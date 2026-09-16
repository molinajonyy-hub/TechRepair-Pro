// ─────────────────────────────────────────────────────────────────────────────
// BETA-GATE-1 · Lote B — Recuperación de contraseña.
//
// POR QUÉ EXISTE ESTE MÓDULO
// --------------------------
// El cliente de Supabase usa el flow `implicit` (el default de supabase-js; no
// se configura `flowType`). MEDIDO contra GoTrue v2.192 local, el enlace del
// correo «Reset your password» es
//
//   /auth/v1/verify?token=…&type=recovery&redirect_to=<origen>/auth/callback
//
// y GoTrue responde 303 a
//
//   <origen>/auth/callback#access_token=…&refresh_token=…&type=recovery
//
// Un enlace YA USADO o vencido vuelve a
//
//   <origen>/auth/callback#error=access_denied&error_code=otp_expired&…
//
// Antes, supabase-js procesaba ese fragmento solo, emitía PASSWORD_RECOVERY en
// un `setTimeout` que nadie escuchaba, y `/auth/callback` —que sólo mira la
// query— tomaba la rama OAuth y mandaba al usuario al Dashboard, logueado y sin
// formulario. `ResetPassword` esperaba un `sessionStorage` que ningún archivo
// escribía.
//
// QUÉ HACE AHORA
// --------------
// 1. `captureRecoveryAtBoot` corre en `src/lib/supabase.ts` ANTES de crear el
//    cliente. Si la URL trae un fragmento de recovery:
//      · elimina el fragmento de la URL ANTES de crear el cliente: reescribe la
//        entrada ACTUAL del historial a `/reset-password` con `replaceState`
//        (no agrega entradas: el fragmento con tokens no queda ni en la barra
//        ni detrás del botón «atrás»);
//      · los tokens recibidos en el fragmento quedan sólo en memoria de este
//        módulo DURANTE el handoff.
//    Como supabase-js lee la URL de forma asíncrona, ya no encuentra nada que
//    procesar.
// 2. `completeRecoveryHandoff` entrega esos tokens a `auth.setSession` (la API
//    documentada para una sesión recibida fuera de la URL), borra la copia en
//    memoria y marca la sesión como «de recovery» para ese usuario.
//    `setSession` instala una sesión NORMAL de Supabase, que el cliente persiste
//    con su storage habitual (`persistSession: true`), igual que cualquier login.
//    Este módulo nunca guarda a mano los tokens del fragmento (ni en
//    sessionStorage ni en ningún otro lado) y nunca los loguea.
// 3. `/reset-password` muestra el formulario SÓLO con sesión vigente + marca del
//    MISMO usuario. Sin eso, muestra «enlace inválido». Nunca el Dashboard.
//
// Lo que NO hace: no toca la config de Auth, ni las plantillas de correo, ni el
// `redirectTo` (sigue siendo `/auth/callback`, la URL exacta ya permitida en la
// allowlist de Redirect URLs). No loguea URLs, tokens ni códigos.
//
// Alcance: el dominio del portal mayorista no monta `/reset-password` ni ofrece
// «olvidé mi contraseña», así que ahí no se intercepta nada (comportamiento
// previo intacto). Un callback `?code=` (PKCE) tampoco se toca: este cliente no
// usa PKCE.
// ─────────────────────────────────────────────────────────────────────────────

export const RECOVERY_PATH = '/reset-password'
export const RECOVERY_MARKER_KEY = 'techrepair.auth.password-recovery'
/** Cuánto vale la marca «esta sesión vino de un enlace de recovery». */
export const RECOVERY_MARKER_TTL_MS = 60 * 60 * 1000
/** Límite de bcrypt en GoTrue: más de 72 bytes se trunca en silencio. */
export const PASSWORD_MAX_BYTES = 72
export const PASSWORD_MIN_LENGTH = 8

