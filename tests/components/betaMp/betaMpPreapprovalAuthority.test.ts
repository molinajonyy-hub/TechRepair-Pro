// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Plan B — quién se activa, con qué plan, y por qué evidencia.
//
// El negocio se resuelve por el ID del preapproval, que el servidor conoce desde
// que lo creó. El plan otorgado es el de la sesión que originó ESE preapproval,
// y sólo si Mercado Pago informa el importe y la frecuencia de esa sesión. Email
// del pagador, importe y fechas nunca son identidad.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from 'vitest'
import { preapprovalState } from '../../../supabase/functions/_shared/billing/mpClient.ts'
import type { MpPreapproval } from '../../../supabase/functions/_shared/billing/mpClient.ts'
import { applyPreapprovalEvidence } from '../../../supabase/functions/_shared/billing/preapproval.ts'
import { BIZ_A, BIZ_B, DAY, HOUR, OWNER_A, OWNER_B, World } from './harness.ts'

let w: World
beforeEach(() => { w = new World() })

const biz = (id = BIZ_A) => w.db.business(id)
const sessions = () => w.db.tables.subscription_checkout_sessions
const notify = (id: string, n?: number) => w.notify('subscription_preapproval', id, n)
const mpRow = (id: string) => w.mp.preapprovals.get(id)!
/** Modifica lo que Mercado Pago informa de un preapproval, con una fecha de modificación nueva. */
const mpCambia = (id: string, patch: Record<string, unknown>) => {
  Object.assign(mpRow(id), { last_modified: w.now().toISOString() }, patch)
}

describe('estados de Mercado Pago', () => {
  it('las dos grafías de «cancelado» que documenta Mercado Pago son el mismo estado', () => {
    expect(preapprovalState('cancelled')).toBe('cancelled')
    expect(preapprovalState('canceled')).toBe('cancelled')
    expect(preapprovalState('AUTHORIZED')).toBe('authorized')
    expect(preapprovalState('active')).toBe('unknown')
    expect(preapprovalState(undefined)).toBe('unknown')
  })
})

describe('authorized activa el negocio correcto, con el plan de SU intención', () => {
  it.each(['basico', 'pro', 'full'])('checkout %s + pago confirmado → el negocio queda en ese plan', async (plan) => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, plan)
    w.pay(preapprovalId)
    const out = await notify(preapprovalId)

    expect(out.detail).toBeNull()
    expect(biz()).toMatchObject({
      subscription_status: 'active', subscription_plan: plan, access_source: 'mercado_pago',
      mp_preapproval_id: preapprovalId, mp_preapproval_plan_id: null, subscription_provider: 'mercadopago',
    })
  })

  it('el vínculo, el período y la sesión salen de ese preapproval', async () => {
    const { preapprovalId, session } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const pre = w.pay(preapprovalId)
    await notify(preapprovalId)

    expect(biz()).toMatchObject({
      subscription_status: 'active', subscription_plan: 'pro', mp_preapproval_id: preapprovalId,
      mp_payer_email: 'aaaaaaaa@invalid.test', grace_until: null, last_payment_status: null,
    })
    // El período es el que informa Mercado Pago.
    expect(new Date(String(biz().current_period_end)).getTime()).toBe(new Date(String(pre.next_payment_date)).getTime())
    expect(biz().current_period_start).not.toBeNull()
    expect(session).toMatchObject({ status: 'paid', mp_preapproval_id: preapprovalId })
    expect(session.confirmed_at).not.toBeNull()
  })

  it('la activación queda auditada: origen, sesión y cómo se vinculó', async () => {
    const { preapprovalId, session } = await w.openCheckout(OWNER_A, BIZ_A, 'full', 'annual')
    w.pay(preapprovalId)
    await notify(preapprovalId)

    const audit = w.db.events('billing_state_applied')[0]
    expect(audit).toMatchObject({ business_id: BIZ_A, external_id: preapprovalId, processed: true })
    expect(audit.raw_payload).toMatchObject({
      source: 'webhook', session_id: session.id, linked_by: 'preapproval_id', reference_echoed: true,
      from: { status: 'trialing', plan: null },
      to: { status: 'active', plan: 'full', billing_cycle: 'annual' },
    })
  })

  it('la activación de A no toca a B, aunque B tenga un checkout abierto del mismo plan', async () => {
    const a = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const b = await w.openCheckout(OWNER_B, BIZ_B, 'pro')
    const antesB = w.snapshot(BIZ_B)
    w.pay(a.preapprovalId)
    await notify(a.preapprovalId)

    expect(biz(BIZ_A).subscription_status).toBe('active')
    expect(w.snapshot(BIZ_B)).toEqual(antesB)
    expect(b.session.status).toBe('pending')
  })

  it('un cambio de plan hecho por un admin sobre la misma suscripción no se pisa en el próximo evento', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    biz().subscription_plan = 'pro'   // admin_change_subscription_plan
    w.advance(HOUR)
    mpCambia('pre_1', {})
    await notify('pre_1')
    expect(biz().subscription_plan).toBe('pro')
  })

  it('una suscripción vinculada que quedó sin plan lo repone desde su sesión de origen', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    biz().subscription_plan = null
    w.advance(HOUR)
    mpCambia('pre_1', {})
    await notify('pre_1')
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'pro' })
  })

  it('…y si no hay sesión de la que tomarlo, no inventa un plan', async () => {
    Object.assign(biz(), { mp_preapproval_id: 'pre_viejo', subscription_status: 'canceled', subscription_plan: null })
    w.mp.seedForeignPreapproval('pre_viejo')
    const out = await notify('pre_viejo')
    expect(out.detail).toBe('not_applied:unknown_plan')
    expect(biz()).toMatchObject({ subscription_status: 'canceled', subscription_plan: null })
  })
})

