-- ===========================================================================
-- M8 - medicion de rendimiento de generate_finance_insights.
--
-- Corre en una transaccion con ROLLBACK: no deja datos. Mide la generacion
-- completa de las 10 reglas en UNA sola operacion (no una RPC por regla) sobre
-- un negocio con volumen sintetico.
--
-- RUN: docker cp ... && psql -X -f
-- ===========================================================================
BEGIN;
SET LOCAL client_min_messages = notice;

\set biz  '00000000-0000-0000-0000-00000000perf'
\set biz  '00000000-0000-0000-0000-0000000fe001'
\set own  '00000000-0000-0000-0000-0000000fe009'
\set sup  '00000000-0000-0000-0000-0000000fe031'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'own');
INSERT INTO businesses(id,name,owner_user_id,subscription_status,subscription_plan)
  VALUES (:'biz','M8 perf',:'own','active','pro');
INSERT INTO profiles(id,business_id,user_id,role,is_active)
  VALUES (:'own',:'biz',:'own','owner',true);
INSERT INTO suppliers(id,business_id,name) VALUES (:'sup',:'biz','Prov perf');

-- Volumen sintetico: 2.000 productos, 3.000 compras, 5.000 movimientos.
INSERT INTO inventory(business_id, code, name, category, cost_price, sale_price,
                      stock_quantity, is_active, tipo, base_currency, base_price,
                      exchange_rate_used)
SELECT :'biz', 'PERF-'||g, 'Producto '||g, 'cat', 100 + (g % 500), 200 + (g % 900),
       1 + (g % 40), true, 'product',
       CASE WHEN g % 4 = 0 THEN 'USD' ELSE 'ARS' END,
       CASE WHEN g % 4 = 0 THEN 10 + (g % 50) ELSE NULL END,
       CASE WHEN g % 4 = 0 THEN 1200 + (g % 300) ELSE NULL END
FROM generate_series(1, 2000) g;

INSERT INTO supplier_purchases(business_id, supplier_id, purchase_date, due_date,
                               total_amount, paid_amount, pending_amount, payment_status)
-- due_date SIEMPRE >= purchase_date (lo exige el CHECK del contrato M8-A).
-- Un tercio de las compras queda sin fecha acordada, que es el caso real.
SELECT :'biz', :'sup', public.ar_today() - (g % 200),
       CASE WHEN g % 3 = 0 THEN public.ar_today() - (g % 200) + (g % 220) ELSE NULL END,
       1000 + g, 0, 1000 + g, 'pending'
FROM generate_series(1, 3000) g;

INSERT INTO inventory_movements(business_id, inventory_item_id, movement_type,
                               quantity, previous_stock, new_stock, created_at)
SELECT :'biz', i.id, 'sale', -1, 10, 9, now() - ((i.n % 300) || ' days')::interval
FROM (SELECT id, row_number() OVER () AS n FROM inventory
       WHERE business_id = '00000000-0000-0000-0000-0000000fe001' LIMIT 5000) i;

INSERT INTO recurring_expenses(business_id, name, type, category, amount, currency,
                               day_of_month, is_active)
SELECT :'biz', 'Fijo '||g, 'fixed_cost_local', 'servicios', 50000, 'ARS', 1 + (g % 28), true
FROM generate_series(1, 12) g;

INSERT INTO exchange_rates(business_id, base_currency, target_currency, rate, updated_at)
  VALUES (:'biz','USD','ARS', 1541, now());
SET LOCAL session_replication_role='origin';

ANALYZE inventory;
ANALYZE supplier_purchases;
ANALYZE inventory_movements;

-- La generacion se invoca a NIVEL PSQL, nunca dentro de un DO: entrar a una
-- SECURITY DEFINER con el rol cambiado dentro de un DO crashea el backend en
-- postgres:17.6.1.104 (mismo build que produccion).
CREATE TEMP TABLE perf_out(tag text, j jsonb, wall_ms numeric);
GRANT ALL ON perf_out TO PUBLIC;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000fe009';

INSERT INTO perf_out
SELECT 'run1', public.generate_finance_insights(
  '00000000-0000-0000-0000-0000000fe001',
  date_trunc('month', public.ar_today())::date, public.ar_today()), NULL;

INSERT INTO perf_out
SELECT 'run2', public.generate_finance_insights(
  '00000000-0000-0000-0000-0000000fe001',
  date_trunc('month', public.ar_today())::date, public.ar_today()), NULL;

INSERT INTO perf_out
SELECT 'read', public.finance_insights_read(
  '00000000-0000-0000-0000-0000000fe001',
  date_trunc('month', public.ar_today())::date, public.ar_today(), 'active', 3), NULL;

RESET ROLE;

DO $$
DECLARE r record; v_ev_bytes int;
BEGIN
  FOR r IN SELECT tag, j FROM perf_out ORDER BY tag LOOP
    IF r.tag = 'read' THEN
      RAISE NOTICE 'PERF % -> insights devueltos: %', r.tag,
        jsonb_array_length(COALESCE(r.j->'insights','[]'::jsonb));
    ELSE
      RAISE NOTICE 'PERF % -> ok=% duration_ms=% fired=% skipped=%',
        r.tag, r.j->>'ok', r.j->>'duration_ms',
        r.j->>'fired', jsonb_array_length(COALESCE(r.j->'skipped','[]'::jsonb));
    END IF;
  END LOOP;

  SELECT COALESCE(MAX(pg_column_size(evidence)),0) INTO v_ev_bytes FROM finance_insights;
  RAISE NOTICE 'PERF evidence mas grande: % bytes', v_ev_bytes;

  RAISE NOTICE 'PERF volumen: % productos, % compras, % movimientos, % insights',
    (SELECT count(*) FROM inventory WHERE business_id='00000000-0000-0000-0000-0000000fe001'),
    (SELECT count(*) FROM supplier_purchases WHERE business_id='00000000-0000-0000-0000-0000000fe001'),
    (SELECT count(*) FROM inventory_movements WHERE business_id='00000000-0000-0000-0000-0000000fe001'),
    (SELECT count(*) FROM finance_insights WHERE business_id='00000000-0000-0000-0000-0000000fe001');
END $$;

ROLLBACK;
