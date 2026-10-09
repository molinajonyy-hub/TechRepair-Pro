// ============================================================================
// BETA-UX-1E — CTAs de acento legibles, medidos en el navegador.
//
//   npx playwright test --project=m7-local --grep @beta-ux-1e
//
// El defecto (P1-6): CTAs de flujos core con fondo de acento y `color: '#fff'`
// EN LÍNEA. El barrido de tema claro de `index.css` remapea todo blanco en
// línea a `--text-primary`, así que en claro quedaban con texto casi negro
// sobre índigo. Los tests de componentes (`betaUx1eAccentContrast`) fijan qué
// estilo declara cada CTA; acá se mide lo que sólo existe con el CSS servido:
// el color con el que el texto queda pintado y el fondo real que tiene detrás.
//
// CÓMO SE MIDE. `paintedContrastOf` captura la caja del texto con los glifos
// ocultos y toma el píxel de PEOR contraste. Un CTA con gradiente no tiene
// `background-color`: medirlo por el color computado del fondo terminaba
// comparando el texto contra la tarjeta de atrás. El primer test calibra el
// instrumento contra valores WCAG conocidos.
//
// CONTRATO. Texto normal ≥ 4,5:1 en claro y en oscuro, sin la excepción de
// texto grande. Los estados deshabilitados sólo tienen que seguir siendo
// legibles (≥ 3:1): WCAG los exime.
//
// DATOS. Órdenes del fixture de BETA-UX-1D y un fixture propio con stock bajo,
// agotado y un usuario editable. El estado vacío y el de error de Inventario se
// obtienen parcheando EN EL NAVEGADOR la respuesta de la lista: se simula la
// ENTRADA de la pantalla; el layout y el CSS son los servidos. No se guarda,
// invita ni borra nada para medir.
// ============================================================================
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { test, expect } from './fixtures'
import type { Locator, Page } from '@playwright/test'
import { AA_SMALL_TEXT, applyTheme, contrastOf, paintedContrastOf } from '../helpers/contrast'
import { consultarJSON } from '../setup/sqlLocal.ts'
import { MOBILE_ORDERS, limpiarMobileOrders, sembrarMobileOrders } from '../setup/seedMobileOrdersFixture.ts'
import { CTA_CONTRAST_TEXT, limpiarCtaContrast, sembrarCtaContrast } from '../setup/seedCtaContrastFixture.ts'

type Tema = 'light' | 'dark'
type Ancho = 'mobile' | 'desktop'

const VIEWPORT: Record<Ancho, { width: number; height: number }> = {
  mobile: { width: 375, height: 812 },
  desktop: { width: 1440, height: 900 },
}
/** Cada superficie se mide en los dos temas y en los dos anchos. */
const MATRIZ: Array<[Tema, Ancho]> = [['light', 'mobile'], ['dark', 'mobile'], ['light', 'desktop'], ['dark', 'desktop']]

/** Estados deshabilitados: WCAG los exime de 4,5; sólo se exige que se sigan leyendo. */
const LEGIBLE_DESHABILITADO = 3
/** WCAG 1.4.11: un ícono que comunica algo necesita 3:1 contra su fondo. */
const NO_TEXTO = 3
const TOUCH_TARGET = 44
const TOUCH_EPSILON = 0.01

/** Medidas a un archivo (JSONL), a pedido: es la tabla antes → después del documento. */
const REGISTRO = process.env.BETA_UX_1E_MEASURE || null
/** Capturas de evidencia: sólo a pedido, para no reescribir PNG versionados en cada corrida. */
const EVIDENCIA = process.env.BETA_UX_1E_EVIDENCE || null

const ORDEN = `/orders/${MOBILE_ORDERS.ordenes.parcial}`

// Con 2 píxeles de dispositivo por píxel CSS los trazos de un texto de 11–14 px
// tienen núcleo: el color pintado de los glifos se puede leer sin suavizado.
test.use({ deviceScaleFactor: 2 })

