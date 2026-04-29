import { useEffect } from 'react'
import { X } from 'lucide-react'

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full'

interface AppModalProps {
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
  size = 'md', scrollable = true,
}: AppModalProps) {
  // Cerrar con Escape
  useEffect(() => {
    if (!isOpen) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [isOpen, onClose])

  // Bloquear scroll del body
  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  if (!isOpen) return null

  const innerStyle: React.CSSProperties = scrollable
    ? { display: 'flex', flexDirection: 'column', maxHeight: '90vh', maxWidth: SIZE_PX[size] }
    : { maxWidth: SIZE_PX[size] }

  return (
    <div
      className="modal-overlay"
      style={{ zIndex: 9999 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="modal-content-responsive"
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
              <h2 style={{ margin: 0 }}>{title}</h2>
              {subtitle && (
                <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--text-subtle)', marginTop: '0.1rem' }}>
                  {subtitle}
                </p>
              )}
            </div>
          </div>
          <button
            className="btn btn-ghost"
            onClick={onClose}
            aria-label="Cerrar"
            style={{ padding: '0.35rem', borderRadius: 'var(--radius-md)' }}
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
  )
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
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gap: '1rem',
    }}>
      {children}
    </div>
  )
}
