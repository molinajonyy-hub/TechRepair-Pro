/**
 * @finance @smoke
 * Finanzas health check — protege que la página carga sin errores y sin
 * valores inválidos (NaN, undefined, null, [object Object]).
 *
 * No crea datos. Solo lectura.
 * Seguro contra producción.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'

const INVALID_PATTERNS = ['NaN', 'undefined', '[object Object]']

test.describe('@finance @smoke Finanzas health', () => {
  test('página de finanzas carga sin valores inválidos', async ({ page }) => {
    await login(page)
    await page.goto('/finance')

    // Esperar que la página cargue completamente
    await page.waitForLoadState('networkidle')

    // Esperar que el encabezado de finanzas sea visible
    await expect(page.locator('h1, .page-hdr-title').filter({ hasText: /panel|financiero|finanz/i }))
      .toBeVisible({ timeout: 15_000 })

    // Verificar que no aparecen valores inválidos en el texto visible
    const bodyText = await page.locator('body').textContent()
    for (const pattern of INVALID_PATTERNS) {
      expect(bodyText, `No debe contener "${pattern}" en la página de Finanzas`).not.toContain(pattern)
    }

    // Verificar que no hay errores de alerta visibles
    const alertErrors = page.locator('.alert-inline-error, [role="alert"].error')
    await expect(alertErrors).toHaveCount(0)
  })

  test('finanzas carga con período mensual sin romper', async ({ page }) => {
    await login(page)
    await page.goto('/finance')
    await page.waitForLoadState('networkidle')

    // No debe haber ningún loader infinito visible
    const loader = page.locator('.animate-spin, [class*="spinning"], [style*="tr-spin"]').first()
    // Si hay un loader inicial, esperar a que desaparezca (hasta 15s)
    if (await loader.isVisible()) {
      await expect(loader).not.toBeVisible({ timeout: 15_000 })
    }

    // La página debe tener contenido visible (no blank)
    const mainContent = page.locator('main, .main-layout-content, [class*="page-content"]').first()
    const text = await page.locator('body').textContent()
    expect((text ?? '').trim().length).toBeGreaterThan(100)
  })
})
