-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 1 — read model canónico de estado
--
--   npm run test:sql:arca-phase1
--
-- Autocontenido, todo en UNA transacción con ROLLBACK. Certificados SINTÉTICOS
-- (los mismos fixtures RSA-2048 autofirmados de AFIP-S4B-2C, notAfter
-- 2035-01-01T03:00:00Z). Nunca el certificado productivo.
--
-- Método (igual que Phase 0): el comportamiento de la RPC SECURITY DEFINER se
-- prueba como postgres con claims JWT; los privilegios por catálogo y por HTTP
-- (scripts/security/arca-phase1-postgrest.mjs). Los umbrales de vencimiento se
-- prueban sobre la derivación privada con reloj inyectado.
--
--   S01 catálogo: grants, SECDEF, STABLE, derivación privada
--   S02 A  sin arca_config                    → not_configured / start_setup
--   S03 B  config sin cert ni clave           → not_configured, metadata visible
--   S04 C  sólo certificado                   → NO configurado, credential_missing
--   S05 C' credencial activa sin secreto Vault → credential.active=false
--   S06 D  clave + certificado + evidencia    → connected / none
--   S07 D' configurado sin verificar          → pending_verification / verify_connection
--   S08 D" evidencia anterior a la credencial → connection unknown
--   S09 E  vencido                            → expired / attention / renew_certificate
--   S10 F  ≤ 60 días                          → expiring (bordes 60/61)
--   S11 G  ≤ 15 días                          → urgent (bordes 15/16)
--   S12 H  rotación pendiente (renewal/initial) → in_progress / continue_setup
--   S13 H' activada pendiente de verificación → pending_verification
--   S14 I  completed/purged                   → NO en curso
--   S15 J  estado_conexion libre / error      → acotado, sin fugas de texto
--   S15b   error/conectado viejo o sin fecha → unknown, sin connection_error
--   S16    par clave↔certificado no coincide, cert ilegible, PFX legacy
--   S17 K-N can_manage (owner/admin sí; admin sin capacidad, manager, inactivos no)
--   S18 O  cross-tenant, anon, plan sin feature
--   S19 P  sin claves prohibidas ni material en la salida
--   S20    solo lectura: filas y Vault idénticos
-- ============================================================================
BEGIN;

SET LOCAL client_min_messages = notice;

