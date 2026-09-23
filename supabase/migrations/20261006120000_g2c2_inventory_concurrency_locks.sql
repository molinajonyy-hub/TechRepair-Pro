-- ============================================================================
-- G2-C.2 · Locks canonicos de inventario (concurrencia de stock)
--
-- Discovery: docs/g2c2-discovery/README.md (sobre origin/main 4383a9f).
--
-- EL BUG. Cuatro writers server-side hacian read-modify-write de
-- inventory.stock_quantity SIN lock de fila: leian el stock, calculaban un valor
-- ABSOLUTO y lo escribian. Dos operaciones concurrentes sobre el mismo producto
-- partian del mismo previous_stock y la segunda pisaba a la primera (lost
-- update). Reproducido con dos conexiones reales y los writers vivos: stock 10,
-- compra +5 en paralelo con repuesto -2 -> 8 (correcto 13); con pgbench y sin
-- ningun sleep, 2865 operaciones dejaron el stock 1797 unidades desviado. Cada
-- fila de inventory_movements seguia cumpliendo new - previous = quantity; lo que
-- se rompia es la CADENA: dos movimientos con el mismo previous_stock.
--
-- Ademas, los writers multi-item bloqueaban en el orden del payload o del
-- escaneo, y el checkout lo hace ORDER BY id: [A,B] contra [B,A] dio deadlocks
-- reales (14 en 15 s, todas las victimas checkouts del POS, tragados como
-- INTERNAL_ERROR).
--
-- Y el trigger de repuestos buscaba el producto SOLO por id: un tenant podia
-- descontar stock de otro poniendo un product_id ajeno en su propia orden
-- (probado: 7 -> 4 en el negocio ajeno).
--
-- EL CONTRATO. Todo read-modify-write de stock:
--
--   advisory de periodo (si la operacion lo toma)
--   -> documento / idempotencia
--   -> inventory: TODOS los productos de una vez, ORDER BY id, del MISMO negocio
--   -> leer stock ya bloqueado -> UPDATE -> INSERT inventory_movements
--   -> filas hijas y ledgers
--
-- El lock vive en UN helper, private.lock_inventory_rows(business, ids[]):
-- FOR NO KEY UPDATE alcanza para serializar (choca con el UPDATE de otro writer
-- y con el FOR UPDATE de checkout/compra rapida/anulacion) y NO choca con el
-- FOR KEY SHARE de los chequeos FK, asi que no agrega aristas nuevas al grafo.
--
-- QUE CAMBIA (4 writers + 1 helper):
--   W4 private.create_supplier_purchase_atomic  pre-lock ordenado antes del loop
--   W5 public.delete_supplier_purchase_safe     pre-lock ordenado antes del loop
--   W6 public.repair_missing_stock_movements    pre-lock ordenado antes de los loops
--   W7 public.adjust_stock_on_order_item()      lock acotado al negocio (cierra el
--      cross-tenant), pre-lock de la orden entera al borrar (cascada), e identidad
--      inmutable en UPDATE (negocio/orden/producto/tipo -> 0A000)
--
-- QUE NO CAMBIA. Checkout, compra rapida y anulacion ya bloquean ORDER BY id (lo
-- exige la precondicion y lo verifica la postcondicion con su md5). Firmas, OID,
-- owner, SECURITY DEFINER, search_path, ACL, respuestas, autoridad, aritmetica
-- G2-C (stock negativo permitido, sin clamp), movimientos, idempotencia,
-- auditoria y finanzas. Los wrappers publicos no se tocan: bloquear inventario
-- ahi seria ANTES del advisory de periodo e invertiria el orden global.
--
-- W4 ademas califica con `public.` las relaciones que su cuerpo dejaba sin
-- calificar (mismo objeto: su search_path es `public, pg_temp`). Lo exige
-- guard:secdef para una SECURITY DEFINER que conserva `public` en el path.
--
-- Cuerpos: CREATE OR REPLACE completo, tomado del pg_get_functiondef de un
-- replay limpio de 4383a9f (el repo prohibe parchear el texto vivo). El mojibake
-- de las notas de W6 viene de la migracion que la definio y se conserva byte a
-- byte: cambiarlo cambiaria el texto de los movimientos que escribe.
--
-- FAIL-CLOSED: si una precondicion no se cumple, nada se aplica. En particular
-- ABORTA si existe algun order_items cuyo producto es de otro negocio: no se
-- reparan datos automaticamente.
-- ============================================================================
BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 0. PRECONDICIONES
-- ════════════════════════════════════════════════════════════════════════════
DO $pre$
DECLARE
  v_sig   text;
  v_n     bigint;
