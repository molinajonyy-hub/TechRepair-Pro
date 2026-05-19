/**
 * @cc @finance
 * Cuenta corriente cliente:
 * - Venta en CC genera deuda en la cuenta del cliente.
 * - Pago reduce saldo.
 *
 * REQUISITOS:
 *   - La cuenta QA debe tener al menos un cliente CON cuenta corriente activa.
 *   - Caja abierta (para emitir el comprobante CC).
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'
import { e2eProduct } from './helpers/data'
import { ensureCajaOpen } from './helpers/caja'
import { createComprobanteCuentaCorriente } from './helpers/comprobante'
import { parseMoney } from './helpers/money'

test.describe('@cc @finance Cuenta corriente cliente', () => {
  test('venta en CC crea deuda en la cuenta corriente del cliente', async ({ page }) => {
    await login(page)

    // Verificar que hay algún cliente con CC (buscar en /cuentas)
    await page.goto('/cuentas')
    await page.waitForLoadState('networkidle')

    const accountRows = page.locator('[data-testid="cc-account-row"]')
    const rowCount = await accountRows.count()
    if (rowCount === 0) {
      test.skip(true,
        'Sin cuentas corrientes en el sistema. ' +
        'Crear un cliente desde /customers/new y asignarle una CC, ' +
        'o usar el flujo de comprobante que crea CC automáticamente.'
      )
      return
    }

    // Tomar el primer cliente con CC
    const firstRow = accountRows.first()
    const customerName = await firstRow.locator('td, [class*="entity_name"]').first().textContent()
    if (!customerName?.trim()) {
      test.skip(true, 'No se pudo leer el nombre del primer cliente de CC.')
      return
    }

    // Abrir el detalle y capturar saldo actual
    await firstRow.click()
    const detailBalance = page.locator('[data-testid="cc-detail-balance"]')
    await expect(detailBalance).toBeVisible({ timeout: 5_000 })
    const balanceBefore = parseMoney(await detailBalance.textContent())

    // Asegurar caja abierta
    const cajaAbierta = await ensureCajaOpen(page).then(() => true).catch(() => false)
    if (!cajaAbierta) {
      test.skip(true, 'No se pudo abrir la caja.')
      return
    }

    // Crear producto E2E
    const productName = e2eProduct()
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
    if (await priceInput.isVisible()) await priceInput.fill('500')
    await page.click('[data-testid="product-save-button"]')
    await expect(nameInput).not.toBeVisible({ timeout: 12_000 })

    // Crear comprobante en cuenta corriente
    await createComprobanteCuentaCorriente(page, {
      productName,
      customerName: customerName.trim(),
    })

    // Verificar que la deuda aumentó en la CC del cliente
    await page.goto('/cuentas')
    await page.waitForLoadState('networkidle')
    await page.locator('[data-testid="cc-search-input"]').fill(customerName.trim())
    await page.waitForTimeout(400)

    const rowsAfterSearch = page.locator('[data-testid="cc-account-row"]')
    await expect(rowsAfterSearch.first()).toBeVisible({ timeout: 8_000 })
    await rowsAfterSearch.first().click()

    const balanceAfter = parseMoney(await page.locator('[data-testid="cc-detail-balance"]').textContent())

    // La deuda debe haber aumentado (balance positivo = deuda)
    expect(balanceAfter, 'La deuda del cliente debe ser mayor después de la venta en CC').toBeGreaterThan(balanceBefore)
  })

  test('registrar pago reduce saldo de CC', async ({ page }) => {
    await login(page)

    await page.goto('/cuentas')
    await page.waitForLoadState('networkidle')

    // Buscar una cuenta con deuda
    const accountRows = page.locator('[data-testid="cc-account-row"]')
    const rowCount = await accountRows.count()
    if (rowCount === 0) {
      test.skip(true, 'Sin cuentas corrientes.')
      return
    }

    // Encontrar una fila con deuda (balance positivo)
    let rowWithDebt = -1
    for (let i = 0; i < Math.min(rowCount, 5); i++) {
      const balText = await accountRows.nth(i).locator('[data-testid="cc-balance-value"]').textContent()
      if (balText && parseMoney(balText) > 0) {
        rowWithDebt = i
        break
      }
    }

    if (rowWithDebt === -1) {
      test.skip(true, 'Sin cuentas en deuda — correr el test anterior primero o crear una venta CC.')
      return
    }

    await accountRows.nth(rowWithDebt).click()

    const detailBalance = page.locator('[data-testid="cc-detail-balance"]')
    await expect(detailBalance).toBeVisible({ timeout: 5_000 })
    const balanceBefore = parseMoney(await detailBalance.textContent())

    // Registrar pago parcial
    const payBtn = page.locator('[data-testid="cc-register-payment-button"]')
    await expect(payBtn).toBeVisible({ timeout: 5_000 })
    await payBtn.click()

    const amountInput = page.locator('[data-testid="cc-payment-amount-input"]')
    await expect(amountInput).toBeVisible({ timeout: 5_000 })

    const payAmount = Math.min(100, balanceBefore)
    await amountInput.fill(String(payAmount))
    await page.fill('[data-testid="cc-payment-description-input"]', 'E2E pago parcial test')
    await page.click('[data-testid="cc-payment-save-button"]')

    // El modal debe cerrarse y el balance debe actualizarse
    await expect(amountInput).not.toBeVisible({ timeout: 10_000 })

    // El balance debe ser menor
    await page.waitForTimeout(500)
    const balanceAfter = parseMoney(await detailBalance.textContent())
    expect(balanceAfter, 'El saldo debe reducirse después del pago').toBeLessThan(balanceBefore)
  })
})
