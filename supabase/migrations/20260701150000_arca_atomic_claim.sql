-- ============================================================================
-- ARCA — claim atómico de emisión (arca_emission_attempts) + RPCs
--
-- CONTEXTO (auditoría ARCA, fase 3, 2026-07-01):
--   El guard `if (comprobante.cae) return success` en comprobanteService.emitir()
--   evita re-emitir un comprobante YA resuelto, pero no evita que dos llamadas
--   CONCURRENTES (dos pestañas, dos usuarios, doble click, dos invocaciones de
--   la Edge Function) que arrancan con cae=null lleguen ambas a FECAESolicitar
--   al mismo tiempo. Ese guard vive en JS, no es atómico.
--
-- CONTEXTO (fase 4, mismo día — CIERRE DE UN SEGUNDO HUECO):
--   El índice único original (idx_arca_attempt_one_live_per_comprobante) solo
--   bloqueaba dos intentos para el MISMO comprobante_id. Dos comprobantes
--   DISTINTOS de la misma serie fiscal (mismo ambiente + CUIT emisor + punto de
--   venta + tipo de comprobante ARCA) podían reclamar cada uno su propio
--   comprobante_id sin conflicto, consultar FECompUltimoAutorizado en paralelo,
--   calcular el MISMO próximo número, y ambos intentar FECAESolicitar con ese
--   número — el índice por comprobante_id no detecta esto porque nunca hay dos
--   filas con el mismo comprobante_id involucradas.
--
--   Se agrega una SEGUNDA exclusión mutua, por SERIE FISCAL
--   (ambiente, cuit_emisor, punto_venta, tipo_comprobante), que es la identidad
--   real que importa para FECompUltimoAutorizado/FECAESolicitar. Esta identidad
--   se resuelve y valida 100% SERVER-SIDE (arca_config + comprobantes.tipo/
--   tipo_comprobante_fiscal) — el cliente YA NO puede pasar punto_venta/
--   tipo_comprobante/ambiente por parámetro; claim_comprobante_arca_emission
--   los ignora si llegaran y los recalcula desde la DB.
--
--   Ambos índices son índices únicos PARCIALES — el índice ES el lock, no hace
--   falta un advisory lock ni mantener una transacción abierta durante la
--   llamada HTTP a ARCA (esa llamada ocurre completamente FUERA de cualquier
--   transacción SQL, en la Edge Function afip-cae).
--
-- DIVISIÓN DE RESPONSABILIDADES:
--   - claim_comprobante_arca_emission: llamable desde el cliente (authenticated).
--     Ownership vía auth.uid() (nunca confía en business_id/serie por parámetro).
--   - reserve_arca_number / mark_arca_attempt_sent / complete_arca_attempt: SOLO
--     desde afip-cae (service_role) — son las únicas escritoras de campos
--     fiscales terminales en `comprobantes`.
--
-- ESTADOS de arca_emission_attempts.status (documentados en el CHECK y abajo):
--   claimed                 — reclamado, todavía sin número (recuperable tras timeout)
--   number_reserved         — número de FECompUltimoAutorizado+1 ya persistido,
--                             pero AÚN NO se llamó a FECAESolicitar
--   sent                    — FECAESolicitar fue invocado; resultado puede ser ambiguo
--   authorized               — CAE confirmado por respuesta directa
--   authorized_reconciled    — CAE confirmado vía FECompConsultar
--   rejected                 — rechazo fiscal definitivo
--   pending_reconciliation   — ambiguo sin resolver (bloquea la SERIE, no bloquea que
--                             el MISMO comprobante lo retome — ver claim más abajo)
--   abandoned                — claim expirado sin llegar a reservar número
--
-- REUTILIZACIÓN: mismo mecanismo para facturas y notas de crédito — cada una
-- con su propio tipo_comprobante ARCA (a través de tipo_comprobante_fiscal ya
-- resuelto por create_credit_note_from_comprobante, o el mapeo fijo para
-- facturas nuevas), así que cada una respeta su propia serie.
--
-- Nunca se almacenan certificados, private keys, tokens WSAA, sign ni CMS acá.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "public"."arca_emission_attempts" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "comprobante_id"   uuid NOT NULL REFERENCES "public"."comprobantes"("id") ON DELETE CASCADE,
  "business_id"      uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "correlation_id"   text NOT NULL,
  -- Identidad de SERIE fiscal — resuelta y validada server-side, nunca confiada
  -- del cliente. cuit_emisor se guarda normalizado (solo dígitos).
  "ambiente"         text NOT NULL CHECK ("ambiente" IN ('homologacion', 'produccion')),
  "cuit_emisor"      text NOT NULL,
  "punto_venta"      integer NOT NULL,
  "tipo_comprobante" integer NOT NULL,
  -- numero_intentado se llena en reserve_arca_number, después de
  -- FECompUltimoAutorizado — antes de eso no existe todavía.
  "numero_intentado" integer,
  "status" text NOT NULL DEFAULT 'claimed' CHECK ("status" IN (
    'claimed', 'number_reserved', 'sent',
    'authorized', 'authorized_reconciled', 'rejected',
    'pending_reconciliation', 'abandoned'
  )),
  "cae"              text,
  "cae_vencimiento"  timestamptz,
  "resultado"        text,
  "observaciones"    text,
  "error_mensaje"    text,     -- mensaje seguro para UI/logs — nunca XML crudo con credenciales
  "started_at"       timestamptz NOT NULL DEFAULT now(),
  "sent_at"          timestamptz,
  "completed_at"     timestamptz,
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE "public"."arca_emission_attempts" IS
  'Trazabilidad + claim atómico de cada intento de emisión fiscal ARCA (comprobantes '
  'normales y notas de crédito). DOS índices únicos parciales son el mecanismo real '
  'de exclusión mutua: idx_arca_attempt_one_live_per_comprobante (mismo comprobante) '
  'e idx_arca_attempt_one_live_per_serie (misma serie fiscal, comprobantes distintos).';

