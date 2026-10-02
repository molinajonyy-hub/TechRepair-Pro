// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Fases 2, 3 y 11 — abrir un checkout NO cambia el acceso canónico.
//
// `create` registra una intención en `subscription_checkout_sessions` (con
// service_role) y devuelve el init_point. No termina un trial, no cambia un plan
// activo, no reactiva una cuenta cancelada, no otorga features y no cancela nada
// en Mercado Pago. El plan pedido queda en la sesión, no en el negocio.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from 'vitest'
import { CYCLE_FREQUENCIES, matchesBillingCycleFrequency } from '../../../supabase/functions/_shared/billing/planCatalog.ts'
import { parseCheckoutReference } from '../../../supabase/functions/_shared/billing/preapproval.ts'
import { BIZ_A, BIZ_B, DAY, HOUR, ORIGIN, OWNER_A, OWNER_B, World } from './harness.ts'

let w: World
beforeEach(() => { w = new World() })

const create = (plan = 'pro', billingCycle = 'monthly', extra: Record<string, unknown> = {}) =>
  w.call(OWNER_A, { action: 'create', business_id: BIZ_A, plan, billing_cycle: billingCycle, ...extra })

const sessions = () => w.db.tables.subscription_checkout_sessions

describe('el negocio conserva su estado mientras no paga', () => {
  it('iniciar un checkout durante el trial NO modifica el trial', async () => {
    const antes = w.snapshot(BIZ_A)
    const res = await create('pro')

    expect(res.status).toBe(200)
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(w.db.business(BIZ_A).subscription_status).toBe('trialing')
    expect(w.db.business(BIZ_A).trial_ends_at).toBe('2026-10-07T12:00:00.000Z')
    // Ni una sola escritura sobre `businesses`.
    expect(w.db.writesTo('businesses')).toEqual([])
  })

  it('nunca escribe pending_activation', async () => {
    await create('pro')
    await create('full')
    expect(w.db.tables.businesses.map((b) => b.subscription_status)).not.toContain('pending_activation')
  })

  it('iniciar un checkout con una suscripción activa NO cambia plan ni estado, ni cancela la vigente', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'pre_a')
    const antes = w.snapshot(BIZ_A)
    w.mp.calls.length = 0

    const res = await create('full')

    expect(res.status).toBe(200)
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(w.db.business(BIZ_A)).toMatchObject({ subscription_status: 'active', subscription_plan: 'basico', mp_preapproval_id: 'pre_a' })
    // Antes de BETA-MP `create` cancelaba el preapproval vigente ANTES del pago.
    expect(w.mp.callsTo('PUT', '/preapproval/')).toEqual([])
    expect(w.mp.preapprovals.get('pre_a')?.status).toBe('authorized')
  })

  it('abandonar el checkout NO pierde acceso: pasan los días y el trial sigue igual', async () => {
    const antes = w.snapshot(BIZ_A)
    await create('pro')
    w.advance(3 * DAY)
    // El usuario vuelve a la app y «verifica»: Mercado Pago no tiene nada.
    const verificar = await w.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })

    expect(verificar.body.activated).toBe(false)
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })

  it('un trial vencido (suspended) que abre el checkout NO sale del muro', async () => {
    Object.assign(w.db.business(BIZ_A), { subscription_status: 'suspended', trial_ends_at: '2026-09-20T12:00:00.000Z' })
    await create('basico')
    expect(w.db.business(BIZ_A).subscription_status).toBe('suspended')
  })

  it('una cuenta cancelada que abre el checkout NO queda activa', async () => {
    Object.assign(w.db.business(BIZ_A), { subscription_status: 'canceled', subscription_plan: 'pro' })
    await create('pro')
    expect(w.db.business(BIZ_A)).toMatchObject({ subscription_status: 'canceled', subscription_plan: 'pro' })
  })

  it('pedir Full NO concede Full', async () => {
    const res = await create('full')
    expect(res.status).toBe(200)
    expect(w.db.business(BIZ_A).subscription_plan).toBeNull()
    expect(w.db.business(BIZ_A).access_source).toBe('trial')
    // Full queda sólo como intención.
    expect(sessions()).toHaveLength(1)
    expect(sessions()[0]).toMatchObject({ plan_id: 'full', status: 'pending' })
  })

  it('un acceso otorgado a mano no se toca por abrir un checkout', async () => {
    Object.assign(w.db.business(BIZ_A), { subscription_status: 'active', subscription_plan: 'pro', access_source: 'admin_override' })
    const antes = w.snapshot(BIZ_A)
    await create('basico')
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })
})

