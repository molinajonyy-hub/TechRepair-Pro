// ============================================================================
// P0 SEARCH — Un producto con variantes que se ve en Inventario TIENE que
// poder cobrarse.
//
// Reproduce el reporte del owner desde una base limpia: catálogo con relleno
// suficiente para desbordar el tope viejo del buscador, un padre agrupador y
// sus variantes. Antes de este lote, buscar el producto por su nombre en la
// caja devolvía cero resultados aunque Inventario lo mostrara perfecto.
//
// Los asserts no se conforman con "aparece en pantalla": verifican identidad
// por id (no por texto renderizado) y el efecto en base tabla por tabla. Un
// test que sólo mire la UI pasaría igual descontándole el stock al padre.
// ============================================================================
import { test, expect } from './fixtures'
import { ejecutarSQL, consultarJSON } from '../setup/sqlLocal.ts'
import { sqlDeFixtureBusqueda, SEARCH_FIXTURE } from '../setup/seedSearchFixture.ts'
import { E2E } from '../setup/seedE2E.ts'
import { abrirCaja } from '../setup/fixturesM7.ts'
import {
  openComprobanteModal,
  selectPaymentMethod,
  submitComprobante,
  closeAfterSuccess,
} from '../helpers/comprobante'

const PADRE = 'Funda Silicone iPhone 15'
const VARIANTE_NEGRO = 'Funda Silicone iPhone 15 - Negro'
const SKU_NEGRO = 'SRCH-FUN-IP15-VAR-01'

/** Stock actual de una fila de inventario, leído de la base. */
function stockDe(id: string): number {
  const fila = consultarJSON<{ stock_quantity: number }>(
    `SELECT stock_quantity FROM public.inventory WHERE id = '${id}'`,
  )
  return Number(fila.stock_quantity)
}

/** Ids de los resultados que el POS ofrece como seleccionables. */
async function idsOfrecidos(page: import('@playwright/test').Page): Promise<string[]> {
  const opciones = page.locator('[data-testid="comprobante-product-option"]')
  await expect(opciones.first()).toBeVisible({ timeout: 8_000 })
  return opciones.evaluateAll(nodos =>
    nodos.map(n => (n as HTMLElement).dataset.productId ?? ''),
  )
}

/** Escribe en el buscador del POS y espera a que el dropdown resuelva. */
async function buscarEnPos(page: import('@playwright/test').Page, texto: string) {
  const input = page.locator('[data-testid="comprobante-product-search"]')
  await expect(input).toBeVisible({ timeout: 8_000 })
  await input.fill(texto)
}

test.beforeAll(() => {
  // Fixture autoabastecido: el spec no depende de estado acumulado local ni de
  // haber corrido otro test antes. Es idempotente (borra por prefijo y resiembra).
  ejecutarSQL(sqlDeFixtureBusqueda())
  // Cobrar en efectivo exige caja abierta: precondición, no lo que se prueba.
  abrirCaja()
})

// ─── Inventario: la referencia visual ───────────────────────────────────────

test('@m7 Inventario muestra la variante del producto con variantes', async ({ page }) => {
  await page.goto('/inventory')
  await page.locator('[data-testid="inventory-search-input"]').fill(PADRE)

  // El padre agrupa y la variante existe: es exactamente lo que ve el owner
  // antes de ir a cobrar.
  await expect(page.getByText(PADRE, { exact: false }).first()).toBeVisible({ timeout: 10_000 })
})

// ─── POS: el gate P0 ────────────────────────────────────────────────────────

test('@m7 REGRESIÓN P0: buscar el nombre del padre en el POS ofrece sus variantes', async ({ page }) => {
  await openComprobanteModal(page)
  await buscarEnPos(page, PADRE)

  const ids = await idsOfrecidos(page)

  // Las tres variantes vendibles tienen que estar. Antes del fix: 0 resultados.
  expect(ids).toContain(SEARCH_FIXTURE.varNegro)
  expect(ids).toContain(SEARCH_FIXTURE.varAzul)
  expect(ids).toContain(SEARCH_FIXTURE.varRosa)

  // Y tienen que estar ARRIBA: la primera opción viene resaltada y Enter la
  // agrega, así que un producto ajeno en el primer lugar carga el ítem
  // equivocado. El relleno matchea "15" por su código (SRCH-FILL-150).
  const variantes = new Set<string>([
    SEARCH_FIXTURE.varNegro, SEARCH_FIXTURE.varAzul, SEARCH_FIXTURE.varRosa,
  ])
  expect(variantes.has(ids[0]),
    `la primera opción debería ser una variante del producto buscado, no ${ids[0]}`).toBe(true)
  expect(ids.slice(0, 3).every(id => variantes.has(id)),
    'las tres primeras opciones deben ser las tres variantes').toBe(true)
})

test('@m7 el padre agrupador NO es seleccionable en el POS', async ({ page }) => {
  await openComprobanteModal(page)
  await buscarEnPos(page, PADRE)

  const ids = await idsOfrecidos(page)
  // Si el padre fuera seleccionable se vendería una unidad que no existe:
  // su stock vive en las variantes y el suyo es siempre 0.
  expect(ids).not.toContain(SEARCH_FIXTURE.padreFunda)
})

test('@m7 buscar por el nombre completo de la variante la encuentra', async ({ page }) => {
  await openComprobanteModal(page)
  await buscarEnPos(page, VARIANTE_NEGRO)

  expect(await idsOfrecidos(page)).toContain(SEARCH_FIXTURE.varNegro)
})

test('@m7 buscar por el atributo suelto encuentra la variante', async ({ page }) => {
  await openComprobanteModal(page)
  await buscarEnPos(page, 'funda silicone negro')

  expect(await idsOfrecidos(page)).toContain(SEARCH_FIXTURE.varNegro)
})

