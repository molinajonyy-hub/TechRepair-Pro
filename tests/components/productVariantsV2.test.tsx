import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { a1Calls, inventoryWrites, makeSupabaseFake, newFakeState, payloadHasStock, resetFakeState } from './fakes/supabaseStockFake'

const h = vi.hoisted(() => ({ state: null as ReturnType<typeof newFakeState> | null }))
vi.mock('../../src/lib/supabase', async () => {
  const fake = await import('./fakes/supabaseStockFake')
  h.state = fake.newFakeState()
  return { supabase: fake.makeSupabaseFake(h.state) }
})
vi.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ businessId: '77777777-7777-4777-8777-777777777777', user: { id: 'u1' } }) }))
vi.mock('../../src/services/dollarRateService', () => ({ getCurrentDollarRate: vi.fn(async () => null), refreshDollarRate: vi.fn(async () => null) }))
vi.mock('../../src/services/inventoryCostAccess', async orig => ({
  ...(await orig<typeof import('../../src/services/inventoryCostAccess')>()),
  attachInventoryCosts: vi.fn(async rows => rows),
  hasInventoryCostAuthority: vi.fn(async () => true),
  fetchInventoryCosts: vi.fn(async () => ({ costs: new Map(), authorized: true })),
}))

import { supabase } from '../../src/lib/supabase'
import { productService, VariantInitialStockPendingError, validateVariantInputs, type CreateProductInput, type CreateVariantInput } from '../../src/services/productService'
import { ProductFormModal } from '../../src/components/products/ProductFormModal'
import { VariantSelector } from '../../src/components/products/VariantSelector'
import { isSellableProduct } from '../../src/lib/productSellability'

const BIZ = '77777777-7777-4777-8777-777777777777'
const base: Omit<CreateProductInput, 'tipo'> = { business_id: BIZ, created_by: 'u1', name: 'Funda Silicone iPhone 15', base_currency: 'ARS', base_price: 5000, sale_price: 5000, cost_price: 1000 }
const variant = (name: string, stock = 0): CreateVariantInput => ({ business_id: BIZ, created_by: 'u1', name, stock, cost_currency: 'ARS', sale_price_ars: 5000, cost_price_ars: 1000, wholesale_price_ars: 4000, min_stock: 1, location: 'A3' })
const state = () => h.state!
const inserts = () => inventoryWrites(state()).filter(op => op.kind === 'insert')
beforeEach(() => { resetFakeState(state()); localStorage.clear(); sessionStorage.clear() })

