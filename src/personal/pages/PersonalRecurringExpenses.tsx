import { useState, useEffect } from 'react'
import { Plus, RepeatIcon, Edit2, Trash2, Check, ChevronRight } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import {
  recurringExpenseService,
  type RecurringExpense, type RecurringExpensePayment,
  type RecurringStatus,
  getRecurringStatusForMonth, FREQUENCY_LABELS, STATUS_COLORS, STATUS_LABELS,
} from '../services/recurringExpenseService'
import { personalService, type PersonalAccount, type PersonalCategory } from '../services/personalService'
import {
  PageContainer, Card, SectionHeader, PrimaryBtn, PersonalInput, PersonalSelect,
  EmptyPersonal, PersonalLoading, showToast, fmtMoney, fmtMoneyCompact,
} from '../components/ui'
import { PersonalBottomSheet } from '../components/PersonalBottomSheet'
import { logger } from '../../lib/logger'

const HIDE_KEY = 'miGuitaHideAmounts'
const MASK     = '••••••'

function fmt(d: string | null): string {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })
}

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: RecurringStatus }) {
  return (
    <span style={{
      fontSize: '0.68rem', fontWeight: 700,
      color: STATUS_COLORS[status],
      background: `${STATUS_COLORS[status]}18`,
      borderRadius: '99px', padding: '0.15rem 0.5rem',
      flexShrink: 0,
    }}>
      {STATUS_LABELS[status]}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// RecurringExpenseForm — create or edit
// ─────────────────────────────────────────────────────────────────────────────
function RecurringExpenseForm({ initial, accounts, categories, onSaved, onClose }: {
  initial?: RecurringExpense
  accounts: PersonalAccount[]
  categories: PersonalCategory[]
  onSaved: () => void
  onClose: () => void
}) {
  const { user } = useAuth()
  const [name,      setName]      = useState(initial?.name ?? '')
  const [desc,      setDesc]      = useState(initial?.description ?? '')
  const [catId,     setCatId]     = useState(initial?.category_id ?? '')
  const [accId,     setAccId]     = useState(initial?.default_account_id ?? '')
  const [currency,  setCurrency]  = useState(initial?.currency ?? 'ARS')
  const [amount,    setAmount]    = useState(initial ? String(initial.amount) : '')
  const [frequency, setFrequency] = useState<RecurringExpense['frequency']>(initial?.frequency ?? 'monthly')
  const [dueDay,    setDueDay]    = useState(initial?.due_day != null ? String(initial.due_day) : '')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')

  const expenseCategories = categories.filter(c => c.type === 'expense' && c.is_active)

  const handleSave = async () => {
    if (!user || saving) return
    if (!name.trim()) { setError('El nombre es obligatorio'); return }
    const amt = parseFloat(amount.replace(',', '.'))
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    const dd = dueDay ? parseInt(dueDay, 10) : null
    if (dd !== null && (isNaN(dd) || dd < 1 || dd > 31)) { setError('El día debe ser entre 1 y 31'); return }
    setError('')
    setSaving(true)
    try {
      if (initial) {
        await recurringExpenseService.updateRecurringExpense(initial.id, user.id, {
          name: name.trim(), description: desc.trim() || null,
          category_id: catId || null, default_account_id: accId || null,
          currency, amount: amt, frequency, due_day: dd,
        })
        showToast({ message: 'Gasto fijo actualizado', type: 'success' })
      } else {
        await recurringExpenseService.createRecurringExpense(user.id, {
          name: name.trim(), description: desc.trim() || null,
          category_id: catId || null, default_account_id: accId || null,
          currency, amount: amt, frequency, due_day: dd,
        })
        showToast({ message: 'Gasto fijo creado', type: 'success' })
      }
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'saveRecurring', e)
      const msg = e.message || 'Error al guardar'
      setError(msg)
      showToast({ message: msg, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <PersonalBottomSheet
      open
      title={initial ? 'Editar gasto fijo' : 'Nuevo gasto fijo'}
      onClose={onClose}
      testId="personal-recurring-form"
      footer={
        <PrimaryBtn testId="personal-recurring-save" onClick={handleSave} loading={saving} fullWidth>
          {saving ? 'Guardando…' : (initial ? 'Guardar cambios' : 'Crear gasto fijo')}
        </PrimaryBtn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <PersonalInput label="Nombre *" value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Internet, Alquiler, Gym..." autoCapitalize="words" autoComplete="off" testId="personal-recurring-name" />
        <PersonalInput label="Descripción (opcional)" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Detalle del gasto..." autoCapitalize="sentences" autoComplete="off" />

        {/* Amount — large display */}
        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Monto *</label>
          <input
            data-testid="personal-recurring-amount"
            type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*"
            value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="0" autoFocus autoComplete="off"
            style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: 'rgba(251,191,36,0.05)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: '0.875rem', color: '#fbbf24', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <PersonalSelect label="Moneda" value={currency} onChange={e => setCurrency(e.target.value)}>
            <option value="ARS">ARS — Pesos</option>
            <option value="USD">USD — Dólares</option>
          </PersonalSelect>
          <PersonalSelect label="Frecuencia" value={frequency} onChange={e => setFrequency(e.target.value as RecurringExpense['frequency'])}>
            <option value="monthly">Mensual</option>
            <option value="weekly">Semanal</option>
            <option value="yearly">Anual</option>
            <option value="custom">Personalizado</option>
          </PersonalSelect>
        </div>

        {frequency === 'monthly' && (
          <PersonalInput
            label="Día de vencimiento (1–31)"
            type="text" inputMode="numeric" pattern="[0-9]*"
            value={dueDay} onChange={e => setDueDay(e.target.value)}
            placeholder="Ej: 10" autoComplete="off"
          />
        )}

        {expenseCategories.length > 0 && (
          <PersonalSelect label="Categoría (opcional)" value={catId} onChange={e => setCatId(e.target.value)}>
            <option value="">Sin categoría</option>
            {expenseCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </PersonalSelect>
        )}

        {accounts.length > 0 && (
          <PersonalSelect label="Cuenta por defecto (opcional)" value={accId} onChange={e => setAccId(e.target.value)}>
            <option value="">Sin cuenta específica</option>
            {accounts.filter(a => a.is_active).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </PersonalSelect>
        )}

        {error && <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>{error}</div>}
      </div>
    </PersonalBottomSheet>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// RecurringPaymentForm — pay one recurring expense
// ─────────────────────────────────────────────────────────────────────────────
function RecurringPaymentForm({ expense, accounts, onSaved, onClose }: {
  expense: RecurringExpense
  accounts: PersonalAccount[]
  onSaved: () => void
  onClose: () => void
}) {
  const defaultAcc = expense.default_account_id ?? accounts[0]?.id ?? ''
  const [accountId, setAccountId] = useState(defaultAcc)
  const [amount,    setAmount]    = useState(String(expense.amount))
  const [date,      setDate]      = useState(new Date().toISOString().split('T')[0])
  const [notes,     setNotes]     = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')

  const amt     = parseFloat(amount.replace(',', '.'))
  const isValid = amt > 0 && !!accountId
  const differsFromExpected = amt > 0 && Math.abs(amt - Number(expense.amount)) > 0.01

  const handleSave = async () => {
    if (saving) return
    if (!accountId) { setError('Seleccioná una cuenta'); return }
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    setError('')
    setSaving(true)
    try {
      await recurringExpenseService.payRecurringExpense({
        expenseId: expense.id, accountId, amount: amt,
        paidDate: date, notes: notes.trim() || null,
      })
      showToast({ message: `"${expense.name}" pagado — ${fmtMoney(amt, expense.currency)}`, type: 'success' })
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'payRecurring', e)
      const msg = e.message || 'Error al registrar el pago'
      setError(msg)
      showToast({ message: msg, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <PersonalBottomSheet
      open
      title={`Pagar: ${expense.name}`}
      onClose={onClose}
      testId="personal-recurring-payment-form"
      footer={
        <PrimaryBtn
          testId="personal-recurring-payment-save"
          onClick={handleSave} loading={saving}
          disabled={!isValid || (differsFromExpected && !confirmed)}
          fullWidth
        >
          {saving ? 'Registrando…' : `Pagar ${fmtMoney(amt || 0, expense.currency)}`}
        </PrimaryBtn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Expected amount info */}
        <div style={{ padding: '0.625rem 0.875rem', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.18)', borderRadius: '0.75rem', display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '0.8rem', color: '#475569' }}>Monto esperado</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#fbbf24' }}>{fmtMoney(Number(expense.amount), expense.currency)}</span>
        </div>

        <PersonalSelect testId="personal-recurring-payment-account" label="Cuenta de débito *" value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">Seleccionar cuenta</option>
          {accounts.filter(a => a.is_active).map(a => <option key={a.id} value={a.id}>{a.name} ({fmtMoney(a.current_balance, expense.currency)})</option>)}
        </PersonalSelect>

        {/* Amount */}
        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Monto real *</label>
          <input
            data-testid="personal-recurring-payment-amount"
            type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*"
            value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="0" autoFocus autoComplete="off"
            style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: 'rgba(52,211,153,0.05)', border: '1px solid rgba(52,211,153,0.25)', borderRadius: '0.875rem', color: '#34d399', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
          />
        </div>

        <PersonalInput label="Fecha de pago" type="date" value={date} onChange={e => setDate(e.target.value)} />
        <PersonalInput label="Nota (opcional)" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Ej: Factura julio..." autoCapitalize="sentences" autoComplete="off" />

        {differsFromExpected && isValid && (
          <div
            onClick={() => setConfirmed(c => !c)}
            role="checkbox" aria-checked={confirmed}
            style={{ padding: '0.875rem', background: confirmed ? 'rgba(251,191,36,0.08)' : 'rgba(255,255,255,0.025)', border: `1px solid ${confirmed ? 'rgba(251,191,36,0.35)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '0.875rem', cursor: 'pointer', display: 'flex', gap: '0.75rem', alignItems: 'center' }}
          >
            <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${confirmed ? '#fbbf24' : '#334155'}`, background: confirmed ? 'rgba(251,191,36,0.2)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {confirmed && <Check size={11} color="#fbbf24" />}
            </div>
            <span style={{ fontSize: '0.8rem', color: confirmed ? '#fbbf24' : '#475569', fontWeight: 600 }}>
              El monto {fmtMoney(amt, expense.currency)} difiere del esperado ({fmtMoney(Number(expense.amount), expense.currency)}). Confirmo.
            </span>
          </div>
        )}

        {error && <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>{error}</div>}
      </div>
    </PersonalBottomSheet>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// RecurringDetailSheet — detail + history
// ─────────────────────────────────────────────────────────────────────────────
function RecurringDetailSheet({ expense, status, onPay, onEdit, onStatusChange, onDelete, onClose }: {
  expense: RecurringExpense
  status: RecurringStatus
  onPay: () => void
  onEdit: () => void
  onStatusChange: (s: RecurringExpense['status']) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [payments,      setPayments]      = useState<RecurringExpensePayment[]>([])
  const [loadingPay,    setLoadingPay]    = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { user } = useAuth()
  const hidden = localStorage.getItem(HIDE_KEY) === 'true'
  const displayAmt = (n: number) => hidden ? MASK : fmtMoney(n, expense.currency)

  useEffect(() => {
    if (!user) return
    recurringExpenseService.getPaymentsForExpense(expense.id, user.id)
      .then(setPayments).catch(() => {})
      .finally(() => setLoadingPay(false))
  }, [expense.id, user])

  return (
    <PersonalBottomSheet
      open
      title={expense.name}
      onClose={onClose}
      testId="personal-recurring-detail"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Meta pills */}
        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <StatusBadge status={status} />
          <span style={{ fontSize: '0.72rem', color: '#60a5fa', background: 'rgba(96,165,250,0.08)', borderRadius: '99px', padding: '0.15rem 0.5rem' }}>{expense.currency}</span>
          <span style={{ fontSize: '0.72rem', color: '#475569', background: 'rgba(255,255,255,0.04)', borderRadius: '99px', padding: '0.15rem 0.5rem' }}>{FREQUENCY_LABELS[expense.frequency]}</span>
          {expense.due_day && <span style={{ fontSize: '0.72rem', color: '#475569', background: 'rgba(255,255,255,0.04)', borderRadius: '99px', padding: '0.15rem 0.5rem' }}>Día {expense.due_day}</span>}
        </div>

        {/* Amount + next due */}
        <div style={{ background: 'rgba(255,255,255,0.025)', borderRadius: '0.875rem', padding: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '0.7rem', color: '#334155', marginBottom: '0.25rem' }}>Monto</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '1.75rem', color: '#fbbf24', lineHeight: 1, letterSpacing: '-0.03em' }}>
              {displayAmt(Number(expense.amount))}
            </div>
          </div>
          {expense.next_due_date && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.7rem', color: '#334155', marginBottom: '0.25rem' }}>Próx. vencimiento</div>
              <div style={{ fontWeight: 700, color: '#f0f4ff', fontSize: '0.875rem' }}>{fmt(expense.next_due_date)}</div>
            </div>
          )}
        </div>

        {expense.description && <p style={{ fontSize: '0.8rem', color: '#475569', margin: 0 }}>{expense.description}</p>}

        {/* Actions */}
        {expense.status !== 'cancelled' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            {expense.status === 'active' && status !== 'paid' && (
              <button onClick={onPay} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)', color: '#34d399', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44 }}>
                + Pagar
              </button>
            )}
            <button onClick={onEdit} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)', color: '#60a5fa', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem' }}>
              <Edit2 size={13} /> Editar
            </button>
            {expense.status === 'active' && (
              <button onClick={() => onStatusChange('paused')} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', color: '#fbbf24', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44 }}>
                Pausar
              </button>
            )}
            {expense.status === 'paused' && (
              <button onClick={() => onStatusChange('active')} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', color: '#34d399', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44 }}>
                Retomar
              </button>
            )}
          </div>
        )}

        {/* Payment history */}
        {!loadingPay && payments.length > 0 && (
          <>
            <SectionHeader title="Historial de pagos" />
            <Card>
              {payments.map((p, i) => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', borderBottom: i < payments.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                  <div>
                    <div style={{ fontSize: '0.8rem', color: '#f0f4ff', fontWeight: 600 }}>
                      {new Date(p.paid_date + 'T12:00:00').toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })}
                    </div>
                    {p.notes && <div style={{ fontSize: '0.7rem', color: '#334155' }}>{p.notes}</div>}
                  </div>
                  <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#34d399', fontSize: '0.875rem' }}>
                    {displayAmt(Number(p.amount))}
                  </span>
                </div>
              ))}
            </Card>
          </>
        )}

        {/* Delete */}
        {confirmDelete ? (
          <div style={{ padding: '0.875rem', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            <div style={{ fontSize: '0.8rem', color: '#f87171' }}>¿Cancelar "{expense.name}"? Los pagos históricos no se eliminan.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              <button onClick={() => setConfirmDelete(false)} style={{ padding: '0.625rem', borderRadius: '0.625rem', background: 'none', border: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8', fontSize: '0.8rem', cursor: 'pointer', minHeight: 40 }}>Cancelar</button>
              <button onClick={onDelete} style={{ padding: '0.625rem', borderRadius: '0.625rem', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 40 }}>Eliminar</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} style={{ width: '100%', padding: '0.625rem', background: 'none', border: 'none', cursor: 'pointer', color: '#334155', fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem', minHeight: 36 }}>
            <Trash2 size={12} /> Eliminar gasto fijo
          </button>
        )}
      </div>
    </PersonalBottomSheet>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ExpenseCard — single row in list
// ─────────────────────────────────────────────────────────────────────────────
function ExpenseCard({ expense, status, hidden, onPay, onClick }: {
  expense: RecurringExpense
  status: RecurringStatus
  hidden: boolean
  onPay: (e: React.MouseEvent) => void
  onClick: () => void
}) {
  const displayAmt = hidden ? MASK : fmtMoney(Number(expense.amount), expense.currency)
  return (
    <div
      data-testid="personal-recurring-row"
      onClick={onClick}
      role="button"
      style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.875rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer' }}
      onPointerEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
      onPointerLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#f0f4ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{expense.name}</div>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.2rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <StatusBadge status={status} />
          {expense.next_due_date && status !== 'paid' && (
            <span style={{ fontSize: '0.68rem', color: '#334155' }}>Vence {fmt(expense.next_due_date)}</span>
          )}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <div>
          <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9375rem', color: STATUS_COLORS[status] }}>{displayAmt}</div>
          <div style={{ fontSize: '0.65rem', color: '#334155' }}>{FREQUENCY_LABELS[expense.frequency]}</div>
        </div>
        {status !== 'paid' && expense.status === 'active' && (
          <button
            onClick={onPay}
            style={{ background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: '0.5rem', padding: '0.375rem 0.625rem', color: '#34d399', fontWeight: 700, fontSize: '0.72rem', cursor: 'pointer', minHeight: 32, flexShrink: 0 }}
          >
            Pagar
          </button>
        )}
        {status === 'paid' && <Check size={14} color="#34d399" style={{ flexShrink: 0 }} />}
        <ChevronRight size={13} color="#334155" style={{ flexShrink: 0 }} />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PersonalRecurringExpenses — main page
// ─────────────────────────────────────────────────────────────────────────────
export function PersonalRecurringExpenses() {
  const { user } = useAuth()
  const [loading,   setLoading]   = useState(true)
  const [expenses,  setExpenses]  = useState<RecurringExpense[]>([])
  const [payments,  setPayments]  = useState<RecurringExpensePayment[]>([])
  const [accounts,  setAccounts]  = useState<PersonalAccount[]>([])
  const [categories,setCategories]= useState<PersonalCategory[]>([])

  // Sheet state
  const [showForm,    setShowForm]    = useState(false)
  const [editingExp,  setEditingExp]  = useState<RecurringExpense | null>(null)
  const [payingExp,   setPayingExp]   = useState<RecurringExpense | null>(null)
  const [detailExp,   setDetailExp]   = useState<RecurringExpense | null>(null)

  // Privacy
  const [hidden] = useState(() => localStorage.getItem(HIDE_KEY) === 'true')
  const displayAmt = (n: number, cur = 'ARS') => hidden ? MASK : fmtMoney(n, cur)
  const displayComp = (n: number) => hidden ? MASK : fmtMoneyCompact(n)

  const now = new Date()
  const year  = now.getFullYear()
  const month = now.getMonth() + 1

  const load = async () => {
    if (!user) return
    setLoading(true)
    try {
      const [exp, pay, accts, cats] = await Promise.all([
        recurringExpenseService.getRecurringExpenses(user.id),
        recurringExpenseService.getPaymentsForMonth(user.id, year, month),
        personalService.getAccounts(user.id),
        personalService.getCategories(user.id),
      ])
      setExpenses(exp); setPayments(pay); setAccounts(accts); setCategories(cats)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleStatusChange = async (expense: RecurringExpense, status: RecurringExpense['status']) => {
    if (!user) return
    try {
      await recurringExpenseService.updateRecurringExpense(expense.id, user.id, { status })
      showToast({ message: { active: 'Retomado', paused: 'Pausado', cancelled: 'Cancelado' }[status] ?? 'Actualizado', type: status === 'cancelled' ? 'error' : 'success' })
      setDetailExp(null)
      void load()
    } catch (e: any) {
      logger.error('PERSONAL', 'recurringStatus', e)
      showToast({ message: e.message || 'Error', type: 'error' })
    }
  }

  const handleDelete = async (expense: RecurringExpense) => {
    if (!user) return
    try {
      await recurringExpenseService.deleteRecurringExpense(expense.id, user.id)
      showToast({ message: 'Gasto fijo eliminado', type: 'success' })
      setDetailExp(null)
      void load()
    } catch (e: any) {
      logger.error('PERSONAL', 'deleteRecurring', e)
      showToast({ message: e.message || 'Error', type: 'error' })
    }
  }

  if (loading) return <PersonalLoading />

  const summary  = recurringExpenseService.getSummary(expenses, payments, now)
  const active   = expenses.filter(e => e.status === 'active')
  const paused   = expenses.filter(e => e.status === 'paused')

  // Group active by status
  const overdue  = active.filter(e => getRecurringStatusForMonth(e, payments, now) === 'overdue')
  const pending  = active.filter(e => getRecurringStatusForMonth(e, payments, now) === 'pending')
  const paid     = active.filter(e => getRecurringStatusForMonth(e, payments, now) === 'paid')
  const upcoming = active.filter(e => getRecurringStatusForMonth(e, payments, now) === 'upcoming')

  return (
    <PageContainer testId="personal-recurring-page">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff' }}>Gastos fijos</span>
        <button
          data-testid="personal-recurring-new-button"
          onClick={() => { setEditingExp(null); setShowForm(true) }}
          style={{ width: 36, height: 36, borderRadius: '0.75rem', background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fbbf24' }}
        >
          <Plus size={18} />
        </button>
      </div>

      {/* Summary */}
      {expenses.length > 0 && (
        <div
          data-testid="personal-recurring-summary"
          style={{ background: 'linear-gradient(135deg,rgba(251,191,36,0.1),rgba(251,191,36,0.04))', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '1.25rem', padding: '1.25rem' }}
        >
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#b45309', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.75rem' }}>
            Resumen mensual · {active.length} activo{active.length !== 1 ? 's' : ''}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: summary.monthlyTotalUSD > 0 ? '1fr 1fr' : '1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
            {summary.monthlyTotalARS > 0 && (
              <div>
                <div style={{ fontSize: '0.68rem', color: '#92400e', marginBottom: '0.2rem' }}>Total fijo ARS/mes</div>
                <div data-testid="personal-recurring-total-ars" style={{ fontSize: '1.75rem', fontWeight: 900, color: '#fbbf24', fontFamily: 'monospace', letterSpacing: '-0.03em', lineHeight: 1 }}>
                  {displayAmt(summary.monthlyTotalARS)}
                </div>
              </div>
            )}
            {summary.monthlyTotalUSD > 0 && (
              <div>
                <div style={{ fontSize: '0.68rem', color: '#92400e', marginBottom: '0.2rem' }}>Total fijo USD/mes</div>
                <div data-testid="personal-recurring-total-usd" style={{ fontSize: '1.75rem', fontWeight: 900, color: '#fb923c', fontFamily: 'monospace', letterSpacing: '-0.03em', lineHeight: 1 }}>
                  {displayAmt(summary.monthlyTotalUSD, 'USD')}
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
            {[
              { label: 'Pagados',   value: summary.paidCount,    color: '#34d399' },
              { label: 'Pendientes',value: summary.pendingCount, color: '#f87171' },
              { label: 'Pendiente', value: displayComp(summary.pendingARS + summary.pendingUSD), color: '#fbbf24' },
            ].map(s => (
              <div key={s.label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.62rem', color: '#92400e', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{s.label}</div>
                <div style={{ fontFamily: typeof s.value === 'number' ? 'monospace' : undefined, fontWeight: 800, fontSize: '1rem', color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>
          {summary.nextDueDate && summary.pendingCount > 0 && (
            <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#92400e' }}>
              Próx: <strong>{summary.nextDueName}</strong> — {fmt(summary.nextDueDate)}
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {expenses.length === 0 ? (
        <EmptyPersonal
          icon={<RepeatIcon size={22} />}
          title="Sin gastos fijos registrados"
          description="Registrá tus gastos mensuales fijos para saber cuánto necesitás cada mes."
          cta="Agregar primer gasto fijo"
          onCta={() => setShowForm(true)}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>

          {/* Overdue */}
          {overdue.length > 0 && (
            <>
              <SectionHeader title="Vencidos" />
              <Card>
                {overdue.map(e => (
                  <ExpenseCard key={e.id} expense={e} status="overdue" hidden={hidden}
                    onPay={ev => { ev.stopPropagation(); setPayingExp(e) }}
                    onClick={() => setDetailExp(e)} />
                ))}
              </Card>
            </>
          )}

          {/* Pending */}
          {pending.length > 0 && (
            <>
              <SectionHeader title="Pendientes este mes" />
              <Card>
                {pending.map(e => (
                  <ExpenseCard key={e.id} expense={e} status="pending" hidden={hidden}
                    onPay={ev => { ev.stopPropagation(); setPayingExp(e) }}
                    onClick={() => setDetailExp(e)} />
                ))}
              </Card>
            </>
          )}

          {/* Paid this month */}
          {paid.length > 0 && (
            <>
              <SectionHeader title="Pagados este mes" />
              <Card style={{ opacity: 0.8 }}>
                {paid.map(e => (
                  <ExpenseCard key={e.id} expense={e} status="paid" hidden={hidden}
                    onPay={ev => { ev.stopPropagation() }}
                    onClick={() => setDetailExp(e)} />
                ))}
              </Card>
            </>
          )}

          {/* Upcoming */}
          {upcoming.length > 0 && (
            <>
              <SectionHeader title="Próximos" />
              <Card>
                {upcoming.map(e => (
                  <ExpenseCard key={e.id} expense={e} status="upcoming" hidden={hidden}
                    onPay={ev => { ev.stopPropagation(); setPayingExp(e) }}
                    onClick={() => setDetailExp(e)} />
                ))}
              </Card>
            </>
          )}

          {/* Paused */}
          {paused.length > 0 && (
            <>
              <SectionHeader title="Pausados" />
              <Card style={{ opacity: 0.6 }}>
                {paused.map(e => (
                  <ExpenseCard key={e.id} expense={e} status="paused" hidden={hidden}
                    onPay={ev => { ev.stopPropagation() }}
                    onClick={() => setDetailExp(e)} />
                ))}
              </Card>
            </>
          )}
        </div>
      )}

      {/* Sheets */}
      {(showForm || editingExp) && (
        <RecurringExpenseForm
          initial={editingExp ?? undefined}
          accounts={accounts}
          categories={categories}
          onSaved={() => { setShowForm(false); setEditingExp(null); void load() }}
          onClose={() => { setShowForm(false); setEditingExp(null) }}
        />
      )}

      {payingExp && (
        <RecurringPaymentForm
          expense={payingExp}
          accounts={accounts}
          onSaved={() => { setPayingExp(null); void load() }}
          onClose={() => setPayingExp(null)}
        />
      )}

      {detailExp && (
        <RecurringDetailSheet
          expense={detailExp}
          status={getRecurringStatusForMonth(detailExp, payments, now)}
          onPay={() => { setPayingExp(detailExp); setDetailExp(null) }}
          onEdit={() => { setEditingExp(detailExp); setDetailExp(null); setShowForm(true) }}
          onStatusChange={s => handleStatusChange(detailExp, s)}
          onDelete={() => handleDelete(detailExp)}
          onClose={() => setDetailExp(null)}
        />
      )}
    </PageContainer>
  )
}
