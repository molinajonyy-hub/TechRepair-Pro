import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Plus, X, Check, Clock, CheckCircle2, Circle,
  ChevronRight, MoreHorizontal, Calendar, User, MessageSquare,
  History, ListChecks, Edit2, Trash2, RefreshCw, LayoutGrid, List,
  BarChart3, Filter, Send, AlertTriangle,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { requireFeature, getFeatureErrorMessage, isFeatureError } from '../utils/requireFeature'
import {
  taskService,
  getAvailableTransitions,
  isTaskServiceError,
  PERSISTED_TASK_STATUSES_CURRENT,
  type PersistedTaskStatus,
  type TaskStatus,
  type TaskPriority,
  type TaskRecord,
  type TaskChecklistItem,
  type TaskCommentRow,
  type TaskHistoryRow,
} from '../services/taskService'
import { AppPageHeader, AppButton, AppIconButton } from '../ui'
import { AddIcon, DeleteIcon } from '../ui/icons'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * TASKS-V2-0 — toda escritura pasa por `taskService`. Esta página no escribe
 * contra Supabase: sólo lee (tareas, perfiles) y muestra errores.
 *
 * Los estados `in_progress` y `cancelled` NO se ofrecen: la base sólo persiste
 * `pending | completed` (CHECK `tasks_status_check`). Se siguen pudiendo RENDERIZAR
 * por si existe alguna fila histórica. Contrato temporal hasta TASKS-V2-3.
 */

/** Mensaje de error genérico para fallos que no vienen tipados del servicio. */
const FALLBACK_ERROR = 'No pudimos guardar el cambio.'

/** Traduce cualquier fallo a algo que el usuario pueda leer y accionar. */
function toUserMessage(e: unknown): string {
  if (isTaskServiceError(e)) return e.message
  if (isFeatureError(e))     return getFeatureErrorMessage(e)
  return FALLBACK_ERROR
}

/** La forma de la fila la define el servicio: una sola definición para todo el módulo. */
type Task = TaskRecord

type TaskItem = TaskChecklistItem
type TaskComment = TaskCommentRow & { user_name?: string }
type TaskHistory = TaskHistoryRow & { user_name?: string }

