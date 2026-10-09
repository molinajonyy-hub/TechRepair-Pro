// ============================================================================
// BETA-UX-1F — Inicio como centro operativo, medido en el navegador.
//
//   npx playwright test --project=m7-local --grep @beta-ux-1f
//
//   DASHBOARD = operación.   FINANZAS = dinero.
//
// Los tests de componentes (`tests/components/betaUx1fDashboard.test.tsx`)
// montan Inicio con sus hooks reales sobre un Supabase simulado. jsdom no aplica
// `index.css` ni tiene un servidor: acá se mide lo que sólo existe con el CSS
// servido y con la base real —
//
//   · la composición: encabezado, «Hoy», Mis tareas y órdenes recientes, en ese
//     orden, sin desborde a 375 / 390 / 430 px y con todo lo tocable en 44 px;
//   · que NADIE ve un importe en Inicio, y que la página no PIDE las fuentes
//     financieras que dejó de mostrar (contrato de red);
//   · Caja y dólar en la barra superior (escritorio) y en la fila de utilidades
//     (mobile), con la capacidad real de cada actor;
//   · el contraste pintado de lo que el lote agregó, en claro y en oscuro.
//
// ACTORES. El dueño E2E, y dos empleados REALES (usuario propio + perfil en el
// negocio E2E, login por la pantalla): un técnico, sin `finance` ni
// `comprobantes`, y un vendedor, con `comprobantes` y sin `finance`.
//
// DATOS. Fixture propio (`seedDashboardFixture`). Los números esperados NO están
// escritos acá: se leen de la base en el momento, porque el negocio E2E es
// compartido y otros specs crean órdenes. El «negocio nuevo» se obtiene
// parcheando EN EL NAVEGADOR las respuestas reales: se simula la ENTRADA de la
// pantalla; el layout y el CSS son los servidos.
//
// COTIZACIÓN. El stack local no tiene la Edge Function del dólar: el fixture
// base responde «sin fuente» y este spec, donde hace falta ver el chip, responde
// una cotización fija sin guardarla en la base (helpers/dollarRate.ts).
// ============================================================================
import { test, expect } from './fixtures'
import type { Browser, Locator, Page, Request } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { AA_SMALL_TEXT, applyTheme, paintedContrastOf } from '../helpers/contrast'
import { conCotizacion } from '../helpers/dollarRate'
import { consultarJSON } from '../setup/sqlLocal.ts'
import { E2E } from '../setup/seedE2E.ts'
import {
  DASHBOARD_1F, DASHBOARD_1F_TEXT,
  borrarPerfilActor, limpiarDashboard, sembrarDashboard, sembrarPerfilActor,
} from '../setup/seedDashboardFixture.ts'

type Tema = 'light' | 'dark'

const TOUCH_TARGET = 44
/** Ruido float32 de la transformación de entrada; ver dialog-touch-actions.spec.ts. */
const TOUCH_EPSILON = 0.01
const TOL = 1

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 375, height: 812 }

/** Capturas de evidencia: sólo a pedido, para no reescribir PNG versionados en cada corrida. */
const EVIDENCIA = process.env.BETA_UX_1F_EVIDENCE === '1' ? 'docs/beta-ux-1/evidence-1f' : null

const O = DASHBOARD_1F.ordenes
const X = DASHBOARD_1F_TEXT
const corto = (id: string) => `#${id.slice(0, 8).toUpperCase()}`

// La app decide «vencida» con el reloj del navegador y «para hoy» con la fecha
// argentina. El taller está en Argentina: se mide como lo ve el usuario, y el
// resultado no depende de la hora UTC a la que corra CI.
test.use({ timezoneId: 'America/Argentina/Cordoba', deviceScaleFactor: 2 })

// ─── Actores ────────────────────────────────────────────────────────────────

const TECNICO_STATE = 'tests/e2e/.auth/beta-ux-1f-tecnico.json'
const VENDEDOR_STATE = 'tests/e2e/.auth/beta-ux-1f-vendedor.json'

/** Cliente de servicio del stack LOCAL, sólo en Node y sólo para los usuarios de Auth. */
const adminLocal = () => createClient(process.env.VITE_SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function prepararActor(
  browser: Browser, baseURL: string,
  actor: { email: string; password: string; rol: string; nombre: string }, statePath: string,
): Promise<string> {
  const admin = adminLocal()
  const { data: existentes } = await admin.auth.admin.listUsers()
  let usuario = existentes?.users?.find(u => u.email === actor.email) ?? null
  if (usuario) {
    await admin.auth.admin.updateUserById(usuario.id, { password: actor.password, email_confirm: true })
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email: actor.email, password: actor.password, email_confirm: true })
    if (error || !data.user) throw new Error(`No se pudo crear el actor E2E ${actor.rol}: ${error?.message}`)
    usuario = data.user
  }
  sembrarPerfilActor(usuario.id, actor)

  // Login REAL por la pantalla, igual que el globalSetup: no se inyecta sesión.
  const contexto = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' })
  const pagina = await contexto.newPage()
  await pagina.goto('/login', { waitUntil: 'networkidle' })
  await pagina.getByTestId('login-email').fill(actor.email)
  await pagina.getByTestId('login-password').fill(actor.password)
  await pagina.getByTestId('login-submit').click()
  await pagina.waitForURL(u => !u.pathname.includes('/login'), { timeout: 20_000 })
  if (pagina.url().includes('/no-business')) throw new Error(`El actor E2E ${actor.rol} no resolvió su negocio.`)
  await contexto.storageState({ path: statePath })
  await contexto.close()
  return usuario.id
}

let tecnicoId = ''
let vendedorId = ''

test.beforeAll(async ({ browser }, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL)
  tecnicoId = await prepararActor(browser, baseURL, DASHBOARD_1F.tecnico, TECNICO_STATE)
  vendedorId = await prepararActor(browser, baseURL, DASHBOARD_1F.vendedor, VENDEDOR_STATE)
  sembrarDashboard(tecnicoId)
})

test.afterAll(async () => {
  limpiarDashboard()
  for (const userId of [tecnicoId, vendedorId]) {
    if (!userId) continue
    borrarPerfilActor(userId)
    await adminLocal().auth.admin.deleteUser(userId)
  }
})

// ─── Verdad de la base ──────────────────────────────────────────────────────

interface Operacion { activas: number; listas: number; aprobacion: number; nuevas_hoy: number }
const operacionEnBase = () => consultarJSON<Operacion>(`
  SELECT (count(*) - count(*) FILTER (WHERE status = 'completed') - count(*) FILTER (WHERE status = 'cancelled'))::int AS activas,
         count(*) FILTER (WHERE status = 'ready_delivery')::int AS listas,
         count(*) FILTER (WHERE status = 'waiting_approval')::int AS aprobacion,
         count(*) FILTER (WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'America/Argentina/Cordoba')
                                               AT TIME ZONE 'America/Argentina/Cordoba'))::int AS nuevas_hoy
    FROM public.orders WHERE business_id = '${E2E.business}'`)