BEGIN
  -- PRECONDICION 1 · las 4 firmas exactas resuelven (el wrapper publico y el
  -- impl privado de la compra comparten nombre: se apunta por firma).
  FOREACH v_sig IN ARRAY ARRAY[
    'private.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text)',
    'public.delete_supplier_purchase_safe(uuid,uuid,uuid)',
    'public.repair_missing_stock_movements(uuid,boolean)',
    'public.adjust_stock_on_order_item()'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'PRECONDICION 1: la firma % no resuelve a ninguna funcion', v_sig;
    END IF;
  END LOOP;

  -- PRECONDICION 2 · G2-C aplicado: los writers del contrato no clampan el stock
  -- (el patron es el clamp que G2-C elimino; GREATEST en descuentos o saldos es
  -- legitimo y no cuenta).
  IF EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid IN (to_regprocedure('public.adjust_stock_on_order_item()'),
                   to_regprocedure('public.delete_supplier_purchase_safe(uuid,uuid,uuid)'),
                   to_regprocedure('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)'))
       AND prosrc ~* 'greatest\s*\(\s*(0\s*,\s*)?(coalesce\s*\(\s*)?v_prev_st'
  ) OR position('v_prev_stock - NEW.cantidad' IN
        (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.adjust_stock_on_order_item()'))) = 0 THEN
    RAISE EXCEPTION 'PRECONDICION 2: G2-C no esta aplicado (clamp presente o aritmetica ausente)';
  END IF;

  -- PRECONDICION 3 · G2-C.1 aplicado.
  IF to_regprocedure('public.create_wholesale_order_atomic(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 3: G2-C.1 no esta aplicado (falta create_wholesale_order_atomic)';
  END IF;

  -- PRECONDICION 4 · el trigger de repuestos existe, esta ENABLED y es
  -- BEFORE ROW INSERT OR DELETE OR UPDATE sobre order_items.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.order_items'::regclass
       AND t.tgname  = 'trg_adjust_stock_on_order_item'
       AND t.tgenabled = 'O'
       AND t.tgfoid  = to_regprocedure('public.adjust_stock_on_order_item()')
       AND (t.tgtype::int & 31) = 31
  ) THEN
    RAISE EXCEPTION 'PRECONDICION 4: trg_adjust_stock_on_order_item no existe, no esta ENABLED o cambio de forma';
  END IF;

  -- PRECONDICION 5 · checkout, compra rapida y anulacion conservan su pre-lock
  -- ORDER BY id: el orden global de G2-C.2 se apoya en eso.
  FOREACH v_sig IN ARRAY ARRAY[
    'private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',
    'private.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb)',
    'private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL
       OR (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(v_sig))
          !~* 'perform\s+1\s+from\s+(public\.)?inventory\y[^;]*order\s+by\s+id\s+for\s+update' THEN
      RAISE EXCEPTION 'PRECONDICION 5: % perdio su pre-lock de inventario ORDER BY id', v_sig;
    END IF;
  END LOOP;

  -- PRECONDICION 6 · cero order_items cross-tenant. El trigger nuevo es
  -- fail-closed tambien en DELETE: una fila asi no se podria borrar. No se
  -- reparan datos aca; si esto falla, hay que investigar cada fila.
  SELECT count(*) INTO v_n
    FROM public.order_items oi
    JOIN public.inventory inv ON inv.id = oi.product_id
    LEFT JOIN public.orders o ON o.id = oi.order_id
   WHERE inv.business_id IS DISTINCT FROM oi.business_id
      OR (o.id IS NOT NULL AND o.business_id IS DISTINCT FROM oi.business_id);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'PRECONDICION 6: % order_items con product_id de otro negocio (o de una orden ajena). No se reparan automaticamente', v_n;
  END IF;

  -- PRECONDICION 7 · el helper todavia no existe (no pisar algo desconocido).
  IF to_regprocedure('private.lock_inventory_rows(uuid,uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDICION 7: private.lock_inventory_rows ya existe';
  END IF;
END
$pre$;

-- Snapshot de lo que CREATE OR REPLACE debe preservar (y de lo que no se toca).
-- Se identifica por OID (el texto de regprocedure depende del search_path).
CREATE TEMP TABLE _g2c2_snapshot ON COMMIT DROP AS
SELECT p.oid, f.firma, f.rol, p.prosecdef, p.proowner, p.proconfig, p.proacl,
       md5(p.prosrc) AS src_md5
  FROM (VALUES
    ('private.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text)', 'writer'),
    ('public.delete_supplier_purchase_safe(uuid,uuid,uuid)',                                                          'writer'),
    ('public.repair_missing_stock_movements(uuid,boolean)',                                                           'writer'),
    ('public.adjust_stock_on_order_item()',                                                                           'writer'),
    ('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',                                              'intacta'),
    ('private.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb)',      'intacta'),
    ('private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)',                                            'intacta')
  ) AS f(firma, rol)
  JOIN pg_proc p ON p.oid = to_regprocedure(f.firma);

-- ════════════════════════════════════════════════════════════════════════════
-- 1. HELPER · private.lock_inventory_rows
-- ════════════════════════════════════════════════════════════════════════════
-- Unico punto que decide MODO, ORDEN y TENANT del lock de stock.
--   · ORDER BY id: orden global, independiente del payload o del escaneo.
--   · business_id obligatorio: un id de otro negocio simplemente no se bloquea
--     (y no se cuenta); el caller decide si count <> esperado es error.
--   · FOR NO KEY UPDATE: serializa contra cualquier writer de stock y no choca
--     con el FOR KEY SHARE de los chequeos FK.
--   · SECURITY INVOKER sin EXECUTE para roles de API: solo lo llaman los writers
--     SECURITY DEFINER (owner postgres).
CREATE FUNCTION private.lock_inventory_rows(p_business_id uuid, p_inventory_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_locked integer;
BEGIN
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_LOCK_TENANT_REQUIRED: el lock de inventario exige business_id'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
     FROM public.inventory i
    WHERE i.business_id = p_business_id
      AND i.id = ANY (COALESCE(p_inventory_ids, '{}'::uuid[]))
    ORDER BY i.id
      FOR NO KEY UPDATE;
  GET DIAGNOSTICS v_locked = ROW_COUNT;

  RETURN v_locked;
END;
$fn$;

ALTER FUNCTION private.lock_inventory_rows(uuid, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.lock_inventory_rows(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION private.lock_inventory_rows(uuid, uuid[]) IS
  'G2-C.2: bloquea FOR NO KEY UPDATE las filas de inventory del negocio, ORDER BY id, y devuelve cuantas bloqueo. '
  'Unico lock canonico para read-modify-write de stock. Sin EXECUTE para roles de API.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. WRITERS · cuerpos canonicos completos (CREATE OR REPLACE conserva OID,
--    owner y ACL; SECURITY DEFINER y search_path se repiten tal cual)
-- ════════════════════════════════════════════════════════════════════════════

-- ── W7 · public.adjust_stock_on_order_item() (trigger de repuestos de orden) ───
CREATE OR REPLACE FUNCTION public.adjust_stock_on_order_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_prev_stock  INTEGER;
  v_new_stock   INTEGER;
  v_business_id UUID;
  v_qty_change  INTEGER;
  -- G2-C.2
  v_order_business UUID;
  v_order_products UUID[];
  v_expected       INTEGER;
BEGIN
  -- ── G2-C.2 · identidad de stock inmutable ─────────────────────────────────
  -- Un UPDATE solo puede cambiar la cantidad. Cambiar negocio, orden, producto o
  -- tipo ajustaba unicamente NEW y dejaba descuadrado el stock del producto
  -- anterior. Ninguna UI lo hace (solo INSERT y DELETE): se rechaza fail-closed.
  -- Incluye el SET NULL de la FK product_id al borrar en duro un producto usado
  -- en una orden: ese borrado ahora falla en vez de perder la trazabilidad.
  IF TG_OP = 'UPDATE' AND (
       NEW.business_id IS DISTINCT FROM OLD.business_id
    OR NEW.order_id    IS DISTINCT FROM OLD.order_id
    OR NEW.product_id  IS DISTINCT FROM OLD.product_id
    OR NEW.tipo        IS DISTINCT FROM OLD.tipo
  ) THEN
    RAISE EXCEPTION 'ORDER_ITEM_STOCK_IDENTITY_IMMUTABLE: un item de orden no puede cambiar de negocio, orden, producto ni tipo; eliminalo y cargalo de nuevo'
      USING ERRCODE = '0A000';
  END IF;

  -- ── G2-C.2 · negocio canonico ─────────────────────────────────────────────
  -- El item declara su negocio (NOT NULL, lo exige la RLS de order_items) y la
  -- orden padre tambien. Para mover stock ambos tienen que coincidir, y el
  -- producto tiene que ser de ESE negocio (antes se buscaba solo por id: un
  -- tenant podia descontar stock de otro poniendo un product_id ajeno).
  -- En el ON DELETE CASCADE de una orden, la orden ya no existe: manda el item.
  v_business_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.business_id ELSE NEW.business_id END;
  SELECT o.business_id INTO v_order_business
    FROM public.orders o
   WHERE o.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;

  -- ── INSERT: descontar stock ────────────────────────────────────────────────
  IF TG_OP = 'INSERT' AND NEW.tipo = 'repuesto' AND NEW.product_id IS NOT NULL THEN

    IF v_order_business IS DISTINCT FROM v_business_id THEN
      RAISE EXCEPTION 'INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH: la orden no pertenece al negocio del item'
        USING ERRCODE = '42501';
    END IF;
    -- G2-C.2: lock canonico de la fila del producto, acotado al negocio, ANTES de leer.
    IF private.lock_inventory_rows(v_business_id, ARRAY[NEW.product_id]) <> 1 THEN
      RAISE EXCEPTION 'INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH: el repuesto no pertenece al negocio de la orden'
        USING ERRCODE = '42501';
    END IF;

    SELECT stock_quantity INTO v_prev_stock
    FROM public.inventory WHERE id = NEW.product_id AND business_id = v_business_id;
    v_prev_stock := COALESCE(v_prev_stock, 0);
    v_new_stock  := v_prev_stock - NEW.cantidad;

    UPDATE public.inventory
    SET stock_quantity = v_new_stock,
        stock          = v_new_stock,
        updated_at     = NOW()
    WHERE id = NEW.product_id AND business_id = v_business_id;

    INSERT INTO public.inventory_movements (
      business_id, inventory_item_id, movement_type,
      quantity, previous_stock, new_stock,
      reference_type, reference_id, note
      -- created_by omitido: order_items no tiene esa columna (nullable en movements)
    ) VALUES (
      v_business_id, NEW.product_id, 'order_usage',
      -NEW.cantidad, v_prev_stock, v_new_stock,
      'order', NEW.order_id,
      'Repuesto usado en orden #' || LEFT(NEW.order_id::TEXT, 8)
    );

    RETURN NEW;

  -- ── DELETE: devolver stock ─────────────────────────────────────────────────
  ELSIF TG_OP = 'DELETE' AND OLD.tipo = 'repuesto' AND OLD.product_id IS NOT NULL THEN

    IF v_order_business IS NOT NULL AND v_order_business IS DISTINCT FROM v_business_id THEN
      RAISE EXCEPTION 'INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH: la orden no pertenece al negocio del item'
        USING ERRCODE = '42501';
    END IF;
    -- G2-C.2: pre-lock ORDENADO de todos los repuestos de la MISMA orden. Cubre el
    -- DELETE multi-fila y el ON DELETE CASCADE de la orden, que disparan este
    -- trigger una vez por item en orden de escaneo: el primer item bloquea el
    -- conjunto ORDER BY id y los siguientes re-entran sobre locks ya tomados.
    SELECT COALESCE(array_agg(DISTINCT oi.product_id), '{}'::uuid[])
      INTO v_order_products
      FROM public.order_items oi
     WHERE oi.order_id = OLD.order_id
       AND oi.tipo = 'repuesto'
       AND oi.product_id IS NOT NULL;
    IF NOT (OLD.product_id = ANY (v_order_products)) THEN
      v_order_products := v_order_products || OLD.product_id;
    END IF;
    v_expected := cardinality(v_order_products);
    IF private.lock_inventory_rows(v_business_id, v_order_products) <> v_expected THEN
      RAISE EXCEPTION 'INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH: un repuesto de la orden no pertenece a su negocio'
        USING ERRCODE = '42501';
    END IF;

    SELECT stock_quantity INTO v_prev_stock
    FROM public.inventory WHERE id = OLD.product_id AND business_id = v_business_id;
    v_prev_stock := COALESCE(v_prev_stock, 0);
    v_new_stock  := v_prev_stock + OLD.cantidad;

    UPDATE public.inventory
    SET stock_quantity = v_new_stock,
        stock          = v_new_stock,
        updated_at     = NOW()
    WHERE id = OLD.product_id AND business_id = v_business_id;

    INSERT INTO public.inventory_movements (
      business_id, inventory_item_id, movement_type,
      quantity, previous_stock, new_stock,
      reference_type, reference_id, note
    ) VALUES (
      v_business_id, OLD.product_id, 'return',
      OLD.cantidad, v_prev_stock, v_new_stock,
      'order', OLD.order_id,
      'Reverso: repuesto eliminado de orden #' || LEFT(OLD.order_id::TEXT, 8)
    );

    RETURN OLD;

  -- ── UPDATE: ajustar diferencia de cantidad ────────────────────────────────
  ELSIF TG_OP = 'UPDATE' AND NEW.tipo = 'repuesto' AND NEW.product_id IS NOT NULL THEN

    v_qty_change := NEW.cantidad - OLD.cantidad;
    IF v_qty_change = 0 THEN RETURN NEW; END IF;

    IF v_order_business IS DISTINCT FROM v_business_id THEN
      RAISE EXCEPTION 'INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH: la orden no pertenece al negocio del item'
        USING ERRCODE = '42501';
    END IF;
    -- G2-C.2: lock canonico de la fila del producto, acotado al negocio, ANTES de leer.
    IF private.lock_inventory_rows(v_business_id, ARRAY[NEW.product_id]) <> 1 THEN
      RAISE EXCEPTION 'INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH: el repuesto no pertenece al negocio de la orden'
        USING ERRCODE = '42501';
    END IF;

    SELECT stock_quantity INTO v_prev_stock
    FROM public.inventory WHERE id = NEW.product_id AND business_id = v_business_id;
    v_prev_stock := COALESCE(v_prev_stock, 0);
    v_new_stock  := v_prev_stock - v_qty_change;

    UPDATE public.inventory
    SET stock_quantity = v_new_stock,
        stock          = v_new_stock,
        updated_at     = NOW()
    WHERE id = NEW.product_id AND business_id = v_business_id;

    INSERT INTO public.inventory_movements (
      business_id, inventory_item_id, movement_type,
      quantity, previous_stock, new_stock,
      reference_type, reference_id, note
    ) VALUES (
      v_business_id, NEW.product_id,
      CASE WHEN v_qty_change > 0 THEN 'order_usage' ELSE 'return' END,
      -v_qty_change, v_prev_stock, v_new_stock,
      'order', NEW.order_id,
      'Ajuste cantidad en orden #' || LEFT(NEW.order_id::TEXT, 8)
    );

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

-- ── W4 · private.create_supplier_purchase_atomic (impl; el wrapper publico no cambia) ───
CREATE OR REPLACE FUNCTION private.create_supplier_purchase_atomic(p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text, p_purchase_date date, p_invoice_number text, p_total_amount numeric, p_paid_amount numeric, p_payment_method text, p_notes text, p_items jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  c_key_max      constant int := 200;
  v_actor_user_id         uuid := auth.uid();
  v_is_member    boolean := false;
  v_purchase_date date;
  v_paid         numeric := COALESCE(p_paid_amount, 0);
  v_pending      numeric;
  v_status       text;
  v_method       text;
  v_key          text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash         text;
  v_items_canon  jsonb;
  v_existing     public.supplier_purchase_requests%ROWTYPE;
  v_req_id       uuid;
  v_purchase     record;
  v_item         jsonb;
  v_payment      record;
  v_fm           record;
  v_fm_id        uuid;
  v_bfe_id       uuid;
  v_payment_id   uuid;
  v_debit_id     uuid;
  v_credit_id    uuid;
  v_caja         uuid;
  v_prev_stk     integer;
  v_new_stk      integer;
  v_inv_num      text;
  v_desc_sfx     text;
  v_item_count   int := COALESCE(jsonb_array_length(p_items), 0);
  v_inv_items    int := 0;
  v_stage        text := 'init';
  v_inv_ids      uuid[];
BEGIN
  -- 1. Autenticacion
  IF v_actor_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  -- 2. Ownership/pertenencia (miembro activo; sin filtro de rol — comportamiento previo)
  SELECT (EXISTS (SELECT 1 FROM public.businesses WHERE id=p_business_id AND owner_user_id=v_actor_user_id)
       OR EXISTS (SELECT 1 FROM public.profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_actor_user_id AND COALESCE(is_active,true))) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;
  -- 3. Validacion del payload
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  IF p_total_amount IS NULL OR p_total_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'total_amount debe ser mayor a 0'); END IF;
  IF v_paid < 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El pago no puede ser negativo'); END IF;
  -- Proveedor del MISMO negocio (aislamiento real)
  IF p_supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id=p_supplier_id AND business_id=p_business_id) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','SUPPLIER_NOT_FOUND', 'error', 'Proveedor inexistente en este negocio'); END IF;
  -- Cantidad valida por item
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it WHERE COALESCE((it->>'quantity')::numeric,0) <= 0) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Cantidad invalida en un item'); END IF;
  -- Productos del MISMO negocio (los que traen inventory_id)
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
             WHERE NULLIF(btrim(it->>'inventory_id'),'') IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.inventory i WHERE i.id=(it->>'inventory_id')::uuid AND i.business_id=p_business_id)) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','PRODUCT_NOT_FOUND', 'error', 'Producto inexistente en este negocio'); END IF;

  -- 3.5 Metodo de pago via helper CENTRAL (mismo catalogo que las RPC de pago; sin
  -- comparar el parametro crudo). Con pago inicial (paid>0) el metodo es obligatorio;
  -- a deuda (paid=0) admite NULL (no hay pago). El valor canonico se usa para hash,
  -- decision de caja, persistencia y auditoria.
  BEGIN
    v_method := public.normalize_supplier_payment_method(p_payment_method);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'INVALID_PAYMENT_METHOD%' THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido'); ELSE RAISE; END IF;
  END;
  IF v_paid > 0 AND v_method IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido'); END IF;

  -- 4. Fecha economica unica
  v_purchase_date := COALESCE(p_purchase_date, public.ar_today());

  -- 5. Replay previo (hash canonico jsonb; items ordenados canonicamente)
  IF v_key IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(elem ORDER BY elem->>'inventory_id', elem->>'product_name', elem->>'quantity', elem->>'unit_cost'), '[]'::jsonb) INTO v_items_canon
    FROM (
      SELECT jsonb_build_object(
        'inventory_id', NULLIF(btrim(it->>'inventory_id'),''),
        'product_name', NULLIF(btrim(it->>'product_name'),''),
        'quantity', round(COALESCE((it->>'quantity')::numeric,0),4),
        'unit_cost', round(COALESCE((it->>'unit_cost')::numeric,0),2)) AS elem
      FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
    ) s;
    v_hash := encode(extensions.digest(jsonb_build_object(
      'op','supplier_purchase', 'business_id',p_business_id, 'supplier_id',p_supplier_id,
      'supplier_name',NULLIF(btrim(p_supplier_name),''),
      'purchase_date',v_purchase_date, 'invoice',NULLIF(btrim(p_invoice_number),''),
      'total',round(p_total_amount,2), 'paid',round(v_paid,2), 'currency','ARS', 'exchange_rate',1,
      'method',v_method, 'notes',NULLIF(btrim(p_notes),''),
      'items',v_items_canon)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM public.supplier_purchase_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing.purchase_id);
    END IF;
  END IF;

  -- 6. Guard de periodo
  BEGIN
    PERFORM public.assert_period_open(p_business_id, v_purchase_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF;
  END;

  -- 6.5 Caja para efectivo (ANTES de reservar/escribir). Un pago en efectivo exige
  -- una caja abierta del MISMO negocio (WHERE business_id=p_business_id). Transferencia
  -- y metodos no-efectivo conservan el comportamiento M6 (usan la caja abierta si hay,
  -- o quedan sin caja). El FM persiste esta misma caja validada.
  SELECT id INTO v_caja FROM public.cajas WHERE business_id=p_business_id AND status='abierta' ORDER BY opened_at DESC LIMIT 1;
  IF v_paid > 0 AND v_method = 'efectivo' AND v_caja IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'Debes abrir una caja antes de registrar un pago en efectivo');
  END IF;

  -- 7. Reserva idempotente race-safe
  IF v_key IS NOT NULL THEN
    INSERT INTO public.supplier_purchase_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_actor_user_id, 'supplier_purchase', v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req_id;
    IF v_req_id IS NULL THEN
      SELECT * INTO v_existing FROM public.supplier_purchase_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing.purchase_id);
    END IF;
  END IF;

  -- 8. Scope de auditoria
  PERFORM public.finance_begin_audit_scope();

  -- 9. Escrituras economicas (todas con v_purchase_date; modelo M3-M6 intacto)
  v_stage := 'write';
  v_inv_num  := NULLIF(trim(COALESCE(p_invoice_number, '')), '');
  v_desc_sfx := COALESCE(' #' || v_inv_num, '');
  v_pending  := GREATEST(0, p_total_amount - v_paid);
  IF v_paid <= 0                          THEN v_status := 'pending';
  ELSIF v_paid >= p_total_amount - 0.01   THEN v_status := 'paid';
  ELSE v_status := 'partial'; END IF;

  INSERT INTO public.supplier_purchases (business_id, supplier_id, purchase_date, invoice_number,
    total_amount, paid_amount, pending_amount, payment_status, payment_method, notes, created_by)
  VALUES (p_business_id, p_supplier_id, v_purchase_date, v_inv_num, p_total_amount, v_paid, v_pending, v_status,
    v_method, NULLIF(trim(COALESCE(p_notes, '')), ''), v_actor_user_id)
  RETURNING * INTO v_purchase;

  -- G2-C.2 · lock canonico de inventario. Orden global: advisory de periodo (6) ->
  -- reserva idempotente/documento (7-9) -> inventario (aca) -> hijas y ledgers.
  -- TODOS los productos del payload de una vez, DISTINCT, ORDER BY id, acotados al
  -- negocio, ANTES del loop. Sin esto el loop leia stock sin lock (lost update, y
  -- las compras con fecha de otro mes ni siquiera comparten el advisory) y
  -- bloqueaba en el orden del payload (deadlock contra el checkout). Los
  -- duplicados del payload se siguen procesando como antes: el loop relee la fila
  -- ya bloqueada y ve su propio UPDATE anterior.
  SELECT COALESCE(array_agg(DISTINCT btrim(it->>'inventory_id')::uuid), '{}'::uuid[])
    INTO v_inv_ids
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) it
   WHERE NULLIF(btrim(COALESCE(it->>'inventory_id', '')), '') IS NOT NULL;
  IF private.lock_inventory_rows(p_business_id, v_inv_ids) <> cardinality(v_inv_ids) THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND: un producto del payload no pertenece al negocio';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    INSERT INTO public.supplier_purchase_items (business_id, purchase_id, supplier_id, inventory_id,
      product_name, quantity, unit_cost, subtotal)
    VALUES (p_business_id, v_purchase.id, p_supplier_id, NULLIF(trim(COALESCE(v_item->>'inventory_id', '')), '')::uuid,
      v_item->>'product_name', (v_item->>'quantity')::numeric, (v_item->>'unit_cost')::numeric,
      (v_item->>'quantity')::numeric * (v_item->>'unit_cost')::numeric);

    IF NULLIF(trim(COALESCE(v_item->>'inventory_id','')),'') IS NOT NULL THEN
      SELECT stock_quantity INTO v_prev_stk FROM public.inventory WHERE id=(v_item->>'inventory_id')::uuid AND business_id=p_business_id;
      IF FOUND THEN
        v_inv_items := v_inv_items + 1;
        v_new_stk := COALESCE(v_prev_stk, 0) + FLOOR((v_item->>'quantity')::numeric)::integer;
        UPDATE public.inventory SET stock_quantity=v_new_stk, stock=v_new_stk, cost_price=(v_item->>'unit_cost')::numeric, updated_at=now()
          WHERE id=(v_item->>'inventory_id')::uuid AND business_id=p_business_id;
        INSERT INTO public.inventory_movements (inventory_item_id, movement_type, quantity, previous_stock, new_stock,
          reference_type, reference_id, note, business_id, created_by, supplier_id, unit_cost, currency, exchange_rate)
        VALUES ((v_item->>'inventory_id')::uuid, 'purchase', FLOOR((v_item->>'quantity')::numeric)::integer,
          COALESCE(v_prev_stk, 0), v_new_stk, 'supplier_purchase', v_purchase.id,
          'Compra a ' || COALESCE(p_supplier_name,'') || v_desc_sfx, p_business_id, v_actor_user_id, p_supplier_id,
          (v_item->>'unit_cost')::numeric, 'ARS', 1);
      END IF;
    END IF;
  END LOOP;

  -- Deuda con proveedor (pasivo): debito por el total. UNA vez.
  INSERT INTO public.supplier_account_movements (business_id, supplier_id, purchase_id, payment_id,
    movement_date, type, description, debit, credit, balance_after)
  VALUES (p_business_id, p_supplier_id, v_purchase.id, NULL, v_purchase_date, 'purchase', 'Compra' || v_desc_sfx, p_total_amount, 0, 0)
  RETURNING id INTO v_debit_id;

  -- Pago inicial (solo si v_paid>0): salida de caja + credito de deuda. Sin duplicar costo.
  IF v_paid > 0 THEN
    INSERT INTO public.financial_movements (business_id, caja_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago, sign, reference_id, reference_type)
    VALUES (p_business_id, v_caja, v_purchase_date, 'expense', 'ARS', v_paid, v_paid, 1, 'pago_proveedor',
      'Compra a ' || COALESCE(p_supplier_name,'') || v_desc_sfx, v_actor_user_id, v_method,
      1, v_purchase.id, 'supplier_purchase') RETURNING * INTO v_fm;
    v_fm_id := v_fm.id;
    INSERT INTO public.business_finance_entries (business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate, payment_method, created_by, source)
    VALUES (p_business_id, v_purchase_date, 'variable_cost', 'compras_proveedor',
      'Compra a ' || COALESCE(p_supplier_name,'') || v_desc_sfx, v_paid, 'ARS', v_paid, 1,
      v_method, v_actor_user_id, 'pago_proveedor') RETURNING id INTO v_bfe_id;
    INSERT INTO public.supplier_payments (business_id, supplier_id, purchase_id, payment_date,
      amount, payment_method, notes, created_by, financial_movement_id)
    VALUES (p_business_id, p_supplier_id, v_purchase.id, v_purchase_date, v_paid,
      v_method, 'Pago inicial al crear compra' || v_desc_sfx, v_actor_user_id, v_fm.id)
    RETURNING * INTO v_payment;
    v_payment_id := v_payment.id;
    INSERT INTO public.supplier_account_movements (business_id, supplier_id, purchase_id, payment_id,
      movement_date, type, description, debit, credit, balance_after)
    VALUES (p_business_id, p_supplier_id, v_purchase.id, v_payment.id, v_purchase_date, 'payment', 'Pago inicial compra' || v_desc_sfx, 0, v_paid, 0)
    RETURNING id INTO v_credit_id;
  END IF;

  -- 10/11. Enlace del request
  IF v_key IS NOT NULL THEN UPDATE public.supplier_purchase_requests SET purchase_id=v_purchase.id WHERE id=v_req_id; END IF;

  -- 12. Auditoria explicita (un evento agregado de negocio: la compra)
  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'supplier_purchase', 'supplier_purchases', v_purchase.id, 'create_supplier_purchase_atomic',
    v_key, p_notes, v_purchase_date, 'supplier_purchase', v_purchase.id,
    NULL, jsonb_build_object('supplier_id', p_supplier_id, 'total', p_total_amount, 'currency','ARS', 'exchange_rate',1,
      'total_ars', p_total_amount, 'paid_amount', v_paid, 'pending_amount', v_pending, 'payment_status', v_status,
      'method', v_method, 'item_count', v_item_count, 'inventory_items', v_inv_items,
      'financial_movement_id', v_fm_id, 'bfe_id', v_bfe_id, 'supplier_payment_id', v_payment_id,
      'supplier_debit_movement_id', v_debit_id, 'supplier_credit_movement_id', v_credit_id, 'caja_id', v_caja));

  -- 13. Retorno
  RETURN jsonb_build_object('ok', true, 'replay', false, 'purchase_id', v_purchase.id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoria de la operacion'
                  ELSE 'No se pudo completar la operacion' END);
