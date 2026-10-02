// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Plan B — el email del pagador (`payer_email`).
//
// Evidencia real (producción, 2026-10-02, después del merge del Plan B):
//   · `POST /preapproval` con el email del login de TechRepair Pro
//       → 400 {"message":"User bad request","status":400}
//   · el MISMO POST con el email real de una cuenta de Mercado Pago
//       → 201, `pending`, con id, external_reference, init_point y auto_recurring.
//
// Mercado Pago exige un `payer_email` y el del login no siempre es el de una
// cuenta de Mercado Pago. Entonces:
//   1. `create` intenta con el email del JWT. Si sirve, nadie ve un paso extra.
//   2. Si Mercado Pago rechaza ESE intento por el pagador, `create` responde
//      `mp_payer_email_required` y el usuario indica el email de su cuenta.
//   3. El reintento manda `mp_payer_email`.
//
// REGLA: ese email es un parámetro de `POST /preapproval` y nada más. No resuelve
// un negocio, no vincula un preapproval, no activa, no participa en `reconcile` ni
// en el webhook. La identidad sigue siendo el id del preapproval que creó el servidor.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from 'vitest'
import { MpApiError, isPayerRejection } from '../../../supabase/functions/_shared/billing/mpClient.ts'
import { BIZ_A, BIZ_B, HOUR, OWNER_A, OWNER_B, World } from './harness.ts'

const JWT_A = 'aaaaaaaa@invalid.test'          // el email del login de OWNER_A
const CUENTA_MP = 'pagador.real@mp.invalid'    // el email de una cuenta de Mercado Pago

let w: World
beforeEach(() => {
  w = new World()
  // Mercado Pago sólo reconoce esta cuenta: el email del login NO sirve.
  w.mp.payerAccounts = new Set([CUENTA_MP])
})

const create = (extra: Record<string, unknown> = {}, user = OWNER_A, businessId = BIZ_A) =>
  w.call(user, { action: 'create', business_id: businessId, plan: 'pro', billing_cycle: 'monthly', ...extra })

const sessions = () => w.db.tables.subscription_checkout_sessions
const biz = (id = BIZ_A) => w.db.business(id)
const posts = () => w.mp.created().map((c) => c.body as Record<string, unknown>)

describe('primer intento: el email del JWT', () => {
  it('Mercado Pago lo acepta → checkout directo, sin pedir nada más', async () => {
    w.mp.payerAccounts = new Set([JWT_A, CUENTA_MP])
    const res = await create()

    expect(res.status).toBe(200)
    expect(String(res.body.init_point)).toMatch(/preapproval_id=/)
    expect(res.body.code).toBeUndefined()
    expect(posts()).toHaveLength(1)
    expect(posts()[0].payer_email).toBe(JWT_A)
    expect(sessions()[0]).toMatchObject({ status: 'pending', payer_email: JWT_A })
  })

  it('Mercado Pago lo rechaza con 400 «User bad request» → respuesta específica para pedir otro email', async () => {
    const antes = w.snapshot(BIZ_A)
    const res = await create()

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('mp_payer_email_required')
    expect(String(res.body.error)).toMatch(/email asociado a tu cuenta de Mercado Pago/)
    // No hay checkout, no hay preapproval, no hay vínculo y el negocio no cambió.
    expect(res.body.init_point).toBeUndefined()
    expect(w.mp.preapprovals.size).toBe(0)
    expect(sessions()).toHaveLength(1)
    expect(sessions()[0]).toMatchObject({ status: 'failed', mp_preapproval_id: null })
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(w.db.writesTo('businesses')).toEqual([])
  })

  it('el intento con el email del JWT se hace SIEMPRE primero: no se pide un email sin haber probado', async () => {
    await create()
    expect(posts()).toHaveLength(1)
    expect(posts()[0].payer_email).toBe(JWT_A)
  })

  it('un usuario sin email en el JWT recibe el mismo pedido, sin llamar a Mercado Pago', async () => {
    const res = await w.call(OWNER_A, { action: 'create', business_id: BIZ_A, plan: 'pro', billing_cycle: 'monthly' }, { email: null })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('mp_payer_email_required')
    expect(w.mp.calls).toEqual([])
    expect(sessions()).toHaveLength(0)
  })

  it('el rechazo queda en el log sin el email que se intentó', async () => {
    await create()
    const log = w.logs.find((l) => l.event === 'payer_email_rejected')!
    expect(log).toMatchObject({ business_id: BIZ_A, explicit: false, detail: 'User bad request' })
    expect(JSON.stringify(w.logs)).not.toContain(JWT_A)
  })
})

