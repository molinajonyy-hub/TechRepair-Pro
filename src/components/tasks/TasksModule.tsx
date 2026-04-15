import { useState } from 'react'
import { Plus, Check, X, Edit2, Trash2, Calendar, Flag, Filter, ChevronDown, ChevronUp } from 'lucide-react'
import { useTasks, Task } from '../../hooks/useTasks'
import { useAuth } from '../../contexts/AuthContext'

export function TasksModule() {
  const { businessId } = useAuth()
  const {
    tasks,
    pendingTasks,
    completedTasks,
    loading,
    createTask,
    updateTask,
    toggleTaskStatus,
    deleteTask
  } = useTasks(businessId)

  const [formError, setFormError] = useState<string | null>(null)
  const [showPending, setShowPending] = useState(true)
  const [showCompleted, setShowCompleted] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [filterPriority, setFilterPriority] = useState<'all' | 'low' | 'medium' | 'high' | 'urgent'>('all')

  // Form state
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    due_date: '',
    priority: 'medium' as 'low' | 'medium' | 'high' | 'urgent'
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.title.trim()) return

    setFormError(null)
    try {
      if (editingTask) {
        await updateTask(editingTask.id, formData)
        setEditingTask(null)
      } else {
        await createTask(formData)
      }

      setFormData({ title: '', description: '', due_date: '', priority: 'medium' })
      setShowForm(false)
    } catch (error) {
      console.error('Error al guardar tarea:', error)
      setFormError('No se pudo guardar la tarea. Revisá la consola para más detalles.')
    }
  }

  const handleEdit = (task: Task) => {
    setEditingTask(task)
    setFormData({
      title: task.title,
      description: task.description || '',
      due_date: task.due_date || '',
      priority: task.priority
    })
    setShowForm(true)
  }

  const getPriorityColor = (priority: string) => {
    const colors = {
      low: '#10b981',
      medium: '#f59e0b',
      high: '#f97316',
      urgent: '#ef4444'
    }
    return colors[priority as keyof typeof colors] || '#64748b'
  }

  const getPriorityLabel = (priority: string) => {
    const labels = {
      low: 'Baja',
      medium: 'Media',
      high: 'Alta',
      urgent: 'Urgente'
    }
    return labels[priority as keyof typeof labels] || priority
  }

  const filteredPendingTasks = filterPriority === 'all' 
    ? pendingTasks 
    : pendingTasks.filter(t => t.priority === filterPriority)

  const filteredCompletedTasks = filterPriority === 'all' 
    ? completedTasks 
    : completedTasks.filter(t => t.priority === filterPriority)

  const isOverdue = (dueDate?: string) => {
    if (!dueDate) return false
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return new Date(dueDate) < today
  }

  if (loading) {
    return (
      <div style={{ padding: '1.5rem', textAlign: 'center', color: '#94a3b8' }}>
        Cargando tareas...
      </div>
    )
  }

  return (
    <div style={{ 
      backgroundColor: '#1e293b', 
      borderRadius: '0.75rem', 
      padding: '1.5rem', 
      border: '1px solid rgba(255,255,255,0.05)',
      marginBottom: '2rem'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ 
            width: '40px', 
            height: '40px', 
            borderRadius: '0.5rem', 
            backgroundColor: 'rgba(99, 102, 241, 0.1)', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center' 
          }}>
            <Check size={20} style={{ color: '#6366f1' }} />
          </div>
          <div>
            <h2 style={{ color: '#ffffff', fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>
              Mis Tareas
            </h2>
            <p style={{ color: '#94a3b8', fontSize: '0.875rem', margin: '0.25rem 0 0 0' }}>
              {pendingTasks.length} pendientes · {completedTasks.length} finalizadas
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {/* Priority Filter */}
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value as any)}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#0f172a',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '0.5rem',
              color: '#ffffff',
              fontSize: '0.875rem',
              cursor: 'pointer',
              outline: 'none'
            }}
          >
            <option value="all">Todas</option>
            <option value="urgent">Urgentes</option>
            <option value="high">Altas</option>
            <option value="medium">Medias</option>
            <option value="low">Bajas</option>
          </select>

          <button
            onClick={() => {
              setShowForm(!showForm)
              setEditingTask(null)
              setFormData({ title: '', description: '', due_date: '', priority: 'medium' })
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.5rem 1rem',
              backgroundColor: '#6366f1',
              border: 'none',
              color: '#ffffff',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: 500
            }}
          >
            <Plus size={16} />
            Nueva Tarea
          </button>
        </div>
      </div>

      {/* Form */}
      {showForm && (
        <form onSubmit={handleSubmit} style={{
          backgroundColor: '#0f172a',
          borderRadius: '0.5rem',
          padding: '1.25rem',
          marginBottom: '1.5rem',
          border: '1px solid rgba(255,255,255,0.05)'
        }}>
          <div style={{ display: 'grid', gap: '1rem' }}>
            <div>
              <input
                type="text"
                placeholder="Título de la tarea *"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                style={{
                  width: '100%',
                  padding: '0.625rem 0.75rem',
                  backgroundColor: '#1e293b',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '0.375rem',
                  color: '#ffffff',
                  fontSize: '0.875rem',
                  outline: 'none'
                }}
                autoFocus
              />
            </div>

            <div>
              <textarea
                placeholder="Descripción (opcional)"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                style={{
                  width: '100%',
                  padding: '0.625rem 0.75rem',
                  backgroundColor: '#1e293b',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '0.375rem',
                  color: '#ffffff',
                  fontSize: '0.875rem',
                  outline: 'none',
                  minHeight: '60px',
                  resize: 'vertical'
                }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                  Fecha objetivo
                </label>
                <input
                  type="date"
                  value={formData.due_date}
                  onChange={(e) => setFormData({ ...formData, due_date: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.625rem 0.75rem',
                    backgroundColor: '#1e293b',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '0.375rem',
                    color: '#ffffff',
                    fontSize: '0.875rem',
                    outline: 'none'
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                  Prioridad
                </label>
                <select
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: e.target.value as any })}
                  style={{
                    width: '100%',
                    padding: '0.625rem 0.75rem',
                    backgroundColor: '#1e293b',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '0.375rem',
                    color: '#ffffff',
                    fontSize: '0.875rem',
                    outline: 'none'
                  }}
                >
                  <option value="low">Baja</option>
                  <option value="medium">Media</option>
                  <option value="high">Alta</option>
                  <option value="urgent">Urgente</option>
                </select>
              </div>
            </div>

            {formError && (
              <p style={{ color: '#ef4444', fontSize: '0.8rem', margin: 0 }}>{formError}</p>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false)
                  setEditingTask(null)
                  setFormData({ title: '', description: '', due_date: '', priority: 'medium' })
                  setFormError(null)
                }}
                style={{
                  padding: '0.5rem 1rem',
                  backgroundColor: 'transparent',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: '#94a3b8',
                  borderRadius: '0.375rem',
                  cursor: 'pointer',
                  fontSize: '0.875rem'
                }}
              >
                Cancelar
              </button>
              <button
                type="submit"
                style={{
                  padding: '0.5rem 1.5rem',
                  backgroundColor: '#6366f1',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '0.375rem',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                  fontWeight: 500
                }}
              >
                {editingTask ? 'Actualizar' : 'Crear'}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Pending Tasks */}
      <div style={{ marginBottom: '1.5rem' }}>
        <button
          onClick={() => setShowPending(!showPending)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            backgroundColor: 'transparent',
            border: 'none',
            color: '#ffffff',
            fontSize: '0.875rem',
            fontWeight: 600,
            cursor: 'pointer',
            padding: '0',
            marginBottom: '1rem'
          }}
        >
          {showPending ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          Pendientes ({filteredPendingTasks.length})
        </button>

        {showPending && (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {filteredPendingTasks.length === 0 ? (
              <div style={{ 
                padding: '2rem', 
                textAlign: 'center', 
                color: '#64748b', 
                fontSize: '0.875rem',
                backgroundColor: '#0f172a',
                borderRadius: '0.5rem'
              }}>
                No hay tareas pendientes
              </div>
            ) : (
              filteredPendingTasks.map(task => (
                <div
                  key={task.id}
                  style={{
                    backgroundColor: '#0f172a',
                    borderRadius: '0.5rem',
                    padding: '1rem',
                    border: '1px solid rgba(255,255,255,0.05)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                    transition: 'all 0.2s'
                  }}
                >
                  <button
                    onClick={() => toggleTaskStatus(task.id)}
                    style={{
                      width: '20px',
                      height: '20px',
                      minWidth: '20px',
                      minHeight: '20px',
                      borderRadius: '4px',
                      border: '2px solid #6366f1',
                      backgroundColor: 'transparent',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                      marginTop: '2px'
                    }}
                  >
                  </button>

                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                      <span style={{ color: '#ffffff', fontSize: '0.875rem', fontWeight: 500 }}>
                        {task.title}
                      </span>
                      <span style={{
                        padding: '0.125rem 0.5rem',
                        backgroundColor: `${getPriorityColor(task.priority)}20`,
                        color: getPriorityColor(task.priority),
                        borderRadius: '9999px',
                        fontSize: '0.75rem',
                        fontWeight: 500,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem'
                      }}>
                        <Flag size={10} />
                        {getPriorityLabel(task.priority)}
                      </span>
                      {isOverdue(task.due_date) && (
                        <span style={{
                          padding: '0.125rem 0.5rem',
                          backgroundColor: 'rgba(239, 68, 68, 0.1)',
                          color: '#ef4444',
                          borderRadius: '9999px',
                          fontSize: '0.75rem',
                          fontWeight: 500
                        }}>
                          Vencida
                        </span>
                      )}
                    </div>

                    {task.description && (
                      <p style={{ color: '#94a3b8', fontSize: '0.8rem', margin: '0.25rem 0 0.5rem 0' }}>
                        {task.description}
                      </p>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '0.75rem', color: '#64748b' }}>
                      {task.due_date && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          <Calendar size={12} />
                          {new Date(task.due_date).toLocaleDateString('es-AR')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '0.25rem' }}>
                    <button
                      onClick={() => handleEdit(task)}
                      style={{
                        padding: '0.375rem',
                        backgroundColor: 'transparent',
                        border: 'none',
                        color: '#94a3b8',
                        borderRadius: '0.25rem',
                        cursor: 'pointer'
                      }}
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={() => deleteTask(task.id)}
                      style={{
                        padding: '0.375rem',
                        backgroundColor: 'transparent',
                        border: 'none',
                        color: '#ef4444',
                        borderRadius: '0.25rem',
                        cursor: 'pointer'
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Completed Tasks */}
      <div>
        <button
          onClick={() => setShowCompleted(!showCompleted)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            backgroundColor: 'transparent',
            border: 'none',
            color: '#ffffff',
            fontSize: '0.875rem',
            fontWeight: 600,
            cursor: 'pointer',
            padding: '0',
            marginBottom: '1rem'
          }}
        >
          {showCompleted ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          Finalizadas ({filteredCompletedTasks.length})
        </button>

        {showCompleted && (
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {filteredCompletedTasks.length === 0 ? (
              <div style={{ 
                padding: '1.5rem', 
                textAlign: 'center', 
                color: '#64748b', 
                fontSize: '0.875rem',
                backgroundColor: '#0f172a',
                borderRadius: '0.5rem'
              }}>
                No hay tareas finalizadas
              </div>
            ) : (
              filteredCompletedTasks.map(task => (
                <div
                  key={task.id}
                  style={{
                    backgroundColor: '#0f172a',
                    borderRadius: '0.5rem',
                    padding: '0.75rem 1rem',
                    border: '1px solid rgba(255,255,255,0.05)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    opacity: 0.6
                  }}
                >
                  <button
                    onClick={() => toggleTaskStatus(task.id)}
                    style={{
                      width: '20px',
                      height: '20px',
                      minWidth: '20px',
                      minHeight: '20px',
                      borderRadius: '4px',
                      border: '2px solid #10b981',
                      backgroundColor: '#10b981',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0
                    }}
                  >
                    <Check size={12} style={{ color: '#ffffff' }} />
                  </button>

                  <span style={{ 
                    color: '#94a3b8', 
                    fontSize: '0.875rem',
                    textDecoration: 'line-through',
                    flex: 1
                  }}>
                    {task.title}
                  </span>

                  <button
                    onClick={() => deleteTask(task.id)}
                    style={{
                      padding: '0.25rem',
                      backgroundColor: 'transparent',
                      border: 'none',
                      color: '#ef4444',
                      borderRadius: '0.25rem',
                      cursor: 'pointer',
                      opacity: 0.5
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
