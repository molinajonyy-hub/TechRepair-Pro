// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Plan B — abrir un checkout.
//
// `create` registra la intención en `subscription_checkout_sessions`, crea EN
// MERCADO PAGO un preapproval `pending` con el precio del catálogo del servidor,
// guarda su id en la sesión y recién entonces devuelve el `init_point` de ESE
// preapproval. No termina un trial, no cambia un plan activo, no reactiva una
// cuenta cancelada, no otorga features y no cancela la suscripción vigente.
//
// Por qué Plan B: en el smoke real del 2026-10-02 el checkout por URL de un plan
// de Mercado Pago dejó un preapproval `authorized` con `external_reference`
// vacía. Sin un id conocido de antemano ese pago no se puede vincular.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CYCLE_FREQUENCIES, PLAN_PRICES, buildPlanCatalog, checkoutTermsProblem, matchesBillingCycleFrequency,
} from '../../../supabase/functions/_shared/billing/planCatalog.ts'
import { parseCheckoutReference } from '../../../supabase/functions/_shared/billing/preapproval.ts'
import { CHECKOUT_LINK_GRACE_MS } from '../../../supabase/functions/_shared/billing/subscriptionActions.ts'
import { BIZ_A, BIZ_B, DAY, HOUR, ORIGIN, OWNER_A, OWNER_B, World } from './harness.ts'

let w: World
beforeEach(() => { w = new World() })

const create = (plan = 'pro', billingCycle = 'monthly', extra: Record<string, unknown> = {}) =>
  w.call(OWNER_A, { action: 'create', business_id: BIZ_A, plan, billing_cycle: billingCycle, ...extra })

const sessions = () => w.db.tables.subscription_checkout_sessions
/** El cuerpo del único `POST /preapproval` que llegó a Mercado Pago. */
const posted = () => {
  expect(w.mp.created()).toHaveLength(1)
  return w.mp.created()[0].body as Record<string, unknown>
}

describe('create crea el preapproval en el servidor y lo vincula antes de responder', () => {
  it('crea un preapproval pending en Mercado Pago y devuelve SU init_point', async () => {
    const res = await create('pro')

    expect(res.status).toBe(200)
    const creado = [...w.mp.preapprovals.values()]
    expect(creado).toHaveLength(1)
    expect(creado[0].status).toBe('pending')
    expect(res.body.init_point).toBe(creado[0].init_point)
    expect(String(res.body.init_point)).toBe(`https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=${creado[0].id}`)
    expect(res.body.checkout).toEqual({ status: 'pending', plan: 'pro', billing_cycle: 'monthly' })
  })

  it('el id del preapproval queda en la sesión ANTES de devolver el checkout', async () => {
    // Línea de tiempo: qué había escrito la base cuando se llamó a Mercado Pago.
    const original = w.mp.fetchImpl
    let escritasAlCrear: string[] = []
    w.mp.fetchImpl = async (input, init) => {
      if ((init?.method ?? 'GET') === 'POST') escritasAlCrear = w.db.writes.map((x) => `${x.op}:${x.columns.includes('mp_preapproval_id') ? 'link' : 'row'}`)
      return original(input, init)
    }

    const res = await create('pro')
    const [session] = sessions()
    const [pre] = [...w.mp.preapprovals.values()]

    // Al llamar a MP la sesión ya existía, todavía sin preapproval…
    expect(escritasAlCrear).toEqual(['insert:row'])
    // …y al responder, el vínculo ya estaba escrito.
    expect(w.db.writesTo('subscription_checkout_sessions').map((x) => x.op)).toEqual(['insert', 'update'])
    expect(w.db.writesTo('subscription_checkout_sessions')[1].columns).toContain('mp_preapproval_id')
    expect(session.mp_preapproval_id).toBe(pre.id)
    expect(new URL(String(res.body.init_point)).searchParams.get('preapproval_id')).toBe(session.mp_preapproval_id)
  })

  it('si el vínculo no se puede escribir, NO se entrega el checkout y el preapproval se cancela', async () => {
    w.db.failOn = { table: 'subscription_checkout_sessions', op: 'update', code: 'XX000' }
    const res = await create('pro')

    expect(res.status).toBe(503)
    expect(res.body.code).toBe('billing_unavailable')
    expect(res.body.init_point).toBeUndefined()
    // Un preapproval que el servidor no pudo vincular no queda pagable.
    const [pre] = [...w.mp.preapprovals.values()]
    expect(pre.status).toBe('cancelled')
    expect(sessions()[0]).toMatchObject({ status: 'failed', mp_preapproval_id: null })
    expect(w.db.writesTo('businesses')).toEqual([])
  })

  it('al navegador no le llega el id del preapproval ni la referencia como dato', async () => {
    const res = await create('pro')
    expect(Object.keys(res.body).sort()).toEqual(['checkout', 'init_point'])
    expect(JSON.stringify(res.body)).not.toMatch(/trpcs_/)
  })

  it('manda a Mercado Pago referencia del servidor, email del JWT, back_url permitida y estado pending', async () => {
    await create('pro')
    const body = posted()

    expect(body).toMatchObject({
      status: 'pending',
      payer_email: 'aaaaaaaa@invalid.test',
      back_url: `${ORIGIN}/subscription/pending`,
      reason: 'TechRepair Pro - Plan Pro (mensual)',
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 25000, currency_id: 'ARS' },
    })
    expect(body.external_reference).toBe(sessions()[0].external_reference)
    expect(parseCheckoutReference(body.external_reference)).not.toBeNull()
    // No se crea contra un plan de Mercado Pago ni con un medio de pago.
    expect(body.preapproval_plan_id).toBeUndefined()
    expect(body.card_token_id).toBeUndefined()
    // Un reintento de red del mismo checkout no crea una segunda suscripción.
    expect(w.mp.created()[0].idempotencyKey).toBe(`create-${body.external_reference}`)
  })

  it('con la base SIN la migración BETA-MP, `create` falla cerrado: 503, sin llamar a Mercado Pago', async () => {
    w.db.preMigration = true
    const res = await create('pro')
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('billing_unavailable')
    expect(res.body.init_point).toBeUndefined()
    expect(sessions()).toHaveLength(0)
    expect(w.mp.created()).toEqual([])
    expect(w.db.writesTo('businesses')).toEqual([])
  })
})

