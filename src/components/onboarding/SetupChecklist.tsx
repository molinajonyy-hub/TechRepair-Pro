/**
 * SetupChecklist — componente PRESENTACIONAL del checklist de primeros pasos.
 *
 * P0 FIRST-STEPS-1 (§12): había dos implementaciones del mismo checklist.
 * `OnboardingChecklist` (montado, con estado en localStorage y checkboxes
 * editables) y éste (muerto, pero con tokens de tema y mejor estructura).
 * Se conservó éste como capa de presentación y se eliminó aquél: menor deuda,
 * usa `var(--*)` en vez de hexadecimales dark hardcodeados, y no inventa
 * estado. Todo el estado vive ahora en `useFirstSteps`.
 *
 * CONTRATO: este componente NO decide si algo está hecho. Recibe `items` ya
 * resueltos desde el servidor y los dibuja.
 *
 * El indicador circular es SÓLO visual (`aria-hidden`): no es un checkbox y no
 * se puede tildar. La fila entera es un `<button>` que navega — accesible por
 * teclado, con el estado anunciado en su `aria-label`.
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
  /** Título opcional; por defecto el del checklist de primeros pasos. */
  title?: string
  /** Callback al cerrar el checklist. */
  onDismiss: () => void
}

export function SetupChecklist({ items, title, onDismiss }: SetupChecklistProps) {
  const navigate = useNavigate()
  const [closing, setClosing] = useState(false)

  const doneCount = items.filter(i => i.done).length
  const progress  = items.length > 0 ? (doneCount / items.length) * 100 : 0
  const allDone   = items.length > 0 && doneCount === items.length

  const handleDismiss = () => {
    setClosing(true)
    setTimeout(onDismiss, 250)
  }

  return (
    <section
      data-testid="setup-checklist"
      aria-label="Primeros pasos"
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
        gap: '0.75rem',
        padding: '0.875rem 1.125rem',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', minWidth: 0 }}>
          <span style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {allDone ? 'Configuración completa' : (title ?? 'Primeros pasos')}
          </span>
          <span
            data-testid="setup-checklist-progress"
            style={{
              fontSize: '0.72rem', fontWeight: 700, padding: '0.15rem 0.5rem',
              borderRadius: '9999px', flexShrink: 0,
              background: allDone ? 'rgba(34,197,94,0.12)' : 'rgba(99,102,241,0.12)',
              color: allDone ? 'var(--success, #16a34a)' : 'var(--accent-primary)',
            }}
          >
            {doneCount}/{items.length}
          </span>
        </div>
        <button
          type="button"
          className="mobile-touch-target"
          onClick={handleDismiss}
          aria-label="Ocultar primeros pasos"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', display: 'flex', padding: '0.25rem',
            flexShrink: 0,
          }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {/* Progress bar */}
      <div
        role="progressbar"
        aria-valuenow={doneCount}
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-label={`${doneCount} de ${items.length} pasos completados`}
        style={{ height: 3, background: 'var(--border-subtle)' }}
      >
        <div style={{
          height: '100%', width: `${progress}%`,
          background: allDone ? 'var(--success, #16a34a)' : 'var(--accent-primary)',
          transition: 'width 0.5s ease',
        }} />
      </div>

      {/* Items */}
      <ul style={{
        listStyle: 'none', margin: 0,
        padding: '0.5rem 0.625rem',
        display: 'flex', flexDirection: 'column', gap: '0.125rem',
      }}>
        {items.map(item => (
          <li key={item.id}>
            <button
              type="button"
              data-testid={`setup-step-${item.id}`}
              data-done={item.done ? 'true' : 'false'}
              onClick={() => item.href && navigate(item.href)}
              disabled={!item.href}
              aria-label={`${item.label}. ${item.done ? 'Completado' : 'Pendiente'}`}
              style={{
                width: '100%',
                display: 'flex', alignItems: 'center', gap: '0.625rem',
                // Mobile-first: 44px de alto real para que el toque no falle.
                minHeight: 44,
                padding: '0.375rem 0.5rem',
                background: 'none', border: 'none', borderRadius: '0.5rem',
                textAlign: 'left',
                cursor: item.href ? 'pointer' : 'default',
                color: 'inherit',
              }}
            >
              {item.done
                ? <CheckCircle2 size={16} aria-hidden="true" style={{ color: 'var(--success, #16a34a)', flexShrink: 0 }} />
                : <Circle size={16} aria-hidden="true" style={{ color: 'var(--text-subtle)', flexShrink: 0 }} />
              }
              <span style={{
                fontSize: '0.82rem',
                color: item.done ? 'var(--text-muted)' : 'var(--text-secondary)',
                textDecoration: item.done ? 'line-through' : 'none',
                flex: 1, minWidth: 0,
              }}>
                {item.label}
              </span>
              {!item.done && item.href && (
                <span aria-hidden="true" style={{
                  fontSize: '0.7rem', color: 'var(--accent-primary)',
                  fontWeight: 600, flexShrink: 0,
                }}>
                  Ir →
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {allDone && (
        <div style={{ padding: '0.25rem 1.125rem 0.875rem', textAlign: 'center' }}>
          <button
            type="button"
            onClick={handleDismiss}
            style={{
              fontSize: '0.78rem', color: 'var(--text-muted)', minHeight: 44,
              background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline',
            }}
          >
            Listo, ocultar
          </button>
        </div>
      )}
    </section>
  )
}
