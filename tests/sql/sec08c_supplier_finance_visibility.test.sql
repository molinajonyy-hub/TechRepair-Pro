-- SEC-08C - contrato SQL de la VISIBILIDAD FINANCIERA DE PROVEEDORES.
--
-- Prueba lo que se prueba mejor en SQL puro: la forma de las policies, la
-- autoridad que las gobierna, el modo de seguridad de las vistas, los grants,
-- y -sobre todo- que un actor SIN autoridad reciba NULL y no CERO.
--
-- La matriz de red (oraculos por filtro y por ORDER BY, embeds, overrides,
-- cross-tenant, autoridad de escritura y controles negativos) vive en
-- scripts/security/sec08c-postgrest.mjs.
--
-- Nota de seguridad del propio test: NUNCA se entra a una funcion SECURITY
-- DEFINER con el rol cambiado dentro de un DO - ese patron crashea el backend.
-- El cambio de rol se usa SOLO para tocar tablas y vistas.
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert(p_condition boolean, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_label; END IF;
  RAISE NOTICE 'PASS: %', p_label;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_user_id IS NULL THEN PERFORM set_config('request.jwt.claims','',true);
  ELSE PERFORM set_config('request.jwt.claims',
    json_build_object('sub',p_user_id::text,'role','authenticated')::text,true); END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.read_expr(p_role text, p_actor uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('role', p_role, true);
  PERFORM pg_temp.act_as(p_actor);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION
    WHEN insufficient_privilege THEN PERFORM set_config('role','none',true); RETURN 'DENIED';
  END;
  PERFORM set_config('role','none',true);
  RETURN COALESCE(v,'NO_ROWS');
END;
$$;

-- ═══ 1. La autoridad existe y tiene la forma correcta ═════════════════════
DO $$
DECLARE r record;
BEGIN
  SELECT p.prosecdef, p.provolatile, array_to_string(p.proconfig,',') AS cfg
    INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='can_view_supplier_finance';

  PERFORM pg_temp.assert(r IS NOT NULL, 'can_view_supplier_finance existe');
  -- INVOKER: no necesita elevacion, solo compone capabilities del llamador.
  -- Un SECDEF aca seria una superficie de bypass sin ninguna necesidad.
  PERFORM pg_temp.assert(r.prosecdef = false, 'can_view_supplier_finance es SECURITY INVOKER');
  PERFORM pg_temp.assert(r.provolatile = 's', 'can_view_supplier_finance es STABLE');
  PERFORM pg_temp.assert(r.cfg LIKE 'search_path=%', 'can_view_supplier_finance fija search_path');
  -- pg_temp AL FINAL: omitirlo lo pone PRIMERO y habilita shadowing.
  PERFORM pg_temp.assert(r.cfg LIKE '%pg_temp', 'search_path termina en pg_temp');

  -- FASE C: el segundo termino es una CONJUNCION. `inventory_view_costs` es una
  -- sub-permission del modulo de inventario y por si sola no describe a un
  -- actor de compras; ademas v_inventory_costs (SEC-08B) ya exige las dos.
  PERFORM pg_temp.assert(
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname='can_view_supplier_finance'
               AND pg_get_functiondef(p.oid) LIKE '%''inventory''%'),
    'la autoridad exige `inventory` junto con los costos (no solo-costos)');

  -- Compone capabilities EXISTENTES. No se invento `supplier_finance`.
  PERFORM pg_temp.assert(
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname='can_view_supplier_finance'
               AND pg_get_functiondef(p.oid) LIKE '%''finance''%'
               AND pg_get_functiondef(p.oid) LIKE '%''inventory_view_costs''%'),
    'la autoridad compone finance OR inventory_view_costs');
  PERFORM pg_temp.assert(
    -- prokind='f': pg_get_functiondef() revienta sobre agregados y ventanas.
    NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname IN ('public','private') AND p.prokind='f'
                   AND pg_get_functiondef(p.oid) LIKE '%''supplier_finance''%'),
    'NO se introdujo una capability supplier_finance');

  -- anon no puede ejecutar la autoridad.
  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon', 'public.can_view_supplier_finance(uuid)', 'EXECUTE'),
    'anon NO puede ejecutar can_view_supplier_finance');
  PERFORM pg_temp.assert(
    has_function_privilege('authenticated', 'public.can_view_supplier_finance(uuid)', 'EXECUTE'),
    'authenticated SI puede ejecutar can_view_supplier_finance');
