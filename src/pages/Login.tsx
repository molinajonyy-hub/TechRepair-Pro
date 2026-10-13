import { useEffect, useId, useRef, useState, type FocusEvent, type FormEvent } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { ArrowLeft, Lock, Mail, User, UserPlus } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { sanitizeInternalPath, getAuthCallbackUrl } from '../lib/authRedirect'
import {
  classifyRecoveryRequestError,
  markRecoveryRequested,
  RECOVERY_REQUEST_SENT_MESSAGE,
} from '../lib/passwordRecovery'
import {
  PASSWORD_MATCH_MESSAGE,
  PASSWORD_PLACEHOLDER,
  PASSWORD_REQUIREMENT,
  checkPasswordPolicy,
  validatePasswordPair,
  validateTypedPasswordPair,
} from '../lib/passwordPolicy'
import {
  AUTH_URL_ERROR_MESSAGE,
  GOOGLE_START_ERROR_MESSAGE,
  RESEND_MESSAGE,
  SIGNUP_ERROR_MESSAGE,
  classifyAuthUrlError,
  classifySignInError,
  signUpErrorMessage,
  type SignInFailure,
} from '../lib/authErrors'
import { canalSoporte } from '../config/contacto'
import { SupportContactLink } from '../components/ui/SupportContactButton'
import { initialLoginMode, planFromInternalPath, rememberSignupPlan, type LoginMode } from '../lib/signupIntent'
import {
  DEFAULT_POST_AUTH_PATH,
  clearPostLoginRedirect,
  consumePostAuthDestination,
  isInvitationDestination,
  rememberPostLoginRedirect,
} from '../lib/postAuthDestination'
import {
  AuthFlowShell, AuthFlowForm, AuthFlowNote,
  AuthFlowPrimaryButton, AuthFlowSecondaryButton, AuthFlowTextButton,
} from '../components/auth/AuthFlowShell'
import {
  AuthFlowAlert, AuthFlowDivider, AuthFlowPasswordField, AuthFlowRequirement,
  AuthFlowSegmented, AuthFlowTextField, focusLeftField,
} from '../components/auth/AuthFlowFields'

// ─────────────────────────────────────────────────────────────────────────────
// /login — ingreso, alta y pedido de recuperación.
//
// BETA-UX-1G — la pantalla usa el shell, los campos y los botones del embudo
// (AuthFlowShell / AuthFlowFields). La lógica de auth es la certificada en
// PRE-BETA-2D: errores por mapa cerrado, política de contraseña única, pedido de
// recuperación neutro y `?redirectTo=` saneado. Lo que cambió de comportamiento:
//   · el email se conserva al cambiar de modo (antes «¿Olvidaste tu
//     contraseña?» lo borraba justo después de un intento fallido);
//   · Google se ofrece también en «Crear cuenta»;
//   · quien llega desde una invitación lo ve dicho, y arranca en «Crear cuenta»;
//   · el destino posterior al ingreso sale de una sola regla
//     (src/lib/postAuthDestination.ts);
//   · un reenvío de confirmación que falla lo dice.
// ─────────────────────────────────────────────────────────────────────────────

/** Login con email y contraseña: textos propios, nunca el de GoTrue. */
const SIGN_IN_ERROR_MESSAGE: Record<SignInFailure, string> = {
  email_not_confirmed: 'Tu cuenta todavía no está confirmada. Revisá tu correo y hacé click en el enlace que te enviamos.',
  invalid_credentials: 'Email o contraseña incorrectos. Verificá tus datos.',
  rate_limited: 'Demasiados intentos seguidos. Esperá un minuto y volvé a probar.',
  network: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  unknown: 'No pudimos iniciar sesión. Intentá nuevamente en un momento.',
}

/**
 * `?motivo=` lo escriben pantallas propias (/auth/callback, la captura de
 * arranque). Enum cerrado: un valor desconocido no pinta nada.
 */
