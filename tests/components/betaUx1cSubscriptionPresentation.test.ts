// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1C · A — matriz PURA de presentación de «Mi Suscripción».
//
// `resolveSubscriptionPresentation` decide qué estado se muestra y qué acciones
// se ofrecen. Acá se recorre la matriz entera, estado por estado, sin React ni
// Supabase: si una acción aparece donde no debe, falla acá antes que en pantalla.
//
// Lo que NO es: no decide acceso (`lib/entitlements`) ni el muro
// (`lib/subscriptionWall`). El último bloque comprueba que no los contradice.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  MERCADO_PAGO_ACTIONS,
  PLAN_ACTIONS,
  hasMercadoPagoSubscription,
  isManualAccess,
  offersAction,
  offersPlans,
  presentationActions,
  resolveSubscriptionPresentation,
  shouldLookUpPendingCheckout,
  type SubscriptionActionId,
  type SubscriptionPresentationInput,
} from '../../src/lib/subscriptionPresentation'
import { classifySubscriptionWall } from '../../src/lib/subscriptionWall'
import { resolveEntitlement } from '../../src/lib/entitlements'
import type { AccessSource, SubscriptionStatus } from '../../src/types/subscriptionAccess'

const AHORA = new Date('2026-10-08T15:00:00.000Z')
const DIA = 24 * 60 * 60 * 1000
const enDias = (n: number) => new Date(AHORA.getTime() + n * DIA).toISOString()

const resolver = (input: SubscriptionPresentationInput) => resolveSubscriptionPresentation(input, AHORA)

const TODAS: SubscriptionActionId[] = [
  'choose_plan', 'reactivate', 'continue_checkout', 'verify_payment',
  'change_plan', 'update_payment_method', 'cancel_subscription', 'help',
]

/** `{ accion: true|false }` para las ocho acciones: la fila de la matriz. */
function fila(input: SubscriptionPresentationInput): Record<SubscriptionActionId, boolean> {
  const p = resolver(input)
  return Object.fromEntries(TODAS.map(a => [a, offersAction(p, a)])) as Record<SubscriptionActionId, boolean>
}

const NADA: Record<SubscriptionActionId, boolean> = {
  choose_plan: false, reactivate: false, continue_checkout: false, verify_payment: false,
  change_plan: false, update_payment_method: false, cancel_subscription: false, help: false,
}

// ── Fixtures: un negocio por estado ─────────────────────────────────────────
const trial: SubscriptionPresentationInput = {
  status: 'trialing', accessSource: 'trial', trialEndsAt: enDias(9), checkout: null,
}
const trialConPagoIniciado: SubscriptionPresentationInput = { ...trial, checkout: { status: 'pending' } }
const activaMp: SubscriptionPresentationInput = {
  status: 'active', accessSource: 'mercado_pago', mpPreapprovalId: 'pre_1',
  lastPaymentStatus: 'approved', currentPeriodEnd: enDias(20),
}
const pagoVencido: SubscriptionPresentationInput = {
  status: 'past_due', accessSource: 'mercado_pago', mpPreapprovalId: 'pre_1', lastPaymentStatus: 'rejected',
}
const manual = (source: AccessSource, extra: Partial<SubscriptionPresentationInput> = {}): SubscriptionPresentationInput => ({
  status: 'active', accessSource: source, currentPeriodEnd: enDias(31), ...extra,
})

