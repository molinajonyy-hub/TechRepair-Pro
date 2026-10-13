/**
 * webhook — BETA-MP · procesamiento de notificaciones de Mercado Pago.
 *
 * La firma HMAC se valida ANTES, en `mp-webhook/index.ts`. Acá:
 *
 *   1. Claim idempotente de la notificación (índice único en la base).
 *   2. Se relee el recurso en Mercado Pago: el cuerpo del webhook nunca es estado.
 *   3. El acceso lo decide `applyPreapprovalEvidence`, el mismo camino de `reconcile`.
 *      El negocio se resuelve por el id del preapproval, que el servidor conoce
 *      desde que lo creó (`create`): una notificación sobre un preapproval que
 *      el servidor no originó queda registrada y no activa nada.
 *
 * El webhook es una vía de entrega, no la única: si Mercado Pago no notifica,
 * `reconcile` llega al mismo resultado releyendo el mismo preapproval.
 *
 * La clave de idempotencia es la NOTIFICACIÓN, no el recurso. Un preapproval
 * emite varias notificaciones con el mismo `data.id` (`created` en `pending`,
 * `updated` en `authorized`, `updated` en `cancelled`…): deduplicar por recurso
 * descartaba todas menos la primera.
 *
 *   subscription_preapproval          → acceso del negocio (canónico)
 *   subscription_authorized_payment   → ledger `payments` + período / mora
 *   payment                           → sólo auditoría (ver `IGNORED_PAYMENT_TOPIC`)
 */
import { MpApiError } from './mpClient.ts'
import { applyPreapprovalEvidence } from './preapproval.ts'
import type { BillingContext } from './preapproval.ts'


/**
 * `payment` no es una autoridad de Billing SaaS:
 *   · su `external_reference` lo elige quien paga, así que no identifica un negocio;
 *   · los cobros de una suscripción ya llegan como `subscription_authorized_payment`,
 *     y registrar los dos duplicaba el ledger.
 * La notificación queda en `subscription_events` y no escribe nada más.
 */
export const IGNORED_PAYMENT_TOPIC = 'ignored:payment_topic_is_not_a_billing_authority'

export interface WebhookNotification {
  topic: string
  action: string
  /** `data.id`: el recurso de Mercado Pago. */
  resourceId: string
  /** `id` de la notificación. Identifica ESTA entrega y sus reintentos. */
  notificationId: string | null
  raw: Record<string, unknown>
}

export function parseNotification(body: Record<string, unknown>): WebhookNotification {
  const data = (body.data ?? null) as { id?: unknown } | null
  const id = body.id
  return {
    topic: String(body.type ?? body.topic ?? ''),
    action: String(body.action ?? ''),
    resourceId: data?.id === undefined || data?.id === null ? '' : String(data.id),
    notificationId: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
    raw: body,
  }
}

export interface WebhookResult {
  /** `duplicate`: la misma notificación ya estaba procesada. */
  result: 'processed' | 'duplicate' | 'ignored'
  detail: string | null
  businessId: string | null
}

interface HandlerNote {
  businessId: string | null
  /** `null` cuando se aplicó sin observaciones; si no, el motivo por el que no cambió nada. */
  detail: string | null
}

export async function processWebhookNotification(ctx: BillingContext, notification: WebhookNotification): Promise<WebhookResult> {
  const { topic, resourceId } = notification
  if (!topic) return { result: 'ignored', detail: 'ignored:no_topic', businessId: null }

  const claim = await ctx.store.claimEvent({
    event_type: topic,
    external_id: resourceId || null,
    notification_id: notification.notificationId,
    raw_payload: notification.raw,
    processed: false,
  })
  if (claim.duplicate && claim.processed) {
    ctx.log({ event: 'webhook_duplicate', topic, resource_id: resourceId })
    return { result: 'duplicate', detail: null, businessId: null }
  }
  // Duplicado SIN procesar: un intento anterior falló a mitad de camino. Se
  // reprocesa sobre la misma fila; todas las escrituras son idempotentes.
  const eventId = claim.id

  try {
    let note: HandlerNote
    if (topic === 'subscription_preapproval') note = await handlePreapproval(ctx, resourceId)
    else if (topic === 'subscription_authorized_payment') note = await handleAuthorizedPayment(ctx, resourceId)
    else if (topic === 'payment') note = { businessId: null, detail: IGNORED_PAYMENT_TOPIC }
    else note = { businessId: null, detail: 'ignored:unhandled_topic' }

    if (eventId) {
      await ctx.store.updateEvent(eventId, {
        business_id: note.businessId, processed: true, processed_at: ctx.now().toISOString(), error_message: note.detail,
      })
    }
    return { result: 'processed', detail: note.detail, businessId: note.businessId }
  } catch (error) {
    if (eventId) {
      // Queda SIN procesar y con el motivo: Mercado Pago reintenta (respondemos 500).
      try {
        await ctx.store.updateEvent(eventId, { error_message: describeError(error) })
      } catch {
        ctx.log({ event: 'webhook_event_update_failed', topic, resource_id: resourceId })
      }
    }
    throw error
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300)
  return 'error desconocido'
}

// ── subscription_preapproval ────────────────────────────────────────────────

async function handlePreapproval(ctx: BillingContext, preapprovalId: string): Promise<HandlerNote> {
  if (!preapprovalId) return { businessId: null, detail: 'ignored:no_resource_id' }
  const pre = await ctx.mp.getPreapproval(preapprovalId)
  // Una notificación firmada sobre un recurso que MP no devuelve: se reintenta.
  if (!pre || pre.id !== preapprovalId) throw new MpApiError('GET preapproval', 404)

  const applied = await applyPreapprovalEvidence(ctx, pre, { source: 'webhook' })
  if (applied.kind === 'not_applied') return { businessId: applied.businessId, detail: `not_applied:${applied.reason}` }
  return { businessId: applied.businessId, detail: applied.reason ? `${applied.kind}:${applied.reason}` : null }
}

// ── subscription_authorized_payment ─────────────────────────────────────────

async function handleAuthorizedPayment(ctx: BillingContext, authorizedPaymentId: string): Promise<HandlerNote> {
  if (!authorizedPaymentId) return { businessId: null, detail: 'ignored:no_resource_id' }
  const invoice = await ctx.mp.getAuthorizedPayment(authorizedPaymentId)
  if (!invoice) throw new MpApiError('GET authorized_payment', 404)

  const preapprovalId = typeof invoice.preapproval_id === 'string' ? invoice.preapproval_id : ''
  if (!preapprovalId) return { businessId: null, detail: 'not_applied:no_preapproval' }
  const pre = await ctx.mp.getPreapproval(preapprovalId)
  if (!pre || pre.id !== preapprovalId) throw new MpApiError('GET preapproval', 404)

  const applied = await applyPreapprovalEvidence(ctx, pre, { source: 'payment', authorizedPaymentId })
  if (applied.kind === 'not_applied') return { businessId: applied.businessId, detail: `not_applied:${applied.reason}` }
  return { businessId: applied.businessId, detail: applied.reason ? `${applied.kind}:${applied.reason}` : null }
}
