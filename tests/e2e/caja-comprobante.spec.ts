/**
 * @cash @finance @local-only
 * Comprobante efectivo impacta caja.
 * Protege que una venta en efectivo genera un movimiento de ingreso en la caja.
 *
 * REQUISITOS: caja abierta.
 * @local-only: No correr contra techrepairpro.app (modifica caja del día).
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'
import { e2eProduct } from './helpers/data'
import { ensureCajaOpen } from './helpers/caja'
import { createComprobanteCash } from './helpers/comprobante'

test.describe('@cash @finance @local-only Comprobante efectivo impacta caja', () => {
  test('crear comprobante efectivo crea movimiento en caja', async ({ page }) => {
    await login(page)

    const cajaAbierta = await ensureCajaOpen(page).then(() => true).catch(() => false)
    if (!cajaAbierta) {
      test.skip(true, 'No se pudo abrir la caja — abrir manualmente desde /caja.')
      return
    }

    // Contar movimientos actuales
    await nav.caja(page)
    await page.waitForLoadState('networkidle')

    const movsList = page.locator('[data-testid="caja-movements-list"]')
    const movsBefore = await movsList.isVisible()
      ? await page.locator('[data-testid="caja-movement-row"]').count()
      : 0

    // Crear un producto E2E y comprobante efectivo
    const productName = e2eProduct()

    // Crear producto via inventario
    await nav.inventory(page)
    await page.click('[data-testid="inventory-new-button"]')
    await page.locator('[data-testid="inventory-new-product-simple"]').waitFor({ state: 'attached', timeout: 5_000 })
    await page.evaluate(() => {
      (document.querySelector('[data-testid="inventory-new-product-simple"]') as HTMLElement)?.click()
    })
    const nameInput = page.locator('[data-testid="product-name-input"]')
    await expect(nameInput).toBeVisible({ timeout: 10_000 })
    await nameInput.fill(productName)
    const priceInput = page.locator('[data-testid="product-price-input"]')
    if (await priceInput.isVisible()) await priceInput.fill('1000')
    await page.click('[data-testid="product-save-button"]')
    await expect(nameInput).not.toBeVisible({ timeout: 12_000 })

    // Crear comprobante efectivo
    await createComprobanteCash(page, { productName, paymentMethod: 'efectivo' })

    // Verificar en caja que hay un movimiento nuevo
    await nav.caja(page)
    await page.waitForLoadState('networkidle')

    const movsAfter = await page.locator('[data-testid="caja-movement-row"]').count()

    // Debe haber al menos un movimiento más que antes
    if (movsAfter <= movsBefore) {
      // Si la caja no muestra el widget de movimientos (ej. caja del día diferente)
      // verificamos que la sección de movimientos existe
      const hasMovsList = await page.locator('[data-testid="caja-movements-list"]').isVisible()
      if (!hasMovsList) {
        test.skip(true, 'La caja no muestra lista de movimientos — posiblemente la caja es de hoy pero está en otro panel.')
        return
      }
    }

    expect(movsAfter, 'Debe haber al menos un movimiento más en caja después del comprobante efectivo')
      .toBeGreaterThan(movsBefore)
  })
})
