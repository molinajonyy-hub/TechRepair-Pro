// ─────────────────────────────────────────────────────────────────────────────
// TASKS-V2-2 — pase mobile.
//
// jsdom no hace layout, así que estos tests NO pueden probar "no hay scroll
// horizontal" midiendo pixeles. Lo que sí pueden fijar es lo que causa ese
// scroll y lo que rompe el uso con el pulgar: anchos fijos, targets chicos,
// acciones que se pisan y superficies que no cierran. La validación visual real
// en un iPhone sigue siendo la última puerta.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  tasks: [] as Record<string, unknown>[],
  role: 'owner' as string,
  checklist: [] as Record<string, unknown>[],
  statusError: null as unknown,
  calls: [] as { fn: string; args: unknown[] }[],
}))

vi.mock('../../src/services/taskService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/taskService')>()
  const track = (fn: string, args: unknown[]) => { mocks.calls.push({ fn, args }) }
  return {
    ...actual,
    taskService: {
      getTasks: async (...a: unknown[]) => { track('getTasks', a); return mocks.tasks },
      getChecklist: async () => mocks.checklist,
      getComments: async () => [],
      getHistory: async () => [],
      setTaskStatus: async (...a: unknown[]) => {
        track('setTaskStatus', a)
        if (mocks.statusError) throw mocks.statusError
        return { ...mocks.tasks[0], status: a[3] }
      },
      deleteTask: async (...a: unknown[]) => { track('deleteTask', a) },
      createTask: async (...a: unknown[]) => { track('createTask', a); return mocks.tasks[0] },
      updateTask: async (...a: unknown[]) => { track('updateTask', a); return mocks.tasks[0] },
      addComment: async () => ({ id: 'c1', task_id: 't1', user_id: 'u1', comment: 'x', created_at: 'now' }),
      addChecklistItem: async () => ({ id: 'i2', task_id: 'task-1', title: 'nuevo', is_done: false, sort_order: 1 }),
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
          data: [{ id: 'p1', user_id: 'user-1', full_name: 'Dueño', email: 'o@x.com', role: mocks.role }],
          error: null,
        }).then(res),
      }
      return chain
    },
  },
}))

import { Tasks } from '../../src/pages/Tasks'
import { TaskServiceError } from '../../src/services/taskService'

const task = (over: Record<string, unknown> = {}) => ({
  id: 'task-1', business_id: 'biz-1', user_id: 'user-1', assigned_to: 'user-1',
  created_by: 'user-1', title: 'Llamar a Juan', description: 'Detalle',
  status: 'pending', priority: 'medium', due_date: null,
  started_at: null, completed_at: null, is_recurring: false, recurrence_type: null,
  created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z', ...over,
})

const renderTasks = () => render(
  <MemoryRouter initialEntries={['/tasks']}>
    <Routes><Route path="/tasks" element={<Tasks />} /></Routes>
  </MemoryRouter>,
)

const openDetail = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^Llamar a Juan/ }))
  return await screen.findByRole('dialog')
}

beforeEach(() => {
  mocks.tasks = [task()]
  mocks.role = 'owner'
  mocks.checklist = []
  mocks.statusError = null
  mocks.calls = []
})

// ─── Ancho / overflow ─────────────────────────────────────────────────────────

describe('nada fuerza scroll horizontal', () => {
  it('la barra y las secciones se maquetan por clase, sin anchos fijos', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    // Las reglas responsive viven en CSS (sobreviven a una rotación); el markup
    // sólo declara las clases.
    expect(document.querySelector('.tasks-toolbar')).not.toBeNull()
    expect(document.querySelector('.tasks-toolbar__search')).not.toBeNull()
    expect(document.querySelector('.tasks-list')).not.toBeNull()

    const html = document.body.innerHTML
    // `width:` fijo de tres cifras — el lookbehind excluye min-/max-width, que
    // son legítimos (`max-width: 100%` no fuerza overflow).
    for (const fixed of [/width:\s*440px/, /padding-right:\s*456px/, /min-width:\s*300px/, /(?<![a-z-])width:\s*\d{3,}px/]) {
      expect(html).not.toMatch(fixed)
    }
  })

  it('el detalle tampoco introduce anchos fijos', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')
    await openDetail()

    expect(document.body.innerHTML).not.toMatch(/width:\s*440px/)
    expect(document.body.innerHTML).not.toMatch(/min-width:\s*300px/)
  })
})

// ─── Composición de la barra ──────────────────────────────────────────────────

describe('barra compacta', () => {
  it('agrupa búsqueda, alcance y filtros sin repetir controles', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    const toolbar = document.querySelector('.tasks-toolbar') as HTMLElement
    expect(within(toolbar).getByPlaceholderText('Buscar tarea…')).toBeInTheDocument()
    expect(within(toolbar).getByRole('group', { name: 'Alcance' })).toBeInTheDocument()
    expect(within(toolbar).getByRole('button', { name: 'Filtros' })).toBeInTheDocument()
    // Un solo campo de búsqueda en toda la pantalla.
    expect(screen.getAllByPlaceholderText('Buscar tarea…')).toHaveLength(1)
  })

  it('«Actualizar» conserva nombre accesible aunque en mobile muestre sólo el ícono', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    const refresh = screen.getByRole('button', { name: 'Actualizar' })
    // La etiqueta es la que se oculta por CSS, no el nombre accesible.
    expect(refresh.querySelector('.tasks-label-optional')).not.toBeNull()
  })

  it('«Nueva tarea» sigue siendo una acción visible y directa', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')
    expect(screen.getByRole('button', { name: /Nueva tarea/ })).toBeInTheDocument()
  })
})

