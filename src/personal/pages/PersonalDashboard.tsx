import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Wallet, TrendingUp, TrendingDown, ArrowDownUp, Building2, CreditCard } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { personalService, type PersonalAccount, type PersonalTransaction } from '../services/personalService'
import { creditCardService, type CreditCard as CCType, type CardPurchase } from '../services/creditCardService'
import {
  SummaryCard, SectionHeader, TxRow, EmptyPersonal, SkeletonCard,
  PageContainer, Card, fmtMoney, fmtMoneyCompact,
} from '../components/ui'
import {
  currentYearMonth, getAllCardsStatementTotal, getFutureInstallmentsTotal,
  addMonths, getNextDueDate,
} from '../utils/creditCards'

const currentMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function PersonalDashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [accounts, setAccounts] = useState<PersonalAccount[]>([])
  const [recentTx, setRecentTx] = useState<PersonalTransaction[]>([])
  const [summary, setSummary] = useState({ totalIncome: 0, totalExpense: 0, balance: 0, available: 0 })
  const [cards, setCards] = useState<CCType[]>([])
  const [cardPurchases, setCardPurchases] = useState<CardPurchase[]>([])

  useEffect(() => {
    if (!user) return
    const load = async () => {
      try {
        await personalService.ensureDefaultCategories(user.id)
        const [accts, txs, sum, crds, purch] = await Promise.all([
          personalService.getAccounts(user.id),
          personalService.getTransactions(user.id, { limit: 8 }),
          personalService.getMonthlySummary(user.id, currentMonth()),
          creditCardService.getCreditCards(user.id).catch(() => [] as CCType[]),
          creditCardService.getCardPurchases(user.id).catch(() => [] as CardPurchase[]),
        ])
        setAccounts(accts)
        setRecentTx(txs)
        setSummary(sum)
        setCards(crds)
        setCardPurchases(purch)
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [user])

  const availableBalance = summary.available
  const month = currentYearMonth()
  const activeCards = cards.filter(c => c.is_active)
  const totalCardsThisMonth = getAllCardsStatementTotal(cardPurchases, month)
  const totalFutureInstallments = getFutureInstallmentsTotal(cardPurchases, addMonths(month, 1))
  const nextCardDue = activeCards.length > 0
    ? activeCards.map(c => ({ card: c, date: getNextDueDate(c) })).sort((a, b) => a.date.getTime() - b.date.getTime())[0]
    : null

  return (
    <PageContainer testId="personal-dashboard">
      {/* ── Greeting ── */}
      <div style={{ padding: '0.5rem 0 0.25rem' }}>
        <div style={{ fontSize: '0.75rem', color: '#334155', fontWeight: 600 }}>
          {new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
        <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#f0f4ff', marginTop: '0.125rem' }}>
          Mis finanzas personales
        </div>
      </div>

      {/* ── Available big card ── */}
      <div
        data-testid="personal-balance-card"
        style={{ background: 'linear-gradient(135deg, rgba(52,211,153,0.12), rgba(16,185,129,0.06))', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '1.25rem', padding: '1.25rem' }}
      >
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#059669', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.375rem' }}>
          Disponible total
        </div>
        {loading ? (
          <div style={{ height: 40, width: '60%', borderRadius: 8, background: 'rgba(52,211,153,0.1)' }} />
        ) : (
          <div style={{ fontSize: '2.5rem', fontWeight: 900, color: availableBalance >= 0 ? '#34d399' : '#f87171', letterSpacing: '-0.04em', lineHeight: 1, fontFamily: 'monospace' }}>
            {fmtMoney(availableBalance)}
          </div>
        )}
        <div style={{ fontSize: '0.75rem', color: '#047857', marginTop: '0.5rem' }}>
          en {accounts.length} cuenta{accounts.length !== 1 ? 's' : ''} activa{accounts.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* ── Month summary grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.625rem' }}>
        <SummaryCard
          testId="personal-income-card"
          label="Ingresos del mes"
          value={loading ? '...' : fmtMoneyCompact(summary.totalIncome)}
          color="#34d399" accent="rgba(52,211,153,0.07)"
          icon={<TrendingUp size={14} />}
        />
        <SummaryCard
          testId="personal-expense-card"
          label="Gastos del mes"
          value={loading ? '...' : fmtMoneyCompact(summary.totalExpense)}
          color="#f87171" accent="rgba(248,113,113,0.07)"
          icon={<TrendingDown size={14} />}
        />
        <SummaryCard
          testId="personal-month-balance-card"
          label="Balance mensual"
          value={loading ? '...' : fmtMoneyCompact(summary.balance)}
          color={summary.balance >= 0 ? '#818cf8' : '#f87171'}
          accent={summary.balance >= 0 ? 'rgba(129,140,248,0.07)' : 'rgba(248,113,113,0.07)'}
          icon={<ArrowDownUp size={14} />}
        />
        <SummaryCard
          label="Ahorro posible"
          value={loading ? '...' : (summary.balance > 0 ? fmtMoneyCompact(summary.balance) : '$0')}
          color="#fbbf24" accent="rgba(251,191,36,0.07)"
        />
      </div>

      {/* ── Quick actions ── */}
      <div>
        <SectionHeader title="Acciones rápidas" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem' }}>
          {([
            { label: '+ Gasto',       color: '#f87171', bg: 'rgba(248,113,113,0.1)', path: '/personal/movimientos/nuevo?type=expense', testId: 'personal-quick-expense' },
            { label: '+ Ingreso',      color: '#34d399', bg: 'rgba(52,211,153,0.1)',  path: '/personal/movimientos/nuevo?type=income',  testId: 'personal-quick-income'  },
            { label: 'Pagarme sueldo', color: '#818cf8', bg: 'rgba(129,140,248,0.1)', path: '/personal/sueldo',                         testId: 'personal-quick-salary'  },
            { label: 'Ver cuentas',    color: '#60a5fa', bg: 'rgba(96,165,250,0.1)',  path: '/personal/cuentas',                        testId: undefined                },
          ] as const).map(a => (
            <button
              key={a.label}
              data-testid={a.testId}
              onClick={() => navigate(a.path)}
              style={{ padding: '0.875rem', borderRadius: '0.875rem', background: a.bg, border: `1px solid ${a.color}30`, color: a.color, fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '0.5rem', minHeight: 48 }}
            >
              <Plus size={14} /> {a.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Credit card summary ── */}
      <div>
        <SectionHeader
          title="Tarjetas"
          action={<button onClick={() => navigate('/personal/tarjetas')} style={{ fontSize: '0.72rem', color: '#818cf8', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Ver tarjetas</button>}
        />
        {loading ? <SkeletonCard rows={1} /> : activeCards.length === 0 ? (
          <Card>
            <div style={{ padding: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <CreditCard size={16} color="#334155" style={{ flexShrink: 0 }} />
              <span style={{ fontSize: '0.8rem', color: '#334155' }}>Agregá tus tarjetas para ver próximos vencimientos.</span>
              <button onClick={() => navigate('/personal/tarjetas')} style={{ marginLeft: 'auto', fontSize: '0.72rem', padding: '0.25rem 0.625rem', background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.2)', borderRadius: '0.5rem', color: '#818cf8', cursor: 'pointer', flexShrink: 0, minHeight: 32 }}>
                + Agregar
              </button>
            </div>
          </Card>
        ) : (
          <Card>
            <div data-testid="personal-dashboard-card-statement" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.875rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div>
                <div style={{ fontSize: '0.7rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Próximo resumen</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 900, color: '#818cf8', fontFamily: 'monospace', marginTop: '0.1rem' }}>{fmtMoney(totalCardsThisMonth)}</div>
              </div>
              {nextCardDue && (
                <div data-testid="personal-dashboard-card-next-due" style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.7rem', color: '#475569' }}>Próx. vencimiento</div>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#f0f4ff', marginTop: '0.1rem' }}>
                    {nextCardDue.card.name}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: '#475569' }}>
                    {nextCardDue.date.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}
                  </div>
                </div>
              )}
            </div>
            {totalFutureInstallments > 0 && (
              <div data-testid="personal-dashboard-card-future-installments" style={{ padding: '0.625rem 1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.775rem', color: '#475569' }}>Cuotas futuras</span>
                <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.875rem', color: '#fbbf24' }}>{fmtMoneyCompact(totalFutureInstallments)}</span>
              </div>
            )}
          </Card>
        )}
      </div>

      {/* ── Accounts ── */}
      <div>
        <SectionHeader
          title="Mis cuentas"
          action={<button onClick={() => navigate('/personal/cuentas')} style={{ fontSize: '0.72rem', color: '#34d399', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Ver todas</button>}
        />
        {loading ? <SkeletonCard rows={2} /> : accounts.length === 0 ? (
          <EmptyPersonal icon={<Wallet size={22} />} title="Sin cuentas aún" description="Creá tu primera cuenta personal para empezar." cta="Crear cuenta" onCta={() => navigate('/personal/cuentas')} />
        ) : (
          <Card>
            {accounts.slice(0, 4).map((acc, i) => (
              <div key={acc.id} style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.875rem 1rem', borderBottom: i < Math.min(accounts.length, 4) - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                <div style={{ width: 36, height: 36, borderRadius: '0.75rem', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Wallet size={15} color="#818cf8" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: '#f0f4ff', fontSize: '0.875rem' }}>{acc.name}</div>
                  <div style={{ fontSize: '0.7rem', color: '#334155', marginTop: '0.1rem', textTransform: 'capitalize' }}>{acc.type}</div>
                </div>
                <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9375rem', color: Number(acc.current_balance) >= 0 ? '#34d399' : '#f87171' }}>
                  {fmtMoney(acc.current_balance)}
                </div>
              </div>
            ))}
          </Card>
        )}
      </div>

      {/* ── Recent transactions ── */}
      <div>
        <SectionHeader
          title="Últimos movimientos"
          action={<button onClick={() => navigate('/personal/movimientos')} style={{ fontSize: '0.72rem', color: '#34d399', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Ver todos</button>}
        />
        {loading ? <SkeletonCard rows={4} /> : recentTx.length === 0 ? (
          <EmptyPersonal
            icon={<ArrowDownUp size={22} />}
            title="Sin movimientos aún"
            description="Cargá tu primer ingreso o gasto para ver el historial."
            cta="Cargar movimiento"
            onCta={() => navigate('/personal/movimientos/nuevo')}
          />
        ) : (
          <Card>
            <div data-testid="personal-recent-transactions">
              {recentTx.map(tx => (
                <TxRow
                  testId="personal-movement-row"
                  key={tx.id}
                  label={tx.description}
                  sub={`${new Date(tx.date + 'T12:00:00').toLocaleDateString('es-AR')} · ${(tx.account as any)?.name ?? ''}`}
                  amount={Number(tx.amount)}
                  type={tx.type as 'income' | 'expense' | 'transfer'}
                  onClick={() => navigate('/personal/movimientos')}
                />
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* ── Salary shortcut ── */}
      <button
        onClick={() => navigate('/personal/sueldo')}
        style={{ width: '100%', padding: '1rem', borderRadius: '1rem', background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.2)', color: '#818cf8', display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer', textAlign: 'left' }}
      >
        <div style={{ width: 36, height: 36, borderRadius: '0.75rem', background: 'rgba(129,140,248,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Building2 size={16} color="#818cf8" />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>Pagarme sueldo o retiro</div>
          <div style={{ fontSize: '0.72rem', color: '#475569', marginTop: '0.1rem' }}>Transferir desde el negocio a mi bolsillo</div>
        </div>
      </button>
    </PageContainer>
  )
}
