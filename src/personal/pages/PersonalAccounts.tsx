import { useState, useEffect } from 'react'
import { PersonalBottomSheet } from '../components/PersonalBottomSheet'
import { Plus, Wallet, Edit2, ChevronDown, ChevronUp } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import {
  personalService, type PersonalAccount, accountTypeLabel,
  getAccountBalanceForCurrency, getAccountCurrencies,
} from '../services/personalService'
import {
  EmptyPersonal, PersonalLoading, PageContainer, Card, PrimaryBtn,
  PersonalInput, PersonalSelect, showToast, fmtMoney,
} from '../components/ui'
import { logger } from '../../lib/logger'

const ACCOUNT_TYPES = [
  { value: 'cash',    label: 'Efectivo' },
  { value: 'bank',    label: 'Banco' },
  { value: 'digital', label: 'Billetera digital (MP, etc.)' },
  { value: 'savings', label: 'Ahorro' },
  { value: 'dollars', label: 'Dólares' },
  { value: 'other',   label: 'Otra' },
]

const ACCOUNT_COLORS: Record<string, string> = {
  cash: '#34d399', bank: '#60a5fa', digital: '#818cf8',
  savings: '#fbbf24', dollars: '#4ade80', other: '#94a3b8',
}

const CURRENCIES = [
  { value: 'ARS', label: 'Pesos (ARS)', symbol: '$' },
  { value: 'USD', label: 'Dólares (USD)', symbol: 'U$' },
]

// ─── AccountForm ─────────────────────────────────────────────────────────────

interface CurrencyEntry { currency: string; initial_balance: string }

