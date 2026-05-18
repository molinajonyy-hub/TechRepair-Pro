import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

/**
 * Página de callback para OAuth (Google, etc.).
 *
 * En lugar de navegar inmediatamente en SIGNED_IN (antes del profile),
 * espera a que AuthContext resuelva tanto auth como profile, luego navega.
 * Esto elimina la race condition donde el profile no estaba cargado y
 * ProtectedRoute redirigía a /no-business → /onboarding.
 */
export function AuthCallback() {
  const navigate = useNavigate()
  const { isAuthenticated, loading, profileLoading } = useAuth()
  const [urlError, setUrlError] = useState<string | null>(null)
  const navigatedRef = useRef(false)

  // Detectar errores OAuth en la URL (ej: acceso denegado)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const err     = params.get('error')
    const errDesc = params.get('error_description')
    if (err) {
      const msg = errDesc
        ? decodeURIComponent(errDesc.replace(/\+/g, ' '))
        : err === 'access_denied'
        ? 'Cancelaste el inicio de sesión con Google.'
        : `Error de autenticación: ${err}`
      setUrlError(msg)
      setTimeout(() => navigate('/login', { replace: true }), 3000)
    }
  }, [navigate])

  // Navegar una vez que auth + profile están totalmente resueltos
  useEffect(() => {
    if (urlError) return
    if (navigatedRef.current) return
    if (loading || profileLoading) return

    navigatedRef.current = true

    if (isAuthenticated) {
      const redirect = sessionStorage.getItem('post_login_redirect') || '/dashboard'
      sessionStorage.removeItem('post_login_redirect')
      navigate(redirect, { replace: true })
    } else {
      // No hay sesión después de cargar → volver al login
      setTimeout(() => navigate('/login', { replace: true }), 1500)
    }
  }, [urlError, loading, profileLoading, isAuthenticated, navigate])

  // Timeout de seguridad: si en 15s no resuelve, ir al login
  useEffect(() => {
    if (urlError) return
    const t = setTimeout(() => {
      if (!navigatedRef.current) {
        navigatedRef.current = true
        navigate('/login', { replace: true })
      }
    }, 15_000)
    return () => clearTimeout(t)
  }, [urlError, navigate])

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#060d1a',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{
        textAlign: 'center',
        padding: '2.5rem',
        backgroundColor: '#0f1829',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '1rem',
        maxWidth: '360px',
        width: '90%',
        boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
      }}>
        {urlError ? (
          <>
            <div style={{
              width: '52px', height: '52px', borderRadius: '50%',
              backgroundColor: 'rgba(248,113,113,0.12)',
              border: '2px solid rgba(248,113,113,0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 1rem', fontSize: '1.5rem',
            }}>✕</div>
            <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.1rem', fontWeight: 700, color: '#f87171' }}>
              Error al iniciar sesión
            </h2>
            <p style={{ margin: '0 0 1rem', fontSize: '0.875rem', color: '#64748b', lineHeight: 1.5 }}>
              {urlError}
            </p>
            <p style={{ margin: 0, fontSize: '0.75rem', color: '#334155' }}>
              Redirigiendo al login...
            </p>
          </>
        ) : (
          <>
            <div style={{
              width: '52px', height: '52px', borderRadius: '50%',
              border: '3px solid rgba(99,102,241,0.15)',
              borderTop: '3px solid #6366f1',
              animation: 'tr-spin 0.8s linear infinite',
              margin: '0 auto 1.25rem',
            }} />
            <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.1rem', fontWeight: 700, color: '#f1f5f9' }}>
              Iniciando sesión...
            </h2>
            <p style={{ margin: 0, fontSize: '0.875rem', color: '#475569' }}>
              Verificando tu cuenta de Google
            </p>
          </>
        )}
      </div>
    </div>
  )
}
