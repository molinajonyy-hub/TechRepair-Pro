// HOTFIX BETA-UX-1G — volver de Google al login, en un navegador REAL con
// back/forward cache.
//
// Por qué un guion aparte y no el E2E de siempre: Playwright lanza Chromium con
// `--disable-back-forward-cache` (está en sus argumentos por defecto), así que
// ningún E2E del repo podía ver una página restaurada desde el historial. Acá se
// lanza SIN ese argumento.
//
// Nada se intercepta con `page.route`: el build de PRODUCCIÓN se sirve con
// `vite preview`, y Supabase y «Google» son dos servidores HTTP locales de este
// mismo proceso, en otros puertos. Así la página es elegible para el bfcache
// igual que en producción (una interceptación de red podría cambiar eso).
//
//   · Supabase falso (127.0.0.1:59999): /auth/v1/authorize responde 302 a
//     «Google», como GoTrue; /auth/v1/user, /token y las RPC responden según el
//     token (cuenta existente con negocio · cuenta nueva sin negocio).
//   · «Google» falso (127.0.0.1:59998): «Cancelar» vuelve al callback con
//     `error=access_denied` (lo que hace GoTrue cuando el usuario cancela);
//     «Elegir cuenta» vuelve con los tokens en el fragmento (flujo implícito).
//
// Uso: node google-return.mjs <worktree> <dirTemporal> <reporte.txt>
//        [--motor=webkit] [--canal=chrome|chromium|msedge] [--capturas=<prefijo>] [--gate]
//
// `--capturas=docs/x/antes` guarda `antes-B1-volver-de-google.png` y
// `antes-C1-cancelar.png`. `--gate` sale con 1 si alguna comprobación falla.
import path from 'node:path'
import http from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const [worktree, tmp, salida] = args
const motor = (args.find(a => a.startsWith('--motor=')) || '--motor=chromium').split('=')[1]
const gate = args.includes('--gate')
const capturas = (args.find(a => a.startsWith('--capturas=')) || '').slice('--capturas='.length) || null
if (!worktree || !tmp || !salida) {
  console.error('Uso: node google-return.mjs <worktree> <dirTemporal> <reporte.txt> [--motor=webkit] [--canal=chrome] [--capturas=<prefijo>] [--gate]')
  process.exit(2)
}
const capturar = async (page, nombre) => { if (capturas) await page.screenshot({ path: `${capturas}-${nombre}.png` }) }
const nm = p => pathToFileURL(path.join(worktree, 'node_modules', p)).href

const SB_PORT = 59999
const GOOGLE_PORT = 59998
const APP_PORT = Number(process.env.APP_PORT || 5191)
const SB = `http://127.0.0.1:${SB_PORT}`
const APP = `http://127.0.0.1:${APP_PORT}`
const GOOGLE = `http://127.0.0.1:${GOOGLE_PORT}`

// ── Build de producción contra el Supabase falso ─────────────────────────────
process.env.VITE_SUPABASE_URL = SB
process.env.VITE_SUPABASE_ANON_KEY = 'local-dummy-anon-key'
process.env.VITE_CONTACT_WHATSAPP = '5490000000000'
const { build, preview } = await import(nm('vite/dist/node/index.js'))
const outDir = path.join(tmp, 'dist')
mkdirSync(tmp, { recursive: true })
await build({
  root: worktree, configFile: path.join(worktree, 'vite.config.ts'), mode: 'production', logLevel: 'error',
  cacheDir: path.join(tmp, 'vite-cache'), build: { outDir, emptyOutDir: true },
})
const servidorApp = await preview({
  root: worktree, configFile: path.join(worktree, 'vite.config.ts'), mode: 'production', logLevel: 'error',
  build: { outDir }, preview: { host: '127.0.0.1', port: APP_PORT, strictPort: true, open: false },
})

