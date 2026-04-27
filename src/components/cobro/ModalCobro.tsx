/**
 * ModalCobro — Cobro rápido con comisiones y emisión de comprobante integrada
 * Flujo: Items → Pago (con comisión) → Éxito → Comprobante (opcional)
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { X, Plus, Trash2, ChevronRight, ChevronLeft, Check, Search } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { invalidateStatsCache } from '../../hooks/useDashboardStats'
import { useCommissionRates, COMMISSION_KEYS } from '../../hooks/useCommissionRates'
import { ModalCrearComprobante } from '../comprobantes/ModalCrearComprobante'

// ─── Tipos ───────────────────────────────────────────────────────────────────

type Origen = 'orden' | 'venta_rapida' | 'personalizado'
export type MetodoPago =
  | 'efectivo' | 'transferencia'
  | 'mp_debito' | 'mp_credito' | 'mp_qr'
  | 'visa_mc_1' | 'visa_mc_3' | 'visa_mc_6' | 'visa_mc_12'
  | 'naranja_1' | 'naranja_3' | 'naranja_6' | 'naranja_12'
type Step = 'items' | 'pago' | 'exito'

interface CobroItem {
  id: string
  nombre: string
  cantidad: number
  precio: number
}

interface PagoEntry {
  metodo: MetodoPago
  montoARS: number
  montoUSD: number
  usaUSD: boolean
}

interface ClienteResult {
  id: string
  name: string
  phone: string | null
  email: string | null
  customer_type?: 'minorista' | 'mayorista'
}

interface OrdenResult {
  id: string
  titulo: string
  total_cost: number | null
  amount_paid: number | null
  customer_name: string | null
  customer_id: string | null
}

export interface ModalCobroProps {
  isOpen: boolean
  onClose: () => void
  orderId?: string
  clienteId?: string
}

// ─── Grupos de métodos de pago ────────────────────────────────────────────────

const METODO_GROUPS = [
  {
    label: 'Sin recargo',
    color: '#64748b',
    methods: [
      { id: 'efectivo' as MetodoPago,     label: 'Efectivo',     emoji: '💵', color: '#22c55e' },
      { id: 'transferencia' as MetodoPago, label: 'Transferencia', emoji: '🏦', color: '#3b82f6' },
    ],
  },
  {
    label: 'MercadoPago',
    color: '#009ee3',
    methods: [
      { id: 'mp_debito' as MetodoPago,  label: 'Débito',  emoji: '💳', color: '#009ee3' },
      { id: 'mp_credito' as MetodoPago, label: 'Crédito', emoji: '💳', color: '#009ee3' },
      { id: 'mp_qr' as MetodoPago,      label: 'QR',      emoji: '📱', color: '#009ee3' },
    ],
  },
  {
    label: 'Visa / Mastercard',
    color: '#1a56db',
    methods: [
      { id: 'visa_mc_1' as MetodoPago,  label: '1 cuota',  emoji: '💳', color: '#1a56db' },
      { id: 'visa_mc_3' as MetodoPago,  label: '3 cuotas', emoji: '💳', color: '#1a56db' },
      { id: 'visa_mc_6' as MetodoPago,  label: '6 cuotas', emoji: '💳', color: '#1a56db' },
      { id: 'visa_mc_12' as MetodoPago, label: '12 cuotas',emoji: '💳', color: '#1a56db' },
    ],
  },
  {
    label: 'Naranja X',
    color: '#f97316',
    methods: [
      { id: 'naranja_1' as MetodoPago,  label: '1 cuota',  emoji: '🟠', color: '#f97316' },
      { id: 'naranja_3' as MetodoPago,  label: '3 cuotas', emoji: '🟠', color: '#f97316' },
      { id: 'naranja_6' as MetodoPago,  label: '6 cuotas', emoji: '🟠', color: '#f97316' },
      { id: 'naranja_12' as MetodoPago, label: '12 cuotas',emoji: '🟠', color: '#f97316' },
    ],
  },
] as const

const METODO_MAP = Object.fromEntries(
  METODO_GROUPS.flatMap(g => g.methods.map(m => [m.id, m]))
) as Record<MetodoPago, { id: MetodoPago; label: string; emoji: string; color: string }>

const newItem = (): CobroItem => ({ id: crypto.randomUUID(), nombre: '', cantidad: 1, precio: 0 })
const newPago = (metodo: MetodoPago = 'efectivo'): PagoEntry => ({ metodo, montoARS: 0, montoUSD: 0, usaUSD: false })
const fmt = (n: number) => '$' + Math.round(n).toLocaleString('es-AR')

// ─── Componente ──────────────────────────────────────────────────────────────

export function ModalCobro({ isOpen, onClose, orderId, clienteId }: ModalCobroProps) {
  const { businessId } = useAuth()
  const { rates } = useCommissionRates()

  // ── State principal ──
  const [step, setStep]       = useState<Step>('items')
  const [origen, setOrigen]   = useState<Origen>(orderId ? 'orden' : 'venta_rapida')
  const [items, setItems]     = useState<CobroItem[]>([newItem()])
  const [pagos, setPagos]     = useState<PagoEntry[]>([newPago('efectivo')])
  const [mixto, setMixto]     = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  // ── Cliente ──
  const [clienteQ, setClienteQ]         = useState('')
  const [clientes, setClientes]         = useState<ClienteResult[]>([])
  const [clienteSelec, setClienteSelec] = useState<ClienteResult | null>(null)

  const clienteTimer = useRef<ReturnType<typeof setTimeout>>()

  // ── Orden ──
  const [ordenQ, setOrdenQ]             = useState('')
  const [ordenes, setOrdenes]           = useState<OrdenResult[]>([])
  const [ordenSelec, setOrdenSelec]     = useState<OrdenResult | null>(null)

  const ordenTimer = useRef<ReturnType<typeof setTimeout>>()

  // ── Tipo de cambio ──
  const [dolar, setDolar] = useState<number>(0)

  // ── Comprobante interno ──
  const [comprobanteOpen, setComprobanteOpen]   = useState(false)
  const [comprobanteItems, setComprobanteItems] = useState<{ descripcion: string; cantidad: number; precio_unitario: number }[]>([])

  // ── Reset al abrir ──
  useEffect(() => {
    if (!isOpen) return
    setStep('items')
    setOrigen(orderId ? 'orden' : 'venta_rapida')
    setItems([newItem()])
    setPagos([newPago('efectivo')])
    setMixto(false)
    setError(null)
    setClienteQ('')
    setClienteSelec(null)
    setOrdenQ('')
    setOrdenSelec(null)
    loadDolar()
    if (orderId) prefillOrden(orderId)
    if (clienteId) prefillCliente(clienteId)
  }, [isOpen]) // eslint-disable-line

  // ── Comisión ──────────────────────────────────────────────────────────────
  const subtotal = useMemo(() => items.reduce((s, i) => s + i.cantidad * i.precio, 0), [items])

  const activeMetodo: MetodoPago = mixto ? 'efectivo' : (pagos[0]?.metodo ?? 'efectivo')
  const commissionKey = COMMISSION_KEYS[activeMetodo]
  const commissionRate = commissionKey ? rates[commissionKey] : 0
  const comisionMonto  = Math.round(subtotal * commissionRate)
  const totalCobrado   = subtotal + comisionMonto
  const hasCommission  = commissionRate > 0

  // ── Totales para balance ──
  const totalPagadoARS = pagos.reduce((s, p) => {
    const usdEnArs = p.usaUSD && dolar > 0 ? p.montoUSD * dolar : 0
    return s + p.montoARS + usdEnArs
  }, 0)
  const diferencia = totalCobrado - totalPagadoARS

  // ── Validaciones ──
  const itemsValidos = items.length > 0 && items.every(i => i.nombre.trim() && i.precio > 0)
  const pagoValido   = hasCommission ? true : Math.abs(diferencia) < 1

  // ─── Helpers ─────────────────────────────────────────────────────────────

  const loadDolar = async () => {
    if (!businessId) return
    const { data } = await supabase
      .from('exchange_rates').select('rate_ars_per_usd')
      .eq('business_id', businessId).eq('currency', 'USD')
      .order('effective_date', { ascending: false }).limit(1).maybeSingle()
    if (data?.rate_ars_per_usd) setDolar(data.rate_ars_per_usd)
  }

  const prefillOrden = async (id: string) => {
    const { data } = await supabase
      .from('orders')
      .select('id, device_id, customer_id, total_cost, amount_paid, customers(name, phone, email), order_parts(name, quantity, sale_price, status)')
      .eq('id', id).single()
    if (!data) return
    const saldo = (data.total_cost || 0) - (data.amount_paid || 0)
    setOrdenSelec({ id: data.id, titulo: `Orden #${data.id.slice(0, 6).toUpperCase()}`, total_cost: data.total_cost, amount_paid: data.amount_paid, customer_name: (data.customers as any)?.name ?? null, customer_id: data.customer_id })
    if (data.customers) setClienteSelec({ id: data.customer_id, name: (data.customers as any).name, phone: (data.customers as any).phone, email: (data.customers as any).email })
    const parts = ((data.order_parts as any[]) || []).filter(p => p.status === 'used' || p.status === 'sold')
    const amountPaid = data.amount_paid || 0
    if (saldo <= 0) {
      setItems([{ id: crypto.randomUUID(), nombre: 'Orden ya cobrada completa', cantidad: 1, precio: 0 }])
    } else if (parts.length > 0 && amountPaid > 0) {
      setItems([{ id: crypto.randomUUID(), nombre: `Saldo pendiente Orden #${id.slice(0, 6).toUpperCase()}`, cantidad: 1, precio: saldo }])
    } else if (parts.length > 0) {
      setItems(parts.map((p: any) => ({ id: crypto.randomUUID(), nombre: p.name || 'Repuesto', cantidad: p.quantity || 1, precio: p.sale_price || 0 })))
    } else if (saldo > 0) {
      setItems([{ id: crypto.randomUUID(), nombre: 'Servicio técnico', cantidad: 1, precio: saldo }])
    }
  }

  const prefillCliente = async (id: string) => {
    const { data } = await supabase.from('customers').select('id, name, phone, email, customer_type').eq('id', id).single()
    if (data) setClienteSelec(data)
  }

  const isClienteMayorista = clienteSelec?.customer_type === 'mayorista'

  const buscarClientes = useCallback((q: string) => {
    clearTimeout(clienteTimer.current)
    if (!q.trim() || !businessId) { setClientes([]); return }
    clienteTimer.current = setTimeout(async () => {

      const { data } = await supabase.from('customers').select('id, name, phone, email, customer_type').eq('business_id', businessId).or(`name.ilike.%${q}%,phone.ilike.%${q}%`).limit(5)
      setClientes(data || [])

    }, 250)
  }, [businessId])

  const buscarOrdenes = useCallback((q: string) => {
    clearTimeout(ordenTimer.current)
    if (!businessId) { setOrdenes([]); return }
    ordenTimer.current = setTimeout(async () => {

      const { data } = await supabase.from('orders').select('id, total_cost, amount_paid, status, customers(name, id)').eq('business_id', businessId).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(50)
      const filtered = (data || []).filter(o => {
        const saldo = (o.total_cost || 0) - (o.amount_paid || 0)
        const matchesQ = !q.trim() || o.id.slice(0, 6).toUpperCase().includes(q.toUpperCase()) || ((o.customers as any)?.name || '').toLowerCase().includes(q.toLowerCase())
        return saldo > 0.5 && matchesQ
      })
      setOrdenes(filtered.slice(0, 8).map(o => ({ id: o.id, titulo: `Orden #${o.id.slice(0, 6).toUpperCase()}`, total_cost: o.total_cost, amount_paid: o.amount_paid, customer_name: (o.customers as any)?.name ?? null, customer_id: (o.customers as any)?.id ?? null })))

    }, 250)
  }, [businessId])

  // ── Búsqueda de productos ──
  const [prodQ, setProdQ]           = useState<Record<string, string>>({})
  const [prodResults, setProdResults] = useState<Record<string, any[]>>({})
  const prodTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const buscarProducto = useCallback((itemId: string, q: string) => {
    setProdQ(prev => ({ ...prev, [itemId]: q }))
    clearTimeout(prodTimers.current[itemId])
    if (!q.trim() || !businessId) { setProdResults(prev => ({ ...prev, [itemId]: [] })); return }
    prodTimers.current[itemId] = setTimeout(async () => {
      const { data } = await supabase.from('inventory').select('id, name, sale_price, precio_mayorista, stock_quantity').eq('business_id', businessId).eq('is_active', true).ilike('name', `%${q}%`).gt('stock_quantity', 0).limit(6)
      setProdResults(prev => ({ ...prev, [itemId]: data || [] }))
    }, 200)
  }, [businessId])

  const seleccionarProducto = (itemId: string, prod: any) => {
    const useMayorista = isClienteMayorista && prod.precio_mayorista != null
    updateItem(itemId, 'nombre', prod.name)
    updateItem(itemId, 'precio', useMayorista ? prod.precio_mayorista : (prod.sale_price || 0))
    setProdQ(prev => ({ ...prev, [itemId]: '' }))
    setProdResults(prev => ({ ...prev, [itemId]: [] }))
  }

  // ── Item helpers ──
  const addItem    = () => setItems(prev => [...prev, newItem()])
  const removeItem = (id: string) => setItems(prev => prev.filter(i => i.id !== id))
  const updateItem = (id: string, field: keyof CobroItem, value: string | number) =>
    setItems(prev => prev.map(i => i.id === id ? { ...i, [field]: value } : i))

  // ── Pago helpers ──
  const addPago    = () => setPagos(prev => [...prev, newPago()])
  const removePago = (idx: number) => setPagos(prev => prev.filter((_, i) => i !== idx))
  const updatePago = (idx: number, field: keyof PagoEntry, value: any) =>
    setPagos(prev => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p))

  const selectMetodo = (metodo: MetodoPago) => {
    if (mixto) return
    const key = COMMISSION_KEYS[metodo]
    const rate = key ? rates[key] : 0
    const total = Math.round(subtotal * (1 + rate))
    setPagos([{ ...newPago(metodo), montoARS: total }])
  }

  const irAPago = () => {
    if (!itemsValidos) { setError('Completá todos los ítems con nombre y precio.'); return }
    setError(null)
    if (!mixto) {
      const key = COMMISSION_KEYS[pagos[0]?.metodo ?? 'efectivo']
      const rate = key ? rates[key] : 0
      setPagos([{ ...pagos[0], montoARS: Math.round(subtotal * (1 + rate)) }])
    }
    setStep('pago')
  }

  // ── COBRAR ──
  const cobrar = async () => {
    if (!pagoValido && !hasCommission) { setError(`Diferencia: ${fmt(Math.abs(diferencia))}. Revisá los montos.`); return }
    if (!businessId) return
    setLoading(true)
    setError(null)
    try {
      const description = items.map(i => `${i.cantidad}x ${i.nombre}`).join(', ')
      if (origen === 'orden' && ordenSelec?.id) {
        if (mixto) {
          for (const pago of pagos) {
            const monto = pago.montoARS + (pago.usaUSD && dolar > 0 ? pago.montoUSD * dolar : 0)
            if (monto <= 0) continue
            await supabase.from('order_payments').insert({ order_id: ordenSelec.id, business_id: businessId, amount: monto, payment_method: pago.metodo, notes: description, payment_date: new Date().toISOString().split('T')[0] })
          }
        } else {
          await supabase.from('order_payments').insert({ order_id: ordenSelec.id, business_id: businessId, amount: totalCobrado, payment_method: activeMetodo, notes: description, payment_date: new Date().toISOString().split('T')[0] })
        }
      } else {
        if (mixto) {
          for (const pago of pagos) {
            const monto = pago.montoARS + (pago.usaUSD && dolar > 0 ? pago.montoUSD * dolar : 0)
            if (monto <= 0) continue
            await supabase.from('business_finance_entries').insert({ business_id: businessId, date: new Date().toISOString().split('T')[0], type: 'income', category: origen === 'venta_rapida' ? 'venta' : 'servicio', description, amount: monto, currency: 'ARS', amount_ars: monto, exchange_rate: 1, source: 'cobro_rapido', customer_id: clienteSelec?.id ?? null, sale_type: isClienteMayorista ? 'mayorista' : 'minorista' })
          }
        } else {
          await supabase.from('business_finance_entries').insert({ business_id: businessId, date: new Date().toISOString().split('T')[0], type: 'income', category: origen === 'venta_rapida' ? 'venta' : 'servicio', description, amount: totalCobrado, currency: 'ARS', amount_ars: totalCobrado, exchange_rate: 1, source: 'cobro_rapido', customer_id: clienteSelec?.id ?? null, sale_type: isClienteMayorista ? 'mayorista' : 'minorista' })
        }
      }
      invalidateStatsCache()
      setStep('exito')
    } catch (e: any) {
      setError(e?.message ?? 'Error al registrar el cobro')
    } finally {
      setLoading(false)
    }
  }

  // ── Abrir comprobante desde éxito ──
  const abrirComprobante = () => {
    const scaled = items.map(i => ({
      descripcion: i.nombre,
      cantidad: i.cantidad,
      precio_unitario: commissionRate > 0
        ? Math.round(i.precio * (1 + commissionRate) * 100) / 100
        : i.precio,
    }))
    setComprobanteItems(scaled)
    setComprobanteOpen(true)
  }

  if (!isOpen) return null

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
        onClick={e => { if (e.target === e.currentTarget) onClose() }}
      >
        <div style={{ background: '#0d1a30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '1.25rem', width: '100%', maxWidth: '560px', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 32px 64px rgba(0,0,0,0.6)' }}>

          {/* ── Header ── */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, background: '#0d1a30', zIndex: 1, borderRadius: '1.25rem 1.25rem 0 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
              <div style={{ width: 36, height: 36, borderRadius: '0.625rem', background: 'linear-gradient(135deg, #22c55e, #16a34a)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem' }}>💰</div>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#f0f4ff' }}>Cobrar</h2>
                <p style={{ margin: 0, fontSize: '0.72rem', color: '#64748b' }}>
                  {step === 'items' ? 'Detalle del cobro' : step === 'pago' ? 'Forma de pago' : '¡Cobro registrado!'}
                </p>
              </div>
            </div>
            <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: '0.5rem', width: 32, height: 32, cursor: 'pointer', color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <X size={16} />
            </button>
          </div>

          {/* ── STEP: ITEMS ── */}
          {step === 'items' && (
            <div style={{ padding: '1.25rem 1.5rem' }}>
              {/* Origen */}
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
                {([
                  { id: 'venta_rapida', label: '⚡ Venta rápida' },
                  { id: 'orden',        label: '🔧 Orden' },
                  { id: 'personalizado',label: '✏️ Personalizado' },
                ] as { id: Origen; label: string }[]).map(o => (
                  <button key={o.id} onClick={() => { setOrigen(o.id); setItems([newItem()]); if (o.id === 'orden') buscarOrdenes('') }} style={{ flex: 1, padding: '0.5rem 0.375rem', borderRadius: '0.625rem', border: `1px solid ${origen === o.id ? '#22c55e' : 'rgba(255,255,255,0.1)'}`, background: origen === o.id ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.03)', color: origen === o.id ? '#22c55e' : '#64748b', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}>
                    {o.label}
                  </button>
                ))}
              </div>

              {/* Cliente */}
              <div style={{ marginBottom: '1rem', position: 'relative' }}>
                <label style={{ display: 'block', fontSize: '0.72rem', color: '#64748b', marginBottom: '0.375rem', fontWeight: 600 }}>
                  Cliente {origen === 'venta_rapida' && <span style={{ color: '#334155' }}>(opcional)</span>}
                </label>
                {clienteSelec ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.625rem 0.875rem', borderRadius: '0.625rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <span style={{ color: '#c7d2fe', fontWeight: 600, fontSize: '0.875rem' }}>{clienteSelec.name}</span>
                      {isClienteMayorista && (
                        <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '0.1rem 0.4rem', borderRadius: '9999px', background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)', color: '#a5b4fc' }}>
                          MAYORISTA
                        </span>
                      )}
                      {clienteSelec.phone && <span style={{ color: '#64748b', fontSize: '0.75rem' }}>{clienteSelec.phone}</span>}
                    </div>
                    <button onClick={() => { setClienteSelec(null); setClienteQ('') }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}><X size={14} /></button>
                  </div>
                ) : (
                  <>
                    <div style={{ position: 'relative' }}>
                      <Search size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
                      <input value={clienteQ} onChange={e => { setClienteQ(e.target.value); buscarClientes(e.target.value) }} placeholder="Buscar por nombre o teléfono..." style={{ ...inputS, paddingLeft: '2.25rem' }} />
                    </div>
                    {clientes.length > 0 && (
                      <div style={{ position: 'absolute', zIndex: 50, left: 0, right: 0, marginTop: '0.25rem', background: '#0d1a30', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '0.625rem', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
                        {clientes.map(c => (
                          <button key={c.id} onClick={() => { setClienteSelec(c); setClientes([]); setClienteQ('') }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '0.625rem 0.875rem', background: 'none', border: 'none', cursor: 'pointer', color: '#e2e8f0', fontSize: '0.85rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }} onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                            <strong>{c.name}</strong>{c.phone && <span style={{ color: '#64748b', marginLeft: '0.5rem', fontSize: '0.75rem' }}>{c.phone}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Orden selector */}
              {origen === 'orden' && !ordenSelec && (
                <div style={{ marginBottom: '1rem', position: 'relative' }}>
                  <label style={{ display: 'block', fontSize: '0.72rem', color: '#64748b', marginBottom: '0.375rem', fontWeight: 600 }}>Orden</label>
                  <div style={{ position: 'relative' }}>
                    <Search size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
                    <input value={ordenQ} onChange={e => { setOrdenQ(e.target.value); buscarOrdenes(e.target.value) }} placeholder="Buscar orden..." style={{ ...inputS, paddingLeft: '2.25rem' }} />
                  </div>
                  {ordenes.length > 0 && (
                    <div style={{ position: 'absolute', zIndex: 50, left: 0, right: 0, marginTop: '0.25rem', background: '#0d1a30', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '0.625rem', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
                      {ordenes.map(o => (
                        <button key={o.id} onClick={() => { setOrdenSelec(o); setOrdenes([]); prefillOrden(o.id) }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '0.625rem 0.875rem', background: 'none', border: 'none', cursor: 'pointer', color: '#e2e8f0', fontSize: '0.85rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }} onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                          <strong>{o.titulo}</strong>
                          {o.customer_name && <span style={{ color: '#64748b', marginLeft: '0.5rem', fontSize: '0.75rem' }}>{o.customer_name}</span>}
                          {o.total_cost && <span style={{ color: '#22c55e', marginLeft: '0.5rem', fontSize: '0.75rem' }}>{fmt(o.total_cost)}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {origen === 'orden' && ordenSelec && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.875rem', borderRadius: '0.625rem', marginBottom: '1rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)' }}>
                  <span style={{ color: '#c7d2fe', fontWeight: 600, fontSize: '0.85rem' }}>🔧 {ordenSelec.titulo}{ordenSelec.customer_name && ` — ${ordenSelec.customer_name}`}</span>
                  <button onClick={() => { setOrdenSelec(null); setItems([newItem()]) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}><X size={14} /></button>
                </div>
              )}

              {/* Items */}
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <label style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600 }}>ÍTEMS</label>
                  <button onClick={addItem} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '0.375rem', padding: '0.25rem 0.625rem', color: '#818cf8', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}>
                    <Plus size={11} /> Agregar
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {items.map(item => (
                    <div key={item.id}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 90px 32px', gap: '0.5rem', alignItems: 'center', position: 'relative' }}>
                        <div style={{ position: 'relative' }}>
                          <input
                            value={prodQ[item.id] !== undefined ? prodQ[item.id] : item.nombre}
                            onChange={e => { updateItem(item.id, 'nombre', e.target.value); buscarProducto(item.id, e.target.value) }}
                            placeholder="Buscar producto o escribir concepto..."
                            style={inputS}
                          />
                          {(prodResults[item.id]?.length ?? 0) > 0 && (
                            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, background: '#0d1a30', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '0.5rem', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.4)', marginTop: '0.2rem' }}>
                              {prodResults[item.id].map((p: any) => (
                                <button key={p.id} type="button" onClick={() => seleccionarProducto(item.id, p)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '0.5rem 0.75rem', background: 'none', border: 'none', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.05)', textAlign: 'left' }} onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                                  <span style={{ color: '#e2e8f0', fontSize: '0.83rem' }}>{p.name}</span>
                                  <span style={{ flexShrink: 0, textAlign: 'right', marginLeft: '0.5rem' }}>
                                    {isClienteMayorista && p.precio_mayorista != null ? (
                                      <span style={{ color: '#a5b4fc', fontSize: '0.78rem', fontWeight: 700 }}>
                                        ${(p.precio_mayorista).toLocaleString('es-AR')} <span style={{ color: '#475569', fontWeight: 400, fontSize: '0.68rem' }}>may.</span>
                                      </span>
                                    ) : (
                                      <span style={{ color: '#22c55e', fontSize: '0.78rem', fontWeight: 600 }}>
                                        ${(p.sale_price || 0).toLocaleString('es-AR')}
                                      </span>
                                    )}
                                    <span style={{ color: '#334155', fontSize: '0.68rem', marginLeft: '0.25rem' }}> · {p.stock_quantity}</span>
                                    {isClienteMayorista && p.precio_mayorista == null && (
                                      <span style={{ color: '#f59e0b', fontSize: '0.65rem', display: 'block' }}>sin precio may.</span>
                                    )}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <input type="number" min={1} value={item.cantidad} onChange={e => updateItem(item.id, 'cantidad', +e.target.value || 1)} style={{ ...inputS, textAlign: 'center' }} />
                        <input type="number" min={0} value={item.precio || ''} onChange={e => updateItem(item.id, 'precio', +e.target.value || 0)} placeholder="Precio" style={{ ...inputS, textAlign: 'right' }} />
                        <button onClick={() => items.length > 1 && removeItem(item.id)} disabled={items.length === 1} style={{ background: 'none', border: 'none', cursor: items.length > 1 ? 'pointer' : 'default', color: items.length > 1 ? '#ef4444' : '#334155', padding: '0.25rem' }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 90px 32px', gap: '0.5rem', marginTop: '0.25rem' }}>
                  <span style={{ fontSize: '0.65rem', color: '#334155' }}>Descripción</span>
                  <span style={{ fontSize: '0.65rem', color: '#334155', textAlign: 'center' }}>Cant.</span>
                  <span style={{ fontSize: '0.65rem', color: '#334155', textAlign: 'right' }}>Precio unit.</span>
                  <span />
                </div>
              </div>

              {/* Total */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', padding: '0.875rem 1rem', borderRadius: '0.75rem', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', marginBottom: '1rem' }}>
                <span style={{ fontSize: '0.8rem', color: '#64748b', marginRight: '0.75rem' }}>TOTAL</span>
                <span style={{ fontSize: '1.5rem', fontWeight: 800, color: '#22c55e' }}>{fmt(subtotal)}</span>
              </div>

              {error && <p style={{ color: '#ef4444', fontSize: '0.8rem', margin: '0 0 0.75rem' }}>{error}</p>}
              <button onClick={irAPago} disabled={!itemsValidos} style={{ width: '100%', padding: '0.875rem', borderRadius: '0.75rem', background: itemsValidos ? 'linear-gradient(135deg, #22c55e, #16a34a)' : 'rgba(255,255,255,0.06)', border: 'none', color: itemsValidos ? 'white' : '#334155', fontWeight: 700, fontSize: '0.9375rem', cursor: itemsValidos ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                Continuar al pago <ChevronRight size={18} />
              </button>
            </div>
          )}

          {/* ── STEP: PAGO ── */}
          {step === 'pago' && (
            <div style={{ padding: '1.25rem 1.5rem' }}>
              {/* Resumen */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', borderRadius: '0.75rem', marginBottom: '1.25rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <span style={{ fontSize: '0.8rem', color: '#64748b' }}>{clienteSelec ? clienteSelec.name : 'Sin cliente'} · {items.length} ítem{items.length > 1 ? 's' : ''}</span>
                <span style={{ fontSize: '1.2rem', fontWeight: 800, color: '#22c55e' }}>{fmt(subtotal)}</span>
              </div>

              {/* Selector de métodos por grupo */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.25rem' }}>
                {METODO_GROUPS.map(group => (
                  <div key={group.label}>
                    <div style={{ fontSize: '0.68rem', color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
                      {group.label}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${group.methods.length}, 1fr)`, gap: '0.5rem' }}>
                      {group.methods.map(m => {
                        const active = !mixto && pagos[0]?.metodo === m.id
                        const key = COMMISSION_KEYS[m.id]
                        const rate = key ? rates[key] : 0
                        return (
                          <button key={m.id} onClick={() => { setMixto(false); selectMetodo(m.id) }} style={{ padding: '0.75rem 0.5rem', borderRadius: '0.625rem', border: `2px solid ${active ? m.color : 'rgba(255,255,255,0.07)'}`, background: active ? `${m.color}18` : 'rgba(255,255,255,0.03)', cursor: 'pointer', transition: 'all 0.15s', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
                            <span style={{ fontSize: '1.25rem' }}>{m.emoji}</span>
                            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: active ? m.color : '#64748b', lineHeight: 1.2, textAlign: 'center' }}>{m.label}</span>
                            {rate > 0 && (
                              <span style={{ fontSize: '0.65rem', color: active ? m.color : '#475569', fontWeight: 600 }}>+{(rate * 100).toFixed(2).replace(/\.?0+$/, '')}%</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* Breakdown de comisión (solo si método tiene comisión) */}
              {hasCommission && !mixto && (
                <div style={{ marginBottom: '1rem', padding: '1rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.75rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <span style={{ fontSize: '0.82rem', color: '#64748b' }}>Subtotal</span>
                    <span style={{ fontSize: '0.82rem', color: '#94a3b8' }}>{fmt(subtotal)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.625rem' }}>
                    <span style={{ fontSize: '0.82rem', color: '#64748b' }}>
                      Recargo ({(commissionRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)
                    </span>
                    <span style={{ fontSize: '0.82rem', color: '#f59e0b' }}>+{fmt(comisionMonto)}</span>
                  </div>
                  <div style={{ height: '1px', background: 'rgba(255,255,255,0.08)', marginBottom: '0.625rem' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f1f5f9' }}>Total a cobrar</span>
                    <span style={{ fontSize: '1.25rem', fontWeight: 800, color: '#22c55e' }}>{fmt(totalCobrado)}</span>
                  </div>
                </div>
              )}

              {/* Monto manual (solo para efectivo/transferencia sin comisión) */}
              {!hasCommission && !mixto && (
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.72rem', color: '#64748b', marginBottom: '0.375rem', fontWeight: 600 }}>MONTO A COBRAR</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                    <div>
                      <input type="number" value={pagos[0]?.montoARS || ''} onChange={e => updatePago(0, 'montoARS', +e.target.value || 0)} placeholder="$ ARS" style={{ ...inputS, fontSize: '1.1rem', fontWeight: 700, textAlign: 'right' }} />
                      <span style={{ fontSize: '0.65rem', color: '#475569' }}>Pesos argentinos</span>
                    </div>
                    <div>
                      <input type="number" value={pagos[0]?.montoUSD || ''} onChange={e => { updatePago(0, 'montoUSD', +e.target.value || 0); updatePago(0, 'usaUSD', true) }} placeholder="USD" style={{ ...inputS, fontSize: '1.1rem', fontWeight: 700, textAlign: 'right' }} />
                      <span style={{ fontSize: '0.65rem', color: '#475569' }}>Dólares {dolar > 0 ? `(= ${fmt((pagos[0]?.montoUSD || 0) * dolar)})` : ''}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Pago mixto */}
              {mixto && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', marginBottom: '1rem' }}>
                  {pagos.map((pago, idx) => (
                    <div key={idx} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr 28px', gap: '0.5rem', alignItems: 'center', background: 'rgba(255,255,255,0.03)', padding: '0.625rem', borderRadius: '0.625rem', border: '1px solid rgba(255,255,255,0.08)' }}>
                      <select value={pago.metodo} onChange={e => updatePago(idx, 'metodo', e.target.value)} style={{ ...inputS, fontSize: '0.78rem' }}>
                        <option value="efectivo">Efectivo</option>
                        <option value="transferencia">Transferencia</option>
                      </select>
                      <input type="number" placeholder="$ ARS" value={pago.montoARS || ''} onChange={e => updatePago(idx, 'montoARS', +e.target.value || 0)} style={{ ...inputS, textAlign: 'right' }} />
                      <div style={{ position: 'relative' }}>
                        <input type="number" placeholder="USD" value={pago.montoUSD || ''} onChange={e => { updatePago(idx, 'montoUSD', +e.target.value || 0); updatePago(idx, 'usaUSD', true) }} style={{ ...inputS, textAlign: 'right', paddingRight: '2rem' }} />
                        <span style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', fontSize: '0.65rem', color: '#475569' }}>USD</span>
                      </div>
                      <button onClick={() => pagos.length > 1 && removePago(idx)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}><X size={13} /></button>
                    </div>
                  ))}
                  <button onClick={addPago} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem', padding: '0.5rem', borderRadius: '0.5rem', background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.12)', color: '#475569', fontSize: '0.78rem', cursor: 'pointer' }}>
                    <Plus size={13} /> Agregar método
                  </button>
                </div>
              )}

              {/* Toggle mixto (solo para sin-comisión) */}
              {!hasCommission && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
                  <button onClick={() => { setMixto(!mixto); if (!mixto) { setPagos([newPago(), newPago('transferencia')]) } else { setPagos([{ ...newPago(), montoARS: subtotal }]) } }} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', background: mixto ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.05)', border: `1px solid ${mixto ? 'rgba(99,102,241,0.4)' : 'rgba(255,255,255,0.1)'}`, borderRadius: '0.5rem', padding: '0.25rem 0.625rem', color: mixto ? '#818cf8' : '#64748b', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}>
                    Pago mixto {mixto ? '✓' : ''}
                  </button>
                </div>
              )}

              {/* Balance (solo para métodos sin comisión) */}
              {!hasCommission && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', borderRadius: '0.625rem', marginBottom: '1rem', background: Math.abs(diferencia) < 1 ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)', border: `1px solid ${Math.abs(diferencia) < 1 ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}` }}>
                  <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                    {Math.abs(diferencia) < 1 ? '✓ Monto exacto' : diferencia > 0 ? `Falta ${fmt(diferencia)}` : `Vuelto ${fmt(Math.abs(diferencia))}`}
                  </span>
                  <span style={{ fontWeight: 700, color: Math.abs(diferencia) < 1 ? '#22c55e' : '#f59e0b', fontSize: '1rem' }}>{fmt(totalPagadoARS)} / {fmt(subtotal)}</span>
                </div>
              )}

              {error && <p style={{ color: '#ef4444', fontSize: '0.8rem', margin: '0 0 0.75rem' }}>{error}</p>}

              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button onClick={() => setStep('items')} style={{ padding: '0.75rem 1rem', borderRadius: '0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.85rem' }}>
                  <ChevronLeft size={16} /> Volver
                </button>
                <button onClick={cobrar} disabled={loading || (!hasCommission && !pagoValido)} style={{ flex: 1, padding: '0.875rem', borderRadius: '0.75rem', background: (hasCommission || pagoValido) ? 'linear-gradient(135deg, #22c55e, #16a34a)' : 'rgba(255,255,255,0.06)', border: 'none', color: (hasCommission || pagoValido) ? 'white' : '#334155', fontWeight: 700, fontSize: '1rem', cursor: (hasCommission || pagoValido) && !loading ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                  {loading ? 'Registrando...' : <>💰 COBRAR {fmt(totalCobrado)}</>}
                </button>
              </div>
            </div>
          )}

          {/* ── STEP: ÉXITO ── */}
          {step === 'exito' && (
            <div style={{ padding: '2rem 1.5rem', textAlign: 'center' }}>
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(34,197,94,0.15)', border: '2px solid #22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1rem' }}>
                <Check size={28} color="#22c55e" />
              </div>
              <h3 style={{ color: '#22c55e', fontWeight: 800, fontSize: '1.25rem', margin: '0 0 0.25rem' }}>¡Cobro registrado!</h3>
              <p style={{ color: '#64748b', fontSize: '0.875rem', margin: '0 0 0.375rem' }}>
                {fmt(totalCobrado)} · {clienteSelec?.name ?? 'Sin cliente'}
              </p>
              {hasCommission && (
                <p style={{ color: '#475569', fontSize: '0.78rem', margin: '0 0 1.75rem' }}>
                  Incluye recargo {METODO_MAP[activeMetodo]?.label} ({(commissionRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)
                </p>
              )}
              {!hasCommission && <div style={{ marginBottom: '1.75rem' }} />}

              <div style={{ marginBottom: '1.5rem' }}>
                <p style={{ color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600, marginBottom: '0.75rem', textTransform: 'uppercase' }}>¿Querés emitir comprobante?</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <button onClick={abrirComprobante} style={postCobroBtn('#6366f1')}>
                    🧾 Sí, emitir comprobante
                  </button>
                  <button onClick={onClose} style={postCobroBtn('#334155')}>
                    — No emitir comprobante
                  </button>
                </div>
              </div>

              <button onClick={onClose} style={{ width: '100%', padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>
                Cerrar
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Modal Comprobante (interno) ── */}
      <ModalCrearComprobante
        isOpen={comprobanteOpen}
        onClose={() => setComprobanteOpen(false)}
        onCreado={() => { setComprobanteOpen(false); onClose() }}
        initialItems={comprobanteItems}
        initialClienteId={clienteSelec?.id}
      />
    </>
  )
}

// ─── Estilos ──────────────────────────────────────────────────────────────────

const inputS: React.CSSProperties = {
  width: '100%',
  padding: '0.5rem 0.625rem',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '0.5rem',
  color: '#f0f4ff',
  fontSize: '0.875rem',
  outline: 'none',
  boxSizing: 'border-box',
}

const postCobroBtn = (color: string): React.CSSProperties => ({
  padding: '0.75rem 1rem',
  borderRadius: '0.75rem',
  background: color === '#334155' ? 'rgba(255,255,255,0.04)' : `${color}18`,
  border: `1px solid ${color === '#334155' ? 'rgba(255,255,255,0.08)' : `${color}40`}`,
  color: color === '#334155' ? '#475569' : '#c7d2fe',
  fontWeight: 600,
  fontSize: '0.875rem',
  cursor: 'pointer',
  width: '100%',
})
