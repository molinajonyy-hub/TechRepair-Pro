-- ============================================================================
-- ARCA SELF-SERVICE · PHASE 2A — motor de configuración inicial
--
--   npm run test:sql:arca-phase2a
--
-- Autocontenido, UNA transacción con ROLLBACK. Certificados y claves SINTÉTICOS
-- (scripts/security/gen-arca-phase2a-fixtures.ts: CA falsa "Computadores Test / AFIP").
-- Las RPC service_role se prueban como postgres con claims {"role":"service_role"}
-- (auth.role() sale del claim, igual que vía PostgREST); los grants por catálogo.
--
--   Q01 catálogo: 8 RPC service_role-only, SECDEF, search_path; helpers sin EXECUTE
--   Q02 autoridad: owner/admin sí; admin sin capacidad, manager, tech, sales, cashier,
--       viewer, inactivos y otro negocio no — en las 8 RPC, sin escribir
--   Q03 datos fiscales: CUIT (formato, dígito verificador, prefijo), ambiente, PV, alias,
--       razón social, idempotency key, CUIT distinto del perfil del negocio
--   Q04 negocios configurados (credencial activa, credencial revocada + fila legacy,
--       certificado suelto) → ARCA_ALREADY_CONFIGURED en todas las RPC, sin escribir
--   Q05 clave/CSR: atributos extra, CSR de otra clave, clave chica, fingerprint declarado
--       falso, certificado en lugar de clave → rechazo sin escribir
--   Q06 Vault sin huérfanos ante una falla inducida al insertar la fila
--   Q07 prepare OK: config fiscal + cuit_emisor, fila initial pendiente, secreto Vault
--       legible con el fingerprint correcto, respuesta sin clave/secret_id/fingerprint
--   Q08 idempotencia: replay (mismo CSR, sin secreto nuevo), conflicto, segunda config,
--       probe con key existente
--   Q09 CSR: recuperación sólo del propio negocio
--   Q10 identidad bloqueada durante la configuración (save_arca_config_legacy)
--   Q11 certificado: inválido, PEM basura, clave privada, dos bloques, otra clave, otro
--       CUIT, otro alias, atributos extra, vencido, todavía no válido, emisor inesperado,
--       emisor de homologación en producción, otro negocio; válido, repetido, reemplazo
--   Q12 material + espera durable: espera pesimista al entregar la clave; en vuelo rechaza
--       verify/attach/cancel; reportes atados al intento; definitivo → 60 s; desconocido y
--       ambiguo → 12 h 30 min monótono; ticket_active; tope del vencimiento observado; no despachado
--   Q13 carrera: el certificado cambia entre material y registro → CERTIFICATE_CHANGED; TA sin
--       registrar → espera hasta el vencimiento observado + 10 min
--   Q14 registro: vencimiento exacto (nunca completado), rechazos, OK libera la espera, replay,
--       reporte tardío no pisa lo registrado, certificado bloqueado
--   Q15 activación con falla inducida: nada activo, setup reanudable, Vault intacto
--   Q16 activación OK: 1 credencial, arca_config, cache WSAA, Phase 1 conectado, replays,
--       el claim de emisión usa el CUIT del certificado
--   Q17 TA verificado con ≤ 90 min: no se activa, espera exacta E + 10 min, re-verificar,
--       activación conectada con cuit_emisor fijado
--   Q18 cancelación: purga Vault, sin referencias colgantes, informa TA posible, idempotente,
--       key consumida, identidad liberada
--   Q21 activación defensiva: CHECK de ticket verificado completo; sin CHECK igual no activa;
--       TA vencido → re-verificar sin espera inútil
--   Q22 la espera sobrevive a cancelar, la hereda el mismo equipo, reportes tardíos extienden
--   Q19 RPC de renovación legacy no operan sobre filas iniciales
--   Q20 exposición: ninguna respuesta del camino de navegador ni la auditoría llevan
--       clave, secret_id, token, sign ni fingerprints completos
-- ============================================================================
BEGIN;

SET LOCAL client_min_messages = notice;

CREATE TEMP TABLE fx (name text PRIMARY KEY, val text) ON COMMIT DROP;
\i /tmp/arca_p2a_fixtures.sql

CREATE OR REPLACE FUNCTION pg_temp.fx(p text) RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT val FROM fx WHERE name = p $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO ids(k, id) SELECT k, gen_random_uuid() FROM unnest(ARRAY[
  'bizA', 'bizB', 'bizC', 'bizR', 'bizF', 'bizT', 'bizP', 'bizS', 'bizK', 'bizV', 'bizE', 'bizH', 'bizN',
  'owner', 'admin', 'admin_no', 'manager_yes', 'tech', 'sales', 'cashier', 'viewer',
  'owner_inactive', 'admin_inactive', 'ownerB', 'ownerC', 'ownerR', 'ownerF', 'ownerT',
  'ownerP', 'ownerS', 'ownerK', 'ownerV', 'ownerE', 'ownerH', 'ownerN']) AS k;
CREATE OR REPLACE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT id FROM ids WHERE k = p $$;

-- Respuestas del camino de navegador (todo menos el material de verificación).
CREATE TEMP TABLE resp (n serial, label text, body jsonb) ON COMMIT DROP;

SET LOCAL session_replication_role = replica;
INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT id, k || '@arca-p2a.invalid', now() FROM ids WHERE k NOT LIKE 'biz%';

INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status)
SELECT pg_temp.id(b), 'ARCA P2A ' || b, pg_temp.id(o), 'pro', 'active'
  FROM (VALUES ('bizA','owner'), ('bizB','ownerB'), ('bizC','ownerC'), ('bizR','ownerR'), ('bizF','ownerF'),
               ('bizT','ownerT'), ('bizP','ownerP'), ('bizS','ownerS'), ('bizK','ownerK'), ('bizV','ownerV'),
               ('bizE','ownerE'), ('bizH','ownerH'), ('bizN','ownerN')) AS x(b, o);

INSERT INTO public.profiles (id, user_id, business_id, role, is_active, permissions, email)
SELECT pg_temp.id(x.k), pg_temp.id(x.k), pg_temp.id(x.biz), x.role, x.active, x.perms, x.k || '@arca-p2a.invalid'
FROM (VALUES
  ('owner',          'bizA', 'owner',   true,  NULL::jsonb),
  ('admin',          'bizA', 'admin',   true,  NULL),
  ('admin_no',       'bizA', 'admin',   true,  '{"settings_sensitive": false}'),
  ('manager_yes',    'bizA', 'manager', true,  '{"settings_sensitive": true}'),
  ('tech',           'bizA', 'tech',    true,  '{"settings_sensitive": true}'),
  ('sales',          'bizA', 'sales',   true,  NULL),
  ('cashier',        'bizA', 'cashier', true,  NULL),
  ('viewer',         'bizA', 'viewer',  true,  NULL),
  ('owner_inactive', 'bizA', 'owner',   false, NULL),
  ('admin_inactive', 'bizA', 'admin',   false, NULL),
  ('ownerB',         'bizB', 'owner',   true,  NULL),
  ('ownerC',         'bizC', 'owner',   true,  NULL),
  ('ownerR',         'bizR', 'owner',   true,  NULL),
  ('ownerF',         'bizF', 'owner',   true,  NULL),
  ('ownerT',         'bizT', 'owner',   true,  NULL),
  ('ownerP',         'bizP', 'owner',   true,  NULL),
  ('ownerS',         'bizS', 'owner',   true,  NULL),
  ('ownerK',         'bizK', 'owner',   true,  NULL),
  ('ownerV',         'bizV', 'owner',   true,  NULL),
  ('ownerE',         'bizE', 'owner',   true,  NULL),
  ('ownerH',         'bizH', 'owner',   true,  NULL),
  ('ownerN',         'bizN', 'owner',   true,  NULL)
) AS x(k, biz, role, active, perms);

-- bizC: configurado (credencial activa + certificado). bizR: credencial REVOCADA + fila
-- legacy NULL-kind pendiente. bizF: sólo certificado cargado. bizT: perfil con otro CUIT.
INSERT INTO public.arca_config (business_id, cuit, cuit_emisor, ambiente, punto_venta, web_service, alias, cert_file, estado_conexion)
VALUES (pg_temp.id('bizC'), '20111111112', '20111111112', 'produccion', 3, 'wsfe', 'clic-like', pg_temp.fx('cert_valid_prod'), 'conectado'),
       (pg_temp.id('bizF'), '20111111112', '20111111112', 'homologacion', 1, 'wsfe', 'loose', pg_temp.fx('cert_valid_homo'), 'no_configurado');
INSERT INTO private.arca_private_key_credentials (business_id, private_key_secret_id, private_key_fingerprint, credential_status)
VALUES (pg_temp.id('bizC'), vault.create_secret('P2A-ACTIVE-C', 'arca-p2a-test-c'), repeat('ab', 32), 'active'),
       (pg_temp.id('bizR'), gen_random_uuid(), repeat('ef', 32), 'revoked');
INSERT INTO private.arca_credential_rotations (business_id, private_key_secret_id, private_key_fingerprint, csr_fingerprint,
  csr_pem, key_size, state, idempotency_key, request_hash)
VALUES (pg_temp.id('bizR'), gen_random_uuid(), repeat('cd', 32), repeat('cd', 32), 'CSR-LEGACY', 2048, 'pending_rotation', 'legacy-r-0001', 'h');
INSERT INTO public.business_settings (business_id, cuit) VALUES (pg_temp.id('bizT'), '20-22222222-3');
SET LOCAL session_replication_role = origin;

-- ── Helpers ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.svc() RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true) $$;