const MOTIVO_MESSAGE: Readonly<Record<string, string>> = {
  link_invalido: 'Ese enlace de confirmación venció o ya no es válido. Iniciá sesión para pedir uno nuevo.',
  enlace_vencido:
    'El enlace que abriste venció o ya se usó. Si querías restablecer tu contraseña, tocá «¿Olvidaste tu contraseña?» para pedir uno nuevo. Si estabas confirmando tu correo, iniciá sesión y te ofrecemos reenviarlo.',
  // BETA-UX-1G — /auth/callback sin sesión (ver AUTH_CALLBACK_NO_SESSION_PATH).
  sesion_no_iniciada: AUTH_URL_ERROR_MESSAGE.failed,
}

const EMAIL_MESSAGE = {
  missing: 'Ingresá tu email.',
  invalid: 'Revisá el email: no parece una dirección válida.',
} as const

const PASSWORD_MISSING_MESSAGE = 'Ingresá tu contraseña.'
const NETWORK_REQUEST_MESSAGE = 'No pudimos enviar el pedido. Revisá tu conexión e intentá de nuevo.'

const validateEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)

const DESCRIPCION: Record<LoginMode, string> = {
  login: 'Ingresá a tu panel de gestión',
  register: 'Creá tu cuenta gratuita',
  forgot: 'Recuperá el acceso a tu cuenta',
}

/** Quien llega desde una invitación no está empezando una prueba: se suma a un equipo. */
const DESCRIPCION_INVITADO: Record<LoginMode, string> = {
  login: 'Iniciá sesión para sumarte al equipo',
  register: 'Creá tu cuenta para sumarte al equipo',
  forgot: DESCRIPCION.forgot,
}

const MODOS = [
  { id: 'login', label: 'Iniciar sesión', testId: 'login-tab-login' },
  { id: 'register', label: 'Crear cuenta', testId: 'login-tab-register' },
] as const

type ResendState = 'idle' | 'sending' | 'sent' | 'limited'

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  )
}

/** `location.state.from` lo escribe el router (ProtectedRoute), pero se trata igual que la URL. */
function pathFromRouterState(state: unknown): string | undefined {
  const from = (state as { from?: { pathname?: unknown; search?: unknown } } | null)?.from
  if (!from || typeof from.pathname !== 'string') return undefined
  return from.pathname + (typeof from.search === 'string' ? from.search : '')
}

// ── Componente ───────────────────────────────────────────────────────

