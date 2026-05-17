import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  X, ArrowUpRight, ArrowDownRight, RotateCcw, Wrench,
  FileText, Truck, Settings2, ExternalLink,
  TrendingUp, TrendingDown, Package,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Movement {
  id: string
  inventory_item_id: string
  movement_type: string
  quantity: number
  previous_stock: number
  new_stock: number
  reference_type: string | null
  reference_id: string | null
  note: string | null
  created_at: string
  created_by: string | null
}

interface Props {
  item: { id: string; name: string; code: string; stock_quantity: number; category?: string }
  businessId: string
  onClose: () => void
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_META: Record<string, { label: string; dir: 'in' | 'out' | 'adj'; color: string; icon: typeof ArrowUpRight }> = {
  sale:         { label: 'Venta',           dir: 'out', color: '#f87171', icon: ArrowDownRight },
  purchase:     { label: 'Compra',          dir: 'in',  color: '#34d399', icon: ArrowUpRight  },
  order_usage:  { label: 'Uso en orden',    dir: 'out', color: '#fb923c', icon: Wrench        },
  return:       { label: 'Devolución',      dir: 'in',  color: '#60a5fa', icon: RotateCcw     },
  cancellation: { label: 'Anulación',       dir: 'in',  color: '#a78bfa', icon: RotateCcw     },
  in:           { label: 'Ingreso manual',  dir: 'in',  color: '#34d399', icon: ArrowUpRight  },
  out:          { label: 'Egreso manual',   dir: 'out', color: '#f87171', icon: ArrowDownRight },
  adjustment:   { label: 'Ajuste',          dir: 'adj', color: '#fbbf24', icon: Settings2     },
  credit_note:  { label: 'Nota de crédito', dir: 'in',  color: '#a78bfa', icon: FileText      },
}

const REF_LABELS: Record<string, string> = {
  comprobante: 'Comprobante', order: 'Orden', purchase: 'Compra proveedor',
  manual: 'Manual', adjustment: 'Ajuste', supplier_return: 'Dev. proveedor', credit_note: 'Nota crédito',
}

import { fmtDate, fmtTime } from '../../utils/dateUtils'

// ─── ProductMovementsModal ────────────────────────────────────────────────────

export function ProductMovementsModal({ item, businessId, onClose }: Props) {
  const navigate = useNavigate()
  const [movs, setMovs] = useState<Movement[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('inventory_movements').select('*')
      .eq('inventory_item_id', item.id)
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .then(({ data }) => { setMovs((data || []) as Movement[]); setLoading(false) })
  }, [item.id, businessId])

  const stats = useMemo(() => {
    const totalIn  = movs.filter(m => m.quantity > 0).reduce((s, m) => s + m.quantity, 0)
    const totalOut = movs.filter(m => m.quantity < 0).reduce((s, m) => s + Math.abs(m.quantity), 0)
    const lastMov  = movs[0]
    const daysSinceFirst = movs.length > 0
      ? Math.floor((Date.now() - new Date(movs[movs.length - 1].created_at).getTime()) / 86_400_000)
      : null
    return { totalIn, totalOut, lastMov, daysSinceFirst }
  }, [movs])

