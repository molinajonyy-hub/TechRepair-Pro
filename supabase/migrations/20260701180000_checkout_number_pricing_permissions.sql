-- ============================================================================
-- Numeración local atómica + cálculo comercial server-side + permisos de
-- override + split de hash cliente/resuelto (auditoría checkout, fase 2,
-- 2026-07-01).
--
-- TRES RIESGOS QUE CIERRA ESTA MIGRACIÓN:
--
-- 1) generar_numero_comprobante() es SOLO LECTURA (SELECT MAX(...)+1, sin
--    ningún lock). Reproducido con dos conexiones reales
--    (supabase/tests/run-numbering-race-repro.ps1): ambas conexiones, sin
--    ninguna fila insertada todavía, calculan EXACTAMENTE el mismo próximo
--    número para la misma serie — no hay nada que las bloquee entre sí.
--    Identidad real de la serie LOCAL (según el comportamiento actual del
--    producto, verificado en el cuerpo de la función): (business_id, tipo).
--    punto_venta es solo un prefijo de FORMATO — la función nunca lo usa
--    para acotar el MAX(), así que NO forma parte de la identidad de la
--    serie local (a diferencia de la serie FISCAL ARCA, que sí depende del
--    punto de venta vía arca_config — son dominios distintos, no se mezclan
--    acá).
--
-- 2) create_comprobante_checkout_atomic confía en subtotal/tax/total/precio/
--    costo enviados por el cliente, con solo una validación de consistencia
--    gruesa (subtotal+tax=total). Un cliente modificado (DevTools) podía
--    mandar cualquier precio/costo.
--
-- 3) (cerrado en la fase anterior para create_comprobante_checkout_atomic;
--    acá se extiende el mismo patrón a los demás entry points productivos —
--    ver Fase 7, código JS, no esta migración).
--
-- DISEÑO DEL CONTADOR (fase 2):
--   Tabla comprobante_number_sequences con UNIQUE(business_id, tipo). La
--   reserva es un INSERT ... ON CONFLICT DO UPDATE SET last_number =
--   last_number + 1 — el mismo patrón que un upsert de contador clásico. Dos
--   transacciones que reservan la MISMA serie se serializan porque Postgres
--   bloquea la segunda hasta que la primera resuelve (commit o rollback) el
--   UPDATE de esa fila — igual mecanismo de exclusión que los índices únicos
--   de arca_emission_attempts/comprobante_checkout_requests, pero vía
--   upsert en vez de vía índice de inserción pura (acá SIEMPRE hay una fila
--   por serie, así que es upsert, no insert-o-choque).
--
--   La reserva ocurre DENTRO de la transacción de
--   create_comprobante_checkout_atomic: si toda la transacción hace
--   ROLLBACK (ítem inválido, precio no autorizado, total inconsistente,
--   etc.), el UPDATE del contador también se revierte — el número NO se
--   consume (política elegida, documentada más abajo). Para la numeración
--   LOCAL esto es aceptable (no hay obligación legal de correlatividad
--   estricta como con CAE/ARCA); para la numeración FISCAL, que es un
--   dominio completamente distinto (arca_emission_attempts +
--   reserve_arca_number), esta regla NO aplica y no se toca acá.
--
--   Segunda barrera: columna comprobantes.numero_secuencial (integer) +
--   índice único parcial (business_id, tipo, numero_secuencial) WHERE NOT
--   NULL. Nunca se renumeran comprobantes históricos (numero_secuencial
--   queda NULL en filas viejas, fuera del índice parcial) — solo los nuevos,
--   creados por la RPC, quedan protegidos por el constraint.
--
-- DISEÑO DE PRICING (fase 4): resolve_product_pricing() es un port 1:1 de
-- src/lib/pricing/productPricing.ts (mismas reglas: USD dolarizado
-- automático / USD manual / ARS manual). La selección minorista/mayorista
-- por tipo de cliente es un port de getProductPriceForCustomer
-- (src/utils/pricing.ts). create_comprobante_checkout_atomic ahora:
--   - resuelve cada ítem con inventory_id desde `inventory` (verificando
--     business_id — nunca confía en que el producto sea del negocio correcto
--     solo porque el cliente lo dice);
--   - compara el precio/descuento que mandó el cliente contra el precio
--     resuelto;
--   - si difieren, exige permiso de override (user_can_override_price) —
--     si no hay permiso, la transacción entera falla (rollback total, cero
--     efectos, ver Fase 9);
--   - si hay permiso, acepta el override pero lo audita (list_price_ars,
--     price_override=true) en comprobante_items;
--   - recalcula subtotal/impuestos/total/costo desde los valores YA
--     resueltos — nunca confía en los agregados que mandó el cliente.
--
-- ALCANCE EXPLÍCITO: ítems de servicio/manuales (sin inventory_id) no tienen
-- precio de lista contra el cual comparar — se tratan como
-- "manual_service", permitido para cualquier rol con acceso de venta (una
-- reparación con precio acordado es legítima para cualquier usuario que
-- opera el POS). Vender por debajo del costo resuelto SÍ requiere permiso
-- (user_can_sell_below_cost) para ítems con costo conocido.
-- ============================================================================

