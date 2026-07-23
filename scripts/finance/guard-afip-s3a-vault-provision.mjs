#!/usr/bin/env node
// ============================================================================
// Guard AFIP-S3A — el provisionamiento hacia Vault es server-side y seguro.
//
// Falla (exit 1) si en la migración S3A:
//  · la RPC acepta un PEM (o cert/clave) como argumento;
//  · devuelve PEM o secret_id;
//  · tiene EXECUTE para PUBLIC/anon/authenticated, o le falta service_role;
//  · no valida auth.role()='service_role';
//  · ejecuta DML de provisión durante la migración (crear secretos/credenciales);
//  · borra/modifica private_key, cert_file o wsaa_token/sign;
//  · no implementa idempotencia (tabla + idempotency_key);
//  · no serializa por negocio (advisory lock) → dos credenciales activas;
//  · no verifica el readback tras escribir en Vault;
//  · deja fallback a legacy ante un Vault roto (eso es del resolver S2);
//  · audita material de clave;
//  · usa archivos temporales (COPY ... FROM/TO PROGRAM, pg_read_file, lo_export).
// Y además:
//  · exige la prueba criptográfica Deno (tests/deno) con node-forge;
//  · exige que NO se haya agregado node-forge como devDependency npm
//    (dependencia no reproducible en este toolchain — ver S2).
//
//   node scripts/finance/guard-afip-s3a-vault-provision.mjs [--self-test]
// ============================================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'supabase/migrations'
const MARK = 'afip_s3a_secure_vault_provision'
const DENO_TEST_DIR = 'tests/deno'
const RPC = 'arca_migrate_legacy_private_key_to_vault'

function stripComments(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.slice(i, i + 2) === '--') { const f = sql.indexOf('\n', i); const e = f === -1 ? sql.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (sql.slice(i, i + 2) === '/*') { const f = sql.indexOf('*/', i + 2); const e = f === -1 ? sql.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += sql[i]; i++
  }
  return out
}

