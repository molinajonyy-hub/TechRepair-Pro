-- SEC-08A — Fase B. Cierre de los pivots de verdad financiera de la orden.
--
-- La Fase A cerró la lectura cruda de `public.orders`. La revisión independiente
-- demostró, contra PostgREST real y con valores testigo, que el contrato del lote
-- todavía era FALSO por tres caminos. Este lote cierra los tres.
--
--   P1-1 · Autoridad ciega al tenant.
--          `get_order_financial_amounts(p_business_id, …)` verificaba la
--          PERTENENCIA contra `p_business_id`, pero la CAPACIDAD con
--          `current_user_can()`, que resuelve UN perfil del actor sin filtrar por
--          negocio (`ORDER BY (business_id IS NOT NULL) DESC, updated_at DESC
--          LIMIT 1`). Medido: un usuario `admin` en A y `tech` en B pedía los
--          importes de B, pasaba la pertenencia por su perfil de B y la capacidad
--          por su perfil de A. La autoridad del baseline
--          (`user_can_view_order_amounts(p_business_id, …)`) sí era tenant-bound,
--          así que esto fue una REGRESIÓN de la Fase A.
--
--   P1-2 · Pivot por `comprobantes`.
--          `comprobantes_select` gateaba sólo por tenant. Un `tech` o un `viewer`
--          con `orders_view_financials = false` leía
--          `total / total_bruto / total_cobrado / saldo_pendiente / payment_status`
--          filtrando por `comprobantes.order_id`. No es "otra capacidad de
--          negocio": `v_order_financial_status` —la vista que la ruta canónica
--          gatea— deriva `total_comprobado`, `total_cobrado` y `saldo_pendiente`
--          sumando EXACTAMENTE esas columnas agrupadas por `order_id`. Mismo dato,
--          un join de distancia. `comprobante_items` es el mismo pivot a nivel
--          línea.
--
--   P1-3 · Reconstrucción exacta por `order_items`.
--          `recalculate_order_total()` DEFINE las columnas protegidas:
--            estimated_total = SUM(precio_unitario * cantidad)
--            total_cost      = SUM(costo_unitario  * cantidad)
--          `order_items` se gateaba sólo por pertenencia (ni `is_staff` ni
--          capacidad) y `authenticated` tenía SELECT de tabla. Medido: un `tech`
--          y un `viewer` reconstruyeron 8000 y 1500 EXACTOS. `order_parts`
--          (`internal_cost`, `sale_price`, y los márgenes que se derivan de
--          ambos) es la misma familia por `is_staff()`, que incluye tech y viewer.
--
-- Principio aplicado, el mismo que funcionó en `orders`: las columnas OPERATIVAS
-- siguen siendo legibles y las FINANCIERAS dejan de serlo; los importes salen por
-- una ruta canónica gateada por capacidad. No se crea ninguna fuente de verdad
-- nueva: las rutas nuevas leen las mismas tablas base.
--
-- NO se toca: la frontera de columnas de `orders`, `device_password`,
-- `reveal_order_device_access`, RLS de `orders`, el puente legacy de Mobile2A,
-- ni ningún cálculo financiero.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Núcleo de capacidades compartido (evita que las dos autoridades divergan)
-- ─────────────────────────────────────────────────────────────────────────────
-- `current_user_can` y la variante tenant-aware tienen que decidir con la MISMA
-- tabla de defaults y la MISMA semántica de override. Duplicar el CASE era
-- garantizar que en seis meses digan cosas distintas. Se factoriza el núcleo y
-- las dos lo llaman; el orden de evaluación se preserva EXACTAMENTE como estaba:
--
--   role NULL            -> false
--   key 'personal_finance'-> false
--   default desconocido  -> false   (ANTES del atajo de owner: una clave que no
--                                    existe es false incluso para el owner)
--   role 'owner'         -> true    (ignora overrides, como hasta hoy)
--   override booleano    -> lo que diga
--   default              -> el default del rol
CREATE OR REPLACE FUNCTION private.capability_resolve(
  p_role text,
  p_perms jsonb,
  p_key text
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_default boolean;
  v_override jsonb;
BEGIN
  IF p_role IS NULL OR p_key IS NULL THEN RETURN false; END IF;
  IF p_key = 'personal_finance' THEN RETURN false; END IF;

  v_default := CASE p_key
    WHEN 'orders' THEN p_role IN ('admin','manager','tech','sales','cashier','viewer')
    WHEN 'orders_create' THEN p_role IN ('admin','manager','tech','sales','cashier')
    WHEN 'device_access_secret' THEN p_role IN ('admin','manager','tech')
    WHEN 'orders_change_status' THEN p_role IN ('admin','manager','tech','sales')
    WHEN 'orders_view_financials' THEN p_role IN ('admin','manager','sales','cashier')
    WHEN 'inventory' THEN p_role IN ('admin','manager','sales')
    WHEN 'inventory_view_costs' THEN p_role IN ('admin','manager')
    WHEN 'customers' THEN p_role IN ('admin','manager','sales','cashier')
    WHEN 'finance' THEN p_role IN ('admin','cashier')
    WHEN 'comprobantes' THEN p_role IN ('admin','manager','sales','cashier')
    WHEN 'reports' THEN p_role IN ('admin','manager','cashier')
    WHEN 'settings' THEN p_role IN ('admin')
    WHEN 'settings_sensitive' THEN p_role IN ('admin')
    WHEN 'subscription' THEN false
    WHEN 'users' THEN p_role IN ('admin')
    WHEN 'personal_finance' THEN false
    WHEN 'wholesale' THEN p_role IN ('admin','manager','sales')
    ELSE NULL
  END;

  IF v_default IS NULL THEN RETURN false; END IF;
  IF p_role = 'owner' THEN RETURN true; END IF;

  IF p_perms IS NOT NULL AND jsonb_typeof(p_perms) = 'object' THEN
    v_override := p_perms -> p_key;
    IF v_override IS NOT NULL AND jsonb_typeof(v_override) = 'boolean' THEN
      RETURN (v_override)::text::boolean;
    END IF;
  END IF;

  RETURN v_default;
END;
$$;

ALTER FUNCTION private.capability_resolve(text, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.capability_resolve(text, jsonb, text) FROM PUBLIC;

COMMENT ON FUNCTION private.capability_resolve(text, jsonb, text) IS
  'SEC-08A Fase B — núcleo de capacidades. Única tabla de defaults y única '
  'semántica de override, compartida por current_user_can() y '
  'current_user_can_in_business(). No resuelve identidad: recibe rol y permisos '
  'ya resueltos por quien la llama.';

-- `current_user_can` conserva su contrato EXACTO (identidad y resolución de
-- perfil sin cambios); sólo delega la decisión al núcleo compartido.
CREATE OR REPLACE FUNCTION public.current_user_can(p_key text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid uuid; v_role text; v_perms jsonb;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL OR p_key IS NULL THEN RETURN false; END IF;

  SELECT p.role, p.permissions INTO v_role, v_perms
    FROM public.profiles p
   WHERE COALESCE(p.user_id, p.id) = v_uid AND COALESCE(p.is_active, true)
   ORDER BY (p.business_id IS NOT NULL) DESC,
            COALESCE(p.updated_at, p.created_at, now()) DESC LIMIT 1;

  RETURN private.capability_resolve(v_role, v_perms, p_key);
END;
$$;

ALTER FUNCTION public.current_user_can(text) OWNER TO postgres;

-- ─────────────────────────────────────────────────────────────────────────────
-- P1-1. Autoridad de capacidad ligada al tenant
-- ─────────────────────────────────────────────────────────────────────────────
-- Deriva TODO —identidad, estado activo, negocio, rol, override— del MISMO
-- contexto de negocio (`p_business_id`). Nunca puede tomar la capacidad de un
-- perfil de otro tenant.
--
-- El dueño registrado (`businesses.owner_user_id`) se acepta como autoridad del
-- negocio: es la misma rama que ya tenía la autoridad del baseline
-- (`user_can_view_order_amounts`), y sin ella un owner sin perfil con rol
-- 'owner' quedaría fuera de su propio negocio.
CREATE OR REPLACE FUNCTION public.current_user_can_in_business(
  p_business_id uuid,
  p_key text
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid uuid; v_role text; v_perms jsonb;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL OR p_business_id IS NULL OR p_key IS NULL THEN RETURN false; END IF;

  IF EXISTS (
    SELECT 1 FROM public.businesses
     WHERE id = p_business_id AND owner_user_id = v_uid
  ) THEN
    RETURN private.capability_resolve('owner', NULL::jsonb, p_key);
  END IF;

  SELECT p.role, p.permissions INTO v_role, v_perms
    FROM public.profiles p
   WHERE p.business_id = p_business_id
     AND COALESCE(p.user_id, p.id) = v_uid
     AND COALESCE(p.is_active, true)
   ORDER BY COALESCE(p.updated_at, p.created_at, now()) DESC
   LIMIT 1;

  RETURN private.capability_resolve(v_role, v_perms, p_key);
END;
$$;

ALTER FUNCTION public.current_user_can_in_business(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_user_can_in_business(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_user_can_in_business(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.current_user_can_in_business(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_can_in_business(uuid, text) TO service_role;

COMMENT ON FUNCTION public.current_user_can_in_business(uuid, text) IS
  'SEC-08A Fase B — capacidad del actor DENTRO de un negocio concreto. Resuelve '
  'identidad, estado activo, rol y override de permisos en el contexto de '
  'p_business_id, así que la autoridad nunca puede provenir de un perfil de otro '
  'tenant. Respeta overrides en ambos sentidos. Usar siempre que la operación '
  'reciba el business_id por parámetro o lo tenga en la fila.';

-- La ruta canónica de importes pasa a la autoridad tenant-bound.
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

  -- SEC-08A Fase B: la capacidad se resuelve EN p_business_id, el mismo negocio
  -- contra el que se verificó la pertenencia.
  IF NOT public.current_user_can_in_business(p_business_id, 'orders_view_financials') THEN
    RETURN jsonb_build_object('ok', true, 'authorized', false, 'rows', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT s.order_id, s.total_comprobado, s.total_cobrado, s.cobrado_directo,
           s.imputado_cc, s.saldo_pendiente, s.saldo_en_cc, s.deuda_en_cc,
           s.completed_at, s.paid_at, s.ultimo_pago,
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

COMMENT ON FUNCTION public.get_order_financial_amounts(uuid, uuid[]) IS
  'SEC-08A — única ruta autorizada a los importes de una orden. Verifica '
  'pertenencia al tenant y la capacidad orders_view_financials RESUELTA EN ESE '
  'MISMO TENANT (current_user_can_in_business): la autoridad nunca puede venir de '
  'un perfil de otro negocio. Sin permiso devuelve authorized=false y cero filas.';

-- ─────────────────────────────────────────────────────────────────────────────
-- P1-2. Pivot por comprobantes
-- ─────────────────────────────────────────────────────────────────────────────
-- Un comprobante SIN `order_id` es documentación comercial suelta (POS, venta de
-- mostrador) y no dice nada de ninguna orden: su lectura NO se toca, así que los
-- flujos de comprobantes y caja siguen exactamente igual. Un comprobante CON
-- `order_id` ES la verdad financiera de esa orden, y pasa a exigir la capacidad
-- del mismo negocio.
--
-- El helper es SECURITY DEFINER a propósito: una subconsulta dentro de una policy
-- se evalúa con los privilegios del invocador, así que consultar `comprobantes`
-- desde la policy de `comprobante_items` quedaría filtrado por la RLS de
-- `comprobantes` y devolvería el resultado equivocado (falso negativo silencioso).
CREATE OR REPLACE FUNCTION private.comprobante_is_order_linked(p_comprobante_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.comprobantes c
     WHERE c.id = p_comprobante_id AND c.order_id IS NOT NULL
  );
$$;

ALTER FUNCTION private.comprobante_is_order_linked(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.comprobante_is_order_linked(uuid) FROM PUBLIC;

COMMENT ON FUNCTION private.comprobante_is_order_linked(uuid) IS
  'SEC-08A Fase B — ¿este comprobante documenta una orden? SECURITY DEFINER '
  'porque se usa dentro de policies: una subconsulta normal quedaría filtrada por '
  'la RLS de comprobantes y mentiría.';

DROP POLICY IF EXISTS comprobantes_select ON public.comprobantes;
CREATE POLICY comprobantes_select ON public.comprobantes
  FOR SELECT
  USING (
    business_id = public.current_user_business_id()
    AND (
      order_id IS NULL
      OR public.current_user_can_in_business(business_id, 'orders_view_financials')
    )
  );

DROP POLICY IF EXISTS comprobante_items_select ON public.comprobante_items;
CREATE POLICY comprobante_items_select ON public.comprobante_items
  FOR SELECT
  USING (
    business_id = public.current_user_business_id()
    AND (
      NOT private.comprobante_is_order_linked(comprobante_id)
      OR public.current_user_can_in_business(business_id, 'orders_view_financials')
    )
  );

-- `v_order_payment_state` es `security_invoker` sobre `comprobantes`. Con las
-- filas ya gateadas, un actor sin capacidad recibiría el LEFT JOIN vacío y la
-- vista le diría 'sin_facturar' para una orden efectivamente facturada: una
-- verdad financiera FABRICADA, que es justo lo que el lote prohíbe. Se le agrega
-- el predicado de capacidad para que devuelva CERO FILAS en vez de mentir.
-- Denegado no es 'sin facturar'.
CREATE OR REPLACE VIEW public.v_order_payment_state
WITH (security_invoker = true) AS
 WITH comps AS (
         SELECT c.order_id,
            c.business_id,
            count(*) AS comprobantes_vigentes,
            sum(COALESCE(c.total_bruto, c.total_ars, c.total, 0::numeric)) AS t_total,
            sum(COALESCE(c.total_cobrado, 0::numeric)) AS t_cobrado,
            sum(COALESCE(c.saldo_pendiente, 0::numeric)) AS t_saldo,
            sum(COALESCE(( SELECT sum(al.amount) AS sum
                   FROM public.customer_account_payment_allocations al
                  WHERE al.comprobante_id = c.id AND al.status = 'active'::text), 0::numeric)) AS t_imputado,
            (array_agg(c.id ORDER BY (COALESCE(c.fecha, c.date, c.created_at)) DESC))[1] AS comprobante_id,
            (array_agg(COALESCE(c.numero_fiscal, c.numero, c.number) ORDER BY (COALESCE(c.fecha, c.date, c.created_at)) DESC))[1] AS comprobante_numero,
            max((COALESCE(c.fecha, c.date, c.created_at) AT TIME ZONE 'America/Argentina/Cordoba'::text)::date) AS fecha_comprobante
           FROM public.comprobantes c
          WHERE c.order_id IS NOT NULL AND c.estado <> 'anulado'::text AND COALESCE(c.estado_comercial, ''::text) <> 'anulado'::text AND COALESCE(c.status, ''::text) <> 'cancelled'::text AND COALESCE(c.tipo, c.type) <> 'nota_credito'::text
          GROUP BY c.order_id, c.business_id
        )
 SELECT o.id AS order_id,
    o.business_id,
    o.status AS estado_tecnico,
        CASE
            WHEN COALESCE(k.comprobantes_vigentes, 0::bigint) = 0 THEN 'sin_facturar'::text
            WHEN (COALESCE(k.t_saldo, 0::numeric) - COALESCE(k.t_imputado, 0::numeric)) <= 1.00 THEN 'paid'::text
            WHEN (COALESCE(k.t_cobrado, 0::numeric) + COALESCE(k.t_imputado, 0::numeric)) > 0::numeric THEN 'partial'::text
            ELSE 'pending'::text
        END AS payment_status,
    COALESCE(k.comprobantes_vigentes, 0::bigint) AS comprobantes_vigentes,
    k.comprobante_id,
    k.comprobante_numero,
    k.fecha_comprobante
   FROM public.orders o
     LEFT JOIN comps k ON k.order_id = o.id
  WHERE public.current_user_can_in_business(o.business_id, 'orders_view_financials');

COMMENT ON VIEW public.v_order_payment_state IS
  'SEC-08A Fase B — estado de cobro por orden, SIN importes. Exige '
  'orders_view_financials en el negocio de la orden: sin la capacidad devuelve '
  'cero filas, nunca ''sin_facturar'' fabricado.';

-- ─────────────────────────────────────────────────────────────────────────────
-- P1-3. Reconstrucción exacta por order_items / order_parts
-- ─────────────────────────────────────────────────────────────────────────────
-- Mismo diseño que `orders`: retirar el GRANT de tabla habilita el GRANT por
-- columna (mientras exista el privilegio a nivel tabla, PostgreSQL lo considera
-- suficiente para cualquier columna). Se conservan INSERT/UPDATE/DELETE y las
-- policies: esto es visibilidad, no autoridad de escritura.
--
-- `cantidad` / `quantity` siguen siendo legibles: son información operativa del
-- trabajo y, sin los precios, no reconstruyen ningún importe.
REVOKE SELECT ON TABLE public.order_items FROM anon;
REVOKE SELECT ON TABLE public.order_items FROM authenticated;
GRANT SELECT (
  id, order_id, product_id, business_id,
  tipo, descripcion, cantidad, cliente_paga_repuesto,
  created_at, updated_at
) ON TABLE public.order_items TO authenticated;

REVOKE SELECT ON TABLE public.order_parts FROM anon;
REVOKE SELECT ON TABLE public.order_parts FROM authenticated;
GRANT SELECT (
  id, order_id, business_id, name, description, part_number,
  quantity, status, deduct_from_inventory, notes, added_at, created_by,
  cliente_paga_repuesto
) ON TABLE public.order_parts TO authenticated;

COMMENT ON COLUMN public.order_items.precio_unitario IS
  'SEC-08A Fase B — precio de línea al cliente. NO seleccionable por el browser: '
  'orders.estimated_total se define como SUM(precio_unitario * cantidad), así que '
  'leerlo crudo reconstruye el importe protegido exactamente. Ruta canónica: '
  'get_order_line_amounts().';
COMMENT ON COLUMN public.order_items.costo_unitario IS
  'SEC-08A Fase B — costo de línea. NO seleccionable por el browser: '
  'orders.total_cost se define como SUM(costo_unitario * cantidad). Ruta '
  'canónica: get_order_line_amounts().';

-- `v_finance_order_cogs_gaps` expone costos agregados POR ORDEN y no tiene ningún
-- consumidor en el frontend (verificado sobre todo `src/`). Es una herramienta de
-- auditoría financiera: se retira del browser en vez de gatearla fila a fila.
REVOKE SELECT ON public.v_finance_order_cogs_gaps FROM anon;
REVOKE SELECT ON public.v_finance_order_cogs_gaps FROM authenticated;

COMMENT ON VIEW public.v_finance_order_cogs_gaps IS
  'SEC-08A Fase B — auditoría de COGS por orden. Sin SELECT para el browser: '
  'exponía costo_atribuible_ars por order_id a cualquier miembro del negocio. '
  'Consumo previsto: service_role / análisis financiero.';

-- Ruta canónica para los importes de línea, para quien SÍ tiene la capacidad.
-- No es una fuente de verdad nueva: lee las mismas dos tablas base, una sola vez
-- por lote de órdenes.
CREATE OR REPLACE FUNCTION public.get_order_line_amounts(
  p_business_id uuid,
  p_order_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_member boolean := false;
  v_items jsonb;
  v_parts jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED');
  END IF;

  SELECT (
    EXISTS (
      SELECT 1 FROM public.businesses
       WHERE id = p_business_id AND owner_user_id = v_actor
    )
    OR EXISTS (
      SELECT 1 FROM public.profiles
       WHERE business_id = p_business_id
         AND COALESCE(user_id, id) = v_actor
         AND COALESCE(is_active, true) = true
    )
  ) INTO v_member;

  IF NOT v_member THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN');
  END IF;

  IF NOT public.current_user_can_in_business(p_business_id, 'orders_view_financials') THEN
    RETURN jsonb_build_object('ok', true, 'authorized', false,
                              'items', '[]'::jsonb, 'parts', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(i)), '[]'::jsonb) INTO v_items
  FROM (
    SELECT oi.id, oi.order_id, oi.precio_unitario, oi.costo_unitario
      FROM public.order_items oi
     WHERE oi.business_id = p_business_id
       AND (p_order_ids IS NULL OR oi.order_id = ANY (p_order_ids))
  ) i;

  SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb) INTO v_parts
  FROM (
    SELECT op.id, op.order_id, op.internal_cost, op.sale_price,
           op.margin_amount, op.margin_percentage
      FROM public.order_parts op
     WHERE op.business_id = p_business_id
       AND (p_order_ids IS NULL OR op.order_id = ANY (p_order_ids))
  ) p;

  RETURN jsonb_build_object('ok', true, 'authorized', true,
                            'items', v_items, 'parts', v_parts);
END;
$$;

ALTER FUNCTION public.get_order_line_amounts(uuid, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_order_line_amounts(uuid, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_order_line_amounts(uuid, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_order_line_amounts(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_line_amounts(uuid, uuid[]) TO service_role;

COMMENT ON FUNCTION public.get_order_line_amounts(uuid, uuid[]) IS
  'SEC-08A Fase B — única ruta autorizada a los importes de línea de una orden '
  '(order_items.precio_unitario/costo_unitario, order_parts.internal_cost/'
  'sale_price/márgenes). Misma autoridad que get_order_financial_amounts: '
  'pertenencia + orders_view_financials resuelta en ese tenant. Sin permiso, '
  'authorized=false y cero filas.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Postcondiciones
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_col text;
BEGIN
  -- P1-3: columnas financieras de línea cerradas, operativas intactas.
  FOREACH v_col IN ARRAY ARRAY['precio_unitario','costo_unitario'] LOOP
    IF has_column_privilege('authenticated', 'public.order_items', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'SEC-08A/B: authenticated todavía puede leer order_items.%', v_col;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['internal_cost','sale_price','margin_amount','margin_percentage'] LOOP
    IF has_column_privilege('authenticated', 'public.order_parts', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'SEC-08A/B: authenticated todavía puede leer order_parts.%', v_col;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['id','order_id','tipo','descripcion','cantidad','cliente_paga_repuesto'] LOOP
    IF NOT has_column_privilege('authenticated', 'public.order_items', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'SEC-08A/B: se perdió la columna operativa order_items.%', v_col;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['id','order_id','name','quantity','status','part_number'] LOOP
    IF NOT has_column_privilege('authenticated', 'public.order_parts', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'SEC-08A/B: se perdió la columna operativa order_parts.%', v_col;
    END IF;
  END LOOP;

  -- La escritura NO se toca: el flujo de alta de ítems/repuestos sigue vivo.
  IF NOT has_table_privilege('authenticated', 'public.order_items', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.order_items', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.order_items', 'DELETE') THEN
    RAISE EXCEPTION 'SEC-08A/B: se rompió la escritura de order_items';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.order_parts', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.order_parts', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.order_parts', 'DELETE') THEN
    RAISE EXCEPTION 'SEC-08A/B: se rompió la escritura de order_parts';
  END IF;

  -- P1-2: las dos policies exigen la capacidad tenant-aware para lo order-linked.
  IF (SELECT qual::text FROM pg_policies
       WHERE schemaname='public' AND tablename='comprobantes' AND policyname='comprobantes_select')
     NOT LIKE '%current_user_can_in_business%' THEN
    RAISE EXCEPTION 'SEC-08A/B: comprobantes_select no exige la capacidad tenant-aware';
  END IF;
  IF (SELECT qual::text FROM pg_policies
       WHERE schemaname='public' AND tablename='comprobante_items' AND policyname='comprobante_items_select')
     NOT LIKE '%current_user_can_in_business%' THEN
    RAISE EXCEPTION 'SEC-08A/B: comprobante_items_select no exige la capacidad tenant-aware';
  END IF;

  -- P1-1: la ruta de importes ya no usa la autoridad ciega al tenant.
  IF pg_get_functiondef('public.get_order_financial_amounts(uuid,uuid[])'::regprocedure)
       NOT LIKE '%current_user_can_in_business(p_business_id, ''orders_view_financials'')%' THEN
    RAISE EXCEPTION 'SEC-08A/B: la ruta de importes no usa autoridad tenant-bound';
  END IF;

  -- Vistas.
  IF has_table_privilege('authenticated', 'public.v_finance_order_cogs_gaps', 'SELECT') THEN
    RAISE EXCEPTION 'SEC-08A/B: v_finance_order_cogs_gaps sigue alcanzable por el browser';
  END IF;
  IF pg_get_viewdef('public.v_order_payment_state'::regclass, true)
       NOT LIKE '%current_user_can_in_business%' THEN
    RAISE EXCEPTION 'SEC-08A/B: v_order_payment_state podría fabricar sin_facturar';
  END IF;

  -- FASE A intacta.
  FOREACH v_col IN ARRAY ARRAY['estimated_total','labor_cost','total_cost','amount_paid','paid_at','device_password'] LOOP
    IF has_column_privilege('authenticated', 'public.orders', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'SEC-08A/B: se reabrió public.orders.%', v_col;
    END IF;
  END LOOP;
  IF NOT has_column_privilege('authenticated', 'public.orders', 'device_password', 'UPDATE') THEN
    RAISE EXCEPTION 'SEC-08A/B: se rompió el dual-write legacy de Mobile2A';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.reveal_order_device_access(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC-08A/B: la ruta canónica del secreto no es alcanzable';
  END IF;

  -- Rutas nuevas: alcanzables por el browser, cerradas para anon.
  IF NOT has_function_privilege('authenticated', 'public.get_order_line_amounts(uuid,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.current_user_can_in_business(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC-08A/B: las rutas canónicas nuevas no son alcanzables';
  END IF;
  IF has_function_privilege('anon', 'public.get_order_line_amounts(uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.current_user_can_in_business(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC-08A/B: anon alcanza una ruta canónica nueva';
  END IF;
END
$post$;

COMMIT;

-- Cambios de datos: ninguno. Esta migración sólo mueve privilegios, reemplaza
-- definiciones de función/vista y reescribe dos policies de SELECT.
