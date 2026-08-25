-- ============================================================================
-- P0-CC · CC-A — Normalización SERVER-SIDE del método de cobro de cuenta corriente.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EL DEFECTO
-- ─────────────────────────────────────────────────────────────────────────────
-- `record_customer_account_payment_atomic` persistía el método de pago CRUDO,
-- tal como venía del cliente:
--
--     v_method := NULLIF(btrim(COALESCE(p_payment_method,'')), '');
--     INSERT INTO financial_movements (..., metodo_pago) VALUES (..., v_method);
--
-- Pero el arqueo (`close_cash_session_atomic`) sólo conoce CUATRO buckets:
--
--     efectivo | transferencia | tarjeta | usd
--
-- y `ModalPagarCC` ofrecía `debito` / `credito`. Un cobro con esos métodos
-- creaba un financial_movement atado a la caja que NO caía en ningún bucket:
-- la plata quedaba fuera del arqueo, y el cierre marcaba una diferencia
-- fantasma. `COALESCE(metodo_pago,'efectivo')` sólo rescata el NULL, no un
-- string desconocido.
--
-- El POS NO tiene este problema porque su trigger sobre `comprobante_payments`
-- MAPEA `payment_method` -> CajaMethod antes de escribir. La cuenta corriente
-- se escribió después, sin ese mapeo. Esta migración cierra esa asimetría.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FAIL-CLOSED, NO `ELSE 'efectivo'`
-- ─────────────────────────────────────────────────────────────────────────────
-- El trigger del POS termina en `ELSE 'efectivo'`. Para la cuenta corriente eso
-- NO se replica a propósito: convertir un método desconocido en efectivo es
-- inventar un ingreso de caja que quizá nunca ocurrió, y es exactamente la
-- clase de fallback silencioso que produjo este lote.
--
-- Acá el conjunto de alias aceptados es CERRADO. Cualquier otra cosa devuelve
-- NULL y la RPC corta con INVALID_PAYMENT_METHOD ANTES de escribir una sola
-- fila: 0 account_movement, 0 financial_movement, 0 BFE.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DOS FUNCIONES, PORQUE SON DOS PREGUNTAS DISTINTAS
-- ─────────────────────────────────────────────────────────────────────────────
-- Se replica el MISMO desdoblamiento que ya hace el POS:
--
--   canonical_cc_payment_method() -> método de NEGOCIO (tarjeta_debito).
--       Va a business_finance_entries.payment_method y a la auditoría, donde
--       importa distinguir débito de crédito.
--
--   normalize_cc_payment_method() -> bucket de CAJA (tarjeta).
--       Va a financial_movements.metodo_pago, que es lo único que el arqueo
--       sabe leer.
--
-- Guardar el bucket grueso en el BFE perdería información de negocio; guardar
-- el método fino en el FM es justamente el bug que se está cerrando.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ARS ONLY
-- ─────────────────────────────────────────────────────────────────────────────
-- `usd` NO es un alias aceptado. La cuenta corriente no tiene columna de moneda
-- ni de cotización (`account_movements` no las tiene), y la RPC fija ARS con
-- exchange_rate=1. Aceptar 'usd' produciría un movimiento de caja en el bucket
-- USD por un importe que en realidad está en pesos. Se rechaza explícitamente.
-- Ver handoff CC-MULTICURRENCY.
--
-- `mixto` tampoco se acepta: esta RPC registra UN cobro con UN método. Un cobro
-- mixto son N cobros, no un método llamado "mixto".
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EL HASH DE IDEMPOTENCIA NO CAMBIA
-- ─────────────────────────────────────────────────────────────────────────────
-- El hash sigue calculándose sobre el método CRUDO recibido, igual que antes.
-- Si se hashease el valor normalizado, toda `idempotency_key` ya emitida y
-- todavía viva pasaría a calcular un hash distinto, y un reintento legítimo
-- posterior al deploy devolvería IDEMPOTENCY_CONFLICT en lugar de un replay.
-- Es un cambio de comportamiento innecesario: se preserva el hash tal cual.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ALCANCE
-- ─────────────────────────────────────────────────────────────────────────────
-- ADITIVA y COMPATIBLE con el frontend desplegado: 'efectivo' y 'transferencia'
-- (lo único que el frontend productivo manda hoy) siguen funcionando idénticos.
-- 'debito'/'credito' pasan de romper el arqueo a mapear a 'tarjeta'.
--
-- NO toca datos históricos. NO recalcula cajas. NO cambia RLS ni grants de
-- tablas. NO toca el modelo de pertenencia (eso es CC-C).
-- CC-0 midió producción: 0 movimientos con método fuera de catálogo. Este
-- normalizador es PREVENTIVO, no correctivo.
-- ============================================================================

