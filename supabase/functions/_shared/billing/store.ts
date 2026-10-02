/**
 * store — BETA-MP · acceso a datos de Billing SaaS.
 *
 * `BillingStore` es la única puerta por la que las Edge Functions de billing
 * leen o escriben la base. La implementación usa el cliente `service_role`, así
 * que cada método escribe sólo las columnas que ese rol tiene concedidas:
 *
 *   businesses                       SELECT + UPDATE de las columnas de billing
 *   subscription_checkout_sessions   SELECT, INSERT, UPDATE   (migración 20261012120000;
 *                                    un preapproval ↔ una sesión: migración 20261013120000)
 *   subscription_events              todo
 *   payments                         todo
 *
 * Ninguna escritura ignora su error: un `UPDATE` que falla lanza
 * `BillingStoreError` y corta la operación. El código anterior no miraba el
 * resultado de sus escrituras.
 *
 * `BillingAuthorizer` es aparte y corre con el JWT DEL USUARIO, no con
 * `service_role`: la autoridad de «puede gestionar la suscripción de este
 * negocio» la tiene la base, evaluada como ese usuario.
 */
import type { BillingCycle, BillingPlan } from './planCatalog.ts'
import type { LedgerPaymentStatus } from './mpClient.ts'

export type SubscriptionStatus =
  | 'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled' | 'pending_activation'

export interface BusinessBillingRow {
  id: string
  subscription_status: SubscriptionStatus
  subscription_plan: BillingPlan | null
  subscription_provider: string | null
  access_source: string | null
  mp_preapproval_id: string | null
  mp_preapproval_plan_id: string | null
  mp_payer_email: string | null
  mp_last_modified: string | null
  current_period_start: string | null
  current_period_end: string | null
  grace_until: string | null
  last_payment_id: string | null
  last_payment_status: string | null
  trial_ends_at: string | null
}

/** Columnas de `businesses` que `service_role` puede actualizar. Ninguna otra. */
export interface BusinessBillingPatch {
  subscription_status?: SubscriptionStatus
  subscription_plan?: BillingPlan
  subscription_provider?: 'mercadopago'
  access_source?: 'mercado_pago'
  mp_preapproval_id?: string
  mp_preapproval_plan_id?: string | null
  mp_payer_email?: string | null
  mp_last_modified?: string | null
  current_period_start?: string | null
  current_period_end?: string | null
  grace_until?: string | null
  last_payment_id?: string | null
  last_payment_status?: LedgerPaymentStatus | null
  last_webhook_at?: string
}

export type CheckoutSessionStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'canceled'

export interface CheckoutSessionRow {
  id: string
  business_id: string
  user_id: string | null
  plan_id: BillingPlan
  billing_cycle: BillingCycle
  amount: number | string
  currency: string
  external_reference: string | null
  status: CheckoutSessionStatus
  mp_preapproval_plan_id: string | null
  mp_preapproval_id: string | null
  payer_email: string | null
  created_at: string
  updated_at: string
  confirmed_at: string | null
}

export interface NewCheckoutSession {
  business_id: string
  user_id: string
  plan_id: BillingPlan
  billing_cycle: BillingCycle
  amount: number
  currency: string
  external_reference: string
  payer_email: string
}

export interface CheckoutSessionPatch {
  status?: CheckoutSessionStatus
  mp_preapproval_id?: string
  confirmed_at?: string
}

export interface NewBillingEvent {
  business_id?: string | null
  event_type: string
  external_id: string | null
  notification_id?: string | null
  raw_payload: Record<string, unknown>
  processed: boolean
  error_message?: string | null
}

export interface BillingEventPatch {
  business_id?: string | null
  processed?: boolean
  processed_at?: string
  error_message?: string | null
}

export interface PaymentLedgerRow {
  business_id: string
  external_payment_id: string
  type: 'recurring'
  amount: number
  currency: string
  status: LedgerPaymentStatus
  subscription_plan: BillingPlan | null
  paid_at: string | null
  raw_payload: Record<string, unknown>
}

export type ClaimedEvent = { id: string; duplicate: false } | { id: string | null; duplicate: true; processed: boolean }

