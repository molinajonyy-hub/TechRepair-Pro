import { useState, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useSidebar } from '../../hooks/useSidebar';
import { usePermissions } from '../../hooks/usePermissions';
import { PermissionKey } from '../../config/permissions';
import { ModalCobro } from '../cobro/ModalCobro';
import { supabase } from '../../lib/supabase';

// ── Cat logo SVG (from design system) ──
const CatIcon = ({ size = 26 }: { size?: number }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M18 46 L25 14 L38 36 Q50 30 62 36 L75 14 L82 46 Q86 60 82 70 Q70 88 50 88 Q30 88 18 70 Q14 60 18 46 Z" fill="white" opacity="0.93"/>
    <path d="M26 18 L20 43 L37 36 Z" fill="#6366f1" opacity="0.45"/>
    <path d="M74 18 L80 43 L63 36 Z" fill="#6366f1" opacity="0.45"/>
    <ellipse cx="37" cy="58" rx="5.5" ry="5" fill="#6366f1" opacity="0.8"/>
    <ellipse cx="63" cy="58" rx="5.5" ry="5" fill="#6366f1" opacity="0.8"/>
  </svg>
);

// ── WhatsApp official SVG icon ──
const WhatsAppIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
  </svg>
);

// ── Inline SVG icons (more specific, from design) ──
const DashboardIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
    <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
  </svg>
);
const OrdersIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
  </svg>
);
const ComprobantesIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
    <polyline points="10 9 9 9 8 9"/>
  </svg>
);
const WarrantyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    <polyline points="9 12 11 14 15 10"/>
  </svg>
);
const ClientesIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 00-3-3.87"/>
    <path d="M16 3.13a4 4 0 010 7.75"/>
  </svg>
);
const InventarioIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/>
    <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>
  </svg>
);
const MayoristaIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
    <line x1="3" y1="6" x2="21" y2="6"/>
    <path d="M16 10a4 4 0 01-8 0"/>
  </svg>
);
const OfertasIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
    <line x1="7" y1="7" x2="7.01" y2="7"/>
  </svg>
);
const ProveedoresIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="1" y="3" width="15" height="13"/>
    <polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>
    <circle cx="5.5" cy="18.5" r="2.5"/>
    <circle cx="18.5" cy="18.5" r="2.5"/>
  </svg>
);
const GastosIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/>
    <line x1="8" y1="10" x2="16" y2="10"/>
    <line x1="8" y1="14" x2="16" y2="14"/>
  </svg>
);
const CajaIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="2" y="5" width="20" height="14" rx="2"/>
    <line x1="2" y1="10" x2="22" y2="10"/>
  </svg>
);
const FinanzasIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
    <polyline points="17 6 23 6 23 12"/>
  </svg>
);
const ReportesIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="20" x2="18" y2="10"/>
    <line x1="12" y1="20" x2="12" y2="4"/>
    <line x1="6" y1="20" x2="6" y2="14"/>
  </svg>
);
const UsuariosIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
    <circle cx="19" cy="8" r="2"/>
    <path d="M19 6v4"/><path d="M17 8h4"/>
  </svg>
);
const ConfigIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
    <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
    <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
    <line x1="1" y1="14" x2="7" y2="14"/>
    <line x1="9" y1="8" x2="15" y2="8"/>
    <line x1="17" y1="16" x2="23" y2="16"/>
  </svg>
);
const MonedaIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10"/>
    <path d="M12 8v4l3 3"/>
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>
  </svg>
);
const SuscripcionIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
    <line x1="1" y1="10" x2="23" y2="10"/>
  </svg>
);
const TutorialesIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
    <path d="M6 12v5c3 3 9 3 12 0v-5"/>
  </svg>
);
const LogoutIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
    <polyline points="16 17 21 12 16 7"/>
    <line x1="21" y1="12" x2="9" y2="12"/>
  </svg>
);

