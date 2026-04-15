-- ============================================================
-- MIGRACIÓN COMPLETA - TechRepair Pro
-- Ejecutar en Supabase SQL Editor (en orden)
-- ============================================================

-- ─── 1. BUSINESS_SETTINGS (ampliar columnas) ────────────────
ALTER TABLE public.business_settings
  ADD COLUMN IF NOT EXISTS nombre_comercial        TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS razon_social            TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS cuit                    TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS condicion_iva           TEXT DEFAULT 'Responsable Inscripto',
  ADD COLUMN IF NOT EXISTS domicilio_fiscal        TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS localidad               TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS provincia               TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS codigo_postal           TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS telefono                TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS email                   TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS logo_url                TEXT,
  ADD COLUMN IF NOT EXISTS moneda_predeterminada   TEXT DEFAULT 'ARS',
  ADD COLUMN IF NOT EXISTS formato_fecha           TEXT DEFAULT 'DD/MM/YYYY',
  ADD COLUMN IF NOT EXISTS iva_por_defecto         NUMERIC DEFAULT 21,
  ADD COLUMN IF NOT EXISTS numeracion_comprobantes TEXT DEFAULT '0001-00000001',
  ADD COLUMN IF NOT EXISTS observaciones_comprobantes TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS stock_negativo          BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS alertas_bajo_stock      BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS categoria_cliente_defecto TEXT DEFAULT 'General',
  ADD COLUMN IF NOT EXISTS tipo_comprobante_defecto  TEXT DEFAULT 'Factura A';

-- Si business_settings no existe, crearla completa:
CREATE TABLE IF NOT EXISTS public.business_settings (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID UNIQUE NOT NULL,
  nombre_comercial            TEXT DEFAULT '',
  razon_social                TEXT DEFAULT '',
  cuit                        TEXT DEFAULT '',
  condicion_iva               TEXT DEFAULT 'Responsable Inscripto',
  domicilio_fiscal            TEXT DEFAULT '',
  localidad                   TEXT DEFAULT '',
  provincia                   TEXT DEFAULT '',
  codigo_postal               TEXT DEFAULT '',
  telefono                    TEXT DEFAULT '',
  email                       TEXT DEFAULT '',
  logo_url                    TEXT,
  moneda_predeterminada        TEXT DEFAULT 'ARS',
  formato_fecha               TEXT DEFAULT 'DD/MM/YYYY',
  iva_por_defecto             NUMERIC DEFAULT 21,
  numeracion_comprobantes     TEXT DEFAULT '0001-00000001',
  observaciones_comprobantes  TEXT DEFAULT '',
  stock_negativo              BOOLEAN DEFAULT FALSE,
  alertas_bajo_stock          BOOLEAN DEFAULT TRUE,
  categoria_cliente_defecto   TEXT DEFAULT 'General',
  tipo_comprobante_defecto    TEXT DEFAULT 'Factura A',
  -- currency fields
  default_currency            TEXT DEFAULT 'ARS',
  show_usd_price              BOOLEAN DEFAULT FALSE,
  auto_update_rate            BOOLEAN DEFAULT FALSE,
  rate_api_url                TEXT,
  rate_update_frequency_hours INTEGER DEFAULT 24,
  -- print settings fields (for useOrderPrintSettings)
  print_settings              JSONB,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.business_settings OWNER TO postgres;
GRANT ALL ON public.business_settings TO authenticated, anon, service_role;
ALTER TABLE public.business_settings DISABLE ROW LEVEL SECURITY;


-- ─── 2. EXCHANGE_RATES ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.exchange_rates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL,
  base_currency     TEXT NOT NULL DEFAULT 'USD',
  target_currency   TEXT NOT NULL DEFAULT 'ARS',
  rate              NUMERIC NOT NULL DEFAULT 1,
  is_manual         BOOLEAN DEFAULT TRUE,
  source            TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (business_id, base_currency, target_currency)
);

ALTER TABLE public.exchange_rates OWNER TO postgres;
GRANT ALL ON public.exchange_rates TO authenticated, anon, service_role;
ALTER TABLE public.exchange_rates DISABLE ROW LEVEL SECURITY;


-- ─── 3. CASH_REGISTERS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cash_registers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  date         DATE NOT NULL,
  ars_opening  NUMERIC DEFAULT 0,
  ars_balance  NUMERIC DEFAULT 0,
  usd_opening  NUMERIC DEFAULT 0,
  usd_balance  NUMERIC DEFAULT 0,
  exchange_rate NUMERIC DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  notes        TEXT,
  created_by   UUID,
  closed_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (business_id, date)
);

