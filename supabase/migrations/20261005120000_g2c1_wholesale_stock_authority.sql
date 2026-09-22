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
--   3. El alta del cliente queda obligada al estado inicial canonico
--      (`pending_whatsapp`, el DEFAULT de la columna) y a marcadores neutros.
--   4. CHECK (quantity > 0) en wholesale_order_items.
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

  -- Ningun overload previo con el mismo nombre: haria ambiguo el contrato.
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_proc p
   WHERE p.proname = 'update_wholesale_order_status_atomic';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'G2-C.1: ya existe una funcion update_wholesale_order_status_atomic (%): revisar a mano', v_n;
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
-- Ninguna Edge Function escribe estas tablas. wholesale_customers NO se toca
-- (last_login y la aprobacion de clientes siguen siendo UPDATE legitimos).
-- Se quitan grant Y policy: una policy sin grant es una puerta que el proximo
-- GRANT reabre sin que nadie lo note.
DROP POLICY IF EXISTS wo_staff_update  ON public.wholesale_orders;
DROP POLICY IF EXISTS woi_staff_update ON public.wholesale_order_items;
REVOKE UPDATE ON TABLE public.wholesale_orders      FROM PUBLIC, anon, authenticated;
REVOKE UPDATE ON TABLE public.wholesale_order_items FROM PUBLIC, anon, authenticated;

-- ── 3. Alta: estado inicial canonico y marcadores neutros ───────────────────
-- Dos capas, a proposito:
--   a) privilegio por COLUMNA: el navegador ni siquiera puede nombrar `status`,
--      `admin_notes` ni los marcadores en un INSERT (42501). Las columnas
--      concedidas son exactamente las que manda portalService.createOrder.
--   b) policy: aunque un GRANT futuro devolviera esas columnas, la fila nueva
--      tiene que nacer en `pending_whatsapp`, sin notas administrativas y con
--      marcadores neutros.
-- Por que no un CHECK de tabla sobre los marcadores: aplicaria tambien a
-- public.repair_missing_stock_movements (SECDEF), que hoy puede marcarlos, y
-- la haria abortar entera. Esa herramienta queda fuera de G2-C.1 por decision
-- explicita; se registra como riesgo residual.
REVOKE INSERT ON TABLE public.wholesale_orders FROM PUBLIC, anon, authenticated;
GRANT INSERT (business_id, customer_id, order_number, subtotal, total, notes)
  ON TABLE public.wholesale_orders TO authenticated;

REVOKE INSERT ON TABLE public.wholesale_order_items FROM PUBLIC, anon, authenticated;
GRANT INSERT (order_id, business_id, inventory_item_id, product_name, product_code,
              quantity, unit_price, subtotal)
  ON TABLE public.wholesale_order_items TO authenticated;

-- Mismas condiciones de identidad/tenant que antes; solo se AGREGA el estado
-- inicial. Ningun actor gana permisos.
ALTER POLICY wo_customer_insert ON public.wholesale_orders
  WITH CHECK (
    customer_id IN (
      SELECT wc.id FROM public.wholesale_customers wc
       WHERE wc.auth_user_id = auth.uid())
    AND status = 'pending_whatsapp'
    AND admin_notes IS NULL
  );

ALTER POLICY wo_staff_insert ON public.wholesale_orders
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.business_has_feature('mayorista')
    AND public.can_manage_wholesale()
    AND status = 'pending_whatsapp'
    AND admin_notes IS NULL
  );

ALTER POLICY woi_customer_insert ON public.wholesale_order_items
  WITH CHECK (
    order_id IN (
      SELECT o.id
        FROM public.wholesale_orders o
        JOIN public.wholesale_customers c ON c.id = o.customer_id
       WHERE c.auth_user_id = auth.uid())
    AND stock_processed IS NOT TRUE
    AND stock_processed_at IS NULL
    AND stock_movement_id IS NULL
  );

ALTER POLICY woi_staff_insert ON public.wholesale_order_items
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.business_has_feature('mayorista')
    AND public.can_manage_wholesale()
    AND stock_processed IS NOT TRUE
    AND stock_processed_at IS NULL
    AND stock_movement_id IS NULL
  );

-- ── 4. Cantidad estrictamente positiva ──────────────────────────────────────
ALTER TABLE public.wholesale_order_items
  ADD CONSTRAINT wholesale_order_items_quantity_positive CHECK (quantity > 0);

