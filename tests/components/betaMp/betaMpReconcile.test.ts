// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Fases 6 y 7 — `reconcile` y `status`.
//
// `reconcile` no es «forzar active»: es consultar Mercado Pago y llevar la base
// al estado confirmado, por el MISMO camino que el webhook. Sin evidencia
// suficiente no activa. `status` es una lectura local que no llama a MP.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from 'vitest'
import { BIZ_A, BIZ_B, DAY, HOUR, OWNER_A, OWNER_B, World } from './harness.ts'

let w: World
beforeEach(() => { w = new World() })

const biz = (id = BIZ_A) => w.db.business(id)
const reconcile = (user = OWNER_A, businessId = BIZ_A) => w.call(user, { action: 'reconcile', business_id: businessId })
const sessions = () => w.db.tables.subscription_checkout_sessions

describe('reconcile existe y sincroniza', () => {
  it('la acción existe (antes respondía 400 «Unknown action»)', async () => {
    const res = await reconcile()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ activated: false, confirmed: false, outcome: 'no_checkout' })
    expect(typeof res.body.message).toBe('string')
  })

  it('el webhook se perdió: authorized válido → reconcile activa con el plan de MP', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mpPreapproval('pre_1', { external_reference: reference })      // pagó; el webhook nunca llegó
    expect(biz().subscription_status).toBe('trialing')

    const res = await reconcile()

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ activated: true, confirmed: true, outcome: 'activated', status: 'active', plan: 'pro' })
    expect(res.body.checkout).toMatchObject({ status: 'paid', plan: 'pro' })
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'pro', access_source: 'mercado_pago', mp_preapproval_id: 'pre_1' })
    expect(sessions()[0].status).toBe('paid')
    // El cambio queda auditado con su origen.
    expect(w.db.events('billing_state_applied')[0].raw_payload).toMatchObject({ source: 'reconcile' })
  })

  it('aplica exactamente lo mismo que el webhook (un solo camino)', async () => {
    const porWebhook = new World()
    const a = await porWebhook.openCheckout(OWNER_A, BIZ_A, 'full')
    porWebhook.mpPreapproval('pre_1', { preapproval_plan_id: 'mpplan_full_m', external_reference: a.reference })
    await porWebhook.notify('subscription_preapproval', 'pre_1')

    const b = await w.openCheckout(OWNER_A, BIZ_A, 'full')
    w.mpPreapproval('pre_1', { preapproval_plan_id: 'mpplan_full_m', external_reference: b.reference })
    await reconcile()

    const sinMarcas = ({ last_webhook_at: _w, updated_at: _u, ...resto }: Record<string, unknown>) => resto
    expect(sinMarcas(w.snapshot(BIZ_A))).toEqual(sinMarcas(porWebhook.snapshot(BIZ_A)))
  })

  it('reconcile repetido es idempotente: la segunda vez no escribe nada', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mpPreapproval('pre_1', { external_reference: reference })
    await reconcile()
    const estado = w.snapshot(BIZ_A)
    const escrituras = w.db.writes.length

    for (let i = 0; i < 3; i++) {
      const res = await reconcile()
      expect(res.body).toMatchObject({ activated: true, outcome: 'already_active' })
    }
    expect(w.db.writes.length).toBe(escrituras)
    expect(w.snapshot(BIZ_A)).toEqual(estado)
    expect(w.db.events('billing_state_applied')).toHaveLength(1)
  })

  it('el plan sale de MP también acá: pidió Full, pagó Básico → Básico', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'full')
    // Pagó otro plan con la misma referencia: la búsqueda por el plan ESPERADO no
    // lo encuentra, así que reconcile no confirma nada…
    w.mpPreapproval('pre_1', { preapproval_plan_id: 'mpplan_basico_m', external_reference: reference })
    const res = await reconcile()
    expect(res.body.activated).toBe(false)
    expect(biz().subscription_plan).toBeNull()
    // …y cuando llega el webhook, otorga lo que MP confirma.
    await w.notify('subscription_preapproval', 'pre_1')
    expect(biz().subscription_plan).toBe('basico')
  })
})

