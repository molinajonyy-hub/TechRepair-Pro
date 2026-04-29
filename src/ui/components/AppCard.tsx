// ─── AppCard ──────────────────────────────────────────────────────────────────

interface AppCardProps {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
  onClick?: () => void
  interactive?: boolean
  accent?: boolean
  padding?: 'none' | 'sm' | 'md' | 'lg'
}

const PADDING_MAP = { none: 0, sm: '0.75rem', md: '1.25rem', lg: '1.75rem' }

export function AppCard({
  children, className = '', style, onClick, interactive = false, accent = false, padding = 'md',
}: AppCardProps) {
  const cls = [
    'card',
    interactive || onClick ? 'card-interactive' : '',
    accent ? 'card-accent' : '',
    className,
  ].filter(Boolean).join(' ')

  return (
    <div
      className={cls}
      style={{ padding: PADDING_MAP[padding], cursor: onClick ? 'pointer' : undefined, ...style }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {children}
    </div>
  )
}

// ─── AppStatCard ───────────────────────────────────────────────────────────────

interface AppStatCardProps {
  label: string
  value: string | number
  icon?: React.ReactNode
  color?: string       // CSS variable or hex
  trend?: { value: string; up: boolean }
  onClick?: () => void
  active?: boolean
}

export function AppStatCard({ label, value, icon, color, trend, onClick, active }: AppStatCardProps) {
  const accentColor = color || 'var(--accent-primary)'
  return (
    <div
      className={`stat-card ${onClick ? 'card-interactive' : ''}`}
      onClick={onClick}
      style={{
        cursor: onClick ? 'pointer' : undefined,
        border: active ? `1px solid ${accentColor}30` : undefined,
        background: active ? `${accentColor}08` : undefined,
      }}
    >
      {icon && (
        <div style={{
          width: 36, height: 36, borderRadius: 'var(--radius-md)',
          background: `${accentColor}15`, display: 'flex',
          alignItems: 'center', justifyContent: 'center', color: accentColor,
        }}>
          {icon}
        </div>
      )}
      <div>
        <div className="stat-card-label">{label}</div>
        <div className="stat-card-value" style={{ color: accentColor }}>{value}</div>
      </div>
      {trend && (
        <div style={{
          fontSize: '0.75rem', fontWeight: 600,
          color: trend.up ? 'var(--success)' : 'var(--error)',
        }}>
          {trend.up ? '↑' : '↓'} {trend.value}
        </div>
      )}
    </div>
  )
}
