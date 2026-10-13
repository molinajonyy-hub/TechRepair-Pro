// BETA-UX-1G — capturas del embudo de acceso con backend SIMULADO.
//
// Levanta un Vite propio sobre el worktree indicado, con `VITE_SUPABASE_URL` a un
// puerto muerto y cada request respondido con route(). No usa Docker ni toca
// ninguna base. Sirve igual sobre `main` (antes) y sobre la rama (después): sólo
// usa rutas y `data-testid` que existen en los dos.
//
// Uso: node capture-auth.mjs <worktree> <cacheDir> <outDir> [escena ...]
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [worktree, cacheDir, outDir, ...soloEstas] = process.argv.slice(2)
if (!worktree || !cacheDir || !outDir) {
  console.error('Uso: node capture-auth.mjs <worktree> <cacheDir> <outDir> [escena ...]')
  process.exit(2)
}
const nm = p => pathToFileURL(path.join(worktree, 'node_modules', p)).href

const SB = 'http://127.0.0.1:59999'
process.env.VITE_SUPABASE_URL = SB
process.env.VITE_SUPABASE_ANON_KEY = 'local-dummy-anon-key'
// Número de fantasía (no asignable) con el formato productivo.
process.env.VITE_CONTACT_WHATSAPP = '5490000000000'

const { createServer } = await import(nm('vite/dist/node/index.js'))
const { chromium } = await import(nm('playwright-core/index.mjs'))

const PORT = Number(process.env.CAPTURE_PORT || 5197)
const server = await createServer({
  root: worktree, configFile: path.join(worktree, 'vite.config.ts'), logLevel: 'error', cacheDir,
  server: { host: '127.0.0.1', port: PORT, strictPort: true, open: false },
})
await server.listen()
const base = `http://127.0.0.1:${PORT}`
mkdirSync(outDir, { recursive: true })

// ── Sesión y respuestas ──────────────────────────────────────────────────────
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const USER_ID = '00000000-0000-4000-8000-0000000001a6'
const now = Math.floor(Date.now() / 1000)
const EMAIL = 'tecnico.qa@example.test'
const jwt = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: USER_ID, exp: now + 86400, role: 'authenticated', aud: 'authenticated', email: EMAIL })}.sig`
const user = {
  id: USER_ID, aud: 'authenticated', role: 'authenticated', email: EMAIL,
  email_confirmed_at: '2026-10-01T12:00:00Z', app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: 'QA' }, created_at: '2026-10-01T11:59:00Z', identities: [],
}
const session = { access_token: jwt, token_type: 'bearer', expires_in: 86400, expires_at: now + 86400, refresh_token: 'fake-refresh', user }
const TOKEN = 'a'.repeat(64)

/**
 * `rpc`: nombre → cuerpo | { status, body }. `auth`: path → idem. Lo que no
 * figura responde vacío: ninguna escena depende de una respuesta implícita.
 */
function instalarBackend(ctx, { rpc = {}, auth = {} } = {}) {
  return ctx.route(`${SB}/**`, async route => {
    const p = new URL(route.request().url()).pathname
    const responder = v => (v && typeof v === 'object' && 'status' in v && 'body' in v)
      ? route.fulfill({ status: v.status, contentType: 'application/json', body: JSON.stringify(v.body) })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) })
    if (p.startsWith('/auth/v1/')) {
      const clave = Object.keys(auth).find(k => p.startsWith(`/auth/v1/${k}`))
      if (clave) return responder(auth[clave])
      if (p.startsWith('/auth/v1/user')) return responder(user)
      return responder({})
    }
    if (p.startsWith('/rest/v1/rpc/')) {
      const nombre = p.replace('/rest/v1/rpc/', '')
      return responder(nombre in rpc ? rpc[nombre] : null)
    }
    if (p.startsWith('/rest/v1/')) return responder([])
    return route.abort()
  })
}

const browser = await chromium.launch()

async function abrir({ tema, width, height, conSesion, sessionStore = {}, localStore = {}, backend }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
  await ctx.addInitScript(([s, t, ss, ls]) => {
    try {
      if (s) localStorage.setItem('sb-127-auth-token', s)
      localStorage.setItem('techrepair_theme', t)
      for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v)
      for (const [k, v] of Object.entries(ss)) sessionStorage.setItem(k, v)
    } catch { /* sin storage */ }
  }, [conSesion ? JSON.stringify(session) : null, tema, sessionStore, localStore])
  await ctx.route('**/*', r => {
    const u = r.request().url()
    // El aviso de versión nueva flota en dev y taparía la captura.
    if (/\/version\.json/.test(u)) return r.fulfill({ status: 404, body: '' })
    if (u.startsWith(base) || u.startsWith(SB) || u.startsWith('data:') || u.startsWith('blob:')) return r.fallback()
    if (/cdn\.jsdelivr\.net\/npm\/bootstrap|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(u)) return r.fallback()
    return r.abort()
  })
  await instalarBackend(ctx, backend)
  const page = await ctx.newPage()
  const errores = []
  page.on('pageerror', e => errores.push(String(e.message).slice(0, 200)))
  return { ctx, page, errores }
}

