#!/usr/bin/env node
// G2-C.3A3 — el saldo y el libro, medidos por HTTP contra el PostgREST LOCAL.
//
// La suite SQL (tests/sql/g2c3a3_inventory_authority_lockdown.test.sql) ya
// ejecuta como `authenticated` con el sub del JWT. Esta prueba agrega el viaje
// real que usa el navegador —PostgREST con un JWT firmado— porque el riesgo de
// cerrar por privilegios de COLUMNA vive justamente ahi: PostgREST arma el
// INSERT/UPDATE con las claves del payload, y un payload de A2 (sin stock) tiene
// que seguir pasando mientras uno con stock muere en el chequeo de permisos.
//
// Cada rechazo tiene al lado su POSITIVO (alta y edicion de metadata, A1, baja
// logica), y cada respuesta se contrasta contra la base: un 4xx que igual
// escribio seria un falso cierre.
//
//   node scripts/security/g2c3a3-postgrest.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')
const dbContainer = process.env.G2C3A3_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base LOCAL (supabase_db_*)')

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
const sql = (q) => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], q).trim()

const ids = Object.fromEntries(['A', 'B', 'owner', 'sales', 'tech', 'ownerB', 'hist', 'plain', 'meta', 'foreign'].map((n) => [n, randomUUID()]))
const TAG = 'g2c3a3-http.invalid'
// Las columnas que pide productService tras el alta (INVENTORY_OPERATIONAL_COLUMNS, sin costo).
const OPS = 'id,code,name,category,stock,stock_quantity,min_stock,sale_price,is_active,business_id'

let seeded = false, checks = 0
const check = (cond, label) => { checks++; assert(cond, label); console.log(`  ✓ ${label}`) }

