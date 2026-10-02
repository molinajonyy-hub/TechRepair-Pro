/**
 * Source-level contract guards for the billing hardening. The webhook runs in
 * Deno and the security objects live in SQL, so these assert on source text
 * (same approach as whatsappEmbeddedSignupDisabled.test.ts).
 *
 * BETA-MP: the webhook rules moved out of `mp-webhook/index.ts` into
 * `supabase/functions/_shared/billing/`. `index.ts` keeps the signature check and
 * the wiring; the claim, the ledger upsert and the out-of-order guard are read
 * from the shared modules. Behaviour is covered by tests/components/betaMp/.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CREATE_PREAPPROVAL_OPERATION, MpApiError, isPayerRejection } from '../../supabase/functions/_shared/billing/mpClient.ts'
import { PLAN_PRICES, buildPlanCatalog } from '../../supabase/functions/_shared/billing/planCatalog.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const webhook    = read('../../supabase/functions/mp-webhook/index.ts')
const webhookLib = read('../../supabase/functions/_shared/billing/webhook.ts')
const store      = read('../../supabase/functions/_shared/billing/store.ts')
const canonical  = read('../../supabase/functions/_shared/billing/preapproval.ts')
const actions    = read('../../supabase/functions/_shared/billing/subscriptionActions.ts')
const mpClient   = read('../../supabase/functions/_shared/billing/mpClient.ts')
const service    = read('../../src/services/subscriptionService.ts')
const types      = read('../../src/types/subscription.ts')
const plansPage  = read('../../src/pages/Plans.tsx')
// NOTE: estas migraciones se archivaron a migrations/_legacy/ en el baseline
// (Fase 0). El CLI las ignora; siguen siendo evidencia y se leen desde ahí.
const trigger   = read('../../supabase/migrations/_legacy/20260623140000_billing_stageD_protect_trigger.sql')
const adminRpc  = read('../../supabase/migrations/_legacy/20260623121000_billing_stageC_admin_rpcs.sql')
const entRpc    = read('../../supabase/migrations/_legacy/20260623101000_billing_stageA_entitlements_rpc.sql')
const platform  = read('../../supabase/migrations/_legacy/20260623120000_billing_stageC_admin_roles_audit.sql')

// ── Webhook: reliability + mandatory signature + idempotency ────────────────
test('webhook AWAIT-ea el procesamiento (sin fire-and-forget)', () => {
  assert.match(webhook, /await processWebhookNotification\(/)
  assert.doesNotMatch(webhook, /aceptando sin validar firma/, 'no debe aceptar sin firma')
})

test('webhook exige firma: missing_secret→500, inválida→401', () => {
  assert.match(webhook, /missing_secret/)
  assert.match(webhook, /status:\s*500/)
  assert.match(webhook, /status:\s*401/)
})

test('webhook usa claim idempotente (unique 23505 + upsert onConflict)', () => {
  assert.match(webhookLib, /ctx\.store\.claimEvent\(/)
  assert.match(store, /23505/)
  assert.match(store, /onConflict:\s*'provider,external_payment_id'/)
})

test('webhook tolera eventos fuera de orden (isStale)', () => {
  assert.match(canonical, /isStale\(/)
})

// ── Plan B: el precio que se cobra es el que se muestra ─────────────────────
// El servidor crea el preapproval con `PLAN_PRICES`; Planes muestra `PLANS`. Son
// dos tablas (Deno y Vite no comparten módulos): si difieren, el cliente ve un
// precio y Mercado Pago cobra otro. Este contrato es la guarda contra ese drift.
test('PLAN_PRICES (servidor) coincide con PLANS (pantalla de Planes), mensual y anual', () => {
  const precioEnPantalla = (plan: string, ciclo: 'monthly' | 'annual'): number => {
    const bloque = types.slice(types.indexOf(`id: '${plan}'`))
    const match = bloque.match(new RegExp(`price_${ciclo}:\\s*([\\d_]+)`))
    assert.ok(match, `PLANS no tiene price_${ciclo} para ${plan}`)
    return Number(match[1].replaceAll('_', ''))
  }
  assert.deepEqual(Object.keys(PLAN_PRICES).sort(), ['basico', 'full', 'pro'])
  for (const plan of ['basico', 'pro', 'full'] as const) {
    for (const ciclo of ['monthly', 'annual'] as const) {
      assert.equal(PLAN_PRICES[plan][ciclo], precioEnPantalla(plan, ciclo), `${plan}/${ciclo}: el servidor cobra otro importe que el que muestra Planes`)
    }
  }
})

test('el servidor no vende un ciclo que Planes no ofrece (trimestral sin precio)', () => {
  for (const plan of ['basico', 'pro', 'full'] as const) {
    assert.equal(PLAN_PRICES[plan].quarterly, undefined)
    assert.equal(buildPlanCatalog().termsFor(plan, 'quarterly'), null)
  }
  assert.match(plansPage, /type Cycle = 'monthly' \| 'annual'/)
})

test('create no lee importe, moneda, frecuencia ni referencia del body', () => {
  assert.doesNotMatch(actions, /req\.body\.(amount|price|transaction_amount|currency|currency_id|frequency|frequency_type|auto_recurring|external_reference|reason)\b/)
  assert.match(actions, /const terms = ctx\.catalog\.termsFor\(plan, billingCycle\)/)
})

test('Mercado Pago se lee por id: no hay endpoints de búsqueda ni planes del panel', () => {
  assert.doesNotMatch(mpClient, /preapproval\/search|preapproval_plan\/|searchPreapprovals/)
  assert.doesNotMatch(actions + canonical + webhookLib, /MP_PLAN_|byMpPlanId|mpPlanIdFor/)
})

// ── El email del pagador no es autoridad ────────────────────────────────────
// Evidencia real (2026-10-02): `POST /preapproval` con el email del login dio
// 400 «User bad request»; con el email real de una cuenta de Mercado Pago, 201.
// El usuario puede indicar ese email, y es SÓLO un parámetro de ese POST.
const sinComentarios = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

test('`mp_payer_email` se lee en un solo lugar, y sólo `create` lo usa', () => {
  const code = sinComentarios(actions)
  assert.equal((code.match(/req\.body\.mp_payer_email/g) ?? []).length, 1)
  assert.match(code, /function resolvePayerEmail\(req: ActionRequest\): PayerEmail \{\s*const raw = req\.body\.mp_payer_email\n/)
  // Sin el campo, el primer intento es con el email del JWT.
  assert.match(code, /if \(raw === undefined \|\| raw === null\) \{\s*return req\.user\.email\s*\? \{ ok: true, email: req\.user\.email, explicit: false \}/)
  for (const fn of ['async function reconcile', 'async function cancelSubscription', 'async function updatePaymentMethod', 'async function readStatus']) {
    const start = code.indexOf(fn)
    assert.ok(start > 0, `falta ${fn}`)
    const body = code.slice(start, code.indexOf('\n}\n', start))
    assert.doesNotMatch(body, /payer|e-?mail/i, `${fn} usa un email`)
  }
})

test('ni el camino canónico, ni el webhook, ni el store resuelven nada por email', () => {
  // Lo único que el camino canónico hace con un email es anotar el que informa MP.
  const bitacora = /if \(typeof pre\.payer_email === 'string' && pre\.payer_email\) patch\.mp_payer_email = pre\.payer_email|mp_payer_email: typeof pre\.payer_email === 'string' && pre\.payer_email \? pre\.payer_email : null,/g
  assert.doesNotMatch(sinComentarios(canonical).replace(bitacora, ''), /payer|e-?mail/i)
  assert.doesNotMatch(sinComentarios(webhookLib), /payer|e-?mail/i)
  assert.doesNotMatch(store, /\.(eq|ilike|like|in|contains)\('(payer_email|mp_payer_email)'/)
  // En el cliente de Mercado Pago el email aparece una sola vez: en el cuerpo del POST.
  const mp = sinComentarios(mpClient)
  assert.doesNotMatch(mp, /payer_email=|\/search/)
  assert.deepEqual(mp.match(/payer_email: [^\n]+/g), ['payer_email: input.payerEmail,'])
})

test('sólo el rechazo medido del pagador pide otro email (lista cerrada)', () => {
  const rejected = (operation: string, status: number, detail: string | null) => isPayerRejection(new MpApiError(operation, status, detail))
  assert.equal(CREATE_PREAPPROVAL_OPERATION, 'POST preapproval')
  assert.equal(rejected('POST preapproval', 400, 'User bad request'), true)
  assert.equal(rejected('POST preapproval', 400, 'Invalid value for payer_email'), true)
  assert.equal(rejected('POST preapproval', 400, 'Invalid value for back_url'), false)
  assert.equal(rejected('POST preapproval', 400, null), false)
  assert.equal(rejected('POST preapproval', 500, 'User bad request'), false)
  assert.equal(rejected('GET preapproval', 400, 'User bad request'), false)
  assert.equal(isPayerRejection(new Error('User bad request')), false)
})

test('Planes pide el email sólo por el código del servidor, sin precargar el del login ni guardarlo', () => {
  const plans = sinComentarios(plansPage)
  const dialog = sinComentarios(read('../../src/components/subscription/MercadoPagoEmailDialog.tsx'))
  assert.match(plans, /subscriptionErrorCode\(e\) === MP_PAYER_EMAIL_REQUIRED/)
  assert.match(service, /export const MP_PAYER_EMAIL_REQUIRED = 'mp_payer_email_required'/)
  assert.match(sinComentarios(actions), /fail\(422, 'mp_payer_email_required',/)
  assert.doesNotMatch(plans + dialog, /localStorage|sessionStorage|document\.cookie/)
  assert.doesNotMatch(plans + dialog, /user\??\.email/)
  assert.match(dialog, /label="Email de tu cuenta de Mercado Pago"/)
  assert.match(dialog, /title="Necesitamos un dato de Mercado Pago"/)
})

// ── Frontend: no direct writes to subscription columns ──────────────────────
test('subscriptionService NO escribe subscription_status directo (usa RPCs)', () => {
  assert.doesNotMatch(service, /subscription_status:\s*'active'/, 'no debe activar por UPDATE directo')
  assert.doesNotMatch(service, /subscription_status:\s*'suspended'/, 'no debe suspender por UPDATE directo')
  assert.match(service, /rpc\('admin_activate_subscription'/)
  assert.match(service, /rpc\('admin_change_subscription_plan'/)
  assert.match(service, /rpc\('admin_suspend_subscription'/)
})

// ── Stage D trigger: blocks client roles only ───────────────────────────────
test('trigger protector bloquea authenticated/anon y permite backend', () => {
  assert.match(trigger, /'authenticated'/)
  assert.match(trigger, /'anon'/)
  assert.match(trigger, /RAISE EXCEPTION/)
  assert.match(trigger, /BEFORE UPDATE ON public\.businesses/)
})

// ── Stage C: admin RPCs require platform-admin + reason + audit ─────────────
test('RPCs admin exigen platform-admin, motivo y auditan', () => {
  assert.match(adminRpc, /_require_platform_admin\(/)
  assert.match(adminRpc, /_require_reason\(/)
  assert.match(adminRpc, /subscription_admin_actions/)
  assert.match(adminRpc, /auth\.uid\(\)/)
  // never trusts an actor passed by the client
  assert.doesNotMatch(adminRpc, /p_actor_user_id/)
})

test('system_admins: roles + sin escritura para anon/authenticated', () => {
  assert.match(platform, /REVOKE INSERT, UPDATE, DELETE ON public\.system_admins FROM anon, authenticated/)
  assert.match(platform, /CHECK \(role IN \('super_admin','billing_admin','support_readonly'\)\)/)
  // reuses the existing allowlist, does not create a parallel table
  assert.doesNotMatch(platform, /CREATE TABLE[^;]*platform_admins/)
})

// ── Stage A: entitlements RPC fixed (personal_finance + search_path) ────────
test('RPC de entitlements incluye personal_finance y search_path seguro', () => {
  assert.match(entRpc, /'personal_finance'/)
  assert.match(entRpc, /SET search_path = public, pg_temp/)
})
