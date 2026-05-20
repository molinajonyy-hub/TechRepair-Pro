/**
 * PersonalBottomSheet — reusable mobile bottom sheet for Mi Guita.
 *
 * Uses createPortal(document.body) to escape <main webkit-overflow-scrolling:touch>
 * in PersonalLayout, which causes position:fixed to misbehave on iOS Safari.
 *
 * Layout: overlay (blurred, full-screen) > floating sheet (margins, radius 28px)
 *         > header (fixed) + content (scrollable) + footer (fixed, always visible)
 *
 * When open: adds `personal-sheet-open` class to body so the bottom nav can
 * fade out via CSS (see PersonalLayout style block).
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
    <div
      style={{
        position: 'fixed', inset: 0,
        zIndex: 300,
        background: 'rgba(0,0,0,0.62)',
        backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        // Sheet floats with air — margins lift it off screen edges and bottom
        padding: '0 0.75rem',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)',
      }}
      onClick={closeOnOverlayClick ? (e => { if (e.target === e.currentTarget) onClose() }) : undefined}
    >
      <div
        data-testid={testId}
        style={{
          width: '100%', maxWidth,
          background: '#0a1628',
          // Full radius — sheet looks like a floating card, not glued to bottom
          borderRadius: '1.75rem',
          border: '1px solid rgba(255,255,255,0.1)',
          maxHeight: 'min(86dvh, calc(100dvh - env(safe-area-inset-top, 20px) - 24px))',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 -4px 60px rgba(0,0,0,0.6), 0 0 0 0.5px rgba(255,255,255,0.06)',
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

        {/* Scrollable content
            min-height:0 is critical for iOS Safari — without it, flex items
            refuse to shrink below content size, pushing the footer off-screen */}
        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch',
          padding: '1rem 1.25rem',
        }}>
          {children}
        </div>

        {/* Footer — fixed, always visible above safe area */}
        {footer && (
          <div
            className="personal-sheet-footer"
            style={{
              flexShrink: 0, position: 'relative', zIndex: 3,
              padding: '0.875rem 1.25rem 1rem',
              borderTop: '1px solid rgba(255,255,255,0.06)',
              background: 'linear-gradient(to bottom, rgba(10,22,40,0.97) 0%, #0a1628 100%)',
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
    </div>,
    document.body
  )
}