-- ══════════════════════════════════════════════════════════════════════════
-- FASE 1 (preflight, solo diagnóstico — NUNCA bloquea ni modifica nada):
-- consultas de auditoría sobre los `numero`/`number` existentes. Se dejan
-- documentadas como comentario para correr manualmente contra un ambiente
-- real antes de plantear cualquier limpieza histórica — esta migración NO
-- las ejecuta ni depende de su resultado, porque el nuevo constraint UNIQUE
-- se apoya en la columna NUEVA `numero_secuencial` (NULL en todo lo
-- histórico), no en el `numero` viejo.
--
-- -- Duplicados históricos por serie (business_id, tipo, numero crudo):
-- SELECT business_id, COALESCE(type, tipo) AS tipo,
--        COALESCE(number, numero) AS numero_original, count(*) AS repeticiones
--   FROM comprobantes
--  WHERE COALESCE(number, numero) IS NOT NULL
--  GROUP BY business_id, COALESCE(type, tipo), COALESCE(number, numero)
-- HAVING count(*) > 1;
--
-- -- Números fuera de formato esperado (ni "NNNN-NNNNNNNN" ni solo dígitos):
-- SELECT id, business_id, COALESCE(type, tipo) AS tipo, COALESCE(number, numero) AS numero
--   FROM comprobantes
--  WHERE COALESCE(number, numero) IS NOT NULL
--    AND COALESCE(number, numero) !~ '^[0-9]+$'
--    AND COALESCE(number, numero) !~ '^[0-9]{4}-[0-9]{8}$';
--
-- -- Series (business_id+tipo) sin ningún número asignado:
-- SELECT DISTINCT business_id, COALESCE(type, tipo) AS tipo
--   FROM comprobantes WHERE COALESCE(number, numero) IS NULL;
--
-- -- Máximo actual por serie (lo que va a sembrar comprobante_number_sequences):
-- SELECT business_id, COALESCE(type, tipo) AS tipo, MAX(
--   CASE
--     WHEN COALESCE(number, numero) ~ '^[0-9]+$' THEN CAST(COALESCE(number, numero) AS BIGINT)
--     WHEN COALESCE(number, numero) ~ '^[0-9]{4}-[0-9]{8}$' THEN CAST(SPLIT_PART(COALESCE(number, numero), '-', 2) AS BIGINT)
--     ELSE 0
--   END) AS last_number
--   FROM comprobantes GROUP BY business_id, COALESCE(type, tipo);
-- ══════════════════════════════════════════════════════════════════════════

-- ── Tabla de contadores por serie local ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."comprobante_number_sequences" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id"  uuid NOT NULL REFERENCES "public"."businesses"("id"),
  "tipo"         text NOT NULL,
  "last_number"  integer NOT NULL DEFAULT 0,
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE "public"."comprobante_number_sequences" IS
  'Contador atómico de numeración LOCAL por serie (business_id, tipo) — reemplaza '
  'el MAX(numero)+1 sin lock de generar_numero_comprobante(). Dominio separado de '
  'la numeración FISCAL (arca_emission_attempts.numero_intentado).';

CREATE UNIQUE INDEX IF NOT EXISTS "idx_comprobante_number_sequences_serie"
  ON "public"."comprobante_number_sequences" ("business_id", "tipo");

ALTER TABLE "public"."comprobante_number_sequences" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "comprobante_number_sequences_select" ON "public"."comprobante_number_sequences";
CREATE POLICY "comprobante_number_sequences_select" ON "public"."comprobante_number_sequences"
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM "public"."businesses" WHERE "id" = "comprobante_number_sequences"."business_id" AND "owner_user_id" = auth.uid())
    OR EXISTS (SELECT 1 FROM "public"."profiles" WHERE "business_id" = "comprobante_number_sequences"."business_id" AND "user_id" = auth.uid())
  );
REVOKE ALL ON "public"."comprobante_number_sequences" FROM PUBLIC;
REVOKE ALL ON "public"."comprobante_number_sequences" FROM "anon";
GRANT SELECT ON "public"."comprobante_number_sequences" TO "authenticated";
GRANT ALL ON "public"."comprobante_number_sequences" TO "service_role";

-- ── Inicialización desde comprobantes existentes (Fase 3) ───────────────────
-- Ignora números nulos/inválidos de forma explícita (ELSE 0, nunca los
-- oculta — quedan reflejados en el preflight de arriba). No renumera nada:
-- solo siembra el CONTADOR, no toca comprobantes.numero/number existentes.
INSERT INTO "public"."comprobante_number_sequences" (business_id, tipo, last_number)
SELECT
  business_id,
  COALESCE(type, tipo) AS tipo,
  MAX(
    CASE
      WHEN COALESCE(number, numero) ~ '^[0-9]+$' THEN CAST(COALESCE(number, numero) AS BIGINT)
      WHEN COALESCE(number, numero) ~ '^[0-9]{4}-[0-9]{8}$' THEN CAST(SPLIT_PART(COALESCE(number, numero), '-', 2) AS BIGINT)
      ELSE 0
    END
  ) AS last_number
FROM "public"."comprobantes"
WHERE business_id IS NOT NULL AND COALESCE(type, tipo) IS NOT NULL
GROUP BY business_id, COALESCE(type, tipo)
ON CONFLICT (business_id, tipo) DO UPDATE
  SET last_number = GREATEST("comprobante_number_sequences"."last_number", EXCLUDED.last_number),
      updated_at = now();

-- ── reserve_comprobante_number: la reserva ES el lock (upsert atómico) ──────
CREATE OR REPLACE FUNCTION "public"."reserve_comprobante_number"(
  "p_business_id" uuid,
  "p_tipo"        text
) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_number integer;
BEGIN
  INSERT INTO comprobante_number_sequences (business_id, tipo, last_number)
    VALUES (p_business_id, p_tipo, 1)
  ON CONFLICT (business_id, tipo) DO UPDATE
    SET last_number = comprobante_number_sequences.last_number + 1,
        updated_at = now()
  RETURNING last_number INTO v_number;

  RETURN v_number;
END;
$$;

