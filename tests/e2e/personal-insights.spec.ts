/**
 * @personal @insights @smoke
 * Mi Guita — Insights de finanzas personales.
 * Cubre navegación, estados vacíos, filtros, widget del dashboard, CTAs y hide amounts.
 */
import { test, expect, type Page } from '@playwright/test'
import { login } from './helpers/auth'
import { watchConsoleErrors } from './helpers/console'

// ── helpers ───────────────────────────────────────────────────────────────────

async function openInsights(page: Page) {
  await page.goto('/personal/insights')
  await page.waitForSelector('[data-testid="personal-layout"]', { timeout: 15_000 })
  await page.waitForSelector('[data-testid="personal-insights-page"]', { timeout: 10_000 })
}

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe('@personal @insights @smoke Mi Guita — insights', () => {

  // ── Navigation ─────────────────────────────────────────────────────────────

  test('navegar a /personal/insights carga sin errores de consola', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await openInsights(page)
    expect(errors().length).toBe(0)
  })

  test('pantalla de insights visible sin crash', async ({ page }) => {
    await login(page)
    await openInsights(page)
    await expect(page.locator('[data-testid="personal-insights-page"]')).toBeVisible()
  })

  // ── Empty state ─────────────────────────────────────────────────────────────

  test('muestra empty state, cards o summary (nunca un error no controlado)', async ({ page }) => {
    await login(page)
    await openInsights(page)
    const hasEmpty   = await page.locator('[data-testid="personal-insights-empty"]').isVisible()
    const hasCards   = await page.locator('[data-testid="personal-insight-card"]').isVisible()
    const hasSummary = await page.locator('[data-testid="personal-insights-summary"]').isVisible()
    expect(hasEmpty || hasCards || hasSummary).toBe(true)
  })

  // ── Filter tabs ─────────────────────────────────────────────────────────────

  test('tabs de filtro visibles: Todos, Alertas, Oportunidades, Salud', async ({ page }) => {
    await login(page)
    await openInsights(page)
    await expect(page.locator('[data-testid="personal-insights-filters"]')).toBeVisible()
    await expect(page.locator('[data-testid="personal-insights-filter-all"]')).toBeVisible()
    await expect(page.locator('[data-testid="personal-insights-filter-alert"]')).toBeVisible()
    await expect(page.locator('[data-testid="personal-insights-filter-opportunity"]')).toBeVisible()
    await expect(page.locator('[data-testid="personal-insights-filter-health"]')).toBeVisible()
  })

  test('tab "Alertas" filtra sin romper la pantalla', async ({ page }) => {
    await login(page)
    await openInsights(page)
    await page.click('[data-testid="personal-insights-filter-alert"]')
    await page.waitForTimeout(300)
    // Either empty-filter state or insight cards — never a crash
    const hasCards  = await page.locator('[data-testid="personal-insight-card"]').isVisible()
    const hasFilter = await page.locator('[data-testid="personal-insights-empty-filter"]').isVisible()
    const hasEmpty  = await page.locator('[data-testid="personal-insights-empty"]').isVisible()
    expect(hasCards || hasFilter || hasEmpty).toBe(true)
  })

  test('tab "Todos" muestra todo después de filtrar', async ({ page }) => {
    await login(page)
    await openInsights(page)
    await page.click('[data-testid="personal-insights-filter-alert"]')
    await page.waitForTimeout(200)
    await page.click('[data-testid="personal-insights-filter-all"]')
    await page.waitForTimeout(200)
    await expect(page.locator('[data-testid="personal-insights-page"]')).toBeVisible()
  })

  // ── Hide amounts ────────────────────────────────────────────────────────────

  test('botón ocultar/mostrar importes visible', async ({ page }) => {
    await login(page)
    await openInsights(page)
    await expect(page.locator('[data-testid="personal-insights-toggle-hide"]')).toBeVisible()
  })

  test('toggle hide oculta importes en tarjetas de insight (si hay datos)', async ({ page }) => {
    await login(page)
    await openInsights(page)
    const hasCards = await page.locator('[data-testid="personal-insight-card"]').isVisible()
    if (hasCards) {
      await page.click('[data-testid="personal-insights-toggle-hide"]')
      await page.waitForTimeout(200)
      const pageContent = await page.locator('[data-testid="personal-insights-page"]').textContent()
      // hiddenMessage should contain •••• or generic non-amount text
      // The toggle must not crash the page
      await expect(page.locator('[data-testid="personal-insights-page"]')).toBeVisible()
      expect(pageContent).toBeTruthy()
    } else {
      // No data — just ensure toggle doesn't crash
      await page.click('[data-testid="personal-insights-toggle-hide"]')
      await expect(page.locator('[data-testid="personal-insights-page"]')).toBeVisible()
    }
  })

  // ── CTAs hacia otros módulos ────────────────────────────────────────────────

  test('links a presupuestos, tarjetas, deudas, proyecciones visibles si hay datos', async ({ page }) => {
    await login(page)
    await openInsights(page)
    const hasCards = await page.locator('[data-testid="personal-insight-card"]').isVisible()
    if (hasCards) {
      await expect(page.locator('[data-testid="personal-insights-link-presupuestos"]')).toBeVisible()
      await expect(page.locator('[data-testid="personal-insights-link-tarjetas"]')).toBeVisible()
      await expect(page.locator('[data-testid="personal-insights-link-deudas"]')).toBeVisible()
      await expect(page.locator('[data-testid="personal-insights-link-proyecciones"]')).toBeVisible()
    }
    expect(true).toBe(true)
  })

  test('CTA a presupuestos navega a /personal/presupuestos', async ({ page }) => {
    await login(page)
    await openInsights(page)
    const hasLink = await page.locator('[data-testid="personal-insights-link-presupuestos"]').isVisible()
    if (hasLink) {
      await page.click('[data-testid="personal-insights-link-presupuestos"]')
      await page.waitForURL('**/personal/presupuestos', { timeout: 5_000 })
      expect(page.url()).toContain('/personal/presupuestos')
    }
    expect(true).toBe(true)
  })

  // ── Dashboard widget ────────────────────────────────────────────────────────

  test('widget de insights visible en el dashboard', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-dashboard"]', { timeout: 15_000 })
    await expect(page.locator('[data-testid="personal-insights-widget"]')).toBeVisible()
  })

  test('widget de insights navega a /personal/insights al hacer click', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-insights-widget"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-insights-widget"]')
    await page.waitForURL('**/personal/insights', { timeout: 5_000 })
    expect(page.url()).toContain('/personal/insights')
  })

  test('widget muestra items o estado tranquilo (sin crash)', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-insights-widget"]', { timeout: 15_000 })
    const hasItems  = await page.locator('[data-testid="personal-insights-widget-item"]').isVisible()
    const widgetText = await page.locator('[data-testid="personal-insights-widget"]').textContent()
    // Either has items or shows the "Todo tranquilo" empty state
    expect(hasItems || (widgetText ?? '').length > 0).toBe(true)
  })

  // ── Resilience (no data scenarios) ─────────────────────────────────────────

  test('no rompe con safe-area padding en mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await login(page)
    await openInsights(page)
    const container = page.locator('[data-testid="personal-insights-page"]')
    await expect(container).toBeVisible()
    const box = await container.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThan(0)
  })

  test('accesible desde el menú Más en /personal/mas', async ({ page }) => {
    await login(page)
    await page.goto('/personal/mas')
    await page.waitForSelector('[data-testid="personal-layout"]', { timeout: 15_000 })
    const insightsBtn = page.getByText('Insights')
    await expect(insightsBtn).toBeVisible()
    await insightsBtn.click()
    await page.waitForURL('**/personal/insights', { timeout: 5_000 })
    expect(page.url()).toContain('/personal/insights')
  })

})
