// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1D · `OverflowMenu` también lo usa Tareas.
//
// 1D le agregó al menú un `scrollIntoView` al abrirse (para que sus últimas
// acciones no queden debajo de la barra de navegación mobile). El primitivo es
// compartido y el otro consumidor es la fila de Tareas, que no tenía ningún test
// que ABRIERA su menú. Regresión chica: el menú de una tarea sigue abriendo,
// sigue ofreciendo Editar / Eliminar y sigue llamando a sus handlers — con
// `scrollIntoView` disponible y sin él.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskListItem, type TaskListItemProps } from '../../src/components/tasks/TaskListItem'

const TASK = {
  id: 't1', title: 'Llamar al proveedor', description: null,
  status: 'pending', priority: 'medium', due_date: null,
} as unknown as TaskListItemProps['task']

function renderTask(over: Partial<TaskListItemProps> = {}) {
  const handlers = { onOpen: vi.fn(), onToggleComplete: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
  render(
    <ul>
      <TaskListItem
        task={TASK} assigneeName={null} showAssignee={false} busy={false} error={null}
        canComplete canManage {...handlers} {...over}
      />
    </ul>,
  )
  return handlers
}

afterEach(() => { Reflect.deleteProperty(Element.prototype, 'scrollIntoView') })

describe('BETA-UX-1D · el menú de una tarea sigue funcionando con el OverflowMenu compartido', () => {
  it('abre, ofrece Editar y Eliminar, y cada una llama a su handler sin abrir la tarea', () => {
    const handlers = renderTask()

    const disparador = screen.getByRole('button', { name: 'Acciones de Llamar al proveedor' })
    fireEvent.click(disparador)
    const menu = screen.getByRole('menu', { name: 'Acciones de Llamar al proveedor' })
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Editar', 'Eliminar'])

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Editar' }))
    expect(handlers.onEdit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.click(disparador)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Eliminar' }))
    expect(handlers.onDelete).toHaveBeenCalledOnce()
    // Ni abrir el menú ni elegir una acción abre o completa la tarea.
    expect(handlers.onOpen).not.toHaveBeenCalled()
    expect(handlers.onToggleComplete).not.toHaveBeenCalled()
  })

  it('al abrirse pide traerse a la vista, una vez y sin forzar un salto', () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView })
    renderTask()

    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Llamar al proveedor' }))

    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollIntoView.mock.instances[0]).toBe(screen.getByRole('menu'))
  })

  it('en un entorno sin `scrollIntoView` el menú abre igual', () => {
    // jsdom no lo implementa: es el caso por defecto de este archivo.
    expect('scrollIntoView' in Element.prototype).toBe(false)
    renderTask()

    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Llamar al proveedor' }))
    expect(screen.getByRole('menu')).toBeVisible()
  })

  it('Escape cierra el menú y devuelve el foco al disparador', () => {
    renderTask()
    const disparador = screen.getByRole('button', { name: 'Acciones de Llamar al proveedor' })

    fireEvent.click(disparador)
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0])
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(disparador)
  })

  it('sin permiso de gestión la fila no ofrece el menú', () => {
    renderTask({ canManage: false })
    expect(screen.queryByRole('button', { name: 'Acciones de Llamar al proveedor' })).not.toBeInTheDocument()
  })
})
