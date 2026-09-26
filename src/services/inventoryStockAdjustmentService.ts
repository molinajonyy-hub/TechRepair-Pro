/**
 * G2-C.3A2 · Adapter frontend ÚNICO de la autoridad canónica de stock.
 *
 * Toda mutación de stock que NO nace de un documento (stock inicial, import /
 * conteo, ajuste manual) pasa por UNA RPC server-side:
 *
 *   public.apply_inventory_stock_adjustments_atomic(
 *     p_business_id, p_items, p_source, p_reason, p_idempotency_key) → jsonb
 *
 * La RPC (G2-C.3A1) es la autoridad: bloquea las filas con el lock canónico,
 * relee el stock bajo lock, escribe stock + alias y el movimiento en la misma
 * transacción, y persiste la respuesta para el replay idempotente.
 *
 * Este módulo NO escribe `inventory`, NO escribe `inventory_movements` y NO
 * calcula ningún saldo: sólo arma el payload, exige tenant + clave de
 * idempotencia y devuelve la respuesta tipada del servidor. Los documentos
 * (venta, anulación, compra, borrado de compra, reparación, repuesto de orden)
 * siguen con sus writers server-side W1-W7: NO usan este adapter.
 */
import { supabase } from '../lib/supabase'

// ─── Contrato de la RPC ───────────────────────────────────────────────────────

export const STOCK_ADJUSTMENT_RPC = 'apply_inventory_stock_adjustments_atomic' as const

/** Tope de items por llamada (c_max_items de la RPC). */
export const STOCK_ADJUSTMENT_MAX_ITEMS = 5000

/** Rango int4 que acepta la RPC para delta / target / expected. */
export const STOCK_INT_MIN = -2147483648
export const STOCK_INT_MAX = 2147483647

export type StockAdjustmentSource = 'initial_stock' | 'import' | 'manual'

/** nuevo = actual + delta. Único modo admitido por `initial_stock`. */
export interface StockAdjustmentDeltaItem {
  inventory_id: string
  delta: number
}

/**
 * nuevo = target. `expected` es el stock que VIO el usuario: si bajo lock el
 * stock real es otro, la fila vuelve `stale` y no se aplica. `import` exige
 * expected; en `manual` es opcional (el frontend siempre lo manda).
 */
export interface StockAdjustmentTargetItem {
  inventory_id: string
  target: number
  expected?: number
}

export type StockAdjustmentItem = StockAdjustmentDeltaItem | StockAdjustmentTargetItem

export type StockAdjustmentItemStatus = 'applied' | 'stale' | 'noop'

export interface StockAdjustmentItemResult {
  inventory_id:   string
  status:         StockAdjustmentItemStatus
  mode:           'delta' | 'target'
  delta:          number | null
  target:         number | null
  expected:       number | null
  /** Stock que el servidor leyó bajo lock (antes de aplicar). */
  current_stock:  number
  previous_stock: number
  new_stock:      number
  quantity:       number
  movement_type:  'in' | 'out' | 'adjustment' | null
  movement_id:    string | null
}

export interface StockAdjustmentResponse {
  ok:              true
  /** created = primera ejecución; existing = replay de la respuesta persistida. */
  status:          'created' | 'existing'
  request_id:      string
  business_id:     string
  idempotency_key: string
  source:          StockAdjustmentSource
  reason:          string | null
  item_count:      number
  applied_count:   number
  stale_count:     number
  noop_count:      number
  items:           StockAdjustmentItemResult[]
}

export interface ApplyStockAdjustmentsParams {
  businessId:     string
  source:         StockAdjustmentSource
  items:          StockAdjustmentItem[]
  /**
   * OBLIGATORIA. Representa la INTENCIÓN, no el intento: un retry de la misma
   * intención reusa la clave (el servidor devuelve la respuesta persistida y no
   * mueve stock dos veces); una intención nueva usa una clave nueva.
   */
  idempotencyKey: string
  reason?:        string | null
}

// ─── Errores ──────────────────────────────────────────────────────────────────

/**
 * Error de la autoridad de stock. Conserva code / details / hint de PostgREST y
 * la etiqueta de dominio del mensaje (STOCK_ADJUSTMENT_*, IDEMPOTENCY_CONFLICT,
 * INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH, FORBIDDEN).
 */
export class StockAdjustmentError extends Error {
  readonly code?:    string
  readonly details?: string
  readonly hint?:    string
  /** Etiqueta de dominio (prefijo en mayúsculas del mensaje del servidor). */
  readonly label?:   string
  /**
   * true = NO se sabe si el servidor aplicó (transporte caído, respuesta
   * inválida o reintento pedido por la RPC). Lo correcto es reintentar con la
   * MISMA clave: el replay idempotente nunca duplica.
   */
  readonly retryable: boolean

