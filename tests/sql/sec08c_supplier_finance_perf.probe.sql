-- ============================================================================
-- SEC-08C - SONDA DE PLAN de las vistas de proveedor. NO es un gate.
--
--   docker cp tests/sql/sec08c_supplier_finance_perf.probe.sql \
--     supabase_db_techrepair-vite:/tmp/p.sql
--   docker exec supabase_db_techrepair-vite psql -U postgres -d postgres -f /tmp/p.sql
--
-- Todo ocurre dentro de UNA transaccion que termina en ROLLBACK.
--
-- POR QUE EXISTE
--
-- SEC-08C reescribe las policies de lectura de proveedor y agrega dos vistas
-- de finanzas. La clase de defecto que hizo expirar a get_finance_charts_l1 en
-- produccion (57014) fue EVALUACION REPETIDA DEL HELPER DE RLS por fila, asi
-- que la pregunta no es "cuanto tarda" sino "como escala".
--
-- Se mide COMO authenticated y CON filtro de tenant, que es la forma real: sin
-- el filtro el planner elige otro plan y la medicion no dice nada del producto.
-- Medir como `postgres` no sirve: el superusuario no pasa por RLS.
--
-- MEDICION DE REFERENCIA (Docker local, 2026-09-04)
--
--   400 proveedores /  4.000 compras : stats 345 ms · debt 225 ms
--   800 proveedores /  8.000 compras : stats 766 ms · debt 414 ms
--                                      (x2,22 y x1,84 al duplicar el volumen)
--
-- Conclusion: LINEAL. ~53 us por fila, que es procesamiento de filas. Si la
-- autoridad se evaluara de nuevo en cada fila el tiempo estaria en decenas de
-- SEGUNDOS: una llamada plpgsql cuesta ~9 ms en este contenedor. No hay
-- subconsulta correlacionada, ni anti-join cuadratico, ni N+1.
--
-- El reloj NO es comparable entre maquinas (este Docker es ~2 ordenes de
-- magnitud mas lento por llamada plpgsql que produccion). Lo que se mira es la
-- RELACION entre volumenes: duplicar N tiene que duplicar el tiempo, no
-- cuadruplicarlo. Cambiar :n abajo permite repetir la comparacion.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off
\set n 400

BEGIN;
SET LOCAL session_replication_role = replica;

CREATE TEMP TABLE t_ids(k text primary key, v uuid);
INSERT INTO t_ids VALUES ('biz', gen_random_uuid()), ('owner', gen_random_uuid()), ('mgr', gen_random_uuid());
-- El rol authenticated tiene que poder leer los ids del fixture.
GRANT SELECT ON t_ids TO authenticated;

INSERT INTO auth.users(id,email,email_confirmed_at)
SELECT v, k||'@perf08c.invalid', now() FROM t_ids WHERE k IN ('owner','mgr');
INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status)
SELECT (SELECT v FROM t_ids WHERE k='biz'),'B-perf',(SELECT v FROM t_ids WHERE k='owner'),'pro','active';
-- El actor de la medicion es `manager`: tiene inventory_view_costs, asi que
-- pasa la autoridad y el plan recorre el camino COMPLETO. Medir con un actor
-- sin autoridad daria un plan corto y un verde enganoso.
INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES
  ((SELECT v FROM t_ids WHERE k='owner'),(SELECT v FROM t_ids WHERE k='biz'),'owner',true,'o@perf08c.invalid'),
  ((SELECT v FROM t_ids WHERE k='mgr'),(SELECT v FROM t_ids WHERE k='biz'),'manager',true,'m@perf08c.invalid');

INSERT INTO public.suppliers(id,business_id,name,active)
SELECT gen_random_uuid(),(SELECT v FROM t_ids WHERE k='biz'),'Prov-'||g,true
FROM generate_series(1,:n) g;

INSERT INTO public.supplier_purchases(id,business_id,supplier_id,purchase_date,total_amount,paid_amount,pending_amount,payment_status)
SELECT gen_random_uuid(), s.business_id, s.id, current_date - (g % 90), 1000+g, 100+g, 900, 'partial'
FROM public.suppliers s CROSS JOIN generate_series(1,10) g
WHERE s.business_id=(SELECT v FROM t_ids WHERE k='biz');

ANALYZE public.suppliers;
ANALYZE public.supplier_purchases;
SET LOCAL session_replication_role = origin;

\echo ''
\echo '=== Volumen ==='
SELECT (SELECT count(*) FROM public.suppliers WHERE business_id=(SELECT v FROM t_ids WHERE k='biz')) AS proveedores,
       (SELECT count(*) FROM public.supplier_purchases WHERE business_id=(SELECT v FROM t_ids WHERE k='biz')) AS compras;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub',(SELECT v FROM t_ids WHERE k='mgr')::text,'role','authenticated')::text, true);

\echo ''
\echo '=== v_finance_supplier_stats ==='
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT * FROM public.v_finance_supplier_stats WHERE business_id = (SELECT v FROM t_ids WHERE k='biz');

\echo ''
\echo '=== v_finance_supplier_debt ==='
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT * FROM public.v_finance_supplier_debt WHERE business_id = (SELECT v FROM t_ids WHERE k='biz');

RESET ROLE;
ROLLBACK;
