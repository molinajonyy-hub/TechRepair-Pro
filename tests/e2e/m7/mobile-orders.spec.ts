// ============================================================================
// BETA-UX-1D — la orden en el celular, medida en el navegador.
//
//   npx playwright test --project=m7-local --grep @beta-ux-1d
//
// Los tests de componentes (`tests/components/betaUx1d*.test.*`) miden qué se
// renderiza y con qué datos. jsdom no aplica `index.css`, así que ahí la tabla y
// las tarjetas conviven. Acá se mide lo que sólo existe con el CSS servido:
//
//   · detalle de orden: UNA columna por debajo de 768 px, dos desde 768; nada
//     desborda ni queda recortado; una primaria de 44 px y las secundarias en un
//     menú que sigue abriendo la impresión, WhatsApp y la garantía;
//   · Órdenes y Clientes: tarjetas por debajo de 768 px y la tabla de siempre
//     desde 768; el menú de cada tarjeta mide 44×44;
//   · estados vacíos fuera de la tabla, con su acción al alcance a 375 px;
//   · un EMPLEADO sin `orders_view_financials` no ve un solo importe en mobile,
//     y se comprueba que la restricción la decide el servidor.
//
// DATOS. Órdenes, clientes y comprobantes propios (`seedMobileOrdersFixture`),
// sembrados en la base local. Los estados vacíos se obtienen parcheando EN EL
// NAVEGADOR la respuesta real de la lista: se simula la ENTRADA de la pantalla;
// el layout y el CSS son los servidos.
// ============================================================================
import { test, expect } from './fixtures'
import type { Browser, Locator, Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { AA_SMALL_TEXT, applyTheme, contrastOf } from '../helpers/contrast'
import { consultarJSON } from '../setup/sqlLocal.ts'
import { E2E } from '../setup/seedE2E.ts'
import {
  MOBILE_ORDERS, MOBILE_ORDERS_TEXT,
  borrarPerfilEmpleado, limpiarMobileOrders, sembrarMobileOrders, sembrarPerfilEmpleado,
} from '../setup/seedMobileOrdersFixture.ts'

const TOUCH_TARGET = 44
/** Ruido float32 de la transformación de entrada; ver dialog-touch-actions.spec.ts. */
const TOUCH_EPSILON = 0.01
const TOL = 1

/** Capturas de evidencia: sólo a pedido, para no reescribir PNG versionados en cada corrida. */
const EVIDENCIA = process.env.BETA_UX_1D_EVIDENCE === '1' ? 'docs/beta-ux-1/evidence-1d' : null

const O = MOBILE_ORDERS.ordenes
const T = MOBILE_ORDERS_TEXT
const corto = (id: string) => id.slice(0, 8)

type Tema = 'light' | 'dark'

test.beforeAll(() => { sembrarMobileOrders() })
test.afterAll(() => { limpiarMobileOrders() })

// ─── Helpers ────────────────────────────────────────────────────────────────

async function abrir(page: Page, ruta: string, tema: Tema, ancho: number, alto: number, listo: Locator | string) {
  await applyTheme(page, tema)
  await page.setViewportSize({ width: ancho, height: alto })
  await page.goto(ruta)
  const señal = (typeof listo === 'string' ? page.getByTestId(listo) : listo).first()
  // Clientes carga UNA vez al montar y, si `auth.getUser()` falla en ese
  // instante, muestra un error con «Reintentar» en vez de la lista (preexistente,
  // fuera del alcance de 1D; medido ~1 de cada 60 cargas en local). Acá se mide
  // el layout: se reintenta una vez y se deja constancia en el reporte.
  const errorDeCarga = page.locator('.alert-inline.alert-error', { hasText: 'No hay una sesión activa' })
  await expect(señal.or(errorDeCarga).first()).toBeVisible({ timeout: 30_000 })
  if (await errorDeCarga.isVisible()) {
    test.info().annotations.push({ type: 'carga-reintentada', description: `${ruta}: «No hay una sesión activa» en la primera carga` })
    await page.getByRole('button', { name: 'Reintentar' }).click()
  }
  await expect(señal).toBeVisible({ timeout: 30_000 })
  await page.waitForLoadState('networkidle')
  // La entrada de la página termina (sin transform residual) antes de medir.
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))))
}

/** Espera a que terminen las animaciones de entrada: una caja a media escala mide de menos. */
const asentar = (page: Page) =>
  page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))))

const caja = async (l: Locator) => {
  const b = await l.boundingBox()
  if (!b) throw new Error('elemento sin caja')
  return b
}

/**
 * Desborde horizontal REAL de la pantalla.
 *
 * `#root` recorta lo que se le sale (`overflow-x: hidden`), así que mirar sólo
 * `documentElement.scrollWidth` daría verde con contenido cortado. Se mide
 * además el contenedor que recorta y se busca cualquier elemento que termine
 * fuera del viewport. Lo que vive dentro de un contenedor con scroll propio
 * (las pestañas, la tabla interna de ítems) no cuenta: scrollea a propósito.
 */
const desbordeHorizontal = (page: Page) => page.evaluate(() => {
  const exceso = (el: Element | null) => (el ? el.scrollWidth - el.clientWidth : 0)
  const ancho = document.documentElement.clientWidth
  let fuera = 0
  let culpable = ''
  for (const el of document.querySelectorAll('.main-layout-inner *')) {
    if (el.closest('.table-wrap, .tabs, [style*="overflow-x: auto"]')) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const e = Math.max(r.right - ancho, -r.left)
    if (e > fuera) { fuera = e; culpable = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}` }
  }
  const px = Math.max(exceso(document.documentElement), exceso(document.getElementById('root')), fuera)
  return { px, culpable }
})

/**
 * Contenido que una tarjeta está RECORTANDO a lo ancho. `.card` y las
 * superficies tienen `overflow: hidden`: lo que se les sale no desborda la
 * página (el chequeo de arriba no lo ve), simplemente desaparece.
 */
const recortes = (page: Page) => page.evaluate(() => {
  const out: string[] = []
  const contenedores = '.main-layout-inner .card, .main-layout-inner .compact-list__item, .main-layout-inner .surface-raised, .main-layout-inner .filter-bar'
  for (const cont of document.querySelectorAll<HTMLElement>(contenedores)) {
    const c = cont.getBoundingClientRect()
    if (c.width === 0) continue
    for (const el of cont.querySelectorAll<HTMLElement>('*')) {
      if (el.closest('.table-wrap, .tabs, [style*="overflow-x: auto"], .overflow-menu__popover, .sr-only')) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const exceso = Math.max(r.right - c.right, c.left - r.left)
      if (exceso > 1) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} «${(el.textContent || '').trim().slice(0, 24)}» +${Math.round(exceso)}px`)
    }
  }
  return out
})

async function sinDesborde(page: Page, donde: string) {
  const d = await desbordeHorizontal(page)
  expect(d.px, `${donde}: desborde horizontal de ${Math.round(d.px)}px (${d.culpable})`).toBeLessThanOrEqual(TOL)
  expect(await recortes(page), `${donde}: contenido recortado por su tarjeta`).toEqual([])
}

async function esTactil(l: Locator, nombre: string, { ancho = false } = {}) {
  const b = await caja(l)
  expect(b.height, `${nombre} mide ${b.height}px de alto`).toBeGreaterThanOrEqual(TOUCH_TARGET - TOUCH_EPSILON)
  if (ancho) expect(b.width, `${nombre} mide ${b.width}px de ancho`).toBeGreaterThanOrEqual(TOUCH_TARGET - TOUCH_EPSILON)
  return b
}

const columnas = (grilla: Locator) =>
  grilla.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length)

/**
 * Geometría de TODAS las tarjetas de una lista, en una sola evaluación.
 *
 * La lista de Clientes no pagina: en una base con cientos de clientes, recorrer
 * las tarjetas de a una desde Node (una ida y vuelta por medida) agota el
 * timeout del test sin que haya nada roto. Devuelve cuántas hay y las que
 * incumplen: las que se salen del viewport o desbordan, y las que tienen el
 * menú por debajo de 44×44.
 */
const medirTarjetas = (page: Page, item: string, accion: string) => page.evaluate(([i, a]) => {
  const ancho = document.documentElement.clientWidth
  const fuera: string[] = []
  const menuChico: string[] = []
  const tarjetas = [...document.querySelectorAll<HTMLElement>(`[data-testid="${i}"]`)]
  for (const el of tarjetas) {
    const r = el.getBoundingClientRect()
    const nombre = (el.textContent || '').trim().slice(0, 32)
    if (r.width === 0 || r.left < -1 || r.right > ancho + 1 || el.scrollWidth - el.clientWidth > 1) fuera.push(nombre)
    const d = el.querySelector(`[data-testid="${a}"]`)?.getBoundingClientRect()
    if (!d || d.width < 43.99 || d.height < 43.99) menuChico.push(`${nombre}: ${d ? `${d.width}×${d.height}` : 'sin menú'}`)
  }
  return { total: tarjetas.length, fuera, menuChico }
}, [item, accion])

