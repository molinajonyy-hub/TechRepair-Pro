// ============================================================================
// Identidad fiscal canónica compartida de un comprobante.
//
// La identidad fiscal de AFIP/ARCA es una TERNA:
//
//     (PtoVta, CbteTipo, CbteNro)
//
// `numero_fiscal` guarda sólo dos de los tres. Eso lo hace AMBIGUO entre tipos:
// una Factura C y su Nota de Crédito pueden compartir '0010-00000001'
// legítimamente, porque viven en series distintas (CbteTipo 11 y 13). Está
// medido en producción — no es hipotético.
//
// Corolario: cualquier igualdad, dedupe, lookup o unicidad que use
// `numero_fiscal` SOLO es incorrecta. Usar `mismaIdentidadFiscal()`.
//
// Sin dependencias de Supabase: se testea con `node --test`.
// ============================================================================

/** Códigos WSFEv1 de los comprobantes que este sistema emite. */
export const CBTE_TIPO = {
  FACTURA_A: 1,
  FACTURA_B: 6,
  FACTURA_C: 11,
  NOTA_CREDITO_A: 3,
  NOTA_CREDITO_B: 8,
  NOTA_CREDITO_C: 13,
} as const

/**
 * Correspondencia de clase fiscal para CbtesAsoc.
 *
 * Esta es la única tabla A/B/C autorizada: una Nota de Crédito siempre toma
 * su clase de la factura original, y el borde ARCA valida la relación inversa.
 */
export const CBTE_TIPO_NOTA_CREDITO_POR_FACTURA: Readonly<Record<number, number>> = {
  [CBTE_TIPO.FACTURA_A]: CBTE_TIPO.NOTA_CREDITO_A,
  [CBTE_TIPO.FACTURA_B]: CBTE_TIPO.NOTA_CREDITO_B,
  [CBTE_TIPO.FACTURA_C]: CBTE_TIPO.NOTA_CREDITO_C,
}

export const CBTE_TIPO_FACTURA_POR_NOTA_CREDITO: Readonly<Record<number, number>> = {
  [CBTE_TIPO.NOTA_CREDITO_A]: CBTE_TIPO.FACTURA_A,
  [CBTE_TIPO.NOTA_CREDITO_B]: CBTE_TIPO.FACTURA_B,
  [CBTE_TIPO.NOTA_CREDITO_C]: CBTE_TIPO.FACTURA_C,
}

export function cbteTipoNotaCreditoParaFactura(cbteTipoFactura: number): number | null {
  return CBTE_TIPO_NOTA_CREDITO_POR_FACTURA[cbteTipoFactura] ?? null
}

export function cbteTipoFacturaParaNotaCredito(cbteTipoNotaCredito: number): number | null {
  return CBTE_TIPO_FACTURA_POR_NOTA_CREDITO[cbteTipoNotaCredito] ?? null
}

export function esCbteTipoNotaCredito(cbteTipo: number): boolean {
  return cbteTipoFacturaParaNotaCredito(cbteTipo) !== null
}

/**
 * Comprueba que el CbteTipo persistido pertenezca al tipo lógico de la fila.
 * El valor persistido tiene prioridad, pero nunca puede contradecir `tipo`.
 */
export function cbteTipoCompatibleConTipo(
  tipo: string | null | undefined,
  cbteTipo: number,
): boolean {
  if (tipo === 'factura_a') return cbteTipo === CBTE_TIPO.FACTURA_A
  if (tipo === 'factura_c') return cbteTipo === CBTE_TIPO.FACTURA_C
  if (tipo === 'nota_credito') return esCbteTipoNotaCredito(cbteTipo)
  return false
}

/**
 * Derivación por `tipo` — SÓLO para los tipos con código fijo.
 *
 * `nota_credito` NO está acá a propósito: su CbteTipo depende del comprobante
 * original (A→3, B→8, C→13). Un mapa genérico que le asigne un valor fijo es
 * una trampa: manda a AFIP una NC de la clase equivocada.
 */
