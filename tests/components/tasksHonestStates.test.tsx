// ─────────────────────────────────────────────────────────────────────────────
// TASKS-V2-0 — la UI sólo ofrece lo que la base persiste, y los fallos se ven.
//
// Contrato temporal hasta TASKS-V2-3: `in_progress` y `cancelled` no se ofrecen,
// la recurrencia está oculta, y una escritura rechazada no puede dejar la
// pantalla mostrando un estado que el servidor nunca aceptó.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  tasks: [] as Record<string, unknown>[],
  myTasks: [] as Record<string, unknown>[],
  summary: { pending: 0, completed: 0, overdue: 0 } as Record<string, number>,
  getTasksError: null as unknown,
  getMyTasksError: null as unknown,
  setStatusError: null as unknown,
  createError: null as unknown,
  completeError: null as unknown,
  calls: [] as { fn: string; args: unknown[] }[],
}))

vi.mock('../../src/services/taskService', async (importOriginal) => {
  // Se conserva lo REAL del contrato de estados y del error tipado: el test
  // verifica el comportamiento del producto, no una copia del contrato.
  const actual = await importOriginal<typeof import('../../src/services/taskService')>()
  const track = (fn: string, args: unknown[]) => { mocks.calls.push({ fn, args }) }
  return {
    ...actual,
    taskService: {
      getTasks: async (...a: unknown[]) => {
        track('getTasks', a)
        if (mocks.getTasksError) throw mocks.getTasksError
        return mocks.tasks
      },
      getMyTasks: async (...a: unknown[]) => {
        track('getMyTasks', a)
        if (mocks.getMyTasksError) throw mocks.getMyTasksError
        return mocks.myTasks
      },
      getTaskSummary: async () => {
        if (mocks.getMyTasksError) throw mocks.getMyTasksError
        return mocks.summary
      },
      getChecklist: async () => [],
      getComments: async () => [],
      getHistory: async () => [],
      setTaskStatus: async (...a: unknown[]) => {
        track('setTaskStatus', a)
        if (mocks.setStatusError) throw mocks.setStatusError
        const next = a[3] as string
        return { ...mocks.tasks[0], status: next, completed_at: next === 'completed' ? 'now' : null }
      },
      completeTask: async (...a: unknown[]) => {
        track('completeTask', a)
        if (mocks.completeError) throw mocks.completeError
        return { ...mocks.myTasks[0], status: 'completed' }
      },
      createTask: async (...a: unknown[]) => {
        track('createTask', a)
        if (mocks.createError) throw mocks.createError
        return { ...mocks.tasks[0], id: 'new-task' }
      },
      updateTask: async (...a: unknown[]) => { track('updateTask', a); return mocks.tasks[0] },
      deleteTask: async (...a: unknown[]) => { track('deleteTask', a) },
      addComment: async (...a: unknown[]) => {
        track('addComment', a)
        return { id: 'c1', task_id: 't1', user_id: 'u1', comment: 'ok', created_at: 'now' }
      },
      addChecklistItem: async () => ({ id: 'i1', task_id: 't1', title: 'x', is_done: false, sort_order: 0 }),
      toggleChecklistItem: async (i: unknown) => i,
      deleteChecklistItem: async () => {},
    },
  }
})

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1', user: { id: 'user-1' } }),
}))

vi.mock('../../src/utils/requireFeature', () => ({
  requireFeature: async () => {},
  getFeatureErrorMessage: () => 'Tu plan no incluye esta función.',
  isFeatureError: () => false,
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        then: (res: (v: unknown) => unknown) => Promise.resolve({
          data: [{ id: 'p1', user_id: 'user-1', full_name: 'Dueño', email: 'o@x.com', role: 'owner' }],
          error: null,
        }).then(res),
      }
      return chain
    },
  },
}))

import { Tasks } from '../../src/pages/Tasks'
import { DashboardTasks } from '../../src/components/tasks/DashboardTasks'
import { TaskServiceError } from '../../src/services/taskService'

const task = (over: Record<string, unknown> = {}) => ({
  id: 'task-1', business_id: 'biz-1', user_id: 'user-1', assigned_to: 'user-1',
  created_by: 'user-1', title: 'Llamar a Juan', description: null,
  status: 'pending', priority: 'medium', due_date: null,
  started_at: null, completed_at: null, is_recurring: false, recurrence_type: null,
  created_at: '2026-09-09T10:00:00Z', updated_at: '2026-09-09T10:00:00Z', ...over,
})

const renderTasks = (state?: unknown) => render(
  <MemoryRouter initialEntries={[{ pathname: '/tasks', state }]}>
    <Routes><Route path="/tasks" element={<Tasks />} /></Routes>
  </MemoryRouter>,
)

beforeEach(() => {
  mocks.tasks = [task()]
  mocks.myTasks = [task()]
  mocks.summary = { pending: 1, completed: 0, overdue: 0 }
  mocks.getTasksError = null
  mocks.getMyTasksError = null
  mocks.setStatusError = null
  mocks.createError = null
  mocks.completeError = null
  mocks.calls = []
})

