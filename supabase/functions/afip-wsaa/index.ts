/**
 * Edge Function: afip-wsaa
 * Autentica ante el WSAA de AFIP/ARCA usando un certificado digital.
 * Firma el TRA con PKCS7/CMS usando node-forge (soporta PEM y PFX).
 * Cachea el token/sign en la tabla arca_config para reutilizarlos.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// @ts-ignore: node-forge en Deno via npm
import forge from 'npm:node-forge@1.3.1'

// ─────────────────────────────────────────────────────────────────
// CORS — single source of truth (buildCorsHeaders + jsonResponse)
//
// Mirrors mp-subscription. Origin: an exact allowlist. We echo back ONLY the
// request's Origin when it is allowed; otherwise we send NO Access-Control-
// Allow-Origin at all (no wildcard, no canonical fallback) so an unauthorized
// origin can never read the response.
//
// Allowlist sources (each a single origin OR a comma-separated list):
//   - MP_CORS_ORIGIN  (preferred)
//   - APP_URL         (usually the same origin)
// The canonical production origins are HARD defaults so a misconfigured secret
// can never drop the real origin or fall back to a stale Vercel domain.
//
// Headers: an explicit, case-insensitive allowlist. We return ONLY the
// intersection of Access-Control-Request-Headers with that allowlist. cache-
// control and pragma are included because Chrome adds them on a hard reload;
// omitting them makes the browser fail the preflight and never send the POST.
// ─────────────────────────────────────────────────────────────────
// Both hosts are real production origins. The apex 307-redirects to www (Vercel),
// so on the live site the browser's Origin is usually https://www.techrepairpro.app.
const CANONICAL_ORIGINS = [
  'https://www.techrepairpro.app',
  'https://techrepairpro.app',
]

const stripSlash = (o: string) => o.trim().replace(/\/+$/, '')

const parseOrigins = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map(stripSlash).filter(Boolean)

const ALLOWED_ORIGINS: string[] = [
  ...new Set<string>([
    ...CANONICAL_ORIGINS,
    ...parseOrigins(Deno.env.get('MP_CORS_ORIGIN')),
    ...parseOrigins(Deno.env.get('APP_URL')),
  ]),
]

// Request headers we are willing to allow on the actual request (lower-case).
const ALLOWED_REQUEST_HEADERS = new Set<string>([
  'authorization',
  'x-client-info',
  'apikey',
  'content-type',
  'cache-control',
  'pragma',
])

// Fallback for non-preflight responses (where ACAH is ignored by the browser).
const DEFAULT_ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type'

// Intersection of the preflight's requested headers with our allowlist.
function pickAllowedRequestHeaders(req: Request): string {
  const requested = req.headers.get('Access-Control-Request-Headers')
  if (!requested) return DEFAULT_ALLOW_HEADERS
  const allowed = requested
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0 && ALLOWED_REQUEST_HEADERS.has(h))
  return allowed.join(', ')
}

// The single CORS-header builder. Used by every response (preflight, success, error).
function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = stripSlash(req.headers.get('Origin') ?? '')
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': pickAllowedRequestHeaders(req),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin, Access-Control-Request-Headers',
  }
  // Only emit Allow-Origin for an authorized origin; never a canonical fallback.
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

// The single JSON-response builder. Always carries the CORS headers.
function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...buildCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// ──────────────────────────────────────────────
// Helpers de formateo de fecha para AFIP
// ──────────────────────────────────────────────

function toAfipDate(date: Date): string {
  // AFIP requiere offset -03:00 (Argentina Standard Time)
  // Restar 3 horas al UTC para obtener hora argentina, luego etiquetar como -03:00.
  // Sin este ajuste, se envía hora UTC con etiqueta -03:00, lo que hace que AFIP
  // lo interprete como 3 horas en el futuro y rechace el TRA.
  const arg = new Date(date.getTime() - 3 * 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const yyyy = arg.getUTCFullYear()
  const MM   = pad(arg.getUTCMonth() + 1)
  const dd   = pad(arg.getUTCDate())
  const hh   = pad(arg.getUTCHours())
  const mm   = pad(arg.getUTCMinutes())
  const ss   = pad(arg.getUTCSeconds())
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}-03:00`
}

// ──────────────────────────────────────────────
// Generación del TRA (Ticket de Requerimiento de Acceso)
// ──────────────────────────────────────────────

function buildTRA(service = 'wsfe'): string {
  const now        = new Date()
  const expiration = new Date(now.getTime() + 12 * 60 * 60 * 1000) // 12 horas
  const uniqueId   = Math.floor(now.getTime() / 1000)

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<loginTicketRequest version="1.0">\n` +
    `  <header>\n` +
    `    <uniqueId>${uniqueId}</uniqueId>\n` +
    `    <generationTime>${toAfipDate(now)}</generationTime>\n` +
    `    <expirationTime>${toAfipDate(expiration)}</expirationTime>\n` +
    `  </header>\n` +
    `  <service>${service}</service>\n` +
    `</loginTicketRequest>`
}

// ──────────────────────────────────────────────
// Firma del TRA con PKCS7 CMS (node-forge)
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// Verificar que el certificado y la clave privada coincidan
// ──────────────────────────────────────────────

function verifyCertKeyMatch(cert: any, privateKey: any): void {
  // Comparar el módulo RSA del certificado con el de la clave privada
  const certPubMod  = cert.publicKey.n.toString(16)
  const privKeyMod  = privateKey.n.toString(16)
  if (certPubMod !== privKeyMod) {
    throw new Error(
      'El certificado y la clave privada NO coinciden. ' +
      'Asegurate de haber generado el CSR desde TechRepair (no de una fuente externa), ' +
      'subido ESE .csr a AFIP y pegado el .crt recibido. ' +
      'Si regeneraste el CSR después de recibir el certificado, debés solicitar un nuevo certificado a AFIP.'
    )
  }
}

function signTRAWithPEM(traXml: string, certPem: string, privateKeyPem: string): string {
  const cert       = forge.pki.certificateFromPem(certPem)
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem)

  // Verificar coincidencia cert ↔ clave antes de firmar
  verifyCertKeyMatch(cert, privateKey)

  // AFIP WSAA: usar SHA-256 sin authenticatedAttributes opcionales
  // para máxima compatibilidad con el servidor de homologación
  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(traXml, 'utf8')
  p7.addCertificate(cert)
  p7.addSigner({
    key: privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  })
  p7.sign()

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes()
  return forge.util.encode64(der)
}

function signTRAWithPFX(traXml: string, pfxBase64: string, pfxPassword = ''): string {
  const pfxDer  = forge.util.decode64(pfxBase64)
  const pfxAsn1 = forge.asn1.fromDer(pfxDer)
  const pfx     = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, false, pfxPassword)

  // Extraer certificado
  const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag })
  const certBag  = certBags[forge.pki.oids.certBag]?.[0]
  if (!certBag?.cert) throw new Error('No se encontró el certificado en el PFX')
  const cert = certBag.cert

  // Extraer clave privada
  const keyBags = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })
  const keyBag  = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]
  if (!keyBag?.key) throw new Error('No se encontró la clave privada en el PFX')
  const privateKey = keyBag.key

  verifyCertKeyMatch(cert, privateKey)

  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(traXml, 'utf8')
  p7.addCertificate(cert)
  p7.addSigner({
    key: privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  })
  p7.sign()

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes()
  return forge.util.encode64(der)
}

// ──────────────────────────────────────────────
// Llamada SOAP al WSAA
// ──────────────────────────────────────────────

async function callWSAA(signedCms: string, ambiente: string): Promise<string> {
  const url = ambiente === 'produccion'
    ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms'
    : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms'

  const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:ser="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <ser:loginCms>
      <ser:in0>${signedCms}</ser:in0>
    </ser:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml;charset=UTF-8',
      'SOAPAction': '""',
    },
    body: soapBody,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`WSAA HTTP ${res.status}: ${text.slice(0, 500)}`)
  }

  return await res.text()
}

// ──────────────────────────────────────────────
// Parser de la respuesta del WSAA
// ──────────────────────────────────────────────

function parseWSAAResponse(soapXml: string): { token: string; sign: string; expirationTime: string } {
  // El WSAA devuelve el TA (Ticket de Acceso) como XML dentro del SOAP
  // Extraemos el contenido de <loginCmsReturn>
  const returnMatch = soapXml.match(/<(?:[^:>]+:)?loginCmsReturn>([\s\S]*?)<\/(?:[^:>]+:)?loginCmsReturn>/i)
  if (!returnMatch) {
    // Buscar faults SOAP
    if (soapXml.includes('faultstring')) {
      const fault = soapXml.match(/<faultstring>([\s\S]*?)<\/faultstring>/i)?.[1] || 'Error SOAP desconocido'
      throw new Error(`WSAA SOAP fault: ${fault}`)
    }
    throw new Error('No se encontró loginCmsReturn en la respuesta del WSAA')
  }

  // Puede venir HTML-encoded o en CDATA
  let taXml = returnMatch[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .trim()

  // Extraer token, sign y expirationTime del TA
  const token = taXml.match(/<token>([\s\S]*?)<\/token>/i)?.[1]?.trim()
  const sign  = taXml.match(/<sign>([\s\S]*?)<\/sign>/i)?.[1]?.trim()
  const expiration = taXml.match(/<expirationTime>([\s\S]*?)<\/expirationTime>/i)?.[1]?.trim()

  if (!token || !sign) {
    throw new Error(`No se pudo extraer token/sign del TA. Respuesta: ${taXml.slice(0, 300)}`)
  }

  return { token, sign, expirationTime: expiration || '' }
}

// ──────────────────────────────────────────────
// Decrypt helper (intenta RPC pgcrypto, fallback a base64 plano)
// ──────────────────────────────────────────────

async function decryptField(supabase: any, encrypted: string): Promise<string> {
  try {
    const { data, error } = await supabase.rpc('decrypt_data', { encrypted_text: encrypted })
    if (!error && data) return data as string
  } catch (_) {
    // RPC no existe, usar como texto plano
  }
  return encrypted
}

// ──────────────────────────────────────────────
// Handler principal
// ──────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    // Preflight — CORS headers only, no body.
    return new Response(null, { status: 204, headers: buildCorsHeaders(req) })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase    = createClient(supabaseUrl, supabaseKey)

  try {
    const { business_id, service = 'wsfe', force_refresh = false } = await req.json()

    if (!business_id) {
      return jsonResponse(req, { success: false, error: 'Falta business_id' }, 400)
    }

    // 1. Cargar configuración ARCA
    const { data: config, error: configError } = await supabase
      .from('arca_config')
      .select('*')
      .eq('business_id', business_id)
      .single()

    if (configError || !config) {
      return jsonResponse(req, { success: false, error: 'Configuración ARCA no encontrada para este negocio' }, 404)
    }

    // 2. Verificar si el token en caché sigue siendo válido (con buffer de 30 min)
    if (!force_refresh && config.wsaa_token && config.wsaa_sign && config.wsaa_token_expires) {
      const expiresAt = new Date(config.wsaa_token_expires)
      const bufferMs  = 30 * 60 * 1000 // 30 minutos
      if (expiresAt.getTime() - Date.now() > bufferMs) {
        return jsonResponse(req, {
          success: true,
          token: config.wsaa_token,
          sign:  config.wsaa_sign,
          cached: true,
        })
      }
    }

    // 3. Validar que haya certificado
    if (!config.pfx_file && !config.cert_file) {
      return jsonResponse(req, { success: false, error: 'No hay certificado digital configurado. Cargá el PFX o el certificado en Configuración > ARCA.' }, 422)
    }

    // 4. Verificar vencimiento del certificado
    if (config.expires_at && new Date(config.expires_at) < new Date()) {
      return jsonResponse(req, { success: false, error: 'El certificado digital está vencido. Renovalo en AFIP.' }, 422)
    }

    // 5. Generar y firmar TRA
    const traXml = buildTRA(service)
    let signedCms: string

    if (config.pfx_file) {
      const pfxData   = await decryptField(supabase, config.pfx_file)
      const pfxPass   = config.pfx_password ? await decryptField(supabase, config.pfx_password) : ''
      signedCms = signTRAWithPFX(traXml, pfxData, pfxPass)
    } else {
      const certPem = await decryptField(supabase, config.cert_file)
      const keyPem  = await decryptField(supabase, config.private_key)
      signedCms = signTRAWithPEM(traXml, certPem, keyPem)
    }

    // 6. Llamar al WSAA
    const ambiente  = config.ambiente || 'homologacion'
    const soapReply = await callWSAA(signedCms, ambiente)

    // 7. Parsear respuesta
    const { token, sign, expirationTime } = parseWSAAResponse(soapReply)

    // 8. Cachear en DB
    const expiresAt = expirationTime ? new Date(expirationTime).toISOString() : new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    await supabase
      .from('arca_config')
      .update({
        wsaa_token:         token,
        wsaa_sign:          sign,
        wsaa_token_expires: expiresAt,
        estado_conexion:    'conectado',
        ultima_sincronizacion: new Date().toISOString(),
        ultimo_error:       null,
      })
      .eq('business_id', business_id)

    return jsonResponse(req, { success: true, token, sign, cached: false, expires_at: expiresAt })

  } catch (err: any) {
    console.error('afip-wsaa error:', err)

    const errMsg = err?.message || 'Error interno en WSAA'

    // Marcar error en DB si hay business_id
    try {
      const body = await req.clone().json().catch(() => ({}))
      if (body?.business_id) {
        await supabase
          .from('arca_config')
          .update({ estado_conexion: 'error', ultimo_error: errMsg })
          .eq('business_id', body.business_id)
      }
    } catch (_) { /* ignorar */ }

    // Retornar 200 con success:false — un 500 hace que el cliente Supabase
    // descarte el body y muestre solo "Edge Function returned a non-2xx status code".
    return jsonResponse(req, { success: false, error: errMsg }, 200)
  }
})
