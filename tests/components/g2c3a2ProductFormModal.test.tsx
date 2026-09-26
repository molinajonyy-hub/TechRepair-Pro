// ─────────────────────────────────────────────────────────────────────────────
// G2-C.3A2 — ProductFormModal sobre la autoridad canónica de stock.
//
//   T3  alta desde Inventario qty 5 → INSERT sin stock (nace 0) + initial_stock +5.
//   T4  alta qty 0 → sin RPC.
//   T5  quick-create desde Proveedores (initialQuantity 7) → nace 0, sin RPC.
//   T6  quick-create desde Gastos/factura → mismo contrato.
//   T13 «Con variantes» oculto; initialTipo='with_variants' degrada explícito.
//   T18 edición sólo de metadata → 0 RPC de stock.
//   T19 el UPDATE de metadata no lleva stock_quantity.
//   T1/T2 edición de stock → manual target/expected; stale → no pisa, informa.
//   + stock inicial pendiente: el retry reusa initial-stock:<id>, sin crear otro.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { newFakeState, resetFakeState, a1Calls, inventoryWrites, payloadHasStock } from './fakes/supabaseStockFake'

const h = vi.hoisted(() => ({ state: null as any }))
vi.mock('../../src/lib/supabase', async () => {
  const fake = await import('./fakes/supabaseStockFake')
  h.state = h.state ?? fake.newFakeState()
  return { supabase: fake.makeSupabaseFake(h.state) }
})
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: '77777777-7777-4777-8777-777777777777', user: { id: 'u1' } }),
}))
vi.mock('../../src/services/dollarRateService', () => ({
  getCurrentDollarRate: vi.fn(async () => null),
  refreshDollarRate: vi.fn(async () => null),
}))
vi.mock('../../src/services/inventoryCostAccess', async (orig) => ({
  ...(await orig<typeof import('../../src/services/inventoryCostAccess')>()),
  fetchInventoryCosts: vi.fn(async () => ({ costs: new Map(), authorized: true })),
  hasInventoryCostAuthority: vi.fn(async () => true),
}))

import { ProductFormModal } from '../../src/components/products/ProductFormModal'

const BIZ = '77777777-7777-4777-8777-777777777777'
const EXISTENTE = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  if (!h.state) h.state = newFakeState()
  resetFakeState(h.state)
  localStorage.clear()
})

function completarAlta(nombre = 'Pantalla X') {
  fireEvent.change(screen.getByTestId('product-name-input'), { target: { value: nombre } })
  fireEvent.change(screen.getAllByTestId('product-price-input')[0], { target: { value: '1000' } })
}

const inserts = () => inventoryWrites(h.state).filter((o) => o.kind === 'insert')
const updates = () => inventoryWrites(h.state).filter((o) => o.kind === 'update')