describe('PRODUCT-VARIANTS-1 · service contracts', () => {
  it('creates one grouping parent and three independent sellable children; stock only by A1', async () => {
    const result = await productService.createProductWithVariants(base, [variant('Negro', 3), variant('Azul', 5), variant('Rosa', 2)])
    expect(inserts()).toHaveLength(4)
    expect(inserts()[0].payload).toMatchObject({ has_variants: true, parent_id: null, auto_update_price: false })
    expect(result.product.stock_quantity).toBe(0)
    expect(isSellableProduct(result.product)).toBe(false)
    expect(state().stock.get(result.product.id)).toBe(0)
    for (const v of result.variants) {
      expect(v.product_id).toBe(result.product.id)
      const child = state().rows.get('inventory')!.get(v.inventory_item_id!)!
      expect(child).toMatchObject({ parent_id: result.product.id, has_variants: false, min_stock: 1, location: 'A3', wholesale_price_ars: 4000 })
      expect(isSellableProduct(child)).toBe(true)
      expect(v.stock).toBe(0)
    }
    expect(a1Calls(state())[0].args.p_items).toEqual(result.variants.map((v, i) => ({ inventory_id: v.inventory_item_id, delta: [3, 5, 2][i] })))
    expect(state().movements.map(m => m.inventory_id)).not.toContain(result.product.id)
    for (const op of inventoryWrites(state())) expect(payloadHasStock(op.payload)).toBe(false)
    expect(state().ops.filter(op => op.table === 'inventory_movements')).toHaveLength(0)
  })

  it('lost response after server applied: same key and same items; retry does not recreate or double stock', async () => {
    const rpc = supabase.rpc.bind(supabase)
    vi.spyOn(supabase, 'rpc').mockImplementationOnce(async (...args) => { await rpc(...args); throw new Error('response lost') })
    let pending: VariantInitialStockPendingError | undefined
    try { await productService.createProductWithVariants(base, [variant('Negro', 5), variant('Azul', 2)]) }
    catch (err) { if (err instanceof VariantInitialStockPendingError) pending = err; else throw err }
    expect(pending).toBeInstanceOf(VariantInitialStockPendingError)
    expect(state().movements).toHaveLength(2)
    expect(state().ops.filter(op => op.kind === 'delete')).toHaveLength(0)
    await productService.retryVariantInitialStock(pending!.recovery)
    await productService.retryVariantInitialStock(pending!.recovery)
    expect(inserts()).toHaveLength(3)
    expect(state().movements).toHaveLength(2)
    expect(a1Calls(state()).map(call => call.args)).toEqual([a1Calls(state())[0].args, a1Calls(state())[0].args, a1Calls(state())[0].args])
    expect(state().stock.get(pending!.recovery.variants[0].inventory_item_id!)).toBe(5)
  })

  it('metadata failure cleans only this unstocked attempt and never tries A1', async () => {
    let count = 0
    state().writeError = op => op.table === 'product_variants' && op.kind === 'insert' && ++count === 2 ? { message: 'metadata failure' } : null
    await expect(productService.createProductWithVariants(base, [variant('Negro', 5), variant('Azul', 2)])).rejects.toThrow('metadata failure')
    expect(a1Calls(state())).toHaveLength(0)
    expect(state().rows.get('inventory')?.size).toBe(0)
    expect(state().rows.get('product_variants')?.size).toBe(0)
  })

  it('pre-stock cleanup falls back to scoped soft deactivation when delete is restricted', async () => {
    state().writeError = op => op.kind === 'delete' ? { message: 'permission denied' }
      : op.table === 'product_variants' && op.kind === 'insert' ? { message: 'metadata failure' } : null
    await expect(productService.createProductWithVariants(base, [variant('Negro', 5)])).rejects.toThrow('metadata failure')
    expect([...state().rows.get('inventory')!.values()].every(row => row.is_active === false)).toBe(true)
    expect(a1Calls(state())).toHaveLength(0)
  })

  it('adding a child later retries only its same initial batch after an ambiguous failure', async () => {
    const family = await productService.createProductWithVariants(base, [variant('Negro', 2)])
    state().rpcOverride = fn => fn.includes('stock_adjustments') ? { data: null, error: { message: 'network' } } : undefined
    let pending: VariantInitialStockPendingError | undefined
    try { await productService.addVariantWithInitialStock(family.product, variant('Azul', 4)) }
    catch (error) { if (error instanceof VariantInitialStockPendingError) pending = error; else throw error }
    expect(pending).toBeDefined()
    const created = inserts().length
    state().rpcOverride = undefined
    await productService.retryVariantInitialStock(pending!.recovery)
    await productService.retryVariantInitialStock(pending!.recovery)
    expect(inserts()).toHaveLength(created)
    expect(state().stock.get(pending!.recovery.variants[0].inventory_item_id!)).toBe(4)
    expect(state().stock.get(family.variants[0].inventory_item_id!)).toBe(2)
  })

  it.each([
    ['duplicate SKU', [variant('Negro'), { ...variant('Azul'), sku: 'S' }, { ...variant('Rosa'), sku: 'S' }]],
    ['blank name', [{ ...variant(''), name: ' ' }]],
    ['duplicate names', [variant('Negro'), variant('Negro')]],
    ['fractional stock', [variant('Negro', 1.5)]],
    ['negative stock', [variant('Negro', -1)]],
    ['negative price', [{ ...variant('Negro'), sale_price_ars: -1 }]],
    ['invalid USD', [{ ...variant('Negro'), cost_currency: 'USD' as const }]],
    ['duplicate barcode', [{ ...variant('Negro'), barcode: '123' }, { ...variant('Azul'), barcode: '123' }]],
    ['oversized family', Array.from({ length: 101 }, (_, i) => variant(String(i)))],
  ])('%s fails before creating metadata', async (_label, variants) => {
    await expect(productService.createProductWithVariants(base, variants)).rejects.toThrow()
    expect(inserts()).toHaveLength(0)
  })

  it('database duplicate SKU fails cleanly, without a stocked orphan', async () => {
    state().writeError = op => op.table === 'inventory' && op.kind === 'insert' && (op.payload as { code?: string }).code === 'TAKEN' ? { message: 'unique code', code: '23505' } : null
    await expect(productService.createProductWithVariants(base, [{ ...variant('Negro', 3), sku: 'TAKEN' }])).rejects.toThrow('SKU')
    expect(state().rows.get('inventory')?.size).toBe(0)
    expect(a1Calls(state())).toHaveLength(0)
  })

  it('a missing / unmarked parent cannot create an orphan child', async () => {
    await expect(productService.createVariant('missing-parent', variant('Negro'))).rejects.toThrow('agrupador')
    const simple = await productService.createProduct({ ...base, tipo: 'product' })
    await expect(productService.createVariant(simple.id, variant('Negro'))).rejects.toThrow('agrupador')
    expect(inserts()).toHaveLength(1)
  })

  it('USD children keep sale reference, exchange rate and automatic repricing; parent does not reprice', async () => {
    const usd = { ...variant('OLED', 2), cost_currency: 'USD' as const, cost_price_usd: 10, sale_price_usd: 25, sale_price_ars: 25000, cost_price_ars: 10000, exchange_rate_used: 1000, auto_update_price: true }
    const result = await productService.createProductWithVariants({ ...base, base_currency: 'USD', base_price: 25, sale_price: 25000, cost_price_usd: 10, exchange_rate_used: 1000, auto_update_price: true }, [usd])
    expect(inserts()[1].payload).toMatchObject({ base_price: 25, base_currency: 'USD', cost_price_usd: 10, auto_update_price: true, linked_to_dolar: true, exchange_rate_used: 1000 })
    expect(result.product.auto_update_price).toBe(false)
  })

  it('editing a variant changes metadata and price, never stock; adding later and toggling active stay linked', async () => {
    const family = await productService.createProductWithVariants(base, [variant('Negro', 3)])
    const id = family.variants[0].inventory_item_id!
    const before = a1Calls(state()).length
    await productService.updateProduct(id, { variant_name: 'Negro mate', sale_price: 6000 }, BIZ)
    const extra = await productService.createVariant(family.product.id, variant('Azul'))
    expect(extra.product_id).toBe(family.product.id)
    expect(extra.inventory_item_id).toBeTruthy()
    await productService.deactivateVariant(family.variants[0].id, BIZ)
    expect((await productService.getVariants(family.product.id, BIZ)).map(v => v.inventory_item_id)).not.toContain(id)
    await productService.setVariantActive(id, true, BIZ)
    const variants = await productService.getVariants(family.product.id, BIZ)
    expect(variants.find(v => v.inventory_item_id === id)).toMatchObject({ name: 'Negro mate', sale_price_ars: 6000, stock_quantity: 3 })
    expect(a1Calls(state())).toHaveLength(before)
  })

  it('legacy product_variants.stock is ignored, linked inventory decides; orphan metadata is omitted', async () => {
    const family = await productService.createProductWithVariants(base, [variant('Negro', 2)])
    const meta = state().rows.get('product_variants')!.get(family.variants[0].id)!
    meta.stock = 999
    const rows = await productService.getVariants(family.product.id, BIZ)
    expect(rows[0].stock_quantity).toBe(2)
    expect(rows[0].stock).toBe(0)
    meta.inventory_item_id = null
    expect(await productService.getVariants(family.product.id, BIZ)).toEqual([])
  })

  it('deactivation preserves rows and history; no destructive delete after creation', async () => {
    const family = await productService.createProductWithVariants(base, [variant('Negro', 2)])
    const another = await productService.createProductWithVariants({ ...base, name: 'Otra familia' }, [variant('Verde', 1)])
    await productService.deactivateFamily(family.product.id, BIZ)
    expect(state().rows.get('inventory')!.get(another.product.id)!.is_active).toBe(true)
    expect(state().rows.get('inventory')!.size).toBe(4)
    expect(state().movements).toHaveLength(2)
    expect(state().ops.filter(op => op.kind === 'delete')).toHaveLength(0)
  })
})

