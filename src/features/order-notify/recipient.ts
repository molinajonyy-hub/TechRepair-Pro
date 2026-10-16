/**
 * CLIENTES-UX-1B — a quién se avisa en una orden.
 *
 * La fila de `order_notification_recipients` (o su ausencia) decide:
 *  · sin fila, o `customer` → el cliente titular, con su teléfono ACTUAL: si el
 *    cliente corrige su número, la orden avisa al corregido;
 *  · `alternate` → la COPIA guardada al elegirlo. Si después la ficha cambia o
 *    borra el contacto, la orden sigue avisando a quien se eligió.
 *
 * Nada de esto cambia la titularidad: comprobantes, garantías y cuentas
 * corrientes siguen leyendo `orders.customer_id` y los datos del cliente.
 */

export type NotificationRecipientKind = 'customer' | 'alternate'

/** La fila tal como la lee el browser (RLS: tenant + `orders`). */
export interface OrderNotificationRecipientRow {
  recipient: NotificationRecipientKind
  contact_name: string | null
  contact_phone: string | null
}

export interface NotificationCustomer {
  name?: string | null
  phone?: string | null
  notification_contact_name?: string | null
  notification_contact_phone?: string | null
}

export interface ResolvedNotificationRecipient {
  kind: NotificationRecipientKind
  name: string
  phone: string
  /** Texto para la persona: «Cliente» o «Contacto alternativo». */
  roleLabel: string
}

export const RECIPIENT_ROLE_LABEL: Record<NotificationRecipientKind, string> = {
  customer: 'Cliente',
  alternate: 'Contacto alternativo',
}

const clean = (value: string | null | undefined) => (value ?? '').trim()

export function resolveNotificationRecipient(
  customer: NotificationCustomer | null | undefined,
  row: OrderNotificationRecipientRow | null | undefined
): ResolvedNotificationRecipient {
  if (row?.recipient === 'alternate' && clean(row.contact_phone)) {
    return {
      kind: 'alternate',
      name: clean(row.contact_name),
      phone: clean(row.contact_phone),
      roleLabel: RECIPIENT_ROLE_LABEL.alternate,
    }
  }
  return {
    kind: 'customer',
    name: clean(customer?.name),
    phone: clean(customer?.phone),
    roleLabel: RECIPIENT_ROLE_LABEL.customer,
  }
}

/** El contacto alternativo que tiene HOY la ficha del cliente, si lo tiene. */
export function customerAlternateContact(
  customer: NotificationCustomer | null | undefined
): { name: string; phone: string } | null {
  const name = clean(customer?.notification_contact_name)
  const phone = clean(customer?.notification_contact_phone)
  return name && phone ? { name, phone } : null
}

/**
 * La orden avisa a una copia que ya no coincide con la ficha: se ofrece
 * actualizarla, nunca se actualiza sola.
 */
export function alternateDiffersFromCustomer(
  resolved: ResolvedNotificationRecipient,
  customer: NotificationCustomer | null | undefined
): boolean {
  if (resolved.kind !== 'alternate') return false
  const current = customerAlternateContact(customer)
  return Boolean(current) && (current!.name !== resolved.name || current!.phone !== resolved.phone)
}

/** Primer nombre, para el saludo de las plantillas (`{nombre}`). */
export const firstNameOf = (name: string) => name.trim().split(/\s+/)[0] ?? ''
