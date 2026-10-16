// BETA-UX-2 — capturas y medidas con sesión FALSA y backend SIMULADO.
// Nada sale de la máquina: VITE_SUPABASE_URL apunta a un puerto muerto y cada
// request se responde con route(). No usa Docker ni el stack local.
//
// Uso: node capture.mjs <root> <outDir> <etiqueta> [filtro,de,nombres]
//   <root>      raíz del repo a servir (la rama que se quiere medir)
//   <outDir>    carpeta de salida (PNG + measures-<etiqueta>.json + report)
//   <etiqueta>  «before» / «after»: prefijo de cada archivo
//
// Mide en cada pantalla: caja del ícono, tamaño del glifo, tipografía del
// título y del subtítulo, distancia barra superior → encabezado, encabezado →
// primer bloque y entre los bloques siguientes. El wizard de Nueva orden se
// recorre de punta a punta con un patrón que usa el punto 9 y el mock de
// `create_order_intake` replica la regla del servidor
// (`private.mobile2a_legacy_from_access`: sólo puntos 0–8, ≥2, sin repetir).
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const root = path.resolve(process.argv[2] || '.')
const outDir = path.resolve(process.argv[3] || 'out')
const label = process.argv[4] || 'run'
const only = (process.argv[5] || '').split(',').filter(Boolean)
const nm = p => pathToFileURL(path.join(root, 'node_modules', p)).href

const SB = 'http://127.0.0.1:59998'
process.env.VITE_SUPABASE_URL = SB
process.env.VITE_SUPABASE_ANON_KEY = 'local-dummy-anon-key'

const { createServer } = await import(nm('vite/dist/node/index.js'))
const { chromium } = await import(nm('playwright-core/index.mjs'))
fs.mkdirSync(outDir, { recursive: true })

const PORT = Number(process.env.CAPTURE_PORT || 5198)
const server = await createServer({
  root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
  cacheDir: path.join(os.tmpdir(), `vite-cache-beta-ux-2-${label}`),
  server: { host: '127.0.0.1', port: PORT, strictPort: true, open: false },
})
await server.listen()
const base = `http://127.0.0.1:${PORT}`

// ── Sesión y datos ───────────────────────────────────────────────────────────
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
const profile = {
  id: USER_ID, user_id: USER_ID, business_id: BIZ_ID, email: user.email, full_name: 'QA Owner',
  role: 'owner', is_active: true, permissions: null, created_at: '2026-10-01T12:00:00Z',
}
const day = 86400e3
const SUBSCRIPTION = {
  subscription_status: 'active', subscription_plan: 'full', access_source: 'admin_override',
  mp_preapproval_id: null, mp_payer_email: null, current_period_start: new Date(Date.now() - 10 * day).toISOString(),
  current_period_end: new Date(Date.now() + 20 * day).toISOString(), grace_until: null, last_payment_status: null,
  trial_ends_at: new Date(Date.now() - 40 * day).toISOString(), override_expires_at: null,
}
const ESTADOS = ['repair', 'ready_delivery', 'waiting_approval', 'diagnosis', 'new', 'completed']
const CLIENTES = [
  { id: 'c0000000-0000-4000-8000-000000000001', name: 'Juan Pérez', phone: '3511234567', document: '30111222', customer_type: 'minorista', active: true, created_at: '2026-10-01T12:00:00Z' },
  { id: 'c0000000-0000-4000-8000-000000000002', name: 'María González', phone: '3517654321', document: null, customer_type: 'minorista', active: true, created_at: '2026-10-02T12:00:00Z' },
]
const ORDERS = ESTADOS.map((status, i) => ({
  id: `a1b2c3${(i + 16).toString(16)}-0000-4000-8000-000000000000`, business_id: BIZ_ID, status, priority: 'medium',
  created_at: new Date(Date.now() - i * 5 * 3600e3).toISOString(), customer_id: CLIENTES[i % 2].id,
  customer: { name: CLIENTES[i % 2].name, phone: CLIENTES[i % 2].phone }, device: { brand: 'Samsung', model: 'Galaxy A54', type: 'smartphone' },
}))

const unmocked = new Set()
const rpcCalls = []

