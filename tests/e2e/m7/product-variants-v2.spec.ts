import { test, expect } from './fixtures'
import { consultarJSON, ejecutarSQL } from '../setup/sqlLocal'
import { E2E } from '../setup/seedE2E'
import { abrirCaja } from '../setup/fixturesM7'
import { openComprobanteModal, selectPaymentMethod, submitComprobante, closeAfterSuccess } from '../helpers/comprobante'

const suffix = Date.now().toString(36)
const familyName = `Funda Variantes V2 ${suffix}`
const sku = `PV2-${suffix}`
const order = crypto.randomUUID()
const device = crypto.randomUUID()
const stockOf = (id: string) => consultarJSON<{ stock_quantity: number }>(`SELECT stock_quantity FROM inventory WHERE id='${id}'`).stock_quantity

test('@m7 variants V2: create through UI, sell one child, add another to an order, preserve family stock', async ({ page }) => {
  test.setTimeout(90000)
  abrirCaja()
  const writes: unknown[] = []
  page.on('request', request => {
    if (/\/rest\/v1\/inventory(?:\?|$)/.test(request.url()) && ['POST', 'PATCH'].includes(request.method())) writes.push(request.postDataJSON())
  })
  await page.goto('/inventory')
  await page.getByTestId('inventory-new-product-chevron').click()
  await page.getByTestId('inventory-new-product-variants').click()
  const modal = page.getByTestId('product-form-modal')
  await modal.getByTestId('product-name-input').fill(familyName)
  await modal.getByPlaceholder('P001', { exact: true }).fill(sku)
  await modal.getByTestId('product-price-input').first().fill('5000')
  for (const [i, name] of ['Negro', 'Azul', 'Rosa'].entries()) {
    if (i) await modal.getByRole('button', { name: '+ Agregar', exact: true }).click()
    await modal.getByTestId('variant-name-input').nth(i).fill(name)
    await modal.getByTestId('variant-sku-input').nth(i).fill(`${sku}-${i}`)
    await modal.getByTestId('variant-stock-input').nth(i).fill(String([3, 5, 2][i]))
  }
  await modal.getByTestId('product-form-save-button').click()
  await expect(modal).not.toBeVisible()
  const parent = consultarJSON<{ id: string; has_variants: boolean; parent_id: string | null; stock_quantity: number }>(`SELECT id,has_variants,parent_id,stock_quantity FROM inventory WHERE code='${sku}'`)
  expect(parent).toMatchObject({ has_variants: true, parent_id: null, stock_quantity: 0 })
  const children = consultarJSON<{ rows: Array<{ id: string; variant_name: string; stock_quantity: number; has_variants: boolean }> }>(`SELECT jsonb_agg(i ORDER BY code) AS rows FROM (SELECT id,code,variant_name,stock_quantity,has_variants FROM inventory WHERE parent_id='${parent.id}') i`).rows
  expect(children.map(child => child.stock_quantity)).toEqual([3, 5, 2])
  expect(children.every(child => !child.has_variants)).toBe(true)
  const metadata = consultarJSON<{ count: number; nonzero: number; orphan: number }>(`SELECT count(*)::int AS count,count(*) FILTER(WHERE stock<>0)::int AS nonzero,count(*) FILTER(WHERE inventory_item_id IS NULL)::int AS orphan FROM product_variants WHERE product_id='${parent.id}'`)
  expect(metadata).toEqual({ count: 3, nonzero: 0, orphan: 0 })
  for (const payload of writes.flat()) {
    expect(payload).not.toHaveProperty('stock_quantity')
    expect(payload).not.toHaveProperty('stock')
  }
  await page.getByTestId('inventory-search-input').fill(familyName)
  const group = page.locator(`[data-testid="inventory-product-row"][data-inventory-id="${parent.id}"]`)
  await group.getByTitle('Mostrar variantes').click()
  for (const child of children) await expect(page.locator(`[data-inventory-id="${child.id}"]`).first()).toBeVisible()

  await openComprobanteModal(page)
  await page.getByTestId('comprobante-product-search').fill(familyName)
  const options = page.getByTestId('comprobante-product-option')
  await expect(options).toHaveCount(3)
  await expect(page.locator(`[data-testid="comprobante-product-option"][data-product-id="${parent.id}"]`)).toHaveCount(0)
  await page.locator(`[data-testid="comprobante-product-option"][data-product-id="${children[0].id}"]`).click()
  await selectPaymentMethod(page, 'efectivo')
  await submitComprobante(page)
  await closeAfterSuccess(page)
  expect(stockOf(children[0].id)).toBe(2)
  expect(stockOf(children[1].id)).toBe(5)
  expect(stockOf(children[2].id)).toBe(2)
  expect(stockOf(parent.id)).toBe(0)

  ejecutarSQL(`INSERT INTO devices(id,business_id,customer_id,type,brand,model,issue) VALUES('${device}','${E2E.business}','${E2E.customer}','smartphone','Equipo','Variantes V2','Fixture local');
    INSERT INTO orders(id,business_id,customer_id,device_id,status,priority) VALUES('${order}','${E2E.business}','${E2E.customer}','${device}','new','medium');`)
  await page.goto(`/orders/${order}`)
  await page.getByRole('button', { name: 'Agregar ítem', exact: true }).click()
  await page.getByRole('button', { name: /Buscar en inventario/ }).click()
  await page.getByPlaceholder('Nombre o código del repuesto...').fill(familyName)
  await expect(page.getByTestId('order-product-option')).toHaveCount(3)
  const option = page.locator(`[data-testid="order-product-option"][data-inventory-id="${children[1].id}"]`)
  await expect(option).toContainText('Azul')
  await option.click()
  await page.getByRole('button', { name: 'Agregar repuesto', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agregar ítem', exact: true })).not.toBeVisible()
  const line = consultarJSON<{ product_id: string }>(`SELECT product_id FROM order_items WHERE order_id='${order}'`)
  expect(line.product_id).toBe(children[1].id)
  expect(stockOf(children[1].id)).toBe(4)
  expect(stockOf(children[0].id)).toBe(2)
  expect(stockOf(children[2].id)).toBe(2)
  expect(stockOf(parent.id)).toBe(0)
})

for (const theme of ['light', 'dark']) {
  test(`@m7 variants V2 mobile 375: manual cards and dimensional generator (${theme})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/inventory')
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme)
    await page.getByTestId('inventory-new-product-chevron').click()
    await page.getByTestId('inventory-new-product-variants').click()
    const modal = page.getByTestId('product-form-modal')
    await expect(modal.getByTestId('variant-name-input')).toBeVisible()
    await modal.getByTestId('variant-name-input').fill('Negro / 128GB')
    await modal.getByRole('button', { name: 'Generador masivo', exact: true }).click()
    const values = modal.getByPlaceholder('Valor + Enter').first()
    for (const value of ['Negro', 'Azul', 'Negro']) { await values.fill(value); await values.press('Enter') }
    await modal.getByRole('button', { name: '+ Agregar dimensión', exact: true }).click()
    await modal.getByPlaceholder('Color / Capacidad / Tamaño...').nth(1).fill('Capacidad')
    for (const value of ['128GB', '256GB']) { await modal.getByPlaceholder('Valor + Enter').nth(1).fill(value); await modal.getByPlaceholder('Valor + Enter').nth(1).press('Enter') }
    await modal.getByRole('button', { name: 'Generar 4 variantes', exact: true }).click()
    await expect(modal.getByText('4 variantes', { exact: true })).toBeVisible()
    await modal.getByRole('button', { name: 'Editar variante Azul / 256GB' }).click()
    await modal.getByTestId('variant-name-input').last().fill('Azul / 256GB editable')
    await modal.getByTestId('variant-name-input').last().scrollIntoViewIfNeeded()
    const sizes = await modal.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }))
    expect(sizes.content).toBeLessThanOrEqual(sizes.width)
    const fields = await modal.locator('input:visible:not([type="checkbox"])').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width))
    expect(fields.every(width => width >= 44)).toBe(true)
    const checkboxTargets = await modal.locator('label:has(input[type="checkbox"]):visible').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height))
    expect(checkboxTargets.every(height => height >= 44)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`variants-mobile-${theme}.png`) })
  })
}
