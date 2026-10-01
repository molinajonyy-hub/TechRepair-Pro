// ─────────────────────────────────────────────────────────────────────────────
// BETA-1 · Fin de la prueba + candado de cobros durante la beta.
//
//   T  la pantalla de bloqueo distingue «terminó la prueba» de «falta de pago»
//   B  con el checkout apagado NINGUNA interacción llega a `mp-subscription`:
//      banner, Planes, paywalls, Suscripción y el servicio mismo
//   R  el flag es reversible: prendido, el checkout vuelve a funcionar
//
// Los mocks van en el BORDE: auth, el hook de datos de suscripción y el cliente
// de Supabase. `subscriptionService` corre DE VERDAD, así que «no llamó al
// checkout» se mide sobre `supabase.functions.invoke`, no sobre un stub propio.
// ─────────────────────────────────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'

const AHORA = Date.now()
const DIA = 24 * 60 * 60 * 1000
const haceDias = (n: number) => new Date(AHORA - n * DIA).toISOString()
const enDias = (n: number) => new Date(AHORA + n * DIA).toISOString()

// Número de fantasía: no es un teléfono asignable.
const WHATSAPP_TEST = '5490000000000'

const h = vi.hoisted(() => ({
  /** null = el valor real del repo (apagado). true = simular el flag prendido. */
  checkout: null as boolean | null,
  invoke: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  role: 'owner' as string,
  sub: {} as Record<string, unknown>,
}))

vi.mock('../../src/config/betaBilling', async (orig) => {
  const actual = await orig<typeof import('../../src/config/betaBilling')>()
  return { ...actual, isBillingCheckoutEnabled: () => h.checkout ?? actual.isBillingCheckoutEnabled() }
})

vi.mock('../../src/lib/supabase', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'order', 'limit', 'insert']) chain[m] = () => chain
  chain.single = async () => ({ data: null, error: null })
  chain.maybeSingle = async () => ({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null, count: 1 }).then(res, rej)
  return {
    supabase: {
      from: () => chain,
      rpc: async () => ({ data: null, error: null }),
      functions: { invoke: h.invoke },
      auth: { getUser: h.getUser },
    },
  }
})

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    businessId: 'biz-beta1',
    user: { email: 'owner@invalid.test' },
    role: h.role,
    isOwner: h.role === 'owner',
    profile: { permissions: null },
    signOut: h.signOut,
  }),
}))

vi.mock('../../src/hooks/useSubscription', () => ({ useSubscription: () => h.sub }))

import { SubscriptionSuspended } from '../../src/pages/SubscriptionSuspended'
import { Plans } from '../../src/pages/Plans'
import { Subscription } from '../../src/pages/Subscription'
import { SubscriptionBanner } from '../../src/components/subscription/SubscriptionBanner'
import { SubscriptionGuard } from '../../src/components/subscription/SubscriptionGuard'
import { FeaturePaywall } from '../../src/components/subscription/FeaturePaywall'
import { UpgradeRequired } from '../../src/components/subscription/UpgradeRequired'
import { UpgradeCard } from '../../src/components/subscription/FeatureGate'
import { createSubscription } from '../../src/services/subscriptionService'
import { BILLING_CHECKOUT_DISABLED_MESSAGE } from '../../src/config/betaBilling'
import { canalSoporte } from '../../src/config/contacto'

// ── Estado del hook ─────────────────────────────────────────────────────────
type Estado = 'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled'

function suscripcion(status: Estado, fila: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  h.sub = {
    subscription: {
      subscription_status: status,
      subscription_plan: null,
      access_source: null,
      mp_preapproval_id: null,
      mp_payer_email: null,
      current_period_start: null,
      current_period_end: null,
      grace_until: null,
      last_payment_status: null,
      trial_ends_at: null,
      override_expires_at: null,
      ...fila,
    },
    payments: [],
    loading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
    isAllowed: status === 'trialing' || status === 'active' || status === 'past_due',
    isTrial: status === 'trialing',
    isActive: status === 'active',
    isPastDue: status === 'past_due',
    isSuspended: status === 'suspended',
    isCanceled: status === 'canceled',
    currentPlan: null,
    hasFeature: () => true,
    daysUntilTrialEnd: null,
    daysUntilGraceEnd: null,
    daysUntilPeriodEnd: null,
    ...extra,
  }
}

