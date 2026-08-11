// ============================================================================
// P1-A — GATE VISUAL de Finanzas → Caja (§10 y §16).
//
//   npx playwright test --project=m7-local --grep @visual-caja
//
// Corre autenticado como owner (storageState del globalSetup) contra el stack
// LOCAL. Matriz obligatoria:
//
//   desktop 1440 · móvil 390x844      ×      light · dark
//
// Lo que verifica —y que un test de "no hay scroll horizontal" NO alcanza a
// probar—:
//   · las 4 tarjetas de medios de pago y las 3 de totales están MONTADAS;
//   · ninguna queda fuera del viewport ni recortada;
//   · ninguna quedó oculta para "resolver" el móvil;
//   · ningún importe se trunca de forma destructiva (ellipsis / clip);
//   · no hay scroll horizontal global;
//   · la tabla de movimientos sigue siendo ALCANZABLE (scroll propio), no
//     recortada en silencio por `overflow: hidden` del contenedor.
//
// El detector de contenido inalcanzable es el mismo criterio del gate de
// Charts L1: `body { overflow-x: hidden }` hace que un grid de columnas fijas
// NO genere scrollbar y aun así se coma lo que no entra. Buscar sólo overflow
// del body deja pasar exactamente el defecto P1-A.
//
// Las capturas quedan en tests/e2e/evidencia/prebeta-p1/.
// ============================================================================
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'

const VIEWPORTS = [
  { nombre: 'desktop-1440', width: 1440, height: 900 },
  { nombre: 'mobile-390',   width: 390,  height: 844 },
]

const TEMAS = ['light', 'dark'] as const

/** Texto que jamás puede llegar a la pantalla. */
const BASURA = ['NaN', 'undefined', '[object Object]', 'Infinity']

/** Importe en es-AR: $ 1.234.567 (la pestaña usa maximumFractionDigits: 0). */
const IMPORTE_AR = /\$\s?-?\d{1,3}(\.\d{3})*/

async function irACaja(page: Page, tema: 'light' | 'dark') {
  await page.addInitScript((t) => {
    window.localStorage.setItem('techrepair_theme', t)
    window.localStorage.setItem('theme', t)
  }, tema)
  await page.goto('/finance')
  await page.waitForSelector('[data-testid="finance-dashboard-page"]', { timeout: 30_000 })

  const tab = page.locator('.tab', { hasText: /caja/i })
  await expect(tab).toBeVisible({ timeout: 15_000 })
  await tab.click()

  // Las tarjetas sólo montan cuando llegó `data`.
  await page.waitForSelector('[data-testid="finance-caja-cash-methods"]', { timeout: 30_000 })
  await page.waitForSelector('[data-testid="finance-caja-totals"]', { timeout: 30_000 })
}

