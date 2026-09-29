/**
 * PRE-BETA-2F — Plantilla transaccional de invitación (versionada en el repo).
 *
 * Reglas de la plantilla:
 *   · TODO texto dinámico se escapa antes de entrar al HTML (el nombre del negocio lo
 *     escribe el owner; nunca es HTML confiable).
 *   · El asunto se sanea como texto de header: sin CR/LF ni controles, whitespace
 *     normalizado y longitud acotada.
 *   · Sin imágenes remotas, sin píxeles, sin tracking, sin Reply-To.
 *   · Sin CONTACTO_SOPORTE: esa casilla hoy no se monitorea y el SaaS Support Inbox sigue
 *     pendiente (P0).
 *   · El token aparece UNA sola vez en el HTML: dentro del href del botón.
 *   · El correo del destinatario no se imprime en el cuerpo.
 *
 * Puro: sin imports ni globals de Deno. Lo prueban vitest y Deno.
 */

export const INVITATION_EMAIL_TEMPLATE_VERSION = 'business-invitation/v1'

export const INVITATION_FROM = 'TechRepair Pro <no-reply@techrepairpro.app>'

/** Roles que una invitación puede otorgar. `owner` jamás (misma allowlist que la RPC). */
export const INVITABLE_ROLES = ['admin', 'manager', 'tech', 'sales', 'cashier', 'viewer'] as const
export type InvitableRole = typeof INVITABLE_ROLES[number]

/** Mapa server-side de etiquetas. El rol sale de la fila de la DB, nunca del request. */
export const ROLE_LABELS: Readonly<Record<InvitableRole, string>> = {
  admin: 'Administrador',
  manager: 'Gerente',
  tech: 'Técnico',
  sales: 'Ventas',
  cashier: 'Cajero',
  viewer: 'Visualizador',
}

export const isInvitableRole = (value: unknown): value is InvitableRole =>
  typeof value === 'string' && (INVITABLE_ROLES as readonly string[]).includes(value)

/** Nombre a mostrar cuando el negocio no se pudo leer o está vacío. */
export const FALLBACK_BUSINESS_NAME = 'un equipo'

/** Largo máximo (en caracteres) del nombre del negocio dentro del asunto y del cuerpo. */
export const MAX_BUSINESS_NAME_LENGTH = 80

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

/** C0, DEL, C1 y los separadores Unicode de línea (U+2028) y párrafo (U+2029). */
const isControlCodePoint = (cp: number): boolean =>
  cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029

/**
 * Texto apto para un header de correo: controles (incluidos CR, LF, TAB, NUL y los
 * separadores Unicode de línea/párrafo) → espacio, whitespace colapsado, recortado y acotado
 * a `maxLength` caracteres (por code point, no parte surrogates). Si se recorta, termina en «…».
 */
export function sanitizeHeaderText(value: unknown, maxLength = MAX_BUSINESS_NAME_LENGTH): string {
  if (typeof value !== 'string') return ''
  const flat = [...value]
    .map((ch) => (isControlCodePoint(ch.codePointAt(0) ?? 0) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...flat]
  if (chars.length <= maxLength) return flat
  return `${chars.slice(0, Math.max(1, maxLength - 1)).join('').trimEnd()}…`
}

/** Nombre del negocio listo para asunto y cuerpo; nunca vacío. */
export function displayBusinessName(raw: unknown): string {
  return sanitizeHeaderText(raw) || FALLBACK_BUSINESS_NAME
}

export interface InvitationEmailInput {
  businessName: string
  role: InvitableRole
  /** Enlace absoluto de aceptación, armado SIEMPRE con _shared/invitationLink.ts. */
  acceptUrl: string
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

export function renderInvitationEmail(input: InvitationEmailInput): RenderedEmail {
  const name = displayBusinessName(input.businessName)
  const roleLabel = ROLE_LABELS[input.role]
  const subject = sanitizeHeaderText(`Te invitaron a ${name} — TechRepair Pro`, 160)

  const nameHtml = escapeHtml(name)
  const roleHtml = escapeHtml(roleLabel)
  const hrefHtml = escapeHtml(input.acceptUrl)

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f5f7;">
<tr>
<td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background-color:#ffffff;border-radius:12px;border:1px solid #e5e7eb;">
<tr>
<td style="padding:32px 32px 8px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<p style="margin:0 0 24px 0;font-size:16px;font-weight:700;color:#4f46e5;">TechRepair Pro</p>
<p style="margin:0 0 4px 0;font-size:16px;color:#374151;">Te invitaron a unirte a</p>
<p style="margin:0 0 20px 0;font-size:22px;font-weight:700;color:#111827;">${nameHtml}</p>
<p style="margin:0 0 4px 0;font-size:14px;color:#6b7280;">Rol:</p>
<p style="margin:0 0 28px 0;font-size:16px;font-weight:700;color:#111827;">${roleHtml}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="border-radius:8px;background-color:#4f46e5;">
<a href="${hrefHtml}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">Aceptar invitación</a>
</td>
</tr>
</table>
</td>
</tr>
<tr>
<td style="padding:24px 32px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<p style="margin:0 0 12px 0;font-size:14px;line-height:1.5;color:#4b5563;">Usá el mismo correo al que recibiste esta invitación. Si todavía no tenés una cuenta de TechRepair Pro, podés crearla al abrir el enlace.</p>
<p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280;">Si no esperabas esta invitación, ignorá este correo.</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`

  const text = [
    'TechRepair Pro',
    '',
    `Te invitaron a unirte a ${name}`,
    `Rol: ${roleLabel}`,
    '',
    'Aceptar invitación:',
    input.acceptUrl,
    '',
    'Usá el mismo correo al que recibiste esta invitación. Si todavía no tenés una cuenta de TechRepair Pro, podés crearla al abrir el enlace.',
    '',
    'Si no esperabas esta invitación, ignorá este correo.',
    '',
  ].join('\n')

  return { subject, html, text }
}