const trialActivo = () => suscripcion('trialing', { trial_ends_at: enDias(6), access_source: 'trial' }, { daysUntilTrialEnd: 6 })
const trialVencido = () => suscripcion('suspended', { trial_ends_at: haceDias(1) })
const suspendidaPorPago = () => suscripcion('suspended', {
  trial_ends_at: haceDias(60), mp_preapproval_id: 'pre_beta1', access_source: 'mercado_pago',
  last_payment_status: 'rejected', subscription_plan: 'pro',
})

// ── Montaje ─────────────────────────────────────────────────────────────────
function Ruta() {
  return <span data-testid="ruta">{useLocation().pathname}</span>
}

/** App mínima: las pantallas reales de suscripción + lo que se esté probando. */
function montar(inicio: string, bajoPrueba: ReactNode = null) {
  return render(
    <MemoryRouter initialEntries={[inicio]}>
      <Routes>
        <Route path="/subscription/suspended" element={<SubscriptionSuspended />} />
        <Route path="/subscription/plans" element={<Plans />} />
        <Route path="/subscription" element={<Subscription />} />
        <Route path="/ayuda" element={<div data-testid="pantalla-ayuda" />} />
        <Route path="/dashboard" element={<div data-testid="pantalla-dashboard" />} />
        <Route path="*" element={<>{bajoPrueba}</>} />
      </Routes>
      <Ruta />
    </MemoryRouter>,
  )
}

const ruta = () => screen.getByTestId('ruta').textContent

/** Click en un enlace externo sin que jsdom intente navegar. */
function clickEnlace(el: HTMLElement) {
  const frenar = (e: Event) => e.preventDefault()
  document.addEventListener('click', frenar)
  try { fireEvent.click(el) } finally { document.removeEventListener('click', frenar) }
}

/** Ninguna acción de `mp-subscription` salió del navegador. */
function sinCheckout() {
  expect(h.invoke).not.toHaveBeenCalled()
}

const DEUDA = /falta de pago|m[eé]todo de pago|verificar pago|pago vencido/i

