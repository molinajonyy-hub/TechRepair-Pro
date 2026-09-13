#!/usr/bin/env node
/**
 * ARCA SELF-SERVICE · PHASE 1 — guard estático del read model de estado.
 *
 *  S1  public.get_arca_selfservice_status: SECURITY DEFINER, STABLE, search_path fijo
 *      SIN comillas, EXECUTE sólo authenticated (REVOKE PUBLIC/anon/service_role),
 *      tenant por identidad (get_my_profile) y p_business_id distinto = FORBIDDEN.
 *  S2  private.arca_selfservice_status: NO SECURITY DEFINER, STABLE, sin EXECUTE para
 *      roles cliente/service_role, can_manage = private.arca_actor_can_manage.
 *  S3  la derivación no LEE material que no necesita (token/sign WSAA, Vault
 *      descifrado, CSR/cert PEM de rotaciones, checkpoints prev_*, ultimo_error) y
 *      cert_file sólo se usa para derivar (btrim / arca_pem_to_der).
 *  S4  claves de salida (todas las jsonb_build_object de ambas funciones) ⊆ allowlist
 *      y ninguna clave prohibida.
 *  S5  frontend: sólo arcaService llama la RPC; la tarjeta y el módulo de contrato
 *      no hablan con Supabase ni nombran material; Settings no reconstruye el estado
 *      desde estado_conexion/ultimo_error.
 *
 *   node scripts/guards/arca-phase1-status-contract.mjs [--self-test]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = 'supabase/migrations'
const RPC = 'public.get_arca_selfservice_status'
const DERIVE = 'private.arca_selfservice_status'

export const ALLOWED_KEYS = new Set([
  'contract_version', 'available', 'status', 'configured', 'environment', 'cuit', 'razon_social',
  'punto_venta', 'alias', 'certificate', 'present', 'expires_at', 'days_remaining', 'renewal_state',
  'matches_credential', 'credential', 'active', 'connection', 'state', 'last_verified_at', 'setup',
  'kind', 'step', 'started_at', 'attention', 'can_manage', 'next_action',
])
export const FORBIDDEN_KEYS = [
  'cert_file', 'private_key', 'private_key_pem', 'wsaa_token', 'wsaa_sign', 'secret_id',
  'private_key_secret_id', 'csr_pem', 'certificate_pem', 'fingerprint', 'private_key_fingerprint',
  'certificate_fingerprint', 'pfx_file', 'pfx_password', 'ultimo_error', 'estado_conexion', 'token', 'sign',
]
const FORBIDDEN_READS = [
  'wsaa_token', 'wsaa_sign', 'decrypted_secret', 'csr_pem', 'certificate_pem', 'prev_', 'pfx_password',
  'ultimo_error', 'arca_get_private_key_for_signing', 'arca_get_credential_for_signing',
]

const stripSqlComments = (s) => s.replace(/--[^\n]*/g, '')
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** Árbol de archivos real o sintético (self-test). */
function realTree() {
  return {
    migrations: () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort().map((f) => join(MIGRATIONS, f)),
    read: (p) => readFileSync(p, 'utf8'),
    exists: (p) => existsSync(p),
    listSrc: () => walk('src'),
  }
}
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p.replace(/\\/g, '/'))
  }
  return out
}

