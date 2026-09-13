#!/usr/bin/env node
// ARCA SELF-SERVICE · PHASE 1 — read model de estado contra PostgREST LOCAL, JWT firmados localmente.
//
// Prueba por HTTP lo que el SQL prueba por claims: quién puede leer el estado, que
// el tenant sale de la identidad, que can_manage coincide con la autoridad canónica,
// que la respuesta no trae material y que leer no escribe nada.
//
//   node scripts/security/arca-phase1-postgrest.mjs
//
// Siembra fixtures propios (UUID aleatorios, certificado SINTÉTICO de
// tests/sql/arca_phase1_status.test.sql) y los borra al final pase lo que pase.
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

const fixtureSql = readFileSync('tests/sql/arca_phase1_status.test.sql', 'utf8')
const CERT = fixtureSql.match(/\('cert_old', \$p\$([\s\S]*?)\$p\$\)/)?.[1]
const FP = fixtureSql.match(/\('fp_old', '([0-9a-f]{64})'\)/)?.[1]
assert(CERT && FP, 'no se encontró el certificado sintético del test SQL')

const actors = {
  owner: ['A', 'owner', true, null, true],
  admin: ['A', 'admin', true, null, true],
  admin_no: ['A', 'admin', true, { settings_sensitive: false }, false],
  manager_yes: ['A', 'manager', true, { settings_sensitive: true }, false],
  tech: ['A', 'tech', true, null, false],
  cashier: ['A', 'cashier', true, null, false],
  viewer: ['A', 'viewer', true, null, false],
  owner_inactive: ['A', 'owner', false, null, null],
  admin_inactive: ['A', 'admin', false, null, null],
  ownerB: ['B', 'owner', true, null, true],
  ownerF: ['F', 'owner', true, null, false],
}
const ids = Object.fromEntries(['A', 'B', 'F', ...Object.keys(actors)].map((n) => [n, randomUUID()]))
const FORBIDDEN = ['cert_file', 'private_key', 'wsaa_token', 'wsaa_sign', 'secret_id', 'csr_pem', 'certificate_pem',
  'fingerprint', 'ultimo_error', 'estado_conexion', 'pfx', 'BEGIN CERTIFICATE', 'TOKEN-P1-HTTP', 'SIGN-P1-HTTP',
  'ERROR-P1-HTTP', 'CSR-P1-HTTP', FP.slice(0, 16)]
const CONTRACT_KEYS = ['alias', 'attention', 'available', 'can_manage', 'certificate', 'configured', 'connection',
  'contract_version', 'credential', 'cuit', 'environment', 'next_action', 'punto_venta', 'razon_social', 'setup', 'status']

