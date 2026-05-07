/**
 * pricing.ts — Función centralizada de precios por tipo de cliente
 *
 * REGLA DE PRECIO (prioridad):
 *   1. Precio manual editado por el usuario
 *   2. Precio mayorista si cliente es mayorista y producto tiene precio mayorista > 0
 *   3. Precio normal/minorista
 */

export type PriceType = 'minorista' | 'mayorista' | 'manual' | 'oferta'

export interface PriceResult {
  price:       number
  priceType:   PriceType
  /** true si el cliente es mayorista pero el producto no tiene precio mayorista → se usó precio normal como fallback */
  fallback:    boolean
}

export interface ProductForPricing {
  sale_price?:      number | string | null
  precio_venta?:    number | string | null
  price?:           number | string | null
  precio_mayorista? : number | string | null
  wholesale_price?: number | string | null
  // Campos de copia almacenada en LineaItem
  inv_sale_price?:     number | null
  inv_mayorista_price?:number | null
}

export interface CustomerForPricing {
  customer_type?: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isWholesaleCustomer(customer: CustomerForPricing | null | undefined): boolean {
  return customer?.customer_type === 'mayorista'
}

function safeNum(v: number | string | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v)
  return isFinite(n) ? n : 0
}

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Devuelve el precio correcto para el producto según el tipo de cliente.
 * No modifica ningún estado — solo calcula.
 */
export function getProductPriceForCustomer(
  product: ProductForPricing,
  customer: CustomerForPricing | null | undefined,
): PriceResult {
  const wholesale = isWholesaleCustomer(customer)

  const normalPrice = safeNum(
    product.inv_sale_price ??
    product.sale_price ??
    product.precio_venta ??
    product.price ??
    0
  )

  const wholesalePrice = safeNum(
    product.inv_mayorista_price ??
    product.precio_mayorista ??
    product.wholesale_price ??
    0
  )

  if (wholesale && wholesalePrice > 0) {
    return { price: wholesalePrice, priceType: 'mayorista', fallback: false }
  }

  return {
    price:     normalPrice,
    priceType: 'minorista',
    fallback:  wholesale && wholesalePrice <= 0,  // aviso: mayorista sin precio mayorista
  }
}

// ─── Badge helpers (para UI) ──────────────────────────────────────────────────

export const PRICE_TYPE_LABELS: Record<PriceType, string> = {
  minorista: 'Minorista',
  mayorista: 'Mayorista',
  manual:    'Manual',
  oferta:    'Oferta',
}

export const PRICE_TYPE_COLORS: Record<PriceType, string> = {
  minorista: '#64748b',
  mayorista: '#818cf8',
  manual:    '#fbbf24',
  oferta:    '#34d399',
}
