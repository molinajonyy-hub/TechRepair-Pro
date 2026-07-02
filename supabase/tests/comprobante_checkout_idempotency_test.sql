-- ============================================================
-- Test suite: create_comprobante_checkout_atomic / get_checkout_request_status
-- (supabase/migrations/20260701170000_comprobante_checkout_idempotency.sql)
--
-- HOW TO RUN (needs a local Supabase stack; NOT against prod):
--   supabase start (o db reset)
--   docker exec -i <postgres_container> psql -U postgres -d postgres \
--     -f supabase/tests/comprobante_checkout_idempotency_test.sql
--
-- ALCANCE: escenarios deterministas verificables en UNA sola transacción/
-- sesión (T2 payload distinto, T3 keys distintas, T4 rollback tras error, T5
-- respuesta perdida tras commit, T6 dos usuarios del mismo negocio, T7 otro
-- negocio, y Fase 8: 10 reintentos con la misma key → efectos exactamente
-- una vez). T1 (dos conexiones REALES, bloqueo medido) vive en
-- supabase/tests/run-checkout-idempotency-concurrency-test.ps1 — una sola
-- sesión no puede demostrar exclusión mutua real entre conexiones.
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

-- ── fictitious identifiers ──────────────────────────────────
\set bizA '00000000-0000-0000-0000-0000000e0a01'
\set bizB '00000000-0000-0000-0000-0000000e0b02'
\set ownerA '00000000-0000-0000-0000-0000000e0a09'
\set staffA '00000000-0000-0000-0000-0000000e0a19'
\set ownerB '00000000-0000-0000-0000-0000000e0b09'
\set outsider '00000000-0000-0000-0000-0000000effff'
\set custA '00000000-0000-0000-0000-0000000e0c01'

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'ownerA'), (:'staffA'), (:'ownerB'), (:'outsider');
INSERT INTO businesses(id, name) VALUES (:'bizA', 'Test Biz Checkout A'), (:'bizB', 'Test Biz Checkout B');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES
  (:'bizA', :'ownerA', 'owner', true),
  (:'bizA', :'staffA', 'cashier', true),
  (:'bizB', :'ownerB', 'owner', true);
INSERT INTO customers(id, business_id, name, phone) VALUES (:'custA', :'bizA', 'Cliente Test', '+5491100000000');
SET LOCAL session_replication_role = 'origin';

-- Payload reutilizable (factura_c, 1 item, pago efectivo, sin CC)
-- ════════════════════════════════════════════════════════════
-- T2: misma key, payload DISTINTO → idempotency_conflict, nunca sigue
--     silenciosamente con datos distintos.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e0a09';
  r1 := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-0000000e0a01'::uuid, 'key-t2', 'hash-original',
    '{"tipo":"factura_c","punto_venta":"0001","condicion_fiscal":"Consumidor Final","customer_id":null,"es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":false,"subtotal_ars":1000,"tax":0,"total":1000,"total_usd":1000,"descuento_total":0,"costo_total_ars":600,"total_comisiones":0,"total_neto":1000,"total_bruto":1000,"cc_total":0,"items":[{"descripcion":"Prod A","tipo_linea":"producto","cantidad":1,"precio_unitario":1000,"subtotal":1000,"costo_unitario":600,"costo_total":600,"currency":"ARS","exchange_rate":1}],"pagos":[{"payment_method":"efectivo","amount":1000,"currency":"ARS","amount_ars":1000,"exchange_rate":1}]}'::jsonb
  );
  PERFORM pg_temp.assert(r1->>'status' = 'created', 'T2a primera llamada con key-t2 -> created');

  r2 := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-0000000e0a01'::uuid, 'key-t2', 'hash-DISTINTO',
    '{"tipo":"factura_c","punto_venta":"0001","condicion_fiscal":"Consumidor Final","customer_id":null,"es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":false,"subtotal_ars":5000,"tax":0,"total":5000,"total_usd":5000,"descuento_total":0,"costo_total_ars":0,"total_comisiones":0,"total_neto":5000,"total_bruto":5000,"cc_total":0,"items":[],"pagos":[]}'::jsonb
  );
  PERFORM pg_temp.assert(r2->>'status' = 'idempotency_conflict', 'T2b misma key + hash distinto -> idempotency_conflict');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(
  (SELECT count(*) FROM comprobantes WHERE business_id = '00000000-0000-0000-0000-0000000e0a01') = 1,
  'T2c solo se creó UN comprobante (el conflicto no creó nada adicional)');

