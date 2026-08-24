// ─────────────────────────────────────────────────────────────────────────────
// P0-P6 HOTFIX — Superficie de caja gateada por capacidad.
//
// Después del deploy de P0-P6 quedaba un borde: la ruta `/caja` ya rebotaba,
// pero el Dashboard seguía mostrando el estado «Caja abierta/cerrada», el CTA
// «Gestionar Caja» y la pestaña «Movimientos Caja». O sea, superficies que
// llevaban a algo que después fallaba.
//
// Y peor: `CajaProvider` envuelve TODA la app y consultaba `cajas` en el
// montaje, en cada `focus` de ventana y en cada `cash-session-updated` — para
// cualquier usuario, tuviera o no la capacidad.
//
// Se miden las CUATRO regresiones del contrato:
//   tech default        -> 0 UI de caja + 0 fetches de caja
//   owner               -> caja visible y funcional
//   cashier autorizado  -> caja visible
//   override explícito  -> respetado
//
// Y una quinta que apareció al implementar: un `sales` NO ve la UI de caja pero
// SÍ tiene que conocer la caja abierta, porque el POS ata la venta a la sesión.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const BIZ_ID = '22222222-2222-4222-8222-222222222222'
const CAJA_ID = '33333333-3333-4333-8333-333333333333'

const estado = vi.hoisted(() => ({
  perfil: null as Record<string, unknown> | null,
  /** Toda tabla consultada. Es como se mide «0 fetches de caja». */
  tablas: [] as string[],
}))

vi.mock('../../src/lib/supabase', () => {
  const chain = (tabla: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {
      select: () => { estado.tablas.push(tabla); return c },
      eq: () => c, gt: () => c, gte: () => c, lte: () => c, in: () => c,
      order: () => c, limit: () => c,
      maybeSingle: async () =>
        tabla === 'cajas'
          ? { data: { id: CAJA_ID, business_id: BIZ_ID, opened_at: '2026-08-24T10:00:00Z', opened_by: USER_ID, status: 'abierta' }, error: null }
          : { data: null, error: null },
      single: async () => ({ data: null, error: null }),
      then: (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: [], error: null }),
    }
    return c
  }
  return {
    supabase: {
      auth: {
        getSession: async () => ({
          data: { session: { user: { id: USER_ID, email: 'u@invalid.test', email_confirmed_at: '2026-08-24T00:00:00Z' } } },
          error: null,
        }),
        getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signOut: async () => ({ error: null }),
      },
      rpc: async (nombre: string) =>
        nombre === 'get_my_profile' ? { data: estado.perfil, error: null } : { data: null, error: null },
      from: (tabla: string) => chain(tabla),
    },
  }
})

import { AuthProvider } from '../../src/contexts/AuthContext'
import { CajaProvider, useCaja } from '../../src/contexts/CajaContext'

const here = dirname(fileURLToPath(import.meta.url))
const leer = (rel: string) => readFileSync(join(here, '../../', rel), 'utf8')
const leerCodigo = (rel: string) =>
  leer(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '')

const perfil = (role: string, permissions: unknown = null) => ({
  id: USER_ID, business_id: BIZ_ID, role, is_active: true,
  full_name: 'U', email: 'u@invalid.test', phone: null, permissions,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
})

/** Expone el contrato del contexto para poder aseverarlo. */
function Sonda() {
  const { canUseCaja, cajaId, isOpen } = useCaja()
  return (
    <div>
      <span data-testid="can">{String(canUseCaja)}</span>
      <span data-testid="cajaId">{cajaId ?? 'null'}</span>
      <span data-testid="isOpen">{String(isOpen)}</span>
    </div>
  )
}

const montar = () =>
  render(<AuthProvider><CajaProvider><Sonda /></CajaProvider></AuthProvider>)

const fetchesDeCaja = () => estado.tablas.filter(t => t === 'cajas').length

