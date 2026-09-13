#!/usr/bin/env node
/**
 * ARCA SELF-SERVICE · PHASE 2A — guard estático del motor de configuración inicial.
 *
 *  F1  el navegador no genera claves ni maneja material privado (node-forge, generateKey,
 *      bloques PRIVATE KEY, signing_key_pem) y no toca tablas/RPC privadas de credenciales.
 *  F2  sólo src/services/arcaSetupService.ts invoca `arca-selfservice-setup`.
 *  F3  el paso del asistente se deriva de Phase 1: src/lib/arcaSetupWizard.ts es puro (sin
 *      Supabase, fetch ni storage) y consume el tipo de src/lib/arcaStatus.ts.
 *  E1  la Edge no loguea, no hace spread de resultados de RPC y no mete material en respuestas.
 *  E2  la Edge nunca habla con WSFE (FECAESolicitar/FECompConsultar) — sólo LoginCms.
 *  E3  verify_jwt = true para arca-selfservice-setup en supabase/config.toml.
 *  W1  _shared/wsaaLogin.ts es token a token igual a las funciones de afip-wsaa/index.ts.
 *  M1  las 8 RPC: SECURITY DEFINER, search_path fijo sin comillas, gate service_role + autoridad
 *      canónica, EXECUTE sólo service_role (también en migraciones posteriores).
 *  M2  toda selección de la fila viva usa setup_kind = 'initial' (salvo el conflicto de prepare);
 *      las RPC que escriben o entregan material excluyen negocios configurados.
 *  M3  la clave pendiente sólo sale del material ANTES de verificar; la activación escribe
 *      cuit_emisor y hace readback del par.
 *
 *   node scripts/guards/arca-phase2a-setup-contract.mjs [--self-test]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const EDGE_DIR = 'supabase/functions/arca-selfservice-setup'
const EDGE_FILES = ['index.ts', 'handler.ts', 'wsaa.ts', 'crypto.ts'].map((f) => `${EDGE_DIR}/${f}`)
const WSAA_SHARED = 'supabase/functions/_shared/wsaaLogin.ts'
const WSAA_ORIGIN = 'supabase/functions/afip-wsaa/index.ts'
const WSAA_FUNCTIONS = ['toAfipDate', 'buildTRA', 'verifyCertKeyMatch', 'signTRAWithPEM', 'callWSAA', 'parseWSAAResponse']
const SERVICE = 'src/services/arcaSetupService.ts'
const WIZARD = 'src/lib/arcaSetupWizard.ts'

export const RPCS = [
  ['arca_selfservice_prepare_initial', 'uuid,uuid,text,text,text,text,integer,text,text,text,text'],
  ['arca_selfservice_get_csr', 'uuid,uuid'],
  ['arca_selfservice_attach_certificate', 'uuid,uuid,text'],
  ['arca_selfservice_verification_material', 'uuid,uuid'],
  ['arca_selfservice_record_verification', 'uuid,uuid,text,text,text,text,timestamptz'],
  ['arca_selfservice_record_verification_failure', 'uuid,uuid,text'],
  ['arca_selfservice_activate', 'uuid,uuid,text,text,text'],
  ['arca_selfservice_cancel', 'uuid,uuid'],
]
const EXCLUDE_CONFIGURED = ['arca_selfservice_prepare_initial', 'arca_selfservice_get_csr', 'arca_selfservice_attach_certificate',
  'arca_selfservice_verification_material', 'arca_selfservice_record_verification', 'arca_selfservice_activate']

const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
const stripSql = (s) => s.replace(/--[^\n]*/g, '')

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

function diskTree() {
  return {
    read: (p) => readFileSync(p, 'utf8'),
    exists: (p) => existsSync(p),
    listSrc: () => walk('src'),
    migrations: () => readdirSync('supabase/migrations').filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort().map((f) => join('supabase/migrations', f).replace(/\\/g, '/')),
  }
}

/** Cuerpo de `function NAME(` hasta la primera línea `}` en columna 0, normalizado. */
export function topLevelFunction(source, name) {
  const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm')
  const m = re.exec(source)
  if (!m) return null
  const rest = source.slice(m.index)
  const end = rest.search(/\n\}\s*(\n|$)/)
  if (end < 0) return null
  return stripJs(rest.slice(0, end + 2)).replace(/^export\s+/, '').replace(/\s+/g, ' ').trim()
}

