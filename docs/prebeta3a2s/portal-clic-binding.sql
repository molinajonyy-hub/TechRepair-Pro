-- ============================================================================
-- PRE-BETA-3A-2S · BINDING DE PORTAL CLIC (PASO MANUAL, SEPARADO DEL DEPLOY)
--
-- NO forma parte de ninguna migracion ni de CI. Lo ejecuta un OPERADOR, con el
-- rol `postgres` (la tabla private.internal_tool_principals no tiene grants
-- para anon/authenticated/service_role), DESPUES de que
-- postdeploy-verify-readonly.sql dio todo ok.
--
-- Hasta que se corre, /portal-clic esta cerrado para TODOS (incluido el owner
-- de Clic): es el estado seguro por defecto.
--
-- Datos que hacen falta (ninguno esta hardcodeado en el repo):
--   internal_user_id  auth.users.id de la cuenta interna que administra Portal Clic
--   clic_business_id  businesses.id del negocio Clic
--   reason            motivo del alta (>= 10 caracteres; queda en la auditoria)
--
-- MODOS (-v action=...):
--
--   lookup  SOLO LECTURA. Ayuda a obtener los ids:
--             psql "$DB_URL" -X -v ON_ERROR_STOP=1 -v action=lookup \
--                  -v internal_email='<email de la cuenta interna>' \
--                  -v clic_slug='<wholesale_portal_slug de Clic>' \
--                  -f docs/prebeta3a2s/portal-clic-binding.sql
--
--   bind    Alta (o reactivacion) del principal. DRY-RUN por defecto: valida,
--           escribe, verifica y hace ROLLBACK. Solo con -v confirm=yes hace COMMIT.
--             psql "$DB_URL" -X -v ON_ERROR_STOP=1 -v action=bind \
--                  -v internal_user_id=<uuid> -v clic_business_id=<uuid> \
--                  -v reason='Alta Portal Clic: <ticket/aprobacion>' \
--                  [-v confirm=yes] -f docs/prebeta3a2s/portal-clic-binding.sql
--
--   revoke  Baja (active = false; la fila y la auditoria quedan). Mismo DRY-RUN.
--             psql "$DB_URL" -X -v ON_ERROR_STOP=1 -v action=revoke \
--                  -v reason='Baja Portal Clic: <motivo>' \
--                  [-v confirm=yes] -f docs/prebeta3a2s/portal-clic-binding.sql
--
-- Reglas que aplica `bind` (fail-closed, todo o nada):
--   · la migracion 20261011130000 esta aplicada;
--   · el usuario existe en auth.users, no esta borrado ni baneado;
--   · el negocio existe;
--   · el usuario es owner registrado o miembro ACTIVO de ese negocio (si no, la
--     autoridad le responderia "no" igual: no se deja un binding inutil);
--   · si ya hay un principal ACTIVO de OTRA identidad o negocio, aborta:
--     primero `revoke`, despues `bind`. Nunca se pisa en silencio;
--   · si el principal activo ya es exactamente ese, no hace nada.
-- Despues de escribir, verifica con la MISMA funcion que usa la app
-- (public.current_user_has_internal_tool_access) que la identidad entra y que
-- la verificacion se haga sobre ese negocio.
-- ============================================================================

\set ON_ERROR_STOP on

\if :{?action}
\else
\echo 'Falta -v action=lookup|bind|revoke. Ver el encabezado del archivo.'
\quit
\endif

SELECT :'action' = 'lookup' AS is_lookup,
       :'action' = 'bind'   AS is_bind,
       :'action' = 'revoke' AS is_revoke,
       :'action' IN ('lookup', 'bind', 'revoke') AS action_ok \gset

\if :action_ok
\else
\echo 'action invalida: usar lookup, bind o revoke.'
\quit
\endif

-- ── lookup (solo lectura) ───────────────────────────────────────────────────
\if :is_lookup
BEGIN TRANSACTION READ ONLY;

\if :{?internal_email}
SELECT u.id AS internal_user_id, u.email, u.created_at, u.last_sign_in_at,
       u.email_confirmed_at IS NOT NULL AS email_confirmado,
       u.deleted_at, u.banned_until
  FROM auth.users u
 WHERE lower(btrim(u.email)) = lower(btrim(:'internal_email'));

SELECT p.business_id, b.name AS negocio, b.wholesale_portal_slug, p.role, p.is_active,
       b.owner_user_id = COALESCE(p.user_id, p.id) AS es_owner_registrado
  FROM public.profiles p
  JOIN auth.users u      ON u.id = COALESCE(p.user_id, p.id)
  JOIN public.businesses b ON b.id = p.business_id
 WHERE lower(btrim(u.email)) = lower(btrim(:'internal_email'));
\endif

\if :{?clic_slug}
SELECT b.id AS clic_business_id, b.name, b.wholesale_portal_slug, b.wholesale_portal_enabled,
       b.subscription_plan, b.subscription_status, b.owner_user_id
  FROM public.businesses b
 WHERE b.wholesale_portal_slug = :'clic_slug';
\endif

-- Principal actual (si hay) e historial.
SELECT tool_key, user_id, business_id, active, granted_reason, granted_by, created_at, updated_at
  FROM private.internal_tool_principals;
SELECT id, tool_key, operation, db_user, at FROM private.internal_tool_principal_audit ORDER BY id;

ROLLBACK;
\quit
\endif

-- ── bind / revoke (escriben; COMMIT solo con -v confirm=yes) ────────────────
\if :{?reason}
\else
\echo 'Falta -v reason=''<motivo de al menos 10 caracteres>''.'
\quit
\endif

