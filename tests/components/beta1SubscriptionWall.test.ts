// ─────────────────────────────────────────────────────────────────────────────
// BETA-1 · Clasificación pura del muro y canal de soporte.
//
//   W  `classifySubscriptionWall` separa «terminó la prueba» de «falta de pago»
//   V  `describeSubscriptionWall`: copy por tipo; el CTA primario es Planes
//   C  `config/contacto.ts` es el único que arma el enlace de ayuda
//   G  control de fuente: no queda ningún candado de cobros, y WhatsApp es
//      ayuda — ninguna pantalla de billing lo usa para activar un plan
//
// Sin mocks: son funciones puras y lecturas de archivos.
// ─────────────────────────────────────────────────────────────────────────────
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  classifySubscriptionWall,
  describeSubscriptionWall,
  hasPaidSubscription,
  type BillingSnapshot,
  type SubscriptionWallKind,
} from '../../src/lib/subscriptionWall'
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

  type Muro = Exclude<SubscriptionWallKind, 'none'>
  /** Los muros que un plan resuelve. `suspended_other` no es uno de ellos. */
  const CON_PLANES: Muro[] = ['trial_ended', 'billing_suspended', 'canceled']
  const texto = (tipo: Muro) => {
    const v = describeSubscriptionWall(tipo)
    return `${v.title} ${v.description} ${v.badge} ${v.primaryLabel}`
  }

  it('trial_ended: título exacto, datos protegidos y la salida es elegir un plan', () => {
    const v = describeSubscriptionWall('trial_ended')
    expect(v.title).toBe('Tu período de prueba terminó')
    expect(v.description).toMatch(/datos siguen guardados y protegidos/i)
    expect(v.description).toMatch(/Elegí un plan/)
    expect(v.badge).toBe('Prueba finalizada')
    expect(v).toMatchObject({ primary: 'plans', primaryLabel: 'Ver planes', tone: 'info' })
  })

  it('trial_ended NUNCA habla de pagos', () => {
    expect(texto('trial_ended')).not.toMatch(DEUDA)
  })

  it('billing_suspended SÍ habla de falta de pago: ahí hay una suscripción paga', () => {
    const v = describeSubscriptionWall('billing_suspended')
    expect(v.title).toBe('Cuenta suspendida')
    expect(v.description).toBe('Tu suscripción fue suspendida por falta de pago. Para restaurar el acceso, actualizá tu método de pago o elegí un nuevo plan.')
    expect(v).toMatchObject({ primary: 'plans', primaryLabel: 'Ver planes y reactivar', tone: 'danger' })
  })

  it('canceled conserva su copy y su CTA de reactivación', () => {
    const v = describeSubscriptionWall('canceled')
    expect(v.title).toBe('Suscripción cancelada')
    expect(v).toMatchObject({ primary: 'plans', primaryLabel: 'Reactivar mi cuenta' })
  })

  it('los muros que un plan resuelve salen por Planes y no mandan a soporte para activar', () => {
    for (const tipo of CON_PLANES) {
      const v = describeSubscriptionWall(tipo)
      expect(v.primary, tipo).toBe('plans')
      expect(v.primaryLabel, tipo).toMatch(/plan|reactivar/i)
      expect(texto(tipo), tipo).not.toMatch(/escribinos|contact|whatsapp|soporte/i)
    }
  })

  it('suspended_other sale por Ayuda: pagar no levanta esa suspensión', () => {
    const v = describeSubscriptionWall('suspended_other')
    expect(v.title).toBe('Cuenta suspendida')
    expect(v).toMatchObject({ primary: 'help', primaryLabel: 'Contactar soporte', tone: 'neutral' })
    expect(v.description).toMatch(/datos siguen guardados y protegidos/i)
    // Neutro: ni una deuda inventada, ni un trial, ni la promesa de que un plan lo arregla.
    expect(texto('suspended_other')).not.toMatch(DEUDA)
    expect(texto('suspended_other')).not.toMatch(/prueba terminó/)
    expect(texto('suspended_other')).not.toMatch(/\bplan(es)?\b|pag[aáo]|reactiv|suscripci[oó]n/i)
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
    const canal = canalSoporte('Hola, me aparece un error & no puedo seguir')
    expect(new URL(canal.url).searchParams.get('text')).toBe('Hola, me aparece un error & no puedo seguir')
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
// Control de fuente. Dos contratos de producto que no deben volver a torcerse:
//   · Mercado Pago es autoservicio: no hay ningún flag que lo apague.
//   · WhatsApp es AYUDA: ninguna pantalla de billing lo usa para activar un plan.
describe('G · control de fuente', () => {
  const fuentes = archivos('src')
  const leer = (p: string) => readFileSync(p, 'utf8')
  const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('no existe ningún candado de cobros: ni el módulo ni sus identificadores', () => {
    expect(existsSync('src/config/betaBilling.ts')).toBe(false)
    const culpables = fuentes.filter(p => /betaBilling|BETA_BILLING|isBillingCheckoutEnabled|BILLING_CHECKOUT_DISABLED/.test(leer(p)))
    expect(culpables.map(rel)).toEqual([])
  })

  it('createSubscription llega a la Edge Function sin ninguna condición previa', () => {
    const src = sinComentarios(leer('src/services/subscriptionService.ts'))
    const cuerpo = src.slice(src.indexOf('export async function createSubscription'))
    const hastaLaLlamada = cuerpo.slice(0, cuerpo.indexOf("callEdge<CreateSubscriptionResponse>('create'"))
    expect(hastaLaLlamada).not.toMatch(/\bif\b|\bthrow\b|\breturn\b/)
  })

  it('Planes inicia el checkout: llama a createSubscription y redirige al init_point', () => {
    const src = sinComentarios(leer('src/pages/Plans.tsx'))
    expect(src).toMatch(/await createSubscription\(/)
    expect(src).toMatch(/window\.location\.href = res\.init_point/)
    expect(src).toMatch(/onClick=\{\(\) => handleSelect\(plan\.id\)\}/)
  })

  it('las pantallas de billing NO usan el canal de ayuda para activar un plan', () => {
    for (const p of [
      'src/pages/Plans.tsx',
      'src/pages/Subscription.tsx',
      'src/pages/PaymentPending.tsx',
      'src/pages/SubscriptionSuccess.tsx',
      'src/pages/SubscriptionFailure.tsx',
      'src/components/subscription/SubscriptionBanner.tsx',
      'src/components/subscription/FeaturePaywall.tsx',
      'src/components/subscription/UpgradeRequired.tsx',
      'src/components/subscription/FeatureGate.tsx',
    ]) {
      const src = sinComentarios(leer(p))
      expect(src, p).not.toMatch(/config\/contacto|canalSoporte|SupportContactButton|whatsappSoporte/)
      expect(src, p).not.toMatch(/Contactar para activar/i)
    }
  })

  it('sólo subscriptionService invoca la Edge Function mp-subscription', () => {
    const invocan = fuentes.filter(p => /['"`]mp-subscription['"`]/.test(sinComentarios(leer(p))))
    expect(invocan.map(rel)).toEqual(['src/services/subscriptionService.ts'])
  })

  it('los componentes de ayuda no hardcodean teléfonos ni wa.me: el enlace sale de contacto.ts', () => {
    for (const p of [
      'src/pages/Ayuda.tsx',
      'src/pages/SubscriptionSuspended.tsx',
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
    // Subscription.tsx traía dos (cancelar / método de pago) y BETA-1 fijó «no se
    // suman más». BETA-MP los reemplazó por un mensaje en la pantalla con el motivo
    // del servidor: el tope baja de 2 a 0.
    expect(sinComentarios(leer('src/pages/Subscription.tsx')).match(/\balert\(/g) ?? []).toHaveLength(0)
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