export function Login() {
  const navigate    = useNavigate()
  const location    = useLocation()
  const { signIn, signUp, signInWithGoogle, resendConfirmation, isAuthenticated, emailConfirmed } = useAuth()
  const panelId = useId()

  // Support ?redirectTo=... from direct links (e.g., PWA deep links or Mi Guita shortcuts)
  //
  // `?redirectTo=` es entrada NO CONFIABLE: viene de la URL, así que la escribe
  // cualquiera. Sin normalizar, un `?redirectTo=//evil.com` convertía el login
  // en un open redirect. `sanitizeInternalPath` exige un path interno y cae a
  // /dashboard ante cualquier duda.
  //
  // `location.state.from` lo escribe el router, no la URL, pero pasa por el
  // mismo filtro: una sola regla, sin excepciones que auditar.
  const searchRedirect = new URLSearchParams(location.search).get('redirectTo')
  const from = sanitizeInternalPath(searchRedirect ?? pathFromRouterState(location.state), DEFAULT_POST_AUTH_PATH)

  // BETA-UX-1G — el login reconoce que el destino es una invitación. Sólo cambia
  // el texto y el modo inicial: aceptar sigue exigiendo sesión y lo decide el
  // servidor con el correo de la cuenta.
  const invitado = isInvitationDestination(from)

  // `?modo=recuperar` abre directo el pedido de enlace: lo usa «Pedir un enlace
  // nuevo» desde /reset-password cuando el anterior venció. `?modo=registro`
  // abre «Crear cuenta»: lo usan los CTAs de prueba de la landing (PRE-BETA-2D).
  // Sin `?modo=`, quien llega desde una invitación arranca en «Crear cuenta»:
  // lo habitual es que todavía no tenga cuenta.
  const [mode, setMode] = useState<LoginMode>(() => {
    const explicito = new URLSearchParams(location.search).has('modo')
    return !explicito && invitado ? 'register' : initialLoginMode(location.search)
  })
  const [email, setEmail]                       = useState('')
  const [password, setPassword]                 = useState('')
  const [confirmPassword, setConfirmPassword]   = useState('')
  const [fullName, setFullName]                 = useState('')
  const [isLoading, setIsLoading]               = useState(false)
  const [isGoogleLoading, setIsGoogleLoading]   = useState(false)
  const [error, setError]                       = useState('')
  const [success, setSuccess]                   = useState('')
  const [emailError, setEmailError]             = useState('')
  const [passwordError, setPasswordError]       = useState('')
  const [confirmError, setConfirmError]         = useState('')
  /**
   * Email cuyo login falló por falta de confirmación.
   *
   * En ese punto NO hay sesión, así que /verificar-email no es alcanzable
   * (rebotaría a /login). El reenvío se ofrece acá mismo: la API `resend` de
   * Supabase no necesita sesión y responde igual exista o no la cuenta, así
   * que tampoco revela emails de terceros.
   */
  const [pendingConfirmationEmail, setPendingConfirmationEmail] = useState('')
  const [resendState, setResendState] = useState<ResendState>('idle')

  const emailInputRef = useRef<HTMLInputElement>(null)
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const confirmInputRef = useRef<HTMLInputElement>(null)
  /** La salida de esta pantalla ocurre una sola vez (el destino guardado se consume). */
  const leftRef = useRef(false)

  // Errores que vuelven por la URL (OAuth, GoTrue). PRE-BETA-2D: el texto sale
  // de un mapa cerrado. `?error_description=` lo escribe cualquiera que arme un
  // link hacia el dominio oficial, así que no se lee ni se muestra jamás.
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const errorKind = classifyAuthUrlError(params)
    if (errorKind) {
      setError(AUTH_URL_ERROR_MESSAGE[errorKind])
      return
    }
    // Enlaces vencidos: /auth/callback (sin sesión) y la captura de arranque
    // derivan acá con un motivo del enum, no con un mensaje del servidor.
    const motivo = params.get('motivo')
    if (motivo && Object.prototype.hasOwnProperty.call(MOTIVO_MESSAGE, motivo)) {
      setError(MOTIVO_MESSAGE[motivo])
    }
  }, [location.search])

  // Foco inicial en el email. Al entrar o salir del pedido de recuperación el
  // control que se tocó desaparece, así que el foco vuelve al email; entre
  // «Iniciar sesión» y «Crear cuenta» se queda en el selector, que sigue ahí.
  const modoAnterior = useRef(mode)
  useEffect(() => {
    const anterior = modoAnterior.current
    modoAnterior.current = mode
    if (anterior === mode || anterior === 'forgot' || mode === 'forgot') emailInputRef.current?.focus()
  }, [mode])

  useEffect(() => {
    if (!isAuthenticated || leftRef.current) return
    // BETA-GATE-1 · Lote B — pidiendo un enlace nuevo no se redirige. Caso real:
    // el mismo enlace abierto dos veces. La primera pestaña crea la sesión de
    // recovery (compartida por localStorage) y la segunda ve «enlace vencido»;
    // su «Pedir un enlace nuevo» no puede terminar en el Dashboard.
    if (mode === 'forgot') return

    leftRef.current = true

    // Sesión sin correo confirmado: el destino es la pantalla de verificación,
    // no el producto. Si se navegara al destino guardado, ProtectedRoute
    // rebotaría igual, pero pasando por una pantalla intermedia que parpadea.
    if (!emailConfirmed) {
      navigate('/verificar-email', { replace: true })
      return
    }

    navigate(consumePostAuthDestination({ requested: from }), { replace: true })
  }, [isAuthenticated, emailConfirmed, from, navigate, mode])

  // BETA-UX-1A — canal de ayuda canónico. Mensaje fijo: no lleva el email.
  const soporteCorreo = canalSoporte('correoNoLlega')

  const clearErrors = () => {
    setError(''); setSuccess('')
    setEmailError(''); setPasswordError(''); setConfirmError('')
    setPendingConfirmationEmail(''); setResendState('idle')
  }

  const handleResendFromLogin = async () => {
    if (!pendingConfirmationEmail || resendState === 'sending' || resendState === 'sent') return
    setResendState('sending')
    const res = await resendConfirmation(pendingConfirmationEmail)
    if (res.status === 'sent') {
      setError('')
      setResendState('sent')
    } else if (res.status === 'rate_limited') {
      setError('')
      setResendState('limited')
    } else {
      // Antes el botón volvía a su estado inicial sin decir nada.
      setError(RESEND_MESSAGE.error)
      setResendState('idle')
    }
  }

  // El email se conserva entre modos: «¿Olvidaste tu contraseña?» llega justo
  // después de un intento fallido, con el correo ya escrito.
  const handleModeChange = (m: LoginMode) => {
    if (m === mode) return
    setMode(m); clearErrors()
    setPassword(''); setConfirmPassword('')
  }

  /**
   * Valida el email y devuelve el valor a usar, o `null`. El `trim` es
   * defensivo: MEDIDO en Chromium y WebKit, un `type="email"` ya entrega su
   * valor sin espacios alrededor.
   */
  const emailListo = (): string | null => {
    const limpio = email.trim()
    if (!limpio) { setEmailError(EMAIL_MESSAGE.missing); emailInputRef.current?.focus(); return null }
    if (!validateEmail(limpio)) { setEmailError(EMAIL_MESSAGE.invalid); emailInputRef.current?.focus(); return null }
    return limpio
  }

  // Mientras se completa: se avisa de lo YA escrito al salir del campo. Un campo
  // vacío no es un error hasta que se intenta enviar.
  const handleEmailBlur = () => {
    const limpio = email.trim()
    if (limpio && !validateEmail(limpio)) setEmailError(EMAIL_MESSAGE.invalid)
  }

  const handleNewPasswordBlur = (e: FocusEvent<HTMLInputElement>) => {
    if (mode !== 'register' || !focusLeftField(e)) return
    const fallas = validateTypedPasswordPair(password, confirmPassword)
    if (fallas.password) setPasswordError(fallas.password)
    if (fallas.confirm) setConfirmError(fallas.confirm)
  }

  const handleForgotPassword = async (e: FormEvent) => {
    e.preventDefault()
    clearErrors()
    const destinatario = emailListo()
    if (!destinatario) return
    setIsLoading(true)
    try {
      // Mismo origen canónico que el resto de los redirects de auth. No cambia
      // el destino (sigue siendo /auth/callback), sólo deja de depender de
      // `window.location.origin` sin validar.
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(destinatario, {
        redirectTo: getAuthCallbackUrl(),
      })
      // BETA-GATE-1 · Lote B — la UI no revela si la cuenta existe. MEDIDO: GoTrue
      // responde 200 para un email inexistente, pero 429 cuando el MISMO email
      // (existente) pide dos enlaces seguidos. Sólo un fallo de red se informa
      // como error; todo lo demás recibe el mismo mensaje neutro. El endpoint
      // Auth directo y sus rate limits son de Supabase/GoTrue: riesgo residual
      // de infraestructura, fuera del alcance de esta pantalla.
      if (resetError && classifyRecoveryRequestError(resetError) === 'network') {
        setError(NETWORK_REQUEST_MESSAGE)
        return
      }
      // PRE-BETA-2D — evidencia local (sólo la hora) de que este navegador pidió
      // un recovery: permite nombrar bien un enlace legacy vencido. No revela
      // nada: se marca igual exista o no la cuenta.
      markRecoveryRequested()
      setSuccess(RECOVERY_REQUEST_SENT_MESSAGE)
    } catch {
      setError(NETWORK_REQUEST_MESSAGE)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    clearErrors()

    const cuenta = emailListo()
    if (!cuenta) return
    if (!password.trim()) { setPasswordError(PASSWORD_MISSING_MESSAGE); passwordInputRef.current?.focus(); return }

    // PRE-BETA-2D — la política (src/lib/passwordPolicy.ts) aplica a contraseñas
    // NUEVAS. El login no la exige: hay cuentas creadas con el mínimo anterior,
    // y bloquearles el ingreso desde el formulario sería romperles el acceso.
    if (mode === 'register') {
      const fallas = validatePasswordPair(password, confirmPassword)
      if (fallas.password) { setPasswordError(fallas.password); passwordInputRef.current?.focus(); return }
      if (fallas.confirm) { setConfirmError(fallas.confirm); confirmInputRef.current?.focus(); return }
    }

    setIsLoading(true)
    try {
      if (mode === 'login') {
        await signIn(cuenta, password)
        if (leftRef.current) return
        leftRef.current = true
        navigate(consumePostAuthDestination({ requested: from }), { replace: true })
      } else {
        const result = await signUp(cuenta, password, fullName.trim() || undefined)
        if (result.needsEmailConfirmation) {
          // P0-P2: preservar el destino a través de la confirmación de correo.
          // Sin esto, alguien que llega desde el enlace de una invitación y se
          // registra pierde el destino: al volver del enlace de confirmación,
          // AuthCallback no encuentra el destino guardado y lo manda a
          // /dashboard, dejando la invitación sin aceptar.
          //
          // El token de la invitación además queda guardado aparte (localStorage
          // con TTL, ver src/lib/pendingInvite.ts) porque `sessionStorage` es POR
          // PESTAÑA y el enlace del correo suele abrirse en una nueva.
          rememberPostLoginRedirect(from)
          // PRE-BETA-2D — el plan elegido en la landing sobrevive a la
          // confirmación en otra pestaña (donde el destino guardado no existe).
          const plan = planFromInternalPath(from)
          if (plan) rememberSignupPlan(plan)
          // NO es un error: con Confirm Email ON, Supabase crea el usuario y
          // devuelve `session: null`. El destino es la pantalla dedicada, que
          // ofrece reenviar y verificar. Antes se volvía al formulario de
          // login con un cartelito, y el usuario quedaba sin salida clara.
          setIsLoading(false)
          navigate('/verificar-email', { replace: true })
          return
        }
        leftRef.current = true
        navigate('/no-business', { replace: true })
      }
    } catch (err: unknown) {
      // PRE-BETA-2D — clasificación CERRADA (src/lib/authErrors.ts). Ningún
      // camino muestra `err.message`: el alta devolvía el texto crudo de GoTrue
      // en inglés («Email rate limit exceeded») en todo lo no mapeado.
      if (mode === 'login') {
        // `email not confirmed` va en su propia rama: con Confirm Email ON es el
        // error MÁS común del login, y antes se le decía «contraseña incorrecta».
        const kind = classifySignInError(err)
        if (kind === 'email_not_confirmed') {
          // Sin sesión no hay /verificar-email: el reenvío se ofrece acá mismo.
          setPendingConfirmationEmail(cuenta)
        }
        setError(SIGN_IN_ERROR_MESSAGE[kind])
      } else {
        setError(signUpErrorMessage(err))
      }
      setIsLoading(false)
    }
  }

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true); clearErrors()
    rememberPostLoginRedirect(from)
    // Con Google no hay correo que confirmar en otra pestaña, pero el plan
    // elegido en la landing viaja igual que en el alta por email.
    const plan = planFromInternalPath(from)
    if (plan) rememberSignupPlan(plan)
    try {
      await signInWithGoogle()
    } catch {
      clearPostLoginRedirect()
      setError(GOOGLE_START_ERROR_MESSAGE)
      setIsGoogleLoading(false)
    }
  }

  const disabled = isLoading || isGoogleLoading
  const descripciones = invitado ? DESCRIPCION_INVITADO : DESCRIPCION
  // El alta falló al ENVIAR un correo: reintentar puede no alcanzar, así que
  // son los únicos errores que ofrecen el canal de ayuda (BETA-UX-1A). Se
  // deriva del mensaje, sin estado propio.
  const errorOfreceAyuda = error === SIGNUP_ERROR_MESSAGE.email_send_failed || error === RESEND_MESSAGE.error
  const registrando = mode === 'register'

  return (
    <AuthFlowShell
      testId="login-page"
      estado={mode}
      brand="hero"
      description={descripciones[mode]}
      back={{ label: 'Volver al inicio', onClick: () => navigate('/landing'), testId: 'login-back-landing' }}
      footer={mode === 'login' && !invitado ? (
        <>
          <span>¿No tenés cuenta?</span>{' '}
          <button
            type="button"
            className="auth-flow__inline-link"
            data-testid="login-trial-cta"
            // Este enlace desaparece al cambiar de modo: el foco sigue en el formulario.
            onClick={() => { handleModeChange('register'); emailInputRef.current?.focus() }}
            disabled={disabled}
          >
            Probalo 14 días gratis
          </button>
        </>
      ) : undefined}
    >
      <AuthFlowForm>
        {invitado && mode !== 'forgot' && (
          <AuthFlowAlert tone="info" role="note" icon={<UserPlus aria-hidden="true" />} testId="login-invite-context">
            <p><strong>Te invitaron a un equipo en TechRepair Pro.</strong></p>
            <p>
              {registrando
                ? 'Creá tu cuenta con el correo en el que recibiste la invitación. Si ya tenés una, elegí «Iniciar sesión».'
                : 'Iniciá sesión con el correo en el que recibiste la invitación. Si todavía no tenés cuenta, elegí «Crear cuenta».'}
            </p>
          </AuthFlowAlert>
        )}

        {/* Modo (sólo ingreso / alta; el pedido de recuperación tiene su vuelta propia) */}
        {mode !== 'forgot' && (
          <AuthFlowSegmented
            label="Cómo querés entrar"
            options={MODOS}
            value={mode}
            onChange={handleModeChange}
            disabled={disabled}
            panelId={panelId}
          />
        )}

        {error && (
          <AuthFlowAlert tone="error" testId="login-error">
            {error}
            {errorOfreceAyuda && soporteCorreo.tipo === 'whatsapp' && (
              <>
                {' '}Si sigue fallando,{' '}
                <SupportContactLink canal={soporteCorreo} testId="login-error-soporte">
                  escribinos por WhatsApp
                </SupportContactLink>.
              </>
            )}
          </AuthFlowAlert>
        )}

        {/* Reenvío: sólo cuando el login falló por falta de confirmación. */}
        {pendingConfirmationEmail && resendState === 'sent' && (
          <AuthFlowAlert tone="success" testId="login-resend-sent">{RESEND_MESSAGE.sent}</AuthFlowAlert>
        )}
        {pendingConfirmationEmail && resendState === 'limited' && (
          <AuthFlowAlert tone="warning" testId="login-resend-limited">{RESEND_MESSAGE.rate_limited}</AuthFlowAlert>
        )}
        {pendingConfirmationEmail && (resendState === 'idle' || resendState === 'sending') && (
          <AuthFlowSecondaryButton
            onClick={() => void handleResendFromLogin()}
            loading={resendState === 'sending'}
            data-testid="login-resend-confirmation"
          >
            {resendState === 'sending' ? 'Enviando…' : 'Reenviar correo de confirmación'}
          </AuthFlowSecondaryButton>
        )}

        {success && <AuthFlowAlert tone="success" testId="login-success">{success}</AuthFlowAlert>}

        {/* Pedido de recuperación de contraseña */}
        {mode === 'forgot' && (
          <form onSubmit={handleForgotPassword} noValidate data-testid="login-forgot-form" className="auth-flow__form">
            <AuthFlowTextField
              id="forgot-email"
              data-testid="login-forgot-email"
              errorTestId="login-forgot-email-error"
              ref={emailInputRef}
              label="Email de tu cuenta"
              icon={<Mail />}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="send"
              placeholder="tu@email.com"
              value={email}
              disabled={isLoading}
              error={emailError}
              onChange={e => { setEmail(e.target.value); setEmailError(''); setError('') }}
              onBlur={handleEmailBlur}
            />

            <AuthFlowPrimaryButton type="submit" data-testid="login-forgot-submit" loading={isLoading}>
              {isLoading ? 'Enviando…' : 'Enviar enlace de recuperación'}
            </AuthFlowPrimaryButton>

            <AuthFlowTextButton
              data-testid="login-forgot-back"
              onClick={() => handleModeChange('login')}
              leftIcon={<ArrowLeft aria-hidden="true" />}
            >
              Volver al inicio de sesión
            </AuthFlowTextButton>
          </form>
        )}

        {/* Ingreso / alta */}
        {mode !== 'forgot' && (
          <div id={panelId} role="tabpanel" aria-label={registrando ? 'Crear cuenta' : 'Iniciar sesión'}>
          <form onSubmit={handleSubmit} noValidate className="auth-flow__form">
            {registrando && (
              <AuthFlowTextField
                id="fullName"
                data-testid="login-fullname"
                label="Nombre completo"
                optional
                icon={<User />}
                type="text"
                autoComplete="name"
                autoCapitalize="words"
                placeholder="Juan Pérez"
                value={fullName}
                disabled={disabled}
                onChange={e => setFullName(e.target.value)}
              />
            )}

            <AuthFlowTextField
              id="email"
              data-testid="login-email"
              errorTestId="login-email-error"
              ref={emailInputRef}
              label="Email"
              icon={<Mail />}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="tu@email.com"
              value={email}
              disabled={disabled}
              error={emailError}
              onChange={e => { setEmail(e.target.value); setEmailError(''); setError('') }}
              onBlur={handleEmailBlur}
            />

            <AuthFlowPasswordField
              id="password"
              data-testid="login-password"
              errorTestId="login-password-error"
              toggleTestId="login-toggle-password"
              ref={passwordInputRef}
              label="Contraseña"
              icon={<Lock />}
              autoComplete={registrando ? 'new-password' : 'current-password'}
              placeholder={registrando ? PASSWORD_PLACEHOLDER : '••••••••'}
              value={password}
              disabled={disabled}
              error={passwordError}
              hint={registrando && password
                ? <AuthFlowRequirement met={checkPasswordPolicy(password) === null}>{PASSWORD_REQUIREMENT}</AuthFlowRequirement>
                : undefined}
              onChange={e => { setPassword(e.target.value); setPasswordError(''); setError('') }}
              onBlur={handleNewPasswordBlur}
            />

            {registrando && (
              <AuthFlowPasswordField
                id="confirmPassword"
                data-testid="login-confirm-password"
                errorTestId="login-confirm-password-error"
                toggleTestId="login-toggle-confirm"
                ref={confirmInputRef}
                label="Confirmar contraseña"
                icon={<Lock />}
                autoComplete="new-password"
                placeholder="Repetí la contraseña"
                value={confirmPassword}
                disabled={disabled}
                error={confirmError}
                hint={confirmPassword && confirmPassword === password
                  ? <AuthFlowRequirement met>{PASSWORD_MATCH_MESSAGE}</AuthFlowRequirement>
                  : undefined}
                onChange={e => { setConfirmPassword(e.target.value); setConfirmError(''); setError('') }}
                onBlur={handleNewPasswordBlur}
              />
            )}

            <AuthFlowPrimaryButton type="submit" data-testid="login-submit" loading={isLoading} disabled={disabled}>
              {isLoading
                ? (registrando ? 'Creando cuenta…' : 'Iniciando sesión…')
                : (registrando ? 'Crear cuenta gratis' : 'Iniciar sesión')}
            </AuthFlowPrimaryButton>
          </form>
          </div>
        )}

        {/* Google: en los dos modos (la cuenta se crea igual en el primer ingreso) */}
        {mode !== 'forgot' && (
          <>
            <AuthFlowDivider>o continuá con</AuthFlowDivider>
            <AuthFlowSecondaryButton
              onClick={() => void handleGoogleSignIn()}
              loading={isGoogleLoading}
              disabled={disabled}
              leftIcon={<GoogleMark />}
              data-testid="login-google"
            >
              {isGoogleLoading ? 'Redirigiendo a Google…' : 'Continuar con Google'}
            </AuthFlowSecondaryButton>
          </>
        )}

        {mode === 'login' && (
          <AuthFlowTextButton data-testid="login-forgot-link" onClick={() => handleModeChange('forgot')} disabled={disabled}>
            ¿Olvidaste tu contraseña?
          </AuthFlowTextButton>
        )}

        {/*
          Antes decía «Términos de uso y Política de privacidad» con los dos
          enlaces en href="#": prometía dos documentos que no existían. La
          política ya existe y se enlaza de verdad. La mención a los términos
          se saca hasta que ese documento exista — prometer algo inexistente
          en la pantalla de registro es peor que no mencionarlo.
        */}
        <AuthFlowNote center>
          Al continuar, declarás haber leído nuestra{' '}
          <Link to="/privacidad" data-testid="login-link-privacidad">Política de privacidad</Link>.
        </AuthFlowNote>
      </AuthFlowForm>
    </AuthFlowShell>
  )
}
