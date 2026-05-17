/**
 * DashboardTasks — widget de tareas para el Dashboard.
 * Fuente de datos: taskService (source of truth único).
 * Read-only + acciones rápidas. Redirige al módulo /tasks para operaciones completas.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, ChevronRight, CheckCircle2, Circle, Clock, AlertTriangle, ListChecks, Send, X } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { taskService, type TaskLite, type TaskSummary } from '../../services/taskService'

// ─── Constants ────────────────────────────────────────────────────────────────

const PRIORITY_META = {
  high:   { label: 'Alta',  color: '#f87171', dot: '#ef4444' },
  medium: { label: 'Media', color: '#fbbf24', dot: '#f59e0b' },
  low:    { label: 'Baja',  color: '#34d399', dot: '#10b981' },
} as const

const STATUS_META = {
  pending:     { label: 'Pendiente',  color: '#94a3b8', next: 'in_progress' as const },
  in_progress: { label: 'En proceso', color: '#818cf8', next: 'completed'   as const },
  completed:   { label: 'Completada', color: '#34d399', next: null                   },
  cancelled:   { label: 'Cancelada',  color: '#f87171', next: null                   },
}

import { todayAR, fmtDateCompact } from '../../utils/dateUtils'
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

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton({ w = '100%', h = 16 }: { w?: string | number; h?: number }) {
  return <div style={{ width: w, height: h, background: 'rgba(255,255,255,0.04)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} />
}

// ─── DashboardTasks ───────────────────────────────────────────────────────────

export function DashboardTasks() {
  const { businessId, user } = useAuth()
  const navigate = useNavigate()

  const [tasks, setTasks]       = useState<TaskLite[]>([])
  const [summary, setSummary]   = useState<TaskSummary | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  // Completion flow inline
  const [completingId, setCompletingId]   = useState<string | null>(null)
  const [completionNote, setCompletionNote] = useState('')
  const [savingComplete, setSavingComplete] = useState(false)
  const [completeErr, setCompleteErr]     = useState('')
  const noteRef = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async () => {
    if (!businessId || !user?.id) return
    try {
      const [myTasks, mySummary] = await Promise.all([
        taskService.getMyTasks(businessId, user.id, 5),
        taskService.getTaskSummary(businessId, user.id),
      ])
      setTasks(myTasks)
      setSummary(mySummary)
      setError(null)
    } catch (e: any) {
      setError(e.message || 'Error al cargar tareas')
    } finally {
      setLoading(false)
    }
  }, [businessId, user?.id])

  // Carga inicial + auto-refresh cada 30 segundos
  useEffect(() => {
    load()
    const interval = setInterval(load, 30_000)
    return () => clearInterval(interval)
  }, [load])

  // Focus textarea when completion form opens
  useEffect(() => {
    if (completingId) setTimeout(() => noteRef.current?.focus(), 80)
  }, [completingId])

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleToggle = async (task: TaskLite) => {
    if (task.status === 'pending') {
      // pending → in_progress: sin validación
      await taskService.updateTaskStatus(task.id, 'in_progress')
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'in_progress' } : t))
      setSummary(prev => prev ? { ...prev, pending: prev.pending - 1, in_progress: prev.in_progress + 1 } : prev)
    } else if (task.status === 'in_progress') {
      // in_progress → completed: requiere comentario
      setCompletingId(task.id)
      setCompletionNote('')
      setCompleteErr('')
    }
  }

  const handleComplete = async () => {
    if (!completingId || !businessId || !user?.id) return
    if (!completionNote.trim()) { setCompleteErr('Escribí una nota de cierre'); return }
    setSavingComplete(true)
    try {
      await taskService.addComment(completingId, businessId, user.id, completionNote.trim())
      await taskService.updateTaskStatus(completingId, 'completed')
      setTasks(prev => prev.filter(t => t.id !== completingId))
      setSummary(prev => prev ? { ...prev, in_progress: Math.max(0, prev.in_progress - 1), completed: prev.completed + 1 } : prev)
      setCompletingId(null); setCompletionNote('')
    } catch (e: any) { setCompleteErr(e.message || 'Error al completar') }
    finally { setSavingComplete(false) }
  }

  // ── Render helpers ──────────────────────────────────────────────────────────

  const totalActive = (summary?.pending || 0) + (summary?.in_progress || 0)
  const isEmpty     = !loading && !error && tasks.length === 0

  // ── Modo compacto: sin tareas ─────────────────────────────────────────────
  if (isEmpty) {
    return (
      <div className="card animate-fade-in" style={{
        padding: '0.875rem 1.25rem',
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: '1rem',
        flexWrap: 'wrap' as const,
        marginBottom: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ width: 32, height: 32, borderRadius: '0.5rem', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <CheckCircle2 size={16} style={{ color: '#34d399' }} />
          </div>
          <div>
            <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Mis Tareas</span>
            <span style={{ marginLeft: '0.625rem', fontSize: '0.8rem', color: '#334155' }}>— Sin tareas asignadas</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.375rem', flexShrink: 0 }}>
          <button onClick={() => navigate('/tasks', { state: { openCreate: true } })}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', padding: '0.4rem 0.875rem', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.5rem', color: '#818cf8', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer' }}>
            <Plus size={13} /> Nueva tarea
          </button>
          <button onClick={() => navigate('/tasks')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', padding: '0.4rem 0.75rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#334155', fontSize: '0.8rem', cursor: 'pointer' }}>
            Ver módulo <ChevronRight size={11} />
          </button>
        </div>
      </div>
    )
  }

  // ── Modo completo: hay tareas ──────────────────────────────────────────────
  return (
    <div className="card animate-fade-in" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem 0.875rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
          <div style={{ width: 32, height: 32, borderRadius: '0.5rem', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ListChecks size={16} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>Mis Tareas</h3>
            {!loading && (
              <p style={{ margin: 0, fontSize: '0.7rem', color: '#475569' }}>
                {totalActive > 0 ? `${totalActive} tarea${totalActive > 1 ? 's' : ''} activa${totalActive > 1 ? 's' : ''}` : 'Sin tareas activas'}
              </p>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.375rem' }}>
          <button onClick={() => navigate('/tasks', { state: { openCreate: true } })}
            style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.375rem 0.625rem', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.375rem', color: '#818cf8', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer' }}>
            <Plus size={12} /> Nueva
          </button>
          <button onClick={() => navigate('/tasks')}
            style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.375rem 0.625rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.375rem', color: '#475569', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}>
            Ver todas <ChevronRight size={11} />
          </button>
        </div>
      </div>

      {/* Summary strip */}
      {!loading && summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          {[
            { label: 'Pendientes',  value: summary.pending,     color: '#94a3b8' },
            { label: 'En proceso',  value: summary.in_progress, color: '#818cf8' },
            { label: 'Completadas', value: summary.completed,   color: '#34d399' },
            { label: 'Vencidas',    value: summary.overdue,     color: summary.overdue > 0 ? '#f87171' : '#334155' },
          ].map(s => (
            <div key={s.label} style={{ padding: '0.5rem 0.75rem', textAlign: 'center', cursor: 'pointer' }}
              onClick={() => navigate('/tasks')}>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: s.color, fontFamily: 'monospace', lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: '0.62rem', color: '#334155', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: '0.1rem' }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Task list */}
      <div style={{ padding: '0.5rem 0' }}>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem 1.25rem' }}>
            {[1, 2, 3].map(i => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Skeleton w={20} h={20} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  <Skeleton w="70%" h={13} />
                  <Skeleton w="40%" h={11} />
                </div>
                <Skeleton w={48} h={11} />
              </div>
            ))}
          </div>
        ) : error ? (
          <div style={{ padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>
            <AlertTriangle size={14} /> {error}
          </div>
        ) : (
          tasks.map(task => {
            const pm     = PRIORITY_META[task.priority] || PRIORITY_META.medium
            const sm     = STATUS_META[task.status]
            const over   = isOverdue(task)
            const isComp = completingId === task.id

            return (
              <div key={task.id}>
                {/* Task row */}
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: '0.625rem',
                  padding: '0.625rem 1.25rem',
                  background: isComp ? 'rgba(99,102,241,0.05)' : 'transparent',
                  transition: 'background 0.15s',
                  borderBottom: '1px solid rgba(255,255,255,0.03)',
                }}>
                  {/* Toggle button */}
                  <button onClick={() => handleToggle(task)} title={`Avanzar a ${sm.next ? STATUS_META[sm.next].label : '—'}`}
                    style={{ background: 'none', border: 'none', cursor: sm.next ? 'pointer' : 'default', padding: '0.125rem', flexShrink: 0, marginTop: '0.1rem', color: sm.color, display: 'flex', alignItems: 'center' }}>
                    {task.status === 'completed' ? <CheckCircle2 size={18} /> : task.status === 'in_progress' ? <Clock size={18} /> : <Circle size={18} />}
                  </button>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => navigate('/tasks')}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '0.15rem' }}>
                      {/* Priority dot */}
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: pm.dot, flexShrink: 0 }} title={pm.label} />
                      <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                        {task.title}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.65rem', padding: '0.1rem 0.35rem', borderRadius: '0.2rem', background: `${sm.color}18`, color: sm.color, fontWeight: 700 }}>
                        {sm.label}
                      </span>
                      {task.due_date && (
                        <span style={{ fontSize: '0.68rem', color: over ? '#f87171' : '#334155', display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          {over && <AlertTriangle size={10} />}
                          {fmtDate(task.due_date)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Arrow to full detail */}
                  <button onClick={() => navigate('/tasks')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1e3a5f', padding: '0.25rem', flexShrink: 0, display: 'flex', alignItems: 'center' }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#475569')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#1e3a5f')}>
                    <ChevronRight size={13} />
                  </button>
                </div>

                {/* Inline completion form */}
                {isComp && (
                  <div style={{ padding: '0.625rem 1.25rem 0.875rem', background: 'rgba(99,102,241,0.04)', borderBottom: '1px solid rgba(99,102,241,0.1)' }}>
                    <p style={{ margin: '0 0 0.5rem', fontSize: '0.75rem', color: '#818cf8', fontWeight: 600 }}>
                      Nota de cierre (obligatoria para completar)
                    </p>
                    <textarea ref={noteRef} value={completionNote} onChange={e => setCompletionNote(e.target.value)}
                      rows={2} placeholder="Describí brevemente cómo se resolvió..."
                      style={{ width: '100%', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.375rem', color: 'var(--text-primary)', fontSize: '0.8rem', outline: 'none', resize: 'none' as const, boxSizing: 'border-box' as const }} />
                    {completeErr && <p style={{ margin: '0.25rem 0 0', color: 'var(--error)', fontSize: '0.72rem' }}>{completeErr}</p>}
                    <div style={{ display: 'flex', gap: '0.375rem', marginTop: '0.5rem', justifyContent: 'flex-end' }}>
                      <button onClick={() => setCompletingId(null)} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.35rem 0.625rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.375rem', color: '#475569', fontSize: '0.75rem', cursor: 'pointer' }}>
                        <X size={11} /> Cancelar
                      </button>
                      <button onClick={handleComplete} disabled={savingComplete} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.35rem 0.75rem', background: savingComplete ? 'rgba(52,211,153,0.1)' : 'rgba(52,211,153,0.18)', border: '1px solid rgba(52,211,153,0.35)', borderRadius: '0.375rem', color: '#34d399', fontSize: '0.75rem', fontWeight: 700, cursor: savingComplete ? 'not-allowed' : 'pointer' }}>
                        <Send size={11} /> {savingComplete ? 'Guardando...' : 'Completar'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Footer */}
      {!loading && tasks.length > 0 && (
        <div style={{ padding: '0.625rem 1.25rem', borderTop: '1px solid rgba(255,255,255,0.04)', display: 'flex', justifyContent: 'center' }}>
          <button onClick={() => navigate('/tasks')} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', background: 'none', border: 'none', cursor: 'pointer', color: '#334155', fontSize: '0.75rem', fontWeight: 600 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#818cf8')}
            onMouseLeave={e => (e.currentTarget.style.color = '#334155')}>
            Ver todas las tareas <ChevronRight size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
