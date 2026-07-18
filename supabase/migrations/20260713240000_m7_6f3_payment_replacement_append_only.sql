-- ============================================================================
-- M7 (Bloque 6F.3) — replace_comprobante_payment APPEND-ONLY.
--
-- ANTES: la RPC hacia `DELETE FROM comprobante_payments` -> destruia la fila
-- original (metodo/provider/comision/fecha) y `v_comprobantes_full.medios_de_pago`
-- pasaba a mostrar solo el metodo nuevo, como si siempre se hubiera cobrado asi.
-- (El ledger FM/BFE ya era append-only y el periodo original ya quedaba intacto.)
--
-- AHORA: las filas originales se CONSERVAN y se marcan como reemplazadas; solo
-- las vivas (replaced_at IS NULL) cuentan para el estado actual. La cadena de
-- reemplazos queda auditable (cada fila apunta a su sustituta inmediata).
--
-- Incluye ademas los aditivos M7 del lote: actor canonico, guard del periodo de
-- la operacion nueva, idempotencia durable server-side, snapshot del conjunto de
-- pagos vivos (PAYMENT_SET_CHANGED), locks deterministas, audit scope E1 + evento
-- unico payment_replacement, error_code aditivo y rollback total.
--
-- ⚠️ EXCEPCION DE ALCANCE (informada): el barrido del §3 encontro que
-- annul_comprobante_atomic SUMA los pagos sin filtrar ("lo REALMENTE registrado").
-- Con filas reemplazadas conservadas, anular DUPLICARIA la reversa. Se aplica el
-- filtro MINIMO (`AND replaced_at IS NULL`) de forma quirurgica. NO es la
-- integracion M7 de annul (eso sigue siendo el Lote 6F.4).
-- ============================================================================

-- ── Part A — esquema append-only (aditivo, sin backfill) ────────────────────
ALTER TABLE "public"."comprobante_payments" ADD COLUMN IF NOT EXISTS "replaced_at" timestamptz;
ALTER TABLE "public"."comprobante_payments" ADD COLUMN IF NOT EXISTS "replaced_by" uuid;
ALTER TABLE "public"."comprobante_payments" ADD COLUMN IF NOT EXISTS "replacement_payment_id" uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='comprobante_payments_replacement_fk') THEN
    ALTER TABLE "public"."comprobante_payments"
      ADD CONSTRAINT "comprobante_payments_replacement_fk"
      FOREIGN KEY ("replacement_payment_id") REFERENCES "public"."comprobante_payments"("id");
  END IF;
  -- no puede apuntar a la propia fila
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='comprobante_payments_replacement_not_self') THEN
    ALTER TABLE "public"."comprobante_payments"
      ADD CONSTRAINT "comprobante_payments_replacement_not_self"
      CHECK ("replacement_payment_id" IS DISTINCT FROM "id");
  END IF;
  -- invariante de estado final: viva (los 3 NULL) o reemplazada (los 3 NOT NULL)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='comprobante_payments_replacement_consistency') THEN
    ALTER TABLE "public"."comprobante_payments"
      ADD CONSTRAINT "comprobante_payments_replacement_consistency"
      CHECK ( ("replaced_at" IS NULL     AND "replaced_by" IS NULL     AND "replacement_payment_id" IS NULL)
           OR ("replaced_at" IS NOT NULL AND "replaced_by" IS NOT NULL AND "replacement_payment_id" IS NOT NULL) );
  END IF;
END $$;
-- indice parcial de pagos VIVOS (sin UNIQUE sobre replacement_payment_id: varias
-- filas de un cobro mixto apuntan al MISMO pago sustituto).
CREATE INDEX IF NOT EXISTS "idx_comprobante_payments_live" ON "public"."comprobante_payments" ("comprobante_id") WHERE "replaced_at" IS NULL;

