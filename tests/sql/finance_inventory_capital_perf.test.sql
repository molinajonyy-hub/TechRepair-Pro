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
-- El fixture usa N productos a proposito: con la forma vieja el trabajo sobre
-- `inventory` crece como N^2 y con la correcta como N. V07 mide exactamente eso.
--
-- ── POR QUE V07 NO ES UN CRONOMETRO ────────────────────────────────────────
--
-- Dos razones, las dos medidas:
--
-- 1. La FORMA de la consulta importa. El RPC siempre lee la vista acotada por
--    `business_id`; medir la vista SIN ese filtro ejercita otro plan. Sobre el
--    mismo fixture: sin filtro ~98 ms, con filtro ~8.135 ms. Un test que mide
--    la forma global aprueba aunque el camino del producto este roto.
--
-- 2. El reloj no es comparable entre maquinas. Este Docker cuesta ~9 ms por
--    llamada plpgsql contra ~0,07 ms en produccion: dos ordenes de magnitud.
--    Una cota fija en milisegundos rechazaria un plan correcto en un runner
--    lento, o aprobaria uno cuadratico en uno rapido.
--
-- Por eso V07 asevera la FORMA DEL PLAN sobre la consulta REAL (con filtro de
-- tenant, como `authenticated`, con autoridad de costo). Dos aserciones
-- independientes del reloj:
--
--   V07a  los scans de `inventory` DENTRO de las CTE de exclusion corren UNA
--         vez (loops ~ 1), no una por producto.
--   V07b  el costo de la EXCLUSION es O(N), no O(N^2): se suman las filas que
--         los ANTI JOIN descartan, por sus loops. Mira el TIPO DE NODO, no la
--         sintaxis, asi que cualquier reescritura equivalente —operandos
--         invertidos, concat(), format(), NOT IN— que vuelva a excluir por
--         fila la rompe igual.
--
-- El tiempo queda como techo secundario y generoso, nunca como unico gate.
--
-- ── QUE SE VERIFICA ────────────────────────────────────────────────────────
--   V01  el capital y el conteo de productos son los correctos
--   V02  el padre por `parent_id` queda EXCLUIDO del universo
--   V03  el padre por `supplier_code = 'VPREF-<id>'` queda EXCLUIDO
--   V04  aislamiento de tenant: el otro negocio no entra en el agregado
--   V05  sin autoridad de costo la vista devuelve CERO FILAS (no un 0 falso)
--   V06  la vista no publica costo por producto: solo agregados por negocio
--   V07  forma del plan sobre la consulta REAL, con filtro de tenant
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

-- ── V07 — forma del plan sobre la consulta REAL ───────────────────────────

-- Recorre el arbol de un plan en FORMAT JSON y devuelve cada nodo.
CREATE OR REPLACE FUNCTION pg_temp.plan_nodes(p jsonb)
RETURNS SETOF jsonb LANGUAGE plpgsql AS $$
DECLARE hijo jsonb;
BEGIN
  RETURN NEXT p;
  IF p ? 'Plans' THEN
    FOR hijo IN SELECT jsonb_array_elements(p->'Plans') LOOP
      RETURN QUERY SELECT * FROM pg_temp.plan_nodes(hijo);
    END LOOP;
  END IF;
END;
$$;

DO $v7$
DECLARE
  a          uuid := 'cab17a10-0000-0000-0000-0000000000a0';
  v_plan     jsonb;
  v_raiz     jsonb;
  v_ms       numeric;
  v_prod     bigint;
  v_touch    numeric;
  v_cota     numeric;
  v_cte      text;
  v_loops    numeric;
  v_faltante text;
