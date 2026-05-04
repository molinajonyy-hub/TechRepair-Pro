// ─── AppPageHeader ────────────────────────────────────────────────────────────
// Encabezado estándar de página con título, descripción y acciones.
// Reemplaza el patrón manual de .page-top + .page-title que cada página repite.

interface AppPageHeaderProps {
  /** Icono del módulo (lucide-react o SVG inline) */
  icon?: React.ReactNode
  /** Color de fondo del contenedor del icono. Default: indigo */
  iconColor?: string
  title: string
  description?: string
  /** Acciones que van a la derecha (AppButton components) */
  actions?: React.ReactNode
  /** Breadcrumb opcional arriba del título */
  breadcrumb?: React.ReactNode
  /** Contador o badge junto al título */
  badge?: React.ReactNode
}

export function AppPageHeader({
  icon, iconColor, title, description, actions, breadcrumb, badge,
}: AppPageHeaderProps) {
  const iconBg = iconColor || 'var(--accent-primary-subtle)'
  const iconBorder = 'var(--accent-primary-light)'

  return (
    <div className="page-top">
      {/* Breadcrumb */}
      {breadcrumb && (
        <div style={{ width: '100%', marginBottom: '0.25rem' }}>
          {breadcrumb}
        </div>
      )}

      {/* Título + icono */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', flex: 1 }}>
        {icon && (
          <div style={{
            width: 40, height: 40, borderRadius: 'var(--radius-lg)',
            background: iconBg, border: `1px solid ${iconBorder}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, color: 'var(--accent-primary)',
          }}>
            {icon}
          </div>
        )}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <h1 className="page-title">{title}</h1>
            {badge}
          </div>
          {description && (
            <p className="page-subtitle">{description}</p>
          )}
        </div>
      </div>

      {/* Acciones */}
      {actions && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
          {actions}
        </div>
      )}
    </div>
  )
}

// ─── AppSectionHeader ─────────────────────────────────────────────────────────

interface AppSectionHeaderProps {
  title: string
  description?: string
  actions?: React.ReactNode
  icon?: React.ReactNode
}

export function AppSectionHeader({ title, description, actions, icon }: AppSectionHeaderProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: '1rem', gap: '1rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {icon && <span style={{ color: 'var(--accent-primary)' }}>{icon}</span>}
        <div>
          <h2 style={{ margin: 0, fontSize: '1.0625rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {title}
          </h2>
          {description && (
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-subtle)' }}>
              {description}
            </p>
          )}
        </div>
      </div>
      {actions && <div style={{ display: 'flex', gap: '0.5rem' }}>{actions}</div>}
    </div>
  )
}

// ─── AppToolbar ───────────────────────────────────────────────────────────────
// Barra de filtros/búsqueda debajo del PageHeader

interface AppToolbarProps {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

export function AppToolbar({ children, className = '', style }: AppToolbarProps) {
  return (
    <div className={`filter-bar ${className}`} style={style}>
      {children}
    </div>
  )
}
