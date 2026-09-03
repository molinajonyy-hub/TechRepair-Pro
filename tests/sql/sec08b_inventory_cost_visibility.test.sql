-- SEC-08B — contrato SQL de la visibilidad del COSTO DE INVENTARIO.
--
-- Prueba lo que se prueba mejor en SQL puro: la forma de los GRANT de columna,
-- la forma de las policies, que las proyecciones autorizadas sean DEFINER y
-- estén ligadas al negocio de la fila, y que la denegación sea por PRIVILEGIO
-- (42501) y no por «cero filas» — porque un cero silencioso en una columna de
-- costo se lee como «cuesta cero», que es justo lo que este lote prohíbe.
--
-- La matriz de red (oráculos por filtro y por ORDER BY, relaciones anidadas,
-- portal mayorista, overrides, vistas de finanzas, controles negativos) vive en
-- scripts/security/sec08b-postgrest.mjs.
--
-- Nota de seguridad del propio test: NUNCA se entra a una función SECURITY
-- DEFINER con el rol cambiado dentro de un DO — ese patrón crashea el backend.
-- El cambio de rol se usa SÓLO para tocar tablas y vistas.
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

/**
 * Lee una expresión COMO el rol dado.
 * 'DENIED' = PostgreSQL rechazó por privilegio (42501). 'NO_ROWS' = la RLS o el
 * gate filtraron la fila. La distinción importa: sobre la TABLA se espera
 * DENIED (GRANT de columna), sobre la VISTA autorizada se espera NO_ROWS.
 */
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

-- ── Fixture ──────────────────────────────────────────────────────────────────
SET session_replication_role = replica;

DO $seed$
DECLARE
  a uuid := '5ec08b00-0000-0000-0000-0000000000a0';
  b uuid := '5ec08b00-0000-0000-0000-0000000000b0';
BEGIN
  INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
    ('5ec08b00-0000-0000-0000-000000000001','owner@sec08b.invalid',now()),
    ('5ec08b00-0000-0000-0000-000000000002','admin@sec08b.invalid',now()),
    ('5ec08b00-0000-0000-0000-000000000003','manager@sec08b.invalid',now()),
    ('5ec08b00-0000-0000-0000-000000000004','sales@sec08b.invalid',now()),
    ('5ec08b00-0000-0000-0000-000000000005','cashier@sec08b.invalid',now()),
    ('5ec08b00-0000-0000-0000-000000000006','tech@sec08b.invalid',now()),
    ('5ec08b00-0000-0000-0000-000000000009','ownerb@sec08b.invalid',now());
  INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
    (a,'SEC08B-A','5ec08b00-0000-0000-0000-000000000001','pro','active'),
    (b,'SEC08B-B','5ec08b00-0000-0000-0000-000000000009','pro','active');
  INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES
    ('5ec08b00-0000-0000-0000-000000000001',a,'owner',  true,'owner@sec08b.invalid'),
    ('5ec08b00-0000-0000-0000-000000000002',a,'admin',  true,'admin@sec08b.invalid'),
    ('5ec08b00-0000-0000-0000-000000000003',a,'manager',true,'manager@sec08b.invalid'),
    ('5ec08b00-0000-0000-0000-000000000004',a,'sales',  true,'sales@sec08b.invalid'),
    ('5ec08b00-0000-0000-0000-000000000005',a,'cashier',true,'cashier@sec08b.invalid'),
    ('5ec08b00-0000-0000-0000-000000000006',a,'tech',   true,'tech@sec08b.invalid'),
    ('5ec08b00-0000-0000-0000-000000000009',b,'owner',  true,'ownerb@sec08b.invalid');

  -- Producto padre + VARIANTE (fila con parent_id: la variante real del esquema).
  INSERT INTO public.inventory(id,business_id,code,name,category,cost_price,cost_price_usd,sale_price,stock_quantity,is_active,has_variants,parent_id) VALUES
    ('5ec08b00-0000-0000-0000-0000000000c1',a,'SEC08B-SQL-P','Padre','cat',71011,0,74044,9,true,true,NULL),
    ('5ec08b00-0000-0000-0000-0000000000c2',a,'SEC08B-SQL-V','Variante','cat',73033,0,74044,4,true,false,'5ec08b00-0000-0000-0000-0000000000c1');

  INSERT INTO public.inventory_movements(id,business_id,inventory_item_id,movement_type,quantity,previous_stock,new_stock,unit_cost)
    VALUES ('5ec08b00-0000-0000-0000-0000000000d1',a,'5ec08b00-0000-0000-0000-0000000000c1','purchase',1,0,1,75055);

  INSERT INTO public.purchases(id,business_id,purchase_date) VALUES ('5ec08b00-0000-0000-0000-0000000000e1',a,now());
  INSERT INTO public.purchase_items(id,business_id,purchase_id,inventory_item_id,description,quantity,unit_cost,subtotal)
    VALUES ('5ec08b00-0000-0000-0000-0000000000e2',a,'5ec08b00-0000-0000-0000-0000000000e1','5ec08b00-0000-0000-0000-0000000000c1','l',1,76066,76066);

  INSERT INTO public.inventory_valuation_history(id,business_id,fecha,capital_invertido,valor_venta,ganancia_potencial,cantidad_total_items)
    VALUES ('5ec08b00-0000-0000-0000-0000000000f1',a,current_date,78088,1,1,1);
