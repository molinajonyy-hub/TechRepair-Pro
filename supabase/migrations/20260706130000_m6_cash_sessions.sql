-- ============================================================================
-- M6 (Fase 4) — Apertura y cierre de caja por RPC atómica e idempotente
--
-- ANTES: CajaPage abría con cajas.insert, cerraba con cajas.update y calculaba
-- los esperados/diferencias en el cliente (React). AHORA:
--   open_cash_session_atomic  — abre (anti-doble-abierta vía índice único parcial),
--     idempotente, ownership, fecha AR. No crea movimientos financieros.
--   close_cash_session_atomic — bloquea la caja (FOR UPDATE), recomputa los
--     esperados SERVER-SIDE desde financial_movements (por método, sign correcto,
--     USD nativo), recibe conteos, calcula diferencias, guarda snapshot y cierra.
--     Idempotente. Rechaza doble cierre / caja de otro negocio / caja ya cerrada.
--   + guard: ningún financial_movement puede asociarse a una caja CERRADA.
--
-- Conservador: NO toca cajas históricas, NO recalcula cierres viejos, NO mueve
-- FM entre cajas, NO hace backfill, NO cambia montos/fechas históricas, NO cierra
-- cajas automáticamente, NO debilita RLS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "public"."cash_session_requests" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"     uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "user_id"         uuid,
  "idempotency_key" text NOT NULL,
  "request_hash"    text NOT NULL,
  "op"              text NOT NULL,
  "caja_id"         uuid,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cash_session_requests_key_uniq" UNIQUE ("business_id", "idempotency_key")
);
ALTER TABLE "public"."cash_session_requests" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cash_session_requests' AND policyname='cash_session_req_select') THEN
    CREATE POLICY "cash_session_req_select" ON "public"."cash_session_requests"
      FOR SELECT USING (
        EXISTS (SELECT 1 FROM businesses WHERE id=cash_session_requests.business_id AND owner_user_id=auth.uid())
        OR EXISTS (SELECT 1 FROM profiles WHERE business_id=cash_session_requests.business_id AND user_id=auth.uid())
      );
  END IF;
END $$;
GRANT SELECT ON "public"."cash_session_requests" TO "authenticated";

-- ── Guard: inmutabilidad de caja cerrada (ningún FM entra a una caja cerrada) ──
-- Se extiende el trigger existente trigger_set_movement_caja (BEFORE INSERT en FM):
-- primero asigna la caja abierta si viene null; luego rechaza si la caja resultante
-- está cerrada. No toca datos históricos; sólo bloquea inserts NUEVOS.
CREATE OR REPLACE FUNCTION "public"."trigger_set_movement_caja"() RETURNS "trigger"
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.caja_id IS NULL AND NEW.business_id IS NOT NULL THEN
    SELECT id INTO NEW.caja_id
    FROM public.cajas
    WHERE business_id = NEW.business_id AND status = 'abierta'
    ORDER BY opened_at DESC LIMIT 1;
  END IF;
  IF NEW.caja_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.cajas WHERE id = NEW.caja_id AND status = 'cerrada') THEN
    RAISE EXCEPTION 'No se pueden registrar movimientos en una caja cerrada';
  END IF;
  RETURN NEW;
END;
$$;

