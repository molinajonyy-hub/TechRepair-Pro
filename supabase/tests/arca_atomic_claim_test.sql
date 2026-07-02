-- ============================================================
-- Test suite: claim_comprobante_arca_emission / reserve_arca_number /
--             mark_arca_attempt_sent / complete_arca_attempt
--             (supabase/migrations/20260701150000_arca_atomic_claim.sql)
--
-- HOW TO RUN (needs a local Supabase stack; NOT against prod):
--   supabase start (o db reset para aplicar migraciones desde cero)
--   docker exec -i <postgres_container> psql -U postgres -d postgres \
--     -f supabase/tests/arca_atomic_claim_test.sql
--
-- ALCANCE DE ESTE ARCHIVO: escenarios que se pueden verificar de forma
-- DETERMINISTA dentro de UNA sola transacción/sesión (lógica de las RPCs,
-- permisos, transición de estados, resolución de serie). Sigue el mismo
-- patrón que whatsapp_admin_provision_test.sql (transacción única +
-- ROLLBACK final, no persiste nada).
--
-- LO QUE ESTE ARCHIVO **NO** PRUEBA (a propósito — una sola sesión no puede
-- demostrar exclusión mutua real entre conexiones concurrentes):
--   - Dos claims SIMULTÁNEOS del mismo comprobante_id desde conexiones
--     independientes.
--   - Dos claims SIMULTÁNEOS de comprobantes distintos de la misma serie
--     desde conexiones independientes.
--   - Dos procesos compitiendo por recuperar el mismo intento abandonado.
--   Esos tres casos usan DOS CONEXIONES REALES (no dos sentencias
--   secuenciales en una sesión) y viven en:
--     supabase/tests/run-arca-concurrency-test.mjs
--   El rollback completo de la migración en una base temporal vive en:
--     supabase/tests/arca_migration_rollback_test.sql
--
-- Runs inside a single transaction and ROLLBACKs at the end.
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;

-- ── assertion helpers (transaction-local) ───────────────────
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label;
  ELSE RAISE NOTICE 'PASS: %', label; END IF;
END; $$;

-- ── fictitious identifiers ──────────────────────────────────
\set bizA '00000000-0000-0000-0000-0000000000a1'
\set bizB '00000000-0000-0000-0000-0000000000b2'
\set ownerA '00000000-0000-0000-0000-0000000000a9'
\set ownerB '00000000-0000-0000-0000-0000000000b9'
\set outsider '00000000-0000-0000-0000-000000000fff'

-- ── fixtures (FK/triggers off) ──────────────────────────────
SET LOCAL session_replication_role = 'replica';
INSERT INTO public.businesses(id, name) VALUES (:'bizA','Test Biz A'), (:'bizB','Test Biz B');
INSERT INTO public.profiles(business_id, user_id, role, is_active)
  VALUES (:'bizA', :'ownerA', 'owner', true), (:'bizB', :'ownerB', 'owner', true);

-- arca_config de bizA: serie fiscal real = (produccion? no, homologacion para
-- test, CUIT 20111111112, punto de venta 1). Nota: cuit_emisor con guiones a
-- propósito, para probar que se normaliza (regexp_replace \D) antes de usarse
-- como clave del índice de serie.
INSERT INTO public.arca_config(business_id, cuit_emisor, punto_venta, ambiente)
  VALUES (:'bizA', '20-11111111-2', 1, 'homologacion');

-- arca_config de bizB: serie DISTINTA (otro CUIT, otro punto de venta).
INSERT INTO public.arca_config(business_id, cuit_emisor, punto_venta, ambiente)
  VALUES (:'bizB', '20-22222222-3', 2, 'homologacion');

