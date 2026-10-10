// BETA-UX-1F — verificación local con sesión FALSA y backend SIMULADO.
// Nada sale de la máquina: VITE_SUPABASE_URL apunta a un puerto muerto y cada
// request se responde con route(). No usa Docker ni el stack local.
// Uso: node capture-1f.mjs <worktree> <outDir> [filtro]
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const worktree = process.argv[2]
const outDir = process.argv[3]
/** Nombres exactos separados por coma; vacío = todos. */
const only = (process.argv[4] || '').split(',').filter(Boolean)
/** Las medidas de contraste necesitan 2; las capturas de evidencia van a 1 para no pesar. */
const DSF = Number(process.env.CAPTURE_DSF || 2)
const SOLO_CAPTURA = process.env.CAPTURE_ONLY === '1'
const nm = p => pathToFileURL(path.join(worktree, 'node_modules', p)).href

const SB = 'http://127.0.0.1:59999'
process.env.VITE_SUPABASE_URL = SB
process.env.VITE_SUPABASE_ANON_KEY = 'local-dummy-anon-key'

const { createServer } = await import(nm('vite/dist/node/index.js'))
const { chromium } = await import(nm('playwright-core/index.mjs'))
const { paintedContrastOf } = await import(pathToFileURL(path.join(worktree, 'tests/e2e/helpers/contrast.ts')).href)
fs.mkdirSync(outDir, { recursive: true })

