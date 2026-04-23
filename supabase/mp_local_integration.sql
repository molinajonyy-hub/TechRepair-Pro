-- ================================================================
-- INTEGRACIÓN MP POR LOCAL — TechRepair Pro
-- ================================================================

-- 1. sales_points: campos de Mercado Pago por local
ALTER TABLE public.sales_points
  ADD COLUMN IF NOT EXISTS mp_enabled       BOOLEAN       DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mp_store_id      TEXT,
  ADD COLUMN IF NOT EXISTS mp_pos_id        TEXT,
  ADD COLUMN IF NOT EXISTS mp_terminal_id   TEXT,
  ADD COLUMN IF NOT EXISTS mp_terminal_mode TEXT          DEFAULT 'PDV',
  ADD COLUMN IF NOT EXISTS mp_channel_qr    BOOLEAN       DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS mp_channel_point BOOLEAN       DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mp_fee_percent   NUMERIC(7,4)  DEFAULT 0.0099,
  ADD COLUMN IF NOT EXISTS mp_fee_fixed     NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mp_vat_percent   NUMERIC(7,4)  DEFAULT 0.21;

-- 2. profiles: local activo del usuario
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS active_sales_point_id UUID
    REFERENCES public.sales_points(id) ON DELETE SET NULL;

-- 3. comprobantes: local_id y campos de cobro
ALTER TABLE public.comprobantes
  ADD COLUMN IF NOT EXISTS local_id             UUID
    REFERENCES public.sales_points(id) ON DELETE SET NULL;

-- 4. payment_orders: local info
ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS local_id    UUID REFERENCES public.sales_points(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS store_id    TEXT,
  ADD COLUMN IF NOT EXISTS pos_id      TEXT,
  ADD COLUMN IF NOT EXISTS terminal_id TEXT;

-- 5. financial_movements: local_id
ALTER TABLE public.financial_movements
  ADD COLUMN IF NOT EXISTS local_id UUID
    REFERENCES public.sales_points(id) ON DELETE SET NULL;

-- 6. RLS para sales_points
ALTER TABLE public.sales_points ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sp_select ON public.sales_points;
CREATE POLICY sp_select ON public.sales_points
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id());

DROP POLICY IF EXISTS sp_write ON public.sales_points;
CREATE POLICY sp_write ON public.sales_points
  FOR ALL TO authenticated
  USING  (business_id = public.current_user_business_id())
  WITH CHECK (business_id = public.current_user_business_id());

-- 7. Función: obtener local activo del usuario
CREATE OR REPLACE FUNCTION public.get_active_sales_point(p_business_id UUID)
RETURNS TABLE (
  id              UUID,
  nombre          TEXT,
  numero          INTEGER,
  mp_enabled      BOOLEAN,
  mp_store_id     TEXT,
  mp_pos_id       TEXT,
  mp_terminal_id  TEXT,
  mp_terminal_mode TEXT,
  mp_channel_qr   BOOLEAN,
  mp_channel_point BOOLEAN,
  mp_fee_percent  NUMERIC,
  mp_fee_fixed    NUMERIC,
  mp_vat_percent  NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    sp.id, sp.nombre, sp.numero,
    COALESCE(sp.mp_enabled, FALSE),
    sp.mp_store_id, sp.mp_pos_id, sp.mp_terminal_id,
    COALESCE(sp.mp_terminal_mode, 'PDV'),
    COALESCE(sp.mp_channel_qr, TRUE),
    COALESCE(sp.mp_channel_point, FALSE),
    COALESCE(sp.mp_fee_percent, 0.0099),
    COALESCE(sp.mp_fee_fixed, 0),
    COALESCE(sp.mp_vat_percent, 0.21)
  FROM public.sales_points sp
  WHERE sp.business_id = p_business_id
    AND sp.activo = TRUE
  ORDER BY sp.predeterminado DESC, sp.numero ASC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_active_sales_point(UUID) TO authenticated;
