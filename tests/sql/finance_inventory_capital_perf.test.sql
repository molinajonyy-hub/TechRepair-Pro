-- ============================================================================
-- v_finance_inventory_capital — regresion de la clase «anti-join cuadratico».
--
-- Corre contra el stack LOCAL o una BRANCH (NUNCA produccion), con
-- 20260917120000_finance_inventory_capital_antijoin_perf.sql ya aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/finance_inventory_capital_perf.test.sql
--
-- Todo ocurre dentro de UNA transaccion que termina en ROLLBACK.
--
-- POR QUE EXISTE
--
-- `get_finance_charts_l1` expiraba en produccion (57014) contra el
-- statement_timeout de 8s de `authenticated`. La causa no era el volumen: 357
-- comprobantes y 795 productos. Era que la vista excluia los padres de
-- variante con un NOT EXISTS CORRELACIONADO contra una cadena construida
-- (`v.supplier_code = 'VPREF-' || i.id::text`). Ese termino depende de la fila
-- externa, asi que el planner no puede hashear ni indexar: reescanea
-- `inventory` una vez por producto, y cada fila interna reevalua la policy RLS,
-- que llama a `current_user_can('inventory')` (plpgsql). Cuadratico.
--
-- El fixture usa N productos a proposito: con la forma vieja el costo crece
-- como N^2 y la cota de V07 se rompe sola. Con la forma correcta crece como N.
--
-- ── QUE SE VERIFICA ────────────────────────────────────────────────────────
--   V01  el capital y el conteo de productos son los correctos
--   V02  el padre por `parent_id` queda EXCLUIDO del universo
--   V03  el padre por `supplier_code = 'VPREF-<id>'` queda EXCLUIDO
--   V04  aislamiento de tenant: el otro negocio no entra en el agregado
--   V05  sin autoridad de costo la vista devuelve CERO FILAS (no un 0 falso)
--   V06  la vista no publica costo por producto: solo agregados por negocio
--   V07  cota de ejecucion con N productos (la clase de regresion medida)
--   V08  estructural: la definicion vigente no correlaciona el anti-join
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_user_id IS NULL THEN PERFORM set_config('request.jwt.claims','',true);
  ELSE PERFORM set_config('request.jwt.claims',
    json_build_object('sub',p_user_id::text,'role','authenticated')::text,true); END IF;
END;
$$;

-- ── Fixture ────────────────────────────────────────────────────────────────
SET session_replication_role = replica;

DO $seed$
DECLARE
  a         uuid := 'cab17a10-0000-0000-0000-0000000000a0';
  b         uuid := 'cab17a10-0000-0000-0000-0000000000b0';
  u_owner   uuid := 'cab17a10-0000-0000-0000-000000000001';
  u_sales   uuid := 'cab17a10-0000-0000-0000-000000000002';
  u_ownerb  uuid := 'cab17a10-0000-0000-0000-000000000009';
  padre_pid uuid := 'cab17a10-0000-0000-0000-0000000000c1';
  padre_vpr uuid := 'cab17a10-0000-0000-0000-0000000000c3';
  -- N productos vendibles. Con la forma vieja el trabajo es N*(N+extras).
  n         int  := 400;