-- Comprobantes de bizA — todos factura_c (tipo_comprobante ARCA = 11), misma serie.
INSERT INTO public.comprobantes(id, business_id, tipo, estado, estado_fiscal)
  VALUES
    ('00000000-0000-0000-0000-0000000c0001', :'bizA', 'factura_c', 'borrador', 'pendiente_emision'), -- c0001: elegible
    ('00000000-0000-0000-0000-0000000c0002', :'bizA', 'factura_c', 'emitido',  'emitido'),            -- c0002: ya autorizado
    ('00000000-0000-0000-0000-0000000c0003', :'bizA', 'factura_c', 'anulado',  'no_fiscal'),          -- c0003: anulado
    ('00000000-0000-0000-0000-0000000c0004', :'bizA', 'factura_c', 'borrador', 'pendiente_emision'),  -- c0004: abandono/happy-path
    ('00000000-0000-0000-0000-0000000c0005', :'bizA', 'factura_c', 'borrador', 'pendiente_emision'),  -- c0005: recuperación de abandonado
    ('00000000-0000-0000-0000-0000000c0006', :'bizA', 'factura_c', 'borrador', 'pendiente_emision'),  -- c0006: bloqueado por 'sent' de OTRO comp (misma serie)
    ('00000000-0000-0000-0000-0000000c0007', :'bizA', 'factura_c', 'borrador', 'pendiente_conciliacion'), -- c0007: propio pending_reconciliation (retry)
    ('00000000-0000-0000-0000-0000000c0008', :'bizA', 'factura_c', 'borrador', 'pendiente_emision'),  -- c0008: bloqueado por pending_reconciliation de OTRO comp
    ('00000000-0000-0000-0000-0000000c0009', :'bizA', 'factura_c', 'borrador', 'pendiente_emision'),  -- c0009: libera serie tras 'authorized'
    ('00000000-0000-0000-0000-0000000c0010', :'bizA', 'factura_c', 'borrador', 'pendiente_emision'),  -- c0010: prueba que c0009 liberó la serie
    ('00000000-0000-0000-0000-0000000c0011', :'bizA', 'factura_c', 'borrador', 'pendiente_emision'),  -- c0011: libera serie tras 'rejected'
    ('00000000-0000-0000-0000-0000000c0012', :'bizA', 'factura_c', 'borrador', 'pendiente_emision');  -- c0012: prueba que c0011 liberó la serie

-- Comprobante de bizB — serie DISTINTA (otro business → otro arca_config).
INSERT INTO public.comprobantes(id, business_id, tipo, estado, estado_fiscal)
  VALUES ('00000000-0000-0000-0000-0000000c0101', :'bizB', 'factura_c', 'borrador', 'pendiente_emision');

-- Nota de Crédito de bizA con tipo_comprobante_fiscal YA resuelto por
-- create_credit_note_from_comprobante (simulado acá) = '8' (NC ligada a
-- factura_b). Serie propia: mismo ambiente/cuit/punto_venta que las facturas
-- de bizA, pero tipo_comprobante=8 ≠ 11 → NO debe chocar con la serie de
-- facturas de bizA.
INSERT INTO public.comprobantes(id, business_id, tipo, estado, estado_fiscal, tipo_comprobante_fiscal)
  VALUES ('00000000-0000-0000-0000-0000000c0201', :'bizA', 'nota_credito', 'borrador', 'pendiente_emision', '8');

SET LOCAL session_replication_role = 'origin';

-- ════════════════════════════════════════════════════════════
-- S1: privilege grants (catálogo) — incluye reserve_arca_number, nuevo en
--     esta migración, y la firma de 2 parámetros de claim/mark_sent.
-- ════════════════════════════════════════════════════════════
SELECT pg_temp.assert(NOT has_function_privilege('anon',
  'public.claim_comprobante_arca_emission(uuid,text)', 'EXECUTE'),
  'S1a anon NO puede reclamar');
SELECT pg_temp.assert(has_function_privilege('authenticated',
  'public.claim_comprobante_arca_emission(uuid,text)', 'EXECUTE'),
  'S1b authenticated SÍ puede reclamar (con ownership check interno)');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated',
  'public.reserve_arca_number(uuid,integer)', 'EXECUTE'),
  'S1c authenticated NO puede reservar número (solo afip-cae)');
