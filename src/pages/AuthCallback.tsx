import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { sanitizeInternalPath } from '../lib/authRedirect'
import { PORTAL_DOMAINS } from '../portal/portalDomains'

/**
 * Callback único de autenticación. Soporta TRES caminos:
 *
 *   A. OAuth PKCE          `?code=...`
 *      Lo resuelve supabase-js solo (`detectSessionInUrl`). Acá sólo se espera
 *      a que AuthContext termine de resolver auth + profile y se navega.
 *
 *   B. Confirmación de correo  `?token_hash=...&type=signup`
 *      Se verifica con `supabase.auth.verifyOtp({ token_hash, type })`.
 *
 *      POR QUÉ token_hash Y NO ConfirmationURL/PKCE: el flujo PKCE exige el
 *      `code_verifier` que quedó en el localStorage del navegador ORIGINAL. El
 *      caso real es registrarse en la compu y abrir el correo en el celular:
 *      ahí no hay verifier y el link muere. `verifyOtp` con `token_hash` no
 *      depende del navegador de origen, así que la confirmación es válida
 *      cross-device.
 *
 *   C. Error del proveedor `?error=...`
 *
 * Nada de esto confía en un query param como autoridad: el estado final
 * siempre se relee de la sesión/servidor. No existe `?verified=true`.
 */

/** Tipos de OTP que este callback acepta. Cerrado a propósito. */
const TIPOS_OTP = ['signup', 'email', 'recovery'] as const
type TipoOtp = (typeof TIPOS_OTP)[number]

const esTipoOtp = (v: string | null): v is TipoOtp =>
  !!v && (TIPOS_OTP as readonly string[]).includes(v)

/** Destino tras confirmar, respetando el dominio dedicado del portal. */
function destinoPostConfirmacion(): string {
  // En un dominio exclusivo del portal mayorista todo cuelga de la raíz: el
  // PortalRouter se monta en `/` y no existe `/dashboard`. Mandar ahí a un
  // cliente mayorista lo sacaría de su portal.
  if (PORTAL_DOMAINS[window.location.hostname]) return '/'

  const guardado = window.sessionStorage.getItem('post_login_redirect')
  window.sessionStorage.removeItem('post_login_redirect')
  return sanitizeInternalPath(guardado, '/dashboard')
}

type Fase = 'verificando' | 'listo' | 'error'

export function AuthCallback() {
  const navigate = useNavigate()
  const { isAuthenticated, loading, profileLoading } = useAuth()
  const [urlError, setUrlError] = useState<string | null>(null)
  const [fase, setFase] = useState<Fase>('verificando')
  const navigatedRef = useRef(false)
  const procesadoRef = useRef(false)

  // ── Camino C + B ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (procesadoRef.current) return
    procesadoRef.current = true

    const params = new URLSearchParams(window.location.search)

    // C. Error explícito del proveedor.
    const err = params.get('error')
    const errDesc = params.get('error_description')
    if (err) {
      const msg = errDesc
        ? decodeURIComponent(errDesc.replace(/\+/g, ' '))
        : err === 'access_denied'
          ? 'Cancelaste el inicio de sesión.'
          : 'No pudimos completar la autenticación.'
      setUrlError(msg)
      setFase('error')
      setTimeout(() => navigate('/login', { replace: true }), 3000)
      return
    }

    const tokenHash = params.get('token_hash')
    const tipo = params.get('type')

    // A. Sin token_hash es el camino PKCE de siempre: no se toca.
    if (!tokenHash) {
      setFase('listo')
      return
    }

    if (!esTipoOtp(tipo)) {
      navigate('/verificar-email?estado=LINK_EXPIRED_OR_INVALID', { replace: true })
      return
    }

    void (async () => {
      // El token no debe quedar en el historial del navegador. Se limpia la
      // query ANTES de resolver: si el usuario recarga, no se reenvía un token
      // ya consumido (que daría un "link inválido" engañoso).
      window.history.replaceState({}, '', window.location.pathname)

      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: tipo,
      })

      if (!error) {
        if (tipo === 'recovery') {
          navigate('/reset-password', { replace: true })
          return
        }
        setFase('listo')
        return
      }

      // ── Enlace rechazado ────────────────────────────────────────────────
      // Puede ser vencido, inválido, o simplemente YA USADO. El último caso es
      // recuperable y frecuente (el usuario hace click dos veces, o el cliente
      // de correo pre-visita el link). No se decide por el mensaje de error:
      // se relee el estado real.
      const { data } = await supabase.auth.getUser()

      if (data?.user?.email_confirmed_at) {
        // Link ya usado pero la cuenta está confirmada -> continuar normal.
        setFase('listo')
        return
      }

      if (data?.user) {
        // Hay sesión, sigue sin confirmar: la pantalla permite reenviar.
        navigate('/verificar-email?estado=LINK_EXPIRED_OR_INVALID', { replace: true })
        return
      }

      // Sin sesión en este dispositivo (caso cross-device con link vencido).
      // /verificar-email rebotaría a /login, así que se va directo con motivo.
      navigate('/login?motivo=link_invalido', { replace: true })
    })()
  }, [navigate])

  // ── Navegación final, una vez que auth + profile resolvieron ───────────────
  useEffect(() => {
    if (fase !== 'listo') return
    if (navigatedRef.current) return
    if (loading || profileLoading) return

    navigatedRef.current = true

    if (isAuthenticated) {
      navigate(destinoPostConfirmacion(), { replace: true })
    } else {
      setTimeout(() => navigate('/login', { replace: true }), 1500)
    }
  }, [fase, loading, profileLoading, isAuthenticated, navigate])

  // Timeout de seguridad: si en 15s no resuelve, ir al login.
  useEffect(() => {
    if (fase === 'error') return
    const t = setTimeout(() => {
      if (!navigatedRef.current) {
        navigatedRef.current = true
        navigate('/login', { replace: true })
      }
    }, 15_000)
    return () => clearTimeout(t)
  }, [fase, navigate])

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
              Verificando tu cuenta...
            </h2>
            <p style={{ margin: 0, fontSize: '0.875rem', color: '#475569' }}>
              Un momento, estamos confirmando tus datos
            </p>
          </>
        )}
      </div>
    </div>
  )
}