export interface BillingStore {
  getBusinessBilling(businessId: string): Promise<BusinessBillingRow | null>
  findBusinessByPreapprovalId(preapprovalId: string): Promise<BusinessBillingRow | null>
  updateBusinessBilling(businessId: string, patch: BusinessBillingPatch, nowIso: string): Promise<void>

  /**
   * La sesión que originó un preapproval. El vínculo lo escribe `create`, con el
   * id que devolvió Mercado Pago, antes de devolver el checkout. Más de una fila
   * para el mismo preapproval es un error (lo impide `uq_scs_mp_preapproval`).
   */
  findCheckoutSessionByPreapprovalId(preapprovalId: string): Promise<CheckoutSessionRow | null>
  findCheckoutSessionByReference(reference: string): Promise<CheckoutSessionRow | null>
  listCheckoutSessions(businessId: string, limit: number): Promise<CheckoutSessionRow[]>
  insertCheckoutSession(row: NewCheckoutSession): Promise<CheckoutSessionRow>
  updateCheckoutSession(sessionId: string, patch: CheckoutSessionPatch, nowIso: string): Promise<void>

  /**
   * Reclama una notificación. La clave única es
   * (provider, event_type, external_id, notification_id): la MISMA notificación
   * reenviada devuelve `duplicate`; otra notificación del mismo recurso, no.
   */
  claimEvent(event: NewBillingEvent): Promise<ClaimedEvent>
  recordEvent(event: NewBillingEvent): Promise<void>
  updateEvent(eventId: string, patch: BillingEventPatch): Promise<void>

  upsertPayment(row: PaymentLedgerRow): Promise<void>
}

export interface BillingAuthorizer {
  /** ¿El usuario del JWT puede gestionar la suscripción de ESE negocio? */
  canManageBilling(businessId: string): Promise<boolean>
}

/** Falla de la base. `code` es el SQLSTATE / código de PostgREST cuando existe. */
export class BillingStoreError extends Error {
  readonly operation: string
  readonly code: string | null
  constructor(operation: string, code: string | null) {
    super(`billing store: ${operation} falló${code ? ` (${code})` : ''}`)
    this.name = 'BillingStoreError'
    this.operation = operation
    this.code = code
  }
}

// ── Implementación sobre supabase-js ────────────────────────────────────────

interface PostgrestResult { data: unknown; error: unknown }
// El builder de supabase-js es encadenable y no tiene un tipo estructural chico
// que sirva a la vez para Deno (esm.sh) y Node (npm). Se acota en los bordes.
// deno-lint-ignore no-explicit-any
type QueryBuilder = any

export interface SupabaseLike {
  from(table: string): QueryBuilder
}

export interface SupabaseRpcLike {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<PostgrestResult>
}

const BUSINESS_COLUMNS = [
  'id', 'subscription_status', 'subscription_plan', 'subscription_provider', 'access_source',
  'mp_preapproval_id', 'mp_preapproval_plan_id', 'mp_payer_email', 'mp_last_modified',
  'current_period_start', 'current_period_end', 'grace_until',
  'last_payment_id', 'last_payment_status', 'trial_ends_at',
].join(', ')

const SESSION_COLUMNS = [
  'id', 'business_id', 'user_id', 'plan_id', 'billing_cycle', 'amount', 'currency',
  'external_reference', 'status', 'mp_preapproval_plan_id', 'mp_preapproval_id',
  'payer_email', 'created_at', 'updated_at', 'confirmed_at',
].join(', ')

const PROVIDER = 'mercadopago'

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

function unwrap<T>(operation: string, result: PostgrestResult): T {
  if (result.error) throw new BillingStoreError(operation, errorCode(result.error))
  return result.data as T
}

