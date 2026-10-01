#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP — Billing SaaS contra el stack Supabase LOCAL.
//
// Los tests de vitest corren el código de las Edge Functions sobre una base en
// memoria. Esta matriz corre EL MISMO código (`supabase/functions/_shared/billing`)
// sobre lo que esos tests no pueden probar:
//
//   · PostgREST real + supabase-js real, con el rol `service_role` y sus GRANT
//     reales (columna por columna) y los índices únicos de la migración;
//   · la autoridad real: `current_user_can_in_business(..., 'subscription')`
//     evaluada por la base con un JWT de usuario firmado;
//   · el navegador (`authenticated`) contra `subscription_checkout_sessions`.
//
// Mercado Pago sigue SIMULADO (tests/components/betaMp/fakeMercadoPago.ts): esto
// certifica la mitad nuestra del contrato, no la de Mercado Pago.
//
// Requiere la migración 20261012120000 aplicada y Node >= 22.18 (importa los
// módulos .ts tal cual). Deja la base como la encontró.
//
//   node scripts/billing/beta-mp-local.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { createMpClient } from '../../supabase/functions/_shared/billing/mpClient.ts'
import { buildPlanCatalog } from '../../supabase/functions/_shared/billing/planCatalog.ts'
import { createCapabilityAuthorizer, createSupabaseBillingStore } from '../../supabase/functions/_shared/billing/store.ts'
import { BILLING_ACTIONS, handleBillingAction } from '../../supabase/functions/_shared/billing/subscriptionActions.ts'
import { parseNotification, processWebhookNotification } from '../../supabase/functions/_shared/billing/webhook.ts'
import { FAKE_MP_TOKEN, FakeMercadoPago, PLAN_ENV, TEST_PLANS } from '../../tests/components/betaMp/fakeMercadoPago.ts'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')
const dbContainer = process.env.BETA_MP_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base LOCAL (supabase_db_*)')

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
const sql = (q) => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], q).trim()

const ids = Object.fromEntries(['A', 'B', 'C', 'ownerA', 'ownerB', 'ownerC', 'techA'].map((n) => [n, randomUUID()]))
const TAG = 'beta-mp-local.invalid'
const ORIGIN = 'https://www.techrepairpro.app'
const run = randomUUID().slice(0, 8)

let seeded = false, checks = 0
const check = (cond, label) => { checks++; assert(cond, label); console.log(`  ✓ ${label}`) }
const section = (title) => console.log(`\n--- ${title} ---`)