CREATE OR REPLACE FUNCTION pg_temp.expect(p_got text, p_want text, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '%: esperado «%», obtenido «%»', p_label, p_want, p_got;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.keep(p_label text, p_body jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN INSERT INTO resp(label, body) VALUES (p_label, p_body); RETURN p_body; END $$;

CREATE OR REPLACE FUNCTION pg_temp.prep(p_actor text, p_biz text, p_key text, p_idem text DEFAULT 'idem-prepare-0001',
  p_cuit text DEFAULT '20-11111111-2', p_razon text DEFAULT 'QA Setup SRL', p_amb text DEFAULT 'homologacion',
  p_pv int DEFAULT 7, p_alias text DEFAULT 'qa-initial-setup',
  p_key_pem text DEFAULT NULL, p_csr text DEFAULT NULL, p_fp text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.svc();
  RETURN pg_temp.keep('prepare:' || p_key, public.arca_selfservice_prepare_initial(pg_temp.id(p_biz), pg_temp.id(p_actor),
    p_idem, p_cuit, p_razon, p_amb, p_pv, p_alias, p_key_pem, p_csr, p_fp));
EXCEPTION WHEN others THEN RETURN jsonb_build_object('error', SQLSTATE);
END $$;

-- prepare con la clave/CSR pendientes del fixture.
CREATE OR REPLACE FUNCTION pg_temp.prep_ok(p_actor text, p_biz text, p_idem text DEFAULT 'idem-prepare-0001',
  p_amb text DEFAULT 'homologacion', p_pv int DEFAULT 7)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.prep(p_actor, p_biz, 'ok', p_idem, '20-11111111-2', 'QA Setup SRL', p_amb, p_pv, 'qa-initial-setup',
    pg_temp.fx('key_pending'), pg_temp.fx('csr_pending'), pg_temp.fx('fp_pending'))
$$;

CREATE OR REPLACE FUNCTION pg_temp.csr(p_actor text, p_biz text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_temp.svc(); RETURN pg_temp.keep('csr', public.arca_selfservice_get_csr(pg_temp.id(p_biz), pg_temp.id(p_actor)));
EXCEPTION WHEN others THEN RETURN jsonb_build_object('error', SQLSTATE); END $$;

CREATE OR REPLACE FUNCTION pg_temp.attach(p_actor text, p_biz text, p_cert text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_temp.svc(); RETURN pg_temp.keep('attach', public.arca_selfservice_attach_certificate(pg_temp.id(p_biz), pg_temp.id(p_actor), p_cert));
EXCEPTION WHEN others THEN RETURN jsonb_build_object('error', SQLSTATE); END $$;

-- Material: NO se guarda en resp (es la única respuesta server-only que lleva la clave).
CREATE OR REPLACE FUNCTION pg_temp.material(p_actor text, p_biz text, p_attempt uuid DEFAULT gen_random_uuid()) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_temp.svc(); RETURN public.arca_selfservice_verification_material(pg_temp.id(p_biz), pg_temp.id(p_actor), p_attempt);
EXCEPTION WHEN others THEN RETURN jsonb_build_object('error', SQLSTATE); END $$;

CREATE OR REPLACE FUNCTION pg_temp.record(p_actor text, p_biz text, p_fp text, p_sha text,
  p_expires timestamptz DEFAULT now() + interval '11 hours', p_token text DEFAULT 'TOKEN-P2A-SENTINEL', p_sign text DEFAULT 'SIGN-P2A-SENTINEL')
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_temp.svc();
  RETURN pg_temp.keep('record', public.arca_selfservice_record_verification(pg_temp.id(p_biz), pg_temp.id(p_actor), p_fp, p_sha, p_token, p_sign, p_expires));
EXCEPTION WHEN others THEN RETURN jsonb_build_object('error', SQLSTATE); END $$;

CREATE OR REPLACE FUNCTION pg_temp.fail(p_actor text, p_biz text, p_attempt uuid, p_code text, p_observed timestamptz DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_temp.svc(); RETURN pg_temp.keep('fail', public.arca_selfservice_record_verification_failure(pg_temp.id(p_biz), pg_temp.id(p_actor), p_attempt, p_code, p_observed));
EXCEPTION WHEN others THEN RETURN jsonb_build_object('error', SQLSTATE); END $$;

CREATE OR REPLACE FUNCTION pg_temp.activate(p_actor text, p_biz text, p_fp text, p_sha text, p_idem text DEFAULT 'idem-activate-0001')
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_temp.svc(); RETURN pg_temp.keep('activate', public.arca_selfservice_activate(pg_temp.id(p_biz), pg_temp.id(p_actor), p_fp, p_sha, p_idem));
EXCEPTION WHEN others THEN RETURN jsonb_build_object('error', SQLSTATE); END $$;

CREATE OR REPLACE FUNCTION pg_temp.cancel(p_actor text, p_biz text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_temp.svc(); RETURN pg_temp.keep('cancel', public.arca_selfservice_cancel(pg_temp.id(p_biz), pg_temp.id(p_actor)));
EXCEPTION WHEN others THEN RETURN jsonb_build_object('error', SQLSTATE); END $$;

CREATE OR REPLACE FUNCTION pg_temp.st(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT coalesce(p ->> 'state', 'ERR:' || coalesce(p ->> 'error', '?')) $$;

-- Paso de Phase 1 visto por el owner del negocio.
CREATE OR REPLACE FUNCTION pg_temp.phase1(p_biz text, p_owner text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_owner), 'role', 'authenticated')::text, true);
  r := public.get_arca_selfservice_status(pg_temp.id(p_biz));
  RETURN concat_ws('|', r ->> 'status', r ->> 'configured', r #>> '{setup,state}', coalesce(r #>> '{setup,kind}', '-'),
                   coalesce(r #>> '{setup,step}', '-'), r #>> '{connection,state}', r ->> 'next_action');
END $$;

-- Espera de la configuración viva (columna cruda) y simulación de que su ventana venció.
CREATE OR REPLACE FUNCTION pg_temp.hold_of(p_biz text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT verification_hold FROM private.arca_credential_rotations
   WHERE business_id = pg_temp.id(p_biz) AND state = 'pending_rotation' AND setup_kind = 'initial'
$$;
CREATE OR REPLACE FUNCTION pg_temp.elapse(p_biz text) RETURNS void LANGUAGE sql AS $$
  UPDATE private.arca_credential_rotations SET verification_retry_not_before = clock_timestamp() - interval '1 second'
   WHERE business_id = pg_temp.id(p_biz) AND verification_hold IS NOT NULL
$$;
-- Paso + espera de Phase 1 vistos por el owner.
CREATE OR REPLACE FUNCTION pg_temp.phase1_hold(p_biz text, p_owner text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_owner), 'role', 'authenticated')::text, true);
  r := public.get_arca_selfservice_status(pg_temp.id(p_biz));
  RETURN concat_ws('|', coalesce(r #>> '{setup,step}', '-'), coalesce(r #>> '{setup,verification_hold}', '-'),
                   (r #>> '{setup,retry_not_before}') IS NOT NULL);
END $$;

-- Huella del mundo ARCA de un negocio (para "sin escribir").
CREATE OR REPLACE FUNCTION pg_temp.world(p_biz text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(
    coalesce((SELECT t::text FROM public.arca_config t WHERE business_id = pg_temp.id(p_biz)), '') || '#' ||
    coalesce((SELECT string_agg(t::text, '|' ORDER BY t.id) FROM private.arca_credential_rotations t WHERE business_id = pg_temp.id(p_biz)), '') || '#' ||
    coalesce((SELECT string_agg(t::text, '|' ORDER BY t.id) FROM private.arca_private_key_credentials t WHERE business_id = pg_temp.id(p_biz)), '') || '#' ||
    (SELECT count(*) FROM vault.secrets)::text)
$$;

-- == Q01 catálogo ============================================================
DO $$
DECLARE v_fn text; v_role text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
      'public.arca_selfservice_prepare_initial(uuid,uuid,text,text,text,text,integer,text,text,text,text)',
      'public.arca_selfservice_get_csr(uuid,uuid)',
      'public.arca_selfservice_attach_certificate(uuid,uuid,text)',
      'public.arca_selfservice_verification_material(uuid,uuid,uuid)',
      'public.arca_selfservice_record_verification(uuid,uuid,text,text,text,text,timestamptz)',
      'public.arca_selfservice_record_verification_failure(uuid,uuid,uuid,text,timestamptz)',
      'public.arca_selfservice_activate(uuid,uuid,text,text,text)',
      'public.arca_selfservice_cancel(uuid,uuid)'] LOOP
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'Q01 % sin service_role', v_fn; END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'Q01 % ejecutable por %', v_fn, v_role; END IF;
    END LOOP;
    IF NOT (SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION 'Q01 % sin SECDEF/search_path', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['private.arca_selfservice_is_configured(uuid)', 'private.arca_selfservice_validate_certificate(text,text,jsonb)',
                              'private.arca_cuit_is_valid(text)', 'private.arca_selfservice_reject(text,uuid,uuid,text,text)',
                              'private.arca_selfservice_verification_hold(uuid,timestamptz)',
                              'private.arca_selfservice_hold_view(text,timestamptz,timestamptz,boolean,timestamptz)'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'Q01 helper % ejecutable por %', v_fn, v_role; END IF;
    END LOOP;
  END LOOP;
  -- RPC ejecutada como authenticated/anon por claims: el gate auth.role() corta.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('owner'), 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.arca_selfservice_cancel(pg_temp.id('bizA'), pg_temp.id('owner'));
    RAISE EXCEPTION 'Q01 authenticated pasó el gate de rol';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF to_regprocedure('public.arca_selfservice_verification_material(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.arca_selfservice_record_verification_failure(uuid,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Q01 sobrevive una firma vieja sin intento';
  END IF;
  RAISE NOTICE 'Q01 OK - 8 RPC service_role-only + SECDEF + search_path; helpers privados; sin firmas viejas; gate auth.role().';
END $$;

-- == Q02 autoridad ===========================================================
DO $$
DECLARE a text; v_before text := pg_temp.world('bizA'); r jsonb;
BEGIN
  FOR a IN SELECT unnest(ARRAY['admin_no', 'manager_yes', 'tech', 'sales', 'cashier', 'viewer',
                               'owner_inactive', 'admin_inactive', 'ownerB']) LOOP
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep(a, 'bizA', 'auth')), 'UNAUTHORIZED', 'Q02 prepare ' || a);
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.csr(a, 'bizA')), 'UNAUTHORIZED', 'Q02 csr ' || a);
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach(a, 'bizA', pg_temp.fx('cert_valid_homo'))), 'UNAUTHORIZED', 'Q02 attach ' || a);
    r := pg_temp.material(a, 'bizA');
    PERFORM pg_temp.expect(pg_temp.st(r), 'UNAUTHORIZED', 'Q02 material ' || a);
    IF r ? 'signing_key_pem' THEN RAISE EXCEPTION 'Q02 material entregó clave a %', a; END IF;
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.record(a, 'bizA', pg_temp.fx('fp_pending'), repeat('0', 64))), 'UNAUTHORIZED', 'Q02 record ' || a);
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.fail(a, 'bizA', gen_random_uuid(), 'WSAA_REJECTED')), 'UNAUTHORIZED', 'Q02 fail ' || a);
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.activate(a, 'bizA', pg_temp.fx('fp_pending'), repeat('0', 64))), 'UNAUTHORIZED', 'Q02 activate ' || a);
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.cancel(a, 'bizA')), 'UNAUTHORIZED', 'Q02 cancel ' || a);
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('owner', 'bizA', 'auth-owner')), 'KEY_REQUIRED', 'Q02 owner');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('admin', 'bizA', 'auth-admin')), 'KEY_REQUIRED', 'Q02 admin');
  -- Owner de A contra B (otro negocio): la autoridad es por negocio.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('owner', 'bizB', 'auth-cross')), 'UNAUTHORIZED', 'Q02 owner A → B');
  PERFORM pg_temp.expect(pg_temp.world('bizA'), v_before, 'Q02 sin escrituras en A');
  RAISE NOTICE 'Q02 OK - sólo owner/admin con settings_sensitive activos del propio negocio; 8 RPC sin escribir.';
END $$;

