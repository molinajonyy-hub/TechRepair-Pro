-- ============================================================================
-- Fix clasificación: fixed_cost_local → operating_expense (catch-all)
--
-- El clasificador R10 sólo mapeaba a operating_expense los gastos
-- fixed_cost_local con category en una lista blanca. Un gasto general con
-- category_key no listado (p.ej. 'operativos', o vacío como los 3 registros
-- productivos legacy_unclassified) caía a legacy_unclassified y quedaba FUERA
-- del P&L — subreportando gastos operativos de forma silenciosa.
--
-- fixed_cost_local ES por definición un costo operativo del local (a diferencia
-- de fixed_cost_personal → owner_withdrawal). Se cambia R10 a un catch-all por
-- TIPO, que subsume 'operativos', vacío y cualquier categoría futura. Los montos,
-- fechas, type/category/source NO cambian; sólo economic_class.
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."bfe_economic_class"(
  "p_type"      text,
  "p_category"  text,
  "p_source"    text,
  "p_ref_comp"  uuid
) RETURNS text
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT CASE
    WHEN p_type='income' AND (
           p_source='comprobante'
        OR p_category='cobro_cuenta_corriente'
        OR (p_source='manual' AND p_category='ventas_productos')
    ) THEN 'revenue_collection_mirror'
    WHEN p_category='comisiones_cobro' THEN 'payment_fee'
    WHEN p_category='mercaderia' THEN 'cogs_mirror'
    WHEN p_category IN ('inventario','repuestos','insumos','mercaderia_compra') THEN 'inventory_purchase'
    WHEN p_category='compras_proveedor' OR p_source='pago_proveedor' THEN 'supplier_liability_payment'
    WHEN p_type='salary' AND p_category IN ('sueldo_dueno','retiros') THEN 'owner_withdrawal'
    WHEN p_type='salary' AND p_category IN ('sueldo_empleados','adelantos','bonos','comisiones') THEN 'employee_salary'
    WHEN p_type='salary' THEN 'owner_withdrawal'
    WHEN p_type='fixed_cost_personal' THEN 'owner_withdrawal'
    -- R10: TODO fixed_cost_local es gasto operativo del local (catch-all por tipo).
    WHEN p_type='fixed_cost_local' THEN 'operating_expense'
    WHEN p_type='variable_cost' AND p_category IN ('envios','reparaciones_tercerizadas','otros_variables') THEN 'operating_expense'
    WHEN p_type='income' AND p_source='manual' THEN 'manual_adjustment'
    ELSE 'legacy_unclassified'
  END;
$$;

ALTER FUNCTION "public"."bfe_economic_class"(text, text, text, uuid) OWNER TO "postgres";

-- ── Backfill SOLO de registros inequívocos: legacy_unclassified que ahora son
--    operating_expense por ser fixed_cost_local. No toca ninguna otra clase.
DO $$
DECLARE v_n integer; v_monto numeric;
BEGIN
  SELECT count(*), COALESCE(round(SUM(amount_ars),2),0) INTO v_n, v_monto
  FROM public.business_finance_entries
  WHERE economic_class='legacy_unclassified' AND type='fixed_cost_local';
  RAISE NOTICE 'Reclasificación operating_expense — legacy fixed_cost_local a corregir: % filas, monto=%', v_n, v_monto;

  UPDATE public.business_finance_entries
     SET economic_class='operating_expense', updated_at=now()
   WHERE economic_class='legacy_unclassified' AND type='fixed_cost_local';
END $$;

-- ============================================================================
-- ROLLBACK (documentado): CREATE OR REPLACE bfe_economic_class con la R10 vieja
--   (lista blanca de categorías). El backfill no es reversible automáticamente
--   (montos/fechas nunca cambiaron; sólo economic_class de filas fixed_cost_local).
-- ============================================================================
