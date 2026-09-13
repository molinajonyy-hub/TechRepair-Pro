#!/usr/bin/env node
// ============================================================================
// Guard AFIP-S1B-A1 — contrato server-side de escritura de arca_config.
//
// Falla (exit 1) si la migración del contrato de escritura viola invariantes:
//  · falta ADD CONSTRAINT UNIQUE (business_id);
//  · una RPC de escritura recibe EXECUTE de PUBLIC/anon/service_role;
//  · una RPC de escritura NO se otorga a authenticated;
//  · la RPC de config acepta private_key/cert_file/token/sign/pfx en su firma;
//  · alguna RPC usa un parámetro jsonb libre (sin allowlist tipada);
//  · alguna RPC usa search_path con 'public' o sin pg_temp (patrón inseguro);
//  · alguna RPC usa SQL dinámico (EXECUTE format/quote_*);
//  · la RPC temporal de certificado no está marcada para retiro en S3.
//
//   node scripts/finance/guard-afip-s1b-a1.mjs [--self-test]
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const DIR = 'supabase/migrations'
const WRITE_FNS = ['save_arca_config_legacy', 'save_arca_certificate_legacy', 'set_arca_estado_conexion']
const CONFIG_FN = 'save_arca_config_legacy'   // contrato NORMAL: prohíbe secretos en la firma
const CERT_FN = 'save_arca_certificate_legacy' // temporal
// Sin \b inicial: debe capturar nombres de parámetro con prefijo (p_private_key).
const SECRET_PARAMS = /(private_key|pfx_file|pfx_password|certificate_password|wsaa_token|wsaa_sign)/i

function stripComments(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.slice(i, i + 2) === '--') { const f = sql.indexOf('\n', i); const e = f === -1 ? sql.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (sql.slice(i, i + 2) === '/*') { const f = sql.indexOf('*/', i + 2); const e = f === -1 ? sql.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += sql[i]; i++
  }
  return out
}