describe('la intención de compra vive en la sesión, escrita por el servidor', () => {
  it('registra negocio, usuario, plan, ciclo, plan de MP esperado, pagador, importe y referencia', async () => {
    const res = await create('pro', 'annual')
    expect(res.status).toBe(200)
    expect(sessions()).toHaveLength(1)
    expect(sessions()[0]).toMatchObject({
      business_id: BIZ_A,
      user_id: OWNER_A,
      plan_id: 'pro',
      billing_cycle: 'annual',
      mp_preapproval_plan_id: 'mpplan_pro_a',   // resuelto por secret, no por el navegador
      payer_email: 'aaaaaaaa@invalid.test',     // el del JWT
      amount: 240000,                           // el que informa Mercado Pago para ese plan
      currency: 'ARS',
      status: 'pending',
      mp_preapproval_id: null,
    })
    expect(parseCheckoutReference(sessions()[0].external_reference)).not.toBeNull()
  })

  it('el email del pagador sale del JWT: el `payer_email` del body se ignora', async () => {
    const res = await create('pro', 'monthly', { payer_email: 'atacante@evil.test' })
    expect(sessions()[0].payer_email).toBe('aaaaaaaa@invalid.test')
    expect(String(res.body.init_point)).not.toContain('atacante')
    expect(new URL(String(res.body.init_point)).searchParams.get('payer_email')).toBe('aaaaaaaa@invalid.test')
  })

  it('el plan de MP sale de los secrets: un id de plan mandado por el navegador se ignora', async () => {
    const res = await create('basico', 'monthly', { preapproval_plan_id: 'mpplan_full_m', mp_plan_id: 'mpplan_full_m', plan_id: 'full' })
    const url = new URL(String(res.body.init_point))
    expect(url.searchParams.get('preapproval_plan_id')).toBe('mpplan_basico_m')
    expect(sessions()[0]).toMatchObject({ plan_id: 'basico', mp_preapproval_plan_id: 'mpplan_basico_m' })
  })

  it('la respuesta no devuelve un preapproval (todavía no existe) ni toca el estado', async () => {
    const res = await create('pro')
    expect(res.body.preapproval_id).toBeNull()
    expect(res.body.checkout).toEqual({ status: 'pending', plan: 'pro', billing_cycle: 'monthly' })
  })

  it('con la base SIN la migración, `create` falla cerrado: 503 y ningún init_point', async () => {
    w.db.preMigration = true
    const res = await create('pro')
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('billing_unavailable')
    expect(res.body.init_point).toBeUndefined()
    expect(sessions()).toHaveLength(0)
    expect(w.db.writesTo('businesses')).toEqual([])
  })
})

describe('external_reference: una referencia inequívoca por checkout', () => {
  it('la referencia viaja en la URL y resuelve checkout → negocio → plan/ciclo esperado', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro', 'annual')
    const session = sessions().find((s) => s.external_reference === reference)!
    expect(session).toMatchObject({ business_id: BIZ_A, plan_id: 'pro', billing_cycle: 'annual', mp_preapproval_plan_id: 'mpplan_pro_a' })
  })

  it('no es el business_id ni lo contiene', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    expect(reference).toMatch(/^trpcs_[0-9a-f-]{36}$/)
    expect(reference).not.toContain(BIZ_A)
  })

  it('cada negocio y cada plan tienen su propia referencia', async () => {
    const a = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const b = await w.openCheckout(OWNER_B, BIZ_B, 'pro')
    const a2 = await w.openCheckout(OWNER_A, BIZ_A, 'full')
    expect(new Set([a.reference, b.reference, a2.reference]).size).toBe(3)
  })

  it('pedir dos veces el mismo plan/ciclo reutiliza la misma intención', async () => {
    const primero = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.advance(2 * HOUR)
    const segundo = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    expect(segundo.reference).toBe(primero.reference)
    expect(sessions()).toHaveLength(1)
  })

  it('una sesión vencida no se reutiliza: se marca expired y se emite otra', async () => {
    const primero = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    w.advance(3 * DAY)
    const segundo = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    expect(segundo.reference).not.toBe(primero.reference)
    expect(sessions().map((s) => s.status).sort()).toEqual(['expired', 'pending'])
  })

  it.each([
    [undefined, null],
    ['', null],
    [BIZ_A, null],                                  // un business_id suelto ya no es una referencia
    [`${BIZ_A}_pro_1759320000000`, null],           // el formato que armaba el navegador
    ['trpcs_no-es-un-uuid', null],
    [12345, null],
    ['trpcs_cccccccc-0000-4000-8000-000000000001', 'trpcs_cccccccc-0000-4000-8000-000000000001'],
  ])('parseCheckoutReference(%j) → %j', (raw, esperado) => {
    expect(parseCheckoutReference(raw)).toBe(esperado)
  })
})

