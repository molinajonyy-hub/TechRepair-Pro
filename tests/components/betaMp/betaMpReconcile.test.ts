// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Plan B — `reconcile` y `status`.
//
// `reconcile` no es «forzar active»: relee en Mercado Pago, POR ID, los
// preapprovals que el servidor creó para ese negocio, y lleva la base al estado
// confirmado por el MISMO camino que el webhook. Es la vía de recuperación
// cuando Mercado Pago no notifica (en el smoke real del 2026-10-02 `mp-webhook`
// no recibió ninguna notificación). No busca nada por plan, email ni fecha.
// `status` es una lectura local que no llama a MP.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from 'vitest'
import { BIZ_A, BIZ_B, DAY, HOUR, OWNER_A, OWNER_B, World } from './harness.ts'

let w: World
beforeEach(() => { w = new World() })

const biz = (id = BIZ_A) => w.db.business(id)
const reconcile = (user = OWNER_A, businessId = BIZ_A) => w.call(user, { action: 'reconcile', business_id: businessId })
const sinMarcas = ({ last_webhook_at: _w, updated_at: _u, ...resto }: Record<string, unknown>) => resto

describe('reconcile sin webhook recupera la compra', () => {
  it('sin ningún checkout: lo dice y no activa', async () => {
    const res = await reconcile()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ activated: false, confirmed: false, outcome: 'no_checkout' })
    expect(typeof res.body.message).toBe('string')
  })

  it('el webhook nunca llegó: authorized en Mercado Pago → reconcile activa con el plan de la sesión', async () => {
    const { preapprovalId, session } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.pay(preapprovalId)                                 // pagó; ninguna notificación
    expect(biz().subscription_status).toBe('trialing')
    expect(w.db.events()).toHaveLength(0)

    const res = await reconcile()

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ activated: true, confirmed: true, outcome: 'activated', status: 'active', plan: 'pro' })
    expect(res.body.checkout).toMatchObject({ status: 'paid', plan: 'pro' })
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'pro', access_source: 'mercado_pago', mp_preapproval_id: preapprovalId })
    expect(session.status).toBe('paid')
    // El cambio queda auditado con su origen.
    expect(w.db.events('billing_state_applied')[0].raw_payload).toMatchObject({ source: 'reconcile', linked_by: 'preapproval_id' })
  })

  it('lee el preapproval DIRECTO por el id guardado en la sesión: una sola lectura, ninguna búsqueda', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.pay(preapprovalId)
    w.mp.calls.length = 0
    await reconcile()

    expect(w.mp.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /preapproval/${preapprovalId}`])
    expect(w.mp.calls.some((c) => c.path.includes('search') || c.path.includes('payer_email'))).toBe(false)
  })

  it('Mercado Pago no devuelve la referencia (smoke real): reconcile recupera igual, por id', async () => {
    w.mp.dropsExternalReference = true
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.pay(preapprovalId)

    const res = await reconcile()
    expect(res.body).toMatchObject({ activated: true, outcome: 'activated', plan: 'basico' })
    expect(biz().mp_preapproval_id).toBe(preapprovalId)
  })

  it('un checkout vencido que se pagó también se recupera: el pago es real', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.advance(3 * DAY)
    w.pay(preapprovalId)
    const res = await reconcile()
    expect(res.body).toMatchObject({ activated: true, plan: 'pro' })
  })

  it('con dos intenciones pagas queda vigente la más nueva, y la anterior se cancela en Mercado Pago', async () => {
    const vieja = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.advance(HOUR)
    const nueva = await w.openCheckout(OWNER_A, BIZ_A, 'full')
    w.pay(vieja.preapprovalId)
    w.pay(nueva.preapprovalId)

    const res = await reconcile()
    expect(res.body).toMatchObject({ activated: true, plan: 'full' })
    expect(biz().mp_preapproval_id).toBe(nueva.preapprovalId)
    expect(w.mp.preapprovals.get(vieja.preapprovalId)?.status).toBe('cancelled')
  })
})

describe('webhook y reconcile convergen al mismo resultado', () => {
  it('aplican exactamente lo mismo (un solo camino)', async () => {
    const porWebhook = new World()
    const a = await porWebhook.openCheckout(OWNER_A, BIZ_A, 'full', 'monthly', 'pre_1')
    porWebhook.pay(a.preapprovalId)
    await porWebhook.notify('subscription_preapproval', 'pre_1')

    const b = await w.openCheckout(OWNER_A, BIZ_A, 'full', 'monthly', 'pre_1')
    w.pay(b.preapprovalId)
    await reconcile()

    expect(sinMarcas(w.snapshot(BIZ_A))).toEqual(sinMarcas(porWebhook.snapshot(BIZ_A)))
    expect(b.session.status).toBe(a.session.status)
  })

  it('reconcile primero, webhook después: el webhook no cambia nada', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.pay(preapprovalId)
    await reconcile()
    const estado = sinMarcas(w.snapshot(BIZ_A))

    const out = await w.notify('subscription_preapproval', preapprovalId)
    expect(out.result).toBe('processed')
    expect(sinMarcas(w.snapshot(BIZ_A))).toEqual(estado)
    expect(w.db.events('billing_state_applied')).toHaveLength(1)
  })

  it('webhook primero, reconcile después: reconcile no cambia nada', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.pay(preapprovalId)
    await w.notify('subscription_preapproval', preapprovalId)
    const estado = w.snapshot(BIZ_A)
    const escrituras = w.db.writes.length

    const res = await reconcile()
    expect(res.body).toMatchObject({ activated: true, outcome: 'already_active' })
    expect(w.snapshot(BIZ_A)).toEqual(estado)
    expect(w.db.writes.length).toBe(escrituras)
  })
})

describe('doble reconcile idempotente', () => {
  it('la segunda vez (y la tercera) no escribe nada', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.pay(preapprovalId)
    const primera = await reconcile()
    expect(primera.body.outcome).toBe('activated')
    const estado = w.snapshot(BIZ_A)
    const escrituras = w.db.writes.length

    for (let i = 0; i < 3; i++) {
      const res = await reconcile()
      expect(res.body).toMatchObject({ activated: true, outcome: 'already_active' })
    }
    expect(w.db.writes.length).toBe(escrituras)
    expect(w.snapshot(BIZ_A)).toEqual(estado)
    expect(w.db.events('billing_state_applied')).toHaveLength(1)
    // Y no cancela ni crea nada en Mercado Pago.
    expect(w.mp.callsTo('PUT', '/preapproval/')).toEqual([])
    expect(w.mp.created()).toHaveLength(1)
  })

  it('dos reconcile simultáneos convergen al mismo estado', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.pay(preapprovalId)
    const [a, b] = await Promise.all([reconcile(), reconcile()])

    expect(a.body.activated).toBe(true)
    expect(b.body.activated).toBe(true)
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'pro', mp_preapproval_id: preapprovalId })
  })
})

describe('sin evidencia suficiente, no activa', () => {
  it('pending en Mercado Pago → no activa y lo dice', async () => {
    await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const antes = w.snapshot(BIZ_A)
    const res = await reconcile()

    expect(res.body).toMatchObject({ activated: false, confirmed: false, outcome: 'pending' })
    expect(res.body.checkout).toMatchObject({ status: 'pending' })
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(w.db.writesTo('businesses')).toEqual([])
  })

  it('un checkout del Plan A (sin preapproval vinculado) no se puede reconciliar: no busca ni adivina', async () => {
    // Las dos sesiones que el Plan A dejó en producción: pending, sin mp_preapproval_id.
    w.db.tables.subscription_checkout_sessions.push({
      id: 'sesion-plan-a', business_id: BIZ_A, user_id: OWNER_A, plan_id: 'basico', billing_cycle: 'monthly', amount: 15000,
      currency: 'ARS', external_reference: 'trpcs_cccccccc-0000-4000-8000-0000000000aa', status: 'pending',
      mp_preapproval_plan_id: 'plan_del_panel', mp_preapproval_id: null, payer_email: 'aaaaaaaa@invalid.test',
      created_at: w.now().toISOString(), updated_at: w.now().toISOString(), confirmed_at: null, mp_preference_id: null,
    })
    // En Mercado Pago existe el preapproval real del smoke: authorized, sin referencia.
    w.mp.seedForeignPreapproval('pre_smoke', { external_reference: '', payer_email: 'aaaaaaaa@invalid.test', preapproval_plan_id: 'plan_del_panel' })
    const antes = w.snapshot(BIZ_A)
    const res = await reconcile()

    expect(res.body).toMatchObject({ activated: false, outcome: 'not_found' })
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(w.mp.calls).toEqual([])                       // no hay nada que releer por id
  })

  it('las condiciones de Mercado Pago no son las de la sesión → no activa y pide soporte', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'full')
    w.pay(preapprovalId)
    Object.assign(w.mp.preapprovals.get(preapprovalId)!.auto_recurring as Record<string, unknown>, { transaction_amount: 15000 })
    const antes = w.snapshot(BIZ_A)
    const res = await reconcile()

    expect(res.body).toMatchObject({ activated: false, outcome: 'mismatch' })
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })

  it('con una suscripción activa, el mismatch de un checkout NUEVO se informa; el de uno ya vencido no tapa el estado', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    w.advance(HOUR)
    const nuevo = await w.openCheckout(OWNER_A, BIZ_A, 'full')
    w.pay(nuevo.preapprovalId)
    Object.assign(w.mp.preapprovals.get(nuevo.preapprovalId)!.auto_recurring as Record<string, unknown>, { transaction_amount: 1 })

    // Checkout abierto: el problema es de ESTA compra y se dice.
    let res = await reconcile()
    expect(res.body).toMatchObject({ activated: true, outcome: 'mismatch', plan: 'basico' })

    // Ya vencido (lo reemplazó otro intento): queda en el log, no en cada verificación.
    nuevo.session.status = 'expired'
    res = await reconcile()
    expect(res.body).toMatchObject({ activated: true, outcome: 'already_active', plan: 'basico' })
    expect(biz()).toMatchObject({ subscription_plan: 'basico', mp_preapproval_id: 'pre_1' })
  })

  it('el preapproval de la sesión devuelve una referencia que no es la suya → no activa', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.pay(preapprovalId, { external_reference: 'otra-cosa' })
    const res = await reconcile()
    expect(res.body).toMatchObject({ activated: false, outcome: 'mismatch' })
    expect(biz().subscription_status).toBe('trialing')
  })

  it('el mismo email de pagador NO alcanza: la suscripción de otro negocio no se toma', async () => {
    // B paga Pro con el mismo email con el que A abrió su checkout.
    await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const b = await w.openCheckout(OWNER_B, BIZ_B, 'pro')
    w.pay(b.preapprovalId, { payer_email: 'aaaaaaaa@invalid.test' })

    const res = await reconcile(OWNER_A, BIZ_A)
    expect(res.body.activated).toBe(false)
    expect(biz(BIZ_A).subscription_status).toBe('trialing')
    expect(biz(BIZ_A).mp_preapproval_id).toBeNull()
    // Y el reconcile de A no activó a B por la puerta de atrás.
    expect(biz(BIZ_B).mp_preapproval_id).toBeNull()
  })

  it('Mercado Pago ya no tiene el preapproval de la sesión → no activa', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mp.preapprovals.delete(preapprovalId)
    const res = await reconcile()
    expect(res.body).toMatchObject({ activated: false, outcome: 'not_found' })
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
    expect(w.mp.preapprovals.get('pre_1')?.status).toBe('authorized')
  })

  it('cambio de plan sin webhook: reconcile confirma el nuevo y recién ahí cancela el anterior', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    w.advance(HOUR)
    await w.openCheckout(OWNER_A, BIZ_A, 'full', 'monthly', 'pre_2')
    w.pay('pre_2')

    const res = await reconcile()
    expect(res.body).toMatchObject({ activated: true, outcome: 'activated', plan: 'full' })
    expect(biz()).toMatchObject({ subscription_plan: 'full', mp_preapproval_id: 'pre_2' })
    expect(w.mp.preapprovals.get('pre_1')?.status).toBe('cancelled')
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

  it('no devuelve el objeto de Mercado Pago, el id del preapproval ni datos del pagador', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    const res = await w.call(OWNER_A, { action: 'status', business_id: BIZ_A })
    expect(res.body.mp_live).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toMatch(/@invalid|pre_1|init_point|trpcs_/)
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