// ═══════════════════════════════════════════════════════════════════════════
describe('1 · trial vigente, sin checkout pendiente', () => {
  it('estado `trial`: la única acción es «Elegir plan», y es la primaria', () => {
    const p = resolver(trial)
    expect(p.state).toBe('trial')
    expect(p.primary).toBe('choose_plan')
    expect(fila(trial)).toEqual({ ...NADA, choose_plan: true })
  })

  it('no ofrece Verificar pago, Actualizar método ni Cancelar', () => {
    const f = fila(trial)
    expect(f.verify_payment).toBe(false)
    expect(f.update_payment_method).toBe(false)
    expect(f.cancel_subscription).toBe(false)
  })

  it('ninguna de sus acciones termina en la Edge Function de Mercado Pago', () => {
    expect(presentationActions(resolver(trial)).filter(a => MERCADO_PAGO_ACTIONS.includes(a))).toEqual([])
  })

  it('no anuncia un próximo cobro, y el precio es «al terminar la prueba»', () => {
    const p = resolver({ ...trial, currentPeriodEnd: enDias(20) })
    expect(p.showNextCharge).toBe(false)
    expect(p.price).toBe('after_trial')
    expect(p.showBillingDetails).toBe(false)
  })

  it.each([
    ['sin consultar', undefined],
    ['sin checkout', null],
    ['checkout pagado', { status: 'paid' }],
    ['checkout vencido', { status: 'expired' }],
    ['checkout cancelado', { status: 'canceled' }],
    ['checkout fallido', { status: 'failed' }],
    ['estado desconocido', { status: 'lo-que-sea' }],
  ])('%s → sigue siendo `trial`: sólo `pending` abre el otro estado', (_caso, checkout) => {
    expect(resolver({ ...trial, checkout }).state).toBe('trial')
  })

  it('un preapproval viejo en la fila NO convierte un trial en una suscripción paga', () => {
    // P. ej. un admin extendió la prueba después de una baja: queda el id anterior.
    const conVinculoViejo = { ...trial, mpPreapprovalId: 'pre_viejo', lastPaymentStatus: 'approved' }
    expect(resolver(conVinculoViejo).state).toBe('trial')
    expect(fila(conVinculoViejo)).toEqual({ ...NADA, choose_plan: true })
  })

  it('sin `access_source` ni fecha (datos todavía sin cargar) también es `trial`', () => {
    expect(resolver({ status: 'trialing' }).state).toBe('trial')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('2 · trial + checkout pendiente', () => {
  it('estado `trial_pending_checkout`: Continuar pago (primaria) y Verificar pago', () => {
    const p = resolver(trialConPagoIniciado)
    expect(p.state).toBe('trial_pending_checkout')
    expect(p.primary).toBe('continue_checkout')
    expect(p.secondary).toEqual(['verify_payment'])
    expect(fila(trialConPagoIniciado)).toEqual({ ...NADA, continue_checkout: true, verify_payment: true })
  })

  it('no ofrece Actualizar método ni Cancelar: todavía no hay suscripción', () => {
    const f = fila(trialConPagoIniciado)
    expect(f.update_payment_method).toBe(false)
    expect(f.cancel_subscription).toBe(false)
  })

  it('sigue sin cobro: precio «al terminar la prueba», sin próximo cobro', () => {
    const p = resolver(trialConPagoIniciado)
    expect(p.price).toBe('after_trial')
    expect(p.showNextCharge).toBe(false)
  })

  it('es un estado DERIVADO: el negocio sigue `trialing` y no hay muro', () => {
    expect(resolver(trialConPagoIniciado).wall).toBe('none')
    expect(classifySubscriptionWall({ subscription_status: 'trialing' }, AHORA)).toBe('none')
  })

  it('un checkout pendiente no cambia la presentación de ningún otro estado', () => {
    const pendiente = { checkout: { status: 'pending' } }
    expect(resolver({ ...activaMp, ...pendiente }).state).toBe('mp_active')
    expect(resolver({ ...pagoVencido, ...pendiente }).state).toBe('past_due')
    expect(resolver({ ...manual('admin_override'), ...pendiente }).state).toBe('manual_access')
    expect(resolver({ status: 'suspended', ...pendiente }).state).toBe('blocked')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('3 · activa por Mercado Pago', () => {
  it('estado `mp_active`: Cambiar plan, Actualizar método, Verificar y Cancelar', () => {
    const p = resolver(activaMp)
    expect(p.state).toBe('mp_active')
    expect(fila(activaMp)).toEqual({
      ...NADA, change_plan: true, update_payment_method: true, verify_payment: true, cancel_subscription: true,
    })
  })

  it('no hay nada que resolver: ninguna acción es primaria, y Verificar no compite', () => {
    const p = resolver(activaMp)
    expect(p.primary).toBeNull()
    expect(p.secondary).toEqual(['change_plan'])
    expect(p.manage).toEqual(['update_payment_method', 'verify_payment'])
    expect(p.destructive).toEqual(['cancel_subscription'])
  })

  it('anuncia el próximo cobro sólo si hay fecha', () => {
    expect(resolver(activaMp).showNextCharge).toBe(true)
    expect(resolver({ ...activaMp, currentPeriodEnd: null }).showNextCharge).toBe(false)
    expect(resolver({ ...activaMp, currentPeriodEnd: '' }).showNextCharge).toBe(false)
  })

  it('muestra el precio y los datos de facturación', () => {
    const p = resolver(activaMp)
    expect(p.price).toBe('current')
    expect(p.showBillingDetails).toBe(true)
  })

  it('`active` sola no alcanza: sin suscripción vinculada no hay acciones de Mercado Pago', () => {
    const sinVinculo: SubscriptionPresentationInput = { status: 'active', accessSource: null, currentPeriodEnd: enDias(20) }
    const p = resolver(sinVinculo)
    expect(p.state).toBe('active_unlinked')
    expect(fila(sinVinculo)).toEqual({ ...NADA, change_plan: true })
    expect(p.showNextCharge).toBe(false)
    expect(p.price).toBe('hidden')
  })

  it.each([['vacío', ''], ['espacios', '   '], ['null', null], ['undefined', undefined]])(
    'un `mp_preapproval_id` %s no es una suscripción vinculada',
    (_caso, id) => {
      expect(hasMercadoPagoSubscription(id)).toBe(false)
      expect(resolver({ status: 'active', mpPreapprovalId: id }).state).toBe('active_unlinked')
    },
  )
})

// ═══════════════════════════════════════════════════════════════════════════
describe('4 · pago vencido', () => {
  it('estado `past_due`: la primaria es Actualizar método de pago', () => {
    const p = resolver(pagoVencido)
    expect(p.state).toBe('past_due')
    expect(p.primary).toBe('update_payment_method')
  })

  it('Verificar pago es secundaria; Cambiar plan existe pero nunca es la primaria', () => {
    const p = resolver(pagoVencido)
    expect(p.secondary).toEqual(['verify_payment', 'change_plan'])
    expect(p.primary).not.toBe('change_plan')
    expect(fila(pagoVencido)).toEqual({
      ...NADA, update_payment_method: true, verify_payment: true, change_plan: true, cancel_subscription: true,
    })
  })

  it('no anuncia un «próximo cobro»: hay uno pendiente', () => {
    expect(resolver({ ...pagoVencido, currentPeriodEnd: enDias(3) }).showNextCharge).toBe(false)
  })

  it('sin suscripción vinculada no ofrece lo que el servidor rechazaría (`no_subscription`)', () => {
    const sinVinculo: SubscriptionPresentationInput = { status: 'past_due', accessSource: null }
    expect(resolver(sinVinculo).state).toBe('past_due')
    expect(fila(sinVinculo)).toEqual({ ...NADA, choose_plan: true })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe.each(['admin_override', 'manual_grandfathered'] as const)('5 · acceso manual (%s)', (source) => {
  it('estado `manual_access`: la única acción es Ayuda', () => {
    const p = resolver(manual(source))
    expect(p.state).toBe('manual_access')
    expect(fila(manual(source))).toEqual({ ...NADA, help: true })
  })

  it('ninguna acción de Mercado Pago y ningún CTA a Planes', () => {
    const acciones = presentationActions(resolver(manual(source)))
    expect(acciones.filter(a => MERCADO_PAGO_ACTIONS.includes(a))).toEqual([])
    expect(acciones.filter(a => PLAN_ACTIONS.includes(a))).toEqual([])
    expect(offersPlans(resolver(manual(source)))).toBe(false)
  })

  it('ningún próximo cobro y ningún precio, aunque tenga `current_period_end`', () => {
    const p = resolver(manual(source))
    expect(p.showNextCharge).toBe(false)
    expect(p.price).toBe('hidden')
    expect(p.showBillingDetails).toBe(false)
  })

  it('se clasifica ANTES que «activa por Mercado Pago», aunque haya un preapproval en la fila', () => {
    const conMp = manual(source, { mpPreapprovalId: 'pre_anterior', lastPaymentStatus: 'approved' })
    expect(resolver(conMp).state).toBe('manual_access')
    expect(fila(conMp)).toEqual({ ...NADA, help: true })
  })

  it('con vencimiento lo informa; sin vencimiento no inventa una fecha', () => {
    expect(resolver(manual(source, { overrideExpiresAt: enDias(40) })).manualAccessExpiresAt).toBe(enDias(40))
    expect(resolver(manual(source)).manualAccessExpiresAt).toBeNull()
    expect(resolver(manual(source, { overrideExpiresAt: null })).manualAccessExpiresAt).toBeNull()
  })

  it.each(['trialing', 'past_due'] as const)('con estado `%s` sigue siendo acceso manual: sin billing', (status) => {
    const input = manual(source, { status, checkout: { status: 'pending' }, mpPreapprovalId: 'pre_1' })
    expect(resolver(input).state).toBe('manual_access')
    expect(fila(input)).toEqual({ ...NADA, help: true })
  })

  it('no se consulta el checkout pendiente para un acceso manual', () => {
    expect(shouldLookUpPendingCheckout({ status: 'trialing', accessSource: source })).toBe(false)
    expect(shouldLookUpPendingCheckout({ status: 'active', accessSource: source })).toBe(false)
  })
})

describe('5 bis · qué cuenta como acceso manual', () => {
  it.each([
    ['admin_override', true], ['manual_grandfathered', true],
    ['mercado_pago', false], ['trial', false], [null, false], [undefined, false],
  ] as const)('access_source %s → %s', (source, esperado) => {
    expect(isManualAccess(source)).toBe(esperado)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('6 · suspendida / cancelada: manda el muro de BETA-1', () => {
  const vencidoHace = (n: number) => new Date(AHORA.getTime() - n * DIA).toISOString()

  it('trial vencido → `blocked` + `trial_ended`, con «Elegir plan» (nunca tuvo un plan)', () => {
    const input: SubscriptionPresentationInput = { status: 'suspended', trialEndsAt: vencidoHace(1) }
    const p = resolver(input)
    expect(p.state).toBe('blocked')
    expect(p.wall).toBe('trial_ended')
    expect(fila(input)).toEqual({ ...NADA, choose_plan: true })
  })

  it('suspendida por pago → `billing_suspended`, con «Reactivar»', () => {
    const input: SubscriptionPresentationInput = {
      status: 'suspended', accessSource: 'mercado_pago', mpPreapprovalId: 'pre_1',
      lastPaymentStatus: 'rejected', trialEndsAt: vencidoHace(60),
    }
    expect(resolver(input).wall).toBe('billing_suspended')
    expect(fila(input)).toEqual({ ...NADA, reactivate: true })
  })

  it('cancelada → `canceled`, con «Reactivar»', () => {
    const input: SubscriptionPresentationInput = { status: 'canceled', mpPreapprovalId: 'pre_1' }
    expect(resolver(input).wall).toBe('canceled')
    expect(fila(input)).toEqual({ ...NADA, reactivate: true })
  })

  it('pendiente de activación: sin acciones, como antes', () => {
    expect(fila({ status: 'pending_activation' })).toEqual(NADA)
  })

  it('bloqueada nunca ofrece administrar una suscripción de Mercado Pago', () => {
    for (const status of ['suspended', 'canceled', 'pending_activation'] as const) {
      const acciones = presentationActions(resolver({ status, mpPreapprovalId: 'pre_1', accessSource: 'mercado_pago' }))
      expect(acciones.filter(a => MERCADO_PAGO_ACTIONS.includes(a)), status).toEqual([])
    }
  })

  it('el tipo de muro es EXACTAMENTE el de `classifySubscriptionWall`: no hay una segunda clasificación', () => {
    const filas: SubscriptionPresentationInput[] = [
      { status: 'suspended', trialEndsAt: vencidoHace(1) },
      { status: 'suspended', trialEndsAt: enDias(3) },
      { status: 'suspended', mpPreapprovalId: 'pre_1' },
      { status: 'suspended', accessSource: 'mercado_pago' },
      { status: 'suspended', lastPaymentStatus: 'approved' },
      { status: 'suspended', accessSource: 'admin_override', trialEndsAt: vencidoHace(5) },
      { status: 'canceled' },
    ]
    for (const input of filas) {
      expect(resolver(input).wall).toBe(classifySubscriptionWall({
        subscription_status: input.status,
        access_source: input.accessSource,
        mp_preapproval_id: input.mpPreapprovalId,
        last_payment_status: input.lastPaymentStatus,
        trial_ends_at: input.trialEndsAt,
      }, AHORA))
    }
  })

  it('una fuente manual sobre un negocio bloqueado NO se presenta como «acceso otorgado»', () => {
    // El acceso manual ya no está vigente: la salida es la del muro, no Ayuda.
    const input: SubscriptionPresentationInput = { status: 'suspended', accessSource: 'admin_override', trialEndsAt: vencidoHace(5) }
    expect(resolver(input).state).toBe('blocked')
    expect(fila(input)).toEqual({ ...NADA, choose_plan: true })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('prioridad de clasificación', () => {
  it('manual > trial + checkout pendiente > trial', () => {
    const base: SubscriptionPresentationInput = { status: 'trialing', checkout: { status: 'pending' } }
    expect(resolver({ ...base, accessSource: 'admin_override' }).state).toBe('manual_access')
    expect(resolver({ ...base, accessSource: 'trial' }).state).toBe('trial_pending_checkout')
    expect(resolver({ ...base, accessSource: 'trial', checkout: null }).state).toBe('trial')
  })

  it('manual > activa por Mercado Pago > activa sin vínculo', () => {
    const base: SubscriptionPresentationInput = { status: 'active', mpPreapprovalId: 'pre_1' }
    expect(resolver({ ...base, accessSource: 'manual_grandfathered' }).state).toBe('manual_access')
    expect(resolver({ ...base, accessSource: 'mercado_pago' }).state).toBe('mp_active')
    expect(resolver({ status: 'active', accessSource: 'mercado_pago' }).state).toBe('active_unlinked')
  })

  it('bloqueada se resuelve primero: el muro de BETA-1 no se rediseña', () => {
    for (const source of ['admin_override', 'manual_grandfathered', 'mercado_pago', 'trial', null] as const) {
      expect(resolver({ status: 'suspended', accessSource: source }).state, String(source)).toBe('blocked')
      expect(resolver({ status: 'canceled', accessSource: source }).state, String(source)).toBe('blocked')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('invariantes sobre TODA la matriz', () => {
  const ESTADOS: SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'suspended', 'canceled', 'pending_activation']
  const FUENTES: Array<AccessSource | null> = ['mercado_pago', 'trial', 'manual_grandfathered', 'admin_override', null]
  const PREAPPROVALS = ['pre_1', null]
  const CHECKOUTS = [null, { status: 'pending' }, { status: 'paid' }, { status: 'expired' }]

  const combinaciones: SubscriptionPresentationInput[] = []
  for (const status of ESTADOS) for (const accessSource of FUENTES)
    for (const mpPreapprovalId of PREAPPROVALS) for (const checkout of CHECKOUTS) {
      combinaciones.push({ status, accessSource, mpPreapprovalId, checkout, currentPeriodEnd: enDias(10), trialEndsAt: enDias(-2) })
    }

  it('recorre las 240 combinaciones de estado × fuente × vínculo × checkout', () => {
    expect(combinaciones).toHaveLength(6 * 5 * 2 * 4)
  })

  it('Actualizar método y Cancelar SÓLO con una suscripción de Mercado Pago vinculada', () => {
    for (const input of combinaciones) {
      const f = fila(input)
      if (f.update_payment_method || f.cancel_subscription) {
        expect(hasMercadoPagoSubscription(input.mpPreapprovalId), JSON.stringify(input)).toBe(true)
      }
    }
  })

  it('con una fuente manual y acceso vigente: jamás una acción de billing', () => {
    for (const input of combinaciones) {
      if (!isManualAccess(input.accessSource)) continue
      if (['suspended', 'canceled', 'pending_activation'].includes(input.status)) continue
      expect(fila(input), JSON.stringify(input)).toEqual({ ...NADA, help: true })
    }
  })

  it('«Continuar pago» sólo en un trial con checkout `pending`', () => {
    for (const input of combinaciones) {
      const esperado = input.status === 'trialing' && !isManualAccess(input.accessSource) && input.checkout?.status === 'pending'
      expect(fila(input).continue_checkout, JSON.stringify(input)).toBe(esperado)
    }
  })

  it('«Verificar pago» nunca aparece sin algo que verificar (checkout pendiente o suscripción vinculada)', () => {
    for (const input of combinaciones) {
      if (!fila(input).verify_payment) continue
      const hayAlgo = input.checkout?.status === 'pending' || hasMercadoPagoSubscription(input.mpPreapprovalId)
      expect(hayAlgo, JSON.stringify(input)).toBe(true)
    }
  })

  it('el próximo cobro sólo se anuncia en `mp_active`', () => {
    for (const input of combinaciones) {
      const p = resolver(input)
      if (p.showNextCharge) expect(p.state, JSON.stringify(input)).toBe('mp_active')
    }
  })

  it('el precio nunca se presenta como un cobro en trial, acceso manual ni bloqueada', () => {
    for (const input of combinaciones) {
      const p = resolver(input)
      if (p.price === 'current') expect(['mp_active', 'past_due'], JSON.stringify(input)).toContain(p.state)
      if (p.state === 'manual_access' || p.state === 'blocked') expect(p.price, JSON.stringify(input)).toBe('hidden')
    }
  })

  it('a lo sumo una acción primaria, y ninguna acción repetida', () => {
    for (const input of combinaciones) {
      const acciones = presentationActions(resolver(input))
      expect(new Set(acciones).size, JSON.stringify(input)).toBe(acciones.length)
    }
  })

  it('es determinista y no muta su entrada', () => {
    for (const input of combinaciones) {
      const copia = JSON.parse(JSON.stringify(input))
      expect(resolver(input)).toEqual(resolver(input))
      expect(input).toEqual(copia)
    }
  })

  it('sólo se consulta el checkout en un trial que no es acceso manual', () => {
    for (const input of combinaciones) {
      expect(shouldLookUpPendingCheckout(input), JSON.stringify(input))
        .toBe(input.status === 'trialing' && !isManualAccess(input.accessSource))
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('no es una segunda máquina de entitlement', () => {
  it('recibe el estado EFECTIVO: un override vigente sobre `suspended` se presenta como acceso manual', () => {
    const negocio = { subscription_status: 'suspended' as const, subscription_plan: 'pro' as const, access_source: 'admin_override' as const, override_expires_at: null }
    const efectivo = resolveEntitlement(negocio, AHORA).effectiveStatus
    expect(efectivo).toBe('active')
    expect(resolver({ status: efectivo, accessSource: negocio.access_source }).state).toBe('manual_access')
  })

  it('con el override VENCIDO el estado efectivo sigue bloqueado y manda el muro', () => {
    const negocio = { subscription_status: 'suspended' as const, subscription_plan: 'pro' as const, access_source: 'admin_override' as const, override_expires_at: enDias(-1) }
    const efectivo = resolveEntitlement(negocio, AHORA).effectiveStatus
    expect(efectivo).toBe('suspended')
    expect(resolver({ status: efectivo, accessSource: negocio.access_source }).state).toBe('blocked')
  })

  it('el módulo es puro: no importa Supabase, React ni servicios', () => {
    const src = readFileSync('src/lib/subscriptionPresentation.ts', 'utf8')
    const codigo = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const imports = [...codigo.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1])
    expect(imports.sort()).toEqual(['../types/subscriptionAccess.ts', './subscriptionWall.ts'])
    expect(codigo).not.toMatch(/import\.meta|localStorage|fetch\(|supabase|window\.|document\./i)
  })
})