SELECT pg_temp.assert(has_function_privilege('service_role',
  'public.reserve_arca_number(uuid,integer)', 'EXECUTE'),
  'S1d service_role SÍ puede reservar número');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated',
  'public.mark_arca_attempt_sent(uuid)', 'EXECUTE'),
  'S1e authenticated NO puede marcar "sent" (solo afip-cae)');
SELECT pg_temp.assert(has_function_privilege('service_role',
  'public.mark_arca_attempt_sent(uuid)', 'EXECUTE'),
  'S1f service_role SÍ puede marcar "sent"');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated',
  'public.complete_arca_attempt(uuid,text,text,timestamptz,text,text,text)', 'EXECUTE'),
  'S1g authenticated NO puede completar el intento (solo afip-cae)');
SELECT pg_temp.assert(has_function_privilege('service_role',
  'public.complete_arca_attempt(uuid,text,text,timestamptz,text,text,text)', 'EXECUTE'),
  'S1h service_role SÍ puede completar el intento');

-- ════════════════════════════════════════════════════════════
-- S2: claim atómico exitoso (dueño real del negocio) — identidad de serie
--     resuelta 100% server-side desde arca_config (nunca por parámetro).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0001'::uuid, 'corr-s2');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'acquired', 'S2 claim inicial → acquired');
END $$;