END $$;

-- ═══ 2. Las policies de lectura usan la autoridad nueva ═══════════════════
DO $$
DECLARE t text;
BEGIN
  -- FASE B: `supplier_purchases` SALE de esta lista. Su fila mezcla importes
  -- con datos operativos, asi que la tabla base volvio a la autoridad de costo
  -- y el actor de finanzas la recibe por una proyeccion (bloque 2b). Estas dos
  -- tablas, en cambio, son verdad financiera de punta a punta.
  FOREACH t IN ARRAY ARRAY['supplier_payments','supplier_account_movements'] LOOP
    PERFORM pg_temp.assert(
      EXISTS (SELECT 1 FROM pg_policies
               WHERE schemaname='public' AND tablename=t AND cmd='SELECT'
                 AND qual LIKE '%can_view_supplier_finance%'),
      format('%s: SELECT exige can_view_supplier_finance', t));
    -- Tenencia: la autoridad NO reemplaza al predicado de tenant.
    PERFORM pg_temp.assert(
      EXISTS (SELECT 1 FROM pg_policies
               WHERE schemaname='public' AND tablename=t AND cmd='SELECT'
                 AND qual LIKE '%current_user_business_id%'),
      format('%s: SELECT conserva el predicado de tenant', t));
    -- Ninguna policy de SELECT puede haber quedado con la autoridad vieja,
    -- que era `inventory` a secas: ese era el defecto D/E.
    PERFORM pg_temp.assert(
      NOT EXISTS (SELECT 1 FROM pg_policies
                   WHERE schemaname='public' AND tablename=t AND cmd='SELECT'
                     AND qual LIKE '%current_user_can(''inventory''%'),
      format('%s: SELECT ya NO se gobierna con la capability inventory', t));
    PERFORM pg_temp.assert(
      (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename=t AND cmd='SELECT') = 1,
      format('%s: hay UNA sola policy de SELECT (dos PERMISSIVE se OR-ean)', t));
    PERFORM pg_temp.assert(
      (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=t),
      format('%s: RLS activo', t));
  END LOOP;
END $$;

-- ═══ 2b. FASE B — la tabla BASE no se gobierna con la autoridad financiera ══
-- La fase A la abrio a can_view_supplier_finance y con eso un actor
-- finance-only se llevaba la fila entera (invoice_number, notes,
-- attachment_url, created_by). Vuelve a exigir autoridad de COSTO.
DO $$
BEGIN
  PERFORM pg_temp.assert(
    EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname='public' AND tablename='supplier_purchases'
               AND cmd='SELECT' AND qual LIKE '%can_view_inventory_cost%'),
    'supplier_purchases: SELECT vuelve a exigir can_view_inventory_cost');
  PERFORM pg_temp.assert(
    NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='supplier_purchases'
                   AND cmd='SELECT' AND qual LIKE '%can_view_supplier_finance%'),
    'supplier_purchases: la tabla base NO entrega la fila cruda al actor de finanzas');

  -- La proyeccion financiera existe, es la ruta autorizada, y NO publica
  -- ningun campo operativo.
  PERFORM pg_temp.assert(
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname='finance_supplier_purchases'),
    'existe la proyeccion finance_supplier_purchases');
  PERFORM pg_temp.assert(
    NOT EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN unnest(p.proargnames) AS argname ON true
       WHERE n.nspname='public' AND p.proname='finance_supplier_purchases'
         AND argname IN ('invoice_number','payment_method','notes','attachment_url',
                         'created_by','created_at','updated_at')),
    'la proyeccion NO publica campos operativos');
  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon', 'public.finance_supplier_purchases()', 'EXECUTE'),
    'anon NO puede ejecutar la proyeccion');

  -- Las vistas de finanzas leen la PROYECCION, no la tabla base: si leyeran la
  -- base, un actor finance-only veria cero filas y el agregado fabricaria un 0.
  PERFORM pg_temp.assert(
    pg_get_viewdef('public.v_finance_supplier_debt'::regclass, true) LIKE '%finance_supplier_purchases%',
    'v_finance_supplier_debt lee la proyeccion');
  PERFORM pg_temp.assert(
    pg_get_viewdef('public.v_finance_payables_aging'::regclass, true) LIKE '%finance_supplier_purchases%',
    'v_finance_payables_aging lee la proyeccion');
  PERFORM pg_temp.assert(
    pg_get_viewdef('public.v_finance_payables_due'::regclass, true) LIKE '%finance_supplier_purchases%',
    'v_finance_payables_due lee la proyeccion');
