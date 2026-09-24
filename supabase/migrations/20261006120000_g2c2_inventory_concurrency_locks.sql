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
-- y con cualquier otro lock de escritura sobre la fila) y NO choca con el
-- FOR KEY SHARE de los chequeos FK, asi que no agrega aristas nuevas al grafo.
--
-- G2-C.2R (en esta MISMA migracion, para que G2-C.2 sea una sola unidad
-- transaccional). Checkout, compra rapida y anulacion bloqueaban inventario con
-- FOR UPDATE, el unico modo que choca con el FOR KEY SHARE que toma cualquier
-- INSERT que referencia inventory (FK). Probado: checkout [A,B] contra el alta
-- mayorista [B,A] (wholesale_order_items en orden del payload) -> deadlock 3/3,
-- victima el POS. Ninguno de los tres cambia claves de inventory: protegen un
-- read-modify-write de stock, y su UPDATE posterior toma NO KEY UPDATE igual. Se
-- normalizan a FOR NO KEY UPDATE, que serializa igual contra los writers de stock
-- y deja de chocar con los inserts que solo referencian el producto. Eso cierra
-- la CLASE (alta mayorista, repuestos de servicio, lineas de comprobante,
-- movimientos...), no solo el caso mayorista, que no se toca.
--
-- QUE CAMBIA (7 writers + 1 helper):
--   W1 private.create_comprobante_checkout_atomic      inventory FOR UPDATE -> FOR NO KEY UPDATE (2)
--   W2 private.create_quick_inventory_purchase_atomic  inventory FOR UPDATE -> FOR NO KEY UPDATE (1)
--   W3 private.sec08e_annul_comprobante_impl           inventory FOR UPDATE -> FOR NO KEY UPDATE (1);
--      sus locks de comprobante, pagos y cuenta corriente siguen FOR UPDATE
--   W4 private.create_supplier_purchase_atomic  pre-lock ordenado antes del loop
--   W5 public.delete_supplier_purchase_safe     pre-lock ordenado antes del loop
--   W6 public.repair_missing_stock_movements    pre-lock ordenado antes de los loops
--   W7 public.adjust_stock_on_order_item()      lock acotado al negocio (cierra el
--      cross-tenant), pre-lock de la orden entera al borrar (cascada), e identidad
--      inmutable en UPDATE (negocio/orden/producto/tipo -> 0A000)
-- En W1/W2/W3 el cambio es SOLO el modo de lock: la postcondicion 2 prueba que
-- volver 'FOR NO KEY UPDATE' a 'FOR UPDATE' reproduce el md5 del cuerpo original.
--
-- QUE NO CAMBIA. Firmas, OID, owner, SECURITY DEFINER, search_path, ACL,
-- respuestas, autoridad, aritmetica G2-C (stock negativo permitido, sin clamp),
-- movimientos, marcadores, idempotencia, notas de credito, auditoria y finanzas.
-- G2-C.1 (alta mayorista) no se toca. Los wrappers publicos no se tocan:
-- bloquear inventario ahi seria ANTES del advisory de periodo e invertiria el
-- orden global.
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

-- Snapshot de lo que CREATE OR REPLACE debe preservar. Se identifica por OID (el
-- texto de regprocedure depende del search_path).
--   rol 'writer' (W4-W7): cuerpo nuevo con el lock canonico.
--   rol 'modo'   (W1-W3): cuerpo original con SOLO el modo de lock de inventory
--                         normalizado a FOR NO KEY UPDATE (G2-C.2R).
-- orig_md5 = md5 del cuerpo de main 4383a9f SIN retornos de carro (produccion
-- tiene funciones con CRLF en prosrc; eso no es drift).
CREATE TEMP TABLE _g2c2_snapshot ON COMMIT DROP AS
SELECT p.oid, f.firma, f.rol, f.orig_md5, p.prosecdef, p.proowner, p.proconfig, p.proacl,
       md5(replace(p.prosrc, E'\r', '')) AS src_md5
  FROM (VALUES
    ('private.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text)', 'writer', 'aa891707ae4f775d2b738c1f1182dd00'),
    ('public.delete_supplier_purchase_safe(uuid,uuid,uuid)',                                                          'writer', 'aae8d25e5a74d700b72cb099b454de37'),
    ('public.repair_missing_stock_movements(uuid,boolean)',                                                           'writer', 'b33f975ee023e3ab05680f07049da03a'),
    ('public.adjust_stock_on_order_item()',                                                                           'writer', '0660fb3d61a278d387e92422ae9c0c60'),
    ('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',                                              'modo',   'dd6e88aeb16f12d6800ac7848c367d1e'),
    ('private.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb)',      'modo',   '4b2f40926e0b36bec3d32d5e58407c3e'),
    ('private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)',                                            'modo',   '72f9a16bec124d6588c23a4ce21685bf')
  ) AS f(firma, rol, orig_md5)
  JOIN pg_proc p ON p.oid = to_regprocedure(f.firma);

DO $pre8$
DECLARE s record;
BEGIN
  -- PRECONDICION 8 · SIN DRIFT: los 7 cuerpos son exactamente los de main 4383a9f
  -- (salvo CRLF). CREATE OR REPLACE reemplaza el cuerpo entero: si produccion
  -- tuviera otra version, pisarla en silencio seria peor que abortar.
  IF (SELECT count(*) FROM _g2c2_snapshot) <> 7 THEN
    RAISE EXCEPTION 'PRECONDICION 8: se esperaban 7 funciones en el snapshot, hay %', (SELECT count(*) FROM _g2c2_snapshot);
  END IF;
  FOR s IN SELECT * FROM _g2c2_snapshot WHERE src_md5 IS DISTINCT FROM orig_md5 LOOP
    RAISE EXCEPTION 'PRECONDICION 8: % tiene drift (md5 % <> main %): no se pisa, revisar antes', s.firma, s.src_md5, s.orig_md5;
  END LOOP;
END
$pre8$;

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

