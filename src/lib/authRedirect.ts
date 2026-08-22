// ─────────────────────────────────────────────────────────────────────────────
// EMAIL VERIFICATION P0 — Origen canónico para los redirects de auth.
//
// Antes había tres formas distintas de armar la misma URL:
//   · `window.location.origin` suelto           (Login / resetPassword)
//   · `VITE_APP_URL || window.location.origin`  (signInWithGoogle)
//   · strings a mano
// y ninguna validaba nada. Este módulo es la única fuente.
//
// POR QUÉ SE PRESERVA EL ORIGEN Y NO SE FUERZA UN DOMINIO FIJO
// ------------------------------------------------------------
// La app se sirve desde más de un dominio y la sesión de Supabase vive en el
// `localStorage` del ORIGEN. Si un cliente del portal mayorista se registra en
// `clicmayorista.com.ar` y el enlace de confirmación lo manda a
// `techrepairpro.app`, la sesión queda del lado equivocado y el alta mayorista
// no puede completarse nunca.
//
// Por eso el origen actual gana, PERO sólo si está en una allowlist cerrada.
// Cualquier otro host cae al dominio canónico. No hay forma de que un host
// arbitrario termine en un `emailRedirectTo`.
//
// La allowlist del panel de Supabase sigue siendo el gate real del lado del
// servidor: esto es defensa en profundidad, no un reemplazo.
// ─────────────────────────────────────────────────────────────────────────────

/** Dominio de producción. Último recurso cuando el origen no es reconocible. */
const CANONICAL_APP_URL = 'https://techrepairpro.app'

/**
 * Hosts que pueden servir `/auth/callback`.
 *
 * `clicmayorista.com.ar` está incluido a propósito: es un dominio del portal
 * mayorista (ver PORTAL_DOMAINS en src/portal/PortalRouter.tsx) y App.tsx monta
 * `/auth/callback` ahí también, justamente para que la confirmación de un
 * cliente mayorista aterrice en su propio origen.
 *
 * Los previews de Vercel NO están: la allowlist del panel de Supabase tampoco
 * los tiene, así que incluirlos acá sólo cambiaría un error claro por un 400
 * del servidor de auth.
 */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'techrepairpro.app',
  'www.techrepairpro.app',
  'clicmayorista.com.ar',
  'www.clicmayorista.com.ar',
])

/** Hosts de desarrollo/E2E. Se aceptan con http. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
])

const isLocalHost = (hostname: string) => LOCAL_HOSTS.has(hostname)

/** `true` si ese origen puede recibir un redirect de auth. */
function isAllowedOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }

  if (isLocalHost(url.hostname)) {
    // En dev/E2E el stack corre sobre http y en puertos variables (5173 de
    // `npm run dev`, 5174 de `dev:e2e`), así que el puerto no se fija.
    return url.protocol === 'http:' || url.protocol === 'https:'
  }

  // Fuera de local, sólo https y sólo hosts conocidos.
  return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname)
}

/**
 * Base canónica para construir URLs de auth. Nunca termina en `/`.
 *
 * Orden: origen actual (si está permitido) -> VITE_APP_URL (si está permitido)
 * -> dominio canónico.
 */
export function getAppBaseUrl(): string {
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : ''
  if (currentOrigin && isAllowedOrigin(currentOrigin)) {
    return currentOrigin.replace(/\/$/, '')
  }

  // `import.meta.env?` con optional chaining: fuera de Vite (los tests de
  // `node --test`) `env` no existe y un acceso directo tiraría TypeError.
  const configured = (import.meta.env?.VITE_APP_URL as string | undefined)?.trim().replace(/\/$/, '')
  if (configured && isAllowedOrigin(configured)) {
    return configured
  }

  return CANONICAL_APP_URL
}

/** URL absoluta del callback de auth (OAuth PKCE y confirmación de correo). */
export function getAuthCallbackUrl(): string {
  return `${getAppBaseUrl()}/auth/callback`
}

/** URL absoluta del formulario de reseteo de contraseña. */
export function getResetPasswordUrl(): string {
  return `${getAppBaseUrl()}/reset-password`
}

/**
 * Rutas de auth que NO pueden ser destino post-login: mandar ahí después de
 * autenticar produce un ciclo (login -> login) o una pantalla que ya cumplió
 * su función (verificar-email -> verificar-email).
 */
const NON_DESTINATION_PREFIXES = ['/login', '/auth/', '/verificar-email', '/logout']

/**
 * Normaliza un destino interno recibido de una fuente no confiable
 * (`?redirectTo=`, `sessionStorage`) y cae al fallback ante cualquier duda.
 *
 * Reglas, todas fail-closed:
 *   · tiene que empezar con EXACTAMENTE una `/`;
 *   · `//host` y `/\host` son protocol-relative -> se rechazan;
 *   · ningún backslash en ninguna posición (los normaliza el browser a `/`);
 *   · ningún caracter de control ni espacio (`/\t/evil.com` termina siendo
 *     protocol-relative después de que el parser de URL los descarta);
 *   · se vuelve a chequear sobre el valor DECODIFICADO, porque `/%2f%2fevil.com`
 *     es `//evil.com` para cualquier router que decodifique;
 *   · un esquema (`https:`, `javascript:`) ya queda descartado por la regla de
 *     la barra inicial, que es anterior a cualquier `:`.
 */
export function sanitizeInternalPath(raw: unknown, fallback = '/dashboard'): string {
  if (typeof raw !== 'string') return fallback

  const value = raw.trim()
  if (!value) return fallback

  // Control chars (C0 + DEL) y cualquier whitespace interno: `value` ya viene
  // trimmeado, asi que todo lo que quede es intermedio y sospechoso. Un
  // `/<tab>/evil.com` termina siendo protocol-relative cuando el parser de URL
  // descarta el tab.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value) || /\s/.test(value)) return fallback

  if (!value.startsWith('/')) return fallback
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback
  if (value.includes('\\')) return fallback

  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    // Escape mal formado: no se puede razonar sobre el valor real.
    return fallback
  }
  if (decoded.startsWith('//') || decoded.startsWith('/\\') || decoded.includes('\\')) return fallback

  const pathOnly = decoded.split(/[?#]/)[0].toLowerCase()
  if (NON_DESTINATION_PREFIXES.some(p => pathOnly === p || pathOnly.startsWith(p))) {
    return fallback
  }

  return value
}

/** Sólo para tests: el dominio al que se cae cuando el origen no es válido. */
export const __CANONICAL_APP_URL_FOR_TESTS = CANONICAL_APP_URL
