import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CircleAlert } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { markRecoveryLinkRejected, markRecoverySession } from '../lib/passwordRecovery'
import {
  AUTH_CALLBACK_NO_SESSION_PATH,
  AUTH_URL_ERROR_MESSAGE,
  AUTH_URL_ERROR_TITLE,
  classifyAuthUrlError,
  type AuthUrlErrorKind,
} from '../lib/authErrors'
import { isEmailLinkType } from '../lib/authEmailLink'
import { consumePostAuthDestination } from '../lib/postAuthDestination'
import { PORTAL_DOMAINS } from '../portal/portalDomains'
import { AuthFlowShell, AuthFlowLoading, AuthFlowPrimaryButton } from '../components/auth/AuthFlowShell'

/**
 * Callback único de autenticación. Soporta TRES caminos:
 *
 *   A. OAuth (Google) por flujo implícito: vuelve con `#access_token=…` en el
 *      fragmento y lo resuelve supabase-js solo (`detectSessionInUrl`). Este
 *      cliente no usa PKCE. Acá sólo se espera a que AuthContext termine de
 *      resolver auth + profile y se navega.
 *
 *   B. Enlace de correo  `?token_hash=...&type=signup|recovery`
 *      Se verifica con `supabase.auth.verifyOtp({ token_hash, type })`.
 *
 *      POR QUÉ token_hash Y NO ConfirmationURL/PKCE: el flujo PKCE exige el
 *      `code_verifier` que quedó en el localStorage del navegador ORIGINAL. El
 *      caso real es registrarse en la compu y abrir el correo en el celular:
 *      ahí no hay verifier y el link muere. `verifyOtp` con `token_hash` no
 *      depende del navegador de origen, así que la confirmación es válida
 *      cross-device. Además el enlace apunta a la app, no a GoTrue: un escáner
 *      de correo que lo pre-abra no consume el token (lo consume este JS).
 *
 *   C. Error que vuelve por la query `?error=...`
 *      PRE-BETA-2D: `error_description` NO se muestra ni se lee. El texto sale
 *      de un mapa cerrado (`classifyAuthUrlError`).
 *
 *   (Recovery legacy por fragmento `#access_token=…&type=recovery`, y el error
 *   `#error_code=otp_expired`, NUNCA llegan a este componente: los captura
 *   `src/lib/passwordRecovery.ts` al arrancar, antes de crear el cliente.
 *   BETA-GATE-1 · Lote B; clasificación de `otp_expired` en PRE-BETA-2D.)
 *
 * Nada de esto confía en un query param como autoridad: el estado final
 * siempre se relee de la sesión/servidor. No existe `?verified=true`.
 *
 * BETA-UX-1G — la pantalla usa el shell del embudo (antes tenía un fondo y una
 * tarjeta oscuros fijos, sin tema ni marca). Cambios de comportamiento:
 *   · un error que vuelve por la URL se queda en pantalla con su salida
 *     («Volver a iniciar sesión»). Antes se mostraba 3 segundos y saltaba solo
 *     a un login que no explicaba nada;
 *   · cuando la sesión no queda creada, el login lo dice (`?motivo=`): antes se
 *     volvía en silencio y parecía que el botón de Google no había hecho nada;
 *   · el destino sale de la misma regla que usa el login
 *     (src/lib/postAuthDestination.ts: destino guardado → invitación pendiente
 *     → /dashboard, respetando el dominio dedicado del portal).
 */

type Fase = 'verificando' | 'listo' | 'error'

/** Tope de espera a que auth + perfil resuelvan. Pasado eso, se vuelve al login. */
const CALLBACK_TIMEOUT_MS = 15_000
/** Margen antes de dar la sesión por no creada. */
const NO_SESSION_GRACE_MS = 1_500

