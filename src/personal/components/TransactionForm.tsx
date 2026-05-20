/**
 * Shared TransactionForm for Mi Guita.
 * Used by PersonalMovements (full page) and PersonalDashboard (quick actions).
 */
import { useState } from 'react'
import { PersonalBottomSheet } from './PersonalBottomSheet'
import { useAuth } from '../../contexts/AuthContext'
import {
  personalService,
  type PersonalAccount, type PersonalCategory,
  getAccountCurrencies, getAccountBalanceForCurrency,
} from '../services/personalService'
import {
  PrimaryBtn, PersonalInput, PersonalSelect, showToast, fmtMoney,
} from './ui'
import { logger } from '../../lib/logger'

export interface TransactionFormProps {
  accounts: PersonalAccount[]
  categories: PersonalCategory[]
  defaultType?: 'income' | 'expense'
  /** Override the sheet title — defaults to type-aware label */
  title?: string
  onSaved: () => void
  onClose: () => void
}

export function TransactionForm({
  accounts, categories, defaultType, title, onSaved, onClose,
}: TransactionFormProps) {
  const { user } = useAuth()
  const [type, setType]               = useState<'income' | 'expense'>(defaultType ?? 'expense')
  const [amount, setAmount]           = useState('')
  const [description, setDescription] = useState('')
  const [accountId, setAccountId]     = useState(accounts[0]?.id ?? '')
  const [currency, setCurrency]       = useState('ARS')
  const [categoryId, setCategoryId]   = useState('')
  const [date, setDate]               = useState(new Date().toISOString().split('T')[0])
  const [notes, setNotes]             = useState('')
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState('')

  const selectedAccount    = accounts.find(a => a.id === accountId)
  const accountCurrencies  = selectedAccount ? getAccountCurrencies(selectedAccount) : ['ARS']
  const filteredCats       = categories.filter(c => c.type === type && c.is_active)

  const handleAccountChange = (id: string) => {
    setAccountId(id)
    const acc = accounts.find(a => a.id === id)
    if (acc) {
      const curs = getAccountCurrencies(acc)
      if (curs.length === 1) setCurrency(curs[0])
      else if (!curs.includes(currency)) setCurrency(curs[0])
    }
  }

  const handleSave = async () => {
    if (!user || saving) return
    const amt = parseFloat(amount.replace(',', '.'))
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    if (!description.trim()) { setError('La descripción es obligatoria'); return }
    if (!accountId) { setError('Seleccioná una cuenta'); return }
    setError('')
    setSaving(true)
    try {
      await personalService.createTransaction(user.id, {
        account_id: accountId,
        category_id: categoryId || null,
        type, amount: amt, currency, date,
        description: description.trim(),
        notes: notes.trim() || null,
        payment_method: null,
        linked_owner_withdrawal_id: null,
      })
      showToast({ message: type === 'income' ? 'Ingreso guardado' : 'Gasto guardado', type: 'success' })
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'createTransaction', e)
      const msg = e.message || 'Error al guardar'
      setError(msg)
      showToast({ message: msg, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const sheetTitle = title ?? (type === 'income' ? 'Nuevo ingreso' : 'Nuevo gasto')

  return (
    <PersonalBottomSheet
      open
      title={sheetTitle}
      onClose={onClose}
      testId="personal-movement-sheet"
      footer={
        <PrimaryBtn testId="personal-movement-save" onClick={handleSave} loading={saving} fullWidth>
          {saving ? 'Guardando…' : `Guardar ${type === 'income' ? 'ingreso' : 'gasto'}`}
        </PrimaryBtn>
      }
    >
      {/* Type toggle */}
      <div data-testid="personal-movement-type" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1.25rem' }}>
        {(['expense', 'income'] as const).map(t => (
          <button key={t} onClick={() => setType(t)}
            style={{ padding: '0.75rem', borderRadius: '0.75rem', border: `2px solid ${type === t ? (t === 'income' ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.5)') : 'rgba(255,255,255,0.08)'}`, background: type === t ? (t === 'income' ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)') : 'transparent', color: type === t ? (t === 'income' ? '#34d399' : '#f87171') : '#475569', fontWeight: 700, cursor: 'pointer', fontSize: '0.875rem', minHeight: 44 }}>
            {t === 'expense' ? '← Gasto' : 'Ingreso →'}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Monto *</label>
          <input
            data-testid="personal-movement-amount"
            type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*"
            value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="0" autoFocus autoComplete="off"
            style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: 'rgba(255,255,255,0.04)', border: `1px solid ${type === 'income' ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)'}`, borderRadius: '0.875rem', color: type === 'income' ? '#34d399' : '#f87171', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
          />
        </div>

        <PersonalInput testId="personal-movement-description" label="Descripción *" value={description} onChange={e => setDescription(e.target.value)} placeholder="¿En qué?" autoCapitalize="sentences" autoComplete="off" />

        <PersonalSelect testId="personal-movement-account" label="Cuenta *" value={accountId} onChange={e => handleAccountChange(e.target.value)}>
          <option value="">Seleccionar cuenta</option>
          {accounts.map(a => {
            const bal = getAccountBalanceForCurrency(a, currency)
            return <option key={a.id} value={a.id}>{a.name} ({fmtMoney(bal, currency)})</option>
          })}
        </PersonalSelect>

        {accountCurrencies.length > 1 && (
          <div>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Moneda</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem' }}>
              {accountCurrencies.map(cur => (
                <button key={cur} type="button" onClick={() => setCurrency(cur)}
                  style={{ padding: '0.625rem', borderRadius: '0.625rem', border: `2px solid ${currency === cur ? (type === 'income' ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.5)') : 'rgba(255,255,255,0.08)'}`, background: currency === cur ? (type === 'income' ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)') : 'transparent', color: currency === cur ? (type === 'income' ? '#34d399' : '#f87171') : '#475569', fontWeight: 700, cursor: 'pointer', fontSize: '0.875rem', minHeight: 44 }}>
                  {cur}
                </button>
              ))}
            </div>
          </div>
        )}

        {filteredCats.length > 0 && (
          <PersonalSelect testId="personal-movement-category" label="Categoría" value={categoryId} onChange={e => setCategoryId(e.target.value)}>
            <option value="">Sin categoría</option>
            {filteredCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </PersonalSelect>
        )}

        <PersonalInput testId="personal-movement-date" label="Fecha" type="date" value={date} onChange={e => setDate(e.target.value)} />
        <PersonalInput label="Nota (opcional)" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Detalle adicional..." autoCapitalize="sentences" autoComplete="off" />

        {error && (
          <div style={{ padding: '0.625rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>
            {error}
          </div>
        )}
      </div>
    </PersonalBottomSheet>
  )
}
