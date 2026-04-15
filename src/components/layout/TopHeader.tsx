import { Search } from 'lucide-react'
import { NotificationsDropdown } from './NotificationsDropdown'

export function TopHeader() {
  return (
    <header
      className="top-header"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: '0.85rem 1rem',
        marginBottom: '1.5rem',
        background: 'var(--bg-header)',
        border: '1px solid var(--border-color)',
        borderRadius: '1rem',
        boxShadow: 'var(--shadow-sm)',
        backdropFilter: 'blur(18px)',
      }}
    >
      {/* Right Section */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '1rem'
      }}>
        {/* Search */}
        <div style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center'
        }}>
          <Search size={18} style={{
            position: 'absolute',
            left: '0.75rem',
            color: 'var(--text-muted)'
          }} />
          <input
            type="text"
            placeholder="Buscar..."
            style={{
              backgroundColor: 'var(--input-bg)',
              border: '1px solid var(--input-border)',
              borderRadius: '0.75rem',
              padding: '0.625rem 0.875rem 0.625rem 2.5rem',
              color: 'var(--text-primary)',
              fontSize: '0.875rem',
              width: '240px',
              outline: 'none',
              boxShadow: 'var(--shadow-sm)',
            }}
            onFocus={(event) => {
              event.currentTarget.style.borderColor = 'var(--input-focus-border)';
              event.currentTarget.style.boxShadow = '0 0 0 3px var(--accent-primary-light)';
            }}
            onBlur={(event) => {
              event.currentTarget.style.borderColor = 'var(--input-border)';
              event.currentTarget.style.boxShadow = 'var(--shadow-sm)';
            }}
          />
        </div>

        {/* Notifications Dropdown */}
        <NotificationsDropdown />
      </div>
    </header>
  )
}