-- == Q03 datos fiscales ======================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('20111111113', 'homologacion', 7, 'qa-initial-setup', 'QA', 'idem-fiscal-0001', 'INVALID_CUIT'),       -- dígito verificador
    ('99111111112', 'homologacion', 7, 'qa-initial-setup', 'QA', 'idem-fiscal-0001', 'INVALID_CUIT'),       -- prefijo
    ('2011111111',  'homologacion', 7, 'qa-initial-setup', 'QA', 'idem-fiscal-0001', 'INVALID_CUIT'),       -- 10 dígitos
    ('CUIT20111111112', 'homologacion', 7, 'qa-initial-setup', 'QA', 'idem-fiscal-0001', 'INVALID_CUIT'),   -- basura con dígitos
    ('20111111112', 'produccion ', 7, 'qa-initial-setup', 'QA', 'idem-fiscal-0001', 'INVALID_AMBIENTE'),
    ('20111111112', 'testing',     7, 'qa-initial-setup', 'QA', 'idem-fiscal-0001', 'INVALID_AMBIENTE'),
    ('20111111112', 'homologacion', 0, 'qa-initial-setup', 'QA', 'idem-fiscal-0001', 'INVALID_PUNTO_VENTA'),
    ('20111111112', 'homologacion', 99999, 'qa-initial-setup', 'QA', 'idem-fiscal-0001', 'INVALID_PUNTO_VENTA'),
    ('20111111112', 'homologacion', 7, 'qa_initial', 'QA', 'idem-fiscal-0001', 'INVALID_ALIAS'),            -- '_' no es PrintableString
    ('20111111112', 'homologacion', 7, 'qa setup', 'QA', 'idem-fiscal-0001', 'INVALID_ALIAS'),
    ('20111111112', 'homologacion', 7, 'qa', 'QA', 'idem-fiscal-0001', 'INVALID_ALIAS'),
    ('20111111112', 'homologacion', 7, 'qa-initial-setup', '   ', 'idem-fiscal-0001', 'INVALID_RAZON_SOCIAL'),
    ('20111111112', 'homologacion', 7, 'qa-initial-setup', 'QA', 'short', 'INVALID_IDEMPOTENCY_KEY')
  ) AS t(cuit, amb, pv, alias, razon, idem, want) LOOP
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('owner', 'bizA', 'fiscal', r.idem, r.cuit, r.razon, r.amb, r.pv, r.alias)),
      r.want, format('Q03 %s/%s/%s/%s', r.cuit, r.amb, r.pv, r.alias));
  END LOOP;
  -- Dígito verificador 0 válido.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('owner', 'bizA', 'fiscal', 'idem-fiscal-0002', '20000000060')), 'KEY_REQUIRED', 'Q03 dígito 0');
  -- El perfil canónico del negocio declara otro CUIT.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('ownerT', 'bizT', 'fiscal', 'idem-fiscal-0003', '20-11111111-2')), 'CUIT_TENANT_MISMATCH', 'Q03 CUIT del negocio');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('ownerT', 'bizT', 'fiscal', 'idem-fiscal-0004', '20-22222222-3')), 'KEY_REQUIRED', 'Q03 CUIT del negocio coincide');
  IF (SELECT r2 ->> 'subject' FROM (SELECT pg_temp.prep('owner', 'bizA', 'fiscal', 'idem-fiscal-0005') AS r2) s)::jsonb
     IS DISTINCT FROM '{"cn": "qa-initial-setup", "serialnumber": "CUIT 20111111112"}'::jsonb THEN
    RAISE EXCEPTION 'Q03 el probe no devuelve el subject autorizado exacto';
  END IF;
  RAISE NOTICE 'Q03 OK - CUIT (formato/verificador/prefijo), ambiente, PV, alias PrintableString, razón social, key, CUIT del negocio.';
END $$;

-- == Q04 negocios configurados: nunca ============================================
DO $$
DECLARE b record; v_before text; r jsonb;
BEGIN
  FOR b IN SELECT * FROM (VALUES ('bizC', 'ownerC'), ('bizR', 'ownerR'), ('bizF', 'ownerF')) AS t(biz, owner) LOOP
    v_before := pg_temp.world(b.biz);
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep(b.owner, b.biz, 'cfg')), 'ARCA_ALREADY_CONFIGURED', 'Q04 probe ' || b.biz);
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep(b.owner, b.biz, 'cfg', 'idem-cfg-0001', '20-11111111-2', 'QA Setup SRL',
      'homologacion', 7, 'qa-initial-setup', pg_temp.fx('key_pending'), pg_temp.fx('csr_pending'), pg_temp.fx('fp_pending'))),
      'ARCA_ALREADY_CONFIGURED', 'Q04 prepare ' || b.biz);
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.csr(b.owner, b.biz)), 'ARCA_ALREADY_CONFIGURED', 'Q04 csr ' || b.biz);
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach(b.owner, b.biz, pg_temp.fx('cert_valid_homo'))), 'ARCA_ALREADY_CONFIGURED', 'Q04 attach ' || b.biz);
    r := pg_temp.material(b.owner, b.biz);
    PERFORM pg_temp.expect(pg_temp.st(r), 'ARCA_ALREADY_CONFIGURED', 'Q04 material ' || b.biz);
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.record(b.owner, b.biz, pg_temp.fx('fp_pending'), repeat('0', 64))), 'ARCA_ALREADY_CONFIGURED', 'Q04 record ' || b.biz);
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.activate(b.owner, b.biz, pg_temp.fx('fp_pending'), repeat('0', 64))), 'ARCA_ALREADY_CONFIGURED', 'Q04 activate ' || b.biz);
    r := pg_temp.cancel(b.owner, b.biz);
    IF pg_temp.st(r) NOT IN ('SETUP_NOT_IN_PROGRESS') THEN RAISE EXCEPTION 'Q04 cancel % → %', b.biz, r; END IF;
    PERFORM pg_temp.expect(pg_temp.world(b.biz), v_before, 'Q04 sin escrituras en ' || b.biz);
  END LOOP;
  RAISE NOTICE 'Q04 OK - credencial activa, credencial revocada + fila legacy y certificado suelto: ARCA_ALREADY_CONFIGURED sin escribir.';
END $$;

-- == Q05 clave/CSR inválidos =================================================
DO $$
DECLARE v_before text := pg_temp.world('bizA');
BEGIN
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('owner', 'bizA', 'k', 'idem-key-00001', '20-11111111-2', 'QA Setup SRL', 'homologacion', 7,
    'qa-initial-setup', pg_temp.fx('key_pending'), pg_temp.fx('csr_extra_attrs'), pg_temp.fx('fp_pending'))), 'CSR_SUBJECT_MISMATCH', 'Q05 atributos extra');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('owner', 'bizA', 'k', 'idem-key-00002', '20-11111111-2', 'QA Setup SRL', 'homologacion', 7,
    'qa-initial-setup', pg_temp.fx('key_pending'), pg_temp.fx('csr_other_key'), pg_temp.fx('fp_pending'))), 'CSR_KEY_MISMATCH', 'Q05 CSR de otra clave');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('owner', 'bizA', 'k', 'idem-key-00003', '20-11111111-2', 'QA Setup SRL', 'homologacion', 7,
    'qa-initial-setup', pg_temp.fx('key_small'), pg_temp.fx('csr_pending'), pg_temp.fx('fp_pending'))), 'KEY_GENERATION_FAILED', 'Q05 clave chica');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('owner', 'bizA', 'k', 'idem-key-00004', '20-11111111-2', 'QA Setup SRL', 'homologacion', 7,
    'qa-initial-setup', pg_temp.fx('key_pending'), pg_temp.fx('csr_pending'), pg_temp.fx('fp_other'))), 'KEY_GENERATION_FAILED', 'Q05 fingerprint declarado falso');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('owner', 'bizA', 'k', 'idem-key-00005', '20-11111111-2', 'QA Setup SRL', 'homologacion', 7,
    'qa-initial-setup', pg_temp.fx('cert_valid_homo'), pg_temp.fx('csr_pending'), pg_temp.fx('fp_pending'))), 'KEY_GENERATION_FAILED', 'Q05 certificado como clave');
  -- El CSR pertenece a la clave pero con otro alias en el pedido → subject distinto.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('owner', 'bizA', 'k', 'idem-key-00006', '20-11111111-2', 'QA Setup SRL', 'homologacion', 7,
    'otro-alias', pg_temp.fx('key_pending'), pg_temp.fx('csr_pending'), pg_temp.fx('fp_pending'))), 'CSR_SUBJECT_MISMATCH', 'Q05 alias del pedido ≠ CSR');
  PERFORM pg_temp.expect(pg_temp.world('bizA'), v_before, 'Q05 sin escrituras');
  RAISE NOTICE 'Q05 OK - atributos extra, CSR de otra clave, clave chica, fingerprint falso, certificado como clave, alias distinto.';
END $$;

-- == Q06 Vault sin huérfanos ante falla inducida ==============================
CREATE OR REPLACE FUNCTION pg_temp.boom() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'falla inducida'; END $$;
CREATE TRIGGER p2a_boom BEFORE INSERT ON private.arca_credential_rotations
  FOR EACH ROW WHEN (NEW.setup_kind = 'initial') EXECUTE FUNCTION pg_temp.boom();
DO $$
DECLARE v_secrets bigint := (SELECT count(*) FROM vault.secrets); v_before text := pg_temp.world('bizA');
BEGIN
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep_ok('owner', 'bizA', 'idem-orphan-0001')), 'SETUP_PREPARE_FAILED', 'Q06 estado');
  PERFORM pg_temp.expect((SELECT count(*) FROM vault.secrets)::text, v_secrets::text, 'Q06 secretos Vault');
  PERFORM pg_temp.expect(pg_temp.world('bizA'), v_before, 'Q06 arca_config y filas intactas');
  IF NOT EXISTS (SELECT 1 FROM private.arca_credential_audit WHERE business_id = pg_temp.id('bizA')
                  AND event = 'arca_selfservice_setup_failed' AND status = 'SETUP_PREPARE_FAILED') THEN
    RAISE EXCEPTION 'Q06 la falla no quedó auditada';
  END IF;
  RAISE NOTICE 'Q06 OK - falla al insertar la fila: sin secreto Vault, sin datos fiscales a medias, auditado.';
END $$;
DROP TRIGGER p2a_boom ON private.arca_credential_rotations;

