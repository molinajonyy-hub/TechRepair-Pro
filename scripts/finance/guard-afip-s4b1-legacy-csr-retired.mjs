#!/usr/bin/env node
/**
 * Guard AFIP-S4B-1 — impide la reactivación del generador de CSR legacy.
 *
 * `generate-csr` generaba un par RSA en el Edge y ESCRIBÍA la clave privada en
 * `arca_config.private_key`. Ese flujo quedó retirado como stub fail-closed (410).
 * Este guard falla (exit 1) si el endpoint vuelve a:
 *   - generar RSA / manejar una clave privada;
 *   - escribir en arca_config (private_key, cert_file, token, sign, …);
 *   - acceder a Vault o a RPC fiscales;
 *   - invocar WSAA/CAE o ARCA;
 *   - devolver un CSR;
 *   - dejar de responder fail-closed (410);
 *   - usar service_role para modificar configuración fiscal;
 * …o si un consumidor del frontend vuelve a depender del endpoint legacy.
 *
 * RUN: node scripts/finance/guard-afip-s4b1-legacy-csr-retired.mjs [--self-test]
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
// La función legacy vive en dos archivos: el entrypoint y el handler testeable.
// Se analizan AMBOS como una sola unidad.
const LEGACY_FILES = [
  'supabase/functions/generate-csr/index.ts',
  'supabase/functions/generate-csr/handler.ts',
]
const FRONTEND_DIRS = ['src']

const readLegacy = () =>
  LEGACY_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n')

/** Recolecta los archivos del frontend que podrían invocar el endpoint legacy. */
function collectFrontendFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(rel)
    }
  }
  for (const d of FRONTEND_DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(d)
  return out
}

