import { GlobalSearch } from './GlobalSearch'
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
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '1rem'
      }}>
        <GlobalSearch />
        <NotificationsDropdown />
      </div>
    </header>
  )
}