BEGIN
  INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
    (u_owner ,'owner@capital.invalid' ,now()),
    (u_sales ,'sales@capital.invalid' ,now()),
    (u_ownerb,'ownerb@capital.invalid',now());
  INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
    (a,'CAPITAL-A',u_owner ,'pro','active'),
    (b,'CAPITAL-B',u_ownerb,'pro','active');
  INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES
    (u_owner ,a,'owner',true,'owner@capital.invalid'),
    (u_sales ,a,'sales',true,'sales@capital.invalid'),
    (u_ownerb,b,'owner',true,'ownerb@capital.invalid');

  -- N productos simples: stock 2, costo 100 => capital esperado 200*n.
  INSERT INTO public.inventory(business_id,code,name,category,cost_price,cost_price_usd,
                               sale_price,stock_quantity,is_active,tipo)
  SELECT a, 'CAPPERF-A-'||g, 'p'||g, 'cat', 100, 0, 300, 2, true, 'product'
    FROM generate_series(1,n) g;

  -- Padre por parent_id + su variante. El padre NO debe contar (V02).
  INSERT INTO public.inventory(id,business_id,code,name,category,cost_price,cost_price_usd,
                               sale_price,stock_quantity,is_active,tipo,has_variants,parent_id) VALUES
    (padre_pid,a,'CAPPERF-A-PADRE-PID','padre pid','cat',9999,0,1,5,true,'product',true,NULL),
    ('cab17a10-0000-0000-0000-0000000000c2',a,'CAPPERF-A-VAR','variante','cat',100,0,300,2,
     true,'product',false,padre_pid);

  -- Padre por la convencion VPREF-. Tampoco debe contar (V03).
  INSERT INTO public.inventory(id,business_id,code,name,category,cost_price,cost_price_usd,
                               sale_price,stock_quantity,is_active,tipo) VALUES
    (padre_vpr,a,'CAPPERF-A-PADRE-VPREF','padre vpref','cat',7777,0,1,5,true,'product');
  INSERT INTO public.inventory(business_id,code,name,category,cost_price,cost_price_usd,
                               sale_price,stock_quantity,is_active,tipo,supplier_code) VALUES
    (a,'CAPPERF-A-VPREFHIJO','hijo vpref','cat',100,0,300,2,true,'product',
     'VPREF-'||padre_vpr::text);

  -- Otro negocio: no puede entrar en el agregado de A (V04).
  INSERT INTO public.inventory(business_id,code,name,category,cost_price,cost_price_usd,
                               sale_price,stock_quantity,is_active,tipo)
  SELECT b, 'CAPPERF-B-'||g, 'pb'||g, 'cat', 5000, 0, 9000, 7, true, 'product'
    FROM generate_series(1,50) g;
END
$seed$;

SET session_replication_role = origin;

-- ── V01/V02/V03/V04 — universo y aritmetica ────────────────────────────────
DO $v1$
DECLARE
  a uuid := 'cab17a10-0000-0000-0000-0000000000a0';
  v_cap numeric; v_tot bigint;
BEGIN
  PERFORM set_config('role','authenticated',true);
  PERFORM pg_temp.act_as('cab17a10-0000-0000-0000-000000000001');
  SELECT inventory_at_cost, products_total INTO v_cap, v_tot
    FROM public.v_finance_inventory_capital WHERE business_id = a;
  PERFORM set_config('role','none',true);

  -- 400 simples + 1 variante + 1 hijo-vpref = 402 filas de stock 2 y costo 100.
  -- Los DOS padres quedan fuera: si entraran, el capital subiria 9999*5+7777*5
  -- y el conteo daria 404.
  IF v_tot IS DISTINCT FROM 402 THEN
    RAISE EXCEPTION 'V01/V02/V03: products_total = % (esperado 402). Un padre de variante se colo en el universo.', v_tot;
  END IF;
  IF v_cap IS DISTINCT FROM 80400.00 THEN
    RAISE EXCEPTION 'V01: inventory_at_cost = % (esperado 80400.00)', v_cap;
  END IF;
  RAISE NOTICE 'V01/V02/V03 ok: 402 productos, capital %', v_cap;
END
$v1$;

DO $v4$
DECLARE
  b uuid := 'cab17a10-0000-0000-0000-0000000000b0';
  v_filas bigint;
BEGIN
  PERFORM set_config('role','authenticated',true);
  PERFORM pg_temp.act_as('cab17a10-0000-0000-0000-000000000001');
  SELECT count(*) INTO v_filas
    FROM public.v_finance_inventory_capital WHERE business_id = b;
  PERFORM set_config('role','none',true);
  IF v_filas <> 0 THEN
    RAISE EXCEPTION 'V04: el owner de A recibe % fila(s) del negocio B', v_filas;
  END IF;
  RAISE NOTICE 'V04 ok: aislamiento de tenant';