-- ── Exclusión mutua #1: mismo comprobante_id ────────────────────────────────
-- Como mucho una fila claimed/number_reserved/sent por comprobante_id.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_arca_attempt_one_live_per_comprobante"
  ON "public"."arca_emission_attempts" ("comprobante_id")
  WHERE ("status" IN ('claimed', 'number_reserved', 'sent'));

-- ── Exclusión mutua #2: misma SERIE fiscal (comprobantes DISTINTOS) ─────────
-- Esta es la que cierra la carrera reportada: dos comprobante_id diferentes de
-- la misma serie no pueden tener ambos una fila viva simultáneamente. Incluye
-- pending_reconciliation — un ambiguo sin resolver bloquea la serie completa
-- (otro comprobante NO puede arriesgarse a pedir el mismo próximo número
-- mientras no sepamos si ese número ya fue consumido).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_arca_attempt_one_live_per_serie"
  ON "public"."arca_emission_attempts" ("ambiente", "cuit_emisor", "punto_venta", "tipo_comprobante")
  WHERE ("status" IN ('claimed', 'number_reserved', 'sent', 'pending_reconciliation'));

CREATE INDEX IF NOT EXISTS "idx_arca_attempt_business_started"
  ON "public"."arca_emission_attempts" ("business_id", "started_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_arca_attempt_comprobante"
  ON "public"."arca_emission_attempts" ("comprobante_id", "started_at" DESC);

ALTER TABLE "public"."arca_emission_attempts" ENABLE ROW LEVEL SECURITY;

-- Solo lectura (diagnóstico/UI) para dueños/staff del negocio. Ninguna policy
-- de INSERT/UPDATE/DELETE para authenticated/anon — la única vía de escritura
-- son las funciones SECURITY DEFINER de abajo (o service_role directo).
DROP POLICY IF EXISTS "arca_emission_attempts_select" ON "public"."arca_emission_attempts";
CREATE POLICY "arca_emission_attempts_select" ON "public"."arca_emission_attempts"
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM "public"."businesses" WHERE "id" = "arca_emission_attempts"."business_id" AND "owner_user_id" = auth.uid())
    OR EXISTS (SELECT 1 FROM "public"."profiles" WHERE "business_id" = "arca_emission_attempts"."business_id" AND "user_id" = auth.uid())
  );