describe('external_reference ausente: alcanza con el id que vinculó el servidor', () => {
  // Lo medido en el smoke real del 2026-10-02: Mercado Pago dejó el preapproval
  // `authorized` con `external_reference` vacía.
  it('Mercado Pago no devuelve la referencia → activa igual, y queda auditado', async () => {
    w.mp.dropsExternalReference = true
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.pay(preapprovalId)
    const out = await notify(preapprovalId)

    expect(out.detail).toBeNull()
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'basico', mp_preapproval_id: preapprovalId })
    expect(w.db.events('billing_state_applied')[0].raw_payload).toMatchObject({ linked_by: 'preapproval_id', reference_echoed: false })
  })

  it.each([null, undefined, '', '   '])('referencia %j en la lectura → activa por id', async (referencia) => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.pay(preapprovalId, { external_reference: referencia })
    await notify(preapprovalId)
    expect(biz()).toMatchObject({ subscription_status: 'active', mp_preapproval_id: preapprovalId })
  })

  it('…pero si Mercado Pago devuelve una referencia, tiene que ser la de esa sesión', async () => {
    const a = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const b = await w.openCheckout(OWNER_B, BIZ_B, 'full')
    // El preapproval de A «dice» pertenecer al checkout de B.
    w.pay(a.preapprovalId, { external_reference: b.reference })
    const antesA = w.snapshot(BIZ_A)
    const antesB = w.snapshot(BIZ_B)
    const out = await notify(a.preapprovalId)

    expect(out.detail).toBe('not_applied:reference_mismatch')
    expect(w.snapshot(BIZ_A)).toEqual(antesA)
    expect(w.snapshot(BIZ_B)).toEqual(antesB)
    expect(w.db.writesTo('businesses')).toEqual([])
  })

  it.each(['otra-cosa', 'YG-1234', BIZ_A, 'trpcs_99999999-9999-4999-8999-999999999999'])(
    'una referencia que no es la de la sesión (%j) → no activa', async (referencia) => {
      const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
      w.pay(preapprovalId, { external_reference: referencia })
      const antes = w.snapshot(BIZ_A)
      const out = await notify(preapprovalId)
      expect(out.detail).toBe('not_applied:reference_mismatch')
      expect(w.snapshot(BIZ_A)).toEqual(antes)
    })
})

