// ─────────────────────────────────────────────────────────────────────────────
// G2-C.3A2 — adapter único de la autoridad canónica de stock + useInventory.
//
//   T1  ajuste manual target/expected → la RPC canónica, source manual.
//   T2  stale → no se afirma actualización; el stock del servidor queda igual.
//   T19 la edición de metadata no lleva stock_quantity (fail-closed).
//   T20 (hook) stock negativo cuenta como agotado.
//   + el adapter exige tenant y clave, preserva code/message/details, y nunca
//     toca tablas.
//
// Borde mockeado: src/lib/supabase (fake con A1 en memoria).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { newFakeState, resetFakeState, a1Calls, inventoryWrites } from './fakes/supabaseStockFake'

const h = vi.hoisted(() => ({ state: null as any }))

vi.mock('../../src/lib/supabase', async () => {
  const fake = await import('./fakes/supabaseStockFake')
  h.state = h.state ?? fake.newFakeState()
  return { supabase: fake.makeSupabaseFake(h.state) }
})
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: BIZ, user: { id: 'u1' } }),
}))
vi.mock('../../src/hooks/useAppWakeUp', () => ({ useRefreshOnWakeUp: () => {} }))

const BIZ = '77777777-7777-4777-8777-777777777777'
const P1 = '11111111-1111-4111-8111-111111111111'

import {
  applyInventoryStockAdjustments,
  inventoryStockAdjustmentService,
  initialStockKey,
  manualStockKey,
  importStockKey,
  assertNoStockFields,
  withoutStockFields,
  StockAdjustmentError,
  StockFieldWriteError,
} from '../../src/services/inventoryStockAdjustmentService'
import { useInventory } from '../../src/hooks/useInventory'

beforeEach(() => {
  if (!h.state) h.state = newFakeState()
  resetFakeState(h.state)
})

