/**
 * @smoke
 * Login + navegación básica por las secciones principales.
 * Verifica que cada página carga sin error visible.
 */
import { test, expect } from '@playwright/test'
import { login, waitForAppReady } from './helpers/auth'
import { nav } from './helpers/navigation'
import { watchConsoleErrors } from './helpers/console'

test.describe('@smoke Auth + Navegación básica', () => {
  test('login con credenciales QA redirige al dashboard', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await waitForAppReady(page)
    await expect(page).not.toHaveURL(/\/login/)
    expect(errors().length).toBe(0)
  })

  test('navegar a Clientes carga sin error', async ({ page }) => {
    await login(page)
    await nav.customers(page)
    await expect(page.locator('h1, .page-hdr-title')).toContainText(/cliente/i, { timeout: 10_000 })
  })

  test('navegar a Inventario carga sin error', async ({ page }) => {
    await login(page)
    await nav.inventory(page)
    await expect(page.locator('h1, .page-hdr-title')).toContainText(/inventario/i, { timeout: 10_000 })
  })

  test('navegar a Comprobantes carga sin error', async ({ page }) => {
    await login(page)
    await nav.comprobantes(page)
    await expect(page.locator('h1, .page-hdr-title')).toContainText(/comprobante/i, { timeout: 10_000 })
  })

  test('navegar a Gastos carga sin error', async ({ page }) => {
    await login(page)
    await nav.expenses(page)
    await expect(page.locator('h1, .page-hdr-title')).toContainText(/gasto/i, { timeout: 10_000 })
  })

  test('navegar a Caja carga sin error', async ({ page }) => {
    await login(page)
    await nav.caja(page)
    await expect(page.locator('h1, .page-hdr-title')).toContainText(/caja/i, { timeout: 10_000 })
  })

  test('ruta protegida sin sesión redirige a login', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login|\/onboarding/, { timeout: 10_000 })
  })
})
