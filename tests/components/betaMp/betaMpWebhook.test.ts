// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Fase 5 — garantías del webhook: idempotencia, orden y ledger.
//
// La firma HMAC se valida en `mp-webhook/index.ts` (la cubre el guard estático);
// acá se prueba lo que pasa DESPUÉS de una notificación válida.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from 'vitest'
import { MpApiError } from '../../../supabase/functions/_shared/billing/mpClient.ts'
import { IGNORED_PAYMENT_TOPIC, parseNotification } from '../../../supabase/functions/_shared/billing/webhook.ts'
import { BIZ_A, BIZ_B, DAY, HOUR, OWNER_A, OWNER_B, World } from './harness.ts'

let w: World
beforeEach(() => { w = new World() })

const biz = (id = BIZ_A) => w.db.business(id)

/** Un cobro recurrente de la suscripción, tal como lo expone Mercado Pago. */
function cobro(id: string, preapprovalId: string, estado: string, opts: { aprobadoEn?: Date; monto?: number } = {}) {
  const cuando = (opts.aprobadoEn ?? w.now()).toISOString()
  w.mp.authorizedPayments.set(id, {
    id, preapproval_id: preapprovalId, status: 'processed', transaction_amount: opts.monto ?? 25000, currency_id: 'ARS',
    date_created: cuando, debit_date: cuando, payment: { id: `pay_${id}`, status: estado },
  })
  w.mp.payments.set(`pay_${id}`, {
    id: `pay_${id}`, status: estado, status_detail: estado === 'approved' ? 'accredited' : 'cc_rejected_other_reason',
    transaction_amount: opts.monto ?? 25000, currency_id: 'ARS', date_created: cuando,
    date_approved: estado === 'approved' ? cuando : null,
    // Datos del pagador que NO deben terminar en una fila legible por el equipo.
    payer: { email: 'pagador@invalid.test', identification: { type: 'DNI', number: '00000000' } },
    card: { last_four_digits: '0000', cardholder: { name: 'TITULAR DE PRUEBA' } },
  })
}

describe('idempotencia', () => {
  it('la misma notificación dos veces: se procesa una sola vez', async () => {
    await w.openCheckout(OWNER_A, BIZ_A, 'pro', 'monthly', 'pre_1')
    w.pay('pre_1')

    const primera = await w.notify('subscription_preapproval', 'pre_1', 7001)
    const escrituras = w.db.writes.length
    const estado = w.snapshot(BIZ_A)
    const segunda = await w.notify('subscription_preapproval', 'pre_1', 7001)

    expect(primera.result).toBe('processed')
    expect(segunda.result).toBe('duplicate')
    expect(w.db.writes.length).toBe(escrituras)
    expect(w.snapshot(BIZ_A)).toEqual(estado)
    expect(w.db.events('subscription_preapproval')).toHaveLength(1)
    expect(w.db.events('billing_state_applied')).toHaveLength(1)
  })

  it('otra notificación con el MISMO estado: se procesa y no cambia nada', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    const estado = w.snapshot(BIZ_A)
    const out = await w.notify('subscription_preapproval', 'pre_1')

    expect(out.result).toBe('processed')
    const { last_webhook_at: _a, updated_at: _b, ...antes } = estado
    const { last_webhook_at: _c, updated_at: _d, ...despues } = w.snapshot(BIZ_A)
    expect(despues).toEqual(antes)
    expect(w.db.events('billing_state_applied')).toHaveLength(1)   // sin un segundo cambio de acceso
  })

  it('un intento que falló a mitad de camino queda SIN procesar y el reintento lo completa', async () => {
    await w.openCheckout(OWNER_A, BIZ_A, 'pro', 'monthly', 'pre_1')
    w.pay('pre_1')
    w.mp.down = true
    await expect(w.notify('subscription_preapproval', 'pre_1', 7002)).rejects.toBeInstanceOf(MpApiError)

    const fallido = w.db.events('subscription_preapproval')[0]
    expect(fallido.processed).toBe(false)
    expect(String(fallido.error_message)).toMatch(/Mercado Pago/)
    expect(biz().subscription_status).toBe('trialing')

    w.mp.down = false
    const reintento = await w.notify('subscription_preapproval', 'pre_1', 7002)
    expect(reintento.result).toBe('processed')
    expect(biz().subscription_status).toBe('active')
    expect(w.db.events('subscription_preapproval')).toHaveLength(1)
    expect(w.db.events('subscription_preapproval')[0].processed).toBe(true)
  })

  it('una notificación sobre un recurso que MP no devuelve se reintenta (no se da por procesada)', async () => {
    await expect(w.notify('subscription_preapproval', 'pre_inexistente', 7003)).rejects.toBeInstanceOf(MpApiError)
    expect(w.db.events('subscription_preapproval')[0].processed).toBe(false)
  })

  it('la escritura del negocio falla a mitad de camino: queda SIN procesar y el reintento activa', async () => {
    await w.openCheckout(OWNER_A, BIZ_A, 'pro', 'monthly', 'pre_1')
    w.pay('pre_1')
    w.db.failOn = { table: 'businesses', op: 'update', code: 'XX000' }
    await expect(w.notify('subscription_preapproval', 'pre_1', 7004)).rejects.toThrow(/billing del negocio/)
    expect(w.db.events('subscription_preapproval')[0].processed).toBe(false)
    expect(biz().subscription_status).toBe('trialing')

    const reintento = await w.notify('subscription_preapproval', 'pre_1', 7004)
    expect(reintento.result).toBe('processed')
    expect(biz()).toMatchObject({ subscription_status: 'active', mp_preapproval_id: 'pre_1' })
  })

  it('el estado NUNCA sale del cuerpo del webhook: sólo se usa data.id', async () => {
    await w.openCheckout(OWNER_A, BIZ_A, 'full', 'monthly', 'pre_1')   // en Mercado Pago sigue pending
    // Un cuerpo que «dice» authorized / full no vale nada: se relee en MP.
    const n = parseNotification({ id: 1, type: 'subscription_preapproval', data: { id: 'pre_1', status: 'authorized', plan: 'full' }, status: 'authorized' })
    expect(n).toMatchObject({ topic: 'subscription_preapproval', resourceId: 'pre_1', notificationId: '1' })
    await w.notify('subscription_preapproval', 'pre_1')
    expect(biz().subscription_status).toBe('trialing')
  })
})

