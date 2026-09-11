/**
 * P0-ARCA-B — ciclo de vida del claim de emisión ANTES del envío a ARCA.
 *
 * Orden del flujo: claim → WSAA → último autorizado → reserva de número →
 * marca de envío → FECAESolicitar. Mientras el intento siga 'claimed' sin
 * numero_intentado ni sent_at, NADA salió hacia ARCA.
 *
 * - releasePreSendClaim: si la emisión falla en ese tramo, libera el claim para
 *   que no ocupe la serie fiscal para siempre (incidente 2026-09-01). La RPC sólo
 *   actúa sobre ese estado exacto: nunca libera number_reserved, sent ni
 *   pending_reconciliation.
 * - confirmReservation: nunca se envía sin una reserva confirmada. Si la reserva
 *   no se confirma (claim recuperado por otro comprobante, error de red), esta
 *   invocación se detiene sin tocar ARCA.
 *
 * Módulo sin dependencias de Deno para poder testearlo con node --test.
 */
type Log = (fields: Record<string, unknown>) => void

export type ReservationState = 'reserved' | 'not_reserved' | 'unknown'

/** Libera un claim pre-envío. Nunca lanza; devuelve true sólo si liberó. */
export async function releasePreSendClaim(
  supabase: any,
  attemptId: string,
  reason: string,
  log: Log,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('release_arca_presend_claim', {
      p_attempt_id: attemptId,
      p_reason: reason,
    })
    if (error || data?.success !== true) {
      log({ stage: 'persistencia', classification: 'release_claim_failed', error: error?.message ?? data?.error ?? null })
      return false
    }
    const released = data.released === true
    log({ stage: 'persistencia', classification: released ? 'claim_released' : 'claim_not_releasable', reason })
    return released
  } catch (e) {
    log({ stage: 'persistencia', classification: 'release_claim_failed', error: String((e as any)?.message ?? e) })
    return false
  }
}

/**
 * Reserva claimed → number_reserved y la CONFIRMA. Si la RPC no confirma, lee la
 * fila: la reserva pudo haberse aplicado aunque la respuesta se perdiera.
 *   reserved      → reservado por esta invocación con este número: se puede enviar.
 *   not_reserved  → la fila no quedó reservada con este número: NO enviar.
 *   unknown       → no se pudo saber: NO enviar.
 */
export async function confirmReservation(
  supabase: any,
  attemptId: string,
  numero: number,
  log: Log,
): Promise<ReservationState> {
  let reserveError: string
  try {
    const { data, error } = await supabase.rpc('reserve_arca_number', { p_attempt_id: attemptId, p_numero: numero })
    if (!error && data?.success === true) return 'reserved'
    reserveError = String(error?.message ?? data?.error ?? 'reserve_not_confirmed')
  } catch (e) {
    reserveError = String((e as any)?.message ?? e)
  }
  log({ stage: 'persistencia', classification: 'reserve_number_failed', error: reserveError })

  try {
    const { data, error } = await supabase
      .from('arca_emission_attempts')
      .select('status, numero_intentado')
      .eq('id', attemptId)
      .maybeSingle()
    if (error || !data) return 'unknown'
    if (data.status === 'number_reserved' && data.numero_intentado === numero) return 'reserved'
    return 'not_reserved'
  } catch {
    return 'unknown'
  }
}
