-- ============================================================================
-- FISCAL DATE ARGENTINA — Parte 2
--
-- Persiste la fecha fiscal EXACTA (CbteFch) que ARCA aceptó, en una columna
-- canónica nueva. Hasta hoy no existía: `fecha_emision_fiscal` es el instante
-- de COMPLETADO (now()), no la fecha del comprobante, y ni request_data ni
-- response_data ni electronic_invoice_log guardaban CbteFch.
--
-- Autoridad: afip-cae ya calcula el día civil argentino server-side (Parte 1,
-- resolveCbteFch) y lo manda en FECAESolicitar. ESE mismo valor se persiste
-- acá — nunca se deriva de now(), sent_at, completed_at ni de la fecha de venta.
--
-- IDENTIDAD DEL RPC (decisión del owner, opción 1):
-- `complete_arca_attempt` mantiene UNA sola autoridad de completado fiscal. No
-- se crea un segundo escritor: se reemplaza la identidad de 7 argumentos por la
-- de 8 en ESTA transacción, con p_fecha_cbte text DEFAULT NULL para que los
-- llamadores viejos (afip-cae v23, que manda 7) sigan resolviendo.
--
-- p_fecha_cbte es TEXT a propósito: si fuera DATE, PostgREST podría rechazar o
-- castear un valor inválido ANTES de entrar a la función, y el CAE ya
-- autorizado se perdería por metadata. La función parsea defensivamente.
--
-- INVARIANTE CRÍTICO — el CAE vale más que la metadata:
-- ninguna fecha faltante, malformada o imposible (p.ej. 20260231), ni un fallo
-- al escribir la columna, puede impedir que se persista un CAE ya autorizado ni
-- crear un pending_reconciliation nuevo. La persistencia de la fecha vive en un
-- sub-bloque con EXCEPTION propio, DESPUÉS del completado canónico.
--
-- ROLLBACK (documentado, no ejecutado acá): ver el bloque al final. Restaura la
-- definición de 7 argumentos EXACTA que corre hoy en producción (61 líneas,
-- md5(prosrc) = 3b3b33da91367df6b8726f3160bd82cb). OJO: esa definición NO tiene
-- el comentario `-- idempotente` que sí está en la fuente del repo y en las DB
-- locales (md5 763dddb9…, 15 bytes de diferencia, misma semántica).
-- ============================================================================
BEGIN;

-- ── 1. Columna canónica ─────────────────────────────────────────────────────
-- Aditiva y nullable: las filas existentes siguen siendo válidas, y un
-- afip-cae viejo que nunca la escribe tampoco rompe.
ALTER TABLE "public"."comprobantes"
  ADD COLUMN IF NOT EXISTS "fecha_comprobante_fiscal" date;

COMMENT ON COLUMN "public"."comprobantes"."fecha_comprobante_fiscal" IS
  'CbteFch EXACTO aceptado por ARCA para este comprobante autorizado (día civil argentino). '
  'No es la fecha de venta (`fecha`), ni created_at, ni sent_at, ni completed_at, ni '
  '`fecha_emision_fiscal` (que es el timestamp de completado). Lo escribe únicamente '
  'complete_arca_attempt con el valor que afip-cae mandó en FECAESolicitar, o un backfill '
  'histórico controlado. NULL = todavía desconocida: la UI no debe inventarla.';

-- ── 2. Parser defensivo YYYYMMDD → date ─────────────────────────────────────
-- NUNCA lanza: devuelve NULL ante NULL, formato inválido o fecha imposible
-- (20260231). `to_date` NO sirve acá: es tolerante y convertiría 20260231 en
-- 2026-03-03, inventando una fecha fiscal que ARCA nunca aceptó.
CREATE OR REPLACE FUNCTION "public"."arca_parse_cbte_fch"("p_value" text)
RETURNS date
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  v_date date;
BEGIN
  IF p_value IS NULL OR p_value !~ '^[0-9]{8}$' THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_date := make_date(
      substr(p_value, 1, 4)::int,
      substr(p_value, 5, 2)::int,
      substr(p_value, 7, 2)::int
    );
  EXCEPTION WHEN OTHERS THEN
    -- Fecha imposible (mes 13, 31 de febrero, …): metadata inválida, no error.
    RETURN NULL;
  END;

  RETURN v_date;
