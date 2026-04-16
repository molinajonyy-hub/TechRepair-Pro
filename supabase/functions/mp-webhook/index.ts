/**
 * mp-webhook — Mercado Pago Webhook Handler
 *
 * POST /functions/v1/mp-webhook
 *
 * ─── MP Webhook Notification format ──────────────────────────
 * {
 *   "action": "payment.created" | "updated" | ...,
 *   "api_version": "v1",
 *   "data": { "id": "<resource_id>" },
 *   "date_created": "2021-11-01T02:02:02Z",
 *   "id": 12341234,          ← notification numeric ID (also in query string ?id=)
 *   "live_mode": true,
 *   "type": "payment" | "subscription_preapproval" | "subscription_authorized_payment",
 *   "user_id": "12345"
 * }
 *
 * ─── Signature validation ──────────────────────────────────────
 * Header: x-signature: ts=<timestamp>,v1=<hmac>
 * Header: x-request-id: <uuid>
 * Manifest: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 * HMAC-SHA256(secret, manifest)
 *
 * ─── Events handled ─────────────────────────────────────────────
 * payment                       → one-time payment status
 * subscription_preapproval      → subscription lifecycle (authorized/paused/cancelled/pending)
 * subscription_authorized_payment → recurring charge processed/rejected
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MP_BASE = 'https://api.mercadopago.com'

// ─────────────────────────────────────────────────────────────────
// MP API helper
// ─────────────────────────────────────────────────────────────────
async function mpFetch(path: string): Promise<Record<string, any> | null> {
  const token = Deno.env.get('MP_ACCESS_TOKEN')
  if (!token) {
    console.error('[mp-webhook] MP_ACCESS_TOKEN not configured')
    return null
  }
  try {
    const res = await fetch(`${MP_BASE}${path}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) {
      const err = await res.text()
      console.error(`[mp-webhook] MP API ${res.status} for ${path}: ${err}`)
      return null
    }
    return await res.json()
  } catch (e) {
    console.error(`[mp-webhook] Network error fetching ${path}:`, e)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────
// HMAC-SHA256 signature validation
// MP signature format in header: ts=<unix_ts>,v1=<hex_hmac>
// Manifest template: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
// ─────────────────────────────────────────────────────────────────
async function verifySignature(
  req: Request,
  dataId: string | undefined
): Promise<boolean> {
  const secret = Deno.env.get('MP_WEBHOOK_SECRET')
  if (!secret) {
    // Sin secret configurado → rechazar siempre (nunca saltear en producción)
    console.error('[mp-webhook] MP_WEBHOOK_SECRET no configurado — rechazando request')
    return false
  }

  const signature = req.headers.get('x-signature') || ''
  const requestId = req.headers.get('x-request-id') || ''

  // Parse ts and v1 from "ts=<timestamp>,v1=<hash>"
  const parts = Object.fromEntries(
    signature.split(',').map(p => p.split('=') as [string, string])
  )
  const ts = parts['ts'] || ''
  const v1 = parts['v1'] || ''

  if (!ts || !v1) {
    console.warn('[mp-webhook] Missing ts or v1 in x-signature header')
    return false
  }

  // Manifest: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
  // NOTE: data.id is the resource ID from the notification body, NOT the notification's numeric id
  const manifest = `id:${dataId ?? ''};request-id:${requestId};ts:${ts};`

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(manifest))
  const computed = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  if (computed !== v1) {
    console.warn('[mp-webhook] Signature mismatch', { computed, received: v1, manifest })
    return false
  }
  return true
}

// ─────────────────────────────────────────────────────────────────
// Status mappers
// ─────────────────────────────────────────────────────────────────

/**
 * Map MP /v1/payments status → our payment status
 * MP values: approved | pending | in_process | rejected | cancelled | refunded | charged_back
 */
function mapPaymentStatus(mpStatus: string): string {
  const map: Record<string, string> = {
    approved:     'approved',
    pending:      'pending',
    in_process:   'in_process',
    rejected:     'rejected',
    cancelled:    'cancelled',
    refunded:     'refunded',
    charged_back: 'charged_back',
  }
  return map[mpStatus] ?? 'pending'
}

/**
 * Map MP preapproval.status → our subscription_status
 * MP preapproval statuses: authorized | paused | cancelled | pending
 */
