-- ============================================================================
-- M7 (Bloque 1a) — finance_audit_log: bitácora financiera central e inmutable
--
-- Contexto: M6 llevó toda operación económica a RPC atómicas y cerró las
-- escrituras directas al mayor. Faltaba una AUDITORÍA central garantizada en la
-- base de datos (no en el frontend). Este es el finance_audit_log que
-- annul_comprobante_atomic.sql:42 y m6-plan.md difieren explícitamente a M7.
--
-- Modelo HÍBRIDO (decisión del owner):
--   (1) finance_log_audit(...)  — helper SECURITY DEFINER que las RPC económicas
--       y las de cierre/reapertura llaman con contexto rico (actor, source_rpc,
--       reason, economic_date, referencias, subconjunto old/new). Marca la
--       evento con contexto. El scope gestionado (m7.audit_managed) lo marca
--       finance_begin_audit_scope() en la RPC, no el helper.
--   (2) finance_audit_backstop() — trigger AFTER INSERT en las DOS superficies de
--       escritura directa que sobreviven a M6 (comprobante_payments E1,
--       account_movements E2). Si la transacción YA fue auditada por el helper,
--       el trigger no duplica; si fue un write directo sin RPC, lo registra.
--
-- Reglas: append-only (sin UPDATE/DELETE para nadie), no se auto-audita, lectura
-- sólo owner/admin, cross-tenant imposible (RLS + ownership), idempotencia
-- delegada a la operación origen (el request_id se persiste para correlación).
-- Aditiva y reversible (DROP).
-- ============================================================================

CREATE TABLE IF NOT EXISTS "public"."finance_audit_log" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"    uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "actor_user_id"  uuid,                 -- auth.uid() al momento; NULL = sistema
  "action"         text NOT NULL,        -- p.ej. create_economic | reversal | annulment | period_close | period_reopen | reconcile | insert
  "entity_table"   text NOT NULL,        -- tabla afectada (financial_movements, comprobante_payments, finance_period_locks, ...)
  "entity_id"      uuid,                 -- fila principal afectada
  "source_rpc"     text,                 -- nombre de la RPC que originó el evento; 'trigger_backstop' si vino del trigger
  "request_id"     text,                 -- idempotency_key / request_hash de la operación origen (correlación)
  "reason"         text,                 -- motivo (obligatorio en reversas/anulaciones/reapertura)
  "economic_date"  date,                 -- fecha económica del asiento (para ligar a período)
  "period_start"   date,                 -- primer día del mes AR que contiene economic_date
  "reference_type" text,
  "reference_id"   uuid,
  "old_data"       jsonb,                -- subconjunto financiero relevante (NO la fila completa, NO secretos)
  "new_data"       jsonb,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  -- Cuando hay request_id (evento de negocio idempotente), action/entity_table
  -- (ya NOT NULL) + entity_id son obligatorios: sostienen el dedup lógico.
  CONSTRAINT "finance_audit_log_reqid_entity_chk"
    CHECK ("request_id" IS NULL OR ("action" IS NOT NULL AND "entity_table" IS NOT NULL AND "entity_id" IS NOT NULL))
);

