import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecurringExpense } from '../../src/hooks/useRecurringExpenses'

type Result = { data: unknown; error: { message: string } | null }
const state = vi.hoisted(() => ({
  rows: [] as RecurringExpense[], businessId: 'biz-1', finance: true, feature: true,
  readError: null as { message: string } | null,
  writeError: null as { message: string } | null,
  zeroRows: false,
  readGate: null as Promise<void> | null,
  writeGate: null as Promise<void> | null,
  reads: [] as string[], writes: [] as { method: string; payload: Record<string, unknown>; filters: Record<string, unknown> }[],
}))

vi.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({
  businessId: state.businessId, user: { id: 'user-1' }, authState: 'AUTHENTICATED',
  role: 'tech', isOwner: false, profile: { permissions: { finance: state.finance } },
}) }))
vi.mock('../../src/hooks/useSystemOwner', () => ({ useSystemOwner: () => ({ isSystemOwner: false, loading: false }) }))
vi.mock('../../src/hooks/useSubscription', () => ({ useSubscription: () => ({
  hasFeature: () => state.feature, loading: false, currentPlan: null, planFeatures: {}, isTrial: false,
}) }))
vi.mock('../../src/lib/supabase', () => ({ supabase: {
  rpc: async () => ({ data: { ok: true, period: { from: '2026-09-01', to: '2026-09-30' } }, error: null }),
  from: (table: string) => {
    const filters: Record<string, unknown> = {}
    let method = 'select'
    let payload: Record<string, unknown> = {}
    const execute = async (single: boolean): Promise<Result> => {
      if (method === 'select') {
        state.reads.push(table)
        const rows = state.rows.filter(row => Object.entries(filters).every(([key, value]) => row[key as keyof RecurringExpense] === value))
        await state.readGate
        return { data: table === 'recurring_expenses' ? rows : single ? null : [], error: table === 'recurring_expenses' ? state.readError : null }
      }
      state.writes.push({ method, payload, filters: { ...filters } })
      await state.writeGate
      if (state.writeError) return { data: null, error: state.writeError }
      const index = state.rows.findIndex(row => Object.entries(filters).every(([key, value]) => row[key as keyof RecurringExpense] === value))
      if (state.zeroRows || (method === 'update' && index < 0)) return { data: null, error: { message: 'Cannot coerce the result to a single JSON object' } }
      const saved = (method === 'insert' ? { id: 'new-1', ...payload } : { ...state.rows[index], ...payload }) as RecurringExpense
      if (method === 'insert') state.rows.push(saved)
      else state.rows[index] = saved
      return { data: saved, error: null }
    }
    const chain = {
      select: () => chain,
      eq: (key: string, value: unknown) => { filters[key] = value; return chain },
      order: () => chain, gte: () => chain, lte: () => chain, limit: () => chain,
      update: (data: Record<string, unknown>) => { method = 'update'; payload = data; return chain },
      insert: (data: Record<string, unknown>) => { method = 'insert'; payload = data; return chain },
      single: () => execute(true), maybeSingle: () => execute(true),
      then: (resolve: (result: Result) => unknown, reject: (cause: unknown) => unknown) => execute(false).then(resolve, reject),
    }
    return chain
  },
} }))

import { RecurringExpensesPanel } from '../../src/components/finance/RecurringExpensesPanel'
import { ProtectedRouteByPermission } from '../../src/components/auth/ProtectedRouteByPermission'
import { ProtectedRouteByFeature } from '../../src/components/auth/ProtectedRouteByFeature'
import { FinanceDashboard } from '../../src/pages/FinanceDashboard'

