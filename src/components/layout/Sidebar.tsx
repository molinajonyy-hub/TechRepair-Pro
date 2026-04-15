import { NavLink, useNavigate } from 'react-router-dom';
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Coins,
  DollarSign,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Receipt,
  Settings,
  Smartphone,
  Truck,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useSidebar } from '../../hooks/useSidebar';

const menuItems = [
  { path: '/dashboard', icon: LayoutDashboard, label: 'Inicio' },
  { path: '/orders', icon: ClipboardList, label: 'Ordenes' },
  { path: '/comprobantes', icon: FileText, label: 'Comprobantes' },
  { path: '/customers', icon: Users, label: 'Clientes' },
  { path: '/inventory', icon: Package, label: 'Inventario' },
  { path: '/suppliers', icon: Truck, label: 'Proveedores' },
  { path: '/expenses', icon: Receipt, label: 'Gastos' },
  { path: '/caja', icon: Wallet, label: 'Caja' },
  { path: '/finance', icon: DollarSign, label: 'Finanzas' },
  { path: '/reports', icon: BarChart3, label: 'Reportes' },
  { path: '/users', icon: Users, label: 'Usuarios' },
  { path: '/settings', icon: Settings, label: 'Configuración' },
  { path: '/currency-settings', icon: Coins, label: 'Moneda' },
];

const expandedWidth = 260;
const collapsedWidth = 80;
const mobileWidth = 280;

const activeBackground = 'var(--nav-active-bg)';

