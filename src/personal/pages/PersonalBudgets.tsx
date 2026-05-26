import { useState, useEffect } from 'react'
import { Plus, Trash2, Edit2, ChevronLeft, ChevronRight, Eye, EyeOff, Wallet } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { personalService, type PersonalCategory } from '../services/personalService'
import {
  budgetService,
  calculateBudgetUsage, getBudgetSummaryFromUsages, budgetStatusColor, budgetStatusLabel,
  type PersonalBudget, type BudgetUsage,
} from '../services/budgetService'
import { currentYearMonth, addMonths, formatYearMonth } from '../utils/creditCards'
import {
  PageContainer, SectionHeader, PrimaryBtn, PersonalInput, PersonalSelect,
  EmptyPersonal, PersonalLoading, showToast, fmtMoney, fmtMoneyCompact,
} from '../components/ui'
import { PersonalBottomSheet } from '../components/PersonalBottomSheet'
import { logger } from '../../lib/logger'

const HIDE_KEY = 'miGuitaHideAmounts'
const MASK     = '••••'

// ── Month selector ─────────────────────────────────────────────────────────────

function MonthSelector({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const now = currentYearMonth()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'center' }}>
      <button
        data-testid="personal-budgets-month-prev"
        onClick={() => onChange(addMonths(month, -1))}
        style={{ width: 36, height: 36, borderRadius: '0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#475569' }}
      >
        <ChevronLeft size={18} />
      </button>
      <span
        data-testid="personal-budgets-month-label"
        style={{ fontSize: '1rem', fontWeight: 700, color: '#f0f4ff', minWidth: 160, textAlign: 'center' }}
      >
        {formatYearMonth(month)}
        {month === now && (
          <span style={{ fontSize: '0.65rem', color: '#34d399', marginLeft: '0.375rem', fontWeight: 600, verticalAlign: 'middle' }}>(este mes)</span>
        )}
      </span>
      <button
        data-testid="personal-budgets-month-next"
        onClick={() => onChange(addMonths(month, 1))}
        style={{ width: 36, height: 36, borderRadius: '0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#475569' }}
      >
        <ChevronRight size={18} />
      </button>
    </div>
  )
}

// ── Budget form ────────────────────────────────────────────────────────────────