BEGIN;

-- ── 1. Método de NEGOCIO canónico ───────────────────────────────────────────
-- Devuelve un valor del catálogo `MedioPago` del repo, o NULL si no se conoce.
CREATE OR REPLACE FUNCTION "public"."canonical_cc_payment_method"(p_method text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE lower(btrim(COALESCE(p_method, '')))
    WHEN 'efectivo'        THEN 'efectivo'
    WHEN 'transferencia'   THEN 'transferencia'
    -- Alias legacy que emitía ModalPagarCC antes de CC-A.
    WHEN 'debito'          THEN 'tarjeta_debito'
    WHEN 'credito'         THEN 'tarjeta_credito'
    WHEN 'tarjeta_debito'  THEN 'tarjeta_debito'
    WHEN 'tarjeta_credito' THEN 'tarjeta_credito'
    -- 'tarjeta' a secas no dice si fue débito o crédito: se conserva como tal.
    WHEN 'tarjeta'         THEN 'tarjeta'
    WHEN 'qr'              THEN 'qr'
    WHEN 'mercado_pago'    THEN 'qr'
    WHEN 'otro'            THEN 'otro'
    ELSE NULL   -- fail-closed: incluye '', NULL, 'usd', 'mixto', 'pepe', …
  END;
$$;

COMMENT ON FUNCTION "public"."canonical_cc_payment_method"(text) IS
  'P0-CC CC-A. Alias de método de cobro de CC -> método de NEGOCIO (catálogo MedioPago). '
  'NULL = método desconocido (fail-closed). No acepta usd ni mixto: la CC es ARS-only y de un solo método por cobro.';

-- ── 2. Bucket de CAJA ───────────────────────────────────────────────────────
-- Devuelve el CajaMethod que entiende close_cash_session_atomic, o NULL.
-- Deliberadamente NO existe un ELSE 'efectivo'.
CREATE OR REPLACE FUNCTION "public"."normalize_cc_payment_method"(p_method text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE public.canonical_cc_payment_method(p_method)
    WHEN 'efectivo'        THEN 'efectivo'
    WHEN 'transferencia'   THEN 'transferencia'
    WHEN 'tarjeta_debito'  THEN 'tarjeta'
    WHEN 'tarjeta_credito' THEN 'tarjeta'
    WHEN 'tarjeta'         THEN 'tarjeta'
    WHEN 'qr'              THEN 'tarjeta'
    WHEN 'otro'            THEN 'tarjeta'
    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION "public"."normalize_cc_payment_method"(text) IS
  'P0-CC CC-A. Método de cobro de CC -> bucket de caja (efectivo|transferencia|tarjeta). '
  'NULL = desconocido: la RPC corta con INVALID_PAYMENT_METHOD. Sin ELSE efectivo a propósito: '
  'convertir lo desconocido en efectivo inventa un ingreso de caja.';

-- EXECUTE a PUBLIC es el default de PostgreSQL: hay que revocarlo explícitamente.
REVOKE ALL ON FUNCTION "public"."canonical_cc_payment_method"(text) FROM PUBLIC, "anon";
REVOKE ALL ON FUNCTION "public"."normalize_cc_payment_method"(text)  FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."canonical_cc_payment_method"(text) TO "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."normalize_cc_payment_method"(text)  TO "authenticated", "service_role";
ALTER FUNCTION "public"."canonical_cc_payment_method"(text) OWNER TO "postgres";
ALTER FUNCTION "public"."normalize_cc_payment_method"(text)  OWNER TO "postgres";

-- ── 3. RPC de cobro: normalizar ANTES de escribir ───────────────────────────
-- Se reemplaza el cuerpo COMPLETO tal como está desplegado (incluye la barrera
-- pg_temp de M7 7C.1: search_path = 'public','pg_temp' con pg_temp AL FINAL).
-- Cambios respecto de la versión viva, y sólo estos:
--   a) v_method_biz / v_method_caja derivados de los normalizadores;
--   b) guard INVALID_PAYMENT_METHOD en el bloque 4 (antes de toda escritura);
--   c) el guard de efectivo usa el bucket normalizado;
--   d) financial_movements.metodo_pago  <- v_method_caja  (era el crudo);
--   e) business_finance_entries.payment_method <- v_method_biz;
--   f) la auditoría registra ambos.
-- Todo lo demás (idempotencia, hash, sobrepago, período, auditoría, scope,
-- pertenencia, contrato de errores) queda EXACTAMENTE igual.
CREATE OR REPLACE FUNCTION "public"."record_customer_account_payment_atomic"(
  p_business_id uuid, p_account_id uuid, p_amount numeric, p_description text, p_user_id uuid,
  p_payment_method text, p_date date, p_caja_id uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  c_key_max       constant int := 200;
  v_user          uuid := auth.uid();
  v_is_member     boolean := false;
  v_account       accounts%ROWTYPE;
  v_debt          numeric;
  v_new_balance   numeric;
  v_economic_date date;
  v_method        text := NULLIF(btrim(COALESCE(p_payment_method,'')), '');  -- CRUDO: sólo para el hash
  v_method_biz    text;   -- método de negocio canónico  -> BFE + auditoría
  v_method_caja   text;   -- bucket de caja              -> financial_movements
  v_key           text := NULLIF(btrim(COALESCE(p_idempotency_key,'')), '');
  v_hash          text;
  v_existing      account_payment_requests%ROWTYPE;
  v_req_id        uuid;
  v_mov_id        uuid;
  v_fm_id         uuid;
  v_bfe_id        uuid;
  v_stage         text := 'init';
BEGIN
  -- 1. Autenticación
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error_code','UNAUTHORIZED', 'error', 'No autenticado'); END IF;
  -- 2/3. Pertenencia (modelo M6: cualquier perfil activo del negocio). CC-C endurece esto.
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;
  -- 4. Validación del payload
  IF v_key IS NOT NULL AND length(v_key) > c_key_max THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La clave de idempotencia es demasiado larga'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'El monto debe ser mayor a 0'); END IF;

  -- 4b. CC-A — método de pago: fail-closed ANTES de cualquier escritura.
  v_method_biz  := public.canonical_cc_payment_method(p_payment_method);
  v_method_caja := public.normalize_cc_payment_method(p_payment_method);
  IF v_method_biz IS NULL OR v_method_caja IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code','INVALID_PAYMENT_METHOD',
      'error', 'Método de cobro no reconocido. La cuenta corriente acepta efectivo, transferencia, débito, crédito, QR u otro, en pesos.');
  END IF;

  SELECT * INTO v_account FROM accounts WHERE id=p_account_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error_code','ACCOUNT_NOT_FOUND', 'error', 'Cuenta inexistente'); END IF;
  IF v_account.type <> 'cliente' THEN RETURN jsonb_build_object('ok', false, 'error_code','VALIDATION_ERROR', 'error', 'La cuenta no es de cliente'); END IF;
  -- Deuda server-side desde el ledger; el cobro no puede superarla (sobrepago)
  SELECT COALESCE(SUM(debit-credit),0) INTO v_debt FROM account_movements WHERE account_id=p_account_id;
  IF p_amount > v_debt + 0.01 THEN RETURN jsonb_build_object('ok', false, 'error_code','OVERPAYMENT', 'error', 'El cobro supera la deuda pendiente'); END IF;
  -- Efectivo requiere caja abierta (ahora sobre el bucket normalizado)
  IF v_method_caja='efectivo' AND p_caja_id IS NULL AND NOT EXISTS (SELECT 1 FROM cajas WHERE business_id=p_business_id AND status='abierta') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'No hay caja abierta para registrar el cobro en efectivo'); END IF;

  -- 5. Fecha económica única
  v_economic_date := COALESCE(p_date, public.ar_today());

  -- 6. Replay previo (hash canónico jsonb). Se hashea el método CRUDO: cambiarlo
  --    invalidaría las idempotency_key ya emitidas. Ver cabecera.
  IF v_key IS NOT NULL THEN
    v_hash := encode(extensions.digest(jsonb_build_object(
      'op','customer_account_payment', 'business_id',p_business_id, 'account_id',p_account_id,
      'amount',round(p_amount,2), 'currency','ARS', 'method',v_method, 'caja',p_caja_id,
      'economic_date',v_economic_date, 'description',NULLIF(btrim(p_description),''))::text, 'sha256'), 'hex');
    SELECT * INTO v_existing FROM account_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
    IF FOUND THEN
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'account_movement_id', v_existing.movement_id);
    END IF;
  END IF;

  -- 7. Guard de período
  BEGIN
    PERFORM public.assert_period_open(p_business_id, v_economic_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF;
  END;

  -- 8. Reserva idempotente race-safe
  IF v_key IS NOT NULL THEN
    INSERT INTO account_payment_requests (business_id, user_id, op, idempotency_key, request_hash)
      VALUES (p_business_id, v_user, 'customer_account_payment', v_key, v_hash)
      ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id INTO v_req_id;
    IF v_req_id IS NULL THEN
      SELECT * INTO v_existing FROM account_payment_requests WHERE business_id=p_business_id AND idempotency_key=v_key;
      IF v_existing.request_hash IS DISTINCT FROM v_hash THEN RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta clave ya fue utilizada con datos diferentes'); END IF;
      RETURN jsonb_build_object('ok', true, 'replay', true, 'account_movement_id', v_existing.movement_id);
    END IF;
  END IF;

  -- 9. Scope de auditoría (E2: suprime el backstop de account_movements)
  PERFORM public.finance_begin_audit_scope();

  -- 10. Escrituras económicas (persisten v_economic_date). balance_after lo pone el trigger.
  v_stage := 'write';
  INSERT INTO account_movements (business_id, account_id, date, type, description, debit, credit, balance_after, reference_type, created_by)
    VALUES (p_business_id, p_account_id, v_economic_date, 'pago',
      COALESCE(NULLIF(btrim(p_description),''), 'Cobro de cuenta corriente'), 0, p_amount, 0, 'manual', v_user)
    RETURNING id INTO v_mov_id;
  INSERT INTO financial_movements (business_id, date, type, currency, amount, amount_ars, exchange_rate,
    source, description, created_by, caja_id, metodo_pago, reference_id, reference_type)
    VALUES (p_business_id, v_economic_date, 'income', 'ARS', p_amount, p_amount, 1,
      'cobro_cuenta_corriente', COALESCE(NULLIF(btrim(p_description),''), 'Cobro de cuenta corriente'),
      v_user, p_caja_id, v_method_caja, v_mov_id, 'account_movement')
    RETURNING id INTO v_fm_id;
  INSERT INTO business_finance_entries (business_id, date, type, category, description,
    amount, currency, amount_ars, exchange_rate, payment_method, source, created_by)
    VALUES (p_business_id, v_economic_date, 'income', 'cobro_cuenta_corriente',
      COALESCE(NULLIF(btrim(p_description),''), 'Cobro de cuenta corriente'),
      p_amount, 'ARS', p_amount, 1, v_method_biz, 'cobro_cc', v_user)
    RETURNING id INTO v_bfe_id;

  -- 11. Saldo nuevo canónico (del trigger; no inventado)
  SELECT balance_after INTO v_new_balance FROM account_movements WHERE id=v_mov_id;

  -- 12. Enlace del request
  IF v_key IS NOT NULL THEN UPDATE account_payment_requests SET movement_id=v_mov_id WHERE id=v_req_id; END IF;

  -- 13. Auditoría explícita (un evento)
  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'customer_account_payment', 'account_movements', v_mov_id, 'record_customer_account_payment_atomic',
    v_key, p_description, v_economic_date, 'account', p_account_id,
    NULL, jsonb_build_object('account_id', p_account_id, 'amount', p_amount, 'currency','ARS', 'amount_ars', p_amount,
      'method', v_method_biz, 'method_caja', v_method_caja, 'method_raw', v_method,
      'caja_id', p_caja_id, 'financial_movement_id', v_fm_id, 'bfe_id', v_bfe_id,
      'prev_debt', v_debt, 'new_debt', v_new_balance));

  -- 14. Retorno
  RETURN jsonb_build_object('ok', true, 'replay', false,
    'account_movement_id', v_mov_id, 'financial_movement_id', v_fm_id, 'bfe_id', v_bfe_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false,
    'error_code', CASE WHEN v_stage='audit' THEN 'AUDIT_FAILED' ELSE 'INTERNAL_ERROR' END,
    'error', CASE WHEN v_stage='audit' THEN 'No se pudo registrar la auditoría de la operación'
                  ELSE 'No se pudo completar la operación' END);
