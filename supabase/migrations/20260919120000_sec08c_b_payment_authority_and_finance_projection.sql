-- ═══════════════════════════════════════════════════════════════════════════
-- SEC-08C · FASE B — CORRECCIONES DE LA REVISION INDEPENDIENTE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La revision devolvio REWORK sobre tres blockers. Los tres se reprodujeron
-- contra esta misma base ANTES de tocar nada
-- (scripts/security/sec08c-phase-b-blockers.mjs, 11 hallazgos):
--
--   B1  Un actor `sales` (inventory=true, finance=false, costos=false) CREABA
--       un pago real a proveedor: fila en supplier_payments, movimiento de
--       cuenta corriente y salida de caja en financial_movements... y despues
--       no podia leer nada de eso, porque la fase A movio la LECTURA a
--       can_view_supplier_finance y dejo la ESCRITURA en `inventory`.
--
--       Ademas —esto NO estaba en el informe de la revision y lo encontro la
--       reproduccion— el MISMO actor mueve caja por otra puerta:
--       create_supplier_purchase_atomic con p_paid_amount > 0 inserta un
--       supplier_payment y un financial_movement. Gatear solo las RPC de pago
--       habria dejado el agujero abierto y la correccion habria sido cosmetica.
--
--   B2  get_finance_charts_l1 devolvia payables_aging.total = 0 a un actor sin
--       autoridad, con deuda real 117308. Un 0 fabricado por COALESCE sobre
--       cero filas: llega como NUMERO, no como ausencia.
--
--   B3  Un actor finance-only recibia la FILA CRUDA de supplier_purchases:
--       invoice_number, notes, attachment_url y created_by, ademas de por
--       filtro y por ORDER BY. La fase A habia ampliado la policy de la tabla
--       BASE para darle los importes, y con ellos se llevo todo lo operativo.
--
-- ── DECISION DE AUTORIDAD (B1) ────────────────────────────────────────────
-- Mover dinero a un proveedor es una operacion de FINANZAS, no de inventario.
-- La excepcion ratificada de SEC-08B es sobre el COSTO: comprar establece el
-- costo server-side sin poder leerlo. NO es una licencia para mover caja.
--
-- Por eso:
--   · pagar (pay_supplier_free_atomic / pay_supplier_purchase_atomic)
--       -> `finance`
--   · comprar A CREDITO (p_paid_amount = 0)
--       -> `inventory`   (la excepcion ratificada, intacta)
--   · comprar CON PAGO (p_paid_amount > 0)
--       -> `inventory` Y ADEMAS `finance`
--
-- La conjuncion usa el parametro p_additional_capability que
-- private.has_action_authority YA implementa como AND. No se inventa ninguna
-- capability nueva y no se toca el modelo RBAC.
--
-- CAMBIO DE COMPORTAMIENTO DELIBERADO: `manager` (inventory + costos, sin
-- finance) deja de poder registrar pagos a proveedor y compras con pago
-- inicial. Es exactamente lo que pide la revision al prohibir que
-- inventory_view_costs sea sustituto de Finance en endpoints de pago. Si el
-- producto decidiera que el rol de compras debe pagar, la vuelta atras es
-- darle `finance` por override de perfil —no relajar estas RPC.
--
-- ── LO QUE NO SE TOCA ─────────────────────────────────────────────────────
-- La LECTURA de supplier_payments y supplier_account_movements sigue en
-- can_view_supplier_finance (finance OR inventory_view_costs), con
-- justificacion de producto explicita: la cuenta corriente del proveedor ES el
-- registro de la deuda de compras, y el rol que compra necesita saber cuanto
-- debe antes de volver a comprar. Leer lo que se debe es una operacion de
-- compras; mover el dinero no. Esa es la linea que separa la lectura de la
-- escritura en este lote.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Autoridad de escritura de pagos (B1) ────────────────────────────────
-- Los wrappers publicos son finos a proposito: autoridad y delegacion. Se
-- reescriben COMPLETOS (nada de parchear el cuerpo con pg_get_functiondef) y
-- conservan search_path fijo con pg_temp AL FINAL.

