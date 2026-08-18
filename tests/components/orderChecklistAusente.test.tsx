// ─────────────────────────────────────────────────────────────────────────────
// 406 PGRST116 sobre `order_checklists` (incidente 2026-08-18).
//
// Al abrir una orden, `useOrderSimple` leía el checklist con `.single()`. Eso
// manda `Accept: application/vnd.pgrst.object+json`, y con 0 filas PostgREST
// responde 406:
//
//   {"code":"PGRST116","details":"The result contains 0 rows",
//    "message":"Cannot coerce the result to a single JSON object"}
//
// Pero una orden SIN checklist es el estado normal: no hay trigger ni
// constraint que lo cree, y `ChecklistCard` lo inserta recién cuando alguien lo
// completa. En producción había 108 órdenes y 0 checklists.
//
// Detalle que hizo el bug invisible: el `try/catch` que envolvía la consulta
// nunca atrapó nada — supabase-js NO lanza ante errores de PostgREST, devuelve
// `{ error }`. El 406 sólo se veía en la consola del navegador.
//
// Estos tests fijan el contrato de esa lectura. No tocan las demás.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

interface TablaFake {
  filas?: Array<Record<string, unknown>>
  /** Error de PostgREST devuelto en lugar de datos. */
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

    // `.single()` reproduce el 406 real: != 1 fila ⇒ PGRST116.
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

    // `.maybeSingle()`: 0 filas ⇒ 200 con data null. Varias filas SIGUE siendo
    // una inconsistencia y no se tapa.
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

    // Consultas de lista (order_parts, order_items, …): resuelven como thenable.
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

/** La orden siempre existe; lo que varía es el checklist. */
function escenarioBase() {
  estado.tablas = {
    orders: { filas: [{ id: ORDER_ID, status: 'received', customer_id: null, device_id: null, technician_id: null }] },
  }
}

beforeEach(() => {
  estado.tablas = {}
  estado.llamadas = []
})

describe('order_checklists — una orden sin checklist es un estado válido', () => {
  it('B · orden SIN checklist: sin error, checklist vacío y SIN 406', async () => {
    escenarioBase()
    estado.tablas.order_checklists = { filas: [] }

    const { result } = renderHook(() => useOrderSimple(ORDER_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBeNull()
    expect(result.current.order).not.toBeNull()
    expect(result.current.order?.checklist).toBeUndefined()

    // La firma corregida no puede haber mandado el header que produce el 406.
    const lecturas = estado.llamadas.filter(c => c.tabla === 'order_checklists')
    expect(lecturas.length).toBeGreaterThan(0)
    expect(lecturas.every(c => c.metodo === 'maybeSingle')).toBe(true)
    expect(lecturas.some(c => c.metodo === 'single')).toBe(false)
  })

  it('A · orden CON checklist: se lee igual que antes', async () => {
    escenarioBase()
    estado.tablas.order_checklists = {
      filas: [{ id: 'chk-1', order_id: ORDER_ID, enciende: true, pantalla_rota: false }],
    }

    const { result } = renderHook(() => useOrderSimple(ORDER_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBeNull()
    expect(result.current.order?.checklist).toMatchObject({ id: 'chk-1', enciende: true })
  })

  it('C · un error REAL del backend no se silencia como "sin checklist"', async () => {
    escenarioBase()
    estado.tablas.order_checklists = {
      error: { code: '42501', message: 'permission denied for table order_checklists', status: 403 },
    }

    const advertencia = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() => useOrderSimple(ORDER_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // La orden sigue cargando (el checklist es accesorio), pero el fallo real
    // no se confunde con ausencia: no queda checklist y quedó registrado.
    expect(result.current.order?.checklist).toBeUndefined()
    expect(advertencia).toHaveBeenCalled()
    advertencia.mockRestore()
  })

  it('varias filas para una misma orden NO se tapan: es una inconsistencia', async () => {
    escenarioBase()
    estado.tablas.order_checklists = {
      filas: [{ id: 'chk-1', order_id: ORDER_ID }, { id: 'chk-2', order_id: ORDER_ID }],
    }

    const advertencia = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() => useOrderSimple(ORDER_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // `maybeSingle()` sigue devolviendo error con >1 fila: no se elige una al azar.
    expect(result.current.order?.checklist).toBeUndefined()
    advertencia.mockRestore()
  })

  it('leer el checklist NO crea la fila', async () => {
    escenarioBase()
    estado.tablas.order_checklists = { filas: [] }

    const { result } = renderHook(() => useOrderSimple(ORDER_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // El query falso no expone insert/upsert: usarlos habría explotado.
    expect(estado.llamadas.filter(c => c.tabla === 'order_checklists')
      .every(c => c.metodo === 'maybeSingle')).toBe(true)
  })

  it('una sola lectura del checklist por montaje: sin loop de requests', async () => {
    escenarioBase()
    estado.tablas.order_checklists = { filas: [] }

    const { result, rerender } = renderHook(() => useOrderSimple(ORDER_ID))
    await waitFor(() => expect(result.current.loading).toBe(false))

    rerender()
    rerender()

    expect(estado.llamadas.filter(c => c.tabla === 'order_checklists')).toHaveLength(1)
  })

  it('REGRESIÓN: con `.single()` el mismo escenario devuelve 406 PGRST116', async () => {
    // Control negativo: demuestra que el test B pasa por el cambio de firma y
    // no por casualidad del doble.
    estado.tablas.order_checklists = { filas: [] }
    const q = construirQuery('order_checklists')

    const conSingle = await q.single()
    expect(conSingle.error?.code).toBe('PGRST116')
    expect(conSingle.error?.status).toBe(406)
    expect(conSingle.error?.details).toBe('The result contains 0 rows')

    const conMaybe = await q.maybeSingle()
    expect(conMaybe.error).toBeNull()
    expect(conMaybe.data).toBeNull()
  })
})
