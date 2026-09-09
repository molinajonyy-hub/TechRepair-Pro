/**
 * taskService — fuente única de verdad para tareas.
 *
 * TASKS-V2-0: este servicio es la ÚNICA autoridad de escritura del módulo.
 * Ni la página ni el widget del dashboard escriben contra Supabase directamente.
 *
 * Toda mutación:
 *   · verifica `error` de Supabase (antes se descartaba en silencio);
 *   · verifica que la escritura haya afectado filas — la RLS deniega INSERT con
 *     42501, pero un UPDATE/DELETE denegado vuelve con 0 filas y SIN error, así
 *     que sin este chequeo una denegación parecía un éxito;
 *   · registra en el logger centralizado;
 *   · propaga un TaskServiceError tipado, con un mensaje apto para el usuario.
 *
 * Consumido por: Dashboard (widget), Tasks page (módulo completo).
 */
import { supabase } from '../lib/supabase'
import { logger } from '../lib/logger'

// ─── Contrato TEMPORAL de estados ─────────────────────────────────────────────

/**
 * Estados que la BASE acepta hoy.
 *
 * La autoridad vigente es el CHECK `tasks_status_check`, que sólo admite
 * `pending | completed`. El producto declaraba además `in_progress` y
 * `cancelled`: esas escrituras violaban el CHECK (23514), el error se descartaba
 * y el estado sobrevivía únicamente en el state de React hasta el próximo
 * refresh.
 *
 * Éste es un contrato TEMPORAL hasta TASKS-V2-3, que amplía el CHECK a los
 * cuatro estados. Mientras tanto la UI expone sólo lo que la base persiste.
 * No agregar chequeos sueltos de estado en componentes: derivarlos de acá.
 */
export const PERSISTED_TASK_STATUSES_CURRENT = ['pending', 'completed'] as const

export type PersistedTaskStatus = typeof PERSISTED_TASK_STATUSES_CURRENT[number]

/**
 * Tipo completo, a futuro. Se conserva para poder LEER sin romperse filas
 * históricas que ya tuvieran `cancelled`, y para que V2-3 no tenga que redefinir
 * el tipo. No usarlo para ofrecer acciones: para eso está `getAvailableTransitions`.
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export type TaskPriority = 'low' | 'medium' | 'high'

/** Grafo de transiciones vigente. Temporal hasta V2-3. */
const CURRENT_STATUS_TRANSITIONS: Record<PersistedTaskStatus, PersistedTaskStatus[]> = {
  pending:   ['completed'],
  completed: ['pending'],
}

export function isPersistedStatus(status: string): status is PersistedTaskStatus {
  return (PERSISTED_TASK_STATUSES_CURRENT as readonly string[]).includes(status)
}

/**
 * Transiciones ofrecibles desde un estado dado.
 * Una fila histórica en un estado no persistible (`in_progress`, `cancelled`) no
 * ofrece acciones: se muestra, no se opera. V2-3 la normaliza.
 */
export function getAvailableTransitions(status: string): PersistedTaskStatus[] {
  return isPersistedStatus(status) ? CURRENT_STATUS_TRANSITIONS[status] : []
}

// ─── Error tipado ─────────────────────────────────────────────────────────────

export type TaskErrorKind = 'permission' | 'validation' | 'network' | 'unknown'

/** Por qué falló una compleción, para que la UI pueda llevar al usuario al lugar correcto. */
export type TaskBlockedReason = 'checklist'

export class TaskServiceError extends Error {
  readonly kind:    TaskErrorKind
  readonly reason?: TaskBlockedReason
  readonly cause?:  unknown

  constructor(kind: TaskErrorKind, message: string, opts?: { reason?: TaskBlockedReason; cause?: unknown }) {
    super(message)
    this.name   = 'TaskServiceError'
    this.kind   = kind
    this.reason = opts?.reason
    this.cause  = opts?.cause
  }
}

