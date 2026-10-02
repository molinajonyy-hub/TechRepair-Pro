// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Fases 8 y 9 — cancelar y actualizar el medio de pago.
//
// Las dos operan SÓLO sobre el `mp_preapproval_id` que la base tiene para el
// negocio autorizado. El cross-tenant está en betaMpAuthorization.test.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from 'vitest'
import { BIZ_A, BIZ_B, HOUR, OWNER_A, OWNER_B, World } from './harness.ts'

let w: World
beforeEach(async () => {
  w = new World()
  await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_a')
  await w.subscribe(OWNER_B, BIZ_B, 'full', 'pre_b')
  w.advance(HOUR)
  w.mp.calls.length = 0
})

const biz = (id = BIZ_A) => w.db.business(id)
const cancel = (user = OWNER_A, businessId = BIZ_A) => w.call(user, { action: 'cancel', business_id: businessId })
const link = (user = OWNER_A, businessId = BIZ_A) => w.call(user, { action: 'update_payment_method', business_id: businessId })

describe('cancel', () => {
  it('cancelación propia: cancela en MP, lo confirma releyendo y deja la base canceled', async () => {
    const res = await cancel()

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, already_cancelled: false, status: 'canceled' })
    expect(w.mp.preapprovals.get('pre_a')?.status).toBe('cancelled')
    expect(biz()).toMatchObject({ subscription_status: 'canceled', mp_preapproval_id: 'pre_a', subscription_plan: 'pro' })
    // Sólo se tocó el preapproval de A.
    expect(w.mp.callsTo('PUT', '/preapproval/').map((c) => c.path)).toEqual(['/preapproval/pre_a'])
    expect(w.mp.preapprovals.get('pre_b')?.status).toBe('authorized')
    expect(biz(BIZ_B).subscription_status).toBe('active')
  })

  it('deja auditoría: quién canceló y el cambio de estado', async () => {
    await cancel()
    expect(w.db.events('user_cancelled')[0]).toMatchObject({
      business_id: BIZ_A, external_id: 'pre_a', processed: true,
      raw_payload: { cancelled_by: OWNER_A, already_cancelled: false },
    })
    const aplicado = w.db.events('billing_state_applied').at(-1)!
    expect(aplicado.raw_payload).toMatchObject({ source: 'cancel', from: { status: 'active' }, to: { status: 'canceled' } })
  })

  it('doble cancelación: la segunda no vuelve a llamar al PUT y responde igual', async () => {
    await cancel()
    const estado = w.snapshot(BIZ_A)
    const segunda = await cancel()

    expect(segunda.status).toBe(200)
    expect(segunda.body).toMatchObject({ success: true, already_cancelled: true, status: 'canceled' })
    expect(w.mp.callsTo('PUT', '/preapproval/')).toHaveLength(1)
    expect(w.snapshot(BIZ_A)).toEqual(estado)
  })

  it('el webhook de la cancelación llega después: no cambia nada', async () => {
    await cancel()
    const { last_webhook_at: _a, updated_at: _b, ...antes } = w.snapshot(BIZ_A)
    const aplicados = w.db.events('billing_state_applied').length

    const out = await w.notify('subscription_preapproval', 'pre_a')
    expect(out.result).toBe('processed')
    const { last_webhook_at: _c, updated_at: _d, ...despues } = w.snapshot(BIZ_A)
    expect(despues).toEqual(antes)
    expect(w.db.events('billing_state_applied')).toHaveLength(aplicados)
  })

  it('si Mercado Pago no confirma la cancelación, la base NO se marca canceled', async () => {
    w.mp.cancelIsIgnored = true
    const res = await cancel()
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('cancel_not_confirmed')
    expect(biz().subscription_status).toBe('active')
    expect(w.db.events('user_cancelled')).toHaveLength(0)
  })

  it('si el PUT falla, nada cambia', async () => {
    w.mp.cancelFails = true
    const res = await cancel()
    expect(res.status).toBe(502)
    expect(biz().subscription_status).toBe('active')
  })

  it('un negocio sin suscripción de MP (trial) → 409 claro, sin llamar a Mercado Pago', async () => {
    const TRIAL = '33333333-3333-4333-8333-33333333cccc'
    const OWNER_C = 'cccccccc-1111-4000-8000-00000000000c'
    w.addBusiness(TRIAL, OWNER_C, { subscription_status: 'trialing', access_source: 'trial' })
    const res = await w.call(OWNER_C, { action: 'cancel', business_id: TRIAL })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('no_subscription')
    expect(w.mp.calls).toEqual([])
    expect(w.db.business(TRIAL).subscription_status).toBe('trialing')
  })

  it('si el preapproval que devuelve MP pertenece a la sesión de OTRO negocio → 409, sin cancelar', async () => {
    // Inconsistencia de datos: A apunta al preapproval de la sesión de B.
    const referenciaDeB = w.db.tables.subscription_checkout_sessions.find((s) => s.business_id === BIZ_B)!.external_reference
    w.mp.preapprovals.get('pre_a')!.external_reference = referenciaDeB
    const res = await cancel()
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('subscription_mismatch')
    expect(w.mp.callsTo('PUT', '/preapproval/')).toEqual([])
    expect(biz().subscription_status).toBe('active')
  })
})

describe('update_payment_method', () => {
  it('devuelve el enlace de Mercado Pago de la suscripción del negocio', async () => {
    const res = await link()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ init_point: 'https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=pre_a' })
    // Consultó el preapproval de A y nada más.
    expect(w.mp.calls.map((c) => c.path)).toEqual(['/preapproval/pre_a'])
  })

  it('no escribe nada', async () => {
    w.db.writes.length = 0
    await link()
    expect(w.db.writes).toEqual([])
  })

  it('sin suscripción → 409, sin llamar a Mercado Pago', async () => {
    Object.assign(biz(), { mp_preapproval_id: null })
    const res = await link()
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('no_subscription')
    expect(w.mp.calls).toEqual([])
  })

  it('suscripción cancelada → 409: no se ofrece un enlace que no sirve', async () => {
    await cancel()
    const res = await link()
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('subscription_cancelled')
    expect(res.body.init_point).toBeUndefined()
  })

  it('preapproval de la sesión de otro negocio → 409, sin enlace', async () => {
    const referenciaDeB = w.db.tables.subscription_checkout_sessions.find((s) => s.business_id === BIZ_B)!.external_reference
    w.mp.preapprovals.get('pre_a')!.external_reference = referenciaDeB
    const res = await link()
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('subscription_mismatch')
    expect(res.body.init_point).toBeUndefined()
  })

  it('una referencia vieja con el id de OTRO negocio → 409', async () => {
    w.mp.preapprovals.get('pre_a')!.external_reference = BIZ_B
    expect((await link()).status).toBe(409)
  })

  it('un init_point que no es de Mercado Pago no se devuelve', async () => {
    w.mp.preapprovals.get('pre_a')!.init_point = 'https://evil.example/phish'
    const res = await link()
    expect(res.status).toBe(502)
    expect(res.body.init_point).toBeUndefined()
  })

  it('Mercado Pago no encuentra el preapproval → 409, sin inventar un enlace', async () => {
    w.mp.preapprovals.delete('pre_a')
    const res = await link()
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('subscription_not_found')
  })
})
