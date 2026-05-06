import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  Tag, Plus, Search, Edit2, Trash2, RefreshCw, X, CheckCircle,
  AlertCircle, Clock, Calendar, Percent,
  RotateCcw, Package,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { smartSearch, buildSupabaseQuery } from '../utils/searchUtils'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProductOffer {
  id: string
  business_id: string
  product_id: string
  normal_price: number
  offer_price: number
  discount_percent: number
  start_date: string
  end_date: string
  is_active: boolean
  notes?: string
  created_by?: string
  created_at: string
  updated_at: string
  // joined
  product?: { id: string; name: string; variant_name?: string; category?: string; stock_quantity: number; code?: string }
}

export type OfferStatus = 'scheduled' | 'active' | 'last_day' | 'expired' | 'paused'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().split('T')[0]

export function computeOfferStatus(o: ProductOffer): OfferStatus {
  if (!o.is_active) return 'paused'
  const t = today()
  if (o.start_date > t) return 'scheduled'
  if (o.end_date < t) return 'expired'
  if (o.end_date === t) return 'last_day'
  return 'active'
}

const fmtARS = (n: number) => '$' + Math.round(n).toLocaleString('es-AR')
import { fmtDateFull as fmtDate } from '../utils/dateUtils'

const STATUS_CONFIG: Record<OfferStatus, { label: string; color: string; bg: string; border: string }> = {
  scheduled: { label: 'Programada', color: '#38bdf8', bg: 'rgba(56,189,248,0.12)', border: 'rgba(56,189,248,0.3)' },
  active:    { label: 'Activa',     color: '#22c55e', bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.3)' },
  last_day:  { label: 'Último día', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.3)' },
  expired:   { label: 'Vencida',    color: '#64748b', bg: 'rgba(100,116,139,0.12)',border: 'rgba(100,116,139,0.25)' },
  paused:    { label: 'Pausada',    color: '#94a3b8', bg: 'rgba(148,163,184,0.08)',border: 'rgba(148,163,184,0.2)' },
}