export function isTaskServiceError(e: unknown): e is TaskServiceError {
  return e instanceof TaskServiceError
}

const WRITE_MESSAGES: Record<TaskErrorKind, string> = {
  permission: 'No tenés permisos para realizar esta acción.',
  validation: 'No pudimos guardar el cambio.',
  network:    'No pudimos conectar. Intentá nuevamente.',
  unknown:    'No pudimos guardar el cambio.',
}

const READ_MESSAGES: Record<TaskErrorKind, string> = {
  permission: 'No tenés permisos para ver esta información.',
  validation: 'No pudimos cargar la información.',
  network:    'No pudimos conectar. Intentá nuevamente.',
  unknown:    'No pudimos cargar la información.',
}

interface SupabaseLikeError {
  code?:    string
  message?: string
}

/**
 * Clasifica por CLASE de SQLSTATE, nunca por nombre de constraint: el nombre es
 * un detalle de implementación de la base y no debe llegar al comportamiento del
 * usuario.
 *
 *   42501  → insufficient_privilege (RLS / GRANT)
 *   23xxx  → violación de integridad (23514 check, 23502 not null, 23503 FK, …)
 *   PGRST301 → JWT vencido: para el usuario es lo mismo que no tener permiso
 */
function classify(error: SupabaseLikeError | null | undefined): TaskErrorKind {
  const code    = error?.code ?? ''
  const message = error?.message ?? ''

  if (code === '42501' || code === 'PGRST301') return 'permission'
  if (/permission denied|row-level security|not authorized/i.test(message)) return 'permission'
  if (/^23\d{3}$/.test(code)) return 'validation'
  if (!code && /fetch|network|failed to fetch|timeout/i.test(message)) return 'network'
  if (code === '') return 'network'
  return 'unknown'
}

function toTaskError(error: SupabaseLikeError, op: string, intent: 'read' | 'write'): TaskServiceError {
  const kind = classify(error)
  // El logger conserva el detalle técnico; el usuario recibe sólo el mensaje.
  logger.error('TASKS', `${op} falló (${kind})`, error)
  const message = intent === 'read' ? READ_MESSAGES[kind] : WRITE_MESSAGES[kind]
  return new TaskServiceError(kind, message, { cause: error })
}

/** Lanza si Supabase devolvió error. */
function assertNoError(error: SupabaseLikeError | null, op: string, intent: 'read' | 'write'): void {
  if (error) throw toTaskError(error, op, intent)
}

/**
 * Lanza si la escritura no tocó ninguna fila.
 *
 * Necesario porque un UPDATE/DELETE bloqueado por RLS no devuelve 42501: devuelve
 * 0 filas y `error: null`. Sin esto, una denegación de permisos se vería como un
 * éxito y la UI mostraría un estado que el servidor nunca aceptó.
 */
