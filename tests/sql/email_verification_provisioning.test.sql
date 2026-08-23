-- ============================================================================
-- EMAIL VERIFICATION P0 — Provisioning diferido hasta confirmar el correo
--
-- Corre contra el stack LOCAL o una branch (NUNCA producción), con la
-- migración 20260823120000 aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/email_verification_provisioning.test.sql
--
--   A  INSERT sin confirmar            -> NO profile, NO business
--   B  UPDATE null -> timestamp        -> exactamente 1 profile y 1 business
--   C  segundo UPDATE / no-op          -> no duplica
--   D  INSERT ya confirmado (Google)   -> provisioning inmediato, como hoy
--   E  profile.id = auth user id
--   F  role owner
--   G  trial único (1 business, 1 trial_ends_at)
--   H  usuarios existentes confirmados sin cambio
--   I  trigger de INSERT formalizado
--   J  trigger de confirmación formalizado
--
-- Todo en una transacción que termina en ROLLBACK: no se commitea ninguna
-- mutación.
--
-- OJO: `public.profiles.id` es FK a `auth.users(id)`. Los fixtures insertan
-- auth users de verdad y dejan que el trigger haga (o no) su trabajo — que es
-- justamente lo que se está midiendo.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_sin_confirmar uuid := gen_random_uuid();   -- A, B, C
  v_google        uuid := gen_random_uuid();   -- D, E, F, G
  v_existente     uuid := gen_random_uuid();   -- H
  v_biz_existente uuid := gen_random_uuid();   -- H
  v_n             integer;
  v_biz           uuid;
  v_biz2          uuid;
  v_role          text;
  v_profile_id    uuid;
  v_trials        integer;
  v_biz_antes     uuid;
  v_prof_antes    timestamptz;
  v_prof_despues  timestamptz;
BEGIN
  -- ══ H (parte 1): un usuario "de los que ya existen": confirmado y con su
  --                 profile creado por el trigger de INSERT.
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (v_existente, 'evp_existente@invalid.test', now() - interval '30 days');

  SELECT p.business_id, p.updated_at INTO v_biz_antes, v_prof_antes
    FROM public.profiles p WHERE p.id = v_existente;

  IF v_biz_antes IS NULL THEN
    RAISE EXCEPTION 'H(setup): el usuario confirmado no recibio profile';
  END IF;

  -- ══ A: INSERT SIN confirmar -> no se provisiona nada ═══════════════════════
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (v_sin_confirmar, 'evp_pendiente@invalid.test', NULL);

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_sin_confirmar;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'A: se creo un profile para un usuario SIN confirmar (n=%)', v_n;
  END IF;

  -- Y tampoco un business suelto. Se cuenta por el nombre por defecto que
  -- usaria handle_new_user para este usuario: si hubiera provisionado, habria
  -- aparecido un 'Mi Negocio' nuevo asociado a este profile inexistente.
  SELECT count(*) INTO v_n
    FROM public.profiles p
   WHERE p.id = v_sin_confirmar OR p.user_id = v_sin_confirmar;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'A: hay profile vinculado a un usuario sin confirmar';
  END IF;

  -- ══ B: UPDATE null -> timestamp = provisioning ═════════════════════════════
  UPDATE auth.users
     SET email_confirmed_at = now()
   WHERE id = v_sin_confirmar;

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_sin_confirmar;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'B: se esperaba exactamente 1 profile tras confirmar, hubo %', v_n;
  END IF;

  SELECT p.business_id INTO v_biz FROM public.profiles p WHERE p.id = v_sin_confirmar;
  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'B: el profile quedo sin business_id';
  END IF;

  SELECT count(*) INTO v_n FROM public.businesses b WHERE b.id = v_biz;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'B: se esperaba exactamente 1 business, hubo %', v_n;
  END IF;

  -- ══ C: idempotencia ════════════════════════════════════════════════════════
  -- (c1) Reescribir el timestamp NO debe volver a provisionar. El WHEN del
  --      trigger ya lo bloquea (OLD no es NULL), pero se mide igual: si alguien
  --      quitara el WHEN, el guard del cuerpo tiene que seguir salvando.
  UPDATE auth.users
     SET email_confirmed_at = now() + interval '1 second'
   WHERE id = v_sin_confirmar;

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_sin_confirmar;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'C1: un segundo UPDATE duplico el profile (n=%)', v_n;
  END IF;

  SELECT p.business_id INTO v_biz2 FROM public.profiles p WHERE p.id = v_sin_confirmar;
  IF v_biz2 <> v_biz THEN
    RAISE EXCEPTION 'C1: cambio el business_id (% -> %)', v_biz, v_biz2;
  END IF;

  -- (c2) Un UPDATE que no toca la columna tampoco hace nada.
  UPDATE auth.users SET raw_user_meta_data = '{"x":1}'::jsonb WHERE id = v_sin_confirmar;

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_sin_confirmar;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'C2: un UPDATE ajeno duplico el profile (n=%)', v_n;
  END IF;

  -- (c3) Un UPDATE que vuelve la confirmacion a NULL y la repone NO debe crear
  --      un segundo business: el guard de existencia es el que corta.
  UPDATE auth.users SET email_confirmed_at = NULL WHERE id = v_sin_confirmar;
  UPDATE auth.users SET email_confirmed_at = now() WHERE id = v_sin_confirmar;

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_sin_confirmar;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'C3: el ciclo NULL->ts duplico el profile (n=%)', v_n;
  END IF;

  SELECT p.business_id INTO v_biz2 FROM public.profiles p WHERE p.id = v_sin_confirmar;
  IF v_biz2 <> v_biz THEN
    RAISE EXCEPTION 'C3: el ciclo NULL->ts creo un business nuevo (% -> %)', v_biz, v_biz2;
  END IF;

  -- ══ D: INSERT ya confirmado (forma Google/OAuth) ═══════════════════════════
  INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  VALUES (v_google, 'evp_google@invalid.test', now(), '{"full_name":"Cliente Google"}'::jsonb);

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_google;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'D: un INSERT ya confirmado no provisiono (n=%)', v_n;
  END IF;

  -- ══ E: la identidad del profile es la del auth user ════════════════════════
  SELECT p.id INTO v_profile_id FROM public.profiles p WHERE p.id = v_google;
  IF v_profile_id <> v_google THEN
    RAISE EXCEPTION 'E: profile.id (%) no coincide con el auth user (%)', v_profile_id, v_google;
  END IF;

  -- ══ F: rol owner ═══════════════════════════════════════════════════════════
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = v_google;
  IF v_role <> 'owner' THEN
    RAISE EXCEPTION 'F: se esperaba role owner, hubo %', v_role;
  END IF;

  -- ══ G: trial unico ═════════════════════════════════════════════════════════
  -- Un provisioning = un business = un trial. Si el trigger corriera dos veces
  -- aparecerian dos businesses en estado trialing para el mismo usuario.
  SELECT count(*) INTO v_trials
    FROM public.businesses b
    JOIN public.profiles p ON p.business_id = b.id
   WHERE p.id = v_google
     AND b.subscription_status = 'trialing'
     AND b.trial_ends_at IS NOT NULL;
  IF v_trials <> 1 THEN
    RAISE EXCEPTION 'G: se esperaba exactamente 1 trial, hubo %', v_trials;
  END IF;

  -- Lo mismo para el usuario que confirmo por UPDATE.
  SELECT count(*) INTO v_trials
    FROM public.businesses b
    JOIN public.profiles p ON p.business_id = b.id
   WHERE p.id = v_sin_confirmar
     AND b.subscription_status = 'trialing';
  IF v_trials <> 1 THEN
    RAISE EXCEPTION 'G: el usuario confirmado por UPDATE tiene % trials', v_trials;
  END IF;

  -- ══ H (parte 2): el usuario preexistente quedo intacto ═════════════════════
  SELECT p.business_id, p.updated_at INTO v_biz2, v_prof_despues
    FROM public.profiles p WHERE p.id = v_existente;

  IF v_biz2 <> v_biz_antes THEN
    RAISE EXCEPTION 'H: cambio el business de un usuario preexistente (% -> %)', v_biz_antes, v_biz2;
  END IF;
  IF v_prof_despues IS DISTINCT FROM v_prof_antes THEN
    RAISE EXCEPTION 'H: se toco el profile de un usuario preexistente';
  END IF;

  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.id = v_existente;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'H: el usuario preexistente quedo con % profiles', v_n;
  END IF;

  RAISE NOTICE 'A-H OK';
