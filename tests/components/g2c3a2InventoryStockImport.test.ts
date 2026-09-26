// ─────────────────────────────────────────────────────────────────────────────
// G2-C.3A2 — stock del import de Excel sobre la autoridad canónica.
//
//   T8  existente: expected 10 / target 7 → lote `import` a la RPC.
//   T9  stale: el stock cambió desde el export → no se pisa, se reporta.
//   T10 archivo viejo sin «Stock esperado» → stock existente intacto + aviso.
//   T11 nuevo: target 8 → `initial_stock` delta 8 (nació en 0).
//   T12 mixto: applied / stale / noop / created / sin cambio correctos.
//   T16 retry del mismo intento → mismas claves (replay, sin doble stock).
//   T17 intento nuevo → claves nuevas.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { newFakeState, resetFakeState, a1Calls } from './fakes/supabaseStockFake'

const h = vi.hoisted(() => ({ state: null as any }))
vi.mock('../../src/lib/supabase', async () => {
  const fake = await import('./fakes/supabaseStockFake')
  h.state = h.state ?? fake.newFakeState()
  return { supabase: fake.makeSupabaseFake(h.state) }
})

import {
  planStockImport,
  applyStockImport,
  describeStockImport,
  createImportAttempt,
  type StockImportRow,
} from '../../src/services/inventoryStockImport'

const BIZ = '77777777-7777-4777-8777-777777777777'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const row = (n: number, code: string, isNew: boolean, actual: unknown, expected?: unknown): StockImportRow =>
  ({ rowNumber: n + 1, code, inventoryId: id(n), isNew, actual, expected })

async function importar(rows: StockImportRow[], attemptId = 'att-1') {
  const summary = await applyStockImport({ businessId: BIZ, attemptId, plan: planStockImport(rows) })
  return { summary, ...describeStockImport(summary) }
}

beforeEach(() => {
  if (!h.state) h.state = newFakeState()
  resetFakeState(h.state)
})