// ── Supabase falso ───────────────────────────────────────────────────────────
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const ahora = () => Math.floor(Date.now() / 1000)
const CUENTAS = {
  existente: { id: '00000000-0000-4000-8000-0000000e0001', email: 'existente.qa@example.test', negocio: '00000000-0000-4000-8000-0000000b0001' },
  nueva: { id: '00000000-0000-4000-8000-0000000e0002', email: 'nueva.qa@example.test', negocio: null },
}
const jwtDe = c => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: c.id, email: c.email, exp: ahora() + 3600, role: 'authenticated', aud: 'authenticated' })}.sig`
const usuarioDe = c => ({
  id: c.id, aud: 'authenticated', role: 'authenticated', email: c.email, email_confirmed_at: '2026-10-01T12:00:00Z',
  app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: { full_name: 'QA' },
  identities: [], created_at: '2026-10-01T11:59:00Z', updated_at: '2026-10-01T11:59:00Z',
})
const sesionDe = c => ({ access_token: jwtDe(c), token_type: 'bearer', expires_in: 3600, expires_at: ahora() + 3600, refresh_token: `rt-${c.id}`, user: usuarioDe(c) })
const cuentaDelToken = auth => {
  const token = (auth || '').replace(/^Bearer\s+/i, '')
  try {
    const sub = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString()).sub
    return Object.values(CUENTAS).find(c => c.id === sub) ?? null
  } catch { return null }
}
const pedidos = []
// I1: mientras sea true, /authorize no contesta (red lenta) y la navegación hacia
// el proveedor queda pendiente hasta que el navegador la detenga.
let colgarAuthorize = false
const colgados = []
const servidorSb = http.createServer((req, res) => {
  const u = new URL(req.url, SB)
  const cors = {
    'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS,HEAD', 'access-control-expose-headers': 'content-range',
  }
  const json = (body, status = 200, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...cors, ...extra }); res.end(JSON.stringify(body)) }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
  pedidos.push(`${req.method} ${u.pathname}`)
  let cuerpo = ''
  req.on('data', d => { cuerpo += d })
  req.on('end', () => {
    if (u.pathname === '/auth/v1/authorize') {
      if (colgarAuthorize) { colgados.push(res); return }
      // Como GoTrue: 302 al proveedor, que después vuelve a `redirect_to`.
      res.writeHead(302, { location: `${GOOGLE}/o/oauth2/auth?redirect_to=${encodeURIComponent(u.searchParams.get('redirect_to') || '')}` })
      res.end(); return
    }
    if (u.pathname === '/auth/v1/user') {
      const c = cuentaDelToken(req.headers.authorization)
      return c ? json(usuarioDe(c)) : json({ code: 'bad_jwt', msg: 'invalid' }, 401)
    }
    if (u.pathname === '/auth/v1/token') {
      const tipo = u.searchParams.get('grant_type')
      if (tipo === 'password') {
        const { email } = JSON.parse(cuerpo || '{}')
        const c = Object.values(CUENTAS).find(x => x.email === email)
        return c ? json(sesionDe(c)) : json({ code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400)
      }
      if (tipo === 'refresh_token') {
        const { refresh_token: rt } = JSON.parse(cuerpo || '{}')
        const c = Object.values(CUENTAS).find(x => `rt-${x.id}` === rt)
        return c ? json(sesionDe(c)) : json({ code: 'refresh_token_not_found' }, 400)
      }
      return json({}, 400)
    }
    if (u.pathname === '/auth/v1/logout') { res.writeHead(204, cors); res.end(); return }
    if (u.pathname.startsWith('/auth/v1/')) return json({})
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const nombre = u.pathname.replace('/rest/v1/rpc/', '')
      const c = cuentaDelToken(req.headers.authorization)
      if (nombre === 'get_my_profile') {
        return json(c?.negocio ? [{ id: c.id, user_id: c.id, business_id: c.negocio, email: c.email, full_name: 'QA', role: 'owner', is_active: true, permissions: null, created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z' }] : null)
      }
      return json(null)
    }
    if (u.pathname.startsWith('/rest/v1/')) {
      if ((req.headers.accept || '').includes('vnd.pgrst.object')) return json({ code: 'PGRST116', message: 'mock: 0 rows' }, 406)
      return json([], 200, { 'content-range': '*/0' })
    }
    if (u.pathname.startsWith('/functions/v1/')) return json({ error: 'mock' }, 404)
    json({}, 404)
  })
})
await new Promise(r => servidorSb.listen(SB_PORT, '127.0.0.1', r))

// ── «Google» falso ───────────────────────────────────────────────────────────
const servidorGoogle = http.createServer((req, res) => {
  const u = new URL(req.url, GOOGLE)
  const vuelta = u.searchParams.get('redirect_to') || `${APP}/auth/callback`
  const exito = c => {
    const s = sesionDe(c)
    const h = new URLSearchParams({ access_token: s.access_token, expires_in: '3600', expires_at: String(s.expires_at), refresh_token: s.refresh_token, token_type: 'bearer', provider_token: 'pt-qa' })
    return `${vuelta}#${h.toString()}`
  }
  const cancelar = `${vuelta}?${new URLSearchParams({ error: 'access_denied', error_description: 'The user denied the request' })}#${new URLSearchParams({ error: 'access_denied', error_description: 'The user denied the request' })}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><title>Google falso</title>
    <h1 id="google-falso">Elegí una cuenta</h1>
    <p><a id="cuenta-existente" href="${exito(CUENTAS.existente)}">Cuenta existente</a></p>
    <p><a id="cuenta-nueva" href="${exito(CUENTAS.nueva)}">Cuenta nueva</a></p>
    <p><a id="cancelar" href="${cancelar}">Cancelar</a></p>`)
})
await new Promise(r => servidorGoogle.listen(GOOGLE_PORT, '127.0.0.1', r))

