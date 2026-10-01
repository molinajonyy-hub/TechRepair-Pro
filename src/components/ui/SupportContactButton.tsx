/**
 * SupportContactButton — BETA-1 · CTA hacia el canal de ayuda.
 *
 * El destino sale de `canalSoporte()` en `config/contacto.ts`: acá no hay
 * teléfonos ni URLs. Es para pedir AYUDA; elegir o activar un plan es
 * autoservicio (Planes → Mercado Pago) y no pasa por este botón.
 *
 * Es un enlace real (`<a>`), no un botón con `window.open`: funciona con
 * teclado, con «abrir en otra pestaña» y en móvil el sistema entrega `wa.me`
 * a la app de WhatsApp.
 */
import type { CSSProperties } from 'react'
import { MessageCircle, Mail } from 'lucide-react'
import { canalSoporte } from '../../config/contacto'

interface SupportContactButtonProps {
  style?: CSSProperties
}

export function SupportContactButton({ style }: SupportContactButtonProps) {
  const canal = canalSoporte()
  const Icon = canal.tipo === 'whatsapp' ? MessageCircle : Mail

  return (
    <a
      href={canal.url}
      // WhatsApp abre aparte para no sacar al usuario de la app; `mailto:` no
      // necesita pestaña nueva (dejaría una en blanco).
      target={canal.tipo === 'whatsapp' ? '_blank' : undefined}
      rel={canal.tipo === 'whatsapp' ? 'noopener noreferrer' : undefined}
      className="btn btn-primary btn-lift"
      style={{ minHeight: 44, justifyContent: 'center', ...style }}
      data-testid="support-contact-cta"
      data-support-channel={canal.tipo}
    >
      <Icon size={18} aria-hidden="true" />
      {canal.etiqueta}
    </a>
  )
}
