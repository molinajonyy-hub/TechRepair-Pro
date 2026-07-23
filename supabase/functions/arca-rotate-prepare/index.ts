/**
 * Edge Function: arca-rotate-prepare  (AFIP-S4A — DORMIDA: sin consumidor productivo)
 *
 * Prepara una rotación de certificado de forma SEGURA:
 *   1. valida identidad (JWT) + membresía owner/admin del negocio;
 *   2. genera una NUEVA clave RSA en memoria (node-forge);
 *   3. genera el CSR (PKCS#10, SHA-256) con el subject provisto;
 *   4. calcula el fingerprint SPKI canónico de la clave pública;
 *   5. delega en la RPC service_role `arca_prepare_certificate_rotation`, que
 *      almacena la clave en Vault (pending_rotation), hace readback y valida
 *      fp(clave)==fp(SPKI del CSR);
 *   6. devuelve SOLO el CSR público + metadata sanitizada.
 *
 * La clave privada NUNCA se devuelve, ni se escribe en arca_config, ni se loguea,
 * ni se pasa por el navegador/operador. La credencial `active` vigente NO se toca.
 * No invoca WSAA ni afip-cae.
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// @ts-ignore: node-forge en Deno via npm
import forge from 'npm:node-forge@1.3.1'

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

/** SPKI SHA-256 canónico (n+e) — byte-idéntico a `openssl rsa -pubout -outform DER`
 *  y a private.arca_rsa_public_key_fingerprint_sha256 en SQL. */
async function spkiFingerprint(pub: any): Promise<string> {
  const der = forge.asn1.toDer(forge.pki.publicKeyToAsn1(pub)).getBytes()
  const bytes = Uint8Array.from(der, (c: string) => c.charCodeAt(0))
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Construye el subject del CSR con los datos públicos que exige AFIP. */
function buildSubjectAttrs(input: {
  razon_social: string; cuit: string; pais?: string; provincia?: string; localidad?: string; email?: string
}): any[] {
  const cuit = String(input.cuit).replace(/\D/g, '')
  const attrs: any[] = [
    { name: 'countryName', value: input.pais || 'AR' },
    { name: 'stateOrProvinceName', value: input.provincia || 'Buenos Aires' },
    { name: 'localityName', value: input.localidad || input.provincia || 'Buenos Aires' },
    { name: 'organizationName', value: input.razon_social },
    { name: 'serialNumber', value: `CUIT ${cuit}` },
    { name: 'commonName', value: input.razon_social },
  ]
  if (input.email) attrs.push({ name: 'emailAddress', value: input.email })
  return attrs
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: buildCorsHeaders(req) })
  if (req.method !== 'POST') return jsonResponse(req, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const authHeader = req.headers.get('Authorization') ?? ''

  // 1. Identidad (cliente con el JWT del usuario, NUNCA service_role).
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } })
  const { data: userData, error: userErr } = await userClient.auth.getUser()
  if (userErr || !userData?.user) return jsonResponse(req, { ok: false, error: 'UNAUTHORIZED' }, 401)
  const actor = userData.user.id

  let body: any
  try { body = await req.json() } catch { return jsonResponse(req, { ok: false, error: 'BAD_REQUEST' }, 400) }
  const businessId = String(body?.business_id ?? '')
  const razonSocial = String(body?.razon_social ?? '')
  const cuit = String(body?.cuit ?? '')
  if (!businessId || !razonSocial || !cuit) {
    return jsonResponse(req, { ok: false, error: 'MISSING_FIELDS', detail: 'business_id, razon_social, cuit' }, 400)
  }

  const admin = createClient(url, serviceKey)

  // 2. Membresía owner/admin (vía service_role; sin exponer datos).
  const { data: isAdmin } = await admin.rpc('is_business_owner_or_admin', {
    p_business_id: businessId, p_user_id: actor,
  })
  if (isAdmin !== true) return jsonResponse(req, { ok: false, error: 'FORBIDDEN' }, 403)

  let keyPem: string | null = null
  try {
    // 3. Generar clave RSA 2048 + CSR (node-forge). RSA 2048/e=65537: compatibilidad
    //    demostrada con ARCA y con el signer PKCS7 de afip-wsaa (mismo runtime).
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
    keyPem = forge.pki.privateKeyToPem(keys.privateKey)

    const csr = forge.pki.createCertificationRequest()
    csr.publicKey = keys.publicKey
    csr.setSubject(buildSubjectAttrs({
      razon_social: razonSocial, cuit,
      pais: body?.pais, provincia: body?.provincia, localidad: body?.localidad, email: body?.email,
    }))
    csr.sign(keys.privateKey, forge.md.sha256.create())
    const csrPem: string = forge.pki.certificationRequestToPem(csr).trim()

    const fingerprint = await spkiFingerprint(keys.publicKey)
    const cuitNorm = cuit.replace(/\D/g, '')
    const subject = {
      cn: razonSocial, o: razonSocial, serialNumber: `CUIT ${cuitNorm}`,
      c: body?.pais || 'AR', st: body?.provincia || 'Buenos Aires',
    }
    // idempotency key: del cliente si viene, si no una nueva (retry seguro si se reusa).
    const idempotencyKey = String(body?.idempotency_key ?? `afip-s4a-rot-${crypto.randomUUID()}`)

    // 4. Delegar en la RPC service_role: Vault + readback + validación fp(CSR)==fp(clave).
    const { data, error } = await admin.rpc('arca_prepare_certificate_rotation', {
      p_business_id: businessId,
      p_key_pem: keyPem,
      p_csr_pem: csrPem,
      p_fingerprint: fingerprint,
      p_algorithm: 'RSA',
      p_key_size: keys.publicKey.n.bitLength(),
      p_public_exponent: 65537,
      p_subject: subject,
      p_idempotency_key: idempotencyKey,
      p_actor: actor,
    })
    if (error) return jsonResponse(req, { ok: false, error: 'ROTATION_RPC_FAILED' }, 500)

    const state = (data && data.state) || null
    if (state !== 'ROTATION_PREPARED' && state !== 'ROTATION_ALREADY_PREPARED') {
      // estados de negocio (conflicto/validación) → 409/422 sanitizado, sin la clave
      return jsonResponse(req, { ok: false, state }, 409)
    }

    // 5. Devolver SOLO el CSR público + metadata. Nunca la clave.
    return jsonResponse(req, {
      ok: true,
      state,
      csr_pem: (data && data.csr_pem) || csrPem,
      fingerprint_trunc: data && data.fingerprint_trunc,
      algorithm: 'RSA',
      key_size: (data && data.key_size) || 2048,
      rotation_ref: data && data.rotation_ref,
      info: {
        firma: 'SHA-256',
        instrucciones: [
          'Descargá el CSR y subilo a AFIP (Administrador de Certificados Digitales).',
          'Descargá el certificado .crt emitido por AFIP.',
          'Volvé a la app e importá el certificado nuevo para activar la rotación (S4B).',
        ],
      },
    })
  } catch (_err) {
    // Nunca incluir la clave ni el detalle crudo en la respuesta/logs.
    return jsonResponse(req, { ok: false, error: 'ROTATION_PREPARE_FAILED' }, 500)
  } finally {
    keyPem = null   // best-effort; la memoria la administra el runtime
  }
})
