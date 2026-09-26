// ============================================================================
// G2-C.3A2 — Frontend sobre la autoridad canónica de stock (E2E LOCAL).
//
// Todo por la UI real contra el Supabase LOCAL; la base se consulta sólo para
// VERIFICAR (y para simular, por la misma RPC canónica, una venta posterior al
// export). Cada corrida usa nombres únicos: no depende de estado previo.
//
//   1. Inventario → alta con stock 5 → base 5, exactamente 1 movimiento
//      reference_type = initial_stock.
//   2. Editar sólo metadata → stock igual, 0 movimientos extra.
//   3. Ajuste manual (edición del stock) → movimiento canónico `manual`.
//   4. Duplicar → copia en 0, sin movimiento.
//   5. Import con un cambio posterior al export → stale: no se pisa.
//   6. Proveedor crea el producto → nace 0 → la compra canónica deja la
//      cantidad exacta (sin double-stock).
// ============================================================================
import { test, expect } from './fixtures'
import * as XLSX from 'xlsx'
import { ejecutarSQL, consultarJSON } from '../setup/sqlLocal.ts'
import { E2E } from '../setup/seedE2E.ts'

test.describe.configure({ mode: 'serial' })

const RUN = Date.now().toString(36).toUpperCase()
const NOMBRE = `G2C3A2 Pantalla ${RUN}`
const NOMBRE_EDITADO = `G2C3A2 Pantalla ${RUN} OLED`
const PROVEEDOR_ID = '00000000-0000-4000-8000-0000000a2a02'
const PROVEEDOR = 'Proveedor G2C3A2'
const NOMBRE_PROVEEDOR = `G2C3A2 Bateria ${RUN}`

type Fila = { id: string; code: string; stock_quantity: number; stock: number }
type Mov = { reference_type: string | null; movement_type: string; quantity: number; new_stock: number }

function producto(nombre: string): Fila {
  return consultarJSON<Fila>(
    `SELECT id, code, stock_quantity, stock FROM public.inventory
      WHERE business_id = '${E2E.business}' AND name = '${nombre.replace(/'/g, "''")}' AND is_active`,
  )
}

function movimientos(id: string): Mov[] {
  const r = consultarJSON<{ m: Mov[] | null }>(
    `SELECT json_agg(json_build_object('reference_type', reference_type, 'movement_type', movement_type,
                                       'quantity', quantity, 'new_stock', new_stock) ORDER BY created_at, id) AS m
       FROM public.inventory_movements WHERE inventory_item_id = '${id}'`,
  )
  return r.m ?? []
}

async function buscar(page: import('@playwright/test').Page, texto: string) {
  const input = page.locator('[data-testid="inventory-search-input"]')
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.fill(texto)
}

const fila = (page: import('@playwright/test').Page, nombre: string) =>
  page.locator('tr', { has: page.getByText(nombre, { exact: true }) }).first()

async function guardarModal(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="product-form-save-button"]').click()
  await expect(page.locator('[data-testid="product-form-modal"]')).toBeHidden({ timeout: 10_000 })
}

test.beforeAll(() => {
  ejecutarSQL(`
INSERT INTO public.suppliers (id, business_id, name, active)
VALUES ('${PROVEEDOR_ID}', '${E2E.business}', '${PROVEEDOR}', true)
ON CONFLICT (id) DO UPDATE SET active = true, name = EXCLUDED.name;`)
})

test('@m7 G2-C.3A2 · 1 · alta desde Inventario con stock 5 → 1 movimiento initial_stock', async ({ page }) => {
  await page.goto('/inventory')
  await page.locator('[data-testid="inventory-new-product-button"]').click()
  await page.locator('[data-testid="product-name-input"]').fill(NOMBRE)
  await page.locator('[data-testid="product-price-input"]').first().fill('45000')
  await page.locator('[data-testid="product-stock-input"]').fill('5')
  await guardarModal(page)

  await expect.poll(() => producto(NOMBRE).stock_quantity).toBe(5)
  const p = producto(NOMBRE)
  expect(p.stock).toBe(5) // alias sincronizado server-side
  const movs = movimientos(p.id)
  expect(movs).toHaveLength(1)
  expect(movs[0]).toMatchObject({ reference_type: 'initial_stock', movement_type: 'in', quantity: 5, new_stock: 5 })
})

test('@m7 G2-C.3A2 · 2 · editar sólo metadata no mueve stock', async ({ page }) => {
  const antes = producto(NOMBRE)
  await page.goto('/inventory')
  await buscar(page, NOMBRE)
  await fila(page, NOMBRE).getByTitle('Editar').click()
  await page.locator('[data-testid="product-name-input"]').fill(NOMBRE_EDITADO)
  await guardarModal(page)

  await expect.poll(() => producto(NOMBRE_EDITADO).id).toBe(antes.id)
  expect(producto(NOMBRE_EDITADO).stock_quantity).toBe(5)
  expect(movimientos(antes.id)).toHaveLength(1)
})

test('@m7 G2-C.3A2 · 3 · ajuste manual del stock → movimiento canónico manual', async ({ page }) => {
  const p = producto(NOMBRE_EDITADO)
  await page.goto('/inventory')
  await buscar(page, NOMBRE_EDITADO)
  await fila(page, NOMBRE_EDITADO).getByTitle('Editar').click()
  const stock = page.locator('[data-testid="product-stock-input"]')
  await expect(stock).toHaveValue('5')
  await stock.fill('8')
  await guardarModal(page)

  await expect.poll(() => producto(NOMBRE_EDITADO).stock_quantity).toBe(8)
  const movs = movimientos(p.id)
  expect(movs).toHaveLength(2)
  expect(movs[1]).toMatchObject({ reference_type: 'manual', movement_type: 'adjustment', quantity: 3, new_stock: 8 })
})

