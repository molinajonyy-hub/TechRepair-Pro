-- ============================================================================
-- M3 — fix_cost_double_count (Etapa 1)
--
-- Elimina el doble/triple costo del P&L SIN tocar montos, fechas, type,
-- category ni source históricos. Enfoque ADITIVO:
--   1. Columna business_finance_entries.economic_class (nullable, CHECK cerrado).
--   2. Función determinística bfe_economic_class(...) — 14 clases del contrato
--      + 2 espejos técnicos (revenue_collection_mirror, cogs_mirror).
--   3. Trigger BEFORE INSERT/UPDATE que la puebla en TODOS los caminos de
--      inserción (checkout, supplier RPCs, gastos, compra rápida, manual) —
--      elegido sobre reescribir los cuerpos de create_supplier_purchase_atomic
--      / pay_supplier_purchase_atomic (más destructivo y propenso a error):
--      un pago a proveedor queda clasificado supplier_liability_payment y las
--      vistas canónicas de M5 NO lo consumen en el P&L → "no genera gasto
--      operativo ni COGS ni reduce dos veces el resultado" (contrato Fase 4).
--   4. Backfill idempotente con PREVIEW (RAISE NOTICE de filas y suma por clase)
--      antes del UPDATE. No borra duplicados históricos: los marca.
--
-- El COGS canónico pasa a ser comprobante_items.costo_total (vistas M5), no
-- BFE 'mercaderia'. Los BFE 'mercaderia'/'inventario'/'repuestos'/
-- 'compras_proveedor' quedan clasificados y EXCLUIDOS del P&L por construcción.
--
-- Ver docs/auditoria-finanzas/etapa1/legacy-classification.md
-- ============================================================================

-- ── 1. Columna ───────────────────────────────────────────────────────────────
ALTER TABLE "public"."business_finance_entries"
  ADD COLUMN IF NOT EXISTS "economic_class" text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bfe_economic_class_check') THEN
    ALTER TABLE "public"."business_finance_entries"
      ADD CONSTRAINT "bfe_economic_class_check" CHECK ("economic_class" IS NULL OR "economic_class" IN (
        'sale_revenue','sales_return','cogs','operating_expense','employee_salary',
        'payment_fee','inventory_purchase','supplier_liability_payment',
        'owner_withdrawal','owner_contribution','transfer','cash_adjustment',
        'manual_adjustment','legacy_unclassified',
        'revenue_collection_mirror','cogs_mirror'
      ));
  END IF;
END $$;

COMMENT ON COLUMN "public"."business_finance_entries"."economic_class" IS
  'Clase economica canonica (contrato Etapa 1). Las vistas v_finance_* deciden '
  'que clases entran al P&L. revenue_collection_mirror/cogs_mirror son espejos '
  'tecnicos: la venta/COGS real vive en comprobante_items y NO se suman aca.';

-- ── 2. Función determinística de clasificación ──────────────────────────────
CREATE OR REPLACE FUNCTION "public"."bfe_economic_class"(
  "p_type"      text,
  "p_category"  text,
  "p_source"    text,
  "p_ref_comp"  uuid
) RETURNS text
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT CASE
    -- R1: espejo de cobro (income de venta, cualquier via)
    WHEN p_type='income' AND (
           p_source='comprobante'
        OR p_category='cobro_cuenta_corriente'
        OR (p_source='manual' AND p_category='ventas_productos')
    ) THEN 'revenue_collection_mirror'
    -- R2: comision de cobro → gasto operativo (payment_fee)
    WHEN p_category='comisiones_cobro' THEN 'payment_fee'
    -- R3: COGS-mirror (el COGS real esta en comprobante_items)
    WHEN p_category='mercaderia' THEN 'cogs_mirror'
    -- R4: compra de stock (no es costo hasta vender)
    WHEN p_category IN ('inventario','repuestos','insumos','mercaderia_compra') THEN 'inventory_purchase'
    -- R5: pago de deuda a proveedor
    WHEN p_category='compras_proveedor' OR p_source='pago_proveedor' THEN 'supplier_liability_payment'
    -- R6: retiro del dueno (sueldo del dueno / retiros)
    WHEN p_type='salary' AND p_category IN ('sueldo_dueno','retiros') THEN 'owner_withdrawal'
    -- R7: sueldo de empleado (si afecta P&L)
    WHEN p_type='salary' AND p_category IN ('sueldo_empleados','adelantos','bonos','comisiones') THEN 'employee_salary'
    -- R8: salary restante sin marca de empleado → capital por defecto
    WHEN p_type='salary' THEN 'owner_withdrawal'
    -- R9: gasto personal pagado por el negocio = retiro
    WHEN p_type='fixed_cost_personal' THEN 'owner_withdrawal'
    -- R10: gasto operativo del local (lista conocida)
    WHEN p_type='fixed_cost_local' AND p_category IN (
      'alquiler','luz','agua','gas','internet','impuestos','contador','software',
      'publicidad','publicidad_fija','limpieza','seguridad','mantenimiento',
      'otros_fijos_local','otros','servicios'
    ) THEN 'operating_expense'
    -- R11: variables operativos legitimos (no COGS, no compra)
    WHEN p_type='variable_cost' AND p_category IN ('envios','reparaciones_tercerizadas','otros_variables') THEN 'operating_expense'
    -- R12: income manual no matcheado → ajuste manual
    WHEN p_type='income' AND p_source='manual' THEN 'manual_adjustment'
    -- R13/R14: sin evidencia suficiente → legacy, NUNCA entra al P&L en silencio
    ELSE 'legacy_unclassified'
  END;
