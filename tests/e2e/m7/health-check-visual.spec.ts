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
//
// ┌── M7 7D.3 · POR QUE LA ESCRITURA ESTA GATEADA ───────────────────────────┐
// │ Estas capturas se escriben en docs/, que está TRACKEADO. Escribirlas en  │
// │ cada corrida ensuciaba el árbol con PNGs de bytes distintos y contenido  │
// │ equivalente: `git status` dejaba de ser señal y un cambio visual real se │
// │ perdía entre el ruido.                                                   │
// │                                                                          │
// │ Ahora la corrida normal es READ-ONLY respecto del repo: valida y adjunta │
// │ la captura al reporte de Playwright. Para regrabar la evidencia hay que  │
// │ pedirlo explícitamente con el mecanismo propio de Playwright:            │
// │                                                                          │
// │     npm run e2e:m7:evidencia     (= playwright test --update-snapshots)  │
// │                                                                          │
// │ NO se usa toHaveScreenshot acá a propósito: el resto de la suite escribe │
// │ comprobantes y pagos, así que el contenido de esta página cambia entre   │
// │ corridas por diseño. Una comparación por píxeles sería flaky y se        │
// │ terminaría desactivando — que es peor que no tenerla. La regresión       │
// │ visual real la cazan las aserciones de tema/contraste/desborde de abajo, │
// │ que sí son deterministas.                                                │
// └──────────────────────────────────────────────────────────────────────────┘
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

    // Escritura gateada por el flag ESTANDAR de Playwright. Por defecto
    // `updateSnapshots` es 'missing'; con --update-snapshots pasa a 'all' o
    // 'changed'. Sin homegrown flags: el mismo interruptor que ya conoce
    // cualquiera que use Playwright.
    const captura = await page.screenshot({ fullPage: true })
    const regrabar = test.info().config.updateSnapshots !== 'missing'

    if (regrabar) {
      await test.info().attach(`evidencia-${ctx.nombre}`, { body: captura, contentType: 'image/png' })
      // eslint-disable-next-line no-console
      console.log(`[evidencia] regrabando ${DIR}/health-check-${ctx.nombre}.png`)
      const { writeFile } = await import('fs/promises')
      await writeFile(`${DIR}/health-check-${ctx.nombre}.png`, captura)
    } else {
      // Corrida normal: la evidencia vive en el reporte, no en el repo.
      await test.info().attach(`health-check-${ctx.nombre}`, { body: captura, contentType: 'image/png' })
    }
  })
}
