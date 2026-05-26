import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft, ChevronRight, Eye, EyeOff, TrendingUp, TrendingDown,
  CreditCard, RepeatIcon, AlertCircle, BarChart3, Check,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { personalService } from '../services/personalService'
import { creditCardService } from '../services/creditCardService'
import { recurringExpenseService } from '../services/recurringExpenseService'
import { debtService } from '../services/debtService'
import { buildProjection, type MonthlyProjection, type ProjectionCommitment } from '../services/projectionService'
import { currentYearMonth, addMonths, formatYearMonth } from '../utils/creditCards'
import {
  PageContainer, Card, fmtMoney, fmtMoneyCompact, EmptyPersonal, PersonalLoading,
} from '../components/ui'

const HIDE_KEY = 'miGuitaHideAmounts'
const MASK     = '••••'

// ── Month selector ──────────────────────────────────────────────────────────────

function MonthSelector({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const now = currentYearMonth()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'center' }}>
      <button
        onClick={() => onChange(addMonths(month, -1))}
        style={{ width: 36, height: 36, borderRadius: '0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#475569' }}
      >
        <ChevronLeft size={18} />
      </button>
      <span
        data-testid="personal-projections-month-label"
        style={{ fontSize: '1rem', fontWeight: 700, color: '#f0f4ff', minWidth: 160, textAlign: 'center' }}
      >
        {formatYearMonth(month)}
        {month === now && (
          <span style={{ fontSize: '0.65rem', color: '#34d399', marginLeft: '0.375rem', fontWeight: 600, verticalAlign: 'middle' }}>
            (este mes)
          </span>
        )}
      </span>
      <button
        data-testid="personal-projections-month-next"
        onClick={() => onChange(addMonths(month, 1))}
        style={{ width: 36, height: 36, borderRadius: '0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#475569' }}
      >
        <ChevronRight size={18} />
      </button>
    </div>
  )
}

// ── Summary cards ───────────────────────────────────────────────────────────────

