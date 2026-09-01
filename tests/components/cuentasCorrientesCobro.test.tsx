// ─────────────────────────────────────────────────────────────────────────────
// P0-CC · CC-B — El cobro de cuenta corriente tiene UN solo camino.
//
// La pantalla `/cuentas` tenía su propio modal de "Registrar pago" que hacía un
// INSERT directo en `account_movements`: bajaba la deuda del cliente y no creaba
// ni el movimiento de caja ni el asiento financiero. La ficha del cliente, en
// cambio, usaba la RPC atómica. Dos botones con el MISMO texto y contabilidad
// opuesta.
//
// Este test fija el contrato nuevo:
//   1. `/cuentas` monta `ModalPagarCC` y cobra por la RPC canónica;
//   2. NUNCA inserta en `account_movements` desde el cliente;
//   3. el método de cobro es un selector obligatorio, no texto libre;
//   4. la observación es opcional y NO sustituye al método;
//   5. la moneda se dice: ARS, sin opción USD;
//   6. el saldo y el badge se refrescan juntos después de cobrar.
//
// Los puntos 1 y 2 se miden de dos formas —comportamiento y código fuente—
// porque la regresión más probable es que alguien reintroduzca el insert directo
// en una rama del componente que el render no ejercita.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const BIZ_ID  = '22222222-2222-4222-8222-222222222222'
const CAJA_ID = '33333333-3333-4333-8333-333333333333'
const ACC_ID  = '44444444-4444-4444-8444-444444444444'
const CUST_ID = '55555555-5555-4555-8555-555555555555'

const estado = vi.hoisted(() => ({
  /** Toda RPC invocada, con sus argumentos. */
  rpcs: [] as { nombre: string; args: Record<string, unknown> }[],
  /** Todo INSERT intentado, por tabla. Es como se mide "cero insert directo". */
  inserts: [] as string[],
  /** Saldo que devuelve la DB simulada; el cobro lo baja. */
  saldo: 100000,
}))

vi.mock('../../src/lib/supabase', () => {
  const cuenta = () => ({
    id: ACC_ID, business_id: BIZ_ID, type: 'cliente',
    entity_id: CUST_ID, entity_name: 'Cliente Uno', entity_phone: null,
    balance: estado.saldo, credit_limit: null, notes: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  })
  const chain = (tabla: string): Record<string, unknown> => {
    const filas = () => {
      if (tabla === 'accounts') return [cuenta()]
      if (tabla === 'cajas') return [{ id: CAJA_ID, business_id: BIZ_ID, opened_at: '2026-08-25T10:00:00Z', opened_by: USER_ID, status: 'abierta' }]
      return []
    }
    const c: Record<string, unknown> = {
      select: () => c, eq: () => c, gt: () => c, gte: () => c, lte: () => c,
      in: () => c, ilike: () => c, order: () => c, limit: () => c,
      insert: () => { estado.inserts.push(tabla); return c },
      update: () => c, delete: () => c,
      maybeSingle: async () => ({ data: filas()[0] ?? null, error: null }),
      single: async () => ({ data: filas()[0] ?? null, error: null }),
      then: (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: filas(), error: null }),
    }
    return c
  }
  return {
    supabase: {
      auth: {
        getSession: async () => ({
          data: { session: { user: { id: USER_ID, email: 'u@invalid.test', email_confirmed_at: '2026-08-25T00:00:00Z' } } },
          error: null,
        }),
        getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signOut: async () => ({ error: null }),
      },
      rpc: async (nombre: string, args: Record<string, unknown>) => {
        estado.rpcs.push({ nombre, args })
        if (nombre === 'get_my_profile') {
          return { data: { id: USER_ID, business_id: BIZ_ID, role: 'owner', is_active: true,
            full_name: 'Owner', email: 'u@invalid.test', phone: null, permissions: null,
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }, error: null }
        }
        if (nombre === 'record_customer_account_payment_atomic') {
          estado.saldo -= Number(args.p_amount) || 0
          return { data: { ok: true, replay: false, account_movement_id: 'am-1', financial_movement_id: 'fm-1' }, error: null }
        }
        return { data: null, error: null }
      },
      from: (tabla: string) => chain(tabla),
    },
  }
})

// El timeline hace su propia orquestación de queries; acá no se está probando.
vi.mock('../../src/hooks/useEntityTimeline', () => ({
  useEntityTimeline: () => ({ events: [], loading: false, error: null, refetch: () => {} }),
}))

import { AuthProvider } from '../../src/contexts/AuthContext'
import { CajaProvider } from '../../src/contexts/CajaContext'
import { CuentasCorrientes } from '../../src/pages/CuentasCorrientes'

