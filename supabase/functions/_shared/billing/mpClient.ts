/**
 * mpClient — BETA-MP · cliente de la API de Mercado Pago para Billing SaaS.
 *
 * Todo lo que el backend sabe de una suscripción lo lee de acá. El cuerpo de un
 * webhook y lo que manda el navegador nunca son fuente de estado.
 *
 * Endpoints usados (todos documentados por Mercado Pago):
 *   POST /preapproval                   crear la suscripción en `pending` («sin plan
 *                                       asociado, con pago pendiente»): devuelve el `id`
 *                                       y el `init_point` ANTES de que alguien pague
 *   GET  /preapproval/{id}              suscripción
 *   PUT  /preapproval/{id}              cancelar
 *   GET  /authorized_payments/{id}      cobro recurrente
 *   GET  /v1/payments/{id}              pago
 *
 * No se usa ningún endpoint de búsqueda: una suscripción se lee SIEMPRE por un
 * id que el servidor ya conoce. Buscar por plan, email o fecha sería adivinar.
 *
 * `fetch` y el token se inyectan: el módulo no toca `Deno.env` ni la red por su
 * cuenta, así que corre igual en Deno y en los tests.
 */

const MP_BASE = 'https://api.mercadopago.com'
const REQUEST_TIMEOUT_MS = 10_000

export interface MpAutoRecurring {
  frequency?: number | string | null
  frequency_type?: string | null
  transaction_amount?: number | string | null
  currency_id?: string | null
}

export interface MpPreapproval {
  id: string
  status?: string | null
  preapproval_plan_id?: string | null
  external_reference?: string | number | null
  payer_email?: string | null
  last_modified?: string | null
  date_created?: string | null
  next_payment_date?: string | null
  init_point?: string | null
  auto_recurring?: MpAutoRecurring | null
}

/** Lo que el servidor le pide a Mercado Pago al abrir un checkout. Nada de esto sale del navegador. */
export interface NewPendingPreapproval {
  reason: string
  externalReference: string
  payerEmail: string
  backUrl: string
  frequency: number
  frequencyType: string
  amount: number
  currency: string
}

export interface MpAuthorizedPayment {
  id: string | number
  preapproval_id?: string | null
  status?: string | null
  transaction_amount?: number | string | null
  currency_id?: string | null
  date_created?: string | null
  debit_date?: string | null
  /** La referencia de MP anida el pago; `payment_id` suelto se acepta por compatibilidad. */
  payment?: { id?: string | number | null; status?: string | null } | null
  payment_id?: string | number | null
}

export interface MpPayment {
  id: string | number
  status?: string | null
  status_detail?: string | null
  transaction_amount?: number | string | null
  currency_id?: string | null
  date_approved?: string | null
  date_created?: string | null
}

export interface MpClient {
  /**
   * Crea un preapproval `pending`. Devuelve lo que respondió Mercado Pago, sin
   * validar: quien llama decide si esa respuesta sirve para abrir un checkout.
   */
  createPendingPreapproval(input: NewPendingPreapproval): Promise<MpPreapproval>
  /** `null` si Mercado Pago responde 404. Cualquier otra falla lanza `MpApiError`. */
  getPreapproval(id: string): Promise<MpPreapproval | null>
  cancelPreapproval(id: string): Promise<void>
  getAuthorizedPayment(id: string): Promise<MpAuthorizedPayment | null>
  getPayment(id: string): Promise<MpPayment | null>
}

/**
 * Falla al hablar con Mercado Pago. El mensaje nunca incluye el token ni el
 * cuerpo de MP. `detail` es el motivo que dio MP, recortado y sin emails: sólo
 * va al log del servidor, para poder leer un 400 en el smoke.
 */
export class MpApiError extends Error {
  readonly status: number
  readonly operation: string
  readonly detail: string | null
  constructor(operation: string, status: number, detail: string | null = null) {
    super(`Mercado Pago ${operation} respondió ${status}`)
    this.name = 'MpApiError'
    this.operation = operation
    this.status = status
    this.detail = detail
  }
}

const EMAIL_RE = /[^\s@"'<>]+@[^\s@"'<>]+/g

/** `message` / `error` de una respuesta de error de MP: sin emails, a lo sumo 200 caracteres. */
async function errorDetail(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown } | null
    const parts = [body?.error, body?.message].filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    if (parts.length === 0) return null
    return parts.join(': ').replace(EMAIL_RE, '[email]').slice(0, 200)
  } catch {
    return null
  }
}

export interface MpClientDeps {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>
  accessToken: () => string | undefined
}

