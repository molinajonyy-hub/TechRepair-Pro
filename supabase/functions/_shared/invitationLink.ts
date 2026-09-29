/**
 * PRE-BETA-2F — ÚNICA fuente del enlace de invitación.
 *
 * La importan los dos lados, así que no pueden divergir:
 *   · la Edge Function `send-business-invitation` (el enlace del correo);
 *   · el cliente web vía `src/lib/invitationLink.ts` («Copiar link» y la lista de
 *     Invitaciones pendientes).
 *
 * Contrato:
 *   · Producción es SIEMPRE `https://www.techrepairpro.app/accept-invite?token=<encoded>`.
 *   · Nunca se usa como autoridad el `Origin` de un request, la Site URL de Supabase, una
 *     Vercel Preview, clicmayorista.com.ar ni un redirect externo.
 *   · El único override admitido es un origen LOOPBACK (http://localhost, 127.0.0.1, [::1])
 *     para dev/E2E. Cualquier otro valor se ignora y cae al canónico: un override mal
 *     configurado en producción no puede mandar el enlace a otro dominio.
 *   · El token viaja siempre URL-encoded.
 *
 * Puro: sin imports, sin globals de Deno ni del DOM, sin leer env. Lo prueban vitest y Deno.
 */

export const CANONICAL_APP_ORIGIN = 'https://www.techrepairpro.app'
export const ACCEPT_INVITE_PATH = '/accept-invite'

// `URL.hostname` devuelve IPv6 entre corchetes.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Devuelve el origen normalizado si `candidate` es EXACTAMENTE un origen loopback http
 * (sin credenciales, path, query ni fragmento). Cualquier otra cosa → null.
 */
export function loopbackOrigin(candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string') return null
  const raw = candidate.trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null
  if (!LOOPBACK_HOSTS.has(url.hostname)) return null
  if (url.username || url.password) return null
  if (url.pathname !== '/' || url.search || url.hash) return null
  return url.origin
}

/** Origen del enlace: el override sólo si es loopback; si no, el canónico de producción. */
export function resolveInvitationOrigin(override?: string | null): string {
  return loopbackOrigin(override) ?? CANONICAL_APP_ORIGIN
}

/** Ruta interna de aceptación con el token codificado. */
export function invitationPath(token: string): string {
  const clean = typeof token === 'string' ? token.trim() : ''
  return `${ACCEPT_INVITE_PATH}?token=${encodeURIComponent(clean)}`
}

/** Enlace absoluto de aceptación. En producción, siempre el origen canónico. */
export function buildInvitationUrl(token: string, override?: string | null): string {
  return `${resolveInvitationOrigin(override)}${invitationPath(token)}`
}