-- == Q07 prepare OK ==========================================================
DO $$
DECLARE r jsonb; v_rot record; v_secrets bigint := (SELECT count(*) FROM vault.secrets); v_cfg record;
BEGIN
  PERFORM pg_temp.expect(pg_temp.phase1('bizA', 'owner'), 'not_configured|false|not_started|-|-|unknown|start_setup', 'Q07 Phase 1 antes');
  r := pg_temp.prep_ok('owner', 'bizA');
  PERFORM pg_temp.expect(pg_temp.st(r), 'SETUP_PREPARED', 'Q07 estado');
  IF r ->> 'csr_pem' IS DISTINCT FROM pg_temp.fx('csr_pending') OR (r #>> '{subject,cuit}') <> '20111111112'
     OR (r #>> '{subject,alias}') <> 'qa-initial-setup' THEN
    RAISE EXCEPTION 'Q07 respuesta inesperada: %', r;
  END IF;
  SELECT * INTO v_rot FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizA');
  IF v_rot.state <> 'pending_rotation' OR v_rot.setup_kind <> 'initial' OR v_rot.private_key_fingerprint <> pg_temp.fx('fp_pending')
     OR v_rot.subject <> '{"cn": "qa-initial-setup", "serialnumber": "CUIT 20111111112"}'::jsonb THEN
    RAISE EXCEPTION 'Q07 fila de configuración inesperada';
  END IF;
  PERFORM pg_temp.expect((SELECT count(*) FROM vault.secrets)::text, (v_secrets + 1)::text, 'Q07 un secreto nuevo');
  PERFORM pg_temp.expect((SELECT private.arca_key_fingerprint(ds.decrypted_secret) FROM vault.decrypted_secrets ds
                           WHERE ds.id = v_rot.private_key_secret_id), pg_temp.fx('fp_pending'), 'Q07 Vault legible con el fingerprint correcto');
  SELECT * INTO v_cfg FROM public.arca_config WHERE business_id = pg_temp.id('bizA');
  PERFORM pg_temp.expect(concat_ws('|', v_cfg.cuit, v_cfg.cuit_emisor, v_cfg.razon_social, v_cfg.ambiente, v_cfg.punto_venta, v_cfg.alias,
    v_cfg.web_service, coalesce(v_cfg.cert_file, '-'), v_cfg.estado_conexion),
    '20111111112|20111111112|QA Setup SRL|homologacion|7|qa-initial-setup|wsfe|-|no_configurado', 'Q07 arca_config');
  PERFORM pg_temp.expect(pg_temp.phase1('bizA', 'owner'), 'setup_in_progress|false|in_progress|initial|certificate|unknown|continue_setup', 'Q07 Phase 1 después');
  RAISE NOTICE 'Q07 OK - clave en Vault (readback), fila initial pendiente, arca_config con cuit_emisor; Phase 1 paso certificate.';
END $$;

-- == Q08 idempotencia ========================================================
DO $$
DECLARE r jsonb; v_secrets bigint := (SELECT count(*) FROM vault.secrets);
BEGIN
  r := pg_temp.prep_ok('owner', 'bizA');
  PERFORM pg_temp.expect(pg_temp.st(r), 'SETUP_ALREADY_PREPARED', 'Q08 replay');
  PERFORM pg_temp.expect(r ->> 'csr_pem', pg_temp.fx('csr_pending'), 'Q08 mismo CSR');
  -- Retry de red: probe con la misma key (sin clave) también es replay.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('owner', 'bizA', 'probe')), 'SETUP_ALREADY_PREPARED', 'Q08 probe replay');
  -- Misma key, pedido distinto.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('owner', 'bizA', 'probe', 'idem-prepare-0001', '20-11111111-2', 'QA Setup SRL', 'homologacion', 8)),
    'IDEMPOTENCY_CONFLICT', 'Q08 conflicto');
  -- Otra key mientras hay una configuración viva.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('admin', 'bizA', 'probe', 'idem-prepare-0002')), 'SETUP_IN_PROGRESS', 'Q08 segunda configuración');
  PERFORM pg_temp.expect((SELECT count(*) FROM vault.secrets)::text, v_secrets::text, 'Q08 sin secretos nuevos');
  PERFORM pg_temp.expect((SELECT count(*) FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizA'))::text, '1', 'Q08 una sola fila');
  RAISE NOTICE 'Q08 OK - replay (mismo CSR, probe incluido), conflicto, una sola configuración viva, sin secretos nuevos.';
END $$;

-- == Q09 CSR =================================================================
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.csr('admin', 'bizA');
  PERFORM pg_temp.expect(pg_temp.st(r), 'CSR_AVAILABLE', 'Q09 estado');
  PERFORM pg_temp.expect(r ->> 'csr_pem', pg_temp.fx('csr_pending'), 'Q09 CSR');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.csr('ownerB', 'bizB')), 'NO_SETUP_IN_PROGRESS', 'Q09 otro negocio sin configuración');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.csr('ownerB', 'bizA')), 'UNAUTHORIZED', 'Q09 otro negocio pide A');
  RAISE NOTICE 'Q09 OK - CSR recuperable sólo por el propio negocio.';
END $$;

-- == Q10 identidad bloqueada durante la configuración ========================
DO $$
DECLARE v_msg text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('owner'), 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.save_arca_config_legacy(pg_temp.id('bizA'), '20-22222222-3');
    RAISE EXCEPTION 'Q10 el CUIT cambió durante la configuración';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS v_msg = PG_EXCEPTION_DETAIL;
    PERFORM pg_temp.expect(v_msg, 'cuit', 'Q10 detalle');
  END;
  BEGIN
    PERFORM public.save_arca_config_legacy(pg_temp.id('bizA'), NULL, NULL, NULL, NULL, NULL, 'otro-alias');
    RAISE EXCEPTION 'Q10 el alias cambió durante la configuración';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM public.save_arca_config_legacy(pg_temp.id('bizA'), NULL, NULL, NULL, 8);   -- PV sigue editable
  PERFORM pg_temp.expect((SELECT punto_venta || '|' || cuit || '|' || alias FROM public.arca_config WHERE business_id = pg_temp.id('bizA')),
    '8|20111111112|qa-initial-setup', 'Q10 PV editable, identidad fija');
  RAISE NOTICE 'Q10 OK - CUIT/alias bloqueados mientras hay configuración viva; PV editable.';
END $$;

-- == Q11 certificado =========================================================
DO $$
DECLARE r record; v jsonb; v_rot record; v_before text;
BEGIN
  v_before := pg_temp.world('bizA');
  FOR r IN SELECT * FROM (VALUES
    ('basura',          'no es un certificado',                                                      'CERTIFICATE_INVALID'),
    ('pem basura',      '-----BEGIN CERTIFICATE-----' || E'\n' || 'QUJDREVG' || E'\n' || '-----END CERTIFICATE-----', 'CERTIFICATE_INVALID'),
    ('clave privada',   pg_temp.fx('key_pending'),                                                   'CERTIFICATE_INVALID'),
    ('cert + clave',    pg_temp.fx('cert_valid_homo') || E'\n' || pg_temp.fx('key_pending'),        'CERTIFICATE_INVALID'),
    ('dos certificados', pg_temp.fx('cert_valid_homo') || E'\n' || pg_temp.fx('cert_valid_prod'),    'CERTIFICATE_INVALID'),
    ('otra clave',      pg_temp.fx('cert_wrong_key'),                                                'CERTIFICATE_KEY_MISMATCH'),
    ('otro CUIT',       pg_temp.fx('cert_wrong_cuit'),                                               'CERTIFICATE_CUIT_MISMATCH'),
    ('otro alias',      pg_temp.fx('cert_wrong_alias'),                                              'CERTIFICATE_ALIAS_MISMATCH'),
    ('atributos extra', pg_temp.fx('cert_extra_attrs'),                                              'CERTIFICATE_SUBJECT_MISMATCH'),
    ('vencido',         pg_temp.fx('cert_expired'),                                                  'CERTIFICATE_EXPIRED'),
    ('no válido aún',   pg_temp.fx('cert_not_yet_valid'),                                            'CERTIFICATE_NOT_YET_VALID'),
    ('emisor falso',    pg_temp.fx('cert_rogue_issuer'),                                             'CERTIFICATE_ISSUER_UNEXPECTED'),
    ('vacío',           '',                                                                          'CERTIFICATE_INVALID'),
    ('enorme',          repeat('A', 70000),                                                          'CERTIFICATE_INVALID')
  ) AS t(label, cert, want) LOOP
    PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('owner', 'bizA', r.cert)), r.want, 'Q11 ' || r.label);
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.world('bizA'), v_before, 'Q11 rechazos sin escribir');

  -- Otro negocio no puede adjuntar a A, ni A a B.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('ownerB', 'bizA', pg_temp.fx('cert_valid_homo'))), 'UNAUTHORIZED', 'Q11 B → A');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('ownerB', 'bizB', pg_temp.fx('cert_valid_homo'))), 'NO_SETUP_IN_PROGRESS', 'Q11 B sin configuración');

  -- Emisor de homologación en una configuración de PRODUCCIÓN.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep_ok('ownerP', 'bizP', 'idem-prod-00001', 'produccion')), 'SETUP_PREPARED', 'Q11 prepare producción');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('ownerP', 'bizP', pg_temp.fx('cert_valid_homo'))), 'CERTIFICATE_ISSUER_UNEXPECTED', 'Q11 emisor test en producción');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('ownerP', 'bizP', pg_temp.fx('cert_valid_prod'))), 'CERTIFICATE_ATTACHED', 'Q11 emisor productivo en producción');

  -- Válido → adjunto; repetido → ya adjunto; mismo par con otros bytes → reemplazo.
  v := pg_temp.attach('owner', 'bizA', E'\n  ' || pg_temp.fx('cert_valid_homo') || E'  \n');
  PERFORM pg_temp.expect(pg_temp.st(v), 'CERTIFICATE_ATTACHED', 'Q11 válido');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('owner', 'bizA', pg_temp.fx('cert_valid_homo'))), 'CERTIFICATE_ALREADY_ATTACHED', 'Q11 repetido');
  SELECT * INTO v_rot FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizA') AND state = 'pending_rotation';
  PERFORM pg_temp.expect(v_rot.certificate_der_sha256,
    encode(extensions.digest(private.arca_pem_to_der(pg_temp.fx('cert_valid_homo')), 'sha256'), 'hex'), 'Q11 sha de los bytes DER');
  PERFORM pg_temp.expect(v_rot.certificate_pem, private.arca_der_to_certificate_pem(private.arca_pem_to_der(pg_temp.fx('cert_valid_homo'))), 'Q11 PEM canónico');
  PERFORM pg_temp.expect(v_rot.certificate_issuer::text, '{"c": "AR", "o": "AFIP", "cn": "Computadores Test"}', 'Q11 issuer saneado');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('owner', 'bizA', pg_temp.fx('cert_valid_prod'))), 'CERTIFICATE_REPLACED', 'Q11 mismo par, otros bytes');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('owner', 'bizA', pg_temp.fx('cert_valid_homo'))), 'CERTIFICATE_REPLACED', 'Q11 vuelta al primero');
  PERFORM pg_temp.expect(pg_temp.phase1('bizA', 'owner'), 'setup_in_progress|false|in_progress|initial|verification|unknown|continue_setup', 'Q11 Phase 1 paso verification');
  RAISE NOTICE 'Q11 OK - 14 rechazos acotados, emisor por ambiente, aislamiento, adjunto/repetido/reemplazo por bytes DER, PEM canónico.';
END $$;

-- == Q12 material + espera durable + reportes por intento =====================
DO $$
DECLARE m jsonb; r jsonb; a1 uuid := gen_random_uuid(); a3 uuid := gen_random_uuid(); a4 uuid := gen_random_uuid();
        v_rot record; v_n bigint;
