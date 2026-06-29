-- ============================================================================
-- Caso E — Aislamiento RLS Portal Clic privado + Mayorista operativo
--
-- Corre contra una BRANCH de Supabase o el stack LOCAL (NUNCA producción):
--   supabase db reset --no-seed   # aplica baseline + migraciones Caso E
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/owner_portal_isolation.test.sql
--
-- Verifica (a nivel RLS, complementa tests/unit/entitlements.test.ts):
--   CASO 1  Owner de Clic: lee/inserta/actualiza clic_wholesale_product_settings;
--           es super_admin y tiene Mayorista+audit.
--   CASO 2  admin/manager/sales de Clic: NO leen ni modifican la config privada.
--   CASO 3  sales de Clic: SÍ opera wholesale_customers/orders/items.
--   CASO 4  tech/cashier/viewer de Clic: leen pero NO escriben; sin SaaS Admin.
--   CASO 5  Otro tenant Full: NO lee ni escribe data de Clic; sin SaaS Admin.
--   CASO 6  Otro tenant Full: mantiene su Mayorista genérico (su business_id).
--   CASO 7  Usuario sin feature Mayorista (plan pro): no accede.
--   CASO 8  service_role: comportamiento preservado — SELECT en businesses
--           intacto; BYPASSRLS NO otorga grant directo a tablas mayoristas.
--   CASO 9  Cliente externo (auth_user_id): policies cliente-facing intactas.
--   CASO 10 Guard de activación (ALLOWLIST fail-closed) — 12 escenarios:
--           owner/admin/authenticated-no-admin bloqueados; platform admin activo
--           permitido; platform admin inactivo bloqueado; service_role y postgres
--           permitidos; supabase_admin verificado; authenticator y rol arbitrario
--           con grant técnico bloqueados; otra columna y mismo valor permitidos.
--
-- Todo en una transacción; termina en ROLLBACK (no deja fixtures). Cada bloque
-- RAISEa ante fallo con etiqueta CASO N.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  -- Clic staff
  v_clic_owner uuid := gen_random_uuid();
  v_clic_admin uuid := gen_random_uuid();
  v_clic_mgr   uuid := gen_random_uuid();
  v_clic_sales uuid := gen_random_uuid();
  v_clic_tech  uuid := gen_random_uuid();
  v_clic_cash  uuid := gen_random_uuid();
  v_clic_view  uuid := gen_random_uuid();
  v_clic_cust  uuid := gen_random_uuid();   -- cliente externo (mayorista)
  -- Otros tenants
  v_other_own  uuid := gen_random_uuid();   -- Full, sin portal
  v_nofeat_own uuid := gen_random_uuid();   -- pro, sin feature mayorista
  v_inact_admin uuid := gen_random_uuid();  -- system admin INACTIVO (guard test)
  -- Negocios
  v_clic   uuid := gen_random_uuid();
  v_other  uuid := gen_random_uuid();
  v_nofeat uuid := gen_random_uuid();
  v_inact_biz uuid := gen_random_uuid();
  -- Inventario / settings / mayorista
  v_clic_inv1 uuid := gen_random_uuid();
  v_clic_inv2 uuid := gen_random_uuid();
  v_wc_clic   uuid := gen_random_uuid();
  v_wc_other  uuid := gen_random_uuid();
  v_wo_clic   uuid := gen_random_uuid();
  v_woi_clic  uuid := gen_random_uuid();
  -- Scratch
  v_cnt    int;
  v_role   text;
  v_uid    uuid;
  v_lbl    text;
  v_blocked boolean;
  v_tmp    uuid;
  v_def    text;
