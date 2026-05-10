import { ShieldOff, LogOut } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { usePortal } from '../contexts/PortalContext'
import { logoutCustomer } from '../services/portalService'
import { PortalLayout, PortalButton, PT } from '../components/PortalLayout'

export function PortalSuspendido() {
  const { business, setCustomer, basePath } = usePortal()
  const navigate = useNavigate()

  const handleLogout = async () => {
    await logoutCustomer()
    setCustomer(null)
    navigate(`${basePath}/login`, { replace: true })
  }

  const whatsapp = business?.wholesale_whatsapp

  return (
    <PortalLayout showCart={false} showBack={false}>
      <div style={{ padding: '3rem 1rem 2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '1rem' }}>
        <div style={{ width: 72, height: 72, borderRadius: '50%', background: `${PT.danger}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ShieldOff size={36} style={{ color: PT.danger }} />
        </div>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: '0 0 0.375rem', letterSpacing: '-0.02em' }}>
            Cuenta suspendida
          </h1>
          <p style={{ color: PT.textSub, margin: 0, fontSize: '0.95rem', maxWidth: 300 }}>
            Tu cuenta fue suspendida temporalmente. Contactá al negocio para más información.
          </p>
        </div>
      </div>

      <div style={{ padding: '0 1rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        {whatsapp && (
          <a
            href={`https://wa.me/${whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent('Hola! Mi cuenta en el portal mayorista aparece como suspendida. Quisiera saber más.')}`}
            target="_blank" rel="noopener noreferrer"
            style={{ textDecoration: 'none' }}
          >
            <PortalButton variant="primary">Consultar por WhatsApp</PortalButton>
          </a>
        )}
        <PortalButton variant="ghost" onClick={handleLogout}>
          <LogOut size={16} /> Cerrar sesión
        </PortalButton>
      </div>
    </PortalLayout>
  )
}
