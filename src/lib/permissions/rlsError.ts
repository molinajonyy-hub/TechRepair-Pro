// Detección amigable de errores de permiso (RLS / GRANT) de PostgREST/Postgres.
// No esconder otros errores reales bajo el mensaje genérico de permisos.

export const PERMISSION_DENIED_MESSAGE = 'No tenés permisos para realizar esta acción.'

/** true si el error corresponde a permiso denegado (42501 / RLS / 403). */
export function isPermissionDeniedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown; status?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  return (
    code === '42501' ||
    e.status === 403 ||
    msg.includes('permission denied') ||
    msg.includes('insufficient_privilege') ||
    msg.includes('row-level security') ||
    msg.includes('row level security')
  )
}

/**
 * Mensaje amigable SOLO para errores de permiso; null para el resto
 * (así el caller puede mostrar el error real cuando no es de permisos).
 */
export function permissionErrorMessage(err: unknown): string | null {
  return isPermissionDeniedError(err) ? PERMISSION_DENIED_MESSAGE : null
}
