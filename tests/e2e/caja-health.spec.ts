/**
 * @cash
 * Caja health check — protege que la página carga, muestra estado correcto
 * y permite abrir la caja si está cerrada.
 *
 * @local-only
 * No correr contra producción real (toca estado de caja del día).
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'

test.describe('@cash Caja health', () => {
  test('página de caja carga y muestra estado claro', async ({ page }) => {
    await login(page)
    await page.goto('/caja')
    await page.waitForLoadState('networkidle')

    // El título y estado deben ser visibles
    await expect(page.locator('h1, .page-hdr-title').filter({ hasText: /caja/i }))
      .toBeVisible({ timeout: 10_000 })

    const status = page.locator('[data-testid="caja-status"]')
    await expect(status).toBeVisible({ timeout: 10_000 })

    const statusText = await status.textContent()
    expect(statusText).toBeTruthy()
    // El estado debe ser uno de los valores conocidos (no "undefined" ni vacío)
    expect(statusText).not.toBe('undefined')
    expect(statusText?.trim().length).toBeGreaterThan(0)
  })

  test('si caja cerrada: muestra botón Abrir Caja', async ({ page }) => {
    await login(page)
    await page.goto('/caja')
    await page.waitForLoadState('networkidle')

    const status = page.locator('[data-testid="caja-status"]')
    await expect(status).toBeVisible({ timeout: 10_000 })
    const isOpen = (await status.textContent() ?? '').includes('Abierta')

    if (!isOpen) {
      // Verificar que el botón de abrir es visible y funcional
      const openBtn = page.locator('[data-testid="caja-open-button"]')
      await expect(openBtn).toBeVisible({ timeout: 5_000 })
      await expect(openBtn).toBeEnabled()
    } else {
      // Si está abierta: el botón de movimiento debe estar visible
      await expect(page.locator('[data-testid="caja-add-movement-button"]')).toBeVisible({ timeout: 5_000 })
    }
  })

  test('caja no muestra valores inválidos en la página', async ({ page }) => {
    await login(page)
    await page.goto('/caja')
    await page.waitForLoadState('networkidle')

    const bodyText = await page.locator('body').textContent()
    expect(bodyText).not.toContain('[object Object]')
    expect(bodyText).not.toContain('undefined')
    expect(bodyText).not.toContain('NaN')
  })
})
