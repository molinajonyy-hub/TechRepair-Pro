#!/usr/bin/env node
/**
 * Guard AFIP-S4A — verifica invariantes de seguridad del contrato de preparación
 * de rotación (migración + Edge), en estático. Falla (exit 1) si:
 *   - la clave nueva aparece en un RETURN / respuesta;
 *   - se escribe en arca_config;
 *   - se reemplaza/borra la credencial active;
 *   - se tocan cert_file/wsaa_token/wsaa_sign;
 *   - se invoca WSAA/CAE;
 *   - falta idempotencia, readback, advisory lock o el índice de una-pending;
 *   - CSR y Vault no comparan fingerprint;
 *   - las RPC no son service_role-only;
 *   - la clave se escribe a un archivo o se imprime.
 * Incluye SELF-TEST con fixtures buenas y malas.
 *
 * RUN: node scripts/finance/guard-afip-s4a-rotation-prepare.mjs [--self-test]
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
// El contrato de rotación vive en dos migraciones: S4A (mecanismo) y S4B-1b
// (subject mínimo y fiel). Se analizan como una sola unidad.
const MIG_FILES = [
  'supabase/migrations/20260724120000_afip_s4a_certificate_rotation_prepare.sql',
  'supabase/migrations/20260726130000_afip_s4b1b_minimal_csr_subject.sql',
]
const EDGE = 'supabase/functions/arca-rotate-prepare/index.ts'
const SQLTEST = 'supabase/tests/security_afip_s4a_rotation_prepare_test.sql'
const HARNESS = 'scripts/finance/arca-s4a-rotation-concurrency.mjs'

const readMig = () =>
  MIG_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n')

/** Quita comentarios TS: la cabecera documenta justamente qué cosas ya NO se hacen. */
function stripTsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/([^:])\/\/.*$/gm, '$1 ')
}

