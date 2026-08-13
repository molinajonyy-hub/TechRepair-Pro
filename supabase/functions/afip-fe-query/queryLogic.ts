/**
 * afip-fe-query/queryLogic.ts - WSFEv1 SOLO LECTURA.
 *
 * Contiene UNICAMENTE FECompConsultar y FECompUltimoAutorizado. No hay
 * FECAESolicitar, ni reserva de numeracion, ni escritura de ningun tipo.
 *
 * COPIA DELIBERADA de los bloques read-only de afip-cae/logic.ts, verbatim.
 * No se importa aquel modulo a proposito: hacerlo arrastraria
 * buildFECAESolicitarSOAP / solicitarCAEConReconciliacion al grafo de imports
 * de este endpoint y rompeeria la garantia estructural de que no puede emitir
 * (ver scripts/guards/afip-query-readonly.mjs). Se prefiere la duplicacion
 * acotada al boundary difuso.
 *
 * Si el parser de afip-cae cambia, este archivo debe regenerarse a mano y con
 * intencion: el guard verifica que ambos sigan coincidiendo en los bloques
 * compartidos.
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

export function logStructured(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), fn: 'afip-fe-query', ...fields }))
}

export type FetchErrorClass = 'not_sent' | 'ambiguous' | 'fatal'

// Marcadores que usa classifyFetchError. Van aca porque sin ellos esa funcion
// lanza ReferenceError en el primer error de red — no en el camino feliz, que
// es lo que hace facil pasarlos por alto.
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

/** Error ya clasificado — evita volver a adivinar la categoría en capas superiores. */
export class ClassifiedFetchError extends Error {
  classification: FetchErrorClass
  constructor(message: string, classification: FetchErrorClass) {
    super(message)
    this.name = 'ClassifiedFetchError'
    this.classification = classification
  }
}

export function classifyFetchError(err: unknown): FetchErrorClass {
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase()
  if (NOT_SENT_MARKERS.some(m => msg.includes(m))) return 'not_sent'
  if (AMBIGUOUS_MARKERS.some(m => msg.includes(m))) return 'ambiguous'
  return 'fatal'
}

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
  // ── Campos AGREGADOS respecto de afip-cae/logic.ts ────────────────────────
  // La emision solo necesita saber SI existe y con que CAE. Reconciliar exige
  // ademas poder comparar identidad y contenido contra la fila local, que es
  // justamente lo que distingue un match real de una coincidencia de numero.
  punto_venta_arca?: number
  tipo_comprobante_arca?: number
  numero_hasta?: number
  fecha_comprobante?: string
  importe_total?: number
  doc_tipo?: number
  doc_numero?: string
}

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

    // Extraccion adicional para reconciliar (ver ConsultaResult).
    const num = (re: RegExp): number | undefined => {
      const v = soapXml.match(re)?.[1]?.trim()
      if (v === undefined || v === '') return undefined
      const n = Number(v)
      return Number.isFinite(n) ? n : undefined
    }
    const fchCbte = soapXml.match(/<CbteFch>([\s\S]*?)<\/CbteFch>/i)?.[1]?.trim() || ''
    const fchFmt = fchCbte.length === 8
      ? `${fchCbte.slice(0,4)}-${fchCbte.slice(4,6)}-${fchCbte.slice(6,8)}`
      : (fchCbte || undefined)

    return {
      status: 'found',
      cae,
      cae_vencimiento: vtoFmt,
      resultado,
      numero_cbte: parseInt(cbteDesde, 10),
      observaciones: obs,
      punto_venta_arca:      num(/<PtoVta>(\d+)<\/PtoVta>/i),
      tipo_comprobante_arca: num(/<CbteTipo>(\d+)<\/CbteTipo>/i),
      numero_hasta:          num(/<CbteHasta>(\d+)<\/CbteHasta>/i),
      fecha_comprobante:     fchFmt,
      importe_total:         num(/<ImpTotal>([\d.]+)<\/ImpTotal>/i),
      doc_tipo:              num(/<DocTipo>(\d+)<\/DocTipo>/i),
      doc_numero:            soapXml.match(/<DocNro>(\d+)<\/DocNro>/i)?.[1]?.trim(),
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
    return { status: 'query_failed', motivo: `ARCA error ${errCode}: ${errMsg || 'sin detalle'}` }
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
