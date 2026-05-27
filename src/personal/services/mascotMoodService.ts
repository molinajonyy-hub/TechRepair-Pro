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
      message: 'Analizando tu resumen...',
      detail: 'Ya casi.',
      cta: null,
    }
  }

  const hasData = summary.totalIncome > 0 || summary.totalExpense > 0
  if (!hasData) {
    return {
      mood: 'thinking',
      message: 'Cargá algunos movimientos para ver el panorama de tu mes.',
      detail: 'Con más datos puedo darte un análisis más preciso.',
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

  if (
    hasDangerInsight ||
    (projResult < 0 && summary.totalIncome > 0 && Math.abs(projResult) > summary.totalIncome * 0.4)
  ) {
    return {
      mood: 'alert',
      message: 'Tu proyección del mes viene ajustada. Conviene revisarlo ahora.',
      detail: 'Hay compromisos importantes que merecen atención.',
      cta: { label: 'Ver proyección', route: '/personal/proyecciones' },
    }
  }

  if (budgetExceeded || projResult < 0 || debtDueSoon || hasWarningInsight) {
    if (budgetExceeded) {
      const n = budgetSummary!.exceedCount
      return {
        mood: 'worried',
        message:
          n === 1
            ? 'Ojo: una categoría superó el presupuesto este mes.'
            : `Ojo: ${n} categorías superaron el presupuesto este mes.`,
        detail: 'No es grave, pero conviene revisarlo antes de que avance.',
        cta: { label: 'Revisar presupuesto', route: '/personal/presupuestos' },
      }
    }
    if (projResult < 0) {
      return {
        mood: 'worried',
        message: 'La proyección no cierra bien con los compromisos del mes.',
        detail: 'Todavía estamos a tiempo de ajustar.',
        cta: { label: 'Ver proyección', route: '/personal/proyecciones' },
      }
    }
    if (debtDueSoon) {
      return {
        mood: 'worried',
        message: 'Tenés un vencimiento próximo, no lo pierdas de vista.',
        detail: 'Revisá antes de que se pase la fecha.',
        cta: { label: 'Ver deudas', route: '/personal/deudas' },
      }
    }
    return {
      mood: 'worried',
      message: 'Hay algunos puntos que merecen una revisión.',
      detail: null,
      cta: null,
    }
  }

  const isGreatMonth =
    summary.balance > 0 &&
    projResult > 0 &&
    summary.totalIncome > 0 &&
    summary.totalExpense < summary.totalIncome * 0.55

  if (isGreatMonth) {
    return {
      mood: 'celebrating',
      message: '¡Excelente mes! Estás cerrando con muy buen margen.',
      detail: 'Un resultado así merece reconocerlo.',
      cta: null,
    }
  }

  const hasBudgets = (budgetSummary?.totalBudgeted ?? 0) > 0
  if (projResult > 0 && hasBudgets && !budgetWarning && budgetUsagePct < 0.85) {
    return {
      mood: 'motivated',
      message: 'Vas bien encaminada. Los presupuestos están acompañando.',
      detail: 'Seguí así y vas a cerrar muy bien el mes.',
      cta: null,
    }
  }

  if (projResult > 0 && summary.balance >= 0) {
    return {
      mood: 'happy',
      message: 'El mes viene bien. Los números están bastante prolijos.',
      detail: 'Se nota que le estás prestando atención a tus finanzas.',
      cta: null,
    }
  }

  if (summary.totalExpense > summary.totalIncome * 0.8 && summary.balance >= 0) {
    return {
      mood: 'tired',
      message: 'Mes con mucho movimiento. Todo registrado y bajo control.',
      detail: 'Por hoy, cerramos bien.',
      cta: null,
    }
  }

  return {
    mood: 'calm',
    message: 'Tu mes viene tranquilo. Sin alarmas por ahora.',
    detail: 'Buen ritmo, seguí así.',
    cta: null,
  }
}
