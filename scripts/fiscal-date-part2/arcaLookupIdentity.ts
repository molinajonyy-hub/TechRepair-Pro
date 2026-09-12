// ============================================================================
// FISCAL DATE Parte 2 — validación de IDENTIDAD FISCAL de un resultado de ARCA
//
// Módulo PURO: sin red, sin base, sin credenciales, sin efectos. Existe aparte
// del runner para poder testearlo sin ejecutar nada, y para que el backfill
// consuma exactamente la misma regla que el runner aplicó.
//
// La pregunta que responde: ¿este resultado de FECompConsultar corresponde
// REALMENTE al comprobante que pedimos? Un CbteFch sólo sirve si la identidad
// fiscal coincide. `numero_fiscal` por sí solo es ambiguo — hay un
// 0010-00000001 factura y otro nota de crédito— así que se exige PV + CbteTipo
// + número + CAE.
// ============================================================================

/** Lo que el plan afirma sobre un comprobante, tomado de la base. */
export interface PlanEntry {
  comprobante_id: string
  business_id: string
  punto_venta: number
  cbte_tipo: number
  numero: number
  /** CAE que la base tiene registrado. Es el testigo fuerte de identidad. */
  cae_local?: string | null
  /** Importe total local, cuando está disponible. */
  importe_local?: number | null
}

/** Lo que devuelve afip-fe-query (operacion: 'consultar'). */
export interface ArcaConsultaResult {
  status?: 'found' | 'not_found' | 'query_failed'
  cae?: string
  /** CbteFch que ARCA reporta, ya como 'YYYY-MM-DD' en el contrato del endpoint. */
  fecha_comprobante?: string
  punto_venta_arca?: number
  tipo_comprobante_arca?: number
  numero_cbte?: number
  numero_hasta?: number
  importe_total?: number
  motivo?: string
}

export type LookupVerdict = 'BACKFILLABLE' | 'REVIEW_REQUIRED'

export interface LookupEvaluation {
  verdict: LookupVerdict
  /** Sólo se llena en BACKFILLABLE, y siempre con forma YYYYMMDD. */
  cbte_fch?: string
  /** Coincidencias evaluadas, para que una persona pueda auditar sin volver a ARCA. */
  checks: {
    status: string
    cae: 'match' | 'mismatch' | 'unknown'
    punto_venta: 'match' | 'mismatch' | 'unknown'
    cbte_tipo: 'match' | 'mismatch' | 'unknown'
    numero: 'match' | 'mismatch' | 'unknown'
    importe: 'match' | 'mismatch' | 'unknown'
    cbte_fch: 'valid' | 'invalid' | 'absent'
  }
  /** Motivos concretos por los que NO es backfillable. Vacío si lo es. */
  problemas: string[]
}

/** YYYY-MM-DD (o el timestamp que arma PostgREST) -> YYYYMMDD. Nada más. */
export function toYyyymmdd(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d] = m
  const nMo = Number(mo), nD = Number(d)
  if (nMo < 1 || nMo > 12 || nD < 1 || nD > 31) return null
  // Fecha imposible (31 de febrero): se rechaza, no se normaliza al mes que
  // viene. Inventaría una fecha fiscal que ARCA nunca informó.
  const probe = new Date(Date.UTC(Number(y), nMo - 1, nD))
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== nMo - 1 || probe.getUTCDate() !== nD) {
    return null
  }
  return `${y}${mo}${d}`
}

const cmpNum = (a: unknown, b: unknown): 'match' | 'mismatch' | 'unknown' => {
  if (a === null || a === undefined || b === null || b === undefined) return 'unknown'
  return Number(a) === Number(b) ? 'match' : 'mismatch'
}

/**
 * Decide si el resultado de ARCA puede alimentar un backfill.
 *
 * Fail-closed: cualquier ausencia, diferencia o ambigüedad cae en
 * REVIEW_REQUIRED. No se adivina.
 */
export function evaluateLookup(entry: PlanEntry, result: ArcaConsultaResult | null): LookupEvaluation {
  const problemas: string[] = []
  const status = result?.status ?? 'sin_respuesta'

  const cbteFch = toYyyymmdd(result?.fecha_comprobante)
  const checks: LookupEvaluation['checks'] = {
    status,
    cae: (() => {
      if (!entry.cae_local || !result?.cae) return 'unknown'
      return String(entry.cae_local).trim() === String(result.cae).trim() ? 'match' : 'mismatch'
    })(),
    punto_venta: cmpNum(entry.punto_venta, result?.punto_venta_arca),
    cbte_tipo: cmpNum(entry.cbte_tipo, result?.tipo_comprobante_arca),
    numero: cmpNum(entry.numero, result?.numero_cbte),
    importe: (() => {
      if (entry.importe_local === null || entry.importe_local === undefined) return 'unknown'
      if (result?.importe_total === null || result?.importe_total === undefined) return 'unknown'
      // Tolerancia de centavo por el redondeo del XML, nada más.
      return Math.abs(Number(entry.importe_local) - Number(result.importe_total)) <= 0.01 ? 'match' : 'mismatch'
    })(),
    cbte_fch: result?.fecha_comprobante === undefined || result?.fecha_comprobante === null
      ? 'absent'
      : (cbteFch ? 'valid' : 'invalid'),
  }

  if (status !== 'found') problemas.push(`ARCA no confirmó el comprobante (status=${status})`)
  if (checks.cbte_fch === 'absent') problemas.push('ARCA no informó CbteFch')
  if (checks.cbte_fch === 'invalid') problemas.push('el CbteFch informado no es una fecha válida')
  for (const campo of ['cae', 'punto_venta', 'cbte_tipo', 'numero'] as const) {
    if (checks[campo] === 'mismatch') problemas.push(`${campo} no coincide con el comprobante local`)
    if (checks[campo] === 'unknown') problemas.push(`${campo} no se pudo comparar`)
  }
  // El importe es evidencia de apoyo: si falta no bloquea, pero si CONTRADICE sí.
  if (checks.importe === 'mismatch') problemas.push('importe_total no coincide con el comprobante local')

  return {
    verdict: problemas.length === 0 ? 'BACKFILLABLE' : 'REVIEW_REQUIRED',
    cbte_fch: problemas.length === 0 && cbteFch ? cbteFch : undefined,
    checks,
    problemas,
  }
}