export function createMpClient(deps: MpClientDeps): MpClient {
  async function call(operation: string, path: string, init: RequestInit = {}): Promise<Response> {
    const token = deps.accessToken()
    // 0 = no llegamos a Mercado Pago (sin token, red caída, timeout).
    if (!token) throw new MpApiError(`${operation} (MP_ACCESS_TOKEN sin configurar)`, 0)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await deps.fetchImpl(`${MP_BASE}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init.headers as Record<string, string> | undefined ?? {}),
        },
      })
    } catch {
      throw new MpApiError(operation, 0)
    } finally {
      clearTimeout(timer)
    }
  }

  async function getJson<T>(operation: string, path: string): Promise<T | null> {
    const res = await call(operation, path)
    if (res.status === 404) return null
    if (!res.ok) throw new MpApiError(operation, res.status)
    try {
      return (await res.json()) as T
    } catch {
      throw new MpApiError(`${operation} (respuesta no JSON)`, res.status)
    }
  }

  const seg = (value: string) => encodeURIComponent(value)

  return {
    async createPendingPreapproval(input) {
      const operation = 'POST preapproval'
      const res = await call(operation, '/preapproval', {
        method: 'POST',
        body: JSON.stringify({
          reason: input.reason,
          external_reference: input.externalReference,
          payer_email: input.payerEmail,
          auto_recurring: {
            frequency: input.frequency,
            frequency_type: input.frequencyType,
            transaction_amount: input.amount,
            currency_id: input.currency,
          },
          back_url: input.backUrl,
          // Sin medio de pago: lo carga quien paga, en el checkout de Mercado Pago.
          status: 'pending',
        }),
        // La referencia es única por sesión: un reintento de red del mismo
        // checkout no crea una segunda suscripción.
        headers: { 'X-Idempotency-Key': `create-${input.externalReference}` },
      })
      if (!res.ok) throw new MpApiError(operation, res.status, await errorDetail(res))
      try {
        return (await res.json()) as MpPreapproval
      } catch {
        throw new MpApiError(`${operation} (respuesta no JSON)`, res.status)
      }
    },

    getPreapproval: (id) => getJson<MpPreapproval>('GET preapproval', `/preapproval/${seg(id)}`),

    async cancelPreapproval(id) {
      const res = await call('PUT preapproval (cancel)', `/preapproval/${seg(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'cancelled' }),
        // Clave estable: un reintento de red no dispara una segunda operación.
        headers: { 'X-Idempotency-Key': `cancel-${id}` },
      })
      if (!res.ok) throw new MpApiError('PUT preapproval (cancel)', res.status)
    },

    getAuthorizedPayment: (id) => getJson<MpAuthorizedPayment>('GET authorized_payment', `/authorized_payments/${seg(id)}`),
    getPayment: (id) => getJson<MpPayment>('GET payment', `/v1/payments/${seg(id)}`),
  }
}

// ── Normalización de estados ────────────────────────────────────────────────

export type PreapprovalState = 'authorized' | 'pending' | 'paused' | 'cancelled' | 'unknown'

/**
 * Estado de un preapproval. Mercado Pago documenta `cancelled` en las respuestas
 * y `canceled` en la guía de gestión: se aceptan las dos grafías. Un valor
 * desconocido es `unknown` y no produce ningún cambio de acceso.
 */
export function preapprovalState(raw: unknown): PreapprovalState {
  switch (typeof raw === 'string' ? raw.trim().toLowerCase() : '') {
    case 'authorized': return 'authorized'
    case 'pending':    return 'pending'
    case 'paused':     return 'paused'
    case 'cancelled':
    case 'canceled':   return 'cancelled'
    default:           return 'unknown'
  }
}

export type LedgerPaymentStatus =
  | 'approved' | 'pending' | 'in_process' | 'rejected' | 'cancelled' | 'refunded' | 'charged_back'

const LEDGER_STATUSES: readonly LedgerPaymentStatus[] =
  ['approved', 'pending', 'in_process', 'rejected', 'cancelled', 'refunded', 'charged_back']

/** Estado de un pago para el ledger `payments` (acotado por su CHECK). */
export function ledgerPaymentStatus(raw: unknown): LedgerPaymentStatus {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (LEDGER_STATUSES as readonly string[]).includes(value) ? (value as LedgerPaymentStatus) : 'pending'
}

/**
 * El `init_point` de UN preapproval, o `null` si no sirve: tiene que ser una URL
 * https de Mercado Pago y, si nombra un preapproval, tiene que ser ese.
 */
export function preapprovalCheckoutUrl(pre: MpPreapproval): string | null {
  if (!isMercadoPagoUrl(pre.init_point)) return null
  const named = new URL(pre.init_point).searchParams.get('preapproval_id')
  return named === null || named === pre.id ? pre.init_point : null
}

/** `true` sólo para URLs https de un dominio de Mercado Pago. */
export function isMercadoPagoUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && /(^|\.)mercadopago\.(com|com\.ar)$/.test(url.hostname)
  } catch {
    return false
  }
}
