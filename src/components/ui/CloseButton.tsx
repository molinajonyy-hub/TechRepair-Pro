/**
 * CloseButton — botón de cierre unificado para todos los modales del sistema.
 *
 * Animación: al hacer hover rota 90° y se torna rojo suave.
 * Uso:
 *   <CloseButton onClick={onClose} />
 *   <CloseButton onClick={onClose} disabled={loading} size={32} />
 */

import { X } from 'lucide-react'

interface CloseButtonProps {
  onClick: () => void
  disabled?: boolean
  /** Tamaño del botón en px (ancho y alto). Default 36 */
  size?: number
  /** Tamaño del ícono X. Default size * 0.5 */
  iconSize?: number
  style?: React.CSSProperties
  'aria-label'?: string
}

export function CloseButton({
  onClick,
  disabled = false,
  size = 36,
  iconSize,
  style,
  'aria-label': ariaLabel = 'Cerrar',
}: CloseButtonProps) {
  const radius = Math.round(size * 0.22)   // ~0.5rem para size=36, ~0.625rem para size=40
  const icon   = iconSize ?? Math.round(size * 0.47)

  return (
    <>
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        className="sys-close-btn"
        style={{
          width:  size,
          height: size,
          borderRadius: radius,
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.1)',
          color: '#64748b',
          cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          transition: 'background 0.18s, border-color 0.18s, color 0.18s, transform 0.22s cubic-bezier(0.34,1.56,0.64,1)',
          opacity: disabled ? 0.5 : 1,
          ...style,
        }}
      >
        <X size={icon} strokeWidth={2.2} />
      </button>

      {/* Estilos hover via CSS — no necesita JS onMouseEnter/Leave */}
      <style>{`
        .sys-close-btn:not(:disabled):hover {
          background: rgba(239, 68, 68, 0.12) !important;
          border-color: rgba(239, 68, 68, 0.35) !important;
          color: #f87171 !important;
          transform: rotate(90deg) scale(1.08) !important;
        }
        .sys-close-btn:not(:disabled):active {
          transform: rotate(90deg) scale(0.95) !important;
        }
      `}</style>
    </>
  )
}

export default CloseButton