describe('sin evidencia suficiente, no activa', () => {
  it('pending → no activa y lo dice', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mpPreapproval('pre_1', { status: 'pending', external_reference: reference })
    const antes = w.snapshot(BIZ_A)
    const res = await reconcile()

    expect(res.body).toMatchObject({ activated: false, confirmed: false, outcome: 'pending' })
    expect(res.body.checkout).toMatchObject({ status: 'pending' })
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })

  it('plan de MP desconocido → no activa', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mpPreapproval('pre_1', { external_reference: reference })
    w.env.MP_PLAN_PRO_MONTHLY = 'mpplan_pro_m_NUEVO'    // el secret cambió después del checkout
    const antes = w.snapshot(BIZ_A)
    const res = await reconcile()

    expect(res.body).toMatchObject({ activated: false, outcome: 'unknown_plan' })
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })

  it('ninguna coincidencia → no activa', async () => {
    await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    // Hay suscripciones del mismo plan en MP, pero ninguna con la referencia de A.
    w.mpPreapproval('pre_otro', { external_reference: 'trpcs_99999999-9999-4999-8999-999999999999' })
    w.mpPreapproval('pre_sin_ref', { external_reference: null })
    const antes = w.snapshot(BIZ_A)
    const res = await reconcile()

    expect(res.body).toMatchObject({ activated: false, outcome: 'not_found' })
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })

  it('coincidencia ambigua (dos suscripciones autorizadas para el mismo checkout) → no activa ninguna', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mpPreapproval('pre_1', { external_reference: reference })
    w.mpPreapproval('pre_2', { external_reference: reference })
    const antes = w.snapshot(BIZ_A)
    const res = await reconcile()

    expect(res.body).toMatchObject({ activated: false, outcome: 'ambiguous' })
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(sessions()[0].status).toBe('pending')
  })

  it('el mismo email de pagador NO alcanza: una suscripción de otro negocio no se toma', async () => {
    // B paga Pro con el mismo email con el que A abrió su checkout.
    await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const b = await w.openCheckout(OWNER_B, BIZ_B, 'pro')
    w.mpPreapproval('pre_b', { external_reference: b.reference, payer_email: 'aaaaaaaa@invalid.test' })

    const res = await reconcile(OWNER_A, BIZ_A)
    expect(res.body.activated).toBe(false)
    expect(biz(BIZ_A).subscription_status).toBe('trialing')
    expect(biz(BIZ_A).mp_preapproval_id).toBeNull()
    // Y la búsqueda de A no activó a B por la puerta de atrás.
    expect(biz(BIZ_B).mp_preapproval_id).toBeNull()
  })

  it('un preapproval anotado en la sesión que ya no lleva su referencia no se usa', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mpPreapproval('pre_1', { status: 'pending', external_reference: reference })
    await w.notify('subscription_preapproval', 'pre_1')              // la sesión anota pre_1
    Object.assign(w.mp.preapprovals.get('pre_1')!, { status: 'authorized', external_reference: 'otra-cosa' })

    const res = await reconcile()
    expect(res.body.activated).toBe(false)
    expect(biz().subscription_status).toBe('trialing')
  })

  it('un checkout vencido ya no se busca en Mercado Pago', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.advance(3 * DAY)
    w.mp.calls.length = 0
    const res = await reconcile()
    expect(res.body.checkout).toMatchObject({ status: 'expired' })
    expect(w.mp.callsTo('GET', '/preapproval/search')).toEqual([])
    // Si igual se paga con esa referencia, el webhook sí lo honra: el pago es real.
    w.mpPreapproval('pre_tarde', { external_reference: reference })
    await w.notify('subscription_preapproval', 'pre_tarde')
    expect(biz().subscription_status).toBe('active')
  })

  it('Mercado Pago caído → 502, sin cambios', async () => {
    await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mp.down = true
    const antes = w.snapshot(BIZ_A)
    const res = await reconcile()
    expect(res.status).toBe(502)
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })
})

