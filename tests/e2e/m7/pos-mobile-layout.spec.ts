// ============================================================================
// POS PRE-BETA — Gate de layout móvil del POS + contrato de sales_points.
//
//   npx playwright test --project=m7-local --grep @pos-mobile
//
// Matriz:  desktop 1440 · móvil 390x844   ×   light · dark
//
// QUÉ VIGILA, Y POR QUÉ NO ALCANZABA LO QUE YA HABÍA
// --------------------------------------------------
// El gate visual de búsqueda (search-pos-visual.spec.ts) ya medía "sin scroll
// horizontal global" a 390px y pasaba en verde. El defecto real que reportó el
// owner NO producía scroll horizontal: el header traía `height: 64` inline, en
// móvil se le habilitaba `flex-wrap: wrap`, sus tres grupos necesitaban 167px
// en tres filas y `.cpm-shell { overflow: hidden }` recortaba los 104px
// sobrantes. Se perdían el punto de venta, el tipo de cambio y toda la fila de
// acciones —incluido el botón de cerrar—, sin desbordar un solo pixel a lo
// ancho. Por eso acá se mide RECORTE VERTICAL, no sólo desborde horizontal.
//
// SCROLL INTENCIONAL vs DESBORDE ACCIDENTAL
// -----------------------------------------
// La franja "Recientes" es un carrusel horizontal legítimo: su contenido SÍ
// excede su propio ancho y eso es correcto. La distinción que hace este gate:
//   · el CONTENEDOR debe entrar en el viewport y declarar overflow-x auto/scroll;
//   · el DOCUMENTO no puede crecer por su culpa.
// Un elemento fuera del viewport sólo se perdona si tiene un ancestro con
// scroll horizontal propio. Ver `desbordesReales()`.
// ============================================================================
import { test, expect, type Page } from '@playwright/test'
import { ejecutarSQL } from '../setup/sqlLocal.ts'
import { sqlDeFixtureBusqueda, SEARCH_FIXTURE } from '../setup/seedSearchFixture.ts'
import { sqlDeFixturePosMobile, POS_MOBILE_FIXTURE } from '../setup/seedPosMobileFixture.ts'

const VIEWPORTS = [
  { nombre: 'desktop-1440', width: 1440, height: 900, movil: false },
  { nombre: 'mobile-390',   width: 390,  height: 844, movil: true  },
]

const TEMAS = ['light', 'dark'] as const

const EVIDENCIA = 'tests/e2e/evidencia/pos-mobile'

/** Tolerancia en px para redondeos de layout sub-pixel. */
const TOL = 1

const PADRE = 'Funda Silicone iPhone 15'

/** Hosts del stack bajo prueba: la app y Supabase, ambos locales por diseño. */
const HOSTS_PROPIOS = new Set(['localhost', '127.0.0.1', '[::1]'])

