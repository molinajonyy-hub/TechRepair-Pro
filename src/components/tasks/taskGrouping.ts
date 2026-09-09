/**
 * Agrupación temporal de tareas — lógica pura, sin React y sin Supabase.
 *
 * TASKS-V2-1: la vista se organiza por CUÁNDO, no por estado de workflow. Esto
 * es presentación: no muta la tarea ni deriva estado de negocio.
 *
 * Zona horaria: `due_date` es una columna DATE («YYYY-MM-DD») y `todayAR()`
 * devuelve el día de Argentina en el mismo formato, así que la comparación es
 * entre strings ISO y ordena bien lexicográficamente. Deliberadamente NO se
 * construyen `Date` a partir de `due_date`: el patrón viejo
 * `new Date(due_date + 'T23:59:59')` interpretaba la fecha en la zona del
 * navegador, así que a un usuario fuera de AR —o con el reloj corrido— una tarea
 * le cambiaba de grupo.
 */
import { todayAR } from '../../utils/dateUtils'

export type TaskGroupKey = 'overdue' | 'today' | 'upcoming' | 'no_date' | 'completed'

/** Orden de lectura de la pantalla: primero lo que quema. */
export const TASK_GROUP_ORDER: TaskGroupKey[] = ['overdue', 'today', 'upcoming', 'no_date']

export const TASK_GROUP_LABEL: Record<TaskGroupKey, string> = {
  overdue:   'Vencidas',
  today:     'Hoy',
  upcoming:  'Próximas',
  no_date:   'Sin fecha',
  completed: 'Completadas',
}

/** Lo mínimo que necesita la agrupación. Sirve para TaskRecord y para TaskLite. */
export interface GroupableTask {
  status: string
  due_date: string | null
  priority?: string
  completed_at?: string | null
  created_at?: string
  title?: string
}

/**
 * Una tarea deja de estar activa cuando se completó o se canceló.
 *
 * `cancelled` no lo persiste la base hoy (CHECK `tasks_status_check`), pero si
 * apareciera una fila histórica hay que tratarla como cerrada: mostrarla vencida
 * para siempre sería peor. Va al grupo cerrado junto con las completadas.
 */
export function isActiveTask(task: GroupableTask): boolean {
  return task.status !== 'completed' && task.status !== 'cancelled'
}

/** Vencida = tenía fecha, ya pasó, y sigue activa. */
export function isOverdueTask(task: GroupableTask, today: string = todayAR()): boolean {
  return isActiveTask(task) && !!task.due_date && task.due_date < today
}

/** Vence hoy y sigue activa. */
export function isDueTodayTask(task: GroupableTask, today: string = todayAR()): boolean {
  return isActiveTask(task) && task.due_date === today
}

export function groupKeyFor(task: GroupableTask, today: string = todayAR()): TaskGroupKey {
  if (!isActiveTask(task))     return 'completed'
  if (!task.due_date)          return 'no_date'
  if (task.due_date < today)   return 'overdue'
  if (task.due_date === today) return 'today'
  return 'upcoming'
}

const PRIORITY_WEIGHT: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 }

const byPriorityDesc = (a: GroupableTask, b: GroupableTask) =>
  (PRIORITY_WEIGHT[b.priority ?? ''] ?? 0) - (PRIORITY_WEIGHT[a.priority ?? ''] ?? 0)

/** Desempate estable para que dos renders seguidos no reordenen la lista. */
const byCreatedDesc = (a: GroupableTask, b: GroupableTask) =>
  (b.created_at ?? '').localeCompare(a.created_at ?? '')

/**
 * Orden DENTRO de cada grupo. Cada grupo tiene su propia pregunta:
 *   · vencidas  → la más atrasada primero;
 *   · hoy       → lo más importante primero, la fecha ya no distingue;
 *   · próximas  → lo que vence antes primero;
 *   · sin fecha → prioridad, y después lo más nuevo;
 *   · cerradas  → lo último que se cerró primero.
 */
function sortForGroup<T extends GroupableTask>(group: TaskGroupKey, tasks: T[]): T[] {
  const sorted = [...tasks]
  switch (group) {
    case 'overdue':
      return sorted.sort((a, b) =>
        (a.due_date ?? '').localeCompare(b.due_date ?? '') || byPriorityDesc(a, b))
    case 'upcoming':
      return sorted.sort((a, b) =>
        (a.due_date ?? '').localeCompare(b.due_date ?? '') || byPriorityDesc(a, b))
    case 'today':
    case 'no_date':
      return sorted.sort((a, b) => byPriorityDesc(a, b) || byCreatedDesc(a, b))
    case 'completed':
      return sorted.sort((a, b) =>
        (b.completed_at ?? '').localeCompare(a.completed_at ?? '') || byCreatedDesc(a, b))
  }
}

export type GroupedTasks<T> = Record<TaskGroupKey, T[]>

/**
 * Reparte las tareas en los cinco grupos y ordena cada uno.
 * No modifica las tareas: sólo las referencia desde otro array.
 */
export function groupTasksByTime<T extends GroupableTask>(
  tasks: T[],
  today: string = todayAR(),
): GroupedTasks<T> {
  const groups: GroupedTasks<T> = {
    overdue: [], today: [], upcoming: [], no_date: [], completed: [],
  }
  for (const task of tasks) groups[groupKeyFor(task, today)].push(task)

  for (const key of Object.keys(groups) as TaskGroupKey[]) {
    groups[key] = sortForGroup(key, groups[key])
  }
  return groups
}

/** Cuántas tareas activas hay en total (todo menos el grupo cerrado). */
export function countActive<T>(groups: GroupedTasks<T>): number {
  return TASK_GROUP_ORDER.reduce((n, key) => n + groups[key].length, 0)
}
