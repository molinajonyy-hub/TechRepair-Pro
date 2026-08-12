/**
 * productSearchService — FUENTE ÚNICA para buscar productos vendibles.
 *
 * Reemplaza las búsquedas ad-hoc que cada pantalla escribía por su cuenta
 * (POS, órdenes, Command Palette). Todas comparten desde acá:
 *   - qué es un producto vendible;
 *   - en qué campos se busca;
 *   - el scope multi-tenant;
 *   - el orden;
 *   - el tope y su señalización.
 *
 * ── POR QUÉ EXISTE ────────────────────────────────────────────────────────
 * La búsqueda anterior del POS mandaba UN SOLO token al servidor
 * (`buildSupabaseQuery` se quedaba con el más largo), traía 40 filas SIN
 * `ORDER BY` y recién ahí filtraba en React por todos los tokens. Con un
 * catálogo real, las 40 filas que llegaban eran un subconjunto arbitrario del
 * universo que matcheaba ese único token, así que un producto perfectamente
 * vendible podía no estar entre ellas. Se veía en Inventario y no se podía
 * cobrar. Buscar el SKU exacto fallaba igual: "SRCH-FUN-IP15-VAR-01" se
 * reducía al token "srch".
 *
 * Acá el AND multi-token se resuelve EN EL SERVIDOR: cada token debe aparecer
 * en algún campo buscable, y el tope se aplica sobre el conjunto ya relevante.
 */
import { supabase } from '../lib/supabase'
import { normalizeText, smartSearch } from '../utils/searchUtils'
import {
  MIN_QUERY_LENGTH,
  buildSearchTokens,
  buildTokenOrFilter,
  buildParentReferenceFilter,
  extractParentIds,
  sortByPhraseRelevance,
} from '../lib/productSearchQuery'

export { MIN_QUERY_LENGTH } from '../lib/productSearchQuery'

// La definición de vendibilidad vive en lib/ (pura, sin Supabase) y se
// re-exporta acá para que las superficies tengan un único punto de import.
export {
  VARIANT_PARENT_PREFIXES,
  getVariantParentId,
  isVariantChild,
  isGroupingParent,
  isSellableProduct,
  productDisplayName,
} from '../lib/productSellability'

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface SellableProduct {
  id: string
  code: string
  name: string
  variant_name: string | null
  category: string | null
  subcategory: string | null
  stock_quantity: number
  cost_price: number | null
  cost_price_usd: number | null
  sale_price: number | null
  precio_mayorista: number | null
  base_price: number | null
  base_currency: string | null
  auto_update_price: boolean | null
  exchange_rate_used: number | null
  has_variants: boolean | null
  parent_id: string | null
  supplier_code: string | null
  tipo: string | null
}

export type ProductSearchStatus = 'ok' | 'error'

export interface ProductSearchResult {
  status: ProductSearchStatus
  items: SellableProduct[]
  /** true si el servidor tenía más coincidencias de las que se pidieron. */
  truncated: boolean
  /** Mensaje crudo del backend. Sólo con status 'error'. */
  error?: string
}

export interface ProductSearchOptions {
  /** Sin negocio no hay universo autorizado: devuelve vacío en vez de consultar. */
  businessId: string | null | undefined
  query: string
  /** Máximo de resultados devueltos a la UI. Default 20. */
  limit?: number
  /** Filtra por `tipo` ('product' | 'service'). Sin valor, no filtra. */
  tipo?: string
  /** Señal para descartar respuestas de búsquedas ya superadas. */
  signal?: AbortSignal
}

const COLUMNS =
  'id,code,name,variant_name,category,subcategory,stock_quantity,cost_price,cost_price_usd,' +
  'sale_price,precio_mayorista,base_price,base_currency,auto_update_price,exchange_rate_used,' +
  'has_variants,parent_id,supplier_code,tipo'

/**
 * Saca del conjunto los productos que, aunque tengan `has_variants` en false,
 * son padres de verdad porque alguna fila los referencia como tal.
 *
 * Una sola consulta indexada sobre los ids ya devueltos. Ante un fallo de esa
 * consulta se devuelve el conjunto SIN filtrar por estructura: el flag sigue
 * cubriendo el caso normal, y preferimos mostrar de más a dejar la caja sin
 * resultados por un problema de red. La venta del padre igual está acotada
 * porque su stock es 0.
 */
