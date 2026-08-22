import { useAuth } from '../contexts/AuthContext'
import { AppPermissions, PermissionKey, ALL_PERMISSIONS, resolvePermissions, ROLE_DEFAULT_PERMISSIONS } from '../config/permissions'

/**
 * Resultado de validar el payload de overrides que llega del servidor.
 *
 * Se distinguen TRES casos, porque "no hay overrides" y "el payload no se
 * entiende" no pueden resolverse igual:
 *
 *  - `none`      → la columna vino NULL/ausente. Contrato explícito de
 *                  `profiles.permissions`: usar los defaults del rol.
 *  - `ok`        → objeto plano interpretable; `overrides` son las claves
 *                  conocidas con valor boolean.
 *  - `malformed` → el payload EXISTE pero no se puede interpretar. No se puede
 *                  saber si restringía o ampliaba, así que se falla cerrado.
 */
export type PermissionsPayload =
  | { kind: 'none' }
  | { kind: 'ok'; overrides: Partial<AppPermissions> }
  | { kind: 'malformed' }

/** Todo en false: el piso al que se cae ante un payload que no se entiende. */
export const DENY_ALL: AppPermissions = ALL_PERMISSIONS.reduce((acc, key) => {
  acc[key] = false
  return acc
}, {} as AppPermissions)

/**
 * Valida y sanitiza los overrides que vienen de la BD.
 *
 * Formato almacenado (ver el COMMENT de `public.profiles.permissions` y
 * `buildOverrideDiff` en UsersManagement): un JSON PARCIAL con las claves
 * conocidas, que es el DIFF contra los defaults del rol. NULL = sin overrides.
 *
 * Reglas:
 *  - null / undefined            → `none` (defaults del rol).
 *  - no es un objeto plano       → `malformed` (array, string, número, boolean).
 *  - clave conocida con boolean  → se toma como override.
 *  - clave conocida sin boolean  → `malformed`: el override existe pero no se
 *                                  puede leer; no se lo puede ignorar en
 *                                  silencio porque podría estar RESTRINGIENDO.
 *  - clave desconocida           → se IGNORA. No amplía privilegio y mantiene
 *                                  compatibilidad hacia adelante si el servidor
 *                                  agrega una clave que este cliente no conoce.
 *  - objeto vacío                → `none`.
 */
export function sanitizePermissions(raw: unknown): PermissionsPayload {
  if (raw === null || raw === undefined) return { kind: 'none' }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'malformed' }

  const source = raw as Record<string, unknown>
  if (Object.keys(source).length === 0) return { kind: 'none' }

  const overrides: Partial<AppPermissions> = {}
  for (const key of ALL_PERMISSIONS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const val = source[key]
    // Una clave conocida que no es boolean es un payload roto, no una clave
    // ausente: fallar cerrado en vez de degradar al default del rol.
    if (typeof val !== 'boolean') return { kind: 'malformed' }
    overrides[key] = val
  }

  return { kind: 'ok', overrides }
}

/**
 * Permisos efectivos = defaults del rol + overrides explícitos.
 *
 * Función pura, sin React, para poder testearla sin montar el árbol.
 */
export function effectivePermissions(
  role: string | null | undefined,
  isOwner: boolean,
  rawPermissions: unknown
): AppPermissions {
  // El owner es el superusuario del tenant: su rol lo define el servidor y no
  // se le aplican overrides. Contrato preexistente, se preserva tal cual.
  if (isOwner) return { ...ROLE_DEFAULT_PERMISSIONS.owner }

  const payload = sanitizePermissions(rawPermissions)
  if (payload.kind === 'malformed') return { ...DENY_ALL }

  return resolvePermissions(
    role || 'viewer',
    payload.kind === 'ok' ? payload.overrides : null
  )
}

/**
 * Retorna los permisos resueltos del usuario actual.
 * Owners siempre tienen todo, independientemente de overrides.
 *
 * Uso:
 *   const { can } = usePermissions()
 *   if (!can('finance')) return <Navigate to="/" />
 */
export function usePermissions() {
  const { role, profile, isOwner } = useAuth()

  const permissions = effectivePermissions(role, isOwner, profile?.permissions)

  function can(key: PermissionKey): boolean {
    return permissions[key] ?? false
  }

  return { permissions, can }
}