CREATE TEMP TABLE p1_ids (k text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO p1_ids(k, id) SELECT k, gen_random_uuid() FROM unnest(ARRAY[
  'bizA', 'bizB', 'bizF',
  'owner', 'admin', 'admin_no', 'manager_yes', 'tech', 'viewer',
  'owner_inactive', 'admin_inactive', 'ownerB', 'ownerF']) AS k;

CREATE OR REPLACE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT id FROM p1_ids WHERE k = p $$;

CREATE TEMP TABLE fx (name text PRIMARY KEY, val text) ON COMMIT DROP;
-- FP_OLD = SPKI SHA-256 de cert_old. cert_new tiene OTRA clave.
INSERT INTO fx VALUES ('fp_old', '21a64c517e8071808e46897428e1540026c5a781c8af0727fcab227bd44de2ad');
INSERT INTO fx VALUES ('cert_old', $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAKuOSghhK6gnpGFhR7UR8nsXdrr8LMXozuj8KZtV71uBGi4YedVq
5V+e7s6ZwIEAH6POkX+aFSrgXYRiOCkAcCh9bxUdytIHszxfFMw8iLnYSqtY7dDL
VAD4k6ea1iuiFmL+Mdr8E2PQFmM1uXnNLrV1X7qPJhWScbHTrDfWIWzX8XulU6XK
n+2AvYMZ+lCzxPi8lF3UdbuUDr2mK5AXUalR9EpNDSOo2ebyjDCkZguESxweT25E
hq7xs9LYO8M5LOxFxicbshOnyCOZPGGIo+m1QRWaZ6HoJwM3qLJipSKfpRR7bhOk
LAJ5uWciKeAUDmMZEgMgnV9ZRCPFrCaOWwkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAPPI8YZ2T7HPHKAFi9Scc9AqW4lPzxcAcbFewAz/FufV2bFeevaxgjpFAfpwH
YHCh8Pby0VLky6Tj1igRqDaIXIPMRnQ7rtr0PmBd9Zzik+ACvnGRtvBaORFHWFqS
EeLNEwNmcgarNnYnwi1eQq4M5HVGSKxeZS8Msg0heb7BUmZVehP3a3fB39ffdL2w
ZL0uWwG18A72nymfZEDIFcI2j16WGKMDTEd61C1McyiDhWCkRqRf21DLnQP1FpxW
MP9xh2UoBbxhQgRoRg8kHQ1jDWUpYTmtsr0jFWrMZMCTumIZ7/FfZq2Qe181YNMD
sSiIyIkmE4mF9i3ifJ9de51fPQ==
-----END CERTIFICATE-----$p$);
INSERT INTO fx VALUES ('cert_new', $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALIBT4zQhQgmzU2iWf2ojY3uU3UepMhQoUmTH9rMafDkgcS7f97N
3TZMfDaDCU7HVSiXlqcjmjPmXpABvJy1Pvp6hTbUSkkXJYEu5GZ4I5wJMG30rdP7
8TX8fkG/buHaWsXqxNcldg1jH9R0/PbN9LIZG2SxhNENdYw9hs9LuDvMx3yp8WxR
F9brt+HsmTyb1SwTwQN3uXjhOSoA8Yp3K3eS1mKodUiF3SwJVP152NAkPAxL9yaY
bIRU1FMGPBYTds1XO+ZIQMxYEbf2uBpZLQUAvL1zOqqUk8s8guXAHV6uhy/x4qGl
lXEUZ74lJ7Wl/MutbU+NAEoYh08gyKrP7j8CAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAFMQtjF1s2BYbBKlXfL/qtXh2TKLT3D6u9bzWDyZWpfIS25Pbi5GJzr8S2LxP
MhpYzcoHtKdOn9B1NFxRMvNOI8uBMXC/Nr0oiVvbnsVx4+VrEEG9ghaPzlYvUYhG
UIPSLzeV61/T2jfs0X6rrKk0lPDnPvRKb51mtumGCeL0ZQAwAQSa3g8H8cWzHGq3
VEJR7zoWeAX/59pPKP8Q33xbaiDkNfYrYl7NBeHG7xWr0HoHVotNT1RIglABZg2f
/1lxdVxzaBwn64zSavyi8H6FEdTrFzwtpl/O016uiDW79HVPDwIIxNWHZIjS5HZI
c2GUUOQ7kyv4kiP5Hz/+MYw5xQ==
-----END CERTIFICATE-----$p$);

CREATE OR REPLACE FUNCTION pg_temp.fx(p text) RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT val FROM fx WHERE name = p $$;

SET LOCAL session_replication_role = replica;

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT id, k || '@arca-p1.invalid', now() FROM p1_ids WHERE k NOT LIKE 'biz%';

INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status) VALUES
  (pg_temp.id('bizA'), 'ARCA P1 A', pg_temp.id('owner'),  'pro',  'active'),
  (pg_temp.id('bizB'), 'ARCA P1 B', pg_temp.id('ownerB'), 'pro',  'active'),
  (pg_temp.id('bizF'), 'ARCA P1 F', pg_temp.id('ownerF'), 'basico', 'active');

INSERT INTO public.profiles (id, user_id, business_id, role, is_active, permissions, email)
SELECT pg_temp.id(x.k), pg_temp.id(x.k), pg_temp.id(x.biz), x.role, x.active, x.perms, x.k || '@arca-p1.invalid'
FROM (VALUES
  ('owner',          'bizA', 'owner',   true,  NULL::jsonb),
  ('admin',          'bizA', 'admin',   true,  NULL),
  ('admin_no',       'bizA', 'admin',   true,  '{"settings_sensitive": false}'),
  ('manager_yes',    'bizA', 'manager', true,  '{"settings_sensitive": true}'),
  ('tech',           'bizA', 'tech',    true,  NULL),
  ('viewer',         'bizA', 'viewer',  true,  NULL),
  ('owner_inactive', 'bizA', 'owner',   false, NULL),
  ('admin_inactive', 'bizA', 'admin',   false, NULL),
  ('ownerB',         'bizB', 'owner',   true,  NULL),
  ('ownerF',         'bizF', 'owner',   true,  NULL)
) AS x(k, biz, role, active, perms);

SET LOCAL session_replication_role = origin;

-- Huella de solo lectura (S20).
CREATE TEMP TABLE p1_before ON COMMIT DROP AS SELECT 0 AS placeholder;

CREATE OR REPLACE FUNCTION pg_temp.fingerprint() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(
    coalesce((SELECT string_agg(t::text, '|' ORDER BY t::text) FROM public.arca_config t), '') || '#' ||
    coalesce((SELECT string_agg(t::text, '|' ORDER BY t::text) FROM private.arca_private_key_credentials t), '') || '#' ||
    coalesce((SELECT string_agg(t::text, '|' ORDER BY t::text) FROM private.arca_credential_rotations t), '') || '#' ||
    (SELECT count(*) FROM vault.secrets)::text || '#' ||
    (SELECT count(*) FROM private.arca_credential_audit)::text)
$$;