END $$;

-- ═══ 2c. FASE B — pagar exige `finance` ═══════════════════════════════════
-- Mover dinero a un proveedor no es una operacion de inventario. Comprar A
-- CREDITO si lo es y conserva la excepcion ratificada de SEC-08B.
DO $$
DECLARE v_def text;
BEGIN
  FOR v_def IN
    SELECT pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prokind='f'
       AND p.proname IN ('pay_supplier_free_atomic','pay_supplier_purchase_atomic')
  LOOP
    PERFORM pg_temp.assert(v_def LIKE '%require_action_authority(p_business_id, ''finance''%',
      'una RPC de pago exige finance');
    PERFORM pg_temp.assert(v_def NOT LIKE '%require_action_authority(p_business_id, ''inventory''%',
      'esa RPC de pago ya NO exige inventory');
  END LOOP;

  -- Comprar: inventory siempre; finance ADEMAS cuando hay pago inicial. Sin
  -- esta conjuncion, p_paid_amount > 0 seguiria moviendo caja con inventory.
  FOR v_def IN
    SELECT pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prokind='f'
       AND p.proname IN ('create_supplier_purchase_atomic','create_quick_inventory_purchase_atomic')
  LOOP
    PERFORM pg_temp.assert(v_def LIKE '%''inventory''%', 'comprar sigue exigiendo inventory');
    PERFORM pg_temp.assert(v_def LIKE '%''finance''%' AND v_def LIKE '%> 0 THEN%',
      'comprar CON pago inicial exige ademas finance');
  END LOOP;
END $$;

-- ═══ 3. SEC-08B no se reabre ni se colapsa ════════════════════════════════
DO $$
BEGIN
  -- La linea de compra sigue exigiendo SOLO autoridad de costo. Un actor de
  -- finanzas ve la deuda agregada del proveedor y NO el costo por articulo.
  PERFORM pg_temp.assert(
    EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname='public' AND tablename='supplier_purchase_items'
               AND cmd='SELECT' AND qual LIKE '%can_view_inventory_cost%'),
    'supplier_purchase_items: SELECT sigue exigiendo can_view_inventory_cost');
  PERFORM pg_temp.assert(
    NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='supplier_purchase_items'
                   AND cmd='SELECT' AND qual LIKE '%can_view_supplier_finance%'),
    'supplier_purchase_items: NO se relajo con la autoridad de SEC-08C');

  -- La ESCRITURA sigue en `inventory`: el contrato ratificado de comprar sin
  -- poder leer el costo resultante se preserva.
  PERFORM pg_temp.assert(
    EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname='public' AND tablename='supplier_purchases'
               AND cmd='INSERT' AND with_check LIKE '%current_user_can(''inventory''%'),
    'supplier_purchases: INSERT sigue gobernado por inventory');
  PERFORM pg_temp.assert(
    EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname='public' AND tablename='supplier_purchase_items'
               AND cmd='INSERT' AND with_check LIKE '%current_user_can(''inventory''%'),
    'supplier_purchase_items: INSERT sigue gobernado por inventory');
END $$;