-- ── 5. POSTCONDICIONES — contra el catalogo, que es lo que corre ────────────
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

  -- [6] El alta no puede nombrar estado, notas administrativas ni marcadores...
  FOREACH v_col IN ARRAY ARRAY['id','status','admin_notes','whatsapp_sent_at','created_at','updated_at'] LOOP
    IF pg_catalog.has_column_privilege('authenticated', 'public.wholesale_orders', v_col, 'INSERT') THEN
      RAISE EXCEPTION 'POSTCONDICION 6: authenticated puede insertar wholesale_orders.%', v_col;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['id','stock_processed','stock_processed_at','stock_movement_id','created_at'] LOOP
    IF pg_catalog.has_column_privilege('authenticated', 'public.wholesale_order_items', v_col, 'INSERT') THEN
      RAISE EXCEPTION 'POSTCONDICION 6: authenticated puede insertar wholesale_order_items.%', v_col;
    END IF;
  END LOOP;
  -- ...pero conserva exactamente las columnas que usa createOrder.
  FOREACH v_col IN ARRAY ARRAY['business_id','customer_id','order_number','subtotal','total','notes'] LOOP
    IF NOT pg_catalog.has_column_privilege('authenticated', 'public.wholesale_orders', v_col, 'INSERT') THEN
      RAISE EXCEPTION 'POSTCONDICION 6: el alta de pedidos perdio la columna %', v_col;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['order_id','business_id','inventory_item_id','product_name',
                               'product_code','quantity','unit_price','subtotal'] LOOP
    IF NOT pg_catalog.has_column_privilege('authenticated', 'public.wholesale_order_items', v_col, 'INSERT') THEN
      RAISE EXCEPTION 'POSTCONDICION 6: el alta de items perdio la columna %', v_col;
    END IF;
  END LOOP;
  IF pg_catalog.has_table_privilege('anon', 'public.wholesale_orders', 'INSERT')
     OR pg_catalog.has_table_privilege('anon', 'public.wholesale_order_items', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDICION 6: anon puede insertar en tablas mayoristas';
  END IF;

  -- [7] La lectura sigue abierta a quien ya la tenia (la RLS decide filas).
  IF NOT pg_catalog.has_table_privilege('authenticated', 'public.wholesale_orders', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('authenticated', 'public.wholesale_order_items', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION 7: authenticated perdio SELECT sobre las tablas mayoristas';
  END IF;

  -- [8] Las policies de alta exigen estado inicial y marcadores neutros.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
                  WHERE p.polrelid = 'public.wholesale_orders'::regclass AND p.polname = 'wo_customer_insert'
                    AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%pending_whatsapp%')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
                  WHERE p.polrelid = 'public.wholesale_orders'::regclass AND p.polname = 'wo_staff_insert'
                    AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%pending_whatsapp%') THEN
    RAISE EXCEPTION 'POSTCONDICION 8: una policy de alta de pedidos no fuerza pending_whatsapp';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_policy p
       WHERE p.polrelid = 'public.wholesale_order_items'::regclass
         AND p.polname IN ('woi_customer_insert', 'woi_staff_insert')
         AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%stock_processed%'
         AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%stock_movement_id%') <> 2 THEN
    RAISE EXCEPTION 'POSTCONDICION 8: una policy de alta de items no fuerza marcadores neutros';
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

  RAISE NOTICE 'G2-C.1 OK · RPC canonica de estado · UPDATE directo cerrado · alta en pending_whatsapp '
    '· marcadores neutros · quantity > 0 · ningun estado mueve stock';
END
$post$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual)
--
--   BEGIN;
--   DROP FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text);
--   ALTER TABLE public.wholesale_order_items DROP CONSTRAINT wholesale_order_items_quantity_positive;
--   GRANT INSERT, UPDATE ON TABLE public.wholesale_orders      TO authenticated;
--   GRANT INSERT, UPDATE ON TABLE public.wholesale_order_items TO authenticated;
--   -- policies de UPDATE y de alta: recrearlas como en
--   -- 20260629115920_caso_e_wholesale_rls_hardening.sql (wo_staff_update,
--   -- woi_staff_update) y el baseline (wo_customer_insert, woi_customer_insert).
--   COMMIT;
--
-- OJO: el frontend de G2-C.1 llama a la RPC. Revertir la base sin revertir el
-- frontend deja los cambios de estado del modulo Mayorista sin camino.
-- ============================================================================