export function AuthCallback() {
  const navigate = useNavigate()
  const { isAuthenticated, loading, profileLoading } = useAuth()
  const [urlError, setUrlError] = useState<AuthUrlErrorKind | null>(null)
  const [fase, setFase] = useState<Fase>('verificando')
  // Con `token_hash` se está validando un enlace de correo; sin él, es Google.
  const [esEnlace] = useState(() => new URLSearchParams(window.location.search).has('token_hash'))
  const navigatedRef = useRef(false)
  const procesadoRef = useRef(false)

  // ── Camino C + B ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (procesadoRef.current) return
    procesadoRef.current = true

    const params = new URLSearchParams(window.location.search)

    // C. Error que vuelve por la URL. Mapa cerrado: `error_description` lo
    // escribe cualquiera que arme el link, así que ni se lee.
    const errorKind = classifyAuthUrlError(params)
    if (errorKind) {
      // Los parámetros del error no quedan en la barra ni en el historial.
      window.history.replaceState(window.history.state, '', window.location.pathname)
      setUrlError(errorKind)
      setFase('error')
      return
    }

    const tokenHash = params.get('token_hash')
    const tipo = params.get('type')

    // A. Sin token_hash es el camino OAuth implícito de siempre: no se toca.
    if (!tokenHash) {
      setFase('listo')
      return
    }

    if (!isEmailLinkType(tipo)) {
      navigate('/verificar-email?estado=LINK_EXPIRED_OR_INVALID', { replace: true })
      return
    }

    void (async () => {
      // El token no debe quedar en el historial del navegador. Se limpia la
      // query ANTES de resolver: si el usuario recarga, no se reenvía un token
      // ya consumido (que daría un "link inválido" engañoso).
      window.history.replaceState({}, '', window.location.pathname)

      const { data: verificado, error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: tipo,
      })

      // BETA-GATE-1 · Lote B — recovery por `token_hash`. /reset-password sólo
      // muestra el formulario con una sesión MARCADA como de recovery; sin la
      // marca quedaba en «Verificando enlace…» para siempre. Si el enlace no
      // sirvió, la pantalla lo dice en vez de caer al circuito de confirmación
      // de alta (que no aplica a quien olvidó su contraseña).
      if (tipo === 'recovery') {
        const userId = verificado?.user?.id
        if (!error && userId) markRecoverySession(userId)
        else markRecoveryLinkRejected()
        navigate('/reset-password', { replace: true })
        return
      }

      if (!error) {
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

  // En un dominio exclusivo del portal mayorista todo cuelga de la raíz: el
  // PortalRouter se monta en `/` y no existe `/dashboard`. Mandar ahí a un
  // cliente mayorista lo sacaría de su portal. Tampoco se le muestra la marca
  // de TechRepair Pro: ese dominio es del comercio.
  const enPortal = Boolean(PORTAL_DOMAINS[window.location.hostname])

  // ── Navegación final, una vez que auth + profile resolvieron ───────────────
  useEffect(() => {
    if (fase !== 'listo') return
    if (navigatedRef.current) return
    if (loading || profileLoading) return

    if (isAuthenticated) {
      navigatedRef.current = true
      // P0-P2 — el destino guardado vive en sessionStorage, que es POR PESTAÑA,
      // y el enlace de confirmación se abre casi siempre en una pestaña nueva:
      // ahí el respaldo es la invitación pendiente (localStorage con TTL).
      navigate(consumePostAuthDestination({ portalHost: enPortal }), { replace: true })
      return
    }

    // Sin sesión. Se espera un momento por si llega tarde: si llega, este
    // efecto vuelve a correr (el temporizador se cancela) y sigue por arriba.
    const t = setTimeout(() => {
      if (navigatedRef.current) return
      navigatedRef.current = true
      navigate(AUTH_CALLBACK_NO_SESSION_PATH, { replace: true })
    }, NO_SESSION_GRACE_MS)
    return () => clearTimeout(t)
  }, [fase, loading, profileLoading, isAuthenticated, navigate, enPortal])

  // Tope de seguridad: si no resuelve, al login (que explica por qué).
  useEffect(() => {
    if (fase === 'error') return
    const t = setTimeout(() => {
      if (!navigatedRef.current) {
        navigatedRef.current = true
        navigate(AUTH_CALLBACK_NO_SESSION_PATH, { replace: true })
      }
    }, CALLBACK_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [fase, navigate])

  const marca = enPortal ? 'none' : 'compact'

  if (fase === 'error' && urlError) {
    return (
      <AuthFlowShell
        testId="auth-callback-page"
        estado={`error:${urlError}`}
        cardTestId="auth-callback-error"
        brand={marca}
        align="center"
        tone={urlError === 'oauth_cancelled' ? 'warning' : 'danger'}
        icon={<CircleAlert size={26} />}
        title={AUTH_URL_ERROR_TITLE[urlError]}
        description={AUTH_URL_ERROR_MESSAGE[urlError]}
      >
        <AuthFlowPrimaryButton
          data-testid="auth-callback-volver"
          onClick={() => navigate('/login', { replace: true })}
        >
          Volver a iniciar sesión
        </AuthFlowPrimaryButton>
      </AuthFlowShell>
    )
  }

  return (
    <AuthFlowLoading
      pageTestId="auth-callback-page"
      estado="verificando"
      testId="auth-callback-loading"
      brand={marca}
      label={esEnlace ? 'Verificando tu enlace…' : 'Iniciando sesión…'}
    />
  )
}