describe('un preapproval que el servidor no creó no activa nada', () => {
  it('el preapproval real del smoke (plan del panel, referencia vacía) → no activa a nadie', async () => {
    // Mismo estado que dejó el Plan A en producción: un checkout abierto y, en
    // Mercado Pago, un preapproval authorized que no lleva ningún vínculo.
    await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.mp.seedForeignPreapproval('pre_smoke', {
      preapproval_plan_id: 'plan_del_panel', external_reference: '', payer_email: 'aaaaaaaa@invalid.test',
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 15000, currency_id: 'ARS' },
    })
    const antes = w.snapshot(BIZ_A)
    const out = await notify('pre_smoke')

    expect(out.detail).toBe('not_applied:unknown_preapproval')
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(w.db.tables.businesses.every((b) => b.mp_preapproval_id === null)).toBe(true)
    expect(w.db.events('subscription_preapproval')[0]).toMatchObject({ processed: true, business_id: null, error_message: 'not_applied:unknown_preapproval' })
  })

  it('mismo email, mismo importe y misma fecha que un checkout abierto: NO es identidad', async () => {
    const { session } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mp.seedForeignPreapproval('pre_parecido', {
      payer_email: session.payer_email, date_created: session.created_at,
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 25000, currency_id: 'ARS' },
    })
    const antes = w.snapshot(BIZ_A)
    const out = await notify('pre_parecido')

    expect(out.detail).toBe('not_applied:unknown_preapproval')
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(session.status).toBe('pending')
  })

  it('un id desconocido que trae la referencia VÁLIDA de un checkout abierto tampoco activa', async () => {
    const { reference, session } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mp.seedForeignPreapproval('pre_con_referencia_copiada', { external_reference: reference })
    const antes = w.snapshot(BIZ_A)
    const out = await notify('pre_con_referencia_copiada')

    expect(out.detail).toBe('not_applied:unknown_preapproval')
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(session).toMatchObject({ status: 'pending' })
    expect(session.mp_preapproval_id).not.toBe('pre_con_referencia_copiada')
  })

  it('un business_id suelto como referencia no le reemplaza la suscripción a ese negocio', async () => {
    await w.subscribe(OWNER_B, BIZ_B, 'full', 'pre_b')
    const antes = w.snapshot(BIZ_B)
    w.mp.seedForeignPreapproval('pre_atacante', { external_reference: BIZ_B })
    const out = await notify('pre_atacante')

    expect(out.detail).toBe('not_applied:unknown_preapproval')
    expect(w.snapshot(BIZ_B)).toEqual(antes)
    expect(biz(BIZ_B)).toMatchObject({ subscription_plan: 'full', mp_preapproval_id: 'pre_b' })
  })
})

