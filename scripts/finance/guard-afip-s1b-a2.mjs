#!/usr/bin/env node
// ============================================================================
// Guard AFIP-S1B-A2 — el frontend no accede directo a arca_config.
//
// Falla (exit 1) si en el frontend (src/**) aparece:
//  · from('arca_config') con select/insert/update/upsert/delete (DML/SELECT directo);
//  · cert_file: null  (borraría el certificado guardado);
//  · una fuga de private_key (property/param/string 'private_key', excepto el flag
//    de presencia has_private_key_configured);
//  · uploadCertificate (método cliente que aceptaba la clave privada);
//  · spread (...) dentro de la llamada a save_arca_config_legacy (mass-assignment).
//
// Y exige que el frontend use las 4 RPC del contrato seguro:
//  get_arca_config_safe, save_arca_config_legacy, save_arca_certificate_legacy,
//  set_arca_estado_conexion.
//
//   node scripts/finance/guard-afip-s1b-a2.mjs [--self-test]
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src'
const REQUIRED_RPCS = [
  'get_arca_config_safe',
  'save_arca_config_legacy',
  'save_arca_certificate_legacy',
  'set_arca_estado_conexion',
]

// Quita comentarios // y /* */ (naive; suficiente para detección de patrones).
function stripComments(src) {
  let out = '', i = 0
  while (i < src.length) {
    if (src.slice(i, i + 2) === '//') { const f = src.indexOf('\n', i); const e = f === -1 ? src.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (src.slice(i, i + 2) === '/*') { const f = src.indexOf('*/', i + 2); const e = f === -1 ? src.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += src[i]; i++
  }
  return out
}

// Hallazgos por archivo (recibe el CONTENIDO ya sin comentarios no es necesario:
// lo limpiamos acá para que las fixtures puedan pasar texto crudo).
export function fileFindings(raw, label = '<mem>') {
  const out = []
  const code = stripComments(raw)

  // 1. DML/SELECT directo sobre arca_config (no confundir con arca_parametros).
  const fromRe = /from\(\s*['"]arca_config['"]\s*\)\s*\.\s*(select|insert|update|upsert|delete)\b/gi
  let m
  while ((m = fromRe.exec(code)) !== null) out.push(`${label}: from('arca_config').${m[1]} directo`)
  // También un from('arca_config') seguido (encadenado multi-línea) de una op.
  const fromChain = /from\(\s*['"]arca_config['"]\s*\)/gi
  while ((m = fromChain.exec(code)) !== null) {
    const win = code.slice(m.index, m.index + 200)
    if (/\.\s*(select|insert|update|upsert|delete)\b/i.test(win) && !fromRe.test(win)) {
      out.push(`${label}: acceso directo a arca_config (encadenado)`)
    }
  }

  // 2. cert_file: null → borrado accidental del certificado.
  if (/cert_file\s*:\s*null\b/i.test(code)) out.push(`${label}: cert_file: null (borraría el certificado)`)

  // 3. Fuga de private_key (permitiendo solo el flag has_private_key_configured).
  const codeNoFlag = code.replace(/has_private_key_configured/g, '')
  if (/private_key/i.test(codeNoFlag)) out.push(`${label}: referencia a private_key en el frontend`)

  // 4. uploadCertificate (método cliente inseguro, retirado).
  if (/\buploadCertificate\b/.test(code)) out.push(`${label}: uploadCertificate cliente (retirado, aceptaba la clave)`)

  // 5. spread dentro de save_arca_config_legacy (mass-assignment).
  const rpcIdx = code.indexOf('save_arca_config_legacy')
  if (rpcIdx >= 0) {
    const win = code.slice(rpcIdx, rpcIdx + 500)
    if (/\.\.\./.test(win.split('}')[0] || '')) out.push(`${label}: spread (...) hacia save_arca_config_legacy`)
  }
  return out
}

function walk(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) files.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(name)) files.push(p)
  }
  return files
}

export function repoFindings() {
  const files = walk(SRC)
  const bad = []
  let corpus = ''
  for (const f of files) {
    const raw = readFileSync(f, 'utf8')
    corpus += '\n' + raw
    for (const h of fileFindings(raw, f.replace(/\\/g, '/'))) bad.push(h)
  }
  const clean = stripComments(corpus)
  for (const rpc of REQUIRED_RPCS) {
    if (!clean.includes(rpc)) bad.push(`falta uso de la RPC del contrato seguro: ${rpc}`)
  }
  return bad
}

function selfTest() {
  const cases = [
    { n: '1 estado correcto (RPC)', exp: 0, sql: "supabase.rpc('save_arca_config_legacy', { p_business_id: id, p_cuit: c })" },
    { n: '2 select(*) directo', min: 1, sql: "supabase.from('arca_config').select('*')" },
    { n: '3 select(id) directo', min: 1, sql: "supabase.from('arca_config').select('id').eq('business_id', id)" },
    { n: '4 update directo', min: 1, sql: "supabase.from('arca_config').update({ estado_conexion: 'error' })" },
    { n: '5 upsert directo', min: 1, sql: "supabase.from('arca_config').upsert(x, { onConflict: 'business_id' })" },
    { n: '6 cert_file:null', min: 1, sql: "const payload = { cert_file: null, cuit }" },
    { n: '7 método con private_key', min: 1, sql: "async function up(type: 'cert_file' | 'private_key') {}" },
    { n: '8 uploadCertificate', min: 1, sql: "await ArcaService.uploadCertificate(id, 'cert_file', x)" },
    { n: '9 spread hacia save RPC', min: 1, sql: "supabase.rpc('save_arca_config_legacy', { p_business_id: id, ...fields })" },
    { n: '10 flag de presencia NO es fuga', exp: 0, sql: "if (config.has_private_key_configured) doThing()" },
    { n: '11 arca_parametros NO es arca_config', exp: 0, sql: "supabase.from('arca_parametros').select('datos')" },
    { n: '12 comentario con private_key NO es fuga', exp: 0, sql: "// aceptaba private_key en el frontend" },
  ]
  let fail = 0
  for (const c of cases) {
    const got = fileFindings(c.sql).length
    const ok = c.exp !== undefined ? got === c.exp : got >= c.min
    if (!ok) fail++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.n}": ${got}${ok ? '' : ` (${fileFindings(c.sql).slice(0, 2).join(' | ')})`}`)
  }
  if (fail) { console.error(`\n❌ self-test: ${fail} fallo(s)`); process.exit(1) }
  console.log(`\n✅ self-test: las ${cases.length} fixtures OK`)
}

const isCLI = process.argv[1] && process.argv[1].endsWith('guard-afip-s1b-a2.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const bad = repoFindings()
  if (bad.length) {
    console.error('❌ Guard AFIP-S1B-A2:\n')
    for (const b of bad) console.error('  · ' + b)
    process.exit(1)
  }
  console.log('✅ Guard AFIP-S1B-A2 OK: frontend sin DML directo a arca_config, sin private_key, sin uploadCertificate; usa las 4 RPC del contrato seguro.')
}
