/**
 * useCheckoutIdempotency — hook único para TODOS los entry points que crean
 * comprobantes vía comprobanteService.crear() (auditoría entry points,
 * 2026-07-01). Centraliza lo que antes se repetía manualmente en
 * ComprobanteProModal: generación/recuperación de la idempotency key,
 * persistencia en sessionStorage, cálculo del client_request_hash, y
 * recuperación de un checkout pendiente tras timeout/refresh.
 *
 * Ningún modal nuevo debe reimplementar esta lógica — importar este hook.
 */
import { useCallback } from 'react'
import {
  computeCheckoutRequestHash, getOrCreateIdempotencyKey, clearPendingCheckout, readPendingCheckout,
  type CheckoutHashInput,
} from '../lib/checkoutIdempotency'
import { comprobanteService } from '../services/comprobanteService'

export interface RecoveredCheckout {
  comprobanteId?: string
  checkoutStatus?: string
  estadoFiscal?: string
  cae?: string
}

export function useCheckoutIdempotency(businessId: string | null | undefined) {
  /** Calcula el hash del carrito y devuelve la key a usar (nueva o reutilizada). */
  const resolveIdempotencyKey = useCallback(async (hashInput: CheckoutHashInput): Promise<string> => {
    if (!businessId) throw new Error('businessId requerido para resolver la idempotency key')
    const requestHash = await computeCheckoutRequestHash(hashInput)
    const { idempotencyKey } = getOrCreateIdempotencyKey(businessId, requestHash)
    return idempotencyKey
  }, [businessId])

  /** Descarta el checkout pendiente — llamar SOLO tras completed/idempotency_conflict/cancelación explícita del usuario. */
  const clearPending = useCallback((): void => {
    if (businessId) clearPendingCheckout(businessId)
  }, [businessId])

  /**
   * Si hay un checkout pendiente en sessionStorage para este negocio, consulta
   * su estado real server-side. Devuelve el comprobante recuperado si ya
   * estaba `completed` — nunca debe usarse para disparar una creación nueva.
   */
  const recoverPending = useCallback(async (): Promise<RecoveredCheckout | null> => {
    if (!businessId) return null
    const pending = readPendingCheckout(businessId)
    if (!pending) return null

    const status = await comprobanteService.getCheckoutStatus(businessId, pending.idempotencyKey)
    if (!status.found || status.checkoutStatus === 'failed_final') {
      clearPendingCheckout(businessId)
      return null
    }
    if (status.checkoutStatus === 'completed' && status.comprobanteId) {
      clearPendingCheckout(businessId)
      return {
        comprobanteId: status.comprobanteId,
        checkoutStatus: status.checkoutStatus,
        estadoFiscal: status.estadoFiscal,
        cae: status.cae,
      }
    }
    // 'processing' / 'failed_retryable': se conserva el pendiente tal cual —
    // el próximo submit manual reutiliza la MISMA key.
    return null
  }, [businessId])

  return { resolveIdempotencyKey, clearPending, recoverPending }
}