function mapPreapprovalStatus(mpStatus: string, currentStatus: string): string {
  switch (mpStatus) {
    case 'authorized': return 'active'
    case 'paused':     return 'past_due'   // paused = payment failed, retrying
    case 'cancelled':  return 'canceled'
    case 'pending':
      // If it was active before and now pending, likely a retry cycle → past_due
      return currentStatus === 'active' ? 'past_due' : 'pending_activation'
    default:
      console.warn(`[mp-webhook] Unknown preapproval status: ${mpStatus}`)
      return currentStatus
  }
}

// ─────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────
serve(async (req) => {
  // MP sends POST only
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  let rawBody: string
  try {
    rawBody = await req.text()
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  let notification: Record<string, any>
  try {
    notification = JSON.parse(rawBody)
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  const topic      = (notification.type ?? notification.topic ?? '') as string
  const resourceId = String(notification.data?.id ?? '')  // resource ID (payment/preapproval)
  const action     = (notification.action ?? '') as string

  // ── Signature validation ──────────────────────────────────────
  // Must be done BEFORE any processing; use data.id in the manifest
  const validSig = await verifySignature(req, resourceId || undefined)
  if (!validSig) {
    console.warn('[mp-webhook] Rejected: invalid signature')
    return new Response('Forbidden', { status: 403 })
  }

  console.log(`[mp-webhook] Received type=${topic} action=${action} id=${resourceId}`)

  // ── Always respond 200 quickly (MP retries if we don't) ───────
  // Fire-and-forget the processing
  processWebhook(supabase, topic, action, resourceId, notification)
    .catch(err => console.error('[mp-webhook] Unhandled processing error:', err))

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

// ─────────────────────────────────────────────────────────────────
// Processing logic
// ─────────────────────────────────────────────────────────────────
async function processWebhook(
  supabase: ReturnType<typeof createClient>,
  topic: string,
  action: string,
  resourceId: string,
  notification: Record<string, any>
) {
  // ── 1. Idempotency check: skip if already processed ──────────
  if (resourceId && topic) {
    const { data: existing } = await supabase
      .from('subscription_events')
      .select('id, processed')
      .eq('external_id', resourceId)
      .eq('event_type', topic)
      .eq('processed', true)
      .maybeSingle()

    if (existing) {
      console.log(`[mp-webhook] Already processed ${topic}/${resourceId}, skipping`)
      return
    }
  }

  // ── 2. Log raw event ─────────────────────────────────────────
  const { data: eventLog } = await supabase
    .from('subscription_events')
    .insert({
      provider:    'mercadopago',
      event_type:  topic || 'unknown',
      external_id: resourceId || null,
      raw_payload: notification,
      processed:   false,
    })
    .select('id')
    .single()

  const eventId: string | undefined = eventLog?.id

  try {
    // ── 3. Dispatch ───────────────────────────────────────────
    if (topic === 'payment') {
      await handlePayment(supabase, resourceId, eventId)

    } else if (topic === 'subscription_preapproval') {
      await handlePreapproval(supabase, resourceId, eventId)

    } else if (topic === 'subscription_authorized_payment') {
      await handleAuthorizedPayment(supabase, resourceId, eventId)

    } else {
      console.log(`[mp-webhook] Unhandled topic "${topic}" — logged only`)
    }

    // ── 4. Mark processed ────────────────────────────────────
    if (eventId) {
      await supabase
        .from('subscription_events')
        .update({ processed: true })
        .eq('id', eventId)
    }

  } catch (err: any) {
    console.error('[mp-webhook] Processing error:', err)
    if (eventId) {
      await supabase
        .from('subscription_events')
        .update({ error_message: String(err?.message ?? err) })
        .eq('id', eventId)
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Handler: one-time payment
// Used when a customer pays a standalone charge (not subscription recurring)
// ─────────────────────────────────────────────────────────────────
async function handlePayment(
  supabase: ReturnType<typeof createClient>,
  paymentId: string,
  eventId: string | undefined
) {
  if (!paymentId) return

  // Fetch real status from MP — NEVER trust webhook body
  const mp = await mpFetch(`/v1/payments/${paymentId}`)
  if (!mp) {
    throw new Error(`Could not fetch payment ${paymentId} from MP`)
  }

  // Resolve business_id via metadata or external_reference
  const businessId: string = mp.metadata?.business_id ?? mp.external_reference ?? ''
  if (!businessId) {
    console.warn(`[mp-webhook] Payment ${paymentId} has no business_id — cannot associate`)
    return
  }

  const status = mapPaymentStatus(mp.status)

  // Upsert payment record (idempotent on provider + external_payment_id)
  await supabase
    .from('payments')
    .upsert(
      {
        business_id:         businessId,
        provider:            'mercadopago',
        external_payment_id: String(mp.id),
        type:                'one_time',
        amount:              mp.transaction_amount,
        currency:            mp.currency_id ?? 'ARS',
        status,
        paid_at:             mp.date_approved ?? null,
        raw_payload:         mp,
      },
      { onConflict: 'provider,external_payment_id' }
    )

  // Update business snapshot fields
  await supabase
    .from('businesses')
    .update({
      last_payment_id:     String(mp.id),
      last_payment_status: status,
      last_webhook_at:     new Date().toISOString(),
      updated_at:          new Date().toISOString(),
    })
    .eq('id', businessId)

  // Attach business_id to event log
  if (eventId) {
    await supabase
      .from('subscription_events')
      .update({ business_id: businessId })
      .eq('id', eventId)
  }
}

// ─────────────────────────────────────────────────────────────────
// Handler: subscription_preapproval
// Triggered when the subscription lifecycle changes
// MP preapproval statuses: authorized | paused | cancelled | pending
// ─────────────────────────────────────────────────────────────────
async function handlePreapproval(
  supabase: ReturnType<typeof createClient>,
  preapprovalId: string,
  eventId: string | undefined
) {
  if (!preapprovalId) return

  // Fetch current preapproval state from MP
  const mp = await mpFetch(`/preapproval/${preapprovalId}`)
  if (!mp) {
    throw new Error(`Could not fetch preapproval ${preapprovalId} from MP`)
  }

  // ── Find the associated business ─────────────────────────────
  // Strategy 1: lookup by mp_preapproval_id (set when we created the preapproval)
  let biz: { id: string; subscription_status: string } | null = null

  const { data: bizByPreapproval } = await supabase
    .from('businesses')
    .select('id, subscription_status')
    .eq('mp_preapproval_id', preapprovalId)
    .maybeSingle()

  if (bizByPreapproval) {
    biz = bizByPreapproval
  } else {
    // Strategy 2: lookup by external_reference (business_id we set at creation)
    const extRef = mp.external_reference
    if (extRef) {
      const { data: bizByExtRef } = await supabase
        .from('businesses')
        .select('id, subscription_status')
        .eq('id', extRef)
        .maybeSingle()

      if (bizByExtRef) {
        biz = bizByExtRef
        // Store the preapproval_id for future lookups
        await supabase
          .from('businesses')
          .update({ mp_preapproval_id: preapprovalId })
          .eq('id', extRef)
      }
    }
  }

  if (!biz) {
    throw new Error(`No business found for preapproval ${preapprovalId} (external_reference=${mp.external_reference})`)
  }

  const newStatus = mapPreapprovalStatus(mp.status, biz.subscription_status)

  // Grace period: 3 days when going to past_due
  const now = new Date()
  const graceUntil = newStatus === 'past_due'
    ? new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
    : undefined

  await supabase
    .from('businesses')
    .update({
      subscription_status:  newStatus,
      mp_preapproval_id:    preapprovalId,
      mp_payer_email:       mp.payer_email ?? null,
      last_webhook_at:      now.toISOString(),
      updated_at:           now.toISOString(),
      ...(graceUntil         ? { grace_until: graceUntil } : {}),
      ...(newStatus === 'active' ? { grace_until: null }    : {}),
    })
    .eq('id', biz.id)

  console.log(`[mp-webhook] Preapproval ${preapprovalId}: MP=${mp.status} → DB=${newStatus} for business ${biz.id}`)

  // Attach business_id to event log
  if (eventId) {
    await supabase
      .from('subscription_events')
      .update({ business_id: biz.id })
      .eq('id', eventId)
  }
}

// ─────────────────────────────────────────────────────────────────
// Handler: subscription_authorized_payment
//
// ⚠️  IMPORTANT: authorized_payment.status is the CHARGE LIFECYCLE, not payment status
//     Values: scheduled | processed | recycling | cancelled
//
//     To get the real payment outcome (approved/rejected), we must
//     fetch /v1/payments/{authorized_payment.payment_id}
// ─────────────────────────────────────────────────────────────────
async function handleAuthorizedPayment(
  supabase: ReturnType<typeof createClient>,
  authorizedPaymentId: string,
  eventId: string | undefined
) {
  if (!authorizedPaymentId) return

  // ── Step 1: Fetch authorized payment metadata ─────────────────
  const authPayment = await mpFetch(`/authorized_payments/${authorizedPaymentId}`)
  if (!authPayment) {
    throw new Error(`Could not fetch authorized_payment ${authorizedPaymentId}`)
  }

  // ── Step 2: Find business via preapproval_id ──────────────────
  const preapprovalId = authPayment.preapproval_id
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, subscription_status, subscription_plan')
    .eq('mp_preapproval_id', preapprovalId)
    .maybeSingle()

  if (!biz) {
    throw new Error(`No business found for preapproval ${preapprovalId} (authorized_payment ${authorizedPaymentId})`)
  }

  // ── Step 3: Fetch the REAL payment to get actual status ───────
  // authorized_payment.status is lifecycle (processed/scheduled/recycling/cancelled)
  // The actual approved/rejected status lives in /v1/payments/{payment_id}
  const paymentId = authPayment.payment_id
  let paymentStatus = 'pending'
  let dateApproved: string | null = null
  let rawPaymentData: Record<string, any> = authPayment

  if (paymentId) {
    const payment = await mpFetch(`/v1/payments/${paymentId}`)
    if (payment) {
      paymentStatus = mapPaymentStatus(payment.status)
      dateApproved  = payment.date_approved ?? null
      rawPaymentData = payment
    } else {
      // Fallback: map from authorized payment lifecycle status
      // processed → approved, cancelled → cancelled, else → pending
      paymentStatus = authPayment.status === 'processed'
        ? 'approved'
        : authPayment.status === 'cancelled'
          ? 'cancelled'
          : 'pending'
    }
  } else {
    // No payment_id yet (scheduled but not charged)
    paymentStatus = 'pending'
  }

  // ── Step 4: Upsert payment ledger ────────────────────────────
  // Use authorized_payment ID as external reference (unique per charge)
  await supabase
    .from('payments')
    .upsert(
      {
        business_id:         biz.id,
        provider:            'mercadopago',
        external_payment_id: String(authorizedPaymentId),
        type:                'recurring',
        amount:              authPayment.transaction_amount ?? 0,
        currency:            authPayment.currency_id ?? 'ARS',
        status:              paymentStatus,
        subscription_plan:   biz.subscription_plan ?? null,
        paid_at:             dateApproved,
        raw_payload:         rawPaymentData,
      },
      { onConflict: 'provider,external_payment_id' }
    )

  // ── Step 5: Update business subscription state ────────────────
  const now = new Date()

  if (paymentStatus === 'approved') {
    // Re-fetch preapproval for next_payment_date
    const preapproval = await mpFetch(`/preapproval/${preapprovalId}`)
    // MP returns next_payment_date: "2024-06-01T00:00:00.000-03:00"
    const periodEnd = preapproval?.next_payment_date
      ? new Date(preapproval.next_payment_date).toISOString()
      : new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString()

    await supabase
      .from('businesses')
      .update({
        subscription_status:  'active',
        current_period_start: dateApproved ?? now.toISOString(),
        current_period_end:   periodEnd,
        grace_until:          null,
        last_payment_id:      String(paymentId ?? authorizedPaymentId),
        last_payment_status:  'approved',
        last_webhook_at:      now.toISOString(),
        updated_at:           now.toISOString(),
      })
      .eq('id', biz.id)

    console.log(`[mp-webhook] Recurring payment APPROVED for business ${biz.id}, next period ends ${periodEnd}`)

  } else if (paymentStatus === 'rejected') {
    // 3-day grace period on rejection
    const graceUntil = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()

    await supabase
      .from('businesses')
      .update({
        subscription_status:  'past_due',
        grace_until:          graceUntil,
        last_payment_id:      String(paymentId ?? authorizedPaymentId),
        last_payment_status:  'rejected',
        last_webhook_at:      now.toISOString(),
        updated_at:           now.toISOString(),
      })
      .eq('id', biz.id)

    console.log(`[mp-webhook] Recurring payment REJECTED for business ${biz.id}, grace until ${graceUntil}`)

  } else if (paymentStatus === 'cancelled') {
    // Cancelled recurring — preapproval likely cancelled too
    await supabase
      .from('businesses')
      .update({
        last_payment_status: 'cancelled',
        last_webhook_at:     now.toISOString(),
        updated_at:          now.toISOString(),
      })
      .eq('id', biz.id)
  }

  // Attach business_id to event log
  if (eventId) {
    await supabase
      .from('subscription_events')
      .update({ business_id: biz.id })
      .eq('id', eventId)
  }
}