export function createSupabaseBillingStore(client: SupabaseLike): BillingStore {
  return {
    async getBusinessBilling(businessId) {
      return unwrap<BusinessBillingRow | null>('leer negocio', await client
        .from('businesses').select(BUSINESS_COLUMNS).eq('id', businessId).maybeSingle())
    },

    async findBusinessByPreapprovalId(preapprovalId) {
      return unwrap<BusinessBillingRow | null>('buscar negocio por preapproval', await client
        .from('businesses').select(BUSINESS_COLUMNS).eq('mp_preapproval_id', preapprovalId).maybeSingle())
    },

    async updateBusinessBilling(businessId, patch, nowIso) {
      unwrap('actualizar billing del negocio', await client
        .from('businesses').update({ ...patch, updated_at: nowIso }).eq('id', businessId))
    },

    async findCheckoutSessionByPreapprovalId(preapprovalId) {
      return unwrap<CheckoutSessionRow | null>('buscar sesión de checkout por preapproval', await client
        .from('subscription_checkout_sessions').select(SESSION_COLUMNS)
        .eq('mp_preapproval_id', preapprovalId).maybeSingle())
    },

    async findCheckoutSessionByReference(reference) {
      return unwrap<CheckoutSessionRow | null>('buscar sesión de checkout', await client
        .from('subscription_checkout_sessions').select(SESSION_COLUMNS)
        .eq('external_reference', reference).maybeSingle())
    },

    async listCheckoutSessions(businessId, limit) {
      return unwrap<CheckoutSessionRow[] | null>('listar sesiones de checkout', await client
        .from('subscription_checkout_sessions').select(SESSION_COLUMNS)
        .eq('business_id', businessId).order('created_at', { ascending: false }).limit(limit)) ?? []
    },

    async insertCheckoutSession(row) {
      return unwrap<CheckoutSessionRow>('crear sesión de checkout', await client
        .from('subscription_checkout_sessions').insert({ ...row, status: 'pending' })
        .select(SESSION_COLUMNS).single())
    },

    async updateCheckoutSession(sessionId, patch, nowIso) {
      unwrap('actualizar sesión de checkout', await client
        .from('subscription_checkout_sessions').update({ ...patch, updated_at: nowIso }).eq('id', sessionId))
    },

    async claimEvent(event) {
      const inserted: PostgrestResult = await client
        .from('subscription_events').insert({ provider: PROVIDER, ...event }).select('id').single()
      if (!inserted.error) return { id: (inserted.data as { id: string }).id, duplicate: false }
      // 23505 = la misma notificación ya fue reclamada.
      if (errorCode(inserted.error) !== '23505') {
        throw new BillingStoreError('registrar evento', errorCode(inserted.error))
      }
      const existing = unwrap<{ id: string; processed: boolean } | null>('leer evento duplicado', await client
        .from('subscription_events').select('id, processed')
        .eq('provider', PROVIDER).eq('event_type', event.event_type)
        .eq('external_id', event.external_id).eq('notification_id', event.notification_id)
        .maybeSingle())
      return { id: existing?.id ?? null, duplicate: true, processed: existing?.processed === true }
    },

    async recordEvent(event) {
      unwrap('registrar evento de auditoría', await client
        .from('subscription_events').insert({ provider: PROVIDER, ...event }))
    },

    async updateEvent(eventId, patch) {
      unwrap('actualizar evento', await client
        .from('subscription_events').update(patch).eq('id', eventId))
    },

    async upsertPayment(row) {
      unwrap('registrar pago en el ledger', await client
        .from('payments').upsert({ provider: PROVIDER, ...row }, { onConflict: 'provider,external_payment_id' }))
    },
  }
}

/** Capacidad canónica que gobierna `/subscription/*` en el frontend. */
export const BILLING_CAPABILITY = 'subscription'

/**
 * Autorizador por capacidad. `userClient` DEBE estar construido con el JWT del
 * usuario: `current_user_can_in_business` resuelve identidad, perfil activo,
 * negocio y overrides con `auth.uid()`. Sólo un `true` literal autoriza; un
 * error de la base lanza (el caller responde 503, nunca permite).
 */
export function createCapabilityAuthorizer(userClient: SupabaseRpcLike): BillingAuthorizer {
  return {
    async canManageBilling(businessId) {
      const result = await userClient.rpc('current_user_can_in_business', {
        p_business_id: businessId,
        p_key: BILLING_CAPABILITY,
      })
      if (result.error) throw new BillingStoreError('autorizar', errorCode(result.error))
      return result.data === true
    },
  }
}
