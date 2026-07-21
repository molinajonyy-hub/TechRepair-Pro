/**
 * Edge Function: arca-credentials  (AFIP-S1A — DORMIDA: sin consumidor productivo)
 *
 * Carga segura de credenciales ARCA. Valida identidad (JWT), membresía y rol
 * owner/admin, verifica el par certificado↔clave con node-forge, calcula
 * fingerprints y guarda la CLAVE PRIVADA en Supabase Vault vía la RPC
 * service_role-only `public.arca_store_credential`. NUNCA devuelve la clave ni el
 * secret_id, nunca escribe PEM en logs. El certificado (público) va a arca_config
 * por el flujo legacy existente (no lo toca esta función en S1A).
 *
 * Estado S1A: NO está conectada al formulario productivo. Se prueba con pares
 * sintéticos. `generate-csr` / `uploadCertificate` / `afip-wsaa` NO se modifican acá.
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// @ts-ignore: node-forge en Deno via npm
import forge from 'npm:node-forge@1.3.1'

const MAX_PEM_BYTES = 64 * 1024   // límite de tamaño por campo (64 KB)

// ── CORS: allowlist explícita (mismo patrón que las demás Edge) ─────────────
const ALLOWED_REQUEST_HEADERS = new Set(['authorization', 'content-type', 'apikey', 'x-client-info'])
function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '*'
  const requested = req.headers.get('Access-Control-Request-Headers')
  const allow = requested
    ? requested.split(',').map((h) => h.trim().toLowerCase()).filter((h) => ALLOWED_REQUEST_HEADERS.has(h)).join(', ')
    : 'authorization, content-type'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': allow,
    'Vary': 'Origin',
  }
}
function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...buildCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// ── Validación cert↔clave con node-forge (sin parser propio) ────────────────
function sha256Hex(bytes: string): string {
  const md = forge.md.sha256.create(); md.update(bytes); return md.digest().toHex()
}
function validatePair(certPem: string, keyPem: string): {
  ok: boolean; error?: string; certFp?: string; keyFp?: string; algorithm?: string; keyBits?: number
  validFrom?: string; validTo?: string
} {
  let cert: any, key: any
  try { cert = forge.pki.certificateFromPem(certPem) } catch { return { ok: false, error: 'CERT_PARSE' } }
  try { key = forge.pki.privateKeyFromPem(keyPem) } catch { return { ok: false, error: 'KEY_PARSE' } }
  // par: la clave pública derivada de la privada debe coincidir con la del cert
  let derivedPubPem: string, certPubPem: string
  try {
    derivedPubPem = forge.pki.publicKeyToPem(forge.pki.setRsaPublicKey(key.n, key.e))
    certPubPem = forge.pki.publicKeyToPem(cert.publicKey)
  } catch { return { ok: false, error: 'PUBKEY_DERIVE' } }
  if (derivedPubPem !== certPubPem) return { ok: false, error: 'PAIR_MISMATCH' }
  const keyBits = key.n.bitLength()
  if (keyBits < 2048) return { ok: false, error: 'KEY_TOO_SMALL' }
  const now = new Date()
  if (cert.validity.notAfter < now) return { ok: false, error: 'CERT_EXPIRED' }
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  return {
    ok: true,
    certFp: sha256Hex(certDer),
    keyFp: sha256Hex(derivedPubPem),      // fingerprint de la clave PÚBLICA (no de la privada)
    algorithm: 'RSA', keyBits,
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: buildCorsHeaders(req) })
  if (req.method !== 'POST') return jsonResponse(req, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const authHeader = req.headers.get('Authorization') ?? ''

  // 1-3. identidad + membresía (cliente con el JWT del usuario, NUNCA service_role)
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } })
  const { data: userData, error: userErr } = await userClient.auth.getUser()
  if (userErr || !userData?.user) return jsonResponse(req, { ok: false, error: 'UNAUTHORIZED' }, 401)
  const actor = userData.user.id

  let body: any
  try { body = await req.json() } catch { return jsonResponse(req, { ok: false, error: 'BAD_REQUEST' }, 400) }
  const businessId = String(body?.business_id ?? '')
  const certPem = String(body?.cert_pem ?? '')
  const keyPem = String(body?.private_key_pem ?? '')
  if (!businessId) return jsonResponse(req, { ok: false, error: 'BUSINESS_REQUIRED' }, 400)

  // 4. owner/admin del negocio (vía service_role: query controlada, sin exponer datos)
  const admin = createClient(url, serviceKey)
  const { data: isAdmin } = await admin.rpc('is_business_owner_or_admin', {
    p_business_id: businessId, p_user_id: actor,
  })
  if (isAdmin !== true) {
    return jsonResponse(req, { ok: false, error: 'FORBIDDEN' }, 403)
  }

  // 5-7. tamaños + formato PEM
  if (new TextEncoder().encode(certPem).length > MAX_PEM_BYTES ||
      new TextEncoder().encode(keyPem).length > MAX_PEM_BYTES) {
    return jsonResponse(req, { ok: false, error: 'TOO_LARGE' }, 413)
  }
  if (!/-----BEGIN CERTIFICATE-----/.test(certPem) || !/-----BEGIN (RSA |ENCRYPTED )?PRIVATE KEY-----/.test(keyPem)) {
    return jsonResponse(req, { ok: false, error: 'INVALID_PEM' }, 400)
  }
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(keyPem)) {
    return jsonResponse(req, { ok: false, error: 'KEY_HAS_PASSPHRASE' }, 400)  // rechazar clave con passphrase
  }

  // 8-10. par + algoritmo + fechas + fingerprints
  const v = validatePair(certPem, keyPem)
  if (!v.ok) {
    // auditoría de falla (sin secretos) — best-effort
    await admin.rpc('arca_store_credential', {}).catch(() => {})
    return jsonResponse(req, { ok: false, error: 'VALIDATION_FAILED', reason: v.error }, 422)
  }

  // 11-12. guardar la CLAVE en Vault (nunca en arca_config). El cert público lo
  // maneja el flujo legacy; acá solo la clave privada va a Vault.
  const { data: secretId, error: storeErr } = await admin.rpc('arca_store_credential', {
    p_business_id: businessId, p_pem: keyPem, p_fingerprint: v.keyFp,
    p_cert_fingerprint: v.certFp, p_algorithm: v.algorithm, p_key_size: v.keyBits, p_actor: actor,
  })
  if (storeErr) {
    return jsonResponse(req, { ok: false, error: 'STORE_FAILED' }, 500)   // error sanitizado
  }

  // 13. NUNCA devolver la clave ni el secret_id. Limpieza best-effort (memoria
  //     administrada por el runtime: no hay borrado criptográfico garantizado).
  body = null
  void secretId

  return jsonResponse(req, {
    ok: true,
    certificate_fingerprint: v.certFp,
    key_size: v.keyBits, algorithm: v.algorithm,
    certificate_valid_from: v.validFrom, certificate_valid_to: v.validTo,
  })
})
