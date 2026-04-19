import { useAuth } from '../contexts/AuthContext'
import { AppPermissions, PermissionKey, resolvePermissions } from '../config/permissions'

/**
 * Returns the resolved AppPermissions for the currently authenticated user.
 * Owners always get all permissions regardless of custom overrides.
 *
 * Usage:
 *   const { can } = usePermissions()
 *   if (!can('finance')) return <Navigate to="/" />
 */
export function usePermissions() {
  const { role, profile, isOwner } = useAuth()

  const permissions: AppPermissions = resolvePermissions(
    role || 'viewer',
    isOwner ? null : (profile as any)?.permissions
  )

  function can(key: PermissionKey): boolean {
    if (isOwner) return true
    return permissions[key] ?? false
  }

  return { permissions, can }
}
