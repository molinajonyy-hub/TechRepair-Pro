import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus, CreditCard, X, Edit2, Trash2, ChevronRight, AlertCircle, Check } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { creditCardService, type CreditCard as CCType, type CardPurchase } from '../services/creditCardService'
import { type PersonalAccount, type PersonalCategory, personalService } from '../services/personalService'
import {
  PageContainer, Card, SectionHeader, PrimaryBtn, PersonalInput, PersonalSelect,
  EmptyPersonal, PersonalLoading, showToast, fmtMoney, fmtMoneyCompact,
} from '../components/ui'
import {
  currentYearMonth, addMonths, formatYearMonth, monthSelectOptions,
  getInstallmentAmount, getCardStatementTotal,
  getAllCardsStatementTotal, getFutureInstallmentsTotal, getNextDueDate,
  formatCardCycle, isPurchaseActive, getRemainingInstallments,
} from '../utils/creditCards'
import { logger } from '../../lib/logger'

// ── Card accent colors (cycled by index) ──────────────────────────────────────
const CARD_COLORS = ['#818cf8', '#34d399', '#60a5fa', '#fbbf24', '#f87171', '#a78bfa', '#fb923c']
const cardColor = (idx: number) => CARD_COLORS[idx % CARD_COLORS.length]

// ── Day options 1–31 for closing/due day selects ──────────────────────────────
const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => i + 1)

