import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  resolveNotificationRecipient,
  type NotificationCustomer,
  type NotificationRecipientKind,
  type OrderNotificationRecipientRow,
  type ResolvedNotificationRecipient,
} from './recipient'
import { loadOrderNotificationRecipient, setOrderNotificationRecipient } from './service'

export interface UseOrderNotificationRecipientReturn {
  recipient: ResolvedNotificationRecipient
  row: OrderNotificationRecipientRow | null
  /** `false` hasta leer, y si la base no tiene la tabla. */
  available: boolean
  saving: boolean
  error: string
  change: (kind: NotificationRecipientKind) => Promise<boolean>
}

/**
 * CLIENTES-UX-1B — estado del destinatario de avisos en el detalle de la orden.
 * Mientras carga (o sin la migración) el destinatario es el titular: el mismo
 * comportamiento que antes de este lote.
 */
export function useOrderNotificationRecipient(
  orderId: string | undefined,
  customer: NotificationCustomer | null | undefined
): UseOrderNotificationRecipientReturn {
  const [row, setRow] = useState<OrderNotificationRecipientRow | null>(null)
  const [available, setAvailable] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!orderId) return
    let alive = true
    void loadOrderNotificationRecipient(orderId).then(result => {
      if (!alive) return
      setRow(result.row)
      setAvailable(result.available)
    })
    return () => { alive = false }
  }, [orderId])

  const change = useCallback(async (kind: NotificationRecipientKind) => {
    if (!orderId) return false
    setSaving(true)
    setError('')
    try {
      setRow(await setOrderNotificationRecipient(orderId, kind))
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo guardar a quién se avisa.')
      return false
    } finally {
      setSaving(false)
    }
  }, [orderId])

  const recipient = useMemo(() => resolveNotificationRecipient(customer, row), [customer, row])

  return { recipient, row, available, saving, error, change }
}
