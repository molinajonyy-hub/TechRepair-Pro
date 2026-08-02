// ─────────────────────────────────────────────────────────────────────────────
// P0-A.1U1V — Resumen financiero: importes según PERMISO server-side.
// Casos 1-6 y 12 del contrato de permisos, más 9/10/14/15 de U1.
//
// P0-A.1 fix — Estados de error de los importes. El gate visual encontró que
// un fallo de `get_order_financial_amounts` caía en la rama de éxito con datos
// sin montos y renderizaba `$NaN`. Los casos "estado de importes" de abajo
// fijan que error, falta de permiso y payload inservible son cosas distintas.
//
// Se mockea el LÍMITE (supabase y useAuth), nunca el componente bajo prueba.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Estado SIN importes: lo que devuelve v_order_payment_state a cualquier rol.
const estadoBase = {
  order_id: 'o1', payment_status: 'partial',
  comprobantes_vigentes: 1, comprobante_id: 'c1', comprobante_numero: '0001-00000042',
}
// Importes: sólo llegan si la RPC autoriza.
const importes = {
  order_id: 'o1', total_comprobado: 100000, total_cobrado: 40000, cobrado_directo: 40000,
  imputado_cc: 0, saldo_pendiente: 60000, saldo_en_cc: 60000, deuda_en_cc: true,
  completed_at: '2026-07-30T12:00:00Z', paid_at: null, ultimo_pago: '2026-07-30',
}

type Resp = { data: unknown; error: unknown }

// Resolvers: reciben el orderId pedido para poder simular respuestas cruzadas.
let darEstado:  (orderId?: string) => Promise<Resp>
let darMontos:  (orderId?: string) => Promise<Resp>
let respCredito: Resp

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1', user: { id: 'u1' } }),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const q: Record<string, unknown> = {}
      let pedido: string | undefined
      q.select = () => q
      q.eq = (col: string, val: string) => { if (col === 'order_id') pedido = val; return q }
      q.maybeSingle = () => darEstado(pedido)
      return q
    },
    rpc: (nombre: string, args?: Record<string, unknown>) => {
      if (nombre === 'get_customer_unallocated_credit') return Promise.resolve(respCredito)
      // El resumen monta el historial de imputaciones: sin permiso no renderiza
      // nada, que es lo que estos tests necesitan para aislar el resumen.
      if (nombre === 'get_payment_allocations') {
        return Promise.resolve({ data: { ok: true, authorized: false }, error: null })
      }
      return darMontos((args?.p_order_ids as string[] | undefined)?.[0])
    },
  },
}))

const { OrderFinancialSummary } = await import('../../src/components/orders/OrderFinancialSummary')

const montar = (customerId: string | null = null, orderId = 'o1') =>
  render(<MemoryRouter><OrderFinancialSummary orderId={orderId} customerId={customerId} /></MemoryRouter>)

const yaCargo = async () =>
  waitFor(() => expect(screen.queryByTestId('order-financial-loading')).not.toBeInTheDocument())

/** Espera a que el bloque de importes salga de su estado de carga. */
const importesResueltos = async () =>
  waitFor(() => expect(screen.queryByTestId('order-amounts-loading')).not.toBeInTheDocument())

