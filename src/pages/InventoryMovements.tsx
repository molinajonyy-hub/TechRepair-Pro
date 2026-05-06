import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowUpRight, ArrowDownRight, RefreshCw, SlidersHorizontal,
  Package, FileText, Truck, ShoppingCart, RotateCcw,
  Wrench, Settings2, AlertTriangle, X, ExternalLink,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDisplayMessage } from '../utils/formatMessage'

// ─── Types ────────────────────────────────────────────────────────────────────

interface MovRow {
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
  business_id: string
  product_name: string
  product_code: string
  product_category: string
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
  comprobante:     'Comprobante',
  order:           'Orden',
  purchase:        'Compra proveedor',
  manual:          'Manual',
  adjustment:      'Ajuste',
  supplier_return: 'Dev. proveedor',
  credit_note:     'Nota de crédito',
}

import { fmtDate, fmtTime, isToday } from '../utils/dateUtils'

// ─── InventoryMovements ───────────────────────────────────────────────────────

export function InventoryMovements() {
  const { businessId } = useAuth()
  const navigate = useNavigate()

  const [rows, setRows]           = useState<MovRow[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(false)

  // Filters
  const [search, setSearch]         = useState('')
  const [dateFrom, setDateFrom]     = useState('')
  const [dateTo, setDateTo]         = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [dirFilter, setDirFilter]   = useState('')    // 'in' | 'out' | 'adj'
  const [page, setPage]             = useState(0)
  const PAGE_SIZE = 150

  // ── Load ──────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!businessId) return
    setLoading(true); setError(null)
    try {
      let q = supabase
        .from('inventory_movements')
        .select('*')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE)
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (dateFrom) q = q.gte('created_at', dateFrom + 'T00:00:00')
      if (dateTo)   q = q.lte('created_at', dateTo + 'T23:59:59')
      if (typeFilter) q = q.eq('movement_type', typeFilter)

      const { data: movs, error: err } = await q
      if (err) throw err

      // Fetch inventory names
      const ids = [...new Set((movs || []).map(m => m.inventory_item_id).filter(Boolean))]
      let invMap: Record<string, { name: string; code: string; category: string }> = {}
      if (ids.length > 0) {
        const { data: invs } = await supabase
          .from('inventory').select('id, name, code, category').in('id', ids)
        for (const inv of invs || []) invMap[inv.id] = { name: inv.name, code: inv.code, category: inv.category || '' }
      }

      const enriched: MovRow[] = (movs || []).map(m => ({
        ...m,
        product_name:     invMap[m.inventory_item_id]?.name     ?? '(producto eliminado)',
        product_code:     invMap[m.inventory_item_id]?.code     ?? '—',
        product_category: invMap[m.inventory_item_id]?.category ?? '',
      }))
      setRows(enriched)
    } catch (e: any) { setError(e.message || 'Error al cargar movimientos') }
    finally { setLoading(false) }
  }, [businessId, dateFrom, dateTo, typeFilter, page])

  useEffect(() => { load() }, [load])

  // ── Client-side filter (search + dir) ─────────────────────────────────────

  const filtered = useMemo(() => {
    let r = rows
    if (search.trim()) {
      const q = search.toLowerCase()
      r = r.filter(m =>
        m.product_name.toLowerCase().includes(q) ||
        m.product_code.toLowerCase().includes(q) ||
        (m.note || '').toLowerCase().includes(q)
      )
    }
    if (dirFilter) {
      r = r.filter(m => {
        const meta = TYPE_META[m.movement_type]
        return meta ? meta.dir === dirFilter : false
      })
    }
    return r
  }, [rows, search, dirFilter])

  // ── Summary stats ─────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const todayRows = rows.filter(m => isToday(m.created_at))
    const inQty  = todayRows.filter(m => (m.quantity || 0) > 0).reduce((s, m) => s + m.quantity, 0)
    const outQty = todayRows.filter(m => (m.quantity || 0) < 0).reduce((s, m) => s + Math.abs(m.quantity), 0)
    const adjCount = todayRows.filter(m => (TYPE_META[m.movement_type]?.dir) === 'adj').length
    const totalMovs = rows.length
    return { inQty, outQty, adjCount, totalMovs }
  }, [rows])

  // ── Navigate to reference ──────────────────────────────────────────────────

  const handleRef = (m: MovRow) => {
    if (!m.reference_id) return
    if (m.reference_type === 'comprobante') navigate(`/comprobantes/${m.reference_id}`)
    else if (m.reference_type === 'order') navigate(`/orders/${m.reference_id}`)
    else if (m.reference_type === 'purchase') navigate('/suppliers')
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const inputS: React.CSSProperties = {
    padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem',
    color: '#f8fafc', fontSize: '0.85rem', outline: 'none',
  }

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1200px', margin: '0 auto' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ width: 44, height: 44, borderRadius: '0.75rem', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Package size={22} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 style={{ fontSize: '1.375rem', fontWeight: 800, color: '#f8fafc', margin: 0, lineHeight: 1 }}>Historial de Inventario</h1>
            <p style={{ fontSize: '0.8rem', color: '#475569', margin: '0.2rem 0 0' }}>Trazabilidad completa de todos los movimientos de stock</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => setShowFilters(v => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', background: showFilters ? 'rgba(99,102,241,0.15)' : 'transparent', border: `1px solid ${showFilters ? 'rgba(99,102,241,0.4)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '0.5rem', color: showFilters ? '#818cf8' : '#64748b', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 }}>
            <SlidersHorizontal size={14} /> Filtros
          </button>
          <button onClick={load}
            style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#64748b', cursor: 'pointer', fontSize: '0.8rem' }}>
            <RefreshCw size={14} /> Actualizar
          </button>
        </div>
      </div>

      {/* ── Stats ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '1.25rem' }}>
        {[
          { label: 'Total movimientos', value: stats.totalMovs, color: '#818cf8', sub: 'en el período' },
          { label: 'Ingresos hoy',      value: `+${stats.inQty}`,  color: '#34d399', sub: 'unidades' },
          { label: 'Egresos hoy',       value: `-${stats.outQty}`, color: '#f87171', sub: 'unidades' },
          { label: 'Ajustes hoy',       value: stats.adjCount,     color: '#fbbf24', sub: 'correcciones' },
        ].map(s => (
          <div key={s.label} style={{ padding: '0.875rem 1rem', background: '#111827', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '0.75rem' }}>
            <div style={{ fontSize: '0.7rem', color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>{s.label}</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 800, fontFamily: 'monospace', color: s.color, letterSpacing: '-0.02em', lineHeight: 1 }}>{s.value}</div>
            <div style={{ fontSize: '0.7rem', color: '#334155', marginTop: '0.2rem' }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* ── Filters ── */}
      {showFilters && (
        <div style={{ padding: '1rem 1.25rem', background: '#111827', border: '1px solid rgba(99,102,241,0.15)', borderRadius: '0.75rem', marginBottom: '1rem', display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.7rem', color: '#64748b', fontWeight: 700, marginBottom: '0.3rem', textTransform: 'uppercase' }}>Producto / código</label>
            <input style={{ ...inputS, width: 200 }} placeholder="Buscar..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.7rem', color: '#64748b', fontWeight: 700, marginBottom: '0.3rem', textTransform: 'uppercase' }}>Desde</label>
            <input style={inputS} type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(0) }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.7rem', color: '#64748b', fontWeight: 700, marginBottom: '0.3rem', textTransform: 'uppercase' }}>Hasta</label>
            <input style={inputS} type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(0) }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.7rem', color: '#64748b', fontWeight: 700, marginBottom: '0.3rem', textTransform: 'uppercase' }}>Tipo</label>
            <select style={inputS} value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setPage(0) }}>
              <option value="">Todos</option>
              {Object.entries(TYPE_META).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.7rem', color: '#64748b', fontWeight: 700, marginBottom: '0.3rem', textTransform: 'uppercase' }}>Dirección</label>
            <select style={inputS} value={dirFilter} onChange={e => setDirFilter(e.target.value)}>
              <option value="">Todos</option>
              <option value="in">Ingresos</option>
              <option value="out">Egresos</option>
              <option value="adj">Ajustes</option>
            </select>
          </div>
          {(search || dateFrom || dateTo || typeFilter || dirFilter) && (
            <button onClick={() => { setSearch(''); setDateFrom(''); setDateTo(''); setTypeFilter(''); setDirFilter(''); setPage(0) }}
              style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 0.75rem', background: 'transparent', border: '1px solid rgba(248,113,113,0.3)', borderRadius: '0.5rem', color: '#f87171', cursor: 'pointer', fontSize: '0.8rem', marginTop: 'auto' }}>
              <X size={13} /> Limpiar
            </button>
          )}
        </div>
      )}

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 1rem', marginBottom: '1rem', background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.875rem' }}>
          <AlertTriangle size={16} /> {formatDisplayMessage(error)}
        </div>
      )}

      {/* ── Table ── */}
      <div style={{ background: '#111827', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '0.75rem', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '4rem', textAlign: 'center', color: '#475569', fontSize: '0.875rem' }}>Cargando movimientos...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '4rem', textAlign: 'center' }}>
            <Package size={32} style={{ margin: '0 auto 0.75rem', color: '#1e293b' }} />
            <p style={{ color: '#334155', fontSize: '0.875rem', margin: 0 }}>Sin movimientos para los filtros aplicados</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  {['Fecha', 'Producto', 'Tipo', 'Cantidad', 'Stock', 'Nota / Referencia'].map(h => (
                    <th key={h} style={{ padding: '0.625rem 1rem', textAlign: 'left', color: '#334155', fontWeight: 700, fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(m => {
                  const meta   = TYPE_META[m.movement_type] ?? { label: m.movement_type, dir: 'adj', color: '#94a3b8', icon: Settings2 }
                  const Icon   = meta.icon
                  const isIn   = (m.quantity || 0) > 0
                  const isSuspicious = Math.abs(m.quantity) >= 20 && meta.dir === 'adj'
                  const canNav = m.reference_id && ['comprobante','order','purchase'].includes(m.reference_type || '')

                  return (
                    <tr key={m.id}
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', background: isSuspicious ? 'rgba(245,158,11,0.03)' : 'transparent' }}
                      onMouseEnter={e => (e.currentTarget.style.background = isSuspicious ? 'rgba(245,158,11,0.06)' : 'rgba(255,255,255,0.015)')}
                      onMouseLeave={e => (e.currentTarget.style.background = isSuspicious ? 'rgba(245,158,11,0.03)' : 'transparent')}
                    >
                      {/* Fecha */}
                      <td style={{ padding: '0.625rem 1rem', whiteSpace: 'nowrap' }}>
                        <div style={{ fontSize: '0.8rem', color: '#cbd5e1', fontWeight: 600 }}>{fmtDate(m.created_at)}</div>
                        <div style={{ fontSize: '0.68rem', color: '#475569' }}>{fmtTime(m.created_at)}</div>
                      </td>

                      {/* Producto */}
                      <td style={{ padding: '0.625rem 1rem', maxWidth: 200 }}>
                        <div style={{ fontWeight: 600, color: '#f1f5f9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.product_name}</div>
                        <div style={{ fontSize: '0.68rem', color: '#475569' }}>{m.product_code} {m.product_category && `· ${m.product_category}`}</div>
                      </td>

                      {/* Tipo */}
                      <td style={{ padding: '0.625rem 1rem', whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.2rem 0.6rem', borderRadius: '0.375rem', background: meta.color + '18', border: `1px solid ${meta.color}33`, fontSize: '0.72rem', fontWeight: 700, color: meta.color }}>
                          <Icon size={11} /> {meta.label}
                        </span>
                        {isSuspicious && <AlertTriangle size={11} style={{ color: '#f59e0b', marginLeft: '0.375rem' }} />}
                      </td>

                      {/* Cantidad */}
                      <td style={{ padding: '0.625rem 1rem', fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9rem', color: isIn ? '#34d399' : '#f87171', whiteSpace: 'nowrap' }}>
                        {isIn ? '+' : ''}{m.quantity}
                      </td>

                      {/* Stock antes → después */}
                      <td style={{ padding: '0.625rem 1rem', whiteSpace: 'nowrap' }}>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: '#64748b' }}>{m.previous_stock ?? '—'}</span>
                        <span style={{ color: '#1e293b', margin: '0 0.375rem' }}>→</span>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: (m.new_stock ?? 0) < 0 ? '#f87171' : '#94a3b8', fontWeight: 700 }}>
                          {m.new_stock ?? '—'}
                        </span>
                        {(m.new_stock ?? 0) < 0 && <AlertTriangle size={11} style={{ color: '#f87171', marginLeft: '0.25rem' }} />}
                      </td>

                      {/* Nota / Referencia */}
                      <td style={{ padding: '0.625rem 1rem', maxWidth: 240 }}>
                        {m.note && <div style={{ color: '#94a3b8', fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.note}</div>}
                        {m.reference_type && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: m.note ? '0.2rem' : 0 }}>
                            {m.reference_type === 'comprobante' && <FileText size={10} style={{ color: '#818cf8' }} />}
                            {m.reference_type === 'order'       && <Wrench    size={10} style={{ color: '#34d399' }} />}
                            {m.reference_type === 'purchase'    && <Truck     size={10} style={{ color: '#fb923c' }} />}
                            {m.reference_type === 'manual'      && <Settings2 size={10} style={{ color: '#94a3b8' }} />}
                            <span style={{ fontSize: '0.68rem', color: '#475569' }}>{REF_LABELS[m.reference_type] ?? m.reference_type}</span>
                            {canNav && (
                              <button onClick={() => handleRef(m)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#334155', padding: 0, display: 'flex', alignItems: 'center', marginLeft: '0.1rem' }}
                                onMouseEnter={e => (e.currentTarget.style.color = '#818cf8')}
                                onMouseLeave={e => (e.currentTarget.style.color = '#334155')}>
                                <ExternalLink size={11} />
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Pagination ── */}
      {!loading && filtered.length === PAGE_SIZE && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
          <button onClick={() => setPage(p => p + 1)}
            style={{ padding: '0.625rem 1.5rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '0.5rem', color: '#818cf8', fontWeight: 600, cursor: 'pointer', fontSize: '0.875rem' }}>
            Cargar más movimientos
          </button>
        </div>
      )}

      <div style={{ marginTop: '0.75rem', textAlign: 'right', fontSize: '0.72rem', color: '#1e293b' }}>
        {filtered.length} movimientos mostrados
      </div>
    </div>
  )
}