describe('un preapproval no se cruza entre negocios', () => {
  it('el preapproval de B activa a B y sólo a B, aunque lo «reclame» A', async () => {
    await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const b = await w.openCheckout(OWNER_B, BIZ_B, 'pro')
    w.pay(b.preapprovalId)
    // A intenta verificar: su reconcile sólo relee los preapprovals de SUS sesiones.
    const res = await w.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })

    expect(res.body.activated).toBe(false)
    expect(biz(BIZ_A)).toMatchObject({ subscription_status: 'trialing', mp_preapproval_id: null })
    expect(w.mp.callsTo('GET', `/preapproval/${b.preapprovalId}`)).toEqual([])
  })

  it('el camino canónico, invocado en nombre de A con el preapproval de la sesión de B, no escribe nada', async () => {
    const b = await w.openCheckout(OWNER_B, BIZ_B, 'pro')
    const pre = w.pay(b.preapprovalId) as unknown as MpPreapproval
    const antesA = w.snapshot(BIZ_A)
    const antesB = w.snapshot(BIZ_B)

    const out = await applyPreapprovalEvidence(w.billingContext(), pre, { source: 'reconcile', expectBusinessId: BIZ_A })
    // Ni activa a A ni a B, y no revela de quién es.
    expect(out).toMatchObject({ kind: 'not_applied', reason: 'foreign_business', businessId: null })
    expect(w.snapshot(BIZ_A)).toEqual(antesA)
    expect(w.snapshot(BIZ_B)).toEqual(antesB)
    expect(b.session.status).toBe('pending')
  })

  it('si una sesión de A apuntara al preapproval ya vinculado a B, el camino canónico se niega', async () => {
    await w.subscribe(OWNER_B, BIZ_B, 'pro', 'pre_b')
    // Inconsistencia de datos forzada (el índice único de la base la impide).
    const a = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    a.session.mp_preapproval_id = 'pre_b'
    const antesA = w.snapshot(BIZ_A)
    const antesB = w.snapshot(BIZ_B)

    const res = await w.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(res.body.activated).toBe(false)
    expect(w.snapshot(BIZ_A)).toEqual(antesA)
    expect(w.snapshot(BIZ_B)).toEqual(antesB)
    expect(w.logs.find((l) => l.event === 'preapproval_evidence' && l.source === 'reconcile')).toMatchObject({ kind: 'not_applied', reason: 'foreign_business' })
  })

  it('la base no permite vincular el mismo preapproval a dos sesiones', async () => {
    const a = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    // El segundo POST «devuelve» el id del primero: el vínculo choca y no hay checkout.
    w.mp.tamperCreated = (row) => { row.id = a.preapprovalId; row.init_point = `https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=${a.preapprovalId}` }
    const res = await w.call(OWNER_B, { action: 'create', business_id: BIZ_B, plan: 'pro', billing_cycle: 'monthly' })

    expect(res.status).toBe(503)
    expect(res.body.init_point).toBeUndefined()
    expect(sessions().filter((s) => s.mp_preapproval_id === a.preapprovalId)).toHaveLength(1)
    expect(w.sessionOf(a.preapprovalId).business_id).toBe(BIZ_A)
    // Ese preapproval es de la sesión de A: el request de B no lo cancela.
    expect(w.mp.callsTo('PUT', '/preapproval/')).toEqual([])
    expect(sessions().find((s) => s.business_id === BIZ_B)).toMatchObject({ status: 'failed', mp_preapproval_id: null })
  })

  it('dos sesiones con el mismo preapproval (base sin el índice único) → error, no activa a ninguna', async () => {
    const a = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const b = await w.openCheckout(OWNER_B, BIZ_B, 'pro')
    b.session.mp_preapproval_id = a.preapprovalId
    w.pay(a.preapprovalId)

    await expect(notify(a.preapprovalId)).rejects.toThrow(/sesión de checkout por preapproval/)
    expect(biz(BIZ_A).subscription_status).toBe('trialing')
    expect(biz(BIZ_B).subscription_status).toBe('trialing')
    expect(w.db.events('subscription_preapproval')[0].processed).toBe(false)
  })

  it('el índice único de businesses impide que un preapproval quede en dos negocios', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    biz(BIZ_B).mp_preapproval_id = null
    const res = w.db.from('businesses').update({ mp_preapproval_id: 'pre_1' }).eq('id', BIZ_B)
    expect((await res).error).toMatchObject({ code: '23505' })
  })
})

describe('plan y monto: lo que cobra Mercado Pago tiene que ser lo de la sesión', () => {
  it.each([
    ['otro importe', { transaction_amount: 15000 }],
    ['un importe simbólico', { transaction_amount: 1 }],
    ['otra moneda', { currency_id: 'USD' }],
    ['otra frecuencia (anual en vez de mensual)', { frequency: 12 }],
    ['una unidad desconocida', { frequency: 30, frequency_type: 'days' }],
  ])('authorized con %s → no activa y queda auditado', async (_caso, cambio) => {
    const { preapprovalId, session } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.pay(preapprovalId)
    Object.assign(mpRow(preapprovalId).auto_recurring as Record<string, unknown>, cambio)
    const antes = w.snapshot(BIZ_A)
    const out = await notify(preapprovalId)

    expect(out.detail).toBe('not_applied:terms_mismatch')
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(session.status).toBe('pending')
    expect(w.db.events('subscription_preapproval')[0]).toMatchObject({ processed: true, error_message: 'not_applied:terms_mismatch', business_id: BIZ_A })
    expect(w.logs.find((l) => l.event === 'terms_mismatch')).toMatchObject({ preapproval_id: preapprovalId })
  })

  it('authorized sin auto_recurring → no activa', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.pay(preapprovalId, { auto_recurring: null })
    const out = await notify(preapprovalId)
    expect(out.detail).toBe('not_applied:terms_mismatch')
    expect(biz().subscription_status).toBe('trialing')
  })

  it('pagó Básico: recibe Básico aunque después pida Full', async () => {
    const basico = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.advance(HOUR)
    await w.openCheckout(OWNER_A, BIZ_A, 'full')         // otra intención, sin pagar
    w.pay(basico.preapprovalId)
    await notify(basico.preapprovalId)

    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'basico', mp_preapproval_id: basico.preapprovalId })
    expect(biz().subscription_plan).not.toBe('full')
  })

  it('el precio del catálogo cambia DESPUÉS de abrir el checkout: vale lo que se pactó en la sesión', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.prices.pro.monthly = 30000
    w.pay(preapprovalId)
    await notify(preapprovalId)
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'pro' })
  })

  it('anual: Mercado Pago lo informa como 1 / years y activa el plan anual de la sesión', async () => {
    const { preapprovalId, session } = await w.openCheckout(OWNER_A, BIZ_A, 'basico', 'annual')
    w.pay(preapprovalId)
    Object.assign(mpRow(preapprovalId).auto_recurring as Record<string, unknown>, { frequency: 1, frequency_type: 'years' })
    await notify(preapprovalId)

    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'basico' })
    expect(session).toMatchObject({ status: 'paid', billing_cycle: 'annual', amount: 144000 })
  })

  it('mensual que Mercado Pago informa como 1 / years → no activa', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico', 'monthly')
    w.pay(preapprovalId)
    Object.assign(mpRow(preapprovalId).auto_recurring as Record<string, unknown>, { frequency: 1, frequency_type: 'years' })
    const out = await notify(preapprovalId)
    expect(out.detail).toBe('not_applied:terms_mismatch')
  })
})

