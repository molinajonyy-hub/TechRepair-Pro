// ============================================================================
// P0 SEARCH — Fixture determinístico para buscadores y variantes.
//
// Reproduce el reporte del owner: un producto con variantes que se ve bien en
// Inventario y "a veces" no aparece al cobrar.
//
// ORDEN DE INSERCIÓN — NO REORDENAR:
//   El relleno se inserta ANTES que el padre y las variantes. Sin ORDER BY,
//   PostgREST devuelve las filas en orden físico, así que las variantes quedan
//   al final y caen fuera del LIMIT del POS. Ese es exactamente el caso real:
//   el comercio ya tenía catálogo y las variantes son lo último que cargó.
//   Si se siembran primero, el bug NO se reproduce.
//
// Se cubren las DOS representaciones de variante que existen en el código:
//   A. supplier_code = 'variant_parent:<parentId>'  → la que escribe Inventario
//   B. parent_id + variant_name                     → la que escribe productService
// ============================================================================
import { E2E } from './seedE2E.ts'

/** IDs determinísticos del fixture de búsqueda. */
export const SEARCH_FIXTURE = {
  // Representación A — la que produce la página de Inventario hoy.
  padreFunda:   '00000000-0000-0000-0000-00000e2ef001',
  varNegro:     '00000000-0000-0000-0000-00000e2ef002',
  varAzul:      '00000000-0000-0000-0000-00000e2ef003',
  varRosa:      '00000000-0000-0000-0000-00000e2ef004',
  // Representación B — la que produce productService.createVariant.
  padreVidrio:  '00000000-0000-0000-0000-00000e2ef005',
  vidrioComun:  '00000000-0000-0000-0000-00000e2ef006',
  vidrioPriv:   '00000000-0000-0000-0000-00000e2ef007',
  // Producto simple de control.
  bateria:      '00000000-0000-0000-0000-00000e2ef008',
  // Producto del negocio ajeno (control multi-tenant).
  ajeno:        '00000000-0000-0000-0000-00000e2ef009',
  /** Cantidad de productos de relleno que empujan a las variantes fuera del LIMIT. */
  relleno: 150,
} as const

const F = SEARCH_FIXTURE