END
$seed$;

SET session_replication_role = origin;

-- ── 1. La columna de costo está REVOCADA, no meramente filtrada ──────────────
-- La diferencia es el corazón del lote: una policy de fila deja pasar
-- `WHERE cost_price = <x>`, que responde «¿cuánto cuesta?» sin devolver nunca la
-- columna. Sólo el GRANT de columna cierra esa puerta, y se manifiesta como
-- 42501 — no como cero filas.
DO $t1$
BEGIN
  PERFORM pg_temp.assert(
    pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000004',
      'SELECT cost_price::text FROM public.inventory WHERE id = ''5ec08b00-0000-0000-0000-0000000000c1''') = 'DENIED',
    'sales no puede proyectar inventory.cost_price (42501, no cero filas)');

  -- El ORÁCULO por filtro: no devuelve la columna, pero la responde.
  PERFORM pg_temp.assert(
    pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000004',
      'SELECT code FROM public.inventory WHERE cost_price = 71011') = 'DENIED',
    'sales no puede usar cost_price como ORÁCULO en el WHERE');

  -- El ORÁCULO por ordenamiento.
  PERFORM pg_temp.assert(
    pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000004',
      'SELECT code FROM public.inventory ORDER BY cost_price DESC LIMIT 1') = 'DENIED',
    'sales no puede usar cost_price como ORÁCULO en el ORDER BY');

  -- Ni siquiera el owner puede proyectar la columna cruda: el GRANT es estático.
  PERFORM pg_temp.assert(
    pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000001',
      'SELECT cost_price::text FROM public.inventory WHERE id = ''5ec08b00-0000-0000-0000-0000000000c1''') = 'DENIED',
    'ni el owner proyecta la columna cruda: el GRANT de columna no distingue actores');

  PERFORM pg_temp.assert(
    pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000004',
      'SELECT unit_cost::text FROM public.inventory_movements WHERE id = ''5ec08b00-0000-0000-0000-0000000000d1''') = 'DENIED',
    'sales no puede proyectar inventory_movements.unit_cost');
END
$t1$;

