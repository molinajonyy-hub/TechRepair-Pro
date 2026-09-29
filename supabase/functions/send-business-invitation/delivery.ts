/**
 * PRE-BETA-2F — Transporte de la invitación por Resend.
 *
 *   · La clave (RESEND_INVITES_API_KEY) la pasa el caller desde Deno.env. Acá nunca se lee
 *     env, nunca se imprime, nunca se devuelve.
 *   · `Idempotency-Key` en TODOS los envíos (Resend lo respeta 24 h):
 *       create_and_send → estable por invitación: un retry de red o un doble submit no
 *                         generan dos correos;
 *       resend          → acotada al minuto UTC: un doble click no duplica, un reenvío
 *                         posterior sí es real.
 *   · El resultado es un código CONTROLADO. Nunca se propaga el body, el status text ni el
 *     mensaje del proveedor.
 *   · Sin tracking, sin imágenes, sin Reply-To: el payload lleva sólo from/to/subject/html/text.
 *
 * Puro: `fetch` se inyecta. Lo prueba Deno sin red.
 */
import { INVITATION_FROM } from './email.ts'

export const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails'
export const RESEND_TIMEOUT_MS = 10_000

export type DeliveryCode =
  | 'not_configured'          // falta RESEND_INVITES_API_KEY
  | 'invalid_recipient'       // la fila trae un correo que no se puede usar como destinatario
  | 'provider_unauthorized'   // 401/403: clave inválida, revocada o sin permiso de dominio
  | 'provider_rejected'       // otros 4xx: payload rechazado
  | 'provider_conflict'       // 409: idempotencia en conflicto / en curso
  | 'rate_limited'            // 429: cuota o rate limit
  | 'provider_error'          // 5xx o respuesta 2xx sin id
  | 'network_error'           // timeout o fallo de transporte

export type DeliveryOutcome =
  | { status: 'sent'; httpStatus: number }
  | { status: 'failed'; code: DeliveryCode; httpStatus: number | null }

export interface OutgoingEmail {
  to: string
  subject: string
  html: string
  text: string
}

/** create_and_send: estable por invitación. */
export function createIdempotencyKey(invitationId: string): string {
  return `invite-create-${invitationId}`
}

/** resend: acotada al minuto UTC (`YYYYMMDDHHmm`). */
export function resendIdempotencyKey(invitationId: string, now: Date): string {
  const minute = now.toISOString().slice(0, 16).replace(/[-:T]/g, '')
  return `invite-resend-${invitationId}-${minute}`
}

/**
 * Destinatario conservador (forma HTML5): un solo buzón, sin display name, sin comas, sin
 * espacios ni `<>`. La DB acepta formas más laxas; si una fila no pasa, no se envía nada.
 */
const RECIPIENT =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

export const isDeliverableRecipient = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 254 && RECIPIENT.test(value)

export function buildResendRequest(apiKey: string, email: OutgoingEmail, idempotencyKey: string): { url: string; init: RequestInit } {
  return {
    url: RESEND_EMAILS_ENDPOINT,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        from: INVITATION_FROM,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
    },
  }
}

function classifyHttpFailure(status: number): DeliveryCode {
  if (status === 401 || status === 403) return 'provider_unauthorized'
  if (status === 409) return 'provider_conflict'
  if (status === 429) return 'rate_limited'
  if (status >= 400 && status < 500) return 'provider_rejected'
  return 'provider_error'
}

export async function deliverViaResend(
  fetchImpl: typeof fetch,
  apiKey: string | null | undefined,
  email: OutgoingEmail,
  idempotencyKey: string,
  timeoutMs = RESEND_TIMEOUT_MS,
): Promise<DeliveryOutcome> {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!key) return { status: 'failed', code: 'not_configured', httpStatus: null }
  if (!isDeliverableRecipient(email.to)) return { status: 'failed', code: 'invalid_recipient', httpStatus: null }

  const { url, init } = buildResendRequest(key, email, idempotencyKey)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal })
  } catch {
    return { status: 'failed', code: 'network_error', httpStatus: null }
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    // El body del proveedor no se lee ni se propaga: sólo se libera.
    await response.body?.cancel().catch(() => {})
    return { status: 'failed', code: classifyHttpFailure(response.status), httpStatus: response.status }
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  const id = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).id : null
  if (typeof id !== 'string' || id.length === 0) {
    return { status: 'failed', code: 'provider_error', httpStatus: response.status }
  }
  return { status: 'sent', httpStatus: response.status }
}