let seeded = false
let requests = 0
let checks = 0
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
  const status = async (actor, body = {}, { role = 'authenticated', method = 'POST' } = {}) => {
    requests++
    const bearer = actor ? token(actor, role) : role === 'service_role' ? token(null, 'service_role') : anonKey
    const qs = method === 'GET' && body.p_business_id ? `?p_business_id=${body.p_business_id}` : ''
    const response = await fetch(`${api}/rpc/get_arca_selfservice_status${qs}`, {
      method,
      headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${bearer}`, 'x-techrepair-client-contract': '1' },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    })
    const text = await response.text()
    let parsed = text
    try { parsed = text ? JSON.parse(text) : null } catch { /* texto */ }
    return { status: response.status, body: parsed, text }
  }
  const expect = (condition, label, detail = '') => { checks++; assert(condition, `${label}${detail ? ` — ${detail}` : ''}`) }
  const noMaterial = (text, label) => {
    for (const f of FORBIDDEN) expect(!text.includes(f), `${label}: la respuesta no contiene «${f}»`)
  }
  const worldHash = () => sql(`SELECT md5(
    coalesce((SELECT string_agg(t::text, '|' ORDER BY t::text) FROM public.arca_config t), '') ||
    coalesce((SELECT string_agg(t::text, '|' ORDER BY t::text) FROM private.arca_private_key_credentials t), '') ||
    coalesce((SELECT string_agg(t::text, '|' ORDER BY t::text) FROM private.arca_credential_rotations t), '') ||
    (SELECT count(*) FROM vault.secrets)::text || (SELECT count(*) FROM private.arca_credential_audit)::text);`)

  // ── Fixture ──────────────────────────────────────────────────────────────
  const users = Object.keys(actors).map((n) => `('${ids[n]}','${n}@arca-p1-http.invalid',now())`).join(',')
  const profiles = Object.entries(actors).map(([n, [biz, role, active, perms]]) =>
    `('${ids[n]}','${ids[n]}','${ids[biz]}','${role}',${active},${perms ? `'${JSON.stringify(perms)}'::jsonb` : 'NULL'},'${n}@arca-p1-http.invalid')`).join(',')
  sql(`
    BEGIN;
    SET session_replication_role = replica;
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status) VALUES
      ('${ids.A}','ARCA P1 HTTP A','${ids.owner}','pro','active'),
      ('${ids.B}','ARCA P1 HTTP B','${ids.ownerB}','pro','active'),
      ('${ids.F}','ARCA P1 HTTP F','${ids.ownerF}','basico','active');
    INSERT INTO public.profiles (id, user_id, business_id, role, is_active, permissions, email) VALUES ${profiles};
    INSERT INTO public.arca_config (business_id, cuit, cuit_emisor, razon_social, ambiente, punto_venta, web_service, alias,
      cert_file, wsaa_token, wsaa_sign, wsaa_token_expires, estado_conexion, ultima_sincronizacion, ultimo_error, expires_at) VALUES
      ('${ids.A}', '20111111112', '20111111112', 'Razon A', 'produccion', 10, 'wsfe', 'fixture.alias',
       $cert$${CERT}$cert$, 'TOKEN-P1-HTTP', 'SIGN-P1-HTTP', now() + interval '6 hours', 'conectado', now(), 'ERROR-P1-HTTP', '2099-01-01'),
      ('${ids.B}', '20444444445', '20444444445', NULL, 'homologacion', 4, 'wsfe', 'alias-b',
       NULL, NULL, NULL, NULL, 'desconectado', NULL, NULL, NULL),
      ('${ids.F}', '20777777778', '20777777778', NULL, 'produccion', 7, 'wsfe', 'alias-f',
       NULL, NULL, NULL, NULL, 'desconectado', NULL, NULL, NULL);
    INSERT INTO private.arca_private_key_credentials (business_id, private_key_secret_id, private_key_fingerprint, credential_status, created_at, rotated_at)
      VALUES ('${ids.A}', vault.create_secret('KEY-P1-HTTP', 'arca-p1-http:${ids.A}'), '${FP}', 'active', now() - interval '1 day', now() - interval '1 day');
    INSERT INTO private.arca_credential_rotations (business_id, private_key_secret_id, private_key_fingerprint, csr_fingerprint,
      csr_pem, key_size, state, idempotency_key, request_hash, prev_status)
      VALUES ('${ids.A}', gen_random_uuid(), repeat('cd', 32), repeat('cd', 32), '-----BEGIN CERTIFICATE REQUEST-----CSR-P1-HTTP',
        2048, 'completed', 'p1-http', 'h', 'purged');
    SET session_replication_role = origin;
    COMMIT;
  `)
  seeded = true
  const before = worldHash()

  // ── 1. anon y service_role no leen ───────────────────────────────────────
  for (const [who, opts] of [['anon', {}], ['service_role', { role: 'service_role' }]]) {
    const r = await status(null, { p_business_id: ids.A }, opts)
    expect([401, 403].includes(r.status), `${who}: get_arca_selfservice_status denegado`, `${r.status} ${r.text.slice(0, 160)}`)
    noMaterial(r.text, who)
  }

  // ── 2. matriz de lectura + can_manage (POST y GET, con y sin confirmación) ─
  for (const [actor, [biz, , active, , canManage]] of Object.entries(actors)) {
    for (const body of [{}, { p_business_id: ids[biz] }]) {
      for (const method of ['POST', 'GET']) {
        const r = await status(actor, body, { method })
        const label = `${actor} ${method}${body.p_business_id ? ' +tenant' : ''}`
        if (!active) {
          expect(r.status === 403 && /FORBIDDEN/.test(r.text), `${label}: perfil inactivo no lee`, `${r.status} ${r.text.slice(0, 160)}`)
          continue
        }
        expect(r.status === 200, `${label}: 200`, `${r.status} ${r.text.slice(0, 200)}`)
        expect(JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(CONTRACT_KEYS), `${label}: claves exactas del contrato`, Object.keys(r.body).join(','))
        expect(r.body.can_manage === canManage, `${label}: can_manage = ${canManage}`, String(r.body.can_manage))
        noMaterial(r.text, label)
        if (biz === 'A') {
          expect(r.body.status === 'connected' && r.body.configured === true && r.body.next_action === 'none'
            && r.body.setup.state === 'completed' && r.body.certificate.renewal_state === 'healthy'
            && r.body.certificate.expires_at?.startsWith('2035-01-01') && r.body.punto_venta === 10,
          `${label}: A conectado, completed/purged no en curso, vencimiento del X.509`, r.text.slice(0, 300))
        }
        if (biz === 'B') expect(r.body.status === 'not_configured' && r.body.next_action === 'start_setup' && r.body.cuit === '20444444445', `${label}: B no configurado`, r.text)
        if (biz === 'F') expect(r.body.available === false && r.body.cuit === null && r.body.punto_venta === null, `${label}: F sin feature arca, sin metadata`, r.text)
      }
    }
  }

  // ── 3. cross-tenant: el body no es autoridad ─────────────────────────────
  for (const [actor, foreign] of [['ownerB', 'A'], ['tech', 'B'], ['owner', 'B'], ['owner', 'F']]) {
    const r = await status(actor, { p_business_id: ids[foreign] })
    expect(r.status === 403 && /FORBIDDEN/.test(r.text), `${actor} pide ${foreign}: FORBIDDEN`, `${r.status} ${r.text.slice(0, 160)}`)
    noMaterial(r.text, `${actor}→${foreign}`)
  }
  const bad = await status('owner', { p_business_id: 'no-es-uuid' })
  expect(bad.status >= 400 && bad.status < 500, 'p_business_id malformado → 4xx', String(bad.status))

  // ── 4. la derivación privada no es alcanzable por la API ─────────────────
  for (const actor of ['owner', null]) {
    requests++
    const r = await fetch(`${api}/rpc/arca_selfservice_status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${actor ? token(actor) : anonKey}`, 'x-techrepair-client-contract': '1' },
      body: JSON.stringify({ p_business_id: ids.A, p_actor: ids.owner, p_now: new Date().toISOString() }),
    })
    expect([401, 403, 404].includes(r.status), `${actor ?? 'anon'}: private.arca_selfservice_status no expuesta`, String(r.status))
  }

  // ── 5. solo lectura ──────────────────────────────────────────────────────
  expect(worldHash() === before, 'arca_config/credenciales/rotaciones/Vault/auditoría idénticos tras todas las lecturas')

  console.log(`✅ ARCA Phase 1 PostgREST: ${checks} aserciones, ${requests} requests, 0 fallas.`)
} catch (error) {
  console.error(`❌ ARCA Phase 1 PostgREST falló tras ${checks} aserciones:`, error?.message ?? error)
  process.exitCode = 1
} finally {
  if (seeded) {
    const list = (keys) => keys.map((k) => `'${ids[k]}'`).join(',')
    sql(`
      BEGIN;
      SET session_replication_role = replica;
      DELETE FROM vault.secrets WHERE id IN (SELECT private_key_secret_id FROM private.arca_private_key_credentials WHERE business_id = '${ids.A}');
      DELETE FROM private.arca_credential_rotations WHERE business_id IN (${list(['A', 'B', 'F'])});
      DELETE FROM private.arca_private_key_credentials WHERE business_id IN (${list(['A', 'B', 'F'])});
      DELETE FROM private.arca_credential_audit WHERE business_id IN (${list(['A', 'B', 'F'])});
      DELETE FROM public.arca_config WHERE business_id IN (${list(['A', 'B', 'F'])});
      DELETE FROM public.profiles WHERE id IN (${list(Object.keys(actors))});
      DELETE FROM public.businesses WHERE id IN (${list(['A', 'B', 'F'])});
      DELETE FROM auth.users WHERE id IN (${list(Object.keys(actors))});
      SET session_replication_role = origin;
      COMMIT;
    `)
    const left = sql(`SELECT (SELECT count(*) FROM auth.users WHERE email LIKE '%@arca-p1-http.invalid') + (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-p1-http:%');`)
    if (left !== '0') { console.error(`❌ limpieza incompleta: ${left} residuos de fixture`); process.exitCode = 1 }
  }
}
