#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Guard estatico de la autoridad de Billing SaaS (Mercado Pago).
//
//   El frontend propone. Mercado Pago confirma. El backend decide.
//
// Los tests (tests/components/betaMp/) ejercitan el comportamiento. Este guard
// fija la ESTRUCTURA que esos tests no ven y que un refactor puede torcer sin
// romperlos: que las Edge Functions sigan siendo cableado, que la autorizacion
// vaya antes de todo, que abrir un checkout no pueda escribir el negocio, que el
// plan salga de Mercado Pago, que el navegador no toque la tabla de checkout y
// que ninguna migracion POSTERIOR reabra lo que cierra la 20261012120000.
//
//   node scripts/guards/beta-mp-billing-authority.mjs [--self-test]
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MIG_DIR = 'supabase/migrations'
const MIGRATION = '20261012120000_beta_mp_checkout_session_server_authority.sql'
const BILLING = 'supabase/functions/_shared/billing'

const read = (p) => readFileSync(p, 'utf8')
const sinComentariosSql = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '')
const codigo = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

function archivosTs(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...archivosTs(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p.replace(/\\/g, '/'))
  }
  return out
}

/** Texto entre dos marcadores (el segundo, exclusivo). Vacio si falta alguno. */
function tramo(src, desde, hasta) {
  const a = src.indexOf(desde)
  if (a < 0) return ''
  const b = hasta ? src.indexOf(hasta, a + desde.length) : -1
  return b < 0 ? src.slice(a) : src.slice(a, b)
}