$$;

ALTER FUNCTION "public"."bfe_economic_class"(text, text, text, uuid) OWNER TO "postgres";

-- ── 3. Trigger universal de auto-clasificación ──────────────────────────────
-- Puebla economic_class cuando viene NULL, en cualquier INSERT/UPDATE. No pisa
-- una clase seteada explicitamente (permite override futuro controlado).
CREATE OR REPLACE FUNCTION "public"."trg_set_bfe_economic_class"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.economic_class IS NULL THEN
    NEW.economic_class := public.bfe_economic_class(NEW.type, NEW.category, NEW.source, NEW.reference_comprobante_id);
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."trg_set_bfe_economic_class"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trig_bfe_economic_class" ON "public"."business_finance_entries";
CREATE TRIGGER "trig_bfe_economic_class"
  BEFORE INSERT OR UPDATE ON "public"."business_finance_entries"
  FOR EACH ROW EXECUTE FUNCTION "public"."trg_set_bfe_economic_class"();

-- ── 4. Backfill con PREVIEW ──────────────────────────────────────────────────
-- Preview: cantidad y suma por clase ANTES de escribir (RAISE NOTICE). Luego
-- el UPDATE (idempotente: solo toca filas con economic_class NULL). No cambia
-- montos/fechas/type/category/source: solo puebla economic_class.
DO $$
DECLARE
  r record;
  v_total_before numeric;
  v_count_before integer;
BEGIN
  SELECT count(*), COALESCE(SUM(amount_ars),0) INTO v_count_before, v_total_before
  FROM public.business_finance_entries;
  RAISE NOTICE 'M3 backfill PREVIEW — BFE totales antes: % filas, suma amount_ars=%', v_count_before, round(v_total_before,2);

  FOR r IN
    SELECT public.bfe_economic_class(type, category, source, reference_comprobante_id) AS cls,
           count(*) n, round(SUM(amount_ars),2) monto
    FROM public.business_finance_entries
    WHERE economic_class IS NULL
    GROUP BY 1 ORDER BY 3 DESC
  LOOP
    RAISE NOTICE 'M3 backfill PREVIEW — % : % filas, monto=%', r.cls, r.n, r.monto;
  END LOOP;

  -- Aplicar (el trigger tambien la pondria, pero backfill explicito garantiza
  -- las filas historicas). updated_at se refresca; nada mas cambia.
  UPDATE public.business_finance_entries
  SET economic_class = public.bfe_economic_class(type, category, source, reference_comprobante_id),
      updated_at = now()
  WHERE economic_class IS NULL;

  RAISE NOTICE 'M3 backfill APLICADO — filas clasificadas: %', (SELECT count(*) FROM public.business_finance_entries WHERE economic_class IS NOT NULL);
END $$;

-- ── Índice para consumo por clase en vistas ─────────────────────────────────
CREATE INDEX IF NOT EXISTS "idx_bfe_economic_class"
  ON "public"."business_finance_entries" ("business_id", "economic_class");

-- ============================================================================
-- DECISIÓN DE DISEÑO (documentada): NO se reescriben los cuerpos de
-- create_supplier_purchase_atomic / pay_supplier_purchase_atomic. El BFE
-- variable_cost/compras_proveedor que insertan queda auto-clasificado
-- supplier_liability_payment por el trigger, y las vistas canónicas (M5) lo
-- excluyen del P&L. Esto satisface el invariante "pagar proveedor no afecta
-- resultado" con el cambio mínimo y captura además cualquier otro camino de
-- inserción (defensa en profundidad). La compra rápida triple-escritura de
-- ModalCrearGasto queda neutralizada en reportes (mercaderia→cogs_mirror,
-- inventario/repuestos→inventory_purchase, todos excluidos) y su unificación
-- transaccional se aborda con create_quick_inventory_purchase_atomic
-- (migración 20260704101000).
-- ============================================================================

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   DROP TRIGGER IF EXISTS trig_bfe_economic_class ON business_finance_entries;
--   DROP FUNCTION IF EXISTS trg_set_bfe_economic_class();
--   DROP FUNCTION IF EXISTS bfe_economic_class(text,text,text,uuid);
--   DROP INDEX IF EXISTS idx_bfe_economic_class;
--   ALTER TABLE business_finance_entries DROP CONSTRAINT IF EXISTS bfe_economic_class_check;
--   ALTER TABLE business_finance_entries DROP COLUMN IF EXISTS economic_class;
--   (montos/fechas/type/category/source nunca cambiaron)
-- ============================================================================
