import { useAuth } from '../contexts/AuthContext'
import { AppPermissions, PermissionKey, ALL_PERMISSIONS, resolvePermissions } from '../config/permissions'

/**
 * Valida y sanitiza los permisos que vienen de la BD.
 * Solo acepta claves conocidas con valores boolean.
 */
function sanitizePermissions(raw: unknown): Partial<AppPermissions> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const result: Partial<AppPermissions> = {}
  let hasAny = false
  for (const key of ALL_PERMISSIONS) {
    const val = (raw as Record<string, unknown>)[key]
    if (typeof val === 'boolean') {
      result[key] = val
      hasAny = true
    }
  }
  return hasAny ? result : null
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

  const sanitized = isOwner ? null : sanitizePermissions(profile?.permissions)

  const permissions: AppPermissions = resolvePermissions(role || 'viewer', sanitized)

  function can(key: PermissionKey): boolean {
    if (isOwner) return true
    return permissions[key] ?? false
  }

  return { permissions, can }
}