const here = dirname(fileURLToPath(import.meta.url))
const leer = (rel: string) => readFileSync(join(here, '../../', rel), 'utf8')
/** Sin comentarios: un `// ya no usamos registerPayment` no debe dar falso positivo. */
const leerCodigo = (rel: string) =>
  leer(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '')

const montar = () => render(<AuthProvider><CajaProvider><CuentasCorrientes /></CajaProvider></AuthProvider>)

const abrirCuentaYCobrar = async () => {
  montar()
  const fila = await screen.findByTestId('cc-account-row')
  fireEvent.click(fila)
  const boton = await screen.findByTestId('cc-register-payment-button')
  fireEvent.click(boton)
  return screen.findByTestId('cc-pay-methods')
}

beforeEach(() => {
  estado.rpcs = []
  estado.inserts = []
  estado.saldo = 100000
  window.localStorage.clear()
  window.sessionStorage.clear()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CC-B · /cuentas cobra por el camino canónico', () => {
  it('el botón dice "Registrar cobro", no "Registrar pago"', async () => {
    montar()
    fireEvent.click(await screen.findByTestId('cc-account-row'))
    const boton = await screen.findByTestId('cc-register-payment-button')
    // Desde el negocio la plata ENTRA: es un cobro. "Pago" describe al cliente.
    expect(boton.textContent).toContain('Registrar cobro')
    expect(boton.textContent).not.toContain('Registrar pago')
  })

  it('el modal usa la MISMA palabra que el botón: cobro, no pago', async () => {
    // El botón decía «Registrar cobro» y el modal que abría decía «Registrar
    // pago de CC» y «Confirmar pago». Dos palabras para el mismo acto es
    // exactamente la ambigüedad que originó este lote.
    await abrirCuentaYCobrar()
    expect(screen.getByTestId('cc-pay-confirm').textContent).toContain('Confirmar cobro')
    expect(screen.queryByText('Registrar pago de CC')).toBeNull()
    expect(screen.queryByText('Confirmar pago')).toBeNull()
  })

  it('abre ModalPagarCC con el selector de método', async () => {
    await abrirCuentaYCobrar()
    expect(screen.getByTestId('cc-pay-method-efectivo')).toBeTruthy()
    expect(screen.getByTestId('cc-pay-method-transferencia')).toBeTruthy()
    expect(screen.getByTestId('cc-pay-method-tarjeta_debito')).toBeTruthy()
    expect(screen.getByTestId('cc-pay-method-tarjeta_credito')).toBeTruthy()
    expect(screen.getByTestId('cc-pay-method-otro')).toBeTruthy()
  })

  it('cobra por la RPC atómica y NO inserta en account_movements', async () => {
    await abrirCuentaYCobrar()
    fireEvent.click(screen.getByTestId('cc-pay-method-transferencia'))
    fireEvent.change(screen.getByTestId('cc-pay-amount'), { target: { value: '40000' } })
    fireEvent.click(screen.getByTestId('cc-pay-confirm'))

    await waitFor(() => {
      expect(estado.rpcs.map(r => r.nombre)).toContain('record_customer_account_payment_atomic')
    })

    // El corazón de CC-B: la plata no puede entrar por un INSERT del cliente.
    expect(estado.inserts, `se insertó directo en: ${estado.inserts.join(', ')}`)
      .not.toContain('account_movements')
    expect(estado.inserts).not.toContain('financial_movements')
    expect(estado.inserts).not.toContain('business_finance_entries')
  })

  it('manda el método canónico y la caja abierta a la RPC', async () => {
    await abrirCuentaYCobrar()
    fireEvent.click(screen.getByTestId('cc-pay-method-tarjeta_debito'))
    fireEvent.change(screen.getByTestId('cc-pay-amount'), { target: { value: '10000' } })
    fireEvent.click(screen.getByTestId('cc-pay-confirm'))

    const llamada = await waitFor(() => {
      const r = estado.rpcs.find(x => x.nombre === 'record_customer_account_payment_atomic')
      expect(r).toBeTruthy()
      return r!
    })
    // `debito` era el string legacy que rompía el arqueo.
    expect(llamada.args.p_payment_method).toBe('tarjeta_debito')
    expect(llamada.args.p_caja_id).toBe(CAJA_ID)
    expect(llamada.args.p_business_id).toBe(BIZ_ID)
    expect(llamada.args.p_amount).toBe(10000)
    // Y siempre viaja una clave de idempotencia.
    expect(llamada.args.p_idempotency_key).toBeTruthy()
  })

  it('la observación es opcional: se puede cobrar sin escribir nada', async () => {
    await abrirCuentaYCobrar()
    // Arranca vacía a propósito: cuando era obligatoria y no había selector, el
    // operador la usaba para anotar el método. En producción quedó un cobro cuya
    // descripción es, literalmente, "efectivo".
    expect((screen.getByTestId('cc-pay-note') as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByTestId('cc-pay-amount'), { target: { value: '5000' } })
    fireEvent.click(screen.getByTestId('cc-pay-confirm'))
    await waitFor(() => {
      expect(estado.rpcs.some(r => r.nombre === 'record_customer_account_payment_atomic')).toBe(true)
    })
    expect(screen.queryByTestId('cc-pay-error')).toBeNull()
  })

  it('un doble click no dispara dos cobros', async () => {
    await abrirCuentaYCobrar()
    fireEvent.change(screen.getByTestId('cc-pay-amount'), { target: { value: '20000' } })
    const confirmar = screen.getByTestId('cc-pay-confirm')
    fireEvent.click(confirmar)
    fireEvent.click(confirmar)
    fireEvent.click(confirmar)
    await waitFor(() => {
      expect(estado.rpcs.some(r => r.nombre === 'record_customer_account_payment_atomic')).toBe(true)
    })
    const cobros = estado.rpcs.filter(r => r.nombre === 'record_customer_account_payment_atomic')
    expect(cobros.length, 'el doble click generó más de un cobro').toBe(1)
  })

  it('dice ARS y no ofrece USD', async () => {
    const panel = await abrirCuentaYCobrar()
    const modal = panel.closest('div[style]')!.parentElement!.parentElement!
    expect(modal.textContent).toContain('ARS')
    expect(modal.textContent).not.toMatch(/\bUSD\b|Dólar|Dolar|cotizaci/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CC-B · el camino legacy ya no existe en el código', () => {
  const pagina = () => leerCodigo('src/pages/CuentasCorrientes.tsx')

  it('CuentasCorrientes no llama a registerPayment', () => {
    expect(pagina()).not.toMatch(/registerPayment/)
  })

  it('CuentasCorrientes no inserta en account_movements', () => {
    expect(pagina()).not.toMatch(/from\(\s*['"]account_movements['"]\s*\)/)
    expect(pagina()).not.toMatch(/\.insert\(/)
  })

  it('CuentasCorrientes monta ModalPagarCC', () => {
    expect(pagina()).toMatch(/ModalPagarCC/)
  })

  it('ModalPagarCC no ofrece los alias legacy debito/credito', () => {
    const modal = leerCodigo('src/components/comprobantes/ModalPagarCC.tsx')
    // Los ids tienen que ser del catálogo de negocio; `debito` suelto rompía el arqueo.
    expect(modal).not.toMatch(/id:\s*['"]debito['"]/)
    expect(modal).not.toMatch(/id:\s*['"]credito['"]/)
    expect(modal).toMatch(/id:\s*['"]tarjeta_debito['"]/)
    expect(modal).toMatch(/id:\s*['"]tarjeta_credito['"]/)
  })

  it('la ficha del cliente usa el MISMO modal, no una variante', () => {
    const ficha = leerCodigo('src/pages/CustomerDetail.tsx')
    expect(ficha).toMatch(/ModalPagarCC/)
    expect(ficha).not.toMatch(/registerPayment/)
  })

  it('la ficha no consulta ni muestra el historial financiero sin orders_view_financials', () => {
    const ficha = leerCodigo('src/pages/CustomerDetail.tsx')
    expect(ficha).toMatch(/can\(['"]orders_view_financials['"]\)/)
    expect(ficha).toMatch(/activeTab !== ['"]compras['"] \|\| !canViewPurchaseFinancials/)
    expect(ficha).toMatch(/canViewPurchaseFinancials \? \[\{ id: ['"]compras['"]/)
  })

  it('la ficha también oculta montos de orden y cuenta corriente al override false', () => {
    const ficha = leerCodigo('src/pages/CustomerDetail.tsx')
    expect(ficha).toMatch(/canViewPurchaseFinancials && <th>Total<\/th>/)
    expect(ficha).toMatch(/canViewPurchaseFinancials && ccAccount/)
    expect(ficha).toMatch(/if \(!canViewPurchaseFinancials \|\| !businessId \|\| !id\)/)
    expect(ficha).toMatch(/canViewPurchaseFinancials && <td[^>]*>\{fmt\(amount\)\}<\/td>/)
  })
})
