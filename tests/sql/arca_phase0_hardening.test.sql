-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 0 — autoridad canónica + retiro de escrituras legacy
--
--   docker cp tests/sql/arca_phase0_hardening.test.sql supabase_db_techrepair-vite:/tmp/arca_p0.sql
--   docker exec supabase_db_techrepair-vite psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/arca_p0.sql
--
-- Autocontenido (no depende del seed E2E). Todo en UNA transacción con ROLLBACK.
--
-- Nota de método (memoria security-gate-pre-m8a): entrar a una función SECURITY
-- DEFINER con el rol cambiado dentro de un DO tumba el backend en este build de
-- Postgres. Por eso:
--   · los privilegios de EJECUCIÓN se prueban con has_function_privilege (fuente
--     de verdad) y por HTTP en scripts/security/arca-phase0-postgrest.mjs;
--   · el COMPORTAMIENTO de las RPC se prueba como postgres con claims JWT (la RPC
--     corre como su owner igual que vía PostgREST; auth.uid() sale del claim);
--   · los privilegios de TABLA sí se prueban con el rol cambiado (no hay SECDEF).
--
--   A01  matriz de autoridad canónica (13 actores)
--   A02  is_business_owner_or_admin == autoridad canónica para todos
--   A03  catálogo: arca_config sin escritura cliente, policies sólo service_role
--   A04  catálogo: RPC retiradas sin EXECUTE; config sólo authenticated
--   A05  RPC retiradas fallan cerradas incluso para postgres y no tocan la fila
--   A06  save_arca_config_legacy: autoridad + tenant por identidad
--   A07  save_arca_config_legacy: campos bloqueados con certificado vigente
--   A08  save_arca_config_legacy: campos bloqueados con credencial activa sin cert
--   A09  save_arca_config_legacy: nunca escribe cert/token/estado/expires_at
--   A10  anon/authenticated: INSERT/UPDATE/DELETE/TRUNCATE directos → 42501
--   A11  service_role conserva la escritura del cache WSAA (afip-wsaa)
--   A12  read model get_arca_config_safe sigue funcionando para el owner
--   A13  material de credencial intacto (sin cambios en private/vault)
-- ============================================================================
BEGIN;

SET LOCAL client_min_messages = notice;

-- ── Fixture ─────────────────────────────────────────────────────────────────
CREATE TEMP TABLE p0_ids (k text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO p0_ids(k, id) SELECT k, gen_random_uuid() FROM unnest(ARRAY[
  'bizA', 'bizB', 'bizC',
  'owner', 'admin', 'admin_no', 'admin_malformed', 'manager_yes', 'tech', 'sales',
  'cashier', 'viewer', 'owner_inactive', 'admin_inactive',
  'ownerB', 'ownerC']) AS k;

CREATE OR REPLACE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT id FROM p0_ids WHERE k = p $$;

-- Huella del material de credencial ANTES de cualquier llamada (A13).
CREATE TEMP TABLE p0_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM private.arca_private_key_credentials) AS creds,
  (SELECT count(*) FROM private.arca_credential_rotations)    AS rots,
  (SELECT count(*) FROM vault.secrets)                        AS secrets,
  md5(coalesce((SELECT string_agg(t::text, '|' ORDER BY t::text)
                  FROM private.arca_private_key_credentials t), '')) AS creds_md5;

SET LOCAL session_replication_role = replica;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT id, k || '@arca-p0.invalid', now() FROM p0_ids WHERE k NOT LIKE 'biz%';

INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status) VALUES
  (pg_temp.id('bizA'), 'ARCA P0 A', pg_temp.id('owner'),  'pro', 'active'),
  (pg_temp.id('bizB'), 'ARCA P0 B', pg_temp.id('ownerB'), 'pro', 'active'),
  (pg_temp.id('bizC'), 'ARCA P0 C', pg_temp.id('ownerC'), 'pro', 'active');

