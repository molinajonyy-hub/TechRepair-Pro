#!/usr/bin/env node
// SEC-08A — matriz real contra PostgREST local, con JWT firmados localmente.
//
// El contrato del lote es sobre lo que CRUZA LA RED, así que se prueba por HTTP
// y no sólo en SQL: las relaciones anidadas (`/customers?select=orders(...)`)
// sólo existen en PostgREST, y cerrar `/orders` sin cerrarlas no cierra nada.
//
// Cada aserción negativa comprueba que el VALOR sensible no aparece en el
// cuerpo de la respuesta, no que el status sea feo.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')
const dbContainer = process.env.SEC08A_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base local')

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
const sql = query => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], query).trim()

const actorNames = ['owner', 'admin', 'manager', 'tech', 'sales', 'cashier', 'viewer', 'inactive', 'ownerB']
const ids = Object.fromEntries(['A', 'B', ...actorNames, 'customer', 'device', 'order'].map(n => [n, randomUUID()]))

// Valores testigo. Si alguno aparece en una respuesta que no debía traerlo, el
// lote está roto — no importa el status HTTP.
const AMOUNTS = { estimated_total: 123456, labor_cost: 7777, total_cost: 99999, amount_paid: 5555 }
const LEGACY_SECRET = 'pin:8391'
const VAULT_SECRET = '4417'
const O1 = ['estimated_total', 'estimated_total_currency', 'labor_cost', 'total_cost', 'amount_paid', 'paid_at']

