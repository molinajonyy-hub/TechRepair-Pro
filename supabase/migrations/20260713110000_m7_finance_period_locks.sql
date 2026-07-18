-- ============================================================================
-- M7 (Bloque 1b) — finance_period_locks: cierre/reapertura e inmutabilidad
--
-- Cierra la etapa "una sola puerta": un período (mes AR) cerrado no puede recibir
-- operaciones económicas retroactivas. Los hechos posteriores (anulaciones,
-- reversas) NO se bloquean: ya se registran con ar_today() → caen en el período
-- ABIERTO como asientos compensatorios (comportamiento M6 intacto).
--
-- Piezas:
--   finance_period_bounds(date)         — límites del mes AR que contiene la fecha
--   finance_period_locks (tabla)        — un registro por (negocio, mes)
--   is_period_closed(business, date)    — lectura barata para health check / UI
--   assert_period_open(business, date)  — GUARD: RAISE 'PERIOD_CLOSED' si aplica
--   close_period / reopen_period (RPC)  — SECURITY DEFINER, auditadas
--
-- El guard se INTEGRA en las RPC económicas en el Bloque 6 (recién ahí se activa
-- el rechazo). Acá sólo se define; sin integrar no cambia ningún flujo vivo.
--
-- Timezone: América/Argentina/Córdoba (vía ar_today() y fechas económicas ya en
-- fecha AR). Aditiva y reversible.
-- ============================================================================

-- ── Límites de mes AR (IMMUTABLE: sólo aritmética de fechas) ────────────────
CREATE OR REPLACE FUNCTION "public"."finance_period_bounds"(p_date date)
  RETURNS TABLE (period_start date, period_end date)
  LANGUAGE sql IMMUTABLE AS $$
  SELECT date_trunc('month', p_date)::date,
         (date_trunc('month', p_date) + interval '1 month - 1 day')::date
$$;
ALTER FUNCTION "public"."finance_period_bounds"(date) OWNER TO "postgres";
-- Helper interno: NO expuesto al frontend (la UI lee la tabla finance_period_locks).
REVOKE ALL ON FUNCTION "public"."finance_period_bounds"(date) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."finance_period_bounds"(date) TO "service_role";

-- ── Clave de lock determinística por (negocio, período) ─────────────────────
-- bigint estable para pg_advisory_xact_lock. IMMUTABLE: sólo hashing puro.
CREATE OR REPLACE FUNCTION "public"."finance_period_lock_key"(p_business_id uuid, p_period_start date)
  RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended(p_business_id::text || ':' || p_period_start::text, 42)
$$;
ALTER FUNCTION "public"."finance_period_lock_key"(uuid, date) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."finance_period_lock_key"(uuid, date) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."finance_period_lock_key"(uuid, date) TO "service_role";

-- ── Tabla de locks ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."finance_period_locks" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"    uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "period_start"   date NOT NULL,
  "period_end"     date NOT NULL,
  "status"         text NOT NULL DEFAULT 'closed' CHECK ("status" IN ('closed','reopened')),
  "closed_at"      timestamptz,
  "closed_by"      uuid,
  "close_reason"   text,
  "reopened_at"    timestamptz,
  "reopened_by"    uuid,
  "reopen_reason"  text,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  -- Un solo registro por negocio y período; períodos mensuales alineados al mes AR.
  CONSTRAINT "finance_period_locks_biz_period_uniq" UNIQUE ("business_id", "period_start"),
  CONSTRAINT "finance_period_locks_month_aligned" CHECK (
    period_start = date_trunc('month', period_start)::date
    AND period_end = (date_trunc('month', period_start) + interval '1 month - 1 day')::date
  )
);

CREATE INDEX IF NOT EXISTS "idx_finance_period_locks_lookup"
  ON "public"."finance_period_locks" ("business_id", "period_start", "status");

COMMENT ON TABLE "public"."finance_period_locks" IS
  'Cierre contable por período (M7). status=closed bloquea operaciones cuya fecha '
  'económica cae en [period_start, period_end]. reopened = cerrado y luego reabierto '
  '(excepcional, sólo owner, con motivo). Escritura sólo por RPC SECURITY DEFINER.';

ALTER TABLE "public"."finance_period_locks" ENABLE ROW LEVEL SECURITY;

-- Lectura: miembros del negocio (staff incluido — la UI muestra el estado del
-- período). Escritura: NINGUNA policy → sólo las RPC SECURITY DEFINER.
DROP POLICY IF EXISTS "finance_period_locks_select" ON "public"."finance_period_locks";
CREATE POLICY "finance_period_locks_select" ON "public"."finance_period_locks"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM businesses WHERE id = finance_period_locks.business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = finance_period_locks.business_id
               AND user_id = auth.uid() AND COALESCE(is_active,true))
  );

