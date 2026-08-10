import { colors, radius, fontSize, shadows } from '../../../lib/tokens'
import { formatARS, formatPercent } from '../../../lib/finance/chartsL1Presentation'

// ─── Charts L1 — tooltip financiero canónico (§27) ───────────────────────────
//
// Un solo tooltip para todos los gráficos del lote. Funciona en light y dark
// porque se apoya en las CSS custom properties del tema.
//
// Nunca muestra: JSON, claves internas, UUID, floats largos ni nombres de
// columna. Todo lo que entra acá ya viene con etiqueta legible y valor
// formateado en es-AR.

export interface TooltipRow {
  label: string
  value: string
  color?: string
  /** Fila destacada (subtotales, resultados). */
  emphasis?: boolean
}

export interface FinanceTooltipProps {
  title: string
  rows: TooltipRow[]
  note?: string
}

export function FinanceTooltip({ title, rows, note }: FinanceTooltipProps) {
  if (!rows.length) return null
  return (
    <div
      role="tooltip"
      style={{
        background: 'var(--bg-modal)',
        border: `1px solid ${colors.border.medium}`,
        borderRadius: radius.md,
        boxShadow: shadows.dropdown,
        padding: '0.6rem 0.75rem',
        minWidth: 180,
        maxWidth: 280,
      }}
    >
      <div style={{
        fontSize: fontSize.xs, fontWeight: 700, color: colors.text.primary,
        marginBottom: '0.4rem', textTransform: 'capitalize',
      }}>{title}</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.22rem' }}>
        {rows.map((r, i) => (
          <div key={`${r.label}-${i}`} style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            paddingTop: r.emphasis ? '0.25rem' : 0,
            borderTop: r.emphasis ? `1px solid ${colors.border.subtle}` : 'none',
          }}>
            {r.color && (
              <span aria-hidden="true" style={{
                width: 8, height: 8, borderRadius: 2, background: r.color, flexShrink: 0,
              }} />
            )}
            <span style={{
              fontSize: fontSize.xs, color: colors.text.muted, flex: 1, whiteSpace: 'nowrap',
            }}>{r.label}</span>
            <span style={{
              fontSize: fontSize.xs, fontWeight: r.emphasis ? 800 : 600,
              color: colors.text.primary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
            }}>{r.value}</span>
          </div>
        ))}
      </div>

      {note && (
        <div style={{
          marginTop: '0.45rem', paddingTop: '0.4rem',
          borderTop: `1px solid ${colors.border.subtle}`,
          fontSize: '0.62rem', color: colors.text.muted, lineHeight: 1.35,
        }}>{note}</div>
      )}
    </div>
  )
}

// ─── Adaptadores para Recharts ───────────────────────────────────────────────
// Recharts entrega un payload propio; se traduce acá una sola vez para que
// ningún gráfico manipule su forma interna.

// Forma mínima del payload de Recharts que estos adaptadores consumen. `name` y
// `value` se declaran anchos (string | number) porque así los tipa la librería:
// estrecharlos haría que el tipo del `content` no encaje.
interface RechartsPayloadItem {
  dataKey?: string | number
  name?: string | number
  /** Recharts tipa ValueType como string | number | (string|number)[]. */
  value?: string | number | (string | number)[]
  color?: string
  payload?: Record<string, unknown>
}

export interface SeriesTooltipProps {
  active?: boolean
  payload?: RechartsPayloadItem[]
  /** Título ya formateado del punto (fecha/período). */
  titleFor: (payload: Record<string, unknown>) => string
  /** Etiqueta legible por dataKey. */
  labels: Record<string, string>
  /** dataKeys que se muestran como fila destacada. */
  emphasize?: string[]
  note?: string
}

export function SeriesTooltip({
  active, payload, titleFor, labels, emphasize = [], note,
}: SeriesTooltipProps) {
  if (!active || !payload?.length) return null
  const first = payload[0]?.payload ?? {}
  const rows: TooltipRow[] = payload
    .filter(p => typeof p.value === 'number' && Number.isFinite(p.value))
    .map(p => {
      const key = String(p.dataKey ?? '')
      return {
        label: labels[key] ?? (p.name !== undefined ? String(p.name) : key),
        value: formatARS(p.value as number),
        color: p.color,
        emphasis: emphasize.includes(key),
      }
    })
  return <FinanceTooltip title={titleFor(first)} rows={rows} note={note} />
}

export interface ShareTooltipProps {
  active?: boolean
  payload?: RechartsPayloadItem[]
  /** Total del conjunto, para calcular la participación. */
  total: number
  /** Etiqueta de la cantidad de operaciones, si la fuente la provee. */
  operationsLabel?: string
}

export function ShareTooltip({ active, payload, total, operationsLabel = 'Operaciones' }: ShareTooltipProps) {
  if (!active || !payload?.length) return null
  const p = payload[0]
  const data = (p?.payload ?? {}) as Record<string, unknown>
  const amount = typeof p?.value === 'number' ? p.value : Number(data.amount)
  if (!Number.isFinite(amount)) return null

  const label = typeof data.label === 'string' ? data.label : String(data.method ?? '')
  const operations = Number(data.operations)

  const rows: TooltipRow[] = [
    { label: 'Importe', value: formatARS(amount) },
    { label: 'Participación', value: total > 0 ? formatPercent((amount / total) * 100, { ya100: true }) : '—' },
  ]
  if (Number.isFinite(operations) && operations > 0) {
    rows.push({ label: operationsLabel, value: new Intl.NumberFormat('es-AR').format(operations) })
  }
  return <FinanceTooltip title={label} rows={rows} />
}
