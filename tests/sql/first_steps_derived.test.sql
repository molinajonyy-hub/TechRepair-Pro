-- ============================================================================
-- P0 FIRST-STEPS-1 — tests de public.get_my_first_steps()
--
-- Corre entero dentro de UNA transaccion que termina en ROLLBACK: no deja
-- rastro en la base local. La migracion se carga desde /tmp/fs_mig.sql, que es
-- el archivo de migracion con sus BEGIN;/COMMIT; removidos (si no, el COMMIT
-- de la migracion cerraria la transaccion del test y el seed quedaria escrito).
--
--   npm run test:sql:first-steps
-- ============================================================================
\set ON_ERROR_STOP on
\timing off

BEGIN;

\i /tmp/fs_mig.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers de test
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE t_result(label text, ok boolean, detail text);

-- Crea un tenant completo (auth.user + business + profile owner) y lo devuelve.
CREATE OR REPLACE FUNCTION pg_temp.mk_tenant(p_slug text)
RETURNS TABLE(biz uuid, usr uuid)
LANGUAGE plpgsql AS $$
DECLARE v_biz uuid := gen_random_uuid(); v_usr uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users(id, instance_id, aud, role, email, encrypted_password,
                         email_confirmed_at, created_at, updated_at)
  VALUES (v_usr, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', p_slug || '@fs.test', '', now(), now(), now());

  INSERT INTO public.businesses(id, name) VALUES (v_biz, 'FS ' || p_slug);

  -- `profiles.id` tiene FK a auth.users: el id del perfil ES el id del usuario.
  INSERT INTO public.profiles(id, user_id, business_id, full_name, role, is_active)
  VALUES (v_usr, v_usr, v_biz, 'Owner ' || p_slug, 'owner', true);

  biz := v_biz; usr := v_usr; RETURN NEXT;
END $$;

-- Corre get_my_first_steps() como p_usr y compara contra los 5 esperados.
CREATE OR REPLACE FUNCTION pg_temp.expect(
  p_label text, p_usr uuid,
  e_customer boolean, e_order boolean, e_inventory boolean,
  e_cobro boolean, e_logo boolean)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r record; v_got text; v_exp text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',
                     COALESCE(p_usr::text, ''), true);
  SELECT * INTO r FROM public.get_my_first_steps();

  v_got := format('%s/%s/%s/%s/%s', r.has_customer, r.has_order,
                  r.has_inventory, r.has_cobro, r.has_logo);
  v_exp := format('%s/%s/%s/%s/%s', e_customer, e_order,
                  e_inventory, e_cobro, e_logo);

  INSERT INTO t_result VALUES (p_label, v_got = v_exp,
    CASE WHEN v_got = v_exp THEN 'ok'
         ELSE 'esperado ' || v_exp || ' / obtenido ' || v_got END);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE t AS
SELECT s.slug, m.biz, m.usr
FROM (VALUES
  ('t0_vacio'),        ('t1_cliente'),       ('t2_orden'),
  ('t3_inventario'),   ('t4_logo_biz'),      ('t5_logo_settings'),
  ('t6_cp'),           ('t7_op_senia'),      ('t8_cc_credit'),
  ('t9_cc_debit'),     ('t10_fm_egreso'),    ('t11_saas'),
  ('t12_cliente_off'), ('t13_inv_off'),      ('t14_padre'),
  ('t15_hijo'),        ('t16_logo_vacio'),   ('t17_cp_reemplazado'),
  ('t18_op_reversado'), ('t19_ajeno')
) AS s(slug)
CROSS JOIN LATERAL pg_temp.mk_tenant(s.slug) AS m;

\set QUIET on
-- t1: SOLO un cliente activo  ── el test distintivo del lote (§17)
INSERT INTO public.customers(name, phone, business_id, active, customer_type)
SELECT 'Cliente Uno', '1130000001', biz, true, 'minorista' FROM t WHERE slug='t1_cliente';