/** Llama la RPC pública como `p_actor` (claims JWT). Devuelve el jsonb como texto o el error. */
CREATE OR REPLACE FUNCTION pg_temp.status_as(p_actor text, p_biz text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    CASE WHEN p_actor IS NULL THEN json_build_object('role', 'anon')::text
         ELSE json_build_object('sub', pg_temp.id(p_actor), 'role', 'authenticated')::text END, true);
  RETURN public.get_arca_selfservice_status(CASE WHEN p_biz IS NULL THEN NULL ELSE pg_temp.id(p_biz) END)::text;
EXCEPTION WHEN others THEN
  RETURN 'ERR:' || SQLSTATE || ':' || SQLERRM;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.derive(p_biz text, p_now timestamptz, p_actor text DEFAULT 'owner')
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT private.arca_selfservice_status(pg_temp.id(p_biz), pg_temp.id(p_actor), p_now)
$$;

CREATE OR REPLACE FUNCTION pg_temp.expect(p_got text, p_want text, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '%: esperado «%», obtenido «%»', p_label, p_want, p_got;
  END IF;
END $$;

/** Resumen compacto: status|configured|renewal|connection|setup.state|setup.kind|setup.step|next|attention */
CREATE OR REPLACE FUNCTION pg_temp.summary(r jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|', r ->> 'status', r ->> 'configured', r #>> '{certificate,renewal_state}',
    r #>> '{connection,state}', r #>> '{setup,state}', coalesce(r #>> '{setup,kind}', '-'),
    coalesce(r #>> '{setup,step}', '-'), r ->> 'next_action',
    coalesce((SELECT string_agg(x, ',' ORDER BY x) FROM jsonb_array_elements_text(r -> 'attention') x), '-'))
$$;

/** Siembra configuración, credencial (con o sin secreto real) y certificado para bizA. */
CREATE OR REPLACE FUNCTION pg_temp.seed_a(
  p_cert text, p_cred boolean, p_secret boolean DEFAULT true, p_estado text DEFAULT 'conectado',
  p_sync timestamptz DEFAULT now(), p_cred_since timestamptz DEFAULT now() - interval '1 day',
  p_fp text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_secret uuid;
BEGIN
  DELETE FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizA');
  DELETE FROM private.arca_private_key_credentials WHERE business_id = pg_temp.id('bizA');
  DELETE FROM public.arca_config WHERE business_id = pg_temp.id('bizA');
  INSERT INTO public.arca_config (business_id, cuit, cuit_emisor, razon_social, ambiente, punto_venta, web_service,
    alias, cert_file, wsaa_token, wsaa_sign, wsaa_token_expires, estado_conexion, ultima_sincronizacion,
    ultimo_error, expires_at)
  VALUES (pg_temp.id('bizA'), '20-11111111-2', '20111111112', 'Razon A', 'produccion', 10, 'wsfe', 'fixture.alias',
    -- estado_conexion es NOT NULL: NULL en el fixture significa el default histórico.
    p_cert, 'TOKEN-SENTINELA-P1', 'SIGN-SENTINELA-P1', now() + interval '6 hours', coalesce(p_estado, 'desconectado'), p_sync,
    'ULTIMO-ERROR-SENTINELA <script>', '2099-01-01');
  IF p_cred THEN
    v_secret := CASE WHEN p_secret THEN vault.create_secret('KEY-SENTINELA-P1', 'arca-p1-test:' || gen_random_uuid())
                     ELSE gen_random_uuid() END;
    INSERT INTO private.arca_private_key_credentials (business_id, private_key_secret_id, private_key_fingerprint,
      credential_status, created_at, rotated_at)
    VALUES (pg_temp.id('bizA'), v_secret, coalesce(p_fp, pg_temp.fx('fp_old')), 'active', p_cred_since, p_cred_since);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.add_rotation(p_biz text, p_state text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO private.arca_credential_rotations (business_id, private_key_secret_id, private_key_fingerprint,
    csr_fingerprint, csr_pem, key_size, state, idempotency_key, request_hash, prev_status)
  VALUES (pg_temp.id(p_biz), gen_random_uuid(), repeat('cd', 32), repeat('cd', 32),
    '-----BEGIN CERTIFICATE REQUEST-----CSR-SENTINELA-P1', 2048, p_state, gen_random_uuid()::text, 'h',
    CASE WHEN p_state = 'completed' THEN 'purged' END);
  SET LOCAL session_replication_role = origin;
END $$;

-- == S01 catálogo ============================================================
DO $$
DECLARE v_role text;
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.get_arca_selfservice_status(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S01: authenticated sin EXECUTE';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(v_role, 'public.get_arca_selfservice_status(uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'S01: % ejecuta la RPC', v_role;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, 'private.arca_selfservice_status(uuid,uuid,timestamptz)', 'EXECUTE') THEN
      RAISE EXCEPTION 'S01: % ejecuta la derivación privada', v_role;
    END IF;
  END LOOP;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.get_arca_selfservice_status(uuid)'::regprocedure) <> 's'
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'private.arca_selfservice_status(uuid,uuid,timestamptz)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'S01: ambas funciones deben ser STABLE (no pueden escribir)';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_arca_selfservice_status(uuid)'::regprocedure)
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.get_arca_selfservice_status(uuid)'::regprocedure
                     AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'S01: la RPC debe ser SECURITY DEFINER con search_path fijo';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_arca_config_safe(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S01: get_arca_config_safe se perdió';
  END IF;
  RAISE NOTICE 'S01 OK - authenticated-only, STABLE, SECDEF con search_path, derivación privada.';
END $$;

INSERT INTO p1_before SELECT 1;
CREATE TEMP TABLE p1_fp ON COMMIT DROP AS SELECT pg_temp.fingerprint() AS fp;

-- == S02 A: sin arca_config ==================================================
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.status_as('owner')::jsonb;
  PERFORM pg_temp.expect(pg_temp.summary(r), 'not_configured|false|not_configured|unknown|not_started|-|-|start_setup|-', 'S02');
  IF r ->> 'cuit' IS NOT NULL OR r ->> 'environment' IS NOT NULL OR (r ->> 'can_manage')::boolean IS NOT TRUE
     OR (r ->> 'available')::boolean IS NOT TRUE OR (r ->> 'contract_version')::int <> 1 THEN
    RAISE EXCEPTION 'S02: metadata inesperada: %', r;
  END IF;
  RAISE NOTICE 'S02 OK - sin configuración → not_configured / start_setup.';
END $$;

-- == S03 B: config sin cert ni clave =========================================
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.seed_a(NULL, false, p_estado => 'desconectado', p_sync => NULL);
  r := pg_temp.status_as('owner')::jsonb;
  PERFORM pg_temp.expect(pg_temp.summary(r), 'not_configured|false|not_configured|unknown|not_started|-|-|start_setup|-', 'S03');
  PERFORM pg_temp.expect(r ->> 'cuit', '20111111112', 'S03 cuit normalizado');
  PERFORM pg_temp.expect(r ->> 'environment', 'produccion', 'S03 ambiente');
  PERFORM pg_temp.expect(r ->> 'punto_venta', '10', 'S03 pv');
  RAISE NOTICE 'S03 OK - config sin credencial → not_configured, metadata no sensible visible.';
END $$;

-- == S04 C: certificado sin credencial =======================================
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), false);
  r := pg_temp.status_as('owner')::jsonb;
  PERFORM pg_temp.expect(pg_temp.summary(r), 'attention|false|healthy|unknown|not_started|-|-|start_setup|credential_missing', 'S04');
  IF (r #>> '{credential,active}')::boolean OR (r #>> '{certificate,present}')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'S04: flags incorrectos: %', r;
  END IF;
  RAISE NOTICE 'S04 OK - un certificado sin clave activa NO es "conectado".';
END $$;

-- == S05 C': credencial activa apuntando a un secreto inexistente ============
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true, p_secret => false);
  r := pg_temp.status_as('owner')::jsonb;
  PERFORM pg_temp.expect(pg_temp.summary(r), 'attention|false|healthy|unknown|not_started|-|-|start_setup|credential_missing', 'S05');
  RAISE NOTICE 'S05 OK - sin secreto en Vault la credencial no cuenta como activa.';
END $$;

-- == S06 D: configurado y conectado ==========================================
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true);
  r := pg_temp.status_as('owner')::jsonb;
  PERFORM pg_temp.expect(pg_temp.summary(r), 'connected|true|healthy|connected|completed|-|-|none|-', 'S06');
  PERFORM pg_temp.expect((r #>> '{certificate,expires_at}')::timestamptz::text,
    '2035-01-01 03:00:00+00'::timestamptz::text, 'S06 vencimiento derivado del X.509 (NO arca_config.expires_at=2099)');
  IF (r #>> '{certificate,matches_credential}')::boolean IS NOT TRUE OR r #>> '{connection,last_verified_at}' IS NULL THEN
    RAISE EXCEPTION 'S06: par o evidencia incorrectos: %', r;
  END IF;
  RAISE NOTICE 'S06 OK - clave+certificado+WSAA posterior → connected / none; vencimiento desde el certificado.';
END $$;

-- == S07 D': configurado sin verificar =======================================
DO $$
BEGIN
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true, p_estado => NULL, p_sync => NULL);
  PERFORM pg_temp.expect(pg_temp.summary(pg_temp.status_as('owner')::jsonb),
    'pending_verification|true|healthy|unknown|completed|-|-|verify_connection|-', 'S07');
  RAISE NOTICE 'S07 OK - configurado sin evidencia → pending_verification / verify_connection.';
END $$;

-- == S08 D": evidencia anterior a la credencial vigente ======================
DO $$
BEGIN
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true, p_sync => now() - interval '3 days',
    p_cred_since => now() - interval '1 day');
  PERFORM pg_temp.expect(pg_temp.summary(pg_temp.status_as('owner')::jsonb),
    'pending_verification|true|healthy|unknown|completed|-|-|verify_connection|-', 'S08');
  RAISE NOTICE 'S08 OK - un "conectado" de la credencial anterior no cuenta.';
END $$;

-- == S09-S11 E/F/G: vigencia con reloj inyectado =============================
DO $$
DECLARE v_na timestamptz := '2035-01-01 03:00:00+00'; r jsonb;
BEGIN
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true, p_sync => now());

  r := pg_temp.derive('bizA', v_na + interval '1 second');
  PERFORM pg_temp.expect(pg_temp.summary(r), 'attention|true|expired|connected|completed|-|-|renew_certificate|certificate_expired', 'S09 vencido');
  PERFORM pg_temp.expect(r #>> '{certificate,days_remaining}', '0', 'S09 días');
  PERFORM pg_temp.expect(pg_temp.summary(pg_temp.derive('bizA', v_na)),
    'attention|true|expired|connected|completed|-|-|renew_certificate|certificate_expired', 'S09 notAfter exacto');

  r := pg_temp.derive('bizA', v_na - interval '30 days');
  PERFORM pg_temp.expect(pg_temp.summary(r), 'connected|true|expiring|connected|completed|-|-|renew_certificate|-', 'S10 30 días');
  PERFORM pg_temp.expect(r #>> '{certificate,days_remaining}', '30', 'S10 días');
  PERFORM pg_temp.expect(pg_temp.derive('bizA', v_na - interval '60 days') #>> '{certificate,renewal_state}', 'expiring', 'S10 borde 60');
  PERFORM pg_temp.expect(pg_temp.derive('bizA', v_na - interval '60 days 1 second') #>> '{certificate,renewal_state}', 'healthy', 'S10 borde 60+');
  PERFORM pg_temp.expect(pg_temp.derive('bizA', v_na - interval '61 days') ->> 'next_action', 'none', 'S10 61 días sin acción');

  r := pg_temp.derive('bizA', v_na - interval '10 days');
  PERFORM pg_temp.expect(pg_temp.summary(r), 'connected|true|urgent|connected|completed|-|-|renew_certificate|-', 'S11 10 días');
  PERFORM pg_temp.expect(pg_temp.derive('bizA', v_na - interval '15 days') #>> '{certificate,renewal_state}', 'urgent', 'S11 borde 15');
  PERFORM pg_temp.expect(pg_temp.derive('bizA', v_na - interval '15 days 1 second') #>> '{certificate,renewal_state}', 'expiring', 'S11 borde 15+');
  RAISE NOTICE 'S09-S11 OK - expired / urgent ≤15 / expiring ≤60 / healthy, bordes incluidos.';
END $$;

-- == S12 H: rotación pendiente ===============================================
DO $$
DECLARE r jsonb;
BEGIN
  -- Renovación: credencial vigente sigue conectada mientras espera el certificado nuevo.
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true);
  PERFORM pg_temp.add_rotation('bizA', 'pending_rotation');
  r := pg_temp.status_as('owner')::jsonb;
  PERFORM pg_temp.expect(pg_temp.summary(r), 'connected|true|healthy|connected|in_progress|renewal|certificate|continue_setup|-', 'S12 renewal');
  IF r #>> '{setup,started_at}' IS NULL THEN RAISE EXCEPTION 'S12: falta started_at'; END IF;

  -- Alta inicial: sin credencial activa.
  PERFORM pg_temp.seed_a(NULL, false, p_estado => NULL, p_sync => NULL);
  PERFORM pg_temp.add_rotation('bizA', 'pending_rotation');
  PERFORM pg_temp.expect(pg_temp.summary(pg_temp.status_as('owner')::jsonb),
    'setup_in_progress|false|not_configured|unknown|in_progress|initial|certificate|continue_setup|-', 'S12 initial');
  RAISE NOTICE 'S12 OK - rotación pendiente → in_progress / continue_setup (renewal e initial).';
END $$;

-- == S13 H': activada pendiente de verificación ==============================
DO $$
BEGIN
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true, p_estado => 'activation_pending_wsaa_verification', p_sync => NULL);
  PERFORM pg_temp.add_rotation('bizA', 'activated_pending_verification');
  PERFORM pg_temp.expect(pg_temp.summary(pg_temp.status_as('owner')::jsonb),
    'pending_verification|true|healthy|unknown|in_progress|renewal|verification|continue_setup|-', 'S13');
  RAISE NOTICE 'S13 OK - activada sin verificar → pending_verification, paso verification.';
END $$;

-- == S14 I: historia completed/purged ========================================
DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['completed', 'rolled_back', 'cancelled', 'failed', 'activation_failed'] LOOP
    PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true);
    PERFORM pg_temp.add_rotation('bizA', s);
    PERFORM pg_temp.expect(pg_temp.summary(pg_temp.status_as('owner')::jsonb),
      'connected|true|healthy|connected|completed|-|-|none|-', 'S14 ' || s);
  END LOOP;
  RAISE NOTICE 'S14 OK - completed(purged)/rolled_back/cancelled/failed/activation_failed NO son "en curso".';
END $$;

-- == S15 J: estado_conexion libre y error ====================================
DO $$
DECLARE r jsonb; s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['Conectado', 'CONECTADO ', 'ok', 'desconectado', '<img src=x onerror=alert(1)>', ''] LOOP
    PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true, p_estado => s);
    r := pg_temp.status_as('owner')::jsonb;
    PERFORM pg_temp.expect(r #>> '{connection,state}', 'unknown', 'S15 estado libre «' || s || '»');
    IF s <> '' AND position(s IN r::text) > 0 THEN
      RAISE EXCEPTION 'S15: el texto libre «%» se filtró a la salida', s;
    END IF;
  END LOOP;

  -- Error VIGENTE: evidencia posterior a la credencial actual.
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true, p_estado => 'error',
    p_sync => now(), p_cred_since => now() - interval '1 day');
  r := pg_temp.status_as('owner')::jsonb;
  PERFORM pg_temp.expect(pg_temp.summary(r), 'attention|true|healthy|error|completed|-|-|verify_connection|connection_error', 'S15 error vigente');
  IF r #>> '{connection,last_verified_at}' IS NULL THEN RAISE EXCEPTION 'S15: error vigente sin timestamp'; END IF;
  IF position('ULTIMO-ERROR-SENTINELA' IN r::text) > 0 THEN
    RAISE EXCEPTION 'S15: ultimo_error crudo en la salida';
  END IF;
  RAISE NOTICE 'S15 OK - estado_conexion acotado a connected/error/unknown; ultimo_error nunca sale.';
END $$;

-- == S15b error viejo o sin fecha: no es evidencia de la credencial vigente ===
DO $$
DECLARE r jsonb;
BEGIN
  -- Error de la credencial ANTERIOR (evidencia previa a la rotación).
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true, p_estado => 'error',
    p_sync => now() - interval '3 days', p_cred_since => now() - interval '1 day');
  r := pg_temp.status_as('owner')::jsonb;
  PERFORM pg_temp.expect(pg_temp.summary(r),
    'pending_verification|true|healthy|unknown|completed|-|-|verify_connection|-', 'S15b error viejo');
  IF r #>> '{connection,last_verified_at}' IS NOT NULL THEN RAISE EXCEPTION 'S15b: error viejo expone timestamp'; END IF;
  IF position('ULTIMO-ERROR-SENTINELA' IN r::text) > 0 OR position('connection_error' IN r::text) > 0 THEN
    RAISE EXCEPTION 'S15b: error viejo filtrado a la salida: %', r;
  END IF;

  -- Error sin ultima_sincronizacion: no fechable.
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true, p_estado => 'error', p_sync => NULL);
  r := pg_temp.status_as('owner')::jsonb;
  PERFORM pg_temp.expect(pg_temp.summary(r),
    'pending_verification|true|healthy|unknown|completed|-|-|verify_connection|-', 'S15b error sin fecha');
  IF r #>> '{connection,last_verified_at}' IS NOT NULL OR position('ULTIMO-ERROR-SENTINELA' IN r::text) > 0 THEN
    RAISE EXCEPTION 'S15b: error sin fecha mal derivado: %', r;
  END IF;

  -- Conectado sin fecha tampoco cuenta (simetría con S08).
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true, p_estado => 'conectado', p_sync => NULL);
  PERFORM pg_temp.expect(pg_temp.summary(pg_temp.status_as('owner')::jsonb),
    'pending_verification|true|healthy|unknown|completed|-|-|verify_connection|-', 'S15b conectado sin fecha');
  RAISE NOTICE 'S15b OK - error viejo o sin fecha → unknown / verify_connection, sin connection_error ni timestamp.';
