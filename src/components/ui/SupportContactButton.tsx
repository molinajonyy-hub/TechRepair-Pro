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
 *
 * BETA-UX-1A — sin canal configurado no hay enlace (y no hay correo de
 * respaldo): el botón muestra el aviso de `canalSoporte()` y deja registro.
 */
import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { MessageCircle } from 'lucide-react'
import { canalSoporte, type CanalSoporteWhatsApp } from '../../config/contacto'
import { logger } from '../../lib/logger'

interface SupportContactButtonProps {
  style?: CSSProperties
}

export function SupportContactButton({ style }: SupportContactButtonProps) {
  const canal = canalSoporte()
  const disponible = canal.tipo === 'whatsapp'

  useEffect(() => {
    if (!disponible) {
      logger.warn('GENERAL', 'Canal de soporte no disponible: falta el WhatsApp de soporte o no es un celular argentino válido (ver config/contacto.ts)')
    }
  }, [disponible])

  if (canal.tipo !== 'whatsapp') {
    return (
      <p
        role="status"
        style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem', lineHeight: 1.6, textAlign: 'center' }}
        data-testid="support-contact-unavailable"
        data-support-channel="no_disponible"
      >
        {canal.etiqueta}
      </p>
    )
  }

  return (
    <a
      href={canal.url}
      // WhatsApp abre aparte para no sacar al usuario de la app.
      target="_blank"
      rel="noopener noreferrer"
      className="btn btn-primary btn-lift"
      style={{ minHeight: 44, justifyContent: 'center', ...style }}
      data-testid="support-contact-cta"
      data-support-channel="whatsapp"
    >
      <MessageCircle size={18} aria-hidden="true" />
      {canal.etiqueta}
    </a>
  )
}

interface SupportContactLinkProps {
  /** Canal ya resuelto: quien lo usa decide si la frase que lo rodea se muestra. */
  canal: CanalSoporteWhatsApp
  children: ReactNode
  style?: CSSProperties
  testId?: string
}

/**
 * Enlace al canal de ayuda para usar DENTRO de una frase («…escribinos por
 * WhatsApp»). Lo usan las pantallas previas al negocio, que no tienen acceso a
 * `/ayuda` (vive dentro de `MainLayout`). Recibe el canal ya resuelto: si no
 * hay WhatsApp, la pantalla no muestra la frase.
 */
export function SupportContactLink({ canal, children, style, testId }: SupportContactLinkProps) {
  return (
    <a
      href={canal.url}
      target="_blank"
      rel="noopener noreferrer"
      style={style}
      data-testid={testId}
      data-support-channel="whatsapp"
    >
      {children}
    </a>
  )
}
