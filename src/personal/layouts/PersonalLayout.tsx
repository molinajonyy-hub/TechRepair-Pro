import { useState, useEffect } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Home, ArrowLeftRight, CreditCard, Target, MoreHorizontal, ArrowLeft, Wallet, X } from 'lucide-react'
import { ToastProvider } from '../components/ui'

const NAV = [
  { path: '/personal',             label: 'Inicio',      Icon: Home,           testId: 'personal-nav-home'      },
  { path: '/personal/movimientos', label: 'Movimientos', Icon: ArrowLeftRight, testId: 'personal-nav-movements' },
  { path: '/personal/tarjetas',    label: 'Tarjetas',    Icon: CreditCard,     testId: 'personal-nav-cards'     },
  { path: '/personal/ahorros',     label: 'Ahorros',     Icon: Target,         testId: 'personal-nav-savings'   },
  { path: '/personal/mas',         label: 'Más',         Icon: MoreHorizontal, testId: 'personal-nav-more'      },
]

// ── Install prompt card ────────────────────────────────────────────────────────

function InstallCard() {
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (localStorage.getItem('miguita_install_dismissed') === '1') setDismissed(true)
  }, [])

  // Don't show if already dismissed or running in standalone mode
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as any).standalone === true

  if (dismissed || isStandalone) return null

  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
  const isAndroid = /Android/i.test(navigator.userAgent)

  // Only show on mobile browsers (skip desktop)
  const isMobile = window.innerWidth <= 768

  if (!isMobile) return null

  const dismiss = () => {
    localStorage.setItem('miguita_install_dismissed', '1')
    setDismissed(true)
  }

  return (
    <div
      data-testid="personal-install-card"
      style={{ margin: '0.75rem 0.75rem 0', padding: '0.875rem', background: 'rgba(129,140,248,0.06)', border: '1px solid rgba(129,140,248,0.18)', borderRadius: '1rem', position: 'relative' }}
    >
      <button
        data-testid="personal-install-dismiss"
        onClick={dismiss}
        style={{ position: 'absolute', top: '0.625rem', right: '0.625rem', background: 'none', border: 'none', cursor: 'pointer', color: '#334155', display: 'flex', minWidth: 28, minHeight: 28, alignItems: 'center', justifyContent: 'center' }}
      >
        <X size={14} />
      </button>
      <div style={{ fontWeight: 700, fontSize: '0.8125rem', color: '#818cf8', marginBottom: '0.375rem' }}>
        Instalá Mi Guita
      </div>
      <div style={{ fontSize: '0.775rem', color: '#475569', marginBottom: '0.625rem', lineHeight: 1.4 }}>
        Agregala a la pantalla de inicio para cargar gastos más rápido.
      </div>
      {isIOS && (
        <div data-testid="personal-install-ios-steps" style={{ fontSize: '0.72rem', color: '#334155', lineHeight: 1.5 }}>
          Tocá Compartir (□↑) → "Agregar a inicio" → Abrí Mi Guita desde el icono.
        </div>
      )}
      {isAndroid && (
        <div data-testid="personal-install-android-steps" style={{ fontSize: '0.72rem', color: '#334155', lineHeight: 1.5 }}>
          Tocá el menú ⋮ → "Instalar app" → Abrí Mi Guita desde el icono.
        </div>
      )}
      {!isIOS && !isAndroid && (
        <div style={{ fontSize: '0.72rem', color: '#334155', lineHeight: 1.5 }}>
          Usá el menú de tu navegador para agregar Mi Guita a la pantalla de inicio.
        </div>
      )}
    </div>
  )
}

// ── Layout ────────────────────────────────────────────────────────────────────

export function PersonalLayout() {
  const location = useLocation()
  const navigate = useNavigate()

  const active = (path: string) => {
    if (path === '/personal') return location.pathname === '/personal'
    return location.pathname.startsWith(path)
  }

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as any).standalone === true
  // Back button: navigate to /personal from any sub-route; hide on root in PWA
  const isOnRoot = location.pathname === '/personal'
  const showBack = !(isStandalone && isOnRoot)
  const handleBack = () => {
    if (!isOnRoot) navigate('/personal')
    else navigate('/dashboard') // browser fallback when on root
  }

  return (
    <div
      data-testid="personal-layout"
      style={{
        display: 'flex', flexDirection: 'column',
        minHeight: '100dvh', maxWidth: 480,
        margin: '0 auto', position: 'relative',
        background: 'var(--bg-base, #071018)',
      }}
    >
      {/* ── Top header ── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 50,
        background: 'rgba(7,16,24,0.96)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        padding: 'max(0.875rem, env(safe-area-inset-top, 0.875rem)) 1rem 0.75rem',
        display: 'flex', alignItems: 'center', gap: '0.75rem',
        flexShrink: 0,
      }}>
        {showBack && (
          <button
            onClick={handleBack}
            aria-label={isOnRoot ? 'Volver al negocio' : 'Inicio Mi Guita'}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: '0.25rem', display: 'flex', alignItems: 'center', minWidth: 36, minHeight: 36 }}>
            <ArrowLeft size={18} />
          </button>
        )}
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
      <main style={{
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        paddingBottom: 'calc(4.5rem + env(safe-area-inset-bottom, 0px))',
        WebkitOverflowScrolling: 'touch',
      }}>
        {/* Install prompt — only on mobile, only if not standalone */}
        <InstallCard />
        <Outlet />
      </main>

      {/* ── Bottom Navigation ── */}
      <nav
        data-testid="personal-bottom-nav"
        style={{
          position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
          width: '100%', maxWidth: 480,
          background: 'rgba(7,16,24,0.97)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderTop: '1px solid rgba(255,255,255,0.07)',
          display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
          paddingTop: '0.375rem',
          paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom, 0.625rem))',
          zIndex: 100,
        }}
      >
        {NAV.map(({ path, label, Icon, testId }) => {
          const isActive = active(path)
          return (
            <button
              key={path}
              data-testid={testId}
              onClick={() => navigate(path)}
              aria-label={label}
              aria-current={isActive ? 'page' : undefined}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: '0.2rem', background: 'none', border: 'none', cursor: 'pointer',
                padding: '0.25rem 0.125rem', transition: 'all 0.15s',
                minHeight: 44,
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

      {/* Toast notifications (renders above bottom nav) */}
      <ToastProvider />
    </div>
  )
}