// ─── Estados fantasma ─────────────────────────────────────────────────────────

describe('la UI no ofrece estados que la base no persiste', () => {
  it('el filtro de estados no incluye En proceso ni Cancelada', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    const options = Array.from(document.querySelectorAll('option')).map(o => o.textContent)
    expect(options).toContain('Pendiente')
    expect(options).toContain('Completada')
    expect(options).not.toContain('En proceso')
    expect(options).not.toContain('Cancelada')
  })

  it('el kanban no tiene columna En proceso', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    // «Pendiente» y «Completada» aparecen como columna y como opción de filtro.
    expect(screen.getAllByText('Pendiente').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Completada').length).toBeGreaterThan(0)
    expect(screen.queryByText('En proceso')).not.toBeInTheDocument()
  })

  it('desde una tarea pendiente sólo se ofrece completar', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    fireEvent.click(document.querySelectorAll('.card-interactive button')[0])
    expect(await screen.findByText('→ Completada')).toBeInTheDocument()
    expect(screen.queryByText('→ En proceso')).not.toBeInTheDocument()
  })

  it('una fila histórica en in_progress se lista sin romperse y sin ofrecer acciones', async () => {
    // En la práctica no existen: el CHECK nunca aceptó ese valor. Igual la
    // pantalla tiene que tolerarlo. En el kanban no aparece —no hay columna para
    // ese estado— pero en la vista de lista sí, y ahí no ofrece transiciones.
    mocks.tasks = [task({ status: 'in_progress', title: 'Fila vieja' })]
    renderTasks()
    await waitFor(() => expect(screen.getByText('Lista')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Lista'))
    expect(await screen.findByText('Fila vieja')).toBeInTheDocument()
    expect(screen.queryByText('→ Completada')).not.toBeInTheDocument()
    expect(screen.queryByText('→ En proceso')).not.toBeInTheDocument()
  })
})

// ─── Escrituras confirmadas por el servidor ───────────────────────────────────

describe('el estado en pantalla sigue al servidor', () => {
  it('completa una tarea pendiente y refleja el resultado confirmado', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    fireEvent.click(document.querySelectorAll('.card-interactive button')[0])
    fireEvent.click(await screen.findByText('→ Completada'))

    await waitFor(() => {
      expect(mocks.calls.filter(c => c.fn === 'setTaskStatus')).toHaveLength(1)
    })
    // La transición pedida fue directamente a `completed`, sin paso intermedio.
    expect(mocks.calls.find(c => c.fn === 'setTaskStatus')!.args[3]).toBe('completed')
  })

  it('completar desde una card no pide comentario ni abre la pestaña Comentarios', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    fireEvent.click(document.querySelectorAll('.card-interactive button')[0])
    fireEvent.click(await screen.findByText('→ Completada'))

    await waitFor(() => {
      expect(mocks.calls.filter(c => c.fn === 'setTaskStatus')).toHaveLength(1)
    })
    expect(screen.queryByText(/comentario de cierre/i)).not.toBeInTheDocument()
    expect(mocks.calls.filter(c => c.fn === 'addComment')).toHaveLength(0)
  })

  it('reabre una tarea completada', async () => {
    mocks.tasks = [task({ status: 'completed', completed_at: '2026-09-09T12:00:00Z' })]
    renderTasks()
    await screen.findByText('Llamar a Juan')

    fireEvent.click(document.querySelectorAll('.card-interactive button')[0])
    fireEvent.click(await screen.findByText('→ Pendiente'))

    await waitFor(() => {
      expect(mocks.calls.find(c => c.fn === 'setTaskStatus')!.args[3]).toBe('pending')
    })
  })

  it('un cambio de estado rechazado muestra el error y NO cambia lo que se ve', async () => {
    mocks.setStatusError = new TaskServiceError('permission', 'No tenés permisos para realizar esta acción.')
    renderTasks()
    await screen.findByText('Llamar a Juan')

    const card = document.querySelectorAll('.card-interactive')[0] as HTMLElement
    fireEvent.click(within(card).getAllByRole('button')[0])
    fireEvent.click(await screen.findByText('→ Completada'))

    expect(await screen.findByRole('alert')).toHaveTextContent('No tenés permisos para realizar esta acción.')
    // La tarjeta sigue en la columna Pendiente: no hubo update optimista.
    expect(within(card).queryByText('Completada')).not.toBeInTheDocument()
  })
})

// ─── Errores visibles ─────────────────────────────────────────────────────────