INSERT INTO public.profiles (id, user_id, business_id, role, is_active, permissions, email)
SELECT pg_temp.id(x.k), pg_temp.id(x.k), pg_temp.id(x.biz), x.role, x.active, x.perms, x.k || '@arca-p0.invalid'
FROM (VALUES
  ('owner',             'bizA', 'owner',   true,  NULL::jsonb),
  ('admin',             'bizA', 'admin',   true,  NULL),
  ('admin_no',          'bizA', 'admin',   true,  '{"settings_sensitive": false}'),
  ('admin_malformed',   'bizA', 'admin',   true,  '{"settings_sensitive": "yes"}'),
  ('manager_yes',       'bizA', 'manager', true,  '{"settings_sensitive": true}'),
  ('tech',              'bizA', 'tech',    true,  '{"settings_sensitive": true}'),
  ('sales',             'bizA', 'sales',   true,  NULL),
  ('cashier',           'bizA', 'cashier', true,  NULL),
  ('viewer',            'bizA', 'viewer',  true,  NULL),
  ('owner_inactive',    'bizA', 'owner',   false, NULL),
  ('admin_inactive',    'bizA', 'admin',   false, NULL),
  ('ownerB',            'bizB', 'owner',   true,  NULL),
  ('ownerC',            'bizC', 'owner',   true,  NULL)
) AS x(k, biz, role, active, perms);

SET LOCAL session_replication_role = origin;

/** Ejecuta save_arca_config_legacy como `p_actor` (claims JWT) y devuelve OK o el error. */
CREATE OR REPLACE FUNCTION pg_temp.save_as(
  p_actor text, p_biz text,
  p_cuit text DEFAULT NULL, p_razon text DEFAULT NULL, p_ambiente text DEFAULT NULL,
  p_pv integer DEFAULT NULL, p_ws text DEFAULT NULL, p_alias text DEFAULT NULL,
  p_expires timestamptz DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_detail text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_actor), 'role', 'authenticated')::text, true);
  PERFORM public.save_arca_config_legacy(pg_temp.id(p_biz), p_cuit, p_razon, p_ambiente,
    p_pv, p_ws, p_alias, p_expires);
  RETURN 'OK';
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  RETURN SQLERRM || CASE WHEN coalesce(v_detail, '') <> '' THEN ':' || v_detail ELSE '' END;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.expect(p_got text, p_want text, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '%: esperado «%», obtenido «%»', p_label, p_want, p_got;
  END IF;
END $$;

-- == A01 matriz de autoridad canónica =======================================
DO $$
DECLARE r record; v_got boolean;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('owner',             'bizA', true),
    ('admin',             'bizA', true),
    ('admin_no',          'bizA', false),   -- rol sin capacidad
    ('admin_malformed',   'bizA', false),   -- override ilegible = fail-closed
    ('manager_yes',       'bizA', false),   -- capacidad sin rol
    ('tech',              'bizA', false),
    ('sales',             'bizA', false),
    ('cashier',           'bizA', false),
    ('viewer',            'bizA', false),
    ('owner_inactive',    'bizA', false),
    ('admin_inactive',    'bizA', false),
    ('ownerB',            'bizA', false),   -- cross-business
    ('owner',             'bizB', false)    -- cross-business (inverso)
  ) AS t(actor, biz, want) LOOP
    v_got := private.arca_actor_can_manage(pg_temp.id(r.biz), pg_temp.id(r.actor));
    IF v_got IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'A01: % sobre % → % (esperado %)', r.actor, r.biz, v_got, r.want;
    END IF;
  END LOOP;
  IF private.arca_actor_can_manage(NULL, pg_temp.id('owner')) OR private.arca_actor_can_manage(pg_temp.id('bizA'), NULL) THEN
    RAISE EXCEPTION 'A01: NULL debe ser false';
  END IF;
  RAISE NOTICE 'A01 OK - owner/admin+settings_sensitive activos pasan; el resto no.';
END $$;

-- == A02 el helper histórico delega =========================================
DO $$
DECLARE k text; b text;
BEGIN
  FOR k IN SELECT p0_ids.k FROM p0_ids WHERE p0_ids.k NOT LIKE 'biz%' LOOP
    FOREACH b IN ARRAY ARRAY['bizA', 'bizB', 'bizC'] LOOP
      IF public.is_business_owner_or_admin(pg_temp.id(b), pg_temp.id(k))
         IS DISTINCT FROM private.arca_actor_can_manage(pg_temp.id(b), pg_temp.id(k)) THEN
        RAISE EXCEPTION 'A02: is_business_owner_or_admin diverge para % en %', k, b;
      END IF;
    END LOOP;
  END LOOP;
  -- Propiedad por businesses.owner_user_id SIN perfil activo ya no alcanza.
  IF public.is_business_owner_or_admin(pg_temp.id('bizA'), pg_temp.id('owner_inactive')) THEN
    RAISE EXCEPTION 'A02: owner inactivo pasa por el helper histórico';
  END IF;
  RAISE NOTICE 'A02 OK - is_business_owner_or_admin == autoridad canónica.';
