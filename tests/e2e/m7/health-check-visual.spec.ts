// ============================================================================
// M7 7D.2 — Evidencia visual del Health Check v2.
//
// No son snapshots con umbral de píxeles (serían frágiles y ruidosos con datos
// vivos). Son capturas + aserciones de contraste: lo que se quiere probar es que
// la página se ve BIEN en los cuatro contextos, no que no cambió nunca.
//
// El tema de este proyecto tiene una trampa conocida: los tokens se serializan a
// rgb() y hay islas dark dentro de light. Verificar "hay dark mode" mirando una
// clase no prueba nada — hay que leer el color computado.
// ============================================================================
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const RUTA = '/finance/health'
const DIR = 'docs/auditoria-finanzas/m7/evidencia-7d2'

const CONTEXTOS = [
  { nombre: 'desktop-light', ancho: 1280, alto: 900, tema: 'light' },
  { nombre: 'desktop-dark', ancho: 1280, alto: 900, tema: 'dark' },
  { nombre: 'mobile-light', ancho: 375, alto: 812, tema: 'light' },
  { nombre: 'mobile-dark', ancho: 375, alto: 812, tema: 'dark' },
] as const

async function aplicarTema(page: Page, tema: string) {
  // ThemeContext lee 'techrepair_theme' y sólo cae a la clave legacy 'theme' si
  // la canónica no está. El storageState del login ya trae la canónica seteada,
  // así que escribir sólo la legacy no tendría ningún efecto: hay que pisar la
  // que realmente gana.
  await page.addInitScript(t => {
    localStorage.setItem('techrepair_theme', t)
    localStorage.setItem('theme', t)
  }, tema)
}

function luminancia(rgb: string): number {
  const m = rgb.match(/\d+/g)
  if (!m) return -1
  const [r, g, b] = m.map(Number)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

for (const ctx of CONTEXTOS) {
  test(`@m7 @visual Health Check v2 — ${ctx.nombre}`, async ({ page }) => {
    await aplicarTema(page, ctx.tema)
    await page.setViewportSize({ width: ctx.ancho, height: ctx.alto })
    await page.goto(RUTA)
    await page.getByTestId('finance-health-run').click()
    await expect(page.getByTestId('finance-health-summary')).toBeVisible({ timeout: 20_000 })

    // El tema realmente se aplicó (no basta con setear localStorage).
    await expect(page.locator('html')).toHaveAttribute('data-theme', ctx.tema)

    // El fondo corresponde al tema. Un dark que quedó claro (o una isla dark
    // colada en light) se caza acá, no revisando capturas a ojo.
    const fondo = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const l = luminancia(fondo)
    expect(l, `fondo ${fondo} en tema ${ctx.tema}`).toBeGreaterThanOrEqual(0)
    if (ctx.tema === 'dark') expect(l, `fondo ${fondo} debería ser oscuro`).toBeLessThan(90)
    else expect(l, `fondo ${fondo} debería ser claro`).toBeGreaterThan(160)

    // Nada se desborda horizontalmente (el caso típico en 375px).
    const desborde = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(desborde, 'la página no debe scrollear en horizontal').toBeLessThanOrEqual(1)

    await page.screenshot({ path: `${DIR}/health-check-${ctx.nombre}.png`, fullPage: true })
  })
}
