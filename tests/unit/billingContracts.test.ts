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
