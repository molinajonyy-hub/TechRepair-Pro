// ─────────────────────────────────────────────────────────────────────────────
// G2-C.3A2 — página Inventario sobre la autoridad canónica de stock.
//
//   T7  duplicar (stock 15, y padre con variante legacy) → copias en 0, sin RPC.
//   T13 el menú «Nuevo producto» no ofrece «Producto con variantes».
//   T14 el «Agregar variante» legacy sigue vivo: crea el hijo sin stock.
//   T20 stock negativo existente se muestra con su valor y como «Agotado».
//   Export → «Stock actual» + snapshot «Stock esperado».
//   Import (integrado) → metadata sin stock; existentes por `import`, nuevos
//   INSERT en 0 + `initial_stock`; archivo viejo sin esperado no toca stock;
//   retry del mismo intento no duplica productos ni stock.
//
// Bordes mockeados: useInventory (writers espiados), supabase (fake A1),
// Excel, contextos y StockRepairTool.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { newFakeState, resetFakeState, a1Calls, inventoryWrites, payloadHasStock } from './fakes/supabaseStockFake'

const BIZ = '77777777-7777-4777-8777-777777777777'

const h = vi.hoisted(() => ({
  state: null as any,
  items: [] as any[],
  addItem: null as any,
  updateItem: null as any,
  exported: null as any,
  importProps: null as any,
  costs: null as null | Map<string, { cost_price: number | null; cost_price_usd: number | null }>,
}))

vi.mock('../../src/lib/supabase', async () => {
  const fake = await import('./fakes/supabaseStockFake')
  h.state = h.state ?? fake.newFakeState()
  return { supabase: fake.makeSupabaseFake(h.state) }
})
vi.mock('../../src/hooks/useInventory', () => ({
  useInventory: () => ({
    items: h.items, categories: [], error: null, loading: false,
    refresh: vi.fn(async () => {}), addItem: h.addItem, updateItem: h.updateItem, deleteItem: vi.fn(),
  }),
}))
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: '77777777-7777-4777-8777-777777777777', user: { id: 'u1' } }),
}))
vi.mock('../../src/contexts/LoadingContext', () => ({
  useLoading: () => ({ showLoading: () => {}, hideLoading: () => {} }),
}))
vi.mock('../../src/services/currencyService', () => ({
  currencyService: { getBusinessSettings: vi.fn(async () => null), getCurrentExchangeRate: vi.fn(async () => 1000) },
}))
vi.mock('../../src/components/inventory/StockRepairTool', () => ({ StockRepairTool: () => null }))
vi.mock('../../src/services/excelService', () => ({
  ExcelService: {
    exportToExcel: vi.fn(async (data: unknown) => { h.exported = data }),
    createTemplate: vi.fn(async () => {}),
    importFromExcel: vi.fn(),
    normalizeData: (d: unknown[]) => d,
  },
}))
vi.mock('../../src/components/ModalImportExcel', () => ({
  ModalImportExcel: (props: any) => { h.importProps = props; return null },
}))
vi.mock('../../src/services/dollarRateService', () => ({
  getCurrentDollarRate: vi.fn(async () => null),
  refreshDollarRate: vi.fn(async () => null),
}))
vi.mock('../../src/services/inventoryCostAccess', async (orig) => ({
  ...(await orig<typeof import('../../src/services/inventoryCostAccess')>()),
  fetchInventoryCosts: vi.fn(async () => ({ costs: h.costs ?? new Map(), authorized: !!h.costs })),
  hasInventoryCostAuthority: vi.fn(async () => !!h.costs),
}))

import { Inventory } from '../../src/pages/Inventory'

const S = '55555555-5555-4555-8555-555555555555'
const P = '66666666-6666-4666-8666-666666666666'
const V = '88888888-8888-4888-8888-888888888888'
const N = '99999999-9999-4999-8999-999999999999'

const base = (over: Record<string, unknown>) => ({
  code: 'X', name: 'X', category: 'Pantallas', description: '', stock: 0, stock_quantity: 0, reserved_quantity: 0,
  min_stock: 1, sale_price: 1000, is_active: true, created_at: '', updated_at: '', tipo: 'product',
  base_currency: 'ARS', base_price: 1000, exchange_rate_used: 0, business_id: BIZ, ...over,
})

let seq = 0
beforeEach(() => {
  if (!h.state) h.state = newFakeState()
  resetFakeState(h.state)
  seq = 0
  h.exported = null
  h.importProps = null
  h.costs = null
  h.addItem = vi.fn(async (payload: any) => {
    if (payload && ('stock' in payload || 'stock_quantity' in payload)) throw Object.assign(new Error('STOCK_FIELDS_NOT_ALLOWED'), { code: 'STOCK_FIELDS_NOT_ALLOWED' })
    seq++
    return { ...payload, id: `aaaaaaaa-0000-4000-8000-${String(seq).padStart(12, '0')}`, stock_quantity: 0 }
  })
  h.updateItem = vi.fn(async () => {})
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('confirm', vi.fn(() => true))
})

