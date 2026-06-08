import type { MonthlyProjection } from './projectionService'
import type { PersonalInsight } from './insightService'

// ── Types ──────────────────────────────────────────────────────────────────────

export type MonthlyPlanStatus = 'healthy' | 'stable' | 'attention' | 'risk' | 'critical'

export interface MonthlyPlanInput {
  month: string
  projection: MonthlyProjection
  insights: PersonalInsight[]
}

export interface MonthlyPlanPriority {
  id: string
  label: string
  amount: number
  currency: string
  kind: 'overdue' | 'urgent' | 'upcoming' | 'paid'
  dueDate: string | null
  detail: string | null
}

export interface MonthlyPlanRecommendation {
  id: string
  text: string
  actionLabel?: string
  actionRoute?: string
}

export interface MonthlyPlanAvoidance {
  id: string
  text: string
}

export interface MonthlyPlanCommitment {
  id: string
  label: string
  amount: number
  currency: string
  dueDate: string | null
  isPaid: boolean
  isOverdue: boolean
  type: 'card' | 'debt' | 'recurring'
  detail: string | null
}

export interface MonthlyPlan {
  month: string
  status: MonthlyPlanStatus
  statusLabel: string
  statusColor: string
  spendableMargin: number
  totalIncome: number
  totalExpense: number
  totalCommitments: number
  estimatedResult: number
  priorities: MonthlyPlanPriority[]
  recommendations: MonthlyPlanRecommendation[]
  avoidances: MonthlyPlanAvoidance[]
  upcomingCommitments: MonthlyPlanCommitment[]
  hasData: boolean
}

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_META: Record<MonthlyPlanStatus, { label: string; color: string }> = {
  healthy:   { label: 'Saludable', color: '#34d399' },
  stable:    { label: 'Estable',   color: '#818cf8' },
  attention: { label: 'Atención',  color: '#fbbf24' },
  risk:      { label: 'Riesgo',    color: '#f97316' },
  critical:  { label: 'Crítico',   color: '#f87171' },
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function daysUntil(dateStr: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.ceil((new Date(dateStr + 'T12:00:00').getTime() - today.getTime()) / 86400000)
}

function computeStatus(proj: MonthlyProjection, insights: PersonalInsight[]): MonthlyPlanStatus {
  const hasDanger  = insights.some(i => i.severity === 'danger')
  const hasWarning = insights.some(i => i.severity === 'warning')
  const hasOverdue = proj.commitments.some(c => c.isOverdue)
  const budgetOver = insights.some(i => i.type === 'budget_exceeded')

  if (hasDanger || (proj.estimatedResult < 0 && proj.incomeConfirmed > 0 && Math.abs(proj.estimatedResult) > proj.incomeConfirmed * 0.4))
    return 'critical'
  if (proj.estimatedResult < 0 || hasOverdue)
    return 'risk'
  if (budgetOver || hasWarning)
    return 'attention'

  const isGreat = proj.estimatedResult > 0
    && proj.incomeConfirmed > 0
    && proj.expensesConfirmed < proj.incomeConfirmed * 0.55
  return isGreat ? 'healthy' : 'stable'
}

function buildPriorities(proj: MonthlyProjection): MonthlyPlanPriority[] {
  return proj.commitments
    .map((c): MonthlyPlanPriority => {
      let kind: MonthlyPlanPriority['kind'] = 'upcoming'
      if (c.isPaid) kind = 'paid'
      else if (c.isOverdue) kind = 'overdue'
      else if (c.dueDate && daysUntil(c.dueDate) <= 5) kind = 'urgent'
      return { id: c.id, label: c.name, amount: c.amount, currency: c.currency, kind, dueDate: c.dueDate, detail: c.detail }
    })
    .sort((a, b) => {
      const order = { overdue: 0, urgent: 1, upcoming: 2, paid: 3 }
      if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind]
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
      return b.amount - a.amount
    })
    .slice(0, 10)
}

