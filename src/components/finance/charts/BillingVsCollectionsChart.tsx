import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'
import { colors, fontSize } from '../../../lib/tokens'
import {
  CHART_COLORS, SERIE_LABELS, bucketLabelFor, bucketTitleFor, formatAxisARS, formatARS,
} from '../../../lib/finance/chartsL1Presentation'
import { SeriesTooltip } from './FinanceTooltip'
import type {
  BillingVsCollectionsPoint, ChartGranularity, ChartsSummary,
} from '../../../services/financeChartsService'

// ─── §8 — Facturación vs cobros ──────────────────────────────────────────────
//
// Pregunta: ¿estoy vendiendo pero no cobrando?
//
// · Facturación = devengado (v_finance_pnl.net_sales).
// · Cobros      = dinero efectivamente recibido (ledger append-only de cobros).
//
// Cuenta corriente NO es cobro. Una factura pendiente NO es cobro. Un pago real
// sí. Las anulaciones se compensan en el período de la anulación, igual que en
// el P&L.
//
// La brecha entre las dos áreas es la misma situación que detecta el insight
// `cash_down_sales_up` de M8, pero visible sin depender de que la regla dispare.

const AXIS_STYLE = { fontSize: 10, fill: 'var(--text-subtle)' }

export interface BillingVsCollectionsChartProps {
  series: BillingVsCollectionsPoint[]
  granularity: ChartGranularity
  height?: number
}

export function BillingVsCollectionsChart({
  series, granularity, height = 240,
}: BillingVsCollectionsChartProps) {
  const hayNegativos = series.some(p => p.billed < 0 || p.collected < 0)

  return (
    <div style={{ width: '100%', height }} data-testid="chart-billing-vs-collections">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 8, right: 4, bottom: 4, left: -8 }}>
          <defs>
            <linearGradient id="l1GradBilled" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.billed} stopOpacity={0.28} />
              <stop offset="100%" stopColor={CHART_COLORS.billed} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="l1GradCollected" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.collected} stopOpacity={0.28} />
              <stop offset="100%" stopColor={CHART_COLORS.collected} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={(b: string) => bucketLabelFor(b, granularity)}
            tick={AXIS_STYLE}
            axisLine={{ stroke: 'var(--border-subtle)' }}
            tickLine={false}
            minTickGap={16}
          />
          <YAxis tickFormatter={formatAxisARS} tick={AXIS_STYLE} axisLine={false} tickLine={false} width={58} />
          {hayNegativos && <ReferenceLine y={0} stroke="var(--border-strong)" strokeWidth={1} />}
          <Tooltip
            cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }}
            content={(props) => (
              <SeriesTooltip
                {...props}
                titleFor={(p) => bucketTitleFor(String(p.bucket ?? ''), granularity)}
                labels={{ billed: SERIE_LABELS.billed, collected: SERIE_LABELS.collected }}
                note="La cuenta corriente no cuenta como cobro hasta que se cobra."
              />
            )}
          />
          <Legend verticalAlign="top" align="left" height={26} iconType="plainline" iconSize={14}
                  wrapperStyle={{ fontSize: 11, color: 'var(--text-muted)' }} />
          {/* Trazo continuo vs punteado: las series se distinguen sin depender
              del color (§45). */}
          <Area
            type="monotone" dataKey="billed" name={SERIE_LABELS.billed}
            stroke={CHART_COLORS.billed} strokeWidth={2}
            fill="url(#l1GradBilled)" activeDot={{ r: 4 }}
          />
          <Area
            type="monotone" dataKey="collected" name={SERIE_LABELS.collected}
            stroke={CHART_COLORS.collected} strokeWidth={2} strokeDasharray="5 3"
            fill="url(#l1GradCollected)" activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export function billingSummaryText(summary: ChartsSummary): string {
  const brecha = summary.net_sales - summary.collections
  if (brecha > 0) {
    return (
      `Facturaste ${formatARS(summary.net_sales)} y cobraste ${formatARS(summary.collections)}: ` +
      `quedan ${formatARS(brecha)} de diferencia entre lo generado y lo efectivamente recibido.`
    )
  }
  if (brecha < 0) {
    return (
      `Cobraste ${formatARS(summary.collections)} contra ${formatARS(summary.net_sales)} facturados: ` +
      `entró más dinero del que se generó en el período, típicamente por cobros de ventas anteriores.`
    )
  }
  return `Facturación y cobros coinciden en ${formatARS(summary.net_sales)} durante el período.`
}

/** Texto educativo pedido por §8. */
export function BillingLegendNote() {
  return (
    <p style={{ margin: 0, fontSize: fontSize.xs, color: colors.text.muted, lineHeight: 1.45 }}>
      <strong style={{ color: colors.text.secondary }}>Facturación</strong> representa lo generado.{' '}
      <strong style={{ color: colors.text.secondary }}>Cobros</strong> representa el dinero efectivamente recibido.
    </p>
  )
}
