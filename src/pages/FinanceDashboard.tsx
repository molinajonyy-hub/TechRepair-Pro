import { useState, useCallback, useEffect, useMemo, lazy, Suspense } from 'react'
import { Link } from 'react-router-dom'
import {
  RefreshCw, TrendingUp, ShieldCheck,
  AlertCircle, AlertTriangle, ArrowUpRight,
  CreditCard, Banknote, Wallet, RotateCcw, Truck,
  Calendar, ChevronRight, CheckCircle2, Info,
  ShoppingCart, FileText, Activity,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { AccountingChangeBanner } from '../components/finance/AccountingChangeBanner'
import { FinanceInsightsPanel } from '../components/finance/FinanceInsightsPanel'
import type { FinanceInsight } from '../services/insightsService'

// Charts L1 — Recharts pesa lo suyo, así que el bloque entero se carga bajo
// demanda: sólo lo baja quien abre Finanzas, y en su propio chunk.
const FinanceChartsL1 = lazy(() => import('../components/finance/charts/FinanceChartsL1'))

// ─── Types ────────────────────────────────────────────────────────────────────

type FinanceTab = 'resumen' | 'caja' | 'ventas' | 'gastos' | 'movimientos' | 'auditoria'
type PeriodPreset = 'today' | 'yesterday' | 'week' | 'month' | 'last_month' | 'custom'

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

// SummaryCard se retiró junto con la fila legacy de KPI del Resumen: su único
// consumidor eran esas tarjetas. La banda KPI canónica vive en
// components/finance/charts/KpiBand.tsx.

function CashCard({ method, amount }: { method: string; amount: number }) {
  const color = METHOD_COLORS[method] || METHOD_COLORS.otro
  const label = METHOD_LABELS[method] || method
  const icon = method === 'efectivo' ? <Banknote size={16} />
    : method === 'transferencia' ? <ArrowUpRight size={16} />
    : method === 'tarjeta' ? <CreditCard size={16} />
    : <Wallet size={16} />
  return (
    // `minWidth: 0` + `overflowWrap` — sin esto el min-content de la tarjeta es
    // el ancho del importe completo, y un número largo ensancha la pista del
    // grid por encima de su parte: la fila se desborda aunque las columnas sean
    // flexibles. Con esto la tarjeta puede achicarse y el importe envuelve.
    <div style={{ background: 'var(--bg-card-solid)', border: `1px solid ${color}30`, borderLeft: `3px solid ${color}`, borderRadius: 'var(--radius-md)', padding: '0.875rem 1rem', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem', minWidth: 0 }}>
        <span style={{ color, flexShrink: 0, display: 'flex' }}>{icon}</span>
        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', minWidth: 0, overflowWrap: 'anywhere' }}>{label}</span>
      </div>
      <div style={{ fontSize: '1.2rem', fontWeight: 800, fontFamily: 'monospace', color: amount >= 0 ? color : '#ef4444', overflowWrap: 'anywhere' }}>{fmt(amount)}</div>
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

  // ── Charts L1 (§18) ──
  // Valor inmovilizado según la regla `dead_stock` de M8. Se toma del panel de
  // insights que ya está montado: no se vuelve a pedir ni se recalcula la regla
  // en el frontend. null = la regla no disparó, y entonces no se afirma nada.
  const [deadStockValue, setDeadStockValue] = useState<number | null>(null)
  const handleInsights = useCallback((insights: FinanceInsight[]) => {
    const ds = insights.find(i => i.rule_id === 'dead_stock')
    const v = ds?.evidence?.dead_value
    setDeadStockValue(typeof v === 'number' && Number.isFinite(v) ? v : null)
  }, [])

  const { from, to } = preset === 'custom'
    ? { from: customFrom, to: customTo }
    : getDateRange(preset)

  // ── Main data load ──────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!businessId || !from || !to) return
    setLoading(true); setError(null)
    try {
      // Etapa 1: la RPC v2 devuelve secciones canónicas (profitability/cashflow/
      // position/data_quality). Se ADAPTAN a la forma DashboardData que consume
      // esta pantalla, sin sumar dinero en JS.
      //
      // Charts L1: acá había una cuarta consulta a v_finance_pnl cuya serie
      // diaria se armaba sumando cogs + payment_fees + operating_expenses +
      // employee_salaries EN JAVASCRIPT. Eso es reconstruir el P&L en el
      // cliente. La serie ahora la entrega get_finance_charts_l1 ya calculada,
      // así que la consulta se retiró junto con el gráfico que la consumía.
      const [rpcRes, { data: mvmts }, { data: debt }] = await Promise.all([
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
      const v2 = rpcRes.data as any
      if (rpcRes.error) throw new Error(rpcRes.error.message)
      if (!v2?.ok) throw new Error(v2?.error || 'Error en RPC')

      const prof = v2.profitability || {}
      const cash = v2.cashflow || {}
      const byMethod = (cash.by_method || {}) as Record<string, number>
      const byClass  = (cash.by_class  || {}) as Record<string, number>
      const dq = v2.data_quality || {}
      const num = (x: any) => Number(x) || 0

      const adapted: DashboardData = {
        period: v2.period,
        summary: {
          gross_income:         num(prof.net_sales),              // ventas netas devengadas
          expenses:             num(prof.cogs) + num(prof.payment_fees) + num(prof.operating_expenses) + num(prof.employee_salaries),
          net_result:           num(prof.operating_result),        // resultado operativo (rentabilidad)
          sales_total:          num(prof.net_sales),
          credit_notes_total:   num(prof.sales_returns),
          supplier_payments:    Math.abs(num(byClass.supplier)),
          operational_expenses: num(prof.operating_expenses),
        },
        cash_by_method: byMethod,
        sales: {
          count: 0, nc_count: 0, local_count: 0, arca_count: 0,
          total_collected: num(cash.income_ars),
          pending_total:   num((v2.position || {}).receivables),
        },
        expenses_by_category: [],
        top_payment_methods: Object.entries(byMethod)
          .map(([method, total]) => ({ method, total: Number(total) }))
          .filter(m => m.total > 0).sort((a, b) => b.total - a.total).slice(0, 5),
        alerts: {
          critical: num(dq.comprobantes_desincronizados) > 0 ? 1 : 0,
          warning:  num(dq.unclassified_count) > 0 || num(dq.fm_sin_caja) > 0 ? 1 : 0,
          low: 0,
        },
      }

      setData(adapted)
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

      <AccountingChangeBanner businessId={businessId} />

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
      </div>

      {/* ── Tab bar ── */}
      <div className="tabs" style={{ marginBottom: '1.5rem' }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`tab tab-sm${activeTab === t.key ? ' tab-active' : ''}`}
          >
            {t.icon} {t.label}
            {t.key === 'auditoria' && hasAlerts && (
              <span className={`badge badge-no-dot ${(data?.alerts.critical ?? 0) > 0 ? 'badge-error' : 'badge-warning'}`} style={{ fontSize: '0.6rem', marginLeft: '0.125rem' }}>
                {(data?.alerts.critical ?? 0) + (data?.alerts.warning ?? 0)}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Error ── */}
      {error && <div className="alert alert-error" style={{ marginBottom: '1.5rem' }}>{error}</div>}

      {loading && !data && (
        <div className="es">
          <RefreshCw size={28} className="animate-spin es-icon" style={{ opacity: 1, color: '#818cf8' }} />
          <p className="es-text" style={{ margin: 0 }}>Calculando…</p>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* TAB: RESUMEN                                                          */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'resumen' && (
        <>
          {/* El aviso del cambio de cálculo contable vive UNA sola vez, en
              <AccountingChangeBanner> arriba del header. Acá había un segundo
              aviso inline que decía lo mismo con otras palabras: se retiró.
              El componente es el que queda porque además despliega la fórmula
              ("Ver cómo se calcula") y recuerda el descarte por negocio. */}
          {PeriodFilter}

          {/* M8 — motor determinista de insights. Reemplaza el bloque binario de
              alertas de abajo: explica QUÉ pasó y con qué números, en vez de
              contar problemas. Se monta fuera del `data &&` a propósito: si el
              resumen falla, el análisis igual debe poder decir lo que sabe. */}
          {businessId && from && to && (
            <FinanceInsightsPanel
              businessId={businessId}
              periodStart={from}
              periodEnd={to}
              onInsightsLoaded={handleInsights}
            />
          )}

          {data && (
            <>
              {/* ── La fila legacy de KPI se retiró acá ──────────────────────
                  La banda KPI de Charts L1 es ahora la superficie canónica del
                  Resumen. Convivían mostrando el MISMO `net_sales` bajo dos
                  nombres ("Ingresos brutos" vs "Ingresos netos"), y el legacy
                  además estaba mal etiquetado: leía `prof.net_sales` y lo
                  llamaba bruto.

                  Ninguna métrica se perdió. Dónde vive ahora cada una:

                    Ingresos brutos    → KPI "Ingresos netos" (L1)
                    Resultado neto     → KPI "Resultado operativo" (L1)
                    Ventas cobradas    → KPI "Cobros" (L1, definición canónica:
                                         cobros de ventas, no caja total) y
                                         pestaña Caja
                    Egresos            → waterfall "Cómo se construyó tu
                                         resultado" (COGS + gastos) y pestaña
                                         Gastos
                    · sub Proveedores  → pestaña Gastos, "Pagos a proveedores"
                    Pendiente ventas   → tarjeta "Cuentas por cobrar" (L1)
                    Deuda proveedores  → tarjeta "Deuda con proveedores" (L1)
                    NC / Reversas      → pestaña Ventas (contador + aviso)
                    Alertas / Auditoría→ badge en la pestaña Auditoría, que ya
                                         muestra el mismo contador

                  Los contratos y las consultas NO se tocaron: `data` sigue
                  alimentando Caja, Ventas y Gastos. */}

              {/* Cash by method — caja por medio de pago. NO lo cubre L1
                  ("Cómo cobraste" son cobros de ventas, no saldos de caja),
                  así que se mantiene.

                  `repeat(4, 1fr)` fijo se comía dos de las cuatro tarjetas en
                  390px: `1fr` no baja del min-content de la tarjeta, el grid
                  quedaba en ~600px y `body { overflow-x: hidden }` recortaba el
                  resto SIN scrollbar — o sea, plata que desaparecía de la
                  pantalla sin ninguna señal. Con auto-fit envuelve a 2x2. */}
              <div data-testid="finance-dashboard-cash-methods" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.875rem', marginBottom: '1.5rem' }}>
                {cashMethods.map(({ method, amount }) => <CashCard key={method} method={method} amount={amount} />)}
              </div>

            </>
          )}

          {/* ── Charts L1 ──
              Se monta fuera del `data &&` a propósito, igual que el panel M8:
              tiene su propia fuente canónica y sus propios estados, así que si
              el resumen de arriba falla, los gráficos igual pueden mostrar lo
              que saben. */}
          {businessId && from && to && (
            <div style={{ marginTop: '1.5rem' }}>
              <Suspense
                fallback={
                  <div className="es" style={{ minHeight: 200 }}>
                    <RefreshCw size={22} className="animate-spin es-icon" style={{ opacity: 1, color: '#818cf8' }} />
                    <p className="es-text" style={{ margin: 0 }}>Cargando gráficos…</p>
                  </div>
                }
              >
                <FinanceChartsL1
                  businessId={businessId}
                  periodStart={from}
                  periodEnd={to}
                  deadStockValue={deadStockValue}
                />
              </Suspense>
            </div>
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
              {/* P1-A — La pestaña Caja arrastraba `repeat(4, 1fr)` y
                  `repeat(3, 1fr)` fijos. En 390px el ancho mínimo de las
                  tarjetas superaba el viewport y, con `body { overflow-x:
                  hidden }`, lo que sobraba se recortaba SIN scrollbar: saldos de
                  caja que existen pero no se pueden leer ni alcanzar.
                  Mismo patrón que ya usa el Resumen: auto-fit + minmax envuelve
                  a 2x2 y a 1 columna sin ocultar ninguna tarjeta. */}
              <div data-testid="finance-caja-cash-methods" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                {cashMethods.map(({ method, amount }) => <CashCard key={method} method={method} amount={amount} />)}
              </div>
              <div data-testid="finance-caja-totals" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                {[
                  { label: 'Total ingresos', value: fmtShort(data.summary.gross_income), color: '#22c55e' },
                  { label: 'Total egresos',  value: fmtShort(data.summary.expenses),     color: '#ef4444' },
                  { label: 'Resultado neto', value: fmtShort(data.summary.net_result),   color: data.summary.net_result >= 0 ? '#34d399' : '#ef4444' },
                ].map(c => (
                  <div key={c.label} style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '1rem', minWidth: 0 }}>
                    <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.3rem', overflowWrap: 'anywhere' }}>{c.label}</div>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800, fontFamily: 'monospace', color: c.color, overflowWrap: 'anywhere' }}>{c.value}</div>
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
            <div className="card es">
              <ShieldCheck size={36} className="es-icon" style={{ color: '#818cf8' }} />
              <p className="es-title">Health-check financiero</p>
              <p className="es-text">Detecta inconsistencias en comprobantes, caja, finanzas y estado fiscal antes de que afecten reportes.</p>
              <button className="btn btn-primary" onClick={() => { setHealthRan(false) }}>
                <RefreshCw size={14} /> Ejecutar auditoría
              </button>
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
                      <span className={`badge badge-no-dot ${check.status === 'ok' ? 'badge-success' : check.status === 'critical' ? 'badge-error' : check.status === 'warning' ? 'badge-warning' : 'badge-neutral'}`}>
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
  // P1-A — Seis columnas tabulares no entran en 390px y no pueden colapsarse sin
  // esconder datos. La carcasa de la tarjeta tiene `overflow: hidden` (para el
  // redondeo), así que sin este scroller la columna Monto quedaba recortada y sin
  // barra: plata visible en desktop e inalcanzable en el teléfono. El scroll
  // horizontal PROPIO de la tabla mantiene todo alcanzable sin generar scroll
  // horizontal en el body.
  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }} data-testid="finance-movements-scroller">
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
            {['Fecha', 'Descripción', 'Fuente', 'Método', 'Tipo', 'Monto'].map(h => (
              <th key={h} style={{ padding: '0.5rem 1rem', fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: h === 'Monto' ? 'right' : 'left', borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {movements.map(m => <MovRow key={m.id} m={m} />)}
        </tbody>
      </table>
    </div>
  )
}

