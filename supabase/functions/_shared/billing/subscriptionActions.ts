/**
 * subscriptionActions — BETA-MP · acciones autenticadas de `mp-subscription`.
 *
 *   create                  abre un checkout. NO cambia el acceso del negocio.
 *   status                  lectura local (DB). No consulta ni sincroniza Mercado Pago.
 *   reconcile               consulta Mercado Pago y lleva la DB al estado confirmado.
 *   update_payment_method   link de MP para la suscripción DEL negocio autorizado.
 *   cancel                  cancela en MP la suscripción DEL negocio autorizado.
 *
 * Todas pasan por la MISMA autorización antes de leer o escribir nada:
 * `authorizer.canManageBilling(business_id)`, evaluada con el JWT del usuario.
 * No hay una verificación por handler que alguno pueda olvidarse.
 *
 * Del body sólo se usan `action`, `business_id`, `plan`, `billing_cycle` y
 * `back_url` (validado contra la allowlist). `payer_email`, ids de preapproval o
 * de plan que mande el navegador se ignoran: el email sale del JWT, los ids de
 * la base y de los secrets.
 */
import { MpApiError, isMercadoPagoUrl, preapprovalState } from './mpClient.ts'
import type { MpPlan, MpPreapproval } from './mpClient.ts'
import { CYCLE_MONTHS, isBillingCycle, isBillingPlan, planEnvKey } from './planCatalog.ts'
import type { BillingCycle, BillingPlan } from './planCatalog.ts'
import { applyPreapprovalEvidence, newCheckoutReference, parseCheckoutReference } from './preapproval.ts'
import type { BillingContext, EvidenceOutcome } from './preapproval.ts'
import { BillingStoreError } from './store.ts'
import type { BillingAuthorizer, BusinessBillingRow, CheckoutSessionRow } from './store.ts'

export const BILLING_ACTIONS = ['create', 'cancel', 'status', 'reconcile', 'update_payment_method'] as const
export type BillingAction = (typeof BILLING_ACTIONS)[number]

/** Un checkout abierto y sin pagar deja de considerarse vigente pasado este tiempo. */
export const CHECKOUT_SESSION_TTL_MS = 48 * 60 * 60 * 1000
const MAX_RECONCILE_SESSIONS = 3
const SEARCH_PAGE_SIZE = 50
const MAX_SEARCH_PAGES = 4
const PENDING_PATH = '/subscription/pending'
const DEFAULT_CHECKOUT_BASE = 'https://www.mercadopago.com.ar/subscriptions/checkout'

export interface ActionUser {
  id: string
  /** Email del JWT verificado. Es el único email de pagador que se usa. */
  email: string | null
}

export interface ActionRequest {
  user: ActionUser
  body: Record<string, unknown>
  /** `Origin` del request, ya normalizado. */
  origin: string | null
}

export interface ActionResponse {
  status: number
  body: Record<string, unknown>
}

