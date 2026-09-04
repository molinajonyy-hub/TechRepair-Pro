/**
 * productSearchService â€” FUENTE ÃšNICA para buscar productos vendibles.
 *
 * Reemplaza las bÃºsquedas ad-hoc que cada pantalla escribÃ­a por su cuenta
 * (POS, Ã³rdenes, Command Palette). Todas comparten desde acÃ¡:
 *   - quÃ© es un producto vendible;
 *   - en quÃ© campos se busca;
 *   - el scope multi-tenant;
 *   - el orden;
 *   - el tope y su seÃ±alizaciÃ³n.
 *
 * â”€â”€ POR QUÃ‰ EXISTE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * La bÃºsqueda anterior del POS mandaba UN SOLO token al servidor
 * (`buildSupabaseQuery` se quedaba con el mÃ¡s largo), traÃ­a 40 filas SIN
 * `ORDER BY` y reciÃ©n ahÃ­ filtraba en React por todos los tokens. Con un
 * catÃ¡logo real, las 40 filas que llegaban eran un subconjunto arbitrario del
 * universo que matcheaba ese Ãºnico token, asÃ­ que un producto perfectamente
 * vendible podÃ­a no estar entre ellas. Se veÃ­a en Inventario y no se podÃ­a
 * cobrar. Buscar el SKU exacto fallaba igual: "SRCH-FUN-IP15-VAR-01" se
 * reducÃ­a al token "srch".
 *
 * AcÃ¡ el AND multi-token se resuelve EN EL SERVIDOR: cada token debe aparecer
 * en algÃºn campo buscable, y el tope se aplica sobre el conjunto ya relevante.
 */
import { supabase } from '../lib/supabase'
import { normalizeText, smartSearch } from '../utils/searchUtils'
import { attachInventoryCosts } from './inventoryCostAccess'
import {
  MIN_QUERY_LENGTH,
  buildSearchTokens,
  buildTokenOrFilter,
  buildParentReferenceFilter,
  extractParentIds,
  sortByPhraseRelevance,
} from '../lib/productSearchQuery'

export { MIN_QUERY_LENGTH } from '../lib/productSearchQuery'

// La definiciÃ³n de vendibilidad vive en lib/ (pura, sin Supabase) y se
// re-exporta acÃ¡ para que las superficies tengan un Ãºnico punto de import.
export {
  VARIANT_PARENT_PREFIXES,
  getVariantParentId,
  isVariantChild,
  isGroupingParent,
  isSellableProduct,
  productDisplayName,
} from '../lib/productSellability'

// â”€â”€â”€ Tipos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

/**
 * QuÃ© fallÃ³. La copia al usuario cambia segÃºn el caso:
 *  - `query`         â€” no se pudo consultar el catÃ¡logo.
 *  - `variant_check` â€” el catÃ¡logo respondiÃ³, pero no se pudo validar quÃ©
 *                      productos son padres agrupadores. Fail-closed: no se
 *                      devuelve nada, porque un padre inconsistente serÃ­a
 *                      seleccionable.
 */
export type ProductSearchErrorReason = 'query' | 'variant_check'

export interface ProductSearchResult {
  status: ProductSearchStatus
  items: SellableProduct[]
  /** true si el servidor tenÃ­a mÃ¡s coincidencias de las que se pidieron. */
  truncated: boolean
  /** Mensaje crudo del backend. SÃ³lo con status 'error'. */
  error?: string
  /** SÃ³lo con status 'error'. */
  reason?: ProductSearchErrorReason
}

export interface ProductSearchOptions {
  /** Sin negocio no hay universo autorizado: devuelve vacÃ­o en vez de consultar. */
  businessId: string | null | undefined
  query: string
  /** MÃ¡ximo de resultados devueltos a la UI. Default 20. */
  limit?: number
  /** Filtra por `tipo` ('product' | 'service'). Sin valor, no filtra. */
  tipo?: string
  /** SeÃ±al para descartar respuestas de bÃºsquedas ya superadas. */
  signal?: AbortSignal
}

// SEC-08B: `cost_price` y `cost_price_usd` ya NO se piden acÃ¡. EstÃ¡n revocadas
// para los roles del navegador, asÃ­ que incluirlas devolverÃ­a 42501 para TODOS
// â€”owner incluidoâ€” y el buscador del POS dejarÃ­a de responder. El costo se
// repone despuÃ©s, por la vista autorizada, y sÃ³lo para quien puede verlo.
const COLUMNS =
  'id,code,name,variant_name,category,subcategory,stock_quantity,' +
  'sale_price,precio_mayorista,base_price,base_currency,auto_update_price,exchange_rate_used,' +
  'has_variants,parent_id,supplier_code,tipo'