REVOKE ALL ON "public"."arca_emission_attempts" FROM PUBLIC;
GRANT SELECT ON "public"."arca_emission_attempts" TO "authenticated";
GRANT ALL ON "public"."arca_emission_attempts" TO "service_role";

-- ============================================================================
-- claim_comprobante_arca_emission — llamable desde el cliente (authenticated).
--
-- Firma SIMPLIFICADA respecto de la versión anterior: YA NO recibe
-- punto_venta/tipo_comprobante/ambiente por parámetro. Toda la identidad de
-- serie se resuelve server-side:
--   - ambiente/cuit/punto_venta      → arca_config del business_id del comprobante
--   - tipo_comprobante (código ARCA) → comprobantes.tipo_comprobante_fiscal si ya
--                                       está seteado (caso Nota de Crédito, que
--                                       create_credit_note_from_comprobante ya
--                                       resuelve a 3/8/13 según la factura original),
--                                       si no, mapeo fijo factura_a→1, factura_c→11.
-- Ownership vía auth.uid() (nunca confía en un business_id pasado por parámetro,
-- mismo patrón que create_credit_note_from_comprobante).
-- ============================================================================
CREATE OR REPLACE FUNCTION "public"."claim_comprobante_arca_emission"(
  "p_comprobante_id" uuid,
  "p_correlation_id" text
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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
    -- No revelar existencia del comprobante a quien no tiene acceso al negocio.
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  IF v_comp.cae IS NOT NULL OR v_comp.estado_fiscal = 'emitido' THEN
    RETURN jsonb_build_object('result', 'already_authorized', 'cae', v_comp.cae);
  END IF;

  IF v_comp.estado = 'anulado' OR v_comp.status = 'cancelled' THEN
    RETURN jsonb_build_object('result', 'not_eligible', 'reason', 'anulado');
  END IF;

  -- ── Resolver identidad de serie SERVER-SIDE ────────────────────────────────
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

  -- cuit_emisor es la columna NOT NULL/confiable de arca_config (existe además
  -- `cuit`, nullable — no se usa acá para no depender de un campo que puede
  -- faltar en filas viejas).
  SELECT cuit_emisor, punto_venta, ambiente INTO v_cuit_raw, v_punto_venta, v_ambiente
    FROM arca_config WHERE business_id = v_comp.business_id;
  IF NOT FOUND OR v_cuit_raw IS NULL OR v_punto_venta IS NULL THEN
    RETURN jsonb_build_object('result', 'not_eligible', 'reason', 'arca_config_incompleta');
  END IF;
  v_cuit := regexp_replace(v_cuit_raw, '\D', '', 'g');
  v_ambiente := COALESCE(v_ambiente, 'homologacion');

  -- ── Reutilizar el intento propio si quedó pending_reconciliation ──────────
  -- Reintentar el MISMO comprobante no debe competir contra su propia serie:
  -- se reactiva la MISMA fila (conserva numero_intentado, así afip-cae
  -- reconcilia el número anterior antes de considerar uno nuevo) en vez de
  -- insertar una fila nueva.
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
    -- Si no aplicó (alguien más ya lo movió en el medio), sigue el flujo normal.
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
    -- ¿El conflicto es con MI PROPIO comprobante? (recuperable si 'claimed' viejo)
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
          -- Otro proceso ganó la recuperación en el medio — no reintentar en loop.
          RETURN jsonb_build_object('result', 'already_in_progress');
        END;
      END IF;

      -- 'number_reserved'/'sent' (ambiguo, ya en tránsito) NUNCA se libera solo.
      RETURN jsonb_build_object(
        'result', 'already_in_progress',
        'attempt_id', v_existing_mine.id,
        'attempt_status', v_existing_mine.status,
        'sent_at', v_existing_mine.sent_at
      );
    END IF;

    -- No es mío: la SERIE está ocupada por OTRO comprobante_id. Nunca se
    -- avanza — el que pierde la carrera espera o consulta el estado del que
    -- la tiene, nunca inicia una emisión propia para la misma serie.
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

ALTER FUNCTION "public"."claim_comprobante_arca_emission"(uuid, text) OWNER TO "postgres";
-- REVOKE ALL ... FROM PUBLIC solo quita el pseudo-grant de PUBLIC. Supabase
-- define ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT
-- EXECUTE ON FUNCTIONS TO anon, authenticated, service_role — como esta
-- función la crea el rol `postgres` (la migración), anon recibe un grant
-- EXPLÍCITO propio en el momento del CREATE FUNCTION, que REVOKE ALL FROM
-- PUBLIC NO toca. Verificado corriendo esta migración contra Postgres real
-- (arca_atomic_claim_test.sql S1a falló hasta agregar este REVOKE explícito).
REVOKE ALL ON FUNCTION "public"."claim_comprobante_arca_emission"(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."claim_comprobante_arca_emission"(uuid, text) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."claim_comprobante_arca_emission"(uuid, text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."claim_comprobante_arca_emission"(uuid, text) TO "service_role";

-- ============================================================================
-- reserve_arca_number — SOLO afip-cae (service_role). Persiste el número
-- exacto (FECompUltimoAutorizado + 1) ANTES de siquiera considerar llamar a
-- FECAESolicitar. Transición: claimed → number_reserved.
-- ============================================================================
CREATE OR REPLACE FUNCTION "public"."reserve_arca_number"(
  "p_attempt_id" uuid,
  "p_numero" integer
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE arca_emission_attempts
    SET status = 'number_reserved', numero_intentado = p_numero, updated_at = now()
    WHERE id = p_attempt_id AND status = 'claimed';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Intento no encontrado o ya no está en estado claimed');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

ALTER FUNCTION "public"."reserve_arca_number"(uuid, integer) OWNER TO "postgres";
-- Ver comentario en claim_comprobante_arca_emission: los defaults de Supabase
-- otorgan EXECUTE explícito a anon/authenticated en cada CREATE FUNCTION;
-- hay que revocarlo de los dos, no solo de PUBLIC.
REVOKE ALL ON FUNCTION "public"."reserve_arca_number"(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."reserve_arca_number"(uuid, integer) FROM "anon";
REVOKE EXECUTE ON FUNCTION "public"."reserve_arca_number"(uuid, integer) FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."reserve_arca_number"(uuid, integer) TO "service_role";

-- ============================================================================
-- mark_arca_attempt_sent — SOLO afip-cae (service_role). Confirma que se está
-- por invocar FECAESolicitar. Transición: number_reserved → sent.
-- (Ya NO recibe el número — reserve_arca_number lo persiste antes, en un paso
-- separado, para poder distinguir "reservado pero nunca se llegó a enviar"
-- de "efectivamente en tránsito hacia ARCA".)
-- ============================================================================
CREATE OR REPLACE FUNCTION "public"."mark_arca_attempt_sent"(
  "p_attempt_id" uuid
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE arca_emission_attempts
    SET status = 'sent', sent_at = now(), updated_at = now()
    WHERE id = p_attempt_id AND status = 'number_reserved';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Intento no encontrado o ya no está en estado number_reserved');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

ALTER FUNCTION "public"."mark_arca_attempt_sent"(uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."mark_arca_attempt_sent"(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."mark_arca_attempt_sent"(uuid) FROM "anon";
REVOKE EXECUTE ON FUNCTION "public"."mark_arca_attempt_sent"(uuid) FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."mark_arca_attempt_sent"(uuid) TO "service_role";

-- ============================================================================
-- complete_arca_attempt — SOLO afip-cae (service_role). Única escritora del
-- resultado fiscal TERMINAL, en arca_emission_attempts Y en comprobantes
-- (single source of verdad server-side). Idempotente vía `AND cae IS NULL`:
-- nunca pisa un comprobante que ya se resolvió. Al pasar a un status terminal
-- (authorized/authorized_reconciled/rejected), la fila sale de los dos índices
-- únicos parciales — libera tanto el comprobante como la serie. Un
-- pending_reconciliation deliberadamente NO libera la serie (sigue bloqueando
-- hasta que se resuelva).
-- ============================================================================
CREATE OR REPLACE FUNCTION "public"."complete_arca_attempt"(
  "p_attempt_id" uuid,
  "p_status" text,  -- 'authorized' | 'authorized_reconciled' | 'rejected' | 'pending_reconciliation'
  "p_cae" text DEFAULT NULL,
  "p_cae_vencimiento" timestamptz DEFAULT NULL,
  "p_resultado" text DEFAULT NULL,
  "p_observaciones" text DEFAULT NULL,
  "p_error_mensaje" text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_attempt arca_emission_attempts%ROWTYPE;
  v_numero_fmt text;
BEGIN
  IF p_status NOT IN ('authorized', 'authorized_reconciled', 'rejected', 'pending_reconciliation') THEN
    RETURN jsonb_build_object('success', false, 'error', 'status inválido: ' || p_status);
  END IF;

  SELECT * INTO v_attempt FROM arca_emission_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Intento no encontrado');
  END IF;

  UPDATE arca_emission_attempts
    SET status = p_status, cae = p_cae, cae_vencimiento = p_cae_vencimiento,
        resultado = p_resultado, observaciones = p_observaciones, error_mensaje = p_error_mensaje,
        completed_at = now(), updated_at = now()
    WHERE id = p_attempt_id;

  IF p_status IN ('authorized', 'authorized_reconciled') THEN
    IF v_attempt.numero_intentado IS NOT NULL THEN
      v_numero_fmt := lpad(v_attempt.punto_venta::text, 4, '0') || '-' || lpad(v_attempt.numero_intentado::text, 8, '0');
    END IF;

    UPDATE comprobantes SET
      cae                     = p_cae,
      cae_vencimiento         = p_cae_vencimiento,
      numero_fiscal           = COALESCE(v_numero_fmt, numero_fiscal),
      numero_comprobante      = COALESCE(v_numero_fmt, numero_comprobante),
      tipo_comprobante_fiscal = COALESCE(v_attempt.tipo_comprobante::text, tipo_comprobante_fiscal),
      resultado_fiscal        = p_resultado,
      observaciones_fiscales  = p_observaciones,
      estado_fiscal           = 'emitido',
      estado                  = 'emitido',
      status                  = 'issued',
      fecha_emision_fiscal    = now(),
      error_mensaje           = NULL,
      updated_at              = now()
    WHERE id = v_attempt.comprobante_id
      AND cae IS NULL; -- idempotente

  ELSIF p_status = 'pending_reconciliation' THEN
    UPDATE comprobantes SET
      estado_fiscal = 'pendiente_conciliacion',
      error_mensaje = p_error_mensaje,
      updated_at    = now()
    WHERE id = v_attempt.comprobante_id
      AND cae IS NULL;

  ELSIF p_status = 'rejected' THEN
    UPDATE comprobantes SET
      estado_fiscal = 'error_emision',
      error_mensaje = p_error_mensaje,
      updated_at    = now()
    WHERE id = v_attempt.comprobante_id
      AND cae IS NULL;
  END IF;

  RETURN jsonb_build_object('success', true, 'status', p_status, 'comprobante_id', v_attempt.comprobante_id);
END;
$$;

ALTER FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text) FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text) TO "service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado por esta migración):
--   DROP FUNCTION IF EXISTS "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text);
--   DROP FUNCTION IF EXISTS "public"."mark_arca_attempt_sent"(uuid);
--   DROP FUNCTION IF EXISTS "public"."reserve_arca_number"(uuid, integer);
--   DROP FUNCTION IF EXISTS "public"."claim_comprobante_arca_emission"(uuid, text);
--   DROP TABLE IF EXISTS "public"."arca_emission_attempts";
--   (no afecta `comprobantes`: complete_arca_attempt solo escribe columnas que
--    ya existían antes de esta migración, así que no hay nada que revertir ahí)
-- ============================================================================
