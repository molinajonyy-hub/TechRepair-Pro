-- ============================================================
-- Test suite: numeración local atómica (reserve_comprobante_number +
-- comprobante_number_sequences + constraint UNIQUE sobre numero_secuencial)
-- (supabase/migrations/20260701180000_checkout_number_pricing_permissions.sql)
--
-- HOW TO RUN (needs a local Supabase stack; NOT against prod):
--   supabase start (o db reset)
--   docker exec -i <postgres_container> psql -U postgres -d postgres \
--     -f supabase/tests/comprobante_numbering_test.sql
--
-- ALCANCE: escenarios deterministas de una sola sesión (N2, N3, N4, N6, N7,
-- N8). N1 (dos conexiones REALES, misma serie, bloqueo medido) y N5 (dos
-- series distintas en paralelo) viven en
-- supabase/tests/run-numbering-concurrency-test.ps1 — una sola sesión no
-- puede demostrar exclusión mutua real entre conexiones.
--
-- Runs inside a single transaction and ROLLBACKs at the end.
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label;
  ELSE RAISE NOTICE 'PASS: %', label; END IF;
END; $$;

\set bizA '00000000-0000-0000-0000-00000000ea01'
\set ownerA '00000000-0000-0000-0000-00000000ea09'
\set staffA '00000000-0000-0000-0000-00000000ea19'

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'ownerA'), (:'staffA');
INSERT INTO businesses(id, name) VALUES (:'bizA', 'Test Biz Numbering');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES
  (:'bizA', :'ownerA', 'owner', true),
  (:'bizA', :'staffA', 'owner', true);
SET LOCAL session_replication_role = 'origin';

-- ════════════════════════════════════════════════════════════
-- N2: misma idempotency key, 10 retries -> UN comprobante, UN número
--     consumido (el contador NO avanza en los reintentos).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb; v_seq_before integer; v_seq_after integer;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ea09';
  r1 := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ea01'::uuid, 'key-n2', 'hash-n2',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[],"pagos":[],"cc_total":0}'::jsonb
  );
  PERFORM pg_temp.assert(r1->>'status' = 'created', 'N2a primera llamada -> created');

  SELECT last_number INTO v_seq_before FROM comprobante_number_sequences WHERE business_id = '00000000-0000-0000-0000-00000000ea01' AND tipo = 'factura_c';

  FOR i IN 1..10 LOOP
    r2 := create_comprobante_checkout_atomic(
      '00000000-0000-0000-0000-00000000ea01'::uuid, 'key-n2', 'hash-n2',
      '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[],"pagos":[],"cc_total":0}'::jsonb
    );
    PERFORM pg_temp.assert(r2->>'status' = 'existing', format('N2b retry #%s -> existing', i));
    PERFORM pg_temp.assert((r2->>'comprobante_id') = (r1->>'comprobante_id'), format('N2c retry #%s mismo comprobante_id', i));
  END LOOP;

  SELECT last_number INTO v_seq_after FROM comprobante_number_sequences WHERE business_id = '00000000-0000-0000-0000-00000000ea01' AND tipo = 'factura_c';
  PERFORM pg_temp.assert(v_seq_after = v_seq_before, 'N2d el contador NO avanzó en los 10 reintentos (sigue en ' || v_seq_before || ')');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- N3: payload conflictivo (misma key, PAYLOAD distinto) NO consume número.
-- 6E.2a: el conflicto lo decide el server_request_hash del payload economico
-- (punto_venta distinto -> hash distinto -> conflicto), no el client hash.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_seq_before integer; v_seq_after integer;
BEGIN
  SELECT last_number INTO v_seq_before FROM comprobante_number_sequences WHERE business_id = '00000000-0000-0000-0000-00000000ea01' AND tipo = 'factura_c';

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ea09';
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ea01'::uuid, 'key-n2', 'hash-DISTINTO-n3',
    '{"tipo":"factura_c","punto_venta":"0002","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[],"pagos":[],"cc_total":0}'::jsonb
  );
  PERFORM pg_temp.assert(r->>'status' = 'idempotency_conflict', 'N3a key-n2 con payload distinto -> idempotency_conflict');

  SELECT last_number INTO v_seq_after FROM comprobante_number_sequences WHERE business_id = '00000000-0000-0000-0000-00000000ea01' AND tipo = 'factura_c';
  PERFORM pg_temp.assert(v_seq_after = v_seq_before, 'N3b el conflicto NO consumió número');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- N4: rollback DESPUÉS de reservar el número (FK inválida en el INSERT de
--     comprobantes) -> el número reservado también se revierte (policy:
--     rollback completo sin consumir número, ver comentario en la migración).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_seq_before integer; v_seq_after integer;
BEGIN
  SELECT COALESCE(last_number, 0) INTO v_seq_before FROM comprobante_number_sequences WHERE business_id = '00000000-0000-0000-0000-00000000ea01' AND tipo = 'factura_c';

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ea09';
  -- customer_id inexistente + cc_total=0 -> no dispara el lookup previo de
  -- clientes, así que la FK falla recién en el INSERT INTO comprobantes,
  -- DESPUÉS de reserve_comprobante_number.
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ea01'::uuid, 'key-n4', 'hash-n4',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"customer_id":"00000000-0000-0000-0000-000000000fff","items":[],"pagos":[],"cc_total":0}'::jsonb
  );
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable', 'N4a customer_id inexistente -> falla (FK) DESPUÉS de reservar número -> failed_retryable');

  SELECT COALESCE(last_number, 0) INTO v_seq_after FROM comprobante_number_sequences WHERE business_id = '00000000-0000-0000-0000-00000000ea01' AND tipo = 'factura_c';
  PERFORM pg_temp.assert(v_seq_after = v_seq_before, 'N4b el contador quedó EXACTAMENTE igual — la reserva del número se revirtió junto con todo lo demás (política: no se consume en rollback)');
  PERFORM pg_temp.assert(
    NOT EXISTS (SELECT 1 FROM comprobantes WHERE business_id = '00000000-0000-0000-0000-00000000ea01' AND numero_secuencial = v_seq_after + 1),
    'N4c no quedó ningún comprobante con el número que se hubiera reservado');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- N6: contador inicializado desde comprobantes históricos -> próximo número correcto.
