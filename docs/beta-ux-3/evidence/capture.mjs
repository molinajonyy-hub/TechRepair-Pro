// BETA-UX-3 — capturas de Administración y Centro de ayuda con sesión FALSA y
// backend SIMULADO. Nada sale de la máquina: VITE_SUPABASE_URL apunta a un
// puerto muerto y cada request se responde con route(). Sin Docker.
//
// Uso: node capture.mjs <root> <outDir> <etiqueta> [filtro,de,nombres]
//   <root>      raíz del repo a servir (la rama que se quiere fotografiar)
//   <outDir>    carpeta de salida (PNG + report-<etiqueta>.txt)
//   <etiqueta>  «before» / «after»: prefijo de cada archivo
//
// Mismo andamiaje que docs/beta-ux-2/evidence/capture.mjs; acá el rol del
// perfil cambia por captura (owner, admin, tech) para mostrar el filtro RBAC.
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const root = path.resolve(process.argv[2] || '.')
const outDir = path.resolve(process.argv[3] || 'out')
const label = process.argv[4] || 'run'
const only = (process.argv[5] || '').split(',').filter(Boolean)
const nm = p => pathToFileURL(path.join(root, 'node_modules', p)).href

const SB = 'http://127.0.0.1:59996'
process.env.VITE_SUPABASE_URL = SB
process.env.VITE_SUPABASE_ANON_KEY = 'local-dummy-anon-key'
// Número de fantasía con formato válido: sólo para que el CTA de soporte se dibuje.
process.env.VITE_CONTACT_WHATSAPP = process.env.VITE_CONTACT_WHATSAPP || '5490000000000'

const { createServer } = await import(nm('vite/dist/node/index.js'))
const { chromium } = await import(nm('playwright-core/index.mjs'))
fs.mkdirSync(outDir, { recursive: true })

const PORT = Number(process.env.CAPTURE_PORT || 5197)
const server = await createServer({
  root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
  cacheDir: path.join(os.tmpdir(), `vite-cache-beta-ux-3-${label}`),
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
const profileFor = role => ({
  id: USER_ID, user_id: USER_ID, business_id: BIZ_ID, email: user.email, full_name: `QA ${role}`,
  role, is_active: true, permissions: null, created_at: '2026-10-01T12:00:00Z',
})
const day = 86400e3
const SUBSCRIPTION = {
  subscription_status: 'active', subscription_plan: 'full', access_source: 'admin_override',
  mp_preapproval_id: null, mp_payer_email: null, current_period_start: new Date(Date.now() - 10 * day).toISOString(),
  current_period_end: new Date(Date.now() + 20 * day).toISOString(), grace_until: null, last_payment_status: null,
  trial_ends_at: new Date(Date.now() - 40 * day).toISOString(), override_expires_at: null,
}
const SETTINGS_ROW = { business_id: BIZ_ID, dolar_source: 'nacional', auto_update_rate: true, nombre_comercial: 'Taller QA', mayorista_enabled: true }

const unmocked = new Set()

async function mockBackend(ctx, role) {
  const profile = profileFor(role)
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
      unmocked.add('rpc:' + fn)
      return json(null)
    }
    if (p.startsWith('/rest/v1/')) {
      const table = p.replace('/rest/v1/', '')
      if (req.method() !== 'GET' && req.method() !== 'HEAD') return json([])
      const wantsObject = (req.headers()['accept'] || '').includes('vnd.pgrst.object')
      if (table === 'businesses' && wantsObject) return json(SUBSCRIPTION)
      if (table === 'business_users_view') return list([
        { id: USER_ID, full_name: `QA ${role}`, email: user.email, role, is_active: true, permissions: null },
        { id: '00000000-0000-4000-8000-00000000c0de', full_name: 'Técnico QA', email: 'tecnico.qa@example.test', role: 'tech', is_active: true, permissions: null },
      ])
      if (table === 'business_settings') return wantsObject ? json(SETTINGS_ROW) : list([SETTINGS_ROW])
      if (table === 'exchange_rates') { const row = { rate: 1556, source: 'bluelytics', updated_at: new Date().toISOString() }; return wantsObject ? json(row) : list([row]) }
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

const report = []

async function open(viewport, theme, role) {
  // CHROMIUM_PATH: un Chromium ya instalado cuando la versión de Playwright no trae el suyo.
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 })
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
  await mockBackend(ctx, role)
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

/** Lo que el menú ofrece en Administración (texto de cada enlace, en orden). */
const adminItems = page => page.evaluate(() => {
  const visible = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 }
  const nav = [...document.querySelectorAll('nav')].find(n => visible(n) && /Navegación lateral|Más módulos/.test(n.getAttribute('aria-label') || ''))
  if (!nav) return null
  const sections = [...nav.children].map(sec => ({
    label: (sec.firstElementChild && sec.firstElementChild.tagName === 'DIV' ? sec.firstElementChild.textContent : '').trim(),
    items: [...sec.querySelectorAll('a')].map(a => a.textContent.trim()),
  }))
  return sections.find(s => /Administraci/i.test(s.label)) || null
})

async function shot({ name, route, width = 1440, height = 900, theme = 'light', role = 'owner', ready = '.main-layout-inner h1', fullPage = false, steps, clip }) {
  if (only.length && !only.includes(name)) return
  const { browser, page, errors } = await open({ width, height }, theme, role)
  try {
    for (let intento = 0; ; intento += 1) {
      try {
        await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 120_000 })
        await page.waitForSelector(ready, { timeout: 90_000 })
        break
      } catch (e) { if (intento >= 2) throw e }
    }
    await settle(page)
    if (steps) { await steps(page); await settle(page) }
    const admin = await adminItems(page)
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    report.push(`[${name}] ${width}x${height} ${theme} ${role} url=${new URL(page.url()).pathname}${new URL(page.url()).search} errors=${errors.length} overflowX=${overflowX} admin=${JSON.stringify(admin)}`)
    const target = clip ? page.locator(clip).first() : page
    await target.screenshot({ path: path.join(outDir, `${label}-${name}.png`), ...(clip ? {} : { fullPage }), caret: 'initial', animations: 'disabled' })
  } catch (e) {
    report.push(`[${name}] FALLÓ: ${String(e.message).slice(0, 200)}`)
  } finally { await browser.close() }
}

