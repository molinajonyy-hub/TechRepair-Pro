import { useEffect, useState, useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft, User, Phone, Mail, MapPin, ClipboardList,
  Smartphone, Building2, CreditCard, ShoppingBag, ChevronDown,
  ChevronRight, Receipt, Tag,
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

interface ComprobanteItem {
  id: string
  descripcion: string
  tipo_linea: string
  cantidad: number
  precio_unitario: number
  costo_unitario: number
  subtotal: number
  applied_price_type?: string | null
}

interface CustomerComprobante {
  id: string
  numero: string | null
  tipo: string
  fecha: string
  created_at: string
  total: number
  total_cobrado: number
  saldo_pendiente: number
  estado: string
  estado_comercial?: string | null
  items?: ComprobanteItem[]
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

// ─── Comprobante row — expandable ─────────────────────────────────────────────

function ComprobanteRow({ comp }: { comp: CustomerComprobante }) {
  const [open, setOpen] = useState(false)
  const meta = ESTADO_COM_META[comp.estado_comercial || 'pendiente'] || ESTADO_COM_META.pendiente
  const isWholesale = comp.items?.some(i => i.applied_price_type === 'mayorista')

  const totalCosto = (comp.items || []).reduce((s, i) => s + (i.costo_unitario || 0) * i.cantidad, 0)
  const ganancia   = comp.total - totalCosto

  return (
    <>
      <tr
        onClick={() => setOpen(v => !v)}
        style={{ cursor: 'pointer', borderBottom: open ? 'none' : '1px solid rgba(255,255,255,0.04)' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.04)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <td style={{ padding: '0.625rem 1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {open ? <ChevronDown size={13} style={{ color: '#64748b', flexShrink: 0 }} /> : <ChevronRight size={13} style={{ color: '#64748b', flexShrink: 0 }} />}
            <Link to={`/comprobantes/${comp.id}`} onClick={e => e.stopPropagation()} style={{ color: '#6366f1', fontWeight: 600, fontSize: '0.85rem' }}>
              {comp.numero ? `#${comp.numero}` : `#${comp.id.slice(0, 8)}`}
            </Link>
            {isWholesale && (
              <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '0.1rem 0.375rem', borderRadius: '0.25rem', background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }}>MAY</span>
            )}
          </div>
          <div style={{ fontSize: '0.7rem', color: '#475569', marginLeft: '1.375rem' }}>{TIPO_LABEL[comp.tipo] || comp.tipo}</div>
        </td>
        <td style={{ padding: '0.625rem 1rem', color: '#64748b', fontSize: '0.8rem' }}>
          {new Date(comp.fecha || comp.created_at).toLocaleDateString('es-AR')}
        </td>
        <td style={{ padding: '0.625rem 1rem', fontSize: '0.78rem', color: '#64748b' }}>
          {comp.items?.length ?? '—'} ítem{comp.items?.length !== 1 ? 's' : ''}
        </td>
        <td style={{ padding: '0.625rem 1rem', fontWeight: 600, fontFamily: 'monospace', fontSize: '0.85rem' }}>
          {fmt(comp.total)}
        </td>
        <td style={{ padding: '0.625rem 1rem' }}>
          <span style={{ padding: '0.15rem 0.5rem', borderRadius: '9999px', fontSize: '0.7rem', fontWeight: 700, background: meta.bg, color: meta.color }}>
            {meta.label}
          </span>
          {comp.saldo_pendiente > 0.5 && (
            <div style={{ fontSize: '0.68rem', color: '#f59e0b', marginTop: '0.1rem' }}>Saldo: {fmt(comp.saldo_pendiente)}</div>
          )}
        </td>
        <td style={{ padding: '0.625rem 1rem', fontFamily: 'monospace', fontSize: '0.78rem', color: ganancia >= 0 ? '#34d399' : '#f87171' }}>
          {totalCosto > 0 ? (ganancia >= 0 ? '+' : '') + fmt(ganancia) : '—'}
        </td>
      </tr>
      {open && (
        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <td colSpan={6} style={{ padding: '0 0 0.875rem 1.375rem' }}>
            <div style={{ margin: '0 1rem', background: 'rgba(255,255,255,0.02)', borderRadius: '0.5rem', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.05)' }}>
              {(comp.items || []).length === 0 ? (
                <p style={{ margin: 0, padding: '0.875rem', color: '#475569', fontSize: '0.78rem' }}>Sin ítems registrados.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                      {['Descripción', 'Tipo', 'Cant.', 'Precio unit.', 'Costo', 'Ganancia', 'Subtotal'].map(h => (
                        <th key={h} style={{ padding: '0.4rem 0.75rem', textAlign: 'left', color: '#334155', fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {comp.items!.map(item => {
                      const linGanancia = (item.precio_unitario - (item.costo_unitario || 0)) * item.cantidad
                      return (
                        <tr key={item.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                          <td style={{ padding: '0.4rem 0.75rem', color: '#e2e8f0' }}>
                            {item.descripcion}
                            {item.applied_price_type === 'mayorista' && <span style={{ marginLeft: '0.375rem', fontSize: '0.6rem', color: '#818cf8', fontWeight: 700 }}>MAYO</span>}
                          </td>
                          <td style={{ padding: '0.4rem 0.75rem' }}>
                            <span style={{ padding: '0.1rem 0.375rem', borderRadius: '0.2rem', fontSize: '0.65rem', fontWeight: 700, background: `${TIPO_LINEA_COLOR[item.tipo_linea] || '#64748b'}18`, color: TIPO_LINEA_COLOR[item.tipo_linea] || '#64748b' }}>
                              {item.tipo_linea}
                            </span>
                          </td>
                          <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', textAlign: 'center', color: '#94a3b8' }}>{item.cantidad}</td>
                          <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', color: '#94a3b8' }}>{fmt(item.precio_unitario)}</td>
                          <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', color: '#64748b' }}>{item.costo_unitario ? fmt(item.costo_unitario) : '—'}</td>
                          <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', color: linGanancia >= 0 ? '#34d399' : '#f87171', fontSize: '0.75rem' }}>
                            {item.costo_unitario ? (linGanancia >= 0 ? '+' : '') + fmt(linGanancia) : '—'}
                          </td>
                          <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', fontWeight: 600, color: '#f1f5f9' }}>{fmt(item.subtotal)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
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
  const [comprobantes,  setComprobantes]  = useState<CustomerComprobante[]>([])
  const [compLoading,   setCompLoading]   = useState(false)

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

  // Load comprobantes when tab selected
  useEffect(() => {
    if (activeTab !== 'compras' || !id || !businessId) return
    setCompLoading(true)
    supabase
      .from('comprobantes')
      .select(`
        id, numero, number, tipo, type, fecha, date, created_at,
        total, total_cobrado, saldo_pendiente,
        estado, status, estado_comercial,
        items:comprobante_items(id, descripcion, tipo_linea, cantidad, precio_unitario, costo_unitario, subtotal, applied_price_type)
      `)
      .eq('business_id', businessId)
      .eq('customer_id', id)
      .in('estado', ['emitido', 'issued'])
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setComprobantes((data || []).map((c: any) => ({
          ...c,
          numero:   c.numero || c.number || null,
          tipo:     c.tipo   || c.type   || 'factura_c',
          fecha:    c.fecha  || c.date   || c.created_at,
          estado_comercial: c.estado_comercial || (c.saldo_pendiente > 0.5 ? 'parcial' : 'pagado'),
        })) as CustomerComprobante[])
        setCompLoading(false)
      })
  }, [activeTab, id, businessId])

  // ── Computed stats ────────────────────────────────────────────────────────
  const totalComprado = comprobantes.reduce((s, c) => s + (c.total || 0), 0)
  const deudaCC       = ccAccount && ccAccount.balance > 0 ? ccAccount.balance : 0
  const ultimaCompra  = comprobantes[0]?.fecha || comprobantes[0]?.created_at || null

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}><Loader size="lg" text="Cargando cliente..." /></div>

  if (error || !customer) {
    return (
      <div style={{ padding: '2rem' }}>
        <Link to="/customers" className="btn btn-outline btn-sm" style={{ marginBottom: '1rem' }}><ArrowLeft size={16} /> Volver a Clientes</Link>
        <div style={{ padding: '1.5rem', backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '0.75rem' }}>
          <p style={{ color: '#f87171' }}>{error || 'Cliente no encontrado'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="animate-fade-in">
      <Link to="/customers" className="btn btn-outline btn-sm" style={{ marginBottom: '1rem' }}>
        <ArrowLeft size={16} /> Volver a Clientes
      </Link>

      {/* Name + badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>{customer.name}</h1>
        {customer.customer_type === 'mayorista' ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', padding: '0.25rem 0.75rem', borderRadius: '999px', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.35)', fontSize: '0.78rem', fontWeight: 700, color: '#818cf8' }}>
            <Building2 size={12} /> Mayorista
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', padding: '0.25rem 0.75rem', borderRadius: '999px', background: 'rgba(100,116,139,0.12)', border: '1px solid rgba(100,116,139,0.25)', fontSize: '0.78rem', fontWeight: 600, color: '#64748b' }}>
            <User size={12} /> Minorista
          </span>
        )}
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.875rem', marginBottom: '1.5rem' }}>
        {[
          { label: 'Total comprado', value: fmt(totalComprado), color: '#818cf8', icon: <ShoppingBag size={16} /> },
          { label: 'Comprobantes', value: String(comprobantes.length || (customer.orders?.length ?? 0)), color: '#34d399', icon: <Receipt size={16} /> },
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
              { id: 'compras', label: 'Compras', icon: <ShoppingBag size={14} />, count: comprobantes.length },
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

          {/* ── Tab: Compras (comprobantes) ── */}
          {activeTab === 'compras' && (
            <div style={{ padding: 0 }}>
              {compLoading ? (
                <div style={{ padding: '2.5rem', textAlign: 'center', color: '#64748b' }}>
                  <div style={{ width: 24, height: 24, borderRadius: '50%', border: '2px solid #6366f1', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', margin: '0 auto 0.5rem' }} />
                  <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                  Cargando historial de compras...
                </div>
              ) : comprobantes.length === 0 ? (
                <div style={{ padding: '2.5rem', textAlign: 'center', color: '#64748b' }}>
                  <ShoppingBag size={28} style={{ margin: '0 auto 0.75rem', opacity: 0.3, display: 'block' }} />
                  Este cliente no tiene comprobantes emitidos.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      {['Comprobante', 'Fecha', 'Ítems', 'Total', 'Estado', 'Ganancia'].map(h => (
                        <th key={h} style={{ padding: '0.625rem 1rem', textAlign: 'left', color: '#334155', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {comprobantes.map(comp => <ComprobanteRow key={comp.id} comp={comp} />)}
                  </tbody>
                </table>
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
