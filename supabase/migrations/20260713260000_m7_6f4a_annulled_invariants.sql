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
-- ── §1 REPARACIÓN DE REPRODUCIBILIDAD (6F.4a, historia) ─────────────────────
-- El bloque original insertaba los chequeos (a/b/c) con replace(pg_get_functiondef
-- (replace_comprobante_payment)) contra fragmentos hardcodeados. En un `db reset`
-- limpio la indentación/formato del cuerpo vivo (que deja la 6F.3 reparada) no
-- coincidía con esos fragmentos → replace() no-op → RAISE P0001 (mismo modo de
-- falla que 6F.3). Reparación determinista: CREATE OR REPLACE explícito de la
-- definición CANÓNICA de replace_comprobante_payment con los tres chequeos 6F.4a
-- ya incorporados (idéntica al contrato productivo). Sin replace(), sin
-- pg_get_functiondef, sin coincidencia textual. CREATE OR REPLACE preserva owner y
-- ACL; 20260713310000 fija el search_path (public, pg_temp) después, idempotente.
-- NO cambia datos ni el resultado lógico pretendido de 6F.4a.
CREATE OR REPLACE FUNCTION "public"."replace_comprobante_payment"("p_comprobante_id" "uuid", "p_business_id" "uuid", "p_payment_method" "text", "p_amount" numeric, "p_amount_ars" numeric, "p_currency" "text", "p_exchange_rate" numeric, "p_notes" "text", "p_user_id" "uuid", "p_commission_amount" numeric DEFAULT 0, "p_payment_provider" "text" DEFAULT NULL::"text", "p_idempotency_key" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET search_path TO public, pg_temp
    AS $$
DECLARE
  c_key_max constant int := 200;
  v_actor_user_id uuid := auth.uid();   -- p_user_id NO atribuye (compat de firma)
  v_access boolean := false; v_tipo text;
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_method text; v_notes text := NULLIF(btrim(COALESCE(p_notes,'')), '');
  v_provider text := NULLIF(btrim(COALESCE(p_payment_provider,'')), '');
  v_hash text; v_set_hash_before text; v_set_hash_after text;
  v_existing comprobante_payment_replace_requests%ROWTYPE;
  v_needs_caja boolean; v_caja uuid;
  v_date date;                          -- resultado server-side: NO entra al hash
  v_live_ids uuid[]; v_new_pay uuid; v_req_id uuid;
  v_orig_summary jsonb; v_comp_fm_ids uuid[]; v_comp_bfe_ids uuid[];
  v_new_fm uuid; v_new_bfe uuid;
  v_in_audit boolean := false; v_ec text;
BEGIN
  -- 1/2. Auth + ownership
  IF v_actor_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_actor_user_id)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND COALESCE(user_id,id)=v_actor_user_id AND COALESCE(is_active,true))) INTO v_access;
  IF NOT v_access THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;

  -- 3. Validacion (politica comercial preexistente intacta)
  SELECT tipo INTO v_tipo FROM comprobantes WHERE id=p_comprobante_id AND business_id=p_business_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error_code','COMPROBANTE_NOT_FOUND', 'error', 'Comprobante no encontrado'); END IF;
  IF v_tipo = 'nota_credito' THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Las notas de credito no tienen cobro editable'); END IF;
  IF p_payment_method = 'cuenta_corriente' THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Para cuenta corriente usa el flujo de cobro normal'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El monto debe ser mayor a 0'); END IF;
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;

  -- 4. Normalizacion del metodo (helper canonico del checkout)
  BEGIN
    v_method := public.normalize_checkout_payment_method(p_payment_method);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'INVALID_CHECKOUT_METHOD%' THEN
      RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'Método de pago inválido');
    ELSE RAISE; END IF;
  END;

  -- 5. Replay: hash de la INTENCION del caller (sin ar_today/actor/IDs/saldos).
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(jsonb_build_object('op','payment_replacement','business_id',p_business_id,
      'comprobante_id',p_comprobante_id,'method',v_method,'amount',round(COALESCE(p_amount,0),2),
      'amount_ars',round(COALESCE(p_amount_ars,0),2),'currency',UPPER(COALESCE(p_currency,'ARS')),
      'exchange_rate',round(COALESCE(p_exchange_rate,1),6),'notes',v_notes,
      'commission_amount',round(COALESCE(p_commission_amount,0),2),'provider',v_provider)::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM comprobante_payment_replace_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.'); END IF;
      -- 6F.3a: un intento que quedo STALE es TERMINAL. Un retry (p.ej. de red) NO
      -- puede convertirse en un segundo reemplazo no confirmado: no recalcula el
      -- conjunto, no toma locks, no ejecuta el guard y no audita. Para editar el
      -- conjunto vigente hay que refrescar y usar una key nueva.
      IF v_existing.status IN ('stale_source','processing') THEN
        RETURN jsonb_build_object('ok', false, 'error_code','PAYMENT_SET_CHANGED', 'error', 'El cobro cambió mientras se procesaba. Volvé a intentarlo'); END IF;
      -- completed | legacy(status NULL, M6) -> replay
      RETURN jsonb_build_object('ok', true, 'replay', true, 'new_payment_id', v_existing.new_payment_id);
    END IF;
  END IF;

  -- 5.5 (6F.4a) Recien ahora, con el replay ya resuelto: un comprobante anulado
  -- no admite reemplazos NUEVOS. Chequeo rapido sin lock; el autoritativo va bajo
  -- el lock en el paso 9.5.
  IF public.is_comprobante_annulled(p_comprobante_id) THEN
    RETURN jsonb_build_object('ok', false, 'error_code','ALREADY_ANNULLED', 'error', 'El comprobante está anulado'); END IF;

  -- 6. Snapshot del conjunto de pagos VIVOS que este intento observo (pre-lock).
  SELECT encode(extensions.digest(COALESCE(jsonb_agg(e ORDER BY e->>'id')::text,'[]'), 'sha256'),'hex')
    INTO v_set_hash_before
    FROM (SELECT jsonb_build_object('id',id,'amount',round(COALESCE(amount,0),2),'amount_ars',round(COALESCE(amount_ars,0),2),
                 'method',payment_method,'currency',currency,'exchange_rate',round(COALESCE(exchange_rate,1),6),
                 'provider',payment_provider,'commission',round(COALESCE(commission_amount,0),2),'date',date) AS e
            FROM comprobante_payments WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND replaced_at IS NULL) s;

  -- 7. Key NUEVA: recien ahora se resuelve la fecha economica.
  v_date := public.ar_today();

  -- 8. Guard: SOLO el periodo de la operacion NUEVA (compensaciones + pago nuevo).
  BEGIN PERFORM public.assert_period_open(p_business_id, v_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF; END;

  -- 8.5 RESERVA (ANTES de los locks): es el punto de serializacion de la MISMA key.
  -- Si otra sesion con la misma key esta en curso, este INSERT espera en el indice
  -- UNIQUE; al liberarse se RELEE su resultado (replay/stale/conflict) en vez de
  -- comparar el source set -- que esa misma sesion acaba de cambiar (§5).
  IF v_key IS NOT NULL THEN
    INSERT INTO comprobante_payment_replace_requests (business_id, user_id, op, idempotency_key, request_hash, comprobante_id, source_payment_set_hash, status)
      VALUES (p_business_id, v_actor_user_id, 'payment_replacement', v_key, v_hash, p_comprobante_id, v_set_hash_before, 'processing')
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req_id;
    IF v_req_id IS NULL THEN
      SELECT * INTO v_existing FROM comprobante_payment_replace_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
        RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.'); END IF;
      IF v_existing.status IN ('stale_source','processing') THEN
        RETURN jsonb_build_object('ok', false, 'error_code','PAYMENT_SET_CHANGED', 'error', 'El cobro cambió mientras se procesaba. Volvé a intentarlo'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'new_payment_id', v_existing.new_payment_id);
    END IF;
  END IF;

  -- 9. LOCKS: comprobante y TODOS los pagos vivos, en orden determinista.
  PERFORM 1 FROM comprobantes WHERE id=p_comprobante_id AND business_id=p_business_id FOR UPDATE;
  PERFORM 1 FROM comprobante_payments WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND replaced_at IS NULL
    ORDER BY id FOR UPDATE;

  -- 9.5 (6F.4a) Estado canonico RELEIDO bajo el lock: si la anulacion se commiteo
  -- mientras esperabamos, se aborta por excepcion para que el rollback al savepoint
  -- deshaga tambien la reserva -> una key nueva no deja request huerfana.
  IF public.is_comprobante_annulled(p_comprobante_id) THEN
    RAISE EXCEPTION 'COMPROBANTE_ANNULLED: el comprobante fue anulado' USING ERRCODE='42501';
  END IF;

  -- 10. Recalcular el conjunto vivo bajo lock: si cambio, abortar sin escribir.
  SELECT encode(extensions.digest(COALESCE(jsonb_agg(e ORDER BY e->>'id')::text,'[]'), 'sha256'),'hex')
    INTO v_set_hash_after
    FROM (SELECT jsonb_build_object('id',id,'amount',round(COALESCE(amount,0),2),'amount_ars',round(COALESCE(amount_ars,0),2),
                 'method',payment_method,'currency',currency,'exchange_rate',round(COALESCE(exchange_rate,1),6),
                 'provider',payment_provider,'commission',round(COALESCE(commission_amount,0),2),'date',date) AS e
            FROM comprobante_payments WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND replaced_at IS NULL) s;
  IF v_set_hash_after IS DISTINCT FROM v_set_hash_before THEN
    -- 6F.3a: se deja EVIDENCIA terminal del intento rechazado por concurrencia
    -- (no es una request huerfana). Se retorna (no se RAISE) para que la fila
    -- stale_source persista y un retry de la misma key no vuelva a reemplazar.
    IF v_req_id IS NOT NULL THEN
      UPDATE comprobante_payment_replace_requests
         SET status='stale_source', error_code='PAYMENT_SET_CHANGED'
       WHERE id=v_req_id;
    END IF;
    RETURN jsonb_build_object('ok', false, 'error_code','PAYMENT_SET_CHANGED', 'error', 'El cobro cambió mientras se procesaba. Volvé a intentarlo');
  END IF;

  -- 11. Caja: politica PREEXISTENTE (nuevo pago efectivo o algun cobro vivo efectivo).
  v_needs_caja := (v_method='efectivo')
    OR EXISTS (SELECT 1 FROM financial_movements WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id
               AND type='income' AND source='comprobante' AND reversed_at IS NULL AND metodo_pago='efectivo');
  SELECT id INTO v_caja FROM cajas WHERE business_id=p_business_id AND status='abierta' ORDER BY opened_at DESC LIMIT 1;
  IF v_needs_caja AND v_caja IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'No hay caja abierta para registrar el reemplazo en efectivo'); END IF;

  -- 12. Audit scope E1 (antes de tocar comprobante_payments / movimientos).
  PERFORM public.finance_begin_audit_scope();

  -- 13. Conjunto vivo original (IDs + resumen compacto para auditoria).
  SELECT array_agg(id ORDER BY id),
         jsonb_agg(jsonb_build_object('id',id,'method',payment_method,'amount_ars',round(COALESCE(amount_ars,0),2),'date',date) ORDER BY id)
    INTO v_live_ids, v_orig_summary
    FROM comprobante_payments WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND replaced_at IS NULL;
  v_live_ids := COALESCE(v_live_ids, '{}');

  -- 14. Compensar FM income vivos (expense HOY, caja abierta actual) y marcarlos.
  WITH ins AS (
    INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate,
      source, description, created_by, metodo_pago, comprobante_id, reference_id, reference_type)
    SELECT business_id, v_date, 'expense', currency, amount, amount_ars, exchange_rate,
      'reversal', 'REVERSO cobro (reemplazo)', v_actor_user_id, metodo_pago, comprobante_id, id, 'comprobante_payment_replace'
    FROM financial_movements
    WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND type='income' AND source='comprobante' AND reversed_at IS NULL
    RETURNING id)
  SELECT array_agg(id) INTO v_comp_fm_ids FROM ins;
  UPDATE financial_movements SET reversed_at=now()
  WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND type='income' AND source='comprobante' AND reversed_at IS NULL;

  -- 15. Compensar BFE vivos (income-mirror y comision) conservando economic_class.
  WITH insb AS (
    INSERT INTO business_finance_entries (business_id, date, type, category, description,
      amount, currency, amount_ars, exchange_rate, payment_method, reference_comprobante_id, source, created_by, economic_class)
    SELECT business_id, v_date, type, category, 'REVERSO: '||COALESCE(description,''),
      -amount, currency, -amount_ars, exchange_rate, payment_method, reference_comprobante_id, 'reversal', v_actor_user_id, economic_class
    FROM business_finance_entries
    WHERE reference_comprobante_id=p_comprobante_id AND business_id=p_business_id AND source='comprobante' AND reversed_at IS NULL
    RETURNING id)
  SELECT array_agg(id) INTO v_comp_bfe_ids FROM insb;
  UPDATE business_finance_entries SET reversed_at=now()
  WHERE reference_comprobante_id=p_comprobante_id AND business_id=p_business_id AND source='comprobante' AND reversed_at IS NULL;

  -- 16. Pago sustituto (UNO). trig_comprobante_payment_finance crea su FM/BFE.
  INSERT INTO comprobante_payments (
    comprobante_id, business_id, amount, currency, amount_ars, exchange_rate,
    payment_method, payment_provider, commission_amount, notes, date, created_by
  ) VALUES (
    p_comprobante_id, p_business_id, p_amount, UPPER(COALESCE(p_currency,'ARS')), p_amount_ars, COALESCE(p_exchange_rate,1),
    v_method, v_provider, COALESCE(p_commission_amount,0), v_notes, v_date, v_actor_user_id
  ) RETURNING id INTO v_new_pay;

  -- 17. APPEND-ONLY: marcar los pagos originales (NO se borran) y enlazarlos al
  --     sustituto. El sync trigger recalcula total_cobrado solo con los vivos.
  IF array_length(v_live_ids,1) > 0 THEN
    UPDATE comprobante_payments
      SET replaced_at=now(), replaced_by=v_actor_user_id, replacement_payment_id=v_new_pay
      WHERE id = ANY(v_live_ids);
  END IF;

  -- 18. Cerrar el intento: processing -> completed (transicion unica permitida)
  IF v_key IS NOT NULL THEN
    UPDATE comprobante_payment_replace_requests
       SET status='completed', new_payment_id=v_new_pay
     WHERE id=v_req_id;
  END IF;

  SELECT id INTO v_new_fm  FROM financial_movements WHERE comprobante_id=p_comprobante_id AND business_id=p_business_id AND source='comprobante' AND reversed_at IS NULL LIMIT 1;
  SELECT id INTO v_new_bfe FROM business_finance_entries WHERE reference_comprobante_id=p_comprobante_id AND business_id=p_business_id AND source='comprobante' AND reversed_at IS NULL LIMIT 1;

  -- 19. UN evento explicito (la operacion, no una fila: puede reemplazar varios pagos)
  v_in_audit := true;
  PERFORM finance_log_audit(
    p_business_id, 'payment_replacement', 'comprobantes', p_comprobante_id, 'replace_comprobante_payment',
    v_key, v_notes, v_date, 'comprobante', p_comprobante_id,
    NULL, jsonb_build_object(
      'comprobante_id', p_comprobante_id, 'request_id', v_req_id,
      'original_payment_ids', to_jsonb(v_live_ids), 'original_payments', COALESCE(v_orig_summary,'[]'::jsonb),
      'original_date_min', (SELECT min(date) FROM comprobante_payments WHERE id=ANY(v_live_ids)),
      'original_date_max', (SELECT max(date) FROM comprobante_payments WHERE id=ANY(v_live_ids)),
      'compensating_fm_ids', to_jsonb(COALESCE(v_comp_fm_ids,'{}'::uuid[])),
      'compensating_bfe_ids', to_jsonb(COALESCE(v_comp_bfe_ids,'{}'::uuid[])),
      'new_payment_id', v_new_pay, 'new_financial_movement_id', v_new_fm, 'new_bfe_id', v_new_bfe,
      'new_method', v_method, 'new_amount', round(COALESCE(p_amount,0),2), 'new_amount_ars', round(COALESCE(p_amount_ars,0),2),
      'currency', UPPER(COALESCE(p_currency,'ARS')), 'exchange_rate', round(COALESCE(p_exchange_rate,1),6),
      'provider', v_provider, 'commission_amount', round(COALESCE(p_commission_amount,0),2),
      'replacement_date', v_date, 'replacement_period', to_char(v_date,'YYYY-MM'),
      'caja_id', v_caja, 'request_hash', v_hash, 'source_payment_set_hash', v_set_hash_before));
  v_in_audit := false;

  RETURN jsonb_build_object('ok', true, 'replay', false, 'new_payment_id', v_new_pay);
