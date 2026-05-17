import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Store, Search, RefreshCw, Loader2, AlertTriangle,
  CheckCircle, Pencil, Check, X, Zap, TrendingUp, Package,
  ChevronDown, ChevronUp, Users, FileText, ShoppingBag,
  Globe, UserCheck, UserX, ExternalLink, Eye, EyeOff,
  Settings, MessageSquare, Filter, LayoutGrid,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { ComprobanteProModal as ModalCrearComprobante } from '../components/comprobantes/ComprobanteProModal'
import { TabCatalogoPortal } from './mayorista/TabCatalogoPortal'
import {
  getWholesaleCustomers, updateCustomerStatus,
  getWholesaleOrders, updateOrderStatus,
  getOrCreateCustomerFromPortal,
} from '../portal/services/portalService'
import { ORDER_STATUS_LABEL, ORDER_STATUS_COLOR, type WholesaleCustomer, type WholesaleOrder } from '../portal/types'

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
  visible_in_wholesale: boolean
  supplier_code?: string
  is_active: boolean
}

interface PortalConfig {
  wholesale_portal_enabled: boolean
  wholesale_portal_slug:    string
  wholesale_whatsapp:       string
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
  const [activeTab, setActiveTab] = useState<'precios' | 'catalogo' | 'portal' | 'clientes' | 'pedidos' | 'config'>('precios')

  // Portal admin data
  const [portalCustomers, setPortalCustomers] = useState<WholesaleCustomer[]>([])
  const [portalOrders, setPortalOrders] = useState<WholesaleOrder[]>([])
  const [portalLoading, setPortalLoading] = useState(false)

  // Portal tab — product visibility
  const [portalSearch, setPortalSearch] = useState('')
  const [portalFilter, setPortalFilter] = useState<'all' | 'visible' | 'hidden'>('all')

  // Pedidos tab filters
  const [orderSearch, setOrderSearch]           = useState('')
  const [orderStatusFilter, setOrderStatusFilter] = useState<'all' | WholesaleOrder['status']>('all')

  // Convertir en comprobante desde pedido portal
  const [convertOrder, setConvertOrder]   = useState<WholesaleOrder | null>(null)
  const [convertClientId, setConvertClientId] = useState<string | null>(null)
  const [converting, setConverting]       = useState(false)
  const [convertError, setConvertError]   = useState('')

  const handleConvertirComprobante = async (order: WholesaleOrder) => {
    if (!businessId) return
    setConverting(true); setConvertError('')
    const cust = order.customer as any
    const { customerId, error } = await getOrCreateCustomerFromPortal(
      businessId,
      cust?.email || '',
      cust?.name || 'Cliente mayorista',
      cust?.whatsapp || null,
      'mayorista',
    )
    setConverting(false)
    if (error || !customerId) {
      setConvertError(error || 'No se pudo obtener el cliente')
      setTimeout(() => setConvertError(''), 4000)
      return
    }
    setConvertClientId(customerId)
    setConvertOrder(order)
    setShowComprobante(true)
  }

  // Portal config
  const [portalConfig, setPortalConfig]   = useState<PortalConfig>({ wholesale_portal_enabled: false, wholesale_portal_slug: '', wholesale_whatsapp: '' })
  const [configSaving, setConfigSaving]   = useState(false)
  const [configSaved,  setConfigSaved]    = useState(false)
  const [configError,  setConfigError]    = useState('')

  const loadPortalConfig = useCallback(async () => {
    if (!businessId) return
    const { data } = await supabase
      .from('businesses')
      .select('wholesale_portal_enabled, wholesale_portal_slug, wholesale_whatsapp')
      .eq('id', businessId)
      .maybeSingle()
    if (data) setPortalConfig({
      wholesale_portal_enabled: data.wholesale_portal_enabled ?? false,
      wholesale_portal_slug:    data.wholesale_portal_slug    ?? '',
      wholesale_whatsapp:       data.wholesale_whatsapp       ?? '',
    })
  }, [businessId])

