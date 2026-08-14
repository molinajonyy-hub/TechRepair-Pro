// ============================================================================
// Fechas de CALENDARIO — un DATE no es un instante.
//
// `cae_vencimiento` es un DATE de PostgreSQL: nombra un dia del almanaque, no
// un momento en el tiempo. Cuando llega al cliente como '2026-06-26' (o como
// '2026-06-26T00:00:00+00:00', que es lo que devuelve PostgREST), el camino
// habitual lo rompe:
//
//     new Date('2026-06-26').toLocaleDateString('es-AR')  ->  '25/6/2026'
//
// El string se parsea como medianoche UTC y Argentina esta en UTC-3, asi que
// la conversion a hora local retrocede al dia anterior. Medido en produccion
// sobre el CAE del comprobante 0010-00000045: ARCA lo vence el 26 y la pantalla
// decia 25.
//
// La regla: para una fecha de calendario, el dia que dice la base es el dia que
// se muestra. No hay zona horaria que aplicar porque no hay instante que
// convertir.
//
// Sin dependencias: se testea con `node --test`.
// ============================================================================

/** Toma los componentes Y-M-D literales del string, sin construir un Date. */
const PARTES_ISO = /^(\d{4})-(\d{2})-(\d{2})/

/**
 * Formatea una fecha de calendario como DD/MM/AAAA.
 *
 * Acepta el `YYYY-MM-DD` pelado y tambien el timestamp que arma PostgREST para
 * una columna DATE: en los dos casos se queda con la parte de fecha TAL CUAL,
 * sin pasar por `Date`.
 *
 * Un `Date` de verdad (un instante) si se formatea en la zona local, que es lo
 * correcto para un timestamptz como `comprobante.fecha`.
 *
 * Devuelve '' para vacio/invalido — nunca 'Invalid Date' en pantalla.
 */
export function formatearFechaCalendario(valor: string | Date | null | undefined): string {
  if (valor === null || valor === undefined || valor === '') return ''

  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return ''
    return valor.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
  }

  const m = PARTES_ISO.exec(valor.trim())
  if (!m) return ''

  const [, anio, mes, dia] = m
  // Rechaza lo que parece una fecha pero no lo es ('2026-13-40'). No se
  // normaliza al mes siguiente: eso inventaria un vencimiento fiscal distinto
  // del que emitio ARCA.
  const nMes = Number(mes)
  const nDia = Number(dia)
  if (nMes < 1 || nMes > 12 || nDia < 1 || nDia > 31) return ''

  return `${dia}/${mes}/${anio}`
}
