import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  TrendingUp, TrendingDown, ArrowDownUp, Building2,
  CreditCard, Target, AlertCircle, Wallet, Eye, EyeOff, RepeatIcon, ChevronRight,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { personalService, type PersonalAccount, type PersonalTransaction, type PersonalCategory } from '../services/personalService'
import { creditCardService } from '../services/creditCardService'
import { getAllCardsStatementTotal, getNextDueDate } from '../utils/creditCards'
import { debtService, type DebtSummary } from '../services/debtService'
import {
  TxRow, EmptyPersonal, SkeletonCard, PageContainer, Card, fmtMoney, fmtMoneyCompact,
} from '../components/ui'
import { TransactionForm } from '../components/TransactionForm'

const HIDE_KEY = 'miGuitaHideAmounts'
const MASK     = '••••••'

const currentMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function PersonalDashboard() {
  const { user } = useAuth()
  const navigate  = useNavigate()

  const [loading,    setLoading]    = useState(true)
  const [accounts,   setAccounts]   = useState<PersonalAccount[]>([])
  const [recentTx,   setRecentTx]   = useState<PersonalTransaction[]>([])
  const [categories, setCategories] = useState<PersonalCategory[]>([])
  const [summary,    setSummary]    = useState({ totalIncome: 0, totalExpense: 0, balance: 0, available: 0, availableARS: 0, availableUSD: 0 })
  const [cardTotalThisMonth, setCardTotalThisMonth] = useState(0)
  const [nextCardDueText, setNextCardDueText] = useState<string | null>(null)
  const [debtSummary, setDebtSummary] = useState<DebtSummary | null>(null)

  // Privacy toggle — persisted in localStorage
  const [hidden, setHidden] = useState(() => localStorage.getItem(HIDE_KEY) === 'true')
  const toggleHidden = () => {
    const next = !hidden
    setHidden(next)
    localStorage.setItem(HIDE_KEY, String(next))
  }

  // Quick-action sheet state
  const [quickType, setQuickType] = useState<'income' | 'expense' | null>(null)

  const load = async () => {
    if (!user) return
    setLoading(true)
    try {
      await personalService.ensureDefaultCategories(user.id)
      const [accts, txs, sum, cats, ccards, cpurchases, debts] = await Promise.all([
        personalService.getAccounts(user.id),
        personalService.getTransactions(user.id, { limit: 4 }),
        personalService.getMonthlySummary(user.id, currentMonth()),
        personalService.getCategories(user.id),
        creditCardService.getCreditCards(user.id),
        creditCardService.getCardPurchases(user.id),
        debtService.getDebts(user.id),
      ])
      setAccounts(accts)
      setRecentTx(txs)
      setSummary(sum)
      setCategories(cats)
      setCardTotalThisMonth(getAllCardsStatementTotal(cpurchases, currentMonth()))
      setDebtSummary(debtService.getDebtSummary(debts))
      const activeCC = ccards.filter(c => c.is_active)
      if (activeCC.length > 0) {
        const earliest = activeCC
          .map(c => ({ name: c.name, date: getNextDueDate(c) }))
          .sort((a, b) => a.date.getTime() - b.date.getTime())[0]
        if (earliest) {
          setNextCardDueText(
            `${earliest.name} · vence ${earliest.date.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}`
          )
        }
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const availableARS = summary.availableARS ?? summary.available
  const availableUSD = summary.availableUSD ?? 0

  // Amount display helpers
  const amt     = (n: number, cur = 'ARS') => hidden ? MASK : fmtMoney(n, cur)
  const amtComp = (n: number)              => hidden ? MASK : fmtMoneyCompact(n)

  // Module access chips
  const modules = [
    { label: 'Cuentas',      path: '/personal/cuentas',      Icon: Wallet,       color: '#34d399', bg: 'rgba(52,211,153,0.1)'  },
    { label: 'Movimientos',  path: '/personal/movimientos',  Icon: ArrowDownUp,  color: '#60a5fa', bg: 'rgba(96,165,250,0.1)'  },
    { label: 'Ahorros',      path: '/personal/ahorros',      Icon: Target,       color: '#fbbf24', bg: 'rgba(251,191,36,0.1)'  },
    { label: 'Tarjetas',     path: '/personal/tarjetas',     Icon: CreditCard,   color: '#818cf8', bg: 'rgba(129,140,248,0.1)' },
    { label: 'Deudas',       path: '/personal/deudas',       Icon: AlertCircle,  color: '#f87171', bg: 'rgba(248,113,113,0.1)' },
    { label: 'Gastos fijos', path: '/personal/gastos-fijos', Icon: RepeatIcon,   color: '#fbbf24', bg: 'rgba(251,191,36,0.1)'  },
    { label: 'Sueldo',       path: '/personal/sueldo',       Icon: Building2,    color: '#a78bfa', bg: 'rgba(167,139,250,0.1)' },
  ]

  return (
    <PageContainer testId="personal-dashboard">

      {/* ── Greeting ── */}
      <div style={{ padding: '0.25rem 0' }}>
        <div style={{ fontSize: '0.72rem', color: '#334155', fontWeight: 600 }}>
          {new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
      </div>

      {/* ── Balance card ── */}
      <div
        data-testid="personal-balance-card"
        style={{ background: 'linear-gradient(135deg, rgba(52,211,153,0.12), rgba(16,185,129,0.06))', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '1.25rem', padding: '1.25rem' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#059669', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            Dinero disponible
          </span>
          <button
            data-testid="personal-toggle-hide"
            onClick={toggleHidden}
            aria-label={hidden ? 'Mostrar importes' : 'Ocultar importes'}
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '99px', padding: '0.25rem 0.625rem', cursor: 'pointer', color: '#34d399', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.72rem', fontWeight: 600 }}
          >
            {hidden ? <Eye size={13} /> : <EyeOff size={13} />}
            {hidden ? 'Mostrar' : 'Ocultar'}
          </button>
        </div>

        {loading ? (
          <div style={{ height: 44, width: '55%', borderRadius: 8, background: 'rgba(52,211,153,0.1)', marginBottom: '0.5rem' }} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.875rem', flexWrap: 'wrap' }}>
            <div data-testid="personal-balance-ars"
              style={{ fontSize: '2.5rem', fontWeight: 900, color: availableARS >= 0 ? '#34d399' : '#f87171', letterSpacing: '-0.04em', lineHeight: 1, fontFamily: 'monospace' }}>
              {amt(availableARS)}
            </div>
            {availableUSD > 0 && (
              <div data-testid="personal-balance-usd"
                style={{ fontSize: '1.25rem', fontWeight: 800, color: '#4ade80', letterSpacing: '-0.03em', lineHeight: 1, fontFamily: 'monospace' }}>
                + {amt(availableUSD, 'USD')}
              </div>
            )}
          </div>
        )}
        <div style={{ fontSize: '0.72rem', color: '#047857', marginTop: '0.375rem' }}>
          en {accounts.length} cuenta{accounts.length !== 1 ? 's' : ''} activa{accounts.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* ── Quick actions ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.625rem' }}>
        <button
          data-testid="personal-quick-income"
          onClick={() => setQuickType('income')}
          style={{ padding: '1rem', borderRadius: '1rem', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)', color: '#34d399', fontWeight: 800, fontSize: '0.9375rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', minHeight: 56 }}
        >
          <TrendingUp size={18} /> Ingreso
        </button>
        <button
          data-testid="personal-quick-expense"
          onClick={() => setQuickType('expense')}
          style={{ padding: '1rem', borderRadius: '1rem', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontWeight: 800, fontSize: '0.9375rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', minHeight: 56 }}
        >
          <TrendingDown size={18} /> Gasto
        </button>
      </div>

      {/* ── Month summary ── */}
      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '1rem', padding: '0.875rem 1rem' }}>
        <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.625rem' }}>
          Este mes
        </div>
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
            {[1,2,3].map(i => <div key={i} style={{ height: 36, borderRadius: 6, background: 'rgba(255,255,255,0.04)' }} />)}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
            {[
              { label: 'Ingresos', value: amtComp(summary.totalIncome),  color: '#34d399', testId: 'personal-income-card'       },
              { label: 'Gastos',   value: amtComp(summary.totalExpense), color: '#f87171', testId: 'personal-expense-card'      },
              { label: 'Balance',  value: amtComp(summary.balance),      color: summary.balance >= 0 ? '#818cf8' : '#f87171', testId: 'personal-month-balance-card' },
            ].map(s => (
              <div key={s.label} data-testid={s.testId} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.62rem', color: '#334155', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.2rem' }}>{s.label}</div>
                <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9rem', color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Credit cards widget ── */}
      <div
        data-testid="personal-cards-widget"
        onClick={() => navigate('/personal/tarjetas')}
        style={{ background: 'rgba(129,140,248,0.06)', border: '1px solid rgba(129,140,248,0.18)', borderRadius: '1rem', padding: '0.875rem 1rem', cursor: 'pointer' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <CreditCard size={14} color="#818cf8" />
            <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Tarjetas</span>
          </div>
          <ChevronRight size={14} color="#334155" />
        </div>
        {loading ? (
          <div style={{ height: 24, width: '40%', borderRadius: 4, background: 'rgba(129,140,248,0.1)', marginTop: '0.375rem' }} />
        ) : (
          <div style={{ marginTop: '0.375rem', display: 'flex', alignItems: 'baseline', gap: '0.625rem', flexWrap: 'wrap' }}>
            <div data-testid="personal-cards-widget-total" style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '1.125rem', color: '#818cf8' }}>
              {amtComp(cardTotalThisMonth)}
            </div>
            {nextCardDueText && (
              <div style={{ fontSize: '0.68rem', color: '#475569' }}>{nextCardDueText}</div>
            )}
          </div>
        )}
      </div>

      {/* ── Debts widget ── */}
      <div
        data-testid="personal-debts-widget"
        onClick={() => navigate('/personal/deudas')}
        style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.18)', borderRadius: '1rem', padding: '0.875rem 1rem', cursor: 'pointer' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <AlertCircle size={14} color="#f87171" />
            <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Deudas</span>
          </div>
          <ChevronRight size={14} color="#334155" />
        </div>
        {loading ? (
          <div style={{ height: 24, width: '40%', borderRadius: 4, background: 'rgba(248,113,113,0.1)', marginTop: '0.375rem' }} />
        ) : !debtSummary || debtSummary.activeCount === 0 ? (
          <div style={{ marginTop: '0.375rem', fontSize: '0.75rem', color: '#334155' }}>Sin deudas activas</div>
        ) : (
          <div style={{ marginTop: '0.5rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            {(debtSummary.totalOwed > 0 || debtSummary.totalOwedUSD > 0) && (
              <div>
                <div style={{ fontSize: '0.62rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.15rem' }}>Yo debo</div>
                <div data-testid="personal-debts-widget-owed" style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9375rem', color: '#f87171' }}>
                  {debtSummary.totalOwed > 0 ? (hidden ? MASK : fmtMoneyCompact(debtSummary.totalOwed)) : (hidden ? MASK : fmtMoneyCompact(debtSummary.totalOwedUSD) + ' USD')}
                </div>
              </div>
            )}
            {(debtSummary.totalReceivable > 0 || debtSummary.totalReceivableUSD > 0) && (
              <div>
                <div style={{ fontSize: '0.62rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.15rem' }}>Me deben</div>
                <div data-testid="personal-debts-widget-receivable" style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9375rem', color: '#34d399' }}>
                  {debtSummary.totalReceivable > 0 ? (hidden ? MASK : fmtMoneyCompact(debtSummary.totalReceivable)) : (hidden ? MASK : fmtMoneyCompact(debtSummary.totalReceivableUSD) + ' USD')}
                </div>
              </div>
            )}
            {debtSummary.nextDueDate && (
              <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                <div style={{ fontSize: '0.62rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.15rem' }}>Próx. venc.</div>
                <div style={{ fontSize: '0.75rem', color: '#fbbf24', fontWeight: 700 }}>
                  {new Date(debtSummary.nextDueDate + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Recent transactions ── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Últimos movimientos</span>
          <button onClick={() => navigate('/personal/movimientos')} style={{ fontSize: '0.72rem', color: '#34d399', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Ver todos</button>
        </div>
        {loading ? (
          <SkeletonCard rows={3} />
        ) : recentTx.length === 0 ? (
          <EmptyPersonal
            icon={<ArrowDownUp size={20} />}
            title="Sin movimientos aún"
            description="Cargá tu primer ingreso o gasto."
            cta="Cargar"
            onCta={() => setQuickType('expense')}
          />
        ) : (
          <Card>
            <div data-testid="personal-recent-transactions">
              {recentTx.map(tx => (
                <TxRow
                  testId="personal-movement-row"
                  key={tx.id}
                  label={hidden ? '••••••' : tx.description}
                  sub={`${new Date(tx.date + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })} · ${(tx.account as any)?.name ?? ''}`}
                  amount={hidden ? 0 : Number(tx.amount)}
                  type={tx.type as 'income' | 'expense' | 'transfer'}
                  onClick={() => navigate('/personal/movimientos')}
                />
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* ── Module chips ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
        {modules.map(({ label, path, Icon, color, bg }) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            style={{ padding: '0.75rem 0.5rem', borderRadius: '0.875rem', background: bg, border: `1px solid ${color}25`, color, fontWeight: 700, fontSize: '0.72rem', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.375rem', minHeight: 60 }}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      {/* ── Quick transaction form ── */}
      {quickType && (
        <TransactionForm
          accounts={accounts}
          categories={categories}
          defaultType={quickType}
          title={quickType === 'income' ? 'Ingreso rápido' : 'Gasto rápido'}
          onSaved={() => { setQuickType(null); void load() }}
          onClose={() => setQuickType(null)}
        />
      )}

    </PageContainer>
  )
}
