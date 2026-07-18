-- ============================================================================
-- M7 (Bloque 2.5, §8) — Guard de período para las superficies de escritura
-- directa E1/E2 (comprobante_payments, account_movements)
--
-- Estas dos tablas conservan INSERT directo desde el cliente (E1: cobro inicial
-- POS; E2: CC manual) — no pasan por una RPC donde integrar assert_period_open.
-- Decisión M7: un trigger BEFORE INSERT valida el período del NUEVO movimiento.
--   - Se valida SIEMPRE la fecha del movimiento nuevo (incluidas compensaciones):
--     una compensación se registra con ar_today() → período abierto → pasa; un
--     asiento retroactivo con fecha en período cerrado → se rechaza.
--   - La fecha se normaliza con COALESCE(NEW.date, ar_today()) para no evadir el
--     guard por fecha nula (sin MUTAR la fila: sólo se valida la fecha efectiva).
--   - Corre ANTES del AFTER INSERT de auditoría (backstop), que se mantiene.
--
-- SECURITY DEFINER (owner postgres): puede invocar assert_period_open, que está
-- revocada para authenticated/anon. Aditiva y reversible (DROP de los triggers).
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."finance_period_guard_biu"() RETURNS "trigger"
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  -- business_id es NOT NULL en ambas tablas; la fecha se normaliza a ar_today()
  -- si viniera nula (el guard es fail-closed ante NULL).
  PERFORM public.assert_period_open(NEW.business_id, COALESCE(NEW.date, public.ar_today()));
  RETURN NEW;
END;
$$;
ALTER FUNCTION "public"."finance_period_guard_biu"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_finance_period_guard_cp" ON "public"."comprobante_payments";
CREATE TRIGGER "trg_finance_period_guard_cp"
  BEFORE INSERT ON "public"."comprobante_payments"
  FOR EACH ROW EXECUTE FUNCTION "public"."finance_period_guard_biu"();

DROP TRIGGER IF EXISTS "trg_finance_period_guard_am" ON "public"."account_movements";
CREATE TRIGGER "trg_finance_period_guard_am"
  BEFORE INSERT ON "public"."account_movements"
  FOR EACH ROW EXECUTE FUNCTION "public"."finance_period_guard_biu"();

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP TRIGGER IF EXISTS trg_finance_period_guard_cp ON comprobante_payments;
--   DROP TRIGGER IF EXISTS trg_finance_period_guard_am ON account_movements;
--   DROP FUNCTION IF EXISTS finance_period_guard_biu();
-- ============================================================================
