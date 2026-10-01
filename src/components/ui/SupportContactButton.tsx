/**
 * SupportContactButton — BETA-1 · CTA único hacia el canal de ayuda.
 *
 * Toda superficie que ofrece «hablar con soporte» (Ayuda, fin de la prueba,
 * Planes, Suscripción) usa este componente. El destino sale de
 * `canalSoporte()` en `config/contacto.ts`: acá no hay teléfonos ni URLs.
 *
 * Es un enlace real (`<a>`), no un botón con `window.open`: funciona con
 * teclado, con «abrir en otra pestaña» y en móvil el sistema entrega `wa.me`
 * a la app de WhatsApp.
 */
import type { CSSProperties, ReactNode } from 'react'
import { MessageCircle, Mail } from 'lucide-react'
import { canalSoporte } from '../../config/contacto'

interface SupportContactButtonProps {
  /** Texto del CTA. Por defecto, el del canal («Hablar por WhatsApp»). */
  label?: ReactNode
  /** Mensaje precargado en WhatsApp. Sin datos del usuario ni del negocio. */
  mensaje?: string
  /** Clases del sistema de botones. Por defecto, el primario. */
  className?: string
  style?: CSSProperties
  'data-testid'?: string
}

export function SupportContactButton({
  label,
  mensaje,
  className = 'btn btn-primary btn-lift',
  style,
  'data-testid': testId = 'support-contact-cta',
}: SupportContactButtonProps) {
  const canal = canalSoporte(mensaje)
  const Icon = canal.tipo === 'whatsapp' ? MessageCircle : Mail

  return (
    <a
      href={canal.url}
      // WhatsApp abre aparte para no sacar al usuario de la app; `mailto:` no
      // necesita pestaña nueva (dejaría una en blanco).
      target={canal.tipo === 'whatsapp' ? '_blank' : undefined}
      rel={canal.tipo === 'whatsapp' ? 'noopener noreferrer' : undefined}
      className={className}
      style={{ minHeight: 44, justifyContent: 'center', ...style }}
      data-testid={testId}
      data-support-channel={canal.tipo}
    >
      <Icon size={18} aria-hidden="true" />
      {label ?? canal.etiqueta}
    </a>
  )
}
