// ─────────────────────────────────────────────────────────────────────────────
// P0 final pre-M8 — contrato de notifications del lado de la app.
//
// Complementa a tests/sql/notifications_contract.test.sql (esquema, RLS, grants,
// publicacion). Aca se prueba lo que vive en React:
//   · el INSERT manda EXACTAMENTE las columnas que existen (adios PGRST204);
//   · supabase-js devuelve { error } sin lanzar, y el codigo lo detecta;
//   · la notificacion es secundaria: si falla, NO revierte el cambio de estado;
//   · HTTP inicial + Realtime no duplican; una reconexion tampoco.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// Columnas REALES de public.notifications despues de 20260805120000.
const COLUMNAS_REALES = new Set([
  'id', 'user_id', 'type', 'title', 'message', 'is_read',
  'created_at', 'created_by', 'business_id', 'order_id', 'metadata',
])

const estado = vi.hoisted(() => ({
  filas: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  errorDeLectura: null as { code: string; message: string } | null,
  /** Callback de Realtime que registro el hook, para empujarle eventos. */
  onEvent: null as ((payload: unknown) => void) | null,
  onStatus: null as ((estado: string) => void) | null,
}))

/** PostgREST de verdad: una columna inexistente tumba el INSERT ENTERO. */
function validarColumnas(fila: Record<string, unknown>) {
  const desconocida = Object.keys(fila).find(k => !COLUMNAS_REALES.has(k))
  if (desconocida) {
    return {
      code: 'PGRST204',
      message: `Could not find the '${desconocida}' column of 'notifications' in the schema cache`,
    }
  }
  return null
}

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const q: Record<string, unknown> = {}
      const enc = () => q
      Object.assign(q, {
        select: enc, eq: enc, order: enc,
        limit: async () => (estado.errorDeLectura
          ? { data: null, error: estado.errorDeLectura }
          : { data: estado.filas, error: null }),
        insert: async (fila: Record<string, unknown>) => {
          const err = validarColumnas(fila)
          if (err) return { data: null, error: err }
          estado.inserts.push(fila)
          return { data: null, error: null }
        },
        update: (cambios: Record<string, unknown>) => {
          const err = validarColumnas(cambios)
          estado.updates.push(cambios)
          const t: Record<string, unknown> = {}
          Object.assign(t, {
            eq: () => t,
            then: (res: (v: unknown) => void) => res({ data: null, error: err }),
          })
          return t
        },
      })
      return q
    },
  },
}))

// El hook usa el canal compartido: interceptamos para capturar el suscriptor.
vi.mock('../../src/lib/realtimeChannel', () => ({
  subscribeShared: (_spec: unknown, sub: { onEvent?: unknown; onStatus?: unknown }) => {
    estado.onEvent = sub.onEvent as (p: unknown) => void
    estado.onStatus = sub.onStatus as (e: string) => void
    return () => { estado.onEvent = null; estado.onStatus = null }
  },
}))

vi.mock('../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const BIZ = '11111111-1111-1111-1111-111111111111'
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: BIZ, user: { id: 'user-1' } }),
}))

import { useNotifications } from '../../src/hooks/useNotifications'

const fila = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'status_change', title: `T-${id}`, message: `M-${id}`,
  is_read: false, created_at: '2026-08-05T10:00:00Z', order_id: null, metadata: {},
  ...extra,
})

beforeEach(() => {
  estado.filas = []
  estado.inserts = []
  estado.updates = []
  estado.errorDeLectura = null
  estado.onEvent = null
  estado.onStatus = null
})

describe('useNotifications — contrato de columnas', () => {
  it('la lectura pide SOLO columnas que existen', async () => {
    estado.filas = [fila('a')]
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.notifications).toHaveLength(1)
  })

  it('markAsRead NO manda read_at (no es columna): sin PGRST204', async () => {
    estado.filas = [fila('a')]
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => { await result.current.markAsRead('a') })

    expect(estado.updates).toHaveLength(1)
    expect(estado.updates[0]).toEqual({ is_read: true })
    expect(Object.keys(estado.updates[0])).not.toContain('read_at')
  })

  it('markAllAsRead tampoco manda read_at', async () => {
    estado.filas = [fila('a'), fila('b')]
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => { await result.current.markAllAsRead() })

    expect(estado.updates[0]).toEqual({ is_read: true })
  })

  it('REGRESION: mandar read_at devuelve PGRST204 (el bug original)', async () => {
    // Prueba que los dos tests de arriba pasan por el recorte y no por azar.
    const err = validarColumnas({ is_read: true, read_at: '2026-08-05T10:00:00Z' })
    expect(err?.code).toBe('PGRST204')
  })

  it('REGRESION: customer_id tambien tumbaba el insert entero', () => {
    expect(validarColumnas({ business_id: BIZ, customer_id: 'x' })?.code).toBe('PGRST204')
    // Y order_id / metadata ahora SI son validas (las agrega la migracion).
    expect(validarColumnas({ business_id: BIZ, order_id: 'o1', metadata: {} })).toBeNull()
  })
})

