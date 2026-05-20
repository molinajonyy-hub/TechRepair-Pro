import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Target, X, Edit2, Pause, Play, Check, Trash2 } from 'lucide-react'
import { PersonalBottomSheet } from '../components/PersonalBottomSheet'
import { useAuth } from '../../contexts/AuthContext'
import { savingsService, type SavingsGoal } from '../services/savingsService'
import { type PersonalAccount, type PersonalCategory, personalService } from '../services/personalService'
import {
  PageContainer, Card, SectionHeader, PrimaryBtn, PersonalInput, PersonalSelect,
  EmptyPersonal, PersonalLoading, showToast, fmtMoney, fmtMoneyCompact,
} from '../components/ui'
import {
  getGoalProgress, getGoalRemainingAmount, getGoalStatusLabel, getGoalStatusColor,
  getSavingsSummary, sortGoalsByRelevance, isGoalCompleted,
  getEstimatedMonthlyNeeded,
} from '../utils/savings'
import { logger } from '../../lib/logger'

// ── Goal accent colors ────────────────────────────────────────────────────────
const GOAL_COLORS = ['#34d399', '#60a5fa', '#fbbf24', '#818cf8', '#f87171', '#a78bfa', '#fb923c']
const goalColor = (idx: number) => GOAL_COLORS[idx % GOAL_COLORS.length]