function esDeNuestroStack(url: string): boolean {
  try {
    return HOSTS_PROPIOS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

test.beforeAll(() => {
  ejecutarSQL(sqlDeFixtureBusqueda())
  ejecutarSQL(sqlDeFixturePosMobile())
})

async function abrirPos(page: Page, tema: 'light' | 'dark') {
  await page.addInitScript((t) => {
    window.localStorage.setItem('techrepair_theme', t)
    window.localStorage.setItem('theme', t)
  }, tema)
  await page.goto('/comprobantes')
  const nuevo = page.locator('[data-testid="comprobantes-new-button"]')
  await expect(nuevo).toBeVisible({ timeout: 30_000 })
  await nuevo.click()
  await expect(page.locator('[data-testid="comprobante-product-search"]'))
    .toBeVisible({ timeout: 15_000 })
}

/**
 * Elementos del POS que se salen del viewport SIN estar dentro de un scroller
 * horizontal propio. Un carrusel puede tener contenido afuera; el documento no.
 */
async function desbordesReales(page: Page, viewportWidth: number) {
  return page.evaluate((vw) => {
    const malos: { tag: string; cls: string; texto: string; x: number; derecha: number }[] = []
    document.querySelectorAll('.cpm-root *').forEach(n => {
      const el = n as HTMLElement
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return
      if (r.x >= -1 && r.x + r.width <= vw + 1) return

      // ¿Algún ancestro scrollea en horizontal? Entonces es intencional.
      let p: HTMLElement | null = el.parentElement
      while (p && !p.classList?.contains('cpm-root')) {
        const ox = getComputedStyle(p).overflowX
        if (ox === 'auto' || ox === 'scroll') return
        p = p.parentElement
      }
      malos.push({
        tag: el.tagName,
        cls: String(el.className).slice(0, 60),
        texto: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 40),
        x: Math.round(r.x),
        derecha: Math.round(r.x + r.width),
      })
    })
    return malos
  }, viewportWidth)
}

test.describe('@pos-mobile POS — layout responsive y punto de venta', () => {

  for (const vp of VIEWPORTS) {
    for (const tema of TEMAS) {
      test(`${vp.nombre} · ${tema}`, async ({ page }) => {
        const fallos: string[] = []
        page.on('response', r => {
          if (r.status() < 400) return
          if (/favicon/i.test(r.url())) return
          // Sólo cuentan los fallos de NUESTRO stack (app + Supabase, ambos
          // locales). Un 404 de fonts.gstatic.com es el flake conocido de
          // fuentes y no dice nada del POS; filtrarlo por origen en vez de por
          // nombre evita, además, silenciar un 400 propio por accidente.
          if (!esDeNuestroStack(r.url())) return
          fallos.push(`${r.status()} ${r.url()}`)
        })
        page.on('pageerror', e => fallos.push(`pageerror: ${String(e)}`))

        await page.setViewportSize({ width: vp.width, height: vp.height })
        await abrirPos(page, tema)

        // MOBILE-1: el POS es fullscreen y debe tomar control explícito del
        // safe-area inferior; la navegación del shell queda oculta mientras
        // el modal está abierto para no competir con total/checkout.
        if (vp.movil) {
          await expect(page.getByTestId('mobile-bottom-nav')).toBeHidden()
          expect(await page.evaluate(() => document.body.classList.contains('mobile-pos-fullscreen'))).toBe(true)
        }

        expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme')),
          'el tema debe estar aplicado en <html>').toBe(tema)

        // ── E · PUNTO DE VENTA: fiscal vs local ──────────────────────────────
        // El tipo por defecto es fiscal (factura_c), así que el POS debe mostrar
        // el PV de ARCA (0003) en modo lectura — nunca el local (0007), que es
        // lo que se persistía y se imprimía como identidad fiscal.
        const pvFiscal = page.locator('[data-testid="comprobante-pv-fiscal"]')
        await expect(pvFiscal, 'un comprobante fiscal muestra el PV de ARCA')
          .toBeVisible({ timeout: 10_000 })
        await expect(pvFiscal).toContainText(POS_MOBILE_FIXTURE.puntoVentaFiscalFormateado)
        await expect(pvFiscal,
          'el PV local no puede presentarse como fiscal')
          .not.toContainText(POS_MOBILE_FIXTURE.puntoVentaFormateado)
        await expect(page.locator('[data-testid="comprobante-pv-local"]'),
          'en un fiscal el PV local no debe ser editable').toHaveCount(0)

        // Al pasar a Remito (no fiscal) el PV local vuelve, y es el que
        // salesPointService leyó con las columnas correctas: 0007, no el
        // señuelo 0003 más antiguo ni el default 0001.
        await page.getByRole('button', { name: 'Remito' }).click()
        const pvLocal = page.locator('[data-testid="comprobante-pv-local"]')
        await expect(pvLocal, 'un remito usa el PV local').toBeVisible()
        await expect(pvLocal).toHaveValue(POS_MOBILE_FIXTURE.puntoVentaFormateado)
        await expect(page.locator('[data-testid="comprobante-pv-fiscal"]')).toHaveCount(0)

        // Se vuelve al tipo fiscal para el resto del gate.
        await page.getByRole('button', { name: 'Factura C' }).click()
        await expect(pvFiscal).toBeVisible()

        // ── HEADER · nada recortado (el defecto del owner) ───────────────────
        const header = page.locator('.cpm-header')
        const hdr = await header.evaluate(el => ({
          clientH: el.clientHeight,
          scrollH: el.scrollHeight,
          hijos: Array.from(el.children).map(c => {
            const r = c.getBoundingClientRect()
            const hr = el.getBoundingClientRect()
            return {
              texto: (c as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 30),
              fueraAbajo: r.y + r.height > hr.y + hr.height + 1,
              derecha: r.x + r.width,
              izquierda: r.x,
            }
          }),
        }))

        expect(hdr.scrollH - hdr.clientH,
          `el header recorta ${hdr.scrollH - hdr.clientH}px de sus propios controles`)
          .toBeLessThanOrEqual(TOL)

        const recortados = hdr.hijos.filter(h => h.fueraAbajo).map(h => h.texto)
        expect(recortados,
          `grupos del header por debajo del corte: ${recortados.join(' | ')}`).toEqual([])

        for (const h of hdr.hijos) {
          expect(h.izquierda, `grupo "${h.texto}" arranca fuera del viewport`)
            .toBeGreaterThanOrEqual(-TOL)
          expect(h.derecha, `grupo "${h.texto}" se sale del viewport (${vp.width}px)`)
            .toBeLessThanOrEqual(vp.width + TOL)
        }

        // El botón de cerrar es el que se perdía: debe verse y ser clickeable.
        const cerrar = page.locator('[data-testid="comprobante-cancel-button"]')
        await expect(cerrar, 'el botón de cerrar debe estar visible').toBeVisible()
        const cajaCerrar = await cerrar.boundingBox()
        expect(cajaCerrar, 'el botón de cerrar no tiene caja').not.toBeNull()
        if (cajaCerrar) {
          expect(cajaCerrar.x + cajaCerrar.width,
            'el botón de cerrar se sale del viewport').toBeLessThanOrEqual(vp.width + TOL)
          expect(cajaCerrar.y + cajaCerrar.height,
            'el botón de cerrar queda fuera de la pantalla').toBeLessThanOrEqual(vp.height + TOL)
        }

        // ── I · Recientes: scroll propio, sin ensanchar el documento ─────────
        const recientes = page.locator('.cpm-left').getByText('Recientes', { exact: true })
        await expect(recientes, 'la franja Recientes debe renderizarse').toBeVisible()
        const franja = await page.evaluate(() => {
          // textContent, no innerText: el rótulo lleva text-transform uppercase
          // y innerText devolvería "RECIENTES" (el texto RENDERIZADO).
          const label = Array.from(document.querySelectorAll('.cpm-left span'))
            .find(s => s.textContent?.trim() === 'Recientes') as HTMLElement | undefined
          const strip = label?.parentElement?.querySelector('div') as HTMLElement | null
          if (!strip) return null
          const r = strip.getBoundingClientRect()
          return {
            x: r.x, derecha: r.x + r.width,
            clientW: strip.clientWidth, scrollW: strip.scrollWidth,
            overflowX: getComputedStyle(strip).overflowX,
            chips: strip.children.length,
          }
        })
        expect(franja, 'no se encontró la franja Recientes').not.toBeNull()
        if (franja) {
          expect(franja.chips, 'Recientes debe tener chips').toBeGreaterThan(0)
          expect(franja.overflowX,
            'Recientes debe scrollear sola, no empujar el layout').toMatch(/auto|scroll/)
          expect(franja.x, 'la franja arranca fuera del viewport').toBeGreaterThanOrEqual(-TOL)
          expect(franja.derecha,
            'la franja se sale del viewport').toBeLessThanOrEqual(vp.width + TOL)
          expect(franja.clientW,
            'el contenedor de Recientes no puede ser más ancho que el viewport')
            .toBeLessThanOrEqual(vp.width + TOL)
        }

        // ── F/G · la búsqueda sigue funcionando y el hijo entra al carrito ───
        const input = page.locator('[data-testid="comprobante-product-search"]')
        await input.fill(PADRE)
        const resultados = page.locator('[data-testid="comprobante-product-results"]')
        await expect(resultados).toBeVisible({ timeout: 15_000 })

        const opciones = page.locator('[data-testid="comprobante-product-option"]')
        expect(await opciones.count(), 'deben ofrecerse las 3 variantes')
          .toBeGreaterThanOrEqual(3)
        const ids = await opciones.evaluateAll(ns =>
          ns.map(n => (n as HTMLElement).dataset.productId ?? ''))
        expect(ids, 'el padre agrupador no puede ser seleccionable')
          .not.toContain(SEARCH_FIXTURE.padreFunda)

        await opciones.first().click()
        await expect(page.locator('[data-testid="comprobante-item-row-0"]'),
          'el hijo seleccionado debe entrar al carrito').toBeVisible({ timeout: 10_000 })

        // La fila del carrito no puede recortarse ni desbordar.
        const fila = await page.locator('[data-testid="comprobante-item-row-0"]').evaluate(el => {
          const r = el.getBoundingClientRect()
          return { x: r.x, derecha: r.x + r.width, recorte: el.scrollHeight - el.clientHeight }
        })
        expect(fila.recorte, 'la fila del carrito recorta contenido').toBeLessThanOrEqual(TOL)
        expect(fila.derecha, 'la fila del carrito se sale del viewport')
          .toBeLessThanOrEqual(vp.width + TOL)

        // ── H · footer de cobro accesible ────────────────────────────────────
        // En móvil es la barra compacta; en desktop, el panel derecho.
        if (vp.movil) {
          const barra = page.locator('.cpm-compact-bar')
          await expect(barra, 'la barra de cobro debe estar visible').toBeVisible()
          const cb = await barra.boundingBox()
          expect(cb, 'la barra de cobro no tiene caja').not.toBeNull()
          if (cb) {
            expect(cb.x, 'la barra de cobro arranca fuera del viewport')
              .toBeGreaterThanOrEqual(-TOL)
            expect(cb.x + cb.width, 'la barra de cobro se sale del viewport')
              .toBeLessThanOrEqual(vp.width + TOL)
            expect(cb.y + cb.height, 'la barra de cobro queda fuera de la pantalla')
              .toBeLessThanOrEqual(vp.height + TOL)
          }
          await expect(barra.getByText(/total/i).first(),
            'la barra debe mostrar el total').toBeVisible()
        } else {
          await expect(page.locator('.cpm-right'),
            'en desktop el panel de cobro es columna visible').toBeVisible()
        }

        // ── Geometría global ─────────────────────────────────────────────────
        const desborde = await page.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth)
        expect(desborde, 'la página no puede tener scroll horizontal')
          .toBeLessThanOrEqual(TOL)

        const malos = await desbordesReales(page, vp.width)
        expect(malos,
          `elementos fuera del viewport sin scroller propio: ${JSON.stringify(malos)}`)
          .toEqual([])

        await page.screenshot({ path: `${EVIDENCIA}/pos-${vp.nombre}-${tema}.png` })

        // ── Red y consola limpias ────────────────────────────────────────────
        // Sin allowlist: el 400 de sales_points que se toleraba se arregló en
        // este mismo lote. Si vuelve, este gate lo caza.
        expect(fallos, `requests fallidos o errores de página: ${fallos.join(' | ')}`)
          .toEqual([])
      })
    }
  }
})
