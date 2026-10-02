/**
 * subscriptionService — Frontend service for subscription management
 *
 * All MP API calls go through the Edge Functions (mp-subscription).
 * Direct DB reads use Supabase client.
 */
import { supabase } from '../lib/supabase'
import { FunctionsHttpError, FunctionsRelayError, FunctionsFetchError } from '@supabase/supabase-js'
import { logger } from '../lib/logger'
import type {
  BusinessSubscription,
  Payment,
  SubscriptionEvent,
  CreateSubscriptionRequest,
  CreateSubscriptionResponse,
  CheckoutSummary,
  ReconcileResult,
  SubscriptionPlan,
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
    // Distinguir los 3 tipos de error de supabase-js para dar un mensaje útil
    // y registrar un código técnico (sin exponer internals en producción).
    if (error instanceof FunctionsHttpError) {
      // La función respondió con un status de error; el body trae { error }.
      let serverMessage = ''
      try {
        serverMessage = ((await error.context.json()) as { error?: string })?.error ?? ''
      } catch {
        /* body no-JSON: ignorar */
      }
      logger.error('GENERAL', `mp-subscription HTTP ${error.context.status} (${action})`, serverMessage)
      throw new Error(serverMessage || `La función de pago devolvió un error (${error.context.status}).`)
    }
    if (error instanceof FunctionsRelayError) {
      logger.error('GENERAL', `mp-subscription relay error (${action})`, error.message)
      throw new Error('No pudimos contactar el servicio de pago. Reintentá en unos segundos.')
    }
    if (error instanceof FunctionsFetchError) {
      // Falla de red o preflight CORS: el navegador no pudo leer la respuesta.
      logger.error('GENERAL', `mp-subscription fetch/CORS error (${action})`, error.message)
      throw new Error('No pudimos enviar la solicitud al servicio de pago. Revisá tu conexión e intentá de nuevo.')
    }
    logger.error('GENERAL', `mp-subscription error desconocido (${action})`, (error as Error)?.message)
    throw new Error('Error en la función de pago.')
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

  // Se mantiene `.single()` A PROPÓSITO: si hay un businessId activo, la fila
  // del negocio TIENE que existir y ser visible. Cero filas no es un estado
  // legítimo acá — es una inconsistencia de datos o una RLS que oculta el
  // negocio propio, y taparla con `.maybeSingle()` la volvería invisible.
  if (error) {
    // PGRST116 = 0 filas (o varias) con Accept: application/vnd.pgrst.object+json.
    // Lo distinguimos de un fallo de permiso/red para no confundir
    // "sin permiso" con "sin dato".
    const sinFila = error.code === 'PGRST116'
    logger.error(
      'AUTH',
      sinFila
        ? 'getSubscription: el negocio activo no es visible (0 filas). Revisar RLS o consistencia de datos.'
        : 'getSubscription: fallo consultando la suscripción',
      { code: error.code, message: error.message },
    )
    return null
  }
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
// BETA-MP: abrir el checkout es una PROPUESTA. La Edge Function registra la
// intención en `subscription_checkout_sessions` (el navegador no escribe esa
// tabla), crea el preapproval en Mercado Pago con el precio del servidor y
// devuelve su checkout. NO cambia el estado ni el plan del negocio: el acceso
// sólo cambia cuando Mercado Pago confirma esa suscripción.
export async function createSubscription(
  req: Omit<CreateSubscriptionRequest, 'back_url'>
): Promise<CreateSubscriptionResponse> {
  const res = await callEdge<CreateSubscriptionResponse>('create', {
    ...req,
    back_url: `${window.location.origin}/subscription/pending`,
  })
  return res
}

// ── Estado del último checkout (lectura local) ───────────────
// `status` NO consulta a Mercado Pago ni sincroniza nada: devuelve lo que el
// servidor ya registró. Para preguntarle a Mercado Pago está `reconcilePayment`.
export async function getCheckoutStatus(businessId: string): Promise<CheckoutSummary | null> {
  const res = await callEdge<{ checkout?: CheckoutSummary | null }>('status', { business_id: businessId })
  return res.checkout ?? null
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

// ── Reconciliación: el servidor consulta Mercado Pago («Verificar pago») ──────
// La Edge Function relee la suscripción en Mercado Pago y lleva la base al
// estado confirmado por el mismo camino que el webhook. `activated` lo decide
// el servidor: si la llamada falla, el error sube tal cual — no se lo
// reemplaza por una lectura local, que diría «activa» de un plan anterior.
export async function reconcilePayment(businessId: string): Promise<ReconcileResult> {
  const result = await callEdge<Partial<ReconcileResult>>('reconcile', { business_id: businessId })
  return {
    activated: result.activated === true,
    message:   result.message ?? 'Verificación completada',
    checkout:  result.checkout ?? null,
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