test.beforeAll(() => { sembrarMobileOrders(); sembrarCtaContrast() })
test.afterAll(() => { limpiarCtaContrast(); limpiarMobileOrders() })

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Espera a que terminen las animaciones de entrada antes de medir. Las
 * infinitas (el spinner de «Guardando...») no terminan nunca: no se esperan.
 */
const asentar = (page: Page) =>
  page.evaluate(() => Promise.all(document.getAnimations()
    .filter(a => a.effect?.getComputedTiming().iterations !== Infinity)
    .map(a => a.finished.catch(() => undefined))))

async function abrir(page: Page, ruta: string, tema: Tema, ancho: Ancho, listo: Locator) {
  await applyTheme(page, tema)
  await page.setViewportSize(VIEWPORT[ancho])
  await page.goto(ruta)
  await expect(listo.first()).toBeVisible({ timeout: 30_000 })
  await page.waitForLoadState('networkidle')
  await asentar(page)
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'tema aplicado').toBe(tema)
}

type Contexto = { superficie: string; cta: string; tema: Tema; ancho: Ancho; estado?: string }

/**
 * Saca el puntero y comprueba que el CTA no quedó debajo. Sin esto una medida
 * «normal» puede salir en hover: el puntero queda donde lo dejó el paso
 * anterior y el próximo CTA, al ir al centro de la pantalla, cae justo ahí.
 */
async function enReposo(page: Page, cta: Locator) {
  await page.mouse.move(0, 0)
  await asentar(page)
  expect(await cta.evaluate(el => el.matches(':hover')), 'el CTA se mide en reposo, sin el puntero encima').toBe(false)
}

/**
 * Lleva el CTA al centro, le pone el puntero encima y comprueba que quedó ahí.
 * Primero al centro: la medida lo lleva a ese lugar, y si el scroll ocurriera
 * después el puntero quedaría sobre otra cosa.
 */
async function bajoElPuntero(page: Page, cta: Locator) {
  await cta.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
  await cta.hover()
  await asentar(page)
  expect(await cta.evaluate(el => el.matches(':hover')), 'el CTA se mide con el puntero encima').toBe(true)
}

/** Mide un CTA, lo deja asentado en el registro y exige el mínimo. */
async function medir(page: Page, cta: Locator, c: Contexto, minimo = AA_SMALL_TEXT) {
  await expect(cta).toBeVisible()
  const estado = c.estado ?? 'normal'
  if (estado === 'hover') await bajoElPuntero(page, cta)
  else await enReposo(page, cta)
  const m = await paintedContrastOf(cta)
  if (REGISTRO) {
    mkdirSync(dirname(REGISTRO), { recursive: true })
    appendFileSync(REGISTRO, JSON.stringify({ ...c, estado, minimo, ...m }) + '\n', 'utf-8')
  }
  expect.soft(
    m.ratio,
    `${c.superficie} · «${c.cta}» · ${c.tema} ${c.ancho} · ${estado}: texto ${m.foreground} sobre ${m.backgroundWorst} = ${m.ratio.toFixed(2)}:1`,
  ).toBeGreaterThanOrEqual(minimo)
  return m
}

/**
 * El CTA sigue siendo utilizable: recibe el click (sin darlo), su texto no
 * queda recortado por el propio botón y no se sale de la pantalla.
 */
async function accionable(cta: Locator, nombre: string, { dentroDelViewport = true } = {}) {
  await cta.click({ trial: true })
  const g = await cta.evaluate(el => {
    const r = el.getBoundingClientRect()
    return { recorte: el.scrollWidth - el.clientWidth, left: r.left, right: r.right, ancho: document.documentElement.clientWidth }
  })
  expect(g.recorte, `${nombre}: el texto se recorta ${g.recorte}px`).toBeLessThanOrEqual(1)
  if (dentroDelViewport) {
    expect(g.left, `${nombre}: empieza fuera de la pantalla`).toBeGreaterThanOrEqual(-1)
    expect(g.right, `${nombre}: termina fuera de la pantalla (${Math.round(g.right)} de ${g.ancho})`).toBeLessThanOrEqual(g.ancho + 1)
  }
}

