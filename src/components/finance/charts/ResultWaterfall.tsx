import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import {
  CHART_COLORS, WATERFALL_LABELS, formatAxisARS, formatARS,
} from '../../../lib/finance/chartsL1Presentation'
import { FinanceTooltip } from './FinanceTooltip'
import type { WaterfallStep, ChartsSummary } from '../../../services/financeChartsService'

// ─── §9 — Cómo se construyó tu resultado ─────────────────────────────────────
//
// Pregunta: ¿qué se está comiendo mi ganancia?
//
// Secuencia canónica, emitida por la RPC (React no la arma):
//   Ingresos netos → COGS → Margen bruto → Gastos operativos → Resultado
//
// Identidades garantizadas server-side y verificadas en los tests SQL:
//   gross_profit     = net_sales - cogs
//   operating_result = gross_profit - operating_expenses
//
// Los retiros del dueño NO son un escalón: se informan aparte, debajo.

interface WaterfallBar {
  key: string
  label: string
  /** Tramo invisible que posiciona la barra. GEOMETRÍA, no contabilidad. */
  base: number
  /** Altura visible del escalón. */
  span: number
  /** Valor real del paso, tal cual lo emitió la base. */
  value: number
  kind: WaterfallStep['kind']
  /** Acumulado en el que termina el paso (para el tooltip). */
  running: number
}

/**
 * Traduce los pasos del servidor a coordenadas de barra.
 *
 * Esto es POSICIONAMIENTO, no cálculo financiero: `value` viaja intacto desde
 * la RPC y nunca se re-deriva. `base`/`span` existen sólo porque un waterfall
 * se dibuja con una barra transparente debajo de la visible.
 */
export function buildWaterfallBars(steps: WaterfallStep[]): WaterfallBar[] {
  const bars: WaterfallBar[] = []
  let running = 0

  for (const step of steps) {
    const value = Number(step.value) || 0
    if (step.kind === 'delta') {
      // Un delta arranca donde terminó el acumulado y se mueve `value`.
      const desde = running
      const hasta = running + value
      bars.push({
        key: step.key, label: WATERFALL_LABELS[step.key] ?? step.key,
        base: Math.min(desde, hasta), span: Math.abs(value),
        value, kind: step.kind, running: hasta,
      })
      running = hasta
    } else {
      // start / subtotal / total: barra completa desde 0 (o hasta 0 si es
      // negativa) y el acumulado se RESETEA al valor absoluto del hito.
      bars.push({
        key: step.key, label: WATERFALL_LABELS[step.key] ?? step.key,
        base: Math.min(0, value), span: Math.abs(value),
        value, kind: step.kind, running: value,
      })
      running = value
    }
  }
  return bars
}

function colorFor(bar: WaterfallBar): string {
  if (bar.kind === 'delta') return bar.value < 0 ? CHART_COLORS.cogs : CHART_COLORS.result
  if (bar.kind === 'total') return bar.value >= 0 ? CHART_COLORS.result : CHART_COLORS.resultNegative
  if (bar.kind === 'subtotal') return CHART_COLORS.neutral
  return CHART_COLORS.revenue
}

const AXIS_STYLE = { fontSize: 10, fill: 'var(--text-subtle)' }

export interface ResultWaterfallProps {
  steps: WaterfallStep[]
  height?: number
}

export function ResultWaterfall({ steps, height = 280 }: ResultWaterfallProps) {
  const bars = buildWaterfallBars(steps)
  const hayNegativos = bars.some(b => b.base < 0 || b.value < 0)

  return (
    <div style={{ width: '100%', height }} data-testid="chart-waterfall">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bars} margin={{ top: 8, right: 4, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
          <XAxis
            dataKey="label" tick={{ ...AXIS_STYLE, fontSize: 9 }}
            axisLine={{ stroke: 'var(--border-subtle)' }} tickLine={false}
            interval={0} height={44} angle={-18} textAnchor="end"
          />
          <YAxis tickFormatter={formatAxisARS} tick={AXIS_STYLE} axisLine={false} tickLine={false} width={58} />
          {hayNegativos && <ReferenceLine y={0} stroke="var(--border-strong)" strokeWidth={1} />}
          <Tooltip
            cursor={{ fill: 'var(--bg-hover)', opacity: 0.45 }}
            content={(props) => {
              const p = props as { active?: boolean; payload?: { payload?: WaterfallBar }[] }
              if (!p.active || !p.payload?.length) return null
              const bar = p.payload[0]?.payload
              if (!bar) return null
              return (
                <FinanceTooltip
                  title={bar.label}
                  rows={[
                    { label: bar.kind === 'delta' ? 'Impacto' : 'Importe', value: formatARS(bar.value) },
                    { label: 'Acumulado', value: formatARS(bar.running), emphasis: true },
                  ]}
                />
              )
            }}
          />
          {/* Tramo invisible que empuja la barra visible hasta su posición. */}
          <Bar dataKey="base" stackId="wf" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="span" stackId="wf" radius={[3, 3, 0, 0]} maxBarSize={54}>
            {bars.map(b => <Cell key={b.key} fill={colorFor(b)} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export function waterfallSummaryText(summary: ChartsSummary): string {
  return (
    `De ${formatARS(summary.net_sales)} de ingresos netos, ${formatARS(summary.cogs)} se fueron en ` +
    `costo de mercadería y ${formatARS(summary.operating_expenses)} en gastos operativos, ` +
    `dejando ${formatARS(summary.operating_result)} de resultado operativo.`
  )
}