describe('la URL de retorno la decide el servidor', () => {
  it('acepta /subscription/pending de un origen permitido', async () => {
    const res = await create('pro', 'monthly', { back_url: `${ORIGIN}/subscription/pending` })
    expect(new URL(String(res.body.init_point)).searchParams.get('back_url')).toBe(`${ORIGIN}/subscription/pending`)
  })

  it.each([
    'https://evil.example/subscription/pending',
    `${ORIGIN}/subscription/success`,
    `${ORIGIN}/subscription/pending?success=true`,
    'javascript:alert(1)',
    42,
  ])('ignora un back_url ajeno o manipulado (%j)', async (backUrl) => {
    const res = await create('pro', 'monthly', { back_url: backUrl })
    expect(new URL(String(res.body.init_point)).searchParams.get('back_url')).toBe(`${ORIGIN}/subscription/pending`)
  })
})

describe('plan y ciclo: validados por el servidor, fail-closed', () => {
  it.each([
    ['enterprise', 'monthly'],
    ['pro', 'weekly'],
    [undefined, 'monthly'],
    ['pro', undefined],
    [{ plan: 'full' }, 'monthly'],
  ])('plan=%j ciclo=%j → 400, sin sesión', async (plan, cycle) => {
    const res = await w.call(OWNER_A, { action: 'create', business_id: BIZ_A, plan, billing_cycle: cycle })
    expect(res.status).toBe(400)
    expect(sessions()).toHaveLength(0)
  })

  it('un ciclo sin plan de MP configurado → 503, sin sesión y sin nombrar el secret', async () => {
    const res = await create('pro', 'quarterly')
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('plan_not_configured')
    expect(JSON.stringify(res.body)).not.toMatch(/MP_PLAN/)
    expect(sessions()).toHaveLength(0)
  })

  it('el plan no existe en Mercado Pago → 503, sin sesión', async () => {
    w.mp.plans.delete('mpplan_pro_m')
    const res = await create('pro')
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('plan_unavailable')
    expect(sessions()).toHaveLength(0)
  })

  it('el plan está dado de baja en Mercado Pago → 503', async () => {
    w.mp.plans.get('mpplan_pro_m')!.status = 'cancelled'
    expect((await create('pro')).status).toBe(503)
  })

  it('un secret mal cableado (mensual apuntando a un plan anual, `1 years`) → 503', async () => {
    w.env.MP_PLAN_PRO_MONTHLY = 'mpplan_basico_a'
    w.env.MP_PLAN_BASICO_ANNUAL = ''
    const res = await create('pro', 'monthly')
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('plan_unavailable')
    expect(w.logs.at(-1)).toMatchObject({ event: 'plan_unavailable', problem: 'frequency_mismatch' })
  })

  it('el mismo id de plan bajo dos secrets no se vende: no se sabría qué se pagó', async () => {
    w.env.MP_PLAN_FULL_MONTHLY = 'mpplan_pro_m'
    expect((await create('pro')).status).toBe(503)
    expect((await create('full')).status).toBe(503)
    expect(sessions()).toHaveLength(0)
  })

  it('Mercado Pago caído → 502, sin sesión y sin cambios', async () => {
    w.mp.down = true
    const antes = w.snapshot(BIZ_A)
    const res = await create('pro')
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('mp_unavailable')
    expect(sessions()).toHaveLength(0)
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })

  it('un usuario sin email no abre un checkout', async () => {
    const res = await w.call(OWNER_A, { action: 'create', business_id: BIZ_A, plan: 'pro', billing_cycle: 'monthly' }, { email: null })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('no_email')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Frecuencia del plan. Evidencia real del preflight del 2026-10-01/02
// (`GET /preapproval_plan/search`): los planes anuales creados desde el panel de
// Mercado Pago vuelven como `1` / `"years"`, no `12` / `"months"`. Antes de este
// ajuste ese anual real daba `frequency_mismatch` y `create` respondía 503.
// ─────────────────────────────────────────────────────────────────────────────
describe('frecuencia del plan: equivalencias de Mercado Pago, lista cerrada', () => {
  it.each([
    // ciclo, frequency, frequency_type, ¿coincide?
    ['monthly', 1, 'months', true],
    ['annual', 12, 'months', true],
    ['annual', 1, 'years', true],          // lo que devuelve MP para un anual del panel
    ['quarterly', 3, 'months', true],
    ['annual', 2, 'years', false],
    ['monthly', 1, 'years', false],
    // La cantidad puede llegar como texto numérico; la unidad, con otra caja.
    ['annual', '1', 'years', true],
    ['annual', ' 12 ', 'months', true],
    ['annual', 1, 'YEARS', true],
    // Otro ciclo con una frecuencia válida para OTRO ciclo.
    ['monthly', 12, 'months', false],
    ['monthly', 3, 'months', false],
    ['annual', 1, 'months', false],
    ['annual', 3, 'months', false],
    ['annual', 24, 'months', false],
    ['quarterly', 1, 'months', false],
    ['quarterly', 12, 'months', false],
    ['quarterly', 1, 'years', false],      // trimestral no se amplía
    // Unidades desconocidas: no hay conversión, aunque «den» el mismo período.
    ['annual', 365, 'days', false],
    ['annual', 52, 'weeks', false],
    ['monthly', 30, 'days', false],
    ['monthly', 4, 'weeks', false],
    ['annual', 1, 'year', false],
    ['annual', 1, 'anual', false],
    ['annual', 1, '', false],
    ['annual', 1, null, false],
    ['annual', 1, undefined, false],
    ['annual', 1, 12, false],
    // Cantidades que no son un entero positivo.
    ['annual', null, 'years', false],
    ['annual', undefined, 'years', false],
    ['annual', '', 'years', false],
    ['annual', 0, 'years', false],
    ['annual', -1, 'years', false],
    ['annual', 1.5, 'years', false],
    ['annual', '1.0', 'years', false],
    ['annual', '1e0', 'years', false],
    ['annual', true, 'years', false],
    ['annual', [1], 'years', false],
    ['annual', Number.NaN, 'years', false],
    ['annual', Number.POSITIVE_INFINITY, 'years', false],
    // Un ciclo que no existe nunca coincide.
    ['weekly', 1, 'weeks', false],
  ])('%s + %j / %j → %j', (cycle, frequency, frequencyType, esperado) => {
    expect(matchesBillingCycleFrequency(cycle as 'annual', frequency, frequencyType)).toBe(esperado)
  })

  it('la tabla de equivalencias es la que se documenta, ni más ni menos', () => {
    expect(CYCLE_FREQUENCIES).toEqual({
      monthly: [{ frequency: 1, frequencyType: 'months' }],
      quarterly: [{ frequency: 3, frequencyType: 'months' }],
      annual: [{ frequency: 12, frequencyType: 'months' }, { frequency: 1, frequencyType: 'years' }],
    })
  })

  /** Reemplaza la frecuencia que «informa Mercado Pago» para un plan. */
  const planCon = (mpPlanId: string, frequency: unknown, frequencyType: unknown) => {
    Object.assign(w.mp.plans.get(mpPlanId)!.auto_recurring as Record<string, unknown>, { frequency, frequency_type: frequencyType })
  }

  it('anual real del panel (1 / years) → 200, con la sesión anual y el importe de MP', async () => {
    expect(w.mp.plans.get('mpplan_full_a')!.auto_recurring).toMatchObject({ frequency: 1, frequency_type: 'years' })
    const res = await create('full', 'annual')
    expect(res.status).toBe(200)
    expect(sessions()[0]).toMatchObject({ plan_id: 'full', billing_cycle: 'annual', mp_preapproval_plan_id: 'mpplan_full_a', amount: 432000 })
  })

  it('anual expresado como 12 / months → 200', async () => {
    planCon('mpplan_pro_a', 12, 'months')
    const res = await create('pro', 'annual')
    expect(res.status).toBe(200)
    expect(sessions()[0]).toMatchObject({ billing_cycle: 'annual', amount: 240000 })
  })

  it('mensual 1 / months → 200', async () => {
    expect(w.mp.plans.get('mpplan_pro_m')!.auto_recurring).toMatchObject({ frequency: 1, frequency_type: 'months' })
    expect((await create('pro', 'monthly')).status).toBe(200)
  })

  it('trimestral configurado con 3 / months → 200', async () => {
    w.env.MP_PLAN_PRO_QUARTERLY = 'mpplan_pro_q'
    w.mp.seedPlans([['mpplan_pro_q', 64500, 3, 'months']])
    const res = await create('pro', 'quarterly')
    expect(res.status).toBe(200)
    expect(sessions()[0]).toMatchObject({ billing_cycle: 'quarterly', mp_preapproval_plan_id: 'mpplan_pro_q' })
  })

  it.each([
    ['anual que MP informa como 2 / years', 'pro', 'annual', 'mpplan_pro_a', 2, 'years'],
    ['mensual que MP informa como 1 / years', 'pro', 'monthly', 'mpplan_pro_m', 1, 'years'],
    ['anual en una unidad desconocida (365 / days)', 'pro', 'annual', 'mpplan_pro_a', 365, 'days'],
    ['mensual en una unidad desconocida (4 / weeks)', 'pro', 'monthly', 'mpplan_pro_m', 4, 'weeks'],
    ['anual sin unidad', 'pro', 'annual', 'mpplan_pro_a', 1, null],
    ['anual sin cantidad', 'pro', 'annual', 'mpplan_pro_a', null, 'years'],
    ['anual que MP informa como 1 / months', 'pro', 'annual', 'mpplan_pro_a', 1, 'months'],
  ])('%s → 503, sin sesión y sin tocar el negocio', async (_caso, plan, cycle, mpPlanId, frequency, frequencyType) => {
    planCon(mpPlanId, frequency, frequencyType)
    const antes = w.snapshot(BIZ_A)
    const res = await create(plan, cycle)

    expect(res.status).toBe(503)
    expect(res.body.code).toBe('plan_unavailable')
    expect(res.body.init_point).toBeUndefined()
    expect(sessions()).toHaveLength(0)
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(w.logs.at(-1)).toMatchObject({ event: 'plan_unavailable', problem: 'frequency_mismatch' })
  })

  it('aceptar 1 / years no relaja el resto: un anual dado de baja o inexistente sigue en 503', async () => {
    w.mp.plans.get('mpplan_full_a')!.status = 'cancelled'
    expect((await create('full', 'annual')).status).toBe(503)
    w.mp.plans.delete('mpplan_pro_a')
    expect((await create('pro', 'annual')).status).toBe(503)
    expect(sessions()).toHaveLength(0)
  })

  it('el plan otorgado sigue saliendo del id de plan de MP: un anual 1 / years activa su plan y no otro', async () => {
    const { reference } = await w.openCheckout(OWNER_A, BIZ_A, 'basico', 'annual')
    w.mpPreapproval('pre_anual', { preapproval_plan_id: 'mpplan_basico_a', external_reference: reference, auto_recurring: { frequency: 1, frequency_type: 'years' } })
    await w.notify('subscription_preapproval', 'pre_anual')
    expect(w.db.business(BIZ_A)).toMatchObject({ subscription_status: 'active', subscription_plan: 'basico', mp_preapproval_plan_id: 'mpplan_basico_a' })
  })
})