test.describe('@visual-caja P1-A — Finanzas → Caja', () => {

  for (const vp of VIEWPORTS) {
    for (const tema of TEMAS) {
      test(`${vp.nombre} · ${tema}`, async ({ page }) => {
        const erroresConsola: string[] = []
        page.on('console', (m: ConsoleMessage) => {
          if (m.type() === 'error') erroresConsola.push(m.text())
        })
        page.on('pageerror', (e) => erroresConsola.push(String(e)))

        await page.setViewportSize({ width: vp.width, height: vp.height })
        await irACaja(page, tema)

        // ── El tema realmente se aplicó ──
        expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme')),
          'el tema debe estar aplicado en <html>').toBe(tema)

        // ── Las 4 tarjetas de medios de pago están montadas y VISIBLES ──
        const metodos = page.locator('[data-testid="finance-caja-cash-methods"] > div')
        await expect(metodos, 'deben montar las 4 tarjetas de medios de pago').toHaveCount(4)
        for (let i = 0; i < 4; i++) {
          await expect(metodos.nth(i), `tarjeta de medio de pago ${i} no visible`).toBeVisible()
        }

        // ── Las 3 tarjetas de totales, idem ──
        const totales = page.locator('[data-testid="finance-caja-totals"] > div')
        await expect(totales, 'deben montar las 3 tarjetas de totales').toHaveCount(3)
        for (let i = 0; i < 3; i++) {
          await expect(totales.nth(i), `tarjeta de total ${i} no visible`).toBeVisible()
        }

        // ── La grilla ENVUELVE en móvil (verificación estructural) ──
        // Las comprobaciones geométricas de abajo sólo disparan cuando los
        // importes son grandes: con datos sembrados chicos, `repeat(4, 1fr)`
        // entra en 390px y el gate pasaría con el defecto puesto. Medido: eso
        // es exactamente lo que ocurría. La cantidad de columnas REALES no
        // depende de los datos, así que es lo que decide.
        const columnas = await page.evaluate(() => {
          const out: Record<string, number> = {}
          for (const sel of ['finance-caja-cash-methods', 'finance-caja-totals']) {
            const cont = document.querySelector(`[data-testid="${sel}"]`)
            if (!cont) { out[sel] = -1; continue }
            // Distintos `left` en la primera fila = columnas reales.
            const cajas = Array.from(cont.children).map(c => c.getBoundingClientRect())
            const primeraFila = Math.min(...cajas.map(r => Math.round(r.top)))
            out[sel] = new Set(cajas.filter(r => Math.round(r.top) === primeraFila)
                                    .map(r => Math.round(r.left))).size
          }
          return out
        })
        if (vp.width <= 430) {
          expect(columnas['finance-caja-cash-methods'],
            'en 390px los medios de pago deben envolver (máx. 2 columnas), no quedar en 4 fijas')
            .toBeLessThanOrEqual(2)
          expect(columnas['finance-caja-totals'],
            'en 390px los totales deben envolver (máx. 2 columnas)')
            .toBeLessThanOrEqual(2)
        } else {
          // Y en desktop no se degrada: las 4 siguen entrando en una fila.
          expect(columnas['finance-caja-cash-methods'],
            'en desktop los 4 medios de pago deben seguir en una sola fila').toBe(4)
        }

        // ── NINGUNA tarjeta monetaria queda fuera del viewport ──
        // Se mide caja por caja: es la prueba directa de que la plata se puede
        // leer, no una inferencia a partir del scroll del documento.
        const fuera = await page.evaluate(() => {
          const limite = document.documentElement.clientWidth + 1
          const out: string[] = []
          for (const sel of ['finance-caja-cash-methods', 'finance-caja-totals']) {
            const cont = document.querySelector(`[data-testid="${sel}"]`)
            if (!cont) { out.push(`falta ${sel}`); continue }
            for (const card of Array.from(cont.children)) {
              const r = card.getBoundingClientRect()
              if (r.right > limite || r.left < -1) {
                out.push(`${sel}: "${(card.textContent ?? '').trim().slice(0, 28)}" ` +
                         `(left=${Math.round(r.left)} right=${Math.round(r.right)} > ${Math.round(limite)})`)
              }
            }
          }
          return out
        })
        expect(fuera, `tarjetas fuera del viewport en ${vp.width}px: ${fuera.join(' · ')}`).toEqual([])

        // ── Ninguna tarjeta se "resolvió" ocultándola ──
        const ocultas = await page.evaluate(() => {
          const out: string[] = []
          for (const sel of ['finance-caja-cash-methods', 'finance-caja-totals']) {
            const cont = document.querySelector(`[data-testid="${sel}"]`)
            if (!cont) continue
            for (const card of Array.from(cont.children)) {
              const cs = getComputedStyle(card)
              const r = card.getBoundingClientRect()
              if (cs.display === 'none' || cs.visibility === 'hidden' ||
                  Number(cs.opacity) === 0 || r.width < 40 || r.height < 20) {
                out.push(`${sel}: "${(card.textContent ?? '').trim().slice(0, 28)}"`)
              }
            }
          }
          return out
        })
        expect(ocultas, `tarjetas ocultas o colapsadas: ${ocultas.join(' · ')}`).toEqual([])

        // ── Ningún importe truncado de forma DESTRUCTIVA ──
        // Envolver está bien (overflow-wrap). Recortar con ellipsis/clip, no:
        // "$1.234…" es un número distinto del que el negocio tiene.
        const truncados = await page.evaluate(() => {
          const out: string[] = []
          for (const sel of ['finance-caja-cash-methods', 'finance-caja-totals']) {
            const cont = document.querySelector(`[data-testid="${sel}"]`)
            if (!cont) continue
            for (const el of Array.from(cont.querySelectorAll('*'))) {
              const txt = (el.textContent ?? '').trim()
              if (!/\$/.test(txt)) continue
              if (el.children.length > 0) continue          // sólo hojas de texto
              const cs = getComputedStyle(el)
              if (cs.textOverflow === 'ellipsis' || cs.textOverflow === 'clip' && cs.overflow === 'hidden') {
                out.push(`ellipsis sobre "${txt.slice(0, 24)}"`)
              }
              // Recorte real: el contenido no entra en su propia caja.
              if (el.scrollWidth > el.clientWidth + 1 && cs.overflow !== 'visible') {
                out.push(`recortado "${txt.slice(0, 24)}" (${el.scrollWidth} > ${el.clientWidth})`)
              }
            }
          }
          return out
        })
        expect(truncados, `importes truncados: ${truncados.join(' · ')}`).toEqual([])

        // ── Los importes siguen mostrándose en es-AR y completos ──
        const textoMetodos = await page.locator('[data-testid="finance-caja-cash-methods"]').innerText()
        expect(textoMetodos, 'no se ve ningún importe en es-AR en los medios de pago')
          .toMatch(IMPORTE_AR)
        for (const b of BASURA) {
          expect(textoMetodos, `apareció "${b}" en las tarjetas de caja`).not.toContain(b)
        }

        // ── Sin scroll horizontal global ──
        const desborda = await page.evaluate(() =>
          document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
        expect(desborda, `hay scroll horizontal global en ${vp.width}px`).toBe(false)

        // ── Y sin contenido INALCANZABLE en toda la pestaña ──
        // (mismo detector que el gate de Charts L1: un ancestro con scroll
        // horizontal propio SÍ cuenta como alcanzable y no es defecto).
        const clipeados = await page.evaluate(() => {
          const limite = document.documentElement.clientWidth + 1
          const raiz = document.querySelector('[data-testid="finance-dashboard-page"]')
          if (!raiz) return ['no se encontró finance-dashboard-page']

          const alcanzablePorScroll = (el: Element): boolean => {
            let p: Element | null = el.parentElement
            while (p && p !== document.documentElement) {
              const ox = getComputedStyle(p).overflowX
              if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true
              p = p.parentElement
            }
            return false
          }

          const out: string[] = []
          for (const el of Array.from(raiz.querySelectorAll('*'))) {
            const r = el.getBoundingClientRect()
            if (r.width <= 0 || r.height <= 0) continue
            if (getComputedStyle(el).position === 'fixed') continue
            if (r.right <= limite) continue
            if (alcanzablePorScroll(el)) continue
            const id = el.getAttribute('data-testid')
            const desc = id ?? `${el.tagName.toLowerCase()}"${(el.textContent ?? '').trim().slice(0, 24)}"`
            out.push(`${desc} (right=${Math.round(r.right)} > ${Math.round(limite)})`)
          }
          return [...new Set(out)].slice(0, 8)
        })
        expect(clipeados, `bloques cortados en ${vp.width}px: ${clipeados.join(' · ')}`).toEqual([])

        // ── Evidencia ──
        await page.screenshot({
          path: `tests/e2e/evidencia/prebeta-p1/caja-${vp.nombre}-${tema}.png`,
          fullPage: true,
        })

        const relevantes = erroresConsola.filter(e =>
          !/favicon|manifest|ResizeObserver loop|Download the React DevTools/i.test(e))
        expect(relevantes, `errores de consola: ${relevantes.join(' | ')}`).toEqual([])
      })
    }
  }

  test('la tabla de movimientos es alcanzable por scroll propio en 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await irACaja(page, 'light')

    const scroller = page.locator('[data-testid="finance-movements-scroller"]').first()
    // Si no hay movimientos en el período, la tabla no se monta: no es un fallo
    // del layout y el resto del gate ya cubrió las tarjetas.
    if (await scroller.count() === 0) {
      test.skip(true, 'sin movimientos en el período: no hay tabla que verificar')
      return
    }

    const ox = await scroller.evaluate(el => getComputedStyle(el).overflowX)
    expect(ox, 'la tabla debe poder scrollear en su propio contenedor').toMatch(/auto|scroll/)

    // Y la columna Monto tiene que ser efectivamente alcanzable: se scrollea
    // hasta el final y se comprueba que el importe queda dentro del viewport.
    const alcanzable = await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
      const limite = document.documentElement.clientWidth + 1
      const celdas = Array.from(el.querySelectorAll('td'))
        .filter(td => /\$/.test(td.textContent ?? ''))
      if (celdas.length === 0) return true
      return celdas.every(td => td.getBoundingClientRect().right <= limite + 1)
    })
    expect(alcanzable, 'la columna Monto no se puede alcanzar ni scrolleando').toBe(true)
  })

  // ══════════════════════════════════════════════════════════════════════════
  // P1-D — la superficie de reposición, en el Resumen
  // ══════════════════════════════════════════════════════════════════════════
  for (const tema of TEMAS) {
    test(`P1-D · reposición registrada · ${tema}`, async ({ page }) => {
      await page.addInitScript((t) => {
        window.localStorage.setItem('techrepair_theme', t)
        window.localStorage.setItem('theme', t)
      }, tema)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto('/finance')
      await page.waitForSelector('[data-testid="finance-charts-l1"]', { timeout: 30_000 })
      await expect
        .poll(async () => page.getByTestId('card-inventory-capital').getAttribute('data-state'),
              { timeout: 30_000 })
        .not.toBe('loading')

      // ── La etiqueta dice lo que el número realmente mide ──
      await expect(page.getByTestId('replenishment-label')).toHaveText('Reposición registrada')
      await expect(page.getByText('Reposición del período')).toHaveCount(0)

      const tarjeta = await page.getByTestId('card-inventory-capital').innerText()

      // ── Capital en stock intacto: la denominación canónica no se movió ──
      expect(tarjeta).toContain('Capital en stock')
      expect(tarjeta).toContain('según los costos registrados actualmente')
      expect(tarjeta.toLowerCase()).not.toContain('capital total')
      expect(tarjeta.toLowerCase()).not.toContain('patrimonio')

      // ── Lenguaje: nada de conclusiones que el dato no sostiene ──
      for (const prohibido of [
        /descapitaliz/i, /no repusiste/i, /no compraste/i,
        /ten[eé]s un error/i, /faltan compras/i,
      ]) {
        expect(tarjeta, `apareció lenguaje prohibido: ${prohibido}`).not.toMatch(prohibido)
      }
      // Y jamás se afirma que hubo mercadería recibida.
      expect(tarjeta).not.toMatch(/(hubo|recibiste|compraste)\s+mercader[ií]a/i)

      // ── Sin basura en pantalla ──
      for (const b of BASURA) {
        expect(tarjeta, `apareció "${b}" en la tarjeta de capital`).not.toContain(b)
      }

      // ── Coherencia: el 0 % SIEMPRE viene acompañado de una explicación ──
      const valor = await page.getByTestId('replenishment-value').innerText()
      const texto = await page.getByTestId('replenishment-text').innerText()
      if (/^0([.,]0+)?\s*%$/.test(valor.trim())) {
        expect(texto, 'un 0 % sin explicación se lee como "no compré mercadería"')
          .toContain('No se registraron entradas de mercadería en inventario')
      }
      expect(texto.trim().length, 'la reposición siempre explica qué se midió').toBeGreaterThan(0)

      // ── Si hay aviso de proveedor, es condicional y es una nota, no una alerta ──
      const nota = page.getByTestId('replenishment-supplier-note')
      if (await nota.count() > 0) {
        const t = await nota.innerText()
        expect(t).toContain('Si corresponden a mercadería recibida')
        expect(await nota.getAttribute('role')).toBe('note')
      }

      // Evidencia de la tarjeta, no del viewport: la reposición vive muy por
      // debajo del pliegue y una captura de pantalla completa no la muestra.
      await page.getByTestId('card-inventory-capital').screenshot({
        path: `tests/e2e/evidencia/prebeta-p1/resumen-reposicion-${tema}.png`,
      })
    })
  }

  test('P1-D · el 0 % contextual se ve de verdad en el navegador', async ({ page }) => {
    // El mes ANTERIOR de los fixtures es exactamente el caso C de §13:
    //   consumo devengado > 0 · CERO entradas de inventario · 1 compra a
    //   proveedor registrada. Es el escenario que producía el "0 %" mudo que se
    //   leía como "no compré mercadería".
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/finance')
    await page.waitForSelector('[data-testid="finance-charts-l1"]', { timeout: 30_000 })

    const mesAnterior = page.locator('[data-testid="finance-dashboard-date-filter"]')
      .locator('button', { hasText: /mes ant/i })
    await expect(mesAnterior).toBeVisible({ timeout: 15_000 })
    await mesAnterior.click()

    await expect
      .poll(async () => page.getByTestId('card-inventory-capital').getAttribute('data-state'),
            { timeout: 30_000 })
      .not.toBe('loading')
    await expect
      .poll(async () => (await page.getByTestId('replenishment-value').innerText()).trim(),
            { timeout: 30_000 })
      .toMatch(/^0([.,]0+)?\s*%$/)

    // El 0 % viene acompañado del HECHO, no de una acusación.
    await expect(page.getByTestId('replenishment-text'))
      .toHaveText('No se registraron entradas de mercadería en inventario durante este período.')

    // Y como hay compras a proveedores cargadas, aparece el aviso condicional.
    const nota = page.getByTestId('replenishment-supplier-note')
    await expect(nota).toBeVisible()
    await expect(nota).toContainText(
      'Hay compras a proveedores registradas. Si corresponden a mercadería recibida, ' +
      'revisá que se haya ingresado al inventario.')
    expect(await nota.getAttribute('role'), 'es una nota, no una alerta crítica').toBe('note')

    const tarjeta = await page.getByTestId('card-inventory-capital').innerText()
    for (const prohibido of [
      /descapitaliz/i, /no repusiste/i, /no compraste/i,
      /ten[eé]s un error/i, /faltan compras/i,
      /(hubo|recibiste|compraste)\s+mercader[ií]a/i,
    ]) {
      expect(tarjeta, `apareció lenguaje prohibido: ${prohibido}`).not.toMatch(prohibido)
    }
    // El importe de las compras a proveedores NO se presenta como reposición.
    expect(tarjeta).not.toMatch(/reposici[oó]n registrada[\s\S]{0,40}145\.000/i)

    await page.getByTestId('card-inventory-capital').screenshot({
      path: 'tests/e2e/evidencia/prebeta-p1/resumen-reposicion-cero-contextual.png',
    })
  })

  test('desktop 1440 no sufre regresión: las 4 tarjetas en una sola fila', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await irACaja(page, 'light')

    // auto-fit con minmax(150px, 1fr) debe seguir dando 4 columnas en desktop:
    // el fix de móvil no puede degradar la lectura en pantalla grande.
    const filas = await page.evaluate(() => {
      const cont = document.querySelector('[data-testid="finance-caja-cash-methods"]')
      if (!cont) return -1
      return new Set(Array.from(cont.children)
        .map(c => Math.round(c.getBoundingClientRect().top))).size
    })
    expect(filas, 'en 1440px las 4 tarjetas deben quedar en una sola fila').toBe(1)
  })
})
