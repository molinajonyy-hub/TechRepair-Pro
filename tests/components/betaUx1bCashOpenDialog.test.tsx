// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1B — Diálogo «Abrir caja» y su adaptador de la RPC, en aislamiento.
//
// `betaUx1bFirstCheckout.test.tsx` mide el flujo dentro del POS. Acá se miden
// los contratos que el POS da por sentados:
//
//   · el adaptador traduce la respuesta de `open_cash_session_atomic` a tres
//     resultados, sin inventar éxitos y sin filtrar internals;
//   · el diálogo no existe sin la capacidad `finance`, ni siquiera si alguien
//     lo monta con `isOpen`;
//   · la idempotency key es estable dentro del mismo intento y cambia cuando
//     cambian los montos;
//   · validaciones y bordes (montos negativos, replay sobre una caja cerrada).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const BIZ_ID  = '22222222-2222-4222-8222-222222222222'
const CAJA_ID = '33333333-3333-4333-8333-333333333333'

const estado = vi.hoisted(() => ({
  perfil: null as Record<string, unknown> | null,
  cajaAbierta: false,
  openRpc: null as null | ((args: Record<string, unknown>) => unknown),
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  logs: [] as unknown[][],
}))

vi.mock('../../src/lib/supabase', () => {
  const chain = (tabla: string): unknown => {
    const c: unknown = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'maybeSingle' || prop === 'single') {
          return async () => tabla === 'cajas' && estado.cajaAbierta
            ? { data: { id: '33333333-3333-4333-8333-333333333333', business_id: '22222222-2222-4222-8222-222222222222', opened_at: '2026-10-07T12:00:00Z', opened_by: null, status: 'abierta' }, error: null }
            : { data: null, error: null }
        }
        if (prop === 'then') return (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: [], error: null })
        return () => c
      },
    })
    return c
  }
  return {
    supabase: {
      auth: {
        getSession: async () => ({
          data: { session: { user: { id: '11111111-1111-4111-8111-111111111111', email: 'u@invalid.test', email_confirmed_at: '2026-08-24T00:00:00Z' } } },
          error: null,
        }),
        getUser: async () => ({ data: { user: { id: '11111111-1111-4111-8111-111111111111' } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signOut: async () => ({ error: null }),
      },
      rpc: async (fn: string, args: Record<string, unknown> = {}) => {
        estado.rpcs.push({ fn, args })
        if (fn === 'get_my_profile') return { data: estado.perfil, error: null }
        if (fn === 'open_cash_session_atomic') {
          if (estado.openRpc) return estado.openRpc(args)
          estado.cajaAbierta = true
          return { data: { ok: true, replay: false, caja_id: '33333333-3333-4333-8333-333333333333' }, error: null }
        }
        return { data: null, error: null }
      },
      from: (tabla: string) => chain(tabla),
    },
  }
})

vi.mock('../../src/lib/logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/logger')>()
  return { ...real, logger: { ...real.logger, error: (...a: unknown[]) => { estado.logs.push(a) } } }
})

import { AuthProvider, useAuth } from '../../src/contexts/AuthContext'
import { CajaProvider } from '../../src/contexts/CajaContext'
import { InlineCashOpenDialog } from '../../src/components/caja/InlineCashOpenDialog'
import {
  cashSessionService, isCajaAlreadyOpenResponse, CAJA_ALREADY_OPEN_ERROR, CAJA_OPEN_METHODS,
} from '../../src/services/cashSessionService'

const perfil = (role: string, permissions: unknown = null) => ({
  id: USER_ID, business_id: BIZ_ID, role, is_active: true,
  full_name: 'U', email: 'u@invalid.test', phone: null, permissions,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
})

function Sonda() {
  const { profile } = useAuth()
  return <span data-testid="sonda-rol">{profile?.role ?? 'sin-perfil'}</span>
}

const onClose = vi.fn()
const onOpened = vi.fn()

