// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2F — Enlace de invitación del lado web.
//
// La forma del enlace NO se decide acá: sale de la misma fuente que usa la Edge
// Function que manda el correo (`supabase/functions/_shared/invitationLink.ts`).
// Así el link del correo, «Copiar link» y la lista de Invitaciones pendientes son
// SIEMPRE el mismo.
//
// Producción: siempre `https://www.techrepairpro.app/accept-invite?token=...`.
// El origen de la pestaña (que puede ser una Vercel Preview, el apex o cualquier
// otro host) NO es autoridad. Sólo fuera de un build de producción se ofrece como
// candidato, y el helper compartido lo acepta únicamente si es loopback
// (localhost / 127.0.0.1 / [::1]) — dev y E2E locales.
// ─────────────────────────────────────────────────────────────────────────────
import {
  buildInvitationUrl,
  invitationPath,
} from '../../supabase/functions/_shared/invitationLink.ts'

export interface LinkRuntime {
  /** `import.meta.env.MODE` del build. */
  mode: string
  /** Origen de la pestaña. Sólo se considera fuera de producción, y sólo si es loopback. */
  origin: string | null
}

function currentRuntime(): LinkRuntime {
  const mode = import.meta.env.MODE
  if (mode === 'production' || typeof window === 'undefined') return { mode, origin: null }
  return { mode, origin: window.location.origin }
}

/** Resolución pura (testeable): producción nunca mira el origen de la pestaña. */
export function invitationUrlFor(token: string, runtime: LinkRuntime): string {
  const override = runtime.mode === 'production' ? null : runtime.origin
  return buildInvitationUrl(token, override)
}

/** Enlace absoluto de aceptación para «Copiar link» y la lista de pendientes. */
export function invitationUrl(token: string): string {
  return invitationUrlFor(token, currentRuntime())
}

export { invitationPath }
