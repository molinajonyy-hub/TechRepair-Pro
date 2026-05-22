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

// ── Helper: authenticated edge function call ──────────────────
// Uses supabase.functions.invoke() which automatically sets both
// the 'apikey' (anon key) and 'Authorization' (user JWT) headers
// required by the Supabase API gateway.
async function callEdge<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  // Use getUser() instead of getSession() — validates with server and auto-refreshes expired tokens
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) throw new Error('No hay sesión activa. Iniciá sesión nuevamente.')

  const { data, error } = await supabase.functions.invoke('mp-subscription', {
    body: { action, ...payload },
  })

  if (error) {
    // FunctionsHttpError has a .context with the response body
    const msg = (error as any)?.context?.error
      ?? (error as any)?.message
      ?? `Error en la función de pago`
    throw new Error(msg)
  }

  return data as T
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
  const res = await callEdge<CreateSubscriptionResponse>('create', {
    ...req,
    back_url: `${window.location.origin}/subscription/pending`,
  })

  // Registrar la sesión de checkout para auditoría y seguimiento del webhook
  const plan = (await import('../types/subscription')).PLANS.find(p => p.id === req.plan)
  if (plan) {
    const cycle = req.billing_cycle as BillingCycle
    const amount = cycle === 'annual' ? plan.price_annual
                 : cycle === 'quarterly' ? plan.price_quarterly
                 : plan.price_monthly
    const extRef = `${req.business_id}_${req.plan}_${Date.now()}`
    await supabase.from('subscription_checkout_sessions').insert({
      business_id:        req.business_id,
      plan_id:            req.plan,
      billing_cycle:      cycle,
      amount,
      mp_preference_id:   res.preapproval_id ?? null,
      external_reference: extRef,
      status:             'pending',
    })
  }

  return res
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

// ── Admin: change plan of an active business ─────────────────
export async function adminChangePlan(
  businessId: string,
  newPlan: SubscriptionPlan
): Promise<void> {
  const { error } = await supabase
    .from('businesses')
    .update({
      subscription_plan: newPlan,
      updated_at: new Date().toISOString(),
    })
    .eq('id', businessId)
  if (error) throw error

  await supabase.from('subscription_events').insert({
    business_id: businessId,
    provider: 'manual',
    event_type: 'manual_plan_change',
    external_id: null,
    raw_payload: { new_plan: newPlan, changed_by: 'admin' },
    processed: true,
  })
}

// ── Admin: extend trial by N extra days ──────────────────────
export async function adminExtendTrial(
  businessId: string,
  extraDays: number
): Promise<void> {
  // Fetch current trial_ends_at; if past, extend from now
  const { data } = await supabase
    .from('businesses')
    .select('trial_ends_at')
    .eq('id', businessId)
    .single()

  const base = data?.trial_ends_at ? new Date(data.trial_ends_at) : new Date()
  if (base < new Date()) base.setTime(Date.now())
  base.setDate(base.getDate() + extraDays)

  const { error } = await supabase
    .from('businesses')
    .update({
      subscription_status: 'trialing',
      trial_ends_at: base.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', businessId)
  if (error) throw error

  await supabase.from('subscription_events').insert({
    business_id: businessId,
    provider: 'manual',
    event_type: 'trial_extended',
    external_id: null,
    raw_payload: { extra_days: extraDays, new_trial_ends_at: base.toISOString() },
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

// ── Consultar estado de checkout session (para polling en PaymentPending) ────
export async function getLatestCheckoutSession(businessId: string): Promise<{
  status: string | null; plan_id: string | null; id: string | null
}> {
  const { data } = await supabase
    .from('subscription_checkout_sessions')
    .select('id, status, plan_id')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return { status: data?.status ?? null, plan_id: data?.plan_id ?? null, id: data?.id ?? null }
}

// ── Reconciliación manual: sincronizar desde MP live (botón "Verificar pago") ─
export async function reconcilePayment(businessId: string): Promise<{
  activated: boolean; message: string
}> {
  try {
    const result = await callEdge<{ activated?: boolean; status?: string; message?: string }>(
      'reconcile', { business_id: businessId }
    )
    return {
      activated: result.activated ?? false,
      message:   result.message ?? 'Verificación completada',
    }
  } catch {
    // Fallback: leer estado actual desde DB
    const sub = await getSubscription(businessId)
    return {
      activated: sub?.subscription_status === 'active',
      message:   sub?.subscription_status === 'active'
        ? 'Tu suscripción ya está activa.'
        : 'No se detectó pago aprobado todavía.',
    }
  }
}

// ── Historial de pagos SaaS (subscription_payments) ───────────────────────
export async function getSubscriptionPayments(businessId: string) {
  const { data } = await supabase
    .from('subscription_payments')
    .select('id, plan_id, billing_cycle, amount, currency, status, paid_at, created_at')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(20)
  return data ?? []
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
