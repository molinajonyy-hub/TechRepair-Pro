-- ================================================================
-- MIGRACIÓN INTEGRAL DE INTEGRACIÓN FINANCIERA — v2 (ajustada)
-- TechRepair Pro
-- Ejecutar una sola vez en Supabase SQL Editor
-- Basada en inspección real de la DB: solo agrega lo que falta
-- ================================================================

-- ================================================================
-- 1. business_finance_entries — agregar columnas faltantes
-- ================================================================
ALTER TABLE public.business_finance_entries
  ADD COLUMN IF NOT EXISTS reference_comprobante_id UUID,
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';

-- ================================================================
-- 2. comprobantes — agregar columnas en inglés que usa el servicio TS
-- ================================================================
ALTER TABLE public.comprobantes
  ADD COLUMN IF NOT EXISTS type   TEXT,
  ADD COLUMN IF NOT EXISTS number TEXT,
  ADD COLUMN IF NOT EXISTS date   TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS tax    NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';

-- Copiar datos existentes de columnas en español → columnas en inglés
UPDATE public.comprobantes
SET
  type   = COALESCE(type,   tipo),
  number = COALESCE(number, numero),
  date   = COALESCE(date,   fecha),
  tax    = CASE WHEN tax = 0 THEN COALESCE(impuestos, 0) ELSE tax END,
  status = CASE
    WHEN status = 'draft' THEN
      CASE estado
        WHEN 'borrador' THEN 'draft'
        WHEN 'emitido'  THEN 'issued'
        WHEN 'anulado'  THEN 'cancelled'
        ELSE COALESCE(estado, 'draft')
      END
    ELSE status
  END
WHERE tipo IS NOT NULL OR numero IS NOT NULL;

-- Índices útiles
CREATE INDEX IF NOT EXISTS comp_business_date_idx
  ON public.comprobantes(business_id, date DESC);
CREATE INDEX IF NOT EXISTS comp_status_idx
  ON public.comprobantes(business_id, status);

-- ================================================================
-- 3. expenses — agregar columnas faltantes
-- ================================================================
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS payment_method  TEXT DEFAULT 'efectivo',
  ADD COLUMN IF NOT EXISTS amount_ars      NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exchange_rate   NUMERIC(12,4) DEFAULT 1,
  ADD COLUMN IF NOT EXISTS finance_entry_id UUID;

-- Normalizar amount_ars con amount donde esté vacío
UPDATE public.expenses
SET amount_ars = amount
WHERE amount_ars = 0 AND amount > 0;

CREATE INDEX IF NOT EXISTS exp_business_date_idx
  ON public.expenses(business_id, date DESC);

-- ================================================================
-- 4. financial_movements — agregar reference_id para compatibilidad
--    (la función register_order_payment lo usa pero el campo era source_id)
-- ================================================================
ALTER TABLE public.financial_movements
  ADD COLUMN IF NOT EXISTS reference_id   UUID,
  ADD COLUMN IF NOT EXISTS reference_type TEXT;

-- Copiar source_id → reference_id para datos existentes
UPDATE public.financial_movements
SET reference_id = source_id
WHERE reference_id IS NULL AND source_id IS NOT NULL;

-- ================================================================
-- 5. generar_numero_comprobante — corregir firma para el servicio TS
--    El servicio llama con: { p_tipo, p_business_id }
--    La función existente es: (p_business_id, p_tipo, p_punto_venta)
--    → Agregar DEFAULT a p_punto_venta y versión con parámetros en orden correcto
-- ================================================================

