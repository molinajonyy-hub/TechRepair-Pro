import type { SavingsGoal } from '../services/savingsService'

export type { SavingsGoal }

// ─── Status helpers ───────────────────────────────────────────────────────────

export type GoalStatus = 'active' | 'completed' | 'paused' | 'cancelled'

export function getGoalStatusLabel(goal: SavingsGoal): string {
  switch (goal.status) {
    case 'active':    return 'Activo'
    case 'completed': return 'Completado'
    case 'paused':    return 'Pausado'
    case 'cancelled': return 'Cancelado'
    default:          return goal.status
  }
}

export function getGoalStatusColor(goal: SavingsGoal): string {
  switch (goal.status) {
    case 'active':    return '#34d399'
    case 'completed': return '#818cf8'
    case 'paused':    return '#fbbf24'
    case 'cancelled': return '#f87171'
    default:          return '#475569'
  }
}

// ─── Progress helpers ─────────────────────────────────────────────────────────

export function isGoalCompleted(goal: SavingsGoal): boolean {
  const target = Number(goal.target_amount) || 0
  if (target <= 0) return false
  return Number(goal.current_amount) >= target
}

/** Progress 0–100. Never negative, capped at 100 for display. */
export function getGoalProgress(goal: SavingsGoal): number {
  const target  = Number(goal.target_amount) || 0
  const current = Number(goal.current_amount) || 0
  if (target <= 0) return current > 0 ? 100 : 0
  return Math.min(100, Math.max(0, (current / target) * 100))
}

/** Remaining amount to reach target. Returns 0 if already at/over target. */
export function getGoalRemainingAmount(goal: SavingsGoal): number {
  const remaining = Number(goal.target_amount) - Number(goal.current_amount)
  return Math.max(0, remaining)
}

/** How much the user needs to save per month to hit the target by target_date. */
export function getEstimatedMonthlyNeeded(goal: SavingsGoal, today = new Date()): number | null {
  if (!goal.target_date) return null
  const remaining = getGoalRemainingAmount(goal)
  if (remaining <= 0) return 0
  const due = new Date(goal.target_date + 'T12:00:00')
  const months = (due.getFullYear() - today.getFullYear()) * 12 + (due.getMonth() - today.getMonth())
  if (months <= 0) return remaining
  return remaining / months
}

/** Ensure amount stays within [0, targetAmount]. */
export function clampGoalAmount(amount: number, targetAmount: number): number {
  return Math.max(0, Math.min(amount, targetAmount))
}

// ─── Summary helpers ──────────────────────────────────────────────────────────

export interface SavingsSummary {
  totalARS: number
  totalUSD: number
  activeCount: number
  completedCount: number
  totalTargetARS: number
  totalTargetUSD: number
}

export function getSavingsSummary(goals: SavingsGoal[]): SavingsSummary {
  const active    = goals.filter(g => g.status === 'active')
  const completed = goals.filter(g => g.status === 'completed')
  return {
    totalARS:      goals.filter(g => g.currency === 'ARS').reduce((s, g) => s + (Number(g.current_amount) || 0), 0),
    totalUSD:      goals.filter(g => g.currency === 'USD').reduce((s, g) => s + (Number(g.current_amount) || 0), 0),
    activeCount:   active.length,
    completedCount: completed.length,
    totalTargetARS: active.filter(g => g.currency === 'ARS').reduce((s, g) => s + (Number(g.target_amount) || 0), 0),
    totalTargetUSD: active.filter(g => g.currency === 'USD').reduce((s, g) => s + (Number(g.target_amount) || 0), 0),
  }
}

/** Goals sorted by: active first, then by progress descending (closest to completion). */
export function sortGoalsByRelevance(goals: SavingsGoal[]): SavingsGoal[] {
  const order: Record<string, number> = { active: 0, paused: 1, completed: 2, cancelled: 3 }
  return [...goals].sort((a, b) => {
    const statusDiff = (order[a.status] ?? 9) - (order[b.status] ?? 9)
    if (statusDiff !== 0) return statusDiff
    return getGoalProgress(b) - getGoalProgress(a)
  })
}

/** Find the active goal closest to completion (highest progress). */
export function getTopGoal(goals: SavingsGoal[]): SavingsGoal | null {
  const active = goals.filter(g => g.status === 'active')
  if (active.length === 0) return null
  return active.reduce((best, g) => getGoalProgress(g) > getGoalProgress(best) ? g : best, active[0])
}
