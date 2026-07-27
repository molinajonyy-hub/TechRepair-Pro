/**
 * AFIP-S4B-2A — tests del Edge de activación/rollback atómicos.
 *
 * Ejercita la validación REAL desplegada (validate.ts) en el mismo runtime que
 * producción, sin red ni base. Los casos que dependen del gateway o de la DB
 * (401 sin JWT, 403 no-owner) se verifican en el smoke productivo.
 *
 * NUNCA se usa el certificado productivo emitido por ARCA: los fixtures son
 * sintéticos y mínimos.
 *
 * RUN: deno test -A --node-modules-dir=auto tests/deno/
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  buildCorsHeaders, validateInput, buildActivationResponse, buildFinalizeResponse, MAX_PEM_BYTES,
} from '../../supabase/functions/arca-rotate-activate/validate.ts'

const BIZ = '00000000-0000-4000-8000-0000000054f1'
const IDEM = 'test-idem-1'
const FP = 'a'.repeat(64)
// Certificado SINTÉTICO mínimo (solo cabecera/cierre: la validación de entrada
// no parsea ASN.1; eso lo hace la DB).
const CERT = '-----BEGIN CERTIFICATE-----\nZm9vYmFy\n-----END CERTIFICATE-----'

Deno.test('OPTIONS/CORS devuelve los headers esperados', () => {
  const req = new Request('https://x/functions/v1/arca-rotate-activate', {
    method: 'OPTIONS',
    headers: { Origin: 'https://www.techrepairpro.app', 'Access-Control-Request-Headers': 'authorization, content-type' },
  })
  const h = buildCorsHeaders(req)
  assertEquals(h['Access-Control-Allow-Origin'], 'https://www.techrepairpro.app')
  assertEquals(h['Access-Control-Allow-Methods'], 'POST, OPTIONS')
  assertEquals(h['Access-Control-Allow-Headers'], 'authorization, content-type')
})

Deno.test('faltan campos obligatorios → 400 MISSING_FIELDS', () => {
  for (const body of [{}, { business_id: BIZ }, { idempotency_key: IDEM }]) {
    const v = validateInput(body)
    assertEquals(v.ok, false)
    if (!v.ok) { assertEquals(v.status, 400); assertEquals(v.body.error, 'MISSING_FIELDS') }
  }
})

Deno.test('falta el certificado o el fingerprint → 400 MISSING_FIELDS', () => {
  const v = validateInput({ business_id: BIZ, idempotency_key: IDEM })
  assertEquals(v.ok, false)
  if (!v.ok) assertEquals(v.body.detail, 'certificate_pem, expected_fingerprint')
})

Deno.test('una CLAVE PRIVADA nunca se acepta → 400 PRIVATE_KEY_NOT_ACCEPTED', () => {
  for (const marker of ['-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----',
                        '-----BEGIN EC PRIVATE KEY-----', '-----BEGIN ENCRYPTED PRIVATE KEY-----']) {
    const v = validateInput({
      business_id: BIZ, idempotency_key: IDEM, expected_fingerprint: FP,
      certificate_pem: `${CERT}\n${marker}\nAAAA\n-----END PRIVATE KEY-----`,
    })
    assertEquals(v.ok, false)
    if (!v.ok) { assertEquals(v.status, 400); assertEquals(v.body.error, 'PRIVATE_KEY_NOT_ACCEPTED') }
  }
})

Deno.test('certificado que no es PEM de certificado → 409 CERTIFICATE_INVALID', () => {
  const v = validateInput({ business_id: BIZ, idempotency_key: IDEM, expected_fingerprint: FP,
    certificate_pem: 'esto no es un certificado' })
  assertEquals(v.ok, false)
  if (!v.ok) { assertEquals(v.status, 409); assertEquals(v.body.state, 'CERTIFICATE_INVALID') }
})

Deno.test('fingerprint mal formado → 400 BAD_REQUEST', () => {
  for (const fp of ['abc', 'Z'.repeat(64), '', 'a'.repeat(63)]) {
    const v = validateInput({ business_id: BIZ, idempotency_key: IDEM, certificate_pem: CERT, expected_fingerprint: fp })
    assertEquals(v.ok, false)
  }
})

Deno.test('certificado demasiado grande → 413 TOO_LARGE', () => {
  const big = '-----BEGIN CERTIFICATE-----\n' + 'A'.repeat(MAX_PEM_BYTES + 10) + '\n-----END CERTIFICATE-----'
  const v = validateInput({ business_id: BIZ, idempotency_key: IDEM, certificate_pem: big, expected_fingerprint: FP })
  assertEquals(v.ok, false)
  if (!v.ok) { assertEquals(v.status, 413); assertEquals(v.body.error, 'TOO_LARGE') }
})

Deno.test('pedido válido de activación pasa la validación', () => {
  const v = validateInput({ business_id: BIZ, idempotency_key: IDEM, certificate_pem: CERT, expected_fingerprint: FP })
  assertEquals(v.ok, true)
  if (v.ok && v.action === 'activate') {
    assertEquals(v.businessId, BIZ)
    assertEquals(v.expectedFp, FP)
    assertEquals(v.rotationRef, null)
  }
})

Deno.test('rollback no exige certificado', () => {
  const v = validateInput({ business_id: BIZ, idempotency_key: IDEM, action: 'rollback' })
  assertEquals(v.ok, true)
  if (v.ok) assertEquals(v.action, 'rollback')
})

Deno.test('action desconocida → 400', () => {
  const v = validateInput({ business_id: BIZ, idempotency_key: IDEM, action: 'destroy' })
  assertEquals(v.ok, false)
})

Deno.test('la respuesta es sanitizada: sin certificado, clave, secret_id ni token', () => {
  const res = buildActivationResponse('ROTATION_ACTIVATED', {
    rotation_ref: '23016088', new_fingerprint_trunc: 'aaaa', previous_fingerprint_trunc: 'bbbb',
    certificate_fingerprint_trunc: 'cccc', key_size: 2048, algorithm: 'RSA',
    wsaa_cache_invalidated: true, rotation_state: 'activated_pending_verification',
    // campos que la RPC NO devuelve, pero si algún día lo hiciera no deben pasar:
    secret_id: 'no-debe-aparecer', certificate_pem: CERT, private_key: 'X',
  })
  const raw = JSON.stringify(res)
  assert(!raw.includes('no-debe-aparecer'), 'no debe filtrar secret_id')
  assert(!/BEGIN CERTIFICATE|PRIVATE KEY/.test(raw), 'no debe filtrar certificado ni clave')
  assertEquals(res.state, 'ROTATION_ACTIVATED')
  assertEquals(res.key_size, 2048)
})

Deno.test('el Edge valida JWT y membresía, y NO escribe la config ni llama a WSAA', async () => {
  const raw = await Deno.readTextFile('supabase/functions/arca-rotate-activate/index.ts')
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert(/auth\.getUser\(\)/.test(src), 'valida el JWT del usuario')
  assert(/is_business_owner_or_admin/.test(src), 'valida membresía owner/admin')
  assert(/arca_activate_certificate_rotation/.test(src), 'delega en la RPC de activación')
  assert(/arca_rollback_certificate_rotation/.test(src), 'delega en la RPC de rollback')
  assert(!/from\(['"]arca_config['"]\)/.test(src), 'no escribe arca_config directamente')
  assert(!/functions\/v1\/afip-(wsaa|cae)|invoke\(\s*['"]afip-/.test(src), 'no invoca WSAA/CAE')
  assert(!/console\.(log|error|warn)/.test(src), 'no loguea (evita filtrar certificado o JWT)')
})

// ── AFIP-S4B-2C — acción `finalize` ────────────────────────────────────────
// Los casos que dependen del gateway o de la base (401 sin JWT, 401 con JWT
// inválido, 403 sin owner/admin) se verifican en el smoke productivo: acá el
// gateway no existe.

Deno.test('finalize con payload correcto pasa la validación', () => {
  const v = validateInput({ business_id: BIZ, idempotency_key: IDEM, action: 'finalize', expected_fingerprint: FP })
  assertEquals(v.ok, true)
  if (v.ok && v.action === 'finalize') {
    assertEquals(v.businessId, BIZ)
    assertEquals(v.expectedFp, FP)
    assertEquals(v.rotationRef, null)
  }
})

Deno.test('finalize acepta rotation_ref explícita', () => {
  const v = validateInput({ business_id: BIZ, idempotency_key: IDEM, action: 'finalize',
    expected_fingerprint: FP, rotation_ref: '23016088-bb81-4e7b-9890-b70bc3f9592b' })
  assertEquals(v.ok, true)
  if (v.ok && v.action === 'finalize') assertEquals(v.rotationRef, '23016088-bb81-4e7b-9890-b70bc3f9592b')
})

Deno.test('finalize sin fingerprint → 400 MISSING_FIELDS', () => {
  const v = validateInput({ business_id: BIZ, idempotency_key: IDEM, action: 'finalize' })
  assertEquals(v.ok, false)
  if (!v.ok) { assertEquals(v.status, 400); assertEquals(v.body.error, 'MISSING_FIELDS') }
})

Deno.test('finalize con fingerprint mal formado → 400 BAD_REQUEST', () => {
  for (const fp of ['abc', 'Z'.repeat(64), 'a'.repeat(63), '0x' + 'a'.repeat(62)]) {
    const v = validateInput({ business_id: BIZ, idempotency_key: IDEM, action: 'finalize', expected_fingerprint: fp })
    assertEquals(v.ok, false)
    if (!v.ok) assertEquals(v.status, 400)
  }
})

Deno.test('finalize NUNCA acepta material ni metadata que deba derivarse server-side', () => {
  const prohibidos: Record<string, unknown> = {
    certificate_pem: CERT,
    private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
    key_pem: 'x', pem: 'x',
    expires_at: '2028-07-25T23:58:12Z', not_after: '2028-07-25T23:58:12Z',
    wsaa_token: 'T', wsaa_sign: 'S', token: 'T', sign: 'S',
    secret_id: '00000000-0000-4000-8000-000000000001',
    vault_secret_id: '00000000-0000-4000-8000-000000000001',
    subject: { cn: 'otro.alias' },
  }
  for (const [campo, valor] of Object.entries(prohibidos)) {
    const v = validateInput({ business_id: BIZ, idempotency_key: IDEM, action: 'finalize',
      expected_fingerprint: FP, [campo]: valor } as Record<string, unknown>)
    assertEquals(v.ok, false, `finalize no debe aceptar ${campo}`)
    if (!v.ok) { assertEquals(v.status, 400); assertEquals(v.body.error, 'BAD_REQUEST') }
  }
})

Deno.test('omitir action NO finaliza: sigue siendo una activación', () => {
  const v = validateInput({ business_id: BIZ, idempotency_key: IDEM, expected_fingerprint: FP })
  // sin certificado, una activación falla; lo importante es que no derive en finalize
  assertEquals(v.ok, false)
  const v2 = validateInput({ business_id: BIZ, idempotency_key: IDEM, expected_fingerprint: FP, certificate_pem: CERT })
  assertEquals(v2.ok, true)
  if (v2.ok) assertEquals(v2.action, 'activate')
})

Deno.test('la respuesta de finalize es sanitizada y reporta la transición', () => {
  const res = buildFinalizeResponse('ROTATION_COMPLETED', {
    rotation_ref: '23016088', previous_state: 'activated_pending_verification', current_state: 'completed',
    active_fingerprint_trunc: '72cd45e05589865e', expires_at: '2028-07-25T23:58:12+00:00',
    previous_expires_at: '2028-04-17T00:00:00+00:00', wsaa_verified_at: '2026-07-27T12:01:48Z',
    rollback_available: true,
    // campos que la RPC NO devuelve, pero que si algún día lo hiciera no deben pasar:
    secret_id: 'no-debe-aparecer', certificate_pem: CERT, private_key: 'X', wsaa_token: 'TOK',
  })
  const raw = JSON.stringify(res)
  assert(!raw.includes('no-debe-aparecer'), 'no debe filtrar secret_id')
  assert(!/BEGIN CERTIFICATE|PRIVATE KEY|TOK/.test(raw), 'no debe filtrar certificado, clave ni token')
  assertEquals(res.state, 'ROTATION_COMPLETED')
  assertEquals(res.previous_state, 'activated_pending_verification')
  assertEquals(res.current_state, 'completed')
  assertEquals(res.rollback_available, true)
})

Deno.test('el Edge delega finalize en la RPC service_role-only y no toca nada más', async () => {
  const raw = await Deno.readTextFile('supabase/functions/arca-rotate-activate/index.ts')
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert(/arca_finalize_certificate_rotation/.test(src), 'delega en la RPC de finalización')
  assert(/p_expected_fingerprint/.test(src), 'pasa el fingerprint esperado')
  assert(!/expires_at/.test(src), 'el Edge nunca envía ni calcula expires_at')
  assert(!/from\(['"]arca_config['"]\)/.test(src), 'no escribe arca_config directamente')
  assert(!/functions\/v1\/afip-(wsaa|cae)|invoke\(\s*['"]afip-/.test(src), 'no invoca WSAA/CAE')
  assert(!/console\.(log|error|warn)/.test(src), 'no loguea el payload')
})

Deno.test('el módulo de validación no importa cliente Supabase ni criptografía', async () => {
  const raw = await Deno.readTextFile('supabase/functions/arca-rotate-activate/validate.ts')
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert(!/createClient|@supabase\/supabase-js/.test(src), 'sin cliente Supabase')
  assert(!/node-forge|forge\./.test(src), 'sin node-forge')
  assert(!/fetch\(/.test(src), 'sin red')
})