REVOKE ALL ON "public"."finance_period_locks" FROM PUBLIC, "anon";
GRANT SELECT ON "public"."finance_period_locks" TO "authenticated";
GRANT ALL ON "public"."finance_period_locks" TO "service_role";

-- ── is_period_closed: lectura barata (STABLE, sin lock) ─────────────────────
-- Interno: NO expuesto al frontend. La UI lee la tabla finance_period_locks
-- (SELECT + RLS). Sin advisory lock: es sólo lectura informativa (no un guard).
CREATE OR REPLACE FUNCTION "public"."is_period_closed"(p_business_id uuid, p_date date)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM finance_period_locks
    WHERE business_id = p_business_id
      AND status = 'closed'
      AND p_date BETWEEN period_start AND period_end
  )
$$;
ALTER FUNCTION "public"."is_period_closed"(uuid, date) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."is_period_closed"(uuid, date) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."is_period_closed"(uuid, date) TO "service_role";

-- ── assert_period_open: GUARD central (fail-closed + advisory xact lock) ─────
-- VOLATILE (no STABLE): toma pg_advisory_xact_lock → tiene efecto colateral y no
-- debe cachearse ni evaluarse fuera de orden. El lock, compartido con close_period
-- y reopen_period por finance_period_lock_key(business, period_start), serializa el
-- guard contra el cierre: o la operación termina antes del cierre, o espera y es
-- rechazada; nunca confirma un asiento retroactivo después de cerrado.
-- FAIL-CLOSED: business_id o fecha NULL → error estable INVALID_FINANCE_CONTEXT
-- (nunca permitir por falta de contexto). Las RPC normalizan la fecha con
-- COALESCE(param, ar_today()) ANTES de llamar.
CREATE OR REPLACE FUNCTION "public"."assert_period_open"(p_business_id uuid, p_economic_date date)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_period_start date;
  v_lock finance_period_locks%ROWTYPE;
BEGIN
  IF p_business_id IS NULL OR p_economic_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_FINANCE_CONTEXT: falta % para validar el período',
      CASE WHEN p_business_id IS NULL THEN 'business_id' ELSE 'fecha económica' END
      USING ERRCODE = 'P0001';
  END IF;

  v_period_start := date_trunc('month', p_economic_date)::date;
  -- Serializa con close_period/reopen_period sobre el MISMO período.
  PERFORM pg_advisory_xact_lock(public.finance_period_lock_key(p_business_id, v_period_start));

  SELECT * INTO v_lock FROM finance_period_locks
    WHERE business_id = p_business_id
      AND status = 'closed'
      AND p_economic_date BETWEEN period_start AND period_end
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: el período % (%.. %) está cerrado; registrá la operación en el período abierto o pedí una reapertura.',
      to_char(v_lock.period_start,'YYYY-MM'), v_lock.period_start, v_lock.period_end
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;
ALTER FUNCTION "public"."assert_period_open"(uuid, date) OWNER TO "postgres";
-- Interno: sólo lo invocan RPC/triggers SECURITY DEFINER (owner postgres). NO expuesto
-- al frontend (evita que un cliente tome locks o sondee estados de período).
REVOKE ALL ON FUNCTION "public"."assert_period_open"(uuid, date) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."assert_period_open"(uuid, date) TO "service_role";

