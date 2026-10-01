// ─────────────────────────────────────────────────────────────────────────────
// BETA-1 · Fin de la prueba + Planes / Mercado Pago en autoservicio.
//
//   T  el muro distingue «terminó la prueba» de «falta de pago», y su CTA
//      primario es SIEMPRE Planes; Ayuda es el secundario
//   B  Planes inicia el checkout de Mercado Pago: el click llega a la Edge
//      Function `mp-subscription` y redirige al `init_point`. Ningún flag lo
//      bloquea, ni para un trial vigente ni para uno vencido ni para una cuenta
//      cancelada
//   S  Suscripción conserva la administración (verificar / método / cancelar)
//   H  Ayuda existe, pero no es el mecanismo de activación de un plan
//
// Los mocks van en el BORDE: auth, el hook de datos de suscripción y el cliente
// de Supabase. `subscriptionService` corre DE VERDAD, así que «llegó al
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
const INIT_POINT = '#beta1-mp-checkout'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  role: 'owner' as string,
  sub: {} as Record<string, unknown>,
}))

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
const cancelada = () => suscripcion('canceled', {
  trial_ends_at: haceDias(90), mp_preapproval_id: 'pre_beta1', access_source: 'mercado_pago', subscription_plan: 'pro',
})
const suscriptorMp = () => suscripcion('active', {
  access_source: 'mercado_pago', mp_preapproval_id: 'pre_beta1', subscription_plan: 'pro',
  current_period_end: enDias(20), last_payment_status: 'approved',
}, { daysUntilPeriodEnd: 20 })

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

/** La llamada `create` que salió hacia la Edge Function, o `undefined`. */
const llamadaCreate = () => h.invoke.mock.calls.find(([, o]) => o?.body?.action === 'create')

/** Elegir un plan en Planes y esperar a que el checkout salga hacia MP. */
async function elegirPlan(nombre: 'Básico' | 'Pro' | 'Full') {
  fireEvent.click(screen.getByRole('button', { name: `Elegir ${nombre}` }))
  await waitFor(() => expect(llamadaCreate()).toBeTruthy())
  // El navegador es enviado al `init_point` que devolvió la Edge Function.
  await waitFor(() => expect(window.location.hash).toBe(INIT_POINT))
  return llamadaCreate()!
}

const DEUDA = /falta de pago|m[eé]todo de pago|verificar pago|pago vencido/i

beforeEach(() => {
  h.role = 'owner'
  h.invoke.mockReset()
  h.invoke.mockResolvedValue({ data: { init_point: INIT_POINT, preapproval_id: null }, error: null })
  h.getUser.mockReset()
  h.getUser.mockResolvedValue({ data: { user: { id: 'user-beta1' } }, error: null })
  h.signOut.mockReset()
  window.location.hash = ''
  vi.stubEnv('VITE_CONTACT_WHATSAPP', WHATSAPP_TEST)
  trialActivo()
})