function analyze(migSql, rawEdgeTs, sqlTest = '', harness = '') {
  const fails = []
  const req = (cond, msg) => { if (!cond) fails.push(msg) }
  const edgeTs = stripTsComments(rawEdgeTs)

  // ── S4A.1: idempotencia end-to-end ─────────────────────────────────────────
  // El request_hash debe ser SEMÁNTICO: se computa desde v_canon, que NO puede
  // contener el fingerprint ni la clave (así el replay con otra clave coincide).
  const canonM = migSql.match(/v_canon\s*:=\s*([\s\S]*?);/i)
  req(!!canonM, 'debe existir un v_canon para el request_hash semántico')
  if (canonM) {
    const canon = canonM[1]
    req(!/fingerprint|p_key_pem|v_fp\b/i.test(canon),
      'el request_hash (v_canon) NO puede incluir fingerprint ni la clave')
    req(/subject/i.test(canon) && /business_id/i.test(canon),
      'el request_hash debe incluir la intención (subject + business_id)')
  }
  req(/v_req_hash\s*:=\s*encode\(extensions\.digest\(\s*v_canon/i.test(migSql),
    'v_req_hash debe derivar de v_canon (no del fingerprint)')
  // El replay (ALREADY_PREPARED) devuelve el CSR YA almacenado, no crea secreto.
  req(/ROTATION_ALREADY_PREPARED'[\s\S]{0,200}v_prev\.csr_pem/i.test(migSql),
    'ROTATION_ALREADY_PREPARED debe devolver el CSR almacenado (v_prev.csr_pem)')
  req(migSql.indexOf('ROTATION_ALREADY_PREPARED') < migSql.indexOf('vault.create_secret'),
    'el replay debe cortar ANTES de vault.create_secret (no crea secreto)')
  // Validación CSR↔pedido server-side.
  req(/arca_csr_subject/.test(migSql) &&
      /arca_canonical_subject\(v_csr_subj\)\s+IS\s+DISTINCT\s+FROM\s+private\.arca_canonical_subject\(v_auth_subj\)/i.test(migSql),
    'la DB debe validar el subject del CSR contra el AUTORIZADO (derivado del certificado vigente)')
  // Tests obligatorios presentes.
  if (sqlTest) req(/respuesta perdida/i.test(sqlTest) && /A2/.test(sqlTest),
    'falta el test de respuesta perdida (retry con otra clave, misma idem)')
  if (harness) req(/race-same/.test(harness) && /ALREADY_PREPARED/.test(harness),
    'falta la carrera con misma idempotency_key y claves distintas')

  // ── S4B-1b: identidad fiscal mínima y fiel ─────────────────────────────────
  // El Edge NO puede exigir razon_social ni inventar atributos del subject.
  req(!/razonSocial|razon_social/.test(edgeTs),
    'el Edge NO debe exigir ni usar razon_social')
  req(!/countryName|stateOrProvinceName|localityName/.test(edgeTs) ||
      !/'AR'|"AR"|Buenos Aires/.test(edgeTs),
    'el Edge NO debe agregar C=AR ni ST/L por default')
  req(!/organizationName['"]?\s*[,:]\s*value/.test(edgeTs) && !/name: 'organizationName', value: razon/.test(edgeTs),
    'el Edge NO debe convertir el alias/razón social en organización')
  req(!/business_settings/.test(edgeTs),
    'el Edge NO debe usar business_settings como fallback')
  // La identidad viene del contrato server-side, no del navegador.
  req(/arca_get_rotation_subject_safe/.test(edgeTs),
    'el Edge debe resolver el subject por arca_get_rotation_subject_safe')
  req(!/body\?\.(cuit|razon_social|provincia|localidad|pais|email)/.test(edgeTs),
    'el Edge NO debe aceptar identidad fiscal enviada por el navegador')

  // La DB compara el certificado vigente con alias/CUIT y rechaza extras.
  req(/arca_cert_subject/.test(migSql) && /arca_get_rotation_subject_safe/.test(migSql),
    'debe existir el resolver de subject derivado del certificado vigente')
  req(/CURRENT_CERTIFICATE_IDENTITY_MISMATCH/.test(migSql),
    'debe comparar CN/serialNumber del certificado vigente con alias/CUIT')
  req(/CSR_SUBJECT_MISMATCH/.test(migSql) &&
      /arca_canonical_subject\(v_csr_subj\)\s+IS\s+DISTINCT\s+FROM\s+private\.arca_canonical_subject\(v_auth_subj\)/i.test(migSql),
    'debe rechazar cualquier CSR cuyo subject no sea EXACTAMENTE el autorizado')
  req(/FISCAL_ALIAS_MISSING/.test(migSql) && /FISCAL_CUIT_MISSING/.test(migSql),
    'deben existir los estados FISCAL_ALIAS_MISSING / FISCAL_CUIT_MISSING')
  // No duplicar parsers DER: el walker X.500 es compartido.
  req(/arca_x500_name/.test(migSql),
    'el walker X.500 debe estar extraído y compartido (sin duplicar parsers DER)')
  // Tests obligatorios del subject mínimo y de los defaults silenciosos.
  if (sqlTest) {
    req(/CSR_SUBJECT_MISMATCH/.test(sqlTest) && /C=AR/.test(sqlTest),
      'falta el test de CSR con C=AR no solicitado')
    req(/optional_attributes_count/.test(sqlTest) && /razon_social NULL/.test(sqlTest),
      'falta el test de subject mínimo / razon_social NULL')
  }

  // ── Migración ──────────────────────────────────────────────────────────────
  // No toca arca_config (ni escritura ni update).
  req(!/\b(update|insert\s+into)\s+public\.arca_config/i.test(migSql),
    'la migración NO debe escribir en arca_config')
  // No toca la credencial active (tabla de credenciales) por UPDATE/DELETE.
  req(!/\b(update|delete\s+from)\s+private\.arca_private_key_credentials/i.test(migSql),
    'la migración NO debe modificar/borrar la credencial active')
  // No toca cert/token/sign.
  req(!/\b(cert_file|wsaa_token|wsaa_sign)\b\s*=/i.test(migSql),
    'la migración NO debe asignar cert_file/wsaa_token/wsaa_sign')
  // No invoca WSAA/CAE.
  req(!/afip-wsaa|afip-cae|arca_get_credential_for_signing|arca_wsaa_audit/i.test(migSql),
    'la migración NO debe invocar WSAA/CAE')
  // Idempotencia.
  req(/idempotency_key/.test(migSql) && /request_hash/.test(migSql) &&
      /unique\s*\(business_id,\s*idempotency_key\)/i.test(migSql),
    'debe haber idempotencia (idempotency_key + request_hash + UNIQUE)')
  // Advisory lock por negocio.
  req(/pg_advisory_xact_lock/.test(migSql), 'debe tomar pg_advisory_xact_lock por negocio')
  // Readback obligatorio del secreto Vault.
  req(/vault\.decrypted_secrets/.test(migSql) &&
      /readback_fingerprint_mismatch|v_readback_fp\s+IS\s+DISTINCT\s+FROM/i.test(migSql),
    'debe hacer readback del secreto Vault y comparar fingerprint')
  // Correspondencia CSR ↔ clave (fingerprint del SPKI del CSR).
  req(/arca_csr_public_key_fingerprint/.test(migSql) &&
      /v_csr_fp\s+IS\s+DISTINCT\s+FROM\s+v_fp/i.test(migSql),
    'debe comparar fp(SPKI del CSR) == fp(clave)')
  // A lo sumo UNA rotación pendiente por negocio (índice único parcial).
  req(/unique\s+index[^;]*arca_credential_rotations[^;]*where\s+state\s*=\s*'pending_rotation'/is.test(migSql),
    'debe existir índice único parcial de una-pending-por-negocio')
  // Estado pending_rotation existe y no reutiliza la tabla active.
  req(/pending_rotation/.test(migSql) && /arca_credential_rotations/.test(migSql),
    'la rotación pendiente vive en su tabla dedicada (arca_credential_rotations)')
  // service_role-only en ambas RPC.
  req(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.arca_prepare_certificate_rotation[\s\S]*?FROM\s+anon,\s*authenticated/i.test(migSql) &&
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.arca_prepare_certificate_rotation[\s\S]*?TO\s+service_role/i.test(migSql),
    'arca_prepare_certificate_rotation debe ser service_role-only')
  req(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.arca_cancel_certificate_rotation[\s\S]*?TO\s+service_role/i.test(migSql),
    'arca_cancel_certificate_rotation debe ser service_role-only')
  // El RETURN de la RPC nunca incluye la clave (p_key_pem / v_readback) en el jsonb.
  const returns = migSql.match(/RETURN\s+jsonb_build_object\([\s\S]*?\);/gi) || []
  req(returns.every(r => !/p_key_pem|v_readback\b/.test(r)),
    'ningún RETURN debe incluir la clave (p_key_pem/v_readback)')
  // El gate exige service_role a nivel función.
  req(/auth\.role\(\)\s+IS\s+DISTINCT\s+FROM\s+'service_role'/i.test(migSql),
    'la RPC debe validar auth.role()=service_role')
  // Cancelación solo pending, nunca active.
  req(/arca_cancel_certificate_rotation/.test(migSql) &&
      /state\s*=\s*'pending_rotation'/.test(migSql),
    'la cancelación debe operar solo sobre pending_rotation')

  // ── Edge ────────────────────────────────────────────────────────────────────
  // No escribe la clave en arca_config.
  req(!/from\(['"]arca_config['"]\)[\s\S]*?(update|insert)[\s\S]*?private_key/i.test(edgeTs),
    'el Edge NO debe escribir private_key en arca_config')
  req(!/\.from\(['"]arca_config['"]\)/.test(edgeTs),
    'el Edge de rotación NO debe tocar arca_config')
  // No INVOCA WSAA/CAE (invocación real, no menciones en comentarios).
  req(!/functions\/v1\/afip-(wsaa|cae)|invoke\(\s*['"]afip-(wsaa|cae)/i.test(edgeTs),
    'el Edge NO debe invocar WSAA/CAE')
  // Valida owner/admin.
  req(/is_business_owner_or_admin/.test(edgeTs), 'el Edge debe validar membresía owner/admin')
  // Llama a la RPC de preparación.
  req(/arca_prepare_certificate_rotation/.test(edgeTs), 'el Edge debe delegar en la RPC de preparación')
  // La variable de la clave privada (keyPem) SOLO puede aparecer en formas
  // permitidas: declaración, asignación (generación/limpieza) y como parámetro
  // p_key_pem de la RPC. Cualquier otro uso (p.ej. dentro de una respuesta) es fuga.
  const strippedKey = edgeTs
    .replace(/let keyPem[^\n]*/g, '')
    .replace(/keyPem\s*=\s*[^\n]*/g, '')
    .replace(/p_key_pem:\s*keyPem/g, '')
  req(!/\bkeyPem\b/.test(strippedKey),
    'keyPem solo puede usarse en generación, p_key_pem y limpieza (nunca en una respuesta)')
  req(/p_key_pem:\s*keyPem/.test(edgeTs), 'la clave va a la RPC como p_key_pem (a Vault), no al cliente')
  req(/keyPem\s*=\s*null/.test(edgeTs), 'el Edge debe limpiar la clave (keyPem=null)')
  // No escribe la clave a archivo.
  req(!/writeFileSync|Deno\.writeTextFile|Deno\.writeFile/.test(edgeTs),
    'el Edge NO debe escribir la clave a un archivo')

  return fails
}

function run() {
  const migSql = readMig()
  const edgeTs = fs.readFileSync(path.join(ROOT, EDGE), 'utf8')
  const sqlTest = fs.readFileSync(path.join(ROOT, SQLTEST), 'utf8')
  const harness = fs.readFileSync(path.join(ROOT, HARNESS), 'utf8')
  const fails = analyze(migSql, edgeTs, sqlTest, harness)
  if (fails.length) {
    console.error('❌ Guard AFIP-S4A FALLÓ:')
    for (const f of fails) console.error('  - ' + f)
    process.exit(1)
  }
  console.log('✅ Guard AFIP-S4A OK: rotación server-side sin clave en respuesta/archivo, no toca active/cert/token/arca_config, service_role-only, idempotente, con readback, advisory lock, una-pending y fp(CSR)==fp(Vault).')
}

function selfTest() {
  const migSql = readMig()
  const edgeTs = fs.readFileSync(path.join(ROOT, EDGE), 'utf8')
  const sqlTest = fs.readFileSync(path.join(ROOT, SQLTEST), 'utf8')
  const harness = fs.readFileSync(path.join(ROOT, HARNESS), 'utf8')
  // La versión real NO debe tener fallas.
  const clean = analyze(migSql, edgeTs, sqlTest, harness)
  if (clean.length) { console.error('SELF-TEST: la versión real tiene fallas:', clean); process.exit(1) }

  // Inyecciones maliciosas que el guard DEBE detectar.
  const bad = [
    // Nota: las inyecciones son GLOBALES — el contrato vive en DOS migraciones y
    // reemplazar solo la primera dejaría la copia buena de la segunda.
    ['clave en RETURN', migSql.replace(/RETURN jsonb_build_object\('ok', true, 'state', 'ROTATION_PREPARED',/g,
      "RETURN jsonb_build_object('ok', true, 'state', 'ROTATION_PREPARED', 'leak', p_key_pem,"), edgeTs],
    ['escribe arca_config', migSql + "\nUPDATE public.arca_config SET private_key = 'x';", edgeTs],
    ['toca credencial active', migSql + "\nUPDATE private.arca_private_key_credentials SET credential_status='x';", edgeTs],
    ['sin advisory lock', migSql.replace(/pg_advisory_xact_lock/g, 'noop_lock'), edgeTs],
    ['sin readback', migSql.replace(/vault\.decrypted_secrets/g, 'vault.nope'), edgeTs],
    ['sin comparación CSR', migSql.replace(/v_csr_fp\s+IS\s+DISTINCT\s+FROM\s+v_fp/gi, 'false'), edgeTs],
    ['Edge toca arca_config', migSql, edgeTs + "\nawait admin.from('arca_config').update({})"],
    ['Edge no limpia la clave', migSql, edgeTs.replace(/keyPem\s*=\s*null/, 'noop')],
    ['Edge filtra la clave en la respuesta', migSql,
      edgeTs.replace(/return jsonResponse\(req, \{\s*\n\s*ok: true,\s*\n\s*state,/,
        'return jsonResponse(req, {\n      ok: true,\n      keyPem,\n      state,')],
    ['Edge invoca WSAA', migSql, edgeTs + "\nawait admin.functions.invoke('afip-wsaa')"],
    ['request_hash incluye fingerprint', migSql.replace(/v_canon\s*:=\s*'arca_prepare_certificate_rotation\|'/g,
      "v_canon := lower(btrim(p_fingerprint)) || 'arca_prepare_certificate_rotation|'"), edgeTs],
    ['replay no devuelve el CSR almacenado', migSql.replace(/'csr_pem', v_prev\.csr_pem/g, "'csr_pem', p_csr_pem"), edgeTs],
    // ── S4B-1b ──
    ['Edge exige razon_social', migSql, edgeTs.replace(/const businessId = String\(body\?\.business_id \?\? ''\)/,
      "const razonSocial = String(body?.razon_social ?? '')\n  const businessId = String(body?.business_id ?? '')")],
    ['Edge agrega C=AR por default', migSql,
      edgeTs.replace(/csr\.setSubject\(attrs\)/, "csr.setSubject([...attrs, { name: 'countryName', value: 'AR' }])")],
    ['sin resolver de subject del certificado', migSql.replace(/arca_get_rotation_subject_safe/g, 'noop_resolver'),
      edgeTs.replace(/arca_get_rotation_subject_safe/g, 'noop_resolver')],
    ['sin comparación de identidad del certificado', migSql.replace(/CURRENT_CERTIFICATE_IDENTITY_MISMATCH/g, 'OTRO'), edgeTs],
    ['acepta subject arbitrario del CSR', migSql.replace(
      /private\.arca_canonical_subject\(v_csr_subj\) IS DISTINCT FROM private\.arca_canonical_subject\(v_auth_subj\)/g, 'false'), edgeTs],
    ['walker X.500 duplicado (no compartido)', migSql.replace(/arca_x500_name/g, 'inline_walker_copy'), edgeTs],
  ]
  let ok = true
  for (const [label, m, e] of bad) {
    const f = analyze(m, e)
    if (f.length === 0) { console.error('SELF-TEST FALLÓ: no detectó "' + label + '"'); ok = false }
    else console.log('  self-test detecta: ' + label)
  }
  if (!ok) process.exit(1)
  console.log('✅ Guard AFIP-S4A self-test OK (' + bad.length + ' inyecciones detectadas)')
}

if (process.argv.includes('--self-test')) selfTest()
else run()
