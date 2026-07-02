-- ============================================================
-- Test suite: seguridad comercial de create_comprobante_checkout_atomic
-- (auditoría pricing/permisos, 2026-07-01, Fase 9).
--
-- HOW TO RUN (needs a local Supabase stack; NOT against prod):
--   supabase start (o db reset)
--   docker exec -i <postgres_container> psql -U postgres -d postgres \
--     -f supabase/tests/checkout_pricing_security_test.sql
--
-- Para CADA ataque: se espera rollback completo — ningún comprobante,
-- ningún ítem, ningún pago, ningún stock descontado, ninguna finanza,
-- ninguna request 'completed'.
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

/** Helper: confirma que NINGÚN efecto quedó para una key dada (rollback completo). */
CREATE OR REPLACE FUNCTION pg_temp.assert_no_effects(p_biz uuid, p_key text, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  SELECT
    NOT EXISTS (SELECT 1 FROM comprobantes c JOIN comprobante_checkout_requests r ON r.comprobante_id = c.id WHERE r.business_id = p_biz AND r.idempotency_key = p_key)
    AND NOT EXISTS (SELECT 1 FROM comprobante_checkout_requests WHERE business_id = p_biz AND idempotency_key = p_key AND status = 'completed')
  INTO v_ok;
  PERFORM pg_temp.assert(v_ok, p_label || ' — cero efectos (ningún comprobante, ninguna request completed)');
END; $$;

\set bizA '00000000-0000-0000-0000-00000000ed01'
\set bizOther '00000000-0000-0000-0000-00000000ed02'
\set cashierA '00000000-0000-0000-0000-00000000ed09'
\set ownerA '00000000-0000-0000-0000-00000000ed19'
\set salesA '00000000-0000-0000-0000-00000000ed29'

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'cashierA'), (:'ownerA'), (:'salesA');
INSERT INTO businesses(id, name) VALUES (:'bizA', 'Test Biz Security'), (:'bizOther', 'Test Biz Other');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES
  (:'bizA', :'cashierA', 'cashier', true),
  (:'bizA', :'ownerA', 'owner', true),
  (:'bizA', :'salesA', 'sales', true);
-- Producto: precio de lista 1000, costo 600, stock 5. Pertenece a bizA.
INSERT INTO inventory(id, business_id, code, name, category, stock_quantity, sale_price, cost_price)
  VALUES ('00000000-0000-0000-0000-00000000ee01', :'bizA', 'SKU-SEC-1', 'Producto Seguridad', 'general', 5, 1000, 600);
-- Producto de OTRO negocio (para el ataque cross-tenant).
INSERT INTO inventory(id, business_id, code, name, category, stock_quantity, sale_price, cost_price)
  VALUES ('00000000-0000-0000-0000-00000000ee02', :'bizOther', 'SKU-OTHER-1', 'Producto Otro Negocio', 'general', 5, 500, 300);
SET LOCAL session_replication_role = 'origin';

-- ════════════════════════════════════════════════════════════
-- ATK1: cashier (sin permiso) manda un precio manipulado (1 en vez de 1000).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ed09';
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ed01'::uuid, 'atk1', 'hash-atk1',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[{"descripcion":"Producto Seguridad","tipo_linea":"producto","cantidad":1,"precio_unitario":1,"descuento_linea":0,"currency":"ARS","exchange_rate":1,"inventory_id":"00000000-0000-0000-0000-00000000ee01"}],"pagos":[{"payment_method":"efectivo","amount":1,"currency":"ARS","amount_ars":1,"exchange_rate":1}],"cc_total":0}'::jsonb
  );
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable', 'ATK1a precio manipulado por cashier sin permiso -> falla');
END $$;
SELECT pg_temp.assert_no_effects('00000000-0000-0000-0000-00000000ed01', 'atk1', 'ATK1b');
SELECT pg_temp.assert(
  (SELECT stock_quantity FROM inventory WHERE id = '00000000-0000-0000-0000-00000000ee01') = 5,
  'ATK1c el stock NO se descontó (seguía en 5)');

-- ════════════════════════════════════════════════════════════
-- ATK2: descuento no autorizado por cashier.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ed09';
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ed01'::uuid, 'atk2', 'hash-atk2',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[{"descripcion":"Producto Seguridad","tipo_linea":"producto","cantidad":1,"precio_unitario":1000,"descuento_linea":50,"currency":"ARS","exchange_rate":1,"inventory_id":"00000000-0000-0000-0000-00000000ee01"}],"pagos":[{"payment_method":"efectivo","amount":500,"currency":"ARS","amount_ars":500,"exchange_rate":1}],"cc_total":0}'::jsonb
  );
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable', 'ATK2a descuento no autorizado por cashier -> falla');
END $$;
SELECT pg_temp.assert_no_effects('00000000-0000-0000-0000-00000000ed01', 'atk2', 'ATK2b');

