/**
 * DashboardTasks — «Mis tareas» en Inicio.
 *
 * BETA-UX-1F: Tareas es uno de los pilares del producto (junto con el CRM que
 * viene), y en Inicio dejó de ser un widget: es un bloque a todo el ancho, justo
 * debajo de los indicadores del día, y conserva su lugar aunque no haya nada
 * pendiente.
 *
 * Fuente de datos: `taskService` (única autoridad). Este bloque no escribe
 * contra Supabase y no decide reglas: completar valida el checklist en el
 * servicio, y un fallo se muestra en vez de convertirse en «sin tareas».
 *
 * La fila es deliberadamente genérica —título, vencimiento, prioridad—: es lo
 * que tiene cualquier tarea, venga de donde venga. Cuando existan tareas
 * creadas por órdenes, clientes o seguimientos, entran en esta lista sin
 * cambiarla. Hoy no hay ningún origen que mostrar, y no se inventa uno.
 */
import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, ChevronRight, CheckCircle2, Circle, Clock, AlertTriangle, ListChecks } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import {
  taskService, isTaskServiceError, isTaskDueToday,
  type TaskLite, type TaskSummary,
} from '../../services/taskService'
import { AppButton } from '../../ui'
import { todayAR, fmtDateCompact } from '../../utils/dateUtils'

/** Traduce cualquier fallo a un mensaje que el usuario pueda leer. */
const toUserMessage = (e: unknown, fallback: string) =>
  isTaskServiceError(e) ? e.message : fallback

// ─── Constants ────────────────────────────────────────────────────────────────

/** Cuántas tareas activas lista Inicio. El resto está en el módulo. */
const DASHBOARD_TASK_LIMIT = 5

/**
 * `urgent` no está en `TaskPriority`, pero el CHECK `tasks_priority_check` de la
 * base lo acepta: una fila que lo traiga se nombra como lo que es. Una
 * prioridad que no esté acá no se muestra; decir «media» sería inventarla.
 */
const PRIORITY_LABEL: Record<string, string> = {
  urgent: 'Prioridad urgente',
  high:   'Prioridad alta',
  medium: 'Prioridad media',
  low:    'Prioridad baja',
}

/**
 * TASKS-V2-0 — sólo `pending` y `completed` son persistibles hoy (CHECK
 * `tasks_status_check`). `in_progress` y `cancelled` siguen acá únicamente para
 * poder RENDERIZAR una fila histórica sin romperse; no se ofrecen como acción.
 */
const HISTORIC_STATUS_LABEL: Record<string, string> = {
  in_progress: 'En proceso',
  completed:   'Completada',
  cancelled:   'Cancelada',
}

const fmtDate = (d: string) => {
  const dateMs  = new Date(d + 'T00:00:00-03:00').getTime()
  const todayMs = new Date(todayAR() + 'T00:00:00-03:00').getTime()
  const diff    = Math.round((dateMs - todayMs) / 86400000)
  if (diff === 0)  return 'Hoy'
  if (diff === 1)  return 'Mañana'
  if (diff === -1) return 'Ayer'
  if (diff < 0)    return `Hace ${Math.abs(diff)}d`
  return fmtDateCompact(d)
}

const isOverdue = (t: TaskLite) =>
  !!t.due_date && t.status !== 'completed' && t.status !== 'cancelled' &&
  new Date(t.due_date + 'T23:59:59') < new Date()

// ─── DashboardTasks ───────────────────────────────────────────────────────────

interface DashboardTasksProps {
  /** Cambia cuando Inicio pide «Actualizar»: vuelve a leer tareas y resumen. */
  refreshKey?: number
}

