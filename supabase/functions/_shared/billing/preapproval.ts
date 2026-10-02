/**
 * preapproval — BETA-MP · EL camino canónico de Billing SaaS.
 *
 * `applyPreapprovalEvidence` es la única función que cambia el acceso de un
 * negocio a partir de Mercado Pago. La usan el webhook, `reconcile`, `cancel` y
 * el handler de cobros recurrentes: no existe un segundo mapeo de estados.
 *
 * Entrada: un preapproval CONSULTADO en Mercado Pago por el servidor. Nunca el
 * cuerpo de un webhook, nunca un dato del navegador.
 *
 * Reglas:
 *   · El negocio se resuelve por `mp_preapproval_id` (suscripción ya vinculada) o
 *     por una sesión de checkout emitida por el servidor (`external_reference`).
 *     Un `business_id` suelto como referencia no vincula nada.
 *   · El plan sale de `preapproval_plan_id` según `planCatalog`. Un plan
 *     desconocido no activa ni cambia nada.
 *   · Sólo `authorized` otorga acceso. `pending` nunca lo quita a quien no lo
 *     tenía por esta suscripción.
 *   · Un evento más viejo que el último aplicado no pisa nada.
 *   · Todo cambio de acceso deja un evento de auditoría.
 */
import type { MpClient, MpPreapproval, PreapprovalState } from './mpClient.ts'
import { preapprovalState } from './mpClient.ts'
import type { BillingPlan, PlanCatalog, PlanCatalogEntry } from './planCatalog.ts'
import type {
  BillingStore, BusinessBillingPatch, BusinessBillingRow, CheckoutSessionRow, SubscriptionStatus,
} from './store.ts'

export const GRACE_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000

// ── Referencia de checkout ──────────────────────────────────────────────────

export const CHECKOUT_REFERENCE_PREFIX = 'trpcs_'
const CHECKOUT_REFERENCE_RE = /^trpcs_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Referencia de un checkout nuevo. El UUID lo genera el servidor. */
export function newCheckoutReference(uuid: string): string {
  return `${CHECKOUT_REFERENCE_PREFIX}${uuid.toLowerCase()}`
}

/**
 * Devuelve la referencia sólo si tiene EXACTAMENTE el formato que emite el
 * servidor. Vacía, numérica, un `business_id` suelto o cualquier otro texto → `null`.
 */
export function parseCheckoutReference(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return CHECKOUT_REFERENCE_RE.test(value) ? value : null
}

// ── Contexto y resultado ────────────────────────────────────────────────────

export interface BillingLogEvent {
  event: string
  [key: string]: unknown
}

export interface BillingContext {
  store: BillingStore
  mp: MpClient
  catalog: PlanCatalog
  now: () => Date
  /** Sólo ids, estados y códigos. Nunca emails, tokens ni cuerpos de Mercado Pago. */
  log: (event: BillingLogEvent) => void
}

export type EvidenceSource = 'webhook' | 'reconcile' | 'cancel' | 'payment'

export type EvidenceReason =
  | 'stale'                  // evento más viejo que el último aplicado
  | 'unknown_plan'           // el plan de MP no está en el catálogo
  | 'unknown_status'         // estado de MP que no conocemos
  | 'no_reference'           // sin external_reference, o con un formato ajeno
  | 'unknown_reference'      // la referencia no corresponde a ninguna sesión
  | 'reference_consumed'     // la sesión ya activó OTRA suscripción
  | 'superseded_preapproval' // esta suscripción ya fue reemplazada por otra
  | 'foreign_business'       // la evidencia no es del negocio esperado
  | 'business_missing'
  | 'not_authorized'         // preapproval nuevo que todavía no está authorized
  | 'awaiting_payment'       // authorized, pero el último cobro fue rechazado
  | 'access_override'        // acceso otorgado por un admin: MP no lo degrada

