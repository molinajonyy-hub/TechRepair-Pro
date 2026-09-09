// ─────────────────────────────────────────────────────────────────────────────
// TASKS-V2-1 — shell unificado.
//
// Verifica lo que este lote cambia: una sola lista por tiempo, primitivas
// globales, alcance Mías/Equipo y estados diferenciados. El contrato de negocio
// (V2-0 / V2-0.1) se cubre en los otros dos archivos y no se repite acá.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todayAR } from '../../src/utils/dateUtils'

const mocks = vi.hoisted(() => ({
  tasks: [] as Record<string, unknown>[],
  role: 'owner' as string,
  getTasksError: null as unknown,
  deleteError: null as unknown,
  calls: [] as { fn: string; args: unknown[] }[],
}))

vi.mock('../../src/services/taskService', async (importOriginal) => {
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
      getChecklist: async () => [],
      getComments: async () => [],
      getHistory: async () => [],
      setTaskStatus: async (...a: unknown[]) => {
        track('setTaskStatus', a)
        return { ...mocks.tasks[0], status: a[3] }
      },
      deleteTask: async (...a: unknown[]) => {
        track('deleteTask', a)
        if (mocks.deleteError) throw mocks.deleteError
      },
      createTask: async (...a: unknown[]) => { track('createTask', a); return mocks.tasks[0] },
      updateTask: async (...a: unknown[]) => { track('updateTask', a); return mocks.tasks[0] },
      addComment: async () => ({ id: 'c1', task_id: 't1', user_id: 'u1', comment: 'x', created_at: 'now' }),
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
          data: [
            { id: 'p1', user_id: 'user-1', full_name: 'Dueño',  email: 'o@x.com', role: mocks.role },
            { id: 'p2', user_id: 'user-2', full_name: 'Técnica', email: 't@x.com', role: 'tech' },
          ],
          error: null,
        }).then(res),
      }
      return chain
    },
  },
}))

import { Tasks } from '../../src/pages/Tasks'
import { TaskServiceError } from '../../src/services/taskService'

const TODAY = todayAR()
const dayOffset = (n: number) => {
  const [y, m, d] = TODAY.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return dt.toISOString().slice(0, 10)
}

const task = (over: Record<string, unknown> = {}) => ({
  id: 'task-1', business_id: 'biz-1', user_id: 'user-1', assigned_to: 'user-1',
  created_by: 'user-1', title: 'Llamar a Juan', description: null,
  status: 'pending', priority: 'medium', due_date: null,
  started_at: null, completed_at: null, is_recurring: false, recurrence_type: null,
  created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z', ...over,
})

const renderTasks = () => render(
  <MemoryRouter initialEntries={['/tasks']}>
    <Routes><Route path="/tasks" element={<Tasks />} /></Routes>
  </MemoryRouter>,
)

beforeEach(() => {
  mocks.tasks = [task()]
  mocks.role = 'owner'
  mocks.getTasksError = null
  mocks.deleteError = null
  mocks.calls = []
})

// ─── Lista única por tiempo ───────────────────────────────────────────────────

describe('una sola lista, organizada por tiempo', () => {
  it('muestra las secciones temporales y no el kanban viejo', async () => {
    mocks.tasks = [
      task({ id: 'a', title: 'Vencida',  due_date: dayOffset(-2) }),
      task({ id: 'b', title: 'De hoy',   due_date: TODAY }),
      task({ id: 'c', title: 'Próxima',  due_date: dayOffset(3) }),
      task({ id: 'd', title: 'Sin plazo' }),
    ]
    renderTasks()
    await screen.findByText('Vencida')

    for (const label of ['Vencidas', 'Hoy', 'Próximas', 'Sin fecha']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    // Ya no hay dualidad kanban/lista.
    expect(screen.queryByText('Kanban')).not.toBeInTheDocument()
    expect(screen.queryByText('Lista')).not.toBeInTheDocument()
  })

  it('ordena las secciones de más urgente a menos', async () => {
    mocks.tasks = [
      task({ id: 'd', title: 'Sin plazo' }),
      task({ id: 'c', title: 'Próxima', due_date: dayOffset(3) }),
      task({ id: 'a', title: 'Vencida', due_date: dayOffset(-2) }),
      task({ id: 'b', title: 'De hoy',  due_date: TODAY }),
    ]
    renderTasks()
    await screen.findByText('Vencida')

    const headings = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)
    expect(headings.map(h => h?.replace(/\d+/g, '').trim())).toEqual(['Vencidas', 'Hoy', 'Próximas', 'Sin fecha'])
  })

  it('las completadas quedan en una sección aparte y colapsada', async () => {
    mocks.tasks = [
      task({ id: 'a', title: 'Activa' }),
      task({ id: 'b', title: 'Ya hecha', status: 'completed', completed_at: '2026-09-09T10:00:00Z' }),
    ]
    renderTasks()
    await screen.findByText('Activa')

    // Colapsada: el título de la completada no se ve hasta desplegar.
    expect(screen.queryByText('Ya hecha')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Completadas/ }))
    expect(await screen.findByText('Ya hecha')).toBeInTheDocument()
  })

  it('la búsqueda filtra la lista', async () => {
    mocks.tasks = [
      task({ id: 'a', title: 'Llamar a Juan' }),
      task({ id: 'b', title: 'Pedir repuesto' }),
    ]
    renderTasks()
    await screen.findByText('Llamar a Juan')

    fireEvent.change(screen.getByPlaceholderText('Buscar tarea…'), { target: { value: 'repuesto' } })

    expect(screen.getByText('Pedir repuesto')).toBeInTheDocument()
    expect(screen.queryByText('Llamar a Juan')).not.toBeInTheDocument()
  })
})

