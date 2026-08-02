-- ============================================================================
-- P0-A.1U1V — Los IMPORTES de una orden se restringen por permiso, server-side.
--
-- PROBLEMA: v_order_financial_status devuelve estado Y montos, y su RLS sólo
-- aísla por negocio. Cualquier perfil activo —incluido un técnico— que veía la
-- orden veía también total, saldo y crédito del cliente. Ocultarlos con un `if`
-- en React no es una restricción: el dato ya viajó al browser.
--
-- ESTRATEGIA (§5, opción C + B): se usa el mecanismo canónico que el proyecto ya
-- tiene para capacidades —`user_can_override_price` / `user_can_sell_below_cost`,
-- funciones SQL STABLE SECURITY DEFINER que evalúan owner OR rol— y se separan
-- DOS superficies:
--
--   · v_order_payment_state   -> estado SIN importes. GRANT a authenticated.
--                                Alimenta badges y filtros para TODOS los roles.
--   · v_order_financial_status -> con importes. Se REVOCA de authenticated y
--                                queda accesible sólo por la RPC de abajo.
--   · get_order_financial_amounts() -> SECURITY DEFINER: valida pertenencia al
--                                negocio Y la capacidad; sin permiso devuelve
--                                CERO filas, nunca importes en cero.
--
-- Así el servidor nunca entrega un monto que el rol no puede ver: no hay nada
-- que ocultar después.
--
-- ROLLBACK documentado al final.
-- ============================================================================

