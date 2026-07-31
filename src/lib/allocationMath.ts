// ─────────────────────────────────────────────────────────────────────────────
// P0-A.1U2 — Aritmética de la imputación, en CENTAVOS enteros.
//
// Por qué enteros: sumar importes en punto flotante produce 0.1 + 0.2 = 0.30000000000000004,
// y una comparación "¿supera el crédito?" con ese error decide mal en el borde
// exacto — justo el caso que más importa. Todo el módulo trabaja en centavos y
// sólo convierte a pesos para mostrar.
//
// La UI valida para prevenir errores obvios; la RPC sigue siendo la autoridad.
// Estas funciones NO consultan nada: reciben lo que el servidor devolvió.
// ─────────────────────────────────────────────────────────────────────────────

/** Pesos → centavos enteros. Redondeo estable frente a artefactos binarios. */
export const aCentavos = (pesos: number): number => Math.round((Number(pesos) + Number.EPSILON) * 100)

/** Centavos → pesos. */
export const aPesos = (centavos: number): number => centavos / 100

/** Parsea lo que el usuario tipeó. Vacío o inválido = 0, nunca NaN. */
export function parseImporte(texto: string): number {
  const limpio = String(texto ?? '').replace(/\./g, '').replace(',', '.').trim()
  if (!limpio) return 0
  const n = Number(limpio)
  return Number.isFinite(n) && n > 0 ? aCentavos(n) : 0
}

export interface DocumentoAbierto {
  comprobante_id: string
  numero: string | null
  order_id: string | null
  fecha: string
  total: number
  saldo_documento: number
  imputado: number
  /** Lo máximo que se puede aplicar a este documento, según el servidor. */
  saldo_imputable: number
}

export interface CreditoDisponible {
  payment_movement_id: string
  payment_date: string
  payment_amount: number
  allocated_amount: number
  unallocated_amount: number
}

/** Una línea del reparto: cuánto se aplica a cada documento. */
export type Reparto = Record<string, number>   // comprobante_id -> centavos

export interface ValidacionReparto {
  /** Total asignado, en centavos. */
  totalAsignado: number
  /** Crédito que quedará sin imputar, en centavos. Nunca negativo. */
  remanente: number
  /** Motivo por el cual NO se puede confirmar. null = se puede. */
  bloqueo: string | null
  /** Documentos con un importe que supera su propio saldo imputable. */
  excedidos: string[]
}

/**
 * Valida un reparto contra el crédito disponible y el saldo de cada documento.
 * Todo en centavos: sin tolerancias improvisadas ni comparaciones de floats.
 */
export function validarReparto(
  reparto: Reparto,
  creditoDisponible: number,      // centavos
  documentos: DocumentoAbierto[],
): ValidacionReparto {
  const porDoc = new Map(documentos.map(d => [d.comprobante_id, aCentavos(d.saldo_imputable)]))
  let total = 0
  const excedidos: string[] = []

  for (const [id, centavos] of Object.entries(reparto)) {
    if (centavos <= 0) continue
    total += centavos
    const tope = porDoc.get(id)
    // Un documento que no está en la lista abierta no es imputable: puede haber
    // sido pagado o anulado mientras el modal estaba abierto.
    if (tope === undefined || centavos > tope) excedidos.push(id)
  }

  let bloqueo: string | null = null
  if (total <= 0) {
    bloqueo = 'Asigná un importe a por lo menos un comprobante.'
  } else if (total > creditoDisponible) {
    bloqueo = 'El total asignado supera el crédito disponible de este cobro.'
  } else if (excedidos.length > 0) {
    bloqueo = 'Hay un importe mayor al saldo pendiente del comprobante.'
  }

  return {
    totalAsignado: total,
    remanente: Math.max(0, creditoDisponible - total),
    bloqueo,
    excedidos,
  }
}

/** Saldo que quedará en un documento después de aplicar el reparto (centavos). */
export function saldoEsperado(doc: DocumentoAbierto, reparto: Reparto): number {
  return Math.max(0, aCentavos(doc.saldo_imputable) - (reparto[doc.comprobante_id] ?? 0))
}

/** Formato de moneda para mostrar. Recibe CENTAVOS. */
export const fmtCentavos = (centavos: number): string =>
  '$' + aPesos(centavos).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

/**
 * Mensaje de usuario para un error del servidor. Nunca se muestra SQL crudo.
 * `esConflicto` indica que los importes cambiaron y hay que refrescar antes de
 * reintentar — jamás se reintenta solo.
 */
export function mensajeDeError(errorCode?: string, error?: string): { texto: string; esConflicto: boolean } {
  const crudo = `${errorCode ?? ''} ${error ?? ''}`
  const CONFLICTO =
    'El saldo cambió mientras realizabas la operación. Actualizamos la información; ' +
    'revisá los importes antes de confirmar nuevamente.'

  if (/EXCEEDS_PAYMENT|EXCEEDS_BALANCE|ALREADY_REVERSED|ON_ANNULLED/.test(crudo)) {
    return { texto: CONFLICTO, esConflicto: true }
  }
  if (/IDEMPOTENCY/.test(crudo)) {
    return { texto: CONFLICTO, esConflicto: true }
  }
  if (/FORBIDDEN/.test(crudo)) {
    return { texto: 'Tu rol no tiene permiso para esta operación.', esConflicto: false }
  }
  if (/UNAUTHORIZED/.test(crudo)) {
    return { texto: 'Tu sesión expiró. Volvé a iniciar sesión.', esConflicto: false }
  }
  if (/NOT_FOUND/.test(crudo)) {
    return { texto: 'El cobro o el comprobante ya no está disponible.', esConflicto: true }
  }
  return { texto: 'No se pudo completar la operación. Volvé a intentarlo.', esConflicto: false }
}
