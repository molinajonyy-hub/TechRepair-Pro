// ─────────────────────────────────────────────────────────────────────────────
// TASKS-V2-0 — taskService como autoridad de escritura.
//
// Cubre los tres defectos que motivaron el lote:
//   1. las mutaciones descartaban el `error` de Supabase;
//   2. se escribían estados que el CHECK `tasks_status_check` no acepta;
//   3. una denegación de RLS en UPDATE/DELETE (0 filas, sin error) pasaba por éxito.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  /** Respuesta por `${tabla}:${operación}`. Sin entrada → lista vacía sin error. */
  responses: {} as Record<string, { data?: unknown; error?: unknown; count?: number }>,
  ops: [] as { table: string; op: string; payload?: unknown }[],
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      let op = 'select'
      let payload: unknown

      const settle = () => {
        mocks.ops.push({ table, op, payload })
        const r = mocks.responses[`${table}:${op}`] ?? { data: [], error: null }
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? 0 })
      }

      const chain: Record<string, unknown> = {
        select: (_cols?: string, opts?: { head?: boolean }) => { if (opts?.head) op = 'count'; return chain },
        insert: (p: unknown) => { op = 'insert'; payload = p; return chain },
        update: (p: unknown) => { op = 'update'; payload = p; return chain },
        delete: () => { op = 'delete'; return chain },
        eq: () => chain, or: () => chain, not: () => chain, in: () => chain,
        order: () => chain, limit: () => chain,
        single: () => settle(), maybeSingle: () => settle(),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej),
      }
      return chain
    },
  },
}))

import {
  taskService,
  isTaskServiceError,
  getAvailableTransitions,
  isPersistedStatus,
  PERSISTED_TASK_STATUSES_CURRENT,
} from '../../src/services/taskService'

const BIZ = 'biz-1'
const USER = 'user-1'
const TASK = 'task-1'

/** Fila mínima que devuelve un write exitoso. */
const row = (over: Record<string, unknown> = {}) => ({
  id: TASK, title: 'Llamar a Juan', description: null, status: 'pending',
  priority: 'medium', due_date: null, assigned_to: USER, user_id: USER,
  started_at: null, completed_at: null, created_at: '2026-09-09T10:00:00Z', ...over,
})

/** Deja la tarea lista para completarse: sin checklist pendiente. Ningún comentario hace falta. */
function allowCompletion() {
  mocks.responses['task_items:select'] = { data: [] }
}

const opsOn = (table: string, op: string) => mocks.ops.filter(o => o.table === table && o.op === op)

beforeEach(() => {
  mocks.responses = {}
  mocks.ops = []
})

// ─── Contrato temporal de estados ─────────────────────────────────────────────

describe('contrato temporal de estados', () => {
  it('sólo declara persistibles los dos que acepta el CHECK de la base', () => {
    expect([...PERSISTED_TASK_STATUSES_CURRENT]).toEqual(['pending', 'completed'])
    expect(isPersistedStatus('in_progress')).toBe(false)
    expect(isPersistedStatus('cancelled')).toBe(false)
  })

  it('ofrece completar desde pendiente y reabrir desde completada', () => {
    expect(getAvailableTransitions('pending')).toEqual(['completed'])
    expect(getAvailableTransitions('completed')).toEqual(['pending'])
  })

  it('no ofrece ninguna acción sobre una fila histórica en un estado no persistible', () => {
    expect(getAvailableTransitions('in_progress')).toEqual([])
    expect(getAvailableTransitions('cancelled')).toEqual([])
  })

  it('rechaza una transición que la base no persiste, sin escribir nada', async () => {
    await expect(
      // `in_progress` no es siquiera un destino ofrecible.
      taskService.setTaskStatus(TASK, BIZ, USER, 'completed', 'in_progress'),
    ).rejects.toMatchObject({ kind: 'validation' })
    expect(opsOn('tasks', 'update')).toHaveLength(0)
  })
})

// ─── Propagación de errores ───────────────────────────────────────────────────

