-- SEC-08A — Fase C. Visibilidad de los PAGOS de un comprobante vinculado a una orden.
--
-- La revisión final independiente aceptó el rollout de las fases A y B, pero
-- reprodujo un P1 que quedaba abierto y que hace FALSO el contrato del lote:
--
--   sales (perfil real, NO dueño del negocio) con orders_view_financials=false
--     GET /comprobantes             -> []                    (Fase B cierra bien)
--     GET /comprobante_payments     -> [{"amount":3103.00}]  <- FUGA
--     GET /comprobante_payments     -> el mismo importe SIN conocer el id,
--                                      enumerando todos los pagos del negocio
--
-- `comprobante_payments.amount` no es metadata de pago ajena a la orden: es lo
-- COBRADO contra el comprobante de esa orden. `v_order_financial_status` deriva
-- `total_cobrado` de `comprobantes.total_cobrado`, que a su vez lo mantiene el
-- trigger `trig_comprobante_payment_sync` sumando EXACTAMENTE estas filas. Sumar
-- los pagos por `comprobante_id` reconstruye la cobranza de la orden.
--
-- Por qué la Fase B no lo alcanzó: cerró `comprobantes` y `comprobante_items`,
-- pero `comprobante_payments` se gatea con OTRA capacidad (`comprobantes`) y con
-- la resolución CIEGA al tenant. Un actor con `comprobantes` y sin
-- `orders_view_financials` —que es justo lo que un admin configura cuando quiere
-- que alguien facture pero no vea la plata de las órdenes— pasaba el gate.
--
-- Regla medida ANTES de este lote:
--   business_id = current_user_business_id() AND current_user_can('comprobantes')
--
-- Este lote es SÓLO visibilidad de SELECT. No toca cálculo canónico, ni
-- `financial_movements`, ni BFE, ni escrituras de pago, ni
-- `replace_comprobante_payment`, ni checkout, ni anulaciones, ni notas de
-- crédito, ni ningún trigger de ledger. Tampoco toca las fases A y B.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. El helper de relación tiene que ser INVOCABLE desde una policy
-- ─────────────────────────────────────────────────────────────────────────────
-- DEFECTO ENCONTRADO EN LA FASE B, que este lote además corrige:
--
-- `private.comprobante_is_order_linked` quedó con `REVOKE ALL ... FROM PUBLIC` y
-- sin ningún GRANT, y `authenticated` tampoco tiene USAGE sobre el esquema
-- `private`. Una expresión de policy se evalúa con los privilegios de QUIEN
-- CONSULTA, así que `comprobante_items_select` respondía
--
--     42501 permission denied for function comprobante_is_order_linked
--
-- a TODOS los roles del browser —incluidos owner y admin— tanto para los
-- comprobantes vinculados a una orden como para los sueltos. Es decir: el
-- detalle de líneas de cualquier comprobante estaba roto. Los tests de la Fase B
-- no lo vieron porque sus aserciones negativas sólo comprobaban que el VALOR
-- testigo no apareciera, y un 42501 cumple esa condición: un error de privilegio
-- se leía como una denegación correcta. Acá se agregan positivos explícitos para
-- que no vuelva a pasar.
--
-- Se mueve el helper a `public`, que es donde viven los demás helpers que las
-- policies invocan (`current_user_can`, `current_user_can_in_business`,
-- `is_staff`, `current_business_id`), con SECURITY DEFINER y EXECUTE acotado.
-- NO se concede USAGE sobre `private`: ese esquema sigue cerrado a propósito.
--
-- La función sigue siendo SECURITY DEFINER por el mismo motivo que en la Fase B:
-- una subconsulta invoker sobre `comprobantes` quedaría filtrada por la RLS que
-- la propia Fase B endureció y respondería "no está vinculado" justo para el
-- actor que hay que frenar. Devuelve un booleano sobre un dato que el actor ya
-- puede conocer por `orders.comprobante_id`, así que no agrega superficie.
CREATE OR REPLACE FUNCTION public.comprobante_is_order_linked(p_comprobante_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.comprobantes c
     WHERE c.id = p_comprobante_id AND c.order_id IS NOT NULL
  );
$$;