/**
 * Tarjetas que muestran algo que un actor sin importes no debería ver, en una
 * sola evaluación: las que traen alguno de los `prohibidos` (por testid), las que
 * no traen el aviso `requerido` y las que tienen un `$` en su texto.
 */
const tarjetasConImporte = (page: Page, item: string, prohibidos: string[], requerido: string) => page.evaluate(([i, p, r]) => {
  const mal: string[] = []
  for (const el of document.querySelectorAll<HTMLElement>(`[data-testid="${i as string}"]`)) {
    const nombre = (el.textContent || '').trim().slice(0, 32)
    for (const testId of p as string[]) if (el.querySelector(`[data-testid="${testId}"]`)) mal.push(`${nombre}: trae ${testId}`)
    if (!el.querySelector(`[data-testid="${r as string}"]`)) mal.push(`${nombre}: falta ${r as string}`)
    if (/\$/.test(el.textContent || '')) mal.push(`${nombre}: muestra un símbolo de moneda`)
  }
  return mal
}, [item, prohibidos, requerido] as const)

async function capturar(page: Page, nombre: string, fullPage = false) {
  if (!EVIDENCIA) return
  await page.screenshot({ path: `${EVIDENCIA}/${nombre}.png`, fullPage, caret: 'initial' })
}

async function tokenDeSesion(page: Page): Promise<string> {
  const token = await page.evaluate(() => {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i) ?? ''
      if (!/^sb-.*-auth-token$/.test(k)) continue
      try { return (JSON.parse(window.localStorage.getItem(k) ?? '{}') as { access_token?: string }).access_token ?? null } catch { return null }
    }
    return null
  })
  if (!token) throw new Error('No se encontró la sesión de Supabase en la página.')
  return token
}

const tarjetaDeOrden = (page: Page, id: string) =>
  page.getByTestId('orders-mobile-item').filter({ hasText: `#${corto(id)}` })