/**
 * Quita comentarios (line y block) y strings literales de texto largo, para no
 * marcar como hallazgo la propia DOCUMENTACIÓN del retiro — el stub explica en
 * su cabecera qué cosas ya NO hace (private_key, service_role, …). Se analiza
 * únicamente el CÓDIGO ejecutable.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // bloques
    .replace(/^[ \t]*\/\/.*$/gm, ' ')    // líneas completas
    .replace(/([^:])\/\/.*$/gm, '$1 ')   // trailing (evita romper 'https://')
}

function analyze(rawTs, frontendFiles) {
  const fails = []
  const req = (cond, msg) => { if (!cond) fails.push(msg) }
  const legacyTs = stripComments(rawTs)

  // ── El stub debe ser fail-closed ───────────────────────────────────────────
  req(/\b410\b/.test(legacyTs), 'generate-csr debe responder 410 (fail-closed)')
  req(/LEGACY_CSR_FLOW_RETIRED/.test(legacyTs),
    'generate-csr debe devolver el código sanitizado LEGACY_CSR_FLOW_RETIRED')
  req(/status:\s*204/.test(legacyTs), 'generate-csr debe seguir respondiendo 204 al preflight OPTIONS')

  // ── Nada de criptografía ni manejo de claves ───────────────────────────────
  req(!/generateKeyPair|rsa\.generateKeyPair/.test(legacyTs),
    'generate-csr NO debe generar claves RSA')
  req(!/\bprivateKey\b|\bkeyPem\b|privateKeyToPem/.test(legacyTs),
    'generate-csr NO debe manejar una clave privada')
  req(!/node-forge|forge\./.test(legacyTs),
    'generate-csr NO debe importar/usar node-forge')
  req(!/createCertificationRequest|certificationRequestToPem|csr_pem/.test(legacyTs),
    'generate-csr NO debe crear ni devolver un CSR')

  // ── Nada de acceso a datos fiscales ────────────────────────────────────────
  req(!/from\(['"]arca_config['"]\)/.test(legacyTs),
    'generate-csr NO debe leer ni escribir arca_config')
  req(!/private_key|cert_file|pfx_file|wsaa_token|wsaa_sign|wsaa_token_expires|estado_conexion/.test(legacyTs),
    'generate-csr NO debe referenciar columnas fiscales (private_key/cert/token/sign/…)')
  req(!/vault\.|decrypted_secrets|create_secret|arca_get_credential_for_signing|arca_store_credential/.test(legacyTs),
    'generate-csr NO debe acceder a Vault ni a contratos de credenciales')
  req(!/\.rpc\(/.test(legacyTs), 'generate-csr NO debe invocar ninguna RPC')
  req(!/functions\/v1\/afip-(wsaa|cae)|invoke\(\s*['"]afip-(wsaa|cae)/.test(legacyTs),
    'generate-csr NO debe invocar WSAA/CAE')
  req(!/wsaa\.afip\.gov\.ar|wsaahomo\.afip\.gov\.ar|servicios1\.afip/.test(legacyTs),
    'generate-csr NO debe llamar a ARCA/AFIP')

  // ── Nada de service_role ni cliente Supabase ───────────────────────────────
  req(!/SUPABASE_SERVICE_ROLE_KEY|service_role/.test(legacyTs),
    'generate-csr NO debe usar service_role')
  req(!/createClient\(/.test(legacyTs),
    'generate-csr NO debe crear un cliente Supabase (no accede a datos)')

  // ── Ningún consumidor del frontend puede volver a invocarlo ────────────────
  const consumers = frontendFiles.filter((f) => {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8')
    return /invoke\(\s*['"]generate-csr['"]|functions\/v1\/generate-csr/.test(t)
  })
  req(consumers.length === 0,
    `ningún archivo del frontend debe invocar generate-csr (encontrado en: ${consumers.join(', ')})`)

  return fails
}

function run() {
  const legacyTs = readLegacy()
  const fails = analyze(legacyTs, collectFrontendFiles())
  if (fails.length) {
    console.error('❌ Guard AFIP-S4B-1 FALLÓ:')
    for (const f of fails) console.error('  - ' + f)
    process.exit(1)
  }
  console.log('✅ Guard AFIP-S4B-1 OK: generate-csr retirado fail-closed (410), sin RSA, sin CSR, sin arca_config, sin Vault, sin service_role, y sin consumidores en el frontend.')
}

function selfTest() {
  const legacyTs = readLegacy()
  const frontend = collectFrontendFiles()
  const clean = analyze(legacyTs, frontend)
  if (clean.length) { console.error('SELF-TEST: la versión real tiene fallas:', clean); process.exit(1) }

  // Fichero temporal de un "consumidor frontend" reintroducido.
  const fakeConsumer = 'src/__s4b1_selftest_consumer.tsx'
  const bad = [
    ['vuelve a generar RSA', legacyTs + "\nconst k = forge.pki.rsa.generateKeyPair({bits:2048})", frontend],
    ['maneja una clave privada', legacyTs + "\nconst keyPem = privateKeyToPem(k)", frontend],
    ['escribe arca_config', legacyTs + "\nawait admin.from('arca_config').update({ private_key: p })", frontend],
    ['accede a Vault', legacyTs + "\nawait admin.rpc('arca_store_credential', {})", frontend],
    ['invoca WSAA', legacyTs + "\nawait fetch('/functions/v1/afip-wsaa')", frontend],
    ['devuelve un CSR', legacyTs + "\nreturn jsonResponse(req, { csr_pem: x }, 200)", frontend],
    ['usa service_role', legacyTs + "\nconst k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')", frontend],
    ['deja de ser fail-closed', legacyTs.replace(/\b410\b/g, '200'), frontend],
    ['pierde el código sanitizado', legacyTs.replace(/LEGACY_CSR_FLOW_RETIRED/g, 'OTRO'), frontend],
  ]

  let ok = true
  for (const [label, code, files] of bad) {
    const f = analyze(code, files)
    if (f.length === 0) { console.error('SELF-TEST FALLÓ: no detectó "' + label + '"'); ok = false }
    else console.log('  self-test detecta: ' + label)
  }

  // Consumidor frontend reintroducido (se crea y se borra).
  try {
    fs.writeFileSync(path.join(ROOT, fakeConsumer),
      "export const x = () => supabase.functions.invoke('generate-csr', { body: {} })\n")
    const f = analyze(legacyTs, [...frontend, fakeConsumer])
    if (f.length === 0) { console.error('SELF-TEST FALLÓ: no detectó consumidor frontend reintroducido'); ok = false }
    else console.log('  self-test detecta: consumidor frontend reintroducido')
  } finally {
    if (fs.existsSync(path.join(ROOT, fakeConsumer))) fs.unlinkSync(path.join(ROOT, fakeConsumer))
  }

  if (!ok) process.exit(1)
  console.log('✅ Guard AFIP-S4B-1 self-test OK (' + (bad.length + 1) + ' inyecciones detectadas)')
}

if (process.argv.includes('--self-test')) selfTest()
else run()
