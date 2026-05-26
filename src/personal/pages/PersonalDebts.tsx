import { useState, useEffect } from 'react'
import { Plus, AlertCircle, Check, Trash2, Edit2, ChevronRight, Eye, EyeOff, TrendingDown, TrendingUp } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import {
  debtService,
  type PersonalDebt, type PersonalDebtPayment,
  getDebtPaidPercent, debtStatusLabel, debtStatusColor, isOverdue,
} from '../services/debtService'
import { personalService, type PersonalAccount } from '../services/personalService'
import {
  PageContainer, Card, SectionHeader, PrimaryBtn, PersonalInput, PersonalSelect,
  EmptyPersonal, PersonalLoading, showToast, fmtMoney,
} from '../components/ui'
import { PersonalBottomSheet } from '../components/PersonalBottomSheet'
import { logger } from '../../lib/logger'

// ── Privacy ────────────────────────────────────────────────────────────────────
const HIDE_KEY = 'miGuitaHideAmounts'
const MASK     = '••••'

// ── Accent colors ─────────────────────────────────────────────────────────────
const DEBT_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#818cf8', '#60a5fa', '#34d399']
const debtColor = (idx: number) => DEBT_COLORS[idx % DEBT_COLORS.length]

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(d: string | null): string {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' })
}

type Filter = 'all' | 'debt' | 'receivable' | 'overdue' | 'paid'

