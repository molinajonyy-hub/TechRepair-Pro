-- Pre-beta cleanup: canonical profile identity for order amount authorization.
--
-- Current invitation/provisioning flows create profiles with:
--   profiles.id = auth.uid(), profiles.user_id = NULL
-- Legacy profiles may still have both columns populated. COALESCE preserves the
-- legacy match while allowing the canonical id fallback. Roles, tenant checks,
-- active-state semantics, SECURITY DEFINER, search_path and grants are unchanged.

CREATE OR REPLACE FUNCTION public.user_can_view_order_amounts(
  p_business_id uuid,
  p_user_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    p_business_id IS NOT NULL AND p_user_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
          FROM public.businesses
         WHERE id = p_business_id
           AND owner_user_id = p_user_id
      )
      OR EXISTS (
        SELECT 1
          FROM public.profiles
         WHERE business_id = p_business_id
           AND COALESCE(user_id, id) = p_user_id
           AND COALESCE(is_active, true) = true
           AND role IN ('owner', 'admin', 'manager', 'cashier', 'sales')
      )
    );
$$;

ALTER FUNCTION public.user_can_view_order_amounts(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.user_can_view_order_amounts(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.user_can_view_order_amounts(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.user_can_view_order_amounts(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_view_order_amounts(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.user_can_view_order_amounts(uuid, uuid) IS
  'P0-A.1U1V — Autoriza importes de órdenes para owner/admin/manager/cashier/sales '
  'activos del tenant. Resuelve perfiles por COALESCE(user_id, id). Tech, viewer '
  'y roles futuros permanecen fail-closed.';

-- get_order_financial_amounts performs a membership check before calling the
-- helper. It must use the same canonical identity or a new invited cashier/sales
-- would still return FORBIDDEN before reaching the corrected authorization.
CREATE OR REPLACE FUNCTION public.get_order_financial_amounts(
  p_business_id uuid,
  p_order_ids uuid[]
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

  SELECT (
    EXISTS (
      SELECT 1
        FROM public.businesses
       WHERE id = p_business_id
         AND owner_user_id = v_actor
    )
    OR EXISTS (
      SELECT 1
        FROM public.profiles
       WHERE business_id = p_business_id
         AND COALESCE(user_id, id) = v_actor
         AND COALESCE(is_active, true) = true
    )
  ) INTO v_member;

  IF NOT v_member THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN');
  END IF;

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

ALTER FUNCTION public.get_order_financial_amounts(uuid, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_order_financial_amounts(uuid, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_order_financial_amounts(uuid, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_order_financial_amounts(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_financial_amounts(uuid, uuid[]) TO service_role;

COMMENT ON FUNCTION public.get_order_financial_amounts(uuid, uuid[]) IS
  'P0-A.1U1V — Importes de órdenes, sólo para quien tiene la capacidad. Sin '
  'permiso devuelve authorized=false y cero filas: el monto NO sale del servidor. '
  'Una consulta por lote de órdenes, nunca una por fila.';

-- Data changes: none. This migration only replaces function definitions.
