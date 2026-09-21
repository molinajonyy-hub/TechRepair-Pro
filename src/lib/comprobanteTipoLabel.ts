/**
 * Cómo se LLAMA cada tipo de comprobante en las superficies de usuario.
 *
 * G2-A — Fuente única. Antes el label vivía duplicado en ~12 mapas locales
 * (POS, tabla, header, documento, impresión, búsqueda global, dashboard,
 * detalle de cliente, movimientos de inventario…), lo que hacía imposible
 * renombrar un tipo sin que alguna superficie quedara atrás.
 *
 * ── `remito` se presenta como «Nota de Pedido» ──────────────────────────────
 * El dominio de DB (`comprobantes_tipo_check`) sigue siendo
 * `remito | factura_a | factura_c | nota_credito`: este módulo NO renombra
 * nada en la base, ni toca la semántica fiscal (`esTipoFiscal`), ni el valor
 * que viaja al checkout. Cambia únicamente el rótulo que lee una persona.
 *
 * El motivo es de producto: para beta, `remito` es el comprobante interno y
 * predeterminado del POS —la venta que no se emite en ARCA—, y «Remito» es un
 * documento de transporte, no una venta. Llamarlo «Nota de Pedido» describe lo
 * que el documento realmente es.
 *
 * Si alguna vez se separa canónicamente `nota_pedido` de `remito`, este módulo
 * es el único lugar que hay que abrir.
 */
import type { TipoComprobante } from '../services/comprobanteService'

/** Rótulo largo. Títulos, selectores, badges, filtros. */
export const COMPROBANTE_TIPO_LABEL: Record<TipoComprobante, string> = {
  factura_a:    'Factura A',
  factura_c:    'Factura C',
  remito:       'Nota de Pedido',
  nota_credito: 'Nota de Crédito',
}

/** Rótulo corto para chips y columnas angostas. */
export const COMPROBANTE_TIPO_LABEL_SHORT: Record<TipoComprobante, string> = {
  factura_a:    'A',
  factura_c:    'C',
  remito:       'NP',
  nota_credito: 'NC',
}

/** Rótulo del DOCUMENTO impreso / PDF. En mayúsculas, como el resto del layout. */
export const COMPROBANTE_TIPO_DOC_LABEL: Record<TipoComprobante, string> = {
  factura_a:    'FACTURA A',
  factura_c:    'FACTURA C',
  remito:       'NOTA DE PEDIDO',
  nota_credito: 'NOTA DE CRÉDITO',
}

function resolver(mapa: Record<TipoComprobante, string>, tipo: string | null | undefined, fallback: string): string {
  if (!tipo) return fallback
  return mapa[tipo as TipoComprobante] ?? fallback
}

/** Rótulo largo, tolerante a un tipo desconocido o nulo. */
export function comprobanteTipoLabel(tipo: string | null | undefined, fallback = 'Comprobante'): string {
  return resolver(COMPROBANTE_TIPO_LABEL, tipo, fallback)
}

/** Rótulo corto, tolerante a un tipo desconocido o nulo. */
export function comprobanteTipoLabelShort(tipo: string | null | undefined, fallback = '—'): string {
  return resolver(COMPROBANTE_TIPO_LABEL_SHORT, tipo, fallback)
}

/** Rótulo del documento impreso, tolerante a un tipo desconocido o nulo. */
export function comprobanteTipoDocLabel(tipo: string | null | undefined, fallback = 'COMPROBANTE'): string {
  return resolver(COMPROBANTE_TIPO_DOC_LABEL, tipo, fallback)
}
