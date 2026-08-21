/**
 * Retención de los registros de WhatsApp — lado del frontend.
 *
 * A los 90 días de creado, el mantenimiento de la base reemplaza el cuerpo del
 * mensaje por un centinela y pone el teléfono en NULL. La fila sobrevive con su
 * metadata operacional, así que el historial sigue contando que hubo un
 * contacto — pero el contenido ya no está.
 *
 * Este módulo existe para que el centinela viva en UN solo lugar del frontend.
 * Está duplicado a propósito respecto de la base: allá es
 * `public.whatsapp_log_redaction_marker()`, y hay un test que asevera que los
 * dos digan lo mismo. Un frontend que compare contra un literal distinto no
 * rompe nada visible — simplemente muestra el texto crudo al usuario, que es
 * la falla silenciosa que este módulo evita.
 */

/**
 * Valor EXACTO que escribe `public.apply_whatsapp_logs_retention()`.
 * Si cambia en la migración, tiene que cambiar acá.
 */
export const MARCA_REDACCION = '[contenido eliminado por política de retención]'

/** Lo que se le muestra a la persona en lugar del centinela. */
export const AVISO_REDACCION = 'Contenido eliminado por política de retención'

/** ¿A este registro ya se le venció la retención del contenido? */
export function estaRedactado(message: string | null | undefined): boolean {
  return message === MARCA_REDACCION
}