-- ════════════════════════════════════════════════════════════
-- T3: keys DISTINTAS → dos ventas legítimas, no se bloquean entre sí.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e0a09';
  r1 := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-0000000e0a01'::uuid, 'key-t3-uno', 'hash-t3-uno',
    '{"tipo":"factura_c","punto_venta":"0001","condicion_fiscal":"Consumidor Final","customer_id":null,"es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":false,"cc_total":0,"items":[{"descripcion":"Servicio T3 uno","tipo_linea":"servicio","cantidad":1,"precio_unitario":200,"currency":"ARS","exchange_rate":1}],"pagos":[{"payment_method":"efectivo","amount":200,"currency":"ARS","amount_ars":200,"exchange_rate":1}]}'::jsonb
  );
  r2 := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-0000000e0a01'::uuid, 'key-t3-dos', 'hash-t3-dos',
    '{"tipo":"factura_c","punto_venta":"0001","condicion_fiscal":"Consumidor Final","customer_id":null,"es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":false,"cc_total":0,"items":[{"descripcion":"Servicio T3 dos","tipo_linea":"servicio","cantidad":1,"precio_unitario":300,"currency":"ARS","exchange_rate":1}],"pagos":[{"payment_method":"efectivo","amount":300,"currency":"ARS","amount_ars":300,"exchange_rate":1}]}'::jsonb
  );
  PERFORM pg_temp.assert(r1->>'status' = 'created', 'T3a primera venta (key-t3-uno) -> created');
  PERFORM pg_temp.assert(r2->>'status' = 'created', 'T3b segunda venta (key-t3-dos) -> created');
  PERFORM pg_temp.assert((r1->>'comprobante_id') <> (r2->>'comprobante_id'), 'T3c dos comprobantes DISTINTOS — keys distintas nunca colisionan');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- T4: la creación falla a mitad de camino (total inconsistente) → rollback
--     total, la request queda failed_retryable, un retry con la MISMA key
--     puede continuar de forma segura después.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e0a09';
  -- tipo inválido -> RAISE EXCEPTION dentro de la RPC (falla DESPUÉS de
  -- registrar la request 'processing', para probar el rollback total).
  r1 := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-0000000e0a01'::uuid, 'key-t4', 'hash-t4-malo',
    '{"tipo":"tipo_invalido_xyz","punto_venta":"0001","condicion_fiscal":"Consumidor Final","customer_id":null,"es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":false,"cc_total":0,"items":[],"pagos":[]}'::jsonb
  );
  PERFORM pg_temp.assert(r1->>'status' = 'failed_retryable', 'T4a payload con tipo de comprobante inválido -> falla, failed_retryable (no failed_final)');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM comprobantes c JOIN comprobante_checkout_requests r ON r.comprobante_id = c.id WHERE r.idempotency_key = 'key-t4'),
  'T4b ningún comprobante quedó asociado a la request fallida (rollback total del bloque de trabajo)');
SELECT pg_temp.assert(
  (SELECT status FROM comprobante_checkout_requests WHERE business_id = '00000000-0000-0000-0000-0000000e0a01' AND idempotency_key = 'key-t4') = 'failed_retryable',
  'T4c la request quedó registrada como failed_retryable, no como fantasma inexistente');

