-- ============================================================================
-- P0-CC · CC-C — Capacidad financiera en cuenta corriente + blindaje del saldo.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DEFECTO 1 — `/cuentas` quedó fuera de P0-P6
-- ─────────────────────────────────────────────────────────────────────────────
-- Las tres policies de `accounts` y `account_movements` exigen `is_staff()`:
--
--     is_staff() := current_user_role() IN
--       ('owner','admin','manager','tech','sales','cashier','viewer')
--
-- Es decir: TODOS los roles, `viewer` incluido. Eso cierra el aislamiento de
-- TENANT pero no el de CAPACIDAD, exactamente el defecto que P0-P6 cerró en el
-- resto de las tablas financieras. `/cuentas` no entró en aquel lote porque ya
-- tenía un gate —`ProtectedRouteByFeature feature="currentAccounts"`— que
-- PARECÍA uno: pero es del PLAN del negocio, no del ACTOR.
--
-- Medido antes de esta migración, actuando como un perfil `role='viewer'`:
--   leer la deuda de todos los clientes  -> permitido
--   insertar en el ledger                -> permitido
--   UPDATE accounts SET balance = 0      -> permitido
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DEFECTO 2 — `accounts.balance` nunca entró en `ledger_protection`
-- ─────────────────────────────────────────────────────────────────────────────
-- `20260702140000_ledger_protection.sql` revocó UPDATE/DELETE sobre
-- `account_movements`, pero dejó `accounts` con `GRANT ALL` y una policy
-- `FOR ALL`. Y `accounts.balance` no es un cache inocente: el trigger
-- `trigger_account_movement_balance` lo usa como ANCLA del saldo corrido.
--
--     SELECT COALESCE(balance,0) INTO v_prev FROM accounts ... FOR UPDATE;
--     NEW.balance_after := v_prev + NEW.debit - NEW.credit;
--
-- Pisar la columna no falsea un número: corrompe TODOS los movimientos
-- siguientes, para siempre, sin dejar rastro en el ledger ni en la auditoría.
-- CC-0 verificó que en producción nadie lo hizo (0 divergencias entre
-- `balance` y `SUM(debit-credit)`), así que este lockdown cae sobre datos
-- limpios.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ REVOCAR LA COLUMNA Y NO LA TABLA
-- ─────────────────────────────────────────────────────────────────────────────
-- Revocar UPDATE entero rompería algo legítimo: la pantalla edita el límite de
-- crédito y las notas de la cuenta. PostgreSQL permite ser preciso, pero NO por
-- resta: un GRANT de tabla cubre todas las columnas y no se le puede descontar
-- una. Hay que revocar el de tabla y volver a otorgar columna por columna.
--
-- `balance` queda fuera de esa lista, así que un UPDATE del cliente sobre esa
-- columna falla con 42501 —error explícito, no cero filas en silencio—, y el
-- trigger sigue funcionando porque es SECURITY DEFINER y corre como `postgres`.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- CAMBIO DE COMPORTAMIENTO DOCUMENTADO — `manager`
-- ─────────────────────────────────────────────────────────────────────────────
-- Medido sobre `current_user_can('finance')`:
--   owner=t  admin=t  cashier=t   |   manager=f  sales=f  tech=f  viewer=f
--
-- Hoy un `manager` entra a `/cuentas` por `is_staff()`; después de esta
-- migración no, salvo override explícito. NO es una inconsistencia nueva: es
-- alinearse con `/caja` y `/expenses`, que ya exigen `finance` y donde el
-- manager tampoco entra. Se prefiere esa coherencia antes que tocar los
-- defaults de `permissions.ts`, que están fuera del alcance de este lote.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LO QUE NO SE ROMPE
-- ─────────────────────────────────────────────────────────────────────────────
-- Verificado: `create_comprobante_checkout_atomic`, `annul_comprobante_atomic`,
-- `allocate_account_payment_atomic`, `reverse_payment_allocation_atomic`,
-- `record_customer_account_payment_atomic` y `trigger_account_movement_balance`
-- son todas SECURITY DEFINER owned by `postgres`: no pasan por RLS ni por los
-- grants del rol. Un `sales` sin `finance` sigue vendiendo a cuenta corriente
-- desde el POS; lo que pierde es la lectura y la escritura DIRECTAS.
--
-- Las policies conservan las TRES dimensiones: tenant AND plan AND capacidad.
-- Ninguna se relaja.
-- ============================================================================

BEGIN;

-- ── 1. account_movements — capacidad, no sólo pertenencia ───────────────────
-- Sólo existen estas dos policies (auditado: 3 en total entre ambas tablas,
-- todas PERMISSIVE sobre {public}). No queda ninguna laxa que las OR-ee.
DROP POLICY IF EXISTS "account_movements_select" ON "public"."account_movements";
DROP POLICY IF EXISTS "account_movements_insert" ON "public"."account_movements";

CREATE POLICY "account_movements_select" ON "public"."account_movements"
  FOR SELECT
  USING (
    "public"."current_business_id"() = "business_id"
    AND "public"."current_user_can"('finance')
    AND "public"."business_has_feature"('currentAccounts')
  );

