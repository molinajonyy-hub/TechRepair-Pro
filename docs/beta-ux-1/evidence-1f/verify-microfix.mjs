// BETA-UX-1F · microfix — verificación en navegador real con backend SIMULADO.
//
// Mismo arnés que `capture-mocked.mjs`: sesión falsa, `VITE_SUPABASE_URL` a un
// puerto muerto y cada request respondido con route(). No usa Docker ni el
// stack local, y nada sale de la máquina.
//
// Mide tres cosas, en Chromium y con el CSS y el código reales:
//   A. la fila de acciones secundarias en mobile (alto parejo, con y sin el fix);
//   B. el bloque de Tareas según capacidad + plan, contra el menú y la ruta;
//   C. qué pantallas leen la cotización y cuáles reprecian inventario.
//
// Uso: node verify-microfix.mjs <worktree> <cacheDir> [A|B|C ...]
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

const PORT = 5198
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
const profileFor = (role, permissions = null) => ({
  id: USER_ID, user_id: USER_ID, business_id: BIZ_ID, email: user.email, full_name: 'QA ' + role,
  role, is_active: true, permissions, created_at: '2026-10-01T12:00:00Z',
})
const day = 86400e3
const suscripcion = plan => ({
  subscription_status: 'active', subscription_plan: plan, access_source: 'admin_override',
  mp_preapproval_id: null, mp_payer_email: null, current_period_start: new Date(Date.now() - 10 * day).toISOString(),
  current_period_end: new Date(Date.now() + 20 * day).toISOString(), grace_until: null, last_payment_status: null,
  trial_ends_at: new Date(Date.now() - 40 * day).toISOString(), override_expires_at: null,
})
const ORDERS = ['repair', 'ready_delivery', 'waiting_approval', 'diagnosis', 'new', 'completed'].map((status, i) => ({
  id: `a1b2c3${(i + 16).toString(16)}-0000-4000-8000-000000000000`, business_id: BIZ_ID, status,
  created_at: new Date(Date.now() - i * 5 * 3600e3).toISOString(),
  customer: { name: `Cliente ${i + 1}` }, device: { brand: 'Samsung', model: `A${i}` },
}))
const TASKS = [1, 2, 3].map(i => ({
  id: `task-${i}`, title: `Tarea ${i}`, description: null, status: 'pending', priority: 'medium', due_date: null,
  assigned_to: USER_ID, user_id: USER_ID, started_at: null, completed_at: null, created_at: new Date().toISOString(),
}))
/** Dos productos con precio en dólares: lo que el reprecio lee y escribe. */
const VINCULADOS = [{ id: 'prod-usd-1', price_usd: 10 }, { id: 'prod-usd-2', price_usd: 25 }]

