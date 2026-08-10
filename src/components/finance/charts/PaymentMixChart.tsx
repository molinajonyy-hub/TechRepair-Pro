import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { colors, fontSize } from '../../../lib/tokens'
import {
  MIX_COLORS, buildPaymentSlices, formatARS, formatPercent,
  type PaymentSlice,
} from '../../../lib/finance/chartsL1Presentation'
import { ShareTooltip } from './FinanceTooltip'
import type { PaymentMixSlice } from '../../../services/financeChartsService'

// ─── §10 — Cómo cobraste ─────────────────────────────────────────────────────
//
// Pregunta: ¿cómo entra el dinero?
//
// Sólo medios REALES del modelo: las categorías salen de los cobros existentes,
// no de una lista fija inventada. La cola se agrupa en "Otros" para no pasar de
// 6 sectores.
//
// Cuenta corriente NO es un medio de cobro. Un comprobante sin pago no
// participa. Las categorías en 0 % no se muestran.

export interface PaymentMixChartProps {
  mix: PaymentMixSlice[]
  height?: number
}

export function PaymentMixChart({ mix, height = 200 }: PaymentMixChartProps) {
  const slices = buildPaymentSlices(mix)
  const total = slices.reduce((s, m) => s + m.amount, 0)
  if (!slices.length) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }} data-testid="chart-payment-mix">
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="amount"
              nameKey="label"
              innerRadius="58%"
              outerRadius="86%"
              paddingAngle={2}
              stroke="var(--bg-card-solid)"
              strokeWidth={2}
            >
              {slices.map((s, i) => (
                <Cell key={s.method} fill={MIX_COLORS[i % MIX_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip content={(props) => <ShareTooltip {...props} total={total} />} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Leyenda-tabla: el color no es la única vía para leer el dato (§45),
          y en móvil ésta es la lectura principal. */}
      <ul style={{
        listStyle: 'none', margin: 0, padding: 0,
        display: 'flex', flexDirection: 'column', gap: '0.3rem',
      }}>
        {slices.map((s, i) => (
          <li key={s.method} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span aria-hidden="true" style={{
              width: 9, height: 9, borderRadius: 2, flexShrink: 0,
              background: MIX_COLORS[i % MIX_COLORS.length],
            }} />
            <span style={{ fontSize: fontSize.sm, color: colors.text.secondary, flex: 1, minWidth: 0 }}>
              {s.label}
            </span>
            <span style={{
              fontSize: fontSize.xs, color: colors.text.muted, fontVariantNumeric: 'tabular-nums',
            }}>{formatPercent(s.share, { ya100: true })}</span>
            <span style={{
              fontSize: fontSize.sm, fontWeight: 700, color: colors.text.primary,
              fontVariantNumeric: 'tabular-nums', minWidth: 92, textAlign: 'right',
            }}>{formatARS(s.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function paymentMixSummaryText(mix: PaymentMixSlice[]): string {
  const slices: PaymentSlice[] = buildPaymentSlices(mix)
  if (!slices.length) return 'No hay cobros registrados en el período.'
  const top = slices[0]
  const total = slices.reduce((s, m) => s + m.amount, 0)
  return (
    `Cobraste ${formatARS(total)} en el período. El medio principal fue ${top.label} ` +
    `con ${formatARS(top.amount)} (${formatPercent(top.share, { ya100: true })} del total).`
  )
}