-- ── 2. Lo OPERATIVO sobrevive — si no, esto sería una pantalla rota ─────────
DO $t2$
BEGIN
  PERFORM pg_temp.assert(
    pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000004',
      'SELECT sale_price::text FROM public.inventory WHERE id = ''5ec08b00-0000-0000-0000-0000000000c1''') = '74044.00',
    'sales SIGUE viendo el precio de venta (POS)');
  PERFORM pg_temp.assert(
    pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000004',
      'SELECT stock_quantity::text FROM public.inventory WHERE id = ''5ec08b00-0000-0000-0000-0000000000c1''') = '9',
    'sales SIGUE viendo el stock');
  PERFORM pg_temp.assert(
    pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000004',
      'SELECT code FROM public.inventory WHERE parent_id = ''5ec08b00-0000-0000-0000-0000000000c1''') = 'SEC08B-SQL-V',
    'sales SIGUE viendo la VARIANTE como producto vendible');
  PERFORM pg_temp.assert(
    pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000004',
      'SELECT movement_type FROM public.inventory_movements WHERE id = ''5ec08b00-0000-0000-0000-0000000000d1''') = 'purchase',
    'sales SIGUE viendo el tipo de movimiento de stock');
END
$t2$;

-- ── 3. La proyección autorizada: quien puede, ve; quien no, no ──────────────
-- Acá la denegación SÍ es «cero filas», porque es un gate de autoridad y no de
-- privilegio. Un 42501 en esta vista significaría pantalla rota para todos.
DO $t3$
DECLARE
  q_cost   text := 'SELECT cost_price::text FROM public.v_inventory_costs WHERE inventory_id = ''5ec08b00-0000-0000-0000-0000000000c1''';
  q_variant text := 'SELECT cost_price::text FROM public.v_inventory_costs WHERE inventory_id = ''5ec08b00-0000-0000-0000-0000000000c2''';
  q_move   text := 'SELECT unit_cost::text FROM public.v_inventory_movement_costs WHERE movement_id = ''5ec08b00-0000-0000-0000-0000000000d1''';
BEGIN
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000001',q_cost) = '71011.00',
    'owner recibe el costo REAL por la proyección autorizada');
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000002',q_cost) = '71011.00',
    'admin recibe el costo real');
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000003',q_cost) = '71011.00',
    'manager recibe el costo real');
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000003',q_variant) = '73033.00',
    'manager recibe el costo real de la VARIANTE');
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000001',q_move) = '75055.00',
    'owner recibe el costo real del movimiento');

  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000004',q_cost) = 'NO_ROWS',
    'sales NO recibe costo — y es NO_ROWS, no 42501: la vista no está rota');
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000006',q_cost) = 'NO_ROWS',
    'tech NO recibe costo');
  -- cashier tiene `finance` pero NO `inventory_view_costs`: el costo de
  -- INVENTARIO no es suyo, aunque el COGS del P&L sí lo sea.
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000005',q_cost) = 'NO_ROWS',
    'cashier NO recibe costo de inventario pese a tener finance');
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000009',q_cost) = 'NO_ROWS',
    'el owner del tenant AJENO no alcanza el costo del negocio A');
  PERFORM pg_temp.assert(pg_temp.read_expr('anon',NULL,q_cost) IN ('DENIED','NO_ROWS'),
    'anon no alcanza la proyección de costo');
END
$t3$;

-- ── 4. Tablas cuya fila entera es costo ─────────────────────────────────────
-- Acá no hace falta cirugía de columna: `subtotal / quantity` reconstruye
-- `unit_cost` exactamente, así que se gatea la FILA.
DO $t4$
DECLARE
  q_pi  text := 'SELECT unit_cost::text FROM public.purchase_items WHERE id = ''5ec08b00-0000-0000-0000-0000000000e2''';
  q_sub text := 'SELECT subtotal::text FROM public.purchase_items WHERE id = ''5ec08b00-0000-0000-0000-0000000000e2''';
  q_ivh text := 'SELECT capital_invertido::text FROM public.inventory_valuation_history WHERE id = ''5ec08b00-0000-0000-0000-0000000000f1''';