beforeEach(() => {
  estado.perfil = null
  estado.tablas = []
  window.localStorage.clear()
  window.sessionStorage.clear()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('regresiones del contrato', () => {
  it('tech default: sin capacidad y CERO fetches de caja', async () => {
    estado.perfil = perfil('tech')
    montar()
    await waitFor(() => expect(screen.getByTestId('can').textContent).toBe('false'))

    // El corazón del hotfix: no alcanza con esconder los botones, la consulta
    // no tiene que salir.
    expect(fetchesDeCaja(), 'el tech consultó `cajas`').toBe(0)
    expect(screen.getByTestId('cajaId').textContent).toBe('null')
    expect(screen.getByTestId('isOpen').textContent).toBe('false')
  })

  it('owner: caja visible y funcional', async () => {
    estado.perfil = perfil('owner')
    montar()
    await waitFor(() => expect(screen.getByTestId('can').textContent).toBe('true'))
    await waitFor(() => expect(screen.getByTestId('cajaId').textContent).toBe(CAJA_ID))
    expect(screen.getByTestId('isOpen').textContent).toBe('true')
    expect(fetchesDeCaja()).toBeGreaterThan(0)
  })

  it('cashier autorizado: caja visible', async () => {
    estado.perfil = perfil('cashier')
    montar()
    await waitFor(() => expect(screen.getByTestId('can').textContent).toBe('true'))
    await waitFor(() => expect(screen.getByTestId('cajaId').textContent).toBe(CAJA_ID))
  })

  it('override explícito: un tech con finance=true recupera la caja', async () => {
    estado.perfil = perfil('tech', { finance: true })
    montar()
    await waitFor(() => expect(screen.getByTestId('can').textContent).toBe('true'))
    await waitFor(() => expect(screen.getByTestId('cajaId').textContent).toBe(CAJA_ID))
  })

  it('override negativo: a un cashier se le puede quitar', async () => {
    estado.perfil = perfil('cashier', { finance: false })
    montar()
    await waitFor(() => expect(screen.getByTestId('can').textContent).toBe('false'))
  })

  it('sales: NO ve la UI de caja pero SÍ conoce la caja abierta (el POS la necesita)', async () => {
    // Si le cortáramos el fetch, seguiría vendiendo pero sus ventas irían con
    // `caja_id: null` y quedarían fuera del arqueo. Eso sería cambiar el
    // comportamiento contable, que este hotfix no debe tocar.
    estado.perfil = perfil('sales')
    montar()
    await waitFor(() => expect(screen.getByTestId('cajaId').textContent).toBe(CAJA_ID))
    expect(screen.getByTestId('can').textContent, 'sales no debe ver la UI de caja').toBe('false')
  })

  it('viewer: sin UI y sin fetch', async () => {
    estado.perfil = perfil('viewer')
    montar()
    await waitFor(() => expect(screen.getByTestId('can').textContent).toBe('false'))
    expect(fetchesDeCaja()).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('estructura', () => {
  const dash = leerCodigo('src/pages/Dashboard.tsx')
  const ctx = leerCodigo('src/contexts/CajaContext.tsx')

  it('la capacidad sale del contexto, NO de un rol hardcodeado', () => {
    expect(ctx).toMatch(/canUseCaja = can\('finance'\)/)
    // El contrato prohíbe explícitamente ramificar por rol acá.
    expect(ctx).not.toMatch(/role\s*===\s*['"]/)
    expect(dash).not.toMatch(/role\s*===\s*['"]tech['"]/)
  })

  it('el estado de caja del dashboard está gateado', () => {
    expect(dash).toMatch(/\{canUseCaja && \(/)
    expect(dash).toContain('data-testid="dash-estado-caja"')
  })

  it('la pestaña Movimientos Caja está gateada', () => {
    expect(dash).toMatch(/canUseCaja[\s\S]{0,120}Movimientos Caja/)
    expect(dash).toMatch(/activeTab === 'movimientos' && canUseCaja/)
  })

  it('el fetch de caja está condicionado', () => {
    expect(ctx).toMatch(/if \(!businessId \|\| !necesitaConocerCaja\)/)
    // Y los listeners tampoco se registran de más.
    expect(ctx).toMatch(/if \(!necesitaConocerCaja\) return/)
  })
})
