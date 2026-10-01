// ─────────────────────────────────────────────────────────────────────────────
// BETA-1 · Clasificación pura, flag de checkout y canal de soporte.
//
//   W  `classifySubscriptionWall` separa «terminó la prueba» de «falta de pago»
//   V  `describeSubscriptionWall`: copy y CTA por tipo, con el flag en los dos
//      valores (reversibilidad)
//   F  el flag de beta nace apagado y tiene una sola autoridad
//   C  `config/contacto.ts` es el único que arma el enlace de ayuda
//   G  control de fuente: nadie fuera de `subscriptionService` llama a
//      `mp-subscription`, y quien importa el checkout consulta el flag
//
// Sin mocks: son funciones puras y lecturas de archivos.
// ─────────────────────────────────────────────────────────────────────────────
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  classifySubscriptionWall,
  describeSubscriptionWall,
  hasPaidSubscription,
  type BillingSnapshot,
  type SubscriptionWallKind,
} from '../../src/lib/subscriptionWall'
import {
  BETA_BILLING_CHECKOUT_ENABLED,
  isBillingCheckoutEnabled,
} from '../../src/config/betaBilling'
import {
  CONTACTO_SOPORTE,
  MENSAJE_SOPORTE_DEFAULT,
  canalSoporte,
  normalizarWhatsApp,
  whatsappSoporte,
} from '../../src/config/contacto'

const AHORA = new Date('2026-10-01T12:00:00.000Z')
const AYER = '2026-09-30T12:00:00.000Z'
const EN_UNA_SEMANA = '2026-10-08T12:00:00.000Z'

// Número de fantasía: no es un teléfono asignable.
const WHATSAPP_TEST = '5490000000000'

