import { useState, useEffect, useCallback } from 'react'
import {
  TrendingUp, TrendingDown, DollarSign, BarChart3, Plus, X,
  Loader2, AlertCircle, CheckCircle, Pencil, Trash2, RefreshCw,
  ArrowUpRight, ArrowDownRight, Minus, Filter,
  Wallet, Building2, User, Users, Layers, Activity, Award, Target,
  Package,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { currencyService } from '../services/currencyService'
import { supabase } from '../lib/supabase'
import {
  financeService,
  calculateSummary,
  buildMonthlyEvolution,
  buildExpenseDistribution,
  getPeriodDates,
  ENTRY_TYPES,
  PAYMENT_METHODS,
  getTypeDef,
  getCategoryLabel,
  type FinanceEntry,
  type EntryType,
  type Currency,
  type PeriodType,
  type FinanceSummary,
  type MonthPoint,
  type DistributionSlice,
} from '../services/financeService'

// ─── Formatters ───────────────────────────────────────────────────────────────

const fmt = (v: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(v || 0)

const fmtCompact = (v: number): string => {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}k`
  return `${sign}$${abs.toFixed(0)}`
}

const fmtDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' })

// ─── View Types ───────────────────────────────────────────────────────────────

type ViewType = 'general' | 'business' | 'personal' | 'salaries' | 'fixed' | 'variable'

const VIEWS: { value: ViewType; label: string; icon: React.ElementType }[] = [
  { value: 'general', label: 'Resumen general', icon: Layers },
  { value: 'business', label: 'Solo negocio', icon: Building2 },
  { value: 'personal', label: 'Solo personal', icon: User },
  { value: 'salaries', label: 'Sueldos y retiros', icon: Users },
  { value: 'fixed', label: 'Costos fijos', icon: Activity },
  { value: 'variable', label: 'Costos variables', icon: BarChart3 },
]

function filterByView(entries: FinanceEntry[], view: ViewType): FinanceEntry[] {
  if (view === 'general') return entries
  if (view === 'business') return entries.filter(e => ['income', 'variable_cost', 'fixed_cost_local', 'salary'].includes(e.type))
  if (view === 'personal') return entries.filter(e => e.type === 'fixed_cost_personal')
  if (view === 'salaries') return entries.filter(e => e.type === 'salary')
  if (view === 'fixed') return entries.filter(e => e.type === 'fixed_cost_local')
  if (view === 'variable') return entries.filter(e => e.type === 'variable_cost')
  return entries
}

// ─── SVG Bar Chart ─────────────────────────────────────────────────────────────

function BarChart({ data }: { data: MonthPoint[] }) {
  if (!data.length) return null
  const H = 160
  const W = 100
  const maxVal = Math.max(...data.flatMap(d => [d.income, d.expenses]), 1)
  const barW = Math.max(8, Math.min(22, (W / data.length) * 0.35))
  const gap = (W - data.length * barW * 2.5) / (data.length + 1)

  return (
    <svg viewBox={`0 0 ${W} ${H + 24}`} style={{ width: '100%', height: '100%', overflow: 'visible' }}>
      {data.map((d, i) => {
        const x = gap + i * (W / data.length) + gap * 0.2
        const incH = (d.income / maxVal) * H
        const expH = (d.expenses / maxVal) * H
        return (
          <g key={i}>
            {/* Income bar */}
            <rect
              x={x} y={H - incH} width={barW} height={incH}
              rx={2} fill="rgba(52,211,153,0.7)"
            >
              <title>{d.label}: Ingresos {fmt(d.income)}</title>
            </rect>
            {/* Expense bar */}
            <rect
              x={x + barW + 2} y={H - expH} width={barW} height={expH}
              rx={2} fill="rgba(248,113,113,0.7)"
            >
              <title>{d.label}: Egresos {fmt(d.expenses)}</title>
            </rect>
            {/* Label */}
            <text
              x={x + barW} y={H + 14}
              textAnchor="middle" fontSize={7} fill="#64748b"
            >
              {d.label}
            </text>
          </g>
        )
      })}
      {/* Legend */}
      <rect x={2} y={H + 18} width={6} height={4} rx={1} fill="rgba(52,211,153,0.7)" />
      <text x={10} y={H + 22} fontSize={6} fill="#94a3b8">Ingresos</text>
      <rect x={38} y={H + 18} width={6} height={4} rx={1} fill="rgba(248,113,113,0.7)" />
      <text x={46} y={H + 22} fontSize={6} fill="#94a3b8">Egresos</text>
    </svg>
  )
}

// ─── SVG Donut Chart ──────────────────────────────────────────────────────────

function DonutChart({ slices }: { slices: DistributionSlice[] }) {
  if (!slices.length) return null
  const R = 38, r = 24, cx = 50, cy = 50
  let cumAngle = -Math.PI / 2

  const arcs = slices.map(s => {
    const angle = (s.pct / 100) * Math.PI * 2
    const x1 = cx + R * Math.cos(cumAngle)
    const y1 = cy + R * Math.sin(cumAngle)
    cumAngle += angle
    const x2 = cx + R * Math.cos(cumAngle)
    const y2 = cy + R * Math.sin(cumAngle)
    const xi1 = cx + r * Math.cos(cumAngle - angle)
    const yi1 = cy + r * Math.sin(cumAngle - angle)
    const xi2 = cx + r * Math.cos(cumAngle)
    const yi2 = cy + r * Math.sin(cumAngle)
    const large = angle > Math.PI ? 1 : 0
    return { ...s, d: `M${x1},${y1} A${R},${R},0,${large},1,${x2},${y2} L${xi2},${yi2} A${r},${r},0,${large},0,${xi1},${yi1} Z` }
  })

  return (
    <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
      {arcs.map((a, i) => (
        <path key={i} d={a.d} fill={a.color} opacity={0.85}>
          <title>{a.label}: {a.pct.toFixed(1)}%</title>
        </path>
      ))}
      <circle cx={cx} cy={cy} r={r - 1} fill="#0b1220" />
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize={7} fill="#94a3b8">Total</text>
      <text x={cx} y={cy + 7} textAnchor="middle" fontSize={8} fontWeight="700" fill="#f8fafc">
        {slices.length}
      </text>
      <text x={cx} y={cy + 15} textAnchor="middle" fontSize={6} fill="#64748b">tipos</text>
    </svg>
  )
}

// ─── SVG Line Chart (net result) ──────────────────────────────────────────────

function LineChart({ data }: { data: MonthPoint[] }) {
  if (data.length < 2) return null
  const W = 200, H = 100
  const vals = data.map(d => d.net)
  const minV = Math.min(...vals)
  const maxV = Math.max(...vals)
  const range = maxV - minV || 1
  const scaleY = (v: number) => H - ((v - minV) / range) * (H - 16) - 8
  const scaleX = (i: number) => (i / (data.length - 1)) * W

  const points = data.map((d, i) => `${scaleX(i).toFixed(1)},${scaleY(d.net).toFixed(1)}`).join(' ')
  const zeroY = scaleY(0)

  return (
    <svg viewBox={`0 0 ${W} ${H + 14}`} style={{ width: '100%', height: '100%', overflow: 'visible' }}>
      {/* Zero line */}
      {minV < 0 && maxV > 0 && (
        <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="rgba(255,255,255,0.08)" strokeDasharray="3,3" strokeWidth={0.8} />
      )}
      {/* Area fill */}
      <polyline
        points={points}
        fill="none"
        stroke="rgba(99,102,241,0.7)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Dots */}
      {data.map((d, i) => (
        <circle
          key={i}
          cx={scaleX(i)} cy={scaleY(d.net)} r={2.5}
          fill={d.net >= 0 ? '#34d399' : '#f87171'}
          stroke="#0b1220" strokeWidth={1}
        >
          <title>{d.label}: {fmt(d.net)}</title>
        </circle>
      ))}
      {/* X labels */}
      {data.map((d, i) => (
        <text key={i} x={scaleX(i)} y={H + 12} textAnchor="middle" fontSize={6} fill="#475569">
          {d.label.slice(0, 3)}
        </text>
      ))}
    </svg>
  )
}

// ─── Status Banner ─────────────────────────────────────────────────────────────

function StatusBanner({ status, net }: { status: FinanceSummary['status']; net: number }) {
  const config = {
    positive: {
      icon: TrendingUp, color: '#34d399', bg: 'rgba(52,211,153,0.08)',
      border: 'rgba(52,211,153,0.25)', text: 'POSITIVO', sub: 'El negocio está generando ganancia real',
    },
    break_even: {
      icon: Minus, color: '#fbbf24', bg: 'rgba(251,191,36,0.08)',
      border: 'rgba(251,191,36,0.25)', text: 'EN EQUILIBRIO', sub: 'Los ingresos apenas cubren los gastos',
    },
    negative: {
      icon: TrendingDown, color: '#f87171', bg: 'rgba(248,113,113,0.08)',
      border: 'rgba(248,113,113,0.25)', text: 'NEGATIVO', sub: 'Los gastos superan los ingresos del período',
    },
  }[status]

  const Icon = config.icon
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '1rem',
      padding: '1rem 1.5rem',
      backgroundColor: config.bg,
      border: `1px solid ${config.border}`,
      borderRadius: '0.75rem',
      marginBottom: '1.25rem',
    }}>
      <div style={{
        width: '44px', height: '44px', borderRadius: '50%',
        backgroundColor: `${config.color}20`,
        border: `2px solid ${config.color}50`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Icon size={20} style={{ color: config.color }} />
      </div>
      <div style={{ flex: 1 }}>
        <span style={{ fontWeight: 800, fontSize: '1rem', color: config.color, letterSpacing: '0.05em' }}>
          {config.text}
        </span>
        <p style={{ margin: '0.1rem 0 0', fontSize: '0.8rem', color: '#64748b' }}>{config.sub}</p>
      </div>
      <div style={{ textAlign: 'right' }}>
        <p style={{ margin: 0, fontSize: '0.7rem', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Resultado financiero real
        </p>
        <p style={{
          margin: 0, fontSize: '1.5rem', fontWeight: 800,
          fontFamily: 'monospace', color: config.color, letterSpacing: '-0.02em',
        }}>
          {fmt(net)}
        </p>
      </div>
    </div>
  )
}

// ─── Metric Card ──────────────────────────────────────────────────────────────

function MetricCard({
  icon: Icon, label, value, sub, color, accent, formula,
}: {
  icon: React.ElementType; label: string; value: string
  sub?: string; color: string; accent: string; formula?: string
}) {
  return (
    <div style={{
      padding: '1.1rem 1.25rem',
      backgroundColor: '#0f1829',
      border: `1px solid rgba(255,255,255,0.06)`,
      borderTop: `3px solid ${color}`,
      borderRadius: '0.75rem',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', top: 0, right: 0, width: '80px', height: '80px',
        background: `radial-gradient(circle at top right, ${accent} 0%, transparent 70%)`,
      }} />
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
          <div style={{
            width: '30px', height: '30px', borderRadius: '0.4rem',
            backgroundColor: accent, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon size={15} style={{ color }} />
          </div>
          <span style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 500 }}>{label}</span>
        </div>
        <div style={{ fontSize: '1.5rem', fontWeight: 800, color, fontFamily: 'monospace', letterSpacing: '-0.02em' }}>
          {value}
        </div>
        {formula && (
          <div style={{ fontSize: '0.65rem', color: '#334155', marginTop: '0.25rem', fontStyle: 'italic' }}>
            {formula}
          </div>
        )}
        {sub && (
          <div style={{ fontSize: '0.75rem', color: '#475569', marginTop: '0.125rem' }}>{sub}</div>
        )}
      </div>
    </div>
  )
}

// ─── Break-Even Display ───────────────────────────────────────────────────────

function BreakEvenSection({ summary }: { summary: FinanceSummary }) {
  const { breakEvenPoint, totalIncome, fixedLocalCosts, salaries, personalCosts } = summary
  const progress = breakEvenPoint > 0 ? Math.min((totalIncome / breakEvenPoint) * 100, 100) : 0
  const remaining = Math.max(breakEvenPoint - totalIncome, 0)

  return (
    <div style={{
      backgroundColor: '#0f1829',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: '0.75rem',
      padding: '1.25rem 1.5rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <Activity size={17} style={{ color: '#818cf8' }} />
        <h3 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>
          Punto de equilibrio mensual
        </h3>
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
            Ingresos actuales: <strong style={{ color: '#34d399' }}>{fmt(totalIncome)}</strong>
          </span>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
            Necesito: <strong style={{ color: '#818cf8' }}>{fmt(breakEvenPoint)}</strong>
          </span>
        </div>
        <div style={{ height: '10px', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '999px', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: '999px',
            width: `${progress}%`,
            background: progress >= 100
              ? 'linear-gradient(90deg, #34d399, #10b981)'
              : progress >= 70
              ? 'linear-gradient(90deg, #fbbf24, #f59e0b)'
              : 'linear-gradient(90deg, #f87171, #ef4444)',
            transition: 'width 0.5s ease',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.375rem' }}>
          <span style={{ fontSize: '0.7rem', color: '#475569' }}>{progress.toFixed(1)}% alcanzado</span>
          {remaining > 0 && (
            <span style={{ fontSize: '0.7rem', color: '#f87171' }}>
              Faltan {fmt(remaining)} para equilibrarse
            </span>
          )}
          {remaining === 0 && (
            <span style={{ fontSize: '0.7rem', color: '#34d399' }}>Punto de equilibrio superado</span>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '0.75rem' }}>
        {[
          { label: 'Costos fijos del local', amount: fixedLocalCosts, color: '#f87171' },
          { label: 'Sueldos y retiros', amount: salaries, color: '#60a5fa' },
          { label: 'Costos personales', amount: personalCosts, color: '#c084fc' },
        ].map(item => (
          <div key={item.label} style={{
            padding: '0.75rem',
            backgroundColor: 'rgba(255,255,255,0.03)',
            borderRadius: '0.5rem',
            border: '1px solid rgba(255,255,255,0.05)',
          }}>
            <p style={{ margin: '0 0 0.25rem', fontSize: '0.65rem', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {item.label}
            </p>
            <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: item.color, fontFamily: 'monospace' }}>
              {fmtCompact(item.amount)}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Entry Modal ──────────────────────────────────────────────────────────────

interface EntryModalProps {
  entry?: FinanceEntry | null
  exchangeRate: number
  businessId: string
  userId: string
  onClose: () => void
  onSaved: () => void
}

const EMPTY_FORM = {
  date: new Date().toISOString().split('T')[0],
  type: 'income' as EntryType,
  category: '',
  subcategory: '',
  description: '',
  amount: '',
  currency: 'ARS' as Currency,
  payment_method: '',
  notes: '',
  reference_order_id: '',
  reference_employee: '',
}

function EntryModal({ entry, exchangeRate, businessId, userId, onClose, onSaved }: EntryModalProps) {
  const [form, setForm] = useState(
    entry
      ? {
          date: entry.date,
          type: entry.type,
          category: entry.category,
          subcategory: entry.subcategory ?? '',
          description: entry.description ?? '',
          amount: String(entry.amount),
          currency: entry.currency,
          payment_method: entry.payment_method ?? '',
          notes: entry.notes ?? '',
          reference_order_id: entry.reference_order_id ?? '',
          reference_employee: entry.reference_employee ?? '',
        }
      : { ...EMPTY_FORM },
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const typeDef = getTypeDef(form.type)
  const isEdit = !!entry

  const set = (k: keyof typeof EMPTY_FORM, v: string) =>
    setForm(f => ({ ...f, [k]: v }))

  const handleTypeChange = (t: EntryType) => {
    setForm(f => ({ ...f, type: t, category: '' }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const amount = parseFloat(form.amount)
    if (!amount || amount <= 0) { setError('El monto debe ser mayor a 0'); return }
    if (!form.category) { setError('Seleccioná una categoría'); return }
    setError('')
    setSaving(true)
    try {
      const amountArs = form.currency === 'USD' ? amount * exchangeRate : amount
      const payload = {
        business_id: businessId,
        date: form.date,
        type: form.type,
        category: form.category,
        subcategory: form.subcategory || undefined,
        description: form.description || undefined,
        amount,
        currency: form.currency,
        amount_ars: amountArs,
        exchange_rate: exchangeRate,
        payment_method: form.payment_method || undefined,
        notes: form.notes || undefined,
        reference_order_id: form.reference_order_id || undefined,
        reference_employee: form.reference_employee || undefined,
        created_by: userId,
      }
      if (isEdit) await financeService.updateEntry(entry!.id, payload)
      else await financeService.createEntry(payload)
      onSaved()
    } catch (err: any) {
      setError(err.message ?? 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  const inp: React.CSSProperties = {
    width: '100%', padding: '0.5rem 0.75rem', boxSizing: 'border-box',
    backgroundColor: 'rgba(15,23,42,0.8)', border: '1px solid rgba(51,65,85,0.6)',
    borderRadius: '0.375rem', color: '#f1f5f9', fontSize: '0.875rem', outline: 'none',
  }

  const lbl: React.CSSProperties = {
    display: 'block', fontSize: '0.72rem', color: '#64748b',
    marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.04em',
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', zIndex: 100, padding: '1rem',
    }}>
      <div style={{
        backgroundColor: '#0a1628', border: '1px solid rgba(51,65,85,0.6)',
        borderRadius: '1rem', width: '100%', maxWidth: '580px',
        maxHeight: '90vh', overflow: 'auto',
        boxShadow: '0 25px 50px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <div style={{
              width: '34px', height: '34px', borderRadius: '0.5rem',
              backgroundColor: `${typeDef.color}20`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <DollarSign size={17} style={{ color: typeDef.color }} />
            </div>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#f8fafc' }}>
              {isEdit ? 'Editar movimiento' : 'Nuevo movimiento'}
            </h3>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: '0.25rem' }}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {error && (
            <div style={{
              padding: '0.6rem 0.875rem', backgroundColor: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.3)', borderRadius: '0.4rem',
              color: '#f87171', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '0.5rem',
            }}>
              <AlertCircle size={14} /> {error}
            </div>
          )}

          {/* Type selector */}
          <div>
            <label style={lbl}>Tipo de movimiento</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {ENTRY_TYPES.map(t => (
                <button key={t.value} type="button"
                  onClick={() => handleTypeChange(t.value)}
                  style={{
                    padding: '0.4rem 0.75rem', borderRadius: '0.375rem', fontSize: '0.78rem',
                    fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                    border: `1.5px solid ${form.type === t.value ? t.color : 'rgba(255,255,255,0.08)'}`,
                    backgroundColor: form.type === t.value ? `${t.color}18` : 'transparent',
                    color: form.type === t.value ? t.color : '#475569',
                  }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Date + Currency */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={lbl}>Fecha</label>
              <input type="date" value={form.date} onChange={e => set('date', e.target.value)} style={inp} required />
            </div>
            <div>
              <label style={lbl}>Moneda</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                {(['ARS', 'USD'] as Currency[]).map(c => (
                  <button key={c} type="button" onClick={() => set('currency', c)}
                    style={{
                      flex: 1, padding: '0.5rem', borderRadius: '0.375rem', fontSize: '0.82rem',
                      fontWeight: 700, cursor: 'pointer',
                      border: `1.5px solid ${form.currency === c
                        ? (c === 'USD' ? '#60a5fa' : '#34d399')
                        : 'rgba(255,255,255,0.08)'}`,
                      backgroundColor: form.currency === c
                        ? (c === 'USD' ? 'rgba(96,165,250,0.15)' : 'rgba(52,211,153,0.12)')
                        : 'transparent',
                      color: form.currency === c ? (c === 'USD' ? '#60a5fa' : '#34d399') : '#475569',
                    }}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Category + Subcategory */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={lbl}>Categoría</label>
              <select value={form.category} onChange={e => set('category', e.target.value)} style={{ ...inp, appearance: 'none' }} required>
                <option value="">Seleccionar...</option>
                {typeDef.categories.map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={lbl}>Subcategoría (opcional)</label>
              <input type="text" value={form.subcategory} onChange={e => set('subcategory', e.target.value)}
                placeholder="Ej: Factura EDESUR" style={inp} />
            </div>
          </div>

          {/* Description + Amount */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={lbl}>Descripción</label>
              <input type="text" value={form.description} onChange={e => set('description', e.target.value)}
                placeholder="Descripción del movimiento" style={inp} />
            </div>
            <div>
              <label style={lbl}>Monto ({form.currency})</label>
              <input type="number" min="0.01" step="0.01" value={form.amount}
                onChange={e => set('amount', e.target.value)} placeholder="0.00"
                style={{ ...inp, fontFamily: 'monospace', fontSize: '1rem', color: typeDef.color }}
                required />
              {form.currency === 'USD' && exchangeRate > 1 && form.amount && (
                <p style={{ margin: '0.2rem 0 0', fontSize: '0.68rem', color: '#475569' }}>
                  ≈ {fmt(parseFloat(form.amount || '0') * exchangeRate)} (TC ${exchangeRate.toLocaleString('es-AR')})
                </p>
              )}
            </div>
          </div>

          {/* Payment Method */}
          <div>
            <label style={lbl}>Método de pago</label>
            <select value={form.payment_method} onChange={e => set('payment_method', e.target.value)} style={{ ...inp, appearance: 'none' }}>
              <option value="">Sin especificar</option>
              {PAYMENT_METHODS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          {/* References */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={lbl}>N° Orden / Comprobante (opcional)</label>
              <input type="text" value={form.reference_order_id}
                onChange={e => set('reference_order_id', e.target.value)}
                placeholder="Ej: ORD-0042" style={inp} />
            </div>
            <div>
              <label style={lbl}>Empleado relacionado (opcional)</label>
              <input type="text" value={form.reference_employee}
                onChange={e => set('reference_employee', e.target.value)}
                placeholder="Nombre del empleado" style={inp} />
            </div>
          </div>

          {/* Notes */}
          <div>
            <label style={lbl}>Observaciones</label>
            <textarea value={form.notes} onChange={e => set('notes', e.target.value)}
              placeholder="Notas adicionales..."
              rows={2}
              style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '0.625rem', paddingTop: '0.25rem' }}>
            <button type="button" onClick={onClose} style={{
              flex: 1, padding: '0.625rem', backgroundColor: 'transparent',
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem',
              color: '#64748b', cursor: 'pointer', fontSize: '0.875rem',
            }}>
              Cancelar
            </button>
            <button type="submit" disabled={saving} style={{
              flex: 2, padding: '0.625rem',
              background: saving ? 'rgba(99,102,241,0.4)' : 'linear-gradient(135deg,#6366f1,#818cf8)',
              border: 'none', borderRadius: '0.5rem', color: '#fff',
              cursor: saving ? 'not-allowed' : 'pointer',
              fontSize: '0.875rem', fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem',
            }}>
              {saving
                ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Guardando...</>
                : <><CheckCircle size={15} /> {isEdit ? 'Actualizar' : 'Guardar movimiento'}</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Movements Table ──────────────────────────────────────────────────────────

function MovementsTable({
  entries, onEdit, onDelete,
}: {
  entries: FinanceEntry[]
  onEdit: (e: FinanceEntry) => void
  onDelete: (id: string) => void
}) {
  if (!entries.length) {
    return (
      <div style={{
        padding: '3rem', textAlign: 'center',
        backgroundColor: '#0f1829',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '0.75rem',
      }}>
        <DollarSign size={36} style={{ color: '#1e3a5f', margin: '0 auto 0.75rem' }} />
        <p style={{ margin: 0, color: '#334155', fontWeight: 500 }}>Sin movimientos en este período</p>
        <p style={{ margin: '0.25rem 0 0', color: '#1e293b', fontSize: '0.8rem' }}>
          Hacé clic en "Nuevo movimiento" para registrar el primero
        </p>
      </div>
    )
  }

  return (
    <div style={{
      backgroundColor: '#0f1829',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: '0.75rem', overflow: 'hidden',
    }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ backgroundColor: 'rgba(255,255,255,0.02)' }}>
              {['Fecha', 'Tipo', 'Categoría', 'Descripción', 'Moneda', 'Monto ARS', 'Pago', ''].map(h => (
                <th key={h} style={{
                  padding: '0.75rem 0.875rem', textAlign: 'left',
                  color: '#334155', fontWeight: 600, fontSize: '0.7rem',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  whiteSpace: 'nowrap',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map(e => {
              const tDef = getTypeDef(e.type)
              return (
                <tr key={e.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.025)' }}>
                  <td style={{ padding: '0.7rem 0.875rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                    {fmtDate(e.date)}
                  </td>
                  <td style={{ padding: '0.7rem 0.875rem' }}>
                    <span style={{
                      display: 'inline-block', padding: '0.2rem 0.5rem', borderRadius: '0.3rem',
                      backgroundColor: tDef.bgColor, color: tDef.color,
                      fontSize: '0.7rem', fontWeight: 700, whiteSpace: 'nowrap',
                    }}>
                      {tDef.label}
                    </span>
                  </td>
                  <td style={{ padding: '0.7rem 0.875rem', color: '#94a3b8' }}>
                    {getCategoryLabel(e.type, e.category)}
                    {e.subcategory && (
                      <span style={{ display: 'block', fontSize: '0.68rem', color: '#475569' }}>
                        {e.subcategory}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '0.7rem 0.875rem', color: '#cbd5e1', maxWidth: '200px' }}>
                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.description || '—'}
                    </span>
                    {e.notes && (
                      <span style={{ display: 'block', fontSize: '0.68rem', color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.notes}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '0.7rem 0.875rem' }}>
                    <span style={{
                      padding: '0.15rem 0.4rem', borderRadius: '0.25rem', fontSize: '0.7rem', fontWeight: 700,
                      backgroundColor: e.currency === 'USD' ? 'rgba(96,165,250,0.12)' : 'rgba(52,211,153,0.1)',
                      color: e.currency === 'USD' ? '#60a5fa' : '#34d399',
                    }}>
                      {e.currency}
                    </span>
                  </td>
                  <td style={{ padding: '0.7rem 0.875rem', fontFamily: 'monospace', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    <span style={{ color: e.type === 'income' ? '#34d399' : '#f87171' }}>
                      {e.type === 'income' ? '+' : '−'}{fmt(e.amount_ars)}
                    </span>
                  </td>
                  <td style={{ padding: '0.7rem 0.875rem', color: '#334155', fontSize: '0.72rem' }}>
                    {PAYMENT_METHODS.find(m => m.value === e.payment_method)?.label ?? '—'}
                  </td>
                  <td style={{ padding: '0.7rem 0.875rem' }}>
                    <div style={{ display: 'flex', gap: '0.25rem' }}>
                      <button onClick={() => onEdit(e)} style={{
                        background: 'none', border: '1px solid rgba(255,255,255,0.06)',
                        borderRadius: '0.35rem', color: '#64748b', cursor: 'pointer', padding: '0.25rem',
                        display: 'flex', alignItems: 'center',
                      }}>
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => onDelete(e.id)} style={{
                        background: 'none', border: '1px solid rgba(239,68,68,0.15)',
                        borderRadius: '0.35rem', color: '#ef4444', cursor: 'pointer', padding: '0.25rem',
                        display: 'flex', alignItems: 'center',
                      }}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Inventory Analytics Types ───────────────────────────────────────────────

interface InvProduct {
  id: string; name: string; category: string
  stock: number; costPrice: number; salePrice: number
  capitalInv: number; valorPot: number; gananciaPot: number
  marginCost: number; marginSale: number
}

interface InvAnalytics {
  capitalInvertido: number
  valorPotencial: number
  gananciaPotencial: number
  margenCostoPromedio: number
  rentabilidadVentaPromedio: number
  comprasCurrent: number
  comprasPrev: number
  growthPct: number | null
  growthNominal: number
  byCategory: { category: string; capital: number; valor: number; count: number }[]
  products: InvProduct[]
  totalItems: number
  itemsConStock: number
}

type InvSortKey = 'name' | 'stock' | 'capitalInv' | 'valorPot' | 'gananciaPot' | 'marginCost' | 'marginSale'

// ─── Inventory Metrics Section ────────────────────────────────────────────────

function InventoryMetrics({ data, loading }: { data: InvAnalytics | null; loading: boolean }) {
  const [sortKey, setSortKey] = useState<InvSortKey>('capitalInv')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const handleSort = (key: InvSortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '6rem' }}>
      <Loader2 size={36} style={{ color: '#6366f1', animation: 'spin 1s linear infinite' }} />
    </div>
  )

  if (!data) return (
    <div style={{ textAlign: 'center', padding: '4rem 2rem', backgroundColor: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.75rem' }}>
      <Package size={40} style={{ color: '#1e3a5f', marginBottom: '0.75rem' }} />
      <p style={{ margin: 0, color: '#334155', fontWeight: 500 }}>No hay datos de inventario disponibles</p>
      <p style={{ margin: '0.25rem 0 0', color: '#1e293b', fontSize: '0.8rem' }}>Agregá productos al inventario para ver las métricas</p>
    </div>
  )

  const gananciaPct = data.capitalInvertido > 0
    ? (data.gananciaPotencial / data.capitalInvertido) * 100 : 0

  const sorted = [...data.products].sort((a, b) => {
    const av = a[sortKey as keyof InvProduct]
    const bv = b[sortKey as keyof InvProduct]
    if (typeof av === 'string' && typeof bv === 'string')
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    return sortDir === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av)
  })

  const topByCapital = [...data.products].sort((a, b) => b.capitalInv - a.capitalInv).slice(0, 8)
  const maxCapital = topByCapital[0]?.capitalInv || 1

  const sortArrow = (key: InvSortKey) =>
    sortKey === key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''

  const CAT_COLORS = ['#818cf8','#34d399','#60a5fa','#fbbf24','#f87171','#c084fc','#fb923c','#38bdf8']

  const growthColor = data.growthPct !== null && data.growthPct >= 0 ? '#fbbf24' : '#f87171'

  return (
    <>
      {/* ── Summary Strip ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
        padding: '0.75rem 1.25rem', marginBottom: '1.25rem',
        backgroundColor: 'rgba(99,102,241,0.05)',
        border: '1px solid rgba(99,102,241,0.12)',
        borderRadius: '0.625rem',
      }}>
        <Package size={14} style={{ color: '#6366f1' }} />
        <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
          <strong style={{ color: '#e2e8f0' }}>{data.totalItems}</strong> productos en total ·{' '}
          <strong style={{ color: '#e2e8f0' }}>{data.itemsConStock}</strong> con stock
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
            Margen prom. sobre costo: <strong style={{ color: '#818cf8' }}>{data.margenCostoPromedio.toFixed(1)}%</strong>
          </span>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
            Rentabilidad prom. sobre venta: <strong style={{ color: '#34d399' }}>{data.rentabilidadVentaPromedio.toFixed(1)}%</strong>
          </span>
        </div>
      </div>

      {/* ── Hero KPI Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))', gap: '1rem', marginBottom: '1.25rem' }}>

        {/* Card 1: Capital Invertido */}
        <div style={{
          background: 'linear-gradient(135deg,#0f1829 0%,#0a1628 100%)',
          border: '1px solid rgba(96,165,250,0.2)', borderTop: '3px solid #60a5fa',
          borderRadius: '0.875rem', padding: '1.5rem', position: 'relative', overflow: 'hidden',
          boxShadow: '0 4px 24px rgba(96,165,250,0.08)',
        }}>
          <div style={{ position: 'absolute', top: 0, right: 0, width: '120px', height: '120px', background: 'radial-gradient(circle at top right,rgba(96,165,250,0.12) 0%,transparent 70%)' }} />
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.875rem' }}>
              <div style={{ width: '34px', height: '34px', borderRadius: '0.5rem', backgroundColor: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <DollarSign size={17} style={{ color: '#60a5fa' }} />
              </div>
              <span style={{ fontSize: '0.7rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Capital Invertido en Stock</span>
            </div>
            <div style={{ fontSize: '2.1rem', fontWeight: 900, color: '#60a5fa', fontFamily: 'monospace', letterSpacing: '-0.03em', lineHeight: 1 }}>
              {fmtCompact(data.capitalInvertido)}
            </div>
            <div style={{ fontSize: '0.73rem', color: '#334155', marginTop: '0.3rem', fontFamily: 'monospace' }}>{fmt(data.capitalInvertido)}</div>
            <div style={{ marginTop: '0.75rem', fontSize: '0.68rem', color: '#1e3a5f', fontStyle: 'italic' }}>Σ (stock × precio_costo)</div>
          </div>
        </div>

        {/* Card 2: Valor Potencial de Venta */}
        <div style={{
          background: 'linear-gradient(135deg,#0f1829 0%,#0a1628 100%)',
          border: '1px solid rgba(52,211,153,0.2)', borderTop: '3px solid #34d399',
          borderRadius: '0.875rem', padding: '1.5rem', position: 'relative', overflow: 'hidden',
          boxShadow: '0 4px 24px rgba(52,211,153,0.08)',
        }}>
          <div style={{ position: 'absolute', top: 0, right: 0, width: '120px', height: '120px', background: 'radial-gradient(circle at top right,rgba(52,211,153,0.12) 0%,transparent 70%)' }} />
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.875rem' }}>
              <div style={{ width: '34px', height: '34px', borderRadius: '0.5rem', backgroundColor: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <TrendingUp size={17} style={{ color: '#34d399' }} />
              </div>
              <span style={{ fontSize: '0.7rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Valor Potencial de Venta</span>
            </div>
            <div style={{ fontSize: '2.1rem', fontWeight: 900, color: '#34d399', fontFamily: 'monospace', letterSpacing: '-0.03em', lineHeight: 1 }}>
              {fmtCompact(data.valorPotencial)}
            </div>
            <div style={{ fontSize: '0.73rem', color: '#334155', marginTop: '0.3rem', fontFamily: 'monospace' }}>{fmt(data.valorPotencial)}</div>
            <div style={{ marginTop: '0.75rem', fontSize: '0.68rem', color: '#1e3a5f', fontStyle: 'italic' }}>Σ (stock × precio_venta)</div>
          </div>
        </div>

        {/* Card 3: Ganancia Potencial Bruta */}
        <div style={{
          background: 'linear-gradient(135deg,#0f1829 0%,#0a1628 100%)',
          border: `1px solid ${data.gananciaPotencial >= 0 ? 'rgba(129,140,248,0.22)' : 'rgba(248,113,113,0.22)'}`,
          borderTop: `3px solid ${data.gananciaPotencial >= 0 ? '#818cf8' : '#f87171'}`,
          borderRadius: '0.875rem', padding: '1.5rem', position: 'relative', overflow: 'hidden',
          boxShadow: `0 4px 24px ${data.gananciaPotencial >= 0 ? 'rgba(129,140,248,0.08)' : 'rgba(248,113,113,0.07)'}`,
        }}>
          <div style={{ position: 'absolute', top: 0, right: 0, width: '120px', height: '120px', background: `radial-gradient(circle at top right,${data.gananciaPotencial >= 0 ? 'rgba(129,140,248,0.12)' : 'rgba(248,113,113,0.1)'} 0%,transparent 70%)` }} />
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.875rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{ width: '34px', height: '34px', borderRadius: '0.5rem', backgroundColor: data.gananciaPotencial >= 0 ? 'rgba(129,140,248,0.1)' : 'rgba(248,113,113,0.1)', border: `1px solid ${data.gananciaPotencial >= 0 ? 'rgba(129,140,248,0.18)' : 'rgba(248,113,113,0.18)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Award size={17} style={{ color: data.gananciaPotencial >= 0 ? '#818cf8' : '#f87171' }} />
                </div>
                <span style={{ fontSize: '0.7rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Ganancia Potencial Bruta</span>
              </div>
              <span style={{ fontSize: '0.82rem', fontWeight: 800, fontFamily: 'monospace', color: data.gananciaPotencial >= 0 ? '#818cf8' : '#f87171', backgroundColor: data.gananciaPotencial >= 0 ? 'rgba(129,140,248,0.1)' : 'rgba(248,113,113,0.1)', padding: '0.2rem 0.5rem', borderRadius: '0.3rem' }}>
                {gananciaPct >= 0 ? '+' : ''}{gananciaPct.toFixed(1)}%
              </span>
            </div>
            <div style={{ fontSize: '2.1rem', fontWeight: 900, color: data.gananciaPotencial >= 0 ? '#818cf8' : '#f87171', fontFamily: 'monospace', letterSpacing: '-0.03em', lineHeight: 1 }}>
              {data.gananciaPotencial < 0 ? '−' : '+'}{fmtCompact(Math.abs(data.gananciaPotencial))}
            </div>
            <div style={{ fontSize: '0.73rem', color: '#334155', marginTop: '0.3rem', fontFamily: 'monospace' }}>{fmt(data.gananciaPotencial)}</div>
            <div style={{ marginTop: '0.75rem', fontSize: '0.68rem', color: '#1e3a5f', fontStyle: 'italic' }}>Valor potencial − Capital invertido</div>
          </div>
        </div>

        {/* Card 4: Crecimiento del Capital */}
        <div style={{
          background: 'linear-gradient(135deg,#0f1829 0%,#0a1628 100%)',
          border: `1px solid ${data.growthPct !== null ? (data.growthPct >= 0 ? 'rgba(251,191,36,0.2)' : 'rgba(248,113,113,0.2)') : 'rgba(255,255,255,0.06)'}`,
          borderTop: `3px solid ${data.growthPct !== null ? growthColor : '#334155'}`,
          borderRadius: '0.875rem', padding: '1.5rem', position: 'relative', overflow: 'hidden',
          boxShadow: data.growthPct !== null ? `0 4px 24px ${data.growthPct >= 0 ? 'rgba(251,191,36,0.07)' : 'rgba(248,113,113,0.07)'}` : 'none',
        }}>
          <div style={{ position: 'absolute', top: 0, right: 0, width: '120px', height: '120px', background: `radial-gradient(circle at top right,${data.growthPct !== null ? (data.growthPct >= 0 ? 'rgba(251,191,36,0.1)' : 'rgba(248,113,113,0.08)') : 'rgba(255,255,255,0.03)'} 0%,transparent 70%)` }} />
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.875rem' }}>
              <div style={{ width: '34px', height: '34px', borderRadius: '0.5rem', backgroundColor: data.growthPct !== null ? (data.growthPct >= 0 ? 'rgba(251,191,36,0.1)' : 'rgba(248,113,113,0.1)') : 'rgba(255,255,255,0.04)', border: `1px solid ${data.growthPct !== null ? (data.growthPct >= 0 ? 'rgba(251,191,36,0.2)' : 'rgba(248,113,113,0.2)') : 'rgba(255,255,255,0.06)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {data.growthPct !== null && data.growthPct >= 0
                  ? <ArrowUpRight size={17} style={{ color: '#fbbf24' }} />
                  : data.growthPct !== null
                  ? <ArrowDownRight size={17} style={{ color: '#f87171' }} />
                  : <TrendingUp size={17} style={{ color: '#334155' }} />}
              </div>
              <span style={{ fontSize: '0.7rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Crecimiento del Capital</span>
            </div>
            {data.growthPct !== null ? (
              <>
                <div style={{ fontSize: '2.1rem', fontWeight: 900, color: growthColor, fontFamily: 'monospace', letterSpacing: '-0.03em', lineHeight: 1 }}>
                  {data.growthPct >= 0 ? '+' : ''}{data.growthPct.toFixed(1)}%
                </div>
                <div style={{ fontSize: '0.82rem', fontWeight: 700, fontFamily: 'monospace', marginTop: '0.3rem', color: data.growthNominal >= 0 ? '#34d399' : '#f87171' }}>
                  {data.growthNominal >= 0 ? '+' : '−'}{fmt(Math.abs(data.growthNominal))}
                </div>
                <div style={{ marginTop: '0.625rem', fontSize: '0.69rem', color: '#334155', lineHeight: 1.5 }}>
                  Compras período actual: {fmtCompact(data.comprasCurrent)}<br />
                  Período anterior: {fmtCompact(data.comprasPrev)}
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#1e3a5f', marginTop: '0.25rem' }}>—</div>
                <div style={{ marginTop: '0.5rem', fontSize: '0.73rem', color: '#334155', lineHeight: 1.5 }}>
                  Registrá compras en el período seleccionado para comparar la evolución del capital.
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Category Chart + Top Items ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.25rem' }}>

        {/* Capital por categoría */}
        <div style={{ backgroundColor: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.75rem', padding: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <BarChart3 size={15} style={{ color: '#818cf8' }} />
            <h3 style={{ margin: 0, fontSize: '0.8rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Capital invertido por categoría
            </h3>
          </div>
          {data.byCategory.length === 0 ? (
            <p style={{ color: '#334155', fontSize: '0.8rem', textAlign: 'center', padding: '2rem 0', margin: 0 }}>Sin datos</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
              {data.byCategory.map((cat, i) => {
                const maxCat = data.byCategory[0].capital
                const pct = maxCat > 0 ? (cat.capital / maxCat) * 100 : 0
                const color = CAT_COLORS[i % CAT_COLORS.length]
                const ganCat = cat.valor - cat.capital
                return (
                  <div key={cat.category}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                      <span style={{ fontSize: '0.76rem', color: '#64748b' }}>
                        {cat.category}
                        <span style={{ color: '#334155', marginLeft: '0.35rem' }}>({cat.count})</span>
                      </span>
                      <div style={{ display: 'flex', gap: '0.75rem' }}>
                        <span style={{ fontSize: '0.72rem', color: '#475569', fontFamily: 'monospace' }}>
                          inv: <span style={{ color }}>{fmtCompact(cat.capital)}</span>
                        </span>
                        <span style={{ fontSize: '0.72rem', color: '#475569', fontFamily: 'monospace' }}>
                          gan: <span style={{ color: ganCat >= 0 ? '#34d399' : '#f87171' }}>{fmtCompact(ganCat)}</span>
                        </span>
                      </div>
                    </div>
                    <div style={{ height: '7px', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: '999px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, borderRadius: '999px', background: `linear-gradient(90deg,${color}cc,${color}77)`, transition: 'width 0.4s ease' }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Top productos por capital */}
        <div style={{ backgroundColor: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.75rem', padding: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <Award size={15} style={{ color: '#fbbf24' }} />
            <h3 style={{ margin: 0, fontSize: '0.8rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Top productos por capital invertido
            </h3>
          </div>
          {topByCapital.length === 0 ? (
            <p style={{ color: '#334155', fontSize: '0.8rem', textAlign: 'center', padding: '2rem 0', margin: 0 }}>Sin productos con stock</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
              {topByCapital.map((item, i) => {
                const rentColor = item.marginSale >= 35 ? '#34d399' : item.marginSale >= 20 ? '#fbbf24' : item.marginSale >= 10 ? '#f97316' : '#f87171'
                return (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                    <span style={{ fontSize: '0.65rem', color: '#334155', width: '16px', textAlign: 'right', flexShrink: 0 }}>{i + 1}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.15rem' }}>
                        <span style={{ fontSize: '0.75rem', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }}>
                          {item.name}
                        </span>
                        <span style={{ fontSize: '0.72rem', color: '#60a5fa', fontFamily: 'monospace', fontWeight: 700, flexShrink: 0, marginLeft: '0.375rem' }}>
                          {fmtCompact(item.capitalInv)}
                        </span>
                      </div>
                      <div style={{ height: '4px', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: '999px', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${maxCapital > 0 ? (item.capitalInv / maxCapital) * 100 : 0}%`, background: 'linear-gradient(90deg,#60a5fa,#3b82f6)', borderRadius: '999px' }} />
                      </div>
                    </div>
                    <span style={{ fontSize: '0.68rem', fontWeight: 700, color: rentColor, flexShrink: 0, minWidth: '32px', textAlign: 'right' }}>
                      {item.marginSale.toFixed(0)}%
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Per-Product Profitability Table ── */}
      <div style={{ backgroundColor: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.75rem', overflow: 'hidden' }}>
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Package size={15} style={{ color: '#818cf8' }} />
          <h3 style={{ margin: 0, fontSize: '0.8rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Rentabilidad por producto
          </h3>
          <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: '#334155' }}>
            {data.products.length} producto{data.products.length !== 1 ? 's' : ''}
          </span>
          <span style={{ fontSize: '0.68rem', color: '#1e3a5f', fontStyle: 'italic' }}>Clic en encabezado para ordenar</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead>
              <tr style={{ backgroundColor: 'rgba(255,255,255,0.02)' }}>
                {([
                  { key: 'name' as InvSortKey, label: 'Producto' },
                  { key: 'stock' as InvSortKey, label: 'Stock' },
                  { key: null, label: 'Costo Unit.' },
                  { key: null, label: 'Precio Venta' },
                  { key: 'capitalInv' as InvSortKey, label: 'Capital Inv.' },
                  { key: 'valorPot' as InvSortKey, label: 'Valor Pot.' },
                  { key: 'marginCost' as InvSortKey, label: 'Margen/Costo %' },
                  { key: 'marginSale' as InvSortKey, label: 'Rent./Venta %' },
                  { key: 'gananciaPot' as InvSortKey, label: 'Gan. Potencial' },
                ]).map((col, i) => (
                  <th key={i}
                    onClick={col.key ? () => handleSort(col.key as InvSortKey) : undefined}
                    style={{
                      padding: '0.625rem 0.875rem', textAlign: i <= 1 ? 'left' : 'right',
                      color: col.key && sortKey === col.key ? '#818cf8' : '#334155',
                      fontWeight: 600, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.05em',
                      borderBottom: '1px solid rgba(255,255,255,0.05)', whiteSpace: 'nowrap',
                      cursor: col.key ? 'pointer' : 'default', userSelect: 'none',
                    }}>
                    {col.label}{col.key ? sortArrow(col.key) : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((p, i) => {
                const mc = p.marginCost
                const ms = p.marginSale
                const mcColor = mc >= 60 ? '#34d399' : mc >= 30 ? '#fbbf24' : mc >= 10 ? '#f97316' : '#f87171'
                const msColor = ms >= 35 ? '#34d399' : ms >= 20 ? '#fbbf24' : ms >= 10 ? '#f97316' : '#f87171'
                return (
                  <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.025)', backgroundColor: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                    <td style={{ padding: '0.6rem 0.875rem', color: '#e2e8f0', maxWidth: '200px' }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      <span style={{ display: 'block', fontSize: '0.65rem', color: '#334155' }}>{p.category}</span>
                    </td>
                    <td style={{ padding: '0.6rem 0.875rem', textAlign: 'right', fontFamily: 'monospace', color: p.stock > 0 ? '#94a3b8' : '#475569' }}>
                      {p.stock}
                    </td>
                    <td style={{ padding: '0.6rem 0.875rem', textAlign: 'right', fontFamily: 'monospace', color: '#64748b', whiteSpace: 'nowrap' }}>
                      {fmt(p.costPrice)}
                    </td>
                    <td style={{ padding: '0.6rem 0.875rem', textAlign: 'right', fontFamily: 'monospace', color: '#64748b', whiteSpace: 'nowrap' }}>
                      {fmt(p.salePrice)}
                    </td>
                    <td style={{ padding: '0.6rem 0.875rem', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: '#60a5fa', whiteSpace: 'nowrap' }}>
                      {fmtCompact(p.capitalInv)}
                    </td>
                    <td style={{ padding: '0.6rem 0.875rem', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: '#34d399', whiteSpace: 'nowrap' }}>
                      {fmtCompact(p.valorPot)}
                    </td>
                    <td style={{ padding: '0.6rem 0.875rem', textAlign: 'right' }}>
                      <span style={{ display: 'inline-block', padding: '0.15rem 0.45rem', borderRadius: '0.3rem', backgroundColor: `${mcColor}14`, color: mcColor, fontFamily: 'monospace', fontWeight: 700, fontSize: '0.75rem' }}>
                        {mc.toFixed(1)}%
                      </span>
                    </td>
                    <td style={{ padding: '0.6rem 0.875rem', textAlign: 'right' }}>
                      <span style={{ display: 'inline-block', padding: '0.15rem 0.45rem', borderRadius: '0.3rem', backgroundColor: `${msColor}14`, color: msColor, fontFamily: 'monospace', fontWeight: 700, fontSize: '0.75rem' }}>
                        {ms.toFixed(1)}%
                      </span>
                    </td>
                    <td style={{ padding: '0.6rem 0.875rem', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      <span style={{ color: p.gananciaPot >= 0 ? '#818cf8' : '#f87171' }}>
                        {p.gananciaPot < 0 ? '−' : '+'}{fmtCompact(Math.abs(p.gananciaPot))}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

// ─── Main Finance Component ───────────────────────────────────────────────────

export function Finance() {
  const { businessId, user } = useAuth()

  const [period, setPeriod] = useState<PeriodType>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [view, setView] = useState<ViewType>('general')
  const [entries, setEntries] = useState<FinanceEntry[]>([])
  const [monthlyData, setMonthlyData] = useState<MonthPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exchangeRate, setExchangeRate] = useState(1)
  const [showModal, setShowModal] = useState(false)
  const [editingEntry, setEditingEntry] = useState<FinanceEntry | null>(null)
  const [activeChartTab, setActiveChartTab] = useState<'bars' | 'donut' | 'line'>('bars')
  const [activeMainTab, setActiveMainTab] = useState<'movimientos' | 'inventario'>('movimientos')
  const [invData, setInvData] = useState<InvAnalytics | null>(null)

  // Ganancia real de operaciones (order_parts)
  const [opProfit, setOpProfit] = useState<{
    totalRevenue: number
    totalCost: number
    totalProfit: number
    margin: number
    count: number
    topItems: { name: string; profit: number; margin: number; count: number }[]
  } | null>(null)

  const { from, to } = getPeriodDates(period, customFrom, customTo)

  const [tableReady, setTableReady] = useState<boolean | null>(null) // null = checking

  const load = useCallback(async () => {
    if (!businessId) return
    setLoading(true)
    setError(null)
    try {
      const [rate, fetched, monthly] = await Promise.all([
        currencyService.getCurrentExchangeRate('USD', 'ARS').catch(() => 1),
        financeService.getEntries(businessId, from, to).catch((err: any) => {
          // Tabla no creada todavía
          if (err?.message?.includes('schema cache') || err?.code === 'PGRST200' || err?.message?.includes('business_finance_entries')) {
            setTableReady(false)
            return []
          }
          throw err
        }),
        financeService.getLastMonths(businessId, 6).catch(() => []),
      ])
      setTableReady(true)
      setExchangeRate(rate || 1)
      setEntries(fetched)
      setMonthlyData(buildMonthlyEvolution(monthly))

      // Ganancia real de operaciones desde order_parts
      try {
        const { data: parts } = await supabase
          .from('order_parts')
          .select('internal_cost, sale_price, quantity, name, added_at, orders!inner(business_id)')
          .eq('orders.business_id', businessId)
          .in('status', ['used', 'sold'])
          .gte('added_at', from + 'T00:00:00')
          .lte('added_at', to + 'T23:59:59')

        const arr = parts || []
        const totalRevenue = arr.reduce((s, p) => s + p.sale_price * p.quantity, 0)
        const totalCost = arr.reduce((s, p) => s + p.internal_cost * p.quantity, 0)
        const totalProfit = totalRevenue - totalCost
        const margin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0

        const itemMap: Record<string, { profit: number; rev: number; count: number }> = {}
        arr.forEach((p: any) => {
          const key = (p.name || 'Sin nombre').slice(0, 40)
          const profit = Math.max(0, (p.sale_price - p.internal_cost)) * p.quantity
          const rev = p.sale_price * p.quantity
          if (!itemMap[key]) itemMap[key] = { profit: 0, rev: 0, count: 0 }
          itemMap[key].profit += profit
          itemMap[key].rev += rev
          itemMap[key].count += 1
        })
        const topItems = Object.entries(itemMap)
          .map(([name, { profit, rev, count }]) => ({
            name, profit, count, margin: rev > 0 ? (profit / rev) * 100 : 0,
          }))
          .sort((a, b) => b.profit - a.profit)
          .slice(0, 8)

        setOpProfit({ totalRevenue, totalCost, totalProfit, margin, count: arr.length, topItems })
      } catch {
        setOpProfit(null)
      }

      // ── Inventory Analytics ──
      try {
        const { data: rawInv } = await supabase
          .from('inventory')
          .select('id, name, category, stock_quantity, cost_price, sale_price')
          .eq('business_id', businessId)
          .eq('is_active', true)

        const invArr = rawInv || []
        const allProducts: InvProduct[] = invArr.map((item: any) => {
          const stock = item.stock_quantity || 0
          const cost = item.cost_price || 0
          const sale = item.sale_price || 0
          const capitalInv = stock * cost
          const valorPot = stock * sale
          const gananciaPot = valorPot - capitalInv
          const marginCost = cost > 0 ? ((sale - cost) / cost) * 100 : 0
          const marginSale = sale > 0 ? ((sale - cost) / sale) * 100 : 0
          return {
            id: item.id, name: item.name || 'Sin nombre',
            category: item.category || 'Sin categoría',
            stock, costPrice: cost, salePrice: sale,
            capitalInv, valorPot, gananciaPot, marginCost, marginSale,
          }
        })

        const withStock = allProducts.filter(p => p.stock > 0)
        const capitalInvertido = withStock.reduce((s, p) => s + p.capitalInv, 0)
        const valorPotencial = withStock.reduce((s, p) => s + p.valorPot, 0)
        const gananciaPotencial = valorPotencial - capitalInvertido

        const totalCap = capitalInvertido || 1
        const margenCostoPromedio = withStock.reduce((s, p) => s + p.marginCost * (p.capitalInv / totalCap), 0)
        const rentabilidadVentaPromedio = withStock.reduce((s, p) => s + p.marginSale * (p.capitalInv / totalCap), 0)

        const catMap: Record<string, { capital: number; valor: number; count: number }> = {}
        withStock.forEach(p => {
          if (!catMap[p.category]) catMap[p.category] = { capital: 0, valor: 0, count: 0 }
          catMap[p.category].capital += p.capitalInv
          catMap[p.category].valor += p.valorPot
          catMap[p.category].count += 1
        })
        const byCategory = Object.entries(catMap)
          .map(([category, v]) => ({ category, ...v }))
          .sort((a, b) => b.capital - a.capital)

        // Compare purchases: current period vs same-duration previous period
        const periodMs = Math.max(86400000, new Date(to).getTime() - new Date(from).getTime())
        const prevFrom = new Date(new Date(from).getTime() - periodMs).toISOString().split('T')[0]

        const [currPurch, prevPurch] = await Promise.all([
          supabase.from('purchases').select('total').eq('business_id', businessId)
            .gte('purchase_date', from).lte('purchase_date', to),
          supabase.from('purchases').select('total').eq('business_id', businessId)
            .gte('purchase_date', prevFrom).lt('purchase_date', from),
        ])

        const comprasCurrent = (currPurch.data || []).reduce((s: number, p: any) => s + (p.total || 0), 0)
        const comprasPrev = (prevPurch.data || []).reduce((s: number, p: any) => s + (p.total || 0), 0)
        const growthPct = comprasPrev > 0 ? ((comprasCurrent - comprasPrev) / comprasPrev) * 100 : null
        const growthNominal = comprasCurrent - comprasPrev

        setInvData({
          capitalInvertido, valorPotencial, gananciaPotencial,
          margenCostoPromedio, rentabilidadVentaPromedio,
          comprasCurrent, comprasPrev, growthPct, growthNominal,
          byCategory, products: allProducts,
          totalItems: invArr.length, itemsConStock: withStock.length,
        })
      } catch {
        // inventory metrics are non-critical — silently ignore
      }

    } catch (err: any) {
      setError(err.message ?? 'Error al cargar datos financieros')
    } finally {
      setLoading(false)
    }
  }, [businessId, from, to])

  useEffect(() => { load() }, [load])

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este movimiento? Esta acción no se puede deshacer.')) return
    try {
      await financeService.deleteEntry(id)
      setEntries(prev => prev.filter(e => e.id !== id))
    } catch (err: any) {
      alert('Error al eliminar: ' + err.message)
    }
  }

  const handleEdit = (entry: FinanceEntry) => {
    setEditingEntry(entry)
    setShowModal(true)
  }

  const handleNew = () => {
    setEditingEntry(null)
    setShowModal(true)
  }

  const handleModalSaved = () => {
    setShowModal(false)
    setEditingEntry(null)
    load()
  }

  const summary = calculateSummary(entries)
  const distribution = buildExpenseDistribution(entries)
  const visibleEntries = filterByView(entries, view)

  const PERIOD_OPTS: { value: PeriodType; label: string }[] = [
    { value: 'today', label: 'Hoy' },
    { value: 'week', label: 'Semana' },
    { value: 'month', label: 'Mes' },
    { value: 'year', label: 'Año' },
    { value: 'custom', label: 'Personalizado' },
  ]

  const cardStyle: React.CSSProperties = {
    backgroundColor: '#0f1829',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '0.75rem',
    padding: '1.25rem',
  }

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1400px', margin: '0 auto' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: '0.75rem',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.2))',
            border: '1px solid rgba(99,102,241,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <BarChart3 size={22} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f8fafc' }}>
              Panel Financiero
            </h1>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#475569' }}>
              Control integral de ingresos, costos y resultados del negocio
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button onClick={load} style={{
            display: 'flex', alignItems: 'center', gap: '0.375rem',
            padding: '0.5rem 0.875rem',
            backgroundColor: 'transparent', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '0.5rem', color: '#64748b', cursor: 'pointer', fontSize: '0.8rem',
          }}>
            <RefreshCw size={14} /> Actualizar
          </button>
          <button onClick={handleNew} style={{
            display: 'flex', alignItems: 'center', gap: '0.375rem',
            padding: '0.5rem 1rem',
            background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
            border: 'none', borderRadius: '0.5rem', color: '#fff',
            cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600,
            boxShadow: '0 4px 12px rgba(99,102,241,0.3)',
          }}>
            <Plus size={16} /> Nuevo movimiento
          </button>
        </div>
      </div>

      {/* ── Main Tabs ── */}
      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0' }}>
        {([
          { key: 'movimientos', label: 'Movimientos y Finanzas', icon: BarChart3 },
          { key: 'inventario', label: 'Inventario', icon: Package },
        ] as const).map(tab => {
          const Icon = tab.icon
          return (
            <button key={tab.key} onClick={() => setActiveMainTab(tab.key)} style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.625rem 1.125rem',
              background: 'none', cursor: 'pointer',
              fontSize: '0.875rem', fontWeight: activeMainTab === tab.key ? 700 : 500,
              color: activeMainTab === tab.key ? '#818cf8' : '#475569',
              border: 'none',
              borderBottom: `2px solid ${activeMainTab === tab.key ? '#6366f1' : 'transparent'}`,
              marginBottom: '-1px',
              transition: 'all 0.15s',
            }}>
              <Icon size={15} />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* ── Inventario Tab Content ── */}
      {activeMainTab === 'inventario' && (
        <InventoryMetrics data={invData} loading={loading} />
      )}

      {/* ── Movimientos Tab Content ── */}
      {activeMainTab === 'movimientos' && <>

      {/* ── Period Filter ── */}
      <div style={{ display: 'flex', gap: '0.375rem', marginBottom: '1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <Filter size={14} style={{ color: '#475569' }} />
        {PERIOD_OPTS.map(p => (
          <button key={p.value} onClick={() => setPeriod(p.value)} style={{
            padding: '0.375rem 0.875rem', borderRadius: '999px', fontSize: '0.8rem',
            fontWeight: 500, cursor: 'pointer', transition: 'all 0.15s',
            backgroundColor: period === p.value ? 'rgba(99,102,241,0.2)' : 'transparent',
            border: `1px solid ${period === p.value ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.06)'}`,
            color: period === p.value ? '#818cf8' : '#475569',
          }}>
            {p.label}
          </button>
        ))}
        {period === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginLeft: '0.25rem' }}>
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
              style={{
                padding: '0.3rem 0.6rem', backgroundColor: '#0f1829',
                border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.4rem',
                color: '#94a3b8', fontSize: '0.8rem', outline: 'none',
              }} />
            <span style={{ color: '#334155', fontSize: '0.75rem' }}>hasta</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
              style={{
                padding: '0.3rem 0.6rem', backgroundColor: '#0f1829',
                border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.4rem',
                color: '#94a3b8', fontSize: '0.8rem', outline: 'none',
              }} />
          </div>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#334155' }}>
          {fmtDate(from)} → {fmtDate(to)}
        </span>
      </div>

      {/* ── Setup requerido ── */}
      {tableReady === false && (
        <div style={{
          padding: '1.5rem',
          backgroundColor: 'rgba(251,191,36,0.06)',
          border: '1px solid rgba(251,191,36,0.25)',
          borderRadius: '0.75rem',
          marginBottom: '1.25rem',
        }}>
          <div style={{ display: 'flex', gap: '0.875rem', alignItems: 'flex-start' }}>
            <AlertCircle size={20} style={{ color: '#fbbf24', flexShrink: 0, marginTop: '0.1rem' }} />
            <div style={{ flex: 1 }}>
              <p style={{ margin: '0 0 0.375rem', fontWeight: 700, color: '#fbbf24', fontSize: '0.95rem' }}>
                Configuración inicial requerida
              </p>
              <p style={{ margin: '0 0 1rem', color: '#94a3b8', fontSize: '0.85rem', lineHeight: 1.5 }}>
                La tabla <code style={{ backgroundColor: 'rgba(255,255,255,0.08)', padding: '0.1rem 0.35rem', borderRadius: '0.25rem', fontFamily: 'monospace', fontSize: '0.82rem' }}>business_finance_entries</code> no existe todavía.
                Ejecutá el siguiente SQL en <strong>Supabase → SQL Editor</strong> y recargá la página.
              </p>
              <details style={{ cursor: 'pointer' }}>
                <summary style={{ color: '#818cf8', fontSize: '0.85rem', fontWeight: 600, userSelect: 'none', marginBottom: '0.5rem' }}>
                  Ver SQL de migración
                </summary>
                <pre style={{
                  margin: '0.5rem 0 0',
                  padding: '1rem',
                  backgroundColor: '#020617',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '0.5rem',
                  fontSize: '0.72rem',
                  color: '#94a3b8',
                  overflowX: 'auto',
                  lineHeight: 1.6,
                  whiteSpace: 'pre',
                }}>{`CREATE TABLE IF NOT EXISTS business_finance_entries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  date               DATE NOT NULL,
  type               TEXT NOT NULL CHECK (type IN (
                       'income','variable_cost',
                       'fixed_cost_local','fixed_cost_personal','salary'
                     )),
  category           TEXT NOT NULL,
  subcategory        TEXT,
  description        TEXT,
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency           TEXT NOT NULL DEFAULT 'ARS' CHECK (currency IN ('ARS','USD')),
  amount_ars         NUMERIC(14,2) NOT NULL,
  exchange_rate      NUMERIC(10,4) NOT NULL DEFAULT 1,
  payment_method     TEXT,
  notes              TEXT,
  reference_order_id TEXT,
  reference_employee TEXT,
  created_by         UUID REFERENCES auth.users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bfe_business_date
  ON business_finance_entries(business_id, date DESC);

ALTER TABLE business_finance_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bfe_select" ON business_finance_entries FOR SELECT
  USING (business_id IN (SELECT business_id FROM profiles WHERE id = auth.uid()));
CREATE POLICY "bfe_insert" ON business_finance_entries FOR INSERT
  WITH CHECK (business_id IN (SELECT business_id FROM profiles WHERE id = auth.uid()));
CREATE POLICY "bfe_update" ON business_finance_entries FOR UPDATE
  USING (business_id IN (SELECT business_id FROM profiles WHERE id = auth.uid()));
CREATE POLICY "bfe_delete" ON business_finance_entries FOR DELETE
  USING (business_id IN (SELECT business_id FROM profiles WHERE id = auth.uid()));`}</pre>
              </details>
              <button
                onClick={load}
                style={{
                  marginTop: '0.875rem',
                  display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
                  padding: '0.5rem 1rem',
                  backgroundColor: 'rgba(251,191,36,0.15)',
                  border: '1px solid rgba(251,191,36,0.35)',
                  borderRadius: '0.5rem',
                  color: '#fbbf24', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600,
                }}
              >
                <RefreshCw size={13} /> Reintentar después de ejecutar el SQL
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div style={{
          padding: '0.75rem 1rem', marginBottom: '1rem',
          backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
          borderRadius: '0.5rem', color: '#f87171', display: 'flex', alignItems: 'center', gap: '0.5rem',
          fontSize: '0.875rem',
        }}>
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '6rem' }}>
          <Loader2 size={36} style={{ color: '#6366f1', animation: 'spin 1s linear infinite' }} />
        </div>
      ) : (
        <>
          {/* ── Ganancia Real de Operaciones ── */}
          {opProfit !== null && (
            <div style={{
              background: 'linear-gradient(135deg, rgba(52,211,153,0.06) 0%, rgba(99,102,241,0.06) 100%)',
              border: '1px solid rgba(52,211,153,0.2)',
              borderRadius: '0.875rem',
              padding: '1.25rem 1.5rem',
              marginBottom: '1.25rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
                {/* Left: title + main metric */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <div style={{
                    width: '48px', height: '48px', borderRadius: '0.75rem',
                    background: 'linear-gradient(135deg, rgba(52,211,153,0.2), rgba(16,185,129,0.2))',
                    border: '1px solid rgba(52,211,153,0.3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <Target size={22} style={{ color: '#34d399' }} />
                  </div>
                  <div>
                    <p style={{ margin: 0, fontSize: '0.7rem', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                      Ganancia real de operaciones
                    </p>
                    <p style={{ margin: '0.1rem 0 0', fontSize: '2rem', fontWeight: 900, color: opProfit.totalProfit >= 0 ? '#34d399' : '#f87171', fontFamily: 'monospace', letterSpacing: '-0.03em', lineHeight: 1 }}>
                      {opProfit.totalProfit < 0 ? '−' : '+'}{fmt(Math.abs(opProfit.totalProfit))}
                    </p>
                    <p style={{ margin: '0.2rem 0 0', fontSize: '0.72rem', color: '#475569' }}>
                      {opProfit.count} repuestos/servicios · cobrado {fmt(opProfit.totalRevenue)} · costo {fmt(opProfit.totalCost)}
                    </p>
                  </div>
                </div>

                {/* Middle: margin + secondary metrics */}
                <div style={{ display: 'flex', gap: '1.5rem' }}>
                  <div style={{ textAlign: 'center' }}>
                    <p style={{ margin: 0, fontSize: '0.65rem', color: '#334155', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Margen</p>
                    <p style={{ margin: '0.1rem 0 0', fontSize: '1.25rem', fontWeight: 800, color: '#818cf8', fontFamily: 'monospace' }}>
                      {opProfit.margin.toFixed(1)}%
                    </p>
                  </div>
                </div>

                {/* Right: top items mini-ranking */}
                {opProfit.topItems.length > 0 && (
                  <div style={{ flex: 1, minWidth: '200px', maxWidth: '380px' }}>
                    <p style={{ margin: '0 0 0.5rem', fontSize: '0.65rem', color: '#334155', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <Award size={10} /> Top rentables
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      {opProfit.topItems.slice(0, 5).map((item, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontSize: '0.65rem', color: '#334155', width: '12px', textAlign: 'center' }}>{i + 1}</span>
                          <div style={{
                            flex: 1, height: '4px', borderRadius: '2px',
                            backgroundColor: 'rgba(255,255,255,0.04)',
                            overflow: 'hidden',
                          }}>
                            <div style={{
                              height: '100%',
                              width: `${opProfit.topItems[0].profit > 0 ? (item.profit / opProfit.topItems[0].profit) * 100 : 0}%`,
                              background: 'linear-gradient(90deg, #34d399, #10b981)',
                              borderRadius: '2px',
                            }} />
                          </div>
                          <span style={{ fontSize: '0.72rem', color: '#94a3b8', maxWidth: '110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {item.name}
                          </span>
                          <span style={{ fontSize: '0.7rem', color: '#34d399', fontFamily: 'monospace', fontWeight: 700, flexShrink: 0 }}>
                            {fmtCompact(item.profit)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Full ranking table (when more than 5) */}
              {opProfit.topItems.length > 5 && (
                <div style={{ marginTop: '1rem', paddingTop: '0.875rem', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {opProfit.topItems.slice(5).map((item, i) => (
                      <span key={i} style={{
                        padding: '0.2rem 0.625rem', borderRadius: '999px', fontSize: '0.72rem',
                        backgroundColor: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.15)',
                        color: '#64748b',
                      }}>
                        {item.name} · <span style={{ color: '#34d399' }}>{fmtCompact(item.profit)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Status Banner ── */}
          <StatusBanner status={summary.status} net={summary.netResult} />

          {/* ── KPI Cards ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '0.875rem', marginBottom: '1.25rem' }}>
            <MetricCard
              icon={ArrowUpRight} label="Ingresos del período" value={fmtCompact(summary.totalIncome)}
              sub={`${entries.filter(e => e.type === 'income').length} movimientos`}
              color="#34d399" accent="rgba(52,211,153,0.12)"
            />
            <MetricCard
              icon={ArrowDownRight} label="Costos variables" value={fmtCompact(summary.variableCosts)}
              sub={`${entries.filter(e => e.type === 'variable_cost').length} movimientos`}
              color="#f97316" accent="rgba(249,115,22,0.12)"
            />
            <MetricCard
              icon={TrendingUp} label="Margen bruto" value={fmtCompact(summary.grossMargin)}
              formula="Ingresos − Costos variables"
              sub={summary.totalIncome > 0 ? `${summary.grossMarginPct.toFixed(1)}% del ingreso` : undefined}
              color={summary.grossMargin >= 0 ? '#818cf8' : '#f87171'} accent="rgba(99,102,241,0.12)"
            />
            <MetricCard
              icon={Building2} label="Costos fijos del local" value={fmtCompact(summary.fixedLocalCosts)}
              sub={`${entries.filter(e => e.type === 'fixed_cost_local').length} ítems`}
              color="#f87171" accent="rgba(248,113,113,0.12)"
            />
            <MetricCard
              icon={Users} label="Sueldos y retiros" value={fmtCompact(summary.salaries)}
              sub={`${entries.filter(e => e.type === 'salary').length} registros`}
              color="#60a5fa" accent="rgba(96,165,250,0.12)"
            />
            <MetricCard
              icon={User} label="Costos fijos personales" value={fmtCompact(summary.personalCosts)}
              sub={`${entries.filter(e => e.type === 'fixed_cost_personal').length} ítems`}
              color="#c084fc" accent="rgba(192,132,252,0.12)"
            />
            <MetricCard
              icon={DollarSign} label="Resultado neto" value={fmtCompact(summary.netResult)}
              formula="Margen − Fijos − Sueldos − Personal"
              color={summary.netResult >= 0 ? '#34d399' : '#f87171'} accent={summary.netResult >= 0 ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)'}
            />
            <MetricCard
              icon={Wallet} label="Total movimientos" value={String(entries.length)}
              sub={`En el período seleccionado`}
              color="#fbbf24" accent="rgba(251,191,36,0.12)"
            />
          </div>

          {/* ── Charts + Break-Even ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.25rem' }}>
            {/* Charts panel */}
            <div style={{ ...cardStyle }}>
              {/* Chart tabs */}
              <div style={{ display: 'flex', gap: '0.375rem', marginBottom: '1rem', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '0.75rem' }}>
                {([
                  { key: 'bars', label: 'Ingresos vs Egresos' },
                  { key: 'donut', label: 'Distribución' },
                  { key: 'line', label: 'Evolución neta' },
                ] as const).map(tab => (
                  <button key={tab.key} onClick={() => setActiveChartTab(tab.key)} style={{
                    padding: '0.3rem 0.625rem', borderRadius: '0.35rem', fontSize: '0.72rem',
                    fontWeight: 500, cursor: 'pointer',
                    backgroundColor: activeChartTab === tab.key ? 'rgba(99,102,241,0.2)' : 'transparent',
                    border: `1px solid ${activeChartTab === tab.key ? 'rgba(99,102,241,0.4)' : 'transparent'}`,
                    color: activeChartTab === tab.key ? '#818cf8' : '#475569',
                  }}>
                    {tab.label}
                  </button>
                ))}
              </div>

              <div style={{ height: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {activeChartTab === 'bars' && (
                  monthlyData.length > 0
                    ? <BarChart data={monthlyData} />
                    : <span style={{ color: '#334155', fontSize: '0.8rem' }}>Sin datos de los últimos meses</span>
                )}
                {activeChartTab === 'donut' && (
                  distribution.length > 0
                    ? <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', width: '100%' }}>
                        <div style={{ width: '140px', height: '140px', flexShrink: 0 }}>
                          <DonutChart slices={distribution} />
                        </div>
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                          {distribution.map(s => (
                            <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <div style={{ width: '8px', height: '8px', borderRadius: '2px', backgroundColor: s.color, flexShrink: 0 }} />
                              <span style={{ fontSize: '0.72rem', color: '#64748b', flex: 1 }}>{s.label}</span>
                              <span style={{ fontSize: '0.72rem', color: '#94a3b8', fontFamily: 'monospace' }}>{s.pct.toFixed(1)}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    : <span style={{ color: '#334155', fontSize: '0.8rem' }}>Sin egresos en el período</span>
                )}
                {activeChartTab === 'line' && (
                  monthlyData.length >= 2
                    ? <LineChart data={monthlyData} />
                    : <span style={{ color: '#334155', fontSize: '0.8rem' }}>Se necesitan al menos 2 meses de datos</span>
                )}
              </div>
            </div>

            {/* Break-even */}
            <BreakEvenSection summary={summary} />
          </div>

          {/* ── Cascada financiera ── */}
          <div style={{ ...cardStyle, marginBottom: '1.25rem' }}>
            <h3 style={{ margin: '0 0 1rem', fontSize: '0.875rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Cascada de resultados
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
              {[
                { label: 'Ingresos totales', value: summary.totalIncome, color: '#34d399', isHeader: true },
                { label: '− Costos variables', value: -summary.variableCosts, color: '#f97316', sub: true },
                { label: '= Margen bruto', value: summary.grossMargin, color: summary.grossMargin >= 0 ? '#818cf8' : '#f87171', isResult: true },
                { label: '− Costos fijos del local', value: -summary.fixedLocalCosts, color: '#f87171', sub: true },
                { label: '= Resultado operativo', value: summary.operatingResult, color: summary.operatingResult >= 0 ? '#818cf8' : '#f87171', isResult: true },
                { label: '− Sueldos y retiros', value: -summary.salaries, color: '#60a5fa', sub: true },
                { label: '= Resultado después de sueldos', value: summary.resultAfterSalaries, color: summary.resultAfterSalaries >= 0 ? '#818cf8' : '#f87171', isResult: true },
                { label: '− Costos fijos personales', value: -summary.personalCosts, color: '#c084fc', sub: true },
                { label: '= Resultado financiero real', value: summary.netResult, color: summary.netResult >= 0 ? '#34d399' : '#f87171', isResult: true, isFinal: true },
              ].map((row, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: `${row.isFinal ? '0.875rem' : '0.5rem'} 0.875rem`,
                  paddingLeft: row.sub ? '1.5rem' : '0.875rem',
                  backgroundColor: row.isFinal ? `${row.color}10` : row.isResult ? 'rgba(255,255,255,0.02)' : 'transparent',
                  borderTop: row.isResult ? '1px solid rgba(255,255,255,0.05)' : 'none',
                  borderBottom: row.isFinal ? `2px solid ${row.color}40` : 'none',
                  borderRadius: row.isFinal ? '0.5rem' : 0,
                  marginTop: row.isFinal ? '0.25rem' : 0,
                }}>
                  <span style={{
                    fontSize: row.isFinal ? '0.9rem' : '0.82rem',
                    fontWeight: row.isResult ? 700 : 400,
                    color: row.isResult ? '#cbd5e1' : '#64748b',
                  }}>
                    {row.label}
                  </span>
                  <span style={{
                    fontFamily: 'monospace',
                    fontSize: row.isFinal ? '1.1rem' : '0.9rem',
                    fontWeight: row.isResult ? 800 : 500,
                    color: row.color,
                  }}>
                    {row.value < 0 ? '−' : ''}{fmt(Math.abs(row.value))}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ── View Tabs ── */}
          <div style={{ display: 'flex', gap: '0.375rem', marginBottom: '0.875rem', flexWrap: 'wrap' }}>
            {VIEWS.map(v => {
              const Icon = v.icon
              return (
                <button key={v.value} onClick={() => setView(v.value)} style={{
                  display: 'flex', alignItems: 'center', gap: '0.375rem',
                  padding: '0.4rem 0.875rem', borderRadius: '0.5rem', fontSize: '0.8rem',
                  fontWeight: 500, cursor: 'pointer', transition: 'all 0.15s',
                  backgroundColor: view === v.value ? 'rgba(99,102,241,0.18)' : 'transparent',
                  border: `1px solid ${view === v.value ? 'rgba(99,102,241,0.4)' : 'rgba(255,255,255,0.06)'}`,
                  color: view === v.value ? '#818cf8' : '#475569',
                }}>
                  <Icon size={13} />
                  {v.label}
                </button>
              )
            })}
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#334155', alignSelf: 'center' }}>
              {visibleEntries.length} registro{visibleEntries.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* ── Movements Table ── */}
          <MovementsTable
            entries={visibleEntries}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        </>
      )}

      {/* end movimientos tab */}
      </>}

      {/* ── Entry Modal ── */}
      {showModal && (
        <EntryModal
          entry={editingEntry}
          exchangeRate={exchangeRate}
          businessId={businessId!}
          userId={user!.id}
          onClose={() => { setShowModal(false); setEditingEntry(null) }}
          onSaved={handleModalSaved}
        />
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