END $$;

-- == S16 par, certificado ilegible, PFX ======================================
DO $$
BEGIN
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_new'), true);   -- credencial = clave de cert_old
  PERFORM pg_temp.expect(pg_temp.summary(pg_temp.status_as('owner')::jsonb),
    'attention|true|healthy|connected|completed|-|-|renew_certificate|credential_certificate_mismatch', 'S16 mismatch');

  PERFORM pg_temp.seed_a('-----BEGIN CERTIFICATE-----NO-ES-BASE64!!', true);
  PERFORM pg_temp.expect(pg_temp.summary(pg_temp.status_as('owner')::jsonb),
    'attention|true|unknown|connected|completed|-|-|renew_certificate|certificate_unreadable', 'S16 ilegible');

  PERFORM pg_temp.seed_a(NULL, false, p_estado => 'conectado');
  UPDATE public.arca_config SET pfx_file = 'PFX-SENTINELA' WHERE business_id = pg_temp.id('bizA');
  PERFORM pg_temp.expect(pg_temp.summary(pg_temp.status_as('owner')::jsonb),
    'attention|false|not_configured|unknown|not_started|-|-|start_setup|legacy_pfx', 'S16 pfx');

  PERFORM pg_temp.seed_a(NULL, true);
  PERFORM pg_temp.expect(pg_temp.summary(pg_temp.status_as('owner')::jsonb),
    'attention|false|not_configured|unknown|not_started|-|-|start_setup|certificate_missing', 'S16 clave sin cert');
  RAISE NOTICE 'S16 OK - mismatch, certificado ilegible, PFX legacy y clave sin certificado piden atención.';
