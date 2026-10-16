import { Check } from 'lucide-react'

// ─── AppStepper ───────────────────────────────────────────────────────────────
// BETA-UX-2 — progreso de un flujo por pasos con nombre. Reemplaza la barra de
// la recepción de equipos, que no decía en qué paso estabas ni cuántos
// quedaban (sólo un ancho) y usaba un gradiente que no existe en el resto del
// sistema.
//
// Cada paso dice su estado con forma y texto, no sólo con color: hecho = check,
// actual = número sobre índigo + rótulo en 700, pendiente = número neutro. Los
// pasos ya hechos son botones para volver (si se pasa `onSelect`); los
// siguientes no se pueden saltear desde acá, porque cada paso valida lo suyo.
// El estilo vive en index.css («BETA-UX-2 · AppStepper»).

export interface AppStepperProps {
  steps: readonly string[]
  /** Índice (0) del paso actual. */
  current: number
  /** Volver a un paso anterior. Sin esto el stepper es sólo informativo. */
  onSelect?: (index: number) => void
  /** Nombre accesible de la lista. */
  label?: string
  className?: string
  'data-testid'?: string
}

export function AppStepper({ steps, current, onSelect, label = 'Pasos', className, 'data-testid': testId }: AppStepperProps) {
  return (
    <ol className={['app-stepper', className].filter(Boolean).join(' ')} aria-label={label} data-testid={testId}>
      {steps.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'upcoming'
        const marker = state === 'done' ? <Check size={15} strokeWidth={3} aria-hidden="true" /> : index + 1
        const body = (
          <>
            <span className="app-stepper__marker" aria-hidden="true">{marker}</span>
            <span className="app-stepper__label">{step}</span>
          </>
        )
        return (
          <li key={step} className="app-stepper__step" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
            {state === 'done' && onSelect ? (
              <button
                type="button"
                className="app-stepper__target"
                onClick={() => onSelect(index)}
                aria-label={`Volver al paso ${index + 1}: ${step} (completo)`}
              >
                {body}
              </button>
            ) : (
              <span className="app-stepper__target">
                {body}
                <span className="sr-only">
                  {state === 'current' ? ` (paso ${index + 1} de ${steps.length}, actual)` : state === 'done' ? ' (completo)' : ` (paso ${index + 1} de ${steps.length})`}
                </span>
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}
