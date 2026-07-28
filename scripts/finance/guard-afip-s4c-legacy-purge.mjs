#!/usr/bin/env node
/**
 * Guard AFIP-S4C — protege la purga definitiva del material legacy.
 *
 * Falla (exit 1) si:
 *   - vuelve a existir un camino que lea o escriba arca_config.private_key;
 *   - el resolver o el Edge recuperan el fallback legacy;
 *   - la migración no elimina la columna;
 *   - la migración purga sin precondición fail-closed;
 *   - purga material de rotaciones que no están `completed`;
 *   - destruye el material sin auditarlo antes;
 *   - borra la fila de rotación (perdería la historia auditada);
 *   - borra el secreto ACTIVO;
 *   - el rollback no queda deshabilitado tras la purga;
 *   - falta el test de purga o el de rollback deshabilitado;
 *   - algún archivo del repo referencia el certificado productivo.
 *
 * RUN: node scripts/finance/guard-afip-s4c-legacy-purge.mjs [--self-test]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = process.cwd()
const MIG = 'supabase/migrations/20260727210000_afip_s4c_legacy_purge.sql'
const RESOLVER = 'supabase/functions/afip-wsaa/keyResolver.ts'
const EDGE = 'supabase/functions/afip-wsaa/index.ts'
const SQLTEST = 'supabase/tests/security_afip_s4c_legacy_purge_test.sql'
const SELF = 'scripts/finance/guard-afip-s4c-legacy-purge.mjs'

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const stripSql = (s) => s.replace(/^\s*--.*$/gm, ' ')
const stripTs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

const PROD_CERT_MARKERS = [
  /afip-s4b1-csr-\d{8}-\d{6}/,
  /pre-afip-s4b2b-\d{8}-\d{6}/,
  /C:\\+Backups\\+TechRepairPro/i,
]

function analyze(migRaw, resolverRaw, edgeRaw, sqlTest, repoFiles) {
  const fails = []
  const req = (cond, msg) => { if (!cond) fails.push(msg) }
  const mig = stripSql(migRaw)
  const res = stripTs(resolverRaw)
  const edge = stripTs(edgeRaw)

  // ── La columna en claro desaparece ─────────────────────────────────────────
  req(/ALTER TABLE public\.arca_config DROP COLUMN IF EXISTS private_key/.test(mig),
    'la migración debe ELIMINAR la columna arca_config.private_key')
  req(/information_schema\.columns[\s\S]{0,400}?private_key[\s\S]{0,400}?RAISE EXCEPTION/.test(mig),
    'debe verificar por post-condición que la columna ya no existe')

  // ── Precondición fail-closed antes de destruir nada ────────────────────────
  req(/AFIP-S4C ABORTA/.test(mig), 'la migración debe ABORTAR si algún negocio quedaría sin poder firmar')
  req(/credential_status = 'active'[\s\S]{0,300}?vault\.secrets/.test(mig),
    'la precondición debe exigir credencial activa con secreto vivo en Vault')
  req(/pending_rotation'?,'?activated_pending_verification|activated_pending_verification'\)/.test(mig),
    'la migración debe abortar si hay rotaciones sin finalizar')

  // ── Sólo se purga material de rotaciones completed ─────────────────────────
  const purga = mig.slice(mig.indexOf('DELETE FROM vault.secrets') - 900, mig.indexOf('DELETE FROM vault.secrets') + 200)
  req(/state = 'completed'/.test(purga), 'sólo puede purgarse el material de rotaciones `completed`')
  req(/prev_secret_id/.test(purga) && !/DELETE FROM vault\.secrets WHERE id = r\.private_key_secret_id/.test(mig),
    'debe purgarse el secreto ANTERIOR, jamás el activo')
  req(!/DELETE\s+FROM\s+private\.arca_credential_rotations/i.test(mig),
    'no debe borrarse la fila de rotación: la historia auditada se conserva')
  req(!/DELETE\s+FROM\s+private\.arca_private_key_credentials/i.test(mig),
    'no debe borrarse la credencial activa')

  // ── Auditar ANTES de destruir ──────────────────────────────────────────────
  req(/arca_legacy_private_key_purged/.test(mig) && /arca_previous_secret_purged/.test(mig)
    && /arca_rollback_disabled/.test(mig), 'faltan los eventos de auditoría de la purga')
  const iAudit = mig.indexOf('arca_legacy_private_key_purged')
  const iDrop = mig.indexOf('DROP COLUMN IF EXISTS private_key')
  req(iAudit > -1 && iDrop > -1 && iAudit < iDrop,
    'la clave en claro debe auditarse ANTES de eliminarla (después ya no se puede)')

  // ── El checkpoint se cierra conservando la historia ────────────────────────
  req(/prev_status\s*=\s*'purged'/.test(mig), 'el checkpoint debe quedar marcado como purgado')
  req(/prev_certificate_pem\s*=\s*NULL/.test(mig) && /prev_wsaa_token\s*=\s*NULL/.test(mig),
    'el material recuperable del checkpoint debe anularse')
  req(!/prev_fingerprint\s*=\s*NULL/.test(mig) && !/activated_at\s*=\s*NULL/.test(mig),
    'no deben borrarse fingerprints ni timestamps: son la trazabilidad')

  // ── Rollback deshabilitado de forma explícita ──────────────────────────────
  req(/ROLLBACK_PERMANENTLY_DISABLED/.test(mig), 'el rollback debe quedar deshabilitado con un estado explícito')
  req(/prev_status\s*=\s*'purged'[\s\S]{0,300}?ROLLBACK_PERMANENTLY_DISABLED/.test(mig),
    'el rollback debe rechazarse por prev_status=purged, no por un efecto colateral')

  // ── Vault-only en el camino de firma ───────────────────────────────────────
  req(!/legacyPrivateKey/.test(res), 'el resolver NO debe aceptar una clave alternativa')
  req(!/legacy_plaintext/.test(res), 'el resolver NO debe poder devolver origen legacy')
  req(/VAULT_CREDENTIAL_NOT_PROVISIONED/.test(res) && /throw new WsaaKeyError\('VAULT_CREDENTIAL_NOT_PROVISIONED'/.test(res),
    'sin credencial en Vault el resolver debe fallar (fail-closed)')
  req(!/config\.private_key/.test(edge), 'afip-wsaa NO debe leer arca_config.private_key')
  req(!/wsaa_private_key_resolved_legacy/.test(edge), 'afip-wsaa NO debe poder auditar una resolución legacy')
  req(/arca_get_credential_for_signing/.test(edge), 'afip-wsaa debe seguir resolviendo por el contrato Vault')

  // ── La presencia de clave se deriva de Vault ───────────────────────────────
  req(/has_private_key_configured/.test(mig) && /arca_private_key_credentials/.test(mig),
    'get_arca_config_safe debe derivar la presencia de clave desde Vault')

  // ── Ningún camino nuevo escribe una clave en claro ─────────────────────────
  const escritores = repoFiles.filter((f) => f.startsWith('src/') || f.startsWith('supabase/functions/')).filter((f) => {
    const t = stripTs(fs.readFileSync(path.join(ROOT, f), 'utf8'))
    return /from\(['"]arca_config['"]\)[\s\S]{0,400}?(update|insert|upsert)[\s\S]{0,200}?private_key/.test(t)
  })
  req(escritores.length === 0, `ningún archivo debe escribir arca_config.private_key (${escritores.join(', ')})`)

  // ── Tests obligatorios ─────────────────────────────────────────────────────
  if (sqlTest) {
    req(/la columna arca_config\.private_key NO existe/.test(sqlTest), 'falta el test de columna eliminada')
    req(/ROLLBACK_PERMANENTLY_DISABLED/.test(sqlTest), 'falta el test de rollback deshabilitado')
    req(/LEGACY_MIGRATION_RETIRED/.test(sqlTest), 'falta el test de la RPC de migración retirada')
    req(/conserva fingerprint y timestamps/.test(sqlTest), 'falta el test de historia conservada')
    req(/NO purgada sigue siendo revertible/.test(sqlTest), 'falta el test de que el rollback normal no se rompió')
  }

  // ── El certificado PRODUCTIVO nunca entra al repo ─────────────────────────
  const crtFiles = repoFiles.filter((f) => /\.(crt|cer|p12|pfx)$/i.test(f))
  req(crtFiles.length === 0, `no debe haber certificados/keystores en el repo (${crtFiles.join(', ')})`)
  const esGuard = (f) => /^scripts\/finance\/guard-.*\.mjs$/.test(f)
  const leaking = repoFiles.filter((f) => f !== SELF && !esGuard(f)).filter((f) => {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8')
    return PROD_CERT_MARKERS.some((re) => re.test(t))
  })
  req(leaking.length === 0, `ningún archivo debe referenciar el certificado productivo (${leaking.join(', ')})`)

  return fails
}

function repoTracked() {
  return execSync('git ls-files', { encoding: 'utf8', cwd: ROOT })
    .split(/\r?\n/).filter(Boolean)
    .filter((f) => fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile())
    .filter((f) => /\.(ts|tsx|js|jsx|mjs|sql|json|md)$/.test(f))
}

function run() {
  const fails = analyze(read(MIG), read(RESOLVER), read(EDGE), read(SQLTEST), repoTracked())
  if (fails.length) {
    console.error('❌ Guard AFIP-S4C FALLÓ:')
    for (const f of fails) console.error('  - ' + f)
    process.exit(1)
  }
  console.log('✅ Guard AFIP-S4C OK: columna en claro eliminada con precondición fail-closed y auditoría previa, purga limitada a rotaciones completed, historia conservada, rollback deshabilitado explícitamente y firma fiscal Vault-only.')
}

function selfTest() {
  const mig = read(MIG), res = read(RESOLVER), edge = read(EDGE), sqlTest = read(SQLTEST)
  const files = repoTracked()
  const clean = analyze(mig, res, edge, sqlTest, files)
  if (clean.length) { console.error('SELF-TEST: la versión real tiene fallas:', clean); process.exit(1) }

  const bad = [
    ['no elimina la columna', mig.replace(/ALTER TABLE public\.arca_config DROP COLUMN IF EXISTS private_key/g, '-- nada'), res, edge, sqlTest],
    ['sin precondición fail-closed', mig.replace(/AFIP-S4C ABORTA/g, 'aviso'), res, edge, sqlTest],
    ['purga rotaciones no completed', mig.replace(/state = 'completed' AND prev_secret_id IS NOT NULL/g, 'prev_secret_id IS NOT NULL'), res, edge, sqlTest],
    ['borra la fila de rotación', mig + '\nDELETE FROM private.arca_credential_rotations WHERE id = r.id;', res, edge, sqlTest],
    ['borra la credencial activa', mig + '\nDELETE FROM private.arca_private_key_credentials WHERE business_id = r.business_id;', res, edge, sqlTest],
    ['destruye sin auditar antes', mig.replace(/arca_legacy_private_key_purged/g, 'otro_evento'), res, edge, sqlTest],
    ['borra la trazabilidad', mig + "\nUPDATE private.arca_credential_rotations SET prev_fingerprint = NULL;", res, edge, sqlTest],
    ['no deshabilita el rollback', mig.replace(/ROLLBACK_PERMANENTLY_DISABLED/g, 'OTRO'), res, edge, sqlTest],
    ['no cierra el checkpoint', mig.replace(/prev_status\s*=\s*'purged'/g, "prev_status = 'restored'"), res, edge, sqlTest],
    ['presencia de clave no viene de Vault', mig.replace(/arca_private_key_credentials/g, 'otra_tabla'), res, edge, sqlTest],
    ['resolver recupera el fallback', mig, res.replace(/getVaultCredential: \(\) => Promise/, 'legacyPrivateKey: string\n  getVaultCredential: () => Promise'), edge, sqlTest],
    ['resolver ya no falla sin Vault', mig, res.replace(/throw new WsaaKeyError\('VAULT_CREDENTIAL_NOT_PROVISIONED'/g, "return ({} as any) || new Error('VAULT_CREDENTIAL_NOT_PROVISIONED'"), edge, sqlTest],
    ['el Edge vuelve a leer la columna', mig, res, edge + '\nconst k = config.private_key', sqlTest],
    ['el Edge vuelve a auditar legacy', mig, res, edge + "\nawait auditWsaaKeySource(s, b, 'wsaa_private_key_resolved_legacy', null, null)", sqlTest],
    ['falta test de columna eliminada', mig, res, edge, sqlTest.replace(/la columna arca_config\.private_key NO existe/g, 'otra cosa')],
    ['falta test de rollback deshabilitado', mig, res, edge, sqlTest.replace(/ROLLBACK_PERMANENTLY_DISABLED/g, 'OTRO')],
    ['falta test de historia conservada', mig, res, edge, sqlTest.replace(/conserva fingerprint y timestamps/g, 'otra cosa')],
  ]

  let ok = true
  for (const [label, m, r, e, s] of bad) {
    const f = analyze(m, r, e, s, files)
    if (f.length === 0) { console.error('SELF-TEST FALLÓ: no detectó "' + label + '"'); ok = false }
    else console.log('  self-test detecta: ' + label)
  }

  const fake = 'scripts/finance/__s4c_selftest_leak.mjs'
  try {
    fs.writeFileSync(path.join(ROOT, fake), "export const p = 'C:\\\\Backups\\\\TechRepairPro\\\\afip-s4b1-csr-20260726-205620'\n")
    const f = analyze(mig, res, edge, sqlTest, [...files, fake])
    if (!f.some((x) => x.includes('certificado productivo'))) {
      console.error('SELF-TEST FALLÓ: no detectó referencia al certificado productivo'); ok = false
    } else console.log('  self-test detecta: referencia al certificado productivo')
  } finally { fs.rmSync(path.join(ROOT, fake), { force: true }) }

  console.log(ok ? '\n✅ SELF-TEST OK' : '\n❌ SELF-TEST FALLÓ')
  process.exit(ok ? 0 : 1)
}

process.argv.includes('--self-test') ? selfTest() : run()