END;
$function$;

-- ── W5 · public.delete_supplier_purchase_safe ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_supplier_purchase_safe(p_business_id uuid, p_purchase_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_purchase public.supplier_purchases%ROWTYPE;
  v_item     record;
  v_prev_stk integer;
  v_new_stk  integer;
  v_inv_ids  uuid[];
BEGIN

  -- LOTE 2: actor -> canonical active tenant -> existing action authority.
  PERFORM public._require_business_member(p_business_id);
  IF p_business_id IS DISTINCT FROM public.current_user_business_id()
     OR NOT public.current_user_can('inventory') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- Reject inconsistent child references before locks or stock effects.
  IF EXISTS (
    SELECT 1 FROM public.supplier_purchase_items i
    JOIN public.inventory inv ON inv.id = i.inventory_id
    WHERE i.purchase_id = p_purchase_id AND i.business_id = p_business_id
      AND inv.business_id IS DISTINCT FROM p_business_id
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_purchase
    FROM public.supplier_purchases
   WHERE id = p_purchase_id AND business_id = p_business_id
     FOR UPDATE;

  IF NOT FOUND THEN
    -- Antes de decir "no existe": ¿la borramos nosotros? Si hay tombstone, esto
    -- es un retry de una operación que YA salió bien, no un error.
    IF EXISTS (SELECT 1 FROM public.supplier_purchase_deletions
                WHERE business_id = p_business_id AND purchase_id = p_purchase_id) THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'error_code', 'ALREADY_DELETED');
    END IF;
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND', 'error', 'Compra no encontrada');
  END IF;

  IF v_purchase.paid_amount > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'BLOCKED_PAID',
      'error', 'blocked_paid',
      'message', 'No se puede eliminar una compra con pagos registrados.');
  END IF;

  -- G2-C.2 · lock canonico de inventario: TODOS los productos de la compra de una
  -- vez, ORDER BY id, acotados al negocio, DESPUES del lock de la compra y ANTES
  -- del loop. Sin esto el loop leia stock sin lock (lost update) y bloqueaba en
  -- el orden fisico de los items (deadlock contra el checkout).
  SELECT COALESCE(array_agg(DISTINCT i.inventory_id), '{}'::uuid[])
    INTO v_inv_ids
    FROM public.supplier_purchase_items i
   WHERE i.purchase_id = p_purchase_id AND i.business_id = p_business_id
     AND i.inventory_id IS NOT NULL;
  IF private.lock_inventory_rows(p_business_id, v_inv_ids) <> cardinality(v_inv_ids) THEN
    RAISE EXCEPTION 'INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH' USING ERRCODE = '42501';
  END IF;

  FOR v_item IN
    SELECT * FROM public.supplier_purchase_items
     WHERE purchase_id = p_purchase_id AND business_id = p_business_id
  LOOP
    IF v_item.inventory_id IS NOT NULL THEN
      SELECT stock_quantity INTO v_prev_stk FROM public.inventory
       WHERE id = v_item.inventory_id AND business_id = p_business_id;
      IF FOUND THEN
        v_new_stk := COALESCE(v_prev_stk, 0) - FLOOR(v_item.quantity)::integer;
        UPDATE public.inventory
           SET stock_quantity = v_new_stk, stock = v_new_stk, updated_at = now()
         WHERE id = v_item.inventory_id AND business_id = p_business_id;
        INSERT INTO public.inventory_movements (
          inventory_item_id, movement_type, quantity, previous_stock, new_stock,
          reference_type, reference_id, note, business_id, created_by
        ) VALUES (
          v_item.inventory_id, 'cancellation', -FLOOR(v_item.quantity)::integer,
          COALESCE(v_prev_stk, 0), v_new_stk, 'supplier_purchase', p_purchase_id,
          'Reversión por eliminación de compra', p_business_id, v_actor);
      END IF;
    END IF;
  END LOOP;

  DELETE FROM public.supplier_account_movements
   WHERE purchase_id = p_purchase_id AND business_id = p_business_id;

  WITH ordered AS (
    SELECT id, SUM(debit - credit) OVER (
             PARTITION BY supplier_id ORDER BY movement_date, created_at
             ROWS UNBOUNDED PRECEDING) AS running_bal
      FROM public.supplier_account_movements
     WHERE supplier_id = v_purchase.supplier_id AND business_id = p_business_id
  )
  UPDATE public.supplier_account_movements m
     SET balance_after = o.running_bal
    FROM ordered o WHERE m.id = o.id;

  DELETE FROM public.supplier_purchase_items
   WHERE purchase_id = p_purchase_id AND business_id = p_business_id;
  DELETE FROM public.supplier_purchases
   WHERE id = p_purchase_id AND business_id = p_business_id;

  -- El tombstone va en la MISMA transacción: si el borrado se revierte, el
  -- tombstone también. Nunca puede quedar diciendo que se borró algo que sigue.
  INSERT INTO public.supplier_purchase_deletions (business_id, purchase_id, supplier_id, user_id)
       VALUES (p_business_id, p_purchase_id, v_purchase.supplier_id, v_actor)
  ON CONFLICT (business_id, purchase_id) DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'replay', false);

