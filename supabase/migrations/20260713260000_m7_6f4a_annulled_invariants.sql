-- ============================================================================
-- M7 Lote 6F.4a — Invariantes de comprobante anulado.
--   1. Un comprobante anulado NO puede recibir reemplazos ni pagos nuevos.
--   2. Ninguna columna alternativa puede marcar NI DESMARCAR una anulacion
--      fuera de annul_comprobante_atomic.
--
-- EVIDENCIA que obliga al guard central de pagos (§3): `authenticated` TIENE
-- grant de INSERT sobre comprobante_payments y la policy cp_insert solo exige
-- business_id = current_user_business_id(). Es decir: los grants/RLS NO hacen
-- imposible insertar un pago fuera de las RPC canonicas — un cliente puede
-- hacerlo directo por PostgREST (comprobanteService.registrarPago() hace
-- exactamente eso, hoy sin consumidor activo). Por eso el guard es necesario.
--
-- NO toca: ARCA, CAE, numeracion, notas de credito, el modelo contable, ni la
-- maquinaria stale_source de 6F.3a.
-- ============================================================================

-- ============================================================================
-- §A — Condicion canonica de "comprobante anulado"
-- ============================================================================
-- No existe columna annulled_at en comprobantes: las señales son estado,
-- estado_comercial y status. Cualquiera puede quedar desincronizada, asi que la
-- condicion canonica es la DISYUNCION de todas + el registro de anulacion, que
-- es la evidencia canonica suficiente.
CREATE OR REPLACE FUNCTION "public"."comprobante_state_is_annulled"(p_estado text, p_estado_comercial text, p_status text)
 RETURNS boolean LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(p_estado = 'anulado' OR p_estado_comercial = 'anulado' OR p_status = 'cancelled', false);
$$;
COMMENT ON FUNCTION "public"."comprobante_state_is_annulled"(text,text,text) IS
  'M7 6F.4a — ¿esta combinacion de señales operativas representa un comprobante '
  'anulado? Solo mira columnas (para triggers, que reciben OLD/NEW). La condicion '
  'CANONICA completa es is_comprobante_annulled(uuid), que ademas consulta el '
  'registro de comprobante_annulments.';

