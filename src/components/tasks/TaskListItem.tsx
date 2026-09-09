/**
 * TaskListItem — una tarea en la lista unificada.
 *
 * Híbrido fila/card: denso en desktop, apilable en una columna en mobile. El
 * layout usa flex-wrap en vez de anchos fijos, así que a 320px la meta baja de
 * línea sola y la página nunca desborda en horizontal.
 *
 * No se usa `CompactList`: esa primitiva no tiene control principal a la
 * izquierda, y meterlo dentro de `primary` rompería tanto el target táctil de
 * 44px como la separación entre «tocar la fila abre» y «tocar el círculo
 * completa». Todo lo demás sí sale de primitivas globales.
 */
import { CheckCircle2, Circle, AlertTriangle, Calendar, User } from 'lucide-react'
import { AppBadge, OverflowMenu, EditIcon, DeleteIcon, type BadgeVariant } from '../../ui'
import { colors, radius, transitions } from '../../lib/tokens'
import { fmtDateCompact } from '../../utils/dateUtils'
import { isOverdueTask, type GroupableTask } from './taskGrouping'

/**
 * Presentación de prioridad.
 *
 * La base admite `low | medium | high | urgent`, pero el producto muestra tres
 * niveles. Una fila histórica en `urgent` se pinta como Alta en vez de romperse:
 * no se ofrece un cuarto nivel nuevo. Sin arcoíris — sólo Alta tiene color de
 * alerta; Normal y Baja quedan neutras para no competir con vencida/hoy.
 */
const PRIORITY_PRESENTATION: Record<string, { label: string; variant: BadgeVariant } | null> = {
  urgent: { label: 'Alta',   variant: 'error' },
  high:   { label: 'Alta',   variant: 'error' },
  medium: null,
  low:    { label: 'Baja',   variant: 'neutral' },
}

const initials = (name: string | null | undefined) =>
  (name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()

export interface TaskListItemProps {
  task: GroupableTask & { id: string; title: string; description: string | null }
  assigneeName: string | null
  /** El avatar sólo aporta cuando la lista mezcla gente (alcance «Equipo»). */
  showAssignee: boolean
  /** Hay una escritura en vuelo para ESTA tarea. */
  busy: boolean
  /** Error de la última acción sobre ESTA tarea. Queda anclado a su fila. */
  error: string | null
  canComplete: boolean
  canManage: boolean
  onOpen: () => void
  onToggleComplete: () => void
  onEdit: () => void
  onDelete: () => void
}

export function TaskListItem({
  task, assigneeName, showAssignee, busy, error,
  canComplete, canManage, onOpen, onToggleComplete, onEdit, onDelete,
}: TaskListItemProps) {
  const done     = task.status === 'completed'
  const overdue  = isOverdueTask(task)
  const priority = PRIORITY_PRESENTATION[task.priority ?? 'medium'] ?? null

  return (
    <li
      data-testid="task-item"
      style={{
        listStyle: 'none',
        border: `1px solid ${overdue ? 'var(--error-border, rgba(248,113,113,0.28))' : colors.border.subtle}`,
        borderRadius: radius.md,
        background: colors.bg.card,
        transition: transitions.normal,
        opacity: busy ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', padding: '0.5rem 0.625rem' }}>
        {/* Completar / reabrir. 44px de target táctil aunque el ícono sea chico. */}
        <button
          type="button"
          onClick={onToggleComplete}
          disabled={!canComplete || busy}
          aria-label={done ? `Reabrir ${task.title}` : `Completar ${task.title}`}
          title={done ? 'Reabrir' : 'Completar'}
          style={{
            flexShrink: 0,
            minWidth: 44, minHeight: 44,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'none', border: 'none', borderRadius: radius.sm,
            cursor: canComplete && !busy ? 'pointer' : 'default',
            color: done ? 'var(--success)' : colors.text.subtle,
            transition: transitions.normal,
          }}
        >
          {done ? <CheckCircle2 size={20} /> : <Circle size={20} />}
        </button>

        {/* Cuerpo. `minWidth: 0` es lo que permite que el título elipse en vez de
            estirar la fila y desbordar la página a 320px. */}
        <button
          type="button"
          onClick={onOpen}
          style={{
            flex: 1, minWidth: 0, textAlign: 'left',
            background: 'none', border: 'none', padding: '0.375rem 0 0.375rem',
            cursor: 'pointer', font: 'inherit',
          }}
        >
          <span
            style={{
              display: 'block',
              fontSize: '0.875rem', fontWeight: 600, lineHeight: 1.35,
              color: done ? colors.text.subtle : colors.text.primary,
              textDecoration: done ? 'line-through' : 'none',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {task.title}
          </span>

          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
            {task.due_date && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                fontSize: '0.72rem', fontWeight: overdue ? 700 : 500,
                color: overdue ? 'var(--error)' : colors.text.muted,
              }}>
                {overdue ? <AlertTriangle size={11} /> : <Calendar size={11} />}
                {fmtDateCompact(task.due_date)}
              </span>
            )}
            {priority && <AppBadge variant={priority.variant} noDot>{priority.label}</AppBadge>}
            {showAssignee && assigneeName && (
              <span
                title={assigneeName}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                  fontSize: '0.72rem', color: colors.text.muted,
                }}
              >
                <User size={11} /> {initials(assigneeName)}
              </span>
            )}
          </span>
        </button>

        {canManage && (
          <div style={{ flexShrink: 0, paddingTop: '0.25rem' }}>
            <OverflowMenu
              label={`Acciones de ${task.title}`}
              actions={[
                { label: 'Editar',   onSelect: onEdit,   icon: <EditIcon size={13} /> },
                { label: 'Eliminar', onSelect: onDelete, icon: <DeleteIcon size={13} />, destructive: true },
              ]}
            />
          </div>
        )}
      </div>

      {error && (
        <p
          role="alert"
          style={{
            margin: 0, padding: '0 0.625rem 0.5rem 3.25rem',
            fontSize: '0.75rem', fontWeight: 600, color: 'var(--error)',
          }}
        >
          {error}
        </p>
      )}
    </li>
  )
}
