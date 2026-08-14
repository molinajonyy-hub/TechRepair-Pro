export type DisplayStatusKey =
  | 'borrador'
  | 'cobrado_pendiente_arca'
  | 'emitido_arca'
  | 'error_arca'
  | 'anulado'
  | 'sin_autorizacion_fiscal'

export interface ComprobanteForDisplay {
  estado?: string | null
  status?: string | null
  estado_comercial?: string | null
  estado_fiscal?: string | null
  cae?: string | null
  numero_fiscal?: string | null
  total_cobrado?: number | null
}

/**
 * Señal canónica de anulación, leída de las columnas que `annul_comprobante_atomic`
 * setea atómicamente al anular (ver migración 20260702120000, tanto el guard de
 * la línea 192 como el UPDATE de la 411): `estado='anulado'`, `status='cancelled'`,
 * `estado_comercial='anulado'`. Consultamos las tres (más `anulado_fiscal`) para
 * que la UI no dependa de una sola columna: si un flujo futuro deja de tocar
 * `estado` pero marca la anulación por otra vía comercial/fiscal, el detalle deja
 * de ofrecer afordancias de cobro igual.
 */
export function isComprobanteAnnulled(c: {
  estado?: string | null
  status?: string | null
  estado_comercial?: string | null
  estado_fiscal?: string | null
} | null | undefined): boolean {
  if (!c) return false
  return c.estado === 'anulado'
    || c.estado === 'cancelled'
    || c.status === 'cancelled'
    || c.estado_comercial === 'anulado'
    || c.estado_fiscal === 'anulado_fiscal'
}

/**
 * Resolución SEMÁNTICA del estado de un comprobante. Única en el sistema.
 *
 * Había tres superficies decidiendo por su cuenta si algo estaba emitido
 * (Header, Documento, Actions) y las tres se equivocaban distinto con el mismo
 * dato. Acá se centraliza el SIGNIFICADO: qué es, cómo se llama y qué acciones
 * admite. La presentación (colores, iconos, layout) sigue siendo de cada
 * componente — eso no hace falta unificarlo y unificarlo sería peor.
 */
export interface ComprobanteDisplayStatus {
  key: DisplayStatusKey
  label: string
  color: string
  bgColor: string
  /** Copy explicativo, cuando el estado lo necesita. */
  detail: string | null
  /** ¿ARCA autorizó este comprobante? NO es lo mismo que `estado='emitido'`. */
  fiscalmenteEmitido: boolean
  /** ¿La UI puede ofrecer emitir en ARCA? */
  permiteEmision: boolean
  /** ¿La UI puede ofrecer reintentar/reconciliar? */
  permiteReintento: boolean
}

/**
 * Copy secundario del estado, cuando hace falta explicarlo.
 *
 * `sin_autorizacion_fiscal` es TERMINAL: la venta existe y se cobró, pero ARCA
 * confirmó que no hay autorización fiscal para ella. No es un error técnico
 * reintentable ni un pendiente, así que la UI no debe ofrecer emitir,
 * reintentar ni reconciliar.
 */
export function comprobanteStatusDetalle(key: DisplayStatusKey): string | null {
  if (key === 'sin_autorizacion_fiscal') {
    return 'Este registro histórico no posee una autorización válida en ARCA.'
  }
  return null
}

/**
 * ¿La UI puede ofrecer emitir / reintentar / reconciliar en este estado?
 *
 * Los tres que dicen que NO son estados donde ya no hay nada que emitir:
 *
 *   · `emitido_arca` — ARCA ya lo autorizo. Ofrecer "Emitir en ARCA" sobre un
 *     comprobante con CAE es pedir un segundo CAE para la misma venta. Hoy el
 *     servidor corta antes (`comprobanteService.emitir` devuelve el CAE que ya
 *     existe), pero la UI igual anunciaba "Comprobante emitido correctamente"
 *     para un no-op. Se vio en produccion sobre el 0010-00000045, que quedo con
 *     estado comercial 'borrador' y CAE real despues de la reconciliacion.
 *   · `sin_autorizacion_fiscal` — TERMINAL. No es un error reintentable.
 *   · `anulado` — se compensa con una NC, no reemitiendo.
 *
 * `error_arca` y `cobrado_pendiente_arca` SI admiten emision: son justamente
 * los estados que esperan un reintento.
 */
export function permiteAccionesDeEmision(key: DisplayStatusKey): boolean {
  return key !== 'sin_autorizacion_fiscal'
    && key !== 'anulado'
    && key !== 'emitido_arca'
}

/** Arma el contrato completo a partir de la clave. */
function construir(
  key: DisplayStatusKey,
  label: string,
  color: string,
  bgColor: string,
): ComprobanteDisplayStatus {
  return {
    key, label, color, bgColor,
    detail: comprobanteStatusDetalle(key),
    // Sólo es fiscalmente emitido si ARCA lo autorizó. `estado='emitido'` es
    // la operación COMERCIAL y no dice nada de eso.
    fiscalmenteEmitido: key === 'emitido_arca',
    permiteEmision:   permiteAccionesDeEmision(key),
    permiteReintento: permiteAccionesDeEmision(key),
  }
}

/**
 * ÚNICA resolución semántica del estado de un comprobante.
 *
 * ORDEN DE PRIORIDAD — no es cosmético, cada regla nació de un defecto real:
 *
 *   1. anulado.
 *   2. sin_autorizacion_fiscal — TERMINAL. Va antes que cualquier inferencia
 *      por `estado='emitido'` o por presencia/ausencia de CAE, porque estos
 *      registros conservan `estado='emitido'` (la venta ocurrió y se cobró) y
 *      cualquier regla de abajo los declararía autorizados por ARCA.
 *   3. emitido en ARCA.
 *   4. error de emisión.
 *   5. cobrado y pendiente.
 *   6. borrador.
 */
export function getComprobanteDisplayStatus(c: ComprobanteForDisplay): ComprobanteDisplayStatus {
  if (isComprobanteAnnulled(c)) {
    return construir('anulado', 'Anulado', '#f87171', 'rgba(239,68,68,0.1)')
  }
  if (c.estado_fiscal === 'sin_autorizacion_fiscal') {
    return construir('sin_autorizacion_fiscal', 'Sin autorización fiscal', '#f59e0b', 'rgba(245,158,11,0.1)')
  }
  if (c.cae || c.estado_fiscal === 'emitido' || c.estado === 'emitido') {
    return construir('emitido_arca', 'Emitido ARCA', '#34d399', 'rgba(16,185,129,0.1)')
  }
  if (c.estado_fiscal === 'error_emision') {
    return construir('error_arca', 'Error ARCA', '#f87171', 'rgba(239,68,68,0.1)')
  }
  const cobrado = typeof c.total_cobrado === 'number' ? c.total_cobrado : 0
  if (cobrado > 0 && !c.cae && !c.numero_fiscal) {
    return construir('cobrado_pendiente_arca', 'Cobrado / Pendiente ARCA', '#60a5fa', 'rgba(96,165,250,0.1)')
  }
  return construir('borrador', 'Borrador', '#fbbf24', 'rgba(245,158,11,0.1)')
}
