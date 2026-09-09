/**
 * TaskDetailDialog — detalle de una tarea.
 *
 * TASKS-V2-1: reemplaza el panel lateral fijo de 440px (y el `paddingRight: 456`
 * que la página tenía que compensar). Ahora es un `AppModal`, así que en desktop
 * es un diálogo y en mobile se presenta como sheet, con Escape, foco y scroll
 * resueltos por la primitiva en vez de a mano.
 *
 * No cambia ningún contrato de datos: mismas pestañas, mismas llamadas al
 * servicio y mismas reglas que en V2-0.1.
 */
import { useEffect, useState } from 'react'
import { Calendar, CheckCircle2, Circle, History, MessageSquare, Plus, Send, User, X } from 'lucide-react'
import {
  AppModal, AppTabs, AppButton, AppBadge, AppEmptyState, EditIcon,
} from '../../ui'
import { colors, radius } from '../../lib/tokens'
import { fmtDateCompact, fmtFull } from '../../utils/dateUtils'
import {
  taskService, getAvailableTransitions, isTaskServiceError,
  type PersistedTaskStatus, type TaskRecord,
  type TaskChecklistItem, type TaskCommentRow, type TaskHistoryRow,
} from '../../services/taskService'
import { toUserMessage } from './taskErrors'
import { isOverdueTask } from './taskGrouping'

type DetailTab = 'details' | 'checklist' | 'comments' | 'history'

const ACTION_LABELS: Record<string, string> = {
  created: 'Tarea creada',
  status_changed: 'Estado cambiado',
  reassigned: 'Reasignada',
  commented: 'Comentario agregado',
  checklist: 'Checklist actualizado',
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pendiente', completed: 'Completada',
  in_progress: 'En proceso', cancelled: 'Cancelada',
}

