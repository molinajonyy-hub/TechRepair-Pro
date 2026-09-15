/**
 * ARCA Self-Service Phase 2B — ayuda de carga de los datos fiscales del asistente.
 *
 * Espejo de UX de las validaciones del servidor (`arca_selfservice_prepare_initial` y
 * `private.arca_cuit_is_valid`). Sólo guía al usuario: la base vuelve a validar todo y es
 * la autoridad. Nunca inventa un CUIT.
 *
 * Módulo puro (sin React ni Supabase) para testearlo aislado.
 */

export const ARCA_CUIT_PREFIXES = ['20', '23', '24', '27', '30', '33', '34'] as const
const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const

export type ArcaAmbiente = 'homologacion' | 'produccion'

/**
 * Nombre del equipo en ARCA (CN del certificado), por ambiente. Espejo EXACTO de
 * `arca_selfservice_prepare_initial` (migración 20261002120000); el guard
 * scripts/guards/arca-wsass-alias-contract.mjs compara ambos por comportamiento.
 *   homologación: WSASS acepta sólo letras y números y usa ese nombre en el certificado
 *                 (medido en el smoke real de 2026-09-15).
 *   producción:   se conserva la regla anterior.
 */
export const ARCA_ALIAS_PATTERNS = {
  homologacion: /^[A-Za-z0-9]{3,50}$/,
  produccion: /^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/,
} as const

/** Ayuda fija bajo el campo del nombre del equipo. */
export const ARCA_ALIAS_HINT = 'ARCA usa este nombre dentro del certificado. En homologación sólo puede contener letras y números.'

export const ARCA_PUNTO_VENTA_MIN = 1
export const ARCA_PUNTO_VENTA_MAX = 99998
export const ARCA_RAZON_SOCIAL_MAX = 200

export type ArcaCuitCheck = 'empty' | 'incomplete' | 'invalid_prefix' | 'invalid_check_digit' | 'valid'

/** Sólo dígitos, como mucho 11. */
export function cuitDigits(input: string): string {
  return input.replace(/\D/g, '').slice(0, 11)
}

/** Formato progresivo XX-XXXXXXXX-X mientras se escribe. */
export function formatCuitInput(input: string): string {
  const d = cuitDigits(input)
  if (d.length <= 2) return d
  if (d.length <= 10) return `${d.slice(0, 2)}-${d.slice(2)}`
  return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`
}

/** Mismo algoritmo que `private.arca_cuit_is_valid` (módulo 11; un resultado 10 es inválido). */
export function checkCuit(input: string): ArcaCuitCheck {
  const d = cuitDigits(input)
  if (d.length === 0) return 'empty'
  if (d.length < 11) return 'incomplete'
  if (!(ARCA_CUIT_PREFIXES as readonly string[]).includes(d.slice(0, 2))) return 'invalid_prefix'
  let sum = 0
  for (let i = 0; i < 10; i++) sum += Number(d[i]) * CUIT_WEIGHTS[i]
  const raw = 11 - (sum % 11)
  if (raw === 10) return 'invalid_check_digit'
  return raw % 11 === Number(d[10]) ? 'valid' : 'invalid_check_digit'
}

export const CUIT_CHECK_MESSAGE: Readonly<Record<Exclude<ArcaCuitCheck, 'valid'>, string>> = {
  empty: 'Ingresá el CUIT del negocio.',
  incomplete: 'El CUIT tiene 11 dígitos.',
  invalid_prefix: 'El CUIT tiene que empezar con 20, 23, 24, 27, 30, 33 o 34.',
  invalid_check_digit: 'Revisá los números: el dígito verificador no coincide.',
}

/** Como `btrim(text)` del servidor: sólo recorta espacios. */
const trimSpaces = (s: string) => s.replace(/^ +| +$/g, '')

/**
 * Error del nombre del equipo según el ambiente elegido. Sin ambiente todavía se usa la regla de
 * producción (la más amplia): el formulario igual no se envía hasta elegir uno, y al elegir
 * homologación el nombre se vuelve a evaluar.
 */
export function aliasError(alias: string, ambiente: ArcaAmbiente | '' = ''): string | null {
  const value = trimSpaces(alias)
  if (value.length === 0) return 'Ingresá un nombre para identificar este equipo en ARCA.'
  if (ambiente === 'homologacion') {
    return ARCA_ALIAS_PATTERNS.homologacion.test(value)
      ? null
      : 'En homologación ARCA acepta únicamente letras y números. Usá entre 3 y 50 caracteres.'
  }
  if (value.length < 3 || value.length > 50) return 'Usá entre 3 y 50 caracteres.'
  if (!ARCA_ALIAS_PATTERNS.produccion.test(value)) return 'Usá letras sin acentos, números, puntos o guiones, empezando con letra o número.'
  return null
}

export function puntoVentaError(raw: string): string | null {
  const value = raw.trim()
  if (value.length === 0) return 'Ingresá el número de punto de venta.'
  if (!/^\d+$/.test(value)) return 'El punto de venta es un número entero.'
  const n = Number(value)
  if (n < ARCA_PUNTO_VENTA_MIN || n > ARCA_PUNTO_VENTA_MAX) return `Tiene que estar entre ${ARCA_PUNTO_VENTA_MIN} y ${ARCA_PUNTO_VENTA_MAX}.`
  return null
}

export function razonSocialError(raw: string): string | null {
  const value = raw.trim()
  if (value.length === 0) return 'Ingresá la razón social tal como figura en ARCA.'
  if (value.length > ARCA_RAZON_SOCIAL_MAX) return `Usá hasta ${ARCA_RAZON_SOCIAL_MAX} caracteres.`
  return null
}

/**
 * Propuesta editable de alias a partir del nombre del negocio (p. ej. `techrepairdemolocal`).
 * Sólo minúsculas sin acentos y números, de 3 a 50: sirve en homologación (WSASS) y en producción.
 * Nunca usa datos que el usuario no cargó: sin nombre ni CUIT propone `techrepair`.
 */
export function suggestArcaAlias(businessName: string | null | undefined, cuit?: string | null): string {
  const slug = (businessName ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  const digits = cuitDigits(cuit ?? '')
  const base = slug.length >= 2 ? `techrepair${slug}` : digits.length === 11 ? `techrepair${digits}` : 'techrepair'
  const candidate = base.slice(0, 50)
  return ARCA_ALIAS_PATTERNS.homologacion.test(candidate) && ARCA_ALIAS_PATTERNS.produccion.test(candidate) ? candidate : 'techrepair'
}

export interface ArcaFiscalDraft {
  cuit: string
  razonSocial: string
  ambiente: 'homologacion' | 'produccion' | ''
  puntoVenta: string
  alias: string
}

export type ArcaFiscalField = 'cuit' | 'razon_social' | 'ambiente' | 'punto_venta' | 'alias'

export function fiscalDraftErrors(draft: ArcaFiscalDraft): Partial<Record<ArcaFiscalField, string>> {
  const errors: Partial<Record<ArcaFiscalField, string>> = {}
  const cuit = checkCuit(draft.cuit)
  if (cuit !== 'valid') errors.cuit = CUIT_CHECK_MESSAGE[cuit]
  const razon = razonSocialError(draft.razonSocial)
  if (razon) errors.razon_social = razon
  if (draft.ambiente !== 'homologacion' && draft.ambiente !== 'produccion') errors.ambiente = 'Elegí dónde vas a emitir.'
  const pv = puntoVentaError(draft.puntoVenta)
  if (pv) errors.punto_venta = pv
  const alias = aliasError(draft.alias, draft.ambiente)
  if (alias) errors.alias = alias
  return errors
}