describe('el negocio conserva su estado mientras no paga', () => {
  it('iniciar un checkout durante el trial NO modifica el trial', async () => {
    const antes = w.snapshot(BIZ_A)
    const res = await create('pro')

    expect(res.status).toBe(200)
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(w.db.business(BIZ_A).subscription_status).toBe('trialing')
    expect(w.db.business(BIZ_A).trial_ends_at).toBe('2026-10-07T12:00:00.000Z')
    // Ni una sola escritura sobre `businesses`.
    expect(w.db.writesTo('businesses')).toEqual([])
  })

  it('nunca escribe pending_activation', async () => {
    await create('pro')
    await create('full')
    expect(w.db.tables.businesses.map((b) => b.subscription_status)).not.toContain('pending_activation')
  })

  it('iniciar un checkout con una suscripción activa NO cambia plan ni estado, ni cancela la vigente', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_a')
    const antes = w.snapshot(BIZ_A)
    w.mp.calls.length = 0

    const res = await create('full')

    expect(res.status).toBe(200)
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(w.db.business(BIZ_A)).toMatchObject({ subscription_status: 'active', subscription_plan: 'basico', mp_preapproval_id: 'pre_a' })
    // Antes de BETA-MP `create` cancelaba el preapproval vigente ANTES del pago.
    expect(w.mp.callsTo('PUT', '/preapproval/')).toEqual([])
    expect(w.mp.preapprovals.get('pre_a')?.status).toBe('authorized')
  })

  it('abandonar el checkout NO pierde acceso: pasan los días y el trial sigue igual', async () => {
    const antes = w.snapshot(BIZ_A)
    await create('pro')
    w.advance(3 * DAY)
    // El usuario vuelve a la app y «verifica»: en Mercado Pago sigue pending.
    const verificar = await w.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })

    expect(verificar.body.activated).toBe(false)
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })

  it('un trial vencido (suspended) que abre el checkout NO sale del muro', async () => {
    Object.assign(w.db.business(BIZ_A), { subscription_status: 'suspended', trial_ends_at: '2026-09-20T12:00:00.000Z' })
    await create('basico')
    expect(w.db.business(BIZ_A).subscription_status).toBe('suspended')
  })

  it('una cuenta cancelada que abre el checkout NO queda activa', async () => {
    Object.assign(w.db.business(BIZ_A), { subscription_status: 'canceled', subscription_plan: 'pro' })
    await create('pro')
    expect(w.db.business(BIZ_A)).toMatchObject({ subscription_status: 'canceled', subscription_plan: 'pro' })
  })

  it('pedir Full NO concede Full', async () => {
    const res = await create('full')
    expect(res.status).toBe(200)
    expect(w.db.business(BIZ_A).subscription_plan).toBeNull()
    expect(w.db.business(BIZ_A).access_source).toBe('trial')
    // Full queda sólo como intención.
    expect(sessions()).toHaveLength(1)
    expect(sessions()[0]).toMatchObject({ plan_id: 'full', status: 'pending' })
  })

  it('un acceso otorgado a mano no se toca por abrir un checkout', async () => {
    Object.assign(w.db.business(BIZ_A), { subscription_status: 'active', subscription_plan: 'pro', access_source: 'admin_override' })
    const antes = w.snapshot(BIZ_A)
    await create('basico')
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })
})