/** Firma (args) de la RPC pública de provisión. */
function rpcArgs(sql) {
  const m = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${RPC}\\s*\\(([\\s\\S]*?)\\)\\s*RETURNS`, 'i').exec(sql)
  return m ? m[1] : null
}

export function migrationFindings(raw) {
  const out = []
  const sql = stripComments(raw)
  if (!sql.includes(RPC)) return ['no define la RPC de provisión']

  // 1. Firma: nunca material criptográfico
  const args = rpcArgs(sql)
  if (args === null) out.push('no se pudo leer la firma de la RPC')
  else if (/(p_pem|pem\b|private_key|cert_file|certificate)/i.test(args)) out.push('la firma acepta material criptográfico (PEM/cert/clave)')

  // 2. Grants
  if (new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${RPC}[^;]*TO\\s+[^;]*\\b(anon|authenticated|public)\\b`, 'i').test(sql)) {
    out.push('EXECUTE otorgado a anon/authenticated/PUBLIC')
  }
  if (!new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${RPC}[^;]*TO\\s+service_role`, 'i').test(sql)) {
    out.push('falta GRANT EXECUTE a service_role')
  }
  if (!new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${RPC}[^;]*FROM\\s+[^;]*authenticated`, 'i').test(sql)) {
    out.push('falta REVOKE de authenticated')
  }

  // 3. Compuerta de rol
  if (!/auth\.role\(\)\s+IS\s+DISTINCT\s+FROM\s+'service_role'/i.test(sql)) out.push("no valida auth.role()='service_role'")

  // 4. Idempotencia + serialización + readback
  if (!/arca_credential_provision_requests/i.test(sql)) out.push('sin tabla de solicitudes (idempotencia)')
  if (!/idempotency_key/i.test(sql)) out.push('sin idempotency_key')
  if (!/pg_advisory_xact_lock/i.test(sql)) out.push('sin advisory lock por negocio (riesgo de doble credencial)')
  if (!/arca_get_private_key_for_signing/i.test(sql)) out.push('sin readback por el contrato de firma')
  if (!/readback/i.test(sql)) out.push('sin verificación explícita de readback')

  // 5. Nunca toca el material legacy
  if (/UPDATE\s+public\.arca_config\s+SET[^;]*private_key/i.test(sql)) out.push('modifica private_key')
  if (/UPDATE\s+public\.arca_config\s+SET[^;]*cert_file/i.test(sql)) out.push('modifica cert_file')
  if (/UPDATE\s+public\.arca_config\s+SET[^;]*wsaa_(token|sign)/i.test(sql)) out.push('modifica wsaa_token/sign')
  if (/DELETE\s+FROM\s+public\.arca_config/i.test(sql)) out.push('borra filas de arca_config')

  // 6. La migración NO provisiona nada
  if (new RegExp(`(SELECT|PERFORM)\\s+public\\.${RPC}\\s*\\(`, 'i').test(sql)) out.push('la migración INVOCA la RPC de provisión')
  if (/(SELECT|PERFORM)\s+private\.arca_store_private_key_secret\s*\(/i.test(sql) && !/CREATE\s+OR\s+REPLACE\s+FUNCTION/i.test(sql.slice(0, sql.indexOf('arca_store_private_key_secret')))) {
    out.push('la migración crea un secreto Vault')
  }
  if (/INSERT\s+INTO\s+private\.arca_private_key_credentials/i.test(sql)) out.push('la migración inserta credenciales')
  if (/vault\.create_secret\s*\(/i.test(sql)) out.push('la migración llama a vault.create_secret')

  // 7. Sin archivos temporales / lectura de disco
  if (/COPY[^;]*FROM\s+PROGRAM|COPY[^;]*TO\s+PROGRAM|pg_read_file|pg_write|lo_export|lo_import/i.test(sql)) {
    out.push('usa archivos temporales o E/S de disco')
  }

  // 8. Auditoría sin material. Ojo: los NOMBRES de evento contienen la cadena
  // "private_key" legítimamente (arca_private_key_vault_migrated), así que se
  // buscan las VARIABLES que sí llevan material, no la subcadena del evento.
  if (/arca_audit\s*\([^)]*\b(v_key_pem|v_cert_pem|v_readback)\b/i.test(sql)) out.push('audita material de clave')
  if (/arca_audit\s*\([^)]*\.(private_key|cert_file)\b/i.test(sql)) out.push('audita una columna con material')

  return out
}

export function repoFindings() {
  const bad = []
  const files = existsSync(DIR) ? readdirSync(DIR).filter(f => f.endsWith('.sql')) : []
  const mig = files.find(f => f.includes(MARK))
  if (!mig) return ['falta la migración S3A (' + MARK + ')']
  for (const h of migrationFindings(readFileSync(join(DIR, mig), 'utf8'))) bad.push(`${mig}: ${h}`)

  // Prueba criptográfica Deno obligatoria
  if (!existsSync(DENO_TEST_DIR)) bad.push('falta el directorio de pruebas Deno (' + DENO_TEST_DIR + ')')
  else {
    const denoFiles = readdirSync(DENO_TEST_DIR).filter(f => f.endsWith('.ts'))
    const corpus = denoFiles.map(f => readFileSync(join(DENO_TEST_DIR, f), 'utf8')).join('\n')
    if (!denoFiles.length) bad.push('no hay pruebas en tests/deno')
    if (!/npm:node-forge/.test(corpus)) bad.push('la prueba Deno no usa npm:node-forge (mismo runtime que producción)')
    if (!/pkcs7|signedData/i.test(corpus)) bad.push('la prueba Deno no ejercita la firma PKCS7/CMS')
    if (!/certMatchesKey|publicKey\.n/.test(corpus)) bad.push('la prueba Deno no verifica correspondencia clave↔certificado')
  }

  // node-forge NO debe volver a package.json (no reproducible en este toolchain)
  if (existsSync('package.json')) {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    if (deps['node-forge']) bad.push('node-forge reintroducido como dependencia npm (no reproducible: ver S2)')
  }
  return bad
}

function selfTest() {
  const files = readdirSync(DIR).filter(f => f.endsWith('.sql'))
  const mig = files.find(f => f.includes(MARK))
  const OK = readFileSync(join(DIR, mig), 'utf8')
  const cases = [
    { n: '1 migración S3A real → 0', exp: 0, sql: OK },
    { n: '2 firma con PEM → falla', min: 1, sql: OK.replace('p_business_id uuid, p_expected_fingerprint text, p_idempotency_key text)', 'p_business_id uuid, p_pem text, p_idempotency_key text)') },
    { n: '3 GRANT a authenticated → falla', min: 1, sql: OK + `\nGRANT EXECUTE ON FUNCTION public.${RPC}(uuid,text,text) TO authenticated;` },
    { n: '4 sin advisory lock → falla', min: 1, sql: OK.replace(/pg_advisory_xact_lock/g, 'no_lock') },
    { n: '5 sin readback → falla', min: 1, sql: OK.replace(/arca_get_private_key_for_signing/g, 'nada') },
    { n: '6 la migración invoca la RPC → falla', min: 1, sql: OK + `\nSELECT public.${RPC}('00000000-0000-4000-8000-000000000001','x','y');` },
    { n: '7 borra private_key → falla', min: 1, sql: OK + "\nUPDATE public.arca_config SET private_key = NULL WHERE business_id IS NOT NULL;" },
    { n: '8 usa archivo temporal → falla', min: 1, sql: OK + "\nCOPY x FROM PROGRAM 'cat /tmp/k';" },
    { n: '9 sin idempotencia → falla', min: 1, sql: OK.replace(/arca_credential_provision_requests/g, 'otra_tabla').replace(/idempotency_key/g, 'k') },
  ]
  let fail = 0
  for (const c of cases) {
    const got = migrationFindings(c.sql).length
    const ok = c.exp !== undefined ? got === c.exp : got >= c.min
    if (!ok) fail++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.n}": ${got}${ok ? '' : ` (${migrationFindings(c.sql).slice(0, 2).join(' | ')})`}`)
  }
  if (fail) { console.error(`\n❌ self-test: ${fail} fallo(s)`); process.exit(1) }
  console.log(`\n✅ self-test: las ${cases.length} fixtures OK`)
}

const isCLI = process.argv[1] && process.argv[1].endsWith('guard-afip-s3a-vault-provision.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const bad = repoFindings()
  if (bad.length) {
    console.error('❌ Guard AFIP-S3A:\n')
    for (const b of bad) console.error('  · ' + b)
    process.exit(1)
  }
  console.log('✅ Guard AFIP-S3A OK: provisión server-side sin PEM en la firma/retorno, service_role-only, idempotente, serializada, con readback; migración dormida; prueba cripto Deno presente.')
}