--     (replica la MISMA query de inicialización de la migración contra fixtures
--     históricas ad-hoc, sin re-aplicar la migración completa)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE v_biz_hist uuid := '00000000-0000-0000-0000-00000000eb01';
DECLARE v_computed_max integer;
BEGIN
  SET LOCAL session_replication_role = 'replica';
  INSERT INTO businesses(id, name) VALUES (v_biz_hist, 'Test Biz Historico');
  -- Comprobantes "históricos" (numero_secuencial NULL, como si vinieran de antes de esta migración)
  INSERT INTO comprobantes(id, business_id, tipo, estado, estado_fiscal, numero, number)
    VALUES
      (gen_random_uuid(), v_biz_hist, 'factura_c', 'emitido', 'emitido', '0001-00000007', '0001-00000007'),
      (gen_random_uuid(), v_biz_hist, 'factura_c', 'emitido', 'emitido', '0001-00000003', '0001-00000003'),
      (gen_random_uuid(), v_biz_hist, 'factura_c', 'emitido', 'emitido', NULL, NULL); -- número nulo: se ignora explícitamente, no rompe el cálculo
  SET LOCAL session_replication_role = 'origin';

  SELECT MAX(
    CASE
      WHEN COALESCE(number, numero) ~ '^[0-9]+$' THEN CAST(COALESCE(number, numero) AS BIGINT)
      WHEN COALESCE(number, numero) ~ '^[0-9]{4}-[0-9]{8}$' THEN CAST(SPLIT_PART(COALESCE(number, numero), '-', 2) AS BIGINT)
      ELSE 0
    END
  ) INTO v_computed_max
  FROM comprobantes WHERE business_id = v_biz_hist AND COALESCE(type, tipo) = 'factura_c';

  PERFORM pg_temp.assert(v_computed_max = 7, 'N6a la query de inicialización calcula MAX=7 (ignora el NULL, no lo confunde con 0)');
END $$;

-- ════════════════════════════════════════════════════════════
-- N7: constraint UNIQUE — inserción manual duplicada de (business_id, tipo, numero_secuencial) falla.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE v_existing_seq integer;
BEGIN
  SELECT numero_secuencial INTO v_existing_seq FROM comprobantes
    WHERE business_id = '00000000-0000-0000-0000-00000000ea01' AND tipo = 'factura_c' AND numero_secuencial IS NOT NULL
    LIMIT 1;
  PERFORM pg_temp.assert(v_existing_seq IS NOT NULL, 'N7 setup: existe al menos un comprobante con numero_secuencial ya asignado');
END $$;

SELECT pg_temp.assert(
  (SELECT COUNT(*) FROM (
    SELECT 1 FROM comprobantes WHERE business_id = '00000000-0000-0000-0000-00000000ea01' AND tipo = 'factura_c' AND numero_secuencial IS NOT NULL
    LIMIT 1
  ) x) = 1, 'N7 pre-check ok');

DO $$
DECLARE v_dupe_seq integer;
BEGIN
  SELECT numero_secuencial INTO v_dupe_seq FROM comprobantes
    WHERE business_id = '00000000-0000-0000-0000-00000000ea01' AND tipo = 'factura_c' AND numero_secuencial IS NOT NULL LIMIT 1;

  BEGIN
    INSERT INTO comprobantes (business_id, tipo, type, estado, estado_fiscal, numero_secuencial)
      VALUES ('00000000-0000-0000-0000-00000000ea01', 'factura_c', 'factura_c', 'emitido', 'emitido', v_dupe_seq);
    PERFORM pg_temp.assert(false, 'N7 FALLO: el INSERT duplicado debería haber violado el constraint UNIQUE y no llegó acá');
  EXCEPTION WHEN unique_violation THEN
    PERFORM pg_temp.assert(true, 'N7 el INSERT manual duplicado de (business_id, tipo, numero_secuencial) violó el UNIQUE, como se esperaba');
  END;
END $$;

-- ════════════════════════════════════════════════════════════
-- N8: dos usuarios del mismo negocio -> números correctos (secuenciales, sin duplicar).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ea09'; -- ownerA
  r1 := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ea01'::uuid, 'key-n8-uno', 'hash-n8-uno',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[],"pagos":[],"cc_total":0}'::jsonb
  );
  RESET ROLE;

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ea19'; -- staffA
  r2 := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ea01'::uuid, 'key-n8-dos', 'hash-n8-dos',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[],"pagos":[],"cc_total":0}'::jsonb
  );
  RESET ROLE;

  PERFORM pg_temp.assert(r1->>'status' = 'created', 'N8a ownerA crea -> created');
  PERFORM pg_temp.assert(r2->>'status' = 'created', 'N8b staffA crea -> created');
  PERFORM pg_temp.assert(
    (SELECT numero_secuencial FROM comprobantes WHERE id = (r1->>'comprobante_id')::uuid)
    <> (SELECT numero_secuencial FROM comprobantes WHERE id = (r2->>'comprobante_id')::uuid),
    'N8c ambos usuarios reciben numero_secuencial DISTINTO — nunca colisionan');
END $$;

SELECT 'ALL TESTS PASSED (rolled back)' AS result;
ROLLBACK;
