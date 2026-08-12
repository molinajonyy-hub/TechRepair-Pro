/**
 * productSellability — definición canónica de "producto vendible".
 *
 * Vive en `lib/` y NO importa el cliente de Supabase a propósito: es lógica
 * pura, la comparten POS, Inventario, órdenes y búsqueda global, y así puede
 * testearse sin red ni entorno Vite.
 *
 * ── EL MODELO REAL ────────────────────────────────────────────────────────
 * Un producto con variantes se guarda como un PADRE agrupador (has_variants =
 * true, stock 0) más una fila por variante. El vínculo hijo→padre se escribió
 * históricamente de tres formas distintas y las tres siguen vivas en datos:
 *
 *   1. `parent_id`                          — productService.createVariant
 *   2. `supplier_code = 'variant_parent:<id>'` — página de Inventario
 *   3. `supplier_code = 'VPREF-<id>'`          — legacy, aún leído por métricas
 *
 * Reconocer sólo una de las tres deja filas reales fuera de la superficie que
 * las mire. Por eso el contrato acepta las tres y no migra ninguna: migrar
 * datos es un lote aparte, y mientras tanto ninguna variante puede volverse
 * invisible.
 */

// Extensión explícita: estos módulos puros también los cargan los tests
// unitarios con `node --test`, que no resuelve imports sin extensión.
// `allowImportingTsExtensions` está activo en tsconfig.
import { normalizeText } from '../utils/searchUtils.ts'

/** Prefijos con que una variante referencia a su padre en `supplier_code`. */
export const VARIANT_PARENT_PREFIXES = ['variant_parent:', 'VPREF-'] as const

export interface VariantLinkFields {
  parent_id?: string | null
  supplier_code?: string | null
}

export interface SellabilityFields {
  is_active?: boolean | null
  has_variants?: boolean | null
}

/** Id del padre si el item es una variante hija; null si no lo es. */
export function getVariantParentId(item: VariantLinkFields | null | undefined): string | null {
  if (!item) return null
  if (item.parent_id) return item.parent_id
  const sc = typeof item.supplier_code === 'string' ? item.supplier_code : ''
  for (const prefijo of VARIANT_PARENT_PREFIXES) {
    if (sc.startsWith(prefijo)) {
      const id = sc.slice(prefijo.length).trim()
      if (id) return id
    }
  }
  return null
}

/** true si el item es una variante hija de algún padre. */
export function isVariantChild(item: VariantLinkFields | null | undefined): boolean {
  return getVariantParentId(item) !== null
}

/**
 * Padre agrupador: existe para agrupar, no para venderse.
 * Sus hijos son las unidades comerciales; su stock es siempre 0.
 */
export function isGroupingParent(item: SellabilityFields | null | undefined): boolean {
  return item?.has_variants === true
}

/**
 * Producto vendible = activo y que no sea un padre agrupador.
 *
 * El stock NO entra acá a propósito: "sin stock" es un atributo del resultado,
 * no su ausencia. Confundirlos es lo que hace que un producto agotado parezca
 * inexistente y se cargue a mano duplicado.
 */
export function isSellableProduct(
  item: (SellabilityFields & VariantLinkFields) | null | undefined
): boolean {
  if (!item) return false
  return item.is_active !== false && !isGroupingParent(item)
}

/**
 * Etiqueta comercial completa: "Funda Silicone iPhone 15 — Negro".
 *
 * Las dos representaciones guardan el nombre distinto: en una el `name` del
 * hijo ya trae el atributo ("… - Negro") y en la otra trae el nombre del padre
 * con el atributo en `variant_name`. Sin este chequeo, la primera se mostraría
 * como "… - Negro — Negro".
 */
export function productDisplayName(p: {
  name: string
  variant_name?: string | null
}): string {
  const variante = p.variant_name?.trim()
  if (!variante) return p.name
  if (normalizeText(p.name).includes(normalizeText(variante))) return p.name
  return `${p.name} — ${variante}`
}