ALTER TABLE public.cash_registers OWNER TO postgres;
GRANT ALL ON public.cash_registers TO authenticated, anon, service_role;
ALTER TABLE public.cash_registers DISABLE ROW LEVEL SECURITY;


-- ─── 4. FINANCIAL_MOVEMENTS ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.financial_movements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  currency     TEXT NOT NULL DEFAULT 'ARS' CHECK (currency IN ('ARS', 'USD')),
  amount       NUMERIC NOT NULL DEFAULT 0,
  amount_ars   NUMERIC NOT NULL DEFAULT 0,
  exchange_rate NUMERIC DEFAULT 1,
  source       TEXT DEFAULT 'manual',
  description  TEXT,
  date         DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by   UUID,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.financial_movements OWNER TO postgres;
GRANT ALL ON public.financial_movements TO authenticated, anon, service_role;
ALTER TABLE public.financial_movements DISABLE ROW LEVEL SECURITY;


-- ─── 5. ORDER_PAYMENTS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.order_payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL,
  amount         NUMERIC NOT NULL DEFAULT 0,
  payment_date   TIMESTAMPTZ DEFAULT NOW(),
  payment_method TEXT DEFAULT 'efectivo',
  payment_status TEXT DEFAULT 'completed' CHECK (payment_status IN ('pending', 'completed', 'refunded')),
  notes          TEXT,
  created_by     UUID,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.order_payments OWNER TO postgres;
GRANT ALL ON public.order_payments TO authenticated, anon, service_role;
ALTER TABLE public.order_payments DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_order_payments_order_id ON public.order_payments(order_id);


-- ─── 6. ORDER_PARTS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.order_parts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL,
  inventory_id  UUID,
  name          TEXT NOT NULL,
  description   TEXT,
  quantity      NUMERIC NOT NULL DEFAULT 1,
  internal_cost NUMERIC DEFAULT 0,
  sale_price    NUMERIC DEFAULT 0,
  status        TEXT DEFAULT 'used' CHECK (status IN ('used', 'sold', 'returned')),
  added_at      TIMESTAMPTZ DEFAULT NOW(),
  created_by    UUID,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.order_parts OWNER TO postgres;
GRANT ALL ON public.order_parts TO authenticated, anon, service_role;
ALTER TABLE public.order_parts DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_order_parts_order_id ON public.order_parts(order_id);


-- ─── 7. ORDER_CHECKLISTS ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.order_checklists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL UNIQUE,
  items       JSONB DEFAULT '[]',
  notes       TEXT,
  completed   BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.order_checklists OWNER TO postgres;
GRANT ALL ON public.order_checklists TO authenticated, anon, service_role;
ALTER TABLE public.order_checklists DISABLE ROW LEVEL SECURITY;


-- ─── 8. DEVICE_INSPECTIONS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.device_inspections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('reception', 'final')),
  items       JSONB DEFAULT '{}',
  notes       TEXT,
  photos      JSONB DEFAULT '[]',
  created_by  UUID,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.device_inspections OWNER TO postgres;
GRANT ALL ON public.device_inspections TO authenticated, anon, service_role;
ALTER TABLE public.device_inspections DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_device_inspections_order_id ON public.device_inspections(order_id);


-- ─── 9. BUSINESS_FINANCE_ENTRIES ────────────────────────────
CREATE TABLE IF NOT EXISTS public.business_finance_entries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL,
  date                DATE NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('income','variable_cost','fixed_cost_local','fixed_cost_personal','salary')),
  category            TEXT NOT NULL,
  subcategory         TEXT,
  description         TEXT,
  amount              NUMERIC NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'ARS' CHECK (currency IN ('ARS','USD')),
  amount_ars          NUMERIC NOT NULL DEFAULT 0,
  exchange_rate       NUMERIC NOT NULL DEFAULT 1,
  payment_method      TEXT,
  notes               TEXT,
  reference_order_id  UUID,
  reference_employee  TEXT,
  created_by          UUID,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.business_finance_entries OWNER TO postgres;
GRANT ALL ON public.business_finance_entries TO authenticated, anon, service_role;
ALTER TABLE public.business_finance_entries DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_bfe_business_date ON public.business_finance_entries(business_id, date);


-- ─── 10. NOTIFICATIONS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL DEFAULT 'info',
  title        TEXT NOT NULL,
  message      TEXT,
  order_id     UUID,
  customer_id  UUID,
  is_read      BOOLEAN DEFAULT FALSE,
  read_at      TIMESTAMPTZ,
  metadata     JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.notifications OWNER TO postgres;