const PORT = 5197
const server = await createServer({
  root: worktree, configFile: path.join(worktree, 'vite.config.ts'), logLevel: 'error',
  cacheDir: path.join(path.dirname(outDir), 'vite-cache-1f'),
  server: { host: '127.0.0.1', port: PORT, strictPort: true, open: false },
})
await server.listen()
const base = `http://127.0.0.1:${PORT}`

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const USER_ID = '00000000-0000-4000-8000-00000000d15c'
const BIZ_ID = '00000000-0000-4000-8000-00000000b12e'
const now = Math.floor(Date.now() / 1000)
const jwt = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: USER_ID, exp: now + 86400, role: 'authenticated', aud: 'authenticated', email: 'owner.qa@example.test' })}.sig`
const user = {
  id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'owner.qa@example.test',
  email_confirmed_at: '2026-10-01T12:00:00Z', app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: 'QA' }, created_at: '2026-10-01T11:59:00Z', identities: [],
}
const session = { access_token: jwt, token_type: 'bearer', expires_in: 86400, expires_at: now + 86400, refresh_token: 'fake-refresh', user }
const profileFor = (role, permissions = null) => ({
  id: USER_ID, user_id: USER_ID, business_id: BIZ_ID, email: user.email, full_name: 'QA ' + role,
  role, is_active: true, permissions, created_at: '2026-10-01T12:00:00Z',
})
const day = 86400e3
const SUBSCRIPTION = {
  subscription_status: 'active', subscription_plan: 'pro', access_source: 'admin_override',
  mp_preapproval_id: null, mp_payer_email: null, current_period_start: new Date(Date.now() - 10 * day).toISOString(),
  current_period_end: new Date(Date.now() + 20 * day).toISOString(), grace_until: null, last_payment_status: null,
  trial_ends_at: new Date(Date.now() - 40 * day).toISOString(), override_expires_at: null,
}

// ── Datos ────────────────────────────────────────────────────────────────────
const hoyAR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Cordoba' }).format(new Date())
const masDias = n => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Cordoba' }).format(new Date(Date.now() + n * day))
const oid = n => `a1b2c3d${n}-0000-4000-8000-00000000000${n}`
const ESTADOS = ['repair', 'ready_delivery', 'waiting_approval', 'diagnosis', 'new', 'completed', 'completed', 'cancelled', 'ready_delivery', 'waiting_parts', 'repair', 'waiting_payment']
const CLIENTES = ['Juan Pérez', 'Distribuidora Sintética del Centro SRL', 'María González', null, 'Lucas Fernández']
const EQUIPOS = [['Samsung', 'Galaxy S24 Ultra 5G 512GB Titanium Black'], ['Apple', 'iPhone 13'], ['Motorola', 'Moto G54'], null, ['Xiaomi', 'Redmi Note 12']]
const ORDERS = ESTADOS.map((status, i) => ({
  id: `a1b2c3${(i + 16).toString(16)}-0000-4000-8000-000000000000`, business_id: BIZ_ID, status,
  created_at: new Date(Date.now() - i * 5 * 3600e3).toISOString(),
  customer: CLIENTES[i % 5] ? { name: CLIENTES[i % 5] } : null,
  device: EQUIPOS[i % 5] ? { brand: EQUIPOS[i % 5][0], model: EQUIPOS[i % 5][1] } : null,
}))
const task = (i, over) => ({
  id: `task-${i}`, title: 'Tarea', description: null, status: 'pending', priority: 'medium', due_date: null,
  assigned_to: USER_ID, user_id: USER_ID, started_at: null, completed_at: null, created_at: new Date().toISOString(), ...over,
})
const TASKS = [
  task(1, { title: 'Llamar a Juan Pérez por el presupuesto del Galaxy', priority: 'high', due_date: masDias(-2) }),
  task(2, { title: 'Pedir módulo de pantalla al proveedor', priority: 'high', due_date: masDias(-1) }),
  task(3, { title: 'Entregar iPhone 13 a Distribuidora Sintética', priority: 'medium', due_date: hoyAR }),
  task(4, { title: 'Revisar stock de baterías', priority: 'low', due_date: hoyAR }),
  task(5, { title: 'Actualizar lista de precios de repuestos y avisarle al equipo del mostrador', priority: 'medium', due_date: masDias(3) }),
  task(6, { title: 'Ordenar depósito', priority: 'low', due_date: null }),
  task(7, { title: 'Hecha', status: 'completed', due_date: masDias(-3) }),
]

const report = []
const unmocked = new Set()
const pedidos = []

function ordersHandler(dataset) {
  return (req) => {
    const u = new URL(req.url())
    let rows = dataset
    const st = u.searchParams.get('status')
    if (st?.startsWith('eq.')) rows = rows.filter(o => o.status === st.slice(3))
    const ca = u.searchParams.get('created_at')
    if (ca?.startsWith('gte.')) rows = rows.filter(o => new Date(o.created_at) >= new Date(ca.slice(4)))
    const lim = Number(u.searchParams.get('limit') || 0)
    return lim ? rows.slice(0, lim) : rows
  }
}
function tasksHandler(dataset) {
  return (req) => {
    const u = new URL(req.url())
    const st = u.searchParams.get('status')
    return st?.startsWith('not.in.') ? dataset.filter(t => t.status !== 'completed' && t.status !== 'cancelled') : dataset
  }
}

async function mockBackend(ctx, sc) {
  await ctx.route(`${SB}/**`, async route => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (p.startsWith('/auth/v1/user')) return json(user)
    if (p.startsWith('/auth/v1/token')) return json(session)
    if (p.startsWith('/auth/v1/')) return json({})
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.replace('/rest/v1/rpc/', '')
      pedidos.push('rpc:' + fn)
      if (fn in sc.rpc) return json(typeof sc.rpc[fn] === 'function' ? sc.rpc[fn](req) : sc.rpc[fn])
      unmocked.add('rpc:' + fn)
      return json(null)
    }
    if (p.startsWith('/rest/v1/')) {
      const table = p.replace('/rest/v1/', '')
      pedidos.push(`${req.method()} ${table}`)
      if (req.method() !== 'GET' && req.method() !== 'HEAD') return json([])
      const wantsObject = (req.headers()['accept'] || '').includes('vnd.pgrst.object')
      if (table === 'businesses' && wantsObject) return json(SUBSCRIPTION)
      if (table in (sc.tables || {})) {
        const v = sc.tables[table]
        const body = typeof v === 'function' ? v(req, wantsObject) : v
        if (wantsObject) return Array.isArray(body) ? (body.length ? json(body[0]) : json({ code: 'PGRST116', message: 'mock: 0 rows' }, 406)) : (body ? json(body) : json({ code: 'PGRST116', message: 'mock: 0 rows' }, 406))
        const arr = Array.isArray(body) ? body : [body]
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': `${arr.length ? `0-${arr.length - 1}` : '*'}/${arr.length}`, 'access-control-expose-headers': 'content-range' }, body: JSON.stringify(arr) })
      }
      unmocked.add('table:' + table + (wantsObject ? '(single)' : ''))
      if (wantsObject) return json({ code: 'PGRST116', message: 'mock: 0 rows' }, 406)
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0', 'access-control-expose-headers': 'content-range' }, body: '[]' })
    }
    if (p.startsWith('/functions/v1/fetch-dollar-rate')) { pedidos.push('fn:fetch-dollar-rate'); return json({ sell: 1556, buy: 1530, source: 'AMBITO_NACIONAL' }) }
    if (p.startsWith('/functions/v1/')) return json({ error: 'mock' }, 404)
    return route.abort()
  })
}

const overflowX = page => page.evaluate(() => {
  const ancho = document.documentElement.clientWidth
  let fuera = 0, culpable = ''
  for (const el of document.querySelectorAll('.main-layout-inner *, .top-header *')) {
    if (el.closest('.table-wrap, .tabs, [style*="overflow-x: auto"]')) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const e = Math.max(r.right - ancho, -r.left)
    if (e > fuera) { fuera = e; culpable = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}` }
  }
  return { scrollW: document.documentElement.scrollWidth, innerW: ancho, fuera: Math.round(fuera), culpable }
})
const recortes = page => page.evaluate(() => {
  const out = []
  for (const cont of document.querySelectorAll('.main-layout-inner .card, .main-layout-inner .dash-today, .main-layout-inner .compact-list__item, .dash-actions, .mobile-utility-bar')) {
    const c = cont.getBoundingClientRect()
    if (c.width === 0) continue
    for (const el of cont.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const exceso = Math.max(r.right - c.right, c.left - r.left)
      if (exceso > 1) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} «${(el.textContent || '').trim().slice(0, 24)}» +${Math.round(exceso)}px`)
      if (el.scrollWidth - el.clientWidth > 1 && getComputedStyle(el).textOverflow !== 'ellipsis' && el.children.length === 0) out.push(`interno ${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} «${(el.textContent || '').trim().slice(0, 24)}»`)
    }
  }
  return out
})
const chicos = page => page.evaluate(() => Array.from(document.querySelectorAll('.main-layout-inner button, .main-layout-inner a[href], .main-layout-inner [role="link"], .mobile-app-header button'))
  .filter(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' })
  .map(e => { const r = e.getBoundingClientRect(); return { n: `${e.tagName.toLowerCase()} "${(e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)}" ${Math.round(r.width * 10) / 10}x${Math.round(r.height * 10) / 10}`, w: r.width, h: r.height } })
  .filter(x => x.h < 43.99 || x.w < 43.99).map(x => x.n))

async function contraste(page, selector, nombre, { hover = false, hoverOn = null, nth = 0 } = {}) {
  const l = page.locator(selector).nth(nth)
  if (!(await l.count()) || !(await l.isVisible())) return `    ${nombre}: (no visible)`
  await page.mouse.move(0, 0)
  try {
    if (hover || hoverOn) {
      const h = hoverOn ? page.locator(hoverOn).first() : l
      // `paintedContrastOf` centra el elemento medido: se lo centra ANTES de
      // llevar el puntero, para que ese scroll no le saque el hover.
      await l.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
      await h.hover(hoverOn ? { position: { x: 8, y: 8 } } : undefined); await page.waitForTimeout(350)
      if (!(await h.evaluate(el => el.matches(':hover')))) return `    ERR ${nombre}: no quedó en hover`
    }
    const c = await paintedContrastOf(l)
    const marca = c.ratio >= 4.5 ? 'ok ' : 'BAJO'
    return `    ${marca} ${c.ratio.toFixed(2)}${c.ratioMax - c.ratio > 0.3 ? `–${c.ratioMax.toFixed(2)}` : ''}  ${nombre}${hover || hoverOn ? ' (hover)' : ''}  «${c.text.slice(0, 26)}» ${c.foreground} / ${c.backgroundWorst} ${c.fontSize}`
  } catch (e) { return `    ERR ${nombre}: ${String(e.message).slice(0, 110)}` }
}

const CONTRASTES = [
  ['.dash-page .page-title', 'título'],
  ['.dash-page .page-subtitle', 'subtítulo'],
  ['.dash-action--primary', 'Nueva Orden'],
  ['.dash-action--primary', 'Nueva Orden', { hover: true }],
  ['.btn-indigo-aa', 'Nuevo Comprobante'],
  ['.btn-indigo-aa', 'Nuevo Comprobante', { hover: true }],
  ['.dash-actions .btn-secondary', 'Gestionar Caja'],
  ['.dash-actions .btn-secondary', 'Gestionar Caja', { hover: true }],
  ['.btn-danger-aa', 'Registrar gasto'],
  ['.btn-danger-aa', 'Registrar gasto', { hover: true }],
  ['[data-testid="shell-caja-chip"]:visible .shell-chip__label', 'chip caja · estado'],
  ['[data-testid="shell-caja-chip"]:visible .shell-chip__meta', 'chip caja · desde'],
  ['[data-testid="shell-caja-chip"]:visible .shell-chip__label', 'chip caja · estado', { hoverOn: '[data-testid="shell-caja-chip"]:visible' }],
  ['[data-testid="shell-dollar-chip"]:visible .shell-chip__unit', 'chip dólar · USD'],
  ['[data-testid="shell-dollar-chip"]:visible .shell-chip__value', 'chip dólar · valor'],
  ['.dash-today__value', 'Hoy · valor'],
  ['.dash-today__label', 'Hoy · etiqueta'],
  ['.dash-today__hint', 'Hoy · +nuevas'],
  ['.dash-today__label', 'Hoy · etiqueta', { hoverOn: '.dash-today__item' }],
  ['.dash-tasks__title', 'Tareas · título'],
  ['.dash-tasks__subtitle', 'Tareas · subtítulo'],
  ['.dash-tasks__actions .btn-primary-aa', 'Nueva tarea'],
  ['.dash-tasks__actions .btn-primary-aa', 'Nueva tarea', { hover: true }],
  ['.dash-tasks__actions .btn-secondary', 'Ver todas (tareas)'],
  ['.dash-tasks__stat[data-tone="danger"] .dash-tasks__stat-value', 'Vencidas · valor'],
  ['.dash-tasks__stat[data-tone="danger"] .dash-tasks__stat-label', 'Vencidas · etiqueta'],
  ['.dash-tasks__stat[data-tone="danger"] .dash-tasks__stat-label', 'Vencidas · etiqueta', { hoverOn: '.dash-tasks__stat[data-tone="danger"]' }],
  ['.dash-tasks__stat[data-tone="accent"] .dash-tasks__stat-value', 'Para hoy · valor'],
  ['.dash-tasks__stat[data-tone="accent"] .dash-tasks__stat-label', 'Para hoy · etiqueta'],
  ['.dash-tasks__stat[data-tone="accent"] .dash-tasks__stat-value', 'Para hoy · valor', { hoverOn: '.dash-tasks__stat[data-tone="accent"]' }],
  ['.dash-tasks__stat[data-tone="neutral"] .dash-tasks__stat-value', 'Pendientes · valor'],
  ['.dash-tasks__stat[data-tone="neutral"] .dash-tasks__stat-label', 'Pendientes · etiqueta'],
  ['.dash-task__title', 'tarea · título'],
  ['.dash-task__due[data-state="overdue"]', 'tarea · vencida'],
  ['.dash-task__due[data-state="today"]', 'tarea · hoy'],
  ['.dash-task__due[data-state="upcoming"]', 'tarea · próxima'],
  ['.dash-task__priority', 'tarea · prioridad'],
  ['.dash-task__title', 'tarea · título', { hoverOn: '.dash-task__open' }],
  ['.dash-task__due[data-state="overdue"]', 'tarea · vencida', { hoverOn: '.dash-task__open' }],
  ['.dash-task__priority', 'tarea · prioridad', { hoverOn: '.dash-task__open' }],
  ['.dash-tasks__empty-title', 'Todo al día'],
  ['.dash-tasks__empty-copy', 'No tenés tareas'],
  ['.dash-orders .card-title', 'Órdenes · título'],
  ['.dash-orders .card-header .btn', 'Ver todas (órdenes)'],
  ['.dash-orders__desktop th', 'tabla · encabezado'],
  ['.dash-orders__id', 'tabla · #orden'],
  ['.dash-orders__customer', 'tabla · cliente'],
  ['.dash-orders__desktop td:nth-child(3)', 'tabla · dispositivo'],
  ['.dash-orders__desktop .dash-status', 'tabla · estado'],
  ['.dash-orders__id', 'tabla · #orden', { hoverOn: '.dash-orders__desktop tbody tr' }],
  ['.dash-orders__desktop td:nth-child(3)', 'tabla · dispositivo', { hoverOn: '.dash-orders__desktop tbody tr' }],
  ['.dash-orders__desktop td:nth-child(5)', 'tabla · fecha'],
  ['.dash-order-card__id', 'tarjeta · #orden'],
  ['.dash-orders__mobile .compact-list__secondary', 'tarjeta · cliente'],
  ['.dash-orders__mobile .compact-list__metadata', 'tarjeta · meta'],
  ['.dash-orders__mobile .dash-status', 'tarjeta · estado'],
]

async function run({ name, sc, width = 1440, height = 900, theme = 'light', fullPage = true, medir = true, shot = true, steps, elemento = null }) {
  if (only.length && !only.includes(name)) return
  if (SOLO_CAPTURA) medir = false
  pedidos.length = 0
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: DSF })
  await ctx.addInitScript(([s, t]) => {
    try {
      localStorage.setItem('sb-127-auth-token', s)
      localStorage.setItem('techrepair_theme', t); localStorage.setItem('theme', t)
    } catch {}
  }, [JSON.stringify(session), theme])
  await ctx.route('**/*', r => {
    const u = r.request().url()
    if (u.startsWith(base) || u.startsWith(SB) || u.startsWith('data:') || u.startsWith('blob:')) return r.fallback()
    if (/cdn\.jsdelivr\.net\/npm\/bootstrap|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(u)) return r.fallback()
    return r.abort()
  })
  await mockBackend(ctx, sc)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)))
  await page.goto(base + '/dashboard', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="dashboard-page"]', { timeout: 90_000 })
  await page.waitForSelector('[data-testid="dashboard-today"], .alert-error', { timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(2500)
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))))
  if (steps) await steps(page)
  const ov = await overflowX(page)
  const rec = await recortes(page)
  const small = width < 1024 ? await chicos(page) : []
  report.push(`\n[${name}] ${width}x${height} ${theme}  errors=${errors.length}${errors.length ? ' :: ' + errors.slice(0, 2).join(' | ') : ''}`)
  report.push(`  desborde: scrollW=${ov.scrollW} innerW=${ov.innerW} fuera=${ov.fuera}px ${ov.culpable}`)
  report.push(`  recortes: ${rec.length ? '\n    - ' + rec.slice(0, 12).join('\n    - ') : 'ninguno'}`)
  if (width < 1024) report.push(`  <44px: ${small.length}${small.length ? '\n    - ' + small.slice(0, 20).join('\n    - ') : ''}`)
  const orden = await page.evaluate(() => ['dashboard-actions', 'setup-checklist', 'dashboard-today', 'dashboard-tasks', 'dashboard-recent-orders']
    .map(id => { const el = document.querySelector(`[data-testid="${id}"]`); return el ? `${id}@${Math.round(el.getBoundingClientRect().top + scrollY)}` : `${id}:ausente` }).join('  '))
  report.push(`  orden: ${orden}`)
  const dinero = await page.evaluate(() => { const t = document.querySelector('[data-testid="dashboard-page"]')?.textContent || ''; return (t.match(/\$\s?\d[\d.]*/g) || []).join(' ') })
  report.push(`  importes en Inicio: ${dinero || 'ninguno'}`)
  report.push(`  requests: ${[...new Set(pedidos)].sort().join(', ')}`)
  await page.mouse.move(0, 0)
  if (shot && elemento) await page.locator(elemento).first().screenshot({ path: path.join(outDir, `${name}.png`), caret: 'initial', animations: 'disabled' })
  else if (shot) await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage, caret: 'initial', animations: 'disabled' })
  if (medir) for (const [sel, nombre, opt] of CONTRASTES) report.push(await contraste(page, sel, nombre, opt))
  await browser.close()
}