const expense = (overrides: Partial<RecurringExpense> = {}): RecurringExpense => ({
  id: 'expense-1', business_id: 'biz-1', name: 'Internet local', type: 'fixed_cost_local', category: 'internet',
  subcategory: 'Fibra', amount: 1234.5, currency: 'ARS', day_of_month: 10, is_active: true,
  notes: 'Plan mensual', created_at: '', updated_at: '', ...overrides,
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const renderGuarded = (dashboard = false) => render(<MemoryRouter initialEntries={['/finance']}><Routes>
  <Route element={<ProtectedRouteByPermission permission="finance" />}>
    <Route element={<ProtectedRouteByFeature feature="advancedFinance" />}>
      <Route path="/finance" element={dashboard ? <FinanceDashboard /> : <RecurringExpensesPanel />} />
    </Route>
  </Route>
  <Route path="/dashboard" element={<p>Inicio permitido</p>} />
</Routes></MemoryRouter>)

beforeEach(() => {
  state.rows = []
  state.businessId = 'biz-1'
  state.finance = state.feature = true
  state.readError = state.writeError = null
  state.zeroRows = false
  state.readGate = state.writeGate = null
  state.reads = []
  state.writes = []
})

describe('Gastos recurrentes · componentes y hook reales, borde Supabase simulado', () => {
  it('finance autorizado ve el panel en Gastos del dashboard y conserva el enlace separado a /expenses', async () => {
    state.rows = [expense()]
    renderGuarded(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Gastos' }))
    expect(await screen.findByText('Internet local')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Gastos recurrentes' })).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Ver gastos' })).toHaveAttribute('href', '/expenses')
    expect(state.reads).not.toContain('expenses')
    expect(state.reads).not.toContain('business_finance_entries')
  })

  it('loading no se confunde con empty; empty ofrece crear', async () => {
    const gate = deferred()
    state.readGate = gate.promise
    renderGuarded()
    expect(screen.getByRole('status', { name: 'Cargando gastos recurrentes' })).toBeInTheDocument()
    expect(screen.queryByText('Todavía no hay gastos recurrentes')).not.toBeInTheDocument()
    await act(async () => gate.resolve())
    expect(await screen.findByText('Todavía no hay gastos recurrentes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Crear gasto recurrente' })).toBeInTheDocument()
  })

  it('query error muestra el error real, nunca empty; permite reintentar', async () => {
    state.readError = { message: 'permission denied for table recurring_expenses' }
    renderGuarded()
    expect(await screen.findByRole('alert')).toHaveTextContent(state.readError.message)
    expect(screen.queryByText('Todavía no hay gastos recurrentes')).not.toBeInTheDocument()
    state.readError = null
    state.rows = [expense()]
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await screen.findByText('Internet local')).toBeInTheDocument()
  })

  it('editar precarga, valida, guarda el payload y refresca la fila confirmada', async () => {
    state.rows = [expense()]
    renderGuarded()
    fireEvent.click(await screen.findByRole('button', { name: 'Editar Internet local' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Nombre / concepto')).toHaveValue('Internet local')
    expect(within(dialog).getByLabelText('Importe mensual', { selector: 'input' })).toHaveValue('1.234,50')
    expect(within(dialog).getByLabelText('Moneda')).toHaveValue('ARS')
    expect(within(dialog).getByLabelText('Día del mes')).toHaveValue(10)
    expect(within(dialog).getByLabelText('Notas (opcional)')).toHaveValue('Plan mensual')
    fireEvent.change(within(dialog).getByLabelText('Día del mes'), { target: { value: '29' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar recurrente' }))
    expect(screen.getByText('Elegí un día entre 1 y 28.')).toBeInTheDocument()
    expect(state.writes).toHaveLength(0)
    fireEvent.change(within(dialog).getByLabelText('Nombre / concepto'), { target: { value: 'Internet actualizado' } })
    fireEvent.change(within(dialog).getByLabelText('Importe mensual', { selector: 'input' }), { target: { value: '2.500,75' } })
    fireEvent.change(within(dialog).getByLabelText('Moneda'), { target: { value: 'USD' } })
    fireEvent.change(within(dialog).getByLabelText('Día del mes'), { target: { value: '28' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar recurrente' }))
    expect(await screen.findByText('Internet actualizado')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(state.writes[0]).toMatchObject({ method: 'update', filters: { id: 'expense-1', business_id: 'biz-1' }, payload: {
      name: 'Internet actualizado', amount: 2500.75, currency: 'USD', day_of_month: 28, notes: 'Plan mensual',
    } })
    expect(state.writes[0].payload).not.toHaveProperty('type')
    expect(state.rows[0].subcategory).toBe('Fibra')
    expect(state.reads.filter(table => table === 'recurring_expenses')).toHaveLength(2)
    expect(screen.getByRole('status')).toHaveTextContent('Gasto recurrente actualizado.')
  })

  it.each(['backend-error', 'zero-rows'])('fallo %s conserva el formulario sin éxito falso', async mode => {
    state.rows = [expense()]
    if (mode === 'backend-error') state.writeError = { message: 'new row violates row-level security policy' }
    else state.zeroRows = true
    renderGuarded()
    fireEvent.click(await screen.findByRole('button', { name: 'Editar Internet local' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar recurrente' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(mode === 'backend-error' ? 'row-level security' : 'single JSON object')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText('Gasto recurrente actualizado.')).not.toBeInTheDocument()
    expect(state.reads.filter(table => table === 'recurring_expenses')).toHaveLength(1)
  })

  it('bloquea doble submit y cierre durante el guardado', async () => {
    state.rows = [expense()]
    const gate = deferred()
    state.writeGate = gate.promise
    renderGuarded()
    fireEvent.click(await screen.findByRole('button', { name: 'Editar Internet local' }))
    const form = screen.getByRole('dialog').querySelector('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(screen.getByRole('button', { name: 'Guardando…' })).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(state.writes).toHaveLength(1)
    await act(async () => gate.resolve())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('crea una plantilla con tipo/categoría existentes y tenant actual', async () => {
    renderGuarded()
    fireEvent.click(await screen.findByRole('button', { name: 'Crear gasto recurrente' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar recurrente' }))
    expect(screen.getByText('Ingresá un nombre.')).toBeInTheDocument()
    expect(state.writes).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('Nombre / concepto'), { target: { value: 'Alquiler' } })
    fireEvent.change(screen.getByLabelText('Importe mensual', { selector: 'input' }), { target: { value: '150.000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar recurrente' }))
    expect(await screen.findByRole('heading', { name: 'Alquiler' })).toBeInTheDocument()
    expect(state.writes[0]).toMatchObject({ method: 'insert', payload: {
      business_id: 'biz-1', name: 'Alquiler', amount: 150000, currency: 'ARS', day_of_month: 1,
      type: 'fixed_cost_local', category: 'alquiler', is_active: true,
    } })
  })

  it('muestra activos/inactivos y permite desactivar/reactivar sin DELETE', async () => {
    state.rows = [expense()]
    renderGuarded()
    fireEvent.click(await screen.findByRole('button', { name: 'Desactivar Internet local' }))
    expect(await screen.findByText('No hay recurrentes activos')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Mostrar recurrentes'), { target: { value: 'inactive' } })
    expect(screen.getByText('Inactivo')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reactivar Internet local' }))
    expect(await screen.findByText('No hay recurrentes inactivos')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Mostrar recurrentes'), { target: { value: 'all' } })
    expect(screen.getByText('Activo')).toBeInTheDocument()
    expect(state.writes.map(write => write.payload.is_active)).toEqual([false, true])
    expect(state.writes.every(write => write.method === 'update')).toBe(true)
  })

  it('rechaza finance=false por el guard real sin consultar plantillas', async () => {
    state.finance = false
    renderGuarded()
    expect(await screen.findByText('Inicio permitido')).toBeInTheDocument()
    expect(screen.queryByText('Gastos recurrentes')).not.toBeInTheDocument()
    expect(state.reads).toHaveLength(0)
  })

  it('hereda advancedFinance sin agregar un bypass', async () => {
    state.feature = false
    renderGuarded()
    expect(await screen.findByText('Finanzas Pro')).toBeInTheDocument()
    expect(screen.queryByText('Gastos recurrentes')).not.toBeInTheDocument()
    expect(state.reads).toHaveLength(0)
  })

  it('cambiar de tenant descarta el editor y no muestra filas de otro negocio', async () => {
    state.rows = [expense(), expense({ id: 'other', business_id: 'biz-2', name: 'Otro negocio' })]
    const view = render(<RecurringExpensesPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Editar Internet local' }))
    state.businessId = 'biz-2'
    view.rerender(<RecurringExpensesPanel />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByText('Otro negocio')).toBeInTheDocument()
    expect(screen.queryByText('Internet local')).not.toBeInTheDocument()
  })

  it('mantiene /expenses y /finance/reports en sus modelos y superficies actuales', () => {
    const app = readFileSync('src/App.tsx', 'utf8')
    expect(app).toMatch(/permission="finance"[\s\S]*feature="advancedFinance"[\s\S]*path="\/finance"\s+element=\{<FinanceDashboard/)
    expect(app).toMatch(/path="\/expenses"\s+element=\{<Expenses \/>\}/)
    expect(app).toContain('path="/finance/reports" element={<FinanceReportsNotice />}')
    const source = readFileSync('src/pages/Expenses.tsx', 'utf8')
    expect(source).not.toContain('useRecurringExpenses')
    expect(source).not.toContain("from('recurring_expenses')")
  })
})