describe('precio, pagador y plan: los decide el servidor', () => {
  it('la sesión registra negocio, usuario, plan, ciclo, pagador, importe, referencia y preapproval', async () => {
    const res = await create('pro', 'annual')
    expect(res.status).toBe(200)
    expect(sessions()).toHaveLength(1)
    expect(sessions()[0]).toMatchObject({
      business_id: BIZ_A,
      user_id: OWNER_A,
      plan_id: 'pro',
      billing_cycle: 'annual',
      payer_email: 'aaaaaaaa@invalid.test',     // el del JWT
      amount: 240000,                           // el del catálogo del servidor
      currency: 'ARS',
      status: 'pending',
      mp_preapproval_plan_id: null,             // Plan B: sin plan de Mercado Pago
    })
    expect(sessions()[0].mp_preapproval_id).not.toBeNull()
    expect(parseCheckoutReference(sessions()[0].external_reference)).not.toBeNull()
  })

  it('importe, moneda y frecuencia mandados por el navegador se ignoran', async () => {
    const res = await create('pro', 'monthly', {
      amount: 1, price: 1, transaction_amount: 1, currency: 'USD', currency_id: 'USD',
      frequency: 99, frequency_type: 'days',
      auto_recurring: { frequency: 99, frequency_type: 'days', transaction_amount: 1, currency_id: 'USD' },
    })
    expect(res.status).toBe(200)
    expect(posted().auto_recurring).toEqual({ frequency: 1, frequency_type: 'months', transaction_amount: 25000, currency_id: 'ARS' })
    expect(sessions()[0]).toMatchObject({ amount: 25000, currency: 'ARS' })
  })

  it('un plan «de más» en el body no cambia lo que se cobra ni lo que se registra', async () => {
    await create('basico', 'monthly', { plan_id: 'full', preapproval_plan_id: 'mpplan_full_m', mp_plan_id: 'mpplan_full_m', reason: 'Plan Full gratis' })
    expect(posted()).toMatchObject({
      reason: 'TechRepair Pro - Plan Básico (mensual)',
      auto_recurring: { transaction_amount: 15000 },
    })
    expect(posted().preapproval_plan_id).toBeUndefined()
    expect(sessions()[0]).toMatchObject({ plan_id: 'basico', amount: 15000 })
  })

  it('primer intento: el email del pagador es el del JWT, y el campo viejo `payer_email` del body se ignora', async () => {
    await create('pro', 'monthly', { payer_email: 'atacante@evil.test' })
    expect(sessions()[0].payer_email).toBe('aaaaaaaa@invalid.test')
    expect(posted().payer_email).toBe('aaaaaaaa@invalid.test')
    expect(JSON.stringify(w.mp.created())).not.toContain('atacante')
  })

  it('una referencia o un preapproval mandados por el navegador no se usan', async () => {
    const ajena = 'trpcs_99999999-9999-4999-8999-999999999999'
    const res = await create('pro', 'monthly', { external_reference: ajena, preapproval_id: 'pre_ajeno', mp_preapproval_id: 'pre_ajeno' })
    expect(res.status).toBe(200)
    expect(posted().external_reference).not.toBe(ajena)
    expect(sessions()[0].external_reference).not.toBe(ajena)
    expect(sessions()[0].mp_preapproval_id).not.toBe('pre_ajeno')
  })

  it('un usuario sin email en el JWT no abre un checkout: se le pide el de su cuenta de Mercado Pago', async () => {
    const res = await w.call(OWNER_A, { action: 'create', business_id: BIZ_A, plan: 'pro', billing_cycle: 'monthly' }, { email: null })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('mp_payer_email_required')
    expect(res.body.init_point).toBeUndefined()
    expect(w.mp.created()).toEqual([])
  })

  it.each([
    ['basico', 'monthly', 15000, 1, 'months'],
    ['pro', 'monthly', 25000, 1, 'months'],
    ['full', 'monthly', 45000, 1, 'months'],
    ['basico', 'annual', 144000, 12, 'months'],
    ['pro', 'annual', 240000, 12, 'months'],
    ['full', 'annual', 432000, 12, 'months'],
  ])('%s / %s → cobra %d cada %d %s', async (plan, cycle, amount, frequency, frequencyType) => {
    const res = await create(plan, cycle)
    expect(res.status).toBe(200)
    expect(posted().auto_recurring).toEqual({ frequency, frequency_type: frequencyType, transaction_amount: amount, currency_id: 'ARS' })
    expect(sessions()[0]).toMatchObject({ plan_id: plan, billing_cycle: cycle, amount })
  })

  it('los importes medidos en el preflight real son los del catálogo del servidor', () => {
    // Anuales medidos el 2026-10-01/02; mensual Básico cobrado en el smoke del 2026-10-02.
    expect(PLAN_PRICES).toEqual({
      basico: { monthly: 15000, annual: 144000 },
      pro: { monthly: 25000, annual: 240000 },
      full: { monthly: 45000, annual: 432000 },
    })
  })
})