test('@m7 G2-C.3A2 · 4 · duplicar copia la definición en 0, sin movimiento', async ({ page }) => {
  await page.goto('/inventory')
  await buscar(page, NOMBRE_EDITADO)
  await fila(page, NOMBRE_EDITADO).getByTitle('Duplicar').click()
  const COPIA = `${NOMBRE_EDITADO} (copia)`
  await expect(fila(page, COPIA)).toBeVisible({ timeout: 10_000 })

  const copia = producto(COPIA)
  expect(copia.stock_quantity).toBe(0)
  expect(copia.stock).toBe(0)
  expect(movimientos(copia.id)).toHaveLength(0)
  // El original no se tocó.
  expect(producto(NOMBRE_EDITADO).stock_quantity).toBe(8)
})

test('@m7 G2-C.3A2 · 5 · import: una venta posterior al export NO se pisa (stale)', async ({ page }) => {
  const original = producto(NOMBRE_EDITADO)
  const copia = producto(`${NOMBRE_EDITADO} (copia)`)

  // Snapshot del export: original 8, copia 0. El usuario edita «Stock actual».
  const libro = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet([
    { 'Código/SKU': original.code, 'Nombre del producto': NOMBRE_EDITADO, 'Categoría': 'Otros', 'Stock actual': 2, 'Stock esperado': 8 },
    { 'Código/SKU': copia.code, 'Nombre del producto': `${NOMBRE_EDITADO} (copia)`, 'Categoría': 'Otros', 'Stock actual': 3, 'Stock esperado': 0 },
  ]), 'Inventario')
  const archivo = XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }) as Buffer

  // Después del export se venden 2 unidades del original: por la RPC canónica,
  // como el owner (misma autoridad que usa la app).
  ejecutarSQL(`
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${E2E.owner}","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT public.apply_inventory_stock_adjustments_atomic(
  '${E2E.business}', '[{"inventory_id":"${original.id}","delta":-2}]'::jsonb,
  'manual', 'Venta posterior al export (E2E)', 'e2e-g2c3a2-venta-${RUN}');
COMMIT;`)
  expect(producto(NOMBRE_EDITADO).stock_quantity).toBe(6)

  await page.goto('/inventory')
  await page.getByRole('button', { name: 'Importar' }).first().click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'inventario.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: archivo,
  })
  const modal = page.locator('div')
    .filter({ has: page.getByRole('heading', { name: 'Importar Inventario' }) })
    .filter({ has: page.getByRole('button', { name: 'Cancelar' }) })
    .last()
  await modal.getByRole('button', { name: 'Importar', exact: true }).click()
  await expect(page.getByText(/stock omitido porque cambió desde la exportación/)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/1 stock actualizado/)).toBeVisible()

  // El original conserva la venta (6), no el 2 del archivo viejo.
  expect(producto(NOMBRE_EDITADO).stock_quantity).toBe(6)
  expect(movimientos(original.id).filter((m) => m.reference_type === 'import')).toHaveLength(0)
  // La copia, que no cambió desde el export, sí se ajustó por import.
  expect(producto(`${NOMBRE_EDITADO} (copia)`).stock_quantity).toBe(3)
  expect(movimientos(copia.id)).toEqual([expect.objectContaining({ reference_type: 'import', movement_type: 'adjustment', quantity: 3, new_stock: 3 })])
})

test('@m7 G2-C.3A2 · 6 · proveedor crea el producto en 0 y la compra deja la cantidad exacta', async ({ page }) => {
  await page.goto('/suppliers')
  const filaProveedor = page.locator('[data-testid="supplier-row"]', { hasText: PROVEEDOR }).first()
  await expect(filaProveedor).toBeVisible({ timeout: 10_000 })
  await filaProveedor.getByTitle('Ver detalle').click()
  await page.locator('[data-testid="supplier-new-purchase"]').click()

  const buscador = page.getByPlaceholder('Buscar o escribir producto...')
  await buscador.fill(NOMBRE_PROVEEDOR)
  await page.getByRole('button', { name: new RegExp(`Crear producto completo: "${NOMBRE_PROVEEDOR}"`) }).dispatchEvent('mousedown')

  // Alta contextual: sin stock inicial, sólo el aviso.
  await expect(page.locator('[data-testid="product-form-modal"]')).toBeVisible()
  await expect(page.locator('[data-testid="product-stock-input"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="product-stock-contextual-hint"]')).toBeVisible()
  await page.locator('[data-testid="product-price-input"]').first().fill('9000')
  await guardarModal(page)

  const creado = producto(NOMBRE_PROVEEDOR)
  expect(creado.stock_quantity).toBe(0)
  expect(movimientos(creado.id)).toHaveLength(0)

  // Compra de 3 unidades por el writer documental canónico.
  await expect(page.getByText('Vinculado al inventario')).toBeVisible()
  const cantidad = page.locator('input[type="number"][min="1"]').first()
  await cantidad.fill('3')
  await page.locator('input[type="number"][min="0"][placeholder="0"]').first().fill('4000')
  await page.getByRole('button', { name: /^Registrar \$/ }).click()

  await expect.poll(() => producto(NOMBRE_PROVEEDOR).stock_quantity, { timeout: 15_000 }).toBe(3)
  const movs = movimientos(creado.id)
  expect(movs).toHaveLength(1)
  expect(movs[0]).toMatchObject({ quantity: 3, new_stock: 3 })
})