describe('reintento con `mp_payer_email`', () => {
  it('con el email de la cuenta de Mercado Pago → crea el preapproval y devuelve su checkout', async () => {
    expect((await create()).body.code).toBe('mp_payer_email_required')
    const res = await create({ mp_payer_email: CUENTA_MP })

    expect(res.status).toBe(200)
    const id = new URL(String(res.body.init_point)).searchParams.get('preapproval_id')
    expect(w.mp.preapprovals.get(String(id))).toMatchObject({ status: 'pending', payer_email: CUENTA_MP })
    // La sesión del intento fallido quedó `failed`; la nueva, vinculada.
    expect(sessions().map((s) => s.status)).toEqual(['failed', 'pending'])
    expect(w.sessionOf(String(id))).toMatchObject({ business_id: BIZ_A, user_id: OWNER_A, payer_email: CUENTA_MP })
    expect(posts().map((p) => p.payer_email)).toEqual([JWT_A, CUENTA_MP])
  })

  it('el email se normaliza: sin espacios y en minúsculas', async () => {
    const res = await create({ mp_payer_email: '  Pagador.Real@MP.invalid  ' })
    expect(res.status).toBe(200)
    expect(posts()[0].payer_email).toBe(CUENTA_MP)
    expect(sessions()[0].payer_email).toBe(CUENTA_MP)
  })

  it('si Mercado Pago TAMBIÉN rechaza ese email → error distinto y claro, sin crear ni activar nada', async () => {
    const antes = w.snapshot(BIZ_A)
    const res = await create({ mp_payer_email: 'otro@mp.invalid' })

    expect(res.status).toBe(422)
    // No es «pedí un email»: ya lo dio. El frontend no vuelve a abrir el pedido solo.
    expect(res.body.code).toBe('mp_payer_email_rejected')
    expect(res.body.code).not.toBe('mp_payer_email_required')
    expect(res.body.init_point).toBeUndefined()
    expect(w.mp.preapprovals.size).toBe(0)
    expect(sessions()[0]).toMatchObject({ status: 'failed', mp_preapproval_id: null })
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(w.logs.find((l) => l.event === 'payer_email_rejected')).toMatchObject({ explicit: true })
    expect(JSON.stringify(w.logs)).not.toContain('otro@mp.invalid')
  })

  it('pedir dos veces con el mismo email reutiliza el mismo preapproval', async () => {
    const primero = await create({ mp_payer_email: CUENTA_MP })
    w.advance(HOUR)
    const segundo = await create({ mp_payer_email: CUENTA_MP })
    expect(segundo.body.init_point).toBe(primero.body.init_point)
    expect(w.mp.preapprovals.size).toBe(1)
  })

  it('pago con ese checkout → se activa el negocio de la sesión, con su plan', async () => {
    const res = await create({ mp_payer_email: CUENTA_MP })
    const id = String(new URL(String(res.body.init_point)).searchParams.get('preapproval_id'))
    w.pay(id)
    await w.notify('subscription_preapproval', id)
    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'pro', mp_preapproval_id: id })
  })
})