describe('external_reference: una referencia inequívoca por checkout', () => {
  it('la genera el servidor y resuelve checkout → negocio → plan/ciclo', async () => {
    const { reference, session } = await w.openCheckout(OWNER_A, BIZ_A, 'pro', 'annual')
    expect(session).toMatchObject({ business_id: BIZ_A, plan_id: 'pro', billing_cycle: 'annual', external_reference: reference })
  })

  it('no es el business_id ni lo contiene', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    expect(reference).toMatch(/^trpcs_[0-9a-f-]{36}$/)
    expect(reference).not.toContain(BIZ_A)
  })

  it('cada negocio y cada plan tienen su propia referencia y su propio preapproval', async () => {
    const a = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const b = await w.openCheckout(OWNER_B, BIZ_B, 'pro')
    const a2 = await w.openCheckout(OWNER_A, BIZ_A, 'full')
    expect(new Set([a.reference, b.reference, a2.reference]).size).toBe(3)
    expect(new Set([a.preapprovalId, b.preapprovalId, a2.preapprovalId]).size).toBe(3)
  })

  it.each([
    [undefined, null],
    ['', null],
    [BIZ_A, null],                                  // un business_id suelto no es una referencia
    [`${BIZ_A}_pro_1759320000000`, null],           // el formato que armaba el navegador
    ['trpcs_no-es-un-uuid', null],
    [12345, null],
    ['trpcs_cccccccc-0000-4000-8000-000000000001', 'trpcs_cccccccc-0000-4000-8000-000000000001'],
  ])('parseCheckoutReference(%j) → %j', (raw, esperado) => {
    expect(parseCheckoutReference(raw)).toBe(esperado)
  })
})