// ── Navegador con bfcache ────────────────────────────────────────────────────
const pw = await import(nm('playwright-core/index.mjs'))
// Control del instrumento (bfcache-probe.mjs): el «headless shell» que Playwright usa por
// defecto NO restaura ninguna página desde el bfcache, ni una trivial. Chrome instalado,
// Edge y `channel: 'chromium'` sí. Por eso el canal por defecto es el Chrome real.
const canal = (args.find(a => a.startsWith('--canal=')) || '--canal=chrome').split('=')[1]
const browser = await pw[motor].launch(motor === 'chromium' ? { channel: canal, ignoreDefaultArgs: ['--disable-back-forward-cache'] } : {})

const lineas = []
let fallas = 0
const decir = t => { console.log(t); lineas.push(t) }
const exigir = (ok, t) => { if (!ok) fallas += 1; decir(`  ${ok ? 'OK   ' : gate ? 'FALLA' : 'no   '} ${t}`) }

async function nuevaPagina() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  await ctx.addInitScript(() => {
    try { localStorage.setItem('techrepair_theme', 'light') } catch { /* sin storage */ }
    // Cuenta las restauraciones desde el historial de ESTE documento.
    window.addEventListener('pageshow', e => {
      if (e.persisted) (window).__bfcache = ((window).__bfcache || 0) + 1
    })
    // Navigation API (si existe): cuenta las navegaciones que no terminaron.
    if ('navigation' in window) {
      (window).navigation.addEventListener('navigateerror', () => { (window).__navErr = ((window).__navErr || 0) + 1 })
    }
  })
  const page = await ctx.newPage()
  return { ctx, page }
}

const estadoLogin = page => page.evaluate(() => {
  const g = document.querySelector('[data-testid="login-google"]')
  const enviar = document.querySelector('[data-testid="login-submit"]')
  const email = document.querySelector('[data-testid="login-email"]')
  const nav = performance.getEntriesByType('navigation')[0]
  return {
    restaurada: (window).__bfcache || 0,
    navegacionesFallidas: (window).__navErr || 0,
    textoGoogle: g?.textContent?.trim() ?? null,
    googleDeshabilitado: g ? g.hasAttribute('disabled') : null,
    enviarDeshabilitado: enviar ? enviar.hasAttribute('disabled') : null,
    emailDeshabilitado: email ? email.hasAttribute('disabled') : null,
    destinoGuardado: sessionStorage.getItem('post_login_redirect'),
    // Chrome explica por qué NO se restauró desde el bfcache (si es el caso).
    motivosNoRestaurada: nav?.notRestoredReasons ? JSON.stringify(nav.notRestoredReasons.reasons ?? nav.notRestoredReasons) : null,
  }
})