export interface EvidenceOutcome {
  /** `activated`: se vinculó una suscripción nueva. `updated`: cambió el acceso de una ya vinculada. */
  kind: 'activated' | 'updated' | 'unchanged' | 'not_applied'
  reason: EvidenceReason | null
  businessId: string | null
  preapprovalId: string
  mpState: PreapprovalState
  /** Estado y plan del negocio DESPUÉS de aplicar (cuando se resolvió un negocio). */
  status: SubscriptionStatus | null
  plan: BillingPlan | null
  sessionId: string | null
  /** El plan que confirmó MP no es el que pidió el checkout. Prevalece MP. */
  planMismatch: boolean
}

export interface ApplyOptions {
  source: EvidenceSource
  /**
   * Negocio en cuyo nombre se actúa (`reconcile`, `cancel`). Si la evidencia
   * resuelve a otro negocio no se escribe nada.
   */
  expectBusinessId?: string
}

/** Fuentes de acceso otorgadas por un admin de plataforma. */
const OVERRIDE_SOURCES = ['admin_override', 'manual_grandfathered']

/** El acceso vigente lo otorgó un admin: Mercado Pago no lo activa ni lo degrada. */
export function hasAccessOverride(business: BusinessBillingRow): boolean {
  return OVERRIDE_SOURCES.includes(business.access_source ?? '')
}

export function isStale(incoming: string | null | undefined, stored: string | null | undefined): boolean {
  if (!incoming || !stored) return false
  const a = new Date(incoming).getTime()
  const b = new Date(stored).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  return a < b
}

export function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const time = new Date(raw).getTime()
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return new Date(a).getTime() === new Date(b).getTime()
}

const INSTANT_COLUMNS = ['mp_last_modified', 'current_period_start', 'current_period_end', 'grace_until']

/** Deja en el patch sólo lo que realmente difiere de la fila. */
export function changedOnly(row: BusinessBillingRow, patch: BusinessBillingPatch): BusinessBillingPatch {
  const out: Record<string, unknown> = {}
  const current = row as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in current)) { out[key] = value; continue }
    const before = (current[key] ?? null) as string | null
    const after = (value ?? null) as string | null
    const equal = INSTANT_COLUMNS.includes(key) ? sameInstant(before, after) : before === after
    if (!equal) out[key] = value
  }
  return out as BusinessBillingPatch
}

function outcome(
  pre: MpPreapproval, mpState: PreapprovalState, partial: Partial<EvidenceOutcome> & Pick<EvidenceOutcome, 'kind'>,
): EvidenceOutcome {
  return {
    reason: null, businessId: null, status: null, plan: null, sessionId: null, planMismatch: false,
    ...partial,
    preapprovalId: pre.id,
    mpState,
  }
}

// ── Punto de entrada ────────────────────────────────────────────────────────

export async function applyPreapprovalEvidence(
  ctx: BillingContext, pre: MpPreapproval, options: ApplyOptions,
): Promise<EvidenceOutcome> {
  const mpState = preapprovalState(pre.status)
  const entry = ctx.catalog.byMpPlanId(pre.preapproval_plan_id)
  const bound = await ctx.store.findBusinessByPreapprovalId(pre.id)

  const result = bound
    ? await applyToBound(ctx, pre, mpState, entry, bound, options)
    : await applyToUnbound(ctx, pre, mpState, entry, options)

  ctx.log({
    event: 'preapproval_evidence', source: options.source, kind: result.kind, reason: result.reason,
    business_id: result.businessId, preapproval_id: pre.id, mp_state: mpState, status: result.status, plan: result.plan,
  })
  return result
}

// ── Suscripción ya vinculada a un negocio ───────────────────────────────────

