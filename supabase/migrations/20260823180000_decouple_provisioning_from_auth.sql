-- ============================================================================
-- P0-P1 FASE B — Desacoplar el provisioning de la confirmación de identidad
--
-- PRECONDICIÓN DEL ROLLOUT (verificada antes de aplicar esta migración):
--   · `public.provision_my_business()` está en producción (fase A,
--     migración 20260823150000);
--   · el frontend que la invoca está DESPLEGADO — medido sobre el bundle
--     servido en producción: contiene `provision_my_business` y NO contiene
--     ninguna referencia a `bootstrap_owner_profile`.
--   Sin las dos, esta migración deja a los owners nuevos sin forma de crear su
--   negocio. El orden no se puede invertir.
--
-- QUÉ CAMBIA
--   Crear una identidad y fundar una empresa dejan de ser el mismo acto:
--
--     ANTES   INSERT auth.users            -> businesses + profiles
--             UPDATE email_confirmed_at    -> businesses + profiles
--     AHORA   INSERT auth.users            -> nada
--             UPDATE email_confirmed_at    -> nada
--             provision_my_business()      -> businesses + profiles
--
--   Google OAuth no necesita nada especial: al no tener perfil, el guard de
--   rutas lo manda al mismo embudo que a un usuario de email+password. La
--   convergencia ocurre DESPUÉS de autenticarse, no en la DB.
--
-- POR QUÉ IMPORTA MÁS ALLÁ DE LOS HUÉRFANOS
--   El provisioning corría DENTRO de la transacción del UPDATE de
--   `email_confirmed_at`. Cualquier excepción suya revertía el UPDATE, y el
--   usuario quedaba SIN PODER CONFIRMAR NUNCA MÁS — reintentar el link daba lo
--   mismo. `handle_new_user` leía `raw_user_meta_data->>'role'`, que lo escribe
--   el navegador: un valor fuera del CHECK de `profiles.role` era suficiente
--   para dejarse la cuenta trabada de forma permanente. Al sacar el
--   provisioning de esa transacción, confirmar el correo pasa a ser una
--   operación que no puede fallar por causas de negocio.
--
-- LO QUE SE RETIRA
--   1. Los dos triggers de `auth.users`.
--   2. `handle_new_user()` — sin otros llamadores (verificado por catálogo:
--      funciones, triggers, policies, vistas y constraints).
--   3. `bootstrap_owner_profile(text,text,text)` — no puede quedar disponible
--      con su comportamiento actual. Defectos medidos en el discovery:
--        · su rama INSERT viola `profiles_id_fkey` (23503), o sea que el
--          camino de recuperación estaba roto justo para quien lo necesitaba;
--        · promovía a `owner` a CUALQUIER miembro que la invocara con su propio
--          correo, y reclamaba `owner_user_id` si estaba NULL (18 de 24);
--        · conservaba un selector residual por email.
--      Se retira entera en vez de revocarle EXECUTE: dejar viva una segunda API
--      capaz de crear owner tenants es exactamente lo que este lote elimina.
--
-- LO QUE NO SE TOCA
--   · `accept_business_invitation()` — es P0-P2. Sigue siendo la operación que
--     incorpora usuarios a tenants existentes.
--   · Datos históricos: ni un backfill, ni una limpieza de los 5 negocios
--     huérfanos, ni de los `owner_user_id` NULL. Esta migración arregla
--     WRITERS FUTUROS; la reconciliación histórica es otro lote.
--   · Los DEFAULT de trial. Ningún GRANT de tabla.
--
-- NOTA: sin `\set ON_ERROR_STOP` — es un meta-comando de psql y el CLI manda
-- este archivo directo al servidor. El corte lo da el BEGIN/COMMIT, necesario
-- porque las migraciones de Supabase corren en AUTOCOMMIT.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '60s';

