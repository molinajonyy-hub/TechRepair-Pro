import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, ArrowDownUp } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { personalService, type PersonalTransaction, type PersonalAccount, type PersonalCategory } from '../services/personalService'
import {
  TxRow, EmptyPersonal, PersonalLoading, PageContainer, Card,
  SectionHeader, fmtMoneyCompact,
} from '../components/ui'
import { TransactionForm } from '../components/TransactionForm'

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