END $$;

-- == A03 catálogo de arca_config ============================================
DO $$
DECLARE v_role text; v_priv text; v_col text; v_pol record;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.arca_config', v_priv) THEN
        RAISE EXCEPTION 'A03: % tiene % sobre arca_config', v_role, v_priv;
      END IF;
    END LOOP;
    FOR v_col IN SELECT attname FROM pg_attribute
                  WHERE attrelid = 'public.arca_config'::regclass AND attnum > 0 AND NOT attisdropped LOOP
      IF has_column_privilege(v_role, 'public.arca_config', v_col, 'INSERT')
         OR has_column_privilege(v_role, 'public.arca_config', v_col, 'UPDATE') THEN
        RAISE EXCEPTION 'A03: % escribe la columna %', v_role, v_col;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'arca_config'
              AND policyname = 'arca_config_plan_write') THEN
    RAISE EXCEPTION 'A03: arca_config_plan_write sigue existiendo';
  END IF;
  FOR v_pol IN SELECT policyname, qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'arca_config' LOOP
    IF v_pol.qual IS DISTINCT FROM '(auth.role() = ''service_role''::text)' THEN
      RAISE EXCEPTION 'A03: policy % no es exclusiva de service_role: %', v_pol.policyname, v_pol.qual;
    END IF;
  END LOOP;
  RAISE NOTICE 'A03 OK - arca_config sin privilegios cliente y sin policy de miembro.';
END $$;

