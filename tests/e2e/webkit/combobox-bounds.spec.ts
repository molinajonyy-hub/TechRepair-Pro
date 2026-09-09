/**
 * ORDERS-V2-0.1.1 · el desplegable no puede quedar recortado en el celular.
 *
 * El human smoke en iPhone falló: las listas de Marca y Modelo se cortaban.
 * Medido a 390×844 con `combobox-diagnostico.spec.ts`, ANTES del arreglo:
 *
 *     lista              top 341 → bottom 597  (alto 256)
 *     .intake-step-card  overflow hidden/hidden, bottom 449
 *
 * Se veían 108 px de 256. NO era falta de espacio —había 327 px libres debajo
 * del campo y la lista no se salía de pantalla— sino el `overflow:hidden` de la
 * card. Por eso la lista ahora se portaléa a `document.body`: ningún ancestro
 * puede recortarla.
 *
 * Este spec asevera exactamente lo que el bug rompía: la lista entera visible,
 * pegada a su campo, en los anchos de iPhone reales.
 *
 * ── LÍMITE DE ESTE ARCHIVO ────────────────────────────────────────────────
 * El volteo hacia arriba NO se prueba acá, y no por olvido: en este layout el
 * campo de Marca nunca baja de ~200 px del borde inferior —el scroll del paso
 * se agota antes— y WebKit headless no abre teclado, que es lo que en un iPhone
 * real achica el viewport visual y provoca el volteo. Forzarlo pidiendo
 * coordenadas o estilos falsos probaría una pantalla que no existe.
 *
 * El cálculo del lado y del alto está cubierto por `tests/components/
 * anchoredPosition.test.ts` (caso B: sin lugar abajo → arriba; caso C: alto
 * adaptado; y el desplazamiento del viewport visual de iOS). Acá se prueba lo
 * que sólo un motor real puede responder: dónde termina la caja en pantalla.
 */
import { expect, test, type Page } from '@playwright/test'

const EVIDENCE = 'docs/orders-v2-0-1-1-evidence'
const SEED_CUSTOMER = 'Cliente E2E'
/** Mismo margen que `ANCHOR_DEFAULTS.gutter`. */
const GUTTER = 8

/** Marcas suficientes para que la lista exceda su alto máximo (16rem). */
const MANY_BRANDS = [
  'Alcatel', 'Apple', 'Asus', 'BLU', 'Google', 'Honor', 'Huawei', 'Infinix',
  'Lanix', 'Lenovo', 'LG', 'Motorola', 'Nokia', 'OnePlus', 'Oppo', 'Realme',
  'Samsung', 'Sony', 'TCL', 'Tecno', 'Vivo', 'Xiaomi', 'ZTE',
]
const MARCA_ELEGIDA = 'Apple'
const MANY_MODELS = Array.from({ length: 24 }, (_, index) => ({
  id: `m${index}`, name: `Modelo ${index + 1}`, brand_id: 'b-apple',
}))

/**
 * El catálogo sembrado tiene pocas marcas; acá hacen falta listas largas, que
 * es la condición en la que el recorte se veía.
 *
 * `brands` se sirve distinto según la consulta: el listado devuelve el arreglo,
 * pero la búsqueda por nombre (`getBrandByName`, un `.maybeSingle()`) espera un
 * objeto. Servir el arreglo a las dos rompería la resolución del id de marca.
 */
async function conCatalogoLargo(page: Page) {
  await page.route('**/rest/v1/brands*', route => {
    const esBusquedaPorNombre = route.request().url().includes('name=ilike')
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        esBusquedaPorNombre
          ? { id: 'b-apple', name: MARCA_ELEGIDA }
          : MANY_BRANDS.map((name, index) => ({ id: `b${index}`, name })),
      ),
    })
  })
  await page.route('**/rest/v1/device_models*', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(MANY_MODELS),
  }))
}

async function elegirCliente(page: Page) {
  await page.getByTestId('customer-picker-search').fill(SEED_CUSTOMER)
  const option = page.getByRole('button', { name: new RegExp(SEED_CUSTOMER) }).first()
  await option.waitFor({ timeout: 20000 })
  await option.click()
  await page.getByRole('button', { name: 'Continuar' }).last().click()
}