test('@m7 REGRESIÓN P0: el SKU exacto devuelve exactamente esa variante', async ({ page }) => {
  await openComprobanteModal(page)
  await buscarEnPos(page, SKU_NEGRO)

  const ids = await idsOfrecidos(page)
  // Antes del fix el SKU colapsaba al token "srch" y traía cualquier cosa.
  expect(ids[0]).toBe(SEARCH_FIXTURE.varNegro)
})

test('@m7 la variante creada con parent_id también se encuentra por el nombre del padre', async ({ page }) => {
  // Segunda representación del modelo: el hijo guarda el nombre del padre en
  // `name` y el atributo en `variant_name`. Tiene que comportarse igual.
  await openComprobanteModal(page)
  await buscarEnPos(page, 'Vidrio Templado iPhone 14')

  const ids = await idsOfrecidos(page)
  expect(ids).toContain(SEARCH_FIXTURE.vidrioComun)
  expect(ids).toContain(SEARCH_FIXTURE.vidrioPriv)
  expect(ids).not.toContain(SEARCH_FIXTURE.padreVidrio)
})

// ─── Padre detectable sólo por ESTRUCTURA ───────────────────────────────────

test('@m7 un padre con has_variants=false pero con hijos reales NO es seleccionable', async ({ page }) => {
  // `has_variants` lo escribe el cliente y ningún trigger lo mantiene:
  // createProductWithVariants lo setea con un UPDATE separado cuyo error no se
  // chequea. Si ese UPDATE falla, quedan las variantes creadas y el padre con
  // el flag en false. Con stock 0, ofrecerlo es vender un producto fantasma.
  await openComprobanteModal(page)
  await buscarEnPos(page, 'Cargador Rapido iPhone 20W')

  const ids = await idsOfrecidos(page)

  expect(ids, 'el padre estructural no puede ofrecerse aunque el flag diga que no lo es')
    .not.toContain(SEARCH_FIXTURE.padreRoto)
  // Y sus hijos sí, por las dos representaciones de vínculo.
  expect(ids).toContain(SEARCH_FIXTURE.rotoPorParent)
  expect(ids).toContain(SEARCH_FIXTURE.rotoPorPrefijo)
})

test('@m7 el padre estructural tampoco aparece buscando su SKU exacto', async ({ page }) => {
  await openComprobanteModal(page)
  await buscarEnPos(page, 'SRCH-CAR-IP20')

  const ids = await idsOfrecidos(page)
  expect(ids).not.toContain(SEARCH_FIXTURE.padreRoto)
})

// ─── Multi-tenant ───────────────────────────────────────────────────────────

test('@m7 el producto del negocio ajeno nunca aparece en el POS', async ({ page }) => {
  await openComprobanteModal(page)
  await buscarEnPos(page, 'Funda Silicone iPhone 15')

  const ids = await idsOfrecidos(page)
  expect(ids).not.toContain(SEARCH_FIXTURE.ajeno)
})

// ─── Venta completa: el efecto económico ────────────────────────────────────

test('@m7 vender la variante descuenta SU stock y no toca al padre ni a la hermana', async ({ page }) => {
  // Estado de partida medido en base, no asumido.
  const stockNegroAntes = stockDe(SEARCH_FIXTURE.varNegro)
  const stockAzulAntes  = stockDe(SEARCH_FIXTURE.varAzul)
  const stockPadreAntes = stockDe(SEARCH_FIXTURE.padreFunda)

  await openComprobanteModal(page)
  await buscarEnPos(page, SKU_NEGRO)

  // Se selecciona por id, no "el primero que aparezca".
  const opcion = page.locator(
    `[data-testid="comprobante-product-option"][data-product-id="${SEARCH_FIXTURE.varNegro}"]`,
  )
  await expect(opcion).toBeVisible({ timeout: 8_000 })
  await opcion.click()

  await selectPaymentMethod(page, 'efectivo')
  await submitComprobante(page)
  await closeAfterSuccess(page)

  // ── El comprobante referencia al HIJO, no al padre ──────────────────────
  const linea = consultarJSON<{ inventory_id: string; cantidad: number }>(`
    SELECT ci.inventory_id, ci.cantidad
      FROM public.comprobante_items ci
      JOIN public.comprobantes c ON c.id = ci.comprobante_id
     WHERE c.business_id = '${E2E.business}'
       AND ci.inventory_id = '${SEARCH_FIXTURE.varNegro}'
     ORDER BY ci.created_at DESC
     LIMIT 1
  `)
  expect(linea.inventory_id).toBe(SEARCH_FIXTURE.varNegro)
  expect(Number(linea.cantidad)).toBe(1)

  // ── Movimiento de inventario sobre el hijo ──────────────────────────────
  const mov = consultarJSON<{ n: number; del_padre: number }>(`
    SELECT
      count(*) FILTER (WHERE inventory_item_id = '${SEARCH_FIXTURE.varNegro}')::int    AS n,
      count(*) FILTER (WHERE inventory_item_id = '${SEARCH_FIXTURE.padreFunda}')::int  AS del_padre
      FROM public.inventory_movements
     WHERE business_id = '${E2E.business}'
  `)
  expect(mov.n).toBeGreaterThan(0)
  // El padre agrupador no puede tener movimientos: nunca se vende.
  expect(mov.del_padre).toBe(0)

  // ── Stock: sólo baja el de la variante vendida ──────────────────────────
  expect(stockDe(SEARCH_FIXTURE.varNegro)).toBe(stockNegroAntes - 1)
  expect(stockDe(SEARCH_FIXTURE.varAzul)).toBe(stockAzulAntes)
  expect(stockDe(SEARCH_FIXTURE.padreFunda)).toBe(stockPadreAntes)
})
