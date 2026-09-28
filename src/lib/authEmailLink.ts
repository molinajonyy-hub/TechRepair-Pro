// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — Contrato de los enlaces de correo de Auth (`token_hash`).
//
// Las plantillas de Supabase (versionadas en `supabase/templates/`) arman:
//
//   {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup
//   {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery
//
// `.RedirectTo` es el `emailRedirectTo`/`redirectTo` que mandó el cliente
// (`getAuthCallbackUrl()`), así que el enlace aterriza en `/auth/callback`.
//
// EL FALLBACK DE LA RAÍZ
// ----------------------
// Si el `redirect_to` no está en la allowlist de Redirect URLs, GoTrue lo
// degrada al Site URL (MEDIDO en 2A, X1/X2) y el enlace queda en
// `/?token_hash=…&type=signup`, donde nadie lo procesa. Acá se reconoce ESE
// contrato —y sólo ese— y se reescribe la entrada del historial a
// `/auth/callback` con los mismos dos parámetros, antes de que monte el router.
//
// No es un parser de redirects: no hay destino configurable, el path de salida
// es fijo, y cualquier cosa fuera del contrato exacto se deja pasar sin tocar.
// ─────────────────────────────────────────────────────────────────────────────

export const AUTH_CALLBACK_PATH = '/auth/callback'

/** Tipos de enlace de correo que la app verifica con `verifyOtp`. Cerrado a propósito. */
export const EMAIL_LINK_TYPES = ['signup', 'email', 'recovery'] as const
export type EmailLinkType = (typeof EMAIL_LINK_TYPES)[number]

export const isEmailLinkType = (v: string | null): v is EmailLinkType =>
  !!v && (EMAIL_LINK_TYPES as readonly string[]).includes(v)

/**
 * Forma de un `token_hash` de GoTrue: un hash hexadecimal, con prefijo `pkce_`
 * en el flujo PKCE. Se acepta el alfabeto de URL sin caracteres especiales y con
 * un largo acotado: no hace falta más para distinguirlo de un valor arbitrario.
 */
const TOKEN_HASH_RE = /^[A-Za-z0-9_-]{16,256}$/

interface BootLocation {
  pathname: string
  search: string
  hash: string
}

interface BootHistory {
  readonly state: unknown
  replaceState(data: unknown, unused: string, url?: string | URL | null): void
}

/**
 * Destino interno para un enlace de correo que cayó en la raíz, o `null` si la
 * URL no es EXACTAMENTE ese contrato. Pura.
 *
 * Exige: path `/`, sin fragmento, y una query con dos parámetros, `token_hash`
 * (forma de hash) y `type` (del enum), cada uno una sola vez.
 */
export function rootEmailLinkTarget(location: BootLocation): string | null {
  if (location.pathname !== '/') return null
  if (location.hash && location.hash !== '#') return null

  let params: URLSearchParams
  try {
    params = new URLSearchParams(location.search)
  } catch {
    return null
  }

  const keys = [...params.keys()]
  if (keys.length !== 2) return null
  if (params.getAll('token_hash').length !== 1 || params.getAll('type').length !== 1) return null

  const tokenHash = params.get('token_hash') ?? ''
  const type = params.get('type')
  if (!TOKEN_HASH_RE.test(tokenHash)) return null
  if (!isEmailLinkType(type)) return null

  const out = new URLSearchParams({ token_hash: tokenHash, type })
  return `${AUTH_CALLBACK_PATH}?${out.toString()}`
}

/**
 * Tiene que correr antes de que el router lea la URL. Reescribe la entrada
 * ACTUAL (sin agregar otra): el token no queda duplicado en el historial, y
 * `/auth/callback` lo borra de la barra antes de verificarlo.
 */
export function redirectRootEmailLinkAtBoot(location: BootLocation, history: BootHistory): boolean {
  const target = rootEmailLinkTarget(location)
  if (!target) return false
  history.replaceState(history.state, '', target)
  return true
}
