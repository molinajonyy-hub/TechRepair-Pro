// ─── AppTabs ──────────────────────────────────────────────────────────────────

export interface TabItem {
  key: string
  label: string
  icon?: React.ReactNode
  badge?: string | number
  disabled?: boolean
}

interface AppTabsProps {
  tabs: TabItem[]
  activeTab: string
  onChange: (key: string) => void
  className?: string
}

export function AppTabs({ tabs, activeTab, onChange, className = '' }: AppTabsProps) {
  return (
    <div className={`tabs ${className}`} role="tablist">
      {tabs.map(tab => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={activeTab === tab.key}
          className={`tab ${activeTab === tab.key ? 'tab-active' : ''}`}
          onClick={() => !tab.disabled && onChange(tab.key)}
          disabled={tab.disabled}
          style={tab.disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
        >
          {tab.icon}
          {tab.label}
          {tab.badge !== undefined && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              minWidth: 18, height: 18, padding: '0 0.3rem',
              borderRadius: 'var(--radius-full)',
              fontSize: '0.62rem', fontWeight: 700,
              background: activeTab === tab.key ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
              color: activeTab === tab.key ? '#fff' : 'var(--text-subtle)',
            }}>
              {tab.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
