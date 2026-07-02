/**
 * saleTransactionService — Orquestador central de ventas
 *
 * ⚠ NO ALCANZABLE (auditoría entry points, 2026-07-01): ningún componente,
 * página ni test importa este módulo — verificado por grep en toda la base
 * (src/, tests/). No está wireado a ningún flujo productivo real; los entry
 * points reales (ComprobanteProModal, ModalCobro, ModalCrearComprobante)
 * llaman a comprobanteService.crear() directamente, con su propia
 * idempotency key (ver useCheckoutIdempotency). Se conserva el archivo (no
 * se borra sin pedido explícito) mantenido inerte deliberadamente — ver
 * tests/unit/checkoutIdempotency.test.ts, test "saleTransactionService
 * permanece no importado" — que falla si alguien vuelve a importarlo sin
 * wirearlo con idempotencia server-side.
 *
 * RESPONSABILIDAD (documentada, no en uso):
 *   Valida stock, detecta tipo de venta y delega a comprobanteService.crear().
 *   El servicio de comprobante ya maneja internamente:
 *     - decremento de stock (step 6 / _descontarStock)
 *     - inventory_movements (dentro de _descontarStock)
 *     - BFE income + cost (steps 8-9)
 *     - comprobante_payments → trigger → BFE (trig_comprobante_payment_finance)
 *     - cuenta corriente (step 10 si hay CC)
 *
 *   processSaleTransaction() agrega:
 *     - validación de stock ANTES de crear (falla rápido)
 *     - detección automática del tipo de venta
 *     - resultado enriquecido con resumen financiero
 *
 * USO:
 *   Llamar siempre que se quiera crear una venta: minorista, mayorista,
 *   mostrador o conversión de orden. Evita que cada módulo llame
 *   directamente a comprobanteService sin validar.
 */

import { supabase } from '../lib/supabase'
import {
  comprobanteService,
  type CrearComprobanteInput,
  type Comprobante,
} from './comprobanteService'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SaleType = 'retail' | 'wholesale' | 'service_order' | 'counter'

export interface SaleItem {
  inventory_id?: string | null
  descripcion:   string
  tipo_linea:    'producto' | 'repuesto' | 'servicio' | 'otro'
  cantidad:      number
  precio_unitario: number
  costo_unitario:  number
  descuento_linea?: number
  currency?:     'ARS' | 'USD'
  exchange_rate?: number
  applied_price_type?: 'minorista' | 'mayorista' | 'manual' | null
}

export interface SaleTransactionInput {
  businessId:  string
  customerId?: string | null
  orderId?:    string | null
  items:       SaleItem[]
  pagos?:      CrearComprobanteInput['pagos']
  tipo?:       CrearComprobanteInput['tipo']
  puntoVenta?: string
  condicionFiscal?: string
  observaciones?:   string
  exchangeRate?:    number
  esFiscal?:        boolean
  emitirEnArca?:    boolean
  cajaId?:          string | null
  userId?:          string
  skipFinanceEntry?: boolean
}

