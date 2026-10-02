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
// navegador no toque la tabla de checkout y que ninguna migracion POSTERIOR
// reabra lo que cierran la 20261012120000 y la 20261013120000.
//
// PLAN B (2026-10-02): el checkout por URL de un plan de Mercado Pago no conserva
// `external_reference`, asi que el SERVIDOR crea el preapproval y guarda su id
// antes de devolver el checkout. El guard fija esa cadena:
//   precio del catalogo del servidor → POST /preapproval → respuesta validada →
//   id vinculado a la sesion → recien entonces el init_point;
// y que la activacion resuelva el negocio SOLO por ese id (nunca por
// referencia sola, email, importe o fecha), con el plan de esa sesion y con las
// condiciones de Mercado Pago iguales a las de la sesion.
//
//   node scripts/guards/beta-mp-billing-authority.mjs [--self-test]
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MIG_DIR = 'supabase/migrations'
const MIGRATION = '20261012120000_beta_mp_checkout_session_server_authority.sql'
const PLAN_B_MIGRATION = '20261013120000_beta_mp_plan_b_session_preapproval_unique.sql'
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

  // Abrir un checkout no escribe el negocio, no aplica evidencia y no toca la
  // suscripcion vigente.
  const create = tramo(actions, 'async function createCheckout', 'function checkoutProblem')
  const openCheckout = tramo(actions, 'async function findOpenCheckout', 'async function closeSession')
  const discard = tramo(actions, 'async function discardUnlinkedPreapproval', 'function sessionAgeMs')
  if (!create || !openCheckout || !discard) f.push('no se encontro createCheckout / findOpenCheckout / discardUnlinkedPreapproval')
  if (/updateBusinessBilling|applyPreapprovalEvidence/.test(create + openCheckout + discard)) f.push('create escribe businesses o aplica evidencia (abrir un checkout no cambia el acceso)')
  if (/business\.mp_preapproval_id/.test(create + openCheckout + discard)) f.push('create mira o toca la suscripcion vigente del negocio')
  if (/cancelPreapproval\(/.test(create + openCheckout)) f.push('create cancela un preapproval fuera de discardUnlinkedPreapproval')
  if (!/if \(reported !== '' && reported !== reference\) return\n[\s\S]*if \(await ctx\.store\.findCheckoutSessionByPreapprovalId\(createdId\)\) return\n\s*await ctx\.mp\.cancelPreapproval\(createdId\)/.test(discard)) {
    f.push('discardUnlinkedPreapproval puede cancelar un preapproval que no es el recien creado (otra referencia o ya vinculado a otra sesion)')
  }
  if (/updateBusinessBilling\(/.test(actions)) f.push('subscriptionActions escribe businesses fuera del camino canonico')

  // Plan B · lo que se cobra y a quien lo decide el servidor.
  if (/req\.body\.(payer_email|preapproval_plan_id|preapproval_id|mp_preapproval_id|mp_plan_id|external_reference|amount|price|transaction_amount|currency|currency_id|frequency|frequency_type|auto_recurring|reason)\b/.test(actions)) {
    f.push('una accion confia en un dato del navegador (payer_email, ids, referencia, importe, moneda o frecuencia)')
  }

  // El email del pagador (`payer_email`). Mercado Pago lo exige para crear el
  // preapproval y el del login no siempre es el de una cuenta de Mercado Pago
  // (medido: 400 «User bad request»). Es un PARAMETRO de ese POST, no identidad:
  //   · el primer intento usa el del JWT; el del body solo entra por
  //     resolvePayerEmail, validado, y solo en `create`;
  //   · solo viaja a createPendingPreapproval y a la columna payer_email de la
  //     sesion (registro de lo enviado);
  //   · el pedido de otro email sale UNICAMENTE del rechazo medido de ese POST.
  const resolver = tramo(actions, 'function resolvePayerEmail', 'async function createCheckout')
  if (!resolver) f.push('no se encontro resolvePayerEmail')
  if ((actions.match(/req\.body\.mp_payer_email/g) ?? []).length !== 1 || !/const raw = req\.body\.mp_payer_email\n/.test(resolver)) {
    f.push('mp_payer_email se lee del body fuera de resolvePayerEmail (solo `create` puede recibirlo, y validado)')
  }
  if (!/if \(raw === undefined \|\| raw === null\) \{\s*return req\.user\.email\s*\? \{ ok: true, email: req\.user\.email, explicit: false \}\s*: \{ ok: false, response: PAYER_EMAIL_REQUIRED\(\) \}\s*\}/.test(resolver)) {
    f.push('el primer intento de create dejo de usar el email del JWT')
  }
  if (!/if \(typeof raw !== 'string'\) return invalid\(/.test(resolver)
      || !/const email = raw\.trim\(\)\.toLowerCase\(\)\n\s*if \(email === ''\) return invalid\(/.test(resolver)
      || !/if \(email\.length > MAX_PAYER_EMAIL_LENGTH \|\| email\.indexOf\('@'\) > MAX_PAYER_EMAIL_LOCAL_LENGTH \|\| !PAYER_EMAIL_RE\.test\(email\)\) \{\s*return invalid\(/.test(resolver)) {
    f.push('mp_payer_email dejo de validarse en el servidor (tipo, vacio, longitud o formato)')
  }
  if (!/const payer = resolvePayerEmail\(req\)\n\s*if \(!payer\.ok\) return payer\.response\n\s*const payerEmail = payer\.email\n/.test(create)) f.push('create dejo de tomar el pagador de resolvePayerEmail')
  if (!/payer_email: payerEmail,\s*\}\)/.test(create)) f.push('la sesion dejo de registrar el payer_email que se le mando a Mercado Pago')
  if (!/\} catch \(error\) \{\s*await closeSession\(ctx, session\.id, 'failed'\)\s*if \(isPayerRejection\(error\)\) \{[\s\S]{0,420}return payer\.explicit\s*\? fail\(422, 'mp_payer_email_rejected',[^\n]*\n\s*: PAYER_EMAIL_REQUIRED\(\)\s*\}\s*throw error\s*\}/.test(create)) {
    f.push('el pedido de otro email dejo de salir solo del rechazo del pagador en POST /preapproval (o un email ya indicado vuelve a pedirse en loop, o se tapan otros errores de Mercado Pago)')
  }
  if ((actions.match(/PAYER_EMAIL_REQUIRED\(\)/g) ?? []).length !== 2) f.push('mp_payer_email_required se responde en un lugar que no es «sin email en el JWT» ni «Mercado Pago rechazo el del JWT»')
  // Fuera de `create`, ninguna accion sabe nada de un email.
  const zonaEmail = tramo(actions, 'interface CheckoutIntent', 'function checkoutProblem')
  const fueraDeCreate = actions.replace(zonaEmail, '').replace(openCheckout, '')
    // Lo unico que queda fuera de esa zona y nombra un email: el import del
    // clasificador y el tipo del usuario autenticado.
    .replace(/\bisPayerRejection\b/, '').replace(/email: string \| null/, '')
  if (/payer|mp_payer_email|\bemail\b/i.test(fueraDeCreate)) {
    f.push('una accion que no es create usa un email (el email del pagador no es identidad)')
  }
  if (!/const terms = ctx\.catalog\.termsFor\(plan, billingCycle\)\n\s*if \(!terms\) \{/.test(create)) f.push('create dejo de tomar importe y frecuencia del catalogo del servidor (o ya no falla cerrado sin precio)')
  if (!/createPendingPreapproval\(\{[\s\S]*externalReference: reference,\s*payerEmail,[\s\S]*frequency: terms\.frequency,\s*frequencyType: terms\.frequencyType,\s*amount: terms\.amount,\s*currency: terms\.currency,\s*\}\)/.test(create)) {
    f.push('el preapproval dejo de crearse con la referencia, el pagador y las condiciones que fija el servidor')
  }

  // Plan B · la cadena: sesion → POST → respuesta validada → vinculo → checkout.
  const paso = (marca) => create.indexOf(marca)
  const insertar = paso('ctx.store.insertCheckoutSession(')
  const crear = paso('ctx.mp.createPendingPreapproval(')
  const validar = paso('checkoutProblem(created, reference, expected)')
  const vincular = paso('ctx.store.updateCheckoutSession(session.id, { mp_preapproval_id: created.id }')
  const entregar = paso('init_point: checkoutUrl')
  if ([insertar, crear, validar, vincular, entregar].some((i) => i < 0)) f.push('create perdio un paso de la cadena sesion → preapproval → validacion → vinculo → checkout')
  else if (!(insertar < crear && crear < validar && validar < vincular && vincular < entregar)) f.push('create entrega el checkout antes de guardar el id del preapproval (o valida/vincula en otro orden)')
  if (!/const checkoutUrl = problem \? null : preapprovalCheckoutUrl\(created\)\n\s*if \(!checkoutUrl\) \{[\s\S]{0,400}return fail\(502, 'checkout_unavailable'/.test(create)) f.push('una respuesta invalida de Mercado Pago ya no corta el checkout')
  if (!/\} catch \(error\) \{\s*await discardUnlinkedPreapproval\(ctx, created, reference\)\s*await closeSession\(ctx, session\.id, 'failed'\)\s*throw error\s*\}/.test(create)) {
    f.push('si el vinculo no se puede guardar, create ya no falla cerrado (sin checkout y sin preapproval pagable)')
  }
  const validacion = tramo(actions, 'function checkoutProblem', 'type OpenCheckout')
  for (const [regla, re] of [
    ['estado pending', /if \(preapprovalState\(pre\.status\) !== 'pending'\) return 'not_pending'/],
    ['referencia de la sesion', /if \(reported !== '' && reported !== reference\) return 'reference_mismatch'/],
    ['condiciones del catalogo', /const terms = checkoutTermsProblem\(expected, pre\.auto_recurring\)\n\s*if \(terms\) return terms/],
    ['init_point propio', /if \(!preapprovalCheckoutUrl\(pre\)\) return 'no_init_point'/],
  ]) if (!re.test(validacion)) f.push(`checkoutProblem dejo de exigir: ${regla}`)

  // La frecuencia se valida con una tabla CERRADA de equivalencias (anual = 12
  // months o 1 years; mensual y trimestral, una sola).
  const catalog = codigo(s.catalog)
  const tabla = tramo(catalog, 'export const CYCLE_FREQUENCIES', '\n}\n').replace(/\s+/g, ' ')
  const esperada = "monthly: [{ frequency: 1, frequencyType: 'months' }], quarterly: [{ frequency: 3, frequencyType: 'months' }], annual: [{ frequency: 12, frequencyType: 'months' }, { frequency: 1, frequencyType: 'years' }],"
  if (!tabla.includes(esperada)) f.push('la tabla de frecuencias equivalentes cambio (se amplio o se achico sin evidencia de Mercado Pago)')
  if (!/\.some\(\(f\) => f\.frequency === amount && f\.frequencyType === unit\)/.test(catalog)) f.push('la frecuencia dejo de compararse de forma exacta contra la tabla')
  const condiciones = tramo(catalog, 'export function checkoutTermsProblem', '\n}\n')
  for (const [regla, re] of [
    ['importe', /Math\.abs\(got - want\) >= 0\.005\) return 'amount_mismatch'/],
    ['moneda', /currency !== expected\.currency\.trim\(\)\.toUpperCase\(\)\) return 'currency_mismatch'/],
    ['frecuencia', /if \(!matchesBillingCycleFrequency\(expected\.billingCycle, r\.frequency, r\.frequency_type\)\) return 'frequency_mismatch'/],
  ]) if (!re.test(condiciones)) f.push(`checkoutTermsProblem dejo de comparar: ${regla}`)
  if (/Deno\.env|getEnv|MP_PLAN_/.test(catalog)) f.push('el catalogo volvio a depender de secrets / planes del panel de Mercado Pago')

  // Mercado Pago se lee por id. Nada de busquedas ni de planes del panel.
  const mp = codigo(s.mpClient)
  if (/preapproval\/search|preapproval_plan\/|payer_email=/.test(mp)) f.push('mpClient volvio a buscar suscripciones (por plan, email, etc.) o a leer planes del panel')
  if (!/status: 'pending',/.test(tramo(mp, 'async createPendingPreapproval', 'getPreapproval:'))) f.push('el preapproval dejo de crearse en estado pending')

  // Un solo camino escribe el acceso. El negocio se resuelve por el id del
  // preapproval que el servidor vinculo; el plan es el de ESA sesion.
  const unbound = tramo(pre, 'async function applyToUnbound', 'async function noteUnauthorized')
  if (!/const session = await ctx\.store\.findCheckoutSessionByPreapprovalId\(pre\.id\)\n\s*if \(!session\) return outcome\(pre, mpState, \{ kind: 'not_applied', reason: 'unknown_preapproval' \}\)/.test(unbound)) {
    f.push('un preapproval que el servidor no vinculo ya no falla cerrado (unknown_preapproval)')
  }
  if (/findCheckoutSessionByReference/.test(pre + webhook)) f.push('el camino canonico vuelve a resolver un negocio por external_reference (Mercado Pago puede no devolverla)')
  if (!/if \(referenceConflicts\(pre, session\)\) \{/.test(unbound)) f.push('se dejo de contrastar la external_reference que devuelve Mercado Pago')
  if (!/return reported !== '' && reported !== session\.external_reference/.test(pre)) f.push('referenceConflicts cambio: una referencia ausente tiene que valer y una distinta no')
  const condicionesOk = unbound.indexOf('if (termsProblem) {')
  const otorgar = unbound.indexOf('subscription_plan: session.plan_id,')
  if (otorgar < 0) f.push('el plan otorgado dejo de salir de la sesion que origino el preapproval')
  if (condicionesOk < 0 || !/const termsProblem = checkoutTermsProblem\(\s*\{ billingCycle: session\.billing_cycle, amount: session\.amount, currency: session\.currency \}, pre\.auto_recurring,\s*\)/.test(unbound)) {
    f.push('se dejo de comparar lo que cobra Mercado Pago con las condiciones de la sesion')
  } else if (otorgar >= 0 && condicionesOk > otorgar) f.push('el plan se otorga antes de comparar las condiciones')
  if (!/if \(mpState !== 'authorized'\) \{/.test(unbound) || unbound.indexOf("if (mpState !== 'authorized') {") > otorgar) f.push('un preapproval que no esta authorized puede activar')
  if (!/\.eq\('mp_preapproval_id', preapprovalId\)\.maybeSingle\(\)/.test(tramo(store, 'async findCheckoutSessionByPreapprovalId', 'async findCheckoutSessionByReference'))) {
    f.push('la sesion dejo de buscarse por el id exacto del preapproval (maybeSingle)')
  }
  if (/\.(eq|ilike|like|gte|lte)\('(payer_email|mp_payer_email|amount|created_at|current_period_start)'/.test(store)) f.push('el store busca por email, importe o fecha: eso no es identidad')

  // reconcile: relee por id los preapprovals de las sesiones de ESE negocio.
  const reconcile = tramo(actions, 'async function reconcile', 'interface ReconcileFacts')
  if (!/const pre = await ctx\.mp\.getPreapproval\(session\.mp_preapproval_id as string\)/.test(reconcile)) f.push('reconcile dejo de leer el preapproval por el id guardado en la sesion')
  if (!/if \(!pre \|\| pre\.id !== session\.mp_preapproval_id\) continue/.test(reconcile)) f.push('reconcile aplica un preapproval que no es el de la sesion')
  if ((reconcile.match(/applyPreapprovalEvidence\(ctx, \w+, \{ source: 'reconcile', expectBusinessId: businessId \}\)/g) ?? []).length !== 2) f.push('reconcile aplica evidencia sin fijar el negocio autorizado')
  if (/payer|e-?mail|\.amount|date_created/i.test(reconcile)) f.push('reconcile usa email, importe o fecha para encontrar un pago')

  // El email que informa Mercado Pago (`pre.payer_email`) solo se anota en el
  // negocio como bitacora. Ni el camino canonico ni el webhook deciden por el.
  const bitacora = /if \(typeof pre\.payer_email === 'string' && pre\.payer_email\) patch\.mp_payer_email = pre\.payer_email|mp_payer_email: typeof pre\.payer_email === 'string' && pre\.payer_email \? pre\.payer_email : null,/g
  if ((pre.match(bitacora) ?? []).length !== 2) f.push('el camino canonico dejo de anotar el payer_email de Mercado Pago como bitacora')
  if (/payer|e-?mail/i.test(pre.replace(bitacora, '') + webhook)) f.push('el camino canonico o el webhook usan un email para decidir (el email del pagador no es identidad)')

  // El rechazo que dispara «ingresa otro email» es una lista CERRADA: el 400 de
  // POST /preapproval con el mensaje medido, o uno que nombre payer_email.
  const rechazo = tramo(mp, 'export function isPayerRejection', '\n}\n')
  if (!/if \(!\(error instanceof MpApiError\)\) return false\n\s*if \(error\.operation !== CREATE_PREAPPROVAL_OPERATION \|\| error\.status !== 400\) return false\n/.test(rechazo)
      || !/return \/\(\^\|:\\s\)user bad request\$\/\.test\(detail\) \|\| \/payer\[_ \]\?email\/\.test\(detail\)$/.test(rechazo)) {
    f.push('isPayerRejection se amplio: cualquier otro error de Mercado Pago no puede convertirse en «proba con otro email»')
  }

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

  // Planes: el email de Mercado Pago se pide SOLO si el servidor lo requiere, no
  // se precarga con el del login y no se guarda en el navegador.
  const plans = codigo(s.plansPage), dialog = codigo(s.emailDialog)
  if (!/const handleSelect = \(planId: SubscriptionPlan\) => startCheckout\(planId, mpPayerEmail\)/.test(plans) || !/const \[mpPayerEmail, setMpPayerEmail\] = useState\(''\)/.test(plans)) {
    f.push('Planes dejo de intentar primero sin email (el flujo normal no pide nada)')
  }
  if (!/\} else if \(subscriptionErrorCode\(e\) === MP_PAYER_EMAIL_REQUIRED\) \{\s*setPayerPrompt\(/.test(plans) || (plans.match(/setPayerPrompt\(\{/g) ?? []).length !== 2) {
    f.push('Planes abre el pedido de email por algo que no es el codigo mp_payer_email_required del servidor')
  }
  if (!/if \(email\) \{\s*setPayerPrompt\(\{ plan: planId, email, error: messageOf\(e\) \}\)\s*\} else if/.test(plans)) f.push('Planes reintenta solo cuando falla el email indicado (tiene que mostrar el error y esperar al usuario)')
  if (!/\{payerPrompt && \(\s*<MercadoPagoEmailDialog/.test(plans)) f.push('el dialogo del email de Mercado Pago dejo de ser condicional')
  if (/localStorage|sessionStorage|document\.cookie|indexedDB/.test(plans + dialog)) f.push('el email de Mercado Pago se guarda en el navegador (tiene que ser estado efimero de la pantalla)')
  if (/user\??\.email|useAuth\(\)\.user/.test(plans + dialog) || /useAuth/.test(dialog)) f.push('Planes presenta o manda el email del login como email de Mercado Pago')
  if (/supabase|\.from\(|\.rpc\(/.test(dialog)) f.push('el dialogo del email de Mercado Pago accede a datos por su cuenta')
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

  // Plan B: un preapproval pertenece a una sola sesion (y por lo tanto a un solo negocio).
  const planB = sinComentariosSql(s.planBMigration)
  if (!/CREATE UNIQUE INDEX IF NOT EXISTS uq_scs_mp_preapproval\s+ON public\.subscription_checkout_sessions \(mp_preapproval_id\)\s+WHERE mp_preapproval_id IS NOT NULL;/.test(planB)) f.push('Plan B: falta el indice unico (mp_preapproval_id) de la sesion de checkout')
  if (!/^BEGIN;[\s\S]*^COMMIT;\s*$/m.test(planB)) f.push('Plan B: la migracion no corre en una transaccion explicita')
  if (/\b(UPDATE|DELETE FROM|INSERT INTO)\s+public\.(businesses|payments|subscription_events|subscription_checkout_sessions)\b/i.test(planB)) f.push('Plan B: la migracion hace DML (tenia que ser cero)')
  if (/\b(GRANT|REVOKE|CREATE POLICY|DROP POLICY)\b/i.test(planB)) f.push('Plan B: la migracion toca grants o policies (no tenia que cambiar el acceso)')

  for (const { nombre, sql: crudo } of s.migraciones) {
    if (nombre <= MIGRATION) continue
    const posterior = sinComentariosSql(crudo)
    if (grantACliente.test(posterior)) f.push(`${nombre}: le devuelve la tabla de checkout a un rol de cliente`)
    if (/CREATE POLICY[^;]*ON\s+(public\.)?"?subscription_checkout_sessions"?[^;]*FOR\s+(INSERT|UPDATE|ALL)/i.test(posterior)) f.push(`${nombre}: recrea una policy de escritura sobre la tabla de checkout`)
    if (/CREATE\s+UNIQUE\s+INDEX[^;]*subscription_events[^;]*\(\s*"?provider"?\s*,\s*"?event_type"?\s*,\s*"?external_id"?\s*\)/i.test(posterior)) f.push(`${nombre}: vuelve al dedupe de eventos por recurso`)
    if (/DROP INDEX[^;]*uq_subscription_events_notification/i.test(posterior)) f.push(`${nombre}: elimina el dedupe por notificacion`)
    if (nombre > PLAN_B_MIGRATION && /DROP INDEX[^;]*uq_scs_mp_preapproval/i.test(posterior)) f.push(`${nombre}: elimina la unicidad preapproval → sesion`)
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
  const planB = migraciones.find((m) => m.nombre === PLAN_B_MIGRATION)
  if (!planB) throw new Error(`falta la migracion ${PLAN_B_MIGRATION}`)
  return {
    planBMigration: planB.sql,
    mpClient: read(`${BILLING}/mpClient.ts`),
    subIndex: read('supabase/functions/mp-subscription/index.ts'),
    hookIndex: read('supabase/functions/mp-webhook/index.ts'),
    actions: read(`${BILLING}/subscriptionActions.ts`),
    preapproval: read(`${BILLING}/preapproval.ts`),
    webhook: read(`${BILLING}/webhook.ts`),
    store: read(`${BILLING}/store.ts`),
    catalog: read(`${BILLING}/planCatalog.ts`),
    service: read('src/services/subscriptionService.ts'),
    pendingPage: read('src/pages/PaymentPending.tsx'),
    plansPage: read('src/pages/Plans.tsx'),
    emailDialog: read('src/components/subscription/MercadoPagoEmailDialog.tsx'),
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
    ['create: escribe el negocio', con('actions', "  ctx.log({\n    event: 'checkout_opened'", "  await ctx.store.updateBusinessBilling(businessId, { subscription_plan: plan }, ctx.now().toISOString())\n  ctx.log({\n    event: 'checkout_opened'"), 'abrir un checkout'],
    ['create: activa al abrir el checkout', con('actions', "  ctx.log({\n    event: 'checkout_opened'", "  await applyPreapprovalEvidence(ctx, created, { source: 'reconcile' })\n  ctx.log({\n    event: 'checkout_opened'"), 'abrir un checkout'],
    ['create: cancela la suscripcion vigente', con('actions', "  ctx.log({\n    event: 'checkout_opened'", "  if (business.mp_preapproval_id) await ctx.mp.cancelPreapproval(business.mp_preapproval_id)\n  ctx.log({\n    event: 'checkout_opened'"), 'suscripcion vigente'],
    ['create: email del campo viejo del body', con('actions', '  const payerEmail = payer.email\n', '  const payerEmail = String(req.body.payer_email)\n'), 'dato del navegador'],
    ['email: mp_payer_email sin pasar por la validacion', con('actions', '  const payerEmail = payer.email\n', '  const payerEmail = typeof req.body.mp_payer_email === "string" ? req.body.mp_payer_email : payer.email\n'), 'fuera de resolvePayerEmail'],
    ['email: pide otro sin haber intentado con el del JWT', con('actions', '  if (raw === undefined || raw === null) {', '  if (raw === undefined) return { ok: false, response: PAYER_EMAIL_REQUIRED() }\n  if (raw === null) {'), 'primer intento'],
    ['email: sin validar el formato', con('actions', ' || !PAYER_EMAIL_RE.test(email)) {', ') {'), 'dejo de validarse'],
    ['email: sin normalizar', con('actions', '  const email = raw.trim().toLowerCase()\n', '  const email = raw\n'), 'dejo de validarse'],
    ['email: acepta lo que no es texto', con('actions', "  if (typeof raw !== 'string') return invalid('El email de Mercado Pago no es válido.')\n", ''), 'dejo de validarse'],
    ['email: cualquier error de MP pide otro email', con('actions', '    if (isPayerRejection(error)) {', '    if (error instanceof MpApiError) {'), 'rechazo del pagador'],
    ['email: el email ya indicado vuelve a pedirse (loop)', con('actions', '      return payer.explicit\n', '      return false\n'), 'rechazo del pagador'],
    ['email: el rechazo del pagador tapa el resto de los errores', con('actions', "        : PAYER_EMAIL_REQUIRED()\n    }\n    throw error\n", "        : PAYER_EMAIL_REQUIRED()\n    }\n    return PAYER_EMAIL_REQUIRED()\n"), 'rechazo del pagador'],
    ['email: reconcile lee el email del body', con('actions', '  // 1. La suscripción ya vinculada al negocio.\n  if (before.mp_preapproval_id) {', '  const email = body_email\n  if (before.mp_preapproval_id) {'), 'email, importe o fecha'],
    ['email: cancel acepta mp_payer_email', con('actions', "  const alreadyCancelled = preapprovalState(pre.status) === 'cancelled'\n", "  const alreadyCancelled = preapprovalState(pre.status) === 'cancelled' || req.body.mp_payer_email === pre.payer_email\n"), 'fuera de resolvePayerEmail'],
    ['email: status devuelve la sesion por email del pagador', con('actions', '  const [latest] = await ctx.store.listCheckoutSessions(businessId, 1)\n  return {\n    status: 200,\n    body: { source', '  const [latest] = (await ctx.store.listCheckoutSessions(businessId, 5)).filter((s) => s.payer_email)\n  return {\n    status: 200,\n    body: { source'), 'no es create usa un email'],
    ['email: el canonico resuelve la sesion por el email del pagador', con('preapproval', "  if (!session) return outcome(pre, mpState, { kind: 'not_applied', reason: 'unknown_preapproval' })\n", "  if (!session && !pre.payer_email) return outcome(pre, mpState, { kind: 'not_applied', reason: 'unknown_preapproval' })\n"), 'usan un email para decidir'],
    ['email: el webhook mira el email del pagador', con('webhook', "  const applied = await applyPreapprovalEvidence(ctx, pre, { source: 'webhook' })\n", "  if (pre.payer_email) ctx.log({ event: 'x' })\n  const applied = await applyPreapprovalEvidence(ctx, pre, { source: 'webhook' })\n"), 'usan un email para decidir'],
    ['email: cualquier 400 de MP es rechazo del pagador', con('mpClient', "  return /(^|:\\s)user bad request$/.test(detail) || /payer[_ ]?email/.test(detail)\n", '  return true\n'), 'isPayerRejection se amplio'],
    ['email: rechazo del pagador con cualquier status', con('mpClient', 'error.operation !== CREATE_PREAPPROVAL_OPERATION || error.status !== 400', 'error.operation !== CREATE_PREAPPROVAL_OPERATION'), 'isPayerRejection se amplio'],
    ['email: rechazo del pagador en cualquier operacion', con('mpClient', 'error.operation !== CREATE_PREAPPROVAL_OPERATION || error.status !== 400', 'error.status !== 400'), 'isPayerRejection se amplio'],
    ['Planes: pide el email a todos', con('plansPage', '  const handleSelect = (planId: SubscriptionPlan) => startCheckout(planId, mpPayerEmail)', "  const handleSelect = (planId: SubscriptionPlan) => setPayerPrompt({ plan: planId, email: '', error: '' })"), 'intentar primero sin email'],
    ['Planes: abre el pedido ante cualquier error', con('plansPage', '      } else if (subscriptionErrorCode(e) === MP_PAYER_EMAIL_REQUIRED) {', '      } else if (e) {'), 'no es el codigo'],
    ['Planes: reintenta solo cuando falla el email', con('plansPage', '        setPayerPrompt({ plan: planId, email, error: messageOf(e) })\n', '        void startCheckout(planId, email)\n'), 'no es el codigo'],
    ['Planes: guarda el email en el navegador', con('plansPage', '      if (email) setMpPayerEmail(email)\n', "      if (email) { setMpPayerEmail(email); localStorage.setItem('mp_payer_email', email) }\n"), 'se guarda en el navegador'],
    ['Planes: manda el email del login como email de MP', con('plansPage', '  const { businessId } = useAuth()', '  const { businessId, user } = useAuth()\n  const loginEmail = user?.email'), 'email del login'],
    ['Dialogo: precarga el email del login', con('emailDialog', "import { AppButton, AppInput, AppModal } from '../../ui'", "import { AppButton, AppInput, AppModal } from '../../ui'\nimport { useAuth } from '../../contexts/AuthContext'"), 'email del login'],
    ['Dialogo: siempre visible', con('plansPage', '      {payerPrompt && (', '      {(payerPrompt ?? { plan: "pro", email: "", error: "" }) && ('), 'dejo de ser condicional'],
    ['create: importe del body', con('actions', '  const terms = ctx.catalog.termsFor(plan, billingCycle)\n', '  const terms = { ...ctx.catalog.termsFor(plan, billingCycle)!, amount: Number(req.body.amount) }\n'), 'dato del navegador'],
    ['create: importe fijo, sin catalogo', con('actions', '  const terms = ctx.catalog.termsFor(plan, billingCycle)\n', "  const terms = { amount: 1, currency: 'ARS', frequency: 1, frequencyType: 'months' as const }\n"), 'catalogo del servidor'],
    ['create: referencia del body', con('actions', '      externalReference: reference,\n', '      externalReference: String(req.body.external_reference),\n'), 'dato del navegador'],
    ['create: cobra otro importe que el de la sesion', con('actions', '      amount: terms.amount,\n      currency: terms.currency,\n    })\n  } catch (error) {\n    await closeSession', '      amount: 1,\n      currency: terms.currency,\n    })\n  } catch (error) {\n    await closeSession'), 'condiciones que fija el servidor'],
    ['create: entrega el checkout sin guardar el id', con('actions', '    await ctx.store.updateCheckoutSession(session.id, { mp_preapproval_id: created.id }, ctx.now().toISOString())\n', '    await Promise.resolve()\n'), 'perdio un paso'],
    ['create: guarda el id DESPUES de armar la respuesta', {
      ...base,
      actions: mutar(
        mutar(base.actions, '    await ctx.store.updateCheckoutSession(session.id, { mp_preapproval_id: created.id }, ctx.now().toISOString())\n', '    await Promise.resolve()\n'),
        '  return { status: 200, body: { init_point: checkoutUrl, checkout: summary } }\n}',
        '  const respuesta = { status: 200, body: { init_point: checkoutUrl, checkout: summary } }\n  void ctx.store.updateCheckoutSession(session.id, { mp_preapproval_id: created.id }, ctx.now().toISOString())\n  return respuesta\n}',
      ),
    }, 'antes de guardar el id'],
    ['create: no valida la respuesta de Mercado Pago', con('actions', '  const checkoutUrl = problem ? null : preapprovalCheckoutUrl(created)\n', '  const checkoutUrl = preapprovalCheckoutUrl(created)\n'), 'respuesta invalida'],
    ['create: el vinculo falla y sigue', con('actions', "    await discardUnlinkedPreapproval(ctx, created, reference)\n    await closeSession(ctx, session.id, 'failed')\n    throw error\n  }\n\n  ctx.log({", "    await discardUnlinkedPreapproval(ctx, created, reference)\n    await closeSession(ctx, session.id, 'failed')\n  }\n\n  ctx.log({"), 'ya no falla cerrado'],
    ['discard: cancela el preapproval de otra sesion', con('actions', '    if (await ctx.store.findCheckoutSessionByPreapprovalId(createdId)) return\n', ''), 'no es el recien creado'],
    ['discard: cancela aunque lleve otra referencia', con('actions', "  if (reported !== '' && reported !== reference) return\n  try {", '  try {'), 'no es el recien creado'],
    ['checkout: acepta un preapproval ya authorized', con('actions', "  if (preapprovalState(pre.status) !== 'pending') return 'not_pending'\n", ''), 'dejo de exigir: estado pending'],
    ['checkout: acepta otra referencia', con('actions', "  if (reported !== '' && reported !== reference) return 'reference_mismatch'\n", ''), 'dejo de exigir: referencia'],
    ['checkout: no compara las condiciones', con('actions', '  if (terms) return terms\n', ''), 'dejo de exigir: condiciones'],
    ['checkout: cualquier init_point', con('actions', "  if (!preapprovalCheckoutUrl(pre)) return 'no_init_point'\n", ''), 'dejo de exigir: init_point'],
    ['frecuencia: cualquier cantidad de years es anual', con('catalog', 'f.frequency === amount && f.frequencyType === unit', 'f.frequencyType === unit'), 'forma exacta'],
    ['frecuencia: mensual acepta 1 years', con('catalog', "monthly:   [{ frequency: 1, frequencyType: 'months' }],", "monthly:   [{ frequency: 1, frequencyType: 'months' }, { frequency: 1, frequencyType: 'years' }],"), 'tabla de frecuencias'],
    ['frecuencia: el anual pierde 1 years', con('catalog', ", { frequency: 1, frequencyType: 'years' }],", '],'), 'tabla de frecuencias'],
    ['condiciones: no compara el importe', con('catalog', "Math.abs(got - want) >= 0.005) return 'amount_mismatch'", "false) return 'amount_mismatch'"), 'dejo de comparar: importe'],
    ['condiciones: no compara la moneda', con('catalog', "currency !== expected.currency.trim().toUpperCase()) return 'currency_mismatch'", "false) return 'currency_mismatch'"), 'dejo de comparar: moneda'],
    ['condiciones: no compara la frecuencia', con('catalog', "  if (!matchesBillingCycleFrequency(expected.billingCycle, r.frequency, r.frequency_type)) return 'frequency_mismatch'\n", ''), 'dejo de comparar: frecuencia'],
    ['catalogo: vuelve a los planes del panel', con('catalog', 'export const BILLING_CURRENCY', "export const planDelPanel = (getEnv: (k: string) => string) => getEnv('MP_PLAN_PRO_MONTHLY')\nexport const BILLING_CURRENCY"), 'planes del panel'],
    ['mp: busca suscripciones por email', con('mpClient', '// ── Normalización de estados', "export const buscar = (email: string) => fetch(`https://api.mercadopago.com/preapproval/search?payer_email=${email}`)\n// ── Normalización de estados"), 'volvio a buscar'],
    ['mp: crea el preapproval ya authorized', con('mpClient', "          status: 'pending',", "          status: 'authorized',"), 'crearse en estado pending'],
    ['canonico: un id desconocido vincula por referencia', con('preapproval', "  if (!session) return outcome(pre, mpState, { kind: 'not_applied', reason: 'unknown_preapproval' })\n", "  if (!session && !(await ctx.store.findCheckoutSessionByReference(reportedReference(pre)))) return outcome(pre, mpState, { kind: 'not_applied', reason: 'unknown_preapproval' })\n"), 'por external_reference'],
    ['canonico: un id desconocido no falla cerrado', con('preapproval', "  if (!session) return outcome(pre, mpState, { kind: 'not_applied', reason: 'unknown_preapproval' })\n", "  if (!session) throw new Error('sin sesion')\n"), 'unknown_preapproval'],
    ['canonico: no contrasta la referencia de MP', con('preapproval', '  if (referenceConflicts(pre, session)) {', '  if (false) {'), 'dejo de contrastar'],
    ['canonico: exige la referencia (Mercado Pago no la devuelve)', con('preapproval', "return reported !== '' && reported !== session.external_reference", 'return reported !== session.external_reference'), 'referenceConflicts cambio'],
    ['canonico: no compara las condiciones', con('preapproval', '  if (termsProblem) {', '  if (false) {'), 'se dejo de comparar lo que cobra'],
    ['canonico: plan fijo en vez del de la sesion', con('preapproval', '    subscription_plan: session.plan_id,\n', "    subscription_plan: 'full',\n"), 'dejo de salir de la sesion'],
    ['canonico: pending activa', con('preapproval', "  if (mpState !== 'authorized') {", "  if (mpState === 'cancelled') {"), 'no esta authorized'],
    ['store: busca la sesion por email del pagador', con('store', '/** Capacidad canónica', "export const porEmail = (c: SupabaseLike, email: string) => c.from('subscription_checkout_sessions').select('id').eq('payer_email', email)\n/** Capacidad canónica"), 'no es identidad'],
    ['store: la sesion por preapproval admite varias filas', con('store', ".select(SESSION_COLUMNS)\n        .eq('mp_preapproval_id', preapprovalId).maybeSingle())", ".select(SESSION_COLUMNS)\n        .eq('mp_preapproval_id', preapprovalId).limit(1).maybeSingle())"), 'id exacto'],
    ['reconcile: no fija el negocio', con('actions', "    const applied = await applyPreapprovalEvidence(ctx, pre, { source: 'reconcile', expectBusinessId: businessId })", "    const applied = await applyPreapprovalEvidence(ctx, pre, { source: 'reconcile' })"), 'sin fijar el negocio'],
    ['reconcile: aplica un preapproval que no es el de la sesion', con('actions', '    if (!pre || pre.id !== session.mp_preapproval_id) continue\n', '    if (!pre) continue\n'), 'no es el de la sesion'],
    ['reconcile: busca por email', con('actions', '  // 1. La suscripción ya vinculada al negocio.\n  if (before.mp_preapproval_id) {', '  const porEmail = before.mp_payer_email ?? req_payer_email\n  if (before.mp_preapproval_id) {'), 'email, importe o fecha'],
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
    ['Plan B: el indice deja de ser unico', con('planBMigration', 'CREATE UNIQUE INDEX IF NOT EXISTS uq_scs_mp_preapproval', 'CREATE INDEX IF NOT EXISTS uq_scs_mp_preapproval'), 'falta el indice unico'],
    ['Plan B: la migracion vincula a mano el smoke', con('planBMigration', 'COMMIT;\n', "UPDATE public.businesses SET mp_preapproval_id = '33b5f5ad' WHERE name = 'x';\nCOMMIT;\n"), 'Plan B: la migracion hace DML'],
    ['Plan B: la migracion abre la tabla', con('planBMigration', 'COMMIT;\n', 'GRANT SELECT ON TABLE public.subscription_checkout_sessions TO authenticated;\nCOMMIT;\n'), 'toca grants o policies'],
    ['posterior: borra la unicidad preapproval → sesion', posterior('DROP INDEX IF EXISTS public.uq_scs_mp_preapproval;'), 'unicidad preapproval'],
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
console.log('BETA-MP guard OK: Edge Functions como cableado, autorizacion uniforme antes de todo, checkout sin escritura de businesses, preapproval creado por el servidor y vinculado antes de responder, activacion por id de preapproval (sin referencia sola, email, importe ni fecha) con el plan y las condiciones de la sesion, webhook con firma obligatoria e idempotencia por notificacion, navegador sin acceso a la sesion de checkout, migraciones sin reapertura.')
