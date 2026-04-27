/**
 * searchUtils — motor de búsqueda inteligente reutilizable
 *
 * Características:
 * - Normaliza texto: minúsculas, sin acentos, sin símbolos
 * - Multi-token: "iphone juan" encuentra ítems con ambas palabras
 * - Ranking por relevancia: exacto > prefijo > substring > campo secundario
 * - Tolerante a errores de tipeo leves
 */

// ─── Normalización ────────────────────────────────────────────────────────────

/**
 * Convierte texto a forma normalizada para comparación.
 * "iPhone-11 Pró Max" → "iphone 11 pro max"
 */
export function normalizeText(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // elimina diacríticos (á→a, é→e, ñ→n, etc.)
    .replace(/[_\-.,;:()[\]{}|/\\@#]/g, ' ') // símbolos → espacio
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Divide la query en tokens no vacíos.
 * "iPhone 11 Juan" → ["iphone", "11", "juan"]
 */
export function tokenize(query: string): string[] {
  return normalizeText(query)
    .split(' ')
    .filter(t => t.length > 0)
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Puntúa qué tan bien un valor normalizado coincide con los tokens.
 * Retorna 0 si no coinciden TODOS los tokens.
 */
export function scoreValue(normalizedValue: string, tokens: string[]): number {
  if (!normalizedValue || tokens.length === 0) return 0

  let total = 0
  for (const token of tokens) {
    if (!normalizedValue.includes(token)) {
      // Intento de tolerancia leve: un token con diferencia de 1 char
      if (!fuzzyIncludes(normalizedValue, token)) return 0
      total += 10 // match difuso, puntaje bajo
      continue
    }
    if (normalizedValue === token) total += 100           // exacto
    else if (normalizedValue.startsWith(token)) total += 70  // prefijo
    else if (wordBoundaryMatch(normalizedValue, token)) total += 50 // inicio de palabra
    else total += 30                                         // substring
  }
  return total
}

/** Detecta si el token aparece al inicio de alguna palabra dentro del valor. */
function wordBoundaryMatch(text: string, token: string): boolean {
  const parts = text.split(' ')
  return parts.some(p => p.startsWith(token))
}

/** Tolerancia a 1 carácter de diferencia (inserción, sustitución o eliminación). */
function fuzzyIncludes(text: string, token: string): boolean {
  if (token.length < 3) return false // tokens cortos no tienen tolerancia
  // Comprueba si existe una subsecuencia de longitud token.length con ≤1 diferencia
  for (let i = 0; i <= text.length - token.length + 1; i++) {
    const window = text.slice(i, i + token.length)
    if (levenshtein(window, token) <= 1) return true
  }
  return false
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
  return dp[m][n]
}

// ─── SmartSearch ──────────────────────────────────────────────────────────────

export interface SearchField<T> {
  /** Obtiene el valor del campo. */
  getValue: (item: T) => string | null | undefined
  /** Multiplicador de relevancia. Default: 1. */
  weight?: number
}

/**
 * Filtra y ordena un array de items por relevancia.
 *
 * @param items - Array a filtrar
 * @param query - Texto del buscador
 * @param fields - Campos en los que buscar (en orden de prioridad)
 * @returns Items que coinciden, ordenados de mayor a menor score
 */
export function smartSearch<T>(
  items: T[],
  query: string,
  fields: SearchField<T>[]
): T[] {
  if (!query.trim()) return items

  const tokens = tokenize(query)
  if (tokens.length === 0) return items

  const scored: { item: T; score: number }[] = []

  for (const item of items) {
    let maxScore = 0

    for (const field of fields) {
      const raw = field.getValue(item)
      if (!raw) continue
      const norm = normalizeText(raw)
      const s = scoreValue(norm, tokens) * (field.weight ?? 1)
      if (s > maxScore) maxScore = s
    }

    if (maxScore > 0) scored.push({ item, score: maxScore })
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .map(s => s.item)
}

// ─── Highlight ────────────────────────────────────────────────────────────────

/**
 * Divide el texto en partes marcando las coincidencias con la query.
 *
 * @returns Array de { text, highlight } para renderizar con JSX
 *
 * @example
 * highlightParts("iPhone 11 Pro", "iphone 11")
 * → [{ text: "iPhone 11", highlight: true }, { text: " Pro", highlight: false }]
 */
export function highlightParts(
  text: string | null | undefined,
  query: string
): { text: string; highlight: boolean }[] {
  if (!text) return []
  if (!query.trim()) return [{ text, highlight: false }]

  const tokens = tokenize(query)
  if (!tokens.length) return [{ text, highlight: false }]

  // Construye un regex que une todos los tokens (case-insensitive, sin acentos)
  const pattern = tokens
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const regex = new RegExp(`(${pattern})`, 'gi')

  const parts: { text: string; highlight: boolean }[] = []
  let last = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) {
      parts.push({ text: text.slice(last, match.index), highlight: false })
    }
    parts.push({ text: match[0], highlight: true })
    last = match.index + match[0].length
  }

  if (last < text.length) {
    parts.push({ text: text.slice(last), highlight: false })
  }

  return parts.length > 0 ? parts : [{ text, highlight: false }]
}

// ─── Helpers para Supabase ────────────────────────────────────────────────────

/**
 * Genera un query string para búsqueda en Supabase usando ilike.
 * Para múltiples tokens, devuelve solo el primer token relevante
 * (Supabase no soporta full-text multi-token en una sola query).
 */
export function buildSupabaseQuery(query: string): string {
  const tokens = tokenize(query)
  if (!tokens.length) return ''
  // Usa el token más largo como query principal para Supabase
  const main = tokens.sort((a, b) => b.length - a.length)[0]
  return `%${main}%`
}