END;
$$;

ALTER FUNCTION "public"."record_customer_account_payment_atomic"(uuid,uuid,numeric,text,uuid,text,date,uuid,text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."record_customer_account_payment_atomic"(uuid,uuid,numeric,text,uuid,text,date,uuid,text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."record_customer_account_payment_atomic"(uuid,uuid,numeric,text,uuid,text,date,uuid,text) TO "authenticated","service_role";

-- ── 4. Postcondiciones ──────────────────────────────────────────────────────
-- Corren DENTRO de la transacción explícita: si algo falla, revierte todo.
DO $post$
DECLARE v_bad text;
BEGIN
  -- 4.1 Truth table del bucket de caja.
  IF public.normalize_cc_payment_method('efectivo')        IS DISTINCT FROM 'efectivo'      THEN RAISE EXCEPTION 'CC-A: efectivo'; END IF;
  IF public.normalize_cc_payment_method('transferencia')   IS DISTINCT FROM 'transferencia' THEN RAISE EXCEPTION 'CC-A: transferencia'; END IF;
  IF public.normalize_cc_payment_method('debito')          IS DISTINCT FROM 'tarjeta'       THEN RAISE EXCEPTION 'CC-A: debito'; END IF;
  IF public.normalize_cc_payment_method('credito')         IS DISTINCT FROM 'tarjeta'       THEN RAISE EXCEPTION 'CC-A: credito'; END IF;
  IF public.normalize_cc_payment_method('tarjeta_debito')  IS DISTINCT FROM 'tarjeta'       THEN RAISE EXCEPTION 'CC-A: tarjeta_debito'; END IF;
  IF public.normalize_cc_payment_method('tarjeta_credito') IS DISTINCT FROM 'tarjeta'       THEN RAISE EXCEPTION 'CC-A: tarjeta_credito'; END IF;
  IF public.normalize_cc_payment_method('qr')              IS DISTINCT FROM 'tarjeta'       THEN RAISE EXCEPTION 'CC-A: qr'; END IF;
  IF public.normalize_cc_payment_method('mercado_pago')    IS DISTINCT FROM 'tarjeta'       THEN RAISE EXCEPTION 'CC-A: mercado_pago'; END IF;
  IF public.normalize_cc_payment_method('otro')            IS DISTINCT FROM 'tarjeta'       THEN RAISE EXCEPTION 'CC-A: otro'; END IF;

  -- 4.2 Todo bucket producido pertenece al catálogo del arqueo.
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['efectivo','transferencia','debito','credito',
                               'tarjeta_debito','tarjeta_credito','tarjeta','qr','mercado_pago','otro']) m
     WHERE public.normalize_cc_payment_method(m) NOT IN ('efectivo','transferencia','tarjeta')
  ) THEN RAISE EXCEPTION 'CC-A: un alias aceptado cae fuera del catálogo de caja'; END IF;

  -- 4.3 FAIL-CLOSED: basura, vacío, NULL, usd y mixto deben dar NULL en AMBAS.
  FOR v_bad IN SELECT unnest(ARRAY['', '   ', 'usd', 'USD', 'mixto', 'pepe', 'crypto', 'bizum',
                                   'cuenta_corriente', 'cash', 'tarjetas'])
  LOOP
    IF public.normalize_cc_payment_method(v_bad) IS NOT NULL THEN
      RAISE EXCEPTION 'CC-A: normalize aceptó un método inválido: %', v_bad; END IF;
    IF public.canonical_cc_payment_method(v_bad) IS NOT NULL THEN
      RAISE EXCEPTION 'CC-A: canonical aceptó un método inválido: %', v_bad; END IF;
  END LOOP;
  IF public.normalize_cc_payment_method(NULL) IS NOT NULL THEN RAISE EXCEPTION 'CC-A: NULL debe ser NULL'; END IF;
  IF public.canonical_cc_payment_method(NULL) IS NOT NULL THEN RAISE EXCEPTION 'CC-A: NULL debe ser NULL'; END IF;

  -- 4.4 Case-insensitive y con espacios (el cliente no debe poder colar variantes).
  IF public.normalize_cc_payment_method('  EFECTIVO ') IS DISTINCT FROM 'efectivo' THEN
    RAISE EXCEPTION 'CC-A: no normaliza mayúsculas/espacios'; END IF;

  -- 4.5 El método de negocio nunca degrada débito/crédito a un genérico.
  IF public.canonical_cc_payment_method('debito')  IS DISTINCT FROM 'tarjeta_debito'  THEN RAISE EXCEPTION 'CC-A: biz debito'; END IF;
  IF public.canonical_cc_payment_method('credito') IS DISTINCT FROM 'tarjeta_credito' THEN RAISE EXCEPTION 'CC-A: biz credito'; END IF;

  -- 4.6 Seguridad: sin EXECUTE para anon, con search_path fijado.
  IF has_function_privilege('anon', 'public.normalize_cc_payment_method(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CC-A: anon no puede tener EXECUTE'; END IF;
  IF has_function_privilege('anon', 'public.canonical_cc_payment_method(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CC-A: anon no puede tener EXECUTE'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public'
         AND p.proname IN ('normalize_cc_payment_method','canonical_cc_payment_method')
         AND p.proconfig @> ARRAY['search_path=public, pg_temp']) <> 2 THEN
    RAISE EXCEPTION 'CC-A: search_path no fijado en los dos normalizadores'; END IF;

  -- 4.7 La RPC conserva la barrera pg_temp de M7 7C.1 (pg_temp AL FINAL).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='record_customer_account_payment_atomic'
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN RAISE EXCEPTION 'CC-A: la RPC perdió la barrera pg_temp'; END IF;

  RAISE NOTICE 'CC-A OK: normalizadores fail-closed y RPC recableada.';
END $post$;

COMMIT;

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   Restaurar record_customer_account_payment_atomic desde
--   20260713160000_m7_6c_customer_order_guard.sql (parte B), reaplicando la
--   barrera pg_temp de 20260713310000_m7_7c1a_pgtemp_barrier_all_secdef.sql;
--   DROP FUNCTION IF EXISTS public.normalize_cc_payment_method(text);
--   DROP FUNCTION IF EXISTS public.canonical_cc_payment_method(text);
-- ============================================================================