BEGIN
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000001',q_pi) = '76066.00',
    'owner sigue viendo el costo de la línea de compra');
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000004',q_pi) = 'NO_ROWS',
    'sales NO ve el costo de la línea de compra');
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000004',q_sub) = 'NO_ROWS',
    'sales tampoco reconstruye el costo por subtotal/quantity');
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000001',q_ivh) = '78088.00',
    'owner sigue viendo el historial de valuación');
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000004',q_ivh) = 'NO_ROWS',
    'sales NO ve el capital invertido histórico');
END
$t4$;

-- ── 5. Overrides — en los dos sentidos ──────────────────────────────────────
DO $t5$
DECLARE
  q text := 'SELECT cost_price::text FROM public.v_inventory_costs WHERE inventory_id = ''5ec08b00-0000-0000-0000-0000000000c1''';
BEGIN
  UPDATE public.profiles SET permissions = '{"inventory_view_costs": true}'::jsonb
   WHERE id = '5ec08b00-0000-0000-0000-000000000004';
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000004',q) = '71011.00',
    'override true sobre sales: ahora SÍ recibe costo');

  -- El motivo por el que `can_view_inventory_cost` NO incluye `finance`: admin
  -- lo trae por defecto, y con la unión este override habría quedado muerto.
  UPDATE public.profiles SET permissions = '{"inventory_view_costs": false}'::jsonb
   WHERE id = '5ec08b00-0000-0000-0000-000000000002';
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000002',q) = 'NO_ROWS',
    'override false sobre admin DENIEGA de verdad, pese a que admin tiene finance');

  -- Un payload roto no puede AMPLIAR privilegio.
  UPDATE public.profiles SET permissions = '{"inventory_view_costs": "true"}'::jsonb
   WHERE id = '5ec08b00-0000-0000-0000-000000000006';
  PERFORM pg_temp.assert(pg_temp.read_expr('authenticated','5ec08b00-0000-0000-0000-000000000006',q) = 'NO_ROWS',
    'un override no booleano es fail-closed');

  UPDATE public.profiles SET permissions = NULL
   WHERE id IN ('5ec08b00-0000-0000-0000-000000000002','5ec08b00-0000-0000-0000-000000000004','5ec08b00-0000-0000-0000-000000000006');
END
$t5$;

-- ── 6. Forma del contrato en el catálogo ────────────────────────────────────
DO $t6$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(format('%s.%s->%s', table_name, column_name, grantee), ', ')
    INTO v_bad FROM information_schema.column_privileges
   WHERE table_schema='public' AND privilege_type='SELECT' AND grantee IN ('anon','authenticated')
     AND ( (table_name='inventory' AND column_name IN ('cost_price','cost_price_usd'))
        OR (table_name='inventory_movements' AND column_name='unit_cost')
        OR (table_name='comprobante_items' AND column_name IN ('costo_unitario','costo_total')) );
  PERFORM pg_temp.assert(v_bad IS NULL, 'ninguna columna de costo está concedida a un rol del navegador');

  -- Las proyecciones autorizadas TIENEN que ser DEFINER: con security_invoker
  -- volverían a depender del GRANT revocado y responderían 42501 a todos.
  SELECT string_agg(c.relname, ', ') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='v'
     AND c.relname IN ('v_inventory_costs','v_inventory_movement_costs','v_comprobante_item_costs')
     AND COALESCE(array_to_string(c.reloptions,','),'') ILIKE '%security_invoker=true%';
  PERFORM pg_temp.assert(v_bad IS NULL, 'las proyecciones de costo son DEFINER');

  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon','public.can_view_inventory_cost(uuid)','EXECUTE'),
    'anon no ejecuta can_view_inventory_cost');
  PERFORM pg_temp.assert(
    has_function_privilege('authenticated','public.can_view_inventory_cost(uuid)','EXECUTE'),
    'authenticated SÍ ejecuta can_view_inventory_cost (si no, toda vista que la use rompe)');
  PERFORM pg_temp.assert(
    NOT has_schema_privilege('authenticated','private','USAGE'),
    'el esquema private sigue cerrado para authenticated');
END
$t6$;

ROLLBACK;

