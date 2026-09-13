/**
 * AFIP-S1B-A2 — el frontend escribe arca_config SOLO por el contrato server-side.
 *
 * Dos capas de prueba (mismo patrón que arcaEmission.test.ts):
 *  1) unidad pura de sanitizeArcaError (no importa Vite/Supabase);
 *  2) contrato de FUENTE sobre arcaService.ts y Settings.tsx — arcaService importa
 *     src/lib/supabase.ts, que lanza sin VITE_SUPABASE_URL bajo `node --test`, así
 *     que se verifica por texto fuente (como el resto de la suite ARCA).
 *
 * ARCA Phase 0: save_arca_certificate_legacy y set_arca_estado_conexion fueron
 * RETIRADAS; el panel ARCA solo guarda configuración no credencial y la gestión
 * exige owner/admin + settings_sensitive.
 *
 * Contexto: hasta A1 el guardado/estado/cert usaban DML directo sobre arca_config,
 * que depende de SELECT. A2 mueve todo a save_arca_config_legacy /
 * save_arca_certificate_legacy / set_arca_estado_conexion / get_arca_config_safe,
 * habilitando la futura revocación de SELECT (S1B-B) sin romper el frontend.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sanitizeArcaError } from '../../src/services/arcaSanitize.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const arca = () => read('../../src/services/arcaService.ts')
const settings = () => read('../../src/pages/Settings.tsx')

// ── stripComments para asertar sobre CÓDIGO, no comentarios ──────────────────
function stripComments(src: string): string {
  let out = '', i = 0
  while (i < src.length) {
    if (src.slice(i, i + 2) === '//') { const f = src.indexOf('\n', i); const e = f === -1 ? src.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (src.slice(i, i + 2) === '/*') { const f = src.indexOf('*/', i + 2); const e = f === -1 ? src.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += src[i]; i++
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// 1. sanitizeArcaError (unidad pura)
// ─────────────────────────────────────────────────────────────────────────

test('sanitizeArcaError: elimina bloques PEM (cert/clave)', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIDdummy\n-----END CERTIFICATE-----'
  const out = sanitizeArcaError(`fallo con ${pem} adjunto`)
  assert.doesNotMatch(out, /BEGIN CERTIFICATE/)
  assert.doesNotMatch(out, /MIIDdummy/)
  assert.match(out, /\[pem omitido\]/)
})

test('sanitizeArcaError: elimina una clave privada PEM sin filtrar su contenido', () => {
  const key = '-----BEGIN PRIVATE KEY-----\nSECRETKEYDATA\n-----END PRIVATE KEY-----'
  const out = sanitizeArcaError(new Error(`error ${key}`))
  assert.doesNotMatch(out, /PRIVATE KEY/)
  assert.doesNotMatch(out, /SECRETKEYDATA/)
})

test('sanitizeArcaError: quita tags XML/SOAP y token/sign', () => {
  const out = sanitizeArcaError('<soap:Fault>token=abc123 sign: ZZZ</soap:Fault>')
  assert.doesNotMatch(out, /<soap:Fault>/)
  assert.doesNotMatch(out, /abc123/)
  assert.doesNotMatch(out, /ZZZ/)
  assert.match(out, /token: \[omitido\]/)
  assert.match(out, /sign: \[omitido\]/)
})

test('sanitizeArcaError: recorta a 200 caracteres', () => {
  const out = sanitizeArcaError('x'.repeat(1000))
  assert.equal(out.length, 200)
})

test('sanitizeArcaError: acepta string, Error y null (fallback)', () => {
  assert.equal(sanitizeArcaError('hola mundo'), 'hola mundo')
  assert.equal(sanitizeArcaError(new Error('boom')), 'boom')
  assert.equal(sanitizeArcaError(null), 'Error de conexión')
})

// ─────────────────────────────────────────────────────────────────────────
// 2. Contrato de fuente — sin DML directo, todo por RPC (ARCA Phase 0)
// ─────────────────────────────────────────────────────────────────────────

