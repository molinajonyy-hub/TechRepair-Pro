-- ================================================================
-- MÓDULO COMPROBANTES — MIGRACIÓN COMPLETA
-- TechRepair Pro
-- ================================================================

-- ================================================================
-- 1. comprobantes — nuevos campos de estado, totales y fiscal
--    SIN CHECK constraints en ADD COLUMN (se agregan después del UPDATE)
-- ================================================================
ALTER TABLE public.comprobantes
  ADD COLUMN IF NOT EXISTS estado_comercial TEXT DEFAULT 'pendiente',
  ADD COLUMN IF NOT EXISTS estado_fiscal    TEXT DEFAULT 'no_fiscal',
  ADD COLUMN IF NOT EXISTS es_fiscal        BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS emitir_en_arca   BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS numero_fiscal    TEXT,
  ADD COLUMN IF NOT EXISTS observaciones    TEXT,
  ADD COLUMN IF NOT EXISTS descuento_total  NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recargo_total    NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_bruto      NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cobrado    NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS saldo_pendiente  NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_comisiones NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_neto       NUMERIC(14,2) DEFAULT 0;

-- Eliminar constraints previas si existen (para re-aplicar de forma limpia)
DO $$
BEGIN
  ALTER TABLE public.comprobantes DROP CONSTRAINT IF EXISTS comprobantes_estado_comercial_check;
  ALTER TABLE public.comprobantes DROP CONSTRAINT IF EXISTS comprobantes_estado_fiscal_check;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Sincronizar estados existentes primero (sin constraint aún)
UPDATE public.comprobantes
SET
  estado_comercial = CASE COALESCE(status, estado)
    WHEN 'issued'    THEN 'pagado'
    WHEN 'emitido'   THEN 'pagado'
    WHEN 'cancelled' THEN 'anulado'
    WHEN 'anulado'   THEN 'anulado'
    ELSE 'pendiente'
  END,
  estado_fiscal = CASE COALESCE(status, estado)
    WHEN 'issued'    THEN CASE WHEN cae IS NOT NULL THEN 'emitido' ELSE 'no_fiscal' END
    WHEN 'emitido'   THEN CASE WHEN cae IS NOT NULL THEN 'emitido' ELSE 'no_fiscal' END
    WHEN 'cancelled' THEN 'anulado_fiscal'
    WHEN 'anulado'   THEN 'anulado_fiscal'
    ELSE 'no_fiscal'
  END,
  total_bruto     = COALESCE(total_ars, total, 0),
  saldo_pendiente = COALESCE(total_ars, total, 0);

-- Agregar constraints DESPUÉS del UPDATE
ALTER TABLE public.comprobantes
  ADD CONSTRAINT comprobantes_estado_comercial_check
    CHECK (estado_comercial IN ('pendiente','parcial','pagado','anulado')),
  ADD CONSTRAINT comprobantes_estado_fiscal_check
    CHECK (estado_fiscal IN ('no_fiscal','pendiente_emision','emitido','error_emision','anulado_fiscal'));

