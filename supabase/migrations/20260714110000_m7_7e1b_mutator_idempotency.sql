-- ============================================================================
-- M7 7E.1b — Idempotencia de los mutadores restantes.
--
-- Antes de escribir una línea se midió el comportamiento REAL con dos sesiones
-- concurrentes (scripts/finance/concurrency-harness.mjs). El resultado corrigió
-- varias suposiciones, incluida una mía en el informe 7E.1:
--
--   create_credit_note_finance_reversal
--     · replay secuencial: YA era seguro (SELECT de control + IF NULL).
--     · concurrencia: YA era segura, pero por un motivo indirecto — la sesión B
--       se BLOQUEA en `uniq_bfe_comprobante_reversal` y termina con
--       unique_violation, que hace rollback de todo el cuerpo (incluido su FM).
--     · defecto real: le devolvía al cliente el texto crudo de Postgres
--       ("duplicate key value violates unique constraint ..."). El llamador no
--       podía distinguir "ya estaba hecho" de "falló".
--
--   delete_supplier_purchase_safe
--     · concurrencia: YA era segura. El `FOR UPDATE` serializa y la segunda
--       sesión encuentra la fila borrada.
--     · defecto real: al borrarse la compra desaparece la identidad. Un retry
--       tras perder la respuesta recibe "Compra no encontrada" —un error— para
--       algo que en realidad salió bien.
--
--   pay_recurring_expense / pay_card_statement_atomic
--     · ambas protegidas por UNIQUE real (no por el IF EXISTS previo, que sí
--       tiene ventana de carrera).
--     · pay_card_statement_atomic ya mapea unique_violation -> already_paid:
--       queda como está, es el contrato correcto.
--     · pay_recurring_expense filtraba el texto crudo de la constraint.
--
--   seed_expense_categories
--     · ROTA: sin UNIQUE(business_id,name), dos llamadas concurrentes dejaron
--       14 categorías en vez de 7. Medido, no supuesto.
--
-- Criterio de este lote: NO se agregan request tables donde la identidad
-- natural ya es única y está respaldada por una constraint. Una key de
-- idempotencia que duplica lo que ya garantiza un índice es ceremonia, y el
-- pliego pide explícitamente no agregar keys decorativas. Donde faltaba la
-- constraint, se agrega; donde faltaba el contrato de error, se arregla.
-- ============================================================================

-- ══ 1. seed_expense_categories — la única duplicación REAL medida ═══════════

-- Deduplicar antes de poder crear el índice (deja la fila más antigua).
DELETE FROM public.expense_categories a
 USING public.expense_categories b
 WHERE a.business_id = b.business_id
   AND lower(btrim(a.name)) = lower(btrim(b.name))
   AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_expense_categories_business_name
  ON public.expense_categories (business_id, lower(btrim(name)));

COMMENT ON INDEX public.uniq_expense_categories_business_name IS
  'M7 7E.1b: sin esto, dos seeds concurrentes dejaban 7 categorias duplicadas (medido: 14).';

-- El `IF EXISTS ... RETURN` se conserva como atajo barato, pero ya no es LA
-- garantía: ahora la garantía es el índice. ON CONFLICT DO NOTHING hace que la
-- segunda llamada concurrente sea un no-op en vez de un error.
CREATE OR REPLACE FUNCTION public.seed_expense_categories(p_business_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.expense_categories WHERE business_id = p_business_id) THEN RETURN; END IF;
  INSERT INTO public.expense_categories(business_id, name, color, sort_order) VALUES
    (p_business_id, 'Inventario / Mercadería', '#6366f1', 1),
    (p_business_id, 'Operativos',              '#10b981', 2),
    (p_business_id, 'Equipamiento',            '#f59e0b', 3),
    (p_business_id, 'Marketing',               '#ec4899', 4),
    (p_business_id, 'Sueldos',                 '#06b6d4', 5),
    (p_business_id, 'Impuestos',               '#8b5cf6', 6),
    (p_business_id, 'Otros',                   '#64748b', 7)
  ON CONFLICT DO NOTHING;   -- la carrera termina en no-op, no en duplicado
END; $$;

-- ══ 2. create_credit_note_finance_reversal — contrato de error tipado ═══════