-- == A04 catálogo de RPC ====================================================
DO $$
DECLARE v_fn text; v_role text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.save_arca_certificate_legacy(uuid,text)',
                              'public.set_arca_estado_conexion(uuid,text,text)'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'A04: % ejecuta la RPC retirada %', v_role, v_fn;
      END IF;
    END LOOP;
    IF (SELECT prosecdef FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION 'A04: el stub % no debe ser SECURITY DEFINER', v_fn;
    END IF;
  END LOOP;

  v_fn := 'public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz)';
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'A04: grants de save_arca_config_legacy incorrectos';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, 'private.arca_actor_can_manage(uuid,uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'A04: % ejecuta la autoridad canónica directo', v_role;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.is_business_owner_or_admin(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.is_business_owner_or_admin(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A04: is_business_owner_or_admin debe seguir siendo service_role-only';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.arca_get_credential_for_signing(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A04: se perdió la lectura Vault de firma';
  END IF;
  RAISE NOTICE 'A04 OK - legacy sin EXECUTE, config authenticated-only, autoridad privada.';
END $$;

-- == A05 las RPC retiradas fallan cerradas ==================================
INSERT INTO public.arca_config (business_id, cuit, cuit_emisor, ambiente, punto_venta, web_service, alias,
  cert_file, wsaa_token, wsaa_sign, wsaa_token_expires, estado_conexion, expires_at)
VALUES (pg_temp.id('bizC'), '20111111112', '20111111112', 'produccion', 5, 'wsfe', 'alias-c',
  '-----BEGIN CERTIFICATE-----CENTINELA-C', 'TOKEN-C', 'SIGN-C', now() + interval '6 hours',
  'conectado', '2028-07-25 23:58:12+00');

DO $$
DECLARE v_before text; v_msg text;
BEGIN
  SELECT t::text INTO v_before FROM public.arca_config t WHERE business_id = pg_temp.id('bizC');

  BEGIN
    PERFORM public.save_arca_certificate_legacy(pg_temp.id('bizC'), '-----BEGIN CERTIFICATE-----OTRO');
    RAISE EXCEPTION 'A05: save_arca_certificate_legacy no falló';
  EXCEPTION WHEN insufficient_privilege THEN v_msg := SQLERRM;
  END;
  PERFORM pg_temp.expect(v_msg, 'ARCA_LEGACY_CERTIFICATE_WRITE_RETIRED', 'A05 cert');

  BEGIN
    PERFORM public.set_arca_estado_conexion(pg_temp.id('bizC'), 'error', 'x');
    RAISE EXCEPTION 'A05: set_arca_estado_conexion no falló';
  EXCEPTION WHEN insufficient_privilege THEN v_msg := SQLERRM;
  END;
  PERFORM pg_temp.expect(v_msg, 'ARCA_CLIENT_CONNECTION_STATE_WRITE_RETIRED', 'A05 estado');

  IF (SELECT t::text FROM public.arca_config t WHERE business_id = pg_temp.id('bizC')) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'A05: una RPC retirada modificó la fila';
  END IF;
  RAISE NOTICE 'A05 OK - stubs fail-closed sin efecto.';
END $$;

-- == A06 autoridad + tenant por identidad ===================================
DO $$
DECLARE a text;
BEGIN
  -- Negocio A sin configuración: sólo owner/admin con capacidad pueden crearla.
  FOREACH a IN ARRAY ARRAY['admin_no','admin_malformed','manager_yes','tech','sales','cashier',
                           'viewer','owner_inactive','admin_inactive'] LOOP
    PERFORM pg_temp.expect(pg_temp.save_as(a, 'bizA', p_pv => 2), 'FORBIDDEN', 'A06 ' || a);
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.arca_config WHERE business_id = pg_temp.id('bizA')) THEN
    RAISE EXCEPTION 'A06: un actor no autorizado creó la configuración';
  END IF;

  -- business_id ajeno: el tenant sale de la identidad, no del body.
  PERFORM pg_temp.expect(pg_temp.save_as('ownerB', 'bizA', p_pv => 2), 'FORBIDDEN', 'A06 ownerB→A');
  PERFORM pg_temp.expect(pg_temp.save_as('owner', 'bizB', p_pv => 2), 'FORBIDDEN', 'A06 owner→B');

  -- Sin identidad fiscal vigente el owner puede cargar identidad; admin también.
  PERFORM pg_temp.expect(pg_temp.save_as('owner', 'bizA', '20-22222222-3', 'Razon A', 'homologacion', 7, NULL, 'alias-a'),
    'OK', 'A06 owner alta');
  PERFORM pg_temp.expect(pg_temp.save_as('admin', 'bizA', '20333333334', NULL, 'produccion', NULL, NULL, 'alias-a2'),
    'OK', 'A06 admin sin identidad vigente');
  IF (SELECT ambiente || '|' || alias || '|' || punto_venta || '|' || web_service
        FROM public.arca_config WHERE business_id = pg_temp.id('bizA'))
     IS DISTINCT FROM 'produccion|alias-a2|7|wsfe' THEN
    RAISE EXCEPTION 'A06: el alta/edición sin identidad vigente no quedó como se esperaba';
  END IF;

  -- Validaciones de entrada.
  PERFORM pg_temp.expect(pg_temp.save_as('owner', 'bizA', p_pv => 0), 'INVALID_PUNTO_VENTA', 'A06 pv 0');
  PERFORM pg_temp.expect(pg_temp.save_as('owner', 'bizA', p_pv => 99999), 'INVALID_PUNTO_VENTA', 'A06 pv 99999');
  PERFORM pg_temp.expect(pg_temp.save_as('owner', 'bizA', p_ambiente => 'otro'), 'INVALID_AMBIENTE', 'A06 ambiente');
  PERFORM pg_temp.expect(pg_temp.save_as('owner', 'bizA', p_cuit => '123'), 'INVALID_CUIT', 'A06 cuit');
  -- web_service y expires_at nunca son autoridad del cliente.
  PERFORM pg_temp.expect(pg_temp.save_as('owner', 'bizA', p_ws => 'wsfev1'), 'ARCA_FIELD_LOCKED:web_service', 'A06 ws');
  PERFORM pg_temp.expect(pg_temp.save_as('owner', 'bizA', p_expires => now() + interval '1 year'),
    'ARCA_FIELD_LOCKED:expires_at', 'A06 expires');
  RAISE NOTICE 'A06 OK - autoridad canónica, tenant por identidad, validaciones.';
END $$;

-- == A07 campos bloqueados con certificado vigente (bizC) ===================
DO $$
BEGIN
  PERFORM pg_temp.expect(pg_temp.save_as('ownerC', 'bizC', p_cuit => '20999999990'), 'ARCA_FIELD_LOCKED:cuit', 'A07 cuit');
  PERFORM pg_temp.expect(pg_temp.save_as('ownerC', 'bizC', p_ambiente => 'homologacion'), 'ARCA_FIELD_LOCKED:ambiente', 'A07 ambiente');
  PERFORM pg_temp.expect(pg_temp.save_as('ownerC', 'bizC', p_alias => 'otro-alias'), 'ARCA_FIELD_LOCKED:alias', 'A07 alias');
  PERFORM pg_temp.expect(pg_temp.save_as('ownerC', 'bizC', p_expires => '2030-01-01'::timestamptz), 'ARCA_FIELD_LOCKED:expires_at', 'A07 expires');
  PERFORM pg_temp.expect(pg_temp.save_as('ownerC', 'bizC', p_ws => 'wsbfe'), 'ARCA_FIELD_LOCKED:web_service', 'A07 ws');

  -- Reenviar los MISMOS valores (pestaña que guarda sin cambiar identidad) pasa.
  PERFORM pg_temp.expect(pg_temp.save_as('ownerC', 'bizC', '20-11111111-2', NULL, 'produccion', NULL, 'wsfe', ' alias-c ',
    '2028-07-25 23:58:12+00'::timestamptz), 'OK', 'A07 mismos valores');
  -- Negocio: PV y razón social siguen siendo editables.
  PERFORM pg_temp.expect(pg_temp.save_as('ownerC', 'bizC', p_pv => 9, p_razon => 'Razon C'), 'OK', 'A07 pv/razon');
  RAISE NOTICE 'A07 OK - identidad bloqueada con certificado; PV y razón social editables.';
END $$;

-- == A08 campos bloqueados con credencial activa sin certificado (bizB) =====
INSERT INTO public.arca_config (business_id, cuit, cuit_emisor, ambiente, punto_venta, web_service, alias)
VALUES (pg_temp.id('bizB'), '20444444445', '20444444445', 'produccion', 4, 'wsfe', 'alias-b');
INSERT INTO private.arca_private_key_credentials (business_id, private_key_secret_id, private_key_fingerprint, credential_status)
VALUES (pg_temp.id('bizB'), gen_random_uuid(), repeat('ab', 32), 'active');
DO $$
BEGIN
  PERFORM pg_temp.expect(pg_temp.save_as('ownerB', 'bizB', p_cuit => '20555555556'), 'ARCA_FIELD_LOCKED:cuit', 'A08 cuit');
  PERFORM pg_temp.expect(pg_temp.save_as('ownerB', 'bizB', p_alias => 'otro'), 'ARCA_FIELD_LOCKED:alias', 'A08 alias');
  PERFORM pg_temp.expect(pg_temp.save_as('ownerB', 'bizB', p_ambiente => 'homologacion'), 'ARCA_FIELD_LOCKED:ambiente', 'A08 ambiente');
  PERFORM pg_temp.expect(pg_temp.save_as('ownerB', 'bizB', p_pv => 6), 'OK', 'A08 pv');
  RAISE NOTICE 'A08 OK - una credencial activa bloquea la identidad aunque no haya certificado.';
END $$;

-- == A09 nunca toca material ni cache =======================================
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.arca_config WHERE business_id = pg_temp.id('bizC');
  IF r.cert_file IS DISTINCT FROM '-----BEGIN CERTIFICATE-----CENTINELA-C'
     OR r.wsaa_token IS DISTINCT FROM 'TOKEN-C' OR r.wsaa_sign IS DISTINCT FROM 'SIGN-C'
     OR r.estado_conexion IS DISTINCT FROM 'conectado'
     OR r.expires_at IS DISTINCT FROM '2028-07-25 23:58:12+00'::timestamptz
     OR r.cuit IS DISTINCT FROM '20111111112' OR r.alias IS DISTINCT FROM 'alias-c'
     OR r.ambiente IS DISTINCT FROM 'produccion' OR r.web_service IS DISTINCT FROM 'wsfe' THEN
    RAISE EXCEPTION 'A09: la configuración vigente cambió fuera de PV/razón social: %', row_to_json(r);
  END IF;
  IF r.punto_venta IS DISTINCT FROM 9 OR r.razon_social IS DISTINCT FROM 'Razon C' THEN
    RAISE EXCEPTION 'A09: no se aplicaron los campos permitidos';
  END IF;
  RAISE NOTICE 'A09 OK - cert/token/sign/estado/expires/identidad intactos.';
END $$;

-- == A10 escrituras directas de roles cliente ===============================
CREATE OR REPLACE FUNCTION pg_temp.direct_as(p_role text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id('owner'), 'role', p_role)::text, true);
  PERFORM set_config('role', p_role, true);
  EXECUTE p_sql;
  PERFORM set_config('role', 'postgres', true);
  RETURN 'OK';
