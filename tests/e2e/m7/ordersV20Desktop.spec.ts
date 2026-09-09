/**
 * ORDERS-V2-0 · Revisión visual DESKTOP.
 *
 * El spec de MOBILE-2A cubre 320/390/430 px. Este cubre el ancho al que se
 * carga la mayoría de las órdenes en un mostrador: una notebook.
 *
 * Las cuatro superficies que cambió el lote: selector de cliente, selector de
 * catálogo, checklist y edición de cliente. Se aseveran las propiedades que un
 * screenshot no prueba solo — sin scroll horizontal y targets táctiles — y se
 * deja la captura como evidencia.
 */
import { expect, test, type Page } from '@playwright/test'

const EVIDENCE = 'docs/orders-v2-0-evidence'
const DESKTOP = { width: 1440, height: 900 }

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'la página no debe scrollear en horizontal').toBeLessThanOrEqual(0)
}

/** El design system pide 44 px para lo que se toca. */
async function minTouchTarget(page: Page, selector: string, min = 44) {
  const boxes = await page.locator(selector).evaluateAll(nodes =>
    nodes.map(node => node.getBoundingClientRect().height))
  expect(boxes.length).toBeGreaterThan(0)
  for (const height of boxes) expect(height).toBeGreaterThanOrEqual(min)
}

async function continuar(page: Page) {
  await page.getByRole('button', { name: 'Continuar' }).last().click()
}

test.use({ viewport: DESKTOP })

test.describe('@ordersv20 ORDERS-V2-0 · desktop', () => {
  test('selector de cliente, catálogo y checklist', async ({ page }) => {
    await page.goto('/orders/new')

    // ── Cliente ────────────────────────────────────────────────────────────
    await page.getByTestId('customer-picker-search').fill('Cliente E2E')
    const resultado = page.getByRole('button', { name: /Cliente E2E/ }).first()
    await expect(resultado).toBeVisible()
    await minTouchTarget(page, '[data-testid="customer-picker-results"] button')
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${EVIDENCE}/1440-01-customer-picker.png` })

    await resultado.click()
    await expect(resultado).toHaveAttribute('aria-pressed', 'true')
    await continuar(page)

    // ── Equipo · catálogo ──────────────────────────────────────────────────
    // ORDERS-V2-0.1: dejó de ser `<input list>` + `<datalist>` — en WebKit
    // móvil esa lista no se desplegaba. Ahora es un combobox con marcado
    // propio, así que las opciones se pueden aseverar de verdad.
    // Se toma por testid y no por etiqueta: `getByLabel` de Playwright hace
    // match por SUBCADENA, así que «Marca» también resolvería a la lista
    // «Sugerencias de Marca». (En testing-library el match es exacto, por eso
    // los tests de componente sí pueden usar la etiqueta.)
    const marca = page.getByTestId('intake-brand')
    await expect(marca).toHaveAttribute('role', 'combobox')
    await marca.click()
    const listbox = page.getByRole('listbox', { name: 'Sugerencias de Marca' })
    await expect(listbox).toBeVisible()
    expect(await listbox.getByRole('option').count()).toBeGreaterThan(0)
    await marca.fill('Samsung')
    await page.getByTestId('intake-model').fill('Galaxy A04e')
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${EVIDENCE}/1440-02-catalogo.png` })
    await continuar(page)

    // ── Checklist ──────────────────────────────────────────────────────────
    await continuar(page) // identificación
    await continuar(page) // estado y fotos

    await expect(page.getByRole('radiogroup', { name: 'Pantalla' })).toBeVisible()
    await expect(page.getByRole('radiogroup')).toHaveCount(8)
    await page.getByRole('radio', { name: 'Pantalla: OK' }).check()
    await page.getByRole('radio', { name: 'Táctil: Falla' }).check()
    await minTouchTarget(page, '.intake-check-opt')
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${EVIDENCE}/1440-03-checklist.png` })

    // El foco se ve y el grupo se recorre con flechas, sin mouse.
    await page.getByRole('radio', { name: 'Cámaras: OK' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('radio', { name: 'Cámaras: Falla' })).toBeChecked()
  })

  test('edición de cliente usa el diálogo global', async ({ page }) => {
    await page.goto('/customers')
    await page.getByTitle('Editar cliente').first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // Los campos son los canónicos, no una copia con inputs propios.
    await expect(dialog.getByTestId('customer-name-input')).toBeVisible()
    await expect(dialog.getByTestId('customer-document-type-dni')).toBeVisible()
    await expect(dialog.getByTestId('customer-edit-save-button')).toBeVisible()
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${EVIDENCE}/1440-04-customer-edit.png` })
  })
})
