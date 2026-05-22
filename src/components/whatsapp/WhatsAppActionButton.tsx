/**
 * WhatsAppActionButton — botón reutilizable que abre WhatsAppPreviewModal.
 *
 * Se puede colocar en cualquier módulo: cliente, orden, comprobante, garantía.
 * Muestra un estado claro cuando el contacto no tiene teléfono.
 */
import { useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { WhatsAppPreviewModal } from './WhatsAppPreviewModal'
import { WhatsAppVars } from '../../services/whatsappService'

export interface WhatsAppActionButtonProps {
  /** Display name (used in modal header and message interpolation) */
  recipientName: string
  /** Phone number (raw) — button disabled if null/empty */
  phone: string | null | undefined
  /** Template key to pre-select */
  templateKey?: string
  /** Extra variables for interpolation */
  vars?: WhatsAppVars
  /** Context entity IDs for logging */
  context?: {
    orderId?: string
    customerId?: string
    comprobantId?: string
    warrantyId?: string
  }
  /** Button label (default: "WhatsApp") */
  label?: string
  /** Explicit disabled reason (shown as tooltip) */
  disabledReason?: string
  /** Extra CSS class for the button */
  className?: string
  /** Extra inline style */
  style?: React.CSSProperties
  /** compact = icon only, full = icon + label */
  size?: 'compact' | 'full'
}

export function WhatsAppActionButton({
  recipientName, phone,
  templateKey = 'free_message',
  vars = {},
  context = {},
  label = 'WhatsApp',
  disabledReason,
  className,
  style,
  size = 'full',
}: WhatsAppActionButtonProps) {
  const [open, setOpen] = useState(false)

  const hasPhone = !!(phone?.trim())
  const disabled = !hasPhone || !!disabledReason
  const tooltip = disabledReason ?? (!hasPhone ? 'Este contacto no tiene teléfono registrado' : undefined)

  return (
    <>
      <button
        data-testid="whatsapp-action-button"
        onClick={() => !disabled && setOpen(true)}
        disabled={disabled}
        title={tooltip}
        className={className ?? 'btn btn-ghost btn-sm'}
        style={{
          color: disabled ? undefined : '#25d366',
          borderColor: disabled ? undefined : 'rgba(37,211,102,0.3)',
          background: disabled ? undefined : 'rgba(37,211,102,0.06)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: size === 'full' ? '0.375rem' : 0,
          ...style,
        }}
        aria-label={tooltip ?? `Enviar WhatsApp a ${recipientName}`}
      >
        <MessageCircle size={15} />
        {size === 'full' && label}
      </button>

      <WhatsAppPreviewModal
        isOpen={open}
        onClose={() => setOpen(false)}
        recipientName={recipientName}
        phone={phone}
        defaultTemplateKey={templateKey}
        vars={vars}
        context={context}
      />
    </>
  )
}
