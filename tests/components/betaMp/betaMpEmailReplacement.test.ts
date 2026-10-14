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

  it('otro correo con preapproval pending: bloquea sin cancelar, cerrar ni crear otro recurso', async () => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const before = w.snapshot(BIZ_A)
    const foreign = await w.openCheckout(OWNER_B, BIZ_B, 'pro')
    const callsBefore = w.mp.calls.length
    const writesBefore = w.db.writes.length
    const result = await create()
    expect(result.status).toBe(409)
    expect(result.body.code).toBe('checkout_replacement_blocked')
    expect(result.body.init_point).toBeUndefined()
    expect(w.mp.calls.slice(callsBefore).map(c => `${c.method} ${c.path}`)).toEqual([
      `GET /preapproval/${old.preapprovalId}`,
    ])
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(2) // A y B: ningún reemplazo.
    expect(old.session.status).toBe('pending')
    expect(w.mp.preapprovals.get(old.preapprovalId)!.status).toBe('pending')
    expect(w.mp.preapprovals.get(foreign.preapprovalId)!.status).toBe('pending')
    expect(w.db.writes).toHaveLength(writesBefore)
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
    expect(cancelCalls()).toHaveLength(0)
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

  it('approved en ledger con cierre local interrumpido bloquea incluso si MP ya informa cancelled', async () => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const before = w.snapshot(BIZ_A)
    w.pay(old.preapprovalId)
    w.mp.preapprovals.get(old.preapprovalId)!.status = 'cancelled'
    // Recovery registra el pago real y luego falla al cerrar la sesión: un
    // retry de create debe respetar esa evidencia aunque siga viendo pending.
    w.db.failOn = { table: 'subscription_checkout_sessions', op: 'update', code: 'XX000' }
    await expect(w.notify('subscription_authorized_payment', `first_${old.preapprovalId}`, 'interrupted-close')).rejects.toThrow()
    expect(old.session.status).toBe('pending')
    expect(w.db.tables.payments).toHaveLength(1)
    expect(w.db.tables.payments[0].status).toBe('approved')
    expect((await create()).body.code).toBe('checkout_replacement_blocked')
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(1)
    expect(old.session.status).toBe('pending')
    expect(w.snapshot(BIZ_A)).toEqual(before)
    expect(w.db.tables.payments).toHaveLength(1)
  })

  it.each(['cancelled', 'canceled'])('%s ya confirmado por MP: GET → cierre local → POST, sin solicitar cancelación', async state => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mp.preapprovals.get(old.preapprovalId)!.status = state
    const callsBefore = w.mp.calls.length
    const original = w.mp.fetchImpl
    vi.spyOn(w.mp, 'fetchImpl').mockImplementation(async (input, init) => {
      if (init?.method === 'POST') {
        expect(w.mp.preapprovals.get(old.preapprovalId)!.status).toBe(state)
        expect(old.session.status).toBe('canceled')
        expect(w.mp.created()).toHaveLength(1)
      }
      return original(input, init)
    })
    expect((await create()).status).toBe(200)
    expect(w.mp.calls.slice(callsBefore).map(c => `${c.method} ${c.path}`)).toEqual([
      `GET /preapproval/${old.preapprovalId}`, 'POST /preapproval',
    ])
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created().at(-1)!.body!.payer_email).toBe('otro@mp.invalid')
  })

  it('pending sigue bloqueado hasta que otra lectura confirma la cancelación externa', async () => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    expect((await create()).status).toBe(409)
    expect(old.session.status).toBe('pending')
    expect(w.mp.created()).toHaveLength(1)
    // Sólo el borde simulado cambia el estado; create nunca envía el PUT.
    w.mp.preapprovals.get(old.preapprovalId)!.status = 'cancelled'
    expect((await create()).status).toBe(200)
    expect(old.session.status).toBe('canceled')
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(2)
  })

  it.each(['paid', 'expired', 'canceled'])('estado local concurrente %s antes del CAS: no libera ni crea otro checkout', async state => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mp.preapprovals.get(old.preapprovalId)!.status = 'cancelled'
    const original = w.mp.fetchImpl
    vi.spyOn(w.mp, 'fetchImpl').mockImplementation(async (input, init) => {
      const response = await original(input, init)
      if ((init?.method ?? 'GET') === 'GET' && new URL(input).pathname === `/preapproval/${old.preapprovalId}`) {
        old.session.status = state
      }
      return response
    })
    expect((await create()).status).toBe(409)
    expect(old.session.status).toBe(state)
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(1)
  })

  it('dos cambios de correo concurrentes sobre pending: ambos bloqueados y sin cancelación', async () => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const results = await Promise.all([create('uno@mp.invalid'), create('dos@mp.invalid')])
    expect(results.map(r => r.status)).toEqual([409, 409])
    expect(results.every(r => r.body.init_point === undefined)).toBe(true)
    expect(old.session.status).toBe('pending')
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(1)
  })

  it('dos reemplazos concurrentes de un cancelled confirmado: un cierre condicional y una reserva', async () => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mp.preapprovals.get(old.preapprovalId)!.status = 'cancelled'
    const results = await Promise.all([create('uno@mp.invalid'), create('dos@mp.invalid')])
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    expect(old.session.status).toBe('canceled')
    expect(cancelCalls()).toHaveLength(0)
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

  it.each(['cancelIsIgnored', 'cancelFails'] as const)('vínculo fallido con %s: no intenta cancelar ni libera la reserva para otro POST', async failure => {
    const before = w.snapshot(BIZ_A)
    w.mp[failure] = true
    w.db.failOn = { table: 'subscription_checkout_sessions', op: 'update', code: 'XX000' }
    expect((await create()).status).toBe(503)
    expect(w.db.tables.subscription_checkout_sessions).toHaveLength(1)
    const [session] = w.db.tables.subscription_checkout_sessions
    expect(session).toMatchObject({ status: 'pending', mp_preapproval_id: null })
    expect((await create()).body.code).toBe('checkout_in_progress')
    w.advance(61_000)
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = await create()
      expect(retry.status).toBe(409)
      expect(retry.body.code).toBe('checkout_replacement_blocked')
      expect(retry.body.init_point).toBeUndefined()
    }
    expect(session).toMatchObject({ status: 'pending', mp_preapproval_id: null })
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(1)
    expect([...w.mp.preapprovals.values()].map(p => p.status)).toEqual(['pending'])
    expect(w.db.tables.payments).toHaveLength(0)
    expect(w.snapshot(BIZ_A)).toEqual(before)
  })

  it('respuesta inicial authorized: no cancela un contrato ni abre otro al reintentar', async () => {
    const before = w.snapshot(BIZ_A)
    w.mp.tamperCreated = row => { row.status = 'authorized' }
    const first = await create()
    expect(first.status).toBe(502)
    expect(first.body.init_point).toBeUndefined()
    expect(w.db.tables.subscription_checkout_sessions[0]).toMatchObject({ status: 'pending', mp_preapproval_id: null })
    w.advance(61_000)
    expect((await create()).body.code).toBe('checkout_replacement_blocked')
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(1)
    expect([...w.mp.preapprovals.values()].map(p => p.status)).toEqual(['authorized'])
    expect(w.db.tables.payments).toHaveLength(0)
    expect(w.snapshot(BIZ_A)).toEqual(before)
  })

  it.each(['error', 'missing', 'wrong_id', 'wrong_reference', 'unknown'])('vínculo fallido y relectura %s: conserva la reserva sin cancelar ni crear otra', async fault => {
    const original = w.mp.fetchImpl
    w.db.failOn = { table: 'subscription_checkout_sessions', op: 'update', code: 'XX000' }
    vi.spyOn(w.mp, 'fetchImpl').mockImplementation(async (input, init) => {
      if ((init?.method ?? 'GET') === 'GET' && new URL(input).pathname.startsWith('/preapproval/')) {
        if (fault === 'error' || fault === 'missing') {
          return new Response(JSON.stringify({ message: fault }), { status: fault === 'error' ? 500 : 404 })
        }
        const remote: Record<string, unknown> = { ...[...w.mp.preapprovals.values()][0], status: 'cancelled' }
        if (fault === 'wrong_id') remote.id = 'foreign'
        else if (fault === 'wrong_reference') remote.external_reference = 'trpcs_99999999-9999-4999-8999-999999999999'
        else remote.status = 'unknown'
        return new Response(JSON.stringify(remote), { status: 200 })
      }
      return original(input, init)
    })
    expect((await create()).status).toBe(503)
    w.advance(61_000)
    expect((await create()).body.code).toBe('checkout_replacement_blocked')
    expect(w.db.tables.subscription_checkout_sessions[0]).toMatchObject({ status: 'pending', mp_preapproval_id: null })
    expect(cancelCalls()).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(1)
    expect(w.db.tables.payments).toHaveLength(0)
  })

  it('respuesta inválida: sólo una lectura remota ya cancelled permite cerrar failed y volver a intentar', async () => {
    const original = w.mp.fetchImpl
    w.mp.tamperCreated = row => { row.init_point = null }
    vi.spyOn(w.mp, 'fetchImpl').mockImplementation(async (input, init) => {
      const response = await original(input, init)
      if (init?.method === 'POST') {
        // El POST ya respondió pending sin enlace; sólo el siguiente GET puede
        // aportar evidencia de cancelación. No se ejecuta PUT en este flujo.
        for (const remote of w.mp.preapprovals.values()) remote.status = 'cancelled'
      }
      return response
    })
    expect((await create()).status).toBe(502)
    expect(w.db.tables.subscription_checkout_sessions[0]).toMatchObject({ status: 'failed', mp_preapproval_id: null })
    expect(cancelCalls()).toHaveLength(0)
    vi.restoreAllMocks()
    w.mp.tamperCreated = null
    expect((await create()).status).toBe(200)
    expect(w.mp.created()).toHaveLength(2)
    expect([...w.mp.preapprovals.values()].map(p => p.status)).toEqual(['cancelled', 'pending'])
    expect(cancelCalls()).toHaveLength(0)
    expect(w.db.tables.payments).toHaveLength(0)
  })

  it('vínculo fallido con GET ya cancelled: cierra sólo esa reserva y permite un reintento', async () => {
    const original = w.mp.fetchImpl
    w.db.failOn = { table: 'subscription_checkout_sessions', op: 'update', code: 'XX000' }
    vi.spyOn(w.mp, 'fetchImpl').mockImplementation(async (input, init) => {
      const response = await original(input, init)
      if (init?.method === 'POST') {
        for (const remote of w.mp.preapprovals.values()) remote.status = 'cancelled'
      }
      return response
    })
    expect((await create()).status).toBe(503)
    expect(w.db.tables.subscription_checkout_sessions[0]).toMatchObject({ status: 'failed', mp_preapproval_id: null })
    vi.restoreAllMocks()
    expect((await create()).status).toBe(200)
    expect(w.mp.created()).toHaveLength(2)
    expect([...w.mp.preapprovals.values()].map(p => p.status)).toEqual(['cancelled', 'pending'])
    expect(cancelCalls()).toHaveLength(0)
    expect(w.db.tables.payments).toHaveLength(0)
  })

  it('error de escritura con cancelación externa confirmada: reintento no duplica el ledger', async () => {
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mp.preapprovals.get(old.preapprovalId)!.status = 'cancelled'
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
    expect(cancelCalls()).toHaveLength(0)
  })
})
