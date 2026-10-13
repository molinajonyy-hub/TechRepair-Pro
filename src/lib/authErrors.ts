// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — Clasificación CERRADA de errores de Auth.
//
// Regla: ningún texto de GoTrue, de supabase-js ni de la URL llega a la
// pantalla. Cada error se reduce a un `kind` de un enum cerrado a partir de
// señales estructurales (`code`, `status`, `name`) y, sólo como compatibilidad
// con versiones viejas de GoTrue, de fragmentos conocidos del mensaje. El texto
// visible sale siempre de un mapa de este archivo o del de cada pantalla.
//
// Un valor desconocido NO se muestra: cae al mensaje genérico.
// ─────────────────────────────────────────────────────────────────────────────
import { isWeakPasswordError, weakPasswordMessage } from './passwordPolicy.ts'

interface AuthErrorShape {
  code: string
  status: number | null
  name: string
  /** Sólo para la compatibilidad por fragmentos. Nunca se muestra. */
  text: string
}

function shape(error: unknown): AuthErrorShape {
  const e = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>
  return {
    code: typeof e.code === 'string' ? e.code : '',
    status: typeof e.status === 'number' ? e.status : null,
    name: typeof e.name === 'string' ? e.name : '',
    text: typeof e.message === 'string' ? e.message.toLowerCase() : '',
  }
}

/**
 * `AuthRetryableFetchError` es lo que supabase-js devuelve cuando no hubo
 * respuesta HTTP (status 0) o el gateway falló (502/503/504/52x).
 */
function isNetwork(s: AuthErrorShape): boolean {
  return s.name === 'AuthRetryableFetchError' || s.status === 0
    || s.text.includes('failed to fetch') || s.text.includes('networkerror') || s.text.includes('network request failed')
}

function isRateLimited(s: AuthErrorShape): boolean {
  return s.status === 429
    || s.code === 'over_email_send_rate_limit'
    || s.code === 'over_request_rate_limit'
    || s.text.includes('rate limit')
    || s.text.includes('too many')
}

// ── Alta (signUp) ─────────────────────────────────────────────────────────────

export type SignUpFailure =
  | 'already_registered'
  | 'rate_limited'
  | 'weak_password'
  | 'invalid_email'
  | 'email_send_failed'
  | 'network'
  | 'unknown'

export function classifySignUpError(error: unknown): SignUpFailure {
  const s = shape(error)
  if (isWeakPasswordError(error)) return 'weak_password'
  if (isNetwork(s)) return 'network'
  if (isRateLimited(s)) return 'rate_limited'
  if (
    s.code === 'user_already_exists' || s.code === 'email_exists'
    || s.text.includes('already registered') || s.text.includes('already been registered')
  ) return 'already_registered'
  if (s.code === 'email_address_invalid' || s.text.includes('invalid format')) return 'invalid_email'
  // Con Confirm Email ON un fallo del SMTP hace que GoTrue devuelva 500 y NO
  // cree el usuario (medido en scripts/e2e/ci-local.mjs). `email_address_not_authorized`
  // es el rechazo del SMTP incorporado de Supabase a una casilla ajena al equipo.
  if (
    s.code === 'email_address_not_authorized'
    || s.text.includes('error sending') || s.text.includes('smtp')
    || (s.status !== null && s.status >= 500 && s.text.includes('email'))
  ) return 'email_send_failed'
  return 'unknown'
}

export const SIGNUP_ERROR_MESSAGE: Record<Exclude<SignUpFailure, 'weak_password'>, string> = {
  // Neutro a propósito (decisión del owner, PRE-BETA-2D): la clasificación
  // sigue existiendo, pero el texto NO confirma que la cuenta exista.
  already_registered: 'No pudimos completar el registro. Si ya tenés una cuenta, iniciá sesión o recuperá tu contraseña.',
  rate_limited: 'Hiciste varios intentos seguidos. Esperá unos minutos y volvé a probar.',
  invalid_email: 'Revisá el email: no parece una dirección válida.',
  // BETA-UX-1A — sin casilla de contacto en el texto: la salida de ayuda es un
  // enlace al canal canónico que la pantalla agrega junto al mensaje (Login).
  email_send_failed: 'No pudimos enviar el correo de confirmación. Probá de nuevo en unos minutos.',
  network: 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.',
  unknown: 'No pudimos crear la cuenta. Intentá nuevamente en unos minutos.',
}

/** Texto visible del alta. `overrides` permite a otra superficie (portal) cambiar el copy, no el contrato. */
export function signUpErrorMessage(
  error: unknown,
  overrides: Partial<Record<Exclude<SignUpFailure, 'weak_password'>, string>> = {},
): string {
  const kind = classifySignUpError(error)
  if (kind === 'weak_password') return weakPasswordMessage(error)
  return overrides[kind] ?? SIGNUP_ERROR_MESSAGE[kind]
}

