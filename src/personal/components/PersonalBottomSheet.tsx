/**
 * PersonalBottomSheet — reusable mobile bottom sheet for Mi Guita.
 *
 * Uses createPortal to render into document.body, bypassing the
 * <main webkit-overflow-scrolling:touch> container in PersonalLayout
 * that causes position:fixed to misbehave on iOS Safari.
 *
 * Structure: overlay > sheet > [header (fixed)] + [content (scrollable)] + [footer (fixed)]
 * The footer always stays visible regardless of content height or keyboard state.
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
  // Prevent background scroll while open
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Escape key closes the sheet
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
        // 300 > bottom nav (100) and any other z-index in PersonalLayout
        zIndex: 300,
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
      onClick={closeOnOverlayClick ? (e => { if (e.target === e.currentTarget) onClose() }) : undefined}
    >
      <div
        data-testid={testId}
        style={{
          width: '100%', maxWidth,
          background: '#0a1628',
          borderRadius: '1.5rem 1.5rem 0 0',
          border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none',
          // Leave room for iOS status bar at top
          maxHeight: 'calc(100dvh - env(safe-area-inset-top, 20px) - 12px)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.5)',
        }}
      >
        {/* Header — always visible, never scrolls */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1.25rem 1.25rem 0.875rem',
          flexShrink: 0, position: 'relative', zIndex: 2,
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}>
          <span style={{ fontWeight: 800, fontSize: '1rem', color: '#f0f4ff' }}>{title}</span>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            style={{
              background: 'none', border: 'none', cursor: 'pointer', color: '#475569',
              display: 'flex', minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable content
            min-height:0 is critical for iOS Safari — without it, flex items refuse
            to shrink below their content size, pushing the footer off-screen */}
        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch',
          padding: '1rem 1.25rem',
        }}>
          {children}
        </div>

        {/* Footer — always visible, always above safe area and bottom nav */}
        {footer && (
          <div style={{
            flexShrink: 0, position: 'relative', zIndex: 3,
            padding: '1rem 1.25rem',
            paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
            borderTop: '1px solid rgba(255,255,255,0.05)',
            background: '#0a1628',
            boxShadow: '0 -4px 16px rgba(0,0,0,0.2)',
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
