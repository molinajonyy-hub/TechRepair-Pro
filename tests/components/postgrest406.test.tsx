// ─────────────────────────────────────────────────────────────────────────────
// P0 final pre-M8 — el 406 de PostgREST sobre `business_settings`.
//
// El 406 que se atribuia a /rest/v1/notifications era en realidad de
// business_settings (fila contigua en el Network tab). Causa exacta:
//
//   `.single()`      manda Accept: application/vnd.pgrst.object+json
//                    -> con != 1 fila PostgREST responde 406 PGRST116.
//   `.maybeSingle()` NO manda ese header en postgrest-js 2.x
//                    -> con 0 filas responde 200 y `data: null`.
//
// Y `business_settings` LEGITIMAMENTE puede no tener fila: no se puebla al crear
// el negocio y no hay trigger que la cree.
//
// Estos tests fijan el CONTRATO de las dos firmas corregidas, no un
// reemplazo global de los 105 `.single()` del repo.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// ── Cliente Supabase falso que distingue single() de maybeSingle() ───────────
interface Escenario {
  filas: Array<Record<string, unknown>>
  /** Fuerza un error de PostgREST en lugar de datos. */
  error?: { code: string; message: string; status: number }
}

const estado = vi.hoisted(() => ({
  escenario: { filas: [] } as Escenario,
  llamadas: [] as Array<{ tabla: string; metodo: 'single' | 'maybeSingle' | 'list'; accept: string | null }>,
}))

function construirQuery(tabla: string) {
  const q = {
    select: () => q,
    eq: () => q,
    order: () => q,
    limit: () => q,

    // `.single()` — Accept: application/vnd.pgrst.object+json
    single: async () => {
      estado.llamadas.push({ tabla, metodo: 'single', accept: 'application/vnd.pgrst.object+json' })
      if (estado.escenario.error) return { data: null, error: estado.escenario.error }
      const n = estado.escenario.filas.length
      if (n !== 1) {
        // Esto es EXACTAMENTE lo que devolvia PostgREST: 406 PGRST116.
        return {
          data: null,
          error: {
            code: 'PGRST116',
            message: n === 0
              ? 'JSON object requested, multiple (or no) rows returned'
              : 'JSON object requested, multiple (or no) rows returned',
            status: 406,
          },
        }
      }
      return { data: estado.escenario.filas[0], error: null }
    },

    // `.maybeSingle()` — sin ese header; 0 filas es 200 + data null
    maybeSingle: async () => {
      estado.llamadas.push({ tabla, metodo: 'maybeSingle', accept: null })
      if (estado.escenario.error) return { data: null, error: estado.escenario.error }
      const n = estado.escenario.filas.length
      if (n > 1) {
        // Varias filas SIGUE siendo una inconsistencia, tambien con maybeSingle.
        return {
          data: null,
          error: { code: 'PGRST116', message: 'multiple rows returned', status: 406 },
        }
      }
      return { data: n === 1 ? estado.escenario.filas[0] : null, error: null }
    },
  }
  return q
}

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => construirQuery(tabla),
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => Promise.resolve('ok'),
  },
}))