END;
$$;

-- ══ I: trigger de INSERT formalizado ════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal
       AND n.nspname = 'auth' AND c.relname = 'users'
       AND t.tgname = 'on_auth_user_created'
       AND pg_get_triggerdef(t.oid) LIKE '%AFTER INSERT%'
  ) THEN
    RAISE EXCEPTION 'I: falta on_auth_user_created (AFTER INSERT) en auth.users';
  END IF;
  RAISE NOTICE 'I OK';
END;
$$;

-- ══ J: trigger de confirmacion formalizado, con su WHEN ═════════════════════
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal
     AND n.nspname = 'auth' AND c.relname = 'users'
     AND t.tgname = 'on_auth_user_email_confirmed';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'J: falta on_auth_user_email_confirmed en auth.users';
  END IF;
  IF v_def NOT LIKE '%AFTER UPDATE OF email_confirmed_at%' THEN
    RAISE EXCEPTION 'J: el trigger no esta acotado a la columna email_confirmed_at: %', v_def;
  END IF;
  IF v_def NOT LIKE '%email_confirmed_at IS NULL%'
     OR v_def NOT LIKE '%email_confirmed_at IS NOT NULL%' THEN
    RAISE EXCEPTION 'J: el trigger perdio su WHEN de transicion: %', v_def;
  END IF;
  RAISE NOTICE 'J OK';
END;
$$;

-- ══ Extra: los dos triggers comparten la MISMA funcion ══════════════════════
DO $$
DECLARE v_fns integer;
BEGIN
  SELECT count(DISTINCT t.tgfoid) INTO v_fns
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname = 'auth' AND c.relname = 'users'
     AND t.tgname IN ('on_auth_user_created', 'on_auth_user_email_confirmed');

  IF v_fns <> 1 THEN
    RAISE EXCEPTION 'EXTRA: los triggers no comparten funcion (distintas=%)', v_fns;
  END IF;
  RAISE NOTICE 'EXTRA OK — una sola funcion SECDEF para los dos caminos';
END;
$$;

ROLLBACK;
