import { useState, useRef, useCallback, useEffect } from 'react'
import { Lock, Eye, EyeOff, Save, Edit2, Trash2, KeyRound, Grid3X3 } from 'lucide-react'

// ─── Pattern Lock (9 puntos 3×3) ─────────────────────────────────────────────

const DOT_COUNT = 9
const SVG_SIZE  = 210
const PADDING   = 35
const CELL      = (SVG_SIZE - PADDING * 2) / 2  // 70

function dotPos(idx: number) {
  const row = Math.floor(idx / 3)
  const col = idx % 3
  return { x: PADDING + col * CELL, y: PADDING + row * CELL }
}

interface PatternInputProps {
  value: number[]                         // secuencia de índices 0-8
  onChange: (seq: number[]) => void
  readonly?: boolean
}

function PatternInput({ value, onChange, readonly = false }: PatternInputProps) {
  const [drawing, setDrawing]   = useState(false)
  const [pattern, setPattern]   = useState<number[]>(readonly ? value : [])
  const [cursor,  setCursor]    = useState<{x:number;y:number}|null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // En modo readonly mostrar el value siempre
  const displayed = readonly ? value : pattern

  const getSVGPoint = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return null
    const scaleX = SVG_SIZE / rect.width
    const scaleY = SVG_SIZE / rect.height
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY }
  }

  const dotHitTest = (svgX: number, svgY: number) => {
    for (let i = 0; i < DOT_COUNT; i++) {
      const p = dotPos(i)
      if (Math.hypot(svgX - p.x, svgY - p.y) < 22) return i
    }
    return -1
  }

  const startDraw = useCallback((clientX: number, clientY: number) => {
    if (readonly) return
    const pt = getSVGPoint(clientX, clientY)
    if (!pt) return
    const hit = dotHitTest(pt.x, pt.y)
    if (hit === -1) return
    setDrawing(true)
    setPattern([hit])
    setCursor(pt)
  }, [readonly])

  const moveDraw = useCallback((clientX: number, clientY: number) => {
    if (!drawing || readonly) return
    const pt = getSVGPoint(clientX, clientY)
    if (!pt) return
    setCursor(pt)
    const hit = dotHitTest(pt.x, pt.y)
    if (hit !== -1) {
      setPattern(prev => prev.includes(hit) ? prev : [...prev, hit])
    }
  }, [drawing, readonly])

  const endDraw = useCallback(() => {
    if (!drawing) return
    setDrawing(false)
    setCursor(null)
    if (pattern.length >= 2) onChange(pattern)
    else setPattern([])
  }, [drawing, pattern, onChange])

  // Mouse
  const onMouseDown = (e: React.MouseEvent) => startDraw(e.clientX, e.clientY)
  const onMouseMove = (e: React.MouseEvent) => moveDraw(e.clientX, e.clientY)
  const onMouseUp   = () => endDraw()

  // Touch
  const onTouchStart = (e: React.TouchEvent) => { e.preventDefault(); startDraw(e.touches[0].clientX, e.touches[0].clientY) }
  const onTouchMove  = (e: React.TouchEvent) => { e.preventDefault(); moveDraw(e.touches[0].clientX, e.touches[0].clientY) }
  const onTouchEnd   = () => endDraw()

  // Lines between consecutive pattern dots
  const lines: {x1:number;y1:number;x2:number;y2:number}[] = []
  for (let i = 0; i < displayed.length - 1; i++) {
    const a = dotPos(displayed[i]); const b = dotPos(displayed[i+1])
    lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
        width={SVG_SIZE}
        height={SVG_SIZE}
        style={{
          touchAction: 'none',
          cursor: readonly ? 'default' : 'crosshair',
          userSelect: 'none',
          background: 'rgba(15,23,42,0.6)',
          borderRadius: '1rem',
          border: '1px solid rgba(99,102,241,0.2)',
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Lines between selected dots */}
        {lines.map((l, i) => (
          <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
            stroke="rgba(99,102,241,0.7)" strokeWidth={3} strokeLinecap="round" />
        ))}

        {/* Line to cursor (while drawing) */}
        {drawing && cursor && displayed.length > 0 && (() => {
          const last = dotPos(displayed[displayed.length - 1])
          return <line x1={last.x} y1={last.y} x2={cursor.x} y2={cursor.y}
            stroke="rgba(99,102,241,0.4)" strokeWidth={2} strokeLinecap="round" strokeDasharray="4 3" />
        })()}

        {/* Dots */}
        {Array.from({ length: DOT_COUNT }, (_, i) => {
          const p = dotPos(i)
          const active = displayed.includes(i)
          const order  = displayed.indexOf(i)
          return (
            <g key={i}>
              {/* Outer ring */}
              <circle cx={p.x} cy={p.y} r={18}
                fill={active ? 'rgba(99,102,241,0.15)' : 'transparent'}
                stroke={active ? 'rgba(99,102,241,0.5)' : 'transparent'}
                strokeWidth={1.5} />
              {/* Inner dot */}
              <circle cx={p.x} cy={p.y} r={active ? 9 : 6}
                fill={active ? '#6366f1' : 'rgba(148,163,184,0.35)'}
                style={{ transition: 'r 0.12s, fill 0.12s' }} />
              {/* Order number */}
              {active && (
                <text x={p.x} y={p.y + 1} textAnchor="middle" dominantBaseline="middle"
                  fill="white" fontSize={8} fontWeight="bold" style={{ pointerEvents: 'none' }}>
                  {order + 1}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {!readonly && (
        <p style={{ fontSize: '0.72rem', color: '#64748b', margin: 0 }}>
          {pattern.length === 0
            ? 'Dibujá el patrón arrastrando por los puntos'
            : pattern.length < 2
              ? 'Conectá al menos 2 puntos'
              : `Patrón: ${pattern.length} puntos — soltá para guardar`}
        </p>
      )}
    </div>
  )
}

// ─── DeviceLockCard ───────────────────────────────────────────────────────────

interface DeviceLockCardProps {
  orderId: string
  initialValue?: string | null        // formato: "pattern:0-1-2" | "pin:1234" | "text:abc"
  onSave: (encoded: string | null) => Promise<void>
}

type LockType = 'pattern' | 'pin' | 'text'

function decode(raw: string | null | undefined): { type: LockType; value: string; pattern: number[] } {
  if (!raw) return { type: 'pattern', value: '', pattern: [] }
  if (raw.startsWith('pattern:')) {
    const seq = raw.slice(8).split('-').map(Number).filter(n => !isNaN(n))
    return { type: 'pattern', value: raw.slice(8), pattern: seq }
  }
  if (raw.startsWith('pin:')) return { type: 'pin', value: raw.slice(4), pattern: [] }
  if (raw.startsWith('text:')) return { type: 'text', value: raw.slice(5), pattern: [] }
  return { type: 'text', value: raw, pattern: [] }
}

function encode(type: LockType, value: string, pattern: number[]): string {
  if (type === 'pattern') return `pattern:${pattern.join('-')}`
  if (type === 'pin')     return `pin:${value}`
  return `text:${value}`
}

export function DeviceLockCard({ orderId: _orderId, initialValue, onSave }: DeviceLockCardProps) {
  const saved = decode(initialValue)

  const [editing,  setEditing]  = useState(false)
  const [saving,   setSaving]   = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [lockType, setLockType] = useState<LockType>(saved.type)
  const [textVal,  setTextVal]  = useState(saved.value)
  const [patSeq,   setPatSeq]   = useState<number[]>(saved.pattern)

  // Sync if parent changes
  useEffect(() => {
    const d = decode(initialValue)
    setLockType(d.type)
    setTextVal(d.value)
    setPatSeq(d.pattern)
  }, [initialValue])

  const hasValue = initialValue && initialValue.length > 0

  const handleSave = async () => {
    setSaving(true)
    try {
      let encoded: string | null = null
      if (lockType === 'pattern' && patSeq.length >= 2) {
        encoded = encode('pattern', '', patSeq)
      } else if ((lockType === 'pin' || lockType === 'text') && textVal.trim()) {
        encoded = encode(lockType, textVal.trim(), [])
      }
      await onSave(encoded)
      setEditing(false)
      setRevealed(false)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('¿Eliminar la contraseña/patrón guardado?')) return
    setSaving(true)
    try {
      await onSave(null)
      setTextVal('')
      setPatSeq([])
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    const d = decode(initialValue)
    setLockType(d.type)
    setTextVal(d.value)
    setPatSeq(d.pattern)
    setEditing(false)
    setRevealed(false)
  }

  // ── Render saved (read) state ─────────────────────────────────────────────

  const renderSaved = () => {
    if (!hasValue) return (
      <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0 }}>
        No hay contraseña ni patrón guardado
      </p>
    )

    if (saved.type === 'pattern') {
      return revealed
        ? <PatternInput value={saved.pattern} onChange={() => {}} readonly />
        : <p style={{ color: '#94a3b8', fontSize: '0.875rem', margin: 0 }}>
            🔒 Patrón guardado ({saved.pattern.length} puntos) — hacé clic en el ojo para ver
          </p>
    }

    const label = saved.type === 'pin' ? 'PIN' : 'Contraseña'
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <span style={{ fontSize: '0.875rem', color: '#94a3b8' }}>
          {label}:&nbsp;
          <span style={{ fontFamily: 'monospace', color: '#e2e8f0', letterSpacing: revealed ? 'normal' : '0.2em' }}>
            {revealed ? saved.value : '•'.repeat(Math.min(saved.value.length, 10))}
          </span>
        </span>
      </div>
    )
  }

  // ── Render edit state ─────────────────────────────────────────────────────

  const tabBtn = (t: LockType, icon: React.ReactNode, label: string) => (
    <button onClick={() => setLockType(t)} style={{
      flex: 1, padding: '0.5rem', display: 'flex', alignItems: 'center',
      justifyContent: 'center', gap: '0.375rem', fontSize: '0.8rem', fontWeight: 500,
      border: 'none', borderRadius: '0.5rem', cursor: 'pointer', transition: 'all 0.15s',
      background: lockType === t ? 'rgba(99,102,241,0.2)' : 'transparent',
      color: lockType === t ? '#a5b4fc' : '#64748b',
      outline: lockType === t ? '1px solid rgba(99,102,241,0.4)' : 'none',
    }}>
      {icon}{label}
    </button>
  )

  return (
    <div className="card" style={{ marginTop: '1rem' }}>
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Lock size={18} style={{ color: '#f59e0b' }} />
          <h3 className="card-title">Contraseña / Patrón del equipo</h3>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {/* Solo mostrar en sistema — badge */}
          <span style={{
            fontSize: '0.65rem', padding: '0.2rem 0.5rem', borderRadius: '9999px',
            background: 'rgba(245,158,11,0.1)', color: '#f59e0b',
            border: '1px solid rgba(245,158,11,0.25)', fontWeight: 500,
          }}>🔒 Solo interno</span>
          {!editing && hasValue && (
            <button onClick={() => setRevealed(r => !r)} title={revealed ? 'Ocultar' : 'Mostrar'}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: '0.25rem', display:'flex' }}>
              {revealed ? <EyeOff size={16}/> : <Eye size={16}/>}
            </button>
          )}
          {!editing && (
            <button onClick={() => setEditing(true)} title="Editar"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: '0.25rem', display:'flex' }}>
              <Edit2 size={16}/>
            </button>
          )}
          {!editing && hasValue && (
            <button onClick={handleDelete} disabled={saving} title="Eliminar"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: '0.25rem', display:'flex' }}>
              <Trash2 size={16}/>
            </button>
          )}
        </div>
      </div>

      <div className="card-body">
        {!editing ? (
          renderSaved()
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Type selector */}
            <div style={{ display: 'flex', gap: '0.5rem', padding: '0.25rem', background: 'rgba(15,23,42,0.5)', borderRadius: '0.625rem' }}>
              {tabBtn('pattern', <Grid3X3 size={14}/>, 'Patrón')}
              {tabBtn('pin',     <KeyRound size={14}/>, 'PIN numérico')}
              {tabBtn('text',    <Lock size={14}/>,     'Contraseña')}
            </div>

            {/* Input */}
            {lockType === 'pattern' && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                <PatternInput
                  value={patSeq}
                  onChange={seq => setPatSeq(seq)}
                />
                {patSeq.length >= 2 && (
                  <p style={{ fontSize: '0.75rem', color: '#6ee7b7', margin: 0 }}>
                    ✓ Patrón listo ({patSeq.length} puntos)
                  </p>
                )}
                {patSeq.length >= 2 && (
                  <button onClick={() => setPatSeq([])}
                    style={{ fontSize: '0.75rem', color: '#f87171', background: 'none', border: 'none', cursor: 'pointer' }}>
                    Limpiar patrón
                  </button>
                )}
              </div>
            )}

            {lockType === 'pin' && (
              <input
                type="number"
                placeholder="Ej: 1234"
                value={textVal}
                onChange={e => setTextVal(e.target.value)}
                style={{
                  padding: '0.625rem 0.875rem', borderRadius: '0.5rem', fontSize: '1.25rem',
                  fontFamily: 'monospace', letterSpacing: '0.3em', textAlign: 'center',
                  background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)',
                  color: '#f1f5f9', outline: 'none', width: '100%',
                }}
              />
            )}

            {lockType === 'text' && (
              <input
                type="text"
                placeholder="Contraseña del equipo"
                value={textVal}
                onChange={e => setTextVal(e.target.value)}
                style={{
                  padding: '0.625rem 0.875rem', borderRadius: '0.5rem', fontSize: '0.9rem',
                  background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)',
                  color: '#f1f5f9', outline: 'none', width: '100%',
                }}
              />
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button onClick={handleSave} disabled={saving ||
                  (lockType === 'pattern' && patSeq.length < 2) ||
                  ((lockType === 'pin' || lockType === 'text') && !textVal.trim())}
                style={{
                  flex: 1, padding: '0.625rem', borderRadius: '0.5rem', border: 'none',
                  background: '#4f46e5', color: '#fff', fontWeight: 500, fontSize: '0.875rem',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                  opacity: (saving || (lockType === 'pattern' && patSeq.length < 2) || ((lockType === 'pin' || lockType === 'text') && !textVal.trim())) ? 0.5 : 1,
                }}>
                <Save size={16}/>{saving ? 'Guardando...' : 'Guardar'}
              </button>
              <button onClick={handleCancel}
                style={{
                  padding: '0.625rem 1rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.1)',
                  background: 'transparent', color: '#94a3b8', fontWeight: 500, fontSize: '0.875rem', cursor: 'pointer',
                }}>
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
