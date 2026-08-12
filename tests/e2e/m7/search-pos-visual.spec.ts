// ============================================================================
// P0 SEARCH — GATE VISUAL del buscador del POS (§32).
//
//   npx playwright test --project=m7-local --grep @visual-search
//
// Matriz obligatoria:  desktop 1440 · móvil 390x844   ×   light · dark
//
// Un test que sólo cuente resultados no alcanza: el arreglo del P0 hace que la
// caja muestre variantes que antes no aparecían, y una variante que se ve pero
// no se distingue de sus hermanas es un error de cobro esperando ocurrir. Acá
// se verifica que cada resultado sea IDENTIFICABLE y ACCIONABLE:
//   · las 3 variantes montadas, ninguna duplicada;
//   · cada una diferenciada (el nombre no se repite entre opciones);
//   · SKU, precio y stock visibles y sin basura (NaN/undefined);
//   · ninguna opción recortada ni fuera del viewport;
//   · sin scroll horizontal global;
//   · el padre agrupador NO figura como opción seleccionable.
//
// Las capturas quedan en tests/e2e/evidencia/search-p0/.
// ============================================================================
import { test, expect, type Page } from '@playwright/test'
import { ejecutarSQL } from '../setup/sqlLocal.ts'
import { sqlDeFixtureBusqueda, SEARCH_FIXTURE } from '../setup/seedSearchFixture.ts'

const VIEWPORTS = [
  { nombre: 'desktop-1440', width: 1440, height: 900 },
  { nombre: 'mobile-390',   width: 390,  height: 844 },
]

const TEMAS = ['light', 'dark'] as const

/** Texto que jamás puede llegar a la pantalla. */
const BASURA = ['NaN', 'undefined', '[object Object]', 'Infinity']

/**
 * Requests que YA fallaban antes de este lote y son ajenos a la búsqueda.
 *
 * Se miden por URL sobre el evento `response` y no por el texto de consola: el
 * mensaje que Chrome imprime ("Failed to load resource… 400") no dice QUÉ
 * falló, así que filtrarlo por texto silenciaría también un 400 nuevo de la
 * búsqueda. Se listan uno por uno, nunca un patrón genérico.
 *
 * `sales_points`: el POS pide `punto_venta` e `is_active`, columnas que la
 * tabla no tiene (son `numero` y `activo`). Ese lookup viene fallando con 400
 * desde antes de este lote y no se toca acá: queda reportado como hallazgo
 * aparte.
 */
const FALLOS_PREEXISTENTES = [/\/rest\/v1\/sales_points/i, /favicon/i]

const PADRE = 'Funda Silicone iPhone 15'

const EVIDENCIA = 'tests/e2e/evidencia/search-p0'

test.beforeAll(() => {
  ejecutarSQL(sqlDeFixtureBusqueda())
})

async function abrirPosYBuscar(page: Page, tema: 'light' | 'dark', texto: string) {
  await page.addInitScript((t) => {
    window.localStorage.setItem('techrepair_theme', t)
    window.localStorage.setItem('theme', t)
  }, tema)

  await page.goto('/comprobantes')
  const nuevo = page.locator('[data-testid="comprobantes-new-button"]')
  await expect(nuevo).toBeVisible({ timeout: 30_000 })
  await nuevo.click()

  const input = page.locator('[data-testid="comprobante-product-search"]')
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.fill(texto)

  await expect(page.locator('[data-testid="comprobante-product-results"]'))
    .toBeVisible({ timeout: 15_000 })
}