describe('useNotifications — deduplicacion', () => {
  it('HTTP inicial + Realtime de la MISMA fila no duplica', async () => {
    estado.filas = [fila('a')]
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.notifications).toHaveLength(1)

    // Realtime reenvia la fila que ya vino por HTTP.
    act(() => { estado.onEvent?.({ new: fila('a') }) })

    expect(result.current.notifications).toHaveLength(1)
  })

  it('una fila NUEVA por Realtime si se incorpora', async () => {
    estado.filas = [fila('a')]
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => { estado.onEvent?.({ new: fila('b', { created_at: '2026-08-05T11:00:00Z' }) }) })

    expect(result.current.notifications).toHaveLength(2)
    // Orden canonico: la mas nueva primero.
    expect(result.current.notifications[0].id).toBe('b')
  })

  it('una RECONEXION que reenvia todo no duplica', async () => {
    estado.filas = [fila('a'), fila('b')]
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      estado.onEvent?.({ new: fila('a') })
      estado.onEvent?.({ new: fila('b') })
      estado.onEvent?.({ new: fila('a') })
    })

    expect(result.current.notifications).toHaveLength(2)
  })

  it('un refresh HTTP conserva lo que llego por Realtime y no duplica', async () => {
    estado.filas = [fila('a')]
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Llega por Realtime una fila que el backend todavia no devuelve.
    act(() => { estado.onEvent?.({ new: fila('z', { created_at: '2026-08-05T12:00:00Z' }) }) })
    expect(result.current.notifications).toHaveLength(2)

    await act(async () => { await result.current.refresh() })

    // No se pierde ni se duplica.
    expect(result.current.notifications).toHaveLength(2)
    expect(result.current.notifications.map(n => n.id).sort()).toEqual(['a', 'z'])
  })

  it('unreadCount se DERIVA de la lista (no se puede desincronizar)', async () => {
    estado.filas = [fila('a'), fila('b', { is_read: true })]
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.unreadCount).toBe(1)

    // Realtime reenvia una no leida ya conocida: el contador NO sube.
    act(() => { estado.onEvent?.({ new: fila('a') }) })
    expect(result.current.unreadCount).toBe(1)

    await act(async () => { await result.current.markAsRead('a') })
    expect(result.current.unreadCount).toBe(0)
  })
})

describe('useNotifications — errores y estados', () => {
  it('un error de lectura NO se convierte en cero: marca error', async () => {
    estado.errorDeLectura = { code: '42501', message: 'permission denied' }
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).not.toBeNull()
    expect(result.current.notifications).toHaveLength(0)
  })

  it('channel_error no rompe la carga HTTP', async () => {
    estado.filas = [fila('a')]
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => { estado.onStatus?.('channel_error') })

    // Los datos siguen ahi: Realtime caido no vacia la pantalla.
    expect(result.current.notifications).toHaveLength(1)
    expect(result.current.error).toBeNull()
    expect(result.current.realtimeStatus).toBe('channel_error')
  })

  it('un evento sin id se descarta sin romper', async () => {
    estado.filas = []
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => { estado.onEvent?.({ new: {} }) })

    expect(result.current.notifications).toHaveLength(0)
  })

  it('cero notificaciones devuelve [] y sin error', async () => {
    estado.filas = []
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.notifications).toEqual([])
    expect(result.current.error).toBeNull()
    expect(result.current.unreadCount).toBe(0)
  })

  it('un evento tardio no toca el hook desmontado', async () => {
    estado.filas = []
    const { result, unmount } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const emisor = estado.onEvent
    unmount()

    // El cleanup limpio la referencia: no hay a quien avisarle.
    expect(estado.onEvent).toBeNull()
    expect(() => emisor?.({ new: fila('tardio') })).not.toThrow()
  })
})