const initials = (name: string | null | undefined) =>
  (name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()

export interface TaskDetailDialogProps {
  task: TaskRecord
  profileMap: Map<string, { full_name: string | null; email: string | null }>
  canManage: boolean
  businessId: string
  userId: string
  myName: string
  onClose: () => void
  onEdit: () => void
  /** Lanza si el servidor rechaza: el diálogo muestra el error y no toca nada local. */
  onStatusChange: (s: PersistedTaskStatus) => Promise<void>
}

export function TaskDetailDialog({
  task, profileMap, canManage, businessId, userId, myName, onClose, onEdit, onStatusChange,
}: TaskDetailDialogProps) {
  const [tab, setTab]           = useState<DetailTab>('details')
  const [items, setItems]       = useState<TaskChecklistItem[]>([])
  const [comments, setComments] = useState<(TaskCommentRow & { user_name?: string })[]>([])
  const [history, setHistory]   = useState<(TaskHistoryRow & { user_name?: string })[]>([])
  const [loadingTab, setLoadingTab]       = useState(false)
  const [newComment, setNewComment]       = useState('')
  const [newItem, setNewItem]             = useState('')
  const [savingComment, setSavingComment] = useState(false)
  const [actionErr, setActionErr]         = useState('')
  const [tabErr, setTabErr]               = useState('')
  const [busyStatus, setBusyStatus]       = useState(false)

  const assignee  = profileMap.get(task.assigned_to || '') || profileMap.get(task.user_id || '')
  const doneItems = items.filter(i => i.is_done).length
  const allDone   = items.length > 0 && doneItems === items.length
  const nextStatuses = getAvailableTransitions(task.status)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (tab === 'details') return
      setLoadingTab(true); setTabErr('')
      try {
        if (tab === 'checklist') {
          const rows = await taskService.getChecklist(task.id)
          if (!cancelled) setItems(rows)
        } else if (tab === 'comments') {
          const rows = await taskService.getComments(task.id)
          if (!cancelled) setComments(rows.map(c => ({ ...c, user_name: profileMap.get(c.user_id)?.full_name || 'Usuario' })))
        } else if (tab === 'history') {
          const rows = await taskService.getHistory(task.id)
          if (!cancelled) setHistory(rows.map(h => ({ ...h, user_name: profileMap.get(h.user_id || '')?.full_name || 'Sistema' })))
        }
      } catch (e: unknown) {
        if (!cancelled) setTabErr(toUserMessage(e, 'No pudimos cargar la información.'))
      } finally {
        if (!cancelled) setLoadingTab(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [task.id, tab, profileMap])

  const handleAddComment = async () => {
    if (!newComment.trim()) return
    setSavingComment(true); setTabErr('')
    try {
      const saved = await taskService.addComment(task.id, businessId, userId, newComment.trim())
      setComments(prev => [...prev, { ...saved, user_name: myName }])
      setNewComment('')
    } catch (e: unknown) { setTabErr(toUserMessage(e)) }
    finally { setSavingComment(false) }
  }

  const handleToggleItem = async (item: TaskChecklistItem) => {
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
   * La única regla de compleción —checklist completo— la valida `taskService`.
   * Acá sólo se lleva al usuario a la pestaña que explica el bloqueo.
   * Completar NO pide comentario: los comentarios son voluntarios.
   */
  const handleStatusChange = async (s: PersistedTaskStatus) => {
    setActionErr(''); setBusyStatus(true)
    try {
      await onStatusChange(s)
    } catch (e: unknown) {
      setActionErr(toUserMessage(e))
      if (isTaskServiceError(e) && e.reason === 'checklist') setTab('checklist')
    } finally { setBusyStatus(false) }
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '0.75rem',
    padding: '0.625rem 0.875rem', background: colors.bg.card, borderRadius: radius.md,
  }

  return (
    <AppModal
      isOpen
      onClose={onClose}
      title={task.title}
      size="md"
      mobilePresentation="sheet"
      scrollable
      footer={
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end', width: '100%' }}>
          {canManage && (
            <AppButton variant="secondary" onClick={onEdit} leftIcon={<EditIcon size={14} />}>Editar</AppButton>
          )}
          {nextStatuses.map(s => (
            <AppButton
              key={s}
              variant={s === 'completed' ? 'indigo' : 'secondary'}
              loading={busyStatus}
              onClick={() => handleStatusChange(s)}
              leftIcon={s === 'completed' ? <CheckCircle2 size={14} /> : <Circle size={14} />}
            >
              {s === 'completed' ? 'Completar' : 'Reabrir'}
            </AppButton>
          ))}
        </div>
      }
    >
      {/* Cabecera de estado */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.875rem' }}>
        <AppBadge variant={task.status === 'completed' ? 'success' : 'neutral'}>
          {STATUS_LABEL[task.status] ?? STATUS_LABEL.pending}
        </AppBadge>
        {isOverdueTask(task) && <AppBadge variant="error">Vencida</AppBadge>}
      </div>

      {actionErr && (
        <p role="alert" style={{ margin: '0 0 0.75rem', color: 'var(--error)', fontSize: '0.8rem', fontWeight: 600 }}>
          {actionErr}
        </p>
      )}

      <AppTabs
        activeTab={tab}
        onChange={k => setTab(k as DetailTab)}
        tabs={[
          { key: 'details',   label: 'Detalles' },
          { key: 'checklist', label: 'Checklist', badge: items.length || undefined },
          { key: 'comments',  label: 'Comentarios' },
          { key: 'history',   label: 'Historial' },
        ]}
      />

      <div style={{ paddingTop: '0.875rem' }}>
        {tabErr && (
          <p role="alert" style={{ margin: '0 0 0.75rem', color: 'var(--error)', fontSize: '0.78rem', fontWeight: 600 }}>
            {tabErr}
          </p>
        )}

        {loadingTab && tab !== 'details' ? (
          <p style={{ color: colors.text.muted, fontSize: '0.82rem', padding: '1rem 0' }}>Cargando…</p>
        ) : tab === 'details' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            {task.description && (
              <p style={{ margin: 0, color: colors.text.secondary, fontSize: '0.875rem', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {task.description}
              </p>
            )}
            <div style={rowStyle}>
              <User size={13} style={{ color: colors.text.muted, flexShrink: 0 }} />
              <span style={{ fontSize: '0.78rem', color: colors.text.muted, fontWeight: 600 }}>Asignada a</span>
              <span style={{ marginLeft: 'auto', fontSize: '0.85rem', color: colors.text.primary }}>
                {assignee?.full_name || assignee?.email || '—'}
              </span>
            </div>
            <div style={rowStyle}>
              <Calendar size={13} style={{ color: colors.text.muted, flexShrink: 0 }} />
              <span style={{ fontSize: '0.78rem', color: colors.text.muted, fontWeight: 600 }}>Vencimiento</span>
              <span style={{ marginLeft: 'auto', fontSize: '0.85rem', color: colors.text.primary }}>
                {task.due_date ? fmtDateCompact(task.due_date) : '—'}
              </span>
            </div>
            {task.completed_at && (
              <div style={rowStyle}>
                <CheckCircle2 size={13} style={{ color: colors.text.muted, flexShrink: 0 }} />
                <span style={{ fontSize: '0.78rem', color: colors.text.muted, fontWeight: 600 }}>Completada</span>
                <span style={{ marginLeft: 'auto', fontSize: '0.85rem', color: colors.text.primary }}>
                  {fmtFull(task.completed_at)}
                </span>
              </div>
            )}
          </div>
        ) : tab === 'checklist' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {items.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                <div style={{ flex: 1, height: 6, background: colors.bg.card, borderRadius: radius.full, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: `${(doneItems / items.length) * 100}%`,
                    background: allDone ? 'var(--success)' : 'var(--accent-primary)', transition: 'width 0.3s',
                  }} />
                </div>
                <span style={{ fontSize: '0.72rem', color: colors.text.muted, fontWeight: 700 }}>{doneItems}/{items.length}</span>
              </div>
            )}
            {items.map(item => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: colors.bg.card, borderRadius: radius.sm, paddingRight: '0.5rem' }}>
                <button
                  type="button" onClick={() => handleToggleItem(item)}
                  aria-label={item.is_done ? `Desmarcar ${item.title}` : `Marcar ${item.title}`}
                  style={{
                    minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: item.is_done ? 'var(--success)' : colors.text.subtle,
                  }}
                >
                  {item.is_done ? <CheckCircle2 size={17} /> : <Circle size={17} />}
                </button>
                <span style={{
                  flex: 1, minWidth: 0, fontSize: '0.85rem',
                  color: item.is_done ? colors.text.muted : colors.text.primary,
                  textDecoration: item.is_done ? 'line-through' : 'none',
                }}>
                  {item.title}
                </span>
                <button
                  type="button" onClick={() => handleDeleteItem(item.id)} aria-label={`Eliminar ${item.title}`}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.text.subtle, display: 'flex', padding: '0.5rem' }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: '0.375rem' }}>
              <input
                value={newItem} onChange={e => setNewItem(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleAddItem() } }}
                placeholder="Agregar ítem…" aria-label="Nuevo ítem del checklist"
                className="form-control" style={{ flex: 1, minWidth: 0 }}
              />
              <AppButton variant="secondary" onClick={handleAddItem} aria-label="Agregar ítem">
                <Plus size={14} />
              </AppButton>
            </div>
          </div>
        ) : tab === 'comments' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {comments.length === 0 && (
              <AppEmptyState compact icon={<MessageSquare size={20} />} description="Sin comentarios." />
            )}
            {comments.map(c => (
              <div key={c.id} style={{ display: 'flex', gap: '0.625rem' }}>
                <span style={{
                  width: 28, height: 28, borderRadius: radius.full, flexShrink: 0,
                  background: 'var(--accent-soft, rgba(99,102,241,0.18))', color: 'var(--accent-primary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.62rem', fontWeight: 800,
                }}>
                  {initials(c.user_name)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <span style={{ fontSize: '0.78rem', fontWeight: 700, color: colors.text.secondary }}>{c.user_name}</span>
                    <span style={{ fontSize: '0.68rem', color: colors.text.muted }}>{fmtFull(c.created_at)}</span>
                  </div>
                  <p style={{
                    margin: '0.2rem 0 0', fontSize: '0.85rem', color: colors.text.primary, lineHeight: 1.5,
                    background: colors.bg.card, padding: '0.5rem 0.75rem', borderRadius: radius.md, whiteSpace: 'pre-wrap',
                  }}>
                    {c.comment}
                  </p>
                </div>
              </div>
            ))}
            {/* Comentar es opcional: no hace falta para completar (V2-0.1). */}
            <div>
              <textarea
                value={newComment} onChange={e => setNewComment(e.target.value)} rows={3}
                placeholder="Escribí un comentario…" aria-label="Nuevo comentario"
                className="form-control" style={{ width: '100%', resize: 'vertical', boxSizing: 'border-box' }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <AppButton variant="indigo" size="sm" loading={savingComment} onClick={handleAddComment} leftIcon={<Send size={12} />}>
                  Comentar
                </AppButton>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {history.length === 0 && <AppEmptyState compact icon={<History size={20} />} description="Sin historial." />}
            {history.map(h => (
              <div key={h.id} style={{ display: 'flex', gap: '0.625rem', alignItems: 'flex-start', paddingBottom: '0.5rem', borderBottom: `1px solid ${colors.border.subtle}` }}>
                <History size={13} style={{ color: colors.text.subtle, flexShrink: 0, marginTop: '0.2rem' }} />
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: '0.82rem', color: colors.text.secondary, fontWeight: 600 }}>
                    {ACTION_LABELS[h.action] || h.action}
                    {h.old_value && h.new_value && (
                      <span style={{ fontWeight: 400, color: colors.text.muted }}> — {h.old_value} → {h.new_value}</span>
                    )}
                  </p>
                  <p style={{ margin: '0.1rem 0 0', fontSize: '0.68rem', color: colors.text.muted }}>
                    {h.user_name} · {fmtFull(h.created_at)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppModal>
  )
}