test.describe('@visual-search P0 — buscador de productos del POS', () => {

  for (const vp of VIEWPORTS) {
    for (const tema of TEMAS) {
      test(`${vp.nombre} · ${tema}`, async ({ page }) => {
        const fallos: string[] = []
        page.on('response', r => {
          if (r.status() < 400) return
          if (FALLOS_PREEXISTENTES.some(p => p.test(r.url()))) return
          fallos.push(`${r.status()} ${r.url()}`)
        })
        page.on('pageerror', (e) => fallos.push(`pageerror: ${String(e)}`))

        await page.setViewportSize({ width: vp.width, height: vp.height })
        await abrirPosYBuscar(page, tema, PADRE)

        // ── El tema realmente se aplicó ──
        expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme')),
          'el tema debe estar aplicado en <html>').toBe(tema)

        const opciones = page.locator('[data-testid="comprobante-product-option"]')
        const total = await opciones.count()
        expect(total, 'la caja debe ofrecer al menos las 3 variantes').toBeGreaterThanOrEqual(3)

        // ── Identidad: sin duplicados y sin el padre agrupador ──
        const ids = await opciones.evaluateAll(ns =>
          ns.map(n => (n as HTMLElement).dataset.productId ?? ''))
        expect(new Set(ids).size, 'no puede haber resultados duplicados').toBe(ids.length)
        expect(ids, 'el padre agrupador no puede ser seleccionable')
          .not.toContain(SEARCH_FIXTURE.padreFunda)

        // ── Las 3 variantes están ──
        for (const v of [SEARCH_FIXTURE.varNegro, SEARCH_FIXTURE.varAzul, SEARCH_FIXTURE.varRosa]) {
          expect(ids, `falta la variante ${v}`).toContain(v)
        }

        // ── Cada opción es distinguible y accionable ──
        const titulos = new Set<string>()
        for (let i = 0; i < total; i++) {
          const op = opciones.nth(i)
          await expect(op, `opción ${i} no visible`).toBeVisible()

          const texto = (await op.innerText()).trim()
          expect(texto.length, `opción ${i} sin texto`).toBeGreaterThan(0)

          for (const b of BASURA) {
            expect(texto, `opción ${i} muestra "${b}"`).not.toContain(b)
          }

          // El primer renglón identifica el producto: no puede repetirse entre
          // opciones, o el cajero no sabe cuál de las variantes está eligiendo.
          const titulo = texto.split('\n')[0].trim()
          expect(titulos.has(titulo), `dos opciones muestran el mismo título "${titulo}"`).toBe(false)
          titulos.add(titulo)

          // Precio y stock presentes.
          expect(texto, `opción ${i} sin importe`).toMatch(/\$\s?-?\d/)
          expect(texto, `opción ${i} sin stock`).toMatch(/stock/i)

          // Nada recortado fuera del viewport.
          const caja = await op.boundingBox()
          expect(caja, `opción ${i} sin caja`).not.toBeNull()
          if (caja) {
            expect(caja.width, `opción ${i} sin ancho`).toBeGreaterThan(0)
            expect(caja.x, `opción ${i} arranca fuera del viewport`).toBeGreaterThanOrEqual(-1)
            expect(caja.x + caja.width,
              `opción ${i} se sale del viewport (${vp.width}px)`).toBeLessThanOrEqual(vp.width + 1)
          }
        }

        // ── El SKU se muestra: es lo que desambigua dos variantes parecidas ──
        const textoLista = await page.locator('[data-testid="comprobante-product-results"]').innerText()
        expect(textoLista, 'la lista debe mostrar el SKU de las variantes')
          .toContain('SRCH-FUN-IP15-VAR-01')

        // ── Sin scroll horizontal global ──
        const desborde = await page.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth)
        expect(desborde, 'la página no puede tener scroll horizontal').toBeLessThanOrEqual(1)

        await page.screenshot({
          path: `${EVIDENCIA}/pos-${vp.nombre}-${tema}.png`,
          fullPage: false,
        })

        expect(fallos, `requests fallidos o errores de página: ${fallos.join(' | ')}`).toEqual([])
      })
    }
  }

  test('el estado de error del buscador se distingue de "sin resultados"', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })

    await page.goto('/comprobantes')
    const nuevo = page.locator('[data-testid="comprobantes-new-button"]')
    await expect(nuevo).toBeVisible({ timeout: 30_000 })
    await nuevo.click()

    // Se rompe SÓLO la búsqueda de inventario, después de abrir el modal.
    await page.route('**/rest/v1/inventory*', route => {
      if (route.request().method() === 'GET') return route.abort('failed')
      return route.fallback()
    })

    const input = page.locator('[data-testid="comprobante-product-search"]')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill(PADRE)

    // Un fallo de red tiene que verse como fallo, no como catálogo vacío: si el
    // cajero lee "sin resultados" carga el producto a mano y lo duplica.
    const error = page.locator('[data-testid="comprobante-product-search-error"]')
    await expect(error, 'debe mostrarse el estado de error del buscador')
      .toBeVisible({ timeout: 15_000 })
    await expect(error).toContainText(/no se pudo buscar/i)

    await expect(page.locator('[data-testid="comprobante-product-results"]'))
      .toHaveCount(0)

    await page.screenshot({ path: `${EVIDENCIA}/pos-error-desktop-1440.png` })
  })
})
