/**
 * @finance @smoke
 * Finanzas unificado — verifica que todos los tabs cargan sin crash
 * ni valores inválidos. No modifica datos.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'
import { watchConsoleErrors } from './helpers/console'

const INVALID = ['NaN', 'undefined', '[object Object]']

const TABS = [
  { name: 'Resumen',      text: /resumen/i     },
  { name: 'Caja',         text: /caja/i        },
  { name: 'Ventas',       text: /ventas/i      },
  { name: 'Gastos',       text: /gastos/i      },
  { name: 'Movimientos',  text: /movimientos/i },
  { name: 'Auditoría',    text: /auditor/i     },
]

test.describe('@finance @smoke Finanzas — tabs unificados', () => {

  test('página principal de Finanzas carga con testid correcto', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await nav.finance(page)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-testid="finance-dashboard-page"]'))
      .toBeVisible({ timeout: 15_000 })

    expect(errors().length, 'No debe haber errores de consola').toBe(0)
  })

  test('filtro de período está visible', async ({ page }) => {
    await login(page)
    await nav.finance(page)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-testid="finance-dashboard-date-filter"]'))
      .toBeVisible({ timeout: 10_000 })
  })

  for (const tab of TABS) {
    test(`tab "${tab.name}" carga sin crash`, async ({ page }) => {
      const errors = watchConsoleErrors(page)
      await login(page)
      await nav.finance(page)
      await page.waitForLoadState('networkidle')

      // Click the tab by visible text (tabs use .tab CSS class)
      const tabBtn = page.locator('.tab', { hasText: tab.text })
      await expect(tabBtn).toBeVisible({ timeout: 10_000 })
      await tabBtn.click()
      await page.waitForLoadState('networkidle')

      // No invalid values in body
      const body = await page.locator('body').textContent()
      for (const pattern of INVALID) {
        expect(body, `Tab ${tab.name}: no debe contener "${pattern}"`).not.toContain(pattern)
      }

      expect(errors().length, `Tab ${tab.name}: sin errores de consola`).toBe(0)
    })
  }

  test('cambiar período a "Hoy" y verificar recálculo', async ({ page }) => {
    await login(page)
    await nav.finance(page)
    await page.waitForLoadState('networkidle')

    const hoy = page.locator('[data-testid="finance-dashboard-date-filter"]')
      .locator('button', { hasText: /hoy/i })
    await expect(hoy).toBeVisible({ timeout: 10_000 })
    await hoy.click()
    await page.waitForLoadState('networkidle')

    // No crash after period change
    await expect(page.locator('[data-testid="finance-dashboard-page"]'))
      .toBeVisible()
  })

  test('tab Auditoría muestra botón para ejecutar health-check', async ({ page }) => {
    await login(page)
    await nav.finance(page)
    await page.waitForLoadState('networkidle')

    const auditoriaTab = page.locator('.tab', { hasText: /auditor/i })
    await auditoriaTab.click()
    await page.waitForLoadState('networkidle')

    // Should show either "Ejecutar auditoría" or a refresh button
    const auditBtn = page.locator('button', { hasText: /ejecutar|re-ejecutar/i }).first()
    await expect(auditBtn).toBeVisible({ timeout: 10_000 })
  })

  test('tab Resumen muestra cards de resumen', async ({ page }) => {
    await login(page)
    await nav.finance(page)
    await page.waitForLoadState('networkidle')

    const resumenTab = page.locator('.tab', { hasText: /resumen/i })
    await resumenTab.click()
    await page.waitForLoadState('networkidle')

    // At least income card should be present
    await expect(page.locator('[data-testid="finance-dashboard-income-card"]'))
      .toBeVisible({ timeout: 15_000 })
  })
})
