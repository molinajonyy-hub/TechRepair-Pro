// ============================================================================
// Identidad fiscal de un comprobante — parte PURA.
//
// Un comprobante tiene DOS numeraciones y confundirlas fue un P0:
//
//   · numero        — número LOCAL. Lo asigna el checkout con el PV que resuelve
//                     el servidor. Existe desde que se cobra, sin CAE.
//   · numero_fiscal — número FISCAL. Lo escribe complete_arca_attempt con el
//                     punto de venta de arca_config y el número que autorizó
//                     AFIP. Es la ÚNICA identidad fiscal real.
//
// Regla: si hay numero_fiscal, manda numero_fiscal. Si no lo hay, el documento
// NO tiene identidad fiscal y el número local debe presentarse rotulado como
// interno — nunca como si fuera un comprobante emitido.
//
// Sin dependencias de Supabase: se testea con `node --test`.
// ============================================================================

/** Tipos que llevan identidad fiscal (piden CAE). El remito no. */
export const TIPOS_FISCALES = ['factura_a', 'factura_c', 'nota_credito'] as const

export function esTipoFiscal(tipo: string | null | undefined): boolean {
  return !!tipo && (TIPOS_FISCALES as readonly string[]).includes(tipo)
}

export interface IdentidadFiscal {
  /** Punto de venta tal como lo autorizó AFIP, 4 dígitos. */
  puntoVenta: string
  /** Número de comprobante autorizado, 8 dígitos. */
  numero: string
  /** Representación canónica "0003-00000012". */
  completo: string
}

/**
 * Parsea `numero_fiscal` ("0003-00000012") a sus dos componentes.
 *
 * Devuelve null si el valor no tiene la forma esperada. Fail-closed a
 * propósito: quien llama debe decidir explícitamente qué hacer sin identidad
 * fiscal, en vez de recibir un valor inventado. Es exactamente el fallback que
 * mandaba el punto de venta LOCAL a AFIP dentro del CbtesAsoc de una NC.
 */
export function parseNumeroFiscal(numeroFiscal: string | null | undefined): IdentidadFiscal | null {
  if (!numeroFiscal) return null
  const m = /^(\d{1,5})-(\d{1,12})$/.exec(numeroFiscal.trim())
  if (!m) return null
  const pv = parseInt(m[1], 10)
  const nro = parseInt(m[2], 10)
  // AFIP numera desde 1: un 0 acá significa "no emitido", no "comprobante 0".
  if (!Number.isFinite(pv) || !Number.isFinite(nro) || pv <= 0 || nro <= 0) return null
  return {
    puntoVenta: String(pv).padStart(4, '0'),
    numero: String(nro).padStart(8, '0'),
    completo: `${String(pv).padStart(4, '0')}-${String(nro).padStart(8, '0')}`,
  }
}

/** Lo mínimo que necesita conocerse de un comprobante para identificarlo. */
export interface ComprobanteIdentificable {
  tipo?: string | null
  numero?: string | null
  numero_fiscal?: string | null
  punto_venta?: string | null
}

export interface IdentidadVisible {
  /** Texto principal a mostrar como número del comprobante. */
  texto: string
  /** Punto de venta a mostrar, o null si todavía no hay ninguno confiable. */
  puntoVenta: string | null
  /** true sólo si el número mostrado es el que autorizó AFIP. */
  esFiscalEmitido: boolean
  /**
   * true si el documento es de tipo fiscal pero todavía no tiene CAE: la UI
   * debe rotular el número como interno y no presentarlo como emitido.
   */
  pendienteDeEmision: boolean
}

/** Normaliza un PV local a 4 dígitos. Sólo para documentos NO fiscales. */
export function padPuntoVenta(pv: string | null | undefined): string | null {
  if (!pv) return null
  const soloDigitos = pv.replace(/\D/g, '')
  return soloDigitos ? soloDigitos.padStart(4, '0') : null
}

/**
 * Resuelve qué número y qué punto de venta mostrarle al usuario.
 *
 * - fiscal CON numero_fiscal  → manda numero_fiscal (número y PV de AFIP).
 * - fiscal SIN numero_fiscal  → número local rotulado como interno.
 * - no fiscal (remito)        → número local, que es su identidad legítima.
 */
export function identidadVisible(c: ComprobanteIdentificable): IdentidadVisible {
  const fiscal = parseNumeroFiscal(c.numero_fiscal)
  if (fiscal) {
    return {
      texto: fiscal.completo,
      puntoVenta: fiscal.puntoVenta,
      esFiscalEmitido: true,
      pendienteDeEmision: false,
    }
  }

  const local = c.numero?.trim() || null
  const esFiscal = esTipoFiscal(c.tipo)

  return {
    texto: local ?? '—',
    // Un tipo fiscal sin CAE no tiene punto de venta que mostrar: el local no
    // es su PV fiscal y presentarlo como tal fue el defecto.
    puntoVenta: esFiscal ? null : padPuntoVenta(c.punto_venta),
    esFiscalEmitido: false,
    pendienteDeEmision: esFiscal,
  }
}
