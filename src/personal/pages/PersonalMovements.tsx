import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, ArrowDownUp, X } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import {
  personalService, type PersonalTransaction,
  type PersonalAccount, type PersonalCategory,
} from '../services/personalService'
import {
  TxRow, EmptyPersonal, PersonalLoading, PageContainer, Card,
  SectionHeader, PrimaryBtn, PersonalInput, PersonalSelect,
  showToast, fmtMoney, fmtMoneyCompact,
} from '../components/ui'
import { logger } from '../../lib/logger'

// ── Transaction Form (modal-style) ───────────────────────────────────────────

function TransactionForm({
  accounts, categories, defaultType,
  onSaved, onClose,
}: {
  accounts: PersonalAccount[]
  categories: PersonalCategory[]
  defaultType?: 'income' | 'expense'
  onSaved: () => void
  onClose: () => void
}) {
  const { user } = useAuth()
  const [type, setType] = useState<'income' | 'expense'>(defaultType ?? 'expense')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [categoryId, setCategoryId] = useState('')
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const filteredCats = categories.filter(c => c.type === type && c.is_active)

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
        type,
        amount: amt,
        currency: 'ARS',
        date,
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

  return (
    <div
      data-testid="personal-movement-sheet"
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      <div style={{ width: '100%', maxWidth: 480, background: '#0a1628', borderRadius: '1.5rem 1.5rem 0 0', border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none', padding: '1.25rem', maxHeight: '90dvh', overflowY: 'auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <span style={{ fontWeight: 800, fontSize: '1rem', color: '#f0f4ff' }}>Nuevo movimiento</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem', display: 'flex', minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' }}><X size={18} /></button>
        </div>

        {/* Type toggle */}
        <div data-testid="personal-movement-type" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1.25rem' }}>
          {(['expense', 'income'] as const).map(t => (
            <button
              key={t}
              onClick={() => setType(t)}
              style={{ padding: '0.75rem', borderRadius: '0.75rem', border: `2px solid ${type === t ? (t === 'income' ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.5)') : 'rgba(255,255,255,0.08)'}`, background: type === t ? (t === 'income' ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)') : 'transparent', color: type === t ? (t === 'income' ? '#34d399' : '#f87171') : '#475569', fontWeight: 700, cursor: 'pointer', fontSize: '0.875rem', minHeight: 44 }}
            >
              {t === 'expense' ? '← Gasto' : 'Ingreso →'}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Amount — large display input, must be ≥16px for iOS */}
          <div>
            <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Monto *</label>
            <input
              data-testid="personal-movement-amount"
              type="number" min="0" step="0.01" value={amount}
              onChange={e => setAmount(e.target.value)} placeholder="0" autoFocus
              style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: 'rgba(255,255,255,0.04)', border: `1px solid ${type === 'income' ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)'}`, borderRadius: '0.875rem', color: type === 'income' ? '#34d399' : '#f87171', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
            />
          </div>

          <PersonalInput
            testId="personal-movement-description"
            label="Descripción *" value={description}
            onChange={e => setDescription(e.target.value)} placeholder="¿En qué?"
          />

          <PersonalSelect
            testId="personal-movement-account"
            label="Cuenta *" value={accountId}
            onChange={e => setAccountId(e.target.value)}
          >
            <option value="">Seleccionar cuenta</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({fmtMoney(a.current_balance)})</option>)}
          </PersonalSelect>

          {filteredCats.length > 0 && (
            <PersonalSelect
              testId="personal-movement-category"
              label="Categoría" value={categoryId}
              onChange={e => setCategoryId(e.target.value)}
            >
              <option value="">Sin categoría</option>
              {filteredCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </PersonalSelect>
          )}

          <PersonalInput
            testId="personal-movement-date"
            label="Fecha" type="date" value={date}
            onChange={e => setDate(e.target.value)}
          />
          <PersonalInput label="Nota (opcional)" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Detalle adicional..." />

          {error && (
            <div style={{ padding: '0.625rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>
              {error}
            </div>
          )}

          <PrimaryBtn testId="personal-movement-save" onClick={handleSave} loading={saving} fullWidth>
            {saving ? 'Guardando…' : `Guardar ${type === 'income' ? 'ingreso' : 'gasto'}`}
          </PrimaryBtn>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function PersonalMovements() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [loading, setLoading] = useState(true)
  const [txs, setTxs] = useState<PersonalTransaction[]>([])
  const [accounts, setAccounts] = useState<PersonalAccount[]>([])
  const [categories, setCategories] = useState<PersonalCategory[]>([])
  const [showForm, setShowForm] = useState(false)
  const defaultType = (searchParams.get('type') as 'income' | 'expense') || undefined
  const [filter, setFilter] = useState<'all' | 'income' | 'expense'>('all')

  const load = async () => {
    if (!user) return
    setLoading(true)
    try {
      const [t, a, c] = await Promise.all([
        personalService.getTransactions(user.id, { limit: 50 }),
        personalService.getAccounts(user.id),
        personalService.getCategories(user.id),
      ])
      setTxs(t); setAccounts(a); setCategories(c)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (defaultType) setShowForm(true) }, [defaultType])

  const filtered = filter === 'all' ? txs : txs.filter(t => t.type === filter)
  const grouped: Record<string, PersonalTransaction[]> = {}
  filtered.forEach(tx => {
    if (!grouped[tx.date]) grouped[tx.date] = []
    grouped[tx.date].push(tx)
  })

  const totalIncome = txs.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0)
  const totalExpense = txs.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0)

  if (loading) return <PersonalLoading />

  return (
    <PageContainer testId="personal-movements-page">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff' }}>Movimientos</span>
        <button
          data-testid="personal-movement-new-button"
          onClick={() => setShowForm(true)}
          style={{ width: 36, height: 36, borderRadius: '0.75rem', background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#34d399' }}
        >
          <Plus size={18} />
        </button>
      </div>

      {/* Month summary */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
        {[
          { label: 'Ingresos', value: fmtMoneyCompact(totalIncome),             color: '#34d399' },
          { label: 'Gastos',   value: fmtMoneyCompact(totalExpense),             color: '#f87171' },
          { label: 'Balance',  value: fmtMoneyCompact(totalIncome - totalExpense), color: totalIncome - totalExpense >= 0 ? '#818cf8' : '#f87171' },
        ].map(s => (
          <div key={s.label} style={{ background: `${s.color}0d`, border: `1px solid ${s.color}25`, borderRadius: '0.75rem', padding: '0.75rem', textAlign: 'center' }}>
            <div style={{ fontSize: '0.6rem', color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.label}</div>
            <div style={{ fontSize: '1rem', fontWeight: 800, color: s.color, marginTop: '0.2rem', fontFamily: 'monospace' }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div
        data-testid="personal-movement-filter-type"
        style={{ display: 'flex', gap: '0.375rem', padding: '0.25rem', background: 'rgba(255,255,255,0.04)', borderRadius: '0.75rem' }}
      >
        {(['all', 'income', 'expense'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{ flex: 1, padding: '0.5rem', borderRadius: '0.5rem', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '0.8rem', background: filter === f ? 'rgba(255,255,255,0.08)' : 'transparent', color: filter === f ? '#f0f4ff' : '#475569', transition: 'all 0.15s', minHeight: 36 }}
          >
            {f === 'all' ? 'Todos' : f === 'income' ? 'Ingresos' : 'Gastos'}
          </button>
        ))}
      </div>

      {/* Transactions */}
      {filtered.length === 0 ? (
        <EmptyPersonal
          icon={<ArrowDownUp size={22} />}
          title="Sin movimientos"
          description="Cargá tu primer ingreso o gasto para ver el historial."
          cta="Nuevo movimiento"
          onCta={() => setShowForm(true)}
        />
      ) : (
        Object.entries(grouped)
          .sort(([a], [b]) => b.localeCompare(a))
          .map(([d, items]) => (
            <div key={d}>
              <SectionHeader title={new Date(d + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })} />
              <Card>
                {items.map(tx => (
                  <TxRow
                    testId="personal-movement-row"
                    key={tx.id}
                    label={tx.description}
                    sub={(tx.account as any)?.name}
                    amount={Number(tx.amount)}
                    type={tx.type as 'income' | 'expense' | 'transfer'}
                    onClick={() => navigate('/personal/movimientos')}
                  />
                ))}
              </Card>
            </div>
          ))
      )}

      {showForm && (
        <TransactionForm
          accounts={accounts}
          categories={categories}
          defaultType={defaultType}
          onSaved={() => { setShowForm(false); void load() }}
          onClose={() => setShowForm(false)}
        />
      )}
    </PageContainer>
  )
}
