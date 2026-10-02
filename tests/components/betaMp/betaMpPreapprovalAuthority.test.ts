// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Fases 4 y 5 — plan pagado = plan otorgado, y el webhook canónico.
//
// El plan que recibe un negocio sale del `preapproval_plan_id` que informa
// Mercado Pago, mapeado contra los secrets `MP_PLAN_*`. Lo que el navegador
// pidió al abrir el checkout es sólo una intención.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from 'vitest'
import { preapprovalState } from '../../../supabase/functions/_shared/billing/mpClient.ts'
import { buildPlanCatalog } from '../../../supabase/functions/_shared/billing/planCatalog.ts'
import { BIZ_A, BIZ_B, DAY, HOUR, OWNER_A, OWNER_B, PLAN_ENV, World } from './harness.ts'

let w: World
beforeEach(() => { w = new World() })

const biz = (id = BIZ_A) => w.db.business(id)
const sessions = () => w.db.tables.subscription_checkout_sessions

describe('catálogo de planes: MP_PLAN_* ↔ plan/ciclo', () => {
  const catalog = buildPlanCatalog((k) => PLAN_ENV[k])

  it.each([
    ['mpplan_basico_m', 'basico', 'monthly'],
    ['mpplan_basico_a', 'basico', 'annual'],
    ['mpplan_pro_m', 'pro', 'monthly'],
    ['mpplan_pro_a', 'pro', 'annual'],
    ['mpplan_full_m', 'full', 'monthly'],
    ['mpplan_full_a', 'full', 'annual'],
  ])('%s → %s / %s', (mpPlanId, plan, cycle) => {
    expect(catalog.byMpPlanId(mpPlanId)).toMatchObject({ plan, billingCycle: cycle })
    expect(catalog.mpPlanIdFor(plan as 'pro', cycle as 'monthly')).toBe(mpPlanId)
  })

  it.each([undefined, null, '', '   ', 'mpplan_desconocido', 42, 'MPPLAN_PRO_M'])('un id desconocido (%j) no resuelve', (id) => {
    expect(catalog.byMpPlanId(id)).toBeNull()
  })

  it('un secret vacío no convierte el id vacío en un plan', () => {
    const c = buildPlanCatalog((k) => (k === 'MP_PLAN_FULL_MONTHLY' ? '' : PLAN_ENV[k]))
    expect(c.byMpPlanId('')).toBeNull()
    expect(c.mpPlanIdFor('full', 'monthly')).toBeNull()
  })

  it('el mismo id en dos secrets queda fuera en las dos direcciones', () => {
    const c = buildPlanCatalog((k) => ({ ...PLAN_ENV, MP_PLAN_FULL_MONTHLY: 'mpplan_basico_m' })[k])
    expect(c.conflicts).toEqual(['mpplan_basico_m'])
    expect(c.byMpPlanId('mpplan_basico_m')).toBeNull()
    expect(c.mpPlanIdFor('basico', 'monthly')).toBeNull()
    expect(c.mpPlanIdFor('full', 'monthly')).toBeNull()
    // El resto sigue resolviendo.
    expect(c.byMpPlanId('mpplan_pro_m')).toMatchObject({ plan: 'pro' })
  })

  it('las dos grafías de «cancelado» que documenta Mercado Pago son el mismo estado', () => {
    expect(preapprovalState('cancelled')).toBe('cancelled')
    expect(preapprovalState('canceled')).toBe('cancelled')
    expect(preapprovalState('AUTHORIZED')).toBe('authorized')
    expect(preapprovalState('active')).toBe('unknown')
    expect(preapprovalState(undefined)).toBe('unknown')
  })
})

