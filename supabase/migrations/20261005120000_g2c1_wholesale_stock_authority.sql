-- ============================================================================
-- G2-C.1 · Autoridad del pedido mayorista: la base decide el estado, el
-- navegador deja de escribir stock.
--
-- CONTRATO (decision de producto, Opcion A)
-- -----------------------------------------
--   PEDIDO MAYORISTA = ESTADO COMERCIAL.
--   COMPROBANTE      = MOVIMIENTO ECONOMICO Y DE STOCK.
--
-- Un pedido mayorista registra intencion comercial y pasa por estados. NINGUN
-- estado mueve inventario: ni approved, ni rejected, ni cancelled, ni invoiced,
-- ni delivered. La unica salida real de stock de un pedido mayorista ocurre al
-- convertirlo en comprobante por el checkout canonico
-- (private.create_comprobante_checkout_atomic), que conserva inventory_id y
-- registra el COGS. Esta migracion NO crea un segundo writer de inventario.
--
-- POR QUE (discovery, docs/g2c1-wholesale-stock-discovery.md)
-- ----------------------------------------------------------
--   1. portalService._processWholesaleStock escribia stock desde el navegador
--      con `Math.max(0, prev + delta)` -el clamp que G2-C elimino en la DB- y
--      sin atomicidad ni lock. Era INALCANZABLE desde la UI (el caller de los
--      botones nunca paso businessId), pero volverlo alcanzable habria
--      duplicado la salida del checkout al convertir el pedido en comprobante.
--   2. El cambio de estado era un UPDATE directo desde el navegador.
--   3. El cliente del portal podia crear su pedido con cualquier `status` e
--      insertar items con marcadores de stock arbitrarios.
--   4. `quantity` no tenia CHECK.
--
-- Produccion (lecturas read-only del 2026-09-22): 0 wholesale_orders,
-- 0 wholesale_order_items, 0 stock_processed=true, 0 quantity<=0,
-- 0 inventory_movements con reference_type='wholesale_order'. No hay legado
-- que preservar: la seccion 0 lo verifica al aplicar y ABORTA si ya no es cierto.
--
-- QUE HACE
-- --------
--   1. RPC public.update_wholesale_order_status_atomic: unica escritura
--      administrativa de status/admin_notes. SECURITY DEFINER porque, cerrado
--      el UPDATE directo, `authenticated` ya no puede escribir la fila.
--   2. Cierra el UPDATE directo de wholesale_orders y wholesale_order_items.
--   3. RPC public.create_wholesale_order_atomic: unica alta de pedidos. La base
--      decide tenant, cliente habilitado, productos, PRECIO y totales, y crea
--      pedido + items en una transaccion. El INSERT directo se cierra entero.
--   4. CHECK (quantity > 0) en wholesale_order_items.
--   5. wholesale_customers: el cliente solo escribe last_login y el alta neutra;
--      approved/suspended/notes los administra el staff por
--      public.update_wholesale_customer_status_atomic.
--
-- REVISION HUMANA DEL PR #144 (blockers que cierran las secciones 3 y 5)
--   B1. wholesale_customers permitia autoaprobarse, des-suspenderse, mudar la
--       fila de negocio y escribir estadisticas.
--   B2. el INSERT de un pedido no ataba order.business_id al negocio del cliente.
--   B3. el INSERT de items no ataba item -> pedido -> inventario al mismo tenant.
--   B4. precio, subtotales y total del pedido los decidia el navegador.
--
-- QUE NO HACE (explicito)
-- -----------------------
--   · No toca inventory, inventory_movements ni los marcadores stock_* desde
--     ningun camino nuevo. Los marcadores quedan en el schema, congelados en
--     estado neutro para todo lo que escriba el navegador.
--   · No toca public.repair_missing_stock_movements ni StockRepairTool: siguen
--     pudiendo reprocesar un pedido ya convertido (riesgo residual separado).
--   · No toca el checkout ni vincula comprobante <-> pedido mayorista.
--   · No resuelve G2-C.2 (locks compatibles de los demas writers de inventory).
-- ============================================================================

BEGIN;

-- ── 0. PRECONDICIONES (fail-closed) ─────────────────────────────────────────
DO $pre$
DECLARE
  v_n bigint;