EXCEPTION WHEN others THEN
  PERFORM set_config('role', 'postgres', true);
  RETURN SQLSTATE;
END $$;

DO $$
DECLARE v_role text; v_stmt text; v_got text; v_before text;
BEGIN
  SELECT string_agg(t::text, '|' ORDER BY t::text) INTO v_before FROM public.arca_config t;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_stmt IN ARRAY ARRAY[
      format('INSERT INTO public.arca_config (business_id, cuit_emisor, punto_venta) VALUES (%L, %L, 1)',
             gen_random_uuid(), '20666666667'),
      'UPDATE public.arca_config SET cert_file = ''-----BEGIN CERTIFICATE-----ATAQUE''',
      'UPDATE public.arca_config SET estado_conexion = ''error''',
      'DELETE FROM public.arca_config',
      'TRUNCATE public.arca_config'] LOOP
      v_got := pg_temp.direct_as(v_role, v_stmt);
      IF v_got IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION 'A10: % ejecutó «%» con resultado %', v_role, left(v_stmt, 60), v_got;
      END IF;
    END LOOP;
  END LOOP;
  IF (SELECT string_agg(t::text, '|' ORDER BY t::text) FROM public.arca_config t) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'A10: arca_config cambió tras escrituras denegadas';
  END IF;
  RAISE NOTICE 'A10 OK - anon/authenticated: INSERT/UPDATE/DELETE/TRUNCATE → 42501, sin efecto.';
