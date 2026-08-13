// ============================================================================
// Punto de venta — parte PURA: formato y lectura del resultado.
//
// Vive separado de salesPointService porque ese importa el cliente de Supabase,
// que no se puede cargar bajo `node --test`. Mismo corte que
// productSearchQuery.ts / productSearchService.ts.
// ============================================================================

/** Ancho fiscal del punto de venta tal como se imprime en el comprobante. */
export const ANCHO_PUNTO_VENTA = 4

/** Punto de venta por defecto cuando el comercio no configuró ninguno. */
export const PUNTO_VENTA_POR_DEFECTO = '0001'

/** Fila de `sales_points` acotada a lo que consume el POS. */
export interface SalesPoint {
  id: string
  numero: number
  nombre: string
  activo: boolean
  predeterminado: boolean
}

/**
 * Resultado de buscar el punto de venta activo.
 *
 * `salesPoint: null` es ambiguo por sí solo, así que viene con `fallo`: sin ese
 * flag, un error de red o de permisos se leería como "el comercio no tiene
 * puntos de venta", que es exactamente el bug que se está cerrando. Quien
 * consuma esto decide explícitamente qué hace en cada caso.
 */
export interface ResultadoPuntoVentaActivo {
  salesPoint: SalesPoint | null
  /** true si la consulta falló. NO significa "no hay punto de venta". */
  fallo: boolean
}

/** Formatea el número de PV al ancho fiscal: 7 → "0007". */
export function formatearPuntoVenta(numero: number): string {
  return String(numero).padStart(ANCHO_PUNTO_VENTA, '0')
}

/**
 * Traduce la respuesta de PostgREST al resultado del servicio.
 *
 * Es el punto exacto donde se perdía el error: el código viejo desestructuraba
 * sólo `data` y un 400 quedaba indistinguible de "no hay filas".
 */
export function interpretarRespuestaPuntoVenta(
  respuesta: { data: unknown; error: unknown },
): ResultadoPuntoVentaActivo {
  if (respuesta.error) return { salesPoint: null, fallo: true }
  return { salesPoint: (respuesta.data as SalesPoint | null) ?? null, fallo: false }
}
