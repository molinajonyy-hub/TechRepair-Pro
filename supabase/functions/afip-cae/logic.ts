/**
 * afip-cae/logic.ts — lógica pura de emisión WSFEv1 (sin Deno.serve ni imports por URL).
 *
 * Separado de index.ts para poder testear con Node (`node --test`), igual que
 * supabase/functions/_shared/scopedCors.ts. Usa solo globals estándar (fetch,
 * setTimeout, console, URL) — nada específico de Deno.
 *
 * Incluye la reconciliación idempotente (FECompConsultar) agregada tras el
 * incidente ARCA 2026-07-01: un timeout/502/503/504 DESPUÉS de enviar
 * FECAESolicitar es AMBIGUO (ARCA pudo haber autorizado el comprobante aunque
 * la respuesta se haya perdido). Nunca se debe pedir un número nuevo a ciegas
 * en ese caso — ver solicitarCAEConReconciliacion().
 */

// ──────────────────────────────────────────────
// Endpoint WSFEv1 — única fuente de verdad
// ──────────────────────────────────────────────
//
// El frontend (arcaService.ts) NUNCA decide ni construye esta URL: siempre
// delega la emisión a esta Edge Function. producción = servicios1 (WSFEv1
// real de AFIP/ARCA); homologación = wswhomo. wsfe.afip.gov.ar /
// wsfev1.afip.gov.ar NO son hosts válidos — no tienen registro DNS y deben
// eliminarse si reaparecen.
export function resolveWsfeUrl(ambiente: string): string {
  return ambiente === 'produccion'
    ? 'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
    : 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx'
}

// ──────────────────────────────────────────────
// Logging estructurado (sin credenciales fiscales)
// ──────────────────────────────────────────────

export function logStructured(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), fn: 'afip-cae', ...fields }))
}

// ──────────────────────────────────────────────
// Clasificación de errores de red — 3 categorías
// ──────────────────────────────────────────────
//
// A. not_sent   — el request nunca llegó a AFIP (falla de conexión ANTES de
//                 enviar: DNS, host inválido, conexión rechazada). Seguro
//                 reintentar la MISMA operación con backoff: no hay ambigüedad,
//                 AFIP nunca lo vio.
// B. ambiguous  — no sabemos si AFIP procesó el request (timeout, connection
//                 reset, EOF inesperado, 502/503/504 recibido DESPUÉS de
//                 enviar). Para una operación de LECTURA (FECompUltimoAutorizado,
//                 FECompConsultar) es seguro reintentar iguel (no tiene efecto
//                 secundario). Para FECAESolicitar NO se debe reintentar a
//                 ciegas: hay que reconciliar con FECompConsultar primero.
// C. fatal      — rechazo fiscal confirmado (SOAP fault, Resultado=R,
//                 validación, etc.). Nunca reintentable automáticamente.
//                 Esta categoría normalmente no pasa por classifyFetchError:
//                 ocurre DESPUÉS de un fetch exitoso, dentro de
//                 parseFECAEResponse/parseFECompConsultarResponse.

export type FetchErrorClass = 'not_sent' | 'ambiguous' | 'fatal'

const NOT_SENT_MARKERS = [
  'dns error', 'name or service not known', 'failed to lookup address',
  'connection refused', 'econnrefused',
  'invalid hostname', 'name resolution',
]

const AMBIGUOUS_MARKERS = [
  'connection reset', 'econnreset',
  'timed out', 'timeout',
  'unexpected eof', 'unexpected end of file', 'socket hang up',
  'body error', 'network error',
]

export function classifyFetchError(err: unknown): FetchErrorClass {
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase()
  if (NOT_SENT_MARKERS.some(m => msg.includes(m))) return 'not_sent'
  if (AMBIGUOUS_MARKERS.some(m => msg.includes(m))) return 'ambiguous'
  return 'fatal'
}

/** Error ya clasificado — evita volver a adivinar la categoría en capas superiores. */
export class ClassifiedFetchError extends Error {
  classification: FetchErrorClass
  constructor(message: string, classification: FetchErrorClass) {
    super(message)
    this.name = 'ClassifiedFetchError'
    this.classification = classification
  }
}

// ──────────────────────────────────────────────
// Reintentos seguros
// ──────────────────────────────────────────────
//
// Rechazos de FECAESolicitar, errores de validación/punto de venta/numeración
// y faults SOAP se resuelven DESPUÉS de un fetch exitoso (en parseFECAEResponse)
// y por lo tanto nunca pasan por este retry — solo se reintenta la conexión.

