-- ============================================================================
-- P0-P6 · CIERRE FINAL — lectura de `public.cajas` por capacidad
--
-- Corre contra el stack LOCAL o una branch (NUNCA producción), con la
-- migración 20260827120000 aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/p0p6_cajas_capability.test.sql
--
-- Contrato que se asevera:
--
--     business_id = current_user_business_id()
--     AND ( current_user_can('finance') OR current_user_can('comprobantes') )
--
-- La rama `comprobantes` NO es un descuido: un `sales` tiene `finance = false`
-- y necesita conocer la caja abierta porque el POS manda `caja_id` al crear el
-- comprobante. Sin ella seguiría vendiendo, pero con `caja_id = NULL` y sus
-- ventas quedarían fuera del arqueo.
--
-- CLAVE: todos los SELECT corren con `SET LOCAL ROLE authenticated`, así que la
-- RLS se aplica de verdad. Como `postgres` (dueño de la tabla) la saltearía por
-- completo y todo daría falso verde.
--
-- Todo en UNA transacción que termina en ROLLBACK.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.como(p_uid uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, true);
END $$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner_a uuid := gen_random_uuid();
  v_admin_a uuid := gen_random_uuid();
  v_tech_a  uuid := gen_random_uuid();
  v_sales_a uuid := gen_random_uuid();
  v_cash_a  uuid := gen_random_uuid();
  v_view_a  uuid := gen_random_uuid();
  v_techf_a uuid := gen_random_uuid();   -- tech con override finance:true
  v_salesn  uuid := gen_random_uuid();   -- sales con override comprobantes:false
  v_owner_b uuid := gen_random_uuid();
  v_biz_a   uuid;
  v_biz_b   uuid;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    (v_owner_a,'c_owner_a@invalid.test',now()), (v_admin_a,'c_admin_a@invalid.test',now()),
    (v_tech_a,'c_tech_a@invalid.test',now()),   (v_sales_a,'c_sales_a@invalid.test',now()),
    (v_cash_a,'c_cash_a@invalid.test',now()),   (v_view_a,'c_view_a@invalid.test',now()),
    (v_techf_a,'c_techf_a@invalid.test',now()), (v_salesn,'c_salesn_a@invalid.test',now()),
    (v_owner_b,'c_owner_b@invalid.test',now());

  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Taller A', v_owner_a) RETURNING id INTO v_biz_a;
  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Taller B', v_owner_b) RETURNING id INTO v_biz_b;

  -- `id = auth.uid()` con `user_id` NULL: la forma REAL que producen
  -- provision_my_business y accept_business_invitation.
  INSERT INTO public.profiles (id, business_id, role, is_active, email) VALUES
    (v_owner_a, v_biz_a, 'owner',   true, 'c_owner_a@invalid.test'),
    (v_admin_a, v_biz_a, 'admin',   true, 'c_admin_a@invalid.test'),
    (v_tech_a,  v_biz_a, 'tech',    true, 'c_tech_a@invalid.test'),
    (v_sales_a, v_biz_a, 'sales',   true, 'c_sales_a@invalid.test'),
    (v_cash_a,  v_biz_a, 'cashier', true, 'c_cash_a@invalid.test'),
    (v_view_a,  v_biz_a, 'viewer',  true, 'c_view_a@invalid.test'),
    (v_owner_b, v_biz_b, 'owner',   true, 'c_owner_b@invalid.test');

  INSERT INTO public.profiles (id, business_id, role, is_active, email, permissions) VALUES
    (v_techf_a, v_biz_a, 'tech',  true, 'c_techf_a@invalid.test', '{"finance": true}'::jsonb),
    (v_salesn,  v_biz_a, 'sales', true, 'c_salesn_a@invalid.test', '{"comprobantes": false}'::jsonb);

  -- Una caja ABIERTA en cada negocio: la que el POS tiene que resolver.
  INSERT INTO public.cajas (business_id, status) VALUES (v_biz_a, 'abierta'), (v_biz_b, 'abierta');
  -- Y una cerrada en A, para que «ver cajas» no sea sólo «ver la abierta».
  INSERT INTO public.cajas (business_id, status) VALUES (v_biz_a, 'cerrada');

  PERFORM set_config('test.owner_a',v_owner_a::text,false);
  PERFORM set_config('test.admin_a',v_admin_a::text,false);
  PERFORM set_config('test.tech_a', v_tech_a::text, false);
  PERFORM set_config('test.sales_a',v_sales_a::text,false);
  PERFORM set_config('test.cash_a', v_cash_a::text, false);
  PERFORM set_config('test.view_a', v_view_a::text, false);
  PERFORM set_config('test.techf_a',v_techf_a::text,false);
  PERFORM set_config('test.salesn', v_salesn::text, false);
  PERFORM set_config('test.owner_b',v_owner_b::text,false);
  PERFORM set_config('test.biz_a',  v_biz_a::text,  false);
  PERFORM set_config('test.biz_b',  v_biz_b::text,  false);
  RAISE NOTICE 'Fixtures OK · A=% (2 cajas) · B=% (1 caja)', v_biz_a, v_biz_b;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- A · DENEGADOS — tech default y viewer no leen NADA
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_tech int; v_view int; v_salesn int;
BEGIN
  SET LOCAL ROLE authenticated;

  PERFORM pg_temp.como(current_setting('test.tech_a')::uuid);
  SELECT count(*) INTO v_tech FROM public.cajas;

  PERFORM pg_temp.como(current_setting('test.view_a')::uuid);
  SELECT count(*) INTO v_view FROM public.cajas;

  -- sales al que le QUITARON `comprobantes` y que tampoco tiene `finance`.
  PERFORM pg_temp.como(current_setting('test.salesn')::uuid);
  SELECT count(*) INTO v_salesn FROM public.cajas;

  RESET ROLE;
  PERFORM set_config('request.jwt.claims','',true);

  IF v_tech <> 0 THEN
    RAISE EXCEPTION 'A FAIL: el tech leyó % cajas por consulta directa', v_tech; END IF;
  IF v_view <> 0 THEN
    RAISE EXCEPTION 'A FAIL: el viewer leyó % cajas', v_view; END IF;
  IF v_salesn <> 0 THEN
    RAISE EXCEPTION 'A FAIL: un sales sin comprobantes ni finance leyó % cajas', v_salesn; END IF;

  RAISE NOTICE 'A OK · tech, viewer y sales-sin-capacidad: 0 filas';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- B · PERMITIDOS — owner, admin, cashier (finance) dentro de SU tenant
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_owner int; v_admin int; v_cash int;
BEGIN
  SET LOCAL ROLE authenticated;

  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  SELECT count(*) INTO v_owner FROM public.cajas;

  PERFORM pg_temp.como(current_setting('test.admin_a')::uuid);
  SELECT count(*) INTO v_admin FROM public.cajas;

  PERFORM pg_temp.como(current_setting('test.cash_a')::uuid);
  SELECT count(*) INTO v_cash FROM public.cajas;

  RESET ROLE;
  PERFORM set_config('request.jwt.claims','',true);

  -- 2 cajas en A (una abierta, una cerrada). La de B no se cuenta: tenant.
  IF v_owner <> 2 THEN RAISE EXCEPTION 'B FAIL: el owner ve % cajas, se esperaban 2', v_owner; END IF;
  IF v_admin <> 2 THEN RAISE EXCEPTION 'B FAIL: el admin ve % cajas, se esperaban 2', v_admin; END IF;
  IF v_cash  <> 2 THEN RAISE EXCEPTION 'B FAIL: el cashier ve % cajas, se esperaban 2', v_cash; END IF;

  RAISE NOTICE 'B OK · owner, admin y cashier ven las 2 cajas de SU negocio';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- C · REGRESIÓN CRÍTICA DEL POS
