import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { resolvePurchaseKey } from '../utils/purchaseIdempotency'
import {
  Wallet, Plus, Loader2, AlertCircle,
  Lock, Unlock, RefreshCw, Trash2, Calendar, ChevronRight, ChevronDown,
  DollarSign, CreditCard, Building2,
  Banknote, X, AlertTriangle, FileText, Receipt, Truck,
} from 'lucide-react'
import { CloseButton } from '../components/ui/CloseButton'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useCaja } from '../contexts/CajaContext'
import { currencyService } from '../services/currencyService'
import { formatDisplayMessage } from '../utils/formatMessage'
import { showToast } from '../utils/toast'

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
    <div onClick={onClick} className="card-interactive" style={{
      padding: '1rem 1.125rem', borderRadius: '0.75rem',
      background: isSelected ? meta.accent : 'rgba(255,255,255,0.02)',
      border: `1px solid ${isSelected ? meta.color + '44' : 'rgba(255,255,255,0.06)'}`,
      borderLeft: `3px solid ${meta.color}`,
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

function HistoryCajaPanel({ caja, onNavigate }: HistoryCajaPanelProps) {
  const [movs, setMovs]     = useState<CajaMovement[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('financial_movements').select('*')
      .eq('caja_id', caja.id)
      .order('created_at', { ascending: true })
      .then(({ data }) => { setMovs((data || []) as CajaMovement[]); setLoading(false) })
  }, [caja.id])

  const totals = useMemo(() => computeTotals(caja, movs), [caja, movs])
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
          <Loader2 size={20} style={{ color: '#6366f1', animation: 'tr-spin 1s linear infinite' }} />
        </div>
      ) : movs.length === 0 ? (
        <div style={{ padding: '1.25rem', textAlign: 'center', color: '#334155', fontSize: '0.8rem' }}>Sin movimientos registrados</div>
      ) : (
        <div data-testid="caja-movements-list" style={{ maxHeight: 280, overflowY: 'auto' }}>
          {movs.map(mov => {
            const src = getSourceMeta(mov.source)
            const SrcIcon = src.icon
            const methodMeta = METHOD_META[(mov.metodo_pago || 'efectivo') as CajaMethod] || METHOD_META.efectivo
            const isNav = ['comprobante','cobro_rapido','expense','pago_proveedor'].includes(mov.source)
            const amountARS = mov.currency === 'ARS' ? mov.amount : mov.amount_ars
            return (
              <div data-testid="caja-movement-row" key={mov.id} onClick={() => isNav && onNavigate(mov)}
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
  const { refresh: refreshCajaContext } = useCaja()
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
  const [historialFilter, setHistorialFilter] = useState<'hoy' | 'semana' | 'mes' | 'todo'>('mes')

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
  // Idempotency keys (apertura/cierre) — estables por intento, renovadas por payload.
  const openKeyRef  = useRef<string | null>(null)
  const openHashRef = useRef<string | null>(null)
  const closeKeyRef  = useRef<string | null>(null)
  const closeHashRef = useRef<string | null>(null)
  const movKeyRef  = useRef<string | null>(null)
  const movHashRef = useRef<string | null>(null)

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
    const now    = new Date()
    const today  = now.toISOString().split('T')[0]
    const weekAgo  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000).toISOString()
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

    let q = supabase
      .from('cajas').select('*')
      .eq('business_id', businessId).eq('status', 'cerrada')
      .order('opened_at', { ascending: false })

    if (historialFilter === 'hoy')   q = q.gte('opened_at', today)
    if (historialFilter === 'semana') q = q.gte('opened_at', weekAgo)
    if (historialFilter === 'mes')   q = q.gte('opened_at', monthAgo)
    // 'todo' → sin filtro de fecha, trae todas (sin LIMIT)

    const { data } = await q
    setHistorial((data || []) as Caja[])
  }, [businessId, historialFilter])

  useEffect(() => {
    loadExchangeRate()
    loadCaja()
  }, [loadExchangeRate, loadCaja])

  useEffect(() => {
    loadHistorial()
  }, [loadHistorial])

  // ── Computed ─────────────────────────────────────────────────────────────────

  const totals = useMemo(() =>
    activeCaja ? computeTotals(activeCaja, movements) : null
  , [activeCaja, movements])

  const filteredMovs = useMemo(() =>
    activeMethod === 'all' ? movements : movements.filter(m => (m.metodo_pago || 'efectivo') === activeMethod)
  , [movements, activeMethod])

  const totalARS = useMemo(() =>
    totals ? fmtARS(METHODS.filter(m => m !== 'usd').reduce((s, m) => s + totals[m].balance, 0)) : '$0'
  , [totals])

  // Expected balances for close modal
  const expectedClose = useMemo(() => {
    if (!totals) return {} as Record<CajaMethod, number>
    return { efectivo: totals.efectivo.balance, transferencia: totals.transferencia.balance, tarjeta: totals.tarjeta.balance, usd: totals.usd.balance }
  }, [totals])

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleOpenCaja = async () => {
    if (!businessId || !user) return
    setOpening(true); setError(null)
    // key ligada al payload (renovación por cambio de montos; conserva ante doble-click)
    const localHash = `${openForm.efectivo}|${openForm.transferencia}|${openForm.tarjeta}|${openForm.usd}`
    const rk = resolvePurchaseKey(openKeyRef.current, openHashRef.current, localHash, () => crypto.randomUUID())
    openKeyRef.current = rk.key; openHashRef.current = rk.hash
    try {
      const { data, error: err } = await supabase.rpc('open_cash_session_atomic', {
        p_business_id:     businessId,
        p_user_id:         user.id,
        p_efectivo:        parseFloat(openForm.efectivo)      || 0,
        p_transferencia:   parseFloat(openForm.transferencia) || 0,
        p_tarjeta:         parseFloat(openForm.tarjeta)       || 0,
        p_usd:             parseFloat(openForm.usd)           || 0,
        p_usd_rate:        exchangeRate,
        p_idempotency_key: openKeyRef.current,
      })
      if (err) throw err
      const res = data as { ok: boolean; error?: string; message?: string; caja_id?: string } | null
      if (res?.error === 'IDEMPOTENCY_CONFLICT') { openKeyRef.current = null; openHashRef.current = null; throw new Error(res.message) }
      if (!res?.ok) throw new Error(res?.error || 'Error al abrir caja')
      // La RPC devuelve caja_id: traer la fila para el estado (no calcular en cliente).
      const { data: caja } = await supabase.from('cajas').select('*').eq('id', res.caja_id!).single()
      openKeyRef.current = null; openHashRef.current = null
      if (caja) setActiveCaja(caja as Caja)
      setMovements([])
      setOpenForm({ efectivo: '', transferencia: '', tarjeta: '', usd: '' })
      void refreshCajaContext()
      window.dispatchEvent(new Event('cash-session-updated'))
      showToast('Caja abierta correctamente', 'success')
    } catch (e: any) { setError(e.message || 'Error al abrir caja') }
    finally { setOpening(false) }
  }

  const handleAddMovement = async (e: React.FormEvent) => {
    e.preventDefault()
    const amount = parseFloat(movForm.amount)
    if (!amount || amount <= 0) { setMovError('El monto debe ser mayor a 0'); return }
    if (!activeCaja || !user) return
    setSavingMov(true); setMovError('')
    // key ligada al contenido (conserva ante doble-click; renueva si cambia)
    const localHash = `${activeCaja.id}|${movForm.type}|${movForm.method}|${amount}`
    const rk = resolvePurchaseKey(movKeyRef.current, movHashRef.current, localHash, () => crypto.randomUUID())
    movKeyRef.current = rk.key; movHashRef.current = rk.hash
    try {
      // El movimiento manual entra por RPC atómica: resuelve la caja abierta
      // server-side y rechaza si no hay caja abierta o si está cerrada.
      const { data, error: rpcError } = await supabase.rpc('create_manual_cash_movement_atomic', {
        p_business_id:     businessId,
        p_type:            movForm.type,
        p_method:          movForm.method,
        p_amount:          amount,
        p_description:     movForm.description || null,
        p_user_id:         user.id,
        p_exchange_rate:   movForm.method === 'usd' ? exchangeRate : 1,
        p_idempotency_key: movKeyRef.current,
      })
      if (rpcError) throw new Error(rpcError.message)
      const res = data as { ok?: boolean; error?: string; message?: string }
      if (res?.error === 'IDEMPOTENCY_CONFLICT') { movKeyRef.current = null; movHashRef.current = null; throw new Error(res.message) }
      if (!res?.ok) throw new Error(res?.error || 'Error al registrar movimiento')
      movKeyRef.current = null; movHashRef.current = null
      setShowAddMov(false)
      setMovForm({ type: 'income', method: 'efectivo', amount: '', description: '' })
      await loadCaja()
    } catch (e: any) { setMovError(e.message || 'Error al registrar movimiento') }
    finally { setSavingMov(false) }
  }

  const handleCloseCaja = async () => {
    if (!activeCaja || !user) return
    setClosing(true)
    // Conteos declarados: vacío → null (el servidor usa su esperado, diferencia 0).
    const parseCount = (v: string) => v !== '' ? (parseFloat(v) || 0) : null
    // key ligada al conteo + caja (conserva ante doble-click; renueva si cambia)
    const localHash = `${activeCaja.id}|${closeForm.efectivo}|${closeForm.transferencia}|${closeForm.tarjeta}|${closeForm.usd}`
    const rk = resolvePurchaseKey(closeKeyRef.current, closeHashRef.current, localHash, () => crypto.randomUUID())
    closeKeyRef.current = rk.key; closeHashRef.current = rk.hash
    try {
      // El CIERRE DEFINITIVO lo calcula la RPC (esperados y diferencias server-side).
      // El cálculo local de `totals` queda solo como PREVISUALIZACIÓN.
      const { data, error: err } = await supabase.rpc('close_cash_session_atomic', {
        p_business_id:         businessId,
        p_user_id:             user.id,
        p_caja_id:             activeCaja.id,
        p_count_efectivo:      parseCount(closeForm.efectivo),
        p_count_transferencia: parseCount(closeForm.transferencia),
        p_count_tarjeta:       parseCount(closeForm.tarjeta),
        p_count_usd:           parseCount(closeForm.usd),
        p_usd_rate:            exchangeRate,
        p_notes:               closingNotes || null,
        p_idempotency_key:     closeKeyRef.current,
      })
      if (err) throw err
      const res = data as { ok: boolean; error?: string; message?: string; total_difference?: number } | null
      if (res?.error === 'IDEMPOTENCY_CONFLICT') { closeKeyRef.current = null; closeHashRef.current = null; throw new Error(res.message) }
      if (!res?.ok) throw new Error(res?.error || 'Error al cerrar caja')
      closeKeyRef.current = null; closeHashRef.current = null
      const diff = res.total_difference ?? 0
      setShowClose(false)
      setCloseForm({ efectivo: '', transferencia: '', tarjeta: '', usd: '' })
      setClosingNotes('')
      await loadCaja()
      await loadHistorial()
      void refreshCajaContext()
      window.dispatchEvent(new Event('cash-session-updated'))
      // Diferencia devuelta por el SERVIDOR (no el cálculo local).
      showToast(Math.abs(diff) < 0.01 ? 'Caja cerrada sin diferencias' : `Caja cerrada · diferencia ${fmtARS(diff)}`, 'info')
    } catch (e: any) { setError(e.message || 'Error al cerrar caja') }
    finally { setClosing(false) }
  }

  // Corrección controlada (Etapa 0): solo movimientos MANUALES de la caja
  // abierta, vía RPC reverse_manual_cash_movement — nunca se borra el asiento,
  // se inserta la reversa compensatoria con motivo. Los movimientos de
  // comprobantes/proveedores/retiros/órdenes se revierten desde su módulo.
  const handleCorrectMovement = async (mov: CajaMovement) => {
    const reason = prompt('Motivo de la corrección (se registra la reversa, no se borra el movimiento):')
    if (reason === null) return
    if (!reason.trim()) { showToast('El motivo es obligatorio', 'error'); return }
    const { data, error: rpcError } = await supabase.rpc('reverse_manual_cash_movement', {
      p_movement_id: mov.id,
      p_reason:      reason.trim(),
    })
    const result = data as { ok: boolean; error?: string } | null
    if (rpcError || !result?.ok) {
      showToast(result?.error || rpcError?.message || 'No se pudo corregir el movimiento', 'error')
      return
    }
    showToast('Movimiento corregido (reversa registrada)', 'success')
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
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon green"><Wallet size={22} /></div>
          <div>
            <h1 className="page-hdr-title">Caja</h1>
            <p data-testid="caja-status" className="page-hdr-subtitle">
              {activeCaja
                ? `Abierta ${fmtDateLong(activeCaja.opened_at)}`
                : activeCaja === null ? 'Sin caja abierta' : 'Cargando...'}
            </p>
          </div>
        </div>

        {activeCaja && (
          <div className="page-hdr-right">
            <button onClick={loadCaja} className="btn btn-ghost btn-sm"><RefreshCw size={14} /> Actualizar</button>
            <button data-testid="caja-add-movement-button" onClick={() => setShowAddMov(true)} className="btn btn-indigo btn-sm btn-lift"><Plus size={15} /> Movimiento</button>
            <button onClick={() => {
              // Pre-fill con montos esperados para que el cierre no quede en null/0
              if (totals) {
                setCloseForm({
                  efectivo:      totals.efectivo.balance      > 0 ? String(Math.round(totals.efectivo.balance))      : '',
                  transferencia: totals.transferencia.balance  > 0 ? String(Math.round(totals.transferencia.balance)) : '',
                  tarjeta:       totals.tarjeta.balance        > 0 ? String(Math.round(totals.tarjeta.balance))       : '',
                  usd:           totals.usd.balance            > 0 ? String(totals.usd.balance.toFixed(2))            : '',
                })
              }
              setShowClose(true)
            }} className="btn btn-danger btn-sm btn-lift"><Lock size={14} /> Cerrar Caja</button>
          </div>
        )}
      </div>

      {error && (
        <div className="alert-inline alert-error" style={{ marginBottom: '1rem' }}>
          <AlertCircle size={15} style={{ flexShrink: 0 }} /> {formatDisplayMessage(error)}
        </div>
      )}

      {/* ── Loading ── */}
      {isLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <Loader2 size={32} style={{ color: 'var(--accent-primary)', animation: 'tr-spin 1s linear infinite' }} />
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

              <button data-testid="caja-open-button" onClick={handleOpenCaja} disabled={opening} className="btn btn-lift"
                style={{ width: '100%', padding: '0.875rem', background: opening ? 'rgba(52,211,153,0.08)' : 'rgba(52,211,153,0.18)', border: '1px solid rgba(52,211,153,0.35)', borderRadius: '0.625rem', color: '#34d399', fontWeight: 800, fontSize: '1rem', cursor: opening ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                {opening ? <Loader2 size={18} style={{ animation: 'tr-spin 1s linear infinite' }} /> : <Unlock size={18} />}
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
                        <th key={h} className="label-caps" style={{ padding: '0.625rem 1rem', textAlign: 'left' }}>{h}</th>
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
                            {/* Solo movimientos MANUALES admiten corrección (reversa con motivo).
                                Los automáticos (comprobante, proveedor, retiro, orden) se
                                revierten desde su módulo de origen. */}
                            {mov.source === 'manual' && (
                              <button onClick={() => handleCorrectMovement(mov)} title="Corregir (registra la reversa)"
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1e3a5f', padding: '0.2rem', display: 'flex', alignItems: 'center' }}
                                onMouseEnter={e => (e.currentTarget.style.color = '#f87171')}
                                onMouseLeave={e => (e.currentTarget.style.color = '#1e3a5f')}>
                                <Trash2 size={13} />
                              </button>
                            )}
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
      <div style={{ marginTop: '1.5rem', background: '#111827', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '0.75rem', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem', borderBottom: showHistorial ? '1px solid rgba(255,255,255,0.05)' : 'none', flexWrap: 'wrap', gap: '0.625rem' }}>
          <button onClick={() => setShowHistorial(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, color: '#e2e8f0', fontSize: '0.9rem', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            <Calendar size={15} style={{ color: '#475569' }} /> Historial de Cajas
            <span style={{ fontSize: '0.75rem', color: '#334155', marginLeft: '0.25rem' }}>
              {showHistorial ? '▲' : `▼ ${historial.length > 0 ? `${historial.length} sesiones` : 'ver'}`}
            </span>
          </button>
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {([['hoy','Hoy'],['semana','7 días'],['mes','30 días'],['todo','Todo']] as const).map(([v,l]) => (
              <button key={v} onClick={() => { setHistorialFilter(v); setShowHistorial(true) }}
                style={{ padding: '0.3rem 0.625rem', borderRadius: '0.375rem', border: `1px solid ${historialFilter === v ? 'rgba(99,102,241,0.4)' : 'rgba(255,255,255,0.07)'}`, background: historialFilter === v ? 'rgba(99,102,241,0.12)' : 'transparent', color: historialFilter === v ? '#818cf8' : '#475569', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {historial.length === 0 && showHistorial && (
          <div style={{ padding: '2rem', textAlign: 'center', color: '#334155', fontSize: '0.8rem' }}>
            No hay cajas cerradas en este período.
          </div>
        )}

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

                  {/* Fecha apertura + duración */}
                  <div style={{ minWidth: 110, flexShrink: 0 }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#cbd5e1' }}>{fmtDateShort(cr.opened_at)}</div>
                    <div style={{ fontSize: '0.68rem', color: '#334155', marginTop: '0.1rem' }}>
                      {duracion !== null ? `${duracion} min` : 'Aún abierta'}
                    </div>
                  </div>

                  {/* Montos contados al cierre (si los hay) o iniciales */}
                  <div style={{ flex: 1, display: 'flex', gap: '0.875rem', flexWrap: 'wrap' }}>
                    {METHODS.map(m => {
                      const meta   = METHOD_META[m]
                      const cierre = cr[`${m}_cierre` as keyof Caja] as number | null
                      const ini    = cr[`${m}_inicial` as keyof Caja] as number || 0
                      const val    = cierre !== null ? cierre : ini
                      return (
                        <span key={m} style={{ fontSize: '0.72rem' }}>
                          <span style={{ color: meta.color }}>{meta.label.substring(0,4)}</span>
                          <span style={{ color: cierre !== null ? '#f8fafc' : '#334155', fontFamily: 'monospace', marginLeft: '0.25rem' }}>
                            {m === 'usd' ? fmtUSD(val) : fmtARS(val)}
                          </span>
                          {cierre === null && <span style={{ color: '#1e3a5f', fontSize: '0.6rem', marginLeft: '0.2rem' }}>ini</span>}
                        </span>
                      )
                    })}
                  </div>

                  {/* Diferencia */}
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

      {/* ── Modal: Agregar movimiento ── */}
      {showAddMov && (
        <div className="modal-overlay-dark" onClick={e => { if (e.target === e.currentTarget) setShowAddMov(false) }}>
          <div className="modal-card">
            <div className="modal-hdr">
              <h3>Registrar movimiento</h3>
              <CloseButton onClick={() => setShowAddMov(false)} />
            </div>
            {movError && <div className="alert-inline alert-error" style={{ margin: '0.75rem 1.375rem 0' }}>{movError}</div>}
            <form onSubmit={handleAddMovement} className="modal-body-scroll" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Tipo */}
              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Tipo</label>
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
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Método</label>
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
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>
                  Monto {movForm.method === 'usd' ? '(USD)' : '(ARS)'}
                </label>
                <input type="number" min="0.01" step="0.01" required value={movForm.amount}
                  onChange={e => setMovForm(f => ({ ...f, amount: e.target.value }))} placeholder="0"
                  className="form-control mono" style={{ fontSize: '1.1rem', fontWeight: 700 }} />
              </div>
              {/* Descripción */}
              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Descripción (opcional)</label>
                <input type="text" value={movForm.description}
                  onChange={e => setMovForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Ej: Alquiler, cobro cliente..."
                  className="form-control" />
              </div>
              <button type="submit" disabled={savingMov} className="btn btn-indigo btn-lift"
                style={{ width: '100%', padding: '0.75rem', fontWeight: 800, fontSize: '1rem' }}>
                {savingMov ? <><Loader2 size={18} style={{ animation: 'tr-spin 1s linear infinite' }} /> Guardando...</> : <><Plus size={18} /> Registrar</>}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Cerrar caja ── */}
      {showClose && activeCaja && totals && (
        <div className="modal-overlay-dark" onClick={e => { if (e.target === e.currentTarget) setShowClose(false) }}>
          <div className="modal-card modal-card-lg" style={{ border: '1px solid rgba(248,113,113,0.2)' }}>
            {/* Header */}
            <div className="modal-hdr">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div style={{ width: 36, height: 36, borderRadius: '0.5rem', background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Lock size={17} style={{ color: '#f87171' }} />
                </div>
                <div>
                  <h3 style={{ margin: 0 }}>Cerrar Caja</h3>
                  <p className="body-sm" style={{ margin: 0 }}>Ingresá el saldo contado por método</p>
                </div>
              </div>
              <button onClick={() => setShowClose(false)} className="icon-btn" aria-label="Cerrar"><X size={16} /></button>
            </div>

            {/* Body */}
            <div className="modal-body-scroll">
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
              <div style={{ marginTop: '0.75rem' }}>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Notas de cierre (opcional)</label>
                <textarea value={closingNotes} onChange={e => setClosingNotes(e.target.value)} rows={2}
                  placeholder="Observaciones del turno..." className="form-control" style={{ resize: 'vertical' }} />
              </div>
            </div>

            {/* Footer */}
            <div className="modal-ftr">
              <button onClick={() => setShowClose(false)} className="btn btn-ghost">Cancelar</button>
              <button onClick={handleCloseCaja} disabled={closing} className="btn btn-danger btn-lift">
                {closing ? <><Loader2 size={16} style={{ animation: 'tr-spin 1s linear infinite' }} /> Cerrando...</> : <><Lock size={16} /> Confirmar cierre</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
