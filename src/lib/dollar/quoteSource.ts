/**
 * Catálogo canónico de fuentes de cotización del dólar.
 *
 * FUENTE ÚNICA DE VERDAD para: valor persistido, proveedor, etiqueta visible y
 * tag que se escribe en `exchange_rates.source`.
 *
 * Antes de P0-DÓLAR convivían tres vocabularios que se escribían sobre las
 * mismas columnas:
 *   · `business_settings.dolar_source`  → 'nacional' | 'cordoba'
 *   · `exchange_rates.source`           → 'bluelytics' | 'infodolar-cordoba' |
 *                                          'manual' | 'api' (legacy)
 *   · `dollarRateService.DollarSource`  → 'AMBITO_NACIONAL' | 'INFODOLAR_CORDOBA' | …
 * Resultado: consultas que filtraban por un vocabulario nunca encontraban las
 * filas escritas con el otro. Acá se unifican.
 *
 * El valor persistido es el del dominio/DB (`nacional` | `cordoba`), que está
 * respaldado por `business_settings_dolar_source_check`. Las etiquetas visibles
 * NUNCA se persisten.
 */

// ─── Fuente configurable por el negocio ───────────────────────────────────────

export type DolarSource = 'nacional' | 'cordoba'

/**
 * Default canónico. Coincide EXACTAMENTE con el default de la columna
 * `business_settings.dolar_source` ('nacional').
 *
 * No es cosmético: `dollarRateService` defaulteaba a 'cordoba' cuando el
 * negocio no tenía fila de settings, así que un negocio recién creado cotizaba
 * Córdoba mientras la pantalla de Configuración mostraba Nacional.
 */
export const DEFAULT_DOLAR_SOURCE: DolarSource = 'nacional'

/** Tag canónico que se escribe en `exchange_rates.source`. */
export type RateSourceTag =
  | 'bluelytics'
  | 'infodolar-cordoba'
  | 'dolarapi'
  | 'manual'
  | 'desconocido'

export const MANUAL_RATE_SOURCE_TAG: RateSourceTag = 'manual'

export interface DolarSourceDescriptor {
  /** Valor persistido en `business_settings.dolar_source`. */
  readonly source: DolarSource
  /** Etiqueta corta para el selector. */
  readonly label: string
  /** Proveedor real detrás de la fuente. */
  readonly providerLabel: string
  /** Tag canónico escrito en `exchange_rates.source`. */
  readonly rateSourceTag: RateSourceTag
}

export const DOLAR_SOURCES: Readonly<Record<DolarSource, DolarSourceDescriptor>> = {
  nacional: {
    source:        'nacional',
    label:         'Blue Nacional',
    providerLabel: 'Bluelytics',
    rateSourceTag: 'bluelytics',
  },
  cordoba: {
    source:        'cordoba',
    label:         'Blue Córdoba',
    providerLabel: 'InfoDolar Córdoba',
    rateSourceTag: 'infodolar-cordoba',
  },
}

/** Orden estable para renderizar el selector. */
export const DOLAR_SOURCE_ORDER: readonly DolarSource[] = ['nacional', 'cordoba']

export function isDolarSource(value: unknown): value is DolarSource {
  return value === 'nacional' || value === 'cordoba'
}

export function describeDolarSource(source: DolarSource): DolarSourceDescriptor {
  return DOLAR_SOURCES[source]
}

export interface NormalizedDolarSource {
  readonly source: DolarSource
  /** false cuando el valor crudo no era una fuente conocida (null, '', typo, alias retirado). */
  readonly recognized: boolean
}

/**
 * Normaliza el valor crudo leído de la DB o de un payload.
 *
 * FAIL-CLOSED: lo desconocido cae en el default de la columna ('nacional'),
 * NUNCA en Córdoba. Sustituir en silencio la fuente configurada por otra es
 * precisamente el bug que este lote cierra.
 */
export function normalizeDolarSource(raw: unknown): NormalizedDolarSource {
  if (isDolarSource(raw)) return { source: raw, recognized: true }

  if (typeof raw === 'string') {
    const key = raw.trim().toLowerCase()
    if (isDolarSource(key)) return { source: key, recognized: true }
  }

  return { source: DEFAULT_DOLAR_SOURCE, recognized: false }
}

// ─── Normalización de `exchange_rates.source` ─────────────────────────────────

/**
 * Aliases históricos observados en producción.
 *
 * `api` quedó de una versión anterior y NO identifica al proveedor: mapearlo a
 * uno concreto sería inventar procedencia, así que se normaliza a
 * 'desconocido'. Sólo afecta a la etiqueta mostrada, nunca a la cotización.
 */