/** Última definición (CREATE OR REPLACE FUNCTION ... $function$) y su bloque de grants en ese archivo. */
function lastDefinition(tree, qualified) {
  let found = null
  const head = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${qualified.replace('.', '\\.')}\\s*\\(`, 'i')
  for (const file of tree.migrations()) {
    const sql = tree.read(file)
    const m = head.exec(sql)
    if (!m) continue
    const rest = sql.slice(m.index)
    const open = rest.search(/\$function\$/)
    const close = rest.indexOf('$function$', open + 10)
    if (open < 0 || close < 0) continue
    found = { file, header: rest.slice(0, open), body: rest.slice(open + 10, close), fileSql: sql }
  }
  return found
}

/** Divide los argumentos top-level de cada jsonb_build_object( ... ) y devuelve las claves literales. */
export function jsonbKeys(sql) {
  const keys = []
  const re = /jsonb_build_object\s*\(/gi
  let m
  while ((m = re.exec(sql))) {
    let depth = 1, i = m.index + m[0].length, inStr = false, cur = '', args = []
    for (; i < sql.length && depth > 0; i++) {
      const ch = sql[i]
      if (inStr) { cur += ch; if (ch === "'" && sql[i + 1] !== "'") inStr = false; else if (ch === "'" ) { cur += sql[++i] } continue }
      if (ch === "'") { inStr = true; cur += ch; continue }
      if (ch === '(') depth++
      if (ch === ')') { depth--; if (depth === 0) break }
      if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue }
      cur += ch
    }
    if (cur.trim()) args.push(cur.trim())
    args.forEach((a, idx) => {
      if (idx % 2 !== 0) return
      const lit = /^'([^']*)'$/.exec(a)
      keys.push(lit ? lit[1] : `<no-literal:${a.slice(0, 40)}>`)
    })
  }
  return keys
}

export function check(tree) {
  const out = []
  const rpc = lastDefinition(tree, RPC)
  const der = lastDefinition(tree, DERIVE)
  if (!rpc) out.push(`S1 falta ${RPC}`)
  if (!der) out.push(`S2 falta ${DERIVE}`)
  if (!rpc || !der) return out

  // ── S1 ──
  const rh = rpc.header
  if (!/SECURITY\s+DEFINER/i.test(rh)) out.push('S1 la RPC debe ser SECURITY DEFINER')
  if (!/\bSTABLE\b/i.test(rh)) out.push('S1 la RPC debe ser STABLE (no puede escribir)')
  if (!/SET\s+search_path\s*=\s*pg_catalog,\s*pg_temp\b/i.test(rh) || /search_path\s*=\s*'/i.test(rh)) {
    out.push('S1 la RPC debe fijar SET search_path = pg_catalog, pg_temp (sin comillas)')
  }
  const rg = stripSqlComments(rpc.fileSql)
  if (!/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.get_arca_selfservice_status\(uuid\)\s+TO\s+authenticated\s*;/i.test(rg)) {
    out.push('S1 falta GRANT EXECUTE ... TO authenticated')
  }
  if (/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.get_arca_selfservice_status\(uuid\)\s+TO\s+[^;]*\b(anon|service_role|PUBLIC)\b/i.test(rg)) {
    out.push('S1 la RPC no puede otorgarse a anon/service_role/PUBLIC')
  }
  if (!/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.get_arca_selfservice_status\(uuid\)\s+FROM\s+PUBLIC/i.test(rg)
      || !/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.get_arca_selfservice_status\(uuid\)\s+FROM\s+anon,\s*service_role/i.test(rg)) {
    out.push('S1 falta REVOKE de PUBLIC y de anon/service_role')
  }
  const rb = stripSqlComments(rpc.body)
  if (!/public\.get_my_profile\(\)/.test(rb)) out.push('S1 el tenant debe resolverse por identidad (get_my_profile)')
  if (!/p_business_id\s*<>\s*v_tenant/.test(rb)) out.push('S1 un p_business_id distinto del tenant debe rechazarse')
  if (/arca_selfservice_status\(\s*p_business_id/.test(rb)) out.push('S1 la derivación no puede recibir p_business_id como autoridad')
  if (!/RAISE\s+EXCEPTION\s+'FORBIDDEN'/.test(rb)) out.push('S1 la RPC debe fallar FORBIDDEN')

  // ── S2 ──
  if (/SECURITY\s+DEFINER/i.test(der.header)) out.push('S2 la derivación privada NO debe ser SECURITY DEFINER')
  if (!/\bSTABLE\b/i.test(der.header)) out.push('S2 la derivación debe ser STABLE')
  const dg = stripSqlComments(der.fileSql)
  if (!/REVOKE\s+ALL\s+ON\s+FUNCTION\s+private\.arca_selfservice_status\(uuid,\s*uuid,\s*timestamptz\)\s+FROM\s+anon,\s*authenticated,\s*service_role/i.test(dg)) {
    out.push('S2 falta REVOKE de anon/authenticated/service_role sobre la derivación')
  }
  if (/GRANT\s+[^;]*ON\s+FUNCTION\s+private\.arca_selfservice_status/i.test(dg)) out.push('S2 la derivación no se otorga a nadie')
  const db = stripSqlComments(der.body)
  if (!/private\.arca_actor_can_manage\(\s*p_business_id\s*,\s*p_actor\s*\)/.test(db)) {
    out.push('S2 can_manage debe venir de private.arca_actor_can_manage')
  }

  // ── S3 ──
  for (const token of FORBIDDEN_READS) {
    if (db.includes(token) || rb.includes(token)) out.push(`S3 el read model lee material innecesario: ${token}`)
  }
  const certUses = db.match(/(?:\w+\()?(?:\w+\.)?cert_file/g) ?? []
  for (const use of certUses) {
    if (!/^(c\.|btrim\(v_cfg\.|arca_pem_to_der\(v_cfg\.)cert_file$/.test(use)) {
      out.push(`S3 cert_file sólo puede usarse para derivar (uso: ${use})`)
    }
  }
  if ((db.match(/private_key_secret_id/g) ?? []).length !== 1 || !/s\.id\s*=\s*k\.private_key_secret_id/.test(db)) {
    out.push('S3 private_key_secret_id sólo puede usarse para comprobar existencia en Vault')
  }

  // ── S4 ──
  for (const key of [...jsonbKeys(db), ...jsonbKeys(rb)]) {
    if (!ALLOWED_KEYS.has(key)) out.push(`S4 clave fuera del contrato: ${key}`)
    if (FORBIDDEN_KEYS.includes(key)) out.push(`S4 clave prohibida: ${key}`)
  }

  // ── S5 ──
  for (const file of tree.listSrc()) {
    const code = stripJsComments(tree.read(file))
    if (/get_arca_selfservice_status/.test(code) && file !== 'src/services/arcaService.ts') {
      out.push(`S5 ${file} llama la RPC de estado fuera de arcaService`)
    }
  }
  for (const file of ['src/lib/arcaStatus.ts', 'src/components/settings/ArcaStatusCard.tsx']) {
    if (!tree.exists(file)) { out.push(`S5 falta ${file}`); continue }
    const code = stripJsComments(tree.read(file))
    if (/supabase|\.rpc\(|from\(/.test(code)) out.push(`S5 ${file} no debe hablar con Supabase`)
    for (const k of FORBIDDEN_KEYS.filter((k) => !['token', 'sign', 'fingerprint'].includes(k))) {
      if (code.includes(k)) out.push(`S5 ${file} nombra material prohibido: ${k}`)
    }
  }
  const settings = 'src/pages/Settings.tsx'
  if (tree.exists(settings)) {
    const code = stripJsComments(tree.read(settings))
    if (/arcaConfig\.(estado_conexion|ultimo_error|expires_at)/.test(code)) {
      out.push('S5 Settings reconstruye el estado ARCA desde estado_conexion/ultimo_error/expires_at')
    }
    if (!/<ArcaStatusCard\b/.test(code)) out.push('S5 Settings debe mostrar ArcaStatusCard')
  }
  return out
}

function selfTest() {
  const base = realTree()
  const migFile = base.migrations().find((f) => f.includes('arca_selfservice_phase1_status_read_model'))
  if (!migFile) throw new Error('self-test: falta la migración de Phase 1')
  const clean = check(base)
  if (clean.length) throw new Error(`self-test: el árbol real no está limpio:\n${clean.join('\n')}`)

  const mutate = (label, file, fn) => {
    const original = base.read(file)
    const patched = fn(original)
    if (patched === original) throw new Error(`self-test: la mutación «${label}» no cambió nada`)
    const tree = { ...base, read: (p) => (p.replace(/\\/g, '/') === file.replace(/\\/g, '/') ? patched : base.read(p)) }
    const got = check(tree)
    const expected = EXPECTED[label]
    if (!expected || !got.some((g) => g.startsWith(expected))) {
      throw new Error(`self-test: no detectó «${label}» (esperado «${expected}», obtenido: ${got.join(' | ') || 'nada'})`)
    }
    return got.length
  }
  // Cada violación plantada tiene que caer en SU regla, no en otra por accidente.
  const EXPECTED = {
    'devuelve cert_file': 'S4 clave prohibida: cert_file',
    'devuelve ultimo_error': 'S4 clave prohibida: ultimo_error',
    'lee wsaa_token': 'S3 el read model lee material innecesario: wsaa_token',
    'descifra Vault': 'S3 el read model lee material innecesario: decrypted_secret',
    'derivación SECURITY DEFINER': 'S2 la derivación privada NO debe ser SECURITY DEFINER',
    'RPC otorgada a anon': 'S1 la RPC no puede otorgarse',
    'search_path con comillas': 'S1 la RPC debe fijar SET search_path',
    'acepta p_business_id como autoridad': 'S1 un p_business_id distinto',
    'can_manage por rol en vez de autoridad': 'S2 can_manage debe venir',
    'RPC VOLATILE': 'S1 la RPC debe ser STABLE',
    'Settings vuelve a leer estado_conexion': 'S5 Settings reconstruye',
    'tarjeta habla con Supabase': 'S5 src/components/settings/ArcaStatusCard.tsx no debe hablar con Supabase',
    'contrato nombra cert_file': 'S5 src/lib/arcaStatus.ts nombra material prohibido: cert_file',
  }
  const cases = [
    ['devuelve cert_file', migFile, (s) => s.replace("'alias',            CASE WHEN v_cfg_found", "'cert_file', v_cfg.cert_file,\n    'alias',            CASE WHEN v_cfg_found")],
    ['devuelve ultimo_error', migFile, (s) => s.replace("'can_manage',       v_can_manage,", "'can_manage',       v_can_manage,\n    'ultimo_error', 'x',")],
    ['lee wsaa_token', migFile, (s) => s.replace('c.cert_file, c.pfx_file,', 'c.cert_file, c.pfx_file, c.wsaa_token,')],
    ['descifra Vault', migFile, (s) => s.replace('FROM vault.secrets s WHERE s.id = k.private_key_secret_id) AS secret_present', 'FROM vault.decrypted_secrets s WHERE s.id = k.private_key_secret_id) AS secret_present')],
    ['derivación SECURITY DEFINER', migFile, (s) => s.replace('RETURNS jsonb\nLANGUAGE plpgsql\nSTABLE\nSET search_path = pg_catalog, pg_temp\nAS $function$\nDECLARE\n  v_cfg ', 'RETURNS jsonb\nLANGUAGE plpgsql\nSTABLE\nSECURITY DEFINER\nSET search_path = pg_catalog, pg_temp\nAS $function$\nDECLARE\n  v_cfg ')],
    ['RPC otorgada a anon', migFile, (s) => s.replace('TO authenticated;\n\nCOMMENT ON FUNCTION public.get_arca_selfservice_status', 'TO authenticated;\nGRANT EXECUTE ON FUNCTION public.get_arca_selfservice_status(uuid) TO anon;\n\nCOMMENT ON FUNCTION public.get_arca_selfservice_status')],
    ['search_path con comillas', migFile, (s) => s.replace("SECURITY DEFINER\nSET search_path = pg_catalog, pg_temp", "SECURITY DEFINER\nSET search_path = 'pg_catalog, pg_temp'")],
    ['acepta p_business_id como autoridad', migFile, (s) => s.replace('OR (p_business_id IS NOT NULL AND p_business_id <> v_tenant)', '').replace('private.arca_selfservice_status(v_tenant, v_actor, now())', 'private.arca_selfservice_status(p_business_id, v_actor, now())')],
    ['can_manage por rol en vez de autoridad', migFile, (s) => s.replace('private.arca_actor_can_manage(p_business_id, p_actor) IS TRUE', "true")],
    ['RPC VOLATILE', migFile, (s) => s.replace("RETURNS jsonb\nLANGUAGE plpgsql\nSTABLE\nSECURITY DEFINER", 'RETURNS jsonb\nLANGUAGE plpgsql\nSECURITY DEFINER')],
    ['Settings vuelve a leer estado_conexion', 'src/pages/Settings.tsx', (s) => s.replace('<ArcaStatusCard status={arcaStatus}', "{arcaConfig.estado_conexion === 'conectado' && <p>ok</p>}\n<ArcaStatusCard status={arcaStatus}")],
    ['tarjeta habla con Supabase', 'src/components/settings/ArcaStatusCard.tsx', (s) => s.replace("import type { ReactNode } from 'react'", "import type { ReactNode } from 'react'\nimport { supabase } from '../../lib/supabase'")],
    ['contrato nombra cert_file', 'src/lib/arcaStatus.ts', (s) => s.replace('contract_version: 1\n  available: boolean', 'contract_version: 1\n  cert_file?: string\n  available: boolean')],
  ]
  for (const [label, file, fn] of cases) mutate(label, file, fn)
  const extra = { ...base, listSrc: () => [...base.listSrc(), 'src/pages/Otra.tsx'], read: (p) => (p === 'src/pages/Otra.tsx' ? "supabase.rpc('get_arca_selfservice_status')" : base.read(p)), exists: (p) => p === 'src/pages/Otra.tsx' || base.exists(p) }
  if (check(extra).length === 0) throw new Error('self-test: no detectó una segunda llamada a la RPC fuera de arcaService')
  console.log(`✅ Self-test ARCA Phase 1: ${cases.length + 1} violaciones plantadas, todas detectadas.`)
}

const isCLI = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('arca-phase1-status-contract.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const problems = check(realTree())
  if (problems.length) {
    console.error('❌ Guard ARCA Phase 1:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log('✅ Guard ARCA Phase 1 OK: read model authenticated-only con tenant por identidad, derivación privada sin material, claves de salida acotadas, UI sin reconstruir estado.')
}
