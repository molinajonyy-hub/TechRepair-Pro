import { useState, useEffect } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Home, ArrowLeftRight, CreditCard, Target, MoreHorizontal, X } from 'lucide-react'
import { ToastProvider } from '../components/ui'
import { useAuth, type Profile } from '../../contexts/AuthContext'
import type { User } from '@supabase/supabase-js'
import { useQuickExpenseShortcut } from '../hooks/useQuickExpenseShortcut'
import { QuickExpensePopup, QuickExpenseContext } from '../components/QuickExpensePopup'

// ── Greeting helpers ──────────────────────────────────────────────────────────

function getFirstName(user: User | null, profile: Profile | null): string | null {
  const raw =
    profile?.full_name ||
    (user?.user_metadata?.full_name as string | undefined) ||
    (user?.user_metadata?.name   as string | undefined) ||
    user?.email?.split('@')[0] ||
    ''
  const clean = raw.trim()
  if (!clean) return null
  return clean.split(' ')[0]
}

function getTimeGreeting(): 'Buen día' | 'Buenas tardes' | 'Buenas noches' {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return 'Buen día'
  if (h >= 12 && h < 20) return 'Buenas tardes'
  return 'Buenas noches'
}

const PHRASES: Record<ReturnType<typeof getTimeGreeting>, string[]> = {
  'Buen día': [
    'Arrancamos con los números claros.',
    'Hoy ordenamos la guita sin drama.',
    'Un cafecito y a mirar el mes.',
    'Buen día para tomar control.',
    'La guita no se ordena sola.',
  ],
  'Buenas tardes': [
    'Tu plata, pero sin vueltas.',
    'Vamos viendo cómo viene el día.',
    'Revisamos rápido y seguimos.',
    'Que los números no se hagan los vivos.',
    'Chequeamos y seguimos.',
  ],
  'Buenas noches': [
    'Cerramos el día con control.',
    'A mirar el resumen sin sustos.',
    'Última mirada antes de descansar.',
    'Que la billetera duerma tranquila.',
    'Números claros, mente tranquila.',
  ],
}

function getGreetingPhrase(greeting: ReturnType<typeof getTimeGreeting>): string {
  const list = PHRASES[greeting]
  // Deterministic per day — no flickering on re-render
  return list[new Date().getDate() % list.length]
}

// ── Nav ───────────────────────────────────────────────────────────────────────

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
  const location  = useLocation()
  const navigate  = useNavigate()
  const { user, profile } = useAuth()

  const { open: quickOpen, openPopup, closePopup } = useQuickExpenseShortcut()

  const active = (path: string) => {
    if (path === '/personal') return location.pathname === '/personal'
    return location.pathname.startsWith(path)
  }

  const greeting  = getTimeGreeting()
  const phrase    = getGreetingPhrase(greeting)
  const firstName = getFirstName(user, profile)
  const title     = firstName ? `${greeting}, ${firstName}` : greeting

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
      <header
        data-testid="personal-header"
        style={{
          position: 'sticky', top: 0, zIndex: 50,
          background: 'rgba(7,16,24,0.96)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          padding: 'max(0.875rem, env(safe-area-inset-top, 0.875rem)) 1rem 0.75rem',
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          flexShrink: 0,
        }}
      >
        {/* Logo verde canónico Mi Guita */}
        <div style={{
          flexShrink: 0,
          width: 38, height: 38,
          borderRadius: '0.75rem',
          boxShadow: '0 0 12px rgba(52,211,153,0.20)',
          overflow: 'hidden',
        }}>
          <img
            src="/icons/miguita-192.svg"
            alt="Mi Guita"
            data-testid="personal-header-logo"
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
        </div>

        {/* Saludo personalizado */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            data-testid="personal-header-greeting"
            style={{
              fontWeight: 700,
              fontSize: '0.9375rem',
              color: '#f0f4ff',
              letterSpacing: '-0.01em',
              lineHeight: 1.25,
              margin: 0,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {title}
          </p>
          <p
            data-testid="personal-header-phrase"
            style={{
              fontSize: '0.72rem',
              color: '#475569',
              margin: '0.125rem 0 0',
              lineHeight: 1.3,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {phrase}
          </p>
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
        <QuickExpenseContext.Provider value={{ openPopup }}>
          <Outlet />
        </QuickExpenseContext.Provider>
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

      {/* Quick expense popup — mounted at layout level, available on all personal routes */}
      <QuickExpensePopup open={quickOpen} onClose={closePopup} />

      {/* Fade + slide bottom nav when a sheet is open */}
      <style>{`
        [data-testid="personal-bottom-nav"] {
          transition: opacity 0.25s ease, transform 0.25s ease;
        }
        body.personal-sheet-open [data-testid="personal-bottom-nav"] {
          opacity: 0 !important;
          pointer-events: none !important;
          transform: translateX(-50%) translateY(10px) !important;
        }
      `}</style>
    </div>
  )
}