async function applyToBound(
  ctx: BillingContext, pre: MpPreapproval, mpState: PreapprovalState, entry: PlanCatalogEntry | null,
  business: BusinessBillingRow, options: ApplyOptions,
): Promise<EvidenceOutcome> {
  const base = { businessId: business.id, status: business.subscription_status, plan: business.subscription_plan }

  if (options.expectBusinessId && options.expectBusinessId !== business.id) {
    // No se devuelve el id del negocio real: es de otro tenant.
    return outcome(pre, mpState, { kind: 'not_applied', reason: 'foreign_business' })
  }
  if (isStale(pre.last_modified, business.mp_last_modified)) {
    return outcome(pre, mpState, { ...base, kind: 'not_applied', reason: 'stale' })
  }
  if (mpState === 'unknown') {
    return outcome(pre, mpState, { ...base, kind: 'not_applied', reason: 'unknown_status' })
  }
  if (mpState === 'authorized' && !entry) {
    return outcome(pre, mpState, { ...base, kind: 'not_applied', reason: 'unknown_plan' })
  }

  const now = ctx.now()
  const nowIso = now.toISOString()
  const current = business.subscription_status
  const patch: BusinessBillingPatch = {}
  let reason: EvidenceReason | null = null

  if (hasAccessOverride(business)) {
    // Un admin otorgó este acceso después de la suscripción. Mercado Pago no lo
    // activa, degrada ni recalifica: sólo se registra la novedad del preapproval.
    reason = 'access_override'
  } else if (mpState === 'authorized') {
    const paymentFailure = (current === 'past_due' || current === 'suspended')
      && business.last_payment_status === 'rejected'
    if (paymentFailure) {
      // Que el preapproval siga `authorized` no prueba que se cobró. La mora la
      // levanta un cobro aprobado (handler de cobros), no una relectura.
      reason = 'awaiting_payment'
    } else {
      patch.subscription_status = 'active'
      patch.subscription_provider = 'mercadopago'
      patch.access_source = 'mercado_pago'
      patch.grace_until = null
      // El plan lo define MP. Se reescribe cuando cambia el plan de MP registrado
      // (o falta), no en cada evento: un cambio de plan hecho por un admin sobre
      // la misma suscripción no se pisa.
      if (business.mp_preapproval_plan_id !== entry!.mpPlanId || business.subscription_plan === null) {
        patch.subscription_plan = entry!.plan
        patch.mp_preapproval_plan_id = entry!.mpPlanId
      }
    }
  } else if (mpState === 'paused' || mpState === 'pending') {
    if (current === 'active') {
      patch.subscription_status = 'past_due'
      // La gracia se fija al ENTRAR en mora. No se renueva con cada evento.
      patch.grace_until = new Date(now.getTime() + GRACE_DAYS * DAY_MS).toISOString()
    }
  } else if (mpState === 'cancelled') {
    // Un trial (p. ej. extendido por un admin después de la baja) no depende de
    // esta suscripción: una cancelación tardía no lo corta.
    if (current !== 'trialing') patch.subscription_status = 'canceled'
  }

  // Bitácora del preapproval (no cambia el acceso).
  const lastModified = isoOrNull(pre.last_modified)
  if (lastModified) patch.mp_last_modified = lastModified
  if (typeof pre.payer_email === 'string' && pre.payer_email) patch.mp_payer_email = pre.payer_email

  const changes = changedOnly(business, patch)
  const accessChanged = 'subscription_status' in changes || 'subscription_plan' in changes
  if (options.source === 'webhook') changes.last_webhook_at = nowIso

  if (Object.keys(changes).length > 0) {
    await ctx.store.updateBusinessBilling(business.id, changes, nowIso)
  }

  const status = changes.subscription_status ?? current
  const plan = changes.subscription_plan ?? business.subscription_plan

  // Repara una sesión que quedó `pending` si la escritura anterior se cortó entre
  // el negocio y la sesión.
  let sessionId: string | null = null
  if (mpState === 'authorized' && status === 'active') {
    sessionId = await settleSession(ctx, pre, business.id, nowIso)
  }

  if (accessChanged) {
    await ctx.store.recordEvent({
      business_id: business.id, event_type: 'billing_state_applied', external_id: pre.id, processed: true,
      raw_payload: {
        source: options.source, mp_status: mpState,
        from: { status: current, plan: business.subscription_plan },
        to: { status, plan },
      },
    })
  }

  return outcome(pre, mpState, {
    kind: accessChanged ? 'updated' : 'unchanged', reason, businessId: business.id, status, plan, sessionId,
  })
}

