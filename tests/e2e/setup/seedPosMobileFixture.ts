// ============================================================================
// POS PRE-BETA — Fixture del gate móvil del POS.
//
// Siembra las dos cosas que ningún fixture creaba y sin las cuales el gate
// pasaría en verde sin probar nada:
//
//   1. Una fila en `sales_points`. La tabla estaba VACÍA en todos los fixtures,
//      así que la consulta del punto de venta devolvía cero filas tanto rota
//      como arreglada, y el POS mostraba '0001' en los dos casos. Con un PV
//      sembrado, el número que aparece en pantalla distingue una cosa de la
//      otra.
//
//      `numero = 7` a propósito: NO es el default '0001' del estado inicial, así
//      que ver "0007" sólo puede venir de haber leído la tabla de verdad.
//
//      Se siembran DOS puntos de venta activos para fijar también el criterio de
//      desempate: el 3 se crea PRIMERO (created_at anterior) pero el
//      predeterminado es el 7. La consulta ordena por `predeterminado DESC,
//      numero ASC` — igual que public.get_active_sales_point — así que debe
//      ganar el 7. Con el orden viejo (created_at ASC) ganaría el 3.
//
//   2. `comprobante_items` con `inventory_id` NO nulo. Los 5 items del seed
//      base tienen inventory_id NULL, y la franja "Recientes" filtra
//      `.not('inventory_id','is',null)`, así que nunca se renderizaba y su
//      geometría quedaba sin medir.
// ============================================================================
import { E2E } from './seedE2E.ts'
import { SEARCH_FIXTURE } from './seedSearchFixture.ts'

/** Datos determinísticos que el gate móvil asevera en pantalla. */
export const POS_MOBILE_FIXTURE = {
  /** PV predeterminado: lo que el POS debe mostrar, formateado a 4 dígitos. */
  puntoVentaNumero: 7,
  puntoVentaFormateado: '0007',
  /** PV más viejo pero NO predeterminado: gana sólo si el orden está mal. */
  puntoVentaSeñuelo: 3,
  puntoVentaSeñueloFormateado: '0003',
  salesPointPredeterminado: '00000000-0000-0000-0000-00000e2e5001',
  salesPointSeñuelo:        '00000000-0000-0000-0000-00000e2e5002',
  comprobanteRecientes:     '00000000-0000-0000-0000-00000e2e5003',
  /** PV FISCAL (arca_config). Distinto del local a propósito: 3 vs 7. */
  puntoVentaFiscal:           3,
  puntoVentaFiscalFormateado: '0003',
} as const

const P = POS_MOBILE_FIXTURE

const SQL = `
BEGIN;
SET LOCAL session_replication_role = 'replica';

-- ── Idempotencia ─────────────────────────────────────────────────────────
DELETE FROM public.comprobante_items WHERE comprobante_id = '${P.comprobanteRecientes}';
DELETE FROM public.comprobantes      WHERE id             = '${P.comprobanteRecientes}';
DELETE FROM public.sales_points
 WHERE id IN ('${P.salesPointPredeterminado}', '${P.salesPointSeñuelo}');

-- ── 1. Puntos de venta ───────────────────────────────────────────────────
-- El señuelo va PRIMERO para que su created_at sea anterior.
INSERT INTO public.sales_points
  (id, business_id, numero, nombre, sucursal, domicilio, condicion_fiscal,
   activo, predeterminado, tipo_emision, created_at)
VALUES
  ('${P.salesPointSeñuelo}', '${E2E.business}', ${P.puntoVentaSeñuelo},
   'Sucursal vieja', 'Centro', 'Calle Falsa 123', 'Monotributo',
   true, false, 'manual', now() - interval '2 days'),
  ('${P.salesPointPredeterminado}', '${E2E.business}', ${P.puntoVentaNumero},
   'Casa Central', 'Casa Central', 'Av. Siempreviva 742', 'Monotributo',
   true, true, 'manual', now() - interval '1 day');

-- ── 1b. Configuracion ARCA — la fuente FISCAL, distinta de la local ──────
-- 3 (fiscal) vs 7 (local) es el caso adversarial del lote: prueba que el POS
-- muestre el fiscal y que el checkout persista el fiscal, no el local.
DELETE FROM public.arca_config WHERE business_id = '${E2E.business}';
INSERT INTO public.arca_config (business_id, cuit_emisor, ambiente, punto_venta)
VALUES ('${E2E.business}', '20111111112', 'homologacion', ${P.puntoVentaFiscal});

-- ── 2. Historial de ventas para la franja "Recientes" ────────────────────
-- Los nombres de las variantes son largos a propósito: el chip recorta con
-- ellipsis a maxWidth 8rem y así se verifica que recorte en vez de empujar.
INSERT INTO public.comprobantes
  (id, business_id, tipo, punto_venta, numero, condicion_fiscal,
   subtotal, total, estado, created_by)
VALUES
  ('${P.comprobanteRecientes}', '${E2E.business}', 'remito', '0007', '00099999',
   'Consumidor Final', 36000, 36000, 'emitido', '${E2E.owner}');

INSERT INTO public.comprobante_items
  (comprobante_id, business_id, inventory_id, descripcion, cantidad,
   precio_unitario, subtotal, currency, exchange_rate, price_override, orden)
VALUES
  ('${P.comprobanteRecientes}', '${E2E.business}', '${SEARCH_FIXTURE.varNegro}',
   'Funda Silicone iPhone 15 - Negro', 1, 12000, 12000, 'ARS', 1, false, 1),
  ('${P.comprobanteRecientes}', '${E2E.business}', '${SEARCH_FIXTURE.varAzul}',
   'Funda Silicone iPhone 15 - Azul',  1, 12000, 12000, 'ARS', 1, false, 2),
  ('${P.comprobanteRecientes}', '${E2E.business}', '${SEARCH_FIXTURE.varRosa}',
   'Funda Silicone iPhone 15 - Rosa',  1, 12000, 12000, 'ARS', 1, false, 3),
  ('${P.comprobanteRecientes}', '${E2E.business}', '${SEARCH_FIXTURE.vidrioComun}',
   'Vidrio Templado iPhone 14 - Comun', 1, 3000, 3000, 'ARS', 1, false, 4),
  ('${P.comprobanteRecientes}', '${E2E.business}', '${SEARCH_FIXTURE.bateria}',
   'Bateria iPhone 11', 1, 9000, 9000, 'ARS', 1, false, 5);

SET LOCAL session_replication_role = 'origin';
COMMIT;
`

export function sqlDeFixturePosMobile(): string {
  return SQL
}