function assertAffected(rows: unknown[] | null, op: string): void {
  if (!rows || rows.length === 0) {
    logger.error('TASKS', `${op} no afectó ninguna fila — probable denegación de RLS`)
    throw new TaskServiceError('permission', WRITE_MESSAGES.permission)
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

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

/**
 * Fila completa, para la página del módulo.
 * `is_recurring` / `recurrence_type` se leen sólo para poder mostrar filas
 * históricas: la UI no ofrece crearlas ni editarlas (scheduler = P1).
 */
export interface TaskRecord extends TaskLite {
  business_id:     string
  created_by:      string | null
  updated_at:      string
  is_recurring:    boolean
  recurrence_type: string | null
}

export interface TaskSummary {
  pending: number
  completed: number
  overdue: number
}

export interface TaskChecklistItem {
  id: string
  task_id: string
  title: string
  is_done: boolean
  sort_order: number
}

export interface TaskCommentRow {
  id: string
  task_id: string
  user_id: string
  comment: string
  created_at: string
}

export interface TaskHistoryRow {
  id: string
  task_id: string
  user_id: string | null
  action: string
  old_value: string | null
  new_value: string | null
  created_at: string
}

export interface TaskWriteInput {
  title: string
  description: string | null
  priority: TaskPriority
  assigned_to: string | null
  due_date: string | null
}

const TASK_COLUMNS =
  'id, title, description, status, priority, due_date, assigned_to, user_id, started_at, completed_at, created_at'

const TASK_COLUMNS_FULL =
  `${TASK_COLUMNS}, business_id, created_by, updated_at, is_recurring, recurrence_type`

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isOverdue(t: Pick<TaskLite, 'status' | 'due_date'>) {
  return !!t.due_date &&
    t.status !== 'completed' &&
    t.status !== 'cancelled' &&
    new Date(t.due_date + 'T23:59:59') < new Date()
}

const PRIORITY_ORDER: Record<TaskPriority, number> = { high: 3, medium: 2, low: 1 }

/**
 * Historial: es un log de auditoría, no la intención del usuario. Si falla, se
 * registra pero NO se tumba la operación que el usuario sí completó.
 */
async function recordHistory(
  taskId: string, businessId: string, userId: string | null,
  action: string, newValue?: string | null, oldValue?: string | null,
): Promise<void> {
  const { error } = await supabase.from('task_history').insert({
    task_id: taskId, business_id: businessId, user_id: userId,
    action, new_value: newValue ?? null, old_value: oldValue ?? null,
  })
  if (error) logger.warn('TASKS', 'No se pudo registrar el historial', error)
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const taskService = {

  // ── Lecturas ───────────────────────────────────────────────────────────────

  /**
   * Todas las tareas del negocio.
   *
   * Ojo: la restricción «cada uno ve lo suyo» todavía NO está en la RLS — hoy la
   * aplica la página. Cerrarla server-side es TASKS-V2-4.
   */
  async getTasks(businessId: string, filters?: {
    assigned_to?: string
    status?: PersistedTaskStatus
    limit?: number
  }): Promise<TaskRecord[]> {
    let q = supabase
      .from('tasks')
      .select(TASK_COLUMNS_FULL)
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
    if (filters?.assigned_to) q = q.eq('assigned_to', filters.assigned_to)
    if (filters?.status)      q = q.eq('status', filters.status)
    if (filters?.limit)       q = q.limit(filters.limit)
    const { data, error } = await q
    assertNoError(error, 'getTasks', 'read')
    return (data || []) as unknown as TaskRecord[]
  },

  /** Tareas activas asignadas a un usuario (dashboard), ordenadas por urgencia. */
  async getMyTasks(businessId: string, userId: string, limit = 5): Promise<TaskLite[]> {
    const { data, error } = await supabase
      .from('tasks')
      .select(TASK_COLUMNS)
      .eq('business_id', businessId)
      .or(`assigned_to.eq.${userId},user_id.eq.${userId}`)
      .not('status', 'in', '("completed","cancelled")')
      .order('due_date', { ascending: true, nullsFirst: false })
    assertNoError(error, 'getMyTasks', 'read')
    const tasks = (data || []) as TaskLite[]
    // Vencidas primero, después por prioridad descendente.
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
   * Contadores del widget.
   *
   * Antes un fallo de lectura devolvía ceros: el widget decía «sin tareas» cuando
   * en realidad no había podido leer. Ahora propaga y la UI muestra el error.
   */
  async getTaskSummary(businessId: string, userId: string): Promise<TaskSummary> {
    const { data, error } = await supabase
      .from('tasks')
      .select('status, due_date')
      .eq('business_id', businessId)
      .or(`assigned_to.eq.${userId},user_id.eq.${userId}`)
    assertNoError(error, 'getTaskSummary', 'read')
    const tasks = (data || []) as Pick<TaskLite, 'status' | 'due_date'>[]
    return {
      pending:   tasks.filter(t => t.status === 'pending').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      overdue:   tasks.filter(isOverdue).length,
    }
  },

  async getChecklist(taskId: string): Promise<TaskChecklistItem[]> {
    const { data, error } = await supabase
      .from('task_items')
      .select('id, task_id, title, is_done, sort_order')
      .eq('task_id', taskId)
      .order('sort_order')
    assertNoError(error, 'getChecklist', 'read')
    return (data || []) as TaskChecklistItem[]
  },

  async getComments(taskId: string): Promise<TaskCommentRow[]> {
    const { data, error } = await supabase
      .from('task_comments')
      .select('id, task_id, user_id, comment, created_at')
      .eq('task_id', taskId)
      .order('created_at')
    assertNoError(error, 'getComments', 'read')
    return (data || []) as TaskCommentRow[]
  },

  async getHistory(taskId: string): Promise<TaskHistoryRow[]> {
    const { data, error } = await supabase
      .from('task_history')
      .select('id, task_id, user_id, action, old_value, new_value, created_at')
      .eq('task_id', taskId)
      .order('created_at')
    assertNoError(error, 'getHistory', 'read')
    return (data || []) as TaskHistoryRow[]
  },

  // ── Escrituras ─────────────────────────────────────────────────────────────

  /**
   * Crear tarea.
   *
   * No escribe `is_recurring` ni `recurrence_type`: la recurrencia está oculta
   * hasta que exista el scheduler (TASKS V2 P1). Los defaults de la base cubren
   * las columnas.
   */
  async createTask(businessId: string, createdBy: string, input: TaskWriteInput): Promise<TaskLite> {
    const { data, error } = await supabase.from('tasks').insert({
      business_id: businessId,
      title:       input.title,
      description: input.description,
      priority:    input.priority,
      assigned_to: input.assigned_to,
      user_id:     input.assigned_to,
      due_date:    input.due_date,
      status:      'pending',
      created_by:  createdBy,
      updated_at:  new Date().toISOString(),
    }).select(TASK_COLUMNS)
    assertNoError(error, 'createTask', 'write')
    assertAffected(data, 'createTask')
    const task = (data as TaskLite[])[0]
    void recordHistory(task.id, businessId, createdBy, 'created', input.title)
    return task
  },

  /**
   * Editar tarea.
   *
   * Deliberadamente NO toca `is_recurring` / `recurrence_type`: si una fila
   * histórica es recurrente, se conserva tal cual en vez de resetearse por el
   * hecho de que el control ya no esté en el formulario.
   */
  async updateTask(taskId: string, input: TaskWriteInput): Promise<TaskLite> {
    const { data, error } = await supabase.from('tasks').update({
      title:       input.title,
      description: input.description,
      priority:    input.priority,
      assigned_to: input.assigned_to,
      user_id:     input.assigned_to,
      due_date:    input.due_date,
      updated_at:  new Date().toISOString(),
    }).eq('id', taskId).select(TASK_COLUMNS)
    assertNoError(error, 'updateTask', 'write')
    assertAffected(data, 'updateTask')
    return (data as TaskLite[])[0]
  },

  /**
   * Completar.
   *
   * La única regla es el checklist, y vive acá y no en cada pantalla: antes sólo
   * la aplicaba el panel de detalle, así que completar desde otra superficie la
   * salteaba.
   *
   * NO se exige comentario de cierre. Una tarea de taller —«llamar al cliente»,
   * «pedir repuesto»— se completa de una acción. Los comentarios siguen existiendo
   * y se pueden agregar antes o después, pero son voluntarios.
   */
  async completeTask(taskId: string, businessId: string, userId: string): Promise<TaskLite> {
    const items = await taskService.getChecklist(taskId)
    if (items.length > 0 && items.some(i => !i.is_done)) {
      throw new TaskServiceError('validation', 'Completá todos los ítems del checklist primero.', { reason: 'checklist' })
    }

    const now = new Date().toISOString()
    const { data, error } = await supabase.from('tasks')
      .update({ status: 'completed', completed_at: now, updated_at: now })
      .eq('id', taskId).select(TASK_COLUMNS)
    assertNoError(error, 'completeTask', 'write')
    assertAffected(data, 'completeTask')
    void recordHistory(taskId, businessId, userId, 'status_changed', 'completed', 'pending')
    return (data as TaskLite[])[0]
  },

  /** Reabrir: vuelve a `pending` y limpia `completed_at` para no dejar la fila incoherente. */
  async reopenTask(taskId: string, businessId: string, userId: string): Promise<TaskLite> {
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('tasks')
      .update({ status: 'pending', completed_at: null, updated_at: now })
      .eq('id', taskId).select(TASK_COLUMNS)
    assertNoError(error, 'reopenTask', 'write')
    assertAffected(data, 'reopenTask')
    void recordHistory(taskId, businessId, userId, 'status_changed', 'pending', 'completed')
    return (data as TaskLite[])[0]
  },

  /** Punto único de cambio de estado. Rechaza transiciones que la base no persiste. */
  async setTaskStatus(
    taskId: string, businessId: string, userId: string,
    next: PersistedTaskStatus, currentStatus: string,
  ): Promise<TaskLite> {
    if (!getAvailableTransitions(currentStatus).includes(next)) {
      logger.warn('TASKS', `Transición no permitida ${currentStatus} → ${next}`)
      throw new TaskServiceError('validation', WRITE_MESSAGES.validation)
    }
    return next === 'completed'
      ? taskService.completeTask(taskId, businessId, userId)
      : taskService.reopenTask(taskId, businessId, userId)
  },

  async deleteTask(taskId: string): Promise<void> {
    const { data, error } = await supabase.from('tasks').delete().eq('id', taskId).select('id')
    assertNoError(error, 'deleteTask', 'write')
    assertAffected(data, 'deleteTask')
  },

  async addComment(taskId: string, businessId: string, userId: string, comment: string): Promise<TaskCommentRow> {
    const { data, error } = await supabase.from('task_comments')
      .insert({ task_id: taskId, business_id: businessId, user_id: userId, comment })
      .select('id, task_id, user_id, comment, created_at')
    assertNoError(error, 'addComment', 'write')
    assertAffected(data, 'addComment')
    void recordHistory(taskId, businessId, userId, 'commented', comment.slice(0, 100))
    return (data as TaskCommentRow[])[0]
  },

  async addChecklistItem(taskId: string, businessId: string, title: string, sortOrder: number): Promise<TaskChecklistItem> {
    const { data, error } = await supabase.from('task_items')
      .insert({ task_id: taskId, business_id: businessId, title, sort_order: sortOrder })
      .select('id, task_id, title, is_done, sort_order')
    assertNoError(error, 'addChecklistItem', 'write')
    assertAffected(data, 'addChecklistItem')
    return (data as TaskChecklistItem[])[0]
  },

  async toggleChecklistItem(
    item: TaskChecklistItem, businessId: string, userId: string,
  ): Promise<TaskChecklistItem> {
    const nextDone = !item.is_done
    const { data, error } = await supabase.from('task_items')
      .update({ is_done: nextDone }).eq('id', item.id)
      .select('id, task_id, title, is_done, sort_order')
    assertNoError(error, 'toggleChecklistItem', 'write')
    assertAffected(data, 'toggleChecklistItem')
    void recordHistory(item.task_id, businessId, userId, 'checklist',
      `${item.title}: ${nextDone ? 'completado' : 'pendiente'}`)
    return (data as TaskChecklistItem[])[0]
  },

  async deleteChecklistItem(itemId: string): Promise<void> {
    const { data, error } = await supabase.from('task_items').delete().eq('id', itemId).select('id')
    assertNoError(error, 'deleteChecklistItem', 'write')
    assertAffected(data, 'deleteChecklistItem')
  },
}