-- ┌── POR QUE **NO** HAY INDICE UNICO EN financial_movements ────────────────┐
-- │ El primer intento de este lote agregó uno "por las dudas":               │
-- │                                                                          │
-- │   UNIQUE (comprobante_id) WHERE sign = -1 AND source = 'comprobante'     │
-- │                                                                          │
-- │ ROMPE LA ANULACION. `annul_comprobante_atomic` inserta un movimiento     │
-- │ compensatorio POR CADA movimiento original, dentro de un loop: un cobro  │
-- │ mixto (efectivo + tarjeta) genera DOS filas `sign=-1, source=            │
-- │ 'comprobante'` para el MISMO comprobante, y son las dos correctas. El    │
-- │ índice las tomaba por duplicados. Lo cazó la suite de anulación (PA6).   │
-- │                                                                          │
-- │ Y no hace falta: el harness de concurrencia demuestra que el índice del  │
-- │ lado BFE ya alcanza. La sesión perdedora se bloquea ahí y el             │
-- │ unique_violation revierte TODO el cuerpo de la función, incluido su      │
-- │ INSERT de FM. La protección existe; agregar una segunda habría costado   │
-- │ una regla contable legítima.                                             │
-- │                                                                          │
-- │ Si alguien vuelve a intentarlo, el discriminante no puede ser            │
-- │ (comprobante_id, sign, source): esos tres no distinguen "reversa de NC"  │
-- │ de "compensación de anulación".                                          │
-- └──────────────────────────────────────────────────────────────────────────┘
DROP INDEX IF EXISTS public.uniq_fm_comprobante_reversal;

CREATE OR REPLACE FUNCTION public.create_credit_note_finance_reversal(p_nc_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_nc           public.comprobantes%ROWTYPE;
  v_business_id  uuid;
  v_has_access   boolean := false;
  v_total        numeric;
  v_numero       text;
  v_orig_numero  text;
  v_today        date := public.ar_today();
  v_existing_fm  uuid;
  v_existing_bfe uuid;
  v_created_fm   boolean := false;
  v_created_bfe  boolean := false;
BEGIN
  SELECT * INTO v_nc FROM public.comprobantes WHERE id = p_nc_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'NOT_FOUND', 'error', 'NC no encontrada');
  END IF;
  v_business_id := v_nc.business_id;

  -- Pertenencia ANTES de cualquier atajo de replay: quien ya no pertenece al
  -- negocio no puede ni siquiera confirmar que la reversa existe.
  SELECT (
    EXISTS (SELECT 1 FROM public.businesses WHERE id = v_business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.profiles WHERE business_id = v_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'FORBIDDEN', 'error', 'Sin acceso al negocio');
  END IF;

  IF v_nc.estado_fiscal IS DISTINCT FROM 'emitido' THEN
    RETURN jsonb_build_object('success', false, 'ok', false, 'error_code', 'VALIDATION_ERROR',
      'error', 'La NC debe estar emitida antes de crear la reversa financiera');
  END IF;
  IF v_nc.comprobante_original_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'ok', false, 'error_code', 'VALIDATION_ERROR',
      'error', 'La NC no tiene comprobante original asociado');
  END IF;

  v_total  := COALESCE(v_nc.total_bruto, v_nc.total_ars, v_nc.total, 0);
  v_numero := COALESCE(v_nc.numero_fiscal, v_nc.numero, p_nc_id::text);
  SELECT COALESCE(numero_fiscal, numero, id::text) INTO v_orig_numero
    FROM public.comprobantes WHERE id = v_nc.comprobante_original_id;

  SELECT id INTO v_existing_fm FROM public.financial_movements
   WHERE comprobante_id = p_nc_id AND business_id = v_business_id AND sign = -1 LIMIT 1;

  IF v_existing_fm IS NULL THEN
    INSERT INTO public.financial_movements (
      business_id, date, type, currency, amount, exchange_rate, amount_ars,
      source, comprobante_id, description, created_by, sign, metodo_pago
    ) VALUES (
      v_business_id, v_today, 'expense',
      COALESCE(v_nc.currency, 'ARS'), v_total, COALESCE(v_nc.exchange_rate, 1), v_total,
      'comprobante', p_nc_id,
      'NOTA DE CRÉDITO #' || v_numero || ' — anula ' || COALESCE(v_orig_numero, ''),
      auth.uid(), -1, NULL
    );
    v_created_fm := true;
  END IF;

  SELECT id INTO v_existing_bfe FROM public.business_finance_entries
   WHERE reference_comprobante_id = p_nc_id AND business_id = v_business_id AND amount < 0 LIMIT 1;

  IF v_existing_bfe IS NULL THEN
    INSERT INTO public.business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      reference_comprobante_id, source, created_by
    ) VALUES (
      v_business_id, v_today, 'income', 'ventas_productos',
      'NOTA DE CRÉDITO #' || v_numero || ' — anula ' || COALESCE(v_orig_numero, ''),
      -v_total, COALESCE(v_nc.currency, 'ARS'), -v_total, COALESCE(v_nc.exchange_rate, 1),
      p_nc_id, 'comprobante', auth.uid()
    );
    v_created_bfe := true;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'ok', true,
    'replay', NOT (v_created_fm OR v_created_bfe),
    'fm_created', v_created_fm, 'bfe_created', v_created_bfe);