-- El INSERT directo sigue existiendo sólo para deuda manual y ajustes; CC-D les
-- da su RPC y CC-E revoca esto por completo.
CREATE POLICY "account_movements_insert" ON "public"."account_movements"
  FOR INSERT
  WITH CHECK (
    "public"."current_business_id"() = "business_id"
    AND "public"."current_user_can"('finance')
    AND "public"."business_has_feature"('currentAccounts')
  );

-- ── 2. accounts — se parte la policy FOR ALL ────────────────────────────────
-- `FOR ALL` cubría también UPDATE y DELETE. Se reemplaza por policies
-- explícitas y NO se crea ninguna de DELETE: una cuenta con historial contable
-- no se borra.
DROP POLICY IF EXISTS "accounts_plan" ON "public"."accounts";

CREATE POLICY "accounts_select" ON "public"."accounts"
  FOR SELECT
  USING (
    "public"."current_business_id"() = "business_id"
    AND "public"."current_user_can"('finance')
    AND "public"."business_has_feature"('currentAccounts')
  );

CREATE POLICY "accounts_insert" ON "public"."accounts"
  FOR INSERT
  WITH CHECK (
    "public"."current_business_id"() = "business_id"
    AND "public"."current_user_can"('finance')
    AND "public"."business_has_feature"('currentAccounts')
  );

-- UPDATE existe sólo para los metadatos. Qué columnas se pueden tocar lo decide
-- el GRANT de abajo, no esta policy.
CREATE POLICY "accounts_update_meta" ON "public"."accounts"
  FOR UPDATE
  USING (
    "public"."current_business_id"() = "business_id"
    AND "public"."current_user_can"('finance')
    AND "public"."business_has_feature"('currentAccounts')
  )
  WITH CHECK (
    "public"."current_business_id"() = "business_id"
    AND "public"."current_user_can"('finance')
    AND "public"."business_has_feature"('currentAccounts')
  );

-- ── 3. El lockdown de `balance` ─────────────────────────────────────────────
-- Un GRANT de tabla cubre todas las columnas y no admite resta: primero se
-- revoca el de tabla, después se otorga columna por columna. `balance` queda
-- deliberadamente afuera.
REVOKE UPDATE, DELETE ON "public"."accounts" FROM "authenticated";
REVOKE UPDATE, DELETE ON "public"."accounts" FROM "anon";
REVOKE ALL           ON "public"."accounts" FROM "anon";

GRANT UPDATE ("entity_name", "entity_phone", "credit_limit", "notes", "updated_at")
  ON "public"."accounts" TO "authenticated";