-- ── G2-C.2R · W1 private.create_comprobante_checkout_atomic (solo el modo de lock de inventory) ───
CREATE OR REPLACE FUNCTION private.create_comprobante_checkout_atomic(p_business_id uuid, p_idempotency_key text, p_request_hash text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  c_tolerance_ars     constant numeric := 1.00;
  v_has_access        boolean := false;
  v_existing          comprobante_checkout_requests%ROWTYPE;
  v_request_id        uuid;
  v_comp_id           uuid;
  v_tipo              text;
  v_es_fiscal         boolean;
  v_emitir_en_arca    boolean;
  v_skip_finance      boolean;
  v_exchange_rate     numeric;
  v_customer_id       uuid;
  v_caja_id           uuid;
  v_punto_venta       text;
  v_arca_pv           integer;
  v_tipo_es_fiscal    boolean;
  v_condicion_fiscal  text;
  v_observaciones     text;
  v_order_id          uuid;
  v_estado_comercial  text;
  v_subtotal_ars      numeric := 0;
  v_tax               numeric := 0;
  v_total             numeric := 0;
  v_total_usd         numeric := 0;
  v_descuento_total   numeric := 0;
  v_costo_total_ars   numeric := 0;
  v_total_comisiones  numeric;
  v_total_neto        numeric;
  v_total_bruto       numeric;
  v_cc_total          numeric;
  v_cash_total        numeric := 0;
  v_numero_int        integer;
  v_numero            text;
  v_item              jsonb;
  v_pago              jsonb;
  v_item_id           uuid;
  v_prev_stock        integer;
  v_new_stock         integer;
  v_mov_id            uuid;
  v_account_id        uuid;
  v_customer_name     text;
  v_customer_phone    text;
  v_is_wholesale      boolean;
  v_dollar_rate       numeric := 1;
  v_can_override      boolean;
  v_can_below_cost    boolean;
  v_inv               inventory%ROWTYPE;
  v_line_qty          numeric;
  v_line_desc_pct     numeric;
  v_line_price_client numeric;
  v_line_price_final  numeric;
  v_line_cost_final   numeric;
  v_line_mayorista    numeric;
  v_price_source      text;
  v_is_override       boolean;
  v_line_subtotal     numeric;
  v_line_cost_total   numeric;
  v_resolved_items    jsonb := '[]'::jsonb;
  v_pago_ars          numeric;
  -- M7 6E.2
  v_economic_date     date;
  v_n_products        int := 0;
  v_n_payments        int := 0;
  v_in_audit          boolean := false;
  v_ec                text;
  v_ret_msg           text;
  -- M7 6E.2a
  v_server_hash       text;
  v_hashes_match      boolean;
  v_pay_id            uuid;
  v_pay_ids           uuid[] := '{}';
  v_pay_methods       text[] := '{}';
  v_pay_summary       jsonb := '[]'::jsonb;
  v_fm_ids            uuid[];
  v_cogs_bfe_id       uuid;
  v_am_id             uuid;
BEGIN
  -- ── Ownership: resolver y validar acceso real al negocio ────────────────
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = p_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'No autorizado para este negocio', 'error_code', 'FORBIDDEN');
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'idempotency_key requerida', 'error_code', 'VALIDATION_ERROR');
  END IF;
  IF p_request_hash IS NULL OR length(trim(p_request_hash)) = 0 THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'request_hash requerido', 'error_code', 'VALIDATION_ERROR');
  END IF;

  -- Una Nota de Credito no es una venta generica. Necesita un comprobante
  -- original autorizado para resolver CbtesAsoc y su CbteTipo (A->3, B->8,
  -- C->13). Cortar ANTES del hash y del INSERT idempotente evita tanto una NC
  -- sin original como cualquier escritura residual de un intento invalido.
  v_tipo := p_payload->>'tipo';
  IF v_tipo = 'nota_credito' THEN
    RETURN jsonb_build_object(
      'status', 'failed_final',
      'error_code', 'CREDIT_NOTE_REQUIRES_ORIGINAL',
      'error', 'La Nota de Credito debe crearse desde un comprobante fiscal original');
  END IF;
  IF v_tipo IS NULL OR v_tipo NOT IN ('remito', 'factura_a', 'factura_c') THEN
    RETURN jsonb_build_object(
      'status', 'failed_final',
      'error_code', 'VALIDATION_ERROR',
      'error', format('tipo de comprobante invalido: %s', COALESCE(v_tipo, 'NULL')));
  END IF;
  v_emitir_en_arca := COALESCE((p_payload->>'emitir_en_arca')::boolean, false);
  IF v_tipo = 'remito' AND v_emitir_en_arca THEN
    RETURN jsonb_build_object(
      'status', 'failed_final',
      'error_code', 'NON_FISCAL_ARCA_NOT_ALLOWED',
      'error', 'Un remito no fiscal no puede solicitar emision en ARCA');
  END IF;

  v_can_override   := user_can_override_price(p_business_id, auth.uid());
  v_can_below_cost := user_can_sell_below_cost(p_business_id, auth.uid());

  -- ── M7 6E.2a: hash canonico SERVER-SIDE (autoridad de idempotencia) ANTES de
  -- reservar. El cliente NO es fuente de verdad. Valida metodos de pago (rechazo
  -- antes de reservar). p_request_hash se conserva para compat/diagnostico.
  BEGIN
    v_server_hash := public.compute_checkout_intent_hash(p_business_id, p_payload);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'INVALID_CHECKOUT_METHOD%' THEN
      RETURN jsonb_build_object('status','failed_final','error','Método de pago inválido','error_code','VALIDATION_ERROR');
    ELSE RAISE; END IF;
  END;
  v_hashes_match := (p_request_hash IS NOT DISTINCT FROM v_server_hash);

  -- ── Idempotencia: intentar registrar la request — ESTE INSERT ES EL LOCK ──
  -- (idx UNIQUE business_id,idempotency_key). Replay/conflict retornan ANTES de
  -- cualquier escritura economica y del guard de periodo (no crean una venta nueva).
  SET LOCAL lock_timeout = '8s';
  BEGIN
    INSERT INTO comprobante_checkout_requests (business_id, user_id, op, idempotency_key, client_request_hash, server_request_hash, status)
    VALUES (p_business_id, auth.uid(), 'sale_checkout', p_idempotency_key, p_request_hash, v_server_hash, 'processing')
    RETURNING id INTO v_request_id;
  EXCEPTION
    WHEN lock_not_available THEN
      RETURN jsonb_build_object('status', 'already_processing');
    WHEN unique_violation THEN
      SELECT * INTO v_existing FROM comprobante_checkout_requests
        WHERE business_id = p_business_id AND idempotency_key = p_idempotency_key;

      -- Replay/conflicto por server_request_hash (autoridad). Fallback legacy:
      -- filas antiguas sin server hash usan client_request_hash (comportamiento previo).
      IF (v_existing.server_request_hash IS NOT NULL AND v_existing.server_request_hash IS DISTINCT FROM v_server_hash)
         OR (v_existing.server_request_hash IS NULL AND v_existing.client_request_hash IS DISTINCT FROM p_request_hash) THEN
        RETURN jsonb_build_object('status', 'idempotency_conflict', 'error_code', 'IDEMPOTENCY_CONFLICT');
      END IF;

      IF v_existing.status = 'completed' THEN
        RETURN jsonb_build_object('status', 'existing', 'comprobante_id', v_existing.comprobante_id);
      ELSIF v_existing.status = 'failed_final' THEN
        RETURN jsonb_build_object('status', 'failed_final', 'error', v_existing.last_error_message, 'error_code', COALESCE(v_existing.last_error_code,'INTERNAL_ERROR'));
      ELSIF v_existing.status = 'processing' THEN
        RETURN jsonb_build_object('status', 'already_processing');
      ELSE -- 'failed_retryable'
        UPDATE comprobante_checkout_requests
          SET status = 'processing', updated_at = now()
          WHERE id = v_existing.id AND status = 'failed_retryable';
        IF NOT FOUND THEN
          RETURN jsonb_build_object('status', 'already_processing');
        END IF;
        v_request_id := v_existing.id;
      END IF;
  END;

  -- ── Bloque de trabajo (savepoint implícito vía EXCEPTION) ────────────────
  BEGIN
    -- M7 §5: fecha economica canonica (el checkout siempre crea ventas actuales).
    v_economic_date := public.ar_today();
    -- M7 §5: guard de periodo defensivo ANTES de cualquier escritura economica.
    -- (el mes actual no puede cerrarse via close_period; casi siempre no-op.)
    PERFORM public.assert_period_open(p_business_id, v_economic_date);
    -- M7 §6: scope de auditoria -> el backstop E1 de comprobante_payments/account_movements
    -- NO registra por-linea; al final se emite UN unico evento sale_checkout.
    PERFORM public.finance_begin_audit_scope();

    v_emitir_en_arca   := COALESCE((p_payload->>'emitir_en_arca')::boolean, false);
    v_skip_finance     := COALESCE((p_payload->>'skip_finance_entry')::boolean, false);
    v_exchange_rate    := COALESCE((p_payload->>'exchange_rate')::numeric, 1);
    v_customer_id      := NULLIF(p_payload->>'customer_id', '')::uuid;
    v_caja_id          := NULLIF(p_payload->>'caja_id', '')::uuid;
    -- == P0 · PUNTO DE VENTA FISCAL: lo resuelve el SERVIDOR ==================
    -- El cliente manda el PV que muestra el POS (sales_points.numero). Eso es
    -- legitimo para un remito, pero NO puede definir la identidad fiscal de una
    -- factura: el CAE se pide SIEMPRE con arca_config.punto_venta
    -- (ver claim_comprobante_arca_emission), asi que confiar en el payload
    -- dejaba comprobantes fiscales persistidos con un PV inexistente en AFIP.
    --
    -- La fiscalidad se deriva del TIPO, no del payload: si se leyera es_fiscal
    -- del cliente, mandar es_fiscal=false junto a tipo=factura_c alcanzaria
    -- para quedarse con el PV local.
    v_tipo_es_fiscal := (v_tipo IN ('factura_a', 'factura_c'));

    -- Fuente unica de fiscalidad persistida: el tipo validado. El cliente no
    -- puede degradar una factura a no_fiscal mandando es_fiscal=false, ni puede
    -- marcar un remito para emision ARCA.
    v_es_fiscal      := v_tipo_es_fiscal;
    v_emitir_en_arca := v_emitir_en_arca AND v_tipo_es_fiscal;

    IF v_tipo_es_fiscal THEN
      SELECT punto_venta INTO v_arca_pv
        FROM arca_config
       WHERE business_id = p_business_id
         AND punto_venta > 0;

      IF v_arca_pv IS NOT NULL THEN
        -- Fuente canonica. El payload se descarta.
        v_punto_venta := lpad(v_arca_pv::text, 4, '0');
      ELSIF v_emitir_en_arca THEN
        -- Se pidio CAE y no hay configuracion: fail-closed explicito. Jamas
        -- inventar un PV para un documento que va a pedir autorizacion a AFIP.
        RAISE EXCEPTION 'ARCA_NOT_CONFIGURED: falta el punto de venta de ARCA para emitir un comprobante fiscal';
      ELSE
        -- Fiscal SIN integracion ARCA - hoy el caso por defecto. No hay fuente
        -- canonica todavia, asi que se usa el mismo DEFAULT que declara
        -- arca_config.punto_venta (1) y NUNCA el PV local del cliente. El
        -- comprobante queda en estado_fiscal='pendiente_emision' y la impresion
        -- lo rotula como numero interno, asi que este valor no se presenta como
        -- identidad fiscal emitida.
        v_punto_venta := '0001';
      END IF;
    ELSE
      -- No fiscal (remito): el PV local de sales_points es legitimo.
      v_punto_venta := COALESCE(p_payload->>'punto_venta', '0001');
    END IF;
    v_condicion_fiscal := COALESCE(p_payload->>'condicion_fiscal', 'Consumidor Final');
    v_observaciones    := p_payload->>'observaciones';
    v_order_id         := NULLIF(p_payload->>'order_id', '')::uuid;

    -- ── Cliente mayorista/minorista (server-side, nunca confiado del payload) ──
    v_is_wholesale := false;
    IF v_customer_id IS NOT NULL THEN
      SELECT (customer_type = 'mayorista'), name, phone
        INTO v_is_wholesale, v_customer_name, v_customer_phone
        FROM customers WHERE id = v_customer_id AND business_id = p_business_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: el cliente no pertenece a este negocio';
      END IF;
      v_is_wholesale := COALESCE(v_is_wholesale, false);
    END IF;

    -- M7 §4: orden del MISMO negocio (si viene)
    IF v_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders WHERE id = v_order_id AND business_id = p_business_id) THEN
      RAISE EXCEPTION 'ORDER_NOT_FOUND: la orden no pertenece a este negocio';
    END IF;

    -- ── Cotización vigente del negocio (server-side) ─────────────────────────
    SELECT rate INTO v_dollar_rate FROM exchange_rates
      WHERE business_id = p_business_id AND base_currency = 'USD' AND target_currency = 'ARS'
      ORDER BY updated_at DESC LIMIT 1;
    v_dollar_rate := COALESCE(v_dollar_rate, 1);

    -- ── 1-2. Ítems: resolver precio/costo server-side, validar overrides ─────
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'items', '[]'::jsonb))
    LOOP
      v_line_qty          := COALESCE((v_item->>'cantidad')::numeric, 0);
      v_line_desc_pct     := LEAST(GREATEST(COALESCE((v_item->>'descuento_linea')::numeric, 0), 0), 100);
      v_line_price_client := COALESCE((v_item->>'precio_unitario')::numeric, 0);

      -- M7 §9: cantidades ENTERAS positivas (TechRepair maneja solo unidades enteras).
      -- Sin FLOOR/truncado silencioso: 1.5/0.5/2.0001/0/negativos/NaN/Infinity -> rechazo.
      IF v_line_qty::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_line_qty < 1 OR v_line_qty <> trunc(v_line_qty) OR v_line_qty > 1000000 THEN
        RAISE EXCEPTION 'QTY_NOT_INTEGER: cantidad entera >=1 requerida (item: %)', v_item->>'descripcion';
      END IF;
      IF v_line_price_client::text IN ('NaN', 'Infinity', '-Infinity') OR v_line_price_client < 0 THEN
        RAISE EXCEPTION 'precio_unitario invalido (negativo, NaN o infinito) en item: %', v_item->>'descripcion';
      END IF;

      IF NULLIF(v_item->>'inventory_id', '') IS NOT NULL THEN
        -- ── Ítem de PRODUCTO: resolver desde inventory, nunca confiar en el payload ──
        SELECT * INTO v_inv FROM inventory
          WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'inventory_id % no pertenece a este negocio o no existe', v_item->>'inventory_id';
        END IF;

        SELECT sale_ars, cost_ars, mayorista_ars INTO v_line_price_final, v_line_cost_final, v_line_mayorista
          FROM resolve_product_pricing(
            v_inv.sale_price, v_inv.precio_mayorista, v_inv.cost_price, v_inv.cost_price_usd,
            v_inv.base_currency, v_inv.base_price, v_inv.auto_update_price, v_inv.exchange_rate_used,
            v_dollar_rate
          );
        v_line_desc_pct := LEAST(GREATEST(COALESCE((v_item->>'descuento_linea')::numeric, 0), 0), 100);

        IF v_is_wholesale AND v_line_mayorista IS NOT NULL AND v_line_mayorista > 0 THEN
          v_line_price_final := v_line_mayorista;
          v_price_source := 'resolved_mayorista';
        ELSE
          v_price_source := 'resolved_minorista';
        END IF;

        -- ── Override: el cliente mandó un precio o descuento distinto del resuelto ──
        v_is_override := (abs(v_line_price_client - v_line_price_final) > 0.01) OR (v_line_desc_pct > 0);
        IF v_is_override THEN
          IF NOT v_can_override THEN
            RAISE EXCEPTION 'usuario sin permiso para modificar el precio/descuento del item: %', v_item->>'descripcion';
          END IF;
          v_price_source := 'manual_override';
        ELSE
          v_line_price_client := v_line_price_final;
        END IF;

        IF v_line_price_client < v_line_cost_final AND NOT v_can_below_cost THEN
          RAISE EXCEPTION 'usuario sin permiso para vender por debajo del costo en item: %', v_item->>'descripcion';
        END IF;
      ELSE
        -- ── Ítem de SERVICIO/MANUAL ──
        v_line_price_final := v_line_price_client;
        v_line_cost_final  := COALESCE((v_item->>'costo_unitario')::numeric, 0);
        v_price_source      := 'manual_service';
        v_is_override       := false;
      END IF;

      v_line_subtotal   := v_line_price_client * v_line_qty * (1 - v_line_desc_pct / 100.0);
      v_line_cost_total := v_line_cost_final * v_line_qty;

      v_subtotal_ars    := v_subtotal_ars + v_line_subtotal;
      v_costo_total_ars := v_costo_total_ars + v_line_cost_total;
      v_descuento_total := v_descuento_total + (v_line_price_client * v_line_qty * (v_line_desc_pct / 100.0));

      v_item := v_item
        || jsonb_build_object('_resolved_precio', v_line_price_client)
        || jsonb_build_object('_resolved_costo', v_line_cost_final)
        || jsonb_build_object('_resolved_subtotal', v_line_subtotal)
        || jsonb_build_object('_resolved_descuento', v_line_desc_pct)
        || jsonb_build_object('_price_source', v_price_source)
        || jsonb_build_object('_price_override', v_is_override)
        || jsonb_build_object('_list_price', v_line_price_final);

      v_resolved_items := v_resolved_items || jsonb_build_array(v_item);
    END LOOP;

    v_tax   := CASE WHEN v_tipo = 'factura_a' THEN v_subtotal_ars * 0.21 ELSE 0 END;
    v_total := v_subtotal_ars + v_tax;
    v_total_usd := CASE WHEN v_dollar_rate > 0 THEN v_total / v_dollar_rate ELSE 0 END;
    v_total_bruto := v_total;

    -- ── Pagos: sumar server-side (nunca confiar en un total de pagos del cliente) ──
    SELECT COALESCE(SUM((p->>'amount_ars')::numeric), 0) INTO v_cash_total
      FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb)) p;
    v_cc_total := COALESCE((p_payload->>'cc_total')::numeric, 0);

    FOR v_pago IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb))
    LOOP
      IF COALESCE((v_pago->>'amount')::numeric, -1) < 0
         OR COALESCE((v_pago->>'amount_ars')::numeric, -1) < 0
         OR COALESCE((v_pago->>'amount_ars')::numeric, 0)::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'pago con monto negativo o invalido no permitido';
      END IF;
    END LOOP;
    IF v_cc_total < 0 OR v_cc_total::text IN ('NaN', 'Infinity', '-Infinity') THEN
      RAISE EXCEPTION 'cc_total invalido';
    END IF;

    -- ── INVARIANTE DE COBRO (Etapa 0) ─────────────────────────────────────────
    IF v_cc_total > 0.01 AND v_customer_id IS NULL THEN
      RAISE EXCEPTION 'la cuenta corriente requiere un cliente asignado (cc=% sin customer_id)', v_cc_total;
    END IF;

    IF v_tipo = 'nota_credito' THEN
      -- Una NC es un documento de reversión: no lleva cobros ni genera deuda.
      IF v_cash_total > 0.01 OR v_cc_total > 0.01 THEN
        RAISE EXCEPTION 'una nota de credito no lleva pagos ni cuenta corriente (pagos=%, cc=%)', v_cash_total, v_cc_total;
      END IF;
    ELSE
      IF (v_cash_total + v_cc_total) > (v_total_bruto + c_tolerance_ars) THEN
        RAISE EXCEPTION 'los pagos (caja + cuenta corriente) exceden el total: total=% pagos=% cuenta_corriente=% diferencia=%',
          round(v_total_bruto, 2), round(v_cash_total, 2), round(v_cc_total, 2),
          round((v_cash_total + v_cc_total) - v_total_bruto, 2);
      END IF;
      IF (v_cash_total + v_cc_total) < (v_total_bruto - c_tolerance_ars) THEN
        RAISE EXCEPTION 'el cobro no cubre el total del comprobante: total=% pagos=% cuenta_corriente=% diferencia=% — completá el pago o registrá el saldo explícitamente como cuenta corriente',
          round(v_total_bruto, 2), round(v_cash_total, 2), round(v_cc_total, 2),
          round(v_total_bruto - (v_cash_total + v_cc_total), 2);
      END IF;
    END IF;

    v_total_comisiones := COALESCE((p_payload->>'total_comisiones')::numeric, 0);
    v_total_neto       := v_total_bruto - v_total_comisiones;

    v_estado_comercial := CASE
      WHEN v_cash_total >= v_total_bruto - c_tolerance_ars THEN 'pagado'
      WHEN v_cash_total > 0 OR v_cc_total > 0 THEN 'parcial'
      ELSE 'pendiente'
    END;

    -- ── Número local: reserva ATÓMICA ─────────────────────────────────────────
    v_numero_int := reserve_comprobante_number(p_business_id, v_tipo);
    IF v_punto_venta IS NULL OR trim(v_punto_venta) = '' THEN
      v_numero := lpad(v_numero_int::text, 8, '0');
    ELSE
      v_numero := lpad(v_punto_venta, 4, '0') || '-' || lpad(v_numero_int::text, 8, '0');
    END IF;

    -- ── 3. Comprobante ────────────────────────────────────────────────────────
    INSERT INTO comprobantes (
      business_id, created_by, customer_id, order_id, tipo, type, punto_venta,
      numero, number, numero_secuencial, fecha, date, condicion_fiscal, observaciones, currency,
      exchange_rate, subtotal, impuestos, tax, total, total_ars, total_usd,
      descuento_total, recargo_total, total_bruto, total_cobrado, saldo_pendiente,
      total_comisiones, total_neto, estado, status, estado_comercial, estado_fiscal,
      es_fiscal, emitir_en_arca, cae, cae_vencimiento, numero_fiscal
    ) VALUES (
      p_business_id, auth.uid(), v_customer_id, v_order_id, v_tipo, v_tipo, v_punto_venta,
      v_numero, v_numero, v_numero_int, now(), now(), v_condicion_fiscal, v_observaciones, 'ARS',
      v_exchange_rate, v_subtotal_ars, v_tax, v_tax, v_total, v_total, v_total_usd,
      v_descuento_total, 0, v_total_bruto, 0, v_total_bruto,
      v_total_comisiones, v_total_neto,
      CASE WHEN v_es_fiscal THEN 'borrador' ELSE 'emitido' END,
      CASE WHEN v_es_fiscal THEN 'draft' ELSE 'issued' END,
      v_estado_comercial,
      CASE WHEN v_es_fiscal THEN 'pendiente_emision' ELSE 'no_fiscal' END,
      v_es_fiscal, v_emitir_en_arca, NULL, NULL, NULL
    ) RETURNING id INTO v_comp_id;

    -- M7 §11: lock DETERMINISTA de todas las filas de inventario a descontar, en orden
    -- global por id, ANTES de tocar la primera -> evita deadlocks con lineas en distinto
    -- orden. Se permiten lineas repetidas del mismo producto (semantica POS): cada id se
    -- bloquea una vez; el descuento de stock sigue siendo por-linea mas abajo.
    IF v_tipo <> 'nota_credito' THEN
      PERFORM 1 FROM inventory
        WHERE business_id = p_business_id
          AND id IN (SELECT (it->>'inventory_id')::uuid FROM jsonb_array_elements(v_resolved_items) it
                     WHERE NULLIF(it->>'inventory_id','') IS NOT NULL
                       AND COALESCE(it->>'tipo_linea','producto') IN ('producto','repuesto'))
        ORDER BY id FOR NO KEY UPDATE;
    END IF;

    -- ── 4-5. Ítems + stock (con precio/costo YA resueltos server-side) ───────
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_resolved_items)
    LOOP
      INSERT INTO comprobante_items (
        comprobante_id, business_id, created_by, descripcion, tipo_linea, cantidad,
        precio_unitario, descuento_linea, subtotal, costo_unitario, costo_total,
        currency, exchange_rate, inventory_id, applied_price_type, orden,
        list_price_ars, price_override, applied_price_source
      ) VALUES (
        v_comp_id, p_business_id, auth.uid(),
        v_item->>'descripcion',
        COALESCE(v_item->>'tipo_linea', 'producto'),
        (v_item->>'cantidad')::numeric,
        (v_item->>'_resolved_precio')::numeric,
        (v_item->>'_resolved_descuento')::numeric,
        (v_item->>'_resolved_subtotal')::numeric,
        (v_item->>'_resolved_costo')::numeric,
        (v_item->>'_resolved_costo')::numeric * (v_item->>'cantidad')::numeric,
        COALESCE(v_item->>'currency', 'ARS'),
        COALESCE((v_item->>'exchange_rate')::numeric, v_exchange_rate),
        NULLIF(v_item->>'inventory_id', '')::uuid,
        v_item->>'applied_price_type',
        COALESCE((v_item->>'orden')::integer, 0),
        (v_item->>'_list_price')::numeric,
        (v_item->>'_price_override')::boolean,
        v_item->>'_price_source'
      ) RETURNING id INTO v_item_id;

      -- Stock: NUNCA para nota_credito (una NC no es una salida de mercadería).
      IF v_tipo <> 'nota_credito'
         AND NULLIF(v_item->>'inventory_id', '') IS NOT NULL
         AND COALESCE(v_item->>'tipo_linea', 'producto') IN ('producto', 'repuesto') THEN

        SELECT stock_quantity INTO v_prev_stock FROM inventory
          WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id
          FOR NO KEY UPDATE;

        IF FOUND THEN
          v_prev_stock := COALESCE(v_prev_stock, 0);
          v_new_stock  := (v_prev_stock - (v_item->>'cantidad')::numeric)::integer;

          UPDATE inventory SET stock_quantity = v_new_stock, updated_at = now()
            WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id;

          INSERT INTO inventory_movements (
            business_id, inventory_item_id, movement_type, quantity, previous_stock,
            new_stock, reference_type, reference_id, note, created_by
          ) VALUES (
            p_business_id, (v_item->>'inventory_id')::uuid, 'sale',
            -((v_item->>'cantidad')::numeric)::integer, v_prev_stock, v_new_stock,
            'comprobante', v_comp_id, 'Salida por venta en comprobante', auth.uid()
          ) RETURNING id INTO v_mov_id;

          UPDATE comprobante_items
            SET stock_processed = true, stock_processed_at = now(), stock_movement_id = v_mov_id
            WHERE id = v_item_id;
        END IF;
      END IF;
    END LOOP;

    -- ── 6. Pagos de caja: solo montos > 0 (un pago de $0 no existe) ────────────
    FOR v_pago IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb))
    LOOP
      v_pago_ars := COALESCE((v_pago->>'amount_ars')::numeric, 0);
      IF v_pago_ars > 0 THEN
        INSERT INTO comprobante_payments (
          comprobante_id, business_id, amount, currency, amount_ars, exchange_rate,
          payment_method, payment_provider, commission_rate, commission_amount,
          net_amount, date, created_by
        ) VALUES (
          v_comp_id, p_business_id,
          (v_pago->>'amount')::numeric, COALESCE(v_pago->>'currency', 'ARS'),
          v_pago_ars,
          COALESCE((v_pago->>'exchange_rate')::numeric, v_exchange_rate),
          public.normalize_checkout_payment_method(v_pago->>'payment_method'), v_pago->>'payment_provider',
          COALESCE((v_pago->>'commission_rate')::numeric, 0),
          COALESCE((v_pago->>'commission_amount')::numeric, 0),
          COALESCE((v_pago->>'net_amount')::numeric, v_pago_ars),
          public.ar_today(), auth.uid()
        ) RETURNING id INTO v_pay_id;
        -- M7 6E.2a: referencias compactas para la auditoria (sin datos sensibles).
        v_pay_ids     := v_pay_ids || v_pay_id;
        v_pay_methods := v_pay_methods || public.normalize_checkout_payment_method(v_pago->>'payment_method');
        v_pay_summary := v_pay_summary || jsonb_build_array(jsonb_build_object(
          'id', v_pay_id, 'method', public.normalize_checkout_payment_method(v_pago->>'payment_method'),
          'amount_ars', round(v_pago_ars,2), 'currency', COALESCE(v_pago->>'currency','ARS')));
      END IF;
    END LOOP;

    -- ── 7. COGS devengado (BFE de costo) — trazable, fecha AR. Nunca para NC. ──
    IF v_costo_total_ars > 0 AND NOT v_skip_finance AND v_tipo <> 'nota_credito' THEN
      INSERT INTO business_finance_entries (
        business_id, date, type, category, description, amount, currency,
        amount_ars, exchange_rate, created_by, source, reference_comprobante_id
      ) VALUES (
        p_business_id, public.ar_today(), 'variable_cost', 'mercaderia',
        'Costo de productos - Comprobante #' || v_numero, v_costo_total_ars,
        'ARS', v_costo_total_ars, 1, auth.uid(), 'comprobante', v_comp_id
      ) RETURNING id INTO v_cogs_bfe_id;
    END IF;

    -- ── 8. Cuenta corriente ───────────────────────────────────────────────────
    IF v_cc_total > 0.01 AND v_customer_id IS NOT NULL THEN
      SELECT id INTO v_account_id FROM accounts
        WHERE business_id = p_business_id AND entity_id = v_customer_id;

      IF v_account_id IS NULL THEN
        INSERT INTO accounts (business_id, type, entity_id, entity_name, entity_phone, balance)
          VALUES (p_business_id, 'cliente', v_customer_id, COALESCE(v_customer_name, 'Cliente'), v_customer_phone, 0)
          RETURNING id INTO v_account_id;
      END IF;

      INSERT INTO account_movements (
        business_id, account_id, date, type, description, debit, credit,
        reference_type, reference_id, created_by
      ) VALUES (
        p_business_id, v_account_id, public.ar_today(), 'venta',
        'Comprobante #' || v_numero, v_cc_total, 0,
        'comprobante', v_comp_id, auth.uid()
      ) RETURNING id INTO v_am_id;
    END IF;

    -- ── M7 §6/§15: UN unico evento de negocio (la venta completa), server-side. ──
    v_n_products := (SELECT count(*) FROM jsonb_array_elements(v_resolved_items) it WHERE NULLIF(it->>'inventory_id','') IS NOT NULL);
    v_n_payments := (SELECT count(*) FROM jsonb_array_elements(COALESCE(p_payload->'pagos','[]'::jsonb)) p WHERE COALESCE((p->>'amount_ars')::numeric,0) > 0);
    -- FM creados por trig_comprobante_payment_finance para este comprobante
    SELECT array_agg(id) INTO v_fm_ids FROM financial_movements WHERE business_id=p_business_id AND comprobante_id=v_comp_id;
    v_in_audit := true;
    PERFORM finance_log_audit(
      p_business_id, 'sale_checkout', 'comprobantes', v_comp_id, 'create_comprobante_checkout_atomic',
      p_idempotency_key, v_observaciones, v_economic_date, 'comprobante', v_comp_id,
      NULL, jsonb_build_object(
        'comprobante_id', v_comp_id, 'tipo', v_tipo, 'numero', v_numero, 'customer_id', v_customer_id,
        'order_id', v_order_id, 'currency', 'ARS', 'exchange_rate', v_exchange_rate,
        'subtotal', round(v_subtotal_ars,2), 'descuento_total', round(v_descuento_total,2), 'tax', round(v_tax,2),
        'total', round(v_total_bruto,2), 'total_percibido', round(v_cash_total,2), 'total_financiado', round(v_cc_total,2),
        'costo_total', round(v_costo_total_ars,2), 'item_count', COALESCE(jsonb_array_length(v_resolved_items),0),
        'product_count', v_n_products, 'payment_count', v_n_payments, 'estado_comercial', v_estado_comercial,
        'account_id', v_account_id, 'es_fiscal', v_es_fiscal,
        -- 6E.2a: metodos normalizados + referencias financieras compactas + ambos hashes
        'payment_methods', to_jsonb(v_pay_methods), 'payments', v_pay_summary,
        'comprobante_payment_ids', to_jsonb(v_pay_ids), 'financial_movement_ids', to_jsonb(COALESCE(v_fm_ids, '{}'::uuid[])),
        'cogs_bfe_id', v_cogs_bfe_id, 'account_movement_id', v_am_id,
        'client_request_hash', p_request_hash, 'server_request_hash', v_server_hash,
        'hash_algorithm', 'checkout_intent_v1', 'hashes_match', v_hashes_match));
    v_in_audit := false;

    -- ── Completar la request — con el hash RESUELTO (auditoría) ──────────────
    UPDATE comprobante_checkout_requests
      SET status = 'completed', comprobante_id = v_comp_id, completed_at = now(), updated_at = now(),
          resolved_checkout_hash = encode(extensions.digest(v_resolved_items::text || v_total::text || v_subtotal_ars::text, 'sha256'), 'hex')
      WHERE id = v_request_id;

    RETURN jsonb_build_object('status', 'created', 'comprobante_id', v_comp_id);

  EXCEPTION WHEN OTHERS THEN
    -- M7 §16: error_code ADITIVO. status se mantiene 'failed_retryable' (contrato POS
    -- intacto: la maquina de estados no cambia). No se expone SQLERRM inesperado.
    v_ec := CASE
      WHEN v_in_audit THEN 'AUDIT_FAILED'
      WHEN SQLERRM LIKE 'PERIOD_CLOSED%' THEN 'PERIOD_CLOSED'
      WHEN SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN 'INVALID_FINANCE_CONTEXT'
      WHEN SQLERRM LIKE 'QTY_NOT_INTEGER%' THEN 'VALIDATION_ERROR'
      WHEN SQLERRM LIKE 'CUSTOMER_NOT_FOUND%' THEN 'CUSTOMER_NOT_FOUND'
      WHEN SQLERRM LIKE 'ORDER_NOT_FOUND%' THEN 'ORDER_NOT_FOUND'
      WHEN SQLERRM LIKE 'ARCA_NOT_CONFIGURED%' THEN 'ARCA_NOT_CONFIGURED'
      WHEN SQLERRM LIKE '%no pertenece a este negocio o no existe%' THEN 'INVENTORY_NOT_FOUND'
      WHEN SQLERRM LIKE 'tipo de comprobante invalido%' OR SQLERRM LIKE 'cantidad invalida%'
        OR SQLERRM LIKE 'precio_unitario invalido%' OR SQLERRM LIKE 'pago con monto%'
        OR SQLERRM LIKE 'cc_total invalido%' OR SQLERRM LIKE '%exceden el total%'
        OR SQLERRM LIKE '%no cubre el total%' OR SQLERRM LIKE '%cuenta corriente requiere%'
        OR SQLERRM LIKE '%nota de credito no lleva%' OR SQLERRM LIKE '%sin permiso%' THEN 'VALIDATION_ERROR'
      ELSE 'INTERNAL_ERROR'
    END;
    v_ret_msg := CASE
      WHEN v_ec = 'QTY_NOT_INTEGER' OR SQLERRM LIKE 'QTY_NOT_INTEGER%' THEN 'La cantidad debe ser un número entero mayor o igual a 1'
      WHEN v_ec = 'CUSTOMER_NOT_FOUND' THEN 'El cliente no pertenece a este negocio'
      WHEN v_ec = 'ORDER_NOT_FOUND' THEN 'La orden no pertenece a este negocio'
      WHEN v_ec = 'ARCA_NOT_CONFIGURED' THEN 'Configura el punto de venta de ARCA antes de emitir un comprobante fiscal'
      WHEN v_ec = 'AUDIT_FAILED' THEN 'No se pudo registrar la auditoria de la operacion'
      WHEN v_ec = 'INTERNAL_ERROR' THEN 'No se pudo completar la operacion'
      ELSE SQLERRM
    END;
    UPDATE comprobante_checkout_requests
      SET status = 'failed_retryable', last_error_code = v_ec, last_error_message = SQLERRM,
          completed_at = now(), updated_at = now()
      WHERE id = v_request_id;
    RETURN jsonb_build_object('status', 'failed_retryable', 'error', v_ret_msg, 'error_code', v_ec);
  END;