const firstStepsDone = { has_customer: true, has_order: true, has_inventory: true, has_cobro: true, has_logo: true }
const firstStepsNew = { has_customer: false, has_order: false, has_inventory: false, has_cobro: false, has_logo: false }
const rpc = (role, steps, permissions) => ({
  get_my_profile: [profileFor(role, permissions)], get_my_first_steps: steps,
  current_platform_admin_role: null, current_user_has_internal_tool_access: false,
})
const CAJA_ABIERTA = { id: 'caja-1', business_id: BIZ_ID, opened_at: new Date(new Date().setHours(9, 20, 0, 0)).toISOString(), opened_by: USER_ID, status: 'abierta' }
const dolar = {
  business_settings: { dolar_source: 'nacional', auto_update_rate: true, mayorista_enabled: true },
  exchange_rates: { rate: 1556, source: 'bluelytics', updated_at: new Date(Date.now() - 6 * 60e3).toISOString() },
  dollar_rate_history: { sell_price: 1556, buy_price: 1530 },
}
const conDatos = (caja) => ({ ...dolar, orders: ordersHandler(ORDERS), tasks: tasksHandler(TASKS), cajas: caja ? [caja] : [] })
const vacio = (caja) => ({ ...dolar, orders: ordersHandler([]), tasks: tasksHandler([]), cajas: caja ? [caja] : [] })