// Extrae la firma (args) de CREATE ... FUNCTION public.<fn>(<args>)
function fnArgs(sql, fn) {
  const m = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(([\\s\\S]*?)\\)\\s*RETURNS`, 'i').exec(sql)
  return m ? m[1] : null
}
// Bloque completo CREATE FUNCTION ... $$ ... $$ (para inspeccionar el cuerpo)
function fnBlock(sql, fn) {
  const i = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(`, 'i').exec(sql)
  if (!i) return null
  const from = i.index
  const tagM = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(sql.slice(from))
  if (!tagM) return sql.slice(from, from + 2000)
  const tag = tagM[1]; const a = from + tagM.index + tagM[0].length
  const b = sql.indexOf(tag, a)
  return sql.slice(from, b === -1 ? sql.length : b + tag.length)
}
// EXECUTE grants para una fn: {authenticated:bool, anon:bool, public:bool, service_role:bool}
function grants(sql, fn) {
  const g = { authenticated: false, anon: false, public: false, service_role: false }
  const re = new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\([^)]*\\)\\s+TO\\s+([^;]+);`, 'gi')
  let m; while ((m = re.exec(sql)) !== null) {
    for (const r of m[1].toLowerCase().split(/[\s,]+/)) if (r in g) g[r] = true
    if (/\bpublic\b/i.test(m[1])) g.public = true
  }
  return g
}

// ARCA Phase 0: estas dos RPC fueron RETIRADAS. Una redefinición posterior tiene
// que ser un stub fail-closed: sin EXECUTE para nadie, sin SECURITY DEFINER, sin
// tocar arca_config y con el código de retiro.
const RETIRED_FNS = {
  save_arca_certificate_legacy: 'ARCA_LEGACY_CERTIFICATE_WRITE_RETIRED',
  set_arca_estado_conexion: 'ARCA_CLIENT_CONNECTION_STATE_WRITE_RETIRED',
}
// Autoridad aceptada: el helper histórico o la autoridad canónica de Phase 0.
const OWNER_ADMIN_AUTHORITY = /is_business_owner_or_admin|private\.arca_actor_can_manage/

function isRetiredDefinition(fn, body) {
  const code = RETIRED_FNS[fn]
  return !!code && new RegExp(code).test(body || '')
}

export function findings(sql, { requireUnique = true } = {}) {
  const out = []
  const clean = stripComments(sql)
  // Gate: solo aplica a archivos que DEFINEN alguna de las RPC del contrato
  // (mencionarlas — p.ej. en pre/post-condiciones de lotes posteriores como
  // S1B-B — no activa el guard; redefinirlas en cualquier migración SÍ).
  const defined = WRITE_FNS.filter(fn =>
    new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(`, 'i').test(clean))
  if (defined.length === 0) return out

  // La migración que CREA la RPC de config debe traer la unique canónica (las
  // redefiniciones posteriores ya la encuentran creada).
  if (requireUnique && defined.includes(CONFIG_FN) &&
      !/ADD\s+CONSTRAINT\s+arca_config_business_id_key\s+UNIQUE\s*\(\s*business_id\s*\)/i.test(clean)) {
    out.push('falta ADD CONSTRAINT UNIQUE(business_id)')
  }
  for (const fn of defined) {
    const args = fnArgs(clean, fn); const body = fnBlock(clean, fn)
    if (args === null) { out.push(`${fn}: no está definida`); continue }
    const g = grants(clean, fn)
    if (g.public || g.anon) out.push(`${fn}: EXECUTE a PUBLIC/anon`)
    if (g.service_role) out.push(`${fn}: EXECUTE a service_role (sin consumidor justificado)`)
    if (isRetiredDefinition(fn, body)) {
      if (g.authenticated) out.push(`${fn}: RPC retirada con EXECUTE a authenticated`)
      if (/SECURITY\s+DEFINER/i.test(body || '')) out.push(`${fn}: stub retirado no debe ser SECURITY DEFINER`)
      if (/arca_config/i.test(body || '')) out.push(`${fn}: stub retirado no debe tocar arca_config`)
      if (!new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\([^)]*\\)\\s+FROM\\s+anon,\\s*authenticated`, 'i').test(clean)) {
        out.push(`${fn}: stub retirado sin REVOKE explícito a anon/authenticated`)
      }
      continue
    }
    if (!g.authenticated) out.push(`${fn}: falta EXECUTE a authenticated`)
    if (!/auth\.uid\(\)/.test(body || '')) out.push(`${fn}: no usa auth.uid()`)
    if (!OWNER_ADMIN_AUTHORITY.test(body || '')) out.push(`${fn}: sin control owner/admin`)
    if (!/SET\s+search_path\s*=\s*pg_catalog\s*,\s*pg_temp/i.test(body || '')) out.push(`${fn}: search_path no es 'pg_catalog, pg_temp'`)
    if (/\bjsonb\b/i.test(args) && /p_\w+\s+jsonb/i.test(args)) out.push(`${fn}: parámetro jsonb libre (sin allowlist tipada)`)
    if (/\bEXECUTE\s+format\b|\bquote_ident\b|\bquote_literal\b/i.test(body || '')) out.push(`${fn}: SQL dinámico`)
    // La RPC de config NORMAL no debe aceptar secretos/cert en su firma
    if (fn === CONFIG_FN && SECRET_PARAMS.test(args)) out.push(`${fn}: acepta secreto/cert en la firma`)
    if (fn === CONFIG_FN && /cert_file/i.test(args)) out.push(`${fn}: acepta cert_file en el contrato normal`)
  }
  // La RPC temporal de cert debe estar marcada para retiro en S3 (salvo que ya sea el stub retirado)
  const certBody = fnBlock(sql, CERT_FN)   // sin stripComments: buscamos la marca en comentario
  if (certBody && !isRetiredDefinition(CERT_FN, certBody)
      && !/TEMPORAL_RETIRAR_EN_S3|retirar en S3|temporal.*S3/i.test(certBody)) {
    out.push(`${CERT_FN}: RPC temporal de certificado sin marca de retiro en S3`)
  }
  return out
}

function selfTest() {
  const OK = readFileSync('supabase/migrations/20260721170000_afip_s1b_a1_write_contract.sql', 'utf8')
  const cases = [
    { n: '1 migración real → 0', exp: 0, sql: OK },
    { n: '2 sin unique → falla', min: 1, sql: OK.replace(/ADD CONSTRAINT arca_config_business_id_key UNIQUE \(business_id\)/, 'x') },
    { n: '3 GRANT a anon → falla', min: 1, sql: OK + '\nGRANT EXECUTE ON FUNCTION public.save_arca_config_legacy(uuid,text,text,text,integer,text,text,timestamptz) TO anon;' },
    { n: '4 param private_key en config → falla', min: 1, sql: OK.replace(/p_cuit\s+text\s+DEFAULT NULL,/, 'p_cuit text DEFAULT NULL, p_private_key text DEFAULT NULL,') },
    { n: '5 no S1B-A1 → 0', exp: 0, sql: 'CREATE TABLE x();' },
  ]
  // ARCA Phase 0: la redefinición real (stubs + config endurecida) no tiene hallazgos,
  // y cada forma de reabrir el camino legacy se detecta.
  const P0 = readFileSync('supabase/migrations/20260928120000_arca_selfservice_phase0_hardening.sql', 'utf8')
  const p0Cases = [
    { n: 'P0-1 migración Phase 0 real → 0', exp: 0, sql: P0 },
    { n: 'P0-2 stub cert re-otorgado a authenticated → falla', min: 1,
      sql: P0 + '\nGRANT EXECUTE ON FUNCTION public.save_arca_certificate_legacy(uuid, text) TO authenticated;' },
    { n: 'P0-3 stub estado vuelve a escribir arca_config → falla', min: 1,
      sql: P0.replace("RAISE EXCEPTION 'ARCA_CLIENT_CONNECTION_STATE_WRITE_RETIRED'",
        "UPDATE public.arca_config SET estado_conexion = p_estado; RAISE EXCEPTION 'ARCA_CLIENT_CONNECTION_STATE_WRITE_RETIRED'") },
    { n: 'P0-4 cert legacy vuelve a ser operativo (sin código de retiro) → falla', min: 1,
      sql: P0.replace("RAISE EXCEPTION 'ARCA_LEGACY_CERTIFICATE_WRITE_RETIRED'", "RAISE EXCEPTION 'OTRA_COSA'") },
    { n: 'P0-5 config sin autoridad owner/admin → falla', min: 1,
      sql: P0.replace(/OR NOT private\.arca_actor_can_manage\(p_business_id, v_actor\)/, '') },
  ]
  let fail = 0
  for (const c of cases) {
    const got = findings(c.sql).length
    const ok = c.exp !== undefined ? got === c.exp : got >= c.min
    if (!ok) fail++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.n}": ${got}${ok ? '' : ` (${findings(c.sql).slice(0,2).join(' | ')})`}`)
  }
  for (const c of p0Cases) {
    const got = findings(c.sql, { requireUnique: false }).length
    const ok = c.exp !== undefined ? got === c.exp : got >= c.min
    if (!ok) fail++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.n}": ${got}${ok ? '' : ` (${findings(c.sql, { requireUnique: false }).slice(0,2).join(' | ')})`}`)
  }
  if (fail) { console.error(`\n❌ self-test: ${fail} fallo(s)`); process.exit(1) }
  console.log(`\n✅ self-test: las ${cases.length + p0Cases.length} fixtures OK`)
}

const isCLI = process.argv[1] && process.argv[1].endsWith('guard-afip-s1b-a1.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort().map(f => join(DIR, f)).filter(f => statSync(f).isFile())
  const bad = []
  // La unique canónica se exige a la PRIMERA migración que crea la RPC de config;
  // las redefiniciones posteriores (ARCA Phase 0) ya la encuentran creada.
  let configCreated = false
  for (const f of files) {
    const sql = readFileSync(f, 'utf8')
    for (const h of findings(sql, { requireUnique: !configCreated })) bad.push(`${basename(f)}: ${h}`)
    if (new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${CONFIG_FN}\\s*\\(`, 'i').test(stripComments(sql))) configCreated = true
  }
  if (bad.length) {
    console.error('❌ Guard AFIP-S1B-A1:\n')
    for (const b of bad) console.error('  · ' + b)
    process.exit(1)
  }
  console.log('✅ Guard AFIP-S1B-A1 OK: unique(business_id), RPC authenticated/owner-admin, sin secretos en el contrato, cert temporal marcada.')
}