async function capturar(objetivo: Locator, nombre: string) {
  if (!EVIDENCIA) return
  await objetivo.screenshot({ path: `${EVIDENCIA}/${nombre}.png`, caret: 'initial', animations: 'disabled' })
}

/** Parchea la lista de Inventario: se simula lo que la pantalla RECIBE. */
async function listaDeInventario(page: Page, respuesta: 'vacia' | 'error') {
  await page.route(/\/rest\/v1\/inventory\?/, route => {
    if (route.request().method() !== 'GET') return route.fallback()
    return respuesta === 'vacia'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
      : route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'falla simulada al cargar' }) })
  })
}

const boton = (page: Page, nombre: string | RegExp) => page.getByRole('button', { name: nombre, exact: typeof nombre === 'string' })

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1e El instrumento de medida', () => {
  test('ve el fondo pintado —también un gradiente— y reproduce los valores WCAG conocidos', async ({ page }) => {
    const base = 'padding:10px 20px;border:0;margin:8px;font:600 14px/1.5 system-ui;color:#ffffff'
    await page.setContent(`<body style="margin:0;background:#ffffff">
      <button id="indigo" style="${base};background:#4f46e5">Enviar Invitación</button>
      <button id="ambar" style="${base};background:#f59e0b">Ver stock bajo</button>
      <button id="gradiente" style="${base};background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%)">Enviar Invitación</button>
      <button id="defecto" style="${base};background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);color:#0f172a">Enviar Invitación</button>
      <div style="background:#0f172a;display:inline-block"><button id="apagado" style="${base};background:#4f46e5;opacity:0.5">Guardando...</button></div>
    </body>`)

    // Fondos sólidos: los valores de la fórmula WCAG para esos pares.
    const indigo = await paintedContrastOf(page.locator('#indigo'))
    expect(indigo.ratio).toBeCloseTo(6.29, 1)
    expect(indigo.ratioMax - indigo.ratio).toBeLessThan(0.05)
    expect((await paintedContrastOf(page.locator('#ambar'))).ratio).toBeCloseTo(2.15, 1)

    // Gradiente legacy: el blanco nunca llega a 4,5 y la medida VE que varía.
    const gradiente = await paintedContrastOf(page.locator('#gradiente'))
    expect(gradiente.ratio).toBeGreaterThan(4.15)
    expect(gradiente.ratioMax).toBeLessThan(4.5)
    expect(gradiente.ratioMax - gradiente.ratio).toBeGreaterThan(0.05)
    // El helper anterior compone `background-color`: no ve el gradiente y mide
    // blanco contra el blanco de la página.
    expect((await contrastOf(page.locator('#gradiente'))).ratio).toBeCloseTo(1, 1)
    // Por lo mismo habría dado VERDE con el defecto presente: texto oscuro sobre
    // el índigo, que él compara contra la página. La medida pintada lo ve.
    expect((await contrastOf(page.locator('#defecto'))).ratio).toBeGreaterThan(15)
    expect((await paintedContrastOf(page.locator('#defecto'))).ratio).toBeLessThan(AA_SMALL_TEXT)

    // Opacidad: se usa el color con el que quedaron pintados los glifos.
    const apagado = await paintedContrastOf(page.locator('#apagado'))
    expect(apagado.opacity).toBe(0.5)
    expect(apagado.foregroundPainted).not.toBe('rgb(255, 255, 255)')
    expect(apagado.ratio).toBeLessThan(indigo.ratio)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1e Usuarios', () => {
  for (const [tema, ancho] of MATRIZ) {
    test(`${ancho} ${tema} · «Enviar Invitación» se lee sobre su fondo`, async ({ page }) => {
      await abrir(page, '/users', tema, ancho, page.getByTestId('invite-open'))
      await page.getByTestId('invite-open').click()
      const cta = page.getByTestId('invite-submit')
      await expect(cta).toHaveText('Enviar Invitación')
      const c = { superficie: 'Usuarios', cta: 'Enviar Invitación', tema, ancho }
      await medir(page, cta, c)
      if (ancho === 'desktop') {
        await medir(page, cta, { ...c, estado: 'hover' })
        if (tema === 'light') await capturar(page.locator('.modal-card'), 'users-invite-light')
      }
      await accionable(cta, 'Enviar Invitación')
    })
  }

  for (const [tema, ancho] of [['light', 'desktop'], ['dark', 'desktop'], ['light', 'mobile']] as Array<[Tema, Ancho]>) {
    test(`${ancho} ${tema} · «Guardar permisos» se lee sobre su fondo`, async ({ page }) => {
      await abrir(page, '/users', tema, ancho, page.getByTestId('invite-open'))
      const fila = page.getByRole('row', { name: new RegExp(CTA_CONTRAST_TEXT.tecnico) })
      await fila.getByTitle('Editar permisos').click()
      const cta = boton(page, 'Guardar permisos')
      await medir(page, cta, { superficie: 'Usuarios', cta: 'Guardar permisos', tema, ancho })
      await accionable(cta, 'Guardar permisos')
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1e Producto', () => {
  for (const [tema, ancho] of MATRIZ) {
    test(`${ancho} ${tema} · «Guardar producto» se lee sobre su fondo`, async ({ page }) => {
      await abrir(page, '/inventory', tema, ancho, page.getByTestId('inventory-new-product-button'))
      await page.getByTestId('inventory-new-product-button').click()
      const cta = page.getByTestId('product-form-save-button')
      await expect(cta).toHaveText('Guardar producto')
      const c = { superficie: 'Producto', cta: 'Guardar producto', tema, ancho }
      await medir(page, cta, c)
      if (ancho === 'desktop') {
        await medir(page, cta, { ...c, estado: 'hover' })
        // El pie del formulario: «Cancelar» + el CTA.
        if (tema === 'light') await capturar(cta.locator('xpath=..'), 'product-save-light')
      }
      await accionable(cta, 'Guardar producto')
    })
  }

  for (const tema of ['light', 'dark'] as Tema[]) {
    test(`desktop ${tema} · los diálogos del formulario: «Seguir editando» y «Restaurar borrador»`, async ({ page }) => {
      await abrir(page, '/inventory', tema, 'desktop', page.getByTestId('inventory-new-product-button'))
      await page.getByTestId('inventory-new-product-button').click()
      const modal = page.getByTestId('product-form-modal')
      await modal.getByPlaceholder('Pantalla iPhone 14 Pro').fill('Borrador de contraste 1E')

      // Cerrar con cambios pregunta antes de perderlos.
      await modal.getByRole('button', { name: 'Cancelar', exact: true }).click()
      const seguir = boton(page, 'Seguir editando')
      await medir(page, seguir, { superficie: 'Producto', cta: 'Seguir editando', tema, ancho: 'desktop' })
      await accionable(seguir, 'Seguir editando')

      // Guardar el borrador y volver a abrir ofrece restaurarlo.
      await boton(page, 'Guardar borrador y cerrar').click()
      await expect(modal).toBeHidden()
      await page.getByTestId('inventory-new-product-button').click()
      const restaurar = boton(page, 'Restaurar borrador')
      await medir(page, restaurar, { superficie: 'Producto', cta: 'Restaurar borrador', tema, ancho: 'desktop' })
      await accionable(restaurar, 'Restaurar borrador')
      await boton(page, 'Empezar de cero').click()
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1e Inventario', () => {
  for (const [tema, ancho] of MATRIZ) {
    test(`${ancho} ${tema} · los filtros de stock se leen activos e inactivos`, async ({ page }) => {
      const bajo = boton(page, 'Ver stock bajo')
      const agotados = boton(page, 'Ver agotados')
      await abrir(page, '/inventory', tema, ancho, bajo)
      const c = { superficie: 'Inventario', tema, ancho }

      // Inactivos: fondo neutro del tema.
      await medir(page, bajo, { ...c, cta: 'Ver stock bajo', estado: 'inactivo' })
      await medir(page, agotados, { ...c, cta: 'Ver agotados', estado: 'inactivo' })

      // Activos: ámbar y rojo sólidos. El blanco no llega a AA sobre ninguno.
      await bajo.click()
      await medir(page, bajo, { ...c, cta: 'Ver stock bajo', estado: 'activo' })
      if (ancho === 'desktop' && tema === 'light') await capturar(bajo.locator('xpath=../..'), 'inventory-actions-light')
      if (ancho === 'desktop' && tema === 'dark') await capturar(bajo.locator('xpath=../..'), 'inventory-actions-dark')
      await agotados.click()
      await medir(page, agotados, { ...c, cta: 'Ver agotados', estado: 'activo' })
      // El que dejó de estar activo vuelve a leerse.
      await medir(page, bajo, { ...c, cta: 'Ver stock bajo', estado: 'inactivo tras cambiar' })

      await accionable(bajo, 'Ver stock bajo')
      await accionable(agotados, 'Ver agotados')
    })
  }

  for (const [tema, ancho] of MATRIZ) {
    test(`${ancho} ${tema} · «Agregar Primer Producto» del estado vacío`, async ({ page }) => {
      await listaDeInventario(page, 'vacia')
      const cta = page.getByTestId('inventory-new-product-empty')
      await abrir(page, '/inventory', tema, ancho, cta)
      await medir(page, cta, { superficie: 'Inventario', cta: 'Agregar Primer Producto', tema, ancho })
      // En mobile el estado vacío vive dentro de la tabla (Inventario mobile es
      // un lote posterior): se mide el CTA, no la maqueta que lo contiene.
      await accionable(cta, 'Agregar Primer Producto', { dentroDelViewport: ancho === 'desktop' })
    })
  }

  for (const tema of ['light', 'dark'] as Tema[]) {
    test(`desktop ${tema} · «Reintentar» del estado de error`, async ({ page }) => {
      await listaDeInventario(page, 'error')
      const cta = boton(page, 'Reintentar')
      await abrir(page, '/inventory', tema, 'desktop', cta)
      await medir(page, cta, { superficie: 'Inventario', cta: 'Reintentar', tema, ancho: 'desktop' })
      await accionable(cta, 'Reintentar')
    })

    test(`desktop ${tema} · «Crear Variante» del modal de variantes`, async ({ page }) => {
      await abrir(page, '/inventory', tema, 'desktop', page.getByTestId('inventory-new-product-button'))
      // `.first()`: otros specs le crean variantes a este producto y sus filas también lo nombran.
      await page.getByRole('row', { name: /Producto E2E/ }).first().getByTitle('Agregar variante').click()
      const cta = boton(page, 'Crear Variante')
      await medir(page, cta, { superficie: 'Inventario', cta: 'Crear Variante', tema, ancho: 'desktop' })
      await accionable(cta, 'Crear Variante')
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1e Agregar ítem a la orden', () => {
  for (const [tema, ancho] of MATRIZ) {
    test(`${ancho} ${tema} · el CTA y los selectores activos del modal`, async ({ page }) => {
      await abrir(page, ORDEN, tema, ancho, page.getByTestId('order-items-block'))
      await boton(page, 'Agregar ítem').click()
      const c = { superficie: 'Agregar ítem', tema, ancho }

      const cta = boton(page, 'Agregar repuesto')
      await medir(page, cta, { ...c, cta: 'Agregar repuesto' })
      if (ancho === 'desktop') {
        await medir(page, cta, { ...c, cta: 'Agregar repuesto', estado: 'hover' })
      }
      await accionable(cta, 'Agregar repuesto')

      // Tipo: la opción activa lleva fondo de acento.
      await medir(page, boton(page, 'Repuesto'), { ...c, cta: 'Tipo · Repuesto', estado: 'activo' })
      // Moneda: ARS activo es índigo; USD activo es verde.
      await medir(page, boton(page, '$ ARS'), { ...c, cta: 'Moneda · ARS', estado: 'activo' })
      await boton(page, 'USD $').click()
      await medir(page, boton(page, 'USD $'), { ...c, cta: 'Moneda · USD', estado: 'activo' })
      await boton(page, '$ ARS').click()

      await boton(page, 'Servicio').click()
      await medir(page, boton(page, 'Servicio'), { ...c, cta: 'Tipo · Servicio', estado: 'activo' })
      await medir(page, boton(page, 'Agregar servicio'), { ...c, cta: 'Agregar servicio' })

      if (ancho === 'desktop') {
        await capturar(page.getByRole('heading', { name: 'Agregar ítem' }).locator('xpath=../..'), `add-item-${tema}`)
      }
    })
  }

  for (const tema of ['light', 'dark'] as Tema[]) {
    test(`desktop ${tema} · «Guardando...» se sigue leyendo mientras se envía`, async ({ page }) => {
      const descripcion = `Servicio de contraste 1E ${tema}`
      // Se retiene el alta para poder medir el estado intermedio y después se
      // aborta: no llega a escribirse nada.
      let recibida!: () => void
      let soltar!: () => void
      const llego = new Promise<void>(r => { recibida = r })
      const retenida = new Promise<void>(r => { soltar = r })
      await page.route(/\/rest\/v1\/order_items/, async route => {
        if (route.request().method() !== 'POST') return route.fallback()
        recibida()
        await retenida
        return route.abort('failed')
      })

      await abrir(page, ORDEN, tema, 'desktop', page.getByTestId('order-items-block'))
      await boton(page, 'Agregar ítem').click()
      await boton(page, 'Servicio').click()
      await page.getByPlaceholder('Ej: Cambio de pantalla, diagnóstico...').fill(descripcion)
      await boton(page, 'Agregar servicio').click()
      await llego

      const guardando = boton(page, 'Guardando...')
      await expect(guardando).toBeDisabled()
      await medir(page, guardando, { superficie: 'Agregar ítem', cta: 'Guardando...', tema, ancho: 'desktop', estado: 'enviando' }, LEGIBLE_DESHABILITADO)

      soltar()
      await expect(boton(page, 'Agregar servicio')).toBeVisible()
      const { n } = consultarJSON<{ n: number }>(`SELECT count(*)::int AS n FROM public.order_items WHERE descripcion = '${descripcion}'`)
      expect(n, 'medir el estado intermedio no escribió ningún ítem').toBe(0)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1e Notas de la orden', () => {
  for (const [tema, ancho] of MATRIZ) {
    test(`${ancho} ${tema} · «Guardar» de las notas se lee sobre su fondo`, async ({ page }) => {
      await abrir(page, ORDEN, tema, ancho, page.getByTestId('order-detail-grid'))
      await boton(page, 'Notas').click()
      const cta = page.locator('.order-notes-save')
      await expect(cta).toHaveText('Guardar')
      const c = { superficie: 'Notas de la orden', cta: 'Guardar', tema, ancho }
      const m = await medir(page, cta, c)
      if (ancho === 'desktop') {
        await medir(page, cta, { ...c, estado: 'hover' })
        if (tema === 'light') await capturar(cta.locator('xpath=ancestor::div[contains(@class,"card")][1]'), 'order-notes-light')
      } else {
        // BETA-UX-1D: en mobile este botón ya es un target táctil.
        expect(m.height, `«Guardar» mide ${m.height}px de alto`).toBeGreaterThanOrEqual(TOUCH_TARGET - TOUCH_EPSILON)
      }
      await accionable(cta, 'Guardar notas')
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// Los primarios de clase (`.btn-primary`) que viven en estas mismas superficies.
// `.btn-primary` pinta blanco sobre un gradiente índigo → cyan y sobre el cyan
// el blanco no llega a AA. La regla global no se toca en este lote: los
// primarios de acá llevan además `btn-primary-aa`, que les cambia texto y fondo.
test.describe('@beta-ux-1e Botón primario de las superficies', () => {
  const ORDEN_SIN_COMPROBANTE = `/orders/${MOBILE_ORDERS.ordenes.sinEquipo}`
  const fondoComputado = (cta: Locator) => cta.evaluate(el => getComputedStyle(el).backgroundImage)

  /** El primario lleva la variante, se mide en reposo y —si se pide— bajo el puntero. */
  async function medirPrimario(page: Page, cta: Locator, c: Contexto, { hover = false } = {}) {
    await expect(cta).toBeVisible()
    await expect.soft(cta, `«${c.cta}» lleva la variante AA`).toHaveClass(/(^|\s)btn-primary-aa(\s|$)/)
    await medir(page, cta, c)
    if (hover) {
      const fondoEnReposo = await fondoComputado(cta)
      await medir(page, cta, { ...c, estado: 'hover' })
      // Y el hover es OTRO fondo: lo que se midió no es dos veces el de reposo.
      expect.soft(await fondoComputado(cta), `«${c.cta}»: el hover cambia el fondo`).not.toBe(fondoEnReposo)
    }
    await accionable(cta, c.cta)
  }

  /** El cliente tiene crédito sin imputar: es lo que hace aparecer «Imputar crédito». */
  const conCreditoSinImputar = (page: Page) =>
    page.route(/\/rest\/v1\/rpc\/get_customer_unallocated_credit/, route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, authorized: true, unallocated_amount: 5000 }),
    }))

  for (const tema of ['light', 'dark'] as Tema[]) {
    test(`desktop ${tema} · Usuarios e Inventario: «Invitar Usuario» y «Nuevo Producto»`, async ({ page }) => {
      const invitar = page.getByTestId('invite-open')
      await abrir(page, '/users', tema, 'desktop', invitar)
      await medirPrimario(page, invitar, { superficie: 'Usuarios', cta: 'Invitar Usuario', tema, ancho: 'desktop' }, { hover: true })

      const nuevo = page.getByTestId('inventory-new-product-button')
      await abrir(page, '/inventory', tema, 'desktop', nuevo)
      const c = { superficie: 'Inventario', tema, ancho: 'desktop' as Ancho }
      await medirPrimario(page, nuevo, { ...c, cta: 'Nuevo Producto' }, { hover: true })
      // La otra mitad del botón partido no tiene texto: se mide su ícono.
      await medirPrimario(page, page.getByTestId('inventory-new-product-chevron'), { ...c, cta: 'Nuevo Producto · chevron' }, { hover: true })
      if (tema === 'light') {
        // En reposo: el paso anterior dejó el puntero sobre la flecha.
        await page.mouse.move(0, 0)
        await asentar(page)
        await capturar(nuevo.locator('xpath=..'), 'primary-aa-light')
      }
    })

    test(`desktop ${tema} · Detalle de orden con comprobante: «Ver Detalle», «Agregar ítem» y los demás primarios`, async ({ page }) => {
      await conCreditoSinImputar(page)
      await abrir(page, ORDEN, tema, 'desktop', page.getByTestId('order-detail-grid'))
      const c = { superficie: 'Detalle de orden', tema, ancho: 'desktop' as Ancho }

      await medirPrimario(page, page.getByTestId('order-comprobante-card').getByRole('link', { name: 'Ver Detalle' }), { ...c, cta: 'Ver Detalle' }, { hover: true })
      await medirPrimario(page, boton(page, 'Agregar ítem'), { ...c, cta: 'Agregar ítem' }, { hover: true })
      await medirPrimario(page, page.getByTestId('order-allocate-button'), { ...c, cta: 'Imputar crédito' }, { hover: true })

      // «Acceso del equipo» en edición: su «Guardar» es un AppButton primario.
      const acceso = page.locator('.card', { hasText: 'Acceso del equipo' }).last()
      await acceso.getByRole('button', { name: 'Configurar' }).click()
      await medirPrimario(page, acceso.getByRole('button', { name: 'Guardar' }), { ...c, cta: 'Acceso del equipo · Guardar' }, { hover: true })
      await acceso.getByRole('button', { name: 'Cancelar' }).click()

      await boton(page, 'Comunicación').click()
      await medirPrimario(page, boton(page, 'Enviar Notificación'), { ...c, cta: 'Enviar Notificación' }, { hover: true })
    })

    test(`desktop ${tema} · Detalle de orden sin comprobante: «Generar Comprobante» y «Agregar primer ítem»`, async ({ page }) => {
      await abrir(page, ORDEN_SIN_COMPROBANTE, tema, 'desktop', page.getByTestId('order-detail-grid'))
      const c = { superficie: 'Detalle de orden', tema, ancho: 'desktop' as Ancho }
      const generar = page.getByTestId('order-primary-action')
      await expect(generar).toHaveText('Generar Comprobante')
      await medirPrimario(page, generar, { ...c, cta: 'Generar Comprobante' }, { hover: true })
      await medirPrimario(page, boton(page, 'Agregar primer ítem'), { ...c, cta: 'Agregar primer ítem' }, { hover: true })
    })

    test(`mobile ${tema} · los primarios de las tres pantallas`, async ({ page }) => {
      const m = { tema, ancho: 'mobile' as Ancho }
      const invitar = page.getByTestId('invite-open')
      await abrir(page, '/users', tema, 'mobile', invitar)
      await medirPrimario(page, invitar, { ...m, superficie: 'Usuarios', cta: 'Invitar Usuario' })

      const nuevo = page.getByTestId('inventory-new-product-button')
      await abrir(page, '/inventory', tema, 'mobile', nuevo)
      await medirPrimario(page, nuevo, { ...m, superficie: 'Inventario', cta: 'Nuevo Producto' })
      await medirPrimario(page, page.getByTestId('inventory-new-product-chevron'), { ...m, superficie: 'Inventario', cta: 'Nuevo Producto · chevron' })

      await abrir(page, ORDEN_SIN_COMPROBANTE, tema, 'mobile', page.getByTestId('order-detail-grid'))
      const generar = page.getByTestId('order-primary-action')
      const d = { ...m, superficie: 'Detalle de orden' }
      const medida = await medir(page, generar, { ...d, cta: 'Generar Comprobante' })
      await expect.soft(generar).toHaveClass(/(^|\s)btn-primary-aa(\s|$)/)
      // BETA-UX-1D: en mobile la acción principal de la orden es un target táctil.
      expect(medida.height, `«Generar Comprobante» mide ${medida.height}px de alto`).toBeGreaterThanOrEqual(TOUCH_TARGET - TOUCH_EPSILON)
      await medirPrimario(page, boton(page, 'Agregar primer ítem'), { ...d, cta: 'Agregar primer ítem' })

      await abrir(page, ORDEN, tema, 'mobile', page.getByTestId('order-detail-grid'))
      await medirPrimario(page, page.getByTestId('order-comprobante-card').getByRole('link', { name: 'Ver Detalle' }), { ...d, cta: 'Ver Detalle' })
      await medirPrimario(page, boton(page, 'Agregar ítem'), { ...d, cta: 'Agregar ítem' })
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1e Acceso del equipo', () => {
  for (const [tema, ancho] of MATRIZ) {
    test(`${ancho} ${tema} · la etiqueta «Cifrado · interno», el estado y el ícono se leen`, async ({ page }) => {
      await abrir(page, ORDEN, tema, ancho, page.getByTestId('order-detail-grid'))
      const etiqueta = page.getByText('Cifrado · interno', { exact: true })
      await medir(page, etiqueta, { superficie: 'Acceso del equipo', cta: 'Cifrado · interno', tema, ancho })
      const tarjeta = page.locator('.card', { hasText: 'Acceso del equipo' }).last()

      // Los otros dos textos de la tarjeta que heredaban el color de Bootstrap:
      // el estado («PIN configurado») y el ícono del encabezado.
      await medir(page, tarjeta.getByText(/configurado$/), { superficie: 'Acceso del equipo', cta: 'PIN configurado', tema, ancho })
      const icono = await contrastOf(tarjeta.locator('.card-header svg').first())
      expect.soft(icono.ratio, `ícono del encabezado · ${tema}: ${icono.foreground} sobre ${icono.background} = ${icono.ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(NO_TEXTO)

      if (ancho === 'desktop') await capturar(tarjeta, `device-lock-badge-${tema}`)
      // La etiqueta entra entera en el encabezado de su tarjeta.
      const [e, t] = [await etiqueta.boundingBox(), await tarjeta.boundingBox()]
      expect(e && t && e.x >= t.x - 1 && e.x + e.width <= t.x + t.width + 1, 'la etiqueta queda dentro de su tarjeta').toBe(true)
    })
  }
})