SELECT pg_temp.assert(
  (SELECT ambiente FROM public.arca_emission_attempts WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0001') = 'homologacion'
  AND (SELECT cuit_emisor FROM public.arca_emission_attempts WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0001') = '20111111112'
  AND (SELECT punto_venta FROM public.arca_emission_attempts WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0001') = 1
  AND (SELECT tipo_comprobante FROM public.arca_emission_attempts WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0001') = 11,
  'S2b identidad de serie resuelta desde arca_config: cuit normalizado (sin guiones), punto_venta y ambiente correctos, tipo_comprobante mapeado de factura_c=11');

-- ════════════════════════════════════════════════════════════
-- S3: segundo claim del MISMO comprobante_id (en la misma sesión, secuencial)
--     → already_in_progress. Prueba la RAMA LÓGICA del handler de
--     unique_violation; NO prueba concurrencia real (ver
--     run-arca-concurrency-test.mjs para eso).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0001'::uuid, 'corr-s3-segunda-pestania');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'already_in_progress', 'S3 segundo claim (secuencial) del mismo comprobante → already_in_progress');
END $$;

SELECT pg_temp.assert(
  (SELECT count(*) FROM public.arca_emission_attempts
   WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0001' AND status IN ('claimed','number_reserved','sent')) = 1,
  'S3b solo UNA fila viva por comprobante — el índice único por comprobante_id es el lock');

-- Liberamos la serie que dejó ocupada el claim de c0001 (S2/S3) — de otro
-- modo bloquearía a c0004/c0006/etc. en los escenarios siguientes, que no
-- tienen nada que ver con c0001. Se completa como 'rejected' (resultado
-- terminal, libera ambos índices) solo para no interferir con el resto.
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.arca_emission_attempts WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0001' AND status = 'claimed';
  SET LOCAL ROLE service_role;
  PERFORM public.complete_arca_attempt(v_id, 'rejected', NULL, NULL, 'R', NULL, 'cierre de S2/S3 setup — libera la serie para los escenarios siguientes');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- S4: claim sobre comprobante YA autorizado → already_authorized (nunca reclama)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0002'::uuid, 'corr-s4');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'already_authorized', 'S4 comprobante con CAE → already_authorized, nunca acquired');
END $$;
SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM public.arca_emission_attempts WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0002'),
  'S4b nunca se crea un intento para un comprobante ya autorizado');

-- ════════════════════════════════════════════════════════════
-- S5: claim sobre comprobante anulado → not_eligible
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0003'::uuid, 'corr-s5');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'not_eligible', 'S5 comprobante anulado → not_eligible');
END $$;

-- ════════════════════════════════════════════════════════════
-- S6: prohibición de claim por otro negocio / usuario sin acceso
--     (ownership real vía auth.uid(), nunca por business_id de parámetro —
--     de hecho esta función ya NI RECIBE business_id como parámetro).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000b9'; -- dueño de bizB
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0004'::uuid, 'corr-s6-otro-negocio');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'not_found', 'S6 dueño de OTRO negocio no puede reclamar (ni ver que existe)');
END $$;

DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000fff'; -- sin profile en ningún negocio
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0004'::uuid, 'corr-s6b-sin-acceso');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'not_found', 'S6b usuario sin acceso a ningún negocio → not_found (fail-closed)');
END $$;

-- ════════════════════════════════════════════════════════════
-- S7: reserve_arca_number → mark_arca_attempt_sent → complete_arca_attempt
--     (flujo feliz, service_role). Prueba que el NÚMERO se persiste en un
--     paso separado (number_reserved) ANTES de "sent" y ANTES de completar.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_attempt_id uuid;
  r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0004'::uuid, 'corr-s7');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'acquired', 'S7a claim para comprobante c0004 → acquired');
  v_attempt_id := (r->>'attempt_id')::uuid;

  SET LOCAL ROLE service_role;
  r := public.reserve_arca_number(v_attempt_id, 42);
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'success' = 'true', 'S7b reserve_arca_number success');
  PERFORM pg_temp.assert(
    (SELECT status FROM public.arca_emission_attempts WHERE id = v_attempt_id) = 'number_reserved',
    'S7c status pasa a number_reserved');
  PERFORM pg_temp.assert(
    (SELECT numero_intentado FROM public.arca_emission_attempts WHERE id = v_attempt_id) = 42,
    'S7d numero_intentado persistido ANTES de mark_arca_attempt_sent (sobrevive a un crash entre reservar y enviar)');

  -- La serie sigue ocupada mientras está en number_reserved (mismo comp, otro intento no puede colarse).
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  PERFORM pg_temp.assert(
    (public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0004'::uuid, 'corr-s7-retry-number-reserved')->>'result') = 'already_in_progress',
    'S7e con status=number_reserved, un nuevo claim del mismo comprobante → already_in_progress');
  RESET ROLE;

  SET LOCAL ROLE service_role;
  PERFORM public.mark_arca_attempt_sent(v_attempt_id);
  RESET ROLE;
  PERFORM pg_temp.assert(
    (SELECT status FROM public.arca_emission_attempts WHERE id = v_attempt_id) = 'sent',
    'S7f mark_arca_attempt_sent → status sent');

  SET LOCAL ROLE service_role;
  r := public.complete_arca_attempt(v_attempt_id, 'authorized', '70999888777000', '2026-12-31'::timestamptz, 'A', NULL, NULL);
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'success' = 'true', 'S7g complete_arca_attempt success');

  PERFORM pg_temp.assert(
    (SELECT cae FROM public.comprobantes WHERE id = '00000000-0000-0000-0000-0000000c0004') = '70999888777000',
    'S7h CAE escrito en comprobantes por complete_arca_attempt');
  PERFORM pg_temp.assert(
    (SELECT numero_fiscal FROM public.comprobantes WHERE id = '00000000-0000-0000-0000-0000000c0004') = '0001-00000042',
    'S7i numero_fiscal formateado correctamente (punto_venta-numero)');
  PERFORM pg_temp.assert(
    (SELECT estado_fiscal FROM public.comprobantes WHERE id = '00000000-0000-0000-0000-0000000c0004') = 'emitido',
    'S7j estado_fiscal=emitido tras autorización');
END $$;

-- ════════════════════════════════════════════════════════════
-- S8: idempotencia — completar el mismo intento DOS veces no duplica ni pisa
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_attempt_id uuid;
  r jsonb;
BEGIN
  SELECT id INTO v_attempt_id FROM public.arca_emission_attempts
    WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0004' ORDER BY started_at DESC LIMIT 1;

  SET LOCAL ROLE service_role;
  r := public.complete_arca_attempt(v_attempt_id, 'authorized', 'CAE-FALSO-NO-DEBERIA-QUEDAR', now(), 'A', NULL, NULL);
  RESET ROLE;

  PERFORM pg_temp.assert(
    (SELECT cae FROM public.comprobantes WHERE id = '00000000-0000-0000-0000-0000000c0004') = '70999888777000',
    'S8 idempotencia: un segundo complete_arca_attempt NO pisa el CAE ya escrito');
END $$;

-- ════════════════════════════════════════════════════════════
-- S9: recuperación de intento abandonado (claimed, nunca reservó número, > 2 minutos)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r1 jsonb;
BEGIN
  SET LOCAL ROLE service_role;
  INSERT INTO public.arca_emission_attempts (
    comprobante_id, business_id, correlation_id, ambiente, cuit_emisor, punto_venta, tipo_comprobante, status, started_at
  ) VALUES (
    '00000000-0000-0000-0000-0000000c0005', '00000000-0000-0000-0000-0000000000a1',
    'corr-s9-viejo', 'homologacion', '20111111112', 1, 11, 'claimed', now() - INTERVAL '10 minutes'
  );
  RESET ROLE;

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r1 := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0005'::uuid, 'corr-s9-nuevo');
  RESET ROLE;

  PERFORM pg_temp.assert(r1->>'result' = 'acquired', 'S9a claim recupera un intento abandonado (>2min, nunca llegó a number_reserved)');
  PERFORM pg_temp.assert((r1->>'recovered_abandoned_attempt')::boolean IS TRUE, 'S9b se marca explícitamente como recuperado');
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM public.arca_emission_attempts
     WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0005' AND status = 'abandoned') = 1,
    'S9c el intento viejo queda marcado abandoned, no se borra (trazabilidad)');

  -- Liberamos la serie que dejó ocupada la recuperación de c0005 — igual que
  -- tras S2/S3, de otro modo bloquearía a S10/S11/etc.
  SET LOCAL ROLE service_role;
  PERFORM public.complete_arca_attempt((r1->>'attempt_id')::uuid, 'rejected', NULL, NULL, 'R', NULL, 'cierre de S9 setup — libera la serie');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- S10: un intento 'sent' de OTRO comprobante de la MISMA SERIE bloquea la
--      serie completa → serie_ocupada (esta es la corrección central de esta
--      migración: antes, esto NO se detectaba porque el índice viejo solo
--      miraba comprobante_id).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  -- c0004 ya tiene un intento 'authorized' (terminal, no bloquea). Insertamos
  -- un intento 'sent' para OTRO comprobante de bizA (mismo ambiente/cuit/pv/tipo).
  SET LOCAL ROLE service_role;
  INSERT INTO public.arca_emission_attempts (
    comprobante_id, business_id, correlation_id, ambiente, cuit_emisor, punto_venta, tipo_comprobante, status, started_at, sent_at, numero_intentado
  ) VALUES (
    '00000000-0000-0000-0000-0000000c0009', '00000000-0000-0000-0000-0000000000a1',
    'corr-s10-otro-comp-sent', 'homologacion', '20111111112', 1, 11, 'sent', now(), now(), 99
  );
  RESET ROLE;

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0006'::uuid, 'corr-s10-comp-distinto');
  RESET ROLE;

  PERFORM pg_temp.assert(r->>'result' = 'serie_ocupada', 'S10a comprobante DISTINTO de la misma serie fiscal → serie_ocupada (NO acquired)');
  PERFORM pg_temp.assert(r->>'blocking_comprobante_id' = '00000000-0000-0000-0000-0000000c0009', 'S10b informa cuál comprobante está bloqueando la serie');
  PERFORM pg_temp.assert(
    NOT EXISTS (SELECT 1 FROM public.arca_emission_attempts WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0006'),
    'S10c nunca se crea una fila de intento para el comprobante que perdió la carrera de serie');
END $$;

-- ════════════════════════════════════════════════════════════
-- S11: un intento 'pending_reconciliation' de OTRO comprobante bloquea la
--      serie; pero el MISMO comprobante puede retomar su propio
--      pending_reconciliation (reutiliza la fila, no inserta una nueva).
-- ════════════════════════════════════════════════════════════
-- Limpiamos el 'sent' de S10 para no interferir (lo completamos como rejected).
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.arca_emission_attempts WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0009' AND status = 'sent';
  SET LOCAL ROLE service_role;
  PERFORM public.complete_arca_attempt(v_id, 'rejected', NULL, NULL, 'R', NULL, 'rechazo de prueba S11 setup');
  RESET ROLE;
END $$;

DO $$
DECLARE r jsonb;
BEGIN
  -- c0008: comprobante DISTINTO, misma serie. Debe bloquear contra el
  -- pending_reconciliation propio de c0007 (insertado en fixtures con
  -- estado_fiscal='pendiente_conciliacion', pero SIN fila en
  -- arca_emission_attempts todavía — lo generamos ahora explícitamente).
  SET LOCAL ROLE service_role;
  INSERT INTO public.arca_emission_attempts (
    comprobante_id, business_id, correlation_id, ambiente, cuit_emisor, punto_venta, tipo_comprobante, status, started_at, sent_at, numero_intentado
  ) VALUES (
    '00000000-0000-0000-0000-0000000c0007', '00000000-0000-0000-0000-0000000000a1',
    'corr-s11-pending-original', 'homologacion', '20111111112', 1, 11, 'pending_reconciliation', now() - INTERVAL '5 minutes', now() - INTERVAL '5 minutes', 100
  );
  RESET ROLE;

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0008'::uuid, 'corr-s11-otro-comp');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'serie_ocupada', 'S11a pending_reconciliation de OTRO comprobante bloquea la serie');

  -- Ahora el DUEÑO del pending_reconciliation (c0007) SÍ puede retomarlo.
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0007'::uuid, 'corr-s11-retry-propio');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'acquired', 'S11b el propio comprobante en pending_reconciliation SÍ puede reclamarse de nuevo (retry)');
  PERFORM pg_temp.assert((r->>'reconciliation_pending')::boolean IS TRUE, 'S11c se informa que viene de una reconciliación pendiente');
  PERFORM pg_temp.assert(
    (SELECT numero_intentado FROM public.arca_emission_attempts WHERE id = (r->>'attempt_id')::uuid) = 100,
    'S11d se conserva el numero_intentado original al reutilizar la fila (no se pierde el número ambiguo)');
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM public.arca_emission_attempts WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0007') = 1,
    'S11e se REUTILIZÓ la misma fila (UPDATE), no se insertó una nueva — la serie se libera y reocupa atómicamente en la misma transacción');

  -- Liberamos la serie para no interferir con S12/S13.
  SET LOCAL ROLE service_role;
  PERFORM public.complete_arca_attempt((r->>'attempt_id')::uuid, 'authorized_reconciled', 'CAE-S11-RECONCILIADO', now(), 'A', NULL, NULL);
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- S12: un resultado 'authorized' libera la serie — otro comprobante de la
--      misma serie puede reclamar inmediatamente después.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE v_attempt uuid; r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0009'::uuid, 'corr-s12-claim');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'acquired', 'S12a claim de c0009 (serie ya liberada desde S11) → acquired');
  v_attempt := (r->>'attempt_id')::uuid;

  SET LOCAL ROLE service_role;
  PERFORM public.reserve_arca_number(v_attempt, 200);
  PERFORM public.mark_arca_attempt_sent(v_attempt);
  r := public.complete_arca_attempt(v_attempt, 'authorized', 'CAE-S12', now(), 'A', NULL, NULL);
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'success' = 'true', 'S12b complete_arca_attempt(authorized) success');

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0010'::uuid, 'corr-s12-libera');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'acquired', 'S12c tras authorized, la serie queda libre → otro comprobante SÍ puede reclamarla');

  -- Dejamos c0010 en estado terminal para no interferir con S13.
  SET LOCAL ROLE service_role;
  PERFORM public.complete_arca_attempt((r->>'attempt_id')::uuid, 'rejected', NULL, NULL, 'R', NULL, 'cierre de S12');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- S13: un rechazo fiscal DEFINITIVO también libera la serie (no solo el éxito).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE v_attempt uuid; r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0011'::uuid, 'corr-s13-claim');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'acquired', 'S13a claim de c0011 → acquired');
  v_attempt := (r->>'attempt_id')::uuid;

  SET LOCAL ROLE service_role;
  PERFORM public.reserve_arca_number(v_attempt, 300);
  PERFORM public.mark_arca_attempt_sent(v_attempt);
  r := public.complete_arca_attempt(v_attempt, 'rejected', NULL, NULL, 'R', NULL, 'rechazo fiscal de prueba');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'success' = 'true', 'S13b complete_arca_attempt(rejected) success');
  PERFORM pg_temp.assert(
    (SELECT estado_fiscal FROM public.comprobantes WHERE id = '00000000-0000-0000-0000-0000000c0011') = 'error_emision',
    'S13c estado_fiscal=error_emision tras rechazo definitivo');

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0012'::uuid, 'corr-s13-libera');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'acquired', 'S13d tras un rechazo definitivo, la serie también queda libre → otro comprobante SÍ puede reclamarla');
END $$;