-- ── Part B — guard de inmutabilidad / validacion de la cadena ───────────────
CREATE OR REPLACE FUNCTION "public"."comprobante_payments_replacement_guard"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.replaced_at IS NOT NULL THEN
      RAISE EXCEPTION 'comprobante_payments: un pago reemplazado no se puede eliminar' USING ERRCODE='0A000';
    END IF;
    RETURN OLD;  -- los pagos VIVOS conservan la semantica previa (annul/delete flows)
  END IF;
  -- metadata de reemplazo: se fija UNA sola vez
  IF OLD.replaced_at IS NOT NULL
     AND (NEW.replaced_at IS DISTINCT FROM OLD.replaced_at
       OR NEW.replaced_by IS DISTINCT FROM OLD.replaced_by
       OR NEW.replacement_payment_id IS DISTINCT FROM OLD.replacement_payment_id) THEN
    RAISE EXCEPTION 'comprobante_payments: la metadata de reemplazo es inmutable' USING ERRCODE='0A000';
  END IF;
  -- una fila reemplazada es inmutable en sus campos economicos
  IF OLD.replaced_at IS NOT NULL
     AND (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.amount_ars IS DISTINCT FROM OLD.amount_ars
       OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
       OR NEW.payment_method IS DISTINCT FROM OLD.payment_method OR NEW.date IS DISTINCT FROM OLD.date
       OR NEW.comprobante_id IS DISTINCT FROM OLD.comprobante_id OR NEW.business_id IS DISTINCT FROM OLD.business_id) THEN
    RAISE EXCEPTION 'comprobante_payments: un pago reemplazado es inmutable' USING ERRCODE='0A000';
  END IF;
  -- la fila sustituta debe ser del MISMO negocio y del MISMO comprobante
  IF NEW.replacement_payment_id IS NOT NULL
     AND NEW.replacement_payment_id IS DISTINCT FROM OLD.replacement_payment_id THEN
    IF NOT EXISTS (SELECT 1 FROM comprobante_payments r WHERE r.id=NEW.replacement_payment_id
                     AND r.business_id=NEW.business_id AND r.comprobante_id=NEW.comprobante_id) THEN
      RAISE EXCEPTION 'comprobante_payments: el pago sustituto debe pertenecer al mismo negocio y comprobante' USING ERRCODE='0A000';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."comprobante_payments_replacement_guard"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_cp_replacement_guard" ON "public"."comprobante_payments";
CREATE TRIGGER "trg_cp_replacement_guard"
  BEFORE UPDATE OR DELETE ON "public"."comprobante_payments"
  FOR EACH ROW EXECUTE FUNCTION "public"."comprobante_payments_replacement_guard"();

-- ── Part C — guard de periodo en UPDATE (excepcion estricta para metadata) ──
-- trg_finance_period_guard_cp es BEFORE **INSERT**: los UPDATE no estaban guardados.
-- Marcar replaced_* en un pago viejo NO es una escritura economica nueva -> permitido.
-- Cualquier cambio ECONOMICO exige que el periodo del pago siga abierto.
CREATE OR REPLACE FUNCTION "public"."finance_period_guard_cp_update"() RETURNS "trigger"
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  -- 6F.3a: WHITELIST ESTRICTA. Solo la metadata de reemplazo puede cambiar sin
  -- guard. Se compara la fila COMPLETA menos esas 3 columnas: cualquier otra
  -- columna -- presente o FUTURA, incluidas las `notes` (historia documental) --
  -- exige que el periodo del pago siga abierto. No depende de enumerar campos
  -- economicos (una columna nueva no se cuela como "metadata" por omision).
  IF to_jsonb(NEW) - 'replaced_at' - 'replaced_by' - 'replacement_payment_id'
     IS NOT DISTINCT FROM
     to_jsonb(OLD) - 'replaced_at' - 'replaced_by' - 'replacement_payment_id' THEN
    RETURN NEW;
  END IF;
  -- Cambio ECONOMICO: el periodo del asiento ORIGINAL debe seguir abierto (no se
  -- puede editar un pago que ya cerro) Y, si se mueve de fecha/negocio, el destino
  -- tampoco puede caer en un periodo cerrado.
  PERFORM public.assert_period_open(OLD.business_id, COALESCE(OLD.date, public.ar_today()));
  IF NEW.date IS DISTINCT FROM OLD.date OR NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    PERFORM public.assert_period_open(NEW.business_id, COALESCE(NEW.date, public.ar_today()));
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."finance_period_guard_cp_update"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_finance_period_guard_cp_upd" ON "public"."comprobante_payments";
CREATE TRIGGER "trg_finance_period_guard_cp_upd"
  BEFORE UPDATE ON "public"."comprobante_payments"
  FOR EACH ROW EXECUTE FUNCTION "public"."finance_period_guard_cp_update"();

