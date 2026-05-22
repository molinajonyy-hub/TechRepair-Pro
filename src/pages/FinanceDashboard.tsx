import { useState, useCallback, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  RefreshCw, TrendingUp, TrendingDown, DollarSign, ShieldCheck,
  AlertCircle, AlertTriangle, ArrowUpRight, ArrowDownRight,
  CreditCard, Banknote, Wallet, RotateCcw, Truck, Receipt,
  Calendar, ChevronRight, CheckCircle2, Info,
  ShoppingCart, FileText, Settings, Activity,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

// ─── Types ────────────────────────────────────────────────────────────────────

type FinanceTab = 'resumen' | 'caja' | 'ventas' | 'gastos' | 'movimientos' | 'auditoria'
type PeriodPreset = 'today' | 'yesterday' | 'week' | 'month' | 'last_month' | 'custom'

interface DailySeries { date: string; income: number; expense: number; net: number }
interface ExpenseCat  { category: string; total: number }
interface TopMethod   { method: string; total: number }

interface DashboardData {
  period:    { from: string; to: string }
  summary: {
    gross_income: number; expenses: number; net_result: number
    sales_total: number; credit_notes_total: number
    supplier_payments: number; operational_expenses: number
  }
  cash_by_method: Record<string, number>
  sales: {
    count: number; nc_count: number; local_count: number; arca_count: number
    total_collected: number; pending_total: number
  }
  expenses_by_category: ExpenseCat[]
  top_payment_methods:  TopMethod[]
  daily_series:         DailySeries[]
  alerts: { critical: number; warning: number; low: number }
}

interface LatestMovement {
  id: string; date: string; type: string; amount_ars: number
  metodo_pago: string | null; description: string | null
  source: string; sign: number; comprobante_id: string | null
  created_at: string
}

type CheckStatus = 'ok' | 'low' | 'warning' | 'critical'
interface HealthCheck {
  id: string; title: string; severity: string; status: CheckStatus
  count: number; description: string; rows: Record<string, unknown>[]
}
interface HealthResult {
  ok: boolean; critical_count: number; warning_count: number
  low_count: number; total_issues: number; checked_at: string
  checks: HealthCheck[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n)

const fmtShort = (n: number) => {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return (n < 0 ? '-' : '') + '$' + (abs / 1_000_000).toFixed(1) + 'M'
  if (abs >= 1_000)     return (n < 0 ? '-' : '') + '$' + (abs / 1_000).toFixed(0) + 'k'
  return fmt(n)
}

const fmtDate = (d: string) =>
  new Date(d + 'T12:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })

function getDateRange(preset: PeriodPreset): { from: string; to: string } {
  const now   = new Date()
  const toISO = (d: Date) => d.toISOString().split('T')[0]
  switch (preset) {
    case 'today':
      return { from: toISO(now), to: toISO(now) }
    case 'yesterday': {
      const y = new Date(now); y.setDate(now.getDate() - 1)
      return { from: toISO(y), to: toISO(y) }
    }
    case 'week': {
      const s = new Date(now); s.setDate(now.getDate() - now.getDay())
      return { from: toISO(s), to: toISO(now) }
    }
    case 'month': {
      const s = new Date(now.getFullYear(), now.getMonth(), 1)
      return { from: toISO(s), to: toISO(now) }
    }
    case 'last_month': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const e = new Date(now.getFullYear(), now.getMonth(), 0)
      return { from: toISO(s), to: toISO(e) }
    }
    default: return { from: toISO(now), to: toISO(now) }
  }
}

const PERIOD_LABELS: Record<PeriodPreset, string> = {
  today: 'Hoy', yesterday: 'Ayer', week: 'Semana',
  month: 'Este mes', last_month: 'Mes ant.', custom: 'Rango',
}

const METHOD_LABELS: Record<string, string> = {
  efectivo: 'Efectivo', transferencia: 'Transferencia',
  tarjeta: 'Tarjeta', otro: 'Otro',
}
const METHOD_COLORS: Record<string, string> = {
  efectivo: '#22c55e', transferencia: '#60a5fa', tarjeta: '#a78bfa', otro: '#94a3b8',
}
const SOURCE_LABELS: Record<string, string> = {
  comprobante: 'Venta', pago_proveedor: 'Proveedor',
  expense: 'Gasto', create_expense_with_finance: 'Gasto', manual: 'Manual',
}
const HEALTH_CFG: Record<CheckStatus, { color: string; bg: string; label: string }> = {
  ok:       { color: '#34d399', bg: 'rgba(52,211,153,0.1)',   label: 'OK'       },
  low:      { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)',  label: 'Bajo'     },
  warning:  { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)',   label: 'Atención' },
  critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.1)',    label: 'Crítico'  },
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DailyChart({ data }: { data: DailySeries[] }) {
  if (!data.length) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 160, color: 'var(--text-subtle)', fontSize: '0.8rem' }}>
      Sin movimientos en el período
    </div>
  )
  const maxVal = Math.max(...data.flatMap(d => [d.income, d.expense]), 1)
  const W = 600; const H = 160; const pL = 52; const pR = 12; const pT = 12; const pB = 32
  const chartW = W - pL - pR; const chartH = H - pT - pB
  const slotW = chartW / data.length; const barW = Math.max(3, Math.min(18, slotW * 0.35))
  const gap = Math.max(1, slotW * 0.08)
  const yScale = (v: number) => chartH - (v / maxVal) * chartH
  const labelStep = Math.max(1, Math.ceil(data.length / 8))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} data-testid="finance-dashboard-daily-chart">
      {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
        const y = pT + yScale(maxVal * f)
        return <g key={i}>
          <line x1={pL} x2={W - pR} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="3 3" />
          {i > 0 && <text x={pL - 4} y={y + 4} textAnchor="end" style={{ fontSize: 9, fill: 'var(--text-subtle)', fontFamily: 'monospace' }}>{fmtShort(maxVal * f)}</text>}
        </g>
      })}
      {data.map((d, i) => {
        const cx = pL + i * slotW + slotW / 2
        return <g key={d.date}>
          <rect x={cx - barW - gap / 2} y={pT + yScale(d.income)} width={barW} height={Math.max(1, (d.income / maxVal) * chartH)} fill="rgba(34,197,94,0.7)" rx="2" />
          <rect x={cx + gap / 2} y={pT + yScale(d.expense)} width={barW} height={Math.max(1, (d.expense / maxVal) * chartH)} fill="rgba(239,68,68,0.65)" rx="2" />
          {i % labelStep === 0 && <text x={cx} y={H - 4} textAnchor="middle" style={{ fontSize: 8, fill: 'var(--text-subtle)', fontFamily: 'monospace' }}>{fmtDate(d.date)}</text>}
        </g>
      })}
      <g>
        <rect x={pL} y={2} width={8} height={8} fill="rgba(34,197,94,0.7)" rx="1" />
        <text x={pL + 11} y={10} style={{ fontSize: 9, fill: 'var(--text-muted)' }}>Ingresos</text>
        <rect x={pL + 68} y={2} width={8} height={8} fill="rgba(239,68,68,0.65)" rx="1" />
        <text x={pL + 79} y={10} style={{ fontSize: 9, fill: 'var(--text-muted)' }}>Egresos</text>
      </g>
    </svg>
  )
}