export const TRANSIENT_HTTP_STATUS = new Set([502, 503, 504])
export const RETRY_DELAYS_MS = [0, 500, 1500]

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface FetchRetryOpts {
  fetchImpl?: typeof fetch
  /**
   * true (default) para operaciones idempotentes de solo lectura
   * (FECompUltimoAutorizado, FECompConsultar): un resultado ambiguo (timeout,
   * reset, 502/503/504) no tiene efecto secundario, así que es seguro
   * reintentar igual que un error not_sent.
   *
   * false para FECAESolicitar (escritura fiscal no idempotente): un resultado
   * ambiguo NUNCA se reintenta acá — se lanza un ClassifiedFetchError
   * 'ambiguous' para que el caller reconcilie con FECompConsultar antes de
   * decidir si reintentar.
   */
  retryAmbiguous?: boolean
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  ctx: { correlationId: string; businessId: string; ambiente: string; stage: string },
  opts: FetchRetryOpts = {}
): Promise<Response> {
  const { fetchImpl = fetch, retryAmbiguous = true } = opts
  const hostname = new URL(url).hostname

  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt - 1] > 0) await sleep(RETRY_DELAYS_MS[attempt - 1])

    try {
      const res = await fetchImpl(url, init)

      if (TRANSIENT_HTTP_STATUS.has(res.status)) {
        logStructured({ ...ctx, hostname, attempt, classification: 'ambiguous', httpStatus: res.status })
        if (retryAmbiguous && attempt < RETRY_DELAYS_MS.length) continue
        if (!retryAmbiguous) throw new ClassifiedFetchError(`WSFEv1 HTTP ${res.status}`, 'ambiguous')
        // retryAmbiguous=true pero se agotaron los intentos: seguimos clasificando como ambiguous.
        throw new ClassifiedFetchError(`WSFEv1 HTTP ${res.status}`, 'ambiguous')
      }

      if (attempt > 1) logStructured({ ...ctx, hostname, attempt, classification: 'recovered', httpStatus: res.status })
      return res
    } catch (err) {
      if (err instanceof ClassifiedFetchError) throw err // ya decidido arriba (HTTP ambiguo con retryAmbiguous=false)

      const classification = classifyFetchError(err)
      logStructured({
        ...ctx, hostname, attempt, classification,
        error: String((err as any)?.message ?? err),
      })

      if (classification === 'fatal') throw err

      if (classification === 'ambiguous' && !retryAmbiguous) {
        throw new ClassifiedFetchError(String((err as any)?.message ?? err), 'ambiguous')
      }

      // not_sent siempre reintenta con backoff; ambiguous reintenta SOLO si retryAmbiguous.
      if (attempt === RETRY_DELAYS_MS.length) {
        throw new ClassifiedFetchError(String((err as any)?.message ?? err), classification)
      }
    }
  }

  // Inalcanzable (el for siempre retorna o lanza), pero TS necesita un retorno.
  throw new ClassifiedFetchError('fetchWithRetry: agotado sin resultado', 'ambiguous')
}

// ──────────────────────────────────────────────
// Tipos
// ──────────────────────────────────────────────

export interface FacturaData {
  business_id: string
  comprobante_id?: string // opcional, retrocompatible — habilita persistencia server-side del intento
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

export function todayYYYYMMDD(): string {
  const d = new Date()
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('')
}

export function tenDaysLaterYYYYMMDD(): string {
  const d = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('')
}

// ──────────────────────────────────────────────
// Obtener el último número de comprobante autorizado
// (lectura idempotente → retryAmbiguous=true, default)
// ──────────────────────────────────────────────

export async function getUltimoComprobante(
  token: string,
  sign: string,
  cuit: string,
  puntoVenta: number,
  tipoComprobante: number,
  ambiente: string,
  ctx: { correlationId: string; businessId: string },
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  const wsfeUrl = resolveWsfeUrl(ambiente)

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

  const res = await fetchWithRetry(wsfeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=UTF-8', 'SOAPAction': '"http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado"' },
    body: soap,
  }, { ...ctx, ambiente, stage: 'ultimo_autorizado' }, { fetchImpl, retryAmbiguous: true })

  const text = await res.text()
  const match = text.match(/<CbteNro>(\d+)<\/CbteNro>/i)
  return match ? parseInt(match[1], 10) : 0
}

// ──────────────────────────────────────────────
// Construir SOAP de FECAESolicitar
// ──────────────────────────────────────────────