/**
 * idle          → no hay un recovery en curso en esta carga de la página.
 * verifying     → llegaron tokens por la URL y se está creando la sesión.
 * ready         → sesión de recovery creada y marcada.
 * invalid_link  → los tokens no sirvieron (usuario inexistente, red, etc.).
 * expired_link  → GoTrue devolvió `otp_expired`: el enlace venció o ya se usó.
 */
export type RecoveryPhase = 'idle' | 'verifying' | 'ready' | 'invalid_link' | 'expired_link'

interface RecoveryTokens {
  access_token: string
  refresh_token: string
}

export type ParsedRecoveryUrl =
  | { kind: 'none' }
  | { kind: 'tokens'; tokens: RecoveryTokens }
  | { kind: 'invalid' }
  | { kind: 'expired' }

const CALLBACK_PATH = '/auth/callback'

/**
 * Interpreta el fragmento de la URL. Puro: no lee `window` ni escribe nada.
 *
 * · `type=recovery` con los dos tokens         → tokens
 * · `type=recovery` sin tokens                  → invalid (enlace malformado)
 * · en `/auth/callback`, `error_code=otp_expired` → expired
 * · cualquier otra cosa (OAuth implícito, errores de OAuth, anclas) → none
 *
 * El error `otp_expired` no trae `type`, por eso se acota a `/auth/callback`:
 * en esta app el único enlace de GoTrue que redirige ahí con ese error es el de
 * recovery (la confirmación de alta usa `token_hash` + `verifyOtp`, y no hay
 * magic link, invitación de GoTrue ni cambio de email).
 */
export function parseRecoveryFragment(hash: string, pathname: string): ParsedRecoveryUrl {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return { kind: 'none' }

  let params: URLSearchParams
  try {
    params = new URLSearchParams(raw)
  } catch {
    return { kind: 'none' }
  }

  if (params.get('type') === 'recovery') {
    const access_token = params.get('access_token')
    const refresh_token = params.get('refresh_token')
    if (access_token && refresh_token) return { kind: 'tokens', tokens: { access_token, refresh_token } }
    return { kind: 'invalid' }
  }

  if (pathname === CALLBACK_PATH && params.get('error_code') === 'otp_expired') {
    return { kind: 'expired' }
  }

  return { kind: 'none' }
}

// ── Estado del recovery en ESTA carga de la página ─────────────────────────────

let phase: RecoveryPhase = 'idle'
let pendingTokens: RecoveryTokens | null = null
const phaseListeners = new Set<() => void>()

function setPhase(next: RecoveryPhase): void {
  if (phase === next) return
  phase = next
  for (const listener of phaseListeners) listener()
}

export function getRecoveryPhase(): RecoveryPhase {
  return phase
}

/** Contrato de `useSyncExternalStore`. */
export function subscribeRecoveryPhase(listener: () => void): () => void {
  phaseListeners.add(listener)
  return () => { phaseListeners.delete(listener) }
}

/** Para `/auth/callback` (camino `token_hash`): el enlace no sirvió. */
export function markRecoveryLinkRejected(): void {
  setPhase('expired_link')
}

// ── Captura en el arranque ─────────────────────────────────────────────────────

interface BootLocation {
  pathname: string
  hash: string
}

interface BootHistory {
  readonly state: unknown
  replaceState(data: unknown, unused: string, url?: string | URL | null): void
}

/**
 * Tiene que correr ANTES de `createClient`. Ver el encabezado del módulo.
 * Devuelve lo que encontró (sin tokens) para poder testearlo.
 */
export function captureRecoveryAtBoot(
  location: BootLocation,
  history: BootHistory,
  options: { isPortalHost: boolean },
): ParsedRecoveryUrl['kind'] {
  if (options.isPortalHost) return 'none'

  const parsed = parseRecoveryFragment(location.hash, location.pathname)
  if (parsed.kind === 'none') return 'none'

  // Sin fragmento y en la pantalla correcta, en la MISMA entrada del historial.
  history.replaceState(history.state, '', RECOVERY_PATH)

  if (parsed.kind === 'tokens') {
    pendingTokens = parsed.tokens
    setPhase('verifying')
  } else if (parsed.kind === 'expired') {
    setPhase('expired_link')
  } else {
    setPhase('invalid_link')
  }
  return parsed.kind
}