export function Sidebar() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const {
    isCollapsed,
    isMobileOpen,
    toggleSidebar,
    toggleMobileSidebar,
    closeMobileSidebar,
  } = useSidebar();

  const sidebarWidth = isCollapsed ? collapsedWidth : expandedWidth;

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate('/login');
    } catch (error) {
      console.error('Error signing out:', error);
    }
  };

  const renderLogo = (collapsed = false, framed = true) => (
    <div
      style={{
        padding: framed ? (collapsed ? '1.25rem 0.75rem' : '1.5rem') : 0,
        borderBottom: framed ? '1px solid var(--border-color)' : 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        minHeight: framed ? '72px' : 'auto',
        boxSizing: 'border-box',
        minWidth: 0,
      }}
    >
      <div
        style={{
          width: '40px',
          height: '40px',
          borderRadius: '0.75rem',
          background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          boxShadow: '0 4px 12px rgba(99, 102, 241, 0.4)',
        }}
      >
        <Smartphone size={20} color="#ffffff" strokeWidth={2} />
      </div>

      {!collapsed && (
        <div style={{ marginLeft: '0.75rem', minWidth: 0 }}>
          <h1
            style={{
              fontSize: '1.125rem',
              fontWeight: 700,
              color: 'var(--text-primary)',
              margin: 0,
              letterSpacing: '-0.025em',
              lineHeight: 1.2,
            }}
          >
            TechRepair
          </h1>
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              margin: '0.125rem 0 0 0',
              fontWeight: 400,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            Sistema de Gestion
          </p>
        </div>
      )}
    </div>
  );

  const renderNav = (variant: 'desktop' | 'mobile') => {
    const collapsed = variant === 'desktop' && isCollapsed;

    return (
      <nav
        style={{
          flex: 1,
          padding: collapsed ? '0.75rem 0.5rem' : '1rem 0.75rem',
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {menuItems.map((item) => {
          const Icon = item.icon;

          return (
            <NavLink
              key={item.path}
              to={item.path}
              onClick={variant === 'mobile' ? closeMobileSidebar : undefined}
              title={collapsed ? item.label : undefined}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                justifyContent: collapsed ? 'center' : 'flex-start',
                gap: collapsed ? 0 : '0.75rem',
                width: '100%',
                minHeight: variant === 'mobile' ? '46px' : '42px',
                padding: collapsed ? '0.75rem' : variant === 'mobile' ? '0.875rem 1rem' : '0.75rem 1rem',
                marginBottom: '0.25rem',
                borderRadius: '0.625rem',
                color: isActive ? 'var(--nav-active-text)' : 'var(--text-muted)',
                background: isActive ? activeBackground : 'transparent',
                border: isActive ? '1px solid var(--nav-active-border)' : '1px solid transparent',
                textDecoration: 'none',
                transition: 'all 0.2s ease',
                fontWeight: isActive ? 600 : 400,
                fontSize: variant === 'mobile' ? '0.9375rem' : '0.875rem',
                boxSizing: 'border-box',
                overflow: 'hidden',
              })}
            >
              <Icon size={variant === 'mobile' ? 20 : 18} style={{ flexShrink: 0 }} />
              {!collapsed && (
                <span
                  style={{
                    minWidth: 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {item.label}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>
    );
  };

  const renderSignOut = (variant: 'desktop' | 'mobile') => {
    const collapsed = variant === 'desktop' && isCollapsed;

    return (
      <div
        style={{
          padding: collapsed ? '0.75rem 0.5rem' : '1rem 0.75rem',
          borderTop: '1px solid var(--border-color)',
        }}
      >
        <button
          onClick={handleSignOut}
          aria-label="Cerrar sesion"
          title={collapsed ? 'Cerrar sesion' : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            gap: collapsed ? 0 : '0.75rem',
            width: '100%',
            minHeight: variant === 'mobile' ? '46px' : '42px',
            padding: collapsed ? '0.75rem' : variant === 'mobile' ? '0.875rem 1rem' : '0.75rem 1rem',
            borderRadius: '0.625rem',
            color: 'var(--text-muted)',
            backgroundColor: 'transparent',
            border: '1px solid var(--border-color)',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            fontWeight: 400,
            fontSize: variant === 'mobile' ? '0.9375rem' : '0.875rem',
            boxSizing: 'border-box',
            overflow: 'hidden',
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.backgroundColor = 'var(--hover-bg)';
            event.currentTarget.style.borderColor = 'var(--border-subtle)';
            event.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.backgroundColor = 'transparent';
            event.currentTarget.style.borderColor = 'var(--border-color)';
            event.currentTarget.style.color = 'var(--text-muted)';
          }}
        >
          <LogOut size={variant === 'mobile' ? 20 : 18} style={{ flexShrink: 0 }} />
          {!collapsed && <span>Cerrar Sesion</span>}
        </button>
      </div>
    );
  };

  return (
    <>
      <aside
        className="sidebar"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: `${sidebarWidth}px`,
          height: '100vh',
          backgroundColor: 'var(--bg-sidebar)',
          backdropFilter: 'blur(20px)',
          borderRight: '1px solid var(--border-color)',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
          overflow: 'hidden',
          transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {renderLogo(isCollapsed)}

        <div
          style={{
            padding: isCollapsed ? '0.75rem 0.5rem' : '0.75rem 1rem',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <button
            onClick={toggleSidebar}
            aria-label={isCollapsed ? 'Expandir sidebar' : 'Colapsar sidebar'}
            style={{
              width: '100%',
              padding: '0.5rem',
              backgroundColor: 'var(--accent-primary-light)',
              border: '1px solid var(--accent-primary)',
              borderRadius: '0.5rem',
              color: 'var(--accent-primary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: isCollapsed ? 'center' : 'space-between',
              transition: 'all 0.2s ease',
              fontWeight: 500,
              fontSize: '0.8125rem',
              boxSizing: 'border-box',
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.backgroundColor = 'var(--accent-primary-subtle)';
              event.currentTarget.style.borderColor = 'var(--accent-primary-hover)';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.backgroundColor = 'var(--accent-primary-light)';
              event.currentTarget.style.borderColor = 'var(--accent-primary)';
            }}
          >
            {!isCollapsed && <span>Menu</span>}
            {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        {renderNav('desktop')}
        {renderSignOut('desktop')}
      </aside>

      {isMobileOpen && (
        <div
          onClick={closeMobileSidebar}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            zIndex: 999,
            backdropFilter: 'blur(4px)',
          }}
        />
      )}

      <aside
        className="sidebar-mobile"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: `${mobileWidth}px`,
          maxWidth: 'calc(100vw - 24px)',
          height: '100vh',
          backgroundColor: 'var(--bg-sidebar)',
          backdropFilter: 'blur(20px)',
          borderRight: '1px solid var(--border-color)',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
          overflow: 'hidden',
          transform: isMobileOpen ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <div
          style={{
            padding: '1.5rem',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
          }}
        >
          {renderLogo(false, false)}
          <button
            onClick={closeMobileSidebar}
            aria-label="Cerrar menu"
            style={{
              width: '36px',
              height: '36px',
              backgroundColor: 'var(--hover-bg)',
              border: '1px solid var(--border-color)',
              borderRadius: '0.5rem',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              transition: 'all 0.2s ease',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {renderNav('mobile')}
        {renderSignOut('mobile')}
      </aside>

      <button
        className="sidebar-mobile-toggle"
        onClick={toggleMobileSidebar}
        aria-label="Abrir menu"
        style={{
          position: 'fixed',
          top: '1rem',
          left: '1rem',
          width: '44px',
          height: '44px',
          backgroundColor: 'var(--bg-sidebar)',
          backdropFilter: 'blur(10px)',
          border: '1px solid var(--border-color)',
          borderRadius: '0.75rem',
          color: 'var(--text-primary)',
          cursor: 'pointer',
          display: 'none',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 998,
          transition: 'all 0.2s ease',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <Menu size={20} />
      </button>

      <style>{`
        @media (max-width: 768px) {
          .sidebar {
            display: none !important;
          }

          .sidebar-mobile-toggle {
            display: flex !important;
          }
        }

        @media (min-width: 769px) {
          .sidebar-mobile,
          .sidebar-mobile-toggle {
            display: none !important;
          }
        }
      `}</style>
    </>
  );
}
