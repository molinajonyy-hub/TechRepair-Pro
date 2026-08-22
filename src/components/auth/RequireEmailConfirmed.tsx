import { Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../../contexts/AuthContext'

/**
 * EMAIL VERIFICATION P0 — anti-bypass para rutas que viven FUERA de
 * `ProtectedRoute`.
 *
 * `/onboarding` y `/no-business` están montadas al mismo nivel que `/login`
 * (ver App.tsx), así que el guard central no las cubre. Sin esto, un usuario
 * sin confirmar que escribiera `/onboarding` a mano entraría a crear su
 * negocio — que es exactamente el estado que esta P0 posterga hasta que el
 * correo esté verificado.
 *
 * No duplica la regla: consume el MISMO `emailConfirmed` del contexto que usan
 * `ProtectedRoute` y `PersonalProtectedRoute`. La regla vive en un solo lugar
 * (`email_confirmed_at`); esto sólo la aplica en un punto de montaje distinto.
 *
 * A diferencia de los guards de producto, acá NO se exige perfil ni negocio:
 * estas dos pantallas son justamente las que se muestran cuando falta.
 */
export function RequireEmailConfirmed({ children }: { children: ReactNode }) {
  const { isAuthenticated, loading, emailConfirmed } = useAuth()

  // Mientras auth resuelve no se decide nada: redirigir acá mandaría a
  // /login a cualquiera que recargue la página.
  if (loading) return null

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  if (!emailConfirmed) {
    return <Navigate to="/verificar-email" replace />
  }

  return <>{children}</>
}