  const handleRef = (m: Movement) => {
    if (!m.reference_id) return
    if (m.reference_type === 'comprobante') { onClose(); navigate(`/comprobantes/${m.reference_id}`) }
    else if (m.reference_type === 'order')  { onClose(); navigate(`/orders/${m.reference_id}`) }
    else if (m.reference_type === 'purchase') { onClose(); navigate('/suppliers') }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: '#0f172a', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '1rem', width: '100%', maxWidth: 720, maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: 36, height: 36, borderRadius: '0.5rem', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Package size={17} style={{ color: '#818cf8' }} />
            </div>
            <div>
              <h3 style={{ fontWeight: 800, color: '#f8fafc', margin: 0, fontSize: '1rem' }}>{item.name}</h3>
              <p style={{ margin: 0, fontSize: '0.72rem', color: '#475569' }}>{item.code}{item.category ? ` · ${item.category}` : ''}</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
          {[
            { label: 'Stock actual',  value: item.stock_quantity, color: item.stock_quantity === 0 ? '#f87171' : '#818cf8' },
            { label: 'Total ingresado', value: `+${stats.totalIn}`, color: '#34d399' },
            { label: 'Total egresado',  value: `-${stats.totalOut}`, color: '#f87171' },
            { label: 'Días en sistema', value: stats.daysSinceFirst ?? '—', color: '#94a3b8' },
          ].map(s => (
            <div key={s.label} style={{ padding: '0.75rem 1rem', borderRight: '1px solid rgba(255,255,255,0.04)' }}>
              <div style={{ fontSize: '0.66rem', color: '#334155', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>{s.label}</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 800, fontFamily: 'monospace', color: s.color }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Timeline */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 0' }}>
          {loading ? (
            <div style={{ padding: '3rem', textAlign: 'center', color: '#475569', fontSize: '0.875rem' }}>Cargando historial...</div>
          ) : movs.length === 0 ? (
            <div style={{ padding: '3rem', textAlign: 'center' }}>
              <Package size={28} style={{ margin: '0 auto 0.75rem', color: '#1e293b' }} />
              <p style={{ color: '#334155', fontSize: '0.875rem', margin: 0 }}>Sin movimientos registrados</p>
            </div>
          ) : (
            <div style={{ position: 'relative', paddingLeft: '2.5rem' }}>
              {/* Vertical line */}
              <div style={{ position: 'absolute', left: '1.5rem', top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,0.05)' }} />

              {movs.map((m, idx) => {
                const meta    = TYPE_META[m.movement_type] ?? { label: m.movement_type, dir: 'adj', color: '#94a3b8', icon: Settings2 }
                const Icon    = meta.icon
                const isIn    = m.quantity > 0
                const canNav  = m.reference_id && ['comprobante','order','purchase'].includes(m.reference_type || '')
                const isFirst = idx === movs.length - 1

                return (
                  <div key={m.id} style={{ position: 'relative', paddingLeft: '1.25rem', paddingBottom: '1rem' }}>
                    {/* Dot */}
                    <div style={{ position: 'absolute', left: '-0.875rem', top: '0.125rem', width: 14, height: 14, borderRadius: '50%', background: meta.color, border: '2px solid #0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Icon size={7} style={{ color: '#0f172a' }} />
                    </div>

                    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '0.625rem', padding: '0.75rem 1rem' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: '0.25rem', background: meta.color + '18', color: meta.color }}>
                              {meta.label}
                            </span>
                            {isFirst && <span style={{ fontSize: '0.66rem', color: '#475569', background: 'rgba(255,255,255,0.04)', padding: '0.1rem 0.4rem', borderRadius: '0.25rem' }}>primer registro</span>}
                          </div>
                          {m.note && (
                            <p style={{ margin: '0.375rem 0 0', fontSize: '0.8rem', color: '#94a3b8' }}>{m.note}</p>
                          )}
                          {m.reference_type && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.3rem' }}>
                              {m.reference_type === 'comprobante' && <FileText size={10} style={{ color: '#818cf8' }} />}
                              {m.reference_type === 'order'       && <Wrench   size={10} style={{ color: '#34d399' }} />}
                              {m.reference_type === 'purchase'    && <Truck    size={10} style={{ color: '#fb923c' }} />}
                              <span style={{ fontSize: '0.72rem', color: '#475569' }}>{REF_LABELS[m.reference_type] ?? m.reference_type}</span>
                              {canNav && (
                                <button onClick={() => handleRef(m)}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#334155', padding: 0, display: 'flex', alignItems: 'center' }}
                                  onMouseEnter={e => (e.currentTarget.style.color = '#818cf8')}
                                  onMouseLeave={e => (e.currentTarget.style.color = '#334155')}>
                                  <ExternalLink size={11} />
                                </button>
                              )}
                            </div>
                          )}
                        </div>

                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '1rem', color: isIn ? '#34d399' : '#f87171' }}>
                            {isIn ? '+' : ''}{m.quantity}
                          </div>
                          <div style={{ fontSize: '0.68rem', color: '#334155', fontFamily: 'monospace' }}>
                            {m.previous_stock ?? '—'} → {m.new_stock ?? '—'}
                          </div>
                          <div style={{ fontSize: '0.66rem', color: '#334155', marginTop: '0.2rem' }}>
                            {fmtDate(m.created_at)} {fmtTime(m.created_at)}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer stats */}
        {movs.length > 0 && (
          <div style={{ padding: '0.75rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.05)', flexShrink: 0, display: 'flex', gap: '1.5rem', fontSize: '0.78rem', color: '#475569' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              <TrendingUp size={12} style={{ color: '#34d399' }} /> {movs.filter(m => m.quantity > 0).length} ingresos
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              <TrendingDown size={12} style={{ color: '#f87171' }} /> {movs.filter(m => m.quantity < 0).length} egresos
            </span>
            <span>{movs.length} movimientos en total</span>
          </div>
        )}
      </div>
    </div>
  )
}