-- ── 0 · Precondición dura: no apagar nada sin el reemplazo en su lugar ──────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'provision_my_business'
  ) THEN
    RAISE EXCEPTION
      'PRECONDICION: falta public.provision_my_business. Aplicá la FASE A (20260823150000) antes que esta migración.';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.provision_my_business(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION
      'PRECONDICION: authenticated no puede ejecutar provision_my_business. Apagar el provisioning ahora dejaría a los owners nuevos sin salida.';
  END IF;
END $$;

-- ── 1 · Los triggers ────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS on_auth_user_created        ON auth.users;
DROP TRIGGER IF EXISTS on_auth_user_email_confirmed ON auth.users;

-- ── 2 · La función de provisioning automático ───────────────────────────────
DROP FUNCTION IF EXISTS public.handle_new_user();

-- ── 3 · La RPC legacy de bootstrap ──────────────────────────────────────────
DROP FUNCTION IF EXISTS public.bootstrap_owner_profile(text, text, text);

-- ============================================================================
-- POSTCONDICIONES — leídas del catálogo y de los datos.
-- ============================================================================
DO $$
DECLARE
  v_n           integer;
  v_t           text;
  v_prov        oid := 'public.provision_my_business(text)'::regprocedure::oid;
  v_confirmados integer;
  v_con_perfil  integer;
BEGIN
  -- 1. NINGÚN trigger de auth.users escribe businesses ni profiles.
  --    Se mira lo que la función HACE, no cómo se llama: un trigger futuro con
  --    otro nombre reintroduciría el acoplamiento sin que nadie lo note.
  SELECT count(*) INTO v_n
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal
     AND n.nspname = 'auth' AND c.relname = 'users'
     AND p.prosrc ~* 'insert\s+into\s+("?public"?\.)?"?(profiles|businesses)"?';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 1: quedan % trigger(s) de auth.users que provisionan', v_n;
  END IF;

  -- 2. Los dos triggers nominales ya no existen.
  SELECT count(*) INTO v_n
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname = 'auth' AND c.relname = 'users'
     AND t.tgname IN ('on_auth_user_created', 'on_auth_user_email_confirmed');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 2: sobreviven % trigger(s) de provisioning', v_n;
  END IF;

  -- 3. `handle_new_user` retirada.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'handle_new_user'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 3: handle_new_user sigue existiendo';
  END IF;

  -- 4. `bootstrap_owner_profile` retirada. Si una migración futura la
  --    reintrodujera, esto lo detecta; y si existiera, no debe ser invocable
  --    por `authenticated`.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bootstrap_owner_profile';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 4: bootstrap_owner_profile sigue existiendo (%)', v_n;
  END IF;

  -- 5. UNA sola autoridad creadora de tenants. Se cuenta por comportamiento:
  --    cualquier función que inserte en `businesses` es una autoridad.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~* 'insert\s+into\s+("?public"?\.)?"?businesses"?';
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'POSTCONDICION 5: hay % funciones que insertan en businesses; debe haber exactamente 1 (provision_my_business)', v_n;
  END IF;

  -- 6. El reemplazo sigue en pie con su ACL mínima.
  IF has_function_privilege('anon', v_prov, 'EXECUTE')
     OR has_function_privilege('public', v_prov, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 6: provision_my_business quedó abierta a anon/PUBLIC';
  END IF;
  IF NOT has_function_privilege('authenticated', v_prov, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 6: authenticated perdió EXECUTE sobre provision_my_business';
  END IF;

  -- 7. Sigue sin haber DML estructural directo desde el cliente. Es la
  --    invariante que obliga a pasar por SECURITY DEFINER.
  FOREACH v_t IN ARRAY ARRAY['public.profiles', 'public.businesses'] LOOP
    IF has_table_privilege('authenticated', v_t, 'INSERT')
       OR has_table_privilege('authenticated', v_t, 'UPDATE')
       OR has_table_privilege('authenticated', v_t, 'DELETE')
       OR has_table_privilege('anon', v_t, 'INSERT')
       OR has_table_privilege('anon', v_t, 'UPDATE')
       OR has_table_privilege('anon', v_t, 'DELETE') THEN
      RAISE EXCEPTION 'POSTCONDICION 7: hay DML estructural directo sobre %', v_t;
    END IF;
  END LOOP;

  -- 8. NO SE DESTRUYÓ NADA. Todos los usuarios confirmados que tenían perfil lo
  --    conservan. Es una aserción sobre datos reales: esta migración sólo
  --    retira writers, jamás toca filas.
  SELECT count(*) INTO v_confirmados
    FROM auth.users u WHERE u.email_confirmed_at IS NOT NULL;
  SELECT count(*) INTO v_con_perfil
    FROM auth.users u
   WHERE u.email_confirmed_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id OR p.user_id = u.id);
  IF v_confirmados <> v_con_perfil THEN
    RAISE EXCEPTION
      'POSTCONDICION 8: % de % usuarios confirmados quedaron sin perfil', (v_confirmados - v_con_perfil), v_confirmados;
  END IF;

  RAISE NOTICE
    'P0-P1 FASE B: 8/8 postcondiciones OK. Provisioning desacoplado de auth; autoridad unica; % usuarios confirmados intactos.',
    v_confirmados;
END $$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual, forward-only por convención del repo)
--   Migración FORWARD que reponga, desde 20260823120000, el cuerpo de
--   `handle_new_user()` y sus dos triggers. `provision_my_business` puede
--   convivir con ellos sin conflicto: su guard de idempotencia detecta el
--   perfil que el trigger haya creado y devuelve el negocio existente — es
--   exactamente el estado de la FASE A, que estuvo en producción y se verificó.
--
--   `bootstrap_owner_profile` NO debe reponerse: sus defectos son la razón del
--   lote, no un efecto colateral.
--
--   NO revertir datos creados por provision_my_business. NO borrar negocios.
-- ============================================================================