/** Réplica de `private.mobile2a_legacy_from_access` para el modo patrón. */
function serverRejectsPattern(secret) {
  let points
  try { points = JSON.parse(secret) } catch { return true }
  if (!Array.isArray(points) || points.length < 2 || points.length > 9) return true
  if (points.some(p => !/^[0-8]$/.test(String(p)))) return true
  return new Set(points.map(String)).size !== points.length
}

async function mockBackend(ctx) {
  await ctx.route(`${SB}/**`, async route => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const list = arr => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': `${arr.length ? `0-${arr.length - 1}` : '*'}/${arr.length}`, 'access-control-expose-headers': 'content-range' }, body: JSON.stringify(arr) })
    if (p.startsWith('/auth/v1/user')) return json(user)
    if (p.startsWith('/auth/v1/token')) return json(session)
    if (p.startsWith('/auth/v1/')) return json({})
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.replace('/rest/v1/rpc/', '')
      if (fn === 'get_my_profile') return json([profile])
      if (fn === 'get_my_first_steps') return json({ has_customer: true, has_order: true, has_inventory: true, has_cobro: true, has_logo: true })
      if (fn === 'current_platform_admin_role') return json(null)
      if (fn === 'current_user_has_internal_tool_access') return json(false)
      if (fn === 'create_order_intake') {
        const body = JSON.parse(req.postData() || '{}')
        rpcCalls.push({ fn, access_mode: body.p_payload?.access_mode, p_access_secret: body.p_access_secret })
        const mode = body.p_payload?.access_mode
        if (mode === 'pattern' && serverRejectsPattern(body.p_access_secret))
          return json({ code: '22023', message: 'INVALID_ACCESS_PATTERN', details: null, hint: null }, 400)
        if (['pin', 'pattern', 'password'].includes(mode) && !body.p_access_secret)
          return json({ code: '22023', message: 'ACCESS_SECRET_REQUIRED', details: null, hint: null }, 400)
        if (!['pin', 'pattern', 'password'].includes(mode) && body.p_access_secret != null)
          return json({ code: '22023', message: 'UNEXPECTED_ACCESS_SECRET', details: null, hint: null }, 400)
        return json({ order_id: 'f0000000-0000-4000-8000-0000000000aa', device_id: 'd0000000-0000-4000-8000-0000000000aa', replayed: false })
      }
      unmocked.add('rpc:' + fn)
      return json(null)
    }
    if (p.startsWith('/rest/v1/')) {
      const table = p.replace('/rest/v1/', '')
      if (req.method() !== 'GET' && req.method() !== 'HEAD') return json([])
      const wantsObject = (req.headers()['accept'] || '').includes('vnd.pgrst.object')
      if (table === 'businesses' && wantsObject) return json(SUBSCRIPTION)
      if (table === 'orders') return wantsObject ? json(ORDERS[0]) : list(ORDERS)
      if (table === 'customers') return wantsObject ? json(CLIENTES[0]) : list(CLIENTES)
      if (table === 'business_users_view') return list([{ id: USER_ID, full_name: 'QA Owner', email: user.email, role: 'owner', is_active: true, permissions: null }])
      if (table === 'business_settings') return wantsObject ? json({ dolar_source: 'nacional', auto_update_rate: true, nombre_comercial: 'Taller QA' }) : list([{ dolar_source: 'nacional', auto_update_rate: true, nombre_comercial: 'Taller QA' }])
      if (table === 'exchange_rates') return wantsObject ? json({ rate: 1556, source: 'bluelytics', updated_at: new Date().toISOString() }) : list([{ rate: 1556, source: 'bluelytics', updated_at: new Date().toISOString() }])
      unmocked.add('table:' + table + (wantsObject ? '(single)' : ''))
      if (wantsObject) return json({ code: 'PGRST116', message: 'mock: 0 rows' }, 406)
      return list([])
    }
    if (p.startsWith('/functions/v1/fetch-dollar-rate')) return json({ sell: 1556, buy: 1530, source: 'AMBITO_NACIONAL' })
    if (p.startsWith('/functions/v1/')) return json({ error: 'mock' }, 404)
    if (p.startsWith('/storage/v1/')) return json({})
    return route.abort()
  })
}