BEGIN
  m := pg_temp.material('owner', 'bizA', a1);
  PERFORM pg_temp.expect(pg_temp.st(m), 'VERIFICATION_MATERIAL', 'Q12 estado');
  PERFORM pg_temp.expect(private.arca_key_fingerprint(m ->> 'signing_key_pem'), pg_temp.fx('fp_pending'), 'Q12 clave pendiente');
  PERFORM pg_temp.expect(m ->> 'certificate_sha256',
    encode(extensions.digest(private.arca_pem_to_der(pg_temp.fx('cert_valid_homo')), 'sha256'), 'hex'), 'Q12 certificado exacto');
  PERFORM pg_temp.expect(concat_ws('|', m ->> 'ambiente', m ->> 'service'), 'homologacion|wsfe', 'Q12 ambiente y servicio');
  IF m ? 'attempt_id' THEN RAISE EXCEPTION 'Q12 el material devuelve el id de intento'; END IF;
  -- Espera pesimista en el MISMO UPDATE que entregó la clave.
  SELECT * INTO v_rot FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizA') AND state = 'pending_rotation';
  PERFORM pg_temp.expect(concat_ws('|', v_rot.verification_hold, v_rot.verification_attempt_id = a1,
    v_rot.verification_retry_not_before - v_rot.verification_started_at), 'in_flight|t|12:30:00', 'Q12 espera pesimista');
  PERFORM pg_temp.expect(pg_temp.phase1_hold('bizA', 'owner'), 'verification|in_progress|t', 'Q12 Phase 1 en curso');

  -- Segundo verify, attach y cancel durante el vuelo: rechazados, sin clave.
  m := pg_temp.material('admin', 'bizA');
  PERFORM pg_temp.expect(pg_temp.st(m), 'VERIFICATION_IN_PROGRESS', 'Q12 segunda verificación');
  IF m ? 'signing_key_pem' OR (m ->> 'retry_after_seconds')::int < 44900 THEN RAISE EXCEPTION 'Q12 respuesta de espera inválida: %', m - 'signing_key_pem'; END IF;
  r := pg_temp.attach('owner', 'bizA', pg_temp.fx('cert_valid_prod'));
  PERFORM pg_temp.expect(pg_temp.st(r), 'VERIFICATION_IN_PROGRESS', 'Q12 attach en vuelo');
  IF (r ->> 'retry_after_seconds')::int NOT BETWEEN 1 AND 420 THEN RAISE EXCEPTION 'Q12 attach retry_after %', r; END IF;
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.cancel('owner', 'bizA')), 'VERIFICATION_IN_PROGRESS', 'Q12 cancel en vuelo');
  PERFORM pg_temp.expect((SELECT state FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizA') AND setup_kind = 'initial'), 'pending_rotation', 'Q12 cancel no tocó la fila');

  -- Un reporte definitivo de OTRO intento no libera nada.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.fail('owner', 'bizA', gen_random_uuid(), 'WSAA_SERVICE_NOT_AUTHORIZED')), 'ATTEMPT_NOT_FOUND', 'Q12 intento ajeno');
  PERFORM pg_temp.expect(pg_temp.hold_of('bizA'), 'in_flight', 'Q12 intento ajeno sin efecto');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.fail('owner', 'bizA', NULL, 'VERIFICATION_NOT_DISPATCHED')), 'ATTEMPT_NOT_FOUND', 'Q12 sin intento');

  -- Definitivo del MISMO intento en vuelo → espera corta anti-martilleo; repetido → sin efecto.
  r := pg_temp.fail('owner', 'bizA', a1, 'WSAA_SERVICE_NOT_AUTHORIZED');
  PERFORM pg_temp.expect(concat_ws('|', pg_temp.st(r), r ->> 'code', r #>> '{hold,state}'), 'FAILURE_RECORDED|WSAA_SERVICE_NOT_AUTHORIZED|VERIFICATION_COOLDOWN', 'Q12 definitivo');
  PERFORM pg_temp.expect(pg_temp.hold_of('bizA'), 'cooldown', 'Q12 espera corta');
  IF (SELECT verification_retry_not_before - clock_timestamp() FROM private.arca_credential_rotations
       WHERE business_id = pg_temp.id('bizA') AND state = 'pending_rotation') NOT BETWEEN interval '50 seconds' AND interval '61 seconds' THEN
    RAISE EXCEPTION 'Q12 la espera corta no es de 60 s';
  END IF;
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.material('owner', 'bizA')), 'VERIFICATION_COOLDOWN', 'Q12 martilleo rechazado');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.fail('owner', 'bizA', a1, 'VERIFICATION_NOT_DISPATCHED')), 'FAILURE_RECORDED', 'Q12 reporte repetido');
  PERFORM pg_temp.expect(pg_temp.hold_of('bizA'), 'cooldown', 'Q12 un reporte repetido no libera');

  -- Pasa la espera corta → otro intento. Un código DESCONOCIDO es ambiguo (12 h 30 min).
  PERFORM pg_temp.elapse('bizA');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.material('owner', 'bizA', a3)), 'VERIFICATION_MATERIAL', 'Q12 nuevo intento');
  r := pg_temp.fail('owner', 'bizA', a3, 'texto libre <script>');
  PERFORM pg_temp.expect(concat_ws('|', r ->> 'code', r #>> '{hold,state}'), 'WSAA_RESULT_UNKNOWN|WSAA_RESULT_UNKNOWN', 'Q12 desconocido → ambiguo');
  PERFORM pg_temp.expect(pg_temp.hold_of('bizA'), 'result_unknown', 'Q12 espera ambigua');
  IF (SELECT verification_retry_not_before - clock_timestamp() FROM private.arca_credential_rotations
       WHERE business_id = pg_temp.id('bizA') AND state = 'pending_rotation') < interval '12 hours 29 minutes' THEN
    RAISE EXCEPTION 'Q12 la espera ambigua es menor a 12 h 30 min';
  END IF;
  m := pg_temp.material('owner', 'bizA');
  PERFORM pg_temp.expect(pg_temp.st(m), 'WSAA_RESULT_UNKNOWN', 'Q12 verify inmediato rechazado');
  IF m ? 'signing_key_pem' OR (m ->> 'retry_after_seconds')::int < 44900 THEN RAISE EXCEPTION 'Q12 espera ambigua inválida'; END IF;
  PERFORM pg_temp.expect(pg_temp.phase1_hold('bizA', 'owner'), 'verification|result_unknown|t', 'Q12 Phase 1 resultado desconocido');
  -- Un definitivo o un "no despachado" tardío NO acortan una espera ambigua.
  PERFORM pg_temp.fail('owner', 'bizA', a3, 'WSAA_CERTIFICATE_REJECTED');
  PERFORM pg_temp.fail('owner', 'bizA', a3, 'VERIFICATION_NOT_DISPATCHED');
  PERFORM pg_temp.expect(pg_temp.hold_of('bizA'), 'result_unknown', 'Q12 la espera ambigua es monótona');
  -- coe.alreadyAuthenticated → ticket_active; un ambiguo posterior conserva el motivo; vencimiento observado con tope 24 h 10 min.
  PERFORM pg_temp.fail('owner', 'bizA', a3, 'WSAA_TICKET_ALREADY_ISSUED');
  PERFORM pg_temp.fail('owner', 'bizA', a3, 'WSAA_RESPONSE_INVALID', now() + interval '30 hours');
  PERFORM pg_temp.expect(pg_temp.hold_of('bizA'), 'ticket_active', 'Q12 motivo ticket_active conservado');
  IF (SELECT verification_retry_not_before - clock_timestamp() FROM private.arca_credential_rotations
       WHERE business_id = pg_temp.id('bizA') AND state = 'pending_rotation') NOT BETWEEN interval '24 hours 9 minutes' AND interval '24 hours 10 minutes' THEN
    RAISE EXCEPTION 'Q12 vencimiento observado sin tope';
  END IF;
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.material('owner', 'bizA')), 'WSAA_TICKET_ALREADY_ISSUED', 'Q12 TA vigente ajeno');
  PERFORM pg_temp.expect((SELECT count(*) FROM private.arca_credential_audit a WHERE business_id = pg_temp.id('bizA') AND a::text LIKE '%script%')::text, '0', 'Q12 auditoría sin texto libre');
  PERFORM pg_temp.expect((SELECT estado_conexion || '|' || coalesce(wsaa_token, '-') FROM public.arca_config WHERE business_id = pg_temp.id('bizA')),
    'no_configurado|-', 'Q12 arca_config sin evidencia de conexión');

  -- Pasa la ventana → otro intento; "no despachado" del mismo intento en vuelo libera sin esperar.
  PERFORM pg_temp.elapse('bizA');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.material('owner', 'bizA', a4)), 'VERIFICATION_MATERIAL', 'Q12 después de la ventana');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.material('owner', 'bizA', a4)), 'VERIFICATION_IN_PROGRESS', 'Q12 nonce repetido en vuelo');
  PERFORM pg_temp.expect(pg_temp.fail('owner', 'bizA', a4, 'VERIFICATION_NOT_DISPATCHED') #>> '{hold}', NULL, 'Q12 no despachado');
  PERFORM pg_temp.expect(coalesce(pg_temp.hold_of('bizA'), '-'), '-', 'Q12 no despachado libera');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.material('owner', 'bizA', a4)), 'BAD_REQUEST', 'Q12 un nonce no se reutiliza');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.material('owner', 'bizA')), 'VERIFICATION_MATERIAL', 'Q12 material inmediato tras no despachado');
  RAISE NOTICE 'Q12 OK - espera pesimista al entregar la clave; en vuelo rechaza verify/attach/cancel; definitivo sólo del mismo intento en vuelo (60 s); desconocido/ambiguo 12 h 30 min monótono; ticket_active; tope 24 h 10 min; no despachado libera.';
END $$;

-- == Q13 carrera: el certificado cambia entre material y registro ============
DO $$
DECLARE v_old text := encode(extensions.digest(private.arca_pem_to_der(pg_temp.fx('cert_valid_homo')), 'sha256'), 'hex');
        v_attempt uuid; r jsonb;
BEGIN
  -- Un Edge colgado más allá del tope de reloj de pared: el certificado puede reemplazarse, la espera NO se libera.
  UPDATE private.arca_credential_rotations SET verification_started_at = clock_timestamp() - interval '8 minutes'
   WHERE business_id = pg_temp.id('bizA') AND state = 'pending_rotation'
   RETURNING verification_attempt_id INTO v_attempt;
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('admin', 'bizA', pg_temp.fx('cert_valid_prod'))), 'CERTIFICATE_REPLACED', 'Q13 reemplazo');
  PERFORM pg_temp.expect(pg_temp.hold_of('bizA'), 'in_flight', 'Q13 reemplazar no libera la espera');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('owner', 'bizA', pg_temp.fx('fp_pending'), v_old)), 'CERTIFICATE_CHANGED', 'Q13 registro con el sha viejo');
  PERFORM pg_temp.expect((SELECT (wsaa_verified_at IS NULL)::text FROM private.arca_credential_rotations
                           WHERE business_id = pg_temp.id('bizA') AND state = 'pending_rotation'), 'true', 'Q13 sin verificar');
  -- Activar sin verificar informa la espera vigente, no un NOT_VERIFIED sin cota.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.activate('owner', 'bizA', pg_temp.fx('fp_pending'), v_old)), 'WSAA_RESULT_UNKNOWN', 'Q13 activar sin verificar');
  -- El Edge tenía un TA que no pudo registrar: reporte ambiguo con el vencimiento observado → espera hasta E + 10 min.
  r := pg_temp.fail('owner', 'bizA', v_attempt, 'VERIFICATION_RECORD_FAILED', now() + interval '13 hours');
  PERFORM pg_temp.expect(r #>> '{hold,state}', 'WSAA_RESULT_UNKNOWN', 'Q13 reporte ambiguo');
  PERFORM pg_temp.expect((SELECT verification_retry_not_before = now() + interval '13 hours 10 minutes' FROM private.arca_credential_rotations
                           WHERE business_id = pg_temp.id('bizA') AND state = 'pending_rotation')::text, 'true', 'Q13 espera hasta el vencimiento observado + 10 min');
  RAISE NOTICE 'Q13 OK - reemplazo tras un Edge colgado no libera la espera; registro con el sha viejo rechazado; TA sin registrar → espera hasta E + 10 min.';
END $$;

-- == Q14 registro de la verificación ==========================================
DO $$
DECLARE m jsonb; v_sha text;
BEGIN
  PERFORM pg_temp.elapse('bizA');
  m := pg_temp.material('owner', 'bizA');
  PERFORM pg_temp.expect(pg_temp.st(m), 'VERIFICATION_MATERIAL', 'Q14 material');
  v_sha := m ->> 'certificate_sha256';
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('owner', 'bizA', pg_temp.fx('fp_pending'), v_sha, now() + interval '13 hours')), 'WSAA_TICKET_INVALID', 'Q14 vencimiento imposible');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('owner', 'bizA', pg_temp.fx('fp_pending'), v_sha, now() - interval '1 minute')), 'WSAA_TICKET_INVALID', 'Q14 ticket vencido');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('owner', 'bizA', pg_temp.fx('fp_pending'), v_sha, NULL)), 'WSAA_TICKET_INVALID', 'Q14 sin vencimiento');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('owner', 'bizA', pg_temp.fx('fp_pending'), v_sha, now() + interval '11 hours', '')), 'WSAA_TICKET_INVALID', 'Q14 token vacío');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('owner', 'bizA', pg_temp.fx('fp_pending'), v_sha, now() + interval '11 hours', 'T', ' ')), 'WSAA_TICKET_INVALID', 'Q14 sign vacío');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('owner', 'bizA', pg_temp.fx('fp_other'), v_sha)), 'CERTIFICATE_CHANGED', 'Q14 otra clave');
  PERFORM pg_temp.expect(pg_temp.hold_of('bizA'), 'in_flight', 'Q14 rechazos no liberan la espera');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('owner', 'bizA', pg_temp.fx('fp_pending'), v_sha)), 'VERIFIED', 'Q14 OK');
  PERFORM pg_temp.expect(coalesce(pg_temp.hold_of('bizA'), '-'), '-', 'Q14 registrar libera la espera');
  PERFORM pg_temp.expect((SELECT verified_wsaa_token_expires = now() + interval '11 hours' FROM private.arca_credential_rotations
                           WHERE business_id = pg_temp.id('bizA') AND state = 'pending_rotation')::text, 'true', 'Q14 vencimiento exacto guardado');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('owner', 'bizA', pg_temp.fx('fp_pending'), v_sha)), 'ALREADY_VERIFIED', 'Q14 replay');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.fail('owner', 'bizA', (SELECT verification_attempt_id FROM private.arca_credential_rotations
    WHERE business_id = pg_temp.id('bizA') AND state = 'pending_rotation'), 'VERIFICATION_RECORD_FAILED')), 'ALREADY_VERIFIED', 'Q14 un reporte tardío no pisa lo registrado');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('owner', 'bizA', pg_temp.fx('cert_valid_homo'))), 'CERTIFICATE_LOCKED_VERIFIED', 'Q14 certificado bloqueado');
  m := pg_temp.material('owner', 'bizA');
  PERFORM pg_temp.expect(pg_temp.st(m), 'ALREADY_VERIFIED', 'Q14 material tras verificar');
  IF m ? 'signing_key_pem' OR m ? 'certificate_pem' THEN RAISE EXCEPTION 'Q14 la clave salió para un setup ya verificado'; END IF;
  PERFORM pg_temp.expect((SELECT estado_conexion || '|' || coalesce(wsaa_token, '-') FROM public.arca_config WHERE business_id = pg_temp.id('bizA')),
    'no_configurado|-', 'Q14 el ticket NO toca arca_config antes de activar');
  PERFORM pg_temp.expect(pg_temp.phase1('bizA', 'owner'), 'setup_in_progress|false|in_progress|initial|activation|unknown|continue_setup', 'Q14 Phase 1 paso activation');
  PERFORM pg_temp.expect(pg_temp.phase1_hold('bizA', 'owner'), 'activation|-|f', 'Q14 Phase 1 sin espera');
  RAISE NOTICE 'Q14 OK - vencimiento exacto validado (nunca completado) y guardado; registrar libera la espera; un reporte tardío no pisa lo registrado.';
