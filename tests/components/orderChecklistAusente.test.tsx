// ─────────────────────────────────────────────────────────────────────────────
// `order_checklists` — lectura RETIRADA de useOrderSimple.
//
// Historia corta: abrir una orden dejaba un 406 PGRST116 en consola porque el
// hook leía el checklist con `.single()` y ninguna orden tenía fila. El primer
// arreglo pasó esa consulta a `.maybeSingle()`, que eliminó el 406.
//
// Después se comprobó algo más de fondo: la lectura no tenía NINGÚN consumidor.
// `result.checklist` se escribía y no se leía en ninguna parte, y la única UI
// que escribe esa tabla (`ChecklistCard`) no está montada en ninguna pantalla.
// En producción: 108 órdenes, 0 checklists.
//
// Así que la consulta se retiró entera. Estos tests fijan el contrato REAL:
// abrir una orden no toca `order_checklists` en absoluto.
//
// NO se testea acá `.single()` vs `.maybeSingle()` sobre esa tabla: sería un
// test de código muerto. Ese contrato sigue cubierto donde sí aplica, en
// tests/components/postgrest406.test.tsx (business_settings).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

interface TablaFake {
  filas?: Array<Record<string, unknown>>
  error?: { code: string; message: string; status: number }
}

const estado = vi.hoisted(() => ({
  tablas: {} as Record<string, TablaFake>,
  llamadas: [] as Array<{ tabla: string; metodo: 'single' | 'maybeSingle' | 'list' }>,
}))

function construirQuery(tabla: string) {
  const cfg = (): TablaFake => estado.tablas[tabla] ?? { filas: [] }

  const q: any = {
    select: () => q,
    eq: () => q,
    order: () => q,
    limit: () => q,

    single: async () => {
      estado.llamadas.push({ tabla, metodo: 'single' })
      const c = cfg()
      if (c.error) return { data: null, error: c.error }
      const n = (c.filas ?? []).length
      if (n !== 1) {
        return {
          data: null,
          error: {
            code: 'PGRST116',
            message: 'Cannot coerce the result to a single JSON object',
            details: `The result contains ${n} rows`,
            status: 406,
          },
        }
      }
      return { data: c.filas![0], error: null }
    },

    maybeSingle: async () => {
      estado.llamadas.push({ tabla, metodo: 'maybeSingle' })
      const c = cfg()
      if (c.error) return { data: null, error: c.error }
      const n = (c.filas ?? []).length
      if (n > 1) {
        return { data: null, error: { code: 'PGRST116', message: 'multiple rows returned', status: 406 } }
      }
      return { data: n === 1 ? c.filas![0] : null, error: null }
    },

    then: (resolve: (v: unknown) => unknown) => {
      estado.llamadas.push({ tabla, metodo: 'list' })
      const c = cfg()
      return Promise.resolve(
        c.error ? { data: null, error: c.error } : { data: c.filas ?? [], error: null },
      ).then(resolve)
    },
  }
  return q
}

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: (tabla: string) => construirQuery(tabla) },
}))

import { useOrderSimple } from '../../src/hooks/useOrderSimple'

const ORDER_ID = 'ae1dfa39-cc17-404f-944d-8986839b22e6'   // la orden real del 406

function escenarioBase() {
  estado.tablas = {
    orders: {
      filas: [{
        id: ORDER_ID, status: 'received', total_cost: 15000, amount_paid: 5000,
        customer_id: 'cus-1', device_id: null, technician_id: null,
      }],
    },
    customers: { filas: [{ id: 'cus-1', name: 'Cliente Demo' }] },
    order_parts: { filas: [{ id: 'p1', name: 'Pantalla' }] },
    order_items: { filas: [{ id: 'i1', descripcion: 'Mano de obra' }] },
  }
}

const lecturasDeChecklist = () => estado.llamadas.filter(c => c.tabla === 'order_checklists')

beforeEach(() => {
  estado.tablas = {}
  estado.llamadas = []
})

describe('useOrderSimple — no consulta order_checklists', () => {
  it('A · abrir una orden NO genera ningún request a order_checklists', async () => {
    escenarioBase()

    const { result } = renderHook(() => useOrderSimple(ORDER_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBeNull()
    expect(lecturasDeChecklist()).toHaveLength(0)
  })

  it('B · refresh() tampoco consulta order_checklists', async () => {
    escenarioBase()

    const { result } = renderHook(() => useOrderSimple(ORDER_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    estado.llamadas = []
    await act(async () => { await result.current.refresh() })

    expect(lecturasDeChecklist()).toHaveLength(0)
  })

  it('C · los datos normales de la orden se siguen cargando', async () => {
    escenarioBase()

    const { result } = renderHook(() => useOrderSimple(ORDER_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.order).not.toBeNull()
    expect(result.current.order?.id).toBe(ORDER_ID)
    expect(result.current.order?.customer).toMatchObject({ name: 'Cliente Demo' })
    expect(result.current.order?.parts?.length).toBe(1)
    expect(result.current.order?.orderItems?.length).toBe(1)
    // El saldo derivado se sigue calculando: sin filas en order_payments el
    // hook recompone amount_paid desde los pagos reales, así que queda el total.
    expect(result.current.order?.balance_pending).toBe(15000)
  })

  it('D · refresh() conserva los datos de la orden', async () => {
    escenarioBase()

    const { result } = renderHook(() => useOrderSimple(ORDER_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => { await result.current.refresh() })

    expect(result.current.error).toBeNull()
    expect(result.current.order?.id).toBe(ORDER_ID)
    expect(result.current.order?.customer).toMatchObject({ name: 'Cliente Demo' })
  })

  it('ninguna de las tablas consultadas es order_checklists', async () => {
    escenarioBase()

    const { result } = renderHook(() => useOrderSimple(ORDER_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(estado.llamadas.length).toBeGreaterThan(0)
    expect(estado.llamadas.every(c => c.tabla !== 'order_checklists')).toBe(true)
  })

  it('device_inspections SIGUE consultándose: es otra tabla y no se tocó', async () => {
    escenarioBase()
    estado.tablas.device_inspections = {
      filas: [{ id: 'insp-1', type: 'reception', order_id: ORDER_ID }],
    }

    const { result } = renderHook(() => useOrderSimple(ORDER_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(estado.llamadas.some(c => c.tabla === 'device_inspections')).toBe(true)
    expect(result.current.order?.inspections?.reception).toMatchObject({ id: 'insp-1' })
  })
})
