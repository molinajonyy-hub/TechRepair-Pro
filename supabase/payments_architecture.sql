-- ================================================================
-- ARQUITECTURA DEFINITIVA DE COBROS — TechRepair Pro
-- ================================================================
-- Prerequisito: fix_comprehensive_integration.sql y
--               fix_comprobantes_module.sql ya aplicados
-- ================================================================

-- ================================================================
-- 1. mp_accounts — tokens OAuth de Mercado Pago por negocio
-- ================================================================
CREATE TABLE IF NOT EXISTS public.mp_accounts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id             UUID NOT NULL UNIQUE REFERENCES public.businesses(id) ON DELETE CASCADE,
  mp_user_id              TEXT,
  app_id                  TEXT,
  client_id               TEXT,

  -- Tokens cifrados con pgcrypto (AES-256-CBC)
  -- La clave de cifrado la inyecta la Edge Function via secret MP_ENCRYPT_KEY
  access_token_encrypted  TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at        TIMESTAMPTZ,

  scope                   TEXT,
  is_active               BOOLEAN NOT NULL DEFAULT FALSE,
  country_id              TEXT DEFAULT 'AR',

  -- Webhooks
  webhook_url             TEXT,
  webhook_secret          TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mp_accounts_business_idx ON public.mp_accounts(business_id);
ALTER TABLE public.mp_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY mp_accounts_all ON public.mp_accounts
  FOR ALL TO authenticated
  USING  (business_id = public.current_user_business_id())
  WITH CHECK (business_id = public.current_user_business_id());

DROP TRIGGER IF EXISTS mp_accounts_updated_at ON public.mp_accounts;
CREATE TRIGGER mp_accounts_updated_at
  BEFORE UPDATE ON public.mp_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ================================================================
-- 2. payment_method_buttons — botones de cobro por negocio
-- ================================================================
CREATE TABLE IF NOT EXISTS public.payment_method_buttons (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id               UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,

  -- Identificación
  name                      TEXT NOT NULL,
  code                      TEXT NOT NULL,  -- slug único por negocio

  -- Clasificación
  payment_type              TEXT NOT NULL DEFAULT 'other'
    CHECK (payment_type IN ('cash','transfer','debit','credit','qr','wallet','check','other')),
  provider                  TEXT NOT NULL DEFAULT 'manual',
  channel                   TEXT NOT NULL DEFAULT 'manual'
    CHECK (channel IN ('manual','integrated')),
  integration_kind          TEXT NOT NULL DEFAULT 'none'
    CHECK (integration_kind IN ('none','mp_qr','mp_point','mp_checkout','custom')),

  -- Cuotas
  installments              INTEGER NOT NULL DEFAULT 1,

  -- Tarifas
  fee_percent               NUMERIC(7,4) NOT NULL DEFAULT 0,  -- 0.0399 = 3.99%
  fee_fixed                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  vat_percent               NUMERIC(7,4) NOT NULL DEFAULT 0,  -- IVA sobre comisión
  installment_extra_percent NUMERIC(7,4) NOT NULL DEFAULT 0,  -- extra por cuotas
  absorbs_fee               BOOLEAN NOT NULL DEFAULT FALSE,   -- negocio absorbe la comisión

  -- Apariencia
  color                     TEXT DEFAULT '#6366f1',
  icon                      TEXT DEFAULT 'wallet',
  sort_order                INTEGER NOT NULL DEFAULT 0,

  -- Estado
  is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
  notes                     TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(business_id, code)
);

CREATE INDEX IF NOT EXISTS pmb_business_active_idx
  ON public.payment_method_buttons(business_id, is_active, sort_order);

ALTER TABLE public.payment_method_buttons ENABLE ROW LEVEL SECURITY;

CREATE POLICY pmb_select ON public.payment_method_buttons
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id());