describe('Inventario · duplicar = definición, nunca existencia física', () => {
  it('T7 · producto simple con stock 15 → la copia nace en 0, sin RPC de stock', async () => {
    h.items = [base({ id: S, code: 'SCR-1', name: 'Pantalla 13', stock: 15, stock_quantity: 15 })]
    render(<Inventory />)
    fireEvent.click(await screen.findByTitle('Duplicar'))
    await waitFor(() => expect(h.addItem).toHaveBeenCalledTimes(1))
    const payload = h.addItem.mock.calls[0][0]
    expect(payload).not.toHaveProperty('stock')
    expect(payload).not.toHaveProperty('stock_quantity')
    expect(payload).toMatchObject({ name: 'Pantalla 13 (copia)', code: 'SCR-1-COPY', sale_price: 1000 })
    // SEC-08B: sin autoridad de costo la copia nace «sin costo cargado» (0),
    // nunca con cost_price ausente (NOT NULL → la copia fallaba).
    expect(payload).toMatchObject({ cost_price: 0, cost_price_usd: 0 })
    expect(a1Calls(h.state)).toHaveLength(0)
    expect(h.state.movements).toHaveLength(0)
  })

  it('T7 · con autoridad de costo, la copia lleva el costo real (vista autorizada) y stock 0', async () => {
    h.costs = new Map([[S, { cost_price: 28000, cost_price_usd: 50 }]])
    h.items = [base({ id: S, code: 'SCR-1', name: 'Pantalla 13', stock: 15, stock_quantity: 15 })]
    render(<Inventory />)
    fireEvent.click(await screen.findByTitle('Duplicar'))
    await waitFor(() => expect(h.addItem).toHaveBeenCalledTimes(1))
    const payload = h.addItem.mock.calls[0][0]
    expect(payload).toMatchObject({ cost_price: 28000, cost_price_usd: 50 })
    expect(payload).not.toHaveProperty('stock_quantity')
    expect(a1Calls(h.state)).toHaveLength(0)
  })

  it('T7 · padre con variante legacy (15) → padre e hijo copiados en 0', async () => {
    h.items = [
      base({ id: P, code: 'FUN', name: 'Funda' }),
      base({ id: V, code: 'FUN-VAR-01', name: 'Funda - Negra', subcategory: 'Negra', stock: 15, stock_quantity: 15, supplier_code: `variant_parent:${P}` }),
    ]
    render(<Inventory />)
    fireEvent.click((await screen.findAllByTitle('Duplicar'))[0])
    await waitFor(() => expect(h.addItem).toHaveBeenCalledTimes(2))
    for (const [payload] of h.addItem.mock.calls) {
      expect(payload).not.toHaveProperty('stock')
      expect(payload).not.toHaveProperty('stock_quantity')
    }
    expect(h.addItem.mock.calls[1][0].supplier_code).toMatch(/^variant_parent:aaaaaaaa-/)
    expect(a1Calls(h.state)).toHaveLength(0)
  })
})

describe('Inventario · variantes', () => {
  it('T13 · el menú «Nuevo producto» no ofrece «Producto con variantes»', async () => {
    h.items = []
    render(<Inventory />)
    fireEvent.click(screen.getByTestId('inventory-new-product-chevron'))
    const menu = await screen.findByTestId('inventory-new-product-dropdown')
    expect(within(menu).getByText('Producto simple')).toBeInTheDocument()
    expect(within(menu).queryByText('Producto con variantes')).toBeNull()
    expect(screen.queryByTestId('inventory-new-product-variants')).toBeNull()
  })

  it('T14 · «Agregar variante» legacy sigue vivo: crea el hijo sin stock y sin RPC', async () => {
    h.items = [base({ id: S, code: 'SCR-1', name: 'Pantalla 13', stock: 4, stock_quantity: 4 })]
    render(<Inventory />)
    fireEvent.click(await screen.findByTitle('Agregar variante'))
    fireEvent.change(await screen.findByPlaceholderText('Ej: Negro / 128GB'), { target: { value: 'Negro' } })
    fireEvent.submit(screen.getByPlaceholderText('Ej: Negro / 128GB').closest('form')!)
    await waitFor(() => expect(h.addItem).toHaveBeenCalledTimes(1))
    const payload = h.addItem.mock.calls[0][0]
    expect(payload).toMatchObject({ name: 'Pantalla 13 - Negro', supplier_code: `variant_parent:${S}` })
    expect(payload).not.toHaveProperty('stock_quantity')
    expect(a1Calls(h.state)).toHaveLength(0)
    expect(h.state.ops.filter((o: any) => o.table === 'product_variants')).toHaveLength(0)
  })
})

