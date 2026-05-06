/**
 * Convierte CUALQUIER valor a string seguro para renderizar en JSX.
 * Previene el error React #31 "Objects are not valid as a React child".
 *
 * Detecta: strings, números, booleanos, Error objects, objetos Supabase
 * ({data, error, count, status, statusText}), y objetos de servicio
 * ({success, error, message}).
 */
export function formatDisplayMessage(
  value: unknown,
  fallback = 'Operación realizada'
): string {
  if (value === null || value === undefined) return fallback

  if (typeof value === 'string') return value || fallback
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'Sí' : 'No'

  if (value instanceof Error) return value.message || fallback

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>

    // Supabase PostgrestError: { message, code, details, hint }
    if (typeof obj.message === 'string' && obj.message) return obj.message

    // Objeto de servicio con propiedad error (string)
    if (typeof obj.error === 'string' && obj.error) return obj.error

    // Objeto de servicio con propiedad error (Error o PostgrestError)
    if (obj.error && typeof obj.error === 'object') {
      const inner = obj.error as Record<string, unknown>
      if (typeof inner.message === 'string' && inner.message) return inner.message
    }

    // Supabase response object: { data, error, count, status, statusText }
    if (typeof obj.statusText === 'string' && obj.statusText) return obj.statusText
    if (typeof obj.status === 'number') return `Error ${obj.status}`

    // Objeto genérico con details o hint (PostgrestError shape)
    if (typeof obj.details === 'string' && obj.details) return obj.details
    if (typeof obj.hint === 'string' && obj.hint) return obj.hint

    return fallback
  }

  return String(value) || fallback
}

/**
 * Extrae un mensaje de error seguro para setError() o toasts.
 * Garantiza que el estado de error reciba siempre un string.
 */
export function toErrorMessage(
  e: unknown,
  fallback = 'Ocurrió un error'
): string {
  return formatDisplayMessage(e, fallback)
}
