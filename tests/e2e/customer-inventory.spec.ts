/**
 * @smoke
 * Crear cliente E2E y producto E2E básicos.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'
import { e2eCustomer, e2eProduct } from './helpers/data'

test.describe('@smoke Cliente + Inventario', () => {
  test('crear cliente E2E y verificar que aparece en búsqueda', async ({ page }) => {
    await login(page)
    await nav.customers(page)

    // Ir a nueva página de cliente
    await page.click('[data-testid="customers-new-button"]')
    await expect(page).toHaveURL(/\/customers\/new/, { timeout: 10_000 })

    const name = e2eCustomer()
    await page.fill('[data-testid="customer-name-input"]', name)
    await page.fill('[data-testid="customer-phone-input"]', '1155550000')
    await page.click('[data-testid="customer-save-button"]')

    // Redirige de vuelta a /customers
    await expect(page).toHaveURL(/\/customers/, { timeout: 10_000 })

    // Buscar el cliente recién creado
    await page.fill('[data-testid="customers-search-input"]', name)
    await expect(page.locator(`text=${name}`)).toBeVisible({ timeout: 8_000 })
  })

  test('crear producto E2E con stock 10 y verificar en inventario', async ({ page }) => {
    await login(page)
    await nav.inventory(page)

    await page.click('[data-testid="inventory-new-button"]')

    const name = e2eProduct()
    await page.fill('[data-testid="product-name-input"]', name)

    // Stock, costo, precio
    const stockInput = page.locator('[data-testid="product-stock-input"]')
    if (await stockInput.isVisible()) {
      await stockInput.fill('10')
    }
    const costInput = page.locator('[data-testid="product-cost-input"]')
    if (await costInput.isVisible()) await costInput.fill('500')

    const priceInput = page.locator('[data-testid="product-price-input"]')
    if (await priceInput.isVisible()) await priceInput.fill('1000')

    await page.click('[data-testid="product-save-button"]')

    // Buscar producto
    await page.fill('[data-testid="inventory-search-input"]', name)
    await expect(page.locator(`text=${name}`)).toBeVisible({ timeout: 8_000 })
  })
})
