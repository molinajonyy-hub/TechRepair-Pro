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
      access_source,
      mp_preapproval_id,
      mp_payer_email,
      current_period_start,
      current_period_end,
      grace_until,
      last_payment_status,
      trial_ends_at,
      override_expires_at
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

// ── Admin: platform-admin role of the current user (null if not an admin) ──
// Reads system_admins.role via RPC. The "owner/admin" business role is NOT a
// platform admin.
export async function getPlatformAdminRole(): Promise<string | null> {
  const { data, error } = await supabase.rpc('current_platform_admin_role')
  if (error) { console.error('getPlatformAdminRole error:', error.message); return null }
  return (data as string | null) ?? null
}

// ── Admin: list all businesses with subscription info ─────────
// Goes through a SECURITY DEFINER RPC gated by system_admins (support_readonly+),
// not the per-tenant RLS view (which would only show the caller's own business).
export async function adminListSubscriptions(query?: string) {
  const { data, error } = await supabase.rpc('admin_list_subscriptions', {
    p_query: query ?? null,
    p_limit: 200,
  })
  if (error) throw error
  // RPC returns SETOF jsonb → array of row objects.
  return (data as unknown[]) ?? []
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

// ── Admin operations — all go through audited SECURITY DEFINER RPCs ──────────
// The frontend NEVER writes subscription columns on `businesses` directly. Each
// RPC validates platform-admin membership, requires a reason, writes only the
// allowed columns and records an audit row. A direct UPDATE is blocked by the
// `trg_protect_subscription_columns` trigger.

export async function adminActivateBusiness(
  businessId: string,
  plan: SubscriptionPlan,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('admin_activate_subscription', {
    p_business_id: businessId, p_plan: plan, p_reason: reason,
  })
  if (error) throw error
}

export async function adminChangePlan(
  businessId: string,
  newPlan: SubscriptionPlan,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('admin_change_subscription_plan', {
    p_business_id: businessId, p_new_plan: newPlan, p_reason: reason,
  })
  if (error) throw error
}

export async function adminExtendTrial(
  businessId: string,
  extraDays: number,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('admin_extend_trial', {
    p_business_id: businessId, p_extra_days: extraDays, p_reason: reason,
  })
  if (error) throw error
}

export async function adminSuspendBusiness(businessId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('admin_suspend_subscription', {
    p_business_id: businessId, p_reason: reason,
  })
  if (error) throw error
}

export async function adminCancelBusiness(businessId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('admin_cancel_subscription', {
    p_business_id: businessId, p_reason: reason,
  })
  if (error) throw error
}

export async function adminGrantLegacyAccess(
  businessId: string,
  plan: SubscriptionPlan,
  reason: string,
  expiresAt?: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('admin_grant_legacy_access', {
    p_business_id: businessId, p_plan: plan, p_reason: reason, p_expires_at: expiresAt ?? null,
  })
  if (error) throw error
}

export async function adminRevokeLegacyAccess(businessId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('admin_revoke_legacy_access', {
    p_business_id: businessId, p_reason: reason,
  })
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

// ── Historial de pagos SaaS ───────────────────────────────────────────────
// Reads the canonical `payments` ledger (written by the webhook). The legacy
// `subscription_payments` table is never populated by the webhook and is
// deprecated — do not read it.
export async function getSubscriptionPayments(businessId: string) {
  const { data } = await supabase
    .from('payments')
    .select('id, subscription_plan, amount, currency, status, paid_at, created_at')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(20)
  return (data ?? []).map(p => ({
    id: p.id,
    plan_id: p.subscription_plan,
    billing_cycle: null as string | null,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    paid_at: p.paid_at,
    created_at: p.created_at,
  }))
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
