/**
 * @customers @smoke
 * Clientes — historial de compras (customer_purchase_history RPC).
 * No crea datos. Solo lectura.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'
import { watchConsoleErrors } from './helpers/console'

const CUSTOMER_ID = process.env.E2E_CUSTOMER_ID ?? ''

test.describe('@customers @smoke Clientes lista', () => {

  test('página de clientes carga sin crash', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await nav.customers(page)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('h1, .page-hdr-title').filter({ hasText: /cliente/i }))
      .toBeVisible({ timeout: 15_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('tabla de clientes o empty state se renderiza', async ({ page }) => {
    await login(page)
    await nav.customers(page)
    await page.waitForLoadState('networkidle')

    // Either rows or empty message
    const rows  = await page.locator('table tbody tr').count()
    const empty = await page.locator('text=/no hay clientes|sin clientes/i').count()
    expect(rows + empty).toBeGreaterThan(0)
  })
})

test.describe('@customers @smoke Clientes — detalle con fixture', () => {
  test.skip(!CUSTOMER_ID, 'E2E_CUSTOMER_ID no configurado — saltar tests de detalle')

  test.beforeEach(async ({ page }) => {
    await login(page)
    await page.goto(`/customers/${CUSTOMER_ID}`)
    await page.waitForLoadState('networkidle')
    // Wait for the customer name heading
    await expect(page.locator('h1, .page-hdr-title').first()).toBeVisible({ timeout: 15_000 })
  })

  test('tabs Órdenes y Compras son visibles', async ({ page }) => {
    await expect(page.locator('.tab', { hasText: /órdenes/i })).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.tab', { hasText: /compras/i })).toBeVisible({ timeout: 10_000 })
  })

  test('tab Compras — testid principal presente', async ({ page }) => {
    const errors = watchConsoleErrors(page)

    const comprasTab = page.locator('.tab', { hasText: /compras/i })
    await comprasTab.click()
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-testid="customer-purchase-history"]'))
      .toBeVisible({ timeout: 15_000 })

    expect(errors().length, 'Sin errores de consola en tab Compras').toBe(0)
  })

  test('tab Compras — muestra summary o empty state correcto', async ({ page }) => {
    const comprasTab = page.locator('.tab', { hasText: /compras/i })
    await comprasTab.click()
    await page.waitForLoadState('networkidle')

    // Wait for loading to finish (phLoading false)
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="customer-purchase-history"] .animate-spin'),
      { timeout: 15_000 }
    )

    const hasSummary = await page.locator('[data-testid="customer-purchase-summary"]').count()
    const hasRows    = await page.locator('[data-testid="customer-purchase-row"]').count()
    const hasEmpty   = await page.locator('text=/todavía no tiene compras|no hay compras/i').count()

    // If summary exists, at least one row should exist
    if (hasSummary > 0) {
      expect(hasRows, 'Con summary, debe haber al menos una compra').toBeGreaterThan(0)
    }

    // Must show something (not blank)
    expect(hasSummary + hasRows + hasEmpty, 'Tab Compras debe mostrar contenido').toBeGreaterThan(0)
  })

  test('tab Compras — filtros visibles si hay compras', async ({ page }) => {
    const comprasTab = page.locator('.tab', { hasText: /compras/i })
    await comprasTab.click()
    await page.waitForLoadState('networkidle')

    const hasRows = await page.locator('[data-testid="customer-purchase-row"]').count()
    if (hasRows > 0) {
      await expect(page.locator('[data-testid="customer-purchase-filter"]'))
        .toBeVisible({ timeout: 5_000 })
    }
  })

  test('expandir compra muestra ítems', async ({ page }) => {
    const comprasTab = page.locator('.tab', { hasText: /compras/i })
    await comprasTab.click()
    await page.waitForLoadState('networkidle')

    const expandBtn = page.locator('[data-testid="customer-purchase-expand"]').first()
    if (await expandBtn.count() === 0) {
      test.skip() // No purchases — skip gracefully
      return
    }

    await expandBtn.click()
    await expect(page.locator('[data-testid="customer-purchase-items"]').first())
      .toBeVisible({ timeout: 5_000 })
  })
})

// ── Navegación general sin fixture ─────────────────────────────────────────
test.describe('@customers @smoke Clientes — detalle sin fixture', () => {

  test('abrir primer cliente disponible y tab Compras no crashea', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await nav.customers(page)
    await page.waitForLoadState('networkidle')

    // Try to click into any customer
    const firstRow = page.locator('table tbody tr a, [class*="customer-row"] a').first()
    if (await firstRow.count() === 0) {
      // No customers exist — acceptable
      return
    }

    await firstRow.click()
    await page.waitForLoadState('networkidle')

    const comprasTab = page.locator('.tab', { hasText: /compras/i })
    await comprasTab.click()
    await page.waitForLoadState('networkidle')

    // After 15s of networkidle, no crash
    const body = await page.locator('body').textContent()
    expect(body?.includes('NaN'), 'No debe haber NaN visible').toBe(false)
    expect(errors().length, 'Sin errores de consola').toBe(0)
  })
})
