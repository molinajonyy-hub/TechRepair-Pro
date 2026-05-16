import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
  compact?: boolean
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, compact, className }: EmptyStateProps) {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: compact ? '2rem 1.5rem' : '4rem 2rem',
        textAlign: 'center',
        gap: '0.75rem',
        color: 'var(--text-subtle)',
        animation: 'tr-fade-in 220ms ease both',
      }}
    >
      {Icon && (
        <div style={{
          width: compact ? '2.75rem' : '3.5rem',
          height: compact ? '2.75rem' : '3.5rem',
          borderRadius: '0.875rem',
          background: 'var(--accent-primary-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '0.25rem',
        }}>
          <Icon size={compact ? 18 : 22} color="var(--accent-primary)" />
        </div>
      )}
      <div style={{
        fontSize: compact ? '0.9375rem' : '1rem',
        fontWeight: 700,
        color: 'var(--text-secondary)',
        lineHeight: 1.3,
      }}>
        {title}
      </div>
      {description && (
        <div style={{
          fontSize: '0.875rem',
          color: 'var(--text-subtle)',
          maxWidth: '320px',
          lineHeight: 1.5,
        }}>
          {description}
        </div>
      )}
      {action && (
        <button
          onClick={action.onClick}
          style={{
            marginTop: '0.25rem',
            padding: '0.5rem 1.25rem',
            background: 'var(--accent-primary-subtle)',
            border: '1px solid rgba(99,102,241,0.3)',
            borderRadius: '0.625rem',
            color: 'var(--accent-primary)',
            fontSize: '0.875rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 120ms ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.2)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.5)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--accent-primary-subtle)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.3)' }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
