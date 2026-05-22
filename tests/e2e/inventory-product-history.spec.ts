/**
 * @inventory @smoke
 * Historial inteligente de producto en Inventario.
 * No crea datos. Solo lectura.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'
import { watchConsoleErrors } from './helpers/console'

const INVENTORY_ID = process.env.E2E_INVENTORY_ID ?? ''
const INVALID_VALS = ['NaN', 'undefined', '[object Object]']

// ─── Inventory page: baseline ──────────────────────────────────────────────

test.describe('@inventory @smoke Inventario — lista', () => {

  test('página de inventario carga sin crash', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await nav.inventory(page)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('h1, .page-hdr-title').filter({ hasText: /inventario/i }))
      .toBeVisible({ timeout: 15_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('tabla o empty state se renderiza', async ({ page }) => {
    await login(page)
    await nav.inventory(page)
    await page.waitForLoadState('networkidle')

    const rows  = await page.locator('table tbody tr').count()
    const empty = await page.locator('[data-testid="inventory-empty"], text=/no hay productos|sin productos/i').count()
    expect(rows + empty, 'Debe mostrar tabla o empty state').toBeGreaterThan(0)
  })
})

// ─── Product history via direct URL fixture ────────────────────────────────

test.describe('@inventory @smoke Historial de producto — con fixture', () => {
  test.skip(!INVENTORY_ID, 'E2E_INVENTORY_ID no configurado — saltar tests de historial')

  test.beforeEach(async ({ page }) => {
    await login(page)
    await nav.inventory(page)
    await page.waitForLoadState('networkidle')
  })

  test('abrir modal de historial desde fila de producto', async ({ page }) => {
    const errors = watchConsoleErrors(page)

    // Click the history button (icon-btn with history-like icon) on any row
    const historyBtn = page.locator('[data-testid="inventory-history-button"], button[title*="Historial"], button[title*="historial"], button[title*="Movimientos"]').first()
    await expect(historyBtn).toBeVisible({ timeout: 10_000 })
    await historyBtn.click()

    await expect(page.locator('[data-testid="inventory-product-detail"]'))
      .toBeVisible({ timeout: 15_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('modal de historial no muestra valores inválidos', async ({ page }) => {
    const historyBtn = page.locator('[data-testid="inventory-history-button"], button[title*="Historial"], button[title*="historial"], button[title*="Movimientos"]').first()
    if (await historyBtn.count() === 0) {
      test.skip()
      return
    }
    await historyBtn.click()
    await page.waitForLoadState('networkidle')

    // Wait for loading to finish
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="inventory-product-detail"] .animate-spin'),
      { timeout: 15_000 }
    )

    const body = await page.locator('[data-testid="inventory-product-detail"]').textContent()
    for (const val of INVALID_VALS) {
      expect(body, `No debe contener "${val}"`).not.toContain(val)
    }
  })

  test('summary cards visibles después de cargar', async ({ page }) => {
    const historyBtn = page.locator('[data-testid="inventory-history-button"], button[title*="Historial"], button[title*="historial"], button[title*="Movimientos"]').first()
    if (await historyBtn.count() === 0) { test.skip(); return }
    await historyBtn.click()

    // Wait for RPC to resolve
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="inventory-product-detail"] .animate-spin'),
      { timeout: 15_000 }
    )

    // Either summary or empty state
    const hasSummary = await page.locator('[data-testid="inventory-product-summary"]').count()
    const hasHistory = await page.locator('[data-testid="inventory-product-history"]').count()
    expect(hasSummary + hasHistory, 'Modal debe mostrar summary o historial').toBeGreaterThan(0)
  })

  test('filtros no crashean al hacer click', async ({ page }) => {
    const historyBtn = page.locator('[data-testid="inventory-history-button"], button[title*="Historial"], button[title*="historial"], button[title*="Movimientos"]').first()
    if (await historyBtn.count() === 0) { test.skip(); return }
    await historyBtn.click()
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="inventory-product-detail"] .animate-spin'),
      { timeout: 15_000 }
    )

    const filterBar = page.locator('[data-testid="inventory-product-filter"]')
    await expect(filterBar).toBeVisible({ timeout: 5_000 })

    // Click through each filter
    for (const label of ['Entradas', 'Salidas', 'Compras', 'Ventas', 'Todos']) {
      const btn = filterBar.locator('button', { hasText: label })
      if (await btn.count() > 0) {
        await btn.click()
        // Brief pause to ensure no crash
        await page.waitForTimeout(200)
      }
    }

    // Modal still visible after clicking all filters
    await expect(page.locator('[data-testid="inventory-product-detail"]')).toBeVisible()
  })
})

// ─── Product history without fixture: open first available ──────────────────

test.describe('@inventory @smoke Historial de producto — sin fixture', () => {

  test('abrir primer producto disponible y ver historial sin crash', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await nav.inventory(page)
    await page.waitForLoadState('networkidle')

    // Try to find any history button
    const histBtn = page.locator(
      '[data-testid="inventory-history-button"], button[title*="Historial"], button[title*="Movimientos"]'
    ).first()

    if (await histBtn.count() === 0) {
      // No products visible — acceptable
      return
    }

    await histBtn.click()
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-testid="inventory-product-detail"]')).toBeVisible({ timeout: 15_000 })

    // Wait for RPC load
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="inventory-product-detail"] .animate-spin'),
      { timeout: 15_000 }
    )

    // No invalid values
    const bodyText = await page.locator('[data-testid="inventory-product-detail"]').textContent()
    for (const val of INVALID_VALS) {
      expect(bodyText, `No debe contener "${val}"`).not.toContain(val)
    }

    // Historial or empty state present
    const hasHistorySection = await page.locator('[data-testid="inventory-product-history"]').count()
    expect(hasHistorySection, 'Historial container debe estar presente').toBeGreaterThan(0)

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('producto sin movimientos muestra empty state claro', async ({ page }) => {
    // This test only applies if a product with no movements exists
    // It's a best-effort test — we open any product and check that
    // an empty state with useful text appears (not a blank screen)
    await login(page)
    await nav.inventory(page)
    await page.waitForLoadState('networkidle')

    const histBtn = page.locator(
      '[data-testid="inventory-history-button"], button[title*="Historial"], button[title*="Movimientos"]'
    ).first()
    if (await histBtn.count() === 0) return

    await histBtn.click()
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="inventory-product-detail"] .animate-spin'),
      { timeout: 15_000 }
    )

    const historyEl = page.locator('[data-testid="inventory-product-history"]')
    await expect(historyEl).toBeVisible({ timeout: 10_000 })

    // Either movement rows or a meaningful empty message (not blank)
    const rows    = await page.locator('[data-testid="inventory-product-movement-row"]').count()
    const isEmpty = await historyEl.textContent()
    const hasContent = rows > 0 || (isEmpty ?? '').trim().length > 10

    expect(hasContent, 'Historial debe tener filas o mensaje de empty state').toBe(true)
  })
})