const recientesEnBase = () => consultarJSON<{ ids: string[] }>(`
  SELECT coalesce(json_agg(x.id), '[]'::json) AS ids
    FROM (SELECT id FROM public.orders WHERE business_id = '${E2E.business}' ORDER BY created_at DESC LIMIT 5) x`).ids

interface Tareas { pendientes: number; hoy: number; vencidas: number }
const tareasEnBase = (userId: string) => consultarJSON<Tareas>(`
  SELECT count(*) FILTER (WHERE t.status = 'pending')::int AS pendientes,
         count(*) FILTER (WHERE t.status NOT IN ('completed', 'cancelled') AND t.due_date = h.hoy)::int AS hoy,
         count(*) FILTER (WHERE t.status NOT IN ('completed', 'cancelled') AND t.due_date < h.hoy)::int AS vencidas
    FROM public.tasks t, (SELECT (now() AT TIME ZONE 'America/Argentina/Cordoba')::date AS hoy) h
   WHERE t.business_id = '${E2E.business}' AND (t.assigned_to = '${userId}' OR t.user_id = '${userId}')`)

const cajaAbiertaEnBase = () => consultarJSON<{ n: number }>(
  `SELECT count(*)::int AS n FROM public.cajas WHERE business_id = '${E2E.business}' AND status = 'abierta'`).n > 0

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Espera a que terminen las animaciones de entrada: una caja a media escala mide de menos. */
const asentar = (page: Page) =>
  page.evaluate(() => Promise.all(document.getAnimations()
    .filter(a => a.effect?.getComputedTiming().iterations !== Infinity)
    .map(a => a.finished.catch(() => undefined))))

async function abrir(page: Page, tema: Tema, vp: { width: number; height: number }, { cotizacion = true } = {}) {
  await applyTheme(page, tema)
  await page.setViewportSize(vp)
  if (cotizacion) await conCotizacion(page)
  await page.goto('/dashboard')
  await expect(page.getByTestId('dashboard-today')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('dashboard-tasks-loading')).toHaveCount(0, { timeout: 15_000 })
  await page.waitForLoadState('networkidle')
  await asentar(page)
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'tema aplicado').toBe(tema)
}

const caja = async (l: Locator) => {
  const b = await l.boundingBox()
  if (!b) throw new Error('elemento sin caja')
  return b
}

const inicio = (page: Page) => page.getByTestId('dashboard-page')
/** Los chips del shell que SE VEN en este ancho. */
const utilidades = (page: Page, movil: boolean) =>
  page.getByTestId(movil ? 'mobile-utility-bar' : 'top-header-utilities')

/**
 * Desborde horizontal REAL. `#root` recorta lo que se le sale, así que mirar
 * sólo `scrollWidth` daría verde con contenido cortado: se busca además
 * cualquier elemento que termine fuera del viewport.
 */
