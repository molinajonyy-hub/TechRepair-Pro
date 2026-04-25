import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

/**
 * Página de callback para OAuth (Google, etc.).
 * Supabase redirige aquí después de que el usuario autoriza con Google.
 * El cliente de Supabase detecta automáticamente el `code` en la URL
 * (flujo PKCE) y lo intercambia por una sesión.
 */
export function AuthCallback() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Detectar errores OAuth en la URL (ej: acceso denegado por el usuario)
    const params = new URLSearchParams(window.location.search)
    const urlError = params.get('error')
    const urlErrorDesc = params.get('error_description')

    if (urlError) {
      const msg = urlErrorDesc
        ? decodeURIComponent(urlErrorDesc.replace(/\+/g, ' '))
        : urlError === 'access_denied'
        ? 'Cancelaste el inicio de sesión con Google.'
        : `Error de autenticación: ${urlError}`
      setError(msg)
      // Redirigir al login con el error después de 3 segundos
      setTimeout(() => navigate('/login', { replace: true }), 3000)
      return
    }

    // Escuchar eventos de autenticación que Supabase dispara
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // Recuperación de contraseña → marcar y redirigir al formulario
      if (event === 'PASSWORD_RECOVERY') {
        sessionStorage.setItem('is_password_recovery', '1')
        navigate('/reset-password', { replace: true })
        return
      }
      if (event === 'SIGNED_IN' && session) {
        const redirect = sessionStorage.getItem('post_login_redirect') || '/dashboard'
        sessionStorage.removeItem('post_login_redirect')
        navigate(redirect, { replace: true })
      } else if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) {
        setTimeout(() => navigate('/login', { replace: true }), 1500)
      }
    })

    // Timeout de seguridad: si en 10 segundos no hay sesión, volver al login
    const timeout = setTimeout(() => {
      setError('El inicio de sesión tardó demasiado. Por favor intentá nuevamente.')
      setTimeout(() => navigate('/login', { replace: true }), 2500)
    }, 10000)

    return () => {
      subscription.unsubscribe()
      clearTimeout(timeout)
    }
  }, [navigate])

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
        {error ? (
          <>
            <div style={{
              width: '52px', height: '52px', borderRadius: '50%',
              backgroundColor: 'rgba(248,113,113,0.12)',
              border: '2px solid rgba(248,113,113,0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 1rem',
              fontSize: '1.5rem',
            }}>
              ✕
            </div>
            <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.1rem', fontWeight: 700, color: '#f87171' }}>
              Error al iniciar sesión
            </h2>
            <p style={{ margin: '0 0 1rem', fontSize: '0.875rem', color: '#64748b', lineHeight: 1.5 }}>
              {error}
            </p>
            <p style={{ margin: 0, fontSize: '0.75rem', color: '#334155' }}>
              Redirigiendo al login...
            </p>
          </>
        ) : (
          <>
            {/* Spinner animado */}
            <div style={{
              width: '52px', height: '52px', borderRadius: '50%',
              border: '3px solid rgba(99,102,241,0.15)',
              borderTop: '3px solid #6366f1',
              animation: 'spin 0.8s linear infinite',
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

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
