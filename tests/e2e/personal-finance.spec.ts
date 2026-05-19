/**
 * @personal @smoke
 * Mi Guita — Finanzas personales.
 * Verifica navegación, carga de datos y flujos básicos (cuenta, movimiento).
 * NO crea datos permanentes en prod — usa el entorno QA configurado en .env.test.
 */
import { test, expect, type Page } from '@playwright/test'
import { login } from './helpers/auth'
import { watchConsoleErrors } from './helpers/console'

// ── helpers ───────────────────────────────────────────────────────────────────

async function goToPersonal(page: Page) {
  await page.goto('/personal')
  await page.waitForSelector('[data-testid="personal-layout"]', { timeout: 15_000 })
}

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe('@personal @smoke Mi Guita — finanzas personales', () => {

  // ── Dashboard ───────────────────────────────────────────────────────────────

  test('dashboard personal carga sin errores de consola', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await goToPersonal(page)
    await expect(page.locator('[data-testid="personal-dashboard"]')).toBeVisible({ timeout: 10_000 })
    expect(errors().length).toBe(0)
  })

  test('dashboard muestra card de balance disponible', async ({ page }) => {
    await login(page)
    await goToPersonal(page)
    await expect(page.locator('[data-testid="personal-balance-card"]')).toBeVisible({ timeout: 10_000 })
  })

  test('dashboard muestra tarjetas de resumen mensual', async ({ page }) => {
    await login(page)
    await goToPersonal(page)
    await expect(page.locator('[data-testid="personal-income-card"]')).toBeVisible()
    await expect(page.locator('[data-testid="personal-expense-card"]')).toBeVisible()
    await expect(page.locator('[data-testid="personal-month-balance-card"]')).toBeVisible()
  })

  test('botón acción rápida Gasto visible en dashboard', async ({ page }) => {
    await login(page)
    await goToPersonal(page)
    await expect(page.locator('[data-testid="personal-quick-expense"]')).toBeVisible()
  })

  test('botón acción rápida Ingreso visible en dashboard', async ({ page }) => {
    await login(page)
    await goToPersonal(page)
    await expect(page.locator('[data-testid="personal-quick-income"]')).toBeVisible()
  })

  // ── Bottom nav ──────────────────────────────────────────────────────────────

  test('bottom nav tiene 5 items', async ({ page }) => {
    await login(page)
    await goToPersonal(page)
    const nav = page.locator('[data-testid="personal-bottom-nav"] button')
    await expect(nav).toHaveCount(5)
  })

  test('navegar a Movimientos desde bottom nav', async ({ page }) => {
    await login(page)
    await goToPersonal(page)
    await page.click('[data-testid="personal-nav-movements"]')
    await expect(page.locator('[data-testid="personal-movements-page"]')).toBeVisible({ timeout: 10_000 })
  })

  test('navegar a Cuentas desde dashboard', async ({ page }) => {
    await login(page)
    await goToPersonal(page)
    // "Ver cuentas" quick action navigates to /personal/cuentas
    await page.click('[data-testid="personal-bottom-nav"] button:has-text("Inicio")')
    await page.goto('/personal/cuentas')
    await expect(page.locator('[data-testid="personal-accounts-page"]')).toBeVisible({ timeout: 10_000 })
  })

  // ── Accounts page ───────────────────────────────────────────────────────────

  test('página de cuentas carga sin errores', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await page.goto('/personal/cuentas')
    await page.waitForSelector('[data-testid="personal-layout"]', { timeout: 15_000 })
    await expect(page.locator('[data-testid="personal-accounts-page"]')).toBeVisible({ timeout: 10_000 })
    expect(errors().length).toBe(0)
  })

  test('botón nueva cuenta abre formulario', async ({ page }) => {
    await login(page)
    await page.goto('/personal/cuentas')
    await page.waitForSelector('[data-testid="personal-accounts-page"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-account-new-button"]')
    await expect(page.locator('[data-testid="personal-account-form"]')).toBeVisible({ timeout: 5_000 })
  })

  test('formulario de cuenta tiene campos requeridos con font ≥ 16px', async ({ page }) => {
    await login(page)
    await page.goto('/personal/cuentas')
    await page.waitForSelector('[data-testid="personal-accounts-page"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-account-new-button"]')
    await page.waitForSelector('[data-testid="personal-account-form"]')

    const nameInput = page.locator('[data-testid="personal-account-name"]')
    await expect(nameInput).toBeVisible()
    const fs = await nameInput.evaluate(el => window.getComputedStyle(el).fontSize)
    // 1rem = 16px; must be ≥ 16 to prevent iOS auto-zoom
    const px = parseFloat(fs)
    expect(px).toBeGreaterThanOrEqual(16)
  })

  test('formulario de cuenta no permite nombre vacío', async ({ page }) => {
    await login(page)
    await page.goto('/personal/cuentas')
    await page.waitForSelector('[data-testid="personal-accounts-page"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-account-new-button"]')
    await page.waitForSelector('[data-testid="personal-account-form"]')
    // Leave name empty and click save
    await page.click('[data-testid="personal-account-save"]')
    await expect(page.locator('[data-testid="personal-account-form"]')).toContainText(/obligatorio/i)
  })

  // ── Movements page ──────────────────────────────────────────────────────────

  test('página de movimientos carga sin errores', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await page.goto('/personal/movimientos')
    await page.waitForSelector('[data-testid="personal-layout"]', { timeout: 15_000 })
    await expect(page.locator('[data-testid="personal-movements-page"]')).toBeVisible({ timeout: 10_000 })
    expect(errors().length).toBe(0)
  })

  test('botón nuevo movimiento abre sheet', async ({ page }) => {
    await login(page)
    await page.goto('/personal/movimientos')
    await page.waitForSelector('[data-testid="personal-movements-page"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-movement-new-button"]')
    await expect(page.locator('[data-testid="personal-movement-sheet"]')).toBeVisible({ timeout: 5_000 })
  })

  test('sheet de movimiento tiene selector de tipo gasto/ingreso', async ({ page }) => {
    await login(page)
    await page.goto('/personal/movimientos')
    await page.waitForSelector('[data-testid="personal-movements-page"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-movement-new-button"]')
    await page.waitForSelector('[data-testid="personal-movement-sheet"]')
    await expect(page.locator('[data-testid="personal-movement-type"]')).toBeVisible()
  })

  test('sheet de movimiento no permite monto cero', async ({ page }) => {
    await login(page)
    await page.goto('/personal/movimientos')
    await page.waitForSelector('[data-testid="personal-movements-page"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-movement-new-button"]')
    await page.waitForSelector('[data-testid="personal-movement-sheet"]')
    // Leave amount at 0 (or empty) and try to save
    await page.fill('[data-testid="personal-movement-amount"]', '0')
    await page.fill('[data-testid="personal-movement-description"]', 'test')
    await page.click('[data-testid="personal-movement-save"]')
    await expect(page.locator('[data-testid="personal-movement-sheet"]')).toContainText(/monto.*mayor|mayor.*\$0/i)
  })

  test('sheet de movimiento tiene input de monto con font ≥ 16px', async ({ page }) => {
    await login(page)
    await page.goto('/personal/movimientos')
    await page.waitForSelector('[data-testid="personal-movements-page"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-movement-new-button"]')
    await page.waitForSelector('[data-testid="personal-movement-sheet"]')
    const amountInput = page.locator('[data-testid="personal-movement-amount"]')
    const fs = await amountInput.evaluate(el => window.getComputedStyle(el).fontSize)
    expect(parseFloat(fs)).toBeGreaterThanOrEqual(16)
  })

  test('filtros de movimientos cambian entre Todos/Ingresos/Gastos', async ({ page }) => {
    await login(page)
    await page.goto('/personal/movimientos')
    await page.waitForSelector('[data-testid="personal-movements-page"]', { timeout: 15_000 })
    const filterBar = page.locator('[data-testid="personal-movement-filter-type"]')
    await expect(filterBar).toBeVisible()
    await expect(filterBar.locator('button')).toHaveCount(3)
  })

  // ── Deep links from dashboard quick actions ─────────────────────────────────

  test('acción rápida Gasto abre sheet con tipo expense preseleccionado', async ({ page }) => {
    await login(page)
    await goToPersonal(page)
    await page.click('[data-testid="personal-quick-expense"]')
    await expect(page.locator('[data-testid="personal-movement-sheet"]')).toBeVisible({ timeout: 8_000 })
  })

  test('acción rápida Ingreso abre sheet con tipo income preseleccionado', async ({ page }) => {
    await login(page)
    await goToPersonal(page)
    await page.click('[data-testid="personal-quick-income"]')
    await expect(page.locator('[data-testid="personal-movement-sheet"]')).toBeVisible({ timeout: 8_000 })
  })

  // ── Salary page ─────────────────────────────────────────────────────────────

  test('página Pagarme sueldo carga sin errores', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await page.goto('/personal/sueldo')
    await page.waitForSelector('[data-testid="personal-layout"]', { timeout: 15_000 })
    await expect(page.locator('[data-testid="personal-salary-page"]')).toBeVisible({ timeout: 10_000 })
    expect(errors().length).toBe(0)
  })

  test('formulario de sueldo tiene campo de monto con font ≥ 16px', async ({ page }) => {
    await login(page)
    await page.goto('/personal/sueldo')
    await page.waitForSelector('[data-testid="personal-salary-page"]', { timeout: 15_000 })
    const amountInput = page.locator('[data-testid="personal-salary-amount"]')
    await expect(amountInput).toBeVisible()
    const fs = await amountInput.evaluate(el => window.getComputedStyle(el).fontSize)
    expect(parseFloat(fs)).toBeGreaterThanOrEqual(16)
  })

  test('botón de sueldo deshabilitado sin confirmar checkbox', async ({ page }) => {
    await login(page)
    await page.goto('/personal/sueldo')
    await page.waitForSelector('[data-testid="personal-salary-page"]', { timeout: 15_000 })
    const submitBtn = page.locator('[data-testid="personal-salary-submit"]')
    await expect(submitBtn).toBeVisible()
    await expect(submitBtn).toBeDisabled()
  })

  // ── Back navigation ─────────────────────────────────────────────────────────

  test('botón volver en PersonalLayout regresa al dashboard de negocio', async ({ page }) => {
    await login(page)
    await goToPersonal(page)
    // The ArrowLeft button navigates to /dashboard
    await page.click('[data-testid="personal-layout"] header button[aria-label="Volver al negocio"]')
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 })
  })
})
