interface PieDataPoint {
  label: string
  value: number
  color: string
}

interface SimplePieChartProps {
  data: PieDataPoint[]
  title?: string
  size?: number
}

export function SimplePieChart({ 
  data, 
  title, 
  size = 200 
}: SimplePieChartProps) {
  const total = data.reduce((sum, item) => sum + item.value, 0)
  const radius = size / 2 - 20
  const center = size / 2
  
  let currentAngle = 0
  
  return (
    <div style={{ width: '100%' }}>
      {title && (
        <h4 style={{ 
          fontSize: '0.875rem', 
          fontWeight: 600, 
          color: '#f8fafc',
          marginBottom: '1rem'
        }}>
          {title}
        </h4>
      )}
      
      <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
        {/* Pie Chart */}
        <svg width={size} height={size}>
          {data.map((item, index) => {
            const angle = (item.value / total) * 360
            const startAngle = currentAngle
            const endAngle = currentAngle + angle
            
            const startRad = (startAngle * Math.PI) / 180
            const endRad = (endAngle * Math.PI) / 180
            
            const x1 = center + radius * Math.cos(startRad)
            const y1 = center + radius * Math.sin(startRad)
            const x2 = center + radius * Math.cos(endRad)
            const y2 = center + radius * Math.sin(endRad)
            
            const largeArc = angle > 180 ? 1 : 0
            
            const pathData = [
              `M ${center} ${center}`,
              `L ${x1} ${y1}`,
              `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
              'Z'
            ].join(' ')
            
            currentAngle += angle
            
            return (
              <path
                key={index}
                d={pathData}
                fill={item.color}
                stroke="#1a1f2e"
                strokeWidth={2}
              />
            )
          })}
          
          {/* Center hole for donut effect */}
          <circle
            cx={center}
            cy={center}
            r={radius * 0.5}
            fill="#1a1f2e"
          />
          
          {/* Total in center */}
          <text
            x={center}
            y={center - 5}
            textAnchor="middle"
            fill="#f8fafc"
            fontSize={14}
            fontWeight={600}
          >
            {total}
          </text>
          <text
            x={center}
            y={center + 12}
            textAnchor="middle"
            fill="#a0aec0"
            fontSize={10}
          >
            Total
          </text>
        </svg>
        
        {/* Legend */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {data.map((item, index) => (
            <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  backgroundColor: item.color
                }}
              />
              <span style={{ fontSize: '0.875rem', color: '#a0aec0' }}>
                {item.label}: {item.value} ({((item.value / total) * 100).toFixed(0)}%)
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
