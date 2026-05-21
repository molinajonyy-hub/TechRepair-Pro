import { useState, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  RefreshCw, TrendingUp, TrendingDown, DollarSign, ShieldCheck,
  AlertCircle, AlertTriangle, ArrowUpRight, ArrowDownRight,
  CreditCard, Banknote, Wallet, RotateCcw, Truck, Receipt,
  Calendar, ChevronRight,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

// ─── Types ────────────────────────────────────────────────────────────────────

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
  today:      'Hoy',
  yesterday:  'Ayer',
  week:       'Esta semana',
  month:      'Este mes',
  last_month: 'Mes anterior',
  custom:     'Personalizado',
}

const METHOD_LABELS: Record<string, string> = {
  efectivo: 'Efectivo', transferencia: 'Transferencia',
  tarjeta:  'Tarjeta',  otro: 'Otro',
}

const METHOD_COLORS: Record<string, string> = {
  efectivo:      '#22c55e',
  transferencia: '#60a5fa',
  tarjeta:       '#a78bfa',
  otro:          '#94a3b8',
}

const SOURCE_LABELS: Record<string, string> = {
  comprobante:           'Venta',
  pago_proveedor:        'Proveedor',
  expense:               'Gasto',
  create_expense_with_finance: 'Gasto',
  manual:                'Manual',
}

// ─── Daily bar chart ──────────────────────────────────────────────────────────

function DailyChart({ data }: { data: DailySeries[] }) {
  if (!data.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 160, color: 'var(--text-subtle)', fontSize: '0.8rem' }}>
        Sin movimientos en el período
      </div>
    )
  }

  const maxVal = Math.max(...data.flatMap(d => [d.income, d.expense]), 1)
  const W = 600; const H = 160
  const pL = 52; const pR = 12; const pT = 12; const pB = 32
  const chartW = W - pL - pR
  const chartH = H - pT - pB
  const slotW  = chartW / data.length
  const barW   = Math.max(3, Math.min(18, slotW * 0.35))
  const gap    = Math.max(1, slotW * 0.08)
  const yScale = (v: number) => chartH - (v / maxVal) * chartH
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f => maxVal * f)

  // Show at most 8 date labels
  const labelStep = Math.max(1, Math.ceil(data.length / 8))

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
      data-testid="finance-dashboard-daily-chart"
    >
      {/* Grid lines */}
      {gridLines.map((v, i) => {
        const y = pT + yScale(v)
        return (
          <g key={i}>
            <line x1={pL} x2={W - pR} y1={y} y2={y}
              stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="3 3" />
            {i > 0 && (
              <text x={pL - 4} y={y + 4} textAnchor="end"
                style={{ fontSize: 9, fill: 'var(--text-subtle)', fontFamily: 'monospace' }}>
                {fmtShort(v)}
              </text>
            )}
          </g>
        )
      })}

      {/* Bars */}
      {data.map((d, i) => {
        const cx = pL + i * slotW + slotW / 2
        const incH = (d.income / maxVal) * chartH
        const expH = (d.expense / maxVal) * chartH
        return (
          <g key={d.date}>
            {/* Income bar */}
            <rect
              x={cx - barW - gap / 2}
              y={pT + yScale(d.income)}
              width={barW} height={Math.max(1, incH)}
              fill="rgba(34,197,94,0.7)" rx="2"
            />
            {/* Expense bar */}
            <rect
              x={cx + gap / 2}
              y={pT + yScale(d.expense)}
              width={barW} height={Math.max(1, expH)}
              fill="rgba(239,68,68,0.65)" rx="2"
            />
            {/* X label */}
            {i % labelStep === 0 && (
              <text
                x={cx} y={H - 4} textAnchor="middle"
                style={{ fontSize: 8, fill: 'var(--text-subtle)', fontFamily: 'monospace' }}>
                {fmtDate(d.date)}
              </text>
            )}
          </g>
        )
      })}

      {/* Legend */}
      <g>
        <rect x={pL} y={2} width={8} height={8} fill="rgba(34,197,94,0.7)" rx="1" />
        <text x={pL + 11} y={10} style={{ fontSize: 9, fill: 'var(--text-muted)' }}>Ingresos</text>
        <rect x={pL + 68} y={2} width={8} height={8} fill="rgba(239,68,68,0.65)" rx="1" />
        <text x={pL + 79} y={10} style={{ fontSize: 9, fill: 'var(--text-muted)' }}>Egresos</text>
      </g>
    </svg>
  )
}

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({
  label, value, color, icon, sub, testId,
}: {
  label: string; value: string; color: string
  icon: React.ReactNode; sub?: string; testId?: string
}) {
  return (
    <div
      data-testid={testId || 'finance-dashboard-summary-card'}
      style={{
        background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-lg)', padding: '1.1rem 1.25rem',
        display: 'flex', alignItems: 'center', gap: '1rem',
      }}
    >
      <div style={{
        width: 40, height: 40, borderRadius: 'var(--radius-md)', flexShrink: 0,
        background: color + '1a', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ color }}>{icon}</span>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.2rem' }}>
          {label}
        </div>
        <div style={{ fontSize: '1.2rem', fontWeight: 800, color, fontFamily: 'monospace', lineHeight: 1 }}>
          {value}
        </div>
        {sub && <div style={{ fontSize: '0.7rem', color: 'var(--text-subtle)', marginTop: '0.2rem' }}>{sub}</div>}
      </div>
    </div>
  )
}