/** Última definición CREATE OR REPLACE de public.NAME y el SQL de su archivo. */
function lastRpc(tree, name) {
  let found = null
  for (const file of tree.migrations()) {
    const sql = tree.read(file)
    const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`, 'gi')
    let m
    while ((m = re.exec(sql))) {
      const rest = sql.slice(m.index)
      const open = rest.indexOf('$function$')
      const close = rest.indexOf('$function$', open + 10)
      if (open < 0 || close < 0) continue
      found = { file, header: rest.slice(0, open), body: rest.slice(open + 10, close) }
    }
  }
  return found
}

export function check(tree) {
  const out = []

  // ── F1/F2/F3 frontend ──
  const F1 = [
    [/node-forge|\bforge\./, 'usa node-forge'],
    [/generateKeyPair|subtle\.generateKey|subtle\.importKey\([^)]*pkcs8/, 'genera o importa claves'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'maneja un bloque PRIVATE KEY'],
    [/signing_key_pem/, 'nombra signing_key_pem'],
    [/arca_credential_rotations|arca_private_key_credentials/, 'nombra tablas privadas de credenciales'],
    [/\.schema\(\s*['"`]private['"`]\s*\)/, 'accede al schema private'],
    [/rpc\(\s*['"`]arca_selfservice_/, 'llama RPC service_role de configuración'],
    [/rpc\(\s*['"`]arca_(prepare|activate|finalize|rollback|cancel)_certificate_rotation/, 'llama RPC de rotación'],
    [/from\(\s*['"`]arca_config['"`]\s*\)\s*\.(insert|update|upsert|delete)/, 'escribe arca_config'],
  ]
  for (const file of tree.listSrc()) {
    const code = stripJs(tree.read(file))
    for (const [re, label] of F1) if (re.test(code)) out.push(`F1 ${file}: ${label}`)
    if (/functions\.invoke\(\s*['"`]arca-selfservice-setup['"`]/.test(code) && file !== SERVICE) {
      out.push(`F2 ${file}: invoca arca-selfservice-setup fuera de ${SERVICE}`)
    }
  }
  if (!tree.exists(WIZARD)) out.push(`F3 falta ${WIZARD}`)
  else {
    const w = stripJs(tree.read(WIZARD))
    if (/supabase|fetch\(|localStorage|sessionStorage|indexedDB/.test(w)) out.push('F3 el asistente no puede leer backend ni guardar progreso propio')
    if (!/from\s+['"]\.\/arcaStatus['"]/.test(w)) out.push('F3 el asistente debe derivar la pantalla del estado canónico (arcaStatus)')
  }
  if (!tree.exists(SERVICE)) out.push(`F2 falta ${SERVICE}`)

  // ── E1/E2 Edge ──
  const edge = EDGE_FILES.filter((f) => tree.exists(f))
  if (edge.length !== EDGE_FILES.length) out.push(`E1 faltan archivos de ${EDGE_DIR}`)
  for (const file of edge) {
    const code = stripJs(tree.read(file))
    if (/\bconsole\.|\blogger\./.test(code)) out.push(`E1 ${file}: no se loguea en la Edge de configuración`)
    if (/\.\.\.\s*(?:\w+\.)?data\b|\.\.\.\s*material\b|\.\.\.\s*(?:ticket|generated)\b/.test(code)) out.push(`E1 ${file}: spread de un resultado de RPC o material`)
    if (/json\([^)]*\b(material|ticket|generated|signingKeyPem|keyPem|certificatePem)\b/.test(code)) out.push(`E1 ${file}: material dentro de una respuesta`)
    if (/FECAESolicitar|FECompConsultar|FECompUltimoAutorizado|servicios1\.afip|wswhomo\.afip|\/wsfev1/i.test(code)) out.push(`E2 ${file}: habla con WSFE`)
  }
  if (tree.exists(`${EDGE_DIR}/handler.ts`)) {
    const h = stripJs(tree.read(`${EDGE_DIR}/handler.ts`))
    if ((h.match(/signing_key_pem/g) ?? []).length !== 1) out.push('E1 handler.ts: signing_key_pem debe leerse exactamente una vez')
  }

  // ── E3 config ──
  const toml = tree.read('supabase/config.toml')
  if (!/\[functions\.arca-selfservice-setup\]\s*\nverify_jwt\s*=\s*true/.test(toml)) out.push('E3 supabase/config.toml: arca-selfservice-setup sin verify_jwt = true')

  // ── W1 WSAA verbatim ──
  if (!tree.exists(WSAA_SHARED) || !tree.exists(WSAA_ORIGIN)) out.push('W1 faltan los helpers WSAA')
  else {
    const shared = tree.read(WSAA_SHARED)
    const origin = tree.read(WSAA_ORIGIN)
    for (const name of WSAA_FUNCTIONS) {
      const a = topLevelFunction(shared, name)
      const b = topLevelFunction(origin, name)
      if (!a || !b) out.push(`W1 ${name}: no encontrada en ${a ? WSAA_ORIGIN : WSAA_SHARED}`)
      else if (a !== b) out.push(`W1 ${name}: _shared/wsaaLogin.ts difiere de afip-wsaa/index.ts`)
    }
    if (!/npm:node-forge@1\.3\.1/.test(shared)) out.push('W1 _shared/wsaaLogin.ts debe fijar npm:node-forge@1.3.1 como afip-wsaa')
  }

  // ── M1/M2/M3 migraciones ──
  const allSql = tree.migrations().map((f) => stripSql(tree.read(f))).join('\n')
  for (const [name, sig] of RPCS) {
    const def = lastRpc(tree, name)
    if (!def) { out.push(`M1 falta public.${name}`); continue }
    const h = def.header
    const b = stripSql(def.body)
    if (!/SECURITY\s+DEFINER/i.test(h)) out.push(`M1 ${name}: debe ser SECURITY DEFINER`)
    if (!/SET\s+search_path\s*=\s*pg_catalog,\s*pg_temp\b/i.test(h) || /search_path\s*=\s*'/i.test(h)) out.push(`M1 ${name}: search_path fijo sin comillas`)
    if (!/auth\.role\(\)\s+IS\s+DISTINCT\s+FROM\s+'service_role'/.test(b)) out.push(`M1 ${name}: sin gate service_role`)
    if (!/public\.is_business_owner_or_admin\(\s*p_business_id\s*,\s*p_actor\s*\)/.test(b)) out.push(`M1 ${name}: sin autoridad canónica`)
    const grant = new RegExp(`GRANT\\s+(?:EXECUTE|ALL)[^;]*ON\\s+FUNCTION\\s+public\\.${name}\\s*\\([^)]*\\)\\s+TO\\s+([^;]+);`, 'gi')
    let m
    while ((m = grant.exec(allSql))) {
      if (/\b(anon|authenticated|public)\b/i.test(m[1])) out.push(`M1 ${name}: EXECUTE otorgado a ${m[1].trim()}`)
    }
    if (!new RegExp(`'public\\.${name}\\(${sig.replace(/,/g, ',')}\\)'`).test(allSql)) out.push(`M1 ${name}: no está en el bloque de grants service_role-only`)

    // M2: toda selección de fila viva es de la configuración inicial.
    // Selecciones/updates sobre la tabla (no comparaciones sobre un registro ya elegido: v_prev.state).
    const pending = [...b.matchAll(/(?<!v_\w+\.)\b(?:r\.)?state\s*=\s*'pending_rotation'/g)]
    for (const p of pending) {
      const near = b.slice(p.index, p.index + 90)
      const isPrepareConflict = name === 'arca_selfservice_prepare_initial' && /IF\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+private\.arca_credential_rotations\s+r\s+WHERE\s+r\.business_id\s*=\s*p_business_id\s+AND\s+r\.state\s*=\s*'pending_rotation'\s*\)/.test(b.slice(Math.max(0, p.index - 140), p.index + 30))
      if (!/setup_kind\s*=\s*'initial'/.test(near) && !isPrepareConflict) out.push(`M2 ${name}: selección de fila viva sin setup_kind = 'initial'`)
    }
    if (EXCLUDE_CONFIGURED.includes(name) && !/private\.arca_selfservice_is_configured\(\s*p_business_id\s*\)/.test(b)) {
      out.push(`M2 ${name}: no excluye negocios configurados`)
    }
    if (name === 'arca_selfservice_verification_material') {
      const already = b.indexOf("'ALREADY_VERIFIED'")
      const key = b.indexOf("'signing_key_pem'")
      const alreadyReturn = already < 0 ? '' : b.slice(already, b.indexOf(');', already))
      if (already < 0 || key < 0 || key < already || (b.match(/'signing_key_pem'/g) ?? []).length !== 1
          || /signing_key_pem|certificate_pem/.test(alreadyReturn)) {
        out.push('M3 verification_material: la clave sólo puede salir una vez, después de descartar un setup verificado')
      }
      if (!/verification_started_at\s*>\s*now\(\)\s*-\s*interval/.test(b)) out.push('M3 verification_material: sin lease de verificación')
    }
    if (name === 'arca_selfservice_activate') {
      if (!/cuit_emisor\s*=\s*v_cuit/.test(b)) out.push('M3 activate: no fija cuit_emisor al CUIT del certificado')
      if (!/arca_key_matches_certificate/.test(b) || !/arca_get_private_key_for_signing/.test(b)) out.push('M3 activate: sin readback del par activo')
      if (!/certificate_der_sha256\s+IS\s+DISTINCT\s+FROM\s+v_sha/.test(b)) out.push('M3 activate: no ata la activación al certificado verificado')
    }
    if (name === 'arca_selfservice_record_verification' && !/certificate_der_sha256/.test(b)) {
      out.push('M3 record_verification: no ata el ticket al certificado exacto')
    }
  }
  return out
}

function selfTest() {
  const base = diskTree()
  const clean = check(base)
  if (clean.length) throw new Error(`self-test: el árbol real no está limpio:\n${clean.join('\n')}`)
  const migration = base.migrations().find((f) => f.includes('arca_selfservice_phase2a_initial_setup'))
  if (!migration) throw new Error('self-test: falta la migración de Phase 2A')

  const overlay = (files, extraSrc = []) => ({
    ...base,
    read: (p) => (files.has(p) ? files.get(p) : base.read(p)),
    exists: (p) => files.has(p) || base.exists(p),
    listSrc: () => [...base.listSrc(), ...extraSrc],
    migrations: () => [...new Set([...base.migrations(), ...[...files.keys()].filter((k) => k.startsWith('supabase/migrations/'))])].sort(),
  })
  const patch = (file, from, to) => {
    const src = base.read(file)
    const next = typeof from === 'string' ? src.replace(from, to) : src.replace(from, to)
    if (next === src) throw new Error(`self-test: la mutación sobre ${file} no cambió nada (${String(from).slice(0, 40)})`)
    return new Map([[file, next]])
  }
  const later = 'supabase/migrations/29991231120000_regresion_phase2a.sql'

  const cases = [
    ['F1', 'frontend genera claves', overlay(new Map([['src/services/x.ts', "import forge from 'node-forge'\nforge.pki.rsa.generateKeyPair(2048)"]]), ['src/services/x.ts'])],
    ['F1', 'frontend lee signing_key_pem', overlay(new Map([['src/services/x.ts', 'export const k = (r: any) => r.signing_key_pem']]), ['src/services/x.ts'])],
    ['F1', 'frontend llama una RPC de configuración', overlay(new Map([['src/services/x.ts', "supabase.rpc('arca_selfservice_activate', {})"]]), ['src/services/x.ts'])],
    ['F1', 'frontend escribe rotaciones', overlay(new Map([['src/services/x.ts', "supabase.schema('private').from('arca_credential_rotations').insert({})"]]), ['src/services/x.ts'])],
    ['F2', 'otra pantalla invoca el Edge', overlay(new Map([['src/pages/Y.tsx', "supabase.functions.invoke('arca-selfservice-setup', { body: {} })"]]), ['src/pages/Y.tsx'])],
    ['F3', 'el asistente guarda progreso propio', overlay(patch(WIZARD, "import type { ArcaSelfServiceStatus } from './arcaStatus'", "import type { ArcaSelfServiceStatus } from './arcaStatus'\nlocalStorage.setItem('paso', '3')"))],
    ['E1', 'la Edge loguea', overlay(patch(`${EDGE_DIR}/handler.ts`, "if (req.method === 'OPTIONS') return cors.preflight(req)", "if (req.method === 'OPTIONS') return cors.preflight(req)\n  console.log(req)"))],
    ['E1', 'la Edge devuelve el material', overlay(patch(`${EDGE_DIR}/handler.ts`, "return json({ ok: true, state: 'SETUP_ALREADY_COMPLETED' })", "return json({ ok: true, state: 'SETUP_ALREADY_COMPLETED', material })"))],
    ['E1', 'la Edge hace spread del resultado', overlay(patch(`${EDGE_DIR}/handler.ts`, "return json({ ok: true, state: st, expires_at: str(r.data.expires_at) })", "return json({ ...r.data })"))],
    ['E2', 'la Edge llama a WSFE', overlay(patch(`${EDGE_DIR}/wsaa.ts`, "const tra = buildTRA(input.service)", "const tra = buildTRA(input.service) // x\n  await fetch('https://wswhomo.afip.gov.ar/wsfev1/service.asmx?op=FECAESolicitar')"))],
    ['E3', 'verify_jwt apagado', overlay(patch('supabase/config.toml', /\[functions\.arca-selfservice-setup\]\s*\nverify_jwt\s*=\s*true/, '[functions.arca-selfservice-setup]\nverify_jwt = false'))],
    ['W1', 'la copia WSAA diverge', overlay(patch(WSAA_SHARED, "const expiration = new Date(now.getTime() + 12 * 60 * 60 * 1000) // 12 horas", "const expiration = new Date(now.getTime() + 24 * 60 * 60 * 1000) // 12 horas"))],
    ['W1', 'afip-wsaa cambia sin la copia', overlay(patch(WSAA_ORIGIN, "digestAlgorithm: forge.pki.oids.sha256,\n    authenticatedAttributes", "digestAlgorithm: forge.pki.oids.sha1,\n    authenticatedAttributes"))],
    ['M1', 'RPC otorgada a authenticated', overlay(new Map([[later, 'GRANT EXECUTE ON FUNCTION public.arca_selfservice_get_csr(uuid,uuid) TO authenticated;']]))],
    ['M1', 'RPC sin gate service_role', overlay(patch(migration, /(FUNCTION public\.arca_selfservice_cancel[\s\S]*?)IF auth\.role\(\) IS DISTINCT FROM 'service_role' THEN/, '$1IF false THEN'))],
    ['M1', 'search_path con comillas', overlay(patch(migration, /(FUNCTION public\.arca_selfservice_get_csr[\s\S]*?)SET search_path = pg_catalog, pg_temp/, "$1SET search_path = 'pg_catalog, pg_temp'"))],
    ['M2', 'cancel selecciona cualquier fila viva', overlay(patch(migration, /(FUNCTION public\.arca_selfservice_cancel[\s\S]*?)r\.state = 'pending_rotation' AND r\.setup_kind = 'initial'/, "$1r.state = 'pending_rotation'"))],
    ['M2', 'attach sin excluir configurados', overlay(patch(migration, /(FUNCTION public\.arca_selfservice_attach_certificate[\s\S]*?)IF private\.arca_selfservice_is_configured\(p_business_id\) THEN/, '$1IF false THEN'))],
    ['M3', 'la clave sale aunque ya esté verificado', overlay(patch(migration, /(FUNCTION public\.arca_selfservice_verification_material[\s\S]*?)'fingerprint', v_row\.private_key_fingerprint,\n      'certificate_sha256', v_row\.certificate_der_sha256\);/, "$1'fingerprint', v_row.private_key_fingerprint, 'signing_key_pem', 'x',\n      'certificate_sha256', v_row.certificate_der_sha256);"))],
    ['M3', 'activate sin cuit_emisor', overlay(patch(migration, 'cuit_emisor           = v_cuit,', ''))],
    ['M3', 'activate sin atarse al certificado', overlay(patch(migration, 'OR v_row.certificate_der_sha256 IS DISTINCT FROM v_sha', ''))],
  ]
  let failed = 0
  for (const [rule, label, tree] of cases) {
    const got = check(tree)
    if (!got.some((g) => g.startsWith(rule))) { failed++; console.error(`❌ no detectó «${label}» (esperado ${rule}; obtenido: ${got.join(' | ') || 'nada'})`) }
    else console.log(`✅ detecta: ${label}`)
  }
  if (failed) { console.error(`\n❌ self-test ARCA Phase 2A: ${failed} fallo(s)`); process.exit(1) }
  console.log(`\n✅ Self-test ARCA Phase 2A: ${cases.length} violaciones plantadas, todas detectadas por su regla.`)
}

const isCLI = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('arca-phase2a-setup-contract.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const problems = check(diskTree())
  if (problems.length) {
    console.error('❌ Guard ARCA Phase 2A:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log('✅ Guard ARCA Phase 2A OK: navegador sin claves ni tablas privadas, Edge sin logs/material/WSFE, WSAA verbatim, 8 RPC service_role-only acotadas a la configuración inicial.')
}