interface Profile {
  id: string
  user_id: string | null
  full_name: string | null
  email: string | null
  role: string | null
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PRIORITY_META: Record<TaskPriority, { label: string; color: string; bg: string; border: string }> = {
  low:    { label: 'Baja',   color: '#34d399', bg: 'rgba(52,211,153,0.1)',  border: 'rgba(52,211,153,0.35)'  },
  medium: { label: 'Media',  color: '#fbbf24', bg: 'rgba(251,191,36,0.1)',  border: 'rgba(251,191,36,0.35)'  },
  high:   { label: 'Alta',   color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.35)' },
}

/**
 * Metadatos de presentación de los CUATRO estados.
 *
 * `in_progress` y `cancelled` siguen acá a propósito: si una fila histórica los
 * tuviera, hay que poder mostrarla sin romperse. Lo que NO se deriva de acá son
 * las acciones: para eso está `getAvailableTransitions`, que sólo devuelve
 * estados que la base persiste hoy.
 */
const STATUS_META: Record<TaskStatus, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  pending:     { label: 'Pendiente',  color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', icon: Circle       },
  in_progress: { label: 'En proceso', color: '#818cf8', bg: 'rgba(99,102,241,0.12)',  icon: Clock        },
  completed:   { label: 'Completada', color: '#34d399', bg: 'rgba(52,211,153,0.12)',  icon: CheckCircle2 },
  cancelled:   { label: 'Cancelada',  color: '#f87171', bg: 'rgba(248,113,113,0.12)', icon: X            },
}

/** Fallback por si llega un estado desconocido desde la base. */
const statusMeta = (s: string) => STATUS_META[s as TaskStatus] ?? STATUS_META.pending

const ACTION_LABELS: Record<string, string> = {
  created: 'Tarea creada',
  status_changed: 'Estado cambiado',
  reassigned: 'Reasignada',
  commented: 'Comentario agregado',
  checklist: 'Checklist actualizado',
}

/** Columnas del kanban = estados que la base persiste. Hoy: Pendiente y Completada. */
const KANBAN_COLUMNS: PersistedTaskStatus[] = [...PERSISTED_TASK_STATUSES_CURRENT]

// ─── Helpers ──────────────────────────────────────────────────────────────────

import { fmtDateCompact as fmtDate, fmtFull } from '../utils/dateUtils'
const isOverdue = (task: Task) => !!task.due_date && task.status !== 'completed' && task.status !== 'cancelled' && new Date(task.due_date + 'T23:59:59') < new Date()
const isDueSoon = (task: Task) => {
  if (!task.due_date || isOverdue(task) || task.status === 'completed') return false
  const diff = new Date(task.due_date + 'T23:59:59').getTime() - Date.now()
  return diff > 0 && diff < 48 * 3600 * 1000
}
const initials = (name: string | null | undefined) => (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
const today    = () => new Date().toISOString().split('T')[0]

// ─── TaskCard ─────────────────────────────────────────────────────────────────

interface TaskCardProps {
  task: Task
  assigneeName: string | null
  isAdmin: boolean
  onSelect: () => void
  onStatusChange: (s: PersistedTaskStatus) => void
  onDelete: () => void
}

function TaskCard({ task, assigneeName, isAdmin, onSelect, onStatusChange, onDelete }: TaskCardProps) {
  const pm   = PRIORITY_META[task.priority] || PRIORITY_META.medium
  const over = isOverdue(task)
  const soon = isDueSoon(task)
  const [menuOpen, setMenuOpen] = useState(false)

  const nextStatuses = getAvailableTransitions(task.status)

  return (
    <div className="card-interactive" style={{
      background: 'rgba(255,255,255,0.025)',
      border: `1px solid ${over ? 'rgba(248,113,113,0.25)' : 'rgba(255,255,255,0.06)'}`,
      borderLeft: `4px solid ${pm.color}`,
      borderRadius: '0.625rem',
      padding: '0.875rem 0.875rem 0.875rem 0.75rem',
      cursor: 'pointer',
      position: 'relative',
    }}
      onClick={onSelect}
    >
      {/* Priority + overdue badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '0.5rem' }}>
        <span className={`badge ${task.priority === 'high' ? 'badge-error' : task.priority === 'medium' ? 'badge-warning' : 'badge-success'}`} style={{ borderRadius: '0.25rem' }}>
          {pm.label}
        </span>
        {over && <span className="badge badge-error" style={{ borderRadius: '0.25rem' }}>Vencida</span>}
        {soon && !over && <span className="badge badge-warning" style={{ borderRadius: '0.25rem' }}>Vence pronto</span>}

        {/* Menu */}
        {isAdmin && (
          <button onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#334155', padding: '0.1rem', display: 'flex', alignItems: 'center' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#94a3b8')}
            onMouseLeave={e => (e.currentTarget.style.color = '#334155')}>
            <MoreHorizontal size={14} />
          </button>
        )}
        {menuOpen && (
          <div style={{ position: 'absolute', top: '2rem', right: '0.5rem', background: 'var(--bg-modal)', border: '1px solid var(--border-color)', borderRadius: '0.5rem', padding: '0.25rem', zIndex: 99, minWidth: 120, boxShadow: 'var(--shadow-lg)' }}
            onClick={e => e.stopPropagation()}>
            {nextStatuses.map(s => (
              <button key={s} onClick={() => { onStatusChange(s); setMenuOpen(false) }}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', padding: '0.4rem 0.625rem', background: 'none', border: 'none', cursor: 'pointer', color: STATUS_META[s].color, fontSize: '0.78rem', fontWeight: 600, borderRadius: '0.25rem' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                → {STATUS_META[s].label}
              </button>
            ))}
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', margin: '0.25rem 0' }} />
            <button onClick={() => { onDelete(); setMenuOpen(false) }}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', padding: '0.4rem 0.625rem', background: 'none', border: 'none', cursor: 'pointer', color: '#f87171', fontSize: '0.78rem', fontWeight: 600, borderRadius: '0.25rem' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(248,113,113,0.08)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
              <Trash2 size={11} /> Eliminar
            </button>
          </div>
        )}
      </div>

      {/* Title */}
      <p style={{ margin: '0 0 0.375rem', fontWeight: 600, fontSize: '0.875rem', color: '#e2e8f0', lineHeight: 1.3 }}>
        {task.title}
      </p>

      {/* Description */}
      {task.description && (
        <p style={{ margin: '0 0 0.5rem', fontSize: '0.75rem', color: '#475569', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {task.description}
        </p>
      )}

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginTop: '0.625rem' }}>
        {assigneeName && (
          <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', fontWeight: 800, color: '#818cf8', flexShrink: 0 }}>
            {initials(assigneeName)}
          </div>
        )}
        {task.due_date && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.7rem', color: over ? '#f87171' : soon ? '#fbbf24' : '#334155' }}>
            <Calendar size={10} /> {fmtDate(task.due_date)}
          </span>
        )}
        <ChevronRight size={11} style={{ marginLeft: 'auto', color: '#1e3a5f' }} />
      </div>
    </div>
  )
}

// ─── CreateEditModal ──────────────────────────────────────────────────────────

interface FormState { title: string; description: string; priority: TaskPriority; assigned_to: string; due_date: string }
const emptyForm = (): FormState => ({ title: '', description: '', priority: 'medium', assigned_to: '', due_date: '' })

interface CreateEditModalProps {
  editing: Task | null
  profiles: Profile[]
  businessId: string
  userId: string
  onSaved: (task: Task) => void
  onClose: () => void
}

function CreateEditModal({ editing, profiles, businessId, userId, onSaved, onClose }: CreateEditModalProps) {
  const [form, setForm] = useState<FormState>(editing ? {
    title: editing.title, description: editing.description || '',
    priority: editing.priority, assigned_to: editing.assigned_to || '',
    due_date: editing.due_date || '',
  } : emptyForm())
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const handleSave = async () => {
    if (!form.title.trim()) { setErr('El título es obligatorio'); return }
    if (!form.assigned_to) { setErr('Debés asignar un usuario'); return }
    setSaving(true); setErr('')
    try {
      await requireFeature(businessId!, 'tasks', 'create_or_edit_task')
      const input = {
        title:       form.title.trim(),
        description: form.description || null,
        priority:    form.priority,
        assigned_to: form.assigned_to,
        due_date:    form.due_date || null,
      }
      // La recurrencia no viaja en el payload: el control está oculto hasta que
      // exista el scheduler (TASKS V2 P1). En edición, omitirla preserva el
      // valor histórico de la fila en vez de resetearlo.
      const saved = editing
        ? await taskService.updateTask(editing.id, input)
        : await taskService.createTask(businessId, userId, input)
      // Sólo después de que el servidor confirmó: nunca cerrar como si hubiera
      // funcionado. Las columnas que el servicio no devuelve se toman de la fila
      // que ya estaba en memoria, para no perder la recurrencia histórica.
      onSaved({
        business_id:     businessId,
        created_by:      editing?.created_by ?? userId,
        is_recurring:    editing?.is_recurring ?? false,
        recurrence_type: editing?.recurrence_type ?? null,
        updated_at:      new Date().toISOString(),
        ...saved,
      })
    } catch (e: unknown) {
      setErr(toUserMessage(e))
    } finally { setSaving(false) }
  }

  const inputS: React.CSSProperties = { width: '100%', padding: '0.5625rem 0.875rem', background: 'var(--input-bg)', border: '1px solid var(--input-border)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' as const }
  const labelS: React.CSSProperties = { display: 'block', fontSize: '0.72rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.35rem', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-modal)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-2xl)', width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', maxHeight: '90vh', boxShadow: 'var(--shadow-xl)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <h2 style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: '1rem' }}>
            {editing ? 'Editar tarea' : 'Nueva tarea'}
          </h2>
          <AppButton variant="ghost" size="sm" onClick={onClose}><X size={16} /></AppButton>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={labelS}>Título *</label>
            <input style={{ ...inputS, fontSize: '1rem', fontWeight: 600 }} value={form.title}
              onChange={e => setForm(p => ({ ...p, title: e.target.value }))} placeholder="¿Qué hay que hacer?" autoFocus />
          </div>
          <div>
            <label style={labelS}>Descripción</label>
            <textarea style={{ ...inputS, minHeight: 80, resize: 'vertical' as const, lineHeight: 1.5 }}
              value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="Detalle o instrucciones..." />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label style={labelS}>Prioridad</label>
              <select style={inputS} value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value as TaskPriority }))}>
                <option value="low">Baja</option>
                <option value="medium">Media</option>
                <option value="high">Alta</option>
              </select>
            </div>
            <div>
              <label style={labelS}>Fecha límite</label>
              <input style={inputS} type="date" value={form.due_date} min={today()}
                onChange={e => setForm(p => ({ ...p, due_date: e.target.value }))} />
            </div>
          </div>
          <div>
            <label style={labelS}>Asignar a *</label>
            <select style={inputS} value={form.assigned_to} onChange={e => setForm(p => ({ ...p, assigned_to: e.target.value }))}>
              <option value="">— Seleccioná un usuario —</option>
              {profiles.map(p => (
                <option key={p.id} value={p.user_id || p.id}>{p.full_name || p.email || 'Usuario'}</option>
              ))}
            </select>
          </div>
          {/* La recurrencia está intencionalmente oculta hasta que exista el
              scheduler (TASKS V2 P1). Las columnas siguen en la base y las filas
              históricas se conservan; lo que no se hace es invitar al usuario a
              crear algo que el sistema todavía no ejecuta. */}
          {err && <p role="alert" style={{ margin: 0, color: 'var(--error)', fontSize: '0.8rem', fontWeight: 600 }}>{err}</p>}
        </div>

        <div style={{ flexShrink: 0, padding: '1rem 1.5rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', background: 'var(--bg-modal)', borderRadius: '0 0 var(--radius-2xl) var(--radius-2xl)' }}>
          <AppButton variant="secondary" onClick={onClose}>Cancelar</AppButton>
          <AppButton variant="indigo" loading={saving} onClick={handleSave} leftIcon={<Check size={14} />}>
            {editing ? 'Guardar cambios' : 'Crear tarea'}
          </AppButton>
        </div>
      </div>
    </div>
  )
}