const CBTE_TIPO_POR_TIPO: Record<string, number> = {
  factura_a: CBTE_TIPO.FACTURA_A,
  factura_c: CBTE_TIPO.FACTURA_C,
}

/** Tipos que llevan identidad fiscal. El remito no. */
export const TIPOS_FISCALES = ['factura_a', 'factura_c', 'nota_credito'] as const

export function esTipoFiscal(tipo: string | null | undefined): boolean {
  return !!tipo && (TIPOS_FISCALES as readonly string[]).includes(tipo)
}

/** Identidad fiscal completa. Si falta una pata, no hay identidad. */
export interface FiscalIdentity {
  puntoVenta: number
  cbteTipo: number
  numero: number
}

/** Lo mínimo que hay que conocer de un comprobante para identificarlo. */
export interface ComprobanteFiscalInput {
  tipo?: string | null
  numero_fiscal?: string | null
  /** Código WSFEv1 persistido. Es la fuente PREFERIDA. */
  tipo_comprobante_fiscal?: string | number | null
}

/**
 * Resuelve el CbteTipo, o null si no se puede saber.
 *
 * Orden: el valor persistido manda; si falta, se deriva sólo para los tipos de
 * código fijo; una `nota_credito` sin código persistido devuelve **null**
 * (fail-closed). No se inventa: mandar la clase equivocada a AFIP es peor que
 * no mandar nada.
 */
export function resolverCbteTipo(c: ComprobanteFiscalInput): number | null {
  const persistido = c.tipo_comprobante_fiscal
  if (persistido !== null && persistido !== undefined && String(persistido).trim() !== '') {
    const n = Number(persistido)
    if (Number.isInteger(n) && n > 0 && cbteTipoCompatibleConTipo(c.tipo, n)) return n
    return null
  }
  if (!c.tipo) return null
  return CBTE_TIPO_POR_TIPO[c.tipo] ?? null
}

/** Parsea '0010-00000045' a sus dos componentes numéricos. */
export function parseNumeroFiscal(
  numeroFiscal: string | null | undefined,
): { puntoVenta: number; numero: number } | null {
  if (!numeroFiscal) return null
  const m = /^(\d{1,5})-(\d{1,12})$/.exec(numeroFiscal.trim())
  if (!m) return null
  const puntoVenta = parseInt(m[1], 10)
  const numero = parseInt(m[2], 10)
  // AFIP numera desde 1: un 0 significa "no emitido", no "comprobante 0".
  if (!(puntoVenta > 0) || !(numero > 0)) return null
  return { puntoVenta, numero }
}

/**
 * Identidad fiscal canónica, o null si el comprobante no la tiene.
 *
 * Devuelve null cuando: no hay `numero_fiscal`, el formato no es válido, el
 * tipo no es fiscal, o no se puede resolver el CbteTipo (NC sin código).
 */
export function fiscalIdentity(c: ComprobanteFiscalInput): FiscalIdentity | null {
  if (!esTipoFiscal(c.tipo)) return null
  const partes = parseNumeroFiscal(c.numero_fiscal)
  if (!partes) return null
  const cbteTipo = resolverCbteTipo(c)
  if (cbteTipo === null) return null
  return { puntoVenta: partes.puntoVenta, cbteTipo, numero: partes.numero }
}

/** Clave estable de la terna, para Map/Set. NUNCA usar `numero_fiscal` solo. */
export function fiscalIdentityKey(id: FiscalIdentity): string {
  return `${id.puntoVenta}-${id.cbteTipo}-${id.numero}`
}

/**
 * ¿Dos comprobantes son el MISMO comprobante fiscal?
 *
 * Falso si alguno no tiene identidad: la ausencia de identidad no equivale a
 * otra ausencia. Dos borradores no son "el mismo comprobante".
 */
export function mismaIdentidadFiscal(
  a: ComprobanteFiscalInput,
  b: ComprobanteFiscalInput,
): boolean {
  const ia = fiscalIdentity(a)
  const ib = fiscalIdentity(b)
  if (!ia || !ib) return false
  return fiscalIdentityKey(ia) === fiscalIdentityKey(ib)
}
