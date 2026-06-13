import { PT } from './PortalLayout'

interface Props {
  logoSrc?:  string
  title?:    string
  subtitle?: string
  badge?:    string
}

/** Bloque de marca superior del portal mayorista (login, registro, etc.) */
export function WholesaleBrandHeader({
  logoSrc = '/logo-clic.png',
  title = 'Clic Mayorista',
  subtitle = 'Acceso exclusivo para clientes mayoristas',
  badge,
}: Props) {
  return (
    <div style={{ textAlign: 'center', marginBottom: '2.25rem' }}>

      {/* Icono / logo */}
      <div style={{
        width: 72,
        height: 72,
        borderRadius: 20,
        background: '#ffffff',
        border: `1px solid ${PT.border}`,
        boxShadow: '0 2px 10px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: '0 auto 1.125rem',
        overflow: 'hidden',
      }}>
        {logoSrc ? (
          <img
            src={logoSrc}
            alt={title}
            style={{ width: '70%', height: '70%', objectFit: 'contain' }}
          />
        ) : (
          <span style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.04em', color: PT.text }}>
            Clic.
          </span>
        )}
      </div>

      {/* Título */}
      <h1 style={{
        margin: 0,
        fontSize: 'clamp(1.5rem, 6vw, 1.875rem)',
        fontWeight: 800,
        letterSpacing: '-0.03em',
        color: PT.text,
        lineHeight: 1.2,
      }}>
        {title}
      </h1>

      {/* Subtítulo */}
      <p style={{
        margin: '0.5rem 0 0',
        fontSize: '0.875rem',
        color: PT.textSub,
        fontWeight: 400,
        letterSpacing: '0.01em',
      }}>
        {subtitle}
      </p>

      {/* Badge opcional */}
      {badge && (
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          marginTop: '0.875rem',
          padding: '0.3rem 0.75rem',
          borderRadius: 99,
          background: 'rgba(0,122,255,0.08)',
          border: '1px solid rgba(0,122,255,0.16)',
          color: PT.primary,
          fontSize: '0.7rem',
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}>
          {badge}
        </div>
      )}
    </div>
  )
}
