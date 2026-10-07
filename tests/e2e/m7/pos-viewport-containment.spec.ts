// ============================================================================
// BETA-UX-1B · smoke manual — el POS se mide contra el VIEWPORT, no contra la
// página que lo abre.
//
//   npx playwright test --project=m7-local --grep @pos-viewport
//
// QUÉ PASÓ
// --------
// Abierto desde una orden, el POS aparecía corrido hacia abajo y con parte del
// contenido fuera de la pantalla: el fondo oscuro no arrancaba en el borde de la
// ventana sino dentro del área de la página.
//
// No era un problema de medidas del POS. `OrderDetail` envuelve la página en
// `.animate-fade-in`, cuya animación terminaba en `transform: translateY(0)` y
// se conservaba con `forwards`. Un `transform` distinto de `none` —aunque sea la
// identidad— convierte al elemento en el bloque contenedor de sus descendientes
// `position: fixed` y en un contexto de apilamiento: el `inset: 0` del POS
// cubría la página, no el viewport, y su `z-index` no competía con el header ni
// con el sidebar.
//
// Medido sobre el build anterior, a 1366×768: wrapper con
// `transform: matrix(1, 0, 0, 1, 0, 0)` y rectángulo (top 129, left 292,
// 1042×1630); el overlay del POS medía EXACTAMENTE eso, y el shell quedaba entre
// y=575 e y=1313 — fuera de una pantalla de 768 de alto.
//
// POR QUÉ NO LO VIO NADIE
// -----------------------
// Los gates del POS (`pos-mobile-layout`, `search-pos-visual`, `pos-open-caja`)
// lo abren desde `/comprobantes`, que no tiene ese wrapper. Ahí el POS ya se
// medía contra el viewport. Este spec lo abre DESDE UNA ORDEN, que es la entrada
// del primer cobro, y compara contra `window.innerWidth / innerHeight`.
//
// QUÉ FIJA
// --------
//   · el overlay arranca en (0,0) y cubre todo el viewport, también con la
//     página de atrás scrolleada;
//   · el shell queda centrado y entero adentro; cerrar y la acción principal se
//     pueden tocar;
//   · el POS vive en un portal (hijo de <body>), fuera del árbol de la página;
//   · `.animate-fade-in` no deja un `transform` aplicado al terminar;
//   · «Abrir caja» sigue apareciendo por encima del POS y abrirlo o cerrarlo no
//     desmonta el POS.
// ============================================================================
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { ejecutarSQL } from '../setup/sqlLocal.ts'
import { E2E } from '../setup/seedE2E.ts'
import { cerrarCaja, abrirCaja } from '../setup/fixturesM7.ts'

// Filas sintéticas en la base LOCAL del stack de pruebas, nunca producción.
const FIX = {
  customer: '00000000-0000-0000-0000-00000e2e1b01',
  device:   '00000000-0000-0000-0000-00000e2e1b02',
  order:    '00000000-0000-0000-0000-00000e2e1b03',
}
const CLIENTE = 'Cliente viewport sintético'

const TOL = 1
const VIEWPORTS = [
  // Alto limitado: el caso de la captura (notebook 1366×768).
  { nombre: 'desktop-1366x768',  width: 1366, height: 768,  movil: false },
  { nombre: 'desktop-1920x1080', width: 1920, height: 1080, movil: false },
  { nombre: 'mobile-390x844',    width: 390,  height: 844,  movil: true  },
] as const

function limpiar(): void {
  ejecutarSQL(`BEGIN;
    DELETE FROM public.orders    WHERE id = '${FIX.order}';
    DELETE FROM public.devices   WHERE id = '${FIX.device}';
    DELETE FROM public.customers WHERE id = '${FIX.customer}';
    COMMIT;`)
}