-- ── §1. Capacidad canónica ──────────────────────────────────────────────────
-- Contrato de producto aprobado: owner, admin, manager, cashier y sales pueden
-- ver importes; tech y viewer NO (fail-closed: cualquier rol futuro que no esté
-- en la lista queda denegado).
CREATE OR REPLACE FUNCTION "public"."user_can_view_order_amounts"(
  "p_business_id" uuid, "p_user_id" uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    p_business_id IS NOT NULL AND p_user_id IS NOT NULL
    AND (
      EXISTS (SELECT 1 FROM public.businesses
               WHERE id = p_business_id AND owner_user_id = p_user_id)
      OR EXISTS (
        SELECT 1 FROM public.profiles
         WHERE business_id = p_business_id AND user_id = p_user_id
           AND COALESCE(is_active, true) = true
           AND role IN ('owner', 'admin', 'manager', 'cashier', 'sales')
      )
    );
$$;
ALTER FUNCTION "public"."user_can_view_order_amounts"(uuid, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."user_can_view_order_amounts"(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."user_can_view_order_amounts"(uuid, uuid) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."user_can_view_order_amounts"(uuid, uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."user_can_view_order_amounts"(uuid, uuid) TO "service_role";

COMMENT ON FUNCTION "public"."user_can_view_order_amounts"(uuid, uuid) IS
  'P0-A.1U1V — ¿Este usuario puede ver los IMPORTES de las órdenes del negocio? '
  'Mismo patrón que user_can_override_price. Fail-closed: tech y viewer quedan '
  'fuera, y cualquier rol nuevo también hasta que se lo agregue explícitamente.';

-- ── §2. Estado SIN importes: lo que puede ver cualquier rol ────────────────
-- IMPORTANTE: se construye desde las TABLAS BASE, no desde
-- v_order_financial_status. Con security_invoker una vista derivada hereda los
-- privilegios del invocador, así que apoyarse en la vista restringida haría que
-- un tech recibiera "permission denied" al leer el estado — probado, no supuesto.
-- Duplica el predicado de vigencia y el CASE, pero NUNCA proyecta un importe.
CREATE OR REPLACE VIEW "public"."v_order_payment_state"
  WITH (security_invoker = true) AS
WITH comps AS (
  SELECT
    c.order_id,
    c.business_id,
    count(*)                                                  AS comprobantes_vigentes,
    SUM(COALESCE(c.total_bruto, c.total_ars, c.total, 0))      AS t_total,
    SUM(COALESCE(c.total_cobrado, 0))                          AS t_cobrado,
    SUM(COALESCE(c.saldo_pendiente, 0))                        AS t_saldo,
    SUM(COALESCE((SELECT SUM(al.amount) FROM public.customer_account_payment_allocations al
                   WHERE al.comprobante_id = c.id AND al.status = 'active'), 0)) AS t_imputado,
    (array_agg(c.id ORDER BY COALESCE(c.fecha, c.date, c.created_at) DESC))[1] AS comprobante_id,
    (array_agg(COALESCE(c.numero_fiscal, c.numero, c.number)
               ORDER BY COALESCE(c.fecha, c.date, c.created_at) DESC))[1]      AS comprobante_numero,
    MAX((COALESCE(c.fecha, c.date, c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date) AS fecha_comprobante
  FROM public.comprobantes c
  WHERE c.order_id IS NOT NULL
    AND c.estado <> 'anulado'
    AND COALESCE(c.estado_comercial, '') <> 'anulado'
    AND COALESCE(c.status, '') <> 'cancelled'
    AND COALESCE(c.tipo, c.type) <> 'nota_credito'
  GROUP BY 1, 2
)
SELECT
  o.id           AS order_id,
  o.business_id,
  o.status       AS estado_tecnico,
  -- Mismo criterio y misma tolerancia que v_order_financial_status. Los montos
  -- se usan para DECIDIR el estado, pero no se proyectan como columnas.
  CASE
    WHEN COALESCE(k.comprobantes_vigentes, 0) = 0 THEN 'sin_facturar'
    WHEN COALESCE(k.t_saldo, 0) - COALESCE(k.t_imputado, 0) <= 1.00 THEN 'paid'
    WHEN COALESCE(k.t_cobrado, 0) + COALESCE(k.t_imputado, 0) > 0   THEN 'partial'
    ELSE 'pending'
  END AS payment_status,
  COALESCE(k.comprobantes_vigentes, 0) AS comprobantes_vigentes,
  k.comprobante_id,
  k.comprobante_numero,
  k.fecha_comprobante
FROM public.orders o
LEFT JOIN comps k ON k.order_id = o.id;

COMMENT ON VIEW "public"."v_order_payment_state" IS
  'P0-A.1U1V — Estado de cobro de la orden SIN importes. Es la superficie que ve '
  'cualquier rol con acceso al negocio: alimenta el badge y el filtro financiero '
  'sin revelar totales, saldo ni crédito. Los montos van por '
  'get_order_financial_amounts(), que evalúa la capacidad.';

ALTER VIEW "public"."v_order_payment_state" OWNER TO "postgres";
GRANT SELECT ON "public"."v_order_payment_state" TO "authenticated";
GRANT SELECT ON "public"."v_order_payment_state" TO "service_role";

-- ── §3. La vista con importes deja de ser accesible al cliente ─────────────
-- No se elimina: la usan el helper de recompute y v_order_payment_state, ambos
-- server-side. Lo que se cierra es la lectura directa desde el browser.
REVOKE SELECT ON "public"."v_order_financial_status" FROM "authenticated";

-- ── §4. Importes, sólo con permiso ─────────────────────────────────────────
-- Devuelve jsonb para poder distinguir tres situaciones que la UI debe mostrar
-- distinto: sin permiso (importes restringidos), error (no disponible) y ok.
CREATE OR REPLACE FUNCTION "public"."get_order_financial_amounts"(
  "p_business_id" uuid,
  "p_order_ids"   uuid[]
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_member boolean := false;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED');
  END IF;

  -- Pertenencia al negocio: sin esto no se responde nada, ni siquiera "sin permiso".
  SELECT (EXISTS (SELECT 1 FROM public.businesses
                   WHERE id = p_business_id AND owner_user_id = v_actor)
       OR EXISTS (SELECT 1 FROM public.profiles
                   WHERE business_id = p_business_id AND user_id = v_actor
                     AND COALESCE(is_active, true) = true))
    INTO v_member;
  IF NOT v_member THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN');
  END IF;

  -- Capacidad. Sin ella se devuelve authorized=false y NINGUNA fila: el importe
  -- no sale del servidor. No se devuelven ceros ni columnas en NULL.
  IF NOT public.user_can_view_order_amounts(p_business_id, v_actor) THEN
    RETURN jsonb_build_object('ok', true, 'authorized', false, 'rows', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT s.order_id, s.total_comprobado, s.total_cobrado, s.cobrado_directo,
           s.imputado_cc, s.saldo_pendiente, s.saldo_en_cc, s.deuda_en_cc,
           s.completed_at, s.paid_at, s.ultimo_pago
    FROM public.v_order_financial_status s
    WHERE s.business_id = p_business_id
      AND (p_order_ids IS NULL OR s.order_id = ANY (p_order_ids))
  ) x;

  RETURN jsonb_build_object('ok', true, 'authorized', true, 'rows', v_rows);
END;
$$;
ALTER FUNCTION "public"."get_order_financial_amounts"(uuid, uuid[]) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."get_order_financial_amounts"(uuid, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."get_order_financial_amounts"(uuid, uuid[]) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."get_order_financial_amounts"(uuid, uuid[]) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_order_financial_amounts"(uuid, uuid[]) TO "service_role";

COMMENT ON FUNCTION "public"."get_order_financial_amounts"(uuid, uuid[]) IS
  'P0-A.1U1V — Importes de órdenes, sólo para quien tiene la capacidad. Sin '
  'permiso devuelve authorized=false y cero filas: el monto NO sale del servidor. '
  'Una consulta por lote de órdenes, nunca una por fila.';

-- ── §5. El crédito no imputado también es un importe ───────────────────────
REVOKE SELECT ON "public"."v_customer_unallocated_credit" FROM "authenticated";

CREATE OR REPLACE FUNCTION "public"."get_customer_unallocated_credit"(
  "p_business_id" uuid, "p_customer_id" uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_total numeric;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED');
  END IF;
  IF NOT public.user_can_view_order_amounts(p_business_id, v_actor) THEN
    RETURN jsonb_build_object('ok', true, 'authorized', false);
  END IF;
  SELECT COALESCE(SUM(c.unallocated_amount), 0) INTO v_total
    FROM public.v_customer_unallocated_credit c
   WHERE c.business_id = p_business_id AND c.customer_id = p_customer_id;
  RETURN jsonb_build_object('ok', true, 'authorized', true, 'unallocated_amount', v_total);
END;
$$;
ALTER FUNCTION "public"."get_customer_unallocated_credit"(uuid, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."get_customer_unallocated_credit"(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."get_customer_unallocated_credit"(uuid, uuid) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."get_customer_unallocated_credit"(uuid, uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_customer_unallocated_credit"(uuid, uuid) TO "service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   GRANT SELECT ON v_order_financial_status TO authenticated;
--   GRANT SELECT ON v_customer_unallocated_credit TO authenticated;
--   DROP FUNCTION get_customer_unallocated_credit(uuid, uuid);
--   DROP FUNCTION get_order_financial_amounts(uuid, uuid[]);
--   DROP VIEW v_order_payment_state;
--   DROP FUNCTION user_can_view_order_amounts(uuid, uuid);
-- ============================================================================
