import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface OverflowMenuAction {
  label: string
  onSelect: () => void
  icon?: ReactNode
  destructive?: boolean
  disabled?: boolean
}

export interface OverflowMenuProps {
  label: string
  actions: OverflowMenuAction[]
  className?: string
}

export function OverflowMenu({ label, actions, className = '' }: OverflowMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    firstItemRef.current?.focus()
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className={`overflow-menu ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className="overflow-menu__trigger mobile-touch-target"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <MoreHorizontal aria-hidden="true" />
      </button>

      {open && (
        <div className="overflow-menu__popover" role="menu" aria-label={label}>
          {actions.map((action, index) => (
            <button
              key={action.label}
              ref={index === 0 ? firstItemRef : undefined}
              type="button"
              role="menuitem"
              className={`overflow-menu__action${action.destructive ? ' is-destructive' : ''}`}
              disabled={action.disabled}
              onClick={() => {
                action.onSelect()
                setOpen(false)
                triggerRef.current?.focus()
              }}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
