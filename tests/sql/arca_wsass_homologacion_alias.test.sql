-- ============================================================================
-- ARCA SELF-SERVICE · WSASS homologación: nombre del equipo sólo alfanumérico
--
--   npm run test:sql:arca-wsass-alias
--
-- Autocontenido, UNA transacción con ROLLBACK. Reusa los fixtures SINTÉTICOS de Phase 2A
-- (CA falsa "Computadores Test / AFIP", CN=qainitialsetup). La RPC service_role se prueba como
-- postgres con claims {"role":"service_role"} (auth.role() sale del claim, igual que vía PostgREST).
--
-- Origen: smoke real de homologación 2026-09-15. WSASS rechaza '.' y '-' en "Nombre simbólico
-- del DN" y emite el certificado con CN = ese nombre, así que prepare_initial no puede aceptar
-- en homologación un alias que WSASS no puede emitir.
--
--   W01 catálogo: una sola firma, SECDEF, search_path fijo, EXECUTE sólo service_role
--   W02 homologación acepta letras/números de 3 a 50 (probe → KEY_REQUIRED)
--   W03 homologación rechaza con INVALID_ALIAS: corto, largo, punto, guion, '_', espacio,
--       acentos, '/', '@', símbolos, tabs, no-ASCII, vacío y NULL
--   W04 producción: el contrato previo no se amplió ni se redujo (casos explícitos + un corpus
--       comparado contra la regex anterior, en ambos sentidos)
--   W05 orden de validación y códigos: ambiente inválido sigue siendo INVALID_AMBIENTE; un alias
--       inválido nunca devuelve un código nuevo
--   W06 prepare completo: homologación con alias con guion NO escribe (ni Vault ni fila); con
--       alias alfanumérico SETUP_PREPARED; replay idempotente intacto
--   W07 negocio ya configurado con un alias viejo con guion en homologación: sigue siendo
--       ARCA_ALREADY_CONFIGURED (la regla nueva no toca configuraciones existentes)
--   W08 la matriz no escribió nada fuera de W06
-- ============================================================================
BEGIN;

SET LOCAL client_min_messages = notice;

CREATE TEMP TABLE fx (name text PRIMARY KEY, val text) ON COMMIT DROP;
\i /tmp/arca_wsass_fixtures.sql

CREATE OR REPLACE FUNCTION pg_temp.fx(p text) RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT val FROM fx WHERE name = p $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO ids(k, id) SELECT k, gen_random_uuid() FROM unnest(ARRAY['bizH', 'bizP', 'bizW', 'bizC', 'ownerH', 'ownerP', 'ownerW', 'ownerC']) AS k;
CREATE OR REPLACE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT id FROM ids WHERE k = p $$;

SET LOCAL session_replication_role = replica;
INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT id, k || '@arca-wsass.invalid', now() FROM ids WHERE k LIKE 'owner%';
INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status)
SELECT pg_temp.id(b), 'ARCA WSASS ' || b, pg_temp.id(o), 'pro', 'active'
  FROM (VALUES ('bizH', 'ownerH'), ('bizP', 'ownerP'), ('bizW', 'ownerW'), ('bizC', 'ownerC')) AS x(b, o);
INSERT INTO public.profiles (id, user_id, business_id, role, is_active, email)
SELECT pg_temp.id(o), pg_temp.id(o), pg_temp.id(b), 'owner', true, o || '@arca-wsass.invalid'
  FROM (VALUES ('bizH', 'ownerH'), ('bizP', 'ownerP'), ('bizW', 'ownerW'), ('bizC', 'ownerC')) AS x(b, o);
-- bizC: homologación ya conectada con un alias viejo con guion (como quedaría un alta previa).
INSERT INTO public.arca_config (business_id, cuit, cuit_emisor, ambiente, punto_venta, web_service, alias, cert_file, estado_conexion)
VALUES (pg_temp.id('bizC'), '20111111112', '20111111112', 'homologacion', 1, 'wsfe', 'demo-homo-previo', pg_temp.fx('cert_valid_homo'), 'conectado');
INSERT INTO private.arca_private_key_credentials (business_id, private_key_secret_id, private_key_fingerprint, credential_status)
VALUES (pg_temp.id('bizC'), vault.create_secret('WSASS-ACTIVE-C', 'arca-wsass-test-c'), repeat('ab', 32), 'active');
SET LOCAL session_replication_role = origin;

