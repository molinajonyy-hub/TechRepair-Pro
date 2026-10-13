// BETA-UX-1G — verificación en navegador real con backend SIMULADO.
//
// Mismo arnés que `capture-auth.mjs`: Vite propio sobre el worktree indicado,
// `VITE_SUPABASE_URL` a un puerto muerto y cada request respondido con route().
// No usa Docker ni toca ninguna base.
//
// Corre igual sobre `main` y sobre la rama: el mismo guion, los dos reportes.
// Con `--gate` falla si alguna comprobación exigible no se cumple (la rama);
// sin él sólo mide (la base, donde varias no se cumplen: es el «antes»).
//
//   G  áreas táctiles de cada control (390×844)
//   O  sin desborde horizontal a 320 / 375 / 390 / 768 / 1440
//   C  contraste PINTADO de los textos, en claro y en oscuro
//   K  recorrido con teclado: orden, foco visible, flechas en el selector
//   A  nombres accesibles y errores asociados
//   F  flujos: destino tras ingresar, callback con error / sin sesión,
//      invitación que falla, reenvío que falla, aviso de versión vs. CTA
//
// Uso: node verify-auth.mjs <worktree> <cacheDir> <reporte.txt> [--gate] [--motor=webkit] [G O C K A F]
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const [worktree, cacheDir, salida] = args
const gate = args.includes('--gate')
const motor = (args.find(a => a.startsWith('--motor=')) || '--motor=chromium').split('=')[1]
const partes = args.slice(3).filter(a => /^[A-Z]$/.test(a))
const corre = p => partes.length === 0 || partes.includes(p)
if (!worktree || !cacheDir || !salida) {
  console.error('Uso: node verify-auth.mjs <worktree> <cacheDir> <reporte.txt> [--gate] [--motor=webkit] [G O C K A F]')
  process.exit(2)
}
const nm = p => pathToFileURL(path.join(worktree, 'node_modules', p)).href

const SB = 'http://127.0.0.1:59999'
process.env.VITE_SUPABASE_URL = SB
process.env.VITE_SUPABASE_ANON_KEY = 'local-dummy-anon-key'
process.env.VITE_CONTACT_WHATSAPP = '5490000000000'

const { createServer } = await import(nm('vite/dist/node/index.js'))
const pw = await import(nm('playwright-core/index.mjs'))
// El instrumento de contraste es el del E2E (tests/e2e/helpers/contrast.ts), el de la rama.
const { paintedContrastOf, contrastOf } = await import(pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../../tests/e2e/helpers/contrast.ts')).href)

const PORT = Number(process.env.VERIFY_PORT || 5195)
const server = await createServer({
  root: worktree, configFile: path.join(worktree, 'vite.config.ts'), logLevel: 'error', cacheDir,
  server: { host: '127.0.0.1', port: PORT, strictPort: true, open: false },
})
await server.listen()
const base = `http://127.0.0.1:${PORT}`

// ── Sesión y respuestas ──────────────────────────────────────────────────────
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const USER_ID = '00000000-0000-4000-8000-0000000001a6'
const BIZ_ID = '00000000-0000-4000-8000-0000000001b6'
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
const errorJson = (status, body) => ({ status, body })

function instalarBackend(ctx, { rpc = {}, auth = {} } = {}) {
  return ctx.route(`${SB}/**`, async route => {
    const p = new URL(route.request().url()).pathname
    const responder = v => (v && typeof v === 'object' && 'status' in v && 'body' in v)
      ? route.fulfill({ status: v.status, contentType: 'application/json', body: JSON.stringify(v.body) })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) })
    if (p.startsWith('/auth/v1/')) {
      const clave = Object.keys(auth).find(k => p.startsWith(`/auth/v1/${k}`))
      if (clave) return responder(typeof auth[clave] === 'function' ? auth[clave]() : auth[clave])
      if (p.startsWith('/auth/v1/user')) return responder(user)
      return responder({})
    }
    if (p.startsWith('/rest/v1/rpc/')) {
      const nombre = p.replace('/rest/v1/rpc/', '')
      const v = nombre in rpc ? rpc[nombre] : null
      return responder(typeof v === 'function' ? v() : v)
    }
    if (p.startsWith('/rest/v1/')) return responder([])
    return route.abort()
  })
}