describe('OrderFinancialSummary — permisos e importes', () => {
  beforeEach(() => {
    darEstado   = () => Promise.resolve({ data: estadoBase, error: null })
    darMontos   = () => Promise.resolve({ data: { ok: true, authorized: true, rows: [importes] }, error: null })
    respCredito = { data: { ok: true, authorized: true, unallocated_amount: 0 }, error: null }
  })

  test('casos 1-2: un rol autorizado (owner/cashier) ve badge E importes', async () => {
    montar(); await yaCargo(); await importesResueltos()
    const card = screen.getByTestId('order-financial-summary')
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('Parcial')
    expect(card).toHaveTextContent('$100.000')
    expect(card).toHaveTextContent('$60.000')
    expect(screen.queryByTestId('order-amounts-restricted')).not.toBeInTheDocument()
  })

  test('casos 3-4: tech/viewer ven el badge pero NO los importes', async () => {
    darMontos = () => Promise.resolve({ data: { ok: true, authorized: false, rows: [] }, error: null })
    montar(); await yaCargo(); await importesResueltos()
    // El estado de cobro sigue visible: es lo que el contrato permite.
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('Parcial')
    expect(screen.getByTestId('order-amounts-restricted')).toBeInTheDocument()
    const card = screen.getByTestId('order-financial-summary')
    expect(card).not.toHaveTextContent('Total comprobado')
    expect(card).not.toHaveTextContent('100.000')
    expect(card).not.toHaveTextContent('60.000')
  })

  test('caso 5: sin permiso NO aparece ningún importe en cero', async () => {
    darMontos = () => Promise.resolve({ data: { ok: true, authorized: false, rows: [] }, error: null })
    montar(); await yaCargo(); await importesResueltos()
    expect(screen.getByTestId('order-financial-summary')).not.toHaveTextContent('$0')
  })

  test('caso 6: error financiero muestra "No disponible", no "restringido" ni $0', async () => {
    darEstado = () => Promise.resolve({ data: null, error: { message: 'permission denied' } })
    montar(); await yaCargo()
    expect(screen.getByTestId('order-financial-unavailable')).toBeInTheDocument()
    const card = screen.getByTestId('order-financial-summary')
    expect(card).toHaveTextContent('No disponible')
    expect(card).not.toHaveTextContent('$0')
    expect(screen.queryByTestId('order-amounts-restricted')).not.toBeInTheDocument()
  })

  test('caso 10: mientras carga no se muestra ningún estado ni importe', () => {
    montar()
    expect(screen.getByTestId('order-financial-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('order-financial-badge')).not.toBeInTheDocument()
    expect(screen.getByTestId('order-financial-summary')).not.toHaveTextContent('$0')
  })

  test('caso 12: el crédito no imputado sólo aparece con permiso', async () => {
    respCredito = { data: { ok: true, authorized: true, unallocated_amount: 25000 }, error: null }
    montar('cli-1')
    await waitFor(() => expect(screen.getByTestId('order-unallocated-credit')).toBeInTheDocument())
    expect(screen.getByTestId('order-unallocated-credit')).toHaveTextContent('$25.000')
    // Y no cambia el estado de la orden.
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('Parcial')
  })

  test('caso 12b: sin permiso el crédito no se muestra en absoluto', async () => {
    darMontos   = () => Promise.resolve({ data: { ok: true, authorized: false, rows: [] }, error: null })
    respCredito = { data: { ok: true, authorized: false }, error: null }
    montar('cli-1'); await yaCargo(); await importesResueltos()
    expect(screen.queryByTestId('order-unallocated-credit')).not.toBeInTheDocument()
  })

  test('la orden sin fila en la vista no inventa un estado', async () => {
    darEstado = () => Promise.resolve({ data: null, error: null })
    montar(); await yaCargo()
    expect(screen.getByTestId('order-financial-unavailable')).toBeInTheDocument()
    expect(screen.getByTestId('order-financial-badge')).not.toHaveTextContent('Cobrado')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Estado de los importes: error ≠ falta de permiso ≠ cero real.
// ─────────────────────────────────────────────────────────────────────────────
describe('OrderFinancialSummary — importes no disponibles', () => {
  beforeEach(() => {
    darEstado   = () => Promise.resolve({ data: estadoBase, error: null })
    darMontos   = () => Promise.resolve({ data: { ok: true, authorized: true, rows: [importes] }, error: null })
    respCredito = { data: { ok: true, authorized: true, unallocated_amount: 0 }, error: null }
  })

  /** Lo que NUNCA puede verse cuando los importes no llegaron. */
  const sinImportesFalsos = () => {
    const card = screen.getByTestId('order-financial-summary')
    expect(card).not.toHaveTextContent('NaN')
    expect(card).not.toHaveTextContent('Infinity')
    expect(card).not.toHaveTextContent('$0')
    expect(card).not.toHaveTextContent('Total comprobado')
    expect(card).not.toHaveTextContent('Saldo pendiente')
  }

  test('caso 1: { ok: false } muestra "No disponible" y conserva el badge', async () => {
    darMontos = () => Promise.resolve({ data: { ok: false, error: 'boom' }, error: null })
    montar(); await yaCargo(); await importesResueltos()
    expect(screen.getByTestId('order-amounts-unavailable')).toBeInTheDocument()
    expect(screen.getByTestId('order-amounts-unavailable')).toHaveTextContent('No disponible')
    // El badge viene de v_order_payment_state: que fallen los montos no lo borra.
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('Parcial')
    sinImportesFalsos()
  })

  test('caso 2: un 403 del servicio NO se interpreta como rol restringido', async () => {
    darMontos = () => Promise.resolve({
      data: null, error: { message: 'permission denied for function', code: '42501' },
    })
    montar(); await yaCargo(); await importesResueltos()
    expect(screen.getByTestId('order-amounts-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('order-amounts-restricted')).not.toBeInTheDocument()
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('Parcial')
    sinImportesFalsos()
  })

  test('caso 3: un error de red da el mismo resultado', async () => {
    darMontos = () => Promise.resolve({ data: null, error: { message: 'Failed to fetch' } })
    montar(); await yaCargo(); await importesResueltos()
    expect(screen.getByTestId('order-amounts-unavailable')).toBeInTheDocument()
    sinImportesFalsos()
  })

  test('el mensaje de error no filtra detalles técnicos', async () => {
    darMontos = () => Promise.resolve({
      data: { ok: false, error: 'new row violates check constraint "cap_amount_positive"', error_code: 'P0001' },
      error: null,
    })
    montar(); await yaCargo(); await importesResueltos()
    const txt = screen.getByTestId('order-amounts-unavailable').textContent ?? ''
    expect(txt).toMatch(/No pudimos cargar los importes de esta orden/)
    for (const filtrado of ['constraint', 'cap_amount_positive', 'P0001', 'violates', 'SQL']) {
      expect(txt).not.toContain(filtrado)
    }
  })

  test('caso 4: el rol restringido sigue diciendo "Importes restringidos", no "No disponible"', async () => {
    darMontos = () => Promise.resolve({ data: { ok: true, authorized: false, rows: [] }, error: null })
    montar(); await yaCargo(); await importesResueltos()
    expect(screen.getByTestId('order-amounts-restricted')).toBeInTheDocument()
    expect(screen.queryByTestId('order-amounts-unavailable')).not.toBeInTheDocument()
    expect(screen.getByTestId('order-financial-summary')).not.toHaveTextContent('No disponible')
  })

  test('caso 5: un cero REAL se muestra como $0 y no como error', async () => {
    darMontos = () => Promise.resolve({
      data: { ok: true, authorized: true, rows: [{ ...importes, total_comprobado: 0, cobrado_directo: 0, saldo_pendiente: 0 }] },
      error: null,
    })
    montar(); await yaCargo(); await importesResueltos()
    const card = screen.getByTestId('order-financial-summary')
    expect(card).toHaveTextContent('Total comprobado')
    expect(card).toHaveTextContent('$0')
    expect(screen.queryByTestId('order-amounts-unavailable')).not.toBeInTheDocument()
    expect(card).not.toHaveTextContent('NaN')
  })

  test('caso 6: los importes correctos se muestran completos', async () => {
    montar(); await yaCargo(); await importesResueltos()
    const card = screen.getByTestId('order-financial-summary')
    expect(card).toHaveTextContent('$100.000')
    expect(card).toHaveTextContent('$40.000')
    expect(card).toHaveTextContent('$60.000')
    expect(card).not.toHaveTextContent('NaN')
  })

  test('caso 7: un payload incompleto no se pinta como $NaN', async () => {
    // Llega la fila pero sin los montos: tan inservible como un error.
    darMontos = () => Promise.resolve({
      data: { ok: true, authorized: true, rows: [{ order_id: 'o1', completed_at: '2026-07-30T12:00:00Z' }] },
      error: null,
    })
    montar(); await yaCargo(); await importesResueltos()
    expect(screen.getByTestId('order-amounts-unavailable')).toBeInTheDocument()
    sinImportesFalsos()
  })

  test('un payload con montos nulos tampoco pasa por cero', async () => {
    darMontos = () => Promise.resolve({
      data: { ok: true, authorized: true, rows: [{ ...importes, saldo_pendiente: null }] },
      error: null,
    })
    montar(); await yaCargo(); await importesResueltos()
    expect(screen.getByTestId('order-amounts-unavailable')).toBeInTheDocument()
    sinImportesFalsos()
  })

  test('caso 8: la respuesta vieja no pisa el estado de la orden nueva', async () => {
    const estadoDe = (id: string, st: string) => ({
      ...estadoBase, order_id: id, payment_status: st, comprobante_id: 'c-' + id,
    })
    // o1 responde tarde; o2 responde ya. La respuesta de o1 llega ÚLTIMA.
    darEstado = (id) => id === 'o1'
      ? new Promise(r => setTimeout(() => r({ data: estadoDe('o1', 'pending'), error: null }), 80))
      : Promise.resolve({ data: estadoDe('o2', 'paid'), error: null })
    darMontos = (id) => id === 'o1'
      ? new Promise(r => setTimeout(() => r({
          data: { ok: true, authorized: true, rows: [{ ...importes, order_id: 'o1', total_comprobado: 999999, saldo_pendiente: 999999 }] },
          error: null }), 80))
      : Promise.resolve({
          data: { ok: true, authorized: true, rows: [{ ...importes, order_id: 'o2', total_comprobado: 100000, saldo_pendiente: 60000 }] },
          error: null })

    const { rerender } = render(
      <MemoryRouter><OrderFinancialSummary orderId="o1" customerId={null} /></MemoryRouter>,
    )
    // Cambio de orden con la primera petición todavía en vuelo.
    rerender(<MemoryRouter><OrderFinancialSummary orderId="o2" customerId={null} /></MemoryRouter>)

    await waitFor(() => expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('Cobrado'))
    // Se le da tiempo de sobra a la respuesta vieja para llegar y pisar.
    await new Promise(r => setTimeout(r, 150))

    const card = screen.getByTestId('order-financial-summary')
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('Cobrado')
    expect(card).toHaveTextContent('$100.000')
    expect(card).not.toHaveTextContent('999.999')
    expect(card).not.toHaveTextContent('Pendiente')
  })

  test('al cambiar de orden no se reutilizan los importes de la anterior', async () => {
    darEstado = (id) => Promise.resolve({ data: { ...estadoBase, order_id: id }, error: null })
    darMontos = (id) => id === 'o1'
      ? Promise.resolve({ data: { ok: true, authorized: true, rows: [importes] }, error: null })
      // La segunda orden no puede mostrar importes: los suyos fallaron.
      : Promise.resolve({ data: { ok: false, error: 'boom' }, error: null })

    const { rerender } = render(
      <MemoryRouter><OrderFinancialSummary orderId="o1" customerId={null} /></MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByTestId('order-financial-summary')).toHaveTextContent('$100.000'))

    rerender(<MemoryRouter><OrderFinancialSummary orderId="o2" customerId={null} /></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('order-amounts-unavailable')).toBeInTheDocument())
    expect(screen.getByTestId('order-financial-summary')).not.toHaveTextContent('$100.000')
  })
})
