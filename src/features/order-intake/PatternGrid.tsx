interface PatternGridProps { value: number[]; onChange: (value: number[]) => void; readOnly?: boolean }

export function PatternGrid({ value, onChange, readOnly = false }: PatternGridProps) {
  const toggle = (point: number) => {
    if (readOnly || value.includes(point)) return
    onChange([...value, point])
  }
  return (
    <div>
      <div className="intake-pattern" role="group" aria-label="Patrón de desbloqueo de 3 por 3">
        {Array.from({ length: 9 }, (_, index) => index + 1).map(point => {
          const order = value.indexOf(point)
          return <button key={point} type="button" className={order >= 0 ? 'is-selected' : ''}
            aria-label={`Punto ${point}${order >= 0 ? `, posición ${order + 1}` : ''}`}
            disabled={readOnly} onClick={() => toggle(point)}>{order >= 0 ? order + 1 : ''}</button>
        })}
      </div>
      {!readOnly && <button type="button" className="btn btn-ghost" disabled={!value.length} onClick={() => onChange([])}>Limpiar patrón</button>}
    </div>
  )
}