-- Idempotente para el DB local ya creado (CREATE TABLE IF NOT EXISTS omite el CHECK).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='finance_audit_log_reqid_entity_chk'
                   AND conrelid='public.finance_audit_log'::regclass) THEN
    ALTER TABLE public.finance_audit_log ADD CONSTRAINT finance_audit_log_reqid_entity_chk
      CHECK (request_id IS NULL OR (action IS NOT NULL AND entity_table IS NOT NULL AND entity_id IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_finance_audit_log_biz_created"
  ON "public"."finance_audit_log" ("business_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_finance_audit_log_entity"
  ON "public"."finance_audit_log" ("business_id", "entity_table", "entity_id");
CREATE INDEX IF NOT EXISTS "idx_finance_audit_log_period"
  ON "public"."finance_audit_log" ("business_id", "period_start");

-- Deduplicación LÓGICA (no sólo por transacción): un mismo evento de negocio
-- —identificado por (business_id, request_id, action, entity_table, entity_id)—
-- no se registra dos veces aunque la operación origen se reintente/re-emita. Sólo
-- aplica cuando hay request_id (idempotency_key/request_hash de la RPC); los
-- eventos sin request_id (p.ej. cierre de período, ya idempotente en su RPC) no
-- se deduplican por índice. NULL en entity_id → filas distintas (sin dedup), OK.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_finance_audit_log_dedup"
  ON "public"."finance_audit_log" ("business_id", "request_id", "action", "entity_table", "entity_id")
  WHERE "request_id" IS NOT NULL;

COMMENT ON TABLE "public"."finance_audit_log" IS
  'Bitácora financiera central e inmutable (M7). Append-only: sin policies de '
  'UPDATE/DELETE. Poblada por finance_log_audit() (RPCs) + finance_audit_backstop '
  '(trigger sobre comprobante_payments/account_movements). No se audita a sí misma.';

ALTER TABLE "public"."finance_audit_log" ENABLE ROW LEVEL SECURITY;

-- Lectura SÓLO owner/admin del negocio (más restrictiva que el resto del ledger,
-- que permite staff): la auditoría es información sensible de gestión.
DROP POLICY IF EXISTS "finance_audit_log_select" ON "public"."finance_audit_log";
CREATE POLICY "finance_audit_log_select" ON "public"."finance_audit_log"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM businesses WHERE id = finance_audit_log.business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = finance_audit_log.business_id
               AND user_id = auth.uid() AND COALESCE(is_active,true) AND role IN ('owner','admin'))
  );

-- Sin policies de escritura: la única vía es el helper/trigger SECURITY DEFINER.
-- Append-only REAL: ni siquiera service_role puede UPDATE/DELETE. Sólo SELECT/INSERT
-- (el INSERT efectivo lo hace el helper/backstop, owner=postgres).
REVOKE ALL ON "public"."finance_audit_log" FROM PUBLIC, "anon";
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."finance_audit_log" FROM "service_role";
GRANT SELECT ON "public"."finance_audit_log" TO "authenticated";
GRANT SELECT, INSERT ON "public"."finance_audit_log" TO "service_role";

-- Trigger de inmutabilidad: rechaza cualquier UPDATE/DELETE (defensa en profundidad
-- además del revoke de grants). Se aplica a TODO rol no-superusuario.
CREATE OR REPLACE FUNCTION "public"."finance_audit_immutable"() RETURNS "trigger"
    LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finance_audit_log es append-only: % no permitido', TG_OP
    USING ERRCODE = '0A000';  -- feature_not_supported
END;
$$;
ALTER FUNCTION "public"."finance_audit_immutable"() OWNER TO "postgres";
DROP TRIGGER IF EXISTS "trg_finance_audit_immutable" ON "public"."finance_audit_log";
CREATE TRIGGER "trg_finance_audit_immutable"
  BEFORE UPDATE OR DELETE ON "public"."finance_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "public"."finance_audit_immutable"();

-- ── Helper central: finance_log_audit ───────────────────────────────────────
-- SECURITY DEFINER (owner postgres). REVOCADO a authenticated/anon: los clientes
-- NO pueden forjar auditoría; sólo las RPC SECURITY DEFINER (owner postgres) lo
-- invocan. Marca la tx como auditada para que el backstop no duplique.
CREATE OR REPLACE FUNCTION "public"."finance_log_audit"(
  p_business_id    uuid,
  p_action         text,
  p_entity_table   text,
  p_entity_id      uuid    DEFAULT NULL,
  p_source_rpc     text    DEFAULT NULL,
  p_request_id     text    DEFAULT NULL,
  p_reason         text    DEFAULT NULL,
  p_economic_date  date    DEFAULT NULL,
  p_reference_type text    DEFAULT NULL,
  p_reference_id   uuid    DEFAULT NULL,
  p_old_data       jsonb   DEFAULT NULL,
  p_new_data       jsonb   DEFAULT NULL,
  p_actor          uuid    DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_business_id IS NULL OR p_action IS NULL OR p_entity_table IS NULL THEN
    RETURN NULL;  -- nunca romper la operación de negocio por un fallo de auditoría
  END IF;

  -- El scope de auditoría (m7.audit_managed) lo marca finance_begin_audit_scope()
  -- de forma explícita en las RPC gestionadas — NO el helper (auditar != marcar).
  INSERT INTO finance_audit_log (
    business_id, actor_user_id, action, entity_table, entity_id, source_rpc,
    request_id, reason, economic_date, period_start, reference_type, reference_id,
    old_data, new_data
  ) VALUES (
    p_business_id, COALESCE(p_actor, auth.uid()), p_action, p_entity_table, p_entity_id, p_source_rpc,
    p_request_id, p_reason, p_economic_date,
    CASE WHEN p_economic_date IS NULL THEN NULL ELSE date_trunc('month', p_economic_date)::date END,
    p_reference_type, p_reference_id, p_old_data, p_new_data
  )
  -- Dedup lógico: mismo (negocio, request_id, action, entity) → no re-inserta.
  ON CONFLICT ("business_id", "request_id", "action", "entity_table", "entity_id")
    WHERE "request_id" IS NOT NULL
    DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL AND p_request_id IS NOT NULL THEN
    -- Hubo conflicto (evento ya auditado): devolver el id existente, sin duplicar.
    SELECT id INTO v_id FROM finance_audit_log
      WHERE business_id=p_business_id AND request_id=p_request_id AND action=p_action
        AND entity_table=p_entity_table AND entity_id IS NOT DISTINCT FROM p_entity_id
      LIMIT 1;
  END IF;

  RETURN v_id;
  -- SIN "EXCEPTION WHEN OTHERS": no se silencian pérdidas de auditoría. El dedup
  -- esperado ya lo maneja ON CONFLICT DO NOTHING; cualquier error inesperado
  -- propaga a la RPC llamante, cuyo propio manejador lo devuelve como {ok:false}.
END;
$$;

ALTER FUNCTION "public"."finance_log_audit"(uuid,text,text,uuid,text,text,text,date,text,uuid,jsonb,jsonb,uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."finance_log_audit"(uuid,text,text,uuid,text,text,text,date,text,uuid,jsonb,jsonb,uuid) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."finance_log_audit"(uuid,text,text,uuid,text,text,text,date,text,uuid,jsonb,jsonb,uuid) TO "service_role";

-- ── Backstop: trigger AFTER INSERT en las superficies de escritura directa ───
-- Sólo registra si la transacción NO fue ya auditada por el helper (evita doble
-- conteo de los flujos que pasan por RPC). SECURITY DEFINER para poder escribir
-- en finance_audit_log aun cuando el INSERT lo hizo el rol authenticated (E1/E2).
CREATE OR REPLACE FUNCTION "public"."finance_audit_backstop"() RETURNS "trigger"
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_j    jsonb := to_jsonb(NEW);   -- acceso robusto: distintas tablas, distintas columnas
  v_econ date  := NULLIF(v_j->>'date','')::date;
BEGIN
  IF COALESCE(current_setting('m7.audit_managed', true), '0') = '1' THEN
    RETURN NEW;  -- dentro de un scope gestionado: la RPC audita explícitamente
  END IF;

  -- comprobante_payments NO tiene reference_type/reference_id; account_movements SÍ.
  -- to_jsonb(NEW)->>'x' devuelve NULL si la columna no existe → sin error.
  INSERT INTO finance_audit_log (
    business_id, actor_user_id, action, entity_table, entity_id, source_rpc,
    economic_date, period_start, reference_type, reference_id, new_data
  ) VALUES (
    (v_j->>'business_id')::uuid, auth.uid(), 'insert', TG_TABLE_NAME, (v_j->>'id')::uuid, 'trigger_backstop',
    v_econ,
    CASE WHEN v_econ IS NULL THEN NULL ELSE date_trunc('month', v_econ)::date END,
    v_j->>'reference_type', NULLIF(v_j->>'reference_id','')::uuid,
    v_j - 'created_at'
  );
  RETURN NEW;
EXCEPTION
  -- ÚNICO caso esperado y documentado: colisión con el índice de dedup lógico
  -- (evento ya auditado por el helper con el mismo request_id). Benigno: no hay
  -- pérdida de auditoría, la fila ya existe. Cualquier OTRO error NO se silencia:
  -- propaga y aborta el INSERT de negocio (fail-closed; sin pérdidas silenciosas).
  WHEN unique_violation THEN
    RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."finance_audit_backstop"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_finance_audit_backstop_cp" ON "public"."comprobante_payments";
CREATE TRIGGER "trg_finance_audit_backstop_cp"
  AFTER INSERT ON "public"."comprobante_payments"
  FOR EACH ROW EXECUTE FUNCTION "public"."finance_audit_backstop"();

DROP TRIGGER IF EXISTS "trg_finance_audit_backstop_am" ON "public"."account_movements";
CREATE TRIGGER "trg_finance_audit_backstop_am"
  AFTER INSERT ON "public"."account_movements"
  FOR EACH ROW EXECUTE FUNCTION "public"."finance_audit_backstop"();

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP TRIGGER IF EXISTS trg_finance_audit_backstop_cp ON comprobante_payments;
--   DROP TRIGGER IF EXISTS trg_finance_audit_backstop_am ON account_movements;
--   DROP FUNCTION IF EXISTS finance_audit_backstop();
--   DROP FUNCTION IF EXISTS finance_log_audit(uuid,text,text,uuid,text,text,text,date,text,uuid,jsonb,jsonb,uuid);
--   DROP TABLE IF EXISTS finance_audit_log;
-- ============================================================================
