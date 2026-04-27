import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Store, Search, RefreshCw, Loader2, AlertTriangle,
  CheckCircle, Pencil, Check, X, Zap, TrendingUp, Package,
  ChevronDown, ChevronUp, Users, FileText,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { ModalCrearComprobante } from '../components/comprobantes/ModalCrearComprobante'

// ─── Types ───────────────────────────────────────────────────────────────────

interface WholesaleProduct {
  id: string
  code?: string
  name: string
  category: string
  subcategory?: string
  stock_quantity: number
  min_stock: number
  cost_price: number
  sale_price: number
  precio_mayorista: number | null
  supplier_code?: string
  is_active: boolean
}

// ─── Formatters ──────────────────────────────────────────────────────────────

const fmt = (v: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(v || 0)

const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`

// ─── Margin helpers ───────────────────────────────────────────────────────────

function getMargin(price: number | null, cost: number) {
  if (!price || !cost) return null
  return ((price - cost) / cost) * 100
}

function getProfit(price: number | null, cost: number) {
  if (!price) return null
  return price - cost
}

type MarginStatus = 'ok' | 'low' | 'negative' | 'missing'

function marginStatus(price: number | null, cost: number): MarginStatus {
  if (!price) return 'missing'
  if (price <= cost) return 'negative'
  const m = ((price - cost) / cost) * 100
  if (m < 10) return 'low'
  return 'ok'
}

const STATUS_CONFIG: Record<MarginStatus, { label: string; color: string; bg: string; border: string }> = {
  ok:       { label: 'Buen margen',         color: '#22c55e', bg: 'rgba(34,197,94,0.12)',    border: 'rgba(34,197,94,0.3)'   },
  low:      { label: 'Margen bajo',          color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',   border: 'rgba(245,158,11,0.3)'  },
  negative: { label: 'Sin ganancia',         color: '#f87171', bg: 'rgba(239,68,68,0.12)',    border: 'rgba(239,68,68,0.3)'   },
  missing:  { label: 'Sin precio mayorista', color: '#64748b', bg: 'rgba(100,116,139,0.1)',   border: 'rgba(100,116,139,0.25)'},
}

// ─── Bulk Price Modal ─────────────────────────────────────────────────────────

interface BulkModalProps {
  products: WholesaleProduct[]
  onClose: () => void
  onApplied: () => void
  businessId: string
}

function BulkPriceModal({ products, onClose, onApplied, businessId }: BulkModalProps) {
  const [pct, setPct] = useState('60')
  const [target, setTarget] = useState<'all' | 'missing'>('missing')
  const [filterCat, setFilterCat] = useState('')
  const [round, setRound] = useState<'none' | '100' | '500' | '1000'>('500')
  const [applying, setApplying] = useState(false)
  const [preview, setPreview] = useState(false)

  const cats = [...new Set(products.map(p => p.category))].sort()

  const roundVal = (v: number) => {
    if (round === 'none') return v
    const r = parseInt(round)
    return Math.ceil(v / r) * r
  }

  const affected = products.filter(p => {
    if (filterCat && p.category !== filterCat) return false
    if (target === 'missing' && p.precio_mayorista != null) return false
    return true
  })

  const pctNum = parseFloat(pct) || 0
  const previews = affected.map(p => ({
    ...p,
    new_price: roundVal(p.cost_price * (1 + pctNum / 100)),
  }))

  const handleApply = async () => {
    setApplying(true)
    try {
      for (const p of previews) {
        await supabase
          .from('inventory')
          .update({ precio_mayorista: p.new_price })
          .eq('id', p.id)
          .eq('business_id', businessId)
      }
      onApplied()
      onClose()
    } catch (e) {
      console.error(e)
    } finally {
      setApplying(false)
    }
  }

  const inputS: React.CSSProperties = {
    width: '100%', padding: '0.5rem 0.75rem',
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '0.5rem', color: '#f0f4ff', fontSize: '0.875rem',
    outline: 'none', boxSizing: 'border-box',
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: '#0d1a30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '1.25rem', width: '100%', maxWidth: '560px', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 32px 64px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem 1.5rem', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: '#f0f4ff' }}>Generar precios mayoristas</h3>
            <p style={{ margin: 0, fontSize: '0.75rem', color: '#64748b' }}>Aplica un porcentaje sobre el costo a múltiples productos</p>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: '0.5rem', width: 30, height: 30, cursor: 'pointer', color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={15} /></button>
        </div>

        <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Configuración */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.72rem', color: '#64748b', fontWeight: 600, marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>% sobre el costo</label>
              <div style={{ position: 'relative' }}>
                <input type="number" value={pct} onChange={e => setPct(e.target.value)} min="0" max="999" step="1" style={{ ...inputS, paddingRight: '2rem' }} />
                <span style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', fontSize: '0.8rem' }}>%</span>
              </div>
              {pctNum > 0 && <p style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: '#475569' }}>Costo $10.000 → {fmt(10000 * (1 + pctNum / 100))}</p>}
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.72rem', color: '#64748b', fontWeight: 600, marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Redondeo</label>
              <select value={round} onChange={e => setRound(e.target.value as any)} style={inputS}>
                <option value="none">Sin redondeo</option>
                <option value="100">Al $100 más cercano</option>
                <option value="500">Al $500 más cercano</option>
                <option value="1000">Al $1.000 más cercano</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.72rem', color: '#64748b', fontWeight: 600, marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Aplicar a</label>
              <select value={target} onChange={e => setTarget(e.target.value as any)} style={inputS}>
                <option value="missing">Solo sin precio mayorista</option>
                <option value="all">Todos los productos</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.72rem', color: '#64748b', fontWeight: 600, marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Categoría</label>
              <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={inputS}>
                <option value="">Todas las categorías</option>
                {cats.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          {/* Resumen */}
          <div style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '0.75rem', padding: '0.875rem 1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ fontSize: '0.82rem', color: '#94a3b8' }}>Productos afectados</span>
              <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#c7d2fe' }}>{previews.length}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ fontSize: '0.82rem', color: '#94a3b8' }}>Productos ignorados</span>
              <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#64748b' }}>{products.length - previews.length}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.82rem', color: '#94a3b8' }}>Margen estimado</span>
              <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#22c55e' }}>{pctNum.toFixed(1)}% sobre costo</span>
            </div>
          </div>

          {/* Preview toggle */}
          {previews.length > 0 && (
            <button onClick={() => setPreview(v => !v)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', background: 'none', border: 'none', color: '#818cf8', fontSize: '0.8rem', cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}>
              {preview ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {preview ? 'Ocultar' : 'Ver'} productos afectados
            </button>
          )}
          {preview && (
            <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
              {previews.map(p => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.375rem 0.625rem', background: 'rgba(255,255,255,0.03)', borderRadius: '0.375rem', fontSize: '0.78rem' }}>
                  <span style={{ color: '#e2e8f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '0.5rem' }}>{p.name}</span>
                  <span style={{ color: '#64748b', marginRight: '0.5rem' }}>{fmt(p.cost_price)}</span>
                  <span style={{ color: '#22c55e', fontWeight: 600, whiteSpace: 'nowrap' }}>→ {fmt(p.new_price)}</span>
                </div>
              ))}
            </div>
          )}

          <button onClick={handleApply} disabled={applying || previews.length === 0}
            style={{ width: '100%', padding: '0.875rem', borderRadius: '0.75rem', background: previews.length > 0 ? 'linear-gradient(135deg, #6366f1, #8b5cf6)' : 'rgba(255,255,255,0.06)', border: 'none', color: previews.length > 0 ? 'white' : '#475569', fontWeight: 700, fontSize: '0.9375rem', cursor: applying || previews.length === 0 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', opacity: applying ? 0.7 : 1 }}>
            {applying
              ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Aplicando...</>
              : previews.length === 0
              ? 'Sin productos para actualizar'
              : <><Zap size={16} /> Aplicar a {previews.length} producto{previews.length !== 1 ? 's' : ''}</>}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Inline Price Editor ──────────────────────────────────────────────────────

interface InlineEditorProps {
  product: WholesaleProduct
  exchangeRate: number
  onSave: (id: string, price: number | null) => Promise<void>
}

function InlineEditor({ product, exchangeRate, onSave }: InlineEditorProps) {
  const [editing, setEditing] = useState(false)
  const [currency, setCurrency] = useState<'ARS' | 'USD'>('ARS')
  const [val, setVal] = useState('')
  const [saving, setSaving] = useState(false)

  const openEditor = () => {
    // Mostrar precio en ARS por defecto al abrir
    setCurrency('ARS')
    setVal(product.precio_mayorista != null ? String(Math.round(product.precio_mayorista)) : '')
    setEditing(true)
  }

  const numVal = parseFloat(val) || 0
  const arsPreview = currency === 'USD' ? Math.round(numVal * exchangeRate) : numVal
  const usdRef = product.precio_mayorista && exchangeRate > 1
    ? (product.precio_mayorista / exchangeRate).toFixed(2)
    : null

  const handleSave = async () => {
    setSaving(true)
    const num = parseFloat(val)
    const arsValue = isNaN(num) || val === '' ? null : (currency === 'USD' ? Math.round(num * exchangeRate) : num)
    await onSave(product.id, arsValue)
    setSaving(false)
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave()
    if (e.key === 'Escape') setEditing(false)
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          {/* Toggle ARS/USD */}
          <div style={{ display: 'flex', borderRadius: '0.375rem', overflow: 'hidden', border: '1px solid rgba(99,102,241,0.3)', flexShrink: 0 }}>
            {(['ARS', 'USD'] as const).map(c => (
              <button key={c} type="button" onClick={() => {
                if (c === currency) return
                // Convertir el valor al cambiar moneda
                const n = parseFloat(val) || 0
                if (c === 'USD' && currency === 'ARS' && exchangeRate > 1) setVal((n / exchangeRate).toFixed(2))
                if (c === 'ARS' && currency === 'USD') setVal(String(Math.round(n * exchangeRate)))
                setCurrency(c)
              }} style={{ padding: '0.2rem 0.4rem', background: currency === c ? 'rgba(99,102,241,0.3)' : 'transparent', border: 'none', color: currency === c ? '#c7d2fe' : '#475569', fontSize: '0.65rem', fontWeight: 700, cursor: 'pointer' }}>
                {c}
              </button>
            ))}
          </div>
          <input
            type="number" value={val} onChange={e => setVal(e.target.value)} onKeyDown={handleKeyDown}
            autoFocus min="0" step={currency === 'USD' ? '0.01' : '1'}
            style={{ width: 90, padding: '0.25rem 0.5rem', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.4)', borderRadius: '0.375rem', color: '#c7d2fe', fontSize: '0.8rem', outline: 'none', fontFamily: 'monospace' }}
          />
          <button onClick={handleSave} disabled={saving}
            style={{ width: 24, height: 24, borderRadius: '0.375rem', background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {saving ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={11} />}
          </button>
          <button onClick={() => setEditing(false)}
            style={{ width: 24, height: 24, borderRadius: '0.375rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: '#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <X size={11} />
          </button>
        </div>
        {/* Preview conversión */}
        {currency === 'USD' && numVal > 0 && exchangeRate > 1 && (
          <span style={{ fontSize: '0.65rem', color: '#60a5fa', fontFamily: 'monospace', paddingLeft: '0.25rem' }}>
            = {fmt(arsPreview)} ARS
          </span>
        )}
        {currency === 'ARS' && numVal > 0 && exchangeRate > 1 && (
          <span style={{ fontSize: '0.65rem', color: '#60a5fa', fontFamily: 'monospace', paddingLeft: '0.25rem' }}>
            ≈ USD {(numVal / exchangeRate).toFixed(2)}
          </span>
        )}
      </div>
    )
  }

  return (
    <button onClick={openEditor}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', background: 'none', border: 'none', cursor: 'pointer', padding: '0.25rem 0', gap: '0.1rem' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', color: product.precio_mayorista ? '#c7d2fe' : '#475569' }}>
        <span style={{ fontFamily: 'monospace', fontSize: '0.875rem', fontWeight: product.precio_mayorista ? 600 : 400 }}>
          {product.precio_mayorista ? fmt(product.precio_mayorista) : '—'}
        </span>
        <Pencil size={11} style={{ color: '#475569', opacity: 0.7 }} />
      </span>
      {usdRef && (
        <span style={{ fontSize: '0.65rem', color: '#60a5fa', fontFamily: 'monospace' }}>≈ USD {usdRef}</span>
      )}
    </button>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function Mayorista() {
  const { businessId } = useAuth()
  const [products, setProducts] = useState<WholesaleProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exchangeRate, setExchangeRate] = useState(1)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'with' | 'without' | 'low_stock'>('all')
  const [filterCat, setFilterCat] = useState('')
  const [showBulk, setShowBulk] = useState(false)
  const [showComprobante, setShowComprobante] = useState(false)
  const [sortField, setSortField] = useState<'name' | 'margin' | 'stock' | 'profit'>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const load = useCallback(async () => {
    if (!businessId) return
    setLoading(true)
    setError(null)
    try {
      const { data, error: e } = await supabase
        .from('inventory')
        .select('id, code, name, category, subcategory, stock_quantity, min_stock, cost_price, sale_price, precio_mayorista, supplier_code, is_active')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .order('name')
      if (e) throw e
      setProducts(data || [])
    } catch (err: any) {
      setError(err.message || 'Error al cargar productos')
    } finally {
      setLoading(false)
    }
  }, [businessId])

  useEffect(() => { load() }, [load])

  // Cargar tipo de cambio USD/ARS
  useEffect(() => {
    if (!businessId) return
    supabase
      .from('exchange_rates')
      .select('rate')
      .eq('business_id', businessId)
      .eq('base_currency', 'USD')
      .eq('target_currency', 'ARS')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => { if (data?.rate) setExchangeRate(data.rate) })
  }, [businessId])

  const savePrecioMayorista = async (id: string, price: number | null) => {
    await supabase
      .from('inventory')
      .update({ precio_mayorista: price })
      .eq('id', id)
      .eq('business_id', businessId)
    setProducts(prev => prev.map(p => p.id === id ? { ...p, precio_mayorista: price } : p))
  }

  // ── Categories for filter ──
  const cats = useMemo(() => [...new Set(products.map(p => p.category))].sort(), [products])

  // ── Filtered + sorted products ──
  const filtered = useMemo(() => {
    let res = products
    if (search) {
      const q = search.toLowerCase()
      res = res.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        (p.code || '').toLowerCase().includes(q) ||
        (p.subcategory || '').toLowerCase().includes(q)
      )
    }
    if (filterCat) res = res.filter(p => p.category === filterCat)
    if (filterStatus === 'with') res = res.filter(p => p.precio_mayorista != null)
    if (filterStatus === 'without') res = res.filter(p => p.precio_mayorista == null)
    if (filterStatus === 'low_stock') res = res.filter(p => p.stock_quantity <= p.min_stock)

    res = [...res].sort((a, b) => {
      let av: number, bv: number
      if (sortField === 'name') return sortDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
      if (sortField === 'margin') {
        av = getMargin(a.precio_mayorista, a.cost_price) ?? -999
        bv = getMargin(b.precio_mayorista, b.cost_price) ?? -999
      } else if (sortField === 'profit') {
        av = getProfit(a.precio_mayorista, a.cost_price) ?? -999
        bv = getProfit(b.precio_mayorista, b.cost_price) ?? -999
      } else {
        av = a.stock_quantity; bv = b.stock_quantity
      }
      return sortDir === 'asc' ? av - bv : bv - av
    })

    return res
  }, [products, search, filterCat, filterStatus, sortField, sortDir])

  // ── Metrics ──
  const metrics = useMemo(() => {
    const withPrice   = products.filter(p => p.precio_mayorista != null)
    const withoutPrice = products.filter(p => p.precio_mayorista == null)
    const margins = withPrice.map(p => getMargin(p.precio_mayorista, p.cost_price)!).filter(Boolean)
    const avgMargin = margins.length ? margins.reduce((s, v) => s + v, 0) / margins.length : 0
    return { withPrice: withPrice.length, withoutPrice: withoutPrice.length, avgMargin, total: products.length }
  }, [products])

  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('asc') }
  }

  const SortIcon = ({ field }: { field: typeof sortField }) => {
    if (sortField !== field) return <ChevronDown size={12} style={{ color: '#334155' }} />
    return sortDir === 'asc' ? <ChevronUp size={12} style={{ color: '#818cf8' }} /> : <ChevronDown size={12} style={{ color: '#818cf8' }} />
  }

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
      <Loader2 size={28} style={{ animation: 'spin 1s linear infinite', color: '#6366f1' }} />
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )

  return (
    <div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {/* ── Header ── */}
      <div style={{ marginBottom: '2rem', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div style={{ width: 44, height: 44, borderRadius: '0.75rem', background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 20px rgba(99,102,241,0.35)' }}>
            <Store size={22} color="white" />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f1f5f9' }}>Mayorista</h1>
            <p style={{ margin: 0, fontSize: '0.82rem', color: '#64748b' }}>Precios especiales para revendedores y clientes mayoristas</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.625rem' }}>
          <button onClick={load} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.625rem', color: '#94a3b8', fontSize: '0.8rem', cursor: 'pointer' }}>
            <RefreshCw size={13} /> Actualizar
          </button>
          <button onClick={() => setShowComprobante(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', background: 'linear-gradient(135deg, #22c55e, #16a34a)', border: 'none', borderRadius: '0.625rem', color: 'white', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer', boxShadow: '0 4px 12px rgba(34,197,94,0.3)' }}>
            <FileText size={13} /> Nuevo Comprobante
          </button>
          <button onClick={() => setShowBulk(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', border: 'none', borderRadius: '0.625rem', color: 'white', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer' }}>
            <Zap size={13} /> Generar precios masivos
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '0.875rem 1rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '0.75rem', color: '#f87171', fontSize: '0.875rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      {/* ── Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.75rem' }}>
        {[
          { label: 'Con precio mayorista', value: metrics.withPrice, icon: <CheckCircle size={18} style={{ color: '#22c55e' }} />, color: '#22c55e', note: `de ${metrics.total} productos` },
          { label: 'Sin precio mayorista', value: metrics.withoutPrice, icon: <AlertTriangle size={18} style={{ color: '#f59e0b' }} />, color: '#f59e0b', note: 'requieren configuración' },
          { label: 'Margen promedio', value: `${metrics.avgMargin.toFixed(1)}%`, icon: <TrendingUp size={18} style={{ color: '#818cf8' }} />, color: '#818cf8', note: 'sobre costo' },
          { label: 'Clientes mayoristas', value: '—', icon: <Users size={18} style={{ color: '#60a5fa' }} />, color: '#60a5fa', note: 'ver en Clientes' },
        ].map(card => (
          <div key={card.label} style={{ background: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.875rem', padding: '1.125rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.625rem' }}>
              <span style={{ fontSize: '0.75rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{card.label}</span>
              {card.icon}
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: card.color, lineHeight: 1, marginBottom: '0.25rem' }}>{card.value}</div>
            <div style={{ fontSize: '0.72rem', color: '#334155' }}>{card.note}</div>
          </div>
        ))}
      </div>

      {/* ── Filters ── */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
          <Search size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre, SKU, categoría..." style={{ width: '100%', padding: '0.5rem 0.75rem 0.5rem 2.25rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.625rem', color: '#f0f4ff', fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' }} />
        </div>

        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
          {([
            { key: 'all',        label: 'Todos' },
            { key: 'with',       label: '✓ Con precio' },
            { key: 'without',    label: '⚠ Sin precio' },
            { key: 'low_stock',  label: 'Bajo stock' },
          ] as const).map(f => (
            <button key={f.key} onClick={() => setFilterStatus(f.key)}
              style={{ padding: '0.375rem 0.75rem', borderRadius: '0.5rem', border: `1px solid ${filterStatus === f.key ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.08)'}`, background: filterStatus === f.key ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)', color: filterStatus === f.key ? '#c7d2fe' : '#64748b', fontSize: '0.78rem', fontWeight: filterStatus === f.key ? 600 : 400, cursor: 'pointer' }}>
              {f.label}
            </button>
          ))}
        </div>

        {cats.length > 0 && (
          <select value={filterCat} onChange={e => setFilterCat(e.target.value)}
            style={{ padding: '0.4rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: filterCat ? '#f0f4ff' : '#64748b', fontSize: '0.78rem', outline: 'none', cursor: 'pointer' }}>
            <option value="">Todas las categorías</option>
            {cats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}

        <span style={{ fontSize: '0.75rem', color: '#334155', marginLeft: 'auto' }}>{filtered.length} producto{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* ── Table ── */}
      <div style={{ background: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.875rem', overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {[
                  { label: 'Producto', field: 'name' as const, w: '22%' },
                  { label: 'Categoría', field: null, w: '10%' },
                  { label: 'Stock', field: 'stock' as const, w: '7%' },
                  { label: 'Costo', field: null, w: '9%' },
                  { label: 'Minorista', field: null, w: '9%' },
                  { label: 'Mayorista', field: null, w: '12%' },
                  { label: 'Ganancia', field: 'profit' as const, w: '9%' },
                  { label: 'Margen', field: 'margin' as const, w: '8%' },
                  { label: 'Estado', field: null, w: '14%' },
                ].map(col => (
                  <th key={col.label} onClick={col.field ? () => toggleSort(col.field!) : undefined}
                    style={{ padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.7rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', width: col.w, cursor: col.field ? 'pointer' : 'default', userSelect: 'none', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      {col.label}
                      {col.field && <SortIcon field={col.field} />}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ padding: '3rem', textAlign: 'center', color: '#334155' }}>
                    <Package size={32} style={{ marginBottom: '0.5rem', display: 'block', margin: '0 auto 0.5rem' }} />
                    No se encontraron productos con los filtros actuales
                  </td>
                </tr>
              ) : filtered.map((p, i) => {
                const ms = marginStatus(p.precio_mayorista, p.cost_price)
                const cfg = STATUS_CONFIG[ms]
                const profit = getProfit(p.precio_mayorista, p.cost_price)
                const margin = getMargin(p.precio_mayorista, p.cost_price)
                const isLowStock = p.stock_quantity <= p.min_stock
                const isRetailLoss = p.precio_mayorista != null && p.precio_mayorista >= p.sale_price

                return (
                  <tr key={p.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.04)')}
                    onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)')}>
                    {/* Nombre */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ fontWeight: 600, color: '#f1f5f9', lineHeight: 1.3, marginBottom: '0.1rem' }}>{p.name}</div>
                      {p.code && <div style={{ fontSize: '0.68rem', color: '#334155', fontFamily: 'monospace' }}>#{p.code}</div>}
                    </td>
                    {/* Categoría */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <span style={{ fontSize: '0.75rem', color: '#64748b' }}>{p.category}</span>
                    </td>
                    {/* Stock */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <span style={{ fontFamily: 'monospace', fontWeight: 600, color: isLowStock ? '#f59e0b' : '#94a3b8', fontSize: '0.85rem' }}>
                        {p.stock_quantity}
                      </span>
                      {isLowStock && <div style={{ fontSize: '0.65rem', color: '#f59e0b' }}>bajo stock</div>}
                    </td>
                    {/* Costo */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <span style={{ fontFamily: 'monospace', color: '#64748b', fontSize: '0.82rem' }}>{fmt(p.cost_price)}</span>
                    </td>
                    {/* Minorista */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <span style={{ fontFamily: 'monospace', color: '#94a3b8', fontSize: '0.82rem' }}>{fmt(p.sale_price)}</span>
                    </td>
                    {/* Mayorista (editable) */}
                    <td style={{ padding: '0.5rem 1rem' }}>
                      <InlineEditor product={p} exchangeRate={exchangeRate} onSave={savePrecioMayorista} />
                      {isRetailLoss && p.precio_mayorista != null && (
                        <div style={{ fontSize: '0.65rem', color: '#f59e0b', marginTop: '0.1rem' }}>≥ minorista</div>
                      )}
                    </td>
                    {/* Ganancia $ */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      {profit != null
                        ? <span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: '0.82rem', color: profit > 0 ? '#34d399' : '#f87171' }}>{fmt(profit)}</span>
                        : <span style={{ color: '#334155' }}>—</span>}
                    </td>
                    {/* Margen % */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      {margin != null
                        ? <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.82rem', color: margin >= 20 ? '#22c55e' : margin >= 10 ? '#f59e0b' : '#f87171' }}>{fmtPct(margin)}</span>
                        : <span style={{ color: '#334155' }}>—</span>}
                    </td>
                    {/* Estado */}
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', padding: '0.2rem 0.6rem', borderRadius: '9999px', fontSize: '0.7rem', fontWeight: 600, background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color, whiteSpace: 'nowrap' }}>
                        {cfg.label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Leyenda ── */}
      <div style={{ marginTop: '1rem', display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
        {Object.entries(STATUS_CONFIG).map(([, cfg]) => (
          <div key={cfg.label} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: cfg.color }} />
            <span style={{ fontSize: '0.72rem', color: '#475569' }}>{cfg.label}</span>
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
          <Pencil size={10} style={{ color: '#475569' }} />
          <span style={{ fontSize: '0.72rem', color: '#475569' }}>Click en el precio para editar</span>
        </div>
      </div>

      {showBulk && businessId && (
        <BulkPriceModal
          products={products}
          businessId={businessId}
          onClose={() => setShowBulk(false)}
          onApplied={load}
        />
      )}

      <ModalCrearComprobante
        isOpen={showComprobante}
        onClose={() => setShowComprobante(false)}
        onCreado={() => setShowComprobante(false)}
        usarPrecioMayorista={true}
      />
    </div>
  )
}
