/**
 * arca-rotate-activate — validación de entrada PURA (AFIP-S4B-2A).
 *
 * Separada de `index.ts` para poder testearla sin red ni base. Este módulo no
 * importa cliente Supabase ni criptografía: solo decide si un pedido es
 * aceptable ANTES de delegar en la RPC atómica.
 *
 * BETA-GATE-1 · Lote A: el helper de CORS que vivía acá reflejaba cualquier
 * `Origin`. Se retiró; la función responde CORS por `_shared/scopedCors.ts`
 * (allowlist exacta, fail-closed), igual que el resto de las superficies ARCA.
 */

export const MAX_PEM_BYTES = 64 * 1024

export type ActivateInput = {
  business_id?: unknown
  action?: unknown
  idempotency_key?: unknown
  rotation_ref?: unknown
  certificate_pem?: unknown
  expected_fingerprint?: unknown
}

export type Validated =
  | { ok: true; action: 'activate'; businessId: string; idempotencyKey: string; rotationRef: string | null; certPem: string; expectedFp: string }
  | { ok: true; action: 'rollback'; businessId: string; idempotencyKey: string; rotationRef: string | null }
  | { ok: true; action: 'finalize'; businessId: string; idempotencyKey: string; rotationRef: string | null; expectedFp: string }
  | { ok: false; status: number; body: Record<string, unknown> }

/**
 * Campos que `finalize` NUNCA debe recibir (AFIP-S4B-2C). La finalización sólo
 * confirma lo que ya está en la base: no transporta material, y el vencimiento
 * se deriva server-side del X.509 activo, jamás de lo que mande el cliente.
 */
const FINALIZE_FORBIDDEN = [
  'certificate_pem', 'private_key', 'private_key_pem', 'key_pem', 'pem',
  'expires_at', 'not_after', 'wsaa_token', 'wsaa_sign', 'token', 'sign',
  'secret_id', 'vault_secret_id', 'subject',
]

/**
 * Fail-closed: rechaza cualquier pedido incompleto o que traiga una CLAVE
 * PRIVADA. Solo se acepta certificado PÚBLICO.
 */
export function validateInput(body: ActivateInput): Validated {
  const businessId = String(body?.business_id ?? '')
  const action = String(body?.action ?? 'activate')
  const idempotencyKey = String(body?.idempotency_key ?? '')
  const rotationRef = body?.rotation_ref ? String(body.rotation_ref) : null

  if (!businessId || !idempotencyKey) {
    return { ok: false, status: 400, body: { ok: false, error: 'MISSING_FIELDS', detail: 'business_id, idempotency_key' } }
  }
  if (action !== 'activate' && action !== 'rollback' && action !== 'finalize') {
    return { ok: false, status: 400, body: { ok: false, error: 'BAD_REQUEST', detail: 'action' } }
  }
  if (action === 'rollback') {
    return { ok: true, action: 'rollback', businessId, idempotencyKey, rotationRef }
  }
  if (action === 'finalize') {
    const intruso = FINALIZE_FORBIDDEN.find((k) => (body as Record<string, unknown>)?.[k] !== undefined)
    if (intruso) {
      return { ok: false, status: 400, body: { ok: false, error: 'BAD_REQUEST', detail: 'campo no aceptado' } }
    }
    const fp = String(body?.expected_fingerprint ?? '').trim().toLowerCase()
    if (!fp) {
      return { ok: false, status: 400, body: { ok: false, error: 'MISSING_FIELDS', detail: 'expected_fingerprint' } }
    }
    if (!/^[0-9a-f]{64}$/.test(fp)) {
      return { ok: false, status: 400, body: { ok: false, error: 'BAD_REQUEST', detail: 'expected_fingerprint' } }
    }
    return { ok: true, action: 'finalize', businessId, idempotencyKey, rotationRef, expectedFp: fp }
  }

  const certPem = String(body?.certificate_pem ?? '')
  const expectedFp = String(body?.expected_fingerprint ?? '').trim().toLowerCase()
  if (!certPem || !expectedFp) {
    return { ok: false, status: 400, body: { ok: false, error: 'MISSING_FIELDS', detail: 'certificate_pem, expected_fingerprint' } }
  }
  if (new TextEncoder().encode(certPem).length > MAX_PEM_BYTES) {
    return { ok: false, status: 413, body: { ok: false, error: 'TOO_LARGE' } }
  }
  // Solo certificado PÚBLICO: cualquier clave privada se rechaza de entrada.
  if (/-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(certPem)) {
    return { ok: false, status: 400, body: { ok: false, error: 'PRIVATE_KEY_NOT_ACCEPTED' } }
  }
  if (!/-----BEGIN CERTIFICATE-----/.test(certPem)) {
    return { ok: false, status: 409, body: { ok: false, state: 'CERTIFICATE_INVALID' } }
  }
  if (!/^[0-9a-f]{64}$/.test(expectedFp)) {
    return { ok: false, status: 400, body: { ok: false, error: 'BAD_REQUEST', detail: 'expected_fingerprint' } }
  }
  return { ok: true, action: 'activate', businessId, idempotencyKey, rotationRef, certPem, expectedFp }
}

/** Respuesta sanitizada de activación: nunca certificado, clave, secret_id ni token. */
export function buildActivationResponse(state: string, data: Record<string, unknown> | null) {
  return {
    ok: true,
    state,
    rotation_ref: data?.rotation_ref ?? null,
    new_fingerprint_trunc: data?.new_fingerprint_trunc ?? null,
    previous_fingerprint_trunc: data?.previous_fingerprint_trunc ?? null,
    certificate_fingerprint_trunc: data?.certificate_fingerprint_trunc ?? null,
    key_size: data?.key_size ?? null,
    algorithm: data?.algorithm ?? null,
    wsaa_cache_invalidated: data?.wsaa_cache_invalidated ?? null,
    rotation_state: data?.rotation_state ?? null,
    info: {
      siguiente_paso: 'Verificar con un refresh WSAA controlado (S4B-2B). Si algo falla, usar action="rollback".',
    },
  }
}

/** Respuesta sanitizada de finalización: nunca certificado, clave, secret_id ni token. */
export function buildFinalizeResponse(state: string, data: Record<string, unknown> | null) {
  return {
    ok: true,
    state,
    rotation_ref: data?.rotation_ref ?? null,
    previous_state: data?.previous_state ?? null,
    current_state: data?.current_state ?? null,
    active_fingerprint_trunc: data?.active_fingerprint_trunc ?? null,
    expires_at: data?.expires_at ?? null,
    previous_expires_at: data?.previous_expires_at ?? null,
    wsaa_verified_at: data?.wsaa_verified_at ?? null,
    rollback_available: data?.rollback_available ?? null,
    info: {
      siguiente_paso: 'Rotación cerrada. El par anterior sigue disponible para rollback hasta AFIP-S4C.',
    },
  }
}
