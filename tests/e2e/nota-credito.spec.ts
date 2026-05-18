/**
 * @finance
 * Nota de crédito: verifica que el EstadoCobroWidget muestra el estado
 * correcto y NO muestra "Pendiente de cobro" ni botón "Editar cobro".
 * Requiere ID de una NC existente en el entorno QA.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'

test.describe('@finance Nota de crédito', () => {
  test('NC muestra widget correcto sin "Pendiente de cobro" ni editar cobro', async ({ page }) => {
    test.fixme(
      !process.env.E2E_NOTA_CREDITO_ID,
      'Requiere E2E_NOTA_CREDITO_ID: ID de una nota de crédito existente en el entorno QA'
    )

    await login(page)
    await page.goto(`/comprobantes/${process.env.E2E_NOTA_CREDITO_ID!}`)

    const widget = page.locator('[data-testid="estado-cobro-widget"]')
    await expect(widget).toBeVisible({ timeout: 10_000 })

    // Debe mostrar "Nota de crédito" o "devolución"
    await expect(widget).toContainText(/nota de cr.dito|devoluci.n|ajuste/i)

    // NO debe mostrar "Pendiente de cobro"
    await expect(widget).not.toContainText(/pendiente de cobro/i)

    // NO debe tener botón "Editar cobro"
    await expect(page.locator('[data-testid="edit-payment-button"]')).not.toBeVisible()
  })
})
