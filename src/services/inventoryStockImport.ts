/**
 * G2-C.3A2 · Stock del import de Excel sobre la autoridad canónica.
 *
 * El import ya NO escribe `stock_quantity`. La metadata del producto se guarda
 * aparte (Inventory.tsx, sin stock) y el stock se decide acá:
 *
 *   · Producto EXISTENTE → lote `import` a la RPC A1 con
 *       { inventory_id, target: «Stock actual», expected: «Stock esperado» }.
 *     «Stock esperado» es el SNAPSHOT de la exportación, nunca el stock leído
 *     durante el import: si entre el export y el import hubo una venta, la fila
 *     vuelve `stale` y NO se pisa.
 *     Sin «Stock esperado» (archivo viejo / plantilla) → el stock NO se toca y se
 *     avisa: un archivo viejo borraría del saldo lo vendido después del export.
 *     Stock actual = Stock esperado → el usuario no pidió cambio de stock: no se
 *     manda (no bloquea la fila ni genera un stale falso).
 *
 *   · Producto NUEVO (creado en este intento con stock 0) → lote `initial_stock`
 *     con delta = «Stock actual». No necesita expected: antes no existía.
 *
 * Idempotencia: un intento de import = un attemptId. Las claves son
 *   g2c3a2-import-existing:<attemptId>:<bloque>
 *   g2c3a2-import-created:<attemptId>:<bloque>
 * Reintentar el mismo intento (misma selección de archivo) reusa las claves y el
 * servidor devuelve la respuesta persistida; un archivo / intento nuevo rota.
 * No se usa una clave derivada del contenido del archivo: re-importar el mismo
 * Excel mañana es otra intención.
 */
import {
  applyInventoryStockAdjustments,
  importStockKey,
  isStockInt,
  STOCK_ADJUSTMENT_MAX_ITEMS,
  type StockAdjustmentDeltaItem,
  type StockAdjustmentItemResult,
  type StockAdjustmentTargetItem,
} from './inventoryStockAdjustmentService'

export const STOCK_ACTUAL_COLUMN = 'Stock actual'
export const STOCK_EXPECTED_COLUMN = 'Stock esperado'

/** Estado de UN intento de import (vive mientras dura la selección del archivo). */
export interface ImportAttempt {
  id: string
  /** código → id de los productos que ESTE intento creó (para que un retry no los trate como existentes). */
  createdByCode: Map<string, string>
}

export function createImportAttempt(id: string = crypto.randomUUID()): ImportAttempt {
  return { id, createdByCode: new Map() }
}

export interface StockImportRow {
  /** Fila de Excel (1 = encabezado). */
  rowNumber:   number
  code:        string
  inventoryId: string
  /** true = el producto lo creó este intento (nace en 0). */
  isNew:       boolean
  /** Celdas crudas. */
  actual:      unknown
  expected:    unknown
}

type Cell = { kind: 'blank' } | { kind: 'int'; value: number } | { kind: 'invalid' }

function parseCell(v: unknown): Cell {
  if (v === undefined || v === null) return { kind: 'blank' }
  const s = String(v).trim()
  if (s === '') return { kind: 'blank' }
  const n = typeof v === 'number' ? v : Number(s)
  return isStockInt(n) ? { kind: 'int', value: n } : { kind: 'invalid' }
}

export interface StockImportPlan {
  existing:  StockAdjustmentTargetItem[]
  created:   StockAdjustmentDeltaItem[]
  /** inventory_id → código, para identificar filas stale en el resumen. */
  codeById:  Map<string, string>
  /** Existentes con Stock actual = Stock esperado: sin intención de stock. */
  unchanged: number
  /** Existentes sin «Stock esperado»: stock omitido. */
  missingExpected: string[]
  invalid:   string[]
  duplicates: string[]
}

/** Decide qué stock se pide. Puro: no llama a nadie. */
export function planStockImport(rows: StockImportRow[]): StockImportPlan {
  const plan: StockImportPlan = {
    existing: [], created: [], codeById: new Map(), unchanged: 0,
    missingExpected: [], invalid: [], duplicates: [],
  }
  const seen = new Set<string>()

  for (const row of rows) {
    const actual = parseCell(row.actual)
    const repeated = seen.has(row.inventoryId)
    seen.add(row.inventoryId)
    plan.codeById.set(row.inventoryId, row.code)

    if (actual.kind === 'blank') continue            // sin intención de stock
    if (repeated) { plan.duplicates.push(row.code); continue }
    if (actual.kind === 'invalid') { plan.invalid.push(`fila ${row.rowNumber} (${row.code})`); continue }

    if (row.isNew) {
      if (actual.value !== 0) plan.created.push({ inventory_id: row.inventoryId, delta: actual.value })
      continue
    }

    const expected = parseCell(row.expected)
    if (expected.kind === 'blank') { plan.missingExpected.push(row.code); continue }
    if (expected.kind === 'invalid') { plan.invalid.push(`fila ${row.rowNumber} (${row.code})`); continue }
    if (expected.value === actual.value) { plan.unchanged++; continue }
    plan.existing.push({ inventory_id: row.inventoryId, target: actual.value, expected: expected.value })
  }
  return plan
}