ALTER FUNCTION public.comprobante_is_order_linked(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.comprobante_is_order_linked(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.comprobante_is_order_linked(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.comprobante_is_order_linked(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.comprobante_is_order_linked(uuid) TO service_role;

COMMENT ON FUNCTION public.comprobante_is_order_linked(uuid) IS
  'SEC-08A Fase C — ¿este comprobante documenta una orden? SECURITY DEFINER '
  'porque se usa dentro de policies: una subconsulta invoker quedaría filtrada '
  'por la RLS de comprobantes y respondería que NO está vinculado justo para el '
  'actor sin capacidad. Vive en public y con EXECUTE para authenticated porque '
  'la expresión de una policy corre con los privilegios de quien consulta.';

-- La policy de la Fase B apuntaba al helper inalcanzable: se reapunta al de
-- `public`. Misma semántica, ahora efectivamente evaluable.
DROP POLICY IF EXISTS comprobante_items_select ON public.comprobante_items;
CREATE POLICY comprobante_items_select ON public.comprobante_items
  FOR SELECT
  USING (
    business_id = public.current_user_business_id()
    AND (
      NOT public.comprobante_is_order_linked(comprobante_id)
      OR public.current_user_can_in_business(business_id, 'orders_view_financials')
    )
  );

-- El helper de `private` se retira más abajo, DESPUÉS de repuntar las dos
-- policies: mientras alguna lo referencie, PostgreSQL rechaza el DROP.

-- ─────────────────────────────────────────────────────────────────────────────
-- Política de lectura de pagos
-- ─────────────────────────────────────────────────────────────────────────────
-- Se conserva la distinción que estableció la Fase B:
--
--   comprobante SUELTO (order_id IS NULL)
--     -> lo gobierna la capacidad `comprobantes`, como hasta hoy. El mostrador y
--        el POS no pierden nada: sus pagos se siguen viendo igual.
--
--   comprobante VINCULADO A UNA ORDEN (order_id IS NOT NULL)
--     -> además exige `orders_view_financials` EN EL MISMO NEGOCIO. Es verdad
--        financiera de la orden y se rige por la capacidad de la orden.
--
-- Dos decisiones de implementación, ambas por motivos ya medidos en este lote:
--
--   1. La capacidad se resuelve con `current_user_can_in_business(business_id,…)`,
--      no con `current_user_can(...)`. La fila SABE a qué negocio pertenece, así
--      que la autoridad se ata a ese negocio y no al perfil que la resolución
--      ciega elija por `updated_at` — un timestamp que mueve cualquier escritura.
--      Esto incluye la capacidad `comprobantes`, que antes también era ciega.
--
--   2. La relación con la orden se pregunta con
--      `private.comprobante_is_order_linked`, que es SECURITY DEFINER. Una
--      subconsulta normal dentro de una policy se evalúa con los privilegios del
--      invocador: consultar `comprobantes` desde acá quedaría filtrado por la RLS
--      de `comprobantes` —que la Fase B ya endureció— y devolvería "no está
--      vinculado" para el actor sin capacidad. Es decir: el caso que hay que
--      cerrar se auto-declararía inocente. Ya existe y se reutiliza; no se crea
--      una segunda fuente de verdad de la relación.
--
-- `comprobante_id` es NOT NULL con FK a `comprobantes(id)`, así que el helper
-- siempre recibe un id real y no hace falta contemplar un NULL.
DROP POLICY IF EXISTS cp_select_comprobantes_capability ON public.comprobante_payments;

CREATE POLICY cp_select_comprobantes_capability ON public.comprobante_payments
  FOR SELECT
  TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_can_in_business(business_id, 'comprobantes')
    AND (
      NOT public.comprobante_is_order_linked(comprobante_id)
      OR public.current_user_can_in_business(business_id, 'orders_view_financials')
    )
  );

COMMENT ON TABLE public.comprobante_payments IS
  'SEC-08A Fase C — los pagos de un comprobante VINCULADO a una orden exigen '
  'orders_view_financials en ese mismo negocio: su suma es la cobranza de la '
  'orden (trig_comprobante_payment_sync la refleja en comprobantes.total_cobrado, '
  'de donde v_order_financial_status deriva total_cobrado). Los pagos de un '
  'comprobante suelto siguen gobernados sólo por la capacidad comprobantes. '
  'Escrituras: sin cambios (la tabla ya era de sólo lectura para el browser '
  'desde LOTE 3; las mutaciones van por RPC canónica).';

-- Ya no queda ninguna policy apuntando al helper inalcanzable: se retira para
-- que nadie lo vuelva a usar por costumbre.
DROP FUNCTION IF EXISTS private.comprobante_is_order_linked(uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- Postcondiciones
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_qual text;
  v_cnt int;
BEGIN
  SELECT qual::text INTO v_qual
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'comprobante_payments'
     AND policyname = 'cp_select_comprobantes_capability';

  IF v_qual IS NULL THEN
    RAISE EXCEPTION 'SEC-08A/C: no existe la policy de lectura de comprobante_payments';
  END IF;
  IF v_qual NOT LIKE '%current_user_can_in_business%' THEN
    RAISE EXCEPTION 'SEC-08A/C: la lectura de pagos no usa autoridad ligada al tenant';
  END IF;
  IF v_qual LIKE '%current_user_can(%' THEN
    RAISE EXCEPTION 'SEC-08A/C: la lectura de pagos conserva una decisión de capacidad ciega al tenant';
  END IF;
  IF v_qual NOT LIKE '%comprobante_is_order_linked%' THEN
    RAISE EXCEPTION 'SEC-08A/C: la lectura de pagos no distingue el comprobante vinculado a una orden';
  END IF;
  IF v_qual NOT LIKE '%orders_view_financials%' THEN
    RAISE EXCEPTION 'SEC-08A/C: la lectura de pagos no exige orders_view_financials para lo vinculado a una orden';
  END IF;
  IF v_qual NOT LIKE '%comprobantes%' THEN
    RAISE EXCEPTION 'SEC-08A/C: la lectura de pagos perdió la autoridad comercial de comprobantes';
  END IF;

  -- Una SEGUNDA policy permissive de SELECT se OR-earía con ésta y la anularía.
  SELECT count(*) INTO v_cnt
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'comprobante_payments'
     AND cmd = 'SELECT' AND permissive = 'PERMISSIVE';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'SEC-08A/C: hay % policies PERMISSIVE de SELECT sobre comprobante_payments; dos se OR-ean y abren el bypass', v_cnt;
  END IF;

  -- El helper de relación TIENE que ser SECURITY DEFINER o la policy se miente.
  IF NOT (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'comprobante_is_order_linked') THEN
    RAISE EXCEPTION 'SEC-08A/C: comprobante_is_order_linked dejó de ser SECURITY DEFINER';
  END IF;

  -- …y TIENE que ser EJECUTABLE por el browser, o toda policy que lo invoque
  -- responde 42501 a todo el mundo. Éste es el defecto que traía la Fase B: un
  -- error de privilegio se confunde con una denegación correcta.
  IF NOT has_function_privilege('authenticated', 'public.comprobante_is_order_linked(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC-08A/C: authenticated no puede ejecutar el helper; las policies que lo usan romperían para TODOS';
  END IF;
  IF has_function_privilege('anon', 'public.comprobante_is_order_linked(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC-08A/C: anon alcanza el helper de relación';
  END IF;
  -- No se abrió el esquema cerrado para lograrlo.
  IF has_schema_privilege('authenticated', 'private', 'USAGE') THEN
    RAISE EXCEPTION 'SEC-08A/C: se concedió USAGE sobre private; el esquema debe seguir cerrado';
  END IF;
  -- Y la policy de la Fase B ya no apunta a un helper inalcanzable.
  IF (SELECT qual::text FROM pg_policies
       WHERE schemaname='public' AND tablename='comprobante_items' AND policyname='comprobante_items_select')
     LIKE '%private.comprobante_is_order_linked%' THEN
    RAISE EXCEPTION 'SEC-08A/C: comprobante_items sigue apuntando al helper inalcanzable de private';
  END IF;

  -- RLS activa: sin esto la policy es decorativa.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.comprobante_payments'::regclass) THEN
    RAISE EXCEPTION 'SEC-08A/C: RLS desactivada en comprobante_payments';
  END IF;

  -- Escritura: la tabla sigue siendo de sólo lectura para el browser (LOTE 3).
  IF has_table_privilege('authenticated', 'public.comprobante_payments', 'INSERT')
     OR has_table_privilege('authenticated', 'public.comprobante_payments', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.comprobante_payments', 'DELETE') THEN
    RAISE EXCEPTION 'SEC-08A/C: el browser ganó escritura directa sobre comprobante_payments';
  END IF;

  -- FASE A y FASE B intactas.
  IF has_column_privilege('authenticated', 'public.orders', 'total_cost', 'SELECT')
     OR has_column_privilege('authenticated', 'public.orders', 'device_password', 'SELECT') THEN
    RAISE EXCEPTION 'SEC-08A/C: se reabrió una columna protegida de orders';
  END IF;
  IF has_column_privilege('authenticated', 'public.order_items', 'precio_unitario', 'SELECT')
     OR has_column_privilege('authenticated', 'public.order_parts', 'sale_price', 'SELECT') THEN
    RAISE EXCEPTION 'SEC-08A/C: se reabrió una columna de importe de línea';
  END IF;
  IF pg_get_functiondef('public.get_order_financial_amounts(uuid,uuid[])'::regprocedure)
       NOT LIKE '%current_user_can_in_business%' THEN
    RAISE EXCEPTION 'SEC-08A/C: la ruta de importes perdió la autoridad tenant-bound';
  END IF;
  IF (SELECT qual::text FROM pg_policies
       WHERE schemaname='public' AND tablename='comprobantes' AND policyname='comprobantes_select')
     NOT LIKE '%current_user_can_in_business%' THEN
    RAISE EXCEPTION 'SEC-08A/C: se revirtió el cierre del pivot de comprobantes';
  END IF;
END
$post$;

COMMIT;

-- Cambios de datos: ninguno. Esta migración sólo reescribe una policy de SELECT.