function StatusBadge({ status }: { status: OfferStatus }) {
  const s = STATUS_CONFIG[status]
  return (
    <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '0.2rem 0.5rem', borderRadius: '9999px', background: s.bg, color: s.color, border: `1px solid ${s.border}`, whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardS: React.CSSProperties = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.875rem', padding: '1.25rem' }
const inputS: React.CSSProperties = { width: '100%', padding: '0.625rem 0.875rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: '#e2e8f0', fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' as const }
const labelS: React.CSSProperties = { display: 'block', fontSize: '0.72rem', fontWeight: 600, color: '#64748b', marginBottom: '0.375rem', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }
const btnPrimary: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', border: 'none', borderRadius: '0.5rem', color: '#fff', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer' }
const btnSecondary: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '0.5rem', color: '#94a3b8', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer' }
const btnGhost: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', borderRadius: '0.375rem', padding: '0.35rem', display: 'inline-flex', alignItems: 'center' }

// ─── Utility: get active offer for a product ─────────────────────────────────

export async function getActiveOfferForProduct(productId: string, businessId: string): Promise<ProductOffer | null> {
  const t = today()
  const { data } = await supabase
    .from('product_offers')
    .select('*')
    .eq('business_id', businessId)
    .eq('product_id', productId)
    .eq('is_active', true)
    .lte('start_date', t)
    .gte('end_date', t)
    .order('offer_price', { ascending: true })
    .limit(1)
    .maybeSingle()
  return data as ProductOffer | null
}

// ─── Modal Crear / Editar oferta ──────────────────────────────────────────────

interface ModalOfferFormProps {
  onClose: () => void
  onSaved: () => void
  editing?: ProductOffer | null
  businessId: string
  userId: string
}

function ModalOfferForm({ onClose, onSaved, editing, businessId, userId }: ModalOfferFormProps) {
  const [productId, setProductId] = useState(editing?.product_id || '')
  const [normalPrice, setNormalPrice] = useState(editing?.normal_price || 0)
  const [offerPrice, setOfferPrice] = useState(editing?.offer_price || 0)
  const [startDate, setStartDate] = useState(editing?.start_date || today())
  const [endDate, setEndDate] = useState(editing?.end_date || '')
  const [notes, setNotes] = useState(editing?.notes || '')
  const [isActive, setIsActive] = useState(editing?.is_active ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [searchQ, setSearchQ] = useState(editing ? (editing.product?.name || '') : '')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [stockWarning, setStockWarning] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()

  const discountPct = normalPrice > 0 && offerPrice > 0
    ? Math.round((1 - offerPrice / normalPrice) * 10000) / 100
    : 0

  const searchProducts = useCallback((q: string) => {
    setSearchQ(q)
    clearTimeout(searchTimer.current)
    if (q.trim().length < 2) { setSearchResults([]); return }
    searchTimer.current = setTimeout(async () => {
      const dbQ = buildSupabaseQuery(q)
      const { data } = await supabase
        .from('inventory')
        .select('id, name, variant_name, code, sale_price, stock_quantity, category')
        .eq('business_id', businessId).eq('is_active', true)
        .not('has_variants', 'is', true)
        .or(`name.ilike.${dbQ},code.ilike.${dbQ},variant_name.ilike.${dbQ}`)
        .limit(8)
      setSearchResults(data || [])
    }, 200)
  }, [businessId])

  const selectProduct = (p: any) => {
    setProductId(p.id)
    setNormalPrice(p.sale_price || 0)
    setSearchQ(p.variant_name ? `${p.name} — ${p.variant_name}` : p.name)
    setSearchResults([])
    setStockWarning((p.stock_quantity || 0) <= 0)
  }

  const handleSave = async () => {
    if (!productId) { setError('Seleccioná un producto'); return }
    if (offerPrice <= 0) { setError('El precio de oferta debe ser mayor a 0'); return }
    if (offerPrice >= normalPrice) { setError('El precio de oferta debe ser menor al precio normal'); return }
    if (!startDate || !endDate) { setError('Completá las fechas'); return }
    if (endDate < startDate) { setError('La fecha de vencimiento no puede ser anterior al inicio'); return }

    // Verificar conflicto de fechas (solo al crear)
    if (!editing) {
      const { data: existing } = await supabase
        .from('product_offers')
        .select('id')
        .eq('business_id', businessId)
        .eq('product_id', productId)
        .eq('is_active', true)
        .lte('start_date', endDate)
        .gte('end_date', startDate)
        .limit(1)
      if (existing && existing.length > 0) {
        setError('Ya existe una oferta activa para ese producto en ese rango de fechas')
        return
      }
    }

    setSaving(true); setError('')
    try {
      const payload = {
        business_id: businessId, product_id: productId,
        normal_price: normalPrice, offer_price: offerPrice,
        discount_percent: discountPct,
        start_date: startDate, end_date: endDate,
        is_active: isActive, notes: notes || null,
        updated_at: new Date().toISOString(),
      }
      if (editing) {
        await supabase.from('product_offers').update(payload).eq('id', editing.id)
      } else {
        await supabase.from('product_offers').insert({ ...payload, created_by: userId })
      }
      onSaved()
    } catch (e: any) {
      setError(e.message || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: '#0d1a30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '1.25rem', width: '100%', maxWidth: '560px', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 32px 64px rgba(0,0,0,0.6)' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, background: '#0d1a30', zIndex: 1, borderRadius: '1.25rem 1.25rem 0 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: 36, height: 36, borderRadius: '0.625rem', background: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Tag size={18} style={{ color: '#818cf8' }} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#f0f4ff' }}>{editing ? 'Editar oferta' : 'Nueva oferta'}</h2>
              <p style={{ margin: 0, fontSize: '0.72rem', color: '#64748b' }}>Precio promocional temporal</p>
            </div>
          </div>
          <button onClick={onClose} style={{ ...btnGhost, color: '#64748b' }}><X size={16} /></button>
        </div>

        <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.125rem' }}>

          {/* Producto */}
          <div>
            <label style={labelS}>Producto *</label>
            <div style={{ position: 'relative' }}>
              <input style={inputS} value={searchQ} onChange={e => searchProducts(e.target.value)}
                placeholder="Buscar producto por nombre, código..." readOnly={!!editing} />
              {searchResults.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, background: '#0d1a30', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '0.5rem', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.4)', marginTop: '0.2rem' }}>
                  {searchResults.map((p: any) => (
                    <button key={p.id} type="button" onClick={() => selectProduct(p)}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '0.5rem 0.75rem', background: 'none', border: 'none', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.05)', textAlign: 'left' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                      <span style={{ color: '#e2e8f0', fontSize: '0.83rem' }}>{p.name}{p.variant_name ? ` — ${p.variant_name}` : ''}</span>
                      <span style={{ color: '#22c55e', fontSize: '0.78rem', flexShrink: 0, marginLeft: '0.5rem' }}>{fmtARS(p.sale_price || 0)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {stockWarning && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginTop: '0.375rem', color: '#f59e0b', fontSize: '0.75rem' }}>
                <AlertCircle size={12} /> Este producto no tiene stock. Podés crear la oferta igual.
              </div>
            )}
          </div>

          {/* Precio normal (readonly) */}
          {normalPrice > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
              <div>
                <label style={labelS}>Precio normal</label>
                <div style={{ ...inputS, color: '#64748b', display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.02)' }}>
                  {fmtARS(normalPrice)}
                </div>
              </div>
              <div>
                <label style={labelS}>Precio de oferta *</label>
                <input style={{ ...inputS, color: '#22c55e', fontWeight: 700 }} type="number" min={1} max={normalPrice - 1}
                  value={offerPrice || ''} onChange={e => setOfferPrice(+e.target.value || 0)} placeholder="$ oferta" />
              </div>
              <div>
                <label style={labelS}>Descuento</label>
                <div style={{ ...inputS, background: discountPct > 0 ? 'rgba(34,197,94,0.08)' : 'rgba(255,255,255,0.02)', color: discountPct > 0 ? '#22c55e' : '#334155', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  {discountPct > 0 ? <><Percent size={13} />{discountPct}% OFF</> : '—'}
                </div>
              </div>
            </div>
          )}

          {/* Si no hay producto seleccionado pero editando */}
          {!normalPrice && editing && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
              <div>
                <label style={labelS}>Precio normal</label>
                <div style={{ ...inputS, color: '#64748b', background: 'rgba(255,255,255,0.02)' }}>{fmtARS(editing.normal_price)}</div>
              </div>
              <div>
                <label style={labelS}>Precio de oferta *</label>
                <input style={{ ...inputS, color: '#22c55e', fontWeight: 700 }} type="number" min={1}
                  value={offerPrice || ''} onChange={e => setOfferPrice(+e.target.value || 0)} placeholder="$ oferta" />
              </div>
              <div>
                <label style={labelS}>Descuento</label>
                <div style={{ ...inputS, background: discountPct > 0 ? 'rgba(34,197,94,0.08)' : 'rgba(255,255,255,0.02)', color: discountPct > 0 ? '#22c55e' : '#334155', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  {discountPct > 0 ? <><Percent size={13} />{discountPct}% OFF</> : '—'}
                </div>
              </div>
            </div>
          )}

          {/* Fechas */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label style={labelS}>Fecha de inicio *</label>
              <input style={inputS} type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div>
              <label style={labelS}>Fecha de vencimiento *</label>
              <input style={inputS} type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>

          {/* Notas */}
          <div>
            <label style={labelS}>Observaciones</label>
            <textarea style={{ ...inputS, minHeight: 64, resize: 'vertical' as const }} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Ej: Liquidación de stock, promo fin de semana..." />
          </div>

          {/* Estado */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderRadius: '0.625rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>Oferta activa</span>
            <button onClick={() => setIsActive(v => !v)}
              style={{ width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', background: isActive ? '#22c55e' : '#334155', position: 'relative', transition: 'background 0.2s' }}>
              <span style={{ position: 'absolute', top: 3, left: isActive ? 23 : 3, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
            </button>
          </div>
        </div>

        {error && <p style={{ margin: '0 1.5rem', color: '#ef4444', fontSize: '0.8rem' }}>{error}</p>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <button style={btnSecondary} onClick={onClose}>Cancelar</button>
          <button style={btnPrimary} onClick={handleSave} disabled={saving}>
            {saving ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle size={14} />}
            {saving ? 'Guardando...' : editing ? 'Guardar cambios' : 'Crear oferta'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

type FilterKey = 'all' | 'active' | 'last_day' | 'scheduled' | 'expired' | 'paused'

export function Offers() {
  const { businessId, user } = useAuth()
  const [offers, setOffers] = useState<ProductOffer[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<ProductOffer | null>(null)

  const loadOffers = useCallback(async () => {
    if (!businessId) return
    setLoading(true)
    try {
      const { data } = await supabase
        .from('product_offers')
        .select('*, product:inventory(id, name, variant_name, code, category, stock_quantity, sale_price)')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false })
      setOffers((data || []) as ProductOffer[])
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [businessId])

  useEffect(() => { loadOffers() }, [loadOffers])

  const withStatus = useMemo(() =>
    offers.map(o => ({ ...o, _status: computeOfferStatus(o) })),
    [offers]
  )

  const filtered = useMemo(() => {
    let list = [...withStatus]
    if (filter !== 'all') list = list.filter(o => o._status === filter)
    if (searchTerm.trim()) {
      list = smartSearch(list, searchTerm, [
        { getValue: o => o.product?.name, weight: 3 },
        { getValue: o => o.product?.variant_name, weight: 2 },
        { getValue: o => o.product?.category },
        { getValue: o => o.notes },
      ]) as typeof list
    }
    return list
  }, [withStatus, filter, searchTerm])

  // Stats
  const stats = useMemo(() => ({
    active:    withStatus.filter(o => o._status === 'active').length,
    last_day:  withStatus.filter(o => o._status === 'last_day').length,
    scheduled: withStatus.filter(o => o._status === 'scheduled').length,
    expired:   withStatus.filter(o => o._status === 'expired').length,
  }), [withStatus])

  const handleToggle = async (o: ProductOffer) => {
    await supabase.from('product_offers').update({ is_active: !o.is_active, updated_at: new Date().toISOString() }).eq('id', o.id)
    loadOffers()
  }

  const handleDelete = async (o: ProductOffer) => {
    if (!confirm(`¿Eliminar la oferta de ${o.product?.name}?`)) return
    await supabase.from('product_offers').delete().eq('id', o.id)
    loadOffers()
  }

  const handleRenew = (o: ProductOffer) => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const newEnd = new Date()
    newEnd.setDate(newEnd.getDate() + 7)
    setEditing({
      ...o,
      start_date: tomorrow.toISOString().split('T')[0],
      end_date: newEnd.toISOString().split('T')[0],
      is_active: true,
    })
    setShowModal(true)
  }

  return (
    <div className="page-shell">
      {/* Header */}
      <div className="page-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div style={{ width: 40, height: 40, borderRadius: '0.75rem', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Tag size={20} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 className="page-title">Ofertas</h1>
            <p className="page-subtitle">Precios promocionales temporales</p>
          </div>
        </div>
        <button style={btnPrimary} onClick={() => { setEditing(null); setShowModal(true) }}>
          <Plus size={15} /> Nueva oferta
        </button>
      </div>

      {/* Alertas */}
      {(stats.last_day > 0 || stats.expired > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.25rem' }}>
          {withStatus.filter(o => o._status === 'last_day').map(o => (
            <div key={o.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderRadius: '0.625rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Clock size={15} style={{ color: '#f59e0b', flexShrink: 0 }} />
                <span style={{ color: '#fcd34d', fontSize: '0.875rem' }}>
                  <strong>Último día:</strong> oferta de <strong>{o.product?.name}</strong> vence hoy. Revisá si querés renovarla.
                </span>
              </div>
              <button style={{ ...btnGhost, color: '#f59e0b', fontSize: '0.72rem' }} onClick={() => handleRenew(o)}>
                <RotateCcw size={12} /> Renovar
              </button>
            </div>
          ))}
          {withStatus.filter(o => o._status === 'expired').slice(0, 3).map(o => (
            <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 1rem', borderRadius: '0.625rem', background: 'rgba(100,116,139,0.08)', border: '1px solid rgba(100,116,139,0.2)' }}>
              <AlertCircle size={14} style={{ color: '#64748b', flexShrink: 0 }} />
              <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
                Oferta vencida: <strong style={{ color: '#e2e8f0' }}>{o.product?.name}</strong> — venció el {fmtDate(o.end_date)}.
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Stats cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '1.25rem' }}>
        {([
          { key: 'active',    label: 'Activas',     value: stats.active,    color: '#22c55e', icon: <CheckCircle size={16} /> },
          { key: 'last_day',  label: 'Vencen hoy',  value: stats.last_day,  color: '#f59e0b', icon: <Clock size={16} /> },
          { key: 'scheduled', label: 'Programadas', value: stats.scheduled, color: '#38bdf8', icon: <Calendar size={16} /> },
          { key: 'expired',   label: 'Vencidas',    value: stats.expired,   color: '#64748b', icon: <AlertCircle size={16} /> },
        ] as const).map(s => (
          <button key={s.key} onClick={() => setFilter(f => f === s.key ? 'all' : s.key as FilterKey)}
            style={{ ...cardS, cursor: 'pointer', border: filter === s.key ? `1px solid ${s.color}40` : '1px solid rgba(255,255,255,0.08)', background: filter === s.key ? `${s.color}08` : 'rgba(255,255,255,0.03)', textAlign: 'left', width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', color: s.color }}>{s.icon}<span style={{ fontSize: '0.68rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase' }}>{s.label}</span></div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: s.color }}>{s.value}</div>
          </button>
        ))}
      </div>

      {/* Buscador + filtros */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
          <input style={{ ...inputS, paddingLeft: '2.25rem' }} placeholder="Buscar por producto, categoría, observación..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
          {([
            { key: 'all', label: 'Todas' },
            { key: 'active', label: 'Activas' },
            { key: 'last_day', label: 'Vencen hoy' },
            { key: 'scheduled', label: 'Programadas' },
            { key: 'expired', label: 'Vencidas' },
          ] as { key: FilterKey; label: string }[]).map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              style={{ padding: '0.4rem 0.75rem', border: `1px solid ${filter === f.key ? '#6366f1' : 'rgba(255,255,255,0.1)'}`, borderRadius: '0.5rem', background: filter === f.key ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)', color: filter === f.key ? '#818cf8' : '#64748b', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tabla */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}><RefreshCw className="animate-spin" size={28} style={{ color: '#6366f1' }} /></div>
      ) : filtered.length === 0 ? (
        <div style={{ ...cardS, textAlign: 'center', padding: '3rem', color: '#475569' }}>
          <Tag size={36} style={{ marginBottom: '0.75rem', opacity: 0.25 }} />
          <p style={{ margin: '0 0 1rem' }}>{searchTerm || filter !== 'all' ? 'Sin resultados para los filtros seleccionados.' : 'No hay ofertas creadas todavía.'}</p>
          {filter === 'all' && !searchTerm && (
            <button style={btnPrimary} onClick={() => { setEditing(null); setShowModal(true) }}><Plus size={13} /> Crear primera oferta</button>
          )}
        </div>
      ) : (
        <div style={{ ...cardS, padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {['Producto', 'Precio normal', 'Precio oferta', 'Descuento', 'Inicio', 'Vencimiento', 'Estado', 'Activa', ''].map(h => (
                  <th key={h} style={{ padding: '0.75rem 1rem', fontSize: '0.65rem', color: '#475569', fontWeight: 700, textAlign: ['Precio normal','Precio oferta','Descuento'].includes(h) ? 'right' : 'left', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(o => {
                const st = o._status
                return (
                  <tr key={o.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding: '0.875rem 1rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                        <div style={{ width: 30, height: 30, borderRadius: '0.5rem', background: 'rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Package size={13} style={{ color: '#818cf8' }} />
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '0.875rem' }}>{o.product?.name || '—'}</div>
                          {o.product?.variant_name && <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{o.product.variant_name}</div>}
                          {o.product?.category && <div style={{ fontSize: '0.68rem', color: '#475569' }}>{o.product.category}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '0.875rem 1rem', textAlign: 'right', color: '#64748b', fontSize: '0.875rem', textDecoration: st === 'active' || st === 'last_day' ? 'line-through' : 'none' }}>
                      {fmtARS(o.normal_price)}
                    </td>
                    <td style={{ padding: '0.875rem 1rem', textAlign: 'right' }}>
                      <span style={{ fontWeight: 800, color: st === 'expired' || st === 'paused' ? '#64748b' : '#22c55e', fontSize: '1rem' }}>{fmtARS(o.offer_price)}</span>
                    </td>
                    <td style={{ padding: '0.875rem 1rem', textAlign: 'right' }}>
                      <span style={{ fontSize: '0.875rem', fontWeight: 700, color: st === 'expired' || st === 'paused' ? '#64748b' : '#f59e0b' }}>
                        {o.discount_percent ? `${o.discount_percent}% OFF` : '—'}
                      </span>
                    </td>
                    <td style={{ padding: '0.875rem 1rem', color: '#94a3b8', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{fmtDate(o.start_date)}</td>
                    <td style={{ padding: '0.875rem 1rem', color: st === 'last_day' ? '#f59e0b' : '#94a3b8', fontSize: '0.8rem', whiteSpace: 'nowrap', fontWeight: st === 'last_day' ? 700 : 400 }}>{fmtDate(o.end_date)}</td>
                    <td style={{ padding: '0.875rem 1rem' }}><StatusBadge status={st} /></td>
                    <td style={{ padding: '0.875rem 1rem' }}>
                      <button onClick={() => handleToggle(o)}
                        style={{ width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', background: o.is_active ? '#22c55e' : '#334155', position: 'relative', transition: 'background 0.2s' }}>
                        <span style={{ position: 'absolute', top: 3, left: o.is_active ? 20 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                      </button>
                    </td>
                    <td style={{ padding: '0.875rem 0.75rem' }}>
                      <div style={{ display: 'flex', gap: '0.25rem', justifyContent: 'flex-end' }}>
                        <button style={{ ...btnGhost, color: '#818cf8' }} title="Editar" onClick={() => { setEditing(o); setShowModal(true) }}><Edit2 size={14} /></button>
                        {(st === 'expired' || st === 'last_day') && (
                          <button style={{ ...btnGhost, color: '#38bdf8' }} title="Renovar" onClick={() => handleRenew(o)}><RotateCcw size={14} /></button>
                        )}
                        <button style={{ ...btnGhost, color: '#ef4444' }} title="Eliminar" onClick={() => handleDelete(o)}><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <ModalOfferForm
          onClose={() => { setShowModal(false); setEditing(null) }}
          onSaved={() => { setShowModal(false); setEditing(null); loadOffers() }}
          editing={editing}
          businessId={businessId || ''}
          userId={user?.id || ''}
        />
      )}
    </div>
  )
}