  const savePortalConfig = async () => {
    if (!businessId) return
    const wa = portalConfig.wholesale_whatsapp.replace(/\D/g, '')
    if (wa && !/^\d{10,15}$/.test(wa)) {
      setConfigError('El número debe tener entre 10 y 15 dígitos (sin símbolos). Ejemplo Argentina: 5493512345678')
      return
    }
    setConfigSaving(true); setConfigError(''); setConfigSaved(false)
    const { error: err } = await supabase
      .from('businesses')
      .update({
        // wholesale_portal_enabled solo se activa desde el panel de admin del sistema, no desde el frontend
        wholesale_portal_slug: portalConfig.wholesale_portal_slug.toLowerCase().replace(/[^a-z0-9-]/g, '') || null,
        wholesale_whatsapp:    wa || null,
      })
      .eq('id', businessId)
    setConfigSaving(false)
    if (err) { setConfigError(err.message); return }
    setPortalConfig(p => ({ ...p, wholesale_whatsapp: wa, wholesale_portal_slug: portalConfig.wholesale_portal_slug.toLowerCase().replace(/[^a-z0-9-]/g, '') }))
    setConfigSaved(true)
    setTimeout(() => setConfigSaved(false), 2500)
  }

  const loadPortalData = useCallback(async () => {
    if (!businessId) return
    setPortalLoading(true)
    const [customers, orders] = await Promise.all([
      getWholesaleCustomers(businessId),
      getWholesaleOrders(businessId),
    ])
    setPortalCustomers(customers)
    setPortalOrders(orders)
    setPortalLoading(false)
  }, [businessId])

  useEffect(() => {
    if (activeTab === 'clientes' || activeTab === 'pedidos') loadPortalData()
    if (activeTab === 'config') loadPortalConfig()
  }, [activeTab, loadPortalData, loadPortalConfig])

