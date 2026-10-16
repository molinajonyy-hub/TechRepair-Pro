import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BellRing } from 'lucide-react'
import {
  RECIPIENT_ROLE_LABEL,
  alternateDiffersFromCustomer,
  customerAlternateContact,
  type NotificationCustomer,
  type NotificationRecipientKind,
  type UseOrderNotificationRecipientReturn,
} from '../../features/order-notify'

export interface NotificationRecipientPanelProps {
  customerId?: string | null
  customer: NotificationCustomer | null | undefined
  state: UseOrderNotificationRecipientReturn
  /** `orders_create` u `orders_change_status`: la misma autoridad que exige la RPC. */
  canChange: boolean
}

const KINDS: NotificationRecipientKind[] = ['customer', 'alternate']

/**
 * CLIENTES-UX-1B — «Avisos por WhatsApp» en la tarjeta Cliente de la orden.
 *
 * Muestra a quién se avisa (nombre, número y si es el cliente o el contacto
 * alternativo) y permite cambiarlo. No envía nada: los mensajes siguen
 * saliendo sólo desde el preview de WhatsApp.
 */
export function NotificationRecipientPanel({ customerId, customer, state, canChange }: NotificationRecipientPanelProps) {
  const { recipient, available, saving, error, change } = state
  const [notice, setNotice] = useState('')
  const alternate = customerAlternateContact(customer)
  const stale = alternateDiffersFromCustomer(recipient, customer)
  const canChoose = canChange && available && (Boolean(alternate) || recipient.kind === 'alternate')

  const choose = async (kind: NotificationRecipientKind) => {
    setNotice('')
    if (await change(kind)) {
      const target = kind === 'alternate' ? alternate?.name : customer?.name
      setNotice(`Los avisos de esta orden van a ${target ?? RECIPIENT_ROLE_LABEL[kind].toLowerCase()}.`)
    }
  }

  return (
    <section className="order-notify" aria-labelledby="order-notify-title" data-testid="order-notify-panel">
      <h4 id="order-notify-title" className="order-notify__title">
        <BellRing size={14} aria-hidden="true" /> Avisos por WhatsApp
      </h4>
      {/* Al titular no se le repite el nombre: está arriba, en la misma tarjeta. */}
      <p className="order-notify__recipient" data-testid="order-notify-recipient" data-kind={recipient.kind}>
        <span className="order-notify__role">{recipient.roleLabel}</span>
        {recipient.kind === 'alternate' && <span className="order-notify__name">{recipient.name || 'Sin nombre'}</span>}
        <span className="order-notify__phone">{recipient.phone || 'Sin teléfono'}</span>
      </p>

      {canChoose && (
        <div className="seg-field order-notify__choice" role="group" aria-label="A quién se avisa en esta orden">
          {KINDS.map(kind => (
            <button
              key={kind}
              type="button"
              className="seg-field-option"
              aria-pressed={recipient.kind === kind}
              disabled={saving || (kind === 'alternate' && !alternate && recipient.kind !== 'alternate')}
              data-testid={`order-notify-choose-${kind}`}
              onClick={() => { if (recipient.kind !== kind) void choose(kind) }}
            >
              {RECIPIENT_ROLE_LABEL[kind]}
            </button>
          ))}
        </div>
      )}

      {canChoose && stale && alternate && (
        <p className="order-notify__hint" data-testid="order-notify-stale">
          La ficha del cliente tiene otro contacto para avisos: {alternate.name} · {alternate.phone}.{' '}
          <button type="button" className="order-notify__link" disabled={saving} onClick={() => void choose('alternate')}>
            Usar el de la ficha
          </button>
        </p>
      )}

      {available && canChange && !alternate && recipient.kind === 'customer' && customerId && (
        <p className="order-notify__hint">
          Para avisar a otra persona, cargá un contacto para avisos en la{' '}
          <Link to={`/customers/${customerId}`}>ficha del cliente</Link>.
        </p>
      )}

      <div role="status" aria-live="polite" className="order-notify__status">{notice}</div>
      {error && <p className="form-error" role="alert" data-testid="order-notify-error">{error}</p>}
    </section>
  )
}
