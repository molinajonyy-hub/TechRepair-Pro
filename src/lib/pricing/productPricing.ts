/**
 * productPricing.ts — Motor centralizado de precio de producto (compute-at-read).
 *
 * Función PURA: dado un producto de inventario y la cotización del dólar vigente,
 * devuelve el precio ARS efectivo + metadata para la UI. No toca estado, servicios,
 * Supabase ni la DB. No persiste nada.
 *
 * Reglas de precio:
 *   - USD + base_price > 0 + auto_update_price = true  → DOLARIZADO: precio = round(base_price × dólar_vigente).
 *     Refleja siempre la cotización actual sin depender de un recálculo guardado.
 *   - USD + auto_update_price = false                  → override manual sobre base USD: usa el sale_price guardado.
 *   - ARS (o sin base_currency)                        → manual en ARS: usa el sale_price guardado, NUNCA se toca por el dólar.
 *   - Dólar inválido (≤0) o sin base_price             → fallback robusto al sale_price guardado (nunca devuelve 0 por error de tasa).
 *
 * El precio mayorista de productos USD-auto se dolariza proporcionalmente usando
 * exchange_rate_used (la tasa con la que se guardó); si falta, se conserva el valor guardado.
 *
 * Esta función NO aplica la regla minorista/mayorista por cliente: eso lo resuelve
 * `getProductPriceForCustomer` (src/utils/pricing.ts) consumiendo estos valores ya en ARS.
 */

export type PriceMode = 'usd_auto' | 'usd_manual' | 'manual_ars'

/** Campos de inventario relevantes para el cálculo (todos opcionales para tolerar productos viejos). */
export interface PricingProduct {
  sale_price?: number | string | null
  precio_mayorista?: number | string | null
  cost_price?: number | string | null
  cost_price_usd?: number | string | null
  base_currency?: string | null
  base_price?: number | string | null
  auto_update_price?: boolean | null
  exchange_rate_used?: number | string | null
}

export interface PricingOptions {
  /** Decimales de redondeo del precio final ARS (default 2, igual que el trigger de la DB). */
  decimals?: number
}

export interface ResolvedPricing {
  /** Precio de venta ARS efectivo (minorista), dolarizado si corresponde. */
  saleArs: number
  /** Costo ARS efectivo (dolarizado desde cost_price_usd si el producto es USD-auto). */
  costArs: number
  /** Precio mayorista ARS efectivo, o null si el producto no tiene mayorista. */
  mayoristaArs: number | null
  /** Modo de precio detectado. */
  mode: PriceMode
  /** true si el precio se calculó automáticamente con el dólar vigente. */
  isAuto: boolean
  /** Cotización usada en el cálculo (solo cuando isAuto). */
  dollarUsed: number | null
  /** Moneda base del producto. */
  baseCurrency: 'ARS' | 'USD'
  /** Precio base en USD (cuando base_currency = 'USD'), o null. */
  basePriceUsd: number | null
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v)
  return Number.isFinite(n) ? n : 0
}

function roundTo(value: number, decimals: number): number {
  const f = Math.pow(10, decimals)
  return Math.round(value * f) / f
}

/**
 * Resuelve el precio ARS vigente de un producto a partir de la cotización actual.
 * Pura, sin efectos secundarios.
 */
export function resolveProductPricing(
  product: PricingProduct,
  dollarRate: number,
  options: PricingOptions = {},
): ResolvedPricing {
  const decimals = options.decimals ?? 2
  const baseCurrency: 'ARS' | 'USD' = product.base_currency === 'USD' ? 'USD' : 'ARS'
  const basePriceUsd = baseCurrency === 'USD' ? (num(product.base_price) || null) : null
  const storedSale = num(product.sale_price)
  const storedCost = num(product.cost_price)
  const costUsd = num(product.cost_price_usd)
  const storedMayorista = product.precio_mayorista == null ? null : num(product.precio_mayorista)
  const rate = num(dollarRate)
  const rateUsed = num(product.exchange_rate_used)

  const isAuto =
    baseCurrency === 'USD' &&
    (basePriceUsd ?? 0) > 0 &&
    product.auto_update_price === true &&
    rate > 0

  if (isAuto) {
    // Mayorista: se dolariza proporcionalmente con la tasa con la que se guardó.
    // Si no hay tasa previa válida, se conserva el valor guardado (sin escalar).
    const mayoristaArs =
      storedMayorista != null && storedMayorista > 0 && rateUsed > 0
        ? roundTo(storedMayorista * (rate / rateUsed), decimals)
        : storedMayorista
    return {
      saleArs: roundTo((basePriceUsd as number) * rate, decimals),
      costArs: costUsd > 0 ? roundTo(costUsd * rate, decimals) : storedCost,
      mayoristaArs,
      mode: 'usd_auto',
      isAuto: true,
      dollarUsed: rate,
      baseCurrency,
      basePriceUsd,
    }
  }

  return {
    saleArs: storedSale,
    costArs: storedCost,
    mayoristaArs: storedMayorista,
    mode: baseCurrency === 'USD' ? 'usd_manual' : 'manual_ars',
    isAuto: false,
    dollarUsed: null,
    baseCurrency,
    basePriceUsd,
  }
}
