#!/usr/bin/env node
/**
 * Guard AFIP-S4B-2A — protege el contrato de activación/rollback atómicos.
 *
 * Falla (exit 1) si:
 *   - el Edge o el frontend escriben cert_file directamente;
 *   - la activación deja de ser atómica (sin advisory lock / sin checkpoint);
 *   - no se compara el SPKI o el subject del certificado;
 *   - se promueve la pending ANTES de validar el certificado;
 *   - se elimina la credencial o el secreto anterior;
 *   - falta el contrato de rollback;
 *   - se invoca WSAA/CAE dentro de la transacción;
 *   - se imprime certificado, JWT o secretos;
 *   - se toca arca_config.private_key;
 *   - falta idempotencia;
 *   - faltan los tests de par cruzado o de rollback;
 *   - algún test/script accede al certificado PRODUCTIVO o éste aparece en el repo.
 *
 * RUN: node scripts/finance/guard-afip-s4b2-atomic-activation.mjs [--self-test]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = process.cwd()
const MIG = 'supabase/migrations/20260727120000_afip_s4b2a_atomic_rotation_activation.sql'
const EDGE = 'supabase/functions/arca-rotate-activate/index.ts'
const VALIDATE = 'supabase/functions/arca-rotate-activate/validate.ts'
const SQLTEST = 'supabase/tests/security_afip_s4b2_atomic_activation_test.sql'
const HARNESS = 'scripts/finance/arca-s4b2-activation-concurrency.mjs'

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const stripSql = (s) => s.replace(/^\s*--.*$/gm, ' ')
const stripTs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

/** Rutas/artefactos del certificado PRODUCTIVO que jamás deben tocarse desde el repo. */
const PROD_CERT_MARKERS = [
  /afip-s4b1-csr-\d{8}-\d{6}/,
  /Descargas Disco C/,
  /C:\\+Backups\\+TechRepairPro/i,
]

