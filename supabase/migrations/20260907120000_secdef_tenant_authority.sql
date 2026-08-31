-- LOTE 2 / PHASE A: candidate only; independent review before production.
-- No data migration, RLS changes, billing changes or general role-policy sweep.
-- Inventory and Suppliers share inventory (App.tsx). StockRepairTool additionally
-- requires owner/admin. Invitation preflight uses users + owner/admin.
-- p_user_id on purchase deletion is compatibility input; only auth.uid audits.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

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
 BEGIN

  -- LOTE 2: actor -> canonical active tenant -> existing action authority.
  PERFORM public._require_business_member(p_business_id, ARRAY['owner', 'admin']);
  IF p_business_id IS DISTINCT FROM public.current_user_business_id()
     OR NOT public.current_user_can('inventory') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

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


CREATE OR REPLACE FUNCTION public.preview_missing_stock_movements(p_business_id uuid)
 RETURNS TABLE(source text, sale_id uuid, item_id uuid, inventory_id uuid, product_name text, quantity numeric, current_stock integer, can_deduct boolean, sale_date timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN

  -- LOTE 2: actor -> canonical active tenant -> existing action authority.
  PERFORM public._require_business_member(p_business_id, ARRAY['owner', 'admin']);
  IF p_business_id IS DISTINCT FROM public.current_user_business_id()
     OR NOT public.current_user_can('inventory') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
   SELECT * FROM (
     SELECT
       'comprobante'::text,
       ci.comprobante_id,
       ci.id,
       ci.inventory_id,
       COALESCE(inv.name, '(sin nombre)'),
       ci.cantidad,
       COALESCE(inv.stock_quantity, 0),
       (COALESCE(inv.stock_quantity, 0) >= ci.cantidad::integer),
       c.created_at
     FROM public.comprobante_items ci
     JOIN public.comprobantes c   ON c.id  = ci.comprobante_id AND c.business_id = p_business_id
     JOIN public.inventory    inv ON inv.id = ci.inventory_id AND inv.business_id = p_business_id
     WHERE ci.business_id   = p_business_id
       AND ci.inventory_id  IS NOT NULL
       AND ci.cantidad        > 0
       AND (ci.stock_processed = false OR ci.stock_processed IS NULL)
       AND c.estado          NOT IN ('anulado')
       AND c.status          NOT IN ('cancelled')
       AND c.estado_comercial NOT IN ('anulado')
       AND c.estado_comercial IS DISTINCT FROM NULL

     UNION ALL

     SELECT
       'wholesale_order'::text,
       woi.order_id,
       woi.id,
       woi.inventory_item_id,
       COALESCE(inv.name, '(sin nombre)'),
       woi.quantity::numeric,
       COALESCE(inv.stock_quantity, 0),
       (COALESCE(inv.stock_quantity, 0) >= woi.quantity),
       wo.created_at
     FROM public.wholesale_order_items woi
     JOIN public.wholesale_orders wo  ON wo.id  = woi.order_id AND wo.business_id = p_business_id
     JOIN public.inventory        inv ON inv.id = woi.inventory_item_id AND inv.business_id = p_business_id
     WHERE woi.business_id      = p_business_id
       AND woi.inventory_item_id IS NOT NULL
       AND woi.quantity           > 0
       AND (woi.stock_processed = false OR woi.stock_processed IS NULL)
       AND wo.status NOT IN ('cancelled', 'rejected')
   ) sub
   ORDER BY sub.created_at;
END;
 $function$;


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

  FOR v_item IN
    SELECT * FROM public.supplier_purchase_items
     WHERE purchase_id = p_purchase_id AND business_id = p_business_id
  LOOP
    IF v_item.inventory_id IS NOT NULL THEN
      SELECT stock_quantity INTO v_prev_stk FROM public.inventory
       WHERE id = v_item.inventory_id AND business_id = p_business_id;
      IF FOUND THEN
        v_new_stk := GREATEST(0, COALESCE(v_prev_stk, 0) - FLOOR(v_item.quantity)::integer);
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


CREATE OR REPLACE FUNCTION public.backfill_remito_fm(p_remito_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_rec       RECORD;
  v_created   INTEGER := 0;
  v_skipped   INTEGER := 0;
  v_errors    TEXT[]  := '{}';
BEGIN
  FOR v_rec IN
    SELECT
      c.id                                              AS comp_id,
      c.business_id,
      COALESCE(c.numero, c.id::TEXT)                   AS numero,
      cp.id                                             AS payment_id,
      cp.amount_ars,
      cp.payment_method,
      cp.date                                           AS payment_date,
      cp.created_by
    FROM public.comprobantes c
    JOIN public.comprobante_payments cp ON cp.comprobante_id = c.id
    WHERE c.id = ANY(p_remito_ids)
      AND c.tipo = 'remito'
      -- Guard idempotente: solo si NO hay FM para este comprobante
      AND NOT EXISTS (
        SELECT 1 FROM public.financial_movements fm
        WHERE fm.comprobante_id = c.id
      )
  LOOP
    -- Validar que el business_id del remito existe
    IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = v_rec.business_id) THEN
      v_errors := v_errors || ('negocio no encontrado para ' || v_rec.comp_id::TEXT);
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.financial_movements (
      business_id,
      date,
      type,
      currency,
      amount,
      exchange_rate,
      amount_ars,
      source,
      comprobante_id,
      description,
      created_by,
      sign,
      metodo_pago
    ) VALUES (
      v_rec.business_id,
      v_rec.payment_date,
      'income',
      'ARS',
      v_rec.amount_ars,
      1,
      v_rec.amount_ars,
      'comprobante',
      v_rec.comp_id,
      'Cobro remito #' || v_rec.numero,
      v_rec.created_by,
      1,
      CASE v_rec.payment_method
        WHEN 'transferencia'  THEN 'transferencia'
        WHEN 'tarjeta_debito' THEN 'tarjeta'
        WHEN 'tarjeta_credito'THEN 'tarjeta'
        WHEN 'qr'             THEN 'tarjeta'
        WHEN 'efectivo'       THEN 'efectivo'
        ELSE                       'efectivo'
      END
    );

    v_created := v_created + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'created', v_created,
    'skipped', v_skipped,
    'errors',  v_errors
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;


CREATE OR REPLACE FUNCTION public.check_user_limit_before_invite(p_business_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $function$
 DECLARE
   v_active_count int;
   v_max_users    int;
   v_plan         text;
   v_status       text;
 BEGIN

  -- LOTE 2: actor -> canonical active tenant -> existing action authority.
  PERFORM public._require_business_member(p_business_id, ARRAY['owner', 'admin']);
  IF p_business_id IS DISTINCT FROM public.current_user_business_id()
     OR NOT public.current_user_can('users') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
   SELECT subscription_plan, subscription_status
   INTO   v_plan, v_status
   FROM   public.businesses WHERE id = p_business_id;

   v_max_users := CASE
     WHEN v_status = 'trialing'     THEN 3
     WHEN v_plan   = 'full'         THEN 10
     WHEN v_plan   = 'pro'          THEN 3
     ELSE 1
   END;

   SELECT COUNT(*) INTO v_active_count
   FROM   public.profiles
   WHERE  business_id = p_business_id AND is_active = true;

   IF v_active_count >= v_max_users THEN
     RETURN 'LIMIT_REACHED:' || v_active_count || ':' || v_max_users || ':' || COALESCE(v_plan,'basico');
   END IF;

   RETURN 'OK';
 END;
 $function$;


CREATE OR REPLACE FUNCTION public.pay_comprobante_from_account_atomic(p_business_id uuid, p_account_id uuid, p_comprobante_id uuid, p_amount numeric, p_description text, p_payment_method text, p_date date, p_caja_id uuid, p_user_id uuid, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_key   text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_pay   jsonb;
  v_alloc jsonb;
  v_mov   uuid;
  v_saldo numeric;
  v_imp   numeric;
BEGIN

  -- LOTE 2: actor -> canonical active tenant -> existing action authority.
  PERFORM public._require_business_member(p_business_id);
  IF p_business_id IS DISTINCT FROM public.current_user_business_id()
     OR NOT public.current_user_can('finance') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'error', 'idempotency_key requerida');
  END IF;

  -- Saldo imputable del documento: el excedente NO se imputa, queda como crédito.
  SELECT GREATEST(COALESCE(c.saldo_pendiente, 0)
         - COALESCE((SELECT SUM(al.amount) FROM public.customer_account_payment_allocations al
                      WHERE al.comprobante_id = c.id AND al.status = 'active'), 0), 0)
    INTO v_saldo
    FROM public.comprobantes c
   WHERE c.id = p_comprobante_id AND c.business_id = p_business_id;
  IF v_saldo IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'COMPROBANTE_NOT_FOUND', 'error', 'Comprobante no encontrado');
  END IF;

  v_pay := public.record_customer_account_payment_atomic(
    p_business_id, p_account_id, p_amount, p_description, p_user_id,
    p_payment_method, p_date, p_caja_id, v_key);
  IF COALESCE((v_pay->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN v_pay;
  END IF;
  v_mov := (v_pay->>'account_movement_id')::uuid;

  v_imp := LEAST(ROUND(p_amount, 2), v_saldo);
  IF v_imp > 0 THEN
    v_alloc := public.allocate_account_payment_atomic(
      p_business_id, v_mov,
      jsonb_build_array(jsonb_build_object('comprobante_id', p_comprobante_id, 'amount', v_imp)),
      'Cobro imputado desde el comprobante', v_key || ':auto');
    IF COALESCE((v_alloc->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'ALLOCATION_FAILED: %', COALESCE(v_alloc->>'error', 'sin detalle');
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true,
    'account_movement_id', v_mov,
    'allocated_amount', v_imp,
    'unallocated_amount', ROUND(p_amount, 2) - v_imp,
    'payment', v_pay, 'allocation', v_alloc);
END;
$function$;


-- Explicit ACLs: no dependency on the default PUBLIC EXECUTE.
REVOKE EXECUTE ON FUNCTION public.repair_missing_stock_movements(uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.repair_missing_stock_movements(uuid,boolean) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.preview_missing_stock_movements(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_missing_stock_movements(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.delete_supplier_purchase_safe(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_supplier_purchase_safe(uuid,uuid,uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.backfill_remito_fm(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
-- postgres (existing owner) only; no newly invented service caller.

REVOKE EXECUTE ON FUNCTION public.check_user_limit_before_invite(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_user_limit_before_invite(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.pay_comprobante_from_account_atomic(uuid,uuid,uuid,numeric,text,text,date,uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_comprobante_from_account_atomic(uuid,uuid,uuid,numeric,text,text,date,uuid,uuid,text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.user_can_allocate_payments(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_allocate_payments(uuid,uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.user_can_reverse_allocations(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_reverse_allocations(uuid,uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.user_can_view_order_amounts(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_view_order_amounts(uuid,uuid) TO service_role;

COMMIT;
