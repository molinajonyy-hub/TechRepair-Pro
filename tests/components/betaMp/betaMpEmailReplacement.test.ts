// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BIZ_A, BIZ_B, OWNER_A, OWNER_B, World } from './harness.ts'

let w: World
beforeEach(() => { w = new World() })
const create = (email = 'otro@mp.invalid') => w.call(OWNER_A, {
  action: 'create', business_id: BIZ_A, plan: 'pro', billing_cycle: 'monthly', mp_payer_email: email,
})
const cancelCalls = () => w.mp.callsTo('PUT', '/preapproval/')

describe('BETA-MP-EMAIL: reemplazo seguro del pagador', () => {
  it('mismo correo normalizado reutiliza sin cancelar ni crear otro recurso', async () => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const r = await create(' AAAAAAAA@invalid.test ')
    expect(r.status).toBe(200)
    expect(r.body.init_point).toBe(old.res.body.init_point)
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(1)
  })

  it('otro correo: GET → PUT → GET cancelled → cierre local → POST nuevo', async () => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const before = w.snapshot(BIZ_A)
    const foreign = await w.openCheckout(OWNER_B, BIZ_B, 'pro')
    const callsBefore = w.mp.calls.length
    const original = w.mp.fetchImpl
    vi.spyOn(w.mp, 'fetchImpl').mockImplementation(async (input, init) => {
      if (init?.method === 'POST') {
        expect(w.mp.preapprovals.get(old.preapprovalId)!.status).toBe('cancelled')
        expect(old.session.status).toBe('canceled')
      }
      return original(input, init)
    })
    expect((await create()).status).toBe(200)
    expect(w.mp.calls.slice(callsBefore).map(c => `${c.method} ${c.path}`)).toEqual([
      `GET /preapproval/${old.preapprovalId}`, `PUT /preapproval/${old.preapprovalId}`,
      `GET /preapproval/${old.preapprovalId}`, 'POST /preapproval',
    ])
    expect(w.mp.created().at(-1)!.body!.payer_email).toBe('otro@mp.invalid')
    expect(w.mp.preapprovals.get(foreign.preapprovalId)!.status).toBe('pending')
    expect(w.snapshot(BIZ_A)).toEqual(before)
    expect(w.db.tables.payments).toHaveLength(0)
  })

  it.each(['cancelFails', 'cancelIsIgnored', 'down'] as const)('%s: bloquea también reintentos sin segundo POST', async failure => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mp[failure] = true
    const before = w.snapshot(BIZ_A)
    for (let i = 0; i < 2; i++) {
      const r = await create()
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(r.body.init_point).toBeUndefined()
    }
    expect(old.session.status).toBe('pending')
    expect(w.mp.created()).toHaveLength(1)
    expect(w.snapshot(BIZ_A)).toEqual(before)
    expect(w.db.tables.payments).toHaveLength(0)
  })

  it.each(['unknown', 'paused', null, 'missing', 'wrong_id', 'wrong_reference'])('%s: no cancela ni reemplaza un recurso no verificado', async state => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const remote = w.mp.preapprovals.get(old.preapprovalId)!
    if (state === 'missing') w.mp.preapprovals.delete(old.preapprovalId)
    else if (state === 'wrong_id') remote.id = 'foreign'
    else if (state === 'wrong_reference') remote.external_reference = 'trpcs_aaaaaaaa-0000-4000-8000-000000000000'
    else remote.status = state
    expect((await create()).body.code).toBe('checkout_replacement_blocked')
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(1)
    expect(old.session.status).toBe('pending')
  })

  it('authorized sin pago no se cancela ni duplica, y tampoco activa', async () => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mp.authorize(old.preapprovalId)
    expect((await create()).body.code).toBe('checkout_already_authorized')
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(1)
    const r = await w.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(r.body.activated).toBe(false)
    expect(w.db.tables.payments).toHaveLength(0)
  })

  it('un recurso vinculado a la suscripción vigente no se cancela por cambiar correo', async () => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    Object.assign(w.db.business(BIZ_A), { mp_preapproval_id: old.preapprovalId, subscription_status: 'active' })
    const before = w.snapshot(BIZ_A)
    expect((await create()).body.code).toBe('checkout_replacement_blocked')
    expect(cancelCalls()).toHaveLength(0)
    expect(w.snapshot(BIZ_A)).toEqual(before)
  })

  it('una suscripción activa del mismo plan/ciclo no se vuelve a contratar por otro correo', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'active')
    const before = w.snapshot(BIZ_A)
    expect((await create()).body.code).toBe('checkout_already_authorized')
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(1)
    expect(w.snapshot(BIZ_A)).toEqual(before)
    expect(w.db.tables.payments).toHaveLength(1)
  })

  it('cancelación diferida: espera la relectura confirmada antes del nuevo POST', async () => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mp.cancelIsIgnored = true
    const original = w.mp.fetchImpl
    let checks = 0
    vi.spyOn(w.mp, 'fetchImpl').mockImplementation(async (input, init) => {
      if (cancelCalls().length && (!init?.method || init.method === 'GET')) {
        checks++
        expect(w.mp.created()).toHaveLength(1)
        expect(old.session.status).toBe('pending')
        if (checks === 3) w.mp.preapprovals.get(old.preapprovalId)!.status = 'cancelled'
      }
      return original(input, init)
    })
    expect((await create()).status).toBe(200)
    expect(checks).toBe(3)
  })

  it.each(['authorized', 'unknown', 'wrong_id', 'missing'])('relectura %s después del PUT: bloquea sin liberar sesión', async fault => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const original = w.mp.fetchImpl
    vi.spyOn(w.mp, 'fetchImpl').mockImplementation(async (input, init) => {
      const response = await original(input, init)
      if (init?.method === 'PUT') {
        const remote = w.mp.preapprovals.get(old.preapprovalId)!
        if (fault === 'wrong_id') remote.id = 'foreign'
        else if (fault === 'missing') w.mp.preapprovals.delete(old.preapprovalId)
        else remote.status = fault
      }
      return response
    })
    expect((await create()).status).toBe(409)
    expect(old.session.status).toBe('pending')
    expect(w.mp.created()).toHaveLength(1)
  })

  it('dos cambios concurrentes: un solo cierre condicional y un solo reemplazo', async () => {
    await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const results = await Promise.all([create('uno@mp.invalid'), create('dos@mp.invalid')])
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    expect(w.mp.created()).toHaveLength(2)
    expect(w.db.tables.subscription_checkout_sessions.filter(s => s.status === 'pending')).toHaveLength(1)
  })

  it('dos planes/ciclos concurrentes sin checkout anterior: una sola reserva por negocio', async () => {
    const [a, b] = await Promise.all([
      create(), w.call(OWNER_A, { action: 'create', business_id: BIZ_A, plan: 'full', billing_cycle: 'annual' }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(w.mp.created()).toHaveLength(1)
  })

  it('un pendiente autorizado de otro plan también bloquea una segunda suscripción', async () => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.mp.authorize(old.preapprovalId)
    expect((await create()).body.code).toBe('checkout_already_authorized')
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(1)
  })

  it('duplicados históricos: bloquea sin elegir ni cancelar recursos arbitrariamente', async () => {
    await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    await w.openLegacyCheckout(OWNER_A, BIZ_A, 'full')
    expect((await create()).body.code).toBe('checkout_replacement_blocked')
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(2)
  })

  it('POST aceptado seguido de timeout: conserva reserva y no crea otro recurso al reintentar', async () => {
    const original = w.mp.fetchImpl
    vi.spyOn(w.mp, 'fetchImpl').mockImplementation(async (input, init) => {
      const response = await original(input, init)
      if (init?.method === 'POST') throw new Error('response lost')
      return response
    })
    expect((await create()).status).toBe(502)
    w.advance(61_000)
    expect((await create()).body.code).toBe('checkout_replacement_blocked')
    expect(w.mp.created()).toHaveLength(1)
    expect(w.mp.preapprovals.size).toBe(1)
    expect(w.db.tables.payments).toHaveLength(0)
  })

  it('error de escritura tras cancelación: reintento reutiliza confirmación remota sin doble ledger', async () => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.db.failOn = { table: 'subscription_checkout_sessions', op: 'update', code: 'XX000' }
    expect((await create()).status).toBe(503)
    expect(old.session.status).toBe('pending')
    expect(w.mp.created()).toHaveLength(1)
    const r = await create()
    expect(r.status).toBe(200)
    const replacement = String(new URL(String(r.body.init_point)).searchParams.get('preapproval_id'))
    w.pay(replacement)
    for (let i = 0; i < 2; i++) await w.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    await w.notify('subscription_authorized_payment', `first_${replacement}`, 'email-retry')
    await w.notify('subscription_authorized_payment', `first_${replacement}`, 'email-retry')
    expect(w.db.tables.payments).toHaveLength(1)
    expect(w.db.tables.payments[0].status).toBe('approved')
    expect(w.db.business(BIZ_A).subscription_status).toBe('active')
  })
})
