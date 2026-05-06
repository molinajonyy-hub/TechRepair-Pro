import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Wallet, TrendingUp, TrendingDown, Plus, Loader2, AlertCircle,
  Lock, Unlock, RefreshCw, Trash2, Calendar, ChevronRight, ChevronDown,
  ArrowUpRight, ArrowDownRight, DollarSign, CreditCard, Building2,
  Banknote, X, CheckCircle, AlertTriangle, FileText, Receipt, Truck,
} from 'lucide-react'
import { CloseButton } from '../components/ui/CloseButton'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { currencyService } from '../services/currencyService'
import { formatDisplayMessage } from '../utils/formatMessage'

// ─── Types ────────────────────────────────────────────────────────────────────

export type CajaMethod = 'efectivo' | 'transferencia' | 'tarjeta' | 'usd'

interface Caja {
  id: string
  business_id: string
  opened_at: string
  closed_at: string | null
  opened_by: string | null
  closed_by: string | null
  efectivo_inicial: number
  transferencia_inicial: number
  tarjeta_inicial: number
  usd_inicial: number
  usd_cotizacion_apertura: number
  efectivo_cierre: number | null
  transferencia_cierre: number | null
  tarjeta_cierre: number | null
  usd_cierre: number | null
  notas: string | null
  status: 'abierta' | 'cerrada'
  difference: number | null
}

interface CajaMovement {
  id: string
  caja_id: string | null
  type: 'income' | 'expense'
  currency: 'ARS' | 'USD'
  amount: number
  amount_ars: number
  source: string
  source_id: string | null
  comprobante_id: string | null
  description: string | null
  date: string
  created_at: string
  metodo_pago: CajaMethod | null
}

