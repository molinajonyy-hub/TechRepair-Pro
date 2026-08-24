import { useState, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useSidebar } from '../../hooks/useSidebar';
import { usePermissions } from '../../hooks/usePermissions';
import { useSubscription } from '../../hooks/useSubscription';
import { useSystemOwner } from '../../hooks/useSystemOwner';
import { useWholesalePermissions } from '../../hooks/useWholesalePermissions';
import { PermissionKey } from '../../config/permissions';
import { supabase } from '../../lib/supabase';
import logoSvg from '../../assets/logo.svg';

// El ícono de WhatsApp vivía acá, para el item de navegación a /whatsapp. Ese
// item se retiró (ver `menuSections`); el ícono se va con él porque
// `noUnusedLocals` lo rechazaría. La ruta y la pantalla siguen existiendo.

// ── Inline SVG icons (more specific, from design) ──
const CuentasIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="2" y="5" width="20" height="14" rx="2"/>
    <path d="M2 10h20"/><path d="M6 15h4"/><path d="M14 15h4"/>
  </svg>
);
const TareasIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M9 11l3 3L22 4"/><rect x="2" y="3" width="20" height="18" rx="2"/>
    <path d="M2 9h20"/>
  </svg>
);
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
const PortalAdminIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
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
const DashFinIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="3" y="14" width="7" height="3" rx="1"/><rect x="3" y="19" width="7" height="2" rx="1"/>
    <polyline points="14 17 17 20 22 14"/>
  </svg>
);
const MiGuitaIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/>
    <path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/>
    <path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>
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
const AdminSubsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
  </svg>
);
const AdminLeadsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
    <polyline points="22,6 12,13 2,6"/>
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
  /** If true, this item is hidden unless wholesale_portal_enabled=true */
  portalAdmin?: boolean;
  /** If true, gated by canViewWholesale (los 7 roles + feature mayorista + acceso). */
  wholesaleView?: boolean;
  /** If true, gated by canManageClicPortal (owner REAL del negocio + portal habilitado). */
  clicPortalManage?: boolean;
  /** If set, this item is hidden unless the active plan has this feature */
  planFeature?: import('../../config/planFeatures').PlanFeature;
  /** If true, this item is only visible to System Owners (system_admins.user_id = auth.uid()) */
  systemOwnerOnly?: boolean;
  /**
   * P0-P6 — Si true, un System Owner ve el item aunque no tenga la `permission`.
   *
   * Es la escotilla para Mi Guita durante la beta: cerrado para los 7 roles del
   * negocio, pero disponible para los usuarios internos, que se identifican
   * server-side por `system_admins` y no por nada configurable del tenant.
   */
  systemOwnerAlso?: boolean;
};
type NavSection = {
  sectionLabel: string;
  items: NavItem[];
};

