// ============================================================================
// BETA-UX-1C — Mi Suscripción por estado + aviso de suscripción, en navegador.
//
//   npx playwright test --project=m7-local --grep @beta-ux-1c
//
// Los tests de componentes (`tests/components/betaUx1c*.test.*`) miden la lógica.
// Acá se mide lo que jsdom no puede — GEOMETRÍA y CONTRASTE sobre el CSS real:
//
//   · P1-4: a 375 px la tarjeta de estado dejaba el texto en una columna de una
//     palabra por línea. Se exige ancho útil para los textos, acciones DEBAJO
//     del contenido, sin desborde horizontal y con área táctil >= 44 px;
//   · P1-13: el aviso de trial no desborda, su cierre mide >= 44×44, el texto y
//     la acción cumplen AA en claro y en oscuro, y el cierre sobrevive a navegar
//     y a recargar.
//
// CÓMO SE LLEGA A CADA ESTADO. El negocio E2E está activo y sin Mercado Pago.
// Para recorrer la matriz se parchea, EN EL NAVEGADOR, la respuesta real de la
// lectura de la suscripción (`businesses?select=subscription_status,…`) y se
// simula la acción `status` de `mp-subscription`. La base, la sesión y RLS son
// las reales y nada queda modificado para el resto de la suite. Lo que se
// simula es la ENTRADA de la pantalla; el layout y los colores son los servidos.
// ============================================================================
import { test, expect } from './fixtures'
import type { Locator, Page } from '@playwright/test'
import { AA_SMALL_TEXT, applyTheme, contrastOf } from '../helpers/contrast'

const TOUCH_TARGET = 44
/** Ruido float32 de la transformación de entrada; ver dialog-touch-actions.spec.ts. */
const TOUCH_EPSILON = 0.01
const TOL = 1
const DIA = 24 * 60 * 60 * 1000

/** Capturas de evidencia: sólo a pedido, para no reescribir PNG versionados en cada corrida. */
const EVIDENCIA = process.env.BETA_UX_1C_EVIDENCE === '1' ? 'docs/beta-ux-1/evidence-1c' : null

const enDias = (n: number) => new Date(Date.now() + n * DIA - 60_000).toISOString()

type Fila = Record<string, string | null>

const BASE: Fila = {
  subscription_status: 'trialing', subscription_plan: 'pro', access_source: 'trial',
  mp_preapproval_id: null, mp_payer_email: null, current_period_start: null, current_period_end: null,
  grace_until: null, last_payment_status: null, trial_ends_at: null, override_expires_at: null,
}

interface Escenario {
  id: string
  presentacion: string
  fila: () => Fila
  checkout?: Record<string, unknown> | null
  /** Botones de la tarjeta de estado, en orden. */
  acciones: string[]
  /** Tipo de aviso sobre el contenido, o `null` si no debe haber ninguno. */
  aviso: 'trial' | 'past_due' | 'period_ending' | null
}

const ESCENARIOS: Escenario[] = [
  {
    id: 'trial',
    presentacion: 'trial',
    fila: () => ({ ...BASE, trial_ends_at: enDias(13) }),
    acciones: ['Elegir plan'],
    aviso: null,
  },
  {
    id: 'trial-por-vencer',
    presentacion: 'trial',
    fila: () => ({ ...BASE, trial_ends_at: enDias(3) }),
    acciones: ['Elegir plan'],
    aviso: 'trial',
  },
  {
    id: 'trial-pago-iniciado',
    presentacion: 'trial_pending_checkout',
    fila: () => ({ ...BASE, trial_ends_at: enDias(9) }),
    checkout: { status: 'pending', plan: 'full', billing_cycle: 'annual', created_at: new Date().toISOString(), confirmed_at: null },
    acciones: ['Continuar pago', 'Verificar pago'],
    aviso: null,
  },
  {
    id: 'activa-mercado-pago',
    presentacion: 'mp_active',
    fila: () => ({
      ...BASE, subscription_status: 'active', access_source: 'mercado_pago', mp_preapproval_id: 'pre_e2e_1c',
      mp_payer_email: 'pagador-e2e@e2e.local', last_payment_status: 'approved',
      current_period_start: enDias(-10), current_period_end: enDias(20),
    }),
    acciones: ['Cambiar plan'],
    aviso: null,
  },
  {
    id: 'pago-vencido',
    presentacion: 'past_due',
    fila: () => ({
      ...BASE, subscription_status: 'past_due', access_source: 'mercado_pago', mp_preapproval_id: 'pre_e2e_1c',
      last_payment_status: 'rejected', grace_until: enDias(2), current_period_end: enDias(-1),
    }),
    acciones: ['Actualizar método de pago', 'Verificar pago', 'Cambiar plan'],
    aviso: 'past_due',
  },
  {
    id: 'acceso-manual',
    presentacion: 'manual_access',
    fila: () => ({
      ...BASE, subscription_status: 'active', access_source: 'admin_override',
      current_period_end: enDias(31), override_expires_at: enDias(45),
    }),
    acciones: ['Ayuda'],
    aviso: null,
  },
]

