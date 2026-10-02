/**
 * subscriptionActions — BETA-MP · acciones autenticadas de `mp-subscription`.
 *
 *   create                  crea el preapproval `pending` en Mercado Pago, lo vincula
 *                           a la sesión y devuelve SU checkout. NO cambia el acceso.
 *   status                  lectura local (DB). No consulta ni sincroniza Mercado Pago.
 *   reconcile               consulta Mercado Pago y lleva la DB al estado confirmado.
 *   update_payment_method   link de MP para la suscripción DEL negocio autorizado.
 *   cancel                  cancela en MP la suscripción DEL negocio autorizado.
 *
 * Todas pasan por la MISMA autorización antes de leer o escribir nada:
 * `authorizer.canManageBilling(business_id)`, evaluada con el JWT del usuario.
 * No hay una verificación por handler que alguno pueda olvidarse.
 *
 * Del body sólo se usan `action`, `business_id`, `plan`, `billing_cycle`,
 * `back_url` (validado contra la allowlist) y, sólo en `create`,
 * `mp_payer_email`. Importe, moneda, frecuencia, referencia, estados e ids de
 * preapproval que mande el navegador se ignoran: el precio sale del catálogo del
 * servidor y los ids de la base.
 *
 * `mp_payer_email` NO es autoridad. Mercado Pago exige un `payer_email` para
 * crear el preapproval y el email del login de TechRepair Pro no siempre es el de
 * una cuenta de Mercado Pago (medido en producción el 2026-10-02: 400 «User bad
 * request»). El primer intento usa el email del JWT; si Mercado Pago lo rechaza,
 * `create` responde `mp_payer_email_required` y el usuario indica el suyo. Ese
 * email se le manda a Mercado Pago y se anota en la sesión, y nada más: no
 * resuelve un negocio, no vincula un preapproval, no participa en `reconcile` ni
 * en el webhook. La identidad sigue siendo JWT → capacidad → sesión → id del
 * preapproval creado por el servidor.
 */
import { MpApiError, isPayerRejection, preapprovalCheckoutUrl, preapprovalState } from './mpClient.ts'
import type { MpPreapproval } from './mpClient.ts'
import { checkoutTermsProblem, isBillingCycle, isBillingPlan } from './planCatalog.ts'
import type { BillingCycle, BillingPlan, CheckoutTerms, ExpectedTerms, PlanCatalog } from './planCatalog.ts'
import {
  applyPreapprovalEvidence, newCheckoutReference, parseCheckoutReference, referenceConflicts, reportedReference,
} from './preapproval.ts'
import type { BillingContext, EvidenceOutcome } from './preapproval.ts'
import { BillingStoreError } from './store.ts'
import type { BillingAuthorizer, BusinessBillingRow, CheckoutSessionRow, CheckoutSessionStatus } from './store.ts'

export const BILLING_ACTIONS = ['create', 'cancel', 'status', 'reconcile', 'update_payment_method'] as const
export type BillingAction = (typeof BILLING_ACTIONS)[number]

/** Un checkout abierto y sin pagar deja de reutilizarse pasado este tiempo. */
export const CHECKOUT_SESSION_TTL_MS = 48 * 60 * 60 * 1000
/**
 * Margen para que el request que insertó la sesión termine de vincularle su
 * preapproval. Mientras dura, un segundo `create` del mismo plan no la pisa.
 */
export const CHECKOUT_LINK_GRACE_MS = 60 * 1000
const MAX_RECONCILE_SESSIONS = 5
const PENDING_PATH = '/subscription/pending'

