-- ============================================================================
-- P0-A.1U1V — Los importes de órdenes salen del servidor SOLO con permiso.
-- Casos 13-20 del contrato. READ-ONLY: BEGIN … ROLLBACK.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz  '00000000-0000-0000-0000-0000000a0a01'
\set biz2 '00000000-0000-0000-0000-0000000a0b01'
\set own  '00000000-0000-0000-0000-0000000a0a09'
\set own2 '00000000-0000-0000-0000-0000000a0b09'
\set cash '00000000-0000-0000-0000-0000000a0a02'
\set tech '00000000-0000-0000-0000-0000000a0a03'
\set view '00000000-0000-0000-0000-0000000a0a04'
\set cust '00000000-0000-0000-0000-0000000a0ac1'
\set caja '00000000-0000-0000-0000-0000000a0a61'
\set ord  '00000000-0000-0000-0000-0000000a0af1'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'own'), (:'own2'), (:'cash'), (:'tech'), (:'view');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','PERM A',:'own'), (:'biz2','PERM B',:'own2');
-- OJO: current_business_id() (la que usan las policies de orders/comprobantes)
-- resuelve por profiles.id = auth.uid(), NO por profiles.user_id. Un seed que
-- sólo setea user_id hace que la RLS descarte todo en silencio. Se setean AMBOS.
INSERT INTO profiles(id,business_id,user_id,role,is_active) VALUES
  (:'own',:'biz',:'own','owner',true), (:'own2',:'biz2',:'own2','owner',true),
  (:'cash',:'biz',:'cash','cashier',true), (:'tech',:'biz',:'tech','tech',true),
  (:'view',:'biz',:'view','viewer',true);
INSERT INTO customers(id,business_id,name,phone,customer_type) VALUES (:'cust',:'biz','Cli','+5400','minorista');
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'caja',:'biz',:'own','abierta');
INSERT INTO orders(id,business_id,status,created_by) VALUES (:'ord',:'biz','repair',:'own');
SET LOCAL session_replication_role='origin';

-- Venta 100.000 con 40.000 efectivo y 60.000 a cuenta corriente -> partial.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000000a0a01'::uuid,'P1','h1',
    jsonb_build_object('tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id','00000000-0000-0000-0000-0000000a0ac1','order_id','00000000-0000-0000-0000-0000000a0af1',
      'es_fiscal',false,'cc_total',60000,
      'items',jsonb_build_array(jsonb_build_object('descripcion','Serv','tipo_linea','servicio','cantidad',1,
        'precio_unitario',100000,'descuento_linea',0,'costo_unitario',0,'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
      'pagos',jsonb_build_array(jsonb_build_object('payment_method','efectivo','amount',40000,'currency','ARS','amount_ars',40000,'exchange_rate',1))));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='created', 'S1 checkout ('||COALESCE(r->>'error','')||')');
END $$;

-- ============ Capacidad por rol (contrato de producto) =====================
SELECT pg_temp.assert(user_can_view_order_amounts(:'biz',:'own')  IS TRUE,  'A1 owner puede ver importes');
SELECT pg_temp.assert(user_can_view_order_amounts(:'biz',:'cash') IS TRUE,  'A2 cashier puede ver importes');
SELECT pg_temp.assert(user_can_view_order_amounts(:'biz',:'tech') IS FALSE, 'A3 tech NO puede ver importes');
SELECT pg_temp.assert(user_can_view_order_amounts(:'biz',:'view') IS FALSE, 'A4 viewer NO puede ver importes');
SELECT pg_temp.assert(user_can_view_order_amounts(:'biz',:'own2') IS FALSE, 'A5 owner de OTRO negocio no puede');
SELECT pg_temp.assert(user_can_view_order_amounts(:'biz', NULL)   IS FALSE, 'A6 sin actor -> fail-closed');

-- ============ 13. owner autorizado =========================================
DO $$
DECLARE r jsonb; fila jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a09';
  r := get_order_financial_amounts('00000000-0000-0000-0000-0000000a0a01'::uuid,
        ARRAY['00000000-0000-0000-0000-0000000a0af1']::uuid[]);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'authorized')::boolean, 'B1 owner autorizado');
  fila := r->'rows'->0;
  PERFORM pg_temp.assert((fila->>'total_comprobado')::numeric = 100000, 'B2 total 100.000');
  PERFORM pg_temp.assert((fila->>'saldo_pendiente')::numeric = 60000,  'B3 saldo 60.000');