export interface ActionContext extends BillingContext {
  authorizer: BillingAuthorizer
  newId: () => string
  /** Orígenes del frontend permitidos (los mismos de la allowlist de CORS). */
  allowedOrigins: readonly string[]
  /** Origen canónico del frontend para la URL de retorno por defecto. */
  appOrigin: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const fail = (status: number, code: string, error: string): ActionResponse => ({ status, body: { error, code } })

const PLAN_LABEL: Record<BillingPlan, string> = { basico: 'Básico', pro: 'Pro', full: 'Full' }

// ── Router ──────────────────────────────────────────────────────────────────

export async function handleBillingAction(ctx: ActionContext, req: ActionRequest): Promise<ActionResponse> {
  const action = req.body.action
  if (typeof action !== 'string' || !(BILLING_ACTIONS as readonly string[]).includes(action)) {
    return fail(400, 'unknown_action', 'Acción desconocida.')
  }
  const businessId = req.body.business_id
  if (typeof businessId !== 'string' || !UUID_RE.test(businessId)) {
    return fail(400, 'invalid_business', 'Falta el negocio.')
  }

  // ── Autorización uniforme: antes de cualquier lectura o escritura ─────────
  let allowed: boolean
  try {
    allowed = await ctx.authorizer.canManageBilling(businessId)
  } catch {
    ctx.log({ event: 'authorization_unavailable', action })
    return fail(503, 'authorization_unavailable', 'No pudimos verificar tus permisos. Probá de nuevo en unos minutos.')
  }
  if (!allowed) {
    ctx.log({ event: 'forbidden', action, user_id: req.user.id })
    return fail(403, 'forbidden', 'No tenés permiso para gestionar la suscripción de este negocio.')
  }

  try {
    switch (action as BillingAction) {
      case 'create':                return await createCheckout(ctx, req, businessId)
      case 'cancel':                return await cancelSubscription(ctx, req, businessId)
      case 'status':                return await readStatus(ctx, businessId)
      case 'reconcile':             return await reconcile(ctx, businessId)
      case 'update_payment_method': return await updatePaymentMethod(ctx, businessId)
    }
  } catch (error) {
    if (error instanceof MpApiError) {
      ctx.log({ event: 'mp_unavailable', action, operation: error.operation, status: error.status })
      return fail(502, 'mp_unavailable', 'No pudimos consultar a Mercado Pago. Probá de nuevo en unos minutos.')
    }
    if (error instanceof BillingStoreError) {
      ctx.log({ event: 'store_unavailable', action, operation: error.operation, code: error.code })
      return fail(503, 'billing_unavailable', 'No pudimos completar la operación. Probá de nuevo en unos minutos.')
    }
    throw error
  }
}

// ── create ──────────────────────────────────────────────────────────────────

async function createCheckout(ctx: ActionContext, req: ActionRequest, businessId: string): Promise<ActionResponse> {
  const { plan, billing_cycle: billingCycle } = req.body
  if (!isBillingPlan(plan) || !isBillingCycle(billingCycle)) {
    return fail(400, 'invalid_plan', 'El plan o el ciclo elegido no es válido.')
  }
  const payerEmail = req.user.email
  if (!payerEmail) return fail(400, 'no_email', 'Tu cuenta no tiene un email para asociar al pago.')

  const mpPlanId = ctx.catalog.mpPlanIdFor(plan, billingCycle)
  if (!mpPlanId) {
    // El nombre del secret queda en el log del servidor, no en la respuesta.
    ctx.log({ event: 'plan_not_configured', env_key: planEnvKey(plan, billingCycle) })
    return fail(503, 'plan_not_configured', 'Este plan todavía no está disponible para contratar. Escribinos desde Ayuda y lo resolvemos.')
  }

  const business = await ctx.store.getBusinessBilling(businessId)
  if (!business) return fail(404, 'business_not_found', 'No encontramos el negocio.')

  // El plan tiene que existir y estar vigente en Mercado Pago, con la frecuencia
  // del ciclo pedido. Un secret mal cableado se detecta antes de mandar al
  // usuario a un checkout equivocado.
  const mpPlan = await ctx.mp.getPlan(mpPlanId)
  const planProblem = describePlanProblem(mpPlan, billingCycle)
  if (!mpPlan || planProblem) {
    ctx.log({ event: 'plan_unavailable', env_key: planEnvKey(plan, billingCycle), problem: planProblem })
    return fail(503, 'plan_unavailable', 'Este plan no está disponible en Mercado Pago en este momento. Escribinos desde Ayuda y lo resolvemos.')
  }
  const amount = Number(mpPlan.auto_recurring?.transaction_amount)
  const currency = mpPlan.auto_recurring?.currency_id || 'ARS'

  const session = await openSession(ctx, {
    businessId, userId: req.user.id, plan, billingCycle, mpPlanId, payerEmail,
    amount: Number.isFinite(amount) && amount >= 0 ? amount : 0, currency,
  })
  const reference = parseCheckoutReference(session.external_reference)
  if (!reference) throw new BillingStoreError('sesión de checkout sin referencia válida', null)

  // La URL del checkout de plan es de Mercado Pago. Que respete estos
  // parámetros no está documentado: si no preserva `external_reference`, el
  // pago no se podrá vincular y NO activará nada (fail-closed). Ver el runbook.
  const planInitPoint = mpPlan.init_point
  const base = isMercadoPagoUrl(planInitPoint)
    && new URL(planInitPoint).searchParams.get('preapproval_plan_id') === mpPlanId
    ? planInitPoint
    : `${DEFAULT_CHECKOUT_BASE}?preapproval_plan_id=${encodeURIComponent(mpPlanId)}`
  const checkout = new URL(base)
  checkout.searchParams.set('external_reference', reference)
  checkout.searchParams.set('payer_email', payerEmail)
  checkout.searchParams.set('back_url', resolveBackUrl(ctx, req))
  const checkoutUrl = checkout.toString()

  ctx.log({ event: 'checkout_opened', business_id: businessId, session_id: session.id, plan, billing_cycle: billingCycle })

  // NADA de esto tocó `businesses`: el negocio conserva su estado y su plan
  // hasta que Mercado Pago confirme una suscripción.
  return {
    status: 200,
    body: {
      init_point: checkoutUrl,
      preapproval_id: null,
      checkout: { status: 'pending', plan, billing_cycle: billingCycle },
    },
  }
}

function describePlanProblem(mpPlan: MpPlan | null, billingCycle: BillingCycle): string | null {
  if (!mpPlan) return 'not_found'
  if (typeof mpPlan.status === 'string' && mpPlan.status.trim().toLowerCase() !== 'active') return 'inactive'
  const recurring = mpPlan.auto_recurring
  if (!recurring) return 'no_frequency'
  const frequencyType = typeof recurring.frequency_type === 'string' ? recurring.frequency_type.trim().toLowerCase() : ''
  if (frequencyType !== 'months' || Number(recurring.frequency) !== CYCLE_MONTHS[billingCycle]) return 'frequency_mismatch'
  return null
}

interface OpenSessionInput {
  businessId: string
  userId: string
  plan: BillingPlan
  billingCycle: BillingCycle
  mpPlanId: string
  payerEmail: string
  amount: number
  currency: string
}

/**
 * Una sesión `pending` por (negocio, plan, ciclo): pedir dos veces el mismo
 * checkout reutiliza la misma intención y la misma referencia.
 */
async function openSession(ctx: ActionContext, input: OpenSessionInput): Promise<CheckoutSessionRow> {
  const nowIso = ctx.now().toISOString()

  const findReusable = async (): Promise<CheckoutSessionRow | null> => {
    const sessions = await ctx.store.listCheckoutSessions(input.businessId, 20)
    const pending = sessions.find((s) => s.status === 'pending' && s.plan_id === input.plan && s.billing_cycle === input.billingCycle)
    if (!pending) return null
    const usable = isWithinTtl(pending, ctx.now())
      && pending.mp_preapproval_plan_id === input.mpPlanId
      && parseCheckoutReference(pending.external_reference) !== null
    if (usable) {
      await ctx.store.updateCheckoutSession(pending.id, { payer_email: input.payerEmail, amount: input.amount, currency: input.currency }, nowIso)
      return pending
    }
    // Vencida o emitida para otro plan de MP: no se reutiliza.
    await ctx.store.updateCheckoutSession(pending.id, { status: 'expired' }, nowIso)
    return null
  }

  const existing = await findReusable()
  if (existing) return existing

  const row = {
    business_id: input.businessId,
    user_id: input.userId,
    plan_id: input.plan,
    billing_cycle: input.billingCycle,
    amount: input.amount,
    currency: input.currency,
    external_reference: newCheckoutReference(ctx.newId()),
    mp_preapproval_plan_id: input.mpPlanId,
    payer_email: input.payerEmail,
  }
  try {
    return await ctx.store.insertCheckoutSession(row)
  } catch (error) {
    // Dos pedidos simultáneos: `idx_scs_pending_unique` deja pasar uno solo.
    if (error instanceof BillingStoreError && error.code === '23505') {
      const raced = await findReusable()
      if (raced) return raced
    }
    throw error
  }
}

function isWithinTtl(session: CheckoutSessionRow, now: Date): boolean {
  const created = new Date(session.created_at).getTime()
  return !Number.isNaN(created) && now.getTime() - created < CHECKOUT_SESSION_TTL_MS
}

/** La URL de retorno siempre apunta a `/subscription/pending` de un origen permitido. */
function resolveBackUrl(ctx: ActionContext, req: ActionRequest): string {
  const requested = req.body.back_url
  if (typeof requested === 'string') {
    try {
      const url = new URL(requested)
      if (ctx.allowedOrigins.includes(url.origin) && url.pathname === PENDING_PATH && !url.search && !url.hash) {
        return `${url.origin}${PENDING_PATH}`
      }
    } catch { /* URL inválida: se usa el default */ }
  }
  const origin = req.origin && ctx.allowedOrigins.includes(req.origin) ? req.origin : ctx.appOrigin
  return `${origin}${PENDING_PATH}`
}

// ── status ──────────────────────────────────────────────────────────────────

function checkoutSummary(session: CheckoutSessionRow | undefined, now: Date): Record<string, unknown> | null {
  if (!session) return null
  const status = session.status === 'pending' && !isWithinTtl(session, now) ? 'expired' : session.status
  return {
    status,
    plan: session.plan_id,
    billing_cycle: session.billing_cycle,
    created_at: session.created_at,
    confirmed_at: session.confirmed_at,
  }
}

function subscriptionSummary(business: BusinessBillingRow): Record<string, unknown> {
  return {
    subscription_status: business.subscription_status,
    subscription_plan: business.subscription_plan,
    access_source: business.access_source,
    has_mp_subscription: business.mp_preapproval_id !== null,
    current_period_start: business.current_period_start,
    current_period_end: business.current_period_end,
    grace_until: business.grace_until,
    last_payment_status: business.last_payment_status,
    trial_ends_at: business.trial_ends_at,
  }
}

/** Lectura local. `source: 'database'` deja explícito que no se consultó a Mercado Pago. */
async function readStatus(ctx: ActionContext, businessId: string): Promise<ActionResponse> {
  const business = await ctx.store.getBusinessBilling(businessId)
  if (!business) return fail(404, 'business_not_found', 'No encontramos el negocio.')
  const [latest] = await ctx.store.listCheckoutSessions(businessId, 1)
  return {
    status: 200,
    body: { source: 'database', ...subscriptionSummary(business), checkout: checkoutSummary(latest, ctx.now()) },
  }
}

// ── reconcile ───────────────────────────────────────────────────────────────

interface SessionSearch {
  candidates: MpPreapproval[]
  /** Quedaron suscripciones del plan sin revisar: «no encontrado» no es concluyente. */
  truncated: boolean
}

/**
 * Preapprovals de Mercado Pago que pertenecen a UNA sesión de checkout.
 *
 * `/preapproval/search` no filtra por `external_reference` (no es un filtro
 * documentado), así que se busca por el plan esperado y se exige, resultado por
 * resultado, la referencia EXACTA de la sesión y el mismo plan. El email del
 * pagador no se usa: no identifica a un negocio.
 */
async function findSessionPreapprovals(ctx: ActionContext, session: CheckoutSessionRow): Promise<SessionSearch> {
  const reference = parseCheckoutReference(session.external_reference)
  const mpPlanId = session.mp_preapproval_plan_id
  if (!reference || !mpPlanId) return { candidates: [], truncated: false }

  const matches = new Map<string, MpPreapproval>()
  const belongs = (pre: MpPreapproval | null): pre is MpPreapproval =>
    !!pre && typeof pre.id === 'string' && parseCheckoutReference(pre.external_reference) === reference

  if (session.mp_preapproval_id) {
    const direct = await ctx.mp.getPreapproval(session.mp_preapproval_id)
    if (belongs(direct)) matches.set(direct.id, direct)
  }

  const seen = new Set<string>()
  let offset = 0
  let exhausted = false
  for (let page = 0; page < MAX_SEARCH_PAGES && !exhausted; page++) {
    const { results, total } = await ctx.mp.searchPreapprovalsByPlan(mpPlanId, { offset, limit: SEARCH_PAGE_SIZE })
    let fresh = 0
    for (const result of results) {
      if (!result || typeof result.id !== 'string' || seen.has(result.id)) continue
      seen.add(result.id)
      fresh++
      if (belongs(result) && result.preapproval_plan_id === mpPlanId) matches.set(result.id, result)
    }
    offset += results.length
    // `fresh === 0`: página vacía o repetida (MP ignoró el offset).
    if (fresh === 0 || (total !== null ? offset >= total : results.length < SEARCH_PAGE_SIZE)) exhausted = true
  }

  return { candidates: [...matches.values()], truncated: !exhausted }
}

async function reconcile(ctx: ActionContext, businessId: string): Promise<ActionResponse> {
  const before = await ctx.store.getBusinessBilling(businessId)
  if (!before) return fail(404, 'business_not_found', 'No encontramos el negocio.')

  const outcomes: EvidenceOutcome[] = []
  let ambiguous = false
  let sawPending = false

  // 1. La suscripción ya vinculada al negocio.
  if (before.mp_preapproval_id) {
    const current = await ctx.mp.getPreapproval(before.mp_preapproval_id)
    if (current) outcomes.push(await applyPreapprovalEvidence(ctx, current, { source: 'reconcile', expectBusinessId: businessId }))
  }

  // 2. Checkouts abiertos todavía sin confirmar.
  const now = ctx.now()
  const open = (await ctx.store.listCheckoutSessions(businessId, 10))
    .filter((s) => s.status === 'pending' && isWithinTtl(s, now))
    .slice(0, MAX_RECONCILE_SESSIONS)

  for (const session of open) {
    const { candidates, truncated } = await findSessionPreapprovals(ctx, session)
    const authorized = candidates.filter((c) => preapprovalState(c.status) === 'authorized')
    if (candidates.some((c) => preapprovalState(c.status) === 'pending')) sawPending = true
    if (truncated) ctx.log({ event: 'reconcile_search_truncated', business_id: businessId, session_id: session.id })

    if (authorized.length > 1) {
      // Dos suscripciones autorizadas para el mismo checkout: no se elige una.
      ambiguous = true
      ctx.log({ event: 'reconcile_ambiguous', business_id: businessId, session_id: session.id, matches: authorized.length })
      continue
    }
    const target = authorized[0] ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (!target) continue

    // El índice de búsqueda puede estar atrasado: se aplica sólo el preapproval
    // releído, y sólo si sigue llevando la referencia de ESTA sesión.
    const verified = await ctx.mp.getPreapproval(target.id)
    if (!verified || parseCheckoutReference(verified.external_reference) !== session.external_reference) continue
    outcomes.push(await applyPreapprovalEvidence(ctx, verified, { source: 'reconcile', expectBusinessId: businessId }))
  }

  const after = (await ctx.store.getBusinessBilling(businessId)) ?? before
  const [latest] = await ctx.store.listCheckoutSessions(businessId, 1)

  const paidByMp = after.subscription_status === 'active'
    && after.access_source === 'mercado_pago' && after.mp_preapproval_id !== null
  const result = describeReconcile({ outcomes, ambiguous, sawPending, hadOpenCheckout: open.length > 0, after, paidByMp })

  return {
    status: 200,
    body: {
      // `activated` y `confirmed` sólo son true con una suscripción de MP activa.
      activated: paidByMp,
      confirmed: paidByMp,
      outcome: result.outcome,
      message: result.message,
      status: after.subscription_status,
      plan: after.subscription_plan,
      checkout: checkoutSummary(latest, ctx.now()),
    },
  }
}

interface ReconcileFacts {
  outcomes: EvidenceOutcome[]
  ambiguous: boolean
  sawPending: boolean
  hadOpenCheckout: boolean
  after: BusinessBillingRow
  paidByMp: boolean
}

function describeReconcile(facts: ReconcileFacts): { outcome: string; message: string } {
  const { outcomes, after } = facts
  const has = (reason: string) => outcomes.some((o) => o.reason === reason)
  const plan = after.subscription_plan ? PLAN_LABEL[after.subscription_plan] : null

  if (outcomes.some((o) => o.kind === 'activated')) {
    return { outcome: 'activated', message: `Mercado Pago confirmó tu suscripción${plan ? ` al plan ${plan}` : ''}.` }
  }
  if (facts.ambiguous) {
    return { outcome: 'ambiguous', message: 'Encontramos más de una suscripción para este pago y no podemos elegir una automáticamente. Escribinos desde Ayuda y lo resolvemos.' }
  }
  if (has('unknown_plan')) {
    return { outcome: 'unknown_plan', message: 'Mercado Pago informó un plan que no reconocemos, así que no activamos nada. Escribinos desde Ayuda y lo resolvemos.' }
  }
  if (has('awaiting_payment')) {
    return { outcome: 'payment_rejected', message: 'El último cobro fue rechazado. Actualizá tu medio de pago en Mercado Pago: cuando el cobro se apruebe, el acceso se restablece solo.' }
  }
  if (facts.paidByMp) {
    return { outcome: 'already_active', message: `Tu suscripción${plan ? ` al plan ${plan}` : ''} está activa.` }
  }
  if (after.mp_preapproval_id !== null && after.subscription_status === 'canceled') {
    return { outcome: 'cancelled', message: 'Mercado Pago informa que la suscripción está cancelada.' }
  }
  if (after.mp_preapproval_id !== null && after.subscription_status === 'past_due') {
    return { outcome: 'past_due', message: 'Mercado Pago informa un pago pendiente en tu suscripción.' }
  }
  if (facts.sawPending) {
    return { outcome: 'pending', message: 'Mercado Pago todavía no confirmó el pago. Mientras tanto tu acceso no cambia.' }
  }
  if (facts.hadOpenCheckout) {
    return { outcome: 'not_found', message: 'Todavía no encontramos un pago confirmado en Mercado Pago. Si ya pagaste, puede tardar unos minutos.' }
  }
  return { outcome: 'no_checkout', message: 'No hay ningún pago en curso para verificar.' }
}

// ── Pertenencia de un preapproval ───────────────────────────────────────────

/**
 * ¿El preapproval que devolvió Mercado Pago es del negocio autorizado?
 * El id sale de la fila del negocio (nunca del navegador). Con datos
 * suficientes en MP se contrasta además su `external_reference`.
 */
async function preapprovalBelongsTo(ctx: ActionContext, pre: MpPreapproval, business: BusinessBillingRow): Promise<boolean> {
  if (pre.id !== business.mp_preapproval_id) return false
  const raw = typeof pre.external_reference === 'string' ? pre.external_reference.trim() : ''
  const reference = parseCheckoutReference(raw)
  if (reference) {
    const session = await ctx.store.findCheckoutSessionByReference(reference)
    return !session || session.business_id === business.id
  }
  // Referencia con forma de id de negocio (formato anterior): tiene que ser este.
  if (UUID_RE.test(raw)) return raw.toLowerCase() === business.id.toLowerCase()
  return true
}

// ── update_payment_method ───────────────────────────────────────────────────

async function updatePaymentMethod(ctx: ActionContext, businessId: string): Promise<ActionResponse> {
  const business = await ctx.store.getBusinessBilling(businessId)
  if (!business) return fail(404, 'business_not_found', 'No encontramos el negocio.')
  if (!business.mp_preapproval_id) {
    return fail(409, 'no_subscription', 'Este negocio no tiene una suscripción de Mercado Pago. Elegí un plan para empezar.')
  }

  const pre = await ctx.mp.getPreapproval(business.mp_preapproval_id)
  if (!pre) return fail(409, 'subscription_not_found', 'Mercado Pago no encuentra la suscripción de este negocio. Escribinos desde Ayuda.')
  if (!(await preapprovalBelongsTo(ctx, pre, business))) {
    ctx.log({ event: 'preapproval_mismatch', action: 'update_payment_method', business_id: businessId })
    return fail(409, 'subscription_mismatch', 'No pudimos validar la suscripción de este negocio. Escribinos desde Ayuda.')
  }
  if (preapprovalState(pre.status) === 'cancelled') {
    return fail(409, 'subscription_cancelled', 'La suscripción está cancelada. Elegí un plan para reactivarla.')
  }
  if (!isMercadoPagoUrl(pre.init_point)) {
    return fail(502, 'no_update_link', 'Mercado Pago no devolvió un enlace para actualizar el medio de pago.')
  }
  return { status: 200, body: { init_point: pre.init_point } }
}

// ── cancel ──────────────────────────────────────────────────────────────────

async function cancelSubscription(ctx: ActionContext, req: ActionRequest, businessId: string): Promise<ActionResponse> {
  const business = await ctx.store.getBusinessBilling(businessId)
  if (!business) return fail(404, 'business_not_found', 'No encontramos el negocio.')
  if (!business.mp_preapproval_id) {
    return fail(409, 'no_subscription', 'Este negocio no tiene una suscripción de Mercado Pago para cancelar.')
  }

  let pre = await ctx.mp.getPreapproval(business.mp_preapproval_id)
  if (!pre) return fail(409, 'subscription_not_found', 'Mercado Pago no encuentra la suscripción de este negocio. Escribinos desde Ayuda.')
  if (!(await preapprovalBelongsTo(ctx, pre, business))) {
    ctx.log({ event: 'preapproval_mismatch', action: 'cancel', business_id: businessId })
    return fail(409, 'subscription_mismatch', 'No pudimos validar la suscripción de este negocio. Escribinos desde Ayuda.')
  }

  const alreadyCancelled = preapprovalState(pre.status) === 'cancelled'
  if (!alreadyCancelled) {
    await ctx.mp.cancelPreapproval(pre.id)
    // No se da por cancelada hasta que Mercado Pago lo confirme al releer.
    pre = await ctx.mp.getPreapproval(pre.id)
    if (!pre || preapprovalState(pre.status) !== 'cancelled') {
      ctx.log({ event: 'cancel_not_confirmed', business_id: businessId })
      return fail(502, 'cancel_not_confirmed', 'Mercado Pago no confirmó la cancelación. Probá de nuevo en unos minutos.')
    }
  }

  // Mismo camino que el webhook: si la notificación llega después, no cambia nada.
  const applied = await applyPreapprovalEvidence(ctx, pre, { source: 'cancel', expectBusinessId: businessId })

  await ctx.store.recordEvent({
    business_id: businessId, event_type: 'user_cancelled', external_id: pre.id, processed: true,
    raw_payload: { cancelled_by: req.user.id, already_cancelled: alreadyCancelled },
  })

  return {
    status: 200,
    body: { success: true, already_cancelled: alreadyCancelled, status: applied.status ?? business.subscription_status },
  }
}
