#!/usr/bin/env node
/**
 * Guard AFIP-S4B-2C — protege el contrato de finalización auditada.
 *
 * Falla (exit 1) si:
 *   - el frontend finaliza con UPDATE directo sobre la rotación o el vencimiento;
 *   - la RPC de finalización deja de ser service_role-only o SECURITY DEFINER;
 *   - no se exige evidencia WSAA POSTERIOR a la activación;
 *   - se acepta una resolución legacy o fallida como evidencia;
 *   - no se compara el fingerprint de la evidencia WSAA;
 *   - expires_at viene del navegador o se hardcodea una fecha;
 *   - la finalización modifica cert_file, el secreto activo o la credencial;
 *   - se borran secretos o checkpoints;
 *   - se toca arca_config.private_key;
 *   - el rollback deja de estar disponible desde `completed` (antes de S4C);
 *   - se invoca WSAA/AFIP;
 *   - se imprime token/sign/JWT/certificado;
 *   - falta idempotencia;
 *   - falta el test de concurrencia o el de rollback desde completed;
 *   - algún archivo del repo referencia el certificado PRODUCTIVO.
 *
 * RUN: node scripts/finance/guard-afip-s4b2c-finalize-rotation.mjs [--self-test]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = process.cwd()
const MIG = 'supabase/migrations/20260727180000_afip_s4b2c_finalize_verified_rotation.sql'
const EDGE = 'supabase/functions/arca-rotate-activate/index.ts'
const VALIDATE = 'supabase/functions/arca-rotate-activate/validate.ts'
const SQLTEST = 'supabase/tests/security_afip_s4b2c_finalize_rotation_test.sql'
const HARNESS = 'scripts/finance/arca-s4b2c-finalize-concurrency.mjs'
const SELF = 'scripts/finance/guard-afip-s4b2c-finalize-rotation.mjs'

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const stripSql = (s) => s.replace(/^\s*--.*$/gm, ' ')
const stripTs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

/** Rutas/artefactos del certificado PRODUCTIVO que jamás deben tocarse desde el repo. */
const PROD_CERT_MARKERS = [
  /afip-s4b1-csr-\d{8}-\d{6}/,
  /pre-afip-s4b2b-\d{8}-\d{6}/,
  /C:\\+Backups\\+TechRepairPro/i,
]
/** Vencimiento real del certificado productivo: jamás debe estar escrito en el repo. */
const FECHA_HARDCODEADA = /2028-0?7-25/