describe('ProductFormModal · alta', () => {
  it('T3 · desde Inventario qty 5: INSERT sin stock (nace 0) + initial_stock +5 con clave estable', async () => {
    const onCreated = vi.fn()
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={onCreated} registerStock sourceNote="Alta desde Inventario" />)
    completarAlta()
    fireEvent.change(screen.getByTestId('product-stock-input'), { target: { value: '5' } })
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())

    expect(inserts()).toHaveLength(1)
    expect(payloadHasStock(inserts()[0].payload)).toBe(false)
    const productId = onCreated.mock.calls[0][0].id
    expect(a1Calls(h.state)).toHaveLength(1)
    expect(a1Calls(h.state)[0].args).toEqual({
      p_business_id: BIZ, p_source: 'initial_stock',
      p_items: [{ inventory_id: productId, delta: 5 }],
      p_reason: 'Alta desde Inventario',
      p_idempotency_key: `initial-stock:${productId}`,
    })
    expect(h.state.stock.get(productId)).toBe(5)
    expect(h.state.movements).toEqual([{ inventory_id: productId, quantity: 5, source: 'initial_stock', key: `initial-stock:${productId}` }])
    expect(onCreated.mock.calls[0][0].stock_quantity).toBe(5)
    // No hay más checkbox de «registrar movimiento»: el stock inicial SIEMPRE va por la RPC.
    expect(screen.queryByText(/Registrar movimiento de inventario/)).toBeNull()
  })

  it('T4 · alta qty 0: sin RPC de stock', async () => {
    const onCreated = vi.fn()
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={onCreated} registerStock />)
    completarAlta()
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(inserts()).toHaveLength(1)
    expect(payloadHasStock(inserts()[0].payload)).toBe(false)
    expect(a1Calls(h.state)).toHaveLength(0)
    expect(onCreated.mock.calls[0][0].stock_quantity).toBe(0)
  })

  it('T5 · quick-create desde Proveedores: initialQuantity NO crea stock', async () => {
    const onCreated = vi.fn()
    render(
      <ProductFormModal isOpen onClose={() => {}} onCreated={onCreated}
        initialName="Batería Z" initialCost={500} initialQuantity={7}
        supplierId="44444444-4444-4444-8444-444444444444" supplierName="Proveedor" registerStock={false} sourceType="supplier_invoice" />,
    )
    // No hay input de stock: sólo el aviso de que nace en 0.
    expect(screen.queryByTestId('product-stock-input')).toBeNull()
    expect(screen.getByTestId('product-stock-contextual-hint')).toHaveTextContent('El producto se crea con stock 0')
    fireEvent.change(screen.getAllByTestId('product-price-input')[0], { target: { value: '900' } })
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(inserts()).toHaveLength(1)
    expect(payloadHasStock(inserts()[0].payload)).toBe(false)
    expect(a1Calls(h.state)).toHaveLength(0)
    expect(onCreated.mock.calls[0][0].stock_quantity).toBe(0)
    expect(h.state.stock.get(onCreated.mock.calls[0][0].id)).toBe(0)
  })

  it('T6 · quick-create desde Gastos/factura: mismo contrato (nace 0, sin RPC), aun con un borrador que traía stock', async () => {
    // Un borrador viejo con stock no puede colarse fuera de Inventario.
    localStorage.setItem('draft_product_77777777-7777-4777-8777-777777777777_u1', JSON.stringify({ form: { name: 'Borrador', stock_quantity: '9', register_stock: true }, savedAt: '2026-09-01T00:00:00Z' }))
    const onCreated = vi.fn()
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={onCreated} registerStock={false} sourceType="supplier_invoice" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restaurar borrador' }))
    fireEvent.change(screen.getAllByTestId('product-price-input')[0], { target: { value: '100' } })
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(payloadHasStock(inserts()[0].payload)).toBe(false)
    expect(a1Calls(h.state)).toHaveLength(0)
  })

  it('stock inicial pendiente: el producto NO se borra y el retry reusa initial-stock:<id> sin crear otro', async () => {
    let falla = true
    h.state.rpcOverride = () => (falla ? { data: null, error: { message: 'TypeError: Failed to fetch' } } : undefined)
    const onCreated = vi.fn()
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={onCreated} registerStock />)
    completarAlta()
    fireEvent.change(screen.getByTestId('product-stock-input'), { target: { value: '4' } })
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await screen.findByText(/el stock inicial no se confirmó/)
    expect(h.state.ops.filter((o: any) => o.table === 'inventory' && o.kind === 'delete')).toHaveLength(0)
    expect(screen.getByTestId('product-form-save-button')).toHaveTextContent('Reintentar stock inicial')
    expect(onCreated).not.toHaveBeenCalled()

    falla = false
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(inserts()).toHaveLength(1) // no se creó otro producto
    const productId = onCreated.mock.calls[0][0].id
    expect(a1Calls(h.state).map((c) => c.args.p_idempotency_key)).toEqual([`initial-stock:${productId}`, `initial-stock:${productId}`])
    expect(h.state.stock.get(productId)).toBe(4)
  })
})

describe('ProductFormModal · «Con variantes» (Variants v2) oculto en beta', () => {
  it('T13 · la opción no existe en el selector de tipo', () => {
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={() => {}} registerStock />)
    const tipo = screen.getByTestId('product-form-tipo')
    expect(tipo).toHaveTextContent('Producto')
    expect(tipo).toHaveTextContent('Servicio')
    expect(tipo).not.toHaveTextContent('Con variantes')
  })

  it('T13 · initialTipo="with_variants" degrada a producto simple con aviso explícito', async () => {
    const onCreated = vi.fn()
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={onCreated} registerStock initialTipo="with_variants" />)
    expect(screen.getByTestId('product-form-notice')).toHaveTextContent('no está disponible en la beta')
    expect(screen.queryByText(/variantes? \(/i)).toBeNull()
    completarAlta()
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    // Se creó como producto simple: nada de product_variants.
    expect(h.state.ops.filter((o: any) => o.table === 'product_variants')).toHaveLength(0)
  })
})

