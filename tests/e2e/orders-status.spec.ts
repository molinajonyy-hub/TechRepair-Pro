/**
 * @orders
 * Cambio de estado de orden de servicio.
 * Protege que el StatusChange component funciona: select → update → persiste.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { createOrderViaUI, e2eOrderData } from './helpers/orders'

test.describe('@orders Cambio de estado de orden', () => {
  test('crear orden y cambiar estado de Recibida a En diagnóstico', async ({ page }) => {
    await login(page)

    const data = e2eOrderData()
    const orderId = await createOrderViaUI(page, data)
    expect(orderId).toBeTruthy()

    // Estamos en /orders/<id>
    await expect(page).toHaveURL(new RegExp(`/orders/${orderId}`))

    // Esperar a que el select de estado esté visible
    const statusSelect = page.locator('[data-testid="order-status-select"]')
    await expect(statusSelect).toBeVisible({ timeout: 10_000 })

    // Seleccionar "En diagnóstico" (valor: "diagnosis")
    await statusSelect.selectOption('diagnosis')

    // El botón de actualizar debe habilitarse
    const updateBtn = page.locator('[data-testid="order-status-update-button"]')
    await expect(updateBtn).toBeEnabled({ timeout: 3_000 })
    await updateBtn.click()

    // El status actualizado debe reflejarse (buscar el badge o texto con el nuevo estado)
    await expect(page.locator('body')).toContainText(/diagn[oó]stico/i, { timeout: 8_000 })

    // Recargar página y confirmar que el estado persiste
    await page.reload()
    await page.waitForURL(new RegExp(`/orders/${orderId}`), { timeout: 10_000 })
    await expect(page.locator('body')).toContainText(/diagn[oó]stico/i, { timeout: 8_000 })
  })
})
