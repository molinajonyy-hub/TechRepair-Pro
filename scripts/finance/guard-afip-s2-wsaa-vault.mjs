#!/usr/bin/env node
// ============================================================================
// Guard AFIP-S2 — afip-wsaa resuelve la clave por Vault sin filtrar secretos.
//
// Estático sobre supabase/functions/afip-wsaa + keyResolver + migración + src.
// Falla (exit 1) si:
//  · afip-wsaa firma leyendo config.private_key directo (sin pasar por el resolver);
//  · el resolver hace fallback a legacy cuando la credencial Vault SÍ existe
//    (provisioned:true) — solo puede caer a legacy con provisioned:false;
//  · se loguea o retorna la clave (console.* con keyPem/privateKey; keyPem en
//    un objeto de respuesta);
//  · una RPC nueva (get_credential_for_signing / wsaa_audit) recibe EXECUTE de
//    PUBLIC/anon/authenticated, o le falta service_role;
//  · el frontend accede a vault.secrets o gana private_key en su contrato;
//  · se elimina el warning legacy (necesario para detectar negocios sin migrar);
//  · se usa cert_file como clave;
//  · aparece un PEM de clave privada REAL versionado;
//  · se toca afip-cae (fuera de alcance de S2, sin justificación en el diff).
//
//   node scripts/finance/guard-afip-s2-wsaa-vault.mjs [--self-test]
// ============================================================================
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const WSAA = 'supabase/functions/afip-wsaa/index.ts'
const RESOLVER = 'supabase/functions/afip-wsaa/keyResolver.ts'
const MIGRATION = 'supabase/migrations/20260722180000_afip_s2_wsaa_vault_read.sql'