const desbordeHorizontal = (page: Page) => page.evaluate(() => {
  const exceso = (el: Element | null) => (el ? el.scrollWidth - el.clientWidth : 0)
  const ancho = document.documentElement.clientWidth
  let fuera = 0
  let culpable = ''
  for (const el of document.querySelectorAll('.main-layout-inner *, .mobile-app-header *')) {
    if (el.closest('.table-wrap, .tabs, [style*="overflow-x: auto"]')) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const e = Math.max(r.right - ancho, -r.left)
    if (e > fuera) { fuera = e; culpable = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}` }
  }
  return { px: Math.max(exceso(document.documentElement), exceso(document.getElementById('root')), fuera), culpable }
})

/** Contenido que una tarjeta está RECORTANDO a lo ancho (`overflow: hidden` no desborda: esconde). */
const recortes = (page: Page) => page.evaluate(() => {
  const out: string[] = []
  const contenedores = '.dash-today, .dash-tasks, .dash-orders, .dash-actions, .mobile-utility-bar, .top-header__utilities, .compact-list__item'
  for (const cont of document.querySelectorAll<HTMLElement>(contenedores)) {
    const c = cont.getBoundingClientRect()
    if (c.width === 0) continue
    for (const el of cont.querySelectorAll<HTMLElement>('*')) {
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

/** Todo lo que se puede tocar en Inicio y en el shell mobile, en una sola evaluación. */
const controlesChicos = (page: Page) => page.evaluate((minimo) => {
  const visibles = [...document.querySelectorAll<HTMLElement>(
    '[data-testid="dashboard-page"] button, [data-testid="dashboard-page"] a[href], [data-testid="dashboard-page"] [role="link"], '
    + '[data-testid="mobile-utility-bar"] button, [data-testid="mobile-utility-bar"] a[href], .mobile-app-header button',
  )].filter(el => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  })
  return {
    total: visibles.length,
    chicos: visibles
      .map(el => { const r = el.getBoundingClientRect(); return { nombre: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), w: r.width, h: r.height } })
      .filter(c => c.w < minimo || c.h < minimo)
      .map(c => `«${c.nombre}» ${Math.round(c.w * 10) / 10}×${Math.round(c.h * 10) / 10}`),
  }
}, TOUCH_TARGET - TOUCH_EPSILON)

/** Ningún importe: ni un `$`, ni un número con separador de miles, ni una moneda. */
async function sinImportes(l: Locator, donde: string) {
  const texto = (await l.innerText()).replace(/\s+/g, ' ')
  expect(texto, `${donde} muestra un símbolo de moneda`).not.toMatch(/\$/)
  expect(texto, `${donde} muestra un número con forma de importe`).not.toMatch(/\b\d{1,3}\.\d{3}\b/)
  expect(texto, `${donde} nombra una moneda`).not.toMatch(/\b(ARS|USD)\b/)
}

/** Lo que Inicio ya no es. */
async function sinRestosFinancieros(page: Page) {
  for (const texto of [/Ganancia Real/i, /Cobrado en caja/i, /Caja neta/i, /Accesos rápidos/i, /Movimientos de Caja/i, /Comprobantes Recientes/i, /Bienvenido a TechRepair/i]) {
    await expect(inicio(page).getByText(texto), `quedó «${texto}» en Inicio`).toHaveCount(0)
  }
  for (const testId of ['dash-ganancia-real', 'dash-estado-caja', 'dashboard-quick-actions', 'dashboard-kpis']) {
    await expect(page.getByTestId(testId), `quedó ${testId}`).toHaveCount(0)
  }
  await expect(inicio(page).getByRole('tab')).toHaveCount(0)
}

async function enReposo(page: Page, l: Locator) {
  await page.mouse.move(0, 0)
  await asentar(page)
  expect(await l.evaluate(el => el.matches(':hover')), 'se mide en reposo, sin el puntero encima').toBe(false)
}

async function bajoElPuntero(page: Page, l: Locator) {
  await l.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
  await l.hover()
  await asentar(page)
  expect(await l.evaluate(el => el.matches(':hover')), 'se mide con el puntero encima').toBe(true)
}

/** Contraste PINTADO (ve gradientes y capas) de un texto, en reposo o con hover. */
async function legible(page: Page, l: Locator, nombre: string, tema: Tema, estado: 'normal' | 'hover' = 'normal') {
  await expect(l, `${nombre}: no está a la vista`).toBeVisible()
  if (estado === 'hover') await bajoElPuntero(page, l)
  else await enReposo(page, l)
  const m = await paintedContrastOf(l)
  expect.soft(
    m.ratio,
    `${nombre} · ${tema} · ${estado}: texto ${m.foreground} sobre ${m.backgroundWorst} = ${m.ratio.toFixed(2)}:1`,
  ).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
}

async function capturar(page: Page, nombre: string, fullPage = true) {
  if (!EVIDENCIA) return
  await page.mouse.move(0, 0)
  await page.screenshot({ path: `${EVIDENCIA}/${nombre}.png`, fullPage, caret: 'initial', animations: 'disabled' })
}

const accion = (page: Page, nombre: string) =>
  page.getByTestId('dashboard-actions').getByRole('button', { name: nombre, exact: true })

// ─── Contrato de red ────────────────────────────────────────────────────────

/** Fuentes financieras que Inicio consumía. No pueden volver a salir de `/dashboard`. */
const FUENTES_RETIRADAS = [
  /\/rest\/v1\/business_finance_entries\b/,
  /\/rest\/v1\/v_finance_/,
  /\/rest\/v1\/comprobante_items\b/,
  /\/rest\/v1\/comprobante_payments\b/,
  /\/rest\/v1\/comprobantes\b/,
  /\/rest\/v1\/financial_movements\b/,
  /\/rest\/v1\/accounts\b/,
  /\/rest\/v1\/rpc\/get_order_financial_amounts\b/,
  /\/rest\/v1\/rpc\/finance_dashboard_summary\b/,
  /\/rest\/v1\/rpc\/can_view_cogs\b/,
]

interface Pedido { metodo: string; ruta: string }

/** Registra TODOS los requests a la API de datos desde antes de navegar. */
function grabarRed(page: Page): Pedido[] {
  const pedidos: Pedido[] = []
  page.on('request', (req: Request) => {
    const url = new URL(req.url())
    if (!url.pathname.startsWith('/rest/v1/')) return
    pedidos.push({ metodo: req.method(), ruta: url.pathname })
  })
  return pedidos
}

function sinFuentesRetiradas(pedidos: Pedido[], quien: string) {
  const prohibidos = pedidos.filter(p => FUENTES_RETIRADAS.some(f => f.test(p.ruta)))
  expect(prohibidos.map(p => `${p.metodo} ${p.ruta}`), `${quien}: Inicio pidió fuentes financieras retiradas`).toEqual([])
  // El conteo de clientes del Dashboard viejo era un HEAD; la precarga del shell
  // (que no es de Inicio) usa GET.
  expect(pedidos.filter(p => p.metodo === 'HEAD' && p.ruta.endsWith('/customers')), `${quien}: volvió el conteo de clientes`).toEqual([])
}

const de = (pedidos: Pedido[], tabla: string, metodo?: string) =>
  pedidos.filter(p => p.ruta === `/rest/v1/${tabla}` && (!metodo || p.metodo === metodo))

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1f A · dueño con datos · escritorio', () => {
  for (const tema of ['light', 'dark'] as const) {
    test(`1440×900 · ${tema} · composición, indicadores, barra superior y contraste`, async ({ page }) => {
      await abrir(page, tema, DESKTOP)
      await sinDesborde(page, `Inicio a 1440 (${tema})`)
      await sinRestosFinancieros(page)

      // ── Encabezado ──────────────────────────────────────────────────────
      await expect(inicio(page).getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible()
      await expect(inicio(page).getByText('Tu taller hoy')).toBeVisible()
      const nombres = await page.getByTestId('dashboard-actions').getByRole('button')
        .evaluateAll(bs => bs.map(b => (b.textContent || b.getAttribute('aria-label') || '').trim()))
      expect(nombres).toEqual(['Nueva Orden', 'Nuevo Comprobante', 'Gestionar Caja', 'Registrar gasto', 'Actualizar datos'])
      // La principal es la más alta de la fila y llega a 44 px.
      const principal = await caja(accion(page, 'Nueva Orden'))
      expect(principal.height).toBeGreaterThanOrEqual(TOUCH_TARGET - TOUCH_EPSILON)
      for (const nombre of ['Nuevo Comprobante', 'Gestionar Caja', 'Registrar gasto']) {
        expect((await caja(accion(page, nombre))).height, `«${nombre}» no puede ser más alta que la principal`).toBeLessThanOrEqual(principal.height + TOL)
      }
      // La clase de la variante, exacta: `btn-danger-aa` sola no es la variante.
      await expect(accion(page, 'Registrar gasto')).toHaveClass(/(^|\s)btn-danger(\s|$)/)

      // ── Orden de los bloques: Hoy → Mis tareas → Órdenes recientes ──────
      const ys: number[] = []
      for (const bloque of ['dashboard-actions', 'dashboard-today', 'dashboard-tasks', 'dashboard-recent-orders']) {
        ys.push((await caja(page.getByTestId(bloque))).y)
      }
      expect(ys, 'los bloques no están en el orden acordado').toEqual([...ys].sort((a, b) => a - b))
      // Tareas es protagonista: ocupa el ancho del contenido, igual que «Hoy».
      const hoy = await caja(page.getByTestId('dashboard-today'))
      const tareas = await caja(page.getByTestId('dashboard-tasks'))
      expect(Math.abs(tareas.width - hoy.width), 'Mis tareas no es de ancho completo').toBeLessThanOrEqual(TOL)

      // ── Indicadores: la verdad de la base ───────────────────────────────
      const base = operacionEnBase()
      await expect(page.getByTestId('dashboard-today-active').locator('.dash-today__value')).toHaveText(String(base.activas))
      await expect(page.getByTestId('dashboard-today-ready').locator('.dash-today__value')).toHaveText(String(base.listas))
      await expect(page.getByTestId('dashboard-today-waiting').locator('.dash-today__value')).toHaveText(String(base.aprobacion))
      expect(base.listas, 'el fixture tiene una orden lista para entregar').toBeGreaterThanOrEqual(1)
      expect(base.aprobacion, 'el fixture tiene una orden esperando aprobación').toBeGreaterThanOrEqual(1)
      // Tres en una fila.
      const cajasHoy = await page.getByTestId('dashboard-today').getByRole('link').evaluateAll(ls => ls.map(l => Math.round(l.getBoundingClientRect().top)))
      expect(new Set(cajasHoy).size, 'los tres indicadores no están en una fila').toBe(1)
      expect(cajasHoy).toHaveLength(3)

      // ── Órdenes recientes: las cinco últimas de la base, como tabla ─────
      const esperadas = recientesEnBase()
      expect(esperadas).toEqual([O.reparacion, O.lista, O.aprobacion, O.sinDatos, O.diagnostico])
      const tabla = page.getByTestId('dashboard-recent-orders-table')
      await expect(tabla).toBeVisible()
      await expect(page.getByTestId('dashboard-recent-orders-list')).toBeHidden()
      await expect(tabla.getByRole('columnheader')).toHaveText(['Orden', 'Cliente', 'Dispositivo', 'Estado', 'Fecha'])
      const filas = page.getByTestId('dashboard-recent-order-row')
      await expect(filas).toHaveCount(5)
      expect(await filas.evaluateAll(fs => fs.map(f => f.querySelector('td')?.textContent?.trim()))).toEqual(esperadas.map(corto))
      await expect(filas.nth(1)).toContainText('Listo para Entregar')
      await expect(filas.nth(2)).toContainText('Esperando Aprobación')
      await expect(filas.nth(3)).toContainText('Sin cliente')
      await expect(filas.nth(3)).toContainText('Sin dispositivo')
      await expect(tabla.getByRole('button')).toHaveCount(0)
      expect(await tabla.innerText()).not.toMatch(/ready_delivery|waiting_approval|null|undefined/)

      // ── Mis tareas ──────────────────────────────────────────────────────
      const mias = tareasEnBase(E2E.owner)
      await expect(page.getByTestId('dashboard-tasks-overdue')).toHaveText(`${mias.vencidas}Vencidas`)
      await expect(page.getByTestId('dashboard-tasks-today')).toHaveText(`${mias.hoy}Para hoy`)
      await expect(page.getByTestId('dashboard-tasks-pending')).toHaveText(`${mias.pendientes}Pendientes`)
      await expect(page.getByTestId('dashboard-tasks-summary').getByText('Completadas')).toHaveCount(0)
      const vencida = page.getByTestId('dashboard-task').filter({ hasText: X.tareaVencidaAlta })
      await expect(vencida).toHaveAttribute('data-overdue', 'true')
      await expect(vencida).toContainText('Vencida')
      await expect(page.getByTestId('dashboard-task').filter({ hasText: X.tareaHoy })).toContainText('Hoy')
      await expect(page.getByTestId('dashboard-task')).toHaveCount(Math.min(5, mias.pendientes))
      // Ni la completada ni la de otro usuario.
      await expect(page.getByTestId('dashboard-tasks').getByText(X.tareaCompletada)).toHaveCount(0)
      await expect(page.getByTestId('dashboard-tasks').getByText(X.tareaDelTecnico)).toHaveCount(0)

      // ── Barra superior: Caja y dólar, compactos, sin importes del negocio ─
      const barra = utilidades(page, false)
      await expect(barra).toBeVisible()
      await expect(page.getByTestId('mobile-utility-bar')).toBeHidden()
      const chipCaja = barra.getByTestId('shell-caja-chip')
      const abierta = cajaAbiertaEnBase()
      await expect(chipCaja).toHaveAttribute('data-state', abierta ? 'open' : 'closed')
      await expect(chipCaja).toContainText(abierta ? 'Caja abierta' : 'Caja cerrada')
      await expect(chipCaja).toHaveAttribute('href', '/caja')
      // Sólo el estado y, si está abierta, desde cuándo. Ni saldo ni ventas.
      expect((await chipCaja.innerText()).replace(/\s+/g, ' ').trim()).toMatch(/^Caja (abierta|cerrada) ?(desde \d{2}:\d{2})?$/)
      const chipDolar = barra.getByTestId('shell-dollar-chip')
      await expect(chipDolar).toContainText('USD')
      await expect(chipDolar).toContainText('$1.556')
      // A la derecha del buscador, y son chips: ninguno ocupa el ancho de la barra.
      const buscador = await caja(page.getByTestId('global-search-trigger'))
      const cChip = await caja(chipCaja)
      expect(cChip.x, 'la caja no quedó a la derecha del buscador').toBeGreaterThanOrEqual(buscador.x + buscador.width - TOL)
      expect(cChip.width, 'la caja volvió a ser una franja').toBeLessThan(260)
      expect(cChip.height).toBeLessThanOrEqual(TOUCH_TARGET)

      // ── Nadie ve importes en Inicio: tampoco el dueño ───────────────────
      await sinImportes(inicio(page), `Inicio del dueño (${tema})`)

      await capturar(page, `dashboard-owner-desktop-${tema}`)

      // ── Contraste pintado de lo que el lote agregó ──────────────────────
      await legible(page, inicio(page).locator('.page-subtitle'), 'subtítulo «Tu taller hoy»', tema)
      for (const nombre of ['Nueva Orden', 'Nuevo Comprobante', 'Gestionar Caja', 'Registrar gasto']) {
        await legible(page, accion(page, nombre), `«${nombre}»`, tema)
        await legible(page, accion(page, nombre), `«${nombre}»`, tema, 'hover')
      }
      await legible(page, chipCaja.locator('.shell-chip__label'), 'chip de caja · estado', tema)
      if (abierta) await legible(page, chipCaja.locator('.shell-chip__meta'), 'chip de caja · «desde»', tema)
      await legible(page, chipDolar.locator('.shell-chip__unit'), 'chip de dólar · «USD»', tema)
      await legible(page, chipDolar.locator('.shell-chip__value'), 'chip de dólar · valor', tema)
      for (const clave of ['active', 'ready', 'waiting']) {
        const item = page.getByTestId(`dashboard-today-${clave}`)
        await legible(page, item.locator('.dash-today__value'), `Hoy · ${clave} · valor`, tema)
        await legible(page, item.locator('.dash-today__label'), `Hoy · ${clave} · etiqueta`, tema)
      }
      for (const clave of ['overdue', 'today', 'pending']) {
        const stat = page.getByTestId(`dashboard-tasks-${clave}`)
        await legible(page, stat.locator('.dash-tasks__stat-value'), `Tareas · ${clave} · valor`, tema)
        await legible(page, stat.locator('.dash-tasks__stat-label'), `Tareas · ${clave} · etiqueta`, tema)
      }
      await legible(page, page.getByTestId('dashboard-tasks').getByRole('button', { name: 'Nueva tarea' }), '«Nueva tarea»', tema)
      await legible(page, vencida.locator('.dash-task__due'), 'tarea vencida · vencimiento', tema)
      await legible(page, vencida.locator('.dash-task__title'), 'tarea · título', tema)
      await legible(page, vencida.locator('.dash-task__priority'), 'tarea · prioridad', tema)
      await legible(page, page.getByTestId('dashboard-task').filter({ hasText: X.tareaHoy }).locator('.dash-task__due'), 'tarea de hoy · vencimiento', tema)
      await legible(page, filas.first().locator('.dash-orders__id'), 'órdenes · número', tema)
      await legible(page, filas.first().locator('.dash-status'), 'órdenes · estado', tema)
      await legible(page, tabla.getByRole('columnheader').first(), 'órdenes · encabezado de columna', tema)
    })
  }

  test('1440×96 · la barra superior, sola (evidencia)', async ({ page }) => {
    await abrir(page, 'light', DESKTOP)
    await expect(utilidades(page, false).getByTestId('shell-dollar-chip')).toContainText('$1.556')
    if (EVIDENCIA) {
      await page.locator('.top-header').screenshot({ path: `${EVIDENCIA}/top-header-utilities.png`, caret: 'initial', animations: 'disabled' })
    }
  })

  test('la fila de una orden reciente abre su detalle; el número es un enlace real', async ({ page }) => {
    await abrir(page, 'light', DESKTOP, { cotizacion: false })
    const fila = page.getByTestId('dashboard-recent-order-row').nth(1)
    await expect(fila.getByRole('link', { name: corto(O.lista) })).toHaveAttribute('href', `/orders/${O.lista}`)
    // Se toca una celda que no es el enlace: la fila entera responde.
    await fila.locator('td').nth(2).click()
    await expect(page).toHaveURL(new RegExp(`/orders/${O.lista}$`))
  })

  test('«Nueva tarea» abre el formulario real del módulo de Tareas', async ({ page }) => {
    await abrir(page, 'light', DESKTOP, { cotizacion: false })
    await page.getByTestId('dashboard-tasks').getByRole('button', { name: 'Nueva tarea' }).click()
    await expect(page).toHaveURL(/\/tasks$/)
    await expect(page.getByPlaceholder('¿Qué hay que hacer?')).toBeVisible({ timeout: 15_000 })
    // No quedó un modal propio de Inicio por detrás.
    await expect(page.getByTestId('dashboard-page')).toHaveCount(0)
  })

  test('completar una tarea es un tap, y queda completada en la base', async ({ page }) => {
    // Este test escribe: repone el fixture para que un reintento arranque igual.
    sembrarDashboard(tecnicoId)
    await abrir(page, 'light', DESKTOP, { cotizacion: false })
    const antes = tareasEnBase(E2E.owner)
    const fila = page.getByTestId('dashboard-task').filter({ hasText: X.tareaHoy })
    await expect(fila).toBeVisible()

    await fila.getByTitle('Completar tarea').click()

    await expect(page.getByTestId('dashboard-task').filter({ hasText: X.tareaHoy })).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(() => consultarJSON<{ status: string }>(
      `SELECT status FROM public.tasks WHERE id = '${DASHBOARD_1F.tareas.hoy}'`).status).toBe('completed')
    // Los contadores siguen a la base, no a una resta local.
    await expect(page.getByTestId('dashboard-tasks-today')).toHaveText(`${antes.hoy - 1}Para hoy`)
    await expect(page.getByTestId('dashboard-tasks-pending')).toHaveText(`${antes.pendientes - 1}Pendientes`)
    // No pidió nota de cierre.
    await expect(page.locator('textarea')).toHaveCount(0)

    sembrarDashboard(tecnicoId)
  })

  test('contrato de red: `/dashboard` no pide las fuentes financieras retiradas, ni al actualizar', async ({ page }) => {
    const pedidos = grabarRed(page)
    await abrir(page, 'light', DESKTOP)

    // Control positivo: el grabador ve la red, e Inicio pidió lo suyo.
    expect(de(pedidos, 'orders', 'HEAD').length, 'conteos de órdenes').toBeGreaterThanOrEqual(6)
    expect(de(pedidos, 'orders', 'GET').length, 'lista de órdenes recientes').toBeGreaterThanOrEqual(1)
    expect(de(pedidos, 'tasks', 'GET').length, 'tareas del usuario').toBeGreaterThanOrEqual(2)
    // El estado de la caja (sin importes) es la excepción válida: lo lee el shell.
    expect(de(pedidos, 'cajas', 'GET').length, 'estado de la caja').toBeGreaterThanOrEqual(1)
    sinFuentesRetiradas(pedidos, 'dueño, al entrar')

    // «Actualizar» vuelve a leer lo mismo, sin recargar el navegador.
    await page.evaluate(() => { (window as unknown as { __SIN_RECARGA__?: boolean }).__SIN_RECARGA__ = true })
    const conteosAntes = de(pedidos, 'orders', 'HEAD').length
    const tareasAntes = de(pedidos, 'tasks', 'GET').length
    await accion(page, 'Actualizar datos').click()
    await expect.poll(() => de(pedidos, 'orders', 'HEAD').length).toBeGreaterThanOrEqual(conteosAntes + 6)
    await expect.poll(() => de(pedidos, 'tasks', 'GET').length).toBeGreaterThan(tareasAntes)
    await page.waitForLoadState('networkidle')
    expect(await page.evaluate(() => (window as unknown as { __SIN_RECARGA__?: boolean }).__SIN_RECARGA__), 'Actualizar recargó el navegador').toBe(true)
    await expect(page).toHaveURL(/\/dashboard$/)
    sinFuentesRetiradas(pedidos, 'dueño, al actualizar')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1f A · dueño con datos · mobile', () => {
  for (const tema of ['light', 'dark'] as const) {
    test(`375×812 · ${tema} · misma jerarquía, composición adaptada`, async ({ page }) => {
      await abrir(page, tema, MOBILE)
      await sinDesborde(page, `Inicio a 375 (${tema})`)
      await sinRestosFinancieros(page)

      // ── Shell: la barra de escritorio no se ve; los chips van en su fila ─
      await expect(page.locator('.top-header')).toBeHidden()
      const fila = utilidades(page, true)
      await expect(fila).toBeVisible()
      const chipCaja = fila.getByTestId('shell-caja-chip')
      const chipDolar = fila.getByTestId('shell-dollar-chip')
      await expect(chipCaja).toBeVisible()
      await expect(chipDolar).toContainText('$1.556')
      // Una sola fila, debajo de la barra del shell y arriba del título.
      const barra = await caja(page.locator('.mobile-app-header'))
      const cCaja = await caja(chipCaja)
      const cDolar = await caja(chipDolar)
      const titulo = await caja(inicio(page).getByRole('heading', { level: 1, name: 'Inicio' }))
      expect(cCaja.y).toBeGreaterThanOrEqual(barra.y + barra.height - TOL)
      expect(Math.abs(cCaja.y - cDolar.y), 'Caja y dólar no están en la misma fila').toBeLessThanOrEqual(TOL)
      expect(titulo.y).toBeGreaterThanOrEqual(cCaja.y + cCaja.height - TOL)
      // La barra del shell sigue con sus tres controles: no se le sumó ninguno.
      await expect(page.locator('.mobile-app-header button')).toHaveCount(3)

      // ── Acciones: la principal a todo el ancho; el resto, en una fila ───
      const contenido = await caja(page.getByTestId('dashboard-today'))
      const principal = await caja(accion(page, 'Nueva Orden'))
      expect(Math.abs(principal.width - contenido.width), '«Nueva Orden» no ocupa el ancho').toBeLessThanOrEqual(TOL)
      expect(principal.height).toBeGreaterThanOrEqual(48 - TOUCH_EPSILON)
      const secundarias = await Promise.all(['Nuevo Comprobante', 'Gestionar Caja', 'Registrar gasto'].map(n => caja(accion(page, n))))
      expect(new Set(secundarias.map(s => Math.round(s.y))).size, 'las secundarias no están en una fila').toBe(1)
      expect(secundarias[0].y).toBeGreaterThanOrEqual(principal.y + principal.height - TOL)
      const anchos = secundarias.map(s => Math.round(s.width))
      expect(Math.max(...anchos) - Math.min(...anchos), `anchos desparejos: ${anchos.join(', ')}`).toBeLessThanOrEqual(2)
      // Ningún texto de botón se corta.
      for (const nombre of ['Nueva Orden', 'Nuevo Comprobante', 'Gestionar Caja', 'Registrar gasto']) {
        expect(await accion(page, nombre).evaluate(el => el.scrollWidth - el.clientWidth), `«${nombre}» se recorta`).toBeLessThanOrEqual(TOL)
      }
      // «Actualizar» va junto al título, no en la grilla de acciones.
      const actualizar = await caja(accion(page, 'Actualizar datos'))
      expect(actualizar.y + actualizar.height).toBeLessThanOrEqual(principal.y + TOL)

      // ── Hoy: tres en una fila, no una columna ni cuatro miniaturas ──────
      const indicadores = await page.getByTestId('dashboard-today').getByRole('link')
        .evaluateAll(ls => ls.map(l => { const r = l.getBoundingClientRect(); return { top: Math.round(r.top), w: r.width, corta: l.scrollWidth - l.clientWidth } }))
      expect(indicadores).toHaveLength(3)
      expect(new Set(indicadores.map(i => i.top)).size).toBe(1)
      for (const i of indicadores) {
        expect(i.w, 'un indicador quedó en miniatura').toBeGreaterThanOrEqual(96)
        expect(i.corta, 'un indicador recorta su texto').toBeLessThanOrEqual(TOL)
      }

      // ── Tareas conserva su lugar: antes que las órdenes y a todo el ancho ─
      const tareas = await caja(page.getByTestId('dashboard-tasks'))
      const ordenes = await caja(page.getByTestId('dashboard-recent-orders'))
      expect(tareas.y).toBeGreaterThanOrEqual(contenido.y + contenido.height - TOL)
      expect(ordenes.y).toBeGreaterThanOrEqual(tareas.y + tareas.height - TOL)
      expect(Math.abs(tareas.width - contenido.width)).toBeLessThanOrEqual(TOL)

      // ── Órdenes recientes: tarjetas, no una tabla comprimida ────────────
      await expect(page.getByTestId('dashboard-recent-orders-table')).toBeHidden()
      const tarjetas = page.getByTestId('dashboard-recent-orders-list').getByTestId('dashboard-recent-order-card')
      await expect(tarjetas).toHaveCount(5)
      const primera = tarjetas.first()
      await expect(primera).toContainText(corto(O.reparacion))
      await expect(primera).toContainText('En Reparación')
      await expect(primera).toContainText(X.clienteUno)
      await expect(primera).toContainText(X.modeloLargo)
      await expect(page.getByTestId('dashboard-recent-orders-list').getByRole('button')).toHaveCount(0)
      // #orden y estado comparten la primera línea; el cliente va debajo.
      const numero = await caja(primera.locator('.dash-order-card__id'))
      const estado = await caja(primera.locator('.dash-status'))
      expect(Math.abs((numero.y + numero.height / 2) - (estado.y + estado.height / 2)), '#orden y estado no comparten línea').toBeLessThanOrEqual(8)
      expect((await caja(primera.locator('.compact-list__secondary'))).y).toBeGreaterThanOrEqual(numero.y + numero.height - TOL)

      // ── Todo lo que se toca mide 44 px ──────────────────────────────────
      const controles = await controlesChicos(page)
      expect(controles.total, 'no se encontraron controles para medir').toBeGreaterThan(15)
      expect(controles.chicos, 'controles por debajo de 44 px').toEqual([])

      await sinImportes(inicio(page), `Inicio mobile del dueño (${tema})`)
      await capturar(page, tema === 'light' ? 'dashboard-owner-mobile' : 'dashboard-owner-mobile-dark')

      // ── Contraste de lo que cambia de forma en mobile ───────────────────
      for (const nombre of ['Nueva Orden', 'Nuevo Comprobante', 'Gestionar Caja', 'Registrar gasto']) {
        await legible(page, accion(page, nombre), `«${nombre}» (mobile)`, tema)
      }
      await legible(page, chipCaja.locator('.shell-chip__label'), 'fila de utilidades · caja', tema)
      await legible(page, chipDolar.locator('.shell-chip__value'), 'fila de utilidades · dólar', tema)
      await legible(page, primera.locator('.dash-order-card__id'), 'tarjeta · número', tema)
      await legible(page, primera.locator('.compact-list__secondary'), 'tarjeta · cliente', tema)
      await legible(page, primera.locator('.compact-list__metadata'), 'tarjeta · equipo y fecha', tema)
      await legible(page, primera.locator('.dash-status'), 'tarjeta · estado', tema)
      await legible(page, page.getByTestId('dashboard-tasks-overdue').locator('.dash-tasks__stat-label'), 'tareas · vencidas (mobile)', tema)
    })
  }

  for (const vp of [{ width: 390, height: 844 }, { width: 430, height: 932 }]) {
    test(`${vp.width}×${vp.height} · sin desborde y con todo en 44 px`, async ({ page }) => {
      await abrir(page, 'light', vp)
      await sinDesborde(page, `Inicio a ${vp.width}`)
      expect((await controlesChicos(page)).chicos, 'controles por debajo de 44 px').toEqual([])
      await expect(utilidades(page, true)).toBeVisible()
      await expect(page.getByTestId('dashboard-recent-orders-list')).toBeVisible()
    })
  }

  test('375×812 · tocar la tarjeta de una orden abre su detalle (también con teclado)', async ({ page }) => {
    await abrir(page, 'light', MOBILE, { cotizacion: false })
    const tarjeta = page.getByTestId('dashboard-recent-orders-list').getByTestId('dashboard-recent-order-card').nth(2)
    const zona = tarjeta.getByRole('link')
    await expect(zona).toHaveAccessibleName(new RegExp(`Abrir la orden ${corto(O.aprobacion)}`))
    await zona.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/orders/${O.aprobacion}$`))
  })

  test('el corte de las órdenes recientes es 768px: 767 tarjetas, 768 tabla', async ({ page }) => {
    await abrir(page, 'light', { width: 767, height: 900 }, { cotizacion: false })
    await expect(page.getByTestId('dashboard-recent-orders-list')).toBeVisible()
    await expect(page.getByTestId('dashboard-recent-orders-table')).toBeHidden()
    await page.setViewportSize({ width: 768, height: 900 })
    await expect(page.getByTestId('dashboard-recent-orders-table')).toBeVisible()
    await expect(page.getByTestId('dashboard-recent-orders-list')).toBeHidden()
    await sinDesborde(page, 'Inicio a 768')
  })

  test('375×812 · la fila de utilidades es de Inicio: en Órdenes el alto es del contenido', async ({ page }) => {
    await abrir(page, 'light', MOBILE)
    await expect(utilidades(page, true)).toBeVisible()
    await page.goto('/orders')
    await expect(page.locator('.mobile-app-header')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('mobile-utility-bar')).toHaveCount(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1f B · negocio nuevo', () => {
  /** Parchea en el navegador la ENTRADA de la pantalla: un negocio sin nada cargado. */
  async function negocioVacio(page: Page) {
    await page.route(/\/rest\/v1\/(orders|tasks|cajas)\?/, async (route) => {
      const metodo = route.request().method()
      if (metodo !== 'GET' && metodo !== 'HEAD') return route.fallback()
      const response = await route.fetch()
      if (metodo === 'HEAD') return route.fulfill({ response, headers: { ...response.headers(), 'content-range': '*/0' } })
      await route.fulfill({ response, json: [], headers: { ...response.headers(), 'content-range': '*/0' } })
    })
    await page.route(/\/rest\/v1\/rpc\/get_my_first_steps$/, async (route) => {
      const response = await route.fetch()
      const cuerpo = await response.json() as Record<string, unknown> | Record<string, unknown>[]
      const sinHacer = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).map(k => [k, false]))
      await route.fulfill({ response, json: Array.isArray(cuerpo) ? cuerpo.map(sinHacer) : sinHacer(cuerpo) })
    })
  }

  for (const [nombre, vp] of [['escritorio', DESKTOP], ['mobile', MOBILE]] as const) {
    test(`${vp.width}×${vp.height} · ${nombre} · una sola guía, y el resto dice la verdad de un taller vacío`, async ({ page }) => {
      await negocioVacio(page)
      await abrir(page, 'light', vp)
      await sinDesborde(page, `negocio nuevo (${nombre})`)
      await sinRestosFinancieros(page)

      // ── UNA guía: la canónica, sin la bienvenida que Inicio mostraba además ─
      const guia = page.getByTestId('setup-checklist')
      await expect(guia).toHaveCount(1)
      await expect(guia).toBeVisible()
      await expect(page.getByTestId('setup-checklist-progress')).toHaveText('0/5')
      await expect(page.getByText(/Bienvenido a TechRepair/)).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Crear primera orden/ })).toHaveCount(0)
      // Después del encabezado y antes del contenido operativo.
      const cTitulo = await caja(inicio(page).getByRole('heading', { level: 1, name: 'Inicio' }))
      const cGuia = await caja(guia)
      const cHoy = await caja(page.getByTestId('dashboard-today'))
      expect(cGuia.y).toBeGreaterThanOrEqual(cTitulo.y + cTitulo.height - TOL)
      expect(cHoy.y).toBeGreaterThanOrEqual(cGuia.y + cGuia.height - TOL)

      // ── Ceros reales, no ausencias ──────────────────────────────────────
      for (const clave of ['active', 'ready', 'waiting']) {
        await expect(page.getByTestId(`dashboard-today-${clave}`).locator('.dash-today__value')).toHaveText('0')
      }
      const tareas = page.getByTestId('dashboard-tasks')
      await expect(tareas.getByText('Todo al día')).toBeVisible()
      await expect(tareas.getByText('No tenés tareas pendientes.')).toBeVisible()
      // Tareas no se achica a una tira: conserva encabezado y acciones.
      await expect(tareas.getByRole('heading', { name: 'Mis tareas' })).toBeVisible()
      await expect(tareas.getByRole('button', { name: 'Nueva tarea' })).toBeVisible()
      expect((await caja(tareas)).height, 'el bloque de Tareas se colapsó').toBeGreaterThan(180)
      await expect(page.getByTestId('dashboard-recent-orders').getByText('Todavía no hay órdenes')).toBeVisible()

      // ── La caja, cerrada, se dice como estado y sin alarma ──────────────
      const chip = utilidades(page, nombre === 'mobile').getByTestId('shell-caja-chip')
      await expect(chip).toHaveAttribute('data-state', 'closed')
      await expect(chip).toHaveText('Caja cerrada')

      if (nombre === 'mobile') expect((await controlesChicos(page)).chicos, 'controles por debajo de 44 px').toEqual([])
      await legible(page, tareas.getByText('No tenés tareas pendientes.'), 'estado vacío de tareas', 'light')
      await legible(page, page.getByText('Cuando recibas un equipo, lo vas a ver acá.'), 'estado vacío de órdenes', 'light')
      await sinImportes(inicio(page), `negocio nuevo (${nombre})`)
      if (nombre === 'escritorio') await capturar(page, 'dashboard-new-business')
    })
  }

  test('con la guía completa no queda un hueco: después del encabezado viene «Hoy»', async ({ page }) => {
    await page.route(/\/rest\/v1\/rpc\/get_my_first_steps$/, async (route) => {
      const response = await route.fetch()
      const cuerpo = await response.json() as Record<string, unknown> | Record<string, unknown>[]
      const hecho = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).map(k => [k, true]))
      await route.fulfill({ response, json: Array.isArray(cuerpo) ? cuerpo.map(hecho) : hecho(cuerpo) })
    })
    await abrir(page, 'light', DESKTOP, { cotizacion: false })
    await expect(page.getByTestId('setup-checklist')).toHaveCount(0)
    const encabezado = await caja(inicio(page).locator('.page-top'))
    const hoy = await caja(page.getByTestId('dashboard-today'))
    expect(hoy.y - (encabezado.y + encabezado.height), 'quedó un hueco donde estaba la guía').toBeLessThanOrEqual(32)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1f C · técnico: sin finance ni comprobantes', () => {
  test.use({ storageState: TECNICO_STATE })

  for (const [nombre, vp] of [['escritorio', DESKTOP], ['mobile', MOBILE]] as const) {
    test(`${vp.width}×${vp.height} · ${nombre} · sólo sus acciones, sin caja y sin un importe`, async ({ page }) => {
      const pedidos = grabarRed(page)
      await abrir(page, 'light', vp)
      await sinDesborde(page, `técnico (${nombre})`)
      await sinRestosFinancieros(page)

      // ── Acciones por capacidad: recibe equipos, no factura ni toca caja ─
      await expect(accion(page, 'Nueva Orden')).toBeVisible()
      for (const ajena of ['Nuevo Comprobante', 'Gestionar Caja', 'Registrar gasto']) {
        await expect(accion(page, ajena), `el técnico ve «${ajena}»`).toHaveCount(0)
      }
      await expect(accion(page, 'Actualizar datos')).toBeVisible()

      // ── No necesita conocer la caja: el chip no existe, en ningún ancho ─
      await expect(page.getByTestId('shell-caja-chip')).toHaveCount(0)
      await expect(page.locator('a[href="/caja"]:visible')).toHaveCount(0)
      // El dólar no es dinero del negocio: sí lo ve.
      await expect(utilidades(page, nombre === 'mobile').getByTestId('shell-dollar-chip')).toContainText('$1.556')

      // ── La operación es la misma que ve el dueño ────────────────────────
      const base = operacionEnBase()
      await expect(page.getByTestId('dashboard-today-active').locator('.dash-today__value')).toHaveText(String(base.activas))
      await expect(page.getByTestId('dashboard-today-ready').locator('.dash-today__value')).toHaveText(String(base.listas))
      const visibles = page.getByTestId(nombre === 'mobile' ? 'dashboard-recent-orders-list' : 'dashboard-recent-orders-table')
      await expect(visibles).toContainText(corto(O.reparacion))

      // ── Sus tareas, no las del dueño ────────────────────────────────────
      const tareas = page.getByTestId('dashboard-tasks')
      await expect(tareas.getByText(X.tareaDelTecnico)).toBeVisible()
      await expect(tareas.getByText(X.tareaVencidaAlta)).toHaveCount(0)
      const mias = tareasEnBase(tecnicoId)
      await expect(page.getByTestId('dashboard-tasks-today')).toHaveText(`${mias.hoy}Para hoy`)
      await expect(page.getByTestId('dashboard-tasks-pending')).toHaveText(`${mias.pendientes}Pendientes`)

      // ── Ningún importe, y la red tampoco los trae ───────────────────────
      await sinImportes(inicio(page), `Inicio del técnico (${nombre})`)
      sinFuentesRetiradas(pedidos, 'técnico')
      expect(de(pedidos, 'cajas').map(p => p.metodo), 'el técnico consultó `cajas`').toEqual([])
      if (nombre === 'mobile') expect((await controlesChicos(page)).chicos, 'controles por debajo de 44 px').toEqual([])
      if (nombre === 'escritorio') await capturar(page, 'dashboard-tech-desktop')
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-1f D · vendedor: comprobantes sin finance', () => {
  test.use({ storageState: VENDEDOR_STATE })

  for (const [nombre, vp] of [['escritorio', DESKTOP], ['mobile', MOBILE]] as const) {
    test(`${vp.width}×${vp.height} · ${nombre} · conoce la caja, no la gestiona, y no ve gasto ni importes`, async ({ page }) => {
      const pedidos = grabarRed(page)
      await abrir(page, 'light', vp)
      await sinDesborde(page, `vendedor (${nombre})`)
      await sinRestosFinancieros(page)

      // ── Vende: orden y comprobante. No caja, no gasto. ──────────────────
      await expect(accion(page, 'Nueva Orden')).toBeVisible()
      await expect(accion(page, 'Nuevo Comprobante')).toBeVisible()
      await expect(accion(page, 'Gestionar Caja')).toHaveCount(0)
      await expect(accion(page, 'Registrar gasto')).toHaveCount(0)

      // ── Conoce el estado de la caja porque cobra; no puede ir a gestionarla ─
      const fila = utilidades(page, nombre === 'mobile')
      const chip = fila.getByTestId('shell-caja-chip')
      const abierta = cajaAbiertaEnBase()
      await expect(chip).toBeVisible()
      await expect(chip).toHaveAttribute('data-state', abierta ? 'open' : 'closed')
      await expect(chip).toContainText(abierta ? 'Caja abierta' : 'Caja cerrada')
      expect(await chip.evaluate(el => el.tagName), 'el chip del vendedor no puede ser un enlace').toBe('SPAN')
      await expect(chip).not.toHaveAttribute('href')
      await expect(fila.locator('a')).toHaveCount(0)
      await expect(page.locator('a[href="/caja"]:visible')).toHaveCount(0)
      expect((await chip.innerText()).replace(/\s+/g, ' ').trim()).toMatch(/^Caja (abierta|cerrada) ?(desde \d{2}:\d{2})?$/)

      // ── «Nuevo Comprobante» conserva su handoff al POS ──────────────────
      await sinImportes(inicio(page), `Inicio del vendedor (${nombre})`)
      sinFuentesRetiradas(pedidos, 'vendedor')
      // Sí lee el estado de la caja: es la excepción válida.
      expect(de(pedidos, 'cajas', 'GET').length).toBeGreaterThanOrEqual(1)
      if (nombre === 'mobile') {
        expect((await controlesChicos(page)).chicos, 'controles por debajo de 44 px').toEqual([])
        // Con una sola secundaria, ocupa la fila entera en vez de un tercio.
        const principal = await caja(accion(page, 'Nueva Orden'))
        const comprobante = await caja(accion(page, 'Nuevo Comprobante'))
        expect(Math.abs(comprobante.width - principal.width)).toBeLessThanOrEqual(TOL)
      }
    })
  }

  test('«Nuevo Comprobante» abre el alta del POS', async ({ page }) => {
    await abrir(page, 'light', DESKTOP, { cotizacion: false })
    await accion(page, 'Nuevo Comprobante').click()
    await expect(page).toHaveURL(/\/comprobantes$/)
    await expect(page.locator('[data-testid="comprobante-product-search"]')).toBeVisible({ timeout: 20_000 })
  })
})