describe('PRODUCT-VARIANTS-1 · form and selector', () => {
  const fill = () => {
    fireEvent.change(screen.getByTestId('product-name-input'), { target: { value: base.name } })
    fireEvent.change(screen.getByTestId('variant-name-input'), { target: { value: 'Negro' } })
    fireEvent.change(screen.getByTestId('variant-stock-input'), { target: { value: '5' } })
  }
  it('double submit creates one family and one stock batch', async () => {
    const onCreated = vi.fn()
    render(<ProductFormModal isOpen onCreated={onCreated} onClose={() => {}} initialTipo="with_variants" registerStock />)
    fill()
    const form = screen.getByTestId('variant-name-input').closest('form')!
    fireEvent.submit(form); fireEvent.submit(form)
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(inserts()).toHaveLength(2)
    expect(a1Calls(state())).toHaveLength(1)
  })
  it('stock pending retry freezes metadata and survives reopening without another family', async () => {
    const onCreated = vi.fn()
    state().rpcOverride = fn => fn.includes('stock_adjustments') ? { data: null, error: { message: 'network' } } : undefined
    const first = render(<ProductFormModal isOpen onCreated={onCreated} onClose={() => {}} initialTipo="with_variants" registerStock />)
    fill(); fireEvent.click(screen.getByTestId('product-form-save-button'))
    await screen.findByText(/Reintentar no duplica el producto/)
    expect(screen.getByTestId('variant-name-input')).toBeDisabled()
    first.unmount()
    render(<ProductFormModal isOpen onCreated={onCreated} onClose={() => {}} registerStock />)
    await screen.findByText(/Reintentar no duplica el producto/)
    expect((screen.getByTestId('variant-name-input') as HTMLInputElement).value).toBe('Negro')
    state().rpcOverride = undefined
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(inserts()).toHaveLength(2)
    expect(a1Calls(state())[1].args).toEqual(a1Calls(state())[0].args)
    expect(sessionStorage.length).toBe(0)
  })
  it('grouping parent edit has no stock adjustment control', () => {
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={() => {}} editItem={{ ...base, id: 'parent', code: 'F', has_variants: true, stock_quantity: 0, is_active: true, min_stock: 0, reserved_quantity: 0, category: 'Otros', created_at: '', updated_at: '' }} />)
    expect(screen.queryByTestId('product-stock-input')).toBeNull()
  })
  it('selector uses inventory balance even when compatibility metadata claims stock', async () => {
    const family = await productService.createProductWithVariants(base, [variant('Negro', 2)])
    state().rows.get('product_variants')!.get(family.variants[0].id)!.stock = 999
    const onSelect = vi.fn()
    render(<VariantSelector isOpen productId={family.product.id} productName={base.name} businessId={BIZ} onClose={() => {}} onSelect={onSelect} />)
    expect(await screen.findByText('2 en stock')).toBeInTheDocument()
    expect(screen.queryByText(/999/)).toBeNull()
    fireEvent.click(screen.getByTestId('variant-selector-option'))
    expect(onSelect.mock.calls[0][1]).toBe(family.variants[0].inventory_item_id)
  })
  it('inheritance fills blanks while individual changes survive', () => {
    validateVariantInputs([variant('Negro')])
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={() => {}} initialTipo="with_variants" registerStock />)
    fireEvent.change(screen.getAllByTestId('product-price-input')[0], { target: { value: '5000' } })
    fireEvent.change(screen.getByTestId('variant-price-input'), { target: { value: '6000' } })
    fireEvent.click(screen.getByTitle('Completa valores sin reemplazar los que ya editaste'))
    expect(screen.getByTestId('variant-price-input')).toHaveValue('6000')
  })
  it('a USD override inherits the ARS base cost by conversion and retains its own rate and sale reference', async () => {
    const onCreated = vi.fn()
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={onCreated} initialTipo="with_variants" registerStock />)
    fill()
    fireEvent.change(screen.getByTestId('product-cost-input'), { target: { value: '2000' } })
    fireEvent.change(screen.getByLabelText('Moneda de variante'), { target: { value: 'USD' } })
    fireEvent.change(screen.getByLabelText('Cotización de variante'), { target: { value: '1000' } })
    fireEvent.change(screen.getByTestId('variant-price-input'), { target: { value: '5000' } })
    fireEvent.change(screen.getByLabelText('Stock mínimo base'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Ubicación base'), { target: { value: 'A3' } })
    fireEvent.click(screen.getByTestId('product-form-save-button'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(inserts()[1].payload).toMatchObject({ base_currency: 'USD', cost_price: 2000, cost_price_usd: 2,
      base_price: 5, sale_price: 5000, exchange_rate_used: 1000, min_stock: 3, location: 'A3' })
  })
})