DO $$
DECLARE r2 jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e0a09';
  -- Mismo hash (mismo payload malo) -> debe reintentar y volver a fallar limpio (no queda a medias).
  r2 := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-0000000e0a01'::uuid, 'key-t4', 'hash-t4-malo',
    '{"tipo":"tipo_invalido_xyz","punto_venta":"0001","condicion_fiscal":"Consumidor Final","customer_id":null,"es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":false,"cc_total":0,"items":[],"pagos":[]}'::jsonb
  );
  PERFORM pg_temp.assert(r2->>'status' = 'failed_retryable', 'T4d retry con la MISMA key (mismo hash) recupera la fila y reintenta de forma segura');
  RESET ROLE;
END $$;
SELECT pg_temp.assert(
  (SELECT count(*) FROM comprobante_checkout_requests WHERE business_id = '00000000-0000-0000-0000-0000000e0a01' AND idempotency_key = 'key-t4') = 1,
  'T4e sigue siendo UNA sola fila de request para key-t4 (se reutilizó, no se duplicó)');

-- ════════════════════════════════════════════════════════════
-- T5: "respuesta perdida" tras el commit — retry con la MISMA key devuelve
--     existing + mismo comprobante_id, CERO efectos duplicados.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb; r3 jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e0a09';
  r1 := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-0000000e0a01'::uuid, 'key-t5', 'hash-t5',
    '{"tipo":"factura_c","punto_venta":"0001","condicion_fiscal":"Consumidor Final","customer_id":"00000000-0000-0000-0000-0000000e0c01","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":false,"subtotal_ars":1000,"tax":0,"total":1000,"total_usd":1000,"descuento_total":0,"costo_total_ars":400,"total_comisiones":0,"total_neto":400,"total_bruto":1000,"cc_total":600,"items":[{"descripcion":"Prod CC","tipo_linea":"producto","cantidad":1,"precio_unitario":1000,"subtotal":1000,"costo_unitario":400,"costo_total":400,"currency":"ARS","exchange_rate":1}],"pagos":[{"payment_method":"efectivo","amount":400,"currency":"ARS","amount_ars":400,"exchange_rate":1}]}'::jsonb
  );
  PERFORM pg_temp.assert(r1->>'status' = 'created', 'T5a primera llamada (con pago parcial + saldo en CC) -> created');

  -- Simula la respuesta HTTP perdida: el cliente reintenta con la MISMA key
  -- (y el mismo hash, porque relee el mismo carrito) DIEZ veces (fase 8).
  FOR i IN 1..9 LOOP
    r2 := create_comprobante_checkout_atomic(
      '00000000-0000-0000-0000-0000000e0a01'::uuid, 'key-t5', 'hash-t5',
      '{"tipo":"factura_c","punto_venta":"0001","condicion_fiscal":"Consumidor Final","customer_id":"00000000-0000-0000-0000-0000000e0c01","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":false,"subtotal_ars":1000,"tax":0,"total":1000,"total_usd":1000,"descuento_total":0,"costo_total_ars":400,"total_comisiones":0,"total_neto":400,"total_bruto":1000,"cc_total":600,"items":[{"descripcion":"Prod CC","tipo_linea":"producto","cantidad":1,"precio_unitario":1000,"subtotal":1000,"costo_unitario":400,"costo_total":400,"currency":"ARS","exchange_rate":1}],"pagos":[{"payment_method":"efectivo","amount":400,"currency":"ARS","amount_ars":400,"exchange_rate":1}]}'::jsonb
    );
    PERFORM pg_temp.assert(r2->>'status' = 'existing', format('T5b retry #%s -> existing', i));
    PERFORM pg_temp.assert((r2->>'comprobante_id') = (r1->>'comprobante_id'), format('T5c retry #%s devuelve el MISMO comprobante_id', i));
  END LOOP;
  RESET ROLE;
END $$;