describe('adapter · applyInventoryStockAdjustments', () => {
  it('T1 · manual target/expected va por la RPC canónica, source manual, con la clave', async () => {
    h.state.stock.set(P1, 20)
    const r = await inventoryStockAdjustmentService.applyManualTarget({
      businessId: BIZ, inventoryId: P1, target: 25, expected: 20,
      idempotencyKey: manualStockKey(P1, 'sess-1', 20, 25), reason: 'Edición de producto',
    })
    expect(a1Calls(h.state)).toHaveLength(1)
    expect(a1Calls(h.state)[0].args).toEqual({
      p_business_id: BIZ,
      p_items: [{ inventory_id: P1, target: 25, expected: 20 }],
      p_source: 'manual',
      p_reason: 'Edición de producto',
      p_idempotency_key: `manual-stock:${P1}:sess-1:20:25`,
    })
    expect(r.status).toBe('applied')
    expect(r.new_stock).toBe(25)
    // El adapter no toca tablas: ni inventory ni inventory_movements.
    expect(h.state.ops).toHaveLength(0)
  })

  it('T2 · stale: no se afirma actualización y el stock real no se pisa', async () => {
    h.state.stock.set(P1, 18) // una venta bajó el stock después de que el usuario vio 20
    const r = await inventoryStockAdjustmentService.applyManualTarget({
      businessId: BIZ, inventoryId: P1, target: 25, expected: 20, idempotencyKey: 'k-stale',
    })
    expect(r.status).toBe('stale')
    expect(r.current_stock).toBe(18)
    expect(r.new_stock).toBe(18)
    expect(r.movement_id).toBeNull()
    expect(h.state.stock.get(P1)).toBe(18)
    expect(h.state.movements).toHaveLength(0)
  })

  it('exige negocio y clave de idempotencia ANTES de llamar a la RPC', async () => {
    await expect(applyInventoryStockAdjustments({ businessId: '', source: 'manual', items: [{ inventory_id: P1, delta: 1 }], idempotencyKey: 'k' }))
      .rejects.toMatchObject({ label: 'STOCK_ADJUSTMENT_BUSINESS_REQUIRED' })
    await expect(applyInventoryStockAdjustments({ businessId: BIZ, source: 'manual', items: [{ inventory_id: P1, delta: 1 }], idempotencyKey: '  ' }))
      .rejects.toMatchObject({ label: 'STOCK_ADJUSTMENT_INVALID_IDEMPOTENCY_KEY' })
    await expect(applyInventoryStockAdjustments({ businessId: BIZ, source: 'manual', items: [], idempotencyKey: 'k' }))
      .rejects.toMatchObject({ label: 'STOCK_ADJUSTMENT_ITEMS_REQUIRED' })
    expect(a1Calls(h.state)).toHaveLength(0)
  })

  it('preserva code / message / details del servidor y distingue lo reintentable', async () => {
    h.state.rpcOverride = () => ({ data: null, error: { message: 'IDEMPOTENCY_CONFLICT: esta clave ya se uso con un ajuste distinto', code: '23505', details: 'detalle', hint: 'pista' } })
    const e1 = await applyInventoryStockAdjustments({ businessId: BIZ, source: 'manual', items: [{ inventory_id: P1, delta: 1 }], idempotencyKey: 'k' }).catch((e) => e)
    expect(e1).toBeInstanceOf(StockAdjustmentError)
    expect(e1).toMatchObject({ code: '23505', details: 'detalle', hint: 'pista', label: 'IDEMPOTENCY_CONFLICT', retryable: false })
    expect(e1.message).toMatch(/^IDEMPOTENCY_CONFLICT/)

    // Transporte caído: sin SQLSTATE → no se sabe si aplicó → reintentar con la misma clave.
    h.state.rpcOverride = () => ({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' } })
    const e2 = await applyInventoryStockAdjustments({ businessId: BIZ, source: 'manual', items: [{ inventory_id: P1, delta: 1 }], idempotencyKey: 'k' }).catch((e) => e)
    expect(e2).toMatchObject({ retryable: true })

    // Respuesta que no es el contrato A1 → tampoco se inventa un resultado.
    h.state.rpcOverride = () => ({ data: { ok: false }, error: null })
    const e3 = await applyInventoryStockAdjustments({ businessId: BIZ, source: 'manual', items: [{ inventory_id: P1, delta: 1 }], idempotencyKey: 'k' }).catch((e) => e)
    expect(e3).toMatchObject({ label: 'STOCK_ADJUSTMENT_INVALID_RESPONSE', retryable: true })
  })

  it('retry con la misma clave = replay (existing), sin mover stock dos veces', async () => {
    h.state.stock.set(P1, 0)
    const a = await inventoryStockAdjustmentService.applyInitialStock({ businessId: BIZ, inventoryId: P1, quantity: 5 })
    const b = await inventoryStockAdjustmentService.applyInitialStock({ businessId: BIZ, inventoryId: P1, quantity: 5 })
    expect(a?.status).toBe('applied')
    expect(b?.status).toBe('applied') // misma respuesta persistida
    expect(h.state.stock.get(P1)).toBe(5)
    expect(h.state.movements).toHaveLength(1)
    expect(a1Calls(h.state).map((c) => c.args.p_idempotency_key)).toEqual([initialStockKey(P1), initialStockKey(P1)])
  })

  it('stock inicial 0 no llama a la RPC', async () => {
    expect(await inventoryStockAdjustmentService.applyInitialStock({ businessId: BIZ, inventoryId: P1, quantity: 0 })).toBeNull()
    expect(a1Calls(h.state)).toHaveLength(0)
  })

  it('las claves son estables por intención', () => {
    expect(initialStockKey(P1)).toBe(`initial-stock:${P1}`)
    expect(importStockKey('existing', 'att-1', 0)).toBe('g2c3a2-import-existing:att-1:0')
    expect(importStockKey('created', 'att-1', 2)).toBe('g2c3a2-import-created:att-1:2')
    expect(manualStockKey(P1, 's', 3, -2)).toBe(`manual-stock:${P1}:s:3:-2`)
  })

  it('assertNoStockFields / withoutStockFields', () => {
    expect(() => assertNoStockFields({ name: 'x' }, 'w')).not.toThrow()
    expect(() => assertNoStockFields({ name: 'x', stock_quantity: 1 }, 'w')).toThrow(StockFieldWriteError)
    expect(() => assertNoStockFields({ stock: undefined }, 'w')).toThrow(StockFieldWriteError)
    expect(withoutStockFields({ name: 'x', stock: 3, stock_quantity: 3, min_stock: 1 })).toEqual({ name: 'x', min_stock: 1 })
  })
})

describe('useInventory · fail-closed de stock', () => {
  it('T19 · updateItem con stock_quantity falla explícito y NO escribe nada', async () => {
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    h.state.ops.length = 0
    await expect(result.current.updateItem(P1, { name: 'x', stock_quantity: 9 } as any)).rejects.toMatchObject({ code: 'STOCK_FIELDS_NOT_ALLOWED' })
    expect(inventoryWrites(h.state)).toHaveLength(0)
  })

  it('T19 · updateItem de metadata no lleva stock', async () => {
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    h.state.ops.length = 0
    await act(() => result.current.updateItem(P1, { name: 'Nuevo', min_stock: 2 }, { skipReload: true }))
    const w = inventoryWrites(h.state)
    expect(w).toHaveLength(1)
    expect(w[0].payload).toEqual({ name: 'Nuevo', min_stock: 2 })
    expect(a1Calls(h.state)).toHaveLength(0)
  })

  it('addItem con stock falla; sin stock crea en 0', async () => {
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    h.state.ops.length = 0
    await expect(result.current.addItem({ name: 'A', stock_quantity: 5 } as any)).rejects.toMatchObject({ code: 'STOCK_FIELDS_NOT_ALLOWED' })
    expect(inventoryWrites(h.state)).toHaveLength(0)
    const row = await result.current.addItem({ name: 'A', code: 'A-1' } as any, { skipReload: true })
    expect(row?.stock_quantity).toBe(0)
    expect(inventoryWrites(h.state)[0].payload).not.toHaveProperty('stock_quantity')
  })

  it('T1/T2 · adjustStock usa target/expected (sin SELECT + delta JS) y devuelve stale sin pisar', async () => {
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    h.state.ops.length = 0
    h.state.stock.set(P1, 7)
    const r = await result.current.adjustStock(P1, 12, 10, { idempotencyKey: 'k-adj' })
    expect(r.status).toBe('stale')
    expect(h.state.stock.get(P1)).toBe(7)
    expect(a1Calls(h.state)[0].args.p_items).toEqual([{ inventory_id: P1, target: 12, expected: 10 }])
    // Ningún SELECT puntual de stock para calcular un delta en JS, ni UPDATE
    // desde el navegador: sólo el refresco del listado.
    expect(h.state.ops.filter((o: any) => o.table === 'inventory' && o.columns === 'stock_quantity')).toHaveLength(0)
    expect(inventoryWrites(h.state)).toHaveLength(0)
  })

  it('T20 · stock negativo existente cuenta como agotado', async () => {
    h.state.selectData = (op: any) => (op.table === 'inventory' && op.kind === 'select'
      ? [{ id: P1, name: 'Neg', stock_quantity: -3, min_stock: 1, category: 'X' }] : undefined)
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    expect(result.current.outOfStockItems.map((i) => i.id)).toEqual([P1])
    expect(result.current.lowStockItems).toHaveLength(0)
  })
})

describe('T15 · el navegador no escribe inventory_movements', () => {
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      if (statSync(p).isDirectory()) walk(p, acc)
      else if (/\.(ts|tsx)$/.test(n)) acc.push(p)
    }
    return acc
  }
  const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('0 INSERT / UPDATE / UPSERT / DELETE de inventory_movements y 0 writers legacy en src/', () => {
    const hallazgos: string[] = []
    for (const f of walk('src')) {
      const s = sinComentarios(readFileSync(f, 'utf8'))
      if (/from\(\s*['"]inventory_movements['"]\s*\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/.test(s)) hallazgos.push(`${f}: write de inventory_movements`)
      if (/\b(registerMovement|revertMovement|manualAdjustment|increaseStockFromPurchase|decreaseStockFromSale|restoreStockFromCancelledSale|applyCreditNoteStock)\s*\(/.test(s)) hallazgos.push(`${f}: writer legacy`)
    }
    expect(hallazgos).toEqual([])
  })
})