// ─── TaskDetailPanel ──────────────────────────────────────────────────────────

type DetailTab = 'details' | 'checklist' | 'comments' | 'history'

interface TaskDetailPanelProps {
  task: Task
  profiles: Profile[]
  profileMap: Map<string, Profile>
  isAdmin: boolean
  businessId: string
  userId: string
  myName: string
  onClose: () => void
  onEdit: () => void
  /** Lanza si el servidor rechaza el cambio: el panel muestra el error y no toca el estado local. */
  onStatusChange: (s: PersistedTaskStatus) => Promise<void>
  onUpdated: (t: Task) => void
}

function TaskDetailPanel({ task, profiles: _profiles, profileMap, isAdmin, businessId, userId, myName, onClose, onEdit, onStatusChange, onUpdated: _onUpdated }: TaskDetailPanelProps) {
  const [tab, setTab]           = useState<DetailTab>('details')
  const [items, setItems]       = useState<TaskItem[]>([])
  const [comments, setComments] = useState<TaskComment[]>([])
  const [history, setHistory]   = useState<TaskHistory[]>([])
  const [loadingTab, setLoadingTab] = useState(false)
  const [newComment, setNewComment] = useState('')
  const [newItem, setNewItem]   = useState('')
  const [savingComment, setSavingComment] = useState(false)
  const [completionErr, setCompletionErr] = useState('')
  const [tabErr, setTabErr]     = useState('')
  const [busyStatus, setBusyStatus] = useState(false)

  const pm       = PRIORITY_META[task.priority] || PRIORITY_META.medium
  const assignee = profileMap.get(task.assigned_to || '') || profileMap.get(task.user_id || '')
  const doneItems = items.filter(i => i.is_done).length
  const allDone   = items.length > 0 && doneItems === items.length

  useEffect(() => {
    loadTabData(tab)
  }, [task.id, tab])

  const loadTabData = async (t: DetailTab) => {
    setLoadingTab(true); setTabErr('')
    try {
      if (t === 'checklist') {
        setItems(await taskService.getChecklist(task.id))
      } else if (t === 'comments') {
        const rows = await taskService.getComments(task.id)
        setComments(rows.map(c => ({ ...c, user_name: profileMap.get(c.user_id)?.full_name || 'Usuario' })))
      } else if (t === 'history') {
        const rows = await taskService.getHistory(task.id)
        setHistory(rows.map(h => ({ ...h, user_name: profileMap.get(h.user_id || '')?.full_name || 'Sistema' })))
      }
    } catch (e: unknown) {
      setTabErr(toUserMessage(e))
    } finally { setLoadingTab(false) }
  }

  const handleAddComment = async () => {
    if (!newComment.trim()) return
    setSavingComment(true); setTabErr('')
    try {
      const saved = await taskService.addComment(task.id, businessId, userId, newComment.trim())
      setComments(prev => [...prev, { ...saved, user_name: myName }])
      setNewComment('')
    } catch (e: unknown) {
      setTabErr(toUserMessage(e))
    } finally { setSavingComment(false) }
  }

  const handleToggleItem = async (item: TaskItem) => {
    setTabErr('')
    try {
      const saved = await taskService.toggleChecklistItem(item, businessId, userId)
      setItems(prev => prev.map(i => i.id === item.id ? saved : i))
    } catch (e: unknown) { setTabErr(toUserMessage(e)) }
  }

  const handleAddItem = async () => {
    if (!newItem.trim()) return
    setTabErr('')
    try {
      const saved = await taskService.addChecklistItem(task.id, businessId, newItem.trim(), items.length)
      setItems(prev => [...prev, saved])
      setNewItem('')
    } catch (e: unknown) { setTabErr(toUserMessage(e)) }
  }

  const handleDeleteItem = async (id: string) => {
    setTabErr('')
    try {
      await taskService.deleteChecklistItem(id)
      setItems(prev => prev.filter(i => i.id !== id))
    } catch (e: unknown) { setTabErr(toUserMessage(e)) }
  }

  /**
   * Las reglas de compleción (checklist completo + comentario de cierre) las
   * valida `taskService`, no esta pantalla: así rigen también cuando se completa
   * desde una card. Acá sólo se traduce el motivo a la pestaña correspondiente.
   */
  const handleStatusChange = async (s: PersistedTaskStatus) => {
    setCompletionErr(''); setBusyStatus(true)
    try {
      await onStatusChange(s)
    } catch (e: unknown) {
      setCompletionErr(toUserMessage(e))
      if (isTaskServiceError(e) && e.reason === 'checklist') setTab('checklist')
      if (isTaskServiceError(e) && e.reason === 'comment')   setTab('comments')
    } finally { setBusyStatus(false) }
  }

  const tabStyle = (t: DetailTab): React.CSSProperties => ({
    padding: '0.5rem 0.875rem', background: 'none', border: 'none', cursor: 'pointer',
    fontSize: '0.8rem', fontWeight: 600, borderBottom: tab === t ? '2px solid var(--accent-primary)' : '2px solid transparent',
    color: tab === t ? 'var(--accent-primary)' : '#475569', transition: 'all 0.15s',
  })

  const nextStatuses = getAvailableTransitions(task.status)

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 440, background: 'var(--bg-modal)', borderLeft: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', zIndex: 888, boxShadow: '-8px 0 32px rgba(0,0,0,0.4)' }}>
      {/* Header */}
      <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
              <span className={`badge ${task.priority === 'high' ? 'badge-error' : task.priority === 'medium' ? 'badge-warning' : 'badge-success'}`} style={{ borderRadius: '0.25rem' }}>{pm.label}</span>
              <span className={`badge ${task.status === 'completed' ? 'badge-success' : task.status === 'cancelled' ? 'badge-error' : task.status === 'in_progress' ? 'badge-info' : 'badge-neutral'}`} style={{ borderRadius: '0.25rem' }}>
                {statusMeta(task.status).label}
              </span>
              {isOverdue(task) && <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.1rem 0.4rem', borderRadius: '0.25rem', background: 'rgba(248,113,113,0.12)', color: '#f87171' }}>Vencida</span>}
            </div>
            <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.3 }}>{task.title}</h2>
          </div>
          <div style={{ display: 'flex', gap: '0.375rem', flexShrink: 0 }}>
            {isAdmin && <AppIconButton icon={<Edit2 size={13} />} label="Editar" size="xs" onClick={onEdit} />}
            <AppIconButton icon={<X size={14} />} label="Cerrar" size="xs" onClick={onClose} />
          </div>
        </div>

        {/* Status actions */}
        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' as const }}>
          {nextStatuses.map(s => (
            <button key={s} onClick={() => handleStatusChange(s)} disabled={busyStatus}
              style={{ padding: '0.3rem 0.75rem', borderRadius: '0.375rem', border: `1px solid ${STATUS_META[s].color}44`, background: STATUS_META[s].bg, color: STATUS_META[s].color, fontSize: '0.75rem', fontWeight: 700, cursor: busyStatus ? 'not-allowed' : 'pointer', opacity: busyStatus ? 0.6 : 1 }}>
              → {STATUS_META[s].label}
            </button>
          ))}
        </div>
        {completionErr && <p role="alert" style={{ margin: '0.5rem 0 0', color: 'var(--error)', fontSize: '0.75rem', fontWeight: 600 }}>{completionErr}</p>}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0, overflowX: 'auto' as const }}>
        {([['details','Detalles'], ['checklist','Checklist'], ['comments','Comentarios'], ['history','Historial']] as [DetailTab, string][]).map(([t, l]) => (
          <button key={t} style={tabStyle(t)} onClick={() => setTab(t)}>{l}</button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem' }}>
        {tabErr && (
          <p role="alert" style={{ margin: '0 0 0.75rem', padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 'var(--radius-sm)', color: '#f87171', fontSize: '0.78rem', fontWeight: 600 }}>
            {tabErr}
          </p>
        )}
        {loadingTab ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
            <div style={{ width: 24, height: 24, border: '2px solid var(--accent-primary)', borderTop: '2px solid transparent', borderRadius: '50%', animation: 'tr-spin 1s linear infinite' }} />
          </div>
        ) : tab === 'details' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {task.description && (
              <div>
                <p style={{ margin: '0 0 0.375rem', fontSize: '0.72rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Descripción</p>
                <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.875rem', lineHeight: 1.6, whiteSpace: 'pre-wrap' as const }}>{task.description}</p>
              </div>
            )}
            {[
              { label: 'Asignado a', value: assignee?.full_name || assignee?.email || '—', icon: <User size={13} /> },
              { label: 'Fecha límite', value: task.due_date ? fmtDate(task.due_date) : '—', icon: <Calendar size={13} /> },
              { label: 'Iniciada',    value: task.started_at ? fmtFull(task.started_at) : '—', icon: <Clock size={13} /> },
              { label: 'Completada',  value: task.completed_at ? fmtFull(task.completed_at) : '—', icon: <CheckCircle2 size={13} /> },
              // Sólo se muestra si la fila YA era recurrente (histórica). No se
              // ofrece crear ni editar recurrencia hasta el scheduler de P1.
              ...(task.is_recurring
                ? [{ label: 'Recurrencia', value: task.recurrence_type || '—', icon: <RefreshCw size={13} /> }]
                : []),
            ].map(r => (
              <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 0.875rem', background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ color: '#475569', flexShrink: 0 }}>{r.icon}</span>
                <span style={{ fontSize: '0.75rem', color: '#475569', fontWeight: 600, minWidth: 80 }}>{r.label}</span>
                <span style={{ fontSize: '0.875rem', color: 'var(--text-primary)', fontWeight: 500, marginLeft: 'auto', textAlign: 'right' as const }}>{r.value}</span>
              </div>
            ))}
          </div>
        ) : tab === 'checklist' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {items.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: '9999px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${items.length > 0 ? (doneItems / items.length) * 100 : 0}%`, background: allDone ? '#34d399' : 'var(--accent-primary)', transition: 'width 0.3s' }} />
                </div>
                <span style={{ fontSize: '0.72rem', color: '#475569', fontWeight: 700, flexShrink: 0 }}>{doneItems}/{items.length}</span>
              </div>
            )}
            {items.map(item => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.5rem 0.625rem', background: item.is_done ? 'rgba(52,211,153,0.06)' : 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(255,255,255,0.04)' }}>
                <button onClick={() => handleToggleItem(item)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: item.is_done ? '#34d399' : '#334155', padding: 0, display: 'flex', flexShrink: 0 }}>
                  {item.is_done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                </button>
                <span style={{ flex: 1, fontSize: '0.875rem', color: item.is_done ? '#475569' : 'var(--text-primary)', textDecoration: item.is_done ? 'line-through' : 'none' }}>
                  {item.title}
                </span>
                <button onClick={() => handleDeleteItem(item.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1e3a5f', padding: 0, display: 'flex', flexShrink: 0 }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#f87171')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#1e3a5f')}>
                  <X size={12} />
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: '0.375rem', marginTop: '0.25rem' }}>
              <input value={newItem} onChange={e => setNewItem(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAddItem()}
                placeholder="Agregar ítem..." style={{ flex: 1, padding: '0.5rem 0.75rem', background: 'var(--input-bg)', border: '1px solid var(--input-border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: '0.85rem', outline: 'none' }} />
              <button onClick={handleAddItem} style={{ padding: '0.5rem 0.75rem', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 'var(--radius-sm)', color: '#818cf8', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 }}>
                <Plus size={14} />
              </button>
            </div>
          </div>
        ) : tab === 'comments' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {comments.length === 0 && (
              <div style={{ textAlign: 'center', color: '#334155', padding: '1.5rem 0', fontSize: '0.8rem' }}>
                <MessageSquare size={24} style={{ margin: '0 auto 0.5rem', opacity: 0.3 }} />
                Sin comentarios aún
              </div>
            )}
            {comments.map(c => (
              <div key={c.id} style={{ display: 'flex', gap: '0.625rem' }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', fontWeight: 800, color: '#818cf8', flexShrink: 0, marginTop: '0.125rem' }}>
                  {initials(c.user_name)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                    <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{c.user_name}</span>
                    <span style={{ fontSize: '0.68rem', color: '#334155' }}>{fmtFull(c.created_at)}</span>
                  </div>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-primary)', lineHeight: 1.5, background: 'var(--bg-surface)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-md)', whiteSpace: 'pre-wrap' as const }}>
                    {c.comment}
                  </p>
                </div>
              </div>
            ))}
            <div style={{ marginTop: '0.5rem' }}>
              <textarea value={newComment} onChange={e => setNewComment(e.target.value)} rows={3}
                placeholder="Escribí tu comentario..." style={{ width: '100%', padding: '0.625rem 0.875rem', background: 'var(--input-bg)', border: '1px solid var(--input-border)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', fontSize: '0.875rem', outline: 'none', resize: 'vertical' as const, boxSizing: 'border-box' as const }} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <AppButton variant="indigo" size="sm" loading={savingComment} onClick={handleAddComment} leftIcon={<Send size={12} />}>
                  Comentar
                </AppButton>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            {history.length === 0 && <p style={{ color: '#334155', fontSize: '0.8rem', textAlign: 'center', padding: '1.5rem 0' }}>Sin historial aún</p>}
            {history.map(h => (
              <div key={h.id} style={{ display: 'flex', gap: '0.625rem', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <History size={13} style={{ color: '#475569' }} />
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                    {ACTION_LABELS[h.action] || h.action}
                    {h.old_value && h.new_value && <span style={{ fontWeight: 400, color: '#475569' }}>{' '}— {h.old_value} → {h.new_value}</span>}
                  </p>
                  <p style={{ margin: '0.1rem 0 0', fontSize: '0.68rem', color: '#334155' }}>
                    {h.user_name} · {fmtFull(h.created_at)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── MetricsPanel ─────────────────────────────────────────────────────────────

interface MetricsPanelProps {
  tasks: Task[]
  profileMap: Map<string, Profile>
}

function MetricsPanel({ tasks, profileMap }: MetricsPanelProps) {
  const byUser = useMemo(() => {
    const map: Record<string, { name: string; pending: number; completed: number; overdue: number }> = {}
    tasks.forEach(t => {
      const uid  = t.assigned_to || t.user_id || 'sin-asignar'
      const name = profileMap.get(uid)?.full_name || profileMap.get(uid)?.email || 'Sin asignar'
      if (!map[uid]) map[uid] = { name, pending: 0, completed: 0, overdue: 0 }
      if (t.status === 'pending')   map[uid].pending++
      if (t.status === 'completed') map[uid].completed++
      if (isOverdue(t))             map[uid].overdue++
    })
    return Object.values(map).sort((a, b) => b.pending - a.pending)
  }, [tasks, profileMap])

  // Sin métrica de «En proceso»: ese estado no lo persiste la base, así que
  // siempre sería 0. Vuelve en V2-3.
  const totalPending   = tasks.filter(t => t.status === 'pending').length
  const totalCompleted = tasks.filter(t => t.status === 'completed').length
  const totalOverdue   = tasks.filter(t => isOverdue(t)).length
  const dueToday = tasks.filter(t => t.due_date === today() && t.status !== 'completed').length

  return (
    <div style={{ background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 'var(--radius-lg)', padding: '1.25rem', marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <BarChart3 size={15} style={{ color: 'var(--accent-primary)' }} />
        <h3 style={{ margin: 0, fontSize: '0.82rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Métricas del equipo</h3>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '1.25rem' }}>
        {[
          { label: 'Pendientes', value: totalPending, color: '#94a3b8' },
          { label: 'Completadas', value: totalCompleted, color: '#34d399' },
          { label: 'Vencen hoy', value: dueToday, color: '#fbbf24' },
          { label: 'Vencidas', value: totalOverdue, color: '#f87171' },
        ].map(m => (
          <div key={m.label} style={{ textAlign: 'center', padding: '0.75rem', background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-md)' }}>
            <div style={{ fontSize: '1.75rem', fontWeight: 800, color: m.color, fontFamily: 'monospace' }}>{m.value}</div>
            <div style={{ fontSize: '0.68rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{m.label}</div>
          </div>
        ))}
      </div>
      <div style={{ overflowX: 'auto' as const }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
          <thead>
            <tr>
              {['Usuario', 'Pendientes', 'Completadas', 'Vencidas'].map(h => (
                <th key={h} style={{ padding: '0.375rem 0.625rem', textAlign: h === 'Usuario' ? 'left' : 'center', color: '#334155', fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {byUser.map(u => (
              <tr key={u.name}>
                <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-primary)', fontWeight: 600 }}>{u.name}</td>
                <td style={{ padding: '0.5rem 0.625rem', textAlign: 'center', color: '#94a3b8' }}>{u.pending}</td>
                <td style={{ padding: '0.5rem 0.625rem', textAlign: 'center', color: '#34d399', fontWeight: u.completed > 0 ? 700 : 400 }}>{u.completed}</td>
                <td style={{ padding: '0.5rem 0.625rem', textAlign: 'center', color: u.overdue > 0 ? '#f87171' : '#334155', fontWeight: u.overdue > 0 ? 700 : 400 }}>{u.overdue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Tasks Page ───────────────────────────────────────────────────────────────

export function Tasks() {
  const { businessId, user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const [tasks, setTasks]       = useState<Task[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading]   = useState(true)
  const [loadErr, setLoadErr]   = useState('')
  const [actionErr, setActionErr] = useState('')
  const [view, setView]         = useState<'kanban' | 'list'>('kanban')

  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [editingTask, setEditingTask]   = useState<Task | null>(null)
  const [showCreate, setShowCreate]     = useState(false)
  const [showMetrics, setShowMetrics]   = useState(false)

  // Filters
  const [filterUser, setFilterUser]         = useState('all')
  const [filterPriority, setFilterPriority] = useState('all')
  const [filterStatus, setFilterStatus]     = useState('all')
  const [searchQ, setSearchQ]               = useState('')

  // Current user's role (from profiles)
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

  // ── Loaders ────────────────────────────────────────────────────────────────

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

      // Filtro de visibilidad para no-admins. Sigue siendo de CLIENTE: la RLS
      // todavía deja leer todas las tareas del negocio. Cerrarlo server-side es
      // TASKS-V2-4 y NO se toca en este lote.
      if (me && me.role !== 'owner' && me.role !== 'admin') {
        allTasks = allTasks.filter(t => t.assigned_to === user?.id || t.user_id === user?.id)
      }
      setTasks(allTasks)
    } catch (e: unknown) {
      // Antes un fallo de lectura dejaba la lista vacía: parecía «no hay tareas».
      setLoadErr(toUserMessage(e))
      setTasks([])
    } finally { setLoading(false) }
  }, [businessId, user?.id])

  useEffect(() => { loadData() }, [loadData])

  // Handoff desde el dashboard: `navigate('/tasks', { state: { openCreate: true } })`.
  // Antes nadie leía ese state y el botón «Nueva tarea» sólo cambiaba de página.
  // Se limpia el state al consumirlo para que un refresh o un back no lo reabran.
  const createHandoffDone = useRef(false)
  useEffect(() => {
    if (createHandoffDone.current) return
    if ((location.state as { openCreate?: boolean } | null)?.openCreate) {
      createHandoffDone.current = true
      setShowCreate(true)
      navigate(location.pathname, { replace: true, state: null })
    }
  }, [location.state, location.pathname, navigate])

  // ── Computed ───────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return tasks.filter(t => {
      if (filterStatus !== 'all' && t.status !== filterStatus) return false
      if (filterPriority !== 'all' && t.priority !== filterPriority) return false
      if (filterUser !== 'all') {
        const uid = t.assigned_to || t.user_id
        if (uid !== filterUser) return false
      }
      if (searchQ.trim() && !t.title.toLowerCase().includes(searchQ.toLowerCase())) return false
      return true
    })
  }, [tasks, filterStatus, filterPriority, filterUser, searchQ])

  const byStatus = useMemo(() => {
    const m: Record<string, Task[]> = {}
    KANBAN_COLUMNS.forEach(s => { m[s] = [] })
    filtered.forEach(t => { if (m[t.status]) m[t.status].push(t) })
    return m
  }, [filtered])

  const alerts = useMemo(() => ({
    overdue: tasks.filter(isOverdue).length,
    pending: tasks.filter(t => t.status === 'pending').length,
  }), [tasks])

  // ── Handlers ──────────────────────────────────────────────────────────────

  /**
   * Único camino de cambio de estado. El estado local se actualiza SÓLO con lo
   * que devolvió el servidor: si la escritura falla, nada cambia en pantalla.
   * Propaga el error para que cada superficie lo muestre donde corresponde.
   */
  const applyStatusChange = useCallback(async (task: Task, newStatus: PersistedTaskStatus) => {
    const updated = await taskService.setTaskStatus(
      task.id, businessId || '', user?.id || '', newStatus, task.status,
    )
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...updated } : t))
    setSelectedTask(prev => prev && prev.id === task.id ? { ...prev, ...updated } : prev)
  }, [businessId, user?.id])

  const handleCardStatusChange = async (task: Task, newStatus: PersistedTaskStatus) => {
    setActionErr('')
    try {
      await applyStatusChange(task, newStatus)
    } catch (e: unknown) {
      setActionErr(toUserMessage(e))
    }
  }

  const handleDelete = async (taskId: string) => {
    if (!confirm('¿Eliminar esta tarea? No se puede deshacer.')) return
    setActionErr('')
    try {
      await taskService.deleteTask(taskId)
      setTasks(prev => prev.filter(t => t.id !== taskId))
      if (selectedTask?.id === taskId) setSelectedTask(null)
    } catch (e: unknown) {
      setActionErr(toUserMessage(e))
    }
  }

  const handleSaved = (task: Task) => {
    setTasks(prev => {
      const exists = prev.find(t => t.id === task.id)
      return exists ? prev.map(t => t.id === task.id ? task : t) : [task, ...prev]
    })
    setShowCreate(false); setEditingTask(null)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const colColors: Record<string, string> = { pending: '#94a3b8', in_progress: '#818cf8', completed: '#34d399' }

  return (
    <div className="page-shell" style={{ paddingRight: selectedTask ? 456 : undefined }}>
      <AppPageHeader
        icon={<ListChecks size={20} />}
        title="Tareas"
        description="Gestión de tareas del equipo"
        actions={
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {/* Alert badges */}
            {alerts.overdue > 0 && (
              <span style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem', borderRadius: '9999px', background: 'rgba(248,113,113,0.12)', color: '#f87171', fontWeight: 700, border: '1px solid rgba(248,113,113,0.25)' }}>
                {alerts.overdue} vencida{alerts.overdue > 1 ? 's' : ''}
              </span>
            )}
            {isAdmin && (
              <AppButton variant="ghost" size="sm" leftIcon={<BarChart3 size={14} />} onClick={() => setShowMetrics(v => !v)}>
                Métricas
              </AppButton>
            )}
            <AppButton variant="ghost" size="sm" leftIcon={view === 'kanban' ? <List size={14} /> : <LayoutGrid size={14} />} onClick={() => setView(v => v === 'kanban' ? 'list' : 'kanban')}>
              {view === 'kanban' ? 'Lista' : 'Kanban'}
            </AppButton>
            <AppButton variant="ghost" size="sm" leftIcon={<RefreshCw size={14} />} onClick={loadData}>Actualizar</AppButton>
            <AppButton variant="indigo" size="sm" leftIcon={<AddIcon size={14} />} onClick={() => setShowCreate(true)}>
              Nueva tarea
            </AppButton>
          </div>
        }
      />

      {/* Metrics */}
      {isAdmin && showMetrics && <MetricsPanel tasks={tasks} profileMap={profileMap} />}

      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' as const, marginBottom: '1.25rem', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flex: '1 1 200px', background: 'var(--input-bg)', border: '1px solid var(--input-border)', borderRadius: 'var(--radius-md)', padding: '0 0.75rem' }}>
          <Filter size={13} style={{ color: '#475569', flexShrink: 0 }} />
          <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Buscar tarea..." style={{ flex: 1, padding: '0.5rem 0', background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: '0.875rem', outline: 'none' }} />
        </div>
        {[
          // Sólo estados persistibles: filtrar por uno inalcanzable daba siempre vacío.
          { value: filterStatus, set: setFilterStatus, opts: [['all','Todos los estados'], ...PERSISTED_TASK_STATUSES_CURRENT.map(s => [s, STATUS_META[s].label] as [string, string])] },
          { value: filterPriority, set: setFilterPriority, opts: [['all','Toda prioridad'],['high','Alta'],['medium','Media'],['low','Baja']] },
        ].map((f, i) => (
          <select key={i} value={f.value} onChange={e => f.set(e.target.value)}
            className="form-select" style={{ width: 'auto', fontSize: '0.8rem', padding: '0.375rem 0.625rem' }}>
            {f.opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        ))}
        {isAdmin && (
          <select value={filterUser} onChange={e => setFilterUser(e.target.value)}
            className="form-select" style={{ width: 'auto', fontSize: '0.8rem', padding: '0.375rem 0.625rem' }}>
            <option value="all">Todos los usuarios</option>
            {profiles.map(p => <option key={p.id} value={p.user_id || p.id}>{p.full_name || p.email || 'Usuario'}</option>)}
          </select>
        )}
      </div>

      {/* Errores de acción y de carga. Antes ambos fallaban en silencio: una
          escritura denegada no decía nada y una lectura denegada se veía como
          «sin tareas». */}
      {(actionErr || loadErr) && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', padding: '0.75rem 1rem', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 'var(--radius-md)', color: '#f87171', fontSize: '0.82rem', fontWeight: 600 }}>
          <AlertTriangle size={15} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{actionErr || loadErr}</span>
          {loadErr
            ? <AppButton variant="ghost" size="sm" onClick={loadData}>Reintentar</AppButton>
            : <AppIconButton icon={<X size={13} />} label="Cerrar" size="xs" onClick={() => setActionErr('')} />}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <div style={{ width: 32, height: 32, border: '3px solid var(--accent-primary)', borderTop: '3px solid transparent', borderRadius: '50%', animation: 'tr-spin 1s linear infinite' }} />
        </div>
      ) : view === 'kanban' ? (
        /* ── Kanban ── */
        <div style={{ display: 'flex', gap: '1rem', overflowX: 'auto' as const, paddingBottom: '1rem', alignItems: 'flex-start' }}>
          {KANBAN_COLUMNS.map(col => {
            const colTasks = byStatus[col]
            const color = colColors[col]
            return (
              <div key={col} style={{ minWidth: 300, flex: '0 0 300px', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                {/* Column header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 0.75rem', background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,255,255,0.05)', borderLeft: `3px solid ${color}` }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 800, color, textTransform: 'uppercase' as const, letterSpacing: '0.06em' }}>
                    {STATUS_META[col].label}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: '0.72rem', fontWeight: 700, background: `${color}22`, color, padding: '0.1rem 0.375rem', borderRadius: '9999px' }}>
                    {colTasks.length}
                  </span>
                </div>
                {/* Cards */}
                {colTasks.length === 0 ? (
                  <div style={{ padding: '1.5rem', textAlign: 'center', color: '#1e3a5f', fontSize: '0.78rem', border: '1px dashed rgba(255,255,255,0.06)', borderRadius: 'var(--radius-md)' }}>
                    Sin tareas
                  </div>
                ) : (
                  colTasks.map(t => (
                    <TaskCard key={t.id} task={t}
                      assigneeName={profileMap.get(t.assigned_to || t.user_id || '')?.full_name || null}
                      isAdmin={isAdmin}
                      onSelect={() => setSelectedTask(t)}
                      onStatusChange={s => handleCardStatusChange(t, s)}
                      onDelete={() => handleDelete(t.id)}
                    />
                  ))
                )}
              </div>
            )
          })}
        </div>
      ) : (
        /* ── List view ── */
        <div className="card table-wrap" style={{ padding: 0 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '3rem', textAlign: 'center', color: '#334155' }}>
              <ListChecks size={28} style={{ margin: '0 auto 0.5rem', opacity: 0.3 }} />
              <p style={{ margin: 0, fontSize: '0.875rem' }}>Sin tareas</p>
            </div>
          ) : (
            <table className="table table-clickable">
              <thead>
                <tr>
                  <th>Tarea</th>
                  <th>Asignado a</th>
                  <th>Estado</th>
                  <th>Prioridad</th>
                  <th>Vencimiento</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(t => {
                  const pm2  = PRIORITY_META[t.priority] || PRIORITY_META.medium
                  const sm   = statusMeta(t.status)
                  const assignee = profileMap.get(t.assigned_to || t.user_id || '')
                  const over = isOverdue(t)
                  return (
                    <tr key={t.id} onClick={() => setSelectedTask(t)}>
                      <td>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>{t.title}</div>
                        {t.description && <div style={{ fontSize: '0.72rem', color: '#475569', marginTop: '0.1rem' }}>{t.description.slice(0, 60)}{t.description.length > 60 ? '…' : ''}</div>}
                      </td>
                      <td>
                        {assignee && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                            <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', fontWeight: 800, color: '#818cf8' }}>
                              {initials(assignee.full_name)}
                            </div>
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{assignee.full_name || assignee.email}</span>
                          </div>
                        )}
                      </td>
                      <td>
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: '0.25rem', background: sm.bg, color: sm.color }}>{sm.label}</span>
                      </td>
                      <td>
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: '0.25rem', background: pm2.bg, color: pm2.color }}>{pm2.label}</span>
                      </td>
                      <td style={{ fontSize: '0.8rem', color: over ? '#f87171' : '#475569', fontWeight: over ? 700 : 400 }}>
                        {t.due_date ? fmtDate(t.due_date) : '—'}
                      </td>
                      <td>
                        {isAdmin && (
                          <AppIconButton icon={<DeleteIcon size={13} />} label="Eliminar" size="xs" variant="danger"
                            onClick={e => { e.stopPropagation(); handleDelete(t.id) }} />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Detail panel */}
      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          profiles={profiles}
          profileMap={profileMap}
          isAdmin={isAdmin}
          businessId={businessId || ''}
          userId={user?.id || ''}
          myName={myProfile?.full_name || myProfile?.email || 'Yo'}
          onClose={() => setSelectedTask(null)}
          onEdit={() => { setEditingTask(selectedTask); setSelectedTask(null) }}
          onStatusChange={s => applyStatusChange(selectedTask, s)}
          onUpdated={t => { setTasks(prev => prev.map(p => p.id === t.id ? t : p)); setSelectedTask(t) }}
        />
      )}

      {/* Create/Edit modal */}
      {(showCreate || editingTask) && (
        <CreateEditModal
          editing={editingTask}
          profiles={profiles}
          businessId={businessId || ''}
          userId={user?.id || ''}
          onSaved={handleSaved}
          onClose={() => { setShowCreate(false); setEditingTask(null) }}
        />
      )}
    </div>
  )
}