export function DashboardTasks({ refreshKey = 0 }: DashboardTasksProps) {
  const { businessId, user } = useAuth()
  const navigate = useNavigate()

  const [tasks, setTasks]       = useState<TaskLite[]>([])
  const [summary, setSummary]   = useState<TaskSummary | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  // Compleción: una sola acción, sin formulario intermedio.
  // El error se ancla a la fila que lo produjo para no quedar huérfano.
  const [busyId, setBusyId]           = useState<string | null>(null)
  const [completeErr, setCompleteErr] = useState<{ taskId: string; message: string } | null>(null)

  const load = useCallback(async () => {
    if (!businessId || !user?.id) return
    try {
      const [myTasks, mySummary] = await Promise.all([
        taskService.getMyTasks(businessId, user.id, DASHBOARD_TASK_LIMIT),
        taskService.getTaskSummary(businessId, user.id),
      ])
      setTasks(myTasks)
      setSummary(mySummary)
      setError(null)
    } catch (e: unknown) {
      // Un fallo de lectura ya no se ve como «sin tareas asignadas»: antes el
      // servicio devolvía [] ante un error y el widget mostraba un cero falso.
      setError(toUserMessage(e, 'No pudimos cargar las tareas.'))
    } finally {
      setLoading(false)
    }
  }, [businessId, user?.id])

  // Carga inicial + auto-refresh cada 30 segundos. `refreshKey` la repite a pedido.
  useEffect(() => {
    load()
    const interval = setInterval(load, 30_000)
    return () => clearInterval(interval)
  }, [load, refreshKey])

  // ── Handlers ───────────────────────────────────────────────────────────────

  const openCreate = () => navigate('/tasks', { state: { openCreate: true } })

  /**
   * `pending → completed` de una sola acción.
   *
   * No pide nota de cierre: una tarea de taller —«llamar al cliente», «pedir
   * repuesto»— se completa con un tap. Los comentarios siguen disponibles en el
   * detalle de la tarea, y son voluntarios.
   *
   * La única regla que puede rechazar la compleción es el checklist, y la valida
   * `taskService`; acá sólo se muestra el error.
   */
  const handleToggle = async (task: TaskLite) => {
    if (task.status !== 'pending' || !businessId || !user?.id) return
    setBusyId(task.id); setCompleteErr(null)
    try {
      await taskService.completeTask(task.id, businessId, user.id)
      // Sólo después de que el servidor lo aceptó. Los contadores salen de la
      // misma tarea que se completó; la relectura que sigue trae la verdad (y la
      // tarea siguiente, si había más de las que se listan).
      setTasks(prev => prev.filter(t => t.id !== task.id))
      setSummary(prev => prev
        ? {
            ...prev,
            pending:   Math.max(0, prev.pending - 1),
            completed: prev.completed + 1,
            overdue:   Math.max(0, prev.overdue - (isOverdue(task) ? 1 : 0)),
            dueToday:  Math.max(0, prev.dueToday - (isTaskDueToday(task) ? 1 : 0)),
          }
        : prev)
      void load()
    } catch (e: unknown) {
      setCompleteErr({ taskId: task.id, message: toUserMessage(e, 'No pudimos completar la tarea.') })
    } finally { setBusyId(null) }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const isEmpty = !loading && !error && tasks.length === 0

  // Vencidas / Para hoy / Pendientes: lo que pide atención. «Completadas» sigue
  // en el módulo; en Inicio no dice qué hacer. Sin tareas activas el resumen no
  // se dibuja: tres ceros arriba de «Todo al día» no agregan nada.
  const stats = summary && !error && !isEmpty ? [
    { key: 'overdue',  label: 'Vencidas',   value: summary.overdue,  tone: summary.overdue > 0 ? 'danger' : 'neutral' },
    { key: 'today',    label: 'Para hoy',   value: summary.dueToday, tone: summary.dueToday > 0 ? 'accent' : 'neutral' },
    { key: 'pending',  label: 'Pendientes', value: summary.pending,  tone: 'neutral' },
  ] as const : null

  return (
    <section className="card dash-tasks" data-testid="dashboard-tasks" aria-labelledby="dash-tasks-title">
      {/* Header */}
      <div className="dash-tasks__header">
        <div className="dash-tasks__heading">
          <span className="dash-tasks__icon" aria-hidden="true"><ListChecks size={18} /></span>
          <div>
            <h2 className="dash-tasks__title" id="dash-tasks-title">Mis tareas</h2>
            <p className="dash-tasks__subtitle">Lo que necesita tu atención</p>
          </div>
        </div>
        <div className="dash-tasks__actions">
          <AppButton
            variant="primary"
            size="sm"
            className="btn-primary-aa dash-tasks__action"
            leftIcon={<Plus size={15} />}
            onClick={openCreate}
          >
            Nueva tarea
          </AppButton>
          <Link to="/tasks" className="btn btn-secondary btn-sm dash-link dash-tasks__action" aria-label="Ver todas las tareas">
            Ver todas <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </div>

      {/* Resumen */}
      {stats && (
        <div className="dash-tasks__summary" data-testid="dashboard-tasks-summary">
          {stats.map(stat => (
            <Link
              key={stat.key}
              to="/tasks"
              className="dash-tasks__stat"
              data-testid={`dashboard-tasks-${stat.key}`}
              data-tone={stat.tone}
              aria-label={`${stat.label}: ${stat.value}. Ver tareas`}
            >
              <span className="dash-tasks__stat-value">{stat.value}</span>
              <span className="dash-tasks__stat-label">{stat.label}</span>
            </Link>
          ))}
        </div>
      )}

      {/* Lista */}
      {loading ? (
        <div className="dash-tasks__loading" data-testid="dashboard-tasks-loading" aria-hidden="true">
          {[1, 2, 3].map(i => (
            <div key={i} className="dash-tasks__loading-row">
              <div className="skeleton" style={{ width: 20, height: 20, borderRadius: '50%' }} />
              <div className="skeleton skeleton-text" style={{ width: `${70 - i * 10}%` }} />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="dash-tasks__error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
          <AppButton variant="secondary" size="sm" className="dash-tasks__retry" onClick={() => { void load() }}>
            Reintentar
          </AppButton>
        </div>
      ) : isEmpty ? (
        <div className="dash-empty dash-empty--done" data-testid="dashboard-tasks-empty">
          <span className="dash-empty__icon" aria-hidden="true"><CheckCircle2 size={22} /></span>
          <p className="dash-empty__title">Todo al día</p>
          <p className="dash-empty__copy">No tenés tareas pendientes.</p>
        </div>
      ) : (
        <ul className="dash-tasks__list">
          {tasks.map(task => {
            const over   = isOverdue(task)
            const today  = !over && isTaskDueToday(task)
            const isBusy = busyId === task.id
            const rowErr = completeErr?.taskId === task.id ? completeErr.message : null
            const canComplete = task.status === 'pending'
            const historic = HISTORIC_STATUS_LABEL[task.status]
            const priority = PRIORITY_LABEL[task.priority]

            return (
              <li key={task.id} className="dash-task" data-testid="dashboard-task" data-overdue={over ? 'true' : 'false'}>
                <div className="dash-task__row">
                  {/* Completa en una sola acción */}
                  <button
                    type="button"
                    className="dash-task__toggle"
                    onClick={() => handleToggle(task)}
                    disabled={!canComplete || isBusy}
                    title={canComplete ? 'Completar tarea' : (historic ?? 'Tarea')}
                    aria-label={canComplete ? `Completar tarea: ${task.title}` : `${historic ?? 'Tarea'}: ${task.title}`}
                  >
                    {task.status === 'completed' ? <CheckCircle2 size={20} /> : task.status === 'in_progress' ? <Clock size={20} /> : <Circle size={20} />}
                  </button>

                  {/* Título, vencimiento y prioridad: lo que tiene cualquier tarea */}
                  <Link to="/tasks" className="dash-task__open">
                    <span className="dash-task__body">
                      <span className="dash-task__title">{task.title}</span>
                      <span className="dash-task__meta">
                        {task.due_date && (
                          <span
                            className="dash-task__due"
                            data-state={over ? 'overdue' : today ? 'today' : 'upcoming'}
                          >
                            {over && <AlertTriangle size={12} aria-hidden="true" />}
                            {over ? `Vencida · ${fmtDate(task.due_date)}` : fmtDate(task.due_date)}
                          </span>
                        )}
                        {priority && (
                          <span className="dash-task__priority" data-priority={task.priority}>
                            <span className="dash-task__priority-dot" aria-hidden="true" />
                            {priority}
                          </span>
                        )}
                        {historic && <span className="dash-task__historic">{historic}</span>}
                      </span>
                    </span>
                    <ChevronRight size={16} className="dash-task__chevron" aria-hidden="true" />
                  </Link>
                </div>

                {/* Error de compleción — p. ej. checklist incompleto. Sin formulario:
                    completar no pide nota de cierre. */}
                {rowErr && (
                  <div className="dash-task__error" role="alert">
                    <AlertTriangle size={13} aria-hidden="true" /> {rowErr}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
