// ============================================================================
// BETA-UX-1B — Abrir la caja sin salir del checkout, contra el stack REAL.
//
//   npx playwright test --project=m7-local --grep @beta-ux-1b
//
// Los tests de componentes (`tests/components/betaUx1b*.test.tsx`) miden la
// lógica con Supabase simulado. Acá no se simula nada: la app servida habla con
// el PostgREST local y `open_cash_session_atomic` corre de verdad. Se mide lo
// que jsdom no puede:
//
//   · GEOMETRÍA: a 390 px (y 320 px) el diálogo entra completo en el viewport,
//     cada control tiene área táctil >= 44 px y recibe el toque, los montos no
//     disparan el zoom de iOS (>= 16 px) y nada desborda a lo ancho;
//   · que al abrir la caja se vuelve al MISMO POS — misma URL, mismo carrito,
//     mismo pago, misma hoja de cobro — y que NO se emitió ningún comprobante;
//   · el estado final en base: una sola caja abierta, con los saldos tipeados;
//   · la carrera de verdad: otro actor abre la caja mientras el diálogo está a
//     la vista, el servidor responde «Ya hay una caja abierta» y el POS sigue;
//   · la autoridad de verdad: un actor sin `finance` no ve la acción, y si arma
//     el pedido a mano con su propio JWT el SERVIDOR responde 403 `FORBIDDEN`
//     sin abrir nada (con control positivo: el mismo pedido pasa con `finance`).
//
// La caja sembrada se cierra antes de cada test y se repone después, igual que
// el rol del perfil E2E: el resto de la suite m7 los necesita como los siembra
// el seed.
// ============================================================================
import { test, expect } from './fixtures'
import type { Locator, Page } from '@playwright/test'
import { GrabadorRPC } from './observability'
import { ejecutarSQL, consultarJSON } from '../setup/sqlLocal.ts'
import { E2E } from '../setup/seedE2E.ts'
import { cerrarCaja, abrirCaja } from '../setup/fixturesM7.ts'
import { sqlDeFixtureBusqueda } from '../setup/seedSearchFixture.ts'
import { sqlDeFixturePosMobile } from '../setup/seedPosMobileFixture.ts'

const TOUCH_TARGET = 44
/** Ruido float32 de la transformación de entrada; ver dialog-touch-actions.spec.ts. */
const TOUCH_EPSILON = 0.01
const TOL = 1
const PRODUCTO = 'Funda Silicone iPhone 15'
const METODOS = ['efectivo', 'transferencia', 'tarjeta', 'usd'] as const

const HOSTS_PROPIOS = new Set(['localhost', '127.0.0.1', '[::1]'])
const esDeNuestroStack = (url: string) => {
  try { return HOSTS_PROPIOS.has(new URL(url).hostname) } catch { return false }
}

interface EstadoCajas {
  abiertas: number
  abierta_id: string | null
  efectivo: string | null
  transferencia: string | null
  tarjeta: string | null
  usd: string | null
  cotizacion: string | null
  abierta_por: string | null
  comprobantes: number
  movimientos: number
}

/** Estado en base de lo único que este flujo puede tocar — y de lo que NO. */
function estadoEnBase(): EstadoCajas {
  return consultarJSON<EstadoCajas>(`
    SELECT
      (SELECT count(*)::int FROM public.cajas WHERE business_id='${E2E.business}' AND status='abierta') AS abiertas,
      c.id AS abierta_id,
      c.efectivo_inicial::text AS efectivo, c.transferencia_inicial::text AS transferencia,
      c.tarjeta_inicial::text AS tarjeta, c.usd_inicial::text AS usd,
      c.usd_cotizacion_apertura::text AS cotizacion, c.opened_by AS abierta_por,
      (SELECT count(*)::int FROM public.comprobantes WHERE business_id='${E2E.business}') AS comprobantes,
      (SELECT count(*)::int FROM public.financial_movements WHERE business_id='${E2E.business}') AS movimientos
    FROM (SELECT 1) uno
    LEFT JOIN public.cajas c ON c.business_id='${E2E.business}' AND c.status='abierta'`)
}

