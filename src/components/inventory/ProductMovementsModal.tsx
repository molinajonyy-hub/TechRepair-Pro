import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  X, ArrowUpRight, ArrowDownRight, RotateCcw, Wrench,
  FileText, Truck, Settings2, ExternalLink,
  TrendingUp, TrendingDown, Package, Search,
  AlertCircle, AlertTriangle, Info, RefreshCw, User,
  ShoppingCart, CheckCircle2,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'

// ─── RPC types ────────────────────────────────────────────────────────────────

interface RpcMovement {
  id: string
  date: string
  movement_type: string
  source: string
  quantity: number
  unit_cost: number | null
  unit_price: number | null
  previous_stock: number | null
  new_stock: number | null
  reference_id: string | null
  reference_type: string | null
  note: string | null
  tipo_linea: string | null
  charged_to_customer: boolean
  is_internal_part: boolean
  supplier: { id: string; name: string } | null
  customer: { id: string; name: string } | null
  comprobante: { id: string; numero: string | null; tipo: string | null; fecha: string | null } | null
  order: { id: string } | null
}

interface RpcSummary {
  total_in: number
  total_out: number
  sold_quantity: number
  internal_used_quantity: number
  total_revenue: number
  total_cost: number
  estimated_margin: number
  movement_count: number
  last_movement_at: string | null
  stock_from_movements: number
}

interface RpcProduct {
  id: string; name: string; code: string | null
  category: string | null; current_stock: number
  cost_price: number | null; sale_price: number | null
}

interface RpcAlert {
  severity: 'critical' | 'warning' | 'low'
  title: string
  description: string
}

interface RpcResult {
  ok: boolean; error?: string
  product: RpcProduct
  summary: RpcSummary
  movements: RpcMovement[]
  alerts: RpcAlert[]
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  item: { id: string; name: string; code: string; stock_quantity: number; category?: string }
  businessId: string
  onClose: () => void
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_META: Record<string, { label: string; dir: 'in' | 'out' | 'adj'; color: string; Icon: typeof ArrowUpRight }> = {
  sale:         { label: 'Venta',            dir: 'out', color: '#f87171', Icon: ShoppingCart    },
  purchase:     { label: 'Compra',           dir: 'in',  color: '#34d399', Icon: ArrowUpRight    },
  order_usage:  { label: 'Uso en orden',     dir: 'out', color: '#fb923c', Icon: Wrench          },
  return:       { label: 'Devolución',       dir: 'in',  color: '#60a5fa', Icon: RotateCcw       },
  cancellation: { label: 'Anulación',        dir: 'in',  color: '#a78bfa', Icon: RotateCcw       },
  in:           { label: 'Ingreso manual',   dir: 'in',  color: '#34d399', Icon: ArrowUpRight    },
  out:          { label: 'Egreso manual',    dir: 'out', color: '#f87171', Icon: ArrowDownRight  },
  adjustment:   { label: 'Ajuste',           dir: 'adj', color: '#fbbf24', Icon: Settings2       },
  credit_note:  { label: 'Nota de crédito',  dir: 'in',  color: '#a78bfa', Icon: FileText        },
}

const FILTER_OPTIONS = [
  { key: 'all',       label: 'Todos'         },
  { key: 'in',        label: 'Entradas'      },
  { key: 'out',       label: 'Salidas'       },
  { key: 'purchase',  label: 'Compras'       },
  { key: 'sale',      label: 'Ventas'        },
  { key: 'order',     label: 'Órdenes'       },
  { key: 'internal',  label: 'Uso interno'   },
  { key: 'manual',    label: 'Ajustes'       },
] as const

type FilterKey = typeof FILTER_OPTIONS[number]['key']

const TIPO_COMP_LABELS: Record<string, string> = {
  factura_a: 'Factura A', factura_c: 'Factura C',
  nota_credito: 'NC', remito: 'Remito',
}

const fmt = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n)

import { fmtDate, fmtTime } from '../../utils/dateUtils'

// ─── Main component ───────────────────────────────────────────────────────────