  constructor(message: string, opts: { code?: string; details?: string; hint?: string; label?: string; retryable: boolean }) {
    super(message)
    this.name = 'StockAdjustmentError'
    this.code = opts.code
    this.details = opts.details
    this.hint = opts.hint
    this.label = opts.label
    this.retryable = opts.retryable
  }
}

/**
 * Un caller intentó mandar stock como dato de producto. Fail-closed: el stock
 * sólo se mueve por la RPC canónica (no documental) o por un documento.
 */
export class StockFieldWriteError extends Error {
  readonly code = 'STOCK_FIELDS_NOT_ALLOWED'
  constructor(where: string) {
    super(`${where}: el stock no se escribe junto con los datos del producto. Usá el ajuste de stock (autoridad canónica).`)
    this.name = 'StockFieldWriteError'
  }
}

/** Columnas de stock que ningún INSERT/UPDATE de metadata puede llevar. */
export const STOCK_FIELDS = ['stock', 'stock_quantity'] as const

export function hasStockFields(payload: object | null | undefined): boolean {
  if (!payload) return false
  return STOCK_FIELDS.some(k => Object.prototype.hasOwnProperty.call(payload, k))
}

/** Lanza si el payload de metadata trae stock / stock_quantity. */
export function assertNoStockFields(payload: object | null | undefined, where: string): void {
  if (hasStockFields(payload)) throw new StockFieldWriteError(where)
}

/** Copia del payload SIN stock / stock_quantity (para duplicar definiciones). */
export function withoutStockFields<T extends object>(payload: T): Omit<T, 'stock' | 'stock_quantity'> {
  const { stock: _stock, stock_quantity: _stockQuantity, ...rest } = payload as T & { stock?: unknown; stock_quantity?: unknown }
  return rest
}

function labelOf(message: string): string | undefined {
  return /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message.trim())?.[1]
}

function toStockAdjustmentError(err: { message?: string; code?: string; details?: string; hint?: string }): StockAdjustmentError {
  const message = err.message || 'Error al aplicar el ajuste de stock'
  const code = err.code || undefined
  // Sin SQLSTATE = transporte (red, timeout): el servidor pudo haber aplicado.
  // 40001 = la RPC pide reintentar (la clave cambió de estado durante la reserva).
  const retryable = !code || code === '40001'
  return new StockAdjustmentError(message, {
    code, details: err.details || undefined, hint: err.hint || undefined,
    label: labelOf(message), retryable,
  })
}

function isResponse(x: unknown): x is StockAdjustmentResponse {
  if (!x || typeof x !== 'object') return false
  const r = x as Partial<StockAdjustmentResponse>
  return r.ok === true
    && (r.status === 'created' || r.status === 'existing')
    && Array.isArray(r.items)
    && typeof r.applied_count === 'number'
    && typeof r.stale_count === 'number'
    && typeof r.noop_count === 'number'
}

// ─── Método central ───────────────────────────────────────────────────────────

/**
 * Llama a la autoridad canónica. No escribe tablas ni calcula saldos: devuelve
 * lo que decidió el servidor (applied / stale / noop por fila).
 */
export async function applyInventoryStockAdjustments(
  params: ApplyStockAdjustmentsParams,
): Promise<StockAdjustmentResponse> {
  const businessId = params.businessId?.trim()
  if (!businessId) {
    throw new StockAdjustmentError('STOCK_ADJUSTMENT_BUSINESS_REQUIRED: falta el negocio', { label: 'STOCK_ADJUSTMENT_BUSINESS_REQUIRED', retryable: false })
  }
  const key = params.idempotencyKey?.trim()
  if (!key) {
    throw new StockAdjustmentError('STOCK_ADJUSTMENT_INVALID_IDEMPOTENCY_KEY: falta la clave de idempotencia', { label: 'STOCK_ADJUSTMENT_INVALID_IDEMPOTENCY_KEY', retryable: false })
  }
  if (!Array.isArray(params.items) || params.items.length === 0) {
    throw new StockAdjustmentError('STOCK_ADJUSTMENT_ITEMS_REQUIRED: no hay productos para ajustar', { label: 'STOCK_ADJUSTMENT_ITEMS_REQUIRED', retryable: false })
  }
  if (params.items.length > STOCK_ADJUSTMENT_MAX_ITEMS) {
    throw new StockAdjustmentError(`STOCK_ADJUSTMENT_TOO_MANY_ITEMS: ${params.items.length} items (máximo ${STOCK_ADJUSTMENT_MAX_ITEMS})`, { label: 'STOCK_ADJUSTMENT_TOO_MANY_ITEMS', retryable: false })
  }

  const { data, error } = await supabase.rpc(STOCK_ADJUSTMENT_RPC, {
    p_business_id:     businessId,
    p_items:           params.items,
    p_source:          params.source,
    p_reason:          params.reason ?? null,
    p_idempotency_key: key,
  })

  if (error) throw toStockAdjustmentError(error)
  if (!isResponse(data)) {
    // El servidor respondió algo que no es el contrato A1: no se sabe qué
    // aplicó. Reintentar con la misma clave devuelve la respuesta persistida.
    throw new StockAdjustmentError('STOCK_ADJUSTMENT_INVALID_RESPONSE: respuesta inesperada del servidor', { label: 'STOCK_ADJUSTMENT_INVALID_RESPONSE', retryable: true })
  }
  return data
}

