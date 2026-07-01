import { useNavigate } from 'react-router-dom'
import { Lock } from 'lucide-react'

interface Props {
  /** Título. Por defecto: "Acceso restringido". */
  title?: string
  /** Descripción. Por defecto: copy de Portal Clic. */
  description?: string
}

/**
 * Pantalla clara de acceso restringido (no un error crudo) para superficies
 * privadas como Portal Clic, cuando el rol no está autorizado por RLS.
 * Mantiene el sistema visual de TechRepair Pro (índigo), Lucide, focus visible.
 */
export function WholesaleRestrictedAccess({
  title = 'Acceso restringido',
  description = 'Solo el propietario del negocio puede administrar Portal Clic.',
}: Props) {
  const navigate = useNavigate()

  return (
    <div
      role="alert"
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '3rem 1.5rem',
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: '100%',
          background: '#0f1829',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: '1.25rem',
          padding: '2.5rem',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '1.25rem',
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: '1rem',
            background: 'rgba(99,102,241,0.1)',
            border: '1px solid rgba(99,102,241,0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Lock size={28} strokeWidth={1.75} color="#818cf8" aria-hidden="true" />
        </div>

        <div>
          <p style={{ margin: '0 0 0.5rem', fontWeight: 700, color: '#f1f5f9', fontSize: '1.1rem' }}>
            {title}
          </p>
          <p style={{ margin: 0, color: '#64748b', fontSize: '0.875rem', lineHeight: 1.6 }}>
            {description}
          </p>
        </div>

        <button
          onClick={() => navigate('/dashboard')}
          style={{
            padding: '0.75rem 1.5rem',
            background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
            border: 'none',
            borderRadius: '0.75rem',
            color: '#fff',
            fontWeight: 700,
            fontSize: '0.875rem',
            cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(99,102,241,0.3)',
            transition: 'opacity 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
        >
          Volver al inicio
        </button>
      </div>
    </div>
  )
}