const SQL_SEARCH_FIXTURE = `
BEGIN;
SET LOCAL session_replication_role = 'replica';

-- ── Idempotencia ─────────────────────────────────────────────────────────
-- El spec COBRA de verdad, así que una corrida deja una venta real. Hay que
-- barrerla junto con todo lo derivado: si sobreviven sus filas, la fila de
-- inventario no se puede borrar (FK) y el checkout request queda huérfano
-- rompiendo el fixture del gate visual en el globalSetup siguiente.
CREATE TEMP TABLE _srch_comp ON COMMIT DROP AS
SELECT DISTINCT ci.comprobante_id AS id
  FROM public.comprobante_items ci
  JOIN public.inventory i ON i.id = ci.inventory_id
 WHERE i.code LIKE 'SRCH-%';

DELETE FROM public.comprobante_checkout_requests WHERE comprobante_id        IN (SELECT id FROM _srch_comp);
DELETE FROM public.financial_movements           WHERE comprobante_id        IN (SELECT id FROM _srch_comp);
DELETE FROM public.business_finance_entries      WHERE reference_comprobante_id IN (SELECT id FROM _srch_comp);
DELETE FROM public.comprobante_payments          WHERE comprobante_id        IN (SELECT id FROM _srch_comp);
DELETE FROM public.comprobante_annulments        WHERE comprobante_id        IN (SELECT id FROM _srch_comp);
DELETE FROM public.finance_audit_log             WHERE entity_id             IN (SELECT id FROM _srch_comp);
DELETE FROM public.comprobante_items             WHERE comprobante_id        IN (SELECT id FROM _srch_comp);
DELETE FROM public.comprobantes                  WHERE id                    IN (SELECT id FROM _srch_comp);

DELETE FROM public.inventory_movements
 WHERE inventory_item_id IN (SELECT id FROM public.inventory WHERE code LIKE 'SRCH-%');

DELETE FROM public.inventory
 WHERE business_id IN ('${E2E.business}', '${E2E.otroBusiness}')
   AND code LIKE 'SRCH-%';

-- ── 1. Relleno ────────────────────────────────────────────────────────────
-- Contiene 'Silicone' y 'iPhone' para saturar CUALQUIERA de los dos tokens que
-- el buscador del POS pueda elegir como término único.
INSERT INTO public.inventory
  (business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
   base_price, base_currency, auto_update_price, exchange_rate_used, is_active, tipo, has_variants)
SELECT
  '${E2E.business}',
  'Silicone iPhone Generico ' || lpad(n::text, 3, '0'),
  'SRCH-FILL-' || lpad(n::text, 3, '0'),
  'Fundas', 10, 10, 500, 900, 900, 'ARS', false, 1, true, 'product', false
FROM generate_series(1, ${F.relleno}) AS n;

-- ── 2. Representación A: padre agrupador + variantes vía supplier_code ────
INSERT INTO public.inventory
  (id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
   base_price, base_currency, auto_update_price, exchange_rate_used, is_active, tipo, has_variants)
VALUES
  ('${F.padreFunda}', '${E2E.business}', 'Funda Silicone iPhone 15', 'SRCH-FUN-IP15',
   'Fundas', 0, 0, 0, 0, 0, 'ARS', false, 1, true, 'product', true);

INSERT INTO public.inventory
  (id, business_id, name, code, category, subcategory, supplier_code,
   stock_quantity, stock, cost_price, sale_price, base_price, base_currency,
   auto_update_price, exchange_rate_used, is_active, tipo, has_variants)
VALUES
  ('${F.varNegro}', '${E2E.business}', 'Funda Silicone iPhone 15 - Negro',
   'SRCH-FUN-IP15-VAR-01', 'Fundas', 'Negro', 'variant_parent:${F.padreFunda}',
   7, 7, 6000, 12000, 12000, 'ARS', false, 1, true, 'product', false),
  ('${F.varAzul}', '${E2E.business}', 'Funda Silicone iPhone 15 - Azul',
   'SRCH-FUN-IP15-VAR-02', 'Fundas', 'Azul', 'variant_parent:${F.padreFunda}',
   5, 5, 6000, 12000, 12000, 'ARS', false, 1, true, 'product', false),
  ('${F.varRosa}', '${E2E.business}', 'Funda Silicone iPhone 15 - Rosa',
   'SRCH-FUN-IP15-VAR-03', 'Fundas', 'Rosa', 'variant_parent:${F.padreFunda}',
   3, 3, 6000, 12000, 12000, 'ARS', false, 1, true, 'product', false);

-- ── 3. Representación B: padre + variantes vía parent_id / variant_name ───
-- Acá el hijo guarda el nombre del PADRE en la columna name y el atributo en
-- variant_name, que es lo que hace productService.createVariant.
INSERT INTO public.inventory
  (id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
   base_price, base_currency, auto_update_price, exchange_rate_used, is_active, tipo, has_variants)
VALUES
  ('${F.padreVidrio}', '${E2E.business}', 'Vidrio Templado iPhone 14', 'SRCH-VID-IP14',
   'Protectores', 0, 0, 0, 0, 0, 'ARS', false, 1, true, 'product', true);

INSERT INTO public.inventory
  (id, business_id, name, variant_name, parent_id, code, category,
   stock_quantity, stock, cost_price, sale_price, base_price, base_currency,
   auto_update_price, exchange_rate_used, is_active, tipo, has_variants)
VALUES
  ('${F.vidrioComun}', '${E2E.business}', 'Vidrio Templado iPhone 14', 'Comun',
   '${F.padreVidrio}', 'SRCH-VID-IP14-V1', 'Protectores',
   9, 9, 1200, 3000, 3000, 'ARS', false, 1, true, 'product', false),
  ('${F.vidrioPriv}', '${E2E.business}', 'Vidrio Templado iPhone 14', 'Privacidad',
   '${F.padreVidrio}', 'SRCH-VID-IP14-V2', 'Protectores',
   4, 4, 1800, 4500, 4500, 'ARS', false, 1, true, 'product', false);

-- ── 4. Producto simple de control ────────────────────────────────────────
INSERT INTO public.inventory
  (id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
   base_price, base_currency, auto_update_price, exchange_rate_used, is_active, tipo, has_variants)
VALUES
  ('${F.bateria}', '${E2E.business}', 'Bateria iPhone 11', 'SRCH-BAT-IP11',
   'Repuestos', 12, 12, 4000, 9000, 9000, 'ARS', false, 1, true, 'product', false);

-- ── 5. Control multi-tenant: producto del negocio ajeno ──────────────────
INSERT INTO public.inventory
  (id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
   base_price, base_currency, auto_update_price, exchange_rate_used, is_active, tipo, has_variants)
VALUES
  ('${F.ajeno}', '${E2E.otroBusiness}', 'Funda Silicone iPhone 15 - Ajena', 'SRCH-AJENO-01',
   'Fundas', 99, 99, 100, 200, 200, 'ARS', false, 1, true, 'product', false);

SET LOCAL session_replication_role = 'origin';
COMMIT;
`

export function sqlDeFixtureBusqueda(): string {
  return SQL_SEARCH_FIXTURE
}