test('arcaService y Settings NO hacen from(arca_config) (cero SELECT/DML directo)', () => {
  assert.doesNotMatch(stripComments(arca()), /from\(\s*['"]arca_config['"]\s*\)/)
  assert.doesNotMatch(stripComments(settings()), /from\(\s*['"]arca_config['"]\s*\)/)
})

test('saveArcaConfig llama save_arca_config_legacy con parámetros tipados (sin spread)', () => {
  const s = stripComments(arca())
  assert.match(s, /supabase\.rpc\(\s*['"]save_arca_config_legacy['"]/)
  const call = s.slice(s.indexOf("save_arca_config_legacy"))
  const argObj = call.slice(call.indexOf('{'), call.indexOf('}') + 1)
  assert.doesNotMatch(argObj, /\.\.\./, 'no debe hacer spread hacia la RPC (mass-assignment)')
  for (const p of ['p_business_id', 'p_cuit', 'p_razon_social', 'p_ambiente', 'p_punto_venta', 'p_web_service', 'p_alias', 'p_expires_at']) {
    assert.match(argObj, new RegExp(p), `falta el parámetro ${p} (la firma de la RPC no cambió)`)
  }
  // Ningún secreto en la firma de la llamada
  for (const secret of ['cert_file', 'private_key', 'wsaa_token', 'wsaa_sign', 'estado_conexion']) {
    assert.doesNotMatch(argObj, new RegExp(secret), `save_arca_config_legacy no debe enviar ${secret}`)
  }
})

test('ARCA Phase 0: web_service y expires_at nunca son autoridad del cliente (siempre null)', () => {
  const s = stripComments(arca())
  const call = s.slice(s.indexOf("save_arca_config_legacy"))
  const argObj = call.slice(call.indexOf('{'), call.indexOf('}') + 1)
  assert.match(argObj, /p_web_service:\s*null/)
  assert.match(argObj, /p_expires_at:\s*null/)
})

test('ARCA Phase 0: el frontend ya no usa las RPC retiradas ni sus métodos cliente', () => {
  for (const src of [arca(), settings()]) {
    const code = stripComments(src)
    assert.doesNotMatch(code, /save_arca_certificate_legacy/, 'carga de certificado sin validar: retirada')
    assert.doesNotMatch(code, /set_arca_estado_conexion/, 'estado_conexion escrito por el cliente: retirado')
    assert.doesNotMatch(code, /\bsaveCertificate\b/)
    assert.doesNotMatch(code, /\bsetEstadoConexion\b/)
    assert.doesNotMatch(code, /private_key_pem/)
  }
})

test('testConnection NO escribe estado_conexion desde el navegador', () => {
  const s = stripComments(arca())
  const fn = s.slice(s.indexOf('static async testConnection'), s.indexOf('static async getPuntosVenta'))
  assert.doesNotMatch(fn, /estado_conexion|setEstado|\.rpc\(\s*['"]set_/)
  assert.doesNotMatch(fn, /\.update\(/, 'testConnection no debe hacer UPDATE directo a arca_config')
  assert.match(fn, /sanitizeArcaError/, 'el mensaje mostrado sigue sanitizado')
})

// ─────────────────────────────────────────────────────────────────────────
// 3. uploadCertificate retirado; ningún private_key en el frontend
// ─────────────────────────────────────────────────────────────────────────

test('uploadCertificate fue ELIMINADO del frontend (aceptaba la clave privada)', () => {
  assert.doesNotMatch(stripComments(arca()), /\buploadCertificate\b/)
})

test('ninguna referencia de CÓDIGO a private_key en arcaService/Settings (solo el flag de presencia)', () => {
  for (const src of [arca(), settings()]) {
    const code = stripComments(src).replace(/has_private_key_configured/g, '')
    assert.doesNotMatch(code, /private_key/, 'private_key no debe aparecer en el código del frontend')
  }
})

// ─────────────────────────────────────────────────────────────────────────
// 4. Settings: panel ARCA sin carga de certificado, gestión gateada
// ─────────────────────────────────────────────────────────────────────────

test('Settings ya no tiene textarea de certificado, cert_file ni el botón de CSR retirado', () => {
  const s = stripComments(settings())
  assert.doesNotMatch(s, /cert_file/, 'el navegador no maneja cert_file')
  assert.doesNotMatch(s, /<textarea[^>]*arcaConfig/, 'sin textarea de certificado')
  assert.doesNotMatch(s, /handleGenerarCSR|Generación de CSR retirada/, 'sin acción de CSR retirada')
  assert.doesNotMatch(s, /csr_generado/, 'sin banner del flujo de CSR legacy')
})

test('Settings gatea la gestión ARCA con canManageArca (owner/admin + settings_sensitive)', () => {
  const s = stripComments(settings())
  assert.match(s, /canManageArca\(\{[\s\S]{0,200}settingsSensitive:\s*can\(['"]settings_sensitive['"]\)/)
  for (const handler of ['handleSaveArcaConfig', 'handleTestArcaConnection', 'handleSyncParameters']) {
    const fn = s.slice(s.indexOf(`const ${handler}`), s.indexOf(`const ${handler}`) + 400)
    assert.match(fn, /puedeGestionarArca/, `${handler} debe cortar sin autoridad de gestión`)
  }
  assert.match(s, /\{puedeGestionarArca && \(\s*<button\s+data-testid="arca-test-connection"/)
  assert.match(s, /\{puedeGestionarArca && \(\s*<div[^>]*>\s*<button\s+data-testid="arca-save-config"/)
})

test('handleSaveArcaConfig: con identidad vigente CUIT/ambiente/alias viajan en null', () => {
  const s = stripComments(settings())
  const fn = s.slice(s.indexOf('const handleSaveArcaConfig'), s.indexOf('const handleSaveArcaConfig') + 1200)
  assert.match(fn, /ArcaService\.saveArcaConfig\(/)
  assert.match(fn, /cuit:\s*identidadArcaBloqueada \? null/)
  assert.match(fn, /ambiente:\s*identidadArcaBloqueada \? null/)
  assert.match(fn, /alias:\s*identidadArcaBloqueada \? null/)
  assert.doesNotMatch(fn, /expires_at|web_service/)
  assert.match(fn, /refreshArcaConfig\(/, 'debe refrescar por el contrato seguro')
})

test('refreshArcaConfig relee por get_arca_config_safe', () => {
  const s = stripComments(settings())
  const fn = s.slice(s.indexOf('const refreshArcaConfig'), s.indexOf('const handleSaveArcaConfig'))
  assert.match(fn, /get_arca_config_safe/, 'debe releer por el contrato seguro')
})

test('UI: CUIT, ambiente y alias quedan deshabilitados con identidad vigente', () => {
  const s = settings()
  for (const id of ['arca-cuit', 'arca-ambiente', 'arca-alias']) {
    assert.match(s, new RegExp(`data-testid="${id}"[\\s\\S]{0,400}disabled=\\{!puedeGestionarArca \\|\\| identidadArcaBloqueada\\}`))
  }
})
