// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BIZ_A, BIZ_B, DAY, OWNER_A, OWNER_B, World } from './harness.ts'

describe('BETA-MP-EMAIL: aislamiento de una reserva histórica sin ID', () => {
  it.each(['pro', 'full'])('conserva la fila y bloquea %s sólo para su negocio, sin buscar ni asociar en MP', async plan => {
    const w = new World()
    w.advance(13 * DAY)
    const legacy = {
      id: '00000000-0000-4000-8000-00000000a001', business_id: BIZ_A, user_id: OWNER_A,
      plan_id: 'pro', billing_cycle: 'monthly', amount: 25000, currency: 'ARS', status: 'pending',
      external_reference: 'trpcs_cccccccc-0000-4000-8000-00000000a001',
      mp_preapproval_plan_id: 'synthetic_legacy_plan', mp_preapproval_id: null, mp_preference_id: null,
      payer_email: null, confirmed_at: null,
      created_at: '2026-10-02T12:00:00.000Z', updated_at: '2026-10-02T12:00:00.000Z',
    }
    w.db.tables.subscription_checkout_sessions.push(legacy)
    const original = structuredClone(legacy)
    const before = w.snapshot(BIZ_A)
    const response = await w.call(OWNER_A, { action: 'create', business_id: BIZ_A, plan, billing_cycle: 'monthly' })
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('checkout_replacement_blocked')
    expect(legacy).toEqual(original)
    expect(w.snapshot(BIZ_A)).toEqual(before)
    expect(w.mp.calls).toEqual([])
    expect(w.db.writes).toEqual([])

    const other = await w.call(OWNER_B, { action: 'create', business_id: BIZ_B, plan: 'pro', billing_cycle: 'monthly' })
    expect(other.status).toBe(200)
    expect(w.mp.created()).toHaveLength(1)
    expect(legacy).toEqual(original)
    expect(w.db.tables.payments).toHaveLength(0)
  })
})
