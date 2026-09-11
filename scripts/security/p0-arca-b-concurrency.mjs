// P0-ARCA-B — REAL concurrency proof (two PostgreSQL sessions) + rollback proof.
//
// Local Docker stack only (supabase_db_techrepair-vite). Steps:
//   0. capture the exact current claim function (pg_get_functiondef) and require
//      that the release RPC does NOT exist (candidate not applied yet);
//   1. apply migration 20260926120000 (committed, local only);
//   2. committed fixture with its own ids, series PV 911 / CUIT 20111111113;
//   3. C1  a transition wins the row lock: while session H holds the stale claim
//          FOR UPDATE and turns it into number_reserved, a concurrent cross-
//          comprobante recovery must re-check its guard and NOT abandon it;
//      C2  two comprobantes recover the same stale claim at the same time: exactly
//          one acquires, the other gets serie_ocupada, one live attempt;
//      C3  same-comprobante recovery racing a reservation: never abandoned;
//   4. always: delete the fixture; run docs/p0-arca-b/rollback.sql and require the
//      claim function to be byte-identical to the PRODUCTION definition (read-only
//      fingerprint below) with the release RPC gone; finally put back the exact
//      local pre-run definition so the local DB ends as it started.
//
// Run from the repo root: node scripts/security/p0-arca-b-concurrency.mjs
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CONTAINER = 'supabase_db_techrepair-vite'
const PSQL = ['exec', '-i', CONTAINER, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1']
const MIGRATION = 'supabase/migrations/20260926120000_p0_arca_presend_claim_recovery.sql'
const ROLLBACK = 'docs/p0-arca-b/rollback.sql'
// md5(prosrc)|proconfig of production's claim_comprobante_arca_emission, read-only,
// 2026-09-10 (project vrdxxmjzxhfgqlnxmbwx). The rollback must reproduce it exactly.
const PRODUCTION_CLAIM_FINGERPRINT = 'b86e1b51f15a40879ab800808a4f8bf4|search_path=public, pg_temp'

const BIZ = '00000000-0000-0000-0000-0000009c0101'
const OWN = '00000000-0000-0000-0000-0000009c0109'
const C = ['00000000-0000-0000-0000-0000009c0c01', '00000000-0000-0000-0000-0000009c0c02', '00000000-0000-0000-0000-0000009c0c03']

const psql = (sql) => execFileSync('docker', PSQL, { input: sql, encoding: 'utf8' }).trim()
const psqlAsync = (sql) => new Promise((resolve, reject) => {
  const p = spawn('docker', PSQL)
  let out = ''
  let err = ''
  p.stdout.on('data', (d) => { out += d })
  p.stderr.on('data', (d) => { err += d })
  p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `psql exit ${code}`))))
  p.stdin.end(sql)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (cond, label) => {
  results.push({ ok: !!cond, label })
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}: ${label}\n`)
}
const fingerprint = () => psql(`SELECT md5(prosrc) || '|' || array_to_string(proconfig, ';')
  FROM pg_proc WHERE oid = 'public.claim_comprobante_arca_emission(uuid,text)'::regprocedure;`)
const releaseExists = () => psql(`SELECT to_regprocedure('public.release_arca_presend_claim(uuid,text)') IS NOT NULL;`) === 't'

const claimSql = (comp, corr) => `BEGIN;
SELECT set_config('request.jwt.claim.sub', '${OWN}', true);
SELECT set_config('request.jwt.claims', '{"sub":"${OWN}","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT 'RESULT=' || public.claim_comprobante_arca_emission('${comp}', '${corr}')::text;
COMMIT;`
const resultOf = (out) => JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT=')).slice(7))

function seed(comp, status, numero, sent, age) {
  return psql(`SET session_replication_role = 'replica';
DELETE FROM public.arca_emission_attempts WHERE business_id = '${BIZ}';
INSERT INTO public.arca_emission_attempts (comprobante_id, business_id, correlation_id, ambiente, cuit_emisor,
  punto_venta, tipo_comprobante, status, numero_intentado, sent_at, started_at, updated_at)
VALUES ('${comp}', '${BIZ}', 'seed', 'homologacion', '20111111113', 911, 11, '${status}', ${numero ?? 'NULL'},
  ${sent ? `now() - interval '${age}'` : 'NULL'}, now() - interval '${age}', now() - interval '${age}')
RETURNING id;`).split('\n').pop()
}
const row = (id) => psql(`SELECT status || '|' || coalesce(numero_intentado::text, '-') FROM public.arca_emission_attempts WHERE id = '${id}';`)
const live = () => Number(psql(`SELECT count(*) FROM public.arca_emission_attempts WHERE business_id = '${BIZ}'
  AND status IN ('claimed','number_reserved','sent','pending_reconciliation');`))

// A session that holds the attempt row lock for `holdSeconds`, then optionally moves it.
const holder = (id, holdSeconds, updateSql) => psqlAsync(`BEGIN;
SELECT id FROM public.arca_emission_attempts WHERE id = '${id}' FOR UPDATE;
SELECT pg_sleep(${holdSeconds});
${updateSql ?? ''}
COMMIT;`)

let baselineFingerprint = null
let baselineDefinition = null
let applied = false
try {
  // 0. Baseline (the complete CREATE statement, so it can be put back verbatim)
  if (releaseExists()) throw new Error('release_arca_presend_claim already exists locally: refusing (candidate already applied?)')
  baselineFingerprint = fingerprint()
  baselineDefinition = psql(`SELECT pg_get_functiondef('public.claim_comprobante_arca_emission(uuid,text)'::regprocedure);`)
  check(baselineDefinition.startsWith('CREATE OR REPLACE FUNCTION public.claim_comprobante_arca_emission'), 'baseline definition captured')

  // 1. Candidate migration (committed, local)
  psql(readFileSync(MIGRATION, 'utf8'))
  applied = true
  check(releaseExists() && fingerprint() !== baselineFingerprint, 'candidate migration applied locally')

  // 2. Fixture
  psql(`SET session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES ('${OWN}');
INSERT INTO public.businesses(id, name, owner_user_id) VALUES ('${BIZ}', 'P0 ARCA B concurrency', '${OWN}');
INSERT INTO public.profiles(business_id, user_id, role, is_active) VALUES ('${BIZ}', '${OWN}', 'owner', true);
INSERT INTO public.arca_config(business_id, cuit, cuit_emisor, punto_venta, ambiente)
  VALUES ('${BIZ}', '20111111113', '20111111113', 911, 'homologacion');
INSERT INTO public.comprobantes(id, business_id, tipo, subtotal, impuestos, total, estado_fiscal) VALUES
  ('${C[0]}', '${BIZ}', 'factura_c', 100, 0, 100, 'pendiente_emision'),
  ('${C[1]}', '${BIZ}', 'factura_c', 100, 0, 100, 'pendiente_emision'),
  ('${C[2]}', '${BIZ}', 'factura_c', 100, 0, 100, 'pendiente_emision');`)

  // C1 — a concurrent reservation wins: the recovery must re-check and step back.
  {
    const s = seed(C[0], 'claimed', null, false, '11 minutes')
    const h = holder(s, 2, `UPDATE public.arca_emission_attempts SET status = 'number_reserved', numero_intentado = 7, updated_at = now() WHERE id = '${s}';`)
    await sleep(700)
    const r = resultOf(await psqlAsync(claimSql(C[1], 'race-1')))
    await h
    check(r.result === 'serie_ocupada', `C1 cross-comprobante recovery re-checked the guard after the lock -> ${r.result}`)
    check(row(s) === 'number_reserved|7' && live() === 1, 'C1b the concurrently reserved attempt is intact; one live attempt')
  }

  // C2 — two recoverers at once on the same stale claim.
  {
    const s = seed(C[0], 'claimed', null, false, '11 minutes')
    const h = holder(s, 1.5)                     // both recoverers block on the same row lock
    await sleep(500)
    const [a, b] = await Promise.all([psqlAsync(claimSql(C[1], 'race-2a')), psqlAsync(claimSql(C[2], 'race-2b'))])
    await h
    const outcomes = [resultOf(a).result, resultOf(b).result].sort()
    check(JSON.stringify(outcomes) === JSON.stringify(['acquired', 'serie_ocupada']), `C2 exactly one recoverer acquires -> ${outcomes.join(',')}`)
    check(row(s).startsWith('abandoned|') && live() === 1, 'C2b stale claim abandoned once; one live attempt in the series')
  }

  // C3 — same-comprobante recovery racing a reservation of that same attempt.
  {
    const s = seed(C[0], 'claimed', null, false, '11 minutes')
    const h = holder(s, 2, `UPDATE public.arca_emission_attempts SET status = 'number_reserved', numero_intentado = 8, updated_at = now() WHERE id = '${s}';`)
    await sleep(700)
    const r = resultOf(await psqlAsync(claimSql(C[0], 'race-3')))
    await h
    check(r.result === 'already_in_progress', `C3 same-comprobante recovery re-checked the guard -> ${r.result}`)
    check(row(s) === 'number_reserved|8' && live() === 1, 'C3b reserved attempt intact; one live attempt')
  }
} catch (e) {
  check(false, `runner error: ${String(e.message || e).split('\n')[0]}`)
} finally {
  // 4. Cleanup + rollback proof + local restoration (always)
  try {
    psql(`SET session_replication_role = 'replica';
DELETE FROM public.arca_emission_attempts WHERE business_id = '${BIZ}';
DELETE FROM public.comprobantes WHERE business_id = '${BIZ}';
DELETE FROM public.arca_config WHERE business_id = '${BIZ}';
DELETE FROM public.profiles WHERE business_id = '${BIZ}';
DELETE FROM public.businesses WHERE id = '${BIZ}';
DELETE FROM auth.users WHERE id = '${OWN}';`)
    check(psql(`SELECT count(*) FROM public.businesses WHERE id = '${BIZ}';`) === '0', 'cleanup: fixture removed')
  } catch (e) {
    check(false, `cleanup error: ${String(e.message || e).split('\n')[0]}`)
  }
  if (applied) {
    try {
      psql(readFileSync(ROLLBACK, 'utf8'))
      check(!releaseExists(), 'rollback: release RPC removed')
      check(fingerprint() === PRODUCTION_CLAIM_FINGERPRINT, 'rollback: claim function byte-identical to the PRODUCTION definition')
    } catch (e) {
      check(false, `rollback error: ${String(e.message || e).split('\n')[0]}`)
    }
  }
  if (baselineDefinition) {
    try {
      psql(`${baselineDefinition};`)
      check(fingerprint() === baselineFingerprint && !releaseExists(), 'local DB restored to its exact pre-run definition')
    } catch (e) {
      check(false, `local restore error: ${String(e.message || e).split('\n')[0]}`)
    }
  }
  const failed = results.filter((r) => !r.ok).length
  process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`)
  process.exitCode = failed ? 1 : 0
}