function SummaryGrid({ proj, hidden }: { proj: MonthlyProjection; hidden: boolean }) {
  const h = (n: number) => hidden ? MASK : fmtMoneyCompact(n)

  const items = [
    {
      label: 'Ingresos',
      value: h(proj.incomeConfirmed),
      color: '#34d399',
      testId: 'personal-projections-income',
    },
    {
      label: 'Gastos confirm.',
      value: h(proj.expensesConfirmed),
      color: '#f87171',
      testId: 'personal-projections-expenses',
    },
    {
      label: 'Compromisos',
      value: h(proj.totalCommitments),
      color: '#fbbf24',
      testId: 'personal-projections-commitments',
    },
    {
      label: 'Libre estimado',
      value: hidden ? MASK : (proj.estimatedResult >= 0 ? '+' : '') + fmtMoneyCompact(proj.estimatedResult),
      color: proj.estimatedResult >= 0 ? '#818cf8' : '#f87171',
      testId: 'personal-projections-result',
    },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
      {items.map(item => (
        <div key={item.label} data-testid={item.testId}
          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '1rem', padding: '0.875rem' }}
        >
          <div style={{ fontSize: '0.62rem', color: '#334155', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>
            {item.label}
          </div>
          <div style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '1.125rem', color: item.color, lineHeight: 1 }}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Distribution bar ─────────────────────────────────────────────────────────────

function DistributionBar({ proj }: { proj: MonthlyProjection }) {
  const base = Math.max(
    proj.incomeConfirmed,
    proj.expensesConfirmed + proj.totalCommitments,
    1
  )

  const segments = [
    { key: 'exp',   value: proj.expensesConfirmed, color: '#f87171', label: 'Gastos' },
    { key: 'cards', value: proj.cardsPending,       color: '#818cf8', label: 'Tarjetas' },
    { key: 'rec',   value: proj.recurringPending,   color: '#fbbf24', label: 'Fijos' },
    { key: 'debt',  value: proj.debtInstallments,   color: '#fb923c', label: 'Deudas' },
  ].filter(s => s.value > 0)

  const usedTotal = segments.reduce((s, seg) => s + seg.value, 0)
  const freeValue = Math.max(0, proj.incomeConfirmed - usedTotal)
  const allSegs   = freeValue > 0
    ? [...segments, { key: 'free', value: freeValue, color: '#34d399', label: 'Libre' }]
    : segments

  if (allSegs.length === 0) return null

  return (
    <div>
      <div style={{ display: 'flex', height: 10, borderRadius: 99, overflow: 'hidden', gap: 2, marginBottom: '0.5rem' }}>
        {allSegs.map(seg => (
          <div key={seg.key} style={{ flex: seg.value / base, background: seg.color, minWidth: 4 }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        {allSegs.map(seg => (
          <div key={seg.key} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: seg.color, flexShrink: 0 }} />
            <span style={{ fontSize: '0.65rem', color: '#475569', fontWeight: 500 }}>{seg.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Alert banner ─────────────────────────────────────────────────────────────────

function AlertBanner({ proj }: { proj: MonthlyProjection }) {
  if (proj.alerts.length === 0) return null
  const topAlert = proj.alerts[0]
  const bg    = topAlert.level === 'danger'  ? 'rgba(248,113,113,0.08)' : 'rgba(251,191,36,0.06)'
  const border = topAlert.level === 'danger' ? 'rgba(248,113,113,0.25)' : 'rgba(251,191,36,0.2)'
  const color  = topAlert.level === 'danger' ? '#f87171' : '#fbbf24'

  return (
    <div data-testid="personal-projections-alert"
      style={{ padding: '0.625rem 0.875rem', background: bg, border: `1px solid ${border}`, borderRadius: '0.75rem', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}
    >
      <AlertCircle size={13} color={color} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
        {proj.alerts.map((a, i) => (
          <span key={i} style={{ fontSize: '0.78rem', color, fontWeight: 600 }}>{a.message}</span>
        ))}
      </div>
    </div>
  )
}

// ── Breakdown section ─────────────────────────────────────────────────────────────

function BreakdownRow({ label, total, paid, pending, color, Icon, testId }: {
  label: string; total: number; paid: number; pending: number
  color: string; Icon: React.ElementType; testId: string
}) {
  if (total <= 0) return null
  return (
    <div data-testid={testId} style={{ padding: '0.75rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.375rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Icon size={13} color={color} />
          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#c8d4e8' }}>{label}</span>
        </div>
        <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9rem', color }}>{fmtMoneyCompact(total)}</span>
      </div>
      <div style={{ display: 'flex', gap: '1rem' }}>
        {paid > 0 && (
          <span style={{ fontSize: '0.68rem', color: '#34d399' }}>
            ✓ Pagado {fmtMoneyCompact(paid)}
          </span>
        )}
        {pending > 0 && (
          <span style={{ fontSize: '0.68rem', color: '#fbbf24' }}>
            ⏳ Pendiente {fmtMoneyCompact(pending)}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Commitment item ───────────────────────────────────────────────────────────────

function CommitmentItem({ c, hidden }: { c: ProjectionCommitment; hidden: boolean }) {
  const typeIcon = { card: CreditCard, debt: AlertCircle, recurring: RepeatIcon }[c.type]
  const Icon = typeIcon
  const typeColor = { card: '#818cf8', debt: '#f87171', recurring: '#fbbf24' }[c.type]

  return (
    <div data-testid="personal-projection-commitment-item"
      style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
    >
      <div style={{ width: 32, height: 32, borderRadius: '0.625rem', background: `${typeColor}12`, border: `1px solid ${typeColor}25`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={14} color={typeColor} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#f0f4ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.name}
          </span>
          {c.isOverdue && (
            <span style={{ fontSize: '0.6rem', color: '#f87171', background: 'rgba(248,113,113,0.1)', borderRadius: 99, padding: '0.1rem 0.35rem', flexShrink: 0 }}>Vencido</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.1rem' }}>
          {c.detail && <span style={{ fontSize: '0.68rem', color: '#334155' }}>{c.detail}</span>}
          {c.dueDate && (
            <span style={{ fontSize: '0.68rem', color: c.isOverdue ? '#f87171' : '#334155' }}>
              {new Date(c.dueDate + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}
            </span>
          )}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.875rem', color: c.isPaid ? '#34d399' : typeColor }}>
          {hidden ? MASK : fmtMoney(c.amount, c.currency)}
        </div>
        {c.isPaid && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', justifyContent: 'flex-end', marginTop: '0.1rem' }}>
            <Check size={10} color="#34d399" />
            <span style={{ fontSize: '0.6rem', color: '#34d399' }}>Pagado</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────────

export function PersonalProjections() {
  const { user }  = useAuth()
  const navigate  = useNavigate()
  const [loading,    setLoading]    = useState(true)
  const [month,      setMonth]      = useState(currentYearMonth())
  const [projection, setProjection] = useState<MonthlyProjection | null>(null)
  const [hidden,     setHidden]     = useState(() => localStorage.getItem(HIDE_KEY) === 'true')

  const toggleHidden = () => {
    const next = !hidden
    setHidden(next)
    localStorage.setItem(HIDE_KEY, String(next))
  }

  const load = async (m: string) => {
    if (!user) return
    setLoading(true)
    try {
      const [year, monthNum] = m.split('-').map(Number)
      const [summary, cards, purchases, cardPmts, recurring, recurringPmts, debts] = await Promise.all([
        personalService.getMonthlySummary(user.id, m),
        creditCardService.getCreditCards(user.id),
        creditCardService.getCardPurchases(user.id),
        creditCardService.getCardPayments(user.id),
        recurringExpenseService.getRecurringExpenses(user.id),
        recurringExpenseService.getPaymentsForMonth(user.id, year, monthNum),
        debtService.getDebts(user.id),
      ])
      setProjection(buildProjection(m, summary, cards, purchases, cardPmts, recurring, recurringPmts, debts))
    } catch {
      setProjection(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load(month) }, [user, month]) // eslint-disable-line react-hooks/exhaustive-deps

  const h = (n: number, cur = 'ARS') => hidden ? MASK : fmtMoney(n, cur)

  return (
    <PageContainer testId="personal-projections-page">

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff' }}>Proyecciones</span>
        <button
          data-testid="personal-projections-toggle-hide"
          onClick={toggleHidden}
          aria-label={hidden ? 'Mostrar importes' : 'Ocultar importes'}
          style={{ width: 32, height: 32, borderRadius: '0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#475569' }}
        >
          {hidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
      </div>

      {/* ── Month selector ── */}
      <MonthSelector month={month} onChange={m => setMonth(m)} />

      {loading ? (
        <PersonalLoading />
      ) : !projection ? (
        <EmptyPersonal
          testId="personal-projections-empty"
          icon={<BarChart3 size={22} />}
          title="No se pudo calcular la proyección"
          description="Intentá de nuevo en unos segundos."
          cta="Reintentar"
          onCta={() => void load(month)}
        />
      ) : !projection.hasData ? (
        <EmptyPersonal
          testId="personal-projections-empty"
          icon={<BarChart3 size={22} />}
          title="Todavía no hay datos suficientes"
          description="Registrá movimientos, tarjetas o deudas para ver cómo viene tu mes."
          cta="Ir al inicio"
          onCta={() => navigate('/personal')}
        />
      ) : (
        <>
          {/* ── Summary cards ── */}
          <SummaryGrid proj={projection} hidden={hidden} />

          {/* ── Alert banner ── */}
          <AlertBanner proj={projection} />

          {/* ── Smart message ── */}
          <div
            data-testid="personal-projections-smart-message"
            style={{ padding: '0.75rem 1rem', background: projection.estimatedResult >= 0 ? 'rgba(52,211,153,0.06)' : 'rgba(248,113,113,0.06)', border: `1px solid ${projection.estimatedResult >= 0 ? 'rgba(52,211,153,0.18)' : 'rgba(248,113,113,0.18)'}`, borderRadius: '0.875rem', fontSize: '0.85rem', color: projection.estimatedResult >= 0 ? '#34d399' : '#f87171', fontWeight: 600, lineHeight: 1.4 }}
          >
            {projection.smartMessage}
          </div>

          {/* ── Distribution bar ── */}
          {(projection.expensesConfirmed > 0 || projection.totalCommitments > 0) && (
            <Card>
              <div style={{ padding: '0.875rem 1rem' }}>
                <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.625rem' }}>
                  Distribución del mes
                </div>
                <DistributionBar proj={projection} />
              </div>
            </Card>
          )}

          {/* ── Breakdown by type ── */}
          <Card>
            <div style={{ padding: '0.875rem 1rem' }}>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.25rem' }}>
                Desglose
              </div>
              <BreakdownRow
                testId="personal-projections-breakdown-income"
                label="Ingresos"
                total={projection.incomeConfirmed}
                paid={projection.incomeConfirmed}
                pending={0}
                color="#34d399"
                Icon={TrendingUp}
              />
              <BreakdownRow
                testId="personal-projections-breakdown-expenses"
                label="Gastos confirmados"
                total={projection.expensesConfirmed}
                paid={projection.expensesConfirmed}
                pending={0}
                color="#f87171"
                Icon={TrendingDown}
              />
              <BreakdownRow
                testId="personal-projections-breakdown-cards"
                label="Tarjetas"
                total={projection.cardsTotal}
                paid={projection.cardsPaid}
                pending={projection.cardsPending}
                color="#818cf8"
                Icon={CreditCard}
              />
              <BreakdownRow
                testId="personal-projections-breakdown-recurring"
                label="Gastos fijos"
                total={projection.recurringTotal}
                paid={projection.recurringPaid}
                pending={projection.recurringPending}
                color="#fbbf24"
                Icon={RepeatIcon}
              />
              <BreakdownRow
                testId="personal-projections-breakdown-debts"
                label="Cuotas de deudas"
                total={projection.debtInstallments}
                paid={0}
                pending={projection.debtInstallments}
                color="#fb923c"
                Icon={AlertCircle}
              />
            </div>
          </Card>

          {/* ── Commitments list ── */}
          {projection.commitments.length > 0 && (
            <Card>
              <div style={{ padding: '0.875rem 1rem' }}>
                <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.25rem' }}>
                  Compromisos del mes
                </div>
                {projection.commitments.map(c => (
                  <CommitmentItem key={`${c.type}-${c.id}`} c={c} hidden={hidden} />
                ))}
              </div>
            </Card>
          )}

          {/* ── No commitments ── */}
          {projection.commitments.length === 0 && (
            <div style={{ textAlign: 'center', padding: '1.5rem', color: '#334155', fontSize: '0.85rem' }}>
              No tenés compromisos pendientes este mes.
            </div>
          )}

          {/* ── Result summary ── */}
          <div
            data-testid="personal-projections-result-card"
            style={{ background: projection.estimatedResult >= 0 ? 'rgba(129,140,248,0.06)' : 'rgba(248,113,113,0.06)', border: `1px solid ${projection.estimatedResult >= 0 ? 'rgba(129,140,248,0.18)' : 'rgba(248,113,113,0.18)'}`, borderRadius: '1.125rem', padding: '1.125rem' }}
          >
            <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
              Libre estimado {formatYearMonth(month)}
            </div>
            <div style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '2rem', color: projection.estimatedResult >= 0 ? '#818cf8' : '#f87171', letterSpacing: '-0.03em', lineHeight: 1 }}>
              {hidden ? MASK : (projection.estimatedResult >= 0 ? '+' : '') + fmtMoney(projection.estimatedResult)}
            </div>
            <div style={{ fontSize: '0.72rem', color: '#334155', marginTop: '0.375rem' }}>
              = {h(projection.incomeConfirmed)} ingresos − {h(projection.expensesConfirmed)} gastos − {h(projection.totalCommitments)} pendiente
            </div>
          </div>
        </>
      )}

    </PageContainer>
  )
}
