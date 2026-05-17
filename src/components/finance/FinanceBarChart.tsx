import type { MonthPoint } from '../../services/financeService'

const fmt = (v: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(v || 0)

interface FinanceBarChartProps {
  data: MonthPoint[]
}

export function FinanceBarChart({ data }: FinanceBarChartProps) {
  if (!data.length) return null
  const H = 160
  const W = 100
  const maxVal = Math.max(...data.flatMap(d => [d.income, d.expenses]), 1)
  const barW = Math.max(8, Math.min(22, (W / data.length) * 0.35))
  const gap = (W - data.length * barW * 2.5) / (data.length + 1)

  return (
    <svg viewBox={`0 0 ${W} ${H + 24}`} style={{ width: '100%', height: '100%', overflow: 'visible' }}>
      {data.map((d, i) => {
        const x = gap + i * (W / data.length) + gap * 0.2
        const incH = (d.income / maxVal) * H
        const expH = (d.expenses / maxVal) * H
        return (
          <g key={i}>
            <rect x={x} y={H - incH} width={barW} height={incH} rx={2} fill="rgba(52,211,153,0.7)">
              <title>{d.label}: Ingresos {fmt(d.income)}</title>
            </rect>
            <rect x={x + barW + 2} y={H - expH} width={barW} height={expH} rx={2} fill="rgba(248,113,113,0.7)">
              <title>{d.label}: Egresos {fmt(d.expenses)}</title>
            </rect>
            <text x={x + barW} y={H + 14} textAnchor="middle" fontSize={7} fill="#64748b">
              {d.label}
            </text>
          </g>
        )
      })}
      <rect x={2} y={H + 18} width={6} height={4} rx={1} fill="rgba(52,211,153,0.7)" />
      <text x={10} y={H + 22} fontSize={6} fill="#94a3b8">Ingresos</text>
      <rect x={38} y={H + 18} width={6} height={4} rx={1} fill="rgba(248,113,113,0.7)" />
      <text x={46} y={H + 22} fontSize={6} fill="#94a3b8">Egresos</text>
    </svg>
  )
}
