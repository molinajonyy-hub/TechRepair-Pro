/**
 * Edge Function: afip-cae
 * Solicita CAE (Código de Autorización Electrónica) ante WSFEv1 de AFIP/ARCA.
 * Primero obtiene token+sign via afip-wsaa (con caché), luego llama a FECAESolicitar.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
// Tipos
// ──────────────────────────────────────────────

interface FacturaData {
  business_id: string
  cuit:              string // CUIT del emisor (sin guiones)
  punto_venta:       number
  tipo_comprobante:  number // 1=Factura A, 6=Factura B, 11=Factura C, etc.
  tipo_doc_receptor: number // 80=CUIT, 96=DNI, 99=consumidor final
  nro_doc_receptor:  string
  concepto:          number // 1=Productos, 2=Servicios, 3=Productos y Servicios
  importe_neto:      number
  importe_iva:       number
  alicuota_iva:      number // 21, 10.5, 27, 0
  importe_total:     number
  moneda:            string // 'PES', 'DOL', etc.
  cotizacion_moneda: number // 1 para pesos
  fecha_cbte?:       string // YYYYMMDD, default hoy
  ambiente:          'homologacion' | 'produccion'
}

// ──────────────────────────────────────────────
// Helpers de fecha
// ──────────────────────────────────────────────

function todayYYYYMMDD(): string {
  const d = new Date()
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('')
}

function tenDaysLaterYYYYMMDD(): string {
  const d = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('')
}

// ──────────────────────────────────────────────
// Obtener el último número de comprobante autorizado
// ──────────────────────────────────────────────

async function getUltimoComprobante(
  token: string,
  sign: string,
  cuit: string,
  puntoVenta: number,
  tipoComprobante: number,
  ambiente: string
): Promise<number> {
  const wsfeUrl = ambiente === 'produccion'
    ? 'https://wsfe.afip.gov.ar/wsfev1/service.asmx'
    : 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx'

  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FECompUltimoAutorizado>
      <ar:Auth>
        <ar:Token>${token}</ar:Token>
        <ar:Sign>${sign}</ar:Sign>
        <ar:Cuit>${cuit}</ar:Cuit>
      </ar:Auth>
      <ar:PtoVta>${puntoVenta}</ar:PtoVta>
      <ar:CbteTipo>${tipoComprobante}</ar:CbteTipo>
    </ar:FECompUltimoAutorizado>
  </soapenv:Body>
</soapenv:Envelope>`

  const res = await fetch(wsfeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=UTF-8', 'SOAPAction': '"http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado"' },
    body: soap,
  })

  const text = await res.text()
  const match = text.match(/<CbteNro>(\d+)<\/CbteNro>/i)
  return match ? parseInt(match[1], 10) : 0
}

// ──────────────────────────────────────────────
// Construir SOAP de FECAESolicitar
// ──────────────────────────────────────────────

function buildFECAESolicitarSOAP(params: {
  token: string
  sign: string
  cuit: string
  puntoVenta: number
  tipoComprobante: number
  cbteDesde: number
  cbteHasta: number
  tipoDocReceptor: number
  nroDocReceptor: string
  concepto: number
  fechaCbte: string
  importeNeto: number
  importeIva: number
  alicuotaIva: number
  importeTotal: number
  moneda: string
  cotizacion: number
  fechaServDesde?: string
  fechaServHasta?: string
  fechaVtoPago?: string
}): string {
  const ivaId = params.alicuotaIva === 21 ? 5
    : params.alicuotaIva === 10.5 ? 4
    : params.alicuotaIva === 27   ? 6
    : 3 // 0% exento

  const serviciosDates = (params.concepto === 2 || params.concepto === 3)
    ? `<FchServDesde>${params.fechaServDesde || params.fechaCbte}</FchServDesde>
      <FchServHasta>${params.fechaServHasta  || params.fechaCbte}</FchServHasta>
      <FchVtoPago>${params.fechaVtoPago      || tenDaysLaterYYYYMMDD()}</FchVtoPago>`
    : ''

  // Si es consumidor final (tipo_doc=99) o B/C, el nro doc puede ser 0
  const nroDoc = (params.tipoDocReceptor === 99 || !params.nroDocReceptor)
    ? '0'
    : params.nroDocReceptor.replace(/\D/g, '')

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FECAESolicitar>
      <ar:Auth>
        <ar:Token>${params.token}</ar:Token>
        <ar:Sign>${params.sign}</ar:Sign>
        <ar:Cuit>${params.cuit}</ar:Cuit>
      </ar:Auth>
      <ar:FeCAEReq>
        <ar:FeCabReq>
          <ar:CantReg>1</ar:CantReg>
          <ar:PtoVta>${params.puntoVenta}</ar:PtoVta>
          <ar:CbteTipo>${params.tipoComprobante}</ar:CbteTipo>
        </ar:FeCabReq>
        <ar:FeDetReq>
          <ar:FECAEDetRequest>
            <ar:Concepto>${params.concepto}</ar:Concepto>
            <ar:DocTipo>${params.tipoDocReceptor}</ar:DocTipo>
            <ar:DocNro>${nroDoc}</ar:DocNro>
            <ar:CbteDesde>${params.cbteDesde}</ar:CbteDesde>
            <ar:CbteHasta>${params.cbteHasta}</ar:CbteHasta>
            <ar:CbteFch>${params.fechaCbte}</ar:CbteFch>
            <ar:ImpTotal>${params.importeTotal.toFixed(2)}</ar:ImpTotal>
            <ar:ImpTotConc>0.00</ar:ImpTotConc>
            <ar:ImpNeto>${params.importeNeto.toFixed(2)}</ar:ImpNeto>
            <ar:ImpOpEx>0.00</ar:ImpOpEx>
            <ar:ImpIVA>${params.importeIva.toFixed(2)}</ar:ImpIVA>
            <ar:ImpTrib>0.00</ar:ImpTrib>
            ${serviciosDates}
            <ar:MonId>${params.moneda}</ar:MonId>
            <ar:MonCotiz>${params.cotizacion.toFixed(2)}</ar:MonCotiz>
            <ar:Iva>
              <ar:AlicIva>
                <ar:Id>${ivaId}</ar:Id>
                <ar:BaseImp>${params.importeNeto.toFixed(2)}</ar:BaseImp>
                <ar:Importe>${params.importeIva.toFixed(2)}</ar:Importe>
              </ar:AlicIva>
            </ar:Iva>
          </ar:FECAEDetRequest>
        </ar:FeDetReq>
      </ar:FeCAEReq>
    </ar:FECAESolicitar>
  </soapenv:Body>
</soapenv:Envelope>`
}

// ──────────────────────────────────────────────
// Parser de la respuesta de FECAESolicitar
// ──────────────────────────────────────────────

interface CAEResult {
  cae: string
  cae_vencimiento: string
  numero_cbte: number
  resultado: string
  observaciones?: string
}

function parseFECAEResponse(soapXml: string): CAEResult {
  // Buscar errores SOAP primero
  if (soapXml.includes('<faultstring>') || soapXml.includes('<faultcode>')) {
    const fault = soapXml.match(/<faultstring>([\s\S]*?)<\/faultstring>/i)?.[1] || 'Error SOAP'
    throw new Error(`WSFEv1 SOAP fault: ${fault}`)
  }

  // Resultado general (A = Aprobado, R = Rechazado, P = Parcial)
  const resultado = soapXml.match(/<Resultado>([\s\S]*?)<\/Resultado>/i)?.[1]?.trim() || ''
  if (resultado === 'R') {
    const obs = soapXml.match(/<Msg>([\s\S]*?)<\/Msg>/gi)
      ?.map(m => m.replace(/<\/?Msg>/gi, ''))
      .join(' | ') || 'Rechazado por AFIP'
    throw new Error(`AFIP rechazó el comprobante: ${obs}`)
  }

  const cae = soapXml.match(/<CAE>([\s\S]*?)<\/CAE>/i)?.[1]?.trim()
  if (!cae) {
    // Buscar error en obs
    const errMsg = soapXml.match(/<Msg>([\s\S]*?)<\/Msg>/i)?.[1]?.trim()
    throw new Error(errMsg || 'No se obtuvo CAE en la respuesta de AFIP')
  }

  const caeVto   = soapXml.match(/<CAEFchVto>([\s\S]*?)<\/CAEFchVto>/i)?.[1]?.trim() || ''
  const cbteDesde = soapXml.match(/<CbteDesde>([\s\S]*?)<\/CbteDesde>/i)?.[1]?.trim() || '0'
  const obsMatch  = soapXml.match(/<Msg>([\s\S]*?)<\/Msg>/gi)
  const obs = obsMatch?.map(m => m.replace(/<\/?Msg>/gi, '')).join(' | ')

  // Formatear vencimiento YYYYMMDD → YYYY-MM-DD
  const vtoFmt = caeVto.length === 8
    ? `${caeVto.slice(0,4)}-${caeVto.slice(4,6)}-${caeVto.slice(6,8)}`
    : caeVto

  return {
    cae,
    cae_vencimiento: vtoFmt,
    numero_cbte: parseInt(cbteDesde, 10),
    resultado,
    observaciones: obs,
  }
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
    const body: FacturaData = await req.json()
    const {
      business_id,
      cuit,
      punto_venta,
      tipo_comprobante,
      tipo_doc_receptor,
      nro_doc_receptor,
      concepto,
      importe_neto,
      importe_iva,
      alicuota_iva,
      importe_total,
      moneda       = 'PES',
      cotizacion_moneda = 1,
      fecha_cbte,
      ambiente     = 'homologacion',
    } = body

    if (!business_id || !cuit || !punto_venta || !tipo_comprobante) {
      return jsonResponse(req, { success: false, error: 'Faltan datos requeridos: business_id, cuit, punto_venta, tipo_comprobante' }, 400)
    }

    // 1. Obtener token+sign (llama internamente a afip-wsaa)
    const wsaaRes = await supabase.functions.invoke('afip-wsaa', {
      body: { business_id, service: 'wsfe' },
    })

    if (wsaaRes.error || !wsaaRes.data?.success) {
      const errMsg = wsaaRes.data?.error || wsaaRes.error?.message || 'Error al autenticar con WSAA'
      return jsonResponse(req, { success: false, error: `WSAA: ${errMsg}` }, 502)
    }

    const { token, sign } = wsaaRes.data as { token: string; sign: string }

    const wsfeUrl = ambiente === 'produccion'
      ? 'https://wsfe.afip.gov.ar/wsfev1/service.asmx'
      : 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx'

    // 2. Obtener último número de comprobante
    const ultimoNro = await getUltimoComprobante(
      token, sign, cuit, punto_venta, tipo_comprobante, ambiente
    )
    const proximoNro = ultimoNro + 1

    // 3. Armar y enviar SOAP FECAESolicitar
    const fechaCbte = fecha_cbte || todayYYYYMMDD()
    const soapBody  = buildFECAESolicitarSOAP({
      token, sign, cuit,
      puntoVenta: punto_venta,
      tipoComprobante: tipo_comprobante,
      cbteDesde: proximoNro,
      cbteHasta: proximoNro,
      tipoDocReceptor: tipo_doc_receptor,
      nroDocReceptor: nro_doc_receptor,
      concepto,
      fechaCbte,
      importeNeto:  importe_neto,
      importeIva:   importe_iva,
      alicuotaIva:  alicuota_iva,
      importeTotal: importe_total,
      moneda,
      cotizacion: cotizacion_moneda,
    })

    const wsfeRes = await fetch(wsfeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        'SOAPAction': '"http://ar.gov.afip.dif.FEV1/FECAESolicitar"',
      },
      body: soapBody,
    })

    if (!wsfeRes.ok) {
      const text = await wsfeRes.text()
      throw new Error(`WSFEv1 HTTP ${wsfeRes.status}: ${text.slice(0, 400)}`)
    }

    const wsfeXml = await wsfeRes.text()
    const result  = parseFECAEResponse(wsfeXml)

    // 4. Formatear número de comprobante
    const nroCbteFormateado = `${String(punto_venta).padStart(4, '0')}-${String(result.numero_cbte).padStart(8, '0')}`

    return jsonResponse(req, {
      success: true,
      cae:                result.cae,
      cae_vencimiento:    result.cae_vencimiento,
      numero_comprobante: nroCbteFormateado,
      numero_cbte_raw:    result.numero_cbte,
      resultado:          result.resultado,
      observaciones:      result.observaciones || null,
    })

  } catch (err: any) {
    console.error('afip-cae error:', err)
    return jsonResponse(req, { success: false, error: err?.message || 'Error interno en CAE' }, 500)
  }
})
