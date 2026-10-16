// ─── AppPageHeader ────────────────────────────────────────────────────────────
// BETA-UX-2 — EL encabezado de página. Un solo patrón para todas las pantallas
// internas: ícono del módulo, título, subtítulo y acciones.
//
// Emite la familia de clases `.page-hdr*` (la de Órdenes de Trabajo, la
// referencia visual del lote). Las pantallas que todavía escriben ese marcado a
// mano se ven idénticas porque comparten las mismas reglas de index.css
// («BETA-UX-2 · Encabezado de página»); migrarlas a este componente no cambia
// un píxel. Antes este componente pintaba otra cosa (`.page-top`, ícono de 40px
// con estilos en línea) y había tres encabezados distintos en la app.
//
// Las medidas (caja del ícono, glifo, tipografía, separación con el contenido)
// las deciden los tokens `--page-header-*` del CSS, no cada pantalla: el tamaño
// del ícono que se le pase acá se normaliza.

/**
 * Tono semántico del ícono. Índigo es la identidad de gestión; los demás sólo
 * cuando el módulo ES ese significado (caja/garantías = éxito, gastos = egreso).
 */
export type PageHeaderTone = 'accent' | 'success' | 'warning' | 'danger' | 'info'

interface AppPageHeaderProps {
  /** Icono del módulo (lucide-react o SVG inline). Es decorativo: el título nombra la pantalla. */
  icon?: React.ReactNode
  /** Tono del ícono. Default: índigo (`accent`). */
  tone?: PageHeaderTone
  title: string
  description?: React.ReactNode
  /** `data-testid` del subtítulo, para las pantallas que lo usan como estado. */
  descriptionTestId?: string
  /** Acciones que van a la derecha (AppButton size="page"). */
  actions?: React.ReactNode
  /**
   * Clase extra para el contenedor de `actions` (`.page-hdr-right`). Permite
   * que una pantalla recomponga sus acciones en mobile desde el CSS, cosa que
   * un `style` en línea no deja pisar.
   */
  actionsClassName?: string
  /** Breadcrumb opcional arriba del título */
  breadcrumb?: React.ReactNode
  /** Contador o badge junto al título */
  badge?: React.ReactNode
  /** Clase extra para el contenedor (`.page-hdr`). */
  className?: string
}

const TONE_CLASS: Record<PageHeaderTone, string> = {
  accent: '',
  success: 'page-hdr-icon--success',
  warning: 'page-hdr-icon--warning',
  danger: 'page-hdr-icon--danger',
  info: 'page-hdr-icon--info',
}

export function AppPageHeader({
  icon, tone = 'accent', title, description, descriptionTestId, actions, actionsClassName,
  breadcrumb, badge, className,
}: AppPageHeaderProps) {
  return (
    <div className={['page-hdr', className].filter(Boolean).join(' ')}>
      {breadcrumb && <div className="page-hdr-breadcrumb">{breadcrumb}</div>}

      <div className="page-hdr-left">
        {icon && (
          <div className={['page-hdr-icon', TONE_CLASS[tone]].filter(Boolean).join(' ')} aria-hidden="true">
            {icon}
          </div>
        )}
        <div className="page-hdr-text">
          <div className="page-hdr-heading">
            <h1 className="page-hdr-title">{title}</h1>
            {badge}
          </div>
          {description && (
            <p className="page-hdr-subtitle" data-testid={descriptionTestId}>{description}</p>
          )}
        </div>
      </div>

      {actions && (
        <div className={['page-hdr-right', actionsClassName].filter(Boolean).join(' ')}>
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
