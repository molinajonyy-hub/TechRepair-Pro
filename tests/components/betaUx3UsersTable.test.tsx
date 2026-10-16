// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-3 (ronda 2) — Usuarios: acciones de la fila a la vista y por teclado.
//
// Dentro de Configuración, entre 1024 y 1280 px de ventana, la tabla tiene 428 a
// 684 px: con cinco columnas, Estado y Acciones quedaban detrás de un scroll
// horizontal. Ahora:
//   T  la tabla: Usuario (con el email) · Rol · Estado · Acciones, con roles ARIA
//      explícitos para conservar la semántica cuando el CSS la vuelve ficha
//   A  acciones: «Permisos» con nombre + menú de la fila (Activar/Desactivar)
//   K  teclado: Tab llega a rol → Permisos → menú; Enter abre; Escape cierra y
//      devuelve el foco; el editor de permisos es un diálogo y se tilda con Space
//      (la trampa de foco con Tab necesita layout: la mide el E2E)
//   P  permisos y funcionalidades: los mismos que antes (quién gestiona, filas
//      protegidas, el rol, activar/desactivar, el diff de permisos)
//   C  contrato de CSS: container query sobre la tabla (no sobre la ventana)
//
// jsdom no aplica CSS: que en 1024/1152/1280 px todo quede a la vista y sin
// scroll lo mide `tests/e2e/m7/beta-ux-3-admin-help.spec.ts`.
// ─────────────────────────────────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'

const OWNER_ID = 'u-owner'

const state = vi.hoisted(() => ({
  actor: null as unknown as Record<string, unknown>,
  users: [] as Array<Record<string, unknown>>,
  changeUserRole: null as unknown as ReturnType<typeof vi.fn>,
  setUserActiveStatus: null as unknown as ReturnType<typeof vi.fn>,
  updateUserPermissions: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => state.actor }))
vi.mock('../../src/hooks/useSubscription', () => ({ useSubscription: () => ({}) }))
vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))
vi.mock('../../src/services/usersService', () => ({
  usersService: {
    getBusinessUsers: async () => state.users,
    changeUserRole: (...args: unknown[]) => state.changeUserRole(...args),
    setUserActiveStatus: (...args: unknown[]) => state.setUserActiveStatus(...args),
    updateUserPermissions: (...args: unknown[]) => state.updateUserPermissions(...args),
  },
}))
vi.mock('../../src/services/invitationsService', async () => {
  const real = await vi.importActual<typeof import('../../src/services/invitationsService')>('../../src/services/invitationsService')
  return { ...real, invitationsService: { ...real.invitationsService, listPendingInvitations: async () => [] } }
})

import { UsersManagement } from '../../src/pages/UsersManagement'

const miembro = (id: string, nombre: string, role: string, extra: Record<string, unknown> = {}) => ({
  id, user_id: id, business_id: 'biz-1', role, is_active: true, full_name: nombre,
  email: `${id}@invalid.test`, permissions: null, created_at: '2026-01-01T00:00:00Z', ...extra,
})

function comoActor(role: string, permissions: unknown = null) {
  state.actor = {
    user: { id: OWNER_ID }, businessId: 'biz-1', role,
    isOwner: role === 'owner', isAdmin: role === 'admin',
    profile: { id: OWNER_ID, permissions }, loading: false, profileLoading: false,
  }
}

async function montar() {
  render(<MemoryRouter><UsersManagement /></MemoryRouter>)
  return screen.findByRole('table', { name: 'Usuarios del negocio' })
}

const fila = (nombre: string) => screen.getAllByRole('row').find(r => r.textContent?.includes(nombre)) as HTMLElement