ALTER FUNCTION "public"."reserve_comprobante_number"(uuid, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."reserve_comprobante_number"(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."reserve_comprobante_number"(uuid, text) FROM "anon";
REVOKE EXECUTE ON FUNCTION "public"."reserve_comprobante_number"(uuid, text) FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."reserve_comprobante_number"(uuid, text) TO "service_role";
-- NOTA: no se otorga a `authenticated` — solo create_comprobante_checkout_atomic
-- (SECURITY DEFINER, dueño postgres) la invoca internamente. Igual que
-- reserve_arca_number, es una función interna, no un endpoint público.

-- ── Segunda barrera: columna + UNIQUE parcial sobre la serie real ───────────
ALTER TABLE "public"."comprobantes" ADD COLUMN IF NOT EXISTS "numero_secuencial" integer;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_comprobantes_numero_secuencial_unique"
  ON "public"."comprobantes" ("business_id", (COALESCE("type", "tipo")), "numero_secuencial")
  WHERE "numero_secuencial" IS NOT NULL;

COMMENT ON COLUMN "public"."comprobantes"."numero_secuencial" IS
  'Número crudo (entero) reservado atómicamente vía reserve_comprobante_number() — '
  'NULL en comprobantes históricos (nunca se renumeran). El UNIQUE parcial de '
  '(business_id, tipo, numero_secuencial) es la segunda barrera: aunque el '
  'contador tuviera un bug, dos comprobantes nunca podrían compartir número.';

-- ── Permisos de override de precio (Fase 5) ─────────────────────────────────
-- owner/admin/manager/sales: pueden aplicar precio manual / descuento sobre
-- ítems de producto (mismo criterio que WHOLESALE_MANAGE_ROLES en
-- src/lib/permissions/wholesalePermissions.ts — reutiliza el mismo corte de
-- roles ya usado en el resto de la app, en vez de inventar uno nuevo).
CREATE OR REPLACE FUNCTION "public"."user_can_override_price"(
  "p_business_id" uuid,
  "p_user_id"     uuid
) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = p_user_id)
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE business_id = p_business_id AND user_id = p_user_id
        AND COALESCE(is_active, true) = true
        AND role IN ('owner', 'admin', 'manager', 'sales')
    );
$$;

ALTER FUNCTION "public"."user_can_override_price"(uuid, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."user_can_override_price"(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."user_can_override_price"(uuid, uuid) FROM "anon";
REVOKE EXECUTE ON FUNCTION "public"."user_can_override_price"(uuid, uuid) FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."user_can_override_price"(uuid, uuid) TO "service_role";

-- owner/admin/manager: pueden vender por debajo del costo resuelto (protege
-- margen — `sales` puede dar descuentos pero no vender a pérdida sin
-- escalar a un rol superior).
CREATE OR REPLACE FUNCTION "public"."user_can_sell_below_cost"(
  "p_business_id" uuid,
  "p_user_id"     uuid
) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = p_user_id)
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE business_id = p_business_id AND user_id = p_user_id
        AND COALESCE(is_active, true) = true
        AND role IN ('owner', 'admin', 'manager')
    );
$$;

