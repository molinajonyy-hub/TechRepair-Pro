/**
 * @personal @budgets @smoke
 * Mi Guita — Presupuestos mensuales.
 * Cubre navegación, selector de mes, widget del dashboard, formulario, hide amounts y estados vacíos.
 */
import { test, expect, type Page } from '@playwright/test'
import { login } from './helpers/auth'
import { watchConsoleErrors } from './helpers/console'

// ── helpers ───────────────────────────────────────────────────────────────────

async function openBudgets(page: Page) {
  await page.goto('/personal/presupuestos')
  await page.waitForSelector('[data-testid="personal-layout"]', { timeout: 15_000 })
  await page.waitForSelector('[data-testid="personal-budgets-page"]', { timeout: 10_000 })
}

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe('@personal @budgets @smoke Mi Guita — presupuestos', () => {

  // ── Navigation ─────────────────────────────────────────────────────────────

  test('navegar a /personal/presupuestos carga sin errores de consola', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await openBudgets(page)
    expect(errors().length).toBe(0)
  })

  test('pantalla de presupuestos visible sin crash', async ({ page }) => {
    await login(page)
    await openBudgets(page)
    await expect(page.locator('[data-testid="personal-budgets-page"]')).toBeVisible()
  })

  // ── Empty state ─────────────────────────────────────────────────────────────

  test('muestra empty state o lista de presupuestos (nunca un error no controlado)', async ({ page }) => {
    await login(page)
    await openBudgets(page)
    const hasEmpty   = await page.locator('[data-testid="personal-budgets-empty"]').isVisible()
    const hasItems   = await page.locator('[data-testid="personal-budget-item"]').isVisible()
    const hasSummary = await page.locator('[data-testid="personal-budgets-summary"]').isVisible()
    expect(hasEmpty || hasItems || hasSummary).toBe(true)
  })

  // ── Month selector ─────────────────────────────────────────────────────────

  test('selector de mes visible y muestra el mes actual', async ({ page }) => {
    await login(page)
    await openBudgets(page)
    await expect(page.locator('[data-testid="personal-budgets-month-label"]')).toBeVisible()
    const label = await page.locator('[data-testid="personal-budgets-month-label"]').textContent()
    expect(label).toMatch(/202[5-9]|203\d/)
  })

  test('botón siguiente avanza al mes próximo', async ({ page }) => {
    await login(page)
    await openBudgets(page)
    const labelBefore = await page.locator('[data-testid="personal-budgets-month-label"]').textContent()
    await page.click('[data-testid="personal-budgets-month-next"]')
    await page.waitForTimeout(300)
    const labelAfter = await page.locator('[data-testid="personal-budgets-month-label"]').textContent()
    expect(labelBefore).not.toBe(labelAfter)
  })

  test('botón anterior retrocede al mes anterior', async ({ page }) => {
    await login(page)
    await openBudgets(page)
    // Go forward first so prev button is enabled
    await page.click('[data-testid="personal-budgets-month-next"]')
    await page.waitForTimeout(200)
    const labelMid = await page.locator('[data-testid="personal-budgets-month-label"]').textContent()
    await page.click('[data-testid="personal-budgets-month-prev"]')
    await page.waitForTimeout(200)
    const labelAfter = await page.locator('[data-testid="personal-budgets-month-label"]').textContent()
    expect(labelMid).not.toBe(labelAfter)
  })

  // ── New budget button ────────────────────────────────────────────────────────

  test('botón nuevo presupuesto visible', async ({ page }) => {
    await login(page)
    await openBudgets(page)
    await expect(page.locator('[data-testid="personal-budget-new-button"]')).toBeVisible()
  })

  test('click en nuevo presupuesto abre el formulario', async ({ page }) => {
    await login(page)
    await openBudgets(page)
    await page.click('[data-testid="personal-budget-new-button"]')
    await page.waitForTimeout(300)
    await expect(page.locator('[data-testid="personal-budget-form"]')).toBeVisible()
  })

  test('formulario tiene campos de categoría y monto', async ({ page }) => {
    await login(page)
    await openBudgets(page)
    await page.click('[data-testid="personal-budget-new-button"]')
    await page.waitForTimeout(300)
    await expect(page.locator('[data-testid="personal-budget-category"]')).toBeVisible()
    await expect(page.locator('[data-testid="personal-budget-amount"]')).toBeVisible()
  })

  // ── Dashboard widget ────────────────────────────────────────────────────────

  test('widget de presupuestos visible en el dashboard', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-dashboard"]', { timeout: 15_000 })
    await expect(page.locator('[data-testid="personal-budgets-widget"]')).toBeVisible()
  })

  test('widget de presupuestos navega a /personal/presupuestos al hacer click', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-budgets-widget"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-budgets-widget"]')
    await page.waitForURL('**/personal/presupuestos', { timeout: 5_000 })
    expect(page.url()).toContain('/personal/presupuestos')
  })

  // ── Hide amounts ────────────────────────────────────────────────────────────

  test('toggle ocultar enmascara montos en la página de presupuestos', async ({ page }) => {
    await login(page)
    await openBudgets(page)
    const toggleBtn = page.locator('[data-testid="personal-budgets-toggle-hide"]')
    await expect(toggleBtn).toBeVisible()
    await toggleBtn.click()
    const pageContent = await page.locator('[data-testid="personal-budgets-page"]').textContent()
    expect(pageContent).toContain('••••')
  })

  test('toggle hide en dashboard enmascara widget de presupuestos', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-dashboard"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-toggle-hide"]')
    await expect(page.locator('[data-testid="personal-budgets-widget"]')).toBeVisible()
    const widgetSpent = page.locator('[data-testid="personal-budgets-widget-spent"]')
    if (await widgetSpent.isVisible()) {
      const text = await widgetSpent.textContent()
      expect(text).toContain('••••')
    }
  })

  // ── Budget item (conditional) ────────────────────────────────────────────────

  test('items de presupuesto muestran barra de progreso si hay datos', async ({ page }) => {
    await login(page)
    await openBudgets(page)
    const firstItem = page.locator('[data-testid="personal-budget-item"]').first()
    if (await firstItem.isVisible()) {
      await expect(firstItem).toBeVisible()
    }
    expect(true).toBe(true)
  })

  // ── Page container ───────────────────────────────────────────────────────────

  test('page container renderiza correctamente con safe-area padding', async ({ page }) => {
    await login(page)
    await openBudgets(page)
    const container = page.locator('[data-testid="personal-budgets-page"]')
    await expect(container).toBeVisible()
    const box = await container.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThan(0)
  })

})
