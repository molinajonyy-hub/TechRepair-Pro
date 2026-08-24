-- ============================================================================
-- P0-P6 — Autorización por capacidad, contrato del servidor
--
-- Corre contra el stack LOCAL o una branch (NUNCA producción), con la
-- migración 20260826120000 aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/p0p6_capability_rbac.test.sql
--
-- Lo que se asevera, y por qué importa: el aislamiento de TENANT ya estaba
-- cerrado, pero el de CAPACIDAD no. Un tech del negocio A no veía al negocio B
-- —correcto— y sin embargo podía leer TODA la información financiera de SU
-- propio negocio llamando a PostgREST directamente. Estos tests miden las dos
-- dimensiones por separado.
--
-- CLAVE: los SELECT se ejecutan con `SET LOCAL ROLE authenticated`, así que la
-- RLS se aplica de verdad. Correr como `postgres` (dueño de las tablas) la
-- saltearía por completo y todo daría falso verde.
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
  v_cash_a  uuid := gen_random_uuid();
  v_sales_a uuid := gen_random_uuid();
  v_over_a  uuid := gen_random_uuid();
  v_owner_b uuid := gen_random_uuid();
  v_biz_a   uuid;
  v_biz_b   uuid;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    (v_owner_a,'p6_owner_a@invalid.test',now()), (v_admin_a,'p6_admin_a@invalid.test',now()),
    (v_tech_a,'p6_tech_a@invalid.test',now()),   (v_cash_a,'p6_cash_a@invalid.test',now()),
    (v_sales_a,'p6_sales_a@invalid.test',now()), (v_over_a,'p6_over_a@invalid.test',now()),
    (v_owner_b,'p6_owner_b@invalid.test',now());

  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Taller A', v_owner_a) RETURNING id INTO v_biz_a;
  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Taller B', v_owner_b) RETURNING id INTO v_biz_b;

  -- `id = auth.uid()` y `user_id` NULL: la forma REAL que producen
  -- provision_my_business y accept_business_invitation.
  INSERT INTO public.profiles (id, business_id, role, is_active, email) VALUES
    (v_owner_a, v_biz_a, 'owner',   true, 'p6_owner_a@invalid.test'),
    (v_admin_a, v_biz_a, 'admin',   true, 'p6_admin_a@invalid.test'),
    (v_tech_a,  v_biz_a, 'tech',    true, 'p6_tech_a@invalid.test'),
    (v_cash_a,  v_biz_a, 'cashier', true, 'p6_cash_a@invalid.test'),
    (v_sales_a, v_biz_a, 'sales',   true, 'p6_sales_a@invalid.test'),
    (v_owner_b, v_biz_b, 'owner',   true, 'p6_owner_b@invalid.test');

  -- Tech con override EXPLÍCITO de finance: el owner se lo habilitó a mano.
  INSERT INTO public.profiles (id, business_id, role, is_active, email, permissions) VALUES
    (v_over_a, v_biz_a, 'tech', true, 'p6_over_a@invalid.test', '{"finance": true}'::jsonb);

  -- Datos financieros en A y en B.
  -- `currency` y `amount` son NOT NULL sin default: hay que darlos explícitos.
  INSERT INTO public.financial_movements (business_id, type, currency, amount, amount_ars, metodo_pago)
  -- `type` sólo admite 'income' | 'expense' (no 'ingreso').
  VALUES (v_biz_a,'income','ARS',150000,150000,'efectivo'),
         (v_biz_b,'income','ARS',999999,999999,'efectivo');

  PERFORM set_config('test.owner_a',v_owner_a::text,false);
  PERFORM set_config('test.admin_a',v_admin_a::text,false);
  PERFORM set_config('test.tech_a', v_tech_a::text, false);
  PERFORM set_config('test.cash_a', v_cash_a::text, false);
  PERFORM set_config('test.sales_a',v_sales_a::text,false);
  PERFORM set_config('test.over_a', v_over_a::text, false);
  PERFORM set_config('test.owner_b',v_owner_b::text,false);
  PERFORM set_config('test.biz_a',  v_biz_a::text,  false);
  RAISE NOTICE 'Fixtures OK · A=% · B=%', v_biz_a, v_biz_b;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- A · current_user_can — defaults por rol
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_bad text := '';
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  IF NOT public.current_user_can('finance')  THEN v_bad := v_bad||' owner.finance'; END IF;
  IF NOT public.current_user_can('users')    THEN v_bad := v_bad||' owner.users'; END IF;
  -- El owner es superusuario del tenant: incluso una clave nueva le da true.
  IF NOT public.current_user_can('wholesale') THEN v_bad := v_bad||' owner.wholesale'; END IF;
  -- PERO Mi Guita está cerrado para la beta incluso para el owner: su acceso
  -- interno es un privilegio del SaaS (system_admins), no del tenant.
  IF public.current_user_can('personal_finance') THEN v_bad := v_bad||' owner.personal_finance'; END IF;

  PERFORM pg_temp.como(current_setting('test.admin_a')::uuid);
  IF NOT public.current_user_can('finance')      THEN v_bad := v_bad||' admin.finance'; END IF;
  IF     public.current_user_can('subscription') THEN v_bad := v_bad||' admin.subscription'; END IF;

  PERFORM pg_temp.como(current_setting('test.tech_a')::uuid);
  IF NOT public.current_user_can('orders')             THEN v_bad := v_bad||' tech.orders'; END IF;
  IF     public.current_user_can('finance')            THEN v_bad := v_bad||' tech.finance'; END IF;
  IF     public.current_user_can('comprobantes')       THEN v_bad := v_bad||' tech.comprobantes'; END IF;
  IF     public.current_user_can('inventory_view_costs') THEN v_bad := v_bad||' tech.costs'; END IF;
  IF     public.current_user_can('wholesale')          THEN v_bad := v_bad||' tech.wholesale'; END IF;
  IF     public.current_user_can('personal_finance')   THEN v_bad := v_bad||' tech.personal'; END IF;
  IF     public.current_user_can('reports')            THEN v_bad := v_bad||' tech.reports'; END IF;

  PERFORM pg_temp.como(current_setting('test.cash_a')::uuid);
  IF NOT public.current_user_can('finance')  THEN v_bad := v_bad||' cashier.finance'; END IF;

  PERFORM pg_temp.como(current_setting('test.sales_a')::uuid);
  IF     public.current_user_can('finance')       THEN v_bad := v_bad||' sales.finance'; END IF;
  IF NOT public.current_user_can('comprobantes')  THEN v_bad := v_bad||' sales.comprobantes'; END IF;

  -- Clave desconocida -> fail-closed (para todos menos owner).
  PERFORM pg_temp.como(current_setting('test.tech_a')::uuid);
  IF public.current_user_can('inventada_xyz') THEN v_bad := v_bad||' tech.clave_desconocida'; END IF;

  PERFORM set_config('request.jwt.claims','',true);
  IF v_bad <> '' THEN RAISE EXCEPTION 'A FAIL:%', v_bad; END IF;
  RAISE NOTICE 'A OK · defaults por rol correctos, clave desconocida fail-closed';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- B · overrides explícitos
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_bad text := '';
BEGIN
  PERFORM pg_temp.como(current_setting('test.over_a')::uuid);
  -- El override habilita SÓLO lo habilitado.
  IF NOT public.current_user_can('finance') THEN v_bad := v_bad||' override.finance'; END IF;
  -- Y no escala colateralmente a otras capacidades.
  IF public.current_user_can('users')                THEN v_bad := v_bad||' override.users'; END IF;
  IF public.current_user_can('settings_sensitive')   THEN v_bad := v_bad||' override.settings'; END IF;
  IF public.current_user_can('inventory_view_costs') THEN v_bad := v_bad||' override.costs'; END IF;
  PERFORM set_config('request.jwt.claims','',true);

  IF v_bad <> '' THEN RAISE EXCEPTION 'B FAIL:%', v_bad; END IF;
  RAISE NOTICE 'B OK · el override habilita sólo su capacidad, sin escalar';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- C · LECTURA DIRECTA — el corazón del lote