const resumen = e => `restaurada del bfcache=${e.restaurada} · Google=«${e.textoGoogle}» deshabilitado=${e.googleDeshabilitado} · enviar deshabilitado=${e.enviarDeshabilitado} · email deshabilitado=${e.emailDeshabilitado} · destino guardado=${JSON.stringify(e.destinoGuardado)}${e.motivosNoRestaurada && e.restaurada === 0 ? ` · no restaurada por: ${e.motivosNoRestaurada}` : ''}`

async function irAGoogle(page) {
  await page.getByTestId('login-google').click()
  await page.waitForURL(u => u.port === String(GOOGLE_PORT), { timeout: 30_000 })
}

// `waitUntil: 'commit'`: en un documento restaurado desde el historial Playwright
// no vuelve a ver el `load`, y sin esto espera ese evento aun para una navegación
// interna de la SPA que ya ocurrió.
const salirDelLogin = page =>
  page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 30_000, waitUntil: 'commit' }).catch(() => {})

async function entrarConContrasena(page) {
  await page.getByTestId('login-email').fill(CUENTAS.existente.email)
  await page.getByTestId('login-password').fill('una-clave-valida')
  await page.getByTestId('login-submit').click()
  await salirDelLogin(page)
  return new URL(page.url()).pathname
}

decir(`Motor: ${motor}${motor === 'chromium' ? ` · canal ${canal}, sin --disable-back-forward-cache` : ''}`)
decir(`App: build de producción servido en ${APP}`)

// B1 — Atrás desde Google.
{
  decir('\nB1 · «Continuar con Google» → en Google, botón Atrás → /login')
  const { ctx, page } = await nuevaPagina()
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle' })
  await irAGoogle(page)
  await page.goBack({ waitUntil: 'commit' })
  await page.waitForSelector('[data-testid="login-google"]', { timeout: 30_000 })
  await page.waitForTimeout(400)
  const e = await estadoLogin(page)
  decir(`  ·     ${resumen(e)}`)
  await capturar(page, 'B1-volver-de-google')
  exigir(e.restaurada >= 1, 'la página volvió desde el bfcache (condición para reproducir)')
  exigir(e.textoGoogle === 'Continuar con Google' && e.googleDeshabilitado === false, 'el botón de Google vuelve a «Continuar con Google» y habilitado')
  exigir(e.enviarDeshabilitado === false && e.emailDeshabilitado === false, 'el formulario de contraseña vuelve a estar habilitado')
  exigir(e.destinoGuardado === null, 'no queda guardado el destino de un intento abandonado')

  // B2 — segundo intento de Google después de volver.
  if (e.googleDeshabilitado === false) {
    await irAGoogle(page)
    exigir(true, 'B2 · segundo intento: «Continuar con Google» vuelve a llevar a Google')
    await page.goBack({ waitUntil: 'commit' })
    await page.waitForSelector('[data-testid="login-google"]', { timeout: 30_000 })
    await page.waitForTimeout(400)
    const e2 = await estadoLogin(page)
    exigir(e2.googleDeshabilitado === false && e2.restaurada >= 2, `B2 · y volver otra vez también deja el login usable (${resumen(e2)})`)
  } else {
    exigir(false, 'B2 · segundo intento: imposible, el botón sigue deshabilitado')
  }

  // B3 — contraseña después de volver.
  if (e.enviarDeshabilitado === false) {
    const destino = await entrarConContrasena(page)
    exigir(destino === '/dashboard', `B3 · login con contraseña después de volver de Google → ${destino}`)
  } else {
    exigir(false, 'B3 · login con contraseña después de volver: imposible, el formulario sigue deshabilitado')
  }
  await ctx.close()
}