/** Mide la lista abierta y busca ancestros capaces de recortarla. */
async function medir(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector('.app-combobox-list') as HTMLElement
    const rect = list.getBoundingClientRect()
    // El campo que ancla la lista abierta, para poder juzgar el lado elegido.
    const anchor = document
      .querySelector('.app-combobox input[aria-expanded="true"]')!
      .closest('.app-combobox-field')!
      .getBoundingClientRect()

    /**
     * Prueba funcional, no estructural: se pregunta al motor qué elemento hay
     * en cada esquina y en el centro de la lista.
     *
     * Un recorrido de ancestros no serviría acá. `body.mobile-shell-active`
     * lleva `overflow: hidden`, pero no es el bloque contenedor de un elemento
     * `fixed`, así que no lo recorta; contarlo daría un fallo falso. El hit test
     * responde lo que de verdad importa —si la lista está ahí y descubierta—
     * y además caza cualquier cosa que la tape (una barra inferior, un overlay).
     */
    const margen = 4
    const puntos: Array<[string, number, number]> = [
      ['sup. izq.', rect.left + margen, rect.top + margen],
      ['sup. der.', rect.right - margen, rect.top + margen],
      ['inf. izq.', rect.left + margen, rect.bottom - margen],
      ['inf. der.', rect.right - margen, rect.bottom - margen],
      ['centro', (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2],
    ]
    const puntosTapados = puntos
      .filter(([, x, y]) => {
        const hit = document.elementFromPoint(x, y)
        return !(hit && (hit === list || list.contains(hit)))
      })
      .map(([nombre]) => nombre)

    const vv = window.visualViewport
    const viewport = {
      width: vv?.width ?? window.innerWidth,
      height: vv?.height ?? window.innerHeight,
      offsetTop: vv?.offsetTop ?? 0,
    }
    return {
      rect: {
        top: rect.top, bottom: rect.bottom,
        left: rect.left, right: rect.right, height: rect.height,
      },
      viewport,
      campo: { top: anchor.top, bottom: anchor.bottom, left: anchor.left, width: anchor.width },
      puntosTapados,
      cuelgaDeBody: list.parentElement === document.body,
      placement: list.dataset.placement,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      // Ambos del mismo sistema de referencia. `visualViewport.width` NO sirve
      // como vara acá: WebKit reporta 313 en un viewport de 320, así que
      // compararlo contra `scrollWidth` daría un desborde inexistente.
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth,
      // Lo que el ojo ve: la intersección entre la lista y el viewport visual.
      altoVisible:
        Math.min(rect.bottom, viewport.offsetTop + viewport.height)
        - Math.max(rect.top, viewport.offsetTop),
    }
  })
}

type Medicion = Awaited<ReturnType<typeof medir>>

function assertDentroDelViewport(m: Medicion, etiqueta: string) {
  const { rect, viewport } = m
  const tolerancia = 1 // subpíxeles del layout, no holgura de criterio

  expect(m.cuelgaDeBody, `${etiqueta}: la lista debe colgar de body (portal)`).toBe(true)
  expect(m.puntosTapados, `${etiqueta}: la lista tiene que estar visible en toda su caja`)
    .toEqual([])

  expect(rect.left, `${etiqueta}: borde izquierdo`).toBeGreaterThanOrEqual(GUTTER - tolerancia)
  expect(rect.right, `${etiqueta}: borde derecho`)
    .toBeLessThanOrEqual(viewport.width - GUTTER + tolerancia)
  expect(rect.top, `${etiqueta}: borde superior`)
    .toBeGreaterThanOrEqual(viewport.offsetTop + GUTTER - tolerancia)
  expect(rect.bottom, `${etiqueta}: borde inferior`)
    .toBeLessThanOrEqual(viewport.offsetTop + viewport.height - GUTTER + tolerancia)

  // El síntoma exacto del bug: se veía una fracción de la lista.
  expect(Math.round(m.altoVisible), `${etiqueta}: se ve entera`)
    .toBeGreaterThanOrEqual(Math.round(rect.height) - tolerancia)

  expect(m.pageScrollWidth, `${etiqueta}: sin scroll horizontal`)
    .toBeLessThanOrEqual(m.pageClientWidth)
  // Una lista de alto 0 pasaría todos los límites anteriores sin ser usable.
  expect(rect.height, `${etiqueta}: alto usable`).toBeGreaterThanOrEqual(96)

  // Estar dentro de pantalla no alcanza: al vivir en `position: fixed` fuera del
  // formulario, una lista mal ubicada seguiría pasando todo lo anterior. Tiene
  // que quedar pegada a SU campo, de un lado o del otro.
  const pegadaAbajo = Math.abs(rect.top - m.campo.bottom)
  const pegadaArriba = Math.abs(m.campo.top - rect.bottom)
  expect(
    Math.min(pegadaAbajo, pegadaArriba),
    `${etiqueta}: la lista tiene que quedar pegada al campo (placement ${m.placement})`,
  ).toBeLessThanOrEqual(8)
}

