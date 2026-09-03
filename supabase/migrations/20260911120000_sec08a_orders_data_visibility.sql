-- SEC-08A — Orders data visibility.
--
-- Problema medido en el stack local con PostgREST real (evidencia en
-- docs/security-sec08a/): la policy `orders_select` es
-- `business_id = current_business_id() AND is_staff()`. Eso es una frontera de
-- FILAS. No dice nada sobre COLUMNAS, y `authenticated` tenía SELECT sobre la
-- tabla entera, así que:
--
--   * un `tech` o un `viewer` (orders_view_financials = false) recibía
--     total_cost / estimated_total / labor_cost / amount_paid / paid_at en un
--     GET directo a /orders y también anidado en /customers?select=orders(...);
--   * un `sales`, `cashier` o `viewer` (device_access_secret = false) recibía
--     `device_password` en claro por el mismo camino.
--
-- Que la UI no lo dibuje es irrelevante: el valor cruzaba la red. Este lote
-- mueve la decisión al servidor.
--
-- Diseño (mínimo, sin fuentes de verdad nuevas):
--
--   1. GRANT de SELECT por columna sobre `public.orders`. Las columnas
--      financieras (O1) y el secreto del equipo (O2) dejan de ser
--      seleccionables por el browser. La tabla cruda deja de ser un bypass:
--      `select=*` sobre esas columnas responde 42501, no las devuelve en NULL.
--
--   2. La ruta autorizada para los importes sigue siendo la que ya existía,
--      `get_order_financial_amounts` (P0-A.1U1). Se le agregan las columnas
--      propias de la orden que antes se leían crudas, y su autorización pasa a
--      ser la capacidad `orders_view_financials` — no una lista de roles
--      hardcodeada — para que los overrides por perfil valgan en los dos
--      sentidos. No se toca `user_can_view_order_amounts`, que tiene otros tres
--      consumidores en cuenta corriente.
--
--   3. La ruta autorizada para el secreto ya existe y no se duplica:
--      `reveal_order_device_access` (Mobile2A), on-demand, con Vault, gate por
--      `device_access_secret` y auditoría. `orders.device_password` sigue
--      siendo el shadow legacy ESCRIBIBLE que Mobile2A necesita durante la
--      ventana de compatibilidad: acá sólo se cierra su LECTURA.
--
-- No se tocan: RLS, políticas, INSERT/UPDATE/DELETE, el trigger espejo de
-- Mobile2A, ni ningún cálculo financiero. `orders.total_cost` sigue siendo el
-- COGS que escribe `recalculate_order_total`; este lote no cambia qué
-- significa, sólo quién puede leerlo.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Frontera de columnas sobre public.orders
-- ─────────────────────────────────────────────────────────────────────────────
-- `anon` nunca tuvo una policy de SELECT sobre orders (todas son para
-- `authenticated`), así que su GRANT de tabla era privilegio muerto. Se retira.
REVOKE SELECT ON TABLE public.orders FROM anon;

-- Retirar el GRANT de tabla es lo que habilita el GRANT por columna: mientras
-- exista el privilegio a nivel tabla, PostgreSQL lo considera suficiente para
-- cualquier columna y el listado explícito no restringe nada.
REVOKE SELECT ON TABLE public.orders FROM authenticated;

GRANT SELECT (
  -- O0 operativas
  status,
  priority,
  notes,
  access_mode,
  created_at,
  updated_at,
  completed_at,
  -- O3 identidad / vínculos internos
  id,
  business_id,
  customer_id,
  device_id,
  technician_id,
  assigned_profile_id,
  created_by,
  comprobante_id
) ON TABLE public.orders TO authenticated;

COMMENT ON COLUMN public.orders.device_password IS
  'SEC-08A — shadow legacy de Mobile2A. Escribible (el trigger '
  'mobile2a_mirror_legacy_device_password lo refleja a Vault); NO seleccionable '
  'por el browser. La lectura canónica es reveal_order_device_access(), '
  'protegida por la capacidad device_access_secret. Formato: '
  'pattern:0-4-8 | pin:1234 | text:abc';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Ruta canónica autorizada para los importes de la orden