GRANT ALL ON public.notifications TO authenticated, anon, service_role;
ALTER TABLE public.notifications DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON public.notifications(is_read);


-- ─── 11. TASKS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','cancelled','done')),
  priority     TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  due_date     DATE,
  order_id     UUID,
  assigned_to  UUID,
  created_by   UUID,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.tasks OWNER TO postgres;
GRANT ALL ON public.tasks TO authenticated, anon, service_role;
ALTER TABLE public.tasks DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_tasks_business_id ON public.tasks(business_id);


-- ─── 12. PURCHASES ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.purchases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL,
  supplier_id     UUID,
  invoice_number  TEXT,
  purchase_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  subtotal        NUMERIC DEFAULT 0,
  taxes           NUMERIC DEFAULT 0,
  total           NUMERIC DEFAULT 0,
  notes           TEXT,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled')),
  created_by      UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.purchases OWNER TO postgres;
GRANT ALL ON public.purchases TO authenticated, anon, service_role;
ALTER TABLE public.purchases DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_purchases_business_id ON public.purchases(business_id);

CREATE TABLE IF NOT EXISTS public.purchase_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id       UUID NOT NULL,
  inventory_item_id UUID,
  description       TEXT NOT NULL,
  quantity          NUMERIC NOT NULL DEFAULT 1,
  unit_cost         NUMERIC NOT NULL DEFAULT 0,
  subtotal          NUMERIC NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.purchase_items OWNER TO postgres;
GRANT ALL ON public.purchase_items TO authenticated, anon, service_role;
ALTER TABLE public.purchase_items DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_id ON public.purchase_items(purchase_id);


-- ─── 13. BRANDS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.brands (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID,
  name         TEXT NOT NULL,
  description  TEXT,
  logo_url     TEXT,
  is_active    BOOLEAN DEFAULT TRUE,
  created_by   UUID,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.brands OWNER TO postgres;
GRANT ALL ON public.brands TO authenticated, anon, service_role;
ALTER TABLE public.brands DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_brands_business_id ON public.brands(business_id);


-- ─── 14. DEVICE_MODELS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.device_models (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID,
  brand_id     UUID,
  name         TEXT NOT NULL,
  type         TEXT DEFAULT 'smartphone' CHECK (type IN ('smartphone','tablet','laptop','smartwatch','other')),
  specs        JSONB DEFAULT '{}',
  is_active    BOOLEAN DEFAULT TRUE,
  created_by   UUID,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.device_models OWNER TO postgres;
GRANT ALL ON public.device_models TO authenticated, anon, service_role;
ALTER TABLE public.device_models DISABLE ROW LEVEL SECURITY;


-- ─── 15. WHATSAPP_SETTINGS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_settings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID UNIQUE NOT NULL,
  enabled             BOOLEAN DEFAULT FALSE,
  auto_send_enabled   BOOLEAN DEFAULT FALSE,
  business_name       TEXT DEFAULT '',
  business_address    TEXT DEFAULT '',
  business_whatsapp   TEXT DEFAULT '',
  business_instagram  TEXT DEFAULT '',
  business_hours      TEXT DEFAULT '',
  closing_message     TEXT DEFAULT '',
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.whatsapp_settings OWNER TO postgres;
GRANT ALL ON public.whatsapp_settings TO authenticated, anon, service_role;
ALTER TABLE public.whatsapp_settings DISABLE ROW LEVEL SECURITY;

-- ─── 15b. WHATSAPP_TEMPLATES ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL,
  status_key        TEXT NOT NULL,
  status_label      TEXT NOT NULL,
  message_template  TEXT NOT NULL DEFAULT '',
  auto_send         BOOLEAN DEFAULT FALSE,
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (business_id, status_key)
);

ALTER TABLE public.whatsapp_templates OWNER TO postgres;
GRANT ALL ON public.whatsapp_templates TO authenticated, anon, service_role;
ALTER TABLE public.whatsapp_templates DISABLE ROW LEVEL SECURITY;

-- ─── 15c. WHATSAPP_LOGS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL,
  order_id      UUID,
  customer_id   UUID,
  phone         TEXT,
  status_key    TEXT,
  message       TEXT,
  send_mode     TEXT DEFAULT 'manual' CHECK (send_mode IN ('manual','auto')),
  send_result   TEXT DEFAULT 'opened' CHECK (send_result IN ('opened','copied','failed','skipped')),
  error_message TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.whatsapp_logs OWNER TO postgres;
GRANT ALL ON public.whatsapp_logs TO authenticated, anon, service_role;
ALTER TABLE public.whatsapp_logs DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_order_id ON public.whatsapp_logs(order_id);


-- ─── 16. INVENTORY_MOVEMENTS ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id    UUID NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('purchase','sale','adjustment','return','transfer','initial')),
  quantity        NUMERIC NOT NULL,
  reference_type  TEXT,
  reference_id    TEXT,
  notes           TEXT,
  business_id     UUID NOT NULL,
  created_by      UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.inventory_movements OWNER TO postgres;