-- Versión que acepta p_tipo primero, p_business_id segundo (como llama el TS)
CREATE OR REPLACE FUNCTION public.generar_numero_comprobante(
  p_tipo        TEXT,
  p_business_id UUID DEFAULT NULL,
  p_punto_venta TEXT DEFAULT '0001'
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ultimo_numero BIGINT;
  nuevo_numero  TEXT;
  v_biz_id      UUID;
BEGIN
  v_biz_id := COALESCE(p_business_id, public.current_user_business_id());

  SELECT COALESCE(
    MAX(
      CASE
        WHEN COALESCE(number, numero) ~ '^[0-9]+$'
          THEN CAST(COALESCE(number, numero) AS BIGINT)
        WHEN COALESCE(number, numero) ~ '^[0-9]{4}-[0-9]{8}$'
          THEN CAST(SPLIT_PART(COALESCE(number, numero), '-', 2) AS BIGINT)
        ELSE 0
      END
    ), 0)
  INTO ultimo_numero
  FROM public.comprobantes
  WHERE business_id = v_biz_id
    AND COALESCE(type, tipo) = p_tipo;

  ultimo_numero := ultimo_numero + 1;

  IF p_punto_venta IS NULL OR TRIM(p_punto_venta) = '' THEN
    nuevo_numero := LPAD(ultimo_numero::TEXT, 8, '0');
  ELSE
    nuevo_numero := LPAD(p_punto_venta, 4, '0') || '-' || LPAD(ultimo_numero::TEXT, 8, '0');
  END IF;

  RETURN nuevo_numero;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generar_numero_comprobante(TEXT, UUID, TEXT) TO authenticated;

-- ================================================================
-- 6. TRIGGER: order_payment INSERT → financial_movements + bfe
-- ================================================================

CREATE OR REPLACE FUNCTION public.trigger_payment_creates_movements()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id UUID;
  v_date        DATE;
BEGIN
  -- Obtener business_id desde la orden si no viene en el pago
  IF NEW.business_id IS NULL THEN
    SELECT o.business_id INTO v_business_id
    FROM public.orders o WHERE o.id = NEW.order_id;
    NEW.business_id := v_business_id;
  ELSE
    v_business_id := NEW.business_id;
  END IF;

  IF v_business_id IS NULL THEN RETURN NEW; END IF;

  v_date := COALESCE(
    CASE WHEN NEW.payment_date IS NOT NULL THEN NEW.payment_date::DATE END,
    CURRENT_DATE
  );

  -- Movimiento de caja (solo medios que impactan efectivo/caja física)
  INSERT INTO public.financial_movements (
    business_id, type, currency, amount, exchange_rate, amount_ars,
    source, source_id, reference_id, reference_type,
    description, date, created_by
  ) VALUES (
    v_business_id,
    'income',
    COALESCE(NEW.currency, 'ARS'),
    NEW.amount,
    1,
    NEW.amount,
    'payment',
    NEW.id,
    NEW.order_id,
    'order',
    'Cobro orden #' || LEFT(NEW.order_id::TEXT, 8),
    v_date,
    NEW.created_by
  );

  -- Entrada en business_finance_entries
  INSERT INTO public.business_finance_entries (
    business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate,
    payment_method, reference_order_id, source, created_by
  ) VALUES (
    v_business_id,
    v_date,
    'income',
    'servicios_tecnicos',
    'Cobro orden #' || LEFT(NEW.order_id::TEXT, 8),
    NEW.amount,
    COALESCE(NEW.currency, 'ARS'),
    NEW.amount,
    1,
    NEW.payment_method,
    NEW.order_id,
    'payment',
    NEW.created_by
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_payment_movements ON public.order_payments;
CREATE TRIGGER trig_payment_movements
  BEFORE INSERT ON public.order_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_payment_creates_movements();

-- ================================================================
-- 7. TRIGGER: comprobante emitido/anulado → bfe
-- ================================================================

CREATE OR REPLACE FUNCTION public.trigger_comprobante_finance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_status TEXT;
  v_old_status TEXT;
  v_amount     NUMERIC;
  v_date       DATE;
  v_desc       TEXT;
BEGIN
  -- Leer status desde columna inglesa o española
  v_new_status := COALESCE(NEW.status, NEW.estado);
  v_old_status := COALESCE(OLD.status, OLD.estado);

  IF NEW.business_id IS NULL THEN RETURN NEW; END IF;

  v_amount := COALESCE(NEW.total_ars, NEW.total, 0);
  v_date   := COALESCE(
    CASE WHEN NEW.date IS NOT NULL THEN NEW.date::DATE END,
    NEW.fecha::DATE,
    CURRENT_DATE
  );

  -- Emitido: registrar ingreso (evitar duplicado)
  IF v_new_status IN ('issued', 'emitido')
     AND COALESCE(v_old_status, '') NOT IN ('issued', 'emitido') THEN

    IF NOT EXISTS (
      SELECT 1 FROM public.business_finance_entries
      WHERE reference_comprobante_id = NEW.id AND type = 'income' AND amount_ars > 0
    ) THEN
      v_desc := 'Comprobante #' || COALESCE(NEW.number, NEW.numero, '');
      INSERT INTO public.business_finance_entries (
        business_id, date, type, category, description,
        amount, currency, amount_ars, exchange_rate,
        reference_comprobante_id, source, created_by
      ) VALUES (
        NEW.business_id, v_date, 'income', 'ventas_productos',
        v_desc, v_amount,
        COALESCE(NEW.currency, 'ARS'), v_amount,
        COALESCE(NEW.exchange_rate, 1),
        NEW.id, 'comprobante', NEW.created_by
      );
    END IF;
  END IF;

  -- Anulado: registrar reverso
  IF v_new_status IN ('cancelled', 'anulado')
     AND COALESCE(v_old_status, '') NOT IN ('cancelled', 'anulado') THEN

    v_desc := 'ANULACIÓN Comprobante #' || COALESCE(NEW.number, NEW.numero, '');
    INSERT INTO public.business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      reference_comprobante_id, source, created_by
    ) VALUES (
      NEW.business_id, CURRENT_DATE, 'income', 'ventas_productos',
      v_desc, -v_amount,
      COALESCE(NEW.currency, 'ARS'), -v_amount,
      COALESCE(NEW.exchange_rate, 1),
      NEW.id, 'comprobante', NEW.created_by
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_comprobante_finance ON public.comprobantes;
CREATE TRIGGER trig_comprobante_finance
  AFTER INSERT OR UPDATE OF status, estado ON public.comprobantes
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_comprobante_finance();

-- ================================================================
-- 8. TRIGGER: expense INSERT/DELETE → bfe + financial_movements
-- ================================================================

CREATE OR REPLACE FUNCTION public.trigger_expense_finance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount     NUMERIC;
  v_pay_method TEXT;
  v_entry_type TEXT;
  v_category   TEXT;
  v_bfe_id     UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Revertir entrada de finanzas si existe
    IF OLD.finance_entry_id IS NOT NULL THEN
      INSERT INTO public.business_finance_entries (
        business_id, date, type, category, description,
        amount, currency, amount_ars, exchange_rate,
        payment_method, source
      )
      SELECT
        business_id, CURRENT_DATE, type, category,
        'REVERSO: ' || COALESCE(description, ''),
        -amount, currency, -amount_ars, exchange_rate,
        payment_method, 'system'
      FROM public.business_finance_entries
      WHERE id = OLD.finance_entry_id;
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT: solo procesar si aún no tiene entrada financiera
  IF NEW.finance_entry_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.business_id IS NULL THEN RETURN NEW; END IF;

  v_amount     := COALESCE(NEW.amount_ars, NEW.amount, 0);
  v_pay_method := COALESCE(NEW.payment_method, 'efectivo');

  -- Mapear categoría → tipo + categoría financiera
  v_entry_type := CASE LOWER(COALESCE(NEW.category, ''))
    WHEN 'inventario' THEN 'variable_cost'
    ELSE 'fixed_cost_local'
  END;

  v_category := CASE LOWER(COALESCE(NEW.category, ''))
    WHEN 'inventario'   THEN 'mercaderia'
    WHEN 'operativos'   THEN 'otros_fijos_local'
    WHEN 'equipamiento' THEN 'mantenimiento'
    WHEN 'marketing'    THEN 'publicidad'
    ELSE 'otros_fijos_local'
  END;

  INSERT INTO public.business_finance_entries (
    business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate,
    payment_method, source, created_by
  ) VALUES (
    NEW.business_id,
    COALESCE(NEW.date::DATE, CURRENT_DATE),
    v_entry_type, v_category,
    COALESCE(NEW.description, 'Gasto: ' || COALESCE(NEW.category, '')),
    v_amount,
    COALESCE(NEW.currency, 'ARS'),
    v_amount,
    COALESCE(NEW.exchange_rate, 1),
    v_pay_method,
    'expense',
    NEW.created_by
  )
  RETURNING id INTO v_bfe_id;

  -- Guardar referencia en expenses
  UPDATE public.expenses SET finance_entry_id = v_bfe_id WHERE id = NEW.id;

  -- Movimiento de caja si fue en efectivo
  IF v_pay_method = 'efectivo' THEN
    INSERT INTO public.financial_movements (
      business_id, type, currency, amount, exchange_rate, amount_ars,
      source, source_id, description, date, created_by
    ) VALUES (
      NEW.business_id, 'expense', 'ARS', v_amount, 1, v_amount,
      'expense', v_bfe_id,
      COALESCE(NEW.description, 'Gasto ' || COALESCE(NEW.category, '')),
      COALESCE(NEW.date::DATE, CURRENT_DATE),
      NEW.created_by
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_expense_finance ON public.expenses;
CREATE TRIGGER trig_expense_finance
  AFTER INSERT OR DELETE ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_expense_finance();

-- ================================================================
-- 9. RPC: get_finance_summary (para Dashboard y Finanzas)
-- ================================================================

CREATE OR REPLACE FUNCTION public.get_finance_summary(
  p_business_id UUID,
  p_from        DATE DEFAULT CURRENT_DATE - INTERVAL '30 days',
  p_to          DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  total_income      NUMERIC,
  income_today      NUMERIC,
  income_this_week  NUMERIC,
  income_this_month NUMERIC,
  total_expenses    NUMERIC,
  net_result        NUMERIC,
  pending_balance   NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    COALESCE(SUM(CASE WHEN type = 'income' THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'income' AND date = CURRENT_DATE THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'income' AND date >= CURRENT_DATE - INTERVAL '7 days' THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'income' AND date >= DATE_TRUNC('month', CURRENT_DATE) THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type != 'income' THEN amount_ars ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'income' THEN amount_ars ELSE -amount_ars END), 0),
    (
      SELECT COALESCE(SUM(GREATEST(0, COALESCE(o.total_cost, 0) - COALESCE(o.amount_paid, 0))), 0)
      FROM public.orders o
      WHERE o.business_id = p_business_id
        AND o.status IN ('completed', 'ready_delivery', 'waiting_payment')
    )
  FROM public.business_finance_entries
  WHERE business_id = p_business_id
    AND date BETWEEN p_from AND p_to;
$$;

GRANT EXECUTE ON FUNCTION public.get_finance_summary(UUID, DATE, DATE) TO authenticated;

-- ================================================================
-- 10. Vista: dashboard_daily_summary
-- ================================================================

CREATE OR REPLACE VIEW public.dashboard_daily_summary AS
SELECT
  business_id,
  date,
  SUM(CASE WHEN type = 'income' THEN amount_ars ELSE 0 END)       AS income,
  SUM(CASE WHEN type != 'income' THEN amount_ars ELSE 0 END)      AS expenses,
  SUM(CASE WHEN type = 'income' THEN amount_ars ELSE -amount_ars END) AS net,
  COUNT(CASE WHEN type = 'income' THEN 1 END)                     AS income_count,
  COUNT(CASE WHEN type != 'income' THEN 1 END)                    AS expense_count
FROM public.business_finance_entries
GROUP BY business_id, date;

-- ================================================================
-- FIN DE MIGRACIÓN
-- ================================================================
