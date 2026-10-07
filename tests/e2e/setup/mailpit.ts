// ============================================================================
// PRE-BETA-2D — Acceso a Mailpit (el SMTP local de Supabase) para los E2E.
//
// Un solo lugar que sabe leer el puerto del config y la API de Mailpit. Antes
// cada spec tenía su parser de TOML artesanal y dependía de `[inbucket]`, que la
// CLI ya marca como deprecado.
//
//   · Sección canónica: `[local_smtp]`. `[inbucket]` se acepta SÓLO como
//     compatibilidad (config viejo de otra rama o de otra máquina).
//   · Siempre 127.0.0.1: es el stack local, nunca otro host.
//
// Los enlaces y los tokens nunca se loguean.
// ============================================================================
import { readFileSync } from 'node:fs'

const SECCIONES = ['local_smtp', 'inbucket'] as const

/** Puerto HTTP de Mailpit declarado en un `config.toml`. Pura; `null` si no hay. */
export function mailpitPortFromToml(toml: string): string | null {
  for (const seccion of SECCIONES) {
    const partes = toml.split(new RegExp(`^\\[${seccion}\\]\\s*$`, 'm'))
    if (partes.length < 2) continue
    // El bloque termina en el próximo encabezado de sección.
    const bloque = partes[1].split(/^\[/m)[0]
    const port = bloque.match(/^\s*port\s*=\s*(\d+)/m)?.[1]
    if (port) return port
  }
  return null
}

export function mailpitBase(configPath = 'supabase/config.toml'): string {
  const port = mailpitPortFromToml(readFileSync(configPath, 'utf-8'))
  if (!port) throw new Error(`${configPath} no declara [local_smtp] port`)
  return `http://127.0.0.1:${port}`
}

export interface MensajeMailpit {
  ID: string
  Subject?: string
}

const busqueda = (email: string) => `${mailpitBase()}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`

export async function correosPara(email: string): Promise<MensajeMailpit[]> {
  const r = await fetch(busqueda(email))
  if (!r.ok) throw new Error(`Mailpit respondió ${r.status}`)
  return ((await r.json()) as { messages?: MensajeMailpit[] }).messages ?? []
}

export async function borrarCorreos(email: string): Promise<void> {
  await fetch(busqueda(email), { method: 'DELETE' }).catch(() => {})
}

/** Todos los `href` del HTML de un correo, con `&amp;` resuelto. */
export function enlacesDelHtml(html: string): string[] {
  return [...html.replace(/&amp;/g, '&').matchAll(/href="([^"]+)"/g)].map(m => m[1])
}

/**
 * Espera el correo más reciente para `email` que tenga un enlace que cumpla
 * `predicado`, y devuelve ese enlace. Nunca lo imprime.
 */
export async function esperarEnlace(
  email: string,
  predicado: (href: string) => boolean,
  { intentos = 40, pausaMs = 500 }: { intentos?: number; pausaMs?: number } = {},
): Promise<string> {
  for (let i = 0; i < intentos; i++) {
    for (const msg of await correosPara(email)) {
      const full = (await (await fetch(`${mailpitBase()}/api/v1/message/${msg.ID}`)).json()) as { HTML?: string }
      const href = enlacesDelHtml(full.HTML ?? '').find(predicado)
      if (href) return href
    }
    await new Promise(r => setTimeout(r, pausaMs))
  }
  throw new Error(`No llegó el correo esperado para ${email}`)
}

/** Asunto y HTML del correo más reciente para `email` (para verificar la plantilla). */
export async function ultimoCorreo(email: string): Promise<{ subject: string; html: string } | null> {
  const [msg] = await correosPara(email)
  if (!msg) return null
  const full = (await (await fetch(`${mailpitBase()}/api/v1/message/${msg.ID}`)).json()) as { HTML?: string; Subject?: string }
  return { subject: full.Subject ?? msg.Subject ?? '', html: full.HTML ?? '' }
}

/**
 * BETA-UX-1A — enlace de ayuda (WhatsApp) tal como está VERSIONADO en una
 * plantilla de Auth. Qué número y qué mensaje son válidos lo fija
 * scripts/guards/auth-email-templates.mjs; los E2E comparan contra esto para
 * probar que GoTrue entrega ese enlace sin tocarlo.
 */
export function enlaceSoporteDePlantilla(nombre: 'confirmation' | 'recovery', dir = 'supabase/templates'): string {
  const html = readFileSync(`${dir}/${nombre}.html`, 'utf-8')
  const href = enlacesDelHtml(html).find(h => /^https:\/\/wa\.me\/549\d{10}\?text=/.test(h))
  if (!href) throw new Error(`${dir}/${nombre}.html no trae el enlace de ayuda por WhatsApp`)
  return href
}

/** El enlace `token_hash` de una plantilla PRE-BETA-2D: path `/auth/callback`, tipo dado. */
export const esEnlaceTokenHash = (tipo: 'signup' | 'recovery') => (href: string): boolean => {
  try {
    const u = new URL(href)
    return u.pathname === '/auth/callback' && u.searchParams.get('type') === tipo && !!u.searchParams.get('token_hash')
  } catch {
    return false
  }
}