END $$;

-- == A11 service_role conserva la escritura del cache WSAA ==================
DO $$
DECLARE v_got text;
BEGIN
  v_got := pg_temp.direct_as('service_role', format(
    'UPDATE public.arca_config SET wsaa_token = %L, wsaa_sign = %L, estado_conexion = %L WHERE business_id = %L',
    'TOKEN-NUEVO', 'SIGN-NUEVO', 'conectado', pg_temp.id('bizC')));
  PERFORM pg_temp.expect(v_got, 'OK', 'A11 service_role UPDATE cache');
  IF (SELECT wsaa_token FROM public.arca_config WHERE business_id = pg_temp.id('bizC')) IS DISTINCT FROM 'TOKEN-NUEVO' THEN
    RAISE EXCEPTION 'A11: el cache WSAA no se escribió';
  END IF;
  RAISE NOTICE 'A11 OK - afip-wsaa (service_role) sigue cacheando token/sign/estado.';
END $$;

-- == A12 read model =========================================================
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id('ownerC'), 'role', 'authenticated')::text, true);
  r := public.get_arca_config_safe(pg_temp.id('bizC'));
  IF r IS NULL OR (r ->> 'configured')::boolean IS NOT TRUE OR (r ->> 'punto_venta')::int <> 9
     OR (r ->> 'has_certificate')::boolean IS NOT TRUE OR r ? 'cert_file' OR r ? 'wsaa_token' THEN
    RAISE EXCEPTION 'A12: get_arca_config_safe no devuelve el contrato esperado: %', r;
  END IF;
  RAISE NOTICE 'A12 OK - get_arca_config_safe intacto.';
END $$;

-- == A13 material de credencial =============================================
DO $$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM p0_before;
  DELETE FROM private.arca_private_key_credentials WHERE business_id = pg_temp.id('bizB');  -- fixture de A08
  IF (SELECT count(*) FROM private.arca_private_key_credentials) <> b.creds
     OR (SELECT count(*) FROM private.arca_credential_rotations) <> b.rots
     OR (SELECT count(*) FROM vault.secrets) <> b.secrets
     OR md5(coalesce((SELECT string_agg(t::text, '|' ORDER BY t::text)
                        FROM private.arca_private_key_credentials t), '')) <> b.creds_md5 THEN
    RAISE EXCEPTION 'A13: el material de credencial cambió';
  END IF;
  RAISE NOTICE 'A13 OK - credenciales, rotaciones y Vault sin cambios.';
END $$;

DO $$ BEGIN RAISE NOTICE 'ARCA Phase 0 SQL: 13/13 OK'; END $$;

ROLLBACK;
