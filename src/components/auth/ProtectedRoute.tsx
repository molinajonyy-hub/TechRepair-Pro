import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { RefreshCw } from 'lucide-react'
import { useRef } from 'react'

export function ProtectedRoute() {
  const { isAuthenticated, loading, emailConfirmed, hasBusinessAccess, profileLoading, profile, profileError } = useAuth()
  const location = useLocation()

  // Una vez que el perfil se cargó exitosamente, jamás lo olvidamos.
  // Esto evita que TOKEN_REFRESHED u otros re-auth temporales desmontenten
  // la página activa (lo que cerraría modales y resetearía estado de UI).
  const profileEverLoadedRef = useRef(false)
  if (profile) profileEverLoadedRef.current = true
  const profileEstablished = profileEverLoadedRef.current

  // Mostrar loading SOLO en la carga inicial (primera vez), nunca en re-auth.
  const isInitialLoad = !profileEstablished

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

  if (loading) return loader

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  // ── GUARD CENTRAL DE CORREO ────────────────────────────────────────────────
  // Va ANTES de cualquier espera de perfil, y esa posición es parte del
  // contrato: un usuario sin confirmar no tiene profile POR DISEÑO (el
  // provisioning ocurre recién al confirmar, ver migración 20260823120000).
  // Si el chequeo fuera después, la condición de loading —que espera un
  // profile que nunca va a llegar— dejaría el spinner girando para siempre en
  // vez de redirigir.
  //
  // `emailConfirmed` sale de `email_confirmed_at`, así que Google entra por
  // acá sin ninguna rama especial: llega ya confirmado y no ve esta pantalla.
  if (!emailConfirmed) {
    return <Navigate to="/verificar-email" replace />
  }

  if ((profileLoading && isInitialLoad) || (!profile && !profileError && isInitialLoad)) {
    return loader
  }

  if (!hasBusinessAccess) {
    return <Navigate to="/no-business" replace />
  }

  return <Outlet />
}