// ── Login (signInWithPassword) ────────────────────────────────────────────────

export type SignInFailure =
  | 'email_not_confirmed'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'network'
  | 'unknown'

export function classifySignInError(error: unknown): SignInFailure {
  const s = shape(error)
  if (s.code === 'email_not_confirmed' || s.text.includes('email not confirmed') || s.text.includes('not confirmed')) {
    return 'email_not_confirmed'
  }
  if (isNetwork(s)) return 'network'
  if (isRateLimited(s)) return 'rate_limited'
  if (s.code === 'invalid_credentials' || s.text.includes('invalid login') || s.text.includes('invalid credentials')) {
    return 'invalid_credentials'
  }
  return 'unknown'
}

// ── Reenvío de confirmación ───────────────────────────────────────────────────

export type ResendOutcome = 'sent' | 'rate_limited' | 'error'

/** Resultado de `auth.resend`. 429 es el único fallo que el usuario resuelve solo (esperando). */
export function classifyResendResult(error: unknown): ResendOutcome {
  if (!error) return 'sent'
  return isRateLimited(shape(error)) ? 'rate_limited' : 'error'
}

/**
 * BETA-UX-1G — texto del reenvío, uno por resultado. Lo comparten el login y
 * /verificar-email: antes cada pantalla tenía su versión, y el login no decía
 * nada cuando el reenvío fallaba (el botón volvía a su estado inicial).
 */
export const RESEND_MESSAGE: Record<ResendOutcome, string> = {
  sent: 'Te reenviamos el correo de confirmación. Revisá tu bandeja de entrada y la carpeta de spam.',
  rate_limited: 'Ya enviamos varios correos en poco tiempo. Esperá unos minutos antes de pedir otro.',
  error: 'No pudimos reenviar el correo. Probá de nuevo en unos minutos.',
}

// ── Errores que vuelven por la URL (OAuth / GoTrue) ───────────────────────────
//
// `?error_description=` lo escribe cualquiera que arme un link: NO es UI
// confiable. Ni se lee. Sólo se miran `error` y `error_code`, y sólo contra
// valores conocidos.

export type AuthUrlErrorKind = 'oauth_cancelled' | 'link_expired' | 'failed'

export const AUTH_URL_ERROR_MESSAGE: Record<AuthUrlErrorKind, string> = {
  oauth_cancelled: 'Cancelaste el inicio de sesión con Google.',
  link_expired: 'El enlace venció o ya se usó. Pedí uno nuevo.',
  failed: 'No pudimos completar el inicio de sesión. Intentá nuevamente.',
}

/**
 * BETA-UX-1G — título de la pantalla de `/auth/callback` para cada error. Antes
 * decía «Error al iniciar sesión» también cuando el usuario había cancelado.
 */
export const AUTH_URL_ERROR_TITLE: Record<AuthUrlErrorKind, string> = {
  oauth_cancelled: 'No iniciaste sesión',
  link_expired: 'El enlace ya no es válido',
  failed: 'No pudimos iniciar tu sesión',
}

/**
 * BETA-UX-1G — `/auth/callback` volvía al login en silencio cuando la sesión no
 * quedaba creada (Google que no completa, el callback abierto a mano, la espera
 * que vence). El login lo explica con un `?motivo=` de su enum cerrado.
 */
export const AUTH_CALLBACK_NO_SESSION_PATH = '/login?motivo=sesion_no_iniciada'

/**
 * `null` si la URL no trae error. Los valores no reconocidos caen en `failed`.
 *
 * · `error_code=otp_expired`             → link_expired
 * · `error=access_denied` sin `error_code` → oauth_cancelled. Es la forma en
 *   que GoTrue reenvía el rechazo del proveedor (el usuario canceló en Google).
 *   Un `access_denied` CON código es un 403 propio de GoTrue: no es «cancelaste».
 * · cualquier otra combinación             → failed
 */
export function classifyAuthUrlError(params: URLSearchParams): AuthUrlErrorKind | null {
  const error = params.get('error')
  const code = params.get('error_code')
  if (!error && !code) return null
  if (code === 'otp_expired') return 'link_expired'
  if (error === 'access_denied' && !code) return 'oauth_cancelled'
  return 'failed'
}

// ── Google (signInWithOAuth) ──────────────────────────────────────────────────

export const GOOGLE_START_ERROR_MESSAGE = 'No pudimos abrir el inicio de sesión con Google. Intentá nuevamente.'