// ── Medidas ──────────────────────────────────────────────────────────────────
const measure = page => page.evaluate(() => {
  const r = el => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top + scrollY), bottom: Math.round(b.bottom + scrollY), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) } }
  const visible = el => { if (!el) return false; const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' }
  const inner = document.querySelector('.main-layout-inner')
  const bar = [document.querySelector('.top-header'), document.querySelector('.mobile-app-header')].find(visible)
  const hdr = inner && [...inner.querySelectorAll('.page-hdr, .page-top, .app-page-header, .intake-header')].find(visible)
  if (!hdr) return { error: 'sin encabezado', url: location.pathname }
  const h1 = hdr.querySelector('h1')
  const sub = hdr.querySelector('p')
  const svg = hdr.querySelector('svg')
  const tile = svg && svg.parentElement
  const cs = el => el ? getComputedStyle(el) : null
  // Bloques que siguen al encabezado (hermanos visibles, en orden).
  const blocks = []
  let n = hdr.nextElementSibling
  while (n && blocks.length < 4) {
    if (visible(n) && getComputedStyle(n).position !== 'fixed' && getComputedStyle(n).position !== 'absolute') blocks.push(n)
    n = n.nextElementSibling
  }
  const gaps = []
  let prev = hdr
  for (const b of blocks) { gaps.push(Math.round(b.getBoundingClientRect().top - prev.getBoundingClientRect().bottom)); prev = b }
  const actions = [...hdr.querySelectorAll('a.btn, button.btn, a[href].btn')].filter(visible).map(a => ({ text: (a.textContent || '').trim().slice(0, 24), h: Math.round(a.getBoundingClientRect().height) }))
  return {
    url: location.pathname,
    barToHeader: bar ? Math.round(hdr.getBoundingClientRect().top - bar.getBoundingClientRect().bottom) : null,
    header: r(hdr),
    tile: tile && tile !== hdr ? { w: Math.round(tile.getBoundingClientRect().width), h: Math.round(tile.getBoundingClientRect().height), radius: cs(tile).borderRadius, bg: cs(tile).backgroundImage !== 'none' ? 'gradient' : cs(tile).backgroundColor } : null,
    glyph: svg ? Math.round(svg.getBoundingClientRect().width) : null,
    title: h1 ? { text: h1.textContent.trim().slice(0, 40), size: cs(h1).fontSize, weight: cs(h1).fontWeight, color: cs(h1).color } : null,
    subtitle: sub ? { size: cs(sub).fontSize, color: cs(sub).color } : null,
    gaps,
    blocks: blocks.map(b => `${b.tagName.toLowerCase()}.${String(b.className).split(' ').slice(0, 2).join('.')}`),
    actions,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
})

const report = []
const measures = {}

async function open(browserCtxOpts, theme) {
  const browser = await chromium.launch()
  const ctx = await browser.newContext(browserCtxOpts)
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
  await mockBackend(ctx)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)))
  return { browser, page, errors }
}

const settle = async page => {
  await page.waitForTimeout(1800)
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))))
  await page.mouse.move(0, 0)
}

async function shotPage({ name, route, width = 1440, height = 900, theme = 'light', ready = '.main-layout-inner h1', fullPage = false, steps }) {
  if (only.length && !only.includes(name)) return
  const { browser, page, errors } = await open({ viewport: { width, height }, deviceScaleFactor: 1 }, theme)
  try {
    // Vite en frío optimiza dependencias y recarga: la primera ruta de la
    // corrida puede tardar. Un reintento largo en vez de un falso rojo.
    for (let intento = 0; ; intento += 1) {
      try {
        await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 120_000 })
        await page.waitForSelector(ready, { timeout: 90_000 })
        break
      } catch (e) { if (intento >= 2) throw e }
    }
    await settle(page)
    if (steps) await steps(page)
    const m = await measure(page)
    measures[name] = m
    report.push(`[${name}] ${width}x${height} ${theme} errors=${errors.length} ${JSON.stringify(m)}`)
    await page.screenshot({ path: path.join(outDir, `${label}-${name}.png`), fullPage, caret: 'initial', animations: 'disabled' })
  } catch (e) {
    report.push(`[${name}] FALLÓ: ${String(e.message).slice(0, 200)}`)
  } finally { await browser.close() }
}