// ── Entrega de la sesión ──────────────────────────────────────────────────────

interface RecoverySessionResult {
  data: { session: { user: { id: string } } | null } | null
  error: unknown
}

export interface RecoveryAuthClient {
  setSession(tokens: RecoveryTokens): Promise<RecoverySessionResult>
}

/**
 * Crea la sesión con los tokens capturados. Idempotente: una segunda llamada
 * no hace nada. Nunca lanza y nunca loguea.
 */
export async function completeRecoveryHandoff(auth: RecoveryAuthClient, now: () => number = Date.now): Promise<void> {
  const tokens = pendingTokens
  pendingTokens = null
  if (!tokens) return

  try {
    const { data, error } = await auth.setSession(tokens)
    const userId = data?.session?.user?.id
    if (error || !userId) {
      setPhase('invalid_link')
      return
    }
    markRecoverySession(userId, now())
    setPhase('ready')
  } catch {
    setPhase('invalid_link')
  }
}

/** Sólo para tests: si la copia en memoria de los tokens del fragmento sigue pendiente de entrega. */
export function hasPendingRecoveryTokens(): boolean {
  return pendingTokens !== null
}

// ── Marca «esta sesión vino de un enlace de recovery» ───────────────────────────
//
// sessionStorage (por pestaña) y NUNCA con tokens: sólo el id del usuario y la
// hora. (La sesión en sí la persiste supabase-js con su storage habitual; esta
// marca es aparte y no la reemplaza.) Sirve para que un reload de `/reset-password` siga mostrando el
// formulario, y para que una sesión normal NO lo muestre. La copia en memoria
// cubre navegadores donde el storage tira (modo privado estricto).

interface RecoveryMarker {
  v: 1
  userId: string
  at: number
}

let memoryMarker: RecoveryMarker | null = null

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function markRecoverySession(userId: string, at: number = Date.now()): void {
  memoryMarker = { v: 1, userId, at }
  try {
    sessionStore()?.setItem(RECOVERY_MARKER_KEY, JSON.stringify(memoryMarker))
  } catch {
    // la copia en memoria alcanza para esta carga de la página
  }
}

function readMarker(): RecoveryMarker | null {
  try {
    const raw = sessionStore()?.getItem(RECOVERY_MARKER_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RecoveryMarker>
      if (parsed && parsed.v === 1 && typeof parsed.userId === 'string' && typeof parsed.at === 'number') {
        return { v: 1, userId: parsed.userId, at: parsed.at }
      }
    }
  } catch {
    // storage ilegible o JSON roto: se cae a la copia en memoria
  }
  return memoryMarker
}

export function hasRecoverySession(userId: string, now: number = Date.now()): boolean {
  const marker = readMarker()
  if (!marker || marker.userId !== userId) return false
  const age = now - marker.at
  return age >= 0 && age <= RECOVERY_MARKER_TTL_MS
}

export function clearRecoverySession(): void {
  memoryMarker = null
  try {
    sessionStore()?.removeItem(RECOVERY_MARKER_KEY)
  } catch {
    // nada que limpiar
  }
}

/** Cierre del flujo tras guardar la contraseña. */
export function finishRecovery(): void {
  clearRecoverySession()
  setPhase('idle')
}

// ── Listener global ───────────────────────────────────────────────────────────

export interface RecoveryAuthEvents {
  onAuthStateChange(callback: (event: string, session: { user: { id: string } } | null) => void): unknown
}

/**
 * `PASSWORD_RECOVERY` lo emite supabase-js cuando `verifyOtp({ type: 'recovery' })`
 * crea la sesión (camino `token_hash`). `SIGNED_OUT` invalida la marca.
 * El callback corre con el lock de auth tomado: NO llamar métodos de auth acá.
 */