const browser = await pw[motor].launch()
const lineas = []
let fallas = 0
const decir = t => { console.log(t); lineas.push(t) }
/** Comprobación exigible: cuenta como falla sólo con `--gate`. */
const exigir = (ok, t) => {
  if (!ok && gate) fallas += 1
  decir(`  ${ok ? 'OK   ' : gate ? 'FALLA' : 'no   '} ${t}`)
}
const medir = t => decir(`  ·     ${t}`)

async function abrir({ tema = 'light', width = 390, height = 844, conSesion = false, sessionStore = {}, localStore = {}, backend, version = false } = {}) {
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
    if (/\/version\.json/.test(u)) {
      return version
        ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ buildTime: 'future-build-for-verify', commit: 'test' }) })
        : r.fulfill({ status: 404, body: '' })
    }
    if (u.startsWith(base) || u.startsWith(SB) || u.startsWith('data:') || u.startsWith('blob:')) return r.fallback()
    if (/cdn\.jsdelivr\.net\/npm\/bootstrap|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(u)) return r.fallback()
    return r.abort()
  })
  await instalarBackend(ctx, backend)
  const page = await ctx.newPage()
  return { ctx, page }
}

const asentar = page => page.evaluate(() => Promise.all(document.getAnimations()
  .filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))))

