#!/usr/bin/env node
// PRE-BETA-1 — public.users medido por HTTP contra el PostgREST LOCAL.
//
// public.users es una tabla legacy GLOBAL (sin business_id) con nombre, email,
// rol y telefono. Su policy de SELECT era USING (true) y las de escritura solo
// miraban el rol owner/admin (en CUALQUIER negocio). La migracion
// 20261010120000_prebeta1_public_users_api_retirement.sql la saca de la API.
//
// Dos modos, el MISMO fixture y las MISMAS rutas HTTP:
//   --baseline  control negativo sobre current main SIN el candidato: cada
//               check es un hueco reproducido (lectura/UPDATE/DELETE/INSERT
//               cross-tenant, y el embed technician:users que usaba el front).
//   (default)   contrato post-fix: toda ruta a public.users -> 42501 para anon,
//               authenticated (tenant A y B) y service_role, sin escribir nada;
//               y los flujos vivos (listado de miembros por business_users_view,
//               lecturas de ordenes que manda el front) siguen respondiendo y
//               aislados por negocio.
//
// Cada rechazo se contrasta contra la base (huella md5): un 4xx que igual
// escribio seria un falso cierre.
//
//   node scripts/security/prebeta1-users-postgrest.mjs [--baseline]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const BASELINE = process.argv.includes('--baseline')
const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')
const dbContainer = process.env.PREBETA1_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base LOCAL (supabase_db_*)')

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
const sql = (q) => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], q).trim()

const ids = Object.fromEntries(['A', 'B', 'ownerA', 'adminA', 'techA', 'salesA', 'ownerB', 'techB', 'LA', 'LB', 'orderA', 'orderB', 'custA', 'custB']
  .map((n) => [n, randomUUID()]))
const TAG = 'prebeta1-http.invalid'
// Las mismas columnas que piden api.ts / useOrderSimple (SEC-08A: sin `*`).
const ORDER_COLS = 'id,business_id,customer_id,device_id,technician_id,assigned_profile_id,created_by,comprobante_id,status,priority,notes,access_mode,created_at,updated_at,completed_at'

let seeded = false, checks = 0
const check = (cond, label) => { checks++; assert(cond, label); console.log(`  ✓ ${label}`) }

