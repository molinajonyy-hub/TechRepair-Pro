/**
 * P0-ONBOARDING-1 — Identidad comercial del negocio: UNA sola regla.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE ESTE ARCHIVO
 * ─────────────────────────────────────────────────────────────────────────────
 * `'Mi Negocio'` es el DEFAULT de `provision_my_business()`: un placeholder
 * TÉCNICO que existe porque `businesses.name` es NOT NULL y el tenant se crea
 * antes de que el usuario elija un nombre.
 *
 * Nunca fue un nombre que alguien haya elegido, pero cinco superficies distintas
 * lo usaban como fallback de presentación:
 *
 *   ComprobanteDocumento · ComprobantePrintLayout · ServiceOrderPrint
 *   WarrantyPrintLayout  · useOrderPrintSettings (como valor por DEFECTO)
 *
 * Con 18 de 20 negocios sin `nombre_comercial`, eso significaba comprobantes,
 * órdenes de servicio y garantías impresos que decían literalmente «Mi Negocio»
 * y se le entregaban al cliente del taller.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA REGLA
 * ─────────────────────────────────────────────────────────────────────────────
 * Un placeholder técnico JAMÁS termina impreso. Si no hay un nombre real, el
 * documento muestra vacío: es la verdad, y es recuperable (el usuario carga el
 * nombre en Configuración). Un nombre inventado no es recuperable — se imprime,
 * se entrega y queda.
 *
 * Orden de resolución:
 *   1. `nombre_comercial`  — la AUTORIDAD comercial (business_settings)
 *   2. `razon_social`      — identidad fiscal, sólo donde el contrato lo permite
 *   3. `businesses.name`   — espejo técnico, SÓLO si no es el placeholder
 *   4. `''`                — vacío honesto
 *
 * NO se inventa un nombre fiscal en ningún escalón.
 */

/** Default de `provision_my_business()`. NO es un nombre elegido por nadie. */
export const PLACEHOLDER_BUSINESS_NAME = 'Mi Negocio'

/** `true` si el valor es el placeholder técnico y no un nombre real. */
export function isPlaceholderBusinessName(value?: string | null): boolean {
  return (value ?? '').trim() === PLACEHOLDER_BUSINESS_NAME
}

interface BusinessNameSources {
  /** `business_settings.nombre_comercial` — la autoridad. */
  nombreComercial?: string | null
  /** `business_settings.razon_social` — sólo si la superficie lo admite. */
  razonSocial?: string | null
  /**
   * `businesses.name` — espejo técnico. Se descarta si es el placeholder.
   * Muchas superficies de impresión no lo tienen a mano: es opcional.
   */
  businessName?: string | null
}

/**
 * Nombre a MOSTRAR en un documento que se le entrega al cliente.
 *
 * Devuelve `''` cuando no hay ningún nombre real. Quien renderiza decide qué
 * hacer con el vacío (omitir el bloque, dejar el espacio), pero NUNCA recibe un
 * placeholder disfrazado de nombre.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DÓNDE SE FILTRA EL PLACEHOLDER — y dónde NO
 * ─────────────────────────────────────────────────────────────────────────────
 * Sólo en `businessName`, que es el ESPEJO TÉCNICO (`businesses.name`): esa
 * columna es NOT NULL y `provision_my_business()` la rellena sola, así que un
 * «Mi Negocio» ahí no lo eligió nadie.
 *
 * En `nombreComercial` NO se filtra, y es deliberado. Esa columna sólo se
 * escribe por acción explícita del usuario o por la reparación histórica, que
 * excluye el placeholder por condición (postcondición R3 de la migración
 * 20260904120000: cero filas con 'Mi Negocio' como nombre comercial). Si aun
 * así alguien TIPEA «Mi Negocio» como nombre de su negocio, es su decisión y
 * hay que respetarla: descartarla le borraría en silencio un dato real, y ese
 * es el mismo error —adivinar en lugar de leer— que produjo este lote.
 *
 * La regla queda: el placeholder no se PROPAGA nunca; un nombre elegido se
 * respeta siempre.
 */
export function resolveBusinessDisplayName({
  nombreComercial,
  razonSocial,
  businessName,
}: BusinessNameSources): string {
  const elegido = (v?: string | null): string => (v ?? '').trim()
  const tecnico = (v?: string | null): string => {
    const t = (v ?? '').trim()
    return t && !isPlaceholderBusinessName(t) ? t : ''
  }
  return elegido(nombreComercial) || elegido(razonSocial) || tecnico(businessName) || ''
}