END
$v4$;

-- ── V05 — sin autoridad de costo, CERO FILAS (no un cero falso) ────────────
DO $v5$
DECLARE v_filas bigint; v_cap numeric;
BEGIN
  PERFORM set_config('role','authenticated',true);
  PERFORM pg_temp.act_as('cab17a10-0000-0000-0000-000000000002');  -- sales
  SELECT count(*), max(inventory_at_cost) INTO v_filas, v_cap
    FROM public.v_finance_inventory_capital;
  PERFORM set_config('role','none',true);
  IF v_filas <> 0 THEN
    RAISE EXCEPTION 'V05: un actor sin inventory_view_costs recibio % fila(s) de capital (cap=%)', v_filas, v_cap;
  END IF;
  RAISE NOTICE 'V05 ok: sin autoridad no hay filas, y por lo tanto no hay 0 falso';
END
$v5$;

-- ── V06 — la vista no publica costo por producto ──────────────────────────
DO $v6$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(column_name, ',' ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='v_finance_inventory_capital';
  IF v_cols ~ '(^|,)(cost_price|cost_price_usd|inventory_id|unit_cost)(,|$)' THEN
    RAISE EXCEPTION 'V06: la vista expone costo por producto (columnas: %)', v_cols;
  END IF;
  RAISE NOTICE 'V06 ok: solo agregados por negocio';
END
$v6$;

-- ── V07 — cota de ejecucion. ES la regresion medida ───────────────────────
-- La cota es deliberadamente generosa: no mide "rapido", mide "no cuadratico".
-- Con 402 productos la forma vieja hacia ~160k reevaluaciones de una funcion
-- plpgsql dentro de la policy RLS; en produccion, con 611, tardaba 32.786 ms.
DO $v7$
DECLARE t0 timestamptz; v_ms numeric; v_filas bigint;
BEGIN
  PERFORM set_config('role','authenticated',true);
  PERFORM pg_temp.act_as('cab17a10-0000-0000-0000-000000000001');
  t0 := clock_timestamp();
  SELECT count(*) INTO v_filas FROM public.v_finance_inventory_capital;
  v_ms := extract(epoch FROM (clock_timestamp() - t0)) * 1000;
  PERFORM set_config('role','none',true);

  IF v_filas <> 1 THEN
    RAISE EXCEPTION 'V07: el fixture no devolvio 1 negocio (dio %)', v_filas;
  END IF;
  -- 800 ms discrimina con margen en las dos direcciones. Medido local:
  -- forma correcta 68 ms (11x por debajo), forma vieja 2.615 ms (3,3x por
  -- encima). Una maquina de CI mas lenta mueve los DOS numeros: el cociente
  -- entre ambos, que es ~38x, es lo que la cota aprovecha.
  IF v_ms > 800 THEN
    RAISE EXCEPTION 'V07: v_finance_inventory_capital tardo % ms con 402 productos. '
      'Volvio el anti-join cuadratico: el planner esta reescaneando inventory por fila.', round(v_ms);
  END IF;
  RAISE NOTICE 'V07 ok: % ms con 402 productos', round(v_ms);
END
$v7$;

-- ── V08 — estructural: la definicion vigente no correlaciona ──────────────
DO $v8$
DECLARE v_def text;
BEGIN
  v_def := pg_get_viewdef('public.v_finance_inventory_capital'::regclass, true);
  IF v_def ~* 'NOT EXISTS' AND v_def ~* '''VPREF-''::text \|\|' THEN
    RAISE EXCEPTION 'V08: volvio el NOT EXISTS correlacionado contra la cadena construida';
  END IF;
  IF v_def !~* 'v_inventory_costs' THEN
    RAISE EXCEPTION 'V08: la vista dejo de tomar el costo de v_inventory_costs (SEC-08B)';
  END IF;
  RAISE NOTICE 'V08 ok: anti-join por igualdad y costo por la vista autorizada';
END
$v8$;

ROLLBACK;
