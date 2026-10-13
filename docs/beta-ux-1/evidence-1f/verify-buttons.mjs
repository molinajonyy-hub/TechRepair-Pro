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
//      inventario medido para BUTTON-SYSTEM-1B, no un gate;
//   F. los FILTROS DE STOCK de Inventario: inactivo, activo, hover y foco de
//      teclado, en claro y en oscuro, a 375 y a 1440;
//   R. el INSTRUMENTO de contraste con la página moviéndose bajo la medida (la
//      carrera que dio un rojo falso en CI);
//   K. el encabezado de CLIENTES: cuatro acciones de página en escritorio,
//      «Nuevo Cliente» + menú en mobile.
//
// Uso: node verify-buttons.mjs <worktree> <cacheDir> [E|G|C|L|F|R|K ...]
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
  // Inventario: una lista larga (la tabla queda lejos de los filtros, como en el
  // negocio E2E), con productos en stock bajo y agotados.
  inventory: Array.from({ length: 40 }, (_, i) => ({
    id: `00000000-0000-4000-8000-0000000a${String(i).padStart(4, '0')}`, business_id: BIZ_ID,
    name: `Producto ${i + 1}`, code: `SKU-${String(i + 1).padStart(4, '0')}`, category: 'Repuestos',
    stock_quantity: i < 7 ? 1 : i < 9 ? 0 : 12, stock: i < 7 ? 1 : i < 9 ? 0 : 12, min_stock: 1,
    sale_price: 1000 + i * 10, price_usd: null, linked_to_dolar: false, base_currency: 'ARS',
    parent_id: null, has_variants: false, is_active: true, product_type: 'product',
    created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z',
  })),
  customers: Array.from({ length: 6 }, (_, i) => ({
    id: `00000000-0000-4000-8000-0000000c${String(i).padStart(4, '0')}`, business_id: BIZ_ID,
    name: `Cliente ${i + 1}`, phone: '3510000000', email: null, customer_type: 'retail', is_active: true,
    created_at: '2026-10-01T12:00:00Z',
  })),
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

  // ═══ F · filtros de stock de Inventario ══════════════════════════════════
  // La misma secuencia que el E2E de BETA-UX-1E (`cta-contrast.spec.ts`): se
  // toca el filtro y se lo mide enseguida. Al tocarlo, Inventario hace un
  // `scrollIntoView({ behavior: 'smooth' })` hacia la tabla.
  if (corre('F')) {
    const FILTROS = [['Ver stock bajo', 'rgb(245, 158, 11)', 'low'], ['Ver agotados', 'rgb(239, 68, 68)', 'out']]
    for (const [tema, ancho, alto] of [['light', 375, 812], ['dark', 375, 812], ['light', 1440, 900], ['dark', 1440, 900]]) {
      decir(`\n[F] Inventario · filtros de stock · ${tema} · ${ancho}px`)
      const { ctx, page, errores } = await abrirSesion({ tema, width: ancho, height: alto })
      await ir(page, '/inventory', 'button:has-text("Ver stock bajo")')
      const boton = nombre => page.getByRole('button', { name: nombre, exact: true })
      const enReposo = async () => { await page.mouse.move(0, 0); await asentar(page) }
      const fondoDe = l => l.evaluate(el => getComputedStyle(el).backgroundColor)
      const conPuntero = async l => {
        await l.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
        await l.hover(); await asentar(page)
        return l.evaluate(el => el.matches(':hover'))
      }
      const conFoco = async l => {
        await page.mouse.move(0, 0)
        await l.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await asentar(page)
        return l.evaluate(el => el.matches(':focus-visible'))
      }

      for (const [nombre, , clave] of FILTROS) {
        const l = boton(nombre)
        await enReposo()
        const m = await paintedContrastOf(l)
        const clases = await l.evaluate(el => [...el.classList].join(' '))
        exigir(clases === `inventory-stock-filter inventory-stock-filter--${clave}` && (await l.getAttribute('aria-pressed')) === 'false',
          `«${nombre}» inactivo: clases «${clases}», sin estilo en línea (${(await l.getAttribute('style')) ?? 'ninguno'})`)
        exigir(m.ratio >= 4.5, `«${nombre}» inactivo: ${m.foreground} sobre ${m.backgroundWorst} = ${m.ratio.toFixed(2)}:1`)
        const sobre = await conPuntero(l)
        const h = await paintedContrastOf(l)
        exigir(sobre && h.ratio >= 4.5, `«${nombre}» inactivo + hover: ${h.foreground} sobre ${h.backgroundWorst} = ${h.ratio.toFixed(2)}:1`)
      }

      for (const [nombre, fondo] of FILTROS) {
        const l = boton(nombre)
        // La secuencia del E2E, varias veces: se toca el filtro y se lo mide
        // enseguida, con el scroll suave hacia la tabla todavía en curso.
        const medidas = []
        for (let vuelta = 0; vuelta < 5; vuelta += 1) {
          if (vuelta > 0) { await boton('Ver todos').click(); await page.evaluate(() => window.scrollTo(0, 0)) }
          await l.click()
          await enReposo()
          medidas.push(await paintedContrastOf(l))
        }
        exigir(medidas.every(m => m.ratio >= 4.5 && m.backgroundWorst === fondo),
          `«${nombre}» activo, medido enseguida del clic ×5: ${[...new Set(medidas.map(m => `${m.ratio.toFixed(2)}:1 sobre ${m.backgroundWorst}`))].join(' · ')} (intentos del instrumento: ${medidas.map(m => m.attempts).join(', ')})`)
        const activo = await paintedContrastOf(l)
        exigir((await l.evaluate(el => el.classList.contains('is-active'))) && (await l.getAttribute('aria-pressed')) === 'true',
          `«${nombre}» activo: lleva \`.is-active\` y \`aria-pressed="true"\``)
        exigir((await fondoDe(l)) === fondo && activo.ratio >= 4.5, `«${nombre}» activo: fondo ${await fondoDe(l)} · ${activo.foreground} = ${activo.ratio.toFixed(2)}:1`)

        const sobre = await conPuntero(l)
        const hover = await paintedContrastOf(l)
        exigir(sobre && (await fondoDe(l)) === fondo && hover.backgroundWorst === fondo && hover.ratio >= 4.5,
          `«${nombre}» activo + hover: conserva el fondo (${await fondoDe(l)}) · ${hover.ratio.toFixed(2)}:1`)
        const enFoco = await conFoco(l)
        const foco = await paintedContrastOf(l)
        const contorno = await l.evaluate(el => getComputedStyle(el).outlineStyle)
        exigir(enFoco && (await fondoDe(l)) === fondo && foco.backgroundWorst === fondo && foco.ratio >= 4.5 && contorno === 'solid',
          `«${nombre}» activo + foco de teclado: conserva el fondo (${await fondoDe(l)}) · ${foco.ratio.toFixed(2)}:1 · contorno ${contorno}`)
        await l.evaluate(el => el.blur())
      }
      // El que dejó de estar activo vuelve a leerse, y «Ver todos» también.
      const bajo = boton('Ver stock bajo')
      await enReposo()
      const vuelta = await paintedContrastOf(bajo)
      exigir(vuelta.ratio >= 4.5 && !(await bajo.evaluate(el => el.classList.contains('is-active'))), `«Ver stock bajo» inactivo tras cambiar: ${vuelta.ratio.toFixed(2)}:1`)
      const todos = await paintedContrastOf(boton('Ver todos'))
      exigir(todos.ratio >= 4.5, `«Ver todos»: ${todos.foreground} sobre ${todos.backgroundWorst} = ${todos.ratio.toFixed(2)}:1`)
      if (ancho < 1024) {
        // Dato para BUTTON-SYSTEM-1B: el alto NO se toca en este lote.
        const altos = await page.evaluate(() => [...document.querySelectorAll('.inventory-stock-filter')].map(b => Math.round(b.getBoundingClientRect().height)))
        decir(`  dato  alto de los filtros en mobile: ${altos.join(' / ')} px (objetivo táctil 44 → BUTTON-SYSTEM-1B; no se exige acá)`)
      }
      exigir(errores.length === 0, `sin errores de página${errores.length ? ': ' + errores.slice(0, 2).join(' | ') : ''}`)
      await ctx.close()
    }
  }

  // ═══ R · la medida contra el scroll suave de Inventario ══════════════════
  // CI midió «Ver stock bajo» activo como tinta sobre rgb(31, 27, 27) (1,05:1).
  // La traza de esa corrida muestra el botón ÁMBAR en ese momento: el clic hace
  // `scrollIntoView({ behavior: 'smooth' })` hacia la tabla y la página se
  // seguía moviendo mientras se capturaba un recorte fijo.
  //
  // Con el instrumento ANTERIOR, el caso 2 de abajo devolvía exactamente lo de
  // CI: «1.05:1 sobre rgb(31, 27, 27)» (queda en `verify-buttons-race-before.txt`).
  // El contrato nuevo: una medida en la que el elemento se movió se descarta y
  // se repite; si nunca queda quieto, se falla. Nunca un número de otro lugar.
  if (corre('R')) {
    const AMBAR = 'rgb(245, 158, 11)'
    decir('\n[R] Inventario · 375px oscuro · «Ver stock bajo» activo, con la página moviéndose bajo la medida')
    const { ctx, page } = await abrirSesion({ tema: 'dark', width: 375, height: 812 })
    await ir(page, '/inventory', 'button:has-text("Ver stock bajo")')
    const bajo = page.getByRole('button', { name: 'Ver stock bajo', exact: true })
    await bajo.click()
    await page.waitForTimeout(1500)
    await asentar(page)
    const quieto = await paintedContrastOf(bajo)
    exigir(quieto.ratio >= 4.5 && quieto.backgroundWorst === AMBAR && quieto.attempts === 1,
      `1 · página quieta: ${quieto.foreground} sobre ${quieto.backgroundWorst} = ${quieto.ratio.toFixed(2)}:1 en ${quieto.attempts} intento`)

    // La página se corre ENTRE capturas del instrumento. Con un recorte de ~17 px
    // de alto, 18 px alcanzan para que entre el fondo de la caja de alerta.
    const capturar = page.screenshot.bind(page)
    /** `mueve(n)`: si antes de la captura número `n` hay que correr la página. */
    const medirMoviendo = async mueve => {
      let capturas = 0
      page.screenshot = async opciones => {
        capturas += 1
        if (mueve(capturas)) await page.evaluate(() => window.scrollBy({ top: 18, behavior: 'instant' }))
        return capturar(opciones)
      }
      try {
        return { m: await paintedContrastOf(bajo), capturas }
      } catch (e) {
        return { error: String(e.message), capturas }
      } finally {
        page.screenshot = capturar
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      }
    }

    const unaVez = await medirMoviendo(n => n === 2)
    exigir(!!unaVez.m && unaVez.m.ratio >= 4.5 && unaVez.m.backgroundWorst === AMBAR && unaVez.m.attempts === 2,
      `2 · la página se corre 18 px entre las dos capturas, UNA vez → ${unaVez.m ? `descarta y repite: ${unaVez.m.ratio.toFixed(2)}:1 sobre ${unaVez.m.backgroundWorst} en ${unaVez.m.attempts} intentos (${unaVez.capturas} capturas)` : `falló: ${unaVez.error.slice(0, 120)}`}`)

    const antes = await medirMoviendo(n => n === 1)
    exigir(!!antes.m && antes.m.ratio >= 4.5 && antes.m.backgroundWorst === AMBAR && antes.m.attempts === 2,
      `3 · la página se corre antes de la PRIMERA captura → ${antes.m ? `descarta y repite: ${antes.m.ratio.toFixed(2)}:1 sobre ${antes.m.backgroundWorst} en ${antes.m.attempts} intentos` : `falló: ${antes.error.slice(0, 120)}`}`)

    const siempre = await medirMoviendo(n => n % 2 === 0)
    exigir(!siempre.m && /element moved during contrast measurement/.test(siempre.error ?? '') && siempre.capturas === 8,
      `4 · la página se corre en CADA medida → ${siempre.m ? `DEVOLVIÓ ${siempre.m.ratio.toFixed(2)}:1 sobre ${siempre.m.backgroundWorst}` : `falla sin devolver un número, tras ${siempre.capturas / 2} intentos`}`)
    if (siempre.error) decir(`       ${siempre.error.slice(0, 300)}`)

    // Un scroll ya en curso cuando se llama al instrumento, como el que dispara
    // el clic del filtro: el suave del navegador y uno cuadro a cuadro (éste se
    // mueve seguro, con o sin scroll suave en el navegador).
    for (const retardo of [0, 40, 120, 250]) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      await page.waitForTimeout(120)
      await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'smooth' }))
      await page.waitForTimeout(retardo)
      const m = await paintedContrastOf(bajo).catch(e => ({ error: String(e.message) }))
      exigir(!m.error && m.ratio >= 4.5 && m.backgroundWorst === AMBAR,
        `5 · scroll suave en curso, medida a ${retardo} ms → ${m.error ? `falló: ${m.error.slice(0, 120)}` : `${m.ratio.toFixed(2)}:1 sobre ${m.backgroundWorst} (${m.attempts} intento/s)`}`)
    }
    await page.evaluate(() => {
      window.scrollTo({ top: 0, behavior: 'instant' })
      let cuadros = 0
      const paso = () => { window.scrollBy({ top: 9, behavior: 'instant' }); cuadros += 1; if (cuadros < 45) requestAnimationFrame(paso) }
      requestAnimationFrame(paso)
    })
    const enMarcha = await paintedContrastOf(bajo).catch(e => ({ error: String(e.message) }))
    exigir(!enMarcha.error && enMarcha.ratio >= 4.5 && enMarcha.backgroundWorst === AMBAR,
      `6 · scroll cuadro a cuadro en curso (45 cuadros de 9 px) → ${enMarcha.error ? `falló: ${enMarcha.error.slice(0, 120)}` : `espera a que termine: ${enMarcha.ratio.toFixed(2)}:1 sobre ${enMarcha.backgroundWorst} (${enMarcha.attempts} intento/s)`}`)

    // Un elemento que no se queda quieto nunca: tampoco hay número.
    await page.evaluate(() => {
      const paso = () => { window.scrollBy({ top: (performance.now() % 400) < 200 ? 6 : -6, behavior: 'instant' }); window.__sinFin = requestAnimationFrame(paso) }
      window.__sinFin = requestAnimationFrame(paso)
    })
    const nunca = await paintedContrastOf(bajo).then(m => ({ m }), e => ({ error: String(e.message) }))
    await page.evaluate(() => cancelAnimationFrame(window.__sinFin))
    exigir(!nunca.m && /element moved during contrast measurement/.test(nunca.error ?? ''),
      `7 · la página no se queda quieta NUNCA → ${nunca.m ? `DEVOLVIÓ ${nunca.m.ratio.toFixed(2)}:1` : 'falla con «element moved during contrast measurement»'}`)
    await ctx.close()

    // El mismo corrimiento en tema CLARO: el fondo ajeno es claro y la tinta
    // oscura sobre él da un contraste alto. El instrumento anterior lo devolvía
    // como una medida válida del botón.
    decir('\n[R] Inventario · 375px claro · el mismo corrimiento')
    const claro = await abrirSesion({ tema: 'light', width: 375, height: 812 })
    await ir(claro.page, '/inventory', 'button:has-text("Ver stock bajo")')
    const bajoClaro = claro.page.getByRole('button', { name: 'Ver stock bajo', exact: true })
    await bajoClaro.click()
    await claro.page.waitForTimeout(1500)
    const capturarClaro = claro.page.screenshot.bind(claro.page)
    let capturasClaro = 0
    claro.page.screenshot = async opciones => {
      capturasClaro += 1
      if (capturasClaro === 2) await claro.page.evaluate(() => window.scrollBy({ top: 18, behavior: 'instant' }))
      return capturarClaro(opciones)
    }
    const enClaro = await paintedContrastOf(bajoClaro).catch(e => ({ error: String(e.message) }))
    claro.page.screenshot = capturarClaro
    exigir(!enClaro.error && enClaro.backgroundWorst === AMBAR && enClaro.attempts === 2,
      `8 · claro, corrimiento de 18 px entre capturas → ${enClaro.error ? `falló: ${enClaro.error.slice(0, 120)}` : `descarta y repite: ${enClaro.ratio.toFixed(2)}:1 sobre ${enClaro.backgroundWorst} (no sobre el fondo de la caja de alerta)`}`)
    await claro.ctx.close()
  }

  // ═══ K · Clientes: las acciones del encabezado son una sola categoría ════
  if (corre('K')) {
    const leerEncabezado = page => page.evaluate(() => {
      const derecha = document.querySelector('.page-hdr-right')
      const visibles = [...derecha.querySelectorAll('button, a')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      return {
        botones: visibles.map(el => {
          const r = el.getBoundingClientRect(); const s = getComputedStyle(el); const i = el.querySelector('svg')?.getBoundingClientRect()
          return {
            texto: (el.textContent || '').trim() || el.getAttribute('aria-label'), top: Math.round(r.top * 10) / 10, alto: Math.round(r.height * 10) / 10, ancho: Math.round(r.width),
            radio: s.borderTopLeftRadius, padding: `${s.paddingLeft}/${s.paddingRight}`, fuente: `${s.fontSize}/${s.fontWeight}`, icono: i ? `${Math.round(i.width)}x${Math.round(i.height)}` : '—',
            fondo: s.backgroundColor, imagen: s.backgroundImage, clases: [...el.classList].filter(c => c.startsWith('btn')).join(' '),
          }
        }),
        desborde: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        menuVisible: (() => { const m = document.querySelector('[data-testid="customers-mobile-header-menu"]'); const r = m?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0 })(),
      }
    })
    const unico = (lista, campo) => [...new Set(lista.map(b => b[campo]))]

    decir('\n[K] Clientes · escritorio (≥ 768): cuatro acciones de página, una fila')
    const d = await abrirSesion({ tema: 'light', width: 1440, height: 900 })
    await ir(d.page, '/customers', '[data-testid="customers-new-button"]')
    for (const ancho of [1440, 1280, 1024, 900, 768]) {
      await d.page.setViewportSize({ width: ancho, height: 900 })
      await d.page.waitForTimeout(250)
      const e = await leerEncabezado(d.page)
      const b = e.botones
      const nombres = b.map(x => x.texto).join(' · ')
      exigir(nombres === 'Plantilla · Exportar · Importar · Nuevo Cliente' && !e.menuVisible,
        `${ancho}px · visibles, en orden: ${nombres}${e.menuVisible ? ' (¡y el menú de mobile!)' : ''}`)
      exigir(unico(b, 'alto').length === 1 && b[0].alto === 44 && unico(b, 'top').length === 1,
        `${ancho}px · mismo alto (${unico(b, 'alto').join(', ')} px) y misma coordenada Y (${unico(b, 'top').join(', ')}) → una fila`)
      exigir(unico(b, 'radio').length === 1 && unico(b, 'padding').join() === '16px/16px' && unico(b, 'fuente').join() === '14px/600' && unico(b, 'icono').join() === '16x16',
        `${ancho}px · mismo radio (${unico(b, 'radio').join(', ')}), padding (${unico(b, 'padding').join(', ')}), tipografía (${unico(b, 'fuente').join(', ')}) e ícono (${unico(b, 'icono').join(', ')})`)
      exigir(b.slice(0, 3).every(x => x.clases === 'btn btn-secondary btn-page-action') && b[3].clases === 'btn btn-primary btn-page-action' && b.every(x => x.imagen === 'none'),
        `${ancho}px · tres secundarias + una primaria, sin \`btn-sm\` ni gradiente; anchos ${b.map(x => x.ancho).join(' / ')} px (no se igualan)`)
      exigir(e.desborde <= 1, `${ancho}px · sin desborde horizontal (${e.desborde})`)
    }
    exigir(d.errores.length === 0, `sin errores de página${d.errores.length ? ': ' + d.errores.slice(0, 2).join(' | ') : ''}`)
    await d.ctx.close()

    for (const tema of ['light', 'dark']) {
      decir(`\n[K] Clientes · contraste de las secundarias · ${tema} · 1440px`)
      const c = await abrirSesion({ tema })
      await ir(c.page, '/customers', '[data-testid="customers-new-button"]')
      for (const nombre of ['Plantilla', 'Exportar', 'Importar']) {
        const l = c.page.locator('.page-hdr-right').getByRole('button', { name: nombre, exact: true })
        await c.page.mouse.move(0, 0); await asentar(c.page)
        const reposo = await paintedContrastOf(l)
        await l.hover(); await asentar(c.page)
        const hover = await paintedContrastOf(l)
        exigir(reposo.ratio >= 4.5 && hover.ratio >= 4.5, `«${nombre}» reposo ${reposo.ratio.toFixed(2)}:1 · hover ${hover.ratio.toFixed(2)}:1`)
      }
      await c.ctx.close()
    }

    decir('\n[K] Clientes · mobile (< 768): «Nuevo Cliente» + el menú, como en BETA-UX-1D')
    const m = await abrirSesion({ tema: 'light', width: 375, height: 812 })
    await ir(m.page, '/customers', '[data-testid="customers-new-button"]')
    for (const ancho of [320, 375, 430, 767]) {
      await m.page.setViewportSize({ width: ancho, height: 812 })
      await m.page.waitForTimeout(250)
      const e = await leerEncabezado(m.page)
      const b = e.botones
      const centros = b.map(x => x.top + x.alto / 2)
      exigir(b.length === 2 && b[0].texto === 'Nuevo Cliente' && e.menuVisible,
        `${ancho}px · visibles: ${b.map(x => x.texto).join(' · ')} (Plantilla / Exportar / Importar no están en la fila)`)
      exigir(b.every(x => x.alto >= 44) && b[1].ancho >= 44 && Math.abs(centros[0] - centros[1]) <= 4 && e.desborde <= 1,
        `${ancho}px · «Nuevo Cliente» ${b[0].ancho}x${b[0].alto} y el menú ${b[1].ancho}x${b[1].alto}, en la misma fila, sin desborde`)
    }
    await m.page.setViewportSize({ width: 375, height: 812 })
    await m.page.getByTestId('customers-mobile-header-menu').click()
    const items = await m.page.getByRole('menu', { name: 'Más acciones de clientes' }).getByRole('menuitem').allTextContents()
    exigir(items.map(t => t.trim()).join(' · ') === 'Plantilla · Exportar · Importar', `375px · el menú ofrece: ${items.map(t => t.trim()).join(' · ')}`)
    await m.ctx.close()
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