// ── Menu structure with sections ──
type NavItem = {
  path: string;
  label: string;
  icon: React.ReactNode;
  isWhatsApp?: boolean;
  /** If set, this item is hidden when user lacks this permission */
  permission?: PermissionKey;
};
type NavSection = {
  sectionLabel: string;
  items: NavItem[];
};

const menuSections: NavSection[] = [
  {
    sectionLabel: 'Principal',
    items: [
      { path: '/dashboard', label: 'Inicio', icon: <DashboardIcon /> },
      { path: '/orders', label: 'Ordenes', icon: <OrdersIcon />, permission: 'orders' },
      { path: '/comprobantes', label: 'Comprobantes', icon: <ComprobantesIcon />, permission: 'comprobantes' },
      { path: '/warranties', label: 'Garantías', icon: <WarrantyIcon />, permission: 'orders' },
      { path: '/whatsapp', label: 'WhatsApp', icon: <WhatsAppIcon />, isWhatsApp: true },
    ],
  },
  {
    sectionLabel: 'Clientes & Stock',
    items: [
      { path: '/customers', label: 'Clientes', icon: <ClientesIcon />, permission: 'customers' },
      { path: '/inventory', label: 'Inventario', icon: <InventarioIcon />, permission: 'inventory' },
      { path: '/mayorista', label: 'Mayorista', icon: <MayoristaIcon />, permission: 'inventory' },
      { path: '/suppliers', label: 'Proveedores', icon: <ProveedoresIcon />, permission: 'inventory' },
      { path: '/offers', label: 'Ofertas', icon: <OfertasIcon />, permission: 'inventory' },
    ],
  },
  {
    sectionLabel: 'Finanzas',
    items: [
      { path: '/expenses', label: 'Gastos', icon: <GastosIcon />, permission: 'finance' },
      { path: '/caja', label: 'Caja', icon: <CajaIcon />, permission: 'finance' },
      { path: '/finance', label: 'Finanzas', icon: <FinanzasIcon />, permission: 'finance' },
      { path: '/reports', label: 'Reportes', icon: <ReportesIcon />, permission: 'reports' },
    ],
  },
  {
    sectionLabel: 'Administración',
    items: [
      { path: '/users', label: 'Usuarios', icon: <UsuariosIcon />, permission: 'users' },
      { path: '/settings', label: 'Configuración', icon: <ConfigIcon />, permission: 'settings' },
      { path: '/currency-settings', label: 'Moneda', icon: <MonedaIcon />, permission: 'settings' },
      { path: '/subscription', label: 'Suscripción', icon: <SuscripcionIcon />, permission: 'subscription' },
      { path: '/tutorials', label: 'Tutoriales', icon: <TutorialesIcon /> },
    ],
  },
];

const expandedWidth = 260;
const collapsedWidth = 80;
const mobileWidth = 280;