function analyze(migRaw, edgeRaw, validateRaw, sqlTest, harness, repoFiles) {
  const fails = []
  const req = (cond, msg) => { if (!cond) fails.push(msg) }
  const mig = stripSql(migRaw)
  const edge = stripTs(edgeRaw)
  const val = stripTs(validateRaw)

  // ── Contrato de la RPC ─────────────────────────────────────────────────────
  req(/CREATE OR REPLACE FUNCTION public\.arca_finalize_certificate_rotation/.test(mig),
    'debe existir public.arca_finalize_certificate_rotation')
  req(/SECURITY DEFINER/.test(mig) && /SET search_path\s*=/.test(mig),
    'la RPC debe ser SECURITY DEFINER con search_path fijo')
  req(/auth\.role\(\)\s*IS DISTINCT FROM\s*'service_role'/.test(mig),
    'la RPC debe tener gate interno service_role')
  req(/REVOKE ALL ON FUNCTION public\.arca_finalize_certificate_rotation[\s\S]{0,200}?FROM PUBLIC/.test(mig)
    && /FROM anon, authenticated/.test(mig)
    && /GRANT\s+EXECUTE ON FUNCTION public\.arca_finalize_certificate_rotation[\s\S]{0,120}?TO service_role/.test(mig),
    'la finalización debe ser service_role-only (revoke PUBLIC/anon/authenticated + grant service_role)')
  req(/pg_advisory_xact_lock/.test(mig), 'la finalización debe tomar advisory lock por negocio')
  req(/is_business_owner_or_admin/.test(mig), 'debe validar pertenencia del actor al negocio')

  // ── Evidencia WSAA posterior a la activación ───────────────────────────────
  req(/arca_wsaa_verification_evidence/.test(mig), 'debe existir la verificación de evidencia WSAA')
  req(/created_at\s*>\s*p_activated_at/.test(mig),
    'la evidencia WSAA debe exigir un timestamp POSTERIOR a la activación')
  req(/wsaa_private_key_resolved_legacy/.test(mig) && /WSAA_VERIFICATION_STALE/.test(mig),
    'una resolución legacy posterior debe invalidar la evidencia')
  req(/wsaa_private_key_resolution_failed/.test(mig),
    'una resolución fallida posterior debe invalidar la evidencia')
  req(/WSAA_FINGERPRINT_MISMATCH/.test(mig),
    'debe compararse el fingerprint contra el esperado y rechazar si difiere')
  req(/fingerprint_trunc IS DISTINCT FROM left\(lower\(btrim\(p_expected_fp\)\),16\)/.test(mig),
    'la evidencia con fingerprint debe compararse literalmente contra el esperado')
  req(/private_key_fingerprint IS DISTINCT FROM lower\(btrim\(p_expected_fp\)\)/.test(mig),
    'sin fingerprint en el evento, debe compararse el de la credencial vigente')
  req(/WSAA_VERIFICATION_NOT_FOUND/.test(mig), 'debe fallar si no hay evidencia WSAA')

  // ── expires_at: derivado server-side del X.509, nunca del cliente ──────────
  req(/arca_cert_validity/.test(mig) || /not_after/.test(mig), 'debe derivar notAfter del certificado')
  req(/expires_at\s*=\s*v_not_after/.test(mig),
    'expires_at debe escribirse con el notAfter derivado del certificado activo')
  req(!FECHA_HARDCODEADA.test(migRaw), 'no debe hardcodearse el vencimiento del certificado productivo')
  req(!/p_expires_at|p_not_after/.test(mig), 'la RPC NO debe recibir el vencimiento por parámetro')
  req(/expires_at/.test(val) && /FINALIZE_FORBIDDEN/.test(val),
    'el Edge debe rechazar expires_at (y demás material) en finalize')

  // ── La finalización no toca material ───────────────────────────────────────
  req(!/cert_file\s*=\s*p_/.test(mig), 'la finalización NO debe escribir cert_file desde un parámetro')
  req(/finalize_certificate_drift/.test(mig), 'debe verificar por readback que cert_file no cambió')
  req(/finalize_credential_drift/.test(mig), 'debe verificar por readback que el fingerprint activo no cambió')
  req(!/DELETE\s+FROM\s+vault\.secrets/i.test(mig), 'NO debe borrar secretos de Vault')
  req(!/(DELETE\s+FROM\s+private\.arca_credential_rotations|prev_secret_id\s*=\s*NULL)/i.test(mig),
    'NO debe borrar checkpoints')
  req(!/\bprivate_key\s*=/.test(mig), 'NO debe modificar arca_config.private_key')
  req(!/private_key_secret_id\s*=\s*v_(rot|cred)\.private_key_secret_id/.test(
    mig.slice(mig.indexOf('arca_finalize_certificate_rotation'), mig.indexOf('arca_rollback_certificate_rotation'))),
    'la finalización NO debe reasignar el secreto activo')

  // ── Rollback disponible desde completed (hasta S4C) ────────────────────────
  const rb = mig.slice(mig.indexOf('CREATE OR REPLACE FUNCTION public.arca_rollback_certificate_rotation'))
  req(/state IN \('activated_pending_verification','completed','rolled_back'\)/.test(rb),
    'el rollback debe aceptar también `completed` mientras no corra S4C')
  req(/PREVIOUS_SECRET_MISSING/.test(rb),
    'el rollback debe rechazarse fail-closed si el secreto anterior ya fue purgado')
  req(/expires_at\s*=\s*coalesce\(v_rot\.prev_expires_at/.test(rb),
    'el rollback debe restaurar el vencimiento anterior')
  req(/prev_expires_at/.test(mig), 'debe guardarse el vencimiento previo en el checkpoint')

  // ── Sin WSAA/AFIP dentro de la transacción ─────────────────────────────────
  req(!/afip-wsaa|afip-cae|functions\/v1\/|wsaa\.afip|servicios1\.afip/.test(mig),
    'la RPC NO debe invocar WSAA/AFIP')

  // ── Idempotencia ───────────────────────────────────────────────────────────
  req(/finalization_idempotency_key/.test(mig) && /finalization_request_hash/.test(mig),
    'debe haber idempotencia de finalización (key + request hash)')
  req(/ROTATION_ALREADY_COMPLETED/.test(mig) && /IDEMPOTENCY_CONFLICT/.test(mig),
    'deben existir los estados de replay y conflicto')

  // ── Auditoría ──────────────────────────────────────────────────────────────
  for (const ev of [
    'arca_certificate_rotation_finalization_started',
    'arca_certificate_rotation_completed',
    'arca_certificate_rotation_finalization_failed',
    'arca_certificate_rotation_finalization_replayed',
  ]) {
    req(mig.includes(ev), `falta el evento de auditoría ${ev}`)
  }
  req(/details/.test(mig) && /previous_state/.test(mig) && /current_state/.test(mig),
    'la auditoría debe registrar la transición de estado')

  // ── Edge ───────────────────────────────────────────────────────────────────
  req(/arca_finalize_certificate_rotation/.test(edge), 'el Edge debe delegar en la RPC de finalización')
  req(!/from\(['"]arca_config['"]\)/.test(edge), 'el Edge NO debe escribir arca_config directamente')
  req(/auth\.getUser\(\)/.test(edge) && /is_business_owner_or_admin/.test(edge),
    'el Edge debe validar JWT y membresía owner/admin')
  req(!/console\.(log|error|warn|info)/.test(edge) && !/console\.(log|error|warn|info)/.test(val),
    'el Edge NO debe loguear (evita filtrar token/sign, JWT o certificado)')
  req(!/afip-wsaa|afip-cae/.test(edge), 'el Edge NO debe invocar WSAA/CAE')
  req(/secret_id/.test(val) && !/secret_id:/.test(val.slice(val.indexOf('buildFinalizeResponse'))),
    'la respuesta de finalize no debe incluir secret_id')

  // ── Frontend: ninguna escritura directa del estado ni del vencimiento ──────
  const frontendWrites = repoFiles.filter((f) => f.startsWith('src/')).filter((f) => {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8')
    return /arca_credential_rotations/.test(t)
      || /from\(['"]arca_config['"]\)[\s\S]{0,400}?(update|upsert)[\s\S]{0,200}?expires_at/.test(t)
  })
  req(frontendWrites.length === 0,
    `el frontend NO debe finalizar ni escribir expires_at directamente (${frontendWrites.join(', ')})`)

  // ── Tests obligatorios ─────────────────────────────────────────────────────
  if (sqlTest) {
    req(/ROTATION_COMPLETED/.test(sqlTest) && /WSAA_VERIFICATION_NOT_FOUND/.test(sqlTest),
      'faltan los tests de finalización y de evidencia WSAA ausente')
    req(/WSAA_FINGERPRINT_MISMATCH/.test(sqlTest), 'falta el test de fingerprint WSAA distinto')
    req(/rollback desde completed/.test(sqlTest) && /ROTATION_ROLLED_BACK/.test(sqlTest),
      'falta el test de rollback desde completed')
    req(/rollback tras cleanup/.test(sqlTest), 'falta el test de rollback bloqueado tras el cleanup de S4C')
    req(/fallo intermedio/.test(sqlTest), 'falta el test de fallo intermedio')
    req(/private_key legacy idéntica/.test(sqlTest), 'falta el test de private_key legacy intacta')
  }
  if (harness) {
    req(/arca_finalize_certificate_rotation/.test(harness) && /arca_rollback_certificate_rotation/.test(harness),
      'falta la concurrencia finalización/rollback')
    req(/par cruzado/.test(harness), 'la concurrencia debe verificar que nunca haya par cruzado')
  }

  // ── El certificado PRODUCTIVO nunca entra al repo ni se referencia ─────────
  const crtFiles = repoFiles.filter((f) => /\.(crt|cer|p12|pfx)$/i.test(f))
  req(crtFiles.length === 0, `no debe haber certificados/keystores en el repo (${crtFiles.join(', ')})`)
  // Los guards contienen estos patrones como REGLAS de detección, no como
  // material: se excluyen para no marcarse entre sí (regla ≠ material).
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
    console.error('❌ Guard AFIP-S4B-2C FALLÓ:')
    for (const f of fails) console.error('  - ' + f)
    process.exit(1)
  }
  console.log('✅ Guard AFIP-S4B-2C OK: finalización service_role-only con evidencia WSAA posterior a la activación y fingerprint comparado, expires_at derivado del X.509, sin tocar material ni borrar secretos, rollback vigente desde completed y sin rastro del certificado productivo.')
}

function selfTest() {
  const mig = read(MIG), edge = read(EDGE), val = read(VALIDATE)
  const sqlTest = read(SQLTEST), harness = read(HARNESS), files = repoTracked()
  const clean = analyze(mig, edge, val, sqlTest, harness, files)
  if (clean.length) { console.error('SELF-TEST: la versión real tiene fallas:', clean); process.exit(1) }

  const bad = [
    ['RPC no service_role-only', mig.replace(/TO service_role/g, 'TO authenticated'), edge, val, sqlTest, harness],
    ['sin gate interno service_role', mig.replace(/auth\.role\(\) IS DISTINCT FROM 'service_role'/g, 'false'), edge, val, sqlTest, harness],
    ['sin advisory lock', mig.replace(/pg_advisory_xact_lock/g, 'noop_lock'), edge, val, sqlTest, harness],
    ['no valida evidencia WSAA posterior', mig.replace(/created_at > p_activated_at/g, 'true'), edge, val, sqlTest, harness],
    ['acepta resolución legacy', mig.replace(/wsaa_private_key_resolved_legacy/g, 'otro_evento'), edge, val, sqlTest, harness],
    ['ignora resoluciones fallidas', mig.replace(/wsaa_private_key_resolution_failed/g, 'otro_evento'), edge, val, sqlTest, harness],
    ['no compara fingerprint WSAA', mig.replace(/WSAA_FINGERPRINT_MISMATCH/g, 'OTRO'), edge, val, sqlTest, harness],
    ['expires_at no viene del certificado', mig.replace(/expires_at = v_not_after/g, 'expires_at = now()'), edge, val, sqlTest, harness],
    ['hardcodea el vencimiento productivo', mig + "\n-- vence 2028-07-25\n", edge, val, sqlTest, harness],
    ['recibe el vencimiento por parámetro', mig.replace(/p_idempotency_key text,/, 'p_idempotency_key text, p_expires_at timestamptz,'), edge, val, sqlTest, harness],
    ['borra secretos de Vault', mig + '\nDELETE FROM vault.secrets WHERE id = v_old;', edge, val, sqlTest, harness],
    ['borra el checkpoint', mig + '\nDELETE FROM private.arca_credential_rotations WHERE id = v_rot.id;', edge, val, sqlTest, harness],
    ['toca private_key legacy', mig + '\nUPDATE public.arca_config SET private_key = NULL;', edge, val, sqlTest, harness],
    ['sin readback de cert_file', mig.replace(/finalize_certificate_drift/g, 'otro'), edge, val, sqlTest, harness],
    ['rollback ya no acepta completed', mig.replace(/'activated_pending_verification','completed','rolled_back'/g, "'activated_pending_verification','rolled_back'"), edge, val, sqlTest, harness],
    ['rollback no restaura el vencimiento', mig.replace(/expires_at\s*=\s*coalesce\(v_rot\.prev_expires_at/g, 'estado_conexion = coalesce(v_rot.prev_estado_conexion'), edge, val, sqlTest, harness],
    ['invoca WSAA desde la RPC', mig + "\n-- llama functions/v1/afip-wsaa\n".replace('--', 'SELECT'), edge, val, sqlTest, harness],
    ['sin idempotencia', mig.replace(/finalization_idempotency_key/g, 'noop_idem'), edge, val, sqlTest, harness],
    ['Edge no delega en la RPC', mig, edge.replace(/arca_finalize_certificate_rotation/g, 'otra_rpc'), val, sqlTest, harness],
    ['Edge escribe arca_config', mig, edge + "\nawait admin.from('arca_config').update({})", val, sqlTest, harness],
    ['Edge loguea', mig, edge + "\nconsole.log('payload', body)", val, sqlTest, harness],
    ['Edge acepta expires_at', mig, edge, val.replace(/FINALIZE_FORBIDDEN/g, 'OTRA_LISTA'), sqlTest, harness],
    ['falta test de rollback desde completed', mig, edge, val, sqlTest.replace(/rollback desde completed/g, 'otra cosa'), harness],
    ['falta test de cleanup', mig, edge, val, sqlTest.replace(/rollback tras cleanup/g, 'otra cosa'), harness],
    ['falta test de fallo intermedio', mig, edge, val, sqlTest.replace(/fallo intermedio/g, 'otra cosa'), harness],
    ['falta concurrencia', mig, edge, val, sqlTest, harness.replace(/arca_finalize_certificate_rotation/g, 'otra_rpc')],
  ]

  let ok = true
  for (const [label, m, e, v, s, h] of bad) {
    const f = analyze(m, e, v, s, h, files)
    if (f.length === 0) { console.error('SELF-TEST FALLÓ: no detectó "' + label + '"'); ok = false }
    else console.log('  self-test detecta: ' + label)
  }

  // Referencia al certificado productivo desde el repo (archivo temporal).
  const fake = 'scripts/finance/__s4b2c_selftest_leak.mjs'
  try {
    fs.writeFileSync(path.join(ROOT, fake), "export const p = 'C:\\\\Backups\\\\TechRepairPro\\\\pre-afip-s4b2b-20260727-084746'\n")
    const f = analyze(mig, edge, val, sqlTest, harness, [...files, fake])
    if (!f.some((x) => x.includes('certificado productivo'))) {
      console.error('SELF-TEST FALLÓ: no detectó referencia al certificado productivo'); ok = false
    } else console.log('  self-test detecta: referencia al certificado productivo')
  } finally { fs.rmSync(path.join(ROOT, fake), { force: true }) }

  console.log(ok ? '\n✅ SELF-TEST OK' : '\n❌ SELF-TEST FALLÓ')
  process.exit(ok ? 0 : 1)
}

process.argv.includes('--self-test') ? selfTest() : run()
