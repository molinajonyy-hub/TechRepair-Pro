-- ============================================================================
-- P0-ARCA-B (2026-09-10) — un claim que falla ANTES de reservar número no puede
-- ocupar la serie fiscal para siempre.
--
-- Incidente: el intento aae5d9d1 quedó 'claimed' desde 2026-09-01 porque afip-cae
-- devolvió 502 en WSAA sin cerrarlo, y claim_comprobante_arca_emission sólo
-- recuperaba claims viejos del MISMO comprobante. idx_arca_attempt_one_live_per_serie
-- bloqueó la serie para todo otro comprobante (serie_ocupada) durante 9 días.
--
-- Invariante: el flujo es claim → WSAA → último autorizado → reserve_arca_number
-- (claimed → number_reserved) → mark_arca_attempt_sent → FECAESolicitar. Un
-- intento 'claimed' con numero_intentado NULL y sent_at NULL nunca envió nada.
-- Sólo ESE estado se libera o recupera. number_reserved, sent y
-- pending_reconciliation NUNCA se liberan acá.
--
-- 1. release_arca_presend_claim: afip-cae libera su propio claim si falla antes
--    de reservar. Sólo service_role.
-- 2. claim_comprobante_arca_emission: si la serie está ocupada por un claim ajeno
--    pre-envío con más de 10 minutos (por encima de la vida máxima de una
--    invocación Edge), lo recupera y reintenta el INSERT una vez. El resto de la
--    lógica es idéntica a la definición de producción; sólo se endurece el
--    search_path (pg_catalog, pg_temp) y se califican las referencias, como el
--    resto de las SECURITY DEFINER del proyecto.
--
-- Cinturón adicional (en afip-cae): nunca se envía sin reserva confirmada, así que
-- una invocación rezagada cuyo claim fue recuperado no puede llegar a ARCA:
-- reserve_arca_number exige status = 'claimed'.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.release_arca_presend_claim(p_attempt_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_attempt_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_attempt');
  END IF;

  UPDATE public.arca_emission_attempts
     SET status        = 'abandoned',
         completed_at  = now(),
         updated_at    = now(),
         error_mensaje = left('pre-send claim released: ' || COALESCE(NULLIF(btrim(p_reason), ''), 'unspecified'), 300)
   WHERE id = p_attempt_id
     AND status = 'claimed'
     AND numero_intentado IS NULL
     AND sent_at IS NULL
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'released', v_id IS NOT NULL);
END;
$$;

