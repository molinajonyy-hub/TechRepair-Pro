#!/usr/bin/env node
// ARCA SELF-SERVICE · PHASE 0 — matriz real contra PostgREST LOCAL, JWT firmados localmente.
//
// Lo que cruza la red es el contrato: los REVOKE, las RPC retiradas y la autoridad
// canónica se prueban por HTTP, no sólo en SQL. Cada negación comprueba además que
// la fila de arca_config quedó byte-idéntica (la escritura no ocurrió).
//
//   node scripts/security/arca-phase0-postgrest.mjs
//
// Siembra fixtures propios (UUID aleatorios) y los borra al final pase lo que pase.
// Nunca apunta a producción: sólo contenedores supabase_*_<project_id> locales.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')
const dbContainer = `supabase_db_${project}`

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
const sql = (query) => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], query).trim()

const actors = {
  owner: ['A', 'owner', true, null],
  admin: ['A', 'admin', true, null],
  admin_no: ['A', 'admin', true, { settings_sensitive: false }],
  manager_yes: ['A', 'manager', true, { settings_sensitive: true }],
  tech: ['A', 'tech', true, null],
  sales: ['A', 'sales', true, null],
  cashier: ['A', 'cashier', true, null],
  viewer: ['A', 'viewer', true, null],
  owner_inactive: ['A', 'owner', false, null],
  admin_inactive: ['A', 'admin', false, null],
  ownerB: ['B', 'owner', true, null],
  ownerC: ['C', 'owner', true, null],
}
const ids = Object.fromEntries(['A', 'B', 'C', ...Object.keys(actors)].map((n) => [n, randomUUID()]))
const CERT_C = '-----BEGIN CERTIFICATE-----ARCA-P0-HTTP-CENTINELA'
const ATTACK_CERT = '-----BEGIN CERTIFICATE-----ATAQUE-HTTP'