-- ════════════════════════════════════════════════════════════
-- ATK3: costo falso (no cambia el resultado — el costo se ignora del payload
--       para ítems con inventory_id, siempre se resuelve server-side).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_costo numeric;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ed19'; -- owner, con permiso de override de PRECIO
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ed01'::uuid, 'atk3', 'hash-atk3',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[{"descripcion":"Producto Seguridad","tipo_linea":"producto","cantidad":1,"precio_unitario":1000,"descuento_linea":0,"costo_unitario":1,"currency":"ARS","exchange_rate":1,"inventory_id":"00000000-0000-0000-0000-00000000ee01"}],"pagos":[{"payment_method":"efectivo","amount":1000,"currency":"ARS","amount_ars":1000,"exchange_rate":1}],"cc_total":0}'::jsonb
  );
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'created', 'ATK3a mismo precio de lista (sin override) -> created');
  SELECT costo_unitario INTO v_costo FROM comprobante_items WHERE comprobante_id = (r->>'comprobante_id')::uuid;
  PERFORM pg_temp.assert(v_costo = 600, 'ATK3b el costo_unitario FINAL es 600 (resuelto server-side), el costo_unitario=1 del payload fue IGNORADO para ítems de inventario');
END $$;

-- ════════════════════════════════════════════════════════════
-- ATK4: inventory_id de OTRO negocio.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ed09';
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ed01'::uuid, 'atk4', 'hash-atk4',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[{"descripcion":"Producto de otro negocio","tipo_linea":"producto","cantidad":1,"precio_unitario":500,"descuento_linea":0,"currency":"ARS","exchange_rate":1,"inventory_id":"00000000-0000-0000-0000-00000000ee02"}],"pagos":[{"payment_method":"efectivo","amount":500,"currency":"ARS","amount_ars":500,"exchange_rate":1}],"cc_total":0}'::jsonb
  );
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable', 'ATK4a inventory_id de OTRO negocio -> falla (no encontrado para este business_id)');
END $$;
SELECT pg_temp.assert_no_effects('00000000-0000-0000-0000-00000000ed01', 'atk4', 'ATK4b');
SELECT pg_temp.assert(
  (SELECT stock_quantity FROM inventory WHERE id = '00000000-0000-0000-0000-00000000ee02') = 5,
  'ATK4c el stock del producto AJENO no se tocó');

-- ════════════════════════════════════════════════════════════
-- ATK5: pago negativo.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ed19';
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ed01'::uuid, 'atk5', 'hash-atk5',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[{"descripcion":"Producto Seguridad","tipo_linea":"producto","cantidad":1,"precio_unitario":1000,"descuento_linea":0,"currency":"ARS","exchange_rate":1,"inventory_id":"00000000-0000-0000-0000-00000000ee01"}],"pagos":[{"payment_method":"efectivo","amount":-500,"currency":"ARS","amount_ars":-500,"exchange_rate":1}],"cc_total":0}'::jsonb
  );
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable', 'ATK5a pago con monto negativo -> falla');
END $$;
SELECT pg_temp.assert_no_effects('00000000-0000-0000-0000-00000000ed01', 'atk5', 'ATK5b');

-- ════════════════════════════════════════════════════════════
-- ATK6: pago mayor al total (sin CC que lo justifique).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ed19';
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ed01'::uuid, 'atk6', 'hash-atk6',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[{"descripcion":"Producto Seguridad","tipo_linea":"producto","cantidad":1,"precio_unitario":1000,"descuento_linea":0,"currency":"ARS","exchange_rate":1,"inventory_id":"00000000-0000-0000-0000-00000000ee01"}],"pagos":[{"payment_method":"efectivo","amount":999999,"currency":"ARS","amount_ars":999999,"exchange_rate":1}],"cc_total":0}'::jsonb
  );
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable', 'ATK6a pago que excede el total recalculado -> falla');
END $$;
SELECT pg_temp.assert_no_effects('00000000-0000-0000-0000-00000000ed01', 'atk6', 'ATK6b');

-- ════════════════════════════════════════════════════════════
-- ATK7: cantidad cero / negativa.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb; v_stock_before integer; v_stock_after integer;
BEGIN
  SELECT stock_quantity INTO v_stock_before FROM inventory WHERE id = '00000000-0000-0000-0000-00000000ee01';

  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ed19';
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ed01'::uuid, 'atk7', 'hash-atk7',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[{"descripcion":"Producto Seguridad","tipo_linea":"producto","cantidad":-3,"precio_unitario":1000,"descuento_linea":0,"currency":"ARS","exchange_rate":1,"inventory_id":"00000000-0000-0000-0000-00000000ee01"}],"pagos":[],"cc_total":0}'::jsonb
  );
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable', 'ATK7a cantidad negativa -> falla');

  SELECT stock_quantity INTO v_stock_after FROM inventory WHERE id = '00000000-0000-0000-0000-00000000ee01';
  PERFORM pg_temp.assert(v_stock_after = v_stock_before, 'ATK7c el stock NO cambió por la cantidad negativa (seguía en ' || v_stock_before || ')');
