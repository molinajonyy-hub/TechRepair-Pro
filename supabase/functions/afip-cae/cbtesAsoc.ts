import {
  cbteTipoFacturaParaNotaCredito,
  esCbteTipoNotaCredito,
  fiscalIdentity,
  resolverCbteTipo,
  type FiscalIdentity,
} from '../_shared/fiscalIdentity.ts'

/**
 * Datos opcionales que llegan en el body de afip-cae. Para una Nota de
 * Crédito no son autoridad: sólo sirven para comprobar que el caller envió la
 * misma terna que ya vive en `comprobantes`.
 */
export interface CbtesAsocBody {
  cbteAsocTipo?: unknown
  cbteAsocPtoVta?: unknown
  cbteAsocNro?: unknown
}

/**
 * Código estable del gate que cortó. Va en el log y en la respuesta: sin esto,
 * un 400 de este módulo era indistinguible del resto y hubo que reconstruirlo
 * por eliminación (incidente 2026-08-18).
 */
export type CbtesAsocGate =
  | 'COMPROBANTE_READ_FAILED'
  | 'ROW_NOT_FOUND'
  | 'ROW_TYPE_MISMATCH'
  | 'ASOC_NOT_ALLOWED_ON_INVOICE'
  | 'ASOC_REQUIRED_FOR_NC'
  | 'ASOC_INCOMPLETE'
  | 'ASOC_CLASS_MISMATCH'
  | 'INVOICE_CBTE_TIPO_MISMATCH'
  | 'NC_CBTE_TIPO_MISMATCH'
  | 'NC_WITHOUT_ORIGINAL'
  | 'ORIGINAL_READ_FAILED'
  | 'ORIGINAL_NOT_FOUND'
  | 'ORIGINAL_WITHOUT_IDENTITY'
  | 'ORIGINAL_CLASS_MISMATCH'
  | 'ASOC_DOES_NOT_MATCH_ORIGINAL'

export interface CbtesAsocResult {
  ok: boolean
  identidad?: FiscalIdentity
  originalId?: string
  error?: string
  gate?: CbtesAsocGate
  /** Código sanitizado del motor (p. ej. '42501'); nunca material sensible. */
  detalle?: string
}

export function esNotaCreditoFiscal(tipoComprobante: number): boolean {
  return esCbteTipoNotaCredito(tipoComprobante)
}

