// BUTTON-SYSTEM-1A — verificación en navegador real con backend SIMULADO.
//
// Mismo arnés que `verify-microfix.mjs`: sesión falsa, `VITE_SUPABASE_URL` a un
// puerto muerto y cada request respondido con route(). No usa Docker.
//
// Mide, en Chromium y con el CSS servido (incluido Bootstrap por CDN):
//   E. los ESTADOS de cada variante (reposo, hover, foco de teclado, presionado):
//      que ninguno caiga en los colores de Bootstrap ni traiga un gradiente;
//   G. la GEOMETRÍA de las acciones de página: alto, padding, radio, tipografía
//      e ícono, iguales entre páginas;
//   C. el CONTRASTE pintado (texto sobre el fondo real) en claro y en oscuro,
//      en reposo y con hover;
//   L. TODAS las variantes, también las que el lote no toca (verde, ámbar,
//      rojo, teal, cyan, ghost, success) y su estado deshabilitado: es el
//      inventario medido para BUTTON-SYSTEM-1B, no un gate.
//
// Uso: node verify-buttons.mjs <worktree> <cacheDir> [E|G|C|L ...]
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const worktree = process.argv[2]
const cacheDir = process.argv[3]
const partes = process.argv.slice(4)
const corre = parte => partes.length === 0 || partes.includes(parte)
const nm = p => pathToFileURL(path.join(worktree, 'node_modules', p)).href

const SB = 'http://127.0.0.1:59999'
process.env.VITE_SUPABASE_URL = SB
process.env.VITE_SUPABASE_ANON_KEY = 'local-dummy-anon-key'

const { createServer } = await import(nm('vite/dist/node/index.js'))
const { chromium } = await import(nm('playwright-core/index.mjs'))
const { paintedContrastOf } = await import(pathToFileURL(path.join(worktree, 'tests/e2e/helpers/contrast.ts')).href)