-- ── Part D/E/F — barrido de dependencias: filtrar SOLO estado actual ────────
-- Parche quirurgico sobre la definicion viva (evita transcribir cuerpos de 4-16 KB
-- y el riesgo de divergencia). Cada parche ASSERTA que se aplico.
-- Cada parche es IDEMPOTENTE (si ya contiene el filtro, se omite) y ASSERTA que
-- se aplico (si el fragmento original cambiara, falla ruidosamente).
DO $$
DECLARE v_def text; v_new text;
  PROCEDURE_MARKER constant text := 'replaced_at IS NULL';
BEGIN
  -- D. trigger_comprobante_payment_sync -> total_cobrado solo de pagos VIVOS
  v_def := pg_get_functiondef('public.trigger_comprobante_payment_sync'::regproc);
  IF position(PROCEDURE_MARKER in v_def) = 0 THEN
    v_new := replace(v_def,
      'SELECT SUM(amount_ars) FROM public.comprobante_payments
       WHERE comprobante_id = v_comp_id)',
      'SELECT SUM(amount_ars) FROM public.comprobante_payments
       WHERE comprobante_id = v_comp_id AND replaced_at IS NULL)');
    IF v_new = v_def THEN RAISE EXCEPTION '6F.3: no se pudo parchear trigger_comprobante_payment_sync'; END IF;
    EXECUTE v_new;
  END IF;

  -- F1. annul_comprobante_atomic -> "lo REALMENTE registrado" = pagos VIVOS
  --     (EXCEPCION DE ALCANCE informada: filtro minimo, no es la integracion M7)
  v_def := pg_get_functiondef('public.annul_comprobante_atomic'::regproc);
  IF position(PROCEDURE_MARKER in v_def) = 0 THEN
    v_new := replace(v_def,
      'FROM comprobante_payments
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id;',
      'FROM comprobante_payments
    WHERE comprobante_id = v_comp.id AND business_id = v_comp.business_id AND replaced_at IS NULL;');
    IF v_new = v_def THEN RAISE EXCEPTION '6F.3: no se pudo parchear annul_comprobante_atomic'; END IF;
    EXECUTE v_new;
  END IF;

  -- F2. finance_dashboard_summary -> comprobantes_desincronizados sin falso positivo
  v_def := pg_get_functiondef('public.finance_dashboard_summary'::regproc);
  IF position(PROCEDURE_MARKER in v_def) = 0 THEN
    v_new := replace(v_def,
      'FROM comprobante_payments p WHERE p.comprobante_id=c.id',
      'FROM comprobante_payments p WHERE p.comprobante_id=c.id AND p.replaced_at IS NULL');
    IF v_new = v_def THEN RAISE EXCEPTION '6F.3: no se pudo parchear finance_dashboard_summary'; END IF;
    EXECUTE v_new;
  END IF;

  -- F3. finance_pending_historicals -> mismo desync check
  v_def := pg_get_functiondef('public.finance_pending_historicals'::regproc);
  IF position(PROCEDURE_MARKER in v_def) = 0 THEN
    v_new := replace(v_def,
      'FROM comprobante_payments p WHERE p.comprobante_id=c.id',
      'FROM comprobante_payments p WHERE p.comprobante_id=c.id AND p.replaced_at IS NULL');
    IF v_new = v_def THEN RAISE EXCEPTION '6F.3: no se pudo parchear finance_pending_historicals'; END IF;
    EXECUTE v_new;
  END IF;

  -- F4. customer_purchase_history -> metodos VIGENTES de cada compra
  v_def := pg_get_functiondef('public.customer_purchase_history'::regproc);
  IF position(PROCEDURE_MARKER in v_def) = 0 THEN
    v_new := replace(v_def,
      'FROM comprobante_payments cp
        WHERE cp.comprobante_id = c.id',
      'FROM comprobante_payments cp
        WHERE cp.comprobante_id = c.id AND cp.replaced_at IS NULL');
    IF v_new = v_def THEN RAISE EXCEPTION '6F.3: no se pudo parchear customer_purchase_history'; END IF;
    EXECUTE v_new;
  END IF;

  -- E. v_comprobantes_full -> medios_de_pago / total_pagado_calc solo de pagos VIVOS
  v_def := pg_get_viewdef('public.v_comprobantes_full'::regclass);
  IF position(PROCEDURE_MARKER in v_def) = 0 THEN
    v_new := replace(v_def,
      'FROM comprobante_payments
          GROUP BY comprobante_payments.comprobante_id) pay',
      'FROM comprobante_payments
          WHERE comprobante_payments.replaced_at IS NULL
          GROUP BY comprobante_payments.comprobante_id) pay');
    IF v_new = v_def THEN RAISE EXCEPTION '6F.3: no se pudo parchear v_comprobantes_full'; END IF;
    EXECUTE 'CREATE OR REPLACE VIEW public.v_comprobantes_full AS ' || v_new;
  END IF;
END $$;
-- NOTA (decisiones "historia/ledger", SIN filtro): v_finance_effective_comprobantes
-- (EXISTS de liveness: evidencia de venta real), finance_health_check CHECK 5
-- (payments huerfanos: cuenta, no suma), delete_comprobante_with_finance (EXISTS
-- como blocker: si tuvo pagos sigue bloqueado), backfill_remito_fm (script legacy).

-- ── Part G — endurecer comprobante_payment_replace_requests ─────────────────
ALTER TABLE "public"."comprobante_payment_replace_requests" ADD COLUMN IF NOT EXISTS "op" text;
ALTER TABLE "public"."comprobante_payment_replace_requests" ADD COLUMN IF NOT EXISTS "source_payment_set_hash" text;
ALTER TABLE "public"."comprobante_payment_replace_requests" ADD COLUMN IF NOT EXISTS "new_payment_id" uuid;
-- 6F.3a: maquina de estados explicita del INTENTO.
--   processing    = reservado, sin resultado aun
--   completed     = reemplazo aplicado (new_payment_id fijado)
--   stale_source  = rechazado por concurrencia (el conjunto vivo cambio) -> NO es
--                   una request huerfana: es evidencia de un intento rechazado.
-- status NULL = fila LEGACY (M6, ya desplegado): reemplazo completado con la
-- semantica previa. Sin backfill.
ALTER TABLE "public"."comprobante_payment_replace_requests" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."comprobante_payment_replace_requests" ADD COLUMN IF NOT EXISTS "error_code" text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='cpr_requests_status_check') THEN
    ALTER TABLE "public"."comprobante_payment_replace_requests" ADD CONSTRAINT "cpr_requests_status_check"
      CHECK (
        "status" IS NULL                                                                            -- legacy M6
        OR ("status"='processing'   AND "new_payment_id" IS NULL     AND "error_code" IS NULL)
        OR ("status"='completed'    AND "new_payment_id" IS NOT NULL AND "error_code" IS NULL)
        OR ("status"='stale_source' AND "new_payment_id" IS NULL     AND "error_code"='PAYMENT_SET_CHANGED')
      );
  END IF;
