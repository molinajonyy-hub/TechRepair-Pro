// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1G — Destino después de autenticarse. Una sola regla.
//
// Antes había dos copias que no decían lo mismo:
//   · `/auth/callback` (Google, enlace de correo): destino guardado → invitación
//     pendiente → /dashboard;
//   · `/login` con contraseña: navegaba al `redirectTo` de la URL sin consumir
//     el destino guardado y sin mirar la invitación pendiente.
// El caso real que se perdía: quien se registra desde una invitación, confirma
// el correo en el celular y vuelve a la pestaña original a «iniciar sesión»
// terminaba en «Creá tu taller» en vez de entrar al equipo que lo invitó.
//
// Ningún valor de acá es autoridad: el destino guardado y el pedido por la URL
// pasan por `sanitizeInternalPath` (sólo paths internos, nunca el login ni las
// rutas de auth), y que el usuario pueda o no ver la pantalla lo deciden los
// guards y el servidor.
// ─────────────────────────────────────────────────────────────────────────────
import { sanitizeInternalPath } from './authRedirect'
import { ACCEPT_INVITE_PATH, invitationPath } from './invitationLink'
import { peekInviteToken } from './pendingInvite'

/** Destino pedido antes de autenticarse. `sessionStorage`: vale para la pestaña. */
export const POST_LOGIN_REDIRECT_KEY = 'post_login_redirect'

/** Adonde va quien no pidió ningún destino. */
export const DEFAULT_POST_AUTH_PATH = '/dashboard'

function tabStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    // Safari en modo privado y algunos WebViews tiran al TOCAR el storage.
    return null
  }
}

/** Guarda el destino para recuperarlo al volver de Google o del correo. */
export function rememberPostLoginRedirect(path: string): void {
  try {
    tabStore()?.setItem(POST_LOGIN_REDIRECT_KEY, path)
  } catch {
    // Sin storage se pierde el destino, no el ingreso.
  }
}

export function clearPostLoginRedirect(): void {
  try {
    tabStore()?.removeItem(POST_LOGIN_REDIRECT_KEY)
  } catch {
    // nada que limpiar
  }
}

function takeStoredRedirect(): string {
  let stored: string | null = null
  try {
    stored = tabStore()?.getItem(POST_LOGIN_REDIRECT_KEY) ?? null
  } catch {
    stored = null
  }
  clearPostLoginRedirect()
  return sanitizeInternalPath(stored, '')
}

export interface PostAuthDestinationOptions {
  /** Destino pedido por la pantalla actual (`?redirectTo=`, `state.from`). No confiable. */
  requested?: string | null
  /**
   * Dominio dedicado del portal mayorista: ahí todo cuelga de la raíz (el
   * PortalRouter se monta en `/` y no existe `/dashboard`).
   */
  portalHost?: boolean
}

/**
 * Resuelve y CONSUME el destino: el guardado se borra para que una sesión
 * posterior no lo herede.
 *
 * Orden: destino guardado por esta pestaña → destino pedido por la pantalla →
 * invitación pendiente (el enlace del correo se abre en otra pestaña, donde
 * `sessionStorage` está vacío) → /dashboard.
 */
export function consumePostAuthDestination(options: PostAuthDestinationOptions = {}): string {
  if (options.portalHost) return '/'

  const stored = takeStoredRedirect()
  if (stored) return stored

  const requested = sanitizeInternalPath(options.requested, '')
  if (requested && requested !== DEFAULT_POST_AUTH_PATH) return requested

  const invitation = peekInviteToken()
  if (invitation) return invitationPath(invitation)

  return DEFAULT_POST_AUTH_PATH
}

/** `true` si ese path interno es la pantalla de aceptación de una invitación. */
export function isInvitationDestination(path: string | null | undefined): boolean {
  if (typeof path !== 'string') return false
  return path.split(/[?#]/)[0] === ACCEPT_INVITE_PATH
}
