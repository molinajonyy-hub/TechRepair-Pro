-- SEC-08A Fase C — contrato SQL de la lectura de pagos.
--
-- Prueba lo que se prueba mejor en SQL puro: la forma de la policy, la
-- alcanzabilidad del helper que la policy invoca, y que la autoridad esté ligada
-- al negocio de la FILA. La matriz de red (enumeración, anidados, vistas de
-- finanzas, overrides por actor) vive en
-- scripts/security/sec08a-phase-c-postgrest.mjs.
--
-- Nota de seguridad del propio test: NUNCA se entra a una función SECURITY
-- DEFINER con el rol cambiado dentro de un DO — ese patrón crashea el backend.
-- El cambio de rol se usa SÓLO para tocar tablas.
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
 * Lee los pagos de un comprobante COMO el rol dado.
 * Devuelve el importe, 'NO_ROWS' si la RLS los oculta, o 'DENIED' si PostgreSQL
 * rechaza por privilegio. La distinción importa: 'DENIED' significa PANTALLA
 * ROTA, no denegación correcta — es exactamente el defecto que traía la Fase B.
 */
CREATE OR REPLACE FUNCTION pg_temp.read_payment(p_role text, p_actor uuid, p_comprobante uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('role', p_role, true);
  PERFORM pg_temp.act_as(p_actor);
  BEGIN
    SELECT string_agg(amount::text, ',') INTO v
      FROM public.comprobante_payments WHERE comprobante_id = p_comprobante;
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('role','none',true); RETURN 'DENIED';
  END;
  PERFORM set_config('role','none',true);
  RETURN COALESCE(v,'NO_ROWS');
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.read_items(p_role text, p_actor uuid, p_comprobante uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('role', p_role, true);
  PERFORM pg_temp.act_as(p_actor);
  BEGIN
    SELECT string_agg(precio_unitario::text, ',') INTO v
      FROM public.comprobante_items WHERE comprobante_id = p_comprobante;
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('role','none',true); RETURN 'DENIED';
  END;
  PERFORM set_config('role','none',true);
  RETURN COALESCE(v,'NO_ROWS');
END;
$$;

CREATE TEMP TABLE ids AS SELECT
  gen_random_uuid() AS biz, gen_random_uuid() AS owner_u, gen_random_uuid() AS sales_u,
  gen_random_uuid() AS tech_u, gen_random_uuid() AS cust, gen_random_uuid() AS ord,
  gen_random_uuid() AS comp_ord, gen_random_uuid() AS comp_free;

SET session_replication_role = replica;
INSERT INTO auth.users(id,email,email_confirmed_at)
SELECT x,'sec08c-'||x||'@sql.invalid',now() FROM (SELECT unnest(ARRAY[owner_u,sales_u,tech_u]) AS x FROM ids) s;
INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status)
SELECT biz,'C',owner_u,'pro','active' FROM ids;
-- `sales` NO es el dueño registrado: si lo fuera, la rama de dueño le daría todo.
INSERT INTO public.profiles(id,business_id,role,is_active,email) SELECT owner_u,biz,'owner',true,'o@sql.invalid' FROM ids
UNION ALL SELECT sales_u,biz,'sales',true,'s@sql.invalid' FROM ids
UNION ALL SELECT tech_u,biz,'tech',true,'t@sql.invalid' FROM ids;
INSERT INTO public.customers(id,business_id,name,phone) SELECT cust,biz,'C','1' FROM ids;
INSERT INTO public.orders(id,business_id,customer_id,status) SELECT ord,biz,cust,'repair' FROM ids;
INSERT INTO public.comprobantes(id,business_id,order_id,customer_id,tipo,estado,subtotal,impuestos,total,total_bruto,total_cobrado,saldo_pendiente,currency,total_ars,total_usd,exchange_rate,tax,status,fecha)
SELECT comp_ord,biz,ord,cust,'factura_c','emitido',1,0,1,1,0,1,'ARS',1,0,1,0,'active',now() FROM ids
UNION ALL SELECT comp_free,biz,NULL,cust,'factura_c','emitido',1,0,1,1,0,1,'ARS',1,0,1,0,'active',now() FROM ids;
INSERT INTO public.comprobante_items(id,comprobante_id,business_id,descripcion,cantidad,precio_unitario,costo_unitario)
SELECT gen_random_uuid(),comp_ord,biz,'lo',1,8101.00,1 FROM ids
UNION ALL SELECT gen_random_uuid(),comp_free,biz,'ls',1,8202.00,1 FROM ids;
INSERT INTO public.comprobante_payments(id,comprobante_id,business_id,amount,payment_method,date)
SELECT gen_random_uuid(),comp_ord,biz,9101.00,'efectivo',now() FROM ids
UNION ALL SELECT gen_random_uuid(),comp_free,biz,9202.00,'efectivo',now() FROM ids;
SET session_replication_role = origin;

-- ── Forma de la policy ──────────────────────────────────────────────────────
DO $shape$
DECLARE v_qual text; v_cnt int;
BEGIN
  SELECT qual::text INTO v_qual FROM pg_policies
   WHERE schemaname='public' AND tablename='comprobante_payments'
     AND policyname='cp_select_comprobantes_capability';
  PERFORM pg_temp.assert(v_qual LIKE '%current_user_can_in_business%',
    'la lectura de pagos usa autoridad ligada al tenant');
  PERFORM pg_temp.assert(v_qual NOT LIKE '%current_user_can(%',
    'la lectura de pagos NO conserva ninguna decisión de capacidad ciega');
  PERFORM pg_temp.assert(v_qual LIKE '%comprobante_is_order_linked%',
    'la lectura de pagos distingue el comprobante vinculado a una orden');
  PERFORM pg_temp.assert(v_qual LIKE '%orders_view_financials%',
    'lo vinculado a una orden exige orders_view_financials');

  SELECT count(*) INTO v_cnt FROM pg_policies
   WHERE schemaname='public' AND tablename='comprobante_payments'
     AND cmd='SELECT' AND permissive='PERMISSIVE';
  PERFORM pg_temp.assert(v_cnt = 1,
    'hay exactamente UNA policy permissive de SELECT (dos se OR-ean y abren el bypass)');

  -- El helper: SECDEF y, sobre todo, EJECUTABLE por el browser.
  PERFORM pg_temp.assert(
    (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='comprobante_is_order_linked'),
    'el helper de relación es SECURITY DEFINER');
  PERFORM pg_temp.assert(
    has_function_privilege('authenticated','public.comprobante_is_order_linked(uuid)','EXECUTE'),
    'el helper es EJECUTABLE por authenticated (si no, toda policy que lo use da 42501 a todos)');
  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon','public.comprobante_is_order_linked(uuid)','EXECUTE'),
    'anon no alcanza el helper');
  PERFORM pg_temp.assert(
    NOT has_schema_privilege('authenticated','private','USAGE'),
    'el esquema private sigue cerrado: el helper se movió, no se abrió el esquema');
  PERFORM pg_temp.assert(
    NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='private' AND p.proname='comprobante_is_order_linked'),
    'el helper inalcanzable de private se retiró');

  -- Escritura intacta: esto es visibilidad, no autoridad de escritura.
  PERFORM pg_temp.assert(
    NOT has_table_privilege('authenticated','public.comprobante_payments','INSERT')
    AND NOT has_table_privilege('authenticated','public.comprobante_payments','UPDATE')
    AND NOT has_table_privilege('authenticated','public.comprobante_payments','DELETE'),
    'el browser sigue sin escritura directa sobre comprobante_payments');
