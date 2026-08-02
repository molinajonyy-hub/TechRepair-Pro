-- ============================================================================
-- P0-A.1 — Cierre automático de órdenes y estado de cobro derivado.
--
-- PROBLEMA: al facturar una orden nadie la completaba, y no había forma de
-- distinguir "el trabajo terminó" de "el dinero entró". El modelo tenía tres
-- campos que PARECÍAN servir y no sirven:
--   · orders.amount_paid          -> huérfano: ningún trigger ni RPC lo mantiene
--                                    (1 sola fila <> 0 en todo el histórico).
--   · comprobantes.payment_status -> MUERTO: 220 filas en 'pending' con saldo 0
--                                    y estado_comercial='pagado'. Nadie lo escribe.
--   · orders.comprobante_id       -> vía paralela a comprobantes.order_id (3 y 3).
-- Reutilizar cualquiera de los tres habría creado una segunda fuente de verdad
-- contradictoria. Ninguno se usa acá; se documentan como deuda en el informe.
--
-- QUÉ SÍ ES CANÓNICO Y SE REUTILIZA:
--   comprobantes.total_cobrado / saldo_pendiente / estado_comercial, mantenidos
--   server-side por trigger_comprobante_payment_sync desde los comprobante_payments
--   VIGENTES (replaced_at IS NULL). Ese trigger ya cubre pago adicional, reemplazo
--   de forma de pago y reversa, porque todos escriben comprobante_payments.
--
-- ESTRATEGIA (§2, opción 2 — DERIVAR):
--   El estado financiero de la orden NO se persiste: se deriva en
--   v_order_financial_status desde los comprobantes vigentes de la orden. Con 93
--   órdenes productivas no hay razón de rendimiento para duplicar el dato, y
--   derivar hace imposible la contradicción entre dos fuentes.
--   Lo único que se persiste son HECHOS TEMPORALES no derivables:
--   orders.completed_at y orders.paid_at.
--
-- ATOMICIDAD (§4): el cierre de la orden ocurre en un TRIGGER sobre comprobantes,
-- o sea DENTRO de la misma transacción del checkout, sin reescribir la RPC de
-- ~700 líneas ni permitir que el frontend haga un UPDATE posterior. Si el
-- checkout falla, el rollback se lleva también el cierre de la orden.
--
-- LÍMITE CONOCIDO Y DOCUMENTADO (§7.D): la cuenta corriente es un saldo POR
-- CLIENTE, no por documento — record_customer_account_payment_atomic inserta el
-- pago con reference_type='manual' y SIN reference_id. No existe imputación
-- open-item pago->comprobante. Por eso un cobro posterior de CC NO puede bajar
-- el saldo de una orden concreta sin inventar una política de imputación
-- (FIFO/proporcional) que el ledger no tiene. Esta migración expone el hecho en
-- columnas separadas (saldo_en_cc, deuda_en_cc) en vez de mentir. Ver informe §7.
--
-- ROLLBACK documentado al final.
-- ============================================================================

-- ── §1. Hechos temporales (lo único que se persiste) ────────────────────────
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "completed_at" timestamptz;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "paid_at"      timestamptz;

COMMENT ON COLUMN "public"."orders"."completed_at" IS
  'P0-A.1 — Momento en que la orden se cerró por facturación. Se establece UNA sola '
  'vez (el trigger nunca lo pisa) y sobrevive a anulaciones: el trabajo se hizo.';
COMMENT ON COLUMN "public"."orders"."paid_at" IS
  'P0-A.1 — Momento en que la orden quedó totalmente cobrada. Lo mantiene '
  'recompute_order_payment_status: se setea al pasar a paid y se limpia si una '
  'reversa o anulación vuelve a generar saldo. Nunca lo escribe el cliente.';

-- ── §2. Vista canónica del estado financiero de la orden ────────────────────
-- Una fila por orden. Deriva de los comprobantes VIGENTES vinculados.
--
-- Cardinalidad: hoy 0 órdenes tienen más de un comprobante, pero NO hay
-- constraint que lo impida y no se introduce uno acá (§3: no imponer la
-- restricción en silencio). La vista agrega por orden, así que N comprobantes
-- funcionan sin supuesto de 1:1.
CREATE OR REPLACE VIEW "public"."v_order_financial_status"
  WITH (security_invoker = true) AS
