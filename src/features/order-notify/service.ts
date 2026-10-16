import { supabase } from '../../lib/supabase'
import { logger } from '../../lib/logger'
import type { NotificationRecipientKind, OrderNotificationRecipientRow } from './recipient'

export interface RecipientLoadResult {
  row: OrderNotificationRecipientRow | null
  /** `false` si la base todavía no tiene la tabla: se avisa al titular y no se ofrece cambiar. */
  available: boolean
}

const isMissingObject = (error: { code?: string; message?: string } | null | undefined) =>
  Boolean(error && (error.code === 'PGRST205' || error.code === 'PGRST202' || error.code === '42P01' || error.code === '42883'
    || /could not find|does not exist|schema cache/i.test(error.message ?? '')))

/**
 * CLIENTES-UX-1B — lee a quién se avisa en la orden.
 *
 * Nunca rompe el detalle de la orden: si la tabla no existe (frontend nuevo
 * contra una base sin migrar) o la lectura falla, se avisa al titular, que es
 * exactamente el comportamiento anterior.
 */
export async function loadOrderNotificationRecipient(orderId: string): Promise<RecipientLoadResult> {
  try {
    const { data, error } = await supabase
      .from('order_notification_recipients' as never)
      .select('recipient, contact_name, contact_phone')
      .eq('order_id', orderId)
      .maybeSingle()
    if (error) {
      if (!isMissingObject(error)) logger.warn('WHATSAPP', 'No se pudo leer el destinatario de avisos', error.message)
      return { row: null, available: !isMissingObject(error) }
    }
    return { row: (data as OrderNotificationRecipientRow | null) ?? null, available: true }
  } catch (cause) {
    logger.warn('WHATSAPP', 'No se pudo leer el destinatario de avisos', cause)
    return { row: null, available: false }
  }
}

const RPC_MESSAGES: Record<string, string> = {
  ALTERNATE_CONTACT_MISSING: 'El cliente no tiene un contacto para avisos cargado. Agregalo en su ficha.',
  FORBIDDEN_NOTIFICATION_RECIPIENT: 'No tenés permiso para cambiar a quién se avisa en esta orden.',
  ORDER_NOT_FOUND: 'No encontramos la orden en tu negocio.',
  INVALID_NOTIFICATION_RECIPIENT: 'Elegí al cliente o a su contacto para avisos.',
}

export function notificationRecipientErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  const message = error?.message ?? ''
  for (const [key, text] of Object.entries(RPC_MESSAGES)) if (message.includes(key)) return text
  if (isMissingObject(error)) return 'Todavía no se puede elegir a quién avisar: falta actualizar la base de datos.'
  return 'No se pudo guardar a quién se avisa. Intentá de nuevo.'
}

/** Única escritura: la RPC copia el contacto del cliente cuando es `alternate`. */
export async function setOrderNotificationRecipient(
  orderId: string,
  recipient: NotificationRecipientKind
): Promise<OrderNotificationRecipientRow> {
  const { data, error } = await supabase.rpc('set_order_notification_recipient' as never, {
    p_order_id: orderId,
    p_recipient: recipient,
  } as never)
  if (error) throw new Error(notificationRecipientErrorMessage(error))
  const result = (data ?? {}) as { recipient?: NotificationRecipientKind; contact_name?: string | null; contact_phone?: string | null }
  return {
    recipient: result.recipient ?? recipient,
    contact_name: result.contact_name ?? null,
    contact_phone: result.contact_phone ?? null,
  }
}

/**
 * Contacto para avisos del cliente elegido en la recepción. `select('*')` a
 * propósito: no nombra columnas que una base sin migrar no tenga.
 */
export async function loadCustomerNoticeContact(
  customerId: string,
  businessId: string
): Promise<{ name: string; phone: string } | null> {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('id', customerId)
      .eq('business_id', businessId)
      .maybeSingle()
    if (error || !data) return null
    const row = data as { notification_contact_name?: string | null; notification_contact_phone?: string | null }
    const name = (row.notification_contact_name ?? '').trim()
    const phone = (row.notification_contact_phone ?? '').trim()
    return name && phone ? { name, phone } : null
  } catch {
    // Sin contacto alternativo: la recepción sigue con el teléfono principal.
    return null
  }
}