/** Borra la caja que abrió el test (nunca la sembrada) y sus requests. */
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

/**
 * Cambia el rol del perfil E2E. La capacidad `finance` —en el navegador y en el
 * servidor— se resuelve desde `profiles.role` + overrides, así que esto cambia
 * de verdad quién es el actor para los dos lados.
 */
function rolDelActor(role: 'owner' | 'sales'): void {
  ejecutarSQL(`
BEGIN;
SET LOCAL session_replication_role = 'replica';
UPDATE public.profiles SET role='${role}' WHERE id='${E2E.owner}';
COMMIT;`)
}

/** Access token de la sesión de la página (nunca se imprime ni se guarda). */
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

async function abrirPos(page: Page, tema: 'light' | 'dark') {
  await page.addInitScript((t) => {
    window.localStorage.setItem('techrepair_theme', t)
    window.localStorage.setItem('theme', t)
  }, tema)
  await page.goto('/comprobantes')
  const nuevo = page.locator('[data-testid="comprobantes-new-button"]')
  await expect(nuevo).toBeVisible({ timeout: 30_000 })
  await nuevo.click()
  await expect(page.locator('[data-testid="comprobante-product-search"]')).toBeVisible({ timeout: 15_000 })
}

/** Carga una venta con producto, observación y un pago parcial. */
async function armarVenta(page: Page, movil: boolean) {
  await page.locator('[data-testid="comprobante-product-search"]').fill(PRODUCTO)
  await expect(page.locator('[data-testid="comprobante-product-results"]')).toBeVisible({ timeout: 15_000 })
  await page.locator('[data-testid="comprobante-product-option"]').first().click()
  await expect(page.locator('[data-testid="comprobante-item-row-0"]')).toBeVisible({ timeout: 10_000 })
  await page.getByPlaceholder('Observaciones...').fill('Entregar con funda')

  if (movil) {
    await page.getByTestId('comprobante-mobile-checkout-open').click()
    await expect(page.getByTestId('comprobante-save-button')).toBeVisible()
  }
  await page.getByTestId('comprobante-payment-efectivo').click()
  await expect(page.getByTestId('comprobante-payment-chip')).toHaveCount(1)
  await page.getByTestId('comprobante-payment-amount').fill('5000')
}

/** Lo que el usuario cargó. Abrir la caja no puede cambiar nada de esto. */
async function fotoDeLaVenta(page: Page) {
  return page.evaluate(() => {
    const valores = (testId: string) =>
      Array.from(document.querySelectorAll<HTMLInputElement>(`[data-testid="${testId}"]`)).map(i => i.value)
    return {
      lineas: valores('comprobante-item-description'),
      cantidades: valores('comprobante-item-quantity'),
      precios: valores('comprobante-item-price'),
      pagos: valores('comprobante-payment-amount'),
      total: document.querySelector('[data-testid="comprobante-total"]')?.textContent ?? null,
      observaciones: (document.querySelector('textarea[placeholder="Observaciones..."]') as HTMLTextAreaElement | null)?.value ?? null,
      tipo: Array.from(document.querySelectorAll('[data-testid^="pos-tipo-"]'))
        .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.getAttribute('data-testid')),
    }
  })
}

async function esperarAnimaciones(locator: Locator): Promise<void> {
  await locator.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(a => a.finished.catch(() => undefined)))
  })
}

/** ¿El propio elemento recibe el toque arriba, al centro y abajo de su caja? */
async function recibeElToque(locator: Locator): Promise<boolean[]> {
  return locator.evaluate(el => {
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    return [r.top + 2, r.top + r.height / 2, r.bottom - 2].map(y => {
      const hit = document.elementFromPoint(x, y)
      return hit === el || Boolean(hit && el.contains(hit))
    })
  })
}

async function sinOverflowHorizontal(page: Page, cuando: string): Promise<void> {
  const d = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(d, `scroll horizontal ${cuando}`).toBeLessThanOrEqual(TOL)
}