ALTER FUNCTION public.release_arca_presend_claim(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.release_arca_presend_claim(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_arca_presend_claim(uuid, text) TO service_role;
COMMENT ON FUNCTION public.release_arca_presend_claim(uuid, text) IS
  'P0-ARCA-B: libera un claim de emisión que nunca envió nada (claimed, sin número, sin sent_at). '
  'Sólo service_role (afip-cae). No toca number_reserved, sent ni pending_reconciliation.';

CREATE OR REPLACE FUNCTION public.claim_comprobante_arca_emission(p_comprobante_id uuid, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_comp             public.comprobantes%ROWTYPE;
  v_has_access       boolean := false;
  v_tipo_comprobante integer;
  v_cuit_raw         text;
  v_cuit             text;
  v_punto_venta      integer;
  v_ambiente         text;
  v_own_pending      public.arca_emission_attempts%ROWTYPE;
  v_existing_mine    public.arca_emission_attempts%ROWTYPE;
  v_existing_serie   public.arca_emission_attempts%ROWTYPE;
  v_attempt_id       uuid;
BEGIN
  SELECT * INTO v_comp FROM public.comprobantes WHERE id = p_comprobante_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  SELECT (
    EXISTS (SELECT 1 FROM public.businesses WHERE id = v_comp.business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.profiles WHERE business_id = v_comp.business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  IF v_comp.cae IS NOT NULL OR v_comp.estado_fiscal = 'emitido' THEN
    RETURN jsonb_build_object('result', 'already_authorized', 'cae', v_comp.cae);
  END IF;

  IF v_comp.estado = 'anulado' OR v_comp.status = 'cancelled' THEN
    RETURN jsonb_build_object('result', 'not_eligible', 'reason', 'anulado');
  END IF;

  v_tipo_comprobante := NULLIF(v_comp.tipo_comprobante_fiscal, '')::integer;
  IF v_tipo_comprobante IS NULL THEN
    v_tipo_comprobante := CASE v_comp.tipo
      WHEN 'factura_a' THEN 1
      WHEN 'factura_c' THEN 11
      ELSE NULL
    END;
  END IF;
  IF v_tipo_comprobante IS NULL THEN
    RETURN jsonb_build_object('result', 'not_eligible', 'reason', 'tipo_comprobante_no_determinable');
  END IF;

  SELECT cuit_emisor, punto_venta, ambiente INTO v_cuit_raw, v_punto_venta, v_ambiente
    FROM public.arca_config WHERE business_id = v_comp.business_id;
  IF NOT FOUND OR v_cuit_raw IS NULL OR v_punto_venta IS NULL THEN
    RETURN jsonb_build_object('result', 'not_eligible', 'reason', 'arca_config_incompleta');
  END IF;
  v_cuit := regexp_replace(v_cuit_raw, '\D', '', 'g');
  v_ambiente := COALESCE(v_ambiente, 'homologacion');

  SELECT * INTO v_own_pending FROM public.arca_emission_attempts
    WHERE comprobante_id = p_comprobante_id AND status = 'pending_reconciliation'
    ORDER BY started_at DESC LIMIT 1;

  IF FOUND THEN
    UPDATE public.arca_emission_attempts
      SET status = 'claimed', correlation_id = p_correlation_id, updated_at = now()
      WHERE id = v_own_pending.id AND status = 'pending_reconciliation';
    IF FOUND THEN
      RETURN jsonb_build_object('result', 'acquired', 'attempt_id', v_own_pending.id, 'reconciliation_pending', true);
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.arca_emission_attempts (
      comprobante_id, business_id, correlation_id,
      ambiente, cuit_emisor, punto_venta, tipo_comprobante, status
    ) VALUES (
      p_comprobante_id, v_comp.business_id, p_correlation_id,
      v_ambiente, v_cuit, v_punto_venta, v_tipo_comprobante, 'claimed'
    ) RETURNING id INTO v_attempt_id;

    RETURN jsonb_build_object('result', 'acquired', 'attempt_id', v_attempt_id);
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing_mine FROM public.arca_emission_attempts
      WHERE comprobante_id = p_comprobante_id AND status IN ('claimed', 'number_reserved', 'sent')
      ORDER BY started_at DESC LIMIT 1;

    IF FOUND THEN
      IF v_existing_mine.status = 'claimed' AND v_existing_mine.started_at < now() - INTERVAL '2 minutes' THEN
        UPDATE public.arca_emission_attempts
          SET status = 'abandoned', completed_at = now(), updated_at = now()
          WHERE id = v_existing_mine.id AND status = 'claimed';

        BEGIN
          INSERT INTO public.arca_emission_attempts (
            comprobante_id, business_id, correlation_id,
            ambiente, cuit_emisor, punto_venta, tipo_comprobante, status
          ) VALUES (
            p_comprobante_id, v_comp.business_id, p_correlation_id,
            v_ambiente, v_cuit, v_punto_venta, v_tipo_comprobante, 'claimed'
          ) RETURNING id INTO v_attempt_id;

          RETURN jsonb_build_object('result', 'acquired', 'attempt_id', v_attempt_id, 'recovered_abandoned_attempt', true);
        EXCEPTION WHEN unique_violation THEN
          RETURN jsonb_build_object('result', 'already_in_progress');
        END;
      END IF;

      RETURN jsonb_build_object(
        'result', 'already_in_progress',
        'attempt_id', v_existing_mine.id,
        'attempt_status', v_existing_mine.status,
        'sent_at', v_existing_mine.sent_at
      );
    END IF;

    SELECT * INTO v_existing_serie FROM public.arca_emission_attempts
      WHERE ambiente = v_ambiente AND cuit_emisor = v_cuit
        AND punto_venta = v_punto_venta AND tipo_comprobante = v_tipo_comprobante
        AND status IN ('claimed', 'number_reserved', 'sent', 'pending_reconciliation')
        AND comprobante_id <> p_comprobante_id
      ORDER BY started_at DESC LIMIT 1;

    -- P0-ARCA-B: claim ajeno que provablemente nunca salió hacia ARCA (claimed,
    -- sin número, sin sent_at) y lleva más de 10 minutos: se recupera. La misma
    -- guarda va en el WHERE, así que dos recuperaciones concurrentes no pisan un
    -- estado que haya avanzado entre el SELECT y el UPDATE.
    IF FOUND AND v_existing_serie.status = 'claimed'
       AND v_existing_serie.numero_intentado IS NULL AND v_existing_serie.sent_at IS NULL
       AND v_existing_serie.started_at < now() - INTERVAL '10 minutes' THEN
      UPDATE public.arca_emission_attempts
         SET status        = 'abandoned',
             completed_at  = now(),
             updated_at    = now(),
             error_mensaje = left('stale pre-send claim recovered by comprobante ' || p_comprobante_id::text, 300)
       WHERE id = v_existing_serie.id
         AND status = 'claimed'
         AND numero_intentado IS NULL
         AND sent_at IS NULL;

      IF FOUND THEN
        BEGIN
          INSERT INTO public.arca_emission_attempts (
            comprobante_id, business_id, correlation_id,
            ambiente, cuit_emisor, punto_venta, tipo_comprobante, status
          ) VALUES (
            p_comprobante_id, v_comp.business_id, p_correlation_id,
            v_ambiente, v_cuit, v_punto_venta, v_tipo_comprobante, 'claimed'
          ) RETURNING id INTO v_attempt_id;

          RETURN jsonb_build_object(
            'result', 'acquired',
            'attempt_id', v_attempt_id,
            'recovered_stale_serie_claim', true,
            'recovered_attempt_id', v_existing_serie.id
          );
        EXCEPTION WHEN unique_violation THEN
          RETURN jsonb_build_object('result', 'serie_ocupada');
        END;
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'result', 'serie_ocupada',
      'blocking_comprobante_id', v_existing_serie.comprobante_id,
      'blocking_attempt_status', v_existing_serie.status
    );
  END;
END;
$$;

ALTER FUNCTION public.claim_comprobante_arca_emission(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_comprobante_arca_emission(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_comprobante_arca_emission(uuid, text) TO authenticated, service_role;

DO $postconditions$
BEGIN
  IF has_function_privilege('anon', 'public.release_arca_presend_claim(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.release_arca_presend_claim(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P0-ARCA-B: release_arca_presend_claim must be service_role only';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.release_arca_presend_claim(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P0-ARCA-B: service_role cannot execute release_arca_presend_claim';
  END IF;
  IF has_function_privilege('anon', 'public.claim_comprobante_arca_emission(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.claim_comprobante_arca_emission(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P0-ARCA-B: claim_comprobante_arca_emission grants changed';
  END IF;
END;
$postconditions$;

COMMIT;