--     Se consulta como `authenticated` para que la RLS se aplique de verdad.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tech int; v_owner int; v_admin int; v_cash int; v_sales int; v_over int; v_b int;
BEGIN
  SET LOCAL ROLE authenticated;

  PERFORM pg_temp.como(current_setting('test.tech_a')::uuid);
  SELECT count(*) INTO v_tech FROM public.financial_movements;

  PERFORM pg_temp.como(current_setting('test.sales_a')::uuid);
  SELECT count(*) INTO v_sales FROM public.financial_movements;

  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  SELECT count(*) INTO v_owner FROM public.financial_movements;

  PERFORM pg_temp.como(current_setting('test.admin_a')::uuid);
  SELECT count(*) INTO v_admin FROM public.financial_movements;

  PERFORM pg_temp.como(current_setting('test.cash_a')::uuid);
  SELECT count(*) INTO v_cash FROM public.financial_movements;

  PERFORM pg_temp.como(current_setting('test.over_a')::uuid);
  SELECT count(*) INTO v_over FROM public.financial_movements;

  PERFORM pg_temp.como(current_setting('test.owner_b')::uuid);
  SELECT count(*) INTO v_b FROM public.financial_movements;

  RESET ROLE;
  PERFORM set_config('request.jwt.claims','',true);

  -- 1,2,3 · el tech NO ve movimientos financieros ni llamando directo.
  IF v_tech <> 0 THEN
    RAISE EXCEPTION 'C FAIL: el tech leyó % movimientos financieros por consulta directa', v_tech; END IF;
  -- `sales` tampoco: no tiene la capacidad `finance`.
  IF v_sales <> 0 THEN
    RAISE EXCEPTION 'C FAIL: sales leyó % movimientos financieros', v_sales; END IF;

  -- 6 · owner, admin y cashier SÍ (no se rompe la operación legítima).
  IF v_owner <> 1 THEN RAISE EXCEPTION 'C FAIL: el owner ve % en vez de 1', v_owner; END IF;
  IF v_admin <> 1 THEN RAISE EXCEPTION 'C FAIL: el admin ve % en vez de 1', v_admin; END IF;
  IF v_cash  <> 1 THEN RAISE EXCEPTION 'C FAIL: el cashier ve % en vez de 1', v_cash; END IF;

  -- El override habilita la lectura real, no sólo el helper.
  IF v_over <> 1 THEN RAISE EXCEPTION 'C FAIL: el tech con override ve % en vez de 1', v_over; END IF;

  -- 7 · TENANT: el owner de B ve lo suyo y nada de A.
  IF v_b <> 1 THEN RAISE EXCEPTION 'C FAIL: el owner de B ve % en vez de 1 (el suyo)', v_b; END IF;

  RAISE NOTICE 'C OK · tech/sales 0 filas; owner/admin/cashier/override 1; tenant intacto';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- D · las vistas financieras heredan el gate (security_invoker)
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_tech int; v_owner int; v_n int;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.como(current_setting('test.tech_a')::uuid);
  SELECT count(*) INTO v_tech FROM public.v_finance_pnl;
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  SELECT count(*) INTO v_owner FROM public.v_finance_pnl;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','',true);

  IF v_tech <> 0 THEN
    RAISE EXCEPTION 'D FAIL: el tech leyó % filas de v_finance_pnl', v_tech; END IF;

  -- Y siguen siendo security_invoker: sin eso ejecutarían como postgres y
  -- saltearían la RLS que acabamos de endurecer.
  SELECT count(*) INTO v_n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname IN ('v_finance_pnl','v_finance_position','v_finance_product_margin')
     AND NOT (coalesce(array_to_string(c.reloptions,','),'') LIKE '%security_invoker=true%');
  IF v_n > 0 THEN RAISE EXCEPTION 'D FAIL: % vistas sin security_invoker', v_n; END IF;

  RAISE NOTICE 'D OK · las vistas heredan el gate (tech 0 filas)';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- E · cobros de comprobantes: gate por `comprobantes`, no por `finance`
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_pol text;
BEGIN
  SELECT coalesce(qual,'') INTO v_pol FROM pg_policies
   WHERE schemaname='public' AND tablename='comprobante_payments' AND cmd='SELECT';

  IF v_pol NOT LIKE '%current_user_can%' THEN
    RAISE EXCEPTION 'E FAIL: comprobante_payments sin chequeo de capacidad'; END IF;
  -- Gatearlo con `finance` habría roto la venta para sales y manager.
  IF v_pol NOT LIKE '%comprobantes%' THEN
    RAISE EXCEPTION 'E FAIL: comprobante_payments no usa la capacidad comprobantes'; END IF;

  RAISE NOTICE 'E OK · comprobante_payments gateado por comprobantes (POS intacto)';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- F · SaaS admin: privilegio separado del tenant y NO auto-otorgable
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_n int; v_owner_es_admin int;
BEGIN
  -- 9 · un owner normal NO tiene privilegios SaaS.
  SELECT count(*) INTO v_owner_es_admin FROM public.system_admins
   WHERE user_id = current_setting('test.owner_a')::uuid;
  IF v_owner_es_admin <> 0 THEN
    RAISE EXCEPTION 'F FAIL: un owner normal figura en system_admins'; END IF;

  -- 8/11 · y el cliente no puede escribirse a sí mismo dentro.
  SELECT count(*) INTO v_n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='system_admins'
     AND grantee IN ('anon','authenticated')
     AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'F FAIL: el cliente puede escribir system_admins (% grants)', v_n; END IF;

  RAISE NOTICE 'F OK · SaaS admin separado del tenant y no auto-otorgable';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- G · estructura: sin policies laxas, ACL mínima, invariantes previas intactas
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_n int; v_def text;
BEGIN
  -- 12 · ninguna policy de SELECT financiera puede filtrar sólo por tenant.
  --      Dos permissive se combinan con OR: la más laxa gana.
  FOR v_def IN
    SELECT tablename||'.'||policyname||' :: '||coalesce(qual,'')
      FROM pg_policies
     WHERE schemaname='public'
       AND tablename IN ('financial_movements','business_finance_entries','comprobante_payments')
       AND cmd='SELECT'
  LOOP
    IF v_def NOT LIKE '%current_user_can%' THEN
      RAISE EXCEPTION 'G FAIL: policy sin capacidad -> %', v_def; END IF;
  END LOOP;

  FOR v_def IN SELECT unnest(ARRAY['financial_movements','business_finance_entries','comprobante_payments'])
  LOOP
    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname='public' AND tablename=v_def AND cmd='SELECT';
    IF v_n <> 1 THEN RAISE EXCEPTION 'G FAIL: % tiene % policies de SELECT', v_def, v_n; END IF;
  END LOOP;

  -- 10 · anon/PUBLIC sin EXECUTE sobre el helper.
  IF has_function_privilege('anon','public.current_user_can(text)','EXECUTE')
     OR has_function_privilege('public','public.current_user_can(text)','EXECUTE') THEN
    RAISE EXCEPTION 'G FAIL: anon/PUBLIC pueden ejecutar current_user_can'; END IF;

  -- 11 · el cliente sigue sin DML estructural (invariante de P0-P1/P2/P5).
  SELECT count(*) INTO v_n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name IN ('profiles','businesses')
     AND grantee IN ('anon','authenticated')
     AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
  IF v_n <> 0 THEN RAISE EXCEPTION 'G FAIL: % grants de DML repuestos', v_n; END IF;

  -- Y la autoridad de provisioning no se tocó.
  IF to_regprocedure('public.provision_my_business(text)') IS NULL THEN
    RAISE EXCEPTION 'G FAIL: desapareció provision_my_business'; END IF;

  RAISE NOTICE 'G OK · una policy por tabla, ACL mínima, invariantes previas intactas';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- H · sin sesión, fail-closed
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_n int;
BEGIN
  PERFORM set_config('request.jwt.claims','',true);
  IF public.current_user_can('orders') THEN
    RAISE EXCEPTION 'H FAIL: sin sesión current_user_can devolvió true'; END IF;

  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.financial_movements;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'H FAIL: sin sesión se leyeron % movimientos', v_n; END IF;

  RAISE NOTICE 'H OK · sin sesión, cero capacidades y cero filas';
END $$;

ROLLBACK;
