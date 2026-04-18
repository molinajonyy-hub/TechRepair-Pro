// React is used implicitly via JSX transform

// ──────────────────────────────────────────────────────────────
// Tipos
// ──────────────────────────────────────────────────────────────

type ConnectionStatus = 'connected' | 'disconnected' | 'error' | null | undefined

interface WhatsAppStatusBadgeProps {
  status: ConnectionStatus
  /** Tamaño del badge: 'sm' (default) o 'md' */
  size?: 'sm' | 'md'
}

// ──────────────────────────────────────────────────────────────
// Configuración visual por estado
// ──────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  connected: {
    label: 'Conectado',
    dotColor: '#22c55e',        // verde
    textColor: '#22c55e',
    bgColor: 'rgba(34,197,94,0.12)',
    borderColor: 'rgba(34,197,94,0.25)',
  },
  disconnected: {
    label: 'Desconectado',
    dotColor: '#ef4444',        // rojo
    textColor: '#ef4444',
    bgColor: 'rgba(239,68,68,0.12)',
    borderColor: 'rgba(239,68,68,0.25)',
  },
  error: {
    label: 'Error',
    dotColor: '#f97316',        // naranja
    textColor: '#f97316',
    bgColor: 'rgba(249,115,22,0.12)',
    borderColor: 'rgba(249,115,22,0.25)',
  },
} as const

// ──────────────────────────────────────────────────────────────
// Componente
// ──────────────────────────────────────────────────────────────

export function WhatsAppStatusBadge({ status, size = 'sm' }: WhatsAppStatusBadgeProps) {
  // Cualquier valor null/undefined/desconocido se trata como desconectado
  const normalizedStatus: keyof typeof STATUS_CONFIG =
    status === 'connected' ? 'connected'
    : status === 'error'   ? 'error'
    : 'disconnected'

  const config = STATUS_CONFIG[normalizedStatus]

  const dotSize   = size === 'md' ? 10 : 8
  const fontSize  = size === 'md' ? 13 : 12
  const paddingX  = size === 'md' ? 10 : 8
  const paddingY  = size === 'md' ? 5  : 4

  return (
    <span
      style={{
        display:      'inline-flex',
        alignItems:   'center',
        gap:          6,
        padding:      `${paddingY}px ${paddingX}px`,
        borderRadius: 20,
        backgroundColor: config.bgColor,
        border:       `1px solid ${config.borderColor}`,
        fontSize,
        fontWeight:   500,
        color:        config.textColor,
        lineHeight:   1,
        whiteSpace:   'nowrap',
      }}
    >
      {/* Punto de estado con animación pulsante cuando está conectado */}
      <span
        style={{
          width:        dotSize,
          height:       dotSize,
          borderRadius: '50%',
          backgroundColor: config.dotColor,
          flexShrink:   0,
          ...(normalizedStatus === 'connected' ? {
            animation: 'whatsapp-pulse 2s ease-in-out infinite',
          } : {}),
        }}
      />
      {config.label}

      {/* Animación CSS inyectada inline una sola vez */}
      <style>{`
        @keyframes whatsapp-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </span>
  )
}

export default WhatsAppStatusBadge