-- ================================================================
-- 2. comprobante_items — campos de tipo, descuento y costo
-- ================================================================
ALTER TABLE public.comprobante_items
  ADD COLUMN IF NOT EXISTS tipo_linea      TEXT DEFAULT 'producto'
    CHECK (tipo_linea IN ('producto','servicio','repuesto','otro')),
  ADD COLUMN IF NOT EXISTS descuento_linea NUMERIC(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS costo_unitario  NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS costo_total     NUMERIC(14,2) DEFAULT 0;

-- ================================================================
-- 3. comprobante_payments — pagos registrados contra el comprobante
-- ================================================================
CREATE TABLE IF NOT EXISTS public.comprobante_payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comprobante_id    UUID NOT NULL REFERENCES public.comprobantes(id) ON DELETE CASCADE,
  business_id       UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'ARS' CHECK (currency IN ('ARS','USD')),
  amount_ars        NUMERIC(14,2) NOT NULL DEFAULT 0,
  exchange_rate     NUMERIC(12,4) NOT NULL DEFAULT 1,
  payment_method    TEXT NOT NULL DEFAULT 'efectivo'
    CHECK (payment_method IN ('efectivo','transferencia','tarjeta_debito',
                               'tarjeta_credito','qr','mixto','otro')),
  payment_provider  TEXT,
  commission_rate   NUMERIC(7,4) DEFAULT 0,
  commission_amount NUMERIC(14,2) DEFAULT 0,
  net_amount        NUMERIC(14,2) DEFAULT 0,
  date              DATE NOT NULL DEFAULT CURRENT_DATE,
  notes             TEXT,
  created_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cp_comprobante_idx ON public.comprobante_payments(comprobante_id);
CREATE INDEX IF NOT EXISTS cp_business_date_idx ON public.comprobante_payments(business_id, date DESC);

ALTER TABLE public.comprobante_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY cp_all ON public.comprobante_payments
  FOR ALL TO authenticated
  USING (business_id = public.current_user_business_id())
  WITH CHECK (business_id = public.current_user_business_id());

-- ================================================================
-- 4. TRIGGER: comprobante_payment → actualizar total_cobrado, saldo, estado_comercial
-- ================================================================
CREATE OR REPLACE FUNCTION public.trigger_comprobante_payment_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_comp_id      UUID;
  v_total        NUMERIC;
  v_total_cobrado NUMERIC;
  v_saldo        NUMERIC;
  v_estado_com   TEXT;
BEGIN
  v_comp_id := COALESCE(NEW.comprobante_id, OLD.comprobante_id);

  SELECT
    COALESCE(total_bruto, total_ars, total, 0),
    COALESCE(
      (SELECT SUM(amount_ars) FROM public.comprobante_payments
       WHERE comprobante_id = v_comp_id), 0)
  INTO v_total, v_total_cobrado
  FROM public.comprobantes
  WHERE id = v_comp_id;

  v_saldo := GREATEST(0, v_total - v_total_cobrado);

  v_estado_com := CASE
    WHEN v_total_cobrado <= 0             THEN 'pendiente'
    WHEN v_saldo <= 0.01                  THEN 'pagado'
    ELSE 'parcial'
  END;

  UPDATE public.comprobantes
  SET total_cobrado    = v_total_cobrado,
      saldo_pendiente  = v_saldo,
      estado_comercial = v_estado_com,
      updated_at       = NOW()
  WHERE id = v_comp_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trig_comprobante_payment_sync ON public.comprobante_payments;
CREATE TRIGGER trig_comprobante_payment_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.comprobante_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_comprobante_payment_sync();

-- ================================================================
-- 5. TRIGGER: comprobante_payment → financial_movements + bfe
-- ================================================================
CREATE OR REPLACE FUNCTION public.trigger_comprobante_payment_finance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_comp_num TEXT;
BEGIN
  SELECT COALESCE(number, numero, id::TEXT) INTO v_comp_num
  FROM public.comprobantes WHERE id = NEW.comprobante_id;

  -- Movimiento de caja (efectivo y tarjetas sí impactan caja)
  IF NEW.payment_method IN ('efectivo','tarjeta_debito','tarjeta_credito','qr') THEN
    INSERT INTO public.financial_movements (
      business_id, date, type, currency, amount, exchange_rate, amount_ars,
      source, source_id, description, created_by
    ) VALUES (
      NEW.business_id, NEW.date, 'income',
      NEW.currency, NEW.amount, NEW.exchange_rate, NEW.amount_ars,
      'comprobante', NEW.id,
      'Cobro comprobante #' || v_comp_num,
      NEW.created_by
    );
  END IF;

  -- Entrada en finanzas (siempre)
  INSERT INTO public.business_finance_entries (
    business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate,
    payment_method, reference_comprobante_id, source, created_by
  ) VALUES (
    NEW.business_id, NEW.date, 'income', 'ventas_productos',
    'Cobro comprobante #' || v_comp_num,
    NEW.amount_ars, NEW.currency, NEW.amount_ars, NEW.exchange_rate,
    NEW.payment_method, NEW.comprobante_id, 'comprobante', NEW.created_by
  );

  -- Si hay comisión, registrar egreso
  IF NEW.commission_amount > 0 THEN
    INSERT INTO public.business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      payment_method, reference_comprobante_id, source, created_by
    ) VALUES (
      NEW.business_id, NEW.date, 'variable_cost', 'comisiones_cobro',
      'Comisión ' || COALESCE(NEW.payment_provider, NEW.payment_method) || ' - comprobante #' || v_comp_num,
      NEW.commission_amount, 'ARS', NEW.commission_amount, 1,
      NEW.payment_method, NEW.comprobante_id, 'comprobante', NEW.created_by
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_comprobante_payment_finance ON public.comprobante_payments;
CREATE TRIGGER trig_comprobante_payment_finance
  AFTER INSERT ON public.comprobante_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_comprobante_payment_finance();

-- ================================================================
-- 6. TRIGGER: ítem insertado/modificado → descontar stock
--    (solo para tipo_linea = 'producto' o 'repuesto')
-- ================================================================
CREATE OR REPLACE FUNCTION public.trigger_comprobante_item_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_comp_status TEXT;
  v_biz_id UUID;
BEGIN
  -- Solo actuar sobre comprobantes emitidos (issued)
  SELECT COALESCE(status, estado), business_id
  INTO v_comp_status, v_biz_id
  FROM public.comprobantes
  WHERE id = NEW.comprobante_id;

  -- Solo descontar stock si el comprobante ya está emitido y el ítem tiene inventario
  IF v_comp_status IN ('issued','emitido')
     AND NEW.inventory_id IS NOT NULL
     AND COALESCE(NEW.tipo_linea, 'producto') IN ('producto','repuesto')
  THEN
    UPDATE public.inventory
    SET stock_quantity = GREATEST(0, stock_quantity - NEW.cantidad),
        updated_at = NOW()
    WHERE id = NEW.inventory_id;

    INSERT INTO public.inventory_movements (
      business_id, inventory_id, inventory_item_id,
      movement_type, quantity, previous_stock, new_stock,
      reference_type, reference_id, note, created_by
    )
    SELECT
      v_biz_id, NEW.inventory_id, NEW.inventory_id,
      'sale', -NEW.cantidad,
      stock_quantity + NEW.cantidad,
      stock_quantity,
      'comprobante', NEW.comprobante_id,
      'Venta en comprobante #' || LEFT(NEW.comprobante_id::TEXT, 8),
      NEW.created_by
    FROM public.inventory WHERE id = NEW.inventory_id;
  END IF;

  RETURN NEW;
END;
$$;

-- ================================================================
-- 7. Vista comprobantes con totales y pagos
-- ================================================================
CREATE OR REPLACE VIEW public.v_comprobantes_full AS
SELECT
  c.*,
  cust.name   AS customer_name,
  cust.phone  AS customer_phone,
  cust.email  AS customer_email,
  COALESCE(pay.total_pagado, 0)  AS total_pagado_calc,
  GREATEST(0, COALESCE(c.total_bruto, c.total_ars, c.total, 0)
              - COALESCE(pay.total_pagado, 0)) AS saldo_calc,
  pay.medios_de_pago
FROM public.comprobantes c
LEFT JOIN public.customers cust ON c.customer_id = cust.id
LEFT JOIN (
  SELECT
    comprobante_id,
    SUM(amount_ars) AS total_pagado,
    STRING_AGG(DISTINCT payment_method, ', ') AS medios_de_pago
  FROM public.comprobante_payments
  GROUP BY comprobante_id
) pay ON c.id = pay.comprobante_id;

-- ================================================================
-- FIN
-- ================================================================