-- ═══ 4. Grants ════════════════════════════════════════════════════════════
DO $$
DECLARE v text;
BEGIN
  SELECT string_agg(table_name||':'||privilege_type, ', ' ORDER BY table_name) INTO v
    FROM information_schema.role_table_grants
   WHERE table_schema='public' AND grantee='anon'
     AND table_name IN ('supplier_payments','supplier_account_movements',
                        'supplier_purchases','supplier_purchase_items','suppliers');
  PERFORM pg_temp.assert(v IS NULL, format('anon sin grants sobre tablas de proveedor (hay: %s)', COALESCE(v,'-')));

  FOREACH v IN ARRAY ARRAY['v_finance_supplier_debt','v_finance_supplier_stats'] LOOP
    PERFORM pg_temp.assert(
      NOT has_table_privilege('anon', 'public.'||v, 'SELECT'),
      format('%s: anon NO puede leerla', v));
    PERFORM pg_temp.assert(
      has_table_privilege('authenticated', 'public.'||v, 'SELECT'),
      format('%s: authenticated SI puede leerla', v));
  END LOOP;
END $$;

-- ═══ 5. Las vistas son security_invoker ═══════════════════════════════════
-- Una vista de finanzas que pierde security_invoker corre con los privilegios
-- del owner: seria un bypass total de RLS y de tenant.
DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['v_finance_supplier_debt','v_finance_supplier_stats',
                           'v_finance_position','v_finance_payables_aging',
                           'v_finance_payables_due'] LOOP
    PERFORM pg_temp.assert(
      (SELECT COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                         WHERE option_name='security_invoker'),'off') = 'true'
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=v),
      format('%s: security_invoker=true', v));
  END LOOP;

  -- v_finance_position.payables tiene que estar gateada, o el cashier veria 0
  -- (COALESCE sobre cero filas) y `sales` veria la deuda real.
  PERFORM pg_temp.assert(
    pg_get_viewdef('public.v_finance_position'::regclass, true) LIKE '%can_view_supplier_finance%',
    'v_finance_position: payables gateada por can_view_supplier_finance');
  -- Y NO se toco el gate de costo que puso SEC-08B.
  PERFORM pg_temp.assert(
    pg_get_viewdef('public.v_finance_position'::regclass, true) LIKE '%can_view_inventory_cost%',
    'v_finance_position: inventory_at_cost conserva el gate de SEC-08B');
END $$;