// ─────────────────────────────────────────────────────────────────────────────
// CardForm — create or edit a credit card
// ─────────────────────────────────────────────────────────────────────────────
function CardForm({ initial, onSaved, onClose }: {
  initial?: CCType; onSaved: () => void; onClose: () => void
}) {
  const { user } = useAuth()
  const [name, setName]               = useState(initial?.name ?? '')
  const [issuer, setIssuer]           = useState(initial?.issuer ?? '')
  const [closingDay, setClosingDay]   = useState(String(initial?.closing_day ?? 20))
  const [dueDay, setDueDay]           = useState(String(initial?.due_day ?? 10))
  const [limit, setLimit]             = useState(initial?.credit_limit != null ? String(initial.credit_limit) : '')
  const [currency, setCurrency]       = useState(initial?.currency ?? 'ARS')
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState('')

  const handleSave = async () => {
    if (!user || saving) return
    if (!name.trim()) { setError('El nombre es obligatorio'); return }
    const cd = parseInt(closingDay, 10)
    const dd = parseInt(dueDay, 10)
    if (isNaN(cd) || cd < 1 || cd > 31) { setError('Día de cierre debe ser entre 1 y 31'); return }
    if (isNaN(dd) || dd < 1 || dd > 31) { setError('Día de vencimiento debe ser entre 1 y 31'); return }
    const creditLimit = limit !== '' ? parseFloat(limit) : null
    if (creditLimit !== null && creditLimit < 0) { setError('El límite no puede ser negativo'); return }
    setError('')
    setSaving(true)
    try {
      if (initial) {
        await creditCardService.updateCreditCard(initial.id, user.id, {
          name: name.trim(), issuer: issuer.trim() || null,
          closing_day: cd, due_day: dd, credit_limit: creditLimit, currency,
        })
        showToast({ message: 'Tarjeta actualizada', type: 'success' })
      } else {
        await creditCardService.createCreditCard(user.id, {
          name: name.trim(), issuer: issuer.trim() || null,
          closing_day: cd, due_day: dd, credit_limit: creditLimit, currency,
        })
        showToast({ message: 'Tarjeta creada', type: 'success' })
      }
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'saveCard', e)
      const msg = e.message || 'Error al guardar'
      setError(msg)
      showToast({ message: msg, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div data-testid="personal-card-form" style={{ width: '100%', maxWidth: 480, background: '#0a1628', borderRadius: '1.5rem 1.5rem 0 0', border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none', padding: '1.25rem', maxHeight: '90dvh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <span style={{ fontWeight: 800, fontSize: '1rem', color: '#f0f4ff' }}>{initial ? 'Editar tarjeta' : 'Nueva tarjeta'}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', display: 'flex', minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' }}><X size={18} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <PersonalInput testId="personal-card-name-input" label="Nombre de tarjeta *" value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Visa Naranja, Mastercard Galicia..." />
          <PersonalInput testId="personal-card-issuer-input" label="Emisor / Banco" value={issuer} onChange={e => setIssuer(e.target.value)} placeholder="Ej: Naranja X, Galicia, Santander..." />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Día de cierre *</label>
              <select
                data-testid="personal-card-closing-day"
                value={closingDay}
                onChange={e => setClosingDay(e.target.value)}
                style={{ width: '100%', padding: '0.75rem', boxSizing: 'border-box', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.75rem', color: '#f0f4ff', fontSize: '1rem', outline: 'none', cursor: 'pointer', minHeight: 44 }}
              >
                {DAY_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Día de vencimiento *</label>
              <select
                data-testid="personal-card-due-day"
                value={dueDay}
                onChange={e => setDueDay(e.target.value)}
                style={{ width: '100%', padding: '0.75rem', boxSizing: 'border-box', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.75rem', color: '#f0f4ff', fontSize: '1rem', outline: 'none', cursor: 'pointer', minHeight: 44 }}
              >
                {DAY_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>

          <PersonalInput testId="personal-card-limit" label="Límite (opcional)" type="number" min="0" value={limit} onChange={e => setLimit(e.target.value)} placeholder="Sin límite" />
          <PersonalSelect testId="personal-card-currency" label="Moneda" value={currency} onChange={e => setCurrency(e.target.value)}>
            <option value="ARS">ARS — Pesos</option>
            <option value="USD">USD — Dólares</option>
          </PersonalSelect>

          {error && <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>{error}</div>}
          <PrimaryBtn testId="personal-card-save" onClick={handleSave} loading={saving} fullWidth>
            {saving ? 'Guardando…' : (initial ? 'Guardar cambios' : 'Crear tarjeta')}
          </PrimaryBtn>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PurchaseForm — register a purchase (with installment preview)
// ─────────────────────────────────────────────────────────────────────────────
function PurchaseForm({ cards, categories, defaultCardId, onSaved, onClose }: {
  cards: CCType[]
  categories: PersonalCategory[]
  defaultCardId?: string
  onSaved: () => void
  onClose: () => void
}) {
  const { user } = useAuth()
  const [cardId, setCardId]           = useState(defaultCardId ?? cards[0]?.id ?? '')
  const [description, setDescription] = useState('')
  const [amount, setAmount]           = useState('')
  const [installments, setInstallments] = useState('1')
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().split('T')[0])
  const [firstMonth, setFirstMonth]   = useState(currentYearMonth())
  const [categoryId, setCategoryId]   = useState('')
  const [notes, setNotes]             = useState('')
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState('')

  const monthOptions = monthSelectOptions(24)
  const expenseCategories = categories.filter(c => c.type === 'expense' && c.is_active)

  const amt = parseFloat(amount.replace(',', '.'))
  const numInstallments = parseInt(installments, 10)
  const previewValid = amt > 0 && numInstallments >= 1 && firstMonth

  // Build preview schedule
  const previewSchedule = previewValid
    ? Array.from({ length: numInstallments }, (_, i) => ({
        month: addMonths(firstMonth, i),
        amount: amt / numInstallments,
      }))
    : []

  const handleSave = async () => {
    if (!user || saving) return
    if (!cardId) { setError('Seleccioná una tarjeta'); return }
    if (!description.trim()) { setError('La descripción es obligatoria'); return }
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    if (!numInstallments || numInstallments < 1 || numInstallments > 60) { setError('Las cuotas deben ser entre 1 y 60'); return }
    if (!purchaseDate) { setError('La fecha es obligatoria'); return }
    setError('')
    setSaving(true)
    try {
      await creditCardService.createCardPurchase(user.id, {
        credit_card_id: cardId,
        category_id: categoryId || null,
        description: description.trim(),
        total_amount: amt,
        installments: numInstallments,
        purchase_date: purchaseDate,
        first_installment_month: firstMonth,
        notes: notes.trim() || null,
      })
      showToast({ message: numInstallments === 1 ? 'Compra registrada' : `Compra en ${numInstallments} cuotas registrada`, type: 'success' })
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'createPurchase', e)
      const msg = e.message || 'Error al guardar'
      setError(msg)
      showToast({ message: msg, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div data-testid="personal-card-purchase-form" style={{ width: '100%', maxWidth: 480, background: '#0a1628', borderRadius: '1.5rem 1.5rem 0 0', border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none', padding: '1.25rem', maxHeight: '90dvh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <span style={{ fontWeight: 800, fontSize: '1rem', color: '#f0f4ff' }}>Registrar compra</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', display: 'flex', minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' }}><X size={18} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <PersonalSelect testId="personal-card-purchase-card" label="Tarjeta *" value={cardId} onChange={e => setCardId(e.target.value)}>
            <option value="">Seleccionar tarjeta</option>
            {cards.filter(c => c.is_active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </PersonalSelect>

          <PersonalInput testId="personal-card-purchase-description" label="Descripción *" value={description} onChange={e => setDescription(e.target.value)} placeholder="¿Qué compraste?" />

          {/* Amount — large display input */}
          <div>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Monto total *</label>
            <input
              data-testid="personal-card-purchase-amount"
              type="number" min="0" step="0.01" value={amount}
              onChange={e => setAmount(e.target.value)} placeholder="0" autoFocus
              style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: 'rgba(129,140,248,0.05)', border: '1px solid rgba(129,140,248,0.25)', borderRadius: '0.875rem', color: '#818cf8', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <PersonalInput testId="personal-card-purchase-installments" label="Cuotas" type="number" min="1" max="60" value={installments} onChange={e => setInstallments(e.target.value)} />
            <PersonalInput testId="personal-card-purchase-date" label="Fecha de compra" type="date" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} />
          </div>

          <PersonalSelect testId="personal-card-purchase-first-month" label="Primera cuota en" value={firstMonth} onChange={e => setFirstMonth(e.target.value)}>
            {monthOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </PersonalSelect>

          {expenseCategories.length > 0 && (
            <PersonalSelect testId="personal-card-purchase-category" label="Categoría" value={categoryId} onChange={e => setCategoryId(e.target.value)}>
              <option value="">Sin categoría</option>
              {expenseCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </PersonalSelect>
          )}

          <PersonalInput label="Nota (opcional)" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Detalle adicional..." />

          {/* Preview */}
          {previewValid && previewSchedule.length > 0 && (
            <div data-testid="personal-card-purchase-preview" style={{ background: 'rgba(129,140,248,0.06)', border: '1px solid rgba(129,140,248,0.18)', borderRadius: '0.875rem', padding: '0.875rem' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
                {numInstallments === 1
                  ? `Compra de ${fmtMoney(amt)} al contado`
                  : `${fmtMoney(amt)} en ${numInstallments} cuotas de ${fmtMoney(amt / numInstallments)}`
                }
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {previewSchedule.map((s, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#a5b4fc' }}>
                    <span>{formatYearMonth(s.month)}</span>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{fmtMoney(s.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>{error}</div>}
          <PrimaryBtn testId="personal-card-purchase-save" onClick={handleSave} loading={saving} fullWidth>
            {saving ? 'Registrando…' : 'Registrar compra'}
          </PrimaryBtn>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PaymentForm — pay a credit card (creates an expense transaction)
// ─────────────────────────────────────────────────────────────────────────────
function PaymentForm({ cards, accounts, onSaved, onClose }: {
  cards: CCType[]
  accounts: PersonalAccount[]
  onSaved: () => void
  onClose: () => void
}) {
  const { user } = useAuth()
  const [cardId, setCardId]       = useState(cards[0]?.id ?? '')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [amount, setAmount]       = useState('')
  const [date, setDate]           = useState(new Date().toISOString().split('T')[0])
  const [notes, setNotes]         = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')

  const activeAccounts = accounts.filter(a => a.is_active)
  const selectedCard = cards.find(c => c.id === cardId)
  const amt = parseFloat(amount.replace(',', '.'))
  const isValid = amt > 0 && !!cardId && !!accountId

  const handleSave = async () => {
    if (!user || saving) return
    if (!cardId) { setError('Seleccioná una tarjeta'); return }
    if (!accountId) { setError('Seleccioná una cuenta'); return }
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    setError('')
    setSaving(true)
    try {
      await creditCardService.payCreditCard(user.id, {
        cardName: selectedCard?.name ?? '',
        accountId,
        amount: amt,
        date,
        notes,
        categoryId: null,
      })
      showToast({ message: `Pago de ${fmtMoney(amt)} registrado`, type: 'success' })
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'payCreditCard', e)
      const msg = e.message || 'Error al registrar el pago'
      setError(msg)
      showToast({ message: msg, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div data-testid="personal-card-payment-form" style={{ width: '100%', maxWidth: 480, background: '#0a1628', borderRadius: '1.5rem 1.5rem 0 0', border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none', padding: '1.25rem', maxHeight: '90dvh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <span style={{ fontWeight: 800, fontSize: '1rem', color: '#f0f4ff' }}>Pagar tarjeta</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', display: 'flex', minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' }}><X size={18} /></button>
        </div>

        {activeAccounts.length === 0 ? (
          <div style={{ padding: '1.25rem', textAlign: 'center', color: '#475569', fontSize: '0.875rem' }}>
            No tenés cuentas personales activas para registrar el pago.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <PersonalSelect testId="personal-card-payment-card" label="Tarjeta" value={cardId} onChange={e => setCardId(e.target.value)}>
              <option value="">Seleccionar tarjeta</option>
              {cards.filter(c => c.is_active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </PersonalSelect>

            <PersonalSelect testId="personal-card-payment-account" label="Cuenta de origen *" value={accountId} onChange={e => setAccountId(e.target.value)}>
              <option value="">Seleccionar cuenta</option>
              {activeAccounts.map(a => <option key={a.id} value={a.id}>{a.name} ({fmtMoney(a.current_balance)})</option>)}
            </PersonalSelect>

            {/* Amount */}
            <div>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Monto del pago *</label>
              <input
                data-testid="personal-card-payment-amount"
                type="number" min="0" step="0.01" value={amount}
                onChange={e => { setAmount(e.target.value); setConfirmed(false) }}
                placeholder="0" autoFocus
                style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.875rem', color: '#f87171', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
              />
            </div>

            <PersonalInput testId="personal-card-payment-date" label="Fecha" type="date" value={date} onChange={e => setDate(e.target.value)} />
            <PersonalInput testId="personal-card-payment-notes" label="Nota (opcional)" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Ej: Pago resumen junio..." />

            {isValid && (
              <div
                data-testid="personal-card-payment-confirm"
                onClick={() => setConfirmed(c => !c)}
                role="checkbox" aria-checked={confirmed}
                style={{ padding: '0.875rem', background: confirmed ? 'rgba(248,113,113,0.08)' : 'rgba(255,255,255,0.025)', border: `1px solid ${confirmed ? 'rgba(248,113,113,0.35)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '0.875rem', cursor: 'pointer', display: 'flex', gap: '0.75rem', alignItems: 'center' }}
              >
                <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${confirmed ? '#f87171' : '#334155'}`, background: confirmed ? 'rgba(248,113,113,0.2)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {confirmed && <Check size={11} color="#f87171" />}
                </div>
                <span style={{ fontSize: '0.8rem', color: confirmed ? '#f87171' : '#475569', fontWeight: 600 }}>
                  Confirmo pagar {fmtMoney(amt)} desde {accounts.find(a => a.id === accountId)?.name ?? 'la cuenta'}
                </span>
              </div>
            )}

            {error && <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>{error}</div>}
            <PrimaryBtn
              testId="personal-card-payment-save"
              onClick={handleSave} loading={saving}
              disabled={!confirmed || !isValid}
              fullWidth
            >
              {saving ? 'Registrando…' : `Registrar pago${amt > 0 ? ` de ${fmtMoney(amt)}` : ''}`}
            </PrimaryBtn>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CardDetailSheet — detail view for one card with its purchases
// ─────────────────────────────────────────────────────────────────────────────
function CardDetailSheet({ card, purchases, cardIdx, onAddPurchase, onEdit, onDeactivate, onDeletePurchase, onClose }: {
  card: CCType
  purchases: CardPurchase[]
  cardIdx: number
  onAddPurchase: () => void
  onEdit: () => void
  onDeactivate: () => void
  onDeletePurchase: (id: string) => void
  onClose: () => void
}) {
  const month = currentYearMonth()
  const color = cardColor(cardIdx)
  const cardPurchases = purchases.filter(p => p.credit_card_id === card.id)
  const thisMonthTotal = getCardStatementTotal(card.id, purchases, month)
  const futureTotal = getFutureInstallmentsTotal(cardPurchases, addMonths(month, 1))
  const activePurchases = cardPurchases.filter(p => isPurchaseActive(p, month))
  const pastPurchases = cardPurchases.filter(p => !isPurchaseActive(p, month))
  const nextDue = getNextDueDate(card)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 480, background: '#0a1628', borderRadius: '1.5rem 1.5rem 0 0', border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none', maxHeight: '92dvh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ padding: '1.25rem 1.25rem 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{ width: 44, height: 44, borderRadius: '0.875rem', background: `${color}18`, border: `1px solid ${color}35`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <CreditCard size={20} color={color} />
              </div>
              <div>
                <div style={{ fontWeight: 800, fontSize: '1.0625rem', color: '#f0f4ff' }}>{card.name}</div>
                {card.issuer && <div style={{ fontSize: '0.75rem', color: '#475569', marginTop: '0.1rem' }}>{card.issuer}</div>}
              </div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', display: 'flex', minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' }}><X size={18} /></button>
          </div>

          {/* Stats row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1rem' }}>
            {[
              { label: 'Este mes', value: fmtMoney(thisMonthTotal), color: '#818cf8' },
              { label: 'Cuotas futuras', value: fmtMoneyCompact(futureTotal), color: '#fbbf24' },
            ].map(s => (
              <div key={s.label} style={{ background: `${s.color}0d`, border: `1px solid ${s.color}25`, borderRadius: '0.75rem', padding: '0.75rem', textAlign: 'center' }}>
                <div style={{ fontSize: '0.6rem', color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.label}</div>
                <div style={{ fontSize: '1rem', fontWeight: 800, color: s.color, marginTop: '0.2rem', fontFamily: 'monospace' }}>{s.value}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginBottom: '1rem' }}>
            <span style={{ fontSize: '0.72rem', color: '#475569', background: 'rgba(255,255,255,0.04)', borderRadius: '99px', padding: '0.25rem 0.625rem' }}>{formatCardCycle(card)}</span>
            <span style={{ fontSize: '0.72rem', color: '#475569', background: 'rgba(255,255,255,0.04)', borderRadius: '99px', padding: '0.25rem 0.625rem' }}>Vence {nextDue.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}</span>
            {card.credit_limit && <span style={{ fontSize: '0.72rem', color: '#475569', background: 'rgba(255,255,255,0.04)', borderRadius: '99px', padding: '0.25rem 0.625rem' }}>Límite {fmtMoney(card.credit_limit)}</span>}
          </div>

          {/* Action buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.375rem', marginBottom: '1rem' }}>
            {[
              { label: '+ Compra', onClick: onAddPurchase, color: '#818cf8', bg: 'rgba(129,140,248,0.1)' },
              { label: '✏ Editar', onClick: onEdit, color: '#60a5fa', bg: 'rgba(96,165,250,0.1)' },
              { label: '⊘ Desactivar', onClick: onDeactivate, color: '#f87171', bg: 'rgba(248,113,113,0.1)' },
            ].map(a => (
              <button key={a.label} onClick={a.onClick} style={{ padding: '0.625rem 0.25rem', borderRadius: '0.625rem', background: a.bg, border: `1px solid ${a.color}30`, color: a.color, fontWeight: 700, fontSize: '0.72rem', cursor: 'pointer', minHeight: 44 }}>
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {/* Scrollable purchases list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 1.25rem 1.25rem' }}>
          {activePurchases.length === 0 && pastPurchases.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#475569', fontSize: '0.875rem' }}>
              Sin compras registradas todavía.
            </div>
          ) : (
            <>
              {activePurchases.length > 0 && (
                <>
                  <SectionHeader title="En curso" />
                  <Card>
                    {activePurchases.map((p, i) => {
                      const perInstallment = getInstallmentAmount(p)
                      const remaining = getRemainingInstallments(p, month)
                      const isConfirmDel = deletingId === p.id
                      return (
                        <div key={p.id} style={{ padding: '0.875rem 1rem', borderBottom: i < activePurchases.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#f0f4ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.description}</div>
                              <div style={{ fontSize: '0.72rem', color: '#475569', marginTop: '0.15rem' }}>
                                {p.installments === 1 ? 'Contado' : `${p.installments} cuotas de ${fmtMoney(perInstallment)}`}
                                {' · '}{remaining} restante{remaining !== 1 ? 's' : ''}
                              </div>
                              {p.category && (
                                <span style={{ fontSize: '0.65rem', color: p.category.color ?? '#475569', background: `${p.category.color ?? '#475569'}18`, borderRadius: '99px', padding: '0.1rem 0.4rem', marginTop: '0.25rem', display: 'inline-block' }}>
                                  {p.category.name}
                                </span>
                              )}
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '0.5rem' }}>
                              <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9rem', color: '#818cf8' }}>{fmtMoney(p.total_amount)}</div>
                              <div style={{ fontSize: '0.65rem', color: '#475569' }}>{new Date(p.purchase_date + 'T12:00:00').toLocaleDateString('es-AR')}</div>
                            </div>
                            <button
                              onClick={() => setDeletingId(isConfirmDel ? null : p.id)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: isConfirmDel ? '#f87171' : '#334155', marginLeft: '0.375rem', display: 'flex', minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                          {isConfirmDel && (
                            <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                              <button onClick={() => setDeletingId(null)} style={{ fontSize: '0.75rem', padding: '0.25rem 0.625rem', background: 'none', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#475569', cursor: 'pointer', minHeight: 32 }}>Cancelar</button>
                              <button onClick={() => { onDeletePurchase(p.id); setDeletingId(null) }} style={{ fontSize: '0.75rem', padding: '0.25rem 0.625rem', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: '0.5rem', color: '#f87171', cursor: 'pointer', minHeight: 32 }}>Eliminar</button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </Card>
                </>
              )}

              {pastPurchases.length > 0 && (
                <>
                  <SectionHeader title="Finalizadas" />
                  <Card style={{ opacity: 0.65 }}>
                    {pastPurchases.map((p, i) => (
                      <div key={p.id} style={{ padding: '0.75rem 1rem', borderBottom: i < pastPurchases.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontWeight: 500, fontSize: '0.8rem', color: '#94a3b8' }}>{p.description}</div>
                          <div style={{ fontSize: '0.68rem', color: '#334155', marginTop: '0.1rem' }}>
                            {p.installments === 1 ? 'Contado' : `${p.installments} cuotas`} · {new Date(p.purchase_date + 'T12:00:00').toLocaleDateString('es-AR')}
                          </div>
                        </div>
                        <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.875rem', color: '#334155' }}>{fmtMoney(p.total_amount)}</div>
                      </div>
                    ))}
                  </Card>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DisableConfirm — confirmation before deactivating a card
// ─────────────────────────────────────────────────────────────────────────────
function DisableConfirm({ card, onConfirm, onClose }: {
  card: CCType; onConfirm: () => void; onClose: () => void
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div style={{ width: '100%', maxWidth: 360, background: '#0a1628', borderRadius: '1.25rem', border: '1px solid rgba(248,113,113,0.25)', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
          <AlertCircle size={20} color="#f87171" style={{ flexShrink: 0, marginTop: '0.1rem' }} />
          <div>
            <div style={{ fontWeight: 800, color: '#f0f4ff', marginBottom: '0.375rem' }}>¿Desactivar tarjeta?</div>
            <div style={{ fontSize: '0.825rem', color: '#475569', lineHeight: 1.5 }}>
              Se desactivará <strong style={{ color: '#f0f4ff' }}>{card.name}</strong>. El historial de compras no se elimina.
            </div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.625rem' }}>
          <button onClick={onClose} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', minHeight: 44 }}>Cancelar</button>
          <button data-testid="personal-card-disable" onClick={onConfirm} style={{ padding: '0.75rem', borderRadius: '0.75rem', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', minHeight: 44 }}>Desactivar</button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PersonalCards — main page
// ─────────────────────────────────────────────────────────────────────────────
export function PersonalCards() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [loading, setLoading]         = useState(true)
  const [cards, setCards]             = useState<CCType[]>([])
  const [purchases, setPurchases]     = useState<CardPurchase[]>([])
  const [accounts, setAccounts]       = useState<PersonalAccount[]>([])
  const [categories, setCategories]   = useState<PersonalCategory[]>([])

  // Sheet state
  const [showCardForm, setShowCardForm]         = useState(false)
  const [editingCard, setEditingCard]           = useState<CCType | null>(null)
  const [showPurchaseForm, setShowPurchaseForm] = useState(false)
  const [purchaseDefaultCard, setPurchaseDefaultCard] = useState('')
  const [showPaymentForm, setShowPaymentForm]   = useState(false)
  const [detailCard, setDetailCard]             = useState<CCType | null>(null)
  const [disableTarget, setDisableTarget]       = useState<CCType | null>(null)

  const load = async () => {
    if (!user) return
    setLoading(true)
    try {
      const [c, p, a, cats] = await Promise.all([
        creditCardService.getCreditCards(user.id),
        creditCardService.getCardPurchases(user.id),
        personalService.getAccounts(user.id),
        personalService.getCategories(user.id),
      ])
      setCards(c); setPurchases(p); setAccounts(a); setCategories(cats)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open purchase form if navigated to /personal/tarjetas/compra
  useEffect(() => {
    if (location.pathname.endsWith('/compra')) setShowPurchaseForm(true)
  }, [location.pathname])

  const month = currentYearMonth()
  const activeCards = cards.filter(c => c.is_active)
  const totalThisMonth = getAllCardsStatementTotal(purchases, month)
  const totalFuture = getFutureInstallmentsTotal(purchases, addMonths(month, 1))

  // Next due: earliest upcoming due across all active cards
  const nextDueInfo = activeCards.length > 0
    ? activeCards
        .map(c => ({ card: c, date: getNextDueDate(c) }))
        .sort((a, b) => a.date.getTime() - b.date.getTime())[0]
    : null

  const handleDeletePurchase = async (purchaseId: string) => {
    if (!user) return
    try {
      await creditCardService.deleteCardPurchase(purchaseId, user.id)
      showToast({ message: 'Compra eliminada', type: 'success' })
      void load()
    } catch (e: any) {
      logger.error('PERSONAL', 'deletePurchase', e)
      showToast({ message: e.message || 'Error al eliminar', type: 'error' })
    }
  }

  const handleDeactivate = async (card: CCType) => {
    if (!user) return
    try {
      await creditCardService.deactivateCreditCard(card.id, user.id)
      showToast({ message: `${card.name} desactivada`, type: 'success' })
      setDisableTarget(null)
      setDetailCard(null)
      void load()
    } catch (e: any) {
      logger.error('PERSONAL', 'deactivateCard', e)
      showToast({ message: e.message || 'Error', type: 'error' })
    }
  }

  if (loading) return <PersonalLoading />

  return (
    <PageContainer testId="personal-cards-page">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff' }}>Tarjetas</span>
        <button
          data-testid="personal-card-new-button"
          onClick={() => { setEditingCard(null); setShowCardForm(true) }}
          style={{ width: 36, height: 36, borderRadius: '0.75rem', background: 'rgba(129,140,248,0.12)', border: '1px solid rgba(129,140,248,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#818cf8' }}
        >
          <Plus size={18} />
        </button>
      </div>

      {/* Summary card */}
      {activeCards.length > 0 && (
        <div
          data-testid="personal-cards-summary"
          style={{ background: 'linear-gradient(135deg, rgba(129,140,248,0.12), rgba(99,102,241,0.06))', border: '1px solid rgba(129,140,248,0.2)', borderRadius: '1.25rem', padding: '1.25rem' }}
        >
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.75rem' }}>
            {activeCards.length} tarjeta{activeCards.length !== 1 ? 's' : ''} activa{activeCards.length !== 1 ? 's' : ''}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: nextDueInfo ? '0.75rem' : 0 }}>
            <div>
              <div style={{ fontSize: '0.68rem', color: '#475569', marginBottom: '0.2rem' }}>Próximo resumen</div>
              <div data-testid="personal-cards-total-due" style={{ fontSize: '1.5rem', fontWeight: 900, color: '#818cf8', fontFamily: 'monospace', letterSpacing: '-0.03em', lineHeight: 1 }}>{fmtMoney(totalThisMonth)}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.68rem', color: '#475569', marginBottom: '0.2rem' }}>Cuotas futuras</div>
              <div data-testid="personal-cards-future-total" style={{ fontSize: '1.5rem', fontWeight: 900, color: '#fbbf24', fontFamily: 'monospace', letterSpacing: '-0.03em', lineHeight: 1 }}>{fmtMoneyCompact(totalFuture)}</div>
            </div>
          </div>
          {nextDueInfo && (
            <div data-testid="personal-cards-next-due" style={{ fontSize: '0.775rem', color: '#818cf8', background: 'rgba(129,140,248,0.08)', borderRadius: '0.5rem', padding: '0.5rem 0.75rem', fontWeight: 600 }}>
              Próx. vencimiento: {nextDueInfo.card.name} el {nextDueInfo.date.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}
            </div>
          )}
        </div>
      )}

      {/* Quick actions */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
        {[
          { label: '+ Tarjeta',  testId: 'personal-card-new-button-2',     color: '#818cf8', bg: 'rgba(129,140,248,0.1)', onClick: () => { setEditingCard(null); setShowCardForm(true) } },
          { label: '+ Compra',   testId: 'personal-card-purchase-button',  color: '#34d399', bg: 'rgba(52,211,153,0.1)',  onClick: () => { setPurchaseDefaultCard(''); setShowPurchaseForm(true) } },
          { label: 'Pagar',      testId: 'personal-card-pay-button',       color: '#f87171', bg: 'rgba(248,113,113,0.1)', onClick: () => setShowPaymentForm(true) },
        ].map(a => (
          <button
            key={a.label}
            data-testid={a.testId}
            onClick={a.onClick}
            style={{ padding: '0.75rem 0.25rem', borderRadius: '0.875rem', background: a.bg, border: `1px solid ${a.color}30`, color: a.color, fontWeight: 700, fontSize: '0.775rem', cursor: 'pointer', minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {a.label}
          </button>
        ))}
      </div>

      {/* Cards list */}
      {cards.length === 0 ? (
        <EmptyPersonal
          icon={<CreditCard size={22} />}
          title="Todavía no agregaste tarjetas."
          description="Registrá tus tarjetas de crédito para ver próximos vencimientos y cuotas."
          cta="Agregar primera tarjeta"
          onCta={() => { setEditingCard(null); setShowCardForm(true) }}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {/* Active cards */}
          {activeCards.length > 0 && (
            <>
              <SectionHeader title="Activas" />
              <Card>
                {activeCards.map((card, i) => {
                  const color = cardColor(i)
                  const thisMonth = getCardStatementTotal(card.id, purchases, month)
                  const nextDue = getNextDueDate(card)
                  return (
                    <div
                      key={card.id}
                      data-testid="personal-card-row"
                      onClick={() => setDetailCard(card)}
                      role="button"
                      style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '1rem', borderBottom: i < activeCards.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', cursor: 'pointer' }}
                      onPointerEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.025)')}
                      onPointerLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div style={{ width: 40, height: 40, borderRadius: '0.875rem', background: `${color}18`, border: `1px solid ${color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <CreditCard size={18} color={color} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div data-testid="personal-card-name" style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#f0f4ff' }}>{card.name}</div>
                        <div data-testid="personal-card-issuer" style={{ fontSize: '0.72rem', color: '#334155', marginTop: '0.1rem' }}>
                          {card.issuer ? `${card.issuer} · ` : ''}{formatCardCycle(card)}
                        </div>
                        <div data-testid="personal-card-due-date" style={{ fontSize: '0.68rem', color: '#475569', marginTop: '0.1rem' }}>
                          Vence {nextDue.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div data-testid="personal-card-statement-total" style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9375rem', color: thisMonth > 0 ? '#818cf8' : '#334155' }}>{fmtMoney(thisMonth)}</div>
                        {card.credit_limit && (
                          <div style={{ fontSize: '0.65rem', color: '#334155', marginTop: '0.1rem' }}>Límite {fmtMoneyCompact(card.credit_limit)}</div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
                        <button
                          data-testid="personal-card-edit"
                          onClick={e => { e.stopPropagation(); setEditingCard(card); setShowCardForm(true) }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#334155', display: 'flex', minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Edit2 size={13} />
                        </button>
                        <ChevronRight size={14} color="#334155" style={{ alignSelf: 'center' }} />
                      </div>
                    </div>
                  )
                })}
              </Card>
            </>
          )}

          {/* Inactive cards */}
          {cards.filter(c => !c.is_active).length > 0 && (
            <>
              <SectionHeader title="Inactivas" />
              <Card style={{ opacity: 0.55 }}>
                {cards.filter(c => !c.is_active).map((card, i, arr) => (
                  <div key={card.id} style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.875rem 1rem', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                    <CreditCard size={16} color="#334155" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#94a3b8' }}>{card.name}</div>
                      <div style={{ fontSize: '0.7rem', color: '#334155' }}>{card.issuer ?? 'Sin emisor'}</div>
                    </div>
                    <button
                      onClick={() => creditCardService.updateCreditCard(card.id, user!.id, { is_active: true }).then(() => void load())}
                      style={{ fontSize: '0.72rem', padding: '0.25rem 0.625rem', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '0.5rem', color: '#34d399', cursor: 'pointer', minHeight: 32 }}
                    >
                      Reactivar
                    </button>
                  </div>
                ))}
              </Card>
            </>
          )}
        </div>
      )}

      {/* Sheets */}
      {(showCardForm || editingCard) && (
        <CardForm
          initial={editingCard ?? undefined}
          onSaved={() => { setShowCardForm(false); setEditingCard(null); void load() }}
          onClose={() => { setShowCardForm(false); setEditingCard(null) }}
        />
      )}

      {showPurchaseForm && (
        <PurchaseForm
          cards={cards}
          categories={categories}
          defaultCardId={purchaseDefaultCard}
          onSaved={() => { setShowPurchaseForm(false); navigate('/personal/tarjetas', { replace: true }); void load() }}
          onClose={() => { setShowPurchaseForm(false); navigate('/personal/tarjetas', { replace: true }) }}
        />
      )}

      {showPaymentForm && (
        <PaymentForm
          cards={cards}
          accounts={accounts}
          onSaved={() => { setShowPaymentForm(false); void load() }}
          onClose={() => setShowPaymentForm(false)}
        />
      )}

      {detailCard && (
        <CardDetailSheet
          card={detailCard}
          purchases={purchases}
          cardIdx={activeCards.findIndex(c => c.id === detailCard.id)}
          onAddPurchase={() => { setPurchaseDefaultCard(detailCard.id); setDetailCard(null); setShowPurchaseForm(true) }}
          onEdit={() => { setEditingCard(detailCard); setDetailCard(null); setShowCardForm(true) }}
          onDeactivate={() => { setDisableTarget(detailCard); setDetailCard(null) }}
          onDeletePurchase={handleDeletePurchase}
          onClose={() => setDetailCard(null)}
        />
      )}

      {disableTarget && (
        <DisableConfirm
          card={disableTarget}
          onConfirm={() => handleDeactivate(disableTarget)}
          onClose={() => setDisableTarget(null)}
        />
      )}
    </PageContainer>
  )
}