function inspectEdge(s) {
  const f = []
  const sub = codigo(s.subIndex), hook = codigo(s.hookIndex)
  const actions = codigo(s.actions), pre = codigo(s.preapproval), webhook = codigo(s.webhook), store = codigo(s.store)

  // Las Edge Functions son cableado: sin reglas de billing ni acceso directo a datos.
  for (const [nombre, src] of [['mp-subscription', sub], ['mp-webhook', hook]]) {
    if (/\.from\(\s*['"`]/.test(src)) f.push(`${nombre}/index.ts accede a una tabla directamente (las reglas viven en _shared/billing)`)
    if (/subscription_status|subscription_plan|pending_activation/.test(src)) f.push(`${nombre}/index.ts decide estado o plan de suscripcion`)
    if (/api\.mercadopago\.com/.test(src)) f.push(`${nombre}/index.ts llama a Mercado Pago sin pasar por mpClient`)
  }
  if (!/handleBillingAction\(/.test(sub)) f.push('mp-subscription no delega en handleBillingAction')
  if (!/authorizer:\s*createCapabilityAuthorizer\(user\.client\)/.test(sub)) f.push('mp-subscription no autoriza con el cliente del USUARIO (JWT)')
  if (!/createClient<any>\(\s*Deno\.env\.get\('SUPABASE_URL'\)!,\s*Deno\.env\.get\('SUPABASE_ANON_KEY'\)!,\s*\{ global: \{ headers: userDataApiHeaders\(req, authHeader\) \}/.test(sub)) {
    f.push('el cliente del usuario dejo de construirse con la anon key + el Authorization del request')
  }
  if (!/const user = await getAuthUser\(req\)\s*\n\s*if \(!user\) return jsonResponse\(req, \{ error: 'Unauthorized' \}, 401\)/.test(sub)) f.push('mp-subscription no valida el JWT antes de actuar')
  if (/jsonResponse\(req,\s*\{[^}]*\b(err|error)\??\.(message|stack)/.test(sub)) f.push('mp-subscription devuelve el mensaje interno de un error al navegador')

  // Webhook: firma obligatoria y procesamiento esperado antes de responder.
  if (!/const sig = await verifySignature\(/.test(hook)) f.push('mp-webhook no valida la firma')
  if (!/sig === 'missing_secret'[\s\S]{0,220}status: 500/.test(hook)) f.push('mp-webhook: sin secret ya no responde 500')
  if (!/sig === 'invalid'[\s\S]{0,220}status: 401/.test(hook)) f.push('mp-webhook: firma invalida ya no responde 401')
  const firma = hook.indexOf('const sig = await verifySignature(')
  const proceso = hook.indexOf('await processWebhookNotification(')
  if (proceso < 0) f.push('mp-webhook no AWAIT-ea el procesamiento (fire-and-forget)')
  else if (firma < 0 || firma > proceso) f.push('mp-webhook procesa antes de validar la firma')
  if (/createClient[\s\S]{0,400}verifySignature\(/.test(hook.slice(hook.indexOf('serve(')))) f.push('mp-webhook crea el cliente service_role antes de validar la firma')

  // Autorizacion uniforme: antes de cualquier lectura, escritura o llamada a MP.
  const router = tramo(actions, 'export async function handleBillingAction', 'switch (action as BillingAction)')
  if (!/allowed = await ctx\.authorizer\.canManageBilling\(businessId\)/.test(router)) f.push('handleBillingAction no consulta la autoridad')
  if (!/if \(!allowed\) \{[\s\S]{0,200}return fail\(403, 'forbidden'/.test(router)) f.push('handleBillingAction no corta con 403 cuando la autoridad dice que no')
  if (/ctx\.(store|mp)\./.test(router)) f.push('handleBillingAction toca la base o Mercado Pago ANTES de autorizar')
  if (/canManageBilling/.test(actions.replace(router, ''))) f.push('hay una segunda verificacion de autorizacion fuera del router (dejo de ser uniforme)')
  if (!/rpc\('current_user_can_in_business', \{\s*p_business_id: businessId,\s*p_key: BILLING_CAPABILITY,?\s*\}\)/.test(store)) f.push('el autorizador no usa current_user_can_in_business(business, subscription)')
  if (!/return result\.data === true/.test(store)) f.push('el autorizador acepta algo distinto de un true literal')

  // Abrir un checkout no escribe el negocio ni cancela nada.
  const create = tramo(actions, 'async function createCheckout', 'function describePlanProblem') + tramo(actions, 'async function openSession', 'function isWithinTtl')
  if (!create) f.push('no se encontro createCheckout')
  if (/updateBusinessBilling|cancelPreapproval|applyPreapprovalEvidence/.test(create)) f.push('create escribe businesses, cancela o aplica evidencia (abrir un checkout no cambia el acceso)')
  if (/req\.body\.(payer_email|preapproval_plan_id|preapproval_id|mp_plan_id)/.test(actions)) f.push('una accion confia en payer_email / ids de plan o preapproval mandados por el navegador')
  if (/updateBusinessBilling\(/.test(actions)) f.push('subscriptionActions escribe businesses fuera del camino canonico')
  if (!/const payerEmail = req\.user\.email\n/.test(actions)) f.push('el email del pagador dejo de salir del JWT')

  // El plan de MP se valida contra el ciclo pedido con una tabla CERRADA de
  // equivalencias (anual = 12 months o 1 years; mensual y trimestral, una sola).
  if (!/if \(!matchesBillingCycleFrequency\(billingCycle, recurring\.frequency, recurring\.frequency_type\)\) return 'frequency_mismatch'/.test(actions)) {
    f.push('create dejo de validar la frecuencia del plan de Mercado Pago contra el ciclo pedido')
  }
  const catalog = codigo(s.catalog)
  const tabla = tramo(catalog, 'export const CYCLE_FREQUENCIES', '\n}\n').replace(/\s+/g, ' ')
  const esperada = "monthly: [{ frequency: 1, frequencyType: 'months' }], quarterly: [{ frequency: 3, frequencyType: 'months' }], annual: [{ frequency: 12, frequencyType: 'months' }, { frequency: 1, frequencyType: 'years' }],"
  if (!tabla.includes(esperada)) f.push('la tabla de frecuencias equivalentes cambio (se amplio o se achico sin evidencia de Mercado Pago)')
  if (!/\.some\(\(f\) => f\.frequency === amount && f\.frequencyType === unit\)/.test(catalog)) f.push('la frecuencia dejo de compararse de forma exacta contra la tabla')

  // Un solo camino escribe el acceso, y el plan sale de Mercado Pago.
  if (/subscription_plan:\s*session\.plan_id|subscription_plan\s*=\s*session\.plan_id/.test(pre + webhook)) f.push('el plan otorgado sale de la sesion (lo que pidio el navegador) y no de Mercado Pago')
  if (!/const entry = ctx\.catalog\.byMpPlanId\(pre\.preapproval_plan_id\)/.test(pre)) f.push('el plan dejo de resolverse por el preapproval_plan_id de Mercado Pago')
  if (!/if \(!entry\) return outcome\(pre, mpState, \{ \.\.\.base, kind: 'not_applied', reason: 'unknown_plan' \}\)/.test(pre)) f.push('un plan desconocido ya no falla cerrado al vincular')
  if (!/if \(!reference\) return outcome\(pre, mpState, \{ kind: 'not_applied', reason: 'no_reference' \}\)/.test(pre)) f.push('un preapproval sin referencia valida ya no falla cerrado')
  for (const [nombre, src] of [['preapproval', pre], ['webhook', webhook], ['subscriptionActions', actions], ['store', store]]) {
    if (/subscription_status\s*[:=]\s*'pending_activation'/.test(src)) f.push(`${nombre}.ts escribe pending_activation`)
  }
  if (/\.delete\(/.test(store)) f.push('el store de billing borra filas')
  if (/from\('businesses'\)\s*\.(insert|upsert)/.test(store)) f.push('el store inserta negocios')

  // Idempotencia por notificacion.
  if (!/notification_id: notification\.notificationId/.test(webhook)) f.push('el webhook dejo de reclamar el evento por notificacion')
  if (!/onConflict: 'provider,external_payment_id'/.test(store)) f.push('el ledger payments dejo de ser un upsert idempotente')
  if (!/if \(isStale\(pre\.last_modified, business\.mp_last_modified\)\)/.test(pre)) f.push('se perdio la proteccion contra eventos fuera de orden')
  return f
}

function inspectFrontend(s) {
  const f = []
  for (const { path, src } of s.srcFiles) {
    const c = codigo(src)
    if (/subscription_checkout_sessions/.test(c)) f.push(`${path}: el navegador vuelve a tocar subscription_checkout_sessions`)
    if (/VITE_MP_PLAN/.test(c)) f.push(`${path}: el navegador vuelve a conocer los ids de plan de Mercado Pago`)
    if (/from\(\s*['"]businesses['"]\s*\)[\s\S]{0,160}\.update\(\s*\{[\s\S]{0,400}(subscription_status|subscription_plan|mp_preapproval_id)/.test(c)) {
      f.push(`${path}: escribe columnas de suscripcion de businesses desde el navegador`)
    }
  }
  const pending = codigo(s.pendingPage)
  if (/useSearchParams|location\.search|URLSearchParams/.test(pending)) f.push('PaymentPending lee parametros de la URL de retorno')
  if (/isActive/.test(pending)) f.push('PaymentPending decide por isActive (un plan anterior tambien es active)')
  if (!/const isPaid\s+= status === 'paid'\n/.test(pending)) f.push('PaymentPending no confirma por el estado del checkout que informa el servidor')
  if (!/confirmed = isActive && subscription\?\.access_source === 'mercado_pago'/.test(codigo(s.successPage))) f.push('SubscriptionSuccess afirma «activada» sin una suscripcion de Mercado Pago')
  const service = codigo(s.service)
  const reconcile = tramo(service, 'export async function reconcilePayment', '\n}\n')
  if (/catch|getSubscription\(/.test(reconcile)) f.push('reconcilePayment vuelve a tapar el error con una lectura local')
  if (!/activated: result\.activated === true/.test(reconcile)) f.push('reconcilePayment no exige un true literal del servidor')
  return f
}

function inspectConfig(config) {
  const f = []
  for (const fn of ['mp-webhook', 'mp-subscription']) {
    if (!new RegExp(`\\[functions\\.${fn}\\]\\s*\\n(?:\\s*#[^\\n]*\\n)*\\s*verify_jwt\\s*=\\s*false`).test(config)) {
      f.push(`supabase/config.toml: ${fn} no declara verify_jwt = false (un redeploy lo cerraria)`)
    }
  }
  return f
}

function inspectMigraciones(s) {
  const f = []
  const sql = sinComentariosSql(s.migration)
  if (!/REVOKE ALL ON TABLE public\.subscription_checkout_sessions FROM PUBLIC, anon, authenticated;/.test(sql)) f.push('la migracion no revoca la tabla de checkout a PUBLIC/anon/authenticated')
  if (!/GRANT SELECT, INSERT, UPDATE ON TABLE public\.subscription_checkout_sessions TO service_role;/.test(sql)) f.push('la migracion no da SELECT/INSERT/UPDATE a service_role')
  if (/GRANT[^;]*\b(DELETE|TRUNCATE|ALL)\b[^;]*subscription_checkout_sessions/i.test(sql)) f.push('la migracion deja borrar o truncar sesiones de checkout')
  if (!/DROP POLICY IF EXISTS scs_insert ON public\.subscription_checkout_sessions;/.test(sql)) f.push('la migracion no elimina scs_insert')
  if (!/CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_events_notification\s+ON public\.subscription_events \(provider, event_type, external_id, notification_id\)/.test(sql)) f.push('falta el indice unico por notificacion')
  if (!/^BEGIN;[\s\S]*^COMMIT;\s*$/m.test(sql)) f.push('la migracion no corre en una transaccion explicita')
  if (/\b(UPDATE|DELETE FROM|INSERT INTO)\s+public\.(businesses|payments|subscription_events|subscription_checkout_sessions)\b/i.test(sql)) f.push('la migracion hace DML (tenia que ser cero)')

  const grantACliente = /GRANT[^;]*ON\s+(TABLE\s+)?(public\.)?"?subscription_checkout_sessions"?[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i
  if (grantACliente.test(sql)) f.push('la migracion le da la tabla de checkout a un rol de cliente')

  for (const { nombre, sql: crudo } of s.migraciones) {
    if (nombre <= MIGRATION) continue
    const posterior = sinComentariosSql(crudo)
    if (grantACliente.test(posterior)) f.push(`${nombre}: le devuelve la tabla de checkout a un rol de cliente`)
    if (/CREATE POLICY[^;]*ON\s+(public\.)?"?subscription_checkout_sessions"?[^;]*FOR\s+(INSERT|UPDATE|ALL)/i.test(posterior)) f.push(`${nombre}: recrea una policy de escritura sobre la tabla de checkout`)
    if (/CREATE\s+UNIQUE\s+INDEX[^;]*subscription_events[^;]*\(\s*"?provider"?\s*,\s*"?event_type"?\s*,\s*"?external_id"?\s*\)/i.test(posterior)) f.push(`${nombre}: vuelve al dedupe de eventos por recurso`)
    if (/DROP INDEX[^;]*uq_subscription_events_notification/i.test(posterior)) f.push(`${nombre}: elimina el dedupe por notificacion`)
  }
  return f
}

function run(s) {
  return [
    ...inspectEdge(s).map((x) => `edge: ${x}`),
    ...inspectFrontend(s).map((x) => `frontend: ${x}`),
    ...inspectConfig(s.config),
    ...inspectMigraciones(s).map((x) => `migraciones: ${x}`),
  ]
}

function estado() {
  const migraciones = readdirSync(MIG_DIR).filter((n) => n.endsWith('.sql')).sort().map((nombre) => ({ nombre, sql: read(join(MIG_DIR, nombre)) }))
  const migration = migraciones.find((m) => m.nombre === MIGRATION)
  if (!migration) throw new Error(`falta la migracion ${MIGRATION}`)
  return {
    subIndex: read('supabase/functions/mp-subscription/index.ts'),
    hookIndex: read('supabase/functions/mp-webhook/index.ts'),
    actions: read(`${BILLING}/subscriptionActions.ts`),
    preapproval: read(`${BILLING}/preapproval.ts`),
    webhook: read(`${BILLING}/webhook.ts`),
    store: read(`${BILLING}/store.ts`),
    catalog: read(`${BILLING}/planCatalog.ts`),
    service: read('src/services/subscriptionService.ts'),
    pendingPage: read('src/pages/PaymentPending.tsx'),
    successPage: read('src/pages/SubscriptionSuccess.tsx'),
    srcFiles: archivosTs('src').map((path) => ({ path, src: read(path) })),
    config: read('supabase/config.toml'),
    migration: migration.sql,
    migraciones,
  }
}

function mutar(texto, de, a) {
  const next = texto.replace(de, a)
  if (next === texto) throw new Error(`self-test: la mutacion no aplico (${String(de).slice(0, 70)})`)
  return next
}

if (process.argv.includes('--self-test')) {
  const base = estado()
  const limpio = run(base)
  if (limpio.length) throw new Error(`self-test: falso positivo sobre el repo: ${limpio.join(' | ')}`)
  const con = (campo, de, a) => ({ ...base, [campo]: mutar(base[campo], de, a) })
  const conSrc = (path, extra) => ({ ...base, srcFiles: base.srcFiles.map((x) => (x.path === path ? { path, src: x.src + extra } : x)) })
  const posterior = (sql) => ({ ...base, migraciones: [...base.migraciones, { nombre: '20261099120000_regresion.sql', sql }] })
  const casos = [
    ['index: create vuelve a escribir businesses', con('subIndex', "    const result = await handleBillingAction(ctx, {", "    await serviceClient.from('businesses').update({ subscription_status: 'pending_activation' }).eq('id', 'x')\n    const result = await handleBillingAction(ctx, {"), 'accede a una tabla'],
    ['index: autoriza con service_role', con('subIndex', 'authorizer: createCapabilityAuthorizer(user.client)', 'authorizer: createCapabilityAuthorizer(serviceClient)'), 'cliente del USUARIO'],
    ['index: sin validar el JWT', con('subIndex', "    if (!user) return jsonResponse(req, { error: 'Unauthorized' }, 401)\n", ''), 'valida el JWT'],
    ['index: filtra el error interno', con('subIndex', "return jsonResponse(req, { error: 'Internal server error' }, 500)", 'return jsonResponse(req, { error: err.message }, 500)'), 'mensaje interno'],
    ['webhook: firma opcional', con('hookIndex', "  if (sig === 'invalid') {", "  if (sig === 'nunca') {"), '401'],
    ['webhook: sin secret procesa igual', con('hookIndex', "  if (sig === 'missing_secret') {", "  if (sig === 'nunca-secret') {"), '500'],
    ['webhook: fire-and-forget', con('hookIndex', 'const outcome = await processWebhookNotification(ctx, notification)', 'const outcome = { result: "x" }; void processWebhookNotification(ctx, notification)'), 'AWAIT'],
    ['router: sin 403', con('actions', "    return fail(403, 'forbidden', 'No tenés permiso para gestionar la suscripción de este negocio.')", "    ctx.log({ event: 'forbidden_ignored' })"), '403'],
    ['router: lee antes de autorizar', con('actions', '  // ── Autorización uniforme: antes de cualquier lectura o escritura ─────────\n', '  await ctx.store.getBusinessBilling(businessId)\n'), 'ANTES de autorizar'],
    ['autorizador: acepta truthy', con('store', 'return result.data === true', 'return Boolean(result.data)'), 'true literal'],
    ['autorizador: otra capacidad', con('store', 'p_key: BILLING_CAPABILITY,', "p_key: 'orders',"), 'current_user_can_in_business'],
    ['create: escribe el negocio', con('actions', "  ctx.log({ event: 'checkout_opened'", "  await ctx.store.updateBusinessBilling(businessId, { subscription_plan: plan }, ctx.now().toISOString())\n  ctx.log({ event: 'checkout_opened'"), 'abrir un checkout'],
    ['create: cancela la suscripcion vigente', con('actions', "  ctx.log({ event: 'checkout_opened'", "  if (business.mp_preapproval_id) await ctx.mp.cancelPreapproval(business.mp_preapproval_id)\n  ctx.log({ event: 'checkout_opened'"), 'abrir un checkout'],
    ['create: email del body', con('actions', 'const payerEmail = req.user.email\n', 'const payerEmail = String(req.body.payer_email)\n'), 'payer_email'],
    ['create: sin validar la frecuencia', con('actions', "  if (!matchesBillingCycleFrequency(billingCycle, recurring.frequency, recurring.frequency_type)) return 'frequency_mismatch'\n", ''), 'validar la frecuencia'],
    ['frecuencia: cualquier cantidad de years es anual', con('catalog', 'f.frequency === amount && f.frequencyType === unit', 'f.frequencyType === unit'), 'forma exacta'],
    ['frecuencia: mensual acepta 1 years', con('catalog', "monthly:   [{ frequency: 1, frequencyType: 'months' }],", "monthly:   [{ frequency: 1, frequencyType: 'months' }, { frequency: 1, frequencyType: 'years' }],"), 'tabla de frecuencias'],
    ['frecuencia: el anual pierde 1 years', con('catalog', ", { frequency: 1, frequencyType: 'years' }],", '],'), 'tabla de frecuencias'],
    ['plan desde la sesion', con('preapproval', "    subscription_plan: entry.plan,\n    subscription_provider: 'mercadopago',", "    subscription_plan: session.plan_id,\n    subscription_provider: 'mercadopago',"), 'lo que pidio el navegador'],
    ['plan desconocido activa', con('preapproval', "  if (!entry) return outcome(pre, mpState, { ...base, kind: 'not_applied', reason: 'unknown_plan' })\n\n  if (session.status === 'paid')", "  if (session.status === 'paid')"), 'plan desconocido'],
    ['sin referencia vincula igual', con('preapproval', "  if (!reference) return outcome(pre, mpState, { kind: 'not_applied', reason: 'no_reference' })\n", ''), 'sin referencia'],
    ['vuelve pending_activation', con('preapproval', "    if (current !== 'trialing') patch.subscription_status = 'canceled'", "    if (current !== 'trialing') patch.subscription_status = 'pending_activation'"), 'pending_activation'],
    ['sin guarda de orden', con('preapproval', 'if (isStale(pre.last_modified, business.mp_last_modified)) {', 'if (false) {'), 'fuera de orden'],
    ['dedupe sin notificacion', con('webhook', '    notification_id: notification.notificationId,\n', ''), 'por notificacion'],
    ['frontend: inserta la sesion', conSrc('src/services/subscriptionService.ts', "\nexport const x = () => supabase.from('subscription_checkout_sessions').insert({})\n"), 'subscription_checkout_sessions'],
    ['frontend: ids de plan en el navegador', conSrc('src/types/subscription.ts', '\nexport const y = import.meta.env.VITE_MP_PLAN_FULL_MONTHLY\n'), 'ids de plan'],
    ['frontend: se autoactiva', conSrc('src/pages/Plans.tsx', "\nexport const z = () => supabase.from('businesses').update({ subscription_status: 'active' })\n"), 'columnas de suscripcion'],
    ['PaymentPending: confia en la URL', con('pendingPage', "import { useNavigate } from 'react-router-dom'", "import { useNavigate, useSearchParams } from 'react-router-dom'"), 'URL de retorno'],
    ['PaymentPending: confirma por isActive', con('pendingPage', "const isPaid     = status === 'paid'\n", "const isPaid     = status === 'paid' || isActive\n"), 'isActive'],
    ['SubscriptionSuccess: active alcanza', con('successPage', "const confirmed = isActive && subscription?.access_source === 'mercado_pago'", 'const confirmed = isActive'), 'activada'],
    ['servicio: traga el error', con('service', "  const result = await callEdge<Partial<ReconcileResult>>('reconcile', { business_id: businessId })", "  let result: Partial<ReconcileResult> = {}\n  try { result = await callEdge<Partial<ReconcileResult>>('reconcile', { business_id: businessId }) } catch { result = { activated: true } }"), 'tapar el error'],
    ['config: mp-webhook sin verify_jwt=false', con('config', /\[functions\.mp-webhook\]\s*\nverify_jwt = false/, '[functions.mp-webhook]\nverify_jwt = true'), 'mp-webhook'],
    ['migracion: authenticated inserta', con('migration', 'GRANT SELECT, INSERT, UPDATE ON TABLE public.subscription_checkout_sessions TO service_role;', 'GRANT SELECT, INSERT, UPDATE ON TABLE public.subscription_checkout_sessions TO service_role;\nGRANT INSERT ON TABLE public.subscription_checkout_sessions TO authenticated;'), 'rol de cliente'],
    ['migracion: service_role borra', con('migration', 'GRANT SELECT, INSERT, UPDATE ON TABLE public.subscription_checkout_sessions TO service_role;', 'GRANT ALL ON TABLE public.subscription_checkout_sessions TO service_role;'), 'SELECT/INSERT/UPDATE'],
    ['migracion: conserva scs_insert', con('migration', 'DROP POLICY IF EXISTS scs_insert ON public.subscription_checkout_sessions;\n', ''), 'scs_insert'],
    ['migracion: hace DML', con('migration', 'COMMIT;\n', "UPDATE public.businesses SET subscription_status = 'active';\nCOMMIT;\n"), 'DML'],
    ['posterior: reabre la tabla al navegador', posterior('GRANT SELECT, INSERT ON TABLE public.subscription_checkout_sessions TO authenticated;'), 'rol de cliente'],
    ['posterior: policy de insert', posterior('CREATE POLICY scs_insert ON public.subscription_checkout_sessions FOR INSERT WITH CHECK (true);'), 'policy de escritura'],
    ['posterior: dedupe por recurso', posterior('CREATE UNIQUE INDEX uq_x ON public.subscription_events (provider, event_type, external_id) WHERE external_id IS NOT NULL;'), 'por recurso'],
    ['posterior: borra el dedupe', posterior('DROP INDEX public.uq_subscription_events_notification;'), 'dedupe por notificacion'],
  ]
  for (const [nombre, st, esperado] of casos) {
    const hits = run(st)
    if (!hits.some((h) => h.includes(esperado))) throw new Error(`self-test no detecto: ${nombre} (hits: ${hits.join(' | ') || 'ninguno'})`)
  }
  console.log(`BETA-MP guard self-test OK: ${casos.length} sabotajes detectados, 0 falsos positivos`)
  process.exit(0)
}

const fallas = run(estado())
if (fallas.length) {
  console.error('BETA-MP guard FAIL:')
  for (const x of fallas) console.error(`- ${x}`)
  process.exit(1)
}
console.log('BETA-MP guard OK: Edge Functions como cableado, autorizacion uniforme antes de todo, checkout sin escritura de businesses, plan desde Mercado Pago, webhook con firma obligatoria e idempotencia por notificacion, navegador sin acceso a la sesion de checkout, migraciones sin reapertura.')
