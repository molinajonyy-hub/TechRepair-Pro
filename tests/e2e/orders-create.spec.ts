/**
 * @orders
 * Crear orden de servicio básica via UI.
 * Protege el flujo NewOrder → redirect a OrderDetail.
 *
 * DATOS CREADOS: marca E2E, modelo E2E, orden E2E — prefijo E2E_.
 * REQUISITO: la cuenta QA debe tener al menos un cliente registrado.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { createOrderViaUI, e2eOrderData } from './helpers/orders'

test.describe('@orders Crear orden de servicio', () => {
  test('crear orden básica redirige a detalle con botón imprimir visible', async ({ page }) => {
    await login(page)

    const data = e2eOrderData()
    const orderId = await createOrderViaUI(page, data)

    // Verificar redirect al detalle
    expect(orderId).toBeTruthy()
    await expect(page).toHaveURL(new RegExp(`/orders/${orderId}`), { timeout: 15_000 })

    // Esperar que el OrderDetail cargue — el botón imprimir es un elemento confiable del detalle
    const printBtn = page.locator('[data-testid="order-print-preview-button"]')
    await expect(printBtn).toBeVisible({ timeout: 15_000 })

    // El status change también debe estar visible
    await expect(page.locator('[data-testid="order-status-select"]')).toBeVisible({ timeout: 8_000 })
  })

  test('listado de órdenes tiene botón Nueva Orden y búsqueda', async ({ page }) => {
    await login(page)
    await page.goto('/orders')

    await expect(page.locator('[data-testid="orders-new-button"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="orders-search-input"]')).toBeVisible({ timeout: 5_000 })
  })
})