export function buildFECAESolicitarSOAP(params: {
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

export interface CAEResult {
  cae: string
  cae_vencimiento: string
  numero_cbte: number
  resultado: string
  observaciones?: string
}

export function parseFECAEResponse(soapXml: string): CAEResult {
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
// FECompConsultar — reconciliación idempotente
// ──────────────────────────────────────────────
//
// Se usa cuando FECAESolicitar termina en resultado ambiguo (timeout,
// connection reset, 502/503/504 después de enviar). Antes de pedir un
// número nuevo, se consulta si ARCA ya autorizó justamente el número que
// se había intentado.

export function buildFECompConsultarSOAP(params: {
  token: string
  sign: string
  cuit: string
  puntoVenta: number
  tipoComprobante: number
  numero: number
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FECompConsultar>
      <ar:Auth>
        <ar:Token>${params.token}</ar:Token>
        <ar:Sign>${params.sign}</ar:Sign>
        <ar:Cuit>${params.cuit}</ar:Cuit>
      </ar:Auth>
      <ar:FeCompConsReq>
        <ar:CbteTipo>${params.tipoComprobante}</ar:CbteTipo>
        <ar:CbteNro>${params.numero}</ar:CbteNro>
        <ar:PtoVta>${params.puntoVenta}</ar:PtoVta>
      </ar:FeCompConsReq>
    </ar:FECompConsultar>
  </soapenv:Body>
</soapenv:Envelope>`
}

export interface ConsultaResult {
  /**
   * found        → ARCA ya autorizó este número; cae/cae_vencimiento presentes.
   * not_found    → ARCA confirma que este número nunca fue autorizado (código
   *                602 de WSFEv1). Es seguro reintentar CON EL MISMO número.
   * query_failed → no se pudo determinar (fault, error inesperado, respuesta
   *                incompleta, o la propia consulta falló). NO se debe asumir
   *                ni "autorizado" ni "no autorizado".
   */
  status: 'found' | 'not_found' | 'query_failed'
  cae?: string
  cae_vencimiento?: string
  resultado?: string
  numero_cbte?: number
  observaciones?: string
  motivo?: string
}

/** Código WSFEv1 para "comprobante inexistente" en FECompConsultar. */
const CODIGO_COMPROBANTE_INEXISTENTE = '602'

export function parseFECompConsultarResponse(soapXml: string): ConsultaResult {
  if (soapXml.includes('<faultstring>') || soapXml.includes('<faultcode>')) {
    const fault = soapXml.match(/<faultstring>([\s\S]*?)<\/faultstring>/i)?.[1] || 'Error SOAP'
    return { status: 'query_failed', motivo: `WSFEv1 SOAP fault: ${fault}` }
  }

  const cae = soapXml.match(/<CodAutorizacion>([\s\S]*?)<\/CodAutorizacion>/i)?.[1]?.trim()

  if (cae) {
    const caeVto     = soapXml.match(/<FchVto>([\s\S]*?)<\/FchVto>/i)?.[1]?.trim() || ''
    const resultado  = soapXml.match(/<Resultado>([\s\S]*?)<\/Resultado>/i)?.[1]?.trim() || ''
    const cbteDesde  = soapXml.match(/<CbteDesde>([\s\S]*?)<\/CbteDesde>/i)?.[1]?.trim() || '0'
    const obsMatch   = soapXml.match(/<Msg>([\s\S]*?)<\/Msg>/gi)
    const obs        = obsMatch?.map(m => m.replace(/<\/?Msg>/gi, '')).join(' | ')
    const vtoFmt = caeVto.length === 8
      ? `${caeVto.slice(0,4)}-${caeVto.slice(4,6)}-${caeVto.slice(6,8)}`
      : caeVto

    return {
      status: 'found',
      cae,
      cae_vencimiento: vtoFmt,
      resultado,
      numero_cbte: parseInt(cbteDesde, 10),
      observaciones: obs,
    }
  }

  const errCode = soapXml.match(/<Code>(\d+)<\/Code>/i)?.[1]
  const errMsg  = soapXml.match(/<Msg>([\s\S]*?)<\/Msg>/i)?.[1]?.trim()

  if (errCode === CODIGO_COMPROBANTE_INEXISTENTE) {
    return { status: 'not_found', motivo: errMsg || 'No se encontró el comprobante solicitado' }
  }

  if (errCode) {
    // Un código de error distinto de 602 no es "no encontrado" — no lo tratamos
    // como tal para no arriesgar una re-emisión sobre un número que sí existe.
    return { status: 'query_failed', motivo: `AFIP error ${errCode}: ${errMsg || 'sin detalle'}` }
  }

  // Ni CAE ni <Errors> reconocible: respuesta incompleta/inesperada.
  return { status: 'query_failed', motivo: 'Respuesta de FECompConsultar sin CAE ni error reconocible' }
}

export async function consultarComprobante(
  token: string,
  sign: string,
  cuit: string,
  puntoVenta: number,
  tipoComprobante: number,
  numero: number,
  ambiente: string,
  ctx: { correlationId: string; businessId: string },
  fetchImpl: typeof fetch = fetch
): Promise<ConsultaResult> {
  const wsfeUrl = resolveWsfeUrl(ambiente)
  const soap = buildFECompConsultarSOAP({ token, sign, cuit, puntoVenta, tipoComprobante, numero })

  try {
    const res = await fetchWithRetry(wsfeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml;charset=UTF-8', 'SOAPAction': '"http://ar.gov.afip.dif.FEV1/FECompConsultar"' },
      body: soap,
    }, { ...ctx, ambiente, stage: 'consultar_comprobante' }, { fetchImpl, retryAmbiguous: true })

    if (!res.ok) {
      return { status: 'query_failed', motivo: `WSFEv1 HTTP ${res.status}` }
    }
    const xml = await res.text()
    return parseFECompConsultarResponse(xml)
  } catch (err) {
    // La propia consulta falló (DNS, timeout agotado, etc.) — no podemos
    // determinar el estado real del comprobante en ARCA.
    return { status: 'query_failed', motivo: String((err as any)?.message ?? err) }
  }
}

// ──────────────────────────────────────────────
// Decisión tras resultado ambiguo — matriz de 5 casos
// ──────────────────────────────────────────────
//
// No alcanza con "FECompConsultar dice not_found → reenviar". Un ÚNICO
// not_found puede ser un falso negativo transitorio (réplica de ARCA no
// actualizada todavía). Antes de decidir, se exige:
//   1. Un primer FECompConsultar.
//   2. Si not_found, esperar con backoff y consultar AL MENOS una vez más.
//   3. Consultar FECompUltimoAutorizado para contrastar.
//   4. Recién ahí decidir con la matriz:
//
//   CASO A — ambas consultas not_found Y último_autorizado < número intentado
//            → safe_resend (un único reenvío, mismo número).
//   CASO B — último_autorizado >= número intentado PERO FECompConsultar no lo
//            recupera → inconsistencia real: pending_reconciliation, NUNCA
//            reenviar (podría estar pisando un número que ARCA ya usó).
//   CASO C — cualquiera de las dos consultas encuentra el comprobante
//            → authorized_reconciled.
//   CASO D — alguna consulta (o FECompUltimoAutorizado) falla → no hay
//            certeza → pending_reconciliation, NUNCA reenviar.
//   CASO E — rechazo fiscal definitivo → se maneja fuera de esta función
//            (parseFECAEResponse ya lo clasifica como 'fatal' antes de llegar acá).

const RECONCILIATION_RETRY_DELAY_MS = 800

export type ReconciliationDecision =
  | { kind: 'authorized_reconciled'; cae: string; cae_vencimiento: string; numero_cbte: number; resultado: string; observaciones?: string }
  | { kind: 'safe_resend' } // CASO A
  | { kind: 'pending_reconciliation'; message: string } // CASOS B y D

export async function decidirTrasAmbiguo(
  params: {
    token: string; sign: string; cuit: string
    puntoVenta: number; tipoComprobante: number
    numeroIntentado: number; ambiente: string
  },
  ctx: { correlationId: string; businessId: string },
  fetchImpl: typeof fetch = fetch
): Promise<ReconciliationDecision> {
  const { token, sign, cuit, puntoVenta, tipoComprobante, numeroIntentado, ambiente } = params
  const logCtx = { ...ctx, ambiente, stage: 'reconciliacion' as const }

  // 1. Primer FECompConsultar.
  const consulta1 = await consultarComprobante(token, sign, cuit, puntoVenta, tipoComprobante, numeroIntentado, ambiente, ctx, fetchImpl)
  if (consulta1.status === 'found') {
    logStructured({ ...logCtx, classification: 'caso_c_found_primera_consulta', cbteNro: numeroIntentado })
    return {
      kind: 'authorized_reconciled',
      cae: consulta1.cae!, cae_vencimiento: consulta1.cae_vencimiento || '',
      numero_cbte: consulta1.numero_cbte ?? numeroIntentado,
      resultado: consulta1.resultado || '', observaciones: consulta1.observaciones,
    }
  }

  // 2. Si not_found, esperar con backoff y repetir la consulta al menos una vez.
  //    Si la primera consulta ya fue query_failed, igual repetimos: puede ser
  //    un fallo transitorio de la consulta misma.
  await sleep(RECONCILIATION_RETRY_DELAY_MS)
  const consulta2 = await consultarComprobante(token, sign, cuit, puntoVenta, tipoComprobante, numeroIntentado, ambiente, ctx, fetchImpl)

  if (consulta2.status === 'found') {
    logStructured({ ...logCtx, classification: 'caso_c_found_segunda_consulta', cbteNro: numeroIntentado })
    return {
      kind: 'authorized_reconciled',
      cae: consulta2.cae!, cae_vencimiento: consulta2.cae_vencimiento || '',
      numero_cbte: consulta2.numero_cbte ?? numeroIntentado,
      resultado: consulta2.resultado || '', observaciones: consulta2.observaciones,
    }
  }

  // CASO D: si CUALQUIERA de las dos consultas no pudo determinar nada (no es
  // un not_found confirmado, es un fallo de la consulta), no hay certeza.
  if (consulta1.status === 'query_failed' || consulta2.status === 'query_failed') {
    logStructured({ ...logCtx, classification: 'caso_d_query_failed', cbteNro: numeroIntentado, motivo1: consulta1.motivo, motivo2: consulta2.motivo })
    return {
      kind: 'pending_reconciliation',
      message: 'No se pudo confirmar el estado del comprobante en ARCA (falló la consulta). Requiere verificación manual.',
    }
  }

  // Acá: ambas consultas confirmaron not_found. Contrastar con FECompUltimoAutorizado
  // antes de asumir que es seguro reenviar — nunca inferir SOLO desde ahí (podría
  // corresponder a otra operación concurrente), pero si NO coincide con lo que
  // FECompConsultar ya confirmó, es la doble señal que hace seguro reenviar.
  let ultimoAutorizado: number
  try {
    ultimoAutorizado = await getUltimoComprobante(token, sign, cuit, puntoVenta, tipoComprobante, ambiente, ctx, fetchImpl)
  } catch (err) {
    logStructured({ ...logCtx, classification: 'caso_d_ultimo_autorizado_failed', cbteNro: numeroIntentado, error: String((err as any)?.message ?? err) })
    return {
      kind: 'pending_reconciliation',
      message: 'No se pudo verificar FECompUltimoAutorizado para contrastar. Requiere verificación manual.',
    }
  }

  if (ultimoAutorizado < numeroIntentado) {
    // CASO A: doble not_found + el número intentado todavía no fue alcanzado
    // por ARCA → seguro que nunca se autorizó. Reenviar con el MISMO número.
    logStructured({ ...logCtx, classification: 'caso_a_safe_resend', cbteNro: numeroIntentado, ultimoAutorizado })
    return { kind: 'safe_resend' }
  }

  // CASO B: FECompUltimoAutorizado dice que ARCA YA autorizó hasta un número
  // >= el intentado, pero FECompConsultar (dos veces) no lo recuperó.
  // Inconsistencia real — nunca reenviar (podría pisar un número que ARCA
  // efectivamente usó, aunque sea para otra operación concurrente).
  logStructured({ ...logCtx, classification: 'caso_b_inconsistencia', cbteNro: numeroIntentado, ultimoAutorizado })
  return {
    kind: 'pending_reconciliation',
    message: `Inconsistencia: ARCA reporta un último autorizado (${ultimoAutorizado}) mayor o igual al número intentado (${numeroIntentado}), pero FECompConsultar no lo encuentra. Requiere verificación manual antes de reintentar.`,
  }
}

// ──────────────────────────────────────────────
// Orquestador: FECAESolicitar con reconciliación idempotente
// ──────────────────────────────────────────────

export type EmissionOutcome =
  | (CAEResult & { kind: 'authorized'; reconciled: false })
  | (CAEResult & { kind: 'authorized_reconciled'; reconciled: true })
  | { kind: 'rejected'; message: string }
  | { kind: 'not_sent'; message: string }
  | { kind: 'pending_reconciliation'; puntoVenta: number; tipoComprobante: number; numeroIntentado: number; message: string }

/** Como mucho un reenvío de FECAESolicitar, y solo tras confirmar CASO A. Nunca un loop. */
const MAX_RECONCILIATION_ROUNDS = 1

export async function solicitarCAEConReconciliacion(
  params: {
    token: string; sign: string; cuit: string
    puntoVenta: number; tipoComprobante: number
    cbteDesde: number; cbteHasta: number
    tipoDocReceptor: number; nroDocReceptor: string
    concepto: number; fechaCbte: string
    importeNeto: number; importeIva: number; alicuotaIva: number; importeTotal: number
    moneda: string; cotizacion: number
    ambiente: string
  },
  ctx: { correlationId: string; businessId: string },
  fetchImpl: typeof fetch = fetch
): Promise<EmissionOutcome> {
  const wsfeUrl = resolveWsfeUrl(params.ambiente)
  const soapBody = buildFECAESolicitarSOAP(params)
  const stageCtx = { ...ctx, ambiente: params.ambiente, stage: 'solicitar_cae' }

  let round = 0
  while (true) {
    let failure: { classification: FetchErrorClass; message: string } | null = null

    try {
      const res = await fetchWithRetry(wsfeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml;charset=UTF-8', 'SOAPAction': '"http://ar.gov.afip.dif.FEV1/FECAESolicitar"' },
        body: soapBody,
      }, stageCtx, { fetchImpl, retryAmbiguous: false })

      if (!res.ok) {
        const text = await res.text()
        failure = { classification: 'fatal', message: `WSFEv1 HTTP ${res.status}: ${text.slice(0, 400)}` }
      } else {
        const xml = await res.text()
        const result = parseFECAEResponse(xml) // lanza en rechazo/fault — nunca ambiguo
        logStructured({ ...stageCtx, classification: 'success', reconciled: round > 0, resultado: result.resultado })
        return round === 0
          ? { kind: 'authorized', reconciled: false, ...result }
          : { kind: 'authorized_reconciled', reconciled: true, ...result }
      }
    } catch (err) {
      if (err instanceof ClassifiedFetchError) {
        failure = { classification: err.classification, message: err.message }
      } else {
        failure = { classification: 'fatal', message: (err as Error)?.message ?? String(err) }
      }
    }

    if (failure.classification === 'not_sent') {
      logStructured({ ...stageCtx, classification: 'not_sent', error: failure.message })
      return { kind: 'not_sent', message: failure.message }
    }
    if (failure.classification === 'fatal') {
      logStructured({ ...stageCtx, classification: 'rejected', error: failure.message })
      return { kind: 'rejected', message: failure.message }
    }

    // ambiguous: no sabemos si ARCA autorizó el comprobante. Decidir con la
    // matriz de 5 casos ANTES de hacer cualquier otra cosa — nunca pedir un
    // número nuevo a ciegas (ver decidirTrasAmbiguo).
    logStructured({ ...stageCtx, classification: 'ambiguous', error: failure.message, cbteNro: params.cbteDesde })

    const decision = await decidirTrasAmbiguo({
      token: params.token, sign: params.sign, cuit: params.cuit,
      puntoVenta: params.puntoVenta, tipoComprobante: params.tipoComprobante,
      numeroIntentado: params.cbteDesde, ambiente: params.ambiente,
    }, ctx, fetchImpl)

    if (decision.kind === 'authorized_reconciled') {
      return { ...decision, reconciled: true }
    }

    if (decision.kind === 'safe_resend' && round < MAX_RECONCILIATION_ROUNDS) {
      // CASO A confirmado: seguro reintentar CON EL MISMO cbteDesde/cbteHasta
      // (soapBody no cambia) — nunca se avanza al siguiente número.
      round++
      logStructured({ ...ctx, ambiente: params.ambiente, stage: 'reconciliacion', classification: 'safe_resend_retry', cbteNro: params.cbteDesde, round })
      continue
    }

    // pending_reconciliation (CASO B o D), o safe_resend ya sin rondas
    // disponibles: nunca inventar un CAE ni avanzar de número sin esta
    // confirmación explícita.
    return {
      kind: 'pending_reconciliation',
      puntoVenta: params.puntoVenta,
      tipoComprobante: params.tipoComprobante,
      numeroIntentado: params.cbteDesde,
      message: decision.kind === 'pending_reconciliation'
        ? decision.message
        : 'Se agotaron los reenvíos seguros disponibles; requiere verificación manual antes de volver a intentar.',
    }
  }
}