export function Sidebar() {
  const { signOut, businessId } = useAuth();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [mayoristaEnabled, setMayoristaEnabled] = useState(true);

  useEffect(() => {
    if (!businessId) return;
    supabase.from('business_settings').select('mayorista_enabled').eq('business_id', businessId).maybeSingle()
      .then(({ data }) => setMayoristaEnabled(data?.mayorista_enabled !== false));
  }, [businessId]);
  const {
    isCollapsed,
    isMobileOpen,
    toggleSidebar,
    closeMobileSidebar,
  } = useSidebar();
  const [cobroOpen, setCobroOpen] = useState(false);

  // Filter sections and items based on permissions + feature flags
  const visibleSections = menuSections
    .map(section => ({
      ...section,
      items: section.items.filter(item => {
        if (!item.permission || !can(item.permission)) return !item.permission;
        if (item.path === '/mayorista' && !mayoristaEnabled) return false;
        return true;
      }),
    }))
    .filter(section => section.items.length > 0);

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
        padding: framed ? (collapsed ? '1.25rem 0.5rem' : '1.25rem 1rem') : 0,
        borderBottom: framed ? '1px solid rgba(255,255,255,0.07)' : 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        gap: collapsed ? 0 : '0.75rem',
        minHeight: framed ? '68px' : 'auto',
        boxSizing: 'border-box',
        minWidth: 0,
      }}
    >
      {/* Cat logo box */}
      <div
        style={{
          width: '40px',
          height: '40px',
          borderRadius: '10px',
          background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          boxShadow: '0 4px 14px rgba(99,102,241,0.45)',
        }}
      >
        <CatIcon size={26} />
      </div>

      {!collapsed && (
        <div style={{ minWidth: 0 }}>
          <h2
            style={{
              fontSize: '1rem',
              fontWeight: 800,
              letterSpacing: '-0.025em',
              color: '#f8fafc',
              margin: 0,
              lineHeight: 1.1,
            }}
          >
            TechRepair<span style={{ color: '#818cf8' }}>Pro</span>
          </h2>
          <p
            style={{
              fontSize: '0.68rem',
              color: '#475569',
              margin: '0.1rem 0 0',
              fontWeight: 400,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            Sistema de Gestión
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
          padding: collapsed ? '0.75rem 0.5rem' : '0.75rem 0.625rem',
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {/* ── Botón COBRAR ── */}
        <button
          onClick={() => setCobroOpen(true)}
          title={collapsed ? 'Cobrar' : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            gap: collapsed ? 0 : '0.625rem',
            width: '100%',
            padding: collapsed ? '0.625rem' : '0.625rem 0.875rem',
            marginBottom: '0.75rem',
            borderRadius: '0.625rem',
            background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
            border: 'none',
            color: 'white',
            fontWeight: 700,
            fontSize: collapsed ? '1rem' : '0.875rem',
            cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(34,197,94,0.35)',
            transition: 'all 0.15s',
            boxSizing: 'border-box',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)'; e.currentTarget.style.boxShadow = '0 6px 20px rgba(34,197,94,0.45)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)'; e.currentTarget.style.boxShadow = '0 4px 14px rgba(34,197,94,0.35)' }}
        >
          <span style={{ fontSize: collapsed ? '1.1rem' : '1rem', flexShrink: 0 }}>💰</span>
          {!collapsed && <span>+ Cobrar</span>}
        </button>

        {visibleSections.map((section) => (
          <div key={section.sectionLabel}>
            {/* Section label — hidden when collapsed */}
            {!collapsed && (
              <div
                style={{
                  fontSize: '0.6rem',
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  color: '#334155',
                  padding: '0.5rem 0.5rem 0.25rem',
                  marginTop: '0.25rem',
                }}
              >
                {section.sectionLabel}
              </div>
            )}

            {section.items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={variant === 'mobile' ? closeMobileSidebar : undefined}
                title={collapsed ? item.label : undefined}
                className={item.isWhatsApp ? 'nav-whatsapp-item' : ''}
                style={({ isActive }) => ({
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  gap: collapsed ? 0 : '0.75rem',
                  width: '100%',
                  padding: collapsed ? '0.625rem' : variant === 'mobile' ? '0.625rem 0.75rem' : '0.5rem 0.75rem',
                  marginBottom: '2px',
                  borderRadius: '0.5rem',
                  color: isActive
                    ? '#fff'
                    : item.isWhatsApp
                    ? '#4ade80'
                    : '#64748b',
                  background: isActive
                    ? 'linear-gradient(135deg, rgba(99,102,241,0.28) 0%, rgba(139,92,246,0.24) 100%)'
                    : 'transparent',
                  border: isActive
                    ? '1px solid rgba(99,102,241,0.35)'
                    : '1px solid transparent',
                  textDecoration: 'none',
                  transition: 'all 0.15s ease',
                  fontWeight: isActive ? 600 : 500,
                  fontSize: variant === 'mobile' ? '0.875rem' : '0.8125rem',
                  boxSizing: 'border-box',
                  overflow: 'hidden',
                })}
              >
                <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                  {item.icon}
                </span>
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
            ))}
          </div>
        ))}
      </nav>
    );
  };

  const renderSignOut = (variant: 'desktop' | 'mobile') => {
    const collapsed = variant === 'desktop' && isCollapsed;

    return (
      <div
        style={{
          padding: collapsed ? '0.625rem 0.5rem' : '0.625rem',
          borderTop: '1px solid rgba(255,255,255,0.06)',
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
            padding: collapsed ? '0.5rem' : variant === 'mobile' ? '0.625rem 0.75rem' : '0.5rem 0.75rem',
            borderRadius: '0.5rem',
            color: '#475569',
            backgroundColor: 'transparent',
            border: '1px solid rgba(255,255,255,0.07)',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            fontWeight: 500,
            fontSize: variant === 'mobile' ? '0.875rem' : '0.8125rem',
            boxSizing: 'border-box',
            overflow: 'hidden',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.04)';
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
            e.currentTarget.style.color = '#94a3b8';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)';
            e.currentTarget.style.color = '#475569';
          }}
        >
          <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <LogoutIcon />
          </span>
          {!collapsed && <span>Cerrar Sesión</span>}
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
          backgroundColor: 'rgba(11, 18, 32, 0.98)',
          backdropFilter: 'blur(20px)',
          borderRight: '1px solid rgba(255,255,255,0.08)',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
          overflow: 'hidden',
          transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
        }}
      >
        {renderLogo(isCollapsed)}

        {/* Toggle button */}
        <div
          style={{
            padding: isCollapsed ? '0.625rem 0.5rem' : '0.625rem 0.75rem',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          <button
            onClick={toggleSidebar}
            aria-label={isCollapsed ? 'Expandir sidebar' : 'Colapsar sidebar'}
            style={{
              width: '100%',
              padding: '0.4375rem 0.75rem',
              backgroundColor: 'rgba(99,102,241,0.12)',
              border: '1px solid rgba(99,102,241,0.25)',
              borderRadius: '0.5rem',
              color: '#818cf8',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: isCollapsed ? 'center' : 'space-between',
              transition: 'all 0.18s ease',
              fontWeight: 600,
              fontSize: '0.775rem',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.18)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.12)';
            }}
          >
            {!isCollapsed && <span>Menú</span>}
            {isCollapsed ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            )}
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

      {/* Mobile sidebar */}
      <aside
        className="sidebar-mobile"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: `${mobileWidth}px`,
          maxWidth: 'calc(100vw - 24px)',
          height: '100vh',
          backgroundColor: 'rgba(11, 18, 32, 0.98)',
          backdropFilter: 'blur(20px)',
          borderRight: '1px solid rgba(255,255,255,0.08)',
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
            padding: '1.25rem 1rem',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
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
              backgroundColor: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '0.5rem',
              color: '#475569',
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

      {/* Floating button hidden — hamburger is in the Layout top header */}

      <style>{`
        .sidebar nav::-webkit-scrollbar { width: 4px; }
        .sidebar nav::-webkit-scrollbar-track { background: transparent; }
        .sidebar nav::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.2); border-radius: 4px; }
        .sidebar nav::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,0.35); }

        .sidebar nav a:not(.active):hover,
        .sidebar-mobile nav a:not(.active):hover {
          background: rgba(255,255,255,0.04) !important;
          color: #94a3b8 !important;
        }
        .sidebar nav a.nav-whatsapp-item:not(.active):hover,
        .sidebar-mobile nav a.nav-whatsapp-item:not(.active):hover {
          background: rgba(37,211,102,0.07) !important;
          color: #4ade80 !important;
        }

        @media (max-width: 1023px) {
          .sidebar {
            display: none !important;
          }
        }

        @media (min-width: 1024px) {
          .sidebar-mobile,
          .sidebar-mobile-toggle {
            display: none !important;
          }
        }
      `}</style>

      <ModalCobro isOpen={cobroOpen} onClose={() => setCobroOpen(false)} />
    </>
  );
}
