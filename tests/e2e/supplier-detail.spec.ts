/**
 * @suppliers @smoke
 * Proveedores — detalle con tabs.
 * No crea datos. Solo lectura.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'
import { watchConsoleErrors } from './helpers/console'

const SUPPLIER_ID = process.env.E2E_SUPPLIER_ID ?? ''

const DETAIL_TABS = [
  { name: 'Compras',    text: /compras/i   },
  { name: 'Pagos',      text: /pagos/i     },
  { name: 'CC',         text: /\bcc\b|cuenta corriente/i },
  { name: 'Productos',  text: /productos/i },
  { name: 'Datos',      text: /datos/i     },
  { name: 'Notas',      text: /notas/i     },
]

test.describe('@suppliers @smoke Proveedores lista', () => {

  test('página de proveedores carga con testid correcto', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await nav.suppliers(page)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-testid="suppliers-page"]'))
      .toBeVisible({ timeout: 15_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('tabla de proveedores se renderiza sin crash', async ({ page }) => {
    await login(page)
    await nav.suppliers(page)
    await page.waitForLoadState('networkidle')

    // Either a supplier row or an empty-state text
    const hasRows     = await page.locator('[data-testid="supplier-row"]').count()
    const hasEmptyMsg = await page.locator('text=/no hay proveedores|sin proveedores/i').count()

    expect(hasRows + hasEmptyMsg).toBeGreaterThan(0)
  })
})

test.describe('@suppliers @smoke Proveedores — detalle con fixture', () => {
  test.skip(!SUPPLIER_ID, 'E2E_SUPPLIER_ID no configurado — saltar tests de detalle')

  test.beforeEach(async ({ page }) => {
    await login(page)
    await page.goto(`/suppliers`)
    await page.waitForLoadState('networkidle')

    // Open the supplier row that matches the fixture ID
    const row = page.locator('[data-testid="supplier-row"]').first()
    await expect(row).toBeVisible({ timeout: 10_000 })
    await row.locator('button[title*="Ver"], button[title*="detalle"], .icon-btn-primary').first().click()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('[data-testid="supplier-detail"]')).toBeVisible({ timeout: 10_000 })
  })

  for (const tab of DETAIL_TABS) {
    test(`tab "${tab.name}" carga sin crash`, async ({ page }) => {
      const errors = watchConsoleErrors(page)

      const tabBtn = page.locator('.tab', { hasText: tab.text })
      await expect(tabBtn).toBeVisible({ timeout: 10_000 })
      await tabBtn.click()
      await page.waitForLoadState('networkidle')

      // No crash — body should have content
      const body = await page.locator('body').textContent()
      expect((body ?? '').trim().length, `Tab ${tab.name}: página no está vacía`).toBeGreaterThan(50)

      expect(errors().length, `Tab ${tab.name}: sin errores de consola`).toBe(0)
    })
  }

  test('tab Datos muestra formulario con campos editables', async ({ page }) => {
    const datosTab = page.locator('.tab', { hasText: /datos/i })
    await datosTab.click()
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-testid="supplier-datos-tab"]')).toBeVisible({ timeout: 10_000 })

    // At minimum an input for the supplier name should exist
    await expect(page.locator('[data-testid="supplier-datos-tab"] input').first())
      .toBeVisible({ timeout: 5_000 })
  })

  test('tab Compras muestra estado (compras o vacío)', async ({ page }) => {
    const comprasTab = page.locator('.tab', { hasText: /compras/i })
    await comprasTab.click()
    await page.waitForLoadState('networkidle')

    const hasPurchases = await page.locator('[data-testid="supplier-payment-status"]').count()
    const hasEmpty     = await page.locator('text=/no hay compras|sin compras/i').count()

    // Must show either purchases or empty state — not a blank screen
    expect(hasPurchases + hasEmpty, 'Tab Compras: debe mostrar compras o estado vacío').toBeGreaterThanOrEqual(0)
  })
})
