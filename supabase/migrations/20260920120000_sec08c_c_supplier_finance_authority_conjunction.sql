-- ═══════════════════════════════════════════════════════════════════════════
-- SEC-08C · FASE C — la autoridad de lectura de proveedores se hace explicita
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La revision independiente pidio codificar con mas precision la justificacion
-- de producto que ya estaba escrita en la fase A:
--
--     "actor de FINANZAS, o actor de COMPRAS que legitimamente maneja costos"
--
-- La fase A la habia expresado como:
--
--     finance OR inventory_view_costs
--
-- y eso deja una puerta que nadie quiso abrir: un override de
-- `inventory_view_costs` A SOLAS —sin `inventory`— pasaba a conceder el libro
-- de pagos y la cuenta corriente del proveedor. `inventory_view_costs` es una
-- SUB-permission del modulo de inventario, no un rol de compras por si misma.
--
-- ── EVIDENCIA (no es una suposicion) ──────────────────────────────────────
--
--   1. src/config/permissions.ts describe la capability como "Ver precios de
--      costo en el inventario", grupo "Inventario".
--   2. En los SIETE roles por defecto, inventory_view_costs=true implica
--      siempre inventory=true. Ningun rol nace solo-costos.
--   3. Las rutas /inventory y /suppliers estan gateadas por la permission
--      `inventory`, asi que un actor solo-costos no alcanza ninguna pantalla
--      de proveedores.
--   4. Y lo decisivo: la proyeccion canonica de costo que ratifico SEC-08B ya
--      exige LAS DOS. `v_inventory_costs` filtra por
--        current_user_can_in_business(business_id,'inventory')
--        AND can_view_inventory_cost(business_id)
--      O sea que el patron ratificado del proyecto para leer costo ES la
--      conjuncion. Esta migracion no inventa un criterio: alinea la autoridad
--      de proveedores con el que ya estaba en produccion para inventario.
--
-- ── LO QUE NO CAMBIA ──────────────────────────────────────────────────────
-- Los defaults por rol quedan EXACTAMENTE igual, y por eso esto no es un
-- cambio de producto sino un cierre de borde:
--
--     owner   -> si (superusuario del tenant)
--     admin   -> si (finance)
--     manager -> si (inventory + inventory_view_costs)
--     cashier -> si (finance)
--     sales   -> no (inventory sin costos, sin finance)
--     tech    -> no
--     viewer  -> no
--
-- Lo unico que deja de conceder es la combinacion que solo se puede fabricar
-- con un override: inventory=false + inventory_view_costs=true.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.can_view_supplier_finance(p_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_business_id IS NOT NULL
     AND ( public.current_user_can_in_business(p_business_id, 'finance')
        OR ( public.current_user_can_in_business(p_business_id, 'inventory')
         AND public.current_user_can_in_business(p_business_id, 'inventory_view_costs') ) );
$$;

COMMENT ON FUNCTION public.can_view_supplier_finance(uuid) IS
  'SEC-08C. Autoridad de lectura de la verdad financiera de proveedores '
  '(deuda, saldo, importes de compra y de pago). Composicion de capabilities '
  'EXISTENTES: finance OR (inventory AND inventory_view_costs). La conjuncion '
  'del segundo termino replica la que ya usa v_inventory_costs desde SEC-08B: '
  'inventory_view_costs es una sub-permission del modulo de inventario y por si '
  'sola NO describe a un actor de compras. NO habilita el costo crudo por linea '
  'de compra, que sigue exigiendo inventory_view_costs (SEC-08B).';

REVOKE ALL ON FUNCTION public.can_view_supplier_finance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_view_supplier_finance(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_view_supplier_finance(uuid) TO authenticated;

-- ── Postcondiciones ────────────────────────────────────────────────────────
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'can_view_supplier_finance';

  IF v_def NOT LIKE '%''inventory''%' THEN
    RAISE EXCEPTION 'SEC-08C fase C: la autoridad no exige `inventory` junto con los costos';
  END IF;
  IF v_def NOT LIKE '%''inventory_view_costs''%' OR v_def NOT LIKE '%''finance''%' THEN
    RAISE EXCEPTION 'SEC-08C fase C: la autoridad dejo de componer las capabilities existentes';
  END IF;
  IF v_def LIKE '%SECURITY DEFINER%' THEN
    RAISE EXCEPTION 'SEC-08C fase C: la autoridad no necesita elevacion';
  END IF;
  IF has_function_privilege('anon', 'public.can_view_supplier_finance(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC-08C fase C: anon conserva EXECUTE sobre la autoridad';
  END IF;

  -- El contrato de SEC-08B sigue intacto: la linea de compra NO se gobierna
  -- con esta autoridad.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'supplier_purchase_items'
       AND cmd = 'SELECT' AND qual LIKE '%can_view_supplier_finance%'
  ) THEN
    RAISE EXCEPTION 'SEC-08C fase C: supplier_purchase_items no puede usar esta autoridad';
  END IF;
END $$;

COMMIT;