ALTER FUNCTION "public"."user_can_sell_below_cost"(uuid, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."user_can_sell_below_cost"(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."user_can_sell_below_cost"(uuid, uuid) FROM "anon";
REVOKE EXECUTE ON FUNCTION "public"."user_can_sell_below_cost"(uuid, uuid) FROM "authenticated";
GRANT EXECUTE ON FUNCTION "public"."user_can_sell_below_cost"(uuid, uuid) TO "service_role";

-- ── resolve_product_pricing: port 1:1 de src/lib/pricing/productPricing.ts ──
CREATE OR REPLACE FUNCTION "public"."resolve_product_pricing"(
  "p_sale_price"          numeric,
  "p_precio_mayorista"    numeric,
  "p_cost_price"          numeric,
  "p_cost_price_usd"      numeric,
  "p_base_currency"       text,
  "p_base_price"          numeric,
  "p_auto_update_price"   boolean,
  "p_exchange_rate_used"  numeric,
  "p_dollar_rate"         numeric
) RETURNS TABLE (
  "sale_ars"      numeric,
  "cost_ars"      numeric,
  "mayorista_ars" numeric,
  "mode"          text,
  "is_auto"       boolean
)
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
DECLARE
  v_is_auto boolean;
  v_mayorista_ars numeric;
BEGIN
  v_is_auto := (COALESCE(p_base_currency, 'ARS') = 'USD')
    AND COALESCE(p_base_price, 0) > 0
    AND p_auto_update_price IS TRUE
    AND COALESCE(p_dollar_rate, 0) > 0;

  IF v_is_auto THEN
    IF p_precio_mayorista IS NOT NULL AND p_precio_mayorista > 0 AND COALESCE(p_exchange_rate_used, 0) > 0 THEN
      v_mayorista_ars := ROUND(p_precio_mayorista * (p_dollar_rate / p_exchange_rate_used), 2);
    ELSE
      v_mayorista_ars := p_precio_mayorista;
    END IF;

    RETURN QUERY SELECT
      ROUND(p_base_price * p_dollar_rate, 2),
      CASE WHEN COALESCE(p_cost_price_usd, 0) > 0 THEN ROUND(p_cost_price_usd * p_dollar_rate, 2) ELSE COALESCE(p_cost_price, 0) END,
      v_mayorista_ars,
      'usd_auto'::text,
      true;
  ELSE
    RETURN QUERY SELECT
      COALESCE(p_sale_price, 0),
      COALESCE(p_cost_price, 0),
      p_precio_mayorista,
      (CASE WHEN COALESCE(p_base_currency, 'ARS') = 'USD' THEN 'usd_manual' ELSE 'manual_ars' END)::text,
      false;
  END IF;
END;
$$;

ALTER FUNCTION "public"."resolve_product_pricing"(numeric, numeric, numeric, numeric, text, numeric, boolean, numeric, numeric) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."resolve_product_pricing"(numeric, numeric, numeric, numeric, text, numeric, boolean, numeric, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."resolve_product_pricing"(numeric, numeric, numeric, numeric, text, numeric, boolean, numeric, numeric) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."resolve_product_pricing"(numeric, numeric, numeric, numeric, text, numeric, boolean, numeric, numeric) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."resolve_product_pricing"(numeric, numeric, numeric, numeric, text, numeric, boolean, numeric, numeric) TO "service_role";

-- ── comprobante_items: columnas de auditoría de precio ──────────────────────
ALTER TABLE "public"."comprobante_items" ADD COLUMN IF NOT EXISTS "list_price_ars" numeric;
ALTER TABLE "public"."comprobante_items" ADD COLUMN IF NOT EXISTS "price_override" boolean NOT NULL DEFAULT false;
ALTER TABLE "public"."comprobante_items" ADD COLUMN IF NOT EXISTS "applied_price_source" text;

COMMENT ON COLUMN "public"."comprobante_items"."list_price_ars" IS
  'Precio de lista resuelto server-side (resolve_product_pricing) al momento de la '
  'venta — NULL para ítems sin inventory_id (servicio/manual). Si difiere de '
  'precio_unitario, price_override=true documenta que fue un override autorizado.';
COMMENT ON COLUMN "public"."comprobante_items"."applied_price_source" IS
  'resolved_minorista | resolved_mayorista | manual_override | manual_service';

-- ── comprobante_checkout_requests: split de hash (Fase 6) ───────────────────
-- client_request_hash: la INTENCIÓN enviada por el cliente (para detectar
-- reuse de la misma key con un carrito distinto). resolved_checkout_hash:
-- hash de los valores FINALES resueltos server-side (auditoría inmutable de
-- lo que realmente se cobró) — nunca se usa para la detección de conflicto,
-- solo quedan asociados al comprobante creado.
ALTER TABLE "public"."comprobante_checkout_requests" RENAME COLUMN "request_hash" TO "client_request_hash";
ALTER TABLE "public"."comprobante_checkout_requests" ADD COLUMN IF NOT EXISTS "resolved_checkout_hash" text;

-- ============================================================================
-- create_comprobante_checkout_atomic — reescritura completa (misma firma):
-- ahora reserva número atómicamente, resuelve precio/costo server-side por
-- ítem (con permisos de override auditados), recalcula subtotal/impuestos/
-- total/costo desde los valores YA resueltos, y guarda el hash resuelto.
-- ============================================================================
CREATE OR REPLACE FUNCTION "public"."create_comprobante_checkout_atomic"(
  "p_business_id"      uuid,
  "p_idempotency_key"  text,
  "p_request_hash"     text,
  "p_payload"          jsonb
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_has_access        boolean := false;
  v_existing          comprobante_checkout_requests%ROWTYPE;
  v_request_id        uuid;
  v_comp_id           uuid;
  v_tipo              text;
  v_es_fiscal         boolean;
  v_emitir_en_arca    boolean;
  v_skip_finance      boolean;
  v_exchange_rate     numeric;
  v_customer_id       uuid;
  v_caja_id           uuid;
  v_punto_venta       text;
  v_condicion_fiscal  text;
  v_observaciones     text;
  v_order_id          uuid;
  v_estado_comercial  text;
  v_subtotal_ars      numeric := 0;
  v_tax               numeric := 0;
  v_total             numeric := 0;
  v_total_usd         numeric := 0;
  v_descuento_total   numeric := 0;
  v_costo_total_ars   numeric := 0;
  v_total_comisiones  numeric;
  v_total_neto        numeric;
  v_total_bruto       numeric;
  v_cc_total          numeric;
  v_cash_total        numeric := 0;
  v_numero_int        integer;
  v_numero            text;
  v_item              jsonb;
  v_pago              jsonb;
  v_item_id           uuid;
  v_prev_stock        integer;
  v_new_stock         integer;
  v_mov_id            uuid;
  v_account_id        uuid;
  v_customer_name     text;
  v_customer_phone    text;
  v_is_wholesale      boolean;
  v_dollar_rate       numeric := 1;
  v_can_override      boolean;
  v_can_below_cost    boolean;
  v_inv               inventory%ROWTYPE;
  v_line_qty          numeric;
  v_line_desc_pct     numeric;
  v_line_price_client numeric;
  v_line_price_final  numeric;
  v_line_cost_final   numeric;
  v_line_mayorista    numeric;
  v_price_source      text;
  v_is_override       boolean;
  v_line_subtotal     numeric;
  v_line_cost_total   numeric;
  v_resolved_items    jsonb := '[]'::jsonb;
BEGIN
  -- ── Ownership: resolver y validar acceso real al negocio ────────────────
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = p_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'No autorizado para este negocio');
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'idempotency_key requerida');
  END IF;
  IF p_request_hash IS NULL OR length(trim(p_request_hash)) = 0 THEN
    RETURN jsonb_build_object('status', 'failed_final', 'error', 'request_hash requerido');
  END IF;

  v_can_override   := user_can_override_price(p_business_id, auth.uid());
  v_can_below_cost := user_can_sell_below_cost(p_business_id, auth.uid());

  -- ── Idempotencia: intentar registrar la request — ESTE INSERT ES EL LOCK ──
  SET LOCAL lock_timeout = '8s';
  BEGIN
    INSERT INTO comprobante_checkout_requests (business_id, user_id, idempotency_key, client_request_hash, status)
    VALUES (p_business_id, auth.uid(), p_idempotency_key, p_request_hash, 'processing')
    RETURNING id INTO v_request_id;
  EXCEPTION
    WHEN lock_not_available THEN
      RETURN jsonb_build_object('status', 'already_processing');
    WHEN unique_violation THEN
      SELECT * INTO v_existing FROM comprobante_checkout_requests
        WHERE business_id = p_business_id AND idempotency_key = p_idempotency_key;

      IF v_existing.client_request_hash IS DISTINCT FROM p_request_hash THEN
        RETURN jsonb_build_object('status', 'idempotency_conflict');
      END IF;

      IF v_existing.status = 'completed' THEN
        RETURN jsonb_build_object('status', 'existing', 'comprobante_id', v_existing.comprobante_id);
      ELSIF v_existing.status = 'failed_final' THEN
        RETURN jsonb_build_object('status', 'failed_final', 'error', v_existing.last_error_message);
      ELSIF v_existing.status = 'processing' THEN
        RETURN jsonb_build_object('status', 'already_processing');
      ELSE -- 'failed_retryable'
        UPDATE comprobante_checkout_requests
          SET status = 'processing', updated_at = now()
          WHERE id = v_existing.id AND status = 'failed_retryable';
        IF NOT FOUND THEN
          RETURN jsonb_build_object('status', 'already_processing');
        END IF;
        v_request_id := v_existing.id;
      END IF;
  END;

  -- ── Bloque de trabajo (savepoint implícito vía EXCEPTION) ────────────────
  BEGIN
    v_tipo             := p_payload->>'tipo';
    v_es_fiscal        := COALESCE((p_payload->>'es_fiscal')::boolean, false);
    v_emitir_en_arca   := COALESCE((p_payload->>'emitir_en_arca')::boolean, false);
    v_skip_finance     := COALESCE((p_payload->>'skip_finance_entry')::boolean, false);
    v_exchange_rate    := COALESCE((p_payload->>'exchange_rate')::numeric, 1);
    v_customer_id      := NULLIF(p_payload->>'customer_id', '')::uuid;
    v_caja_id          := NULLIF(p_payload->>'caja_id', '')::uuid;
    v_punto_venta      := COALESCE(p_payload->>'punto_venta', '0001');
    v_condicion_fiscal := COALESCE(p_payload->>'condicion_fiscal', 'Consumidor Final');
    v_observaciones    := p_payload->>'observaciones';
    v_order_id         := NULLIF(p_payload->>'order_id', '')::uuid;

    IF v_tipo NOT IN ('remito', 'factura_a', 'factura_c', 'nota_credito') THEN
      RAISE EXCEPTION 'tipo de comprobante invalido: %', v_tipo;
    END IF;

    -- ── Cliente mayorista/minorista (server-side, nunca confiado del payload) ──
    v_is_wholesale := false;
    IF v_customer_id IS NOT NULL THEN
      SELECT (customer_type = 'mayorista'), name, phone
        INTO v_is_wholesale, v_customer_name, v_customer_phone
        FROM customers WHERE id = v_customer_id AND business_id = p_business_id;
      v_is_wholesale := COALESCE(v_is_wholesale, false);
    END IF;

    -- ── Cotización vigente del negocio (server-side) ─────────────────────────
    SELECT rate INTO v_dollar_rate FROM exchange_rates
      WHERE business_id = p_business_id AND base_currency = 'USD' AND target_currency = 'ARS'
      ORDER BY updated_at DESC LIMIT 1;
    v_dollar_rate := COALESCE(v_dollar_rate, 1);

    -- ── 1-2. Ítems: resolver precio/costo server-side, validar overrides ─────
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'items', '[]'::jsonb))
    LOOP
      v_line_qty          := COALESCE((v_item->>'cantidad')::numeric, 0);
      v_line_desc_pct     := LEAST(GREATEST(COALESCE((v_item->>'descuento_linea')::numeric, 0), 0), 100);
      v_line_price_client := COALESCE((v_item->>'precio_unitario')::numeric, 0);

      -- Postgres numeric acepta 'NaN'/'Infinity' como valores válidos del tipo
      -- (a diferencia de un cast que falla con basura no numérica) — NaN
      -- además se define MAYOR que cualquier valor, así que "NaN <= 0" o
      -- "NaN >= 0" NO lo detectan. Postgres no tiene is_finite(numeric); se
      -- valida comparando la representación de texto (Infinity/-Infinity/NaN
      -- son los únicos valores especiales posibles para numeric).
      IF v_line_qty::text IN ('NaN', 'Infinity', '-Infinity') OR v_line_qty <= 0 THEN
        RAISE EXCEPTION 'cantidad invalida (<=0, NaN o infinita) en item: %', v_item->>'descripcion';
      END IF;
      IF v_line_price_client::text IN ('NaN', 'Infinity', '-Infinity') OR v_line_price_client < 0 THEN
        RAISE EXCEPTION 'precio_unitario invalido (negativo, NaN o infinito) en item: %', v_item->>'descripcion';
      END IF;

      IF NULLIF(v_item->>'inventory_id', '') IS NOT NULL THEN
        -- ── Ítem de PRODUCTO: resolver desde inventory, nunca confiar en el payload ──
        SELECT * INTO v_inv FROM inventory
          WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'inventory_id % no pertenece a este negocio o no existe', v_item->>'inventory_id';
        END IF;

        SELECT sale_ars, cost_ars, mayorista_ars INTO v_line_price_final, v_line_cost_final, v_line_mayorista
          FROM resolve_product_pricing(
            v_inv.sale_price, v_inv.precio_mayorista, v_inv.cost_price, v_inv.cost_price_usd,
            v_inv.base_currency, v_inv.base_price, v_inv.auto_update_price, v_inv.exchange_rate_used,
            v_dollar_rate
          );
        v_line_desc_pct := LEAST(GREATEST(COALESCE((v_item->>'descuento_linea')::numeric, 0), 0), 100);

        IF v_is_wholesale AND v_line_mayorista IS NOT NULL AND v_line_mayorista > 0 THEN
          v_line_price_final := v_line_mayorista;
          v_price_source := 'resolved_mayorista';
        ELSE
          v_price_source := 'resolved_minorista';
        END IF;

        -- ── Override: el cliente mandó un precio o descuento distinto del resuelto ──
        v_is_override := (abs(v_line_price_client - v_line_price_final) > 0.01) OR (v_line_desc_pct > 0);
        IF v_is_override THEN
          IF NOT v_can_override THEN
            RAISE EXCEPTION 'usuario sin permiso para modificar el precio/descuento del item: %', v_item->>'descripcion';
          END IF;
          v_price_source := 'manual_override';
          -- El override SÍ se respeta (precio_unitario del cliente + descuento),
          -- pero queda auditado: list_price_ars = precio resuelto, price_override=true.
        ELSE
          v_line_price_client := v_line_price_final; -- sin override: el precio final ES el resuelto
        END IF;

        -- Vender por debajo del costo requiere permiso adicional.
        IF v_line_price_client < v_line_cost_final AND NOT v_can_below_cost THEN
          RAISE EXCEPTION 'usuario sin permiso para vender por debajo del costo en item: %', v_item->>'descripcion';
        END IF;
      ELSE
        -- ── Ítem de SERVICIO/MANUAL: no hay precio de lista contra el cual comparar ──
        v_line_price_final := v_line_price_client;
        v_line_cost_final  := COALESCE((v_item->>'costo_unitario')::numeric, 0);
        v_price_source      := 'manual_service';
        v_is_override       := false;
      END IF;

      v_line_subtotal   := v_line_price_client * v_line_qty * (1 - v_line_desc_pct / 100.0);
      v_line_cost_total := v_line_cost_final * v_line_qty;

      v_subtotal_ars    := v_subtotal_ars + v_line_subtotal;
      v_costo_total_ars := v_costo_total_ars + v_line_cost_total;
      v_descuento_total := v_descuento_total + (v_line_price_client * v_line_qty * (v_line_desc_pct / 100.0));

      -- Reinyectamos los valores RESUELTOS en el jsonb del ítem para el loop
      -- de inserción de abajo (evita resolver todo dos veces).
      v_item := v_item
        || jsonb_build_object('_resolved_precio', v_line_price_client)
        || jsonb_build_object('_resolved_costo', v_line_cost_final)
        || jsonb_build_object('_resolved_subtotal', v_line_subtotal)
        || jsonb_build_object('_resolved_descuento', v_line_desc_pct)
        || jsonb_build_object('_price_source', v_price_source)
        || jsonb_build_object('_price_override', v_is_override)
        || jsonb_build_object('_list_price', v_line_price_final);

      v_resolved_items := v_resolved_items || jsonb_build_array(v_item);
    END LOOP;

    v_tax   := CASE WHEN v_tipo = 'factura_a' THEN v_subtotal_ars * 0.21 ELSE 0 END;
    v_total := v_subtotal_ars + v_tax;
    v_total_usd := CASE WHEN v_dollar_rate > 0 THEN v_total / v_dollar_rate ELSE 0 END;
    v_total_bruto := v_total;

    -- ── Pagos: sumar server-side (nunca confiar en un total de pagos del cliente) ──
    SELECT COALESCE(SUM((p->>'amount_ars')::numeric), 0) INTO v_cash_total
      FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb)) p;
    v_cc_total := COALESCE((p_payload->>'cc_total')::numeric, 0);

    IF (v_cash_total + v_cc_total) > (v_total_bruto + 1) THEN
      RAISE EXCEPTION 'los pagos (caja + cuenta corriente) exceden el total recalculado del comprobante';
    END IF;
    FOR v_pago IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb))
    LOOP
      IF COALESCE((v_pago->>'amount')::numeric, -1) < 0 THEN
        RAISE EXCEPTION 'pago con monto negativo no permitido';
      END IF;
    END LOOP;
    IF v_cc_total < 0 THEN
      RAISE EXCEPTION 'cc_total no puede ser negativo';
    END IF;

    v_total_comisiones := COALESCE((p_payload->>'total_comisiones')::numeric, 0);
    v_total_neto       := v_total_bruto - v_total_comisiones;

    v_estado_comercial := CASE
      WHEN v_cash_total >= v_total_bruto - 1 THEN 'pagado'
      WHEN v_cash_total > 0 OR v_cc_total > 0 THEN 'parcial'
      ELSE 'pendiente'
    END;

    -- ── Número local: reserva ATÓMICA (reemplaza generar_numero_comprobante) ──
    v_numero_int := reserve_comprobante_number(p_business_id, v_tipo);
    IF v_punto_venta IS NULL OR trim(v_punto_venta) = '' THEN
      v_numero := lpad(v_numero_int::text, 8, '0');
    ELSE
      v_numero := lpad(v_punto_venta, 4, '0') || '-' || lpad(v_numero_int::text, 8, '0');
    END IF;

    -- ── 3. Comprobante ────────────────────────────────────────────────────────
    INSERT INTO comprobantes (
      business_id, created_by, customer_id, order_id, tipo, type, punto_venta,
      numero, number, numero_secuencial, fecha, date, condicion_fiscal, observaciones, currency,
      exchange_rate, subtotal, impuestos, tax, total, total_ars, total_usd,
      descuento_total, recargo_total, total_bruto, total_cobrado, saldo_pendiente,
      total_comisiones, total_neto, estado, status, estado_comercial, estado_fiscal,
      es_fiscal, emitir_en_arca, cae, cae_vencimiento, numero_fiscal
    ) VALUES (
      p_business_id, auth.uid(), v_customer_id, v_order_id, v_tipo, v_tipo, v_punto_venta,
      v_numero, v_numero, v_numero_int, now(), now(), v_condicion_fiscal, v_observaciones, 'ARS',
      v_exchange_rate, v_subtotal_ars, v_tax, v_tax, v_total, v_total, v_total_usd,
      v_descuento_total, 0, v_total_bruto, 0, v_total_bruto,
      v_total_comisiones, v_total_neto,
      CASE WHEN v_es_fiscal THEN 'borrador' ELSE 'emitido' END,
      CASE WHEN v_es_fiscal THEN 'draft' ELSE 'issued' END,
      v_estado_comercial,
      CASE WHEN v_es_fiscal THEN 'pendiente_emision' ELSE 'no_fiscal' END,
      v_es_fiscal, v_emitir_en_arca, NULL, NULL, NULL
    ) RETURNING id INTO v_comp_id;

    -- ── 4-5. Ítems + stock (con precio/costo YA resueltos server-side) ───────
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_resolved_items)
    LOOP
      INSERT INTO comprobante_items (
        comprobante_id, business_id, created_by, descripcion, tipo_linea, cantidad,
        precio_unitario, descuento_linea, subtotal, costo_unitario, costo_total,
        currency, exchange_rate, inventory_id, applied_price_type, orden,
        list_price_ars, price_override, applied_price_source
      ) VALUES (
        v_comp_id, p_business_id, auth.uid(),
        v_item->>'descripcion',
        COALESCE(v_item->>'tipo_linea', 'producto'),
        (v_item->>'cantidad')::numeric,
        (v_item->>'_resolved_precio')::numeric,
        (v_item->>'_resolved_descuento')::numeric,
        (v_item->>'_resolved_subtotal')::numeric,
        (v_item->>'_resolved_costo')::numeric,
        (v_item->>'_resolved_costo')::numeric * (v_item->>'cantidad')::numeric,
        COALESCE(v_item->>'currency', 'ARS'),
        COALESCE((v_item->>'exchange_rate')::numeric, v_exchange_rate),
        NULLIF(v_item->>'inventory_id', '')::uuid,
        v_item->>'applied_price_type',
        COALESCE((v_item->>'orden')::integer, 0),
        (v_item->>'_list_price')::numeric,
        (v_item->>'_price_override')::boolean,
        v_item->>'_price_source'
      ) RETURNING id INTO v_item_id;

      IF NULLIF(v_item->>'inventory_id', '') IS NOT NULL
         AND COALESCE(v_item->>'tipo_linea', 'producto') IN ('producto', 'repuesto') THEN

        SELECT stock_quantity INTO v_prev_stock FROM inventory
          WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id
          FOR UPDATE;

        IF FOUND THEN
          v_prev_stock := COALESCE(v_prev_stock, 0);
          v_new_stock  := GREATEST(0, v_prev_stock - (v_item->>'cantidad')::numeric)::integer;

          UPDATE inventory SET stock_quantity = v_new_stock, updated_at = now()
            WHERE id = (v_item->>'inventory_id')::uuid AND business_id = p_business_id;

          INSERT INTO inventory_movements (
            business_id, inventory_item_id, movement_type, quantity, previous_stock,
            new_stock, reference_type, reference_id, note, created_by
          ) VALUES (
            p_business_id, (v_item->>'inventory_id')::uuid, 'sale',
            -((v_item->>'cantidad')::numeric)::integer, v_prev_stock, v_new_stock,
            'comprobante', v_comp_id, 'Salida por venta en comprobante', auth.uid()
          ) RETURNING id INTO v_mov_id;

          UPDATE comprobante_items
            SET stock_processed = true, stock_processed_at = now(), stock_movement_id = v_mov_id
            WHERE id = v_item_id;
        END IF;
      END IF;
    END LOOP;

    -- ── 6. Pagos de caja ──────────────────────────────────────────────────────
    FOR v_pago IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'pagos', '[]'::jsonb))
    LOOP
      INSERT INTO comprobante_payments (
        comprobante_id, business_id, amount, currency, amount_ars, exchange_rate,
        payment_method, payment_provider, commission_rate, commission_amount,
        net_amount, date, created_by
      ) VALUES (
        v_comp_id, p_business_id,
        (v_pago->>'amount')::numeric, COALESCE(v_pago->>'currency', 'ARS'),
        (v_pago->>'amount_ars')::numeric,
        COALESCE((v_pago->>'exchange_rate')::numeric, v_exchange_rate),
        v_pago->>'payment_method', v_pago->>'payment_provider',
        COALESCE((v_pago->>'commission_rate')::numeric, 0),
        COALESCE((v_pago->>'commission_amount')::numeric, 0),
        COALESCE((v_pago->>'net_amount')::numeric, (v_pago->>'amount_ars')::numeric),
        CURRENT_DATE, auth.uid()
      );
    END LOOP;

    -- ── 7. Movimientos financieros (costo/ingreso), con los totales YA recalculados ──
    IF v_costo_total_ars > 0 AND NOT v_skip_finance THEN
      INSERT INTO business_finance_entries (
        business_id, date, type, category, description, amount, currency,
        amount_ars, exchange_rate, created_by
      ) VALUES (
        p_business_id, CURRENT_DATE, 'variable_cost', 'mercaderia',
        'Costo de productos - Comprobante #' || v_numero, v_costo_total_ars,
        'ARS', v_costo_total_ars, 1, auth.uid()
      );
    END IF;

    IF NOT v_skip_finance AND v_cash_total = 0 AND v_cc_total = 0 THEN
      INSERT INTO business_finance_entries (
        business_id, date, type, category, description, amount, currency,
        amount_ars, exchange_rate, created_by
      ) VALUES (
        p_business_id, CURRENT_DATE, 'income', 'ventas_productos',
        'Comprobante #' || v_numero, v_total, 'ARS', v_total, v_exchange_rate, auth.uid()
      );

      INSERT INTO financial_movements (
        business_id, date, type, currency, amount, amount_ars, exchange_rate,
        source, description, created_by, caja_id
      ) VALUES (
        p_business_id, CURRENT_DATE, 'income', 'ARS', v_total, v_total,
        v_exchange_rate, 'comprobante', 'Comprobante #' || v_numero, auth.uid(), v_caja_id
      );
    END IF;

    -- ── 8. Cuenta corriente ───────────────────────────────────────────────────
    IF v_cc_total > 0.01 AND v_customer_id IS NOT NULL THEN
      SELECT id INTO v_account_id FROM accounts
        WHERE business_id = p_business_id AND entity_id = v_customer_id;

      IF v_account_id IS NULL THEN
        INSERT INTO accounts (business_id, type, entity_id, entity_name, entity_phone, balance)
          VALUES (p_business_id, 'cliente', v_customer_id, COALESCE(v_customer_name, 'Cliente'), v_customer_phone, 0)
          RETURNING id INTO v_account_id;
      END IF;

      INSERT INTO account_movements (
        business_id, account_id, date, type, description, debit, credit,
        reference_type, reference_id, created_by
      ) VALUES (
        p_business_id, v_account_id, CURRENT_DATE, 'venta',
        'Comprobante #' || v_numero, v_cc_total, 0,
        'comprobante', v_comp_id, auth.uid()
      );
    END IF;

    -- ── Completar la request — con el hash RESUELTO (auditoría) ──────────────
    UPDATE comprobante_checkout_requests
      SET status = 'completed', comprobante_id = v_comp_id, completed_at = now(), updated_at = now(),
          resolved_checkout_hash = encode(extensions.digest(v_resolved_items::text || v_total::text || v_subtotal_ars::text, 'sha256'), 'hex')
      WHERE id = v_request_id;

    RETURN jsonb_build_object('status', 'created', 'comprobante_id', v_comp_id);

  EXCEPTION WHEN OTHERS THEN
    UPDATE comprobante_checkout_requests
      SET status = 'failed_retryable', last_error_code = SQLSTATE, last_error_message = SQLERRM,
          completed_at = now(), updated_at = now()
      WHERE id = v_request_id;
    RETURN jsonb_build_object('status', 'failed_retryable', 'error', SQLERRM);
  END;