CREATE OR REPLACE FUNCTION public.pay_supplier_free_atomic(
  p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text,
  p_payment_date date, p_amount numeric, p_payment_method text, p_notes text,
  p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- SEC-08C fase B: pagar es FINANZAS. Antes exigia 'inventory'.
  PERFORM private.require_action_authority(p_business_id, 'finance', NULL, NULL);
  RETURN private.pay_supplier_free_atomic(p_business_id,p_supplier_id,p_user_id,p_supplier_name,p_payment_date,p_amount,p_payment_method,p_notes,p_idempotency_key);
END;
$function$;

CREATE OR REPLACE FUNCTION public.pay_supplier_purchase_atomic(
  p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text,
  p_purchase_id uuid, p_payment_date date, p_amount numeric, p_payment_method text,
  p_notes text, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM private.require_action_authority(p_business_id, 'finance', NULL, NULL);
  RETURN private.pay_supplier_purchase_atomic(p_business_id,p_supplier_id,p_user_id,p_supplier_name,p_purchase_id,p_payment_date,p_amount,p_payment_method,p_notes,p_idempotency_key);
END;
$function$;

-- Comprar sigue siendo `inventory`. Comprar PAGANDO exige ademas `finance`:
-- el pago inicial inserta supplier_payments + financial_movements, o sea que
-- sin esta conjuncion la puerta de atras seguiria abierta.
CREATE OR REPLACE FUNCTION public.create_supplier_purchase_atomic(
  p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text,
  p_purchase_date date, p_invoice_number text, p_total_amount numeric,
  p_paid_amount numeric, p_payment_method text, p_notes text, p_items jsonb,
  p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM private.require_action_authority(
    p_business_id, 'inventory',
    CASE WHEN COALESCE(p_paid_amount, 0) > 0 THEN 'finance' END,
    NULL);
  RETURN private.create_supplier_purchase_atomic(p_business_id,p_supplier_id,p_user_id,p_supplier_name,p_purchase_date,p_invoice_number,p_total_amount,p_paid_amount,p_payment_method,p_notes,p_items,p_idempotency_key);
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_quick_inventory_purchase_atomic(
  p_business_id uuid, p_idempotency_key text, p_supplier_id uuid, p_supplier_name text,
  p_invoice text, p_date date, p_payment_method text, p_total_ars numeric,
  p_paid_ars numeric, p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM private.require_action_authority(
    p_business_id, 'inventory',
    CASE WHEN COALESCE(p_paid_ars, 0) > 0 THEN 'finance' END,
    NULL);
  RETURN private.create_quick_inventory_purchase_atomic(p_business_id,p_idempotency_key,p_supplier_id,p_supplier_name,p_invoice,p_date,p_payment_method,p_total_ars,p_paid_ars,p_items);
END;
$function$;

-- Una SECDEF "nace abierta": EXECUTE a PUBLIC es el default de PostgreSQL y
-- este proyecto ademas tiene ALTER DEFAULT PRIVILEGES para `anon`.
REVOKE ALL ON FUNCTION public.pay_supplier_free_atomic(uuid,uuid,uuid,text,date,numeric,text,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pay_supplier_purchase_atomic(uuid,uuid,uuid,text,uuid,date,numeric,text,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_supplier_free_atomic(uuid,uuid,uuid,text,date,numeric,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pay_supplier_purchase_atomic(uuid,uuid,uuid,text,uuid,date,numeric,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb) TO authenticated, service_role;

-- ── 2. Proyeccion financiera de compras (B3) ───────────────────────────────
-- El problema es que sobre la MISMA tabla conviven dos autoridades con dos
-- conjuntos de columnas distintos, y ni la RLS (que filtra filas) ni un GRANT
-- de columna (que es por rol, no por capability) pueden expresar eso.
--
-- La respuesta es la misma que ratifico SEC-08B para el costo: la tabla base
-- queda con la autoridad restrictiva y la otra autoridad recibe una PROYECCION
-- explicita. Aca es una funcion SECURITY DEFINER —no una vista DEFINER— para
-- no agregar otra vista sin security_invoker al catalogo.
--
-- Columnas: SOLO verdad financiera. Se excluyen a proposito invoice_number,
-- payment_method, notes, attachment_url, created_by, created_at y updated_at.
CREATE OR REPLACE FUNCTION public.finance_supplier_purchases()
RETURNS TABLE (
  supplier_purchase_id uuid,
  business_id          uuid,
  supplier_id          uuid,
  purchase_date        date,
  due_date             date,
  payment_status       text,
  -- Sin typmod: PostgreSQL lo DESCARTA en RETURNS TABLE, asi que declarar
  -- numeric(12,2) aca no sirve de nada. La precision se restituye con un cast
  -- explicito en v_finance_payables_due, que es la unica vista que ya publicaba
  -- pending_amount como numeric(12,2) y que CREATE OR REPLACE no deja cambiar.
  total_amount         numeric,
  paid_amount          numeric,
  pending_amount       numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT sp.id, sp.business_id, sp.supplier_id, sp.purchase_date, sp.due_date,
         sp.payment_status, sp.total_amount, sp.paid_amount, sp.pending_amount
    FROM public.supplier_purchases sp
   WHERE sp.business_id = public.current_user_business_id()
     AND public.can_view_supplier_finance(sp.business_id);
$function$;

COMMENT ON FUNCTION public.finance_supplier_purchases() IS
  'SEC-08C fase B. Proyeccion FINANCIERA de supplier_purchases para actores con '
  'autoridad financiera de proveedor que NO tienen acceso a la tabla base. '
  'Devuelve solo importes, fechas y estado: nunca invoice_number, notes, '
  'attachment_url ni created_by. Liga el tenant con current_user_business_id() '
  'y la autoridad con can_view_supplier_finance().';

REVOKE ALL ON FUNCTION public.finance_supplier_purchases() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_supplier_purchases() TO authenticated;

-- ── 3. La tabla base vuelve a la autoridad de SEC-08B (B3) ────────────────
-- La fase A la habia abierto a can_view_supplier_finance y con eso un actor
-- finance-only se llevaba la fila entera. Vuelve a exigir autoridad de COSTO,
-- que es exactamente como la dejo SEC-08B: este lote ya no amplia la base.
DROP POLICY IF EXISTS supplier_purchases_inventory_select ON public.supplier_purchases;
CREATE POLICY supplier_purchases_inventory_select ON public.supplier_purchases
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id()
         AND public.can_view_inventory_cost(business_id));

-- ── 4. Las vistas de finanzas leen la PROYECCION, no la tabla ─────────────
-- Si siguieran leyendo la base, un actor finance-only veria cero filas y el
-- agregado volveria a fabricar un 0.

CREATE OR REPLACE VIEW public.v_finance_payables_aging
WITH (security_invoker = true) AS
  SELECT sp.business_id,
         CASE
           WHEN (ar_today() - sp.purchase_date) <= 7  THEN '0-7'::text
           WHEN (ar_today() - sp.purchase_date) <= 30 THEN '8-30'::text
           WHEN (ar_today() - sp.purchase_date) <= 60 THEN '31-60'::text
           ELSE '60+'::text
         END AS bucket,
         round(sum(sp.pending_amount), 2) AS amount,
         count(*) AS purchases
    FROM public.finance_supplier_purchases() sp
   WHERE sp.pending_amount > 0.01
   GROUP BY sp.business_id, 2;

CREATE OR REPLACE VIEW public.v_finance_payables_due
WITH (security_invoker = true) AS
  SELECT sp.business_id,
         sp.supplier_purchase_id,
         sp.supplier_id,
         sp.purchase_date,
         sp.due_date,
         sp.pending_amount::numeric(12,2) AS pending_amount,
         sp.payment_status,
         CASE WHEN sp.due_date IS NULL THEN NULL::integer
              ELSE sp.due_date - ar_today() END AS days_to_due,
         CASE WHEN sp.due_date IS NULL THEN 'undated'::text
              WHEN sp.due_date < ar_today() THEN 'overdue'::text
              WHEN sp.due_date <= (ar_today() + 14) THEN 'due_soon'::text
              ELSE 'future'::text END AS due_status
    FROM public.finance_supplier_purchases() sp
   WHERE sp.pending_amount > 0.01
     AND sp.payment_status <> 'paid'::text;

CREATE OR REPLACE VIEW public.v_finance_supplier_purchases_daily
WITH (security_invoker = true) AS
  SELECT sp.business_id,
         sp.purchase_date,
         count(*) AS purchases,
         round(COALESCE(sum(sp.total_amount), 0::numeric), 2) AS amount_ars
    FROM public.finance_supplier_purchases() sp
   GROUP BY sp.business_id, sp.purchase_date;

CREATE OR REPLACE VIEW public.v_finance_supplier_debt
WITH (security_invoker = true) AS
  SELECT
    b.id AS business_id,
    CASE WHEN public.can_view_supplier_finance(b.id)
         THEN COALESCE(d.outstanding, 0)::numeric
         ELSE NULL::numeric END AS outstanding_ars,
    CASE WHEN public.can_view_supplier_finance(b.id)
         THEN COALESCE(d.documents, 0)::bigint
         ELSE NULL::bigint END AS documents,
    public.can_view_supplier_finance(b.id) AS is_authorized
  FROM public.businesses b
  LEFT JOIN (
    SELECT sp.business_id,
           round(sum(sp.pending_amount), 2) AS outstanding,
           count(*)                         AS documents
      FROM public.finance_supplier_purchases() sp
     WHERE sp.pending_amount > 0.01
       AND sp.payment_status <> 'paid'
     GROUP BY sp.business_id
  ) d ON d.business_id = b.id;

CREATE OR REPLACE VIEW public.v_finance_supplier_stats
WITH (security_invoker = true) AS
  SELECT
    s.business_id,
    s.id AS supplier_id,
    CASE WHEN public.can_view_supplier_finance(s.business_id)
         THEN COALESCE(a.total_purchases, 0)::numeric ELSE NULL::numeric END AS total_purchases,
    CASE WHEN public.can_view_supplier_finance(s.business_id)
         THEN COALESCE(a.total_paid, 0)::numeric      ELSE NULL::numeric END AS total_paid,
    CASE WHEN public.can_view_supplier_finance(s.business_id)
         THEN COALESCE(a.pending_amount, 0)::numeric  ELSE NULL::numeric END AS pending_amount,
    CASE WHEN public.can_view_supplier_finance(s.business_id)
         THEN COALESCE(a.purchases_count, 0)::bigint  ELSE NULL::bigint  END AS purchases_count,
    CASE WHEN public.can_view_supplier_finance(s.business_id)
         THEN a.last_purchase_date                    ELSE NULL::date    END AS last_purchase_date,
    public.can_view_supplier_finance(s.business_id) AS is_authorized
  FROM public.suppliers s
  LEFT JOIN (
    SELECT sp.supplier_id,
           round(sum(sp.total_amount), 2)   AS total_purchases,
           round(sum(sp.paid_amount), 2)    AS total_paid,
           round(sum(sp.pending_amount), 2) AS pending_amount,
           count(*)                         AS purchases_count,
           max(sp.purchase_date)            AS last_purchase_date
      FROM public.finance_supplier_purchases() sp
     GROUP BY sp.supplier_id
  ) a ON a.supplier_id = s.id;

REVOKE ALL ON public.v_finance_supplier_debt FROM PUBLIC, anon;
REVOKE ALL ON public.v_finance_supplier_stats FROM PUBLIC, anon;
REVOKE ALL ON public.v_finance_payables_aging FROM PUBLIC, anon;
REVOKE ALL ON public.v_finance_payables_due FROM PUBLIC, anon;
REVOKE ALL ON public.v_finance_supplier_purchases_daily FROM PUBLIC, anon;
GRANT SELECT ON public.v_finance_supplier_debt TO authenticated;
GRANT SELECT ON public.v_finance_supplier_stats TO authenticated;
GRANT SELECT ON public.v_finance_payables_aging TO authenticated;
GRANT SELECT ON public.v_finance_payables_due TO authenticated;
GRANT SELECT ON public.v_finance_supplier_purchases_daily TO authenticated;

-- ── 5. get_finance_charts_l1: restringido -> NULL, nunca 0 (B2) ───────────
-- Se reescribe COMPLETA. Los unicos cambios son la variable de autoridad y los
-- dos bloques de payables; el resto es identico byte a byte a la definicion
-- vigente y se genero transformandola con anclas verificadas, no a mano.
CREATE OR REPLACE FUNCTION public.get_finance_charts_l1(p_business_id uuid, p_period_start date, p_period_end date, p_granularity text DEFAULT 'auto'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_days      int;
  v_gran      text;
  v_cmp_start date;
  v_cmp_end   date;
  v_out       jsonb;
  v_pay_auth  boolean;
BEGIN
  IF p_business_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_params');
  END IF;
  IF p_period_end < p_period_start THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_period');
  END IF;

  -- SEC-08C fase B: la autoridad de payables se resuelve UNA vez y se
  -- transporta en el payload. Sin esto, un actor sin autoridad recibia
  -- total = 0 por COALESCE sobre cero filas: un cero FABRICADO que se lee
  -- como "no hay deuda".
  v_pay_auth := public.can_view_supplier_finance(p_business_id);

  v_days := (p_period_end - p_period_start) + 1;

  -- ── Granularidad (§5) ────────────────────────────────────────────────────
  v_gran := CASE
    WHEN p_granularity IN ('day', 'week', 'month') THEN p_granularity
    WHEN v_days <= 31  THEN 'day'
    WHEN v_days <= 120 THEN 'week'
    ELSE 'month'
  END;

  -- ── Periodo de comparacion: MISMA duracion, inmediatamente anterior (§4) ──
  v_cmp_end   := p_period_start - 1;
  v_cmp_start := v_cmp_end - (v_days - 1);

  WITH
  -- ══ P&L del periodo, por dia (fuente canonica devengada) ══
  pnl AS (
    SELECT
      p.period_date,
      p.net_sales,
      p.cogs,
      (p.payment_fees + p.operating_expenses + p.employee_salaries) AS operating_expenses,
      p.gross_profit,
      p.operating_result
    FROM public.v_finance_pnl p
    WHERE p.business_id = p_business_id
      AND p.period_date BETWEEN p_period_start AND p_period_end
  ),
  pnl_prev AS (
    SELECT
      p.net_sales, p.cogs,
      (p.payment_fees + p.operating_expenses + p.employee_salaries) AS operating_expenses,
      p.gross_profit, p.operating_result
    FROM public.v_finance_pnl p
    WHERE p.business_id = p_business_id
      AND p.period_date BETWEEN v_cmp_start AND v_cmp_end
  ),
  -- ══ Cobros del periodo (append-only, compensa anulaciones) ══
  coll AS (
    SELECT c.period_date, c.payment_method, c.amount_ars, c.comprobante_payment_id, c.event_type
    FROM public.v_finance_collections_ledger c
    WHERE c.business_id = p_business_id
      AND c.period_date BETWEEN p_period_start AND p_period_end
  ),
  coll_prev AS (
    SELECT round(COALESCE(sum(c.amount_ars), 0), 2) AS total
    FROM public.v_finance_collections_ledger c
    WHERE c.business_id = p_business_id
      AND c.period_date BETWEEN v_cmp_start AND v_cmp_end
  ),
  -- ══ Bucketizacion comun a las dos series temporales ══
  buckets AS (
    -- g.d es timestamptz; se castea a date para que el bucket viaje al frontend
    -- como '2026-08-01' y no como un instante con offset (que ademas se
    -- reinterpretaria en la zona del navegador).
    SELECT
      CASE v_gran
        WHEN 'day'   THEN g.d::date
        WHEN 'week'  THEN date_trunc('week',  g.d)::date
        ELSE              date_trunc('month', g.d)::date
      END AS bucket,
      g.d::date AS d
    FROM generate_series(p_period_start, p_period_end, interval '1 day') AS g(d)
  ),
  pnl_bucketed AS (
    SELECT
      b.bucket,
      round(COALESCE(sum(p.net_sales), 0), 2)          AS net_sales,
      round(COALESCE(sum(p.cogs), 0), 2)               AS cogs,
      round(COALESCE(sum(p.operating_expenses), 0), 2) AS operating_expenses,
      round(COALESCE(sum(p.operating_result), 0), 2)   AS operating_result
    FROM buckets b
    LEFT JOIN pnl p ON p.period_date = b.d
    GROUP BY b.bucket
  ),
  bvc_bucketed AS (
    SELECT
      b.bucket,
      round(COALESCE(sum(p.net_sales), 0), 2) AS billed,
      round(COALESCE(sum(c.amt), 0), 2)       AS collected
    FROM buckets b
    LEFT JOIN pnl p ON p.period_date = b.d
    LEFT JOIN (SELECT period_date, sum(amount_ars) AS amt FROM coll GROUP BY 1) c
           ON c.period_date = b.d
    GROUP BY b.bucket
  ),
  -- ══ Medios de cobro ══
  mix AS (
    SELECT
      c.payment_method AS method,
      round(sum(c.amount_ars), 2)                                              AS amount,
      count(DISTINCT c.comprobante_payment_id) FILTER (WHERE c.event_type = 'collection') AS operations
    FROM coll c
    GROUP BY c.payment_method
    HAVING round(sum(c.amount_ars), 2) <> 0
  ),
  -- ══ Aging: estado ACTUAL, no del periodo (por definicion) ══
  rec AS (
    SELECT r.bucket, r.amount, r.comprobantes AS documents
    FROM public.v_finance_receivables_aging r
    WHERE r.business_id = p_business_id
  ),
  pay AS (
    SELECT a.bucket, a.amount, a.purchases AS documents
    FROM public.v_finance_payables_aging a
    WHERE a.business_id = p_business_id
  ),
  -- ══ Vencimientos reales: NUNCA mezclados con el aging (§12) ══
  due AS (
    SELECT
      round(COALESCE(sum(d.pending_amount) FILTER (WHERE d.due_status = 'due_soon'), 0), 2) AS due_soon_amount,
      round(COALESCE(sum(d.pending_amount) FILTER (WHERE d.due_status = 'overdue'),  0), 2) AS overdue_amount,
      round(COALESCE(sum(d.pending_amount) FILTER (WHERE d.due_status = 'undated'),  0), 2) AS undated_amount,
      count(*) FILTER (WHERE d.due_status = 'undated')                                      AS undated_count,
      count(*) FILTER (WHERE d.due_date IS NOT NULL)                                        AS dated_count
    FROM public.v_finance_payables_due d
    WHERE d.business_id = p_business_id
  ),
  -- ══ Capital en stock (estado actual) ══
  cap AS (
    SELECT * FROM public.v_finance_inventory_capital c WHERE c.business_id = p_business_id
  ),
  -- ══ Flujos de inventario del periodo ══
  flows AS (
    SELECT
      f.flow_kind,
      sum(f.gross_units)      AS gross_units,
      sum(f.net_units)        AS net_units,
      sum(f.movements)        AS movements,
      sum(f.movements_costed) AS movements_costed,
      sum(f.cost_amount_ars)  AS cost_amount_ars
    FROM public.v_finance_inventory_flows f
    WHERE f.business_id = p_business_id
      AND f.movement_date_ar BETWEEN p_period_start AND p_period_end
    GROUP BY f.flow_kind
  ),
  -- ══ P1-D: compras a proveedores REGISTRADAS en el periodo ══
  -- CONTEXTO, no insumo. No entra en ningun calculo de reposicion: solo
  -- permite decir "hay compras cargadas" sin afirmar que fueran mercaderia.
  sp AS (
    SELECT
      COALESCE(sum(s.purchases), 0)::bigint     AS purchases_count,
      round(COALESCE(sum(s.amount_ars), 0), 2)  AS purchases_amount
    FROM public.v_finance_supplier_purchases_daily s
    WHERE s.business_id = p_business_id
      AND s.purchase_date BETWEEN p_period_start AND p_period_end
  ),
  -- ══ Retiros del propietario: FUERA del P&L, informados aparte (§9) ══
  own AS (
    SELECT round(COALESCE(sum(o.amount), 0), 2) AS withdrawals
    FROM public.v_owner_flows o
    WHERE o.business_id = p_business_id
      AND o.flow_type = 'withdrawal' AND o.status = 'completed'
      AND o.date BETWEEN p_period_start AND p_period_end
  ),
  -- ══ Totales ══
  tot AS (
    SELECT
      round(COALESCE(sum(net_sales), 0), 2)          AS net_sales,
      round(COALESCE(sum(cogs), 0), 2)               AS cogs,
      round(COALESCE(sum(operating_expenses), 0), 2) AS operating_expenses,
      round(COALESCE(sum(gross_profit), 0), 2)       AS gross_profit,
      round(COALESCE(sum(operating_result), 0), 2)   AS operating_result
    FROM pnl
  ),
  tot_prev AS (
    SELECT
      round(COALESCE(sum(net_sales), 0), 2)          AS net_sales,
      round(COALESCE(sum(cogs), 0), 2)               AS cogs,
      round(COALESCE(sum(operating_expenses), 0), 2) AS operating_expenses,
      round(COALESCE(sum(gross_profit), 0), 2)       AS gross_profit,
      round(COALESCE(sum(operating_result), 0), 2)   AS operating_result,
      count(*)                                       AS rows_found
    FROM pnl_prev
  )
  SELECT jsonb_build_object(
    'ok', true,
    'calculation_version', 'charts_l1_v1',
    'period', jsonb_build_object(
      'start', p_period_start, 'end', p_period_end,
      'days', v_days, 'granularity', v_gran,
      'timezone', 'America/Argentina/Cordoba'),
    'comparison_period', jsonb_build_object(
      'start', v_cmp_start, 'end', v_cmp_end, 'days', v_days),

    -- ── KPI del periodo ──
    'summary', (SELECT jsonb_build_object(
        'net_sales', t.net_sales,
        'cogs', t.cogs,
        'operating_expenses', t.operating_expenses,
        'gross_profit', t.gross_profit,
        'operating_result', t.operating_result,
        -- Margen sobre ventas netas. NULL (no 0) cuando no hay base.
        'margin_pct', CASE WHEN t.net_sales > 0
                           THEN round(t.operating_result / t.net_sales * 100, 2)
                           ELSE NULL END,
        'collections', (SELECT round(COALESCE(sum(amount_ars), 0), 2) FROM coll),
        'owner_withdrawals', (SELECT withdrawals FROM own)
      ) FROM tot t),

    -- ── Comparacion: mismo largo, inmediatamente anterior ──
    'comparison', (SELECT jsonb_build_object(
        'available', (tp.rows_found > 0),
        'net_sales', tp.net_sales,
        'cogs', tp.cogs,
        'operating_expenses', tp.operating_expenses,
        'gross_profit', tp.gross_profit,
        'operating_result', tp.operating_result,
        'margin_pct', CASE WHEN tp.net_sales > 0
                           THEN round(tp.operating_result / tp.net_sales * 100, 2)
                           ELSE NULL END,
        'collections', (SELECT total FROM coll_prev)
      ) FROM tot_prev tp),

    -- ── Series ──
    'pnl_series', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'bucket', bucket, 'net_sales', net_sales, 'cogs', cogs,
        'operating_expenses', operating_expenses, 'operating_result', operating_result)
        ORDER BY bucket) FROM pnl_bucketed), '[]'::jsonb),

    'billing_vs_collections', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'bucket', bucket, 'billed', billed, 'collected', collected)
        ORDER BY bucket) FROM bvc_bucketed), '[]'::jsonb),

    'payment_mix', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'method', method, 'amount', amount, 'operations', operations)
        ORDER BY amount DESC) FROM mix), '[]'::jsonb),

    -- ── Cartera (estado actual) ──
    'receivables_aging', jsonb_build_object(
      'total', (SELECT round(COALESCE(sum(amount), 0), 2) FROM rec),
      'documents', (SELECT COALESCE(sum(documents), 0) FROM rec),
      'buckets', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'bucket', bucket, 'amount', amount, 'documents', documents)
          ORDER BY bucket) FROM rec), '[]'::jsonb)),

    'payables_aging', jsonb_build_object(
      'is_authorized', v_pay_auth,
      'total', CASE WHEN v_pay_auth
                    THEN (SELECT round(COALESCE(sum(amount), 0), 2) FROM pay)
                    ELSE NULL END,
      'documents', CASE WHEN v_pay_auth
                        THEN (SELECT COALESCE(sum(documents), 0) FROM pay)
                        ELSE NULL END,
      'buckets', CASE WHEN v_pay_auth
                      THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
                             'bucket', bucket, 'amount', amount, 'documents', documents)
                             ORDER BY bucket) FROM pay), '[]'::jsonb)
                      ELSE '[]'::jsonb END),

    -- Vencimientos: superficie SEPARADA del aging, a proposito.
    'payables_due', (SELECT jsonb_build_object(
        'is_authorized', v_pay_auth,
        'due_soon_amount', CASE WHEN v_pay_auth THEN d.due_soon_amount ELSE NULL END,
        'overdue_amount',  CASE WHEN v_pay_auth THEN d.overdue_amount  ELSE NULL END,
        'undated_amount',  CASE WHEN v_pay_auth THEN d.undated_amount  ELSE NULL END,
        'undated_count',   CASE WHEN v_pay_auth THEN d.undated_count   ELSE NULL END,
        'has_due_dates',   CASE WHEN v_pay_auth THEN (d.dated_count > 0) ELSE false END
      ) FROM due d),

    -- ── Capital en stock ──
    'inventory_capital', COALESCE((SELECT jsonb_build_object(
        'inventory_at_cost', c.inventory_at_cost,
        'inventory_at_cost_valued', c.inventory_at_cost_valued,
        'products_total', c.products_total,
        'products_valued', c.products_valued,
        'products_missing_cost', c.products_missing_cost,
        'units_missing_cost', c.units_missing_cost,
        'products_negative_stock', c.products_negative_stock,
        'coverage_pct', CASE WHEN c.products_total > 0
                             THEN round(c.products_valued::numeric / c.products_total * 100, 2)
                             ELSE NULL END,
        'usd_based_products', c.usd_based_products,
        'usd_rate_min_applied', c.usd_rate_min_applied,
        'usd_rate_max_applied', c.usd_rate_max_applied,
        -- Se declara explicitamente que NO hay serie historica legitima.
        'history_available', false,
        'history_blocked_reason', 'no_historical_cost_basis'
      ) FROM cap c), jsonb_build_object(
        'inventory_at_cost', 0, 'inventory_at_cost_valued', 0,
        'products_total', 0, 'products_valued', 0, 'products_missing_cost', 0,
        'units_missing_cost', 0, 'products_negative_stock', 0,
        'coverage_pct', NULL, 'usd_based_products', 0,
        'usd_rate_min_applied', NULL, 'usd_rate_max_applied', NULL,
        'history_available', false,
        'history_blocked_reason', 'no_historical_cost_basis')),

    -- ── Flujos de inventario del periodo + indice de reposicion ──
    'inventory_flows', (
      WITH agg AS (
        SELECT
          COALESCE((SELECT cost_amount_ars  FROM flows WHERE flow_kind = 'purchase'), 0)        AS purchases_cost,
          COALESCE((SELECT gross_units      FROM flows WHERE flow_kind = 'purchase'), 0)        AS purchases_units,
          COALESCE((SELECT movements        FROM flows WHERE flow_kind = 'purchase'), 0)        AS purchases_movements,
          COALESCE((SELECT movements_costed FROM flows WHERE flow_kind = 'purchase'), 0)        AS purchases_movements_costed,
          COALESCE((SELECT gross_units      FROM flows WHERE flow_kind = 'return_in'), 0)       AS returns_units,
          COALESCE((SELECT cost_amount_ars  FROM flows WHERE flow_kind = 'return_in'), 0)       AS returns_cost,
          COALESCE((SELECT gross_units      FROM flows WHERE flow_kind = 'adjustment'), 0)      AS adjustments_units,
          COALESCE((SELECT net_units        FROM flows WHERE flow_kind = 'adjustment'), 0)      AS adjustments_net_units,
          COALESCE((SELECT cost_amount_ars  FROM flows WHERE flow_kind = 'adjustment'), 0)      AS adjustments_cost,
          COALESCE((SELECT gross_units      FROM flows WHERE flow_kind = 'cancellation_in'), 0) AS cancellations_units,
          COALESCE((SELECT sum(gross_units) FROM flows
                     WHERE flow_kind IN ('sale_out','order_out','credit_note_out','other_out')), 0) AS consumption_units,
          COALESCE((SELECT sum(movements) FROM flows
                     WHERE flow_kind IN ('sale_out','order_out')), 0)                           AS consumption_movements,
          COALESCE((SELECT sum(movements_costed) FROM flows
                     WHERE flow_kind IN ('sale_out','order_out')), 0)                           AS consumption_movements_costed,
          -- CONSUMO A COSTO: viene del COGS devengado, no de los movimientos.
          (SELECT cogs FROM tot)                                                                AS consumption_cost,
          -- P1-D: contexto. NO participa de ningun calculo de abajo.
          (SELECT purchases_count  FROM sp)                                                     AS supplier_purchases_count,
          (SELECT purchases_amount FROM sp)                                                     AS supplier_purchases_amount
      )
      SELECT jsonb_build_object(
        'purchases_cost', a.purchases_cost,
        'purchases_units', a.purchases_units,
        'purchases_movements', a.purchases_movements,
        'purchases_movements_costed', a.purchases_movements_costed,
        'consumption_cost', a.consumption_cost,
        'consumption_units', a.consumption_units,
        'consumption_movements_uncosted', (a.consumption_movements - a.consumption_movements_costed),
        'returns_units', a.returns_units,
        'returns_cost', a.returns_cost,
        'adjustments_units', a.adjustments_units,
        'adjustments_net_units', a.adjustments_net_units,
        'adjustments_cost', a.adjustments_cost,
        'cancellations_units', a.cancellations_units,
        -- Indice de reposicion (§16). Sin consumo NO hay Infinity: hay NULL y
        -- un motivo. Ajustes, devoluciones, cancelaciones y FX NO entran en el
        -- numerador; correcciones administrativas NO entran en el denominador.
        -- P1-D: supplier_purchases_* TAMPOCO. La formula es identica a la de
        -- 20260810120000 y este archivo no la modifica.
        'replenishment_pct', CASE WHEN a.consumption_cost > 0
                                  THEN round(a.purchases_cost / a.consumption_cost * 100, 2)
                                  ELSE NULL END,
        'replenishment_basis', CASE WHEN a.consumption_cost > 0 THEN 'comparable'
                                    ELSE 'no_comparable_consumption' END,
        'consumption_source', 'accrued_cogs',
        'purchases_source', 'inventory_movements_snapshot_cost',
        -- ── P1-D: contexto de compras registradas a proveedores ──
        -- Existe para explicar un 0 % sin acusar al usuario de no haber
        -- comprado. NO es reposicion y NO es mercaderia recibida: es el
        -- comprobante de compra cargado, que puede ser un gasto o un servicio.
        'supplier_purchases_count', a.supplier_purchases_count,
        'supplier_purchases_amount', a.supplier_purchases_amount,
        'supplier_purchases_source', 'supplier_purchases_registered',
        -- El puente contable queda bloqueado: las bases no son homogeneas.
        'bridge_available', false,
        'bridge_blocked_reason', 'heterogeneous_cost_basis'
      ) FROM agg a),

    -- ── Waterfall: ingresos -> COGS -> margen bruto -> gastos -> resultado ──
    -- Se emiten VALORES, no etiquetas: el idioma vive en React.
    'waterfall', (SELECT jsonb_build_array(
        jsonb_build_object('key', 'net_sales',          'value', t.net_sales,           'kind', 'start'),
        jsonb_build_object('key', 'cogs',               'value', -t.cogs,               'kind', 'delta'),
        jsonb_build_object('key', 'gross_profit',       'value', t.gross_profit,        'kind', 'subtotal'),
        jsonb_build_object('key', 'operating_expenses', 'value', -t.operating_expenses, 'kind', 'delta'),
        jsonb_build_object('key', 'operating_result',   'value', t.operating_result,    'kind', 'total')
      ) FROM tot t)
  ) INTO v_out;

  RETURN v_out;
