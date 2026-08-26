#!/usr/bin/env node
// ============================================================================
// P0 FIRST-STEPS-1 — matriz de compatibilidad de rollout (§21).
//
// MIDE por PostgREST, no asume. Las cuatro celdas:
//
//   A. DB nueva + frontend viejo  -> debe PASAR
//   B. frontend nuevo + DB vieja  -> debe FALLAR EXPLICITAMENTE (no en silencio)
//
// Si A pasa y B falla de forma explicita, el orden correcto es DB-FIRST.
//
// Corre contra el stack LOCAL. Aplica la migracion, mide, y la revierte:
// la base local queda como estaba. NO toca produccion.
//
//   node scripts/guards/first-steps-compat-matrix.mjs
// ============================================================================
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { join, resolve } from 'node:path'

const RAIZ = resolve(process.argv[2] ?? '.')
const DB   = 'supabase_db_techrepair-vite'
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'
const MIGRACION = 'supabase/migrations/20260905120000_first_steps_derived.sql'

// ── util ────────────────────────────────────────────────────────────────────
const b64u = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function mintJWT(sub) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64u(JSON.stringify({
    sub, aud: 'authenticated', role: 'authenticated',
    iat: now, exp: now + 3600,
  }))
  const sig = b64u(createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest())
  return `${head}.${body}.${sig}`
}

