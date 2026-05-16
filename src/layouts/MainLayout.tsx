import { Outlet, useNavigate } from 'react-router-dom'
import { Sidebar } from '../components/layout/Sidebar'
import { TopHeader } from '../components/layout/TopHeader'
import { CommandPalette } from '../components/ui/CommandPalette'
import { useAuth } from '../contexts/AuthContext'
import { useSidebar } from '../hooks/useSidebar'
import { SubscriptionGuard } from '../components/subscription/SubscriptionGuard'
import { SubscriptionBanner } from '../components/subscription/SubscriptionBanner'
import { TrialBanner } from '../components/subscription/TrialBanner'
import { SystemStatusProvider } from '../contexts/SystemStatusContext'
import { useEffect } from 'react'
import { backgroundPrefetch } from '../services/refreshCriticalData'
import logoSvg from '../assets/logo.svg'

// Mobile top bar (hamburger + brand)
function MobileTopBar() {
  const { toggleMobileSidebar } = useSidebar()
  const navigate = useNavigate()
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem',
      padding: '0.75rem 1rem',
      background: 'rgba(11,18,32,0.98)',
      borderBottom: '1px solid rgba(255,255,255,0.07)',
      position: 'sticky',
      top: 0,
      zIndex: 50,
    }}>
      <button
        onClick={toggleMobileSidebar}
        aria-label="Abrir menú"
        style={{
          width: '38px', height: '38px',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '0.6rem',
          color: '#f8fafc',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>

      <div
        onClick={() => navigate('/dashboard')}
        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}
      >
        <img
          src={logoSvg}
          alt="TechRepair Pro"
          style={{
            width: '30px', height: '30px', borderRadius: '8px',
            boxShadow: '0 3px 10px rgba(99,102,241,0.4)',
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: '0.9375rem', fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.025em' }}>
          TechRepair<span style={{ color: '#818cf8' }}>Pro</span>
        </span>
      </div>
    </div>
  )
}

export function MainLayout() {
  const { businessId, profileError, user } = useAuth()
  const { isCollapsed } = useSidebar()
  const sidebarOffset = isCollapsed ? '80px' : '260px'

  // Precarga en segundo plano al montar el layout
  useEffect(() => {
    if (businessId) backgroundPrefetch(businessId)
  }, [businessId])

  return (
    <SystemStatusProvider>
    <CommandPalette />
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--app-shell-bg)',
        display: 'flex',
      }}
    >
      <Sidebar />
      <div
        className="main-layout-content"
        style={{
          flex: 1,
          marginLeft: sidebarOffset,
          width: `calc(100% - ${sidebarOffset})`,
          minWidth: 0,
          minHeight: '100vh',
          background: 'transparent',
          transition: 'margin-left 0.3s cubic-bezier(0.4, 0, 0.2, 1), width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* Mobile top bar — hidden on desktop via CSS */}
        <div className="mobile-topbar-wrapper">
          <MobileTopBar />
        </div>

        <div className="main-layout-inner">
          {/* Desktop top search/notif header — hidden on mobile via CSS */}
          <div className="desktop-topheader-wrapper">
            <TopHeader />
          </div>

          {!businessId ? (
            <div
              style={{
                padding: '1.5rem',
                backgroundColor: 'var(--bg-card)',
                border: '1px solid var(--error)',
                borderRadius: '0.75rem',
              }}
            >
              <h2 style={{ color: 'var(--text-primary)', marginTop: 0, marginBottom: '0.75rem' }}>
                Falta vincular este usuario a un negocio
              </h2>
              <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
                {profileError || 'El usuario inicio sesion, pero todavia no tiene perfil ni business_id.'}
              </p>
              <p style={{ color: 'var(--text-muted)', marginBottom: 0 }}>
                Usuario actual: {user?.email || 'sin email'}
              </p>
            </div>
          ) : (
            <SubscriptionGuard>
              <SubscriptionBanner />
              <TrialBanner />
              <Outlet />
            </SubscriptionGuard>
          )}
        </div>
      </div>

      <style>{`
        /* Desktop: hide mobile top bar */
        .mobile-topbar-wrapper { display: none; }
        .desktop-topheader-wrapper { display: block; }

        .main-layout-inner {
          padding: 2rem;
          max-width: 1400px;
          margin: 0 auto;
        }

        /* Tablet + mobile: hide sidebar, show mobile bar */
        @media (max-width: 1023px) {
          .main-layout-content {
            margin-left: 0 !important;
            width: 100% !important;
          }
          .mobile-topbar-wrapper { display: block; }
          .desktop-topheader-wrapper { display: none; }
          .main-layout-inner { padding: 1.25rem; }
        }

        @media (max-width: 767px) {
          .main-layout-inner { padding: 0.875rem; }
        }

        @media (max-width: 479px) {
          .main-layout-inner { padding: 0.75rem 0.625rem; }
        }
      `}</style>
    </div>
    </SystemStatusProvider>
  )
}