GRANT ALL ON public.inventory_movements TO authenticated, anon, service_role;
ALTER TABLE public.inventory_movements DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_inv_movements_inventory_id ON public.inventory_movements(inventory_id);
CREATE INDEX IF NOT EXISTS idx_inv_movements_business_id ON public.inventory_movements(business_id);


-- ─── 17. INVENTORY_VALUATION_HISTORY ────────────────────────
CREATE TABLE IF NOT EXISTS public.inventory_valuation_history (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID NOT NULL,
  fecha                DATE NOT NULL,
  capital_invertido    NUMERIC DEFAULT 0,
  valor_venta          NUMERIC DEFAULT 0,
  ganancia_potencial   NUMERIC DEFAULT 0,
  cantidad_total_items INTEGER DEFAULT 0,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (business_id, fecha)
);

ALTER TABLE public.inventory_valuation_history OWNER TO postgres;
GRANT ALL ON public.inventory_valuation_history TO authenticated, anon, service_role;
ALTER TABLE public.inventory_valuation_history DISABLE ROW LEVEL SECURITY;


-- ─── 18. DOCUMENTS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID NOT NULL,
  business_id  UUID,
  type         TEXT DEFAULT 'other',
  name         TEXT NOT NULL,
  url          TEXT,
  size         INTEGER,
  created_by   UUID,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.documents OWNER TO postgres;
GRANT ALL ON public.documents TO authenticated, anon, service_role;
ALTER TABLE public.documents DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_documents_order_id ON public.documents(order_id);


-- ─── 19. ARCA_PARAMETROS ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.arca_parametros (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  tipo         TEXT NOT NULL,    -- 'tipos_comprobante' | 'monedas' | 'alicuotas_iva'
  datos        JSONB DEFAULT '[]',
  actualizado  TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (business_id, tipo)
);

ALTER TABLE public.arca_parametros OWNER TO postgres;
GRANT ALL ON public.arca_parametros TO authenticated, anon, service_role;
ALTER TABLE public.arca_parametros DISABLE ROW LEVEL SECURITY;


-- ─── 20. STATUS_HISTORY (si no existe) ──────────────────────
CREATE TABLE IF NOT EXISTS public.status_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  notes       TEXT,
  changed_by  UUID,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.status_history OWNER TO postgres;
GRANT ALL ON public.status_history TO authenticated, anon, service_role;
ALTER TABLE public.status_history DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_status_history_order_id ON public.status_history(order_id);


-- ─── 21. NOTES (si no existe) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL,
  content     TEXT NOT NULL,
  type        TEXT DEFAULT 'internal',
  created_by  UUID,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.notes OWNER TO postgres;
GRANT ALL ON public.notes TO authenticated, anon, service_role;
ALTER TABLE public.notes DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_notes_order_id ON public.notes(order_id);


-- ─── 22. PARTS_USED (si no existe - alias de order_parts) ───
CREATE TABLE IF NOT EXISTS public.parts_used (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID NOT NULL,
  inventory_id UUID,
  name         TEXT NOT NULL,
  quantity     NUMERIC DEFAULT 1,
  unit_price   NUMERIC DEFAULT 0,
  total_price  NUMERIC DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.parts_used OWNER TO postgres;
GRANT ALL ON public.parts_used TO authenticated, anon, service_role;
ALTER TABLE public.parts_used DISABLE ROW LEVEL SECURITY;


-- ─── 23. Agregar columna business_id a comprobantes (si falta) ─
ALTER TABLE public.comprobantes
  ADD COLUMN IF NOT EXISTS business_id UUID,
  ADD COLUMN IF NOT EXISTS created_by  UUID;

ALTER TABLE public.comprobante_items
  ADD COLUMN IF NOT EXISTS business_id UUID,
  ADD COLUMN IF NOT EXISTS created_by  UUID;


-- ─── 24. Agregar columna comprobante_id a orders (si falta) ──
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS comprobante_id UUID,
  ADD COLUMN IF NOT EXISTS total_cost     NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_paid    NUMERIC DEFAULT 0;


-- ─── 25. Recargar schema cache de PostgREST ─────────────────
NOTIFY pgrst, 'reload schema';