EXCEPTION
  WHEN insufficient_privilege THEN RAISE;
  WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL_ERROR',
    'error', 'No se pudo eliminar la compra');
END; $function$;

-- ── W6 · public.repair_missing_stock_movements ────────────────────────────────
CREATE OR REPLACE FUNCTION public.repair_missing_stock_movements(p_business_id uuid, p_allow_negative boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $function$
 DECLARE
   v_comp_count     int     := 0;
   v_ws_count       int     := 0;
   v_skip_stock     int     := 0;
   v_skip_product   int     := 0;
   v_total_units    numeric := 0;
   v_movement_id    uuid;
   v_prev_stock     int;
   v_new_stock      int;
   r                record;
   v_inv_ids        uuid[];
 BEGIN

  -- LOTE 2: actor -> canonical active tenant -> existing action authority.
  PERFORM public._require_business_member(p_business_id, ARRAY['owner', 'admin']);
  IF p_business_id IS DISTINCT FROM public.current_user_business_id()
     OR NOT public.current_user_can('inventory') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

   -- G2-C.2 · lock canonico de inventario: la union de productos candidatos se
   -- bloquea UNA vez, ORDER BY id, acotada al negocio, antes de mover stock. Los
   -- loops solo procesan lineas de productos de ese conjunto: una linea que
   -- aparezca despues queda para la proxima reparacion en vez de mutarse sin
   -- lock. Una reparacion concurrente espera aca y despues relee las lineas ya
   -- marcadas (stock_processed) sin duplicar impacto. Los productos que no son
   -- del negocio no se bloquean y siguen contando como no encontrados.
   SELECT COALESCE(array_agg(DISTINCT x.inventory_id), '{}'::uuid[])
     INTO v_inv_ids
     FROM (
       SELECT ci.inventory_id
         FROM public.comprobante_items ci
         JOIN public.comprobantes c ON c.id = ci.comprobante_id AND c.business_id = p_business_id
        WHERE ci.business_id   = p_business_id
          AND ci.inventory_id  IS NOT NULL
          AND ci.cantidad        > 0
          AND (ci.stock_processed = false OR ci.stock_processed IS NULL)
          AND c.estado          NOT IN ('anulado')
          AND c.status          NOT IN ('cancelled')
          AND c.estado_comercial NOT IN ('anulado')
          AND c.estado_comercial IS DISTINCT FROM NULL
       UNION
       SELECT woi.inventory_item_id
         FROM public.wholesale_order_items woi
         JOIN public.wholesale_orders wo ON wo.id = woi.order_id AND wo.business_id = p_business_id
        WHERE woi.business_id       = p_business_id
          AND woi.inventory_item_id IS NOT NULL
          AND woi.quantity            > 0
          AND (woi.stock_processed = false OR woi.stock_processed IS NULL)
          AND wo.status NOT IN ('cancelled','rejected')
     ) x;
   PERFORM private.lock_inventory_rows(p_business_id, v_inv_ids);

   FOR r IN
     SELECT ci.id, ci.comprobante_id, ci.inventory_id, ci.cantidad
     FROM   public.comprobante_items ci
     JOIN   public.comprobantes c ON c.id = ci.comprobante_id AND c.business_id = p_business_id
     WHERE  ci.business_id   = p_business_id
       AND  ci.inventory_id  IS NOT NULL
       AND  ci.cantidad        > 0
       AND  (ci.stock_processed = false OR ci.stock_processed IS NULL)
       AND  c.estado          NOT IN ('anulado')
       AND  c.status          NOT IN ('cancelled')
       AND  c.estado_comercial NOT IN ('anulado')
       AND  c.estado_comercial IS DISTINCT FROM NULL
       AND  ci.inventory_id = ANY (v_inv_ids)
     FOR UPDATE OF ci SKIP LOCKED
   LOOP
     SELECT stock_quantity INTO v_prev_stock
     FROM public.inventory
     WHERE id = r.inventory_id AND business_id = p_business_id;

     IF NOT FOUND THEN v_skip_product := v_skip_product + 1; CONTINUE; END IF;

     IF v_prev_stock < r.cantidad::int AND NOT p_allow_negative THEN
       v_skip_stock := v_skip_stock + 1; CONTINUE;
     END IF;

     v_new_stock := v_prev_stock - r.cantidad::int;

     UPDATE public.inventory SET stock_quantity = v_new_stock, updated_at = now()
      WHERE id = r.inventory_id AND business_id = p_business_id;

     INSERT INTO public.inventory_movements
       (business_id, inventory_item_id, movement_type, quantity,
        previous_stock, new_stock, reference_type, reference_id, note)
     VALUES
       (p_business_id, r.inventory_id, 'sale', -r.cantidad::int,
        v_prev_stock, v_new_stock, 'comprobante', r.comprobante_id,
        'ReparaciÃ³n de stock â€” venta anterior')
     RETURNING id INTO v_movement_id;

     UPDATE public.comprobante_items
        SET stock_processed = true, stock_processed_at = now(), stock_movement_id = v_movement_id
      WHERE id = r.id;

     v_comp_count  := v_comp_count  + 1;
     v_total_units := v_total_units + r.cantidad;
   END LOOP;

   FOR r IN
     SELECT woi.id, woi.order_id, woi.inventory_item_id, woi.quantity
     FROM   public.wholesale_order_items woi
     JOIN   public.wholesale_orders wo ON wo.id = woi.order_id AND wo.business_id = p_business_id
     WHERE  woi.business_id       = p_business_id
       AND  woi.inventory_item_id IS NOT NULL
       AND  woi.quantity            > 0
       AND  (woi.stock_processed = false OR woi.stock_processed IS NULL)
       AND  wo.status NOT IN ('cancelled','rejected')
       AND  woi.inventory_item_id = ANY (v_inv_ids)
     FOR UPDATE OF woi SKIP LOCKED
   LOOP
     SELECT stock_quantity INTO v_prev_stock
     FROM public.inventory
     WHERE id = r.inventory_item_id AND business_id = p_business_id;

     IF NOT FOUND THEN v_skip_product := v_skip_product + 1; CONTINUE; END IF;

     IF v_prev_stock < r.quantity AND NOT p_allow_negative THEN
       v_skip_stock := v_skip_stock + 1; CONTINUE;
     END IF;

     v_new_stock := v_prev_stock - r.quantity;

     UPDATE public.inventory SET stock_quantity = v_new_stock, updated_at = now()
      WHERE id = r.inventory_item_id AND business_id = p_business_id;

     INSERT INTO public.inventory_movements
       (business_id, inventory_item_id, movement_type, quantity,
        previous_stock, new_stock, reference_type, reference_id, note)
     VALUES
       (p_business_id, r.inventory_item_id, 'sale', -r.quantity,
        v_prev_stock, v_new_stock, 'wholesale_order', r.order_id,
        'ReparaciÃ³n de stock â€” pedido mayorista anterior')
     RETURNING id INTO v_movement_id;

     UPDATE public.wholesale_order_items
        SET stock_processed = true, stock_processed_at = now(), stock_movement_id = v_movement_id
      WHERE id = r.id;

     v_ws_count    := v_ws_count    + 1;
     v_total_units := v_total_units + r.quantity;
   END LOOP;

   RETURN jsonb_build_object(
     'comprobantes_procesados',         v_comp_count,
     'pedidos_mayoristas_procesados',   v_ws_count,
     'items_sin_stock_suficiente',      v_skip_stock,
     'items_producto_no_encontrado',    v_skip_product,
     'total_unidades_descontadas',      v_total_units
   );
 END;
 $function$;

-- Ninguno de los tres writers invocables tiene EXECUTE para PUBLIC: su ACL ya
-- esta materializada y CREATE OR REPLACE la conserva. El REVOKE es un no-op sobre
-- el ACL (lo verifica la POSTCONDICION 1 contra el snapshot) y deja la constancia
-- estatica que exige guard:secdef-exposure (R2) para toda SECURITY DEFINER
-- redefinida. El trigger de repuestos queda fuera: no es invocable.
REVOKE ALL ON FUNCTION private.create_supplier_purchase_atomic(uuid, uuid, uuid, text, date, text, numeric, numeric, text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_supplier_purchase_safe(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repair_missing_stock_movements(uuid, boolean) FROM PUBLIC;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. POSTCONDICIONES (sobre el catalogo resultante; cualquier falla revierte todo)
-- ════════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  s        record;
  v_now    record;
  v_helper oid := to_regprocedure('private.lock_inventory_rows(uuid,uuid[])');
  v_ok     boolean;
  v_sig    text;
  v_src    text;
  v_n      bigint;
BEGIN
  -- POSTCONDICION 1 · los 4 writers conservan OID, SECURITY DEFINER, owner,
  -- search_path y ACL exactamente como antes del CREATE OR REPLACE.
  FOR s IN SELECT * FROM _g2c2_snapshot WHERE rol = 'writer' LOOP
    SELECT p.oid, p.prosecdef, p.proowner, p.proconfig, p.proacl, md5(p.prosrc) AS src_md5
      INTO v_now FROM pg_proc p WHERE p.oid = s.oid;
    IF NOT FOUND THEN RAISE EXCEPTION 'POSTCONDICION 1: % cambio de OID (dejo de ser la misma funcion)', s.firma; END IF;
    IF v_now.prosecdef IS DISTINCT FROM s.prosecdef THEN RAISE EXCEPTION 'POSTCONDICION 1: % cambio SECURITY DEFINER', s.firma; END IF;
    IF v_now.proowner  IS DISTINCT FROM s.proowner  THEN RAISE EXCEPTION 'POSTCONDICION 1: % cambio de owner', s.firma; END IF;
    IF v_now.proconfig IS DISTINCT FROM s.proconfig THEN
      RAISE EXCEPTION 'POSTCONDICION 1: % cambio su search_path (% -> %)', s.firma, s.proconfig, v_now.proconfig;
    END IF;
    IF v_now.proacl    IS DISTINCT FROM s.proacl    THEN
      RAISE EXCEPTION 'POSTCONDICION 1: % cambio su ACL (% -> %)', s.firma, s.proacl, v_now.proacl;
    END IF;
    IF v_now.src_md5 = s.src_md5 THEN RAISE EXCEPTION 'POSTCONDICION 1: % no cambio su cuerpo', s.firma; END IF;
  END LOOP;

  -- POSTCONDICION 2 · checkout, compra rapida y anulacion NO se tocaron.
  FOR s IN SELECT * FROM _g2c2_snapshot WHERE rol = 'intacta' LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = s.oid) IS DISTINCT FROM s.src_md5 THEN
      RAISE EXCEPTION 'POSTCONDICION 2: % cambio y G2-C.2 no debia tocarla', s.firma;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM _g2c2_snapshot WHERE rol = 'writer') <> 4
     OR (SELECT count(*) FROM _g2c2_snapshot WHERE rol = 'intacta') <> 3 THEN
    RAISE EXCEPTION 'POSTCONDICION 2: el snapshot no tiene las 4 + 3 funciones esperadas';
  END IF;

  -- POSTCONDICION 3 · el helper: plpgsql, SECURITY INVOKER, owner postgres,
  -- search_path pg_catalog/pg_temp y SIN EXECUTE para PUBLIC ni roles de API.
  IF v_helper IS NULL THEN RAISE EXCEPTION 'POSTCONDICION 3: falta private.lock_inventory_rows'; END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_helper) THEN
    RAISE EXCEPTION 'POSTCONDICION 3: el helper es SECURITY DEFINER';
  END IF;
  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_helper) <> 'postgres' THEN
    RAISE EXCEPTION 'POSTCONDICION 3: el helper no es de postgres';
  END IF;
  IF (SELECT l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = v_helper) <> 'plpgsql' THEN
    RAISE EXCEPTION 'POSTCONDICION 3: el helper no es plpgsql';
  END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid = v_helper) IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
    RAISE EXCEPTION 'POSTCONDICION 3: search_path del helper inesperado: %', (SELECT proconfig FROM pg_proc WHERE oid = v_helper);
  END IF;
  -- proacl NULL significa "default" = EXECUTE para PUBLIC (y aclexplode(NULL) da
  -- un falso negativo): tiene que estar materializado y sin grantee 0 (PUBLIC).
  IF (SELECT proacl FROM pg_proc WHERE oid = v_helper) IS NULL
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_helper AND a.grantee = 0) THEN
    RAISE EXCEPTION 'POSTCONDICION 3: el helper conserva EXECUTE para PUBLIC';
  END IF;
  IF has_function_privilege('anon', v_helper, 'EXECUTE')
     OR has_function_privilege('authenticated', v_helper, 'EXECUTE')
     OR has_function_privilege('service_role', v_helper, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 3: un rol de API puede ejecutar el helper';
  END IF;

  -- POSTCONDICION 4 · el helper es fail-closed sin tenant y neutro sin ids.
  BEGIN
    PERFORM private.lock_inventory_rows(NULL, '{}'::uuid[]);
    v_ok := false;
  EXCEPTION WHEN invalid_parameter_value THEN
    v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'POSTCONDICION 4: el helper acepta business_id NULL'; END IF;
  IF private.lock_inventory_rows(gen_random_uuid(), NULL) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 4: el helper bloqueo filas con ids NULL';
  END IF;

  -- POSTCONDICION 5 · los 4 writers llaman al helper.
  FOREACH v_sig IN ARRAY ARRAY[
    'private.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text)',
    'public.delete_supplier_purchase_safe(uuid,uuid,uuid)',
    'public.repair_missing_stock_movements(uuid,boolean)',
    'public.adjust_stock_on_order_item()'
  ] LOOP
    IF position('private.lock_inventory_rows(' IN (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(v_sig))) = 0 THEN
      RAISE EXCEPTION 'POSTCONDICION 5: % no toma el lock canonico', v_sig;
    END IF;
  END LOOP;

  -- POSTCONDICION 6 · INVARIANTE DE CATALOGO: toda funcion de public/private que
  -- escriba stock en inventory bloquea antes (helper o pre-lock ORDER BY id).
  -- Atrapa tambien writers futuros que olviden el lock.
  FOR s IN
    SELECT p.oid::regprocedure::text AS firma, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
       AND p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*='
  LOOP
    IF position('private.lock_inventory_rows(' IN s.prosrc) = 0
       AND s.prosrc !~* 'order\s+by\s+(i\.)?id\s+for\s+(no\s+key\s+)?update' THEN
      RAISE EXCEPTION 'POSTCONDICION 6: % escribe stock sin lock canonico previo', s.firma;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
     AND p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*=';
  IF v_n <> 7 THEN
    RAISE EXCEPTION 'POSTCONDICION 6: se esperaban 7 writers de stock server-side, hay %', v_n;
  END IF;

  -- POSTCONDICION 7 · W7 ya no accede a inventory solo por id, y tiene la
  -- identidad inmutable en UPDATE.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.adjust_stock_on_order_item()');
  IF v_src ~* 'where\s+id\s*=\s*(new|old)\.product_id\s*;' THEN
    RAISE EXCEPTION 'POSTCONDICION 7: adjust_stock_on_order_item sigue accediendo a inventory sin business_id';
  END IF;
  IF position('ORDER_ITEM_STOCK_IDENTITY_IMMUTABLE' IN v_src) = 0 OR position('0A000' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 7: adjust_stock_on_order_item perdio la identidad inmutable';
  END IF;
  IF position('INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 7: adjust_stock_on_order_item perdio el fail-closed de tenant';
  END IF;

  -- POSTCONDICION 8 · el trigger sigue ligado, ENABLED y con la misma forma.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.order_items'::regclass
       AND t.tgname  = 'trg_adjust_stock_on_order_item'
       AND t.tgenabled = 'O'
       AND t.tgfoid  = to_regprocedure('public.adjust_stock_on_order_item()')
       AND (t.tgtype::int & 31) = 31
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 8: se perdio trg_adjust_stock_on_order_item';
  END IF;

  -- POSTCONDICION 9 · regresion G2-C: ningun writer tocado reintroduce un clamp
  -- y la aritmetica sigue presente.
  FOREACH v_sig IN ARRAY ARRAY[
    'private.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text)',
    'public.delete_supplier_purchase_safe(uuid,uuid,uuid)',
    'public.repair_missing_stock_movements(uuid,boolean)',
    'public.adjust_stock_on_order_item()'
  ] LOOP
    IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(v_sig))
       ~* 'greatest\s*\(\s*(0\s*,\s*)?(coalesce\s*\(\s*)?v_prev_st' THEN
      RAISE EXCEPTION 'POSTCONDICION 9: % reintrodujo un clamp', v_sig;
    END IF;
  END LOOP;
  IF position('v_prev_stock - NEW.cantidad' IN v_src) = 0
     OR position('v_prev_stock + OLD.cantidad' IN v_src) = 0
     OR position('v_prev_stock - v_qty_change' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 9: adjust_stock_on_order_item perdio su aritmetica G2-C';
  END IF;

  RAISE NOTICE 'G2-C.2 OK · helper private.lock_inventory_rows (NO KEY UPDATE, ORDER BY id, por negocio, sin EXECUTE de API) '
    '· W4/W5/W6/W7 bloquean antes de leer · W7 acotado al negocio e identidad inmutable '
    '· checkout/compra rapida/anulacion intactos · OID/owner/secdef/search_path/ACL preservados';
END
$post$;

COMMIT;