/** Geometría del diálogo: entra entero, nada se sale, todo es tocable. */
async function medirDialogo(page: Page, vp: { width: number; height: number }, tactil: boolean) {
  const dialogo = page.getByTestId('pos-open-caja-dialog')
  await expect(dialogo).toBeVisible()
  await esperarAnimaciones(dialogo)

  const caja = await dialogo.boundingBox()
  expect(caja, 'el diálogo no tiene caja').not.toBeNull()
  expect(caja!.x, 'el diálogo arranca fuera del viewport').toBeGreaterThanOrEqual(-TOL)
  expect(caja!.y, 'el diálogo queda cortado arriba').toBeGreaterThanOrEqual(-TOL)
  expect(caja!.x + caja!.width, 'el diálogo se sale a lo ancho').toBeLessThanOrEqual(vp.width + TOL)
  expect(caja!.y + caja!.height, 'el diálogo se sale por abajo').toBeLessThanOrEqual(vp.height + TOL)

  // Ningún descendiente visible queda fuera del viewport ni recortado a lo ancho.
  const fuera = await dialogo.evaluate((el, w) =>
    Array.from(el.querySelectorAll<HTMLElement>('*')).filter(n => {
      const r = n.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && (r.left < -1 || r.right > w + 1)
    }).map(n => `${n.tagName}.${String(n.className).slice(0, 40)}`), vp.width)
  expect(fuera, `elementos del diálogo fuera del viewport: ${fuera.join(' | ')}`).toEqual([])

  // El cuerpo no necesita scroll horizontal y los botones de acción están a la vista.
  const cuerpo = await dialogo.locator('.cpm-caja-body').evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth }))
  expect(cuerpo.sw - cuerpo.cw, 'el cuerpo del diálogo scrollea a lo ancho').toBeLessThanOrEqual(TOL)

  for (const m of METODOS) {
    const input = page.getByTestId(`pos-open-caja-${m}`)
    const b = await input.boundingBox()
    expect(b, `${m} sin caja`).not.toBeNull()
    expect(b!.height + TOUCH_EPSILON, `alto táctil de ${m}: ${b!.height}px`).toBeGreaterThanOrEqual(TOUCH_TARGET)
    expect(b!.y + b!.height, `${m} queda bajo el borde inferior`).toBeLessThanOrEqual(vp.height + TOL)
    expect(await recibeElToque(input), `${m} no recibe el toque`).toEqual([true, true, true])
    if (tactil) {
      const fuente = await input.evaluate(el => parseFloat(getComputedStyle(el).fontSize))
      expect(fuente, `${m}: < 16px dispara el zoom de iOS`).toBeGreaterThanOrEqual(16)
    }
  }
  for (const id of ['pos-open-caja-confirm', 'pos-open-caja-cancel', 'pos-open-caja-close']) {
    const boton = page.getByTestId(id)
    const b = await boton.boundingBox()
    expect(b, `${id} sin caja`).not.toBeNull()
    expect(b!.height + TOUCH_EPSILON, `alto táctil de ${id}: ${b!.height}px`).toBeGreaterThanOrEqual(TOUCH_TARGET)
    expect(b!.width + TOUCH_EPSILON, `ancho táctil de ${id}: ${b!.width}px`).toBeGreaterThanOrEqual(TOUCH_TARGET)
    expect(b!.y + b!.height, `${id} queda fuera de la pantalla`).toBeLessThanOrEqual(vp.height + TOL)
    expect(await recibeElToque(boton), `${id} no recibe el toque`).toEqual([true, true, true])
  }
  return dialogo
}

test.describe.configure({ mode: 'serial' })

