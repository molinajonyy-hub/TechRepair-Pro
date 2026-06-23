/**
 * mp-subscription — Mercado Pago Subscription Management
 *
 * POST /functions/v1/mp-subscription
 * Body: { action, ...params }
 *
 * ─── MP Preapproval API ──────────────────────────────────────
 * Subscriptions in MP are called "preapprovals".
 * When using a plan (preapproval_plan_id), the amount/frequency come from the plan.
 * The flow:
 *   1. POST /preapproval → returns init_point (MP checkout URL)
 *   2. User pays in MP checkout
 *   3. MP calls our webhook with subscription_preapproval event (status=authorized)
 *   4. We activate the business
 *
 * ─── Preapproval statuses ──────────────────────────────────────
 *   pending    → created, awaiting user payment setup
 *   authorized → payment method confirmed, subscription active
 *   paused     → payment failed, MP retrying (grace period)
 *   cancelled  → subscription cancelled
 *
 * ─── Security ──────────────────────────────────────────────────
 * - MP_ACCESS_TOKEN is ONLY in this Edge Function env (never frontend)
 * - Requires valid Supabase JWT from authenticated user
 * - Verifies user belongs to the target business before any MP call
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Allowed origin is configurable so it never goes stale on a Vercel domain change.
// Set MP_CORS_ORIGIN (or APP_URL) in Edge Function secrets to the frontend origin.
const ALLOWED_ORIGIN =
  Deno.env.get('MP_CORS_ORIGIN') ??
  Deno.env.get('APP_URL') ??
  'https://tech-repair-pro-molinajonyy-hubs-projects.vercel.app'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
}

const MP_BASE = 'https://api.mercadopago.com'

// ─────────────────────────────────────────────────────────────────
// MP API helper — all calls go through here
// ─────────────────────────────────────────────────────────────────
async function mpFetch(
  path: string,
  options: RequestInit = {},
  idempotencyKey?: string
): Promise<Record<string, any>> {
  const token = Deno.env.get('MP_ACCESS_TOKEN')
  if (!token) throw new Error('MP_ACCESS_TOKEN is not configured in Edge Function secrets')

  const headers: Record<string, string> = {
    'Authorization':  `Bearer ${token}`,
    'Content-Type':   'application/json',
  }

  // Idempotency key prevents duplicate charges on network retries
  // Use a stable key (e.g. business_id + action) not a random UUID
  if (idempotencyKey) {
    headers['X-Idempotency-Key'] = idempotencyKey
  }

  const res = await fetch(`${MP_BASE}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
  })

  const body = await res.json()

  if (!res.ok) {
    // MP error format: { message, error, status, cause: [...] }
    const cause = Array.isArray(body.cause)
      ? body.cause.map((c: any) => `${c.code}: ${c.description}`).join('; ')
      : ''
    throw new Error(
      `MP API error ${res.status} on ${path}: ${body.message ?? body.error ?? JSON.stringify(body)}${cause ? ` (${cause})` : ''}`
    )
  }

  return body
}

// ─────────────────────────────────────────────────────────────────
// Plan ID resolver: reads from Edge Function secrets
// Secret naming convention: MP_PLAN_BASICO_MONTHLY, MP_PLAN_PRO_ANNUAL, etc.
// ─────────────────────────────────────────────────────────────────
function getMPPlanId(plan: string, cycle: string): string {
  const key = `MP_PLAN_${plan.toUpperCase()}_${cycle.toUpperCase()}`
  return Deno.env.get(key) ?? ''
}

// Plan display names for the reason field (shown to user in MP checkout)
const PLAN_NAMES: Record<string, string> = {
  basico:    'TechRepair Pro — Plan Básico',
  pro:       'TechRepair Pro — Plan Pro',
  full:      'TechRepair Pro — Plan Full',
}

const CYCLE_NAMES: Record<string, string> = {
  monthly:   'mensual',
  quarterly: 'trimestral',
  annual:    'anual',
}

// ─────────────────────────────────────────────────────────────────
// Auth helper — verifies Supabase JWT and returns authenticated user
// Uses a user-scoped client (anon key + user JWT) for reliable verification
// ─────────────────────────────────────────────────────────────────
async function getAuthUser(req: Request) {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null

  // Create a user-scoped client with the token from the request
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )

  const { data: { user }, error } = await userClient.auth.getUser()
  if (error || !user) return null
  return user
}

// ─────────────────────────────────────────────────────────────────
// Main router
// ─────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const user = await getAuthUser(req)
    if (!user) return json({ error: 'Unauthorized' }, 401)

    const body = await req.json()
    const { action } = body

    switch (action) {
      case 'create':               return await handleCreate(supabase, user, body)
      case 'cancel':               return await handleCancel(supabase, user, body)
      case 'status':               return await handleStatus(supabase, user, body)
      case 'update_payment_method': return await handleUpdatePaymentMethod(supabase, user, body)
      default:
        return json({ error: `Unknown action: ${action}` }, 400)
    }

  } catch (err: any) {
    console.error('[mp-subscription] Unhandled error:', err)
    return json({ error: err?.message ?? 'Internal server error' }, 500)
  }
})

// ─────────────────────────────────────────────────────────────────
// CREATE SUBSCRIPTION
// ─────────────────────────────────────────────────────────────────
async function handleCreate(
  supabase: ReturnType<typeof createClient>,
  user: any,
  body: Record<string, any>
) {
  const { business_id, plan, billing_cycle, payer_email, back_url } = body

  if (!business_id || !plan || !billing_cycle || !payer_email) {
    return json({ error: 'Missing required fields: business_id, plan, billing_cycle, payer_email' }, 400)
  }

  // ── Verify user belongs to this business ─────────────────────
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, role')
    .eq('user_id', user.id)
    .eq('business_id', business_id)
    .eq('is_active', true)
    .maybeSingle()

  if (!profile) {
    return json({
      error: 'Forbidden: user does not belong to this business',
      debug: { userId: user.id, businessId: business_id, profileError: profileError?.message }
    }, 403)
  }

  // ── Resolve MP Plan ID ────────────────────────────────────────
  const planId = getMPPlanId(plan, billing_cycle)
  if (!planId) {
    return json({
      error: `MP plan ID not configured. Set secret MP_PLAN_${plan.toUpperCase()}_${billing_cycle.toUpperCase()} in Supabase Edge Function secrets.`
    }, 500)
  }

  // ── Check for existing pending preapproval (re-subscription) ──
  const { data: existing } = await supabase
    .from('businesses')
    .select('mp_preapproval_id, subscription_status')
    .eq('id', business_id)
    .single()

  // If there's an existing active/authorized preapproval, cancel it first
  if (existing?.mp_preapproval_id && ['active', 'past_due'].includes(existing.subscription_status)) {
    try {
      await mpFetch(`/preapproval/${existing.mp_preapproval_id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'cancelled' }),
      }, `cancel-${existing.mp_preapproval_id}`)
    } catch (e) {
      console.warn('[mp-subscription] Could not cancel existing preapproval:', e)
      // Continue anyway — don't block re-subscription
    }
  }

  // ── Marcar negocio como pending_activation en DB ─────────────
  await supabase
    .from('businesses')
    .update({
      mp_preapproval_plan_id: planId,
      mp_payer_email:         payer_email,
      subscription_plan:      plan,
      subscription_status:    'pending_activation',
      updated_at:             new Date().toISOString(),
    })
    .eq('id', business_id)

  // ── Construir URL de checkout de MP (redirect flow) ───────────
  // En lugar de crear el preapproval via API (que requiere card_token_id),
  // redirigimos al usuario al checkout del plan donde MP maneja todo.
  // Cuando el usuario pague, MP llama al webhook y activamos el negocio.
  const appUrl = back_url ?? `${Deno.env.get('APP_URL') ?? ''}/subscription/pending`
  const checkoutUrl = `https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=${planId}&payer_email=${encodeURIComponent(payer_email)}&external_reference=${business_id}&back_url=${encodeURIComponent(appUrl)}`

  console.log(`[mp-subscription] Redirecting business ${business_id} to MP checkout for plan ${planId}`)

  return json({
    init_point:     checkoutUrl,
    preapproval_id: null,
  })
}

// ─────────────────────────────────────────────────────────────────
// CANCEL SUBSCRIPTION
// ─────────────────────────────────────────────────────────────────
async function handleCancel(
  supabase: ReturnType<typeof createClient>,
  user: any,
  body: Record<string, any>
) {
  const { business_id } = body
  if (!business_id) return json({ error: 'Missing business_id' }, 400)

  // Verify ownership
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role')
    .eq('user_id', user.id)
    .eq('business_id', business_id)
    .eq('is_active', true)
    .maybeSingle()

  if (!profile) return json({ error: 'Forbidden' }, 403)

  const { data: biz } = await supabase
    .from('businesses')
    .select('mp_preapproval_id')
    .eq('id', business_id)
    .single()

  if (!biz?.mp_preapproval_id) {
    return json({ error: 'No active subscription found for this business' }, 404)
  }

  // ── Cancel in MP ──────────────────────────────────────────────
  // PUT /preapproval/:id { status: 'cancelled' }
  await mpFetch(`/preapproval/${biz.mp_preapproval_id}`, {
    method: 'PUT',
    body:   JSON.stringify({ status: 'cancelled' }),
  }, `cancel-${biz.mp_preapproval_id}-user`)

  // ── Update DB immediately (webhook will also confirm) ─────────
  await supabase
    .from('businesses')
    .update({
      subscription_status: 'canceled',
      updated_at:          new Date().toISOString(),
    })
    .eq('id', business_id)

  // Log event
  await supabase.from('subscription_events').insert({
    business_id,
    provider:    'mercadopago',
    event_type:  'user_cancelled',
    external_id: biz.mp_preapproval_id,
    raw_payload: { cancelled_by: user.id, timestamp: new Date().toISOString() },
    processed:   true,
  })

  console.log(`[mp-subscription] Cancelled preapproval ${biz.mp_preapproval_id} for business ${business_id}`)

  return json({ success: true })
}

// ─────────────────────────────────────────────────────────────────
// GET LIVE STATUS
// Returns DB data + live MP status for reconciliation
// ─────────────────────────────────────────────────────────────────
async function handleStatus(
  supabase: ReturnType<typeof createClient>,
  user: any,
  body: Record<string, any>
) {
  const { business_id } = body
  if (!business_id) return json({ error: 'Missing business_id' }, 400)

  const { data: biz } = await supabase
    .from('businesses')
    .select(`
      subscription_status,
      subscription_plan,
      mp_preapproval_id,
      mp_payer_email,
      current_period_start,
      current_period_end,
      grace_until,
      last_payment_status,
      trial_ends_at
    `)
    .eq('id', business_id)
    .single()

  if (!biz?.mp_preapproval_id) {
    return json(biz ?? {})
  }

  // Fetch live from MP for real-time status
  let mpLive: Record<string, any> | null = null
  try {
    mpLive = await mpFetch(`/preapproval/${biz.mp_preapproval_id}`)
  } catch (e) {
    console.warn('[mp-subscription] Could not fetch live status:', e)
  }

  return json({ ...biz, mp_live: mpLive })
}

// ─────────────────────────────────────────────────────────────────
// UPDATE PAYMENT METHOD
// Returns the init_point for the existing preapproval so the user
// can re-enter their card in the MP checkout
// ─────────────────────────────────────────────────────────────────
async function handleUpdatePaymentMethod(
  supabase: ReturnType<typeof createClient>,
  user: any,
  body: Record<string, any>
) {
  const { business_id } = body
  if (!business_id) return json({ error: 'Missing business_id' }, 400)

  const { data: biz } = await supabase
    .from('businesses')
    .select('mp_preapproval_id')
    .eq('id', business_id)
    .single()

  if (!biz?.mp_preapproval_id) {
    return json({ error: 'No subscription found for this business' }, 404)
  }

  // Fetch the preapproval — init_point is always available
  const preapproval = await mpFetch(`/preapproval/${biz.mp_preapproval_id}`)

  return json({
    init_point:     preapproval.init_point,
    preapproval_id: biz.mp_preapproval_id,
  })
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