describe('ProductFormModal · edición', () => {
  const item = {
    id: EXISTENTE, code: 'P-1', name: 'Existente', category: 'Otros', stock_quantity: 10, reserved_quantity: 0,
    min_stock: 1, sale_price: 1000, is_active: true, created_at: '', updated_at: '', tipo: 'product',
  } as any

  it('T18/T19 · sólo metadata: UPDATE sin stock_quantity y 0 RPC de stock', async () => {
    const onSaved = vi.fn()
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={() => {}} onSaved={onSaved} editItem={item} />)
    await waitFor(() => expect(screen.getByTestId('product-name-input')).toHaveValue('Existente'))
    fireEvent.change(screen.getByTestId('product-name-input'), { target: { value: 'Existente v2' } })
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(updates()).toHaveLength(1)
    expect(updates()[0].payload).toMatchObject({ name: 'Existente v2' })
    expect(payloadHasStock(updates()[0].payload)).toBe(false)
    expect(a1Calls(h.state)).toHaveLength(0)
    expect(onSaved.mock.calls[0][0].stock_quantity).toBe(10)
  })

  it('T1 · cambio de stock: metadata sin stock + manual target/expected', async () => {
    h.state.stock.set(EXISTENTE, 10)
    const onSaved = vi.fn()
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={() => {}} onSaved={onSaved} editItem={item} />)
    await waitFor(() => expect(screen.getByTestId('product-stock-input')).toHaveValue(10))
    fireEvent.change(screen.getByTestId('product-stock-input'), { target: { value: '14' } })
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(payloadHasStock(updates()[0].payload)).toBe(false)
    expect(a1Calls(h.state)).toHaveLength(1)
    expect(a1Calls(h.state)[0].args).toMatchObject({
      p_source: 'manual', p_items: [{ inventory_id: EXISTENTE, target: 14, expected: 10 }], p_reason: 'Edición de producto',
    })
    expect(a1Calls(h.state)[0].args.p_idempotency_key).toMatch(new RegExp(`^manual-stock:${EXISTENTE}:[0-9a-f-]+:10:14$`))
    expect(h.state.stock.get(EXISTENTE)).toBe(14)
    expect(onSaved.mock.calls[0][0].stock_quantity).toBe(14)
  })

  it('T2 · stale: guarda metadata, NO pisa el stock, informa y refresca el valor real', async () => {
    h.state.stock.set(EXISTENTE, 8) // una venta: el usuario abrió viendo 10
    const onSaved = vi.fn()
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={() => {}} onSaved={onSaved} editItem={item} />)
    await waitFor(() => expect(screen.getByTestId('product-stock-input')).toHaveValue(10))
    fireEvent.change(screen.getByTestId('product-stock-input'), { target: { value: '14' } })
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await screen.findByTestId('product-form-notice')
    expect(screen.getByTestId('product-form-notice')).toHaveTextContent('el stock NO se modificó: pasó de 10 a 8')
    expect(h.state.stock.get(EXISTENTE)).toBe(8)
    expect(h.state.movements).toHaveLength(0)
    expect(onSaved).not.toHaveBeenCalled() // no afirma una actualización
    expect(updates()).toHaveLength(1)       // la metadata sí se guardó
    expect(screen.getByTestId('product-stock-input')).toHaveValue(8)

    // Confirmar de nuevo es una intención NUEVA sobre el valor real (expected 8).
    fireEvent.change(screen.getByTestId('product-stock-input'), { target: { value: '14' } })
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(a1Calls(h.state)[1].args.p_items).toEqual([{ inventory_id: EXISTENTE, target: 14, expected: 8 }])
    expect(a1Calls(h.state)[1].args.p_idempotency_key).not.toBe(a1Calls(h.state)[0].args.p_idempotency_key)
    expect(h.state.stock.get(EXISTENTE)).toBe(14)
  })

  it('stock no entero en edición: no guarda nada', async () => {
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={() => {}} onSaved={() => {}} editItem={item} />)
    await waitFor(() => expect(screen.getByTestId('product-stock-input')).toHaveValue(10))
    fireEvent.change(screen.getByTestId('product-stock-input'), { target: { value: '2.5' } })
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await screen.findByText('El stock tiene que ser un número entero.')
    expect(updates()).toHaveLength(0)
    expect(a1Calls(h.state)).toHaveLength(0)
  })
})