describe('la búsqueda en Mercado Pago', () => {
  it('filtra por el plan esperado y exige la referencia exacta, página por página', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    for (let i = 0; i < 120; i++) w.mpPreapproval(`pre_ruido_${i}`, { external_reference: null })
    w.mpPreapproval('pre_mio', { external_reference: reference })

    const res = await reconcile()
    expect(res.body.activated).toBe(true)
    expect(biz().mp_preapproval_id).toBe('pre_mio')
    const busquedas = w.mp.callsTo('GET', '/preapproval/search')
    expect(busquedas.length).toBe(3)                                  // 121 resultados, páginas de 50
    expect(busquedas.every((c) => c.path.includes('preapproval_plan_id=mpplan_pro_m'))).toBe(true)
    // El email del pagador no es un criterio de búsqueda.
    expect(busquedas.some((c) => c.path.includes('payer_email'))).toBe(false)
  })

  it('si MP ignora el offset (misma página una y otra vez) corta y no confirma', async () => {
    await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    for (let i = 0; i < 120; i++) w.mpPreapproval(`pre_ruido_${i}`, { external_reference: null })
    w.mp.searchIgnoresOffset = true
    const res = await reconcile()
    expect(res.body.activated).toBe(false)
    expect(w.mp.callsTo('GET', '/preapproval/search').length).toBe(2)
  })

  it('antes de aplicar relee el preapproval: un resultado de búsqueda atrasado no activa', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const pre = w.mpPreapproval('pre_1', { external_reference: reference })
    // El índice de búsqueda dice authorized; la lectura directa ya dice cancelled.
    const original = w.mp.fetchImpl
    Object.assign(w.mp, { fetchImpl: async (input: string, init?: RequestInit) => {
      if (new URL(input).pathname === '/preapproval/pre_1') return new Response(JSON.stringify({ ...pre, status: 'cancelled' }), { status: 200 })
      return original(input, init)
    } })
    const res = await reconcile()
    expect(res.body.activated).toBe(false)
    expect(biz().subscription_status).toBe('trialing')
  })
})

describe('suscripción ya vinculada', () => {
  it('refleja en la base una baja hecha directamente en Mercado Pago', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    w.advance(HOUR)
    Object.assign(w.mp.preapprovals.get('pre_1')!, { status: 'cancelled', last_modified: w.now().toISOString() })
    const res = await reconcile()
    expect(res.body).toMatchObject({ activated: false, outcome: 'cancelled', status: 'canceled' })
    expect(biz().subscription_status).toBe('canceled')
  })

  it('en mora por un cobro rechazado: «Verificar pago» no reactiva ni renueva la gracia', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    Object.assign(biz(), { subscription_status: 'past_due', last_payment_status: 'rejected', grace_until: '2026-10-04T12:00:00.000Z' })
    for (let i = 0; i < 3; i++) {
      w.advance(HOUR)
      const res = await reconcile()
      expect(res.body).toMatchObject({ activated: false, outcome: 'payment_rejected', status: 'past_due' })
    }
    expect(biz()).toMatchObject({ subscription_status: 'past_due', grace_until: '2026-10-04T12:00:00.000Z' })
  })

  it('con un plan activo y un checkout nuevo sin pagar: no confirma el checkout ni toca el plan', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    w.advance(HOUR)
    await w.openCheckout(OWNER_A, BIZ_A, 'full')
    const res = await reconcile()
    // La suscripción vigente sigue activa…
    expect(res.body).toMatchObject({ activated: true, plan: 'basico' })
    // …pero ESTE checkout no está confirmado: la pantalla de espera mira esto.
    expect(res.body.checkout).toMatchObject({ status: 'pending', plan: 'full' })
    expect(biz().subscription_plan).toBe('basico')
  })
})

describe('status: lectura local', () => {
  it('no consulta a Mercado Pago ni escribe nada', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    w.mp.calls.length = 0
    w.db.writes.length = 0
    const res = await w.call(OWNER_A, { action: 'status', business_id: BIZ_A })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      source: 'database', subscription_status: 'active', subscription_plan: 'pro',
      access_source: 'mercado_pago', has_mp_subscription: true,
    })
    expect(res.body.checkout).toMatchObject({ status: 'paid', plan: 'pro', billing_cycle: 'monthly' })
    expect(w.mp.calls).toEqual([])
    expect(w.db.writes).toEqual([])
  })

  it('no devuelve el objeto de Mercado Pago ni datos del pagador', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    const res = await w.call(OWNER_A, { action: 'status', business_id: BIZ_A })
    expect(res.body.mp_live).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toMatch(/pagador@|pre_1|init_point/)
  })

  it('status y reconcile informan el mismo estado: no hay dos mapeos', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    const estado = await w.call(OWNER_A, { action: 'status', business_id: BIZ_A })
    const verificado = await reconcile()
    expect(estado.body.subscription_status).toBe(verificado.body.status)
    expect(estado.body.subscription_plan).toBe(verificado.body.plan)
    expect(estado.body.checkout).toEqual(verificado.body.checkout)
  })

  it('sin checkout: checkout null', async () => {
    const res = await w.call(OWNER_A, { action: 'status', business_id: BIZ_A })
    expect(res.body.checkout).toBeNull()
    expect(res.body.subscription_status).toBe('trialing')
  })
})