EXCEPTION WHEN OTHERS THEN
  v_ec := CASE
    WHEN v_in_audit THEN 'AUDIT_FAILED'
    WHEN SQLSTATE = '23505' THEN 'IDEMPOTENCY_CONFLICT'
    WHEN SQLERRM LIKE 'PERIOD_CLOSED%' THEN 'PERIOD_CLOSED'
    WHEN SQLERRM LIKE 'COMPROBANTE_ANNULLED%' THEN 'ALREADY_ANNULLED'
    ELSE 'INTERNAL_ERROR' END;
  IF v_ec = 'IDEMPOTENCY_CONFLICT' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
  END IF;
  RETURN jsonb_build_object('ok', false, 'error_code', v_ec,
    'error', CASE WHEN v_ec='AUDIT_FAILED' THEN 'No se pudo registrar la auditoria de la operacion'
                  WHEN v_ec='PERIOD_CLOSED' THEN SQLERRM
                  WHEN v_ec='ALREADY_ANNULLED' THEN 'El comprobante está anulado'
                  ELSE 'No se pudo completar la operacion' END);
END;
$$;


-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP TRIGGER trg_cp_annulled_guard ON comprobante_payments;
--   DROP FUNCTION comprobante_payments_annulled_guard();
--   Recrear comprobante_annulment_transition_guard() de 20260713250000 (solo
--     bloqueaba la entrada a anulado, con chequeo agregado);
--   Recrear replace_comprobante_payment sin los chequeos 6F.4a (a/b/c);
--   DROP FUNCTION is_comprobante_annulled(uuid), comprobante_state_is_annulled(text,text,text);
-- ============================================================================

