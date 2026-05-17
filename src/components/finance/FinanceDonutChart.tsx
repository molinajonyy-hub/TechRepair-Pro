import type { DistributionSlice } from '../../services/financeService'

interface FinanceDonutChartProps {
  slices: DistributionSlice[]
}

export function FinanceDonutChart({ slices }: FinanceDonutChartProps) {
  if (!slices.length) return null
  const R = 38, r = 24, cx = 50, cy = 50
  let cumAngle = -Math.PI / 2

  const arcs = slices.map(s => {
    const angle = (s.pct / 100) * Math.PI * 2
    const x1 = cx + R * Math.cos(cumAngle)
    const y1 = cy + R * Math.sin(cumAngle)
    cumAngle += angle
    const x2 = cx + R * Math.cos(cumAngle)
    const y2 = cy + R * Math.sin(cumAngle)
    const xi1 = cx + r * Math.cos(cumAngle - angle)
    const yi1 = cy + r * Math.sin(cumAngle - angle)
    const xi2 = cx + r * Math.cos(cumAngle)
    const yi2 = cy + r * Math.sin(cumAngle)
    const large = angle > Math.PI ? 1 : 0
    return { ...s, d: `M${x1},${y1} A${R},${R},0,${large},1,${x2},${y2} L${xi2},${yi2} A${r},${r},0,${large},0,${xi1},${yi1} Z` }
  })

  return (
    <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
      {arcs.map((a, i) => (
        <path key={i} d={a.d} fill={a.color} opacity={0.85}>
          <title>{a.label}: {a.pct.toFixed(1)}%</title>
        </path>
      ))}
      <circle cx={cx} cy={cy} r={r - 1} fill="#0b1220" />
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize={7} fill="#94a3b8">Total</text>
      <text x={cx} y={cy + 7} textAnchor="middle" fontSize={8} fontWeight="700" fill="#f8fafc">
        {slices.length}
      </text>
      <text x={cx} y={cy + 15} textAnchor="middle" fontSize={6} fill="#64748b">tipos</text>
    </svg>
  )
}