END $$;
DROP POLICY IF EXISTS "cpr_requests_select" ON "public"."comprobante_payment_replace_requests";
DROP POLICY IF EXISTS "comprobante_payment_replace_requests_select" ON "public"."comprobante_payment_replace_requests";
REVOKE ALL ON "public"."comprobante_payment_replace_requests" FROM PUBLIC, "anon", "authenticated";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."comprobante_payment_replace_requests" FROM "service_role";
GRANT SELECT, INSERT ON "public"."comprobante_payment_replace_requests" TO "service_role";

CREATE OR REPLACE FUNCTION "public"."comprobante_payment_replace_requests_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '% es append-only: DELETE no permitido', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.op IS DISTINCT FROM OLD.op
     OR NEW.comprobante_id IS DISTINCT FROM OLD.comprobante_id
     OR NEW.source_payment_set_hash IS DISTINCT FROM OLD.source_payment_set_hash THEN
    RAISE EXCEPTION '%: el registro de reemplazo es inmutable', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF OLD.new_payment_id IS NOT NULL AND NEW.new_payment_id IS DISTINCT FROM OLD.new_payment_id THEN
    RAISE EXCEPTION '%: new_payment_id ya fijado es inmutable', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  IF NEW.new_payment_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM comprobante_payments p WHERE p.id=NEW.new_payment_id
        AND p.business_id=NEW.business_id AND p.comprobante_id=NEW.comprobante_id) THEN
    RAISE EXCEPTION '%: el pago sustituto no pertenece al negocio/comprobante', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  -- 6F.3a: transiciones permitidas. Terminal = completed / stale_source / legacy(NULL).
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IS NULL THEN
      RAISE EXCEPTION '%: una request legacy es terminal', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
    IF OLD.status IN ('completed','stale_source') THEN
      RAISE EXCEPTION '%: % es un estado terminal (no admite transiciones)', TG_TABLE_NAME, OLD.status USING ERRCODE='0A000'; END IF;
    IF NOT (OLD.status='processing' AND NEW.status IN ('completed','stale_source')) THEN
      RAISE EXCEPTION '%: transicion de estado no permitida (% -> %)', TG_TABLE_NAME, OLD.status, NEW.status USING ERRCODE='0A000'; END IF;
  END IF;
  IF OLD.error_code IS NOT NULL AND NEW.error_code IS DISTINCT FROM OLD.error_code THEN
    RAISE EXCEPTION '%: error_code ya fijado es inmutable', TG_TABLE_NAME USING ERRCODE='0A000'; END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION "public"."comprobante_payment_replace_requests_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_cpr_requests_immutable" ON "public"."comprobante_payment_replace_requests";