const asentar = page => page.evaluate(() => Promise.all(document.getAnimations()
  .filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))))

const marcaRecovery = () => ({ 'techrepair.auth.password-recovery': JSON.stringify({ v: 1, userId: USER_ID, at: Date.now() }) })
const errorRpc = (code, message) => ({ status: 400, body: { code, message, details: null, hint: null } })

// ── Escenas ──────────────────────────────────────────────────────────────────
// `listo`: selector o texto que prueba que la pantalla llegó al estado buscado.
// `antes`: interacción previa a la captura.
const ESCENAS = [
  { id: '01-login', ruta: '/login', listo: '[data-testid="login-email"]' },
  { id: '02-registro', ruta: '/login?modo=registro', listo: '[data-testid="login-confirm-password"]' },
  { id: '03-recuperar', ruta: '/login?modo=recuperar', listo: '[data-testid="login-forgot-email"]' },
  { id: '04-login-error-url', ruta: '/login?error=access_denied', listo: '[data-testid="login-error"]' },
  {
    id: '05-login-credenciales', ruta: '/login', listo: '[data-testid="login-error"]',
    backend: { auth: { token: { status: 400, body: { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials' } } } },
    antes: async page => {
      await page.getByTestId('login-email').fill('tecnico.qa@example.test')
      await page.getByTestId('login-password').fill('no-es-la-clave')
      await page.getByTestId('login-submit').click()
    },
  },
  {
    id: '06-registro-validacion', ruta: '/login?modo=registro', listo: 'text=Usá al menos 8 caracteres.',
    antes: async page => {
      await page.getByTestId('login-email').fill('tecnico.qa@example.test')
      await page.getByTestId('login-password').fill('corta12')
      await page.getByTestId('login-confirm-password').fill('corta12')
      await page.getByTestId('login-submit').click()
    },
  },
  { id: '07-login-invitacion', ruta: `/login?redirectTo=${encodeURIComponent(`/accept-invite?token=${TOKEN}`)}`, listo: '[data-testid="login-email"]' },
  {
    id: '08-recuperar-enviado', ruta: '/login?modo=recuperar', listo: '[data-testid="login-success"]',
    antes: async page => {
      await page.getByTestId('login-forgot-email').fill('tecnico.qa@example.test')
      await page.getByTestId('login-forgot-submit').click()
    },
  },
  { id: '09-reset-invalido', ruta: '/reset-password', listo: '[data-testid="reset-password-invalid"]' },
  { id: '10-reset-formulario', ruta: '/reset-password', listo: '[data-testid="reset-password-new"]', conSesion: true, sessionStore: marcaRecovery },
  {
    id: '11-reset-validacion', ruta: '/reset-password', listo: '[data-testid="reset-password-new-error"]', conSesion: true, sessionStore: marcaRecovery,
    antes: async page => {
      await page.getByTestId('reset-password-new').fill('corta12')
      await page.getByTestId('reset-password-confirm').fill('corta12')
      await page.getByTestId('reset-password-submit').click()
    },
  },
  { id: '12-callback-error', ruta: '/auth/callback?error=access_denied', listo: 'text=Cancelaste el inicio de sesión con Google.' },
  { id: '13-invitacion-sin-enlace', ruta: '/accept-invite', listo: 'text=/invitación/i' },
  {
    id: '14-invitacion-aceptada', ruta: `/accept-invite?token=${TOKEN}`, listo: 'text=/Invitación aceptada/i', conSesion: true,
    backend: { rpc: { accept_business_invitation: { business_id: 'b', role: 'tech', created: true, status: 'ACCEPTED' }, get_my_profile: null } },
  },
  {
    id: '15-invitacion-otro-correo', ruta: `/accept-invite?token=${TOKEN}`, listo: 'text=/otra dirección de correo/i', conSesion: true,
    backend: { rpc: { accept_business_invitation: errorRpc('TRIEM', 'INVITATION_EMAIL_MISMATCH'), get_my_profile: null } },
  },
  {
    id: '16-invitacion-vencida', ruta: `/accept-invite?token=${TOKEN}`, listo: 'text=/venció/i', conSesion: true,
    backend: { rpc: { accept_business_invitation: errorRpc('TRIEX', 'INVITATION_EXPIRED'), get_my_profile: null } },
  },
  {
    id: '17-verificar-email', ruta: '/verificar-email', listo: '[data-testid="verify-email-page"]',
    sessionStore: () => ({ trp_pending_confirmation_email: 'tecnico.qa@example.test' }),
  },
]

const VISTAS = [
  { sufijo: 'desktop-light', tema: 'light', width: 1440, height: 900 },
  { sufijo: 'mobile-light', tema: 'light', width: 390, height: 844 },
  { sufijo: 'desktop-dark', tema: 'dark', width: 1440, height: 900 },
  { sufijo: 'mobile-dark', tema: 'dark', width: 390, height: 844 },
]

const reporte = []
let fallas = 0
for (const escena of ESCENAS) {
  if (soloEstas.length && !soloEstas.some(s => escena.id.includes(s))) continue
  for (const vista of VISTAS) {
    const { ctx, page, errores } = await abrir({
      tema: vista.tema, width: vista.width, height: vista.height,
      conSesion: Boolean(escena.conSesion),
      sessionStore: escena.sessionStore ? escena.sessionStore() : {},
      backend: escena.backend,
    })
    const nombre = `${escena.id}-${vista.sufijo}.png`
    try {
      await page.goto(base + escena.ruta, { waitUntil: 'domcontentloaded' })
      if (escena.antes) {
        await page.waitForSelector('[data-testid="login-email"], [data-testid="login-forgot-email"], [data-testid="reset-password-new"]', { timeout: 120_000 })
        await escena.antes(page)
      }
      await page.waitForSelector(escena.listo, { timeout: 120_000 })
      await page.evaluate(() => document.fonts.ready)
      await asentar(page)
      await page.screenshot({ path: path.join(outDir, nombre), fullPage: true, caret: 'initial' })
      const linea = `OK    ${nombre}${errores.length ? `  · pageerror: ${errores.join(' | ')}` : ''}`
      console.log(linea); reporte.push(linea)
    } catch (e) {
      fallas += 1
      const linea = `FALLA ${nombre}  · ${String(e.message).split('\n')[0].slice(0, 180)}`
      console.log(linea); reporte.push(linea)
      await page.screenshot({ path: path.join(outDir, nombre.replace('.png', '-FALLA.png')), fullPage: true }).catch(() => {})
    }
    await ctx.close()
  }
}

writeFileSync(path.join(outDir, 'capture-report.txt'), reporte.join('\n') + '\n')
await browser.close()
await server.close()
process.exit(fallas ? 1 : 0)