const menuSections: NavSection[] = [
  {
    sectionLabel: 'Principal',
    items: [
      { path: '/dashboard',   label: 'Inicio',        icon: <DashboardIcon /> },
      { path: '/orders',      label: 'Ordenes',        icon: <OrdersIcon />,       permission: 'orders' },
      { path: '/comprobantes',label: 'Comprobantes',   icon: <ComprobantesIcon />, permission: 'comprobantes' },
      { path: '/warranties',  label: 'Garantías',      icon: <WarrantyIcon />,     permission: 'orders' },
      { path: '/tasks',       label: 'Tareas',         icon: <TareasIcon />,       planFeature: 'tasks' },
      // El item '/whatsapp' se retiró de la navegación: esa pantalla es la del
      // módulo Cloud API (conexión con Meta, automatizaciones), que en el flujo
      // W1 Standard no se usa y confundía. La RUTA, la pantalla y todo el código
      // de Cloud API siguen existiendo — esto es sólo navegación.
      // Las plantillas Standard se editan en Configuración → WhatsApp.
    ],
  },
  {
    sectionLabel: 'Clientes & Stock',
    items: [
      { path: '/customers',  label: 'Clientes',      icon: <ClientesIcon />,    permission: 'customers' },
      { path: '/cuentas',    label: 'Cuentas Ctes.', icon: <CuentasIcon />,     permission: 'customers', planFeature: 'currentAccounts' },
      { path: '/inventory',  label: 'Inventario',    icon: <InventarioIcon />,  permission: 'inventory' },
      { path: '/mayorista',  label: 'Mayorista',     icon: <MayoristaIcon />,   wholesaleView: true },
      { path: '/portal-clic',label: 'Portal Clic',   icon: <PortalAdminIcon />, clicPortalManage: true },
      { path: '/suppliers',  label: 'Proveedores',   icon: <ProveedoresIcon />, permission: 'inventory' },
      { path: '/offers',     label: 'Ofertas',       icon: <OfertasIcon />,     permission: 'inventory' },
    ],
  },
  {
    sectionLabel: 'Finanzas',
    items: [
      { path: '/expenses', label: 'Gastos',    icon: <GastosIcon />,   permission: 'finance' },
      { path: '/caja',     label: 'Caja',      icon: <CajaIcon />,     permission: 'finance' },
      { path: '/finance', label: 'Finanzas', icon: <DashFinIcon />, permission: 'finance', planFeature: 'advancedFinance' },
      { path: '/reports',        label: 'Reportes',  icon: <ReportesIcon />,  permission: 'reports', planFeature: 'reports' },
      // P0-P6: Mi Guita queda cerrado para la beta. `personal_finance` es
      // `false` para los 7 roles (incluido owner) y NO es configurable desde la
      // matriz de permisos: el acceso interno se resuelve por `system_admins`.
      // Antes este item no declaraba ningún gate, así que lo veía todo el mundo.
      { path: '/mi-guita', label: 'Mi Guita',  icon: <MiGuitaIcon />, permission: 'personal_finance', systemOwnerAlso: true },
    ],
  },
  {
    sectionLabel: 'Administración',
    items: [
      { path: '/users',             label: 'Usuarios',      icon: <UsuariosIcon />,  permission: 'users' },
      { path: '/settings',          label: 'Configuración', icon: <ConfigIcon />,    permission: 'settings' },
      { path: '/currency-settings', label: 'Moneda',        icon: <MonedaIcon />,    permission: 'settings' },
      { path: '/subscription',      label: 'Suscripción',   icon: <SuscripcionIcon />, permission: 'subscription' },
      { path: '/tutorials',         label: 'Tutoriales',    icon: <TutorialesIcon /> },
    ],
  },
  {
    sectionLabel: 'SaaS Admin',
    items: [
      { path: '/admin/subscriptions', label: 'Suscripciones', icon: <AdminSubsIcon />,  systemOwnerOnly: true },
      { path: '/admin/leads',         label: 'Leads',          icon: <AdminLeadsIcon />, systemOwnerOnly: true },
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
  const { hasFeature } = useSubscription();
  const { isSystemOwner } = useSystemOwner();
  const wholesale = useWholesalePermissions();
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

  // Filter sections and items based on permissions + feature flags
  const visibleSections = menuSections
    .map(section => ({
      ...section,
      items: section.items.filter(item => {
        // ── P0-P6 ────────────────────────────────────────────────────────────
        // Este filtro tenía un `return` temprano que anulaba los dos gates de
        // abajo:
        //
        //     if (!item.permission || !can(item.permission)) return !item.permission
        //
        // Para cualquier item SIN `permission` eso devolvía `true` de inmediato,
        // así que `planFeature` y `systemOwnerOnly` NUNCA se evaluaban. Como
        // `/admin/subscriptions` y `/admin/leads` declaran sólo
        // `systemOwnerOnly`, y `/mi-guita` no declaraba nada, la sección
        // SaaS Admin y Mi Guita eran visibles para CUALQUIER usuario —incluido
        // un técnico invitado—. Ése fue el incidente que disparó el lote.
        //
        // Ahora cada gate se evalúa por separado y todos tienen que pasar.
        // El orden es irrelevante a propósito: son condiciones AND, no una
        // cadena de precedencia.

        // SaaS Admin: privilegio del SaaS, NUNCA del negocio. No depende del
        // rol, del plan ni de ningún permiso configurable del tenant.
        if (item.systemOwnerOnly && !isSystemOwner) return false;

        // Mayorista: hacen falta las TRES cosas. Que el negocio tenga la
        // feature (plan Full) no alcanza — antes un técnico lo veía sólo por
        // eso.
        if (item.wholesaleView) {
          return wholesale.canView && mayoristaEnabled && can('wholesale');
        }

        // Portal Clic: SOLO el owner real con el portal habilitado.
        if (item.clicPortalManage) return wholesale.canManageClicPortal;

        // `systemOwnerAlso`: el interno del SaaS pasa aunque el tenant no le dé
        // la capacidad. Va antes del chequeo de permiso, no en lugar de él.
        if (item.permission && !can(item.permission)) {
          if (!(item.systemOwnerAlso && isSystemOwner)) return false;
        }
        if (item.planFeature && !hasFeature(item.planFeature)) return false;
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
        borderBottom: framed ? '1px solid var(--border-color)' : 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        gap: collapsed ? 0 : '0.75rem',
        minHeight: framed ? '68px' : 'auto',
        boxSizing: 'border-box',
        minWidth: 0,
      }}
    >
      {/* Logo original */}
      <img
        src={logoSvg}
        alt="TechRepair Pro"
        style={{
          width: '40px',
          height: '40px',
          borderRadius: '10px',
          flexShrink: 0,
          boxShadow: '0 4px 14px rgba(99,102,241,0.45)',
        }}
      />

      {!collapsed && (
        <div style={{ minWidth: 0 }}>
          <h2
            style={{
              fontSize: '1rem',
              fontWeight: 800,
              letterSpacing: '-0.025em',
              color: 'var(--text-primary)',
              margin: 0,
              lineHeight: 1.1,
            }}
          >
            TechRepair<span style={{ color: 'var(--color-primary-light)' }}>Pro</span>
          </h2>
          <p
            style={{
              fontSize: '0.68rem',
              color: 'var(--nav-section-label)',
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
                  color: 'var(--nav-section-label)',
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
                    ? 'var(--nav-active-text)'
                    : item.isWhatsApp
                    ? 'var(--nav-whatsapp)'
                    : 'var(--nav-item-text)',
                  background: isActive
                    ? 'var(--nav-active-bg)'
                    : 'transparent',
                  border: isActive
                    ? '1px solid var(--nav-active-border)'
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
            padding: collapsed ? '0.5rem' : variant === 'mobile' ? '0.625rem 0.75rem' : '0.5rem 0.75rem',
            borderRadius: '0.5rem',
            color: 'var(--nav-item-text)',
            backgroundColor: 'transparent',
            border: '1px solid var(--border-color)',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            fontWeight: 500,
            fontSize: variant === 'mobile' ? '0.875rem' : '0.8125rem',
            boxSizing: 'border-box',
            overflow: 'hidden',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--nav-hover-bg)';
            e.currentTarget.style.borderColor = 'var(--border-strong)';
            e.currentTarget.style.color = 'var(--nav-item-text-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.borderColor = 'var(--border-color)';
            e.currentTarget.style.color = 'var(--nav-item-text)';
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
          backgroundColor: 'var(--bg-sidebar-overlay)',
          backdropFilter: 'blur(20px)',
          borderRight: '1px solid var(--border-color)',
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
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <button
            onClick={toggleSidebar}
            aria-label={isCollapsed ? 'Expandir sidebar' : 'Colapsar sidebar'}
            style={{
              width: '100%',
              padding: '0.4375rem 0.75rem',
              backgroundColor: 'var(--accent-primary-subtle)',
              border: '1px solid var(--border-accent)',
              borderRadius: '0.5rem',
              color: 'var(--color-primary-light)',
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
              e.currentTarget.style.backgroundColor = 'var(--accent-primary-light)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--accent-primary-subtle)';
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
          backgroundColor: 'var(--bg-sidebar-overlay)',
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
            padding: '1.25rem 1rem',
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
              backgroundColor: 'var(--nav-hover-bg)',
              border: '1px solid var(--border-color)',
              borderRadius: '0.5rem',
              color: 'var(--nav-item-text)',
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
          background: var(--nav-hover-bg) !important;
          color: var(--nav-item-text-hover) !important;
        }
        .sidebar nav a.nav-whatsapp-item:not(.active):hover,
        .sidebar-mobile nav a.nav-whatsapp-item:not(.active):hover {
          background: var(--nav-whatsapp-bg) !important;
          color: var(--nav-whatsapp) !important;
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

    </>
  );
}