// ─────────────────────────────────────────────────────────────────────────────
// GoalForm — create or edit a savings goal
// ─────────────────────────────────────────────────────────────────────────────
function GoalForm({ initial, accounts, onSaved, onClose }: {
  initial?: SavingsGoal
  accounts: PersonalAccount[]
  onSaved: () => void
  onClose: () => void
}) {
  const { user } = useAuth()
  const [name, setName]           = useState(initial?.name ?? '')
  const [target, setTarget]       = useState(initial ? String(initial.target_amount) : '')
  const [current, setCurrent]     = useState(initial ? String(initial.current_amount) : '0')
  const [currency, setCurrency]   = useState(initial?.currency ?? 'ARS')
  const [targetDate, setTargetDate] = useState(initial?.target_date ?? '')
  const [accountId, setAccountId] = useState(initial?.account_id ?? '')
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')

  const handleSave = async () => {
    if (!user || saving) return
    if (!name.trim()) { setError('El nombre es obligatorio'); return }
    const tgt = parseFloat(target.replace(',', '.'))
    if (!tgt || tgt <= 0) { setError('El monto objetivo debe ser mayor a $0'); return }
    const cur = parseFloat(current.replace(',', '.')) || 0
    if (cur < 0) { setError('El monto inicial no puede ser negativo'); return }
    setError('')
    setSaving(true)
    try {
      if (initial) {
        await savingsService.updateSavingsGoal(initial.id, user.id, {
          name: name.trim(),
          target_amount: tgt,
          currency,
          target_date: targetDate || null,
          account_id: accountId || null,
        })
        showToast({ message: 'Objetivo actualizado', type: 'success' })
      } else {
        await savingsService.createSavingsGoal(user.id, {
          name: name.trim(),
          target_amount: tgt,
          // MVP: initial amount is "already saved" — no debit from account
          current_amount: cur,
          currency,
          target_date: targetDate || null,
          account_id: accountId || null,
        })
        showToast({ message: 'Objetivo creado', type: 'success' })
      }
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'saveGoal', e)
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
      title={initial ? 'Editar objetivo' : 'Nuevo objetivo'}
      onClose={onClose}
      testId="personal-savings-form"
      footer={
        <PrimaryBtn testId="personal-savings-save" onClick={handleSave} loading={saving} fullWidth>
          {saving ? 'Guardando…' : (initial ? 'Guardar cambios' : 'Crear objetivo')}
        </PrimaryBtn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <PersonalInput testId="personal-savings-name-input" label="Nombre del objetivo *" value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Fondo de emergencia, Viaje, iPhone..." />
        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Meta *</label>
          <input
            data-testid="personal-savings-target-input"
            type="number" min="0" step="1" value={target}
            onChange={e => setTarget(e.target.value)} placeholder="0" autoFocus
            style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: 'rgba(52,211,153,0.05)', border: '1px solid rgba(52,211,153,0.25)', borderRadius: '0.875rem', color: '#34d399', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
          />
        </div>
        {!initial && (
          <PersonalInput
            testId="personal-savings-current-input"
            label="Ya tenés ahorrado (opcional)"
            type="number" min="0" step="1" value={current}
            onChange={e => setCurrent(e.target.value)} placeholder="0"
          />
        )}
        <PersonalSelect testId="personal-savings-currency" label="Moneda" value={currency} onChange={e => setCurrency(e.target.value)}>
          <option value="ARS">ARS — Pesos</option>
          <option value="USD">USD — Dólares</option>
        </PersonalSelect>
        <PersonalInput testId="personal-savings-target-date" label="Fecha objetivo (opcional)" type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} />
        {accounts.length > 0 && (
          <PersonalSelect testId="personal-savings-account" label="Cuenta asociada (opcional)" value={accountId} onChange={e => setAccountId(e.target.value)}>
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
// ContributeForm — deposit to a savings goal
// ─────────────────────────────────────────────────────────────────────────────
function ContributeForm({ goals, accounts, defaultGoalId, onSaved, onClose }: {
  goals: SavingsGoal[]
  accounts: PersonalAccount[]
  defaultGoalId?: string
  onSaved: () => void
  onClose: () => void
}) {
  const { user } = useAuth()
  const activeGoals = goals.filter(g => g.status === 'active' || g.status === 'paused')
  const [goalId, setGoalId]       = useState(defaultGoalId ?? activeGoals[0]?.id ?? '')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [amount, setAmount]       = useState('')
  const [date, setDate]           = useState(new Date().toISOString().split('T')[0])
  const [notes, setNotes]         = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')

  const selectedGoal = goals.find(g => g.id === goalId)
  const amt = parseFloat(amount.replace(',', '.'))
  const isValid = amt > 0 && !!goalId && !!accountId
  const wouldComplete = selectedGoal && isValid &&
    (Number(selectedGoal.current_amount) + amt) >= Number(selectedGoal.target_amount)

  const handleSave = async () => {
    if (!user || saving) return
    if (!goalId) { setError('Seleccioná un objetivo'); return }
    if (!accountId) { setError('Seleccioná una cuenta'); return }
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    setError('')
    setSaving(true)
    try {
      await savingsService.contributeToGoal({ goalId, accountId, amount: amt, date, notes: notes.trim() || null })
      showToast({ message: wouldComplete ? `¡Objetivo completado! +${fmtMoney(amt)}` : `Aporte de ${fmtMoney(amt)} registrado`, type: 'success' })
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'contributeGoal', e)
      const msg = e.message || 'Error al aportar'
      setError(msg)
      showToast({ message: msg, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <PersonalBottomSheet
      open
      title="Aportar a objetivo"
      onClose={onClose}
      testId="personal-savings-contribute-form"
      footer={
        <PrimaryBtn testId="personal-savings-contribute-save" onClick={handleSave} loading={saving} disabled={!confirmed || !isValid} fullWidth>
          {saving ? 'Aportando…' : `Aportar${amt > 0 ? ` ${fmtMoney(amt)}` : ''}`}
        </PrimaryBtn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <PersonalSelect testId="personal-savings-contribute-goal" label="Objetivo *" value={goalId} onChange={e => setGoalId(e.target.value)}>
          <option value="">Seleccionar objetivo</option>
          {activeGoals.map(g => (
            <option key={g.id} value={g.id}>{g.name} ({fmtMoneyCompact(Number(g.current_amount))}/{fmtMoneyCompact(Number(g.target_amount))} {g.currency})</option>
          ))}
        </PersonalSelect>
        <PersonalSelect testId="personal-savings-contribute-account" label="Cuenta origen *" value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">Seleccionar cuenta</option>
          {accounts.filter(a => a.is_active).map(a => <option key={a.id} value={a.id}>{a.name} ({fmtMoney(a.current_balance)})</option>)}
        </PersonalSelect>
        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Monto del aporte *</label>
          <input
            data-testid="personal-savings-contribute-amount"
            type="number" min="0" step="1" value={amount}
            onChange={e => { setAmount(e.target.value); setConfirmed(false) }}
            placeholder="0" autoFocus
            style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: 'rgba(52,211,153,0.05)', border: '1px solid rgba(52,211,153,0.25)', borderRadius: '0.875rem', color: '#34d399', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
          />
        </div>
        <PersonalInput testId="personal-savings-contribute-date" label="Fecha" type="date" value={date} onChange={e => setDate(e.target.value)} />
        <PersonalInput testId="personal-savings-contribute-notes" label="Nota (opcional)" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Ej: Sueldo de julio..." />
        {wouldComplete && (
          <div style={{ padding: '0.625rem 0.875rem', background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.25)', borderRadius: '0.75rem', fontSize: '0.8rem', color: '#818cf8', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <Check size={14} style={{ flexShrink: 0 }} />
            Con este aporte completás el objetivo "{selectedGoal!.name}" 🎉
          </div>
        )}
        {isValid && (
          <div
            data-testid="personal-savings-contribute-confirm"
            onClick={() => setConfirmed(c => !c)}
            role="checkbox" aria-checked={confirmed}
            style={{ padding: '0.875rem', background: confirmed ? 'rgba(52,211,153,0.08)' : 'rgba(255,255,255,0.025)', border: `1px solid ${confirmed ? 'rgba(52,211,153,0.35)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '0.875rem', cursor: 'pointer', display: 'flex', gap: '0.75rem', alignItems: 'center' }}
          >
            <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${confirmed ? '#34d399' : '#334155'}`, background: confirmed ? 'rgba(52,211,153,0.2)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {confirmed && <Check size={11} color="#34d399" />}
            </div>
            <span style={{ fontSize: '0.8rem', color: confirmed ? '#34d399' : '#475569', fontWeight: 600 }}>
              Confirmo aportar {fmtMoney(amt)} al objetivo
            </span>
          </div>
        )}
        {error && <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>{error}</div>}
      </div>
    </PersonalBottomSheet>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// WithdrawForm — withdraw from a savings goal
// ─────────────────────────────────────────────────────────────────────────────
function WithdrawForm({ goals, accounts, defaultGoalId, onSaved, onClose }: {
  goals: SavingsGoal[]
  accounts: PersonalAccount[]
  defaultGoalId?: string
  onSaved: () => void
  onClose: () => void
}) {
  const { user } = useAuth()
  const withdrawableGoals = goals.filter(g => g.status !== 'cancelled' && Number(g.current_amount) > 0)
  const [goalId, setGoalId]       = useState(defaultGoalId ?? withdrawableGoals[0]?.id ?? '')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [amount, setAmount]       = useState('')
  const [date, setDate]           = useState(new Date().toISOString().split('T')[0])
  const [notes, setNotes]         = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')

  const selectedGoal = goals.find(g => g.id === goalId)
  const amt = parseFloat(amount.replace(',', '.'))
  const maxAmount = selectedGoal ? Number(selectedGoal.current_amount) : 0
  const isValid = amt > 0 && !!goalId && !!accountId
  const exceedsBalance = amt > maxAmount

  const handleSave = async () => {
    if (!user || saving) return
    if (!goalId) { setError('Seleccioná un objetivo'); return }
    if (!accountId) { setError('Seleccioná una cuenta destino'); return }
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    if (exceedsBalance) { setError(`No podés retirar más de ${fmtMoney(maxAmount)}`); return }
    setError('')
    setSaving(true)
    try {
      await savingsService.withdrawFromGoal({ goalId, accountId, amount: amt, date, notes: notes.trim() || null })
      showToast({ message: `Retiro de ${fmtMoney(amt)} registrado`, type: 'success' })
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'withdrawGoal', e)
      const msg = e.message || 'Error al retirar'
      setError(msg)
      showToast({ message: msg, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <PersonalBottomSheet
      open
      title="Retirar de objetivo"
      onClose={onClose}
      testId="personal-savings-withdraw-form"
      footer={
        <PrimaryBtn testId="personal-savings-withdraw-save" onClick={handleSave} loading={saving} disabled={!confirmed || !isValid || exceedsBalance} fullWidth>
          {saving ? 'Retirando…' : `Retirar${amt > 0 ? ` ${fmtMoney(amt)}` : ''}`}
        </PrimaryBtn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <PersonalSelect testId="personal-savings-withdraw-goal" label="Objetivo *" value={goalId} onChange={e => { setGoalId(e.target.value); setConfirmed(false) }}>
          <option value="">Seleccionar objetivo</option>
          {withdrawableGoals.map(g => (
            <option key={g.id} value={g.id}>{g.name} (disponible: {fmtMoney(Number(g.current_amount))} {g.currency})</option>
          ))}
        </PersonalSelect>
        {selectedGoal && (
          <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.025)', borderRadius: '0.625rem', fontSize: '0.8rem', color: '#475569' }}>
            Disponible en "{selectedGoal.name}": <strong style={{ color: '#34d399', fontFamily: 'monospace' }}>{fmtMoney(Number(selectedGoal.current_amount))}</strong>
          </div>
        )}
        <PersonalSelect testId="personal-savings-withdraw-account" label="Cuenta destino *" value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">Seleccionar cuenta</option>
          {accounts.filter(a => a.is_active).map(a => <option key={a.id} value={a.id}>{a.name} ({fmtMoney(a.current_balance)})</option>)}
        </PersonalSelect>
        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Monto a retirar *</label>
          <input
            data-testid="personal-savings-withdraw-amount"
            type="number" min="0" step="1" value={amount}
            onChange={e => { setAmount(e.target.value); setConfirmed(false) }}
            placeholder="0" autoFocus
            style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: exceedsBalance ? 'rgba(248,113,113,0.05)' : 'rgba(251,191,36,0.05)', border: `1px solid ${exceedsBalance ? 'rgba(248,113,113,0.35)' : 'rgba(251,191,36,0.25)'}`, borderRadius: '0.875rem', color: exceedsBalance ? '#f87171' : '#fbbf24', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
          />
          {exceedsBalance && <div style={{ fontSize: '0.75rem', color: '#f87171', marginTop: '0.25rem' }}>Máximo disponible: {fmtMoney(maxAmount)}</div>}
        </div>
        <PersonalInput testId="personal-savings-withdraw-date" label="Fecha" type="date" value={date} onChange={e => setDate(e.target.value)} />
        <PersonalInput testId="personal-savings-withdraw-notes" label="Nota (opcional)" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Razón del retiro..." />
        {isValid && !exceedsBalance && (
          <div
            data-testid="personal-savings-withdraw-confirm"
            onClick={() => setConfirmed(c => !c)}
            role="checkbox" aria-checked={confirmed}
            style={{ padding: '0.875rem', background: confirmed ? 'rgba(251,191,36,0.08)' : 'rgba(255,255,255,0.025)', border: `1px solid ${confirmed ? 'rgba(251,191,36,0.35)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '0.875rem', cursor: 'pointer', display: 'flex', gap: '0.75rem', alignItems: 'center' }}
          >
            <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${confirmed ? '#fbbf24' : '#334155'}`, background: confirmed ? 'rgba(251,191,36,0.2)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {confirmed && <Check size={11} color="#fbbf24" />}
            </div>
            <span style={{ fontSize: '0.8rem', color: confirmed ? '#fbbf24' : '#475569', fontWeight: 600 }}>
              Retiro de {fmtMoney(amt)} de "{selectedGoal?.name ?? '…'}". Este dinero vuelve a tu cuenta.
            </span>
          </div>
        )}
        {error && <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>{error}</div>}
      </div>
    </PersonalBottomSheet>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// GoalDetailSheet — detail + manage goal
// ─────────────────────────────────────────────────────────────────────────────
function GoalDetailSheet({ goal, goalIdx, onContribute, onWithdraw, onEdit, onStatusChange, onDelete, onClose }: {
  goal: SavingsGoal
  goalIdx: number
  onContribute: () => void
  onWithdraw: () => void
  onEdit: () => void
  onStatusChange: (status: 'paused' | 'completed' | 'cancelled' | 'active') => void
  onDelete: () => void
  onClose: () => void
}) {
  const color = goalColor(goalIdx)
  const progress = getGoalProgress(goal)
  const remaining = getGoalRemainingAmount(goal)
  const monthlyNeeded = getEstimatedMonthlyNeeded(goal)
  const [confirmCancel, setConfirmCancel] = useState(false)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ width: '100%', maxWidth: 480, background: '#0a1628', borderRadius: '1.5rem 1.5rem 0 0', border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none', maxHeight: 'calc(100dvh - env(safe-area-inset-top, 20px) - 12px)', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 -8px 40px rgba(0,0,0,0.5)' }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '1.25rem' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: 44, height: 44, borderRadius: '0.875rem', background: `${color}18`, border: `1px solid ${color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Target size={20} color={color} />
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: '1.0625rem', color: '#f0f4ff' }}>{goal.name}</div>
              <span style={{ fontSize: '0.68rem', fontWeight: 700, color: getGoalStatusColor(goal), background: `${getGoalStatusColor(goal)}18`, borderRadius: '99px', padding: '0.1rem 0.5rem' }}>
                {getGoalStatusLabel(goal)}
              </span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', display: 'flex', minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' }}><X size={18} /></button>
        </div>

        {/* Progress */}
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.375rem' }}>
            <span style={{ fontSize: '0.72rem', color: '#475569' }}>Progreso</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.875rem', color }}>
              {Math.round(progress)}%
            </span>
          </div>
          <div style={{ height: 8, borderRadius: 99, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress}%`, background: `linear-gradient(90deg, ${color}, ${color}cc)`, borderRadius: 99, transition: 'width 0.4s ease' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.375rem' }}>
            <span style={{ fontSize: '0.72rem', color: '#475569' }}>Ahorrado: <strong style={{ color, fontFamily: 'monospace' }}>{fmtMoney(Number(goal.current_amount), goal.currency)}</strong></span>
            <span style={{ fontSize: '0.72rem', color: '#475569' }}>Meta: <strong style={{ color: '#f0f4ff', fontFamily: 'monospace' }}>{fmtMoney(Number(goal.target_amount), goal.currency)}</strong></span>
          </div>
        </div>

        {/* Info pills */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginBottom: '1rem' }}>
          {remaining > 0 && (
            <span style={{ fontSize: '0.72rem', color: '#f87171', background: 'rgba(248,113,113,0.08)', borderRadius: '99px', padding: '0.25rem 0.625rem' }}>
              Falta {fmtMoney(remaining, goal.currency)}
            </span>
          )}
          {goal.target_date && (
            <span style={{ fontSize: '0.72rem', color: '#475569', background: 'rgba(255,255,255,0.04)', borderRadius: '99px', padding: '0.25rem 0.625rem' }}>
              Meta: {new Date(goal.target_date + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          )}
          {monthlyNeeded !== null && monthlyNeeded > 0 && (
            <span style={{ fontSize: '0.72rem', color: '#fbbf24', background: 'rgba(251,191,36,0.08)', borderRadius: '99px', padding: '0.25rem 0.625rem' }}>
              ≈ {fmtMoneyCompact(monthlyNeeded)}/mes
            </span>
          )}
          {goal.currency !== 'ARS' && (
            <span style={{ fontSize: '0.72rem', color: '#60a5fa', background: 'rgba(96,165,250,0.08)', borderRadius: '99px', padding: '0.25rem 0.625rem' }}>
              {goal.currency}
            </span>
          )}
        </div>

        {/* Actions */}
        {goal.status !== 'cancelled' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1rem' }}>
            {goal.status === 'active' && (
              <>
                <button onClick={onContribute} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)', color: '#34d399', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44 }}>+ Aportar</button>
                <button onClick={onWithdraw} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem' }}>
                  Retirar
                </button>
                <button data-testid="personal-savings-goal-edit" onClick={onEdit} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)', color: '#60a5fa', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem' }}>
                  <Edit2 size={13} /> Editar
                </button>
                <button data-testid="personal-savings-goal-pause" onClick={() => onStatusChange('paused')} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)', color: '#fbbf24', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem' }}>
                  <Pause size={13} /> Pausar
                </button>
              </>
            )}
            {goal.status === 'paused' && (
              <>
                <button onClick={() => onStatusChange('active')} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)', color: '#34d399', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem' }}>
                  <Play size={13} /> Retomar
                </button>
                <button data-testid="personal-savings-goal-edit" onClick={onEdit} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)', color: '#60a5fa', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem' }}>
                  <Edit2 size={13} /> Editar
                </button>
              </>
            )}
            {(goal.status === 'active' || goal.status === 'paused') && isGoalCompleted(goal) && (
              <button data-testid="personal-savings-goal-complete" onClick={() => onStatusChange('completed')} style={{ gridColumn: '1 / -1', padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(129,140,248,0.12)', border: '1px solid rgba(129,140,248,0.35)', color: '#818cf8', fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                <Check size={14} /> Marcar como completado 🎉
              </button>
            )}
          </div>
        )}

        {/* Cancel / Delete */}
        {goal.status !== 'cancelled' && (
          confirmCancel ? (
            <div style={{ padding: '0.875rem', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              <div style={{ fontSize: '0.8rem', color: '#f87171' }}>¿Cancelar el objetivo "{goal.name}"? El saldo ahorrado no se pierde automáticamente.</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                <button onClick={() => setConfirmCancel(false)} style={{ padding: '0.625rem', borderRadius: '0.625rem', background: 'none', border: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8', fontSize: '0.8rem', cursor: 'pointer', minHeight: 40 }}>Volver</button>
                <button onClick={() => onStatusChange('cancelled')} style={{ padding: '0.625rem', borderRadius: '0.625rem', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', minHeight: 40 }}>Cancelar objetivo</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setConfirmCancel(true)} style={{ width: '100%', padding: '0.625rem', background: 'none', border: 'none', cursor: 'pointer', color: '#334155', fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem', minHeight: 36 }}>
              <Trash2 size={12} /> Cancelar objetivo
            </button>
          )
        )}

        {goal.status === 'cancelled' && (
          <button onClick={onDelete} style={{ width: '100%', padding: '0.625rem', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: '0.625rem', cursor: 'pointer', color: '#f87171', fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem', minHeight: 36 }}>
            <Trash2 size={12} /> Eliminar objetivo
          </button>
        )}
      </div>
      </div>
    </div>,
    document.body
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ProgressBar — reusable inline progress bar
// ─────────────────────────────────────────────────────────────────────────────
function ProgressBar({ progress, color }: { progress: number; color: string }) {
  return (
    <div style={{ height: 5, borderRadius: 99, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${Math.min(100, progress)}%`, background: color, borderRadius: 99, transition: 'width 0.3s ease' }} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PersonalSavings — main page
// ─────────────────────────────────────────────────────────────────────────────
export function PersonalSavings() {
  const { user } = useAuth()
  const [loading, setLoading]   = useState(true)
  const [goals, setGoals]       = useState<SavingsGoal[]>([])
  const [accounts, setAccounts] = useState<PersonalAccount[]>([])
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_categories, setCategories] = useState<PersonalCategory[]>([])

  // Sheet state
  const [showGoalForm, setShowGoalForm]           = useState(false)
  const [editingGoal, setEditingGoal]             = useState<SavingsGoal | null>(null)
  const [showContributeForm, setShowContributeForm] = useState(false)
  const [showWithdrawForm, setShowWithdrawForm]   = useState(false)
  const [defaultGoalId, setDefaultGoalId]         = useState('')
  const [detailGoal, setDetailGoal]               = useState<SavingsGoal | null>(null)

  const load = async () => {
    if (!user) return
    setLoading(true)
    try {
      const [g, a, cats] = await Promise.all([
        savingsService.getSavingsGoals(user.id),
        personalService.getAccounts(user.id),
        personalService.getCategories(user.id),
      ])
      setGoals(g); setAccounts(a); setCategories(cats)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleStatusChange = async (goal: SavingsGoal, status: 'paused' | 'completed' | 'cancelled' | 'active') => {
    if (!user) return
    try {
      await savingsService.updateSavingsGoal(goal.id, user.id, { status })
      const labels: Record<string, string> = { paused: 'Objetivo pausado', completed: '¡Objetivo completado! 🎉', cancelled: 'Objetivo cancelado', active: 'Objetivo retomado' }
      showToast({ message: labels[status] ?? 'Estado actualizado', type: status === 'cancelled' ? 'error' : 'success' })
      setDetailGoal(null)
      void load()
    } catch (e: any) {
      logger.error('PERSONAL', 'goalStatus', e)
      showToast({ message: e.message || 'Error', type: 'error' })
    }
  }

  const handleDelete = async (goal: SavingsGoal) => {
    if (!user) return
    try {
      await savingsService.deleteSavingsGoal(goal.id, user.id)
      showToast({ message: 'Objetivo eliminado', type: 'success' })
      setDetailGoal(null)
      void load()
    } catch (e: any) {
      logger.error('PERSONAL', 'deleteGoal', e)
      showToast({ message: e.message || 'Error', type: 'error' })
    }
  }

  const summary = getSavingsSummary(goals)
  const sorted = sortGoalsByRelevance(goals)
  const activeGoals = goals.filter(g => g.status === 'active')

  if (loading) return <PersonalLoading />

  return (
    <PageContainer testId="personal-savings-page">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff' }}>Ahorros</span>
        <button
          data-testid="personal-savings-new-button"
          onClick={() => { setEditingGoal(null); setShowGoalForm(true) }}
          style={{ width: 36, height: 36, borderRadius: '0.75rem', background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#34d399' }}
        >
          <Plus size={18} />
        </button>
      </div>

      {/* Summary card */}
      {goals.length > 0 && (
        <div
          data-testid="personal-savings-summary"
          style={{ background: 'linear-gradient(135deg, rgba(52,211,153,0.12), rgba(16,185,129,0.06))', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '1.25rem', padding: '1.25rem' }}
        >
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#059669', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.75rem' }}>
            {summary.activeCount} objetivo{summary.activeCount !== 1 ? 's' : ''} activo{summary.activeCount !== 1 ? 's' : ''}
            {summary.completedCount > 0 && ` · ${summary.completedCount} completado${summary.completedCount !== 1 ? 's' : ''}`}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: summary.totalUSD > 0 ? '1fr 1fr' : '1fr', gap: '0.75rem' }}>
            <div>
              <div style={{ fontSize: '0.68rem', color: '#047857', marginBottom: '0.2rem' }}>Total ahorrado ARS</div>
              <div data-testid="personal-savings-total-ars" style={{ fontSize: '1.75rem', fontWeight: 900, color: '#34d399', fontFamily: 'monospace', letterSpacing: '-0.03em', lineHeight: 1 }}>
                {fmtMoney(summary.totalARS)}
              </div>
            </div>
            {summary.totalUSD > 0 && (
              <div>
                <div style={{ fontSize: '0.68rem', color: '#047857', marginBottom: '0.2rem' }}>Total USD</div>
                <div data-testid="personal-savings-total-usd" style={{ fontSize: '1.75rem', fontWeight: 900, color: '#4ade80', fontFamily: 'monospace', letterSpacing: '-0.03em', lineHeight: 1 }}>
                  {fmtMoney(summary.totalUSD, 'USD')}
                </div>
              </div>
            )}
          </div>
          <div data-testid="personal-savings-active-count" style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#047857' }}>
            Meta total activa: {fmtMoney(summary.totalTargetARS)}
            {summary.totalTargetUSD > 0 && ` + ${fmtMoney(summary.totalTargetUSD, 'USD')}`}
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
        {[
          { label: '+ Objetivo', testId: 'personal-savings-new-button-2',      color: '#34d399', bg: 'rgba(52,211,153,0.1)',  onClick: () => { setEditingGoal(null); setShowGoalForm(true) } },
          { label: '+ Aportar',  testId: 'personal-savings-contribute-button', color: '#818cf8', bg: 'rgba(129,140,248,0.1)', onClick: () => { setDefaultGoalId(''); setShowContributeForm(true) } },
          { label: 'Retirar',   testId: 'personal-savings-withdraw-button',   color: '#fbbf24', bg: 'rgba(251,191,36,0.1)',  onClick: () => { setDefaultGoalId(''); setShowWithdrawForm(true) } },
        ].map(a => (
          <button key={a.label} data-testid={a.testId} onClick={a.onClick}
            style={{ padding: '0.75rem 0.25rem', borderRadius: '0.875rem', background: a.bg, border: `1px solid ${a.color}30`, color: a.color, fontWeight: 700, fontSize: '0.775rem', cursor: 'pointer', minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {a.label}
          </button>
        ))}
      </div>

      {/* Goals list */}
      {goals.length === 0 ? (
        <EmptyPersonal
          icon={<Target size={22} />}
          title="Todavía no creaste objetivos de ahorro."
          description="Separar plata para un objetivo específico te ayuda a no mezclarla con tus gastos del día a día."
          cta="Crear primer objetivo"
          onCta={() => { setEditingGoal(null); setShowGoalForm(true) }}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {/* Active */}
          {activeGoals.length > 0 && <SectionHeader title="Activos" />}
          {sorted.filter(g => g.status === 'active').map((goal, i) => {
            const color = goalColor(i)
            const progress = getGoalProgress(goal)
            const remaining = getGoalRemainingAmount(goal)
            return (
              <div
                key={goal.id}
                data-testid="personal-savings-goal-row"
                onClick={() => setDetailGoal(goal)}
                role="button"
                style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '1rem', padding: '1rem', cursor: 'pointer' }}
                onPointerEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                onPointerLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.025)')}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flex: 1, minWidth: 0 }}>
                    <div style={{ width: 36, height: 36, borderRadius: '0.75rem', background: `${color}18`, border: `1px solid ${color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Target size={16} color={color} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div data-testid="personal-savings-goal-name" style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#f0f4ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{goal.name}</div>
                      {goal.account && <div style={{ fontSize: '0.7rem', color: '#334155', marginTop: '0.1rem' }}>{goal.account.name}</div>}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '0.5rem' }}>
                    <div data-testid="personal-savings-goal-progress" style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '1rem', color }}>{Math.round(progress)}%</div>
                    {goal.target_date && <div style={{ fontSize: '0.65rem', color: '#334155' }}>{new Date(goal.target_date + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}</div>}
                  </div>
                </div>

                <ProgressBar progress={progress} color={color} />

                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem' }}>
                  <span data-testid="personal-savings-goal-current" style={{ fontSize: '0.775rem', color: '#475569' }}>
                    {fmtMoney(Number(goal.current_amount), goal.currency)}
                  </span>
                  <div style={{ textAlign: 'right' }}>
                    {remaining > 0 ? (
                      <span data-testid="personal-savings-goal-remaining" style={{ fontSize: '0.72rem', color: '#334155' }}>
                        Falta <span data-testid="personal-savings-goal-target" style={{ color: '#f0f4ff', fontFamily: 'monospace' }}>{fmtMoney(remaining, goal.currency)}</span>
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.72rem', color: '#34d399', fontWeight: 700 }}>¡Meta alcanzada!</span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}

          {/* Paused */}
          {sorted.filter(g => g.status === 'paused').length > 0 && (
            <>
              <SectionHeader title="Pausados" />
              <Card style={{ opacity: 0.7 }}>
                {sorted.filter(g => g.status === 'paused').map((goal, i, arr) => (
                  <div key={goal.id} onClick={() => setDetailGoal(goal)} role="button"
                    style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.875rem 1rem', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', cursor: 'pointer' }}>
                    <Pause size={15} color="#fbbf24" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#f0f4ff' }}>{goal.name}</div>
                      <div style={{ fontSize: '0.7rem', color: '#334155' }}>{fmtMoney(Number(goal.current_amount), goal.currency)} de {fmtMoney(Number(goal.target_amount), goal.currency)}</div>
                    </div>
                    <span style={{ fontSize: '0.68rem', color: '#fbbf24', background: 'rgba(251,191,36,0.08)', borderRadius: '99px', padding: '0.2rem 0.5rem' }}>Pausado</span>
                  </div>
                ))}
              </Card>
            </>
          )}

          {/* Completed */}
          {sorted.filter(g => g.status === 'completed').length > 0 && (
            <>
              <SectionHeader title="Completados" />
              <Card style={{ opacity: 0.6 }}>
                {sorted.filter(g => g.status === 'completed').map((goal, i, arr) => (
                  <div key={goal.id} style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.875rem 1rem', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                    <Check size={15} color="#818cf8" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#f0f4ff' }}>{goal.name}</div>
                      <div style={{ fontSize: '0.7rem', color: '#334155' }}>{fmtMoney(Number(goal.current_amount), goal.currency)}</div>
                    </div>
                    <span style={{ fontSize: '0.68rem', color: '#818cf8', background: 'rgba(129,140,248,0.08)', borderRadius: '99px', padding: '0.2rem 0.5rem' }}>Completado</span>
                  </div>
                ))}
              </Card>
            </>
          )}
        </div>
      )}

      {/* Sheets */}
      {(showGoalForm || editingGoal) && (
        <GoalForm
          initial={editingGoal ?? undefined}
          accounts={accounts}
          onSaved={() => { setShowGoalForm(false); setEditingGoal(null); void load() }}
          onClose={() => { setShowGoalForm(false); setEditingGoal(null) }}
        />
      )}

      {showContributeForm && (
        <ContributeForm
          goals={goals}
          accounts={accounts}
          defaultGoalId={defaultGoalId}
          onSaved={() => { setShowContributeForm(false); void load() }}
          onClose={() => setShowContributeForm(false)}
        />
      )}

      {showWithdrawForm && (
        <WithdrawForm
          goals={goals}
          accounts={accounts}
          defaultGoalId={defaultGoalId}
          onSaved={() => { setShowWithdrawForm(false); void load() }}
          onClose={() => setShowWithdrawForm(false)}
        />
      )}

      {detailGoal && (
        <GoalDetailSheet
          goal={detailGoal}
          goalIdx={sorted.findIndex(g => g.id === detailGoal.id)}
          onContribute={() => { setDefaultGoalId(detailGoal.id); setDetailGoal(null); setShowContributeForm(true) }}
          onWithdraw={() => { setDefaultGoalId(detailGoal.id); setDetailGoal(null); setShowWithdrawForm(true) }}
          onEdit={() => { setEditingGoal(detailGoal); setDetailGoal(null); setShowGoalForm(true) }}
          onStatusChange={status => handleStatusChange(detailGoal, status)}
          onDelete={() => handleDelete(detailGoal)}
          onClose={() => setDetailGoal(null)}
        />
      )}
    </PageContainer>
  )
}