describe('plan pagado = plan otorgado', () => {
  it.each([
    ['basico', 'mpplan_basico_m'],
    ['pro', 'mpplan_pro_m'],
    ['full', 'mpplan_full_m'],
  ])('MP confirma el plan %s → el negocio queda en %s', async (plan, mpPlanId) => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, plan)
    w.mpPreapproval('pre_1', { preapproval_plan_id: mpPlanId, external_reference: reference })
    await w.notify('subscription_preapproval', 'pre_1')

    expect(biz()).toMatchObject({
      subscription_status: 'active', subscription_plan: plan, access_source: 'mercado_pago',
      mp_preapproval_id: 'pre_1', mp_preapproval_plan_id: mpPlanId, subscription_provider: 'mercadopago',
    })
  })

  it('el navegador pidió Full, Mercado Pago confirma Básico → Básico, jamás Full', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'full')
    // El usuario cambió el plan en la URL pública del checkout y pagó Básico.
    w.mpPreapproval('pre_1', { preapproval_plan_id: 'mpplan_basico_m', external_reference: reference })
    const out = await w.notify('subscription_preapproval', 'pre_1')

    expect(biz().subscription_plan).toBe('basico')
    expect(biz().subscription_plan).not.toBe('full')
    expect(biz().mp_preapproval_plan_id).toBe('mpplan_basico_m')
    // La diferencia queda auditada.
    expect(out.detail).toBe('applied:plan_differs_from_checkout')
    const audit = w.db.events('billing_state_applied')[0].raw_payload as Record<string, unknown>
    expect(audit).toMatchObject({ plan_mismatch: true, requested: { plan: 'full' }, to: { plan: 'basico' } })
  })

  it('el ciclo también sale de MP: pidió mensual, pagó anual', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro', 'monthly')
    w.mpPreapproval('pre_1', { preapproval_plan_id: 'mpplan_pro_a', external_reference: reference })
    await w.notify('subscription_preapproval', 'pre_1')
    expect(biz()).toMatchObject({ subscription_plan: 'pro', mp_preapproval_plan_id: 'mpplan_pro_a' })
  })

  it('un plan de MP desconocido NO activa, NO concede un plan y queda registrado', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'full')
    w.mpPreapproval('pre_1', { preapproval_plan_id: 'mpplan_de_otra_app', external_reference: reference })
    const antes = w.snapshot(BIZ_A)
    const out = await w.notify('subscription_preapproval', 'pre_1')

    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(out.detail).toBe('not_applied:unknown_plan')
    expect(sessions()[0].status).toBe('pending')
    const evento = w.db.events('subscription_preapproval')[0]
    expect(evento).toMatchObject({ processed: true, error_message: 'not_applied:unknown_plan', business_id: BIZ_A })
  })

  it('un preapproval sin plan (suscripción suelta) no activa', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'full')
    w.mpPreapproval('pre_1', { preapproval_plan_id: null, external_reference: reference })
    const antes = w.snapshot(BIZ_A)
    await w.notify('subscription_preapproval', 'pre_1')
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })

  it('un plan cuyo secret quedó duplicado deja de otorgar', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.env.MP_PLAN_FULL_MONTHLY = 'mpplan_pro_m'   // drift de configuración posterior al checkout
    w.mpPreapproval('pre_1', { preapproval_plan_id: 'mpplan_pro_m', external_reference: reference })
    const antes = w.snapshot(BIZ_A)
    const out = await w.notify('subscription_preapproval', 'pre_1')
    expect(out.detail).toBe('not_applied:unknown_plan')
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })

  it('un cambio de plan hecho por un admin sobre la misma suscripción no se pisa en el próximo evento', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    biz().subscription_plan = 'pro'   // admin_change_subscription_plan
    w.advance(HOUR)
    w.mp.preapprovals.get('pre_1')!.last_modified = w.now().toISOString()
    await w.notify('subscription_preapproval', 'pre_1')
    expect(biz().subscription_plan).toBe('pro')
  })
})