function psql(sql) {
  const r = spawnSync('docker',
    ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', sql],
    { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`psql fallo: ${r.stderr || r.stdout}`)
  return (r.stdout || '').trim()
}

function leerEnvLocal() {
  const p = join(RAIZ, '.env.development.local')
  if (!existsSync(p)) throw new Error('falta .env.development.local (URL/anon key del stack local)')
  const txt = readFileSync(p, 'utf8')
  const g = k => (txt.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim()
  return { url: g('VITE_SUPABASE_URL'), anon: g('VITE_SUPABASE_ANON_KEY') }
}

const { url: BASE, anon: ANON } = leerEnvLocal()

async function rest(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/rest/v1${path}`, {
    method,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token ?? ANON}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch { /* respuesta vacia */ }
  return { status: res.status, json }
}

// ── seed / limpieza ─────────────────────────────────────────────────────────
const MARCA = 'FS-COMPAT'

function seed() {
  limpiar()
  const out = psql(`
    WITH u AS (
      INSERT INTO auth.users(id, instance_id, aud, role, email, encrypted_password,
                             email_confirmed_at, created_at, updated_at)
      VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
              'authenticated', 'compat@fs.test', '', now(), now(), now())
      RETURNING id
    ), b AS (
      INSERT INTO public.businesses(id, name) VALUES (gen_random_uuid(), '${MARCA}')
      RETURNING id
    ), p AS (
      INSERT INTO public.profiles(id, user_id, business_id, full_name, role, is_active)
      SELECT u.id, u.id, b.id, 'Compat', 'owner', true FROM u, b
      RETURNING user_id
    ), c AS (
      -- SOLO un cliente: el progreso esperado es 1 de 5.
      INSERT INTO public.customers(name, phone, business_id, active, customer_type)
      SELECT 'Compat Cliente', '1130009999', b.id, true, 'minorista' FROM b
      RETURNING id
    )
    SELECT u.id || ' ' || b.id FROM u, b, p, c LIMIT 1;`)
  const [usr, biz] = out.split(' ')
  return { usr, biz }
}

function limpiar() {
  psql(`
    DELETE FROM public.customers  WHERE business_id IN (SELECT id FROM public.businesses WHERE name='${MARCA}');
    DELETE FROM public.profiles   WHERE business_id IN (SELECT id FROM public.businesses WHERE name='${MARCA}');
    DELETE FROM public.businesses WHERE name='${MARCA}';
    DELETE FROM auth.users        WHERE email='compat@fs.test';`)
}

const existeFn = () => psql(`
  SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_my_first_steps';`) !== '0'

function aplicarMigracion() {
  const r = spawnSync('docker', ['cp', join(RAIZ, MIGRACION), `${DB}:/tmp/fs_compat.sql`], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('docker cp: ' + r.stderr)
  const q = spawnSync('docker',
    ['exec', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '/tmp/fs_compat.sql'],
    { encoding: 'utf8' })
  if (q.status !== 0) throw new Error('aplicar migracion: ' + (q.stderr || q.stdout))
}

const revertirMigracion = () => psql('DROP FUNCTION IF EXISTS public.get_my_first_steps();')

/** PostgREST cachea el esquema: sin esto una funcion recien creada da 404. */
const recargarSchema = () => psql("NOTIFY pgrst, 'reload schema';")

// ── consulta EXACTA del frontend VIEJO (OnboardingChecklist) ────────────────
const consultaFrontendViejo = (token, biz) =>
  rest(`/businesses?select=onboarding_completed,created_at&id=eq.${biz}`, { token })

// ── consulta del frontend NUEVO ─────────────────────────────────────────────
const consultaFrontendNuevo = token =>
  rest('/rpc/get_my_first_steps', { token, method: 'POST', body: {} })

// ── main ────────────────────────────────────────────────────────────────────
const filas = []
const anota = (celda, ok, detalle) => {
  filas.push({ celda, ok, detalle })
  console.log(`  ${ok ? 'ok   ' : 'FALLA'} ${celda}\n         ${detalle}`)
}

let fallas = 0
const huboFn = existeFn()

try {
  const { usr, biz } = seed()
  const token = mintJWT(usr)

  console.log(`base:  ${BASE}`)
  console.log(`estado inicial: la funcion ${huboFn ? 'YA EXISTE' : 'NO existe'} en la base local\n`)

  // ── DB VIEJA ──────────────────────────────────────────────────────────────
  if (huboFn) revertirMigracion()
  recargarSchema()
  await new Promise(r => setTimeout(r, 1500))

  console.log('DB VIEJA (sin get_my_first_steps):')
  {
    const r = await consultaFrontendViejo(token, biz)
    anota('DB vieja + frontend viejo (control)',
      r.status === 200 && Array.isArray(r.json) && r.json.length === 1,
      `GET /businesses -> ${r.status}`)
  }
  {
    const r = await consultaFrontendNuevo(token)
    // Debe fallar, y fallar RUIDOSAMENTE: 404 PGRST202 (funcion inexistente).
    const explicito = r.status === 404 && r.json?.code === 'PGRST202'
    anota('B. DB vieja + frontend NUEVO -> falla explicita',
      explicito,
      `POST /rpc/get_my_first_steps -> ${r.status} ${r.json?.code ?? ''} ${(r.json?.message ?? '').slice(0, 90)}`)
  }

  // ── DB NUEVA ──────────────────────────────────────────────────────────────
  aplicarMigracion()
  recargarSchema()
  await new Promise(r => setTimeout(r, 1500))

  console.log('\nDB NUEVA (con get_my_first_steps):')
  {
    const r = await consultaFrontendViejo(token, biz)
    anota('A. DB nueva + frontend VIEJO -> pasa',
      r.status === 200 && Array.isArray(r.json) && r.json.length === 1,
      `GET /businesses -> ${r.status} (la migracion no toca lo que lee el frontend viejo)`)
  }
  {
    const r = await consultaFrontendNuevo(token)
    const fila = Array.isArray(r.json) ? r.json[0] : r.json
    const esperado = fila
      && fila.has_customer === true && fila.has_order === false
      && fila.has_inventory === false && fila.has_cobro === false && fila.has_logo === false
    anota('DB nueva + frontend NUEVO -> 1 de 5',
      r.status === 200 && esperado,
      `POST /rpc/get_my_first_steps -> ${r.status} ${JSON.stringify(fila)}`)
  }
  {
    // anon NO debe poder invocarla ni con el token anonimo.
    const r = await rest('/rpc/get_my_first_steps', { method: 'POST', body: {} })
    anota('DB nueva + anon -> denegado',
      r.status === 401 || r.status === 403 || r.status === 404,
      `POST /rpc (anon) -> ${r.status} ${r.json?.code ?? ''}`)
  }
} finally {
  try { limpiar() } catch (e) { console.error('limpieza:', e.message) }
  try {
    // Deja la base local exactamente como estaba.
    if (!huboFn) revertirMigracion()
    recargarSchema()
  } catch (e) { console.error('revertir:', e.message) }
}

fallas = filas.filter(f => !f.ok).length
console.log('\n─── MATRIZ ──────────────────────────────────────────────────────')
for (const f of filas) console.log(`  ${f.ok ? 'PASS' : 'FAIL'}  ${f.celda}`)

if (fallas) { console.error(`\nMATRIZ: ${fallas} celda(s) inesperada(s).`); process.exit(1) }
console.log('\nMATRIZ OK -> A pasa y B falla explicitamente: ROLLOUT DB-FIRST.')
