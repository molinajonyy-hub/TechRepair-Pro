/**
 * @cc
 * Cuenta corriente health check — protege que la página carga, la búsqueda
 * funciona y los balances se muestran sin valores inválidos.
 *
 * No crea cuentas ni movimientos. Solo lectura.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'

const INVALID_PATTERNS = ['NaN', 'undefined', '[object Object]']

test.describe('@cc Cuenta corriente health', () => {
  test('página de cuentas corrientes carga sin valores inválidos', async ({ page }) => {
    await login(page)
    await page.goto('/cuentas')
    await page.waitForLoadState('networkidle')

    await expect(page.locator('h1, .page-hdr-title, .page-title').filter({ hasText: /cuenta/i }))
      .toBeVisible({ timeout: 10_000 })

    const bodyText = await page.locator('body').textContent()
    for (const pattern of INVALID_PATTERNS) {
      expect(bodyText, `No debe contener "${pattern}" en Cuentas Corrientes`).not.toContain(pattern)
    }
  })

  test('campo de búsqueda de CC es visible y funciona', async ({ page }) => {
    await login(page)
    await page.goto('/cuentas')

    const searchInput = page.locator('[data-testid="cc-search-input"]')
    await expect(searchInput).toBeVisible({ timeout: 10_000 })

    // La búsqueda no debe romper la página
    await searchInput.fill('E2E')
    await page.waitForTimeout(400) // debounce

    // La página no debe mostrar errores ni valores inválidos
    const bodyText = await page.locator('body').textContent()
    expect(bodyText).not.toContain('[object Object]')
    expect(bodyText).not.toContain('undefined')

    // Limpiar búsqueda
    await searchInput.fill('')
  })

  test('si hay cuentas: los balances muestran valores numéricos válidos', async ({ page }) => {
    await login(page)
    await page.goto('/cuentas')
    await page.waitForLoadState('networkidle')

    const accountRows = page.locator('[data-testid="cc-account-row"]')
    const count = await accountRows.count()

    if (count === 0) {
      // Sin cuentas es un estado válido — no falla el test
      return
    }

    // Si hay cuentas, verificar que los balances son válidos
    const balanceCells = page.locator('[data-testid="cc-balance-value"]')
    const balanceCount = await balanceCells.count()
    for (let i = 0; i < Math.min(balanceCount, 5); i++) {
      const text = await balanceCells.nth(i).textContent()
      expect(text, `Balance en fila ${i} no debe ser inválido`).not.toBe('undefined')
      expect(text).not.toBe('NaN')
      expect(text).not.toBe('[object Object]')
    }
  })
})