/**
 * Saca del conjunto los productos que, aunque tengan `has_variants` en false,
 * son padres de verdad porque alguna fila los referencia como tal.
 *
 * â”€â”€ FAIL-CLOSED â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Si la consulta falla NO se devuelven los candidatos sin filtrar. Hacerlo
 * serÃ­a fail-open justo cuando no se puede confirmar la estructura: un padre
 * inconsistente (has_variants=false con hijos reales) volverÃ­a a ser
 * seleccionable, que es exactamente el invariante que este lote cierra.
 *
 * Un padre agrupador nunca debe poder venderse accidentalmente, ni siquiera
 * en el camino de error. Se propaga el fallo para que la superficie ofrezca
 * reintentar, en vez de decidir por su cuenta con datos que no pudo validar.
 */
type ResultadoEstructural =
  | { ok: true; items: SellableProduct[] }
  | { ok: false; error: string }

async function descartarPadresEstructurales(
  businessId: string,
  candidatos: SellableProduct[],
): Promise<ResultadoEstructural> {
  if (candidatos.length === 0) return { ok: true, items: candidatos }

  const filtro = buildParentReferenceFilter(candidatos.map(c => c.id))
  // Sin ids vÃ¡lidos no hay nada que validar: no es un fallo.
  if (!filtro) return { ok: true, items: candidatos }

  const { data, error } = await supabase
    .from('inventory')
    .select('parent_id,supplier_code')
    .eq('business_id', businessId)
    .or(filtro)

  if (error) return { ok: false, error: error.message }

  const padres = extractParentIds(data ?? [])
  if (padres.size === 0) return { ok: true, items: candidatos }

  return { ok: true, items: candidatos.filter(c => !padres.has(c.id)) }
}

// â”€â”€â”€ BÃºsqueda canÃ³nica â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Busca productos vendibles del negocio.
 *
 * El AND multi-token se resuelve en el servidor encadenando un `.or(...)` por
 * token: PostgREST combina con AND los parÃ¡metros de nivel superior, asÃ­ que
 * cada token debe matchear en alguno de los campos buscables. ReciÃ©n sobre ese
 * conjunto ya relevante se aplica el tope, y se pide uno de mÃ¡s para poder
 * avisar que quedÃ³ truncado en vez de mentir un "no hay resultados".
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
  // y la misma bÃºsqueda puede dar distinto resultado en dos corridas.
  q = q.order('name', { ascending: true }).order('id', { ascending: true })

  // Se piden `limit + 1` filas sÃ³lo para saber si habÃ­a mÃ¡s.
  q = q.limit(limit + 1)

  if (signal) q = q.abortSignal(signal)

  const { data, error } = await q

  if (error) {
    // Un fallo del backend NO es "no hay resultados". La superficie decide cÃ³mo
    // mostrarlo, pero jamÃ¡s puede confundirse con un catÃ¡logo vacÃ­o.
    return { status: 'error', items: [], truncated: false, error: error.message, reason: 'query' }
  }

  const candidatos = (data ?? []) as unknown as SellableProduct[]

  // â”€â”€ Segundo filtro: padres detectados por ESTRUCTURA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // `has_variants` no es confiable por sÃ­ solo: lo escribe el cliente, no hay
  // trigger que lo mantenga, y en createProductWithVariants se setea con un
  // UPDATE separado cuyo error no se chequea. Un padre que quedÃ³ con el flag
  // en false tiene stock 0 y se ofrecerÃ­a como producto fantasma.
  // Se consulta sobre los ids ya devueltos (a lo sumo limit+1), no sobre el
  // catÃ¡logo entero.
  const estructura = await descartarPadresEstructurales(businessId, candidatos)

  // Fail-closed: sin poder validar la estructura, ningÃºn candidato es seguro.
  // No se devuelve nada vendible ni se finge "sin resultados": la superficie
  // tiene que poder distinguirlo y ofrecer reintentar.
  if (!estructura.ok) {
    return {
      status: 'error',
      items: [],
      truncated: false,
      error: estructura.error,
      reason: 'variant_check',
    }
  }

  const filas = estructura.items
  const truncated = candidatos.length > limit

  // Ranking local sobre un conjunto YA relevante: acÃ¡ el orden no decide quÃ© se
  // pierde, pero SÃ decide quÃ© queda primero â€” y la primera opciÃ³n viene
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

  // SEC-08B: el costo se repone al final, sobre el puÃ±ado de filas que van a
  // pantalla, y sÃ³lo si el actor tiene autoridad. Va despuÃ©s del ranking a
  // propÃ³sito: el orden del buscador nunca dependiÃ³ del costo, y no debe
  // empezar a depender de quiÃ©n puede verlo.
  const items = await attachInventoryCosts(ordenados.slice(0, limit))

  return { status: 'ok', items: items as SellableProduct[], truncated }
}
