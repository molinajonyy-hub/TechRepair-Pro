/**
 * Sanitizes a string for use as a PDF filename part.
 * Removes accents, special chars, collapses spaces to dashes.
 */
export function sanitizeFilenamePart(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')          // remove diacritics
    .replace(/[^a-zA-Z0-9\s-]/g, '')          // keep only alphanum, spaces, dashes
    .trim()
    .replace(/\s+/g, '-')                     // spaces → dashes
    .replace(/-{2,}/g, '-')                   // collapse repeated dashes
    .replace(/^-|-$/g, '')                    // trim leading/trailing dashes
    || 'Doc'
}

const TIPO_COMPROBANTE_FILE: Record<string, string> = {
  factura_a:   'Factura-A',
  factura_c:   'Factura-C',
  remito:      'Remito',
  nota_credito:'Nota-de-Credito',
}

/**
 * Builds a safe PDF filename for a comprobante.
 * Format: {Negocio}-{Tipo}-{Numero}.pdf
 * Example: Clic-Factura-C-0001-000100758979.pdf
 */
export function buildComprobanteFilename(
  businessName: string | null | undefined,
  tipo: string,
  numero: string | null | undefined,
  fallbackId?: string
): string {
  const biz  = sanitizeFilenamePart(businessName || 'Negocio')
  const tip  = TIPO_COMPROBANTE_FILE[tipo] ?? (sanitizeFilenamePart(tipo) || 'Comprobante')
  const num  = numero
    ? sanitizeFilenamePart(numero)
    : sanitizeFilenamePart(fallbackId?.slice(0, 8) || 'sin-numero')
  return `${biz}-${tip}-${num}.pdf`
}

/**
 * Builds a safe print window title for a service order.
 * Format: {Negocio}-Orden-{ShortId}  (no .pdf — browser adds it)
 * Example: Clic-Orden-A1B2C3D4
 */
export function buildOrderPrintTitle(
  businessName: string | null | undefined,
  orderId: string
): string {
  const biz = sanitizeFilenamePart(businessName || 'Negocio')
  const num = orderId.slice(0, 8).toUpperCase()
  return `${biz}-Orden-${num}`
}
