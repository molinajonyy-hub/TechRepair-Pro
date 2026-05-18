/**
 * @finance
 * TEST CRÍTICO: Editar cobro con pago único no infla total_cobrado.
 * Protege el fix de BUG-01 (replace_comprobante_payment RPC).
 *
 * Pre-condición: debe existir un comprobante pagado accesible en /comprobantes.
 * Si no hay datos de QA disponibles, usar test.fixme.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'

test.describe('@finance Editar cobro — pago único', () => {
  test('editar cobro de pago único no infla total_cobrado', async ({ page }) => {
    test.fixme(
      !process.env.E2E_COMPROBANTE_ID_EFECTIVO,
      'Requiere E2E_COMPROBANTE_ID_EFECTIVO: ID de un comprobante pagado con efectivo $1000'
    )

    await login(page)
    const comprobanteId = process.env.E2E_COMPROBANTE_ID_EFECTIVO!
    await page.goto(`/comprobantes/${comprobanteId}`)

    // Verificar estado inicial
    const estadoWidget = page.locator('[data-testid="estado-cobro-widget"]')
    await expect(estadoWidget).toBeVisible({ timeout: 10_000 })

    // Abrir Editar cobro
    await page.click('[data-testid="edit-payment-button"]')
    await expect(page.locator('[data-testid="edit-payment-amount-input"]')).toBeVisible()

    // El monto pre-cargado debe ser $1000, NO total_cobrado si estaba inflado
    const amountValue = await page.locator('[data-testid="edit-payment-amount-input"]').inputValue()
    expect(parseFloat(amountValue)).toBe(1000)

    // Cambiar método a transferencia
    await page.selectOption('[data-testid="edit-payment-method-select"]', 'transferencia')

    // Guardar
    await page.click('[data-testid="edit-payment-save-button"]')
    await expect(page.locator('[data-testid="edit-payment-save-button"]')).not.toBeVisible({ timeout: 8_000 })

    // Verificar que total_cobrado sigue siendo $1000 (no $1500)
    await expect(estadoWidget).not.toContainText('1.500')
    await expect(estadoWidget).not.toContainText('1500')
  })
})
