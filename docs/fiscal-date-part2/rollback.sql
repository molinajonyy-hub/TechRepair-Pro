-- ============================================================================
-- FISCAL DATE ARGENTINA Parte 2 — ROLLBACK de 20260927120000_fiscal_date_part2.sql
--
-- ORDEN (inverso al despliegue, sin ventana insegura):
--   1. Volver PRIMERO el Edge a la versión previa a la Parte 2 (manda 7
--      argumentos). Con la identidad de 8 y p_fecha_cbte DEFAULT NULL esa
--      llamada sigue resolviendo, así que este paso no depende del rollback SQL.
--   2. Sólo si realmente hace falta, correr este script para restaurar la
--      función de 7 argumentos EXACTA que corría en producción.
--   3. Verificar: una sola complete_arca_attempt, identidad de 7 argumentos,
--      SECURITY DEFINER, search_path public/pg_temp, ACL sólo service_role.
--
-- LA COLUMNA NO SE DROPEA. `comprobantes.fecha_comprobante_fiscal` es aditiva,
-- nullable e inerte para un llamador viejo, y puede contener historia fiscal
-- canónica ya recolectada (CbteFch real aceptado por ARCA). Tirarla para
-- "restaurar la forma del esquema" destruiría metadata fiscal válida que no se
-- puede reconstruir localmente. El trigger de inmutabilidad tampoco se toca:
-- sin él, esa historia quedaría reescribible.
--
-- Cuerpo restaurado = definición de PRODUCCIÓN previa a la Parte 2:
--   md5(prosrc) = 3b3b33da91367df6b8726f3160bd82cb   (2395 bytes, 61 líneas)
-- OJO: NO lleva el comentario `-- idempotente` de la línea `AND cae IS NULL;`.
-- Ese comentario existe en la fuente del repo (20260701150000) y en las DB
-- locales (md5 763dddb9…, 15 bytes más), pero NO en producción. Restaurar la
-- variante local dejaría un fingerprint distinto del que había.
-- ============================================================================
BEGIN;

DROP FUNCTION IF EXISTS "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text, text);

CREATE FUNCTION "public"."complete_arca_attempt"(
  "p_attempt_id" uuid,
  "p_status" text,
  "p_cae" text DEFAULT NULL,
  "p_cae_vencimiento" timestamptz DEFAULT NULL,
  "p_resultado" text DEFAULT NULL,
  "p_observaciones" text DEFAULT NULL,
  "p_error_mensaje" text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $rollback$
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
      AND cae IS NULL;

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
$rollback$;

ALTER FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text) FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text) TO "service_role";

NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  v_count int;
  v_args text;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_arca_attempt';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'rollback: debe quedar EXACTAMENTE una complete_arca_attempt, hay %', v_count;
  END IF;

  SELECT pg_get_function_identity_arguments(p.oid) INTO v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_arca_attempt';

  IF v_args <> 'p_attempt_id uuid, p_status text, p_cae text, p_cae_vencimiento timestamp with time zone, p_resultado text, p_observaciones text, p_error_mensaje text' THEN
    RAISE EXCEPTION 'rollback: identidad inesperada tras restaurar: %', v_args;
  END IF;
END;
$$;

COMMIT;
