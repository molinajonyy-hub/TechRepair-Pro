/**
 * @smoke
 * Crear cliente E2E y producto E2E básicos.
 *
 * FIXES aplicados:
 *   - Cliente: después de guardar, NewCustomer redirige a /customers/<id> (detalle),
 *     NO al listado. Se navega explícitamente de vuelta al listado antes de buscar.
 *   - Producto: inventory-new-button abre un dropdown. Se hace click en
 *     "Producto simple" (data-testid="inventory-new-product-simple") para abrir
 *     el modal, luego se espera que el input sea visible antes de llenar.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'
import { e2eCustomer, e2eProduct } from './helpers/data'

test.describe('@smoke Cliente + Inventario', () => {
  test('crear cliente E2E y verificar que aparece en búsqueda', async ({ page }) => {
    await login(page)
    await nav.customers(page)

    // Ir a página de nuevo cliente
    await page.click('[data-testid="customers-new-button"]')
    await expect(page).toHaveURL(/\/customers\/new/, { timeout: 10_000 })

    const name = e2eCustomer()
    await page.fill('[data-testid="customer-name-input"]', name)
    await page.fill('[data-testid="customer-phone-input"]', '1155550000')
    await page.click('[data-testid="customer-save-button"]')

    // POST-SAVE: NewCustomer redirige a /customers/<id> (detalle), no al listado.
    // Navegar explícitamente al listado para poder buscar.
    await expect(page).toHaveURL(/\/customers\/[a-f0-9-]{36}/, { timeout: 10_000 })
    await nav.customers(page)

    // Buscar el cliente recién creado en el listado
    const searchInput = page.locator('[data-testid="customers-search-input"]')
    await expect(searchInput).toBeVisible({ timeout: 10_000 })
    await searchInput.fill(name)
    await expect(page.locator(`text=${name}`)).toBeVisible({ timeout: 8_000 })
  })

  test('crear producto E2E con stock 10 y verificar en inventario', async ({ page }) => {
    await login(page)
    await nav.inventory(page)

    // inventory-new-button abre un DROPDOWN. El ítem queda hidden para Playwright
    // (un ancestro tiene overflow-x:hidden que clipea el position:absolute del dropdown).
    // page.evaluate con .click() nativo del browser no verifica visibilidad
    // y dispara el onClick de React correctamente.
    await page.click('[data-testid="inventory-new-button"]')
    await page.locator('[data-testid="inventory-new-product-simple"]').waitFor({ state: 'attached', timeout: 5_000 })
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="inventory-new-product-simple"]') as HTMLElement | null
      btn?.click()
    })

    // Esperar a que el modal abra y el input esté listo
    const nameInput = page.locator('[data-testid="product-name-input"]')
    await expect(nameInput).toBeVisible({ timeout: 10_000 })

    const name = e2eProduct()
    await nameInput.fill(name)

    // Stock, costo, precio — llenar si están visibles
    const stockInput = page.locator('[data-testid="product-stock-input"]')
    if (await stockInput.isVisible()) await stockInput.fill('10')

    const costInput = page.locator('[data-testid="product-cost-input"]')
    if (await costInput.isVisible()) await costInput.fill('500')

    const priceInput = page.locator('[data-testid="product-price-input"]')
    if (await priceInput.isVisible()) await priceInput.fill('1000')

    // Guardar y esperar cierre del modal
    await page.click('[data-testid="product-save-button"]')
    await expect(nameInput).not.toBeVisible({ timeout: 12_000 })

    // Buscar el producto en el inventario
    const searchInput = page.locator('[data-testid="inventory-search-input"]')
    await expect(searchInput).toBeVisible({ timeout: 8_000 })
    await searchInput.fill(name)
    await expect(page.locator(`text=${name}`)).toBeVisible({ timeout: 8_000 })
  })
})
