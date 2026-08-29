// ─────────────────────────────────────────────────────────────────────────────
// Charts L1 — clasificación de cancelaciones en el límite de Supabase.
//
// PostgREST devuelve el aborto de fetch dentro de `{ error }`. Estos tests
// fijan que el signal del caller —no el texto del error— decide si se trata de
// control de flujo esperado o de una falla real que debe diagnosticarse.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from 'vitest'

const estado = vi.hoisted(() => ({
  data: null as unknown,
  error: null as { message: string } | null,
  rpc: vi.fn(),
  abortSignal: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      estado.rpc(name, args)
      return {
        abortSignal: (signal: AbortSignal) => {
          estado.abortSignal(signal)
          return Promise.resolve({ data: estado.data, error: estado.error })
        },
        then: (
          resolve: (value: { data: unknown; error: { message: string } | null }) => unknown,
          reject: (reason: unknown) => unknown,
        ) => Promise.resolve({ data: estado.data, error: estado.error }).then(resolve, reject),
      }
    },
  },
}))

vi.mock('../../src/lib/logger', () => ({
  logger: { error: estado.loggerError },
}))

import { financeChartsService } from '../../src/services/financeChartsService'

const PARAMS = {
  businessId: 'biz-1',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-10',
} as const

beforeEach(() => {
  estado.data = null
  estado.error = null
  estado.rpc.mockReset()
  estado.abortSignal.mockReset()
  estado.loggerError.mockReset()
})

describe('financeChartsService.fetch — cancelación esperada', () => {
  it('A. un error con el signal abortado es silencioso y conserva semántica AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    estado.error = { message: 'AbortError: The user aborted a request.' }

    const failure = await financeChartsService
      .fetch({ ...PARAMS, signal: controller.signal })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DOMException)
    expect(failure).toMatchObject({ name: 'AbortError' })
    expect(estado.abortSignal).toHaveBeenCalledWith(controller.signal)
    expect(estado.loggerError).not.toHaveBeenCalled()
  })

  it('B. un error real con el signal vigente se registra y se propaga', async () => {
    const controller = new AbortController()
    const supabaseError = { message: 'permission denied' }
    estado.error = supabaseError

    await expect(financeChartsService.fetch({ ...PARAMS, signal: controller.signal }))
      .rejects.toThrow('permission denied')

    expect(controller.signal.aborted).toBe(false)
    expect(estado.loggerError).toHaveBeenCalledOnce()
    expect(estado.loggerError).toHaveBeenCalledWith(
      'FINANCE',
      'get_finance_charts_l1 falló',
      supabaseError,
    )
  })

  it('C. una respuesta exitosa conserva el payload y no registra errores', async () => {
    const payload = { ok: true, calculation_version: 'charts_l1_v1' }
    estado.data = payload

    await expect(financeChartsService.fetch(PARAMS)).resolves.toBe(payload)

    expect(estado.rpc).toHaveBeenCalledOnce()
    expect(estado.abortSignal).not.toHaveBeenCalled()
    expect(estado.loggerError).not.toHaveBeenCalled()
  })
})