/** Borra una caja abierta por el test (nunca la sembrada). */
function limpiarCajasDelTest(): void {
  ejecutarSQL(`
BEGIN;
SET LOCAL session_replication_role = 'replica';
DELETE FROM public.cash_session_requests r USING public.cajas c
 WHERE r.caja_id = c.id AND c.business_id='${E2E.business}' AND c.id <> '${E2E.caja}' AND c.status='abierta';
DELETE FROM public.cajas
 WHERE business_id='${E2E.business}' AND id <> '${E2E.caja}' AND status='abierta';
COMMIT;`)
}

interface Rect { top: number; left: number; right: number; bottom: number; width: number; height: number }
interface Medicion {
  innerWidth: number
  innerHeight: number
  /** Ancho de una barra de scroll clásica, si la hay (0 con barras superpuestas). */
  barra: number
  overlay: Rect
  shell: Rect
  overlayEsHijoDeBody: boolean
  overlayDentroDeLaPagina: boolean
  /** ¿El punto pertenece al POS? Si no, otra capa (header, sidebar) quedó encima. */
  esquinasDelPos: boolean[]
  scrollY: number
  desbordeHorizontal: number
}

/** Geometría del POS contra `window.innerWidth / innerHeight`. */
async function medirPos(page: Page): Promise<Medicion> {
  return page.evaluate(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    }
    const overlay = document.querySelector('.cpm-root') as HTMLElement
    const shell = document.querySelector('.cpm-shell') as HTMLElement
    const w = window.innerWidth, h = window.innerHeight
    const puntos: Array<[number, number]> = [[4, 4], [w - 4, 4], [4, h - 4], [w - 4, h - 4], [w / 2, 2]]
    return {
      innerWidth: w,
      innerHeight: h,
      barra: w - document.documentElement.clientWidth,
      overlay: rect(overlay),
      shell: rect(shell),
      overlayEsHijoDeBody: overlay.parentElement === document.body,
      overlayDentroDeLaPagina: overlay.closest('#root') !== null,
      esquinasDelPos: puntos.map(([x, y]) => {
        const hit = document.elementFromPoint(x, y)
        return Boolean(hit && overlay.contains(hit))
      }),
      scrollY: window.scrollY,
      desbordeHorizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
}

/** Las aserciones de contención: lo que la captura del smoke violaba. */
function exigirContenido(m: Medicion, cuando: string): void {
  // Overlay: arranca en el borde de la ventana y la cubre entera.
  expect(Math.abs(m.overlay.top), `${cuando}: el overlay no arranca en top=0 (top=${m.overlay.top})`).toBeLessThanOrEqual(TOL)
  expect(Math.abs(m.overlay.left), `${cuando}: el overlay no arranca en left=0 (left=${m.overlay.left})`).toBeLessThanOrEqual(TOL)
  expect(m.overlay.width, `${cuando}: el overlay no cubre el ancho del viewport`).toBeGreaterThanOrEqual(m.innerWidth - m.barra - TOL)
  expect(m.overlay.width, `${cuando}: el overlay es más ancho que el viewport`).toBeLessThanOrEqual(m.innerWidth + TOL)
  expect(Math.abs(m.overlay.height - m.innerHeight), `${cuando}: el overlay no cubre el alto del viewport (${m.overlay.height} vs ${m.innerHeight})`).toBeLessThanOrEqual(TOL)

  // Shell: entero adentro, por los cuatro lados.
  expect(m.shell.top, `${cuando}: el shell se sale por arriba`).toBeGreaterThanOrEqual(-TOL)
  expect(m.shell.left, `${cuando}: el shell se sale por la izquierda`).toBeGreaterThanOrEqual(-TOL)
  expect(m.shell.bottom, `${cuando}: el shell se sale por abajo (${m.shell.bottom} > ${m.innerHeight})`).toBeLessThanOrEqual(m.innerHeight + TOL)
  expect(m.shell.right, `${cuando}: el shell se sale por la derecha`).toBeLessThanOrEqual(m.innerWidth + TOL)

  // …y centrado respecto del VIEWPORT, no de la página.
  const cx = (m.shell.left + m.shell.right) / 2
  const cy = (m.shell.top + m.shell.bottom) / 2
  expect(Math.abs(cx - (m.innerWidth - m.barra) / 2), `${cuando}: el shell no está centrado a lo ancho`).toBeLessThanOrEqual(TOL + 0.5)
  expect(Math.abs(cy - m.innerHeight / 2), `${cuando}: el shell no está centrado a lo alto`).toBeLessThanOrEqual(TOL + 0.5)

  // Nada de la aplicación queda por encima: esquinas y borde superior son del POS.
  expect(m.esquinasDelPos, `${cuando}: otra capa quedó encima del POS en alguna esquina`).toEqual([true, true, true, true, true])

  // Desacoplado del árbol de la página.
  expect(m.overlayEsHijoDeBody, `${cuando}: .cpm-root debe ser hijo directo de <body>`).toBe(true)
  expect(m.overlayDentroDeLaPagina, `${cuando}: .cpm-root no puede vivir dentro de #root`).toBe(false)
  expect(m.desbordeHorizontal, `${cuando}: scroll horizontal`).toBeLessThanOrEqual(TOL)
}

/** ¿El elemento está dentro del viewport y recibe el toque en su centro? */
async function alcanzable(page: Page, testId: string): Promise<{ dentro: boolean; recibe: boolean }> {
  return page.getByTestId(testId).evaluate(el => {
    const r = el.getBoundingClientRect()
    const dentro = r.width > 0 && r.height > 0 && r.top >= -1 && r.left >= -1 &&
      r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { dentro, recibe: hit === el || Boolean(hit && el.contains(hit)) }
  })
}

/** `transform` computado de cada `.animate-fade-in`, una vez terminadas sus animaciones. */
async function transformsDeEntrada(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('.animate-fade-in'))
    await Promise.all(els.flatMap(el => el.getAnimations().map(a => a.finished.catch(() => undefined))))
    return els.map(el => getComputedStyle(el).transform)
  })
}