const RATE_SOURCE_ALIASES: Readonly<Record<string, RateSourceTag>> = {
  'bluelytics':        'bluelytics',
  'ambito-nacional':   'bluelytics',
  'ambito':            'bluelytics',
  'nacional':          'bluelytics',
  'infodolar-cordoba': 'infodolar-cordoba',
  'infodolar':         'infodolar-cordoba',
  'cordoba':           'infodolar-cordoba',
  'dolarapi':          'dolarapi',
  'manual':            'manual',
  'db-cache':          'desconocido',
  'api':               'desconocido',
}

/**
 * Normaliza cualquier grafía histórica de `exchange_rates.source` al tag
 * canónico. Case-insensitive y tolerante a `_` vs `-`.
 *
 * Sin esto, `.eq('source', 'infodolar-cordoba')` no encontraba ninguna de las
 * filas escritas como `INFODOLAR_CORDOBA` — que en producción son la mayoría.
 */
export function normalizeRateSourceTag(raw: unknown): RateSourceTag {
  if (typeof raw !== 'string') return 'desconocido'
  const key = raw.trim().toLowerCase().replace(/_/g, '-')
  return RATE_SOURCE_ALIASES[key] ?? 'desconocido'
}

/**
 * Todas las grafías conocidas de un tag canónico. Se usa para construir filtros
 * `.in('source', …)` que sí alcanzan a las filas históricas.
 */
export function rateSourceSpellings(tag: RateSourceTag): string[] {
  const base = Object.keys(RATE_SOURCE_ALIASES).filter(k => RATE_SOURCE_ALIASES[k] === tag)
  const out = new Set<string>()
  for (const spelling of base) {
    out.add(spelling)
    out.add(spelling.toUpperCase())
    out.add(spelling.replace(/-/g, '_'))
    out.add(spelling.replace(/-/g, '_').toUpperCase())
  }
  return [...out]
}

export const RATE_SOURCE_LABELS: Readonly<Record<RateSourceTag, string>> = {
  'bluelytics':        'Blue Nacional · Bluelytics',
  'infodolar-cordoba': 'Blue Córdoba · InfoDolar',
  'dolarapi':          'DolarAPI',
  'manual':            'Manual',
  'desconocido':       'Origen no identificado',
}

export function describeRateSource(raw: unknown): string {
  return RATE_SOURCE_LABELS[normalizeRateSourceTag(raw)]
}

// ─── Resultado de una consulta de cotización ──────────────────────────────────

/** Por qué falló una consulta al proveedor. Nunca se colapsa a "sin datos". */
export type QuoteFailureReason =
  | 'timeout'
  | 'unreachable'
  | 'http_error'
  | 'invalid_payload'
  | 'missing_price'

export interface QuoteSuccess {
  readonly ok: true
  readonly source: DolarSource
  /** Precio de VENTA — el único que se aplica a precios dolarizados. */
  readonly sell: number
  /** Precio de compra, sólo informativo. null si el proveedor no lo expone. */
  readonly buy: number | null
  readonly fetchedAt: string
  readonly strategy?: string
}

export interface QuoteFailure {
  readonly ok: false
  readonly source: DolarSource
  readonly reason: QuoteFailureReason
  /** Mensaje ya redactado para el usuario — sin JSON crudo ni códigos HTTP. */
  readonly message: string
}

export type QuoteOutcome = QuoteSuccess | QuoteFailure

/** Rango plausible del blue en ARS. Fuera de esto el payload no se acepta. */
export const MIN_PLAUSIBLE_RATE = 500
export const MAX_PLAUSIBLE_RATE = 10_000

export function isPlausibleRate(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > MIN_PLAUSIBLE_RATE
    && value < MAX_PLAUSIBLE_RATE
}

/** Mensaje de error por fuente y motivo. Explícito, nunca "Failed to fetch". */
export function quoteFailureMessage(source: DolarSource, reason: QuoteFailureReason): string {
  const nombre = DOLAR_SOURCES[source].label
  switch (reason) {
    case 'timeout':
      return `No pudimos obtener ${nombre}: la fuente tardó demasiado en responder. No se actualizaron precios.`
    case 'unreachable':
      return `No pudimos conectarnos con ${nombre}. Revisá tu conexión e intentá de nuevo. No se actualizaron precios.`
    case 'http_error':
      return `${nombre} no está disponible en este momento. Intentá de nuevo en unos minutos. No se actualizaron precios.`
    case 'invalid_payload':
      return `${nombre} respondió con un formato que no pudimos interpretar. No se actualizaron precios.`
    case 'missing_price':
      return `No pudimos detectar el valor de venta de ${nombre}. No se actualizaron precios.`
  }
}
