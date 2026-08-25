import type { ReactNode } from 'react'
import { useKeyboardAwareBottomOffset } from '../../hooks/useKeyboardAwareBottomOffset'

export interface MobileActionBarProps {
  primaryAction: ReactNode
  secondaryAction?: ReactNode
  label?: string
  className?: string
}

/**
 * Footer mobile para una acción primaria y, opcionalmente, una secundaria.
 * Usa max(nav, teclado): nunca suma safe-area y teclado dos veces.
 */
export function MobileActionBar({
  primaryAction,
  secondaryAction,
  label = 'Acciones del formulario',
  className = '',
}: MobileActionBarProps) {
  const keyboardOffset = useKeyboardAwareBottomOffset()

  return (
    <>
      <div className="mobile-action-bar__spacer" aria-hidden="true" />
      <div
        className={`mobile-action-bar ${className}`.trim()}
        data-testid="mobile-action-bar"
        aria-label={label}
        style={{ '--mobile-keyboard-offset': `${keyboardOffset}px` } as React.CSSProperties}
      >
        <div className="mobile-action-bar__inner">
          {secondaryAction && <div className="mobile-action-bar__secondary">{secondaryAction}</div>}
          <div className="mobile-action-bar__primary">{primaryAction}</div>
        </div>
      </div>
    </>
  )
}