END;
$$;

ALTER FUNCTION "public"."arca_parse_cbte_fch"(text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."arca_parse_cbte_fch"(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."arca_parse_cbte_fch"(text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "public"."arca_parse_cbte_fch"(text) FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."arca_parse_cbte_fch"(text) TO "service_role";

-- ── 3. Inmutabilidad de la fecha fiscal ya persistida ───────────────────────
-- `authenticated` hoy NO tiene UPDATE sobre esta columna (los únicos grants de
-- columna son observaciones y updated_at), así que el cliente no puede
-- escribirla aunque exista. Este trigger es defensa en profundidad y, sobre
-- todo, impide que un camino server-side pise una fecha fiscal ya escrita.
--   NULL  -> fecha   : permitido (completado o backfill controlado)
--   fecha -> misma   : idempotente
--   fecha -> distinta: bloqueado
CREATE OR REPLACE FUNCTION "public"."comprobante_fiscal_date_immutable"()
RETURNS trigger
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF OLD.fecha_comprobante_fiscal IS NOT NULL
     AND NEW.fecha_comprobante_fiscal IS DISTINCT FROM OLD.fecha_comprobante_fiscal THEN
    RAISE EXCEPTION
      'fecha_comprobante_fiscal ya persistida (%) no puede reescribirse con %',
      OLD.fecha_comprobante_fiscal, NEW.fecha_comprobante_fiscal
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."comprobante_fiscal_date_immutable"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_comprobante_fiscal_date_immutable" ON "public"."comprobantes";
CREATE TRIGGER "trg_comprobante_fiscal_date_immutable"
  BEFORE UPDATE OF "fecha_comprobante_fiscal" ON "public"."comprobantes"
  FOR EACH ROW EXECUTE FUNCTION "public"."comprobante_fiscal_date_immutable"();

-- ── 4. Reemplazo ATÓMICO de la identidad de complete_arca_attempt ───────────
-- DROP + CREATE en la misma transacción: nunca conviven las dos identidades.
DROP FUNCTION IF EXISTS "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text);

CREATE FUNCTION "public"."complete_arca_attempt"(
  "p_attempt_id" uuid,
  "p_status" text,  -- 'authorized' | 'authorized_reconciled' | 'rejected' | 'pending_reconciliation'
  "p_cae" text DEFAULT NULL,
  "p_cae_vencimiento" timestamptz DEFAULT NULL,
  "p_resultado" text DEFAULT NULL,
  "p_observaciones" text DEFAULT NULL,
  "p_error_mensaje" text DEFAULT NULL,
  -- Parte 2: CbteFch exacto enviado a ARCA (YYYYMMDD). METADATA OPCIONAL:
  -- un llamador viejo no lo manda y el completado fiscal es idéntico.
  "p_fecha_cbte" text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    -- Los nombres de schema van SIN comillas simples. Postgres guarda el mismo
    -- proconfig en los dos casos (`search_path=public, pg_temp`, y la
    -- postcondición de abajo lo verifica), pero guard-security-definer.mjs
    -- blanquea los literales entre comillas simples antes de parsear, así que
    -- con 'public', 'pg_temp' lee un search_path vacío y reporta que falta
    -- pg_temp. El search_path EFECTIVO es idéntico al de la función anterior.
    SET search_path TO public, pg_temp
    AS $$
DECLARE
  -- Todas las relaciones van CALIFICADAS con public.: la resolución no depende
  -- del search_path, así que ni una tabla temporal ni un schema intermedio
  -- pueden secuestrar a qué objeto apunta esta SECURITY DEFINER. Es el
  -- endurecimiento que exige scripts/finance/guard-security-definer.mjs.
  v_attempt public.arca_emission_attempts%ROWTYPE;
  v_numero_fmt text;
  v_fecha_fiscal date;
  v_fecha_status text := 'absent';
BEGIN
  IF p_status NOT IN ('authorized', 'authorized_reconciled', 'rejected', 'pending_reconciliation') THEN
    RETURN jsonb_build_object('success', false, 'error', 'status inválido: ' || p_status);
  END IF;

  SELECT * INTO v_attempt FROM public.arca_emission_attempts WHERE id = p_attempt_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Intento no encontrado');
  END IF;

  UPDATE public.arca_emission_attempts
    SET status = p_status, cae = p_cae, cae_vencimiento = p_cae_vencimiento,
        resultado = p_resultado, observaciones = p_observaciones, error_mensaje = p_error_mensaje,
        completed_at = now(), updated_at = now()
    WHERE id = p_attempt_id;

  IF p_status IN ('authorized', 'authorized_reconciled') THEN
    IF v_attempt.numero_intentado IS NOT NULL THEN
      v_numero_fmt := lpad(v_attempt.punto_venta::text, 4, '0') || '-' || lpad(v_attempt.numero_intentado::text, 8, '0');
    END IF;

    UPDATE public.comprobantes SET
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
    UPDATE public.comprobantes SET
      estado_fiscal = 'pendiente_conciliacion',
      error_mensaje = p_error_mensaje,
      updated_at    = now()
    WHERE id = v_attempt.comprobante_id
      AND cae IS NULL;

  ELSIF p_status = 'rejected' THEN
    UPDATE public.comprobantes SET
      estado_fiscal = 'error_emision',
      error_mensaje = p_error_mensaje,
      updated_at    = now()
    WHERE id = v_attempt.comprobante_id
      AND cae IS NULL;
  END IF;

  -- ── Metadata fiscal OPCIONAL — fail-open ─────────────────────────────────
  -- Todo lo de arriba ya ocurrió. Nada de acá abajo puede tumbar el CAE: cada
  -- paso vive en su propio sub-bloque con EXCEPTION (savepoint implícito), así
  -- que un parser ausente, una fecha imposible o el trigger de inmutabilidad
  -- sólo dejan la columna en NULL y registran evidencia acotada.
  IF p_fecha_cbte IS NOT NULL THEN
    BEGIN
      v_fecha_fiscal := public.arca_parse_cbte_fch(p_fecha_cbte);
    EXCEPTION WHEN OTHERS THEN
      v_fecha_fiscal := NULL;
      RAISE LOG 'complete_arca_attempt: parser de CbteFch no disponible para attempt % (%)', p_attempt_id, SQLSTATE;
    END;

    IF v_fecha_fiscal IS NULL THEN
      v_fecha_status := 'invalid';
      RAISE LOG 'complete_arca_attempt: CbteFch inválido para attempt %, fecha fiscal queda NULL', p_attempt_id;
    END IF;
  END IF;

  IF v_fecha_fiscal IS NOT NULL AND p_status IN ('authorized', 'authorized_reconciled') THEN
    BEGIN
      UPDATE public.comprobantes
        SET fecha_comprobante_fiscal = v_fecha_fiscal
        WHERE id = v_attempt.comprobante_id
          AND fecha_comprobante_fiscal IS NULL;

      IF FOUND THEN
        v_fecha_status := 'persisted';
      ELSE
        v_fecha_status := 'already_set';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fecha_status := 'metadata_failed';
      RAISE LOG 'complete_arca_attempt: no se pudo persistir la fecha fiscal del attempt % (%) — el CAE ya quedó completado',
        p_attempt_id, SQLSTATE;
    END;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', p_status,
    'comprobante_id', v_attempt.comprobante_id,
    'fiscal_date', v_fecha_fiscal,
    'fiscal_date_status', v_fecha_status
  );
END;
$$;

ALTER FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text, text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text, text) FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text, text) TO "service_role";

-- PostgREST resuelve las RPC por el esquema cacheado: sin recarga, una llamada
-- de 7 argumentos seguiría buscando la identidad vieja.
NOTIFY pgrst, 'reload schema';

-- ── 5. Postcondiciones ──────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
  v_args text;
  v_secdef boolean;
  v_config text[];
  v_acl text;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_arca_attempt';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'postcondición: debe existir EXACTAMENTE una complete_arca_attempt, hay %', v_count;
  END IF;

  SELECT pg_get_function_identity_arguments(p.oid), p.prosecdef, p.proconfig, p.proacl::text
    INTO v_args, v_secdef, v_config, v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_arca_attempt';

  IF v_args <> 'p_attempt_id uuid, p_status text, p_cae text, p_cae_vencimiento timestamp with time zone, p_resultado text, p_observaciones text, p_error_mensaje text, p_fecha_cbte text' THEN
    RAISE EXCEPTION 'postcondición: identidad inesperada: %', v_args;
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'postcondición: complete_arca_attempt debe ser SECURITY DEFINER';
  END IF;
  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'postcondición: search_path inesperado: %', v_config;
  END IF;
  IF has_function_privilege('anon', 'public.complete_arca_attempt(uuid,text,text,timestamptz,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.complete_arca_attempt(uuid,text,text,timestamptz,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondición: anon/authenticated no pueden ejecutar complete_arca_attempt (ACL %)', v_acl;
  END IF;
  IF NOT has_function_privilege('service_role', 'public.complete_arca_attempt(uuid,text,text,timestamptz,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondición: service_role debe poder ejecutar complete_arca_attempt';
  END IF;

  -- Columna canónica
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'comprobantes'
     AND column_name = 'fecha_comprobante_fiscal' AND data_type = 'date' AND is_nullable = 'YES';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'postcondición: falta comprobantes.fecha_comprobante_fiscal date NULL';
  END IF;

  -- Ningún cliente puede escribirla
  IF has_column_privilege('authenticated', 'public.comprobantes', 'fecha_comprobante_fiscal', 'UPDATE')
     OR has_column_privilege('anon', 'public.comprobantes', 'fecha_comprobante_fiscal', 'UPDATE') THEN
    RAISE EXCEPTION 'postcondición: anon/authenticated no pueden UPDATE la fecha fiscal';
  END IF;

  -- Guard de inmutabilidad
  PERFORM 1 FROM pg_trigger
   WHERE tgrelid = 'public.comprobantes'::regclass
     AND tgname = 'trg_comprobante_fiscal_date_immutable' AND NOT tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'postcondición: falta el trigger de inmutabilidad de la fecha fiscal';
  END IF;

  -- Parser defensivo
  IF public.arca_parse_cbte_fch('20260911') IS DISTINCT FROM DATE '2026-09-11'
     OR public.arca_parse_cbte_fch('20260231') IS NOT NULL
     OR public.arca_parse_cbte_fch('2026-09-11') IS NOT NULL
     OR public.arca_parse_cbte_fch(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'postcondición: arca_parse_cbte_fch no cumple su contrato';
  END IF;
END;
$$;

COMMIT;

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado por esta migración)
--
-- Orden seguro, igual que en P0-ARCA-B: primero volver el Edge a la versión
-- anterior (que manda 7 argumentos), DESPUÉS —sólo si hace falta— restaurar la
-- función. La columna NO se dropea: conserva historia fiscal válida ya
-- recolectada y es inerte para cualquier llamador viejo.
--
--   BEGIN;
--   DROP FUNCTION IF EXISTS "public"."complete_arca_attempt"(uuid, text, text, timestamptz, text, text, text, text);
--   -- Definición EXACTA que corría en producción antes de esta migración
--   -- (md5(prosrc) = 3b3b33da91367df6b8726f3160bd82cb; SIN el comentario
--   --  `-- idempotente`, que sólo existe en la fuente del repo y en local):
--   CREATE FUNCTION "public"."complete_arca_attempt"(
--     "p_attempt_id" uuid, "p_status" text, "p_cae" text DEFAULT NULL,
--     "p_cae_vencimiento" timestamptz DEFAULT NULL, "p_resultado" text DEFAULT NULL,
--     "p_observaciones" text DEFAULT NULL, "p_error_mensaje" text DEFAULT NULL
--   ) RETURNS jsonb LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO 'public', 'pg_temp'
--   AS $rollback$ …cuerpo de 61 líneas de producción… $rollback$;
--   ALTER FUNCTION … OWNER TO "postgres";
--   REVOKE ALL … FROM PUBLIC; REVOKE EXECUTE … FROM "anon"; REVOKE EXECUTE … FROM "authenticated";
--   GRANT EXECUTE … TO "service_role";
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;
--
-- El script ejecutable vive en docs/fiscal-date-part2/rollback.sql.
-- ============================================================================