describe('Inventario · render de stock negativo', () => {
  it('T20 · stock -3 se muestra con su valor y como «Agotado»', async () => {
    h.items = [base({ id: N, code: 'NEG', name: 'Sobrevendido', stock: -3, stock_quantity: -3 })]
    render(<Inventory />)
    const fila = (await screen.findByText('Sobrevendido')).closest('tr')!
    expect(within(fila).getByText('-3')).toBeInTheDocument()
    expect(within(fila).getByText('Agotado')).toBeInTheDocument()
    expect(within(fila).queryByText('OK')).toBeNull()
  })
})

describe('Inventario · Excel', () => {
  it('export: «Stock actual» editable + snapshot «Stock esperado»', async () => {
    h.items = [base({ id: S, code: 'SCR-1', name: 'Pantalla 13', stock: 10, stock_quantity: 10 })]
    render(<Inventory />)
    fireEvent.click(screen.getByRole('button', { name: /Exportar/ }))
    await waitFor(() => expect(h.exported).not.toBeNull())
    expect(h.exported[0]).toMatchObject({ 'Código/SKU': 'SCR-1', 'Stock actual': 10, 'Stock esperado': 10 })
    // SEC-08B intacto: sin autoridad de costo, las columnas de costo no se exportan.
    expect(h.exported[0]).not.toHaveProperty('Precio de costo (ARS)')
  })

  it('import integrado: metadata sin stock, existentes por import, nuevos en 0 + initial_stock, archivo viejo intacto, retry sin duplicar', async () => {
    const EX = '12121212-1212-4212-8212-121212121212'
    const OLD = '13131313-1313-4313-8313-131313131313'
    h.items = []
    h.state.stock.set(EX, 10)
    h.state.stock.set(OLD, 4)
    h.state.selectData = (op: any) => {
      if (op.table !== 'inventory' || op.kind !== 'select' || !op.maybe) return undefined
      const code = op.filters.find((f: any) => f[1] === 'code')?.[2]
      return code === 'EX' ? { id: EX } : code === 'OLD' ? { id: OLD } : null
    }
    // La primera llamada del lote de nuevos se pierde en la red.
    let caida = true
    h.state.rpcOverride = (_fn: string, args: any) => {
      if (caida && args.p_source === 'initial_stock') { caida = false; return { data: null, error: { message: 'TypeError: Failed to fetch' } } }
      return undefined
    }
    render(<Inventory />)
    await waitFor(() => expect(h.importProps).not.toBeNull())

    const rows = [
      { 'Código/SKU': 'EX', 'Nombre del producto': 'Existente', 'Stock actual': 7, 'Stock esperado': 10 },
      { 'Código/SKU': 'NEW', 'Nombre del producto': 'Nuevo', 'Stock actual': 8 },
      { 'Código/SKU': 'OLD', 'Nombre del producto': 'Viejo', 'Stock actual': 99 }, // archivo viejo: sin esperado
    ]
    await expect(h.importProps.onImport(rows, { attemptId: 'att-ui' })).rejects.toMatchObject({ retryable: true })
    const res = await h.importProps.onImport(rows, { attemptId: 'att-ui' })

    // Metadata: nunca stock.
    for (const w of inventoryWrites(h.state)) expect(payloadHasStock(w.payload)).toBe(false)
    // El producto nuevo se insertó UNA sola vez (el retry lo reconoce como creado por este intento).
    const inserts = inventoryWrites(h.state).filter((o) => o.kind === 'insert')
    expect(inserts).toHaveLength(1)
    // Stock: existentes por import (expected del archivo), nuevo por initial_stock; mismas claves en el retry.
    expect(a1Calls(h.state).map((c) => [c.args.p_source, c.args.p_idempotency_key])).toEqual([
      ['import', 'g2c3a2-import-existing:att-ui:0'],
      ['initial_stock', 'g2c3a2-import-created:att-ui:0'],
      ['import', 'g2c3a2-import-existing:att-ui:0'],
      ['initial_stock', 'g2c3a2-import-created:att-ui:0'],
    ])
    expect(a1Calls(h.state)[0].args.p_items).toEqual([{ inventory_id: EX, target: 7, expected: 10 }])
    expect(h.state.stock.get(EX)).toBe(7)
    expect(h.state.stock.get(OLD)).toBe(4) // intacto
    const newId = a1Calls(h.state)[3].args.p_items[0].inventory_id
    expect(h.state.stock.get(newId)).toBe(8)
    expect(h.state.movements).toHaveLength(2)
    expect(res).toMatchObject({ created: 1, updated: 2 })
    expect(res.details).toEqual(['1 stock actualizado', '1 producto nuevo con stock inicial'])
    expect(res.warnings.join(' ')).toMatch(/1 producto existente sin «Stock esperado»/)
  })
})