export interface ActionUser {
  id: string
  /** Email del JWT verificado. Es el `payer_email` del primer intento de `create`. */
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
  /** Precio y frecuencia de cada plan/ciclo. Única fuente de lo que se cobra. */
  catalog: PlanCatalog
  newId: () => string
  /** Orígenes del frontend permitidos (los mismos de la allowlist de CORS). */
  allowedOrigins: readonly string[]
  /** Origen canónico del frontend para la URL de retorno por defecto. */
  appOrigin: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const fail = (status: number, code: string, error: string): ActionResponse => ({ status, body: { error, code } })

const PLAN_LABEL: Record<BillingPlan, string> = { basico: 'Básico', pro: 'Pro', full: 'Full' }
const CYCLE_LABEL: Record<BillingCycle, string> = { monthly: 'mensual', quarterly: 'trimestral', annual: 'anual' }

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
      // `detail` es el motivo de MP ya recortado y sin emails (ver mpClient).
      ctx.log({ event: 'mp_unavailable', action, operation: error.operation, status: error.status, detail: error.detail })
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

interface CheckoutIntent {
  businessId: string
  plan: BillingPlan
  billingCycle: BillingCycle
  payerEmail: string
  terms: CheckoutTerms
}

const IN_PROGRESS = () => fail(409, 'checkout_in_progress', 'Ya estamos preparando tu checkout. Probá de nuevo en unos segundos.')

// ── Email del pagador ───────────────────────────────────────────────────────

/** RFC 5321: 64 para la parte local, 254 para la dirección completa. */
const MAX_PAYER_EMAIL_LENGTH = 254
const MAX_PAYER_EMAIL_LOCAL_LENGTH = 64
// Deliberadamente simple: una sola `@`, sin espacios ni caracteres de control,
// dominio con al menos un punto. Si es de una cuenta real lo decide Mercado Pago.
const PAYER_EMAIL_RE = /^[^\s@\u0000-\u001f\u007f<>"]+@[^\s@\u0000-\u001f\u007f<>"]+\.[^\s@\u0000-\u001f\u007f<>".]{2,}$/

/**
 * `create` necesita el email de la cuenta de Mercado Pago de quien paga, y el del
 * login de TechRepair Pro no siempre lo es: en ese caso el usuario indica el suyo.
 */
const PAYER_EMAIL_REQUIRED = () => fail(422, 'mp_payer_email_required',
  'Mercado Pago no pudo iniciar la suscripción con el email de tu cuenta de TechRepair Pro. Ingresá el email asociado a tu cuenta de Mercado Pago.')

type PayerEmail =
  /** `explicit`: lo indicó el usuario. Si no, es el del JWT (primer intento). */
  | { ok: true; email: string; explicit: boolean }
  | { ok: false; response: ActionResponse }

/**
 * El `payer_email` que se le va a mandar a Mercado Pago. ÚNICO lugar donde se lee
 * `mp_payer_email` del body, y lo que devuelve sólo viaja a `POST /preapproval` y
 * a la columna `payer_email` de la sesión. Nunca decide nada sobre un negocio.
 */
function resolvePayerEmail(req: ActionRequest): PayerEmail {
  const raw = req.body.mp_payer_email
  if (raw === undefined || raw === null) {
    // Primer intento: el email del JWT. Sin email en el JWT no hay con qué intentar.
    return req.user.email
      ? { ok: true, email: req.user.email, explicit: false }
      : { ok: false, response: PAYER_EMAIL_REQUIRED() }
  }
  const invalid = (error: string): PayerEmail => ({ ok: false, response: fail(400, 'invalid_payer_email', error) })
  if (typeof raw !== 'string') return invalid('El email de Mercado Pago no es válido.')
  const email = raw.trim().toLowerCase()
  if (email === '') return invalid('Ingresá el email de tu cuenta de Mercado Pago.')
  if (email.length > MAX_PAYER_EMAIL_LENGTH || email.indexOf('@') > MAX_PAYER_EMAIL_LOCAL_LENGTH || !PAYER_EMAIL_RE.test(email)) {
    return invalid('El email de Mercado Pago no tiene un formato válido. Revisalo e intentá de nuevo.')
  }
  return { ok: true, email, explicit: true }
}

async function createCheckout(ctx: ActionContext, req: ActionRequest, businessId: string): Promise<ActionResponse> {
  const { plan, billing_cycle: billingCycle } = req.body
  if (!isBillingPlan(plan) || !isBillingCycle(billingCycle)) {
    return fail(400, 'invalid_plan', 'El plan o el ciclo elegido no es válido.')
  }
  const payer = resolvePayerEmail(req)
  if (!payer.ok) return payer.response
  const payerEmail = payer.email

  // Importe, moneda y frecuencia: del catálogo del servidor, para el plan y el
  // ciclo validados. El navegador no aporta ninguno de los tres.
  const terms = ctx.catalog.termsFor(plan, billingCycle)
  if (!terms) {
    ctx.log({ event: 'plan_not_configured', plan, billing_cycle: billingCycle })
    return fail(503, 'plan_not_configured', 'Este plan todavía no está disponible para contratar. Escribinos desde Ayuda y lo resolvemos.')
  }

  const business = await ctx.store.getBusinessBilling(businessId)
  if (!business) return fail(404, 'business_not_found', 'No encontramos el negocio.')

  const intent: CheckoutIntent = { businessId, plan, billingCycle, payerEmail, terms }
  const summary = { status: 'pending', plan, billing_cycle: billingCycle }

  // 1. ¿Ya hay un checkout abierto para este plan y ciclo?
  const open = await findOpenCheckout(ctx, intent)
  if (open.kind === 'in_progress') return IN_PROGRESS()
  if (open.kind === 'already_paid') {
    // Abrir otro checkout cobraría dos veces. La activación no ocurre acá: la
    // hacen el webhook y `reconcile`, por el camino canónico.
    return fail(409, 'checkout_already_paid', 'Mercado Pago ya registró el pago de este plan. Tocá «Verificar pago» en Mi Suscripción para activarlo.')
  }
  if (open.kind === 'reuse') {
    ctx.log({ event: 'checkout_reused', business_id: businessId, session_id: open.session.id, plan, billing_cycle: billingCycle })
    return { status: 200, body: { init_point: open.checkoutUrl, checkout: summary } }
  }

  // 2. La intención, con una referencia que genera el servidor.
  let session: CheckoutSessionRow
  try {
    session = await ctx.store.insertCheckoutSession({
      business_id: businessId,
      user_id: req.user.id,
      plan_id: plan,
      billing_cycle: billingCycle,
      amount: terms.amount,
      currency: terms.currency,
      external_reference: newCheckoutReference(ctx.newId()),
      payer_email: payerEmail,
    })
  } catch (error) {
    // Dos pedidos simultáneos: `idx_scs_pending_unique` deja pasar uno solo.
    if (error instanceof BillingStoreError && error.code === '23505') return IN_PROGRESS()
    throw error
  }
  const reference = parseCheckoutReference(session.external_reference)
  if (!reference) throw new BillingStoreError('sesión de checkout sin referencia válida', null)

  // 3. El preapproval `pending` en Mercado Pago, creado por el servidor.
  let created: MpPreapproval
  try {
    created = await ctx.mp.createPendingPreapproval({
      reason: `TechRepair Pro - Plan ${PLAN_LABEL[plan]} (${CYCLE_LABEL[billingCycle]})`,
      externalReference: reference,
      payerEmail,
      backUrl: resolveBackUrl(ctx, req),
      frequency: terms.frequency,
      frequencyType: terms.frequencyType,
      amount: terms.amount,
      currency: terms.currency,
    })
  } catch (error) {
    await closeSession(ctx, session.id, 'failed')
    if (isPayerRejection(error)) {
      // Mercado Pago no creó nada: no hay checkout ni preapproval que vincular.
      // Al log va el motivo de MP (sin emails), nunca el email que se intentó.
      ctx.log({
        event: 'payer_email_rejected', business_id: businessId, session_id: session.id,
        explicit: payer.explicit, detail: error.detail,
      })
      return payer.explicit
        ? fail(422, 'mp_payer_email_rejected', 'Mercado Pago tampoco pudo iniciar la suscripción con ese email. Revisá que sea el de tu cuenta de Mercado Pago o escribinos desde Ayuda.')
        : PAYER_EMAIL_REQUIRED()
    }
    throw error
  }

  const expected: ExpectedTerms = { billingCycle, amount: terms.amount, currency: terms.currency }
  const problem = checkoutProblem(created, reference, expected)
  const checkoutUrl = problem ? null : preapprovalCheckoutUrl(created)
  if (!checkoutUrl) {
    ctx.log({ event: 'preapproval_rejected', business_id: businessId, session_id: session.id, problem: problem ?? 'no_init_point' })
    await discardUnlinkedPreapproval(ctx, created, reference)
    await closeSession(ctx, session.id, 'failed')
    return fail(502, 'checkout_unavailable', 'Mercado Pago no devolvió un checkout válido. Probá de nuevo en unos minutos.')
  }

  // 4. El vínculo sesión ↔ preapproval queda escrito ANTES de responder. Sin él
  //    ese preapproval no podría activar nada, así que tampoco se entrega su checkout.
  try {
    await ctx.store.updateCheckoutSession(session.id, { mp_preapproval_id: created.id }, ctx.now().toISOString())
  } catch (error) {
    await discardUnlinkedPreapproval(ctx, created, reference)
    await closeSession(ctx, session.id, 'failed')
    throw error
  }

  ctx.log({
    event: 'checkout_opened', business_id: businessId, session_id: session.id, preapproval_id: created.id,
    plan, billing_cycle: billingCycle,
  })

  // NADA de esto tocó `businesses`: el negocio conserva su estado y su plan
  // hasta que Mercado Pago confirme la suscripción.
  return { status: 200, body: { init_point: checkoutUrl, checkout: summary } }
}

/**
 * ¿El preapproval que devolvió Mercado Pago sirve para abrir el checkout de ESTA
 * intención? Tiene que estar `pending`, llevar la referencia de la sesión (si
 * devuelve alguna), cobrar lo que pidió el servidor y traer un `init_point` propio.
 */
function checkoutProblem(pre: MpPreapproval | null, reference: string, expected: ExpectedTerms): string | null {
  if (!pre || typeof pre.id !== 'string' || pre.id.trim() === '') return 'no_id'
  if (preapprovalState(pre.status) !== 'pending') return 'not_pending'
  const reported = reportedReference(pre)
  if (reported !== '' && reported !== reference) return 'reference_mismatch'
  const terms = checkoutTermsProblem(expected, pre.auto_recurring)
  if (terms) return terms
  if (!preapprovalCheckoutUrl(pre)) return 'no_init_point'
  return null
}

type OpenCheckout =
  | { kind: 'none' }
  | { kind: 'reuse'; session: CheckoutSessionRow; checkoutUrl: string }
  | { kind: 'in_progress' }
  | { kind: 'already_paid' }

/**
 * Una sesión `pending` por (negocio, plan, ciclo): pedir dos veces el mismo
 * checkout devuelve el MISMO preapproval. Una sesión que ya no sirve (vencida,
 * de otro precio o pagador, o cuyo preapproval Mercado Pago ya no tiene
 * pendiente) deja de estar `pending` para que se pueda emitir otra.
 */
async function findOpenCheckout(ctx: ActionContext, intent: CheckoutIntent): Promise<OpenCheckout> {
  const sessions = await ctx.store.listCheckoutSessions(intent.businessId, 20)
  const pending = sessions.find((s) => s.status === 'pending' && s.plan_id === intent.plan && s.billing_cycle === intent.billingCycle)
  if (!pending) return { kind: 'none' }
  const now = ctx.now()
  const nowIso = now.toISOString()

  if (!pending.mp_preapproval_id) {
    // Insertada y todavía sin preapproval: otro request la está completando, o
    // se cortó a mitad de camino (y entonces nadie recibió un checkout).
    if (sessionAgeMs(pending, now) < CHECKOUT_LINK_GRACE_MS) return { kind: 'in_progress' }
    await ctx.store.updateCheckoutSession(pending.id, { status: 'expired' }, nowIso)
    return { kind: 'none' }
  }

  const reference = parseCheckoutReference(pending.external_reference)
  const pre = await ctx.mp.getPreapproval(pending.mp_preapproval_id)
  const state = pre ? preapprovalState(pre.status) : 'unknown'

  if (pre && state === 'authorized' && !referenceConflicts(pre, pending)) return { kind: 'already_paid' }

  const sameIntent = reference !== null && isWithinTtl(pending, now) && pending.payer_email === intent.payerEmail
  if (sameIntent && pre) {
    // Se revalida contra el catálogo de HOY: si el precio cambió, el preapproval
    // abierto con el precio anterior ya no es el checkout de esta intención.
    const expected: ExpectedTerms = { billingCycle: intent.billingCycle, amount: intent.terms.amount, currency: intent.terms.currency }
    const checkoutUrl = checkoutProblem(pre, reference, expected) === null ? preapprovalCheckoutUrl(pre) : null
    if (checkoutUrl) return { kind: 'reuse', session: pending, checkoutUrl }
  }

  const closed: CheckoutSessionStatus = state === 'cancelled' ? 'canceled' : 'expired'
  await ctx.store.updateCheckoutSession(pending.id, { status: closed }, nowIso)
  return { kind: 'none' }
}

/** Cierra una sesión que no llegó a abrir un checkout. No tapa el error original si falla. */
async function closeSession(ctx: ActionContext, sessionId: string, status: CheckoutSessionStatus): Promise<void> {
  try {
    await ctx.store.updateCheckoutSession(sessionId, { status }, ctx.now().toISOString())
  } catch {
    ctx.log({ event: 'checkout_session_not_closed', session_id: sessionId })
  }
}

/**
 * Un preapproval recién creado que no quedó vinculado a su sesión no puede
 * activar nada: se cancela para que tampoco se pueda pagar.
 *
 * Sólo se cancela el que creó ESTE request — nunca la suscripción vigente del
 * negocio ni el preapproval de otro checkout. Si Mercado Pago lo devolvió con
 * otra referencia, o si su id ya pertenece a otra sesión, no es nuestro y se
 * deja como está.
 */
async function discardUnlinkedPreapproval(ctx: ActionContext, created: MpPreapproval | null, reference: string): Promise<void> {
  const createdId = typeof created?.id === 'string' ? created.id.trim() : ''
  if (!created || !createdId) return
  const reported = reportedReference(created)
  if (reported !== '' && reported !== reference) return
  try {
    if (await ctx.store.findCheckoutSessionByPreapprovalId(createdId)) return
    await ctx.mp.cancelPreapproval(createdId)
  } catch {
    ctx.log({ event: 'unlinked_preapproval_not_cancelled', preapproval_id: createdId })
  }
}

function sessionAgeMs(session: CheckoutSessionRow, now: Date): number {
  const created = new Date(session.created_at).getTime()
  return Number.isNaN(created) ? Number.POSITIVE_INFINITY : now.getTime() - created
}

function isWithinTtl(session: CheckoutSessionRow, now: Date): boolean {
  return sessionAgeMs(session, now) < CHECKOUT_SESSION_TTL_MS
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

/**
 * Lleva la base al estado que confirma Mercado Pago, sin depender del webhook.
 *
 * Cada preapproval se relee POR ID: el del negocio y el que `create` guardó en
 * cada sesión todavía sin activar. No se busca nada por plan, email, importe ni
 * fecha: un checkout cuyo preapproval el servidor no conoce no se puede
 * reconciliar, y eso es deliberado.
 */
async function reconcile(ctx: ActionContext, businessId: string): Promise<ActionResponse> {
  const before = await ctx.store.getBusinessBilling(businessId)
  if (!before) return fail(404, 'business_not_found', 'No encontramos el negocio.')

  const outcomes: EvidenceOutcome[] = []
  let sawPending = false
  let openMismatch = false

  // 1. La suscripción ya vinculada al negocio.
  if (before.mp_preapproval_id) {
    const current = await ctx.mp.getPreapproval(before.mp_preapproval_id)
    if (current) outcomes.push(await applyPreapprovalEvidence(ctx, current, { source: 'reconcile', expectBusinessId: businessId }))
  }

  // 2. Checkouts de ESTE negocio que todavía no activaron. Una sesión vencida
  //    también cuenta: si se pagó, el pago es real. De la más vieja a la más
  //    nueva, para que la última intención sea la que quede vigente.
  const now = ctx.now()
  const sessions = await ctx.store.listCheckoutSessions(businessId, 10)
  const unsettled = sessions
    .filter((s) => (s.status === 'pending' || s.status === 'expired')
      && s.mp_preapproval_id !== null && s.mp_preapproval_id !== before.mp_preapproval_id)
    .slice(0, MAX_RECONCILE_SESSIONS)
    .reverse()

  for (const session of unsettled) {
    const pre = await ctx.mp.getPreapproval(session.mp_preapproval_id as string)
    // Mercado Pago tiene que devolver ESE preapproval. Que sea de esta sesión y de
    // este negocio lo vuelve a comprobar el camino canónico antes de escribir.
    if (!pre || pre.id !== session.mp_preapproval_id) continue
    if (session.status === 'pending' && preapprovalState(pre.status) === 'pending') sawPending = true
    const applied = await applyPreapprovalEvidence(ctx, pre, { source: 'reconcile', expectBusinessId: businessId })
    outcomes.push(applied)
    // Sólo cuenta para el mensaje si es un checkout todavía abierto: el de una
    // sesión vencida queda en el log y en la auditoría, no en cada verificación.
    if (session.status === 'pending' && (applied.reason === 'terms_mismatch' || applied.reason === 'reference_mismatch')) {
      openMismatch = true
    }
  }

  const after = (await ctx.store.getBusinessBilling(businessId)) ?? before
  const [latest] = await ctx.store.listCheckoutSessions(businessId, 1)
  const hadOpenCheckout = sessions.some((s) => s.status === 'pending' && isWithinTtl(s, now))

  const paidByMp = after.subscription_status === 'active'
    && after.access_source === 'mercado_pago' && after.mp_preapproval_id !== null
  const result = describeReconcile({ outcomes, sawPending, openMismatch, hadOpenCheckout, after, paidByMp })

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
  sawPending: boolean
  /** Un checkout todavía abierto cuyo preapproval no coincide con lo que registró el servidor. */
  openMismatch: boolean
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
  if (facts.openMismatch) {
    return { outcome: 'mismatch', message: 'Mercado Pago informó datos que no coinciden con tu checkout, así que no activamos nada. Escribinos desde Ayuda y lo resolvemos.' }
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
 * El id sale de la fila del negocio (nunca del navegador). Además: la sesión
 * que originó ese preapproval tiene que ser de este negocio, y lo que informe
 * Mercado Pago no puede contradecirla.
 */
async function preapprovalBelongsTo(ctx: ActionContext, pre: MpPreapproval, business: BusinessBillingRow): Promise<boolean> {
  if (pre.id !== business.mp_preapproval_id) return false
  const origin = await ctx.store.findCheckoutSessionByPreapprovalId(pre.id)
  if (origin) return origin.business_id === business.id && !referenceConflicts(pre, origin)

  // Suscripción vinculada sin sesión de origen: se contrasta lo que informe MP.
  const raw = reportedReference(pre)
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
  const link = preapprovalCheckoutUrl(pre)
  if (!link) {
    return fail(502, 'no_update_link', 'Mercado Pago no devolvió un enlace para actualizar el medio de pago.')
  }
  return { status: 200, body: { init_point: link } }
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