async function ir(page, ruta, listo) {
  await page.goto(base + ruta, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(listo, { timeout: 120_000 })
  await page.evaluate(() => document.fonts.ready)
  await asentar(page)
}

const caja = async l => (await l.count()) ? l.first().boundingBox() : null
const r1 = n => Math.round(n * 10) / 10

// ═══ G · áreas táctiles ══════════════════════════════════════════════════════
if (corre('G')) {
  decir('\nG · áreas táctiles (390×844, tema claro) — mínimo exigido 44 px de alto')
  const controles = [
    ['Volver al inicio', p => p.getByRole('button', { name: 'Volver al inicio' })],
    ['modo «Iniciar sesión»', p => p.getByRole('tab', { name: 'Iniciar sesión' }).or(p.getByRole('button', { name: 'Iniciar sesión' }).first())],
    ['modo «Crear cuenta»', p => p.getByTestId('login-tab-register')],
    ['campo email', p => p.getByTestId('login-email')],
    ['campo contraseña', p => p.getByTestId('login-password')],
    ['mostrar contraseña', p => p.getByRole('button', { name: /Mostrar contraseña|Ocultar contraseña/ }).first()],
    ['Iniciar sesión (enviar)', p => p.getByTestId('login-submit')],
    ['Continuar con Google', p => p.getByRole('button', { name: 'Continuar con Google' })],
    ['¿Olvidaste tu contraseña?', p => p.getByTestId('login-forgot-link')],
  ]
  const { ctx, page } = await abrir()
  await ir(page, '/login', '[data-testid="login-email"]')
  for (const [nombre, loc] of controles) {
    const b = await caja(loc(page))
    if (!b) { medir(`${nombre}: no existe`); continue }
    exigir(b.height >= 43.5, `${nombre}: ${r1(b.width)}×${r1(b.height)} px`)
  }
  await ctx.close()

  for (const [ruta, listo, nombre, loc] of [
    ['/login?modo=recuperar', '[data-testid="login-forgot-email"]', 'recuperar · Volver al inicio de sesión', p => p.getByTestId('login-forgot-back')],
    ['/reset-password', '[data-testid="reset-password-invalid"]', 'reset · Volver al inicio de sesión', p => p.getByTestId('reset-password-back-login')],
    ['/reset-password', '[data-testid="reset-password-invalid"]', 'reset · Pedir un enlace nuevo', p => p.getByTestId('reset-password-request-new')],
    ['/accept-invite', 'text=/invitación/i', 'invitación · acción principal', p => p.locator('button[type="submit"]')],
    ['/accept-invite', 'text=/invitación/i', 'invitación · volver', p => p.getByRole('button', { name: /Volver al login|Ir a iniciar sesión/ })],
  ]) {
    const { ctx: c, page: p } = await abrir()
    await ir(p, ruta, listo)
    const b = await caja(loc(p))
    if (!b) medir(`${nombre}: no existe`)
    else exigir(b.height >= 43.5, `${nombre}: ${r1(b.width)}×${r1(b.height)} px`)
    await c.close()
  }
}

// ═══ O · desborde horizontal ═════════════════════════════════════════════════
if (corre('O')) {
  decir('\nO · sin desborde horizontal')
  const escenas = [
    ['/login', '[data-testid="login-email"]'],
    ['/login?modo=registro', '[data-testid="login-confirm-password"]'],
    ['/login?modo=recuperar', '[data-testid="login-forgot-email"]'],
    [`/login?redirectTo=${encodeURIComponent(`/accept-invite?token=${TOKEN}`)}`, '[data-testid="login-email"]'],
    ['/reset-password', '[data-testid="reset-password-invalid"]'],
    ['/auth/callback?error=access_denied', 'text=Cancelaste el inicio de sesión con Google.'],
    ['/accept-invite', 'text=/invitación/i'],
  ]
  for (const width of [320, 375, 390, 768, 1440]) {
    const malas = []
    for (const [ruta, listo] of escenas) {
      const { ctx, page } = await abrir({ width, height: width < 768 ? 700 : 900 })
      await ir(page, ruta, listo)
      const d = await page.evaluate(() => {
        const ancho = window.innerWidth
        const fuera = [...document.querySelectorAll('body *')].filter(el => {
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          if (!r.width || cs.position === 'fixed' || el.getAttribute('aria-hidden') === 'true') return false
          return r.right > ancho + 0.5 || r.left < -0.5
        }).length
        return { scroll: document.documentElement.scrollWidth, ancho, fuera }
      })
      if (d.scroll > d.ancho || d.fuera) malas.push(`${ruta.split('?')[0]}${ruta.includes('modo=') ? '?' + ruta.split('?')[1].slice(0, 14) : ''} (scrollWidth ${d.scroll}, ${d.fuera} fuera)`)
      await ctx.close()
    }
    exigir(malas.length === 0, `${width} px: ${malas.length ? malas.join(' · ') : `${escenas.length} pantallas sin desborde`}`)
  }
}

// ═══ C · contraste pintado ═══════════════════════════════════════════════════
if (corre('C')) {
  decir('\nC · contraste PINTADO (texto contra el fondo real) — mínimo 4,5:1; 3:1 en texto grande')
  // Cada medida es de UN color de texto. Un contenedor con un hijo de otro color
  // (una frase con un enlace adentro) no se mide entero: el instrumento oculta
  // los glifos del elemento medido y los del hijo quedarían como «fondo».
  //   `computado`: el elemento comparte caja con glifos vecinos (el «Pro» pegado
  //   a «TechRepair» por el interletrado negativo); se usa el color computado
  //   contra las capas de fondo compuestas.
  const AVISO = `/login?redirectTo=${encodeURIComponent(`/accept-invite?token=${TOKEN}`)}`
  const textos = [
    ['/login', '[data-testid="login-email"]', 390, [
      ['bajada de la marca', p => p.getByText('Ingresá a tu panel de gestión'), 4.5],
      ['«Pro» de la marca', p => p.locator('h1 span').first(), 3, 'computado'],
      ['modo elegido', p => p.getByTestId('login-tab-register').locator('xpath=preceding-sibling::*[1]'), 4.5],
      ['modo no elegido', p => p.getByTestId('login-tab-register'), 4.5],
      ['etiqueta de campo', p => p.locator('label[for="email"]'), 4.5],
      ['botón primario', p => p.getByTestId('login-submit'), 4.5],
      ['Continuar con Google', p => p.getByRole('button', { name: 'Continuar con Google' }), 4.5],
      ['¿Olvidaste tu contraseña?', p => p.getByTestId('login-forgot-link'), 4.5],
      ['«¿No tenés cuenta?» (sobre el fondo de página)', p => p.getByText('¿No tenés cuenta?', { exact: true }), 4.5],
      ['«Probalo 14 días gratis» (sobre el fondo de página)', p => p.getByRole('button', { name: /Probalo 14 días gratis/ }), 4.5],
    ]],
    // A 1440 px el pie legal entra en una línea: un enlace partido en dos
    // renglones no tiene una caja que el instrumento pueda capturar.
    ['/login', '[data-testid="login-email"]', 1440, [
      ['pie legal', p => p.getByText('Al continuar, declarás haber leído nuestra'), 4.5, 'computado'],
      ['enlace a la política', p => p.getByTestId('login-link-privacidad'), 4.5],
    ]],
    ['/login?error=access_denied', '[data-testid="login-error"]', 390, [
      ['alerta de error', p => p.getByTestId('login-error'), 4.5],
    ]],
    [AVISO, '[data-testid="login-email"]', 390, [
      ['aviso de invitación · detalle', p => p.getByText(/Creá tu cuenta con el correo/), 4.5],
    ]],
    // El título del aviso es un inline que a 390 px se parte en dos renglones.
    [AVISO, '[data-testid="login-email"]', 1440, [
      ['aviso de invitación · título', p => p.getByText('Te invitaron a un equipo en TechRepair Pro.'), 4.5],
    ]],
    ['/login?modo=registro', '[data-testid="login-confirm-password"]', 390, [
      ['requisito sin cumplir', p => p.getByText('8 caracteres o más'), 4.5, null, async p => { await p.getByTestId('login-password').fill('corta') }],
      ['requisito cumplido', p => p.getByText('8 caracteres o más'), 4.5, null, async p => { await p.getByTestId('login-password').fill('segura-123') }],
      ['error de campo', p => p.getByText('Usá al menos 8 caracteres.'), 4.5, null, async p => {
        await p.getByTestId('login-email').fill('tecnico.qa@example.test')
        await p.getByTestId('login-password').fill('corta12')
        await p.getByTestId('login-confirm-password').fill('corta12')
        await p.getByTestId('login-submit').click()
      }],
    ]],
    ['/login?modo=recuperar', '[data-testid="login-forgot-email"]', 390, [
      ['Volver al inicio de sesión', p => p.getByTestId('login-forgot-back'), 4.5],
    ]],
    ['/reset-password', '[data-testid="reset-password-invalid"]', 390, [
      ['título de estado', p => p.getByTestId('reset-password-invalid').locator('h1'), 4.5],
      ['detalle de estado', p => p.getByText(/Para elegir una nueva contraseña/), 4.5],
    ]],
    ['/auth/callback?error=access_denied', 'text=Cancelaste el inicio de sesión con Google.', 390, [
      ['callback · título', p => p.locator('h1, h2').first(), 4.5],
      ['callback · detalle', p => p.getByText('Cancelaste el inicio de sesión con Google.'), 4.5],
    ]],
    ['/accept-invite', 'text=/invitación/i', 390, [
      ['invitación · título', p => p.locator('h1, h2').first(), 4.5],
      ['invitación · detalle', p => p.locator('h1 + div, h2 + p').first(), 4.5],
      ['invitación · etiqueta del campo', p => p.locator('label').first(), 4.5],
    ]],
  ]
  for (const tema of ['light', 'dark']) {
    decir(`  — ${tema === 'light' ? 'claro' : 'oscuro'} —`)
    for (const [ruta, listo, width, items] of textos) {
      for (const [nombre, loc, minimo, modo, antes] of items) {
        // Una página por medida cuando hay interacción previa: cada una parte limpia.
        const { ctx, page } = await abrir({ tema, width, height: width < 768 ? 844 : 900 })
        await ir(page, ruta, listo)
        if (antes) { await antes(page); await page.waitForTimeout(200) }
        const l = loc(page)
        if (!(await l.count())) { medir(`${nombre}: no existe`); await ctx.close(); continue }
        try {
          if (modo === 'computado') {
            const conGradiente = await l.first().evaluate(el => getComputedStyle(el).webkitTextFillColor === 'rgba(0, 0, 0, 0)')
            if (conGradiente) { medir(`${nombre}: texto con relleno transparente (gradiente) — no medible por color`); await ctx.close(); continue }
            const m = await contrastOf(l.first())
            exigir(m.ratio >= minimo, `${nombre}: ${m.ratio.toFixed(2)}:1 computado (${m.foreground} sobre ${m.background})`)
          } else {
            const m = await paintedContrastOf(l.first())
            exigir(m.ratio >= minimo, `${nombre}: ${m.ratio.toFixed(2)}:1 (${m.foregroundPainted} sobre ${m.backgroundWorst}, ${m.fontSize}/${m.fontWeight})`)
          }
        } catch (e) {
          exigir(false, `${nombre}: no se pudo medir (${String(e.message).split('\n')[0].slice(0, 80)})`)
        }
        await ctx.close()
      }
    }
  }

  // La espera no tiene tarjeta: el texto queda sobre el fondo de la página.
  for (const tema of ['light', 'dark']) {
    const { ctx, page } = await abrir({ tema, conSesion: true, backend: { rpc: { get_my_profile: null } } })
    // La RPC de aceptación nunca responde: la pantalla se queda en la espera.
    await ctx.route(`${SB}/rest/v1/rpc/accept_business_invitation`, () => {})
    await page.goto(base + `/accept-invite?token=${TOKEN}`, { waitUntil: 'domcontentloaded' })
    const texto = page.getByText(/Sumándote al (negocio|equipo)/)
    await texto.waitFor({ timeout: 60_000 }).catch(() => {})
    if (await texto.count()) {
      await page.evaluate(() => document.fonts.ready)
      try {
        const m = await paintedContrastOf(texto.first())
        exigir(m.ratio >= 4.5, `espera (${tema === 'light' ? 'claro' : 'oscuro'}): ${m.ratio.toFixed(2)}:1 (${m.foregroundPainted} sobre ${m.backgroundWorst}, ${m.fontSize}/${m.fontWeight})`)
      } catch (e) {
        exigir(false, `espera (${tema}): no se pudo medir (${String(e.message).split('\n')[0].slice(0, 80)})`)
      }
    } else {
      medir(`espera (${tema}): no apareció`)
    }
    await ctx.close()
  }
}

// ═══ K · teclado ═════════════════════════════════════════════════════════════
if (corre('K')) {
  decir('\nK · teclado en /login (1440×900)')
  const { ctx, page } = await abrir({ width: 1440, height: 900 })
  await ir(page, '/login', '[data-testid="login-email"]')
  const enfocado = () => page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return null
    const cs = getComputedStyle(el)
    const nombre = el.getAttribute('data-testid') || el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 32) || el.tagName
    const anillo = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none')
    return { nombre, anillo: Boolean(anillo), tag: el.tagName }
  })
  // Desde el principio del documento.
  await page.evaluate(() => { document.activeElement?.blur?.(); window.getSelection()?.removeAllRanges() })
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  const orden = []
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press('Tab')
    const f = await enfocado()
    if (!f) break
    if (orden.length && orden[0].nombre === f.nombre) break
    orden.push(f)
  }
  medir(`orden: ${orden.map(o => o.nombre).join(' → ')}`)
  const sinAnillo = orden.filter(o => !o.anillo).map(o => o.nombre)
  exigir(sinAnillo.length === 0, `foco visible en las ${orden.length} paradas${sinAnillo.length ? ` — sin indicador: ${sinAnillo.join(', ')}` : ''}`)
  const nombres = orden.map(o => o.nombre)
  const idx = n => nombres.indexOf(n)
  exigir(idx('login-email') >= 0 && idx('login-email') < idx('login-password') && idx('login-password') < idx('login-submit'),
    'el orden sigue la lectura: email → contraseña → enviar')
  const paradasDeModo = nombres.filter(n => n === 'login-tab-login' || n === 'login-tab-register' || n === 'Iniciar sesión' || n === 'Crear cuenta').length
  exigir(paradasDeModo === 1, `el selector de modo es una sola parada de Tab (${paradasDeModo})`)

  // Flechas en el selector.
  const pestaña = page.getByRole('tab', { name: 'Iniciar sesión' })
  if (await pestaña.count()) {
    await pestaña.focus()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(150)
    const modo = await page.getByTestId('login-confirm-password').count()
    const foco = await enfocado()
    exigir(modo === 1 && foco?.nombre === 'login-tab-register', `flecha derecha cambia a «Crear cuenta» y el foco queda en el selector (${foco?.nombre})`)
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(150)
  } else {
    exigir(false, 'el selector de modo no es un tablist (sin flechas)')
  }

  // Enter en el email envía el formulario (y el foco va al primer campo que falla).
  await page.getByTestId('login-email').focus()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(250)
  const trasEnter = await enfocado()
  const hayError = await page.locator('[aria-invalid="true"]').count()
  exigir(hayError >= 1 && trasEnter?.nombre === 'login-email', `Enter envía; el campo que falla queda con foco y aria-invalid (${trasEnter?.nombre}, ${hayError} inválidos)`)
  await ctx.close()
}