describe('propagación de errores de escritura', () => {
  it('propaga un 42501 como error de permisos legible', async () => {
    mocks.responses['tasks:insert'] = { error: { code: '42501', message: 'permission denied for table tasks' } }
    const err = await taskService.createTask(BIZ, USER, {
      title: 'x', description: null, priority: 'medium', assigned_to: USER, due_date: null,
    }).catch(e => e)

    expect(isTaskServiceError(err)).toBe(true)
    expect(err.kind).toBe('permission')
    expect(err.message).toBe('No tenés permisos para realizar esta acción.')
  })

  it('mapea una violación de integridad por CLASE de SQLSTATE, sin filtrar detalles internos', async () => {
    // 23514 = check_violation. El mapeo es por clase 23xxx, no por nombre de
    // constraint: el nombre es un detalle de la base y no debe llegar al usuario.
    mocks.responses['tasks:update'] = {
      error: { code: '23514', message: 'new row violates check constraint "tasks_status_check"' },
    }
    const err = await taskService.updateTask(TASK, {
      title: 'x', description: null, priority: 'medium', assigned_to: USER, due_date: null,
    }).catch(e => e)

    expect(err.kind).toBe('validation')
    expect(err.message).toBe('No pudimos guardar el cambio.')
    for (const leak of ['23514', 'tasks_status_check', 'check constraint', 'tasks']) {
      expect(err.message).not.toContain(leak)
    }
  })

  it('distingue un fallo de red', async () => {
    mocks.responses['tasks:delete'] = { error: { message: 'Failed to fetch' } }
    const err = await taskService.deleteTask(TASK).catch(e => e)
    expect(err.kind).toBe('network')
    expect(err.message).toBe('No pudimos conectar. Intentá nuevamente.')
  })

  it('trata como denegación un UPDATE que no afecta filas', async () => {
    // La RLS deniega el INSERT con 42501, pero un UPDATE bloqueado vuelve con
    // 0 filas y error null. Sin este chequeo, una denegación parecía un éxito.
    allowCompletion()
    mocks.responses['tasks:update'] = { data: [], error: null }
    const err = await taskService.completeTask(TASK, BIZ, USER).catch(e => e)
    expect(err.kind).toBe('permission')
  })

  it('trata como denegación un DELETE que no afecta filas', async () => {
    mocks.responses['tasks:delete'] = { data: [], error: null }
    await expect(taskService.deleteTask(TASK)).rejects.toMatchObject({ kind: 'permission' })
  })
})

describe('propagación de errores de lectura', () => {
  it('no devuelve una lista vacía cuando la lectura falla', async () => {
    // Antes `return (data || [])` convertía un 42501 en «no hay tareas».
    mocks.responses['tasks:select'] = { error: { code: '42501', message: 'permission denied' } }
    await expect(taskService.getTasks(BIZ)).rejects.toMatchObject({ kind: 'permission' })
  })

  it('no devuelve contadores en cero cuando el resumen falla', async () => {
    mocks.responses['tasks:select'] = { error: { code: '42501', message: 'permission denied' } }
    await expect(taskService.getTaskSummary(BIZ, USER)).rejects.toMatchObject({ kind: 'permission' })
  })
})

// ─── Reglas de compleción ─────────────────────────────────────────────────────

describe('reglas de compleción', () => {
  it('bloquea si el checklist tiene ítems pendientes y no escribe el estado', async () => {
    mocks.responses['task_items:select'] = { data: [{ id: 'i1', task_id: TASK, title: 'a', is_done: false, sort_order: 0 }] }
    const err = await taskService.completeTask(TASK, BIZ, USER).catch(e => e)
    expect(err.reason).toBe('checklist')
    expect(opsOn('tasks', 'update')).toHaveLength(0)
  })

  it('completa una tarea SIN checklist y SIN ningún comentario', async () => {
    // El comentario de cierre obligatorio se retiró en TASKS-V2-0.1: una tarea de
    // taller se completa de una acción.
    mocks.responses['task_items:select'] = { data: [] }
    mocks.responses['tasks:update']      = { data: [row({ status: 'completed' })] }

    const saved = await taskService.completeTask(TASK, BIZ, USER)

    expect(saved.status).toBe('completed')
    const patch = opsOn('tasks', 'update')[0].payload as Record<string, unknown>
    expect(patch.status).toBe('completed')
    expect(patch.completed_at).toEqual(expect.any(String))
    // No se consulta si hay comentarios, ni se fabrica uno.
    expect(opsOn('task_comments', 'count')).toHaveLength(0)
    expect(opsOn('task_comments', 'insert')).toHaveLength(0)
  })

  it('completa con el checklist terminado y sin comentario', async () => {
    mocks.responses['task_items:select'] = {
      data: [
        { id: 'i1', task_id: TASK, title: 'a', is_done: true, sort_order: 0 },
        { id: 'i2', task_id: TASK, title: 'b', is_done: true, sort_order: 1 },
      ],
    }
    mocks.responses['tasks:update'] = { data: [row({ status: 'completed' })] }

    const saved = await taskService.completeTask(TASK, BIZ, USER)
    expect(saved.status).toBe('completed')
    expect(opsOn('task_comments', 'insert')).toHaveLength(0)
  })

  it('un comentario preexistente no cambia nada: completa igual', async () => {
    mocks.responses['task_items:select'] = { data: [] }
    mocks.responses['task_comments:select'] = {
      data: [{ id: 'c1', task_id: TASK, user_id: USER, comment: 'ya estaba', created_at: 'x' }],
    }
    mocks.responses['tasks:update'] = { data: [row({ status: 'completed' })] }

    const saved = await taskService.completeTask(TASK, BIZ, USER)
    expect(saved.status).toBe('completed')
  })

  it('al reabrir limpia completed_at para no dejar la fila incoherente', async () => {
    mocks.responses['tasks:update'] = { data: [row({ status: 'pending' })] }
    await taskService.reopenTask(TASK, BIZ, USER)

    const patch = opsOn('tasks', 'update')[0].payload as Record<string, unknown>
    expect(patch.status).toBe('pending')
    expect(patch.completed_at).toBeNull()
  })
})

