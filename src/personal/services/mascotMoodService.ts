import type { BudgetSummary } from './budgetService'
import type { DebtSummary } from './debtService'
import type { PersonalInsight } from './insightService'

export type MascotMood =
  | 'calm'
  | 'happy'
  | 'proud'
  | 'motivated'
  | 'worried'
  | 'alert'
  | 'celebrating'
  | 'thinking'
  | 'tired'

export interface MoodInput {
  loading: boolean
  summary: { totalIncome: number; totalExpense: number; balance: number }
  projResult: number
  budgetSummary: BudgetSummary | null
  debtSummary: DebtSummary | null
  insights: PersonalInsight[]
}

export interface MoodResult {
  mood: MascotMood
  message: string
  detail: string | null
}

function daysUntil(dateStr: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(dateStr + 'T12:00:00')
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

export function calculateMood(input: MoodInput): MoodResult {
  const { loading, summary, projResult, budgetSummary, debtSummary, insights } = input

  if (loading) {
    return { mood: 'thinking', message: 'Cargando tu resumen...', detail: null }
  }

  const hasData = summary.totalIncome > 0 || summary.totalExpense > 0
  if (!hasData) {
    return {
      mood: 'thinking',
      message: 'Cargá ingresos o gastos para ver tu situación.',
      detail: null,
    }
  }

  const hasDangerInsight = insights.some(i => i.severity === 'danger')
  const hasWarningInsight = insights.some(i => i.severity === 'warning')
  const budgetExceeded = (budgetSummary?.exceedCount ?? 0) > 0
  const budgetWarning = (budgetSummary?.warningCount ?? 0) > 0
  const budgetUsagePct =
    budgetSummary && budgetSummary.totalBudgeted > 0
      ? budgetSummary.totalSpent / budgetSummary.totalBudgeted
      : 0
  const debtDueSoon =
    debtSummary?.nextDueDate ? daysUntil(debtSummary.nextDueDate) <= 5 : false

  // alert — projection significantly negative or critical insight
  if (
    hasDangerInsight ||
    (projResult < 0 && summary.totalIncome > 0 && Math.abs(projResult) > summary.totalIncome * 0.4)
  ) {
    return {
      mood: 'alert',
      message: 'Los compromisos superan el balance del mes.',
      detail: 'Revisá proyecciones.',
    }
  }

  // worried — any warning sign
  if (budgetExceeded || projResult < 0 || debtDueSoon || hasWarningInsight) {
    if (budgetExceeded) {
      const n = budgetSummary!.exceedCount
      return {
        mood: 'worried',
        message:
          n === 1
            ? 'Un presupuesto está excedido.'
            : `${n} presupuestos excedidos este mes.`,
        detail: 'Revisá tus categorías.',
      }
    }
    if (projResult < 0) {
      return {
        mood: 'worried',
        message: 'La proyección del mes cierra en negativo.',
        detail: 'Revisá tarjetas y deudas.',
      }
    }
    if (debtDueSoon) {
      return {
        mood: 'worried',
        message: 'Tenés un vencimiento en los próximos días.',
        detail: 'Revisá deudas.',
      }
    }
    return {
      mood: 'worried',
      message: 'Hay un aviso pendiente de revisar.',
      detail: null,
    }
  }

  // celebrating — exceptional month: expenses well below income
  const isGreatMonth =
    summary.balance > 0 &&
    projResult > 0 &&
    summary.totalIncome > 0 &&
    summary.totalExpense < summary.totalIncome * 0.55

  if (isGreatMonth) {
    return {
      mood: 'celebrating',
      message: '¡Mes muy bueno! El saldo está excelente.',
      detail: null,
    }
  }

  // motivated — budgets active, on track, projection positive
  const hasBudgets = (budgetSummary?.totalBudgeted ?? 0) > 0
  if (projResult > 0 && hasBudgets && !budgetWarning && budgetUsagePct < 0.85) {
    return {
      mood: 'motivated',
      message: 'Vas dentro del presupuesto. ¡Seguí así!',
      detail: null,
    }
  }

  // happy — positive projection, balance ok
  if (projResult > 0 && summary.balance >= 0) {
    return {
      mood: 'happy',
      message: 'El mes va bien. Todo en orden.',
      detail: null,
    }
  }

  // tired — lots of expense activity but still manageable
  if (summary.totalExpense > summary.totalIncome * 0.8 && summary.balance >= 0) {
    return {
      mood: 'tired',
      message: 'Mes con mucho movimiento. Todo registrado.',
      detail: null,
    }
  }

  return {
    mood: 'calm',
    message: 'Sin novedades. Todo tranquilo.',
    detail: null,
  }
}