BEGIN
  -- ── Fixtures (como postgres: RLS bypass) ──────────────────────────────────
  INSERT INTO auth.users (id, email) VALUES
    (v_clic_owner,'clic_owner_t@example.com'), (v_clic_admin,'clic_admin_t@example.com'),
    (v_clic_mgr,'clic_mgr_t@example.com'),     (v_clic_sales,'clic_sales_t@example.com'),
    (v_clic_tech,'clic_tech_t@example.com'),   (v_clic_cash,'clic_cash_t@example.com'),
    (v_clic_view,'clic_view_t@example.com'),   (v_clic_cust,'clic_cust_t@example.com'),
    (v_other_own,'other_own_t@example.com'),   (v_nofeat_own,'nofeat_own_t@example.com'),
    (v_inact_admin,'inact_admin_t@example.com')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.businesses
    (id, name, owner_user_id, subscription_status, subscription_plan, wholesale_portal_enabled, wholesale_portal_slug)
  VALUES
    (v_clic,  'TEST CLIC',       v_clic_owner, 'active','full', true,  'test-clic'),
    (v_other, 'TEST OTHER FULL', v_other_own,  'active','full', false, NULL),
    (v_nofeat,'TEST NOFEAT',     v_nofeat_own, 'active','pro',  false, NULL),
    (v_inact_biz,'TEST INACT ADMIN', v_inact_admin,'active','full', false, NULL);

  INSERT INTO public.profiles (id, user_id, business_id, role, is_active) VALUES
    (v_clic_owner,v_clic_owner,v_clic,'owner',  true),
    (v_clic_admin,v_clic_admin,v_clic,'admin',  true),
    (v_clic_mgr,  v_clic_mgr,  v_clic,'manager',true),
    (v_clic_sales,v_clic_sales,v_clic,'sales',  true),
    (v_clic_tech, v_clic_tech, v_clic,'tech',   true),
    (v_clic_cash, v_clic_cash, v_clic,'cashier',true),
    (v_clic_view, v_clic_view, v_clic,'viewer', true),
    (v_other_own, v_other_own, v_other,'owner', true),
    (v_nofeat_own,v_nofeat_own,v_nofeat,'owner',true),
    (v_inact_admin,v_inact_admin,v_inact_biz,'owner',true);

  -- Owner de Clic = System Owner ACTIVO. v_inact_admin = system admin INACTIVO.
  INSERT INTO public.system_admins (user_id, email, role, is_active)
  VALUES (v_clic_owner, 'clic_owner_t@example.com','super_admin', true),
         (v_inact_admin,'inact_admin_t@example.com','super_admin', false)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.inventory (id, code, name, category, cost_price, sale_price, business_id) VALUES
    (v_clic_inv1,'TEST-CLIC-INV1','Prod Clic 1','test',100,200,v_clic),
    (v_clic_inv2,'TEST-CLIC-INV2','Prod Clic 2','test',100,200,v_clic);

  INSERT INTO public.clic_wholesale_product_settings (business_id, inventory_id, is_visible) VALUES
    (v_clic, v_clic_inv1, true);

  INSERT INTO public.wholesale_customers
    (id, business_id, auth_user_id, name, email, approved) VALUES
    (v_wc_clic,  v_clic,  v_clic_cust, 'Cliente Clic','cust_clic_t@example.com', true),
    (v_wc_other, v_other, NULL,        'Cliente Otro','cust_other_t@example.com',true);

  INSERT INTO public.wholesale_orders
    (id, business_id, customer_id, order_number, status, subtotal, total) VALUES
    (v_wo_clic, v_clic, v_wc_clic, 'TEST-WO-1','pending_review',200,200);

  INSERT INTO public.wholesale_order_items
    (id, order_id, business_id, product_name, quantity, unit_price, subtotal) VALUES
    (v_woi_clic, v_wo_clic, v_clic, 'Prod Clic 1', 1, 200, 200);

  -- ── CASO 1 — Owner de Clic ────────────────────────────────────────────────
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_clic_owner,'role','authenticated')::text, true);

  SELECT count(*) INTO v_cnt FROM public.clic_wholesale_product_settings WHERE business_id=v_clic;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'CASO 1 FAIL: owner no lee su config (vio %)', v_cnt; END IF;

  INSERT INTO public.clic_wholesale_product_settings (business_id, inventory_id, is_visible)
  VALUES (v_clic, v_clic_inv2, true);   -- owner INSERT

  UPDATE public.clic_wholesale_product_settings SET is_featured=true WHERE inventory_id=v_clic_inv1;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'CASO 1 FAIL: owner no pudo UPDATE config (% filas)', v_cnt; END IF;

  v_role := public.current_platform_admin_role();
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'CASO 1 FAIL: owner no super_admin (%)', v_role; END IF;
  IF NOT (public.business_has_feature('mayorista') AND public.business_has_feature('audit'))
    THEN RAISE EXCEPTION 'CASO 1 FAIL: owner sin Mayorista/audit'; END IF;

  PERFORM set_config('role','postgres',true);
  RAISE NOTICE 'CASO 1 OK — owner gestiona clic settings, super_admin, Full features.';

  -- ── CASO 2 — admin/manager/sales NO tocan config privada ──────────────────
  FOREACH v_uid IN ARRAY ARRAY[v_clic_admin, v_clic_mgr, v_clic_sales] LOOP
    SELECT CASE v_uid WHEN v_clic_admin THEN 'admin' WHEN v_clic_mgr THEN 'manager' ELSE 'sales' END INTO v_lbl;
    PERFORM set_config('role','authenticated',true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub',v_uid,'role','authenticated')::text, true);

    SELECT count(*) INTO v_cnt FROM public.clic_wholesale_product_settings WHERE business_id=v_clic;
    IF v_cnt <> 0 THEN RAISE EXCEPTION 'CASO 2 FAIL: % LEE config privada (vio %)', v_lbl, v_cnt; END IF;

    UPDATE public.clic_wholesale_product_settings SET is_featured=false WHERE inventory_id=v_clic_inv1;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt <> 0 THEN RAISE EXCEPTION 'CASO 2 FAIL: % UPDATEó config privada (% filas)', v_lbl, v_cnt; END IF;

    v_blocked := false;
    BEGIN
      INSERT INTO public.clic_wholesale_product_settings (business_id, inventory_id, is_visible)
      VALUES (v_clic, v_clic_inv2, true);
    EXCEPTION WHEN insufficient_privilege OR check_violation THEN v_blocked := true;
    END;
    IF NOT v_blocked THEN RAISE EXCEPTION 'CASO 2 FAIL: % pudo INSERT config privada', v_lbl; END IF;

    PERFORM set_config('role','postgres',true);
  END LOOP;
  RAISE NOTICE 'CASO 2 OK — admin/manager/sales no leen ni modifican clic settings.';

  -- ── CASO 3 — sales SÍ opera mayorista ─────────────────────────────────────
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_clic_sales,'role','authenticated')::text, true);

  SELECT count(*) INTO v_cnt FROM public.wholesale_customers WHERE business_id=v_clic;
  IF v_cnt < 1 THEN RAISE EXCEPTION 'CASO 3 FAIL: sales no lee clientes mayoristas (%)', v_cnt; END IF;

  INSERT INTO public.wholesale_customers (business_id, name, email, approved)
  VALUES (v_clic, 'Nuevo x Sales', 'wc_sales_new_t@example.com', true) RETURNING id INTO v_tmp;

  UPDATE public.wholesale_customers SET notes='tocado por sales' WHERE id=v_wc_clic;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'CASO 3 FAIL: sales no pudo UPDATE cliente (%)', v_cnt; END IF;

  INSERT INTO public.wholesale_orders (business_id, customer_id, order_number, subtotal, total)
  VALUES (v_clic, v_wc_clic, 'TEST-WO-SALES', 50, 50) RETURNING id INTO v_tmp;
  INSERT INTO public.wholesale_order_items (order_id, business_id, product_name, quantity, unit_price, subtotal)
  VALUES (v_tmp, v_clic, 'Item x Sales', 1, 50, 50);

  PERFORM set_config('role','postgres',true);
  RAISE NOTICE 'CASO 3 OK — sales opera customers/orders/items.';

  -- ── CASO 4 — tech/cashier/viewer leen pero NO escriben; sin SaaS Admin ────
  FOREACH v_uid IN ARRAY ARRAY[v_clic_tech, v_clic_cash, v_clic_view] LOOP
    SELECT CASE v_uid WHEN v_clic_tech THEN 'tech' WHEN v_clic_cash THEN 'cashier' ELSE 'viewer' END INTO v_lbl;
    PERFORM set_config('role','authenticated',true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub',v_uid,'role','authenticated')::text, true);

    SELECT count(*) INTO v_cnt FROM public.wholesale_customers WHERE business_id=v_clic;
    IF v_cnt < 1 THEN RAISE EXCEPTION 'CASO 4 FAIL: % no puede LEER mayorista (%)', v_lbl, v_cnt; END IF;

    UPDATE public.wholesale_customers SET notes='hack' WHERE id=v_wc_clic;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt <> 0 THEN RAISE EXCEPTION 'CASO 4 FAIL: % UPDATEó mayorista (% filas)', v_lbl, v_cnt; END IF;

    v_blocked := false;
    BEGIN
      INSERT INTO public.wholesale_customers (business_id, name, email, approved)
      VALUES (v_clic, 'hack', 'wc_hack_'||v_lbl||'_t@example.com', true);
    EXCEPTION WHEN insufficient_privilege OR check_violation THEN v_blocked := true;
    END;
    IF NOT v_blocked THEN RAISE EXCEPTION 'CASO 4 FAIL: % pudo INSERT mayorista', v_lbl; END IF;

    IF public.current_platform_admin_role() IS NOT NULL
      THEN RAISE EXCEPTION 'CASO 4 FAIL: % no debe ser platform admin', v_lbl; END IF;

    PERFORM set_config('role','postgres',true);
  END LOOP;
  RAISE NOTICE 'CASO 4 OK — tech/cashier/viewer leen, no escriben, sin SaaS Admin.';

  -- ── CASO 5 — Otro tenant Full aislado de Clic ─────────────────────────────
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_other_own,'role','authenticated')::text, true);

  SELECT count(*) INTO v_cnt FROM public.clic_wholesale_product_settings WHERE business_id=v_clic;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'CASO 5 FAIL: otro Full LEE config de Clic (%)', v_cnt; END IF;

  SELECT count(*) INTO v_cnt FROM public.wholesale_customers WHERE business_id=v_clic;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'CASO 5 FAIL: otro Full VE clientes de Clic (%)', v_cnt; END IF;

  UPDATE public.wholesale_customers SET notes='cross' WHERE id=v_wc_clic;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'CASO 5 FAIL: otro Full UPDATEó cliente de Clic (%)', v_cnt; END IF;

  v_blocked := false;
  BEGIN
    INSERT INTO public.wholesale_customers (business_id, name, email, approved)
    VALUES (v_clic, 'cross', 'wc_cross_t@example.com', true);
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'CASO 5 FAIL: otro Full INSERTó cliente en Clic'; END IF;

  IF public.current_platform_admin_role() IS NOT NULL
    THEN RAISE EXCEPTION 'CASO 5 FAIL: otro Full no debe ser platform admin'; END IF;

  PERFORM set_config('role','postgres',true);
  RAISE NOTICE 'CASO 5 OK — otro Full aislado (no lee ni escribe Clic), sin SaaS Admin.';

  -- ── CASO 6 — Otro tenant Full mantiene su Mayorista genérico ──────────────
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_other_own,'role','authenticated')::text, true);

  SELECT count(*) INTO v_cnt FROM public.wholesale_customers;  -- solo ve los suyos
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'CASO 6 FAIL: otro Full debería ver 1 cliente propio (vio %)', v_cnt; END IF;

  INSERT INTO public.wholesale_customers (business_id, name, email, approved)
  VALUES (v_other, 'Propio Otro', 'wc_other_new_t@example.com', true);  -- owner→can_manage, Full→feature

  PERFORM set_config('role','postgres',true);
  RAISE NOTICE 'CASO 6 OK — otro Full opera su propio mayorista.';

  -- ── CASO 7 — Sin feature Mayorista (plan pro) ─────────────────────────────
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_nofeat_own,'role','authenticated')::text, true);

  SELECT count(*) INTO v_cnt FROM public.wholesale_customers;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'CASO 7 FAIL: sin feature ve mayorista (%)', v_cnt; END IF;

  v_blocked := false;
  BEGIN
    INSERT INTO public.wholesale_customers (business_id, name, email, approved)
    VALUES (v_nofeat, 'x', 'wc_nofeat_t@example.com', true);
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'CASO 7 FAIL: sin feature pudo INSERT mayorista'; END IF;

  PERFORM set_config('role','postgres',true);
  RAISE NOTICE 'CASO 7 OK — usuario sin feature Mayorista no accede.';

  -- ── CASO 8 — service_role conserva el comportamiento esperado ─────────────
  -- service_role tiene BYPASSRLS pero NO grants directos sobre las tablas
  -- mayoristas/clic (usa RPCs SECURITY DEFINER). BYPASSRLS saltea RLS, NO otorga
  -- privilegios de tabla. La migración NO cambia esto (comportamiento preservado).
  PERFORM set_config('role','service_role',true);

  SELECT count(*) INTO v_cnt FROM public.businesses;  -- service_role SÍ tiene SELECT en businesses
  IF v_cnt < 3 THEN RAISE EXCEPTION 'CASO 8 FAIL: service_role no ve businesses (%)', v_cnt; END IF;

  v_blocked := false;
  BEGIN
    SELECT count(*) INTO v_cnt FROM public.wholesale_customers;  -- sin grant → permission denied
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'CASO 8 FAIL: service_role tiene grant directo inesperado a wholesale_customers'; END IF;

  v_blocked := false;
  BEGIN
    SELECT count(*) INTO v_cnt FROM public.clic_wholesale_product_settings;  -- sin grant → permission denied
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'CASO 8 FAIL: service_role tiene grant directo inesperado a clic settings'; END IF;

  PERFORM set_config('role','postgres',true);
  RAISE NOTICE 'CASO 8 OK — service_role: SELECT businesses intacto; sin acceso directo a tablas mayoristas (preservado).';

  -- ── CASO 9 — Cliente externo (auth_user_id) — cliente-facing intacto ──────
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_clic_cust,'role','authenticated')::text, true);

  SELECT count(*) INTO v_cnt FROM public.wholesale_customers WHERE auth_user_id=v_clic_cust;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'CASO 9 FAIL: cliente no ve su propia ficha (%)', v_cnt; END IF;

  SELECT count(*) INTO v_cnt FROM public.wholesale_orders WHERE customer_id=v_wc_clic;
  IF v_cnt < 1 THEN RAISE EXCEPTION 'CASO 9 FAIL: cliente no ve sus pedidos (%)', v_cnt; END IF;

  UPDATE public.wholesale_customers SET last_login=now() WHERE id=v_wc_clic;  -- wc_own_update
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'CASO 9 FAIL: cliente no pudo actualizar su ficha (%)', v_cnt; END IF;

  SELECT count(*) INTO v_cnt FROM public.clic_wholesale_product_settings;  -- no es config sensible
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'CASO 9 FAIL: cliente externo LEE clic settings (%)', v_cnt; END IF;

  PERFORM set_config('role','postgres',true);
  RAISE NOTICE 'CASO 9 OK — policies cliente-facing intactas.';

  -- ── CASO 10 — Guard de activación (ALLOWLIST fail-closed) — 12 escenarios ──
  -- Allowlist: current_user IN ('postgres','supabase_admin','service_role') o
  -- (authenticated AND platform admin activo). Para que los UPDATE lleguen al
  -- trigger se simulan grants técnicos (revertidos por el ROLLBACK final).
  GRANT UPDATE (wholesale_portal_enabled, wholesale_whatsapp) ON public.businesses TO authenticated;
  GRANT UPDATE (wholesale_portal_enabled) ON public.businesses TO service_role;

  -- 10.1 owner (NO platform admin) -> DENEGADO
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_other_own,'role','authenticated')::text, true);
  v_blocked := false;
  BEGIN UPDATE public.businesses SET wholesale_portal_enabled=true WHERE id=v_other;
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'CASO 10.1 FAIL: owner pudo togglear el flag'; END IF;

  -- 10.3 authenticated no-admin: ambas ramas de allow del guard son FALSAS
  IF (current_user IN ('postgres','supabase_admin','service_role'))
     OR (current_user='authenticated' AND public.current_platform_admin_role() IS NOT NULL)
    THEN RAISE EXCEPTION 'CASO 10.3 FAIL: authenticated no-admin caería en una rama de allow'; END IF;
  PERFORM set_config('role','postgres',true);

  -- 10.2 admin (NO platform admin) -> DENEGADO
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_clic_admin,'role','authenticated')::text, true);
  v_blocked := false;
  BEGIN UPDATE public.businesses SET wholesale_portal_enabled=false WHERE id=v_clic;
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'CASO 10.2 FAIL: admin pudo togglear el flag'; END IF;
  PERFORM set_config('role','postgres',true);

  -- 10.4 platform admin ACTIVO (authenticated + system_admins) -> PERMITIDO
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_clic_owner,'role','authenticated')::text, true);
  UPDATE public.businesses SET wholesale_portal_enabled=false WHERE id=v_clic;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'CASO 10.4 FAIL: platform admin activo no pudo togglear (%)', v_cnt; END IF;
  UPDATE public.businesses SET wholesale_portal_enabled=true WHERE id=v_clic;  -- restaurar
  PERFORM set_config('role','postgres',true);

  -- 10.5 platform admin INACTIVO -> DENEGADO
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_inact_admin,'role','authenticated')::text, true);
  v_blocked := false;
  BEGIN UPDATE public.businesses SET wholesale_portal_enabled=true WHERE id=v_inact_biz;
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  IF NOT v_blocked THEN RAISE EXCEPTION 'CASO 10.5 FAIL: platform admin INACTIVO pudo togglear'; END IF;
  PERFORM set_config('role','postgres',true);

  -- 10.6 service_role -> PERMITIDO (v_other false->true)
  PERFORM set_config('role','service_role',true);
  UPDATE public.businesses SET wholesale_portal_enabled=true WHERE id=v_other;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'CASO 10.6 FAIL: service_role no pudo togglear (%)', v_cnt; END IF;
  PERFORM set_config('role','postgres',true);

  -- 10.7 postgres -> PERMITIDO (v_other true->false)
  UPDATE public.businesses SET wholesale_portal_enabled=false WHERE id=v_other;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'CASO 10.7 FAIL: postgres no pudo togglear (%)', v_cnt; END IF;

  -- 10.8 supabase_admin -> verificación segura: está en la allowlist del guard
  SELECT pg_get_functiondef('public.enforce_wholesale_portal_activation()'::regprocedure) INTO v_def;
  IF position('supabase_admin' in v_def) = 0
    THEN RAISE EXCEPTION 'CASO 10.8 FAIL: supabase_admin no figura en la allowlist del guard'; END IF;

  -- 10.9 authenticator -> DENEGADO (decisión): no en allowlist y no es authenticated
  PERFORM set_config('role','authenticator',true);
  IF (current_user IN ('postgres','supabase_admin','service_role')) OR (current_user='authenticated')
    THEN RAISE EXCEPTION 'CASO 10.9 FAIL: authenticator (current_user=%) caería en allow', current_user; END IF;
  PERFORM set_config('role','postgres',true);

  -- 10.10 rol arbitrario con GRANT técnico -> DENEGADO (end-to-end contra el trigger)
  EXECUTE 'CREATE ROLE caso_e_probe_arb NOLOGIN BYPASSRLS';
  EXECUTE 'GRANT SELECT, UPDATE (wholesale_portal_enabled) ON public.businesses TO caso_e_probe_arb';
  EXECUTE 'GRANT caso_e_probe_arb TO postgres WITH SET TRUE';
  SET ROLE caso_e_probe_arb;
  v_blocked := false;
  BEGIN UPDATE public.businesses SET wholesale_portal_enabled=true WHERE id=v_other;
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  RESET ROLE;
  IF NOT v_blocked THEN RAISE EXCEPTION 'CASO 10.10 FAIL: rol arbitrario con grant pudo togglear'; END IF;
  EXECUTE 'REVOKE ALL ON public.businesses FROM caso_e_probe_arb';
  EXECUTE 'REVOKE caso_e_probe_arb FROM postgres';
  EXECUTE 'DROP ROLE caso_e_probe_arb';

  -- 10.11 otra columna sin tocar el flag -> PERMITIDO (BEFORE UPDATE OF no dispara)
  PERFORM set_config('role','authenticated',true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_other_own,'role','authenticated')::text, true);
  UPDATE public.businesses SET wholesale_whatsapp='5490000000000' WHERE id=v_other;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'CASO 10.11 FAIL: update de otra columna bloqueado (%)', v_cnt; END IF;

  -- 10.12 mismo valor (IS DISTINCT FROM) -> PERMITIDO aun siendo authenticated no-admin
  UPDATE public.businesses SET wholesale_portal_enabled=false WHERE id=v_other;  -- v_other.flag ya es false
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'CASO 10.12 FAIL: asignar el mismo valor fue bloqueado (%)', v_cnt; END IF;
  PERFORM set_config('role','postgres',true);

  REVOKE UPDATE (wholesale_portal_enabled, wholesale_whatsapp) ON public.businesses FROM authenticated;
  REVOKE UPDATE (wholesale_portal_enabled) ON public.businesses FROM service_role;
  RAISE NOTICE 'CASO 10 OK — guard allowlist: 12 escenarios verificados.';

  RAISE NOTICE 'ALL CASO E RLS ISOLATION TESTS PASSED';
END $$;

ROLLBACK;