// ═══ A · nombres accesibles y errores asociados ══════════════════════════════
if (corre('A')) {
  decir('\nA · nombres accesibles y errores asociados')
  const { ctx, page } = await abrir({ width: 1440, height: 900 })
  await ir(page, '/login?modo=registro', '[data-testid="login-confirm-password"]')
  for (const [testId, etiqueta] of [['login-email', 'Email'], ['login-password', 'Contraseña'], ['login-confirm-password', 'Confirmar contraseña']]) {
    const nombre = await page.getByTestId(testId).evaluate(el => (el.labels?.[0]?.textContent || '').trim())
    exigir(nombre.startsWith(etiqueta), `${testId} se llama «${nombre}»`)
  }
  const ojo = page.getByRole('button', { name: /Mostrar contraseña|Ocultar contraseña/ }).first()
  exigir((await ojo.getAttribute('aria-pressed')) === 'false', `mostrar contraseña expone su estado (aria-pressed=${await ojo.getAttribute('aria-pressed')})`)

  await page.getByTestId('login-email').fill('tecnico.qa@example.test')
  await page.getByTestId('login-password').fill('corta12')
  await page.getByTestId('login-confirm-password').fill('corta12')
  await page.getByTestId('login-submit').click()
  await page.waitForSelector('text=Usá al menos 8 caracteres.')
  const asociado = await page.getByTestId('login-password').evaluate(el => {
    const id = el.getAttribute('aria-describedby')
    return { invalido: el.getAttribute('aria-invalid'), texto: id ? (document.getElementById(id)?.textContent || '').trim() : null }
  })
  exigir(asociado.invalido === 'true' && asociado.texto === 'Usá al menos 8 caracteres.', `el error de contraseña queda asociado al control (aria-invalid=${asociado.invalido}, descripción=«${asociado.texto}»)`)
  exigir((await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'login-password', 'el foco va al campo que falla')
  await ctx.close()

  const { ctx: c2, page: p2 } = await abrir({ width: 1440, height: 900 })
  await ir(p2, '/login?error=access_denied', '[data-testid="login-error"]')
  const alerta = await p2.getByTestId('login-error').evaluate(el => ({ role: el.getAttribute('role'), emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(el.textContent || ''), icono: Boolean(el.querySelector('svg')) }))
  exigir(alerta.role === 'alert' && !alerta.emoji && alerta.icono, `la alerta es role=alert, con ícono y sin emoji (role=${alerta.role}, emoji=${alerta.emoji}, svg=${alerta.icono})`)
  const h1 = await p2.locator('h1').count()
  exigir(h1 === 1, `la pantalla tiene un h1 (${h1})`)
  await c2.close()

  for (const [ruta, listo] of [['/auth/callback?error=access_denied', 'text=Cancelaste el inicio de sesión con Google.'], ['/accept-invite', 'text=/invitación/i'], ['/reset-password', '[data-testid="reset-password-invalid"]']]) {
    const { ctx: c, page: p } = await abrir({ width: 1440, height: 900 })
    await ir(p, ruta, listo)
    const d = await p.evaluate(() => ({ h1: document.querySelectorAll('h1').length, main: document.querySelectorAll('main').length, sinEtiqueta: [...document.querySelectorAll('input:not([type=hidden])')].filter(i => !i.labels?.length && !i.getAttribute('aria-label')).length }))
    exigir(d.h1 === 1 && d.main === 1 && d.sinEtiqueta === 0, `${ruta.split('?')[0]}: h1=${d.h1}, main=${d.main}, campos sin etiqueta=${d.sinEtiqueta}`)
    await c.close()
  }
}

// ═══ F · flujos ══════════════════════════════════════════════════════════════
if (corre('F')) {
  decir('\nF · flujos (backend simulado)')
  const perfilConNegocio = [{ id: USER_ID, user_id: USER_ID, business_id: BIZ_ID, email: EMAIL, full_name: 'QA', role: 'tech', is_active: true, permissions: null, created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z' }]
  const login = async page => {
    await page.getByTestId('login-email').fill(EMAIL)
    await page.getByTestId('login-password').fill('una-clave-valida')
    await page.getByTestId('login-submit').click()
  }
  const trasUnRato = async (page, ms = 3500) => { await page.waitForTimeout(ms); return new URL(page.url()) }

  // F1 — ingreso con una invitación pendiente guardada (confirmó el correo en otro dispositivo).
  {
    // El perfil no tiene negocio hasta que la invitación se acepta; después, sí.
    let aceptada = false
    const { ctx, page } = await abrir({
      localStore: { trp_pending_invite: JSON.stringify({ token: TOKEN, ts: Date.now() }) },
      backend: { auth: { token: session }, rpc: {
        get_my_profile: () => (aceptada ? perfilConNegocio : null),
        accept_business_invitation: () => { aceptada = true; return { business_id: BIZ_ID, role: 'tech', created: true, status: 'ACCEPTED' } },
      } },
    })
    const visitadas = []
    page.on('framenavigated', f => { if (f === page.mainFrame()) visitadas.push(new URL(f.url()).pathname) })
    await ir(page, '/login', '[data-testid="login-email"]')
    await login(page)
    await page.waitForTimeout(3500)
    const recorrido = [...new Set(visitadas)].join(' → ')
    exigir(visitadas.includes('/accept-invite') && !visitadas.includes('/no-business'), `F1 invitación pendiente + ingreso: ${recorrido}`)
    await ctx.close()
  }

  // F2 — destino guardado por la pestaña (alta desde la landing con plan).
  {
    const { ctx, page } = await abrir({
      sessionStore: { post_login_redirect: '/onboarding?plan=pro' },
      backend: { auth: { token: session }, rpc: { get_my_profile: perfilConNegocio } },
    })
    await ir(page, '/login', '[data-testid="login-email"]')
    await login(page)
    await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 20_000 }).catch(() => {})
    const u = new URL(page.url())
    const guardado = await page.evaluate(() => sessionStorage.getItem('post_login_redirect'))
    exigir(u.pathname === '/onboarding' && guardado === null, `F2 destino guardado + ingreso: ${u.pathname}${u.search} · queda guardado=${JSON.stringify(guardado)}`)
    await ctx.close()
  }

  // F3 — /auth/callback con error: ¿se queda con su salida o salta solo?
  {
    const { ctx, page } = await abrir()
    await ir(page, '/auth/callback?error=access_denied&error_description=The+user+denied', 'text=Cancelaste el inicio de sesión con Google.')
    const u = await trasUnRato(page, 4500)
    const explica = await page.getByText('Cancelaste el inicio de sesión con Google.').count()
    const boton = await page.getByRole('button', { name: 'Volver a iniciar sesión' }).count()
    exigir(u.pathname === '/auth/callback' && explica === 1 && boton === 1, `F3 callback con error, a los 4,5 s: ${u.pathname}${u.search} · explicación visible=${explica === 1} · botón de salida=${boton === 1}`)
    await ctx.close()
  }

  // F4 — /auth/callback sin sesión: ¿el login explica por qué se volvió?
  {
    const { ctx, page } = await abrir()
    await page.goto(base + '/auth/callback', { waitUntil: 'domcontentloaded' })
    await page.waitForURL(u => u.pathname === '/login', { timeout: 30_000 }).catch(() => {})
    await page.waitForSelector('[data-testid="login-email"]', { timeout: 30_000 })
    const u = new URL(page.url())
    const explica = await page.getByTestId('login-error').count()
    exigir(explica === 1, `F4 callback sin sesión: ${u.pathname}${u.search} · el login lo explica=${explica === 1}`)
    await ctx.close()
  }

  // F5 — aceptar una invitación falla por un motivo que no es del enlace.
  {
    const { ctx, page } = await abrir({ conSesion: true, backend: { rpc: { get_my_profile: null, accept_business_invitation: errorJson(503, { code: '08006', message: 'connection failure' }) } } })
    await page.goto(base + `/accept-invite?token=${TOKEN}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/No se pudo aceptar|No pudimos sumarte/', { timeout: 60_000 })
    const reintentar = await page.getByRole('button', { name: 'Reintentar' }).count()
    const pideToken = await page.getByText(/token/i).count()
    exigir(reintentar === 1 && pideToken === 0, `F5 invitación con fallo transitorio: botón «Reintentar»=${reintentar === 1} · pide pegar un «token»=${pideToken > 0}`)
    await ctx.close()
  }

  // F6 — «es para otro correo»: ¿hay una salida que no sea volver al inicio?
  {
    const { ctx, page } = await abrir({ conSesion: true, backend: { rpc: { get_my_profile: null, accept_business_invitation: errorJson(400, { code: 'TRIEM', message: 'INVITATION_EMAIL_MISMATCH' }) } } })
    await page.goto(base + `/accept-invite?token=${TOKEN}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/otra dirección de correo/i', { timeout: 60_000 })
    const cambiar = await page.getByRole('button', { name: 'Usar otra cuenta' }).count()
    const cuenta = await page.getByText(EMAIL).count()
    exigir(cambiar === 1 && cuenta >= 1, `F6 invitación para otro correo: «Usar otra cuenta»=${cambiar === 1} · dice con qué cuenta se entró=${cuenta >= 1}`)
    if (cambiar) {
      await page.getByRole('button', { name: 'Usar otra cuenta' }).click()
      await page.waitForURL(u => u.pathname === '/login', { timeout: 20_000 }).catch(() => {})
      const u = new URL(page.url())
      exigir(u.pathname === '/login' && (u.searchParams.get('redirectTo') || '').startsWith('/accept-invite?token='), `F6 al cambiar de cuenta el enlace viaja al login: ${u.pathname}?redirectTo=${(u.searchParams.get('redirectTo') || '').slice(0, 28)}…`)
    }
    await ctx.close()
  }

  // F7 — el reenvío de confirmación falla desde el login.
  {
    const { ctx, page } = await abrir({ backend: { auth: {
      token: errorJson(400, { code: 'email_not_confirmed', error_code: 'email_not_confirmed', msg: 'Email not confirmed' }),
      resend: errorJson(500, { code: 'unexpected_failure', error_code: 'unexpected_failure', msg: 'Error sending confirmation email' }),
    } } })
    await ir(page, '/login', '[data-testid="login-email"]')
    await login(page)
    await page.getByTestId('login-resend-confirmation').click({ timeout: 20_000 })
    await page.waitForTimeout(2500)
    const dice = await page.getByText(/No pudimos reenviar el correo/).count()
    exigir(dice === 1, `F7 reenvío que falla desde el login: la pantalla lo dice=${dice === 1}`)
    await ctx.close()
  }

  // F8 — Google en «Crear cuenta» y aviso de invitación.
  {
    const { ctx, page } = await abrir()
    await ir(page, '/login?modo=registro', '[data-testid="login-confirm-password"]')
    const google = await page.getByRole('button', { name: 'Continuar con Google' }).count()
    exigir(google === 1, `F8 «Crear cuenta» ofrece Google=${google === 1}`)
    await ctx.close()
    const { ctx: c2, page: p2 } = await abrir()
    await ir(p2, `/login?redirectTo=${encodeURIComponent(`/accept-invite?token=${TOKEN}`)}`, '[data-testid="login-email"]')
    const aviso = await p2.getByText(/Te invitaron a un equipo/).count()
    const alta = await p2.getByTestId('login-confirm-password').count()
    exigir(aviso === 1 && alta === 1, `F8 login desde una invitación: lo dice=${aviso === 1} · arranca en «Crear cuenta»=${alta === 1}`)
    await c2.close()
  }

  // F9 — el email escrito sobrevive a «¿Olvidaste tu contraseña?».
  {
    const { ctx, page } = await abrir()
    await ir(page, '/login', '[data-testid="login-email"]')
    await page.getByTestId('login-email').fill(EMAIL)
    await page.getByTestId('login-forgot-link').click()
    const valor = await page.getByTestId('login-forgot-email').inputValue()
    exigir(valor === EMAIL, `F9 el email escrito sigue en el pedido de recuperación: «${valor}»`)
    await ctx.close()
  }

  // F10 — el aviso de versión nueva no tapa el CTA (320×568; mismo cálculo que m7/mobile-shell.spec.ts).
  {
    const { ctx, page } = await abrir({ width: 320, height: 568, version: true })
    await ir(page, '/login', '[data-testid="login-submit"]')
    const cta = page.getByTestId('login-submit')
    await cta.scrollIntoViewIfNeeded()
    const banner = page.getByTestId('update-banner')
    await banner.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
    if (await banner.count()) {
      const [b, c] = [await banner.boundingBox(), await cta.boundingBox()]
      const pisa = !(b.x + b.width <= c.x || c.x + c.width <= b.x || b.y + b.height <= c.y || c.y + c.height <= b.y)
      exigir(!pisa, `F10 aviso de versión vs. CTA a 320×568: aviso y=${r1(b.y)}–${r1(b.y + b.height)} · CTA y=${r1(c.y)}–${r1(c.y + c.height)} · se pisan=${pisa}`)
    } else {
      medir('F10 el aviso de versión no apareció en 20 s: sin medida')
    }
    await ctx.close()
  }
}

decir(`\n${gate ? (fallas ? `RESULTADO: ${fallas} comprobación(es) en FALLA` : 'RESULTADO: todas las comprobaciones exigibles en OK') : 'RESULTADO: medición sin gate (referencia)'}`)
writeFileSync(salida, lineas.join('\n') + '\n')
await browser.close()
await server.close()
process.exit(gate && fallas ? 1 : 0)