-- t2: SOLO una orden (entregada: el estado no importa)
INSERT INTO public.orders(business_id, status, priority)
SELECT biz, 'completed', 'medium' FROM t WHERE slug='t2_orden';

-- t3: SOLO un producto vendible
INSERT INTO public.inventory(code, name, category, cost_price, sale_price, business_id,
                             tipo, is_active, has_variants)
SELECT 'FS-T3', 'Producto', 'General', 10, 20, biz, 'product', true, false
FROM t WHERE slug='t3_inventario';

-- t4 / t5 / t16: logo en cada fuente, y string vacio
UPDATE public.businesses SET logo_url='https://cdn.test/a.png'
WHERE id=(SELECT biz FROM t WHERE slug='t4_logo_biz');

INSERT INTO public.business_settings(business_id, logo_url)
SELECT biz, 'https://cdn.test/b.png' FROM t WHERE slug='t5_logo_settings';

UPDATE public.businesses SET logo_url='   '
WHERE id=(SELECT biz FROM t WHERE slug='t16_logo_vacio');
INSERT INTO public.business_settings(business_id, logo_url)
SELECT biz, '' FROM t WHERE slug='t16_logo_vacio';

-- t6: SOLO un cobro de comprobante (POS)
WITH c AS (
  INSERT INTO public.comprobantes(business_id, tipo, subtotal, impuestos, total, estado, tax, status)
  SELECT biz, 'remito', 100, 0, 100, 'emitido', 0, 'emitido' FROM t WHERE slug='t6_cp'
  RETURNING id, business_id
)
INSERT INTO public.comprobante_payments(comprobante_id, business_id, amount, currency,
                                        amount_ars, exchange_rate, payment_method, date)
SELECT id, business_id, 100, 'ARS', 100, 1, 'efectivo', current_date FROM c;

-- t7: seña sobre una orden (order_payment). Implica orden + cobro.
WITH o AS (
  INSERT INTO public.orders(business_id, status, priority)
  SELECT biz, 'new', 'medium' FROM t WHERE slug='t7_op_senia'
  RETURNING id, business_id
)
INSERT INTO public.order_payments(order_id, business_id, amount, payment_method,
                                  payment_date, currency, exchange_rate, amount_ars)
SELECT id, business_id, 50, 'cash', current_date, 'ARS', 1, 50 FROM o;

-- t8 / t9: cuenta corriente. credit>0 es cobranza; debit>0 es cargo.
WITH a AS (
  INSERT INTO public.accounts(business_id, type, entity_id, entity_name, balance)
  SELECT biz, 'cliente', gen_random_uuid(), 'CC Cliente', 0 FROM t WHERE slug='t8_cc_credit'
  RETURNING id, business_id
)
INSERT INTO public.account_movements(business_id, account_id, date, type, description, debit, credit)
SELECT business_id, id, current_date, 'pago', 'cobranza CC', 0, 500 FROM a;

WITH a AS (
  INSERT INTO public.accounts(business_id, type, entity_id, entity_name, balance)
  SELECT biz, 'cliente', gen_random_uuid(), 'CC Cliente', 0 FROM t WHERE slug='t9_cc_debit'
  RETURNING id, business_id
)
INSERT INTO public.account_movements(business_id, account_id, date, type, description, debit, credit)
SELECT business_id, id, current_date, 'venta', 'cargo CC', 500, 0 FROM a;

-- t10: SOLO un egreso financiero
INSERT INTO public.financial_movements(business_id, type, currency, amount, exchange_rate,
                                       amount_ars, source, date, sign)
SELECT biz, 'expense', 'ARS', 999, 1, 999, 'manual', current_date, -1
FROM t WHERE slug='t10_fm_egreso';

-- t11: SOLO un pago del SaaS (el SaaS cobrandole al comerciante)
INSERT INTO public.payments(business_id, amount, status, type)
SELECT biz, 15000, 'approved', 'recurring' FROM t WHERE slug='t11_saas';

