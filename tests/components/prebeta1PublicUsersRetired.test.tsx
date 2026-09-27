// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-1 · `public.users` fuera de la API — contrato del frontend.
//
// La migración 20261010120000 revoca todo acceso de API a `public.users`
// (tabla legacy GLOBAL, sin business_id). Desde entonces PostgREST responde
// 42501 a cualquier request que la nombre, y un embed `technician:users(...)`
// hace fallar la consulta PADRE entera.
//
// El fake de supabase de este archivo se comporta como el PostgREST post-fix:
// `.from('users')` o un select que embeba `users(` -> 42501. Con el código previo
// al fix, Reports perdía TODAS las órdenes completadas (el embed tiraba la
// consulta) y OrderDetail disparaba lecturas a `users`. Estos tests fijan:
//   · ningún consumidor vivo consulta `public.users`;
//   · lo que ve el usuario no cambia: `technician_id` es NULL en el 100% de las
//     órdenes, así que el técnico ya se mostraba vacío / "Sin asignar".
// Atribuir por `assigned_profile_id` es otro lote y NO se prueba acá.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, renderHook, screen, waitFor, act } from '@testing-library/react'

const estado = vi.hoisted(() => ({
  filas: {} as Record<string, Array<Record<string, unknown>>>,
  requests: [] as Array<{ tabla: string; columnas: string }>,
}))

const DENEGADO = { code: '42501', message: 'permission denied for table users' }
const tocaUsers = (tabla: string, columnas: string) => tabla === 'users' || /(^|[,\s(:])users\s*\(/.test(columnas)

function construirQuery(tabla: string) {
  let columnas = ''
  const resultado = () => {
    if (tocaUsers(tabla, columnas)) return { data: null, error: DENEGADO, count: null }
    const filas = estado.filas[tabla] ?? []
    return { data: filas, error: null, count: filas.length }
  }
  const q: any = {
    select: (c?: string) => { columnas = c ?? '*'; estado.requests.push({ tabla, columnas }); return q },
    eq: () => q, neq: () => q, gte: () => q, lt: () => q, lte: () => q, in: () => q,
    order: () => q, limit: () => q, is: () => q, not: () => q, or: () => q,
    single: async () => {
      const r = resultado()
      return r.error ? r : { data: (r.data as unknown[])[0] ?? null, error: null }
    },
    maybeSingle: async () => {
      const r = resultado()
      return r.error ? r : { data: (r.data as unknown[])[0] ?? null, error: null }
    },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(resultado()).then(resolve),
  }
  return q
}

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      if (tabla === 'users') estado.requests.push({ tabla, columnas: '(from users)' })
      return construirQuery(tabla)
    },
    rpc: async (nombre: string) => {
      if (nombre === 'get_order_financial_amounts') {
        return { data: { ok: true, authorized: true, rows: [{ order_id: 'orden-1', total_cost: 0, amount_paid: 0 }] }, error: null }
      }
      if (nombre === 'get_my_profile') return { data: [{ business_id: 'biz-1' }], error: null }
      return { data: false, error: null }
    },
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
  },
}))

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1', isAuthenticated: true, hasBusinessAccess: true, loading: false, profileLoading: false }),
}))
vi.mock('../../src/hooks/useDashboardStats', () => ({
  useDashboardStats: () => ({ stats: null, loading: false, error: null }),
}))
vi.mock('../../src/services/inventoryService', () => ({
  inventoryService: { getLowStockItems: async () => [], getOutOfStockItems: async () => [] },
}))
vi.mock('../../src/services/inventoryReportsService', () => ({
  inventoryReportsService: { calculateTotalValue: async () => 0 },
}))

import { useOrderSimple } from '../../src/hooks/useOrderSimple'
import { ordersService } from '../../src/services/api'
import { Reports } from '../../src/pages/Reports'

const lecturasDeUsers = () => estado.requests.filter((r) => tocaUsers(r.tabla, r.columnas) || r.tabla === 'users')

beforeEach(() => {
  estado.filas = {}
  estado.requests = []
})

describe('PRE-BETA-1 · OrderDetail (useOrderSimple) no lee public.users', () => {
  it('abrir y refrescar una orden con technician_id legacy no consulta users y deja technician en null', async () => {
    estado.filas = {
      orders: [{ id: 'orden-1', business_id: 'biz-1', status: 'received', customer_id: 'cus-1', device_id: null, technician_id: 'legacy-tech-1' }],
      customers: [{ id: 'cus-1', name: 'Cliente Demo' }],
    }
    const { result } = renderHook(() => useOrderSimple('orden-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBeNull()
    expect(result.current.order?.id).toBe('orden-1')
    expect(result.current.order?.customer).toMatchObject({ name: 'Cliente Demo' })
    expect(result.current.order?.technician).toBeNull()

    await act(async () => { await result.current.refresh() })
    expect(result.current.order?.technician).toBeNull()
    expect(lecturasDeUsers()).toEqual([])
  })
})

describe('PRE-BETA-1 · ordersService no embebe users', () => {
  it('getById responde sin el embed technician:users (antes: 42501 de toda la consulta)', async () => {
    estado.filas = { orders: [{ id: 'orden-1', business_id: 'biz-1', parts_used: [] }] }
    const orden = await ordersService.getById('orden-1')
    expect(orden.id).toBe('orden-1')
    expect(lecturasDeUsers()).toEqual([])
  })

  it('getAll responde sin el embed technician:users', async () => {
    estado.filas = { orders: [{ id: 'orden-1', business_id: 'biz-1' }] }
    const ordenes = await ordersService.getAll()
    expect(ordenes).toHaveLength(1)
    expect(lecturasDeUsers()).toEqual([])
  })
})

describe('PRE-BETA-1 · Reports sigue contando las órdenes completadas', () => {
  it('la consulta de completadas no embebe users y el ranking queda en "Sin asignar"', async () => {
    const reciente = new Date(Date.now() - 60_000).toISOString()
    estado.filas = { orders: [{ updated_at: reciente }, { updated_at: reciente }] }

    render(<Reports />)

    // Con el embed viejo, el 42501 vaciaba las completadas y se mostraba el
    // estado vacío; ahora el ranking tiene las 2 órdenes (técnico sin asignar,
    // como siempre: technician_id es NULL en el 100% de las órdenes).
    expect(await screen.findByText('Sin asignar')).toBeTruthy()
    expect(screen.queryByText(/No hay ordenes completadas con tecnico asignado/)).toBeNull()
    const completadas = screen.getByText('Ordenes completadas').closest('.stat-card')
    expect(completadas?.querySelector('.stat-card-value')?.textContent).toBe('2')

    const consulta = estado.requests.find((r) => r.tabla === 'orders')
    expect(consulta?.columnas).toBe('updated_at')
    expect(lecturasDeUsers()).toEqual([])
  })
})