const main = async () => {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuracion de PostgREST local (¿kong sin puerto publicado?)')

  // El modo tiene que coincidir con el estado de la base: si no, cada check
  // "pasaria" por la razon equivocada.
  const policies = sql(`SELECT count(*) FROM pg_policy WHERE polrelid = 'public.users'::regclass;`)
  const apiGrants = sql(`SELECT count(*) FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.users'::regclass AND a.grantee <> c.relowner;`)
  if (BASELINE) assert(policies === '4' && apiGrants !== '0', 'Modo --baseline: la base ya tiene PRE-BETA-1 aplicada (el control negativo no probaria nada)')
  else assert(policies === '0' && apiGrants === '0', 'PRE-BETA-1 no esta aplicada en la base local')

  const apiUrl = `http://127.0.0.1:${hostPort}/rest/v1`
  let signingKey = Buffer.from(vars.PGRST_JWT_SECRET)
  if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
    const k = JSON.parse(vars.PGRST_JWT_SECRET).keys.find((x) => x.kty === 'oct')
    assert(k?.k, 'Falta la JWK HS256 local'); signingKey = Buffer.from(k.k, 'base64url')
  }
  const token = (actor) => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const exp = Math.floor(Date.now() / 1000) + 900
    const claims = actor === 'service_role' ? { role: 'service_role', exp }
      : actor ? { role: 'authenticated', aud: 'authenticated', sub: ids[actor], exp }
        : { role: 'anon', exp }
    const c = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${h}.${c}.${createHmac('sha256', signingKey).update(`${h}.${c}`).digest('base64url')}`
  }
  const call = async (method, actor, path, body, prefer = 'return=minimal') => {
    const r = await fetch(apiUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json', Prefer: prefer, 'x-techrepair-client-contract': '1',
        apikey: token(null), Authorization: `Bearer ${token(actor)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const text = await r.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* texto plano */ }
    return { status: r.status, text, json }
  }
  const denied = (r) => r.status >= 400 && r.json?.code === '42501'
  // pg_graphql (/graphql/v1) es la otra superficie de la API sobre las mismas tablas.
  const gql = async (actor, query) => {
    const r = await fetch(`http://127.0.0.1:${hostPort}/graphql/v1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-techrepair-client-contract': '1',
        apikey: token(null), Authorization: `Bearer ${token(actor)}`,
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15000),
    })
    return { status: r.status, json: await r.json() }
  }
  const sinCampo = (r, campo) => r.json?.data == null && r.json?.errors?.some((e) => e.message?.includes(`Unknown field "${campo}"`))
  const huella = () => sql(`SELECT md5(coalesce(string_agg(format('%s|%s|%s|%s|%s|%s|%s', id, name, email, role, phone, active, created_by), ',' ORDER BY id), '')) FROM public.users;`)
  const fila = (k) => sql(`SELECT coalesce((SELECT format('%s|%s|%s|%s', name, role, phone, active) FROM public.users WHERE id='${ids[k]}'), '<borrada>');`)

  // ── Fixture (como postgres, triggers apagados: es semilla, no el contrato) ──
  sql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users(id, email, email_confirmed_at) VALUES
      ('${ids.ownerA}','owner-a@${TAG}',now()), ('${ids.adminA}','admin-a@${TAG}',now()),
      ('${ids.techA}','tech-a@${TAG}',now()), ('${ids.salesA}','sales-a@${TAG}',now()),
      ('${ids.ownerB}','owner-b@${TAG}',now()), ('${ids.techB}','tech-b@${TAG}',now());
    INSERT INTO public.businesses(id, name, owner_user_id, subscription_plan, subscription_status) VALUES
      ('${ids.A}','PB1 HTTP A','${ids.ownerA}','pro','active'), ('${ids.B}','PB1 HTTP B','${ids.ownerB}','pro','active');
    INSERT INTO public.profiles(id, business_id, role, is_active, email) VALUES
      ('${ids.ownerA}','${ids.A}','owner',true,'owner-a@${TAG}'), ('${ids.adminA}','${ids.A}','admin',true,'admin-a@${TAG}'),
      ('${ids.techA}','${ids.A}','tech',true,'tech-a@${TAG}'), ('${ids.salesA}','${ids.A}','sales',true,'sales-a@${TAG}'),
      ('${ids.ownerB}','${ids.B}','owner',true,'owner-b@${TAG}'), ('${ids.techB}','${ids.B}','tech',true,'tech-b@${TAG}');
    INSERT INTO public.users(id, name, email, role, phone, active, created_by) VALUES
      ('${ids.LA}','Tecnico de A','legacy-a@${TAG}','technician','+54 11 0000-000A',true,'${ids.ownerA}'),
      ('${ids.LB}','Tecnico de B','legacy-b@${TAG}','technician','+54 11 0000-000B',true,'${ids.ownerB}');
    INSERT INTO public.customers(id, business_id, name, phone) VALUES
      ('${ids.custA}','${ids.A}','Cliente A','1'), ('${ids.custB}','${ids.B}','Cliente B','2');
    INSERT INTO public.orders(id, business_id, customer_id, status, technician_id, assigned_profile_id, updated_at) VALUES
      ('${ids.orderA}','${ids.A}','${ids.custA}','completed',${BASELINE ? `'${ids.LA}'` : 'NULL'},'${ids.techA}',now()),
      ('${ids.orderB}','${ids.B}','${ids.custB}','completed',NULL,'${ids.techB}',now());
    COMMIT;`)
  seeded = true

  // ── Flujo moderno de miembros (business_users_view sobre profiles) ─────────
  // Se mide igual en los dos modos: el fix no lo toca y tiene que dar lo mismo.
  const miembros = async () => {
    console.log('\n--- Miembros por business_users_view (profiles, RLS por negocio) ---')
    for (const [actor, propio, ajeno, nPropio] of [['ownerA', 'A', 'B', 4], ['adminA', 'A', 'B', 4], ['ownerB', 'B', 'A', 2]]) {
      let r = await call('GET', actor, `/business_users_view?select=id,business_id,role&business_id=eq.${ids[propio]}`)
      check(r.status === 200 && r.json?.length === nPropio && r.json.every((m) => m.business_id === ids[propio]),
        `${actor} lista los ${nPropio} miembros de su negocio (${r.status}, ${r.json?.length})`)
      r = await call('GET', actor, `/business_users_view?select=id&business_id=eq.${ids[ajeno]}`)
      check(r.status === 200 && r.json?.length === 0, `${actor} NO ve miembros del negocio ${ajeno} (${r.status}, ${r.json?.length})`)
    }
    for (const actor of ['techA', 'salesA']) {
      const r = await call('GET', actor, `/business_users_view?select=id,business_id&business_id=in.(${ids.A},${ids.B})`)
      check(r.status === 200 && r.json.every((m) => m.business_id === ids.A),
        `${actor}: visibilidad de miembros acotada a su negocio (${r.json?.length} filas, 0 de B)`)
    }
  }

  if (BASELINE) {
    console.log('\n=== PRE-BETA-1 · CONTROL NEGATIVO (current main, sin el candidato) ===')
    console.log('\n--- 1. Lectura cross-tenant ---')
    let r = await call('GET', 'techA', `/users?select=id,name,email,phone&id=eq.${ids.LB}`)
    check(r.status === 200 && r.json?.[0]?.email === `legacy-b@${TAG}` && r.json[0].phone === '+54 11 0000-000B',
      `BYPASS: tech de A lee email y telefono de la fila de B (${r.status})`)
    r = await call('GET', 'ownerB', `/users?select=id&id=in.(${ids.LA},${ids.LB})`)
    check(r.status === 200 && r.json?.length === 2, `BYPASS: owner de B lista las filas de A y de B (${r.json?.length})`)
    const g = await gql('techA', `{ usersCollection(filter: {id: {eq: "${ids.LB}"}}) { edges { node { email phone } } } }`)
    check(g.json?.data?.usersCollection?.edges?.[0]?.node?.email === `legacy-b@${TAG}`,
      `BYPASS: tech de A lee la fila de B tambien por GraphQL (usersCollection)`)
    r = await call('GET', 'ownerA', `/orders?select=id,technician:users(name,email,phone)&id=eq.${ids.orderA}`)
    check(r.status === 200 && r.json?.[0]?.technician?.email === `legacy-a@${TAG}`,
      `ruta del front: embed technician:users(...) responde 200 hoy (${r.status})`)

    console.log('\n--- 2. Escritura cross-tenant ---')
    r = await call('PATCH', 'ownerA', `/users?id=eq.${ids.LB}`, { phone: 'pisado-por-A' })
    check(r.status === 204 && fila('LB').endsWith('|pisado-por-A|t'), `BYPASS: owner de A PATCH fila de B -> ${r.status} y quedo escrito`)
    r = await call('PATCH', 'adminA', `/users?id=eq.${ids.LB}`, { role: 'admin' })
    check(r.status === 204 && fila('LB').includes('|admin|'), `BYPASS: admin de A cambia el role de la fila de B -> ${r.status}`)
    r = await call('PATCH', 'ownerB', `/users?id=eq.${ids.LA}`, { active: false })
    check(r.status === 204 && fila('LA').endsWith('|f'), `BYPASS: owner de B desactiva la fila de A -> ${r.status}`)
    r = await call('POST', 'ownerA', '/users', { name: 'Arbitrario', email: `arbitrario@${TAG}`, role: 'admin' })
    check(r.status === 201 && sql(`SELECT count(*) FROM public.users WHERE email='arbitrario@${TAG}';`) === '1',
      `BYPASS: owner de A inserta una fila arbitraria -> ${r.status}`)
    r = await call('DELETE', 'ownerA', `/users?id=eq.${ids.LB}`)
    check(r.status === 204 && fila('LB') === '<borrada>', `BYPASS: owner de A DELETE fila de B -> ${r.status} y desaparecio`)

    console.log('\n--- 3. Contexto ---')
    r = await call('GET', null, '/users?select=id')
    check(r.status === 200 && r.json?.length === 0, `anon: 200 [] (solo por falta de policy TO anon; el GRANT existe) (${r.status})`)
    r = await call('GET', 'service_role', '/users?select=id')
    check(denied(r), `service_role: ${r.status} 42501 (ya sin privilegios hoy)`)

    await miembros()
    console.log(`\nPRE-BETA-1 CONTROL NEGATIVO OK · bypass reproducido · ${checks} verificaciones`)
    return
  }

  console.log('\n=== PRE-BETA-1 · contrato post-fix ===')
  const h0 = huella()
  const intento = async (actor, method, path, body, label) => {
    const r = await call(method, actor, path, body)
    check(denied(r), `${label} -> ${r.status} 42501`)
  }
  const nueva = (who) => ({ name: `Arbitraria ${who}`, email: `arb-${who}-${randomUUID().slice(0, 6)}@${TAG}`, role: 'admin' })

  for (const [tenant, owner, admin, tech, propia, ajena] of [
    ['A', 'ownerA', 'adminA', 'techA', 'LA', 'LB'],
    ['B', 'ownerB', null, 'techB', 'LB', 'LA'],
  ]) {
    console.log(`\n--- Tenant ${tenant} ---`)
    await intento(tech, 'GET', `/users?select=id,name,email,phone&id=eq.${ids[ajena]}`, undefined, `${tech} lee la fila ajena`)
    await intento(owner, 'GET', '/users?select=id,email', undefined, `${owner} lista la tabla global`)
    await intento(owner, 'GET', `/users?select=id&id=eq.${ids[propia]}`, undefined, `${owner} lee "su" fila`)
    await intento(owner, 'PATCH', `/users?id=eq.${ids[ajena]}`, { phone: `pisado-por-${tenant}` }, `${owner} UPDATE fila ajena`)
    if (admin) await intento(admin, 'PATCH', `/users?id=eq.${ids[ajena]}`, { role: 'admin' }, `${admin} UPDATE role de la fila ajena`)
    await intento(owner, 'DELETE', `/users?id=eq.${ids[ajena]}`, undefined, `${owner} DELETE fila ajena`)
    await intento(owner, 'POST', '/users', nueva(owner), `${owner} INSERT fila arbitraria`)
    await intento(owner, 'POST', '/users?on_conflict=id', { ...nueva(owner), id: ids[ajena] }, `${owner} UPSERT sobre la fila ajena`)
    await intento(owner, 'GET', `/orders?select=id,technician:users(name,email,phone)&business_id=eq.${ids[tenant]}`, undefined,
      `${owner} embed technician:users desde orders`)
  }

  console.log('\n--- anon ---')
  for (const [m, p, b] of [['GET', '/users?select=id', undefined], ['POST', '/users', nueva('anon')],
    ['PATCH', `/users?id=eq.${ids.LA}`, { phone: 'anon' }], ['DELETE', `/users?id=eq.${ids.LA}`, undefined]]) {
    await intento(null, m, p, b, `anon ${m} /users`)
  }

  console.log('\n--- service_role (contrato explicito: sin acceso) ---')
  for (const [m, p, b] of [['GET', '/users?select=id', undefined], ['POST', '/users', nueva('svc')],
    ['PATCH', `/users?id=eq.${ids.LA}`, { phone: 'svc' }], ['DELETE', `/users?id=eq.${ids.LA}`, undefined]]) {
    await intento('service_role', m, p, b, `service_role ${m} /users`)
  }
  console.log('\n--- GraphQL (pg_graphql) ---')
  for (const actor of ['ownerA', 'adminA', 'techA', 'ownerB', null, 'service_role']) {
    const quien = actor ?? 'anon'
    let g = await gql(actor, `{ usersCollection(first: 5) { edges { node { id email phone } } } }`)
    check(sinCampo(g, 'usersCollection'), `${quien}: GraphQL usersCollection no existe en su esquema`)
    g = await gql(actor, `mutation { deleteFromusersCollection(filter: {id: {eq: "${ids.LB}"}}, atMost: 1) { affectedCount } }`)
    check(sinCampo(g, 'deleteFromusersCollection'), `${quien}: GraphQL deleteFromusersCollection no existe`)
  }

  check(huella() === h0 && fila('LA') === 'Tecnico de A|technician|+54 11 0000-000A|t' && fila('LB') === 'Tecnico de B|technician|+54 11 0000-000B|t',
    'public.users intacta tras todos los rechazos (huella md5 identica)')

  console.log('\n--- Lecturas de ordenes que manda el front (sin embed de users) ---')
  // Reports.tsx (ordenes completadas del periodo)
  let r = await call('GET', 'ownerA', `/orders?select=updated_at&business_id=eq.${ids.A}&status=eq.completed`)
  check(r.status === 200 && r.json?.length === 1, `Reports: orders?select=updated_at -> ${r.status}, 1 orden de A`)
  r = await call('GET', 'ownerA', `/orders?select=updated_at&business_id=eq.${ids.B}&status=eq.completed`)
  check(r.status === 200 && r.json?.length === 0, 'Reports: owner A no ve ordenes completadas de B')
  // api.ts ordersService.getAll / getById
  r = await call('GET', 'ownerA', `/orders?select=${ORDER_COLS},customer:customers(id,name,phone,email),device:devices(id,brand,model,type)&business_id=eq.${ids.A}`)
  check(r.status === 200 && r.json?.length === 1 && r.json[0].customer?.name === 'Cliente A', `ordersService.getAll -> ${r.status}`)
  r = await call('GET', 'ownerA', `/orders?select=${ORDER_COLS},customer:customers(*),device:devices(*),notes(*),status_history(*)&id=eq.${ids.orderA}`)
  check(r.status === 200 && r.json?.[0]?.id === ids.orderA, `ordersService.getById -> ${r.status}`)
  // useOrderSimple (OrderDetail) — la orden sigue cargando; el tecnico legacy ya no se consulta.
  r = await call('GET', 'techA', `/orders?select=${ORDER_COLS}&id=eq.${ids.orderA}`)
  check(r.status === 200 && r.json?.[0]?.technician_id === null && r.json[0].assigned_profile_id === ids.techA,
    `useOrderSimple: la orden carga (technician_id NULL, assigned_profile_id intacto) -> ${r.status}`)
  r = await call('GET', 'ownerA', `/orders?select=id&id=eq.${ids.orderB}`)
  check(r.status === 200 && r.json?.length === 0, 'owner A no ve la orden de B')

  await miembros()
  console.log(`\nPRE-BETA-1 PostgREST OK · ${checks} verificaciones`)
}

const cleanup = () => {
  if (!seeded) return
  try {
    sql(`
      BEGIN;
      SET LOCAL session_replication_role = replica;
      DELETE FROM public.orders WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.customers WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.users WHERE email LIKE '%@${TAG}';
      DELETE FROM public.profiles WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.businesses WHERE id IN ('${ids.A}','${ids.B}');
      DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
      COMMIT;`)
  } catch (e) { console.error('cleanup:', e.message) }
}

main().then(cleanup, (e) => { cleanup(); console.error(`\nFALLO: ${e.message}`); process.exit(1) })