describe('estados del preapproval', () => {
  it('pending NO otorga acceso nuevo y NO degrada el que había', async () => {
    const { preapprovalId, session } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const antes = w.snapshot(BIZ_A)
    const out = await notify(preapprovalId)

    expect(out.detail).toBe('not_applied:not_authorized')
    expect(w.snapshot(BIZ_A)).toEqual(antes)            // sigue en trial, sin plan
    expect(biz().subscription_status).not.toBe('pending_activation')
    expect(session.status).toBe('pending')
    expect(w.db.writesTo('businesses')).toEqual([])
  })

  it('la notificación `created` puede llegar ANTES de que el servidor termine de vincular: no rompe ni activa', async () => {
    // Mercado Pago notifica el alta del preapproval mientras `create` sigue en curso.
    w.mp.seedForeignPreapproval('pre_recien_creado', { status: 'pending' })
    const out = await notify('pre_recien_creado')
    expect(out.result).toBe('processed')
    expect(out.detail).toBe('not_applied:unknown_preapproval')
    expect(w.db.writesTo('businesses')).toEqual([])
  })

  it('pending → authorized: las DOS notificaciones del mismo preapproval se procesan', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    await notify(preapprovalId, 5001)                    // created
    expect(biz().subscription_status).toBe('trialing')

    w.advance(60_000)
    w.pay(preapprovalId)
    const out = await notify(preapprovalId, 5002)        // updated — mismo data.id

    // Con el dedupe por recurso esta notificación se descartaba.
    expect(out.result).toBe('processed')
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'pro' })
  })

  it('cancelled sobre un checkout inicial (nunca activó) no cambia el acceso; la sesión queda canceled', async () => {
    const { preapprovalId, session } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    mpCambia(preapprovalId, { status: 'cancelled' })
    const antes = w.snapshot(BIZ_A)
    await notify(preapprovalId)

    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(session.status).toBe('canceled')
  })

  it('cancelled sobre la suscripción vigente → canceled', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    w.advance(HOUR)
    mpCambia('pre_1', { status: 'cancelled' })
    await notify('pre_1')
    expect(biz()).toMatchObject({ subscription_status: 'canceled', subscription_plan: 'pro', mp_preapproval_id: 'pre_1' })
  })

  it('paused → past_due con 3 días de gracia, y un segundo evento NO renueva la gracia', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    w.advance(HOUR)
    mpCambia('pre_1', { status: 'paused' })
    await notify('pre_1')

    expect(biz().subscription_status).toBe('past_due')
    const gracia = String(biz().grace_until)
    expect(new Date(gracia).getTime() - w.now().getTime()).toBe(3 * DAY)

    w.advance(DAY)
    mpCambia('pre_1', {})
    await notify('pre_1')
    expect(biz().grace_until).toBe(gracia)
  })

  it('un estado que no conocemos no cambia nada', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    w.advance(HOUR)
    mpCambia('pre_1', { status: 'finished' })
    const antes = w.snapshot(BIZ_A)
    const out = await notify('pre_1')
    expect(out.detail).toBe('not_applied:unknown_status')
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })

  it('un acceso otorgado por un admin no se degrada por un paused/cancelled de la suscripción anterior', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    Object.assign(biz(), { access_source: 'admin_override', subscription_plan: 'full' })   // admin_activate_subscription
    w.advance(HOUR)
    mpCambia('pre_1', { status: 'cancelled' })
    await notify('pre_1')
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'full', access_source: 'admin_override' })
  })

  it('un checkout vencido que igual se paga: el pago es real y activa', async () => {
    const { preapprovalId, session } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.advance(3 * DAY)
    await w.openCheckout(OWNER_A, BIZ_A, 'pro')          // el viejo quedó expired
    expect(session.status).toBe('expired')

    w.pay(preapprovalId)
    await notify(preapprovalId)
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'pro', mp_preapproval_id: preapprovalId })
    expect(session.status).toBe('paid')
  })
})