describe('los fallos son visibles y recuperables', () => {
  it('un permiso denegado al crear muestra el error y deja el modal abierto', async () => {
    mocks.createError = new TaskServiceError('permission', 'No tenés permisos para realizar esta acción.')
    renderTasks()
    await screen.findByText('Llamar a Juan')

    fireEvent.click(screen.getByText('Nueva tarea'))
    fireEvent.change(screen.getByPlaceholderText('¿Qué hay que hacer?'), { target: { value: 'Pedir repuesto' } })
    const assignee = document.querySelectorAll('select')
    fireEvent.change(assignee[assignee.length - 1], { target: { value: 'user-1' } })
    fireEvent.click(screen.getByText('Crear tarea'))

    expect(await screen.findByRole('alert')).toHaveTextContent('No tenés permisos para realizar esta acción.')
    // El modal NO se cerró como si hubiera funcionado.
    expect(screen.getByRole('heading', { name: 'Nueva tarea' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('¿Qué hay que hacer?')).toBeInTheDocument()
  })

  it('un fallo de lectura no se muestra como «no hay tareas»', async () => {
    mocks.getTasksError = new TaskServiceError('permission', 'No tenés permisos para ver esta información.')
    renderTasks()

    expect(await screen.findByRole('alert')).toHaveTextContent('No tenés permisos para ver esta información.')
    expect(screen.getByText('Reintentar')).toBeInTheDocument()
  })
})

// ─── Recurrencia ──────────────────────────────────────────────────────────────

describe('recurrencia', () => {
  it('el formulario no ofrece crear tareas recurrentes', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')
    fireEvent.click(screen.getByText('Nueva tarea'))

    expect(screen.queryByText('Tarea recurrente')).not.toBeInTheDocument()
    expect(document.querySelector('input[type="checkbox"]')).toBeNull()
  })
})

// ─── Handoff del dashboard ────────────────────────────────────────────────────

describe('handoff «Nueva tarea» desde el dashboard', () => {
  it('abre el formulario una sola vez cuando llega openCreate', async () => {
    renderTasks({ openCreate: true })
    await screen.findByText('Llamar a Juan')

    expect(await screen.findByPlaceholderText('¿Qué hay que hacer?')).toBeInTheDocument()
    expect(screen.getAllByPlaceholderText('¿Qué hay que hacer?')).toHaveLength(1)
  })

  it('entrar a /tasks normalmente no abre el formulario', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    expect(screen.queryByPlaceholderText('¿Qué hay que hacer?')).not.toBeInTheDocument()
  })
})

// ─── Widget del dashboard ─────────────────────────────────────────────────────

describe('widget del dashboard', () => {
  const renderWidget = () => render(<MemoryRouter><DashboardTasks /></MemoryRouter>)

  it('no muestra el contador En proceso', async () => {
    renderWidget()
    await screen.findByText('Llamar a Juan')

    expect(screen.getByText('Pendientes')).toBeInTheDocument()
    expect(screen.getByText('Completadas')).toBeInTheDocument()
    expect(screen.queryByText('En proceso')).not.toBeInTheDocument()
  })

  it('completa una tarea pendiente de un solo tap, sin pedir nota de cierre', async () => {
    renderWidget()
    await screen.findByText('Llamar a Juan')

    fireEvent.click(screen.getByTitle('Completar tarea'))

    await waitFor(() => {
      expect(mocks.calls.filter(c => c.fn === 'completeTask')).toHaveLength(1)
    })
    // Ni formulario de nota, ni comentario fabricado.
    expect(screen.queryByText(/Nota de cierre/)).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Describí brevemente/)).not.toBeInTheDocument()
    expect(mocks.calls.filter(c => c.fn === 'addComment')).toHaveLength(0)
  })

  it('no expone ningún control de nota de cierre en el widget', async () => {
    renderWidget()
    await screen.findByText('Llamar a Juan')

    expect(document.querySelector('textarea')).toBeNull()
    expect(screen.queryByText(/comentario de cierre/i)).not.toBeInTheDocument()
  })

  it('un fallo de lectura muestra el error en vez de «Sin tareas asignadas»', async () => {
    mocks.getMyTasksError = new TaskServiceError('permission', 'No tenés permisos para ver esta información.')
    renderWidget()

    expect(await screen.findByText('No tenés permisos para ver esta información.')).toBeInTheDocument()
    expect(screen.queryByText(/Sin tareas asignadas/)).not.toBeInTheDocument()
  })

  it('un fallo al completar deja la tarea en la lista y muestra el error', async () => {
    mocks.completeError = new TaskServiceError('permission', 'No tenés permisos para realizar esta acción.')
    renderWidget()
    await screen.findByText('Llamar a Juan')

    fireEvent.click(screen.getByTitle('Completar tarea'))

    expect(await screen.findByText('No tenés permisos para realizar esta acción.')).toBeInTheDocument()
    expect(screen.getByText('Llamar a Juan')).toBeInTheDocument()
  })

  it('un checklist incompleto bloquea la compleción y lo explica', async () => {
    mocks.completeError = new TaskServiceError(
      'validation', 'Completá todos los ítems del checklist primero.', { reason: 'checklist' },
    )
    renderWidget()
    await screen.findByText('Llamar a Juan')

    fireEvent.click(screen.getByTitle('Completar tarea'))

    expect(await screen.findByText('Completá todos los ítems del checklist primero.')).toBeInTheDocument()
    expect(screen.getByText('Llamar a Juan')).toBeInTheDocument()
  })
})