test.describe('@webkit ORDERS-V2-0.1.1 · desplegable dentro del viewport', () => {
  test('Marca y Modelo se ven enteros a 390×844', async ({ page }) => {
    await conCatalogoLargo(page)
    await page.goto('/orders/new')
    await elegirCliente(page)

    const marca = page.getByTestId('intake-brand')
    const list = page.locator('.app-combobox-list')

    await marca.click()
    await expect(list).toBeVisible()

    const medicionMarca = await medir(page)
    assertDentroDelViewport(medicionMarca, 'Marca')
    // Si la lista entrara completa no habría nada que recortar: el caso del bug
    // exige contenido que exceda la caja.
    expect(medicionMarca.scrollHeight, 'Marca: la lista debe exceder su alto visible')
      .toBeGreaterThan(medicionMarca.clientHeight)
    await page.screenshot({ path: `${EVIDENCE}/webkit-390x844-marca-completa.png` })

    // El contrato táctil aprobado sigue en pie: desplazar no elige ni cierra.
    await list.evaluate(node => { node.scrollTop = 140 })
    await expect(list).toBeVisible()
    await expect(marca).toHaveValue('')

    // Y el tap posterior sí elige.
    await list.getByRole('option', { name: MARCA_ELEGIDA, exact: true }).click()
    await expect(marca).toHaveValue(MARCA_ELEGIDA)
    await expect(marca).toHaveAttribute('aria-expanded', 'false')

    // ── Modelo ───────────────────────────────────────────────────────────────
    const modelo = page.getByTestId('intake-model')
    await modelo.click()
    await expect(list.getByRole('option').first()).toBeVisible()

    const medicionModelo = await medir(page)
    assertDentroDelViewport(medicionModelo, 'Modelo')
    await page.screenshot({ path: `${EVIDENCE}/webkit-390x844-modelo-completo.png` })
  })

  test('al achicarse la pantalla se reubica, sin salirse ni despegarse', async ({ page }) => {
    await conCatalogoLargo(page)
    await page.goto('/orders/new')
    await elegirCliente(page)

    const marca = page.getByTestId('intake-brand')
    const list = page.locator('.app-combobox-list')
    await marca.click()
    await expect(list).toBeVisible()

    const antes = await medir(page)
    assertDentroDelViewport(antes, 'Marca (844)')

    // La lista está en `position: fixed` con coordenadas calculadas al abrir:
    // si nadie la recalcula, un cambio de viewport la deja flotando donde ya no
    // corresponde. Achicar la pantalla ejercita ese recálculo de verdad.
    await page.setViewportSize({ width: 390, height: 420 })
    await expect(list).toBeVisible()
    await expect
      .poll(async () => (await medir(page)).rect.top, { timeout: 2000 })
      .not.toBe(antes.rect.top)

    // Sigue entera, dentro de pantalla y pegada al campo en su posición nueva.
    // No se le exige achicarse: a 420 px todavía entran los 256 completos, y
    // pedir un alto menor sería inventar un requisito que el caso no tiene.
    assertDentroDelViewport(await medir(page), 'Marca (420)')
    await page.screenshot({ path: `${EVIDENCE}/webkit-390x420-reubicada.png` })
  })

  test('matriz de anchos de iPhone: 320 · 375 · 430', async ({ page }) => {
    await conCatalogoLargo(page)
    for (const [width, height] of [[320, 568], [375, 667], [430, 932]]) {
      await page.setViewportSize({ width, height })
      await page.goto('/orders/new')
      await elegirCliente(page)

      await page.getByTestId('intake-brand').click()
      await expect(page.locator('.app-combobox-list')).toBeVisible()
      assertDentroDelViewport(await medir(page), `${width}×${height}`)
      await page.keyboard.press('Escape')
    }
  })
})
