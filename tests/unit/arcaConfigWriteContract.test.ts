/**
 * AFIP-S1B-A2 — el frontend escribe arca_config SOLO por el contrato server-side.
 *
 * Dos capas de prueba (mismo patrón que arcaEmission.test.ts):
 *  1) unidad pura de sanitizeArcaError (no importa Vite/Supabase);
 *  2) contrato de FUENTE sobre arcaService.ts y Settings.tsx — arcaService importa
 *     src/lib/supabase.ts, que lanza sin VITE_SUPABASE_URL bajo `node --test`, así
 *     que se verifica por texto fuente (como el resto de la suite ARCA).
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
// 2. Contrato de fuente — sin DML directo, todo por RPC
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
    assert.match(argObj, new RegExp(p), `falta el parámetro ${p}`)
  }
  // Ningún secreto en la firma de la llamada
  for (const secret of ['cert_file', 'private_key', 'wsaa_token', 'wsaa_sign', 'estado_conexion']) {
    assert.doesNotMatch(argObj, new RegExp(secret), `save_arca_config_legacy no debe enviar ${secret}`)
  }
})

test('saveCertificate usa save_arca_certificate_legacy y rechaza claves privadas', () => {
  const s = stripComments(arca())
  assert.match(s, /supabase\.rpc\(\s*['"]save_arca_certificate_legacy['"]/)
  const fn = s.slice(s.indexOf('static async saveCertificate'), s.indexOf('static async setEstadoConexion'))
  assert.match(fn, /PRIVATE KEY/i, 'debe rechazar contenido con encabezado de clave privada')
  assert.match(fn, /BEGIN CERTIFICATE/, 'debe exigir el header público del certificado')
})

test('setEstadoConexion usa set_arca_estado_conexion y sanitiza el error (nunca UPDATE directo)', () => {
  const s = stripComments(arca())
  assert.match(s, /supabase\.rpc\(\s*['"]set_arca_estado_conexion['"]/)
  const fn = s.slice(s.indexOf('static async setEstadoConexion'))
  assert.match(fn, /sanitizeArcaError/)
})

test('testConnection registra el error por RPC (setEstadoConexion), no por DML directo', () => {
  const s = stripComments(arca())
  const fn = s.slice(s.indexOf('static async testConnection'), s.indexOf('static async getPuntosVenta'))
  assert.match(fn, /this\.setEstadoConexion\(businessId,\s*['"]error['"]/)
  assert.doesNotMatch(fn, /\.update\(/, 'testConnection no debe hacer UPDATE directo a arca_config')
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
// 4. Settings: sin select(id)/DML, cert preservado, refresh seguro
// ─────────────────────────────────────────────────────────────────────────

test('handleSaveArcaConfig: sin prelectura select(id), sin cert_file:null, con RPC + refresh seguro', () => {
  const s = stripComments(settings())
  const fn = s.slice(s.indexOf('const handleSaveArcaConfig'), s.indexOf('const handleGenerarCSR'))
  assert.doesNotMatch(fn, /select\(\s*['"]id['"]\s*\)/, 'no debe usar prelectura select(id) de existencia')
  assert.doesNotMatch(fn, /cert_file\s*:\s*null/, 'nunca debe mandar cert_file: null')
  assert.match(fn, /ArcaService\.saveArcaConfig\(/)
  assert.match(fn, /ArcaService\.saveCertificate\(/)
  assert.match(fn, /refreshArcaConfig\(/, 'debe refrescar por el contrato seguro')
})

test('refreshArcaConfig relee por get_arca_config_safe y limpia el input de cert', () => {
  const s = stripComments(settings())
  const fn = s.slice(s.indexOf('const refreshArcaConfig'), s.indexOf('const handleSaveArcaConfig'))
  assert.match(fn, /get_arca_config_safe/, 'debe releer por el contrato seguro')
  assert.match(fn, /cert_file:\s*''/, 'debe limpiar el textarea del certificado tras refrescar')
})

test('handleSaveArcaConfig: el certificado solo se envía si el usuario pegó uno no vacío', () => {
  const s = stripComments(settings())
  const fn = s.slice(s.indexOf('const handleSaveArcaConfig'), s.indexOf('const handleGenerarCSR'))
  // La llamada a saveCertificate está guardada por un chequeo de contenido no vacío (trim()).
  assert.match(fn, /cert_file\?\.trim\(\)/)
  const idxGuard = fn.indexOf('nuevoCert')
  const idxCall = fn.indexOf('ArcaService.saveCertificate(')
  assert.ok(idxGuard >= 0 && idxCall > idxGuard, 'saveCertificate debe estar detrás del guard de certificado nuevo')
})

test('handleSaveArcaConfig: un fallo de certificado NO borra el anterior ni hace DML compensatorio', () => {
  const s = stripComments(settings())
  const fn = s.slice(s.indexOf('const handleSaveArcaConfig'), s.indexOf('const handleGenerarCSR'))
  const idxCatch = fn.indexOf('catch (certErr')
  assert.ok(idxCatch > 0, 'debe haber manejo explícito del fallo del certificado')
  const afterCatch = fn.slice(idxCatch)
  assert.doesNotMatch(afterCatch, /\.update\(|\.upsert\(|\.insert\(/, 'sin DML compensatorio tras fallo de cert')
  assert.doesNotMatch(afterCatch, /cert_file\s*:\s*null/)
})

test('UI del certificado: el indicador de presencia usa has_certificate, no el contenido del textarea', () => {
  const s = settings()
  assert.match(s, /arcaConfig\.has_certificate\s*&&[\s\S]{0,120}Certificado configurado/)
})