END
$function$;

REVOKE ALL ON FUNCTION public.get_finance_charts_l1(uuid,date,date,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_finance_charts_l1(uuid,date,date,text) TO authenticated;

-- ── 6. Postcondiciones de catalogo ─────────────────────────────────────────
DO $$
DECLARE v_bad text;
BEGIN
  -- Las vistas conservan security_invoker: CREATE OR REPLACE resetea
  -- reloptions si no se las vuelve a declarar.
  SELECT string_agg(c.relname, ', ') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('v_finance_supplier_debt','v_finance_supplier_stats',
                       'v_finance_payables_aging','v_finance_payables_due',
                       'v_finance_supplier_purchases_daily','v_finance_position')
     AND COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                    WHERE option_name = 'security_invoker'), 'off') <> 'true';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SEC-08C fase B: vistas sin security_invoker=true: %', v_bad;
  END IF;

  -- B3: la tabla base NO puede seguir gobernada por la autoridad financiera.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='supplier_purchases'
       AND cmd='SELECT' AND qual LIKE '%can_view_supplier_finance%'
  ) THEN
    RAISE EXCEPTION 'SEC-08C fase B: supplier_purchases volvio a la autoridad financiera (fila cruda para finance-only)';
  END IF;

  -- B1: las RPC de pago no pueden seguir gateadas por inventario.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prokind='f'
       AND p.proname IN ('pay_supplier_free_atomic','pay_supplier_purchase_atomic')
       AND pg_get_functiondef(p.oid) LIKE '%require_action_authority(p_business_id, ''inventory''%'
  ) THEN
    RAISE EXCEPTION 'SEC-08C fase B: una RPC de pago sigue exigiendo inventory';
  END IF;

  -- La proyeccion financiera no puede exponer campos operativos.
  SELECT string_agg(a.attname, ', ') INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN unnest(p.proallargtypes, p.proargnames) WITH ORDINALITY AS a(atttypid, attname, ord) ON true
   WHERE n.nspname='public' AND p.proname='finance_supplier_purchases'
     AND a.attname IN ('invoice_number','payment_method','notes','attachment_url',
                       'created_by','created_at','updated_at');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SEC-08C fase B: finance_supplier_purchases expone campos operativos: %', v_bad;
  END IF;

  -- anon no ejecuta nada de esto.
  IF has_function_privilege('anon', 'public.finance_supplier_purchases()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pay_supplier_free_atomic(uuid,uuid,uuid,text,date,numeric,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC-08C fase B: anon conserva EXECUTE sobre funciones de proveedor';
  END IF;
END $$;

COMMIT;
