/**
 * mp-webhook — Mercado Pago Webhook Handler (hardened)
 *
 * POST /functions/v1/mp-webhook
 *
 * Hardening applied in the 2026-06-23 billing audit:
 *  - Signature validation is MANDATORY. If MP_WEBHOOK_SECRET is unset → 500.
 *    If the x-signature is missing/invalid → 401. (Previously it silently accepted.)
 *  - Processing is AWAITED before responding (no fire-and-forget) so the isolate
 *    cannot be torn down mid-activation.
 *  - Idempotency is atomic: we "claim" the event by inserting a row keyed by the
 *    unique index (provider, event_type, external_id). Duplicates are skipped.
 *  - Out-of-order tolerance: stale events (older than the last applied
 *    mp_last_modified) do not overwrite a newer subscription state.
 *  - The resource is ALWAYS re-fetched from the MP API; the webhook body is
 *    never trusted for status.
 *
 * MP webhook body:
 * { "action": "...", "type": "payment|subscription_preapproval|subscription_authorized_payment",
 *   "data": { "id": "<resource_id>" }, "id": <notification_id>, "live_mode": bool, ... }
 *
 * Signature: header x-signature: ts=<ts>,v1=<hmac>; x-request-id: <uuid>
 * Manifest: id:<data.id lowercased>;request-id:<x-request-id>;ts:<ts>;  (HMAC-SHA256)
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MP_BASE = 'https://api.mercadopago.com'

// ─────────────────────────────────────────────────────────────────
// MP API helper — read-only fetch; never trusts the webhook body
// ─────────────────────────────────────────────────────────────────
async function mpFetch(path: string): Promise<Record<string, any> | null> {
  const token = Deno.env.get('MP_ACCESS_TOKEN')
  if (!token) {
    console.error('[mp-webhook] MP_ACCESS_TOKEN not configured')
    return null
  }
  try {
    const res = await fetch(`${MP_BASE}${path}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      console.error(`[mp-webhook] MP API ${res.status} for ${path}`)
      return null
    }
    return await res.json()
  } catch (e) {
    console.error(`[mp-webhook] Network error fetching ${path}:`, String(e))
    return null
  }
}

// ─────────────────────────────────────────────────────────────────
// HMAC-SHA256 signature validation (timing-safe)
// Returns: 'ok' | 'missing_secret' | 'invalid'
// ─────────────────────────────────────────────────────────────────
async function verifySignature(
  req: Request,
  dataId: string | undefined,
): Promise<'ok' | 'missing_secret' | 'invalid'> {
  const secret = Deno.env.get('MP_WEBHOOK_SECRET')
  if (!secret) return 'missing_secret'

  const signature = req.headers.get('x-signature') || ''
  const requestId = req.headers.get('x-request-id') || ''
  const parts = Object.fromEntries(
    signature.split(',').map(p => {
      const idx = p.indexOf('=')
      return idx === -1 ? [p.trim(), ''] : [p.slice(0, idx).trim(), p.slice(idx + 1).trim()]
    }),
  )
  const ts = parts['ts'] || ''
  const v1 = parts['v1'] || ''
  if (!ts || !v1) return 'invalid'

  // MP template: lowercase alphanumeric resource id.
  const id = (dataId ?? '').toLowerCase()
  const manifest = `id:${id};request-id:${requestId};ts:${ts};`

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(manifest))
  const computed = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')

  // Constant-time comparison
  if (computed.length !== v1.length) return 'invalid'
  let diff = 0
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ v1.charCodeAt(i)
  return diff === 0 ? 'ok' : 'invalid'
}

// ─────────────────────────────────────────────────────────────────
// Status mappers
// ─────────────────────────────────────────────────────────────────
function mapPaymentStatus(mpStatus: string): string {
  const map: Record<string, string> = {
    approved: 'approved', pending: 'pending', in_process: 'in_process',
    rejected: 'rejected', cancelled: 'cancelled', refunded: 'refunded', charged_back: 'charged_back',
  }
  return map[mpStatus] ?? 'pending'
}

function mapPreapprovalStatus(mpStatus: string, currentStatus: string): string {
  switch (mpStatus) {
    case 'authorized': return 'active'
    case 'paused':     return 'past_due'
    case 'cancelled':  return 'canceled'
    case 'pending':    return currentStatus === 'active' ? 'past_due' : 'pending_activation'
    default:
      console.warn(`[mp-webhook] Unknown preapproval status: ${mpStatus}`)
      return currentStatus
  }
}

// ─────────────────────────────────────────────────────────────────
// Main handler — validate, claim, process (awaited), respond
// ─────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let rawBody: string
  try { rawBody = await req.text() } catch { return new Response('Bad Request', { status: 400 }) }

  let notification: Record<string, any>
  try { notification = JSON.parse(rawBody) } catch { return new Response('Invalid JSON', { status: 400 }) }

  const topic      = (notification.type ?? notification.topic ?? '') as string
  const resourceId = String(notification.data?.id ?? '')
  const action     = (notification.action ?? '') as string

  // ── Mandatory signature ──────────────────────────────────────
  const sig = await verifySignature(req, resourceId || undefined)
  if (sig === 'missing_secret') {
    console.error('[mp-webhook] MP_WEBHOOK_SECRET not configured — refusing to process')
    return new Response('Webhook secret not configured', { status: 500 })
  }
  if (sig === 'invalid') {
    console.warn(`[mp-webhook] Rejected: invalid signature (type=${topic} id=${resourceId})`)
    return new Response('Forbidden', { status: 401 })
  }

  console.log(`[mp-webhook] Received type=${topic} action=${action} id=${resourceId}`)

  try {
    await processWebhook(supabase, topic, action, resourceId, notification)
    return new Response(JSON.stringify({ received: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  } catch (err: any) {
    // Return 500 so MP retries; the event row is marked with the error for diagnosis.
    console.error('[mp-webhook] Processing error:', String(err?.message ?? err))
    return new Response(JSON.stringify({ received: false }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})

// ─────────────────────────────────────────────────────────────────
// Processing — atomic claim then dispatch
// ─────────────────────────────────────────────────────────────────
async function processWebhook(
  supabase: ReturnType<typeof createClient>,
  topic: string, action: string, resourceId: string,
  notification: Record<string, any>,
) {
  if (!topic) { console.log('[mp-webhook] No topic — ignoring'); return }

  // ── Atomic idempotent claim via the unique index ─────────────
  // (uq_subscription_events_dedupe on provider, event_type, external_id)
  let eventId: string | undefined
  const { data: inserted, error: insErr } = await supabase
    .from('subscription_events')
    .insert({ provider: 'mercadopago', event_type: topic, external_id: resourceId || null, raw_payload: notification, processed: false })
    .select('id')
    .single()

  if (insErr) {
    // 23505 = unique violation → already claimed/seen.
    const code = (insErr as any)?.code
    if (code === '23505' && resourceId) {
      const { data: existing } = await supabase
        .from('subscription_events')
        .select('id, processed')
        .eq('provider', 'mercadopago').eq('event_type', topic).eq('external_id', resourceId)
        .maybeSingle()
      if (existing?.processed) { console.log(`[mp-webhook] Duplicate ${topic}/${resourceId} already processed — skip`); return }
      eventId = existing?.id
      // fall through: re-process (all writes are idempotent upserts)
    } else {
      throw new Error(`Could not record event: ${insErr.message}`)
    }
  } else {
    eventId = inserted?.id
  }

  try {
    if (topic === 'payment') {
      await handlePayment(supabase, resourceId, eventId)
    } else if (topic === 'subscription_preapproval') {
      await handlePreapproval(supabase, resourceId, eventId)
    } else if (topic === 'subscription_authorized_payment') {
      await handleAuthorizedPayment(supabase, resourceId, eventId)
    } else {
      console.log(`[mp-webhook] Unhandled topic "${topic}" — logged only`)
    }

    if (eventId) {
      await supabase.from('subscription_events')
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq('id', eventId)
    }
  } catch (err: any) {
    if (eventId) {
      await supabase.from('subscription_events')
        .update({ error_message: String(err?.message ?? err) })
        .eq('id', eventId)
    }
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────
// Out-of-order guard: returns true if the incoming change is stale
// ─────────────────────────────────────────────────────────────────
function isStale(incomingLastModified: string | null | undefined, storedLastModified: string | null | undefined): boolean {
  if (!incomingLastModified) return false
  if (!storedLastModified) return false
  return new Date(incomingLastModified).getTime() < new Date(storedLastModified).getTime()
}

// ─────────────────────────────────────────────────────────────────
// Handler: one-time payment
// ─────────────────────────────────────────────────────────────────
async function handlePayment(supabase: ReturnType<typeof createClient>, paymentId: string, eventId?: string) {
  if (!paymentId) return
  const mp = await mpFetch(`/v1/payments/${paymentId}`)
  if (!mp) throw new Error(`Could not fetch payment ${paymentId} from MP`)

  const businessId: string = mp.metadata?.business_id ?? mp.external_reference ?? ''
  if (!businessId) { console.warn(`[mp-webhook] Payment ${paymentId} has no business_id`); return }

  const status = mapPaymentStatus(mp.status)
  await supabase.from('payments').upsert({
    business_id: businessId, provider: 'mercadopago', external_payment_id: String(mp.id),
    type: 'one_time', amount: mp.transaction_amount, currency: mp.currency_id ?? 'ARS',
    status, paid_at: mp.date_approved ?? null, raw_payload: mp,
  }, { onConflict: 'provider,external_payment_id' })

  await supabase.from('businesses').update({
    last_payment_id: String(mp.id), last_payment_status: status,
    last_webhook_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', businessId)

  if (eventId) await supabase.from('subscription_events').update({ business_id: businessId }).eq('id', eventId)
}

// ─────────────────────────────────────────────────────────────────
// Handler: subscription_preapproval (subscription lifecycle)
// ─────────────────────────────────────────────────────────────────
async function handlePreapproval(supabase: ReturnType<typeof createClient>, preapprovalId: string, eventId?: string) {
  if (!preapprovalId) return
  const mp = await mpFetch(`/preapproval/${preapprovalId}`)
  if (!mp) throw new Error(`Could not fetch preapproval ${preapprovalId} from MP`)

  // Resolve business: by stored preapproval id, else by external_reference (business_id).
  let biz: { id: string; subscription_status: string; mp_last_modified: string | null } | null = null
  const { data: byPre } = await supabase.from('businesses')
    .select('id, subscription_status, mp_last_modified').eq('mp_preapproval_id', preapprovalId).maybeSingle()
  if (byPre) {
    biz = byPre as any
  } else if (mp.external_reference) {
    const { data: byRef } = await supabase.from('businesses')
      .select('id, subscription_status, mp_last_modified').eq('id', mp.external_reference).maybeSingle()
    if (byRef) biz = byRef as any
  }
  if (!biz) throw new Error(`No business for preapproval ${preapprovalId} (ext_ref=${mp.external_reference})`)

  if (isStale(mp.last_modified, biz.mp_last_modified)) {
    console.log(`[mp-webhook] Stale preapproval event for business ${biz.id} — recording only`)
    if (eventId) await supabase.from('subscription_events').update({ business_id: biz.id }).eq('id', eventId)
    return
  }

  const newStatus = mapPreapprovalStatus(mp.status, biz.subscription_status)
  const now = new Date()
  const graceUntil = newStatus === 'past_due'
    ? new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString() : undefined

  await supabase.from('businesses').update({
    subscription_status: newStatus,
    subscription_provider: 'mercadopago',
    access_source: newStatus === 'active' ? 'mercado_pago' : undefined,
    mp_preapproval_id: preapprovalId,
    mp_payer_email: mp.payer_email ?? null,
    mp_last_modified: mp.last_modified ?? now.toISOString(),
    last_webhook_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...(graceUntil ? { grace_until: graceUntil } : {}),
    ...(newStatus === 'active' ? { grace_until: null } : {}),
  }).eq('id', biz.id)

  // Make the pending screen deterministic.
  await markCheckoutSession(supabase, biz.id, newStatus === 'active' ? 'paid'
    : newStatus === 'canceled' ? 'canceled' : null)

  console.log(`[mp-webhook] Preapproval ${preapprovalId}: MP=${mp.status} → DB=${newStatus} biz=${biz.id}`)
  if (eventId) await supabase.from('subscription_events').update({ business_id: biz.id }).eq('id', eventId)
}

// ─────────────────────────────────────────────────────────────────
// Handler: subscription_authorized_payment (recurring charge)
// ─────────────────────────────────────────────────────────────────
async function handleAuthorizedPayment(supabase: ReturnType<typeof createClient>, authorizedPaymentId: string, eventId?: string) {
  if (!authorizedPaymentId) return
  const authPayment = await mpFetch(`/authorized_payments/${authorizedPaymentId}`)
  if (!authPayment) throw new Error(`Could not fetch authorized_payment ${authorizedPaymentId}`)

  const preapprovalId = authPayment.preapproval_id
  const { data: biz } = await supabase.from('businesses')
    .select('id, subscription_status, subscription_plan, mp_last_modified')
    .eq('mp_preapproval_id', preapprovalId).maybeSingle()
  if (!biz) throw new Error(`No business for preapproval ${preapprovalId} (auth_payment ${authorizedPaymentId})`)

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
      paymentStatus = authPayment.status === 'processed' ? 'approved'
        : authPayment.status === 'cancelled' ? 'cancelled' : 'pending'
    }
  }

  await supabase.from('payments').upsert({
    business_id: biz.id, provider: 'mercadopago', external_payment_id: String(authorizedPaymentId),
    type: 'recurring', amount: authPayment.transaction_amount ?? 0, currency: authPayment.currency_id ?? 'ARS',
    status: paymentStatus, subscription_plan: biz.subscription_plan ?? null, paid_at: dateApproved, raw_payload: rawPaymentData,
  }, { onConflict: 'provider,external_payment_id' })

  const now = new Date()
  if (paymentStatus === 'approved') {
    const preapproval = await mpFetch(`/preapproval/${preapprovalId}`)
    const periodEnd = preapproval?.next_payment_date
      ? new Date(preapproval.next_payment_date).toISOString()
      : new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString()
    await supabase.from('businesses').update({
      subscription_status: 'active', access_source: 'mercado_pago',
      current_period_start: dateApproved ?? now.toISOString(), current_period_end: periodEnd,
      grace_until: null, last_payment_id: String(paymentId ?? authorizedPaymentId),
      last_payment_status: 'approved', last_webhook_at: now.toISOString(), updated_at: now.toISOString(),
    }).eq('id', biz.id)
  } else if (paymentStatus === 'rejected') {
    const graceUntil = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
    await supabase.from('businesses').update({
      subscription_status: 'past_due', grace_until: graceUntil,
      last_payment_id: String(paymentId ?? authorizedPaymentId), last_payment_status: 'rejected',
      last_webhook_at: now.toISOString(), updated_at: now.toISOString(),
    }).eq('id', biz.id)
  } else if (paymentStatus === 'cancelled') {
    await supabase.from('businesses').update({
      last_payment_status: 'cancelled', last_webhook_at: now.toISOString(), updated_at: now.toISOString(),
    }).eq('id', biz.id)
  }

  if (eventId) await supabase.from('subscription_events').update({ business_id: biz.id }).eq('id', eventId)
}

// Best-effort: mark the latest pending checkout session for the pending screen.
async function markCheckoutSession(
  supabase: ReturnType<typeof createClient>, businessId: string, status: string | null,
) {
  if (!status) return
  try {
    const { data: latest } = await supabase.from('subscription_checkout_sessions')
      .select('id').eq('business_id', businessId).eq('status', 'pending')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (latest?.id) {
      await supabase.from('subscription_checkout_sessions')
        .update({ status, updated_at: new Date().toISOString() }).eq('id', latest.id)
    }
  } catch (e) {
    console.warn('[mp-webhook] markCheckoutSession failed:', String(e))
  }
}