-- ── Helpers ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.expect(p_got text, p_want text, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '%: esperado «%», obtenido «%»', p_label, p_want, p_got;
  END IF;
END $$;

-- Probe (sin clave): valida los datos fiscales y devuelve KEY_REQUIRED sin escribir nada.
CREATE OR REPLACE FUNCTION pg_temp.probe(p_biz text, p_owner text, p_amb text, p_alias text, p_idem text DEFAULT 'wsass-probe-0001')
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  RETURN public.arca_selfservice_prepare_initial(pg_temp.id(p_biz), pg_temp.id(p_owner), p_idem,
    '20-11111111-2', 'QA WSASS SRL', p_amb, 1, p_alias) ->> 'state';
EXCEPTION WHEN others THEN RETURN 'ERROR ' || SQLSTATE;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.world() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(concat_ws('|',
    (SELECT count(*) FROM private.arca_credential_rotations),
    (SELECT count(*) FROM private.arca_private_key_credentials),
    (SELECT count(*) FROM private.arca_credential_audit),
    (SELECT count(*) FROM vault.secrets),
    (SELECT coalesce(string_agg(t::text, '|' ORDER BY t::text), '') FROM public.arca_config t)))
$$;

-- ── W01 catálogo ────────────────────────────────────────────────────────────
DO $$
DECLARE v_fn constant text := 'public.arca_selfservice_prepare_initial(uuid,uuid,text,text,text,text,integer,text,text,text,text)';
BEGIN
  PERFORM pg_temp.expect((SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                           WHERE n.nspname = 'public' AND p.proname = 'arca_selfservice_prepare_initial'), '1', 'W01 una sola firma');
  PERFORM pg_temp.expect((SELECT prosecdef::text FROM pg_proc WHERE oid = v_fn::regprocedure), 'true', 'W01 SECURITY DEFINER');
  PERFORM pg_temp.expect((SELECT (proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])::text FROM pg_proc WHERE oid = v_fn::regprocedure), 'true', 'W01 search_path');
  PERFORM pg_temp.expect(concat_ws('|', has_function_privilege('service_role', v_fn, 'EXECUTE'),
    has_function_privilege('authenticated', v_fn, 'EXECUTE'), has_function_privilege('anon', v_fn, 'EXECUTE')), 't|f|f', 'W01 EXECUTE sólo service_role');
  PERFORM pg_temp.expect((SELECT count(*)::text FROM pg_proc p, aclexplode(p.proacl) a
                           WHERE p.oid = v_fn::regprocedure AND a.grantee = 0), '0', 'W01 sin PUBLIC');
  RAISE NOTICE 'W01 OK - una firma, SECDEF, search_path fijo, EXECUTE sólo service_role.';
END $$;

-- ── W02 homologación: aceptados ─────────────────────────────────────────────
DO $$
DECLARE a text;
BEGIN
  FOREACH a IN ARRAY ARRAY['abc', 'techrepair', 'techrepairdemohomo', 'techrepairdemolocal', 'techrepair20301234567',
                           'Demo2026', 'ABC', '123', 'a1b2c3', 'TechRepairPRO', repeat('a', 50), repeat('9', 50),
                           'x' || repeat('Y1', 24) || 'z'] LOOP
    PERFORM pg_temp.expect(pg_temp.probe('bizH', 'ownerH', 'homologacion', a), 'KEY_REQUIRED', format('W02 homologación acepta «%s»', a));
  END LOOP;
  -- Espacios al borde: el alias se recorta (btrim) antes de validar, como siempre.
  PERFORM pg_temp.expect(pg_temp.probe('bizH', 'ownerH', 'homologacion', '  techrepair  '), 'KEY_REQUIRED', 'W02 btrim previo');
  RAISE NOTICE 'W02 OK - homologación acepta letras y números de 3 a 50 caracteres.';
END $$;

-- ── W03 homologación: rechazados ────────────────────────────────────────────
DO $$
DECLARE a text;
BEGIN
  FOREACH a IN ARRAY ARRAY['ab', 'a', repeat('a', 51), repeat('1', 51),
                           'techrepair-demo', 'techrepair.demo', 'techrepair_demo', 'techrepair demo',
                           'techrepair-demo-homo', 'molina.jonyy2', '-techrepair', 'techrepair-', '.techrepair',
                           'técnico', 'tecnicoñ', 'ÁBCDEF', 'demo/arca', 'demo@arca', 'demo#1', 'demo+1', 'demo,1', 'demo:1',
                           'demo''1', 'demo"1', 'demo\1', 'demo*', 'tech' || chr(9) || 'repair', 'tech' || chr(10) || 'repair',
                           'ｔｅｃｈ', '١٢٣abc', 'demo😀', ''] LOOP
    PERFORM pg_temp.expect(pg_temp.probe('bizH', 'ownerH', 'homologacion', a), 'INVALID_ALIAS', format('W03 homologación rechaza «%s»', a));
  END LOOP;
  PERFORM pg_temp.expect(pg_temp.probe('bizH', 'ownerH', 'homologacion', NULL), 'INVALID_ALIAS', 'W03 homologación rechaza NULL');
  PERFORM pg_temp.expect(pg_temp.probe('bizH', 'ownerH', 'homologacion', '   '), 'INVALID_ALIAS', 'W03 homologación rechaza sólo espacios');
  RAISE NOTICE 'W03 OK - homologación rechaza punto, guion, underscore, espacios, acentos, símbolos, no-ASCII, largos inválidos, vacío y NULL.';