-- ── open_cash_session_atomic ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."open_cash_session_atomic"(
  p_business_id uuid, p_user_id uuid,
  p_efectivo numeric, p_transferencia numeric, p_tarjeta numeric, p_usd numeric,
  p_usd_rate numeric DEFAULT NULL, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_user uuid := auth.uid();
  v_access boolean := false;
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash text;
  v_existing cash_session_requests%ROWTYPE;
  v_req uuid;
  v_caja uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))) INTO v_access;
  IF NOT v_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio'); END IF;

  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(
      'open§'||p_business_id::text||'§'||round(COALESCE(p_efectivo,0),2)::text||'§'||round(COALESCE(p_transferencia,0),2)::text||'§'||
      round(COALESCE(p_tarjeta,0),2)::text||'§'||round(COALESCE(p_usd,0),2)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM cash_session_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
      END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'caja_id', v_existing.caja_id);
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM cajas WHERE business_id=p_business_id AND status='abierta') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Ya hay una caja abierta');
  END IF;

  IF v_key IS NOT NULL THEN
    INSERT INTO cash_session_requests (business_id, user_id, idempotency_key, request_hash, op)
      VALUES (p_business_id, v_user, v_key, v_hash, 'open') RETURNING id INTO v_req;
  END IF;

  BEGIN
    INSERT INTO cajas (business_id, efectivo_inicial, transferencia_inicial, tarjeta_inicial, usd_inicial,
      usd_cotizacion_apertura, opened_by, status)
      VALUES (p_business_id, COALESCE(p_efectivo,0), COALESCE(p_transferencia,0), COALESCE(p_tarjeta,0),
        COALESCE(p_usd,0), COALESCE(p_usd_rate,1), p_user_id, 'abierta') RETURNING id INTO v_caja;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Ya hay una caja abierta');
  END;

  IF v_key IS NOT NULL THEN UPDATE cash_session_requests SET caja_id=v_caja WHERE id=v_req; END IF;
  RETURN jsonb_build_object('ok', true, 'replay', false, 'caja_id', v_caja);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ── close_cash_session_atomic ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."close_cash_session_atomic"(
  p_business_id uuid, p_user_id uuid, p_caja_id uuid,
  p_count_efectivo numeric, p_count_transferencia numeric, p_count_tarjeta numeric, p_count_usd numeric,
  p_usd_rate numeric DEFAULT NULL, p_notes text DEFAULT NULL, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_user uuid := auth.uid();
  v_access boolean := false;
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash text;
  v_existing cash_session_requests%ROWTYPE;
  v_req uuid;
  v_caja cajas%ROWTYPE;
  v_exp_ef numeric; v_exp_tr numeric; v_exp_ta numeric; v_exp_usd numeric;
  v_cnt_ef numeric; v_cnt_tr numeric; v_cnt_ta numeric; v_cnt_usd numeric;
  v_diff_ef numeric; v_diff_tr numeric; v_diff_ta numeric; v_diff_usd numeric;
  v_rate numeric; v_total_diff numeric;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'No autenticado'); END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))) INTO v_access;
  IF NOT v_access THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio'); END IF;

  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(
      'close§'||p_business_id::text||'§'||p_caja_id::text||'§'||round(COALESCE(p_count_efectivo,-1),2)::text||'§'||
      round(COALESCE(p_count_transferencia,-1),2)::text||'§'||round(COALESCE(p_count_tarjeta,-1),2)::text||'§'||
      round(COALESCE(p_count_usd,-1),2)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM cash_session_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
      END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'caja_id', p_caja_id);
    END IF;
  END IF;

  SELECT * INTO v_caja FROM cajas WHERE id=p_caja_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'Caja inexistente'); END IF;
  IF v_caja.status <> 'abierta' THEN RETURN jsonb_build_object('ok', false, 'error', 'La caja ya está cerrada'); END IF;

  -- Esperados server-side desde financial_movements (sign por type; USD nativo).
  v_exp_ef := COALESCE(v_caja.efectivo_inicial,0) + COALESCE((SELECT SUM(CASE WHEN type='income' THEN amount_ars ELSE -amount_ars END)
    FROM financial_movements WHERE caja_id=p_caja_id AND COALESCE(metodo_pago,'efectivo')='efectivo'),0);
  v_exp_tr := COALESCE(v_caja.transferencia_inicial,0) + COALESCE((SELECT SUM(CASE WHEN type='income' THEN amount_ars ELSE -amount_ars END)
    FROM financial_movements WHERE caja_id=p_caja_id AND metodo_pago='transferencia'),0);
  v_exp_ta := COALESCE(v_caja.tarjeta_inicial,0) + COALESCE((SELECT SUM(CASE WHEN type='income' THEN amount_ars ELSE -amount_ars END)
    FROM financial_movements WHERE caja_id=p_caja_id AND metodo_pago='tarjeta'),0);
  v_exp_usd := COALESCE(v_caja.usd_inicial,0) + COALESCE((SELECT SUM(CASE WHEN type='income' THEN amount ELSE -amount END)
    FROM financial_movements WHERE caja_id=p_caja_id AND metodo_pago='usd'),0);

  -- Conteos declarados; si NULL, usar el esperado (diferencia 0).
  v_cnt_ef  := COALESCE(p_count_efectivo,      v_exp_ef);
  v_cnt_tr  := COALESCE(p_count_transferencia, v_exp_tr);
  v_cnt_ta  := COALESCE(p_count_tarjeta,       v_exp_ta);
  v_cnt_usd := COALESCE(p_count_usd,           v_exp_usd);

  v_diff_ef := v_cnt_ef - v_exp_ef;
  v_diff_tr := v_cnt_tr - v_exp_tr;
  v_diff_ta := v_cnt_ta - v_exp_ta;
  v_diff_usd := v_cnt_usd - v_exp_usd;
  v_rate := COALESCE(p_usd_rate, v_caja.usd_cotizacion_apertura, 1);
  v_total_diff := v_diff_ef + v_diff_tr + v_diff_ta + (v_diff_usd * v_rate);

  UPDATE cajas SET
    status='cerrada', closed_at=now(), closed_by=p_user_id,
    efectivo_cierre = v_cnt_ef, transferencia_cierre = v_cnt_tr, tarjeta_cierre = v_cnt_ta, usd_cierre = v_cnt_usd,
    notas = COALESCE(NULLIF(btrim(p_notes),''), notas),
    difference = v_total_diff
  WHERE id=p_caja_id;

  IF v_key IS NOT NULL THEN
    INSERT INTO cash_session_requests (business_id, user_id, idempotency_key, request_hash, op, caja_id)
      VALUES (p_business_id, v_user, v_key, v_hash, 'close', p_caja_id);
  END IF;

  RETURN jsonb_build_object('ok', true, 'replay', false, 'caja_id', p_caja_id,
    'expected', jsonb_build_object('efectivo', v_exp_ef, 'transferencia', v_exp_tr, 'tarjeta', v_exp_ta, 'usd', v_exp_usd),
    'counted',  jsonb_build_object('efectivo', v_cnt_ef, 'transferencia', v_cnt_tr, 'tarjeta', v_cnt_ta, 'usd', v_cnt_usd),
    'differences', jsonb_build_object('efectivo', v_diff_ef, 'transferencia', v_diff_tr, 'tarjeta', v_diff_ta, 'usd', v_diff_usd),
    'total_difference', v_total_diff);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

ALTER FUNCTION "public"."open_cash_session_atomic"(uuid,uuid,numeric,numeric,numeric,numeric,numeric,text) OWNER TO "postgres";
ALTER FUNCTION "public"."close_cash_session_atomic"(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,text,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."open_cash_session_atomic"(uuid,uuid,numeric,numeric,numeric,numeric,numeric,text) FROM PUBLIC, "anon";
REVOKE ALL ON FUNCTION "public"."close_cash_session_atomic"(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,text,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."open_cash_session_atomic"(uuid,uuid,numeric,numeric,numeric,numeric,numeric,text) TO "authenticated","service_role";
GRANT EXECUTE ON FUNCTION "public"."close_cash_session_atomic"(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,text,text) TO "authenticated","service_role";

-- ROLLBACK: DROP las 2 funciones + DROP TABLE cash_session_requests + restaurar
-- trigger_set_movement_caja sin el guard de caja cerrada.