describe('eventos fuera de orden', () => {
  it('un evento viejo no pisa uno nuevo', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    const t0 = w.now().toISOString()

    // Mercado Pago ya canceló (t1) y nuestra base lo aplicó.
    w.advance(HOUR)
    Object.assign(w.mp.preapprovals.get('pre_1')!, { status: 'cancelled', last_modified: w.now().toISOString() })
    await w.notify('subscription_preapproval', 'pre_1')
    expect(biz().subscription_status).toBe('canceled')

    // Llega tarde una lectura con el estado anterior (t0, authorized).
    Object.assign(w.mp.preapprovals.get('pre_1')!, { status: 'authorized', last_modified: t0 })
    const out = await w.notify('subscription_preapproval', 'pre_1')
    expect(out.detail).toBe('not_applied:stale')
    expect(biz().subscription_status).toBe('canceled')
  })
})

describe('`payment` no es una autoridad de billing', () => {
  it('no escribe el ledger ni el negocio, aunque su external_reference sea el id de un negocio', async () => {
    w.mp.payments.set('pay_suelto', { id: 'pay_suelto', status: 'approved', transaction_amount: 1, external_reference: BIZ_B, metadata: { business_id: BIZ_B } })
    const antes = w.snapshot(BIZ_B)
    const out = await w.notify('payment', 'pay_suelto')

    expect(out.detail).toBe(IGNORED_PAYMENT_TOPIC)
    expect(w.db.tables.payments).toHaveLength(0)
    expect(w.snapshot(BIZ_B)).toEqual(antes)
    expect(w.mp.calls).toEqual([])                                  // ni siquiera se consulta
    expect(w.db.events('payment')[0]).toMatchObject({ processed: true, business_id: null })
  })

  it('un tipo de notificación desconocido se registra y no hace nada', async () => {
    const out = await w.notify('subscription_preapproval_plan', 'plan_del_panel')
    expect(out.detail).toBe('ignored:unhandled_topic')
    expect(w.db.writesTo('businesses')).toEqual([])
  })
})