// ─── Alcance ──────────────────────────────────────────────────────────────────

describe('alcance Mías / Equipo', () => {
  it('se ofrece a un rol que ya ve tareas de otros', async () => {
    mocks.role = 'owner'
    renderTasks()
    await screen.findByText('Llamar a Juan')

    expect(screen.getByRole('button', { name: 'Mías' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Equipo' })).toBeInTheDocument()
  })

  it('no se ofrece a un rol cuya lista ya es sólo la suya', async () => {
    // Para un técnico el toggle sería decorativo, e insinuaría un permiso que no
    // tiene. La restricción real es de servidor y llega en TASKS-V2-4.
    mocks.role = 'tech'
    renderTasks()
    await screen.findByText('Llamar a Juan')

    expect(screen.queryByRole('button', { name: 'Mías' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Equipo' })).not.toBeInTheDocument()
  })

  it('«Mías» deja fuera lo asignado a otra persona', async () => {
    mocks.tasks = [
      task({ id: 'a', title: 'Mi tarea',    assigned_to: 'user-1', user_id: 'user-1' }),
      task({ id: 'b', title: 'De la técnica', assigned_to: 'user-2', user_id: 'user-2' }),
    ]
    renderTasks()
    await screen.findByText('Mi tarea')
    // Por defecto un admin ve al equipo, igual que antes de este lote.
    expect(screen.getByText('De la técnica')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Mías' }))

    expect(screen.getByText('Mi tarea')).toBeInTheDocument()
    expect(screen.queryByText('De la técnica')).not.toBeInTheDocument()
  })
})

// ─── Estados de pantalla ──────────────────────────────────────────────────────

describe('vacío y error son estados distintos', () => {
  it('sin tareas muestra el vacío, no un error', async () => {
    mocks.tasks = []
    renderTasks()

    expect(await screen.findByText('No tenés tareas pendientes.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('un fallo de lectura muestra el error con reintento, no el vacío', async () => {
    mocks.getTasksError = new TaskServiceError('permission', 'No tenés permisos para ver esta información.')
    renderTasks()

    expect(await screen.findByRole('alert')).toHaveTextContent('No tenés permisos para ver esta información.')
    expect(screen.getByText('Reintentar')).toBeInTheDocument()
    expect(screen.queryByText('No tenés tareas pendientes.')).not.toBeInTheDocument()
  })
})

// ─── Primitivas globales ──────────────────────────────────────────────────────

describe('primitivas globales', () => {
  it('eliminar usa el diálogo de la app, no el confirm nativo', async () => {
    const nativeConfirm = vi.fn(() => true)
    vi.stubGlobal('confirm', nativeConfirm)

    renderTasks()
    await screen.findByText('Llamar a Juan')

    fireEvent.click(screen.getByRole('button', { name: /Acciones de Llamar a Juan/ }))
    fireEvent.click(await screen.findByText('Eliminar'))

    // Aparece el diálogo de la app y NO se llamó a window.confirm.
    expect(await screen.findByText('Eliminar tarea')).toBeInTheDocument()
    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(mocks.calls.filter(c => c.fn === 'deleteTask')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }))
    await waitFor(() => {
      expect(mocks.calls.filter(c => c.fn === 'deleteTask')).toHaveLength(1)
    })
  })

  it('el formulario de nueva tarea abre y cierra', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    fireEvent.click(screen.getByRole('button', { name: /Nueva tarea/ }))
    expect(await screen.findByPlaceholderText('¿Qué hay que hacer?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('¿Qué hay que hacer?')).not.toBeInTheDocument()
    })
  })

  it('el detalle abre como diálogo, sin el panel fijo de 440px', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    fireEvent.click(screen.getByRole('button', { name: /^Llamar a Juan/ }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    // Nada del andamiaje viejo: ni panel de 440px ni el padding que lo compensaba.
    const html = document.body.innerHTML
    expect(html).not.toMatch(/width:\s*440px/)
    expect(html).not.toMatch(/padding-right:\s*456px/)
  })
})

// ─── Accesibilidad / mobile ───────────────────────────────────────────────────

describe('fundaciones de accesibilidad y mobile', () => {
  it('el control de completar tiene un target táctil de al menos 44px', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    const toggle = screen.getByRole('button', { name: 'Completar Llamar a Juan' })
    expect(toggle.style.minWidth).toBe('44px')
    expect(toggle.style.minHeight).toBe('44px')
  })

  it('las acciones de estado tienen nombre accesible propio por tarea', async () => {
    mocks.tasks = [
      task({ id: 'a', title: 'Llamar a Juan' }),
      task({ id: 'b', title: 'Pedir repuesto' }),
    ]
    renderTasks()
    await screen.findByText('Llamar a Juan')

    expect(screen.getByRole('button', { name: 'Completar Llamar a Juan' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Completar Pedir repuesto' })).toBeInTheDocument()
  })

  it('la lista no usa anchos fijos que fuercen scroll horizontal', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    // El kanban viejo fijaba columnas de 300px; la lista nueva es fluida.
    expect(document.body.innerHTML).not.toMatch(/min-width:\s*300px/)
  })
})