async function settleSession(
  ctx: BillingContext, pre: MpPreapproval, businessId: string, nowIso: string,
): Promise<string | null> {
  const reference = parseCheckoutReference(pre.external_reference)
  if (!reference) return null
  const session = await ctx.store.findCheckoutSessionByReference(reference)
  if (!session || session.business_id !== businessId) return null
  if (session.status !== 'paid' && (session.mp_preapproval_id === null || session.mp_preapproval_id === pre.id)) {
    await ctx.store.updateCheckoutSession(session.id, { status: 'paid', mp_preapproval_id: pre.id, confirmed_at: nowIso }, nowIso)
  }
  return session.id
}

// ── Suscripción nueva: se resuelve por la sesión de checkout ────────────────

async function applyToUnbound(
  ctx: BillingContext, pre: MpPreapproval, mpState: PreapprovalState, entry: PlanCatalogEntry | null,
  options: ApplyOptions,
): Promise<EvidenceOutcome> {
  const reference = parseCheckoutReference(pre.external_reference)
  if (!reference) return outcome(pre, mpState, { kind: 'not_applied', reason: 'no_reference' })

  const session = await ctx.store.findCheckoutSessionByReference(reference)
  if (!session) return outcome(pre, mpState, { kind: 'not_applied', reason: 'unknown_reference' })

  if (options.expectBusinessId && options.expectBusinessId !== session.business_id) {
    return outcome(pre, mpState, { kind: 'not_applied', reason: 'foreign_business' })
  }

  const business = await ctx.store.getBusinessBilling(session.business_id)
  if (!business) return outcome(pre, mpState, { kind: 'not_applied', reason: 'business_missing', sessionId: session.id })

  const base = {
    businessId: business.id, status: business.subscription_status, plan: business.subscription_plan, sessionId: session.id,
  }
  const nowIso = ctx.now().toISOString()

  if (mpState !== 'authorized') {
    // Ningún cambio de acceso. La sesión anota lo que vio para que `reconcile`
    // pueda consultar el preapproval directamente.
    await noteUnauthorized(ctx, session, pre, mpState, nowIso)
    return outcome(pre, mpState, { ...base, kind: 'not_applied', reason: mpState === 'unknown' ? 'unknown_status' : 'not_authorized' })
  }
  if (!entry) return outcome(pre, mpState, { ...base, kind: 'not_applied', reason: 'unknown_plan' })

  if (session.status === 'paid') {
    // Una sesión activa UNA suscripción. La misma, ya reemplazada, o una segunda
    // con la misma referencia: ninguna vuelve a vincular.
    const reason: EvidenceReason = session.mp_preapproval_id === pre.id ? 'superseded_preapproval' : 'reference_consumed'
    return outcome(pre, mpState, { ...base, kind: 'not_applied', reason })
  }

  const previousPreapproval = business.mp_preapproval_id
  const previousStatus = business.subscription_status
  const planMismatch = session.plan_id !== entry.plan || session.billing_cycle !== entry.billingCycle

  // 1. El negocio. Si otro negocio ya tiene este preapproval, el índice único
  //    `uq_businesses_mp_preapproval_id` rechaza la escritura y no se sigue.
  await ctx.store.updateBusinessBilling(business.id, {
    subscription_status: 'active',
    subscription_plan: entry.plan,
    subscription_provider: 'mercadopago',
    access_source: 'mercado_pago',
    mp_preapproval_id: pre.id,
    mp_preapproval_plan_id: entry.mpPlanId,
    mp_payer_email: typeof pre.payer_email === 'string' && pre.payer_email ? pre.payer_email : null,
    mp_last_modified: isoOrNull(pre.last_modified) ?? nowIso,
    // Período informado por MP. Lo que MP no informa queda vacío, no inventado.
    current_period_start: isoOrNull(pre.date_created),
    current_period_end: isoOrNull(pre.next_payment_date),
    grace_until: null,
    // Suscripción nueva: todavía no hay un cobro registrado para ella.
    last_payment_id: null,
    last_payment_status: null,
    ...(options.source === 'webhook' ? { last_webhook_at: nowIso } : {}),
  }, nowIso)

  // 2. La sesión queda consumida.
  await ctx.store.updateCheckoutSession(session.id, { status: 'paid', mp_preapproval_id: pre.id, confirmed_at: nowIso }, nowIso)

  // 3. Auditoría.
  await ctx.store.recordEvent({
    business_id: business.id, event_type: 'billing_state_applied', external_id: pre.id, processed: true,
    raw_payload: {
      source: options.source, mp_status: mpState, session_id: session.id,
      from: { status: previousStatus, plan: business.subscription_plan },
      to: { status: 'active', plan: entry.plan, billing_cycle: entry.billingCycle },
      requested: { plan: session.plan_id, billing_cycle: session.billing_cycle },
      plan_mismatch: planMismatch,
    },
  })

  // 4. Otros checkouts abiertos del mismo negocio dejan de estar vigentes.
  const others = await ctx.store.listCheckoutSessions(business.id, 20)
  for (const other of others) {
    if (other.id !== session.id && other.status === 'pending') {
      await ctx.store.updateCheckoutSession(other.id, { status: 'expired' }, nowIso)
    }
  }

  // 5. Cambio de plan o reactivación: la suscripción anterior se cancela en MP
  //    DESPUÉS de confirmada la nueva (antes se cancelaba al abrir el checkout).
  //    Se intenta siempre que exista: una suscripción en mora sigue reintentando
  //    cobros en MP aunque acá figure suspendida.
  if (previousPreapproval && previousPreapproval !== pre.id) {
    await supersedePreapproval(ctx, business.id, previousPreapproval, pre.id)
  }

  return outcome(pre, mpState, {
    kind: 'activated', businessId: business.id, status: 'active', plan: entry.plan, sessionId: session.id, planMismatch,
  })
}

