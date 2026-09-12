#!/usr/bin/env node
// ============================================================================
// FISCAL DATE Parte 2 — HARD GATE de resolución de firma en PostgREST
//
//   node scripts/fiscal-date-part2/postgrest-signature-gate.mjs
//
// El gate declarado por el owner: si un PostgREST local NO puede resolver la
// llamada de 7 argumentos contra la función nueva de 8 (con p_fecha_cbte
// DEFAULT NULL), hay que PARAR. Un Edge viejo conviviendo con la DB nueva
// durante el rollout manda exactamente esa llamada, y si no resuelve, cada
// comprobante autorizado en esa ventana pierde su completado fiscal.
//
// Se mide por HTTP real contra Kong→PostgREST, no con psql: lo único que vale
// es si el request cruza la red y resuelve. psql resolvería igual aunque
// PostgREST tuviera el esquema cacheado viejo.
//
// FASES
//   1. PRE  (DB con la función vieja de 7 args)
//      1a. payload de 7 args  -> 200  (línea base del arnés)
//      1b. payload de 8 args  -> 404 PGRST202, y se captura el error EXACTO
//          que valida isLegacyCompleteSignatureError() del Edge.
//   2. Aplicar la migración candidata (LOCAL) + recargar el esquema.
//   3. POST (DB con la función nueva de 8 args)
//      3a. payload de 7 args  -> 200  ← EL HARD GATE (Edge viejo + DB nueva)
//      3b. payload de 8 args  -> 200  (Edge nuevo + DB nueva)
//      3c. un solo overload en pg_proc: la resolución es inequívoca
//      3d. persistencia end-to-end: la fecha llega a la columna por HTTP
//      3e. argumento desconocido -> 404: PostgREST es estricto, o sea que
//          3a no resuelve "por tolerancia".
//   4. Restaurar la base local a su estado exacto previo (finally).
//
// NO toca producción: sólo el contenedor de Supabase local.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const MIGRATION = 'supabase/migrations/20260927120000_fiscal_date_part2.sql'
const SEVEN = 'public.complete_arca_attempt(uuid,text,text,timestamptz,text,text,text)'
const EIGHT = 'public.complete_arca_attempt(uuid,text,text,timestamptz,text,text,text,text)'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')
const dbContainer = process.env.FDP2_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base LOCAL')

const docker = (args, input) => execFileSync('docker', args,
  { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
const sql = q => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
  '-Atq', '-v', 'ON_ERROR_STOP=1'], q).trim()

let checks = 0
const check = (cond, label) => { assert(cond, `FAIL: ${label}`); checks++; console.log(`  PASS  ${label}`) }