END;
$$;

ALTER FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb) TO "service_role";

-- get_checkout_request_status referencia request_hash -> actualizar a client_request_hash
CREATE OR REPLACE FUNCTION "public"."get_checkout_request_status"(
  "p_business_id"      uuid,
  "p_idempotency_key"  text
) RETURNS jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER STABLE
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_has_access boolean := false;
  v_req        comprobante_checkout_requests%ROWTYPE;
  v_comp       comprobantes%ROWTYPE;
BEGIN
  SELECT (
    EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE business_id = p_business_id AND user_id = auth.uid())
  ) INTO v_has_access;
  IF NOT v_has_access THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT * INTO v_req FROM comprobante_checkout_requests
    WHERE business_id = p_business_id AND idempotency_key = p_idempotency_key;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  IF v_req.comprobante_id IS NOT NULL THEN
    SELECT * INTO v_comp FROM comprobantes WHERE id = v_req.comprobante_id;
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'checkout_status', v_req.status,
    'comprobante_id', v_req.comprobante_id,
    'estado_fiscal', v_comp.estado_fiscal,
    'cae', v_comp.cae,
    'error', v_req.last_error_message
  );
END;
$$;

ALTER FUNCTION "public"."get_checkout_request_status"(uuid, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."get_checkout_request_status"(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."get_checkout_request_status"(uuid, text) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."get_checkout_request_status"(uuid, text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_checkout_request_status"(uuid, text) TO "service_role";

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado por esta migración):
--   CREATE OR REPLACE FUNCTION create_comprobante_checkout_atomic(...) -- volver a la versión de 20260701170000
--   DROP FUNCTION IF EXISTS get_checkout_request_status(uuid, text); -- recrear versión anterior si se revierte
--   ALTER TABLE comprobante_checkout_requests DROP COLUMN IF EXISTS resolved_checkout_hash;
--   ALTER TABLE comprobante_checkout_requests RENAME COLUMN client_request_hash TO request_hash;
--   ALTER TABLE comprobante_items DROP COLUMN IF EXISTS applied_price_source, DROP COLUMN IF EXISTS price_override, DROP COLUMN IF EXISTS list_price_ars;
--   DROP FUNCTION IF EXISTS resolve_product_pricing(numeric,numeric,numeric,numeric,text,numeric,boolean,numeric,numeric);
--   DROP FUNCTION IF EXISTS user_can_sell_below_cost(uuid,uuid);
--   DROP FUNCTION IF EXISTS user_can_override_price(uuid,uuid);
--   DROP INDEX IF EXISTS idx_comprobantes_numero_secuencial_unique;
--   ALTER TABLE comprobantes DROP COLUMN IF EXISTS numero_secuencial;
--   DROP FUNCTION IF EXISTS reserve_comprobante_number(uuid, text);
--   DROP TABLE IF EXISTS comprobante_number_sequences;
--   (no afecta comprobantes/comprobante_items históricos: las columnas nuevas
--    son NULLABLE o con default, y las filas viejas simplemente no las usan)
-- ============================================================================
