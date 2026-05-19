import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Home, ArrowLeftRight, CreditCard, Target, MoreHorizontal, ArrowLeft, Wallet } from 'lucide-react'

const NAV = [
  { path: '/personal',              label: 'Inicio',      Icon: Home           },
  { path: '/personal/movimientos',  label: 'Movimientos', Icon: ArrowLeftRight },
  { path: '/personal/tarjetas',     label: 'Tarjetas',    Icon: CreditCard     },
  { path: '/personal/ahorros',      label: 'Ahorros',     Icon: Target         },
  { path: '/personal/mas',          label: 'Más',         Icon: MoreHorizontal },
]

export function PersonalLayout() {
  const location = useLocation()
  const navigate = useNavigate()

  const active = (path: string) => {
    if (path === '/personal') return location.pathname === '/personal'
    return location.pathname.startsWith(path)
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      minHeight: '100dvh', maxWidth: 480,
      margin: '0 auto', position: 'relative',
      background: 'var(--bg-base, #071018)',
      fontFamily: 'var(--font-sans, Inter, system-ui, sans-serif)',
    }}>
      {/* ── Top header ── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 50,
        background: 'rgba(7,16,24,0.95)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        padding: '0.875rem 1rem 0.75rem',
        display: 'flex', alignItems: 'center', gap: '0.75rem',
        flexShrink: 0,
      }}>
        <button
          onClick={() => navigate('/dashboard')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: '0.25rem', display: 'flex', alignItems: 'center' }}>
          <ArrowLeft size={18} />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
          <div style={{ width: 28, height: 28, borderRadius: '0.5rem', background: 'linear-gradient(135deg,rgba(52,211,153,0.25),rgba(16,185,129,0.15))', border: '1px solid rgba(52,211,153,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Wallet size={14} color="#34d399" />
          </div>
          <span style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#f0f4ff', letterSpacing: '-0.01em' }}>
            Mi Guita
          </span>
        </div>
      </header>

      {/* ── Page content ── */}
      <main style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingBottom: '5rem' }}>
        <Outlet />
      </main>

      {/* ── Bottom Navigation ── */}
      <nav style={{
        position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
        width: '100%', maxWidth: 480,
        background: 'rgba(7,16,24,0.97)',
        backdropFilter: 'blur(16px)',
        borderTop: '1px solid rgba(255,255,255,0.07)',
        display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
        padding: '0.5rem 0 max(0.5rem, env(safe-area-inset-bottom))',
        zIndex: 100,
      }}>
        {NAV.map(({ path, label, Icon }) => {
          const isActive = active(path)
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: '0.2rem', background: 'none', border: 'none', cursor: 'pointer',
                padding: '0.25rem 0', transition: 'all 0.15s',
              }}
            >
              <div style={{
                width: 36, height: 28, borderRadius: '1rem',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: isActive ? 'rgba(52,211,153,0.15)' : 'transparent',
                transition: 'background 0.15s',
              }}>
                <Icon size={18} color={isActive ? '#34d399' : '#475569'} />
              </div>
              <span style={{
                fontSize: '0.625rem', fontWeight: isActive ? 700 : 500,
                color: isActive ? '#34d399' : '#475569',
                letterSpacing: '0.02em',
              }}>
                {label}
              </span>
            </button>
          )
        })}
      </nav>

      {/* iOS-style safe area for bottom */}
      <div style={{ height: 'env(safe-area-inset-bottom)', background: 'rgba(7,16,24,0.97)' }} />
    </div>
  )
}
