// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-3A-2S · Frontend alineado con la autoridad server-side.
//
//   A. POS: el precio mayorista exige acceso Mayorista del actor (espejo del
//      checkout). Sin acceso, un cliente mayorista se cotiza minorista.
//   B. Conversión portal -> customers: SOLO por la RPC canónica; ningún INSERT
//      directo del navegador a `customers` con customer_type mayorista.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const state = vi.hoisted(() => ({
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  from: [] as string[],
  rpcResult: { data: null as unknown, error: null as null | { message: string } },
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcs.push({ fn, args })
      return state.rpcResult
    },
    from: (t: string) => { state.from.push(t); return {} },
  },
}))

import { resolvesWholesalePricing } from '../../src/utils/pricing'
import { getOrCreateCustomerFromWholesale } from '../../src/portal/services/portalService'

const here = dirname(fileURLToPath(import.meta.url))
const code = (rel: string) => readFileSync(join(here, '../../', rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

beforeEach(() => {
  state.rpcs = []
  state.from = []
  state.rpcResult = { data: null, error: null }
})

describe('A · POS: precio mayorista = venta mayorista Y acceso del actor', () => {
  const CASES: Array<[string, { customerIsWholesale: boolean; forceWholesale: boolean; canAccessWholesale: boolean }, boolean]> = [
    ['cliente mayorista + acceso', { customerIsWholesale: true, forceWholesale: false, canAccessWholesale: true }, true],
    ['cliente mayorista SIN acceso (manager/sales sin wholesale, Básico)', { customerIsWholesale: true, forceWholesale: false, canAccessWholesale: false }, false],
    ['flujo Mayorista forzado + acceso', { customerIsWholesale: false, forceWholesale: true, canAccessWholesale: true }, true],
    ['flujo Mayorista forzado SIN acceso', { customerIsWholesale: false, forceWholesale: true, canAccessWholesale: false }, false],
    ['minorista + acceso', { customerIsWholesale: false, forceWholesale: false, canAccessWholesale: true }, false],
  ]
  for (const [name, input, esperado] of CASES) {
    it(`${name} → ${esperado ? 'mayorista' : 'minorista'}`, () => {
      expect(resolvesWholesalePricing(input)).toBe(esperado)
    })
  }

  it('ComprobanteProModal cotiza con la autoridad central, no con customer_type solo', () => {
    const src = code('src/components/comprobantes/ComprobanteProModal.tsx')
    // La autoridad que entra a la regla es EXACTAMENTE useWholesaleAccess().canAccess.
    expect(src).toMatch(/const \{ canAccess: puedeCotizarMayorista \} = useWholesaleAccess\(\)/)
    expect(src).toMatch(/resolvesWholesalePricing\(\{[\s\S]{0,200}canAccessWholesale: puedeCotizarMayorista,[\s\S]{0,80}\}\)/)
    expect(src).not.toMatch(/usarPrecioMayorista \|\| isWholesaleCustomer\(selectedCliente\)/)
  })
})

describe('B · conversión portal -> customers', () => {
  it('llama a la RPC canónica con el negocio y el id del cliente del portal', async () => {
    state.rpcResult = { data: { ok: true, customer_id: 'c-1', created: true }, error: null }
    const r = await getOrCreateCustomerFromWholesale('biz-1', 'wc-1')
    expect(r).toEqual({ customerId: 'c-1', created: true, error: null })
    expect(state.rpcs).toEqual([{ fn: 'get_or_create_customer_from_wholesale_atomic',
      args: { p_business_id: 'biz-1', p_wholesale_customer_id: 'wc-1' } }])
    expect(state.from).toEqual([])
  })

  it('un match ambiguo NO elige un cliente: pide al operador que decida', async () => {
    state.rpcResult = { data: null, error: { message: 'CUSTOMER_MATCH_AMBIGUOUS: 2 clientes ...' } }
    const r = await getOrCreateCustomerFromWholesale('biz-1', 'wc-1')
    expect(r.customerId).toBeNull()
    expect(r.error).toMatch(/Elegí el cliente manualmente/)
  })

  it('sin negocio o sin cliente del portal no llama a nada', async () => {
    const r = await getOrCreateCustomerFromWholesale('', 'wc-1')
    expect(r.customerId).toBeNull()
    expect(state.rpcs).toEqual([])
  })

  it('ningún archivo del frontend inserta clientes mayoristas directo en `customers`', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e)) {
          const src = code(p.replace(join(here, '../../'), ''))
          if (/from\(\s*['"]customers['"]\s*\)[\s\S]{0,200}\.insert\([\s\S]{0,400}customer_type:\s*(customerType|['"]mayorista['"])/.test(src)) {
            offenders.push(p)
          }
        }
      }
    }
    walk(join(here, '../../src'))
    expect(offenders).toEqual([])
    expect(code('src/portal/services/portalService.ts')).not.toMatch(/getOrCreateCustomerFromPortal|\.ilike\(\s*['"]name['"]/)
  })
})