function buildRecommendations(proj: MonthlyProjection, insights: PersonalInsight[], status: MonthlyPlanStatus): MonthlyPlanRecommendation[] {
  const recs: MonthlyPlanRecommendation[] = []

  const hasOverdue = proj.commitments.some(c => c.isOverdue && !c.isPaid)
  if (hasOverdue) {
    recs.push({ id: 'pay_overdue', text: 'Pagá los compromisos vencidos primero para evitar cargos adicionales.', actionLabel: 'Ver compromisos', actionRoute: '/personal/proyecciones' })
  }

  if (proj.cardsPending > 0 && proj.incomeConfirmed > 0 && proj.cardsPending > proj.incomeConfirmed * 0.25) {
    recs.push({ id: 'reserve_cards', text: `Reservá el importe de tus tarjetas pendientes antes de gastar en variables.`, actionLabel: 'Ver tarjetas', actionRoute: '/personal/tarjetas' })
  }

  if (proj.recurringPending > 0) {
    recs.push({ id: 'recurring', text: 'Tenés gastos fijos pendientes este mes. Priorizalos antes de gastos discrecionales.', actionLabel: 'Ver gastos fijos', actionRoute: '/personal/gastos-fijos' })
  }

  const budgetWarning = insights.find(i => i.type === 'budget_exceeded' || i.type === 'budget_warning')
  if (budgetWarning) {
    recs.push({ id: 'budget_warning', text: budgetWarning.hiddenMessage, actionLabel: 'Ver presupuestos', actionRoute: '/personal/presupuestos' })
  }

  if ((status === 'healthy' || status === 'stable') && proj.estimatedResult > 0) {
    recs.push({ id: 'save_surplus', text: 'El mes cierra con margen positivo. Es buen momento para separar una parte para ahorros.', actionLabel: 'Ver ahorros', actionRoute: '/personal/ahorros' })
  }

  if (recs.length === 0) {
    recs.push({ id: 'default', text: 'Seguí registrando movimientos para mejorar la precisión del diagnóstico.' })
  }

  return recs
}

function buildAvoidances(proj: MonthlyProjection, status: MonthlyPlanStatus): MonthlyPlanAvoidance[] {
  if (status === 'healthy') return []

  const avoidances: MonthlyPlanAvoidance[] = []

  if (status === 'critical' || status === 'risk') {
    avoidances.push({ id: 'no_new_debt', text: 'No tomar nuevas deudas ni adelantos hasta que la proyección vuelva a positivo.' })
    avoidances.push({ id: 'no_installments', text: 'Evitá compras en cuotas que agreguen compromisos fijos al próximo mes.' })
    avoidances.push({ id: 'no_unplanned', text: 'Evitá gastos grandes no planeados este mes.' })
  } else if (status === 'attention') {
    avoidances.push({ id: 'no_installments', text: 'Evitá sumar nuevas cuotas o financiaciones por ahora.' })
    if (proj.cardsPending > 0) {
      avoidances.push({ id: 'no_card_unplanned', text: 'Cuidado con gastos adicionales en tarjeta — ya tenés compromisos pendientes.' })
    }
  }

  return avoidances
}

// ── Main export ────────────────────────────────────────────────────────────────

export function buildMonthlyPlan(input: MonthlyPlanInput): MonthlyPlan {
  const { month, projection: proj, insights } = input

  if (!proj.hasData) {
    return {
      month, status: 'stable', statusLabel: 'Sin datos', statusColor: '#334155',
      spendableMargin: 0, totalIncome: 0, totalExpense: 0,
      totalCommitments: 0, estimatedResult: 0,
      priorities: [], recommendations: [], avoidances: [],
      upcomingCommitments: [], hasData: false,
    }
  }

  const status = computeStatus(proj, insights)
  const { label: statusLabel, color: statusColor } = STATUS_META[status]

  const upcomingCommitments: MonthlyPlanCommitment[] = proj.commitments.map(c => ({
    id: c.id, label: c.name, amount: c.amount, currency: c.currency,
    dueDate: c.dueDate, isPaid: c.isPaid, isOverdue: c.isOverdue,
    type: c.type, detail: c.detail,
  }))

  return {
    month,
    status,
    statusLabel,
    statusColor,
    spendableMargin: Math.max(0, proj.estimatedResult),
    totalIncome: proj.incomeConfirmed,
    totalExpense: proj.expensesConfirmed,
    totalCommitments: proj.totalCommitments,
    estimatedResult: proj.estimatedResult,
    priorities: buildPriorities(proj),
    recommendations: buildRecommendations(proj, insights, status),
    avoidances: buildAvoidances(proj, status),
    upcomingCommitments,
    hasData: true,
  }
}