// ── Backend simulado: responde y REGISTRA ────────────────────────────────────
function crearBackend({ role = 'owner', permissions = null, plan = 'pro' } = {}) {
  /** @type {{ m: string, t: string, q: string }[]} */
  const log = []
  const estado = { cotizaciones: 0 }
  const rpc = {
    get_my_profile: [profileFor(role, permissions)],
    get_my_first_steps: { has_customer: true, has_order: true, has_inventory: true, has_cobro: true, has_logo: true },
    current_platform_admin_role: null, current_user_has_internal_tool_access: false,
  }
  const tablas = {
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
    inventory: req => (/linked_to_dolar=eq\.true/.test(new URL(req.url()).search) ? VINCULADOS : []),
  }

  const instalar = ctx => ctx.route(`${SB}/**`, async route => {
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
      log.push({ m: 'RPC', t: nombre, q: '' })
      return json(nombre in rpc ? rpc[nombre] : null)
    }
    if (p.startsWith('/rest/v1/')) {
      const tabla = p.replace('/rest/v1/', '')
      log.push({ m: req.method(), t: tabla, q: url.search })
      if (req.method() !== 'GET' && req.method() !== 'HEAD') return json([])
      const objeto = (req.headers()['accept'] || '').includes('vnd.pgrst.object')
      const sinFila = () => json({ code: 'PGRST116', message: 'mock: 0 rows' }, 406)
      if (tabla === 'businesses' && objeto) return json(suscripcion(plan))
      if (tabla in tablas) {
        const v = tablas[tabla]
        const cuerpo = typeof v === 'function' ? v(req) : v
        if (objeto) return Array.isArray(cuerpo) ? (cuerpo.length ? json(cuerpo[0]) : sinFila()) : (cuerpo ? json(cuerpo) : sinFila())
        return lista(Array.isArray(cuerpo) ? cuerpo : [cuerpo])
      }
      return objeto ? sinFila() : lista([])
    }
    if (p.startsWith('/functions/v1/fetch-dollar-rate')) {
      estado.cotizaciones += 1
      // Cada consulta a la fuente trae un valor distinto: se ve en el chip.
      return json({ sell: 1556 + (estado.cotizaciones - 1) * 10, buy: 1530, source: 'AMBITO_NACIONAL' })
    }
    if (p.startsWith('/functions/v1/')) return json({ error: 'mock' }, 404)
    return route.abort()
  })

  const escritura = e => e.m !== 'GET' && e.m !== 'HEAD' && e.m !== 'RPC'
  const cuenta = () => ({
    fuente: estado.cotizaciones,
    leeVinculados: log.filter(e => e.m === 'GET' && e.t === 'inventory' && /linked_to_dolar=eq\.true/.test(e.q)).length,
    escribeInventario: log.filter(e => e.t === 'inventory' && escritura(e)).length,
    guardaCotizacion: log.filter(e => ['exchange_rates', 'dollar_rate_history', 'business_settings'].includes(e.t) && escritura(e)).length,
    tareas: log.filter(e => /^task/.test(e.t)).length,
  })
  return { instalar, cuenta, log }
}

// ── Utilidades ───────────────────────────────────────────────────────────────
const lineas = []
let fallas = 0
const decir = texto => { console.log(texto); lineas.push(texto) }
const exigir = (condicion, texto) => {
  if (!condicion) fallas += 1
  decir(`  ${condicion ? 'OK   ' : 'FALLA'} ${texto}`)
}
const esperar = async (condicion, ms = 8000) => {
  const fin = Date.now() + ms
  while (Date.now() < fin) { if (await condicion()) return true; await new Promise(r => setTimeout(r, 100)) }
  return false
}

const browser = await chromium.launch()
async function abrirSesion(backend, { width = 1440, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
  await ctx.addInitScript(([s]) => {
    try { localStorage.setItem('sb-127-auth-token', s); localStorage.setItem('techrepair_theme', 'light'); localStorage.setItem('theme', 'light') } catch { /* sin storage */ }
  }, [JSON.stringify(session)])
  await ctx.route('**/*', r => {
    const u = r.request().url()
    if (u.startsWith(base) || u.startsWith(SB) || u.startsWith('data:') || u.startsWith('blob:')) return r.fallback()
    if (/cdn\.jsdelivr\.net\/npm\/bootstrap|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(u)) return r.fallback()
    return r.abort()
  })
  await backend.instalar(ctx)
  const page = await ctx.newPage()
  const errores = []
  page.on('pageerror', e => errores.push(String(e.message).slice(0, 160)))
  return { ctx, page, errores }
}
const asentar = page => page.evaluate(() => Promise.all(document.getAnimations()
  .filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))))
async function irAInicio(page) {
  await page.goto(base + '/dashboard', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="dashboard-today"]', { timeout: 120_000 })
  await page.waitForTimeout(1500)
  await asentar(page)
}
const CHIP = '[data-testid="top-header-utilities"] [data-testid="shell-dollar-chip"]'
const chipDice = (page, valor) => page.waitForFunction(
  ([sel, v]) => document.querySelector(sel)?.textContent?.includes(v), [CHIP, valor], { timeout: 120_000 })
const actualizarChip = page => page.locator(`${CHIP} button[aria-label="Actualizar cotización del dólar"]`).click()
/** Navegación del cliente, sin recargar: la sesión de la aplicación es la misma. */
const irPorMenu = async (page, ruta, listo) => {
  await page.locator(`aside a[href="${ruta}"]:visible`).first().click()
  await page.waitForURL(`**${ruta}`)
  if (listo) await page.waitForSelector(listo, { timeout: 30_000 })
  await page.waitForTimeout(800)
}