beforeEach(() => {
  comoActor('owner')
  state.users = [
    miembro(OWNER_ID, 'Dueña QA', 'owner'),
    miembro('u-tech', 'Técnico QA', 'tech'),
    miembro('u-baja', 'Vendedor de baja', 'sales', { is_active: false }),
  ]
  state.changeUserRole = vi.fn(async () => undefined)
  state.setUserActiveStatus = vi.fn(async () => undefined)
  state.updateUserPermissions = vi.fn(async () => undefined)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('T · la tabla', () => {
  it('T1. cuatro columnas con nombre; el email vive en la celda del usuario', async () => {
    const tabla = await montar()
    expect(within(tabla).getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Usuario', 'Rol', 'Estado', 'Acciones'])
    const celda = within(fila('Técnico QA')).getAllByRole('cell')[0]
    expect(celda).toHaveTextContent('Técnico QA')
    expect(celda).toHaveTextContent('u-tech@invalid.test')
  })

  it('T2. filas y celdas declaran su rol: la semántica no depende del `display`', async () => {
    const tabla = await montar()
    expect(tabla).toHaveAttribute('role', 'table')
    for (const tr of tabla.querySelectorAll('tr')) expect(tr).toHaveAttribute('role', 'row')
    for (const td of tabla.querySelectorAll('td')) expect(td).toHaveAttribute('role', 'cell')
    for (const th of tabla.querySelectorAll('th')) expect(th).toHaveAttribute('role', 'columnheader')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A · acciones de la fila', () => {
  it('A1. «Permisos» tiene nombre visible y accesible; el menú anuncia que es un menú', async () => {
    await montar()
    const f = fila('Técnico QA')
    const permisos = within(f).getByRole('button', { name: 'Editar permisos de Técnico QA' })
    expect(permisos).toHaveTextContent('Permisos')
    expect(permisos).toHaveAttribute('title', 'Editar permisos')
    const menu = within(f).getByRole('button', { name: 'Más acciones de Técnico QA' })
    expect(menu).toHaveAttribute('aria-haspopup', 'menu')
    expect(menu).toHaveAttribute('aria-expanded', 'false')
    expect(within(f).getByRole('combobox', { name: 'Rol de Técnico QA' })).toHaveValue('tech')
  })

  it('A2. activo → el menú ofrece «Desactivar usuario» (destructivo) y pide confirmación', async () => {
    const user = userEvent.setup()
    await montar()
    await user.click(within(fila('Técnico QA')).getByRole('button', { name: 'Más acciones de Técnico QA' }))
    const menu = screen.getByRole('menu', { name: 'Más acciones de Técnico QA' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map(i => i.textContent)).toEqual(['Desactivar usuario'])
    expect(items[0]).toHaveClass('is-destructive')
    await user.click(items[0])
    expect(window.confirm).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(state.setUserActiveStatus).toHaveBeenCalledWith('u-tech', false))
  })

  it('A2. inactivo → «Activar usuario», sin confirmación', async () => {
    const user = userEvent.setup()
    await montar()
    await user.click(within(fila('Vendedor de baja')).getByRole('button', { name: 'Más acciones de Vendedor de baja' }))
    const item = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Activar usuario' })
    await user.click(item)
    expect(window.confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(state.setUserActiveStatus).toHaveBeenCalledWith('u-baja', true))
  })

  it('A3. cambiar el rol sigue siendo directo, desde la fila', async () => {
    const user = userEvent.setup()
    await montar()
    await user.selectOptions(within(fila('Técnico QA')).getByRole('combobox', { name: 'Rol de Técnico QA' }), 'cashier')
    await waitFor(() => expect(state.changeUserRole).toHaveBeenCalledWith('u-tech', 'cashier'))
  })

  it('A4. permisos personalizados: lo dice el nombre accesible, no sólo un punto de color', async () => {
    state.users[1] = miembro('u-tech', 'Técnico QA', 'tech', { permissions: { inventory: true } })
    await montar()
    const permisos = within(fila('Técnico QA')).getByRole('button', { name: 'Editar permisos de Técnico QA (personalizados)' })
    expect(permisos.querySelector('.users-table__custom-dot')).not.toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('K · teclado', () => {
  it('K1. Tab recorre la fila en orden: rol → Permisos → menú', async () => {
    const user = userEvent.setup()
    await montar()
    const f = fila('Técnico QA')
    within(f).getByRole('combobox', { name: 'Rol de Técnico QA' }).focus()
    await user.tab()
    expect(within(f).getByRole('button', { name: 'Editar permisos de Técnico QA' })).toHaveFocus()
    await user.tab()
    expect(within(f).getByRole('button', { name: 'Más acciones de Técnico QA' })).toHaveFocus()
  })

  it('K2. Enter en «Permisos» abre el diálogo con el foco adentro; Escape lo cierra y el foco vuelve', async () => {
    const user = userEvent.setup()
    await montar()
    const permisos = within(fila('Técnico QA')).getByRole('button', { name: 'Editar permisos de Técnico QA' })
    permisos.focus()
    await user.keyboard('{Enter}')
    const dialogo = await screen.findByRole('dialog', { name: 'Permisos — Técnico QA' })
    expect(dialogo).toHaveAttribute('aria-modal', 'true')
    await waitFor(() => expect(dialogo.contains(document.activeElement)).toBe(true))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(permisos).toHaveFocus()
  })

  it('K4. la matriz se opera con el teclado: Space tilda y Guardar manda el diff', async () => {
    const user = userEvent.setup()
    await montar()
    within(fila('Técnico QA')).getByRole('button', { name: 'Editar permisos de Técnico QA' }).focus()
    await user.keyboard('{Enter}')
    const dialogo = await screen.findByRole('dialog', { name: 'Permisos — Técnico QA' })
    // El diálogo pone el foco en «Cerrar» al abrir; recién ahí se navega.
    await waitFor(() => expect(within(dialogo).getByRole('button', { name: 'Cerrar' })).toHaveFocus())
    const inventario = within(dialogo).getByRole('checkbox', { name: /^Inventario/ })
    expect(inventario).not.toBeChecked()
    // jsdom no tiene layout (`offsetParent` es null) y la trampa de foco del
    // diálogo no puede recorrer con Tab: se enfoca el control. El recorrido con
    // Tab real lo mide el E2E.
    inventario.focus()
    await user.keyboard(' ')
    expect(inventario).toBeChecked()
    within(dialogo).getByRole('button', { name: 'Guardar permisos' }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(state.updateUserPermissions).toHaveBeenCalledWith('u-tech', { inventory: true }))
  })

  it('K5. un permiso automático (Mayorista para admin) es un checkbox tildado y deshabilitado', async () => {
    state.users[1] = miembro('u-admin', 'Admin QA', 'admin')
    const user = userEvent.setup()
    await montar()
    await user.click(within(fila('Admin QA')).getByRole('button', { name: 'Editar permisos de Admin QA' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Permisos — Admin QA' })
    const mayorista = within(dialogo).getByRole('checkbox', { name: /^Mayorista/ })
    expect(mayorista).toBeChecked()
    expect(mayorista).toBeDisabled()
  })

  it('K6. Enter en el menú lo abre con el foco en su acción; Escape lo cierra y el foco vuelve', async () => {
    const user = userEvent.setup()
    await montar()
    const disparador = within(fila('Técnico QA')).getByRole('button', { name: 'Más acciones de Técnico QA' })
    disparador.focus()
    await user.keyboard('{Enter}')
    const item = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Desactivar usuario' })
    expect(item).toHaveFocus()
    expect(disparador).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(disparador).toHaveFocus()
    expect(state.setUserActiveStatus).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('P · permisos y funcionalidades de siempre', () => {
  it('P1. la propia fila y la del dueño no tienen acciones', async () => {
    comoActor('admin')
    state.users = [miembro('u-duenia', 'Dueña QA', 'owner'), { ...miembro(OWNER_ID, 'Yo Admin', 'admin') }, miembro('u-tech', 'Técnico QA', 'tech')]
    await montar()
    expect(fila('Dueña QA')).toHaveTextContent('Protegido')
    expect(fila('Yo Admin')).toHaveTextContent('Tu usuario')
    for (const nombre of ['Dueña QA', 'Yo Admin']) {
      expect(within(fila(nombre)).queryByRole('combobox')).toBeNull()
      expect(within(fila(nombre)).queryByRole('button')).toBeNull()
    }
    expect(within(fila('Técnico QA')).getByRole('button', { name: 'Editar permisos de Técnico QA' })).toBeInTheDocument()
  })

  it('P2. quien entra con `users` sin ser owner/admin ve la lista, sin acciones (como antes)', async () => {
    comoActor('tech', { users: true })
    const tabla = await montar()
    expect(within(tabla).getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Usuario', 'Rol', 'Estado'])
    expect(within(tabla).queryAllByRole('button')).toHaveLength(0)
    expect(within(tabla).queryAllByRole('combobox')).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C · contrato de CSS', () => {
  const css = readFileSync('src/index.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const bloque = (desde: string) => css.slice(css.indexOf(desde), css.indexOf('}\n}', css.indexOf(desde)) + 3)

  it('C1. la tabla es contenedor de su propio ancho y no scrollea (salvo sin container queries)', () => {
    const base = css.slice(css.indexOf('.users-table {'), css.indexOf('}', css.indexOf('.users-table {')))
    expect(base).toMatch(/container-type: inline-size/)
    expect(base).not.toMatch(/overflow/)
    expect(css).toMatch(/@supports not \(container-type: inline-size\) \{\s*\.users-table \{ overflow-x: auto; \}/)
  })

  it('C2. por debajo de 640 px de tabla, cada fila es una ficha de dos renglones con objetivos de 44 px', () => {
    const ficha = bloque('@container (max-width: 639px)')
    expect(ficha).toMatch(/grid-template-areas: "user status" "role actions"/)
    expect(ficha).toMatch(/\.users-table__permissions \{ min-height: var\(--mobile-touch-target\)/)
    expect(ficha).toMatch(/\.users-table__menu \.overflow-menu__trigger \{ min-width: var\(--mobile-touch-target\); min-height: var\(--mobile-touch-target\)/)
    // Los encabezados salen de la vista, no del árbol de accesibilidad.
    expect(ficha).toMatch(/\.users-table__table thead \{[^}]*clip-path: inset\(50%\)/)
    expect(ficha).not.toMatch(/thead \{[^}]*display: none/)
  })

  it('C3. foco visible en rol, Permisos, menú y checkboxes de la matriz', () => {
    for (const selector of ['.users-table__role-select:focus-visible', '.users-table__permissions:focus-visible', '.users-table__menu .overflow-menu__trigger:focus-visible', '.perm-toggle__input:focus-visible + .perm-toggle__box']) {
      expect(css, selector).toContain(`${selector} { outline: 2px solid var(--accent-primary)`)
    }
  })
})