async function descartarPadresEstructurales(
  businessId: string,
  candidatos: SellableProduct[],
): Promise<SellableProduct[]> {
  if (candidatos.length === 0) return candidatos

  const filtro = buildParentReferenceFilter(candidatos.map(c => c.id))
  if (!filtro) return candidatos

  const { data, error } = await supabase
    .from('inventory')
    .select('parent_id,supplier_code')
    .eq('business_id', businessId)
    .or(filtro)

  if (error) return candidatos

  const padres = extractParentIds(data ?? [])
  if (padres.size === 0) return candidatos

  return candidatos.filter(c => !padres.has(c.id))
}

// ─── Búsqueda canónica ───────────────────────────────────────────────────────

/**
 * Busca productos vendibles del negocio.
 *
 * El AND multi-token se resuelve en el servidor encadenando un `.or(...)` por
 * token: PostgREST combina con AND los parámetros de nivel superior, así que
 * cada token debe matchear en alguno de los campos buscables. Recién sobre ese
 * conjunto ya relevante se aplica el tope, y se pide uno de más para poder
 * avisar que quedó truncado en vez de mentir un "no hay resultados".
 */
export async function searchSellableProducts(
  opts: ProductSearchOptions
): Promise<ProductSearchResult> {
  const { businessId, query, limit = 20, tipo, signal } = opts

  if (!businessId) {
    return { status: 'ok', items: [], truncated: false }
  }
  if (normalizeText(query).length < MIN_QUERY_LENGTH) {
    return { status: 'ok', items: [], truncated: false }
  }

  const tokens = buildSearchTokens(query)
  if (tokens.length === 0) {
    return { status: 'ok', items: [], truncated: false }
  }

  let q = supabase
    .from('inventory')
    .select(COLUMNS)
    .eq('business_id', businessId)
    .eq('is_active', true)
    // Un padre agrupador nunca es vendible: sus hijos representan las unidades.
    .not('has_variants', 'is', true)

  if (tipo) q = q.eq('tipo', tipo)

  // AND multi-token server-side: un .or() por token.
  for (const token of tokens) {
    q = q.or(buildTokenOrFilter(token))
  }

  // Orden determinista: sin esto el truncado devuelve un subconjunto arbitrario
  // y la misma búsqueda puede dar distinto resultado en dos corridas.
  q = q.order('name', { ascending: true }).order('id', { ascending: true })

  // Se piden `limit + 1` filas sólo para saber si había más.
  q = q.limit(limit + 1)

  if (signal) q = q.abortSignal(signal)

  const { data, error } = await q

  if (error) {
    // Un fallo del backend NO es "no hay resultados". La superficie decide cómo
    // mostrarlo, pero jamás puede confundirse con un catálogo vacío.
    return { status: 'error', items: [], truncated: false, error: error.message }
  }

  const candidatos = (data ?? []) as unknown as SellableProduct[]

  // ── Segundo filtro: padres detectados por ESTRUCTURA ────────────────────
  // `has_variants` no es confiable por sí solo: lo escribe el cliente, no hay
  // trigger que lo mantenga, y en createProductWithVariants se setea con un
  // UPDATE separado cuyo error no se chequea. Un padre que quedó con el flag
  // en false tiene stock 0 y se ofrecería como producto fantasma.
  // Se consulta sobre los ids ya devueltos (a lo sumo limit+1), no sobre el
  // catálogo entero.
  const filas = await descartarPadresEstructurales(businessId, candidatos)
  const truncated = candidatos.length > limit

  // Ranking local sobre un conjunto YA relevante: acá el orden no decide qué se
  // pierde, pero SÍ decide qué queda primero — y la primera opción viene
  // resaltada y se agrega con Enter.
  const porTokens = smartSearch(filas.slice(0, limit + 1), query, [
    { getValue: (p: SellableProduct) => p.code, weight: 3 },
    { getValue: (p: SellableProduct) => p.name, weight: 2 },
    { getValue: (p: SellableProduct) => p.variant_name ?? '', weight: 2 },
    { getValue: (p: SellableProduct) => p.subcategory ?? '', weight: 1.5 },
    { getValue: (p: SellableProduct) => p.category ?? '', weight: 1 },
  ])
  // La coincidencia de frase manda sobre la suma de tokens sueltos: si no, un
  // producto ajeno gana por matchear "15" en un campo de mucho peso.
  const ordenados = sortByPhraseRelevance(porTokens, query)

  return { status: 'ok', items: ordenados.slice(0, limit), truncated }
}
