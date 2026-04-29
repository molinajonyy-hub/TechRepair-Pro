import { AppButton, type ButtonVariant } from './AppButton'

// ─── AppEmptyState ────────────────────────────────────────────────────────────

interface AppEmptyAction {
  label: string
  onClick: () => void
  icon?: React.ReactNode
  variant?: ButtonVariant
}

interface AppEmptyStateProps {
  icon?: React.ReactNode
  title?: string
  description?: string
  action?: AppEmptyAction
  /** Compacto para usar dentro de cards pequeñas */
  compact?: boolean
}

export function AppEmptyState({
  icon, title = 'Sin datos', description, action, compact = false,
}: AppEmptyStateProps) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: compact ? '2rem 1rem' : '3.5rem 1rem',
      gap: compact ? '0.75rem' : '1rem',
      textAlign: 'center',
    }}>
      {icon && (
        <div style={{
          width: compact ? 44 : 56, height: compact ? 44 : 56,
          borderRadius: 'var(--radius-lg)',
          background: 'var(--bg-tertiary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-subtle)', opacity: 0.6,
        }}>
          {icon}
        </div>
      )}
      <div>
        <p style={{
          margin: 0, fontWeight: 600,
          fontSize: compact ? '0.875rem' : '1rem',
          color: 'var(--text-secondary)',
        }}>
          {title}
        </p>
        {description && (
          <p style={{
            margin: '0.375rem 0 0', fontSize: '0.8rem',
            color: 'var(--text-subtle)', maxWidth: 340,
          }}>
            {description}
          </p>
        )}
      </div>
      {action && (
        <AppButton
          variant={action.variant || 'primary'}
          size={compact ? 'sm' : 'md'}
          leftIcon={action.icon}
          onClick={action.onClick}
          style={{ marginTop: compact ? 0 : '0.5rem' }}
        >
          {action.label}
        </AppButton>
      )}
    </div>
  )
}

// ─── AppLoadingState ──────────────────────────────────────────────────────────

interface AppLoadingStateProps {
  rows?: number
  columns?: number
  type?: 'table' | 'cards' | 'list'
}

export function AppLoadingState({ rows = 5, type = 'table' }: AppLoadingStateProps) {
  if (type === 'cards') {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '1rem' }}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="skeleton skeleton-card" style={{ height: 120 }} />
        ))}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', padding: '1rem' }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div className="skeleton skeleton-avatar" style={{ width: 32, height: 32, flexShrink: 0 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            <div className="skeleton skeleton-text" style={{ width: '60%' }} />
            <div className="skeleton skeleton-text" style={{ width: '40%' }} />
          </div>
          <div className="skeleton" style={{ width: 80, height: 24, borderRadius: 'var(--radius-full)' }} />
        </div>
      ))}
    </div>
  )
}

// ─── AppErrorState ────────────────────────────────────────────────────────────

interface AppErrorStateProps {
  message?: string
  onRetry?: () => void
}

export function AppErrorState({ message = 'No se pudieron cargar los datos.', onRetry }: AppErrorStateProps) {
  return (
    <div className="alert alert-error" style={{ margin: '1rem 0' }}>
      <span>{message}</span>
      {onRetry && (
        <AppButton variant="ghost" size="sm" onClick={onRetry} style={{ marginLeft: 'auto' }}>
          Reintentar
        </AppButton>
      )}
    </div>
  )
}
