/**
 * SetupChecklist — tarjeta de configuración inicial para negocios nuevos.
 *
 * Muestra el progreso de setup y se oculta automáticamente cuando el
 * negocio ya completó el onboarding hace más de 30 días.
 * Se puede descartar manualmente.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, CheckCircle2, Circle } from 'lucide-react'

export interface SetupChecklistItem {
  id: string
  label: string
  done: boolean
  href?: string
}

interface SetupChecklistProps {
  items: SetupChecklistItem[]
  /** Callback al cerrar el checklist */
  onDismiss: () => void
}

export function SetupChecklist({ items, onDismiss }: SetupChecklistProps) {
  const navigate = useNavigate()
  const [closing, setClosing] = useState(false)

  const doneCount = items.filter(i => i.done).length
  const progress  = items.length > 0 ? (doneCount / items.length) * 100 : 0
  const allDone   = doneCount === items.length

  const handleDismiss = () => {
    setClosing(true)
    setTimeout(onDismiss, 250)
  }

  return (
    <div
      data-testid="setup-checklist"
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '0.875rem',
        overflow: 'hidden',
        marginBottom: '1.5rem',
        opacity: closing ? 0 : 1,
        transform: closing ? 'translateY(-8px)' : 'none',
        transition: 'opacity 0.25s, transform 0.25s',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.875rem 1.125rem',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
          <span style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {allDone ? '✅ Configuración completa' : '🚀 Configuración inicial'}
          </span>
          <span style={{
            fontSize: '0.72rem', fontWeight: 700, padding: '0.15rem 0.5rem',
            borderRadius: '9999px',
            background: allDone ? 'rgba(34,197,94,0.12)' : 'rgba(99,102,241,0.12)',
            color: allDone ? '#22c55e' : '#818cf8',
          }}>
            {doneCount}/{items.length}
          </span>
        </div>
        <button
          onClick={handleDismiss}
          title="Cerrar checklist"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: '0.25rem' }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Progress bar */}
      <div style={{ height: 3, background: 'var(--border-subtle)' }}>
        <div style={{
          height: '100%', width: `${progress}%`,
          background: allDone ? '#22c55e' : '#6366f1',
          transition: 'width 0.5s ease',
        }} />
      </div>

      {/* Items */}
      <div style={{ padding: '0.75rem 1.125rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {items.map(item => (
          <div
            key={item.id}
            onClick={() => item.href && !item.done && navigate(item.href)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.625rem',
              cursor: item.href && !item.done ? 'pointer' : 'default',
              opacity: item.done ? 0.6 : 1,
            }}
          >
            {item.done
              ? <CheckCircle2 size={15} style={{ color: '#22c55e', flexShrink: 0 }} />
              : <Circle size={15} style={{ color: 'var(--text-subtle)', flexShrink: 0 }} />
            }
            <span style={{
              fontSize: '0.82rem',
              color: item.done ? 'var(--text-muted)' : 'var(--text-secondary)',
              textDecoration: item.done ? 'line-through' : 'none',
              flex: 1,
            }}>
              {item.label}
            </span>
            {!item.done && item.href && (
              <span style={{ fontSize: '0.7rem', color: '#6366f1', fontWeight: 600 }}>Ir →</span>
            )}
          </div>
        ))}
      </div>

      {allDone && (
        <div style={{ padding: '0.625rem 1.125rem 0.875rem', textAlign: 'center' }}>
          <button onClick={handleDismiss} style={{
            fontSize: '0.78rem', color: 'var(--text-muted)',
            background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline',
          }}>
            Ocultar checklist
          </button>
        </div>
      )}
    </div>
  )
}

/** Hook para gestionar el estado del checklist (visible/oculto) en localStorage. */
export function useSetupChecklistVisible(businessId: string | null): [boolean, () => void] {
  const key = businessId ? `setup_checklist_hidden_${businessId}` : null
  const [visible, setVisible] = useState(() => {
    if (!key) return false
    return localStorage.getItem(key) !== 'true'
  })

  const dismiss = () => {
    if (key) localStorage.setItem(key, 'true')
    setVisible(false)
  }

  return [visible, dismiss]
}