function analyze(migRaw, edgeRaw, validateRaw, sqlTest, harness, repoFiles) {
  const fails = []
  const req = (cond, msg) => { if (!cond) fails.push(msg) }
  const mig = stripSql(migRaw)
  const edge = stripTs(edgeRaw)
  const val = stripTs(validateRaw)

  // ── Validación criptográfica antes de escribir ─────────────────────────────
  req(/arca_validate_rotation_certificate/.test(mig), 'debe existir la validación estructural del certificado')
  req(/arca_rsa_public_key_fingerprint_sha256/.test(mig), 'debe comparar el SPKI (fingerprint canónico)')
  req(/arca_canonical_subject/.test(mig) && /CERTIFICATE_SUBJECT_MISMATCH/.test(mig),
    'debe comparar el subject y rechazar con CERTIFICATE_SUBJECT_MISMATCH')
  req(/CERTIFICATE_EXPIRED/.test(mig) && /CERTIFICATE_NOT_YET_VALID/.test(mig) && /arca_cert_validity/.test(mig),
    'debe validar la vigencia del certificado')
  // La validación tiene que ocurrir ANTES de promover la credencial.
  const iValidate = mig.indexOf('arca_validate_rotation_certificate(')
  const iPromote = mig.indexOf('UPDATE private.arca_private_key_credentials SET')
  req(iValidate > -1 && iPromote > -1 && iValidate < iPromote,
    'la validación del certificado debe ocurrir ANTES de promover la pending')

  // ── Atomicidad, checkpoint y rollback ──────────────────────────────────────
  req(/pg_advisory_xact_lock/.test(mig), 'la activación debe tomar advisory lock por negocio')
  req(/prev_secret_id/.test(mig) && /prev_certificate_pem/.test(mig) && /prev_fingerprint/.test(mig),
    'debe guardar checkpoint del par anterior (secreto, fingerprint y certificado)')
  req(/rollback_candidate/.test(mig), 'el par anterior debe quedar marcado como rollback_candidate')
  req(/arca_rollback_certificate_rotation/.test(mig), 'debe existir el contrato de rollback')
  req(/ACTIVATION_READBACK_FAILED/.test(mig) && /arca_get_private_key_for_signing/.test(mig),
    'debe hacer readback final tras promover')
  // El secreto anterior NO se borra (es el rollback).
  req(!/DELETE\s+FROM\s+vault\.secrets/i.test(mig), 'la activación/rollback NO deben borrar secretos de Vault')
  req(!/DELETE\s+FROM\s+private\.arca_private_key_credentials/i.test(mig),
    'no debe eliminarse la credencial anterior')

  // ── Idempotencia ───────────────────────────────────────────────────────────
  req(/activation_idempotency_key/.test(mig) && /activation_request_hash/.test(mig),
    'debe haber idempotencia de activación (key + request hash)')
  req(/ACTIVATION_ALREADY_APPLIED/.test(mig) && /IDEMPOTENCY_CONFLICT/.test(mig),
    'deben existir los estados de replay y conflicto')

  // ── Sin WSAA dentro de la transacción ──────────────────────────────────────
  req(!/afip-wsaa|afip-cae|functions\/v1\//.test(mig), 'la RPC NO debe invocar WSAA/CAE')
  req(/wsaa_token\s*=\s*NULL/i.test(mig) && /activation_pending_wsaa_verification/.test(mig),
    'debe invalidar el cache WSAA y dejar el estado de verificación pendiente')

  // ── private_key legacy intacta ─────────────────────────────────────────────
  req(!/\bprivate_key\s*=/.test(mig), 'la activación NO debe modificar arca_config.private_key')

  // ── Edge ───────────────────────────────────────────────────────────────────
  req(!/from\(['"]arca_config['"]\)/.test(edge), 'el Edge NO debe escribir arca_config directamente')
  req(/auth\.getUser\(\)/.test(edge) && /is_business_owner_or_admin/.test(edge),
    'el Edge debe validar JWT y membresía owner/admin')
  req(/arca_activate_certificate_rotation/.test(edge) && /arca_rollback_certificate_rotation/.test(edge),
    'el Edge debe delegar en las RPC de activación y rollback')
  req(!/console\.(log|error|warn|info)/.test(edge) && !/console\.(log|error|warn|info)/.test(val),
    'el Edge NO debe loguear (evita filtrar certificado, JWT o secretos)')
  req(/PRIVATE_KEY_NOT_ACCEPTED/.test(val), 'el Edge debe rechazar cualquier clave privada')
  req(!/afip-wsaa|afip-cae/.test(edge), 'el Edge NO debe invocar WSAA/CAE')

  // ── Frontend: ninguna escritura directa de cert_file ───────────────────────
  const frontendCertWrites = repoFiles.filter((f) => f.startsWith('src/')).filter((f) => {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8')
    return /from\(['"]arca_config['"]\)[\s\S]{0,400}?(update|insert|upsert)[\s\S]{0,200}?cert_file/.test(t)
  })
  req(frontendCertWrites.length === 0,
    `el frontend NO debe escribir cert_file directamente (${frontendCertWrites.join(', ')})`)

  // ── Tests obligatorios ─────────────────────────────────────────────────────
  if (sqlTest) {
    req(/CERTIFICATE_KEY_MISMATCH/.test(sqlTest) && /clave activa vieja/.test(sqlTest),
      'falta el test de par cruzado (certificado de la clave vieja)')
    req(/ROTATION_ROLLED_BACK/.test(sqlTest) && /ROLLBACK_ALREADY_APPLIED/.test(sqlTest),
      'faltan los tests de rollback y su replay')
    req(/VAULT_READBACK_FAILED/.test(sqlTest), 'falta el test de fallo intermedio')
  }
  if (harness) {
    req(/par cruzado/.test(harness) && /arca_rollback_certificate_rotation/.test(harness),
      'falta la concurrencia activación/rollback con verificación de par cruzado')
  }

  // ── El certificado PRODUCTIVO nunca entra al repo ni se referencia ─────────
  const crtFiles = repoFiles.filter((f) => /\.(crt|cer|p12|pfx)$/i.test(f))
  req(crtFiles.length === 0, `no debe haber certificados/keystores en el repo (${crtFiles.join(', ')})`)
  // Los guards contienen los patrones como REGLAS de detección: se excluyen para
  // no marcarse entre sí (regla ≠ material). AFIP-S4C extendió esta excepción,
  // que antes cubría sólo a este archivo, a todos los guards.
  const SELF = 'scripts/finance/guard-afip-s4b2-atomic-activation.mjs'
  const esGuard = (f) => /^scripts\/finance\/guard-.*\.mjs$/.test(f)
  const leaking = repoFiles.filter((f) => f !== SELF && !esGuard(f)).filter((f) => {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8')
    return PROD_CERT_MARKERS.some((re) => re.test(t))
  })
  req(leaking.length === 0,
    `ningún archivo del repo debe referenciar el certificado productivo ni su carpeta (${leaking.join(', ')})`)

  return fails
}

function repoTracked() {
  return execSync('git ls-files', { encoding: 'utf8', cwd: ROOT })
    .split(/\r?\n/).filter(Boolean)
    .filter((f) => fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile())
    .filter((f) => /\.(ts|tsx|js|jsx|mjs|sql|json|md)$/.test(f))
}

function run() {
  const fails = analyze(read(MIG), read(EDGE), read(VALIDATE), read(SQLTEST), read(HARNESS), repoTracked())
  if (fails.length) {
    console.error('❌ Guard AFIP-S4B-2A FALLÓ:')
    for (const f of fails) console.error('  - ' + f)
    process.exit(1)
  }
  console.log('✅ Guard AFIP-S4B-2A OK: activación atómica con validación SPKI+subject previa, checkpoint y rollback, sin borrar secretos, sin WSAA en la transacción, sin escritura directa de cert_file, y sin rastro del certificado productivo.')
}

function selfTest() {
  const mig = read(MIG), edge = read(EDGE), val = read(VALIDATE)
  const sqlTest = read(SQLTEST), harness = read(HARNESS), files = repoTracked()
  const clean = analyze(mig, edge, val, sqlTest, harness, files)
  if (clean.length) { console.error('SELF-TEST: la versión real tiene fallas:', clean); process.exit(1) }

  const bad = [
    ['sin comparación de SPKI', mig.replace(/arca_rsa_public_key_fingerprint_sha256/g, 'noop_fp'), edge, val, sqlTest, harness],
    ['sin comparación de subject', mig.replace(/CERTIFICATE_SUBJECT_MISMATCH/g, 'OTRO'), edge, val, sqlTest, harness],
    ['sin validación de vigencia', mig.replace(/arca_cert_validity/g, 'noop_validity'), edge, val, sqlTest, harness],
    ['sin advisory lock', mig.replace(/pg_advisory_xact_lock/g, 'noop_lock'), edge, val, sqlTest, harness],
    ['sin checkpoint', mig.replace(/prev_secret_id/g, 'noop_prev'), edge, val, sqlTest, harness],
    ['sin rollback', mig.replace(/arca_rollback_certificate_rotation/g, 'noop_rb'), edge, val, sqlTest, harness],
    ['borra secretos de Vault', mig + '\nDELETE FROM vault.secrets WHERE id = v_old;', edge, val, sqlTest, harness],
    ['elimina la credencial anterior', mig + '\nDELETE FROM private.arca_private_key_credentials WHERE business_id = p_business_id;', edge, val, sqlTest, harness],
    ['toca private_key legacy', mig + '\nUPDATE public.arca_config SET private_key = NULL;', edge, val, sqlTest, harness],
    ['sin idempotencia', mig.replace(/activation_idempotency_key/g, 'noop_idem'), edge, val, sqlTest, harness],
    ['sin readback final', mig.replace(/ACTIVATION_READBACK_FAILED/g, 'OTRO'), edge, val, sqlTest, harness],
    ['sin invalidar el cache WSAA', mig.replace(/activation_pending_wsaa_verification/g, 'conectado'), edge, val, sqlTest, harness],
    ['Edge escribe arca_config', mig, edge + "\nawait admin.from('arca_config').update({})", val, sqlTest, harness],
    ['Edge loguea', mig, edge + "\nconsole.log('cert', certPem)", val, sqlTest, harness],
    ['Edge acepta clave privada', mig, edge, val.replace(/PRIVATE_KEY_NOT_ACCEPTED/g, 'OTRO'), sqlTest, harness],
    ['falta test de par cruzado', mig, edge, val, sqlTest.replace(/clave activa vieja/g, 'otra cosa'), harness],
    ['falta test de rollback', mig, edge, val, sqlTest.replace(/ROLLBACK_ALREADY_APPLIED/g, 'OTRO'), harness],
    ['falta concurrencia de par cruzado', mig, edge, val, sqlTest, harness.replace(/par cruzado/g, 'otra cosa')],
  ]

  let ok = true
  for (const [label, m, e, v, s, h] of bad) {
    const f = analyze(m, e, v, s, h, files)
    if (f.length === 0) { console.error('SELF-TEST FALLÓ: no detectó "' + label + '"'); ok = false }
    else console.log('  self-test detecta: ' + label)
  }

  // Certificado productivo referenciado desde el repo (archivo temporal).
  const fake = 'scripts/finance/__s4b2_selftest_leak.mjs'
  try {
    fs.writeFileSync(path.join(ROOT, fake), "export const p = 'C:\\\\Backups\\\\TechRepairPro\\\\afip-s4b1-csr-20260726-205620'\n")
    const f = analyze(mig, edge, val, sqlTest, harness, [...files, fake])
    if (f.length === 0) { console.error('SELF-TEST FALLÓ: no detectó referencia al certificado productivo'); ok = false }
    else console.log('  self-test detecta: referencia al certificado productivo')
  } finally {
    if (fs.existsSync(path.join(ROOT, fake))) fs.unlinkSync(path.join(ROOT, fake))
  }

  if (!ok) process.exit(1)
  console.log('✅ Guard AFIP-S4B-2A self-test OK (' + (bad.length + 1) + ' inyecciones detectadas)')
}

if (process.argv.includes('--self-test')) selfTest()
else run()