/** Parchea en el navegador la lectura real de la suscripción del negocio. */
async function simularSuscripcion(page: Page, fila: Fila) {
  await page.route('**/rest/v1/businesses?**', async (route) => {
    if (!route.request().url().includes('subscription_status')) return route.fallback()
    const response = await route.fetch()
    const body = await response.json()
    const patch = (row: Record<string, unknown>) => ({ ...row, ...fila })
    await route.fulfill({ response, json: Array.isArray(body) ? body.map(patch) : patch(body) })
  })
}

/**
 * Simula `mp-subscription`. `status` devuelve el checkout del escenario; ninguna
 * otra acción debería salir en estos tests, y si sale queda registrada.
 */
async function simularMercadoPago(page: Page, checkout: Record<string, unknown> | null): Promise<string[]> {
  const acciones: string[] = []
  await page.route('**/functions/v1/mp-subscription', async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as { action?: string }
    acciones.push(body.action ?? '(sin acción)')
    const cors = { 'access-control-allow-origin': '*' }
    if (body.action === 'status') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ source: 'database', checkout }) })
    }
    return route.fulfill({ status: 409, contentType: 'application/json', headers: cors, body: JSON.stringify({ error: 'Acción no esperada en este test.', code: 'unexpected' }) })
  })
  return acciones
}

async function abrirSuscripcion(page: Page, escenario: Escenario, tema: 'light' | 'dark', ancho: number, alto: number) {
  await applyTheme(page, tema)
  await page.setViewportSize({ width: ancho, height: alto })
  await simularSuscripcion(page, escenario.fila())
  const acciones = await simularMercadoPago(page, escenario.checkout ?? null)
  // En un trial la pantalla le pregunta al servidor por un pago iniciado. Hasta
  // que esa lectura vuelve muestra `trial`: se espera a que haya vuelto, para
  // medir el estado definitivo y no el provisorio.
  const enTrial = escenario.presentacion.startsWith('trial')
  const checkoutLeido = enTrial
    ? page.waitForResponse(r => r.url().includes('/functions/v1/mp-subscription') && r.request().method() === 'POST')
    : null
  await page.goto('/subscription')
  const tarjeta = page.getByTestId('subscription-status-card')
  await expect(tarjeta).toBeVisible({ timeout: 30_000 })
  await checkoutLeido
  await expect(tarjeta).toHaveAttribute('data-presentation', escenario.presentacion, { timeout: 15_000 })
  // La entrada de la página termina (sin transform residual) antes de medir.
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))))
  return { tarjeta, acciones }
}

const caja = async (l: Locator) => {
  const b = await l.boundingBox()
  if (!b) throw new Error('elemento sin caja')
  return b
}

/**
 * Desborde horizontal REAL. `.main-content` recorta lo que se le sale
 * (`overflow-x: hidden`), así que mirar sólo `documentElement.scrollWidth` daría
 * verde con contenido cortado. Se mide además el contenedor que recorta y se
 * busca cualquier elemento de la pantalla que termine fuera del viewport (salvo
 * lo que vive dentro de una tabla con scroll propio).
 */
const desbordeHorizontal = (page: Page) => page.evaluate(() => {
  const exceso = (el: Element | null) => (el ? el.scrollWidth - el.clientWidth : 0)
  const ancho = document.documentElement.clientWidth
  let fuera = 0
  for (const el of document.querySelectorAll('.sub-page *, .sub-banner, .sub-banner *')) {
    if (el.closest('.table-wrap')) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    fuera = Math.max(fuera, r.right - ancho, -r.left)
  }
  return Math.max(exceso(document.documentElement), exceso(document.querySelector('.main-content')), exceso(document.querySelector('.sub-page')), fuera)
})