let seeded = false
let requests = 0
let checks = 0
try {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuración de PostgREST local (¿kong sin puerto publicado?)')
  const api = `http://127.0.0.1:${hostPort}/rest/v1`
  let signingKey = Buffer.from(vars.PGRST_JWT_SECRET)
  if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
    const key = JSON.parse(vars.PGRST_JWT_SECRET).keys.find(k => k.kty === 'oct')
    assert(key?.k, 'Falta la JWK HS256 local')
    signingKey = Buffer.from(key.k, 'base64url')
  }
  const token = (actor, role = 'authenticated') => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const claims = { role, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 }
    if (actor) claims.sub = ids[actor]
    const c = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${h}.${c}.${createHmac('sha256', signingKey).update(`${h}.${c}`).digest('base64url')}`
  }
  const request = async (actor, path, { method = 'GET', body, role = 'authenticated', headers = {} } = {}) => {
    requests++
    const response = await fetch(api + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers, ...(actor || role === 'service_role' ? { Authorization: `Bearer ${token(actor, role)}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    })
    const text = await response.text()
    let parsed = text
    try { parsed = text ? JSON.parse(text) : null } catch { /* texto plano */ }
    return { status: response.status, body: parsed, text, range: response.headers.get('content-range') }
  }

  /** El valor sensible NO puede aparecer en el cuerpo, pase lo que pase. */
  const denyValue = (result, needles, label) => {
    checks++
    for (const needle of needles) {
      assert(!String(result.text ?? '').includes(String(needle)),
        `${label}: el valor '${needle}' cruzó la red — ${result.status} ${result.text?.slice(0, 300)}`)
    }
  }
  const expectStatus = (result, allowed, label) => {
    checks++
    assert(allowed.includes(result.status), `${label}: status ${result.status} — ${result.text?.slice(0, 300)}`)
  }
  const expect = (condition, label) => { checks++; assert(condition, label) }

  const users = actorNames.map(n => `('${ids[n]}','${n}@sec08a-http.invalid',now())`).join(',')
  const profiles = actorNames.map(n => `('${ids[n]}','${ids[n]}','${n === 'ownerB' ? ids.B : ids.A}','${n === 'ownerB' ? 'owner' : n === 'inactive' ? 'admin' : n}',${n === 'inactive' ? 'false' : 'true'},'${n}@sec08a-http.invalid')`).join(',')
  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ${users};
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
      ('${ids.A}','SEC08A HTTP A','${ids.owner}','full','active'),
      ('${ids.B}','SEC08A HTTP B','${ids.ownerB}','full','active');
    INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email) VALUES ${profiles};
    INSERT INTO public.customers(id,business_id,name,phone) VALUES('${ids.customer}','${ids.A}','SEC08A customer','1100000000');
    INSERT INTO public.devices(id,business_id,customer_id,type,brand,model,issue) VALUES
      ('${ids.device}','${ids.A}','${ids.customer}','smartphone','SEC08A','Fixture','pantalla');
    INSERT INTO public.orders(id,business_id,customer_id,device_id,status,priority,
      estimated_total,labor_cost,total_cost,amount_paid,paid_at,device_password,access_mode,created_by)
      VALUES('${ids.order}','${ids.A}','${ids.customer}','${ids.device}','repair','medium',
        ${AMOUNTS.estimated_total},${AMOUNTS.labor_cost},${AMOUNTS.total_cost},${AMOUNTS.amount_paid},
        now(),'${LEGACY_SECRET}','pin','${ids.owner}');
    SET session_replication_role=origin;
    COMMIT;
  `); seeded = true

  // Secreto canónico en Vault, escrito por la ruta canónica como admin.
  const stored = await request('admin', '/rpc/set_order_device_access_secret', {
    method: 'POST', body: { p_order_id: ids.order, p_mode: 'pin', p_secret: VAULT_SECRET },
  })
  expectStatus(stored, [200, 204], 'set_order_device_access_secret (admin)')

  const leakNeedles = Object.values(AMOUNTS).map(String)
  const secretNeedles = [LEGACY_SECRET, '8391', VAULT_SECRET]

  // ── 1. Lectura operativa segura ────────────────────────────────────────────
  for (const actor of ['owner', 'admin', 'manager', 'tech', 'sales', 'cashier', 'viewer']) {
    const safe = await request(actor, `/orders?id=eq.${ids.order}&select=id,status,priority,created_at,access_mode,customer:customers(id,name)`)
    expectStatus(safe, [200], `${actor} lectura operativa`)
    expect(safe.body?.[0]?.status === 'repair', `${actor} recibe el estado de la orden`)
    expect(safe.body?.[0]?.access_mode === 'pin', `${actor} recibe el MODO de acceso`)
    denyValue(safe, [...leakNeedles, ...secretNeedles], `${actor} lectura operativa`)
  }
  const count = await request('tech', `/orders?business_id=eq.${ids.A}&select=id`, { method: 'HEAD', headers: { Prefer: 'count=exact' } })
  expectStatus(count, [200, 206], 'conteo por PK sigue disponible')
  expect(/\/1$/.test(count.range || ''), 'el conteo devuelve el total esperado')

  // ── 2. Pedido financiero explícito ─────────────────────────────────────────
  for (const actor of [...actorNames, null]) {
    for (const column of O1) {
      const direct = await request(actor, `/orders?id=eq.${ids.order}&select=id,${column}`)
      expectStatus(direct, [401, 403], `${actor ?? 'anon'} pide orders.${column} directo`)
      denyValue(direct, leakNeedles, `${actor ?? 'anon'} pide orders.${column} directo`)
    }
    const star = await request(actor, `/orders?id=eq.${ids.order}&select=*`)
    expectStatus(star, [401, 403], `${actor ?? 'anon'} pide orders con select=*`)
    denyValue(star, [...leakNeedles, ...secretNeedles], `${actor ?? 'anon'} pide orders con select=*`)
  }

  // ── 3. Pedido explícito del secreto ────────────────────────────────────────
  for (const actor of [...actorNames, null]) {
    const direct = await request(actor, `/orders?id=eq.${ids.order}&select=id,device_password`)
    expectStatus(direct, [401, 403], `${actor ?? 'anon'} pide orders.device_password`)
    denyValue(direct, secretNeedles, `${actor ?? 'anon'} pide orders.device_password`)
  }

  // ── 4. Bypass por relación anidada ─────────────────────────────────────────
  // Esto es lo que hace insuficiente cerrar sólo /orders.
  const nested = [
    `/customers?id=eq.${ids.customer}&select=*,orders(*)`,
    `/customers?id=eq.${ids.customer}&select=id,orders(total_cost)`,
    `/customers?id=eq.${ids.customer}&select=id,orders(estimated_total,labor_cost,amount_paid)`,
    `/customers?id=eq.${ids.customer}&select=id,orders(device_password)`,
    `/devices?id=eq.${ids.device}&select=*,orders(device_password)`,
    `/devices?id=eq.${ids.device}&select=id,orders(total_cost)`,
  ]
  for (const actor of ['tech', 'sales', 'cashier', 'viewer', 'manager', 'admin', 'owner']) {
    for (const path of nested) {
      const result = await request(actor, path)
      expectStatus(result, [401, 403], `${actor} bypass anidado ${path}`)
      denyValue(result, [...leakNeedles, ...secretNeedles], `${actor} bypass anidado ${path}`)
    }
  }
  // Control positivo: la relación anidada SEGURA sigue funcionando.
  const nestedSafe = await request('tech', `/customers?id=eq.${ids.customer}&select=id,name,orders(id,status,created_at)`)
  expectStatus(nestedSafe, [200], 'relación anidada operativa')
  expect(nestedSafe.body?.[0]?.orders?.length === 1, 'la relación anidada operativa devuelve la orden')
  denyValue(nestedSafe, [...leakNeedles, ...secretNeedles], 'relación anidada operativa')

  // ── 5. Ruta autorizada de importes ─────────────────────────────────────────
  const amountsFor = actor => request(actor, '/rpc/get_order_financial_amounts', {
    method: 'POST', body: { p_business_id: ids.A, p_order_ids: [ids.order] },
  })
  for (const actor of ['owner', 'admin', 'manager', 'sales', 'cashier']) {
    const result = await amountsFor(actor)
    expectStatus(result, [200], `${actor} ruta autorizada de importes`)
    expect(result.body?.authorized === true, `${actor} está autorizado a ver importes`)
    const row = result.body?.rows?.[0]
    for (const [column, value] of Object.entries(AMOUNTS)) {
      expect(Number(row?.[column]) === value, `${actor} recibe ${column} por la ruta canónica`)
    }
    expect(row?.saldo_pendiente !== undefined, `${actor} sigue recibiendo los derivados canónicos`)
  }
  for (const actor of ['tech', 'viewer']) {
    const result = await amountsFor(actor)
    expectStatus(result, [200], `${actor} ruta de importes sin capacidad`)
    expect(result.body?.authorized === false, `${actor} recibe authorized=false`)
    expect((result.body?.rows ?? []).length === 0, `${actor} recibe cero filas`)
    denyValue(result, leakNeedles, `${actor} ruta de importes sin capacidad`)
  }
  const inactiveAmounts = await amountsFor('inactive')
  expect(inactiveAmounts.body?.ok === false || inactiveAmounts.body?.authorized === false, 'inactive no obtiene importes')
  denyValue(inactiveAmounts, leakNeedles, 'inactive ruta de importes')
  const anonAmounts = await request(null, '/rpc/get_order_financial_amounts', {
    method: 'POST', body: { p_business_id: ids.A, p_order_ids: [ids.order] },
  })
  expectStatus(anonAmounts, [401, 403, 404], 'anon ruta de importes')
  denyValue(anonAmounts, leakNeedles, 'anon ruta de importes')

  // ── 6. Ruta autorizada del secreto ─────────────────────────────────────────
  const revealFor = actor => request(actor, '/rpc/reveal_order_device_access', { method: 'POST', body: { p_order_id: ids.order } })
  for (const actor of ['owner', 'admin', 'manager', 'tech']) {
    const result = await revealFor(actor)
    expectStatus(result, [200], `${actor} revela el secreto por la ruta canónica`)
    expect(result.body === VAULT_SECRET, `${actor} obtiene el secreto correcto on-demand`)
  }
  for (const actor of ['sales', 'cashier', 'viewer', 'inactive', 'ownerB']) {
    const result = await revealFor(actor)
    expectStatus(result, [401, 403, 404, 200], `${actor} ruta del secreto sin capacidad`)
    denyValue(result, secretNeedles, `${actor} ruta del secreto sin capacidad`)
  }
  const anonReveal = await request(null, '/rpc/reveal_order_device_access', { method: 'POST', body: { p_order_id: ids.order } })
  expectStatus(anonReveal, [401, 403, 404], 'anon ruta del secreto')
  denyValue(anonReveal, secretNeedles, 'anon ruta del secreto')

  // ── 7. Overrides en los dos sentidos ───────────────────────────────────────
  sql(`UPDATE public.profiles SET permissions='{"orders_view_financials":true}'::jsonb WHERE id='${ids.tech}';`)
  const techOverride = await amountsFor('tech')
  expect(techOverride.body?.authorized === true, 'override: default false + override true habilita al tech')
  const techRaw = await request('tech', `/orders?id=eq.${ids.order}&select=id,total_cost`)
  expectStatus(techRaw, [401, 403], 'override: el tech habilitado sigue sin poder leer la tabla cruda')
  denyValue(techRaw, leakNeedles, 'override: tabla cruda con override true')

  sql(`UPDATE public.profiles SET permissions='{"orders_view_financials":false}'::jsonb WHERE id='${ids.manager}';`)
  const managerOverride = await amountsFor('manager')
  expect(managerOverride.body?.authorized === false, 'override: default true + override false deshabilita al manager')
  denyValue(managerOverride, leakNeedles, 'override: manager deshabilitado')

  sql(`UPDATE public.profiles SET permissions='{"device_access_secret":true}'::jsonb WHERE id='${ids.sales}';`)
  const salesReveal = await revealFor('sales')
  expectStatus(salesReveal, [200], 'override: sales habilitado revela el secreto')
  expect(salesReveal.body === VAULT_SECRET, 'override: sales habilitado obtiene el secreto correcto')

  sql(`UPDATE public.profiles SET permissions='{"device_access_secret":false}'::jsonb WHERE id='${ids.tech}';`)
  const techReveal = await revealFor('tech')
  expectStatus(techReveal, [401, 403, 404], 'override: tech deshabilitado ya no revela')
  denyValue(techReveal, secretNeedles, 'override: tech deshabilitado')
  sql(`UPDATE public.profiles SET permissions=NULL WHERE business_id='${ids.A}';`)

  // ── 8. Aislamiento entre tenants ───────────────────────────────────────────
  const foreignSafe = await request('ownerB', `/orders?id=eq.${ids.order}&select=id,status`)
  expectStatus(foreignSafe, [200], 'foreign tenant: consulta operativa')
  expect(Array.isArray(foreignSafe.body) && foreignSafe.body.length === 0, 'foreign tenant: cero filas de otro tenant')
  const foreignAmounts = await amountsFor('ownerB')
  expect(foreignAmounts.body?.error_code === 'FORBIDDEN', 'foreign tenant: la ruta de importes lo rechaza')
  denyValue(foreignAmounts, leakNeedles, 'foreign tenant: ruta de importes')

  // ── 9. El dual-write legacy de Mobile2A sigue vivo ─────────────────────────
  const legacyWrite = await request('admin', `/orders?id=eq.${ids.order}`, {
    method: 'PATCH', body: { device_password: 'pin:5150' }, headers: { Prefer: 'return=minimal' },
  })
  expectStatus(legacyWrite, [200, 204], 'Mobile2A: el shadow legacy sigue siendo escribible')
  expect(sql(`SELECT device_password FROM public.orders WHERE id='${ids.order}'`) === 'pin:5150',
    'Mobile2A: la escritura legacy persistió')
  const afterLegacy = await request('admin', `/orders?id=eq.${ids.order}&select=id,device_password`)
  expectStatus(afterLegacy, [401, 403], 'Mobile2A: escribirlo no lo vuelve legible')

  console.log(`PASS SEC-08A PostgREST real: ${requests} requests, ${checks} aserciones; ningún actor sin capacidad recibió importes ni el secreto (directo, select=*, o relación anidada); rutas canónicas y overrides verificados en ambos sentidos`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  if (seeded) {
    try {
      sql(`
        SET session_replication_role=replica;
        DELETE FROM private.order_device_access_audit WHERE business_id IN ('${ids.A}','${ids.B}');
        DELETE FROM private.order_device_access_secrets WHERE business_id IN ('${ids.A}','${ids.B}');
        DELETE FROM public.status_history WHERE order_id='${ids.order}';
        DELETE FROM public.orders WHERE business_id IN ('${ids.A}','${ids.B}');
        DELETE FROM public.devices WHERE business_id IN ('${ids.A}','${ids.B}');
        DELETE FROM public.customers WHERE business_id IN ('${ids.A}','${ids.B}');
        DELETE FROM public.profiles WHERE business_id IN ('${ids.A}','${ids.B}');
        DELETE FROM public.businesses WHERE id IN ('${ids.A}','${ids.B}');
        DELETE FROM auth.users WHERE id IN (${actorNames.map(n => `'${ids[n]}'`).join(',')});
        SET session_replication_role=origin;
      `)
    } catch (error) {
      console.error(`Limpieza del fixture local fallida: ${error.stderr?.toString() || error.message}`)
      process.exitCode = 1
    }
  }
}
