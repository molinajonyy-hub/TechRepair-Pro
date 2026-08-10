import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { CalendarClock } from 'lucide-react'
import { colors, radius, fontSize } from '../../../lib/tokens'
import {
  AGING_COLORS, bucketLabel, formatAxisARS, formatARS, formatNumber, formatPercent,
} from '../../../lib/finance/chartsL1Presentation'
import { FinanceTooltip } from './FinanceTooltip'
import type { AgingSection, PayablesDue } from '../../../services/financeChartsService'

// ─── §11 / §12 — Cartera ─────────────────────────────────────────────────────
//
// Estas dos tarjetas muestran el ESTADO ACTUAL, no el período: la antigüedad de
// una deuda no depende del rango que uno elija mirar. Se dice explícitamente en
// el subtítulo para que nadie lo lea como "deuda generada en el período".
//
// REGLA CRÍTICA (§12): aging y due_date NUNCA se mezclan.
//   · aging     = hace cuánto que existe la deuda (v_finance_payables_aging)
//   · due_date  = cuándo hay que pagarla       (v_finance_payables_due)
// No se inventa un vencimiento tipo "compra + 30 días". Si nadie cargó fechas,
// se dice que no hay fechas cargadas — que no es un error.

const AXIS_STYLE = { fontSize: 10, fill: 'var(--text-subtle)' }

/** Orden canónico de los buckets. Sin esto el eje sale alfabético. */
const ORDEN = ['0-7', '8-30', '31-60', '60+']

function ordenar(buckets: AgingSection['buckets']) {
  return [...buckets].sort((a, b) => ORDEN.indexOf(a.bucket) - ORDEN.indexOf(b.bucket))
}

export interface AgingChartProps {
  section: AgingSection
  documentLabel: { one: string; many: string }
  height?: number
}

export function AgingChart({ section, documentLabel, height = 190 }: AgingChartProps) {
  const data = ordenar(section.buckets).map(b => ({ ...b, label: bucketLabel(b.bucket) }))
  if (!data.length) return null

  return (
    <div style={{ width: '100%', height }} data-testid="chart-aging">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
          <XAxis dataKey="label" tick={{ ...AXIS_STYLE, fontSize: 9 }}
                 axisLine={{ stroke: 'var(--border-subtle)' }} tickLine={false} interval={0} />
          <YAxis tickFormatter={formatAxisARS} tick={AXIS_STYLE} axisLine={false} tickLine={false} width={58} />
          <Tooltip
            cursor={{ fill: 'var(--bg-hover)', opacity: 0.45 }}
            content={(props) => {
              const p = props as { active?: boolean; payload?: { payload?: typeof data[number] }[] }
              if (!p.active || !p.payload?.length) return null
              const d = p.payload[0]?.payload
              if (!d) return null
              const share = section.total > 0 ? (d.amount / section.total) * 100 : 0
              return (
                <FinanceTooltip
                  title={d.label}
                  rows={[
                    { label: 'Importe', value: formatARS(d.amount) },
                    { label: 'Participación', value: formatPercent(share, { ya100: true }) },
                    {
                      label: d.documents === 1 ? documentLabel.one : documentLabel.many,
                      value: formatNumber(d.documents, 0),
                    },
                  ]}
                  note="Antigüedad del saldo, no fecha de vencimiento."
                />
              )
            }}
          />
          <Bar dataKey="amount" radius={[3, 3, 0, 0]} maxBarSize={46}>
            {data.map(d => <Cell key={d.bucket} fill={AGING_COLORS[d.bucket] ?? colors.text.muted} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export function receivablesSummaryText(section: AgingSection): string {
  if (section.total <= 0) return 'No tenés saldos pendientes de cobro.'
  const viejo = section.buckets
    .filter(b => b.bucket === '31-60' || b.bucket === '60+')
    .reduce((s, b) => s + b.amount, 0)
  const share = section.total > 0 ? (viejo / section.total) * 100 : 0
  return (
    `Te deben ${formatARS(section.total)} en ${formatNumber(section.documents, 0)} ` +
    `comprobante${section.documents === 1 ? '' : 's'}. ` +
    (viejo > 0
      ? `${formatARS(viejo)} (${formatPercent(share, { ya100: true })}) tiene más de 30 días de antigüedad.`
      : 'Todo el saldo tiene menos de 30 días de antigüedad.')
  )
}

export function payablesSummaryText(section: AgingSection): string {
  if (section.total <= 0) return 'No tenés deuda pendiente con proveedores.'
  return (
    `Debés ${formatARS(section.total)} en ${formatNumber(section.documents, 0)} ` +
    `compra${section.documents === 1 ? '' : 's'} sin saldar, clasificadas por antigüedad.`
  )
}

// ─── Vencimientos reales — superficie SEPARADA ───────────────────────────────

export function PayablesDueBlock({ due }: { due: PayablesDue }) {
  if (!due.has_due_dates) {
    return (
      <div style={{
        display: 'flex', gap: '0.55rem', alignItems: 'flex-start',
        padding: '0.6rem 0.7rem', borderRadius: radius.sm,
        background: colors.bg.card, border: `1px solid ${colors.border.subtle}`,
      }}>
        <CalendarClock size={14} style={{ color: colors.text.muted, flexShrink: 0, marginTop: 1 }} />
        <span style={{ fontSize: fontSize.xs, color: colors.text.muted, lineHeight: 1.45 }}>
          Todavía no cargaste fechas de vencimiento.{' '}
          {due.undated_count > 0 && (
            <>
              {formatNumber(due.undated_count, 0)} compra{due.undated_count === 1 ? '' : 's'} por{' '}
              {formatARS(due.undated_amount)} sin fecha acordada.
            </>
          )}
        </span>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }} data-testid="payables-due">
      <DueChip label="Vencido" amount={due.overdue_amount} tone={colors.error} />
      <DueChip label="Próximos 14 días" amount={due.due_soon_amount} tone={colors.warning} />
      {due.undated_amount > 0 && (
        <DueChip label="Sin fecha acordada" amount={due.undated_amount} tone={colors.text.muted} />
      )}
    </div>
  )
}

function DueChip({ label, amount, tone }: { label: string; amount: number; tone: string }) {
  return (
    <div style={{
      flex: '1 1 130px', minWidth: 0, padding: '0.5rem 0.65rem',
      borderRadius: radius.sm, background: colors.bg.card,
      border: `1px solid ${colors.border.subtle}`, borderLeft: `3px solid ${tone}`,
    }}>
      <div style={{
        fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.04em',
        fontWeight: 700, color: colors.text.muted,
      }}>{label}</div>
      <div style={{
        fontSize: fontSize.base, fontWeight: 700, color: colors.text.primary,
        fontVariantNumeric: 'tabular-nums', marginTop: '0.1rem',
      }}>{formatARS(amount)}</div>
    </div>
  )
}