/** Cantidad de líneas que ocupa un texto: alto del contenido / alto de línea. */
const lineas = (l: Locator) => l.evaluate((el) => {
  const estilo = getComputedStyle(el)
  const alto = el.getBoundingClientRect().height - parseFloat(estilo.paddingTop) - parseFloat(estilo.paddingBottom)
  return Math.round(alto / parseFloat(estilo.lineHeight))
})

async function capturar(page: Page, nombre: string) {
  if (!EVIDENCIA) return
  await page.screenshot({ path: `${EVIDENCIA}/${nombre}.png`, fullPage: false, caret: 'initial' })
}

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1c Mi Suscripción · tarjeta de estado en mobile (P1-4)', () => {
  for (const tema of ['light', 'dark'] as const) {
    for (const escenario of ESCENARIOS) {
      test(`375×812 · ${tema} · ${escenario.id}`, async ({ page }) => {
        const { tarjeta, acciones } = await abrirSuscripcion(page, escenario, tema, 375, 812)

        // ── Sin desborde horizontal: ni la página ni la tarjeta ──────────────
        expect(await desbordeHorizontal(page), 'la página desborda a lo ancho').toBeLessThanOrEqual(TOL)
        const cajaTarjeta = await caja(tarjeta)
        expect(cajaTarjeta.x).toBeGreaterThanOrEqual(-TOL)
        expect(cajaTarjeta.x + cajaTarjeta.width).toBeLessThanOrEqual(375 + TOL)
        expect(await tarjeta.evaluate(el => el.scrollWidth - el.clientWidth), 'la tarjeta desborda').toBeLessThanOrEqual(TOL)

        // ── Ancho útil: los textos usan el ancho de la tarjeta ───────────────
        const cuerpo = tarjeta.locator('.sub-status')
        const anchoUtil = await cuerpo.evaluate((el) => {
          const e = getComputedStyle(el)
          return el.clientWidth - parseFloat(e.paddingLeft) - parseFloat(e.paddingRight)
        })
        const detalle = tarjeta.locator('.sub-status__detail')
        const cajaDetalle = await caja(detalle)
        expect(cajaDetalle.width, 'los textos del estado no usan el ancho de la tarjeta').toBeGreaterThanOrEqual(anchoUtil - TOL)
        // El síntoma exacto de P1-4: una palabra por línea. Ningún párrafo se
        // estira más de lo que su largo justifica (≈ 28 caracteres por línea).
        for (const parrafo of await detalle.locator('p').all()) {
          const texto = (await parrafo.textContent()) ?? ''
          const n = await lineas(parrafo)
          expect(n, `«${texto.slice(0, 40)}…» ocupa ${n} líneas`).toBeLessThanOrEqual(Math.ceil(texto.length / 28) + 1)
        }
        const titulo = tarjeta.locator('.sub-status__title')
        expect(await lineas(titulo), 'el nombre del plan se parte en líneas').toBe(1)
        // El ícono acompaña al título en la misma fila, no le roba una columna al texto.
        const cajaIcono = await caja(tarjeta.locator('.sub-status__icon'))
        const cajaTitulo = await caja(titulo)
        expect(cajaTitulo.y).toBeLessThan(cajaIcono.y + cajaIcono.height)
        expect(cajaDetalle.y).toBeGreaterThanOrEqual(cajaIcono.y + cajaIcono.height - TOL)

        // ── Acciones: las del estado, debajo del contenido, de lado a lado ───
        const zona = page.getByTestId('subscription-status-actions')
        const botones = zona.getByRole('button')
        await expect(botones).toHaveText(escenario.acciones)
        const cajaZona = await caja(zona)
        expect(cajaZona.y, 'las acciones no quedaron debajo del contenido').toBeGreaterThanOrEqual(cajaDetalle.y + cajaDetalle.height - TOL)
        for (const boton of await botones.all()) {
          const b = await caja(boton)
          expect(b.height, `«${await boton.textContent()}» mide ${b.height}px de alto`).toBeGreaterThanOrEqual(TOUCH_TARGET - TOUCH_EPSILON)
          expect(b.width, 'la acción no usa el ancho disponible').toBeGreaterThanOrEqual(anchoUtil - TOL)
          expect(b.x + b.width).toBeLessThanOrEqual(375 + TOL)
          // Alcanzable: visible, estable y recibe el toque (sin ejecutarlo).
          await boton.click({ trial: true })
        }

        // ── Toda acción de la pantalla es táctil ─────────────────────────────
        for (const boton of await page.locator('.sub-page .btn').all()) {
          const b = await caja(boton)
          expect(b.height, `«${(await boton.textContent())?.trim()}» mide ${b.height}px`).toBeGreaterThanOrEqual(TOUCH_TARGET - TOUCH_EPSILON)
        }

        // ── Legible en este tema ─────────────────────────────────────────────
        const medidas = {
          titulo: await contrastOf(titulo),
          estado: await contrastOf(page.getByTestId('subscription-status-badge')),
          texto: await contrastOf(detalle.locator('p').first()),
        }
        for (const [que, m] of Object.entries(medidas)) {
          expect(m.ratio, `${que}: ${m.foreground} sobre ${m.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
        }

        // ── El aviso sobre el contenido: sólo cuando corresponde ─────────────
        const aviso = page.getByTestId('subscription-banner')
        if (escenario.aviso) await expect(aviso).toHaveAttribute('data-banner-kind', escenario.aviso)
        else await expect(aviso).toHaveCount(0)

        // Dibujar la pantalla no dispara ninguna acción de Mercado Pago: a lo
        // sumo la lectura del checkout, y sólo durante un trial.
        expect(acciones).toEqual(escenario.presentacion.startsWith('trial') ? ['status'] : [])

        await capturar(page, `${escenario.id}-375-${tema}`)
      })
    }
  }

  test('320×700 · el estado con más acciones tampoco desborda', async ({ page }) => {
    const escenario = ESCENARIOS.find(e => e.id === 'pago-vencido')!
    const { tarjeta } = await abrirSuscripcion(page, escenario, 'light', 320, 700)
    expect(await desbordeHorizontal(page)).toBeLessThanOrEqual(TOL)
    expect(await tarjeta.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(TOL)
    for (const boton of await page.getByTestId('subscription-status-actions').getByRole('button').all()) {
      const b = await caja(boton)
      expect(b.height).toBeGreaterThanOrEqual(TOUCH_TARGET - TOUCH_EPSILON)
      expect(b.x + b.width).toBeLessThanOrEqual(320 + TOL)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1c Mi Suscripción · desktop y anchos intermedios', () => {
  for (const escenario of ESCENARIOS) {
    test(`1440×900 · light · ${escenario.id}: composición horizontal`, async ({ page }) => {
      const { tarjeta } = await abrirSuscripcion(page, escenario, 'light', 1440, 900)
      expect(await desbordeHorizontal(page)).toBeLessThanOrEqual(TOL)
      expect(await tarjeta.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(TOL)

      const principal = await caja(tarjeta.locator('.sub-status__main'))
      const zona = await caja(page.getByTestId('subscription-status-actions'))
      // Acciones al costado del contenido, en la misma fila.
      expect(zona.x, 'las acciones no quedaron al costado').toBeGreaterThanOrEqual(principal.x + principal.width - TOL)
      expect(zona.y).toBeLessThan(principal.y + principal.height)
      expect(zona.y + zona.height).toBeGreaterThan(principal.y)
      await expect(page.getByTestId('subscription-status-actions').getByRole('button')).toHaveText(escenario.acciones)

      const texto = await contrastOf(tarjeta.locator('.sub-status__detail p').first())
      expect(texto.ratio, `${texto.foreground} sobre ${texto.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      await capturar(page, `${escenario.id}-1440-light`)
    })
  }

  // Entre mobile y desktop el contenido puede ser angosto (sidebar + tarjeta).
  // El texto nunca queda apretado al lado de las acciones: o entran, o bajan.
  for (const ancho of [480, 600, 768, 1024]) {
    test(`${ancho}px · el texto conserva un ancho útil con tres acciones`, async ({ page }) => {
      const escenario = ESCENARIOS.find(e => e.id === 'pago-vencido')!
      const { tarjeta } = await abrirSuscripcion(page, escenario, 'light', ancho, 900)
      expect(await desbordeHorizontal(page)).toBeLessThanOrEqual(TOL)
      const detalle = await caja(tarjeta.locator('.sub-status__detail'))
      const cuerpo = await caja(tarjeta.locator('.sub-status'))
      // 16rem de texto, o todo el ancho de la tarjeta si la tarjeta es más angosta.
      expect(detalle.width).toBeGreaterThanOrEqual(Math.min(256, cuerpo.width - 120))
      const parrafo = tarjeta.getByTestId('subscription-past-due')
      const texto = (await parrafo.textContent()) ?? ''
      expect(await lineas(parrafo)).toBeLessThanOrEqual(Math.ceil(texto.length / 28) + 1)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1c Mi Suscripción · contenido por estado', () => {
  test('trial: «Al terminar la prueba», sin acciones de Mercado Pago ni lenguaje de cobro', async ({ page }) => {
    await abrirSuscripcion(page, ESCENARIOS[0], 'light', 1440, 900)
    const detalles = page.getByTestId('subscription-plan-details')
    await expect(detalles).toContainText('Al terminar la prueba')
    await expect(detalles).toContainText('/mes')
    await expect(detalles.locator('.label-caps')).toHaveText(['Plan', 'Al terminar la prueba'])
    await expect(page.getByTestId('subscription-manage-card')).toHaveCount(0)
    for (const nombre of [/Verificar pago/, /Actualizar método de pago/, /Cancelar suscripción/]) {
      await expect(page.getByRole('button', { name: nombre })).toHaveCount(0)
    }
    await expect(page.locator('.sub-page')).not.toContainText('Próximo cobro')
  })

  test('acceso manual: «Acceso otorgado por TechRepair Pro», vencimiento, sólo Ayuda', async ({ page }) => {
    const escenario = ESCENARIOS.find(e => e.id === 'acceso-manual')!
    const { acciones } = await abrirSuscripcion(page, escenario, 'light', 1440, 900)
    await expect(page.getByTestId('subscription-manual-access')).toHaveText('Acceso otorgado por TechRepair Pro.')
    await expect(page.getByTestId('subscription-manual-expiry')).toContainText('Tu acceso vence el ')
    const pantalla = page.locator('.sub-page')
    for (const prohibido of ['Elegir plan', 'Cambiar plan', 'Ver planes', 'Verificar pago', 'Actualizar método', 'Cancelar suscripción', 'Próximo cobro', 'Historial de pagos', '$']) {
      await expect(pantalla, `no debería decir «${prohibido}»`).not.toContainText(prohibido)
    }
    await expect(pantalla.getByRole('button')).toHaveText(['Actualizar', 'Ayuda'])
    await page.getByRole('button', { name: 'Ayuda' }).click()
    await expect(page).toHaveURL(/\/ayuda$/)
    expect(acciones).toEqual([])
  })

  test('activa por Mercado Pago: próximo cobro y administración completa', async ({ page }) => {
    const escenario = ESCENARIOS.find(e => e.id === 'activa-mercado-pago')!
    await abrirSuscripcion(page, escenario, 'light', 1440, 900)
    await expect(page.getByTestId('subscription-next-charge')).toContainText('Próximo cobro')
    const administrar = page.getByTestId('subscription-manage-card')
    await expect(administrar.getByRole('button')).toHaveText(['Actualizar método de pago', 'Verificar pago', 'Cancelar suscripción'])
  })

  for (const tema of ['light', 'dark'] as const) {
    test(`«Usuarios incluidos» y las funciones del plan se leen en ${tema}`, async ({ page }) => {
      await abrirSuscripcion(page, ESCENARIOS[0], tema, 375, 812)
      const fila = page.getByTestId('subscription-users')
      await expect(fila).toBeVisible()
      for (const span of await fila.locator('span').all()) {
        const m = await contrastOf(span)
        expect(m.ratio, `«${await span.textContent()}» ${m.foreground} sobre ${m.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      }
      // La fila se distingue del fondo de la tarjeta con un borde de tema.
      const borde = await fila.evaluate(el => getComputedStyle(el).borderTopWidth)
      expect(parseFloat(borde)).toBeGreaterThanOrEqual(1)

      // Funciones incluidas y no incluidas (el Plan Pro tiene de las dos).
      for (const clase of ['.sub-feature--on', '.sub-feature:not(.sub-feature--on)']) {
        const funcion = page.locator(clase).first()
        await expect(funcion).toBeVisible()
        const m = await contrastOf(funcion.locator('span').last())
        expect(m.ratio, `${clase}: ${m.foreground} sobre ${m.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      }
      const marca = await contrastOf(page.locator('.sub-feature--on .sub-feature__mark').first())
      expect(marca.ratio, `✓ ${marca.foreground} sobre ${marca.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1c Aviso de suscripción (P1-13)', () => {
  const porVencer = ESCENARIOS.find(e => e.id === 'trial-por-vencer')!

  async function abrirCon(page: Page, fila: Fila, tema: 'light' | 'dark', ancho: number, alto: number, ruta = '/dashboard') {
    await applyTheme(page, tema)
    await page.setViewportSize({ width: ancho, height: alto })
    await simularSuscripcion(page, fila)
    await simularMercadoPago(page, null)
    await page.goto(ruta)
    await expect(page.locator('.page-hdr, h1').first()).toBeVisible({ timeout: 30_000 })
  }

  for (const tema of ['light', 'dark'] as const) {
    for (const [ancho, alto] of [[375, 812], [1440, 900]] as const) {
      test(`trial por vencer · ${ancho}px · ${tema}: geometría, táctil y contraste AA`, async ({ page }) => {
        await abrirCon(page, porVencer.fila(), tema, ancho, alto)
        const aviso = page.getByTestId('subscription-banner')
        await expect(aviso).toBeVisible({ timeout: 15_000 })
        await expect(aviso).toHaveAttribute('data-banner-kind', 'trial')
        await expect(aviso).toContainText('Tu período de prueba vence en 3 días.')

        // ── No desborda ──────────────────────────────────────────────────────
        expect(await desbordeHorizontal(page)).toBeLessThanOrEqual(TOL)
        const b = await caja(aviso)
        expect(b.x).toBeGreaterThanOrEqual(-TOL)
        expect(b.x + b.width).toBeLessThanOrEqual(ancho + TOL)
        expect(await aviso.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(TOL)

        // ── Cierre: 44×44, con nombre, dentro del aviso y tocable ────────────
        const cerrar = aviso.getByRole('button', { name: 'Cerrar aviso de suscripción' })
        const c = await caja(cerrar)
        expect(c.width).toBeGreaterThanOrEqual(TOUCH_TARGET - TOUCH_EPSILON)
        expect(c.height).toBeGreaterThanOrEqual(TOUCH_TARGET - TOUCH_EPSILON)
        expect(c.x + c.width).toBeLessThanOrEqual(b.x + b.width + TOL)
        await cerrar.click({ trial: true })

        // ── Acción ───────────────────────────────────────────────────────────
        const accion = aviso.getByRole('button', { name: 'Ver planes' })
        const a = await caja(accion)
        if (ancho < 640) expect(a.height, 'la acción del aviso no es táctil en mobile').toBeGreaterThanOrEqual(TOUCH_TARGET - TOUCH_EPSILON)
        expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width + TOL)
        await accion.click({ trial: true })
        // El cierre y la acción no se pisan.
        const separados = a.x + a.width <= c.x + TOL || a.y >= c.y + c.height - TOL || c.y >= a.y + a.height - TOL
        expect(separados, 'el cierre y la acción se superponen').toBe(true)

        // ── No crece de más ──────────────────────────────────────────────────
        // Desktop: una sola línea. Mobile: el texto (hasta tres líneas a 375 px)
        // + la fila de la acción: ~123 px, contra los ~150 px que ocupaba antes.
        if (ancho >= 1024) expect(b.height).toBeLessThanOrEqual(60)
        else expect(b.height).toBeLessThanOrEqual(130)

        // ── Contraste AA del texto y de la acción reales ─────────────────────
        const medidas = {
          destacado: await contrastOf(aviso.locator('.sub-banner__text strong')),
          texto: await contrastOf(aviso.locator('.sub-banner__text')),
          accion: await contrastOf(accion),
        }
        for (const [que, m] of Object.entries(medidas)) {
          expect(m.ratio, `${que}: ${m.foreground} sobre ${m.background} (${m.fontSize})`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
        }
        // Foco visible en los dos controles.
        for (const control of [accion, cerrar]) {
          await control.focus()
          await page.keyboard.press('Shift+Tab')
          await page.keyboard.press('Tab')
          const foco = await control.evaluate(el => {
            const e = getComputedStyle(el)
            return { estilo: e.outlineStyle, ancho: parseFloat(e.outlineWidth) }
          })
          expect(foco.estilo).toBe('solid')
          expect(foco.ancho).toBeGreaterThanOrEqual(2)
        }

        await capturar(page, `aviso-trial-${ancho}-${tema}`)
      })
    }
  }

  test('el umbral es 5 días: a 5 hay aviso, a 6 no', async ({ page }) => {
    // En Mi Suscripción el estado aplicado se puede leer: el «no hay aviso» se
    // comprueba con la suscripción YA cargada, no antes.
    await abrirSuscripcion(page, { ...ESCENARIOS[0], fila: () => ({ ...BASE, trial_ends_at: enDias(5) }) }, 'light', 375, 812)
    await expect(page.getByTestId('subscription-trial-days')).toContainText('Te quedan 5 días de prueba')
    await expect(page.getByTestId('subscription-banner')).toContainText('Tu período de prueba vence en 5 días.')

    await abrirSuscripcion(page, { ...ESCENARIOS[0], fila: () => ({ ...BASE, trial_ends_at: enDias(6) }) }, 'light', 375, 812)
    await expect(page.getByTestId('subscription-trial-days')).toContainText('Te quedan 6 días de prueba')
    await expect(page.getByTestId('subscription-banner')).toHaveCount(0)
  })

  test('con más de 5 días de prueba no hay aviso en ninguna página', async ({ page }) => {
    await abrirCon(page, { ...BASE, trial_ends_at: enDias(13) }, 'light', 375, 812)
    for (const ruta of ['/dashboard', '/orders', '/customers', '/subscription']) {
      const leida = page.waitForResponse(r => r.url().includes('/rest/v1/businesses') && r.url().includes('subscription_status'))
      await page.goto(ruta)
      await leida
      await expect(page.locator('.page-hdr, h1').first()).toBeVisible({ timeout: 30_000 })
      // La suscripción ya llegó: se deja terminar la red y pintar antes del «no está».
      await page.waitForLoadState('networkidle')
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))))
      await expect(page.getByTestId('subscription-banner'), ruta).toHaveCount(0)
    }
  })

  test('cerrar el aviso lo oculta al navegar y al recargar; otro negocio u otro día no heredan la marca', async ({ page }) => {
    await abrirCon(page, porVencer.fila(), 'light', 375, 812)
    const aviso = page.getByTestId('subscription-banner')
    await expect(aviso).toBeVisible({ timeout: 15_000 })

    await aviso.getByRole('button', { name: 'Cerrar aviso de suscripción' }).click()
    await expect(aviso).toHaveCount(0)

    // La marca: una sola clave, con el negocio, el tipo y la fecha local; vale `1`.
    const marcas = await page.evaluate(() => Object.entries(window.localStorage)
      .filter(([k]) => k.startsWith('techrepair:subscription-banner:')))
    expect(marcas).toHaveLength(1)
    const hoy = await page.evaluate(() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    expect(marcas[0][0]).toMatch(new RegExp(`^techrepair:subscription-banner:dismissed:[0-9a-f-]{36}:trial:${hoy}$`))
    expect(marcas[0][1]).toBe('1')

    // Navegar dentro de la app.
    await page.goto('/orders')
    await expect(page.locator('.page-hdr, h1').first()).toBeVisible({ timeout: 30_000 })
    await expect(aviso).toHaveCount(0)

    // Recargar: la lectura de la suscripción vuelve y el aviso sigue cerrado.
    const releida = page.waitForResponse(r => r.url().includes('/rest/v1/businesses') && r.url().includes('subscription_status'))
    await page.reload()
    await releida
    await expect(page.locator('.page-hdr, h1').first()).toBeVisible({ timeout: 30_000 })
    await expect(aviso).toHaveCount(0)

    // La condición sigue: en Mi Suscripción el trial figura por vencer.
    await page.goto('/subscription')
    await expect(page.getByTestId('subscription-trial-days')).toContainText('Te quedan 3 días de prueba')
    await expect(aviso).toHaveCount(0)

    // Si la marca fuera de AYER o de OTRO negocio, el aviso vuelve.
    await page.evaluate(([clave]) => {
      window.localStorage.removeItem(clave)
      const partes = clave.split(':')
      window.localStorage.setItem([...partes.slice(0, -1), '2020-01-01'].join(':'), '1')
      window.localStorage.setItem(['techrepair', 'subscription-banner', 'dismissed', '00000000-0000-0000-0000-0000000000ff', 'trial', partes.at(-1)].join(':'), '1')
    }, [marcas[0][0]])
    await page.goto('/dashboard')
    await expect(aviso).toBeVisible({ timeout: 15_000 })
  })
})
