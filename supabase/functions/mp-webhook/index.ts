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
import { buildPlanCatalog } from '../_shared/billing/planCatalog.ts'
import type { BillingContext } from '../_shared/billing/preapproval.ts'
import { createSupabaseBillingStore } from '../_shared/billing/store.ts'
import { parseNotification, processWebhookNotification } from '../_shared/billing/webhook.ts'

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
// Main handler — validate, claim, process (awaited), respond
// ─────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let rawBody: string
  try { rawBody = await req.text() } catch { return new Response('Bad Request', { status: 400 }) }

  let payload: unknown
  try { payload = JSON.parse(rawBody) } catch { return new Response('Invalid JSON', { status: 400 }) }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return new Response('Invalid JSON', { status: 400 })
  }

  const notification = parseNotification(payload as Record<string, unknown>)
  const { topic, action, resourceId } = notification

  // ── Mandatory signature ──────────────────────────────────────
  // Mercado Pago firma el `data.id` de la URL de la notificación. Si viene, tiene
  // que ser el mismo recurso que el cuerpo: lo firmado y lo procesado no pueden
  // diferir.
  const urlDataId = new URL(req.url).searchParams.get('data.id')
  if (urlDataId !== null && resourceId && urlDataId.toLowerCase() !== resourceId.toLowerCase()) {
    console.warn(`[mp-webhook] Rejected: signed id differs from body id (type=${topic})`)
    return new Response('Forbidden', { status: 401 })
  }
  const sig = await verifySignature(req, urlDataId ?? (resourceId || undefined))
  if (sig === 'missing_secret') {
    console.error('[mp-webhook] MP_WEBHOOK_SECRET not configured — refusing to process')
    return new Response('Webhook secret not configured', { status: 500 })
  }
  if (sig === 'invalid') {
    console.warn(`[mp-webhook] Rejected: invalid signature (type=${topic} id=${resourceId})`)
    return new Response('Forbidden', { status: 401 })
  }

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
    catalog: buildPlanCatalog((key) => Deno.env.get(key)),
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
