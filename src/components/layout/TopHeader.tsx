import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { GlobalSearch } from './GlobalSearch'
import { NotificationsDropdown } from './NotificationsDropdown'
import { useSystemStatus } from '../../contexts/SystemStatusContext'
import type { AppStatus } from '../../hooks/useAppWakeUp'

// ─── Dot de estado ────────────────────────────────────────────────────────────

const STATUS_MAP: Record<AppStatus, { color: string; label: string; pulse: boolean }> = {
  online:          { color: '#22c55e', label: 'Online',        pulse: false },
  updating:        { color: '#f59e0b', label: 'Actualizando',  pulse: true  },
  offline:         { color: '#ef4444', label: 'Sin conexión',  pulse: false },
  reconnecting:    { color: '#f59e0b', label: 'Reconectando',  pulse: true  },
  session_expired: { color: '#ef4444', label: 'Sesión vencida',pulse: false },
}

function SystemStatusDot({ status }: { status: AppStatus }) {
  const s = STATUS_MAP[status]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.3rem 0.625rem', borderRadius: '9999px', background: `${s.color}12`, border: `1px solid ${s.color}30` }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%', background: s.color, flexShrink: 0,
        boxShadow: s.pulse ? `0 0 0 0 ${s.color}` : 'none',
        animation: s.pulse ? 'statusPulse 1.4s infinite' : 'none',
      }} />
      <span style={{ fontSize: '0.7rem', fontWeight: 600, color: s.color, whiteSpace: 'nowrap' }}>{s.label}</span>
    </div>
  )
}

// ─── Botón Reconectar ─────────────────────────────────────────────────────────

function ReconnectButton() {
  const { triggerRefresh, status } = useSystemStatus()
  const [spinning, setSpinning] = useState(false)

  const handleClick = async () => {
    setSpinning(true)
    triggerRefresh()
    setTimeout(() => setSpinning(false), 2500)
  }

  const isActive = status === 'updating' || status === 'reconnecting'

  return (
    <button
      onClick={handleClick}
      disabled={isActive}
      title="Reconectar y actualizar datos"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
        padding: '0.3rem 0.625rem', borderRadius: '0.5rem',
        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
        color: '#94a3b8', fontSize: '0.72rem', fontWeight: 600, cursor: isActive ? 'default' : 'pointer',
        opacity: isActive ? 0.6 : 1, transition: 'opacity 0.2s',
      }}
    >
      <RefreshCw size={12} style={{ animation: (spinning || isActive) ? 'spin 1s linear infinite' : 'none' }} />
      Reconectar
    </button>
  )
}

// ─── TopHeader ────────────────────────────────────────────────────────────────

export function TopHeader() {
  const { status } = useSystemStatus()
  const showDot = status !== 'online'  // solo visible cuando hay algo que informar

  return (
    <header
      className="top-header"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        padding: '0.85rem 1rem', marginBottom: '1.5rem',
        background: 'var(--bg-header)', border: '1px solid var(--border-color)',
        borderRadius: '1rem', boxShadow: 'var(--shadow-sm)', backdropFilter: 'blur(18px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%', justifyContent: 'flex-end' }}>
        <GlobalSearch />
        {showDot && <SystemStatusDot status={status} />}
        <ReconnectButton />
        <NotificationsDropdown />
      </div>
      <style>{`
        @keyframes statusPulse {
          0%   { box-shadow: 0 0 0 0 currentColor40; }
          70%  { box-shadow: 0 0 0 5px transparent; }
          100% { box-shadow: 0 0 0 0 transparent; }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </header>
  )
}