describe('resolución del negocio: sólo por una sesión emitida por el servidor', () => {
  it('authorized válido → active, y la sesión queda paid', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const pre = w.mpPreapproval('pre_1', { external_reference: reference })
    await w.notify('subscription_preapproval', 'pre_1')

    expect(biz()).toMatchObject({
      subscription_status: 'active', subscription_plan: 'pro', access_source: 'mercado_pago', mp_preapproval_id: 'pre_1',
      mp_payer_email: 'pagador@invalid.test', grace_until: null, last_payment_status: null,
    })
    // El período es el que informa Mercado Pago.
    expect(new Date(String(biz().current_period_end)).getTime()).toBe(new Date(String(pre.next_payment_date)).getTime())
    expect(biz().current_period_start).not.toBeNull()
    expect(sessions()[0]).toMatchObject({ status: 'paid', mp_preapproval_id: 'pre_1' })
    expect(sessions()[0].confirmed_at).not.toBeNull()
  })

  it.each([
    ['sin external_reference', null, 'not_applied:no_reference'],
    ['external_reference vacía', '', 'not_applied:no_reference'],
    ['un business_id suelto (referencia vieja / armada a mano)', BIZ_A, 'not_applied:no_reference'],
    ['una referencia con el formato correcto que nadie emitió', 'trpcs_99999999-9999-4999-8999-999999999999', 'not_applied:unknown_reference'],
    ['texto arbitrario', 'YG-1234', 'not_applied:no_reference'],
  ])('%s → no activa', async (_caso, reference, detalle) => {
    await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mpPreapproval('pre_x', { external_reference: reference })
    const antes = w.snapshot(BIZ_A)
    const out = await w.notify('subscription_preapproval', 'pre_x')

    expect(out.detail).toBe(detalle)
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(w.db.writesTo('businesses')).toEqual([])
    expect(w.db.tables.businesses.every((b) => b.mp_preapproval_id === null)).toBe(true)
  })

  it('pagar con el business_id de OTRO negocio como referencia no le reemplaza la suscripción', async () => {
    await w.subscribe(OWNER_B, BIZ_B, 'full', 'pre_b')
    const antes = w.snapshot(BIZ_B)
    // Un tercero arma la URL pública del plan Básico con el id de B y paga.
    w.mpPreapproval('pre_atacante', { preapproval_plan_id: 'mpplan_basico_m', external_reference: BIZ_B })
    await w.notify('subscription_preapproval', 'pre_atacante')

    expect(w.snapshot(BIZ_B)).toEqual(antes)
    expect(biz(BIZ_B)).toMatchObject({ subscription_plan: 'full', mp_preapproval_id: 'pre_b' })
  })

  it('la referencia de A sólo puede activar a A', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    await w.openCheckout(OWNER_B, BIZ_B, 'pro')
    w.mpPreapproval('pre_1', { external_reference: reference })
    await w.notify('subscription_preapproval', 'pre_1')
    expect(biz(BIZ_A).subscription_status).toBe('active')
    expect(biz(BIZ_B).subscription_status).toBe('trialing')
    expect(biz(BIZ_B).mp_preapproval_id).toBeNull()
  })

  it('una sesión activa UNA suscripción: una segunda con la misma referencia no vincula', async () => {
    const reference = await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    w.mpPreapproval('pre_2', { preapproval_plan_id: 'mpplan_full_m', external_reference: reference })
    const out = await w.notify('subscription_preapproval', 'pre_2')

    expect(out.detail).toBe('not_applied:reference_consumed')
    expect(biz()).toMatchObject({ subscription_plan: 'pro', mp_preapproval_id: 'pre_1' })
  })
})

describe('estados del preapproval', () => {
  it('pending NO otorga acceso nuevo y NO degrada el que había', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mpPreapproval('pre_1', { status: 'pending', external_reference: reference })
    const antes = w.snapshot(BIZ_A)
    const out = await w.notify('subscription_preapproval', 'pre_1')

    expect(out.detail).toBe('not_applied:not_authorized')
    expect(w.snapshot(BIZ_A)).toEqual(antes)            // sigue en trial, sin plan
    expect(biz().subscription_status).not.toBe('pending_activation')
    // La sesión anota el preapproval visto, para poder reconciliarlo después.
    expect(sessions()[0]).toMatchObject({ status: 'pending', mp_preapproval_id: 'pre_1' })
  })

  it('pending → authorized: las DOS notificaciones del mismo preapproval se procesan', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mpPreapproval('pre_1', { status: 'pending', external_reference: reference })
    await w.notify('subscription_preapproval', 'pre_1', 5001)   // created
    expect(biz().subscription_status).toBe('trialing')

    w.advance(60_000)
    Object.assign(w.mp.preapprovals.get('pre_1')!, { status: 'authorized', last_modified: w.now().toISOString() })
    const out = await w.notify('subscription_preapproval', 'pre_1', 5002)   // updated — mismo data.id

    // Con el dedupe por recurso esta notificación se descartaba.
    expect(out.result).toBe('processed')
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'pro' })
  })

  it('cancelled sobre un checkout inicial (nunca activó) no cambia el acceso; la sesión queda canceled', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.mpPreapproval('pre_1', { status: 'cancelled', external_reference: reference })
    const antes = w.snapshot(BIZ_A)
    await w.notify('subscription_preapproval', 'pre_1')

    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(sessions()[0].status).toBe('canceled')
  })

  it('cancelled sobre la suscripción vigente → canceled', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    w.advance(HOUR)
    Object.assign(w.mp.preapprovals.get('pre_1')!, { status: 'cancelled', last_modified: w.now().toISOString() })
    await w.notify('subscription_preapproval', 'pre_1')
    expect(biz()).toMatchObject({ subscription_status: 'canceled', subscription_plan: 'pro', mp_preapproval_id: 'pre_1' })
  })

  it('paused → past_due con 3 días de gracia, y un segundo evento NO renueva la gracia', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    w.advance(HOUR)
    Object.assign(w.mp.preapprovals.get('pre_1')!, { status: 'paused', last_modified: w.now().toISOString() })
    await w.notify('subscription_preapproval', 'pre_1')

    expect(biz().subscription_status).toBe('past_due')
    const gracia = String(biz().grace_until)
    expect(new Date(gracia).getTime() - w.now().getTime()).toBe(3 * DAY)

    w.advance(DAY)
    w.mp.preapprovals.get('pre_1')!.last_modified = w.now().toISOString()
    await w.notify('subscription_preapproval', 'pre_1')
    expect(biz().grace_until).toBe(gracia)
  })

  it('un estado que no conocemos no cambia nada', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    w.advance(HOUR)
    Object.assign(w.mp.preapprovals.get('pre_1')!, { status: 'finished', last_modified: w.now().toISOString() })
    const antes = w.snapshot(BIZ_A)
    const out = await w.notify('subscription_preapproval', 'pre_1')
    expect(out.detail).toBe('not_applied:unknown_status')
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })

  it('un acceso otorgado por un admin no se degrada por un paused/cancelled de la suscripción anterior', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    Object.assign(biz(), { access_source: 'admin_override', subscription_plan: 'full' })   // admin_activate_subscription
    w.advance(HOUR)
    Object.assign(w.mp.preapprovals.get('pre_1')!, { status: 'cancelled', last_modified: w.now().toISOString() })
    await w.notify('subscription_preapproval', 'pre_1')
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'full', access_source: 'admin_override' })
  })
})

