/**
 * Tareas — vista operativa única.
 *
 * TASKS-V2-1: se retira la dualidad kanban/tabla. La lista se lee por CUÁNDO
 * (Vencidas → Hoy → Próximas → Sin fecha, con Completadas al pie) en vez de por
 * columnas de workflow. El kanban además tenía la columna del medio siempre
 * vacía, porque `in_progress` no lo persiste la base.
 *
 * Contrato de estados sin cambios respecto de V2-0.1: sólo `pending` y
 * `completed` son interactivos, no hay recurrencia y completar no pide
 * comentario. Toda escritura sigue pasando por `taskService`.
 *
 * LÍMITE CONOCIDO: el alcance «Mías/Equipo» es presentación, NO una frontera de
 * seguridad. La RLS todavía devuelve todas las tareas del negocio a cualquiera
 * con `orders`; recortarlo server-side es TASKS-V2-4.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ListChecks, SlidersHorizontal, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  AppPageHeader, AppButton, AppSearchInput, AppSelect, AppBadge,
  AppEmptyState, AppErrorState, AppLoadingState, AppConfirmDialog, AddIcon,
} from '../ui'
import { colors } from '../lib/tokens'
import {
  taskService, getAvailableTransitions,
  type PersistedTaskStatus, type TaskRecord,
} from '../services/taskService'
import { TaskListItem } from '../components/tasks/TaskListItem'
import { TaskDetailDialog } from '../components/tasks/TaskDetailDialog'
import { TaskFormDialog } from '../components/tasks/TaskFormDialog'
import { toUserMessage } from '../components/tasks/taskErrors'
import {
  groupTasksByTime, countActive, TASK_GROUP_ORDER, TASK_GROUP_LABEL,
} from '../components/tasks/taskGrouping'

type Task = TaskRecord

interface Profile {
  id: string
  user_id: string | null
  full_name: string | null
  email: string | null
  role: string | null
}

/** Alcance de lectura. Presentación, no seguridad — ver cabecera del archivo. */
type Scope = 'mine' | 'team'