describe('pedir dos veces el mismo checkout', () => {
  it('reutiliza la misma intención y el MISMO preapproval: no crea otro en Mercado Pago', async () => {
    const primero = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.advance(2 * HOUR)
    const segundo = await w.openCheckout(OWNER_A, BIZ_A, 'pro')

    expect(segundo.preapprovalId).toBe(primero.preapprovalId)
    expect(segundo.reference).toBe(primero.reference)
    expect(sessions()).toHaveLength(1)
    expect(w.mp.created()).toHaveLength(1)
    expect(w.mp.preapprovals.size).toBe(1)
  })

  it('una sesión vencida no se reutiliza: se marca expired y se emite otra, con otro preapproval', async () => {
    const primero = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.advance(3 * DAY)
    const segundo = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    expect(segundo.reference).not.toBe(primero.reference)
    expect(segundo.preapprovalId).not.toBe(primero.preapprovalId)
    expect(sessions().map((s) => s.status).sort()).toEqual(['expired', 'pending'])
  })

  it('si el precio del catálogo cambió, el checkout abierto con el precio anterior no se reutiliza', async () => {
    const viejo = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.prices.pro.monthly = 30000
    w.advance(HOUR)
    const nuevo = await w.openCheckout(OWNER_A, BIZ_A, 'pro')

    expect(nuevo.preapprovalId).not.toBe(viejo.preapprovalId)
    expect(nuevo.session.amount).toBe(30000)
    expect((w.mp.preapprovals.get(nuevo.preapprovalId)!.auto_recurring as Record<string, unknown>).transaction_amount).toBe(30000)
    expect(viejo.session.status).toBe('expired')
  })

  it('otro usuario del negocio (otro email de pagador) recibe su propio preapproval', async () => {
    const CO_OWNER = 'aaaaaaaa-0000-4000-8000-0000000000a3'
    w.addMember({ userId: CO_OWNER, businessId: BIZ_A, role: 'owner' })
    const primero = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.advance(HOUR)
    const res = await w.call(CO_OWNER, { action: 'create', business_id: BIZ_A, plan: 'pro', billing_cycle: 'monthly' }, { email: 'socio@invalid.test' })

    expect(res.status).toBe(200)
    expect(String(res.body.init_point)).not.toBe(String(primero.res.body.init_point))
    expect(w.mp.created().map((c) => c.body?.payer_email)).toEqual(['aaaaaaaa@invalid.test', 'socio@invalid.test'])
  })

  it('el preapproval del checkout abierto fue cancelado en Mercado Pago: se emite uno nuevo', async () => {
    const primero = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mp.preapprovals.get(primero.preapprovalId)!.status = 'cancelled'
    w.advance(HOUR)
    const segundo = await w.openCheckout(OWNER_A, BIZ_A, 'pro')

    expect(segundo.preapprovalId).not.toBe(primero.preapprovalId)
    expect(primero.session.status).toBe('canceled')
  })

  it('el checkout abierto YA está pago en Mercado Pago: no abre otro (cobraría dos veces) ni activa desde `create`', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.pay(preapprovalId)                       // pagó; el webhook nunca llegó
    const antes = w.snapshot(BIZ_A)
    const res = await create('pro')

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('checkout_already_paid')
    expect(res.body.init_point).toBeUndefined()
    expect(w.mp.created()).toHaveLength(1)
    // `create` no activa: eso es del webhook y de `reconcile`.
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    const verificar = await w.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(verificar.body).toMatchObject({ activated: true, plan: 'pro' })
  })

  it('una sesión recién insertada y todavía sin preapproval (otro request en curso) → 409, sin crear nada', async () => {
    sessions().push({
      id: 'sesion-en-curso', business_id: BIZ_A, user_id: OWNER_A, plan_id: 'pro', billing_cycle: 'monthly', amount: 25000,
      currency: 'ARS', external_reference: 'trpcs_cccccccc-0000-4000-8000-0000000000ff', status: 'pending',
      mp_preapproval_plan_id: null, mp_preapproval_id: null, payer_email: 'aaaaaaaa@invalid.test',
      created_at: w.now().toISOString(), updated_at: w.now().toISOString(), confirmed_at: null, mp_preference_id: null,
    })
    const res = await create('pro')
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('checkout_in_progress')
    expect(w.mp.created()).toEqual([])

    // Pasado el margen, esa sesión quedó huérfana: se cierra y se emite otra.
    w.advance(CHECKOUT_LINK_GRACE_MS + 1000)
    const reintento = await create('pro')
    expect(reintento.status).toBe(200)
    expect(sessions().map((s) => s.status).sort()).toEqual(['expired', 'pending'])
  })

  it('dos pedidos simultáneos: el índice único deja pasar una sola sesión pending', async () => {
    const [a, b] = await Promise.all([create('pro'), create('pro')])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(sessions().filter((s) => s.status === 'pending')).toHaveLength(1)
    expect(w.mp.created()).toHaveLength(1)
  })
})

describe('la URL de retorno la decide el servidor', () => {
  it('acepta /subscription/pending de un origen permitido', async () => {
    await create('pro', 'monthly', { back_url: `${ORIGIN}/subscription/pending` })
    expect(posted().back_url).toBe(`${ORIGIN}/subscription/pending`)
  })

  it.each([
    'https://evil.example/subscription/pending',
    `${ORIGIN}/subscription/success`,
    `${ORIGIN}/subscription/pending?success=true`,
    'javascript:alert(1)',
    42,
  ])('ignora un back_url ajeno o manipulado (%j)', async (backUrl) => {
    await create('pro', 'monthly', { back_url: backUrl })
    expect(posted().back_url).toBe(`${ORIGIN}/subscription/pending`)
  })
})