/** Recorre el wizard completo; en el paso de acceso dibuja 1-5-9. */
async function walkWizard({ name, width, height, theme = 'light' }) {
  if (only.length && !only.includes(name)) return
  const { browser, page, errors } = await open({ viewport: { width, height }, deviceScaleFactor: 1 }, theme)
  const before = rpcCalls.length
  const log = []
  try {
    await page.goto(base + '/orders/new', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.intake-page h1', { timeout: 90_000 })
    await page.getByRole('button', { name: /Juan Pérez/ }).first().click()
    const visibleBtn = text => page.locator('button:visible', { hasText: text }).last()
    for (let i = 0; i < 14; i++) {
      await settle(page)
      const heading = (await page.locator('.intake-page h1').first().textContent())?.trim()
      log.push(heading)
      // Lo que cada paso exige, sólo si está a la vista.
      const marca = page.getByLabel('Marca', { exact: true })
      if (await marca.isVisible().catch(() => false) && !(await marca.inputValue())) {
        await marca.fill('Samsung'); await page.keyboard.press('Escape')
        await page.getByLabel('Modelo', { exact: true }).fill('Galaxy A54'); await page.keyboard.press('Escape')
      }
      const patron = page.getByRole('button', { name: /Patrón\s*Secuencia/ })
      if (await patron.isVisible().catch(() => false)) {
        await patron.click()
        for (const n of [1, 5, 9]) await page.getByRole('button', { name: `Punto ${n}` }).click()
      }
      const problema = page.getByLabel('Problema informado por el cliente')
      if (await problema.isVisible().catch(() => false) && !(await problema.inputValue())) await problema.fill('No carga')
      await page.screenshot({ path: path.join(outDir, `${label}-${name}-${String(i + 1).padStart(2, '0')}.png`), fullPage: true, caret: 'initial', animations: 'disabled' })
      const crear = visibleBtn('Crear orden')
      if (await crear.isVisible().catch(() => false)) {
        await crear.click()
        await page.waitForTimeout(2500)
        break
      }
      await visibleBtn('Continuar').click()
      const alerta = page.locator('[role="alert"]:visible').first()
      if (await alerta.isVisible().catch(() => false)) { log.push('ALERTA: ' + (await alerta.textContent())?.trim()); }
    }
    const alertText = await page.locator('[role="alert"]:visible').first().textContent().catch(() => null)
    const calls = rpcCalls.slice(before)
    measures[name] = { steps: log, rpc: calls, finalUrl: new URL(page.url()).pathname, alert: alertText?.trim() || null }
    report.push(`[${name}] ${width}x${height} errors=${errors.length} pasos=${log.length} ${JSON.stringify(measures[name])}`)
    await page.screenshot({ path: path.join(outDir, `${label}-${name}-final.png`), fullPage: false, caret: 'initial', animations: 'disabled' })
  } catch (e) {
    report.push(`[${name}] FALLÓ: ${String(e.message).slice(0, 300)} pasos=${JSON.stringify(log)}`)
  } finally { await browser.close() }
}

const PAGES = [
  ['dashboard', '/dashboard'], ['orders', '/orders'], ['comprobantes', '/comprobantes'],
  ['customers', '/customers'], ['inventory', '/inventory'], ['tasks', '/tasks'],
  ['caja', '/caja'], ['expenses', '/expenses'], ['suppliers', '/suppliers'],
  ['cuentas', '/cuentas'], ['warranties', '/warranties'], ['reports', '/reports'],
  ['finance', '/finance'], ['settings', '/settings'], ['users', '/users'],
]

try {
  for (const [name, route] of PAGES) await shotPage({ name: `${name}-desktop`, route })
  for (const [name, route] of PAGES) await shotPage({ name: `${name}-mobile`, route, width: 390, height: 844 })
  for (const name of ['dashboard', 'orders', 'comprobantes', 'settings']) await shotPage({ name: `${name}-desktop-dark`, route: PAGES.find(p => p[0] === name)[1], theme: 'dark' })
  await shotPage({ name: 'settings-desktop-full', route: '/settings', fullPage: true })
  await shotPage({ name: 'settings-mobile-full', route: '/settings', width: 390, height: 844, fullPage: true })
  await walkWizard({ name: 'wizard-mobile', width: 390, height: 844 })
  await walkWizard({ name: 'wizard-desktop', width: 1440, height: 900 })
} finally {
  await server.close()
}
report.push('\nSIN MOCK: ' + [...unmocked].sort().join(', '))
fs.writeFileSync(path.join(outDir, `measures-${label}.json`), JSON.stringify(measures, null, 2))
fs.writeFileSync(path.join(outDir, `report-${label}.txt`), report.join('\n'))
console.log(report.join('\n'))
