import { Clock, CheckCircle, LogOut } from 'lucide-react'
import { usePortal } from '../contexts/PortalContext'
import { logoutCustomer } from '../services/portalService'
import { PortalLayout, PortalCard, PortalButton, PT } from '../components/PortalLayout'

export function PortalPending() {
  const { business, customer, setCustomer } = usePortal()

  const handleLogout = async () => {
    await logoutCustomer()
    setCustomer(null)
  }

  const whatsapp = business?.wholesale_whatsapp

  return (
    <PortalLayout showCart={false} showBack={false}>
      <div style={{ padding: '3rem 1rem 2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '1rem' }}>
        <div style={{ width: 72, height: 72, borderRadius: '50%', background: `${PT.warning}20`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Clock size={36} style={{ color: PT.warning }} />
        </div>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: '0 0 0.375rem', letterSpacing: '-0.02em' }}>
            Solicitud en revisión
          </h1>
          <p style={{ color: PT.textSub, margin: 0, fontSize: '0.95rem', maxWidth: 320 }}>
            Tu cuenta está pendiente de aprobación. Te avisaremos cuando esté lista.
          </p>
        </div>
      </div>

      <div style={{ padding: '0 1rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        <PortalCard style={{ padding: '1.25rem' }}>
          <p style={{ margin: '0 0 1rem', fontWeight: 600, fontSize: '0.95rem' }}>
            ¿Qué pasa ahora?
          </p>
          {[
            { icon: '✅', text: 'Recibimos tu solicitud' },
            { icon: '👀', text: 'Revisamos tu información' },
            { icon: '📲', text: 'Te contactamos por WhatsApp cuando esté aprobada' },
          ].map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '1.25rem' }}>{s.icon}</span>
              <span style={{ color: PT.text, fontSize: '0.9rem' }}>{s.text}</span>
            </div>
          ))}
        </PortalCard>

        {customer && (
          <PortalCard style={{ padding: '1.25rem' }}>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.78rem', fontWeight: 700, color: PT.textSub, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Tu solicitud
            </p>
            <p style={{ margin: '0 0 0.25rem', fontWeight: 600 }}>{customer.name}</p>
            {customer.business_name && <p style={{ margin: '0 0 0.25rem', color: PT.textSub, fontSize: '0.9rem' }}>{customer.business_name}</p>}
            <p style={{ margin: 0, color: PT.textSub, fontSize: '0.85rem' }}>{customer.email}</p>
          </PortalCard>
        )}

        {whatsapp && (
          <a
            href={`https://wa.me/${whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent('Hola! Me registré en el portal mayorista y quiero consultar el estado de mi solicitud.')}`}
            target="_blank" rel="noopener noreferrer"
            style={{ textDecoration: 'none' }}
          >
            <PortalButton variant="secondary">
              <CheckCircle size={18} /> Consultar por WhatsApp
            </PortalButton>
          </a>
        )}

        <PortalButton variant="ghost" onClick={handleLogout}>
          <LogOut size={16} /> Cerrar sesión
        </PortalButton>
      </div>
    </PortalLayout>
  )
}