  const load = useCallback(async () => {
    if (!businessId) return
    setLoading(true)
    setError(null)
    try {
      const { data, error: e } = await supabase
        .from('inventory')
        .select('id, code, name, category, subcategory, stock_quantity, min_stock, cost_price, sale_price, precio_mayorista, visible_in_wholesale, supplier_code, is_active')
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
      <Loader2 size={28} style={{ animation: 'tr-spin 1s linear infinite', color: '#6366f1' }} />
    </div>
  )

  return (
    <div>

      {/* ── Header ── */}
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon"><Store size={22} /></div>
          <div>
            <h1 className="page-hdr-title">Mayorista</h1>
            <p className="page-hdr-subtitle">Precios especiales para revendedores y clientes mayoristas</p>
          </div>
        </div>
        <div className="page-hdr-right">
          <button onClick={load} className="btn btn-ghost btn-sm"><RefreshCw size={13} /> Actualizar</button>
          <button onClick={() => setShowComprobante(true)} className="btn btn-success btn-sm btn-lift"><FileText size={13} /> Nuevo Comprobante</button>
          <button onClick={() => setShowBulk(true)} className="btn btn-primary btn-sm btn-lift"><Zap size={13} /> Generar precios masivos</button>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="tabs" style={{ marginBottom: '1.5rem' }}>
        {([
          { id: 'precios',  label: 'Precios', icon: TrendingUp },
          ...(portalConfig.wholesale_portal_enabled ? [
            { id: 'catalogo', label: 'Catálogo Portal', icon: LayoutGrid  },
            { id: 'portal',   label: 'Visibilidad',     icon: Globe       },
            { id: 'clientes', label: 'Clientes',        icon: Users       },
            { id: 'pedidos',  label: 'Pedidos Web',     icon: ShoppingBag },
            { id: 'config',   label: 'Configuración',   icon: Settings    },
          ] : []),
        ] as const).map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setActiveTab(id as any)}
            className={`tab${activeTab === id ? ' tab-active' : ''}`}>
            <Icon size={14} /> {label}
            {id === 'clientes' && portalCustomers.filter(c => !c.approved && !c.suspended).length > 0 && (
              <span className="badge badge-error" style={{ fontSize: '0.62rem', padding: '0.1rem 0.375rem', marginLeft: '0.2rem' }}>
                {portalCustomers.filter(c => !c.approved && !c.suspended).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ══════ TAB: PRECIOS ══════ */}
      {activeTab === 'precios' && (<>

      {error && (
        <div className="alert-inline alert-error" style={{ marginBottom: '1.5rem' }}>
          <AlertTriangle size={15} style={{ flexShrink: 0 }} /> {error}
        </div>
      )}

      {/* ── Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.75rem' }}>
        {[
          { label: 'Con precio mayorista', value: metrics.withPrice,           icon: <CheckCircle  size={16} />, color: '#22c55e', note: `de ${metrics.total} productos` },
          { label: 'Sin precio mayorista', value: metrics.withoutPrice,        icon: <AlertTriangle size={16} />, color: '#f59e0b', note: 'requieren configuración' },
          { label: 'Margen promedio',      value: `${metrics.avgMargin.toFixed(1)}%`, icon: <TrendingUp size={16} />, color: '#818cf8', note: 'sobre costo' },
          { label: 'Clientes mayoristas',  value: '—',                         icon: <Users size={16} />,       color: '#60a5fa', note: 'ver en Clientes' },
        ].map(card => (
          <div key={card.label} className="stat-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
              <span className="stat-card-label">{card.label}</span>
              <span style={{ color: card.color }}>{card.icon}</span>
            </div>
            <div className="stat-card-value" style={{ color: card.color }}>{card.value}</div>
            <div className="body-sm">{card.note}</div>
          </div>
        ))}
      </div>

      {/* ── Filters ── */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
          <Search size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre, SKU, categoría..." className="form-control" style={{ paddingLeft: '2.25rem' }} />
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

      </> /* end tab precios */ )}

      {/* ══════ TAB: CATÁLOGO PORTAL ══════ */}
      {activeTab === 'catalogo' && businessId && (
        <TabCatalogoPortal
          businessId={businessId}
          portalSlug={portalConfig.wholesale_portal_slug || 'clic'}
        />
      )}

      {/* ══════ TAB: PORTAL — visibilidad de productos ══════ */}
      {activeTab === 'portal' && (() => {
        const portalVisible = products.filter(p => {
          const q = portalSearch.toLowerCase()
          const matchSearch = !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q)
          const matchFilter = portalFilter === 'all' || (portalFilter === 'visible' && p.visible_in_wholesale) || (portalFilter === 'hidden' && !p.visible_in_wholesale)
          return matchSearch && matchFilter
        })
        const toggleVisibility = async (id: string, val: boolean) => {
          await supabase.from('inventory').update({ visible_in_wholesale: val }).eq('id', id).eq('business_id', businessId)
          setProducts(prev => prev.map(p => p.id === id ? { ...p, visible_in_wholesale: val } : p))
        }
        const visibleCount = products.filter(p => p.visible_in_wholesale).length
        return (
          <div>
            {/* Stats + controls */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
              <div style={{ display: 'flex', gap: '1.25rem' }}>
                <span style={{ fontSize: '0.82rem', color: '#64748b' }}>
                  <strong style={{ color: '#818cf8' }}>{visibleCount}</strong> visibles en portal · {products.length - visibleCount} ocultos
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                {/* Filter */}
                <div style={{ display: 'flex', gap: '0.25rem', background: 'rgba(255,255,255,0.03)', padding: '0.2rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.07)' }}>
                  {([['all','Todos'],['visible','Visibles'],['hidden','Ocultos']] as const).map(([v,l]) => (
                    <button key={v} onClick={() => setPortalFilter(v)} style={{ padding: '0.3rem 0.625rem', borderRadius: '0.375rem', border: 'none', background: portalFilter === v ? 'rgba(99,102,241,0.2)' : 'transparent', color: portalFilter === v ? '#818cf8' : '#64748b', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}>{l}</button>
                  ))}
                </div>
                {/* Search */}
                <div style={{ position: 'relative' }}>
                  <Search size={13} style={{ position: 'absolute', left: '0.625rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                  <input value={portalSearch} onChange={e => setPortalSearch(e.target.value)} placeholder="Buscar..." style={{ padding: '0.375rem 0.75rem 0.375rem 2rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#f1f5f9', fontSize: '0.8rem', outline: 'none', width: 180 }} />
                </div>
              </div>
            </div>
            {/* Table */}
            <div style={{ background: '#111827', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.875rem', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                    {['Producto', 'Categoría', 'Stock', 'Precio normal', 'Precio mayorista', 'Visible en portal'].map(h => (
                      <th key={h} style={{ padding: '0.625rem 0.875rem', textAlign: 'left', color: '#334155', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {portalVisible.length === 0 ? (
                    <tr><td colSpan={6} style={{ padding: '2.5rem', textAlign: 'center', color: '#334155' }}>Sin productos para mostrar.</td></tr>
                  ) : portalVisible.map((p, i) => (
                    <tr key={p.id} style={{ borderBottom: i < portalVisible.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                      <td style={{ padding: '0.75rem 0.875rem' }}>
                        <div style={{ fontWeight: 600, color: '#f1f5f9' }}>{p.name}</div>
                        {p.code && <div style={{ fontSize: '0.7rem', color: '#334155', fontFamily: 'monospace' }}>{p.code}</div>}
                      </td>
                      <td style={{ padding: '0.75rem 0.875rem', color: '#64748b', fontSize: '0.8rem' }}>{p.category}</td>
                      <td style={{ padding: '0.75rem 0.875rem', fontFamily: 'monospace', color: p.stock_quantity <= p.min_stock ? '#f59e0b' : '#94a3b8', fontSize: '0.85rem' }}>{p.stock_quantity}</td>
                      <td style={{ padding: '0.75rem 0.875rem', fontFamily: 'monospace', color: '#64748b', fontSize: '0.82rem' }}>{fmt(p.sale_price)}</td>
                      <td style={{ padding: '0.75rem 0.875rem', fontFamily: 'monospace', fontSize: '0.82rem', color: p.precio_mayorista ? '#818cf8' : '#334155' }}>
                        {p.precio_mayorista ? fmt(p.precio_mayorista) : <span style={{ color: '#334155', fontSize: '0.75rem' }}>Sin precio</span>}
                      </td>
                      <td style={{ padding: '0.75rem 0.875rem' }}>
                        <button
                          onClick={() => toggleVisibility(p.id, !p.visible_in_wholesale)}
                          style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.35rem 0.75rem', borderRadius: '0.375rem', border: `1px solid ${p.visible_in_wholesale ? 'rgba(34,197,94,0.35)' : 'rgba(255,255,255,0.1)'}`, background: p.visible_in_wholesale ? 'rgba(34,197,94,0.1)' : 'rgba(255,255,255,0.03)', color: p.visible_in_wholesale ? '#22c55e' : '#475569', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s' }}
                        >
                          {p.visible_in_wholesale ? <><Eye size={12} /> Visible</> : <><EyeOff size={12} /> Oculto</>}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ margin: '0.75rem 0 0', fontSize: '0.75rem', color: '#334155' }}>
              Solo los productos visibles aparecen en el catálogo del portal. Editá el precio mayorista desde la pestaña Precios.
            </p>
          </div>
        )
      })()}

      {/* ══════ TAB: CLIENTES PORTAL ══════ */}
      {activeTab === 'clientes' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <span style={{ fontSize: '0.82rem', color: '#64748b' }}>
              {portalCustomers.length} cliente{portalCustomers.length !== 1 ? 's' : ''} registrados
            </span>
            <button onClick={loadPortalData} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.4rem 0.75rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#64748b', fontSize: '0.75rem', cursor: 'pointer' }}>
              <RefreshCw size={12} /> Actualizar
            </button>
          </div>
          {portalLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
              <Loader2 size={24} style={{ animation: 'spin 1s linear infinite', color: '#6366f1' }} />
            </div>
          ) : portalCustomers.length === 0 ? (
            <div style={{ padding: '3rem', textAlign: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: '0.75rem', border: '1px solid rgba(255,255,255,0.06)', color: '#475569' }}>
              <Globe size={28} style={{ marginBottom: '0.75rem', display: 'block', margin: '0 auto 0.75rem' }} />
              <p style={{ margin: 0 }}>Aún no hay clientes registrados en el portal.</p>
              <p style={{ margin: '0.5rem 0 0', fontSize: '0.82rem' }}>
                Compartí el link: <strong style={{ color: '#818cf8' }}>{window.location.origin}/mayorista/{portalConfig.wholesale_portal_slug || 'clic'}</strong>
              </p>
            </div>
          ) : (
            <div style={{ background: '#111827', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.875rem', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                    {['Cliente', 'Negocio', 'WhatsApp', 'Ubicación', 'Estado', 'Registrado', 'Acciones'].map(h => (
                      <th key={h} style={{ padding: '0.625rem 0.875rem', textAlign: 'left', color: '#334155', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {portalCustomers.map(c => (
                    <tr key={c.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={{ padding: '0.75rem 0.875rem' }}>
                        <div style={{ fontWeight: 600, color: '#f1f5f9' }}>{c.name}</div>
                        <div style={{ fontSize: '0.72rem', color: '#475569' }}>{c.email}</div>
                      </td>
                      <td style={{ padding: '0.75rem 0.875rem', color: '#94a3b8' }}>{c.business_name || '—'}</td>
                      <td style={{ padding: '0.75rem 0.875rem', color: '#94a3b8', fontFamily: 'monospace', fontSize: '0.8rem' }}>{c.whatsapp || '—'}</td>
                      <td style={{ padding: '0.75rem 0.875rem', fontSize: '0.8rem' }}>
                        <div style={{ color: '#94a3b8' }}>{c.city || '—'}{c.province && c.city ? `, ${c.province}` : c.province || ''}</div>
                        {c.instagram && <div style={{ color: '#334155', fontSize: '0.72rem' }}>@{c.instagram}</div>}
                      </td>
                      <td style={{ padding: '0.75rem 0.875rem' }}>
                        {c.suspended ? (
                          <span style={{ padding: '0.2rem 0.5rem', borderRadius: '99px', background: 'rgba(239,68,68,0.1)', color: '#f87171', fontSize: '0.72rem', fontWeight: 700 }}>Suspendido</span>
                        ) : c.approved ? (
                          <span style={{ padding: '0.2rem 0.5rem', borderRadius: '99px', background: 'rgba(34,197,94,0.1)', color: '#22c55e', fontSize: '0.72rem', fontWeight: 700 }}>Aprobado</span>
                        ) : (
                          <span style={{ padding: '0.2rem 0.5rem', borderRadius: '99px', background: 'rgba(245,158,11,0.1)', color: '#f59e0b', fontSize: '0.72rem', fontWeight: 700 }}>Pendiente</span>
                        )}
                      </td>
                      <td style={{ padding: '0.75rem 0.875rem', color: '#475569', fontSize: '0.78rem' }}>
                        {new Date(c.created_at).toLocaleDateString('es-AR')}
                      </td>
                      <td style={{ padding: '0.75rem 0.875rem' }}>
                        <div style={{ display: 'flex', gap: '0.375rem' }}>
                          {!c.approved && !c.suspended && (
                            <button
                              onClick={async () => {
                                await updateCustomerStatus(c.id, { approved: true })
                                setPortalCustomers(prev => prev.map(x => x.id === c.id ? { ...x, approved: true } : x))
                              }}
                              style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.3rem 0.625rem', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '0.375rem', color: '#22c55e', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer' }}
                            >
                              <UserCheck size={12} /> Aprobar
                            </button>
                          )}
                          {c.approved && !c.suspended && (
                            <button
                              onClick={async () => {
                                await updateCustomerStatus(c.id, { suspended: true })
                                setPortalCustomers(prev => prev.map(x => x.id === c.id ? { ...x, suspended: true } : x))
                              }}
                              style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.3rem 0.625rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '0.375rem', color: '#f87171', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer' }}
                            >
                              <UserX size={12} /> Suspender
                            </button>
                          )}
                          {c.suspended && (
                            <button
                              onClick={async () => {
                                await updateCustomerStatus(c.id, { suspended: false })
                                setPortalCustomers(prev => prev.map(x => x.id === c.id ? { ...x, suspended: false } : x))
                              }}
                              style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.3rem 0.625rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.375rem', color: '#818cf8', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer' }}
                            >
                              <UserCheck size={12} /> Reactivar
                            </button>
                          )}
                          {c.whatsapp && (
                            <a
                              href={`https://wa.me/${c.whatsapp.replace(/\D/g, '')}`}
                              target="_blank" rel="noopener noreferrer"
                              style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', padding: '0.3rem 0.5rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.375rem', color: '#475569', fontSize: '0.72rem', cursor: 'pointer', textDecoration: 'none' }}
                            >
                              <ExternalLink size={11} />
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ══════ TAB: PEDIDOS WEB ══════ */}
      {activeTab === 'pedidos' && (() => {
        const WA_MESSAGES: Record<WholesaleOrder['status'], (n: string, num: string) => string> = {
          pending_whatsapp: (n: string, num: string) => `Hola ${n}! Recibimos tu pedido #${num} y lo estamos revisando.`,
          pending_review:   (n: string, num: string) => `Hola ${n}! Tu pedido #${num} está en revisión. Pronto te confirmamos.`,
          approved:         (n: string, num: string) => `Hola ${n}! Tu pedido #${num} fue aprobado. ¡Lo estamos preparando!`,
          rejected:         (n: string, num: string) => `Hola ${n}! Lamentablemente tu pedido #${num} no pudo ser procesado. Contactanos para más info.`,
          invoiced:         (n: string, num: string) => `Hola ${n}! Tu pedido #${num} fue facturado y está listo para coordinar entrega.`,
          delivered:        (n: string, num: string) => `Hola ${n}! Tu pedido #${num} fue entregado. ¡Gracias por tu compra!`,
          cancelled:        (n: string, num: string) => `Hola ${n}! Tu pedido #${num} fue cancelado. Contactanos si tenés dudas.`,
        } as any

        const nextStatuses: Record<WholesaleOrder['status'], WholesaleOrder['status'][]> = {
          pending_whatsapp: ['pending_review', 'approved', 'cancelled'],
          pending_review:   ['approved', 'rejected'],
          approved:         ['invoiced', 'cancelled'],
          rejected:         ['pending_review'],
          invoiced:         ['delivered', 'cancelled'],
          delivered:        [],
          cancelled:        ['pending_review'],
        }

        const filteredOrders = portalOrders.filter(o => {
          const c = o.customer as any
          const q = orderSearch.toLowerCase()
          const matchQ = !q || (c?.name || '').toLowerCase().includes(q) || (c?.business_name || '').toLowerCase().includes(q) || (c?.whatsapp || '').includes(q) || o.order_number.toLowerCase().includes(q)
          const matchStatus = orderStatusFilter === 'all' || o.status === orderStatusFilter
          return matchQ && matchStatus
        })

        return (
          <div>
            {/* Controls */}
            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
                <Search size={13} style={{ position: 'absolute', left: '0.625rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                <input value={orderSearch} onChange={e => setOrderSearch(e.target.value)} placeholder="Buscar cliente, negocio, WhatsApp, N°..." style={{ width: '100%', boxSizing: 'border-box', padding: '0.4rem 0.75rem 0.4rem 2rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#f1f5f9', fontSize: '0.8rem', outline: 'none' }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                <Filter size={13} style={{ color: '#475569' }} />
                <select value={orderStatusFilter} onChange={e => setOrderStatusFilter(e.target.value as any)} style={{ padding: '0.4rem 0.75rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#94a3b8', fontSize: '0.8rem', outline: 'none' }}>
                  <option value="all">Todos los estados</option>
                  {(Object.keys(ORDER_STATUS_LABEL) as WholesaleOrder['status'][]).map(s => (
                    <option key={s} value={s}>{ORDER_STATUS_LABEL[s]}</option>
                  ))}
                </select>
              </div>
              <span style={{ fontSize: '0.78rem', color: '#475569', whiteSpace: 'nowrap' }}>
                {filteredOrders.length} pedido{filteredOrders.length !== 1 ? 's' : ''}
              </span>
              <button onClick={loadPortalData} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.4rem 0.75rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#64748b', fontSize: '0.75rem', cursor: 'pointer' }}>
                <RefreshCw size={12} /> Actualizar
              </button>
            </div>

            {portalLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
                <Loader2 size={24} style={{ animation: 'spin 1s linear infinite', color: '#6366f1' }} />
              </div>
            ) : filteredOrders.length === 0 ? (
              <div style={{ padding: '3rem', textAlign: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: '0.75rem', border: '1px solid rgba(255,255,255,0.06)', color: '#475569' }}>
                <ShoppingBag size={28} style={{ display: 'block', margin: '0 auto 0.75rem' }} />
                <p style={{ margin: 0 }}>{portalOrders.length === 0 ? 'Aún no hay pedidos del portal.' : 'Sin pedidos para esos filtros.'}</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {filteredOrders.map(order => {
                  const cust = order.customer as any
                  const itemCount = (order.items as any[])?.length ?? 0
                  return (
                    <div key={order.id} style={{ background: '#111827', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.75rem', overflow: 'hidden' }}>
                      {/* Header */}
                      <div style={{ padding: '0.875rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.625rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                            <span style={{ fontWeight: 700, color: '#f1f5f9', fontSize: '0.9rem' }}>#{order.order_number}</span>
                            <span style={{ padding: '0.2rem 0.5rem', borderRadius: '99px', background: `${ORDER_STATUS_COLOR[order.status]}18`, color: ORDER_STATUS_COLOR[order.status], fontSize: '0.7rem', fontWeight: 700, border: `1px solid ${ORDER_STATUS_COLOR[order.status]}40` }}>
                              {ORDER_STATUS_LABEL[order.status]}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem' }}>
                            {cust?.name}{cust?.business_name && ` · ${cust.business_name}`}{cust?.whatsapp && <span style={{ color: '#334155', marginLeft: '0.5rem' }}>{cust.whatsapp}</span>}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '0.8rem', color: '#64748b' }}>
                          <span>{itemCount} {itemCount === 1 ? 'producto' : 'productos'}</span>
                          <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#f1f5f9', fontSize: '0.9rem' }}>${Math.round(order.total).toLocaleString('es-AR')}</span>
                          <span>{new Date(order.created_at).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
                        </div>
                      </div>

                      {/* Items */}
                      {(order.items as any[])?.length > 0 && (
                        <div style={{ padding: '0.5rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                          {(order.items as any[]).map((item: any) => (
                            <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: '#94a3b8' }}>
                              <span>{item.quantity}× {item.product_name}</span>
                              <span style={{ fontFamily: 'monospace', color: '#64748b' }}>${Math.round(item.subtotal).toLocaleString('es-AR')}</span>
                            </div>
                          ))}
                          {order.notes && <p style={{ margin: '0.375rem 0 0', fontSize: '0.75rem', color: '#475569', fontStyle: 'italic' }}>Obs: {order.notes}</p>}
                        </div>
                      )}

                      {/* Actions */}
                      <div style={{ padding: '0.625rem 1rem', borderTop: '1px solid rgba(255,255,255,0.04)', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        {nextStatuses[order.status].map(s => (
                          <button key={s}
                            onClick={async () => {
                              await updateOrderStatus(order.id, s)
                              setPortalOrders(prev => prev.map(o => o.id === order.id ? { ...o, status: s } : o))
                            }}
                            style={{ padding: '0.3rem 0.75rem', background: `${ORDER_STATUS_COLOR[s]}12`, border: `1px solid ${ORDER_STATUS_COLOR[s]}35`, borderRadius: '0.375rem', color: ORDER_STATUS_COLOR[s], fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer' }}
                          >
                            {ORDER_STATUS_LABEL[s]}
                          </button>
                        ))}
                        {cust?.whatsapp && (
                          <a
                            href={`https://wa.me/${cust.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(WA_MESSAGES[order.status](cust.name, order.order_number))}`}
                            target="_blank" rel="noopener noreferrer"
                            style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.3rem 0.625rem', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: '0.375rem', color: '#22c55e', fontSize: '0.72rem', fontWeight: 600, textDecoration: 'none', marginLeft: 'auto' }}
                          >
                            <MessageSquare size={11} /> Notificar por WhatsApp
                          </a>
                        )}
                        {order.status !== 'invoiced' && order.status !== 'cancelled' && order.status !== 'rejected' && (
                          <button
                            onClick={() => handleConvertirComprobante(order)}
                            disabled={converting}
                            style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.3rem 0.75rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '0.375rem', color: '#818cf8', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', marginLeft: cust?.whatsapp ? '0' : 'auto' }}
                          >
                            <FileText size={11} /> {converting ? 'Procesando...' : 'Convertir en comprobante'}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })()}

      {/* ══════ TAB: CONFIGURACIÓN PORTAL ══════ */}
      {activeTab === 'config' && (
        <div style={{ maxWidth: 540 }}>
          <div style={{ background: '#111827', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.875rem', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {/* Enable/disable */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.875rem 1rem', background: portalConfig.wholesale_portal_enabled ? 'rgba(34,197,94,0.06)' : 'rgba(255,255,255,0.02)', border: `1px solid ${portalConfig.wholesale_portal_enabled ? 'rgba(34,197,94,0.25)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '0.625rem' }}>
              <div>
                <div style={{ fontWeight: 700, color: '#f1f5f9', fontSize: '0.9rem' }}>Portal activo</div>
                <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '0.125rem' }}>Los clientes pueden acceder al catálogo y armar pedidos</div>
              </div>
              <button
                onClick={() => setPortalConfig(p => ({ ...p, wholesale_portal_enabled: !p.wholesale_portal_enabled }))}
                style={{ padding: '0.4rem 1rem', borderRadius: '0.5rem', border: 'none', background: portalConfig.wholesale_portal_enabled ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.07)', color: portalConfig.wholesale_portal_enabled ? '#22c55e' : '#64748b', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minWidth: 80 }}
              >
                {portalConfig.wholesale_portal_enabled ? 'Activo' : 'Inactivo'}
              </button>
            </div>

            {/* Slug */}
            <div>
              <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>Slug del portal</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.82rem', color: '#334155', whiteSpace: 'nowrap' }}>{window.location.origin}/mayorista/</span>
                <input
                  value={portalConfig.wholesale_portal_slug}
                  onChange={e => setPortalConfig(p => ({ ...p, wholesale_portal_slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
                  placeholder="clic"
                  style={{ flex: 1, padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: '#f1f5f9', fontSize: '0.9rem', fontFamily: 'monospace', outline: 'none' }}
                />
              </div>
              {portalConfig.wholesale_portal_slug && (
                <p style={{ margin: '0.375rem 0 0', fontSize: '0.72rem', color: '#475569' }}>
                  URL: {window.location.origin}/mayorista/{portalConfig.wholesale_portal_slug}
                </p>
              )}
            </div>

            {/* WhatsApp */}
            <div>
              <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>WhatsApp del negocio</label>
              <input
                value={portalConfig.wholesale_whatsapp}
                onChange={e => setPortalConfig(p => ({ ...p, wholesale_whatsapp: e.target.value }))}
                placeholder="5493512345678"
                style={{ width: '100%', boxSizing: 'border-box', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: '#f1f5f9', fontSize: '0.9rem', fontFamily: 'monospace', outline: 'none' }}
              />
              <p style={{ margin: '0.375rem 0 0', fontSize: '0.72rem', color: '#334155' }}>
                Formato internacional sin + ni espacios. Argentina: 549 + código de área + número. Ej: <span style={{ fontFamily: 'monospace', color: '#475569' }}>5493512345678</span>
              </p>
            </div>

            {configError && (
              <div style={{ padding: '0.625rem 0.875rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.82rem' }}>
                {configError}
              </div>
            )}

            <button
              onClick={savePortalConfig}
              disabled={configSaving}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '0.75rem 1.5rem', background: configSaved ? 'rgba(34,197,94,0.15)' : 'linear-gradient(135deg,#6366f1,#8b5cf6)', border: configSaved ? '1px solid rgba(34,197,94,0.35)' : 'none', borderRadius: '0.625rem', color: configSaved ? '#22c55e' : '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: configSaving ? 'not-allowed' : 'pointer', opacity: configSaving ? 0.7 : 1, transition: 'all 0.15s' }}
            >
              {configSaving ? <><Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite' }} /> Guardando...</> : configSaved ? <><CheckCircle size={15} /> Guardado</> : 'Guardar configuración'}
            </button>
          </div>
        </div>
      )}

      {/* Modal comprobante directo (botón "Nuevo Comprobante" en header) */}
      {showComprobante && !convertOrder && (
        <ModalCrearComprobante
          isOpen
          onClose={() => setShowComprobante(false)}
          onCreado={() => setShowComprobante(false)}
          usarPrecioMayorista={true}
        />
      )}

      {/* Modal comprobante desde pedido web */}
      {showComprobante && convertOrder && convertClientId && (
        <ModalCrearComprobante
          isOpen
          onClose={() => { setShowComprobante(false); setConvertOrder(null); setConvertClientId(null) }}
          onCreado={async () => {
            setShowComprobante(false)
            // Marcar pedido como facturado
            await updateOrderStatus(convertOrder.id, 'invoiced', undefined, businessId || undefined)
            setPortalOrders(prev => prev.map(o => o.id === convertOrder.id ? { ...o, status: 'invoiced' as const } : o))
            setConvertOrder(null); setConvertClientId(null)
          }}
          initialClienteId={convertClientId}
          usarPrecioMayorista={true}
          initialItems={(convertOrder.items || []).map(item => ({
            descripcion:     item.product_name,
            cantidad:        item.quantity,
            precio_unitario: item.unit_price,
            costo_unitario:  0,
            inventory_id:    item.inventory_item_id || undefined,
            tipo_linea:      'producto' as const,
          }))}
        />
      )}

      {convertError && (
        <div style={{ position: 'fixed', bottom: '1.5rem', left: '50%', transform: 'translateX(-50%)', background: '#ef4444', color: '#fff', padding: '0.625rem 1.25rem', borderRadius: '99px', fontSize: '0.85rem', fontWeight: 600, zIndex: 999 }}>
          {convertError}
        </div>
      )}
    </div>
  )
}