describe('plan y ciclo: validados por el servidor, fail-closed', () => {
  it.each([
    ['enterprise', 'monthly'],
    ['pro', 'weekly'],
    [undefined, 'monthly'],
    ['pro', undefined],
    [{ plan: 'full' }, 'monthly'],
  ])('plan=%j ciclo=%j → 400, sin sesión y sin llamar a Mercado Pago', async (plan, cycle) => {
    const res = await w.call(OWNER_A, { action: 'create', business_id: BIZ_A, plan, billing_cycle: cycle })
    expect(res.status).toBe(400)
    expect(sessions()).toHaveLength(0)
    expect(w.mp.calls).toEqual([])
  })

  it('un ciclo sin precio en el catálogo (trimestral) → 503, sin sesión', async () => {
    const res = await create('pro', 'quarterly')
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('plan_not_configured')
    expect(sessions()).toHaveLength(0)
    expect(w.mp.calls).toEqual([])
  })

  it('trimestral con precio configurado → 3 / months', async () => {
    w.prices.pro.quarterly = 64500
    const res = await create('pro', 'quarterly')
    expect(res.status).toBe(200)
    expect(posted().auto_recurring).toEqual({ frequency: 3, frequency_type: 'months', transaction_amount: 64500, currency_id: 'ARS' })
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('un precio inválido en el catálogo (%j) no se vende', (precio) => {
    const catalog = buildPlanCatalog({ basico: {}, pro: { monthly: precio }, full: {} })
    expect(catalog.termsFor('pro', 'monthly')).toBeNull()
    expect(catalog.termsFor('basico', 'monthly')).toBeNull()
  })

  it('Mercado Pago caído → 502, la sesión queda failed y el negocio no cambia', async () => {
    w.mp.down = true
    const antes = w.snapshot(BIZ_A)
    const res = await create('pro')

    expect(res.status).toBe(502)
    expect(res.body.code).toBe('mp_unavailable')
    expect(res.body.init_point).toBeUndefined()
    expect(sessions().map((s) => s.status)).toEqual(['failed'])
    expect(w.snapshot(BIZ_A)).toEqual(antes)

    // Y no deja trabado el siguiente intento.
    w.mp.down = false
    expect((await create('pro')).status).toBe(200)
  })

  it('Mercado Pago rechaza el POST (400): 502 sin detalle para el navegador; el motivo va al log, sin emails', async () => {
    w.mp.createFailsWith = 400
    const res = await create('pro')

    expect(res.status).toBe(502)
    expect(JSON.stringify(res.body)).not.toMatch(/payer_email|bad_request|invalid\.test/)
    const log = w.logs.find((l) => l.event === 'mp_unavailable')!
    expect(log).toMatchObject({ operation: 'POST preapproval', status: 400 })
    expect(String(log.detail)).toContain('bad_request')
    expect(String(log.detail)).not.toMatch(/@/)
    expect(sessions().map((s) => s.status)).toEqual(['failed'])
  })
})

describe('la respuesta de Mercado Pago se valida antes de entregar el checkout', () => {
  it.each([
    ['devuelve otro importe', (row: Record<string, unknown>) => { (row.auto_recurring as Record<string, unknown>).transaction_amount = 1 }, 'amount_mismatch'],
    ['devuelve otra moneda', (row: Record<string, unknown>) => { (row.auto_recurring as Record<string, unknown>).currency_id = 'USD' }, 'currency_mismatch'],
    ['devuelve otra frecuencia', (row: Record<string, unknown>) => { (row.auto_recurring as Record<string, unknown>).frequency = 6 }, 'frequency_mismatch'],
    ['no devuelve las condiciones', (row: Record<string, unknown>) => { row.auto_recurring = null }, 'no_terms'],
    ['lo crea ya authorized', (row: Record<string, unknown>) => { row.status = 'authorized' }, 'not_pending'],
    ['devuelve un init_point que no es de Mercado Pago', (row: Record<string, unknown>) => { row.init_point = 'https://evil.example/pagar' }, 'no_init_point'],
    ['devuelve el init_point de OTRO preapproval', (row: Record<string, unknown>) => { row.init_point = 'https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=pre_de_otro' }, 'no_init_point'],
    ['no devuelve init_point', (row: Record<string, unknown>) => { row.init_point = null }, 'no_init_point'],
  ])('Mercado Pago %s → 502, sin checkout, sin vínculo y el preapproval cancelado', async (_caso, alterar, problema) => {
    w.mp.tamperCreated = alterar
    const antes = w.snapshot(BIZ_A)
    const res = await create('pro')

    expect(res.status).toBe(502)
    expect(res.body.code).toBe('checkout_unavailable')
    expect(res.body.init_point).toBeUndefined()
    expect(w.logs.find((l) => l.event === 'preapproval_rejected')).toMatchObject({ problem: problema })
    expect(sessions()[0]).toMatchObject({ status: 'failed', mp_preapproval_id: null })
    expect([...w.mp.preapprovals.values()].every((p) => p.status === 'cancelled')).toBe(true)
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })

  it('Mercado Pago devuelve un preapproval con OTRA referencia → 502, sin vínculo, y no se cancela (no es de este checkout)', async () => {
    w.mp.tamperCreated = (row) => { row.external_reference = 'trpcs_99999999-9999-4999-8999-999999999999' }
    const res = await create('pro')

    expect(res.status).toBe(502)
    expect(res.body.init_point).toBeUndefined()
    expect(w.logs.find((l) => l.event === 'preapproval_rejected')).toMatchObject({ problem: 'reference_mismatch' })
    expect(sessions()[0]).toMatchObject({ status: 'failed', mp_preapproval_id: null })
    expect(w.mp.callsTo('PUT', '/preapproval/')).toEqual([])
  })

  it('Mercado Pago no devuelve un id → 502, sin checkout y sin vínculo', async () => {
    w.mp.tamperCreated = (row) => { row.id = '' }
    const res = await create('pro')
    expect(res.status).toBe(502)
    expect(w.logs.find((l) => l.event === 'preapproval_rejected')).toMatchObject({ problem: 'no_id' })
    expect(sessions()[0]).toMatchObject({ status: 'failed', mp_preapproval_id: null })
  })

  it('Mercado Pago NO devuelve la referencia (como en el smoke real): el checkout se abre igual, vinculado por id', async () => {
    w.mp.dropsExternalReference = true
    const res = await create('pro')

    expect(res.status).toBe(200)
    expect(sessions()[0].mp_preapproval_id).toBe(new URL(String(res.body.init_point)).searchParams.get('preapproval_id'))
  })

  it('Mercado Pago normaliza el anual a 1 / years: sigue siendo el mismo período', async () => {
    w.mp.tamperCreated = (row) => { Object.assign(row.auto_recurring as Record<string, unknown>, { frequency: 1, frequency_type: 'years' }) }
    const res = await create('pro', 'annual')
    expect(res.status).toBe(200)
    expect(sessions()[0]).toMatchObject({ billing_cycle: 'annual', amount: 240000, status: 'pending' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Frecuencia. Evidencia real del preflight del 2026-10-01/02: Mercado Pago
// expresa un anual como `1` / `"years"` en los planes del panel. El servidor
// manda `12` / `"months"` (la unidad documentada de `POST /preapproval`) y al
// LEER acepta las dos formas, y nada más.
// ─────────────────────────────────────────────────────────────────────────────
describe('frecuencia: equivalencias de Mercado Pago, lista cerrada', () => {
  it.each([
    // ciclo, frequency, frequency_type, ¿coincide?
    ['monthly', 1, 'months', true],
    ['annual', 12, 'months', true],
    ['annual', 1, 'years', true],          // lo que devuelve MP para un anual del panel
    ['quarterly', 3, 'months', true],
    ['annual', 2, 'years', false],
    ['monthly', 1, 'years', false],
    // La cantidad puede llegar como texto numérico; la unidad, con otra caja.
    ['annual', '1', 'years', true],
    ['annual', ' 12 ', 'months', true],
    ['annual', 1, 'YEARS', true],
    // Otro ciclo con una frecuencia válida para OTRO ciclo.
    ['monthly', 12, 'months', false],
    ['monthly', 3, 'months', false],
    ['annual', 1, 'months', false],
    ['annual', 3, 'months', false],
    ['annual', 24, 'months', false],
    ['quarterly', 1, 'months', false],
    ['quarterly', 12, 'months', false],
    ['quarterly', 1, 'years', false],      // trimestral no se amplía
    // Unidades desconocidas: no hay conversión, aunque «den» el mismo período.
    ['annual', 365, 'days', false],
    ['annual', 52, 'weeks', false],
    ['monthly', 30, 'days', false],
    ['monthly', 4, 'weeks', false],
    ['annual', 1, 'year', false],
    ['annual', 1, 'anual', false],
    ['annual', 1, '', false],
    ['annual', 1, null, false],
    ['annual', 1, undefined, false],
    ['annual', 1, 12, false],
    // Cantidades que no son un entero positivo.
    ['annual', null, 'years', false],
    ['annual', undefined, 'years', false],
    ['annual', '', 'years', false],
    ['annual', 0, 'years', false],
    ['annual', -1, 'years', false],
    ['annual', 1.5, 'years', false],
    ['annual', '1.0', 'years', false],
    ['annual', '1e0', 'years', false],
    ['annual', true, 'years', false],
    ['annual', [1], 'years', false],
    ['annual', Number.NaN, 'years', false],
    ['annual', Number.POSITIVE_INFINITY, 'years', false],
    // Un ciclo que no existe nunca coincide.
    ['weekly', 1, 'weeks', false],
  ])('%s + %j / %j → %j', (cycle, frequency, frequencyType, esperado) => {
    expect(matchesBillingCycleFrequency(cycle as 'annual', frequency, frequencyType)).toBe(esperado)
  })

  it('la tabla de equivalencias es la que se documenta, ni más ni menos', () => {
    expect(CYCLE_FREQUENCIES).toEqual({
      monthly: [{ frequency: 1, frequencyType: 'months' }],
      quarterly: [{ frequency: 3, frequencyType: 'months' }],
      annual: [{ frequency: 12, frequencyType: 'months' }, { frequency: 1, frequencyType: 'years' }],
    })
  })
})

describe('condiciones de un checkout contra lo que informa Mercado Pago', () => {
  const pro = { billingCycle: 'monthly' as const, amount: 25000, currency: 'ARS' }
  const mp = (patch: Record<string, unknown> = {}) => ({ frequency: 1, frequency_type: 'months', transaction_amount: 25000, currency_id: 'ARS', ...patch })

  it.each([
    ['las mismas condiciones', mp(), null],
    ['el importe como texto', mp({ transaction_amount: '25000.00' }), null],
    ['la moneda en minúsculas', mp({ currency_id: 'ars' }), null],
    ['un peso menos', mp({ transaction_amount: 24999 }), 'amount_mismatch'],
    ['un centavo más', mp({ transaction_amount: 25000.01 }), 'amount_mismatch'],
    ['importe ausente', mp({ transaction_amount: undefined }), 'amount_mismatch'],
    ['importe vacío', mp({ transaction_amount: '' }), 'amount_mismatch'],
    ['importe no numérico', mp({ transaction_amount: 'gratis' }), 'amount_mismatch'],
    ['otra moneda', mp({ currency_id: 'USD' }), 'currency_mismatch'],
    ['sin moneda', mp({ currency_id: null }), 'currency_mismatch'],
    ['otra frecuencia', mp({ frequency: 12 }), 'frequency_mismatch'],
    ['otra unidad', mp({ frequency_type: 'years' }), 'frequency_mismatch'],
    ['sin auto_recurring', null, 'no_terms'],
    ['auto_recurring que no es un objeto', 'x', 'no_terms'],
  ])('%s → %j', (_caso, recurring, esperado) => {
    expect(checkoutTermsProblem(pro, recurring)).toBe(esperado)
  })

  it('una sesión con importe inválido nunca coincide', () => {
    expect(checkoutTermsProblem({ ...pro, amount: 0 }, mp({ transaction_amount: 0 }))).toBe('amount_mismatch')
    expect(checkoutTermsProblem({ ...pro, amount: 'x' }, mp())).toBe('amount_mismatch')
  })

  it('anual: 12 / months y 1 / years son el mismo período', () => {
    const anual = { billingCycle: 'annual' as const, amount: 240000, currency: 'ARS' }
    expect(checkoutTermsProblem(anual, mp({ frequency: 12, transaction_amount: 240000 }))).toBeNull()
    expect(checkoutTermsProblem(anual, mp({ frequency: 1, frequency_type: 'years', transaction_amount: 240000 }))).toBeNull()
    expect(checkoutTermsProblem(anual, mp({ frequency: 1, transaction_amount: 240000 }))).toBe('frequency_mismatch')
  })
})