END
$shape$;

-- ── Comportamiento por actor ────────────────────────────────────────────────
DO $behaviour$
DECLARE r record; v text;
BEGIN
  SELECT * INTO r FROM ids;

  -- sales por defecto: ve todo (tiene comprobantes y orders_view_financials).
  v := pg_temp.read_payment('authenticated', r.sales_u, r.comp_ord);
  PERFORM pg_temp.assert(v = '9101.00', 'sales por defecto SÍ ve el pago de la orden — got ' || v);

  -- sales con el override que motivó el P1: pierde el de la orden, conserva el suelto.
  UPDATE public.profiles SET permissions='{"orders_view_financials":false}'::jsonb WHERE id = r.sales_u;
  v := pg_temp.read_payment('authenticated', r.sales_u, r.comp_ord);
  PERFORM pg_temp.assert(v = 'NO_ROWS', 'sales con override false NO ve el pago de la orden — got ' || v);
  v := pg_temp.read_payment('authenticated', r.sales_u, r.comp_free);
  PERFORM pg_temp.assert(v = '9202.00', 'sales con override false CONSERVA el pago suelto — got ' || v);
  -- Y tampoco las líneas del comprobante de la orden, pero sí las sueltas.
  v := pg_temp.read_items('authenticated', r.sales_u, r.comp_ord);
  PERFORM pg_temp.assert(v = 'NO_ROWS', 'sales con override false NO ve las líneas de la orden — got ' || v);
  v := pg_temp.read_items('authenticated', r.sales_u, r.comp_free);
  PERFORM pg_temp.assert(v = '8202.00', 'sales con override false CONSERVA las líneas sueltas — got ' || v);
  UPDATE public.profiles SET permissions=NULL WHERE id = r.sales_u;

  -- tech por defecto: sin `comprobantes`, ningún pago; pero NUNCA 'DENIED'.
  v := pg_temp.read_payment('authenticated', r.tech_u, r.comp_free);
  PERFORM pg_temp.assert(v = 'NO_ROWS', 'tech por defecto no ve pagos, y NO recibe DENIED — got ' || v);

  -- REGRESIÓN DE LA FASE B: el autorizado NO puede recibir 'DENIED'.
  -- La Fase B rompía comprobante_items para TODOS con 42501 y sus tests lo leían
  -- como una denegación correcta.
  v := pg_temp.read_items('authenticated', r.owner_u, r.comp_ord);
  PERFORM pg_temp.assert(v = '8101.00', 'owner lee las líneas del comprobante de la orden (no 42501) — got ' || v);
  v := pg_temp.read_items('authenticated', r.owner_u, r.comp_free);
  PERFORM pg_temp.assert(v = '8202.00', 'owner lee las líneas del comprobante suelto (no 42501) — got ' || v);
  v := pg_temp.read_items('authenticated', r.tech_u, r.comp_free);
  PERFORM pg_temp.assert(v = '8202.00', 'tech lee las líneas del comprobante suelto (no 42501) — got ' || v);
  v := pg_temp.read_payment('authenticated', r.owner_u, r.comp_ord);
  PERFORM pg_temp.assert(v = '9101.00', 'owner lee el pago del comprobante de la orden (no 42501) — got ' || v);

  -- CONTROL NEGATIVO: se restaura la policy pre-Fase-C y la fuga vuelve.
  UPDATE public.profiles SET permissions='{"orders_view_financials":false}'::jsonb WHERE id = r.sales_u;
  DROP POLICY cp_select_comprobantes_capability ON public.comprobante_payments;
  CREATE POLICY cp_select_comprobantes_capability ON public.comprobante_payments
    FOR SELECT TO authenticated
    USING (business_id = public.current_user_business_id() AND public.current_user_can('comprobantes'));
  v := pg_temp.read_payment('authenticated', r.sales_u, r.comp_ord);
  PERFORM pg_temp.assert(v = '9101.00', 'CONTROL NEGATIVO: con la policy pre-Fase-C la fuga REAPARECE — got ' || v);

  DROP POLICY cp_select_comprobantes_capability ON public.comprobante_payments;
  CREATE POLICY cp_select_comprobantes_capability ON public.comprobante_payments
    FOR SELECT TO authenticated
    USING (
      business_id = public.current_user_business_id()
      AND public.current_user_can_in_business(business_id, 'comprobantes')
      AND (
        NOT public.comprobante_is_order_linked(comprobante_id)
        OR public.current_user_can_in_business(business_id, 'orders_view_financials')
      )
    );
  v := pg_temp.read_payment('authenticated', r.sales_u, r.comp_ord);
  PERFORM pg_temp.assert(v = 'NO_ROWS', 'control negativo revertido: la fuga vuelve a estar cerrada — got ' || v);
  UPDATE public.profiles SET permissions=NULL WHERE id = r.sales_u;
END
$behaviour$;

DO $done$ BEGIN RAISE NOTICE 'SEC-08A Fase C SQL suite: todas las aserciones pasaron'; END $done$;

ROLLBACK;