export function ProductMovementsModal({ item, businessId, onClose }: Props) {
  const [result,  setResult]  = useState<RpcResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [filter,  setFilter]  = useState<FilterKey>('all')
  const [search,  setSearch]  = useState('')

  const load = async () => {
    setLoading(true); setError(null)
    const { data, error: rpcErr } = await supabase.rpc('inventory_product_history', {
      p_business_id:  businessId,
      p_inventory_id: item.id,
    })
    if (rpcErr) { setError(rpcErr.message); setLoading(false); return }
    if (!data?.ok) { setError(data?.error || 'Error al cargar historial'); setLoading(false); return }
    setResult(data as RpcResult)
    setLoading(false)
  }

  useEffect(() => { void load() }, [item.id, businessId]) // eslint-disable-line react-hooks/exhaustive-deps

  const movements = result?.movements ?? []

  const filtered = useMemo(() => {
    let list = movements
    if (filter === 'in')       list = list.filter(m => m.quantity > 0)
    if (filter === 'out')      list = list.filter(m => m.quantity < 0)
    if (filter === 'purchase') list = list.filter(m => m.movement_type === 'purchase' || m.source === 'purchase')
    if (filter === 'sale')     list = list.filter(m => m.movement_type === 'sale' || m.source === 'comprobante')
    if (filter === 'order')    list = list.filter(m => m.movement_type === 'order_usage' || m.source === 'order')
    if (filter === 'internal') list = list.filter(m => m.is_internal_part)
    if (filter === 'manual')   list = list.filter(m => ['adjustment', 'in', 'out', 'manual'].includes(m.movement_type))

    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(m =>
        m.supplier?.name?.toLowerCase().includes(q) ||
        m.customer?.name?.toLowerCase().includes(q) ||
        m.comprobante?.numero?.toLowerCase().includes(q) ||
        m.note?.toLowerCase().includes(q) ||
        m.movement_type.toLowerCase().includes(q)
      )
    }
    return list
  }, [movements, filter, search])

  const p  = result?.product
  const s  = result?.summary
  const alerts = result?.alerts ?? []

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      data-testid="inventory-product-detail"
    >
      <div style={{ background: 'var(--bg-card)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '1rem', width: '100%', maxWidth: 780, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* ── Header ── */}
        <div style={{ padding: '1.125rem 1.5rem 1rem', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: 36, height: 36, borderRadius: '0.5rem', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Package size={17} style={{ color: '#818cf8' }} />
            </div>
            <div>
              <h3 style={{ fontWeight: 800, color: 'var(--text-primary)', margin: 0, fontSize: '1rem' }}>{item.name}</h3>
              <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                {item.code}{p?.category ? ` · ${p.category}` : ''}
                {p && <span style={{ marginLeft: '0.5rem', color: 'var(--text-subtle)' }}>Costo: {fmt(p.cost_price ?? 0)} · Venta: {fmt(p.sale_price ?? 0)}</span>}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button onClick={() => void load()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0.25rem', display: 'flex' }} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0.25rem', display: 'flex' }}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ── Summary stats ── */}
        {s && (
          <div
            data-testid="inventory-product-summary"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}
          >
            {[
              { label: 'Stock',      value: p?.current_stock ?? item.stock_quantity, color: (p?.current_stock ?? item.stock_quantity) === 0 ? '#f87171' : '#818cf8' },
              { label: '+Entradas',  value: `+${s.total_in}`,                       color: '#34d399'  },
              { label: '-Salidas',   value: `-${s.total_out}`,                      color: '#f87171'  },
              { label: 'Vendido',    value: s.sold_quantity,                        color: '#818cf8'  },
              { label: 'Uso interno',value: s.internal_used_quantity,               color: '#fb923c'  },
              { label: 'Ingresos',   value: fmt(s.total_revenue),                   color: '#34d399'  },
              { label: 'Margen est.',value: fmt(s.estimated_margin),                color: s.estimated_margin >= 0 ? '#34d399' : '#f87171' },
            ].map(st => (
              <div key={st.label} style={{ padding: '0.625rem 0.75rem', borderRight: '1px solid var(--border-subtle)' }}>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-subtle)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.2rem' }}>{st.label}</div>
                <div style={{ fontSize: '0.875rem', fontWeight: 800, fontFamily: 'monospace', color: st.color }}>{st.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Filter + search ── */}
        <div
          data-testid="inventory-product-filter"
          style={{ padding: '0.625rem 1rem', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0, display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}
        >
          {FILTER_OPTIONS.map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`tab tab-sm${filter === f.key ? ' tab-active' : ''}`}
              style={{ borderBottom: 'none', padding: '0.2rem 0.5rem' }}>
              {f.label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ position: 'relative' }}>
            <Search size={12} style={{ position: 'absolute', left: '0.5rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-subtle)', pointerEvents: 'none' }} />
            <input
              className="form-control"
              style={{ paddingLeft: '1.75rem', height: 28, fontSize: '0.75rem', width: 180 }}
              placeholder="Buscar..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* ── Alerts ── */}
        {alerts.length > 0 && (
          <div data-testid="inventory-product-alerts" style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            {alerts.map((a, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', background: a.severity === 'critical' ? 'rgba(239,68,68,0.08)' : a.severity === 'warning' ? 'rgba(245,158,11,0.08)' : 'rgba(148,163,184,0.08)', border: `1px solid ${a.severity === 'critical' ? 'rgba(239,68,68,0.2)' : a.severity === 'warning' ? 'rgba(245,158,11,0.2)' : 'rgba(148,163,184,0.15)'}` }}>
                {a.severity === 'critical' ? <AlertCircle size={13} style={{ color: '#ef4444', flexShrink: 0 }} /> : a.severity === 'warning' ? <AlertTriangle size={13} style={{ color: '#f59e0b', flexShrink: 0 }} /> : <Info size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />}
                <span style={{ fontSize: '0.78rem', color: a.severity === 'critical' ? '#fca5a5' : a.severity === 'warning' ? '#fcd34d' : 'var(--text-secondary)' }}>
                  <strong>{a.title}:</strong> {a.description}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ── Content ── */}
        <div data-testid="inventory-product-history" style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 0' }}>
          {loading ? (
            <div className="es">
              <RefreshCw size={24} className="animate-spin es-icon" style={{ opacity: 1, color: '#818cf8' }} />
              <p className="es-text" style={{ margin: 0 }}>Cargando historial...</p>
            </div>
          ) : error ? (
            <div className="es">
              <AlertCircle size={28} className="es-icon" style={{ color: '#ef4444' }} />
              <p className="es-title">Error al cargar</p>
              <p className="es-text">{error}</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="es">
              <Package size={32} className="es-icon" />
              <p className="es-title">
                {movements.length === 0 ? 'Sin movimientos registrados' : 'Sin resultados para el filtro'}
              </p>
              <p className="es-text">
                {movements.length === 0
                  ? 'Cuando el producto entre o salga del inventario, aparecerá acá.'
                  : 'Probá cambiando el filtro o borrá la búsqueda.'}
              </p>
            </div>
          ) : (
            <div style={{ position: 'relative', paddingLeft: '2.5rem' }}>
              {/* Vertical timeline line */}
              <div style={{ position: 'absolute', left: '1.5rem', top: 0, bottom: 0, width: 2, background: 'var(--border-subtle)' }} />

              {filtered.map((m, idx) => {
                const meta  = TYPE_META[m.movement_type] ?? { label: m.movement_type, dir: 'adj', color: '#94a3b8', Icon: Settings2 }
                const Icon  = meta.Icon
                const isIn  = m.quantity > 0
                const margin = m.unit_price != null && m.unit_cost != null
                  ? (m.unit_price - m.unit_cost) * Math.abs(m.quantity)
                  : null

                return (
                  <div key={m.id} data-testid="inventory-product-movement-row" style={{ position: 'relative', paddingLeft: '1.25rem', paddingBottom: '0.875rem' }}>
                    {/* Dot */}
                    <div style={{ position: 'absolute', left: '-0.875rem', top: '0.2rem', width: 14, height: 14, borderRadius: '50%', background: meta.color, border: '2px solid var(--bg-card)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Icon size={7} style={{ color: '#0f172a' }} />
                    </div>

                    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '0.75rem 1rem' }}>
                      {/* Row top */}
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.3rem' }}>
                            {/* Type badge */}
                            <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '0.12rem 0.45rem', borderRadius: '0.25rem', background: meta.color + '18', color: meta.color, flexShrink: 0 }}>
                              {meta.label}
                            </span>
                            {/* Charged / internal badge */}
                            {m.charged_to_customer && (
                              <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '0.25rem', background: 'rgba(99,102,241,0.12)', color: '#818cf8', flexShrink: 0 }}>
                                <CheckCircle2 size={8} style={{ display: 'inline', marginRight: 2 }} />Cobrado al cliente
                              </span>
                            )}
                            {m.is_internal_part && (
                              <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '0.25rem', background: 'rgba(251,146,60,0.12)', color: '#fb923c', flexShrink: 0 }}>
                                <Wrench size={8} style={{ display: 'inline', marginRight: 2 }} />Uso interno
                              </span>
                            )}
                            {idx === filtered.length - 1 && <span style={{ fontSize: '0.6rem', color: 'var(--text-subtle)', background: 'var(--bg-surface)', padding: '0.1rem 0.4rem', borderRadius: '0.25rem' }}>primer registro</span>}
                          </div>

                          {/* Context row: supplier / customer / comprobante / order */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                            {m.supplier && (
                              <Link to="/suppliers" onClick={onClose} data-testid="inventory-product-open-supplier"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: '#fb923c', textDecoration: 'none' }}>
                                <Truck size={11} />{m.supplier.name}
                              </Link>
                            )}
                            {m.customer && (
                              <Link to={`/customers/${m.customer.id}`} onClick={onClose} data-testid="inventory-product-open-customer"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: '#60a5fa', textDecoration: 'none' }}>
                                <User size={11} />{m.customer.name}
                              </Link>
                            )}
                            {m.comprobante && (
                              <Link to={`/comprobantes/${m.comprobante.id}`} onClick={onClose} data-testid="inventory-product-open-comprobante"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: '#818cf8', textDecoration: 'none' }}>
                                <FileText size={11} />
                                {TIPO_COMP_LABELS[m.comprobante.tipo ?? ''] || m.comprobante.tipo}
                                {m.comprobante.numero ? ` #${m.comprobante.numero}` : ''}
                                <ExternalLink size={9} />
                              </Link>
                            )}
                            {m.order && !m.comprobante && (
                              <Link to={`/orders/${m.order.id}`} onClick={onClose} data-testid="inventory-product-open-order"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: '#34d399', textDecoration: 'none' }}>
                                <Wrench size={11} />Orden {m.order.id.slice(0, 8)}
                                <ExternalLink size={9} />
                              </Link>
                            )}
                            {m.note && (
                              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>{m.note}</span>
                            )}
                          </div>
                        </div>

                        {/* Right col: qty + stock + cost + margin */}
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '1rem', color: isIn ? '#34d399' : '#f87171' }}>
                            {isIn ? '+' : ''}{m.quantity}
                          </div>
                          <div style={{ fontSize: '0.68rem', color: 'var(--text-subtle)', fontFamily: 'monospace' }}>
                            {m.previous_stock ?? '?'} → {m.new_stock ?? '?'}
                          </div>
                          {m.unit_cost != null && (
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                              costo: {fmt(m.unit_cost)}
                            </div>
                          )}
                          {m.unit_price != null && !isIn && (
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                              precio: {fmt(m.unit_price)}
                            </div>
                          )}
                          {margin !== null && margin !== 0 && (
                            <div style={{ fontSize: '0.68rem', fontWeight: 700, color: margin >= 0 ? '#34d399' : '#f87171' }}>
                              {margin >= 0 ? '+' : ''}{fmt(margin)} margen
                            </div>
                          )}
                          <div style={{ fontSize: '0.62rem', color: 'var(--text-subtle)', marginTop: '0.15rem' }}>
                            {fmtDate(m.date)} {fmtTime(m.date)}
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

        {/* ── Footer ── */}
        {!loading && !error && s && (
          <div style={{ padding: '0.625rem 1.5rem', borderTop: '1px solid var(--border-subtle)', flexShrink: 0, display: 'flex', gap: '1.25rem', fontSize: '0.75rem', color: 'var(--text-muted)', alignItems: 'center' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              <TrendingUp size={11} style={{ color: '#34d399' }} /> {s.total_in} entradas
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              <TrendingDown size={11} style={{ color: '#f87171' }} /> {s.total_out} salidas
            </span>
            <span>{s.movement_count} movimientos</span>
            {filter !== 'all' || search ? (
              <span style={{ color: 'var(--accent-primary)' }}>{filtered.length} mostrados</span>
            ) : null}
            <div style={{ flex: 1 }} />
            {s.last_movement_at && (
              <span>Último: {fmtDate(s.last_movement_at)}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