END $$;
SELECT pg_temp.assert_no_effects('00000000-0000-0000-0000-00000000ed01', 'atk7', 'ATK7b');

-- ════════════════════════════════════════════════════════════
-- ATK8: precio_unitario = "NaN" (string numérica válida para el tipo numeric).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ed19';
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ed01'::uuid, 'atk8', 'hash-atk8',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[{"descripcion":"Producto Seguridad","tipo_linea":"producto","cantidad":1,"precio_unitario":"NaN","descuento_linea":0,"currency":"ARS","exchange_rate":1,"inventory_id":"00000000-0000-0000-0000-00000000ee01"}],"pagos":[],"cc_total":0}'::jsonb
  );
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable', 'ATK8a precio_unitario="NaN" -> falla');
END $$;
SELECT pg_temp.assert_no_effects('00000000-0000-0000-0000-00000000ed01', 'atk8', 'ATK8b');

-- ════════════════════════════════════════════════════════════
-- ATK9: precio_unitario = "Infinity".
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ed19';
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ed01'::uuid, 'atk9', 'hash-atk9',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[{"descripcion":"Producto Seguridad","tipo_linea":"producto","cantidad":1,"precio_unitario":"Infinity","descuento_linea":0,"currency":"ARS","exchange_rate":1,"inventory_id":"00000000-0000-0000-0000-00000000ee01"}],"pagos":[],"cc_total":0}'::jsonb
  );
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable', 'ATK9a precio_unitario="Infinity" -> falla');
END $$;
SELECT pg_temp.assert_no_effects('00000000-0000-0000-0000-00000000ed01', 'atk9', 'ATK9b');

-- ════════════════════════════════════════════════════════════
-- ATK10: vender por debajo del costo sin permiso (sales SÍ puede aplicar
--        descuento, pero NO vender a pérdida).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ed29'; -- salesA
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ed01'::uuid, 'atk10', 'hash-atk10',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[{"descripcion":"Producto Seguridad","tipo_linea":"producto","cantidad":1,"precio_unitario":500,"descuento_linea":0,"currency":"ARS","exchange_rate":1,"inventory_id":"00000000-0000-0000-0000-00000000ee01"}],"pagos":[{"payment_method":"efectivo","amount":500,"currency":"ARS","amount_ars":500,"exchange_rate":1}],"cc_total":0}'::jsonb
  );
  RESET ROLE;
  -- 500 < costo 600 -> sales tiene permiso de override de PRECIO pero NO de vender bajo costo.
  PERFORM pg_temp.assert(r->>'status' = 'failed_retryable', 'ATK10a sales vende por debajo del costo (500 < costo 600) -> falla (sin permiso de below-cost)');
END $$;
SELECT pg_temp.assert_no_effects('00000000-0000-0000-0000-00000000ed01', 'atk10', 'ATK10b');

-- ════════════════════════════════════════════════════════════
-- ATK11 (control positivo): owner SÍ puede vender por debajo del costo.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000ed19'; -- ownerA
  r := create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000000ed01'::uuid, 'atk11', 'hash-atk11',
    '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[{"descripcion":"Producto Seguridad","tipo_linea":"producto","cantidad":1,"precio_unitario":500,"descuento_linea":0,"currency":"ARS","exchange_rate":1,"inventory_id":"00000000-0000-0000-0000-00000000ee01"}],"pagos":[{"payment_method":"efectivo","amount":500,"currency":"ARS","amount_ars":500,"exchange_rate":1}],"cc_total":0}'::jsonb
  );
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status' = 'created', 'ATK11a owner SÍ puede vender por debajo del costo (500 < 600) -> created');
END $$;

-- ════════════════════════════════════════════════════════════
-- Grants (catálogo)
-- ════════════════════════════════════════════════════════════
SELECT pg_temp.assert(NOT has_function_privilege('anon', 'public.resolve_product_pricing(numeric,numeric,numeric,numeric,text,numeric,boolean,numeric,numeric)', 'EXECUTE'), 'GRANTS anon NO puede resolver pricing');
SELECT pg_temp.assert(NOT has_function_privilege('anon', 'public.user_can_override_price(uuid,uuid)', 'EXECUTE'), 'GRANTS anon NO puede consultar permisos de override');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated', 'public.user_can_override_price(uuid,uuid)', 'EXECUTE'), 'GRANTS authenticated NO puede llamar user_can_override_price directo (solo internamente vía SECURITY DEFINER)');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated', 'public.reserve_comprobante_number(uuid,text)', 'EXECUTE'), 'GRANTS authenticated NO puede reservar número directamente');
SELECT pg_temp.assert(has_function_privilege('service_role', 'public.reserve_comprobante_number(uuid,text)', 'EXECUTE'), 'GRANTS service_role SÍ puede (función interna)');

SELECT 'ALL TESTS PASSED (rolled back)' AS result;
ROLLBACK;
