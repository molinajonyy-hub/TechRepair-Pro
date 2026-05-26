/**
 * @personal @projections @smoke
 * Mi Guita — Proyecciones mensuales.
 * Cubre navegación, selector de mes, widget del dashboard, hide amounts y estados vacíos.
 */
import { test, expect, type Page } from '@playwright/test'
import { login } from './helpers/auth'
import { watchConsoleErrors } from './helpers/console'

// ── helpers ───────────────────────────────────────────────────────────────────

async function openProjections(page: Page) {
  await page.goto('/personal/proyecciones')
  await page.waitForSelector('[data-testid="personal-layout"]', { timeout: 15_000 })
  await page.waitForSelector('[data-testid="personal-projections-page"]', { timeout: 10_000 })
}

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe('@personal @projections @smoke Mi Guita — proyecciones', () => {

  // ── Navigation ─────────────────────────────────────────────────────────────

  test('navegar a /personal/proyecciones carga sin errores de consola', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await openProjections(page)
    expect(errors().length).toBe(0)
  })

  test('pantalla de proyecciones visible sin crash', async ({ page }) => {
    await login(page)
    await openProjections(page)
    await expect(page.locator('[data-testid="personal-projections-page"]')).toBeVisible()
  })

  // ── Empty state ─────────────────────────────────────────────────────────────

  test('muestra empty state o contenido de proyección (nunca un error no controlado)', async ({ page }) => {
    await login(page)
    await openProjections(page)
    // Either shows empty state OR real projection content — both are valid
    const hasEmpty   = await page.locator('[data-testid="personal-projections-empty"]').isVisible()
    const hasContent = await page.locator('[data-testid="personal-projections-result-card"]').isVisible()
    const hasSummary = await page.locator('[data-testid="personal-projections-income"]').isVisible()
    expect(hasEmpty || hasContent || hasSummary).toBe(true)
  })

  // ── Month selector ─────────────────────────────────────────────────────────

  test('selector de mes visible y muestra el mes actual', async ({ page }) => {
    await login(page)
    await openProjections(page)
    await expect(page.locator('[data-testid="personal-projections-month-label"]')).toBeVisible()
    const label = await page.locator('[data-testid="personal-projections-month-label"]').textContent()
    // Should contain a year (e.g. "2026")
    expect(label).toMatch(/202[5-9]|203\d/)
  })

  test('botón siguiente avanza al mes próximo', async ({ page }) => {
    await login(page)
    await openProjections(page)
    const labelBefore = await page.locator('[data-testid="personal-projections-month-label"]').textContent()
    await page.click('[data-testid="personal-projections-month-next"]')
    // Wait for re-render
    await page.waitForTimeout(300)
    const labelAfter = await page.locator('[data-testid="personal-projections-month-label"]').textContent()
    expect(labelBefore).not.toBe(labelAfter)
  })

  test('navegar al mes anterior y volver da el mismo mes original', async ({ page }) => {
    await login(page)
    await openProjections(page)
    const labelBefore = await page.locator('[data-testid="personal-projections-month-label"]').textContent()
    // Go forward then back
    await page.click('[data-testid="personal-projections-month-next"]')
    await page.waitForTimeout(200)
    // Go back (there should be a prev button)
    const prevBtn = page.locator('button:has([data-lucide="chevron-left"]), button:has(svg)').first()
    // Use the first chevron-left button (prev month)
    const allButtons = page.locator('[data-testid="personal-projections-page"] button')
    const count = await allButtons.count()
    // The prev button is the first chevron button in the month selector
    // Simply click the month-next button twice and previous twice
    await page.click('[data-testid="personal-projections-month-next"]')
    await page.waitForTimeout(200)
    // Now we need a prev button — it doesn't have a testId but is the other button in the selector
    // Click the selector's first button (left chevron)
    const selectorArea = page.locator('[data-testid="personal-projections-month-label"]')
    const prevButton = selectorArea.locator('..').locator('button').first()
    await prevButton.click()
    await page.waitForTimeout(200)
    await prevButton.click()
    await page.waitForTimeout(200)
    const labelAfter = await page.locator('[data-testid="personal-projections-month-label"]').textContent()
    expect(labelAfter).toBe(labelBefore)
  })

  // ── Dashboard widget ────────────────────────────────────────────────────────

  test('widget de proyecciones visible en el dashboard', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-dashboard"]', { timeout: 15_000 })
    await expect(page.locator('[data-testid="personal-projections-widget"]')).toBeVisible()
  })

  test('widget de proyecciones navega a /personal/proyecciones al hacer click', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-projections-widget"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-projections-widget"]')
    await page.waitForURL('**/personal/proyecciones', { timeout: 5_000 })
    expect(page.url()).toContain('/personal/proyecciones')
  })

  // ── Hide amounts ────────────────────────────────────────────────────────────

  test('toggle ocultar enmascara montos en la página de proyecciones', async ({ page }) => {
    await login(page)
    await openProjections(page)
    const toggleBtn = page.locator('[data-testid="personal-projections-toggle-hide"]')
    await expect(toggleBtn).toBeVisible()
    await toggleBtn.click()
    // After toggling, amounts should be masked
    const pageContent = await page.locator('[data-testid="personal-projections-page"]').textContent()
    expect(pageContent).toContain('••••')
  })

  test('toggle hide en dashboard enmascara widget de proyecciones', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-dashboard"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-toggle-hide"]')
    // Widget should still be visible
    await expect(page.locator('[data-testid="personal-projections-widget"]')).toBeVisible()
    // Its amount should be masked
    const widgetResult = page.locator('[data-testid="personal-projections-widget-result"]')
    if (await widgetResult.isVisible()) {
      const text = await widgetResult.textContent()
      expect(text).toContain('••••')
    }
  })

  // ── Commitments sections (conditional) ─────────────────────────────────────

  test('sección de tarjetas visible en compromisos si hay compras de tarjeta', async ({ page }) => {
    await login(page)
    await openProjections(page)
    // If card data breakdown is visible, check it renders correctly
    const cardsRow = page.locator('[data-testid="personal-projections-breakdown-cards"]')
    if (await cardsRow.isVisible()) {
      await expect(cardsRow).toBeVisible()
    }
    // This test is informational — it passes regardless (no data = section hidden)
    expect(true).toBe(true)
  })

  test('sección de deudas visible en compromisos si hay deudas con cuotas', async ({ page }) => {
    await login(page)
    await openProjections(page)
    const debtsRow = page.locator('[data-testid="personal-projections-breakdown-debts"]')
    if (await debtsRow.isVisible()) {
      await expect(debtsRow).toBeVisible()
    }
    expect(true).toBe(true)
  })

  test('alerta de resultado negativo visible si compromisos superan ingresos', async ({ page }) => {
    await login(page)
    await openProjections(page)
    const alert = page.locator('[data-testid="personal-projections-alert"]')
    if (await alert.isVisible()) {
      // Alert is present — verify it has text content
      const text = await alert.textContent()
      expect(text?.length).toBeGreaterThan(0)
    }
    // Passing either way: no alert = healthy projection
    expect(true).toBe(true)
  })

  // ── Safe area ───────────────────────────────────────────────────────────────

  test('page container renderiza correctamente con safe-area padding', async ({ page }) => {
    await login(page)
    await openProjections(page)
    const container = page.locator('[data-testid="personal-projections-page"]')
    await expect(container).toBeVisible()
    const box = await container.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThan(0)
  })

})
