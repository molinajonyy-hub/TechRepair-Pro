import type { MonthPoint } from '../../services/financeService'

const fmt = (v: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(v || 0)

interface FinanceLineChartProps {
  data: MonthPoint[]
}

export function FinanceLineChart({ data }: FinanceLineChartProps) {
  if (data.length < 2) return null
  const W = 200, H = 100
  const vals = data.map(d => d.net)
  const minV = Math.min(...vals)
  const maxV = Math.max(...vals)
  const range = maxV - minV || 1
  const scaleY = (v: number) => H - ((v - minV) / range) * (H - 16) - 8
  const scaleX = (i: number) => (i / (data.length - 1)) * W
  const points = data.map((d, i) => `${scaleX(i).toFixed(1)},${scaleY(d.net).toFixed(1)}`).join(' ')
  const zeroY = scaleY(0)

  return (
    <svg viewBox={`0 0 ${W} ${H + 14}`} style={{ width: '100%', height: '100%', overflow: 'visible' }}>
      {minV < 0 && maxV > 0 && (
        <line x1={0} y1={zeroY} x2={W} y2={zeroY}
          stroke="rgba(255,255,255,0.08)" strokeDasharray="3,3" strokeWidth={0.8} />
      )}
      <polyline points={points} fill="none"
        stroke="rgba(99,102,241,0.7)" strokeWidth={1.5}
        strokeLinejoin="round" strokeLinecap="round" />
      {data.map((d, i) => (
        <circle key={i} cx={scaleX(i)} cy={scaleY(d.net)} r={2.5}
          fill={d.net >= 0 ? '#34d399' : '#f87171'}
          stroke="#0b1220" strokeWidth={1}>
          <title>{d.label}: {fmt(d.net)}</title>
        </circle>
      ))}
      {data.map((d, i) => (
        <text key={i} x={scaleX(i)} y={H + 12}
          textAnchor="middle" fontSize={6} fill="#475569">
          {d.label.slice(0, 3)}
        </text>
      ))}
    </svg>
  )
}