END;
$function$;

-- ── G2-C.2R · W2 private.create_quick_inventory_purchase_atomic (solo el modo de lock de inventory) ───
CREATE OR REPLACE FUNCTION private.create_quick_inventory_purchase_atomic(p_business_id uuid, p_idempotency_key text, p_supplier_id uuid, p_supplier_name text, p_invoice text, p_date date, p_payment_method text, p_total_ars numeric, p_paid_ars numeric, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  c_key_max      constant int := 200;
  v_actor_user_id uuid := auth.uid();
  v_is_member    boolean := false;
  v_key          text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_method       text;
  v_paid         numeric := COALESCE(p_paid_ars, 0);
  v_date         date;
  v_pending      numeric;
  v_status       text;
  v_items_canon  jsonb;
  v_hash         text;
  v_existing     quick_purchase_requests%ROWTYPE;
  v_req_id       uuid;
  v_purchase     uuid;
  v_caja         uuid;
  v_item         jsonb;
  v_prev_stk     integer;
  v_new_stk      integer;
  v_qty          integer;
  v_prev_cost    numeric;
  v_mov_id       uuid;
  v_fm_id        uuid;
  v_bfe_id       uuid;
  v_payment_id   uuid;
  v_debit_id     uuid;
  v_credit_id    uuid;
  v_inv_audit    jsonb := '[]'::jsonb;
  v_inv_count    int := 0;
  v_stage        text := 'init';
BEGIN
  -- 1. Autenticacion
  IF v_actor_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  -- 2/3. Ownership/pertenencia + autorizacion (miembro activo; sin filtro de rol nuevo)
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_actor_user_id)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_actor_user_id AND COALESCE(is_active,true))) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;

  -- 4. Validacion
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  IF p_total_ars IS NULL OR p_total_ars <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El total debe ser mayor a 0'); END IF;
  IF v_paid < 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El pago no puede ser negativo'); END IF;
  -- 6E.1a: CANTIDADES ENTERAS obligatorias (TechRepair maneja solo unidades enteras).
  -- Sin redondeo ni truncado silencioso de la cantidad. Rechazo ANTES de reservar o escribir.
  -- (a) tipo numerico (rechaza NULL, string, no-numerico); (b) entero >=1 y en rango.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
             WHERE jsonb_typeof(it->'quantity') IS DISTINCT FROM 'number') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La cantidad debe ser un número entero mayor o igual a 1'); END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
             WHERE (it->>'quantity')::numeric < 1
                OR (it->>'quantity')::numeric <> trunc((it->>'quantity')::numeric)
                OR (it->>'quantity')::numeric > 1000000) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La cantidad debe ser un número entero mayor o igual a 1'); END IF;
  -- Costo unitario: numero >= 0
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
             WHERE jsonb_typeof(it->'unit_cost_ars') IS DISTINCT FROM 'number' OR (it->>'unit_cost_ars')::numeric < 0) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El costo unitario debe ser un número mayor o igual a 0'); END IF;
  -- Producto DUPLICADO dentro del payload (mismo inventory_id > 1 vez) -> rechazo (sin agrupar ni sumar)
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
             WHERE NULLIF(btrim(it->>'inventory_id'),'') IS NOT NULL
             GROUP BY btrim(it->>'inventory_id') HAVING count(*) > 1) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El mismo producto no puede aparecer más de una vez'); END IF;
  -- Proveedor del MISMO negocio (si viene)
  IF p_supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppliers WHERE id=p_supplier_id AND business_id=p_business_id) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','SUPPLIER_NOT_FOUND', 'error', 'Proveedor inexistente en este negocio'); END IF;
  -- Inventario: N distintos esperados = N encontrados en el negocio (todos existen y pertenecen)
  IF (SELECT count(DISTINCT btrim(it->>'inventory_id')) FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it WHERE NULLIF(btrim(it->>'inventory_id'),'') IS NOT NULL)
     <> (SELECT count(*) FROM inventory i WHERE i.business_id=p_business_id
           AND i.id IN (SELECT (it2->>'inventory_id')::uuid FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it2 WHERE NULLIF(btrim(it2->>'inventory_id'),'') IS NOT NULL)) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','INVENTORY_NOT_FOUND', 'error', 'Uno o más productos no existen o no pertenecen al negocio'); END IF;

  -- 5. Normalizacion: fecha economica + metodo via helper CENTRAL de proveedores
  -- (la compra rapida ES una supplier_purchase; comparte exactamente el catalogo PROV_METHODS).
  v_date := COALESCE(p_date, public.ar_today());
  BEGIN
    v_method := public.normalize_supplier_payment_method(p_payment_method);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'INVALID_PAYMENT_METHOD%' THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido'); ELSE RAISE; END IF;
  END;
  IF v_paid > 0 AND v_method IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido'); END IF;

  -- 6. Replay (hash canonico jsonb con TODO campo persistido; items ordenados)
  IF v_key IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(elem ORDER BY elem->>'inventory_id', elem->>'product_name', elem->>'quantity', elem->>'unit_cost'), '[]'::jsonb) INTO v_items_canon
    FROM (
      SELECT jsonb_build_object(
        'inventory_id', NULLIF(btrim(it->>'inventory_id'),''),
        'product_name', NULLIF(btrim(it->>'product_name'),''),
        'quantity', (it->>'quantity')::numeric::integer,  -- entero canonico (2 y 2.0 -> mismo hash)
        'unit_cost', round(COALESCE((it->>'unit_cost_ars')::numeric,0),2)) AS elem
      FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it
    ) s;
    v_hash := encode(extensions.digest(jsonb_build_object(
      'op','quick_inventory_purchase', 'business_id',p_business_id, 'supplier_id',p_supplier_id,
      'supplier_name',NULLIF(btrim(p_supplier_name),''), 'invoice',NULLIF(btrim(p_invoice),''),
      'date',v_date, 'method',v_method, 'total',round(p_total_ars,2), 'paid',round(v_paid,2),
      'currency','ARS', 'exchange_rate',1, 'items',v_items_canon)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM quick_purchase_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing.purchase_id);
    END IF;
  END IF;

  -- 7. Guard de periodo (retroactiva en periodo cerrado -> rechazo ANTES de tocar stock)
  BEGIN PERFORM public.assert_period_open(p_business_id, v_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF; END;

  -- 7.5 Caja para efectivo (misma empresa; persistida en el FM). No-efectivo: v_caja si hay.
  SELECT id INTO v_caja FROM cajas WHERE business_id=p_business_id AND status='abierta' ORDER BY opened_at DESC LIMIT 1;
  IF v_paid > 0 AND v_method = 'efectivo' AND v_caja IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'Debes abrir una caja antes de registrar un pago en efectivo'); END IF;

  -- 8. Reserva idempotente race-safe (UNIQUE + ON CONFLICT DO NOTHING)
  IF v_key IS NOT NULL THEN
    INSERT INTO quick_purchase_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_actor_user_id, 'quick_inventory_purchase', v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req_id;
    IF v_req_id IS NULL THEN
      SELECT * INTO v_existing FROM quick_purchase_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'purchase_id', v_existing.purchase_id);
    END IF;
  END IF;

  -- 9. Scope de auditoria
  PERFORM public.finance_begin_audit_scope();

  -- 10. Escrituras (todas con v_date; modelo M3-M6 intacto)
  v_stage := 'write';
  v_pending := GREATEST(0, p_total_ars - v_paid);
  v_status  := CASE WHEN v_paid<=0 THEN 'pending' WHEN v_paid >= p_total_ars - 0.01 THEN 'paid' ELSE 'partial' END;

  INSERT INTO supplier_purchases (business_id, supplier_id, purchase_date, invoice_number,
    total_amount, paid_amount, pending_amount, payment_status, payment_method, notes, created_by)
  VALUES (p_business_id, p_supplier_id, v_date, NULLIF(btrim(COALESCE(p_invoice,'')),''),
    p_total_ars, v_paid, v_pending, v_status, v_method, 'Compra rápida de inventario', v_actor_user_id)
  RETURNING id INTO v_purchase;

  -- Lock DETERMINISTA de TODAS las filas de inventario del payload, en orden global por id,
  -- ANTES de actualizar la primera. Evita deadlocks entre compras con productos en distinto
  -- orden (Sesion1 [A,B] vs Sesion2 [B,A]). Los locks se mantienen hasta el fin de la tx.
  --   PERFORM 1 FROM inventory WHERE business_id=... AND id IN (...ids...) ORDER BY id FOR NO KEY UPDATE;
  PERFORM 1 FROM inventory
    WHERE business_id=p_business_id
      AND id IN (SELECT (it->>'inventory_id')::uuid FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) it WHERE NULLIF(btrim(it->>'inventory_id'),'') IS NOT NULL)
    ORDER BY id
    FOR NO KEY UPDATE;

  -- Items + entrada de inventario. Cantidad ENTERA validada (v_qty); stock y costo se
  -- calculan desde la fila ya BLOQUEADA arriba (no se releen valores sin lock).
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb))
  LOOP
    v_qty := (v_item->>'quantity')::numeric::integer;  -- entero validado (>=1, sin fraccion); ::numeric::int acepta "2.0"
    INSERT INTO supplier_purchase_items (business_id, purchase_id, supplier_id, inventory_id,
      product_name, quantity, unit_cost, subtotal)
    VALUES (p_business_id, v_purchase, p_supplier_id, NULLIF(btrim(v_item->>'inventory_id'),'')::uuid,
      v_item->>'product_name', v_qty, (v_item->>'unit_cost_ars')::numeric,
      v_qty * (v_item->>'unit_cost_ars')::numeric);

    IF NULLIF(btrim(v_item->>'inventory_id'),'') IS NOT NULL THEN
      SELECT stock_quantity, cost_price INTO v_prev_stk, v_prev_cost FROM inventory
        WHERE id=(v_item->>'inventory_id')::uuid AND business_id=p_business_id;  -- ya bloqueada arriba
      v_new_stk := COALESCE(v_prev_stk,0) + v_qty;
      UPDATE inventory SET stock_quantity=v_new_stk, stock=v_new_stk,
        cost_price=(v_item->>'unit_cost_ars')::numeric, updated_at=now()
        WHERE id=(v_item->>'inventory_id')::uuid AND business_id=p_business_id;
      INSERT INTO inventory_movements (business_id, inventory_item_id, movement_type, quantity,
        previous_stock, new_stock, reference_type, reference_id, note, created_by, supplier_id, unit_cost, currency, exchange_rate)
      VALUES (p_business_id, (v_item->>'inventory_id')::uuid, 'purchase',
        v_qty, COALESCE(v_prev_stk,0), v_new_stk,
        'supplier_purchase', v_purchase, 'Compra rápida', v_actor_user_id, p_supplier_id,
        (v_item->>'unit_cost_ars')::numeric, 'ARS', 1) RETURNING id INTO v_mov_id;
      v_inv_count := v_inv_count + 1;
      v_inv_audit := v_inv_audit || jsonb_build_object('inventory_id', v_item->>'inventory_id',
        'quantity', v_qty, 'prev_stock', COALESCE(v_prev_stk,0), 'new_stock', v_new_stk,
        'prev_cost', v_prev_cost, 'new_cost', round((v_item->>'unit_cost_ars')::numeric,2), 'inventory_movement_id', v_mov_id);
    END IF;
  END LOOP;

  -- Deuda a proveedor (si hay proveedor): debito por el total. UNA vez.
  IF p_supplier_id IS NOT NULL THEN
    INSERT INTO supplier_account_movements (business_id, supplier_id, purchase_id, payment_id,
      movement_date, type, description, debit, credit, balance_after)
    VALUES (p_business_id, p_supplier_id, v_purchase, NULL, v_date, 'purchase', 'Compra rápida', p_total_ars, 0, 0)
    RETURNING id INTO v_debit_id;
  END IF;

  -- Pago inicial (si v_paid>0): FM salida + BFE tecnica (inventory_purchase, fuera del P&L)
  -- + supplier_payment + credito. Sin duplicar costo (no COGS al comprar).
  IF v_paid > 0 THEN
    INSERT INTO financial_movements (business_id, caja_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago, sign, reference_id, reference_type)
    VALUES (p_business_id, v_caja, v_date, 'expense', 'ARS', v_paid, v_paid, 1, 'pago_proveedor',
      'Compra rápida de inventario' || COALESCE(' — '||p_supplier_name,''), v_actor_user_id, v_method, 1, v_purchase, 'supplier_purchase')
    RETURNING id INTO v_fm_id;
    INSERT INTO business_finance_entries (business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate, payment_method, source, created_by, economic_class)
    VALUES (p_business_id, v_date, 'variable_cost', 'inventario', 'Compra de inventario' || COALESCE(' — '||p_supplier_name,''),
      v_paid, 'ARS', v_paid, 1, v_method, 'pago_proveedor', v_actor_user_id, 'inventory_purchase')
    RETURNING id INTO v_bfe_id;
    IF p_supplier_id IS NOT NULL THEN
      INSERT INTO supplier_payments (business_id, supplier_id, purchase_id, payment_date,
        amount, payment_method, notes, created_by, financial_movement_id)
      VALUES (p_business_id, p_supplier_id, v_purchase, v_date, v_paid, v_method, 'Compra rápida', v_actor_user_id, v_fm_id)
      RETURNING id INTO v_payment_id;
      INSERT INTO supplier_account_movements (business_id, supplier_id, purchase_id, payment_id,
        movement_date, type, description, debit, credit, balance_after)
      VALUES (p_business_id, p_supplier_id, v_purchase, v_payment_id, v_date, 'payment', 'Pago compra rápida', 0, v_paid, 0)
      RETURNING id INTO v_credit_id;
    END IF;
  END IF;

  -- 12. Enlace del request
  IF v_key IS NOT NULL THEN UPDATE quick_purchase_requests SET purchase_id=v_purchase WHERE id=v_req_id; END IF;

  -- 13. Auditoria explicita (evento de negocio: la compra rapida). Sin payloads enormes.
  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'quick_inventory_purchase', 'supplier_purchases', v_purchase, 'create_quick_inventory_purchase_atomic',
    v_key, 'Compra rápida de inventario', v_date, 'supplier_purchase', v_purchase,
    NULL, jsonb_build_object('supplier_id', p_supplier_id, 'total', p_total_ars, 'paid_amount', v_paid,
      'pending_amount', v_pending, 'payment_status', v_status, 'method', v_method, 'caja_id', v_caja,
      'currency','ARS', 'exchange_rate',1, 'item_count', COALESCE(jsonb_array_length(p_items),0),
      'inventory_items', v_inv_count, 'inventory', v_inv_audit,
      'financial_movement_id', v_fm_id, 'bfe_id', v_bfe_id, 'supplier_payment_id', v_payment_id,
      'supplier_debit_movement_id', v_debit_id, 'supplier_credit_movement_id', v_credit_id));

  RETURN jsonb_build_object('ok', true, 'replay', false, 'purchase_id', v_purchase);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoria de la operacion'
                  ELSE 'No se pudo completar la operacion' END);
