// ============================================================================
// GATES PRE-ENVÍO de afip-cae.
//
// Todo lo que decide si una solicitud puede siquiera llegar a WSAA vive acá,
// separado de `index.ts`, por una razón concreta: el handler vive dentro de
// `serve()` y no se puede importar sin arrancar un servidor, así que el 400 del
// 2026-08-18 no se pudo reproducir offline contra el código real — sólo contra
// helpers sueltos. Esta extracción NO cambia el comportamiento: es el mismo
// orden de gates, los mismos textos y los mismos códigos de estado.
//
// Un rechazo acá nunca consume numeración ni deja el intento marcado `sent`.
// ============================================================================
import {
  esNotaCreditoFiscal,
  resolverCbtesAsocCanonico,
  type CbtesAsocBody,
  type CbtesAsocResult,
} from './cbtesAsoc.ts'

export interface AttemptRow {
  id: string
  comprobante_id: string
  business_id: string
  ambiente: string
  cuit_emisor: string
  punto_venta: number
  tipo_comprobante: number
  numero_intentado: number | null
  status: string
}

/** Estados en los que un intento todavía puede avanzar hacia ARCA. */
export const ESTADOS_ACTIVOS = ['claimed', 'number_reserved', 'sent'] as const

export type PreSendGate =
  | 'MISSING_IDS'
  | 'FORBIDDEN_ATTEMPT'
  | 'ATTEMPT_READ_FAILED'
  | 'ATTEMPT_MISMATCH'
  | 'ATTEMPT_NOT_ACTIVE'
  | 'CBTES_ASOC_INVALID'
  | 'COMPROBANTE_READ_FAILED'
  | 'NC_IDENTITY_UNPROVEN'

export interface PreSendReject {
  ok: false
  status: number
  gate: PreSendGate
  /** Gate fino del resolutor de CbtesAsoc, cuando corresponde. */
  detalle?: string
  error: string
}

export interface PreSendOk {
  ok: true
  attempt: AttemptRow
  cbtesAsoc: CbtesAsocResult
  /** true si el intento es una NC y por lo tanto exige snapshot de CbtesAsoc. */
  requiereSnapshotNc: boolean
}

/**
 * Lee el intento reclamado.
 *
 * Devuelve el error de PostgREST en vez de tragarlo. Antes hacía
 * `const { data } = await ...` y descartaba `error`: CUALQUIER fallo de lectura
 * (permisos, timeout, PGRST*) se volvía `null` y el caller respondía
 * "attempt_id inválido o no corresponde a comprobante_id" — un texto que
 * describe un problema del cliente cuando en realidad el servidor no pudo leer.
 */
export async function fetchAttempt(
  supabase: any,
  attemptId: string,
  authorizedBusinessId?: string,
): Promise<{ row: AttemptRow | null; error: string | null }> {
  let query = supabase
    .from('arca_emission_attempts')
    .select('id, comprobante_id, business_id, ambiente, cuit_emisor, punto_venta, tipo_comprobante, numero_intentado, status')
    .eq('id', attemptId)
  if (authorizedBusinessId) query = query.eq('business_id', authorizedBusinessId)
  const { data, error } = await query.maybeSingle()
  return {
    row: (data as AttemptRow) ?? null,
    error: error ? String((error as any)?.message ?? error) : null,
  }
}

/**
 * Corre, en orden, los gates que preceden a cualquier llamada externa.
 *
 * La identidad fiscal (ambiente/CUIT/PV/CbteTipo) sale SIEMPRE del intento
 * reclamado, nunca del body: un cliente no puede spoofearla aunque la incluya.
 */
export async function evaluarPreEnvio(
  supabase: any,
  params: {
    authorizedBusinessId?: string
    comprobanteId?: string
    attemptId?: string
    body: CbtesAsocBody
  },
): Promise<PreSendOk | PreSendReject> {
  const { comprobanteId, attemptId } = params

  if (!comprobanteId || !attemptId) {
    return {
      ok: false, status: 400, gate: 'MISSING_IDS',
      error: 'Faltan comprobante_id / attempt_id: debe reclamarse el intento antes de invocar afip-cae',
    }
  }

  const { row: attempt, error: attemptError } = await fetchAttempt(supabase, attemptId, params.authorizedBusinessId)

  if (!attemptError && params.authorizedBusinessId
    && (!attempt || attempt.business_id !== params.authorizedBusinessId)) {
    return { ok: false, status: 403, gate: 'FORBIDDEN_ATTEMPT', error: 'FORBIDDEN' }
  }

  // Un fallo de LECTURA no es un error del cliente: se separa del mismatch para
  // no volver a confundir "no pude leer" con "me mandaste mal los ids".
  if (attemptError) {
    return {
      ok: false, status: 503, gate: 'ATTEMPT_READ_FAILED',
      detalle: attemptError,
      error: 'No se pudo leer el intento fiscal en la base',
    }
  }
  if (!attempt || attempt.comprobante_id !== comprobanteId) {
    return {
      ok: false, status: 400, gate: 'ATTEMPT_MISMATCH',
      error: 'attempt_id inválido o no corresponde a comprobante_id',
    }
  }
  if (!(ESTADOS_ACTIVOS as readonly string[]).includes(attempt.status)) {
    return {
      ok: false, status: 409, gate: 'ATTEMPT_NOT_ACTIVE',
      error: `El intento ya no está activo (status=${attempt.status})`,
    }
  }

  const cbtesAsoc = await resolverCbtesAsocCanonico(supabase, {
    comprobanteId,
    businessId: attempt.business_id,
    tipoComprobante: attempt.tipo_comprobante,
    body: params.body,
  })
  if (!cbtesAsoc.ok) {
    // Un fallo de LECTURA es del servidor (5xx), no del cliente. Mezclarlo con
    // los rechazos de contrato fue lo que ocultó el incidente del 2026-08-18:
    // un 42501 se reportaba como 400, indistinguible de un payload inválido.
    const fallaDeLectura = cbtesAsoc.gate === 'COMPROBANTE_READ_FAILED'
      || cbtesAsoc.gate === 'ORIGINAL_READ_FAILED'
    return {
      ok: false,
      status: fallaDeLectura ? 503 : 400,
      gate: fallaDeLectura ? 'COMPROBANTE_READ_FAILED' : 'CBTES_ASOC_INVALID',
      detalle: cbtesAsoc.detalle ? `${cbtesAsoc.gate}:${cbtesAsoc.detalle}` : cbtesAsoc.gate,
      error: cbtesAsoc.error || 'CbtesAsoc inválido',
    }
  }

  const requiereSnapshotNc = esNotaCreditoFiscal(attempt.tipo_comprobante)
  if (requiereSnapshotNc && (!cbtesAsoc.identidad || !cbtesAsoc.originalId)) {
    return {
      ok: false, status: 400, gate: 'NC_IDENTITY_UNPROVEN',
      error: 'No se pudo demostrar la identidad completa de CbtesAsoc',
    }
  }

  return { ok: true, attempt, cbtesAsoc, requiereSnapshotNc }
}