EXCEPTION
  -- Otra sesión ganó la carrera y ya dejó la reversa. El estado final deseado
  -- SE CUMPLE, así que esto es un replay, no un fallo: devolver un error acá
  -- llevaría al llamador a reintentar algo que ya está hecho. Antes se filtraba
  -- el texto crudo de la constraint hasta la UI.
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', true, 'ok', true, 'replay', true,
      'fm_created', false, 'bfe_created', false);
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'ok', false,
      'error_code', 'INTERNAL_ERROR',
      'error', 'No se pudo registrar la reversa financiera de la nota de crédito');
END; $$;

-- ══ 3. pay_recurring_expense — no filtrar el texto de la constraint ═════════
-- El cuerpo no cambia; sólo el manejo de errores del final.
-- El DEFAULT de p_notes se preserva: quitarlo cambiaría la firma y rompería a
-- los llamadores que omiten el argumento (Postgres además lo rechaza).
CREATE OR REPLACE FUNCTION public.pay_recurring_expense(
  p_expense_id uuid, p_account_id uuid, p_amount numeric, p_paid_date date,
  p_notes text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_expense    public.personal_recurring_expenses%rowtype;
  v_account    public.personal_accounts%rowtype;
  v_tx_id      uuid;
  v_payment_id uuid;
  v_period_y   int  := extract(year  from p_paid_date)::int;
  v_period_m   int  := extract(month from p_paid_date)::int;
  v_next_due   date;
  v_cat_id     uuid;
BEGIN
  SELECT * INTO v_expense FROM public.personal_recurring_expenses
   WHERE id = p_expense_id AND user_id = v_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND', 'error', 'Gasto fijo no encontrado');
  END IF;
  IF v_expense.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'error', 'El gasto fijo está cancelado');
  END IF;
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'error', 'El monto debe ser mayor a $0');
  END IF;

  SELECT * INTO v_account FROM public.personal_accounts
   WHERE id = p_account_id AND user_id = v_user_id AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND', 'error', 'Cuenta no encontrada');
  END IF;

  -- Atajo barato. La garantía de verdad es la UNIQUE de más abajo: entre este
  -- chequeo y el INSERT hay una ventana en la que otra sesión puede insertar.
  IF EXISTS (
    SELECT 1 FROM public.personal_recurring_expense_payments
     WHERE recurring_expense_id = p_expense_id
       AND period_year = v_period_y AND period_month = v_period_m
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'ALREADY_PAID',
      'error', 'Ya se registró un pago para este mes');
  END IF;

  v_cat_id := v_expense.category_id;
  IF v_cat_id IS NULL THEN
    SELECT id INTO v_cat_id FROM public.personal_categories
     WHERE user_id = v_user_id AND type = 'expense'
       AND (lower(name) LIKE '%servicio%' OR lower(name) LIKE '%fijo%'
            OR lower(name) LIKE '%gasto%' OR lower(name) LIKE '%hogar%')
     LIMIT 1;
  END IF;

  INSERT INTO public.personal_transactions (
    user_id, account_id, category_id, type, amount, currency,
    date, description, notes, payment_method, linked_owner_withdrawal_id
  ) VALUES (
    v_user_id, p_account_id, v_cat_id, 'expense', p_amount, v_expense.currency,
    p_paid_date, 'Gasto fijo: ' || v_expense.name, p_notes, NULL, NULL
  ) RETURNING id INTO v_tx_id;

  PERFORM public.personal_update_currency_balance(p_account_id, v_expense.currency, -p_amount);

  INSERT INTO public.personal_recurring_expense_payments (
    user_id, recurring_expense_id, account_id, transaction_id,
    currency, amount, paid_date, period_year, period_month, notes
  ) VALUES (
    v_user_id, p_expense_id, p_account_id, v_tx_id,
    v_expense.currency, p_amount, p_paid_date, v_period_y, v_period_m, p_notes
  ) RETURNING id INTO v_payment_id;

  IF v_expense.due_day IS NOT NULL THEN
    v_next_due := (date_trunc('month', p_paid_date + interval '1 month')
                   + (v_expense.due_day - 1) * interval '1 day')::date;
    v_next_due := least(v_next_due,
      (date_trunc('month', p_paid_date + interval '1 month') + interval '1 month - 1 day')::date);
    UPDATE public.personal_recurring_expenses SET next_due_date = v_next_due WHERE id = p_expense_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'payment_id', v_payment_id,
    'transaction_id', v_tx_id, 'next_due_date', v_next_due);