describe('import de Excel · stock por la RPC canónica', () => {
  it('T8 · existente expected 10 / target 7 → source import con target y expected del ARCHIVO', async () => {
    h.state.stock.set(id(1), 10)
    const { summary, details } = await importar([row(1, 'A', false, 7, 10)])
    expect(a1Calls(h.state)).toHaveLength(1)
    expect(a1Calls(h.state)[0].args).toMatchObject({
      p_business_id: BIZ, p_source: 'import',
      p_items: [{ inventory_id: id(1), target: 7, expected: 10 }],
      p_idempotency_key: 'g2c3a2-import-existing:att-1:0',
    })
    expect(summary.applied).toBe(1)
    expect(h.state.stock.get(id(1))).toBe(7)
    expect(details).toContain('1 stock actualizado')
  })

  it('T9 · stale: una venta después del export NO se pisa y se identifica la fila', async () => {
    h.state.stock.set(id(1), 8) // exportado en 10, se vendieron 2
    const { summary, warnings } = await importar([row(1, 'PANT-13', false, 7, 10)])
    expect(summary.applied).toBe(0)
    expect(summary.stale).toEqual([{ code: 'PANT-13', current: 8, expected: 10, target: 7 }])
    expect(h.state.stock.get(id(1))).toBe(8)
    expect(h.state.movements).toHaveLength(0)
    expect(warnings.join(' ')).toMatch(/1 stock omitido porque cambió desde la exportación: PANT-13 \(ahora 8, exportado 10\)/)
  })

  it('T10 · archivo viejo sin «Stock esperado»: stock intacto, sin RPC, con aviso', async () => {
    h.state.stock.set(id(1), 10)
    const { summary, warnings } = await importar([row(1, 'A', false, 3), row(2, 'B', false, 0, '')])
    expect(a1Calls(h.state)).toHaveLength(0)
    expect(h.state.stock.get(id(1))).toBe(10)
    expect(summary.missingExpected).toEqual(['A', 'B'])
    expect(warnings.join(' ')).toMatch(/2 productos existentes sin «Stock esperado».*se omitió para no pisar movimientos posteriores/)
  })

  it('T11 · producto nuevo target 8 → initial_stock delta 8 (sin expected)', async () => {
    const { summary, details } = await importar([row(1, 'NUEVO', true, 8)])
    expect(a1Calls(h.state)).toHaveLength(1)
    expect(a1Calls(h.state)[0].args).toMatchObject({
      p_source: 'initial_stock',
      p_items: [{ inventory_id: id(1), delta: 8 }],
      p_idempotency_key: 'g2c3a2-import-created:att-1:0',
    })
    expect(a1Calls(h.state)[0].args.p_items[0]).not.toHaveProperty('expected')
    expect(summary.createdApplied).toBe(1)
    expect(h.state.stock.get(id(1))).toBe(8)
    expect(details).toContain('1 producto nuevo con stock inicial')
  })

  it('T12 · mixto: applied / stale / sin cambio / nuevo / nuevo en 0 / inválido / repetido', async () => {
    h.state.stock.set(id(1), 10) // applied 10 → 4
    h.state.stock.set(id(2), 5)  // stale: exportado 6
    h.state.stock.set(id(3), 9)  // sin cambio: actual = esperado
    const rows = [
      row(1, 'APL', false, 4, 10),
      row(2, 'STA', false, 1, 6),
      row(3, 'SIN', false, 9, 9),
      row(4, 'NEW', true, 3),
      row(5, 'NEW0', true, 0),
      row(6, 'BAD', false, '2,5', 3),
      { ...row(1, 'APL', false, 99, 10), rowNumber: 99 }, // código repetido
    ]
    const { summary, details, warnings } = await importar(rows)
    expect(summary).toMatchObject({ applied: 1, noop: 0, createdApplied: 1, createdNoop: 0, unchanged: 1 })
    expect(summary.stale.map((s) => s.code)).toEqual(['STA'])
    expect(summary.invalid).toEqual(['fila 7 (BAD)'])
    expect(summary.duplicates).toEqual(['APL'])
    // Sólo lo que el usuario pidió cambiar viaja (no se bloquean filas sin cambio).
    const [existing, created] = a1Calls(h.state)
    expect(existing.args.p_items).toEqual([
      { inventory_id: id(1), target: 4, expected: 10 },
      { inventory_id: id(2), target: 1, expected: 6 },
    ])
    expect(created.args.p_items).toEqual([{ inventory_id: id(4), delta: 3 }])
    expect(h.state.stock.get(id(1))).toBe(4)
    expect(h.state.stock.get(id(2))).toBe(5)
    expect(h.state.stock.get(id(3))).toBe(9)
    expect(details).toEqual(['1 stock actualizado', '1 producto nuevo con stock inicial', '1 producto sin cambio de stock'])
    expect(warnings).toHaveLength(3) // stale + inválido + repetido
  })

  it('T12 · un noop informado por el servidor se cuenta como «sin cambio»', async () => {
    h.state.rpcOverride = (_fn: string, args: any) => ({
      data: { ok: true, status: 'created', request_id: 'r', business_id: BIZ, idempotency_key: args.p_idempotency_key, source: 'import', reason: null,
        item_count: 1, applied_count: 0, stale_count: 0, noop_count: 1,
        items: [{ inventory_id: id(1), status: 'noop', mode: 'target', delta: null, target: 7, expected: 10, current_stock: 7, previous_stock: 7, new_stock: 7, quantity: 0, movement_type: null, movement_id: null }] },
      error: null,
    })
    const { summary, details } = await importar([row(1, 'A', false, 7, 10)])
    expect(summary.noop).toBe(1)
    expect(details).toEqual(['1 producto sin cambio de stock'])
  })

  it('T16 · retry del MISMO intento reusa las claves: replay, sin doble stock', async () => {
    h.state.stock.set(id(1), 10)
    const rows = [row(1, 'A', false, 7, 10), row(2, 'N', true, 5)]
    await importar(rows, 'att-X')
    // Respuesta perdida → el usuario reintenta el mismo archivo.
    const again = await importar(rows, 'att-X')
    const keys = a1Calls(h.state).map((c) => c.args.p_idempotency_key)
    expect(keys).toEqual([
      'g2c3a2-import-existing:att-X:0', 'g2c3a2-import-created:att-X:0',
      'g2c3a2-import-existing:att-X:0', 'g2c3a2-import-created:att-X:0',
    ])
    expect(h.state.stock.get(id(1))).toBe(7)
    expect(h.state.stock.get(id(2))).toBe(5) // no 10
    expect(h.state.movements).toHaveLength(2)
    expect(again.summary.applied).toBe(1) // replay devuelve el resultado persistido
  })

  it('T17 · intento nuevo → claves nuevas (y el stale protege un archivo re-usado)', async () => {
    h.state.stock.set(id(1), 10)
    await importar([row(1, 'A', false, 7, 10)], createImportAttempt('att-1').id)
    const second = await importar([row(1, 'A', false, 7, 10)], createImportAttempt('att-2').id)
    expect(a1Calls(h.state).map((c) => c.args.p_idempotency_key)).toEqual([
      'g2c3a2-import-existing:att-1:0', 'g2c3a2-import-existing:att-2:0',
    ])
    // El mismo Excel importado otra vez: el esperado (10) ya no es el real (7) → stale.
    expect(second.summary.stale.map((s) => s.code)).toEqual(['A'])
    expect(h.state.stock.get(id(1))).toBe(7)
  })

  it('createImportAttempt genera ids distintos', () => {
    expect(createImportAttempt().id).not.toBe(createImportAttempt().id)
  })

  it('> 5000 filas se parten en bloques con clave por bloque', async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => row(i + 1, `C${i}`, true, 1))
    await importar(rows, 'att-big')
    expect(a1Calls(h.state).map((c) => [c.args.p_idempotency_key, c.args.p_items.length])).toEqual([
      ['g2c3a2-import-created:att-big:0', 5000],
      ['g2c3a2-import-created:att-big:1', 1],
    ])
  })

  it('un error de la RPC se propaga (el caller reintenta el mismo intento)', async () => {
    h.state.rpcOverride = () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } })
    await expect(importar([row(1, 'A', false, 7, 10)])).rejects.toMatchObject({ retryable: true })
  })
})
