/**
 * mp-webhook — Billing SaaS · notificaciones de Mercado Pago (BETA-MP)
 *
 * POST /functions/v1/mp-webhook
 *
 * Este archivo es el BORDE: valida la firma y cablea dependencias. Las reglas
 * viven en `_shared/billing/` y se prueban sin red:
 *
 *   webhook.ts       claim idempotente por notificación + despacho por tipo
 *   preapproval.ts   el camino canónico, compartido con `mp-subscription:reconcile`
 *
 * Garantías que se conservan de la auditoría del 2026-06-23:
 *  - La firma es OBLIGATORIA. Sin MP_WEBHOOK_SECRET → 500. Firma ausente o
 *    inválida → 401.
 *  - El procesamiento se AWAIT-ea antes de responder (sin fire-and-forget): el
 *    isolate no puede morir a mitad de una activación.
 *  - Idempotencia atómica: la notificación se reclama con un índice único.
 *  - Tolerancia a eventos fuera de orden (`mp_last_modified`).
 *  - El recurso SIEMPRE se relee en la API de Mercado Pago: el cuerpo del webhook
 *    nunca es fuente de estado.
 *  - verify_jwt=false (Mercado Pago no manda un JWT de Supabase) y service_role.
 *
 * Cuerpo de la notificación:
 * { "id": <notification_id>, "type": "subscription_preapproval|subscription_authorized_payment|payment",
 *   "action": "...", "data": { "id": "<resource_id>" }, "live_mode": bool, ... }
 *
 * Firma: header x-signature: ts=<ts>,v1=<hmac>; x-request-id: <uuid>
 * Manifiesto: id:<data.id en minúsculas>;request-id:<x-request-id>;ts:<ts>;  (HMAC-SHA256)
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { createMpClient } from '../_shared/billing/mpClient.ts'
import type { BillingContext } from '../_shared/billing/preapproval.ts'
import { createSupabaseBillingStore } from '../_shared/billing/store.ts'
import { parseNotification, processWebhookNotification } from '../_shared/billing/webhook.ts'
import { normalizeSignedId, validateMpSignature } from '../_shared/billing/mpSignature.ts'

// ─────────────────────────────────────────────────────────────────
// HMAC-SHA256 signature validation (timing-safe)
// Returns: 'ok' | 'missing_secret' | 'invalid'
// ─────────────────────────────────────────────────────────────────
async function verifySignature(
  req: Request,
  dataId: string | undefined,
): Promise<'ok' | 'missing_secret' | 'invalid'> {
  return validateMpSignature(req, dataId, Deno.env.get('MP_WEBHOOK_SECRET'))
}

/**
 * Qué partes de la firma trajo el request. Sólo presencia, nunca valores: alcanza
 * para distinguir un request sin firma de una firma calculada sobre otro manifiesto.
 */
function signatureParts(req: Request, urlDataId: string | null): string {
  const has = (name: string) => (req.headers.get(name) ? 'yes' : 'no')
  return `x-signature=${has('x-signature')} x-request-id=${has('x-request-id')} url-data-id=${urlDataId === null ? 'no' : 'yes'}`
}

// ─────────────────────────────────────────────────────────────────
// Main handler — validate, claim, process (awaited), respond
// ─────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method !== 'POST') {
    console.warn(`[mp-webhook] Rejected: method ${req.method}`)
    return new Response('Method Not Allowed', { status: 405 })
  }

  // Todo rechazo previo a reclamar el evento deja una línea en el log: sin ella
  // no se distingue «Mercado Pago no notificó» de «notificó y lo rechazamos».
  const badBody = (why: string) => {
    console.warn(`[mp-webhook] Rejected: ${why}`)
    return new Response(why === 'unreadable body' ? 'Bad Request' : 'Invalid JSON', { status: 400 })
  }

  let rawBody: string
  try { rawBody = await req.text() } catch { return badBody('unreadable body') }

  let payload: unknown
  try { payload = JSON.parse(rawBody) } catch { return badBody('body is not JSON') }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return badBody('body is not a JSON object')
  }

  const notification = parseNotification(payload as Record<string, unknown>)
  const { topic, action, resourceId } = notification

  // ── Mandatory signature ──────────────────────────────────────
  // Mercado Pago firma el `data.id` de la URL de la notificación. Si viene, tiene
  // que ser el mismo recurso que el cuerpo: lo firmado y lo procesado no pueden
  // diferir.
  const query = new URL(req.url).searchParams
  const urlDataId = query.get('data.id')
  if (query.getAll('data.id').length > 1 || query.getAll('type').length > 1) {
    console.warn('[mp-webhook] Rejected: ambiguous URL parameters')
    return new Response('Forbidden', { status: 401 })
  }
  if (urlDataId !== null && resourceId && normalizeSignedId(urlDataId) !== normalizeSignedId(resourceId)) {
    console.warn(`[mp-webhook] Rejected: signed id differs from body id (type=${topic})`)
    return new Response('Forbidden', { status: 401 })
  }
  const sig = await verifySignature(req, urlDataId ?? undefined)
  if (sig === 'missing_secret') {
    console.error('[mp-webhook] MP_WEBHOOK_SECRET not configured — refusing to process')
    return new Response('Webhook secret not configured', { status: 500 })
  }
  if (sig === 'invalid') {
    console.warn(`[mp-webhook] Rejected: invalid signature (type=${topic} id=${resourceId} ${signatureParts(req, urlDataId)})`)
    return new Response('Forbidden', { status: 401 })
  }
  // MP can sign manifests with omitted fields. A billing resource MUST itself
  // be signed: an unsigned body id is never substituted into that manifest.
  if (!urlDataId || (query.get('type') !== null && query.get('type') !== topic)) {
    console.warn('[mp-webhook] Rejected: missing signed resource or topic mismatch')
    return new Response('Forbidden', { status: 401 })
  }
  notification.resourceId = normalizeSignedId(urlDataId)

  console.log(`[mp-webhook] Received type=${topic} action=${action} id=${resourceId}`)

  // <any> Database generic: this function predates generated DB types. Type-only.
  const supabase = createClient<any>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  )

  const ctx: BillingContext = {
    store: createSupabaseBillingStore(supabase),
    mp: createMpClient({
      fetchImpl: (input, init) => fetch(input, init),
      accessToken: () => Deno.env.get('MP_ACCESS_TOKEN'),
    }),
    now: () => new Date(),
    // Sólo ids, estados y códigos. Nunca emails, tokens ni cuerpos de Mercado Pago.
    log: (event) => console.log(JSON.stringify({ fn: 'mp-webhook', ...event })),
  }

  try {
    const outcome = await processWebhookNotification(ctx, notification)
    return new Response(JSON.stringify({ received: true, result: outcome.result }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    // Return 500 so MP retries; the event row is marked with the error for diagnosis.
    console.error('[mp-webhook] Processing error:', err instanceof Error ? err.message : 'unknown')
    return new Response(JSON.stringify({ received: false }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})