function SummaryCard({ label, value, color, icon, sub, testId }: {
  label: string; value: string; color: string
  icon: React.ReactNode; sub?: string; testId?: string
}) {
  return (
    <div data-testid={testId || 'finance-dashboard-summary-card'} style={{
      background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)',
      borderRadius: 'var(--radius-lg)', padding: '1rem 1.1rem',
      display: 'flex', alignItems: 'center', gap: '0.875rem',
    }}>
      <div style={{ width: 38, height: 38, borderRadius: 'var(--radius-md)', flexShrink: 0, background: color + '1a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color }}>{icon}</span>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.15rem' }}>{label}</div>
        <div style={{ fontSize: '1.15rem', fontWeight: 800, color, fontFamily: 'monospace', lineHeight: 1 }}>{value}</div>
        {sub && <div style={{ fontSize: '0.68rem', color: 'var(--text-subtle)', marginTop: '0.15rem' }}>{sub}</div>}
      </div>
    </div>
  )
}

function CashCard({ method, amount }: { method: string; amount: number }) {
  const color = METHOD_COLORS[method] || METHOD_COLORS.otro
  const label = METHOD_LABELS[method] || method
  const icon = method === 'efectivo' ? <Banknote size={16} />
    : method === 'transferencia' ? <ArrowUpRight size={16} />
    : method === 'tarjeta' ? <CreditCard size={16} />
    : <Wallet size={16} />
  return (
    <div style={{ background: 'var(--bg-card-solid)', border: `1px solid ${color}30`, borderLeft: `3px solid ${color}`, borderRadius: 'var(--radius-md)', padding: '0.875rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
        <span style={{ color }}>{icon}</span>
        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{label}</span>
      </div>
      <div style={{ fontSize: '1.2rem', fontWeight: 800, fontFamily: 'monospace', color: amount >= 0 ? color : '#ef4444' }}>{fmt(amount)}</div>
    </div>
  )
}

function MovRow({ m }: { m: LatestMovement }) {
  const isIncome   = m.type === 'income'  && m.sign === 1
  const isReversal = m.type === 'income'  && m.sign === -1
  const color = isIncome ? '#22c55e' : isReversal ? '#f59e0b' : '#ef4444'
  const prefix = isIncome ? '+' : '-'
  return (
    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.03)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <td style={{ padding: '0.55rem 1rem', fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtDate(m.date)}</td>
      <td style={{ padding: '0.55rem 1rem', fontSize: '0.8rem', color: 'var(--text-secondary)', maxWidth: 260 }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.description || '—'}</span>
        {m.comprobante_id && <Link to={`/comprobantes/${m.comprobante_id}`} style={{ fontSize: '0.65rem', color: 'var(--accent-primary)', opacity: 0.8 }}>Ver comprobante</Link>}
      </td>
      <td style={{ padding: '0.55rem 1rem' }}>
        <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '0.2rem', background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}>
          {SOURCE_LABELS[m.source] || m.source}
        </span>
      </td>
      <td style={{ padding: '0.55rem 1rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        {METHOD_LABELS[m.metodo_pago || ''] || m.metodo_pago || '—'}
      </td>
      <td style={{ padding: '0.55rem 1rem' }}>
        <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '0.2rem', background: isIncome ? 'rgba(34,197,94,0.1)' : isReversal ? 'rgba(245,158,11,0.1)' : 'rgba(239,68,68,0.1)', color }}>
          {isIncome ? 'Ingreso' : isReversal ? 'Reversa' : 'Egreso'}
        </span>
      </td>
      <td style={{ padding: '0.55rem 1rem', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', fontSize: '0.875rem', color, whiteSpace: 'nowrap' }}>
        {prefix}{fmt(m.amount_ars)}
      </td>
    </tr>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function FinanceDashboard() {
  const { businessId } = useAuth()

  // ── Tab ──
  const [activeTab, setActiveTab] = useState<FinanceTab>('resumen')

  // ── Period ──
  const [preset,     setPreset]     = useState<PeriodPreset>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo,   setCustomTo]   = useState('')

  // ── Data ──
  const [data,         setData]         = useState<DashboardData | null>(null)
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState<string | null>(null)
  const [movements,    setMovements]    = useState<LatestMovement[]>([])
  const [supplierDebt, setSupplierDebt] = useState(0)

  // ── Health check (lazy — only when Auditoría tab is visited) ──
  const [healthData,    setHealthData]    = useState<HealthResult | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthRan,     setHealthRan]     = useState(false)

  // ── Movements filter ──
  const [mvFilter, setMvFilter] = useState<'all' | 'income' | 'expense' | 'reversal'>('all')

  const { from, to } = preset === 'custom'
    ? { from: customFrom, to: customTo }
    : getDateRange(preset)

  // ── Main data load ──────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!businessId || !from || !to) return
    setLoading(true); setError(null)
    try {
      const [{ data: rpcData, error: rpcErr }, { data: mvmts }, { data: debt }] = await Promise.all([
        supabase.rpc('finance_dashboard_summary', { p_business_id: businessId, p_date_from: from, p_date_to: to }),
        supabase
          .from('financial_movements')
          .select('id,date,type,amount_ars,metodo_pago,description,source,sign,comprobante_id,created_at')
          .eq('business_id', businessId)
          .gte('date', from).lte('date', to)
          .order('created_at', { ascending: false }).limit(50),
        supabase
          .from('supplier_purchases')
          .select('pending_amount')
          .eq('business_id', businessId)
          .neq('payment_status', 'paid'),
      ])
      if (rpcErr) throw new Error(rpcErr.message)
      if (!rpcData?.ok) throw new Error(rpcData?.error || 'Error en RPC')
      setData(rpcData as DashboardData)
      setMovements((mvmts || []) as LatestMovement[])
      setSupplierDebt((debt || []).reduce((s: number, r: { pending_amount: number }) => s + (r.pending_amount || 0), 0))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error al cargar finanzas')
    } finally { setLoading(false) }
  }, [businessId, from, to])

  useEffect(() => { void load() }, [load])

  // ── Health check (loads once when Auditoría tab is opened) ─────────────────
  useEffect(() => {
    if (activeTab !== 'auditoria' || !businessId || healthRan) return
    setHealthLoading(true)
    void Promise.resolve(supabase.rpc('finance_health_check', { p_business_id: businessId }))
      .then(({ data: hd }) => { setHealthData(hd); setHealthRan(true) })
      .finally(() => setHealthLoading(false))
  }, [activeTab, businessId, healthRan])

  // ── Derived ────────────────────────────────────────────────────────────────
  const cashMethods = ['efectivo', 'transferencia', 'tarjeta', 'otro'].map(m => ({
    method: m,
    amount: m === 'otro'
      ? Object.entries(data?.cash_by_method || {})
          .filter(([k]) => !['efectivo', 'transferencia', 'tarjeta'].includes(k))
          .reduce((s, [, v]) => s + v, 0)
      : (data?.cash_by_method[m] || 0),
  }))

  const expMaxTotal = Math.max(...(data?.expenses_by_category || []).map(e => e.total), 1)
  const hasAlerts = (data?.alerts.critical ?? 0) + (data?.alerts.warning ?? 0) > 0

  const filteredMovements = useMemo(() => {
    if (mvFilter === 'all') return movements
    if (mvFilter === 'income')   return movements.filter(m => m.type === 'income'  && m.sign === 1)
    if (mvFilter === 'expense')  return movements.filter(m => m.type === 'expense')
    if (mvFilter === 'reversal') return movements.filter(m => m.type === 'income'  && m.sign === -1)
    return movements
  }, [movements, mvFilter])

  // ── Tab definitions ────────────────────────────────────────────────────────
  const TABS: { key: FinanceTab; label: string; icon: React.ReactNode }[] = [
    { key: 'resumen',     label: 'Resumen',      icon: <TrendingUp size={13} />   },
    { key: 'caja',        label: 'Caja',          icon: <Banknote size={13} />     },
    { key: 'ventas',      label: 'Ventas',        icon: <ShoppingCart size={13} /> },
    { key: 'gastos',      label: 'Gastos',        icon: <Activity size={13} />     },
    { key: 'movimientos', label: 'Movimientos',   icon: <FileText size={13} />     },
    { key: 'auditoria',   label: 'Auditoría',     icon: <ShieldCheck size={13} />  },
  ]

  // ── Period filter bar ──────────────────────────────────────────────────────
  const PeriodFilter = (
    <div data-testid="finance-dashboard-date-filter" style={{
      display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center',
      marginBottom: '1.5rem', padding: '0.625rem 1rem',
      background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)',
      borderRadius: 'var(--radius-md)',
    }}>
      <Calendar size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
      {(['today', 'yesterday', 'week', 'month', 'last_month'] as PeriodPreset[]).map(p => (
        <button key={p} onClick={() => setPreset(p)} style={{
          padding: '0.25rem 0.6rem', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem',
          fontWeight: 600, cursor: 'pointer',
          border: `1px solid ${preset === p ? 'rgba(99,102,241,0.5)' : 'var(--border-color)'}`,
          background: preset === p ? 'rgba(99,102,241,0.12)' : 'transparent',
          color: preset === p ? '#818cf8' : 'var(--text-muted)',
        }}>
          {PERIOD_LABELS[p]}
        </button>
      ))}
      <button onClick={() => setPreset('custom')} style={{
        padding: '0.25rem 0.6rem', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem',
        fontWeight: 600, cursor: 'pointer',
        border: `1px solid ${preset === 'custom' ? 'rgba(99,102,241,0.5)' : 'var(--border-color)'}`,
        background: preset === 'custom' ? 'rgba(99,102,241,0.12)' : 'transparent',
        color: preset === 'custom' ? '#818cf8' : 'var(--text-muted)',
      }}>Rango</button>
      {preset === 'custom' && (
        <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
          <input className="form-control" type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={{ width: 130, height: 30, fontSize: '0.75rem' }} />
          <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>—</span>
          <input className="form-control" type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={{ width: 130, height: 30, fontSize: '0.75rem' }} />
        </div>
      )}
      <div style={{ flex: 1 }} />
      <button className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading} style={{ flexShrink: 0 }}>
        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
      </button>
    </div>
  )

  return (
    <div className="page-shell" data-testid="finance-dashboard-page">

      {/* ── Header ── */}
      <div className="page-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div className="stat-icon" style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)' }}>
            <TrendingUp size={20} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 className="page-title">Finanzas</h1>
            <p className="page-subtitle">
              {data
                ? `${new Date(from + 'T12:00:00').toLocaleDateString('es-AR')} — ${new Date(to + 'T12:00:00').toLocaleDateString('es-AR')}`
                : 'Dashboard financiero unificado'}
            </p>
          </div>
        </div>
        <Link to="/finance/reports" className="btn btn-ghost btn-sm" style={{ color: 'var(--text-muted)' }}>
          <Settings size={13} /> Análisis P&L
        </Link>
      </div>

      {/* ── Tab bar ── */}
      <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: '1.5rem', gap: '0.125rem' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)} style={{
            display: 'flex', alignItems: 'center', gap: '0.375rem',
            padding: '0.625rem 0.875rem', border: 'none',
            borderBottom: `2px solid ${activeTab === t.key ? '#6366f1' : 'transparent'}`,
            background: 'none', color: activeTab === t.key ? '#818cf8' : 'var(--text-muted)',
            fontSize: '0.8rem', fontWeight: activeTab === t.key ? 700 : 500,
            cursor: 'pointer', transition: 'all 0.15s', borderRadius: '0.25rem 0.25rem 0 0',
          }}>
            {t.icon} {t.label}
            {t.key === 'auditoria' && hasAlerts && (
              <span style={{ padding: '0.05rem 0.35rem', borderRadius: '9999px', fontSize: '0.6rem', fontWeight: 800, background: (data?.alerts.critical ?? 0) > 0 ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)', color: (data?.alerts.critical ?? 0) > 0 ? '#ef4444' : '#f59e0b' }}>
                {(data?.alerts.critical ?? 0) + (data?.alerts.warning ?? 0)}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Error ── */}
      {error && <div className="alert alert-error" style={{ marginBottom: '1.5rem' }}>{error}</div>}

      {loading && !data && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 280, gap: '0.75rem', color: 'var(--text-muted)' }}>
          <RefreshCw size={22} className="animate-spin" style={{ color: '#818cf8' }} />
          <span style={{ fontSize: '0.875rem' }}>Calculando…</span>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* TAB: RESUMEN                                                          */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'resumen' && (
        <>
          {PeriodFilter}

          {data && (
            <>
              {/* Alerts */}
              {hasAlerts && (
                <div data-testid="finance-dashboard-health-alert" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.25rem' }}>
                  {(data.alerts.critical > 0) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.75rem 1rem', borderRadius: 'var(--radius-md)', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
                      <AlertCircle size={15} style={{ color: '#ef4444', flexShrink: 0 }} />
                      <span style={{ flex: 1, color: '#fca5a5', fontSize: '0.875rem' }}><strong>{data.alerts.critical}</strong> problema{data.alerts.critical > 1 ? 's' : ''} crítico{data.alerts.critical > 1 ? 's' : ''} de integridad detectado{data.alerts.critical > 1 ? 's' : ''}.</span>
                      <button onClick={() => setActiveTab('auditoria')} className="btn btn-ghost btn-sm" style={{ flexShrink: 0, color: '#ef4444' }}>Ver <ChevronRight size={12} /></button>
                    </div>
                  )}
                  {(data.alerts.warning > 0) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.75rem 1rem', borderRadius: 'var(--radius-md)', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
                      <AlertTriangle size={15} style={{ color: '#f59e0b', flexShrink: 0 }} />
                      <span style={{ flex: 1, color: '#fcd34d', fontSize: '0.875rem' }}>Hay facturas de proveedores pendientes de pago.</span>
                      <Link to="/suppliers" className="btn btn-ghost btn-sm" style={{ flexShrink: 0, color: '#f59e0b' }}>Proveedores <ChevronRight size={12} /></Link>
                    </div>
                  )}
                </div>
              )}

              {/* Summary cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.875rem', marginBottom: '0.875rem' }}>
                <SummaryCard testId="finance-dashboard-income-card" label="Ingresos brutos" value={fmtShort(data.summary.gross_income)} color="#22c55e" icon={<TrendingUp size={17} />} sub={data.top_payment_methods[0] ? (METHOD_LABELS[data.top_payment_methods[0].method] || data.top_payment_methods[0].method) + ' principal' : undefined} />
                <SummaryCard testId="finance-dashboard-expense-card" label="Egresos" value={fmtShort(data.summary.expenses)} color="#ef4444" icon={<TrendingDown size={17} />} sub={`Proveedores: ${fmtShort(data.summary.supplier_payments)}`} />
                <SummaryCard testId="finance-dashboard-net-card" label="Resultado neto" value={fmtShort(data.summary.net_result)} color={data.summary.net_result >= 0 ? '#34d399' : '#ef4444'} icon={data.summary.net_result >= 0 ? <ArrowUpRight size={17} /> : <ArrowDownRight size={17} />} sub={data.summary.net_result >= 0 ? 'Superávit' : 'Déficit'} />
                <SummaryCard label="Ventas cobradas" value={fmtShort(data.sales.total_collected)} color="#818cf8" icon={<Receipt size={17} />} sub={`${data.sales.count} comprobante${data.sales.count !== 1 ? 's' : ''}`} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.875rem', marginBottom: '1.5rem' }}>
                {data.summary.credit_notes_total > 0 && <SummaryCard label="NC / Reversas" value={fmtShort(data.summary.credit_notes_total)} color="#f59e0b" icon={<RotateCcw size={17} />} sub={`${data.sales.nc_count} nota${data.sales.nc_count !== 1 ? 's' : ''}`} />}
                <SummaryCard label="Pendiente ventas" value={fmtShort(data.sales.pending_total)} color={data.sales.pending_total > 0 ? '#f87171' : '#34d399'} icon={<DollarSign size={17} />} sub="Saldo por cobrar" />
                {supplierDebt > 0 && <SummaryCard label="Deuda proveedores" value={fmtShort(supplierDebt)} color="#fb923c" icon={<Truck size={17} />} sub="Pendiente total" />}
                <SummaryCard label={hasAlerts ? 'Alertas activas' : 'Auditoría'} value={hasAlerts ? String(data.alerts.critical + data.alerts.warning) : 'OK'} color={data.alerts.critical > 0 ? '#ef4444' : data.alerts.warning > 0 ? '#f59e0b' : '#34d399'} icon={<ShieldCheck size={17} />} sub={hasAlerts ? 'Ver auditoría' : 'Sin problemas'} />
              </div>

              {/* Cash by method */}
              <div data-testid="finance-dashboard-cash-methods" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.875rem', marginBottom: '1.5rem' }}>
                {cashMethods.map(({ method, amount }) => <CashCard key={method} method={method} amount={amount} />)}
              </div>

              {/* Charts */}
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
                <div style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '1.25rem' }}>
                  <h3 style={{ margin: '0 0 0.875rem', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ingresos vs Egresos diarios</h3>
                  <DailyChart data={data.daily_series} />
                </div>
                <div style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '1.25rem' }}>
                  <h3 style={{ margin: '0 0 0.875rem', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Egresos por categoría</h3>
                  {data.expenses_by_category.length === 0
                    ? <p style={{ color: 'var(--text-subtle)', fontSize: '0.8rem', margin: 0 }}>Sin egresos registrados.</p>
                    : <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                        {data.expenses_by_category.map(({ category, total }) => (
                          <div key={category}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.15rem' }}>
                              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{category}</span>
                              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{fmtShort(total)}</span>
                            </div>
                            <div style={{ height: 5, borderRadius: 9999, background: 'var(--bg-hover)', overflow: 'hidden' }}>
                              <div style={{ height: '100%', borderRadius: 9999, width: `${(total / expMaxTotal) * 100}%`, background: 'linear-gradient(90deg,#f59e0b,#ef4444)' }} />
                            </div>
                          </div>
                        ))}
                      </div>
                  }
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* TAB: CAJA                                                             */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'caja' && (
        <>
          {PeriodFilter}
          {data && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
                {cashMethods.map(({ method, amount }) => <CashCard key={method} method={method} amount={amount} />)}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
                {[
                  { label: 'Total ingresos', value: fmtShort(data.summary.gross_income), color: '#22c55e' },
                  { label: 'Total egresos',  value: fmtShort(data.summary.expenses),     color: '#ef4444' },
                  { label: 'Resultado neto', value: fmtShort(data.summary.net_result),   color: data.summary.net_result >= 0 ? '#34d399' : '#ef4444' },
                ].map(c => (
                  <div key={c.label} style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '1rem' }}>
                    <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.3rem' }}>{c.label}</div>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800, fontFamily: 'monospace', color: c.color }}>{c.value}</div>
                  </div>
                ))}
              </div>
              <div style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
                <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginRight: '0.25rem' }}>Filtro:</span>
                  {(['all', 'income', 'expense', 'reversal'] as const).map(f => (
                    <button key={f} onClick={() => setMvFilter(f)} style={{ padding: '0.2rem 0.6rem', borderRadius: 'var(--radius-sm)', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', border: `1px solid ${mvFilter === f ? 'rgba(99,102,241,0.5)' : 'var(--border-color)'}`, background: mvFilter === f ? 'rgba(99,102,241,0.12)' : 'transparent', color: mvFilter === f ? '#818cf8' : 'var(--text-muted)' }}>
                      {f === 'all' ? 'Todos' : f === 'income' ? 'Ingresos' : f === 'expense' ? 'Egresos' : 'Reversas'}
                    </button>
                  ))}
                  <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-subtle)' }}>{filteredMovements.length} registros</span>
                </div>
                <MovimientosTable movements={filteredMovements} />
              </div>
            </>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* TAB: VENTAS                                                           */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'ventas' && (
        <>
          {PeriodFilter}
          {data && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                {[
                  { label: 'Comprobantes',      value: data.sales.count,           color: '#818cf8' },
                  { label: 'Ventas locales',     value: data.sales.local_count,     color: '#60a5fa' },
                  { label: 'ARCA emitidas',      value: data.sales.arca_count,      color: '#34d399' },
                  { label: 'NC / Anuladas',      value: data.sales.nc_count,        color: '#f59e0b' },
                  { label: 'Cobrado',            value: fmt(data.sales.total_collected), color: '#22c55e', isStr: true },
                  { label: 'Pendiente',          value: fmt(data.sales.pending_total),   color: data.sales.pending_total > 0 ? '#f87171' : '#34d399', isStr: true },
                ].map((item, i) => (
                  <div key={i} style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '1rem' }}>
                    <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.3rem' }}>{item.label}</div>
                    <div style={{ fontSize: item.isStr ? '1rem' : '1.75rem', fontWeight: 800, color: item.color, fontFamily: 'monospace' }}>{item.value}</div>
                  </div>
                ))}
              </div>
              {data.summary.credit_notes_total > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.875rem 1rem', borderRadius: 'var(--radius-md)', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', marginBottom: '1rem' }}>
                  <RotateCcw size={15} style={{ color: '#f59e0b' }} />
                  <span style={{ color: '#fcd34d', fontSize: '0.875rem' }}>
                    NC / Reversas del período: <strong>{fmt(data.summary.credit_notes_total)}</strong> — no contabilizadas como venta positiva.
                  </span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Link to="/comprobantes" className="btn btn-ghost btn-sm">Ver todos los comprobantes <ChevronRight size={12} /></Link>
              </div>

              {/* Movements filtered to income */}
              <div style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginTop: '1.25rem' }}>
                <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border-subtle)' }}>
                  <h3 style={{ margin: 0, fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Movimientos de ventas</h3>
                </div>
                <MovimientosTable movements={movements.filter(m => m.type === 'income' && m.sign === 1 && m.source === 'comprobante')} />
              </div>
            </>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* TAB: GASTOS                                                           */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'gastos' && (
        <>
          {PeriodFilter}
          {data && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
                {[
                  { label: 'Total egresos', value: fmtShort(data.summary.expenses), color: '#ef4444' },
                  { label: 'Pagos a proveedores', value: fmtShort(data.summary.supplier_payments), color: '#fb923c' },
                  { label: 'Deuda proveedores', value: fmtShort(supplierDebt), color: supplierDebt > 0 ? '#f87171' : '#34d399' },
                ].map(c => (
                  <div key={c.label} style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '1rem' }}>
                    <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.3rem' }}>{c.label}</div>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800, fontFamily: 'monospace', color: c.color }}>{c.value}</div>
                  </div>
                ))}
              </div>

              {data.expenses_by_category.length > 0 && (
                <div style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '1.25rem', marginBottom: '1.25rem' }}>
                  <h3 style={{ margin: '0 0 1rem', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Distribución por categoría</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {data.expenses_by_category.map(({ category, total }) => (
                      <div key={category} style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600, minWidth: 160 }}>{category}</span>
                        <div style={{ flex: 1, height: 8, borderRadius: 9999, background: 'var(--bg-hover)', overflow: 'hidden' }}>
                          <div style={{ height: '100%', borderRadius: 9999, width: `${(total / expMaxTotal) * 100}%`, background: 'linear-gradient(90deg,#f59e0b,#ef4444)' }} />
                        </div>
                        <span style={{ fontSize: '0.82rem', fontFamily: 'monospace', color: 'var(--text-secondary)', fontWeight: 600, minWidth: 80, textAlign: 'right' }}>{fmtShort(total)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <Link to="/suppliers" className="btn btn-ghost btn-sm"><Truck size={13} /> Ver proveedores</Link>
                <Link to="/expenses" className="btn btn-ghost btn-sm">Ver gastos</Link>
                <Link to="/finance/reports" className="btn btn-ghost btn-sm">Análisis P&L completo <ChevronRight size={12} /></Link>
              </div>

              <div style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginTop: '1.25rem' }}>
                <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border-subtle)' }}>
                  <h3 style={{ margin: 0, fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Movimientos de egresos</h3>
                </div>
                <MovimientosTable movements={movements.filter(m => m.type === 'expense')} />
              </div>
            </>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* TAB: MOVIMIENTOS                                                      */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'movimientos' && (
        <>
          {PeriodFilter}
          <div data-testid="finance-dashboard-latest-movements" style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
            <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginRight: '0.25rem' }}>Filtrar:</span>
              {(['all', 'income', 'expense', 'reversal'] as const).map(f => (
                <button key={f} onClick={() => setMvFilter(f)} style={{ padding: '0.2rem 0.6rem', borderRadius: 'var(--radius-sm)', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', border: `1px solid ${mvFilter === f ? 'rgba(99,102,241,0.5)' : 'var(--border-color)'}`, background: mvFilter === f ? 'rgba(99,102,241,0.12)' : 'transparent', color: mvFilter === f ? '#818cf8' : 'var(--text-muted)' }}>
                  {f === 'all' ? 'Todos' : f === 'income' ? 'Ingresos' : f === 'expense' ? 'Egresos' : 'Reversas'}
                </button>
              ))}
              <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-subtle)' }}>{filteredMovements.length} registros</span>
            </div>
            <MovimientosTable movements={filteredMovements} />
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* TAB: AUDITORÍA                                                        */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'auditoria' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              16 checks de integridad financiera y fiscal.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => { setHealthRan(false) }} disabled={healthLoading}>
                <RefreshCw size={13} className={healthLoading ? 'animate-spin' : ''} /> Re-ejecutar
              </button>
              <Link to="/finance/health" className="btn btn-ghost btn-sm">Ver página completa <ChevronRight size={12} /></Link>
            </div>
          </div>

          {healthLoading && !healthData && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200, gap: '0.75rem', color: 'var(--text-muted)' }}>
              <RefreshCw size={22} className="animate-spin" style={{ color: '#818cf8' }} />
              <span>Ejecutando 16 checks…</span>
            </div>
          )}

          {!healthData && !healthLoading && (
            <div style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
              <ShieldCheck size={36} style={{ color: '#818cf8', margin: '0 auto 1rem', display: 'block' }} />
              <p style={{ margin: '0 0 1rem' }}>Haz clic en "Re-ejecutar" para correr la auditoría.</p>
              <button className="btn btn-primary" onClick={() => { setHealthRan(false) }}>Ejecutar auditoría</button>
            </div>
          )}

          {healthData && (
            <>
              {/* Summary */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
                {[
                  { label: 'Total issues',  value: healthData.total_issues,    color: healthData.ok ? '#34d399' : '#ef4444' },
                  { label: 'Críticos',      value: healthData.critical_count,  color: '#ef4444' },
                  { label: 'Advertencias',  value: healthData.warning_count,   color: '#f59e0b' },
                  { label: 'Bajos',         value: healthData.low_count,       color: '#64748b' },
                ].map(c => (
                  <div key={c.label} style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '0.875rem 1rem', display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
                    <div style={{ width: 36, height: 36, borderRadius: 'var(--radius-md)', background: c.color + '1a', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {c.label === 'Críticos' ? <AlertCircle size={16} style={{ color: c.color }} />
                        : c.label === 'Advertencias' ? <AlertTriangle size={16} style={{ color: c.color }} />
                        : c.label === 'Bajos' ? <Info size={16} style={{ color: c.color }} />
                        : <ShieldCheck size={16} style={{ color: c.color }} />}
                    </div>
                    <div>
                      <div style={{ fontSize: '1.4rem', fontWeight: 800, color: c.color }}>{c.value}</div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{c.label}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Check list */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {healthData.checks.sort((a, b) => {
                  const ord = { critical: 0, warning: 1, low: 2, ok: 3 }
                  return (ord[a.status] ?? 4) - (ord[b.status] ?? 4)
                }).map(check => {
                  const cfg = HEALTH_CFG[check.status]
                  return (
                    <div key={check.id} style={{ background: 'var(--bg-card-solid)', border: `1px solid ${check.status === 'ok' ? 'var(--border-color)' : cfg.bg}`, borderRadius: 'var(--radius-md)', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
                      <span style={{ padding: '0.15rem 0.5rem', borderRadius: '9999px', fontSize: '0.65rem', fontWeight: 700, color: cfg.color, background: cfg.bg, flexShrink: 0 }}>
                        {check.status === 'ok' ? <CheckCircle2 size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 2 }} /> : check.status === 'critical' ? <AlertCircle size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 2 }} /> : null}
                        {cfg.label}
                      </span>
                      <span style={{ flex: 1, fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>{check.title}</span>
                      {check.count > 0 && <span style={{ fontSize: '0.75rem', fontWeight: 800, color: cfg.color, background: cfg.bg, padding: '0.1rem 0.4rem', borderRadius: '9999px' }}>{check.count}</span>}
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{check.description}</span>
                    </div>
                  )
                })}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
                <Link to="/finance/health" className="btn btn-ghost btn-sm">Auditoría completa con detalle expandible <ChevronRight size={12} /></Link>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Shared movements table (used by multiple tabs) ───────────────────────────

function MovimientosTable({ movements }: { movements: LatestMovement[] }) {
  if (movements.length === 0) return (
    <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>Sin movimientos en el período.</div>
  )
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
          {['Fecha', 'Descripción', 'Fuente', 'Método', 'Tipo', 'Monto'].map(h => (
            <th key={h} style={{ padding: '0.5rem 1rem', fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: h === 'Monto' ? 'right' : 'left', borderBottom: '1px solid var(--border-subtle)' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {movements.map(m => <MovRow key={m.id} m={m} />)}
      </tbody>
    </table>
  )
}