export function installRecoveryAuthListener(auth: RecoveryAuthEvents): void {
  auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY' && session?.user?.id) markRecoverySession(session.user.id)
    else if (event === 'SIGNED_OUT') clearRecoverySession()
  })
}

// ── Validación y mensajes (puros) ─────────────────────────────────────────────

export interface PasswordFieldErrors {
  password?: string
  confirm?: string
}

export function validateNewPassword(password: string, confirm: string): PasswordFieldErrors {
  const errors: PasswordFieldErrors = {}
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Usá al menos ${PASSWORD_MIN_LENGTH} caracteres.`
  } else if (password.trim().length === 0) {
    errors.password = 'La contraseña no puede ser sólo espacios.'
  } else if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
    // El límite es de 72 BYTES UTF-8 (bcrypt), no de caracteres: el copy no da un número.
    errors.password = 'Usá una contraseña más corta.'
  }
  if (!confirm) {
    errors.confirm = 'Repetí la contraseña.'
  } else if (confirm !== password) {
    errors.confirm = 'Las contraseñas no coinciden.'
  }
  return errors
}

interface AuthErrorLike {
  code?: unknown
  status?: unknown
  name?: unknown
}

export type PasswordUpdateFailure =
  | { kind: 'field'; message: string }
  | { kind: 'session' }
  | { kind: 'retry'; message: string }

/**
 * Traduce el error de `updateUser({ password })` sin mostrar nunca el texto
 * crudo del servidor.
 */
export function classifyPasswordUpdateError(error: unknown): PasswordUpdateFailure {
  const e = (error ?? {}) as AuthErrorLike
  const code = typeof e.code === 'string' ? e.code : ''
  const status = typeof e.status === 'number' ? e.status : 0
  const name = typeof e.name === 'string' ? e.name : ''

  if (code === 'same_password') {
    return { kind: 'field', message: 'La nueva contraseña tiene que ser distinta de la anterior.' }
  }
  if (code === 'weak_password') {
    return { kind: 'field', message: 'Esa contraseña es muy débil. Probá con una más larga o menos común.' }
  }
  if (
    name === 'AuthSessionMissingError'
    || ['session_not_found', 'session_expired', 'bad_jwt', 'no_authorization', 'user_not_found', 'reauthentication_needed'].includes(code)
    || status === 401
    || status === 403
  ) {
    return { kind: 'session' }
  }
  if (code === 'over_request_rate_limit' || status === 429) {
    return { kind: 'retry', message: 'Hiciste varios intentos seguidos. Esperá un minuto y volvé a probar.' }
  }
  return { kind: 'retry', message: 'No pudimos guardar la contraseña. Revisá tu conexión e intentá de nuevo.' }
}

/**
 * Pedido de «olvidé mi contraseña». Sólo un fallo de RED se informa como error:
 * MEDIDO en GoTrue, un email inexistente responde 200 y el MISMO email pedido
 * dos veces seguidas responde 429 `over_email_send_rate_limit`. Si la UI
 * mostrara ese 429 (o un 500 del envío), la pantalla delataría que la cuenta
 * existe; por eso todo lo que no es red se presenta con el mismo mensaje neutro.
 *
 * Alcance: la UI no revela existencia de cuenta. El comportamiento observable
 * del endpoint Auth directo (`/auth/v1/recover`) y sus rate limits pertenece a
 * Supabase/GoTrue y queda como riesgo residual de infraestructura: este módulo
 * no lo resuelve ni pretende hacerlo.
 */
export function classifyRecoveryRequestError(error: unknown): 'network' | 'neutral' {
  if (!error) return 'neutral'
  const e = error as AuthErrorLike
  const name = typeof e.name === 'string' ? e.name : ''
  const status = typeof e.status === 'number' ? e.status : undefined
  if (name === 'AuthRetryableFetchError' || status === 0) return 'network'
  return 'neutral'
}

export const RECOVERY_REQUEST_SENT_MESSAGE =
  'Si existe una cuenta asociada a ese correo, te enviamos instrucciones. Revisá también la carpeta de spam.'