END $$;

-- == Q15 activación con falla inducida ========================================
CREATE OR REPLACE FUNCTION pg_temp.boom_cfg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.cert_file IS DISTINCT FROM OLD.cert_file THEN RAISE EXCEPTION 'falla inducida en activación'; END IF; RETURN NEW; END $$;
CREATE TRIGGER p2a_boom_cfg BEFORE UPDATE ON public.arca_config FOR EACH ROW EXECUTE FUNCTION pg_temp.boom_cfg();
DO $$
DECLARE v_sha text := encode(extensions.digest(private.arca_pem_to_der(pg_temp.fx('cert_valid_prod')), 'sha256'), 'hex');
        v_before text := pg_temp.world('bizA');
BEGIN
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.activate('owner', 'bizA', pg_temp.fx('fp_pending'), v_sha)), 'ACTIVATION_FAILED', 'Q15 estado');
  PERFORM pg_temp.expect(pg_temp.world('bizA'), v_before, 'Q15 nada cambió (credencial, arca_config, fila, Vault)');
  PERFORM pg_temp.expect((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id = pg_temp.id('bizA'))::text, '0', 'Q15 sin credencial');
  PERFORM pg_temp.expect(pg_temp.phase1('bizA', 'owner'), 'setup_in_progress|false|in_progress|initial|activation|unknown|continue_setup', 'Q15 reanudable');
  RAISE NOTICE 'Q15 OK - activación fallida sin estado a medias; la configuración sigue en el paso activation.';
END $$;
DROP TRIGGER p2a_boom_cfg ON public.arca_config;

-- == Q16 activación OK ========================================================
DO $$
DECLARE v_sha text := encode(extensions.digest(private.arca_pem_to_der(pg_temp.fx('cert_valid_prod')), 'sha256'), 'hex');
        r jsonb; v_cfg record; v_rot record; v_cred record; v_comp uuid := gen_random_uuid(); v_claim jsonb;
BEGIN
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.activate('owner', 'bizA', pg_temp.fx('fp_pending'), repeat('0', 64))), 'CERTIFICATE_CHANGED', 'Q16 sha equivocado');
  r := pg_temp.activate('owner', 'bizA', pg_temp.fx('fp_pending'), v_sha);
  PERFORM pg_temp.expect(pg_temp.st(r) || '|' || (r ->> 'connection'), 'ACTIVATED|connected', 'Q16 estado');

  SELECT * INTO v_cred FROM private.arca_private_key_credentials WHERE business_id = pg_temp.id('bizA');
  SELECT * INTO v_rot FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizA') AND setup_kind = 'initial';
  SELECT * INTO v_cfg FROM public.arca_config WHERE business_id = pg_temp.id('bizA');
  PERFORM pg_temp.expect((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id = pg_temp.id('bizA'))::text, '1', 'Q16 una credencial');
  PERFORM pg_temp.expect(concat_ws('|', v_cred.credential_status, v_cred.private_key_fingerprint = pg_temp.fx('fp_pending'),
    v_cred.private_key_secret_id = v_rot.private_key_secret_id), 'active|t|t', 'Q16 credencial = secreto pendiente');
  PERFORM pg_temp.expect(concat_ws('|', v_rot.state, v_rot.verified_wsaa_token IS NULL, v_rot.activated_at IS NOT NULL, v_rot.finalized_at IS NOT NULL),
    'completed|t|t|t', 'Q16 fila completada y ticket purgado');
  PERFORM pg_temp.expect(concat_ws('|', v_cfg.cert_file = v_rot.certificate_pem, v_cfg.cuit_emisor, v_cfg.expires_at = v_rot.certificate_not_after,
    v_cfg.wsaa_token, v_cfg.wsaa_sign, v_cfg.estado_conexion, v_cfg.ultima_sincronizacion IS NOT NULL, v_cfg.web_service),
    't|20111111112|t|TOKEN-P2A-SENTINEL|SIGN-P2A-SENTINEL|conectado|t|wsfe', 'Q16 arca_config');
  PERFORM pg_temp.expect(private.arca_key_fingerprint(private.arca_get_private_key_for_signing(pg_temp.id('bizA'))), pg_temp.fx('fp_pending'), 'Q16 la firma resuelve la clave nueva');
  PERFORM pg_temp.expect(pg_temp.phase1('bizA', 'owner'), 'connected|true|completed|-|-|connected|none', 'Q16 Phase 1 conectado');

  -- Replays y reintentos después de comprometer.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.activate('owner', 'bizA', pg_temp.fx('fp_pending'), v_sha)), 'ALREADY_ACTIVATED', 'Q16 replay misma key');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.activate('admin', 'bizA', pg_temp.fx('fp_pending'), v_sha, 'idem-activate-0002')), 'ALREADY_ACTIVATED', 'Q16 replay otra key');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.activate('owner', 'bizA', pg_temp.fx('fp_other'), v_sha)), 'IDEMPOTENCY_CONFLICT', 'Q16 misma key otro pedido');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.material('owner', 'bizA')), 'SETUP_ALREADY_COMPLETED', 'Q16 verify reintentado');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.cancel('owner', 'bizA')), 'SETUP_ALREADY_COMPLETED', 'Q16 cancel tardío');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep_ok('owner', 'bizA', 'idem-prepare-0009')), 'ARCA_ALREADY_CONFIGURED', 'Q16 nunca un segundo alta');

  -- La emisión toma el CUIT del certificado verificado.
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.comprobantes (id, business_id, tipo) VALUES (v_comp, pg_temp.id('bizA'), 'factura_c');
  SET LOCAL session_replication_role = origin;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('owner'), 'role', 'authenticated')::text, true);
  v_claim := public.claim_comprobante_arca_emission(v_comp, 'p2a-claim-test');
  PERFORM pg_temp.expect(v_claim ->> 'result', 'acquired', 'Q16 claim');
  PERFORM pg_temp.expect((SELECT cuit_emisor || '|' || punto_venta || '|' || ambiente FROM public.arca_emission_attempts WHERE id = (v_claim ->> 'attempt_id')::uuid),
    '20111111112|8|homologacion', 'Q16 el intento snapshotea el CUIT del certificado');

  IF NOT EXISTS (SELECT 1 FROM private.arca_credential_audit WHERE business_id = pg_temp.id('bizA') AND event = 'arca_selfservice_activated'
                  AND details ->> 'ticket_installed' = 'true') THEN
    RAISE EXCEPTION 'Q16 activación sin auditoría';
  END IF;
  RAISE NOTICE 'Q16 OK - una credencial activa, par y ticket instalados, Phase 1 connected/completed/none, replays acotados, claim con el CUIT del certificado.';
END $$;