// ─────────────────────────────────────────────────────────────────────────────
// DebtForm — create or edit
// ─────────────────────────────────────────────────────────────────────────────
function DebtForm({ initial, onSaved, onClose }: {
  initial?: PersonalDebt; onSaved: () => void; onClose: () => void
}) {
  const { user } = useAuth()
  const [type,        setType]        = useState<'debt' | 'receivable'>(initial?.type ?? 'debt')
  const [name,        setName]        = useState(initial?.name ?? '')
  const [lender,      setLender]      = useState(initial?.lender_name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [currency,    setCurrency]    = useState(initial?.currency ?? 'ARS')
  const [amount,      setAmount]      = useState(initial ? String(initial.initial_amount) : '')
  const [installment, setInstallment] = useState(initial?.installment_amount != null ? String(initial.installment_amount) : '')
  const [dueDay,      setDueDay]      = useState(initial?.due_day != null ? String(initial.due_day) : '')
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')

  const isDebt = type === 'debt'

  const handleSave = async () => {
    if (!user || saving) return
    if (!name.trim()) { setError('El nombre es obligatorio'); return }
    const amt = parseFloat(amount.replace(',', '.'))
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    const inst = installment ? parseFloat(installment.replace(',', '.')) : null
    const dd   = dueDay ? parseInt(dueDay, 10) : null
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
          type, name: name.trim(), lender_name: lender.trim() || null,
          description: description.trim() || null,
          currency, initial_amount: amt, installment_amount: inst, due_day: dd,
        })
        showToast({ message: isDebt ? 'Deuda creada' : 'Deuda a cobrar creada', type: 'success' })
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

  const personLabel = isDebt ? 'A quién le debo (opcional)' : 'Quién me debe (opcional)'
  const personPlaceholder = isDebt ? 'Ej: Banco Galicia, Juan...' : 'Ej: María, Empresa ABC...'

  return (
    <PersonalBottomSheet
      open
      title={initial ? 'Editar deuda' : 'Nueva deuda'}
      onClose={onClose}
      testId="personal-debt-form"
      footer={
        <PrimaryBtn testId="personal-debt-save" onClick={handleSave} loading={saving} fullWidth>
          {saving ? 'Guardando…' : (initial ? 'Guardar cambios' : (isDebt ? 'Crear deuda' : 'Crear deuda a cobrar'))}
        </PrimaryBtn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Type selector */}
        {!initial && (
          <div data-testid="personal-debt-type-selector" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            {(['debt', 'receivable'] as const).map(t => {
              const selected = type === t
              const color    = t === 'debt' ? '#f87171' : '#34d399'
              const Icon     = t === 'debt' ? TrendingDown : TrendingUp
              return (
                <button
                  key={t}
                  data-testid={`personal-debt-type-${t}`}
                  onClick={() => setType(t)}
                  style={{ padding: '0.875rem 0.5rem', borderRadius: '0.875rem', background: selected ? `${color}12` : 'rgba(255,255,255,0.025)', border: `2px solid ${selected ? color : 'rgba(255,255,255,0.06)'}`, color: selected ? color : '#475569', fontWeight: 700, fontSize: '0.825rem', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.375rem', minHeight: 64, transition: 'all 0.15s' }}
                >
                  <Icon size={18} />
                  {t === 'debt' ? 'Yo debo' : 'Me deben'}
                </button>
              )
            })}
          </div>
        )}

        <PersonalInput
          testId="personal-debt-name"
          label="Nombre de la deuda *"
          value={name} onChange={e => setName(e.target.value)}
          placeholder="Ej: Préstamo banco, Cuotas auto..."
          autoCapitalize="words" autoComplete="off"
        />
        <PersonalInput
          label={personLabel}
          value={lender} onChange={e => setLender(e.target.value)}
          placeholder={personPlaceholder}
          autoCapitalize="words" autoComplete="off"
        />

        {!initial && (
          <>
            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>
                Monto total *
              </label>
              <input
                data-testid="personal-debt-amount"
                type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*"
                value={amount} onChange={e => setAmount(e.target.value)}
                placeholder="0" autoFocus autoComplete="off"
                style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: isDebt ? 'rgba(248,113,113,0.05)' : 'rgba(52,211,153,0.05)', border: `1px solid ${isDebt ? 'rgba(248,113,113,0.25)' : 'rgba(52,211,153,0.25)'}`, borderRadius: '0.875rem', color: isDebt ? '#f87171' : '#34d399', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
              />
            </div>
            <PersonalSelect testId="personal-debt-currency" label="Moneda" value={currency} onChange={e => setCurrency(e.target.value)}>
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
// DebtPaymentForm — register a payment or collection
// ─────────────────────────────────────────────────────────────────────────────
function DebtPaymentForm({ debt, accounts, onSaved, onClose }: {
  debt: PersonalDebt
  accounts: PersonalAccount[]
  onSaved: () => void
  onClose: () => void
}) {
  const [accountId,  setAccountId]  = useState(accounts.find(a => a.is_active)?.id ?? '')
  const [amount,     setAmount]     = useState(debt.installment_amount ? String(debt.installment_amount) : '')
  const [date,       setDate]       = useState(new Date().toISOString().split('T')[0])
  const [notes,      setNotes]      = useState('')
  const [confirmed,  setConfirmed]  = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState('')

  const amt             = parseFloat(amount.replace(',', '.'))
  const remaining       = Number(debt.current_balance)
  const isValid         = amt > 0 && !!accountId
  const exceedsBalance  = amt > remaining
  const paysOff         = isValid && !exceedsBalance && (remaining - amt) <= 0.01
  const activeAccounts  = accounts.filter(a => a.is_active)
  const isReceivable    = debt.type === 'receivable'

  const handleSave = async () => {
    if (saving) return
    if (!accountId) { setError('Seleccioná una cuenta'); return }
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    if (exceedsBalance) { setError(`No podés registrar más de ${fmtMoney(remaining, debt.currency)}`); return }
    setError('')
    setSaving(true)
    try {
      await debtService.payDebt({ debtId: debt.id, accountId, amount: amt, date, notes: notes.trim() || null })
      showToast({
        message: paysOff
          ? `¡${isReceivable ? 'Cobro' : 'Deuda'} "${debt.name}" completado!`
          : `${isReceivable ? 'Cobro' : 'Pago'} de ${fmtMoney(amt, debt.currency)} registrado`,
        type: 'success',
      })
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'payDebt', e)
      const msg = e.message || 'Error al registrar'
      setError(msg)
      showToast({ message: msg, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <PersonalBottomSheet
      open
      title={isReceivable ? `Registrar cobro: ${debt.name}` : `Pagar: ${debt.name}`}
      onClose={onClose}
      testId="personal-debt-payment-form"
      footer={
        <PrimaryBtn
          testId="personal-debt-payment-save"
          onClick={handleSave} loading={saving}
          disabled={!confirmed || !isValid || exceedsBalance}
          fullWidth
        >
          {saving ? 'Registrando…' : `${isReceivable ? 'Cobrar' : 'Pagar'}${amt > 0 ? ` ${fmtMoney(amt, debt.currency)}` : ''}`}
        </PrimaryBtn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ padding: '0.625rem 0.875rem', background: isReceivable ? 'rgba(52,211,153,0.06)' : 'rgba(248,113,113,0.06)', border: `1px solid ${isReceivable ? 'rgba(52,211,153,0.18)' : 'rgba(248,113,113,0.18)'}`, borderRadius: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.8rem', color: '#475569' }}>Saldo restante</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 800, color: isReceivable ? '#34d399' : '#f87171', fontSize: '1rem' }}>
            {fmtMoney(remaining, debt.currency)}
          </span>
        </div>

        <PersonalSelect testId="personal-debt-payment-account" label={isReceivable ? 'Cuenta de ingreso *' : 'Cuenta de débito *'} value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">Seleccionar cuenta</option>
          {activeAccounts.map(a => <option key={a.id} value={a.id}>{a.name} ({fmtMoney(a.current_balance, debt.currency)})</option>)}
        </PersonalSelect>

        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>
            Monto del {isReceivable ? 'cobro' : 'pago'} *
          </label>
          <input
            data-testid="personal-debt-payment-amount"
            type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*"
            value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="0" autoFocus autoComplete="off"
            style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: exceedsBalance ? 'rgba(248,113,113,0.05)' : (isReceivable ? 'rgba(52,211,153,0.05)' : 'rgba(52,211,153,0.05)'), border: `1px solid ${exceedsBalance ? 'rgba(248,113,113,0.35)' : 'rgba(52,211,153,0.25)'}`, borderRadius: '0.875rem', color: exceedsBalance ? '#f87171' : '#34d399', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
          />
          {exceedsBalance && <div style={{ fontSize: '0.75rem', color: '#f87171', marginTop: '0.25rem' }}>Máximo: {fmtMoney(remaining, debt.currency)}</div>}
        </div>

        <PersonalInput label="Fecha" type="date" value={date} onChange={e => setDate(e.target.value)} />
        <PersonalInput label="Nota (opcional)" value={notes} onChange={e => setNotes(e.target.value)} placeholder={isReceivable ? 'Ej: Cobro junio...' : 'Ej: Cuota junio...'} autoCapitalize="sentences" autoComplete="off" />

        {paysOff && (
          <div style={{ padding: '0.625rem 0.875rem', background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.25)', borderRadius: '0.75rem', fontSize: '0.8rem', color: '#818cf8', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <Check size={14} style={{ flexShrink: 0 }} />
            {isReceivable ? 'Con este cobro cerrás la deuda completa 🎉' : 'Con este pago cancelás la deuda completamente 🎉'}
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
              Confirmo {isReceivable ? 'cobrar' : 'pagar'} {fmtMoney(amt, debt.currency)} de "{debt.name}"
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
function DebtDetailSheet({ debt, debtIdx, hidden, onPay, onEdit, onStatusChange, onDelete, onClose }: {
  debt: PersonalDebt
  debtIdx: number
  hidden: boolean
  onPay: () => void
  onEdit: () => void
  onStatusChange: (status: PersonalDebt['status']) => void
  onDelete: () => void
  onClose: () => void
}) {
  const color   = debtColor(debtIdx)
  const pct     = getDebtPaidPercent(debt)
  const paid    = Number(debt.initial_amount) - Number(debt.current_balance)
  const overdue = isOverdue(debt)
  const [payments,       setPayments]       = useState<PersonalDebtPayment[]>([])
  const [loadingPay,     setLoadingPay]     = useState(true)
  const [confirmDelete,  setConfirmDelete]  = useState(false)
  const { user } = useAuth()

  const amtH = (n: number) => hidden ? MASK : fmtMoney(n, debt.currency)

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

  const isReceivable = debt.type === 'receivable'

  return (
    <PersonalBottomSheet
      open
      title={debt.name}
      onClose={onClose}
      testId="personal-debt-detail"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Status + meta chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: debtStatusColor(debt), background: `${debtStatusColor(debt)}18`, borderRadius: '99px', padding: '0.2rem 0.625rem' }}>
            {debtStatusLabel(debt)}
          </span>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: isReceivable ? '#34d399' : '#f87171', background: isReceivable ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)', borderRadius: '99px', padding: '0.2rem 0.625rem' }}>
            {isReceivable ? 'Me deben' : 'Yo debo'}
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
            <span style={{ fontSize: '0.72rem', color: '#475569' }}>Pagado: <strong style={{ color, fontFamily: 'monospace' }}>{amtH(paid)}</strong></span>
            <span style={{ fontSize: '0.72rem', color: '#475569' }}>Total: <strong style={{ color: '#f0f4ff', fontFamily: 'monospace' }}>{amtH(Number(debt.initial_amount))}</strong></span>
          </div>
          <div style={{ height: 8, borderRadius: 99, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: `linear-gradient(90deg, ${color}, ${color}cc)`, borderRadius: 99, transition: 'width 0.4s' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.375rem' }}>
            <span style={{ fontSize: '0.72rem', color: '#475569' }}>{Math.round(pct)}% completado</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 800, color: isReceivable ? '#34d399' : '#f87171', fontSize: '0.875rem' }}>
              Resta {amtH(Number(debt.current_balance))}
            </span>
          </div>
        </div>

        {/* Meta info */}
        {(nextDue || debt.installment_amount || debt.description) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            {nextDue && (
              <span style={{ fontSize: '0.78rem', color: overdue ? '#f87171' : '#fbbf24' }}>
                {overdue ? '⚠ ' : ''}{nextDue}
              </span>
            )}
            {debt.installment_amount && (
              <span style={{ fontSize: '0.78rem', color: '#475569' }}>
                Cuota: <strong style={{ color: '#f0f4ff', fontFamily: 'monospace' }}>{amtH(Number(debt.installment_amount))}</strong>
              </span>
            )}
            {debt.description && <span style={{ fontSize: '0.78rem', color: '#475569' }}>{debt.description}</span>}
          </div>
        )}

        {/* Actions */}
        {debt.status !== 'paid' && debt.status !== 'cancelled' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <button data-testid="personal-debt-pay-button" onClick={onPay} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: isReceivable ? 'rgba(52,211,153,0.1)' : 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)', color: '#34d399', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44 }}>
              {isReceivable ? '+ Registrar cobro' : '+ Registrar pago'}
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
            <button onClick={() => onStatusChange('cancelled')} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(71,85,105,0.08)', border: '1px solid rgba(71,85,105,0.2)', color: '#475569', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44 }}>
              Cancelar
            </button>
          </div>
        )}

        {/* Payment history */}
        {!loadingPay && payments.length > 0 && (
          <>
            <SectionHeader title={isReceivable ? 'Historial de cobros' : 'Historial de pagos'} />
            <Card>
              {payments.slice(0, 8).map((p, i) => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', borderBottom: i < Math.min(payments.length, 8) - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                  <div>
                    <div style={{ fontSize: '0.8rem', color: '#f0f4ff', fontWeight: 600 }}>
                      {new Date(p.payment_date + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}
                    </div>
                    {p.notes && <div style={{ fontSize: '0.7rem', color: '#334155' }}>{p.notes}</div>}
                  </div>
                  <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#34d399', fontSize: '0.875rem' }}>
                    {hidden ? MASK : fmtMoney(Number(p.amount), debt.currency)}
                  </span>
                </div>
              ))}
            </Card>
          </>
        )}
        {!loadingPay && payments.length === 0 && debt.status === 'active' && (
          <div style={{ textAlign: 'center', fontSize: '0.8rem', color: '#334155', padding: '0.5rem' }}>
            No hay pagos registrados aún.
          </div>
        )}

        {/* Delete */}
        {confirmDelete ? (
          <div style={{ padding: '0.875rem', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            <div style={{ fontSize: '0.8rem', color: '#f87171' }}>¿Eliminar la deuda "{debt.name}" y su historial?</div>
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
  const [filter,   setFilter]   = useState<Filter>('all')

  // Privacy toggle — shared via localStorage
  const [hidden, setHidden] = useState(() => localStorage.getItem(HIDE_KEY) === 'true')
  const toggleHidden = () => {
    const next = !hidden
    setHidden(next)
    localStorage.setItem(HIDE_KEY, String(next))
  }

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
      const msgs: Record<PersonalDebt['status'], string> = {
        active: 'Deuda retomada', paused: 'Deuda pausada',
        paid: 'Deuda marcada como pagada', cancelled: 'Deuda cancelada',
      }
      showToast({ message: msgs[status] ?? 'Estado actualizado', type: 'success' })
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

  const today = new Date().toISOString().split('T')[0]

  const activeDebts   = debts.filter(d => d.status === 'active')
  const pausedDebts   = debts.filter(d => d.status === 'paused')
  const paidDebts     = debts.filter(d => d.status === 'paid')
  const cancelledDebts = debts.filter(d => d.status === 'cancelled')
  const overdueDebts  = activeDebts.filter(d => d.next_due_date && d.next_due_date < today)

  // Filter display
  const filteredActive = activeDebts.filter(d => {
    if (filter === 'debt')       return d.type === 'debt'
    if (filter === 'receivable') return d.type === 'receivable'
    if (filter === 'overdue')    return isOverdue(d)
    if (filter === 'paid')       return false
    return true // 'all'
  })

  const summary = debtService.getDebtSummary(debts)
  const amt     = (n: number, cur = 'ARS') => hidden ? MASK : fmtMoney(n, cur)

  const FILTERS: { key: Filter; label: string; count?: number }[] = [
    { key: 'all',        label: 'Todas',      count: activeDebts.length },
    { key: 'debt',       label: 'Yo debo',    count: activeDebts.filter(d => d.type === 'debt').length },
    { key: 'receivable', label: 'Me deben',   count: activeDebts.filter(d => d.type === 'receivable').length },
    { key: 'overdue',    label: 'Vencidas',   count: overdueDebts.length },
    { key: 'paid',       label: 'Pagadas',    count: paidDebts.length },
  ]

  return (
    <PageContainer testId="personal-debts-page">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff' }}>Deudas</span>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            data-testid="personal-debts-toggle-hide"
            onClick={toggleHidden}
            aria-label={hidden ? 'Mostrar importes' : 'Ocultar importes'}
            style={{ width: 32, height: 32, borderRadius: '0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#475569' }}
          >
            {hidden ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          <button
            data-testid="personal-debt-new-button"
            onClick={() => { setEditingDebt(null); setShowForm(true) }}
            style={{ width: 36, height: 36, borderRadius: '0.75rem', background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#f87171' }}
          >
            <Plus size={18} />
          </button>
        </div>
      </div>

      {/* Summary cards */}
      {debts.length > 0 && (
        <div data-testid="personal-debts-summary" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          {/* I owe */}
          <div style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.18)', borderRadius: '1rem', padding: '0.875rem' }}>
            <div style={{ fontSize: '0.62rem', fontWeight: 700, color: '#dc2626', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.375rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <TrendingDown size={10} /> Yo debo
            </div>
            <div data-testid="personal-debts-total-owed" style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '1.125rem', color: '#f87171', lineHeight: 1 }}>
              {amt(summary.totalOwed)}
            </div>
            {summary.totalOwedUSD > 0 && (
              <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#fb923c', marginTop: '0.2rem' }}>
                + {amt(summary.totalOwedUSD, 'USD')}
              </div>
            )}
          </div>

          {/* Owed to me */}
          <div style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.18)', borderRadius: '1rem', padding: '0.875rem' }}>
            <div style={{ fontSize: '0.62rem', fontWeight: 700, color: '#059669', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.375rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <TrendingUp size={10} /> Me deben
            </div>
            <div data-testid="personal-debts-total-receivable" style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '1.125rem', color: '#34d399', lineHeight: 1 }}>
              {amt(summary.totalReceivable)}
            </div>
            {summary.totalReceivableUSD > 0 && (
              <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#4ade80', marginTop: '0.2rem' }}>
                + {amt(summary.totalReceivableUSD, 'USD')}
              </div>
            )}
          </div>

          {/* Net balance — full width */}
          {(summary.totalOwed > 0 || summary.totalReceivable > 0) && (
            <div style={{ gridColumn: '1 / -1', background: 'rgba(129,140,248,0.06)', border: '1px solid rgba(129,140,248,0.18)', borderRadius: '1rem', padding: '0.75rem 0.875rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.72rem', color: '#475569', fontWeight: 600 }}>Saldo neto</span>
              <span data-testid="personal-debts-net" style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '1rem', color: summary.totalReceivable >= summary.totalOwed ? '#34d399' : '#f87171' }}>
                {summary.totalReceivable >= summary.totalOwed
                  ? `+${amt(summary.totalReceivable - summary.totalOwed)}`
                  : `-${amt(summary.totalOwed - summary.totalReceivable)}`}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Next due alert */}
      {summary.nextDueDate && (
        <div style={{ padding: '0.625rem 0.875rem', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '0.75rem', fontSize: '0.78rem', color: '#fbbf24', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <AlertCircle size={13} style={{ flexShrink: 0 }} />
          Próx. vencimiento: <strong>{summary.nextDueName}</strong> — {fmt(summary.nextDueDate)}
        </div>
      )}

      {/* Filter tabs */}
      {debts.length > 0 && (
        <div data-testid="personal-debts-filters" style={{ display: 'flex', gap: '0.375rem', overflowX: 'auto', paddingBottom: '0.25rem' }}>
          {FILTERS.map(f => {
            const active = filter === f.key
            return (
              <button
                key={f.key}
                data-testid={`personal-debts-filter-${f.key}`}
                onClick={() => setFilter(f.key)}
                style={{ flexShrink: 0, padding: '0.375rem 0.75rem', borderRadius: '99px', background: active ? 'rgba(129,140,248,0.12)' : 'rgba(255,255,255,0.03)', border: `1px solid ${active ? 'rgba(129,140,248,0.4)' : 'rgba(255,255,255,0.06)'}`, color: active ? '#818cf8' : '#475569', fontWeight: active ? 700 : 500, fontSize: '0.775rem', cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                {f.label}{f.count !== undefined && f.count > 0 ? ` (${f.count})` : ''}
              </button>
            )
          })}
        </div>
      )}

      {/* Empty state */}
      {debts.length === 0 ? (
        <EmptyPersonal
          testId="personal-debts-empty"
          icon={<AlertCircle size={22} />}
          title="Todavía no registraste deudas"
          description="Creá tu primera deuda para seguir lo que debés o lo que te deben."
          cta="Agregar primera deuda"
          onCta={() => setShowForm(true)}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>

          {/* Filtered active debts */}
          {filter !== 'paid' && filteredActive.length === 0 && filter !== 'all' && (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#334155', fontSize: '0.85rem' }}>
              {filter === 'overdue' ? 'No tenés deudas vencidas.' : 'No hay deudas en esta categoría.'}
            </div>
          )}

          {filteredActive.length > 0 && (
            <>
              {filter !== 'all' && <SectionHeader title={FILTERS.find(f => f.key === filter)?.label ?? ''} />}
              {filter === 'all' && activeDebts.filter(d => d.type === 'debt').length > 0 && <SectionHeader title="Yo debo" />}
              {filteredActive.filter(d => filter !== 'all' || d.type === 'debt').map((debt) => (
                <DebtRow key={debt.id} debt={debt} debtIdx={debts.indexOf(debt)} hidden={hidden} onOpen={() => setDetailDebt(debt)} />
              ))}
              {filter === 'all' && activeDebts.filter(d => d.type === 'receivable').length > 0 && (
                <>
                  <SectionHeader title="Me deben" />
                  {activeDebts.filter(d => d.type === 'receivable').map((debt) => (
                    <DebtRow key={debt.id} debt={debt} debtIdx={debts.indexOf(debt)} hidden={hidden} onOpen={() => setDetailDebt(debt)} />
                  ))}
                </>
              )}
            </>
          )}

          {/* Paused */}
          {(filter === 'all') && pausedDebts.length > 0 && (
            <>
              <SectionHeader title="Pausadas" />
              <Card style={{ opacity: 0.7 }}>
                {pausedDebts.map((debt, i, arr) => (
                  <div key={debt.id} data-testid="personal-debt-row" onClick={() => setDetailDebt(debt)} role="button"
                    style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.875rem 1rem', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', cursor: 'pointer' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#f0f4ff' }}>{debt.name}</div>
                      <div style={{ fontSize: '0.7rem', color: '#334155' }}>{hidden ? MASK : fmtMoney(Number(debt.current_balance), debt.currency)} restante</div>
                    </div>
                    <span style={{ fontSize: '0.68rem', color: '#fbbf24', background: 'rgba(251,191,36,0.08)', borderRadius: '99px', padding: '0.2rem 0.5rem' }}>Pausada</span>
                  </div>
                ))}
              </Card>
            </>
          )}

          {/* Paid (shown in filter or at bottom of all) */}
          {(filter === 'paid' || filter === 'all') && paidDebts.length > 0 && (
            <>
              <SectionHeader title="Pagadas" />
              <Card style={{ opacity: 0.55 }}>
                {paidDebts.map((debt, i, arr) => (
                  <div key={debt.id} data-testid="personal-debt-row" onClick={() => setDetailDebt(debt)} role="button"
                    style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.875rem 1rem', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', cursor: 'pointer' }}>
                    <Check size={15} color="#818cf8" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#f0f4ff' }}>{debt.name}</div>
                      <div style={{ fontSize: '0.7rem', color: '#334155' }}>{hidden ? MASK : fmtMoney(Number(debt.initial_amount), debt.currency)}</div>
                    </div>
                    <span style={{ fontSize: '0.68rem', color: '#818cf8', background: 'rgba(129,140,248,0.08)', borderRadius: '99px', padding: '0.2rem 0.5rem' }}>Pagada</span>
                  </div>
                ))}
              </Card>
            </>
          )}

          {/* Cancelled — always at bottom, collapsed */}
          {filter === 'all' && cancelledDebts.length > 0 && (
            <>
              <SectionHeader title="Canceladas" />
              <Card style={{ opacity: 0.45 }}>
                {cancelledDebts.map((debt, i, arr) => (
                  <div key={debt.id} style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.75rem 1rem', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, fontSize: '0.8rem', color: '#475569' }}>{debt.name}</div>
                    </div>
                    <span style={{ fontSize: '0.68rem', color: '#475569', background: 'rgba(71,85,105,0.08)', borderRadius: '99px', padding: '0.2rem 0.5rem' }}>Cancelada</span>
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
          hidden={hidden}
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

// ─────────────────────────────────────────────────────────────────────────────
// DebtRow — reusable card for active debt display
// ─────────────────────────────────────────────────────────────────────────────
function DebtRow({ debt, debtIdx, hidden, onOpen }: {
  debt: PersonalDebt; debtIdx: number; hidden: boolean; onOpen: () => void
}) {
  const color    = debtColor(debtIdx)
  const pct      = getDebtPaidPercent(debt)
  const overdue  = isOverdue(debt)
  const isReceivable = debt.type === 'receivable'
  const amtColor = isReceivable ? '#34d399' : '#f87171'

  return (
    <div
      data-testid="personal-debt-row"
      onClick={onOpen}
      role="button"
      style={{ background: 'rgba(255,255,255,0.025)', border: `1px solid ${overdue ? 'rgba(248,113,113,0.25)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '1rem', padding: '1rem', cursor: 'pointer' }}
      onPointerEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
      onPointerLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.025)')}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.625rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '0.1rem' }}>
            <div data-testid="personal-debt-name" style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#f0f4ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{debt.name}</div>
            {overdue && <AlertCircle size={12} color="#f87171" style={{ flexShrink: 0 }} />}
          </div>
          {debt.lender_name && <div style={{ fontSize: '0.7rem', color: '#334155' }}>{debt.lender_name}</div>}
          <span style={{ fontSize: '0.65rem', color: isReceivable ? '#34d399' : '#f87171', background: isReceivable ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)', borderRadius: '99px', padding: '0.1rem 0.4rem', marginTop: '0.25rem', display: 'inline-block' }}>
            {isReceivable ? 'Me deben' : 'Yo debo'}
          </span>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '0.5rem' }}>
          <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '1rem', color: amtColor }}>
            {hidden ? MASK : fmtMoney(Number(debt.current_balance), debt.currency)}
          </div>
          {debt.next_due_date && (
            <div style={{ fontSize: '0.65rem', color: overdue ? '#f87171' : '#334155' }}>
              {overdue ? 'Vencida' : fmt(debt.next_due_date)}
            </div>
          )}
        </div>
        <ChevronRight size={14} color="#334155" style={{ flexShrink: 0, marginLeft: '0.25rem', marginTop: '0.25rem' }} />
      </div>
      <div style={{ height: 5, borderRadius: 99, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 99, transition: 'width 0.3s' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.375rem' }}>
        <span style={{ fontSize: '0.7rem', color: '#475569' }}>{Math.round(pct)}% completado</span>
        {debt.installment_amount && <span style={{ fontSize: '0.7rem', color: '#475569' }}>Cuota: {hidden ? MASK : fmtMoney(Number(debt.installment_amount), debt.currency)}</span>}
      </div>
    </div>
  )
}
