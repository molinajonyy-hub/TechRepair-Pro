import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Wallet, TrendingUp, TrendingDown, Plus, Loader2,
  AlertCircle, DollarSign, Lock, Unlock, RefreshCw, Trash2,
  Calendar, ChevronRight, ExternalLink, ArrowUpRight, ArrowDownRight,
  Receipt, FileText, Truck, X,
} from 'lucide-react'
import { CloseButton } from '../components/ui/CloseButton'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { currencyService } from '../services/currencyService'

// ─── Types ────────────────────────────────────────────────────────────────────

type Currency = 'ARS' | 'USD'
type MovementType = 'income' | 'expense'

interface CashRegister {
  id: string
  date: string
  ars_opening: number
  ars_balance: number
  usd_opening: number
  usd_balance: number
  exchange_rate: number
  status: 'open' | 'closed'
  notes?: string
}

interface Movement {
  id: string
  type: MovementType
  currency: Currency
  amount: number
  amount_ars: number
  description?: string
  source: string
  source_id?: string | null
  comprobante_id?: string | null
  created_at: string
}

interface DayDetail {
  caja: CashRegister | null
  movements: Movement[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtARS = (v: number) =>
  `$${(v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtUSD = (v: number) =>
  `USD ${(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
const fmtDateLong = (iso: string) =>
  new Date(iso + 'T12:00:00').toLocaleDateString('es-AR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  })
const fmtDateShort = (iso: string) =>
  new Date(iso + 'T12:00:00').toLocaleDateString('es-AR', {
    weekday: 'short', day: '2-digit', month: 'short',
  })

const SOURCE_INFO: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  comprobante:    { label: 'Comprobante', color: '#818cf8', icon: FileText },
  cobro_rapido:   { label: 'Cobro',       color: '#34d399', icon: FileText },
  expense:        { label: 'Gasto',       color: '#f87171', icon: Receipt  },
  pago_proveedor: { label: 'Proveedor',   color: '#fb923c', icon: Truck    },
  manual:         { label: 'Manual',      color: '#94a3b8', icon: Wallet   },
  payment:        { label: 'Pago',        color: '#60a5fa', icon: DollarSign },
}

function getSourceInfo(source: string) {
  return SOURCE_INFO[source] ?? { label: source || '—', color: '#475569', icon: Wallet }
}

// ─── DayDetailPanel ───────────────────────────────────────────────────────────
// Defined at module level to prevent remount on parent re-renders

interface DayDetailPanelProps {
  date: string
  detail: DayDetail
  loading: boolean
  onClose: () => void
  onNavigate: (mov: Movement) => void
}

function DayDetailPanel({ date, detail, loading, onClose, onNavigate }: DayDetailPanelProps) {
  const { caja, movements } = detail

  const arsIn  = movements.filter(m => m.currency === 'ARS' && m.type === 'income').reduce((s, m) => s + (m.amount || 0), 0)
  const arsOut = movements.filter(m => m.currency === 'ARS' && m.type === 'expense').reduce((s, m) => s + (m.amount || 0), 0)
  const saldoInicial = caja?.ars_opening ?? 0
  const saldoFinal   = caja ? caja.ars_balance : saldoInicial + arsIn - arsOut

  // Running balance: calculado secuencialmente por created_at asc
  let running = saldoInicial
  const withBalance = movements.map(m => {
    const delta = m.currency === 'ARS' ? (m.amount_ars || m.amount || 0) : 0
    if (m.type === 'income')  running += delta
    else                       running -= delta
    return { ...m, runningBalance: running }
  })

  const row: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '44px 1fr auto auto',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.75rem 1.25rem',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    cursor: 'pointer',
    transition: 'background 0.12s',
  }

  return (
    <div style={{
      backgroundColor: '#0d1a30',
      border: '1px solid rgba(99,102,241,0.2)',
      borderRadius: '0.875rem',
      overflow: 'hidden',
      marginTop: '1.25rem',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '1rem 1.25rem',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(99,102,241,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Calendar size={16} style={{ color: '#818cf8' }} />
          <span style={{ fontWeight: 700, color: '#e2e8f0', fontSize: '0.95rem' }}>
            {fmtDateLong(date)}
          </span>
          {caja && (
            <span style={{
              padding: '0.15rem 0.5rem', borderRadius: '0.25rem', fontSize: '0.7rem', fontWeight: 700,
              backgroundColor: caja.status === 'closed' ? 'rgba(248,113,113,0.12)' : 'rgba(52,211,153,0.12)',
              color: caja.status === 'closed' ? '#f87171' : '#34d399',
            }}>
              {caja.status === 'closed' ? 'Cerrada' : 'Abierta'}
            </span>
          )}
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem', display: 'flex', alignItems: 'center' }}>
          <X size={16} />
        </button>
      </div>

      {/* Summary strip */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
      }}>
        {[
          { label: 'Saldo inicial', value: fmtARS(saldoInicial), color: '#94a3b8' },
          { label: 'Ingresos',      value: fmtARS(arsIn),        color: '#34d399' },
          { label: 'Egresos',       value: fmtARS(arsOut),       color: '#f87171' },
          { label: 'Saldo final',   value: fmtARS(saldoFinal),   color: '#818cf8' },
        ].map((s, i) => (
          <div key={i} style={{
            padding: '0.875rem 1.25rem',
            borderRight: i < 3 ? '1px solid rgba(255,255,255,0.05)' : 'none',
            background: i === 3 ? 'rgba(99,102,241,0.05)' : 'transparent',
          }}>
            <div style={{ fontSize: '0.7rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>
              {s.label}
            </div>
            <div style={{ fontSize: '1.05rem', fontWeight: 800, color: s.color, fontFamily: 'monospace', letterSpacing: '-0.02em' }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* Movement list */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '2.5rem' }}>
          <Loader2 size={24} style={{ color: '#6366f1', animation: 'spin 1s linear infinite' }} />
        </div>
      ) : withBalance.length === 0 ? (
        <div style={{ padding: '2.5rem', textAlign: 'center', color: '#475569' }}>
          <Wallet size={28} style={{ margin: '0 auto 0.5rem', opacity: 0.4 }} />
          <p style={{ margin: 0, fontSize: '0.875rem' }}>Sin movimientos en este día</p>
        </div>
      ) : (
        <>
          {/* Column headers */}
          <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr auto auto', gap: '0.75rem', padding: '0.5rem 1.25rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            {['', 'Descripción / Fuente', 'Monto', 'Saldo'].map((h, i) => (
              <div key={i} style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: i >= 2 ? 'right' : 'left' }}>
                {h}
              </div>
            ))}
          </div>

          {withBalance.map((mov) => {
            const src = getSourceInfo(mov.source)
            const SrcIcon = src.icon
            const isNavigable = ['comprobante','cobro_rapido','expense','pago_proveedor'].includes(mov.source)
            const amountARS = mov.currency === 'ARS' ? mov.amount : mov.amount_ars
            return (
              <div
                key={mov.id}
                style={row}
                onClick={() => isNavigable && onNavigate(mov)}
                onMouseEnter={e => { if (isNavigable) e.currentTarget.style.background = 'rgba(255,255,255,0.025)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                {/* Source icon */}
                <div style={{
                  width: 36, height: 36, borderRadius: '0.5rem', flexShrink: 0,
                  backgroundColor: mov.type === 'income' ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)',
                  border: `1px solid ${mov.type === 'income' ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: mov.type === 'income' ? '#34d399' : '#f87171',
                }}>
                  {mov.type === 'income' ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}
                </div>

                {/* Description + meta */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '0.875rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {mov.description || '—'}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.15rem' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.7rem', color: src.color }}>
                      <SrcIcon size={10} />
                      {src.label}
                    </span>
                    <span style={{ fontSize: '0.68rem', color: '#334155' }}>{fmtTime(mov.created_at)}</span>
                    {mov.currency === 'USD' && (
                      <span style={{ fontSize: '0.68rem', padding: '0.1rem 0.35rem', borderRadius: '0.2rem', backgroundColor: 'rgba(96,165,250,0.12)', color: '#60a5fa', fontWeight: 700 }}>
                        USD
                      </span>
                    )}
                    {isNavigable && (
                      <ExternalLink size={11} style={{ color: '#334155', marginLeft: 'auto' }} />
                    )}
                  </div>
                </div>

                {/* Amount */}
                <div style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, fontSize: '0.9rem', color: mov.type === 'income' ? '#34d399' : '#f87171', flexShrink: 0 }}>
                  {mov.type === 'income' ? '+' : '−'}{fmtARS(amountARS || 0)}
                </div>

                {/* Running balance */}
                <div style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: '0.8rem', color: mov.runningBalance >= 0 ? '#94a3b8' : '#f87171', flexShrink: 0, minWidth: 90 }}>
                  {fmtARS(mov.runningBalance)}
                </div>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function CajaPage() {
  const { businessId, user } = useAuth()
  const navigate = useNavigate()

  const [caja, setCaja]           = useState<CashRegister | null>(null)
  const [movements, setMovements] = useState<Movement[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [exchangeRate, setExchangeRate] = useState(1)
  const [historial, setHistorial] = useState<CashRegister[]>([])
  const [showHistorial, setShowHistorial] = useState(false)

  // Modal movimiento manual
  const [showModal, setShowModal] = useState(false)
  const [modalForm, setModalForm] = useState({ type: 'income' as MovementType, currency: 'ARS' as Currency, amount: '', description: '' })
  const [submitting, setSubmitting] = useState(false)
  const [modalError, setModalError] = useState('')

  // Abrir caja form
  const [openForm, setOpenForm]     = useState({ arsOpening: '', usdOpening: '' })
  const [openingCaja, setOpeningCaja] = useState(false)

  // Detalle por día
  const [selectedDay, setSelectedDay]   = useState<string | null>(null)
  const [dayDetail, setDayDetail]       = useState<DayDetail | null>(null)
  const [loadingDay, setLoadingDay]     = useState(false)
  const [datePicker, setDatePicker]     = useState('')

  const today = new Date().toISOString().split('T')[0]

  // ── Loaders ──────────────────────────────────────────────────────────────────

  const loadExchangeRate = useCallback(async () => {
    const rate = await currencyService.getCurrentExchangeRate('USD', 'ARS').catch(() => 1)
    setExchangeRate(rate || 1)
  }, [])

  const loadCaja = useCallback(async () => {
    if (!businessId) return
    setLoading(true); setError(null)
    try {
      const { data: existing } = await supabase
        .from('cash_registers').select('*')
        .eq('business_id', businessId).eq('date', today).maybeSingle()

      if (!existing) { setCaja(null); setMovements([]); return }
      setCaja(existing as CashRegister)

      const { data: movs } = await supabase
        .from('financial_movements').select('*')
        .eq('business_id', businessId).eq('date', today)
        .order('created_at', { ascending: false })
      setMovements((movs || []) as Movement[])

      const arsIn  = (movs || []).filter((m: any) => m.currency === 'ARS' && m.type === 'income').reduce((s: number, m: any) => s + m.amount, 0)
      const arsOut = (movs || []).filter((m: any) => m.currency === 'ARS' && m.type === 'expense').reduce((s: number, m: any) => s + m.amount, 0)
      const usdIn  = (movs || []).filter((m: any) => m.currency === 'USD' && m.type === 'income').reduce((s: number, m: any) => s + m.amount, 0)
      const usdOut = (movs || []).filter((m: any) => m.currency === 'USD' && m.type === 'expense').reduce((s: number, m: any) => s + m.amount, 0)
      const newARS = (existing as CashRegister).ars_opening + arsIn - arsOut
      const newUSD = (existing as CashRegister).usd_opening + usdIn - usdOut

      await supabase.from('cash_registers').update({ ars_balance: newARS, usd_balance: newUSD, updated_at: new Date().toISOString() }).eq('id', existing.id)
      setCaja(prev => prev ? { ...prev, ars_balance: newARS, usd_balance: newUSD } : prev)
    } catch (err: any) { setError(err.message || 'Error al cargar caja') }
    finally { setLoading(false) }
  }, [businessId, today])

  const loadHistorial = useCallback(async () => {
    if (!businessId) return
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const { data } = await supabase
      .from('cash_registers').select('*')
      .eq('business_id', businessId).gte('date', thirtyDaysAgo)
      .neq('date', today).order('date', { ascending: false }).limit(30)
    setHistorial((data || []) as CashRegister[])
  }, [businessId, today])

  const loadDayDetail = useCallback(async (date: string) => {
    if (!businessId) return
    if (selectedDay === date) { setSelectedDay(null); setDayDetail(null); return }
    setSelectedDay(date); setLoadingDay(true); setDayDetail(null)
    try {
      const [{ data: movs }, { data: cr }] = await Promise.all([
        supabase.from('financial_movements').select('*')
          .eq('business_id', businessId).eq('date', date)
          .order('created_at', { ascending: true }),
        supabase.from('cash_registers').select('*')
          .eq('business_id', businessId).eq('date', date).maybeSingle(),
      ])
      setDayDetail({ movements: (movs || []) as Movement[], caja: (cr ?? null) as CashRegister | null })
    } finally { setLoadingDay(false) }
  }, [businessId, selectedDay])

  useEffect(() => { loadExchangeRate().then(() => { loadCaja(); loadHistorial() }) }, [loadExchangeRate, loadCaja, loadHistorial])

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleNavigateToSource = (mov: Movement) => {
    if (['comprobante', 'cobro_rapido'].includes(mov.source) && mov.comprobante_id) {
      navigate(`/comprobantes`)
    } else if (mov.source === 'expense') {
      navigate('/expenses')
    } else if (mov.source === 'pago_proveedor') {
      navigate('/suppliers')
    }
  }

  const handleAddMovement = async (e: React.FormEvent) => {
    e.preventDefault()
    const amount = parseFloat(modalForm.amount)
    if (!amount || amount <= 0) { setModalError('El monto debe ser mayor a 0'); return }
    setSubmitting(true); setModalError('')
    try {
      const amountARS = modalForm.currency === 'USD' ? amount * exchangeRate : amount
      await supabase.from('financial_movements').insert({
        business_id: businessId, type: modalForm.type, currency: modalForm.currency,
        amount, exchange_rate: exchangeRate, amount_ars: amountARS,
        source: 'manual', description: modalForm.description || null, date: today, created_by: user?.id,
      })
      setShowModal(false)
      setModalForm({ type: 'income', currency: 'ARS', amount: '', description: '' })
      await loadCaja()
    } catch (err: any) { setModalError(err.message || 'Error al registrar movimiento') }
    finally { setSubmitting(false) }
  }

  const handleCloseCaja = async () => {
    if (!caja) return
    const arsIn  = movements.filter(m => m.currency === 'ARS' && m.type === 'income').reduce((s, m) => s + m.amount, 0)
    const arsOut = movements.filter(m => m.currency === 'ARS' && m.type === 'expense').reduce((s, m) => s + m.amount, 0)
    const msg = `RESUMEN DEL DÍA\n\nIngresos ARS: ${fmtARS(arsIn)}\nEgresos ARS: ${fmtARS(arsOut)}\nNeto ARS: ${fmtARS(arsIn - arsOut)}\n\nBalance final: ${fmtARS(caja.ars_balance)}\n\n¿Cerrar la caja?`
    if (!confirm(msg)) return
    await supabase.from('cash_registers').update({ status: 'closed', closed_at: new Date().toISOString(), ars_balance: caja.ars_balance, usd_balance: caja.usd_balance }).eq('id', caja.id)
    await loadCaja(); await loadHistorial()
  }

  const handleOpenCaja = async () => {
    if (!businessId) return
    setOpeningCaja(true); setError(null)
    try {
      const { data: created, error: createError } = await supabase.from('cash_registers').insert({
        business_id: businessId, date: today,
        ars_opening: parseFloat(openForm.arsOpening) || 0, ars_balance: parseFloat(openForm.arsOpening) || 0,
        usd_opening: parseFloat(openForm.usdOpening) || 0, usd_balance: parseFloat(openForm.usdOpening) || 0,
        exchange_rate: exchangeRate, status: 'open', created_by: user?.id,
      }).select().single()
      if (createError) throw createError
      setCaja(created as CashRegister)
    } catch (err: any) { setError(err.message || 'Error al abrir la caja') }
    finally { setOpeningCaja(false) }
  }

  const handleDeleteMovement = async (movId: string) => {
    if (!confirm('¿Eliminás este movimiento? El balance se recalculará automáticamente.')) return
    try { await supabase.from('financial_movements').delete().eq('id', movId); await loadCaja() }
    catch (err: any) { alert(err.message || 'Error al eliminar movimiento') }
  }

  const equivalenteARS = (caja?.ars_balance || 0) + (caja?.usd_balance || 0) * exchangeRate

  // ─── Render ──────────────────────────────────────────────────────────────────

  const cardS: React.CSSProperties = { padding: '1.25rem', backgroundColor: '#111827', borderRadius: '0.75rem' }
  const monoVal: React.CSSProperties = { fontSize: '1.75rem', fontWeight: 700, fontFamily: 'monospace', margin: 0, letterSpacing: '-0.02em' }

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1100px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Wallet size={28} style={{ color: '#10b981' }} />
          <div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>Caja Diaria</h1>
            <p style={{ fontSize: '0.875rem', color: '#64748b', margin: 0 }}>
              {new Date().toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button onClick={() => loadCaja()} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', backgroundColor: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: '#94a3b8', cursor: 'pointer', fontSize: '0.875rem' }}>
            <RefreshCw size={15} /> Actualizar
          </button>
          {caja?.status === 'open' && (
            <>
              <button onClick={() => setShowModal(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', backgroundColor: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '0.5rem', color: '#818cf8', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 500 }}>
                <Plus size={16} /> Movimiento
              </button>
              <button onClick={handleCloseCaja} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '0.5rem', color: '#f87171', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 500 }}>
                <Lock size={15} /> Cerrar Caja
              </button>
            </>
          )}
          {caja?.status === 'closed' && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.875rem', fontWeight: 600 }}>
              <Lock size={15} /> Caja Cerrada
            </span>
          )}
        </div>
      </div>

      {error && (
        <div style={{ padding: '0.75rem 1rem', marginBottom: '1rem', backgroundColor: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: '0.5rem', color: '#dc2626', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <Loader2 size={32} style={{ color: '#6366f1', animation: 'spin 1s linear infinite' }} />
        </div>
      ) : !caja ? (
        /* ── Sin caja abierta ── */
        <div style={{ maxWidth: '480px', margin: '4rem auto', textAlign: 'center' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '1rem', backgroundColor: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem' }}>
            <Unlock size={28} style={{ color: '#10b981' }} />
          </div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#f8fafc', marginBottom: '0.5rem' }}>No hay caja abierta hoy</h2>
          <p style={{ color: '#64748b', fontSize: '0.9rem', marginBottom: '2rem' }}>
            Ingresá el saldo inicial y abrí la caja para registrar movimientos del día.
          </p>
          <div style={{ backgroundColor: '#111827', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.75rem', padding: '1.5rem', textAlign: 'left' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.25rem' }}>
              {[
                { label: 'Saldo inicial ARS (opcional)', key: 'arsOpening', color: '#34d399', placeholder: '0.00' },
                { label: 'Saldo inicial USD (opcional)', key: 'usdOpening', color: '#60a5fa', placeholder: '0.00' },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>{f.label}</label>
                  <input type="number" min="0" step="0.01" placeholder={f.placeholder}
                    value={openForm[f.key as 'arsOpening' | 'usdOpening']}
                    onChange={e => setOpenForm(p => ({ ...p, [f.key]: e.target.value }))}
                    style={{ width: '100%', padding: '0.625rem 0.875rem', backgroundColor: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: f.color, fontSize: '1rem', fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' }} />
                </div>
              ))}
            </div>
            <button onClick={handleOpenCaja} disabled={openingCaja} style={{ width: '100%', padding: '0.75rem', backgroundColor: openingCaja ? 'rgba(16,185,129,0.1)' : 'rgba(16,185,129,0.2)', border: '1px solid rgba(16,185,129,0.4)', borderRadius: '0.5rem', color: '#34d399', fontWeight: 700, fontSize: '1rem', cursor: openingCaja ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
              {openingCaja ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> : <Unlock size={18} />}
              {openingCaja ? 'Abriendo...' : 'Abrir Caja'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Balance cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
            <div style={{ ...cardS, border: '1px solid rgba(52,211,153,0.2)', borderLeft: '4px solid #34d399' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <div style={{ width: '2rem', height: '2rem', borderRadius: '0.5rem', backgroundColor: 'rgba(52,211,153,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#34d399' }}>ARS</span>
                </div>
                <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Saldo en Pesos</span>
              </div>
              <p style={{ ...monoVal, color: '#34d399' }}>{fmtARS(caja.ars_balance)}</p>
              <p style={{ fontSize: '0.75rem', color: '#475569', margin: '0.25rem 0 0 0' }}>Apertura: {fmtARS(caja.ars_opening)}</p>
            </div>

            {(() => {
              const neg = caja.usd_balance < 0
              return (
                <div style={{ ...cardS, border: `1px solid ${neg ? 'rgba(248,113,113,0.35)' : 'rgba(96,165,250,0.2)'}`, borderLeft: `4px solid ${neg ? '#f87171' : '#60a5fa'}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                    <div style={{ width: '2rem', height: '2rem', borderRadius: '0.5rem', backgroundColor: neg ? 'rgba(248,113,113,0.15)' : 'rgba(96,165,250,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <DollarSign size={14} style={{ color: neg ? '#f87171' : '#60a5fa' }} />
                    </div>
                    <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Saldo en Dólares</span>
                    {neg && <AlertCircle size={13} style={{ color: '#f87171', marginLeft: 'auto' }} />}
                  </div>
                  <p style={{ ...monoVal, color: neg ? '#f87171' : '#60a5fa' }}>{fmtUSD(caja.usd_balance)}</p>
                  <p style={{ fontSize: '0.75rem', color: neg ? 'rgba(248,113,113,0.6)' : '#475569', margin: '0.25rem 0 0 0' }}>
                    {neg ? '⚠ Saldo negativo' : `Apertura: ${fmtUSD(caja.usd_opening)}`}
                  </p>
                </div>
              )
            })()}

            {(() => {
              const neg = equivalenteARS < 0
              return (
                <div style={{ ...cardS, border: `1px solid ${neg ? 'rgba(248,113,113,0.35)' : 'rgba(99,102,241,0.2)'}`, borderLeft: `4px solid ${neg ? '#f87171' : '#6366f1'}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                    <div style={{ width: '2rem', height: '2rem', borderRadius: '0.5rem', backgroundColor: neg ? 'rgba(248,113,113,0.1)' : 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Wallet size={14} style={{ color: neg ? '#f87171' : '#818cf8' }} />
                    </div>
                    <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Total Equivalente</span>
                  </div>
                  <p style={{ ...monoVal, color: neg ? '#f87171' : '#818cf8' }}>{fmtARS(equivalenteARS)}</p>
                  <p style={{ fontSize: '0.75rem', color: '#475569', margin: '0.25rem 0 0 0' }}>TC: ${exchangeRate.toLocaleString('es-AR')}</p>
                </div>
              )
            })()}
          </div>

          {/* Today's movements */}
          <div style={{ backgroundColor: '#111827', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '0.75rem', overflow: 'hidden' }}>
            <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#e2e8f0', margin: 0 }}>Movimientos de Hoy</h3>
              <span style={{ fontSize: '0.75rem', color: '#475569' }}>{movements.length} registros</span>
            </div>

            {movements.length === 0 ? (
              <div style={{ padding: '3rem', textAlign: 'center', color: '#475569' }}>
                <Wallet size={32} style={{ margin: '0 auto 0.75rem', opacity: 0.4 }} />
                <p style={{ margin: 0 }}>Sin movimientos hoy</p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                  <thead>
                    <tr style={{ backgroundColor: 'rgba(255,255,255,0.02)' }}>
                      {['Tipo', 'Descripción', 'Moneda', 'Monto', 'Fuente', 'Hora', ''].map(h => (
                        <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', color: '#475569', fontWeight: 500, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {movements.map(mov => {
                      const src = getSourceInfo(mov.source)
                      return (
                        <tr key={mov.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                          <td style={{ padding: '0.75rem 1rem' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', padding: '0.2rem 0.5rem', borderRadius: '0.25rem', backgroundColor: mov.type === 'income' ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)', color: mov.type === 'income' ? '#34d399' : '#f87171', fontSize: '0.75rem', fontWeight: 600 }}>
                              {mov.type === 'income' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                              {mov.type === 'income' ? 'Ingreso' : 'Egreso'}
                            </span>
                          </td>
                          <td style={{ padding: '0.75rem 1rem', color: '#cbd5e1' }}>{mov.description || '—'}</td>
                          <td style={{ padding: '0.75rem 1rem' }}>
                            <span style={{ padding: '0.15rem 0.4rem', borderRadius: '0.25rem', backgroundColor: mov.currency === 'USD' ? 'rgba(96,165,250,0.15)' : 'rgba(52,211,153,0.1)', color: mov.currency === 'USD' ? '#60a5fa' : '#34d399', fontSize: '0.7rem', fontWeight: 700 }}>{mov.currency}</span>
                          </td>
                          <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', color: mov.type === 'income' ? '#34d399' : '#f87171', fontWeight: 600 }}>
                            {mov.type === 'income' ? '+' : '-'}{mov.currency === 'USD' ? fmtUSD(mov.amount) : fmtARS(mov.amount)}
                          </td>
                          <td style={{ padding: '0.75rem 1rem', color: src.color, fontSize: '0.75rem', fontWeight: 500 }}>{src.label}</td>
                          <td style={{ padding: '0.75rem 1rem', color: '#475569', fontSize: '0.75rem' }}>{fmtTime(mov.created_at)}</td>
                          <td style={{ padding: '0.75rem 1rem' }}>
                            <button onClick={() => handleDeleteMovement(mov.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.25rem', color: '#475569', display: 'flex', alignItems: 'center' }}
                              title="Eliminar movimiento"
                              onMouseEnter={e => (e.currentTarget.style.color = '#f87171')}
                              onMouseLeave={e => (e.currentTarget.style.color = '#475569')}>
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Ver detalle de cualquier día ── */}
      <div style={{ marginTop: '2rem', backgroundColor: '#111827', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '0.75rem', padding: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: selectedDay ? '0' : undefined }}>
          <Calendar size={16} style={{ color: '#818cf8' }} />
          <span style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '0.875rem' }}>Ver detalle de otro día</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input type="date" value={datePicker} max={today}
              onChange={e => setDatePicker(e.target.value)}
              style={{ padding: '0.4rem 0.625rem', backgroundColor: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.375rem', color: '#e2e8f0', fontSize: '0.8rem', outline: 'none' }} />
            <button
              onClick={() => datePicker && loadDayDetail(datePicker)}
              disabled={!datePicker}
              style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.4rem 0.875rem', backgroundColor: datePicker ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.05)', border: `1px solid ${datePicker ? 'rgba(99,102,241,0.35)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '0.375rem', color: datePicker ? '#818cf8' : '#334155', fontSize: '0.8rem', fontWeight: 600, cursor: datePicker ? 'pointer' : 'not-allowed' }}>
              Ver <ChevronRight size={13} />
            </button>
          </div>
        </div>

        {selectedDay && dayDetail && (
          <DayDetailPanel
            date={selectedDay}
            detail={dayDetail}
            loading={loadingDay}
            onClose={() => { setSelectedDay(null); setDayDetail(null) }}
            onNavigate={handleNavigateToSource}
          />
        )}
        {loadingDay && !dayDetail && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '1.5rem' }}>
            <Loader2 size={22} style={{ color: '#6366f1', animation: 'spin 1s linear infinite' }} />
          </div>
        )}
      </div>

      {/* ── Historial (30 días) ── */}
      {historial.length > 0 && (
        <div style={{ marginTop: '1.25rem', backgroundColor: '#111827', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '0.75rem', overflow: 'hidden' }}>
          <button onClick={() => setShowHistorial(v => !v)} style={{ width: '100%', padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', borderBottom: showHistorial ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#e2e8f0', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Calendar size={16} style={{ color: '#64748b' }} />
              Historial de Cajas
            </h3>
            <span style={{ fontSize: '0.75rem', color: '#475569' }}>
              {showHistorial ? '▲ ocultar' : `▼ ver ${historial.length} registros`}
            </span>
          </button>

          {showHistorial && (
            <>
              <p style={{ margin: 0, padding: '0.5rem 1.25rem', fontSize: '0.75rem', color: '#334155', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                Hacé clic en un día para ver el detalle de movimientos
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                  <thead>
                    <tr style={{ backgroundColor: 'rgba(255,255,255,0.02)' }}>
                      {['Fecha', 'Estado', 'Apertura ARS', 'Balance ARS', 'Apertura USD', 'Balance USD', 'Resultado', ''].map(h => (
                        <th key={h} style={{ padding: '0.625rem 1rem', textAlign: 'left', color: '#475569', fontWeight: 500, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {historial.map(cr => {
                      const resultado = (cr.ars_balance || 0) - (cr.ars_opening || 0)
                      const isSelected = selectedDay === cr.date
                      return (
                        <tr key={cr.id}
                          onClick={() => loadDayDetail(cr.date)}
                          style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer', backgroundColor: isSelected ? 'rgba(99,102,241,0.08)' : 'transparent', transition: 'background 0.12s' }}
                          onMouseEnter={e => { if (!isSelected) e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.025)' }}
                          onMouseLeave={e => { if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent' }}
                        >
                          <td style={{ padding: '0.75rem 1rem', color: isSelected ? '#818cf8' : '#cbd5e1', fontWeight: 600 }}>
                            {fmtDateShort(cr.date)}
                          </td>
                          <td style={{ padding: '0.75rem 1rem' }}>
                            <span style={{ padding: '0.15rem 0.5rem', borderRadius: '0.25rem', fontSize: '0.72rem', fontWeight: 700, backgroundColor: cr.status === 'closed' ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)', color: cr.status === 'closed' ? '#f87171' : '#34d399' }}>
                              {cr.status === 'closed' ? 'Cerrada' : 'Abierta'}
                            </span>
                          </td>
                          <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', color: '#94a3b8' }}>{fmtARS(cr.ars_opening || 0)}</td>
                          <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', color: '#34d399', fontWeight: 600 }}>{fmtARS(cr.ars_balance || 0)}</td>
                          <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', color: '#94a3b8' }}>{fmtUSD(cr.usd_opening || 0)}</td>
                          <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', color: '#60a5fa', fontWeight: 600 }}>{fmtUSD(cr.usd_balance || 0)}</td>
                          <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', fontWeight: 700, color: resultado >= 0 ? '#34d399' : '#f87171' }}>
                            {resultado >= 0 ? '+' : ''}{fmtARS(resultado)}
                          </td>
                          <td style={{ padding: '0.75rem 1rem', color: isSelected ? '#818cf8' : '#334155' }}>
                            <ChevronRight size={14} style={{ transform: isSelected ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }} />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Inline day detail dentro del historial */}
              {selectedDay && historial.some(cr => cr.date === selectedDay) && dayDetail && (
                <div style={{ padding: '0 1.25rem 1.25rem' }}>
                  <DayDetailPanel
                    date={selectedDay}
                    detail={dayDetail}
                    loading={loadingDay}
                    onClose={() => { setSelectedDay(null); setDayDetail(null) }}
                    onNavigate={handleNavigateToSource}
                  />
                </div>
              )}
              {loadingDay && historial.some(cr => cr.date === selectedDay) && !dayDetail && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '1.5rem' }}>
                  <Loader2 size={22} style={{ color: '#6366f1', animation: 'spin 1s linear infinite' }} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Modal movimiento manual ── */}
      {showModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem' }}>
          <div style={{ backgroundColor: '#0f172a', border: '1px solid rgba(51,65,85,0.5)', borderRadius: '0.75rem', width: '100%', maxWidth: '440px', padding: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>Registrar Movimiento</h3>
              <CloseButton onClick={() => setShowModal(false)} />
            </div>

            {modalError && (
              <div style={{ padding: '0.625rem 0.875rem', marginBottom: '1rem', backgroundColor: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: '0.375rem', color: '#f87171', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <AlertCircle size={14} /> {modalError}
              </div>
            )}

            <form onSubmit={handleAddMovement} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Tipo */}
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>Tipo</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {([['income', 'Ingreso', '#34d399'], ['expense', 'Egreso', '#f87171']] as const).map(([val, label, color]) => (
                    <button key={val} type="button" onClick={() => setModalForm(f => ({ ...f, type: val }))}
                      style={{ flex: 1, padding: '0.5rem', borderRadius: '0.375rem', border: `2px solid ${modalForm.type === val ? color : 'rgba(255,255,255,0.08)'}`, backgroundColor: modalForm.type === val ? `${color}22` : 'transparent', color: modalForm.type === val ? color : '#64748b', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Moneda */}
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>Moneda</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {(['ARS', 'USD'] as Currency[]).map(c => (
                    <button key={c} type="button" onClick={() => setModalForm(f => ({ ...f, currency: c }))}
                      style={{ flex: 1, padding: '0.5rem', borderRadius: '0.375rem', border: `2px solid ${modalForm.currency === c ? (c === 'USD' ? '#60a5fa' : '#34d399') : 'rgba(255,255,255,0.08)'}`, backgroundColor: modalForm.currency === c ? (c === 'USD' ? 'rgba(96,165,250,0.15)' : 'rgba(52,211,153,0.1)') : 'transparent', color: modalForm.currency === c ? (c === 'USD' ? '#60a5fa' : '#34d399') : '#64748b', fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer' }}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              {/* Monto */}
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>Monto ({modalForm.currency})</label>
                <input type="number" min="0.01" step="0.01" required value={modalForm.amount}
                  onChange={e => setModalForm(f => ({ ...f, amount: e.target.value }))} placeholder="0.00"
                  style={{ width: '100%', padding: '0.625rem 0.875rem', backgroundColor: 'rgba(15,23,42,0.6)', border: '1px solid rgba(51,65,85,0.5)', borderRadius: '0.375rem', color: '#f8fafc', fontSize: '1rem', fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' }} />
              </div>

              {/* Descripción */}
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>Descripción (opcional)</label>
                <input type="text" value={modalForm.description}
                  onChange={e => setModalForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Ej: Pago de alquiler, cobro cliente..."
                  style={{ width: '100%', padding: '0.625rem 0.875rem', backgroundColor: 'rgba(15,23,42,0.6)', border: '1px solid rgba(51,65,85,0.5)', borderRadius: '0.375rem', color: '#f8fafc', fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' }} />
              </div>

              <button type="submit" disabled={submitting} style={{ padding: '0.75rem', backgroundColor: submitting ? 'rgba(99,102,241,0.1)' : 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)', borderRadius: '0.5rem', color: '#818cf8', fontWeight: 700, fontSize: '1rem', cursor: submitting ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                {submitting ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={18} />}
                {submitting ? 'Guardando...' : 'Registrar'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
