import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ShoppingCart, User, ArrowLeft, ClipboardList } from 'lucide-react'
import { usePortal } from '../contexts/PortalContext'
import { usePortalCart } from '../hooks/usePortalCart'

// ─── iOS-style design tokens ──────────────────────────────────────────────────
export const PT = {
  bg:         '#f2f2f7',
  surface:    '#ffffff',
  primary:    '#007aff',
  success:    '#34c759',
  danger:     '#ff3b30',
  warning:    '#ff9500',
  text:       '#1c1c1e',
  textSub:    '#8e8e93',
  border:     '#e5e5ea',
  radius:     '12px',
  radiusLg:   '16px',
  shadow:     '0 2px 12px rgba(0,0,0,0.08)',
  shadowMd:   '0 4px 24px rgba(0,0,0,0.12)',
  font:       "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', sans-serif",
}

interface Props {
  children:    ReactNode
  title?:      string
  showBack?:   boolean
  showCart?:   boolean
  backTo?:     string
}

export function PortalLayout({ children, title, showBack = false, showCart = true, backTo }: Props) {
  const { slug } = useParams<{ slug: string }>()
  const { business, customer } = usePortal()
  const navigate = useNavigate()
  const { itemCount } = usePortalCart(business?.id || '')

  const goBack = () => {
    if (backTo) navigate(backTo)
    else navigate(-1)
  }

  return (
    <div style={{
      minHeight: '100dvh',
      background: PT.bg,
      fontFamily: PT.font,
      color: PT.text,
      overflowX: 'hidden',
    }}>
      {/* ── Top bar ── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 100,
        background: 'rgba(242,242,247,0.92)',
        backdropFilter: 'saturate(180%) blur(20px)',
        WebkitBackdropFilter: 'saturate(180%) blur(20px)',
        borderBottom: `1px solid ${PT.border}`,
        padding: '0 1rem',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 54,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
          {showBack && (
            <button onClick={goBack} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: PT.primary, display: 'flex', alignItems: 'center', gap: '0.25rem',
              fontSize: '1rem', fontFamily: PT.font, padding: '0.25rem',
              marginLeft: '-0.25rem',
            }}>
              <ArrowLeft size={20} />
            </button>
          )}
          {title ? (
            <span style={{ fontWeight: 600, fontSize: '1rem', color: PT.text }}>{title}</span>
          ) : (
            <span style={{ fontWeight: 700, fontSize: '1.1rem', color: PT.text, letterSpacing: '-0.02em' }}>
              {business?.name || 'Portal'}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {customer && (
            <>
              <button
                onClick={() => navigate(`/mayorista/${slug}/pedidos`)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: PT.textSub, padding: '0.25rem' }}
                title="Mis pedidos"
              >
                <ClipboardList size={20} />
              </button>
              <button
                onClick={() => navigate(`/mayorista/${slug}/perfil`)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: PT.textSub, padding: '0.25rem' }}
              >
                <User size={22} />
              </button>
            </>
          )}
          {showCart && customer?.approved && (
            <button
              onClick={() => navigate(`/mayorista/${slug}/carrito`)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                position: 'relative', color: PT.text, padding: '0.25rem',
              }}
            >
              <ShoppingCart size={22} />
              {itemCount > 0 && (
                <span style={{
                  position: 'absolute', top: -2, right: -4,
                  background: PT.danger, color: '#fff',
                  fontSize: '0.65rem', fontWeight: 700,
                  width: 18, height: 18, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  lineHeight: 1,
                }}>
                  {itemCount > 9 ? '9+' : itemCount}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '0 0 5rem' }}>
        {children}
      </div>
    </div>
  )
}

// ── Reusable UI primitives ────────────────────────────────────────────────────

export function PortalCard({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: PT.surface, borderRadius: PT.radiusLg,
      boxShadow: PT.shadow, overflow: 'hidden', ...style,
    }}>
      {children}
    </div>
  )
}

export function PortalButton({
  children, onClick, variant = 'primary', loading = false, disabled = false, fullWidth = true,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  loading?: boolean
  disabled?: boolean
  fullWidth?: boolean
  type?: 'button' | 'submit'
}) {
  const colors = {
    primary:   { bg: PT.primary,  color: '#fff'   },
    secondary: { bg: PT.border,   color: PT.text  },
    danger:    { bg: PT.danger,   color: '#fff'   },
    ghost:     { bg: 'transparent', color: PT.primary },
  }
  const c = colors[variant]
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={loading || disabled}
      style={{
        width: fullWidth ? '100%' : 'auto',
        padding: '0.875rem 1.5rem',
        background: c.bg, color: c.color,
        border: variant === 'ghost' ? `1px solid ${PT.border}` : 'none',
        borderRadius: PT.radius,
        fontFamily: PT.font, fontSize: '1rem', fontWeight: 600,
        cursor: loading || disabled ? 'not-allowed' : 'pointer',
        opacity: loading || disabled ? 0.6 : 1,
        transition: 'opacity 0.15s, transform 0.1s',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
      }}
    >
      {loading ? <span style={{ fontSize: '0.9rem' }}>Cargando...</span> : children}
    </button>
  )
}

export function PortalInput({
  label, type = 'text', value, onChange, placeholder, required, error,
}: {
  label: string
  type?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  required?: boolean
  error?: string
}) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: PT.textSub, marginBottom: '0.35rem' }}>
        {label}{required && <span style={{ color: PT.danger }}> *</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '0.75rem 1rem',
          background: PT.bg, border: `1px solid ${error ? PT.danger : PT.border}`,
          borderRadius: PT.radius, color: PT.text,
          fontFamily: PT.font, fontSize: '1rem',
          outline: 'none',
        }}
      />
      {error && <p style={{ margin: '0.25rem 0 0', fontSize: '0.78rem', color: PT.danger }}>{error}</p>}
    </div>
  )
}