// B4 — el destino pedido sobrevive al ida y vuelta (por la URL, no por lo guardado).
{
  decir('\nB4 · /login?redirectTo=/orders → Google → Atrás → contraseña')
  const { ctx, page } = await nuevaPagina()
  await page.goto(`${APP}/login?redirectTo=%2Forders`, { waitUntil: 'networkidle' })
  await irAGoogle(page)
  await page.goBack({ waitUntil: 'commit' })
  await page.waitForSelector('[data-testid="login-google"]', { timeout: 30_000 })
  await page.waitForTimeout(400)
  const e = await estadoLogin(page)
  decir(`  ·     ${resumen(e)}`)
  if (e.enviarDeshabilitado === false) {
    const destino = await entrarConContrasena(page)
    exigir(destino === '/orders', `el destino pedido se respeta: ${destino}`)
  } else {
    exigir(false, 'el destino pedido no se puede comprobar: el formulario sigue deshabilitado')
  }
  await ctx.close()
}

// C1 — cancelar en Google: vuelve por /auth/callback con access_denied.
{
  decir('\nC1 · «Continuar con Google» → «Cancelar» en Google → /auth/callback')
  const { ctx, page } = await nuevaPagina()
  await page.goto(`${APP}/login?redirectTo=%2Forders`, { waitUntil: 'networkidle' })
  await irAGoogle(page)
  await page.click('#cancelar')
  await page.waitForURL(u => u.pathname === '/auth/callback', { timeout: 30_000 })
  const tarjeta = page.getByTestId('auth-callback-error')
  await tarjeta.waitFor({ timeout: 30_000 })
  const titulo = (await tarjeta.locator('h1').textContent())?.trim()
  const detalle = await page.getByText('Cancelaste el inicio de sesión con Google.').count()
  await capturar(page, 'C1-cancelar')
  exigir(titulo === 'No iniciaste sesión' && detalle === 1, `el callback lo explica: «${titulo}» + «Cancelaste el inicio de sesión con Google.»`)
  exigir(!page.url().includes('error'), `sin el error en la barra: ${new URL(page.url()).pathname}${new URL(page.url()).search}`)
  await page.getByTestId('auth-callback-volver').click()
  await page.waitForSelector('[data-testid="login-google"]', { timeout: 30_000 })
  const e = await estadoLogin(page)
  exigir(e.textoGoogle === 'Continuar con Google' && e.googleDeshabilitado === false && e.enviarDeshabilitado === false, `«Volver a iniciar sesión» deja el login usable (${resumen(e)})`)
  await irAGoogle(page)
  exigir(true, 'C1 · y Google se puede volver a intentar')
  await ctx.close()
}

// C1b — cancelar en Google, volver, y entrar con contraseña: el destino pedido
// antes de cancelar no se pierde.
{
  decir('\nC1b · /login?redirectTo=/orders → Google → «Cancelar» → «Volver a iniciar sesión» → contraseña')
  const { ctx, page } = await nuevaPagina()
  await page.goto(`${APP}/login?redirectTo=%2Forders`, { waitUntil: 'networkidle' })
  await irAGoogle(page)
  await page.click('#cancelar')
  await page.getByTestId('auth-callback-error').waitFor({ timeout: 30_000 })
  await page.getByTestId('auth-callback-volver').click()
  await page.waitForSelector('[data-testid="login-google"]', { timeout: 30_000 })
  const destino = await entrarConContrasena(page)
  const guardado = await page.evaluate(() => sessionStorage.getItem('post_login_redirect'))
  exigir(destino === '/orders' && guardado === null, `entra al destino pedido y lo consume: ${destino} · guardado=${JSON.stringify(guardado)}`)
  await ctx.close()
}

// C2 — cancelar en Google y después Atrás hasta el login original.
{
  decir('\nC2 · Google → «Cancelar» → callback → Atrás, Atrás (hasta el /login original)')
  const { ctx, page } = await nuevaPagina()
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle' })
  await irAGoogle(page)
  await page.click('#cancelar')
  await page.getByTestId('auth-callback-error').waitFor({ timeout: 30_000 })
  await page.goBack({ waitUntil: 'commit' })
  if (new URL(page.url()).port === String(GOOGLE_PORT)) await page.goBack({ waitUntil: 'commit' })
  await page.waitForSelector('[data-testid="login-google"]', { timeout: 30_000 })
  await page.waitForTimeout(400)
  const e = await estadoLogin(page)
  decir(`  ·     ${resumen(e)}`)
  exigir(e.googleDeshabilitado === false && e.enviarDeshabilitado === false, 'el login original queda usable')
  await ctx.close()
}