const main = async () => {
  const rest = JSON.parse(docker(['inspect', dbContainer.replace('supabase_db_', 'supabase_rest_')]))[0]
  const kong = JSON.parse(docker(['inspect', dbContainer.replace('supabase_db_', 'supabase_kong_')]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuracion de PostgREST local (¿kong sin puerto publicado?)')
  const baseUrl = `http://127.0.0.1:${hostPort}`
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl), 'El destino no es local')

  // La migracion tiene que estar aplicada: si no, cada rechazo "pasaria" por otra razon.
  const applied = sql(`SELECT (to_regclass('public.uq_subscription_events_notification') IS NOT NULL)::int
    + (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.subscription_checkout_sessions'::regclass AND attname = 'mp_preapproval_plan_id');`)
  assert(applied === '2', 'La migracion 20261012120000 (BETA-MP) no esta aplicada en la base local')

  let signingKey = Buffer.from(vars.PGRST_JWT_SECRET)
  if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
    const k = JSON.parse(vars.PGRST_JWT_SECRET).keys.find((x) => x.kty === 'oct')
    assert(k?.k, 'Falta la JWK HS256 local'); signingKey = Buffer.from(k.k, 'base64url')
  }
  const jwt = (claims) => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const c = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url')
    return `${h}.${c}.${createHmac('sha256', signingKey).update(`${h}.${c}`).digest('base64url')}`
  }
  const anonKey = jwt({ role: 'anon' })
  const userJwt = (actor) => jwt({ role: 'authenticated', aud: 'authenticated', sub: ids[actor] })
  const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

  // Igual que mp-subscription/index.ts: service_role para los datos, JWT del usuario para autorizar.
  const serviceClient = createClient(baseUrl, jwt({ role: 'service_role' }), clientOptions)
  const userClient = (actor) => createClient(baseUrl, anonKey, {
    ...clientOptions,
    global: { headers: { Authorization: `Bearer ${userJwt(actor)}`, 'x-techrepair-client-contract': '1' } },
  })

  const mp = new FakeMercadoPago(() => new Date())
  mp.seedPlans(TEST_PLANS)
  const logs = []
  const billing = () => ({
    store: createSupabaseBillingStore(serviceClient),
    mp: createMpClient({ fetchImpl: mp.fetchImpl, accessToken: () => FAKE_MP_TOKEN }),
    catalog: buildPlanCatalog((key) => PLAN_ENV[key]),
    now: () => new Date(),
    log: (event) => { logs.push(event) },
  })
  const call = (actor, body) => handleBillingAction({
    ...billing(),
    authorizer: createCapabilityAuthorizer(userClient(actor)),
    newId: () => randomUUID(),
    allowedOrigins: [ORIGIN],
    appOrigin: ORIGIN,
  }, { user: { id: ids[actor], email: `${actor.toLowerCase()}@${TAG}` }, body, origin: ORIGIN })
  let notificationSeq = 0
  const notify = (topic, resourceId, notificationId) => processWebhookNotification(
    billing(), parseNotification({ id: notificationId ?? `${run}-${++notificationSeq}`, type: topic, action: 'updated', data: { id: resourceId } }))

  const bodyFor = (action, biz) => action === 'create'
    ? { action, business_id: ids[biz], plan: 'pro', billing_cycle: 'monthly' }
    : { action, business_id: ids[biz] }
  const business = (biz) => JSON.parse(sql(`SELECT row_to_json(b) FROM (SELECT subscription_status, subscription_plan, access_source,
    mp_preapproval_id, mp_preapproval_plan_id, last_payment_status, trial_ends_at, current_period_end, grace_until FROM public.businesses WHERE id = '${ids[biz]}') b;`))
  const huella = (biz) => sql(`SELECT md5(b::text) FROM public.businesses b WHERE id = '${ids[biz]}';`)
  const count = (table, where) => Number(sql(`SELECT count(*) FROM public.${table} WHERE ${where};`))
  const reference = (res) => new URL(String(res.body.init_point)).searchParams.get('external_reference')
  const pre = (name) => `pre_${run}_${name}`

  // ── Fixture (como postgres, triggers apagados: es semilla, no el contrato) ──
  sql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users(id, email, email_confirmed_at) VALUES
      ('${ids.ownerA}','ownera@${TAG}',now()), ('${ids.ownerB}','ownerb@${TAG}',now()),
      ('${ids.ownerC}','ownerc@${TAG}',now()), ('${ids.techA}','techa@${TAG}',now());
    INSERT INTO public.businesses(id, name, owner_user_id, subscription_status, trial_ends_at, access_source) VALUES
      ('${ids.A}','BETA-MP A','${ids.ownerA}','trialing', now() + interval '6 days', 'trial'),
      ('${ids.B}','BETA-MP B','${ids.ownerB}','trialing', now() + interval '6 days', 'trial'),
      ('${ids.C}','BETA-MP C','${ids.ownerC}','trialing', now() + interval '6 days', 'trial');
    INSERT INTO public.profiles(id, business_id, role, is_active, email) VALUES
      ('${ids.ownerA}','${ids.A}','owner',true,'ownera@${TAG}'), ('${ids.ownerB}','${ids.B}','owner',true,'ownerb@${TAG}'),
      ('${ids.ownerC}','${ids.C}','owner',true,'ownerc@${TAG}'), ('${ids.techA}','${ids.A}','tech',true,'techa@${TAG}');
    COMMIT;`)
  seeded = true

  // ── 1. Autorización con la autoridad REAL de la base ─────────────────────
  section('1. Autorización: current_user_can_in_business real, con JWT de usuario')
  let r = await call('ownerA', bodyFor('status', 'A'))
  check(r.status === 200 && r.body.subscription_status === 'trialing', `owner de A lee el estado de A (${r.status})`)
  for (const action of BILLING_ACTIONS) {
    const before = huella('B')
    r = await call('ownerA', bodyFor(action, 'B'))
    check(r.status === 403 && r.body.code === 'forbidden', `owner de A → ${action} sobre B: 403`)
    assert(huella('B') === before, `${action} cross-tenant modificó B`)
  }
  for (const action of BILLING_ACTIONS) {
    r = await call('techA', bodyFor(action, 'A'))
    check(r.status === 403, `técnico de A (sin la capacidad subscription) → ${action}: 403`)
  }
  check(mp.calls.length === 0, 'ninguna de las denegadas llegó a Mercado Pago')
  check(count('subscription_checkout_sessions', `business_id IN ('${ids.A}','${ids.B}','${ids.C}')`) === 0, 'ninguna de las denegadas creó una sesión')

  // ── 2. El navegador no toca la tabla de checkout ─────────────────────────
  section('2. El navegador (authenticated) contra subscription_checkout_sessions')
  const browser = async (method, path, body) => {
    const res = await fetch(`${baseUrl}/rest/v1${path}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${userJwt('ownerA')}`, 'x-techrepair-client-contract': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* texto plano */ }
    return { status: res.status, json }
  }
  let b = await browser('POST', '/subscription_checkout_sessions', { business_id: ids.A, plan_id: 'full', billing_cycle: 'monthly', amount: 1, external_reference: `cliente-${run}`, status: 'paid' })
  check(b.status >= 400 && b.json?.code === '42501', `el owner NO inserta una sesión por PostgREST (${b.status} ${b.json?.code})`)
  b = await browser('GET', '/subscription_checkout_sessions?select=id')
  check(b.status >= 400 && b.json?.code === '42501', `el owner NO lee la tabla por PostgREST (${b.status} ${b.json?.code})`)
  b = await browser('PATCH', `/businesses?id=eq.${ids.A}`, { subscription_status: 'active', subscription_plan: 'full' })
  check(b.status >= 400 && business('A').subscription_status === 'trialing', `el owner NO se activa escribiendo businesses (${b.status})`)

  // ── 3. Abrir un checkout no cambia el negocio ────────────────────────────
  section('3. create: la intención queda en la sesión, el negocio no cambia')
  const antesA = huella('A')
  r = await call('ownerA', { action: 'create', business_id: ids.A, plan: 'pro', billing_cycle: 'monthly', payer_email: 'otro@evil.test' })
  check(r.status === 200 && reference(r)?.startsWith('trpcs_'), `create propio: 200 con referencia del servidor (${r.status})`)
  const refA = reference(r)
  check(huella('A') === antesA, 'la fila de businesses es idéntica: trial, plan y estado intactos')
  const sesionA = JSON.parse(sql(`SELECT row_to_json(s) FROM public.subscription_checkout_sessions s WHERE external_reference = '${refA}';`))
  check(sesionA.business_id === ids.A && sesionA.user_id === ids.ownerA && sesionA.plan_id === 'pro' && sesionA.billing_cycle === 'monthly'
    && sesionA.status === 'pending' && sesionA.mp_preapproval_plan_id === 'mpplan_pro_m' && Number(sesionA.amount) === 25000
    && sesionA.payer_email === `ownera@${TAG}`, 'la sesión registra negocio, usuario, plan, ciclo, plan de MP esperado, importe y el email del JWT')
  r = await call('ownerA', { action: 'create', business_id: ids.A, plan: 'pro', billing_cycle: 'monthly' })
  check(reference(r) === refA && count('subscription_checkout_sessions', `business_id = '${ids.A}'`) === 1, 'pedir el mismo plan reutiliza la misma sesión (índice único real)')

  // ── 4. Webhook: pending → authorized, por notificación ───────────────────
  section('4. Webhook canónico sobre la base real')
  mp.seedPreapproval(pre('a'), { status: 'pending', preapproval_plan_id: 'mpplan_pro_m', external_reference: refA })
  let n = await notify('subscription_preapproval', pre('a'), `${run}-created`)
  check(n.result === 'processed' && business('A').subscription_status === 'trialing', 'pending: procesada, sin acceso nuevo y sin degradar el trial')
  Object.assign(mp.preapprovals.get(pre('a')), { status: 'authorized', last_modified: new Date().toISOString() })
  n = await notify('subscription_preapproval', pre('a'), `${run}-updated`)
  let A = business('A')
  check(n.result === 'processed' && A.subscription_status === 'active' && A.subscription_plan === 'pro'
    && A.access_source === 'mercado_pago' && A.mp_preapproval_id === pre('a') && A.mp_preapproval_plan_id === 'mpplan_pro_m',
  'authorized (segunda notificación del MISMO preapproval): active + plan de MP + access_source mercado_pago')
  check(A.current_period_end !== null, 'current_period_end sale de next_payment_date')
  check(sql(`SELECT status || ':' || mp_preapproval_id || ':' || (confirmed_at IS NOT NULL) FROM public.subscription_checkout_sessions WHERE external_reference = '${refA}';`) === `paid:${pre('a')}:true`, 'la sesión queda paid con el preapproval confirmado')
  check(count('subscription_events', `external_id = '${pre('a')}' AND event_type = 'subscription_preapproval' AND processed`) === 2, 'las dos notificaciones quedaron registradas y procesadas')
  check(count('subscription_events', `business_id = '${ids.A}' AND event_type = 'billing_state_applied'`) === 1, 'un evento de auditoría por el cambio de acceso')
  const antesDup = huella('A')
  n = await notify('subscription_preapproval', pre('a'), `${run}-updated`)
  check(n.result === 'duplicate' && huella('A') === antesDup, 'la misma notificación reenviada: duplicate (índice único real), sin cambios')

  // ── 5. Plan pagado = plan otorgado ───────────────────────────────────────
  section('5. El navegador pide Full, Mercado Pago confirma Básico')
  r = await call('ownerB', { action: 'create', business_id: ids.B, plan: 'full', billing_cycle: 'monthly' })
  mp.seedPreapproval(pre('b'), { preapproval_plan_id: 'mpplan_basico_m', external_reference: reference(r) })
  n = await notify('subscription_preapproval', pre('b'))
  const B = business('B')
  check(B.subscription_status === 'active' && B.subscription_plan === 'basico', `B queda en Básico, jamás Full (${B.subscription_plan})`)
  mp.seedPreapproval(pre('x'), { preapproval_plan_id: 'mpplan_de_otra_app', external_reference: reference(r) })
  n = await notify('subscription_preapproval', pre('x'))
  check(n.detail === 'not_applied:reference_consumed' || n.detail === 'not_applied:unknown_plan', `un preapproval ajeno con la misma referencia no vincula (${n.detail})`)
  mp.seedPreapproval(pre('y'), { preapproval_plan_id: 'mpplan_full_m', external_reference: ids.C })
  const antesC = huella('C')
  n = await notify('subscription_preapproval', pre('y'))
  check(n.detail === 'not_applied:no_reference' && huella('C') === antesC, 'un business_id suelto como referencia no activa a ese negocio')

  // ── 6. Cobro recurrente → ledger ─────────────────────────────────────────
  section('6. Cobro recurrente: ledger payments + último pago')
  const inv = `inv_${run}`
  const pagadoEn = new Date().toISOString()
  mp.authorizedPayments.set(inv, { id: inv, preapproval_id: pre('a'), status: 'processed', transaction_amount: 25000, currency_id: 'ARS', date_created: pagadoEn, debit_date: pagadoEn, payment: { id: `pay_${run}`, status: 'approved' } })
  mp.payments.set(`pay_${run}`, { id: `pay_${run}`, status: 'approved', status_detail: 'accredited', transaction_amount: 25000, currency_id: 'ARS', date_created: pagadoEn, date_approved: pagadoEn, payer: { identification: { number: '00000000' } } })
  n = await notify('subscription_authorized_payment', inv)
  const pago = JSON.parse(sql(`SELECT row_to_json(p) FROM public.payments p WHERE external_payment_id = '${inv}';`))
  check(pago.business_id === ids.A && pago.status === 'approved' && pago.type === 'recurring' && Number(pago.amount) === 25000 && pago.subscription_plan === 'pro', 'una fila aprobada en payments, del negocio y con el plan de MP')
  check(!JSON.stringify(pago.raw_payload).includes('identification'), 'el ledger guarda un recorte: sin datos del pagador')
  check(business('A').last_payment_status === 'approved', 'last_payment_status = approved')
  n = await notify('subscription_authorized_payment', inv)
  check(count('payments', `external_payment_id = '${inv}'`) === 1, 'otra notificación del mismo cobro no duplica el ledger')
  n = await notify('payment', `pay_${run}`)
  check(count('payments', `business_id = '${ids.A}'`) === 1, 'la notificación `payment` no agrega una segunda fila al ledger')

  // ── 7. reconcile ─────────────────────────────────────────────────────────
  section('7. reconcile')
  const antesRec = huella('A')
  r = await call('ownerA', { action: 'reconcile', business_id: ids.A })
  check(r.status === 200 && r.body.activated === true && r.body.outcome === 'already_active' && huella('A') === antesRec, 'suscripción ya sincronizada: idempotente, la fila no cambia')
  r = await call('ownerC', { action: 'create', business_id: ids.C, plan: 'full', billing_cycle: 'annual' })
  mp.seedPreapproval(pre('c'), { preapproval_plan_id: 'mpplan_full_a', external_reference: reference(r) })
  mp.seedPreapproval(pre('c_ruido'), { preapproval_plan_id: 'mpplan_full_a', external_reference: null, payer_email: `ownerc@${TAG}` })
  r = await call('ownerC', { action: 'reconcile', business_id: ids.C })
  const C = business('C')
  check(r.status === 200 && r.body.activated === true && r.body.outcome === 'activated' && r.body.checkout?.status === 'paid'
    && C.subscription_status === 'active' && C.subscription_plan === 'full' && C.mp_preapproval_id === pre('c'),
  'webhook perdido: reconcile encuentra el preapproval por plan + referencia exacta y activa Full anual')
  check(count('subscription_events', `business_id = '${ids.C}' AND event_type = 'billing_state_applied' AND raw_payload->>'source' = 'reconcile'`) === 1, 'el cambio queda auditado con origen reconcile')

  // ── 8. Medio de pago y cancelación ───────────────────────────────────────
  section('8. update_payment_method y cancel')
  r = await call('ownerA', { action: 'update_payment_method', business_id: ids.A, preapproval_id: pre('c') })
  check(r.status === 200 && String(r.body.init_point).includes(pre('a')) && !String(r.body.init_point).includes(pre('c')), 'devuelve el enlace del preapproval de A, no el id que mandó el navegador')
  r = await call('ownerA', { action: 'cancel', business_id: ids.A })
  check(r.status === 200 && r.body.success === true && business('A').subscription_status === 'canceled' && mp.preapprovals.get(pre('a')).status === 'cancelled', 'cancel propio: cancelado en MP y canceled en la base')
  check(count('subscription_events', `business_id = '${ids.A}' AND event_type = 'user_cancelled'`) === 1, 'la cancelación queda auditada')
  r = await call('ownerA', { action: 'cancel', business_id: ids.A })
  check(r.status === 200 && r.body.already_cancelled === true && count('subscription_events', `business_id = '${ids.A}' AND event_type = 'user_cancelled'`) === 2, 'doble cancelación: idempotente (y los eventos de auditoría no chocan entre sí)')
  const antesWebhook = sql(`SELECT subscription_status || ':' || subscription_plan || ':' || mp_preapproval_id FROM public.businesses WHERE id = '${ids.A}';`)
  n = await notify('subscription_preapproval', pre('a'))
  check(n.result === 'processed' && sql(`SELECT subscription_status || ':' || subscription_plan || ':' || mp_preapproval_id FROM public.businesses WHERE id = '${ids.A}';`) === antesWebhook, 'el webhook de la cancelación llega después y no cambia nada')
  check(business('C').subscription_status === 'active' && mp.preapprovals.get(pre('c')).status === 'authorized', 'cancelar A no tocó la suscripción de C')
}

const cleanup = () => {
  if (!seeded) return
  const biz = `('${ids.A}','${ids.B}','${ids.C}')`
  sql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.payments WHERE business_id IN ${biz};
    DELETE FROM public.subscription_events WHERE business_id IN ${biz} OR external_id LIKE '%${run}%';
    DELETE FROM public.subscription_checkout_sessions WHERE business_id IN ${biz};
    DELETE FROM public.profiles WHERE business_id IN ${biz};
    DELETE FROM public.businesses WHERE id IN ${biz};
    DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
    COMMIT;`)
}

try {
  await main()
  console.log(`\nBETA-MP local OK: ${checks} comprobaciones contra PostgreSQL + PostgREST locales (Mercado Pago simulado).`)
} catch (error) {
  console.error(`\nBETA-MP local FAIL: ${error?.message ?? error}`)
  process.exitCode = 1
} finally {
  try { cleanup() } catch (error) { console.error(`cleanup: ${error?.message ?? error}`); process.exitCode = 1 }
}
