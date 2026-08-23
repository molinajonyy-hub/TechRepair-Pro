-- ============================================================================
-- EMAIL VERIFICATION P0 — Provisioning diferido hasta confirmar el correo
--
-- CONTRATO ANTERIOR
--   `on_auth_user_created` (AFTER INSERT ON auth.users) -> `handle_new_user()`
--   crea SIEMPRE un business + un profile, exista o no confirmación de correo.
--   Con «Confirm Email» apagado eso era correcto: todo INSERT en auth.users
--   nacía ya confirmado.
--
--   Además el trigger NUNCA estuvo formalizado en migrations: existía sólo en
--   producción (verificado por catálogo, 2026-08-22). Local y prod estaban
--   divergentes y un `db reset` producía un stack SIN provisioning.
--
-- CONTRATO NUEVO
--   El provisioning se ancla a `email_confirmed_at`, que es la señal
--   canónica y provider-agnostic:
--
--     · INSERT con email_confirmed_at NOT NULL  (Google OAuth, admin API)
--         -> provisioning INMEDIATO, exactamente como hoy.
--     · INSERT con email_confirmed_at NULL      (email+password, Confirm ON)
--         -> NO se crea nada. El auth user existe pero no es operativo.
--     · UPDATE NULL -> NOT NULL                 (el usuario confirmó)
--         -> provisioning en ese momento.
--
--   Una sola función SECURITY DEFINER (`handle_new_user`, la que ya existía) y
--   dos triggers que la comparten. Deliberadamente NO se introduce una función
--   SECDEF nueva: `NEW` tiene la misma forma en INSERT y en UPDATE, así que la
--   misma función sirve para los dos caminos y la superficie privilegiada no
--   crece.
--
-- IDEMPOTENCIA
--   Guard explícito: si ya existe un profile para NEW.id no se crea un segundo
--   business. Cubre el re-disparo del trigger de confirmación (un UPDATE que
--   vuelva a tocar la columna), un `email_confirmed_at` que se reescriba, y el
--   caso mixto INSERT-confirmado + UPDATE posterior.
--
--   El guard mira `id` Y `user_id` porque las dos son identidades válidas de un
--   profile: `handle_new_user` escribe `id = NEW.id` (contrato legacy) y
--   `link_profile_to_auth_user` (migración 20260822160000) escribe `user_id`.
--   Mirar sólo una de las dos crearía un business duplicado para un usuario
--   cuyo perfil fue reparado por el link.
--
-- USUARIOS EXISTENTES
--   No hay backfill y no hace falta: los 17 auth users de producción están
--   confirmados (verificado read-only) y ya tienen sus 17 profiles. El guard
--   de idempotencia los deja intactos aunque un UPDATE futuro toque la columna.
--
-- ALCANCE
--   Esta migración NO limpia los businesses huérfanos existentes, NO toca el
--   wizard de onboarding y NO cambia `enable_confirmations` (eso es un switch
--   del panel de Auth, no del esquema, y lo activa el owner a mano DESPUÉS
--   del deploy).
--
-- Ver tests/sql/email_verification_provisioning.test.sql para el contrato
-- de comportamiento (A..J). Acá las postcondiciones son ESTRUCTURALES: validan
-- que la migración aterrizó completa. El comportamiento se gatea en CI contra
-- un `db reset` limpio, no mutando auth.users en producción.
-- ============================================================================
--
-- NOTA: sin `\set ON_ERROR_STOP` — es un meta-comando de psql y el CLI de
-- Supabase manda este archivo directo al servidor, donde `\` es un error de
-- sintaxis. El corte ante fallos lo da el BEGIN/COMMIT de abajo.
-- ============================================================================

-- Las migraciones de Supabase corren en AUTOCOMMIT: sin este BEGIN explícito
-- cada statement se confirmaría por separado y una falla a mitad de camino
-- dejaría la función nueva con los triggers viejos.
BEGIN;

-- ── 1. La función ───────────────────────────────────────────────────────────
--
-- `pg_temp` va ÚLTIMO en search_path a propósito: omitirlo lo pone PRIMERO en
-- el orden efectivo y habilita el bypass por objetos temporales.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
declare
  new_business_id   uuid;
  new_full_name     text;
  new_role          text;
  new_business_name text;
begin
  -- (a) Sin correo confirmado no hay usuario operativo. Se sale en silencio:
  --     el INSERT/UPDATE de auth.users debe tener éxito igual — hacerlo fallar
  --     rompería el signup entero.
  if new.email_confirmed_at is null then
    return new;
  end if;

  -- (b) Guard de idempotencia. Ver nota de cabecera sobre id/user_id.
  if exists (
    select 1 from public.profiles p
    where p.id = new.id or p.user_id = new.id
  ) then
    return new;
  end if;

  new_full_name     := coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1));
  new_role          := coalesce(new.raw_user_meta_data->>'role', 'owner');
  new_business_name := coalesce(new.raw_user_meta_data->>'business_name', 'Mi Negocio');

  insert into public.businesses (name)
  values (new_business_name)
  returning id into new_business_id;

  insert into public.profiles (id, business_id, full_name, role, is_active)
  values (new.id, new_business_id, new_full_name, new_role, true);

  return new;
end;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- ── 2. Los triggers ─────────────────────────────────────────────────────────
--
-- `on_auth_user_created` se recrea aunque ya exista en prod: es el acto de
-- FORMALIZARLO. Después de esta migración, un `db reset` local reproduce el
-- estado de producción en vez de quedarse sin provisioning.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- El camino nuevo. `OF email_confirmed_at` acota el disparo a la columna que
-- importa, y el WHEN garantiza que sólo corre en la transición NULL -> NOT NULL:
-- un UPDATE que reescriba un timestamp ya presente no vuelve a entrar.
DROP TRIGGER IF EXISTS on_auth_user_email_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_email_confirmed
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)
  EXECUTE FUNCTION public.handle_new_user();

-- ── 3. Postcondiciones estructurales ────────────────────────────────────────
DO $$
DECLARE
  v_prosecdef  boolean;
  v_config     text[];
  v_def        text;
BEGIN
  -- (1) La función sigue siendo SECURITY DEFINER con la barrera de pg_temp.
  SELECT p.prosecdef, p.proconfig
    INTO v_prosecdef, v_config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'handle_new_user';

  IF v_prosecdef IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 1: public.handle_new_user() no existe';
  END IF;
  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDICION 1: handle_new_user dejo de ser SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'POSTCONDICION 1: search_path inesperado en handle_new_user: %', v_config;
  END IF;

  -- (2) El guard de confirmación está REALMENTE en el cuerpo. Sin esto, un
  --     `CREATE OR REPLACE` posterior que reintrodujera el provisioning
  --     inmediato pasaría desapercibido.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'handle_new_user';

  IF v_def NOT LIKE '%email_confirmed_at is null%' THEN
    RAISE EXCEPTION 'POSTCONDICION 2: handle_new_user no verifica email_confirmed_at';
  END IF;

  -- (3) Trigger de INSERT formalizado.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal
       AND n.nspname = 'auth' AND c.relname = 'users'
       AND t.tgname = 'on_auth_user_created'
       AND pg_get_triggerdef(t.oid) LIKE '%AFTER INSERT%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 3: falta el trigger on_auth_user_created (AFTER INSERT)';
  END IF;

  -- (4) Trigger de confirmación, con su WHEN. Se verifica el WHEN y no sólo el
  --     nombre: un trigger sin la guarda dispararía en cada UPDATE.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal
       AND n.nspname = 'auth' AND c.relname = 'users'
       AND t.tgname = 'on_auth_user_email_confirmed'
       AND pg_get_triggerdef(t.oid) LIKE '%AFTER UPDATE OF email_confirmed_at%'
       AND pg_get_triggerdef(t.oid) LIKE '%email_confirmed_at IS NULL%'
       AND pg_get_triggerdef(t.oid) LIKE '%email_confirmed_at IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 4: falta el trigger on_auth_user_email_confirmed o perdio su WHEN';
  END IF;

  -- (5) Los dos triggers apuntan a la MISMA función. Si alguien clonara la
  --     lógica en una segunda SECDEF, esto lo detecta.
  IF (
    SELECT count(DISTINCT t.tgfoid) FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND n.nspname = 'auth' AND c.relname = 'users'
       AND t.tgname IN ('on_auth_user_created', 'on_auth_user_email_confirmed')
  ) <> 1 THEN
    RAISE EXCEPTION 'POSTCONDICION 5: los triggers de auth.users no comparten funcion';
  END IF;

  -- (6) Los usuarios existentes siguen teniendo su profile. Es una asersión de
  --     no-regresión sobre datos reales: la migración no debe haber tocado a
  --     nadie que ya estaba confirmado.
  IF EXISTS (
    SELECT 1 FROM auth.users u
     WHERE u.email_confirmed_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.profiles p WHERE p.id = u.id OR p.user_id = u.id
       )
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 6: hay auth users confirmados sin profile';
  END IF;

  RAISE NOTICE 'EMAIL VERIFICATION P0: 6/6 postcondiciones estructurales OK';
END;
$$;

COMMIT;