END $$;

-- ── W04 producción: mismo contrato que antes ────────────────────────────────
DO $$
DECLARE
  a text;
  v_old constant text := '^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$';
  v_want text;
  v_n int := 0;
BEGIN
  -- Casos explícitos: '.' y '-' siguen valiendo en producción.
  FOREACH a IN ARRAY ARRAY['abc', 'techrepair', 'qa-initial-setup', 'demo.local2', 'tech-repair.demo', 'a.b', 'a-b', 'a--', 'a..',
                           'techrepairdemohomo', 'A' || repeat('.-', 24) || 'z'] LOOP
    PERFORM pg_temp.expect(pg_temp.probe('bizP', 'ownerP', 'produccion', a), 'KEY_REQUIRED', format('W04 producción acepta «%s»', a));
  END LOOP;
  FOREACH a IN ARRAY ARRAY['ab', '-abc', '.abc', 'qa_initial', 'qa setup', repeat('a', 51), 'técnico', 'demo/arca', ''] LOOP
    PERFORM pg_temp.expect(pg_temp.probe('bizP', 'ownerP', 'produccion', a), 'INVALID_ALIAS', format('W04 producción sigue rechazando «%s»', a));
  END LOOP;

  -- Corpus: la función en producción coincide con la regex anterior en ambos sentidos.
  FOR a IN
    SELECT DISTINCT s FROM (
      SELECT unnest(ARRAY['abc', 'ab', 'a.b', 'a-b', 'a_b', 'a b', '.ab', '-ab', 'ab.', 'ab-', 'Ab1', '1ab', 'ÁBC', 'ñandu', 'x/y', 'x@y',
                          'a' || repeat('b', 48), 'a' || repeat('b', 49), 'a' || repeat('b', 50), 'a' || repeat('.', 49), 'a' || repeat('-', 50),
                          'tech' || chr(9) || 'x', 'qa-initial-setup', 'molina.jonyy2']) AS s
      UNION ALL
      -- combinaciones cortas de un alfabeto con letras, dígitos y separadores
      SELECT c1 || c2 || c3 || c4
        FROM unnest(ARRAY['a', 'Z', '0', '.', '-', '_', ' ']) c1,
             unnest(ARRAY['b', '9', '.', '-', '_']) c2,
             unnest(ARRAY['c', '.', '-']) c3,
             unnest(ARRAY['', 'd', '-']) c4
    ) q
  LOOP
    v_want := CASE WHEN btrim(a) ~ v_old THEN 'KEY_REQUIRED' ELSE 'INVALID_ALIAS' END;
    PERFORM pg_temp.expect(pg_temp.probe('bizP', 'ownerP', 'produccion', a), v_want, format('W04 corpus producción «%s»', a));
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'W04 OK - producción sin cambios: casos explícitos y % alias del corpus iguales a la regla anterior.', v_n;
END $$;

-- ── W05 orden y códigos ─────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM pg_temp.expect(pg_temp.probe('bizH', 'ownerH', 'testing', 'techrepair-demo'), 'INVALID_AMBIENTE', 'W05 ambiente desconocido antes que el alias');
  PERFORM pg_temp.expect(pg_temp.probe('bizH', 'ownerH', 'homologacion ', 'techrepair'), 'INVALID_AMBIENTE', 'W05 ambiente con espacio');
  PERFORM pg_temp.expect(pg_temp.probe('bizH', 'ownerH', 'HOMOLOGACION', 'techrepair-demo'), 'INVALID_AMBIENTE', 'W05 ambiente en mayúsculas');
  -- Un alias inválido nunca produce un código nuevo.
  PERFORM pg_temp.expect((SELECT string_agg(DISTINCT pg_temp.probe('bizH', 'ownerH', 'homologacion', a), ',')
                            FROM unnest(ARRAY['a-b-c', 'a.b.c', 'a_b_c', 'á b c']) a), 'INVALID_ALIAS', 'W05 un solo código');
  RAISE NOTICE 'W05 OK - ambiente se valida antes; alias inválido siempre es INVALID_ALIAS.';
END $$;