export interface SaleTransactionResult {
  success:      boolean
  comprobante?: Comprobante
  error?:       string
  arcaError?:   string
  /** Resumen calculado antes de persistir */
  summary?: {
    saleType:        SaleType
    subtotal:        number
    totalCost:       number
    grossProfit:     number
    grossMarginPct:  number
    hasWholesaleItems: boolean
    stockWarnings:   string[]
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Verifica stock disponible para ítems de inventario. Devuelve lista de warnings. */
async function validateStock(
  items: SaleItem[],
  businessId: string,
): Promise<{ ok: boolean; warnings: string[] }> {
  const inventoryItems = items.filter(
    i => i.inventory_id && (i.tipo_linea === 'producto' || i.tipo_linea === 'repuesto')
  )
  if (inventoryItems.length === 0) return { ok: true, warnings: [] }

  const ids = inventoryItems.map(i => i.inventory_id!)
  const { data, error } = await supabase
    .from('inventory')
    .select('id, name, stock_quantity')
    .in('id', ids)
    .eq('business_id', businessId)

  if (error) {
    console.warn('[saleTransaction] stock validation query failed:', error.message)
    return { ok: true, warnings: [] } // falla abierta — deja continuar
  }

  const stockMap = new Map((data || []).map(d => [d.id, d]))
  const warnings: string[] = []
  let ok = true

  for (const item of inventoryItems) {
    const stock = stockMap.get(item.inventory_id!)
    if (!stock) continue
    if (stock.stock_quantity < item.cantidad) {
      warnings.push(`"${stock.name}": stock disponible ${stock.stock_quantity}, se intenta vender ${item.cantidad}`)
      ok = false
    }
    if (stock.stock_quantity <= 3) {
      warnings.push(`"${stock.name}": stock bajo (${stock.stock_quantity} unidades)`)
    }
  }

  return { ok, warnings }
}

/** Detecta tipo de venta según ítems y cliente. */
function detectSaleType(
  items: SaleItem[],
  input: SaleTransactionInput
): SaleType {
  if (input.orderId) return 'service_order'
  const hasWholesale = items.some(i => i.applied_price_type === 'mayorista')
  if (hasWholesale) return 'wholesale'
  if (!input.customerId) return 'counter'
  return 'retail'
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Punto de entrada único para todas las ventas del sistema.
 *
 * Flujo:
 *  1. Valida stock (falla rápido con mensaje claro)
 *  2. Detecta tipo de venta (retail / wholesale / service_order / counter)
 *  3. Construye el resumen financiero previamente
 *  4. Llama a comprobanteService.crear() que orquesta el resto:
 *     stock decrement → inventory_movements → BFE → caja → CC
 */
export async function processSaleTransaction(
  input: SaleTransactionInput
): Promise<SaleTransactionResult> {

  // ── 1. Validar stock ───────────────────────────────────────────────────────
  const { ok: stockOk, warnings } = await validateStock(input.items, input.businessId)
  if (!stockOk) {
    return {
      success: false,
      error:   'Stock insuficiente:\n' + warnings.filter(w => w.includes('intenta vender')).join('\n'),
      summary: {
        saleType:          'retail',
        subtotal:          0,
        totalCost:         0,
        grossProfit:       0,
        grossMarginPct:    0,
        hasWholesaleItems: false,
        stockWarnings:     warnings,
      },
    }
  }

  // ── 2. Detectar tipo de venta ──────────────────────────────────────────────
  const saleType = detectSaleType(input.items, input)

  // ── 3. Calcular resumen preventivo ────────────────────────────────────────
  const rate = input.exchangeRate || 1
  let subtotal   = 0
  let totalCost  = 0
  const hasWholesaleItems = input.items.some(i => i.applied_price_type === 'mayorista')

  for (const item of input.items) {
    const disc   = Math.min(item.descuento_linea || 0, 100) / 100
    const lineARS = item.cantidad * item.precio_unitario * (1 - disc) * (item.currency === 'USD' ? rate : 1)
    subtotal  += lineARS
    totalCost += (item.costo_unitario || 0) * item.cantidad * (item.currency === 'USD' ? rate : 1)
  }

  const grossProfit    = subtotal - totalCost
  const grossMarginPct = subtotal > 0 ? (grossProfit / subtotal) * 100 : 0

  // ── 4. Construir input para comprobanteService ─────────────────────────────
  const comprobanteInput: CrearComprobanteInput = {
    tipo:             input.tipo ?? 'factura_c',
    punto_venta:      input.puntoVenta ?? '0001',
    condicion_fiscal: input.condicionFiscal ?? 'Consumidor Final',
    customer_id:      input.customerId || null,
    order_id:         input.orderId    || null,
    observaciones:    input.observaciones,
    exchange_rate:    input.exchangeRate || 1,
    es_fiscal:        input.esFiscal || false,
    emitir_en_arca:   input.emitirEnArca || false,
    items: input.items.map(i => ({
      descripcion:        i.descripcion,
      tipo_linea:         i.tipo_linea,
      cantidad:           i.cantidad,
      precio_unitario:    i.precio_unitario,
      descuento_linea:    i.descuento_linea || 0,
      costo_unitario:     i.costo_unitario  || 0,
      currency:           i.currency        || 'ARS',
      exchange_rate:      i.exchange_rate   || 1,
      inventory_id:       i.inventory_id    || null,
      applied_price_type: i.applied_price_type || null,
    })),
    pagos:             input.pagos || [],
    business_id:       input.businessId,
    created_by:        input.userId,
    caja_id:           input.cajaId || null,
    skip_finance_entry: input.skipFinanceEntry || false,
  }

  // ── 5. Ejecutar venta ──────────────────────────────────────────────────────
  const result = await comprobanteService.crear(comprobanteInput)

  if (!result.success) {
    return {
      success: false,
      error:   result.error,
      summary: { saleType, subtotal, totalCost, grossProfit, grossMarginPct, hasWholesaleItems, stockWarnings: warnings },
    }
  }

  console.info(`[saleTransaction] Venta ${saleType} completada`, {
    comprobanteId: result.comprobante?.id,
    subtotal:      subtotal.toFixed(2),
    costo:         totalCost.toFixed(2),
    ganancia:      grossProfit.toFixed(2),
    margen:        grossMarginPct.toFixed(1) + '%',
    stockWarnings: warnings.length,
  })

  return {
    success:     true,
    comprobante: result.comprobante,
    arcaError:   result.arcaError,
    summary: {
      saleType,
      subtotal,
      totalCost,
      grossProfit,
      grossMarginPct,
      hasWholesaleItems,
      stockWarnings: warnings,
    },
  }
}