-- ─────────────────────────────────────────────────────────────────────────────
-- Misma función, mismo contrato de respuesta ({ok, authorized, rows}), mismos
-- grants. Cambian dos cosas:
--   * la autoridad pasa a ser public.current_user_can('orders_view_financials'),
--     que respeta profiles.permissions en ambos sentidos (default false +
--     override true, y default true + override false). La verificación de
--     pertenencia al tenant se conserva tal cual;
--   * las filas incorporan las columnas propias de la orden que el browser ya
--     no puede leer crudas. Los importes derivados (total_comprobado,
--     total_cobrado, saldo_pendiente, …) siguen saliendo de
--     v_order_financial_status: no se agrega ninguna fuente de verdad nueva ni
--     se recalcula nada.
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

  IF NOT public.current_user_can('orders_view_financials') THEN
    RETURN jsonb_build_object('ok', true, 'authorized', false, 'rows', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT s.order_id, s.total_comprobado, s.total_cobrado, s.cobrado_directo,
           s.imputado_cc, s.saldo_pendiente, s.saldo_en_cc, s.deuda_en_cc,
           s.completed_at, s.paid_at, s.ultimo_pago,
           -- Columnas propias de la orden (O1). Antes viajaban crudas.
           o.estimated_total, o.estimated_total_currency, o.labor_cost,
           o.total_cost, o.amount_paid
      FROM public.v_order_financial_status s
      JOIN public.orders o
        ON o.id = s.order_id
       AND o.business_id = s.business_id
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
  'SEC-08A — única ruta autorizada a los importes de una orden. Verifica '
  'pertenencia al tenant y la capacidad orders_view_financials (respeta '
  'overrides de perfil). Sin permiso devuelve authorized=false y cero filas: el '
  'monto NO sale del servidor. Devuelve los derivados de '
  'v_order_financial_status más las columnas O1 propias de orders, que el '
  'browser ya no puede leer crudas. Una consulta por lote, nunca una por fila.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Postcondiciones
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_col text;
  v_denied text[] := ARRAY[
    'estimated_total','estimated_total_currency','labor_cost','total_cost',
    'amount_paid','paid_at','device_password'
  ];
  v_allowed text[] := ARRAY[
    'id','business_id','customer_id','device_id','technician_id',
    'assigned_profile_id','created_by','comprobante_id','status','priority',
    'notes','access_mode','created_at','updated_at','completed_at'
  ];
BEGIN
  FOREACH v_col IN ARRAY v_denied LOOP
    IF has_column_privilege('authenticated', 'public.orders', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'SEC-08A: authenticated todavía puede leer public.orders.%', v_col;
    END IF;
    IF has_column_privilege('anon', 'public.orders', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'SEC-08A: anon todavía puede leer public.orders.%', v_col;
    END IF;
  END LOOP;

  FOREACH v_col IN ARRAY v_allowed LOOP
    IF NOT has_column_privilege('authenticated', 'public.orders', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'SEC-08A: authenticated perdió la columna operativa public.orders.%', v_col;
    END IF;
  END LOOP;

  IF has_table_privilege('anon', 'public.orders', 'SELECT') THEN
    RAISE EXCEPTION 'SEC-08A: anon conserva SELECT sobre public.orders';
  END IF;

  -- La escritura del shadow legacy de Mobile2A NO se toca.
  IF NOT has_column_privilege('authenticated', 'public.orders', 'device_password', 'UPDATE') THEN
    RAISE EXCEPTION 'SEC-08A: se rompió el dual-write legacy de Mobile2A sobre device_password';
  END IF;

  IF pg_get_functiondef('public.get_order_financial_amounts(uuid,uuid[])'::regprocedure)
       NOT LIKE '%current_user_can(''orders_view_financials'')%' THEN
    RAISE EXCEPTION 'SEC-08A: la ruta canónica de importes no verifica orders_view_financials';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.reveal_order_device_access(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC-08A: la ruta canónica del secreto del equipo no es alcanzable';
  END IF;
END
$post$;

COMMIT;

-- Cambios de datos: ninguno. Esta migración sólo mueve privilegios y reemplaza
-- una definición de función.
