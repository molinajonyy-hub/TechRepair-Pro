import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  TrendingUp, TrendingDown, DollarSign, BarChart3, Plus,
  Loader2, AlertCircle, CheckCircle, Pencil, Trash2, RefreshCw,
  ArrowUpRight, ArrowDownRight, Minus, Filter,
  Wallet, Building2, User, Users, Layers, Activity, Award, Target,
  Package, RepeatIcon, History, CheckCircle2, X,
} from 'lucide-react'
import { useRecurringExpenses, RecurringExpenseWithStatus } from '../hooks/useRecurringExpenses'
import { CloseButton } from '../components/ui/CloseButton'
import { EmptyState } from '../components/ui/EmptyState'
import { FinanceBarChart } from '../components/finance/FinanceBarChart'
import { FinanceDonutChart } from '../components/finance/FinanceDonutChart'
import { FinanceLineChart } from '../components/finance/FinanceLineChart'
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
} from '../services/financeService'
import { getFinancialSummary, type FinancialSummary as UnifiedSummary } from '../services/financialMetricsService'

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

import { fmtDateFull as fmtDate } from '../utils/dateUtils'

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

// Charts extraídos a src/components/finance/ — FinanceBarChart, FinanceDonutChart, FinanceLineChart

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
  // Recurring toggle — disponible para gastos fijos y sueldos al crear
  const [isRecurring, setIsRecurring] = useState(false)
  const [recurringName, setRecurringName] = useState('')
  const [recurringDay, setRecurringDay] = useState('1')

  const typeDef = getTypeDef(form.type)
  const isEdit = !!entry
  const isRecurringEligible = form.type === 'fixed_cost_local' || form.type === 'fixed_cost_personal' || form.type === 'salary'

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
    if (form.currency === 'USD' && exchangeRate <= 0) { setError('El tipo de cambio no está disponible. Actualizalo en Configuración de Moneda.'); return }
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
      if (isEdit) {
        await financeService.updateEntry(entry!.id, payload)
      } else {
        // Crear la entrada
        let recurringId: string | undefined
        if (isRecurring && isRecurringEligible) {
          const name = (recurringName.trim() || form.description.trim() || getCategoryLabel(form.type as EntryType, form.category))
          const { data: rec } = await supabase
            .from('recurring_expenses')
            .insert({
              business_id: businessId,
              name,
              type: form.type,
              category: form.category,
              subcategory: form.subcategory || undefined,
              amount,
              currency: form.currency,
              day_of_month: parseInt(recurringDay) || 1,
              notes: form.notes || undefined,
            })
            .select('id')
            .single()
          recurringId = rec?.id
        }
        await financeService.createEntry({ ...payload, recurring_expense_id: recurringId } as any)
      }
      onSaved()
    } catch (err: any) {
      setError(err.message ?? 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay-dark" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-card modal-card-lg">
        {/* Header */}
        <div className="modal-hdr">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <div style={{ width: '34px', height: '34px', borderRadius: '0.5rem', backgroundColor: `${typeDef.color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <DollarSign size={17} style={{ color: typeDef.color }} />
            </div>
            <h3 style={{ margin: 0 }}>{isEdit ? 'Editar movimiento' : 'Nuevo movimiento'}</h3>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        <form onSubmit={handleSubmit} className="modal-body-scroll" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {error && <div className="alert-inline alert-error"><AlertCircle size={14} /> {error}</div>}

          {/* Type selector */}
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.3rem' }}>Tipo de movimiento</label>
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
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.3rem' }}>Fecha</label>
              <input type="date" value={form.date} onChange={e => set('date', e.target.value)} className="form-control" required />
            </div>
            <div>
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.3rem' }}>Moneda</label>
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
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.3rem' }}>Categoría</label>
              <select value={form.category} onChange={e => set('category', e.target.value)} className="form-select" required>
                <option value="">Seleccionar...</option>
                {typeDef.categories.map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.3rem' }}>Subcategoría (opcional)</label>
              <input type="text" value={form.subcategory} onChange={e => set('subcategory', e.target.value)}
                placeholder="Ej: Factura EDESUR" className="form-control" />
            </div>
          </div>

          {/* Description + Amount */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.3rem' }}>Descripción</label>
              <input type="text" value={form.description} onChange={e => set('description', e.target.value)}
                placeholder="Descripción del movimiento" className="form-control" />
            </div>
            <div>
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.3rem' }}>Monto ({form.currency})</label>
              <input type="number" min="0.01" step="0.01" value={form.amount}
                onChange={e => set('amount', e.target.value)} placeholder="0.00"
                className="form-control mono" style={{ fontSize: '1rem', color: typeDef.color }}
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
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.3rem' }}>Método de pago</label>
            <select value={form.payment_method} onChange={e => set('payment_method', e.target.value)} className="form-select">
              <option value="">Sin especificar</option>
              {PAYMENT_METHODS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          {/* References */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.3rem' }}>N° Orden / Comprobante (opcional)</label>
              <input type="text" value={form.reference_order_id}
                onChange={e => set('reference_order_id', e.target.value)}
                placeholder="Ej: ORD-0042" className="form-control" />
            </div>
            <div>
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.3rem' }}>Empleado relacionado (opcional)</label>
              <input type="text" value={form.reference_employee}
                onChange={e => set('reference_employee', e.target.value)}
                placeholder="Nombre del empleado" className="form-control" />
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.3rem' }}>Observaciones</label>
            <textarea value={form.notes} onChange={e => set('notes', e.target.value)}
              placeholder="Notas adicionales..."
              rows={2}
              className="form-control" style={{ resize: 'vertical' }} />
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '0.625rem', paddingTop: '0.25rem' }}>
            <button type="button" onClick={onClose} className="btn btn-ghost" style={{ flex: 1 }}>Cancelar</button>
            <button type="submit" disabled={saving} className="btn btn-primary btn-lift" style={{ flex: 2 }}>
              {saving
                ? <><Loader2 size={15} style={{ animation: 'tr-spin 1s linear infinite' }} /> Guardando...</>
                : <><CheckCircle size={15} /> {isEdit ? 'Actualizar' : 'Guardar movimiento'}</>}
            </button>
          </div>

          {/* Toggle recurrente — para gastos fijos y sueldos al crear */}
          {!isEdit && isRecurringEligible && (
            <div style={{ marginTop: '0.5rem', border: `1px solid ${isRecurring ? 'rgba(99,102,241,0.35)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '0.75rem', overflow: 'hidden', transition: 'border-color 0.2s' }}>
              <button type="button" onClick={() => setIsRecurring(r => !r)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', background: isRecurring ? 'rgba(99,102,241,0.08)' : 'rgba(255,255,255,0.02)', border: 'none', cursor: 'pointer', transition: 'background 0.15s' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                  <RepeatIcon size={15} style={{ color: isRecurring ? '#818cf8' : '#475569' }} />
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: isRecurring ? '#c7d2fe' : '#94a3b8' }}>Repetir mensualmente</div>
                    <div style={{ fontSize: '0.72rem', color: '#475569' }}>
                      {form.type === 'salary' ? 'Agrega este sueldo a los recurrentes mensuales' : 'Agrega este gasto a la lista de recurrentes'}
                    </div>
                  </div>
                </div>
                <div style={{ width: 36, height: 20, borderRadius: 10, background: isRecurring ? '#6366f1' : 'rgba(255,255,255,0.12)', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                  <div style={{ position: 'absolute', top: 2, left: isRecurring ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                </div>
              </button>
              {isRecurring && (
                <div style={{ padding: '0 1rem 0.875rem', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.68rem', color: '#64748b', fontWeight: 600, marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Nombre del gasto recurrente
                    </label>
                    <input type="text" value={recurringName} onChange={e => setRecurringName(e.target.value)}
                      placeholder={form.description || getCategoryLabel(form.type as EntryType, form.category) || 'Ej: Alquiler del local'}
                      className="form-control" />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.68rem', color: '#64748b', fontWeight: 600, marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Día del mes en que vence
                    </label>
                    <input type="number" value={recurringDay} onChange={e => setRecurringDay(e.target.value)} min="1" max="28"
                      className="form-control" style={{ maxWidth: 100 }} />
                  </div>
                </div>
              )}
            </div>
          )}
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
      <EmptyState
        icon={DollarSign}
        title="Sin movimientos en este período"
        description={'Hacé clic en "Nuevo movimiento" para registrar el primero'}
      />
    )
  }

  return (
    <div className="surface-raised table-wrap" style={{ overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              {['Fecha', 'Tipo', 'Categoría', 'Descripción', 'Moneda', 'Monto ARS', 'Pago', ''].map(h => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map(e => {
              const tDef = getTypeDef(e.type)
              return (
                <tr key={e.id}>
                  <td className="body-sm" style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.date)}</td>
                  <td>
                    <span className="badge" style={{ background: tDef.bgColor, color: tDef.color }}>
                      {tDef.label}
                    </span>
                  </td>
                  <td>
                    {getCategoryLabel(e.type, e.category)}
                    {e.subcategory && <span className="body-sm" style={{ display: 'block' }}>{e.subcategory}</span>}
                  </td>
                  <td style={{ maxWidth: '200px' }}>
                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.description || '—'}
                    </span>
                    {e.notes && (
                      <span className="body-sm" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.notes}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={e.currency === 'USD' ? 'badge badge-info' : 'badge badge-success'} style={{ fontSize: '0.7rem' }}>
                      {e.currency}
                    </span>
                  </td>
                  <td className="mono" style={{ fontWeight: 700, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <span style={{ color: e.type === 'income' ? '#34d399' : '#f87171' }}>
                      {e.type === 'income' ? '+' : '−'}{fmt(e.amount_ars)}
                    </span>
                  </td>
                  <td className="body-sm">{PAYMENT_METHODS.find(m => m.value === e.payment_method)?.label ?? '—'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.25rem', justifyContent: 'flex-end' }}>
                      <button onClick={() => onEdit(e)} className="icon-btn icon-btn-primary" title="Editar"><Pencil size={13} /></button>
                      <button onClick={() => onDelete(e.id)} className="icon-btn icon-btn-danger" title="Eliminar"><Trash2 size={13} /></button>
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
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', padding: '0.5rem 0' }}>
      {[0,1,2,3,4,5].map(i => (
        <div key={i} style={{ padding: '1.25rem', backgroundColor: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.75rem' }}>
          <div style={{ height: '0.75rem', width: '55%', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: '0.25rem', marginBottom: '0.75rem' }} />
          <div style={{ height: '1.5rem', width: '40%', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: '0.25rem' }} />
        </div>
      ))}
    </div>
  )

  if (!data) return (
    <EmptyState icon={Package} title="No hay datos de inventario disponibles" description="Agregá productos al inventario para ver las métricas" />
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

      {/* ── Alerta: productos sin costo ── */}
      {(() => {
        const sinCosto = data.products.filter(p => p.stock > 0 && p.costPrice === 0)
        if (sinCosto.length === 0) return null
        return (
          <div className="alert-inline alert-warning" style={{ marginBottom: '1.25rem', alignItems: 'flex-start' }}>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
            <div>
              <p style={{ margin: 0, fontWeight: 700, fontSize: '0.85rem' }}>
                {sinCosto.length} producto{sinCosto.length > 1 ? 's' : ''} con stock sin precio de costo
              </p>
              <p className="body-sm" style={{ margin: '0.2rem 0 0' }}>
                El capital invertido puede estar subestimado. Editá cada producto en Inventario y completá el precio de costo.
              </p>
              <p className="body-sm" style={{ margin: '0.35rem 0 0' }}>
                {sinCosto.slice(0, 5).map(p => p.name).join(', ')}{sinCosto.length > 5 ? ` y ${sinCosto.length - 5} más` : ''}
              </p>
            </div>
          </div>
        )
      })()}

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
                  Registrá compras a proveedores o facturas en Gastos para comparar la evolución del capital.
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
      <div className="surface-raised" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Package size={15} style={{ color: 'var(--accent-primary)' }} />
          <h3 className="label-caps" style={{ margin: 0 }}>Rentabilidad por producto</h3>
          <span className="body-sm" style={{ marginLeft: 'auto' }}>
            {data.products.length} producto{data.products.length !== 1 ? 's' : ''}
          </span>
          <span className="body-sm" style={{ fontStyle: 'italic' }}>Clic en encabezado para ordenar</span>
        </div>
        <div className="table-wrap">
          <table className="data-table" style={{ fontSize: '0.8rem' }}>
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

// ─── Recurring Expenses Panel ─────────────────────────────────────────────────

const fmtARS = (v: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(v || 0)

interface RegisterPaymentModalProps {
  expense: RecurringExpenseWithStatus
  exchangeRate: number
  businessId: string
  userId: string
  onClose: () => void
  onSaved: () => void
}

function RegisterPaymentModal({ expense, exchangeRate, businessId, userId, onClose, onSaved }: RegisterPaymentModalProps) {
  const today = new Date().toISOString().split('T')[0]
  const [amount, setAmount] = useState(String(expense.amount))
  const [currency, setCurrency] = useState<'ARS' | 'USD'>(expense.currency as 'ARS' | 'USD')
  const [date, setDate] = useState(today)
  const [paymentMethod, setPaymentMethod] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const amountNum = parseFloat(amount) || 0
  const amountArs = currency === 'USD' ? amountNum * exchangeRate : amountNum

  const handleSave = async () => {
    if (amountNum <= 0) { setErr('Ingresá un monto válido'); return }
    setSaving(true)
    setErr('')
    try {
      const { error } = await supabase
        .from('business_finance_entries')
        .insert({
          business_id: businessId,
          date,
          type: expense.type,
          category: expense.category,
          subcategory: expense.subcategory || undefined,
          description: expense.name,
          amount: amountNum,
          currency,
          amount_ars: amountArs,
          exchange_rate: currency === 'USD' ? exchangeRate : 1,
          payment_method: paymentMethod || undefined,
          notes: notes || undefined,
          recurring_expense_id: expense.id,
          created_by: userId,
        })
      if (error) throw error
      onSaved()
      onClose()
    } catch (e: any) {
      setErr(e.message || 'Error al registrar pago')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay-dark" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-card">
        <div className="modal-hdr">
          <div>
            <h3 style={{ margin: 0 }}>Registrar pago</h3>
            <p className="body-sm" style={{ margin: 0 }}>{expense.name}</p>
          </div>
          <button onClick={onClose} className="icon-btn" aria-label="Cerrar"><X size={15} /></button>
        </div>

        <div className="modal-body-scroll" style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Monto</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} min="0" step="0.01" className="form-control" style={{ flex: 1 }} />
              <div style={{ display: 'flex', gap: '0.25rem' }}>
                {(['ARS', 'USD'] as const).map(c => (
                  <button key={c} onClick={() => setCurrency(c)} className={`badge ${currency === c ? 'badge-info' : 'badge-neutral'}`} style={{ cursor: 'pointer', border: 'none', padding: '0.375rem 0.625rem', fontSize: '0.75rem' }}>{c}</button>
                ))}
              </div>
            </div>
            {currency === 'USD' && exchangeRate > 1 && (
              <p className="body-sm" style={{ margin: '0.25rem 0 0' }}>= {fmtARS(amountArs)}</p>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <div>
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Fecha</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className="form-control" />
            </div>
            <div>
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Método de pago</label>
              <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} className="form-select">
                <option value="">— Sin especificar</option>
                <option value="efectivo">Efectivo</option>
                <option value="transferencia">Transferencia</option>
                <option value="tarjeta_debito">Débito</option>
                <option value="tarjeta_credito">Crédito</option>
              </select>
            </div>
          </div>

          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Notas (opcional)</label>
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Ej: con aumento" className="form-control" />
          </div>

          {err && <div className="alert-inline alert-error">{err}</div>}
        </div>

        <div className="modal-ftr">
          <button onClick={handleSave} disabled={saving} className="btn btn-success btn-lift btn-full">
            {saving ? <><Loader2 size={16} style={{ animation: 'tr-spin 1s linear infinite' }} /> Guardando...</> : <><CheckCircle size={15} /> Registrar pago</>}
          </button>
        </div>
      </div>
    </div>
  )
}

interface EditRecurringModalProps {
  expense: RecurringExpenseWithStatus
  onClose: () => void
  onSaved: () => void
}

function EditRecurringModal({ expense, onClose, onSaved }: EditRecurringModalProps) {
  const { update } = useRecurringExpenses()
  const [name, setName] = useState(expense.name)
  const [amount, setAmount] = useState(String(expense.amount))
  const [dayOfMonth, setDayOfMonth] = useState(String(expense.day_of_month))
  const [notes, setNotes] = useState(expense.notes || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const handleSave = async () => {
    const amountNum = parseFloat(amount)
    if (!name.trim()) { setErr('El nombre es requerido'); return }
    if (!amountNum || amountNum <= 0) { setErr('El monto debe ser mayor a 0'); return }
    setSaving(true)
    setErr('')
    try {
      await update(expense.id, {
        name: name.trim(),
        amount: amountNum,
        day_of_month: parseInt(dayOfMonth) || 1,
        notes: notes.trim() || undefined,
      })
      onSaved()
      onClose()
    } catch (e: any) {
      setErr(e.message || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay-dark" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-card">
        <div className="modal-hdr">
          <h3 style={{ margin: 0 }}>Editar gasto recurrente</h3>
          <button onClick={onClose} className="icon-btn" aria-label="Cerrar"><X size={15} /></button>
        </div>
        <div className="modal-body-scroll" style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Nombre</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} className="form-control" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <div>
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Monto esperado</label>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} min="0" className="form-control" />
            </div>
            <div>
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Día del mes</label>
              <input type="number" value={dayOfMonth} onChange={e => setDayOfMonth(e.target.value)} min="1" max="28" className="form-control" />
            </div>
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Notas</label>
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Proveedor, referencia, etc." className="form-control" />
          </div>
          {err && <div className="alert-inline alert-error">{err}</div>}
        </div>
        <div className="modal-ftr">
          <button onClick={handleSave} disabled={saving} className="btn btn-primary btn-lift btn-full">
            {saving ? 'Guardando...' : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface HistoryModalProps {
  expense: RecurringExpenseWithStatus
  loadHistory: (id: string) => Promise<any[]>
  onClose: () => void
}

function HistoryModal({ expense, loadHistory, onClose }: HistoryModalProps) {
  const [history, setHistory] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadHistory(expense.id).then(h => { setHistory(h); setLoading(false) })
  }, [expense.id])

  const monthLabel = (dateStr: string) => {
    const d = new Date(dateStr + 'T00:00:00')
    return d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })
  }

  return (
    <div className="modal-overlay-dark" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-card">
        <div className="modal-hdr">
          <div>
            <h3 style={{ margin: 0 }}>Historial de pagos</h3>
            <p className="body-sm" style={{ margin: 0 }}>{expense.name} · últimos 24 meses</p>
          </div>
          <button onClick={onClose} className="icon-btn" aria-label="Cerrar"><X size={15} /></button>
        </div>
        <div className="modal-body-scroll">
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
              <Loader2 size={20} style={{ animation: 'tr-spin 1s linear infinite', color: 'var(--text-muted)' }} />
            </div>
          ) : history.length === 0 ? (
            <EmptyState icon={History} title="Sin pagos registrados aún" compact />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {history.map((h, i) => {
                const changed = i < history.length - 1 && h.amount_ars !== history[i + 1].amount_ars
                return (
                  <div key={h.id} className="surface-inset" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.625rem 0.875rem' }}>
                    <div>
                      <div style={{ fontSize: '0.875rem', color: 'var(--text-primary)', fontWeight: 500, textTransform: 'capitalize' }}>{monthLabel(h.date)}</div>
                      {h.notes && <div className="body-sm" style={{ marginTop: '0.125rem' }}>{h.notes}</div>}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="mono" style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f87171' }}>
                        {fmtARS(h.amount_ars)}
                      </div>
                      {changed && <div className="body-sm" style={{ color: '#f59e0b', marginTop: '0.1rem' }}>monto cambió</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <div className="modal-ftr" style={{ justifyContent: 'space-between' }}>
          <span className="body-sm">{history.length} registro{history.length !== 1 ? 's' : ''}</span>
          {history.length > 0 && (
            <span className="body-sm">Promedio: {fmtARS(history.reduce((s, h) => s + h.amount_ars, 0) / history.length)}</span>
          )}
        </div>
      </div>
    </div>
  )
}

interface RecurringExpensesPanelProps {
  businessId: string
  userId: string
  exchangeRate: number
  onEntryCreated: () => void
}

function RecurringExpensesPanel({ businessId, userId, exchangeRate, onEntryCreated }: RecurringExpensesPanelProps) {
  const { expenses, loading, error, load, deactivate, loadHistory } = useRecurringExpenses()
  const [paying, setPaying] = useState<RecurringExpenseWithStatus | null>(null)
  const [editing, setEditing] = useState<RecurringExpenseWithStatus | null>(null)
  const [viewHistory, setViewHistory] = useState<RecurringExpenseWithStatus | null>(null)
  const [confirmDeactivate, setConfirmDeactivate] = useState<string | null>(null)

  const now = new Date()
  const monthName = now.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })

  const pendingCount = expenses.filter(e => !e.paid_this_month).length
  const totalExpected = expenses.reduce((s, e) => s + e.amount, 0)
  const totalPaid = expenses.filter(e => e.paid_this_month).reduce((s, e) => s + (e.paid_amount || 0), 0)

  const handleDeactivate = async (id: string) => {
    try { await deactivate(id) } catch {}
    setConfirmDeactivate(null)
  }

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
      <Loader2 size={24} style={{ animation: 'tr-spin 1s linear infinite', color: 'var(--text-muted)' }} />
    </div>
  )

  if (error) return (
    <div className="alert-inline alert-error">{error}</div>
  )

  return (
    <>
      {/* Resumen del mes */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        {[
          { label: `Total esperado — ${monthName}`, value: fmtARS(totalExpected), color: 'var(--text-secondary)' },
          { label: 'Pagado este mes', value: fmtARS(totalPaid), color: '#22c55e' },
          { label: 'Pendientes', value: String(pendingCount), color: pendingCount > 0 ? '#f59e0b' : '#22c55e', suffix: ` gasto${pendingCount !== 1 ? 's' : ''}` },
        ].map(card => (
          <div key={card.label} className="stat-card">
            <div className="stat-card-label">{card.label}</div>
            <div className="stat-card-value mono" style={{ color: card.color }}>
              {card.value}{card.suffix || ''}
            </div>
          </div>
        ))}
      </div>

      {/* Lista de gastos recurrentes */}
      {expenses.length === 0 ? (
        <EmptyState
          icon={RepeatIcon}
          title="Sin gastos recurrentes"
          description={'Al agregar un gasto fijo o sueldo, activá "Repetir mensualmente" para que aparezca aquí'}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {expenses.map(expense => (
            <div key={expense.id} style={{
              background: '#0f1829',
              border: `1px solid ${expense.paid_this_month ? 'rgba(34,197,94,0.2)' : 'rgba(245,158,11,0.2)'}`,
              borderRadius: '0.875rem',
              padding: '1rem 1.25rem',
              display: 'flex', alignItems: 'center', gap: '1rem',
            }}>
              {/* Status indicator */}
              <div style={{ width: 40, height: 40, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: expense.paid_this_month ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)', border: `1px solid ${expense.paid_this_month ? 'rgba(34,197,94,0.3)' : 'rgba(245,158,11,0.3)'}` }}>
                {expense.paid_this_month
                  ? <CheckCircle2 size={18} style={{ color: '#22c55e' }} />
                  : <RepeatIcon size={16} style={{ color: '#f59e0b' }} />}
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#f1f5f9' }}>{expense.name}</span>
                  <span style={{ fontSize: '0.68rem', color: '#475569', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.25rem', padding: '0.1rem 0.4rem' }}>
                    día {expense.day_of_month}
                  </span>
                </div>
                <div style={{ fontSize: '0.78rem', color: '#475569' }}>
                  {expense.paid_this_month ? (
                    <span style={{ color: '#22c55e' }}>
                      ✓ Pagado {fmtARS(expense.paid_amount || 0)}
                      {expense.paid_amount !== expense.amount && expense.amount > 0 && (
                        <span style={{ color: '#f59e0b', marginLeft: '0.375rem' }}>
                          (esperado {fmtARS(expense.amount)})
                        </span>
                      )}
                    </span>
                  ) : (
                    <span style={{ color: '#f59e0b' }}>Pendiente · esperado {fmtARS(expense.amount)}</span>
                  )}
                  {expense.notes && <span style={{ color: '#334155', marginLeft: '0.5rem' }}>· {expense.notes}</span>}
                </div>
              </div>

              {/* Acciones */}
              <div style={{ display: 'flex', gap: '0.375rem', flexShrink: 0 }}>
                {!expense.paid_this_month && (
                  <button onClick={() => setPaying(expense)}
                    style={{ padding: '0.4rem 0.75rem', borderRadius: '0.5rem', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    Registrar pago
                  </button>
                )}
                <button onClick={() => setViewHistory(expense)} title="Ver historial"
                  style={{ width: 32, height: 32, borderRadius: '0.5rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <History size={14} />
                </button>
                <button onClick={() => setEditing(expense)} title="Editar"
                  style={{ width: 32, height: 32, borderRadius: '0.5rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Pencil size={13} />
                </button>
                {confirmDeactivate === expense.id ? (
                  <div style={{ display: 'flex', gap: '0.25rem' }}>
                    <button onClick={() => handleDeactivate(expense.id)}
                      style={{ padding: '0.25rem 0.5rem', borderRadius: '0.375rem', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', fontSize: '0.72rem', cursor: 'pointer' }}>
                      Confirmar
                    </button>
                    <button onClick={() => setConfirmDeactivate(null)}
                      style={{ padding: '0.25rem 0.5rem', borderRadius: '0.375rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#64748b', fontSize: '0.72rem', cursor: 'pointer' }}>
                      Cancelar
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmDeactivate(expense.id)} title="Desactivar"
                    style={{ width: 32, height: 32, borderRadius: '0.5rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modales */}
      {paying && (
        <RegisterPaymentModal
          expense={paying}
          exchangeRate={exchangeRate}
          businessId={businessId}
          userId={userId}
          onClose={() => setPaying(null)}
          onSaved={() => { load(); onEntryCreated() }}
        />
      )}
      {editing && (
        <EditRecurringModal
          expense={editing}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
      {viewHistory && (
        <HistoryModal
          expense={viewHistory}
          loadHistory={loadHistory}
          onClose={() => setViewHistory(null)}
        />
      )}
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
  const [activeMainTab, setActiveMainTab] = useState<'movimientos' | 'inventario' | 'recurrentes'>('movimientos')
  const [invData, setInvData] = useState<InvAnalytics | null>(null)

  // Resumen financiero unificado
  const [unifiedSummary, setUnifiedSummary] = useState<UnifiedSummary | null>(null)

  // Ganancia real de operaciones (comprobante_items) — se llena desde unifiedSummary
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
      const [rate, fetched, monthly, unified] = await Promise.all([
        currencyService.getCurrentExchangeRate('USD', 'ARS').catch(() => 1),
        financeService.getEntries(businessId, from, to).catch((err: any) => {
          if (err?.message?.includes('schema cache') || err?.code === 'PGRST200' || err?.message?.includes('business_finance_entries')) {
            setTableReady(false)
            return []
          }
          throw err
        }),
        financeService.getLastMonths(businessId, 6).catch(() => []),
        getFinancialSummary(businessId, from, to).catch(() => null),
      ])
      setTableReady(true)
      setExchangeRate(rate || 1)
      setEntries(fetched)
      setMonthlyData(buildMonthlyEvolution(monthly))
      setUnifiedSummary(unified)
      if (unified) {
        console.log('[Finance] Resumen unificado:', unified._debug)
      }

      // opProfit se llena desde el servicio unificado (ya calculado arriba)
      if (unified) {
        setOpProfit({
          totalRevenue: unified.opRevenue,
          totalCost:    unified.opCogs,
          totalProfit:  unified.opProfit,
          margin:       unified.opMarginPct,
          count:        unified.opItemsCount,
          topItems:     [],  // TODO: si se necesita top items, extender el servicio
        })
      }

      // ── Inventory Analytics ──
      try {
        const { data: rawInv } = await supabase
          .from('inventory')
          .select('id, name, category, stock_quantity, cost_price, sale_price, supplier_code')
          .eq('business_id', businessId)
          .eq('is_active', true)

        // Detectar variantes y productos-padre con variantes.
        // Convención: las variantes tienen supplier_code = 'VPREF-<id_del_padre>'.
        // Los productos base con variantes no deben contarse en el capital
        // (su stock y precio vive en las variantes), solo los productos simples
        // y las variantes cuentan.
        const VARIANT_PARENT_PREFIX = 'VPREF-'
        const rawInvArr = rawInv || []
        const parentIdsWithVariants = new Set<string>()
        rawInvArr.forEach((it: any) => {
          const sc = typeof it.supplier_code === 'string' ? it.supplier_code : ''
          if (sc.startsWith(VARIANT_PARENT_PREFIX)) {
            const pid = sc.slice(VARIANT_PARENT_PREFIX.length)
            if (pid) parentIdsWithVariants.add(pid)
          }
        })
        const invArr = rawInvArr.filter((it: any) => !parentIdsWithVariants.has(it.id))

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

        // Lee supplier_purchases (módulo Proveedores + Gastos tipo Factura)
        const [currPurch, prevPurch] = await Promise.all([
          supabase.from('supplier_purchases').select('total_amount').eq('business_id', businessId)
            .gte('purchase_date', from).lte('purchase_date', to),
          supabase.from('supplier_purchases').select('total_amount').eq('business_id', businessId)
            .gte('purchase_date', prevFrom).lt('purchase_date', from),
        ])

        const comprasCurrent = (currPurch.data || []).reduce((s: number, p: any) => s + (p.total_amount || 0), 0)
        const comprasPrev = (prevPurch.data || []).reduce((s: number, p: any) => s + (p.total_amount || 0), 0)
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

  // Calcular summary desde BFE (para distribución, lista de entradas, etc.)
  const rawSummary  = useMemo(() => calculateSummary(entries), [entries])
  const distribution = useMemo(() => buildExpenseDistribution(entries), [entries])
  const visibleEntries = useMemo(() => filterByView(entries, view), [entries, view])

  // Sobrescribir con datos corregidos del servicio unificado cuando estén disponibles.
  // El servicio unificado filtra income de comprobantes DRAFT, evitando inflación.
  const summary = useMemo<FinanceSummary>(() => unifiedSummary ? {
    totalIncome:          unifiedSummary.ingresosPeriodo,
    variableCosts:        unifiedSummary.costosVariables,
    grossMargin:          unifiedSummary.margenBruto,
    grossMarginPct:       unifiedSummary.margenBrutoPct,
    fixedLocalCosts:      unifiedSummary.costosFijosLocal,
    operatingResult:      unifiedSummary.margenBruto - unifiedSummary.costosFijosLocal,
    salaries:             unifiedSummary.sueldosRetiros,
    resultAfterSalaries:  unifiedSummary.margenBruto - unifiedSummary.costosFijosLocal - unifiedSummary.sueldosRetiros,
    personalCosts:        unifiedSummary.costosFijosPersonales,
    netResult:            unifiedSummary.resultadoNeto,
    breakEvenPoint:       rawSummary.breakEvenPoint,
    status: unifiedSummary.resultadoNeto > 500 ? 'positive'
          : unifiedSummary.resultadoNeto < -500 ? 'negative' : 'break_even',
  } : rawSummary, [unifiedSummary, rawSummary])

  const PERIOD_OPTS: { value: PeriodType; label: string }[] = [
    { value: 'today', label: 'Hoy' },
    { value: 'week', label: 'Semana' },
    { value: 'month', label: 'Mes' },
    { value: 'year', label: 'Año' },
    { value: 'custom', label: 'Personalizado' },
  ]

  // cardStyle migrado a .surface-raised en el JSX

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1400px', margin: '0 auto' }}>

      {/* ── Header ── */}
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon"><BarChart3 size={22} /></div>
          <div>
            <h1 className="page-hdr-title">Panel Financiero</h1>
            <p className="page-hdr-subtitle">Control integral de ingresos, costos y resultados del negocio</p>
          </div>
        </div>
        <div className="page-hdr-right">
          <button onClick={load} className="btn btn-ghost btn-sm"><RefreshCw size={14} /> Actualizar</button>
          <button onClick={handleNew} className="btn btn-primary btn-sm btn-lift"><Plus size={15} /> Nuevo movimiento</button>
        </div>
      </div>

      {/* ── Main Tabs ── */}
      <div className="tabs" style={{ marginBottom: '1.5rem' }}>
        {([
          { key: 'movimientos', label: 'Movimientos y Finanzas', icon: BarChart3 },
          { key: 'recurrentes', label: 'Gastos Recurrentes', icon: RepeatIcon },
          { key: 'inventario', label: 'Inventario', icon: Package },
        ] as const).map(tab => {
          const Icon = tab.icon
          return (
            <button key={tab.key} onClick={() => setActiveMainTab(tab.key)}
              className={`tab${activeMainTab === tab.key ? ' tab-active' : ''}`}>
              <Icon size={15} />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* ── Recurrentes Tab Content ── */}
      {activeMainTab === 'recurrentes' && (
        <RecurringExpensesPanel
          businessId={businessId!}
          userId={user!.id}
          exchangeRate={exchangeRate}
          onEntryCreated={load}
        />
      )}

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
              className="form-control" style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }} />
            <span className="body-sm">hasta</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
              className="form-control" style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }} />
          </div>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#334155' }}>
          {fmtDate(from)} → {fmtDate(to)}
        </span>
      </div>

      {/* ── Setup requerido ── */}
      {tableReady === false && (
        <div className="alert-inline alert-warning" style={{ marginBottom: '1.25rem', alignItems: 'flex-start' }}>
          <AlertCircle size={18} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
          <div style={{ flex: 1 }}>
            <p style={{ margin: '0 0 0.375rem', fontWeight: 700, fontSize: '0.95rem' }}>
              Configuración inicial requerida
            </p>
            <p className="body-sm" style={{ margin: '0 0 1rem', lineHeight: 1.5 }}>
              La tabla <code className="mono" style={{ background: 'rgba(255,255,255,0.08)', padding: '0.1rem 0.35rem', borderRadius: '0.25rem' }}>business_finance_entries</code> no existe todavía.
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
              <button onClick={load} className="btn btn-ghost btn-sm" style={{ marginTop: '0.875rem', color: 'var(--warning)' }}>
                <RefreshCw size={13} /> Reintentar después de ejecutar el SQL
              </button>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="alert-inline alert-error" style={{ marginBottom: '1rem' }}>
          <AlertCircle size={15} style={{ flexShrink: 0 }} /> {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '6rem' }}>
          <Loader2 size={36} style={{ color: '#6366f1', animation: 'tr-spin 1s linear infinite' }} />
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

          {/* ── Desglose Mayorista / Minorista ── */}
          {(() => {
            const incomeEntries = entries.filter(e => e.type === 'income')
            const mayorista = incomeEntries.filter(e => (e as any).sale_type === 'mayorista')
            const minorista = incomeEntries.filter(e => (e as any).sale_type !== 'mayorista')
            const totalMay = mayorista.reduce((s, e) => s + (e.amount_ars || 0), 0)
            const totalMin = minorista.reduce((s, e) => s + (e.amount_ars || 0), 0)
            const totalIncome = summary.totalIncome
            if (mayorista.length === 0) return null
            return (
              <div style={{ background: '#0f1829', border: '1px solid rgba(99,102,241,0.15)', borderRadius: '0.875rem', padding: '1rem 1.25rem', marginBottom: '1.25rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ fontSize: '0.72rem', color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Desglose de ingresos</div>
                <div style={{ display: 'flex', gap: '1.5rem', flex: 1, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '0.72rem', color: '#64748b', marginBottom: '0.2rem' }}>👤 Minorista</div>
                    <div style={{ fontWeight: 700, color: '#34d399', fontFamily: 'monospace', fontSize: '0.95rem' }}>{fmt(totalMin)}</div>
                    <div style={{ fontSize: '0.7rem', color: '#334155' }}>{totalIncome > 0 ? `${((totalMin / totalIncome) * 100).toFixed(0)}%` : '—'} · {minorista.length} ventas</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.72rem', color: '#64748b', marginBottom: '0.2rem' }}>🏬 Mayorista</div>
                    <div style={{ fontWeight: 700, color: '#a5b4fc', fontFamily: 'monospace', fontSize: '0.95rem' }}>{fmt(totalMay)}</div>
                    <div style={{ fontSize: '0.7rem', color: '#334155' }}>{totalIncome > 0 ? `${((totalMay / totalIncome) * 100).toFixed(0)}%` : '—'} · {mayorista.length} ventas</div>
                  </div>
                </div>
                {/* Barra visual */}
                {totalIncome > 0 && (
                  <div style={{ flex: '0 0 160px', height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${(totalMin / totalIncome) * 100}%`, background: '#34d399', borderRadius: 4, transition: 'width 0.3s' }} />
                  </div>
                )}
              </div>
            )
          })()}

          {/* ── Charts + Break-Even ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.25rem' }}>
            {/* Charts panel */}
            <div className="surface-raised" style={{ padding: '1.25rem' }}>
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
                    ? <FinanceBarChart data={monthlyData} />
                    : <span style={{ color: '#334155', fontSize: '0.8rem' }}>Sin datos de los últimos meses</span>
                )}
                {activeChartTab === 'donut' && (
                  distribution.length > 0
                    ? <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', width: '100%' }}>
                        <div style={{ width: '140px', height: '140px', flexShrink: 0 }}>
                          <FinanceDonutChart slices={distribution} />
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
                    ? <FinanceLineChart data={monthlyData} />
                    : <span style={{ color: '#334155', fontSize: '0.8rem' }}>Se necesitan al menos 2 meses de datos</span>
                )}
              </div>
            </div>

            {/* Break-even */}
            <BreakEvenSection summary={summary} />
          </div>

          {/* ── Cascada financiera ── */}
          <div className="surface-raised" style={{ padding: '1.25rem', marginBottom: '1.25rem' }}>
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

    </div>
  )
}