const snapshot = (over: BillingSnapshot): BillingSnapshot => ({
  subscription_status: 'suspended',
  access_source: null,
  mp_preapproval_id: null,
  last_payment_status: null,
  trial_ends_at: AYER,
  ...over,
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('W · clasificación del bloqueo', () => {
  it('trial ACTIVO no es un muro', () => {
    expect(classifySubscriptionWall(snapshot({ subscription_status: 'trialing', trial_ends_at: EN_UNA_SEMANA }), AHORA)).toBe('none')
  })

  it('trialing con la fecha ya pasada (el cron todavía no corrió) tampoco bloquea', () => {
    expect(classifySubscriptionWall(snapshot({ subscription_status: 'trialing' }), AHORA)).toBe('none')
  })

  it.each(['active', 'past_due', 'pending_activation'] as const)('%s no es un muro', (status) => {
    expect(classifySubscriptionWall(snapshot({ subscription_status: status }), AHORA)).toBe('none')
  })

  it('sin datos (null / undefined / estado ausente) no se adelanta un motivo', () => {
    expect(classifySubscriptionWall(null, AHORA)).toBe('none')
    expect(classifySubscriptionWall(undefined, AHORA)).toBe('none')
    expect(classifySubscriptionWall({ subscription_status: null }, AHORA)).toBe('none')
  })

  it('suspended SIN suscripción paga y con el trial vencido → trial_ended', () => {
    expect(classifySubscriptionWall(snapshot({}), AHORA)).toBe('trial_ended')
    expect(classifySubscriptionWall(snapshot({ access_source: 'trial' }), AHORA)).toBe('trial_ended')
  })

  it('el estado que deja expire_trials() (sólo cambia el status) cae en trial_ended', () => {
    // expire_trials(): UPDATE businesses SET subscription_status = 'suspended'
    // WHERE subscription_status = 'trialing' AND trial_ends_at < NOW()
    const antes: BillingSnapshot = { subscription_status: 'trialing', trial_ends_at: AYER, access_source: null, mp_preapproval_id: null, last_payment_status: null }
    const despues: BillingSnapshot = { ...antes, subscription_status: 'suspended' }
    expect(classifySubscriptionWall(antes, AHORA)).toBe('none')
    expect(classifySubscriptionWall(despues, AHORA)).toBe('trial_ended')
  })

  it.each([
    ['preapproval de MP', { mp_preapproval_id: 'pre_123' }],
    ['acceso originado en un pago MP', { access_source: 'mercado_pago' as const }],
    ['un cobro procesado por el webhook', { last_payment_status: 'rejected' }],
  ])('suspended con %s → billing_suspended', (_caso, over) => {
    expect(classifySubscriptionWall(snapshot(over), AHORA)).toBe('billing_suspended')
  })

  it('la suscripción paga manda aunque el trial también haya vencido', () => {
    expect(classifySubscriptionWall(snapshot({ mp_preapproval_id: 'pre_123', trial_ends_at: AYER }), AHORA)).toBe('billing_suspended')
  })

  it('suspended sin billing y con el trial todavía vigente → suspended_other (no «prueba terminada»)', () => {
    expect(classifySubscriptionWall(snapshot({ trial_ends_at: EN_UNA_SEMANA }), AHORA)).toBe('suspended_other')
    expect(classifySubscriptionWall(snapshot({ trial_ends_at: null }), AHORA)).toBe('suspended_other')
    expect(classifySubscriptionWall(snapshot({ trial_ends_at: 'no-es-una-fecha' }), AHORA)).toBe('suspended_other')
  })

  it('canceled es canceled, con o sin billing', () => {
    expect(classifySubscriptionWall(snapshot({ subscription_status: 'canceled' }), AHORA)).toBe('canceled')
    expect(classifySubscriptionWall(snapshot({ subscription_status: 'canceled', mp_preapproval_id: 'pre_1' }), AHORA)).toBe('canceled')
  })

  it('hasPaidSubscription: un override manual NO es una suscripción paga', () => {
    expect(hasPaidSubscription({ access_source: 'admin_override' })).toBe(false)
    expect(hasPaidSubscription({ access_source: 'manual_grandfathered' })).toBe(false)
    expect(hasPaidSubscription({ access_source: 'trial' })).toBe(false)
    expect(hasPaidSubscription({ mp_preapproval_id: '   ' })).toBe(false)
    expect(hasPaidSubscription(null)).toBe(false)
    expect(hasPaidSubscription({ mp_preapproval_id: 'pre_1' })).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('V · copy y CTA del muro', () => {
  const DEUDA = /falta de pago|m[eé]todo de pago|verificar pago|deuda|pago vencido/i

  it('trial_ended: título exacto y datos protegidos', () => {
    const v = describeSubscriptionWall('trial_ended', false)
    expect(v.title).toBe('Tu período de prueba terminó')
    expect(v.description).toMatch(/datos siguen guardados y protegidos/i)
    expect(v.description).toMatch(/continuar con la beta o elegir un plan/i)
    expect(v.badge).toBe('Prueba finalizada')
  })

  it.each([false, true])('trial_ended NUNCA habla de pagos (checkout=%s)', (checkout) => {
    const v = describeSubscriptionWall('trial_ended', checkout)
    expect(`${v.title} ${v.description} ${v.badge} ${v.plansLabel ?? ''}`).not.toMatch(DEUDA)
  })

  it('suspended_other tampoco inventa una deuda', () => {
    for (const checkout of [false, true]) {
      const v = describeSubscriptionWall('suspended_other', checkout)
      expect(`${v.title} ${v.description}`).not.toMatch(DEUDA)
      expect(v.primary).toBe('help')
    }
  })

  it('billing_suspended conserva la semántica de falta de pago en los dos valores del flag', () => {
    expect(describeSubscriptionWall('billing_suspended', false).description).toMatch(/suspendida por falta de pago/)
    expect(describeSubscriptionWall('billing_suspended', true).description).toMatch(/suspendida por falta de pago/)
  })

  it('con el checkout APAGADO todo muro sale por Ayuda, nunca por Planes', () => {
    const tipos: Array<Exclude<SubscriptionWallKind, 'none'>> = ['trial_ended', 'billing_suspended', 'suspended_other', 'canceled']
    for (const tipo of tipos) {
      const v = describeSubscriptionWall(tipo, false)
      expect(v.primary, tipo).toBe('help')
      expect(v.plansLabel, tipo).toBeNull()
    }
  })

  it('con el checkout PRENDIDO vuelve el CTA a Planes (el flag es reversible)', () => {
    expect(describeSubscriptionWall('trial_ended', true)).toMatchObject({ primary: 'plans', plansLabel: 'Ver planes' })
    expect(describeSubscriptionWall('billing_suspended', true)).toMatchObject({ primary: 'plans', plansLabel: 'Ver planes y reactivar' })
    expect(describeSubscriptionWall('canceled', true)).toMatchObject({ primary: 'plans', plansLabel: 'Reactivar mi cuenta' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('F · flag de beta', () => {
  it('nace apagado y la función lee la constante', () => {
    expect(BETA_BILLING_CHECKOUT_ENABLED).toBe(false)
    expect(isBillingCheckoutEnabled()).toBe(false)
  })

  it('hay UNA sola definición del flag en src/', () => {
    const definiciones = archivos('src').filter(p => /BETA_BILLING_CHECKOUT_ENABLED\s*=/.test(readFileSync(p, 'utf8')))
    expect(definiciones.map(rel)).toEqual(['src/config/betaBilling.ts'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C · canal de soporte canónico', () => {
  it('normaliza al formato de wa.me (sólo dígitos, sin +)', () => {
    expect(normalizarWhatsApp('+54 9 000 000-0000')).toBe(WHATSAPP_TEST)
    expect(normalizarWhatsApp(WHATSAPP_TEST)).toBe(WHATSAPP_TEST)
  })

  it('rechaza lo que no parece un teléfono internacional', () => {
    for (const malo of [undefined, null, '', '   ', 'whatsapp', '12345', '1'.repeat(16)]) {
      expect(normalizarWhatsApp(malo as string | null | undefined), String(malo)).toBeNull()
    }
  })

  it('con VITE_CONTACT_WHATSAPP configurado el canal es WhatsApp', () => {
    vi.stubEnv('VITE_CONTACT_WHATSAPP', `+${WHATSAPP_TEST}`)
    expect(whatsappSoporte()).toBe(WHATSAPP_TEST)
    const canal = canalSoporte()
    expect(canal.tipo).toBe('whatsapp')
    expect(canal.etiqueta).toBe('Hablar por WhatsApp')
    expect(canal.url).toBe(`https://wa.me/${WHATSAPP_TEST}?text=${encodeURIComponent(MENSAJE_SOPORTE_DEFAULT)}`)
  })

  it('el mensaje precargado va codificado y es el que pide la pantalla', () => {
    vi.stubEnv('VITE_CONTACT_WHATSAPP', WHATSAPP_TEST)
    const canal = canalSoporte('Hola, quiero activar el plan Básico & más')
    expect(new URL(canal.url).searchParams.get('text')).toBe('Hola, quiero activar el plan Básico & más')
  })

  it('sin WhatsApp configurado cae al correo: la pantalla nunca queda sin salida', () => {
    vi.stubEnv('VITE_CONTACT_WHATSAPP', '')
    expect(whatsappSoporte()).toBeNull()
    expect(canalSoporte()).toEqual({ tipo: 'email', url: `mailto:${CONTACTO_SOPORTE}`, etiqueta: 'Escribir por correo' })
  })

  it('un valor roto en la variable no produce un link roto', () => {
    vi.stubEnv('VITE_CONTACT_WHATSAPP', 'pendiente')
    expect(canalSoporte().tipo).toBe('email')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Control de fuente. Mientras el flag esté apagado, que un componente vuelva a
// enlazar el checkout por su cuenta tiene que romper acá, no en producción.
describe('G · control de fuente del checkout', () => {
  const fuentes = archivos('src')
  const leer = (p: string) => readFileSync(p, 'utf8')
  const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('sólo subscriptionService invoca la Edge Function mp-subscription', () => {
    const invocan = fuentes.filter(p => /['"`]mp-subscription['"`]/.test(sinComentarios(leer(p))))
    expect(invocan.map(rel)).toEqual(['src/services/subscriptionService.ts'])
  })

  it('createSubscription corta ANTES de llamar a la Edge Function', () => {
    const src = leer('src/services/subscriptionService.ts')
    const cuerpo = src.slice(src.indexOf('export async function createSubscription'))
    const corte = cuerpo.indexOf('if (!isBillingCheckoutEnabled()) throw')
    const llamada = cuerpo.indexOf("callEdge<CreateSubscriptionResponse>('create'")
    expect(corte).toBeGreaterThan(-1)
    expect(llamada).toBeGreaterThan(corte)
  })

  it('todo archivo que importa una acción de pago consulta el flag', () => {
    const ACCIONES = /\b(createSubscription|cancelSubscription|getUpdatePaymentLink|reconcilePayment)\b/
    const consumidores = fuentes.filter(p => {
      if (rel(p) === 'src/services/subscriptionService.ts') return false
      const src = sinComentarios(leer(p))
      return /from ['"][^'"]*services\/subscriptionService['"]/.test(src) && ACCIONES.test(src)
    })
    // Hoy son exactamente estas dos pantallas. Una tercera es una decisión, no un descuido.
    expect(consumidores.map(rel).sort()).toEqual(['src/pages/Plans.tsx', 'src/pages/Subscription.tsx'])
    for (const p of consumidores) {
      expect(leer(p), rel(p)).toContain('isBillingCheckoutEnabled()')
    }
  })

  it('nadie arma una URL de checkout de Mercado Pago del lado del navegador', () => {
    const culpables = fuentes.filter(p => /mercadopago\.com(\.ar)?\/subscriptions\/checkout|preapproval_plan_id=/.test(sinComentarios(leer(p))))
    expect(culpables.map(rel)).toEqual([])
  })

  it('los componentes de ayuda no hardcodean teléfonos ni wa.me: el enlace sale de contacto.ts', () => {
    for (const p of [
      'src/pages/Ayuda.tsx',
      'src/pages/SubscriptionSuspended.tsx',
      'src/pages/Plans.tsx',
      'src/pages/Subscription.tsx',
      'src/components/ui/SupportContactButton.tsx',
      'src/components/ui/PremiumErrorBoundary.tsx',
    ]) {
      const src = sinComentarios(leer(p))
      expect(src, p).not.toMatch(/wa\.me|api\.whatsapp\.com|VITE_CONTACT_WHATSAPP/)
      expect(src, p).not.toMatch(/\d{10,}/)
    }
  })

  it('ninguna superficie de BETA-1 agrega un alert() nativo', () => {
    for (const p of [
      'src/pages/Ayuda.tsx',
      'src/pages/SubscriptionSuspended.tsx',
      'src/pages/Plans.tsx',
      'src/components/ui/SupportContactButton.tsx',
      'src/components/subscription/SubscriptionBanner.tsx',
    ]) {
      expect(sinComentarios(leer(p)), p).not.toMatch(/\balert\(/)
    }
    // Subscription.tsx ya traía dos (cancelar / método de pago): no se suman más.
    expect(sinComentarios(leer('src/pages/Subscription.tsx')).match(/\balert\(/g) ?? []).toHaveLength(2)
  })
})

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap(e => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? archivos(p) : /\.(ts|tsx)$/.test(p) ? [p] : []
  })
}

function rel(p: string): string {
  return relative('.', p).split(sep).join('/')
}