-- == Q17 TA verificado con ≤ 90 min de vida: NO se activa; espera hasta E + 10 min; re-verificar ==
DO $$
DECLARE m jsonb; r jsonb; v_cfg record; v_rot record; v_e timestamptz := now() + interval '20 minutes';
BEGIN
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep_ok('ownerS', 'bizS', 'idem-short-0001')), 'SETUP_PREPARED', 'Q17 prepare');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('ownerS', 'bizS', pg_temp.fx('cert_valid_homo'))), 'CERTIFICATE_ATTACHED', 'Q17 attach');
  m := pg_temp.material('ownerS', 'bizS');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('ownerS', 'bizS', m ->> 'fingerprint', m ->> 'certificate_sha256', v_e)), 'VERIFIED', 'Q17 record');

  r := pg_temp.activate('ownerS', 'bizS', m ->> 'fingerprint', m ->> 'certificate_sha256', 'idem-short-act0');
  PERFORM pg_temp.expect(pg_temp.st(r), 'VERIFICATION_EXPIRED', 'Q17 no activa un TA casi vencido');
  IF (r ->> 'retry_after_seconds')::int NOT BETWEEN 1700 AND 1800 THEN RAISE EXCEPTION 'Q17 retry_after % (esperado ≈ E + 10 min)', r; END IF;
  SELECT * INTO v_rot FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizS') AND state = 'pending_rotation';
  PERFORM pg_temp.expect(concat_ws('|', v_rot.wsaa_verified_at IS NULL, v_rot.verified_wsaa_token IS NULL, v_rot.verified_wsaa_sign IS NULL,
    v_rot.verified_wsaa_token_expires IS NULL, v_rot.verification_hold, v_rot.verification_retry_not_before = v_e + interval '10 minutes'),
    't|t|t|t|verification_expired|t', 'Q17 verificación descartada en un UPDATE, espera exacta');
  PERFORM pg_temp.expect((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id = pg_temp.id('bizS'))::text, '0', 'Q17 sin credencial');
  PERFORM pg_temp.expect((SELECT coalesce(wsaa_token, '-') || '|' || coalesce(cert_file, '-') FROM public.arca_config WHERE business_id = pg_temp.id('bizS')), '-|-', 'Q17 arca_config intacto');
  -- Respuesta perdida y reintento: la espera, no un NOT_VERIFIED sin cota.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.activate('ownerS', 'bizS', m ->> 'fingerprint', m ->> 'certificate_sha256', 'idem-short-act0')), 'VERIFICATION_EXPIRED', 'Q17 reintento de activación');
  m := pg_temp.material('ownerS', 'bizS');
  PERFORM pg_temp.expect(pg_temp.st(m), 'VERIFICATION_EXPIRED', 'Q17 sin LoginCms antes de E + 10 min');
  IF m ? 'signing_key_pem' THEN RAISE EXCEPTION 'Q17 la clave salió durante la espera'; END IF;
  PERFORM pg_temp.expect(pg_temp.phase1_hold('bizS', 'ownerS'), 'verification|verification_expired|t', 'Q17 Phase 1 verificación vencida');

  -- Vence la espera → verificar de nuevo (sin volver a pedir el certificado) → TA fresco → activación conectada.
  PERFORM pg_temp.elapse('bizS');
  m := pg_temp.material('ownerS', 'bizS');
  PERFORM pg_temp.expect(pg_temp.st(m), 'VERIFICATION_MATERIAL', 'Q17 re-verificar');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('ownerS', 'bizS', m ->> 'fingerprint', m ->> 'certificate_sha256')), 'VERIFIED', 'Q17 TA fresco');
  -- cuit_emisor viejo y DISTINTO del certificado: nunca se emite con otra identidad.
  UPDATE public.arca_config SET cuit_emisor = '20222222223' WHERE business_id = pg_temp.id('bizS');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.activate('ownerS', 'bizS', m ->> 'fingerprint', m ->> 'certificate_sha256', 'idem-short-act1')),
    'FISCAL_IDENTITY_MISMATCH', 'Q17 cuit_emisor ajeno');
  -- cuit_emisor vacío (default de la tabla): la activación lo fija al CUIT del certificado.
  UPDATE public.arca_config SET cuit_emisor = '' WHERE business_id = pg_temp.id('bizS');
  r := pg_temp.activate('ownerS', 'bizS', m ->> 'fingerprint', m ->> 'certificate_sha256', 'idem-short-act2');
  PERFORM pg_temp.expect(pg_temp.st(r) || '|' || (r ->> 'connection'), 'ACTIVATED|connected', 'Q17 activar');
  SELECT * INTO v_cfg FROM public.arca_config WHERE business_id = pg_temp.id('bizS');
  PERFORM pg_temp.expect(concat_ws('|', v_cfg.wsaa_token, v_cfg.estado_conexion, v_cfg.ultima_sincronizacion IS NOT NULL, v_cfg.cuit_emisor,
    v_cfg.wsaa_token_expires = now() + interval '11 hours'),
    'TOKEN-P2A-SENTINEL|conectado|t|20111111112|t', 'Q17 TA instalado con su vencimiento exacto y cuit_emisor fijado');
  PERFORM pg_temp.expect(pg_temp.phase1('bizS', 'ownerS'), 'connected|true|completed|-|-|connected|none', 'Q17 Phase 1 conectado/none');
  RAISE NOTICE 'Q17 OK - un TA con ≤ 90 min no se instala: verificación descartada, espera exacta E + 10 min, re-verificar sin nuevo certificado, activación conectada.';
END $$;

-- == Q18 cancelación ==========================================================
DO $$
DECLARE v_rot record; v_secret uuid; m jsonb; r jsonb;
BEGIN
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.cancel('ownerK', 'bizK')), 'SETUP_NOT_IN_PROGRESS', 'Q18 nada que cancelar');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep_ok('ownerK', 'bizK', 'idem-cancel-0001')), 'SETUP_PREPARED', 'Q18 prepare');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('ownerK', 'bizK', pg_temp.fx('cert_valid_homo'))), 'CERTIFICATE_ATTACHED', 'Q18 attach');
  m := pg_temp.material('ownerK', 'bizK');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('ownerK', 'bizK', m ->> 'fingerprint', m ->> 'certificate_sha256')), 'VERIFIED', 'Q18 verificado');
  SELECT private_key_secret_id INTO v_secret FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizK') AND state = 'pending_rotation';

  r := pg_temp.cancel('ownerK', 'bizK');
  PERFORM pg_temp.expect(concat_ws('|', pg_temp.st(r), r ->> 'remote_ticket_possible'), 'SETUP_CANCELLED|true', 'Q18 cancelar un setup verificado');
  IF r::text ~* 'revoc' THEN RAISE EXCEPTION 'Q18 la cancelación dice haber revocado algo'; END IF;
  SELECT * INTO v_rot FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizK');
  PERFORM pg_temp.expect(concat_ws('|', v_rot.state, v_rot.private_key_secret_id IS NULL, v_rot.certificate_pem IS NULL,
    v_rot.verified_wsaa_token IS NULL, v_rot.verified_wsaa_sign IS NULL, v_rot.verification_hold,
    v_rot.verification_retry_not_before = now() + interval '11 hours 10 minutes'),
    'cancelled|t|t|t|t|ticket_active|t', 'Q18 fila cancelada y purgada; la espera del TA descartado sobrevive');
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE id = v_secret) THEN RAISE EXCEPTION 'Q18 el secreto pendiente sigue en Vault'; END IF;
  IF EXISTS (SELECT 1 FROM private.arca_credential_rotations r WHERE r.private_key_secret_id IS NOT NULL
               AND r.business_id = pg_temp.id('bizK') AND NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = r.private_key_secret_id)) THEN
    RAISE EXCEPTION 'Q18 referencia colgante a Vault';
  END IF;
  PERFORM pg_temp.expect((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id = pg_temp.id('bizK'))::text, '0', 'Q18 sin credencial');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.cancel('ownerK', 'bizK')), 'SETUP_NOT_IN_PROGRESS', 'Q18 idempotente');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep_ok('ownerK', 'bizK', 'idem-cancel-0001')), 'IDEMPOTENCY_KEY_CONSUMED', 'Q18 key consumida');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep('ownerK', 'bizK', 'again', 'idem-cancel-0002')), 'KEY_REQUIRED', 'Q18 nueva key');
  PERFORM pg_temp.expect(pg_temp.phase1('bizK', 'ownerK'), 'not_configured|false|not_started|-|-|unknown|start_setup', 'Q18 Phase 1');
  -- Identidad liberada.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('ownerK'), 'role', 'authenticated')::text, true);
  PERFORM public.save_arca_config_legacy(pg_temp.id('bizK'), '20-22222222-3');
  PERFORM pg_temp.expect((SELECT cuit FROM public.arca_config WHERE business_id = pg_temp.id('bizK')), '20-22222222-3', 'Q18 identidad liberada');
  RAISE NOTICE 'Q18 OK - cancelación purga Vault/ticket/certificado sin referencias colgantes; informa que un TA pudo quedar en ARCA; idempotente; key consumida; identidad liberada.';
END $$;

-- == Q19 RPC de renovación legacy sobre filas iniciales ========================
DO $$
DECLARE v_before text; r jsonb;
BEGIN
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep_ok('ownerV', 'bizV', 'idem-legacy-0001')), 'SETUP_PREPARED', 'Q19 prepare');
  v_before := pg_temp.world('bizV');
  PERFORM pg_temp.svc();
  r := public.arca_cancel_certificate_rotation(pg_temp.id('bizV'), 'idem-legacy-0001', pg_temp.id('ownerV'));
  PERFORM pg_temp.expect(pg_temp.st(r), 'NO_PENDING_ROTATION', 'Q19 cancel legacy');
  r := public.arca_activate_certificate_rotation(pg_temp.id('bizV'), NULL, pg_temp.fx('cert_valid_homo'), pg_temp.fx('fp_pending'), 'idem-legacy-act', pg_temp.id('ownerV'));
  IF (r ->> 'ok')::boolean THEN RAISE EXCEPTION 'Q19 la activación de renovación operó sobre una fila inicial: %', r; END IF;
  -- La auditoría de un intento fallido es la única escritura permitida.
  IF (SELECT md5(coalesce((SELECT t::text FROM public.arca_config t WHERE business_id = pg_temp.id('bizV')), '') ||
                 coalesce((SELECT string_agg(t::text, '|') FROM private.arca_credential_rotations t WHERE business_id = pg_temp.id('bizV')), '')))
     IS DISTINCT FROM (SELECT md5(split_part(v_before, '#', 1))) AND pg_temp.world('bizV') <> v_before THEN
    RAISE EXCEPTION 'Q19 la renovación legacy escribió sobre la configuración inicial';
  END IF;
  PERFORM pg_temp.expect(pg_temp.world('bizV'), v_before, 'Q19 sin escrituras');
  RAISE NOTICE 'Q19 OK - cancel/activate de renovación no operan sobre filas iniciales.';
END $$;

-- == Q21 activación defensiva: ticket verificado completo y coherente ==========
DO $$
DECLARE m jsonb; r jsonb; v_fp text; v_sha text; v_bad text; v_state text; v_hold text; v_creds text;
BEGIN
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep_ok('ownerE', 'bizE', 'idem-defense-0001')), 'SETUP_PREPARED', 'Q21 prepare');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('ownerE', 'bizE', pg_temp.fx('cert_valid_homo'))), 'CERTIFICATE_ATTACHED', 'Q21 attach');
  m := pg_temp.material('ownerE', 'bizE');
  v_fp := m ->> 'fingerprint'; v_sha := m ->> 'certificate_sha256';
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('ownerE', 'bizE', v_fp, v_sha)), 'VERIFIED', 'Q21 verificado');

  -- La base NO admite un estado verificado incompleto o incoherente.
  FOREACH v_bad IN ARRAY ARRAY[
      'verified_wsaa_sign = NULL', 'verified_wsaa_sign = ''  ''', 'verified_wsaa_token = NULL', 'verified_wsaa_token_expires = NULL',
      'verified_wsaa_token_expires = wsaa_verified_at', 'wsaa_verified_at = NULL',
      'verification_hold = ''result_unknown'', verification_retry_not_before = now() + interval ''1 hour''',
      'verification_hold = ''in_flight''', 'verification_hold = ''otro'', verification_retry_not_before = now()'] LOOP
    BEGIN
      EXECUTE format('UPDATE private.arca_credential_rotations SET %s WHERE business_id = %L AND state = ''pending_rotation''', v_bad, pg_temp.id('bizE'));
      RAISE EXCEPTION 'Q21 la base aceptó un ticket verificado inválido: %', v_bad;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  -- Defensa en profundidad: aun sin el CHECK, activar con un ticket sin sign NO activa.
  BEGIN
    ALTER TABLE private.arca_credential_rotations DROP CONSTRAINT arca_credential_rotations_initial_verified_ticket_check;
    UPDATE private.arca_credential_rotations SET verified_wsaa_sign = NULL WHERE business_id = pg_temp.id('bizE') AND state = 'pending_rotation';
    r := pg_temp.activate('ownerE', 'bizE', v_fp, v_sha, 'idem-defense-act1');
    v_state := pg_temp.st(r);
    SELECT verification_hold INTO v_hold FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizE') AND state = 'pending_rotation';
    v_creds := (SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id = pg_temp.id('bizE'))::text;
    RAISE EXCEPTION 'q21_probe_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'q21_probe_rollback' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.expect(concat_ws('|', v_state, v_hold, v_creds), 'VERIFICATION_EXPIRED|verification_expired|0', 'Q21 sin sign: no activa, descarta y espera');
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'arca_credential_rotations_initial_verified_ticket_check') THEN
    RAISE EXCEPTION 'Q21 el probe no restauró el CHECK';
  END IF;

  -- TA verificado que ya venció hace rato: se descarta y se puede re-verificar YA (E + 10 min en el pasado).
  UPDATE private.arca_credential_rotations SET wsaa_verified_at = now() - interval '13 hours', verified_wsaa_token_expires = now() - interval '1 hour'
   WHERE business_id = pg_temp.id('bizE') AND state = 'pending_rotation';
  r := pg_temp.activate('ownerE', 'bizE', v_fp, v_sha, 'idem-defense-act2');
  PERFORM pg_temp.expect(concat_ws('|', pg_temp.st(r), r ->> 'retry_after_seconds'), 'VERIFICATION_EXPIRED|1', 'Q21 TA vencido');
  PERFORM pg_temp.expect(coalesce(pg_temp.hold_of('bizE'), '-'), '-', 'Q21 sin espera inútil');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.material('ownerE', 'bizE')), 'VERIFICATION_MATERIAL', 'Q21 re-verificar inmediato');
  PERFORM pg_temp.expect((SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id = pg_temp.id('bizE'))::text, '0', 'Q21 nada activado');
  RAISE NOTICE 'Q21 OK - CHECK: verificado ⇔ token+sign+vencimiento coherentes y sin espera; activación defensiva aun sin CHECK; TA vencido → re-verificar sin espera inútil.';