-- ── W06 prepare completo con clave ──────────────────────────────────────────
DO $$
DECLARE r jsonb; v_world text := pg_temp.world();
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- Clave + CSR reales del fixture, pero alias con guion en homologación: rechazo antes de Vault.
  r := public.arca_selfservice_prepare_initial(pg_temp.id('bizW'), pg_temp.id('ownerW'), 'wsass-full-0001',
         '20-11111111-2', 'QA WSASS SRL', 'homologacion', 1, 'qa-initial-setup',
         pg_temp.fx('key_pending'), pg_temp.fx('csr_pending'), pg_temp.fx('fp_pending'));
  PERFORM pg_temp.expect(r ->> 'state', 'INVALID_ALIAS', 'W06 homologación con guion y clave');
  PERFORM pg_temp.expect(pg_temp.world(), v_world, 'W06 el rechazo no escribió nada');

  r := public.arca_selfservice_prepare_initial(pg_temp.id('bizW'), pg_temp.id('ownerW'), 'wsass-full-0002',
         '20-11111111-2', 'QA WSASS SRL', 'homologacion', 1, 'qainitialsetup',
         pg_temp.fx('key_pending'), pg_temp.fx('csr_pending'), pg_temp.fx('fp_pending'));
  PERFORM pg_temp.expect(r ->> 'state', 'SETUP_PREPARED', 'W06 homologación alfanumérica');
  PERFORM pg_temp.expect(r #>> '{subject,alias}', 'qainitialsetup', 'W06 subject');
  PERFORM pg_temp.expect((SELECT concat_ws('|', setup_kind, state, subject::text, fiscal_snapshot ->> 'alias', fiscal_snapshot ->> 'ambiente')
                            FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizW')),
    'initial|pending_rotation|{"cn": "qainitialsetup", "serialnumber": "CUIT 20111111112"}|qainitialsetup|homologacion', 'W06 fila pendiente');

  r := public.arca_selfservice_prepare_initial(pg_temp.id('bizW'), pg_temp.id('ownerW'), 'wsass-full-0002',
         '20-11111111-2', 'QA WSASS SRL', 'homologacion', 1, 'qainitialsetup',
         pg_temp.fx('key_pending'), pg_temp.fx('csr_pending'), pg_temp.fx('fp_pending'));
  PERFORM pg_temp.expect(r ->> 'state', 'SETUP_ALREADY_PREPARED', 'W06 replay idempotente');
  PERFORM pg_temp.expect((SELECT count(*)::text FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizW')), '1', 'W06 una sola fila');
  RAISE NOTICE 'W06 OK - alias con guion no escribe; alfanumérico prepara; replay intacto.';
END $$;

-- ── W07 configuraciones existentes ──────────────────────────────────────────
DO $$
DECLARE v_before text := (SELECT md5(t::text) FROM public.arca_config t WHERE business_id = pg_temp.id('bizC'));
BEGIN
  PERFORM pg_temp.expect(pg_temp.probe('bizC', 'ownerC', 'homologacion', 'demo-homo-previo'), 'ARCA_ALREADY_CONFIGURED', 'W07 configurado con alias viejo');
  PERFORM pg_temp.expect(pg_temp.probe('bizC', 'ownerC', 'homologacion', 'otroalias'), 'ARCA_ALREADY_CONFIGURED', 'W07 configurado con alias nuevo');
  PERFORM pg_temp.expect((SELECT md5(t::text) FROM public.arca_config t WHERE business_id = pg_temp.id('bizC')), v_before, 'W07 config intacta');
  RAISE NOTICE 'W07 OK - un negocio ya configurado con alias viejo sigue igual.';
END $$;

-- ── W08 sin escrituras fuera de W06 ─────────────────────────────────────────
DO $$
BEGIN
  -- Los probes de W02–W05 (bizH, bizP) no dejan filas, configuración, secretos ni auditoría; la única
  -- escritura de la suite es el prepare alfanumérico de W06 (bizW). bizC sólo audita su rechazo.
  PERFORM pg_temp.expect(concat_ws('|',
      (SELECT count(*) FROM private.arca_credential_rotations WHERE business_id IN (pg_temp.id('bizH'), pg_temp.id('bizP'), pg_temp.id('bizC'))),
      (SELECT count(*) FROM public.arca_config WHERE business_id IN (pg_temp.id('bizH'), pg_temp.id('bizP'))),
      (SELECT count(*) FROM private.arca_credential_audit WHERE business_id IN (pg_temp.id('bizH'), pg_temp.id('bizP'))),
      (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key-setup:%'
         AND (name LIKE '%' || pg_temp.id('bizH') || '%' OR name LIKE '%' || pg_temp.id('bizP') || '%')),
      (SELECT count(*) FROM private.arca_credential_rotations WHERE business_id = pg_temp.id('bizW'))),
    '0|0|0|0|1', 'W08 sólo W06 escribió');
  RAISE NOTICE 'W08 OK - probes sin escrituras ni auditoría.';
END $$;

ROLLBACK;
