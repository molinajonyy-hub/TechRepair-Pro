/**
 * PersonalBottomSheet — reusable mobile bottom sheet for Mi Guita.
 *
 * The overlay and the sheet are TWO separate fixed elements so the
 * bottom gap is explicit and guaranteed on iOS Safari.  Using a single
 * flex container with align-items:flex-end causes the sheet to still
 * look "glued to the floor" when content fills the max-height.
 *
 * Overlay: full-screen dim + blur (z-index 300)
 * Sheet:   position:fixed with explicit left/right/bottom (z-index 301)
 *          → bottom = safe-area-inset-bottom + 18 px of real air
 */
import { type ReactNode, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export interface PersonalBottomSheetProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  /** Rendered in a fixed footer — put submit buttons here, never inside children */
  footer?: ReactNode
  maxWidth?: number
  closeOnOverlayClick?: boolean
  testId?: string
}

export function PersonalBottomSheet({
  open,
  title,
  onClose,
  children,
  footer,
  maxWidth = 480,
  closeOnOverlayClick = true,
  testId,
}: PersonalBottomSheetProps) {
  // Lock body scroll + signal sheet is open (for bottom nav CSS fade)
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.body.classList.add('personal-sheet-open')
    return () => {
      document.body.style.overflow = prev
      document.body.classList.remove('personal-sheet-open')
    }
  }, [open])

  // Escape key closes
  useEffect(() => {
    if (!open) return
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <>
      {/* ── Dim overlay — separate element so sheet z-index is independent ── */}
      <div
        style={{
          position: 'fixed', inset: 0,
          zIndex: 300,
          background: 'rgba(0,0,0,0.62)',
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
        }}
        onClick={closeOnOverlayClick ? onClose : undefined}
      />

      {/* ── Sheet — explicit bottom so the gap is always real ── */}
      <div
        data-testid={testId}
        style={{
          position: 'fixed',
          // 12 px lateral gap on each side
          left: 12,
          right: 12,
          // Guaranteed air between sheet bottom and home indicator / screen edge
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)',
          zIndex: 301,
          // Center within the lateral gap up to maxWidth
          maxWidth,
          marginLeft: 'auto',
          marginRight: 'auto',
          // Leaves room above for safe-area top + some air
          maxHeight: 'min(82dvh, calc(100dvh - env(safe-area-inset-top, 20px) - env(safe-area-inset-bottom, 0px) - 48px))',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: '1.75rem',
          background: '#0b1626',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.06)',
        }}
      >
        {/* Header — fixed, never scrolls */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1.25rem 1.25rem 0.875rem',
          flexShrink: 0, position: 'relative', zIndex: 2,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}>
          <span style={{ fontWeight: 800, fontSize: '1.0625rem', color: '#f0f4ff' }}>{title}</span>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            style={{
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '50%', cursor: 'pointer', color: '#94a3b8',
              display: 'flex', width: 32, height: 32, alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable content — min-height:0 critical for iOS flex shrink */}
        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch',
          padding: '1rem 1.25rem',
        }}>
          {children}
        </div>

        {/* Footer — always visible, no extra safe-area (sheet already floats above it) */}
        {footer && (
          <div
            className="personal-sheet-footer"
            style={{
              flexShrink: 0, position: 'relative', zIndex: 3,
              padding: '0.875rem 1.25rem 1rem',
              borderTop: '1px solid rgba(255,255,255,0.06)',
              background: 'linear-gradient(to bottom, rgba(11,22,38,0.97) 0%, #0b1626 100%)',
              boxShadow: '0 -1px 0 rgba(255,255,255,0.04)',
            }}
          >
            <style>{`
              .personal-sheet-footer > button {
                min-height: 52px !important;
                border-radius: 18px !important;
                font-size: 1rem !important;
                font-weight: 700 !important;
                width: 100%;
              }
            `}</style>
            {footer}
          </div>
        )}
      </div>
    </>,
    document.body
  )
}