END $$;

-- ============ 14/15. tech y viewer: cero filas, sin importes ==============
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a03'; -- tech
  r := get_order_financial_amounts('00000000-0000-0000-0000-0000000a0a01'::uuid, NULL);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'C1 tech recibe respuesta válida');
  PERFORM pg_temp.assert((r->>'authorized')::boolean IS FALSE, 'C2 tech NO autorizado');
  PERFORM pg_temp.assert(jsonb_array_length(r->'rows') = 0, 'C3 tech recibe CERO filas (no importes en cero)');
  PERFORM pg_temp.assert(r::text NOT LIKE '%100000%' AND r::text NOT LIKE '%60000%',
    'C4 la respuesta a tech no contiene ningún importe');
END $$;
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a04'; -- viewer
  r := get_order_financial_amounts('00000000-0000-0000-0000-0000000a0a01'::uuid, NULL);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'authorized')::boolean IS FALSE AND jsonb_array_length(r->'rows') = 0,
    'C5 viewer tampoco obtiene importes');
END $$;

-- cashier SÍ
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a02';
  r := get_order_financial_amounts('00000000-0000-0000-0000-0000000a0a01'::uuid, NULL);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'authorized')::boolean AND jsonb_array_length(r->'rows') = 1, 'C6 cashier sí ve importes');
END $$;

-- ============ 16. cross-business bloqueado ================================
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0b09'; -- owner B
  r := get_order_financial_amounts('00000000-0000-0000-0000-0000000a0a01'::uuid, NULL);
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code' = 'FORBIDDEN', 'D1 otro negocio -> FORBIDDEN (ni siquiera "sin permiso")');
END $$;

-- ============ 17/18. anon y PUBLIC cerrados ===============================
SELECT pg_temp.assert(
  has_function_privilege('anon','public.get_order_financial_amounts(uuid,uuid[])','EXECUTE') = false,
  'E1 anon no puede ejecutar la RPC de importes');
SELECT pg_temp.assert(
  has_function_privilege('anon','public.user_can_view_order_amounts(uuid,uuid)','EXECUTE') = false,
  'E2 anon no puede evaluar la capacidad');
SELECT pg_temp.assert(
  has_table_privilege('anon','public.v_order_payment_state','SELECT') = false,
  'E3 anon no lee ni el estado sin importes');

-- ============ 19. sin bypass por consulta directa =========================
SELECT pg_temp.assert(
  has_table_privilege('authenticated','public.v_order_financial_status','SELECT') = false,
  'F1 authenticated YA NO puede leer la vista con importes directamente');
SELECT pg_temp.assert(
  has_table_privilege('authenticated','public.v_customer_unallocated_credit','SELECT') = false,
  'F2 el crédito no imputado tampoco es legible directamente');
DO $$
DECLARE v_err text := ''; n int;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a03'; -- tech
  BEGIN
    SELECT count(*) INTO n FROM v_order_financial_status;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(v_err LIKE '%permission denied%' OR v_err LIKE '%denegado%',
    'F3 un tech que consulta la vista directamente recibe permission denied ('||v_err||')');
END $$;

-- ============ 20. el filtro financiero funciona SIN revelar montos ========
DO $$
DECLARE v_estado text; v_cols int;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a03'; -- tech
  SELECT payment_status INTO v_estado FROM v_order_payment_state
   WHERE order_id = '00000000-0000-0000-0000-0000000a0af1';
  RESET ROLE;
  PERFORM pg_temp.assert(v_estado = 'partial', 'G1 tech SÍ ve el estado de cobro (badge y filtro funcionan)');
  SELECT count(*) INTO v_cols FROM information_schema.columns
   WHERE table_schema='public' AND table_name='v_order_payment_state'
     AND column_name IN ('total_comprobado','total_cobrado','saldo_pendiente','saldo_en_cc','imputado_cc');
  PERFORM pg_temp.assert(v_cols = 0, 'G2 la vista de estado NO tiene ninguna columna de importe');
END $$;

-- El crédito del cliente también queda restringido.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000a0a03';
  r := get_customer_unallocated_credit('00000000-0000-0000-0000-0000000a0a01'::uuid,'00000000-0000-0000-0000-0000000a0ac1'::uuid);
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'authorized')::boolean IS FALSE AND (r ? 'unallocated_amount') IS FALSE,
    'H1 tech no recibe el crédito del cliente ni como campo');
END $$;

ROLLBACK;