--     Un `sales` (finance=false, comprobantes=true) tiene que poder RESOLVER
--     la caja abierta. Es literalmente la consulta que hace CajaContext.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_finance boolean; v_compro boolean;
  v_caja_id uuid; v_total int; v_ajenas int;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.como(current_setting('test.sales_a')::uuid);

  v_finance := public.current_user_can('finance');
  v_compro  := public.current_user_can('comprobantes');

  -- La MISMA consulta de CajaContext.refresh(): la caja abierta del negocio.
  SELECT id INTO v_caja_id
    FROM public.cajas
   WHERE business_id = current_setting('test.biz_a')::uuid
     AND status = 'abierta'
   ORDER BY opened_at DESC
   LIMIT 1;

  SELECT count(*) INTO v_total   FROM public.cajas;
  SELECT count(*) INTO v_ajenas  FROM public.cajas
   WHERE business_id = current_setting('test.biz_b')::uuid;

  RESET ROLE;
  PERFORM set_config('request.jwt.claims','',true);

  -- El supuesto que hace crítica a esta prueba.
  IF v_finance THEN RAISE EXCEPTION 'C FAIL(setup): el sales tiene finance, el caso no aplica'; END IF;
  IF NOT v_compro THEN RAISE EXCEPTION 'C FAIL(setup): el sales no tiene comprobantes'; END IF;

  -- LO QUE IMPORTA: el POS resuelve la caja abierta.
  IF v_caja_id IS NULL THEN
    RAISE EXCEPTION 'C FAIL: el sales NO resuelve la caja abierta -> el POS mandaría caja_id NULL y la venta quedaría fuera del arqueo';
  END IF;

  IF v_total <> 2 THEN RAISE EXCEPTION 'C FAIL: el sales ve % cajas, se esperaban 2', v_total; END IF;
  IF v_ajenas <> 0 THEN RAISE EXCEPTION 'C FAIL: el sales ve % cajas de otro negocio', v_ajenas; END IF;

  RAISE NOTICE 'C OK · POS intacto: sales sin finance resuelve la caja abierta (%), y 0 ajenas', v_caja_id;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- D · OVERRIDES explícitos
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_techf int; v_can boolean;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.como(current_setting('test.techf_a')::uuid);
  v_can := public.current_user_can('finance');
  SELECT count(*) INTO v_techf FROM public.cajas;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','',true);

  IF NOT v_can THEN RAISE EXCEPTION 'D FAIL: el override finance:true no se aplicó'; END IF;
  IF v_techf <> 2 THEN
    RAISE EXCEPTION 'D FAIL: el tech con override ve % cajas, se esperaban 2', v_techf; END IF;

  RAISE NOTICE 'D OK · tech con finance:true accede; sales con comprobantes:false no (caso A)';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- E · CROSS-TENANT — capacidad NO es permiso para ver otro negocio
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_a_ve_b int; v_b_ve_a int; v_b_total int;
BEGIN
  SET LOCAL ROLE authenticated;

  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  SELECT count(*) INTO v_a_ve_b FROM public.cajas
   WHERE business_id = current_setting('test.biz_b')::uuid;

  PERFORM pg_temp.como(current_setting('test.owner_b')::uuid);
  SELECT count(*) INTO v_b_ve_a FROM public.cajas
   WHERE business_id = current_setting('test.biz_a')::uuid;
  SELECT count(*) INTO v_b_total FROM public.cajas;

  RESET ROLE;
  PERFORM set_config('request.jwt.claims','',true);

  IF v_a_ve_b <> 0 THEN RAISE EXCEPTION 'E FAIL: el owner de A ve % cajas de B', v_a_ve_b; END IF;
  IF v_b_ve_a <> 0 THEN RAISE EXCEPTION 'E FAIL: el owner de B ve % cajas de A', v_b_ve_a; END IF;
  IF v_b_total <> 1 THEN RAISE EXCEPTION 'E FAIL: el owner de B ve % cajas, se esperaba 1', v_b_total; END IF;

  RAISE NOTICE 'E OK · cross-tenant cerrado en las dos direcciones';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- F · SIN SESIÓN — fail closed
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_n int;
BEGIN
  PERFORM set_config('request.jwt.claims','',true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.cajas;
  RESET ROLE;

  IF v_n <> 0 THEN RAISE EXCEPTION 'F FAIL: sin sesión se leyeron % cajas', v_n; END IF;
  RAISE NOTICE 'F OK · sin sesión, 0 filas';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- G · ESTRUCTURA — sin permissive superpuestas ni vuelta a is_staff()
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_n int; v_pol text;
BEGIN
  -- Dos permissive se combinan con OR: la más laxa gana. Por eso «exactamente
  -- una» es parte del contrato y no una cuestión de prolijidad.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='cajas' AND cmd='SELECT';
  IF v_n <> 1 THEN RAISE EXCEPTION 'G FAIL: % policies de SELECT en cajas', v_n; END IF;

  SELECT coalesce(qual,'') INTO v_pol FROM pg_policies
   WHERE schemaname='public' AND tablename='cajas' AND cmd='SELECT';

  IF v_pol LIKE '%is_staff%' THEN
    RAISE EXCEPTION 'G FAIL: la policy volvió a is_staff() (= cualquiera de los 7 roles)'; END IF;
  IF v_pol NOT LIKE '%current_user_can%' THEN
    RAISE EXCEPTION 'G FAIL: la policy no chequea capacidad'; END IF;
  IF v_pol NOT LIKE '%comprobantes%' THEN
    RAISE EXCEPTION 'G FAIL: falta la rama comprobantes (rompería el POS)'; END IF;
  IF v_pol NOT LIKE '%current_user_business_id%' THEN
    RAISE EXCEPTION 'G FAIL: la policy perdió el filtro de tenant'; END IF;

  -- No se agregaron policies de escritura: abrir/cerrar caja sigue por RPC.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='cajas' AND cmd <> 'SELECT';
  IF v_n <> 0 THEN RAISE EXCEPTION 'G FAIL: % policies de escritura en cajas', v_n; END IF;

  -- Y las policies financieras de 20260826120000 siguen cerradas.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public'
     AND tablename IN ('financial_movements','business_finance_entries','comprobante_payments')
     AND cmd='SELECT' AND coalesce(qual,'') LIKE '%current_user_can%';
  IF v_n <> 3 THEN RAISE EXCEPTION 'G FAIL: % de 3 policies financieras con capacidad', v_n; END IF;

  RAISE NOTICE 'G OK · una sola policy, sin is_staff, tenant+capacidad, financieras intactas';
END $$;

ROLLBACK;
