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
  cta: { label: string; route: string } | null
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
    return {
      mood: 'thinking',
      message: 'Cargando tu resumen...',
      detail: 'Ya casi estoy lista.',
      cta: null,
    }
  }

  const hasData = summary.totalIncome > 0 || summary.totalExpense > 0
  if (!hasData) {
    return {
      mood: 'thinking',
      message: 'Sumá algunos ingresos o gastos y arrancamos juntas.',
      detail: 'Con un poco más de contexto ya puedo acompañarte mejor.',
      cta: { label: 'Cargar movimiento', route: '/personal/movimientos' },
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
      message: 'Tu proyección viene bastante ajustada. Mejor lo miramos juntas ahora.',
      detail: 'Hay una alerta importante, pero la podemos trabajar.',
      cta: { label: 'Ver proyección', route: '/personal/proyecciones' },
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
            ? 'Ojo, se te está yendo el presupuesto en una categoría.'
            : `Ojo, se te está yendo el presupuesto en ${n} categorías.`,
        detail: 'No es grave, pero conviene revisarlo.',
        cta: { label: 'Revisar presupuesto', route: '/personal/presupuestos' },
      }
    }
    if (projResult < 0) {
      return {
        mood: 'worried',
        message: 'La proyección del mes no cerraría bien con los compromisos pendientes.',
        detail: 'Estamos a tiempo de ajustar.',
        cta: { label: 'Ver proyección', route: '/personal/proyecciones' },
      }
    }
    if (debtDueSoon) {
      return {
        mood: 'worried',
        message: 'Tenés un vencimiento muy cerca, no lo pierdas de vista.',
        detail: 'Revisá para quedar tranquila.',
        cta: { label: 'Ver deudas', route: '/personal/deudas' },
      }
    }
    return {
      mood: 'worried',
      message: 'Hay algunas cositas para mirar, pero estamos a tiempo.',
      detail: null,
      cta: null,
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
      message: '¡Esooo! Este mes viene buenísimo.',
      detail: 'Acá hay algo para festejar. Me encanta esta victoria.',
      cta: null,
    }
  }

  // motivated — budgets active, on track, projection positive
  const hasBudgets = (budgetSummary?.totalBudgeted ?? 0) > 0
  if (projResult > 0 && hasBudgets && !budgetWarning && budgetUsagePct < 0.85) {
    return {
      mood: 'motivated',
      message: 'Vas bien encaminada. Los presupuestos te acompañan.',
      detail: 'Seguí así y vas a cerrar muy bien el mes.',
      cta: null,
    }
  }

  // happy — positive projection, balance ok
  if (projResult > 0 && summary.balance >= 0) {
    return {
      mood: 'happy',
      message: 'Me gusta cómo viene este mes.',
      detail: 'Vas bien, se nota que le estás prestando atención a tu plata.',
      cta: null,
    }
  }

  // tired — lots of expense activity but manageable
  if (summary.totalExpense > summary.totalIncome * 0.8 && summary.balance >= 0) {
    return {
      mood: 'tired',
      message: 'Mes con mucho movimiento. Todo anotado.',
      detail: 'Por hoy, bastante bien.',
      cta: null,
    }
  }

  return {
    mood: 'calm',
    message: 'Todo bastante en orden por acá.',
    detail: 'No veo alarmas urgentes, y eso me gusta.',
    cta: null,
  }
}
