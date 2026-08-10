import type { ReactNode } from 'react'
import { AlertTriangle, Lock, Info, RefreshCw } from 'lucide-react'
import { colors, radius, fontSize } from '../../../lib/tokens'

// ─── Charts L1 — carcasa común de cada tarjeta ───────────────────────────────
//
// Concentra los 7 estados de §28 para que ninguna tarjeta los invente por su
// cuenta, y garantiza §31: el gráfico NUNCA es la única fuente de información.
// Cada tarjeta lleva título, resumen textual y aria-label.
//
// Regla dura: un error JAMÁS se dibuja como $0. `unavailable` y `empty` son
// estados distintos y se ven distinto.

export type CardState =
  | 'loading'
  | 'available'
  | 'empty'
  | 'incomplete'
  | 'unavailable'
  | 'restricted'
  | 'stale'

export interface ChartCardProps {
  title: string
  /** Pregunta que responde la tarjeta. Se muestra bajo el título. */
  subtitle?: string
  /**
   * Resumen textual del contenido del gráfico. Es la alternativa accesible y
   * también se usa como aria-label de la figura.
   */
  summary?: string
  state: CardState
  /** Nota de estado `incomplete` (p. ej. cobertura de costos). */
  incompleteNote?: string
  error?: string | null
  onRetry?: () => void
  /** Marca de recarga en curso con datos viejos visibles. */
  stale?: boolean
  footer?: ReactNode
  action?: ReactNode
  height?: number
  testId?: string
  children: ReactNode
}

const MENSAJES: Record<string, string> = {
  empty: 'No hay movimientos suficientes en este período.',
  unavailable: 'No pudimos cargar este gráfico.',
  restricted: 'Tu usuario no tiene permiso para ver esta información.',
}

function Placeholder({ icon, text, onRetry }: { icon: ReactNode; text: string; onRetry?: () => void }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '0.6rem', minHeight: 160, padding: '1.5rem 1rem', textAlign: 'center',
    }}>
      {icon}
      <p style={{ margin: 0, fontSize: fontSize.sm, color: colors.text.muted, maxWidth: 320 }}>{text}</p>
      {onRetry && (
        <button className="btn btn-ghost btn-sm" onClick={onRetry} type="button">
          <RefreshCw size={12} /> Reintentar
        </button>
      )}
    </div>
  )
}

export function ChartCard({
  title, subtitle, summary, state, incompleteNote, error, onRetry,
  stale, footer, action, height, testId, children,
}: ChartCardProps) {
  const mostrarContenido = state === 'available' || state === 'incomplete' || state === 'stale'

  return (
    <section
      data-testid={testId}
      data-state={state}
      aria-busy={state === 'loading' || stale === true}
      style={{
        background: 'var(--bg-card-solid)',
        border: `1px solid ${colors.border.default}`,
        borderRadius: radius.lg,
        padding: '1.15rem 1.25rem',
        display: 'flex', flexDirection: 'column', gap: '0.75rem',
        minWidth: 0,                 // deja que el hijo encoja: evita overflow-x
        opacity: stale ? 0.6 : 1,
        transition: 'opacity 0.18s ease',
      }}
    >
      {/* ── Encabezado ── */}
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 style={{
            margin: 0, fontSize: fontSize.base, fontWeight: 700,
            color: colors.text.primary, lineHeight: 1.25,
          }}>{title}</h3>
          {subtitle && (
            <p style={{ margin: '0.15rem 0 0', fontSize: fontSize.xs, color: colors.text.muted }}>
              {subtitle}
            </p>
          )}
        </div>
        {action}
      </header>

      {/* ── Resumen textual (§31) ──
          Visible, no sólo para lectores de pantalla: es la respuesta rápida
          para quien no quiere leer un gráfico. */}
      {summary && mostrarContenido && (
        <p data-testid={testId ? `${testId}-summary` : undefined} style={{
          margin: 0, fontSize: fontSize.sm, color: colors.text.secondary, lineHeight: 1.45,
        }}>{summary}</p>
      )}

      {/* ── Nota de cobertura parcial ── */}
      {state === 'incomplete' && incompleteNote && (
        <div role="note" style={{
          display: 'flex', gap: '0.5rem', alignItems: 'flex-start',
          padding: '0.55rem 0.7rem', borderRadius: radius.sm,
          background: colors.warningBg, border: `1px solid ${colors.warningBorder}`,
        }}>
          <Info size={13} style={{ color: colors.warning, flexShrink: 0, marginTop: 2 }} />
          <span style={{ fontSize: fontSize.xs, color: colors.text.secondary, lineHeight: 1.4 }}>
            {incompleteNote}
          </span>
        </div>
      )}

      {/* ── Cuerpo ── */}
      {state === 'loading' && (
        <div
          aria-hidden="true"
          style={{
            minHeight: height ?? 180, borderRadius: radius.md,
            background: colors.bg.card, animation: 'pulse 1.4s ease-in-out infinite',
          }}
        />
      )}

      {state === 'empty' && (
        <Placeholder icon={<Info size={22} style={{ color: colors.text.muted }} />} text={MENSAJES.empty} />
      )}

      {state === 'unavailable' && (
        <Placeholder
          icon={<AlertTriangle size={22} style={{ color: colors.error }} />}
          text={error ? `${MENSAJES.unavailable} ${error}` : MENSAJES.unavailable}
          onRetry={onRetry}
        />
      )}

      {state === 'restricted' && (
        <Placeholder icon={<Lock size={22} style={{ color: colors.text.muted }} />} text={MENSAJES.restricted} />
      )}

      {mostrarContenido && (
        <figure
          role="figure"
          aria-label={summary ? `${title}. ${summary}` : title}
          style={{ margin: 0, minWidth: 0, width: '100%' }}
        >
          {children}
        </figure>
      )}

      {footer && mostrarContenido && (
        <div style={{ borderTop: `1px solid ${colors.border.subtle}`, paddingTop: '0.65rem' }}>
          {footer}
        </div>
      )}
    </section>
  )
}
