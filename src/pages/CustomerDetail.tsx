import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, User, Phone, Mail, MapPin, ClipboardList,
  Smartphone, Building2, CreditCard, ShoppingBag, ChevronDown,
  ChevronRight, Receipt, Tag, Search, ExternalLink,
  TrendingUp, RotateCcw, Wallet,
} from 'lucide-react'
import { Loader } from '../components/ui/Loader'
import { customersService } from '../services/api'
import { supabase } from '../lib/supabase'
import { STATUS_CONFIG } from '../types/orderStatus'
import { cuentasService, getAccountStatus, type Account } from '../services/cuentasService'
import { ModalPagarCC } from '../components/comprobantes/ModalPagarCC'
import { useAuth } from '../contexts/AuthContext'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CustomerOrderSummary {
  id: string
  status: string
  total_cost?: number
  estimated_total?: number
  created_at: string
  device?: { brand?: string; model?: string } | null
}

interface CustomerDetailData {
  id: string
  name: string
  phone?: string
  email?: string
  address?: string
  customer_type?: string
  devices?: Array<{ id: string; brand?: string; model?: string }>
  orders?: CustomerOrderSummary[]
}

// ─── RPC types ────────────────────────────────────────────────────────────────

interface PurchaseItem {
  id:              string
  descripcion:     string
  tipo_linea:      string
  cantidad:        number
  precio_unitario: number
  subtotal:        number
}

interface PurchaseRecord {
  id:                       string
  date:                     string
  created_at:               string
  tipo:                     string
  numero:                   string | null
  numero_local:             string | null
  numero_fiscal:            string | null
  cae:                      string | null
  estado:                   string
  estado_fiscal:            string | null
  estado_comercial:         string
  emitido_arca:             boolean
  total:                    number
  total_cobrado:            number
  saldo_pendiente:          number
  order_id:                 string | null
  comprobante_original_id:  string | null
  is_credit_note:           boolean
  observaciones:            string | null
  payment_methods:          string[]
  items:                    PurchaseItem[]
}