WITH comps AS (
  SELECT
    c.order_id,
    c.business_id,
    -- Vigentes: ni anulados ni notas de crédito.
    SUM(COALESCE(c.total_bruto, c.total_ars, c.total, 0))        AS total_comprobado,
    SUM(COALESCE(c.total_cobrado, 0))                            AS total_cobrado,
    SUM(COALESCE(c.saldo_pendiente, 0))                          AS saldo_pendiente,
    count(*)                                                     AS comprobantes_vigentes,
    -- Con varios comprobantes vigentes se expone el más reciente como
    -- "el comprobante" de la orden; el conteo queda en comprobantes_vigentes.
    (array_agg(c.id ORDER BY COALESCE(c.fecha, c.date, c.created_at) DESC))[1] AS comprobante_id,
    (array_agg(COALESCE(c.numero_fiscal, c.numero, c.number)
               ORDER BY COALESCE(c.fecha, c.date, c.created_at) DESC))[1]      AS comprobante_numero,
    MAX((COALESCE(c.fecha, c.date, c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date) AS fecha_comprobante,
    -- Parte del saldo que se trasladó a la cuenta corriente del cliente: la
    -- venta a CC deja un account_movement type='venta' referenciando el
    -- comprobante. Es deuda REAL, no cobro.
    SUM(COALESCE((SELECT SUM(am.debit - am.credit) FROM public.account_movements am
                   WHERE am.reference_type = 'comprobante' AND am.reference_id = c.id
                     AND am.type = 'venta'), 0))                 AS saldo_en_cc
  FROM public.comprobantes c
  WHERE c.order_id IS NOT NULL
    AND c.estado <> 'anulado'
    AND COALESCE(c.estado_comercial, '') <> 'anulado'
    AND COALESCE(c.status, '') <> 'cancelled'
    AND COALESCE(c.tipo, c.type) <> 'nota_credito'
  GROUP BY 1, 2
),
pagos AS (   -- último cobro efectivo registrado contra la orden
  SELECT c.order_id, MAX(p.date) AS ultimo_pago
  FROM public.comprobantes c
  JOIN public.comprobante_payments p ON p.comprobante_id = c.id AND p.replaced_at IS NULL
  WHERE c.order_id IS NOT NULL
  GROUP BY 1
)
SELECT
  o.id                                   AS order_id,
  o.business_id,
  o.status                               AS estado_tecnico,
  o.completed_at,
  o.paid_at,
  ROUND(COALESCE(k.total_comprobado, 0), 2) AS total_comprobado,
  ROUND(COALESCE(k.total_cobrado, 0), 2)    AS total_cobrado,
  ROUND(COALESCE(k.saldo_pendiente, 0), 2)  AS saldo_pendiente,
  ROUND(COALESCE(k.saldo_en_cc, 0), 2)      AS saldo_en_cc,
  (COALESCE(k.saldo_en_cc, 0) > 0.01)       AS deuda_en_cc,
  COALESCE(k.comprobantes_vigentes, 0)      AS comprobantes_vigentes,
  k.comprobante_id,
  k.comprobante_numero,
  k.fecha_comprobante,
  pg.ultimo_pago,
  -- ── Estado financiero (§3) ──────────────────────────────────────────────
  -- Tolerancia canónica 1,00 ARS: la misma que usan el checkout y
  -- annul_comprobante_atomic (c_tolerance_ars). No se inventa otra.
  CASE
    WHEN COALESCE(k.comprobantes_vigentes, 0) = 0        THEN 'sin_facturar'
    WHEN COALESCE(k.saldo_pendiente, 0) <= 1.00          THEN 'paid'
    WHEN COALESCE(k.total_cobrado, 0)   >  0             THEN 'partial'
    ELSE 'pending'
  END AS payment_status
FROM public.orders o
LEFT JOIN comps k  ON k.order_id = o.id
LEFT JOIN pagos pg ON pg.order_id = o.id;

COMMENT ON VIEW "public"."v_order_financial_status" IS
  'P0-A.1 — Fuente canónica del estado financiero de una orden. DERIVADA de los '
  'comprobantes vigentes (no anulados, sin notas de crédito) y de sus pagos '
  'vigentes. payment_status: sin_facturar | pending | partial | paid, con '
  'tolerancia de 1,00 ARS (la canónica del checkout). saldo_en_cc expone por '
  'separado la parte de la deuda trasladada a la cuenta corriente del cliente: es '
  'deuda, NO cobro, y no reduce el saldo. El estado TÉCNICO (orders.status) es un '
  'eje independiente: representa el trabajo, no el dinero.';

ALTER VIEW "public"."v_order_financial_status" OWNER TO "postgres";
GRANT SELECT ON "public"."v_order_financial_status" TO "authenticated";
GRANT SELECT ON "public"."v_order_financial_status" TO "service_role";

-- ── §3. Helper canónico único (§6) ──────────────────────────────────────────
-- Mantiene los timestamps derivables del estado. Idempotente: sólo escribe si
-- algo cambió, así que un replay no genera UPDATE ni evento de auditoría.
CREATE OR REPLACE FUNCTION "public"."recompute_order_payment_status"("p_order_id" uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_o        public.orders%ROWTYPE;
  v_st       record;
  v_paid_at  timestamptz;
  v_changed  boolean := false;
BEGIN
  IF p_order_id IS NULL THEN RETURN NULL; END IF;

  -- Lock de la orden: serializa dos cobros concurrentes sobre la misma orden.
  SELECT * INTO v_o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_st FROM public.v_order_financial_status WHERE order_id = p_order_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- paid_at: se setea al quedar cobrada; se LIMPIA si una reversa o anulación
  -- vuelve a generar saldo. No se pisa si ya estaba cobrada (idempotencia).
  IF v_st.payment_status = 'paid' THEN
    v_paid_at := COALESCE(v_o.paid_at, now());
  ELSE
    v_paid_at := NULL;
  END IF;

  IF v_o.paid_at IS DISTINCT FROM v_paid_at THEN
    UPDATE public.orders SET paid_at = v_paid_at, updated_at = now() WHERE id = p_order_id;
    v_changed := true;
    -- Auditoría canónica: se reutiliza finance_audit_log, no se crea tabla nueva.
    -- Sin datos personales, sin payloads, sin información fiscal.
    BEGIN
      PERFORM public.finance_log_audit(
        v_o.business_id, 'order_payment_status_changed', 'orders', p_order_id,
        'recompute_order_payment_status', NULL, NULL, public.ar_today(), 'order', p_order_id,
        NULL, jsonb_build_object(
          'order_id', p_order_id,
          'payment_status', v_st.payment_status,
          'total_comprobado', v_st.total_comprobado,
          'total_cobrado', v_st.total_cobrado,
          'saldo_pendiente', v_st.saldo_pendiente,
          'saldo_en_cc', v_st.saldo_en_cc,
          'paid_at_anterior', v_o.paid_at,
          'paid_at_nuevo', v_paid_at));
    EXCEPTION WHEN OTHERS THEN
      NULL;  -- la auditoría nunca puede tumbar un cobro
    END;
  END IF;

  RETURN jsonb_build_object(
    'order_id', p_order_id,
    'payment_status', v_st.payment_status,
    'estado_tecnico', v_st.estado_tecnico,
    'total_comprobado', v_st.total_comprobado,
    'total_cobrado', v_st.total_cobrado,
    'saldo_pendiente', v_st.saldo_pendiente,
    'saldo_en_cc', v_st.saldo_en_cc,
    'paid_at', v_paid_at,
    'changed', v_changed);
END;
$$;

ALTER FUNCTION "public"."recompute_order_payment_status"(uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."recompute_order_payment_status"(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."recompute_order_payment_status"(uuid) FROM "anon";
REVOKE EXECUTE ON FUNCTION "public"."recompute_order_payment_status"(uuid) FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."recompute_order_payment_status"(uuid) TO "service_role";

COMMENT ON FUNCTION "public"."recompute_order_payment_status"(uuid) IS
  'P0-A.1 — Único recalculador del estado financiero de una orden. Server-side, '
  'idempotente, con lock de la orden. Deriva de v_order_financial_status; nunca '
  'confía en datos del cliente. NO se otorga a authenticated: el frontend jamás '
  'determina ni escribe el estado financiero.';

-- ── §4. Cierre automático de la orden, dentro de la transacción del checkout ─
CREATE OR REPLACE FUNCTION "public"."order_complete_on_comprobante"() RETURNS "trigger"
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_o public.orders%ROWTYPE;
BEGIN
  IF NEW.order_id IS NULL THEN RETURN NEW; END IF;
  -- Una nota de crédito no cierra una orden.
  IF COALESCE(NEW.tipo, NEW.type) = 'nota_credito' THEN RETURN NEW; END IF;

  SELECT * INTO v_o FROM public.orders WHERE id = NEW.order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Aislamiento: un comprobante nunca cierra una orden de otro negocio.
  IF v_o.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'ORDER_CROSS_BUSINESS: la orden % no pertenece al negocio del comprobante', NEW.order_id
      USING ERRCODE = '42501';
  END IF;

  -- Transiciones prohibidas (§5): una orden cancelada no se completa por
  -- facturar. 'completed' es terminal: no se degrada ni se repite.
  IF v_o.status = 'cancelled' THEN
    RAISE EXCEPTION 'ORDER_CANCELLED: no se puede facturar una orden cancelada'
      USING ERRCODE = '42501';
  END IF;

  IF v_o.status <> 'completed' THEN
    UPDATE public.orders SET status = 'completed', updated_at = now() WHERE id = v_o.id;
    INSERT INTO public.status_history (order_id, business_id, status, note, created_by)
      VALUES (v_o.id, v_o.business_id, 'completed',
              'Cierre automático por facturación', NEW.created_by);
  END IF;

  -- completed_at se establece UNA sola vez: un replay idempotente que recupera
  -- el mismo comprobante no lo mueve.
  IF v_o.completed_at IS NULL THEN
    UPDATE public.orders SET completed_at = now() WHERE id = v_o.id;
  END IF;

  PERFORM public.recompute_order_payment_status(v_o.id);
  RETURN NEW;
END;
$$;
ALTER FUNCTION "public"."order_complete_on_comprobante"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_order_complete_on_comprobante" ON "public"."comprobantes";
CREATE TRIGGER "trg_order_complete_on_comprobante"
  AFTER INSERT ON "public"."comprobantes"
  FOR EACH ROW EXECUTE FUNCTION "public"."order_complete_on_comprobante"();

-- ── §5. Recompute ante todo evento que mueva el saldo (§6) ──────────────────
-- Un solo helper, disparado desde las tablas que el modelo ya usa como fuente:
--   · comprobante_payments  -> cobro inicial, pago adicional, reemplazo, reversa
--   · comprobantes (UPDATE) -> anulación (estado_comercial='anulado')
-- No se toca ninguna de las 6 RPC financieras: todas escriben estas tablas.
CREATE OR REPLACE FUNCTION "public"."order_status_on_payment_change"() RETURNS "trigger"
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_order_id uuid;
BEGIN
  SELECT c.order_id INTO v_order_id FROM public.comprobantes c
   WHERE c.id = COALESCE(NEW.comprobante_id, OLD.comprobante_id);
  IF v_order_id IS NOT NULL THEN
    PERFORM public.recompute_order_payment_status(v_order_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
ALTER FUNCTION "public"."order_status_on_payment_change"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_order_status_on_payment" ON "public"."comprobante_payments";
-- AFTER: corre DESPUÉS de trig_comprobante_payment_sync, así lee el saldo ya sincronizado.
CREATE TRIGGER "trg_order_status_on_payment"
  AFTER INSERT OR UPDATE OR DELETE ON "public"."comprobante_payments"
  FOR EACH ROW EXECUTE FUNCTION "public"."order_status_on_payment_change"();

CREATE OR REPLACE FUNCTION "public"."order_status_on_comprobante_change"() RETURNS "trigger"
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.order_id IS NULL THEN RETURN NEW; END IF;
  -- Sólo cuando cambió algo que afecta el saldo o la vigencia del documento.
  IF NEW.estado IS DISTINCT FROM OLD.estado
     OR NEW.estado_comercial IS DISTINCT FROM OLD.estado_comercial
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.saldo_pendiente IS DISTINCT FROM OLD.saldo_pendiente
     OR NEW.total_cobrado IS DISTINCT FROM OLD.total_cobrado THEN
    PERFORM public.recompute_order_payment_status(NEW.order_id);
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "public"."order_status_on_comprobante_change"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_order_status_on_comprobante" ON "public"."comprobantes";
CREATE TRIGGER "trg_order_status_on_comprobante"
  AFTER UPDATE ON "public"."comprobantes"
  FOR EACH ROW EXECUTE FUNCTION "public"."order_status_on_comprobante_change"();

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP TRIGGER trg_order_status_on_comprobante ON comprobantes;
--   DROP TRIGGER trg_order_status_on_payment ON comprobante_payments;
--   DROP TRIGGER trg_order_complete_on_comprobante ON comprobantes;
--   DROP FUNCTION order_status_on_comprobante_change();
--   DROP FUNCTION order_status_on_payment_change();
--   DROP FUNCTION order_complete_on_comprobante();
--   DROP FUNCTION recompute_order_payment_status(uuid);
--   DROP VIEW v_order_financial_status;
--   ALTER TABLE orders DROP COLUMN paid_at, DROP COLUMN completed_at;
-- ============================================================================
