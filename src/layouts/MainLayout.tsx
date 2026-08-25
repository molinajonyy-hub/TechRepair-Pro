import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Sidebar } from '../components/layout/Sidebar'
import { MobileBottomNav } from '../components/layout/MobileBottomNav'
import { TopHeader } from '../components/layout/TopHeader'
import { ThemeToggle } from '../components/ui/ThemeToggle'
import { CommandPalette } from '../components/ui/CommandPalette'
import { useAuth } from '../contexts/AuthContext'
import { useSidebar } from '../hooks/useSidebar'
import { useNavigationAccess } from '../hooks/useNavigationAccess'
import { mobilePrimaryPaths, resolveMobilePrimaryNavigation } from '../config/mobileNavigation'
import { zIndex } from '../lib/tokens'
import { SubscriptionGuard } from '../components/subscription/SubscriptionGuard'
import { SubscriptionBanner } from '../components/subscription/SubscriptionBanner'
import { SystemStatusProvider } from '../contexts/SystemStatusContext'
import { Suspense, useEffect } from 'react'
import { backgroundPrefetch } from '../services/refreshCriticalData'
import logoSvg from '../assets/logo.svg'

const MOBILE_PAGE_TITLES: Array<[string, string]> = [
  ['/orders/new', 'Nueva orden'],
  ['/orders/', 'Detalle de orden'],
  ['/orders', 'Órdenes'],
  ['/comprobantes', 'POS y comprobantes'],
  ['/customers', 'Clientes'],
  ['/tasks', 'Tareas'],
  ['/caja', 'Caja'],
  ['/inventory', 'Inventario'],
  ['/suppliers', 'Proveedores'],
  ['/finance', 'Finanzas'],
  ['/reports', 'Reportes'],
  ['/users', 'Usuarios'],
  ['/settings', 'Configuración'],
  ['/subscription', 'Suscripción'],
  ['/dashboard', 'Inicio'],
]

export function mobilePageTitle(pathname: string): string {
  return MOBILE_PAGE_TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? 'Inicio'
}

// Mobile top bar (Más + contexto + tema)
function MobileTopBar() {
  const { isMobileOpen, toggleMobileSidebar } = useSidebar()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const title = mobilePageTitle(pathname)

  return (
    <header className="mobile-app-header" style={{ zIndex: zIndex.sticky }}>
      <button
        onClick={toggleMobileSidebar}
        aria-label="Abrir más módulos"
        aria-controls="mobile-more-drawer"
        aria-expanded={isMobileOpen}
        className="mobile-app-header__action"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>

      <button
        type="button"
        onClick={() => navigate('/dashboard')}
        className="mobile-app-header__context"
        aria-label={`Ir a Inicio. Página actual: ${title}`}
      >
        <img
          src={logoSvg}
          alt="TechRepair Pro"
          className="mobile-app-header__logo"
        />
        <span className="mobile-app-header__title">{title}</span>
      </button>

      <ThemeToggle variant="icon" />
    </header>
  )
}

export function MainLayout() {
  const { businessId, profileError, user } = useAuth()
  const { isCollapsed } = useSidebar()
  const navigationAccess = useNavigationAccess()
  const primaryDestinations = resolveMobilePrimaryNavigation(navigationAccess)
  const primaryPaths = mobilePrimaryPaths(primaryDestinations)
  const sidebarOffset = isCollapsed ? '80px' : '260px'

  // Precarga en segundo plano al montar el layout
  useEffect(() => {
    if (businessId) backgroundPrefetch(businessId)
  }, [businessId])

  useEffect(() => {
    document.body.classList.add('mobile-shell-active')
    return () => document.body.classList.remove('mobile-shell-active')
  }, [])

  return (
    <SystemStatusProvider>
    <CommandPalette />
    <div
      className="app-shell-mobile"
      style={{
        minHeight: '100dvh',
        background: 'var(--app-shell-bg)',
        display: 'flex',
      }}
    >
      <Sidebar access={navigationAccess} mobilePrimaryPaths={primaryPaths} />
      <div
        className="main-layout-content"
        style={{
          flex: 1,
          marginLeft: sidebarOffset,
          width: `calc(100% - ${sidebarOffset})`,
          minWidth: 0,
          minHeight: '100dvh',
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
              <Suspense fallback={
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
                  <div style={{
                    width: 32, height: 32,
                    border: '3px solid rgba(99,102,241,0.2)',
                    borderTopColor: '#6366f1',
                    borderRadius: '50%',
                    animation: 'spin 0.7s linear infinite',
                  }} />
                </div>
              }>
                <Outlet />
              </Suspense>
            </SubscriptionGuard>
          )}
        </div>
      </div>

      <MobileBottomNav access={navigationAccess} />

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
          .main-layout-inner {
            padding: 1.25rem;
            padding-bottom: calc(1.25rem + var(--mobile-bottom-nav-height) + env(safe-area-inset-bottom, 0px));
          }
        }

        @media (max-width: 767px) {
          .main-layout-inner {
            padding: var(--mobile-page-padding);
            padding-bottom: calc(var(--mobile-page-padding) + var(--mobile-bottom-nav-height) + env(safe-area-inset-bottom, 0px));
          }
        }

        @media (max-width: 359px) {
          .main-layout-inner {
            padding: 0.75rem;
            padding-bottom: calc(0.75rem + var(--mobile-bottom-nav-height) + env(safe-area-inset-bottom, 0px));
          }
        }
      `}</style>
    </div>
    </SystemStatusProvider>
  )
}