\if :is_bind
\if :{?internal_user_id}
\else
\echo 'bind: falta -v internal_user_id=<uuid>.'
\quit
\endif
\if :{?clic_business_id}
\else
\echo 'bind: falta -v clic_business_id=<uuid>.'
\quit
\endif
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Los valores viajan por GUC de la transaccion: psql no interpola variables
-- dentro de un bloque $$.
SELECT set_config('prebeta3a2s_binding.action', :'action', true),
       set_config('prebeta3a2s_binding.reason', :'reason', true);
\if :is_bind
SELECT set_config('prebeta3a2s_binding.user_id', :'internal_user_id', true),
       set_config('prebeta3a2s_binding.business_id', :'clic_business_id', true);
\endif

DO $binding$
DECLARE
  v_action   text := current_setting('prebeta3a2s_binding.action');
  v_reason   text := btrim(current_setting('prebeta3a2s_binding.reason'));
  v_user     uuid;
  v_business uuid;
  v_actual   record;
  v_existe   boolean;
  v_ok       boolean;
BEGIN
  IF to_regclass('private.internal_tool_principals') IS NULL
     OR to_regprocedure('public.current_user_has_internal_tool_access(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'BINDING: la migracion 20261011130000 no esta aplicada';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'BINDING: reason tiene que tener al menos 10 caracteres';
  END IF;

  SELECT * INTO v_actual FROM private.internal_tool_principals
   WHERE tool_key = 'portal_clic' FOR UPDATE;
  v_existe := FOUND;

  IF v_action = 'revoke' THEN
    IF NOT v_existe OR NOT v_actual.active THEN
      RAISE NOTICE 'BINDING revoke: no hay principal activo de portal_clic; nada que hacer';
      RETURN;
    END IF;
    UPDATE private.internal_tool_principals
       SET active = false,
           granted_reason = v_reason,
           granted_by = current_user
     WHERE tool_key = 'portal_clic';
    PERFORM set_config('request.jwt.claim.sub', v_actual.user_id::text, true);
    IF public.current_user_has_internal_tool_access('portal_clic', v_actual.business_id) THEN
      RAISE EXCEPTION 'BINDING revoke: la identidad revocada sigue entrando';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE NOTICE 'BINDING revoke: principal % / % desactivado', v_actual.user_id, v_actual.business_id;
    RETURN;
  END IF;

  -- bind
  BEGIN
    v_user     := current_setting('prebeta3a2s_binding.user_id')::uuid;
    v_business := current_setting('prebeta3a2s_binding.business_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'BINDING: internal_user_id y clic_business_id tienen que ser UUIDs';
  END;

  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = v_user) THEN
    RAISE EXCEPTION 'BINDING: el usuario % no existe en auth.users', v_user;
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users u WHERE u.id = v_user
               AND (u.deleted_at IS NOT NULL OR u.banned_until > now())) THEN
    RAISE EXCEPTION 'BINDING: el usuario % esta borrado o baneado', v_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = v_business) THEN
    RAISE EXCEPTION 'BINDING: el negocio % no existe', v_business;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = v_business AND b.owner_user_id = v_user)
     AND NOT EXISTS (SELECT 1 FROM public.profiles p
                      WHERE p.business_id = v_business
                        AND COALESCE(p.user_id, p.id) = v_user
                        AND COALESCE(p.is_active, true)) THEN
    RAISE EXCEPTION 'BINDING: el usuario % no es owner ni miembro activo del negocio %', v_user, v_business;
  END IF;

  IF v_existe THEN
    IF v_actual.active AND v_actual.user_id = v_user AND v_actual.business_id = v_business THEN
      RAISE NOTICE 'BINDING bind: el principal activo ya es % / %; nada que hacer', v_user, v_business;
    ELSIF v_actual.active THEN
      RAISE EXCEPTION 'BINDING bind: ya hay un principal ACTIVO distinto (% / %). Correr action=revoke primero.',
        v_actual.user_id, v_actual.business_id;
    ELSE
      UPDATE private.internal_tool_principals
         SET user_id = v_user, business_id = v_business, active = true,
             granted_reason = v_reason, granted_by = current_user
       WHERE tool_key = 'portal_clic';
    END IF;
  ELSE
    INSERT INTO private.internal_tool_principals(tool_key, user_id, business_id, active, granted_reason)
    VALUES ('portal_clic', v_user, v_business, true, v_reason);
  END IF;

  -- Verificacion con la autoridad real de la app.
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  v_ok := public.current_user_has_internal_tool_access('portal_clic', v_business);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'BINDING bind: la identidad no obtiene acceso despues del alta';
  END IF;
  IF (SELECT count(*) FROM private.internal_tool_principals WHERE active) <> 1 THEN
    RAISE EXCEPTION 'BINDING bind: tiene que quedar exactamente un principal activo';
  END IF;
  RAISE NOTICE 'BINDING bind: principal portal_clic = % / % (verificado)', v_user, v_business;
END
$binding$;

SELECT tool_key, user_id, business_id, active, granted_reason, granted_by, updated_at
  FROM private.internal_tool_principals;
SELECT id, tool_key, operation, db_user, at
  FROM private.internal_tool_principal_audit
 ORDER BY id DESC
 LIMIT 5;

\if :{?confirm}
SELECT :'confirm' = 'yes' AS do_commit \gset
\else
\set do_commit false
\endif

\if :do_commit
COMMIT;
\echo 'BINDING: COMMIT hecho.'
\else
ROLLBACK;
\echo 'BINDING: DRY-RUN, ROLLBACK hecho. Repetir con -v confirm=yes para confirmar.'
\endif