BEGIN
  -- Los helpers canonicos de autoridad existen por FIRMA EXACTA.
  IF to_regprocedure('public.current_user_can_in_business(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'G2-C.1: falta public.current_user_can_in_business(uuid,text)';
  END IF;
  IF to_regprocedure('public.current_user_business_id()') IS NULL THEN
    RAISE EXCEPTION 'G2-C.1: falta public.current_user_business_id()';
  END IF;
  IF to_regprocedure('public.business_has_feature(text)') IS NULL THEN
    RAISE EXCEPTION 'G2-C.1: falta public.business_has_feature(text)';
  END IF;

  -- La autoridad del portal que reusa el alta.
  IF to_regprocedure('public.get_wholesale_portal_features(text)') IS NULL THEN
    RAISE EXCEPTION 'G2-C.1: falta public.get_wholesale_portal_features(text)';
  END IF;

  -- Ningun overload previo con los mismos nombres: haria ambiguo el contrato.
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_proc p
   WHERE p.proname IN ('update_wholesale_order_status_atomic',
                       'create_wholesale_order_atomic',
                       'update_wholesale_customer_status_atomic');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'G2-C.1: ya existe alguna de las RPC de G2-C.1 (%): revisar a mano', v_n;
  END IF;

  -- El slug del portal identifica UN negocio: el alta resuelve el tenant por el.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index x
      JOIN pg_catalog.pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
     WHERE x.indrelid = 'public.businesses'::regclass
       AND x.indisunique AND x.indnatts = 1
       AND a.attname = 'wholesale_portal_slug'
  ) THEN
    RAISE EXCEPTION 'G2-C.1: wholesale_portal_slug dejo de ser UNIQUE';
  END IF;

  -- El alta del cliente nace neutra por DEFAULT: approved y suspended en false.
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'wholesale_customers'
         AND column_name IN ('approved', 'suspended', 'whatsapp_verified')
         AND column_default = 'false') <> 3 THEN
    RAISE EXCEPTION 'G2-C.1: cambiaron los DEFAULT administrativos de wholesale_customers';
  END IF;

  -- Sin legado: la decision de producto se tomo sobre 0 filas procesadas.
  SELECT count(*) INTO v_n
    FROM public.wholesale_order_items
   WHERE stock_processed IS TRUE
      OR stock_processed_at IS NOT NULL
      OR stock_movement_id IS NOT NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'G2-C.1: hay % item(s) mayoristas con marcadores de stock. '
      'La Opcion A se decidio sobre 0 filas: revisar antes de aplicar.', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM public.inventory_movements
   WHERE reference_type = 'wholesale_order';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'G2-C.1: hay % movimiento(s) de inventario de pedidos mayoristas. '
      'La Opcion A se decidio sobre 0 filas: revisar antes de aplicar.', v_n;
  END IF;

  -- El CHECK de cantidad no puede encontrar datos incompatibles.
  SELECT count(*) INTO v_n FROM public.wholesale_order_items WHERE quantity <= 0;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'G2-C.1: hay % item(s) mayoristas con quantity <= 0', v_n;
  END IF;

  -- El estado inicial canonico es el DEFAULT real de la columna.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'wholesale_orders'
       AND column_name = 'status'
       AND column_default = '''pending_whatsapp''::text'
  ) THEN
    RAISE EXCEPTION 'G2-C.1: el DEFAULT de wholesale_orders.status dejo de ser pending_whatsapp';
  END IF;
END
$pre$;

-- ── 1. RPC canonica de cambio de estado ─────────────────────────────────────
-- Autoridad: la MISMA que tenia la policy de escritura, pero tenant-bound y
-- respetando overrides.
--   · current_user_can_in_business(p_business_id, 'wholesale'): identidad
--     (auth.uid()), perfil ACTIVO de ESE negocio, rol y override de
--     permissions, todo del mismo contexto. Defaults: owner/admin/manager/sales,
--     los mismos cuatro roles que can_manage_wholesale().
--   · current_user_business_id() = p_business_id y business_has_feature
--     ('mayorista'): lo mismo que exigia wo_staff_update. No se replica la
--     tabla de planes: se reusa el helper canonico sobre el mismo negocio.
-- Un cliente del portal no tiene perfil en `profiles`: queda fuera por
-- construccion. No hay p_user_id: la identidad sale de auth.uid().
--
-- Maquina de estados: NO se inventa una. La base acepta cualquiera de los 7
-- estados del CHECK, igual que antes; el grafo de transiciones vive en la UI
-- (Mayorista.tsx) y la conversion a comprobante marca `invoiced` desde
-- cualquier estado no terminal. Ningun estado mueve stock, asi que no hay
-- transicion que pueda dejar el inventario inconsistente.
--
-- Idempotencia: repetir el mismo estado (y las mismas notas) no escribe la
-- fila: updated_at no cambia y `changed` vuelve en false.
-- p_admin_notes NULL conserva las notas; '' (o solo espacios) las borra.
CREATE FUNCTION public.update_wholesale_order_status_atomic(
  p_business_id uuid,
  p_order_id    uuid,
  p_status      text,
  p_admin_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_order   record;
  v_notes   text;
  v_changed boolean;
  v_updated timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION 'business_id y order_id son obligatorios' USING ERRCODE = '22023';
  END IF;

  IF NOT public.current_user_can_in_business(p_business_id, 'wholesale') THEN
    -- Generico a proposito: no confirma si el negocio o el pedido existen.
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF public.current_user_business_id() IS DISTINCT FROM p_business_id
     OR NOT public.business_has_feature('mayorista') THEN
    RAISE EXCEPTION 'Forbidden: el plan del negocio no incluye el modulo mayorista'
      USING ERRCODE = '42501';
  END IF;

  IF p_status IS NULL OR p_status NOT IN (
       'pending_whatsapp', 'pending_review', 'approved', 'rejected',
       'invoiced', 'delivered', 'cancelled') THEN
    RAISE EXCEPTION 'INVALID_STATUS: %', COALESCE(p_status, '(null)') USING ERRCODE = '22023';
  END IF;

  -- El pedido, de ESTE negocio, bloqueado hasta el COMMIT. Un pedido de otro
  -- tenant es indistinguible de uno inexistente.
  SELECT o.id, o.status, o.admin_notes, o.updated_at
    INTO v_order
    FROM public.wholesale_orders o
   WHERE o.id = p_order_id
     AND o.business_id = p_business_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WHOLESALE_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_notes := CASE
               WHEN p_admin_notes IS NULL THEN v_order.admin_notes
               ELSE NULLIF(btrim(p_admin_notes), '')
             END;
  v_changed := v_order.status IS DISTINCT FROM p_status
            OR v_order.admin_notes IS DISTINCT FROM v_notes;

  IF v_changed THEN
    UPDATE public.wholesale_orders
       SET status      = p_status,
           admin_notes = v_notes,
           updated_at  = now()
     WHERE id = v_order.id
    RETURNING updated_at INTO v_updated;
  ELSE
    v_updated := v_order.updated_at;
  END IF;

  RETURN jsonb_build_object(
    'ok',              true,
    'order_id',        v_order.id,
    'business_id',     p_business_id,
    'status',          p_status,
    'previous_status', v_order.status,
    'admin_notes',     v_notes,
    'changed',         v_changed,
    'updated_at',      v_updated
  );
END;
$$;

ALTER FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text) OWNER TO postgres;

-- Grants minimos. EXECUTE a PUBLIC es el default de PostgreSQL y un stack
-- fresco puede dar EXECUTE EXPLICITO a anon/service_role por default
-- privileges: se revocan los tres por nombre. service_role no tiene
-- auth.uid() y no tiene nada que hacer aca.
REVOKE ALL ON FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text) IS
  'G2-C.1 — unica escritura administrativa de wholesale_orders.status/admin_notes. '
  'Autoridad: current_user_can_in_business(p_business_id, ''wholesale'') + feature '
  'mayorista del mismo negocio. Bloquea el pedido (FOR UPDATE). NO mueve stock: la '
  'salida de inventario de un pedido mayorista ocurre solo al convertirlo en '
  'comprobante por el checkout canonico. Idempotente ante el mismo estado.';

-- ── 2. Cierre del UPDATE directo ────────────────────────────────────────────
-- Discovery: el UNICO UPDATE legitimo desde el navegador sobre estas dos
-- tablas era portalService.updateOrderStatus (status/admin_notes/updated_at) y
-- _processWholesaleStock (marcadores). Los dos se reemplazan en este lote.
-- Ninguna Edge Function escribe estas tablas. wholesale_customers tiene su
-- propio cierre, por columnas, en la seccion 5.
-- Se quitan grant Y policy: una policy sin grant es una puerta que el proximo
-- GRANT reabre sin que nadie lo note.
DROP POLICY IF EXISTS wo_staff_update  ON public.wholesale_orders;
DROP POLICY IF EXISTS woi_staff_update ON public.wholesale_order_items;
REVOKE UPDATE ON TABLE public.wholesale_orders      FROM PUBLIC, anon, authenticated;
REVOKE UPDATE ON TABLE public.wholesale_order_items FROM PUBLIC, anon, authenticated;

-- ── 3. Alta canonica del pedido: RPC atomica, la base es autoridad ──────────
-- Revision humana del PR #144 (Blockers 2, 3 y 4). El INSERT directo desde el
-- navegador dejaba en manos del cliente:
--   · el tenant: wo_customer_insert validaba el customer_id propio pero NO que
--     order.business_id fuera el negocio de ese cliente (A podia dejar un
--     pedido en B);
--   · el ata item -> pedido -> inventario: woi_customer_insert no probaba
--     item.business_id = order.business_id ni inventory.business_id;
--   · el PRECIO y los totales: unit_price/subtotal/total/product_name/
--     product_code viajaban desde el navegador como verdad;
--   · la aprobacion: un cliente no aprobado o suspendido podia pedir llamando
--     directo aunque la UI lo bloqueara;
--   · la atomicidad: encabezado e items eran dos INSERT separados; si fallaba
--     el segundo quedaba un pedido huerfano sin items.
--
-- public.create_wholesale_order_atomic(p_portal_slug, p_items, p_notes):
--   · identidad por auth.uid(); no recibe customer_id ni business_id.
--   · negocio: se resuelve por el SLUG del portal (UNIQUE en businesses), con
--     la MISMA autoridad que usa el portal para decidir si toma pedidos:
--     public.get_wholesale_portal_features(p_slug) -> mayorista AND active
--     (portal encendido + plan + suscripcion no suspendida). No se replica la
--     tabla de planes.
--   · cliente: el wholesale_customers del actor EN ESE negocio, exactamente
--     uno, approved = true y suspended = false. Bloqueado FOR UPDATE.
--   · items: array no vacio de {inventory_item_id, quantity}; quantity entero
--     > 0; sin repetidos. Cualquier otra clave (unit_price, product_name, ...)
--     se IGNORA: no es autoridad.
--   · cada producto: del MISMO negocio, is_active y visible_in_wholesale (el
--     contrato del catalogo, PortalCatalog/getCatalog). El stock NO se exige:
--     el pedido no reserva stock y la sobreventa esta permitida (G2-C); la
--     disponibilidad se confirma en la revision.
--   · precio: la regla del catalogo, en la base:
--       precio_mayorista > 0 ? precio_mayorista : sale_price
--     nombre y codigo salen de inventory. Subtotal por linea y total del
--     pedido se calculan aca.
--   · order_number server-side. status = DEFAULT (pending_whatsapp),
--     admin_notes NULL, marcadores en sus defaults (false/NULL/NULL).
--   · last_order_at del cliente lo escribe la RPC (el navegador ya no puede).
--     total_orders/total_spent NO se tocan: la RPC que el cliente llamaba para
--     eso (increment_wholesale_customer_stats) no existe en ninguna migracion,
--     asi que hoy nunca se actualizan; darles semantica nueva queda fuera.
--   · todo en UNA transaccion: cualquier fallo revierte pedido e items.
CREATE FUNCTION public.create_wholesale_order_atomic(
  p_portal_slug text,
  p_items       jsonb,
  p_notes       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_features jsonb;
  v_business uuid;
  v_n        bigint;
  v_customer record;
  v_elem     jsonb;
  v_inv_id   uuid;
  v_qty      numeric;
  v_inv      record;
  v_price    numeric;
  v_seen     uuid[] := ARRAY[]::uuid[];
  v_lines    jsonb := '[]'::jsonb;
  v_total    numeric := 0;
  v_order    record;
  v_number   text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_portal_slug IS NULL OR btrim(p_portal_slug) = '' THEN
    RAISE EXCEPTION 'portal_slug es obligatorio' USING ERRCODE = '22023';
  END IF;

  -- El portal acepta pedidos: la misma decision que toma el portal.
  v_features := public.get_wholesale_portal_features(p_portal_slug);
  IF v_features IS NULL
     OR (v_features->>'mayorista') IS DISTINCT FROM 'true'
     OR (v_features->>'active')    IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'PORTAL_NOT_ACCEPTING_ORDERS' USING ERRCODE = '42501';
  END IF;

  SELECT b.id INTO v_business
    FROM public.businesses b
   WHERE b.wholesale_portal_enabled = true
     AND b.wholesale_portal_slug = p_portal_slug;
  IF v_business IS NULL THEN
    RAISE EXCEPTION 'PORTAL_NOT_ACCEPTING_ORDERS' USING ERRCODE = '42501';
  END IF;

  -- El cliente del actor EN ESTE negocio. Ninguno o mas de uno: fail-closed.
  SELECT count(*) INTO v_n
    FROM public.wholesale_customers wc
   WHERE wc.auth_user_id = v_actor
     AND wc.business_id = v_business;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Forbidden: no es cliente mayorista de este portal' USING ERRCODE = '42501';
  END IF;

  SELECT wc.id, wc.approved, wc.suspended
    INTO v_customer
    FROM public.wholesale_customers wc
   WHERE wc.auth_user_id = v_actor
     AND wc.business_id = v_business
   FOR UPDATE;

  IF v_customer.approved IS NOT TRUE THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_APPROVED' USING ERRCODE = '42501';
  END IF;
  IF v_customer.suspended IS TRUE THEN
    RAISE EXCEPTION 'CUSTOMER_SUSPENDED' USING ERRCODE = '42501';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'EMPTY_ORDER' USING ERRCODE = '22023';
  END IF;

  FOR v_elem IN SELECT e.value FROM jsonb_array_elements(p_items) AS e LOOP
    IF jsonb_typeof(v_elem) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_elem->'inventory_item_id') IS DISTINCT FROM 'string'
       OR (v_elem->>'inventory_item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR jsonb_typeof(v_elem->'quantity') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'INVALID_ITEM: cada item necesita inventory_item_id y quantity' USING ERRCODE = '22023';
    END IF;

    v_inv_id := (v_elem->>'inventory_item_id')::uuid;
    v_qty    := (v_elem->>'quantity')::numeric;

    IF v_qty <= 0 OR v_qty <> trunc(v_qty) OR v_qty > 2147483647 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY: %', v_qty USING ERRCODE = '22023';
    END IF;
    IF v_inv_id = ANY (v_seen) THEN
      RAISE EXCEPTION 'DUPLICATE_ITEM: %', v_inv_id USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_inv_id;

    -- Mismo negocio, activo y visible en el catalogo mayorista. Un producto de
    -- otro tenant es indistinguible de uno inexistente.
    SELECT i.id, i.name, i.code, i.sale_price, i.precio_mayorista
      INTO v_inv
      FROM public.inventory i
     WHERE i.id = v_inv_id
       AND i.business_id = v_business
       AND i.is_active IS TRUE
       AND i.visible_in_wholesale IS TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_NOT_AVAILABLE: %', v_inv_id USING ERRCODE = 'P0002';
    END IF;

    v_price := CASE WHEN COALESCE(v_inv.precio_mayorista, 0) > 0
                    THEN v_inv.precio_mayorista
                    ELSE v_inv.sale_price END;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'inventory_item_id', v_inv.id,
      'product_name',      v_inv.name,
      'product_code',      v_inv.code,
      'quantity',          v_qty::integer,
      'unit_price',        v_price,
      'subtotal',          v_price * v_qty));
    v_total := v_total + v_price * v_qty;
  END LOOP;

  v_number := 'PW-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

  INSERT INTO public.wholesale_orders(business_id, customer_id, order_number, subtotal, total, notes)
  VALUES (v_business, v_customer.id, v_number, v_total, v_total, NULLIF(btrim(p_notes), ''))
  RETURNING id, order_number, status, subtotal, total, notes, created_at INTO v_order;

  INSERT INTO public.wholesale_order_items(order_id, business_id, inventory_item_id, product_name,
                                           product_code, quantity, unit_price, subtotal)
  SELECT v_order.id, v_business, (l.value->>'inventory_item_id')::uuid, l.value->>'product_name',
         l.value->>'product_code', (l.value->>'quantity')::integer,
         (l.value->>'unit_price')::numeric, (l.value->>'subtotal')::numeric
    FROM jsonb_array_elements(v_lines) AS l;

  UPDATE public.wholesale_customers
     SET last_order_at = now()
   WHERE id = v_customer.id;

  RETURN jsonb_build_object(
    'ok',           true,
    'order_id',     v_order.id,
    'order_number', v_order.order_number,
    'business_id',  v_business,
    'customer_id',  v_customer.id,
    'status',       v_order.status,
    'subtotal',     v_order.subtotal,
    'total',        v_order.total,
    'notes',        v_order.notes,
    'created_at',   v_order.created_at,
    'items',        v_lines
  );
END;
$$;

ALTER FUNCTION public.create_wholesale_order_atomic(text, jsonb, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_wholesale_order_atomic(text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_wholesale_order_atomic(text, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.create_wholesale_order_atomic(text, jsonb, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.create_wholesale_order_atomic(text, jsonb, text) TO authenticated;

COMMENT ON FUNCTION public.create_wholesale_order_atomic(text, jsonb, text) IS
  'G2-C.1 — unica alta de pedidos mayoristas. Identidad por auth.uid(); negocio por '
  'slug con get_wholesale_portal_features; cliente propio aprobado y no suspendido; '
  'productos del mismo negocio, activos y visibles; precio, nombre, codigo, subtotales '
  'y total calculados en la base (precio_mayorista > 0 ? precio_mayorista : sale_price). '
  'Pedido + items en una transaccion, en pending_whatsapp y con marcadores neutros. '
  'NO mueve stock.';

-- Con la RPC como unica alta, el INSERT directo se cierra ENTERO. Discovery de
-- callers: el unico INSERT legitimo en src/ era portalService.createOrder (que
-- pasa a la RPC); ninguna Edge Function escribe estas tablas; ningun flujo de
-- staff crea pedidos o items a mano. Se quitan grant Y policies.
DROP POLICY IF EXISTS wo_customer_insert  ON public.wholesale_orders;
DROP POLICY IF EXISTS wo_staff_insert     ON public.wholesale_orders;
DROP POLICY IF EXISTS woi_customer_insert ON public.wholesale_order_items;
DROP POLICY IF EXISTS woi_staff_insert    ON public.wholesale_order_items;
REVOKE INSERT ON TABLE public.wholesale_orders      FROM PUBLIC, anon, authenticated;
REVOKE INSERT ON TABLE public.wholesale_order_items FROM PUBLIC, anon, authenticated;
-- Por que no un CHECK de tabla sobre los marcadores: aplicaria tambien a
-- public.repair_missing_stock_movements (SECDEF), que hoy puede marcarlos, y
-- la haria abortar entera. Esa herramienta queda fuera de G2-C.1 por decision
-- explicita; se registra como riesgo residual.

-- ── 4. Cantidad estrictamente positiva ──────────────────────────────────────
ALTER TABLE public.wholesale_order_items
  ADD CONSTRAINT wholesale_order_items_quantity_positive CHECK (quantity > 0);

-- ── 5. wholesale_customers: el cliente no administra su propia cuenta ───────
-- Revision humana del PR #144 (Blocker 1). `authenticated` tenia UPDATE e
-- INSERT de TABLA y la policy wc_own_update solo ataba la fila al actor
-- (auth_user_id = auth.uid()), sin limitar columnas. Un cliente del portal
-- podia autoaprobarse, quitarse la suspension, mudar su fila a otro negocio o
-- escribir sus estadisticas; y al registrarse podia nacer approved = true.
--
-- Discovery de escrituras legitimas desde el navegador:
--   · loginCustomer ............ UPDATE last_login          (el propio cliente)
--   · insertWholesaleCustomer .. INSERT del alta            (el propio cliente)
--   · updateCustomerStatus ..... UPDATE approved/suspended  (staff, Mayorista.tsx)
--   · createOrder .............. UPDATE last_order_at       (pasa a la RPC de alta)
--   · otpService ............... UPDATE whatsapp_code/verified — codigo MUERTO:
--     ningun archivo lo importa. Tras este cierre queda denegado, que es lo
--     correcto: una verificacion por OTP no puede decidirse en el navegador.
-- Ninguna UI de staff crea clientes a mano.
--
-- Cierre por COLUMNAS (el privilegio es por rol, igual para cliente y staff):
--   · UPDATE: solo last_login. La policy wc_own_update la limita a la fila
--     propia. La administracion del staff pasa a una RPC (abajo) y se quita
--     wc_staff_update.
--   · INSERT: solo las columnas del alta. approved, suspended, notes, tags,
--     estadisticas, last_* y whatsapp_* no se pueden nombrar: nacen en su
--     DEFAULT (false/false/NULL/NULL/0/0/...). wc_own_insert ademas exige ese
--     estado neutro. wc_staff_insert se quita: ningun flujo lo usa.
-- SELECT no cambia.
CREATE FUNCTION public.update_wholesale_customer_status_atomic(
  p_business_id uuid,
  p_customer_id uuid,
  p_approved    boolean DEFAULT NULL,
  p_suspended   boolean DEFAULT NULL,
  p_notes       text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_c         record;
  v_approved  boolean;
  v_suspended boolean;
  v_notes     text;
  v_changed   boolean;
  v_updated   timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL OR p_customer_id IS NULL THEN
    RAISE EXCEPTION 'business_id y customer_id son obligatorios' USING ERRCODE = '22023';
  END IF;

  -- Misma autoridad que el cambio de estado de pedidos.
  IF NOT public.current_user_can_in_business(p_business_id, 'wholesale') THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF public.current_user_business_id() IS DISTINCT FROM p_business_id
     OR NOT public.business_has_feature('mayorista') THEN
    RAISE EXCEPTION 'Forbidden: el plan del negocio no incluye el modulo mayorista'
      USING ERRCODE = '42501';
  END IF;

  SELECT wc.id, wc.approved, wc.suspended, wc.notes, wc.updated_at
    INTO v_c
    FROM public.wholesale_customers wc
   WHERE wc.id = p_customer_id
     AND wc.business_id = p_business_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WHOLESALE_CUSTOMER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- NULL conserva; notas en blanco se borran.
  v_approved  := COALESCE(p_approved,  v_c.approved);
  v_suspended := COALESCE(p_suspended, v_c.suspended);
  v_notes     := CASE WHEN p_notes IS NULL THEN v_c.notes ELSE NULLIF(btrim(p_notes), '') END;
  v_changed   := v_approved  IS DISTINCT FROM v_c.approved
              OR v_suspended IS DISTINCT FROM v_c.suspended
              OR v_notes     IS DISTINCT FROM v_c.notes;

  IF v_changed THEN
    UPDATE public.wholesale_customers
       SET approved   = v_approved,
           suspended  = v_suspended,
           notes      = v_notes,
           updated_at = now()
     WHERE id = v_c.id
    RETURNING updated_at INTO v_updated;
  ELSE
    v_updated := v_c.updated_at;
  END IF;

  RETURN jsonb_build_object(
    'ok',          true,
    'customer_id', v_c.id,
    'business_id', p_business_id,
    'approved',    v_approved,
    'suspended',   v_suspended,
    'notes',       v_notes,
    'changed',     v_changed,
    'updated_at',  v_updated
  );
END;
$$;

ALTER FUNCTION public.update_wholesale_customer_status_atomic(uuid, uuid, boolean, boolean, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.update_wholesale_customer_status_atomic(uuid, uuid, boolean, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_wholesale_customer_status_atomic(uuid, uuid, boolean, boolean, text) FROM anon;
REVOKE ALL ON FUNCTION public.update_wholesale_customer_status_atomic(uuid, uuid, boolean, boolean, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.update_wholesale_customer_status_atomic(uuid, uuid, boolean, boolean, text) TO authenticated;

COMMENT ON FUNCTION public.update_wholesale_customer_status_atomic(uuid, uuid, boolean, boolean, text) IS
  'G2-C.1 — unica escritura administrativa de wholesale_customers (approved, suspended, '
  'notes). Autoridad: current_user_can_in_business(p_business_id, ''wholesale'') + feature '
  'mayorista del mismo negocio. Bloquea la fila. Idempotente.';

DROP POLICY IF EXISTS wc_staff_update ON public.wholesale_customers;
DROP POLICY IF EXISTS wc_staff_insert ON public.wholesale_customers;

REVOKE UPDATE ON TABLE public.wholesale_customers FROM PUBLIC, anon, authenticated;
GRANT UPDATE (last_login) ON TABLE public.wholesale_customers TO authenticated;

REVOKE INSERT ON TABLE public.wholesale_customers FROM PUBLIC, anon, authenticated;
GRANT INSERT (business_id, auth_user_id, name, business_name, email, whatsapp,
              province, city, instagram)
  ON TABLE public.wholesale_customers TO authenticated;

ALTER POLICY wc_own_insert ON public.wholesale_customers
  WITH CHECK (
    auth_user_id = auth.uid()
    AND approved IS FALSE
    AND suspended IS FALSE
    AND whatsapp_verified IS FALSE
    AND whatsapp_code IS NULL
    AND whatsapp_code_expires_at IS NULL
    AND notes IS NULL
    AND tags IS NULL
    AND total_orders = 0
    AND total_spent = 0
    AND last_order_at IS NULL
  );

-- ── 6. POSTCONDICIONES — contra el catalogo, que es lo que corre ────────────
DO $post$
DECLARE
  v_fn   oid := to_regprocedure('public.update_wholesale_order_status_atomic(uuid,uuid,text,text)');
  v_src  text;
  v_def  text;
  v_col  text;
  v_st   text;
BEGIN
  -- [1] La RPC existe por firma exacta, SECDEF, owner postgres, search_path minimo.
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 1: no existe la firma exacta de la RPC';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = v_fn
       AND p.prosecdef
       AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 1: la RPC no es SECDEF/postgres/search_path=pg_catalog, pg_temp';
  END IF;

  -- [2] Solo authenticated la ejecuta.
  IF pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 2: anon puede ejecutar la RPC';
  END IF;
  IF pg_catalog.has_function_privilege('public', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 2: PUBLIC puede ejecutar la RPC';
  END IF;
  IF NOT pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 2: authenticated no puede ejecutar la RPC';
  END IF;

  -- [3] Autoridad canonica, lock, y NINGUNA escritura de inventario.
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid = v_fn;
  IF v_src NOT LIKE '%public.current_user_can_in_business(p_business_id, ''wholesale'')%' THEN
    RAISE EXCEPTION 'POSTCONDICION 3: la RPC perdio la autoridad tenant-bound';
  END IF;
  IF v_src !~* 'FOR\s+UPDATE' THEN
    RAISE EXCEPTION 'POSTCONDICION 3: la RPC no bloquea el pedido';
  END IF;
  IF v_src ~* '(inventory|stock_processed|stock_movement_id|stock_quantity)' THEN
    RAISE EXCEPTION 'POSTCONDICION 3: la RPC toca inventario o marcadores de stock';
  END IF;

  -- [4] Los 7 estados de la RPC son exactamente los del CHECK.
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public.wholesale_orders'::regclass
     AND c.conname = 'wholesale_orders_status_check';
  IF v_def IS NULL
     OR (length(v_def) - length(replace(v_def, '::text', ''))) / length('::text') <> 7 THEN
    RAISE EXCEPTION 'POSTCONDICION 4: el CHECK de status ya no tiene 7 estados: %', v_def;
  END IF;
  FOREACH v_st IN ARRAY ARRAY['pending_whatsapp','pending_review','approved','rejected',
                              'invoiced','delivered','cancelled'] LOOP
    IF position(quote_literal(v_st) IN v_def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDICION 4: el CHECK de status no contiene %', v_st;
    END IF;
  END LOOP;

  -- [5] Nadie del lado cliente puede hacer UPDATE directo, en ninguna columna.
  FOR v_col IN
    SELECT a.attname FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.wholesale_orders'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    IF pg_catalog.has_column_privilege('authenticated', 'public.wholesale_orders', v_col, 'UPDATE')
       OR pg_catalog.has_column_privilege('anon', 'public.wholesale_orders', v_col, 'UPDATE') THEN
      RAISE EXCEPTION 'POSTCONDICION 5: queda UPDATE directo sobre wholesale_orders.%', v_col;
    END IF;
  END LOOP;
  FOR v_col IN
    SELECT a.attname FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.wholesale_order_items'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    IF pg_catalog.has_column_privilege('authenticated', 'public.wholesale_order_items', v_col, 'UPDATE')
       OR pg_catalog.has_column_privilege('anon', 'public.wholesale_order_items', v_col, 'UPDATE') THEN
      RAISE EXCEPTION 'POSTCONDICION 5: queda UPDATE directo sobre wholesale_order_items.%', v_col;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
     WHERE p.polrelid IN ('public.wholesale_orders'::regclass, 'public.wholesale_order_items'::regclass)
       AND p.polcmd IN ('w', '*')
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 5: queda una policy de UPDATE sobre las tablas mayoristas';
  END IF;

  -- [6] Nadie del lado cliente puede hacer INSERT directo de pedidos ni items,
  --     en ninguna columna, y no queda policy de INSERT: la RPC es la unica alta.
  FOR v_col IN
    SELECT a.attname FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.wholesale_orders'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    IF pg_catalog.has_column_privilege('authenticated', 'public.wholesale_orders', v_col, 'INSERT')
       OR pg_catalog.has_column_privilege('anon', 'public.wholesale_orders', v_col, 'INSERT') THEN
      RAISE EXCEPTION 'POSTCONDICION 6: queda INSERT directo sobre wholesale_orders.%', v_col;
    END IF;
  END LOOP;
  FOR v_col IN
    SELECT a.attname FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.wholesale_order_items'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    IF pg_catalog.has_column_privilege('authenticated', 'public.wholesale_order_items', v_col, 'INSERT')
       OR pg_catalog.has_column_privilege('anon', 'public.wholesale_order_items', v_col, 'INSERT') THEN
      RAISE EXCEPTION 'POSTCONDICION 6: queda INSERT directo sobre wholesale_order_items.%', v_col;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
     WHERE p.polrelid IN ('public.wholesale_orders'::regclass, 'public.wholesale_order_items'::regclass)
       AND p.polcmd = 'a'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 6: queda una policy de INSERT sobre pedidos o items';
  END IF;

  -- [7] La lectura sigue abierta a quien ya la tenia (la RLS decide filas).
  IF NOT pg_catalog.has_table_privilege('authenticated', 'public.wholesale_orders', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('authenticated', 'public.wholesale_order_items', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION 7: authenticated perdio SELECT sobre las tablas mayoristas';
  END IF;

  -- [8] La RPC de alta: firma exacta, SECDEF, owner postgres, search_path
  --     minimo, solo authenticated; autoridad del portal, cliente aprobado,
  --     precio de la base; y NINGUNA escritura de inventario ni marcadores.
  v_fn := to_regprocedure('public.create_wholesale_order_atomic(text,jsonb,text)');
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 8: no existe la firma exacta de create_wholesale_order_atomic';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = v_fn
       AND p.prosecdef
       AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 8: la RPC de alta no es SECDEF/postgres/search_path minimo';
  END IF;
  IF pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', v_fn, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 8: la RPC de alta tiene grants distintos de solo-authenticated';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid = v_fn;
  IF v_src NOT LIKE '%public.get_wholesale_portal_features(p_portal_slug)%'
     OR v_src NOT LIKE '%auth.uid()%'
     OR v_src NOT LIKE '%approved IS NOT TRUE%'
     OR v_src NOT LIKE '%suspended IS TRUE%'
     OR v_src NOT LIKE '%precio_mayorista%'
     OR v_src NOT LIKE '%visible_in_wholesale IS TRUE%'
     OR v_src NOT LIKE '%i.business_id = v_business%' THEN
    RAISE EXCEPTION 'POSTCONDICION 8: la RPC de alta perdio una de sus autoridades';
  END IF;
  IF v_src !~* 'FOR\s+UPDATE' THEN
    RAISE EXCEPTION 'POSTCONDICION 8: la RPC de alta no bloquea al cliente';
  END IF;
  IF v_src ~* '(inventory_movements|stock_processed|stock_movement_id|stock_quantity|UPDATE\s+public\.inventory\M|INSERT\s+INTO\s+public\.inventory\M)' THEN
    RAISE EXCEPTION 'POSTCONDICION 8: la RPC de alta escribe inventario o marcadores';
  END IF;

  -- [9] CHECK de cantidad instalado y validado.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.wholesale_order_items'::regclass
       AND c.conname = 'wholesale_order_items_quantity_positive'
       AND c.contype = 'c' AND c.convalidated
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 9: falta el CHECK quantity > 0 validado';
  END IF;

  -- [10] Ningun trigger mueve stock al cambiar un pedido mayorista.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE NOT t.tgisinternal
       AND t.tgrelid IN ('public.wholesale_orders'::regclass, 'public.wholesale_order_items'::regclass)
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 10: aparecio un trigger sobre las tablas mayoristas';
  END IF;

  -- [11] La RPC de administracion de clientes: firma exacta, SECDEF, owner,
  --      search_path minimo, solo authenticated, autoridad tenant-bound, lock.
  v_fn := to_regprocedure('public.update_wholesale_customer_status_atomic(uuid,uuid,boolean,boolean,text)');
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 11: no existe la firma exacta de update_wholesale_customer_status_atomic';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = v_fn
       AND p.prosecdef
       AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 11: la RPC de clientes no es SECDEF/postgres/search_path minimo';
  END IF;
  IF pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', v_fn, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 11: la RPC de clientes tiene grants distintos de solo-authenticated';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid = v_fn;
  IF v_src NOT LIKE '%public.current_user_can_in_business(p_business_id, ''wholesale'')%'
     OR v_src !~* 'FOR\s+UPDATE' THEN
    RAISE EXCEPTION 'POSTCONDICION 11: la RPC de clientes perdio su autoridad o su lock';
  END IF;

  -- [12] wholesale_customers: el unico UPDATE directo que queda es last_login.
  FOR v_col IN
    SELECT a.attname FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.wholesale_customers'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    IF pg_catalog.has_column_privilege('anon', 'public.wholesale_customers', v_col, 'UPDATE')
       OR (v_col <> 'last_login'
           AND pg_catalog.has_column_privilege('authenticated', 'public.wholesale_customers', v_col, 'UPDATE')) THEN
      RAISE EXCEPTION 'POSTCONDICION 12: queda UPDATE directo sobre wholesale_customers.%', v_col;
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_column_privilege('authenticated', 'public.wholesale_customers', 'last_login', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDICION 12: loginCustomer perdio el UPDATE de last_login';
  END IF;

  -- [13] El alta del cliente: exactamente las columnas del registro.
  FOR v_col IN
    SELECT a.attname FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.wholesale_customers'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    IF pg_catalog.has_column_privilege('anon', 'public.wholesale_customers', v_col, 'INSERT')
       OR (pg_catalog.has_column_privilege('authenticated', 'public.wholesale_customers', v_col, 'INSERT')
           <> (v_col IN ('business_id','auth_user_id','name','business_name','email','whatsapp',
                         'province','city','instagram'))) THEN
      RAISE EXCEPTION 'POSTCONDICION 13: el INSERT de wholesale_customers.% no es el del registro', v_col;
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_table_privilege('authenticated', 'public.wholesale_customers', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION 13: authenticated perdio SELECT sobre wholesale_customers';
  END IF;

  -- [14] Policies de clientes: sin escritura de staff directa; el alta propia
  --      exige estado administrativo neutro.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
              WHERE p.polrelid = 'public.wholesale_customers'::regclass
                AND p.polname IN ('wc_staff_update', 'wc_staff_insert')) THEN
    RAISE EXCEPTION 'POSTCONDICION 14: sigue una policy de escritura directa de staff sobre clientes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
                  WHERE p.polrelid = 'public.wholesale_customers'::regclass AND p.polname = 'wc_own_insert'
                    AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%approved IS FALSE%'
                    AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%suspended IS FALSE%'
                    AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%total_spent = %') THEN
    RAISE EXCEPTION 'POSTCONDICION 14: wc_own_insert no exige el estado administrativo neutro';
  END IF;

  RAISE NOTICE 'G2-C.1 OK · RPC canonica de estado · alta atomica con precio de la base · UPDATE/INSERT '
    'directo de pedidos cerrado · clientes sin autoadministracion · quantity > 0 · ningun estado mueve stock';
END
$post$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual)
--
--   BEGIN;
--   DROP FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text);
--   DROP FUNCTION public.create_wholesale_order_atomic(text, jsonb, text);
--   DROP FUNCTION public.update_wholesale_customer_status_atomic(uuid, uuid, boolean, boolean, text);
--   ALTER TABLE public.wholesale_order_items DROP CONSTRAINT wholesale_order_items_quantity_positive;
--   GRANT INSERT, UPDATE ON TABLE public.wholesale_orders      TO authenticated;
--   GRANT INSERT, UPDATE ON TABLE public.wholesale_order_items TO authenticated;
--   GRANT INSERT, UPDATE ON TABLE public.wholesale_customers   TO authenticated;
--   -- policies: recrearlas como en 20260629115920_caso_e_wholesale_rls_hardening.sql
--   -- (wo/woi/wc_staff_update, wo/woi/wc_staff_insert) y el baseline
--   -- (wo_customer_insert, woi_customer_insert, wc_own_insert sin estado neutro).
--   COMMIT;
--
-- OJO: revertir REABRE los cuatro blockers de la revision humana (autoaprobacion,
-- pedido en otro tenant, items/inventario de otro tenant, precio del navegador).
-- Y el frontend de G2-C.1 llama a las RPC: revertir la base sin revertir el
-- frontend deja al portal sin alta de pedidos y al modulo Mayorista sin
-- cambios de estado ni aprobacion de clientes.
-- ============================================================================