// I1 — la salida hacia Google se interrumpe ANTES de dejar el login: /authorize
// tarda y el navegador detiene la carga (botón «Detener» / Esc). CDP
// `Page.stopLoading` es lo mismo que ese botón. Sin restauración: no hay `pageshow`.
if (motor === 'chromium') {
  decir('\nI1 · «Continuar con Google» → /authorize no contesta → el navegador detiene la carga')
  const { ctx, page } = await nuevaPagina()
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle' })
  colgarAuthorize = true
  const pedido = page.waitForRequest(r => r.url().startsWith(`${SB}/auth/v1/authorize`), { timeout: 30_000 })
  // Clic desde la página: el `click` de Playwright esperaría la navegación que
  // acá, a propósito, nunca termina.
  await page.evaluate(() => document.querySelector('[data-testid="login-google"]').click())
  await pedido
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Page.stopLoading')
  colgarAuthorize = false
  await page.waitForTimeout(400)
  const e = await estadoLogin(page)
  decir(`  ·     ${resumen(e)} · navegaciones fallidas (navigateerror)=${e.navegacionesFallidas} · URL=${new URL(page.url()).pathname}`)
  await capturar(page, 'I1-carga-detenida')
  exigir(new URL(page.url()).pathname === '/login', 'el navegador sigue en el login (la salida no ocurrió)')
  exigir(e.textoGoogle === 'Continuar con Google' && e.googleDeshabilitado === false && e.enviarDeshabilitado === false, 'el login vuelve a estar usable')
  exigir(e.destinoGuardado === null, 'no queda guardado el destino de un intento abandonado')
  if (e.googleDeshabilitado === false) {
    await irAGoogle(page)
    exigir(true, 'I1 · y Google se puede volver a intentar')
  }
  await ctx.close()
  for (const r of colgados.splice(0)) r.destroy()
}

// S1 / S2 — Google completa (cuenta existente con negocio · cuenta nueva sin negocio).
for (const [clave, id, esperado] of [['existente', '#cuenta-existente', '/dashboard'], ['nueva', '#cuenta-nueva', '/no-business']]) {
  decir(`\nS · Google con cuenta ${clave}`)
  const { ctx, page } = await nuevaPagina()
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle' })
  await irAGoogle(page)
  await page.click(id)
  await page.waitForURL(u => u.pathname === esperado, { timeout: 30_000 }).catch(() => {})
  const u = new URL(page.url())
  exigir(u.pathname === esperado && !u.hash.includes('access_token'), `termina en ${u.pathname} (esperado ${esperado}), sin tokens en la URL`)
  await ctx.close()
}

// S3 — Google completa con un destino pedido.
{
  decir('\nS3 · /login?redirectTo=/orders → Google con cuenta existente')
  const { ctx, page } = await nuevaPagina()
  await page.goto(`${APP}/login?redirectTo=%2Forders`, { waitUntil: 'networkidle' })
  await irAGoogle(page)
  await page.click('#cuenta-existente')
  await page.waitForURL(u => u.pathname === '/orders', { timeout: 30_000 }).catch(() => {})
  const guardado = await page.evaluate(() => sessionStorage.getItem('post_login_redirect'))
  exigir(new URL(page.url()).pathname === '/orders' && guardado === null, `el callback lleva al destino pedido y lo consume: ${new URL(page.url()).pathname} · guardado=${JSON.stringify(guardado)}`)
  await ctx.close()
}

decir(`\n${fallas ? `RESULTADO: ${fallas} comprobación(es) no cumplidas` : 'RESULTADO: todas las comprobaciones se cumplen'}`)
writeFileSync(salida, lineas.join('\n') + '\n')
await browser.close()
servidorSb.close(); servidorGoogle.close()
await new Promise(r => servidorApp.httpServer.close(r))
process.exit(gate && fallas ? 1 : 0)