const scrollSidebarToEnd = page => page.evaluate(() => {
  const nav = document.querySelector('.sidebar nav')
  if (nav) nav.scrollTop = nav.scrollHeight
})
const openMore = async page => {
  await page.locator('button[aria-label="Abrir más módulos"]:visible').first().click()
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    const nav = document.querySelector('#mobile-more-drawer nav')
    if (nav) nav.scrollTop = nav.scrollHeight
  })
}

try {
  // Menú lateral: la sección Administración por rol.
  for (const role of ['owner', 'admin', 'tech']) {
    await shot({ name: `sidebar-${role}`, route: '/dashboard', role, height: 1000, steps: scrollSidebarToEnd, clip: '.sidebar' })
  }
  // Configuración y las pantallas que ahora viven dentro.
  await shot({ name: 'configuracion-desktop', route: '/settings' })
  await shot({ name: 'usuarios-desktop', route: '/users' })
  await shot({ name: 'moneda-desktop', route: '/currency-settings' })
  await shot({ name: 'suscripcion-desktop', route: '/subscription' })
  await shot({ name: 'configuracion-admin-desktop', route: '/settings', role: 'admin' })
  // Laptop de 1280: la columna de la sección es la más angosta del escritorio.
  await shot({ name: 'usuarios-1280', route: '/users', width: 1280, height: 800 })
  await shot({ name: 'suscripcion-1280', route: '/subscription', width: 1280, height: 800 })
  await shot({ name: 'moneda-1280', route: '/currency-settings', width: 1280, height: 800 })
  // Ayuda.
  await shot({ name: 'ayuda-desktop', route: '/ayuda' })
  await shot({ name: 'tutoriales-desktop', route: '/tutorials' })
  await shot({ name: 'ayuda-tech-desktop', route: '/ayuda', role: 'tech' })
  await shot({ name: 'ayuda-desktop-dark', route: '/ayuda', theme: 'dark' })
  // Celular.
  await shot({ name: 'mas-mobile', route: '/dashboard', width: 390, height: 844, steps: openMore })
  await shot({ name: 'configuracion-mobile', route: '/settings', width: 390, height: 844, fullPage: true })
  await shot({ name: 'usuarios-mobile', route: '/users', width: 390, height: 844 })
  await shot({ name: 'ayuda-mobile', route: '/ayuda', width: 390, height: 844, fullPage: true })
  await shot({ name: 'tutoriales-mobile', route: '/tutorials', width: 390, height: 844 })
} finally {
  await server.close()
}
report.push('\nSIN MOCK: ' + [...unmocked].sort().join(', '))
fs.writeFileSync(path.join(outDir, `report-${label}.txt`), report.join('\n'))
console.log(report.join('\n'))
