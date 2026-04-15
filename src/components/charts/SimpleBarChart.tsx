interface DataPoint {
  label: string
  value: number
  color?: string
}

interface SimpleBarChartProps {
  data: DataPoint[]
  title?: string
  height?: number
  maxValue?: number
}

export function SimpleBarChart({ 
  data, 
  title, 
  height = 200,
  maxValue 
}: SimpleBarChartProps) {
  const max = maxValue || Math.max(...data.map(d => d.value))
  const barWidth = 60
  const gap = 20
  const chartWidth = data.length * (barWidth + gap)
  
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
      
      <svg 
        width="100%" 
        height={height + 40}
        viewBox={`0 0 ${chartWidth} ${height + 40}`}
        style={{ maxWidth: '100%' }}
      >
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio, i) => (
          <line
            key={i}
            x1={0}
            y1={height - (ratio * height)}
            x2={chartWidth}
            y2={height - (ratio * height)}
            stroke="#374151"
            strokeWidth={1}
            strokeDasharray="2,2"
          />
        ))}
        
        {/* Bars */}
        {data.map((item, index) => {
          const barHeight = (item.value / max) * height
          const x = index * (barWidth + gap)
          const y = height - barHeight
          
          return (
            <g key={index}>
              {/* Bar */}
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                fill={item.color || '#6366f1'}
                rx={4}
                opacity={0.8}
              />
              
              {/* Value label */}
              <text
                x={x + barWidth / 2}
                y={y - 8}
                textAnchor="middle"
                fill="#f8fafc"
                fontSize={12}
                fontWeight={600}
              >
                {item.value}
              </text>
              
              {/* X-axis label */}
              <text
                x={x + barWidth / 2}
                y={height + 20}
                textAnchor="middle"
                fill="#a0aec0"
                fontSize={11}
              >
                {item.label}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