try {
  await run({ name: 'dashboard-owner-desktop-light', theme: 'light', sc: { rpc: rpc('owner', firstStepsDone), tables: conDatos(CAJA_ABIERTA) } })
  await run({ name: 'dashboard-owner-desktop-dark', theme: 'dark', sc: { rpc: rpc('owner', firstStepsDone), tables: conDatos(CAJA_ABIERTA) } })
  await run({ name: 'dashboard-tech-desktop', theme: 'light', sc: { rpc: rpc('tech', firstStepsDone), tables: conDatos(CAJA_ABIERTA) } })
  await run({ name: 'dashboard-sales-desktop', theme: 'light', medir: false, sc: { rpc: rpc('sales', firstStepsDone), tables: conDatos(null) } })
  await run({ name: 'dashboard-owner-mobile', theme: 'light', width: 375, height: 812, sc: { rpc: rpc('owner', firstStepsDone), tables: conDatos(CAJA_ABIERTA) } })
  await run({ name: 'dashboard-owner-mobile-dark', theme: 'dark', width: 375, height: 812, sc: { rpc: rpc('owner', firstStepsDone), tables: conDatos(CAJA_ABIERTA) } })
  await run({ name: 'dashboard-new-business', theme: 'light', sc: { rpc: rpc('owner', firstStepsNew), tables: vacio(null) } })
  await run({ name: 'dashboard-new-business-mobile', theme: 'light', width: 375, height: 812, medir: false, sc: { rpc: rpc('owner', firstStepsNew), tables: vacio(null) } })
  await run({ name: 'top-header-utilities', theme: 'light', width: 1440, height: 900, medir: false, elemento: '.top-header', sc: { rpc: rpc('owner', firstStepsDone), tables: conDatos(CAJA_ABIERTA) } })
  await run({ name: 'top-header-utilities-dark', theme: 'dark', width: 1440, height: 900, medir: false, elemento: '.top-header', sc: { rpc: rpc('sales', firstStepsDone), tables: conDatos(null) } })
  await run({ name: 'dashboard-empty-states-dark', theme: 'dark', medir: true, shot: false, sc: { rpc: rpc('owner', firstStepsNew), tables: vacio(null) } })
  // Geometría en otros anchos (sin captura)
  for (const [w, h] of [[390, 844], [430, 932], [320, 700], [768, 1024], [1024, 768], [1280, 800]]) {
    await run({ name: `geo-owner-${w}`, theme: 'light', width: w, height: h, medir: false, shot: false, sc: { rpc: rpc('owner', firstStepsDone), tables: conDatos(CAJA_ABIERTA) } })
  }
  await run({ name: 'geo-tech-375', theme: 'light', width: 375, height: 812, medir: false, shot: false, sc: { rpc: rpc('tech', firstStepsDone), tables: conDatos(CAJA_ABIERTA) } })
  await run({ name: 'geo-sales-375', theme: 'light', width: 375, height: 812, medir: false, shot: false, sc: { rpc: rpc('sales', firstStepsDone), tables: conDatos(CAJA_ABIERTA) } })
} finally {
  await server.close()
}
report.push('\nSIN MOCK (respondidos vacío/null): ' + [...unmocked].sort().join(', '))
fs.writeFileSync(path.join(outDir, 'capture-report.txt'), report.join('\n'))
console.log(report.join('\n'))