-- ═══ 6. RESTRINGIDO ES NULL, NUNCA CERO ══════════════════════════════════
-- El corazon del lote. Se siembra deuda REAL distinta de cero y se compara la
-- lectura de tres actores: uno con autoridad, uno sin, y el mismo sin
-- autoridad tras un override.
DO $$
DECLARE
  v_biz uuid := gen_random_uuid();
  v_owner uuid := gen_random_uuid();
  v_sales uuid := gen_random_uuid();
  v_cashier uuid := gen_random_uuid();
  v_manager uuid := gen_random_uuid();
  v_sup uuid := gen_random_uuid();
  v_debt numeric := 51988;
  v_out text;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
    (v_owner,'o@sec08c-sql.invalid',now()),
    (v_sales,'s@sec08c-sql.invalid',now()),
    (v_cashier,'c@sec08c-sql.invalid',now()),
    (v_manager,'m@sec08c-sql.invalid',now());
  INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status)
    VALUES (v_biz,'B-08C',v_owner,'pro','active');
  INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES
    (v_owner,v_biz,'owner',true,'o@sec08c-sql.invalid'),
    (v_sales,v_biz,'sales',true,'s@sec08c-sql.invalid'),
    (v_cashier,v_biz,'cashier',true,'c@sec08c-sql.invalid'),
    (v_manager,v_biz,'manager',true,'m@sec08c-sql.invalid');
  INSERT INTO public.suppliers(id,business_id,name,active) VALUES (v_sup,v_biz,'Prov-SQL',true);
  INSERT INTO public.supplier_purchases(id,business_id,supplier_id,purchase_date,total_amount,paid_amount,pending_amount,payment_status)
    VALUES (gen_random_uuid(),v_biz,v_sup,current_date,73191,21203,v_debt,'partial');
  SET LOCAL session_replication_role = origin;

  -- El actor de FINANZAS recibe el numero real. Sin este positivo, el resto
  -- del bloque no distingue "cerrado" de "roto".
  v_out := pg_temp.read_expr('authenticated', v_cashier,
    format('SELECT outstanding_ars::text FROM public.v_finance_supplier_debt WHERE business_id=%L', v_biz));
  PERFORM pg_temp.assert(v_out::numeric = v_debt,
    format('cashier (finance) recibe la deuda REAL %s (llego %s)', v_debt, v_out));

  v_out := pg_temp.read_expr('authenticated', v_cashier,
    format('SELECT is_authorized::text FROM public.v_finance_supplier_debt WHERE business_id=%L', v_biz));
  PERFORM pg_temp.assert(v_out = 'true', 'cashier: is_authorized = true');

  -- El actor OPERATIVO no recibe la deuda... y tampoco recibe un cero.
  v_out := pg_temp.read_expr('authenticated', v_sales,
    format('SELECT COALESCE(outstanding_ars::text,''IS_NULL'') FROM public.v_finance_supplier_debt WHERE business_id=%L', v_biz));
  PERFORM pg_temp.assert(v_out = 'IS_NULL',
    format('sales: outstanding_ars tiene que ser NULL (restringido), NUNCA 0 - llego %s', v_out));
  PERFORM pg_temp.assert(v_out <> '0', 'sales: el cero falso no volvio');

  v_out := pg_temp.read_expr('authenticated', v_sales,
    format('SELECT is_authorized::text FROM public.v_finance_supplier_debt WHERE business_id=%L', v_biz));
  PERFORM pg_temp.assert(v_out = 'false', 'sales: is_authorized = false (la UI sabe por que hay NULL)');

  -- Lo mismo en las stats por proveedor.
  v_out := pg_temp.read_expr('authenticated', v_sales,
    format('SELECT COALESCE(pending_amount::text,''IS_NULL'') FROM public.v_finance_supplier_stats WHERE supplier_id=%L', v_sup));
  PERFORM pg_temp.assert(v_out = 'IS_NULL',
    format('sales: v_finance_supplier_stats.pending_amount NULL, no 0 - llego %s', v_out));
  -- El positivo de las stats POR PROVEEDOR se toma de `manager`, no de
  -- `cashier`. Son dos superficies con dos audiencias:
  --   · v_finance_supplier_debt  → agregado del negocio, arranca en
  --     `businesses`. Es la del FinanceDashboard y la ve el actor de finanzas.
  --   · v_finance_supplier_stats → por proveedor, arranca en `suppliers`, que
  --     sigue exigiendo la capability `inventory`. Es la de la pantalla
  --     /suppliers, gateada por esa misma permission.
  -- Un cashier sin `inventory` no lista proveedores y por lo tanto no recibe
  -- filas aca. Eso NO es un cero falso: no hay fila, no hay importe, y la
  -- pantalla que la consumiria le esta vedada por routing.
  v_out := pg_temp.read_expr('authenticated', v_manager,
    format('SELECT pending_amount::text FROM public.v_finance_supplier_stats WHERE supplier_id=%L', v_sup));
  PERFORM pg_temp.assert(v_out::numeric = v_debt, 'manager: las stats por proveedor traen el importe real');

  v_out := pg_temp.read_expr('authenticated', v_cashier,
    format('SELECT COALESCE(pending_amount::text,''IS_NULL'') FROM public.v_finance_supplier_stats WHERE supplier_id=%L', v_sup));
  PERFORM pg_temp.assert(v_out = 'NO_ROWS',
    format('cashier sin inventory: sin fila de proveedor (llego %s)', v_out));

  -- El manager tambien tiene que ver la deuda agregada: es el rol de COMPRAS y
  -- perderla habria sido una regresion de operacion legitima, no seguridad.
  v_out := pg_temp.read_expr('authenticated', v_manager,
    format('SELECT outstanding_ars::text FROM public.v_finance_supplier_debt WHERE business_id=%L', v_biz));
  PERFORM pg_temp.assert(v_out::numeric = v_debt,
    format('manager (inventory_view_costs) conserva la deuda agregada (llego %s)', v_out));

  -- Y la fila cruda no cruza para sales, ni por proyeccion ni por conteo.
  v_out := pg_temp.read_expr('authenticated', v_sales,
    format('SELECT count(*)::text FROM public.supplier_purchases WHERE business_id=%L', v_biz));
  PERFORM pg_temp.assert(v_out = '0', 'sales: supplier_purchases no devuelve filas');

  -- ── OVERRIDE: la autoridad tiene que resolver por perfil, no por rol ────
  UPDATE public.profiles SET permissions = '{"finance": true}'::jsonb WHERE id = v_sales;
  v_out := pg_temp.read_expr('authenticated', v_sales,
    format('SELECT outstanding_ars::text FROM public.v_finance_supplier_debt WHERE business_id=%L', v_biz));
  PERFORM pg_temp.assert(v_out::numeric = v_debt,
    format('override finance=true sobre sales: ahora SI ve la deuda real (llego %s)', v_out));

  -- Override a false sobre un actor que la tenia por defecto: tiene que denegar.
  UPDATE public.profiles SET permissions = '{"finance": false, "inventory_view_costs": false}'::jsonb WHERE id = v_cashier;
  v_out := pg_temp.read_expr('authenticated', v_cashier,
    format('SELECT COALESCE(outstanding_ars::text,''IS_NULL'') FROM public.v_finance_supplier_debt WHERE business_id=%L', v_biz));
  PERFORM pg_temp.assert(v_out = 'IS_NULL', 'override finance=false sobre cashier: deniega, y con NULL');

  -- FASE C: `inventory_view_costs` A SOLAS —sin `inventory`— NO alcanza. Es la
  -- unica combinacion que cierra el endurecimiento, y solo se puede fabricar
  -- con un override: ningun rol nace solo-costos.
  UPDATE public.profiles
     SET permissions = '{"inventory": false, "inventory_view_costs": true, "finance": false}'::jsonb
   WHERE id = v_sales;
  v_out := pg_temp.read_expr('authenticated', v_sales,
    format('SELECT COALESCE(outstanding_ars::text,''IS_NULL'') FROM public.v_finance_supplier_debt WHERE business_id=%L', v_biz));
  PERFORM pg_temp.assert(v_out = 'IS_NULL',
    format('solo-costos (inventory=false) NO alcanza la deuda - llego %s', v_out));

  -- …y con `inventory` puesto, la misma combinacion SI alcanza: la denegacion
  -- de arriba es por la conjuncion, no porque la superficie este rota.
  UPDATE public.profiles
     SET permissions = '{"inventory": true, "inventory_view_costs": true, "finance": false}'::jsonb
   WHERE id = v_sales;
  v_out := pg_temp.read_expr('authenticated', v_sales,
    format('SELECT outstanding_ars::text FROM public.v_finance_supplier_debt WHERE business_id=%L', v_biz));
  PERFORM pg_temp.assert(v_out::numeric = v_debt,
    format('inventory + costos SI alcanza la deuda (llego %s)', v_out));

  -- Un payload roto NO puede ampliar privilegio.
  UPDATE public.profiles SET permissions = '{"finance": "true"}'::jsonb WHERE id = v_sales;
  v_out := pg_temp.read_expr('authenticated', v_sales,
    format('SELECT COALESCE(outstanding_ars::text,''IS_NULL'') FROM public.v_finance_supplier_debt WHERE business_id=%L', v_biz));
  PERFORM pg_temp.assert(v_out = 'IS_NULL', 'override con string en vez de boolean: fail-closed');

  RAISE NOTICE 'PASS: bloque de verdad restringida completo';
END $$;

-- Todo el fixture vive dentro de la transaccion: el ROLLBACK lo borra.
ROLLBACK;
