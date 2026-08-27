/**
 * Construcción pura de la búsqueda de clientes del POS.
 *
 * El servidor recibe un filtro por cada término (AND entre términos) y cada
 * filtro puede coincidir por nombre, teléfono o documento. Los identificadores
 * se buscan también con comodines entre caracteres para tolerar las formas
 * históricas (`DNI: 30.123.456`, `20-30123456-7`) sin reescribir datos.
 */
import { parseStoredDocument } from '../features/customer-core/document.ts'
import { tokenize } from '../utils/searchUtils.ts'

export const POS_CUSTOMER_MIN_QUERY_LENGTH = 2

export const POS_CUSTOMER_MATCH_COLUMNS = ['name', 'phone', 'document'] as const

export function sanitizePosCustomerTerm(term: string): string {
  return term.replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * DNI/CUIT/telefonos escritos con separadores se convierten en un solo término.
 * Para nombres se conservan todos los tokens, de modo que "Ana Gomez" se
 * resuelva en el servidor y no sobre un subconjunto precortado.
 */
export function buildPosCustomerSearchTerms(query: string): string[] {
  const raw = query.trim()
  if (!raw) return []

  const hasDocumentPrefix = /^(dni|cuit)\b/i.test(raw)
  const isSeparatedIdentifier = /^[\d\s().+\-/:]+$/.test(raw) && /\d/.test(raw)

  if (hasDocumentPrefix || isSeparatedIdentifier) {
    const body = sanitizePosCustomerTerm(parseStoredDocument(raw).body.toLowerCase())
    return body ? [body] : []
  }

  return tokenize(raw).map(sanitizePosCustomerTerm).filter(Boolean)
}

function flexibleIdentifierPattern(term: string): string | null {
  if (term.length < 5 || !/\d/.test(term)) return null
  return term.split('').join('%')
}

/** Filtro OR de PostgREST para un término ya saneado. */
export function buildPosCustomerTokenOrFilter(term: string): string {
  const safe = sanitizePosCustomerTerm(term)
  if (!safe) return ''

  const filters = POS_CUSTOMER_MATCH_COLUMNS.map(column => `${column}.ilike.%${safe}%`)
  const flexible = flexibleIdentifierPattern(safe)

  if (flexible) {
    filters.push(`phone.ilike.%${flexible}%`, `document.ilike.%${flexible}%`)
  }

  return [...new Set(filters)].join(',')
}