interface MethodTotals {
  inicial: number
  in: number
  out: number
  balance: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const METHODS: CajaMethod[] = ['efectivo', 'transferencia', 'tarjeta', 'usd']

const METHOD_META: Record<CajaMethod, { label: string; color: string; icon: React.ElementType; accent: string }> = {
  efectivo:      { label: 'Efectivo',      color: '#34d399', icon: Banknote,   accent: 'rgba(52,211,153,0.1)'  },
  transferencia: { label: 'Transferencia', color: '#60a5fa', icon: Building2,  accent: 'rgba(96,165,250,0.1)'  },
  tarjeta:       { label: 'Tarjeta',       color: '#a78bfa', icon: CreditCard, accent: 'rgba(167,139,250,0.1)' },
  usd:           { label: 'Dólares',       color: '#fbbf24', icon: DollarSign, accent: 'rgba(251,191,36,0.1)'  },
}

const SOURCE_META: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  comprobante:    { label: 'Comprobante', color: '#818cf8', icon: FileText  },
  cobro_rapido:   { label: 'Cobro',       color: '#34d399', icon: FileText  },
  expense:        { label: 'Gasto',       color: '#f87171', icon: Receipt   },
  pago_proveedor: { label: 'Proveedor',   color: '#fb923c', icon: Truck     },
  manual:         { label: 'Manual',      color: '#94a3b8', icon: Wallet    },
  payment:        { label: 'Pago',        color: '#60a5fa', icon: DollarSign },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

import { fmtTime, fmtDateLong, fmtDateShort } from '../utils/dateUtils'

const fmtARS = (v: number) => `$${Math.round(v).toLocaleString('es-AR')}`
const fmtUSD = (v: number) => `U$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function computeTotals(caja: Caja, movements: CajaMovement[]): Record<CajaMethod, MethodTotals> {
  const result: Record<CajaMethod, MethodTotals> = {
    efectivo:      { inicial: caja.efectivo_inicial,      in: 0, out: 0, balance: caja.efectivo_inicial      },
    transferencia: { inicial: caja.transferencia_inicial, in: 0, out: 0, balance: caja.transferencia_inicial },
    tarjeta:       { inicial: caja.tarjeta_inicial,       in: 0, out: 0, balance: caja.tarjeta_inicial       },
    usd:           { inicial: caja.usd_inicial,           in: 0, out: 0, balance: caja.usd_inicial           },
  }
  for (const m of movements) {
    const method = (m.metodo_pago || 'efectivo') as CajaMethod
    if (!result[method]) continue
    const amount = method === 'usd' ? (m.amount) : (m.amount_ars || m.amount)
    if (m.type === 'income') result[method].in  += amount
    else                     result[method].out += amount
  }
  for (const k of METHODS) {
    result[k].balance = result[k].inicial + result[k].in - result[k].out
  }
  return result
}

function getSourceMeta(source: string) {
  return SOURCE_META[source] ?? { label: source || '—', color: '#475569', icon: Wallet }
}

// ─── MethodCard ───────────────────────────────────────────────────────────────

interface MethodCardProps {
  method: CajaMethod
  totals: MethodTotals
  cotizacion?: number
  isSelected: boolean
  onClick: () => void
}

function MethodCard({ method, totals, cotizacion = 1, isSelected, onClick }: MethodCardProps) {
  const meta = METHOD_META[method]
  const Icon = meta.icon
  const isUsd = method === 'usd'
  const fmt = (v: number) => isUsd ? fmtUSD(v) : fmtARS(v)
  const negBalance = totals.balance < 0

  return (
    <div onClick={onClick} style={{
      padding: '1rem 1.125rem', borderRadius: '0.75rem', cursor: 'pointer',
      background: isSelected ? meta.accent : 'rgba(255,255,255,0.02)',
      border: `1px solid ${isSelected ? meta.color + '44' : 'rgba(255,255,255,0.06)'}`,
      borderLeft: `3px solid ${meta.color}`,
      transition: 'all 0.15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
        <Icon size={14} style={{ color: meta.color, flexShrink: 0 }} />
        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {meta.label}
        </span>
      </div>
      <div style={{ fontSize: '1.375rem', fontWeight: 800, fontFamily: 'monospace', color: negBalance ? '#f87171' : meta.color, letterSpacing: '-0.02em', lineHeight: 1 }}>
        {fmt(totals.balance)}
      </div>
      {isUsd && totals.balance > 0 && (
        <div style={{ fontSize: '0.7rem', color: '#475569', marginTop: '0.2rem', fontFamily: 'monospace' }}>
          ≈ {fmtARS(totals.balance * cotizacion)}
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem', fontSize: '0.7rem' }}>
        <span style={{ color: '#34d399' }}>▲ {fmt(totals.in)}</span>
        <span style={{ color: '#f87171' }}>▼ {fmt(totals.out)}</span>
        <span style={{ color: '#334155', marginLeft: 'auto' }}>ini: {fmt(totals.inicial)}</span>
      </div>
    </div>
  )
}

// ─── HistoryCajaPanel ─────────────────────────────────────────────────────────

interface HistoryCajaPanelProps {
  caja: Caja
  onNavigate: (m: CajaMovement) => void
  businessId: string
}

function HistoryCajaPanel({ caja, onNavigate, businessId }: HistoryCajaPanelProps) {
  const [movs, setMovs]     = useState<CajaMovement[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('financial_movements').select('*')
      .eq('caja_id', caja.id)
      .order('created_at', { ascending: true })
      .then(({ data }) => { setMovs((data || []) as CajaMovement[]); setLoading(false) })
  }, [caja.id])

  const totals = useMemo(() => computeTotals(caja, movs), [caja, movs])
  const arsTotal = METHODS.filter(m => m !== 'usd').reduce((s, m) => s + totals[m].balance, 0)

  return (
    <div style={{ marginTop: '0.75rem', background: 'rgba(0,0,0,0.2)', borderRadius: '0.625rem', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.05)' }}>
      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        {METHODS.map((m, i) => {
          const meta = METHOD_META[m]
          const t = totals[m]
          return (
            <div key={m} style={{ padding: '0.625rem 0.875rem', borderRight: i < 3 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
              <div style={{ fontSize: '0.66rem', color: '#334155', fontWeight: 700, textTransform: 'uppercase', marginBottom: '0.25rem' }}>{meta.label}</div>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, fontFamily: 'monospace', color: t.balance < 0 ? '#f87171' : meta.color }}>
                {m === 'usd' ? fmtUSD(t.balance) : fmtARS(t.balance)}
              </div>
              <div style={{ fontSize: '0.65rem', color: '#334155' }}>
                <span style={{ color: '#34d399' }}>+{m === 'usd' ? fmtUSD(t.in) : fmtARS(t.in)}</span>
                {' / '}
                <span style={{ color: '#f87171' }}>-{m === 'usd' ? fmtUSD(t.out) : fmtARS(t.out)}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Cierre info */}
      {caja.status === 'cerrada' && (caja.efectivo_cierre !== null || caja.transferencia_cierre !== null) && (
        <div style={{ padding: '0.5rem 0.875rem', borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.01)' }}>
          <span style={{ fontSize: '0.7rem', color: '#475569' }}>Contado al cierre: </span>
          {METHODS.filter(m => m !== 'usd').map(m => {
            const cierre = caja[`${m}_cierre` as keyof Caja] as number | null
            if (cierre === null) return null
            const esperado = totals[m].balance
            const diff = cierre - esperado
            return (
              <span key={m} style={{ fontSize: '0.7rem', marginRight: '0.75rem' }}>
                <span style={{ color: METHOD_META[m].color }}>{METHOD_META[m].label}:</span>{' '}
                <span style={{ fontFamily: 'monospace', color: diff === 0 ? '#34d399' : diff > 0 ? '#fbbf24' : '#f87171' }}>
                  {fmtARS(cierre)} {diff !== 0 && `(${diff > 0 ? '+' : ''}${fmtARS(diff)})`}
                </span>
              </span>
            )
          })}
        </div>
      )}

      {/* Movements */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '1.25rem' }}>
          <Loader2 size={20} style={{ color: '#6366f1', animation: 'spin 1s linear infinite' }} />
        </div>
      ) : movs.length === 0 ? (
        <div style={{ padding: '1.25rem', textAlign: 'center', color: '#334155', fontSize: '0.8rem' }}>Sin movimientos registrados</div>
      ) : (
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          {movs.map(mov => {
            const src = getSourceMeta(mov.source)
            const SrcIcon = src.icon
            const methodMeta = METHOD_META[(mov.metodo_pago || 'efectivo') as CajaMethod] || METHOD_META.efectivo
            const isNav = ['comprobante','cobro_rapido','expense','pago_proveedor'].includes(mov.source)
            const amountARS = mov.currency === 'ARS' ? mov.amount : mov.amount_ars
            return (
              <div key={mov.id} onClick={() => isNav && onNavigate(mov)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.5rem 0.875rem', borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: isNav ? 'pointer' : 'default' }}
                onMouseEnter={e => { if (isNav) e.currentTarget.style.background = 'rgba(255,255,255,0.025)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
                <span style={{ fontSize: '0.68rem', color: '#334155', width: 36, flexShrink: 0 }}>{fmtTime(mov.created_at)}</span>
                <SrcIcon size={11} style={{ color: src.color, flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: '0.8rem', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mov.description || '—'}</span>
                <span style={{ fontSize: '0.66rem', padding: '0.1rem 0.35rem', borderRadius: '0.25rem', background: methodMeta.accent, color: methodMeta.color, fontWeight: 700, flexShrink: 0 }}>
                  {methodMeta.label.substring(0,4)}
                </span>
                <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', fontWeight: 700, color: mov.type === 'income' ? '#34d399' : '#f87171', flexShrink: 0 }}>
                  {mov.type === 'income' ? '+' : '−'}{fmtARS(amountARS || 0)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── CajaPage ─────────────────────────────────────────────────────────────────

export function CajaPage() {
  const { businessId, user } = useAuth()
  const navigate = useNavigate()

  const [activeCaja, setActiveCaja]   = useState<Caja | null | undefined>(undefined) // undefined = loading
  const [movements, setMovements]     = useState<CajaMovement[]>([])
  const [historial, setHistorial]     = useState<Caja[]>([])
  const [loading, setLoading]         = useState(true)
  const [exchangeRate, setExchangeRate] = useState(1)
  const [error, setError]             = useState<string | null>(null)
  const [activeMethod, setActiveMethod] = useState<CajaMethod | 'all'>('all')
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null)
  const [showHistorial, setShowHistorial] = useState(false)

  // Opening form
  const [openForm, setOpenForm] = useState<Record<CajaMethod, string>>({
    efectivo: '', transferencia: '', tarjeta: '', usd: '',
  })
  const [opening, setOpening] = useState(false)

  // Add movement modal
  const [showAddMov, setShowAddMov]   = useState(false)
  const [movForm, setMovForm]         = useState({ type: 'income' as 'income' | 'expense', method: 'efectivo' as CajaMethod, amount: '', description: '' })
  const [savingMov, setSavingMov]     = useState(false)
  const [movError, setMovError]       = useState('')

  // Close caja modal
  const [showClose, setShowClose]     = useState(false)
  const [closeForm, setCloseForm]     = useState<Record<CajaMethod, string>>({
    efectivo: '', transferencia: '', tarjeta: '', usd: '',
  })
  const [closingNotes, setClosingNotes] = useState('')
  const [closing, setClosing]         = useState(false)

  // ── Loaders ──────────────────────────────────────────────────────────────────

  const loadExchangeRate = useCallback(async () => {
    const rate = await currencyService.getCurrentExchangeRate('USD', 'ARS').catch(() => 1)
    setExchangeRate(rate || 1)
  }, [])

  const loadCaja = useCallback(async () => {
    if (!businessId) return
    setLoading(true); setError(null)
    try {
      const { data: caja } = await supabase
        .from('cajas').select('*')
        .eq('business_id', businessId).eq('status', 'abierta')
        .order('opened_at', { ascending: false }).limit(1).maybeSingle()
      setActiveCaja((caja as Caja | null) ?? null)

      if (caja) {
        const { data: movs } = await supabase
          .from('financial_movements').select('*')
          .eq('caja_id', caja.id)
          .order('created_at', { ascending: false })
        setMovements((movs || []) as CajaMovement[])
      } else {
        setMovements([])
      }
    } catch (e: any) { setError(e.message || 'Error al cargar caja') }
    finally { setLoading(false) }
  }, [businessId])

  const loadHistorial = useCallback(async () => {
    if (!businessId) return
    const { data } = await supabase
      .from('cajas').select('*')
      .eq('business_id', businessId).eq('status', 'cerrada')
      .order('opened_at', { ascending: false }).limit(20)
    setHistorial((data || []) as Caja[])
  }, [businessId])

  useEffect(() => {
    loadExchangeRate()
    loadCaja()
    loadHistorial()
  }, [loadExchangeRate, loadCaja, loadHistorial])

  // ── Computed ─────────────────────────────────────────────────────────────────

  const totals = useMemo(() =>
    activeCaja ? computeTotals(activeCaja, movements) : null
  , [activeCaja, movements])

  const filteredMovs = useMemo(() =>
    activeMethod === 'all' ? movements : movements.filter(m => (m.metodo_pago || 'efectivo') === activeMethod)
  , [movements, activeMethod])

  const totalARS = totals
    ? fmtARS(METHODS.filter(m => m !== 'usd').reduce((s, m) => s + totals[m].balance, 0))
    : '$0'

  // Expected balances for close modal
  const expectedClose = useMemo(() => {
    if (!totals) return {} as Record<CajaMethod, number>
    return { efectivo: totals.efectivo.balance, transferencia: totals.transferencia.balance, tarjeta: totals.tarjeta.balance, usd: totals.usd.balance }
  }, [totals])

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleOpenCaja = async () => {
    if (!businessId || !user) return
    setOpening(true); setError(null)
    try {
      const { data, error: err } = await supabase.from('cajas').insert({
        business_id: businessId,
        efectivo_inicial:        parseFloat(openForm.efectivo)      || 0,
        transferencia_inicial:   parseFloat(openForm.transferencia) || 0,
        tarjeta_inicial:         parseFloat(openForm.tarjeta)       || 0,
        usd_inicial:             parseFloat(openForm.usd)           || 0,
        usd_cotizacion_apertura: exchangeRate,
        opened_by: user.id,
        status: 'abierta',
      }).select().single()
      if (err) throw err
      setActiveCaja(data as Caja)
      setMovements([])
      setOpenForm({ efectivo: '', transferencia: '', tarjeta: '', usd: '' })
    } catch (e: any) { setError(e.message || 'Error al abrir caja') }
    finally { setOpening(false) }
  }

  const handleAddMovement = async (e: React.FormEvent) => {
    e.preventDefault()
    const amount = parseFloat(movForm.amount)
    if (!amount || amount <= 0) { setMovError('El monto debe ser mayor a 0'); return }
    if (!activeCaja) return
    setSavingMov(true); setMovError('')
    try {
      const isUsd    = movForm.method === 'usd'
      const currency = isUsd ? 'USD' : 'ARS'
      const amountARS = isUsd ? amount * exchangeRate : amount
      await supabase.from('financial_movements').insert({
        business_id: businessId,
        caja_id: activeCaja.id,
        type: movForm.type, currency,
        amount, exchange_rate: isUsd ? exchangeRate : 1,
        amount_ars: amountARS,
        source: 'manual',
        description: movForm.description || null,
        date: new Date().toISOString().split('T')[0],
        created_by: user?.id,
        metodo_pago: movForm.method,
      })
      setShowAddMov(false)
      setMovForm({ type: 'income', method: 'efectivo', amount: '', description: '' })
      await loadCaja()
    } catch (e: any) { setMovError(e.message || 'Error al registrar movimiento') }
    finally { setSavingMov(false) }
  }

  const handleCloseCaja = async () => {
    if (!activeCaja || !user || !totals) return
    setClosing(true)
    try {
      const efDiff = closeForm.efectivo      !== '' ? (parseFloat(closeForm.efectivo)      || 0) - totals.efectivo.balance      : 0
      const trDiff = closeForm.transferencia !== '' ? (parseFloat(closeForm.transferencia) || 0) - totals.transferencia.balance : 0
      const taDiff = closeForm.tarjeta       !== '' ? (parseFloat(closeForm.tarjeta)       || 0) - totals.tarjeta.balance       : 0
      const usDiff = closeForm.usd           !== '' ? ((parseFloat(closeForm.usd)          || 0) - totals.usd.balance) * exchangeRate : 0
      const difference = efDiff + trDiff + taDiff + usDiff

      await supabase.from('cajas').update({
        status: 'cerrada',
        closed_at: new Date().toISOString(),
        closed_by: user.id,
        efectivo_cierre:      parseFloat(closeForm.efectivo)      || null,
        transferencia_cierre: parseFloat(closeForm.transferencia) || null,
        tarjeta_cierre:       parseFloat(closeForm.tarjeta)       || null,
        usd_cierre:           parseFloat(closeForm.usd)           || null,
        notas: closingNotes || null,
        difference,
      }).eq('id', activeCaja.id)
      setShowClose(false)
      setCloseForm({ efectivo: '', transferencia: '', tarjeta: '', usd: '' })
      setClosingNotes('')
      await loadCaja()
      await loadHistorial()
    } catch (e: any) { setError(e.message || 'Error al cerrar caja') }
    finally { setClosing(false) }
  }

  const handleDeleteMovement = async (movId: string) => {
    if (!confirm('¿Eliminás este movimiento?')) return
    await supabase.from('financial_movements').delete().eq('id', movId)
    await loadCaja()
  }

  const handleNavigate = (mov: CajaMovement) => {
    if (['comprobante','cobro_rapido'].includes(mov.source)) navigate('/comprobantes')
    else if (mov.source === 'expense') navigate('/expenses')
    else if (mov.source === 'pago_proveedor') navigate('/suppliers')
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  const isLoading = loading || activeCaja === undefined

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1100px', margin: '0 auto' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ width: 44, height: 44, borderRadius: '0.75rem', background: 'rgba(52,211,153,0.15)', border: '1px solid rgba(52,211,153,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Wallet size={22} style={{ color: '#34d399' }} />
          </div>
          <div>
            <h1 style={{ fontSize: '1.375rem', fontWeight: 800, color: '#f8fafc', margin: 0, lineHeight: 1 }}>Caja</h1>
            <p style={{ fontSize: '0.8rem', color: '#475569', margin: '0.2rem 0 0' }}>
              {activeCaja
                ? `Abierta ${fmtDateLong(activeCaja.opened_at)}`
                : activeCaja === null ? 'Sin caja abierta' : 'Cargando...'}
            </p>
          </div>
        </div>

        {activeCaja && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button onClick={loadCaja} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#64748b', cursor: 'pointer', fontSize: '0.8rem' }}>
              <RefreshCw size={14} /> Actualizar
            </button>
            <button onClick={() => setShowAddMov(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '0.5rem', color: '#818cf8', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 }}>
              <Plus size={15} /> Movimiento
            </button>
            <button onClick={() => setShowClose(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 }}>
              <Lock size={14} /> Cerrar Caja
            </button>
          </div>
        )}
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 1rem', marginBottom: '1rem', background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.875rem' }}>
          <AlertCircle size={16} /> {formatDisplayMessage(error)}
        </div>
      )}

      {/* ── Loading ── */}
      {isLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <Loader2 size={32} style={{ color: '#6366f1', animation: 'spin 1s linear infinite' }} />
        </div>
      )}

      {/* ── Sin caja abierta: abrir ── */}
      {!isLoading && activeCaja === null && (
        <div style={{ maxWidth: 520, margin: '3rem auto' }}>
          <div style={{ background: '#111827', border: '1px solid rgba(52,211,153,0.15)', borderRadius: '1rem', overflow: 'hidden' }}>
            <div style={{ padding: '1.75rem 1.75rem 1.25rem', textAlign: 'center', background: 'rgba(52,211,153,0.04)', borderBottom: '1px solid rgba(52,211,153,0.1)' }}>
              <div style={{ width: 56, height: 56, borderRadius: '1rem', background: 'rgba(52,211,153,0.15)', border: '1px solid rgba(52,211,153,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1rem' }}>
                <Unlock size={26} style={{ color: '#34d399' }} />
              </div>
              <h2 style={{ fontWeight: 800, fontSize: '1.2rem', color: '#f8fafc', margin: '0 0 0.375rem' }}>Abrir Caja</h2>
              <p style={{ color: '#475569', fontSize: '0.8rem', margin: 0 }}>Ingresá el saldo inicial por método de pago</p>
            </div>

            <div style={{ padding: '1.25rem 1.75rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.875rem', marginBottom: '1.25rem' }}>
                {METHODS.map(m => {
                  const meta = METHOD_META[m]
                  const Icon = meta.icon
                  return (
                    <div key={m}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.75rem', color: meta.color, fontWeight: 600, marginBottom: '0.375rem' }}>
                        <Icon size={12} /> {meta.label} {m === 'usd' && <span style={{ color: '#334155', fontWeight: 400 }}>(TC: ${exchangeRate.toLocaleString('es-AR')})</span>}
                      </label>
                      <input type="number" min="0" step="0.01" placeholder="0"
                        value={openForm[m]}
                        onChange={e => setOpenForm(p => ({ ...p, [m]: e.target.value }))}
                        style={{ width: '100%', padding: '0.6rem 0.75rem', background: 'rgba(255,255,255,0.04)', border: `1px solid rgba(255,255,255,0.08)`, borderRadius: '0.5rem', color: meta.color, fontSize: '0.95rem', fontFamily: 'monospace', fontWeight: 700, outline: 'none', boxSizing: 'border-box' }}
                        onFocus={e => (e.currentTarget.style.borderColor = meta.color + '66')}
                        onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)')}
                      />
                    </div>
                  )
                })}
              </div>

              <button onClick={handleOpenCaja} disabled={opening}
                style={{ width: '100%', padding: '0.875rem', background: opening ? 'rgba(52,211,153,0.08)' : 'rgba(52,211,153,0.18)', border: '1px solid rgba(52,211,153,0.35)', borderRadius: '0.625rem', color: '#34d399', fontWeight: 800, fontSize: '1rem', cursor: opening ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                {opening ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> : <Unlock size={18} />}
                {opening ? 'Abriendo...' : 'Abrir Caja'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Caja abierta ── */}
      {!isLoading && activeCaja && totals && (
        <>
          {/* Method cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '1.25rem' }}>
            {METHODS.map(m => (
              <MethodCard key={m} method={m} totals={totals[m]} cotizacion={exchangeRate}
                isSelected={activeMethod === m}
                onClick={() => setActiveMethod(prev => prev === m ? 'all' : m)}
              />
            ))}
          </div>

          {/* Total strip */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1.25rem', marginBottom: '1.25rem', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: '0.625rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
              <span style={{ fontSize: '0.72rem', color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total ARS</span>
              <span style={{ fontSize: '1.25rem', fontWeight: 800, fontFamily: 'monospace', color: '#818cf8', letterSpacing: '-0.02em' }}>{totalARS}</span>
            </div>
            <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.75rem' }}>
              <span style={{ color: '#334155' }}>
                USD: <span style={{ color: '#fbbf24', fontFamily: 'monospace' }}>{fmtUSD(totals.usd.balance)}</span>
                <span style={{ color: '#334155' }}> ≈ {fmtARS(totals.usd.balance * exchangeRate)}</span>
              </span>
              <span style={{ color: '#334155' }}>
                {movements.length} movimientos
              </span>
              {activeMethod !== 'all' && (
                <button onClick={() => setActiveMethod('all')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#818cf8', fontSize: '0.75rem', fontWeight: 600, padding: 0 }}>
                  Ver todos
                </button>
              )}
            </div>
          </div>

          {/* Movement filter tabs */}
          <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.75rem' }}>
            {(['all', ...METHODS] as const).map(m => {
              const isAll  = m === 'all'
              const meta   = isAll ? null : METHOD_META[m]
              const active = activeMethod === m
              const count  = isAll ? movements.length : movements.filter(mv => (mv.metodo_pago || 'efectivo') === m).length
              return (
                <button key={m} onClick={() => setActiveMethod(m)}
                  style={{ padding: '0.375rem 0.75rem', borderRadius: '0.375rem', border: `1px solid ${active ? (meta?.color ?? '#818cf8') + '44' : 'rgba(255,255,255,0.06)'}`, background: active ? (meta?.accent ?? 'rgba(99,102,241,0.1)') : 'transparent', color: active ? (meta?.color ?? '#818cf8') : '#475569', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}>
                  {isAll ? `Todos (${count})` : `${meta!.label} (${count})`}
                </button>
              )
            })}
          </div>

          {/* Movements table */}
          <div style={{ background: '#111827', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '0.75rem', overflow: 'hidden' }}>
            {filteredMovs.length === 0 ? (
              <div style={{ padding: '3rem', textAlign: 'center', color: '#334155' }}>
                <Wallet size={28} style={{ margin: '0 auto 0.75rem', opacity: 0.3 }} />
                <p style={{ margin: 0, fontSize: '0.875rem' }}>Sin movimientos{activeMethod !== 'all' ? ` en ${METHOD_META[activeMethod].label}` : ''}</p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      {['Hora', 'Descripción', 'Fuente', 'Método', 'Monto', ''].map(h => (
                        <th key={h} style={{ padding: '0.625rem 1rem', textAlign: 'left', color: '#334155', fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMovs.map(mov => {
                      const src    = getSourceMeta(mov.source)
                      const SrcIcon = src.icon
                      const method  = (mov.metodo_pago || 'efectivo') as CajaMethod
                      const mMeta   = METHOD_META[method] || METHOD_META.efectivo
                      const isNav   = ['comprobante','cobro_rapido','expense','pago_proveedor'].includes(mov.source)
                      const amtARS  = mov.currency === 'ARS' ? mov.amount : (mov.amount_ars || 0)
                      const amtUSD  = mov.currency === 'USD' ? mov.amount : null
                      return (
                        <tr key={mov.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                          <td style={{ padding: '0.625rem 1rem', color: '#334155', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>{fmtTime(mov.created_at)}</td>
                          <td style={{ padding: '0.625rem 1rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                              <span style={{ color: '#cbd5e1', fontWeight: mov.description ? 500 : 400 }}>{mov.description || '—'}</span>
                              {isNav && (
                                <button onClick={() => handleNavigate(mov)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#334155', padding: 0, display: 'flex', alignItems: 'center' }}
                                  onMouseEnter={e => (e.currentTarget.style.color = src.color)}
                                  onMouseLeave={e => (e.currentTarget.style.color = '#334155')}>
                                  <ChevronRight size={12} />
                                </button>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '0.625rem 1rem' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.72rem', color: src.color }}>
                              <SrcIcon size={11} /> {src.label}
                            </span>
                          </td>
                          <td style={{ padding: '0.625rem 1rem' }}>
                            <span style={{ fontSize: '0.72rem', padding: '0.15rem 0.45rem', borderRadius: '0.25rem', background: mMeta.accent, color: mMeta.color, fontWeight: 700 }}>
                              {mMeta.label}
                            </span>
                          </td>
                          <td style={{ padding: '0.625rem 1rem', fontFamily: 'monospace', fontWeight: 700, fontSize: '0.9rem', color: mov.type === 'income' ? '#34d399' : '#f87171', whiteSpace: 'nowrap' }}>
                            {mov.type === 'income' ? '+' : '−'}
                            {amtUSD !== null ? `${fmtUSD(amtUSD)} (${fmtARS(amtARS)})` : fmtARS(amtARS)}
                          </td>
                          <td style={{ padding: '0.625rem 0.75rem' }}>
                            <button onClick={() => handleDeleteMovement(mov.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1e3a5f', padding: '0.2rem', display: 'flex', alignItems: 'center' }}
                              onMouseEnter={e => (e.currentTarget.style.color = '#f87171')}
                              onMouseLeave={e => (e.currentTarget.style.color = '#1e3a5f')}>
                              <Trash2 size={13} />
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

      {/* ── Historial ── */}
      {historial.length > 0 && (
        <div style={{ marginTop: '1.5rem', background: '#111827', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '0.75rem', overflow: 'hidden' }}>
          <button onClick={() => setShowHistorial(v => !v)} style={{ width: '100%', padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', borderBottom: showHistorial ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, color: '#e2e8f0', fontSize: '0.9rem' }}>
              <Calendar size={15} style={{ color: '#475569' }} /> Historial de Cajas
            </span>
            <span style={{ fontSize: '0.75rem', color: '#334155' }}>{showHistorial ? '▲' : `▼ ${historial.length} sesiones`}</span>
          </button>

          {showHistorial && historial.map(cr => {
            const duracion = cr.closed_at
              ? Math.round((new Date(cr.closed_at).getTime() - new Date(cr.opened_at).getTime()) / 60000)
              : null
            const isExpanded = expandedHistory === cr.id
            return (
              <div key={cr.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <div onClick={() => setExpandedHistory(p => p === cr.id ? null : cr.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.75rem 1.25rem', cursor: 'pointer', background: isExpanded ? 'rgba(255,255,255,0.025)' : 'transparent' }}
                  onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = 'rgba(255,255,255,0.015)' }}
                  onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'transparent' }}>
                  <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#cbd5e1', minWidth: 100 }}>{fmtDateShort(cr.opened_at)}</span>
                  <span style={{ fontSize: '0.72rem', color: '#334155', minWidth: 70 }}>{duracion !== null ? `${duracion} min` : 'Aún abierta'}</span>
                  <div style={{ flex: 1, display: 'flex', gap: '0.875rem', flexWrap: 'wrap' }}>
                    {METHODS.map(m => {
                      const meta = METHOD_META[m]
                      const ini  = cr[`${m}_inicial` as keyof Caja] as number || 0
                      return (
                        <span key={m} style={{ fontSize: '0.7rem', color: '#334155' }}>
                          <span style={{ color: meta.color }}>{meta.label.substring(0,4)}</span>: {m === 'usd' ? fmtUSD(ini) : fmtARS(ini)}
                        </span>
                      )
                    })}
                  </div>
                  {cr.difference !== null && cr.difference !== undefined && (
                    <span style={{ fontSize: '0.75rem', fontFamily: 'monospace', fontWeight: 700, flexShrink: 0, color: cr.difference === 0 ? '#34d399' : cr.difference > 0 ? '#fbbf24' : '#f87171' }}>
                      {cr.difference > 0 ? '+' : ''}{fmtARS(cr.difference)}
                    </span>
                  )}
                  <ChevronDown size={14} style={{ color: '#334155', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }} />
                </div>
                {isExpanded && (
                  <div style={{ padding: '0 1rem 1rem' }}>
                    <HistoryCajaPanel caja={cr} onNavigate={handleNavigate} businessId={businessId || ''} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Modal: Agregar movimiento ── */}
      {showAddMov && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}
          onClick={e => { if (e.target === e.currentTarget) setShowAddMov(false) }}>
          <div style={{ background: '#0f172a', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '0.875rem', width: '100%', maxWidth: 420, padding: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
              <h3 style={{ fontWeight: 700, color: '#f8fafc', margin: 0 }}>Registrar movimiento</h3>
              <CloseButton onClick={() => setShowAddMov(false)} />
            </div>
            {movError && <div style={{ padding: '0.5rem 0.75rem', marginBottom: '1rem', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.375rem', color: '#f87171', fontSize: '0.8rem' }}>{movError}</div>}
            <form onSubmit={handleAddMovement} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Tipo */}
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: '#64748b', marginBottom: '0.375rem', fontWeight: 600 }}>Tipo</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {([['income','Ingreso','#34d399'],['expense','Egreso','#f87171']] as const).map(([v,l,c]) => (
                    <button key={v} type="button" onClick={() => setMovForm(f => ({ ...f, type: v }))}
                      style={{ flex: 1, padding: '0.5rem', borderRadius: '0.375rem', border: `2px solid ${movForm.type === v ? c : 'rgba(255,255,255,0.08)'}`, background: movForm.type === v ? `${c}22` : 'transparent', color: movForm.type === v ? c : '#475569', fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer' }}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              {/* Método */}
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: '#64748b', marginBottom: '0.375rem', fontWeight: 600 }}>Método</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.375rem' }}>
                  {METHODS.map(m => {
                    const meta = METHOD_META[m]
                    const sel  = movForm.method === m
                    return (
                      <button key={m} type="button" onClick={() => setMovForm(f => ({ ...f, method: m }))}
                        style={{ padding: '0.4rem 0.25rem', borderRadius: '0.375rem', border: `1px solid ${sel ? meta.color + '55' : 'rgba(255,255,255,0.08)'}`, background: sel ? meta.accent : 'transparent', color: sel ? meta.color : '#475569', fontWeight: 600, fontSize: '0.72rem', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem' }}>
                        <meta.icon size={14} />
                        {meta.label.split(' ')[0]}
                      </button>
                    )
                  })}
                </div>
              </div>
              {/* Monto */}
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: '#64748b', marginBottom: '0.375rem', fontWeight: 600 }}>
                  Monto {movForm.method === 'usd' ? '(USD)' : '(ARS)'}
                </label>
                <input type="number" min="0.01" step="0.01" required value={movForm.amount}
                  onChange={e => setMovForm(f => ({ ...f, amount: e.target.value }))} placeholder="0"
                  style={{ width: '100%', padding: '0.625rem 0.875rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: '#f8fafc', fontSize: '1.1rem', fontFamily: 'monospace', fontWeight: 700, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              {/* Descripción */}
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: '#64748b', marginBottom: '0.375rem', fontWeight: 600 }}>Descripción (opcional)</label>
                <input type="text" value={movForm.description}
                  onChange={e => setMovForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Ej: Alquiler, cobro cliente..."
                  style={{ width: '100%', padding: '0.625rem 0.875rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: '#f8fafc', fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <button type="submit" disabled={savingMov}
                style={{ padding: '0.75rem', background: savingMov ? 'rgba(99,102,241,0.1)' : 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)', borderRadius: '0.5rem', color: '#818cf8', fontWeight: 800, fontSize: '1rem', cursor: savingMov ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                {savingMov ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={18} />}
                {savingMov ? 'Guardando...' : 'Registrar'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Cerrar caja ── */}
      {showClose && activeCaja && totals && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}
          onClick={e => { if (e.target === e.currentTarget) setShowClose(false) }}>
          <div style={{ background: '#0d1a30', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '1rem', width: '100%', maxWidth: 560, maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div style={{ width: 36, height: 36, borderRadius: '0.5rem', background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Lock size={17} style={{ color: '#f87171' }} />
                </div>
                <div>
                  <h3 style={{ fontWeight: 800, color: '#f8fafc', margin: 0, fontSize: '1rem' }}>Cerrar Caja</h3>
                  <p style={{ margin: 0, fontSize: '0.72rem', color: '#475569' }}>Ingresá el saldo contado por método</p>
                </div>
              </div>
              <button onClick={() => setShowClose(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem', display: 'flex' }}>
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.5rem' }}>
              {/* Comparison table */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0', marginBottom: '1.25rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '0.625rem', overflow: 'hidden' }}>
                {/* Header */}
                {['Método', 'Esperado', 'Contado', 'Diferencia'].map(h => (
                  <div key={h} style={{ padding: '0.5rem 0.875rem', fontSize: '0.66rem', color: '#334155', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.02)' }}>{h}</div>
                ))}
                {/* Rows */}
                {METHODS.filter(m => m !== 'usd').map(m => {
                  const meta     = METHOD_META[m]
                  const expected = expectedClose[m]
                  const counted  = parseFloat(closeForm[m]) || 0
                  const diff     = counted - expected
                  const hasCounted = closeForm[m] !== ''
                  return (
                    <>
                      <div key={m + '_label'} style={{ padding: '0.625rem 0.875rem', display: 'flex', alignItems: 'center', gap: '0.375rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <meta.icon size={12} style={{ color: meta.color }} />
                        <span style={{ fontSize: '0.78rem', color: meta.color, fontWeight: 600 }}>{meta.label}</span>
                      </div>
                      <div key={m + '_exp'} style={{ padding: '0.625rem 0.875rem', fontFamily: 'monospace', fontSize: '0.82rem', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>{fmtARS(expected)}</div>
                      <div key={m + '_inp'} style={{ padding: '0.375rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <input type="number" min="0" step="1" value={closeForm[m]}
                          onChange={e => setCloseForm(p => ({ ...p, [m]: e.target.value }))}
                          placeholder={fmtARS(expected).replace('$', '')}
                          style={{ width: '100%', padding: '0.375rem 0.5rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.375rem', color: '#f8fafc', fontSize: '0.82rem', fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' }}
                        />
                      </div>
                      <div key={m + '_diff'} style={{ padding: '0.625rem 0.875rem', fontFamily: 'monospace', fontSize: '0.82rem', fontWeight: 700, borderBottom: '1px solid rgba(255,255,255,0.04)', color: !hasCounted ? '#334155' : diff === 0 ? '#34d399' : diff > 0 ? '#fbbf24' : '#f87171', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        {hasCounted && diff !== 0 && (diff > 0 ? <AlertTriangle size={11} /> : <AlertCircle size={11} />)}
                        {hasCounted ? `${diff >= 0 ? '+' : ''}${fmtARS(diff)}` : '—'}
                      </div>
                    </>
                  )
                })}
                {/* USD row */}
                {(() => {
                  const expected = expectedClose.usd
                  const counted  = parseFloat(closeForm.usd) || 0
                  const diff     = counted - expected
                  const hasCounted = closeForm.usd !== ''
                  return (
                    <>
                      <div style={{ padding: '0.625rem 0.875rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                        <DollarSign size={12} style={{ color: '#fbbf24' }} />
                        <span style={{ fontSize: '0.78rem', color: '#fbbf24', fontWeight: 600 }}>Dólares</span>
                      </div>
                      <div style={{ padding: '0.625rem 0.875rem', fontFamily: 'monospace', fontSize: '0.82rem', color: '#94a3b8', fontWeight: 600 }}>{fmtUSD(expected)}</div>
                      <div style={{ padding: '0.375rem 0.5rem' }}>
                        <input type="number" min="0" step="0.01" value={closeForm.usd}
                          onChange={e => setCloseForm(p => ({ ...p, usd: e.target.value }))}
                          placeholder="0.00"
                          style={{ width: '100%', padding: '0.375rem 0.5rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.375rem', color: '#fbbf24', fontSize: '0.82rem', fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' }}
                        />
                      </div>
                      <div style={{ padding: '0.625rem 0.875rem', fontFamily: 'monospace', fontSize: '0.82rem', fontWeight: 700, color: !hasCounted ? '#334155' : diff === 0 ? '#34d399' : diff > 0 ? '#fbbf24' : '#f87171' }}>
                        {hasCounted ? `${diff >= 0 ? '+' : ''}${fmtUSD(diff)}` : '—'}
                      </div>
                    </>
                  )
                })()}
              </div>

              {/* Notes */}
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: '#64748b', marginBottom: '0.375rem', fontWeight: 600 }}>Notas de cierre (opcional)</label>
                <textarea value={closingNotes} onChange={e => setClosingNotes(e.target.value)} rows={2}
                  placeholder="Observaciones del turno..."
                  style={{ width: '100%', padding: '0.625rem 0.875rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#f8fafc', fontSize: '0.875rem', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
              </div>
            </div>

            {/* Footer */}
            <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', flexShrink: 0, background: '#0d1a30' }}>
              <button onClick={() => setShowClose(false)} style={{ padding: '0.625rem 1.25rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#64748b', fontWeight: 600, cursor: 'pointer', fontSize: '0.875rem' }}>
                Cancelar
              </button>
              <button onClick={handleCloseCaja} disabled={closing}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 1.5rem', background: closing ? 'rgba(248,113,113,0.1)' : 'rgba(248,113,113,0.18)', border: '1px solid rgba(248,113,113,0.35)', borderRadius: '0.5rem', color: '#f87171', fontWeight: 800, cursor: closing ? 'not-allowed' : 'pointer', fontSize: '0.875rem' }}>
                {closing ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Lock size={16} />}
                {closing ? 'Cerrando...' : 'Confirmar cierre'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