-- t12 / t13: filas dadas de baja
INSERT INTO public.customers(name, phone, business_id, active, customer_type)
SELECT 'Cliente Baja', '1130000012', biz, false, 'minorista' FROM t WHERE slug='t12_cliente_off';

INSERT INTO public.inventory(code, name, category, cost_price, sale_price, business_id,
                             tipo, is_active, has_variants)
SELECT 'FS-T13', 'Producto Baja', 'General', 10, 20, biz, 'product', false, false
FROM t WHERE slug='t13_inv_off';

-- t14: SOLO el padre estructural de variantes (no vendible)
INSERT INTO public.inventory(code, name, category, cost_price, sale_price, business_id,
                             tipo, is_active, has_variants)
SELECT 'FS-T14', 'Padre', 'General', 0, 0, biz, 'product', true, true
FROM t WHERE slug='t14_padre';

-- t15: padre + hijo vendible. El hijo hace que el paso cuente.
WITH p AS (
  INSERT INTO public.inventory(code, name, category, cost_price, sale_price, business_id,
                               tipo, is_active, has_variants)
  SELECT 'FS-T15-P', 'Padre', 'General', 0, 0, biz, 'product', true, true
  FROM t WHERE slug='t15_hijo'
  RETURNING id, business_id
)
INSERT INTO public.inventory(code, name, category, cost_price, sale_price, business_id,
                             tipo, is_active, has_variants, parent_id, variant_name)
SELECT 'FS-T15-H', 'Padre / Rojo', 'General', 10, 20, business_id, 'product', true, false, id, 'Rojo'
FROM p;

-- t17 (§19): el UNICO cobro fue REEMPLAZADO por el mecanismo canonico.
-- La fila original sobrevive con replaced_at seteado -> el hecho ocurrio.
WITH c AS (
  INSERT INTO public.comprobantes(business_id, tipo, subtotal, impuestos, total, estado, tax, status)
  SELECT biz, 'remito', 100, 0, 100, 'emitido', 0, 'emitido' FROM t WHERE slug='t17_cp_reemplazado'
  RETURNING id, business_id
), nuevo AS (
  INSERT INTO public.comprobante_payments(comprobante_id, business_id, amount, currency,
                                          amount_ars, exchange_rate, payment_method, date)
  SELECT id, business_id, 100, 'ARS', 100, 1, 'transferencia', current_date FROM c
  RETURNING id, comprobante_id, business_id
)
INSERT INTO public.comprobante_payments(comprobante_id, business_id, amount, currency,
                                        amount_ars, exchange_rate, payment_method, date,
                                        replaced_at, replaced_by, replacement_payment_id)
SELECT comprobante_id, business_id, 100, 'ARS', 100, 1, 'efectivo', current_date,
       now(), (SELECT usr FROM t WHERE slug='t17_cp_reemplazado'), id
FROM nuevo;

-- t18 (§19): la UNICA seña fue REVERSADA. La fila queda con reversed_at.
WITH o AS (
  INSERT INTO public.orders(business_id, status, priority)
  SELECT biz, 'cancelled', 'medium' FROM t WHERE slug='t18_op_reversado'
  RETURNING id, business_id
)
INSERT INTO public.order_payments(order_id, business_id, amount, payment_method,
                                  payment_date, currency, exchange_rate, amount_ars,
                                  reversed_at, reversed_by)
SELECT id, business_id, 50, 'cash', current_date, 'ARS', 1, 50,
       now(), (SELECT usr FROM t WHERE slug='t18_op_reversado')
FROM o;