describe('cambio de plan y reactivación', () => {
  it('cambio de plan: el anterior sigue vigente hasta que Mercado Pago confirma el nuevo', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    const nuevo = await w.openCheckout(OWNER_A, BIZ_A, 'full', 'monthly', 'pre_2')
    // Mientras no paga, sigue con Básico y con su suscripción intacta.
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'basico', mp_preapproval_id: 'pre_1' })
    expect(mpRow('pre_1').status).toBe('authorized')
    expect(w.mp.callsTo('PUT', '/preapproval/')).toEqual([])

    // La notificación del preapproval nuevo, todavía pending, tampoco cambia nada.
    await notify('pre_2')
    expect(biz()).toMatchObject({ subscription_plan: 'basico', mp_preapproval_id: 'pre_1' })
    expect(mpRow('pre_1').status).toBe('authorized')

    w.advance(HOUR)
    w.pay(nuevo.preapprovalId)
    await notify('pre_2')

    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'full', mp_preapproval_id: 'pre_2' })
    expect(mpRow('pre_1').status).toBe('cancelled')
    expect(w.db.events('preapproval_superseded')[0]).toMatchObject({ external_id: 'pre_1', processed: true, business_id: BIZ_A })
  })

  it('la cancelación de la suscripción reemplazada llega después y NO cancela la nueva', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    await w.openCheckout(OWNER_A, BIZ_A, 'full', 'monthly', 'pre_2')
    w.advance(HOUR)
    w.pay('pre_2')
    await notify('pre_2')

    const out = await notify('pre_1')   // el webhook de la baja de pre_1
    expect(out.detail).toBe('not_applied:not_authorized')
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'full', mp_preapproval_id: 'pre_2' })
  })

  it('la suscripción reemplazada, si sigue authorized, no vuelve a vincularse', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    await w.openCheckout(OWNER_A, BIZ_A, 'full', 'monthly', 'pre_2')
    w.mp.cancelFails = true                                // la anterior no se pudo cancelar
    w.pay('pre_2')
    await notify('pre_2')

    const out = await notify('pre_1')
    expect(out.detail).toBe('not_applied:superseded_preapproval')
    expect(biz()).toMatchObject({ subscription_plan: 'full', mp_preapproval_id: 'pre_2' })
  })

  it('si Mercado Pago no deja cancelar la anterior, la nueva queda activa y hay un evento SIN procesar', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    await w.openCheckout(OWNER_A, BIZ_A, 'full', 'monthly', 'pre_2')
    w.pay('pre_2')
    w.mp.cancelFails = true

    await notify('pre_2')
    expect(biz()).toMatchObject({ subscription_plan: 'full', mp_preapproval_id: 'pre_2' })
    expect(mpRow('pre_1').status).toBe('authorized')
    expect(w.db.events('preapproval_superseded')[0]).toMatchObject({ processed: false, error_message: 'supersede_cancel_failed' })
  })

  it('reactivar: una cuenta cancelada vuelve a active sólo con una suscripción nueva confirmada', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    w.advance(HOUR)
    mpCambia('pre_1', { status: 'cancelled' })
    await notify('pre_1')
    expect(biz().subscription_status).toBe('canceled')

    await w.openCheckout(OWNER_A, BIZ_A, 'basico', 'monthly', 'pre_2')
    expect(biz().subscription_status).toBe('canceled')     // abrir el checkout no reactiva
    w.advance(HOUR)
    w.pay('pre_2')
    await notify('pre_2')
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'basico', mp_preapproval_id: 'pre_2' })
  })
})