beforeEach(() => {
  h.checkout = null
  h.role = 'owner'
  h.invoke.mockReset()
  h.invoke.mockResolvedValue({ data: { init_point: '#beta1-checkout', preapproval_id: 'pre_test' }, error: null })
  h.getUser.mockReset()
  h.getUser.mockResolvedValue({ data: { user: { id: 'user-beta1' } }, error: null })
  h.signOut.mockReset()
  vi.stubEnv('VITE_CONTACT_WHATSAPP', WHATSAPP_TEST)
  trialActivo()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('T · estado «tu prueba terminó»', () => {
  it('trial ACTIVO: el guard no bloquea y la pantalla de bloqueo no se muestra', async () => {
    trialActivo()
    const guard = montar('/orders', <SubscriptionGuard><div data-testid="contenido" /></SubscriptionGuard>)
    expect(screen.getByTestId('contenido')).toBeInTheDocument()
    expect(ruta()).toBe('/orders')
    guard.unmount()

    // Aun escribiendo la URL a mano: no hay muro para un trial vigente.
    montar('/subscription/suspended')
    await waitFor(() => expect(ruta()).toBe('/dashboard'))
    expect(screen.queryByTestId('subscription-wall')).toBeNull()
    expect(screen.queryByText('Tu período de prueba terminó')).toBeNull()
  })

  it('trial VENCIDO sin Mercado Pago: «Tu período de prueba terminó»', () => {
    trialVencido()
    montar('/subscription/suspended')
    const muro = screen.getByTestId('subscription-wall')
    expect(muro).toHaveAttribute('data-wall-kind', 'trial_ended')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tu período de prueba terminó')
    expect(muro).toHaveTextContent(/datos siguen guardados y protegidos/i)
    expect(muro).toHaveTextContent('Prueba finalizada')
  })

  it('ese caso NUNCA dice «falta de pago» ni ofrece nada de pagos', () => {
    trialVencido()
    montar('/subscription/suspended')
    const muro = screen.getByTestId('subscription-wall')
    expect(muro.textContent).not.toMatch(DEUDA)
    expect(muro.textContent).not.toMatch(/Cuenta suspendida|Suspendida/)
    expect(screen.queryByRole('button', { name: /plan|reactivar|pago/i })).toBeNull()
  })

  it('el CTA primario es Ayuda (canal canónico), no el checkout', () => {
    trialVencido()
    montar('/subscription/suspended')
    const cta = screen.getByTestId('subscription-wall-help')
    expect(cta.tagName).toBe('A')
    expect(cta).toHaveAttribute('href', canalSoporte().url)
    expect(cta.getAttribute('href')).toContain(`wa.me/${WHATSAPP_TEST}`)
    expect(cta).toHaveTextContent('Hablar por WhatsApp')
    expect(cta.className).toContain('btn-primary')

    clickEnlace(cta)
    expect(ruta()).toBe('/subscription/suspended')
    sinCheckout()
  })

  it('desde el fin de la prueba se llega a Ayuda', () => {
    trialVencido()
    montar('/subscription/suspended')
    const linea = screen.getByTestId('subscription-suspended-soporte')
    fireEvent.click(within(linea).getByRole('link', { name: 'Ayuda' }))
    expect(ruta()).toBe('/ayuda')
    expect(screen.getByTestId('pantalla-ayuda')).toBeInTheDocument()
  })

  it('el guard deja pasar /ayuda con el negocio bloqueado, y sigue bloqueando el resto', async () => {
    trialVencido()
    const enAyuda = render(
      <MemoryRouter initialEntries={['/ayuda']}>
        <SubscriptionGuard><div data-testid="contenido" /></SubscriptionGuard>
        <Ruta />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('contenido')).toBeInTheDocument()
    await new Promise(r => setTimeout(r, 0))
    expect(ruta()).toBe('/ayuda')
    enAyuda.unmount()

    // Cualquier otra ruta sigue rebotando al muro — que ahora dice la verdad.
    montar('/orders', <SubscriptionGuard><div data-testid="contenido" /></SubscriptionGuard>)
    await waitFor(() => expect(ruta()).toBe('/subscription/suspended'))
    expect(screen.queryByTestId('contenido')).toBeNull()
    expect(screen.getByTestId('subscription-wall')).toHaveAttribute('data-wall-kind', 'trial_ended')
  })

  it('suspensión REAL por una suscripción paga conserva «falta de pago»', () => {
    suspendidaPorPago()
    montar('/subscription/suspended')
    const muro = screen.getByTestId('subscription-wall')
    expect(muro).toHaveAttribute('data-wall-kind', 'billing_suspended')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Cuenta suspendida')
    expect(muro).toHaveTextContent(/suspendida por falta de pago/)
    expect(screen.queryByText('Tu período de prueba terminó')).toBeNull()
    // Beta: se regulariza por Ayuda, no por un checkout nuevo.
    expect(screen.getByTestId('subscription-wall-help').className).toContain('btn-primary')
    expect(screen.queryByRole('button', { name: /Ver planes/ })).toBeNull()
  })

  it('suspendida sin billing y sin trial vencido: mensaje neutro, sin deuda inventada', () => {
    suscripcion('suspended', { trial_ends_at: enDias(5) })
    montar('/subscription/suspended')
    const muro = screen.getByTestId('subscription-wall')
    expect(muro).toHaveAttribute('data-wall-kind', 'suspended_other')
    expect(muro.textContent).not.toMatch(DEUDA)
    expect(muro.textContent).not.toMatch(/prueba terminó/)
  })

  it('mientras carga no adelanta ningún motivo', () => {
    h.sub = { subscription: null, loading: true, isSuspended: false, isCanceled: false }
    montar('/subscription/suspended')
    expect(screen.queryByTestId('subscription-wall')).toBeNull()
    expect(document.body.textContent).not.toMatch(DEUDA)
    expect(ruta()).toBe('/subscription/suspended')
  })

  it('«Cerrar sesión» sigue disponible en el muro', () => {
    trialVencido()
    montar('/subscription/suspended')
    fireEvent.click(screen.getByRole('button', { name: /Cerrar sesión/ }))
    expect(h.signOut).toHaveBeenCalledTimes(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B · checkout apagado (beta)', () => {
  it('banner: «Ver planes» lleva a Planes informativo y no abre el checkout', () => {
    trialActivo()
    Object.assign(h.sub, { daysUntilTrialEnd: 3 })
    montar('/orders', <SubscriptionBanner />)
    expect(screen.getByText(/escribinos para continuar/i)).toBeInTheDocument()
    expect(screen.queryByText(/Elegí un plan para continuar/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Ver planes' }))
    expect(ruta()).toBe('/subscription/plans')
    expect(screen.getAllByText('Contactar para activar')).toHaveLength(3)
    sinCheckout()
  })

  it('banner: sin suscripción paga no pide revisar un «método de pago»', () => {
    // Acceso otorgado a mano (admin_override): tiene current_period_end, no cobra.
    suscripcion('active', { access_source: 'admin_override', subscription_plan: 'pro', current_period_end: enDias(2) }, { daysUntilPeriodEnd: 2 })
    const { container } = montar('/orders', <SubscriptionBanner />)
    expect(container.textContent).not.toMatch(DEUDA)
    expect(screen.queryByRole('button', { name: 'Gestionar' })).toBeNull()
  })

  it('banner: con una suscripción paga real el aviso de vencimiento se conserva', () => {
    suscripcion('active', { access_source: 'mercado_pago', mp_preapproval_id: 'pre_beta1', subscription_plan: 'pro', current_period_end: enDias(2) }, { daysUntilPeriodEnd: 2 })
    montar('/orders', <SubscriptionBanner />)
    expect(screen.getByRole('button', { name: 'Gestionar' })).toBeInTheDocument()
  })

  it('Planes: muestra planes y precios, pero ningún CTA inicia un pago', () => {
    montar('/subscription/plans')
    for (const nombre of ['Básico', 'Pro', 'Full']) {
      expect(screen.getAllByText(nombre).length).toBeGreaterThan(0)
    }
    expect(screen.getByText('25.000')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Elegir / })).toBeNull()
    expect(document.body.textContent).not.toMatch(/Pagos procesados .* Mercado Pago/)

    for (const plan of ['basico', 'pro', 'full'] as const) {
      const cta = screen.getByTestId(`plan-contact-${plan}`)
      expect(cta.tagName).toBe('A')
      expect(cta).toHaveTextContent('Contactar para activar')
      expect(cta.getAttribute('href')).toContain(`https://wa.me/${WHATSAPP_TEST}?text=`)
      clickEnlace(cta)
    }
    // El mensaje nombra el plan elegido y nada más (ni email ni negocio).
    const texto = new URL(screen.getByTestId('plan-contact-pro').getAttribute('href')!).searchParams.get('text')
    expect(texto).toBe('Hola, quiero activar el plan Pro de TechRepair Pro.')
    sinCheckout()
    expect(h.getUser).not.toHaveBeenCalled()
  })

  it('Planes: recorrer TODOS los controles de la pantalla no llega al checkout', async () => {
    montar('/subscription/plans')
    for (const boton of screen.getAllByRole('button')) {
      if (/Volver/.test(boton.textContent ?? '')) continue
      fireEvent.click(boton)
    }
    for (const enlace of screen.getAllByRole('link')) clickEnlace(enlace)
    await new Promise(r => setTimeout(r, 0))
    sinCheckout()
  })

  it.each([
    ['FeaturePaywall (full)', () => <FeaturePaywall featureName="Finanzas Pro" requiredPlan="pro" />, /Mejorar a Pro/],
    ['FeaturePaywall (compact)', () => <FeaturePaywall featureName="Reportes" requiredPlan="pro" variant="compact" />, /Mejorar a Pro/],
    ['UpgradeRequired', () => <UpgradeRequired feature="reports" />, /Ver planes/],
    ['UpgradeCard', () => <UpgradeCard feature="tasks" />, /Ver planes/],
    ['UpgradeCard (compact)', () => <UpgradeCard feature="tasks" compact />, /Actualizar/],
  ])('paywall %s: su CTA termina en Planes informativo, no en un pago', async (_nombre, paywall, cta) => {
    montar('/reports', paywall())
    fireEvent.click(screen.getByRole('button', { name: cta }))
    expect(ruta()).toBe('/subscription/plans')
    expect(screen.getAllByText('Contactar para activar')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /^Elegir / })).toBeNull()
    await new Promise(r => setTimeout(r, 0))
    sinCheckout()
  })

  it('Suscripción SIN suscripción de Mercado Pago: no ofrece acciones de pago', async () => {
    trialActivo()
    Object.assign(h.sub, { daysUntilTrialEnd: 2 })
    montar('/subscription')
    await screen.findByText('Mi Suscripción')

    expect(screen.queryByTestId('subscription-management')).toBeNull()
    for (const accion of [/Verificar pago/, /Actualizar método de pago/, /Cancelar suscripción/]) {
      expect(screen.queryByRole('button', { name: accion })).toBeNull()
    }
    expect(screen.queryByRole('button', { name: /Elegir plan|Activar plan ahora|Reactivar|Cambiar plan/ })).toBeNull()
    expect(screen.getByText(/Escribinos si necesitás más tiempo/)).toBeInTheDocument()
    expect(screen.getByTestId('subscription-help')).toHaveAttribute('href', canalSoporte().url)

    // Recorrer la pantalla entera: nada llama a mp-subscription.
    for (const boton of screen.getAllByRole('button')) {
      if (/Ver planes/.test(boton.textContent ?? '')) continue // navega; se prueba abajo
      fireEvent.click(boton)
    }
    clickEnlace(screen.getByTestId('subscription-help'))
    await new Promise(r => setTimeout(r, 0))
    sinCheckout()

    fireEvent.click(screen.getAllByRole('button', { name: 'Ver planes' })[0])
    expect(ruta()).toBe('/subscription/plans')
    sinCheckout()
  })

  it('Suscripción con el trial vencido: «Prueba finalizada», sin badge de suspensión ni deuda', async () => {
    trialVencido()
    montar('/subscription')
    await screen.findByText('Mi Suscripción')
    expect(screen.getByText('Prueba finalizada')).toBeInTheDocument()
    expect(screen.getByTestId('subscription-trial-ended')).toHaveTextContent(/Tu período de prueba terminó/)
    expect(screen.queryByText('Suspendida')).toBeNull()
    expect(document.body.textContent).not.toMatch(DEUDA)
    expect(screen.queryByTestId('subscription-management')).toBeNull()
  })

  it('Suscripción con acceso manual: no promete un «próximo cobro»', async () => {
    suscripcion('active', { access_source: 'admin_override', subscription_plan: 'pro', current_period_end: enDias(20) }, { daysUntilPeriodEnd: 20 })
    montar('/subscription')
    await screen.findByText('Mi Suscripción')
    expect(document.body.textContent).not.toMatch(/Próximo cobro/)
    expect(screen.queryByTestId('subscription-management')).toBeNull()
  })

  it('Suscripción CON una suscripción real de Mercado Pago: la administración se conserva', async () => {
    suscripcion('active', {
      access_source: 'mercado_pago', mp_preapproval_id: 'pre_beta1', subscription_plan: 'pro',
      current_period_end: enDias(20), last_payment_status: 'approved',
    }, { daysUntilPeriodEnd: 20 })
    montar('/subscription')
    await screen.findByText('Mi Suscripción')

    const admin = screen.getByTestId('subscription-management')
    expect(within(admin).getByRole('button', { name: /Verificar pago/ })).toBeInTheDocument()
    expect(within(admin).getByRole('button', { name: /Actualizar método de pago/ })).toBeInTheDocument()
    expect(within(admin).getByRole('button', { name: /Cancelar suscripción/ })).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/Próximo cobro/)
    // …pero cambiar de plan tampoco abre un checkout: va a Planes informativo.
    expect(screen.queryByRole('button', { name: 'Cambiar plan' })).toBeNull()
    sinCheckout()
  })

  it('servicio: createSubscription se niega y NO invoca la Edge Function', async () => {
    await expect(createSubscription({
      business_id: 'biz-beta1', plan: 'pro', billing_cycle: 'monthly', payer_email: 'owner@invalid.test',
    })).rejects.toThrow(BILLING_CHECKOUT_DISABLED_MESSAGE)
    sinCheckout()
    expect(h.getUser).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// El candado es un flag, no un borrado: prendido, todo vuelve a como estaba.
describe('R · reversibilidad (flag prendido)', () => {
  beforeEach(() => { h.checkout = true })

  it('Planes vuelve a ofrecer «Elegir …» y el click crea el checkout', async () => {
    montar('/subscription/plans')
    expect(screen.queryByText('Contactar para activar')).toBeNull()
    expect(document.body.textContent).toMatch(/Pagos procesados de forma segura por Mercado Pago/)

    fireEvent.click(screen.getByRole('button', { name: 'Elegir Pro' }))
    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1))
    const [fn, opciones] = h.invoke.mock.calls[0]
    expect(fn).toBe('mp-subscription')
    expect(opciones.body).toMatchObject({ action: 'create', business_id: 'biz-beta1', plan: 'pro', billing_cycle: 'monthly' })
  })

  it('el muro de fin de prueba ofrece Planes como primario y Ayuda como alternativa', () => {
    trialVencido()
    montar('/subscription/suspended')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tu período de prueba terminó')
    expect(screen.getByTestId('subscription-wall').textContent).not.toMatch(DEUDA)
    expect(screen.getByTestId('subscription-wall-help').className).toContain('btn-ghost')
    fireEvent.click(screen.getByRole('button', { name: 'Ver planes' }))
    expect(ruta()).toBe('/subscription/plans')
  })

  it('la suspensión por pago recupera «Ver planes y reactivar»', () => {
    suspendidaPorPago()
    montar('/subscription/suspended')
    expect(screen.getByRole('button', { name: 'Ver planes y reactivar' })).toBeInTheDocument()
    expect(screen.getByTestId('subscription-wall')).toHaveTextContent(/actualizá tu método de pago o elegí un nuevo plan/)
  })

  it('Suscripción recupera sus CTA y la administración de un trial', async () => {
    trialActivo()
    Object.assign(h.sub, { daysUntilTrialEnd: 2 })
    montar('/subscription')
    await screen.findByText('Mi Suscripción')
    expect(screen.getAllByRole('button', { name: 'Elegir plan' }).length).toBeGreaterThan(0)
    expect(screen.getByTestId('subscription-management')).toBeInTheDocument()
    expect(screen.queryByTestId('subscription-help')).toBeNull()
  })

  it('el banner vuelve a pedir «Elegí un plan»', () => {
    trialActivo()
    Object.assign(h.sub, { daysUntilTrialEnd: 3 })
    montar('/orders', <SubscriptionBanner />)
    expect(screen.getByText(/Elegí un plan para continuar sin interrupciones/)).toBeInTheDocument()
  })
})