describe('cambio de plan y reactivación', () => {
  it('cambio de plan: la nueva se activa y la anterior se cancela en MP DESPUÉS de confirmada', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'full')
    // Mientras no paga, sigue con Básico y con su suscripción intacta.
    expect(biz()).toMatchObject({ subscription_plan: 'basico', mp_preapproval_id: 'pre_1' })
    expect(w.mp.preapprovals.get('pre_1')?.status).toBe('authorized')

    w.advance(HOUR)
    w.mpPreapproval('pre_2', { preapproval_plan_id: 'mpplan_full_m', external_reference: reference })
    await w.notify('subscription_preapproval', 'pre_2')

    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'full', mp_preapproval_id: 'pre_2' })
    expect(w.mp.preapprovals.get('pre_1')?.status).toBe('cancelled')
    expect(w.db.events('preapproval_superseded')[0]).toMatchObject({ external_id: 'pre_1', processed: true, business_id: BIZ_A })
  })

  it('la cancelación de la suscripción reemplazada llega después y NO cancela la nueva', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'full')
    w.advance(HOUR)
    w.mpPreapproval('pre_2', { preapproval_plan_id: 'mpplan_full_m', external_reference: reference })
    await w.notify('subscription_preapproval', 'pre_2')

    const out = await w.notify('subscription_preapproval', 'pre_1')   // el webhook de la baja de pre_1
    expect(out.detail).toBe('not_applied:not_authorized')
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'full', mp_preapproval_id: 'pre_2' })
  })

  it('si Mercado Pago no deja cancelar la anterior, la nueva queda activa y hay un evento SIN procesar', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_1')
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'full')
    w.mpPreapproval('pre_2', { preapproval_plan_id: 'mpplan_full_m', external_reference: reference })
    w.mp.cancelFails = true

    await w.notify('subscription_preapproval', 'pre_2')
    expect(biz()).toMatchObject({ subscription_plan: 'full', mp_preapproval_id: 'pre_2' })
    expect(w.mp.preapprovals.get('pre_1')?.status).toBe('authorized')
    expect(w.db.events('preapproval_superseded')[0]).toMatchObject({ processed: false, error_message: 'supersede_cancel_failed' })
  })

  it('reactivar: una cuenta cancelada vuelve a active sólo con una suscripción nueva confirmada', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_1')
    w.advance(HOUR)
    Object.assign(w.mp.preapprovals.get('pre_1')!, { status: 'cancelled', last_modified: w.now().toISOString() })
    await w.notify('subscription_preapproval', 'pre_1')
    expect(biz().subscription_status).toBe('canceled')

    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    expect(biz().subscription_status).toBe('canceled')     // abrir el checkout no reactiva
    w.advance(HOUR)
    w.mpPreapproval('pre_2', { preapproval_plan_id: 'mpplan_basico_m', external_reference: reference })
    await w.notify('subscription_preapproval', 'pre_2')
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'basico', mp_preapproval_id: 'pre_2' })
  })
})