async function noteUnauthorized(
  ctx: BillingContext, session: CheckoutSessionRow, pre: MpPreapproval, mpState: PreapprovalState, nowIso: string,
): Promise<void> {
  if (session.status !== 'pending') return
  if (mpState === 'pending' && session.mp_preapproval_id !== pre.id) {
    await ctx.store.updateCheckoutSession(session.id, { mp_preapproval_id: pre.id }, nowIso)
  } else if (mpState === 'cancelled' && (session.mp_preapproval_id === null || session.mp_preapproval_id === pre.id)) {
    await ctx.store.updateCheckoutSession(session.id, { status: 'canceled', mp_preapproval_id: pre.id }, nowIso)
  }
}

/**
 * Cancela en MP la suscripción que quedó reemplazada. Si falla, la nueva ya está
 * activa: no se revierte, pero queda un evento SIN procesar para que alguien lo
 * vea — el negocio tendría dos suscripciones cobrando.
 */
async function supersedePreapproval(
  ctx: BillingContext, businessId: string, previousId: string, replacedBy: string,
): Promise<void> {
  let error: string | null = null
  try {
    const previous = await ctx.mp.getPreapproval(previousId)
    if (previous && preapprovalState(previous.status) !== 'cancelled') {
      await ctx.mp.cancelPreapproval(previousId)
    }
  } catch {
    error = 'supersede_cancel_failed'
    ctx.log({ event: 'supersede_cancel_failed', business_id: businessId, preapproval_id: previousId })
  }
  await ctx.store.recordEvent({
    business_id: businessId, event_type: 'preapproval_superseded', external_id: previousId,
    processed: error === null, error_message: error,
    raw_payload: { replaced_by: replacedBy },
  })
}