END $$;

-- == S17 K-N can_manage ======================================================
DO $$
DECLARE r record;
BEGIN
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true);
  FOR r IN SELECT * FROM (VALUES
    ('owner', 'true'), ('admin', 'true'), ('admin_no', 'false'), ('manager_yes', 'false'),
    ('tech', 'false'), ('viewer', 'false')) AS t(actor, want) LOOP
    PERFORM pg_temp.expect(pg_temp.status_as(r.actor)::jsonb ->> 'can_manage', r.want, 'S17 ' || r.actor);
    -- Un no-gestor lee el MISMO estado.
    PERFORM pg_temp.expect(pg_temp.summary(pg_temp.status_as(r.actor)::jsonb),
      'connected|true|healthy|connected|completed|-|-|none|-', 'S17 estado para ' || r.actor);
  END LOOP;
  -- Inactivos: no leen (no son miembros activos) y la derivación tampoco los habilita.
  PERFORM pg_temp.expect(left(pg_temp.status_as('owner_inactive'), 15), 'ERR:42501:FORBI', 'S17 owner inactivo');
  PERFORM pg_temp.expect(left(pg_temp.status_as('admin_inactive'), 15), 'ERR:42501:FORBI', 'S17 admin inactivo');
  PERFORM pg_temp.expect(pg_temp.derive('bizA', now(), 'owner_inactive') ->> 'can_manage', 'false', 'S17 derivación owner inactivo');
  PERFORM pg_temp.expect(pg_temp.derive('bizA', now(), 'admin_inactive') ->> 'can_manage', 'false', 'S17 derivación admin inactivo');
  RAISE NOTICE 'S17 OK - can_manage = autoridad canónica; no-gestores leen en solo lectura; inactivos fuera.';