test.describe('@beta-ux-1b POS — abrir la caja sin perder el checkout', () => {
  test.beforeAll(() => {
    ejecutarSQL(sqlDeFixtureBusqueda())
    ejecutarSQL(sqlDeFixturePosMobile())
  })

  test.beforeEach(() => {
    limpiarCajasDelTest()
    cerrarCaja()
  })

  test.afterEach(() => {
    rolDelActor('owner')
    limpiarCajasDelTest()
    abrirCaja()
  })

  for (const tema of ['light', 'dark'] as const) {
    test(`mobile-390 · ${tema} · «Cobrar» → abrir caja → mismo checkout`, async ({ page }, testInfo) => {
      const vp = { width: 390, height: 844 }
      const fallos: string[] = []
      page.on('response', r => {
        if (r.status() < 400 || /favicon/i.test(r.url()) || !esDeNuestroStack(r.url())) return
        fallos.push(`${r.status()} ${r.url()}`)
      })
      page.on('pageerror', e => fallos.push(`pageerror: ${String(e)}`))
      const aperturas: Array<Record<string, unknown>> = []
      page.on('request', req => {
        if (req.method() === 'POST' && /\/rest\/v1\/rpc\/open_cash_session_atomic$/.test(new URL(req.url()).pathname)) {
          aperturas.push(JSON.parse(req.postData() ?? '{}'))
        }
      })
      const grabador = await GrabadorRPC.iniciar(page, ['create_comprobante_checkout_atomic'])
      const antesEnBase = estadoEnBase()
      expect(antesEnBase.abiertas, 'precondición: caja cerrada').toBe(0)

      await page.setViewportSize(vp)
      await abrirPos(page, tema)
      await armarVenta(page, true)

      // ── 2 y 3 · caja cerrada, con salida a la vista ────────────────────────
      const aviso = page.getByTestId('pos-caja-closed')
      await expect(aviso).toBeVisible()
      await expect(aviso).toContainText('Necesitás abrir la caja para registrar este cobro.')
      const cta = page.getByTestId('pos-open-caja-button')
      await expect(cta).toBeVisible()
      const cajaCta = await cta.boundingBox()
      expect(cajaCta!.height + TOUCH_EPSILON, `alto táctil del CTA: ${cajaCta!.height}px`).toBeGreaterThanOrEqual(TOUCH_TARGET)
      expect(cajaCta!.x + cajaCta!.width, 'el CTA se sale del viewport').toBeLessThanOrEqual(vp.width + TOL)
      expect(await recibeElToque(cta), 'el CTA no recibe el toque').toEqual([true, true, true])
      const avisoCaja = await aviso.boundingBox()
      expect(avisoCaja!.x + avisoCaja!.width, 'el aviso se sale del viewport').toBeLessThanOrEqual(vp.width + TOL)
      await sinOverflowHorizontal(page, 'con el aviso de caja cerrada')
      await page.screenshot({ path: testInfo.outputPath(`01-caja-cerrada-${tema}.png`) })

      const antes = await fotoDeLaVenta(page)
      expect(antes.lineas.filter(Boolean).length, 'el carrito debe tener el producto').toBeGreaterThan(0)
      expect(antes.pagos).toEqual(['5000'])
      const urlAntes = page.url()

      // ── «Cobrar» NO empieza el checkout: abre el diálogo ───────────────────
      await page.getByTestId('comprobante-save-button').click()
      await medirDialogo(page, vp, true)
      expect(grabador.de('create_comprobante_checkout_atomic'), 'el checkout no puede haber empezado').toEqual([])
      await expect(page.getByTestId('comprobante-error-message')).toHaveCount(0)

      // El POS sigue siendo fullscreen: ni segunda barra ni scroll del fondo.
      await expect(page.getByTestId('mobile-bottom-nav')).toBeHidden()
      expect(await page.evaluate(() => document.body.classList.contains('mobile-pos-fullscreen'))).toBe(true)
      await sinOverflowHorizontal(page, 'con el diálogo abierto')
      await page.screenshot({ path: testInfo.outputPath(`02-dialogo-${tema}.png`) })

      // ── apertura ───────────────────────────────────────────────────────────
      await page.getByTestId('pos-open-caja-efectivo').fill('15000')
      await page.getByTestId('pos-open-caja-usd').fill('20')
      // Con montos cargados el diálogo sigue entrando (no crece al tipear).
      await medirDialogo(page, vp, true)
      await page.getByTestId('pos-open-caja-confirm').click()

      // ── 6 · se vuelve al MISMO POS ─────────────────────────────────────────
      await expect(page.getByTestId('pos-open-caja-dialog')).toHaveCount(0)
      await expect(page.getByTestId('pos-caja-closed')).toHaveCount(0)
      await expect(page.getByText('Caja abierta. Ya podés cobrar.')).toBeVisible()
      expect(page.url(), 'no se navega a /caja ni a ningún otro lado').toBe(urlAntes)
      await expect(page.locator('[data-testid="comprobante-product-search"]')).toBeAttached()
      // La hoja de cobro sigue abierta, con «Cobrar» a la vista.
      await expect(page.getByTestId('comprobante-save-button')).toBeVisible()
      await expect(page.getByTestId('comprobante-save-button')).toBeEnabled()
      expect(await fotoDeLaVenta(page), 'la venta cambió al abrir la caja').toEqual(antes)
      await expect(page.getByTestId('comprobante-success-screen')).toHaveCount(0)
      await sinOverflowHorizontal(page, 'de vuelta en el checkout')
      await page.screenshot({ path: testInfo.outputPath(`03-de-vuelta-${tema}.png`) })

      // ── una sola apertura, con el contrato de la RPC ───────────────────────
      expect(aperturas, 'exactamente una apertura').toHaveLength(1)
      expect(aperturas[0]).toMatchObject({
        p_business_id: E2E.business, p_user_id: E2E.owner,
        p_efectivo: 15000, p_transferencia: 0, p_tarjeta: 0, p_usd: 20,
      })
      expect(String(aperturas[0].p_idempotency_key)).toMatch(/^[0-9a-f-]{36}$/)
      expect(grabador.de('create_comprobante_checkout_atomic'), 'abrir la caja NO cobra').toEqual([])

      // ── estado final en base ───────────────────────────────────────────────
      const despues = estadoEnBase()
      expect(despues.abiertas, 'una sola caja abierta').toBe(1)
      expect(despues.abierta_id, 'no es la caja sembrada: la abrió este flujo').not.toBe(E2E.caja)
      expect(Number(despues.efectivo)).toBe(15000)
      expect(Number(despues.transferencia)).toBe(0)
      expect(Number(despues.tarjeta)).toBe(0)
      expect(Number(despues.usd)).toBe(20)
      expect(Number(despues.cotizacion)).toBe(Number(aperturas[0].p_usd_rate))
      expect(despues.abierta_por).toBe(E2E.owner)
      expect(despues.comprobantes, 'no se emitió ningún comprobante').toBe(antesEnBase.comprobantes)
      expect(despues.movimientos, 'abrir caja no crea movimientos').toBe(antesEnBase.movimientos)

      expect(fallos, `requests fallidos o errores de página: ${fallos.join(' | ')}`).toEqual([])
    })
  }

  test('mobile-320 · el diálogo entra y los campos pasan a una columna', async ({ page }, testInfo) => {
    const vp = { width: 320, height: 568 }
    await page.setViewportSize(vp)
    await abrirPos(page, 'light')
    await armarVenta(page, true)

    await page.getByTestId('pos-open-caja-button').click()
    const dialogo = await medirDialogo(page, vp, true)

    // Una sola columna: los cuatro montos comparten borde izquierdo.
    const xs = await Promise.all(METODOS.map(async m => Math.round((await page.getByTestId(`pos-open-caja-${m}`).boundingBox())!.x)))
    expect(new Set(xs).size, `a 320px los campos deben apilarse: x=${xs.join(',')}`).toBe(1)
    await sinOverflowHorizontal(page, 'a 320px con el diálogo abierto')
    await page.screenshot({ path: testInfo.outputPath('dialogo-320.png') })

    // Cancelar devuelve al checkout sin abrir nada.
    await page.getByTestId('pos-open-caja-cancel').click()
    await expect(dialogo).toHaveCount(0)
    await expect(page.getByTestId('pos-open-caja-button')).toBeVisible()
    expect(estadoEnBase().abiertas).toBe(0)
  })

  test('desktop-1440 · centrado, Escape cierra sólo el diálogo y el POS sigue', async ({ page }, testInfo) => {
    const vp = { width: 1440, height: 900 }
    await page.setViewportSize(vp)
    await abrirPos(page, 'light')
    await armarVenta(page, false)
    const antes = await fotoDeLaVenta(page)

    const aviso = page.getByTestId('pos-caja-closed')
    await expect(aviso).toBeVisible()
    // Aviso y CTA en una fila dentro del panel de cobro, sin desbordarlo.
    const panel = (await page.locator('.cpm-right').boundingBox())!
    const cajaAviso = (await aviso.boundingBox())!
    expect(cajaAviso.x, 'el aviso se sale del panel').toBeGreaterThanOrEqual(panel.x - TOL)
    expect(cajaAviso.x + cajaAviso.width, 'el aviso se sale del panel').toBeLessThanOrEqual(panel.x + panel.width + TOL)
    await page.screenshot({ path: testInfo.outputPath('01-caja-cerrada-desktop.png') })

    await page.keyboard.press('F4')
    const dialogo = await medirDialogo(page, vp, false)
    const caja = (await dialogo.boundingBox())!
    expect(Math.abs((caja.x + caja.width / 2) - vp.width / 2), 'el diálogo debe quedar centrado').toBeLessThanOrEqual(2)
    expect(caja.width, 'en desktop no ocupa todo el ancho').toBeLessThanOrEqual(480)
    await page.screenshot({ path: testInfo.outputPath('02-dialogo-desktop.png') })

    await page.keyboard.press('Escape')
    await expect(dialogo).toHaveCount(0)
    // Escape no cerró el POS ni disparó el aviso de cambios sin guardar.
    await expect(page.locator('[data-testid="comprobante-product-search"]')).toBeVisible()
    await expect(page.getByText('Cambios sin guardar')).toHaveCount(0)
    expect(await fotoDeLaVenta(page)).toEqual(antes)
    expect(estadoEnBase().abiertas).toBe(0)
  })

  test('sales (sin finance) · sin CTA ni diálogo, y el SERVIDOR rechaza la apertura directa', async ({ page, request }, testInfo) => {
    const vp = { width: 390, height: 844 }
    rolDelActor('sales')
    const aperturasDesdeLaUi: string[] = []
    page.on('request', req => {
      if (/\/rest\/v1\/rpc\/open_cash_session_atomic$/.test(new URL(req.url()).pathname)) aperturasDesdeLaUi.push(req.url())
    })
    const grabador = await GrabadorRPC.iniciar(page, ['create_comprobante_checkout_atomic'])
    const antesEnBase = estadoEnBase()

    await page.setViewportSize(vp)
    await abrirPos(page, 'light')
    await armarVenta(page, true)

    // ── UI: explicación, sin acción ──────────────────────────────────────────
    const aviso = page.getByTestId('pos-caja-closed')
    await expect(aviso).toHaveAttribute('data-caja-action', 'none')
    await expect(aviso).toContainText('La caja está cerrada. Pedile a un usuario con permiso de Finanzas / Caja que la abra para continuar.')
    await expect(page.getByTestId('pos-open-caja-button')).toHaveCount(0)
    await expect(aviso.getByRole('button')).toHaveCount(0)
    await expect(aviso.getByRole('link')).toHaveCount(0)
    const cajaAviso = (await aviso.boundingBox())!
    expect(cajaAviso.x + cajaAviso.width, 'el aviso se sale del viewport').toBeLessThanOrEqual(vp.width + TOL)
    await sinOverflowHorizontal(page, 'con el aviso sin permiso')
    await page.screenshot({ path: testInfo.outputPath('caja-cerrada-sin-permiso.png') })

    const urlAntes = page.url()
    await page.getByTestId('comprobante-save-button').click()
    await page.waitForTimeout(400)
    await expect(page.getByTestId('pos-open-caja-dialog')).toHaveCount(0)
    expect(page.url(), 'tampoco se lo manda a /caja').toBe(urlAntes)
    expect(aperturasDesdeLaUi, 'la UI no puede pedir la apertura').toEqual([])
    expect(grabador.de('create_comprobante_checkout_atomic'), 'el checkout no empieza con la caja cerrada').toEqual([])

    // ── Servidor: aunque alguien arme el pedido a mano, no pasa ──────────────
    // Mismo JWT y mismo contrato de cliente que usa la app.
    const token = await tokenDeSesion(page)
    const llamar = (key: string) => request.post(`${process.env.VITE_SUPABASE_URL}/rest/v1/rpc/open_cash_session_atomic`, {
      headers: {
        apikey: process.env.VITE_SUPABASE_ANON_KEY ?? '',
        Authorization: `Bearer ${token}`,
        'x-techrepair-client-contract': '1',
      },
      data: {
        p_business_id: E2E.business, p_user_id: E2E.owner,
        p_efectivo: 1, p_transferencia: 0, p_tarjeta: 0, p_usd: 0,
        p_usd_rate: 1, p_idempotency_key: key,
      },
    })

    const denegada = await llamar('beta-ux-1b-e2e-sales')
    expect(denegada.status(), 'sin finance el servidor responde 403').toBe(403)
    expect(await denegada.json()).toMatchObject({ code: '42501', message: 'FORBIDDEN' })
    const trasDenegar = estadoEnBase()
    expect(trasDenegar.abiertas, 'la denegación no abrió nada').toBe(0)
    expect(trasDenegar).toEqual(antesEnBase)

    // Control positivo: el MISMO pedido, con el mismo token, pasa cuando el
    // actor recupera la capacidad. Sin esto el 403 podría ser de otra cosa.
    rolDelActor('owner')
    const permitida = await llamar('beta-ux-1b-e2e-owner')
    expect(permitida.status()).toBe(200)
    expect(await permitida.json()).toMatchObject({ ok: true, replay: false })
    expect(estadoEnBase().abiertas).toBe(1)
  })

  test('carrera real · otro actor abre la caja con el diálogo a la vista', async ({ page }) => {
    const vp = { width: 390, height: 844 }
    const respuestas: unknown[] = []
    page.on('response', async r => {
      if (/\/rest\/v1\/rpc\/open_cash_session_atomic$/.test(new URL(r.url()).pathname)) {
        respuestas.push(await r.json().catch(() => null))
      }
    })
    const grabador = await GrabadorRPC.iniciar(page, ['create_comprobante_checkout_atomic'])

    await page.setViewportSize(vp)
    await abrirPos(page, 'light')
    await armarVenta(page, true)
    const antes = await fotoDeLaVenta(page)

    await page.getByTestId('pos-open-caja-button').click()
    await expect(page.getByTestId('pos-open-caja-dialog')).toBeVisible()
    await page.getByTestId('pos-open-caja-efectivo').fill('7000')

    // El «usuario B»: la caja sembrada vuelve a estar abierta por fuera de esta pantalla.
    abrirCaja()
    await page.getByTestId('pos-open-caja-confirm').click()

    // El servidor rechazó la apertura; la UI lo trata como prerequisito cumplido.
    await expect(page.getByTestId('pos-open-caja-dialog')).toHaveCount(0)
    await expect(page.getByTestId('pos-open-caja-error')).toHaveCount(0)
    await expect(page.getByTestId('pos-caja-closed')).toHaveCount(0)
    await expect(page.getByText('La caja ya estaba abierta. Ya podés cobrar.')).toBeVisible()
    expect(respuestas).toEqual([{ ok: false, error: 'Ya hay una caja abierta' }])
    expect(await fotoDeLaVenta(page)).toEqual(antes)
    expect(grabador.de('create_comprobante_checkout_atomic')).toEqual([])

    // No se abrió una segunda caja y los $7000 tipeados NO se aplicaron.
    const despues = estadoEnBase()
    expect(despues.abiertas).toBe(1)
    expect(despues.abierta_id).toBe(E2E.caja)
    expect(Number(despues.efectivo)).not.toBe(7000)
  })
})
