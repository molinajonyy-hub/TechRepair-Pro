-- ============================================================================
-- P0-ARCA-B — ROLLBACK de 20260926120000_p0_arca_presend_claim_recovery.sql
--
-- ORDEN (inverso al despliegue, sin ventana insegura):
--   1. Con el build de afip-cae de P0-ARCA-B (ciclo de vida del claim) TODAVÍA
--      activo, correr este script. Ese build tolera que
--      release_arca_presend_claim no exista (su helper devuelve false y lo loguea;
--      la emisión no depende de esa RPC) y sigue sin enviar nunca sin reserva
--      confirmada, así que ese build + semántica vieja del claim es un estado seguro.
--   2. Verificar: claim_comprobante_arca_emission idéntica a la definición previa
--      y la RPC de liberación eliminada.
--   3. Recién entonces, si hace falta, volver a desplegar el afip-cae previo a
--      P0-ARCA-B (el de `main` antes del merge de este PR; al 2026-09-11 es la
--      versión que dejó P0 EDGE CORS #126). Usar números de versión reales del
--      proyecto, no los de este comentario.
-- NUNCA dejar el afip-cae previo activo mientras la recuperación entre
-- comprobantes de la migración siga vigente: ignora una reserva fallida y podría
-- enviar con un claim recuperado por otro comprobante.
--
-- Efecto: claim_comprobante_arca_emission vuelve EXACTAMENTE a la definición de
-- producción previa (sin recuperación entre comprobantes) y se elimina la RPC de
-- liberación. No toca filas: los intentos ya marcados 'abandoned' quedan así
-- (append-only de hecho; nunca enviaron nada).
-- ============================================================================
BEGIN;

REVOKE ALL ON FUNCTION public.release_arca_presend_claim(uuid, text) FROM service_role;
DROP FUNCTION IF EXISTS public.release_arca_presend_claim(uuid, text);

CREATE OR REPLACE FUNCTION public.claim_comprobante_arca_emission(p_comprobante_id uuid, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_comp             comprobantes%ROWTYPE;
  v_has_access       boolean := false;
  v_tipo_comprobante integer;
  v_cuit_raw         text;
  v_cuit             text;
  v_punto_venta      integer;
  v_ambiente         text;
  v_own_pending      arca_emission_attempts%ROWTYPE;
  v_existing_mine    arca_emission_attempts%ROWTYPE;
  v_existing_serie   arca_emission_attempts%ROWTYPE;
  v_attempt_id       uuid;
BEGIN
  SELECT * INTO v_comp FROM comprobantes WHERE id = p_comprobante_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = v_comp.business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = v_comp.business_id AND user_id = auth.uid())
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
    FROM arca_config WHERE business_id = v_comp.business_id;
  IF NOT FOUND OR v_cuit_raw IS NULL OR v_punto_venta IS NULL THEN
    RETURN jsonb_build_object('result', 'not_eligible', 'reason', 'arca_config_incompleta');
  END IF;
  v_cuit := regexp_replace(v_cuit_raw, '\D', '', 'g');
  v_ambiente := COALESCE(v_ambiente, 'homologacion');

  SELECT * INTO v_own_pending FROM arca_emission_attempts
    WHERE comprobante_id = p_comprobante_id AND status = 'pending_reconciliation'
    ORDER BY started_at DESC LIMIT 1;

  IF FOUND THEN
    UPDATE arca_emission_attempts
      SET status = 'claimed', correlation_id = p_correlation_id, updated_at = now()
      WHERE id = v_own_pending.id AND status = 'pending_reconciliation';
    IF FOUND THEN
      RETURN jsonb_build_object('result', 'acquired', 'attempt_id', v_own_pending.id, 'reconciliation_pending', true);
    END IF;
  END IF;

  BEGIN
    INSERT INTO arca_emission_attempts (
      comprobante_id, business_id, correlation_id,
      ambiente, cuit_emisor, punto_venta, tipo_comprobante, status
    ) VALUES (
      p_comprobante_id, v_comp.business_id, p_correlation_id,
      v_ambiente, v_cuit, v_punto_venta, v_tipo_comprobante, 'claimed'
    ) RETURNING id INTO v_attempt_id;

    RETURN jsonb_build_object('result', 'acquired', 'attempt_id', v_attempt_id);
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing_mine FROM arca_emission_attempts
      WHERE comprobante_id = p_comprobante_id AND status IN ('claimed', 'number_reserved', 'sent')
      ORDER BY started_at DESC LIMIT 1;

    IF FOUND THEN
      IF v_existing_mine.status = 'claimed' AND v_existing_mine.started_at < now() - INTERVAL '2 minutes' THEN
        UPDATE arca_emission_attempts
          SET status = 'abandoned', completed_at = now(), updated_at = now()
          WHERE id = v_existing_mine.id AND status = 'claimed';

        BEGIN
          INSERT INTO arca_emission_attempts (
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

    SELECT * INTO v_existing_serie FROM arca_emission_attempts
      WHERE ambiente = v_ambiente AND cuit_emisor = v_cuit
        AND punto_venta = v_punto_venta AND tipo_comprobante = v_tipo_comprobante
        AND status IN ('claimed', 'number_reserved', 'sent', 'pending_reconciliation')
        AND comprobante_id <> p_comprobante_id
      ORDER BY started_at DESC LIMIT 1;

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

COMMIT;