async function montar(role: string, opts: { permissions?: unknown; exchangeRate?: number; isOpen?: boolean } = {}) {
  estado.perfil = perfil(role, opts.permissions ?? null)
  render(
    <AuthProvider>
      <CajaProvider>
        <Sonda />
        <InlineCashOpenDialog
          isOpen={opts.isOpen ?? true} exchangeRate={opts.exchangeRate ?? 1450}
          onClose={onClose} onOpened={onOpened}
        />
      </CajaProvider>
    </AuthProvider>,
  )
  await waitFor(() => expect(screen.getByTestId('sonda-rol').textContent).toBe(role))
}

const aperturas = () => estado.rpcs.filter(r => r.fn === 'open_cash_session_atomic')
const tipear = (m: string, valor: string) => fireEvent.change(screen.getByTestId(`pos-open-caja-${m}`), { target: { value: valor } })
const confirmar = () => fireEvent.click(screen.getByTestId('pos-open-caja-confirm'))
const INPUT = { businessId: BIZ_ID, userId: USER_ID, balances: { efectivo: 100, transferencia: 0, tarjeta: 0, usd: 0 }, usdRate: 1450, idempotencyKey: 'k-1' }

beforeEach(() => {
  estado.perfil = null
  estado.cajaAbierta = false
  estado.openRpc = null
  estado.rpcs = []
  estado.logs = []
  onClose.mockClear()
  onOpened.mockClear()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('cashSessionService.open — traducción de la respuesta', () => {
  it('conoce los cuatro medios del arqueo, en el orden de la pantalla', () => {
    expect([...CAJA_OPEN_METHODS]).toEqual(['efectivo', 'transferencia', 'tarjeta', 'usd'])
  })

  it('apertura nueva → opened', async () => {
    expect(await cashSessionService.open(INPUT)).toEqual({ status: 'opened', cajaId: CAJA_ID, replay: false })
    expect(aperturas()[0].args).toEqual({
      p_business_id: BIZ_ID, p_user_id: USER_ID,
      p_efectivo: 100, p_transferencia: 0, p_tarjeta: 0, p_usd: 0,
      p_usd_rate: 1450, p_idempotency_key: 'k-1',
    })
  })

  it('reintento reconocido por el servidor → opened con replay', async () => {
    estado.openRpc = () => ({ data: { ok: true, replay: true, caja_id: CAJA_ID }, error: null })
    expect(await cashSessionService.open(INPUT)).toEqual({ status: 'opened', cajaId: CAJA_ID, replay: true })
  })

  it('«Ya hay una caja abierta» → already_open, por el chequeo previo o por el índice único', async () => {
    estado.openRpc = () => ({ data: { ok: false, error: CAJA_ALREADY_OPEN_ERROR }, error: null })
    expect(await cashSessionService.open(INPUT)).toEqual({ status: 'already_open' })
    expect(isCajaAlreadyOpenResponse({ error: 'Ya hay una caja abierta' })).toBe(true)
    expect(isCajaAlreadyOpenResponse({ error: 'ya hay una caja abierta.' })).toBe(true)
  })

  it('ningún otro error se confunde con «ya abierta»', async () => {
    for (const error of ['IDEMPOTENCY_CONFLICT', 'Sin acceso a este negocio', 'No autenticado', 'Caja inexistente', '']) {
      expect(isCajaAlreadyOpenResponse({ error }), error).toBe(false)
    }
    expect(isCajaAlreadyOpenResponse(null)).toBe(false)
    expect(isCajaAlreadyOpenResponse({})).toBe(false)
  })

  it('FORBIDDEN llega LEVANTADO (42501), no como `{ ok:false }`: se dice como permiso', async () => {
    estado.openRpc = () => ({ data: null, error: { code: '42501', message: 'FORBIDDEN' } })
    expect(await cashSessionService.open(INPUT)).toEqual({
      status: 'error', code: 'FORBIDDEN',
      message: 'Tu usuario no tiene permiso para esta operación financiera.',
    })
  })

  it('IDEMPOTENCY_CONFLICT conserva su código para que el diálogo renueve la key', async () => {
    estado.openRpc = () => ({ data: { ok: false, error: 'IDEMPOTENCY_CONFLICT', message: 'Esta solicitud ya fue utilizada con datos diferentes.' }, error: null })
    const r = await cashSessionService.open(INPUT)
    expect(r).toMatchObject({ status: 'error', code: 'IDEMPOTENCY_CONFLICT' })
    expect(r.status === 'error' && r.message).toMatch(/ya se había enviado con otros datos/)
  })

  it('una frase del servidor se muestra como mensaje, no entre paréntesis como si fuera un código', async () => {
    estado.openRpc = () => ({ data: { ok: false, error: 'Sin acceso a este negocio' }, error: null })
    expect(await cashSessionService.open(INPUT)).toEqual({ status: 'error', code: null, message: 'Sin acceso a este negocio' })
  })

  it('una caída de transporte no llega cruda a la pantalla y queda en el log sin datos del pedido', async () => {
    estado.openRpc = () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } })
    const r = await cashSessionService.open(INPUT)
    expect(r.status).toBe('error')
    expect(r.status === 'error' && r.message).not.toMatch(/TypeError|fetch/)
    expect(JSON.stringify(estado.logs)).not.toMatch(new RegExp(`${BIZ_ID}|${USER_ID}|k-1`))
  })

  it('una respuesta vacía NO es un éxito', async () => {
    estado.openRpc = () => ({ data: null, error: null })
    expect((await cashSessionService.open(INPUT)).status).toBe('error')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('InlineCashOpenDialog — capacidad', () => {
  it('sin `finance` no se renderiza aunque lo monten abierto, y no llama a nada', async () => {
    await montar('sales')
    expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull()
    expect(screen.queryByTestId('pos-open-caja-confirm')).toBeNull()
    expect(aperturas()).toEqual([])
  })

  it('override finance:false sobre un rol que la tendría: tampoco', async () => {
    await montar('cashier', { permissions: { finance: false } })
    expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull()
  })

  it('override finance:true sobre un rol que no la tendría: sí', async () => {
    await montar('tech', { permissions: { finance: true } })
    expect(await screen.findByTestId('pos-open-caja-dialog')).toBeInTheDocument()
  })

  it('cerrado no renderiza nada', async () => {
    await montar('owner', { isOpen: false })
    expect(screen.queryByTestId('pos-open-caja-overlay')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('InlineCashOpenDialog — formulario', () => {
  it('es un diálogo modal con nombre, descripción y los cuatro campos etiquetados', async () => {
    await montar('owner')
    const dialogo = await screen.findByRole('dialog', { name: 'Abrir caja' })
    expect(dialogo).toHaveAttribute('aria-modal', 'true')
    expect(dialogo).toHaveAccessibleDescription(/Tu venta queda como está/)
    for (const [m, label] of [['efectivo', 'Efectivo'], ['transferencia', 'Transferencia'], ['tarjeta', 'Tarjeta'], ['usd', 'USD']]) {
      const input = screen.getByLabelText(label) as HTMLInputElement
      expect(input).toBe(screen.getByTestId(`pos-open-caja-${m}`))
      expect(input.type).toBe('number')
      expect(input.inputMode).toBe('decimal')
      expect(input.min).toBe('0')
    }
    expect(screen.getByTestId('pos-open-caja-usd')).toHaveAccessibleDescription('Cotización: $1.450')
  })

  it('sin cotización no inventa un «$1»: lo dice', async () => {
    await montar('owner', { exchangeRate: 1 })
    expect(await screen.findByTestId('pos-open-caja-usd-rate')).toHaveTextContent('Cotización no disponible')
  })

  it('todo vacío abre la caja en cero (día 1: no hay saldo inicial)', async () => {
    await montar('owner')
    await screen.findByTestId('pos-open-caja-dialog')
    confirmar()
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith({ alreadyOpen: false }))
    expect(aperturas()[0].args).toMatchObject({ p_efectivo: 0, p_transferencia: 0, p_tarjeta: 0, p_usd: 0 })
  })

  it('Enter en un monto confirma (el formulario es un <form>)', async () => {
    await montar('owner')
    await screen.findByTestId('pos-open-caja-dialog')
    tipear('efectivo', '500')
    fireEvent.submit(screen.getByTestId('pos-open-caja-efectivo').closest('form') as HTMLFormElement)
    await waitFor(() => expect(aperturas()).toHaveLength(1))
    expect(aperturas()[0].args.p_efectivo).toBe(500)
  })

  it('un saldo negativo se frena en pantalla, sin llamar al servidor', async () => {
    await montar('owner')
    await screen.findByTestId('pos-open-caja-dialog')
    tipear('tarjeta', '-50')
    confirmar()
    expect(await screen.findByTestId('pos-open-caja-error')).toHaveTextContent(/no pueden ser negativos/)
    expect(aperturas()).toEqual([])
    expect(onOpened).not.toHaveBeenCalled()
  })

  it('Escape y «Cancelar» cierran; no abren ni llaman', async () => {
    await montar('owner')
    await screen.findByTestId('pos-open-caja-dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('pos-open-caja-cancel'))
    fireEvent.click(screen.getByTestId('pos-open-caja-close'))
    expect(onClose).toHaveBeenCalledTimes(3)
    expect(aperturas()).toEqual([])
  })

  it('Tab no se escapa del diálogo', async () => {
    await montar('owner')
    const dialogo = await screen.findByTestId('pos-open-caja-dialog')
    const ultimo = screen.getByTestId('pos-open-caja-confirm')
    const primero = screen.getByTestId('pos-open-caja-close')
    ultimo.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(primero)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(ultimo)
    expect(dialogo.contains(document.activeElement)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('InlineCashOpenDialog — idempotencia', () => {
  it('reintento con los MISMOS montos conserva la key; cambiar un monto la renueva', async () => {
    estado.openRpc = () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } })
    await montar('owner')
    await screen.findByTestId('pos-open-caja-dialog')

    tipear('efectivo', '1000')
    confirmar()
    await screen.findByTestId('pos-open-caja-error')
    confirmar()
    await waitFor(() => expect(aperturas()).toHaveLength(2))
    const [k1, k2] = aperturas().map(a => a.args.p_idempotency_key)
    expect(k1).toBeTruthy()
    expect(k2).toBe(k1)

    tipear('efectivo', '1200')
    confirmar()
    await waitFor(() => expect(aperturas()).toHaveLength(3))
    expect(aperturas()[2].args.p_idempotency_key).not.toBe(k1)
  })

  it('tras un IDEMPOTENCY_CONFLICT la key se descarta: el próximo intento es uno nuevo', async () => {
    estado.openRpc = () => ({ data: { ok: false, error: 'IDEMPOTENCY_CONFLICT' }, error: null })
    await montar('owner')
    await screen.findByTestId('pos-open-caja-dialog')
    confirmar()
    await screen.findByTestId('pos-open-caja-error')
    confirmar()
    await waitFor(() => expect(aperturas()).toHaveLength(2))
    expect(aperturas()[1].args.p_idempotency_key).not.toBe(aperturas()[0].args.p_idempotency_key)
  })

  it('un replay sobre una caja que ya no está abierta NO se presenta como «caja abierta»', async () => {
    estado.openRpc = () => ({ data: { ok: true, replay: true, caja_id: CAJA_ID }, error: null })
    await montar('owner')
    await screen.findByTestId('pos-open-caja-dialog')
    confirmar()
    expect(await screen.findByTestId('pos-open-caja-error')).toHaveTextContent(/volvió a cerrarse/)
    expect(onOpened).not.toHaveBeenCalled()

    // El reintento usa una key nueva y abre de verdad.
    const anterior = aperturas()[0].args.p_idempotency_key
    estado.openRpc = null
    confirmar()
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith({ alreadyOpen: false }))
    expect(aperturas()[1].args.p_idempotency_key).not.toBe(anterior)
  })

  it('apertura confirmada aunque la relectura falle: manda lo que dijo el servidor', async () => {
    // El servidor abrió (no es replay) y la lectura posterior no la ve: se
    // confía en la apertura. El evento hace que el contexto vuelva a leer.
    estado.openRpc = () => ({ data: { ok: true, replay: false, caja_id: CAJA_ID }, error: null })
    let eventos = 0
    const h = () => { eventos += 1 }
    window.addEventListener('cash-session-updated', h)
    await montar('owner')
    await screen.findByTestId('pos-open-caja-dialog')
    confirmar()
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith({ alreadyOpen: false }))
    expect(eventos).toBe(1)
    window.removeEventListener('cash-session-updated', h)
  })
})