END $$;

-- == S18 O: cross-tenant, anon, plan =========================================
DO $$
DECLARE r jsonb;
BEGIN
  INSERT INTO public.arca_config (business_id, cuit, cuit_emisor, ambiente, punto_venta, web_service, alias)
  VALUES (pg_temp.id('bizB'), '20444444445', '20444444445', 'homologacion', 4, 'wsfe', 'alias-b'),
         (pg_temp.id('bizF'), '20777777778', '20777777778', 'produccion', 7, 'wsfe', 'alias-f');

  PERFORM pg_temp.expect(pg_temp.status_as('ownerB', 'bizA'), 'ERR:42501:FORBIDDEN', 'S18 ownerB pide A');
  PERFORM pg_temp.expect(pg_temp.status_as('owner', 'bizB'), 'ERR:42501:FORBIDDEN', 'S18 owner pide B');
  PERFORM pg_temp.expect(pg_temp.status_as('tech', 'bizB'), 'ERR:42501:FORBIDDEN', 'S18 tech pide B');
  PERFORM pg_temp.expect(pg_temp.status_as(NULL), 'ERR:42501:UNAUTHENTICATED', 'S18 anon');

  r := pg_temp.status_as('ownerB')::jsonb;
  PERFORM pg_temp.expect(r ->> 'cuit', '20444444445', 'S18 ownerB ve SOLO su negocio');
  r := pg_temp.status_as('owner', 'bizA')::jsonb;
  PERFORM pg_temp.expect(r ->> 'cuit', '20111111112', 'S18 confirmación del propio tenant');

  r := pg_temp.status_as('ownerF')::jsonb;
  PERFORM pg_temp.expect(concat_ws('|', r ->> 'available', r ->> 'status', r ->> 'next_action', r ->> 'can_manage',
    coalesce(r ->> 'cuit', '-'), coalesce(r ->> 'punto_venta', '-')), 'false|unavailable|none|false|-|-', 'S18 plan sin arca');
  RAISE NOTICE 'S18 OK - tenant por identidad, mismatch FORBIDDEN, anon fuera, plan sin feature sin metadata.';
