/**
 * @finance
 * TEST CRÍTICO: Editar cobro con pago mixto no infla total_cobrado.
 * Protege el fix de BUG-01 (replace_comprobante_payment RPC).
 *
 * Este test es el caso más importante: mezcla de $500 + $500 → editar a $1000.
 * Resultado esperado: total_cobrado = $1000, NO $1500 ni $2000.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'

test.describe('@finance Editar cobro — pago mixto (BUG-01 regression)', () => {
  test('pago mixto + editar cobro no genera total_cobrado > total', async ({ page }) => {
    test.fixme(
      !process.env.E2E_COMPROBANTE_ID_MIXTO,
      'Requiere E2E_COMPROBANTE_ID_MIXTO: ID de comprobante creado con pago $500 efectivo + $500 transferencia'
    )

    await login(page)
    const comprobanteId = process.env.E2E_COMPROBANTE_ID_MIXTO!
    await page.goto(`/comprobantes/${comprobanteId}`)

    const estadoWidget = page.locator('[data-testid="estado-cobro-widget"]')
    await expect(estadoWidget).toBeVisible({ timeout: 10_000 })

    // Abrir Editar cobro
    await page.click('[data-testid="edit-payment-button"]')
    const amountInput = page.locator('[data-testid="edit-payment-amount-input"]')
    await expect(amountInput).toBeVisible()

    // Monto debe ser el total del comprobante, no la suma inflada
    const amountValue = await amountInput.inputValue()
    const amount = parseFloat(amountValue)
    expect(amount).toBeLessThanOrEqual(1000) // total del comprobante
    expect(amount).not.toBe(1500)

    // Cambiar a transferencia total
    await amountInput.fill('1000')
    await page.selectOption('[data-testid="edit-payment-method-select"]', 'transferencia')
    await page.click('[data-testid="edit-payment-save-button"]')
    await expect(page.locator('[data-testid="edit-payment-save-button"]')).not.toBeVisible({ timeout: 8_000 })

    // Verificar que el widget NO muestra valores inflados
    await expect(estadoWidget).not.toContainText('1.500')
    await expect(estadoWidget).not.toContainText('1500')
    await expect(estadoWidget).not.toContainText('2.000')
    await expect(estadoWidget).not.toContainText('2000')
  })
})
