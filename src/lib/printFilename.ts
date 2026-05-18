/**
 * Sanitizes a string for use as a PDF filename part.
 * Removes accents, special chars, collapses spaces to dashes.
 */
export function sanitizeFilenamePart(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')       // remove diacritics
    .replace(/[^a-zA-Z0-9\s-]/g, '')       // keep only alphanum, spaces, dashes
    .trim()
    .replace(/\s+/g, '-')                   // spaces → dashes
    .replace(/-{2,}/g, '-')                 // collapse repeated dashes
    .replace(/^-|-$/g, '')                  // trim leading/trailing dashes
    || 'Doc'
}
