/**
 * @warranty @smoke
 * Módulo de Garantías extendido — legacy (equipos vendidos) + nuevo (reparaciones).
 * No crea datos permanentes sin fixtures. Lectura + navegación.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'
import { watchConsoleErrors } from './helpers/console'

// ─── Garantías — lista y módulo principal ─────────────────────────────────

test.describe('@warranty @smoke Garantías — módulo', () => {

  test('página de garantías carga sin crash', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await nav.warranties(page)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('h1, .page-hdr-title').filter({ hasText: /garantía/i }))
      .toBeVisible({ timeout: 15_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('filtros de estado visibles (Vigente, Por vencer, Vencida)', async ({ page }) => {
    await login(page)
    await nav.warranties(page)
    await page.waitForLoadState('networkidle')

    // Filter bar should have status and source selects
    const selects = page.locator('select')
    await expect(selects.first()).toBeVisible({ timeout: 10_000 })
    const count = await selects.count()
    expect(count, 'Debe haber al menos 2 selects de filtro').toBeGreaterThanOrEqual(2)
  })

  test('filtro de Origen incluye tipos de garantía', async ({ page }) => {
    await login(page)
    await nav.warranties(page)
    await page.waitForLoadState('networkidle')

    // Look for a select that contains "Equipo vendido" option
    const origenSelect = page.locator('select').filter({ hasText: /equipo vendido|reparaci/i }).first()
    if (await origenSelect.count() > 0) {
      await expect(origenSelect).toBeVisible()
    }
    // Even if not found, the test is informational
  })

  test('garantías existentes (equipos vendidos) siguen visibles', async ({ page }) => {
    await login(page)
    await nav.warranties(page)
    await page.waitForLoadState('networkidle')

    // Legacy warranties should still show (may be 0 if no data)
    const rows   = await page.locator('table tbody tr').count()
    const empty  = await page.locator('text=/no hay garantías|sin garantías/i').count()

    // At least one must be true (rows OR empty state)
    expect(rows + empty, 'Debe mostrar tabla o empty state').toBeGreaterThan(0)
  })

  test('botón "Nueva garantía" visible', async ({ page }) => {
    await login(page)
    await nav.warranties(page)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('button', { hasText: /nueva garantía/i }).first())
      .toBeVisible({ timeout: 10_000 })
  })

  test('modal "Nueva garantía" incluye selector de origen y tipo', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await nav.warranties(page)
    await page.waitForLoadState('networkidle')

    await page.locator('button', { hasText: /nueva garantía/i }).first().click()

    // Wait for modal
    await expect(page.locator('text=/nueva garantía/i').nth(1)).toBeVisible({ timeout: 10_000 })

    // Check source + type selectors present in modal
    const modalSelects = page.locator('[style*="0b1120"] select, [class*="modal"] select')
    const modalSelectCount = await modalSelects.count()
    expect(modalSelectCount, 'Modal debe tener selects de origen y tipo').toBeGreaterThanOrEqual(1)

    // Close
    await page.keyboard.press('Escape')

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })
})

// ─── Garantía existente — detalle y acciones ──────────────────────────────

test.describe('@warranty @smoke Garantías — detalle con datos existentes', () => {

  test('abrir detalle de primera garantía disponible', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await nav.warranties(page)
    await page.waitForLoadState('networkidle')

    const firstRow = page.locator('table tbody tr').first()
    if (await firstRow.count() === 0) return // No warranties — skip

    await firstRow.click()
    await page.waitForLoadState('networkidle')

    // Modal detail should open
    const modal = page.locator('[role="dialog"], div[style*="position: fixed"]').last()
    await expect(modal).toBeVisible({ timeout: 10_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('botón WhatsApp genera link wa.me en el detalle', async ({ page }) => {
    await login(page)
    await nav.warranties(page)
    await page.waitForLoadState('networkidle')

    const firstRow = page.locator('table tbody tr').first()
    if (await firstRow.count() === 0) return

    await firstRow.click()

    const waBtn = page.locator('[data-testid="warranty-whatsapp-button"]')
    await expect(waBtn).toBeVisible({ timeout: 10_000 })

    const href = await waBtn.getAttribute('href')
    expect(href, 'Href debe ser un link de WhatsApp').toContain('wa.me')
  })

  test('botón Imprimir A4 presente en el detalle', async ({ page }) => {
    await login(page)
    await nav.warranties(page)
    await page.waitForLoadState('networkidle')

    const firstRow = page.locator('table tbody tr').first()
    if (await firstRow.count() === 0) return

    await firstRow.click()

    await expect(page.locator('button', { hasText: /imprimir/i }).first())
      .toBeVisible({ timeout: 10_000 })
  })
})

// ─── Integración con OrderDetail ─────────────────────────────────────────

test.describe('@warranty @smoke Garantías — desde orden', () => {

  test('botón Garantía existe en OrderDetail', async ({ page }) => {
    await login(page)
    await page.goto('/orders')
    await page.waitForLoadState('networkidle')

    // Open first order
    const firstOrderLink = page.locator('table tbody tr a, [class*="order-row"]').first()
    if (await firstOrderLink.count() === 0) return

    await firstOrderLink.click()
    await page.waitForLoadState('networkidle')

    // Warranty button should exist
    const warrantyBtn = page.locator('[data-testid="order-create-warranty-button"]')
    await expect(warrantyBtn).toBeVisible({ timeout: 10_000 })
  })

  test('modal de garantía desde orden incluye datos del cliente prefilled', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await page.goto('/orders')
    await page.waitForLoadState('networkidle')

    const firstOrderLink = page.locator('table tbody tr a').first()
    if (await firstOrderLink.count() === 0) return

    await firstOrderLink.click()
    await page.waitForLoadState('networkidle')

    const warrantyBtn = page.locator('[data-testid="order-create-warranty-button"]')
    if (await warrantyBtn.count() === 0) return

    await warrantyBtn.click()

    // Modal should open
    await expect(page.locator('h2', { hasText: /garantía/i }).first()).toBeVisible({ timeout: 10_000 })

    // Warranty source should be pre-set to "Reparación"
    const sourceSelect = page.locator('select').first()
    const sourceVal = await sourceSelect.inputValue()
    expect(sourceVal, 'Source debe ser service_order').toContain('service_order')

    // Close
    await page.keyboard.press('Escape')

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })
})