-- ── Fase 8: efectos EXACTAMENTE una vez tras 10 llamadas totales con la misma key ──
SELECT pg_temp.assert(
  (SELECT count(*) FROM comprobantes c JOIN comprobante_checkout_requests r ON r.comprobante_id = c.id WHERE r.idempotency_key = 'key-t5') = 1,
  'FASE8a comprobantes: 1 (no 10)');
SELECT pg_temp.assert(
  (SELECT count(*) FROM comprobante_items ci JOIN comprobante_checkout_requests r ON r.comprobante_id = ci.comprobante_id WHERE r.idempotency_key = 'key-t5') = 1,
  'FASE8b comprobante_items: 1 (cantidad original exacta)');
SELECT pg_temp.assert(
  (SELECT count(*) FROM comprobante_payments cp JOIN comprobante_checkout_requests r ON r.comprobante_id = cp.comprobante_id WHERE r.idempotency_key = 'key-t5') = 1,
  'FASE8c comprobante_payments: 1 (pagos no duplicados)');
-- NOTA: cuando hay pago de CAJA, el ingreso en business_finance_entries/
-- financial_movements lo crea un trigger YA EXISTENTE al insertar
-- comprobante_payments (mismo comportamiento que el JS original — de ahí el
-- comentario "con pagos de caja lo maneja el trigger"). La RPC solo inserta
-- su PROPIO business_finance_entries de "income" cuando NO hay pago de caja
-- ni CC (ver condición `cash_total=0 AND cc_total=0`) — acá SÍ hay pago de
-- caja (400), así que ese insert propio correctamente NO se dispara. Lo que
-- se verifica es que el trigger, igual que la propia RPC, produce el efecto
-- UNA SOLA VEZ pese a los 10 reintentos (nunca 10 filas).
SELECT pg_temp.assert(
  (SELECT count(*) FROM business_finance_entries bfe JOIN comprobante_checkout_requests r ON r.business_id = bfe.business_id WHERE r.idempotency_key = 'key-t5' AND bfe.description LIKE '%' || (SELECT numero FROM comprobantes WHERE id = r.comprobante_id) || '%') = 2,
  'FASE8d business_finance_entries: 2 (costo propio de la RPC + ingreso del trigger de pagos) — una sola vez cada uno, no 10');
SELECT pg_temp.assert(
  (SELECT count(*) FROM financial_movements fm JOIN comprobante_checkout_requests r ON r.comprobante_id = fm.comprobante_id WHERE r.idempotency_key = 'key-t5') = 1,
  'FASE8e financial_movements: 1 (creado por el trigger de comprobante_payments al insertar el ÚNICO pago) — nunca 10, pese a los 10 reintentos');
SELECT pg_temp.assert(
  (SELECT count(*) FROM account_movements am JOIN comprobante_checkout_requests r ON r.comprobante_id = am.reference_id WHERE r.idempotency_key = 'key-t5') = 1,
  'FASE8f account_movements (cuenta corriente): 1 (una sola vez, no 10)');
SELECT pg_temp.assert(
  (SELECT balance FROM accounts WHERE business_id = '00000000-0000-0000-0000-0000000e0a01' AND entity_id = '00000000-0000-0000-0000-0000000e0c01') = 600,
  'FASE8g balance de cuenta corriente = 600 exactos (no se acumuló 10 veces)');

