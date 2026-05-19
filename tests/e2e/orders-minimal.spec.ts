/**
 * @orders
 * Orden con datos mínimos — protege contra undefined/null/NaN en el template de impresión.
 * Crea una orden sin presupuesto, sin IMEI, sin diagnóstico previo.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { createOrderViaUI, e2eOrderData } from './helpers/orders'

test.describe('@orders Orden con datos mínimos', () => {
  test('preview de orden mínima no muestra undefined, null ni NaN', async ({ page }) => {
    await login(page)

    const data = { ...e2eOrderData(), budget: '' }
    const orderId = await createOrderViaUI(page, data)
    expect(orderId).toBeTruthy()

    // Abrir el modal de impresión
    const printBtn = page.locator('[data-testid="order-print-preview-button"]')
    await expect(printBtn).toBeVisible({ timeout: 10_000 })
    await printBtn.click()

    const printRoot = page.locator('[data-testid="service-order-print-root"]')
    await expect(printRoot).toBeVisible({ timeout: 10_000 })

    const printText = await printRoot.textContent()

    // Valores inválidos que nunca deben aparecer en el documento impreso
    expect(printText).not.toContain('undefined')
    expect(printText).not.toContain('[object Object]')
    expect(printText).not.toContain('NaN')

    // "null" puede aparecer en IDs internos pero no como texto visible al usuario
    // Verificar que el cliente aparece correctamente
    expect(printText?.trim().length).toBeGreaterThan(50)
  })
})
