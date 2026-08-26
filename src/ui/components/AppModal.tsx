import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { zIndex } from '../../lib/tokens'
import { useKeyboardAwareBottomOffset } from '../../hooks/useKeyboardAwareBottomOffset'

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full'
export type ResponsiveDialogMode = 'centered' | 'sheet' | 'fullscreen'

export interface AppModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  subtitle?: string
  icon?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  size?: ModalSize
  /** Si true, el body es scrolleable y el header/footer son sticky */
  scrollable?: boolean
  /** Composición usada sólo bajo el breakpoint mobile. Desktop no cambia. */
  mobilePresentation?: ResponsiveDialogMode
  closeOnBackdrop?: boolean
}

const SIZE_PX: Record<ModalSize, string> = {
  sm:   '420px',
  md:   '600px',
  lg:   '780px',
  xl:   '960px',
  full: '1100px',
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function AppModal({
  isOpen, onClose, title, subtitle, icon, children, footer,
  size = 'md', scrollable = true, mobilePresentation = 'sheet', closeOnBackdrop = true,
}: AppModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const subtitleId = useId()
  const keyboardOffset = useKeyboardAwareBottomOffset(isOpen)

  // Escape, focus trap y restauración de foco.
  useEffect(() => {
    if (!isOpen) return

    const previouslyFocused = document.activeElement as HTMLElement | null
    const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusFirst = window.requestAnimationFrame(() => closeRef.current?.focus())

    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector))
        .filter(element => element.offsetParent !== null || element === document.activeElement)
      if (focusable.length === 0) {
        e.preventDefault()
        dialogRef.current.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', h)
    return () => {
      window.cancelAnimationFrame(focusFirst)
      document.removeEventListener('keydown', h)
      previouslyFocused?.focus()
    }
  }, [isOpen, onClose])

  // Bloquear scroll del body
  useEffect(() => {
    if (!isOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.body.classList.add('app-modal-open')
    return () => {
      document.body.style.overflow = previousOverflow
      document.body.classList.remove('app-modal-open')
    }
  }, [isOpen])

  if (!isOpen) return null

  const innerStyle: React.CSSProperties = scrollable
    ? { display: 'flex', flexDirection: 'column', maxHeight: '90dvh', maxWidth: SIZE_PX[size] }
    : { maxWidth: SIZE_PX[size] }

  return createPortal((
    <div
      className={`modal-overlay modal-overlay--${mobilePresentation}`}
      data-mobile-presentation={mobilePresentation}
      style={{
        zIndex: zIndex.modal,
        '--mobile-keyboard-offset': `${keyboardOffset}px`,
      } as React.CSSProperties}
      onClick={e => { if (closeOnBackdrop && e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={dialogRef}
        className="modal-content-responsive"
        data-testid="responsive-dialog"
        data-mobile-presentation={mobilePresentation}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        style={innerStyle}
      >
        {/* Header sticky */}
        <div className="modal-header" style={{ flexShrink: 0, borderRadius: 'var(--radius-xl) var(--radius-xl) 0 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {icon && (
              <div style={{
                width: 36, height: 36, borderRadius: 'var(--radius-md)',
                background: 'var(--accent-primary-subtle)', border: '1px solid var(--accent-primary-light)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                color: 'var(--accent-primary)',
              }}>
                {icon}
              </div>
            )}
            <div>
              <h2 id={titleId} style={{ margin: 0 }}>{title}</h2>
              {subtitle && (
                <p id={subtitleId} style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--text-subtle)', marginTop: '0.1rem' }}>
                  {subtitle}
                </p>
              )}
            </div>
          </div>
          <button
            ref={closeRef}
            className="btn btn-ghost"
            onClick={onClose}
            aria-label="Cerrar"
            style={{ padding: '0.35rem', borderRadius: 'var(--radius-md)', minWidth: 44, minHeight: 44 }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body scrolleable */}
        <div
          className="modal-body"
          style={scrollable ? { flex: 1, overflowY: 'auto' } : undefined}
        >
          {children}
        </div>

        {/* Footer sticky */}
        {footer && (
          <div
            className="modal-footer"
            style={{
              flexShrink: 0,
              borderRadius: '0 0 var(--radius-xl) var(--radius-xl)',
              background: 'var(--bg-modal)',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  ), document.body)
}

// ─── Sub-componentes helper ───────────────────────────────────────────────────

/** Sección dentro del modal-body con separación visual */
export function ModalSection({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {title && (
        <p style={{
          margin: 0, fontSize: '0.72rem', fontWeight: 700,
          color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em',
          paddingBottom: '0.5rem', borderBottom: '1px solid var(--border-subtle)',
        }}>
          {title}
        </p>
      )}
      {children}
    </div>
  )
}

/** Grid de 2 columnas para campos de formulario */
export function FormGrid({ children, cols = 2 }: { children: React.ReactNode; cols?: 2 | 3 | 4 }) {
  return (
    <div
      className="form-grid-responsive"
      style={{ '--form-grid-columns': cols } as React.CSSProperties}
    >
      {children}
    </div>
  )
}

/** Nombre canónico nuevo; AppModal se conserva por compatibilidad. */
export const ResponsiveDialog = AppModal