// ─── Comentarios voluntarios ──────────────────────────────────────────────────

describe('comentarios (voluntarios, no obligatorios)', () => {
  it('sigue pudiendo crear un comentario y deja rastro en el historial', async () => {
    mocks.responses['task_comments:insert'] = {
      data: [{ id: 'c1', task_id: TASK, user_id: USER, comment: 'Cliente avisado', created_at: 'x' }],
    }
    const saved = await taskService.addComment(TASK, BIZ, USER, 'Cliente avisado')

    expect(saved.comment).toBe('Cliente avisado')
    const payload = opsOn('task_comments', 'insert')[0].payload as Record<string, unknown>
    expect(payload.comment).toBe('Cliente avisado')
    expect(payload.business_id).toBe(BIZ)
    // El historial se sigue registrando.
    const hist = opsOn('task_history', 'insert')[0].payload as Record<string, unknown>
    expect(hist.action).toBe('commented')
  })

  it('completar no crea ningún comentario automático ni vacío', async () => {
    allowCompletion()
    mocks.responses['tasks:update'] = { data: [row({ status: 'completed' })] }
    await taskService.completeTask(TASK, BIZ, USER)

    expect(opsOn('task_comments', 'insert')).toHaveLength(0)
  })
})

// ─── Recurrencia ──────────────────────────────────────────────────────────────

describe('recurrencia', () => {
  it('no escribe columnas de recurrencia al crear', async () => {
    mocks.responses['tasks:insert'] = { data: [row()] }
    await taskService.createTask(BIZ, USER, {
      title: 'x', description: null, priority: 'medium', assigned_to: USER, due_date: null,
    })
    const payload = opsOn('tasks', 'insert')[0].payload as Record<string, unknown>
    expect(payload).not.toHaveProperty('is_recurring')
    expect(payload).not.toHaveProperty('recurrence_type')
  })

  it('no toca la recurrencia al editar, para no resetear una fila histórica', async () => {
    mocks.responses['tasks:update'] = { data: [row()] }
    await taskService.updateTask(TASK, {
      title: 'x', description: null, priority: 'medium', assigned_to: USER, due_date: null,
    })
    const payload = opsOn('tasks', 'update')[0].payload as Record<string, unknown>
    expect(payload).not.toHaveProperty('is_recurring')
    expect(payload).not.toHaveProperty('recurrence_type')
  })
})

// ─── Estados escritos ─────────────────────────────────────────────────────────

describe('estados escritos contra la base', () => {
  it('nunca escribe un estado que el CHECK vigente rechaza', async () => {
    allowCompletion()
    mocks.responses['tasks:update'] = { data: [row({ status: 'completed' })] }
    mocks.responses['tasks:insert'] = { data: [row()] }

    await taskService.createTask(BIZ, USER, { title: 'x', description: null, priority: 'medium', assigned_to: USER, due_date: null })
    await taskService.completeTask(TASK, BIZ, USER)
    await taskService.reopenTask(TASK, BIZ, USER)

    const written = mocks.ops
      .filter(o => o.table === 'tasks' && (o.op === 'insert' || o.op === 'update'))
      .map(o => (o.payload as Record<string, unknown>).status)
      .filter(Boolean)

    expect(written.length).toBeGreaterThan(0)
    for (const s of written) expect(['pending', 'completed']).toContain(s)
  })
})