const tarjetaDeCliente = (page: Page, nombre: string) =>
  page.getByTestId('customers-mobile-item').filter({ hasText: nombre })

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1d Detalle de orden · mobile', () => {
  for (const tema of ['light', 'dark'] as const) {
    test(`375×812 · ${tema} · una columna, sin desborde, textos largos envueltos`, async ({ page }) => {
      await abrir(page, `/orders/${O.parcial}`, tema, 375, 812, 'order-detail-grid')
      await expect(page.getByTestId('order-financial-summary')).toBeVisible({ timeout: 15_000 })
      await sinDesborde(page, 'detalle a 375')

      // ── La grilla principal es UNA columna ───────────────────────────────
      const grilla = page.getByTestId('order-detail-grid')
      expect(await columnas(grilla), 'la grilla del detalle no es de una columna').toBe(1)
      const g = await caja(grilla)

      // ── Cliente a todo el ancho; Dispositivo DEBAJO, también a todo el ancho ─
      const cliente = await caja(page.getByTestId('order-customer-card'))
      const equipo = await caja(page.getByTestId('order-device-card'))
      expect(Math.abs(cliente.width - g.width), 'Cliente no usa el ancho de la grilla').toBeLessThanOrEqual(TOL)
      expect(Math.abs(equipo.width - g.width), 'Dispositivo no usa el ancho de la grilla').toBeLessThanOrEqual(TOL)
      expect(equipo.y, 'Dispositivo no quedó debajo de Cliente').toBeGreaterThanOrEqual(cliente.y + cliente.height - TOL)
      expect(Math.abs(equipo.x - cliente.x)).toBeLessThanOrEqual(TOL)

      // ── El modelo largo envuelve dentro de su tarjeta ────────────────────
      const modelo = page.getByTestId('order-device-model')
      await expect(modelo).toHaveText(T.modeloLargo)
      const m = await caja(modelo)
      expect(m.x + m.width, 'el modelo se sale de la tarjeta').toBeLessThanOrEqual(equipo.x + equipo.width + TOL)
      expect(await modelo.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(TOL)
      // A <=480 Marca y Modelo se apilan: el modelo tiene toda la fila.
      const marca = await caja(page.getByTestId('order-device-card').locator('.order-device-grid > div').first())
      expect(m.y, 'Marca y Modelo no se apilaron').toBeGreaterThanOrEqual(marca.y + marca.height - TOL)

      // ── Acceso del equipo, Comprobante, Ítems y Estado financiero: ancho completo ─
      const acceso = page.locator('.order-detail-grid > .card', { hasText: 'Acceso del equipo' })
      for (const [nombre, bloque] of [
        ['Acceso del equipo', acceso],
        ['Comprobante', page.getByTestId('order-comprobante-card')],
        ['Ítems de la orden', page.getByTestId('order-items-block')],
        ['Estado financiero', page.getByTestId('order-financial-block')],
      ] as const) {
        const b = await caja(bloque)
        expect(Math.abs(b.width - g.width), `${nombre} no usa el ancho de la grilla`).toBeLessThanOrEqual(TOL)
        expect(b.x + b.width).toBeLessThanOrEqual(375 + TOL)
      }
      // Mismo orden semántico que en escritorio.
      const ys: number[] = []
      for (const bloque of [page.getByTestId('order-customer-card'), page.getByTestId('order-device-card'), acceso,
        page.getByTestId('order-comprobante-card'), page.getByTestId('order-items-block'), page.getByTestId('order-financial-block')]) {
        ys.push((await caja(bloque)).y)
      }
      expect(ys, 'los bloques cambiaron de orden').toEqual([...ys].sort((a, b) => a - b))

      // ── Nada desaparece en este tema: los textos principales se leen ─────
      for (const [que, l] of [
        ['nombre del cliente', page.getByTestId('order-customer-card').locator('.card-body > p').first()],
        ['modelo', modelo],
      ] as const) {
        const c = await contrastOf(l)
        expect(c.ratio, `${que}: ${c.foreground} sobre ${c.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      }

      await capturar(page, `order-detail-375-${tema}`, true)
    })
  }

  test('375×812 · un modelo sin espacios se parte en vez de ensanchar la tarjeta', async ({ page }) => {
    await abrir(page, `/orders/${O.sinEspacios}`, 'light', 375, 812, 'order-detail-grid')
    await sinDesborde(page, 'detalle con modelo sin espacios')

    const modelo = page.getByTestId('order-device-model')
    await expect(modelo).toHaveText(T.modeloSinEspacios)
    const equipo = await caja(page.getByTestId('order-device-card'))
    const m = await caja(modelo)
    expect(m.x + m.width).toBeLessThanOrEqual(equipo.x + equipo.width + TOL)
    const lineas = await modelo.evaluate(el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)))
    expect(lineas, 'el modelo debería ocupar más de una línea').toBeGreaterThan(1)
  })

  test('375×812 · encabezado: una primaria de 44px y las secundarias en el menú', async ({ page }) => {
    await abrir(page, `/orders/${O.parcial}`, 'light', 375, 812, 'order-detail-grid')

    // ── Volver, título y estado ──────────────────────────────────────────
    const volver = page.getByRole('link', { name: 'Volver a Órdenes' })
    await esTactil(volver, '«Volver a Órdenes»')
    const titulo = page.getByRole('heading', { level: 1 })
    await expect(titulo).toHaveText(`Orden #${corto(O.parcial)}`)
    const t = await caja(titulo)
    expect(t.x + t.width, 'el título se sale').toBeLessThanOrEqual(375 + TOL)
    expect(await titulo.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(TOL)

    // ── La primaria: «Ver Comprobante» (esta orden ya tiene uno) ─────────
    const primaria = page.getByTestId('order-primary-action')
    await expect(primaria).toBeVisible()
    await expect(primaria).toHaveText(/Ver Comprobante/)
    const p = await esTactil(primaria, 'la acción principal')
    expect(p.x + p.width).toBeLessThanOrEqual(375 + TOL)

    // ── Las secundarias de escritorio no se ven; hay UN disparador ───────
    for (const oculto of [page.getByTestId('order-print-preview-button'), page.getByTestId('order-create-warranty-button'),
      page.getByRole('button', { name: 'WhatsApp', exact: true })]) {
      await expect(oculto).toBeHidden()
    }
    const menu = page.getByTestId('order-mobile-actions-menu')
    await expect(menu).toBeVisible()
    const d = await esTactil(menu, 'el menú de acciones', { ancho: true })
    // Primaria y menú comparten la fila y ocupan el ancho: no hay hilera de botones chicos.
    expect(Math.abs((d.y + d.height / 2) - (p.y + p.height / 2)), 'primaria y menú no están en la misma fila').toBeLessThanOrEqual(4)
    expect(p.width, 'la primaria no usa el ancho disponible').toBeGreaterThan(375 * 0.6)
    const visibles = await page.locator('.order-detail-header__actions').locator('button:visible, a:visible').count()
    expect(visibles, 'en el encabezado mobile sólo quedan la primaria y el menú').toBe(2)

    // ── Abrir y cerrar con click ─────────────────────────────────────────
    await menu.click()
    const popover = page.getByRole('menu', { name: 'Más acciones de la orden' })
    await expect(popover).toBeVisible()
    await expect(popover.getByRole('menuitem')).toHaveText([
      'Imprimir', 'WhatsApp: Orden recibida', 'WhatsApp: Presupuesto listo',
      'WhatsApp: Equipo listo para retirar', 'WhatsApp: Mensaje libre', 'Garantía',
    ])
    const pop = await caja(popover)
    expect(pop.x, 'el menú se sale por la izquierda').toBeGreaterThanOrEqual(-TOL)
    expect(pop.x + pop.width, 'el menú se sale por la derecha').toBeLessThanOrEqual(375 + TOL)
    for (const item of await popover.getByRole('menuitem').all()) {
      await esTactil(item, `«${await item.textContent()}»`)
      const c = await contrastOf(item)
      expect(c.ratio, `${await item.textContent()}: ${c.foreground} sobre ${c.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
    }
    await capturar(page, 'order-detail-menu-375-light')
    await menu.click()
    await expect(popover).toBeHidden()

    // ── Escape lo cierra y devuelve el foco al disparador ────────────────
    await menu.click()
    await expect(popover).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden()
    await expect(menu).toBeFocused()
    await expect(menu).toHaveAttribute('aria-expanded', 'false')

    // ── Tocar afuera también lo cierra ───────────────────────────────────
    await menu.click()
    await expect(popover).toBeVisible()
    await titulo.click()
    await expect(popover).toBeHidden()
  })

  test('375×812 · desde el menú: Imprimir, WhatsApp y Garantía abren lo mismo que en escritorio', async ({ page }) => {
    await abrir(page, `/orders/${O.parcial}`, 'light', 375, 812, 'order-detail-grid')
    const menu = page.getByTestId('order-mobile-actions-menu')

    // ── Imprimir → la vista previa de la orden ───────────────────────────
    await menu.click()
    await page.getByRole('menuitem', { name: 'Imprimir' }).click()
    const vistaPrevia = page.getByRole('heading', { name: 'Vista previa — Orden de Servicio' })
    await expect(vistaPrevia).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Cerrar', exact: true }).last().click()
    await expect(vistaPrevia).toBeHidden()

    // ── WhatsApp → el preview, con la plantilla elegida ya resuelta ──────
    await menu.click()
    await page.getByRole('menuitem', { name: 'WhatsApp: Orden recibida' }).click()
    const preview = page.getByTestId('whatsapp-preview-modal')
    await expect(preview).toBeVisible({ timeout: 10_000 })
    const mensaje = preview.getByTestId('whatsapp-preview-textarea')
    await expect.poll(async () => (await mensaje.inputValue()).length).toBeGreaterThan(0)
    const texto = await mensaje.inputValue()
    expect(texto, 'el mensaje no es el de la orden').toContain('Samsung')
    expect(texto).toContain(corto(O.parcial).toUpperCase())
    await page.keyboard.press('Escape')
    await expect(preview).toBeHidden()

    // ── Garantía → el alta de garantía, con los datos de la orden ────────
    await menu.click()
    await page.getByRole('menuitem', { name: 'Garantía' }).click()
    const garantia = page.getByRole('heading', { name: 'Nueva garantía' })
    await expect(garantia).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(`input[value="${T.minorista}"]`).first()).toBeVisible()
  })

  test('375×812 · sin comprobante la primaria es «Generar Comprobante»', async ({ page }) => {
    await abrir(page, `/orders/${O.sinEquipo}`, 'light', 375, 812, 'order-detail-grid')
    await sinDesborde(page, 'detalle sin dispositivo')

    const primaria = page.getByTestId('order-primary-action')
    await expect(primaria).toHaveText(/Generar Comprobante/)
    await esTactil(primaria, '«Generar Comprobante»')
    await primaria.click({ trial: true })
    await expect(page.getByTestId('order-comprobante-card')).toHaveCount(0)
    await expect(page.getByTestId('order-device-card')).toContainText('No hay información del dispositivo')
  })

  test('320×700 · tampoco desborda y los controles siguen siendo tocables', async ({ page }) => {
    await abrir(page, `/orders/${O.parcial}`, 'light', 320, 700, 'order-detail-grid')
    await expect(page.getByTestId('order-financial-summary')).toBeVisible({ timeout: 15_000 })
    await sinDesborde(page, 'detalle a 320')
    expect(await columnas(page.getByTestId('order-detail-grid'))).toBe(1)

    await esTactil(page.getByRole('link', { name: 'Volver a Órdenes' }), '«Volver a Órdenes»')
    await esTactil(page.getByTestId('order-primary-action'), 'la acción principal')
    await esTactil(page.getByTestId('order-mobile-actions-menu'), 'el menú de acciones', { ancho: true })
    // Cambio de estado: no se tocó, sólo se verifica que siga entrando y siendo táctil.
    await esTactil(page.getByTestId('order-status-select'), 'el selector de estado')
    await esTactil(page.getByTestId('order-status-update-button'), 'el botón de cambio de estado')
    // Toda acción de las tarjetas del detalle.
    for (const boton of await page.locator('.order-detail-grid .btn:visible').all()) {
      await esTactil(boton, `«${(await boton.textContent())?.trim()}»`)
    }

    // El menú, con sus seis opciones, entra en 320 px.
    await page.getByTestId('order-mobile-actions-menu').click()
    const pop = await caja(page.getByRole('menu'))
    expect(pop.x).toBeGreaterThanOrEqual(-TOL)
    expect(pop.x + pop.width).toBeLessThanOrEqual(320 + TOL)
    await page.keyboard.press('Escape')

    // El modelo sin espacios, en el ancho más chico.
    await page.goto(`/orders/${O.sinEspacios}`)
    await expect(page.getByTestId('order-device-model')).toHaveText(T.modeloSinEspacios)
    await page.waitForLoadState('networkidle')
    await sinDesborde(page, 'detalle a 320 con modelo sin espacios')
  })

  for (const pestana of ['Notas', 'Documentos', 'Comunicación', 'Historial']) {
    test(`375×812 · la pestaña ${pestana} ocupa el ancho y no desborda`, async ({ page }) => {
      await abrir(page, `/orders/${O.parcial}`, 'light', 375, 812, 'order-detail-grid')
      await page.getByRole('button', { name: pestana, exact: true }).click()
      await page.waitForLoadState('networkidle')
      const grilla = page.getByTestId('order-detail-grid')
      const g = await caja(grilla)
      const bloque = grilla.locator('> *').first()
      await expect(bloque).toBeVisible()
      expect(Math.abs((await caja(bloque)).width - g.width), `${pestana} no usa el ancho de la grilla`).toBeLessThanOrEqual(TOL)
      await sinDesborde(page, `pestaña ${pestana}`)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1d Detalle de orden · escritorio no cambia', () => {
  for (const [ancho, alto] of [[1024, 768], [1440, 900]] as const) {
    test(`${ancho}px · dos columnas y las acciones a la vista`, async ({ page }) => {
      await abrir(page, `/orders/${O.parcial}`, 'light', ancho, alto, 'order-detail-grid')
      await expect(page.getByTestId('order-financial-summary')).toBeVisible({ timeout: 15_000 })

      const grilla = page.getByTestId('order-detail-grid')
      expect(await columnas(grilla), 'el detalle dejó de ser de dos columnas').toBe(2)
      const g = await caja(grilla)
      const cliente = await caja(page.getByTestId('order-customer-card'))
      const equipo = await caja(page.getByTestId('order-device-card'))
      // Lado a lado, misma fila, mitades iguales.
      expect(Math.abs(cliente.y - equipo.y)).toBeLessThanOrEqual(TOL)
      expect(equipo.x).toBeGreaterThanOrEqual(cliente.x + cliente.width)
      expect(Math.abs(cliente.width - equipo.width)).toBeLessThanOrEqual(TOL)
      // Marca y Modelo, lado a lado.
      const celdas = page.getByTestId('order-device-card').locator('.order-device-grid > div')
      expect(Math.abs((await caja(celdas.nth(0))).y - (await caja(celdas.nth(1))).y)).toBeLessThanOrEqual(TOL)
      // Los bloques grandes cruzan las dos columnas.
      for (const testId of ['order-comprobante-card', 'order-items-block', 'order-financial-block']) {
        expect(Math.abs((await caja(page.getByTestId(testId))).width - g.width), `${testId} no cruza las dos columnas`).toBeLessThanOrEqual(TOL)
      }

      // Acciones de escritorio visibles, en su orden; el menú de mobile no existe a la vista.
      const acciones = page.locator('.order-detail-header__actions')
      await expect(acciones.locator('.btn:visible')).toHaveText([
        /Ver Comprobante/, /Imprimir/, /WhatsApp/, /Garantía/,
      ])
      await expect(page.getByTestId('order-mobile-actions-menu')).toBeHidden()
      // Todas en UNA fila, como antes.
      const filas = new Set<number>()
      for (const boton of await acciones.locator('.btn:visible').all()) filas.add(Math.round((await caja(boton)).y))
      expect(filas.size, 'las acciones del encabezado se partieron en más de una fila').toBe(1)

      // El desplegable de WhatsApp de escritorio sigue funcionando.
      await page.getByRole('button', { name: 'WhatsApp', exact: true }).click()
      await page.getByTestId('order-whatsapp-quote').click()
      await expect(page.getByTestId('whatsapp-preview-modal')).toBeVisible({ timeout: 10_000 })

      if (ancho === 1440) await capturar(page, 'order-detail-1440-light', true)
    })
  }

  test('el corte es 768px: 767 una columna y menú, 768 dos columnas y botones', async ({ page }) => {
    await abrir(page, `/orders/${O.parcial}`, 'light', 767, 900, 'order-detail-grid')
    expect(await columnas(page.getByTestId('order-detail-grid'))).toBe(1)
    await expect(page.getByTestId('order-mobile-actions-menu')).toBeVisible()
    await expect(page.getByTestId('order-print-preview-button')).toBeHidden()
    await sinDesborde(page, 'detalle a 767')

    await page.setViewportSize({ width: 768, height: 900 })
    await expect(page.getByTestId('order-mobile-actions-menu')).toBeHidden()
    await expect(page.getByTestId('order-print-preview-button')).toBeVisible()
    expect(await columnas(page.getByTestId('order-detail-grid'))).toBe(2)
    await sinDesborde(page, 'detalle a 768')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1d Órdenes · lista mobile', () => {
  for (const tema of ['light', 'dark'] as const) {
    test(`375×812 · ${tema} · tarjetas en vez de tabla, sin desborde`, async ({ page }) => {
      await abrir(page, '/orders', tema, 375, 812, 'orders-mobile-list')
      await expect(tarjetaDeOrden(page, O.parcial).getByTestId('orders-mobile-total')).toBeVisible({ timeout: 15_000 })

      await expect(page.getByTestId('orders-desktop-table')).toBeHidden()
      await expect(page.getByTestId('orders-mobile-list')).toBeVisible()
      await sinDesborde(page, 'Órdenes a 375')

      // ── Cada tarjeta entra completa, y su menú mide 44×44 ────────────────
      const medidas = await medirTarjetas(page, 'orders-mobile-item', 'orders-mobile-actions')
      expect(medidas.total).toBeGreaterThanOrEqual(4)
      expect(medidas.fuera, 'tarjetas que se salen del viewport o desbordan').toEqual([])
      expect(medidas.menuChico, 'menús de tarjeta por debajo de 44×44').toEqual([])

      // ── Contenido: identifica la orden de un vistazo ─────────────────────
      const parcial = tarjetaDeOrden(page, O.parcial)
      await expect(parcial).toContainText(T.minorista)
      await expect(parcial).toContainText(`Samsung ${T.modeloLargo}`)
      await expect(parcial).toContainText('Prioridad urgente')
      await expect(parcial).toContainText('En Reparación')
      await expect(parcial.getByTestId('order-financial-badge')).toHaveAttribute('data-status', 'partial')
      await expect(parcial.getByTestId('orders-mobile-total')).toHaveText(`$${T.totalParcial}`)
      await expect(parcial.getByTestId('orders-mobile-balance')).toHaveText(`Saldo $${T.saldoParcial}`)

      const cobrada = tarjetaDeOrden(page, O.cobrada)
      await expect(cobrada).toContainText(T.mayorista)
      await expect(cobrada).toContainText('Listo para Entregar')
      await expect(cobrada.getByTestId('order-financial-badge')).toHaveAttribute('data-status', 'paid')
      await expect(cobrada.getByTestId('orders-mobile-total')).toHaveText(`$${T.totalCobrada}`)
      await expect(cobrada.getByTestId('orders-mobile-balance')).toHaveCount(0)
      await expect(cobrada).not.toContainText(/prioridad/i)

      const sinEquipo = tarjetaDeOrden(page, O.sinEquipo)
      await expect(sinEquipo).toContainText('Sin dispositivo')
      await expect(sinEquipo.getByTestId('order-financial-badge')).toHaveAttribute('data-status', 'sin_facturar')

      // El modelo sin espacios envuelve dentro de la tarjeta.
      await expect(tarjetaDeOrden(page, O.sinEspacios)).toContainText(T.modeloSinEspacios)

      // ── Se leen y se distinguen del fondo en este tema ───────────────────
      for (const [que, l] of [
        ['cliente', parcial.locator('.order-card__title > span').first()],
        ['equipo', parcial.locator('.compact-list__secondary')],
        ['total', parcial.getByTestId('orders-mobile-total')],
      ] as const) {
        const c = await contrastOf(l)
        expect(c.ratio, `${que}: ${c.foreground} sobre ${c.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      }
      const borde = await parcial.evaluate(el => parseFloat(getComputedStyle(el).borderTopWidth))
      expect(borde, 'la tarjeta no tiene borde que la separe').toBeGreaterThanOrEqual(1)

      // ── El menú no pisa los textos ───────────────────────────────────────
      const dMenu = await esTactil(parcial.getByTestId('orders-mobile-actions'), 'el menú de la tarjeta', { ancho: true })
      const dTitulo = await caja(parcial.locator('.order-card__title > span').first())
      expect(dTitulo.x + dTitulo.width, 'el nombre queda debajo del menú').toBeLessThanOrEqual(dMenu.x + TOL)

      // ── Filtros: búsqueda de lado a lado; nada se sale ───────────────────
      const barra = await caja(page.getByTestId('orders-filter-bar'))
      const busqueda = await caja(page.getByTestId('orders-search-input'))
      expect(busqueda.width, 'la búsqueda no usa el ancho de la barra').toBeGreaterThanOrEqual(barra.width - 40)
      for (const testId of ['orders-status-filter', 'orders-payment-filter', 'orders-priority-filter']) {
        const f = await caja(page.getByTestId(testId))
        expect(f.x).toBeGreaterThanOrEqual(barra.x - TOL)
        expect(f.x + f.width, `${testId} se sale de la barra`).toBeLessThanOrEqual(barra.x + barra.width + TOL)
        expect(f.height).toBeGreaterThanOrEqual(TOUCH_TARGET - TOUCH_EPSILON)
      }
      // Estado y cobro comparten fila; la barra no es una columna de cuatro pisos.
      const estado = await caja(page.getByTestId('orders-status-filter'))
      const cobro = await caja(page.getByTestId('orders-payment-filter'))
      expect(Math.abs(estado.y - cobro.y), 'los filtros no se acomodaron de a dos').toBeLessThanOrEqual(TOL)

      // ── «Nueva Orden»: la única primaria, de 44px ────────────────────────
      const nueva = page.getByTestId('orders-new-button')
      await expect(nueva).toBeVisible()
      await esTactil(nueva, '«Nueva Orden»')
      expect((await caja(nueva)).width).toBeGreaterThan(375 * 0.8)

      if (tema === 'light') await capturar(page, 'orders-list-375-light', true)
      else await capturar(page, 'orders-list-375-dark', true)
    })
  }

  test('375×812 · tocar la tarjeta abre el detalle (también con teclado)', async ({ page }) => {
    await abrir(page, '/orders', 'light', 375, 812, 'orders-mobile-list')
    const zona = tarjetaDeOrden(page, O.cobrada).getByRole('link')
    await expect(zona).toHaveAccessibleName(`Abrir la orden #${corto(O.cobrada)} de ${T.mayorista}`)
    await zona.click()
    await expect(page).toHaveURL(new RegExp(`/orders/${O.cobrada}$`))
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Orden #${corto(O.cobrada)}`)

    await page.goBack()
    await expect(page.getByTestId('orders-mobile-list')).toBeVisible({ timeout: 15_000 })
    await tarjetaDeOrden(page, O.parcial).getByRole('link').focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/orders/${O.parcial}$`))
  })

  test('375×812 · el menú imprime la orden y pide confirmación antes de eliminar', async ({ page }) => {
    // La impresión abre una ventana nueva y le escribe el documento: se captura
    // lo que se le escribe en vez de abrirla.
    await page.addInitScript(() => {
      const w = window as unknown as { __PRINT__: string[] }
      w.__PRINT__ = []
      window.open = (() => ({
        document: { write: (html: string) => { w.__PRINT__.push(html) }, close: () => undefined },
        focus: () => undefined, print: () => undefined, close: () => undefined,
      })) as unknown as typeof window.open
    })
    await abrir(page, '/orders', 'light', 375, 812, 'orders-mobile-list')
    const disparador = tarjetaDeOrden(page, O.cobrada).getByTestId('orders-mobile-actions')

    // ── Menú: sólo lo que agrega algo; ítems táctiles ────────────────────
    await disparador.click()
    const menu = page.getByRole('menu', { name: `Acciones de la orden #${corto(O.cobrada)}` })
    await expect(menu.getByRole('menuitem')).toHaveText(['Imprimir', 'Eliminar'])
    for (const item of await menu.getByRole('menuitem').all()) await esTactil(item, `«${await item.textContent()}»`)
    const pop = await caja(menu)
    expect(pop.x).toBeGreaterThanOrEqual(-TOL)
    expect(pop.x + pop.width).toBeLessThanOrEqual(375 + TOL)
    await capturar(page, 'orders-card-menu-375-light')
    // Abrir el menú no navegó.
    await expect(page).toHaveURL(/\/orders$/)

    // ── Imprimir ─────────────────────────────────────────────────────────
    await menu.getByRole('menuitem', { name: 'Imprimir' }).click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __PRINT__: string[] }).__PRINT__.length), { timeout: 10_000 }).toBe(1)
    const documento = await page.evaluate(() => (window as unknown as { __PRINT__: string[] }).__PRINT__[0])
    expect(documento, 'el documento impreso no es el de la orden').toContain(T.mayorista)
    expect(documento).toContain('iPhone 13')
    await expect(page.getByTestId('order-print-hidden-root')).toHaveCount(0)

    // ── Eliminar → la confirmación de siempre; cancelar no borra ─────────
    await tarjetaDeOrden(page, O.sinEquipo).getByTestId('orders-mobile-actions').click()
    await page.getByRole('menuitem', { name: 'Eliminar' }).click()
    const confirmacion = page.locator('.modal-card', { hasText: 'Eliminar Orden' })
    await expect(confirmacion).toBeVisible()
    await expect(confirmacion).toContainText(`#${corto(O.sinEquipo)}`)
    await expect(confirmacion).toContainText('Esta acción no se puede deshacer.')
    await expect(page.locator('.modal-card')).toHaveCount(1)
    await asentar(page)
    const c = await caja(confirmacion)
    expect(c.x).toBeGreaterThanOrEqual(-TOL)
    expect(c.x + c.width).toBeLessThanOrEqual(375 + TOL)
    // Cancelar y Eliminar, uno al lado del otro: los dos táctiles.
    await esTactil(confirmacion.getByRole('button', { name: 'Cancelar' }), '«Cancelar» de la confirmación')
    await esTactil(confirmacion.getByRole('button', { name: /Eliminar/ }), '«Eliminar» de la confirmación')
    await confirmacion.getByRole('button', { name: 'Cancelar' }).click()
    await expect(confirmacion).toBeHidden()
    expect(consultarJSON<{ n: number }>(`SELECT count(*)::int AS n FROM public.orders WHERE id = '${O.sinEquipo}'`).n).toBe(1)
  })

  test('375×812 · el menú de una tarjeta pegada a la barra inferior queda entero a la vista', async ({ page }) => {
    await abrir(page, '/orders', 'light', 375, 812, 'orders-mobile-list')
    const barra = await caja(page.getByTestId('mobile-bottom-nav'))
    const disparador = tarjetaDeOrden(page, O.sinEspacios).getByTestId('orders-mobile-actions')
    // Se deja el disparador justo encima de la barra de navegación: el menú abre
    // hacia abajo, así que sin correr la página sus acciones quedarían detrás.
    await disparador.evaluate((el, yBarra) => {
      window.scrollBy({ top: el.getBoundingClientRect().bottom - (yBarra - 12), behavior: 'instant' })
    }, barra.y)
    const d = await caja(disparador)
    expect(d.y + d.height, 'el disparador debería quedar a la vista').toBeLessThanOrEqual(barra.y)
    expect(d.y + d.height + 100, 'precondición: sin correr, el menú cruzaría la barra').toBeGreaterThan(barra.y)

    await disparador.click()
    const eliminar = page.getByRole('menuitem', { name: 'Eliminar' })
    await expect(eliminar).toBeVisible()
    await expect.poll(async () => { const b = await caja(eliminar); return b.y + b.height }, {
      message: '«Eliminar» quedó detrás de la barra de navegación', timeout: 5_000,
    }).toBeLessThanOrEqual(barra.y)
    // Se puede tocar: nada lo tapa.
    await eliminar.click({ trial: true })
    await expect(page.getByRole('menuitem', { name: 'Imprimir' })).toBeInViewport({ ratio: 1 })
  })

  test('320×700 · las tarjetas tampoco desbordan', async ({ page }) => {
    await abrir(page, '/orders', 'light', 320, 700, 'orders-mobile-list')
    await expect(tarjetaDeOrden(page, O.parcial).getByTestId('orders-mobile-total')).toBeVisible({ timeout: 15_000 })
    await sinDesborde(page, 'Órdenes a 320')
    const medidas = await medirTarjetas(page, 'orders-mobile-item', 'orders-mobile-actions')
    expect(medidas.total).toBeGreaterThanOrEqual(4)
    expect(medidas.fuera, 'tarjetas que se salen del viewport o desbordan').toEqual([])
    expect(medidas.menuChico, 'menús de tarjeta por debajo de 44×44').toEqual([])
    await esTactil(page.getByTestId('orders-new-button'), '«Nueva Orden»')
  })

  test('escritorio: la tabla de siempre, con sus nueve columnas y sus acciones', async ({ page }) => {
    await abrir(page, '/orders', 'light', 1440, 900, 'orders-desktop-table')
    await expect(page.getByTestId('orders-mobile-list')).toBeHidden()
    const tabla = page.getByTestId('orders-desktop-table')
    await expect(tabla.getByRole('columnheader')).toHaveText([
      'Orden', 'Cliente', 'Dispositivo', 'Estado', 'Cobro', 'Prioridad', 'Total', 'Fecha', 'Acciones',
    ])
    const fila = tabla.getByRole('row').filter({ hasText: `#${corto(O.parcial)}` })
    await expect(fila).toContainText(T.minorista)
    await expect(fila).toContainText(`$${T.totalParcial}`)
    await expect(fila).toContainText(`Saldo $${T.saldoParcial}`)
    await expect(fila.getByTestId('order-financial-badge')).toHaveAttribute('data-status', 'partial')
    // Las cuatro acciones, incluida «Editar».
    await expect(fila.getByTestId('order-print-button')).toBeVisible()
    for (const titulo of ['Ver detalle', 'Editar', 'Eliminar']) await expect(fila.getByTitle(titulo)).toBeVisible()
    await expect(fila.locator('td').last().locator('button, a')).toHaveCount(4)
    // Los filtros siguen siendo una barra flexible, no la grilla de mobile.
    expect(await page.getByTestId('orders-filter-bar').evaluate(el => getComputedStyle(el).display)).toBe('flex')
    await expect(page.getByTestId('orders-new-button')).toBeVisible()
    await capturar(page, 'orders-desktop-1440')
  })

  test('el corte es 768px: 767 tarjetas, 768 tabla', async ({ page }) => {
    await abrir(page, '/orders', 'light', 767, 900, 'orders-mobile-list')
    await expect(page.getByTestId('orders-desktop-table')).toBeHidden()
    await sinDesborde(page, 'Órdenes a 767')
    await page.setViewportSize({ width: 768, height: 900 })
    await expect(page.getByTestId('orders-desktop-table')).toBeVisible()
    await expect(page.getByTestId('orders-mobile-list')).toBeHidden()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1d Clientes · lista mobile y encabezado', () => {
  for (const tema of ['light', 'dark'] as const) {
    test(`375×812 · ${tema} · tarjetas en vez de tabla, una primaria y un menú`, async ({ page }) => {
      await abrir(page, '/customers', tema, 375, 812, 'customers-mobile-list')
      await expect(tarjetaDeCliente(page, T.minorista).getByTestId('customers-mobile-total')).toBeVisible({ timeout: 15_000 })

      await expect(page.getByTestId('customers-desktop-table')).toBeHidden()
      await expect(page.getByTestId('customers-mobile-list')).toBeVisible()
      await sinDesborde(page, 'Clientes a 375')

      // ── Tarjetas ─────────────────────────────────────────────────────────
      const minorista = tarjetaDeCliente(page, T.minorista)
      await expect(minorista).toContainText('3515550101')
      await expect(minorista).toContainText('cliente.movil.uno@example.test')
      await expect(minorista).toContainText('2 órdenes')
      // 185.000 (estimado de la orden parcial) + 0 (orden sin importes).
      await expect(minorista.getByTestId('customers-mobile-total')).toContainText(T.totalParcial)
      await expect(minorista.getByText('MAYORISTA')).toHaveCount(0)

      const mayorista = tarjetaDeCliente(page, T.mayorista)
      await expect(mayorista.getByText('MAYORISTA', { exact: true })).toBeVisible()
      await expect(mayorista).toContainText('1 orden')
      // El email largo envuelve dentro de la tarjeta (lo cubre `sinDesborde`), entero.
      await expect(mayorista).toContainText(T.emailLargo)

      const sinContacto = tarjetaDeCliente(page, T.sinContacto)
      await expect(sinContacto).toContainText('Sin datos de contacto')

      // Todas las tarjetas (la lista no pagina: pueden ser cientos), de una vez.
      const medidas = await medirTarjetas(page, 'customers-mobile-item', 'customers-mobile-actions')
      expect(medidas.total).toBeGreaterThanOrEqual(3)
      expect(medidas.fuera, 'tarjetas que se salen del viewport o desbordan').toEqual([])
      expect(medidas.menuChico, 'menús de tarjeta por debajo de 44×44').toEqual([])
      for (const [que, l] of [
        ['nombre', minorista.locator('.customer-card__title > span').first()],
        ['contacto', minorista.locator('.customer-card__contact-row').first()],
        ['total', minorista.getByTestId('customers-mobile-total')],
      ] as const) {
        const c = await contrastOf(l)
        expect(c.ratio, `${que}: ${c.foreground} sobre ${c.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      }

      // ── Encabezado: sólo «Nuevo Cliente» + el menú ───────────────────────
      const nuevo = page.getByTestId('customers-new-button')
      await expect(nuevo).toBeVisible()
      const n = await esTactil(nuevo, '«Nuevo Cliente»')
      for (const nombre of ['Plantilla', 'Exportar', 'Importar']) {
        await expect(page.locator('.page-hdr-right').getByRole('button', { name: nombre, exact: true })).toBeHidden()
      }
      const masAcciones = page.getByTestId('customers-mobile-header-menu')
      const m = await esTactil(masAcciones, 'el menú del encabezado', { ancho: true })
      expect(Math.abs((m.y + m.height / 2) - (n.y + n.height / 2)), 'la primaria y el menú no están en la misma fila').toBeLessThanOrEqual(4)
      expect(await page.locator('.page-hdr-right').locator('button:visible, a:visible').count()).toBe(2)

      await masAcciones.click()
      const menu = page.getByRole('menu', { name: 'Más acciones de clientes' })
      await expect(menu.getByRole('menuitem')).toHaveText(['Plantilla', 'Exportar', 'Importar'])
      for (const item of await menu.getByRole('menuitem').all()) {
        await esTactil(item, `«${await item.textContent()}»`)
        const c = await contrastOf(item)
        expect(c.ratio, `${await item.textContent()}: ${c.foreground} sobre ${c.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      }
      const pop = await caja(menu)
      expect(pop.x).toBeGreaterThanOrEqual(-TOL)
      expect(pop.x + pop.width).toBeLessThanOrEqual(375 + TOL)
      if (tema === 'light') await capturar(page, 'customers-header-menu-375-light')
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
      await expect(masAcciones).toBeFocused()

      await capturar(page, `customers-list-375-${tema}`, true)
    })
  }

  test('375×812 · «Importar» del menú abre el importador de siempre', async ({ page }) => {
    await abrir(page, '/customers', 'light', 375, 812, 'customers-mobile-list')
    await page.getByTestId('customers-mobile-header-menu').click()
    await page.getByRole('menuitem', { name: 'Importar' }).click()
    await expect(page.getByRole('heading', { name: 'Importar Clientes' })).toBeVisible({ timeout: 10_000 })
  })

  test('375×812 · tocar la tarjeta abre la ficha; el menú edita y elimina con los flujos de siempre', async ({ page }) => {
    await abrir(page, '/customers', 'light', 375, 812, 'customers-mobile-list')
    const tarjeta = tarjetaDeCliente(page, T.sinContacto)
    const disparador = tarjeta.getByTestId('customers-mobile-actions')

    // ── Editar → el diálogo de edición de siempre ────────────────────────
    await disparador.click()
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['Editar', 'Eliminar'])
    await page.getByRole('menuitem', { name: 'Editar' }).click()
    const edicion = page.getByRole('dialog', { name: 'Editar Cliente' })
    await expect(edicion).toBeVisible()
    await expect(edicion.getByTestId('customer-edit-save-button')).toBeVisible()
    await expect(edicion.getByLabel('Nombre completo')).toHaveValue(T.sinContacto)
    await expect(page.getByRole('dialog', { name: 'Editar Cliente' })).toHaveCount(1)
    await edicion.getByRole('button', { name: 'Cancelar' }).click()
    await expect(edicion).toBeHidden()

    // ── Eliminar → la confirmación de siempre; cerrar no borra ───────────
    await disparador.click()
    await page.getByRole('menuitem', { name: 'Eliminar' }).click()
    const confirmacion = page.locator('.modal-card', { hasText: 'Eliminar cliente' })
    await expect(confirmacion).toBeVisible()
    await expect(confirmacion).toContainText(T.sinContacto)
    await expect(page.locator('.modal-card')).toHaveCount(1)
    await asentar(page)
    await esTactil(confirmacion.getByRole('button', { name: 'Cancelar' }), '«Cancelar» de la confirmación')
    await esTactil(confirmacion.getByRole('button', { name: /Sí, eliminar/ }), '«Sí, eliminar» de la confirmación')
    await confirmacion.getByRole('button', { name: 'Cancelar' }).click()
    await expect(confirmacion).toBeHidden()
    expect(consultarJSON<{ n: number }>(`SELECT count(*)::int AS n FROM public.customers WHERE id = '${MOBILE_ORDERS.clientes.sinContacto}'`).n).toBe(1)

    // ── La tarjeta entera abre la ficha ──────────────────────────────────
    const zona = tarjetaDeCliente(page, T.mayorista).getByRole('link')
    await expect(zona).toHaveAccessibleName(`Abrir la ficha de ${T.mayorista}`)
    await zona.click()
    await expect(page).toHaveURL(new RegExp(`/customers/${MOBILE_ORDERS.clientes.mayorista}$`))
  })

  test('320×700 · tampoco desborda', async ({ page }) => {
    await abrir(page, '/customers', 'light', 320, 700, 'customers-mobile-list')
    await expect(tarjetaDeCliente(page, T.mayorista)).toBeVisible()
    await sinDesborde(page, 'Clientes a 320')
    await esTactil(page.getByTestId('customers-new-button'), '«Nuevo Cliente»')
    await esTactil(page.getByTestId('customers-mobile-header-menu'), 'el menú del encabezado', { ancho: true })
  })

  test('escritorio: la tabla de siempre y los cuatro botones del encabezado', async ({ page }) => {
    await abrir(page, '/customers', 'light', 1440, 900, 'customers-desktop-table')
    await expect(page.getByTestId('customers-mobile-list')).toBeHidden()
    const tabla = page.getByTestId('customers-desktop-table')
    await expect(tabla.getByRole('columnheader')).toHaveText(['Cliente', 'Contacto', 'Órdenes', 'Total', 'Acciones'])
    const fila = tabla.getByRole('row').filter({ hasText: T.mayorista })
    await expect(fila.getByText('MAYORISTA', { exact: true })).toBeVisible()
    for (const titulo of ['Ver detalle', 'Editar cliente', 'Eliminar cliente']) await expect(fila.getByTitle(titulo)).toBeVisible()

    // Encabezado: las cuatro, en su orden y en una fila; el menú de mobile no se ve.
    const derecha = page.locator('.page-hdr-right')
    await expect(derecha.locator('button:visible, a:visible')).toHaveText([/Plantilla/, /Exportar/, /Importar/, /Nuevo Cliente/])
    await expect(page.getByTestId('customers-mobile-header-menu')).toBeHidden()
    const filas = new Set<number>()
    for (const boton of await derecha.locator('button:visible, a:visible').all()) filas.add(Math.round((await caja(boton)).y))
    expect(filas.size, 'los botones del encabezado se partieron en más de una fila').toBe(1)
  })

  test('el corte es 768px: 767 tarjetas y menú, 768 tabla y botones', async ({ page }) => {
    await abrir(page, '/customers', 'light', 767, 900, 'customers-mobile-list')
    await expect(page.getByTestId('customers-desktop-table')).toBeHidden()
    await expect(page.getByTestId('customers-mobile-header-menu')).toBeVisible()
    await sinDesborde(page, 'Clientes a 767')
    await page.setViewportSize({ width: 768, height: 900 })
    await expect(page.getByTestId('customers-desktop-table')).toBeVisible()
    await expect(page.getByTestId('customers-mobile-list')).toBeHidden()
    await expect(page.getByTestId('customers-mobile-header-menu')).toBeHidden()
    await expect(page.locator('.page-hdr-right').getByRole('button', { name: 'Plantilla', exact: true })).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1d Estados vacíos · fuera de la tabla', () => {
  /** Parchea en el navegador la respuesta REAL de una lista para que llegue vacía. */
  async function listaVacia(page: Page, tabla: 'orders' | 'customers') {
    await page.route(`**/rest/v1/${tabla}?**`, async (route) => {
      const metodo = route.request().method()
      if (metodo !== 'GET' && metodo !== 'HEAD') return route.fallback()
      const response = await route.fetch()
      if (metodo === 'HEAD') return route.fulfill({ response, headers: { ...response.headers(), 'content-range': '*/0' } })
      await route.fulfill({ response, json: [], headers: { ...response.headers(), 'content-range': '*/0' } })
    })
  }

  test('375×812 · Órdenes sin datos: no hay tabla vacía y «Nueva Orden» queda al alcance', async ({ page }) => {
    await listaVacia(page, 'orders')
    await abrir(page, '/orders', 'light', 375, 812, 'orders-empty-state')

    const vacio = page.getByTestId('orders-empty-state')
    await expect(vacio).toHaveAttribute('data-empty-kind', 'no-data')
    await expect(vacio).toContainText('Todavía no tenés órdenes')
    // Ni tabla ni lista: no hay un contenedor vacío haciendo de marco del mensaje.
    await expect(page.locator('.main-layout-inner table')).toHaveCount(0)
    await expect(page.getByTestId('orders-desktop-table')).toHaveCount(0)
    await expect(page.getByTestId('orders-mobile-list')).toHaveCount(0)
    await sinDesborde(page, 'Órdenes vacío')

    const v = await caja(vacio)
    expect(v.x).toBeGreaterThanOrEqual(-TOL)
    expect(v.x + v.width).toBeLessThanOrEqual(375 + TOL)
    const cta = vacio.getByRole('button', { name: 'Nueva Orden' })
    await cta.scrollIntoViewIfNeeded()
    const b = await esTactil(cta, '«Nueva Orden» del estado vacío')
    expect(b.x).toBeGreaterThanOrEqual(-TOL)
    expect(b.x + b.width).toBeLessThanOrEqual(375 + TOL)
    await capturar(page, 'orders-empty-375')
    await cta.click()
    await expect(page).toHaveURL(/\/orders\/new$/)
  })

  test('375×812 · Órdenes con filtros sin resultados: «Limpiar filtros» limpia los cuatro', async ({ page }) => {
    await abrir(page, '/orders', 'light', 375, 812, 'orders-mobile-list')
    await expect(tarjetaDeOrden(page, O.parcial)).toBeVisible()

    await page.getByTestId('orders-status-filter').selectOption('repair')
    await page.getByTestId('orders-payment-filter').selectOption('partial')
    await page.getByTestId('orders-priority-filter').selectOption('urgent')
    // Con los tres filtros la orden parcial sigue: los filtros funcionan igual que antes.
    await expect(tarjetaDeOrden(page, O.parcial)).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('orders-search-input').fill('zzz ninguna orden coincide con esto')

    const vacio = page.getByTestId('orders-empty-state')
    await expect(vacio).toBeVisible({ timeout: 15_000 })
    await expect(vacio).toHaveAttribute('data-empty-kind', 'no-results')
    await expect(vacio).toContainText('Sin resultados')
    await expect(page.locator('.main-layout-inner table')).toHaveCount(0)
    await sinDesborde(page, 'Órdenes sin resultados')

    const limpiar = vacio.getByRole('button', { name: 'Limpiar filtros' })
    await esTactil(limpiar, '«Limpiar filtros»')
    await limpiar.click()
    await expect(page.getByTestId('orders-search-input')).toHaveValue('')
    await expect(page.getByTestId('orders-status-filter')).toHaveValue('')
    await expect(page.getByTestId('orders-payment-filter')).toHaveValue('')
    await expect(page.getByTestId('orders-priority-filter')).toHaveValue('')
    await expect(tarjetaDeOrden(page, O.sinEquipo)).toBeVisible({ timeout: 15_000 })
    await expect(vacio).toHaveCount(0)
  })

  test('375×812 · sólo con el filtro de cobro y sin coincidencias dice «Sin resultados»', async ({ page }) => {
    // El servidor filtra por cobro; se parchea su respuesta para que ninguna
    // orden coincida, sea cual sea el estado de la base en esta corrida.
    await page.route('**/rest/v1/v_order_payment_state?**', async (route) => {
      if (!route.request().url().includes('payment_status=eq.')) return route.fallback()
      const response = await route.fetch()
      await route.fulfill({ response, json: [] })
    })
    await abrir(page, '/orders', 'light', 375, 812, 'orders-mobile-list')
    await page.getByTestId('orders-payment-filter').selectOption('pending')

    const vacio = page.getByTestId('orders-empty-state')
    await expect(vacio).toBeVisible({ timeout: 15_000 })
    await expect(vacio).toHaveAttribute('data-empty-kind', 'no-results')
    await expect(vacio).not.toContainText('Todavía no tenés órdenes')
    await vacio.getByRole('button', { name: 'Limpiar filtros' }).click()
    await expect(page.getByTestId('orders-payment-filter')).toHaveValue('')
    await expect(page.getByTestId('orders-mobile-list')).toBeVisible({ timeout: 15_000 })
  })

  test('375×812 · Clientes sin datos: no hay tabla y «Nuevo Cliente» queda al alcance', async ({ page }) => {
    await listaVacia(page, 'customers')
    await abrir(page, '/customers', 'light', 375, 812, 'customers-empty-state')

    const vacio = page.getByTestId('customers-empty-state')
    await expect(vacio).toHaveAttribute('data-empty-kind', 'no-data')
    await expect(vacio).toContainText('Todavía no tenés clientes')
    await expect(page.locator('.main-layout-inner table')).toHaveCount(0)
    await expect(page.getByTestId('customers-mobile-list')).toHaveCount(0)
    await sinDesborde(page, 'Clientes vacío')

    const cta = vacio.getByRole('button', { name: 'Nuevo Cliente' })
    await cta.scrollIntoViewIfNeeded()
    await expect(cta).toBeVisible()
    const b = await esTactil(cta, '«Nuevo Cliente» del estado vacío')
    expect(b.x).toBeGreaterThanOrEqual(-TOL)
    expect(b.x + b.width).toBeLessThanOrEqual(375 + TOL)
    await capturar(page, 'customers-empty-375')
    await cta.click()
    await expect(page).toHaveURL(/\/customers\/new$/)
  })

  test('375×812 · Clientes sin coincidencias: «Limpiar búsqueda» vuelve a la lista', async ({ page }) => {
    await abrir(page, '/customers', 'light', 375, 812, 'customers-mobile-list')
    await page.getByTestId('customers-search-input').fill('zzz ningún cliente coincide')

    const vacio = page.getByTestId('customers-empty-state')
    await expect(vacio).toBeVisible({ timeout: 15_000 })
    await expect(vacio).toHaveAttribute('data-empty-kind', 'no-results')
    await expect(page.locator('.main-layout-inner table')).toHaveCount(0)
    await sinDesborde(page, 'Clientes sin resultados')
    const limpiar = vacio.getByRole('button', { name: 'Limpiar búsqueda' })
    await esTactil(limpiar, '«Limpiar búsqueda»')
    await limpiar.click()
    await expect(page.getByTestId('customers-search-input')).toHaveValue('')
    await expect(tarjetaDeCliente(page, T.minorista)).toBeVisible({ timeout: 15_000 })
  })

  test('1440px · el estado vacío de escritorio tampoco usa una tabla', async ({ page }) => {
    await listaVacia(page, 'orders')
    await abrir(page, '/orders', 'light', 1440, 900, 'orders-empty-state')
    await expect(page.locator('.main-layout-inner table')).toHaveCount(0)
    await expect(page.getByTestId('orders-empty-state').getByRole('button', { name: 'Nueva Orden' })).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Importes restringidos. El actor es un EMPLEADO real: usuario propio, perfil
// `sales` en el negocio E2E y la capacidad `orders_view_financials` apagada por
// override. No es el owner degradado (ver `sembrarPerfilEmpleado`).
// ═══════════════════════════════════════════════════════════════════════════
const EMPLEADO_STATE = 'tests/e2e/.auth/beta-ux-1d-empleado.json'

/** Cliente de servicio del stack LOCAL, sólo en Node y sólo para el usuario de Auth. */
const adminLocal = () => createClient(process.env.VITE_SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function prepararEmpleado(browser: Browser, baseURL: string): Promise<string> {
  const { email, password } = MOBILE_ORDERS.empleado
  const admin = adminLocal()
  const { data: existentes } = await admin.auth.admin.listUsers()
  let usuario = existentes?.users?.find(u => u.email === email) ?? null
  if (usuario) {
    await admin.auth.admin.updateUserById(usuario.id, { password, email_confirm: true })
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (error || !data.user) throw new Error(`No se pudo crear el empleado E2E: ${error?.message}`)
    usuario = data.user
  }
  sembrarPerfilEmpleado(usuario.id)

  // Login REAL por la pantalla, igual que el globalSetup: no se inyecta sesión.
  const contexto = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' })
  const pagina = await contexto.newPage()
  await pagina.goto('/login', { waitUntil: 'networkidle' })
  await pagina.getByTestId('login-email').fill(email)
  await pagina.getByTestId('login-password').fill(password)
  await pagina.getByTestId('login-submit').click()
  await pagina.waitForURL(u => !u.pathname.includes('/login'), { timeout: 20_000 })
  if (pagina.url().includes('/no-business')) throw new Error('El empleado E2E no resolvió su negocio.')
  await contexto.storageState({ path: EMPLEADO_STATE })
  await contexto.close()
  return usuario.id
}

test.describe('@beta-ux-1d Importes restringidos en mobile (SEC-08A)', () => {
  let empleadoId = ''

  test.beforeAll(async ({ browser }, testInfo) => {
    empleadoId = await prepararEmpleado(browser, String(testInfo.project.use.baseURL))
  })
  test.afterAll(async () => {
    if (!empleadoId) return
    borrarPerfilEmpleado(empleadoId)
    await adminLocal().auth.admin.deleteUser(empleadoId)
  })

  test.describe('como empleado sin `orders_view_financials`', () => {
    test.use({ storageState: EMPLEADO_STATE })

    /** Ningún importe: ni un `$`, ni un número con separador de miles. */
    async function sinImportes(l: Locator, donde: string) {
      const texto = (await l.innerText()).replace(/\s+/g, ' ')
      expect(texto, `${donde} muestra un símbolo de moneda`).not.toMatch(/\$/)
      expect(texto, `${donde} muestra un número con forma de importe`).not.toMatch(/\b\d{1,3}\.\d{3}\b/)
    }

    test('el SERVIDOR es quien niega los importes a este actor', async ({ page, request }) => {
      await abrir(page, '/orders', 'light', 375, 812, 'orders-mobile-list')
      const headers = {
        apikey: process.env.VITE_SUPABASE_ANON_KEY ?? '',
        Authorization: `Bearer ${await tokenDeSesion(page)}`,
        'x-techrepair-client-contract': '1',
      }
      const base = process.env.VITE_SUPABASE_URL
      const importes = await request.post(`${base}/rest/v1/rpc/get_order_financial_amounts`, {
        headers, data: { p_business_id: E2E.business, p_order_ids: Object.values(O) },
      })
      expect(importes.status()).toBe(200)
      expect(await importes.json()).toEqual({ ok: true, authorized: false, rows: [] })
      // El estado de cobro también es verdad financiera: cero filas, no 'sin_facturar' inventado.
      const estado = await request.get(`${base}/rest/v1/v_order_payment_state?select=order_id,payment_status&business_id=eq.${E2E.business}`, { headers })
      expect(estado.status()).toBe(200)
      expect(await estado.json()).toEqual([])
      // Y las columnas financieras de la orden no se pueden leer de la tabla.
      const cruda = await request.get(`${base}/rest/v1/orders?select=id,estimated_total&id=eq.${O.parcial}`, { headers })
      expect(cruda.status(), 'leer estimated_total de la tabla debería estar denegado').toBeGreaterThanOrEqual(400)
    })

    for (const [ancho, alto] of [[375, 812], [320, 700]] as const) {
      test(`${ancho}px · Órdenes: «Importes restringidos», ningún monto y ningún $0`, async ({ page }) => {
        await abrir(page, '/orders', 'light', ancho, alto, 'orders-mobile-list')
        const tarjetas = page.getByTestId('orders-mobile-item')
        await expect(tarjetaDeOrden(page, O.parcial).getByTestId('orders-mobile-amounts-restricted')).toBeVisible({ timeout: 15_000 })
        await page.waitForLoadState('networkidle')

        expect(await tarjetas.count()).toBeGreaterThanOrEqual(4)
        // Todas las tarjetas: ninguna trae total ni saldo, y todas dicen que está restringido.
        expect(
          await tarjetasConImporte(page, 'orders-mobile-item', ['orders-mobile-total', 'orders-mobile-balance'], 'orders-mobile-amounts-restricted'),
          'tarjetas de Órdenes que muestran un importe',
        ).toEqual([])
        await expect(tarjetaDeOrden(page, O.parcial).getByTestId('orders-mobile-amounts-restricted')).toHaveText('Importes restringidos')
        // Sin estado de cobro del servidor no se inventa uno: en ninguna tarjeta.
        const estados = await page.getByTestId('orders-mobile-list').getByTestId('order-financial-badge')
          .evaluateAll(badges => [...new Set(badges.map(b => b.getAttribute('data-status')))])
        expect(estados, 'estados de cobro mostrados sin la capacidad').toEqual(['unavailable'])
        // La lista entera, incluido lo que el CSS oculta: nada con forma de importe.
        await sinImportes(page.getByTestId('orders-mobile-list'), 'la lista mobile de Órdenes')
        const oculta = (await page.getByTestId('orders-desktop-table').textContent()) ?? ''
        expect(oculta, 'la tabla oculta trae un importe').not.toMatch(/\$|\b\d{1,3}\.\d{3}\b/)
        // Lo operativo sigue: la orden se identifica y se abre.
        await expect(tarjetaDeOrden(page, O.parcial)).toContainText(T.minorista)
        await expect(tarjetaDeOrden(page, O.parcial)).toContainText('En Reparación')
        await sinDesborde(page, `Órdenes restringido a ${ancho}`)
        if (ancho === 375) await capturar(page, 'orders-list-375-restricted', true)
      })
    }

    test('375px · Clientes: el total no se muestra; el conteo de órdenes sí', async ({ page }) => {
      await abrir(page, '/customers', 'light', 375, 812, 'customers-mobile-list')
      const minorista = tarjetaDeCliente(page, T.minorista)
      await expect(minorista).toContainText('2 órdenes', { timeout: 15_000 })
      await page.waitForLoadState('networkidle')

      // Todas las tarjetas (pueden ser cientos), en una evaluación.
      expect(
        await tarjetasConImporte(page, 'customers-mobile-item', ['customers-mobile-total'], 'customers-mobile-total-restricted'),
        'tarjetas de Clientes que muestran un total',
      ).toEqual([])
      await expect(minorista.getByTestId('customers-mobile-total-restricted')).toContainText('Importe restringido')
      // Ni un símbolo de moneda en toda la lista. (Acá no se busca «un número con
      // forma de importe»: los teléfonos y los nombres de los clientes traen dígitos.)
      expect(await page.getByTestId('customers-mobile-list').innerText(), 'la lista mobile de Clientes muestra un símbolo de moneda').not.toMatch(/\$/)
      const oculta = (await page.getByTestId('customers-desktop-table').textContent()) ?? ''
      expect(oculta, 'la tabla oculta trae un importe').not.toMatch(/\$/)
      await sinDesborde(page, 'Clientes restringido')
      await capturar(page, 'customers-list-375-restricted', true)
    })

    test('375px · detalle de orden: sin acción de facturar, con el menú, sin importes', async ({ page }) => {
      await abrir(page, `/orders/${O.sinEspacios}`, 'light', 375, 812, 'order-detail-grid')
      await expect(page.getByTestId('order-financial-summary')).toBeVisible({ timeout: 15_000 })
      await page.waitForLoadState('networkidle')

      // Sin importes no se puede facturar de verdad: no se ofrece.
      await expect(page.getByTestId('order-primary-action')).toHaveCount(0)
      const menu = page.getByTestId('order-mobile-actions-menu')
      await esTactil(menu, 'el menú de acciones', { ancho: true })
      // Solo, el menú queda a la derecha de su fila.
      const fila = await caja(page.locator('.order-detail-header__actions'))
      const m = await caja(menu)
      expect(Math.abs((m.x + m.width) - (fila.x + fila.width)), 'el menú no quedó alineado a la derecha').toBeLessThanOrEqual(TOL)
      await sinImportes(page.getByTestId('order-detail-grid'), 'el detalle de orden')
      await sinDesborde(page, 'detalle restringido')
    })
  })

  test('control positivo: el dueño SÍ recibe los importes por la misma ruta', async ({ page, request }) => {
    await abrir(page, '/orders', 'light', 375, 812, 'orders-mobile-list')
    const respuesta = await request.post(`${process.env.VITE_SUPABASE_URL}/rest/v1/rpc/get_order_financial_amounts`, {
      headers: {
        apikey: process.env.VITE_SUPABASE_ANON_KEY ?? '',
        Authorization: `Bearer ${await tokenDeSesion(page)}`,
        'x-techrepair-client-contract': '1',
      },
      data: { p_business_id: E2E.business, p_order_ids: [O.parcial] },
    })
    const cuerpo = await respuesta.json() as { authorized: boolean; rows: Array<{ estimated_total: number; saldo_pendiente: number }> }
    expect(cuerpo.authorized).toBe(true)
    expect(cuerpo.rows).toHaveLength(1)
    expect(Number(cuerpo.rows[0].estimated_total)).toBe(185000)
    expect(Number(cuerpo.rows[0].saldo_pendiente)).toBe(100000)
    // Y lo que muestra la tarjeta es exactamente eso.
    await expect(tarjetaDeOrden(page, O.parcial).getByTestId('orders-mobile-total')).toHaveText(`$${T.totalParcial}`)
    await expect(tarjetaDeOrden(page, O.parcial).getByTestId('orders-mobile-balance')).toHaveText(`Saldo $${T.saldoParcial}`)
  })
})
