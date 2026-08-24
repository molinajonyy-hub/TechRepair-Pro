import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { usePermissions } from '../../hooks/usePermissions'
import { useAuth } from '../../contexts/AuthContext'
import { useSystemOwner } from '../../hooks/useSystemOwner'
import { RefreshCw } from 'lucide-react'
import type { PermissionKey } from '../../config/permissions'

/**
 * P0-P6 — Guard de ruta por CAPACIDAD.
 *
 * Un item oculto en el sidebar NO es protección: escribir la URL a mano tiene
 * que fallar igual. Este guard es lo que hace que `/mayorista` o `/mi-guita`
 * rebote aunque el usuario conozca el path.
 *
 * Es defensa en profundidad, no la única barrera: las lecturas sensibles ya
 * están cerradas server-side por RLS con `current_user_can()`. Este guard evita
 * que el usuario llegue a una pantalla rota (permisos denegados por todos
 * lados) en vez de a un destino con sentido.
 *
 * Uso:
 *   <Route element={<ProtectedRouteByPermission permission="wholesale" />}>
 *     <Route path="/mayorista" element={<Mayorista />} />
 *   </Route>
 */
export function ProtectedRouteByPermission({
  permission,
  /** Si true, un System Owner entra aunque el tenant no le dé la capacidad. */
  allowSystemOwner = false,
  redirectTo = '/dashboard',
}: {
  permission: PermissionKey
  allowSystemOwner?: boolean
  redirectTo?: string
}) {
  const { can } = usePermissions()
  const { authState } = useAuth()
  const { isSystemOwner, loading: systemOwnerLoading } = useSystemOwner()
  const location = useLocation()

  const loader = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
      <RefreshCw size={24} className="animate-spin" style={{ color: '#6366f1' }} />
    </div>
  )

  // No se decide nada hasta que la hidratación terminó. Un permiso evaluado
  // sobre un perfil a medio cargar es `false` por accidente, y rebotaría a un
  // usuario legítimo (misma clase de bug que cerró P0-P4).
  if (authState === 'AUTH_LOADING' || authState === 'AUTHENTICATED_PROFILE_LOADING') {
    return loader
  }

  // La escotilla del interno se consulta al servidor; hay que esperarla o
  // negaríamos el acceso durante el fetch.
  if (allowSystemOwner && systemOwnerLoading) return loader

  if (can(permission)) return <Outlet />
  if (allowSystemOwner && isSystemOwner) return <Outlet />

  return <Navigate to={redirectTo} state={{ from: location, deniedPermission: permission }} replace />
}