CREATE POLICY pmb_modify ON public.payment_method_buttons
  FOR ALL TO authenticated
  USING (business_id = public.current_user_business_id()
         AND public.current_user_role() IN ('owner','admin'))
  WITH CHECK (business_id = public.current_user_business_id()
              AND public.current_user_role() IN ('owner','admin'));

DROP TRIGGER IF EXISTS pmb_updated_at ON public.payment_method_buttons;
CREATE TRIGGER pmb_updated_at
  BEFORE UPDATE ON public.payment_method_buttons
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ================================================================
-- 3. payment_orders — órdenes de cobro (antes de confirmación)
-- ================================================================
CREATE TABLE IF NOT EXISTS public.payment_orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  comprobante_id       UUID REFERENCES public.comprobantes(id) ON DELETE SET NULL,
  payment_button_id    UUID REFERENCES public.payment_method_buttons(id) ON DELETE SET NULL,

  -- Proveedor e integración
  provider             TEXT NOT NULL DEFAULT 'manual',
  channel              TEXT NOT NULL DEFAULT 'manual',
  integration_kind     TEXT NOT NULL DEFAULT 'none',

  -- Referencia cruzada
  external_reference   TEXT,          -- referencia que enviamos a MP
  provider_order_id    TEXT,          -- id de la orden en MP
  provider_order_status TEXT,         -- estado en MP
  mp_qr_data           TEXT,          -- QR string para mostrar
  mp_deep_link         TEXT,          -- link para dispositivos móviles

  -- Montos
  requested_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  target_net_amount    NUMERIC(14,2),
  estimated_fee_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  estimated_net_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency             TEXT NOT NULL DEFAULT 'ARS',

  -- Estado
  status               TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','approved','rejected','expired','cancelled')),
  expires_at           TIMESTAMPTZ,

  -- Raw
  raw_response         JSONB,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS po_business_status_idx
  ON public.payment_orders(business_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS po_comprobante_idx
  ON public.payment_orders(comprobante_id);
CREATE INDEX IF NOT EXISTS po_external_ref_idx
  ON public.payment_orders(external_reference);

ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY po_all ON public.payment_orders
  FOR ALL TO authenticated
  USING  (business_id = public.current_user_business_id())
  WITH CHECK (business_id = public.current_user_business_id());

DROP TRIGGER IF EXISTS po_updated_at ON public.payment_orders;
CREATE TRIGGER po_updated_at
  BEFORE UPDATE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ================================================================
-- 4. payment_transactions — transacciones confirmadas
-- ================================================================
CREATE TABLE IF NOT EXISTS public.payment_transactions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  comprobante_id           UUID REFERENCES public.comprobantes(id) ON DELETE SET NULL,
  payment_order_id         UUID REFERENCES public.payment_orders(id) ON DELETE SET NULL,
  payment_button_id        UUID REFERENCES public.payment_method_buttons(id) ON DELETE SET NULL,

  -- Proveedor
  provider                 TEXT NOT NULL DEFAULT 'manual',
  channel                  TEXT NOT NULL DEFAULT 'manual',
  integration_kind         TEXT NOT NULL DEFAULT 'none',

  -- Referencias externas
  provider_payment_id      TEXT,
  provider_order_id        TEXT,
  external_reference       TEXT,

  -- Estado del proveedor
  status                   TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','in_process','rejected','refunded','cancelled','charged_back')),
  status_detail            TEXT,

  -- Detalle del medio de pago
  payment_method_type      TEXT,       -- credit_card, debit_card, account_money, etc.
  payment_method_id        TEXT,       -- visa, master, pix, etc.
  installments             INTEGER DEFAULT 1,

  -- Montos
  transaction_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  fee_amount_estimated     NUMERIC(14,2) NOT NULL DEFAULT 0,
  fee_amount_real          NUMERIC(14,2),         -- null hasta conciliación
  net_amount_estimated     NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_amount_real          NUMERIC(14,2),         -- null hasta conciliación
  currency                 TEXT NOT NULL DEFAULT 'ARS',

  -- Fechas
  approved_at              TIMESTAMPTZ,
  released_at              TIMESTAMPTZ,           -- cuando se acredita en cuenta

  -- Flags
  is_manual                BOOLEAN NOT NULL DEFAULT FALSE,

  -- Raw
  raw_payment              JSONB,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pt_business_status_idx
  ON public.payment_transactions(business_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS pt_comprobante_idx
  ON public.payment_transactions(comprobante_id);
CREATE INDEX IF NOT EXISTS pt_provider_payment_idx
  ON public.payment_transactions(provider_payment_id);
CREATE INDEX IF NOT EXISTS pt_external_ref_idx
  ON public.payment_transactions(external_reference);

ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY pt_all ON public.payment_transactions
  FOR ALL TO authenticated
  USING  (business_id = public.current_user_business_id())
  WITH CHECK (business_id = public.current_user_business_id());

DROP TRIGGER IF EXISTS pt_updated_at ON public.payment_transactions;
CREATE TRIGGER pt_updated_at
  BEFORE UPDATE ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ================================================================
-- 5. payment_webhook_events — log idempotente de webhooks
-- ================================================================
CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  provider      TEXT NOT NULL DEFAULT 'mercadopago',
  topic         TEXT,
  action        TEXT,
  resource_id   TEXT,
  live_mode     BOOLEAN DEFAULT TRUE,
  raw_payload   JSONB,
  processed     BOOLEAN NOT NULL DEFAULT FALSE,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS pwe_idempotency_idx
  ON public.payment_webhook_events(provider, resource_id, action)
  WHERE processed = TRUE;

CREATE INDEX IF NOT EXISTS pwe_unprocessed_idx
  ON public.payment_webhook_events(processed, created_at)
  WHERE processed = FALSE;

-- Sin RLS — lo accede solo la Edge Function con service_role
ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY pwe_service_only ON public.payment_webhook_events
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ================================================================
-- 6. Extender financial_movements con campos de proveedor
-- ================================================================
ALTER TABLE public.financial_movements
  ADD COLUMN IF NOT EXISTS comprobante_id       UUID REFERENCES public.comprobantes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_transaction_id UUID REFERENCES public.payment_transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS movement_type        TEXT DEFAULT 'income'
    CHECK (movement_type IN ('income','fee','refund','chargeback','adjustment')),
  ADD COLUMN IF NOT EXISTS provider             TEXT,
  ADD COLUMN IF NOT EXISTS channel              TEXT,
  ADD COLUMN IF NOT EXISTS sign                 SMALLINT NOT NULL DEFAULT 1
    CHECK (sign IN (-1, 1));

-- ================================================================
-- 7. Extender comprobantes con campos de cobro integrado
-- ================================================================
ALTER TABLE public.comprobantes
  ADD COLUMN IF NOT EXISTS payment_status        TEXT DEFAULT 'pending'
    CHECK (payment_status IN ('pending','partial','paid','refunded','cancelled')),
  ADD COLUMN IF NOT EXISTS payment_provider      TEXT,
  ADD COLUMN IF NOT EXISTS payment_channel       TEXT,
  ADD COLUMN IF NOT EXISTS payment_integration   TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS external_reference    TEXT,
  ADD COLUMN IF NOT EXISTS provider_order_id     TEXT,
  ADD COLUMN IF NOT EXISTS provider_payment_id   TEXT,
  ADD COLUMN IF NOT EXISTS gross_amount          NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS fee_amount            NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_amount            NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS amount_paid           NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_approved_at   TIMESTAMPTZ;

-- Sincronizar payment_status desde estado_comercial
UPDATE public.comprobantes
SET payment_status = CASE estado_comercial
  WHEN 'pagado'  THEN 'paid'
  WHEN 'parcial' THEN 'partial'
  WHEN 'anulado' THEN 'cancelled'
  ELSE 'pending'
END
WHERE payment_status = 'pending';

-- ================================================================
-- 8. TRIGGER: payment_transaction aprobada → actualiza comprobante
--    + genera financial_movements (bruto y comisión separados)
-- ================================================================
CREATE OR REPLACE FUNCTION public.trigger_payment_transaction_approved()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_comp_num  TEXT;
  v_biz_id    UUID;
BEGIN
  -- Solo actuar cuando pasa a 'approved' y tiene comprobante
  IF NEW.status != 'approved'
     OR (OLD.status = 'approved' AND NEW.status = 'approved')
     OR NEW.comprobante_id IS NULL
  THEN
    RETURN NEW;
  END IF;

  v_biz_id := NEW.business_id;

  SELECT COALESCE(number, numero, id::TEXT)
  INTO v_comp_num
  FROM public.comprobantes
  WHERE id = NEW.comprobante_id;

  -- Movimiento: ingreso bruto
  INSERT INTO public.financial_movements (
    business_id, comprobante_id, payment_transaction_id,
    type, movement_type, currency, amount, exchange_rate, amount_ars,
    source, source_id, provider, channel, sign, description, date, created_by
  ) VALUES (
    v_biz_id, NEW.comprobante_id, NEW.id,
    'income', 'income', NEW.currency,
    NEW.transaction_amount, 1, NEW.transaction_amount,
    'comprobante', NEW.id,
    NEW.provider, NEW.channel, 1,
    'Cobro ' || COALESCE(NEW.provider,'') || ' #' || v_comp_num,
    COALESCE(NEW.approved_at::DATE, CURRENT_DATE), NULL
  );

  -- Movimiento: comisión (negativo)
  IF COALESCE(NEW.fee_amount_estimated, 0) > 0 THEN
    INSERT INTO public.financial_movements (
      business_id, comprobante_id, payment_transaction_id,
      type, movement_type, currency, amount, exchange_rate, amount_ars,
      source, source_id, provider, channel, sign, description, date
    ) VALUES (
      v_biz_id, NEW.comprobante_id, NEW.id,
      'expense', 'fee', NEW.currency,
      NEW.fee_amount_estimated, 1, NEW.fee_amount_estimated,
      'comprobante', NEW.id,
      NEW.provider, NEW.channel, -1,
      'Comisión ' || COALESCE(NEW.provider,'') || ' #' || v_comp_num,
      COALESCE(NEW.approved_at::DATE, CURRENT_DATE)
    );
  END IF;

  -- Registrar en business_finance_entries (ingreso neto)
  INSERT INTO public.business_finance_entries (
    business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate,
    payment_method, reference_comprobante_id, source, created_by
  ) VALUES (
    v_biz_id,
    COALESCE(NEW.approved_at::DATE, CURRENT_DATE),
    'income', 'ventas_productos',
    'Cobro ' || COALESCE(NEW.provider,'manual') || ' — ' || v_comp_num,
    NEW.net_amount_estimated,
    NEW.currency, NEW.net_amount_estimated, 1,
    NEW.payment_method_type,
    NEW.comprobante_id, 'comprobante', NULL
  )
  ON CONFLICT DO NOTHING;

  -- Si hay comisión, registrarla como costo
  IF COALESCE(NEW.fee_amount_estimated, 0) > 0 THEN
    INSERT INTO public.business_finance_entries (
      business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate,
      payment_method, reference_comprobante_id, source
    ) VALUES (
      v_biz_id,
      COALESCE(NEW.approved_at::DATE, CURRENT_DATE),
      'variable_cost', 'comisiones_cobro',
      'Comisión ' || COALESCE(NEW.provider,'') || ' — ' || v_comp_num,
      NEW.fee_amount_estimated,
      NEW.currency, NEW.fee_amount_estimated, 1,
      NEW.payment_method_type,
      NEW.comprobante_id, 'comprobante'
    )
    ON CONFLICT DO NOTHING;
  END IF;

  -- Actualizar comprobante
  UPDATE public.comprobantes
  SET
    payment_status       = 'paid',
    payment_provider     = NEW.provider,
    payment_channel      = NEW.channel,
    payment_integration  = NEW.integration_kind,
    provider_payment_id  = NEW.provider_payment_id,
    gross_amount         = NEW.transaction_amount,
    fee_amount           = COALESCE(NEW.fee_amount_estimated, 0),
    net_amount           = NEW.net_amount_estimated,
    amount_paid          = NEW.transaction_amount,
    payment_approved_at  = NEW.approved_at,
    estado_comercial     = 'pagado',
    updated_at           = NOW()
  WHERE id = NEW.comprobante_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_pt_approved ON public.payment_transactions;
CREATE TRIGGER trig_pt_approved
  AFTER UPDATE OF status ON public.payment_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_payment_transaction_approved();

-- También disparar en INSERT si ya viene aprobado
CREATE OR REPLACE FUNCTION public.trigger_pt_insert_approved()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'approved' AND NEW.comprobante_id IS NOT NULL THEN
    PERFORM public.trigger_payment_transaction_approved();
  END IF;
  RETURN NEW;
END;
$$;

-- ================================================================
-- 9. Botones de cobro predeterminados para negocios nuevos
-- ================================================================
CREATE OR REPLACE FUNCTION public.create_default_payment_buttons(p_business_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.payment_method_buttons
    (business_id, name, code, payment_type, provider, channel, integration_kind,
     fee_percent, fee_fixed, color, icon, sort_order)
  VALUES
    (p_business_id, 'Efectivo',        'cash',           'cash',     'manual',      'manual', 'none', 0,      0,    '#34d399', 'banknote',    1),
    (p_business_id, 'Transferencia',   'transfer',       'transfer', 'manual',      'manual', 'none', 0,      0,    '#60a5fa', 'send',        2),
    (p_business_id, 'Débito (MP)',     'mp_debit',       'debit',    'mercadopago', 'manual', 'none', 0.0089, 0,    '#818cf8', 'credit-card', 3),
    (p_business_id, 'Crédito 1C (MP)','mp_credit_1',    'credit',   'mercadopago', 'manual', 'none', 0.0399, 0,    '#f59e0b', 'credit-card', 4),
    (p_business_id, 'QR (MP)',         'mp_qr',          'qr',       'mercadopago', 'manual', 'none', 0.0099, 0,    '#a78bfa', 'qr-code',     5),
    (p_business_id, 'Link de pago',    'mp_checkout',    'wallet',   'mercadopago', 'manual', 'none', 0.0399, 0,    '#6366f1', 'link',        6)
  ON CONFLICT (business_id, code) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_default_payment_buttons(UUID) TO authenticated;

-- Crear botones para negocios ya existentes que no los tengan
SELECT public.create_default_payment_buttons(b.id)
FROM public.businesses b
WHERE NOT EXISTS (
  SELECT 1 FROM public.payment_method_buttons pmb
  WHERE pmb.business_id = b.id
);

-- ================================================================
-- 10. Vista analítica de pagos por proveedor
-- ================================================================
CREATE OR REPLACE VIEW public.v_payment_analytics AS
SELECT
  pt.business_id,
  DATE_TRUNC('month', pt.created_at)   AS month,
  pt.provider,
  pt.channel,
  pt.payment_method_type,
  COUNT(*)                             AS total_transactions,
  SUM(pt.transaction_amount)           AS gross_total,
  SUM(COALESCE(pt.fee_amount_real, pt.fee_amount_estimated)) AS fee_total,
  SUM(COALESCE(pt.net_amount_real, pt.net_amount_estimated)) AS net_total,
  AVG(COALESCE(pt.fee_amount_real, pt.fee_amount_estimated)
      / NULLIF(pt.transaction_amount, 0) * 100)              AS avg_fee_pct,
  COUNT(*) FILTER (WHERE pt.fee_amount_real IS NOT NULL)     AS reconciled_count
FROM public.payment_transactions pt
WHERE pt.status = 'approved'
GROUP BY 1, 2, 3, 4, 5;

-- ================================================================
-- FIN
-- ================================================================