async function abrirOrden(page: Page) {
  await page.goto(`/orders/${FIX.order}`)
  await expect(page.getByText(CLIENTE, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Generar Comprobante' })).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test.describe('@pos-viewport POS — contenido en el viewport desde cualquier entrada', () => {
  test.beforeAll(() => {
    limpiar()
    ejecutarSQL(`BEGIN;
      INSERT INTO public.customers (id, business_id, name, phone)
      VALUES ('${FIX.customer}', '${E2E.business}', '${CLIENTE}', '0000000000');
      INSERT INTO public.devices (id, business_id, customer_id, type, brand, model, issue)
      VALUES ('${FIX.device}', '${E2E.business}', '${FIX.customer}',
        'smartphone', 'Equipo', 'Viewport sintético', 'Fixture local');
      INSERT INTO public.orders (id, business_id, customer_id, device_id, status, priority)
      VALUES ('${FIX.order}', '${E2E.business}', '${FIX.customer}', '${FIX.device}', 'new', 'medium');
      COMMIT;`)
  })

  test.afterAll(() => {
    limpiarCajasDelTest()
    abrirCaja()
    limpiar()
  })

  for (const vp of VIEWPORTS) {
    test(`desde una orden · ${vp.nombre}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await abrirOrden(page)

      // ── La causa: el wrapper de la página no puede quedar transformado ─────
      const transforms = await transformsDeEntrada(page)
      expect(transforms.length, 'la orden debe renderizar su wrapper .animate-fade-in').toBeGreaterThan(0)
      expect(transforms, '.animate-fade-in dejó un transform aplicado al terminar').toEqual(transforms.map(() => 'none'))

      await page.getByRole('button', { name: 'Generar Comprobante' }).click()
      await expect(page.locator('[data-testid="comprobante-product-search"]')).toBeVisible({ timeout: 15_000 })

      // ── 1 · recién abierto ─────────────────────────────────────────────────
      exigirContenido(await medirPos(page), 'recién abierto')
      await page.screenshot({ path: testInfo.outputPath(`orden-${vp.nombre}.png`) })

      // Cerrar a la vista y tocable.
      expect(await alcanzable(page, 'comprobante-cancel-button'), 'el botón de cerrar').toEqual({ dentro: true, recibe: true })

      // Acción principal alcanzable: «Cobrar» en desktop; en móvil, la barra que
      // abre la hoja de cobro, y dentro de la hoja, «Cobrar».
      if (vp.movil) {
        expect(await alcanzable(page, 'comprobante-mobile-checkout-open'), '«Revisar y cobrar»').toEqual({ dentro: true, recibe: true })
        await page.getByTestId('comprobante-mobile-checkout-open').click()
        await expect(page.getByTestId('comprobante-save-button')).toBeVisible()
        await page.getByTestId('comprobante-mobile-checkout-sheet').evaluate(async el => {
          await Promise.all(el.getAnimations().map(a => a.finished.catch(() => undefined)))
        })
        expect(await alcanzable(page, 'comprobante-save-button'), '«Cobrar» en la hoja').toEqual({ dentro: true, recibe: true })
        await page.getByTestId('comprobante-mobile-checkout-close').click()
      } else {
        expect(await alcanzable(page, 'comprobante-save-button'), '«Cobrar»').toEqual({ dentro: true, recibe: true })
      }

      // ── 4 · no depende del scroll de la página de atrás ────────────────────
      // Con el bug, el overlay viajaba con la página: bastaba scrollear para que
      // el POS se fuera de la pantalla.
      const scrolleable = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      const conScroll = await medirPos(page)
      if (vp.height <= 844) {
        expect(scrolleable, 'la orden debe ser más alta que este viewport para que el caso mida algo').toBeGreaterThan(40)
        expect(conScroll.scrollY, 'la página de atrás debe haber scrolleado').toBeGreaterThan(40)
      }
      exigirContenido(conScroll, `con la orden scrolleada ${Math.round(conScroll.scrollY)}px`)
      await page.evaluate(() => window.scrollTo(0, 0))
      exigirContenido(await medirPos(page), 'de vuelta arriba')

      // Cerrar sigue funcionando (carrito vacío: cierra sin preguntar).
      await page.getByTestId('comprobante-cancel-button').click()
      await expect(page.locator('.cpm-root')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Generar Comprobante' })).toBeVisible()
    })
  }

  test('desde una orden ya scrolleada · se abre igual contra el viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await abrirOrden(page)
    await transformsDeEntrada(page)

    // Se scrollea la página y se dispara el click SIN que Playwright la devuelva
    // arriba: el botón queda fuera de la vista, como al usar un atajo o el teclado.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const antes = await page.evaluate(() => window.scrollY)
    expect(antes).toBeGreaterThan(40)
    await page.getByRole('button', { name: 'Generar Comprobante' }).dispatchEvent('click')
    await expect(page.locator('.cpm-root')).toBeVisible({ timeout: 15_000 })

    const m = await medirPos(page)
    expect(m.scrollY, 'abrir el POS no debe mover la página').toBe(antes)
    exigirContenido(m, `abierto con la orden scrolleada ${Math.round(antes)}px`)
    expect(await alcanzable(page, 'comprobante-cancel-button')).toEqual({ dentro: true, recibe: true })
    expect(await alcanzable(page, 'comprobante-save-button')).toEqual({ dentro: true, recibe: true })
  })

  for (const vp of VIEWPORTS) {
    test(`desde /comprobantes · ${vp.nombre}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/comprobantes')
      const nuevo = page.locator('[data-testid="comprobantes-new-button"]')
      await expect(nuevo).toBeVisible({ timeout: 30_000 })
      await nuevo.click()
      await expect(page.locator('[data-testid="comprobante-product-search"]')).toBeVisible({ timeout: 15_000 })

      exigirContenido(await medirPos(page), 'desde /comprobantes')
      expect(await alcanzable(page, 'comprobante-cancel-button')).toEqual({ dentro: true, recibe: true })
      expect(await alcanzable(page, vp.movil ? 'comprobante-mobile-checkout-open' : 'comprobante-save-button'))
        .toEqual({ dentro: true, recibe: true })

      // Escape cierra (carrito vacío) igual que antes del portal.
      await page.keyboard.press('Escape')
      await expect(page.locator('.cpm-root')).toHaveCount(0)
    })
  }

  test('«Abrir caja» desde una orden: por encima del POS, y el POS no se desmonta', async ({ page }) => {
    limpiarCajasDelTest()
    cerrarCaja()
    try {
      await page.setViewportSize({ width: 1366, height: 768 })
      await abrirOrden(page)
      await page.getByRole('button', { name: 'Generar Comprobante' }).click()
      await expect(page.locator('[data-testid="comprobante-product-search"]')).toBeVisible({ timeout: 15_000 })

      // Se marca el nodo del POS: si se desmontara, la marca se perdería.
      await page.locator('.cpm-root').evaluate(el => { (el as HTMLElement & { __marca?: string }).__marca = 'pos-original' })
      const sigueSiendoElMismo = () =>
        page.locator('.cpm-root').evaluate(el => (el as HTMLElement & { __marca?: string }).__marca === 'pos-original')

      await page.getByTestId('pos-open-caja-button').click()
      const dialogo = page.getByTestId('pos-open-caja-dialog')
      await expect(dialogo).toBeVisible()
      await dialogo.evaluate(async el => {
        await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => undefined)))
      })

      // Su overlay también cubre el viewport, y el diálogo recibe el toque: está
      // por ENCIMA del POS, no debajo ni recortado por él.
      const capa = await page.getByTestId('pos-open-caja-overlay').evaluate(el => {
        const r = el.getBoundingClientRect()
        const d = (document.querySelector('[data-testid="pos-open-caja-dialog"]') as HTMLElement).getBoundingClientRect()
        const hit = document.elementFromPoint(d.left + d.width / 2, d.top + 24)
        return {
          top: r.top, left: r.left, width: r.width, height: r.height,
          vw: document.documentElement.clientWidth, vh: window.innerHeight,
          dentroDelPos: el.closest('.cpm-root') !== null,
          dialogoArriba: Boolean(hit && hit.closest('[data-testid="pos-open-caja-dialog"]')),
          dialogoDentro: d.top >= -1 && d.bottom <= window.innerHeight + 1 && d.left >= -1 && d.right <= window.innerWidth + 1,
        }
      })
      expect(Math.abs(capa.top)).toBeLessThanOrEqual(TOL)
      expect(Math.abs(capa.left)).toBeLessThanOrEqual(TOL)
      expect(Math.abs(capa.width - capa.vw)).toBeLessThanOrEqual(TOL)
      expect(Math.abs(capa.height - capa.vh)).toBeLessThanOrEqual(TOL)
      expect(capa.dentroDelPos, '«Abrir caja» vive dentro del POS (tokens --pos-*)').toBe(true)
      expect(capa.dialogoArriba, 'el diálogo debe quedar por encima del POS').toBe(true)
      expect(capa.dialogoDentro, 'el diálogo debe entrar en el viewport').toBe(true)
      expect(await sigueSiendoElMismo(), 'abrir «Abrir caja» desmontó el POS').toBe(true)

      // Cancelar: el POS es el mismo nodo.
      await page.getByTestId('pos-open-caja-cancel').click()
      await expect(dialogo).toHaveCount(0)
      expect(await sigueSiendoElMismo(), 'cerrar «Abrir caja» desmontó el POS').toBe(true)

      // Abrir la caja de verdad: vuelve al mismo POS, sin remontarlo.
      await page.getByTestId('pos-open-caja-button').click()
      await page.getByTestId('pos-open-caja-confirm').click()
      await expect(dialogo).toHaveCount(0)
      await expect(page.getByTestId('pos-caja-closed')).toHaveCount(0)
      expect(await sigueSiendoElMismo(), 'abrir la caja desmontó el POS').toBe(true)
      exigirContenido(await medirPos(page), 'después de abrir la caja')
    } finally {
      limpiarCajasDelTest()
      abrirCaja()
    }
  })
})
