import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import { colors, fontSize } from '../../../lib/tokens'
import {
  CHART_COLORS, SERIE_LABELS, bucketLabelFor, bucketTitleFor, formatAxisARS, formatARS,
} from '../../../lib/finance/chartsL1Presentation'
import { SeriesTooltip } from './FinanceTooltip'
import type { ChartGranularity, PnlPoint, ChartsSummary } from '../../../services/financeChartsService'

// ─── §7 — Resultado del negocio ──────────────────────────────────────────────
//
// Pregunta: ¿estoy ganando?
//
// Fuente: v_finance_pnl (devengado, ledger canónico). React NO reconstruye el
// P&L: recibe los puntos ya calculados y sólo los dibuja.
//
// Los retiros del dueño no aparecen: no son gasto operativo.
// Caja y devengado no se mezclan: esta serie es 100 % devengada.

const AXIS_STYLE = { fontSize: 10, fill: 'var(--text-subtle)' }

export interface ResultChartProps {
  series: PnlPoint[]
  granularity: ChartGranularity
  summary: ChartsSummary
  height?: number
}

export function ResultChart({ series, granularity, summary, height = 280 }: ResultChartProps) {
  // El resultado puede ser negativo: el eje debe poder bajar de 0 y hay que
  // dibujar la línea de cero para que la pérdida se lea como pérdida.
  const hayNegativos = series.some(p => p.operating_result < 0)

  return (
    <div style={{ width: '100%', height }} data-testid="chart-result">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={series} margin={{ top: 8, right: 4, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={(b: string) => bucketLabelFor(b, granularity)}
            tick={AXIS_STYLE}
            axisLine={{ stroke: 'var(--border-subtle)' }}
            tickLine={false}
            minTickGap={16}
          />
          <YAxis
            tickFormatter={formatAxisARS}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
            width={58}
          />
          {hayNegativos && <ReferenceLine y={0} stroke="var(--border-strong)" strokeWidth={1} />}
          <Tooltip
            cursor={{ fill: 'var(--bg-hover)', opacity: 0.45 }}
            content={(props) => (
              <SeriesTooltip
                {...props}
                titleFor={(p) => bucketTitleFor(String(p.bucket ?? ''), granularity)}
                labels={{
                  net_sales: SERIE_LABELS.net_sales,
                  cogs: SERIE_LABELS.cogs,
                  operating_expenses: SERIE_LABELS.operating_expenses,
                  operating_result: SERIE_LABELS.operating_result,
                }}
                emphasize={['operating_result']}
              />
            )}
          />
          <Legend
            verticalAlign="top"
            align="left"
            height={26}
            iconType="circle"
            iconSize={7}
            wrapperStyle={{ fontSize: 11, color: 'var(--text-muted)' }}
          />
          {/* Barras para los componentes; línea para el resultado. La forma —no
              sólo el color— distingue las series (§45). */}
          <Bar dataKey="net_sales" name={SERIE_LABELS.net_sales}
               fill={CHART_COLORS.revenue} radius={[3, 3, 0, 0]} maxBarSize={22} />
          <Bar dataKey="cogs" name={SERIE_LABELS.cogs}
               fill={CHART_COLORS.cogs} radius={[3, 3, 0, 0]} maxBarSize={22} />
          <Bar dataKey="operating_expenses" name={SERIE_LABELS.operating_expenses}
               fill={CHART_COLORS.expenses} radius={[3, 3, 0, 0]} maxBarSize={22} />
          <Line
            type="monotone"
            dataKey="operating_result"
            name={SERIE_LABELS.operating_result}
            stroke={summary.operating_result >= 0 ? CHART_COLORS.result : CHART_COLORS.resultNegative}
            strokeWidth={2.25}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Resumen textual del gráfico (§31). */
export function resultSummaryText(summary: ChartsSummary): string {
  const signo = summary.operating_result >= 0 ? 'ganancia' : 'pérdida'
  return (
    `En el período el resultado operativo fue ${formatARS(summary.operating_result)} ` +
    `(${signo}), con ${formatARS(summary.net_sales)} de ingresos netos, ` +
    `${formatARS(summary.cogs)} de costo de mercadería y ` +
    `${formatARS(summary.operating_expenses)} de gastos operativos.`
  )
}

/** Nota al pie: los retiros existen, pero fuera del P&L (§9). */
export function OwnerWithdrawalsNote({ amount }: { amount: number }) {
  if (!Number.isFinite(amount) || amount <= 0) return null
  return (
    <p style={{ margin: 0, fontSize: fontSize.xs, color: colors.text.muted }}>
      Retiros del período: <strong style={{ color: colors.text.secondary }}>{formatARS(amount)}</strong>
      {' '}— no se computan como gasto operativo.
    </p>
  )
}