// ─── Pulgar: completar vs abrir ───────────────────────────────────────────────

describe('completar y abrir son acciones separadas', () => {
  it('tocar el círculo completa y NO abre el detalle', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    fireEvent.click(screen.getByRole('button', { name: 'Completar Llamar a Juan' }))

    await waitFor(() => expect(mocks.calls.filter(c => c.fn === 'setTaskStatus')).toHaveLength(1))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('tocar la fila abre el detalle y NO completa', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    await openDetail()
    expect(mocks.calls.filter(c => c.fn === 'setTaskStatus')).toHaveLength(0)
  })

  it('no dispara dos escrituras si se toca dos veces seguidas', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    const toggle = screen.getByRole('button', { name: 'Completar Llamar a Juan' })
    fireEvent.click(toggle)
    fireEvent.click(toggle)

    await waitFor(() => expect(mocks.calls.filter(c => c.fn === 'setTaskStatus').length).toBeGreaterThan(0))
    expect(mocks.calls.filter(c => c.fn === 'setTaskStatus')).toHaveLength(1)
  })
})

// ─── Superficie de detalle ────────────────────────────────────────────────────

describe('detalle como sheet', () => {
  it('abre y cierra desde el control de cierre', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')
    await openDetail()

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('cierra con Escape', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')
    await openDetail()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('se presenta como sheet en mobile y expone el offset de teclado', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')
    await openDetail()

    const surface = document.querySelector('[data-testid="responsive-dialog"]') as HTMLElement
    expect(surface.dataset.mobilePresentation).toBe('sheet')
    // La primitiva publica el offset del teclado; el footer lo consume por CSS.
    const overlay = document.querySelector('.modal-overlay') as HTMLElement
    expect(overlay.style.getPropertyValue('--mobile-keyboard-offset')).toMatch(/px$/)
  })

  it('las cuatro pestañas siguen disponibles y se puede cambiar entre ellas', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')
    const dialog = await openDetail()

    for (const label of ['Detalles', 'Checklist', 'Comentarios', 'Historial']) {
      expect(within(dialog).getByRole('tab', { name: new RegExp(label) })).toBeInTheDocument()
    }

    fireEvent.click(within(dialog).getByRole('tab', { name: /Comentarios/ }))
    expect(await within(dialog).findByPlaceholderText('Escribí un comentario…')).toBeInTheDocument()
  })
})

// ─── Targets táctiles ─────────────────────────────────────────────────────────

describe('targets táctiles de 44px', () => {
  it('completar en la lista', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')

    const toggle = screen.getByRole('button', { name: 'Completar Llamar a Juan' })
    expect(toggle.style.minWidth).toBe('44px')
    expect(toggle.style.minHeight).toBe('44px')
  })

  it('marcar y eliminar un ítem del checklist', async () => {
    mocks.checklist = [{ id: 'i1', task_id: 'task-1', title: 'Revisar', is_done: false, sort_order: 0 }]
    renderTasks()
    await screen.findByText('Llamar a Juan')
    const dialog = await openDetail()

    fireEvent.click(within(dialog).getByRole('tab', { name: /Checklist/ }))

    const check = await within(dialog).findByRole('button', { name: 'Marcar Revisar' })
    expect(check.style.minWidth).toBe('44px')
    expect(check.style.minHeight).toBe('44px')

    // El de borrar era el más chico de todos (~29px) antes de este lote.
    const del = within(dialog).getByRole('button', { name: 'Eliminar Revisar' })
    expect(del.style.minWidth).toBe('44px')
    expect(del.style.minHeight).toBe('44px')
  })
})

// ─── Checklist / errores ──────────────────────────────────────────────────────

describe('checklist en mobile', () => {
  it('agrega un ítem con Enter, sin obligar a ir al botón', async () => {
    renderTasks()
    await screen.findByText('Llamar a Juan')
    const dialog = await openDetail()
    fireEvent.click(within(dialog).getByRole('tab', { name: /Checklist/ }))

    const input = await within(dialog).findByLabelText('Nuevo ítem del checklist')
    fireEvent.change(input, { target: { value: 'nuevo' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await within(dialog).findByText('nuevo')).toBeInTheDocument()
  })

  it('un checklist incompleto bloquea y el mensaje queda visible en el detalle', async () => {
    mocks.statusError = new TaskServiceError(
      'validation', 'Completá todos los ítems del checklist primero.', { reason: 'checklist' },
    )
    mocks.checklist = [{ id: 'i1', task_id: 'task-1', title: 'Revisar', is_done: false, sort_order: 0 }]
    renderTasks()
    await screen.findByText('Llamar a Juan')
    const dialog = await openDetail()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Completar' }))

    expect(await within(dialog).findByRole('alert'))
      .toHaveTextContent('Completá todos los ítems del checklist primero.')
  })
})