-- ════════════════════════════════════════════════════════════
-- S14: dos series DISTINTAS pueden avanzar sin interferir (otro business,
--      otro arca_config → otro cuit/punto_venta).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  -- La serie de bizA (cuit 20111111112, pv 1) sigue con actividad viva (S13
  -- dejó c0012 'claimed'). Un comprobante de bizB (otra serie) debe poder
  -- reclamar sin que le importe lo que pasa en bizA.
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000b9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0101'::uuid, 'corr-s14-otra-serie');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'acquired', 'S14 comprobante de OTRA serie fiscal (otro business/CUIT/punto de venta) avanza en paralelo sin bloqueo');
  PERFORM pg_temp.assert(
    (SELECT cuit_emisor FROM public.arca_emission_attempts WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0101') = '20222222223',
    'S14b la serie de bizB usa SU PROPIO cuit_emisor, no el de bizA');
END $$;

-- ════════════════════════════════════════════════════════════
-- S15: Nota de Crédito respeta su PROPIO tipo_comprobante fiscal
--      (tipo_comprobante_fiscal ya resuelto, no el mapeo fijo de facturas) y
--      su propia serie no choca con la de facturas del mismo business/CUIT.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a9';
  r := public.claim_comprobante_arca_emission('00000000-0000-0000-0000-0000000c0201'::uuid, 'corr-s15-nc');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'result' = 'acquired', 'S15a NC con tipo_comprobante_fiscal ya resuelto → acquired (misma mecánica que facturas)');
  PERFORM pg_temp.assert(
    (SELECT tipo_comprobante FROM public.arca_emission_attempts WHERE comprobante_id = '00000000-0000-0000-0000-0000000c0201') = 8,
    'S15b usa el tipo_comprobante_fiscal YA resuelto (8), no el mapeo fijo de facturas nuevas');
  -- No chocó con la serie de facturas de bizA (mismo cuit/pv, pero
  -- tipo_comprobante=8 ≠ 11 → índice de serie no las considera la misma serie).
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM public.arca_emission_attempts
     WHERE ambiente='homologacion' AND cuit_emisor='20111111112' AND punto_venta=1 AND tipo_comprobante=11
       AND status IN ('claimed','number_reserved','sent','pending_reconciliation')) = 1, -- c0012 sigue 'claimed' de S13
    'S15c la serie de facturas (tipo 11) de bizA sigue con su propio estado, ajena a la NC (tipo 8)');
END $$;

SELECT 'ALL TESTS PASSED (rolled back)' AS result;
ROLLBACK;