-- t19: tenant "ajeno" cargado hasta arriba. Ningun otro debe verlo.
INSERT INTO public.customers(name, phone, business_id, active, customer_type)
SELECT 'Ajeno', '1130000019', biz, true, 'minorista' FROM t WHERE slug='t19_ajeno';
INSERT INTO public.orders(business_id, status, priority)
SELECT biz, 'new', 'medium' FROM t WHERE slug='t19_ajeno';
INSERT INTO public.inventory(code, name, category, cost_price, sale_price, business_id,
                             tipo, is_active, has_variants)
SELECT 'FS-T19', 'Ajeno', 'General', 10, 20, biz, 'product', true, false
FROM t WHERE slug='t19_ajeno';
UPDATE public.businesses SET logo_url='https://cdn.test/ajeno.png'
WHERE id=(SELECT biz FROM t WHERE slug='t19_ajeno');
WITH c AS (
  INSERT INTO public.comprobantes(business_id, tipo, subtotal, impuestos, total, estado, tax, status)
  SELECT biz, 'remito', 100, 0, 100, 'emitido', 0, 'emitido' FROM t WHERE slug='t19_ajeno'
  RETURNING id, business_id
)
INSERT INTO public.comprobante_payments(comprobante_id, business_id, amount, currency,
                                        amount_ars, exchange_rate, payment_method, date)
SELECT id, business_id, 100, 'ARS', 100, 1, 'efectivo', current_date FROM c;
\set QUIET off

-- ─────────────────────────────────────────────────────────────────────────────
-- Aserciones
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('t0  tenant vacio -> 0/5',
       (SELECT usr FROM t WHERE slug='t0_vacio'),          false,false,false,false,false);

-- §17 TEST DISTINTIVO: solo un cliente -> 1 de 5, y son las OTRAS 4 las que
-- deben quedar pendientes. La implementacion vieja (localStorage) no puede
-- pasar este test: sin tildar nada devuelve 0/5.
SELECT pg_temp.expect('t1  SOLO cliente -> 1/5 (DISTINTIVO §17)',
       (SELECT usr FROM t WHERE slug='t1_cliente'),        true, false,false,false,false);

SELECT pg_temp.expect('t2  SOLO orden',
       (SELECT usr FROM t WHERE slug='t2_orden'),          false,true, false,false,false);
SELECT pg_temp.expect('t3  SOLO inventario',
       (SELECT usr FROM t WHERE slug='t3_inventario'),     false,false,true, false,false);
SELECT pg_temp.expect('t4  SOLO logo en businesses',
       (SELECT usr FROM t WHERE slug='t4_logo_biz'),       false,false,false,false,true);
SELECT pg_temp.expect('t5  SOLO logo en business_settings',
       (SELECT usr FROM t WHERE slug='t5_logo_settings'),  false,false,false,false,true);
SELECT pg_temp.expect('t6  SOLO cobro POS (comprobante_payments)',
       (SELECT usr FROM t WHERE slug='t6_cp'),             false,false,false,true, false);
SELECT pg_temp.expect('t7  seña order_payment -> orden + cobro',
       (SELECT usr FROM t WHERE slug='t7_op_senia'),       false,true, false,true, false);
SELECT pg_temp.expect('t8  cobranza CC (credit>0) -> cobro',
       (SELECT usr FROM t WHERE slug='t8_cc_credit'),      false,false,false,true, false);

-- Negativos del cobro
SELECT pg_temp.expect('t9  debit CC -> NO es cobro',
       (SELECT usr FROM t WHERE slug='t9_cc_debit'),       false,false,false,false,false);
SELECT pg_temp.expect('t10 egreso financiero -> NO es cobro',
       (SELECT usr FROM t WHERE slug='t10_fm_egreso'),     false,false,false,false,false);
SELECT pg_temp.expect('t11 pago SaaS -> NO es cobro',
       (SELECT usr FROM t WHERE slug='t11_saas'),          false,false,false,false,false);

-- Negativos de los demas pasos
SELECT pg_temp.expect('t12 cliente inactivo -> NO cuenta',
       (SELECT usr FROM t WHERE slug='t12_cliente_off'),   false,false,false,false,false);
