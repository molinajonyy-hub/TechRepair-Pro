import type { KeyboardEvent, ReactNode } from 'react'

export interface CompactListItem {
  id: string
  primary: ReactNode
  secondary?: ReactNode
  metadata?: ReactNode
  amount?: ReactNode
  status?: ReactNode
  trailingAction?: ReactNode
  onSelect?: () => void
  accessibleLabel?: string
}

export interface CompactListProps {
  items: CompactListItem[]
  emptyState?: ReactNode
  label?: string
  className?: string
}

export function CompactList({
  items,
  emptyState,
  label = 'Listado',
  className = '',
}: CompactListProps) {
  if (items.length === 0) return <>{emptyState ?? null}</>

  const activateFromKeyboard = (event: KeyboardEvent<HTMLDivElement>, onSelect?: () => void) => {
    if (!onSelect || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onSelect()
  }

  return (
    <ul className={`compact-list ${className}`.trim()} aria-label={label}>
      {items.map(item => (
        <li key={item.id} className="compact-list__item">
          <div
            className={`compact-list__content${item.onSelect ? ' is-interactive' : ''}`}
            role={item.onSelect ? 'link' : undefined}
            tabIndex={item.onSelect ? 0 : undefined}
            aria-label={item.onSelect ? item.accessibleLabel : undefined}
            onClick={item.onSelect}
            onKeyDown={event => activateFromKeyboard(event, item.onSelect)}
          >
            <div className="compact-list__copy">
              <div className="compact-list__primary">{item.primary}</div>
              {item.secondary && <div className="compact-list__secondary">{item.secondary}</div>}
              {item.metadata && <div className="compact-list__metadata">{item.metadata}</div>}
            </div>
            {(item.amount || item.status) && (
              <div className="compact-list__summary">
                {item.amount && <div className="compact-list__amount">{item.amount}</div>}
                {item.status && <div className="compact-list__status">{item.status}</div>}
              </div>
            )}
          </div>
          {item.trailingAction && <div className="compact-list__trailing">{item.trailingAction}</div>}
        </li>
      ))}
    </ul>
  )
}