let seeded = false
let requests = 0
let checks = 0
const results = []
const failures = []
try {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuración de PostgREST local')
  const api = `http://127.0.0.1:${hostPort}/rest/v1`
  let signingKey = Buffer.from(vars.PGRST_JWT_SECRET)
  if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
    const key = JSON.parse(vars.PGRST_JWT_SECRET).keys.find((k) => k.kty === 'oct')
    signingKey = Buffer.from(key.k, 'base64url')
  }
  const token = (actor, role = 'authenticated') => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const claims = { role, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 }
    if (actor) claims.sub = ids[actor]
    const c = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${h}.${c}.${createHmac('sha256', signingKey).update(`${h}.${c}`).digest('base64url')}`
  }
  const anonKey = token(null, 'anon')
  const request = async (actor, path, { method = 'GET', body, role = 'authenticated', headers = {} } = {}) => {
    requests++
    const bearer = actor ? token(actor, role) : role === 'service_role' ? token(null, 'service_role') : anonKey
    const response = await fetch(api + path, {
      method,
      // Mismo protocolo que el cliente oficial (src/lib/clientContract.ts): sin el
      // header el gate SEC-08E corta con 409 antes de llegar a los privilegios.
      headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${bearer}`, 'x-techrepair-client-contract': '1', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    })
    const text = await response.text()
    let parsed = text
    try { parsed = text ? JSON.parse(text) : null } catch { /* texto */ }
    return { status: response.status, body: parsed, text }
  }
  // ARCA_P0_NEGATIVE_CONTROL=1: no corta en la primera falla; cuenta cuántas
  // aserciones fallan contra una base SIN Phase 0 (control del control).
  const negativeControl = process.env.ARCA_P0_NEGATIVE_CONTROL === '1'
  const expect = (condition, label, detail = '') => {
    checks++
    if (negativeControl) {
      if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
      return
    }
    assert(condition, `${label}${detail ? ` — ${detail}` : ''}`)
    results.push(label)
  }
  const configRow = (biz) => sql(`SELECT coalesce((SELECT t::text FROM public.arca_config t WHERE business_id = '${ids[biz]}'), '<none>');`)

  // ── Fixture ────────────────────────────────────────────────────────────────
  const users = Object.keys(actors).map((n) => `('${ids[n]}','${n}@arca-p0-http.invalid',now())`).join(',')
  const profiles = Object.entries(actors).map(([n, [biz, role, active, perms]]) =>
    `('${ids[n]}','${ids[n]}','${ids[biz]}','${role}',${active},${perms ? `'${JSON.stringify(perms)}'::jsonb` : 'NULL'},'${n}@arca-p0-http.invalid')`).join(',')
  sql(`
    BEGIN;
    SET session_replication_role = replica;
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status) VALUES
      ('${ids.A}','ARCA P0 HTTP A','${ids.owner}','pro','active'),
      ('${ids.B}','ARCA P0 HTTP B','${ids.ownerB}','pro','active'),
      ('${ids.C}','ARCA P0 HTTP C','${ids.ownerC}','pro','active');
    INSERT INTO public.profiles (id, user_id, business_id, role, is_active, permissions, email) VALUES ${profiles};
    INSERT INTO public.arca_config (business_id, cuit, cuit_emisor, ambiente, punto_venta, web_service, alias,
      cert_file, wsaa_token, wsaa_sign, wsaa_token_expires, estado_conexion, expires_at)
      VALUES ('${ids.C}', '20111111112', '20111111112', 'produccion', 5, 'wsfe', 'alias-c',
      '${CERT_C}', 'TOKEN-C', 'SIGN-C', now() + interval '6 hours', 'conectado', '2028-07-25 23:58:12+00');
    SET session_replication_role = origin;
    COMMIT;
  `)
  seeded = true

  // ── 1. Escritura directa de tabla: anon y cada rol autenticado ─────────────
  const beforeC = configRow('C')
  for (const actor of [null, ...Object.keys(actors)]) {
    const who = actor ?? 'anon'
    const ins = await request(actor, '/arca_config', { method: 'POST', body: { business_id: ids.A, cuit_emisor: '20666666667', punto_venta: 1 }, headers: { Prefer: 'return=minimal' } })
    expect([401, 403].includes(ins.status), `${who}: INSERT directo a arca_config denegado`, `${ins.status} ${ins.text.slice(0, 160)}`)
    const upd = await request(actor, `/arca_config?business_id=eq.${ids.C}`, { method: 'PATCH', body: { cert_file: ATTACK_CERT }, headers: { Prefer: 'return=minimal' } })
    expect([401, 403].includes(upd.status), `${who}: PATCH directo a arca_config denegado`, `${upd.status} ${upd.text.slice(0, 160)}`)
    const del = await request(actor, `/arca_config?business_id=eq.${ids.C}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } })
    expect([401, 403].includes(del.status), `${who}: DELETE directo a arca_config denegado`, `${del.status} ${del.text.slice(0, 160)}`)
    const sel = await request(actor, `/arca_config?business_id=eq.${ids.C}&select=cert_file,wsaa_token`)
    expect([401, 403].includes(sel.status) && !sel.text.includes('CENTINELA') && !sel.text.includes('TOKEN-C'), `${who}: SELECT directo sin material`, `${sel.status}`)
  }
  expect(configRow('A') === '<none>', 'ningún INSERT directo creó configuración para A')
  expect(configRow('C') === beforeC, 'arca_config de C byte-idéntica tras las escrituras denegadas')

  // ── 2. RPC retiradas: nadie las ejecuta ────────────────────────────────────
  for (const actor of [null, 'owner', 'admin', 'ownerC']) {
    const who = actor ?? 'anon'
    const cert = await request(actor, '/rpc/save_arca_certificate_legacy', { method: 'POST', body: { p_business_id: ids.C, p_cert_file: ATTACK_CERT } })
    expect([401, 403, 404].includes(cert.status), `${who}: save_arca_certificate_legacy no ejecutable`, `${cert.status} ${cert.text.slice(0, 160)}`)
    const estado = await request(actor, '/rpc/set_arca_estado_conexion', { method: 'POST', body: { p_business_id: ids.C, p_estado: 'error', p_error: 'x' } })
    expect([401, 403, 404].includes(estado.status), `${who}: set_arca_estado_conexion no ejecutable`, `${estado.status} ${estado.text.slice(0, 160)}`)
  }
  expect(configRow('C') === beforeC, 'las RPC retiradas no modificaron la configuración vigente')

  // ── 3. Autoridad canónica por HTTP (save_arca_config_legacy) ───────────────
  const save = (actor, biz, fields) => request(actor, '/rpc/save_arca_config_legacy', {
    method: 'POST',
    body: { p_business_id: ids[biz], p_cuit: null, p_razon_social: null, p_ambiente: null, p_punto_venta: null, p_web_service: null, p_alias: null, p_expires_at: null, ...fields },
  })
  for (const actor of ['admin_no', 'manager_yes', 'tech', 'sales', 'cashier', 'viewer', 'owner_inactive', 'admin_inactive']) {
    const r = await save(actor, 'A', { p_punto_venta: 3 })
    expect(r.status === 403 && /FORBIDDEN/.test(r.text), `${actor}: save_arca_config_legacy → 403 FORBIDDEN`, `${r.status} ${r.text.slice(0, 160)}`)
  }
  const anonSave = await save(null, 'A', { p_punto_venta: 3 })
  expect([401, 403, 404].includes(anonSave.status), 'anon: save_arca_config_legacy no ejecutable', `${anonSave.status}`)
  const cross = await save('ownerB', 'A', { p_punto_venta: 3 })
  expect(cross.status === 403, 'ownerB → negocio A: 403 (tenant por identidad)', `${cross.status}`)
  expect(configRow('A') === '<none>', 'ningún actor no autorizado creó configuración')

  const ownerAlta = await save('owner', 'A', { p_cuit: '20-22222222-3', p_ambiente: 'homologacion', p_punto_venta: 7, p_alias: 'alias-a' })
  expect(ownerAlta.status === 200, 'owner: alta de configuración sin identidad vigente', `${ownerAlta.status} ${ownerAlta.text.slice(0, 160)}`)
  const adminEdit = await save('admin', 'A', { p_punto_venta: 8 })
  expect(adminEdit.status === 200, 'admin con settings_sensitive: edita PV', `${adminEdit.status}`)

  // ── 4. Identidad bloqueada con certificado vigente (C) ─────────────────────
  for (const [field, value] of [['p_cuit', '20999999990'], ['p_ambiente', 'homologacion'], ['p_alias', 'otro'], ['p_expires_at', '2031-01-01T00:00:00Z'], ['p_web_service', 'wsbfe']]) {
    const r = await save('ownerC', 'C', { [field]: value })
    expect(r.status === 403 && /ARCA_FIELD_LOCKED/.test(r.text), `ownerC: ${field} bloqueado con certificado vigente`, `${r.status} ${r.text.slice(0, 160)}`)
  }
  expect(configRow('C') === beforeC, 'los intentos bloqueados no cambiaron la configuración vigente')
  const pv = await save('ownerC', 'C', { p_punto_venta: 9, p_razon_social: 'Razon C' })
  expect(pv.status === 200, 'ownerC: PV y razón social siguen editables', `${pv.status} ${pv.text.slice(0, 160)}`)
  const afterC = sql(`SELECT cert_file || '|' || wsaa_token || '|' || wsaa_sign || '|' || estado_conexion || '|' || expires_at || '|' || cuit || '|' || alias || '|' || ambiente || '|' || punto_venta FROM public.arca_config WHERE business_id = '${ids.C}';`)
  expect(afterC === `${CERT_C}|TOKEN-C|SIGN-C|conectado|2028-07-25 23:58:12+00|20111111112|alias-c|produccion|9`, 'cert/token/sign/estado/expires/identidad intactos; PV aplicado', afterC)

  // ── 5. Read model intacto ──────────────────────────────────────────────────
  const safe = await request('ownerC', '/rpc/get_arca_config_safe', { method: 'POST', body: { p_business_id: ids.C } })
  expect(safe.status === 200 && safe.body?.configured === true && safe.body?.punto_venta === 9 && safe.body?.has_certificate === true, 'get_arca_config_safe sigue sirviendo el estado', `${safe.status} ${safe.text.slice(0, 200)}`)
  expect(!safe.text.includes('CENTINELA') && !safe.text.includes('TOKEN-C'), 'get_arca_config_safe no filtra material')

  // ── 6. Autoridad de los Edge de gestión (service_role → is_business_owner_or_admin) ──
  const matrix = { owner: true, admin: true, admin_no: false, manager_yes: false, tech: false, sales: false, cashier: false, viewer: false, owner_inactive: false, admin_inactive: false, ownerB: false }
  for (const [actor, want] of Object.entries(matrix)) {
    const r = await request(null, '/rpc/is_business_owner_or_admin', { method: 'POST', role: 'service_role', body: { p_business_id: ids.A, p_user_id: ids[actor] } })
    expect(r.status === 200 && r.body === want, `Edge authority: ${actor} en A → ${want}`, `${r.status} ${r.text}`)
  }
  for (const actor of ['owner', null]) {
    const r = await request(actor, '/rpc/is_business_owner_or_admin', { method: 'POST', body: { p_business_id: ids.A, p_user_id: ids.owner } })
    expect([401, 403, 404].includes(r.status), `${actor ?? 'anon'}: is_business_owner_or_admin no ejecutable fuera de service_role`, `${r.status}`)
  }

  // ── 7. service_role sigue escribiendo el cache WSAA (afip-wsaa) ────────────
  const cache = await request(null, `/arca_config?business_id=eq.${ids.C}`, { method: 'PATCH', role: 'service_role', body: { wsaa_token: 'TOKEN-NUEVO', estado_conexion: 'conectado' }, headers: { Prefer: 'return=minimal' } })
  expect([200, 204].includes(cache.status), 'service_role: PATCH del cache WSAA permitido', `${cache.status} ${cache.text.slice(0, 160)}`)
  expect(sql(`SELECT wsaa_token FROM public.arca_config WHERE business_id = '${ids.C}';`) === 'TOKEN-NUEVO', 'el cache WSAA quedó escrito')

  if (negativeControl) {
    console.log(`CONTROL NEGATIVO: ${failures.length} de ${checks} aserciones fallan sin Phase 0.`)
    for (const f of failures) console.log('  · ' + f)
    if (failures.length === 0) { console.error('❌ el control negativo no detectó nada'); process.exitCode = 1 }
  } else {
    console.log(`✅ ARCA Phase 0 PostgREST: ${checks} aserciones, ${requests} requests, 0 fallas.`)
  }
} catch (error) {
  console.error(`❌ ARCA Phase 0 PostgREST falló tras ${checks} aserciones:`, error?.message ?? error)
  process.exitCode = 1
} finally {
  if (seeded) {
    const list = (keys) => keys.map((k) => `'${ids[k]}'`).join(',')
    sql(`
      BEGIN;
      SET session_replication_role = replica;
      DELETE FROM private.arca_credential_audit WHERE business_id IN (${list(['A', 'B', 'C'])});
      DELETE FROM public.arca_config WHERE business_id IN (${list(['A', 'B', 'C'])});
      DELETE FROM public.profiles WHERE id IN (${list(Object.keys(actors))});
      DELETE FROM public.businesses WHERE id IN (${list(['A', 'B', 'C'])});
      DELETE FROM auth.users WHERE id IN (${list(Object.keys(actors))});
      SET session_replication_role = origin;
      COMMIT;
    `)
    const left = sql(`SELECT count(*) FROM auth.users WHERE email LIKE '%@arca-p0-http.invalid';`)
    if (left !== '0') { console.error(`❌ limpieza incompleta: ${left} usuarios de fixture`); process.exitCode = 1 }
  }
}