const PORT = 5199
const server = await createServer({
  root: worktree, configFile: path.join(worktree, 'vite.config.ts'), logLevel: 'error', cacheDir,
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
const day = 86400e3
const SUSCRIPCION = {
  subscription_status: 'active', subscription_plan: 'full', access_source: 'admin_override',
  mp_preapproval_id: null, mp_payer_email: null, current_period_start: new Date(Date.now() - 10 * day).toISOString(),
  current_period_end: new Date(Date.now() + 20 * day).toISOString(), grace_until: null, last_payment_status: null,
  trial_ends_at: new Date(Date.now() - 40 * day).toISOString(), override_expires_at: null,
}
const ORDERS = ['repair', 'ready_delivery', 'waiting_approval', 'diagnosis', 'new', 'completed'].map((status, i) => ({
  id: `a1b2c3${(i + 16).toString(16)}-0000-4000-8000-000000000000`, business_id: BIZ_ID, status,
  created_at: new Date(Date.now() - i * 5 * 3600e3).toISOString(),
  customer: { name: `Cliente ${i + 1}` }, device: { brand: 'Samsung', model: `A${i}` },
}))
const TASKS = [1, 2, 3].map(i => ({
  id: `task-${i}`, title: `Tarea ${i}`, description: null, status: 'pending', priority: 'medium', due_date: null,
  assigned_to: USER_ID, user_id: USER_ID, started_at: null, completed_at: null, created_at: new Date().toISOString(),
}))
const RPC = {
  get_my_profile: [{
    id: USER_ID, user_id: USER_ID, business_id: BIZ_ID, email: user.email, full_name: 'QA owner',
    role: 'owner', is_active: true, permissions: null, created_at: '2026-10-01T12:00:00Z',
  }],
  get_my_first_steps: { has_customer: true, has_order: true, has_inventory: true, has_cobro: true, has_logo: true },
  current_platform_admin_role: null, current_user_has_internal_tool_access: false,
}
const TABLAS = {
  business_settings: { dolar_source: 'nacional', auto_update_rate: true, mayorista_enabled: true },
  exchange_rates: { rate: 1556, source: 'ambito', updated_at: new Date(Date.now() - 6 * 60e3).toISOString() },
  dollar_rate_history: { sell_price: 1556, buy_price: 1530 },
  orders: req => {
    const u = new URL(req.url())
    let filas = ORDERS
    const st = u.searchParams.get('status')
    if (st?.startsWith('eq.')) filas = filas.filter(o => o.status === st.slice(3))
    const lim = Number(u.searchParams.get('limit') || 0)
    return lim ? filas.slice(0, lim) : filas
  },
  tasks: () => TASKS,
  cajas: [{ id: 'caja-1', business_id: BIZ_ID, opened_at: new Date(new Date().setHours(9, 20, 0, 0)).toISOString(), opened_by: USER_ID, status: 'abierta' }],
}

const instalarBackend = ctx => ctx.route(`${SB}/**`, async route => {
  const req = route.request()
  const url = new URL(req.url())
  const p = url.pathname
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const lista = filas => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'content-range': `${filas.length ? `0-${filas.length - 1}` : '*'}/${filas.length}`, 'access-control-expose-headers': 'content-range' },
    body: JSON.stringify(filas),
  })
  if (p.startsWith('/auth/v1/user')) return json(user)
  if (p.startsWith('/auth/v1/token')) return json(session)
  if (p.startsWith('/auth/v1/')) return json({})
  if (p.startsWith('/rest/v1/rpc/')) {
    const nombre = p.replace('/rest/v1/rpc/', '')
    return json(nombre in RPC ? RPC[nombre] : null)
  }
  if (p.startsWith('/rest/v1/')) {
    const tabla = p.replace('/rest/v1/', '')
    if (req.method() !== 'GET' && req.method() !== 'HEAD') return json([])
    const objeto = (req.headers()['accept'] || '').includes('vnd.pgrst.object')
    const sinFila = () => json({ code: 'PGRST116', message: 'mock: 0 rows' }, 406)
    if (tabla === 'businesses' && objeto) return json(SUSCRIPCION)
    if (tabla in TABLAS) {
      const v = TABLAS[tabla]
      const cuerpo = typeof v === 'function' ? v(req) : v
      if (objeto) return Array.isArray(cuerpo) ? (cuerpo.length ? json(cuerpo[0]) : sinFila()) : (cuerpo ? json(cuerpo) : sinFila())
      return lista(Array.isArray(cuerpo) ? cuerpo : [cuerpo])
    }
    return objeto ? sinFila() : lista([])
  }
  if (p.startsWith('/functions/v1/fetch-dollar-rate')) return json({ sell: 1556, buy: 1530, source: 'AMBITO_NACIONAL' })
  if (p.startsWith('/functions/v1/')) return json({ error: 'mock' }, 404)
  return route.abort()
})

// ── Utilidades ───────────────────────────────────────────────────────────────
const lineas = []
let fallas = 0
const decir = texto => { console.log(texto); lineas.push(texto) }
const exigir = (condicion, texto) => {
  if (!condicion) fallas += 1
  decir(`  ${condicion ? 'OK   ' : 'FALLA'} ${texto}`)
}

const browser = await chromium.launch()
async function abrirSesion({ tema = 'light', width = 1440, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 })
  await ctx.addInitScript(([s, t]) => {
    try { localStorage.setItem('sb-127-auth-token', s); localStorage.setItem('techrepair_theme', t); localStorage.setItem('theme', t) } catch { /* sin storage */ }
  }, [JSON.stringify(session), tema])
  await ctx.route('**/*', r => {
    const u = r.request().url()
    if (u.startsWith(base) || u.startsWith(SB) || u.startsWith('data:') || u.startsWith('blob:')) return r.fallback()
    if (/cdn\.jsdelivr\.net\/npm\/bootstrap|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(u)) return r.fallback()
    return r.abort()
  })
  await instalarBackend(ctx)
  const page = await ctx.newPage()
  const errores = []
  page.on('pageerror', e => errores.push(String(e.message).slice(0, 160)))
  return { ctx, page, errores }
}
const asentar = page => page.evaluate(() => Promise.all(document.getAnimations()
  .filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))))
