/**
 * Ayuda.tsx — BETA-1 · Entrada de ayuda del producto.
 *
 * Una sola superficie, a propósito chica: un canal atendido y nada más. No es
 * un centro de soporte ni un inbox (eso es un lote posterior). El canal sale de
 * `config/contacto.ts`; acá no hay teléfonos ni URLs.
 *
 * Se llega desde el sidebar, desde «Más» en mobile y desde la pantalla de fin
 * de prueba; por eso `SubscriptionGuard` la deja pasar con el negocio bloqueado.
 */
import { LifeBuoy } from 'lucide-react'
import { SupportContactButton } from '../components/ui/SupportContactButton'

export function Ayuda() {
  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }} data-testid="ayuda-page">
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon">
            <LifeBuoy size={20} style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
          </div>
          <div>
            <h1 className="page-hdr-title">Ayuda de TechRepair Pro</h1>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.6 }}>
            Si algo te impide continuar durante la beta, escribinos y te ayudamos.
          </p>

          <SupportContactButton style={{ width: '100%', padding: '0.875rem', fontSize: '1rem' }} />
        </div>
      </div>
    </div>
  )
}