vi.mock('../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { useOrderPrintSettings } from '../../src/hooks/useOrderPrintSettings'

const BIZ = '11111111-1111-1111-1111-111111111111'

beforeEach(() => {
  estado.escenario = { filas: [] }
  estado.llamadas = []
})

describe('business_settings — ausencia de fila es un estado legitimo', () => {
  // ── 1, 2 ───────────────────────────────────────────────────────────────────
  it('1+2. cero filas -> sin error y SIN 406 (usa maybeSingle)', async () => {
    estado.escenario = { filas: [] }

    const { result } = renderHook(() => useOrderPrintSettings(BIZ))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBeNull()

    // La firma corregida no puede haber mandado el header que produce el 406.
    const lecturas = estado.llamadas.filter(c => c.tabla === 'business_settings')
    expect(lecturas.length).toBeGreaterThan(0)
    expect(lecturas.every(c => c.metodo === 'maybeSingle')).toBe(true)
    expect(lecturas.every(c => c.accept === null)).toBe(true)
  })

  it('cero filas -> quedan los defaults explicitos, no undefined ni vacio', async () => {
    estado.escenario = { filas: [] }

    const { result } = renderHook(() => useOrderPrintSettings(BIZ))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // El hook tiene DEFAULT_PRINT_SETTINGS justamente para este caso.
    expect(result.current.settings).toBeDefined()
    expect(result.current.settings.orden_mostrar_logo).toBe(true)
    expect(result.current.settings.orden_condiciones).not.toBe('')
  })

  // ── 3 ──────────────────────────────────────────────────────────────────────
  it('3. VARIAS filas sigue siendo una inconsistencia (no se tapa)', async () => {
    estado.escenario = { filas: [{ nombre_comercial: 'A' }, { nombre_comercial: 'B' }] }

    const { result } = renderHook(() => useOrderPrintSettings(BIZ))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).not.toBeNull()
  })

  // ── 4 ──────────────────────────────────────────────────────────────────────
  it('4. 42501 (permiso denegado) NO se interpreta como ausencia', async () => {
    estado.escenario = {
      filas: [],
      error: { code: '42501', message: 'permission denied for table business_settings', status: 403 },
    }

    const { result } = renderHook(() => useOrderPrintSettings(BIZ))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Un permiso denegado tiene que verse como error, no como "no hay config".
    expect(result.current.error).not.toBeNull()
  })

  // ── 5 ──────────────────────────────────────────────────────────────────────
  it('5. un 5xx no se convierte en defaults silenciosos', async () => {
    estado.escenario = {
      filas: [],
      error: { code: 'XX000', message: 'internal server error', status: 500 },
    }

    const { result } = renderHook(() => useOrderPrintSettings(BIZ))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).not.toBeNull()
  })

  // ── 6 ──────────────────────────────────────────────────────────────────────
  it('6. no se crea una fila accidentalmente al leer', async () => {
    estado.escenario = { filas: [] }

    const { result } = renderHook(() => useOrderPrintSettings(BIZ))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Ningun insert/upsert: el query falso no expone esos metodos, asi que
    // usarlos habria explotado. Se afirma ademas sobre la traza.
    expect(estado.llamadas.every(c => c.metodo !== 'list')).toBe(true)
    expect(estado.llamadas).toHaveLength(1)
  })

  // ── 7 ──────────────────────────────────────────────────────────────────────
  it('7. una sola lectura por businessId: sin loop de requests', async () => {
    estado.escenario = { filas: [{ nombre_comercial: 'Taller' }] }

    const { result, rerender } = renderHook(() => useOrderPrintSettings(BIZ))
    await waitFor(() => expect(result.current.loading).toBe(false))

    rerender()
    rerender()
    rerender()

    expect(estado.llamadas.filter(c => c.tabla === 'business_settings')).toHaveLength(1)
  })

  // ── 8 ──────────────────────────────────────────────────────────────────────
  it('8. con fila presente el contrato no cambia: se leen los datos', async () => {
    estado.escenario = { filas: [{ nombre_comercial: 'Taller Central', orden_mostrar_logo: false }] }

    const { result } = renderHook(() => useOrderPrintSettings(BIZ))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBeNull()
    expect(result.current.settings.nombre_comercial).toBe('Taller Central')
    expect(result.current.settings.orden_mostrar_logo).toBe(false)
  })

  // ── Regresion ──────────────────────────────────────────────────────────────
  it('REGRESION: con `.single()` el mismo escenario devuelve 406 PGRST116', async () => {
    // Demuestra que el test 1 pasa por el cambio de firma y no por casualidad.
    estado.escenario = { filas: [] }
    const q = construirQuery('business_settings')

    const conSingle = await q.single()
    expect(conSingle.error?.code).toBe('PGRST116')
    expect(conSingle.error?.status).toBe(406)

    const conMaybe = await q.maybeSingle()
    expect(conMaybe.error).toBeNull()
    expect(conMaybe.data).toBeNull()
  })
})