CREATE OR REPLACE FUNCTION "public"."is_comprobante_annulled"(p_comprobante_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT
    -- Evidencia canonica: un registro de anulacion completado alcanza por si solo.
    EXISTS (SELECT 1 FROM comprobante_annulments a
             WHERE a.comprobante_id = p_comprobante_id AND a.status = 'completed')
    -- Defensa ante datos legacy: anulaciones viejas hechas por la via client-side
    -- no tienen registro canonico, pero si dejaron las señales operativas.
    OR EXISTS (SELECT 1 FROM comprobantes c
                WHERE c.id = p_comprobante_id
                  AND public.comprobante_state_is_annulled(c.estado, c.estado_comercial, c.status));
$$;
COMMENT ON FUNCTION "public"."is_comprobante_annulled"(uuid) IS
  'M7 6F.4a — Condicion CANONICA de comprobante anulado. Unica fuente para: '
  'replace_comprobante_payment, el guard de insercion de pagos, tests y preflight. '
  'No depende de una sola columna: registro de anulacion OR cualquier señal operativa.';
ALTER FUNCTION "public"."comprobante_state_is_annulled"(text,text,text) OWNER TO "postgres";
ALTER FUNCTION "public"."is_comprobante_annulled"(uuid) OWNER TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."is_comprobante_annulled"(uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."is_comprobante_annulled"(uuid) TO "service_role";

-- ============================================================================
-- §4 — Transition guard: cierra AMBAS direcciones y TODAS las columnas
-- ============================================================================
-- 6F.4 solo bloqueaba ENTRAR a anulado. Faltaba:
--   · SALIR de anulado (resucitar un comprobante);
--   · cambiar SOLO status o SOLO estado_comercial cuando otra columna ya decia
--     'anulado' (el chequeo agregado lo enmascaraba).
-- Ahora se evalua COLUMNA POR COLUMNA: cualquier cambio que toque un valor de
-- anulacion/cancelacion, en cualquier direccion, exige el contexto canonico.
CREATE OR REPLACE FUNCTION "public"."comprobante_annulment_transition_guard"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
DECLARE
  v_touches_annulment boolean;
BEGIN
  v_touches_annulment :=
       (OLD.estado IS DISTINCT FROM NEW.estado
        AND (OLD.estado = 'anulado' OR NEW.estado = 'anulado'))
    OR (OLD.estado_comercial IS DISTINCT FROM NEW.estado_comercial
        AND (OLD.estado_comercial = 'anulado' OR NEW.estado_comercial = 'anulado'))
    OR (OLD.status IS DISTINCT FROM NEW.status
        AND (OLD.status = 'cancelled' OR NEW.status = 'cancelled'));

  IF COALESCE(v_touches_annulment, false) THEN
    -- Doble condicion, NO una GUC sola:
    --   1. current_user='postgres' — esta funcion es SECURITY INVOKER a proposito,
    --      asi current_user refleja el contexto REAL: 'authenticated' via PostgREST,
    --      'postgres' dentro de una SECURITY DEFINER de postgres. Un cliente no
    --      puede SET ROLE postgres: es un limite de privilegio, no un flag.
    --   2. GUC m7.annulment_scope — acota a la RPC canonica. Falsificable por si
    --      sola, por eso nunca es la unica proteccion.
    IF current_user <> 'postgres'
       OR COALESCE(current_setting('m7.annulment_scope', true), '') <> '1' THEN
      RAISE EXCEPTION 'La anulacion de un comprobante debe realizarse mediante annul_comprobante_atomic'
        USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."comprobante_annulment_transition_guard"() OWNER TO "postgres";
-- (el trigger trg_comprobante_annulment_transition de 6F.4 se conserva tal cual)

-- ============================================================================
-- §3 — Guard central: ningun pago NUEVO sobre un comprobante anulado
-- ============================================================================
-- BEFORE INSERT: no toca ninguna fila historica. No afecta las compensaciones
-- financieras de la anulacion (escriben financial_movements/BFE, no pagos).
CREATE OR REPLACE FUNCTION "public"."comprobante_payments_annulled_guard"() RETURNS "trigger"
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_comp_business uuid;
BEGIN
  SELECT business_id INTO v_comp_business FROM comprobantes WHERE id = NEW.comprobante_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El comprobante del pago no existe' USING ERRCODE='23503';
  END IF;
  -- Aislamiento: el pago debe pertenecer al mismo negocio que su comprobante.
  IF NEW.business_id IS DISTINCT FROM v_comp_business THEN
    RAISE EXCEPTION 'El pago pertenece a otro negocio que su comprobante' USING ERRCODE='42501';
  END IF;
  -- Invariante 6F.4a: un comprobante anulado no recibe cobros nuevos.
  IF public.is_comprobante_annulled(NEW.comprobante_id) THEN
    RAISE EXCEPTION 'El comprobante está anulado' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."comprobante_payments_annulled_guard"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_cp_annulled_guard" ON "public"."comprobante_payments";
-- Nombre elegido para correr ANTES de trg_cp_replacement_guard y de los de
-- periodo/finanzas (los BEFORE se disparan por orden alfabetico).
CREATE TRIGGER "trg_cp_annulled_guard"
  BEFORE INSERT ON "public"."comprobante_payments"
  FOR EACH ROW EXECUTE FUNCTION "public"."comprobante_payments_annulled_guard"();

-- ============================================================================
-- §1 — replace_comprobante_payment: rechazo sobre comprobante anulado
-- ============================================================================
-- Parche QUIRURGICO (la funcion tiene ~200 lineas y su orden de locks es delicado).
--
-- POR QUE NO SE MUEVE EL LOCK DEL COMPROBANTE AL PRINCIPIO:
--   El boceto pedia lock -> relectura -> chequeo -> reserva. Pero en esta RPC la
--   reserva precede a los locks A PROPOSITO (6F.3a §5): el snapshot del conjunto
--   vivo (v_set_hash_before) se toma PRE-lock porque representa lo que el intento
--   OBSERVO. Si se tomara el lock antes, dos reemplazos concurrentes se
--   serializarian por completo y v_set_hash_before == v_set_hash_after SIEMPRE:
--   PAYMENT_SET_CHANGED no se dispararia nunca y la segunda sesion reescribiria
--   en silencio un conjunto de pagos que su usuario jamas vio. Eso es exactamente
--   lo que 6F.3a evita.
--
-- SOLUCION: dos chequeos con la misma condicion canonica.
--   · Rapido, sin lock (paso 3): cubre el caso normal y retorna antes de todo.
--   · AUTORITATIVO, bajo el lock (paso 9.5): si la anulacion se colo entre medio,
--     se RAISE. El handler externo lo mapea a ALREADY_ANNULLED y el rollback al
--     savepoint deshace la reserva -> la key NUEVA no deja request, ni pago, ni
--     compensacion, ni auditoria (§1).
-- El replay se resuelve en el paso 5, ANTES de ambos chequeos: un reemplazo
-- completado antes de la anulacion sigue devolviendo replay.
DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('public.replace_comprobante_payment(uuid,uuid,text,numeric,numeric,text,numeric,text,uuid,numeric,text,text)'::regprocedure);

  IF position('6F.4a' in v_def) > 0 THEN
    RAISE NOTICE '6F.4a: replace_comprobante_payment ya parcheada';
  ELSE
    -- (a) chequeo rapido sin lock. Va DESPUES del bloque de replay (paso 5) a
    -- proposito: un reemplazo COMPLETADO antes de la anulacion tiene que seguir
    -- devolviendo replay; solo se rechaza una operacion NUEVA (§1).
    v_new := replace(v_def,
      $frag$  -- 6. Snapshot del conjunto de pagos VIVOS que este intento observo (pre-lock).$frag$,
      $frag$  -- 5.5 (6F.4a) Recien ahora, con el replay ya resuelto: un comprobante anulado
  -- no admite reemplazos NUEVOS. Chequeo rapido sin lock; el autoritativo va bajo
  -- el lock en el paso 9.5.
  IF public.is_comprobante_annulled(p_comprobante_id) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','ALREADY_ANNULLED', 'error', 'El comprobante está anulado'); END IF;

  -- 6. Snapshot del conjunto de pagos VIVOS que este intento observo (pre-lock).$frag$);
    IF v_new = v_def THEN RAISE EXCEPTION '6F.4a: no se pudo insertar el chequeo rapido de anulado'; END IF;
    v_def := v_new;

    -- (b) chequeo autoritativo bajo el lock del comprobante, antes de escribir nada
    v_new := replace(v_def,
      $frag$  -- 10. Recalcular el conjunto vivo bajo lock: si cambio, abortar sin escribir.$frag$,
      $frag$  -- 9.5 (6F.4a) Estado canonico RELEIDO bajo el lock: si la anulacion se commiteo
  -- mientras esperabamos, se aborta por excepcion para que el rollback al savepoint
  -- deshaga tambien la reserva -> una key nueva no deja request huerfana.
  IF public.is_comprobante_annulled(p_comprobante_id) THEN
    RAISE EXCEPTION 'COMPROBANTE_ANNULLED: el comprobante fue anulado' USING ERRCODE='42501';
  END IF;

  -- 10. Recalcular el conjunto vivo bajo lock: si cambio, abortar sin escribir.$frag$);
    IF v_new = v_def THEN RAISE EXCEPTION '6F.4a: no se pudo insertar el chequeo autoritativo'; END IF;
    v_def := v_new;

    -- (c) el handler externo mapea la excepcion al contrato ALREADY_ANNULLED
    v_new := replace(v_def,
      $frag$    WHEN SQLERRM LIKE 'PERIOD_CLOSED%' THEN 'PERIOD_CLOSED'
    ELSE 'INTERNAL_ERROR' END;$frag$,
      $frag$    WHEN SQLERRM LIKE 'PERIOD_CLOSED%' THEN 'PERIOD_CLOSED'
    WHEN SQLERRM LIKE 'COMPROBANTE_ANNULLED%' THEN 'ALREADY_ANNULLED'
    ELSE 'INTERNAL_ERROR' END;$frag$);
    IF v_new = v_def THEN RAISE EXCEPTION '6F.4a: no se pudo mapear ALREADY_ANNULLED en el handler'; END IF;
    v_def := v_new;

    v_new := replace(v_def,
      $frag$    'error', CASE WHEN v_ec='AUDIT_FAILED' THEN 'No se pudo registrar la auditoria de la operacion'
                  WHEN v_ec='PERIOD_CLOSED' THEN SQLERRM
                  ELSE 'No se pudo completar la operacion' END);$frag$,
      $frag$    'error', CASE WHEN v_ec='AUDIT_FAILED' THEN 'No se pudo registrar la auditoria de la operacion'
                  WHEN v_ec='PERIOD_CLOSED' THEN SQLERRM
                  WHEN v_ec='ALREADY_ANNULLED' THEN 'El comprobante está anulado'
                  ELSE 'No se pudo completar la operacion' END);$frag$);
    IF v_new = v_def THEN RAISE EXCEPTION '6F.4a: no se pudo insertar el mensaje de ALREADY_ANNULLED'; END IF;

    EXECUTE v_new;
    RAISE NOTICE '6F.4a: replace_comprobante_payment parcheada';
  END IF;
END $$;

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP TRIGGER trg_cp_annulled_guard ON comprobante_payments;
--   DROP FUNCTION comprobante_payments_annulled_guard();
--   Recrear comprobante_annulment_transition_guard() de 20260713250000 (solo
--     bloqueaba la entrada a anulado, con chequeo agregado);
--   Recrear replace_comprobante_payment sin los chequeos 6F.4a (a/b/c);
--   DROP FUNCTION is_comprobante_annulled(uuid), comprobante_state_is_annulled(text,text,text);
-- ============================================================================