export interface StaleImportRow {
  code:     string
  current:  number
  expected: number | null
  target:   number | null
}

export interface StockImportSummary {
  applied:        number
  noop:           number
  stale:          StaleImportRow[]
  createdApplied: number
  createdNoop:    number
  unchanged:      number
  missingExpected: string[]
  invalid:        string[]
  duplicates:     string[]
}

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += STOCK_ADJUSTMENT_MAX_ITEMS) out.push(xs.slice(i, i + STOCK_ADJUSTMENT_MAX_ITEMS))
  return out
}

/**
 * Aplica el plan: existentes por `import`, nuevos por `initial_stock`. Un stale
 * NO aborta el archivo (el servidor lo decide por fila). Un error de la RPC sí
 * se propaga: el caller reintenta el MISMO intento y las claves hacen replay.
 */
export async function applyStockImport(params: {
  businessId: string
  attemptId:  string
  plan:       StockImportPlan
}): Promise<StockImportSummary> {
  const { businessId, attemptId, plan } = params
  const summary: StockImportSummary = {
    applied: 0, noop: 0, stale: [], createdApplied: 0, createdNoop: 0,
    unchanged: plan.unchanged, missingExpected: plan.missingExpected,
    invalid: plan.invalid, duplicates: plan.duplicates,
  }

  const staleOf = (r: StockAdjustmentItemResult): StaleImportRow => ({
    code: plan.codeById.get(r.inventory_id) ?? r.inventory_id,
    current: r.current_stock, expected: r.expected, target: r.target,
  })

  for (const [i, items] of chunks(plan.existing).entries()) {
    const res = await applyInventoryStockAdjustments({
      businessId, source: 'import', items, idempotencyKey: importStockKey('existing', attemptId, i),
    })
    for (const r of res.items) {
      if (r.status === 'applied') summary.applied++
      else if (r.status === 'noop') summary.noop++
      else summary.stale.push(staleOf(r))
    }
  }

  for (const [i, items] of chunks(plan.created).entries()) {
    const res = await applyInventoryStockAdjustments({
      businessId, source: 'initial_stock', items, idempotencyKey: importStockKey('created', attemptId, i),
      reason: 'Alta por importación de Excel',
    })
    for (const r of res.items) {
      if (r.status === 'applied') summary.createdApplied++
      else if (r.status === 'noop') summary.createdNoop++
      else summary.stale.push(staleOf(r))
    }
  }

  return summary
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const LIST_MAX = 20
const listOf = (xs: string[]) => xs.slice(0, LIST_MAX).join(', ') + (xs.length > LIST_MAX ? `… (+${xs.length - LIST_MAX})` : '')

/** Resumen legible para el usuario. */
export function describeStockImport(s: StockImportSummary): { details: string[]; warnings: string[] } {
  const details: string[] = []
  const warnings: string[] = []

  if (s.applied) details.push(`${plural(s.applied, 'stock actualizado', 'stocks actualizados')}`)
  if (s.createdApplied) details.push(`${plural(s.createdApplied, 'producto nuevo', 'productos nuevos')} con stock inicial`)
  const sinCambio = s.unchanged + s.noop + s.createdNoop
  if (sinCambio) details.push(`${plural(sinCambio, 'producto', 'productos')} sin cambio de stock`)

  if (s.stale.length) {
    const rows = s.stale.map(r => `${r.code} (ahora ${r.current}, exportado ${r.expected ?? '—'})`)
    warnings.push(`${plural(s.stale.length, 'stock omitido porque cambió', 'stocks omitidos porque cambiaron')} desde la exportación: ${listOf(rows)}. Exportá de nuevo y reintentá esos productos.`)
  }
  if (s.missingExpected.length) {
    warnings.push(`${plural(s.missingExpected.length, 'producto existente', 'productos existentes')} sin «${STOCK_EXPECTED_COLUMN}» (archivo viejo o plantilla): el stock se omitió para no pisar movimientos posteriores. Exportá el inventario de nuevo para ajustar stock.`)
  }
  if (s.invalid.length) {
    warnings.push(`${plural(s.invalid.length, 'fila', 'filas')} con stock inválido (tiene que ser un número entero): ${listOf(s.invalid)}. El stock de esas filas no se tocó.`)
  }
  if (s.duplicates.length) {
    warnings.push(`${plural(s.duplicates.length, 'código repetido', 'códigos repetidos')} en el archivo: sólo se tomó el stock de la primera fila (${listOf(s.duplicates)}).`)
  }
  return { details, warnings }
}