BEGIN
  SELECT count(*) INTO v_prod
    FROM public.inventory WHERE business_id = a AND is_active;

  PERFORM set_config('role','authenticated',true);
  PERFORM pg_temp.act_as('cab17a10-0000-0000-0000-000000000001');

  -- La consulta es EXACTAMENTE la forma que ejecuta el RPC: la vista acotada
  -- por business_id, como authenticated, con autoridad de costo. Un plan
  -- catastrofico se corta solo en vez de colgar CI; el corte ES la falla.
  BEGIN
    PERFORM set_config('statement_timeout','60s',true);
    EXECUTE format(
      'EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) '
      'SELECT * FROM public.v_finance_inventory_capital WHERE business_id = %L', a)
      INTO v_plan;
  EXCEPTION WHEN query_canceled THEN
    PERFORM set_config('role','none',true);
    RAISE EXCEPTION 'V07: la consulta REAL (con filtro de tenant) no termino en 60s '
      'con % productos. Es el sintoma del plan cuadratico.', v_prod;
  END;
  PERFORM set_config('statement_timeout','0',true);
  PERFORM set_config('role','none',true);

  v_raiz := v_plan -> 0 -> 'Plan';
  v_ms   := (v_plan -> 0 ->> 'Execution Time')::numeric;

  -- V07b — costo de la EXCLUSION: O(N), no O(N^2). Va PRIMERO porque es la
  -- asercion de COMPORTAMIENTO y no depende de como se llamen los nodos: si el
  -- plan volvio a ser cuadratico, que la falla lo diga con el numero medido.
  --
  -- Se suman las filas que los ANTI JOIN descartan, por sus loops. Ese numero
  -- ES la regresion: con la forma correlacionada el plan descartaba 440.531
  -- (611 productos x 721 filas reescaneadas); con la forma materializada
  -- descarta ~1 por producto.
  --
  -- Mira el TIPO DE NODO, no la sintaxis del SQL: da igual si alguien reescribe
  -- el NOT EXISTS con operandos invertidos, con concat(), con format() o con
  -- NOT IN — si el plan vuelve a excluir por fila, falla.
  --
  -- Se acota a los anti-join a proposito. El JOIN a `v_inventory_costs` puede
  -- planificarse como nested loop con reescaneo del lado interno segun las
  -- estadisticas (medido en este contenedor: 81.406 descartes con 404
  -- productos), y eso es un riesgo SEPARADO —de SEC-08B, no de esta
  -- migracion—. Meterlo en la misma cota obligaria a aflojarla tanto que
  -- dejaria de detectar los 440.531.
  SELECT COALESCE(sum(COALESCE((n->>'Rows Removed by Join Filter')::numeric,0)
                      * COALESCE((n->>'Actual Loops')::numeric,1)), 0)
    INTO v_touch
    FROM pg_temp.plan_nodes(v_raiz) n
   WHERE n->>'Join Type' = 'Anti';

  v_cota := 25 * GREATEST(v_prod, 1);
  IF v_touch > v_cota THEN
    RAISE EXCEPTION 'V07b: los anti-join descartan % filas con % productos (cota %). '
      'Eso es crecimiento cuadratico: el conjunto de exclusion se evalua por fila.',
      v_touch, v_prod, v_cota;
  END IF;

  -- V07a — ademas, las CTE de exclusion tienen que EXISTIR y correr UNA vez.
  FOREACH v_cte IN ARRAY ARRAY['CTE variant_parents','CTE vpref_parents'] LOOP
    -- Se ubica el subarbol de la CTE y se miran los scans de inventory dentro.
    SELECT max((d->>'Actual Loops')::numeric) INTO v_loops
      FROM pg_temp.plan_nodes(v_raiz) c,
           LATERAL pg_temp.plan_nodes(c) d
     WHERE c->>'Subplan Name' = v_cte
       AND d->>'Relation Name' = 'inventory';

    IF v_loops IS NULL THEN
      v_faltante := COALESCE(v_faltante || ', ', '') || v_cte;
    ELSIF v_loops > 2 THEN
      RAISE EXCEPTION 'V07a: el scan de inventory dentro de «%» corre % veces. '
        'El conjunto de exclusion se esta recalculando por fila: volvio el anti-join correlacionado.',
        v_cte, v_loops;
    END IF;
  END LOOP;

  IF v_faltante IS NOT NULL THEN
    RAISE EXCEPTION 'V07a: el plan de la consulta REAL no materializa las CTE de exclusion (falta: %). '
      'Sin ellas el universo se excluye fila por fila, que es la regresion.', v_faltante;
  END IF;

  -- Techo secundario. Deliberadamente flojo: el reloj de este contenedor no es
  -- comparable con produccion (~2 ordenes de magnitud). No es el gate.
  IF v_ms > 30000 THEN
    RAISE EXCEPTION 'V07c: la consulta REAL tardo % ms con % productos', round(v_ms), v_prod;
  END IF;

  RAISE NOTICE 'V07 ok: % productos · CTE de exclusion con loops<=2 · descartes de anti-join % (cota %) · % ms',
    v_prod, v_touch, v_cota, round(v_ms);
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
