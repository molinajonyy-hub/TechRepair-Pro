// ============================================================================
// M7 7D.2 — Health Check v2 con navegador real, sesión real y Supabase local.
//
// Cierra la validación visual que quedó pendiente en 7D: hasta acá el parser
// estaba probado por unitarios, pero nadie había visto la página renderizar
// contra una RPC v2 de verdad.
// ============================================================================
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const RUTA = '/finance/health'

async function correrCheck(page: Page) {
  await page.goto(RUTA)
  await expect(page.getByTestId('finance-health-page')).toBeVisible()
  await page.getByTestId('finance-health-run').click()
  await expect(page.getByTestId('finance-health-summary')).toBeVisible({ timeout: 20_000 })
}

test.describe('@m7 Health Check v2', () => {
  test('la página corre la RPC v2 y pinta el resumen', async ({ page }) => {
    await correrCheck(page)

    // El contrato v2 se declara en el DOM: si la RPC cayera a v1, esto lo caza.
    await expect(page.getByTestId('finance-health-page')).toHaveAttribute('data-health-version', 'v2')

    // Hubo checks reales, no una tabla vacía.
    const filas = page.getByTestId('finance-health-check-row')
    expect(await filas.count()).toBeGreaterThan(0)

    // El estado global es uno del vocabulario v2, no un string crudo sin mapear.
    await expect(page.getByTestId('finance-health-overall'))
      .toHaveAttribute('data-overall', /^(pass|warn|fail)$/)
  })

  test('los checks se agrupan por categoría con etiquetas legibles', async ({ page }) => {
    await correrCheck(page)
    const cats = page.getByTestId('finance-health-category')
    expect(await cats.count()).toBeGreaterThan(0)

    // Ninguna categoría muestra su slug crudo: el mapa de etiquetas debe cubrir
    // todo lo que la RPC devuelva. Ver "period_locks" en pantalla en vez de
    // "Bloqueos de período" significa que la RPC agregó una categoría que el
    // frontend no conoce — exactamente lo que este check tiene que cazar.
    // Se compara la etiqueta contra el slug que la RPC mandó: si son iguales, el
    // mapa no cubre esa categoría. Buscar sólo guiones bajos no alcanzaba —
    // "security" se veía crudo en pantalla y pasaba igual.
    for (const sec of await page.getByTestId('finance-health-category').all()) {
      const slug = await sec.getAttribute('data-category')
      const label = (await sec.getByTestId('finance-health-category-label').innerText()).trim()
      expect(label.length).toBeGreaterThan(0)
      expect(label, `la categoría "${slug}" no tiene etiqueta en CATEGORY_ORDER`).not.toBe(slug)
    }
  })

  test('no hay checks pintados con un resultado sin reconocer', async ({ page }) => {
    await correrCheck(page)
    // El parser es fail-closed: un `result` desconocido cae en warn, nunca en
    // verde. Si apareciera un badge fuera del vocabulario v2, el mapeo se rompió.
    const badges = page.locator('[data-testid^="result-badge-"]')
    expect(await badges.count()).toBeGreaterThan(0)
    for (const b of await badges.all()) {
      expect(await b.getAttribute('data-testid')).toMatch(/^result-badge-(pass|warn|fail|info)$/)
    }
  })

  test('el reporte se puede copiar', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await correrCheck(page)
    await page.getByTestId('finance-health-copy').click()
    const texto = await page.evaluate(() => navigator.clipboard.readText())
    expect(texto.length).toBeGreaterThan(50)
  })
})

// ─── Estados visuales controlados ───────────────────────────────────────────
// Se interceptan las respuestas de la RPC para forzar estados que en un entorno
// sano no ocurren. Es intervención de RED, no de datos: no se toca la lógica
// financiera ni se escribe nada.
test.describe('@m7 Health Check v2 · estados controlados', () => {
  test('error de la RPC: se muestra alerta, no una página en blanco', async ({ page }) => {
    await page.route('**/rest/v1/rpc/finance_health_check_v2', r =>
      r.fulfill({ status: 500, body: JSON.stringify({ message: 'boom' }) }))
    await page.goto(RUTA)
    await page.getByTestId('finance-health-run').click()
    await expect(page.getByTestId('finance-health-error')).toBeVisible()
  })

  test('RPC v2 inexistente: cae a v1 y AVISA que el dato es legacy', async ({ page }) => {
    // PostgREST responde así cuando la función no existe (migración pendiente).
    // El contrato es caer a v1, pero jamás en silencio: sin el banner, el usuario
    // leería datos del modelo viejo creyendo que son los de M7.
    await page.route('**/rest/v1/rpc/finance_health_check_v2', r =>
      r.fulfill({
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function' }),
      }))
    await page.goto(RUTA)
    await page.getByTestId('finance-health-run').click()
    await expect(page.getByTestId('legacy-warning')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('finance-health-page'))
      .toHaveAttribute('data-health-version', 'legacy_v1')
  })

  test('un error que NO es "v2 inexistente" se propaga: no hay fallback silencioso', async ({ page }) => {
    // Un 403 de permisos no debe disfrazarse de "deploy pendiente" y caer a v1.
    await page.route('**/rest/v1/rpc/finance_health_check_v2', r =>
      r.fulfill({
        status: 403,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '42501', message: 'permission denied' }),
      }))
    await page.goto(RUTA)
    await page.getByTestId('finance-health-run').click()
    await expect(page.getByTestId('finance-health-error')).toBeVisible()
    await expect(page.getByTestId('legacy-warning')).toHaveCount(0)
  })

  test('antes de ejecutar: estado vacío explícito, sin métricas en cero', async ({ page }) => {
    await page.goto(RUTA)
    // Nada corrió todavía: mostrar un resumen en 0 se leería como "todo bien".
    await expect(page.getByTestId('finance-health-empty')).toBeVisible()
    await expect(page.getByTestId('finance-health-summary')).toHaveCount(0)
  })
})