try {
  // ═══ A · fila de acciones secundarias en mobile ══════════════════════════
  if (corre('A')) {
    decir('\n[A] Mobile · las tres acciones secundarias comparten fila y alto')
    const backend = crearBackend()
    const { ctx, page, errores } = await abrirSesion(backend, { width: 375, height: 812 })
    await irAInicio(page)
    const medir = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="dashboard-actions"] .dash-action--secondary')].map(b => {
      const r = b.getBoundingClientRect()
      // Renglones del RÓTULO: sólo nodos de texto, el ícono no cuenta.
      const renglones = new Set()
      const textos = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
      for (let nodo = textos.nextNode(); nodo; nodo = textos.nextNode()) {
        const rango = document.createRange()
        rango.selectNodeContents(nodo)
        for (const c of rango.getClientRects()) if (c.width > 1) renglones.add(Math.round(c.top))
      }
      return { y: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width), renglones: renglones.size, corta: b.scrollWidth - b.clientWidth }
    }))
    let conRenglonesDesparejos = 0
    for (const ancho of [320, 344, 360, 375, 390, 412, 430, 480, 540, 600, 767]) {
      await page.setViewportSize({ width: ancho, height: 812 })
      await page.waitForTimeout(250)
      const conFix = await medir()
      // Control en vivo: la regla de antes del fix (el `center` de escritorio).
      const estilo = await page.addStyleTag({ content: '@media (max-width: 767px) { .dash-actions { align-items: center !important; } }' })
      await page.waitForTimeout(100)
      const sinFix = await medir()
      await estilo.evaluate(nodo => nodo.remove())
      const desparejo = new Set(conFix.map(b => b.renglones)).size > 1
      if (desparejo) conRenglonesDesparejos += 1
      const parejo = m => new Set(m.map(b => b.y)).size === 1 && Math.max(...m.map(b => b.h)) - Math.min(...m.map(b => b.h)) <= 1
      exigir(conFix.length === 3 && parejo(conFix) && conFix.every(b => b.corta <= 1) && Math.max(...conFix.map(b => b.w)) - Math.min(...conFix.map(b => b.w)) <= 2,
        `${ancho}px · renglones ${conFix.map(b => b.renglones).join('/')} · altos ${conFix.map(b => b.h).join('/')} · y ${conFix.map(b => b.y).join('/')}`
        + (desparejo ? `   ← sin el fix: altos ${sinFix.map(b => b.h).join('/')} · y ${sinFix.map(b => b.y).join('/')} (${parejo(sinFix) ? 'parejo' : 'DESPAREJO'})` : ''))
      if (desparejo) exigir(!parejo(sinFix), `${ancho}px · el control sin el fix reproduce la fila despareja`)
    }
    exigir(conRenglonesDesparejos > 0, `el barrido incluyó ${conRenglonesDesparejos} ancho(s) con rótulos en distinta cantidad de renglones (el caso de CI)`)
    exigir(errores.length === 0, `sin errores de página${errores.length ? ': ' + errores.slice(0, 2).join(' | ') : ''}`)
    await ctx.close()
  }

  // ═══ B · bloque de Tareas: capacidad + plan ══════════════════════════════
  if (corre('B')) {
    decir('\n[B] Bloque de Tareas · el mismo contrato que la ruta /tasks y el menú')
    const CASOS = [
      ['A · feature + orders', { role: 'tech', plan: 'pro' }, true],
      ['A · dueño, plan full', { role: 'owner', plan: 'full' }, true],
      ['B · feature sin orders', { role: 'tech', plan: 'pro', permissions: { orders: false } }, false],
      ['C · orders sin feature', { role: 'tech', plan: 'basico' }, false],
      ['C · dueño, plan básico', { role: 'owner', plan: 'basico' }, false],
      ['D · sin ninguna', { role: 'tech', plan: 'basico', permissions: { orders: false } }, false],
    ]
    for (const [nombre, actor, esperado] of CASOS) {
      const backend = crearBackend(actor)
      const { ctx, page, errores } = await abrirSesion(backend)
      await irAInicio(page)
      const vista = await page.evaluate(() => {
        const hoy = document.querySelector('[data-testid="dashboard-today"]')
        const ordenes = document.querySelector('[data-testid="dashboard-recent-orders"]')
        const tareas = document.querySelector('[data-testid="dashboard-tasks"]')
        return {
          bloque: Boolean(tareas),
          menu: [...document.querySelectorAll('aside a[href="/tasks"]')].length > 0,
          sigueAHoy: hoy?.nextElementSibling?.getAttribute('data-testid') ?? null,
          hueco: hoy && ordenes ? Math.round(ordenes.getBoundingClientRect().top - hoy.getBoundingClientRect().bottom) : null,
          margen: hoy ? Math.round(parseFloat(getComputedStyle(hoy).marginBottom)) : null,
          nuevaTarea: [...document.querySelectorAll('[data-testid="dashboard-page"] button')].some(b => b.textContent?.trim() === 'Nueva tarea'),
        }
      })
      await page.locator('[data-testid="dashboard-actions"] button[aria-label="Actualizar datos"]').click()
      await page.waitForTimeout(1200)
      const pedidas = backend.cuenta().tareas
      decir(`  ── ${nombre} (${actor.role}, ${actor.plan}${actor.permissions ? ', orders:false' : ''})`)
      exigir(vista.bloque === esperado, `bloque de Tareas ${vista.bloque ? 'presente' : 'ausente'} (esperado: ${esperado ? 'presente' : 'ausente'})`)
      exigir(vista.menu === esperado, `el menú ${vista.menu ? 'ofrece' : 'no ofrece'} «Tareas»: la misma decisión`)
      if (esperado) {
        exigir(pedidas > 0, `pidió tareas (${pedidas} requests, incluido «Actualizar»)`)
        exigir(vista.sigueAHoy === 'dashboard-tasks', 'el bloque va después de «Hoy»')
      } else {
        exigir(pedidas === 0, `cero requests a tasks / task_items / task_history (también tras «Actualizar»): ${pedidas}`)
        exigir(vista.sigueAHoy === 'dashboard-recent-orders' && vista.hueco === vista.margen,
          `sin hueco: a «Hoy» le siguen las órdenes recientes, a ${vista.hueco}px (el margen de «Hoy» es ${vista.margen}px)`)
        exigir(!vista.nuevaTarea, 'no hay «Nueva tarea» que lleve a «mejorá tu plan»')
      }
      // La ruta, escrita a mano, decide lo mismo.
      await page.goto(base + '/tasks', { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2500)
      const ruta = await page.evaluate(() => ({
        url: location.pathname,
        mejora: /Esta función está disponible en el plan/.test(document.body.textContent || ''),
      }))
      const entra = ruta.url === '/tasks' && !ruta.mejora
      exigir(entra === esperado, `la ruta /tasks ${entra ? 'abre el módulo' : ruta.mejora ? 'muestra «mejorá tu plan»' : `rebota a ${ruta.url}`}`)
      exigir(errores.length === 0, `sin errores de página${errores.length ? ': ' + errores.slice(0, 2).join(' | ') : ''}`)
      await ctx.close()
    }
  }

  // ═══ C · cotización en el shell, reprecio sólo en Inicio ═════════════════
  if (corre('C')) {
    decir('\n[C] Dólar · el shell lee y muestra; sólo Inicio reprecia inventario')
    const backend = crearBackend()
    const { ctx, page, errores } = await abrirSesion(backend)
    const paso = (texto, c = backend.cuenta()) =>
      decir(`  · ${texto}\n      fuente consultada ${c.fuente} · lee productos en USD ${c.leeVinculados} · UPDATE inventory ${c.escribeInventario} · escrituras de la cotización ${c.guardaCotizacion}`)

    await page.goto(base + '/orders', { waitUntil: 'domcontentloaded' })
    await chipDice(page, '$1.556')
    await page.waitForTimeout(2000)
    paso('carga en /orders (pantalla que no es Inicio)')
    let c = backend.cuenta()
    exigir(c.fuente === 1, 'la cotización se leyó una vez')
    exigir(c.leeVinculados === 0 && c.escribeInventario === 0, '/orders no leyó productos en USD ni escribió inventario')

    await actualizarChip(page)
    await chipDice(page, '$1.566')
    await page.waitForTimeout(1500)
    paso('«Actualizar cotización» desde /orders')
    c = backend.cuenta()
    exigir(c.fuente === 2, 'la fuente se consultó de nuevo (lectura forzada por el usuario)')
    exigir(c.leeVinculados === 0 && c.escribeInventario === 0, 'un refresh de dólar fuera de Inicio no actualizó productos')

    await irPorMenu(page, '/customers')
    await page.waitForTimeout(1500)
    paso('navegar a /customers')
    c = backend.cuenta()
    exigir(c.fuente === 2 && c.leeVinculados === 0 && c.escribeInventario === 0, 'navegar entre pantallas no pide la cotización ni toca inventario')

    await irPorMenu(page, '/dashboard', '[data-testid="dashboard-today"]')
    await esperar(() => backend.cuenta().escribeInventario === VINCULADOS.length)
    await page.waitForTimeout(1500)
    paso('entrar a Inicio')
    c = backend.cuenta()
    exigir(c.fuente === 2, 'Inicio NO hizo un segundo pedido de cotización: usó la lectura del shell')
    exigir(c.leeVinculados === 1 && c.escribeInventario === VINCULADOS.length, `Inicio aplicó la cotización vigente UNA vez (${VINCULADOS.length} productos)`)

    await actualizarChip(page)
    await chipDice(page, '$1.576')
    await esperar(() => backend.cuenta().escribeInventario === VINCULADOS.length * 2)
    await page.waitForTimeout(1500)
    paso('«Actualizar cotización» estando en Inicio')
    c = backend.cuenta()
    exigir(c.fuente === 3 && c.leeVinculados === 2 && c.escribeInventario === VINCULADOS.length * 2, 'una lectura nueva con Inicio montado se aplica una vez')

    await irPorMenu(page, '/orders')
    await actualizarChip(page)
    await chipDice(page, '$1.586')
    await page.waitForTimeout(1500)
    paso('salir a /orders y actualizar la cotización otra vez')
    c = backend.cuenta()
    exigir(c.fuente === 4 && c.leeVinculados === 2 && c.escribeInventario === VINCULADOS.length * 2, 'al salir de Inicio el reprecio se detiene aunque la cotización cambie')

    await irPorMenu(page, '/dashboard', '[data-testid="dashboard-today"]')
    await esperar(() => backend.cuenta().escribeInventario === VINCULADOS.length * 3)
    await page.waitForTimeout(1500)
    await irPorMenu(page, '/orders')
    await irPorMenu(page, '/dashboard', '[data-testid="dashboard-today"]')
    await page.waitForTimeout(1500)
    paso('volver a Inicio, salir y volver a entrar sin una lectura nueva')
    c = backend.cuenta()
    exigir(c.fuente === 4, 'ninguna de las tres entradas a Inicio pidió la cotización')
    exigir(c.leeVinculados === 3 && c.escribeInventario === VINCULADOS.length * 3, 'la lectura pendiente se aplicó una sola vez; reentrar no la repite')
    exigir(errores.length === 0, `sin errores de página${errores.length ? ': ' + errores.slice(0, 2).join(' | ') : ''}`)
    await ctx.close()

    // Carga directa en Inicio: una lectura, un reprecio.
    const directo = crearBackend()
    const s2 = await abrirSesion(directo)
    await irAInicio(s2.page)
    await esperar(() => directo.cuenta().escribeInventario === VINCULADOS.length)
    await s2.page.waitForTimeout(1500)
    paso('carga directa en /dashboard', directo.cuenta())
    c = directo.cuenta()
    exigir(c.fuente === 1 && c.leeVinculados === 1 && c.escribeInventario === VINCULADOS.length, 'la barra e Inicio comparten UNA lectura y hay UN reprecio')
    await s2.ctx.close()
  }
} finally {
  await browser.close()
  await server.close()
}

decir(fallas === 0 ? '\nVERIFICACIÓN DEL MICROFIX: todo en verde' : `\nVERIFICACIÓN DEL MICROFIX: ${fallas} comprobación(es) en rojo`)
process.exit(fallas === 0 ? 0 : 1)