interface PurchaseSummary {
  total_purchases:  number
  total_spent:      number
  total_refunded:   number
  net_spent:        number
  pending_balance:  number
  last_purchase_at: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (v: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(Number.isFinite(v) ? v : 0)

const TIPO_LABEL: Record<string, string> = {
  factura_a: 'Factura A', factura_c: 'Factura C',
  nota_credito: 'Nota de Crédito', remito: 'Remito',
}

const ESTADO_COM_META: Record<string, { label: string; color: string; bg: string }> = {
  pagado:   { label: 'Pagado',   color: '#34d399', bg: 'rgba(52,211,153,0.1)' },
  parcial:  { label: 'Parcial',  color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  pendiente:{ label: 'Pendiente',color: '#f87171', bg: 'rgba(248,113,113,0.1)' },
  anulado:  { label: 'Anulado',  color: '#64748b', bg: 'rgba(100,116,139,0.1)' },
}

const TIPO_LINEA_COLOR: Record<string, string> = {
  producto: '#818cf8', repuesto: '#f59e0b', servicio: '#34d399', otro: '#64748b',
}

const CC_STATUS = {
  al_dia:  { label: 'Al día',   color: '#34d399', bg: 'rgba(52,211,153,0.1)',  border: 'rgba(52,211,153,0.25)'  },
  deuda:   { label: 'En deuda', color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.25)' },
  a_favor: { label: 'A favor',  color: '#60a5fa', bg: 'rgba(96,165,250,0.1)',  border: 'rgba(96,165,250,0.25)'  },
}

const getStatusStyle = (status: string) => {
  const config = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]
  return {
    backgroundColor: config ? `${config.color}20` : 'rgba(100,116,139,0.2)',
    color: config?.color || '#94a3b8',
    padding: '0.2rem 0.625rem',
    borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 500,
  }
}

// ─── Purchase row — historial de compras ──────────────────────────────────────

function PurchaseRow({ purchase }: { purchase: PurchaseRecord }) {
  const [open, setOpen]   = useState(false)
  const navigate          = useNavigate()
  const meta = ESTADO_COM_META[purchase.estado_comercial] || ESTADO_COM_META.pendiente

  const displayNumber = purchase.numero_fiscal ?? purchase.numero_local ?? purchase.id.slice(0, 8)

  return (
    <div
      data-testid="customer-purchase-row"
      style={{
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        padding: '0.875rem 1rem',
        transition: 'background 0.12s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.03)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {/* ── Main row ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        {/* Expand button */}
        <button
          data-testid="customer-purchase-expand"
          onClick={() => setOpen(v => !v)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-subtle)', padding: '0.1rem', display: 'flex', alignItems: 'center', flexShrink: 0 }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        {/* Tipo badge */}
        <span style={{
          padding: '0.15rem 0.5rem', borderRadius: '0.25rem', fontSize: '0.68rem', fontWeight: 700,
          background: purchase.is_credit_note ? 'rgba(251,191,36,0.12)' : purchase.tipo === 'remito' ? 'rgba(52,211,153,0.1)' : 'rgba(99,102,241,0.1)',
          color: purchase.is_credit_note ? '#fbbf24' : purchase.tipo === 'remito' ? '#34d399' : '#818cf8',
          whiteSpace: 'nowrap', flexShrink: 0,
        }}>
          {purchase.is_credit_note ? '↩ NC' : (TIPO_LABEL[purchase.tipo] || purchase.tipo)}
        </span>

        {/* ARCA / Local badge */}
        {purchase.emitido_arca && (
          <span style={{ padding: '0.1rem 0.4rem', borderRadius: '0.25rem', fontSize: '0.62rem', fontWeight: 700, background: 'rgba(6,182,212,0.1)', color: '#22d3ee', flexShrink: 0 }}>
            ARCA ✓
          </span>
        )}

        {/* Número */}
        <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: 'var(--text-secondary)', fontWeight: 600, flexShrink: 0 }}>
          {displayNumber}
        </span>

        {/* Items summary */}
        {purchase.items.length > 0 && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {purchase.items.slice(0, 2).map(i => i.descripcion).join(', ')}
            {purchase.items.length > 2 ? ` +${purchase.items.length - 2}` : ''}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Payment methods */}
        <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
          {(purchase.payment_methods || []).slice(0, 2).map(m => (
            <span key={m} style={{ fontSize: '0.62rem', padding: '0.1rem 0.35rem', borderRadius: '0.25rem', background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)', textTransform: 'capitalize' }}>
              {m}
            </span>
          ))}
        </div>

        {/* Total */}
        <span style={{ fontWeight: 700, fontSize: '0.9rem', color: purchase.is_credit_note ? '#fbbf24' : 'var(--text-primary)', fontFamily: 'monospace', flexShrink: 0 }}>
          {purchase.is_credit_note ? '-' : ''}{fmt(purchase.total)}
        </span>

        {/* Estado comercial badge */}
        <span style={{ padding: '0.15rem 0.5rem', borderRadius: '9999px', fontSize: '0.68rem', fontWeight: 600, background: meta.bg, color: meta.color, flexShrink: 0 }}>
          {meta.label}
        </span>

        {/* Saldo */}
        {purchase.saldo_pendiente > 0.5 && (
          <span style={{ fontSize: '0.72rem', color: '#f87171', flexShrink: 0 }}>
            Saldo: {fmt(purchase.saldo_pendiente)}
          </span>
        )}

        {/* Fecha */}
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', flexShrink: 0 }}>
          {new Date(purchase.date).toLocaleDateString('es-AR')}
        </span>

        {/* Open link */}
        <button
          data-testid="customer-purchase-open-comprobante"
          onClick={e => { e.stopPropagation(); navigate(`/comprobantes/${purchase.id}`) }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-primary)', padding: '0.2rem', display: 'flex', alignItems: 'center', flexShrink: 0 }}
          title="Abrir comprobante"
        >
          <ExternalLink size={13} />
        </button>
      </div>

      {/* ── Items expandidos ── */}
      {open && purchase.items.length > 0 && (
        <div
          data-testid="customer-purchase-items"
          style={{ marginTop: '0.625rem', marginLeft: '1.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '0.5rem', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.05)' }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                {['Descripción', 'Tipo', 'Cant.', 'Precio unit.', 'Subtotal'].map(h => (
                  <th key={h} style={{ padding: '0.35rem 0.75rem', textAlign: 'left', color: 'var(--text-subtle)', fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {purchase.items.map(item => (
                <tr key={item.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <td style={{ padding: '0.375rem 0.75rem', color: 'var(--text-secondary)' }}>{item.descripcion}</td>
                  <td style={{ padding: '0.375rem 0.75rem' }}>
                    <span style={{ padding: '0.1rem 0.35rem', borderRadius: '0.2rem', fontSize: '0.62rem', fontWeight: 700, background: `${TIPO_LINEA_COLOR[item.tipo_linea] || '#64748b'}18`, color: TIPO_LINEA_COLOR[item.tipo_linea] || '#64748b' }}>
                      {item.tipo_linea}
                    </span>
                  </td>
                  <td style={{ padding: '0.375rem 0.75rem', fontFamily: 'monospace', textAlign: 'center', color: 'var(--text-muted)' }}>{item.cantidad}</td>
                  <td style={{ padding: '0.375rem 0.75rem', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{fmt(item.precio_unitario)}</td>
                  <td style={{ padding: '0.375rem 0.75rem', fontFamily: 'monospace', fontWeight: 600, color: 'var(--text-primary)' }}>{fmt(item.subtotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CustomerDetail() {
  const { id } = useParams<{ id: string }>()
  const { businessId, user } = useAuth()
  const [customer,      setCustomer]      = useState<CustomerDetailData | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)
  const [ccAccount,     setCcAccount]     = useState<Account | null>(null)
  const [showPagarCC,   setShowPagarCC]   = useState(false)
  const [activeTab,     setActiveTab]     = useState<'ordenes' | 'compras'>('ordenes')
  // RPC purchase history
  const [purchases,     setPurchases]     = useState<PurchaseRecord[]>([])
  const [phSummary,     setPhSummary]     = useState<PurchaseSummary | null>(null)
  const [phLoading,     setPhLoading]     = useState(false)
  const [searchTerm,    setSearchTerm]    = useState('')
  const [filterTipo,    setFilterTipo]    = useState<'todos' | 'facturas' | 'remitos' | 'nc'>('todos')

  // Load customer
  useEffect(() => {
    if (!id) { setError('Cliente no encontrado'); setLoading(false); return }
    customersService.getById(id)
      .then(data => setCustomer(data as CustomerDetailData))
      .catch((e: any) => setError(e.message || 'Error al cargar cliente'))
      .finally(() => setLoading(false))
  }, [id])

  // Load CC account
  const loadCcAccount = useCallback(async () => {
    if (!businessId || !id) return
    const accounts = await cuentasService.getAccounts(businessId, 'cliente')
    setCcAccount(accounts.find(a => a.entity_id === id) || null)
  }, [businessId, id])

  useEffect(() => { void loadCcAccount() }, [loadCcAccount])

  // Load purchase history via RPC when tab selected
  useEffect(() => {
    if (activeTab !== 'compras' || !id || !businessId) return
    setPhLoading(true)
    void Promise.resolve(
      supabase.rpc('customer_purchase_history', { p_customer_id: id, p_business_id: businessId })
    ).then(({ data, error: rpcErr }) => {
      if (!rpcErr && data?.ok) {
        setPurchases((data.purchases || []) as PurchaseRecord[])
        setPhSummary(data.summary as PurchaseSummary)
      }
    }).finally(() => setPhLoading(false))
  }, [activeTab, id, businessId])

  // Filtered + searched purchases
  const filteredPurchases = useMemo(() => {
    let list = purchases
    if (filterTipo !== 'todos') {
      if (filterTipo === 'facturas')  list = list.filter(p => ['factura_a','factura_c'].includes(p.tipo))
      if (filterTipo === 'remitos')   list = list.filter(p => p.tipo === 'remito')
      if (filterTipo === 'nc')        list = list.filter(p => p.is_credit_note)
    }
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase()
      list = list.filter(p =>
        (p.numero ?? '').toLowerCase().includes(q) ||
        p.items.some(i => i.descripcion.toLowerCase().includes(q))
      )
    }
    return list
  }, [purchases, filterTipo, searchTerm])

  // ── Computed stats ────────────────────────────────────────────────────────
  const totalComprado = phSummary?.total_spent ?? purchases.reduce((s, p) => s + (p.total || 0), 0)
  const deudaCC       = ccAccount && ccAccount.balance > 0 ? ccAccount.balance : 0
  const ultimaCompra  = phSummary?.last_purchase_at ?? (purchases[0]?.date || purchases[0]?.created_at || null)

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}><Loader size="lg" text="Cargando cliente..." /></div>

  if (error || !customer) {
    return (
      <div style={{ padding: '2rem' }}>
        <Link to="/customers" className="btn btn-outline btn-sm" style={{ marginBottom: '1rem' }}><ArrowLeft size={16} /> Volver a Clientes</Link>
        <div className="alert-inline alert-error">
          {error || 'Cliente no encontrado'}
        </div>
      </div>
    )
  }

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon">
            <User size={22} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
              <h1 className="page-hdr-title">{customer.name}</h1>
              {customer.customer_type === 'mayorista' ? (
                <span className="badge badge-info"><Building2 size={11} /> Mayorista</span>
              ) : (
                <span className="badge badge-neutral"><User size={11} /> Minorista</span>
              )}
            </div>
            <p className="page-hdr-subtitle">
              {customer.orders?.length ?? 0} orden{(customer.orders?.length ?? 0) !== 1 ? 'es' : ''}
            </p>
          </div>
        </div>
        <div className="page-hdr-right">
          <Link to="/customers" className="btn btn-outline btn-sm">
            <ArrowLeft size={16} /> Volver
          </Link>
        </div>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.875rem', marginBottom: '1.5rem' }}>
        {[
          { label: 'Total comprado', value: fmt(totalComprado), color: '#818cf8', icon: <ShoppingBag size={16} /> },
          { label: 'Comprobantes', value: String(purchases.length || (customer.orders?.length ?? 0)), color: '#34d399', icon: <Receipt size={16} /> },
          { label: 'Deuda CC', value: deudaCC > 0 ? fmt(deudaCC) : 'Sin deuda', color: deudaCC > 0 ? '#f87171' : '#34d399', icon: <CreditCard size={16} /> },
          { label: 'Última compra', value: ultimaCompra ? new Date(ultimaCompra).toLocaleDateString('es-AR') : '—', color: '#64748b', icon: <Tag size={16} /> },
        ].map(s => (
          <div key={s.label} className="stat-card" style={{ padding: '0.875rem 1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.label}</span>
              <span style={{ color: s.color }}>{s.icon}</span>
            </div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: s.color, fontFamily: 'monospace' }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* CC widget */}
      {ccAccount && Math.abs(ccAccount.balance) > 0.01 && (() => {
        const status = getAccountStatus(ccAccount.balance)
        const sm = CC_STATUS[status]
        return (
          <div className="card" style={{ marginBottom: '1.5rem', borderColor: sm.border, background: sm.bg }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <CreditCard size={20} style={{ color: sm.color }} />
                <div>
                  <div style={{ fontSize: '0.7rem', fontWeight: 700, color: sm.color, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Cuenta Corriente</div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 800, fontFamily: 'monospace', color: sm.color }}>{fmt(Math.abs(ccAccount.balance))}</div>
                </div>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '0.2rem 0.625rem', borderRadius: '9999px', background: sm.bg, color: sm.color, border: `1px solid ${sm.border}` }}>{sm.label}</span>
              </div>
              {ccAccount.balance > 0 && (
                <button onClick={() => setShowPagarCC(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 1.125rem', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', border: 'none', borderRadius: '0.625rem', color: '#fff', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', boxShadow: '0 4px 12px rgba(99,102,241,0.3)' }}>
                  <CreditCard size={14} /> Registrar pago
                </button>
              )}
            </div>
          </div>
        )
      })()}

      {/* Main layout: contact (left) + tabs (right) */}
      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: '1.5rem', alignItems: 'start' }}>

        {/* Contact card */}
        <div className="card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <User size={18} color="#6366f1" />
            <h3 className="card-title">Contacto</h3>
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Phone size={16} color="#64748b" />
                <span style={{ fontSize: '0.875rem' }}>{customer.phone || 'Sin teléfono'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Mail size={16} color="#64748b" />
                <span style={{ fontSize: '0.875rem', wordBreak: 'break-all' }}>{customer.email || 'Sin email'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                <MapPin size={16} color="#64748b" style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                <span style={{ fontSize: '0.875rem' }}>{customer.address || 'Sin dirección'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Smartphone size={16} color="#64748b" />
                <span style={{ fontSize: '0.875rem' }}>{customer.devices?.length || 0} dispositivo(s)</span>
              </div>
            </div>
          </div>
        </div>

        {/* Tabbed main content */}
        <div className="card" style={{ overflow: 'hidden' }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)', padding: '0 0.5rem' }}>
            {([
              { id: 'ordenes', label: 'Órdenes', icon: <ClipboardList size={14} />, count: customer.orders?.length ?? 0 },
              { id: 'compras', label: 'Compras', icon: <ShoppingBag size={14} />, count: purchases.length },
            ] as const).map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.375rem',
                  padding: '0.875rem 1rem', border: 'none', background: 'none',
                  borderBottom: `2px solid ${activeTab === tab.id ? '#6366f1' : 'transparent'}`,
                  color: activeTab === tab.id ? '#818cf8' : '#64748b',
                  fontSize: '0.875rem', fontWeight: activeTab === tab.id ? 700 : 500,
                  cursor: 'pointer', transition: 'all 0.15s',
                }}
              >
                {tab.icon} {tab.label}
                {tab.count > 0 && (
                  <span style={{ padding: '0.1rem 0.4rem', borderRadius: '9999px', fontSize: '0.68rem', fontWeight: 700, background: activeTab === tab.id ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.05)', color: activeTab === tab.id ? '#818cf8' : '#475569' }}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* ── Tab: Órdenes ── */}
          {activeTab === 'ordenes' && (
            <div style={{ padding: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Orden</th>
                    <th>Dispositivo</th>
                    <th>Estado</th>
                    <th>Total</th>
                    <th>Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {!customer.orders || customer.orders.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', padding: '2.5rem', color: '#64748b' }}>
                        Este cliente no tiene órdenes de servicio registradas.
                      </td>
                    </tr>
                  ) : customer.orders.map(order => {
                    const amount = typeof order.total_cost === 'number' && order.total_cost > 0
                      ? order.total_cost
                      : order.estimated_total || 0
                    const deviceLabel = order.device
                      ? `${order.device.brand || ''} ${order.device.model || ''}`.trim()
                      : 'Dispositivo asociado'
                    return (
                      <tr key={order.id}>
                        <td>
                          <Link to={`/orders/${order.id}`} style={{ color: '#6366f1', fontWeight: 600 }}>
                            #{order.id.slice(0, 8)}
                          </Link>
                        </td>
                        <td>{deviceLabel || 'Sin dispositivo'}</td>
                        <td>
                          <span style={getStatusStyle(order.status)}>
                            {STATUS_CONFIG[order.status as keyof typeof STATUS_CONFIG]?.label || order.status}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>{fmt(amount)}</td>
                        <td style={{ color: '#64748b' }}>{new Date(order.created_at).toLocaleDateString('es-AR')}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Tab: Compras — historial de compras ── */}
          {activeTab === 'compras' && (
            <div data-testid="customer-purchase-history">

              {/* ── Summary cards ── */}
              {phSummary && !phLoading && (
                <div
                  data-testid="customer-purchase-summary"
                  style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', padding: '1.25rem 1.25rem 0' }}
                >
                  {[
                    { icon: <ShoppingBag size={16} />, label: 'Compras',        value: String(phSummary.total_purchases),        color: '#818cf8' },
                    { icon: <TrendingUp  size={16} />, label: 'Total gastado',   value: fmt(phSummary.total_spent),               color: '#34d399' },
                    { icon: <RotateCcw   size={16} />, label: 'Devoluciones',    value: fmt(phSummary.total_refunded),            color: '#fbbf24' },
                    { icon: <Wallet      size={16} />, label: 'Saldo pendiente', value: fmt(phSummary.pending_balance),           color: phSummary.pending_balance > 0 ? '#f87171' : '#34d399' },
                  ].map(s => (
                    <div key={s.label} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.625rem', padding: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <span style={{ color: s.color }}>{s.icon}</span>
                      <div>
                        <div style={{ fontSize: '1rem', fontWeight: 700, color: s.color }}>{s.value}</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{s.label}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Search + filters ── */}
              {!phLoading && purchases.length > 0 && (
                <div style={{ display: 'flex', gap: '0.75rem', padding: '1rem 1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  {/* Search */}
                  <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
                    <Search size={13} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-subtle)', pointerEvents: 'none' }} />
                    <input
                      className="form-control"
                      style={{ paddingLeft: '2.25rem', height: 36, fontSize: '0.82rem' }}
                      placeholder="Buscar por número o producto..."
                      value={searchTerm}
                      onChange={e => setSearchTerm(e.target.value)}
                    />
                  </div>
                  {/* Type filter */}
                  <div style={{ display: 'flex', gap: '0.375rem' }} data-testid="customer-purchase-filter">
                    {([
                      { key: 'todos',    label: 'Todos'   },
                      { key: 'facturas', label: 'Facturas' },
                      { key: 'remitos',  label: 'Remitos' },
                      { key: 'nc',       label: 'NC'      },
                    ] as const).map(f => (
                      <button key={f.key} onClick={() => setFilterTipo(f.key)}
                        style={{ padding: '0.3rem 0.75rem', borderRadius: '0.375rem', border: `1px solid ${filterTipo === f.key ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.08)'}`, background: filterTipo === f.key ? 'rgba(99,102,241,0.12)' : 'transparent', color: filterTipo === f.key ? '#818cf8' : 'var(--text-muted)', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}>
                        {f.label}
                      </button>
                    ))}
                  </div>
                  {filteredPurchases.length !== purchases.length && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-subtle)' }}>{filteredPurchases.length} resultado{filteredPurchases.length !== 1 ? 's' : ''}</span>
                  )}
                </div>
              )}

              {/* ── Content ── */}
              {phLoading ? (
                <div style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                  <Loader size="sm" />
                  <span style={{ marginLeft: '0.5rem' }}>Cargando historial de compras…</span>
                </div>
              ) : purchases.length === 0 ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                  <ShoppingBag size={32} style={{ margin: '0 auto 0.875rem', opacity: 0.3, display: 'block' }} />
                  <p style={{ margin: 0, fontWeight: 600 }}>Este cliente todavía no tiene compras registradas.</p>
                </div>
              ) : filteredPurchases.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                  Sin resultados para la búsqueda.
                </div>
              ) : (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', marginTop: '0.25rem' }}>
                  {filteredPurchases.map(p => <PurchaseRow key={p.id} purchase={p} />)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {ccAccount && (
        <ModalPagarCC
          isOpen={showPagarCC}
          onClose={() => setShowPagarCC(false)}
          onPagado={() => { setShowPagarCC(false); void loadCcAccount() }}
          account={ccAccount}
          businessId={businessId || ''}
          userId={user?.id || ''}
        />
      )}
    </div>
  )
}
