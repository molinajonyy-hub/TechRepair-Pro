/**
 * webhook — BETA-MP · procesamiento de notificaciones de Mercado Pago.
 *
 * La firma HMAC se valida ANTES, en `mp-webhook/index.ts`. Acá:
 *
 *   1. Claim idempotente de la notificación (índice único en la base).
 *   2. Se relee el recurso en Mercado Pago: el cuerpo del webhook nunca es estado.
 *   3. El acceso lo decide `applyPreapprovalEvidence`, el mismo camino de `reconcile`.
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
import { MpApiError, ledgerPaymentStatus, preapprovalState } from './mpClient.ts'
import type { LedgerPaymentStatus } from './mpClient.ts'
import { GRACE_DAYS, applyPreapprovalEvidence, changedOnly, hasAccessOverride, isoOrNull } from './preapproval.ts'
import type { BillingContext } from './preapproval.ts'
import type { BusinessBillingPatch } from './store.ts'

const DAY_MS = 24 * 60 * 60 * 1000

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
  if (!pre) throw new MpApiError('GET preapproval', 404)

  const applied = await applyPreapprovalEvidence(ctx, pre, { source: 'webhook' })
  if (applied.kind === 'not_applied') return { businessId: applied.businessId, detail: `not_applied:${applied.reason}` }
  if (applied.planMismatch) return { businessId: applied.businessId, detail: 'applied:plan_differs_from_checkout' }
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
  if (!pre) throw new MpApiError('GET preapproval', 404)

  // El cobro no depende de que la notificación del preapproval haya llegado
  // antes: se aplica acá por el mismo camino canónico.
  const evidence = await applyPreapprovalEvidence(ctx, pre, { source: 'payment' })
  const bound = await ctx.store.findBusinessByPreapprovalId(preapprovalId)

  // El ledger registra el cobro para el negocio de la suscripción, aunque esta
  // ya haya sido reemplazada. Sin negocio resuelto no hay dónde registrarlo.
  const ledgerBusinessId = bound?.id ?? evidence.businessId
  if (!ledgerBusinessId) return { businessId: null, detail: `not_applied:${evidence.reason ?? 'unbound_preapproval'}` }

  const paymentId = invoice.payment?.id ?? invoice.payment_id ?? null
  const payment = paymentId === null ? null : await ctx.mp.getPayment(String(paymentId))
  // «Aprobado» sale sólo del pago consultado en MP. Sin pago no se infiere.
  const status: LedgerPaymentStatus = payment
    ? ledgerPaymentStatus(payment.status)
    : (typeof invoice.status === 'string' && invoice.status.toLowerCase() === 'cancelled' ? 'cancelled' : 'pending')
  const paidAt = isoOrNull(payment?.date_approved)
  const chargedAt = paidAt ?? isoOrNull(payment?.date_created) ?? isoOrNull(invoice.debit_date) ?? isoOrNull(invoice.date_created)
  const amount = Number(invoice.transaction_amount ?? payment?.transaction_amount ?? 0)

  await ctx.store.upsertPayment({
    business_id: ledgerBusinessId,
    external_payment_id: String(invoice.id),
    type: 'recurring',
    amount: Number.isFinite(amount) ? amount : 0,
    currency: invoice.currency_id || payment?.currency_id || 'ARS',
    status,
    subscription_plan: bound?.subscription_plan ?? evidence.plan,
    paid_at: paidAt,
    // Recorte deliberado: la fila es legible por los miembros del negocio y el
    // pago completo de MP trae datos del pagador (documento, tarjeta).
    raw_payload: {
      authorized_payment_id: String(invoice.id),
      preapproval_id: preapprovalId,
      payment_id: paymentId === null ? null : String(paymentId),
      invoice_status: invoice.status ?? null,
      payment_status: payment?.status ?? null,
      payment_status_detail: payment?.status_detail ?? null,
      debit_date: invoice.debit_date ?? null,
    },
  })

  // Sólo la suscripción VIGENTE del negocio mueve su estado.
  if (!bound) return { businessId: ledgerBusinessId, detail: `ledger_only:${evidence.reason ?? 'unbound_preapproval'}` }

  // Un cobro anterior al período vigente (una notificación vieja) no retrocede nada.
  if (chargedAt && bound.current_period_start && new Date(chargedAt).getTime() < new Date(bound.current_period_start).getTime()) {
    return { businessId: bound.id, detail: 'ledger_only:older_than_current_period' }
  }

  const now = ctx.now()
  const nowIso = now.toISOString()
  const patch: BusinessBillingPatch = {}
  const reference = String(paymentId ?? invoice.id)

  if (status === 'approved') {
    patch.last_payment_id = reference
    patch.last_payment_status = 'approved'
    // Un cobro aprobado activa sólo si MP sigue informando la suscripción
    // `authorized`: un cobro tardío no revive una suscripción cancelada.
    if (preapprovalState(pre.status) === 'authorized' && !hasAccessOverride(bound)) {
      patch.subscription_status = 'active'
      patch.access_source = 'mercado_pago'
      patch.grace_until = null
      if (paidAt) patch.current_period_start = paidAt
      const periodEnd = isoOrNull(pre.next_payment_date)
      if (periodEnd) patch.current_period_end = periodEnd
    }
  } else if (status === 'rejected') {
    patch.last_payment_id = reference
    patch.last_payment_status = 'rejected'
    if (bound.subscription_status === 'active' && !hasAccessOverride(bound)) {
      patch.subscription_status = 'past_due'
      // La gracia se fija al ENTRAR en mora; un segundo rechazo no la renueva.
      patch.grace_until = new Date(now.getTime() + GRACE_DAYS * DAY_MS).toISOString()
    }
  } else if (status === 'cancelled') {
    patch.last_payment_id = reference
    patch.last_payment_status = 'cancelled'
  }

  const changes = changedOnly(bound, patch)
  const statusChanged = 'subscription_status' in changes
  if (Object.keys(changes).length > 0) {
    await ctx.store.updateBusinessBilling(bound.id, { ...changes, last_webhook_at: nowIso }, nowIso)
  }
  if (statusChanged) {
    await ctx.store.recordEvent({
      business_id: bound.id, event_type: 'billing_state_applied', external_id: String(invoice.id), processed: true,
      raw_payload: {
        source: 'payment', payment_status: status,
        from: { status: bound.subscription_status, plan: bound.subscription_plan },
        to: { status: changes.subscription_status, plan: bound.subscription_plan },
      },
    })
  }
  return { businessId: bound.id, detail: null }
}