-- ── 4. Guard de capacidad DENTRO de la RPC de cobro ─────────────────────────
-- La RPC es SECURITY DEFINER: no pasa por RLS, así que la policy de arriba no
-- la cubre. Sin este guard, un `viewer` seguiría pudiendo cobrar llamando a
-- PostgREST directamente, aunque no pudiera leer la cuenta.
--
-- Se conserva TODO lo demás intacto: normalización CC-A, idempotencia, hash,
-- sobrepago, período, auditoría, barrera pg_temp y contrato de errores.
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
  v_method_biz    text;
  v_method_caja   text;
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
  -- 2. Pertenencia al tenant
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=v_user)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=v_user AND COALESCE(is_active,true))) INTO v_is_member;
  IF NOT v_is_member THEN RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin acceso a este negocio'); END IF;
  -- 3. CC-C — CAPACIDAD. Tenant y capacidad son dos preguntas distintas: un
  --    viewer del negocio pasa la (2) y tiene que fallar acá.
  IF NOT public.current_user_can('finance') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','FORBIDDEN', 'error', 'Sin permiso para operaciones financieras');
  END IF;
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
  SELECT COALESCE(SUM(debit-credit),0) INTO v_debt FROM account_movements WHERE account_id=p_account_id;
  IF p_amount > v_debt + 0.01 THEN RETURN jsonb_build_object('ok', false, 'error_code','OVERPAYMENT', 'error', 'El cobro supera la deuda pendiente'); END IF;
  IF v_method_caja='efectivo' AND p_caja_id IS NULL AND NOT EXISTS (SELECT 1 FROM cajas WHERE business_id=p_business_id AND status='abierta') THEN
    RETURN jsonb_build_object('ok', false, 'error_code','CASH_REGISTER_NOT_OPEN', 'error', 'No hay caja abierta para registrar el cobro en efectivo'); END IF;

  v_economic_date := COALESCE(p_date, public.ar_today());

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

  BEGIN
    PERFORM public.assert_period_open(p_business_id, v_economic_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'PERIOD_CLOSED%' THEN RETURN jsonb_build_object('ok', false, 'error_code','PERIOD_CLOSED', 'error', SQLERRM);
    ELSIF SQLERRM LIKE 'INVALID_FINANCE_CONTEXT%' THEN RETURN jsonb_build_object('ok', false, 'error_code','INVALID_FINANCE_CONTEXT', 'error', SQLERRM);
    ELSE RAISE; END IF;
  END;

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

  PERFORM public.finance_begin_audit_scope();

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

  SELECT balance_after INTO v_new_balance FROM account_movements WHERE id=v_mov_id;

  IF v_key IS NOT NULL THEN UPDATE account_payment_requests SET movement_id=v_mov_id WHERE id=v_req_id; END IF;

  v_stage := 'audit';
  PERFORM finance_log_audit(
    p_business_id, 'customer_account_payment', 'account_movements', v_mov_id, 'record_customer_account_payment_atomic',
    v_key, p_description, v_economic_date, 'account', p_account_id,
    NULL, jsonb_build_object('account_id', p_account_id, 'amount', p_amount, 'currency','ARS', 'amount_ars', p_amount,
      'method', v_method_biz, 'method_caja', v_method_caja, 'method_raw', v_method,
      'caja_id', p_caja_id, 'financial_movement_id', v_fm_id, 'bfe_id', v_bfe_id,
      'prev_debt', v_debt, 'new_debt', v_new_balance));

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

-- ── 5. Postcondiciones ──────────────────────────────────────────────────────
DO $post$
DECLARE v_n int;
BEGIN
  -- 5.1 NINGUNA policy de estas tablas puede seguir usando is_staff().
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename IN ('accounts','account_movements')
     AND COALESCE(qual,'')||COALESCE(with_check,'') LIKE '%is_staff%';
  IF v_n > 0 THEN RAISE EXCEPTION 'CC-C: quedaron % policies con is_staff()', v_n; END IF;

  -- 5.2 TODAS exigen la capacidad. Las policies PERMISSIVE se OR-ean: una sola
  --     laxa anularía a las demás, así que se exige que NINGUNA lo sea.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename IN ('accounts','account_movements')
     AND COALESCE(qual,'')||COALESCE(with_check,'') NOT LIKE '%current_user_can%';
  IF v_n > 0 THEN RAISE EXCEPTION 'CC-C: % policies sin current_user_can()', v_n; END IF;

  -- 5.3 Y todas conservan tenant + plan.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename IN ('accounts','account_movements')
     AND (COALESCE(qual,'')||COALESCE(with_check,'') NOT LIKE '%current_business_id%'
       OR COALESCE(qual,'')||COALESCE(with_check,'') NOT LIKE '%currentAccounts%');
  IF v_n > 0 THEN RAISE EXCEPTION 'CC-C: % policies perdieron tenant o plan', v_n; END IF;

  -- 5.4 No puede existir una policy de DELETE sobre accounts.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='accounts' AND cmd IN ('DELETE','ALL')) THEN
    RAISE EXCEPTION 'CC-C: accounts no puede tener policy de DELETE ni FOR ALL'; END IF;

  -- 5.5 El lockdown del saldo: sin UPDATE de tabla, sin UPDATE de la columna.
  IF has_table_privilege('authenticated', 'public.accounts', 'DELETE') THEN
    RAISE EXCEPTION 'CC-C: authenticated conserva DELETE sobre accounts'; END IF;
  IF has_column_privilege('authenticated', 'public.accounts', 'balance', 'UPDATE') THEN
    RAISE EXCEPTION 'CC-C: authenticated todavía puede escribir accounts.balance'; END IF;
  -- …pero los metadatos siguen siendo editables: el lockdown no puede romper
  -- la edición del límite de crédito.
  IF NOT has_column_privilege('authenticated', 'public.accounts', 'credit_limit', 'UPDATE') THEN
    RAISE EXCEPTION 'CC-C: se rompió la edición de credit_limit'; END IF;
  IF NOT has_column_privilege('authenticated', 'public.accounts', 'notes', 'UPDATE') THEN
    RAISE EXCEPTION 'CC-C: se rompió la edición de notes'; END IF;

  -- 5.6 anon no toca nada.
  IF has_table_privilege('anon', 'public.accounts', 'SELECT') THEN
    RAISE EXCEPTION 'CC-C: anon conserva SELECT sobre accounts'; END IF;

  -- 5.7 La RPC conserva la barrera pg_temp y ahora exige capacidad.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='record_customer_account_payment_atomic'
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
       AND p.prosrc LIKE '%current_user_can(''finance'')%'
  ) THEN RAISE EXCEPTION 'CC-C: la RPC perdió la barrera pg_temp o el guard de capacidad'; END IF;

  RAISE NOTICE 'CC-C OK: capacidad exigida y accounts.balance blindado.';
END $post$;

COMMIT;

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP POLICY accounts_select/accounts_insert/accounts_update_meta ON accounts;
--   CREATE POLICY "accounts_plan" ON accounts USING (... is_staff() ...) WITH CHECK (...);
--   GRANT UPDATE, DELETE ON accounts TO authenticated;
--   Restaurar account_movements_select/_insert con is_staff();
--   Restaurar la RPC desde 20260829120000_p0cc_a_normalize_payment_method.sql.
-- ============================================================================
