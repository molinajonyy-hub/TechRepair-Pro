import { useState, useEffect } from 'react'
import { Plus, AlertCircle, Check, Trash2, Edit2, ChevronRight } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import {
  debtService,
  type PersonalDebt, type PersonalDebtPayment,
  getDebtPaidPercent, debtStatusLabel, debtStatusColor,
} from '../services/debtService'
import { personalService, type PersonalAccount } from '../services/personalService'
import {
  PageContainer, Card, SectionHeader, PrimaryBtn, PersonalInput, PersonalSelect,
  EmptyPersonal, PersonalLoading, showToast, fmtMoney,
} from '../components/ui'
import { PersonalBottomSheet } from '../components/PersonalBottomSheet'
import { logger } from '../../lib/logger'

// ── Accent colors ─────────────────────────────────────────────────────────────
const DEBT_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#818cf8', '#60a5fa', '#34d399']
const debtColor = (idx: number) => DEBT_COLORS[idx % DEBT_COLORS.length]

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(d: string | null): string {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ─────────────────────────────────────────────────────────────────────────────
// DebtForm — create or edit
// ─────────────────────────────────────────────────────────────────────────────
function DebtForm({ initial, onSaved, onClose }: {
  initial?: PersonalDebt; onSaved: () => void; onClose: () => void
}) {
  const { user } = useAuth()
  const [name,        setName]        = useState(initial?.name ?? '')
  const [lender,      setLender]      = useState(initial?.lender_name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [currency,    setCurrency]    = useState(initial?.currency ?? 'ARS')
  const [amount,      setAmount]      = useState(initial ? String(initial.initial_amount) : '')
  const [installment, setInstallment] = useState(initial?.installment_amount != null ? String(initial.installment_amount) : '')
  const [dueDay,      setDueDay]      = useState(initial?.due_day != null ? String(initial.due_day) : '')
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')

  const handleSave = async () => {
    if (!user || saving) return
    if (!name.trim()) { setError('El nombre es obligatorio'); return }
    const amt = parseFloat(amount.replace(',', '.'))
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    const inst = installment ? parseFloat(installment.replace(',', '.')) : null
    const dd = dueDay ? parseInt(dueDay, 10) : null
    if (dd !== null && (dd < 1 || dd > 31)) { setError('El día debe ser entre 1 y 31'); return }
    setError('')
    setSaving(true)
    try {
      if (initial) {
        await debtService.updateDebt(initial.id, user.id, {
          name: name.trim(), lender_name: lender.trim() || null,
          description: description.trim() || null,
          installment_amount: inst, due_day: dd, status: initial.status,
        })
        showToast({ message: 'Deuda actualizada', type: 'success' })
      } else {
        await debtService.createDebt(user.id, {
          name: name.trim(), lender_name: lender.trim() || null,
          description: description.trim() || null,
          currency, initial_amount: amt, installment_amount: inst, due_day: dd,
        })
        showToast({ message: 'Deuda creada', type: 'success' })
      }
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'saveDebt', e)
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
      title={initial ? 'Editar deuda' : 'Nueva deuda'}
      onClose={onClose}
      testId="personal-debt-form"
      footer={
        <PrimaryBtn testId="personal-debt-save" onClick={handleSave} loading={saving} fullWidth>
          {saving ? 'Guardando…' : (initial ? 'Guardar cambios' : 'Crear deuda')}
        </PrimaryBtn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <PersonalInput
          testId="personal-debt-name"
          label="Nombre de la deuda *"
          value={name} onChange={e => setName(e.target.value)}
          placeholder="Ej: Préstamo banco, Cuotas auto..."
          autoCapitalize="words" autoComplete="off"
        />
        <PersonalInput
          label="Acreedor (opcional)"
          value={lender} onChange={e => setLender(e.target.value)}
          placeholder="Ej: Banco Galicia, Juan..."
          autoCapitalize="words" autoComplete="off"
        />

        {!initial && (
          <>
            {/* Monto total — large display */}
            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>
                Monto total *
              </label>
              <input
                data-testid="personal-debt-amount"
                type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*"
                value={amount} onChange={e => setAmount(e.target.value)}
                placeholder="0" autoFocus autoComplete="off"
                style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.875rem', color: '#f87171', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
              />
            </div>

            <PersonalSelect label="Moneda" value={currency} onChange={e => setCurrency(e.target.value)}>
              <option value="ARS">ARS — Pesos</option>
              <option value="USD">USD — Dólares</option>
            </PersonalSelect>
          </>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <PersonalInput
            label="Cuota mensual (opcional)"
            type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*"
            value={installment} onChange={e => setInstallment(e.target.value)}
            placeholder="0" autoComplete="off"
          />
          <PersonalInput
            label="Día de vencimiento (1–31)"
            type="text" inputMode="numeric" pattern="[0-9]*"
            value={dueDay} onChange={e => setDueDay(e.target.value)}
            placeholder="Ej: 15" autoComplete="off"
          />
        </div>

        <PersonalInput
          label="Descripción (opcional)"
          value={description} onChange={e => setDescription(e.target.value)}
          placeholder="Detalle del préstamo..."
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

// ─────────────────────────────────────────────────────────────────────────────
// DebtPaymentForm — register a payment
// ─────────────────────────────────────────────────────────────────────────────
function DebtPaymentForm({ debt, accounts, onSaved, onClose }: {
  debt: PersonalDebt
  accounts: PersonalAccount[]
  onSaved: () => void
  onClose: () => void
}) {
  const [accountId,  setAccountId]  = useState(accounts[0]?.id ?? '')
  const [amount,     setAmount]     = useState(debt.installment_amount ? String(debt.installment_amount) : '')
  const [date,       setDate]       = useState(new Date().toISOString().split('T')[0])
  const [notes,      setNotes]      = useState('')
  const [confirmed,  setConfirmed]  = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState('')

  const amt = parseFloat(amount.replace(',', '.'))
  const remaining = Number(debt.current_balance)
  const isValid = amt > 0 && !!accountId
  const exceedsBalance = amt > remaining
  const paysOff = isValid && !exceedsBalance && (remaining - amt) <= 0.01

  const handleSave = async () => {
    if (saving) return
    if (!accountId) { setError('Seleccioná una cuenta'); return }
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    if (exceedsBalance) { setError(`No podés pagar más de ${fmtMoney(remaining, debt.currency)}`); return }
    setError('')
    setSaving(true)
    try {
      await debtService.payDebt({
        debtId: debt.id, accountId, amount: amt, date,
        notes: notes.trim() || null,
      })
      showToast({ message: paysOff ? `¡Deuda "${debt.name}" pagada completamente!` : `Pago de ${fmtMoney(amt, debt.currency)} registrado`, type: 'success' })
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'payDebt', e)
      const msg = e.message || 'Error al registrar el pago'
      setError(msg)
      showToast({ message: msg, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const activeAccounts = accounts.filter(a => a.is_active)

  return (
    <PersonalBottomSheet
      open
      title={`Pagar: ${debt.name}`}
      onClose={onClose}
      testId="personal-debt-payment-form"
      footer={
        <PrimaryBtn
          testId="personal-debt-payment-save"
          onClick={handleSave} loading={saving}
          disabled={!confirmed || !isValid || exceedsBalance}
          fullWidth
        >
          {saving ? 'Registrando…' : `Pagar${amt > 0 ? ` ${fmtMoney(amt, debt.currency)}` : ''}`}
        </PrimaryBtn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Remaining balance pill */}
        <div style={{ padding: '0.625rem 0.875rem', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.18)', borderRadius: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.8rem', color: '#475569' }}>Saldo restante</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 800, color: '#f87171', fontSize: '1rem' }}>
            {fmtMoney(remaining, debt.currency)}
          </span>
        </div>

        <PersonalSelect testId="personal-debt-payment-account" label="Cuenta de débito *" value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">Seleccionar cuenta</option>
          {activeAccounts.map(a => <option key={a.id} value={a.id}>{a.name} ({fmtMoney(a.current_balance, debt.currency)})</option>)}
        </PersonalSelect>

        {/* Amount */}
        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Monto del pago *</label>
          <input
            data-testid="personal-debt-payment-amount"
            type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*"
            value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="0" autoFocus autoComplete="off"
            style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: exceedsBalance ? 'rgba(248,113,113,0.05)' : 'rgba(52,211,153,0.05)', border: `1px solid ${exceedsBalance ? 'rgba(248,113,113,0.35)' : 'rgba(52,211,153,0.25)'}`, borderRadius: '0.875rem', color: exceedsBalance ? '#f87171' : '#34d399', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
          />
          {exceedsBalance && <div style={{ fontSize: '0.75rem', color: '#f87171', marginTop: '0.25rem' }}>Máximo: {fmtMoney(remaining, debt.currency)}</div>}
        </div>

        <PersonalInput label="Fecha" type="date" value={date} onChange={e => setDate(e.target.value)} />
        <PersonalInput label="Nota (opcional)" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Ej: Cuota junio..." autoCapitalize="sentences" autoComplete="off" />

        {paysOff && (
          <div style={{ padding: '0.625rem 0.875rem', background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.25)', borderRadius: '0.75rem', fontSize: '0.8rem', color: '#818cf8', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <Check size={14} style={{ flexShrink: 0 }} />
            Con este pago cancelás la deuda completamente 🎉
          </div>
        )}

        {isValid && !exceedsBalance && (
          <div
            data-testid="personal-debt-payment-confirm"
            onClick={() => setConfirmed(c => !c)}
            role="checkbox" aria-checked={confirmed}
            style={{ padding: '0.875rem', background: confirmed ? 'rgba(52,211,153,0.08)' : 'rgba(255,255,255,0.025)', border: `1px solid ${confirmed ? 'rgba(52,211,153,0.35)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '0.875rem', cursor: 'pointer', display: 'flex', gap: '0.75rem', alignItems: 'center' }}
          >
            <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${confirmed ? '#34d399' : '#334155'}`, background: confirmed ? 'rgba(52,211,153,0.2)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {confirmed && <Check size={11} color="#34d399" />}
            </div>
            <span style={{ fontSize: '0.8rem', color: confirmed ? '#34d399' : '#475569', fontWeight: 600 }}>
              Confirmo pagar {fmtMoney(amt, debt.currency)} de la deuda "{debt.name}"
            </span>
          </div>
        )}

        {error && <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>{error}</div>}
      </div>
    </PersonalBottomSheet>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DebtDetailSheet — detail + history
// ─────────────────────────────────────────────────────────────────────────────
function DebtDetailSheet({ debt, debtIdx, onPay, onEdit, onStatusChange, onDelete, onClose }: {
  debt: PersonalDebt
  debtIdx: number
  onPay: () => void
  onEdit: () => void
  onStatusChange: (status: PersonalDebt['status']) => void
  onDelete: () => void
  onClose: () => void
}) {
  const color = debtColor(debtIdx)
  const pct   = getDebtPaidPercent(debt)
  const paid  = Number(debt.initial_amount) - Number(debt.current_balance)
  const [payments, setPayments] = useState<PersonalDebtPayment[]>([])
  const [loadingPay, setLoadingPay] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { user } = useAuth()

  useEffect(() => {
    if (!user) return
    debtService.getPayments(debt.id, user.id)
      .then(setPayments)
      .catch(() => {})
      .finally(() => setLoadingPay(false))
  }, [debt.id, user])

  const nextDue = debt.next_due_date
    ? `Vence ${fmt(debt.next_due_date)}`
    : debt.due_day ? `Día ${debt.due_day} de cada mes` : null

  return (
    <PersonalBottomSheet
      open
      title={debt.name}
      onClose={onClose}
      testId="personal-debt-detail"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Status + lender */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: debtStatusColor(debt.status), background: `${debtStatusColor(debt.status)}18`, borderRadius: '99px', padding: '0.2rem 0.625rem' }}>
            {debtStatusLabel(debt.status)}
          </span>
          {debt.lender_name && (
            <span style={{ fontSize: '0.72rem', color: '#475569', background: 'rgba(255,255,255,0.04)', borderRadius: '99px', padding: '0.2rem 0.625rem' }}>
              {debt.lender_name}
            </span>
          )}
          <span style={{ fontSize: '0.72rem', color: '#60a5fa', background: 'rgba(96,165,250,0.08)', borderRadius: '99px', padding: '0.2rem 0.625rem' }}>
            {debt.currency}
          </span>
        </div>

        {/* Progress */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
            <span style={{ fontSize: '0.72rem', color: '#475569' }}>Pagado: <strong style={{ color, fontFamily: 'monospace' }}>{fmtMoney(paid, debt.currency)}</strong></span>
            <span style={{ fontSize: '0.72rem', color: '#475569' }}>Total: <strong style={{ color: '#f0f4ff', fontFamily: 'monospace' }}>{fmtMoney(Number(debt.initial_amount), debt.currency)}</strong></span>
          </div>
          <div style={{ height: 8, borderRadius: 99, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: `linear-gradient(90deg, ${color}, ${color}cc)`, borderRadius: 99, transition: 'width 0.4s' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.375rem' }}>
            <span style={{ fontSize: '0.72rem', color: '#475569' }}>{Math.round(pct)}% pagado</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 800, color: '#f87171', fontSize: '0.875rem' }}>
              Resta {fmtMoney(Number(debt.current_balance), debt.currency)}
            </span>
          </div>
        </div>

        {/* Meta info */}
        {(nextDue || debt.installment_amount || debt.description) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            {nextDue && <span style={{ fontSize: '0.78rem', color: '#fbbf24' }}>{nextDue}</span>}
            {debt.installment_amount && (
              <span style={{ fontSize: '0.78rem', color: '#475569' }}>
                Cuota: <strong style={{ color: '#f0f4ff', fontFamily: 'monospace' }}>{fmtMoney(Number(debt.installment_amount), debt.currency)}</strong>
              </span>
            )}
            {debt.description && <span style={{ fontSize: '0.78rem', color: '#475569' }}>{debt.description}</span>}
          </div>
        )}

        {/* Actions */}
        {debt.status !== 'paid' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <button onClick={onPay} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)', color: '#34d399', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44 }}>
              + Registrar pago
            </button>
            <button onClick={onEdit} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)', color: '#60a5fa', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem' }}>
              <Edit2 size={13} /> Editar
            </button>
            {debt.status === 'active' && (
              <button onClick={() => onStatusChange('paused')} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', color: '#fbbf24', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44 }}>
                Pausar
              </button>
            )}
            {debt.status === 'paused' && (
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
              {payments.slice(0, 8).map((p, i) => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', borderBottom: i < payments.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                  <div>
                    <div style={{ fontSize: '0.8rem', color: '#f0f4ff', fontWeight: 600 }}>
                      {new Date(p.payment_date + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}
                    </div>
                    {p.notes && <div style={{ fontSize: '0.7rem', color: '#334155' }}>{p.notes}</div>}
                  </div>
                  <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#34d399', fontSize: '0.875rem' }}>
                    {fmtMoney(Number(p.amount), debt.currency)}
                  </span>
                </div>
            ))}
            </Card>
          </>
        )}

        {/* Delete */}
        {confirmDelete ? (
          <div style={{ padding: '0.875rem', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            <div style={{ fontSize: '0.8rem', color: '#f87171' }}>¿Eliminar la deuda "{debt.name}" y su historial de pagos?</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              <button onClick={() => setConfirmDelete(false)} style={{ padding: '0.625rem', borderRadius: '0.625rem', background: 'none', border: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8', fontSize: '0.8rem', cursor: 'pointer', minHeight: 40 }}>Cancelar</button>
              <button onClick={onDelete} style={{ padding: '0.625rem', borderRadius: '0.625rem', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 40 }}>Eliminar</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} style={{ width: '100%', padding: '0.625rem', background: 'none', border: 'none', cursor: 'pointer', color: '#334155', fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem', minHeight: 36 }}>
            <Trash2 size={12} /> Eliminar deuda
          </button>
        )}
      </div>
    </PersonalBottomSheet>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PersonalDebts — main page
// ─────────────────────────────────────────────────────────────────────────────
export function PersonalDebts() {
  const { user } = useAuth()
  const [loading,  setLoading]  = useState(true)
  const [debts,    setDebts]    = useState<PersonalDebt[]>([])
  const [accounts, setAccounts] = useState<PersonalAccount[]>([])

  // Sheet state
  const [showForm,    setShowForm]    = useState(false)
  const [editingDebt, setEditingDebt] = useState<PersonalDebt | null>(null)
  const [payingDebt,  setPayingDebt]  = useState<PersonalDebt | null>(null)
  const [detailDebt,  setDetailDebt]  = useState<PersonalDebt | null>(null)

  const load = async () => {
    if (!user) return
    setLoading(true)
    try {
      const [d, a] = await Promise.all([
        debtService.getDebts(user.id),
        personalService.getAccounts(user.id),
      ])
      setDebts(d); setAccounts(a)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleStatusChange = async (debt: PersonalDebt, status: PersonalDebt['status']) => {
    if (!user) return
    try {
      await debtService.updateDebt(debt.id, user.id, { ...debt, status })
      showToast({ message: { active: 'Deuda retomada', paused: 'Deuda pausada', paid: 'Deuda marcada como pagada' }[status] ?? 'Estado actualizado', type: 'success' })
      setDetailDebt(null)
      void load()
    } catch (e: any) {
      logger.error('PERSONAL', 'debtStatus', e)
      showToast({ message: e.message || 'Error', type: 'error' })
    }
  }

  const handleDelete = async (debt: PersonalDebt) => {
    if (!user) return
    try {
      await debtService.deleteDebt(debt.id, user.id)
      showToast({ message: 'Deuda eliminada', type: 'success' })
      setDetailDebt(null)
      void load()
    } catch (e: any) {
      logger.error('PERSONAL', 'deleteDebt', e)
      showToast({ message: e.message || 'Error', type: 'error' })
    }
  }

  if (loading) return <PersonalLoading />

  const activeDebts = debts.filter(d => d.status === 'active')
  const pausedDebts = debts.filter(d => d.status === 'paused')
  const paidDebts   = debts.filter(d => d.status === 'paid')

  const summary = debtService.getDebtSummary(debts)

  return (
    <PageContainer testId="personal-debts-page">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff' }}>Deudas</span>
        <button
          data-testid="personal-debt-new-button"
          onClick={() => { setEditingDebt(null); setShowForm(true) }}
          style={{ width: 36, height: 36, borderRadius: '0.75rem', background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#f87171' }}
        >
          <Plus size={18} />
        </button>
      </div>

      {/* Summary */}
      {debts.length > 0 && (
        <div
          data-testid="personal-debts-summary"
          style={{ background: 'linear-gradient(135deg,rgba(248,113,113,0.1),rgba(251,146,60,0.05))', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '1.25rem', padding: '1.25rem' }}
        >
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#dc2626', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.75rem' }}>
            {summary.activeCount} deuda{summary.activeCount !== 1 ? 's' : ''} activa{summary.activeCount !== 1 ? 's' : ''}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: summary.totalUSD > 0 ? '1fr 1fr' : '1fr', gap: '0.75rem' }}>
            {summary.totalARS > 0 && (
              <div>
                <div style={{ fontSize: '0.68rem', color: '#7f1d1d', marginBottom: '0.2rem' }}>Total restante ARS</div>
                <div style={{ fontSize: '1.75rem', fontWeight: 900, color: '#f87171', fontFamily: 'monospace', letterSpacing: '-0.03em', lineHeight: 1 }}>
                  {fmtMoney(summary.totalARS)}
                </div>
              </div>
            )}
            {summary.totalUSD > 0 && (
              <div>
                <div style={{ fontSize: '0.68rem', color: '#7f1d1d', marginBottom: '0.2rem' }}>Total USD</div>
                <div style={{ fontSize: '1.75rem', fontWeight: 900, color: '#fb923c', fontFamily: 'monospace', letterSpacing: '-0.03em', lineHeight: 1 }}>
                  {fmtMoney(summary.totalUSD, 'USD')}
                </div>
              </div>
            )}
          </div>
          {summary.nextDueDate && (
            <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#dc2626', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
              <AlertCircle size={13} style={{ flexShrink: 0 }} />
              Próx. vencimiento: <strong>{summary.nextDueName}</strong> — {fmt(summary.nextDueDate)}
            </div>
          )}
        </div>
      )}

      {/* Quick actions */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem' }}>
        {[
          { label: '+ Nueva deuda', color: '#f87171', bg: 'rgba(248,113,113,0.1)', onClick: () => { setEditingDebt(null); setShowForm(true) } },
          { label: '+ Registrar pago', color: '#34d399', bg: 'rgba(52,211,153,0.1)', onClick: () => { if (activeDebts[0]) setPayingDebt(activeDebts[0]) }, disabled: activeDebts.length === 0 },
        ].map(a => (
          <button key={a.label} onClick={a.onClick} disabled={a.disabled}
            style={{ padding: '0.75rem', borderRadius: '0.875rem', background: a.bg, border: `1px solid ${a.color}30`, color: a.color, fontWeight: 700, fontSize: '0.775rem', cursor: a.disabled ? 'not-allowed' : 'pointer', minHeight: 48, opacity: a.disabled ? 0.4 : 1 }}>
            {a.label}
          </button>
        ))}
      </div>

      {/* Empty state */}
      {debts.length === 0 ? (
        <EmptyPersonal
          icon={<AlertCircle size={22} />}
          title="Sin deudas registradas"
          description="Registrá tus préstamos, tarjetas y cuotas para saber cuánto te falta pagar."
          cta="Agregar primera deuda"
          onCta={() => setShowForm(true)}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {/* Active */}
          {activeDebts.length > 0 && <SectionHeader title="Activas" />}
          {activeDebts.map((debt, i) => {
            const color = debtColor(i)
            const pct   = getDebtPaidPercent(debt)
            return (
              <div
                key={debt.id}
                data-testid="personal-debt-row"
                onClick={() => setDetailDebt(debt)}
                role="button"
                style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '1rem', padding: '1rem', cursor: 'pointer' }}
                onPointerEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                onPointerLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.025)')}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.625rem' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#f0f4ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{debt.name}</div>
                    {debt.lender_name && <div style={{ fontSize: '0.7rem', color: '#334155', marginTop: '0.1rem' }}>{debt.lender_name}</div>}
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '0.5rem' }}>
                    <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '1rem', color: '#f87171' }}>{fmtMoney(Number(debt.current_balance), debt.currency)}</div>
                    {debt.next_due_date && <div style={{ fontSize: '0.65rem', color: '#334155' }}>{fmt(debt.next_due_date)}</div>}
                  </div>
                  <ChevronRight size={14} color="#334155" style={{ flexShrink: 0, marginLeft: '0.25rem', marginTop: '0.25rem' }} />
                </div>
                {/* Progress bar */}
                <div style={{ height: 5, borderRadius: 99, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 99, transition: 'width 0.3s' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.375rem' }}>
                  <span style={{ fontSize: '0.7rem', color: '#475569' }}>{Math.round(pct)}% pagado</span>
                  {debt.installment_amount && <span style={{ fontSize: '0.7rem', color: '#475569' }}>Cuota: {fmtMoney(Number(debt.installment_amount), debt.currency)}</span>}
                </div>
              </div>
            )
          })}

          {/* Paused */}
          {pausedDebts.length > 0 && (
            <>
              <SectionHeader title="Pausadas" />
              <Card style={{ opacity: 0.7 }}>
                {pausedDebts.map((debt, i, arr) => (
                  <div key={debt.id} onClick={() => setDetailDebt(debt)} role="button"
                    style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.875rem 1rem', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', cursor: 'pointer' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#f0f4ff' }}>{debt.name}</div>
                      <div style={{ fontSize: '0.7rem', color: '#334155' }}>{fmtMoney(Number(debt.current_balance), debt.currency)} restante</div>
                    </div>
                    <span style={{ fontSize: '0.68rem', color: '#fbbf24', background: 'rgba(251,191,36,0.08)', borderRadius: '99px', padding: '0.2rem 0.5rem' }}>Pausada</span>
                  </div>
                ))}
              </Card>
            </>
          )}

          {/* Paid */}
          {paidDebts.length > 0 && (
            <>
              <SectionHeader title="Pagadas" />
              <Card style={{ opacity: 0.55 }}>
                {paidDebts.map((debt, i, arr) => (
                  <div key={debt.id} onClick={() => setDetailDebt(debt)} role="button"
                    style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.875rem 1rem', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', cursor: 'pointer' }}>
                    <Check size={15} color="#818cf8" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#f0f4ff' }}>{debt.name}</div>
                      <div style={{ fontSize: '0.7rem', color: '#334155' }}>{fmtMoney(Number(debt.initial_amount), debt.currency)}</div>
                    </div>
                    <span style={{ fontSize: '0.68rem', color: '#818cf8', background: 'rgba(129,140,248,0.08)', borderRadius: '99px', padding: '0.2rem 0.5rem' }}>Pagada</span>
                  </div>
                ))}
              </Card>
            </>
          )}
        </div>
      )}

      {/* Sheets */}
      {(showForm || editingDebt) && (
        <DebtForm
          initial={editingDebt ?? undefined}
          onSaved={() => { setShowForm(false); setEditingDebt(null); void load() }}
          onClose={() => { setShowForm(false); setEditingDebt(null) }}
        />
      )}

      {payingDebt && (
        <DebtPaymentForm
          debt={payingDebt}
          accounts={accounts}
          onSaved={() => { setPayingDebt(null); void load() }}
          onClose={() => setPayingDebt(null)}
        />
      )}

      {detailDebt && (
        <DebtDetailSheet
          debt={detailDebt}
          debtIdx={debts.indexOf(detailDebt)}
          onPay={() => { setPayingDebt(detailDebt); setDetailDebt(null) }}
          onEdit={() => { setEditingDebt(detailDebt); setDetailDebt(null); setShowForm(true) }}
          onStatusChange={s => handleStatusChange(detailDebt, s)}
          onDelete={() => handleDelete(detailDebt)}
          onClose={() => setDetailDebt(null)}
        />
      )}
    </PageContainer>
  )
}