END $$;

-- == Q22 la espera sobrevive a cancelar y la hereda el mismo equipo ==============
DO $$
DECLARE h1 uuid := gen_random_uuid(); n1 uuid := gen_random_uuid(); m jsonb; r jsonb; v_cancelled uuid;
BEGIN
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep_ok('ownerH', 'bizH', 'idem-inherit-0001')), 'SETUP_PREPARED', 'Q22 prepare');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('ownerH', 'bizH', pg_temp.fx('cert_valid_homo'))), 'CERTIFICATE_ATTACHED', 'Q22 attach');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.material('ownerH', 'bizH', h1)), 'VERIFICATION_MATERIAL', 'Q22 material');
  -- Timeout después del envío.
  PERFORM pg_temp.fail('ownerH', 'bizH', h1, 'WSAA_RESULT_UNKNOWN');
  r := pg_temp.cancel('ownerH', 'bizH');
  PERFORM pg_temp.expect(concat_ws('|', pg_temp.st(r), r ->> 'remote_ticket_possible'), 'SETUP_CANCELLED|true', 'Q22 cancelar con resultado desconocido');
  SELECT id INTO v_cancelled FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizH') AND state = 'cancelled';
  PERFORM pg_temp.expect((SELECT concat_ws('|', verification_hold, verification_retry_not_before > clock_timestamp() + interval '12 hours 29 minutes',
    private_key_secret_id IS NULL) FROM private.arca_credential_rotations WHERE id = v_cancelled), 'result_unknown|t|t', 'Q22 la espera queda en la fila cancelada');
  PERFORM pg_temp.expect(pg_temp.phase1('bizH', 'ownerH'), 'not_configured|false|not_started|-|-|unknown|start_setup', 'Q22 Phase 1 sin configuración');

  -- Nueva configuración del MISMO equipo (CUIT + alias): hereda la espera.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep_ok('ownerH', 'bizH', 'idem-inherit-0002')), 'SETUP_PREPARED', 'Q22 re-prepare');
  PERFORM pg_temp.expect(pg_temp.phase1_hold('bizH', 'ownerH'), 'certificate|result_unknown|t', 'Q22 Phase 1 muestra la espera heredada');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.attach('ownerH', 'bizH', pg_temp.fx('cert_valid_homo'))), 'CERTIFICATE_ATTACHED', 'Q22 la espera heredada no bloquea subir el certificado');
  m := pg_temp.material('ownerH', 'bizH');
  PERFORM pg_temp.expect(pg_temp.st(m), 'WSAA_RESULT_UNKNOWN', 'Q22 sin LoginCms dentro de la ventana heredada');
  IF m ? 'signing_key_pem' OR (m ->> 'retry_after_seconds')::int < 44900 THEN RAISE EXCEPTION 'Q22 espera heredada inválida'; END IF;
  -- Un reporte tardío del intento viejo extiende la fila cancelada (y la herencia); uno definitivo no la libera.
  r := pg_temp.fail('ownerH', 'bizH', h1, 'VERIFICATION_RECORD_FAILED', now() + interval '20 hours');
  PERFORM pg_temp.expect(r ->> 'state', 'FAILURE_RECORDED', 'Q22 reporte tardío sobre la fila cancelada');
  PERFORM pg_temp.fail('ownerH', 'bizH', h1, 'WSAA_REJECTED');
  m := pg_temp.material('ownerH', 'bizH');
  IF (m ->> 'retry_after_seconds')::int NOT BETWEEN 72500 AND 72600 THEN RAISE EXCEPTION 'Q22 la extensión tardía no llegó a la herencia: %', m - 'signing_key_pem'; END IF;
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.activate('ownerH', 'bizH', pg_temp.fx('fp_pending'), repeat('a', 64))), 'WSAA_RESULT_UNKNOWN', 'Q22 activar sin verificar informa la espera');
  -- Alcance: otro equipo (otro subject) no hereda.
  UPDATE private.arca_credential_rotations SET subject = '{"cn": "otro-equipo", "serialnumber": "CUIT 20111111112"}'::jsonb WHERE id = v_cancelled;
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.material('ownerH', 'bizH')), 'VERIFICATION_MATERIAL', 'Q22 otro equipo no hereda');

  -- Cancelar un setup verificado y re-preparar: el TA descartado bloquea hasta su vencimiento + 10 min.
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep_ok('ownerN', 'bizN', 'idem-inherit-0101')), 'SETUP_PREPARED', 'Q22 N prepare');
  PERFORM pg_temp.attach('ownerN', 'bizN', pg_temp.fx('cert_valid_homo'));
  m := pg_temp.material('ownerN', 'bizN', n1);
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.record('ownerN', 'bizN', m ->> 'fingerprint', m ->> 'certificate_sha256', now() + interval '2 hours')), 'VERIFIED', 'Q22 N verificado');
  PERFORM pg_temp.expect(pg_temp.cancel('ownerN', 'bizN') ->> 'remote_ticket_possible', 'true', 'Q22 N cancelar verificado');
  PERFORM pg_temp.expect(pg_temp.st(pg_temp.prep_ok('ownerN', 'bizN', 'idem-inherit-0102')), 'SETUP_PREPARED', 'Q22 N re-prepare');
  PERFORM pg_temp.attach('ownerN', 'bizN', pg_temp.fx('cert_valid_homo'));
  m := pg_temp.material('ownerN', 'bizN');
  PERFORM pg_temp.expect(pg_temp.st(m), 'WSAA_TICKET_ALREADY_ISSUED', 'Q22 N el TA descartado sigue vigente en ARCA');
  IF (m ->> 'retry_after_seconds')::int NOT BETWEEN 7700 AND 7800 THEN RAISE EXCEPTION 'Q22 N espera ≠ E + 10 min: %', m - 'signing_key_pem'; END IF;

  -- Una espera corta (rechazo definitivo) no se informa como TA posible.
  UPDATE private.arca_credential_rotations SET verification_hold = NULL, verification_retry_not_before = NULL
   WHERE business_id = pg_temp.id('bizN') AND state = 'cancelled';
  m := pg_temp.material('ownerN', 'bizN', gen_random_uuid());
  PERFORM pg_temp.expect(pg_temp.st(m), 'VERIFICATION_MATERIAL', 'Q22 N material');
  PERFORM pg_temp.fail('ownerN', 'bizN', (SELECT verification_attempt_id FROM private.arca_credential_rotations
    WHERE business_id = pg_temp.id('bizN') AND state = 'pending_rotation'), 'WSAA_CERTIFICATE_REJECTED');
  PERFORM pg_temp.expect(pg_temp.cancel('ownerN', 'bizN') ->> 'remote_ticket_possible', 'false', 'Q22 N cooldown no es un TA posible');
  RAISE NOTICE 'Q22 OK - cancelar conserva la espera; el mismo equipo la hereda (material/activar la informan, attach no se bloquea); reportes tardíos extienden; otro equipo no hereda; TA verificado descartado bloquea hasta E + 10 min.';
END $$;

-- == Q20 exposición ==========================================================
DO $$
DECLARE v_out text; f text; v_secret text;
BEGIN
  SELECT string_agg(body::text, '§') INTO v_out FROM resp;
  FOREACH f IN ARRAY ARRAY['PRIVATE KEY', 'signing_key_pem', 'secret_id', 'TOKEN-P2A-SENTINEL', 'SIGN-P2A-SENTINEL',
                           'verified_wsaa', 'fingerprint', pg_temp.fx('fp_pending'), pg_temp.fx('fp_other'),
                           'P2A-ACTIVE-C', 'certificate_pem', 'wsaa_token', 'wsaa_sign', 'decrypted'] LOOP
    IF position(f IN v_out) > 0 THEN RAISE EXCEPTION 'Q20 una respuesta del camino de navegador contiene «%»', left(f, 24); END IF;
  END LOOP;
  FOR v_secret IN SELECT private_key_secret_id::text FROM private.arca_credential_rotations WHERE private_key_secret_id IS NOT NULL
                  UNION SELECT private_key_secret_id::text FROM private.arca_private_key_credentials LOOP
    IF position(v_secret IN v_out) > 0 THEN RAISE EXCEPTION 'Q20 respuesta con secret_id'; END IF;
  END LOOP;
  FOR v_secret IN SELECT verification_attempt_id::text FROM private.arca_credential_rotations WHERE verification_attempt_id IS NOT NULL LOOP
    IF position(v_secret IN v_out) > 0 THEN RAISE EXCEPTION 'Q20 respuesta con id de intento'; END IF;
  END LOOP;
  IF v_out ~* 'in_flight|attempt_id' THEN RAISE EXCEPTION 'Q20 una respuesta expone el estado crudo de la espera o el intento'; END IF;
  IF EXISTS (SELECT 1 FROM private.arca_credential_audit a
              WHERE a.business_id IN (SELECT id FROM ids WHERE k LIKE 'biz%')
                AND (a::text ~ 'PRIVATE KEY|BEGIN CERTIFICATE|TOKEN-P2A|SIGN-P2A' OR length(coalesce(a.fingerprint_trunc, '')) > 16)) THEN
    RAISE EXCEPTION 'Q20 la auditoría contiene material';
  END IF;
  PERFORM pg_temp.expect((SELECT count(*) FROM resp)::text, (SELECT count(*) FROM resp)::text, 'Q20');
  RAISE NOTICE 'Q20 OK - % respuestas del camino de navegador y la auditoría sin clave, secret_id, ticket ni fingerprints.', (SELECT count(*) FROM resp);
END $$;

DO $$ BEGIN RAISE NOTICE 'ARCA Phase 2A SQL: 22/22 OK'; END $$;

ROLLBACK;