async function ir(page, ruta, listo) {
  await page.goto(base + ruta, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(listo, { timeout: 120_000 })
  await page.waitForTimeout(1200)
  await asentar(page)
}

/** Las acciones de página que el lote lleva al contrato, por pantalla. */
const ACCIONES = [
  ['/dashboard', '[data-testid="dashboard-today"]', [
    ['Inicio · Nueva Orden', '[data-testid="dashboard-actions"] button:has-text("Nueva Orden")', 'primary'],
    ['Inicio · Nuevo Comprobante', '[data-testid="dashboard-actions"] button:has-text("Nuevo Comprobante")', 'secondary'],
    ['Inicio · Gestionar Caja', '[data-testid="dashboard-actions"] button:has-text("Gestionar Caja")', 'secondary'],
    ['Inicio · Registrar gasto', '[data-testid="dashboard-actions"] button:has-text("Registrar gasto")', 'danger'],
    ['Inicio · Nueva tarea', '[data-testid="dashboard-tasks"] button:has-text("Nueva tarea")', 'primary'],
    ['Inicio · Ver todas (tareas)', '[data-testid="dashboard-tasks"] a[aria-label="Ver todas las tareas"]', 'secondary'],
    ['Inicio · Ver todas (órdenes)', '[data-testid="dashboard-recent-orders"] a[aria-label="Ver todas las órdenes"]', 'secondary'],
  ]],
  ['/orders', '[data-testid="orders-new-button"]', [['Órdenes · Nueva Orden', '[data-testid="orders-new-button"]', 'primary']]],
  ['/customers', '[data-testid="customers-new-button"]', [['Clientes · Nuevo Cliente', '[data-testid="customers-new-button"]', 'primary']]],
  ['/tasks', '.page-shell button:has-text("Nueva tarea")', [['Tareas · Nueva tarea', '.page-shell button:has-text("Nueva tarea")', 'primary']]],
  ['/comprobantes', '[data-testid="comprobantes-new-button"]', [['Comprobantes · Nuevo Comprobante', '[data-testid="comprobantes-new-button"]', 'primary']]],
  ['/warranties', '.page-hdr-right button:has-text("Nueva garantía")', [['Garantías · Nueva garantía', '.page-hdr-right button:has-text("Nueva garantía")', 'primary']]],
  ['/offers', '.page-hdr-right button:has-text("Nueva oferta")', [['Ofertas · Nueva oferta', '.page-hdr-right button:has-text("Nueva oferta")', 'primary']]],
]

const estilo = l => l.evaluate(el => {
  const s = getComputedStyle(el)
  const icono = el.querySelector('svg')
  const r = el.getBoundingClientRect()
  const ri = icono?.getBoundingClientRect()
  return {
    alto: Math.round(r.height * 10) / 10,
    fondo: s.backgroundColor, imagen: s.backgroundImage, color: s.color, borde: s.borderTopColor,
    sombra: s.boxShadow, contorno: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`, transform: s.transform,
    padding: `${s.paddingLeft}/${s.paddingRight}`, gap: s.columnGap, radio: s.borderTopLeftRadius,
    fuente: `${s.fontSize}/${s.fontWeight}`, icono: ri ? `${Math.round(ri.width)}x${Math.round(ri.height)}` : '—',
  }
})

/** Colores que delatan una regla de Bootstrap ganando (azules y grises de su paleta). */
const DE_BOOTSTRAP = /rgb\((13, 110, 253|11, 94, 215|10, 88, 202|10, 83, 190|108, 117, 125|92, 99, 106|86, 94, 100|220, 53, 69|187, 45, 59|176, 42, 55)\)/

try {
  // ═══ E · estados de cada variante ════════════════════════════════════════
  if (corre('E')) {
    for (const tema of ['light', 'dark']) {
      decir(`\n[E] Estados · tema ${tema}`)
      const { ctx, page, errores } = await abrirSesion({ tema })
      await ir(page, '/dashboard', '[data-testid="dashboard-today"]')
      for (const [nombre, selector, variante] of ACCIONES[0][2].slice(0, 5)) {
        const l = page.locator(selector).first()
        await page.mouse.move(0, 0)
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
        const reposo = await estilo(l)
        await l.hover(); await asentar(page)
        const hover = await estilo(l)
        await page.mouse.down(); await asentar(page)
        const presionado = await estilo(l)
        // Se suelta fuera: el estado presionado se midió sin disparar la navegación.
        await page.mouse.move(0, 0); await page.mouse.up()
        await l.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await asentar(page)
        const foco = await estilo(l)
        const enFoco = await l.evaluate(el => el.matches(':focus-visible'))
        decir(`  ── ${nombre} (${variante})`)
        for (const [estado, e] of [['reposo', reposo], ['hover', hover], ['presionado', presionado], ['foco', foco]]) {
          decir(`     ${estado.padEnd(10)} fondo ${e.fondo} · texto ${e.color} · borde ${e.borde} · sombra ${e.sombra === 'none' ? 'ninguna' : e.sombra} · ${e.transform === 'none' ? 'sin elevar' : e.transform}${estado === 'foco' ? ` · contorno ${e.contorno}` : ''}`)
          exigir(e.imagen === 'none', `${estado}: sin gradiente${e.imagen === 'none' ? '' : ` (${e.imagen.slice(0, 60)})`}`)
          exigir(!DE_BOOTSTRAP.test(`${e.fondo} ${e.borde}`), `${estado}: ni el fondo ni el borde son de la paleta de Bootstrap`)
        }
        exigir(enFoco, 'el foco de teclado se midió con :focus-visible')
        exigir(/solid/.test(foco.contorno) || foco.sombra !== 'none', 'el foco de teclado tiene un indicador visible')
        if (variante === 'primary') {
          exigir(reposo.sombra === 'none' && hover.sombra === 'none', 'primary: sin resplandor en reposo ni en hover')
          exigir(hover.fondo !== reposo.fondo, 'primary: el hover cambia a otro sólido')
        }
      }
      exigir(errores.length === 0, `sin errores de página${errores.length ? ': ' + errores.slice(0, 2).join(' | ') : ''}`)
      await ctx.close()
    }
  }

  // ═══ G · geometría de las acciones de página ═════════════════════════════
  if (corre('G')) {
    decir('\n[G] Geometría · una acción de página mide lo mismo en todas las pantallas')
    const { ctx, page, errores } = await abrirSesion({ tema: 'light' })
    const medidas = []
    for (const [ruta, listo, acciones] of ACCIONES) {
      await ir(page, ruta, listo)
      for (const [nombre, selector, variante] of acciones) {
        const l = page.locator(selector).first()
        await page.mouse.move(0, 0)
        const e = await estilo(l)
        medidas.push({ nombre, variante, ...e })
        decir(`  · ${nombre.padEnd(34)} ${String(e.alto).padStart(4)}px · padding ${e.padding} · gap ${e.gap} · radio ${e.radio} · ${e.fuente} · ícono ${e.icono} · fondo ${e.fondo}`)
      }
    }
    const unico = campo => [...new Set(medidas.map(m => m[campo]))]
    exigir(unico('alto').length === 1 && unico('alto')[0] === 44, `todas miden 44px de alto: ${unico('alto').join(', ')}`)
    exigir(unico('padding').length === 1 && unico('padding')[0] === '16px/16px', `mismo padding horizontal (16px): ${unico('padding').join(', ')}`)
    exigir(unico('gap').length === 1 && unico('gap')[0] === '8px', `mismo espacio ícono–texto (8px): ${unico('gap').join(', ')}`)
    exigir(unico('radio').length === 1, `mismo radio: ${unico('radio').join(', ')}`)
    exigir(unico('fuente').length === 1 && unico('fuente')[0] === '14px/600', `misma tipografía (14px / 600): ${unico('fuente').join(', ')}`)
    exigir(medidas.filter(m => m.icono !== '—').every(m => m.icono === '16x16'), `todos los íconos miden 16px: ${unico('icono').join(', ')}`)
    const primarias = medidas.filter(m => m.variante === 'primary')
    exigir(new Set(primarias.map(m => `${m.fondo}|${m.color}|${m.sombra}`)).size === 1,
      `las ${primarias.length} primarias pintan igual (fondo ${primarias[0].fondo}, texto ${primarias[0].color}, sombra ${primarias[0].sombra})`)
    exigir(medidas.every(m => m.imagen === 'none'), 'ninguna lleva gradiente')
    exigir(errores.length === 0, `sin errores de página${errores.length ? ': ' + errores.slice(0, 2).join(' | ') : ''}`)
    await ctx.close()

    // Mobile: la fila de Inicio y el alto táctil.
    decir('\n[G] Mobile · Inicio a 375 / 390 / 430 y Órdenes a 375')
    const m = await abrirSesion({ tema: 'light', width: 375, height: 812 })
    await ir(m.page, '/dashboard', '[data-testid="dashboard-today"]')
    for (const ancho of [320, 375, 390, 430]) {
      await m.page.setViewportSize({ width: ancho, height: 812 })
      await m.page.waitForTimeout(250)
      const fila = await m.page.evaluate(() => {
        const caja = sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { y: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width), corta: el.scrollWidth - el.clientWidth } }
        const botones = [...document.querySelectorAll('[data-testid="dashboard-actions"] .dash-action--secondary')].map(b => { const r = b.getBoundingClientRect(); return { y: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width), corta: b.scrollWidth - b.clientWidth } })
        return { principal: caja('[data-testid="dashboard-actions"] .dash-action--primary'), botones, desborde: document.documentElement.scrollWidth - document.documentElement.clientWidth }
      })
      exigir(fila.principal.h >= 44 && fila.botones.length === 3 && new Set(fila.botones.map(b => b.y)).size === 1
        && Math.max(...fila.botones.map(b => b.h)) - Math.min(...fila.botones.map(b => b.h)) <= 1
        && fila.botones.every(b => b.h >= 44 && b.corta <= 1) && fila.principal.corta <= 1 && fila.desborde <= 1,
        `${ancho}px · principal ${fila.principal.w}x${fila.principal.h} · secundarias ${fila.botones.map(b => `${b.w}x${b.h}`).join(' ')} · sin recorte ni desborde`)
    }
    await m.page.setViewportSize({ width: 375, height: 812 })
    // Los contratos de BETA-UX-1D sobre el encabezado mobile de las listas.
    await ir(m.page, '/orders', '[data-testid="orders-new-button"]')
    const enOrdenes = await m.page.evaluate(() => {
      const r = document.querySelector('[data-testid="orders-new-button"]').getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), desborde: document.documentElement.scrollWidth - document.documentElement.clientWidth }
    })
    exigir(enOrdenes.h >= 44 && enOrdenes.w > 375 * 0.8 && enOrdenes.desborde <= 1,
      `Órdenes a 375 · «Nueva Orden» mide ${enOrdenes.w}x${enOrdenes.h} (≥ 44 de alto, > 80 % del ancho) y no desborda`)
    await ir(m.page, '/customers', '[data-testid="customers-new-button"]')
    const enClientes = await m.page.evaluate(() => {
      const caja = sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { y: r.top + r.height / 2, h: Math.round(r.height) } }
      const visibles = [...document.querySelectorAll('.page-hdr-right button, .page-hdr-right a')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      return { nuevo: caja('[data-testid="customers-new-button"]'), menu: caja('[data-testid="customers-mobile-header-menu"]'), visibles: visibles.length, desborde: document.documentElement.scrollWidth - document.documentElement.clientWidth }
    })
    exigir(enClientes.nuevo.h >= 44 && Math.abs(enClientes.nuevo.y - enClientes.menu.y) <= 4 && enClientes.visibles === 2 && enClientes.desborde <= 1,
      `Clientes a 375 · «Nuevo Cliente» (${enClientes.nuevo.h}px) y el menú (${enClientes.menu.h}px) comparten fila; ${enClientes.visibles} controles en el encabezado; sin desborde`)
    await m.ctx.close()
  }

  // ═══ C · contraste pintado ═══════════════════════════════════════════════
  if (corre('C')) {
    for (const tema of ['light', 'dark']) {
      decir(`\n[C] Contraste pintado · tema ${tema} (mínimo 4,5:1)`)
      const { ctx, page } = await abrirSesion({ tema })
      for (const [ruta, listo, acciones] of ACCIONES.slice(0, 2)) {
        await ir(page, ruta, listo)
        for (const [nombre, selector, variante] of acciones) {
          const l = page.locator(selector).first()
          await l.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
          await page.mouse.move(0, 0); await asentar(page)
          const reposo = await paintedContrastOf(l)
          await l.hover(); await asentar(page)
          const hover = await paintedContrastOf(l)
          exigir(reposo.ratio >= 4.5 && hover.ratio >= 4.5,
            `${nombre.padEnd(32)} (${variante.padEnd(9)}) reposo ${reposo.ratio.toFixed(2)}:1 · hover ${hover.ratio.toFixed(2)}:1`)
        }
      }
      await ctx.close()
    }
  }

  // ═══ L · lo que 1A NO toca: se mide para el inventario de BUTTON-SYSTEM-1B ═
  if (corre('L')) {
    const VARIANTES = ['primary', 'secondary', 'danger', 'success', 'ghost', 'green', 'amber', 'red', 'teal', 'cyan']
    for (const tema of ['light', 'dark']) {
      decir(`\n[L] Todas las variantes · tema ${tema} — se MIDEN; sólo se exige lo que 1A cambió`)
      const { ctx, page } = await abrirSesion({ tema })
      await ir(page, '/dashboard', '[data-testid="dashboard-today"]')
      // Botones de sonda con las clases reales, sobre el fondo de la página.
      await page.evaluate(variantes => {
        const caja = document.createElement('div')
        caja.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;padding:16px 0'
        for (const v of variantes) for (const deshabilitado of [false, true]) {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = `btn btn-${v}`
          b.disabled = deshabilitado
          b.dataset.sonda = `${v}${deshabilitado ? '-off' : ''}`
          b.textContent = `Botón ${v}`
          caja.appendChild(b)
        }
        document.querySelector('[data-testid="dashboard-page"]').prepend(caja)
      }, VARIANTES)
      await page.mouse.move(0, 0); await asentar(page)
      for (const v of VARIANTES) {
        const l = page.locator(`[data-sonda="${v}"]`)
        const c = await paintedContrastOf(l)
        const e = await estilo(l)
        const off = await estilo(page.locator(`[data-sonda="${v}-off"]`))
        const deBootstrap = DE_BOOTSTRAP.test(`${off.fondo} ${off.borde}`)
        decir(`  · ${v.padEnd(9)} texto ${c.ratio.toFixed(2)}:1${c.ratio < 4.5 ? ' (BAJO)' : ''} · ${e.imagen === 'none' ? 'sólido' : 'GRADIENTE'} · sombra ${e.sombra === 'none' ? 'ninguna' : 'sí'} · deshabilitado: fondo ${off.fondo}${deBootstrap ? ' ← de Bootstrap' : ''}`)
        if (v === 'primary') {
          exigir(c.ratio >= 4.5 && e.imagen === 'none' && e.sombra === 'none', 'primary: AA, sólido y sin sombra')
          exigir(off.fondo === e.fondo && !deBootstrap, 'primary deshabilitado: el mismo índigo, no el azul de Bootstrap')
        }
        if (v === 'secondary' || v === 'danger') exigir(c.ratio >= 4.5 && e.imagen === 'none', `${v}: AA y sin gradiente`)
      }
      await ctx.close()
    }
  }
} finally {
  await browser.close()
  await server.close()
}

decir(fallas === 0 ? '\nVERIFICACIÓN DE BOTONES: todo en verde' : `\nVERIFICACIÓN DE BOTONES: ${fallas} comprobación(es) en rojo`)
process.exit(fallas === 0 ? 0 : 1)
