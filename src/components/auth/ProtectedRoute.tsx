import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { RefreshCw } from 'lucide-react'
import { useRef } from 'react'

/**
 * P0-P4 — Guard central. Decide SÓLO a partir de `authState`.
 *
 * Antes cada rama miraba una combinación distinta de `loading`,
 * `profileLoading`, `profile` y `profileError`, y la condición de espera tenía
 * un hueco: `profileLoading` arranca en `false` ANTES del primer intento, así
 * que existía un render en el que un owner con negocio era indistinguible de
 * uno sin negocio — y se lo mandaba a /no-business.
 *
 * `authState` colapsa eso en una sola pregunta y hace imposible la ambigüedad:
 * los estados de espera son estados propios, no la ausencia de datos.
 */
export function ProtectedRoute() {
  const { authState, profile } = useAuth()
  const location = useLocation()

  // Una vez que el perfil se cargó exitosamente, jamás lo olvidamos: evita que
  // un TOKEN_REFRESHED desmonte la página activa (cerrando modales y perdiendo
  // estado de UI). Es una decisión de UX, no de autorización.
  const profileEverLoadedRef = useRef(false)
  if (profile) profileEverLoadedRef.current = true

  const loader = (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: 'var(--app-shell-bg)',
    }}>
      <RefreshCw className="animate-spin" size={32} style={{ color: '#6366f1' }} />
    </div>
  )

  switch (authState) {
    // ── Estados de ESPERA: nadie redirige ────────────────────────────────────
    case 'AUTH_LOADING':
      return loader

    case 'AUTHENTICATED_PROFILE_LOADING':
      // Si ya habíamos cargado el perfil alguna vez, se sigue mostrando la
      // pantalla en vez de un spinner: es una recarga en segundo plano.
      return profileEverLoadedRef.current ? <Outlet /> : loader

    // ── Redirects ────────────────────────────────────────────────────────────
    case 'UNAUTHENTICATED':
      return <Navigate to="/login" state={{ from: location }} replace />

    case 'EMAIL_UNCONFIRMED':
      // Va antes de cualquier espera de perfil y esa posición es parte del
      // contrato: un usuario sin confirmar no tiene profile POR DISEÑO, así que
      // esperarlo dejaría el spinner girando para siempre.
      return <Navigate to="/verificar-email" replace />

    case 'AUTHENTICATED_WITHOUT_BUSINESS':
    case 'AUTH_ERROR':
      // Los dos terminan en /no-business, pero NO son lo mismo y esa pantalla
      // los distingue: uno ofrece crear el negocio, el otro sólo reintentar.
      // Mandar un AUTH_ERROR a «creá tu negocio» es cómo se fabrican tenants
      // duplicados a partir de un corte de red.
      return <Navigate to="/no-business" replace />

    case 'AUTHENTICATED_WITH_BUSINESS':
      return <Outlet />
  }
}
