// ============================================================================
// Presentacion humana de la identidad fiscal.
//
// La identidad fiscal CANONICA sigue siendo la terna (PtoVta, CbteTipo,
// CbteNro) — eso vive en `fiscalIdentity.ts` y no cambia. Este modulo resuelve
// una pregunta distinta y mas chica: que numero se le muestra a una persona.
//
// EL BUG QUE CIERRA. El documento armaba el numero asi:
//
//     `${padPV(punto_venta)}-${digits(numero).padStart(8,'0')}`
//
// `numero` es el numero COMERCIAL interno y ya viene con su propio prefijo
// ('0001-00672017'), asi que sacarle los guiones y volver a prefijarlo produce
// un numero que no existe: '0001-000100672017'. Y como `numero_fiscal` no
// participaba, el comprobante 0010-00000045 —autorizado por ARCA, con su CAE
// guardado— se mostraba como '0010-000100759033'. La identidad que ARCA
// reconoce no aparecia en ninguna parte de la pantalla.
//
// LA REGLA. Si hay `numero_fiscal`, ese es el numero que se muestra: es el que
// ARCA autorizo y el unico que sirve para reclamar, auditar o cotejar. El
// numero interno solo aparece cuando no hay identidad fiscal todavia.
//
// Sin dependencias de React ni de Supabase: se testea con `node --test`.
// ============================================================================

// Extension explicita: este modulo lo carga tambien `node --test`, que no
// resuelve extensiones implicitas. tsconfig tiene allowImportingTsExtensions.
import { parseNumeroFiscal } from './fiscalIdentity.ts'

export interface ComprobanteNumeroInput {
  numero?: string | null
  numero_fiscal?: string | null
  punto_venta?: string | null
}

/** '1' | '0001' | 'PV 1' -> '0001'. */
export function padPuntoVenta(pv: string | null | undefined): string {
  return String(pv ?? '').replace(/\D/g, '').padStart(4, '0')
}

/** Forma canonica PPPP-NNNNNNNN a partir de sus dos componentes. */
function componer(puntoVenta: number, numero: number): string {
  return `${String(puntoVenta).padStart(4, '0')}-${String(numero).padStart(8, '0')}`
}

/**
 * Parseo TOLERANTE para el numero interno.
 *
 * `parseNumeroFiscal` rechaza los ceros porque en AFIP el 0 significa "no
 * emitido"; para el numero interno eso no aplica y no queremos que un caso
 * raro tire el fallback al camino que produce basura.
 */
function partirNumeroInterno(s: string | null | undefined): { pv: number; nro: number } | null {
  if (!s) return null
  const m = /^(\d{1,5})-(\d{1,12})$/.exec(s.trim())
  if (!m) return null
  return { pv: parseInt(m[1], 10), nro: parseInt(m[2], 10) }
}

/**
 * Numero que se le muestra a una persona.
 *
 * Prioridad:
 *   1. `numero_fiscal` — la identidad que autorizo ARCA.
 *   2. `numero` interno, si ya viene con forma PV-NRO (respeta su propio
 *      prefijo en vez de anteponerle otro).
 *   3. `punto_venta` + los digitos de `numero`, para los numeros sueltos.
 *   4. Marcador de "sin numero" cuando no hay nada que mostrar.
 */
export function formatearNumeroComprobante(c: ComprobanteNumeroInput): string {
  const fiscal = parseNumeroFiscal(c.numero_fiscal)
  if (fiscal) return componer(fiscal.puntoVenta, fiscal.numero)

  const interno = partirNumeroInterno(c.numero)
  if (interno) return componer(interno.pv, interno.nro)

  const pv = padPuntoVenta(c.punto_venta)
  const digitos = String(c.numero ?? '').replace(/\D/g, '')
  if (!digitos) return `${pv}---------`
  return `${pv}-${digitos.padStart(8, '0')}`
}

/**
 * ¿El numero que se esta mostrando es la identidad fiscal, o el interno?
 *
 * Sirve para no rotular "Comprobante N°" como si fuera fiscal cuando todavia no
 * lo es. No se usa para decidir permisos: para eso esta `comprobanteStatus`.
 */
export function muestraIdentidadFiscal(c: ComprobanteNumeroInput): boolean {
  return parseNumeroFiscal(c.numero_fiscal) !== null
}