EXCEPTION
  -- Perdió la carrera contra otra sesión del mismo período. Todo el cuerpo se
  -- revierte (transacción y débito incluidos), así que el efecto económico
  -- ocurre UNA sola vez. Antes esto devolvía el texto crudo de la constraint.
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'ALREADY_PAID',
      'error', 'Ya se registró un pago para este mes');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL_ERROR',
      'error', 'No se pudo registrar el pago del gasto fijo');
END; $$;

-- ══ 4. delete_supplier_purchase_safe — tombstone para el retry ══════════════
--
-- El FOR UPDATE ya impide la doble ejecución (medido). Lo que falta es poder
-- CONTESTAR bien a un retry: al borrarse la compra desaparece la identidad y el
-- segundo intento recibía "Compra no encontrada", que se lee como fallo cuando
-- en realidad la operación salió bien. El tombstone conserva ese resultado.
CREATE TABLE IF NOT EXISTS public.supplier_purchase_deletions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  purchase_id   uuid NOT NULL,
  supplier_id   uuid,
  user_id       uuid,
  deleted_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uniq_supplier_purchase_deletion UNIQUE (business_id, purchase_id)
);

COMMENT ON TABLE public.supplier_purchase_deletions IS
  'M7 7E.1b: tombstone append-only. La compra borrada deja de existir como '
  'identidad; sin esto, un retry tras perder la respuesta no puede distinguir '
  '"ya se borro" de "nunca existio".';

ALTER TABLE public.supplier_purchase_deletions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS supplier_purchase_deletions_select ON public.supplier_purchase_deletions;
CREATE POLICY supplier_purchase_deletions_select ON public.supplier_purchase_deletions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.business_id = supplier_purchase_deletions.business_id
                    AND p.user_id = auth.uid()));

-- Fail-closed: sólo la RPC (SECURITY DEFINER, owner postgres) escribe acá.
REVOKE ALL ON public.supplier_purchase_deletions FROM PUBLIC;
GRANT SELECT ON public.supplier_purchase_deletions TO authenticated;

-- Append-only, como el resto del ledger M7.
CREATE OR REPLACE FUNCTION public.supplier_purchase_deletions_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% es append-only: % no permitido', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000';
END; $$;

DROP TRIGGER IF EXISTS trg_supplier_purchase_deletions_immutable ON public.supplier_purchase_deletions;
CREATE TRIGGER trg_supplier_purchase_deletions_immutable
  BEFORE UPDATE OR DELETE ON public.supplier_purchase_deletions
  FOR EACH ROW EXECUTE FUNCTION public.supplier_purchase_deletions_immutable();

CREATE OR REPLACE FUNCTION public.delete_supplier_purchase_safe(
  p_business_id uuid, p_purchase_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_purchase public.supplier_purchases%ROWTYPE;
  v_item     record;
  v_prev_stk integer;
  v_new_stk  integer;
BEGIN
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
          'Reversión por eliminación de compra', p_business_id, p_user_id);
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
       VALUES (p_business_id, p_purchase_id, v_purchase.supplier_id, p_user_id)
  ON CONFLICT (business_id, purchase_id) DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'replay', false);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL_ERROR',
    'error', 'No se pudo eliminar la compra');
END; $$;

-- ── ACL: se preservan los grants originales de cada función ──────────────────
REVOKE ALL ON FUNCTION public.create_credit_note_finance_reversal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_credit_note_finance_reversal(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.pay_recurring_expense(uuid, uuid, numeric, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_recurring_expense(uuid, uuid, numeric, date, text) TO authenticated;

REVOKE ALL ON FUNCTION public.delete_supplier_purchase_safe(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_supplier_purchase_safe(uuid, uuid, uuid) TO authenticated;

-- ── Verificación en la propia migración ─────────────────────────────────────
DO $$
BEGIN
  -- 7E.1 no puede retroceder por culpa de este lote.
  IF has_schema_privilege('authenticated', 'public', 'CREATE') THEN
    RAISE EXCEPTION '7E.1b: se reintrodujo CREATE sobre public';
  END IF;
  -- Las tres funciones reescritas quedan con un search_path seguro.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('create_credit_note_finance_reversal','pay_recurring_expense',
                         'delete_supplier_purchase_safe','supplier_purchase_deletions_immutable')
       AND NOT ('search_path=pg_catalog, pg_temp' = ANY(COALESCE(p.proconfig, '{}'::text[])))
  ) THEN
    RAISE EXCEPTION '7E.1b: alguna funcion quedo sin search_path=pg_catalog, pg_temp';
  END IF;
  RAISE NOTICE '7E.1b OK: constraints, contratos tipados y tombstone aplicados';
END $$;
