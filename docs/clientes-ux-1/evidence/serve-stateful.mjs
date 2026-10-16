// CLIENTES-UX-1 — copia del Supabase simulado de BETA-UX-2
// (docs/beta-ux-2/evidence/e2e-mock/serve.mjs) con dos cambios, sólo para
// reproducir la edición de clientes y sacar las capturas:
//   · PATCH /rest/v1/customers guarda en memoria y devuelve la fila, así se
//     puede guardar, reabrir y ver lo guardado;
//   · un segundo cliente, «Mayorista Portal», mayorista SIN razón social, como
//     los crea `get_or_create_customer_from_wholesale_atomic`.
// Nada sale de la máquina. No reemplaza al job `e2e-local` (base real).
// Uso: node serve-stateful.mjs   (API :59997, web :5200)
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.REPO_ROOT || path.resolve(here, '../../..')
// MOCK_API_PORT / MOCK_WEB_PORT: puertos propios, para levantar varios seguidos
// sin esperar a que el anterior libere los suyos.
const API_PORT = Number(process.env.MOCK_API_PORT || 59997)
const WEB_PORT = Number(process.env.MOCK_WEB_PORT || 5200)
const API = `http://127.0.0.1:${API_PORT}`

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url')
export const USER_ID = '00000000-0000-4000-8000-00000000d15c'
const BIZ_ID = '00000000-0000-4000-8000-00000000b12e'
const now = Math.floor(Date.now() / 1000)
const jwt = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: USER_ID, exp: now + 86400, role: 'authenticated', aud: 'authenticated', email: 'owner.qa@example.test' })}.sig`
export const user = {
  id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'owner.qa@example.test',
  email_confirmed_at: '2026-10-01T12:00:00Z', app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: 'QA' }, created_at: '2026-10-01T11:59:00Z', identities: [],
}
export const session = { access_token: jwt, token_type: 'bearer', expires_in: 86400, expires_at: now + 86400, refresh_token: 'fake-refresh', user }
// Perillas para reproducir lo que ve CI con la base real:
//   MOCK_ROLE       rol del perfil (owner por defecto; `tech` = técnico sin finanzas).
//   MOCK_CUSTOMERS  cuántos clientes devuelve la búsqueda (CI acumula decenas de
//                   corridas: con uno solo la recepción no scrollea).
//   MOCK_CUSTOMERS_DELAY_MS  demora de la búsqueda de clientes: en CI el spec mide
//                   la recepción con la lista todavía en «Buscando…».
const ROLE = process.env.MOCK_ROLE || 'owner'
const EXTRA_CUSTOMERS = Number(process.env.MOCK_CUSTOMERS || 0)
const CUSTOMERS_DELAY_MS = Number(process.env.MOCK_CUSTOMERS_DELAY_MS || 0)
const profile = { id: USER_ID, user_id: USER_ID, business_id: BIZ_ID, email: user.email, full_name: `QA ${ROLE}`, role: ROLE, is_active: true, permissions: null, created_at: '2026-10-01T12:00:00Z' }
const day = 86400e3
const SUBSCRIPTION = {
  subscription_status: 'active', subscription_plan: 'full', access_source: 'admin_override',
  mp_preapproval_id: null, mp_payer_email: null, current_period_start: new Date(Date.now() - 10 * day).toISOString(),
  current_period_end: new Date(Date.now() + 20 * day).toISOString(), grace_until: null, last_payment_status: null,
  trial_ends_at: new Date(Date.now() - 40 * day).toISOString(), override_expires_at: null,
}
const CUSTOMER = { id: 'c0000000-0000-4000-8000-0000000000e2', business_id: BIZ_ID, name: 'Cliente E2E', phone: '3511234567', email: null, address: null, document: '30111222', customer_type: 'minorista', active: true, created_at: '2026-10-01T12:00:00Z' }
const PORTAL = { ...CUSTOMER, id: 'c0000000-0000-4000-8000-0000000000f1', name: 'Mayorista Portal', phone: '+54 9 351 555-1234', document: null, customer_type: 'mayorista', business_name: null, contact_person: null, email: 'portal@example.test' }
const CUSTOMERS = [CUSTOMER, PORTAL, ...Array.from({ length: EXTRA_CUSTOMERS }, (_, i) => ({
  ...CUSTOMER, id: `c0000000-0000-4000-8000-${String(1000 + i).padStart(12, '0')}`,
  name: `Sintético ${i + 1}`, phone: `35100000${String(i).padStart(2, '0')}`, document: null,
}))]
const DEVICE = { id: 'd0000000-0000-4000-8000-0000000000aa', type: 'smartphone', brand: 'Motorola', model: 'Moto G', serial: null, imei: null, issue: 'No carga', diagnosis: null }
const ORDER_ID = 'f0000000-0000-4000-8000-0000000000aa'
//   MOCK_ACCESS_MODE / MOCK_ACCESS_SECRET  acceso ya guardado en la orden (para
//                   ver la tarjeta «Acceso del equipo» con un patrón SINTÉTICO de
//                   formato anterior, p. ej. `[1,4,7,8]`, sin pasar por la recepción).
const state = { accessMode: process.env.MOCK_ACCESS_MODE || 'none', secret: process.env.MOCK_ACCESS_SECRET ?? null }
const order = () => ({
  id: ORDER_ID, business_id: BIZ_ID, status: 'new', priority: 'medium', customer_id: CUSTOMER.id, device_id: DEVICE.id,
  access_mode: state.accessMode, estimated_total: 0, estimated_total_currency: 'ARS', notes: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), created_by: USER_ID,
  customer: { name: CUSTOMER.name, phone: CUSTOMER.phone }, device: { brand: DEVICE.brand, model: DEVICE.model, type: DEVICE.type },
})

/** Réplica de `private.mobile2a_legacy_from_access` (modo patrón). */
function rejectsPattern(secret) {
  let points
  try { points = JSON.parse(secret) } catch { return true }
  if (!Array.isArray(points) || points.length < 2 || points.length > 9) return true
  if (points.some(p => !/^[0-8]$/.test(String(p)))) return true
  return new Set(points.map(String)).size !== points.length
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,HEAD,OPTIONS',
  'Access-Control-Expose-Headers': 'content-range',
}

const api = http.createServer((req, res) => {
  const url = new URL(req.url, API)
  const p = url.pathname
  const send = (status, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...cors, ...extra })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }
  const list = arr => send(200, arr, { 'content-range': `${arr.length ? `0-${arr.length - 1}` : '*'}/${arr.length}` })
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  // Control del simulador (no existe en Supabase): cambia el acceso guardado sin
  // reiniciar Vite. `?mode=pattern&secret=[1,2,5,8]`.
  if (p === '/__mock/access') {
    state.accessMode = url.searchParams.get('mode') || 'none'
    state.secret = url.searchParams.get('secret')
    return send(200, { ok: true })
  }
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const body = raw ? (() => { try { return JSON.parse(raw) } catch { return {} } })() : {}
    if (p.startsWith('/auth/v1/user')) return send(200, user)
    if (p.startsWith('/auth/v1/token')) return send(200, session)
    if (p.startsWith('/auth/v1/')) return send(200, {})
    if (p.startsWith('/storage/v1/')) return send(200, { Key: 'mock', Id: 'mock' })
    if (p.startsWith('/functions/v1/fetch-dollar-rate')) return send(200, { sell: 1556, buy: 1530, source: 'AMBITO_NACIONAL' })
    if (p.startsWith('/functions/v1/')) return send(404, { error: 'mock' })
    // Gate SEC-08E (pgrst.db_pre_request, mínimo 1): sin contrato de cliente,
    // PostgREST responde 409 a TODO /rest/v1. El bundle lo manda siempre; un
    // fetch a mano de un spec, no.
    if (p.startsWith('/rest/v1/') && !/^[1-9][0-9]*$/.test(String(req.headers['x-techrepair-client-contract'] ?? '')))
      return send(409, { code: 'CLIENT_UPDATE_REQUIRED', message: 'Actualizá la aplicación para continuar.', details: null, hint: null })
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.replace('/rest/v1/rpc/', '')
      if (fn === 'get_my_profile') return send(200, [profile])
      if (fn === 'get_my_first_steps') return send(200, { has_customer: true, has_order: true, has_inventory: true, has_cobro: true, has_logo: true })
      if (fn === 'current_platform_admin_role') return send(200, null)
      if (fn === 'current_user_has_internal_tool_access') return send(200, false)
      if (fn === 'reveal_order_device_access') return send(200, state.secret)
      if (fn === 'set_order_device_access_secret') {
        // Misma validación de patrón que el servidor (acepta números o strings 0–8).
        if (body.p_mode === 'pattern' && rejectsPattern(body.p_secret))
          return send(400, { code: '22023', message: 'INVALID_ACCESS_PATTERN', details: null, hint: null })
        state.accessMode = body.p_mode; state.secret = body.p_secret
        return send(200, null)
      }
      if (fn === 'create_order_intake') {
        const mode = body.p_payload?.access_mode
        const secret = body.p_access_secret ?? null
        const fail = message => send(400, { code: '22023', message, details: null, hint: null })
        if (['pin', 'pattern', 'password'].includes(mode) && !secret) return fail('ACCESS_SECRET_REQUIRED')
        if (!['pin', 'pattern', 'password'].includes(mode) && secret !== null) return fail('UNEXPECTED_ACCESS_SECRET')
        if (mode === 'pattern' && rejectsPattern(secret)) return fail('INVALID_ACCESS_PATTERN')
        state.accessMode = mode; state.secret = secret
        return send(200, { order_id: ORDER_ID, device_id: DEVICE.id, replayed: false })
      }
      return send(200, null)
    }
    if (p.startsWith('/rest/v1/')) {
      const table = p.replace('/rest/v1/', '')
      if (req.method === 'PATCH' && table === 'customers') {
        const id = (url.searchParams.get('id') || '').replace('eq.', '')
        const row = CUSTOMERS.find(c => c.id === id)
        if (!row) return send(406, { code: 'PGRST116', message: 'mock: 0 rows' })
        Object.assign(row, body)
        return send(200, row)
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(200, [])
      const single = (req.headers.accept || '').includes('vnd.pgrst.object')
      const one = row => row ? send(200, row) : send(406, { code: 'PGRST116', message: 'mock: 0 rows' })
      if (table === 'businesses' && single) return send(200, SUBSCRIPTION)
      if (table === 'orders') return single ? one(order()) : list([order()])
      if (table === 'customers') {
        if (single) { const id = (url.searchParams.get('id') || '').replace('eq.', ''); return one(CUSTOMERS.find(c => c.id === id) || CUSTOMER) }
        return CUSTOMERS_DELAY_MS ? setTimeout(() => list(CUSTOMERS), CUSTOMERS_DELAY_MS) : list(CUSTOMERS)
      }
      if (table === 'devices') return single ? one(DEVICE) : list([DEVICE])
      if (table === 'business_users_view') return list([{ id: USER_ID, full_name: `QA ${ROLE}`, email: user.email, role: ROLE, is_active: true, permissions: null }])
      if (table === 'business_settings') { const row = { business_id: BIZ_ID, dolar_source: 'nacional', auto_update_rate: true, nombre_comercial: 'Taller QA', mayorista_enabled: true }; return single ? one(row) : list([row]) }
      if (table === 'exchange_rates') { const row = { rate: 1556, source: 'bluelytics', updated_at: new Date().toISOString() }; return single ? one(row) : list([row]) }
      return single ? one(null) : list([])
    }
    send(404, { error: 'mock: ruta desconocida' })
  })
})
api.listen(API_PORT, '127.0.0.1')

process.env.VITE_SUPABASE_URL = API
process.env.VITE_SUPABASE_ANON_KEY = 'local-dummy-anon-key'
const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href)
const vite = await createServer({
  root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
  server: { host: '127.0.0.1', port: WEB_PORT, strictPort: true, open: false },
})
await vite.listen()
console.log(`mock API ${API} · web http://127.0.0.1:${WEB_PORT}`)