CREATE TRIGGER "trg_cpr_requests_immutable"
  BEFORE UPDATE OR DELETE ON "public"."comprobante_payment_replace_requests"
  FOR EACH ROW EXECUTE FUNCTION "public"."comprobante_payment_replace_requests_immutable"();

-- ── Part H — RPC append-only ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.replace_comprobante_payment(p_comprobante_id uuid, p_business_id uuid, p_payment_method text, p_amount numeric, p_amount_ars numeric, p_currency text, p_exchange_rate numeric, p_notes text, p_user_id uuid, p_commission_amount numeric DEFAULT 0, p_payment_provider text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    ELSE 'INTERNAL_ERROR' END;
  IF v_ec = 'IDEMPOTENCY_CONFLICT' THEN
    RETURN jsonb_build_object('ok', false, 'error_code','IDEMPOTENCY_CONFLICT', 'error', 'IDEMPOTENCY_CONFLICT', 'message', 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
  END IF;
  RETURN jsonb_build_object('ok', false, 'error_code', v_ec,
    'error', CASE WHEN v_ec='AUDIT_FAILED' THEN 'No se pudo registrar la auditoria de la operacion'
                  WHEN v_ec='PERIOD_CLOSED' THEN SQLERRM
                  ELSE 'No se pudo completar la operacion' END);
END;
$function$;

-- ============================================================================
-- ROLLBACK (documentado): revertir las 6 funciones/vista parcheadas a su version
-- previa (quitar 'AND replaced_at IS NULL'); DROP triggers trg_cp_replacement_guard,
-- trg_finance_period_guard_cp_upd, trg_cpr_requests_immutable + sus funciones;
-- ALTER comprobante_payments DROP COLUMN replaced_at/replaced_by/replacement_payment_id
-- (+ constraints e indice parcial); recrear replace_comprobante_payment M6 (con DELETE);
-- ALTER comprobante_payment_replace_requests DROP COLUMN op/source_payment_set_hash/
-- new_payment_id; restaurar policy/GRANT SELECT a authenticated.
-- ============================================================================