function AccountForm({ initial, onSaved, onClose }: {
  initial?: PersonalAccount; onSaved: () => void; onClose: () => void
}) {
  const { user } = useAuth()
  const [name, setName]   = useState(initial?.name ?? '')
  const [type, setType]   = useState<PersonalAccount['type']>(initial?.type ?? 'cash')
  const [saving, setSaving] = useState(false)
  const [error, setError]  = useState('')

  // Multi-currency state
  const [currencies, setCurrencies] = useState<CurrencyEntry[]>(() => {
    if (initial?.balances?.length) {
      return initial.balances.map(b => ({ currency: b.currency, initial_balance: String(b.initial_balance) }))
    }
    return [{ currency: 'ARS', initial_balance: '0' }]
  })

  const selectedCurrencies = currencies.map(c => c.currency)

  const toggleCurrency = (cur: string) => {
    if (selectedCurrencies.includes(cur)) {
      if (currencies.length <= 1) return // need at least one
      setCurrencies(prev => prev.filter(c => c.currency !== cur))
    } else {
      setCurrencies(prev => [...prev, { currency: cur, initial_balance: '0' }])
    }
  }

  const updateBalance = (cur: string, val: string) => {
    setCurrencies(prev => prev.map(c => c.currency === cur ? { ...c, initial_balance: val } : c))
  }

  const handleSave = async () => {
    if (!user || saving) return
    if (!name.trim()) { setError('El nombre es obligatorio'); return }
    if (currencies.length === 0) { setError('Seleccioná al menos una moneda'); return }
    for (const c of currencies) {
      const bal = parseFloat(c.initial_balance) || 0
      if (bal < 0) { setError('Los saldos iniciales no pueden ser negativos'); return }
    }
    setError('')
    setSaving(true)
    try {
      if (initial) {
        await personalService.updateAccount(initial.id, user.id, { name: name.trim(), type })
        showToast({ message: 'Cuenta actualizada', type: 'success' })
      } else {
        await personalService.createAccount(user.id, {
          name: name.trim(),
          type,
          currencies: currencies.map(c => ({
            currency: c.currency,
            initial_balance: parseFloat(c.initial_balance) || 0,
          })),
        })
        showToast({ message: 'Cuenta creada', type: 'success' })
      }
      onSaved()
    } catch (e: any) {
      logger.error('PERSONAL', 'saveAccount', e)
      const msg = e.message || 'Error al guardar'
      setError(msg)
      showToast({ message: msg, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const canSave = !saving && name.trim().length > 0 && currencies.length > 0

  return (
    <PersonalBottomSheet
      open
      title={initial ? 'Editar cuenta' : 'Nueva cuenta'}
      onClose={onClose}
      testId="personal-account-form"
      footer={
        <PrimaryBtn
          testId="personal-account-save"
          onClick={handleSave}
          loading={saving}
          disabled={!canSave}
          fullWidth
        >
          {saving ? 'Guardando…' : (initial ? 'Guardar cambios' : 'Crear cuenta')}
        </PrimaryBtn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <PersonalInput
          testId="personal-account-name"
          label="Nombre *"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Ej: Efectivo billetera, Cuenta BBVA..."
          autoCapitalize="words" autoComplete="off"
        />
        <PersonalSelect
          testId="personal-account-type"
          label="Tipo"
          value={type}
          onChange={e => setType(e.target.value as PersonalAccount['type'])}
        >
          {ACCOUNT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </PersonalSelect>

        {/* Multi-currency selection */}
        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.625rem' }}>
            Monedas de la cuenta
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {CURRENCIES.map(cur => {
              const isSelected = selectedCurrencies.includes(cur.value)
              const entry = currencies.find(c => c.currency === cur.value)
              return (
                <div key={cur.value} style={{ background: isSelected ? 'rgba(52,211,153,0.04)' : 'rgba(255,255,255,0.02)', border: `1px solid ${isSelected ? 'rgba(52,211,153,0.25)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '0.875rem', overflow: 'hidden', transition: 'all 0.15s' }}>
                  <div
                    onClick={() => toggleCurrency(cur.value)}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', cursor: 'pointer', minHeight: 48 }}
                  >
                    <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${isSelected ? '#34d399' : '#334155'}`, background: isSelected ? 'rgba(52,211,153,0.2)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.15s' }}>
                      {isSelected && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#34d399' }} />}
                    </div>
                    <span style={{ fontWeight: 600, fontSize: '0.875rem', color: isSelected ? '#f0f4ff' : '#475569', flex: 1 }}>{cur.label}</span>
                    {isSelected && (
                      <span style={{ fontSize: '0.72rem', color: '#34d399', fontFamily: 'monospace' }}>
                        {cur.symbol}{parseFloat(entry?.initial_balance || '0').toLocaleString('es-AR')}
                      </span>
                    )}
                  </div>
                  {isSelected && !initial && (
                    <div style={{ padding: '0 1rem 0.875rem' }}>
                      <label style={{ fontSize: '0.7rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: '0.375rem' }}>
                        Saldo inicial {cur.value}
                      </label>
                      <input
                        data-testid={`personal-account-initial-balance-${cur.value}`}
                        type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*"
                        value={entry?.initial_balance ?? '0'}
                        onChange={e => updateBalance(cur.value, e.target.value)}
                        placeholder="0" autoComplete="off"
                        style={{ width: '100%', padding: '0.625rem 0.875rem', boxSizing: 'border-box', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.625rem', color: '#34d399', fontSize: '1rem', fontFamily: 'monospace', fontWeight: 700, outline: 'none' }}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {error && (
          <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>
            {error}
          </div>
        )}
      </div>
    </PersonalBottomSheet>
  )
}

// ─── PersonalAccounts page ────────────────────────────────────────────────────

export function PersonalAccounts() {
  const { user } = useAuth()
  const [loading, setLoading]   = useState(true)
  const [accounts, setAccounts] = useState<PersonalAccount[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing]   = useState<PersonalAccount | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = async () => {
    if (!user) return
    setLoading(true)
    const data = await personalService.getAccounts(user.id).finally(() => setLoading(false))
    setAccounts(data)
  }

  useEffect(() => { void load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  // Totals per currency from personal_account_balances
  const totalARS = accounts.flatMap(a => a.balances ?? [])
    .filter(b => b.currency === 'ARS')
    .reduce((s, b) => s + Number(b.current_balance), 0)
  const totalUSD = accounts.flatMap(a => a.balances ?? [])
    .filter(b => b.currency === 'USD')
    .reduce((s, b) => s + Number(b.current_balance), 0)

  // Fallback for legacy accounts without balances
  const legacyARS = accounts
    .filter(a => a.currency === 'ARS' && (!a.balances?.length))
    .reduce((s, a) => s + Number(a.current_balance), 0)
  const displayARS = totalARS + legacyARS

  if (loading) return <PersonalLoading />

  return (
    <PageContainer testId="personal-accounts-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff' }}>Mis cuentas</span>
        <button
          data-testid="personal-account-new-button"
          onClick={() => { setEditing(null); setShowForm(true) }}
          style={{ width: 36, height: 36, borderRadius: '0.75rem', background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#34d399' }}
        >
          <Plus size={18} />
        </button>
      </div>

      {/* Summary cards by currency */}
      {accounts.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: totalUSD > 0 ? '1fr 1fr' : '1fr', gap: '0.625rem' }}>
          <div style={{ background: 'linear-gradient(135deg, rgba(52,211,153,0.1),rgba(16,185,129,0.05))', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '1rem', padding: '1rem', textAlign: 'center' }}>
            <div style={{ fontSize: '0.7rem', color: '#059669', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.25rem' }}>Total pesos</div>
            <div style={{ fontSize: '1.75rem', fontWeight: 900, color: '#34d399', fontFamily: 'monospace' }}>{fmtMoney(displayARS)}</div>
          </div>
          {totalUSD > 0 && (
            <div style={{ background: 'linear-gradient(135deg, rgba(74,222,128,0.1),rgba(74,222,128,0.05))', border: '1px solid rgba(74,222,128,0.2)', borderRadius: '1rem', padding: '1rem', textAlign: 'center' }}>
              <div style={{ fontSize: '0.7rem', color: '#16a34a', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.25rem' }}>Total USD</div>
              <div style={{ fontSize: '1.75rem', fontWeight: 900, color: '#4ade80', fontFamily: 'monospace' }}>{fmtMoney(totalUSD, 'USD')}</div>
            </div>
          )}
        </div>
      )}

      {accounts.length === 0 ? (
        <EmptyPersonal
          icon={<Wallet size={22} />}
          title="Sin cuentas aún"
          description="Creá tu primera cuenta para empezar a registrar tus finanzas."
          cta="Crear cuenta"
          onCta={() => setShowForm(true)}
        />
      ) : (
        <Card>
          {accounts.map((acc, i) => {
            const color = ACCOUNT_COLORS[acc.type] ?? '#94a3b8'
            const currencies = getAccountCurrencies(acc)
            const isExp = expanded === acc.id
            return (
              <div key={acc.id} style={{ borderBottom: i < accounts.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                {/* Main row */}
                <div
                  data-testid="personal-account-row"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '1rem' }}
                >
                  <div style={{ width: 40, height: 40, borderRadius: '0.875rem', background: `${color}18`, border: `1px solid ${color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Wallet size={18} color={color} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#f0f4ff' }}>{acc.name}</div>
                    <div style={{ fontSize: '0.72rem', color: '#334155', marginTop: '0.1rem' }}>{accountTypeLabel(acc.type)}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    {/* Show ARS balance prominently */}
                    {currencies.includes('ARS') && (
                      <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '1rem', color: getAccountBalanceForCurrency(acc, 'ARS') >= 0 ? color : '#f87171' }}>
                        {fmtMoney(getAccountBalanceForCurrency(acc, 'ARS'))}
                      </div>
                    )}
                    {/* Show USD if exists */}
                    {currencies.includes('USD') && (
                      <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.82rem', color: '#4ade80', marginTop: '0.1rem' }}>
                        {fmtMoney(getAccountBalanceForCurrency(acc, 'USD'), 'USD')}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '0.125rem', flexShrink: 0 }}>
                    <button
                      data-testid="personal-card-edit"
                      onClick={() => { setEditing(acc); setShowForm(true) }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#334155', display: 'flex', minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Edit2 size={13} />
                    </button>
                    {currencies.length > 1 && (
                      <button
                        onClick={() => setExpanded(isExp ? null : acc.id)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#334155', display: 'flex', minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' }}
                      >
                        {isExp ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded: all currency balances + initial */}
                {isExp && acc.balances && acc.balances.length > 0 && (
                  <div style={{ padding: '0 1rem 0.875rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                    {acc.balances.map(bal => (
                      <div key={bal.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.025)', borderRadius: '0.5rem' }}>
                        <span style={{ color: '#475569', fontWeight: 600 }}>{bal.currency}</span>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontFamily: 'monospace', fontWeight: 800, color: Number(bal.current_balance) >= 0 ? color : '#f87171' }}>
                            {fmtMoney(Number(bal.current_balance), bal.currency)}
                          </div>
                          <div style={{ fontSize: '0.65rem', color: '#334155' }}>
                            Inicial: {fmtMoney(Number(bal.initial_balance), bal.currency)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </Card>
      )}

      {(showForm || editing) && (
        <AccountForm
          initial={editing ?? undefined}
          onSaved={() => { setShowForm(false); setEditing(null); void load() }}
          onClose={() => { setShowForm(false); setEditing(null) }}
        />
      )}
    </PageContainer>
  )
}