const main = async () => {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuracion de PostgREST local (¿kong sin puerto publicado?)')

  // A3 tiene que estar aplicada: si no, cada rechazo "pasaria" por la razon equivocada.
  const applied = sql(`SELECT count(*) FROM pg_trigger WHERE tgname IN ('zz_inventory_stock_authority_guard','trg_inventory_movements_append_only');`)
  assert(applied === '2', 'G2-C.3A3 no esta aplicada en la base local')

  const apiUrl = `http://127.0.0.1:${hostPort}/rest/v1`
  let signingKey = Buffer.from(vars.PGRST_JWT_SECRET)
  if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
    const k = JSON.parse(vars.PGRST_JWT_SECRET).keys.find((x) => x.kty === 'oct')
    assert(k?.k, 'Falta la JWK HS256 local'); signingKey = Buffer.from(k.k, 'base64url')
  }
  const token = (actor) => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const claims = actor
      ? { role: 'authenticated', aud: 'authenticated', sub: ids[actor], exp: Math.floor(Date.now() / 1000) + 900 }
      : { role: 'anon', exp: Math.floor(Date.now() / 1000) + 900 }
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
  const stock = (id) => sql(`SELECT stock_quantity || '/' || stock FROM public.inventory WHERE id='${id}';`)
  const movs = (id) => Number(sql(`SELECT count(*) FROM public.inventory_movements WHERE inventory_item_id='${id}';`))
  const huella = () => sql(`SELECT md5(coalesce(string_agg(format('%s:%s:%s', id, stock_quantity, stock), ',' ORDER BY id), '')
                                   || '|' || (SELECT count(*) FROM public.inventory_movements WHERE business_id IN ('${ids.A}','${ids.B}')))
                              FROM public.inventory WHERE business_id IN ('${ids.A}','${ids.B}');`)

  // ── Fixture (como postgres, triggers apagados: es semilla, no el contrato) ──
  sql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users(id, email, email_confirmed_at) VALUES
      ('${ids.owner}','owner@${TAG}',now()), ('${ids.sales}','sales@${TAG}',now()),
      ('${ids.tech}','tech@${TAG}',now()), ('${ids.ownerB}','ownerb@${TAG}',now());
    INSERT INTO public.businesses(id, name, owner_user_id, subscription_plan, subscription_status) VALUES
      ('${ids.A}','A3 HTTP','${ids.owner}','pro','active'), ('${ids.B}','A3 HTTP B','${ids.ownerB}','pro','active');
    INSERT INTO public.profiles(id, business_id, role, is_active, email) VALUES
      ('${ids.owner}','${ids.A}','owner',true,'owner@${TAG}'), ('${ids.sales}','${ids.A}','sales',true,'sales@${TAG}'),
      ('${ids.tech}','${ids.A}','tech',true,'tech@${TAG}'), ('${ids.ownerB}','${ids.B}','owner',true,'ownerb@${TAG}');
    INSERT INTO public.inventory(id, business_id, code, name, category, cost_price, sale_price, stock_quantity, stock, is_active) VALUES
      ('${ids.hist}','${ids.A}','A3H-HIST-${ids.hist.slice(0, 6)}','Con historial','cat',600,1000,10,10,true),
      ('${ids.plain}','${ids.A}','A3H-PLAIN-${ids.plain.slice(0, 6)}','Sin historial','cat',600,1000,10,10,true),
      ('${ids.foreign}','${ids.B}','A3H-FOREIGN-${ids.foreign.slice(0, 6)}','Ajeno','cat',600,1000,40,40,true);
    COMMIT;`)
  seeded = true

  // ── 1. A1 por HTTP: el cliente PIDE, el servidor escribe ─────────────────
  console.log('\n--- 1. A1 por PostgREST (positivo) ---')
  let r = await call('POST', 'sales', '/rpc/apply_inventory_stock_adjustments_atomic', {
    p_business_id: ids.A, p_items: [{ inventory_id: ids.hist, delta: 5 }], p_source: 'manual', p_reason: 'a3 http', p_idempotency_key: `a3-http-${ids.hist}`,
  })
  check(r.status === 200 && r.json?.status === 'created', `sales llama a A1: 200 created (${r.status})`)
  check(stock(ids.hist) === '15/15' && movs(ids.hist) === 1, 'A1: 10 + 5 = 15 (alias 15) con UN movimiento')
  r = await call('POST', 'tech', '/rpc/apply_inventory_stock_adjustments_atomic', {
    p_business_id: ids.A, p_items: [{ inventory_id: ids.plain, delta: 5 }], p_source: 'manual', p_reason: null, p_idempotency_key: `a3-http-tech-${ids.plain}`,
  })
  check(denied(r) && stock(ids.plain) === '10/10', `tech (sin inventory) -> A1 42501 (${r.status} ${r.json?.message})`)

  // ── 2. Saldo por PATCH: 42501 en el chequeo de permisos ───────────────────
  console.log('\n--- 2. PATCH directo del saldo ---')
  let h = huella()
  for (const [who, body] of [['sales', { stock_quantity: 9999 }], ['owner', { stock_quantity: 9999 }], ['owner', { stock: 1 }],
    ['owner', { name: 'colado', stock_quantity: 9999 }], ['sales', { stock_quantity: 15 }]]) {
    r = await call('PATCH', who, `/inventory?id=eq.${ids.hist}`, body)
    check(denied(r), `${who} PATCH ${JSON.stringify(body)} -> ${r.status} 42501`)
  }
  check(huella() === h && stock(ids.hist) === '15/15', 'saldo, alias y libro intactos tras los PATCH rechazados')

  // ── 3. Alta por POST ──────────────────────────────────────────────────────
  console.log('\n--- 3. POST /inventory ---')
  const nuevo = (extra) => ({ business_id: ids.A, name: 'Alta HTTP', code: `A3H-NEW-${randomUUID().slice(0, 8)}`, category: 'cat', cost_price: 0, sale_price: 100, ...extra })
  const n0 = sql(`SELECT count(*) FROM public.inventory WHERE business_id='${ids.A}';`)
  for (const extra of [{ stock_quantity: 50 }, { stock: 50 }, { stock_quantity: 0 }]) {
    r = await call('POST', 'sales', '/inventory', nuevo(extra))
    check(denied(r), `sales POST con ${JSON.stringify(extra)} -> ${r.status} 42501`)
  }
  // Upsert (el import de Excel viejo) tampoco cuela el saldo.
  r = await call('POST', 'owner', '/inventory?on_conflict=id', [{ ...nuevo({ stock_quantity: 77 }), id: ids.plain }], 'resolution=merge-duplicates,return=minimal')
  check(denied(r) && stock(ids.plain) === '10/10', `owner UPSERT con stock_quantity -> ${r.status} 42501, saldo intacto`)
  check(sql(`SELECT count(*) FROM public.inventory WHERE business_id='${ids.A}';`) === n0, 'ningun alta con saldo se creo')

  // Positivo: el payload de A2 (metadata, sin stock) con return=representation.
  r = await call('POST', 'sales', `/inventory?select=${OPS}`, nuevo({ id: ids.meta, min_stock: 2, location: 'Estante', is_active: true }), 'return=representation')
  check(r.status === 201 && r.json?.[0]?.stock_quantity === 0 && r.json?.[0]?.stock === 0,
    `sales POST metadata (payload A2) -> 201 y nace en 0/0 (${r.status} ${r.text.slice(0, 120)})`)
  check(movs(ids.meta) === 0, 'el alta de metadata no escribe movimientos')

  // ── 4. Edicion de metadata y baja logica (positivos) ─────────────────────
  console.log('\n--- 4. PATCH de metadata ---')
  r = await call('PATCH', 'sales', `/inventory?id=eq.${ids.hist}&business_id=eq.${ids.A}`,
    { name: 'Editado HTTP', min_stock: 4, location: 'Deposito', category: 'otra', sale_price: 1500, updated_at: new Date().toISOString() })
  check(r.status === 204 && sql(`SELECT name FROM public.inventory WHERE id='${ids.hist}';`) === 'Editado HTTP',
    `sales PATCH metadata -> ${r.status} y quedo escrita`)
  check(stock(ids.hist) === '15/15' && movs(ids.hist) === 1, 'la edicion de metadata no toco el saldo ni el libro')
  r = await call('PATCH', 'owner', `/inventory?id=eq.${ids.hist}`, { is_active: false })
  check(r.status === 204 && sql(`SELECT is_active FROM public.inventory WHERE id='${ids.hist}';`) === 'f' && movs(ids.hist) === 1,
    `owner baja logica (is_active=false) -> ${r.status}, historial intacto`)

  // ── 5. Libro: sin escritura de la API ─────────────────────────────────────
  console.log('\n--- 5. /inventory_movements ---')
  const mov = sql(`SELECT id FROM public.inventory_movements WHERE inventory_item_id='${ids.hist}';`)
  h = huella()
  r = await call('POST', 'owner', '/inventory_movements', { business_id: ids.A, inventory_item_id: ids.plain, movement_type: 'in', quantity: 5, previous_stock: 10, new_stock: 15 })
  check(denied(r), `owner POST movimiento -> ${r.status} 42501`)
  r = await call('PATCH', 'owner', `/inventory_movements?id=eq.${mov}`, { quantity: 77 })
  check(denied(r), `owner PATCH movimiento -> ${r.status} 42501`)
  r = await call('DELETE', 'owner', `/inventory_movements?id=eq.${mov}`)
  check(denied(r), `owner DELETE movimiento -> ${r.status} 42501`)
  r = await call('GET', 'sales', `/inventory_movements?inventory_item_id=eq.${ids.hist}&select=id,quantity,previous_stock,new_stock,movement_type`)
  check(r.status === 200 && r.json?.length === 1 && r.json[0].quantity === 5, 'la LECTURA del libro sigue igual para sales')
  check(huella() === h, 'el libro no cambio')

  // ── 6. Borrado en duro ────────────────────────────────────────────────────
  console.log('\n--- 6. DELETE /inventory ---')
  r = await call('DELETE', 'owner', `/inventory?id=eq.${ids.hist}`)
  check(r.status === 409 && r.json?.code === '23503' && movs(ids.hist) === 1 && sql(`SELECT count(*) FROM public.inventory WHERE id='${ids.hist}';`) === '1',
    `owner DELETE de un producto con historial -> ${r.status} 23503 (producto e historial intactos)`)
  r = await call('DELETE', 'owner', `/inventory?id=eq.${ids.meta}`)
  check(r.status === 204 && sql(`SELECT count(*) FROM public.inventory WHERE id='${ids.meta}';`) === '0',
    `owner DELETE de un producto SIN historial -> ${r.status} (compatible: rollback de alta de A2)`)

  // ── 7. anon y tenant ajeno ────────────────────────────────────────────────
  console.log('\n--- 7. anon y tenant ---')
  h = huella()
  r = await call('PATCH', null, `/inventory?id=eq.${ids.plain}`, { stock_quantity: 1 })
  check(denied(r), `anon PATCH saldo -> ${r.status} 42501`)
  r = await call('POST', null, '/inventory_movements', { business_id: ids.A, inventory_item_id: ids.plain, movement_type: 'in', quantity: 1, previous_stock: 0, new_stock: 1 })
  check(denied(r), `anon POST movimiento -> ${r.status} 42501`)
  r = await call('PATCH', 'owner', `/inventory?id=eq.${ids.foreign}`, { name: 'robado' })
  check(r.status === 204 && sql(`SELECT name FROM public.inventory WHERE id='${ids.foreign}';`) === 'Ajeno', 'owner A no edita el producto de B (0 filas)')
  check(huella() === h, 'nada cambio')

  console.log(`\nG2-C.3A3 PostgREST OK · ${checks} verificaciones`)
}

const cleanup = () => {
  if (!seeded) return
  try {
    sql(`
      BEGIN;
      SET LOCAL session_replication_role = replica;
      DELETE FROM private.inventory_stock_adjustment_requests WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.inventory_movements WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.inventory WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.profiles WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.businesses WHERE id IN ('${ids.A}','${ids.B}');
      DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
      COMMIT;`)
  } catch (e) { console.error('cleanup:', e.message) }
}

main().then(cleanup, (e) => { cleanup(); console.error(`\nFALLO: ${e.message}`); process.exit(1) })
