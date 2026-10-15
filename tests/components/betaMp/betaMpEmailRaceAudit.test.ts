// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { BIZ_A, OWNER_A, World } from './harness.ts'

describe('BETA-MP-EMAIL: carrera entre lectura pendiente y autorización remota', () => {
  it.each([false, true])('no cancela ni reemplaza si la autorización ocurre después del GET (pago aprobado: %s)', async paid => {
    const w = new World()
    const old = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const before = w.snapshot(BIZ_A)
    const original = w.mp.fetchImpl
    let transitioned = false
    vi.spyOn(w.mp, 'fetchImpl').mockImplementation(async (input, init) => {
      // La respuesta GET ya contiene pending. Antes de entregarla al backend,
      // el usuario termina en otra pestaña. No existe notificación local aún.
      const response = await original(input, init)
      if (!transitioned && (init?.method ?? 'GET') === 'GET'
        && new URL(input).pathname === `/preapproval/${old.preapprovalId}`) {
        transitioned = true
        if (paid) w.pay(old.preapprovalId)
        else w.mp.authorize(old.preapprovalId)
      }
      return response
    })

    const res = await w.call(OWNER_A, {
      action: 'create', business_id: BIZ_A, plan: 'pro', billing_cycle: 'monthly', mp_payer_email: 'otro@mp.invalid',
    })

    expect(transitioned).toBe(true)
    expect(res.status).toBe(409)
    expect(res.body.init_point).toBeUndefined()
    expect(w.mp.callsTo('PUT', '/preapproval/')).toHaveLength(0)
    expect(w.mp.created()).toHaveLength(1)
    expect(w.mp.preapprovals.get(old.preapprovalId)!.status).toBe('authorized')
    expect(old.session.status).toBe('pending')
    expect(w.snapshot(BIZ_A)).toEqual(before)
    expect(w.db.tables.payments).toHaveLength(0)
  })
})