END;
$function$;

-- ── G2-C.2R · W3 private.sec08e_annul_comprobante_impl (solo el modo de lock de inventory) ───
CREATE OR REPLACE FUNCTION private.sec08e_annul_comprobante_impl(p_comprobante_id uuid, p_mode text, p_motivo text, p_restore_stock boolean, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  c_tolerance_ars   constant numeric := 1.00;  -- misma tolerancia que el checkout
  c_key_max         constant integer := 200;
  v_actor           uuid := auth.uid();
  v_reason          text := NULLIF(btrim(COALESCE(p_motivo, '')), '');
  v_key             text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_comp            comprobantes%ROWTYPE;
  v_has_access      boolean := false;
  v_request_hash    text;
  v_prev            comprobante_annulments%ROWTYPE;
  v_numero          text;
  v_open_caja_id    uuid;
  v_cobrado         numeric := 0;
  v_commissions     numeric := 0;
  v_cc_net          numeric := 0;
  v_fm_income_total numeric := 0;
  v_account_id      uuid;
  v_fm              record;
  v_item            record;
  v_bfe             record;
  v_new_fm_id       uuid;
  v_new_bfe_id      uuid;
  v_cc_mov_id       uuid;
  v_prev_stock      integer;
  v_new_stock       integer;
  v_mov_id          uuid;
  v_original_fm_ids uuid[] := '{}';
  v_original_cajas  uuid[] := '{}';
  v_fm_reversals    uuid[] := '{}';
  v_bfe_reversals   uuid[] := '{}';
  v_live_pay_ids    uuid[] := '{}';
  v_inv_movs        uuid[] := '{}';
  v_stock_json      jsonb := '[]'::jsonb;
  v_stock_count     integer := 0;
  v_reverted_cogs   numeric := 0;
  v_annulment_id    uuid;
  -- La fecha de la anulacion es un RESULTADO server-side: no se calcula en el
  -- DECLARE ni entra al hash. Solo se asigna cuando la key es NUEVA.
  v_date            date;
  v_in_audit        boolean := false;
  v_ec              text;
BEGIN
  -- ── 1. Autenticacion / validacion de entrada ──────────────────────────────
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado');
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('void_same_session', 'refund_current_session', 'commercial_annulment') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
      'error', 'Modo de anulación inválido: ' || COALESCE(p_mode, '(null)'));
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
      'error', 'El motivo de la anulación es obligatorio');
  END IF;
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'idempotency_key requerida');
  END IF;
  IF length(v_key) > c_key_max THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
      'error', 'La clave de idempotencia es demasiado larga');
  END IF;

  -- ── 2. Comprobante + ownership (business_id SIEMPRE del comprobante) ──────
  SELECT * INTO v_comp FROM comprobantes WHERE id = p_comprobante_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code','COMPROBANTE_NOT_FOUND', 'error', 'Comprobante no encontrado');
  END IF;
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = v_comp.business_id AND owner_user_id = v_actor)
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = v_comp.business_id AND user_id = v_actor AND COALESCE(is_active, true) = true)
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio');
  END IF;

  -- ── 3. Hash canonico: SOLO intencion del caller ───────────────────────────
  -- op + negocio + comprobante + modo + restore_stock + motivo normalizado.
  -- NO incluye ar_today()/fecha/actor/estado/saldos/IDs generados -> idempotencia
  -- DURABLE (un retry al dia siguiente con la misma intencion sigue siendo replay).
  v_request_hash := encode(extensions.digest(jsonb_build_object(
    'op','comprobante_annulment', 'business_id', v_comp.business_id, 'comprobante_id', p_comprobante_id,
    'mode', p_mode, 'restore_stock', COALESCE(p_restore_stock, false), 'reason', v_reason)::text, 'sha256'), 'hex');

  -- ── 4. Replay/conflicto ANTES de la fecha y del guard ─────────────────────
  SELECT * INTO v_prev FROM comprobante_annulments
    WHERE business_id = v_comp.business_id AND idempotency_key = v_key;
  IF FOUND THEN
    IF v_prev.request_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT',
        'error', 'La idempotency_key ya fue usada con parámetros distintos. Generá una key nueva.');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replay', true,
      'annulment_id', v_prev.id, 'mode', v_prev.mode,
      'reverted_cash_ars', v_prev.reverted_cash_ars, 'reverted_cc_ars', v_prev.reverted_cc_ars,
      'reverted_commissions_ars', v_prev.reverted_commissions_ars, 'reverted_cogs_ars', v_prev.reverted_cogs_ars,
      'stock_restored_count', v_prev.stock_restored_count, 'refund_caja_id', v_prev.refund_caja_id);
  END IF;

  -- ── 5. Fecha economica de la anulacion + guard SOLO de ese periodo ────────
  -- El periodo del comprobante original, sus pagos, su stock y su CC NUNCA se
  -- validan ni se reabren: anular hoy una venta de un mes cerrado es valido.
  v_date := public.ar_today();
  BEGIN PERFORM public.assert_period_open(v_comp.business_id, v_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF; END;

  -- ── 6. LOCK del comprobante: punto de serializacion de TODA la operacion ──
  SELECT * INTO v_comp FROM comprobantes WHERE id = p_comprobante_id FOR UPDATE;

  -- ── 7. Relectura de la request YA con el lock tomado ──────────────────────
  -- Una sesion concurrente con la MISMA key pudo completar mientras esperabamos:
  -- se releee ANTES de mirar el estado para devolver replay y no ALREADY_ANNULLED.
  SELECT * INTO v_prev FROM comprobante_annulments
    WHERE business_id = v_comp.business_id AND idempotency_key = v_key;
  IF FOUND THEN
    IF v_prev.request_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT',
        'error', 'La idempotency_key ya fue usada con parámetros distintos. Generá una key nueva.');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replay', true,
      'annulment_id', v_prev.id, 'mode', v_prev.mode,
      'reverted_cash_ars', v_prev.reverted_cash_ars, 'reverted_cc_ars', v_prev.reverted_cc_ars,
      'reverted_commissions_ars', v_prev.reverted_commissions_ars, 'reverted_cogs_ars', v_prev.reverted_cogs_ars,
      'stock_restored_count', v_prev.stock_restored_count, 'refund_caja_id', v_prev.refund_caja_id);
  END IF;

  -- ── 8. Estado (con el estado FRESCO del lock) ─────────────────────────────
  IF v_comp.estado = 'anulado' OR v_comp.status = 'cancelled' OR v_comp.estado_comercial = 'anulado'
     OR EXISTS (SELECT 1 FROM comprobante_annulments WHERE comprobante_id = v_comp.id AND status = 'completed') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','ALREADY_ANNULLED', 'error', 'El comprobante ya está anulado');
  END IF;
  IF COALESCE(v_comp.tipo, v_comp.type) = 'nota_credito' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
      'error', 'Una nota de crédito no se anula por este flujo');
  END IF;
  -- Fiscal: con CAE corresponde Nota de Credito. Politica PRESERVADA tal cual.
  IF v_comp.cae IS NOT NULL OR v_comp.numero_fiscal IS NOT NULL OR v_comp.estado_fiscal = 'emitido' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','REQUIRES_CREDIT_NOTE',
      'error', 'Este comprobante fue autorizado por ARCA. Generá una Nota de Crédito desde el detalle del comprobante.',
      'requiere_nota_credito', true);
  END IF;

  v_numero := COALESCE(v_comp.numero_fiscal, v_comp.number, v_comp.numero, left(v_comp.id::text, 8));

  -- ── 9. Locks deterministas de las filas que vamos a compensar ─────────────
  -- Pagos VIVOS por id (los reemplazados ya fueron compensados por 6F.3).
  PERFORM 1 FROM comprobante_payments
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id AND replaced_at IS NULL
    ORDER BY id FOR UPDATE;
  -- Movimientos de CC originales de esta venta, por id.
  PERFORM 1 FROM account_movements
    WHERE business_id = v_comp.business_id AND reference_type = 'comprobante' AND reference_id = v_comp.id
    ORDER BY id FOR UPDATE;
  -- Inventarios AGRUPADOS por inventory_id y bloqueados por id (nunca en el orden
  -- de los items): dos anulaciones concurrentes no pueden deadlockear.
  IF COALESCE(p_restore_stock, false) THEN
    PERFORM 1 FROM inventory
      WHERE business_id = v_comp.business_id
        AND id IN (SELECT DISTINCT ci.inventory_id FROM comprobante_items ci
                    WHERE ci.comprobante_id = v_comp.id AND ci.stock_processed = true
                      AND ci.inventory_id IS NOT NULL
                      AND COALESCE(ci.tipo_linea,'producto') IN ('producto','repuesto'))
      ORDER BY id FOR NO KEY UPDATE;
  END IF;

  -- ── 10. Medir lo REALMENTE registrado y VIGENTE (nunca total_bruto) ───────
  SELECT COALESCE(SUM(amount_ars), 0), COALESCE(SUM(commission_amount), 0), COALESCE(array_agg(id ORDER BY id), '{}')
    INTO v_cobrado, v_commissions, v_live_pay_ids
    FROM comprobante_payments
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id AND replaced_at IS NULL;

  SELECT COALESCE(SUM(debit - credit), 0) INTO v_cc_net
    FROM account_movements
    WHERE business_id = v_comp.business_id
      AND reference_type = 'comprobante' AND reference_id = v_comp.id;

  -- FM de ingreso VIGENTES: reversed_at IS NULL excluye los ingresos ya
  -- compensados por un reemplazo de cobro previo (6F.3). Sin este filtro la
  -- anulacion devolvia el eslabon viejo Y el nuevo -> caja negativa.
  SELECT COALESCE(SUM(amount_ars), 0),
         COALESCE(array_agg(id ORDER BY id), '{}'),
         COALESCE(array_agg(DISTINCT caja_id) FILTER (WHERE caja_id IS NOT NULL), '{}')
    INTO v_fm_income_total, v_original_fm_ids, v_original_cajas
    FROM financial_movements
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id
      AND type = 'income' AND COALESCE(sign, 1) = 1 AND reversed_at IS NULL;

  SELECT id INTO v_open_caja_id FROM cajas
    WHERE business_id = v_comp.business_id AND status = 'abierta'
    ORDER BY opened_at DESC LIMIT 1;

  -- ── 11. Validaciones por modo (politica comercial PRESERVADA) ─────────────
  IF p_mode = 'commercial_annulment' THEN
    IF v_cobrado > c_tolerance_ars THEN
      RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
        'error', format('Este comprobante tiene $%s cobrados. Si devolviste el dinero usá el modo devolución; si no, no corresponde anulación comercial.', round(v_cobrado, 2)));
    END IF;
  ELSE
    IF v_cobrado <= c_tolerance_ars AND v_fm_income_total <= c_tolerance_ars THEN
      RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
        'error', 'No hay cobros registrados para devolver — usá la anulación comercial (sin devolución de dinero).');
    END IF;
    IF v_open_caja_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
        'error', 'No hay caja abierta. Abrí una caja para registrar la devolución.');
    END IF;
    IF p_mode = 'void_same_session' THEN
      IF EXISTS (
        SELECT 1 FROM financial_movements
        WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id
          AND type = 'income' AND COALESCE(sign, 1) = 1 AND reversed_at IS NULL
          AND (caja_id IS DISTINCT FROM v_open_caja_id)
      ) THEN
        RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR',
          'error', 'La venta no pertenece a la caja abierta actual — usá el modo devolución (el egreso se registra en la caja de hoy sin tocar la sesión original).');
      END IF;
    END IF;
  END IF;

  -- ── 12. Audit scope E1: a partir de aca escribimos tablas con backstop ────
  PERFORM public.finance_begin_audit_scope();

  -- ── 13. Compensacion de caja: UN egreso espejo por CADA ingreso VIGENTE ───
  FOR v_fm IN
    SELECT * FROM financial_movements
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id
      AND type = 'income' AND COALESCE(sign, 1) = 1 AND reversed_at IS NULL
    ORDER BY id
  LOOP
    INSERT INTO financial_movements (
      business_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, source_id, comprobante_id, description, created_by, sign,
      metodo_pago, caja_id, reference_type, reference_id, movement_type
    ) VALUES (
      v_comp.business_id, v_date, 'expense',
      v_fm.currency, v_fm.amount, v_fm.amount_ars, COALESCE(v_fm.exchange_rate, 1),
      'comprobante', v_fm.source_id, v_comp.id,
      'ANULACIÓN Comprobante #' || v_numero || ' — reversa de mov. ' || v_fm.id || ' · ' || v_reason,
      v_actor, -1,
      v_fm.metodo_pago, v_open_caja_id, 'annulment_reversal', v_fm.id, 'refund'
    ) RETURNING id INTO v_new_fm_id;
    v_fm_reversals := v_fm_reversals || v_new_fm_id;
  END LOOP;

  -- ── 14. Espejos negativos de BFE (trazabilidad; el P&L NO los lee) ────────
  -- La reversion devengada de venta/COGS la DERIVA v_finance_sales_ledger desde
  -- comprobante_annulments. Estos espejos se conservan como trazabilidad y para
  -- la comision (payment_fee), que si es un gasto real del P&L y debe revertirse.
  FOR v_bfe IN
    SELECT * FROM business_finance_entries
    WHERE business_id = v_comp.business_id
      AND reference_comprobante_id = v_comp.id
      AND amount_ars > 0
      AND (type = 'income' OR (type = 'variable_cost' AND category IN ('comisiones_cobro', 'mercaderia')))
    ORDER BY created_at
  LOOP
    INSERT INTO business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      payment_method, reference_comprobante_id, source, created_by
    ) VALUES (
      v_comp.business_id, v_date, v_bfe.type, v_bfe.category,
      'ANULACIÓN Comprobante #' || v_numero || ' — reversa de asiento ' || v_bfe.id,
      -v_bfe.amount, v_bfe.currency, -v_bfe.amount_ars, COALESCE(v_bfe.exchange_rate, 1),
      v_bfe.payment_method, v_comp.id, 'annulment', v_actor
    ) RETURNING id INTO v_new_bfe_id;
    v_bfe_reversals := v_bfe_reversals || v_new_bfe_id;
    IF v_bfe.type = 'variable_cost' AND v_bfe.category = 'mercaderia' THEN
      v_reverted_cogs := v_reverted_cogs + v_bfe.amount_ars;
    END IF;
  END LOOP;

  -- COGS historico sin referencia (BFE de checkouts anteriores a 20260702110000).
  FOR v_bfe IN
    SELECT * FROM business_finance_entries
    WHERE business_id = v_comp.business_id
      AND reference_comprobante_id IS NULL
      AND type = 'variable_cost' AND category = 'mercaderia'
      AND amount_ars > 0
      AND description = 'Costo de productos - Comprobante #' || v_numero
    ORDER BY created_at
  LOOP
    INSERT INTO business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      reference_comprobante_id, source, created_by
    ) VALUES (
      v_comp.business_id, v_date, 'variable_cost', 'mercaderia',
      'ANULACIÓN Comprobante #' || v_numero || ' — reversa de asiento ' || v_bfe.id,
      -v_bfe.amount, v_bfe.currency, -v_bfe.amount_ars, COALESCE(v_bfe.exchange_rate, 1),
      v_comp.id, 'annulment', v_actor
    ) RETURNING id INTO v_new_bfe_id;
    v_bfe_reversals := v_bfe_reversals || v_new_bfe_id;
    v_reverted_cogs := v_reverted_cogs + v_bfe.amount_ars;
  END LOOP;

  -- ── 15. Cuenta corriente: movimiento contrario HOY (historico intacto) ────
  IF v_cc_net > 0.01 THEN
    SELECT account_id INTO v_account_id
      FROM account_movements
      WHERE business_id = v_comp.business_id
        AND reference_type = 'comprobante' AND reference_id = v_comp.id
      ORDER BY created_at LIMIT 1;
    IF v_account_id IS NOT NULL THEN
      INSERT INTO account_movements (
        business_id, account_id, date, type, description, debit, credit,
        reference_type, reference_id, created_by
      ) VALUES (
        v_comp.business_id, v_account_id, v_date, 'ajuste',
        'ANULACIÓN Comprobante #' || v_numero || ' · ' || v_reason,
        0, v_cc_net, 'comprobante', v_comp.id, v_actor
      ) RETURNING id INTO v_cc_mov_id;
    END IF;
  END IF;

  -- ── 16. Stock: append-only, agrupado por inventory_id, cantidades enteras ─
  IF COALESCE(p_restore_stock, false) THEN
    FOR v_item IN
      SELECT ci.inventory_id, SUM(ci.cantidad)::integer AS cantidad
      FROM comprobante_items ci
      WHERE ci.comprobante_id = v_comp.id
        AND ci.stock_processed = true
        AND ci.inventory_id IS NOT NULL
        AND COALESCE(ci.tipo_linea, 'producto') IN ('producto', 'repuesto')
      GROUP BY ci.inventory_id
      ORDER BY ci.inventory_id
    LOOP
      SELECT stock_quantity INTO v_prev_stock FROM inventory
        WHERE id = v_item.inventory_id AND business_id = v_comp.business_id;
      IF FOUND THEN
        v_prev_stock := COALESCE(v_prev_stock, 0);
        v_new_stock  := v_prev_stock + v_item.cantidad;
        UPDATE inventory SET stock_quantity = v_new_stock, updated_at = now()
          WHERE id = v_item.inventory_id AND business_id = v_comp.business_id;
        INSERT INTO inventory_movements (
          business_id, inventory_item_id, movement_type, quantity, previous_stock,
          new_stock, reference_type, reference_id, note, created_by
        ) VALUES (
          v_comp.business_id, v_item.inventory_id, 'return',
          v_item.cantidad, v_prev_stock, v_new_stock,
          'comprobante', v_comp.id,
          'Devolución por anulación de comprobante #' || v_numero, v_actor
        ) RETURNING id INTO v_mov_id;
        v_inv_movs   := v_inv_movs || v_mov_id;
        v_stock_json := v_stock_json || jsonb_build_object(
          'inventory_id', v_item.inventory_id, 'qty', v_item.cantidad,
          'prev_stock', v_prev_stock, 'new_stock', v_new_stock, 'movement_id', v_mov_id);
        v_stock_count := v_stock_count + 1;
      END IF;
    END LOOP;
    -- Marcador exactamente-una-vez sobre TODAS las lineas procesadas.
    UPDATE comprobante_items
      SET stock_processed = false, stock_processed_at = NULL, stock_movement_id = NULL
      WHERE comprobante_id = v_comp.id AND stock_processed = true;
  END IF;

  -- ── 17. Metadata OPERATIVA del comprobante ───────────────────────────────
  -- Solo estado + rastro de anulacion. Fecha, numero, punto de venta, tipo,
  -- moneda, totales, cliente, orden, condicion fiscal, CAE y su vencimiento
  -- NO se tocan: el comprobante sigue siendo el mismo documento.
  PERFORM set_config('m7.annulment_scope', '1', true);
  UPDATE comprobantes SET
    estado           = 'anulado',
    status           = 'cancelled',
    estado_comercial = 'anulado',
    estado_fiscal    = CASE WHEN estado_fiscal = 'no_fiscal' THEN 'no_fiscal' ELSE 'anulado_fiscal' END,
    afip_response    = COALESCE(afip_response, '{}'::jsonb) || jsonb_build_object(
                         'anulacion', jsonb_build_object(
                           'motivo', v_reason, 'modo', p_mode,
                           'restore_stock', COALESCE(p_restore_stock, false), 'fecha', v_date)),
    updated_at       = now()
  WHERE id = v_comp.id;

  -- ── 18. Registro canonico (idempotencia + fuente del evento devengado) ────
  INSERT INTO comprobante_annulments (
    business_id, comprobante_id, user_id, idempotency_key, request_hash, op,
    mode, motivo, restore_stock, stock_restored_count, annulment_date,
    original_caja_ids, refund_caja_id,
    reverted_cash_ars, reverted_cc_ars, reverted_commissions_ars, reverted_cogs_ars,
    original_fm_ids, fm_reversal_ids, bfe_reversal_ids, cc_reversal_movement_id
  ) VALUES (
    v_comp.business_id, v_comp.id, v_actor, v_key, v_request_hash, 'comprobante_annulment',
    p_mode, v_reason, COALESCE(p_restore_stock, false), v_stock_count, v_date,
    v_original_cajas, v_open_caja_id,
    GREATEST(v_cobrado, v_fm_income_total), v_cc_net, v_commissions, v_reverted_cogs,
    v_original_fm_ids, v_fm_reversals, v_bfe_reversals, v_cc_mov_id
  ) RETURNING id INTO v_annulment_id;

  -- ── 19. UN unico evento de auditoria ─────────────────────────────────────
  v_in_audit := true;
  PERFORM finance_log_audit(
    v_comp.business_id, 'comprobante_annulment', 'comprobantes', v_comp.id, 'annul_comprobante_atomic',
    v_key, v_reason, v_date, 'comprobante', v_comp.id,
    NULL, jsonb_build_object(
      'comprobante_id', v_comp.id, 'annulment_id', v_annulment_id, 'numero', v_numero,
      'reason', v_reason, 'mode', p_mode,
      'original_date', (COALESCE(v_comp.fecha, v_comp.date, v_comp.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date,
      'annulment_date', v_date,
      'original_period', to_char((COALESCE(v_comp.fecha, v_comp.date, v_comp.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date, 'YYYY-MM'),
      'annulment_period', to_char(v_date, 'YYYY-MM'),
      'customer_id', v_comp.customer_id, 'order_id', v_comp.order_id, 'sale_total', v_comp.total,
      'reverted_cash_ars', GREATEST(v_cobrado, v_fm_income_total), 'reverted_cc_ars', v_cc_net,
      'reverted_commissions_ars', v_commissions, 'reverted_cogs_ars', v_reverted_cogs,
      'live_payment_ids', to_jsonb(v_live_pay_ids),
      'original_fm_ids', to_jsonb(v_original_fm_ids), 'fm_reversal_ids', to_jsonb(v_fm_reversals),
      'bfe_reversal_ids', to_jsonb(v_bfe_reversals), 'cc_reversal_movement_id', v_cc_mov_id,
      'stock_restored', v_stock_json, 'inventory_movement_ids', to_jsonb(v_inv_movs),
      'original_caja_ids', to_jsonb(v_original_cajas), 'refund_caja_id', v_open_caja_id,
      'actor', v_actor, 'request_hash', v_request_hash));
  v_in_audit := false;

  RETURN jsonb_build_object(
    'ok', true, 'replay', false,
    'annulment_id', v_annulment_id, 'mode', p_mode,
    'reverted_cash_ars', GREATEST(v_cobrado, v_fm_income_total),
    'reverted_cc_ars', v_cc_net,
    'reverted_commissions_ars', v_commissions,
    'reverted_cogs_ars', v_reverted_cogs,
    'stock_restored_count', v_stock_count,
    'refund_caja_id', v_open_caja_id
  );

EXCEPTION WHEN OTHERS THEN
  -- Rollback TOTAL al savepoint implicito: nunca queda una anulacion a medias
  -- (ni compensacion parcial, ni request huerfana, ni auditoria parcial).
  v_ec := CASE
    WHEN v_in_audit THEN 'AUDIT_FAILED'
    WHEN SQLSTATE = '23505' THEN 'IDEMPOTENCY_CONFLICT'
    ELSE 'INTERNAL_ERROR' END;
  IF v_ec = 'IDEMPOTENCY_CONFLICT' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT',
      'error', 'La idempotency_key ya fue usada con parámetros distintos. Generá una key nueva.');
  END IF;
  RETURN jsonb_build_object('ok', false, 'error_code', v_ec,
    'error', CASE WHEN v_ec='AUDIT_FAILED' THEN 'No se pudo registrar la auditoria de la operacion'
                  ELSE 'No se pudo completar la operacion' END);
END;
$function$;

-- Ninguno de los seis writers invocables tiene EXECUTE para PUBLIC: su ACL ya
-- esta materializada y CREATE OR REPLACE la conserva. El REVOKE es un no-op sobre
-- el ACL (lo verifica la POSTCONDICION 1 contra el snapshot) y deja la constancia
-- estatica que exige guard:secdef-exposure (R2) para toda SECURITY DEFINER
-- redefinida. El trigger de repuestos queda fuera: no es invocable.
REVOKE ALL ON FUNCTION private.create_supplier_purchase_atomic(uuid, uuid, uuid, text, date, text, numeric, numeric, text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_supplier_purchase_safe(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repair_missing_stock_movements(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.create_comprobante_checkout_atomic(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.create_quick_inventory_purchase_atomic(uuid, text, uuid, text, text, date, text, numeric, numeric, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.sec08e_annul_comprobante_impl(uuid, text, text, boolean, text) FROM PUBLIC;

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
  -- POSTCONDICION 1 · los 7 writers conservan OID, SECURITY DEFINER, owner,
  -- search_path y ACL exactamente como antes del CREATE OR REPLACE.
  FOR s IN SELECT * FROM _g2c2_snapshot LOOP
    SELECT p.oid, p.prosecdef, p.proowner, p.proconfig, p.proacl, md5(replace(p.prosrc, E'\r', '')) AS src_md5
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

  -- POSTCONDICION 2 · G2-C.2R: en checkout, compra rapida y anulacion el UNICO
  -- cambio es el modo de lock de inventory. Volver 'FOR NO KEY UPDATE' a
  -- 'FOR UPDATE' reproduce el md5 de main; ningun lock de inventory queda
  -- FOR UPDATE; el pre-lock sigue ORDER BY id; los locks de otras tablas
  -- (comprobante, pagos, cuenta corriente de la anulacion) siguen FOR UPDATE.
  FOR s IN
    SELECT sn.*, e.no_key, e.for_update
      FROM _g2c2_snapshot sn
      JOIN (VALUES
        ('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',                                         2, 0),
        ('private.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb)', 2, 0),
        ('private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)',                                       1, 3)
      ) AS e(firma, no_key, for_update) ON e.firma = sn.firma
     WHERE sn.rol = 'modo'
  LOOP
    SELECT replace(prosrc, E'\r', '') INTO v_src FROM pg_proc WHERE oid = s.oid;
    IF md5(replace(v_src, 'FOR NO KEY UPDATE', 'FOR UPDATE')) IS DISTINCT FROM s.orig_md5 THEN
      RAISE EXCEPTION 'POSTCONDICION 2: % cambio algo mas que el modo de lock de inventory', s.firma;
    END IF;
    IF v_src ~* 'from\s+(public\.)?inventory\y[^;]*\yfor\s+update\y' THEN
      RAISE EXCEPTION 'POSTCONDICION 2: % conserva un lock FOR UPDATE sobre inventory', s.firma;
    END IF;
    IF v_src !~* 'from\s+(public\.)?inventory\y[^;]*order\s+by\s+id\s+for\s+no\s+key\s+update' THEN
      RAISE EXCEPTION 'POSTCONDICION 2: % perdio su pre-lock de inventory ORDER BY id FOR NO KEY UPDATE', s.firma;
    END IF;
    IF array_length(regexp_split_to_array(v_src, 'FOR NO KEY UPDATE'), 1) - 1 <> s.no_key
       OR array_length(regexp_split_to_array(v_src, 'FOR UPDATE'), 1) - 1 <> s.for_update THEN
      RAISE EXCEPTION 'POSTCONDICION 2: % no tiene los locks esperados (NO KEY UPDATE %, FOR UPDATE %)',
        s.firma, s.no_key, s.for_update;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM _g2c2_snapshot WHERE rol = 'writer') <> 4
     OR (SELECT count(*) FROM _g2c2_snapshot WHERE rol = 'modo') <> 3 THEN
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
  -- escriba stock en inventory bloquea antes con el contrato UNICO (helper o
  -- pre-lock ORDER BY id FOR NO KEY UPDATE) y ninguno de sus locks de inventory
  -- es FOR UPDATE (G2-C.2R: ese modo choca con el FOR KEY SHARE de las FK).
  -- Atrapa tambien writers futuros que olviden el lock o vuelvan a FOR UPDATE.
  FOR s IN
    SELECT p.oid::regprocedure::text AS firma, replace(p.prosrc, E'\r', '') AS prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
       AND p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*='
  LOOP
    IF position('private.lock_inventory_rows(' IN s.prosrc) = 0
       AND s.prosrc !~* 'order\s+by\s+(i\.)?id\s+for\s+no\s+key\s+update' THEN
      RAISE EXCEPTION 'POSTCONDICION 6: % escribe stock sin lock canonico previo', s.firma;
    END IF;
    IF s.prosrc ~* 'from\s+(public\.)?inventory\y[^;]*\yfor\s+update\y' THEN
      RAISE EXCEPTION 'POSTCONDICION 6: % bloquea inventory con FOR UPDATE (debe ser FOR NO KEY UPDATE)', s.firma;
    END IF;
  END LOOP;
  IF (SELECT prosrc FROM pg_proc WHERE oid = v_helper) !~* 'order\s+by\s+i\.id\s+for\s+no\s+key\s+update'
     OR (SELECT prosrc FROM pg_proc WHERE oid = v_helper) ~* '\yfor\s+update\y' THEN
    RAISE EXCEPTION 'POSTCONDICION 6: el helper dejo de bloquear ORDER BY id FOR NO KEY UPDATE';
  END IF;
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
    '· G2-C.2R: checkout/compra rapida/anulacion con inventory FOR NO KEY UPDATE (solo el modo cambia) '
    '· OID/owner/secdef/search_path/ACL preservados en los 7';
END
$post$;

COMMIT;
