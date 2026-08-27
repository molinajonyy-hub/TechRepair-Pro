/**
 * Documento del cliente — normalización canónica.
 *
 * CONTEXTO. `customers.document` es UNA sola columna `text` libre. No existe
 * `document_type` en la base, así que el tipo (DNI / CUIT) tiene que viajar
 * dentro del propio valor o se pierde.
 *
 * Antes de este módulo había dos escrituras incompatibles:
 *
 *   NewCustomer  → `"DNI: 30.123.456"`  (prefijo + lo que tipeó el usuario)
 *   NewOrder     → `"30.123.456"`       (crudo, y el tipo sólo estaba en el label)
 *
 * FORMATO CANÓNICO PARA ESCRITURAS NUEVAS:
 *
 *   `<TIPO> <cuerpo>`   ej. `DNI 30123456` · `CUIT 20301234567`
 *
 * Por qué ese y no otro:
 *
 *  - Preserva la distinción DNI/CUIT, que es la única forma de reconstruir el
 *    `DocTipo` de ARCA (96 = DNI, 80 = CUIT). Hoy `comprobanteService` manda
 *    99/0 fijo con un TODO explícito de "cargar de cliente"; cuando ese lote
 *    llegue, el dato tiene que estar acá y ser legible.
 *  - El cuerpo va sin separadores, así la búsqueda es determinista: buscar
 *    `30123456` encuentra la fila. Con `30.123.456` guardado, no la encontraba.
 *  - `Customers.tsx` empareja el import de Excel con `document.eq.<valor>`
 *    (igualdad exacta): un formato estable es lo único que hace que ese
 *    emparejamiento sea reproducible.
 *  - `afip-cae/logic.ts` ya hace `.replace(/\D/g,'')` sobre el número, así que
 *    el prefijo no lo molesta.
 *
 * NO se migran filas históricas en este lote. Por eso `parseStoredDocument`
 * es deliberadamente tolerante y entiende TODAS las formas que existen hoy.
 */

export type DocumentType = 'dni' | 'cuit'

export const DOCUMENT_TYPES: readonly DocumentType[] = ['dni', 'cuit'] as const

export interface ParsedDocument {
  /** Tipo declarado en el valor guardado, o `null` si la fila no lo trae. */
  type: DocumentType | null
  /** Cuerpo alfanumérico en mayúsculas, sin separadores. Puede ser ''. */
  body: string
  /** Sólo los dígitos del cuerpo — lo que ARCA necesita como DocNro. */
  digits: string
}

const EMPTY_PARSED: ParsedDocument = { type: null, body: '', digits: '' }

/**
 * Deja el cuerpo en alfanumérico mayúscula.
 *
 * No se filtra a sólo-dígitos a propósito: hay clientes que cargan pasaporte u
 * otro identificador con letras, y tirar las letras sería pérdida de datos
 * silenciosa. `30.123.456` → `30123456`; `20-30123456-7` → `20301234567`;
 * `AB123456` → `AB123456`.
 */
function normalizeBody(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

/**
 * Convierte lo que tipeó el usuario en el valor canónico a persistir.
 * Devuelve `undefined` cuando no hay documento que guardar.
 */
export function normalizeDocumentInput(
  type: DocumentType,
  raw: string | null | undefined
): string | undefined {
  const body = normalizeBody(raw ?? '')
  if (!body) return undefined
  return `${type.toUpperCase()} ${body}`
}

/**
 * Lee un valor guardado, en cualquiera de las formas que conviven en la tabla.
 *
 * Entiende: `DNI 30123456` (canónico), `DNI: 30.123.456` (legacy NewCustomer),
 * `30.123.456` (legacy NewOrder / import de Excel), y variantes en minúscula.
 */
export function parseStoredDocument(stored: string | null | undefined): ParsedDocument {
  const value = (stored ?? '').trim()
  if (!value) return EMPTY_PARSED

  const prefixed = /^(dni|cuit)\s*:?\s*(.*)$/i.exec(value)
  const type = prefixed ? (prefixed[1].toLowerCase() as DocumentType) : null
  const body = normalizeBody(prefixed ? prefixed[2] : value)

  return { type, body, digits: body.replace(/\D/g, '') }
}

/**
 * Texto para mostrar. Los valores sin tipo se muestran tal cual vinieron: no
 * se les inventa un DNI/CUIT que la fila nunca declaró.
 */
export function formatStoredDocument(stored: string | null | undefined): string {
  const { type, body } = parseStoredDocument(stored)
  if (!body) return ''
  return type ? `${type.toUpperCase()} ${body}` : body
}

/**
 * Términos con los que una fila debe poder encontrarse.
 *
 * Necesario para NO regresionar la búsqueda mientras conviven formatos: una
 * fila histórica `DNI: 30.123.456` tiene que seguir apareciendo cuando el
 * usuario tipea `30.123.456`, y una fila nueva `DNI 30123456` cuando tipea
 * `30123456`. Devolver ambas representaciones cubre los dos casos sin tocar
 * ninguna fila.
 */
export function documentSearchTokens(stored: string | null | undefined): string[] {
  const value = (stored ?? '').trim()
  if (!value) return []

  const { type, body, digits } = parseStoredDocument(value)
  const tokens = new Set<string>([value])

  if (body) tokens.add(body)
  if (digits) tokens.add(digits)
  if (type && body) tokens.add(`${type.toUpperCase()} ${body}`)

  return [...tokens]
}

/**
 * Tipo de documento por defecto según el tipo de cliente.
 *
 * Formaliza lo que las dos pantallas ya insinuaban por separado: el diálogo
 * rápido rotulaba el campo "CUIT" para mayorista y "DNI" para minorista. Acá
 * pasa a ser una regla del core, y el usuario la puede sobreescribir.
 */
export function defaultDocumentTypeFor(customerType: 'minorista' | 'mayorista'): DocumentType {
  return customerType === 'mayorista' ? 'cuit' : 'dni'
}
