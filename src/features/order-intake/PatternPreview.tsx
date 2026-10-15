/**
 * BETA-UX-2 · hotfix — vista de sólo lectura de un patrón de desbloqueo.
 *
 * Reemplaza el texto «Patrón: 1 → 4 → 7» por la grilla 3×3 con los puntos
 * marcados y unidos en orden, como se ve en el teléfono. El orden no depende
 * sólo del trazo: el primer punto lleva un aro y cada punto marcado su número.
 * Para el lector de pantalla, la secuencia en palabras (`role="img"`).
 *
 * Recibe los puntos YA en la numeración de la grilla (1–9, fila por fila). Si
 * el patrón guardado no puede leerse con certeza, este componente NO se usa
 * (ver `classifyStoredPattern` en model.ts y `DeviceLockCard`).
 */
const CELL = 40
const ORIGIN = 20
const center = (point: number) => ({
  x: ORIGIN + ((point - 1) % 3) * CELL,
  y: ORIGIN + Math.floor((point - 1) / 3) * CELL,
})

export function describePattern(points: number[]): string {
  return `Patrón de ${points.length} puntos, en orden: ${points.join(', ')}. Los puntos se numeran del 1 al 9, fila por fila, empezando arriba a la izquierda.`
}

export function PatternPreview({ points, testId }: { points: number[]; testId?: string }) {
  const trazo = points.map(point => { const c = center(point); return `${c.x},${c.y}` }).join(' ')
  const inicio = center(points[0])
  return (
    <svg className="pattern-preview" viewBox="0 0 120 120" role="img" aria-label={describePattern(points)} data-testid={testId}>
      <rect className="pattern-preview__surface" x="1" y="1" width="118" height="118" rx="16" />
      {points.length > 1 && <polyline className="pattern-preview__line" points={trazo} />}
      {Array.from({ length: 9 }, (_, index) => index + 1).map(point => {
        const { x, y } = center(point)
        const orden = points.indexOf(point)
        if (orden < 0) return <circle key={point} className="pattern-preview__dot" cx={x} cy={y} r={4.5} />
        return (
          <g key={point}>
            <circle className="pattern-preview__node" cx={x} cy={y} r={9} />
            <text className="pattern-preview__order" x={x} y={y} textAnchor="middle" dominantBaseline="central">{orden + 1}</text>
          </g>
        )
      })}
      <circle className="pattern-preview__start" cx={inicio.x} cy={inicio.y} r={13} />
    </svg>
  )
}