function enteroPositivo(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Valida la forma del body antes de cualquier llamada a WSAA/WSFE.
 *
 * Una terna parcial nunca se ignora silenciosamente. Para NC 3/8/13 la terna
 * además es obligatoria y el tipo asociado debe corresponder a su clase.
 */
export function validarCbtesAsocBody(
  tipoComprobante: number,
  body: CbtesAsocBody,
): CbtesAsocResult {
  const values = [body.cbteAsocTipo, body.cbteAsocPtoVta, body.cbteAsocNro]
  const presentes = values.filter((value) => value !== null && value !== undefined).length
  const esNotaCredito = esNotaCreditoFiscal(tipoComprobante)

  // Este producto sólo modela CbtesAsoc para Notas de Crédito. Aceptar una
  // terna en una factura permitiría que un caller eligiera contenido fiscal
  // material que no tiene ninguna fuente canónica ni flujo legítimo.
  if (!esNotaCredito) {
    return presentes === 0
      ? { ok: true }
      : { ok: false, gate: 'ASOC_NOT_ALLOWED_ON_INVOICE', error: 'CbtesAsoc sólo está permitido para una Nota de Crédito' }
  }

  if (presentes === 0) {
    return { ok: false, gate: 'ASOC_REQUIRED_FOR_NC', error: 'La Nota de Crédito requiere CbtesAsoc completo (Tipo, PtoVta, Nro)' }
  }

  if (presentes !== 3 || !values.every(enteroPositivo)) {
    return { ok: false, gate: 'ASOC_INCOMPLETE', error: 'CbtesAsoc debe contener Tipo, PtoVta y Nro enteros positivos' }
  }

  const identidad = {
    cbteTipo: body.cbteAsocTipo as number,
    puntoVenta: body.cbteAsocPtoVta as number,
    numero: body.cbteAsocNro as number,
  }

  if (identidad.cbteTipo !== cbteTipoFacturaParaNotaCredito(tipoComprobante)) {
    return {
      ok: false,
      gate: 'ASOC_CLASS_MISMATCH',
      error: `CbtesAsoc.Tipo=${identidad.cbteTipo} no corresponde a Nota de Crédito CbteTipo=${tipoComprobante}`,
    }
  }

  return { ok: true, identidad }
}

/**
 * Resuelve CbtesAsoc desde las filas server-side. El body no puede elegir ni
 * corregir la identidad fiscal: para una NC debe coincidir exactamente con la
 * terna canónica del comprobante original o la emisión se bloquea.
 */
export async function resolverCbtesAsocCanonico(
  supabase: any,
  params: {
    comprobanteId: string
    businessId: string
    tipoComprobante: number
    body: CbtesAsocBody
  },
): Promise<CbtesAsocResult> {
  // La fila se lee SIEMPRE, aun para un CbteTipo que no parece NC. Así una
  // fila nota_credito corrupta no puede eludir el gate con attempt tipo 11/99.
  //
  // Va por RPC y no por `.from('comprobantes')`: service_role NO tiene grants
  // sobre esa tabla (lockdown deliberado de las tablas de negocio), así que la
  // lectura directa devolvía 42501 y abortaba la emisión antes de WSAA —
  // el incidente del 2026-08-18. La RPC expone sólo estas tres columnas,
  // acotadas por negocio. Ver 20260818210000_arca_comprobante_identity_snapshot.
  const { data: notaCredito, error: errorNc } = await supabase.rpc(
    'snapshot_arca_comprobante_identity',
    { p_comprobante_id: params.comprobanteId, p_business_id: params.businessId },
  )

  // Un fallo de LECTURA no es lo mismo que una fila ausente. Colapsarlos fue lo
  // que dejó este incidente sin diagnóstico: 42501 se leía como "no existe".
  if (errorNc) {
    return {
      ok: false,
      gate: 'COMPROBANTE_READ_FAILED',
      error: 'No se pudo leer el comprobante local del intento fiscal',
      detalle: String((errorNc as any)?.code ?? (errorNc as any)?.message ?? errorNc),
    }
  }
  if (!notaCredito) {
    return {
      ok: false,
      gate: 'ROW_NOT_FOUND',
      error: 'No se encontró el comprobante local del intento fiscal',
    }
  }

  const filaEsNotaCredito = notaCredito.tipo === 'nota_credito'
  const intentoEsNotaCredito = esNotaCreditoFiscal(params.tipoComprobante)
  if (filaEsNotaCredito !== intentoEsNotaCredito) {
    return { ok: false, gate: 'ROW_TYPE_MISMATCH', error: 'El tipo de la fila y el CbteTipo del intento no son fiscalmente equivalentes' }
  }

  const validacionBody = validarCbtesAsocBody(params.tipoComprobante, params.body)
  if (!validacionBody.ok) return validacionBody

  // Para facturas el attempt también debe coincidir exactamente con el tipo
  // canónico de la fila. Un claim corrupto (factura_c+1/99, factura_a+11) no
  // puede alcanzar WSAA por el camino temprano de "no NC".
  if (!filaEsNotaCredito) {
    const tipoFila = resolverCbteTipo(notaCredito)
    if (tipoFila === null || tipoFila !== params.tipoComprobante) {
      return { ok: false, gate: 'INVOICE_CBTE_TIPO_MISMATCH', error: `El CbteTipo del intento (${params.tipoComprobante}) no coincide con el tipo fiscal canónico del comprobante (${tipoFila ?? 'indeterminado'})` }
    }
    return validacionBody
  }

  const tipoNotaCreditoPersistido = resolverCbteTipo(notaCredito)
  if (tipoNotaCreditoPersistido !== params.tipoComprobante) {
    return { ok: false, gate: 'NC_CBTE_TIPO_MISMATCH', error: 'El CbteTipo del intento no coincide con el tipo fiscal persistido de la Nota de Crédito' }
  }

  if (!notaCredito.comprobante_original_id) {
    return { ok: false, gate: 'NC_WITHOUT_ORIGINAL', error: 'La Nota de Crédito no tiene un comprobante original válido' }
  }

  // Misma pared de permisos que arriba: también va por RPC acotada. Ésta sí
  // devuelve numero_fiscal, porque probar la terna del original lo exige.
  const { data: original, error: errorOriginal } = await supabase.rpc(
    'snapshot_arca_original_identity',
    {
      p_original_id: notaCredito.comprobante_original_id,
      p_business_id: params.businessId,
    },
  )

  if (errorOriginal) {
    return {
      ok: false,
      gate: 'ORIGINAL_READ_FAILED',
      error: 'No se pudo leer el comprobante fiscal original de la Nota de Crédito',
      detalle: String((errorOriginal as any)?.code ?? (errorOriginal as any)?.message ?? errorOriginal),
    }
  }
  if (!original) {
    return {
      ok: false,
      gate: 'ORIGINAL_NOT_FOUND',
      error: 'No se encontró el comprobante fiscal original de la Nota de Crédito',
    }
  }

  // Fuente única: el mismo helper canónico que usa comprobanteService. No se
  // reimplementa parseo ni resolución de CbteTipo en la Edge Function.
  const identidadOriginal = fiscalIdentity(original)
  if (!identidadOriginal) {
    return { ok: false, gate: 'ORIGINAL_WITHOUT_IDENTITY', error: 'El comprobante original no tiene identidad fiscal completa' }
  }

  const tipoOriginalEsperado = cbteTipoFacturaParaNotaCredito(params.tipoComprobante)
  if (identidadOriginal.cbteTipo !== tipoOriginalEsperado) {
    return {
      ok: false,
      gate: 'ORIGINAL_CLASS_MISMATCH',
      error: `La identidad del original no corresponde a Nota de Crédito CbteTipo=${params.tipoComprobante}`,
    }
  }

  const bodyIdentity = validacionBody.identidad!
  if (
    bodyIdentity.puntoVenta !== identidadOriginal.puntoVenta
    || bodyIdentity.cbteTipo !== identidadOriginal.cbteTipo
    || bodyIdentity.numero !== identidadOriginal.numero
  ) {
    return { ok: false, gate: 'ASOC_DOES_NOT_MATCH_ORIGINAL', error: 'CbtesAsoc no coincide con la identidad fiscal canónica del original' }
  }

  return {
    ok: true,
    identidad: identidadOriginal,
    originalId: notaCredito.comprobante_original_id,
  }
}