describe('cobros recurrentes (subscription_authorized_payment)', () => {
  beforeEach(async () => { await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1') })

  it('cobro aprobado → una fila en el ledger, período y último pago', async () => {
    w.advance(HOUR)
    cobro('inv_1', 'pre_1', 'approved')
    await w.notify('subscription_authorized_payment', 'inv_1')

    expect(w.db.tables.payments).toHaveLength(1)
    expect(w.db.tables.payments[0]).toMatchObject({
      business_id: BIZ_A, provider: 'mercadopago', external_payment_id: 'inv_1', type: 'recurring',
      amount: 25000, currency: 'ARS', status: 'approved', subscription_plan: 'pro',
    })
    expect(biz()).toMatchObject({ subscription_status: 'active', last_payment_status: 'approved', last_payment_id: 'pay_inv_1' })
    expect(new Date(String(biz().current_period_start)).getTime()).toBe(w.now().getTime())
  })

  it('el ledger guarda un recorte: nunca el documento ni la tarjeta del pagador', async () => {
    cobro('inv_1', 'pre_1', 'approved')
    await w.notify('subscription_authorized_payment', 'inv_1')
    const crudo = JSON.stringify(w.db.tables.payments[0].raw_payload)
    expect(crudo).not.toMatch(/identification|00000000|last_four|TITULAR|pagador@/)
    expect(w.db.tables.payments[0].raw_payload).toMatchObject({ preapproval_id: 'pre_1', payment_status: 'approved' })
  })

  it('el mismo cobro notificado dos veces (scheduled → processed) deja UNA fila actualizada', async () => {
    cobro('inv_1', 'pre_1', 'pending')
    await w.notify('subscription_authorized_payment', 'inv_1', 8001)
    expect(w.db.tables.payments[0].status).toBe('pending')

    cobro('inv_1', 'pre_1', 'approved')
    await w.notify('subscription_authorized_payment', 'inv_1', 8002)   // mismo data.id, otra notificación
    expect(w.db.tables.payments).toHaveLength(1)
    expect(w.db.tables.payments[0].status).toBe('approved')
  })

  it('«aprobado» sale sólo del pago consultado: un cobro `processed` sin pago queda pending', async () => {
    w.mp.authorizedPayments.set('inv_1', { id: 'inv_1', preapproval_id: 'pre_1', status: 'processed', transaction_amount: 25000 })
    await w.notify('subscription_authorized_payment', 'inv_1')
    expect(w.db.tables.payments[0].status).toBe('pending')
    expect(biz().last_payment_status).toBeNull()
  })

  it('cobro rechazado → past_due + gracia; un segundo rechazo NO renueva la gracia', async () => {
    w.advance(HOUR)
    cobro('inv_1', 'pre_1', 'rejected')
    await w.notify('subscription_authorized_payment', 'inv_1')
    expect(biz()).toMatchObject({ subscription_status: 'past_due', last_payment_status: 'rejected' })
    const gracia = String(biz().grace_until)
    expect(new Date(gracia).getTime() - w.now().getTime()).toBe(3 * DAY)

    w.advance(DAY)
    cobro('inv_2', 'pre_1', 'rejected')
    await w.notify('subscription_authorized_payment', 'inv_2')
    expect(biz().grace_until).toBe(gracia)
  })

  it('en mora por un cobro rechazado, que el preapproval siga authorized NO reactiva', async () => {
    w.advance(HOUR)
    cobro('inv_1', 'pre_1', 'rejected')
    await w.notify('subscription_authorized_payment', 'inv_1')
    w.advance(HOUR)
    w.mp.preapprovals.get('pre_1')!.last_modified = w.now().toISOString()
    const out = await w.notify('subscription_preapproval', 'pre_1')

    expect(out.detail).toBe('unchanged:awaiting_payment')
    expect(biz().subscription_status).toBe('past_due')
  })

  it('…y la mora la levanta un cobro aprobado', async () => {
    w.advance(HOUR)
    cobro('inv_1', 'pre_1', 'rejected')
    await w.notify('subscription_authorized_payment', 'inv_1')
    w.advance(DAY)
    cobro('inv_1', 'pre_1', 'approved')
    await w.notify('subscription_authorized_payment', 'inv_1')
    expect(biz()).toMatchObject({ subscription_status: 'active', grace_until: null, last_payment_status: 'approved' })
  })

  it('un cobro aprobado tardío NO revive una suscripción cancelada', async () => {
    w.advance(HOUR)
    Object.assign(w.mp.preapprovals.get('pre_1')!, { status: 'cancelled', last_modified: w.now().toISOString() })
    await w.notify('subscription_preapproval', 'pre_1')
    expect(biz().subscription_status).toBe('canceled')

    w.advance(HOUR)
    cobro('inv_tarde', 'pre_1', 'approved')
    await w.notify('subscription_authorized_payment', 'inv_tarde')
    expect(biz().subscription_status).toBe('canceled')
    expect(w.db.tables.payments).toHaveLength(1)        // el cobro existió: queda en el ledger
  })

  it('un cobro viejo rechazado, notificado tarde, no manda a mora a una cuenta que ya pagó', async () => {
    const haceUnMes = new Date(w.now().getTime() - 30 * DAY)
    w.advance(HOUR)
    cobro('inv_actual', 'pre_1', 'approved')
    await w.notify('subscription_authorized_payment', 'inv_actual')

    cobro('inv_viejo', 'pre_1', 'rejected', { aprobadoEn: haceUnMes })
    const out = await w.notify('subscription_authorized_payment', 'inv_viejo')
    expect(out.detail).toBe('ledger_only:older_than_current_period')
    expect(biz()).toMatchObject({ subscription_status: 'active', last_payment_status: 'approved' })
  })

  it('el cobro llega ANTES que el webhook del preapproval: activa igual, por el mismo camino', async () => {
    await w.openCheckout(OWNER_B, BIZ_B, 'full', 'monthly', 'pre_b')
    w.pay('pre_b')
    cobro('inv_b', 'pre_b', 'approved', { monto: 45000 })
    await w.notify('subscription_authorized_payment', 'inv_b')

    expect(biz(BIZ_B)).toMatchObject({ subscription_status: 'active', subscription_plan: 'full', mp_preapproval_id: 'pre_b', last_payment_status: 'approved' })
    expect(w.db.tables.payments[0]).toMatchObject({ business_id: BIZ_B, subscription_plan: 'full', amount: 45000 })
  })

  it('si el ledger no se puede escribir, la notificación NO se da por procesada (Mercado Pago reintenta)', async () => {
    // El estado real de la base antes de la migración: el upsert de `payments`
    // falla con 42P10. Antes ese error se ignoraba y el cobro se perdía en silencio.
    w.db.preMigration = true
    cobro('inv_1', 'pre_1', 'approved')
    await expect(w.notify('subscription_authorized_payment', 'inv_1', 8100)).rejects.toThrow(/ledger/)
    expect(w.db.events('subscription_authorized_payment')[0]).toMatchObject({ processed: false })
    expect(biz().last_payment_status).toBeNull()

    w.db.preMigration = false
    const reintento = await w.notify('subscription_authorized_payment', 'inv_1', 8100)
    expect(reintento.result).toBe('processed')
    expect(w.db.tables.payments).toHaveLength(1)
  })

  it('un cobro de una suscripción que el servidor no creó no escribe nada', async () => {
    // El cobro real del smoke del 2026-10-02: un preapproval del plan del panel.
    w.mp.seedForeignPreapproval('pre_ajeno', { external_reference: '' })
    cobro('inv_x', 'pre_ajeno', 'approved')
    const antesDelCobro = w.db.writesTo('businesses').length
    const out = await w.notify('subscription_authorized_payment', 'inv_x')
    expect(out.detail).toBe('not_applied:unknown_preapproval')
    expect(w.db.tables.payments).toHaveLength(0)
    expect(w.db.writesTo('businesses').length).toBe(antesDelCobro)
  })

  it('un cobro aprobado de un checkout cuyas condiciones no coinciden no activa', async () => {
    await w.openCheckout(OWNER_B, BIZ_B, 'full', 'monthly', 'pre_b')
    w.pay('pre_b')
    Object.assign(w.mp.preapprovals.get('pre_b')!.auto_recurring as Record<string, unknown>, { transaction_amount: 15000 })
    cobro('inv_b', 'pre_b', 'approved', { monto: 15000 })
    await w.notify('subscription_authorized_payment', 'inv_b')

    expect(biz(BIZ_B)).toMatchObject({ subscription_status: 'trialing', mp_preapproval_id: null })
  })
})
