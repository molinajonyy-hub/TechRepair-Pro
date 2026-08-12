/**
 * productSearchQuery — construcción PURA de la búsqueda de productos.
 *
 * Separado del servicio para poder testear sin red la parte que causó el P0:
 * cómo se traduce el texto del cajero a filtros de servidor.
 *
 * ── LA REGLA QUE SE ROMPIÓ ────────────────────────────────────────────────
 * La versión anterior mandaba UN SOLO token al servidor (el más largo), traía
 * un tope de filas y recién ahí filtraba por el resto de los tokens en React.
 * Con catálogo real eso descarta resultados válidos antes de mirarlos: el tope
 * se aplicaba sobre un universo mucho más grande que el relevante.
 *
 * Acá cada token produce su propio filtro y TODOS deben cumplirse en el
 * servidor, así el tope recae sobre un conjunto ya relevante.
 */
// Extensión explícita: ver la nota en productSellability.ts.
import { tokenize, normalizeText } from '../utils/searchUtils.ts'
import { VARIANT_PARENT_PREFIXES, getVariantParentId } from './productSellability.ts'

/** Campos donde puede caer un token. Un solo lugar para todas las superficies. */
export const PRODUCT_MATCH_COLUMNS = [
  'name',
  'variant_name',
  'code',
  'subcategory',
  'category',
] as const

/** Longitud mínima de query normalizada. Por debajo no se consulta al servidor. */
export const MIN_QUERY_LENGTH = 2

/**
 * Deja el token seguro para incrustar en un filtro `or=(...)` de PostgREST.
 *
 * `tokenize` ya saca la mayoría de los símbolos, pero no `%` ni `_` (comodines
 * de LIKE) ni comillas, comas o paréntesis, que romperían la sintaxis del
 * filtro o cambiarían su significado. Se conserva sólo lo alfanumérico —
 * incluidos acentos y dígitos— porque es lo único que aporta a la coincidencia.
 */
export function sanitizeToken(token: string): string {
  return token.replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * Tokens listos para el servidor: normalizados, saneados y sin vacíos.
 *
 * Devuelve [] cuando no hay nada buscable; el llamador NO debe consultar.
 */
export function buildSearchTokens(query: string): string[] {
  return tokenize(query).map(sanitizeToken).filter(Boolean)
}

/**
 * Filtro `or` de PostgREST para UN token: matchea en cualquier campo buscable.
 * Los filtros de varios tokens se combinan con AND encadenando `.or()`.
 */
export function buildTokenOrFilter(token: string): string {
  return PRODUCT_MATCH_COLUMNS.map(col => `${col}.ilike.%${token}%`).join(',')
}

// ─── Detección estructural de padre ─────────────────────────────────────────

/**
 * Filtro para saber cuáles de `ids` son referenciados como PADRE por alguna
 * fila del negocio, por cualquiera de las tres representaciones.
 *
 * ── POR QUÉ NO ALCANZA `has_variants` ─────────────────────────────────────
 * Ese flag lo escribe el cliente y NO hay trigger que lo mantenga. En
 * `createProductWithVariants` se setea con un UPDATE separado cuyo error nunca
 * se chequea: si falla, las variantes se crean igual con `parent_id` apuntando
 * a un padre que quedó en `has_variants = false`. Ese padre tiene stock 0 y
 * sería vendible — un ítem fantasma en la caja.
 *
 * Por eso la vendibilidad se decide con las DOS señales: el flag y la
 * estructura real. La estructura manda.
 *
 * Los ids vienen de filas ya devueltas por el servidor (son UUIDs de la propia
 * base), así que no hay texto de usuario acá; aun así se filtra a hexadecimal
 * y guiones antes de incrustarlos.
 */
export function buildParentReferenceFilter(ids: string[]): string | null {
  const limpios = ids.filter(id => /^[0-9a-fA-F-]{36}$/.test(id))
  if (limpios.length === 0) return null

  // `supplier_code` guarda el vínculo como '<prefijo><uuid>'. Los valores se
  // citan porque contienen ':' y '-', que la lista `in.()` interpreta.
  const referencias = limpios.flatMap(id =>
    VARIANT_PARENT_PREFIXES.map(p => `"${p}${id}"`),
  )

  return `parent_id.in.(${limpios.join(',')}),supplier_code.in.(${referencias.join(',')})`
}

/**
 * A partir de las filas hijas encontradas, devuelve el conjunto de ids que
 * están actuando como padre. Reusa `getVariantParentId` para no tener un
 * segundo criterio de vínculo padre→hijo dando vueltas.
 */
export function extractParentIds(
  hijos: Array<{ parent_id?: string | null; supplier_code?: string | null }>,
): Set<string> {
  const padres = new Set<string>()
  for (const hijo of hijos) {
    const padre = getVariantParentId(hijo)
    if (padre) padres.add(padre)
  }
  return padres
}

// ─── Relevancia ─────────────────────────────────────────────────────────────

/**
 * Bonus de relevancia por coincidencia de FRASE COMPLETA.
 *
 * ── POR QUÉ HACE FALTA ────────────────────────────────────────────────────
 * El scoring por tokens sueltos puntúa cada palabra por separado, así que un
 * producto ajeno puede ganarle al buscado por coincidencias accidentales en
 * campos de mucho peso. Medido con el fixture: buscando
 * "Funda Silicone iPhone 15", el relleno "Silicone iPhone Generico 150" salía
 * PRIMERO porque su código `SRCH-FILL-150` matchea el token "15" en `code`,
 * que pesa más que `name`.
 *
 * Eso no es un detalle cosmético: la primera opción viene resaltada y Enter la
 * agrega, así que buscar el nombre exacto del producto y confirmar cargaba
 * OTRO producto al carrito.
 *
 * El bonus es escalonado y determinista —nada de fuzzy— y respeta el orden que
 * pide el contrato: SKU exacto > nombre exacto > prefijo > frase contenida.
 */
export function phraseRelevanceBonus(
  producto: { name?: string | null; code?: string | null; variant_name?: string | null },
  query: string,
): number {
  const q = normalizeText(query)
  if (!q) return 0

  const code = normalizeText(producto.code)
  const name = normalizeText(producto.name)
  // Etiqueta comercial completa: cubre las dos representaciones de variante
  // (atributo dentro de `name`, o aparte en `variant_name`).
  const completo = normalizeText(
    [producto.name, producto.variant_name].filter(Boolean).join(' '),
  )

  if (code && code === q) return 10_000                 // SKU exacto
  if (name === q || completo === q) return 5_000        // nombre exacto
  if (completo.startsWith(q) || name.startsWith(q)) return 2_000 // prefijo
  if (completo.includes(q)) return 1_000                // frase contenida
  return 0
}

/**
 * Ordena por relevancia de frase, conservando el orden previo dentro de cada
 * escalón. La entrada ya viene rankeada por tokens, así que el resultado es
 * "primero lo que coincide como frase, y dentro de eso lo mejor puntuado".
 */
export function sortByPhraseRelevance<T extends { name?: string | null; code?: string | null; variant_name?: string | null }>(
  items: T[],
  query: string,
): T[] {
  return items
    .map((item, i) => ({ item, i, bonus: phraseRelevanceBonus(item, query) }))
    // Orden estable explícito: ante el mismo bonus manda la posición original.
    .sort((a, b) => (b.bonus - a.bonus) || (a.i - b.i))
    .map(x => x.item)
}