describe('`mp_payer_email` se valida en el servidor, antes de llamar a Mercado Pago', () => {
  it.each([
    ['vacío', ''],
    ['sólo espacios', '   '],
    ['sin arroba', 'pagador.real.mp.invalid'],
    ['sin dominio', 'pagador@'],
    ['sin usuario', '@mp.invalid'],
    ['dominio sin punto', 'pagador@localhost'],
    ['dos arrobas', 'a@b@mp.invalid'],
    ['con espacio', 'paga dor@mp.invalid'],
    ['con salto de línea', 'pagador@mp.invalid\nBcc: x@evil.test'],
    ['con comillas', '"pagador"@mp.invalid'],
    ['con <>', 'Nombre <pagador@mp.invalid>'],
    ['dominio que termina en punto', 'pagador@mp.invalid.'],
    ['más de 254 caracteres', `${'a'.repeat(60)}@${'b'.repeat(200)}.invalid`],
    ['parte local de más de 64 caracteres', `${'a'.repeat(65)}@mp.invalid`],
    ['un número', 42],
    ['un objeto', { email: CUENTA_MP }],
    ['una lista', [CUENTA_MP]],
    ['un booleano', true],
  ])('%s → 400 local, sin sesión y sin llamar a Mercado Pago', async (_caso, valor) => {
    const res = await create({ mp_payer_email: valor })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_payer_email')
    expect(typeof res.body.error).toBe('string')
    expect(w.mp.calls).toEqual([])
    expect(sessions()).toHaveLength(0)
  })

  it('vacío se dice de forma amigable', async () => {
    const res = await create({ mp_payer_email: '' })
    expect(res.body.error).toBe('Ingresá el email de tu cuenta de Mercado Pago.')
  })

  it('un email inválido NO cae al email del JWT: lo que el usuario escribió no se reemplaza en silencio', async () => {
    w.mp.payerAccounts = null
    const res = await create({ mp_payer_email: 'no-es-un-email' })
    expect(res.status).toBe(400)
    expect(posts()).toEqual([])
  })

  it('`null` o ausente = primer intento con el email del JWT', async () => {
    w.mp.payerAccounts = null
    await create({ mp_payer_email: null })
    await create({}, OWNER_B, BIZ_B)
    expect(posts().map((p) => p.payer_email)).toEqual([JWT_A, 'bbbbbbbb@invalid.test'])
  })

  it('el campo viejo `payer_email` del body se sigue ignorando', async () => {
    w.mp.payerAccounts = null
    await create({ payer_email: CUENTA_MP })
    expect(posts()[0].payer_email).toBe(JWT_A)
  })
})

describe('sólo ese rechazo dispara el pedido de email', () => {
  it('otro 400 de Mercado Pago NO se convierte en «probá con otro email»', async () => {
    w.mp.payerAccounts = null
    w.mp.createFailsWith = 400
    const res = await create()

    expect(res.status).toBe(502)
    expect(res.body.code).toBe('mp_unavailable')
    expect(w.logs.find((l) => l.event === 'mp_unavailable')).toMatchObject({ operation: 'POST preapproval', status: 400 })
    expect(w.logs.some((l) => l.event === 'payer_email_rejected')).toBe(false)
  })

  it.each([401, 403, 404, 429, 500, 503])('un %d de Mercado Pago tampoco', async (status) => {
    w.mp.payerAccounts = null
    w.mp.createFailsWith = status
    const res = await create()
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('mp_unavailable')
  })

  it('Mercado Pago caído tampoco, ni en el reintento', async () => {
    w.mp.down = true
    expect((await create()).body.code).toBe('mp_unavailable')
    expect((await create({ mp_payer_email: CUENTA_MP })).body.code).toBe('mp_unavailable')
  })

  it('un 400 que nombra `payer_email` también es un rechazo del pagador', async () => {
    w.mp.payerRejectionBody = { message: 'Invalid value for payer_email', error: 'bad_request', status: 400 }
    expect((await create()).body.code).toBe('mp_payer_email_required')
  })

  const error = (operation: string, status: number, detail: string | null) => new MpApiError(operation, status, detail)

  it.each([
    ['lo medido en producción', error('POST preapproval', 400, 'User bad request'), true],
    ['con el campo `error` delante', error('POST preapproval', 400, 'bad_request: User bad request'), true],
    ['otra caja', error('POST preapproval', 400, 'USER BAD REQUEST'), true],
    ['nombra payer_email', error('POST preapproval', 400, 'Invalid payer_email'), true],
    ['nombra «payer email»', error('POST preapproval', 400, 'payer email is not a valid user'), true],
    ['otro mensaje', error('POST preapproval', 400, 'Invalid value for back_url'), false],
    ['el mensaje como parte de otro', error('POST preapproval', 400, 'User bad request for back_url'), false],
    ['sin detalle', error('POST preapproval', 400, null), false],
    ['otro status', error('POST preapproval', 500, 'User bad request'), false],
    ['otro status (404)', error('POST preapproval', 404, 'User bad request'), false],
    ['otra operación (leer)', error('GET preapproval', 400, 'User bad request'), false],
    ['otra operación (cancelar)', error('PUT preapproval (cancel)', 400, 'User bad request'), false],
    ['no es un error de Mercado Pago', new Error('User bad request'), false],
    ['no es un error', { status: 400, detail: 'User bad request' }, false],
  ])('isPayerRejection — %s → %j', (_caso, err, esperado) => {
    expect(isPayerRejection(err)).toBe(esperado)
  })
})