// ── Conexión al PostgREST local ─────────────────────────────────────────────
const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
const vars = Object.fromEntries(rest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuración de PostgREST local')

let signingKey = Buffer.from(vars.PGRST_JWT_SECRET)
if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
  const k = JSON.parse(vars.PGRST_JWT_SECRET).keys.find(x => x.kty === 'oct')
  assert(k?.k, 'Falta la JWK HS256 local')
  signingKey = Buffer.from(k.k, 'base64url')
}
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const serviceToken = (() => {
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    role: 'service_role', iss: 'supabase',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  })}`
  return `${body}.${createHmac('sha256', signingKey).update(body).digest('base64url')}`
})()

const apiUrl = `http://127.0.0.1:${hostPort}/rest/v1`
const rpc = async (payload) => {
  const res = await fetch(`${apiUrl}/rpc/complete_arca_attempt`, {
    method: 'POST',
    headers: {
      apikey: serviceToken,
      Authorization: `Bearer ${serviceToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* respuesta no-JSON */ }
  return { status: res.status, json, text }
}

/** Espera a que PostgREST recargue su caché de esquema (NOTIFY es asíncrono). */
const reloadSchema = async (expectFechaCbte) => {
  for (let i = 0; i < 40; i++) {
    sql("NOTIFY pgrst, 'reload schema';")
    await new Promise(r => setTimeout(r, 250))
    const probe = await rpc({ p_attempt_id: randomUUID(), p_status: 'authorized', p_fecha_cbte: '20260911' })
    const resolves = probe.status !== 404
    if (resolves === expectFechaCbte) return true
  }
  return false
}

const legacyPayload = (attemptId, cae) => ({
  p_attempt_id: attemptId, p_status: 'authorized', p_cae: cae,
  p_cae_vencimiento: null, p_resultado: 'A', p_observaciones: null, p_error_mensaje: null,
})

// ── Estado previo, capturado para poder restaurar EXACTO ────────────────────
const before = {
  def: sql(`SELECT pg_get_functiondef('${SEVEN}'::regprocedure);`),
  md5: sql(`SELECT md5(prosrc) FROM pg_proc WHERE oid = '${SEVEN}'::regprocedure;`),
  acl: sql(`SELECT coalesce(proacl::text,'') FROM pg_proc WHERE oid = '${SEVEN}'::regprocedure;`),
  owner: sql(`SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = '${SEVEN}'::regprocedure;`),
}
assert(before.def.includes('complete_arca_attempt'), 'No se pudo capturar la definición previa')
assert(!before.def.includes('p_fecha_cbte'), 'La base local YA tiene la migración aplicada: restaurala antes de correr el gate')

console.log(`[gate] proyecto        : ${project}`)
console.log(`[gate] PostgREST       : ${apiUrl}`)
console.log(`[gate] md5 previo      : ${before.md5}`)
console.log(`[gate] ACL previa      : ${before.acl}`)

const seed = { biz: randomUUID(), comp: randomUUID(), att: randomUUID() }
let applied = false
let legacyError = null

try {
  // ── FASE 1 — PRE ──────────────────────────────────────────────────────────
  console.log('\n[gate] FASE 1 — base con la función VIEJA de 7 argumentos')

  const pre7 = await rpc(legacyPayload(randomUUID(), 'GATE-PRE-7'))
  check(pre7.status === 200, `1a payload de 7 args resuelve contra la función vieja (HTTP ${pre7.status})`)

  const pre8 = await rpc({ ...legacyPayload(randomUUID(), 'GATE-PRE-8'), p_fecha_cbte: '20260911' })
  check(pre8.status === 404, `1b payload de 8 args NO resuelve contra la función vieja (HTTP ${pre8.status})`)
  check(pre8.json?.code === 'PGRST202', `1c el código es PGRST202 (fue ${JSON.stringify(pre8.json?.code)})`)
  check(typeof pre8.json?.message === 'string' && pre8.json.message.includes('complete_arca_attempt'),
    '1d el mensaje nombra complete_arca_attempt')
  legacyError = pre8.json
  console.log(`  ↳ error que el Edge debe reconocer: ${JSON.stringify(legacyError)}`)

  // ── FASE 2 — aplicar la migración (LOCAL) ─────────────────────────────────
  console.log('\n[gate] FASE 2 — aplicando la migración candidata en la base LOCAL')
  docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-f', '-'], readFileSync(MIGRATION, 'utf8'))
  applied = true
  check(sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='complete_arca_attempt';`) === '1',
    '2a tras aplicar hay exactamente una complete_arca_attempt')
  check(await reloadSchema(true), '2b PostgREST recargó el esquema y ve la identidad nueva')

  // ── FASE 3 — POST ─────────────────────────────────────────────────────────
  console.log('\n[gate] FASE 3 — base con la función NUEVA de 8 argumentos')

  const post7 = await rpc(legacyPayload(randomUUID(), 'GATE-POST-7'))
  check(post7.status === 200,
    `3a HARD GATE: el payload LEGACY de 7 args resuelve contra la función de 8 (HTTP ${post7.status}) — Edge viejo + DB nueva es seguro`)
  check(post7.json?.success === false && /no encontrado/i.test(post7.json?.error ?? ''),
    '3b y entró REALMENTE a la función (responde su contrato, no un error de ruteo)')

  const post8 = await rpc({ ...legacyPayload(randomUUID(), 'GATE-POST-8'), p_fecha_cbte: '20260911' })
  check(post8.status === 200, `3c el payload de 8 args resuelve (HTTP ${post8.status})`)

  check(sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='complete_arca_attempt';`) === '1',
    '3d un solo overload: PostgREST no puede elegir mal')

  // 3e — persistencia end-to-end por HTTP, con datos propios
  sql(`
    INSERT INTO businesses(id, name) VALUES ('${seed.biz}', 'FDP2 gate');
    INSERT INTO comprobantes(id, business_id, tipo, numero, punto_venta, fecha,
                             subtotal, impuestos, total, estado, estado_fiscal)
      VALUES ('${seed.comp}', '${seed.biz}', 'factura_c', '99999999', '0010', now(),
              1000, 0, 1000, 'borrador', 'pendiente_emision');
    INSERT INTO arca_emission_attempts(id, comprobante_id, business_id, correlation_id,
                                       ambiente, cuit_emisor, punto_venta, tipo_comprobante,
                                       numero_intentado, status, started_at, sent_at)
      VALUES ('${seed.att}', '${seed.comp}', '${seed.biz}', 'fdp2-gate', 'produccion',
              '20999999999', 10, 11, 99999999, 'sent', now(), now());
  `)
  const e2e = await rpc({ ...legacyPayload(seed.att, 'GATE-E2E'), p_fecha_cbte: '20260911' })
  check(e2e.status === 200 && e2e.json?.success === true, '3e el completado end-to-end por HTTP funciona')
  check(e2e.json?.fiscal_date_status === 'persisted', '3f fiscal_date_status=persisted vuelve por la red')
  check(sql(`SELECT fecha_comprobante_fiscal::text FROM comprobantes WHERE id='${seed.comp}';`) === '2026-09-11',
    '3g la fecha fiscal EXACTA quedó en la columna, escrita vía PostgREST')
  check(sql(`SELECT cae FROM comprobantes WHERE id='${seed.comp}';`) === 'GATE-E2E', '3h y el CAE también')

  const unknown = await rpc({ ...legacyPayload(randomUUID(), 'GATE-UNK'), p_argumento_inexistente: 'x' })
  check(unknown.status === 404,
    `3i control: un argumento DESCONOCIDO sí es rechazado (HTTP ${unknown.status}) — 3a no pasó por tolerancia`)

  console.log(`\n[gate] HARD GATE SUPERADO — ${checks} verificaciones`)
} finally {
  // ── FASE 4 — restaurar la base local a su estado exacto previo ────────────
  console.log('\n[gate] FASE 4 — restaurando la base local')
  try {
    sql(`
      DELETE FROM arca_emission_attempts WHERE id = '${seed.att}';
      DELETE FROM comprobantes WHERE id = '${seed.comp}';
      DELETE FROM businesses WHERE id = '${seed.biz}';
    `)
  } catch (e) { console.error('[gate] aviso limpiando el fixture:', e.message) }

  if (applied) {
    try {
      sql(`
        BEGIN;
        DROP FUNCTION IF EXISTS ${EIGHT};
        ${before.def};
        ALTER FUNCTION ${SEVEN} OWNER TO ${before.owner};
        REVOKE ALL ON FUNCTION ${SEVEN} FROM PUBLIC;
        REVOKE EXECUTE ON FUNCTION ${SEVEN} FROM anon;
        REVOKE EXECUTE ON FUNCTION ${SEVEN} FROM authenticated;
        GRANT EXECUTE ON FUNCTION ${SEVEN} TO service_role;
        DROP TRIGGER IF EXISTS trg_comprobante_fiscal_date_immutable ON public.comprobantes;
        DROP FUNCTION IF EXISTS public.comprobante_fiscal_date_immutable();
        DROP FUNCTION IF EXISTS public.arca_parse_cbte_fch(text);
        ALTER TABLE public.comprobantes DROP COLUMN IF EXISTS fecha_comprobante_fiscal;
        NOTIFY pgrst, 'reload schema';
        COMMIT;
      `)
      const after = {
        md5: sql(`SELECT md5(prosrc) FROM pg_proc WHERE oid = '${SEVEN}'::regprocedure;`),
        acl: sql(`SELECT coalesce(proacl::text,'') FROM pg_proc WHERE oid = '${SEVEN}'::regprocedure;`),
        col: sql(`SELECT exists(SELECT 1 FROM information_schema.columns
                                 WHERE table_schema='public' AND table_name='comprobantes'
                                   AND column_name='fecha_comprobante_fiscal')::text;`),
      }
      const ok = after.md5 === before.md5 && after.acl === before.acl && after.col === 'false'
      console.log(`[gate] restaurado: md5 ${after.md5}${after.md5 === before.md5 ? ' (idéntico)' : ' ¡DISTINTO!'}`)
      console.log(`[gate] restaurado: ACL ${after.acl === before.acl ? 'idéntica' : `¡DISTINTA! ${after.acl}`}`)
      console.log(`[gate] restaurado: columna fiscal presente = ${after.col}`)
      if (!ok) {
        console.error('[gate] LA RESTAURACIÓN NO COINCIDE CON EL ESTADO PREVIO — revisar la base local a mano')
        process.exitCode = 1
      }
    } catch (e) {
      console.error('[gate] FALLÓ LA RESTAURACIÓN — la base local quedó migrada:', e.message)
      process.exitCode = 1
    }
  } else {
    console.log('[gate] la migración no se aplicó: no hay nada que restaurar')
  }
}
