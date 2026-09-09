/**
 * TaskFormDialog — crear y editar una tarea.
 *
 * TASKS-V2-1: sólo consistencia de shell. El overlay `position: fixed` escrito a
 * mano pasa a ser `AppModal` (Escape, foco, scroll y presentación mobile los
 * resuelve la primitiva), y los inputs pasan a las primitivas de formulario.
 *
 * El MODELO DE DATOS no cambia: mismos campos que soporta la base hoy. Sin
 * `due_at`, sin hora, sin vínculo a orden o cliente, sin recurrencia — eso es
 * TASKS-V2-3/V2-5. Las columnas de recurrencia siguen sin escribirse.
 */
import { useState } from 'react'
import { Check } from 'lucide-react'
import { AppModal, AppButton, AppInput, AppSelect, AppTextarea, FormGrid } from '../../ui'
import { requireFeature } from '../../utils/requireFeature'
import { taskService, type TaskPriority, type TaskRecord } from '../../services/taskService'
import { toUserMessage } from './taskErrors'
import { todayAR } from '../../utils/dateUtils'

export interface TaskFormProfile {
  id: string
  user_id: string | null
  full_name: string | null
  email: string | null
}

interface FormState {
  title: string
  description: string
  priority: TaskPriority
  assigned_to: string
  due_date: string
}

const emptyForm = (): FormState => ({
  title: '', description: '', priority: 'medium', assigned_to: '', due_date: '',
})

/**
 * Tres niveles visibles. La base admite además `urgent`, que no se ofrece: se
 * conserva para filas históricas pero el producto no crea un cuarto nivel.
 */
const PRIORITY_OPTIONS = [
  { value: 'high',   label: 'Alta' },
  { value: 'medium', label: 'Normal' },
  { value: 'low',    label: 'Baja' },
]

export interface TaskFormDialogProps {
  /** `null` = crear. */
  editing: TaskRecord | null
  profiles: TaskFormProfile[]
  businessId: string
  userId: string
  onSaved: (task: TaskRecord) => void
  onClose: () => void
}

export function TaskFormDialog({ editing, profiles, businessId, userId, onSaved, onClose }: TaskFormDialogProps) {
  const [form, setForm] = useState<FormState>(editing ? {
    title:       editing.title,
    description: editing.description || '',
    // Una fila histórica en `urgent` se edita como Alta en vez de romper el select.
    priority:    editing.priority === 'low' ? 'low' : editing.priority === 'medium' ? 'medium' : 'high',
    assigned_to: editing.assigned_to || '',
    due_date:    editing.due_date || '',
  } : emptyForm())
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState('')

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(p => ({ ...p, [k]: v }))

  const handleSave = async () => {
    if (!form.title.trim())  { setErr('El título es obligatorio'); return }
    if (!form.assigned_to)   { setErr('Debés asignar un usuario'); return }
    setSaving(true); setErr('')
    try {
      await requireFeature(businessId, 'tasks', 'create_or_edit_task')
      const input = {
        title:       form.title.trim(),
        description: form.description || null,
        priority:    form.priority,
        assigned_to: form.assigned_to,
        due_date:    form.due_date || null,
      }
      const saved = editing
        ? await taskService.updateTask(editing.id, input)
        : await taskService.createTask(businessId, userId, input)
      // Sólo después de que el servidor confirmó. Las columnas que el servicio no
      // devuelve se toman de la fila en memoria, para no perder la recurrencia
      // histórica de una tarea vieja.
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

  return (
    <AppModal
      isOpen
      onClose={onClose}
      title={editing ? 'Editar tarea' : 'Nueva tarea'}
      size="sm"
      mobilePresentation="sheet"
      footer={
        <div style={{ display: 'flex', gap: '0.625rem', justifyContent: 'flex-end', width: '100%' }}>
          <AppButton variant="secondary" onClick={onClose}>Cancelar</AppButton>
          <AppButton variant="indigo" loading={saving} onClick={handleSave} leftIcon={<Check size={14} />}>
            {editing ? 'Guardar' : 'Crear tarea'}
          </AppButton>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        <AppInput
          label="Título" required autoFocus
          value={form.title}
          onChange={e => set('title', e.target.value)}
          placeholder="¿Qué hay que hacer?"
        />
        <AppTextarea
          label="Descripción"
          value={form.description}
          onChange={e => set('description', e.target.value)}
          placeholder="Detalle o instrucciones…"
          rows={3}
        />
        <FormGrid cols={2}>
          <AppSelect
            label="Prioridad"
            value={form.priority}
            onChange={e => set('priority', e.target.value as TaskPriority)}
            options={PRIORITY_OPTIONS}
          />
          <AppInput
            label="Fecha límite" type="date"
            value={form.due_date} min={todayAR()}
            onChange={e => set('due_date', e.target.value)}
          />
        </FormGrid>
        <AppSelect
          label="Asignar a" required
          value={form.assigned_to}
          onChange={e => set('assigned_to', e.target.value)}
          options={[
            { value: '', label: '— Seleccioná un usuario —' },
            ...profiles.map(p => ({
              value: p.user_id || p.id,
              label: p.full_name || p.email || 'Usuario',
            })),
          ]}
        />
        {err && (
          <p role="alert" style={{ margin: 0, color: 'var(--error)', fontSize: '0.8rem', fontWeight: 600 }}>{err}</p>
        )}
      </div>
    </AppModal>
  )
}