SELECT pg_temp.expect('t13 producto inactivo -> NO cuenta',
       (SELECT usr FROM t WHERE slug='t13_inv_off'),       false,false,false,false,false);
SELECT pg_temp.expect('t14 padre de variantes solo -> NO es vendible',
       (SELECT usr FROM t WHERE slug='t14_padre'),         false,false,false,false,false);
SELECT pg_temp.expect('t15 hijo variante -> SI es vendible',
       (SELECT usr FROM t WHERE slug='t15_hijo'),          false,false,true, false,false);
SELECT pg_temp.expect('t16 logo vacio/whitespace -> NO cuenta',
       (SELECT usr FROM t WHERE slug='t16_logo_vacio'),    false,false,false,false,false);

-- §19 MONOTONICIDAD DEL COBRO
SELECT pg_temp.expect('t17 cobro REEMPLAZADO -> sigue contando (§19)',
       (SELECT usr FROM t WHERE slug='t17_cp_reemplazado'),false,false,false,true, false);
SELECT pg_temp.expect('t18 seña REVERSADA -> sigue contando (§19)',
       (SELECT usr FROM t WHERE slug='t18_op_reversado'),  false,true, false,true, false);

-- Cross-tenant: el tenant vacio sigue vacio aunque el vecino tenga todo.
SELECT pg_temp.expect('t0  cross-tenant: no ve los datos del vecino',
       (SELECT usr FROM t WHERE slug='t0_vacio'),          false,false,false,false,false);
SELECT pg_temp.expect('t19 tenant ajeno ve LO SUYO',
       (SELECT usr FROM t WHERE slug='t19_ajeno'),         true, true, true, true, true);

-- Sin sesion (auth.uid() nulo) -> fail-closed, todo en false.
SELECT pg_temp.expect('sin sesion -> fail-closed 0/5', NULL, false,false,false,false,false);

-- ── Seguridad: grants reales ────────────────────────────────────────────────
INSERT INTO t_result
SELECT 'grant: anon NO tiene EXECUTE',
       NOT has_function_privilege('anon', p.oid, 'EXECUTE'), ''
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='get_my_first_steps';

INSERT INTO t_result
SELECT 'grant: PUBLIC NO tiene EXECUTE',
       NOT has_function_privilege('public', p.oid, 'EXECUTE'), ''
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='get_my_first_steps';

INSERT INTO t_result
SELECT 'grant: authenticated SI tiene EXECUTE',
       has_function_privilege('authenticated', p.oid, 'EXECUTE'), ''
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='get_my_first_steps';

-- Firma: cero parametros. Es lo que hace imposible el cross-tenant por diseño.
INSERT INTO t_result
SELECT 'firma: 0 parametros (no acepta business_id del cliente)',
       p.pronargs = 0, 'pronargs=' || p.pronargs
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='get_my_first_steps';

-- search_path endurecido con pg_temp AL FINAL.
INSERT INTO t_result
SELECT 'search_path endurecido (pg_temp ultimo)',
       p.proconfig::text LIKE '%search_path=pg_catalog, public, pg_temp%',
       p.proconfig::text
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='get_my_first_steps';

-- ─────────────────────────────────────────────────────────────────────────────
-- Reporte
-- ─────────────────────────────────────────────────────────────────────────────
\echo ''
\echo '─── FIRST-STEPS-1 ───────────────────────────────────────────────────────'
SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS r, label, detail FROM t_result;

DO $check$
DECLARE v_fail int;
BEGIN
  SELECT count(*) INTO v_fail FROM t_result WHERE NOT ok;
  IF v_fail > 0 THEN
    RAISE EXCEPTION 'FIRST-STEPS-1: % test(s) FALLARON', v_fail;
  END IF;
  RAISE NOTICE 'FIRST-STEPS-1: % tests OK', (SELECT count(*) FROM t_result);
END
$check$;

ROLLBACK;
