// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Fase 1 — autorización uniforme de `mp-subscription`.
//
// Las cinco acciones que aceptan `business_id` pasan por la MISMA verificación
// antes de leer o escribir: la capacidad `subscription` del usuario EN ese
// negocio. Un usuario del negocio A que manda el id del negocio B no consulta,
// no obtiene un init_point, no cancela, no reconcilia y no modifica nada de B.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from 'vitest'
import { BILLING_ACTIONS } from '../../../supabase/functions/_shared/billing/subscriptionActions.ts'
import { BIZ_A, BIZ_B, OWNER_A, OWNER_B, TECH_A, World } from './harness.ts'

let w: World

/** El cuerpo mínimo válido de cada acción. */
const body = (action: string, businessId: string) =>
  action === 'create'
    ? { action, business_id: businessId, plan: 'pro', billing_cycle: 'monthly' }
    : { action, business_id: businessId }

beforeEach(async () => {
  w = new World()
  // B es un suscriptor real de Mercado Pago: hay algo que robar o romper.
  await w.subscribe(OWNER_B, BIZ_B, 'pro', 'pre_b')
  w.mp.calls.length = 0
  w.db.writes.length = 0
})

describe('cross-tenant: el usuario de A manda el business_id de B', () => {
  it.each(BILLING_ACTIONS)('%s → 403, sin tocar Mercado Pago ni la base', async (action) => {
    const antes = w.snapshot(BIZ_B)
    const res = await w.call(OWNER_A, body(action, BIZ_B))

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('forbidden')
    // Ni una lectura de MP, ni una escritura: la autorización va primero.
    expect(w.mp.calls).toEqual([])
    expect(w.db.writes).toEqual([])
    expect(w.snapshot(BIZ_B)).toEqual(antes)
  })

  it('el 403 no filtra nada: ni ids, ni estado, ni init_point, ni un objeto debug', async () => {
    for (const action of BILLING_ACTIONS) {
      const res = await w.call(OWNER_A, body(action, BIZ_B))
      expect(Object.keys(res.body).sort()).toEqual(['code', 'error'])
      expect(JSON.stringify(res.body)).not.toMatch(/pre_b|mercadopago|init_point|debug|pro\b/i)
    }
  })

  it('status de otro tenant no devuelve su plan, su email de pagador ni su preapproval', async () => {
    const res = await w.call(OWNER_A, { action: 'status', business_id: BIZ_B })
    expect(res.status).toBe(403)
    expect(res.body.subscription_plan).toBeUndefined()
    expect(res.body.mp_live).toBeUndefined()
  })

  it('update_payment_method de otro tenant no devuelve su init_point', async () => {
    const res = await w.call(OWNER_A, { action: 'update_payment_method', business_id: BIZ_B })
    expect(res.status).toBe(403)
    expect(res.body.init_point).toBeUndefined()
    expect(res.body.preapproval_id).toBeUndefined()
  })

  it('cancel de otro tenant no cancela: Mercado Pago sigue authorized y B sigue activo', async () => {
    const res = await w.call(OWNER_A, { action: 'cancel', business_id: BIZ_B })
    expect(res.status).toBe(403)
    expect(w.mp.preapprovals.get('pre_b')?.status).toBe('authorized')
    expect(w.db.business(BIZ_B).subscription_status).toBe('active')
  })

  it('un preapproval_id mandado por el navegador no se usa: sólo cuenta el del negocio autorizado', async () => {
    // A tiene capacidad sobre A, pero intenta operar el preapproval de B por id.
    const cancel = await w.call(OWNER_A, { action: 'cancel', business_id: BIZ_A, preapproval_id: 'pre_b', mp_preapproval_id: 'pre_b' })
    expect(cancel.status).toBe(409)
    expect(cancel.body.code).toBe('no_subscription')
    const link = await w.call(OWNER_A, { action: 'update_payment_method', business_id: BIZ_A, preapproval_id: 'pre_b' })
    expect(link.status).toBe(409)
    expect(w.mp.callsTo('GET', '/preapproval/pre_b')).toEqual([])
    expect(w.mp.preapprovals.get('pre_b')?.status).toBe('authorized')
  })
})

describe('el propio negocio', () => {
  it.each(BILLING_ACTIONS)('%s propio → pasa la autorización', async (action) => {
    const res = await w.call(OWNER_B, body(action, BIZ_B))
    expect(res.status).not.toBe(403)
    expect(res.status).toBe(200)
  })

  it('create propio → 200 con init_point', async () => {
    const res = await w.call(OWNER_A, body('create', BIZ_A))
    expect(res.status).toBe(200)
    expect(String(res.body.init_point)).toMatch(/^https:\/\/www\.mercadopago\.com\.ar\/subscriptions\/checkout\?/)
  })
})

describe('pertenecer al negocio no alcanza: hace falta la capacidad `subscription`', () => {
  it.each(BILLING_ACTIONS)('un técnico de A no puede %s en A', async (action) => {
    await w.subscribe(OWNER_A, BIZ_A, 'pro', 'pre_a')
    w.mp.calls.length = 0
    const antes = w.snapshot(BIZ_A)

    const res = await w.call(TECH_A, body(action, BIZ_A))
    expect(res.status).toBe(403)
    expect(w.mp.calls).toEqual([])
    expect(w.snapshot(BIZ_A)).toEqual(antes)
  })

  it('un técnico al que el owner le habilitó `subscription` sí puede', async () => {
    w.db.tables.profiles.find((p) => p.user_id === TECH_A)!.permissions = { subscription: true }
    const res = await w.call(TECH_A, body('status', BIZ_A))
    expect(res.status).toBe(200)
  })

  it('un perfil desactivado pierde el acceso aunque fuera owner por rol', async () => {
    const DESACTIVADO = 'dddddddd-0000-4000-8000-00000000000d'
    w.addMember({ userId: DESACTIVADO, businessId: BIZ_A, role: 'owner', active: false })
    const res = await w.call(DESACTIVADO, body('reconcile', BIZ_A))
    expect(res.status).toBe(403)
  })

  it('un usuario sin perfil en ningún negocio no entra a ninguno', async () => {
    const NADIE = 'eeeeeeee-0000-4000-8000-00000000000e'
    for (const biz of [BIZ_A, BIZ_B]) {
      expect((await w.call(NADIE, body('status', biz))).status).toBe(403)
    }
  })
})

describe('fail-closed', () => {
  it.each(BILLING_ACTIONS)('si la autoridad no responde, %s → 503 y no se hace nada', async (action) => {
    w.authorizerDown = true
    const res = await w.call(OWNER_B, body(action, BIZ_B))
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('authorization_unavailable')
    expect(w.mp.calls).toEqual([])
    expect(w.db.writes).toEqual([])
  })

  it('business_id ausente o con forma inválida → 400 antes de consultar nada', async () => {
    for (const bad of [undefined, '', 'no-es-un-uuid', 42, null, `${BIZ_B}' OR '1'='1`]) {
      const res = await w.call(OWNER_A, { action: 'status', business_id: bad })
      expect(res.status).toBe(400)
    }
    expect(w.mp.calls).toEqual([])
  })

  it('acción desconocida → 400', async () => {
    const res = await w.call(OWNER_A, { action: 'activate', business_id: BIZ_A })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('unknown_action')
  })

  it('no existe ninguna acción que active por pedido del navegador', () => {
    expect([...BILLING_ACTIONS].sort()).toEqual(['cancel', 'create', 'reconcile', 'status', 'update_payment_method'])
  })
})