// ─── Cash method card ─────────────────────────────────────────────────────────

function CashCard({ method, amount }: { method: string; amount: number }) {
  const color = METHOD_COLORS[method] || METHOD_COLORS.otro
  const label = METHOD_LABELS[method] || method
  const icon = method === 'efectivo' ? <Banknote size={16} />
    : method === 'transferencia' ? <ArrowUpRight size={16} />
    : method === 'tarjeta' ? <CreditCard size={16} />
    : <Wallet size={16} />

  return (
    <div style={{
      background: 'var(--bg-card-solid)', border: `1px solid ${color}30`,
      borderLeft: `3px solid ${color}`, borderRadius: 'var(--radius-md)',
      padding: '0.875rem 1rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
        <span style={{ color }}>{icon}</span>
        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: '1.25rem', fontWeight: 800, fontFamily: 'monospace', color: amount >= 0 ? color : '#ef4444' }}>
        {fmt(amount)}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function FinanceDashboard() {
  const { businessId } = useAuth()

  const [preset, setPreset] = useState<PeriodPreset>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo,   setCustomTo]   = useState('')
  const [data,    setData]    = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [movements, setMovements] = useState<LatestMovement[]>([])
  const [supplierDebt, setSupplierDebt] = useState(0)

  const { from, to } = preset === 'custom'
    ? { from: customFrom, to: customTo }
    : getDateRange(preset)

  const load = useCallback(async () => {
    if (!businessId || !from || !to) return
    setLoading(true); setError(null)
    try {
      const [{ data: rpcData, error: rpcErr }, { data: mvmts }, { data: debt }] = await Promise.all([
        supabase.rpc('finance_dashboard_summary', {
          p_business_id: businessId,
          p_date_from:   from,
          p_date_to:     to,
        }),
        supabase
          .from('financial_movements')
          .select('id,date,type,amount_ars,metodo_pago,description,source,sign,comprobante_id')
          .eq('business_id', businessId)
          .gte('date', from).lte('date', to)
          .order('created_at', { ascending: false })
          .limit(20),
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
      setError(e instanceof Error ? e.message : 'Error al cargar dashboard')
    } finally {
      setLoading(false)
    }
  }, [businessId, from, to])

  useEffect(() => { void load() }, [load])

  // ── Derived cash-method totals (ensure 4 main methods always visible) ──────
  const cashMethods = ['efectivo', 'transferencia', 'tarjeta', 'otro'].map(m => ({
    method: m,
    amount: (data?.cash_by_method[m] || 0) +
      // merge any unlisted methods into 'otro'
      (m === 'otro' ? Object.entries(data?.cash_by_method || {})
        .filter(([k]) => !['efectivo','transferencia','tarjeta'].includes(k))
        .reduce((s, [,v]) => s + v, 0) - (data?.cash_by_method['otro'] || 0)
       + (data?.cash_by_method['otro'] || 0)
        : 0),
  }))

  const hasAlerts = (data?.alerts.critical ?? 0) + (data?.alerts.warning ?? 0) > 0

  const expMaxTotal = Math.max(...(data?.expenses_by_category || []).map(e => e.total), 1)

  return (
    <div className="page-shell" data-testid="finance-dashboard-page">

      {/* ── Header ── */}
      <div className="page-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div className="stat-icon" style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)' }}>
            <TrendingUp size={20} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 className="page-title">Dashboard Financiero</h1>
            <p className="page-subtitle">
              {data
                ? `${new Date(from + 'T12:00:00').toLocaleDateString('es-AR')} — ${new Date(to + 'T12:00:00').toLocaleDateString('es-AR')}`
                : 'Resumen de caja y finanzas'}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <Link to="/finance/reports" className="btn btn-ghost btn-sm">Análisis P&L</Link>
          <button className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── Period filter ── */}
      <div
        data-testid="finance-dashboard-date-filter"
        style={{
          display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center',
          marginBottom: '1.5rem', padding: '0.75rem 1rem',
          background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <Calendar size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        {(['today','yesterday','week','month','last_month'] as PeriodPreset[]).map(p => (
          <button
            key={p}
            onClick={() => setPreset(p)}
            style={{
              padding: '0.3rem 0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.78rem',
              fontWeight: 600, cursor: 'pointer',
              border: `1px solid ${preset === p ? 'rgba(99,102,241,0.5)' : 'var(--border-color)'}`,
              background: preset === p ? 'rgba(99,102,241,0.12)' : 'transparent',
              color: preset === p ? '#818cf8' : 'var(--text-muted)',
            }}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
        <button
          onClick={() => setPreset('custom')}
          style={{
            padding: '0.3rem 0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.78rem',
            fontWeight: 600, cursor: 'pointer',
            border: `1px solid ${preset === 'custom' ? 'rgba(99,102,241,0.5)' : 'var(--border-color)'}`,
            background: preset === 'custom' ? 'rgba(99,102,241,0.12)' : 'transparent',
            color: preset === 'custom' ? '#818cf8' : 'var(--text-muted)',
          }}
        >
          Rango
        </button>
        {preset === 'custom' && (
          <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
            <input className="form-control" type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
              style={{ width: 140, height: 32, fontSize: '0.78rem' }} />
            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>—</span>
            <input className="form-control" type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
              style={{ width: 140, height: 32, fontSize: '0.78rem' }} />
          </div>
        )}
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="alert alert-error" style={{ marginBottom: '1.5rem' }}>{error}</div>
      )}

      {/* ── Loading skeleton ── */}
      {loading && !data && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300, gap: '0.75rem', color: 'var(--text-muted)' }}>
          <RefreshCw size={24} className="animate-spin" style={{ color: '#818cf8' }} />
          <span>Calculando…</span>
        </div>
      )}

      {data && (
        <>
          {/* ── Health alerts ── */}
          {hasAlerts && (
            <div data-testid="finance-dashboard-health-alert" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem' }}>
              {data.alerts.critical > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.75rem 1rem', borderRadius: 'var(--radius-md)', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
                  <AlertCircle size={16} style={{ color: '#ef4444', flexShrink: 0 }} />
                  <span style={{ flex: 1, color: '#fca5a5', fontSize: '0.875rem' }}>
                    <strong>{data.alerts.critical}</strong> problema{data.alerts.critical > 1 ? 's' : ''} crítico{data.alerts.critical > 1 ? 's' : ''} de integridad financiera detectado{data.alerts.critical > 1 ? 's' : ''}.
                  </span>
                  <Link to="/finance/health" className="btn btn-ghost btn-sm" style={{ flexShrink: 0, color: '#ef4444' }}>
                    Ver auditoría <ChevronRight size={12} />
                  </Link>
                </div>
              )}
              {data.alerts.warning > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.75rem 1rem', borderRadius: 'var(--radius-md)', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
                  <AlertTriangle size={16} style={{ color: '#f59e0b', flexShrink: 0 }} />
                  <span style={{ flex: 1, color: '#fcd34d', fontSize: '0.875rem' }}>
                    Hay facturas de proveedores pendientes de pago.
                  </span>
                  <Link to="/suppliers" className="btn btn-ghost btn-sm" style={{ flexShrink: 0, color: '#f59e0b' }}>
                    Ver proveedores <ChevronRight size={12} />
                  </Link>
                </div>
              )}
            </div>
          )}

          {/* ── Summary cards — row 1 ── */}
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1rem' }}
          >
            <SummaryCard
              testId="finance-dashboard-income-card"
              label="Ingresos brutos"
              value={fmtShort(data.summary.gross_income)}
              color="#22c55e"
              icon={<TrendingUp size={18} />}
              sub={`${(data.top_payment_methods[0]?.method ? METHOD_LABELS[data.top_payment_methods[0].method] || data.top_payment_methods[0].method : '—')} principal`}
            />
            <SummaryCard
              testId="finance-dashboard-expense-card"
              label="Egresos"
              value={fmtShort(data.summary.expenses)}
              color="#ef4444"
              icon={<TrendingDown size={18} />}
              sub={`Proveedores: ${fmtShort(data.summary.supplier_payments)}`}
            />
            <SummaryCard
              testId="finance-dashboard-net-card"
              label="Resultado neto"
              value={fmtShort(data.summary.net_result)}
              color={data.summary.net_result >= 0 ? '#34d399' : '#ef4444'}
              icon={data.summary.net_result >= 0 ? <ArrowUpRight size={18} /> : <ArrowDownRight size={18} />}
              sub={data.summary.net_result >= 0 ? 'Superávit' : 'Déficit'}
            />
            <SummaryCard
              label="Ventas cobradas"
              value={fmtShort(data.sales.total_collected)}
              color="#818cf8"
              icon={<Receipt size={18} />}
              sub={`${data.sales.count} comprobante${data.sales.count !== 1 ? 's' : ''}`}
            />
          </div>

          {/* ── Summary cards — row 2 ── */}
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.75rem' }}
          >
            {data.summary.credit_notes_total > 0 && (
              <SummaryCard
                label="NC / Reversas"
                value={fmtShort(data.summary.credit_notes_total)}
                color="#f59e0b"
                icon={<RotateCcw size={18} />}
                sub={`${data.sales.nc_count} nota${data.sales.nc_count !== 1 ? 's' : ''} de crédito`}
              />
            )}
            <SummaryCard
              label="Pendiente ventas"
              value={fmtShort(data.sales.pending_total)}
              color={data.sales.pending_total > 0 ? '#f87171' : '#34d399'}
              icon={<DollarSign size={18} />}
              sub="Saldo por cobrar"
            />
            {supplierDebt > 0 && (
              <SummaryCard
                label="Deuda proveedores"
                value={fmtShort(supplierDebt)}
                color="#fb923c"
                icon={<Truck size={18} />}
                sub="Total pendiente"
              />
            )}
            <SummaryCard
              label={hasAlerts ? 'Alertas activas' : 'Auditoría'}
              value={hasAlerts ? String(data.alerts.critical + data.alerts.warning) : 'OK'}
              color={data.alerts.critical > 0 ? '#ef4444' : data.alerts.warning > 0 ? '#f59e0b' : '#34d399'}
              icon={<ShieldCheck size={18} />}
              sub={hasAlerts ? 'Ver auditoría' : 'Sin problemas'}
            />
          </div>

          {/* ── Cash by method ── */}
          <div
            data-testid="finance-dashboard-cash-methods"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.875rem', marginBottom: '1.75rem' }}
          >
            {cashMethods.map(({ method, amount }) => (
              <CashCard key={method} method={method} amount={amount} />
            ))}
          </div>

          {/* ── Charts row ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1rem', marginBottom: '1.75rem' }}>

            {/* Daily bar chart */}
            <div style={{
              background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-lg)', padding: '1.25rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Ingresos vs Egresos por día
                </h3>
              </div>
              <DailyChart data={data.daily_series} />
            </div>

            {/* Expenses by category */}
            <div style={{
              background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-lg)', padding: '1.25rem',
            }}>
              <h3 style={{ margin: '0 0 1rem', fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Egresos por categoría
              </h3>
              {data.expenses_by_category.length === 0 ? (
                <p style={{ color: 'var(--text-subtle)', fontSize: '0.8rem', margin: 0 }}>Sin egresos registrados.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                  {data.expenses_by_category.map(({ category, total }) => (
                    <div key={category}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                          {category}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                          {fmtShort(total)}
                        </span>
                      </div>
                      <div style={{ height: 5, borderRadius: 9999, background: 'var(--bg-hover)', overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', borderRadius: 9999,
                          width: `${(total / expMaxTotal) * 100}%`,
                          background: 'linear-gradient(90deg, #f59e0b, #ef4444)',
                        }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Sales breakdown ── */}
          <div style={{
            background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)', padding: '1.25rem', marginBottom: '1.75rem',
          }}>
            <h3 style={{ margin: '0 0 1rem', fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Ventas del período
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem' }}>
              {[
                { label: 'Total comprobantes', value: data.sales.count,        color: '#818cf8' },
                { label: 'Locales',             value: data.sales.local_count,  color: '#60a5fa' },
                { label: 'ARCA emitidas',        value: data.sales.arca_count,   color: '#34d399' },
                { label: 'NC / Anuladas',         value: data.sales.nc_count,    color: '#f59e0b' },
                { label: 'Cobrado',  value: fmt(data.sales.total_collected),     color: '#22c55e', isStr: true },
                { label: 'Pendiente',value: fmt(data.sales.pending_total),       color: data.sales.pending_total > 0 ? '#f87171' : '#34d399', isStr: true },
              ].map((item, i) => (
                <div key={i} style={{
                  background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)', padding: '0.75rem',
                }}>
                  <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.3rem' }}>
                    {item.label}
                  </div>
                  <div style={{ fontSize: item.isStr ? '1rem' : '1.5rem', fontWeight: 800, color: item.color, fontFamily: 'monospace' }}>
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Latest movements ── */}
          <div
            data-testid="finance-dashboard-latest-movements"
            style={{
              background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-lg)', overflow: 'hidden',
            }}
          >
            <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Últimos movimientos
              </h3>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-subtle)' }}>{movements.length} registros</span>
            </div>

            {movements.length === 0 ? (
              <div style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                Sin movimientos en el período seleccionado.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                    {['Fecha', 'Descripción', 'Fuente', 'Método', 'Tipo', 'Monto'].map(h => (
                      <th key={h} style={{
                        padding: '0.5rem 1rem', fontSize: '0.62rem', fontWeight: 700,
                        color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em',
                        textAlign: h === 'Monto' ? 'right' : 'left',
                        borderBottom: '1px solid var(--border-subtle)',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {movements.map(m => {
                    const isIncome  = m.type === 'income'  && m.sign === 1
                    const isReversal = m.type === 'income' && m.sign === -1
                    const isExpense = m.type === 'expense'
                    const amountColor = isIncome ? '#22c55e' : isReversal ? '#f59e0b' : '#ef4444'
                    const amountPrefix = isIncome ? '+' : '-'
                    return (
                      <tr
                        key={m.id}
                        style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.03)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <td style={{ padding: '0.625rem 1rem', fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                          {fmtDate(m.date)}
                        </td>
                        <td style={{ padding: '0.625rem 1rem', fontSize: '0.8rem', color: 'var(--text-secondary)', maxWidth: 280 }}>
                          <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {m.description || '—'}
                          </span>
                          {m.comprobante_id && (
                            <Link to={`/comprobantes/${m.comprobante_id}`} style={{ fontSize: '0.68rem', color: 'var(--accent-primary)', opacity: 0.8 }}>
                              Ver comprobante
                            </Link>
                          )}
                        </td>
                        <td style={{ padding: '0.625rem 1rem' }}>
                          <span style={{
                            fontSize: '0.65rem', fontWeight: 700, padding: '0.15rem 0.4rem',
                            borderRadius: '0.25rem', background: 'rgba(255,255,255,0.05)',
                            color: 'var(--text-muted)',
                          }}>
                            {SOURCE_LABELS[m.source] || m.source}
                          </span>
                        </td>
                        <td style={{ padding: '0.625rem 1rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                          {METHOD_LABELS[m.metodo_pago || ''] || m.metodo_pago || '—'}
                        </td>
                        <td style={{ padding: '0.625rem 1rem' }}>
                          <span style={{
                            fontSize: '0.65rem', fontWeight: 700, padding: '0.15rem 0.4rem',
                            borderRadius: '0.25rem',
                            background: isIncome ? 'rgba(34,197,94,0.1)' : isReversal ? 'rgba(245,158,11,0.1)' : 'rgba(239,68,68,0.1)',
                            color: amountColor,
                          }}>
                            {isIncome ? 'Ingreso' : isReversal ? 'Reversa' : 'Egreso'}
                          </span>
                        </td>
                        <td style={{ padding: '0.625rem 1rem', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', fontSize: '0.875rem', color: amountColor, whiteSpace: 'nowrap' }}>
                          {amountPrefix}{fmt(m.amount_ars)}
                        </td>
                      </tr>
                    )
                    void isExpense
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