END $$;

-- == S19 P: sin claves prohibidas ni material ================================
CREATE OR REPLACE FUNCTION pg_temp.all_keys(j jsonb) RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $$
  WITH RECURSIVE walk(v, path) AS (
    SELECT j, ''::text
    UNION ALL
    SELECT e.value, walk.path || '.' || e.key
      FROM walk, jsonb_each(CASE WHEN jsonb_typeof(walk.v) = 'object' THEN walk.v ELSE '{}'::jsonb END) e)
  SELECT path FROM walk WHERE path <> ''
$$;

DO $$
DECLARE
  v_out   text := '';
  v_keys  text;
  v_forbidden text;
  v_want  text := '.alias,.attention,.available,.can_manage,.certificate,.certificate.days_remaining,'
               || '.certificate.expires_at,.certificate.matches_credential,.certificate.present,'
               || '.certificate.renewal_state,.configured,.connection,.connection.last_verified_at,'
               || '.connection.state,.contract_version,.credential,.credential.active,.cuit,.environment,'
               || '.next_action,.punto_venta,.razon_social,.setup,.setup.kind,.setup.started_at,.setup.state,'
               || '.setup.step,.status';
  r jsonb;
BEGIN
  -- Estado con TODO el material sembrado: cert, token, sign, secreto, rotación con CSR.
  PERFORM pg_temp.seed_a(pg_temp.fx('cert_old'), true, p_estado => 'error');
  PERFORM pg_temp.add_rotation('bizA', 'pending_rotation');
  FOREACH v_forbidden IN ARRAY ARRAY['owner', 'tech', 'ownerF'] LOOP
    r := pg_temp.status_as(v_forbidden)::jsonb;
    SELECT string_agg(k, ',' ORDER BY k) INTO v_keys FROM pg_temp.all_keys(r) k;
    PERFORM pg_temp.expect(v_keys, v_want, 'S19 conjunto EXACTO de claves (' || v_forbidden || ')');
    v_out := v_out || r::text;
  END LOOP;

  FOREACH v_forbidden IN ARRAY ARRAY[
    'cert_file', 'private_key', 'private_key_pem', 'wsaa_token', 'wsaa_sign', 'secret_id', 'csr_pem',
    'certificate_pem', 'pfx', 'fingerprint', 'ultimo_error', 'estado_conexion', 'business_id',
    'BEGIN CERTIFICATE', 'MIIC3zCC', 'TOKEN-SENTINELA', 'SIGN-SENTINELA', 'KEY-SENTINELA', 'CSR-SENTINELA',
    'ULTIMO-ERROR-SENTINELA', '21a64c517e8071', 'cdcdcdcd'] LOOP
    IF position(v_forbidden IN v_out) > 0 THEN
      RAISE EXCEPTION 'S19: la salida contiene «%»', v_forbidden;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM private.arca_private_key_credentials k
              WHERE k.business_id = pg_temp.id('bizA') AND position(k.private_key_secret_id::text IN v_out) > 0) THEN
    RAISE EXCEPTION 'S19: la salida contiene el secret_id';
  END IF;
  RAISE NOTICE 'S19 OK - claves exactas del contrato; sin PEM, CSR, token, sign, secret_id, fingerprint ni texto libre.';
END $$;

-- == S20 solo lectura ========================================================
DO $$
DECLARE v_before text; i int;
BEGIN
  v_before := pg_temp.fingerprint();
  FOR i IN 1..3 LOOP
    PERFORM pg_temp.status_as('owner');
    PERFORM pg_temp.status_as('tech');
    PERFORM pg_temp.status_as('ownerB');
    PERFORM pg_temp.derive('bizA', now() + interval '20 years');
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.fingerprint(), v_before, 'S20 arca_config/credenciales/rotaciones/Vault/auditoría');
  RAISE NOTICE 'S20 OK - leer el estado no escribe filas, Vault ni auditoría.';
END $$;

DO $$ BEGIN RAISE NOTICE 'ARCA Phase 1 SQL: 21/21 OK'; END $$;

ROLLBACK;