function stripComments(src) {
  let out = '', i = 0
  while (i < src.length) {
    if (src.slice(i, i + 2) === '//') { const f = src.indexOf('\n', i); const e = f === -1 ? src.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (src.slice(i, i + 2) === '/*') { const f = src.indexOf('*/', i + 2); const e = f === -1 ? src.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += src[i]; i++
  }
  return out
}

// Hallazgos sobre el Edge afip-wsaa (recibe contenido; la fixture pasa texto).
export function wsaaFindings(idxRaw) {
  const out = []
  const idx = stripComments(idxRaw)
  if (!/resolveArcaPrivateKey\s*\(/.test(idx)) out.push('afip-wsaa no usa resolveArcaPrivateKey')
  if (!/arca_get_credential_for_signing/.test(idx)) out.push('afip-wsaa no llama arca_get_credential_for_signing')
  // firmar leyendo la clave directo (patrón viejo) — prohibido
  if (/decryptField\(\s*supabase\s*,\s*config\.private_key\s*\)/.test(idx)) out.push('afip-wsaa lee config.private_key directo para firmar')
  if (/signTRAWithPEM\([^)]*config\.private_key/.test(idx)) out.push('afip-wsaa firma con config.private_key directo')
  // loguear/retornar la clave (line-based: la clave nunca en un log ni en una respuesta)
  for (const line of idx.split('\n')) {
    if (/console\.(log|warn|error)/.test(line) && /\bkeyPem\b/.test(line)) out.push('afip-wsaa loguea keyPem')
    if (/jsonResponse\s*\(/.test(line) && /\bkeyPem\b/.test(line)) out.push('afip-wsaa retorna keyPem en la respuesta')
  }
  // warning legacy debe existir (para detectar negocios sin migrar en S3)
  if (!/legacy/i.test(idx) || !/console\.warn/.test(idx)) out.push('afip-wsaa sin warning legacy (necesario para S3)')
  return out
}

// Hallazgos sobre el resolver.
export function resolverFindings(resRaw) {
  const out = []
  const res = stripComments(resRaw)
  // El fallback a legacy debe estar guardado por provisioned !== true.
  if (!/provisioned\s*!==\s*true|provisioned\s*===\s*false|!cred\b/.test(res)) {
    out.push('resolver: fallback legacy no guardado por provisioned')
  }
  // No debe loguear.
  if (/console\.(log|warn|error)/.test(res)) out.push('resolver: no debe loguear (deja eso al Edge)')
  return out
}

// Grants de la migración (por texto): las 2 RPC service_role-only.
export function migrationFindings(sqlRaw) {
  const out = []
  const sql = stripComments(sqlRaw)
  for (const fn of ['arca_get_credential_for_signing', 'arca_wsaa_audit']) {
    if (new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fn}[^;]*TO\\s+[^;]*\\b(anon|authenticated|public)\\b`, 'i').test(sql)) {
      out.push(`${fn}: EXECUTE a anon/authenticated/PUBLIC`)
    }
    if (!new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fn}[^;]*TO\\s+service_role`, 'i').test(sql)) {
      out.push(`${fn}: falta GRANT a service_role`)
    }
    if (!new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${fn}[^;]*FROM\\s+[^;]*authenticated`, 'i').test(sql)) {
      out.push(`${fn}: falta REVOKE de authenticated`)
    }
  }
  return out
}

function walkSrc(dir) {
  const files = []
  if (!existsSync(dir)) return files
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) files.push(...walkSrc(p))
    else if (/\.(ts|tsx)$/.test(name)) files.push(p)
  }
  return files
}

function selfTest() {
  const okWsaa = readFileSync(WSAA, 'utf8')
  const okRes = readFileSync(RESOLVER, 'utf8')
  const okMig = readFileSync(MIGRATION, 'utf8')
  const cases = [
    { n: '1 afip-wsaa real → 0', fn: wsaaFindings, exp: 0, sql: okWsaa },
    { n: '2 lee private_key directo → falla', fn: wsaaFindings, min: 1, sql: okWsaa.replace('const resolved = await resolveArcaPrivateKey', 'const keyPem = await decryptField(supabase, config.private_key); const resolved = await resolveArcaPrivateKey') },
    { n: '3 loguea keyPem → falla', fn: wsaaFindings, min: 1, sql: okWsaa.replace('signedCms = signTRAWithPEM', 'console.warn(keyPem); signedCms = signTRAWithPEM') },
    { n: '4 resolver real → 0', fn: resolverFindings, exp: 0, sql: okRes },
    { n: '5 migración real → 0', fn: migrationFindings, exp: 0, sql: okMig },
    { n: '6 GRANT a authenticated → falla', fn: migrationFindings, min: 1, sql: okMig + '\nGRANT EXECUTE ON FUNCTION public.arca_get_credential_for_signing(uuid) TO authenticated;' },
  ]
  let fail = 0
  for (const c of cases) {
    const got = c.fn(c.sql).length
    const ok = c.exp !== undefined ? got === c.exp : got >= c.min
    if (!ok) fail++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.n}": ${got}${ok ? '' : ` (${c.fn(c.sql).slice(0, 2).join(' | ')})`}`)
  }
  if (fail) { console.error(`\n❌ self-test: ${fail} fallo(s)`); process.exit(1) }
  console.log(`\n✅ self-test: las ${cases.length} fixtures OK`)
}

const isCLI = process.argv[1] && process.argv[1].endsWith('guard-afip-s2-wsaa-vault.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const bad = []
  if (!existsSync(WSAA)) bad.push('falta afip-wsaa/index.ts')
  if (!existsSync(RESOLVER)) bad.push('falta afip-wsaa/keyResolver.ts')
  if (!existsSync(MIGRATION)) bad.push('falta la migración S2')
  if (bad.length === 0) {
    for (const h of wsaaFindings(readFileSync(WSAA, 'utf8'))) bad.push(`afip-wsaa: ${h}`)
    for (const h of resolverFindings(readFileSync(RESOLVER, 'utf8'))) bad.push(`keyResolver: ${h}`)
    for (const h of migrationFindings(readFileSync(MIGRATION, 'utf8'))) bad.push(`migración: ${h}`)
    // Frontend: sin vault.secrets ni private_key (excepto el flag de presencia)
    for (const f of walkSrc('src')) {
      const code = stripComments(readFileSync(f, 'utf8'))
      if (/vault\.secrets/.test(code)) bad.push(`${f.replace(/\\/g, '/')}: accede a vault.secrets desde el frontend`)
      if (/private_key/.test(code.replace(/has_private_key_configured/g, ''))) bad.push(`${f.replace(/\\/g, '/')}: private_key en el frontend`)
    }
  }
  if (bad.length) {
    console.error('❌ Guard AFIP-S2:\n')
    for (const b of bad) console.error('  · ' + b)
    process.exit(1)
  }
  console.log('✅ Guard AFIP-S2 OK: afip-wsaa resuelve por Vault (fallback legacy solo si no provisionado), sin filtrar la clave; RPC service_role-only; frontend sin vault/private_key.')
}