// ─── Claves de idempotencia (una por intención) ──────────────────────────────

/** Stock inicial de un producto: una sola intención por producto, para siempre. */
export function initialStockKey(inventoryId: string): string {
  return `initial-stock:${inventoryId}`
}

/**
 * Ajuste manual: la intención es «pasar de `expected` a `target` en esta
 * sesión de edición». Un retry de lo mismo reusa la clave; cambiar el valor o
 * abrir otra sesión es otra intención.
 */
export function manualStockKey(inventoryId: string, sessionId: string, expected: number, target: number): string {
  return `manual-stock:${inventoryId}:${sessionId}:${expected}:${target}`
}

/** Un intento de import: clave por lote y por bloque de hasta 5000 filas. */
export function importStockKey(kind: 'existing' | 'created', attemptId: string, chunk: number): string {
  return `g2c3a2-import-${kind}:${attemptId}:${chunk}`
}

export function isStockInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= STOCK_INT_MIN && n <= STOCK_INT_MAX
}

// ─── Atajos de las intenciones del frontend ──────────────────────────────────

/**
 * Stock inicial de un producto recién creado (sólo desde Inventario).
 * delta = cantidad; clave estable `initial-stock:<id>`. 0 → no llama.
 */
async function applyInitialStock(params: {
  businessId:  string
  inventoryId: string
  quantity:    number
  reason?:     string | null
}): Promise<StockAdjustmentItemResult | null> {
  if (!params.quantity) return null
  if (!isStockInt(params.quantity)) {
    throw new StockAdjustmentError('STOCK_ADJUSTMENT_INVALID_QUANTITY: el stock inicial debe ser un número entero', { label: 'STOCK_ADJUSTMENT_INVALID_QUANTITY', retryable: false })
  }
  const res = await applyInventoryStockAdjustments({
    businessId:     params.businessId,
    source:         'initial_stock',
    items:          [{ inventory_id: params.inventoryId, delta: params.quantity }],
    idempotencyKey: initialStockKey(params.inventoryId),
    reason:         params.reason ?? null,
  })
  return res.items.find(i => i.inventory_id === params.inventoryId) ?? null
}

/**
 * Ajuste manual a un valor: target = lo que escribió el usuario, expected = el
 * stock que VIO al empezar a editar. Si cambió entretanto → `stale`: no se
 * aplica y el caller informa; nunca se recalcula ni se pisa.
 */
async function applyManualTarget(params: {
  businessId:     string
  inventoryId:    string
  target:         number
  expected:       number
  idempotencyKey: string
  reason?:        string | null
}): Promise<StockAdjustmentItemResult> {
  if (!isStockInt(params.target) || !isStockInt(params.expected)) {
    throw new StockAdjustmentError('STOCK_ADJUSTMENT_INVALID_QUANTITY: el stock debe ser un número entero', { label: 'STOCK_ADJUSTMENT_INVALID_QUANTITY', retryable: false })
  }
  const res = await applyInventoryStockAdjustments({
    businessId:     params.businessId,
    source:         'manual',
    items:          [{ inventory_id: params.inventoryId, target: params.target, expected: params.expected }],
    idempotencyKey: params.idempotencyKey,
    reason:         params.reason ?? null,
  })
  const item = res.items.find(i => i.inventory_id === params.inventoryId)
  if (!item) {
    throw new StockAdjustmentError('STOCK_ADJUSTMENT_INVALID_RESPONSE: la respuesta no incluye el producto ajustado', { label: 'STOCK_ADJUSTMENT_INVALID_RESPONSE', retryable: true })
  }
  return item
}

export const inventoryStockAdjustmentService = {
  apply: applyInventoryStockAdjustments,
  applyInitialStock,
  applyManualTarget,
}
