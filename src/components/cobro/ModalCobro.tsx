/**
 * ModalCobro — Cobro rápido centralizado
 * Flujo: Cliente → Items → Pago → Post-cobro
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Plus, Trash2, ChevronRight, ChevronLeft, Check, Search, Zap } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'

// ─── Tipos ───────────────────────────────────────────────────────────────────

type Origen = 'orden' | 'venta_rapida' | 'personalizado'
type MetodoPago = 'efectivo' | 'transferencia' | 'mercadopago' | 'tarjeta'
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
  orderId?: string       // pre-fill desde una orden
  clienteId?: string     // pre-fill cliente
}

// ─── Constantes ──────────────────────────────────────────────────────────────

const METODOS: { id: MetodoPago; label: string; emoji: string; color: string }[] = [
  { id: 'efectivo',      label: 'Efectivo',      emoji: '💵', color: '#22c55e' },
  { id: 'transferencia', label: 'Transferencia',  emoji: '🏦', color: '#3b82f6' },
  { id: 'mercadopago',   label: 'Mercado Pago',   emoji: '💳', color: '#009ee3' },
  { id: 'tarjeta',       label: 'Tarjeta',        emoji: '💳', color: '#8b5cf6' },
]

const newItem = (): CobroItem => ({
  id: crypto.randomUUID(),
  nombre: '',
  cantidad: 1,
  precio: 0,
})

const newPago = (metodo: MetodoPago = 'efectivo'): PagoEntry => ({
  metodo,
  montoARS: 0,
  montoUSD: 0,
  usaUSD: false,
})

const fmt = (n: number) =>
  '$' + Math.round(n).toLocaleString('es-AR')

// ─── Componente ──────────────────────────────────────────────────────────────

export function ModalCobro({ isOpen, onClose, orderId, clienteId }: ModalCobroProps) {
  const { businessId } = useAuth()

  // ── State principal ──
  const [step, setStep]         = useState<Step>('items')
  const [origen, setOrigen]     = useState<Origen>(orderId ? 'orden' : 'venta_rapida')
  const [items, setItems]       = useState<CobroItem[]>([newItem()])
  const [pagos, setPagos]       = useState<PagoEntry[]>([newPago('efectivo')])
  const [mixto, setMixto]       = useState(false)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  // ── Cliente ──
  const [clienteQ, setClienteQ]           = useState('')
  const [clientes, setClientes]           = useState<ClienteResult[]>([])
  const [clienteSelec, setClienteSelec]   = useState<ClienteResult | null>(null)
  const [buscandoCli, setBuscandoCli]     = useState(false)
  const clienteTimer = useRef<ReturnType<typeof setTimeout>>()

  // ── Orden ──
  const [ordenQ, setOrdenQ]         = useState('')
  const [ordenes, setOrdenes]       = useState<OrdenResult[]>([])
  const [ordenSelec, setOrdenSelec] = useState<OrdenResult | null>(null)
  const [buscandoOrden, setBuscandoOrden] = useState(false)
  const ordenTimer = useRef<ReturnType<typeof setTimeout>>()

  // ── Tipo de cambio ──
  const [dolar, setDolar] = useState<number>(0)

  // ── Resultado cobro ──
  const [cobroId, setCobroId] = useState<string | null>(null)

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
    setCobroId(null)
    // cargar tipo de cambio
    loadDolar()
    // pre-fill si viene con orderId / clienteId
    if (orderId) prefillOrden(orderId)
    if (clienteId) prefillCliente(clienteId)
  }, [isOpen]) // eslint-disable-line

  // ── Cargar tipo de cambio ──
  const loadDolar = async () => {
    if (!businessId) return
    const { data } = await supabase
      .from('exchange_rates')
      .select('rate_ars_per_usd')
      .eq('business_id', businessId)
      .eq('currency', 'USD')
      .order('effective_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (data?.rate_ars_per_usd) setDolar(data.rate_ars_per_usd)
  }

  // ── Pre-fill desde orden ──
  const prefillOrden = async (id: string) => {
    const { data } = await supabase
      .from('orders')
      .select('id, device_id, customer_id, total_cost, amount_paid, customers(name, phone, email), order_parts(name, quantity, sale_price, status)')
      .eq('id', id)
      .single()
    if (!data) return

    const saldo = (data.total_cost || 0) - (data.amount_paid || 0)
    const orden: OrdenResult = {
      id: data.id,
      titulo: `Orden #${data.id.slice(0, 6).toUpperCase()}`,
      total_cost: data.total_cost,
      amount_paid: data.amount_paid,
      customer_name: (data.customers as any)?.name ?? null,
      customer_id: data.customer_id,
    }
    setOrdenSelec(orden)

    if (data.customers) {
      setClienteSelec({
        id: data.customer_id,
        name: (data.customers as any).name,
        phone: (data.customers as any).phone,
        email: (data.customers as any).email,
      })
    }

    // Armar items desde order_parts usados
    const parts = ((data.order_parts as any[]) || []).filter(p => p.status === 'used' || p.status === 'sold')
    if (parts.length > 0) {
      setItems(parts.map(p => ({
        id: crypto.randomUUID(),
        nombre: p.name || 'Repuesto',
        cantidad: p.quantity || 1,
        precio: p.sale_price || 0,
      })))
    } else if (saldo > 0) {
      setItems([{ id: crypto.randomUUID(), nombre: 'Servicio técnico', cantidad: 1, precio: saldo }])
    }
  }

  // ── Pre-fill cliente ──
  const prefillCliente = async (id: string) => {
    const { data } = await supabase.from('customers').select('id, name, phone, email').eq('id', id).single()
    if (data) setClienteSelec(data)
  }

  // ── Buscar clientes con debounce ──
  const buscarClientes = useCallback((q: string) => {
    clearTimeout(clienteTimer.current)
    if (!q.trim() || !businessId) { setClientes([]); return }
    clienteTimer.current = setTimeout(async () => {
      setBuscandoCli(true)
      const { data } = await supabase
        .from('customers')
        .select('id, name, phone, email')
        .eq('business_id', businessId)
        .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
        .limit(5)
      setClientes(data || [])
      setBuscandoCli(false)
    }, 250)
  }, [businessId])

  // ── Buscar órdenes ──
  const buscarOrdenes = useCallback((q: string) => {
    clearTimeout(ordenTimer.current)
    if (!q.trim() || !businessId) { setOrdenes([]); return }
    ordenTimer.current = setTimeout(async () => {
      setBuscandoOrden(true)
      const { data } = await supabase
        .from('orders')
        .select('id, total_cost, amount_paid, customers(name)')
        .eq('business_id', businessId)
        .not('status', 'in', '("completed","cancelled")')
        .limit(5)
      setOrdenes(
        (data || []).map(o => ({
          id: o.id,
          titulo: `Orden #${o.id.slice(0, 6).toUpperCase()}`,
          total_cost: o.total_cost,
          amount_paid: o.amount_paid,
          customer_name: (o.customers as any)?.name ?? null,
          customer_id: null,
        }))
      )
      setBuscandoOrden(false)
    }, 250)
  }, [businessId])

  // ── Totales ──
  const subtotal = items.reduce((s, i) => s + i.cantidad * i.precio, 0)

  const totalPagadoARS = pagos.reduce((s, p) => {
    const usdEnArs = p.usaUSD && dolar > 0 ? p.montoUSD * dolar : 0
    return s + p.montoARS + usdEnArs
  }, 0)

  const diferencia = subtotal - totalPagadoARS

  // ── Item helpers ──
  const addItem = () => setItems(prev => [...prev, newItem()])
  const removeItem = (id: string) => setItems(prev => prev.filter(i => i.id !== id))
  const updateItem = (id: string, field: keyof CobroItem, value: string | number) =>
    setItems(prev => prev.map(i => i.id === id ? { ...i, [field]: value } : i))

  // ── Pago helpers ──
  const addPago = () => setPagos(prev => [...prev, newPago()])
  const removePago = (idx: number) => setPagos(prev => prev.filter((_, i) => i !== idx))
  const updatePago = (idx: number, field: keyof PagoEntry, value: any) =>
    setPagos(prev => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p))

  // ── Distribuir total automáticamente al seleccionar método ──
  const selectMetodo = (metodo: MetodoPago) => {
    if (mixto) return
    setPagos([{ ...newPago(metodo), montoARS: subtotal }])
  }

  // ── Validación step items ──
  const itemsValidos = items.length > 0 && items.every(i => i.nombre.trim() && i.precio > 0)

  // ── Validación step pago ──
  const pagoValido = Math.abs(diferencia) < 1

  // ── Siguiente paso ──
  const irAPago = () => {
    if (!itemsValidos) { setError('Completá todos los ítems con nombre y precio.'); return }
    setError(null)
    // Inicializar monto del pago con el subtotal
    if (!mixto) setPagos([{ ...pagos[0], montoARS: subtotal }])
    setStep('pago')
  }

  // ── COBRAR ──
  const cobrar = async () => {
    if (!pagoValido) { setError(`Diferencia: ${fmt(Math.abs(diferencia))}. Revisá los montos.`); return }
    if (!businessId) return
    setLoading(true)
    setError(null)

    try {
      const description = items.map(i => `${i.cantidad}x ${i.nombre}`).join(', ')
      const metodoPrincipal = pagos[0]?.metodo ?? 'efectivo'

      if (origen === 'orden' && ordenSelec?.id) {
        // ── Cobro de orden existente ──────────────────────────────────────────
        for (const pago of pagos) {
          const monto = pago.montoARS + (pago.usaUSD && dolar > 0 ? pago.montoUSD * dolar : 0)
          if (monto <= 0) continue
          await supabase.from('order_payments').insert({
            order_id:       ordenSelec.id,
            business_id:    businessId,
            amount:         monto,
            payment_method: pago.metodo,
            notes:          description,
            payment_date:   new Date().toISOString().split('T')[0],
          })
        }
        setCobroId(ordenSelec.id)
      } else {
        // ── Cobro rápido / personalizado → business_finance_entries ──────────
        for (const pago of pagos) {
          const monto = pago.montoARS + (pago.usaUSD && dolar > 0 ? pago.montoUSD * dolar : 0)
          if (monto <= 0) continue
          const { data } = await supabase.from('business_finance_entries').insert({
            business_id:  businessId,
            date:         new Date().toISOString().split('T')[0],
            type:         'income',
            category:     origen === 'venta_rapida' ? 'venta' : 'servicio',
            description:  description,
            amount_ars:   monto,
            payment_method: pago.metodo,
            customer_id:  clienteSelec?.id ?? null,
          }).select('id').single()
          if (data?.id) setCobroId(data.id)
        }

        // Guardar en financial_movements también (caja)
        const totalARS = pagos.reduce((s, p) => {
          return s + p.montoARS + (p.usaUSD && dolar > 0 ? p.montoUSD * dolar : 0)
        }, 0)
        await supabase.from('financial_movements').insert({
          business_id:   businessId,
          date:          new Date().toISOString().split('T')[0],
          type:          'income',
          category:      'cobro',
          description:   description,
          amount:        totalARS,
          payment_method: metodoPrincipal,
          customer_id:   clienteSelec?.id ?? null,
        }).then(() => {}) // fire and forget, trigger handles rest
      }

      setStep('exito')
    } catch (e: any) {
      setError(e?.message ?? 'Error al registrar el cobro')
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  // ─── RENDER ────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          background: '#0d1a30',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '1.25rem',
          width: '100%', maxWidth: '560px',
          maxHeight: '90vh', overflowY: 'auto',
          boxShadow: '0 32px 64px rgba(0,0,0,0.6)',
        }}
      >
        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1.25rem 1.5rem 1rem',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          position: 'sticky', top: 0, background: '#0d1a30', zIndex: 1,
          borderRadius: '1.25rem 1.25rem 0 0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <div style={{
              width: 36, height: 36, borderRadius: '0.625rem',
              background: 'linear-gradient(135deg, #22c55e, #16a34a)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '1.1rem',
            }}>💰</div>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#f0f4ff' }}>
                Cobrar
              </h2>
              <p style={{ margin: 0, fontSize: '0.72rem', color: '#64748b' }}>
                {step === 'items' ? 'Detalle del cobro' : step === 'pago' ? 'Forma de pago' : '¡Cobro registrado!'}
              </p>
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: '0.5rem',
            width: 32, height: 32, cursor: 'pointer', color: '#64748b',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
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
                <button
                  key={o.id}
                  onClick={() => { setOrigen(o.id); setItems([newItem()]) }}
                  style={{
                    flex: 1, padding: '0.5rem 0.375rem', borderRadius: '0.625rem',
                    border: `1px solid ${origen === o.id ? '#22c55e' : 'rgba(255,255,255,0.1)'}`,
                    background: origen === o.id ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.03)',
                    color: origen === o.id ? '#22c55e' : '#64748b',
                    fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>

            {/* Cliente (opcional en venta rápida) */}
            <div style={{ marginBottom: '1rem', position: 'relative' }}>
              <label style={{ display: 'block', fontSize: '0.72rem', color: '#64748b', marginBottom: '0.375rem', fontWeight: 600 }}>
                Cliente {origen === 'venta_rapida' && <span style={{ color: '#334155' }}>(opcional)</span>}
              </label>
              {clienteSelec ? (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0.625rem 0.875rem', borderRadius: '0.625rem',
                  background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)',
                }}>
                  <div>
                    <span style={{ color: '#c7d2fe', fontWeight: 600, fontSize: '0.875rem' }}>{clienteSelec.name}</span>
                    {clienteSelec.phone && <span style={{ color: '#64748b', fontSize: '0.75rem', marginLeft: '0.5rem' }}>{clienteSelec.phone}</span>}
                  </div>
                  <button onClick={() => { setClienteSelec(null); setClienteQ('') }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}>
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <>
                  <div style={{ position: 'relative' }}>
                    <Search size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
                    <input
                      value={clienteQ}
                      onChange={e => { setClienteQ(e.target.value); buscarClientes(e.target.value) }}
                      placeholder="Buscar por nombre o teléfono..."
                      style={{
                        width: '100%', padding: '0.625rem 0.75rem 0.625rem 2.25rem',
                        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '0.625rem', color: '#f0f4ff', fontSize: '0.875rem',
                        outline: 'none', boxSizing: 'border-box',
                      }}
                    />
                  </div>
                  {clientes.length > 0 && (
                    <div style={{
                      position: 'absolute', zIndex: 50, left: 0, right: 0, marginTop: '0.25rem',
                      background: '#0d1a30', border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: '0.625rem', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                    }}>
                      {clientes.map(c => (
                        <button key={c.id} onClick={() => { setClienteSelec(c); setClientes([]); setClienteQ('') }}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left',
                            padding: '0.625rem 0.875rem', background: 'none', border: 'none',
                            cursor: 'pointer', color: '#e2e8f0', fontSize: '0.85rem',
                            borderBottom: '1px solid rgba(255,255,255,0.05)',
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'none'}
                        >
                          <strong>{c.name}</strong>
                          {c.phone && <span style={{ color: '#64748b', marginLeft: '0.5rem', fontSize: '0.75rem' }}>{c.phone}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Selector de orden (solo si origen=orden) */}
            {origen === 'orden' && !ordenSelec && (
              <div style={{ marginBottom: '1rem', position: 'relative' }}>
                <label style={{ display: 'block', fontSize: '0.72rem', color: '#64748b', marginBottom: '0.375rem', fontWeight: 600 }}>Orden</label>
                <div style={{ position: 'relative' }}>
                  <Search size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
                  <input
                    value={ordenQ}
                    onChange={e => { setOrdenQ(e.target.value); buscarOrdenes(e.target.value) }}
                    placeholder="Buscar orden..."
                    style={{
                      width: '100%', padding: '0.625rem 0.75rem 0.625rem 2.25rem',
                      background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '0.625rem', color: '#f0f4ff', fontSize: '0.875rem',
                      outline: 'none', boxSizing: 'border-box',
                    }}
                  />
                </div>
                {ordenes.length > 0 && (
                  <div style={{
                    position: 'absolute', zIndex: 50, left: 0, right: 0, marginTop: '0.25rem',
                    background: '#0d1a30', border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '0.625rem', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                  }}>
                    {ordenes.map(o => (
                      <button key={o.id} onClick={() => { setOrdenSelec(o); setOrdenes([]); prefillOrden(o.id) }}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '0.625rem 0.875rem', background: 'none', border: 'none',
                          cursor: 'pointer', color: '#e2e8f0', fontSize: '0.85rem',
                          borderBottom: '1px solid rgba(255,255,255,0.05)',
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      >
                        <strong>{o.titulo}</strong>
                        {o.customer_name && <span style={{ color: '#64748b', marginLeft: '0.5rem', fontSize: '0.75rem' }}>{o.customer_name}</span>}
                        {o.total_cost && <span style={{ color: '#22c55e', marginLeft: '0.5rem', fontSize: '0.75rem' }}>{fmt(o.total_cost)}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Orden seleccionada badge */}
            {origen === 'orden' && ordenSelec && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0.5rem 0.875rem', borderRadius: '0.625rem', marginBottom: '1rem',
                background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)',
              }}>
                <span style={{ color: '#c7d2fe', fontWeight: 600, fontSize: '0.85rem' }}>
                  🔧 {ordenSelec.titulo}
                  {ordenSelec.customer_name && ` — ${ordenSelec.customer_name}`}
                </span>
                <button onClick={() => { setOrdenSelec(null); setItems([newItem()]) }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}>
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Items */}
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <label style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600 }}>ÍTEMS</label>
                <button onClick={addItem} style={{
                  display: 'flex', alignItems: 'center', gap: '0.25rem',
                  background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.3)',
                  borderRadius: '0.375rem', padding: '0.25rem 0.625rem',
                  color: '#818cf8', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer',
                }}>
                  <Plus size={11} /> Agregar
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {items.map((item, idx) => (
                  <div key={item.id} style={{
                    display: 'grid', gridTemplateColumns: '1fr 60px 90px 32px',
                    gap: '0.5rem', alignItems: 'center',
                  }}>
                    <input
                      value={item.nombre}
                      onChange={e => updateItem(item.id, 'nombre', e.target.value)}
                      placeholder={origen === 'personalizado' ? 'Concepto...' : 'Nombre del item'}
                      style={inputS}
                    />
                    <input
                      type="number" min={1} value={item.cantidad}
                      onChange={e => updateItem(item.id, 'cantidad', +e.target.value || 1)}
                      style={{ ...inputS, textAlign: 'center' }}
                    />
                    <input
                      type="number" min={0} value={item.precio || ''}
                      onChange={e => updateItem(item.id, 'precio', +e.target.value || 0)}
                      placeholder="Precio"
                      style={{ ...inputS, textAlign: 'right' }}
                    />
                    <button onClick={() => items.length > 1 && removeItem(item.id)}
                      disabled={items.length === 1}
                      style={{
                        background: 'none', border: 'none', cursor: items.length > 1 ? 'pointer' : 'default',
                        color: items.length > 1 ? '#ef4444' : '#334155', padding: '0.25rem',
                      }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>

              {/* Header de columnas */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 90px 32px', gap: '0.5rem', marginTop: '0.25rem' }}>
                <span style={{ fontSize: '0.65rem', color: '#334155' }}>Descripción</span>
                <span style={{ fontSize: '0.65rem', color: '#334155', textAlign: 'center' }}>Cant.</span>
                <span style={{ fontSize: '0.65rem', color: '#334155', textAlign: 'right' }}>Precio unit.</span>
                <span />
              </div>
            </div>

            {/* Total */}
            <div style={{
              display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
              padding: '0.875rem 1rem', borderRadius: '0.75rem',
              background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)',
              marginBottom: '1rem',
            }}>
              <span style={{ fontSize: '0.8rem', color: '#64748b', marginRight: '0.75rem' }}>TOTAL</span>
              <span style={{ fontSize: '1.5rem', fontWeight: 800, color: '#22c55e' }}>{fmt(subtotal)}</span>
            </div>

            {error && <p style={{ color: '#ef4444', fontSize: '0.8rem', margin: '0 0 0.75rem' }}>{error}</p>}

            <button
              onClick={irAPago}
              disabled={!itemsValidos}
              style={{
                width: '100%', padding: '0.875rem', borderRadius: '0.75rem',
                background: itemsValidos ? 'linear-gradient(135deg, #22c55e, #16a34a)' : 'rgba(255,255,255,0.06)',
                border: 'none', color: itemsValidos ? 'white' : '#334155',
                fontWeight: 700, fontSize: '0.9375rem', cursor: itemsValidos ? 'pointer' : 'not-allowed',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                transition: 'all 0.15s',
              }}
            >
              Continuar al pago <ChevronRight size={18} />
            </button>
          </div>
        )}

        {/* ── STEP: PAGO ── */}
        {step === 'pago' && (
          <div style={{ padding: '1.25rem 1.5rem' }}>

            {/* Resumen */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '0.75rem 1rem', borderRadius: '0.75rem', marginBottom: '1.25rem',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
            }}>
              <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                {clienteSelec ? clienteSelec.name : 'Sin cliente'} · {items.length} ítem{items.length > 1 ? 's' : ''}
              </span>
              <span style={{ fontSize: '1.2rem', fontWeight: 800, color: '#22c55e' }}>{fmt(subtotal)}</span>
            </div>

            {/* Toggle mixto */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <span style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: 600 }}>FORMA DE PAGO</span>
              <button onClick={() => { setMixto(!mixto); if (!mixto) { setPagos([newPago(), newPago('transferencia')]) } else { setPagos([{ ...newPago(), montoARS: subtotal }]) } }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.375rem',
                  background: mixto ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.05)',
                  border: `1px solid ${mixto ? 'rgba(99,102,241,0.4)' : 'rgba(255,255,255,0.1)'}`,
                  borderRadius: '0.5rem', padding: '0.25rem 0.625rem',
                  color: mixto ? '#818cf8' : '#64748b', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer',
                }}>
                Pago mixto {mixto ? '✓' : ''}
              </button>
            </div>

            {/* Métodos (sin mixto: selector visual) */}
            {!mixto && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem', marginBottom: '1rem' }}>
                {METODOS.map(m => {
                  const active = pagos[0]?.metodo === m.id
                  return (
                    <button key={m.id} onClick={() => selectMetodo(m.id)}
                      style={{
                        padding: '0.875rem 0.75rem', borderRadius: '0.75rem',
                        border: `2px solid ${active ? m.color : 'rgba(255,255,255,0.08)'}`,
                        background: active ? `${m.color}18` : 'rgba(255,255,255,0.03)',
                        cursor: 'pointer', transition: 'all 0.15s',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.375rem',
                      }}>
                      <span style={{ fontSize: '1.5rem' }}>{m.emoji}</span>
                      <span style={{ fontSize: '0.78rem', fontWeight: 600, color: active ? m.color : '#64748b' }}>{m.label}</span>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Mixto: múltiples entradas */}
            {mixto && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', marginBottom: '1rem' }}>
                {pagos.map((pago, idx) => (
                  <div key={idx} style={{
                    display: 'grid', gridTemplateColumns: '120px 1fr 1fr 28px',
                    gap: '0.5rem', alignItems: 'center',
                    background: 'rgba(255,255,255,0.03)', padding: '0.625rem',
                    borderRadius: '0.625rem', border: '1px solid rgba(255,255,255,0.08)',
                  }}>
                    <select value={pago.metodo} onChange={e => updatePago(idx, 'metodo', e.target.value)}
                      style={{ ...inputS, fontSize: '0.78rem' }}>
                      {METODOS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                    <input type="number" placeholder="$ ARS" value={pago.montoARS || ''}
                      onChange={e => updatePago(idx, 'montoARS', +e.target.value || 0)}
                      style={{ ...inputS, textAlign: 'right' }} />
                    <div style={{ position: 'relative' }}>
                      <input type="number" placeholder="USD" value={pago.montoUSD || ''}
                        onChange={e => { updatePago(idx, 'montoUSD', +e.target.value || 0); updatePago(idx, 'usaUSD', true) }}
                        style={{ ...inputS, textAlign: 'right', paddingRight: '2rem' }} />
                      <span style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', fontSize: '0.65rem', color: '#475569' }}>USD</span>
                    </div>
                    <button onClick={() => pagos.length > 1 && removePago(idx)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
                <button onClick={addPago}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem',
                    padding: '0.5rem', borderRadius: '0.5rem',
                    background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.12)',
                    color: '#475569', fontSize: '0.78rem', cursor: 'pointer',
                  }}>
                  <Plus size={13} /> Agregar método
                </button>
              </div>
            )}

            {/* Monto manual si no es mixto */}
            {!mixto && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.72rem', color: '#64748b', marginBottom: '0.375rem', fontWeight: 600 }}>MONTO A COBRAR</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  <div>
                    <input
                      type="number" value={pagos[0]?.montoARS || ''}
                      onChange={e => updatePago(0, 'montoARS', +e.target.value || 0)}
                      placeholder="$ ARS"
                      style={{ ...inputS, fontSize: '1.1rem', fontWeight: 700, textAlign: 'right' }}
                    />
                    <span style={{ fontSize: '0.65rem', color: '#475569' }}>Pesos argentinos</span>
                  </div>
                  <div>
                    <input
                      type="number" value={pagos[0]?.montoUSD || ''}
                      onChange={e => { updatePago(0, 'montoUSD', +e.target.value || 0); updatePago(0, 'usaUSD', true) }}
                      placeholder="USD"
                      style={{ ...inputS, fontSize: '1.1rem', fontWeight: 700, textAlign: 'right' }}
                    />
                    <span style={{ fontSize: '0.65rem', color: '#475569' }}>
                      Dólares {dolar > 0 ? `(= ${fmt((pagos[0]?.montoUSD || 0) * dolar)})` : ''}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Balance */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '0.75rem 1rem', borderRadius: '0.625rem', marginBottom: '1rem',
              background: Math.abs(diferencia) < 1 ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
              border: `1px solid ${Math.abs(diferencia) < 1 ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
            }}>
              <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                {Math.abs(diferencia) < 1 ? '✓ Monto exacto' : diferencia > 0 ? `Falta ${fmt(diferencia)}` : `Vuelto ${fmt(Math.abs(diferencia))}`}
              </span>
              <span style={{ fontWeight: 700, color: Math.abs(diferencia) < 1 ? '#22c55e' : '#f59e0b', fontSize: '1rem' }}>
                {fmt(totalPagadoARS)} / {fmt(subtotal)}
              </span>
            </div>

            {error && <p style={{ color: '#ef4444', fontSize: '0.8rem', margin: '0 0 0.75rem' }}>{error}</p>}

            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button onClick={() => setStep('items')} style={{
                padding: '0.75rem 1rem', borderRadius: '0.75rem',
                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                color: '#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.375rem',
                fontSize: '0.85rem',
              }}>
                <ChevronLeft size={16} /> Volver
              </button>
              <button
                onClick={cobrar}
                disabled={loading || !pagoValido}
                style={{
                  flex: 1, padding: '0.875rem', borderRadius: '0.75rem',
                  background: pagoValido ? 'linear-gradient(135deg, #22c55e, #16a34a)' : 'rgba(255,255,255,0.06)',
                  border: 'none', color: pagoValido ? 'white' : '#334155',
                  fontWeight: 700, fontSize: '1rem', cursor: pagoValido && !loading ? 'pointer' : 'not-allowed',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                  transition: 'all 0.15s',
                }}
              >
                {loading ? 'Registrando...' : <>💰 COBRAR {fmt(subtotal)}</>}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP: ÉXITO ── */}
        {step === 'exito' && (
          <div style={{ padding: '2rem 1.5rem', textAlign: 'center' }}>
            <div style={{
              width: 64, height: 64, borderRadius: '50%',
              background: 'rgba(34,197,94,0.15)', border: '2px solid #22c55e',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 1rem',
            }}>
              <Check size={28} color="#22c55e" />
            </div>
            <h3 style={{ color: '#22c55e', fontWeight: 800, fontSize: '1.25rem', margin: '0 0 0.375rem' }}>
              ¡Cobro registrado!
            </h3>
            <p style={{ color: '#64748b', fontSize: '0.875rem', margin: '0 0 1.75rem' }}>
              {fmt(subtotal)} · {clienteSelec?.name ?? 'Sin cliente'}
            </p>

            {/* Opciones post-cobro */}
            <div style={{ marginBottom: '1.5rem' }}>
              <p style={{ color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600, marginBottom: '0.75rem', textTransform: 'uppercase' }}>
                ¿Querés emitir comprobante?
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <button
                  onClick={() => { onClose(); window.location.href = '/comprobantes?new=1' }}
                  style={postCobroBtn('#6366f1')}
                >
                  🧾 Factura / Ticket (ARCA)
                </button>
                <button
                  onClick={() => { onClose() }}
                  style={postCobroBtn('#334155')}
                >
                  — No emitir comprobante
                </button>
              </div>
            </div>

            <button onClick={onClose} style={{
              width: '100%', padding: '0.75rem', borderRadius: '0.75rem',
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
              color: '#94a3b8', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer',
            }}>
              Cerrar
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Estilos reutilizables ────────────────────────────────────────────────────

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