afterEach(() => {
  vi.unstubAllEnvs()
  window.location.hash = ''
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

  it('ese caso NUNCA dice «falta de pago»', () => {
    trialVencido()
    montar('/subscription/suspended')
    const muro = screen.getByTestId('subscription-wall')
    expect(muro.textContent).not.toMatch(DEUDA)
    expect(muro.textContent).not.toMatch(/Cuenta suspendida|Suspendida/)
    expect(screen.queryByRole('button', { name: /reactivar|pago/i })).toBeNull()
  })

  it('el CTA primario es «Ver planes» y lleva a Planes', () => {
    trialVencido()
    montar('/subscription/suspended')
    const primario = screen.getByRole('button', { name: 'Ver planes' })
    expect(primario.className).toContain('btn-primary')
    // Es el único primario del muro: Ayuda no compite con él.
    expect(within(screen.getByTestId('subscription-wall')).getAllByRole('button').filter(b => b.className.includes('btn-primary'))).toHaveLength(1)

    fireEvent.click(primario)
    expect(ruta()).toBe('/subscription/plans')
    expect(screen.getByRole('button', { name: 'Elegir Pro' })).toBeInTheDocument()
  })

  it('un trial vencido puede pagar: muro → Planes → checkout de Mercado Pago', async () => {
    trialVencido()
    montar('/subscription/suspended')
    fireEvent.click(screen.getByRole('button', { name: 'Ver planes' }))
    const [fn, opciones] = await elegirPlan('Básico')
    expect(fn).toBe('mp-subscription')
    expect(opciones.body).toMatchObject({ action: 'create', business_id: 'biz-beta1', plan: 'basico', billing_cycle: 'monthly' })
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

  it('suspensión REAL por una suscripción paga: sí habla de falta de pago', () => {
    suspendidaPorPago()
    montar('/subscription/suspended')
    const muro = screen.getByTestId('subscription-wall')
    expect(muro).toHaveAttribute('data-wall-kind', 'billing_suspended')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Cuenta suspendida')
    expect(muro).toHaveTextContent('Tu suscripción fue suspendida por falta de pago. Para restaurar el acceso, actualizá tu método de pago o elegí un nuevo plan.')
    expect(screen.queryByText('Tu período de prueba terminó')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Ver planes y reactivar' }))
    expect(ruta()).toBe('/subscription/plans')
  })

  it('cuenta CANCELADA: puede volver a elegir plan y llegar al checkout', async () => {
    cancelada()
    montar('/subscription/suspended')
    expect(screen.getByTestId('subscription-wall')).toHaveAttribute('data-wall-kind', 'canceled')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Suscripción cancelada')

    fireEvent.click(screen.getByRole('button', { name: 'Reactivar mi cuenta' }))
    expect(ruta()).toBe('/subscription/plans')
    const [, opciones] = await elegirPlan('Full')
    expect(opciones.body).toMatchObject({ action: 'create', plan: 'full' })
  })

  it('suspendida sin billing y sin trial vencido: mensaje neutro, sin deuda inventada, con salida a Planes', () => {
    suscripcion('suspended', { trial_ends_at: enDias(5) })
    montar('/subscription/suspended')
    const muro = screen.getByTestId('subscription-wall')
    expect(muro).toHaveAttribute('data-wall-kind', 'suspended_other')
    expect(muro.textContent).not.toMatch(DEUDA)
    expect(muro.textContent).not.toMatch(/prueba terminó/)
    expect(screen.getByRole('button', { name: 'Ver planes' })).toBeInTheDocument()
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
describe('B · Planes + Mercado Pago (autoservicio)', () => {
  it('Planes muestra los tres planes con su precio y un CTA de compra cada uno', () => {
    montar('/subscription/plans')
    for (const [nombre, precio] of [['Básico', '15.000'], ['Pro', '25.000'], ['Full', '45.000']] as const) {
      expect(screen.getByText(precio)).toBeInTheDocument()
      const cta = screen.getByRole('button', { name: `Elegir ${nombre}` })
      expect(cta).toBeEnabled()
    }
    expect(document.body.textContent).toMatch(/Pagos procesados de forma segura por Mercado Pago/)
  })

  it.each([
    ['Básico', 'basico'],
    ['Pro', 'pro'],
    ['Full', 'full'],
  ] as const)('un trial puede elegir %s: el click llega a mp-subscription y redirige al checkout', async (nombre, plan) => {
    trialActivo()
    montar('/subscription/plans')
    const [fn, opciones] = await elegirPlan(nombre)

    expect(fn).toBe('mp-subscription')
    expect(opciones.body).toEqual({
      action: 'create',
      business_id: 'biz-beta1',
      plan,
      billing_cycle: 'monthly',
      payer_email: 'owner@invalid.test',
      back_url: `${window.location.origin}/subscription/pending`,
    })
    expect(h.invoke.mock.calls.filter(([, o]) => o?.body?.action === 'create')).toHaveLength(1)
  })

  it('el ciclo anual viaja en el checkout', async () => {
    montar('/subscription/plans')
    fireEvent.click(screen.getByRole('button', { name: /Anual/ }))
    const [, opciones] = await elegirPlan('Pro')
    expect(opciones.body).toMatchObject({ plan: 'pro', billing_cycle: 'annual' })
  })

  it('servicio: createSubscription llega a mp-subscription y devuelve el init_point', async () => {
    const res = await createSubscription({
      business_id: 'biz-beta1', plan: 'pro', billing_cycle: 'monthly', payer_email: 'owner@invalid.test',
    })
    expect(res.init_point).toBe(INIT_POINT)
    expect(h.invoke).toHaveBeenCalledTimes(1)
    expect(h.invoke.mock.calls[0][0]).toBe('mp-subscription')
    expect(h.invoke.mock.calls[0][1].body).toMatchObject({ action: 'create', plan: 'pro' })
  })

  it('si la Edge Function falla, Planes muestra el error y deja reintentar', async () => {
    h.invoke.mockResolvedValueOnce({ data: null, error: new Error('boom') })
    montar('/subscription/plans')
    fireEvent.click(screen.getByRole('button', { name: 'Elegir Pro' }))
    expect(await screen.findByText('Error en la función de pago.')).toBeInTheDocument()
    expect(window.location.hash).toBe('')
    expect(screen.getByRole('button', { name: 'Elegir Pro' })).toBeEnabled()
  })

  it('banner del trial: «Ver planes» lleva a Planes con el checkout disponible', () => {
    trialActivo()
    Object.assign(h.sub, { daysUntilTrialEnd: 3 })
    montar('/orders', <SubscriptionBanner />)
    expect(screen.getByText(/Elegí un plan para continuar sin interrupciones/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Ver planes' }))
    expect(ruta()).toBe('/subscription/plans')
    expect(screen.getAllByRole('button', { name: /^Elegir / })).toHaveLength(3)
  })

  it.each([
    ['FeaturePaywall (full)', () => <FeaturePaywall featureName="Finanzas Pro" requiredPlan="pro" />, /Mejorar a Pro/],
    ['FeaturePaywall (compact)', () => <FeaturePaywall featureName="Reportes" requiredPlan="pro" variant="compact" />, /Mejorar a Pro/],
    ['UpgradeRequired', () => <UpgradeRequired feature="reports" />, /Ver planes/],
    ['UpgradeCard', () => <UpgradeCard feature="tasks" />, /Ver planes/],
    ['UpgradeCard (compact)', () => <UpgradeCard feature="tasks" compact />, /Actualizar/],
  ])('paywall %s: su CTA lleva a Planes, donde se puede comprar', (_nombre, paywall, cta) => {
    montar('/reports', paywall())
    fireEvent.click(screen.getByRole('button', { name: cta }))
    expect(ruta()).toBe('/subscription/plans')
    expect(screen.getAllByRole('button', { name: /^Elegir / })).toHaveLength(3)
  })

  it('upgrade/downgrade: un suscriptor activo llega a Planes y puede cambiar de plan', async () => {
    suscriptorMp()
    montar('/subscription')
    await screen.findByText('Mi Suscripción')
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar plan' }))
    expect(ruta()).toBe('/subscription/plans')
    const [, opciones] = await elegirPlan('Full')
    expect(opciones.body).toMatchObject({ action: 'create', plan: 'full' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('S · Suscripción: administración según el flujo actual', () => {
  it('suscriptor de Mercado Pago: Verificar pago, Actualizar método y Cancelar llegan a la Edge Function', async () => {
    suscriptorMp()
    const abrir = vi.spyOn(window, 'open').mockImplementation(() => null)
    h.invoke.mockImplementation(async (_fn: string, o: { body: { action: string } }) => {
      if (o.body.action === 'update_payment_method') return { data: { init_point: 'https://example.test/mp-update' }, error: null }
      if (o.body.action === 'cancel') return { data: { success: true }, error: null }
      return { data: { activated: false, message: 'Sin novedades' }, error: null }
    })
    montar('/subscription')
    await screen.findByText('Mi Suscripción')
    expect(document.body.textContent).toMatch(/Próximo cobro/)

    const acciones = () => h.invoke.mock.calls.map(([fn, o]) => `${fn}:${o.body.action}`)

    fireEvent.click(screen.getByRole('button', { name: /Verificar pago/ }))
    await waitFor(() => expect(acciones()).toContain('mp-subscription:reconcile'))

    fireEvent.click(screen.getByRole('button', { name: /Actualizar método de pago/ }))
    await waitFor(() => expect(acciones()).toContain('mp-subscription:update_payment_method'))
    await waitFor(() => expect(abrir).toHaveBeenCalledWith('https://example.test/mp-update', '_blank'))

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar suscripción' }))
    fireEvent.click(await screen.findByRole('button', { name: /Sí, cancelar/ }))
    await waitFor(() => expect(acciones()).toContain('mp-subscription:cancel'))
  })

  it('trial: conserva «Elegir plan» y la tarjeta de administración (sin reglas nuevas)', async () => {
    trialActivo()
    Object.assign(h.sub, { daysUntilTrialEnd: 2 })
    montar('/subscription')
    await screen.findByText('Mi Suscripción')
    expect(screen.getAllByRole('button', { name: 'Elegir plan' }).length).toBeGreaterThan(0)
    expect(screen.getByText('Administrar suscripción')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Verificar pago/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Actualizar método de pago/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancelar suscripción' })).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Elegir plan' })[0])
    expect(ruta()).toBe('/subscription/plans')
  })

  it('trial vencido: «Prueba finalizada», sin badge de suspensión ni deuda, con «Elegir plan»', async () => {
    trialVencido()
    montar('/subscription')
    await screen.findByText('Mi Suscripción')
    expect(screen.getByText('Prueba finalizada')).toBeInTheDocument()
    expect(screen.getByTestId('subscription-trial-ended')).toHaveTextContent(/Tu período de prueba terminó/)
    expect(screen.queryByText('Suspendida')).toBeNull()
    expect(document.body.textContent).not.toMatch(DEUDA)
    // Nunca tuvo un plan: no «reactiva», elige.
    expect(screen.queryByRole('button', { name: 'Reactivar' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Elegir plan' }))
    expect(ruta()).toBe('/subscription/plans')
  })

  it('suspendida por pago: conserva «Suspendida» y «Reactivar»', async () => {
    suspendidaPorPago()
    montar('/subscription')
    await screen.findByText('Mi Suscripción')
    expect(screen.getByText('Suspendida')).toBeInTheDocument()
    expect(screen.queryByTestId('subscription-trial-ended')).toBeNull()
    expect(screen.getByRole('button', { name: 'Reactivar' })).toBeInTheDocument()
  })

  it('acceso otorgado a mano: no promete un «próximo cobro»', async () => {
    suscripcion('active', { access_source: 'admin_override', subscription_plan: 'pro', current_period_end: enDias(20) }, { daysUntilPeriodEnd: 20 })
    montar('/subscription')
    await screen.findByText('Mi Suscripción')
    expect(document.body.textContent).not.toMatch(/Próximo cobro/)
  })

  it('banner: un acceso manual no recibe el aviso de «método de pago»; una suscripción paga sí', () => {
    suscripcion('active', { access_source: 'admin_override', subscription_plan: 'pro', current_period_end: enDias(2) }, { daysUntilPeriodEnd: 2 })
    const manual = montar('/orders', <SubscriptionBanner />)
    expect(manual.container.textContent).not.toMatch(DEUDA)
    expect(screen.queryByRole('button', { name: 'Gestionar' })).toBeNull()
    manual.unmount()

    suscriptorMp()
    Object.assign(h.sub, { daysUntilPeriodEnd: 2 })
    montar('/orders', <SubscriptionBanner />)
    expect(screen.getByRole('button', { name: 'Gestionar' })).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('H · Ayuda no reemplaza al billing', () => {
  it('el muro ofrece «Necesito ayuda» como secundario, y lleva a /ayuda', () => {
    trialVencido()
    montar('/subscription/suspended')
    const linea = screen.getByTestId('subscription-suspended-soporte')
    const ayuda = within(linea).getByRole('link', { name: 'Necesito ayuda' })
    expect(ayuda).toHaveAttribute('href', '/ayuda')
    expect(ayuda.className).toContain('btn-ghost')
    expect(ayuda.className).not.toContain('btn-primary')

    fireEvent.click(ayuda)
    expect(ruta()).toBe('/ayuda')
    expect(screen.getByTestId('pantalla-ayuda')).toBeInTheDocument()
  })

  it('en el DOM el primario (Planes) va antes que Ayuda', () => {
    trialVencido()
    montar('/subscription/suspended')
    const planes = screen.getByRole('button', { name: 'Ver planes' })
    const ayuda = screen.getByRole('link', { name: 'Necesito ayuda' })
    expect(planes.compareDocumentPosition(ayuda) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it.each([
    ['el muro de fin de prueba', '/subscription/suspended', trialVencido],
    ['Planes', '/subscription/plans', trialActivo],
    ['Suscripción', '/subscription', trialActivo],
  ] as const)('%s no enlaza a WhatsApp ni dice «Contactar para activar»', async (_nombre, donde, preparar) => {
    preparar()
    montar(donde)
    await new Promise(r => setTimeout(r, 0))
    expect(document.querySelector('a[href*="wa.me"]')).toBeNull()
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Contactar para activar|WhatsApp/i)
  })
})