describe('el email NO es autoridad', () => {
  it('el mismo `mp_payer_email` en dos negocios: cada uno su sesión y su preapproval; pagar uno activa sólo a ese', async () => {
    const a = await create({ mp_payer_email: CUENTA_MP }, OWNER_A, BIZ_A)
    const b = await create({ mp_payer_email: CUENTA_MP }, OWNER_B, BIZ_B)
    const idA = String(new URL(String(a.body.init_point)).searchParams.get('preapproval_id'))
    const idB = String(new URL(String(b.body.init_point)).searchParams.get('preapproval_id'))
    expect(idA).not.toBe(idB)
    expect(w.sessionOf(idA).business_id).toBe(BIZ_A)
    expect(w.sessionOf(idB).business_id).toBe(BIZ_B)

    const antesB = w.snapshot(BIZ_B)
    w.pay(idA)
    await w.notify('subscription_preapproval', idA)

    expect(biz(BIZ_A)).toMatchObject({ subscription_status: 'active', mp_preapproval_id: idA })
    expect(w.snapshot(BIZ_B)).toEqual(antesB)
    expect(w.sessionOf(idB).status).toBe('pending')
  })

  it('usar como `mp_payer_email` el email del dueño de OTRO negocio no da nada de ese negocio', async () => {
    w.mp.payerAccounts = null
    await w.subscribe(OWNER_B, BIZ_B, 'full', 'pre_b')
    const antesB = w.snapshot(BIZ_B)
    const emailDeB = String(w.sessionOf('pre_b').payer_email)

    // A, autorizado sólo sobre A, manda el email de B.
    const res = await create({ mp_payer_email: emailDeB }, OWNER_A, BIZ_A)
    expect(res.status).toBe(200)
    const idA = String(new URL(String(res.body.init_point)).searchParams.get('preapproval_id'))
    expect(idA).not.toBe('pre_b')
    expect(w.sessionOf(idA).business_id).toBe(BIZ_A)

    // …y con ese email sigue sin poder tocar B.
    for (const action of ['status', 'reconcile', 'cancel', 'update_payment_method', 'create']) {
      const cruzado = await w.call(OWNER_A, { action, business_id: BIZ_B, plan: 'pro', billing_cycle: 'monthly', mp_payer_email: emailDeB })
      expect(cruzado.status).toBe(403)
    }
    expect(w.snapshot(BIZ_B)).toEqual(antesB)
    expect(biz(BIZ_A)).toMatchObject({ subscription_status: 'trialing', mp_preapproval_id: null })
  })

  it('un preapproval que el servidor no creó, con el MISMO email de un checkout abierto, no activa', async () => {
    const res = await create({ mp_payer_email: CUENTA_MP })
    const id = String(new URL(String(res.body.init_point)).searchParams.get('preapproval_id'))
    w.mp.seedForeignPreapproval('pre_mismo_email', {
      payer_email: CUENTA_MP, date_created: w.sessionOf(id).created_at,
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 25000, currency_id: 'ARS' },
    })
    const antes = w.snapshot(BIZ_A)
    const out = await w.notify('subscription_preapproval', 'pre_mismo_email')

    expect(out.detail).toBe('not_applied:unknown_preapproval')
    expect(w.snapshot(BIZ_A)).toEqual(antes)
    expect(w.sessionOf(id).status).toBe('pending')
  })

  it('webhook: el email que informa Mercado Pago no decide nada — activa por id aunque sea otro', async () => {
    const res = await create({ mp_payer_email: CUENTA_MP })
    const id = String(new URL(String(res.body.init_point)).searchParams.get('preapproval_id'))
    // Mercado Pago informa otro email (el de la cuenta que terminó pagando).
    w.pay(id, { payer_email: 'cuenta.que.pago@mp.invalid' })
    await w.notify('subscription_preapproval', id)

    expect(biz()).toMatchObject({ subscription_status: 'active', subscription_plan: 'pro', mp_preapproval_id: id })
    // Queda como bitácora de lo que informó Mercado Pago, no como identidad.
    expect(biz().mp_payer_email).toBe('cuenta.que.pago@mp.invalid')
  })

  it('webhook: el email del pagador igual al de la sesión de OTRO negocio no cruza', async () => {
    w.mp.payerAccounts = null
    const a = await w.openCheckout(OWNER_A, BIZ_A, 'pro')
    const b = await w.openCheckout(OWNER_B, BIZ_B, 'pro')
    // El preapproval de A «informa» como pagador el email de la sesión de B.
    w.pay(a.preapprovalId, { payer_email: b.session.payer_email })
    await w.notify('subscription_preapproval', a.preapprovalId)

    expect(biz(BIZ_A).subscription_status).toBe('active')
    expect(biz(BIZ_B)).toMatchObject({ subscription_status: 'trialing', mp_preapproval_id: null })
  })

  it('reconcile no usa el email: ignora el del body y sólo relee por id', async () => {
    const res = await create({ mp_payer_email: CUENTA_MP })
    const id = String(new URL(String(res.body.init_point)).searchParams.get('preapproval_id'))
    // Otro preapproval, del MISMO pagador, que el servidor no creó y que está pago.
    w.mp.seedForeignPreapproval('pre_pago_del_mismo_pagador', { payer_email: CUENTA_MP })
    w.mp.calls.length = 0

    const verificar = await w.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A, mp_payer_email: CUENTA_MP, payer_email: CUENTA_MP })

    expect(verificar.body).toMatchObject({ activated: false, outcome: 'pending' })
    expect(w.mp.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /preapproval/${id}`])
    expect(w.mp.calls.some((c) => /email|search/i.test(c.path))).toBe(false)
    expect(biz().mp_preapproval_id).toBeNull()
  })

  it('reconcile recupera la compra hecha con `mp_payer_email`, sin webhook', async () => {
    const res = await create({ mp_payer_email: CUENTA_MP })
    const id = String(new URL(String(res.body.init_point)).searchParams.get('preapproval_id'))
    w.pay(id)
    const verificar = await w.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(verificar.body).toMatchObject({ activated: true, outcome: 'activated', plan: 'pro' })
  })

  it('status, cancel y update_payment_method ignoran `mp_payer_email`', async () => {
    w.mp.payerAccounts = null
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_a')
    for (const action of ['status', 'update_payment_method', 'cancel']) {
      const res = await w.call(OWNER_A, { action, business_id: BIZ_A, mp_payer_email: 'no-es-un-email' })
      expect(res.status).toBe(200)
    }
  })
})

describe('con `mp_payer_email`, importe, moneda, frecuencia y referencia siguen siendo del servidor', () => {
  it('lo que mande el navegador se ignora', async () => {
    const res = await create({
      mp_payer_email: CUENTA_MP,
      amount: 1, transaction_amount: 1, currency: 'USD', currency_id: 'USD', frequency: 99, frequency_type: 'days',
      auto_recurring: { frequency: 99, frequency_type: 'days', transaction_amount: 1, currency_id: 'USD' },
      external_reference: 'trpcs_99999999-9999-4999-8999-999999999999', preapproval_id: 'pre_del_navegador',
      status: 'authorized', plan_id: 'full',
    })
    expect(res.status).toBe(200)
    const [post] = posts()
    expect(post).toMatchObject({
      status: 'pending', payer_email: CUENTA_MP,
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 25000, currency_id: 'ARS' },
    })
    expect(post.external_reference).toBe(sessions()[0].external_reference)
    expect(post.external_reference).not.toBe('trpcs_99999999-9999-4999-8999-999999999999')
    expect(sessions()[0]).toMatchObject({ plan_id: 'pro', amount: 25000, currency: 'ARS', status: 'pending' })
    expect(sessions()[0].mp_preapproval_id).not.toBe('pre_del_navegador')
  })

  it.each([
    ['basico', 'monthly', 15000, 1],
    ['full', 'annual', 432000, 12],
  ])('%s / %s con otro email cobra lo mismo: %d cada %d months', async (plan, cycle, amount, frequency) => {
    await w.call(OWNER_A, { action: 'create', business_id: BIZ_A, plan, billing_cycle: cycle, mp_payer_email: CUENTA_MP })
    expect(posts()[0].auto_recurring).toEqual({ frequency, frequency_type: 'months', transaction_amount: amount, currency_id: 'ARS' })
  })

  it('el email no cambia a quién se autoriza: un técnico con un email válido sigue sin poder', async () => {
    const res = await w.call('aaaaaaaa-0000-4000-8000-0000000000a2', { action: 'create', business_id: BIZ_A, plan: 'pro', billing_cycle: 'monthly', mp_payer_email: CUENTA_MP })
    expect(res.status).toBe(403)
    expect(w.mp.calls).toEqual([])
  })
})