-- ── close_period: cierre idempotente ────────────────────────────────────────
-- Autorización: owner o admin activo. No permite cerrar el mes en curso hasta que
-- termine (evitaría registrar ventas del propio día). Idempotente: re-cerrar un
-- período ya cerrado devuelve replay sin error ni doble auditoría.
CREATE OR REPLACE FUNCTION "public"."close_period"(
  p_business_id uuid, p_period_start date, p_reason text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_authorized boolean := false;
  v_start date := date_trunc('month', p_period_start)::date;
  v_end   date := (date_trunc('month', p_period_start) + interval '1 month - 1 day')::date;
  v_cur_start date := date_trunc('month', public.ar_today())::date;
  v_lock finance_period_locks%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  IF p_period_start IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Período requerido'); END IF;

  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user
                  AND COALESCE(is_active,true) AND role IN ('owner','admin'))) INTO v_authorized;
  IF NOT v_authorized THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin permiso para cerrar períodos en este negocio'); END IF;

  -- Sólo se cierran meses COMPLETAMENTE terminados según America/Argentina/Cordoba.
  -- v_cur_start = primer día del mes AR en curso. Se rechaza el mes en curso y todo
  -- mes futuro (v_start >= v_cur_start cubre ambos).
  IF v_start >= v_cur_start THEN
    RETURN jsonb_build_object('ok', false, 'error',
      CASE WHEN v_start = v_cur_start THEN 'No se puede cerrar el mes en curso (aún no terminó)'
           ELSE 'No se puede cerrar un mes futuro' END);
  END IF;

  -- Serializa con assert_period_open/reopen_period sobre el MISMO período.
  PERFORM pg_advisory_xact_lock(public.finance_period_lock_key(p_business_id, v_start));

  SELECT * INTO v_lock FROM finance_period_locks
    WHERE business_id=p_business_id AND period_start=v_start FOR UPDATE;

  IF FOUND AND v_lock.status='closed' THEN
    RETURN jsonb_build_object('ok', true, 'replay', true, 'period_lock_id', v_lock.id,
      'period_start', v_start, 'period_end', v_end, 'status', 'closed');
  END IF;

  IF FOUND THEN
    -- Estaba 'reopened' → segundo cierre.
    UPDATE finance_period_locks SET
      status='closed', closed_at=now(), closed_by=v_user,
      close_reason=NULLIF(btrim(p_reason),''), updated_at=now()
    WHERE id=v_lock.id RETURNING id INTO v_id;
  ELSE
    INSERT INTO finance_period_locks (business_id, period_start, period_end, status, closed_at, closed_by, close_reason)
      VALUES (p_business_id, v_start, v_end, 'closed', now(), v_user, NULLIF(btrim(p_reason),''))
      RETURNING id INTO v_id;
  END IF;

  PERFORM finance_log_audit(
    p_business_id, 'period_close', 'finance_period_locks', v_id, 'close_period',
    NULL, NULLIF(btrim(p_reason),''), v_start, 'finance_period', v_id,
    NULL, jsonb_build_object('period_start', v_start, 'period_end', v_end, 'status', 'closed')
  );

  RETURN jsonb_build_object('ok', true, 'replay', false, 'period_lock_id', v_id,
    'period_start', v_start, 'period_end', v_end, 'status', 'closed');
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;
ALTER FUNCTION "public"."close_period"(uuid, date, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."close_period"(uuid, date, text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."close_period"(uuid, date, text) TO "authenticated","service_role";

-- ── reopen_period: reapertura excepcional (SÓLO owner, motivo obligatorio) ───
CREATE OR REPLACE FUNCTION "public"."reopen_period"(
  p_business_id uuid, p_period_start date, p_reason text
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_is_owner boolean := false;
  v_reason text := NULLIF(btrim(COALESCE(p_reason,'')), '');
  v_start date := date_trunc('month', p_period_start)::date;
  v_lock finance_period_locks%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  IF v_reason IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'El motivo de la reapertura es obligatorio'); END IF;

  -- Reapertura: EXCLUSIVA del dueño real del negocio (más restrictivo que cierre).
  SELECT EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user) INTO v_is_owner;
  IF NOT v_is_owner THEN RETURN jsonb_build_object('ok', false, 'error', 'Sólo el dueño del negocio puede reabrir un período'); END IF;

  -- Serializa con assert_period_open/close_period sobre el MISMO período.
  PERFORM pg_advisory_xact_lock(public.finance_period_lock_key(p_business_id, v_start));

  SELECT * INTO v_lock FROM finance_period_locks
    WHERE business_id=p_business_id AND period_start=v_start FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'El período no está cerrado'); END IF;
  IF v_lock.status <> 'closed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El período ya está reabierto');
  END IF;

  -- Orden cronológico inverso: no se puede reabrir un período si existe uno
  -- POSTERIOR aún cerrado (habría que reabrir primero el más reciente). Evita
  -- huecos incoherentes en la línea de cierres.
  IF EXISTS (SELECT 1 FROM finance_period_locks
             WHERE business_id=p_business_id AND status='closed' AND period_start > v_start) THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'Reabrí primero los períodos posteriores que siguen cerrados (orden cronológico inverso)');
  END IF;

  UPDATE finance_period_locks SET
    status='reopened', reopened_at=now(), reopened_by=v_user, reopen_reason=v_reason, updated_at=now()
  WHERE id=v_lock.id;

  PERFORM finance_log_audit(
    p_business_id, 'period_reopen', 'finance_period_locks', v_lock.id, 'reopen_period',
    NULL, v_reason, v_start, 'finance_period', v_lock.id,
    jsonb_build_object('status','closed'), jsonb_build_object('status','reopened')
  );

  RETURN jsonb_build_object('ok', true, 'period_lock_id', v_lock.id,
    'period_start', v_start, 'status', 'reopened');
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;
ALTER FUNCTION "public"."reopen_period"(uuid, date, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."reopen_period"(uuid, date, text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."reopen_period"(uuid, date, text) TO "authenticated","service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP FUNCTION IF EXISTS reopen_period(uuid,date,text);
--   DROP FUNCTION IF EXISTS close_period(uuid,date,text);
--   DROP FUNCTION IF EXISTS assert_period_open(uuid,date);
--   DROP FUNCTION IF EXISTS is_period_closed(uuid,date);
--   DROP TABLE IF EXISTS finance_period_locks;
--   DROP FUNCTION IF EXISTS finance_period_bounds(date);
-- ============================================================================
