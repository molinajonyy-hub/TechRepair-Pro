import { Outlet } from 'react-router-dom'
import { Sidebar } from '../components/layout/Sidebar'
import { TopHeader } from '../components/layout/TopHeader'
import { useAuth } from '../contexts/AuthContext'
import { useSidebar } from '../hooks/useSidebar'

export function MainLayout() {
  const { businessId, profileError, user } = useAuth()
  const { isCollapsed } = useSidebar()
  const sidebarOffset = isCollapsed ? '80px' : '260px'

  return (
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
        <div
          style={{
            padding: '2rem',
            maxWidth: '1400px',
            margin: '0 auto',
          }}
        >
          <TopHeader />

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
            <Outlet />
          )}
        </div>
      </div>

      <style>{`
        @media (max-width: 768px) {
          .main-layout-content {
            margin-left: 0 !important;
            width: 100% !important;
          }
        }
      `}</style>
    </div>
  )
}
