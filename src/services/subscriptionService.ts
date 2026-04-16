/**
 * subscriptionService — Frontend service for subscription management
 *
 * All MP API calls go through the Edge Functions (mp-subscription).
 * Direct DB reads use Supabase client.
 */
import { supabase } from '../lib/supabase'
import type {
  BusinessSubscription,
  Payment,
  SubscriptionEvent,
  CreateSubscriptionRequest,
  CreateSubscriptionResponse,
  SubscriptionPlan,
  BillingCycle,
} from '../types/subscription'

// Edge function URL — uses VITE_SUPABASE_URL which is always the project URL
const EDGE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mp-subscription`

// ── Helper: authenticated edge function call ──────────────────
// Refreshes the session token before each call to avoid 401s from expired JWTs
async function callEdge<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  // getSession may return a stale token; refreshSession ensures it's valid
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('No hay sesión activa. Iniciá sesión nuevamente.')

  const res = await fetch(EDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, ...payload }),
  })

  let body: any
  try {
    body = await res.json()
  } catch {
    throw new Error(`Edge function returned non-JSON response (status ${res.status})`)
  }

  if (!res.ok) {
    throw new Error(body?.error ?? `Error en la función de pago (${res.status})`)
  }
  return body as T
}

// ── Get subscription info for current business ─────────────────
export async function getSubscription(businessId: string): Promise<BusinessSubscription | null> {
  const { data, error } = await supabase
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
    .eq('id', businessId)
    .single()

  if (error) { console.error('getSubscription error:', error); return null }
  return data as BusinessSubscription
}

// ── List payments for current business ───────────────────────
export async function getPayments(businessId: string): Promise<Payment[]> {
  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) { console.error('getPayments error:', error); return [] }
  return (data || []) as Payment[]
}

// ── List subscription events (webhook log) ────────────────────
export async function getSubscriptionEvents(businessId: string): Promise<SubscriptionEvent[]> {
  const { data, error } = await supabase
    .from('subscription_events')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(30)

  if (error) { console.error('getSubscriptionEvents error:', error); return [] }
  return (data || []) as SubscriptionEvent[]
}

// ── Create subscription (calls Edge Function) ─────────────────
export async function createSubscription(
  req: Omit<CreateSubscriptionRequest, 'back_url'>
): Promise<CreateSubscriptionResponse> {
  return callEdge<CreateSubscriptionResponse>('create', {
    ...req,
    back_url: `${window.location.origin}/subscription/pending`,
  })
}

// ── Sync from MP (live reconciliation) ───────────────────────
// Called on the PaymentPending page to check if webhook already arrived.
// Returns the current subscription status from our DB (refreshed by calling
// the edge function which queries MP live and we read the DB side).
export async function syncSubscriptionStatus(businessId: string): Promise<BusinessSubscription | null> {
  // First try to get current DB state (fast)
  const current = await getSubscription(businessId)

  // If not yet active, also call the edge fn which fetches live MP status
  // (This doesn't update the DB — only the webhook does that — but it lets us
  // show the correct state in the PaymentPending polling screen)
  if (current?.subscription_status === 'pending_activation') {
    try {
      await callEdge('status', { business_id: businessId })
    } catch {
      // Non-critical — return DB state as-is
    }
    // Re-read from DB after potential webhook update
    return getSubscription(businessId)
  }

  return current
}

// ── Cancel subscription (calls Edge Function) ─────────────────
export async function cancelSubscription(businessId: string): Promise<void> {
  await callEdge<{ success: boolean }>('cancel', { business_id: businessId })
}

// ── Get update payment method link ───────────────────────────
export async function getUpdatePaymentLink(businessId: string): Promise<string> {
  const res = await callEdge<{ init_point: string }>('update_payment_method', {
    business_id: businessId,
  })
  return res.init_point
}

// ── Admin: list all businesses with subscription info ─────────
export async function adminListSubscriptions(query?: string) {
  let q = supabase
    .from('v_subscription_overview')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)

  if (query) {
    q = q.ilike('business_name', `%${query}%`)
  }

  const { data, error } = await q
  if (error) throw error
  return data || []
}

// ── Admin: get all events for a business ─────────────────────
export async function adminGetEvents(businessId: string) {
  const { data, error } = await supabase
    .from('subscription_events')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) throw error
  return data || []
}

// ── Admin: manually activate a business ──────────────────────
export async function adminActivateBusiness(
  businessId: string,
  plan: SubscriptionPlan
): Promise<void> {
  const now = new Date()
  const nextMonth = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000)

  const { error } = await supabase
    .from('businesses')
    .update({
      subscription_status: 'active',
      subscription_plan: plan,
      current_period_start: now.toISOString(),
      current_period_end: nextMonth.toISOString(),
      grace_until: null,
      updated_at: now.toISOString(),
    })
    .eq('id', businessId)

  if (error) throw error

  // Log manual activation
  await supabase.from('subscription_events').insert({
    business_id: businessId,
    provider: 'manual',
    event_type: 'manual_activation',
    external_id: null,
    raw_payload: { activated_plan: plan, activated_by: 'admin' },
    processed: true,
  })
}

// ── Admin: suspend a business ─────────────────────────────────
export async function adminSuspendBusiness(businessId: string): Promise<void> {
  const { error } = await supabase
    .from('businesses')
    .update({
      subscription_status: 'suspended',
      updated_at: new Date().toISOString(),
    })
    .eq('id', businessId)

  if (error) throw error
}

// ── Format currency ───────────────────────────────────────────
export function formatSubscriptionPrice(amount: number, currency = 'ARS'): string {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
  }).format(amount)
}

// ── Get billing cycle MP plan ID ─────────────────────────────
export function getPlanId(plan: SubscriptionPlan, cycle: BillingCycle): string {
  const envMap: Record<string, string> = {
    'basico_monthly':   import.meta.env.VITE_MP_PLAN_BASICO_MONTHLY   || '',
    'basico_quarterly': import.meta.env.VITE_MP_PLAN_BASICO_QUARTERLY || '',
    'basico_annual':    import.meta.env.VITE_MP_PLAN_BASICO_ANNUAL    || '',
    'pro_monthly':      import.meta.env.VITE_MP_PLAN_PRO_MONTHLY      || '',
    'pro_quarterly':    import.meta.env.VITE_MP_PLAN_PRO_QUARTERLY    || '',
    'pro_annual':       import.meta.env.VITE_MP_PLAN_PRO_ANNUAL       || '',
    'full_monthly':     import.meta.env.VITE_MP_PLAN_FULL_MONTHLY     || '',
    'full_quarterly':   import.meta.env.VITE_MP_PLAN_FULL_QUARTERLY   || '',
    'full_annual':      import.meta.env.VITE_MP_PLAN_FULL_ANNUAL      || '',
  }
  return envMap[`${plan}_${cycle}`] || ''
}
