/**
 * taskService — fuente única de verdad para tareas.
 * Consumido por: Dashboard (widget), Tasks page (módulo completo).
 */
import { supabase } from '../lib/supabase'

// ─── Types (shared, compatibles con Tasks.tsx) ────────────────────────────────

export type TaskStatus   = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type TaskPriority = 'low' | 'medium' | 'high'

export interface TaskLite {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  due_date: string | null
  assigned_to: string | null
  user_id: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

export interface TaskSummary {
  pending: number
  in_progress: number
  completed: number
  overdue: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isOverdue(t: Pick<TaskLite, 'status' | 'due_date'>) {
  return !!t.due_date &&
    t.status !== 'completed' &&
    t.status !== 'cancelled' &&
    new Date(t.due_date + 'T23:59:59') < new Date()
}

const PRIORITY_ORDER: Record<TaskPriority, number> = { high: 3, medium: 2, low: 1 }

// ─── Service ──────────────────────────────────────────────────────────────────

export const taskService = {
  /**
   * Todas las tareas del negocio (admin).
   */
  async getTasks(businessId: string, filters?: {
    assigned_to?: string
    status?: TaskStatus
    limit?: number
  }): Promise<TaskLite[]> {
    let q = supabase
      .from('tasks')
      .select('id, title, description, status, priority, due_date, assigned_to, user_id, started_at, completed_at, created_at')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
    if (filters?.assigned_to) q = q.eq('assigned_to', filters.assigned_to)
    if (filters?.status)      q = q.eq('status', filters.status)
    if (filters?.limit)       q = q.limit(filters.limit)
    const { data } = await q
    return (data || []) as TaskLite[]
  },

  /**
   * Tareas asignadas a un usuario (para el dashboard — sólo activas, ordenadas por urgencia).
   */
  async getMyTasks(businessId: string, userId: string, limit = 5): Promise<TaskLite[]> {
    const { data } = await supabase
      .from('tasks')
      .select('id, title, description, status, priority, due_date, assigned_to, user_id, started_at, completed_at, created_at')
      .eq('business_id', businessId)
      .or(`assigned_to.eq.${userId},user_id.eq.${userId}`)
      .not('status', 'in', '("completed","cancelled")')
      .order('due_date', { ascending: true, nullsFirst: false })
    const tasks = (data || []) as TaskLite[]
    // Sort: overdue first, then by priority desc
    return tasks
      .sort((a, b) => {
        const aOver = isOverdue(a) ? 1 : 0
        const bOver = isOverdue(b) ? 1 : 0
        if (bOver !== aOver) return bOver - aOver
        return (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0)
      })
      .slice(0, limit)
  },

  /**
   * Resumen de contadores para el widget del dashboard.
   */
  async getTaskSummary(businessId: string, userId: string): Promise<TaskSummary> {
    const { data } = await supabase
      .from('tasks')
      .select('status, due_date')
      .eq('business_id', businessId)
      .or(`assigned_to.eq.${userId},user_id.eq.${userId}`)
    const tasks = data || []
    return {
      pending:     tasks.filter(t => t.status === 'pending').length,
      in_progress: tasks.filter(t => t.status === 'in_progress').length,
      completed:   tasks.filter(t => t.status === 'completed').length,
      overdue:     tasks.filter(t => isOverdue(t as any)).length,
    }
  },

  /**
   * Avanzar estado con timestamps automáticos.
   */
  async updateTaskStatus(taskId: string, newStatus: TaskStatus): Promise<void> {
    const now = new Date().toISOString()
    const patch: Record<string, any> = { status: newStatus, updated_at: now }
    if (newStatus === 'in_progress') patch.started_at  = now
    if (newStatus === 'completed')   patch.completed_at = now
    await supabase.from('tasks').update(patch).eq('id', taskId)
  },

  /**
   * Agregar comentario (necesario para completar).
   */
  async addComment(taskId: string, businessId: string, userId: string, comment: string): Promise<void> {
    await supabase.from('task_comments').insert({ task_id: taskId, business_id: businessId, user_id: userId, comment })
    await supabase.from('task_history').insert({ task_id: taskId, business_id: businessId, user_id: userId, action: 'commented', new_value: comment.slice(0, 100) })
  },

  /**
   * Verificar si la tarea ya tiene al menos un comentario.
   */
  async hasComment(taskId: string): Promise<boolean> {
    const { count } = await supabase.from('task_comments').select('id', { count: 'exact', head: true }).eq('task_id', taskId)
    return (count || 0) > 0
  },
}