-- ════════════════════════════════════════════════════════════
-- T6: dos usuarios DEL MISMO negocio, misma key, mismo payload -> una sola venta.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e0a09'; -- ownerA
  r1 := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-0000000e0a01'::uuid, 'key-t6', 'hash-t6',
    '{"tipo":"factura_c","punto_venta":"0001","condicion_fiscal":"Consumidor Final","customer_id":null,"es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":false,"cc_total":0,"items":[{"descripcion":"Servicio T6","tipo_linea":"servicio","cantidad":1,"precio_unitario":50,"currency":"ARS","exchange_rate":1}],"pagos":[{"payment_method":"efectivo","amount":50,"currency":"ARS","amount_ars":50,"exchange_rate":1}]}'::jsonb
  );
  RESET ROLE;

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e0a19'; -- staffA (otro usuario, mismo negocio)
  r2 := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-0000000e0a01'::uuid, 'key-t6', 'hash-t6',
    '{"tipo":"factura_c","punto_venta":"0001","condicion_fiscal":"Consumidor Final","customer_id":null,"es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":false,"cc_total":0,"items":[{"descripcion":"Servicio T6","tipo_linea":"servicio","cantidad":1,"precio_unitario":50,"currency":"ARS","exchange_rate":1}],"pagos":[{"payment_method":"efectivo","amount":50,"currency":"ARS","amount_ars":50,"exchange_rate":1}]}'::jsonb
  );
  RESET ROLE;

  PERFORM pg_temp.assert(r1->>'status' = 'created', 'T6a ownerA crea con key-t6 -> created');
  PERFORM pg_temp.assert(r2->>'status' = 'existing', 'T6b staffA (mismo negocio, misma key) -> existing, NO crea otra venta');
  PERFORM pg_temp.assert((r1->>'comprobante_id') = (r2->>'comprobante_id'), 'T6c ambos usuarios ven el MISMO comprobante_id');
END $$;

-- ════════════════════════════════════════════════════════════
-- T7: usuario de OTRO negocio no puede recuperar ni reutilizar la operación.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e0b09'; -- ownerB, otro negocio
  -- Intenta usar el bizA como p_business_id (no le pertenece).
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-0000000e0a01'::uuid, 'key-t7-cross', 'hash-t7',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"subtotal_ars":10,"tax":0,"total":10,"total_usd":10,"descuento_total":0,"costo_total_ars":0,"total_comisiones":0,"total_neto":10,"total_bruto":10,"cc_total":0,"items":[],"pagos":[]}'::jsonb
  );
  PERFORM pg_temp.assert(r->>'status' = 'failed_final', 'T7a usuario de otro negocio -> failed_final (ownership rechazado)');
  RESET ROLE;
END $$;
SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM comprobante_checkout_requests WHERE idempotency_key = 'key-t7-cross'),
  'T7b nunca se registra una request para un intento de acceso cross-negocio (fail-closed, no revela nada)');

-- get_checkout_request_status respeta el mismo ownership.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000e0b09'; -- ownerB
  r := get_checkout_request_status('00000000-0000-0000-0000-0000000e0a01'::uuid, 'key-t5'); -- request real de bizA
  PERFORM pg_temp.assert((r->>'found')::boolean IS FALSE, 'T7c get_checkout_request_status: otro negocio no puede consultar una request ajena');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- Grants (catálogo) — anon NUNCA debe tener EXECUTE en ninguna RPC nueva.
-- ════════════════════════════════════════════════════════════
SELECT pg_temp.assert(NOT has_function_privilege('anon',
  'public.create_comprobante_checkout_atomic(uuid,text,text,jsonb)', 'EXECUTE'),
  'GRANTS anon NO puede crear checkouts');
SELECT pg_temp.assert(has_function_privilege('authenticated',
  'public.create_comprobante_checkout_atomic(uuid,text,text,jsonb)', 'EXECUTE'),
  'GRANTS authenticated SÍ puede crear checkouts (con ownership interno)');
SELECT pg_temp.assert(NOT has_function_privilege('anon',
  'public.get_checkout_request_status(uuid,text)', 'EXECUTE'),
  'GRANTS anon NO puede consultar estado de checkout');
SELECT pg_temp.assert(has_function_privilege('authenticated',
  'public.get_checkout_request_status(uuid,text)', 'EXECUTE'),
  'GRANTS authenticated SÍ puede consultar estado de checkout');

SELECT 'ALL TESTS PASSED (rolled back)' AS result;
ROLLBACK;