export function Tasks() {
  const { businessId, user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const [tasks, setTasks]       = useState<Task[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading]   = useState(true)
  const [loadErr, setLoadErr]   = useState('')

  const [search, setSearch]                 = useState('')
  const [scope, setScope]                   = useState<Scope>('team')
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [showFilters, setShowFilters]       = useState(false)
  const [showCompleted, setShowCompleted]   = useState(false)

  const [selectedId, setSelectedId]   = useState<string | null>(null)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [showCreate, setShowCreate]   = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null)
  const [deleting, setDeleting]       = useState(false)

  /** Escritura en vuelo y errores, ambos anclados a la tarea que los produjo. */
  const [busyId, setBusyId]       = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  const [myProfile, setMyProfile] = useState<Profile | null>(null)
  const isAdmin = myProfile?.role === 'owner' || myProfile?.role === 'admin'

  const profileMap = useMemo(() => {
    const m = new Map<string, Profile>()
    profiles.forEach(p => {
      if (p.user_id) m.set(p.user_id, p)
      m.set(p.id, p)
    })
    return m
  }, [profiles])

  // ── Carga ──────────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    if (!businessId) return
    setLoading(true); setLoadErr('')
    try {
      const [allTasksRaw, profilesRes] = await Promise.all([
        taskService.getTasks(businessId),
        supabase.from('profiles').select('id, user_id, full_name, email, role').eq('business_id', businessId).eq('is_active', true),
      ])
      let allTasks = allTasksRaw
      const allProfiles = (profilesRes.data || []) as Profile[]
      setProfiles(allProfiles)

      const me = allProfiles.find(p => p.user_id === user?.id || p.id === user?.id)
      setMyProfile(me || null)

      // Recorte de visibilidad para no-admins. Sigue siendo de CLIENTE: la RLS
      // deja leer todas las tareas del negocio. La autoridad server-side es
      // TASKS-V2-4 y NO se toca acá.
      if (me && me.role !== 'owner' && me.role !== 'admin') {
        allTasks = allTasks.filter(t => t.assigned_to === user?.id || t.user_id === user?.id)
      }
      setTasks(allTasks)
    } catch (e: unknown) {
      // Un fallo de lectura no se convierte en lista vacía (contrato V2-0).
      setLoadErr(toUserMessage(e, 'No pudimos cargar las tareas.'))
      setTasks([])
    } finally { setLoading(false) }
  }, [businessId, user?.id])

  useEffect(() => { void loadData() }, [loadData])

  // Handoff desde el dashboard. Se limpia el state al consumirlo para que un
  // refresh o un back no reabran el formulario.
  const createHandoffDone = useRef(false)
  useEffect(() => {
    if (createHandoffDone.current) return
    if ((location.state as { openCreate?: boolean } | null)?.openCreate) {
      createHandoffDone.current = true
      setShowCreate(true)
      navigate(location.pathname, { replace: true, state: null })
    }
  }, [location.state, location.pathname, navigate])

  // ── Derivados ──────────────────────────────────────────────────────────────

  /**
   * «Equipo» sólo se ofrece a quien ya ve tareas de otros. Para el resto la
   * lista es su propia lista, así que un toggle sería decorativo — y ofrecerlo
   * insinuaría un permiso que no existe.
   */
  const canSeeTeam = isAdmin

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tasks.filter(t => {
      if (canSeeTeam && scope === 'mine') {
        const uid = t.assigned_to || t.user_id
        if (uid !== user?.id) return false
      }
      if (priorityFilter !== 'all') {
        // `urgent` es histórico: la base lo admite pero el tipo del producto sólo
        // declara tres niveles, así que se compara ensanchando a string. Se
        // presenta —y por lo tanto se filtra— como Alta.
        const raw = t.priority as string
        const shown = raw === 'urgent' ? 'high' : raw
        if (shown !== priorityFilter) return false
      }
      if (q && !t.title.toLowerCase().includes(q)) return false
      return true
    })
  }, [tasks, search, scope, canSeeTeam, priorityFilter, user?.id])

  const groups      = useMemo(() => groupTasksByTime(visible), [visible])
  const activeCount = countActive(groups)
  const overdueCount = groups.overdue.length
  const selectedTask = useMemo(() => tasks.find(t => t.id === selectedId) ?? null, [tasks, selectedId])

  // ── Escrituras ─────────────────────────────────────────────────────────────

  const setRowError = (taskId: string, message: string | null) =>
    setRowErrors(prev => {
      const next = { ...prev }
      if (message) next[taskId] = message
      else delete next[taskId]
      return next
    })

  /** Único camino de cambio de estado. El estado local sigue al servidor. */
  const applyStatusChange = useCallback(async (task: Task, next: PersistedTaskStatus) => {
    const updated = await taskService.setTaskStatus(
      task.id, businessId || '', user?.id || '', next, task.status,
    )
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...updated } : t))
  }, [businessId, user?.id])

  const handleToggleComplete = async (task: Task) => {
    const [next] = getAvailableTransitions(task.status)
    if (!next || busyId) return
    setBusyId(task.id); setRowError(task.id, null)
    try {
      await applyStatusChange(task, next)
    } catch (e: unknown) {
      setRowError(task.id, toUserMessage(e))
    } finally { setBusyId(null) }
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await taskService.deleteTask(deleteTarget.id)
      setTasks(prev => prev.filter(t => t.id !== deleteTarget.id))
      if (selectedId === deleteTarget.id) setSelectedId(null)
      setDeleteTarget(null)
    } catch (e: unknown) {
      setRowError(deleteTarget.id, toUserMessage(e))
      setDeleteTarget(null)
    } finally { setDeleting(false) }
  }

  const handleSaved = (task: Task) => {
    setTasks(prev => prev.some(t => t.id === task.id)
      ? prev.map(t => t.id === task.id ? task : t)
      : [task, ...prev])
    setShowCreate(false); setEditingTask(null)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const scopeButton = (value: Scope, label: string) => (
    <button
      type="button"
      className="tasks-scope__option"
      onClick={() => setScope(value)}
      aria-pressed={scope === value}
    >
      {label}
    </button>
  )

  const renderGroup = (key: typeof TASK_GROUP_ORDER[number]) => {
    const list = groups[key]
    if (list.length === 0) return null
    return (
      <section key={key} className="tasks-group">
        <h2 className={`tasks-group__header${key === 'overdue' ? ' tasks-group__header--overdue' : ''}`}>
          {TASK_GROUP_LABEL[key]}
          <span className="tasks-group__count">{list.length}</span>
        </h2>
        <ul className="tasks-list">
          {list.map(t => (
            <TaskListItem
              key={t.id}
              task={t}
              assigneeName={profileMap.get(t.assigned_to || t.user_id || '')?.full_name ?? null}
              showAssignee={canSeeTeam && scope === 'team'}
              busy={busyId === t.id}
              error={rowErrors[t.id] ?? null}
              canComplete={getAvailableTransitions(t.status).length > 0}
              canManage={isAdmin}
              onOpen={() => setSelectedId(t.id)}
              onToggleComplete={() => handleToggleComplete(t)}
              onEdit={() => setEditingTask(t)}
              onDelete={() => setDeleteTarget(t)}
            />
          ))}
        </ul>
      </section>
    )
  }

  return (
    <div className="page-shell">
      <AppPageHeader
        icon={<ListChecks size={20} />}
        title="Tareas"
        description="Trabajo del equipo, ordenado por urgencia"
        badge={overdueCount > 0
          ? <AppBadge variant="error">{overdueCount} vencida{overdueCount > 1 ? 's' : ''}</AppBadge>
          : undefined}
        actions={
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {/* En mobile queda el ícono solo: el nombre accesible lo mantiene
                `aria-label`, y así «Nueva tarea» no compite por el ancho. */}
            <AppButton variant="ghost" size="sm" leftIcon={<RefreshCw size={14} />} onClick={loadData} aria-label="Actualizar">
              <span className="tasks-label-optional">Actualizar</span>
            </AppButton>
            <AppButton variant="indigo" size="sm" leftIcon={<AddIcon size={14} />} onClick={() => setShowCreate(true)}>
              Nueva tarea
            </AppButton>
          </div>
        }
      />

      {/* Barra: buscar + alcance + filtros. En mobile la búsqueda toma su propia
          fila y alcance/filtros comparten la siguiente, en vez de apilarse en
          tres. Las reglas viven en `.tasks-toolbar` (index.css). */}
      <div className="tasks-toolbar">
        <div className="tasks-toolbar__search">
          <AppSearchInput value={search} onChange={setSearch} placeholder="Buscar tarea…" />
        </div>
        {canSeeTeam && (
          <div className="tasks-scope" role="group" aria-label="Alcance">
            {scopeButton('mine', 'Mías')}
            {scopeButton('team', 'Equipo')}
          </div>
        )}
        <AppButton
          className="tasks-toolbar__filters"
          variant={showFilters || priorityFilter !== 'all' ? 'secondary' : 'ghost'}
          size="sm"
          leftIcon={<SlidersHorizontal size={14} />}
          onClick={() => setShowFilters(v => !v)}
          aria-expanded={showFilters}
        >
          Filtros
        </AppButton>
      </div>

      {showFilters && (
        <div style={{ maxWidth: 220, marginBottom: '1rem' }}>
          <AppSelect
            label="Prioridad"
            value={priorityFilter}
            onChange={e => setPriorityFilter(e.target.value)}
            options={[
              { value: 'all',    label: 'Toda prioridad' },
              { value: 'high',   label: 'Alta' },
              { value: 'medium', label: 'Normal' },
              { value: 'low',    label: 'Baja' },
            ]}
          />
        </div>
      )}

      {/* Cargando, error y vacío son tres estados distintos: un fallo de lectura
          nunca se muestra como «no hay tareas». */}
      {loading ? (
        <AppLoadingState type="list" rows={4} />
      ) : loadErr ? (
        // `AppErrorState` no trae `role="alert"`; se envuelve acá para no perder
        // el contrato de anuncio de V2-0 ni tocar una primitiva compartida.
        <div role="alert">
          <AppErrorState message={loadErr} onRetry={loadData} />
        </div>
      ) : activeCount === 0 && groups.completed.length === 0 ? (
        <AppEmptyState
          icon={<ListChecks size={26} />}
          title={search.trim() ? 'Sin resultados' : 'No tenés tareas pendientes.'}
          description={search.trim() ? 'Probá con otra búsqueda.' : undefined}
          action={search.trim() ? undefined : { label: 'Nueva tarea', onClick: () => setShowCreate(true) }}
        />
      ) : (
        <>
          {activeCount === 0 && (
            <AppEmptyState compact icon={<ListChecks size={22} />} title="No tenés tareas pendientes." />
          )}
          {TASK_GROUP_ORDER.map(renderGroup)}

          {/* Completadas: sección secundaria colapsada, no una columna. */}
          {groups.completed.length > 0 && (
            <section>
              <button
                type="button"
                onClick={() => setShowCompleted(v => !v)}
                aria-expanded={showCompleted}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.375rem',
                  background: 'none', border: 'none', cursor: 'pointer', padding: '0.5rem 0',
                  fontSize: '0.72rem', fontWeight: 800, textTransform: 'uppercase',
                  letterSpacing: '0.06em', color: colors.text.muted,
                }}
              >
                {showCompleted ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {TASK_GROUP_LABEL.completed}
                <span style={{ color: colors.text.subtle }}>{groups.completed.length}</span>
              </button>
              {showCompleted && (
                <ul style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {groups.completed.map(t => (
                    <TaskListItem
                      key={t.id}
                      task={t}
                      assigneeName={profileMap.get(t.assigned_to || t.user_id || '')?.full_name ?? null}
                      showAssignee={canSeeTeam && scope === 'team'}
                      busy={busyId === t.id}
                      error={rowErrors[t.id] ?? null}
                      canComplete={getAvailableTransitions(t.status).length > 0}
                      canManage={isAdmin}
                      onOpen={() => setSelectedId(t.id)}
                      onToggleComplete={() => handleToggleComplete(t)}
                      onEdit={() => setEditingTask(t)}
                      onDelete={() => setDeleteTarget(t)}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      {selectedTask && (
        <TaskDetailDialog
          task={selectedTask}
          profileMap={profileMap}
          canManage={isAdmin}
          businessId={businessId || ''}
          userId={user?.id || ''}
          myName={myProfile?.full_name || myProfile?.email || 'Yo'}
          onClose={() => setSelectedId(null)}
          onEdit={() => { setEditingTask(selectedTask); setSelectedId(null) }}
          onStatusChange={s => applyStatusChange(selectedTask, s)}
        />
      )}

      {(showCreate || editingTask) && (
        <TaskFormDialog
          editing={editingTask}
          profiles={profiles}
          businessId={businessId || ''}
          userId={user?.id || ''}
          onSaved={handleSaved}
          onClose={() => { setShowCreate(false); setEditingTask(null) }}
        />
      )}

      <AppConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
        title="Eliminar tarea"
        description={deleteTarget ? `«${deleteTarget.title}» se elimina de forma permanente.` : undefined}
        confirmLabel="Eliminar"
        isDanger
        loading={deleting}
      />
    </div>
  )
}
