import { useState, useEffect } from 'react'
import { Plus, Wallet, Edit2, X } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { personalService, type PersonalAccount, accountTypeLabel } from '../services/personalService'
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

function AccountForm({ initial, onSaved, onClose }: {
  initial?: PersonalAccount; onSaved: () => void; onClose: () => void
}) {
  const { user } = useAuth()
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<PersonalAccount['type']>(initial?.type ?? 'cash')
  const [currency, setCurrency] = useState(initial?.currency ?? 'ARS')
  const [initialBalance, setInitialBalance] = useState(String(initial?.initial_balance ?? '0'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSave = async () => {
    if (!user || saving) return
    if (!name.trim()) { setError('El nombre es obligatorio'); return }
    setError('')
    setSaving(true)
    try {
      if (initial) {
        await personalService.updateAccount(initial.id, user.id, { name: name.trim(), type, currency })
        showToast({ message: 'Cuenta actualizada', type: 'success' })
      } else {
        await personalService.createAccount(user.id, {
          name: name.trim(), type, currency,
          initial_balance: parseFloat(initialBalance) || 0,
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

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div
        data-testid="personal-account-form"
        style={{ width: '100%', maxWidth: 480, background: '#0a1628', borderRadius: '1.5rem 1.5rem 0 0', border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none', padding: '1.25rem' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <span style={{ fontWeight: 800, fontSize: '1rem', color: '#f0f4ff' }}>{initial ? 'Editar cuenta' : 'Nueva cuenta'}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', display: 'flex', minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' }}><X size={18} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <PersonalInput
            testId="personal-account-name"
            label="Nombre *" value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Ej: Efectivo billetera, Cuenta BBVA..."
          />
          <PersonalSelect
            testId="personal-account-type"
            label="Tipo" value={type}
            onChange={e => setType(e.target.value as PersonalAccount['type'])}
          >
            {ACCOUNT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </PersonalSelect>
          <PersonalSelect
            testId="personal-account-currency"
            label="Moneda" value={currency}
            onChange={e => setCurrency(e.target.value)}
          >
            <option value="ARS">ARS — Pesos</option>
            <option value="USD">USD — Dólares</option>
          </PersonalSelect>
          {!initial && (
            <PersonalInput
              testId="personal-account-initial-balance"
              label="Saldo inicial" type="number" min="0"
              value={initialBalance}
              onChange={e => setInitialBalance(e.target.value)}
              placeholder="0"
            />
          )}
          {error && (
            <div style={{ padding: '0.5rem', background: 'rgba(248,113,113,0.08)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>
              {error}
            </div>
          )}
          <PrimaryBtn testId="personal-account-save" onClick={handleSave} loading={saving} fullWidth>
            {saving ? 'Guardando…' : (initial ? 'Guardar cambios' : 'Crear cuenta')}
          </PrimaryBtn>
        </div>
      </div>
    </div>
  )
}

export function PersonalAccounts() {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [accounts, setAccounts] = useState<PersonalAccount[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<PersonalAccount | null>(null)

  const load = async () => {
    if (!user) return
    setLoading(true)
    const data = await personalService.getAccounts(user.id).finally(() => setLoading(false))
    setAccounts(data)
  }

  useEffect(() => { void load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const totalARS = accounts.filter(a => a.currency === 'ARS').reduce((s, a) => s + Number(a.current_balance), 0)

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

      {accounts.length > 0 && (
        <div style={{ background: 'linear-gradient(135deg, rgba(52,211,153,0.1),rgba(16,185,129,0.05))', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '1rem', padding: '1rem', textAlign: 'center' }}>
          <div style={{ fontSize: '0.7rem', color: '#059669', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.25rem' }}>Total en pesos</div>
          <div style={{ fontSize: '2rem', fontWeight: 900, color: '#34d399', fontFamily: 'monospace' }}>{fmtMoney(totalARS)}</div>
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
            return (
              <div
                key={acc.id}
                data-testid="personal-account-row"
                style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '1rem', borderBottom: i < accounts.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}
              >
                <div style={{ width: 40, height: 40, borderRadius: '0.875rem', background: `${color}18`, border: `1px solid ${color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Wallet size={18} color={color} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#f0f4ff' }}>{acc.name}</div>
                  <div style={{ fontSize: '0.72rem', color: '#334155', marginTop: '0.1rem' }}>{accountTypeLabel(acc.type)} · {acc.currency}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '1rem', color: Number(acc.current_balance) >= 0 ? color : '#f87171' }}>{fmtMoney(acc.current_balance, acc.currency)}</div>
                  <div style={{ fontSize: '0.65rem', color: '#334155', marginTop: '0.1rem' }}>Inicial: {fmtMoney(acc.initial_balance, acc.currency)}</div>
                </div>
                <button
                  onClick={() => { setEditing(acc); setShowForm(true) }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#334155', padding: '0.25rem', flexShrink: 0, display: 'flex', minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Edit2 size={14} />
                </button>
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