function BudgetForm({ initial, categories, period, existingCategoryIds, onSaved, onClose }: {
  initial?: PersonalBudget
  categories: PersonalCategory[]
  period: string
  existingCategoryIds: string[]
  onSaved: () => void
  onClose: () => void
}) {
  const { user } = useAuth()
  const [categoryId, setCategoryId] = useState(initial?.category_id ?? '')
  const [amount,     setAmount]     = useState(initial ? String(initial.amount) : '')
  const [currency,   setCurrency]   = useState(initial?.currency ?? 'ARS')
  const [notes,      setNotes]      = useState(initial?.notes ?? '')
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState('')

  const expenseCategories = categories.filter(c => c.type === 'expense' && c.is_active)
  // For new budget: exclude already-budgeted categories in this period+currency
  const availableCategories = initial
    ? expenseCategories
    : expenseCategories.filter(c => !existingCategoryIds.includes(c.id))

  const handleSave = async () => {
    if (!user || saving) return
    if (!categoryId) { setError('Seleccioná una categoría'); return }
    const amt = parseFloat(amount.replace(',', '.'))
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    setError('')
    setSaving(true)
    try {
      if (initial) {
        await budgetService.updateBudget(initial.id, user.id, { amount: amt, currency, notes: notes.trim() || null })
        showToast({ message: 'Presupuesto actualizado', type: 'success' })
      } else {
        await budgetService.createBudget(user.id, { category_id: categoryId, amount: amt, currency, period, notes: notes.trim() || null })
        showToast({ message: 'Presupuesto creado', type: 'success' })
      }
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'saveBudget', e)
      const isDuplicate = e.message?.includes('unique') || e.message?.includes('duplicate') || e.code === '23505'
      const msg = isDuplicate
        ? 'Ya existe un presupuesto para esa categoría en este mes.'
        : (e.message || 'Error al guardar')
      setError(msg)
      showToast({ message: msg, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <PersonalBottomSheet
      open
      title={initial ? 'Editar presupuesto' : 'Nuevo presupuesto'}
      onClose={onClose}
      testId="personal-budget-form"
      footer={
        <PrimaryBtn testId="personal-budget-save" onClick={handleSave} loading={saving} fullWidth>
          {saving ? 'Guardando…' : (initial ? 'Guardar cambios' : 'Crear presupuesto')}
        </PrimaryBtn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

        {!initial && (
          <PersonalSelect
            testId="personal-budget-category"
            label="Categoría *"
            value={categoryId}
            onChange={e => setCategoryId(e.target.value)}
          >
            <option value="">Seleccioná una categoría</option>
            {availableCategories.length === 0 && (
              <option value="" disabled>No hay categorías disponibles</option>
            )}
            {availableCategories.map(c => (
              <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
            ))}
          </PersonalSelect>
        )}

        {initial && (
          <div style={{ padding: '0.625rem 0.875rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.1rem' }}>{initial.category?.icon}</span>
            <span style={{ fontWeight: 600, color: '#f0f4ff' }}>{initial.category?.name}</span>
          </div>
        )}

        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>
            Límite mensual *
          </label>
          <input
            data-testid="personal-budget-amount"
            type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*"
            value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="0" autoFocus autoComplete="off"
            style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: 'rgba(129,140,248,0.05)', border: '1px solid rgba(129,140,248,0.25)', borderRadius: '0.875rem', color: '#818cf8', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
          />
        </div>

        <PersonalSelect
          testId="personal-budget-currency"
          label="Moneda"
          value={currency}
          onChange={e => setCurrency(e.target.value)}
        >
          <option value="ARS">ARS — Pesos</option>
          <option value="USD">USD — Dólares</option>
        </PersonalSelect>

        <PersonalInput
          label="Nota (opcional)"
          value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="Ej: Incluye salidas, delivery..."
          autoCapitalize="sentences" autoComplete="off"
        />

        {error && (
          <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>
            {error}
          </div>
        )}
      </div>
    </PersonalBottomSheet>
  )
}

// ── Budget item row ────────────────────────────────────────────────────────────

function BudgetItem({ usage, hidden, onEdit, onDelete }: {
  usage: BudgetUsage
  hidden: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const { budget, spent, remaining, percentUsed, status } = usage
  const color   = budgetStatusColor(status)
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div data-testid="personal-budget-item"
      style={{ background: 'rgba(255,255,255,0.025)', border: `1px solid ${status === 'exceeded' ? 'rgba(248,113,113,0.2)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '1rem', padding: '1rem' }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.625rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: '1.25rem', lineHeight: 1 }}>{budget.category?.icon ?? '📦'}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#f0f4ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {budget.category?.name ?? 'Categoría'}
            </div>
            {budget.notes && (
              <div style={{ fontSize: '0.68rem', color: '#334155', marginTop: '0.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{budget.notes}</div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.375rem', flexShrink: 0, marginLeft: '0.5rem' }}>
          <button onClick={onEdit}
            style={{ width: 28, height: 28, borderRadius: '0.5rem', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#60a5fa' }}>
            <Edit2 size={12} />
          </button>
          <button onClick={() => setConfirmDelete(true)}
            style={{ width: 28, height: 28, borderRadius: '0.5rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#f87171' }}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Amounts */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
        <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '1rem', color }}>
          {hidden ? MASK : fmtMoney(spent, budget.currency)}
        </span>
        <span style={{ fontSize: '0.72rem', color: '#334155' }}>
          de {hidden ? MASK : fmtMoney(Number(budget.amount), budget.currency)}
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ height: 7, borderRadius: 99, background: 'rgba(255,255,255,0.05)', overflow: 'hidden', marginBottom: '0.375rem' }}>
        <div style={{ height: '100%', width: `${Math.min(percentUsed, 100)}%`, background: color, borderRadius: 99, transition: 'width 0.3s' }} />
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.7rem', color }}>
          {Math.round(percentUsed)}% {budgetStatusLabel(status)}
        </span>
        {remaining > 0 ? (
          <span style={{ fontSize: '0.7rem', color: '#334155' }}>
            Resta {hidden ? MASK : fmtMoneyCompact(remaining)}
          </span>
        ) : status === 'exceeded' && (
          <span style={{ fontSize: '0.7rem', color: '#f87171', fontWeight: 600 }}>
            Excedido {hidden ? MASK : fmtMoneyCompact(spent - Number(budget.amount))}
          </span>
        )}
      </div>

      {/* Delete confirm */}
      {confirmDelete && (
        <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.78rem', color: '#f87171' }}>¿Eliminar presupuesto de {budget.category?.name}?</span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <button onClick={() => setConfirmDelete(false)} style={{ padding: '0.5rem', borderRadius: '0.5rem', background: 'none', border: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8', fontSize: '0.8rem', cursor: 'pointer', minHeight: 36 }}>Cancelar</button>
            <button onClick={onDelete} style={{ padding: '0.5rem', borderRadius: '0.5rem', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 36 }}>Eliminar</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export function PersonalBudgets() {
  const { user } = useAuth()
  const [loading,    setLoading]    = useState(true)
  const [month,      setMonth]      = useState(currentYearMonth())
  const [usages,     setUsages]     = useState<BudgetUsage[]>([])
  const [categories, setCategories] = useState<PersonalCategory[]>([])
  const [hidden,     setHidden]     = useState(() => localStorage.getItem(HIDE_KEY) === 'true')
  const [showForm,   setShowForm]   = useState(false)
  const [editing,    setEditing]    = useState<PersonalBudget | null>(null)

  const toggleHidden = () => {
    const next = !hidden
    setHidden(next)
    localStorage.setItem(HIDE_KEY, String(next))
  }

  const load = async (m: string) => {
    if (!user) return
    setLoading(true)
    try {
      await personalService.ensureDefaultCategories(user.id)
      const [budgets, expenses, cats] = await Promise.all([
        budgetService.getBudgets(user.id, m),
        budgetService.getExpensesForPeriod(user.id, m),
        personalService.getCategories(user.id),
      ])
      setUsages(calculateBudgetUsage(budgets, expenses))
      setCategories(cats)
    } catch (e) {
      logger.error('PERSONAL', 'loadBudgets', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load(month) }, [user, month]) // eslint-disable-line react-hooks/exhaustive-deps

  const summary   = getBudgetSummaryFromUsages(usages)
  const activeBudgets = usages.filter(u => u.budget.status === 'active')
  const existingCategoryIds = activeBudgets.map(u => u.budget.category_id)

  // Smart alerts
  const exceeded = activeBudgets.filter(u => u.status === 'exceeded')
  const warnings = activeBudgets.filter(u => u.status === 'warning')

  const handleDelete = async (budget: PersonalBudget) => {
    if (!user) return
    try {
      await budgetService.deleteBudget(budget.id, user.id)
      showToast({ message: `Presupuesto de ${budget.category?.name ?? ''} eliminado`, type: 'success' })
      void load(month)
    } catch (e: any) {
      logger.error('PERSONAL', 'deleteBudget', e)
      showToast({ message: e.message || 'Error al eliminar', type: 'error' })
    }
  }

  return (
    <PageContainer testId="personal-budgets-page">

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff' }}>Presupuestos</span>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            data-testid="personal-budgets-toggle-hide"
            onClick={toggleHidden}
            aria-label={hidden ? 'Mostrar importes' : 'Ocultar importes'}
            style={{ width: 32, height: 32, borderRadius: '0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#475569' }}
          >
            {hidden ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          <button
            data-testid="personal-budget-new-button"
            onClick={() => { setEditing(null); setShowForm(true) }}
            style={{ width: 36, height: 36, borderRadius: '0.75rem', background: 'rgba(129,140,248,0.12)', border: '1px solid rgba(129,140,248,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#818cf8' }}
          >
            <Plus size={18} />
          </button>
        </div>
      </div>

      {/* ── Month selector ── */}
      <MonthSelector month={month} onChange={m => setMonth(m)} />

      {loading ? (
        <PersonalLoading />
      ) : activeBudgets.length === 0 ? (
        <EmptyPersonal
          testId="personal-budgets-empty"
          icon={<Wallet size={22} />}
          title="Todavía no creaste presupuestos"
          description="Definí límites por categoría para saber si venís bien o te estás pasando."
          cta="Crear primer presupuesto"
          onCta={() => setShowForm(true)}
        />
      ) : (
        <>
          {/* ── Summary card ── */}
          <div
            data-testid="personal-budgets-summary"
            style={{ background: 'rgba(129,140,248,0.06)', border: '1px solid rgba(129,140,248,0.18)', borderRadius: '1.125rem', padding: '1.125rem' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <div>
                <div style={{ fontSize: '0.62rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.2rem' }}>Presupuestado</div>
                <div data-testid="personal-budgets-total" style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '1.25rem', color: '#818cf8' }}>
                  {hidden ? MASK : fmtMoneyCompact(summary.totalBudgeted)}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '0.62rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.2rem' }}>Gastado</div>
                <div data-testid="personal-budgets-spent" style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '1.25rem', color: summary.percentUsed >= 100 ? '#f87171' : summary.percentUsed >= 70 ? '#fbbf24' : '#34d399' }}>
                  {hidden ? MASK : fmtMoneyCompact(summary.totalSpent)}
                </div>
              </div>
            </div>

            {/* Global progress bar */}
            <div style={{ height: 8, borderRadius: 99, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginBottom: '0.5rem' }}>
              <div style={{ height: '100%', width: `${Math.min(summary.percentUsed, 100)}%`, background: summary.percentUsed >= 100 ? '#f87171' : summary.percentUsed >= 70 ? '#fbbf24' : '#34d399', borderRadius: 99, transition: 'width 0.4s' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.72rem', color: '#475569' }}>{Math.round(summary.percentUsed)}% del total usado</span>
              <span style={{ fontSize: '0.72rem', color: '#334155' }}>Resta {hidden ? MASK : fmtMoneyCompact(summary.totalRemaining)}</span>
            </div>
          </div>

          {/* ── Alerts ── */}
          {(exceeded.length > 0 || warnings.length > 0) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
              {exceeded.map(u => (
                <div key={u.budget.id} style={{ padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '0.625rem', fontSize: '0.78rem', color: '#f87171', fontWeight: 600 }}>
                  ⚠ Superaste tu presupuesto de {u.budget.category?.name}.
                </div>
              ))}
              {warnings.map(u => (
                <div key={u.budget.id} style={{ padding: '0.5rem 0.75rem', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '0.625rem', fontSize: '0.78rem', color: '#fbbf24', fontWeight: 600 }}>
                  ⚡ Estás cerca del límite en {u.budget.category?.name}.
                </div>
              ))}
              {exceeded.length === 0 && warnings.length === 0 && activeBudgets.length > 0 && (
                <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '0.625rem', fontSize: '0.78rem', color: '#34d399', fontWeight: 600 }}>
                  Este mes venís bastante ordenado. ✓
                </div>
              )}
            </div>
          )}

          {/* ── Budget list ── */}
          <SectionHeader title={`${activeBudgets.length} categoría${activeBudgets.length !== 1 ? 's' : ''} presupuestada${activeBudgets.length !== 1 ? 's' : ''}`} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            {activeBudgets
              .sort((a, b) => b.percentUsed - a.percentUsed)
              .map(usage => (
                <BudgetItem
                  key={usage.budget.id}
                  usage={usage}
                  hidden={hidden}
                  onEdit={() => { setEditing(usage.budget); setShowForm(true) }}
                  onDelete={() => void handleDelete(usage.budget)}
                />
              ))}
          </div>

          {/* ── All healthy message ── */}
          {exceeded.length === 0 && warnings.length === 0 && activeBudgets.length > 0 && (
            <div style={{ textAlign: 'center', fontSize: '0.78rem', color: '#34d399', padding: '0.5rem' }}>
              ✓ Este mes venís bastante ordenado.
            </div>
          )}
        </>
      )}

      {/* ── Forms ── */}
      {showForm && (
        <BudgetForm
          initial={editing ?? undefined}
          categories={categories}
          period={month}
          existingCategoryIds={existingCategoryIds}
          onSaved={() => { setShowForm(false); setEditing(null); void load(month) }}
          onClose={() => { setShowForm(false); setEditing(null) }}
        />
      )}

    </PageContainer>
  )
}
