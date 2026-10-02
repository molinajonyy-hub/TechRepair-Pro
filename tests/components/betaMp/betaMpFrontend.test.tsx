// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Fase 10 — el navegador no es autoridad de activación.
//
//   P  PaymentPending muestra «Pago confirmado» SÓLO cuando el servidor informa
//      que el checkout quedó pagado. Que el negocio esté `active` (plan anterior,
//      acceso manual) o que la URL de retorno diga «success» no alcanza.
//   S  El servicio no escribe `subscription_checkout_sessions` ni fabrica nada;
//      un error de «Verificar pago» no se convierte en «tu suscripción está activa».
//   M  Mi Suscripción muestra el motivo del servidor en pantalla, no en un alert().
//
// Mocks en el BORDE (auth, hook de datos, cliente de Supabase): el servicio corre
// de verdad, así que lo que se mide es lo que sale hacia la Edge Function.
//
// Sin matchers de jest-dom a propósito: getBy* / findBy* ya fallan si el elemento
// no está, y así el archivo corre igual en cualquier instalación de node_modules.
// ─────────────────────────────────────────────────────────────────────────────
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  getUser: vi.fn(),
  from: vi.fn(),
  refresh: vi.fn(async () => undefined),
  sub: {} as Record<string, unknown>,
}))

// Builder mínimo de PostgREST: lo usa `Subscription` para contar usuarios. El
// spy `h.from` registra CUALQUIER acceso a una tabla desde el navegador.
const chain: Record<string, unknown> = {}
for (const m of ['select', 'eq', 'order', 'limit', 'insert', 'update']) chain[m] = () => chain
chain.single = async () => ({ data: null, error: null })
chain.maybeSingle = async () => ({ data: null, error: null })
chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
  Promise.resolve({ data: [], error: null, count: 1 }).then(res, rej)

vi.mock('../../../src/lib/supabase', () => ({
  supabase: {
    from: h.from,
    rpc: async () => ({ data: null, error: null }),
    functions: { invoke: h.invoke },
    auth: { getUser: h.getUser },
  },
}))

vi.mock('../../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-beta-mp', user: { email: 'owner@invalid.test' }, role: 'owner', isOwner: true, profile: { permissions: null } }),
}))

vi.mock('../../../src/hooks/useSubscription', () => ({ useSubscription: () => h.sub }))

import { PaymentPending } from '../../../src/pages/PaymentPending'
import { Subscription } from '../../../src/pages/Subscription'
import { SubscriptionSuccess } from '../../../src/pages/SubscriptionSuccess'
import { createSubscription, getCheckoutStatus, reconcilePayment } from '../../../src/services/subscriptionService'

type Estado = 'trialing' | 'active' | 'suspended'

function suscripcion(status: Estado, fila: Record<string, unknown> = {}) {
  h.sub = {
    subscription: {
      subscription_status: status, subscription_plan: null, access_source: null, mp_preapproval_id: null,
      mp_payer_email: null, current_period_start: null, current_period_end: null, grace_until: null,
      last_payment_status: null, trial_ends_at: null, override_expires_at: null, ...fila,
    },
    payments: [], loading: false, error: null, refresh: h.refresh,
    isAllowed: status !== 'suspended', isTrial: status === 'trialing', isActive: status === 'active',
    isPastDue: false, isSuspended: status === 'suspended', isCanceled: false,
    currentPlan: (fila.subscription_plan as string) ?? null, hasFeature: () => true,
    daysUntilTrialEnd: null, daysUntilGraceEnd: null, daysUntilPeriodEnd: null,
  }
}

const checkout = (status: string, plan = 'full') =>
  ({ status, plan, billing_cycle: 'monthly', created_at: '2026-10-01T12:00:00.000Z', confirmed_at: status === 'paid' ? '2026-10-01T12:05:00.000Z' : null })

/** Lo que responde `mp-subscription:reconcile`. */
function servidorResponde(body: Record<string, unknown>) {
  h.invoke.mockImplementation(async (_fn: string, o: { body: { action: string } }) => {
    if (o.body.action === 'reconcile') return { data: body, error: null }
    return { data: {}, error: null }
  })
}

function Ruta() {
  const l = useLocation()
  return <span data-testid="ruta">{l.pathname}</span>
}

function montarPending(url = '/subscription/pending') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/subscription/pending" element={<PaymentPending />} />
        <Route path="*" element={<div data-testid="otra-pantalla" />} />
      </Routes>
      <Ruta />
    </MemoryRouter>,
  )
}

const ruta = () => screen.getByTestId('ruta').textContent
const avanzar = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const accionesEnviadas = () => h.invoke.mock.calls.map(([fn, o]) => `${fn}:${o.body.action}`)

beforeEach(() => {
  h.invoke.mockReset()
  // `restoreMocks: true` borra las implementaciones entre tests: se reponen acá.
  h.from.mockReset()
  h.from.mockImplementation(() => chain)
  h.refresh.mockReset()
  h.refresh.mockImplementation(async () => undefined)
  h.getUser.mockReset()
  h.getUser.mockResolvedValue({ data: { user: { id: 'user-beta-mp' } }, error: null })
  suscripcion('trialing', { access_source: 'trial' })
})

afterEach(() => { vi.useRealTimers() })

// ═══════════════════════════════════════════════════════════════════════════
describe('P · PaymentPending no es autoridad de activación', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('cuenta YA activa con su plan anterior + checkout sin confirmar: NO dice «Pago confirmado»', async () => {
    suscripcion('active', { subscription_plan: 'basico', access_source: 'mercado_pago', mp_preapproval_id: 'pre_viejo' })
    // El servidor: la suscripción vigente está activa, ESTE checkout sigue pendiente.
    servidorResponde({ activated: true, message: 'Tu suscripción al plan Básico está activa.', checkout: checkout('pending') })
    montarPending()
    await avanzar(1000)
    await avanzar(8000)

    expect(screen.getByTestId('payment-verifying')).not.toBeNull()
    expect(screen.queryByText('¡Pago confirmado!')).toBeNull()
    expect(ruta()).toBe('/subscription/pending')
    expect(document.body.textContent).toMatch(/seguís usando TechRepair Pro con tu acceso actual/)
  })

  it('acceso otorgado a mano + checkout sin confirmar: tampoco', async () => {
    suscripcion('active', { subscription_plan: 'pro', access_source: 'admin_override' })
    servidorResponde({ activated: false, message: 'Mercado Pago todavía no confirmó el pago.', checkout: checkout('pending') })
    montarPending()
    await avanzar(1000)
    expect(screen.queryByText('¡Pago confirmado!')).toBeNull()
    expect(ruta()).toBe('/subscription/pending')
  })

  it('los parámetros de la URL de retorno no confirman nada', async () => {
    servidorResponde({ activated: false, message: 'Mercado Pago todavía no confirmó el pago.', checkout: checkout('pending') })
    montarPending('/subscription/pending?success=true&status=approved&collection_status=approved&preapproval_id=pre_falso&plan=full')
    await avanzar(1000)
    await avanzar(8000)

    expect(screen.queryByText('¡Pago confirmado!')).toBeNull()
    expect(ruta()).toBe('/subscription/pending')
    // Y no viajan al servidor: sólo el negocio.
    for (const [, o] of h.invoke.mock.calls) expect(o.body).toEqual({ action: 'reconcile', business_id: 'biz-beta-mp' })
  })

  it('el servidor confirma ESTE checkout → «Pago confirmado» y recién ahí va a /subscription/success', async () => {
    servidorResponde({ activated: true, message: 'Mercado Pago confirmó tu suscripción al plan Full.', checkout: checkout('paid') })
    montarPending()
    await avanzar(1000)

    expect(screen.getByTestId('payment-confirmed')).not.toBeNull()
    expect(screen.getByText('¡Pago confirmado!')).not.toBeNull()
    expect(h.refresh).toHaveBeenCalled()
    await avanzar(800)
    expect(ruta()).toBe('/subscription/success')
  })

  it('primero pendiente, después pagado: confirma cuando el servidor lo dice', async () => {
    servidorResponde({ activated: false, message: 'pendiente', checkout: checkout('pending') })
    montarPending()
    await avanzar(1000)
    expect(screen.getByTestId('payment-verifying')).not.toBeNull()

    servidorResponde({ activated: true, message: 'ok', checkout: checkout('paid') })
    await avanzar(8000)
    expect(screen.getByTestId('payment-confirmed')).not.toBeNull()
  })

  it('un trial vencido que espera la confirmación no recibe la promesa de «tu acceso actual»', async () => {
    suscripcion('suspended', { trial_ends_at: '2026-09-20T00:00:00.000Z' })
    servidorResponde({ activated: false, message: 'pendiente', checkout: checkout('pending') })
    montarPending()
    await avanzar(1000)
    expect(document.body.textContent).toMatch(/Tu acceso se habilita cuando Mercado Pago confirme el pago/)
    expect(document.body.textContent).not.toMatch(/con tu acceso actual/)
  })

  it('checkout cancelado en Mercado Pago → «El pago no se completó», sin cambios y sin más polling', async () => {
    servidorResponde({ activated: false, message: 'x', checkout: checkout('canceled') })
    montarPending()
    await avanzar(1000)
    expect(screen.getByTestId('payment-not-completed')).not.toBeNull()
    expect(document.body.textContent).toMatch(/No se cambió nada en tu cuenta/)

    const llamadas = h.invoke.mock.calls.length
    await avanzar(60_000)
    expect(h.invoke.mock.calls.length).toBe(llamadas)
  })

  it('sin ningún checkout (entró por la URL) → «No hay un pago en curso»', async () => {
    servidorResponde({ activated: false, message: 'No hay ningún pago en curso para verificar.', checkout: null })
    montarPending()
    await avanzar(1000)
    expect(screen.getByTestId('payment-no-checkout')).not.toBeNull()
    expect(screen.queryByText('¡Pago confirmado!')).toBeNull()
  })

  it('pasan dos minutos sin confirmación: lo dice, ofrece verificar y Ayuda, y no activa nada', async () => {
    servidorResponde({ activated: false, message: 'Todavía no encontramos un pago confirmado en Mercado Pago.', checkout: checkout('pending') })
    montarPending()
    await avanzar(1000)
    for (let i = 0; i < 15; i++) await avanzar(8000)

    expect(screen.getByTestId('payment-unconfirmed')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Todavía no recibimos la confirmación' })).not.toBeNull()
    expect(screen.queryByText('¡Pago confirmado!')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Necesito ayuda' }))
    expect(ruta()).toBe('/ayuda')
  })

  it('un error del servicio no es «pago rechazado» ni «pago confirmado»', async () => {
    h.invoke.mockResolvedValue({ data: null, error: new Error('boom') })
    montarPending()
    await avanzar(1000)
    expect(screen.queryByText('¡Pago confirmado!')).toBeNull()
    expect(screen.queryByTestId('payment-not-completed')).toBeNull()
    expect(screen.getByTestId('payment-verifying')).not.toBeNull()
  })

  it('sólo le pide al servidor que verifique: no escribe ninguna tabla', async () => {
    servidorResponde({ activated: false, message: 'pendiente', checkout: checkout('pending') })
    montarPending()
    await avanzar(1000)
    await avanzar(8000)
    expect([...new Set(accionesEnviadas())]).toEqual(['mp-subscription:reconcile'])
    expect(h.from).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('S · servicio: el navegador propone, no registra', () => {
  it('createSubscription no escribe subscription_checkout_sessions ni ninguna otra tabla', async () => {
    h.invoke.mockResolvedValue({ data: { init_point: '#mp', preapproval_id: null }, error: null })
    const res = await createSubscription({ business_id: 'biz-beta-mp', plan: 'full', billing_cycle: 'monthly', payer_email: 'owner@invalid.test' })

    expect(res.init_point).toBe('#mp')
    expect(h.from).not.toHaveBeenCalled()
    expect(h.invoke).toHaveBeenCalledTimes(1)
  })

  it('getCheckoutStatus lee el estado por la Edge Function (`status`), no por la tabla', async () => {
    h.invoke.mockResolvedValue({ data: { source: 'database', checkout: checkout('pending') }, error: null })
    const estado = await getCheckoutStatus('biz-beta-mp')
    expect(estado).toMatchObject({ status: 'pending', plan: 'full' })
    expect(accionesEnviadas()).toEqual(['mp-subscription:status'])
    expect(h.from).not.toHaveBeenCalled()
  })

  it('reconcilePayment devuelve lo que decidió el servidor', async () => {
    servidorResponde({ activated: true, message: 'ok', checkout: checkout('paid') })
    await expect(reconcilePayment('biz-beta-mp')).resolves.toEqual({ activated: true, message: 'ok', checkout: checkout('paid') })
  })

  it('`activated` exige un true literal del servidor', async () => {
    for (const valor of [undefined, null, 'true', 1, {}]) {
      servidorResponde({ activated: valor, message: 'x' })
      expect((await reconcilePayment('biz-beta-mp')).activated).toBe(false)
    }
  })

  it('si la verificación falla, el error sube: no se reemplaza por una lectura local que diga «activa»', async () => {
    suscripcion('active', { subscription_plan: 'basico' })
    h.invoke.mockResolvedValue({ data: null, error: new Error('boom') })
    await expect(reconcilePayment('biz-beta-mp')).rejects.toThrow()
    expect(h.from).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('M · Mi Suscripción y la pantalla de éxito', () => {
  const montar = (el: JSX.Element) => render(<MemoryRouter>{el}</MemoryRouter>)

  it('cancelar sin suscripción de MP: el motivo del servidor aparece en pantalla, sin alert()', async () => {
    const alerta = vi.spyOn(window, 'alert').mockImplementation(() => undefined)
    const { FunctionsHttpError } = await import('@supabase/supabase-js')
    const respuesta = new Response(JSON.stringify({ error: 'Este negocio no tiene una suscripción de Mercado Pago para cancelar.', code: 'no_subscription' }), { status: 409 })
    h.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(respuesta) })
    montar(<Subscription />)

    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar suscripción' }))
    fireEvent.click(await screen.findByRole('button', { name: /Sí, cancelar/ }))

    expect((await screen.findByTestId('subscription-manage-error')).textContent).toContain('no tiene una suscripción de Mercado Pago para cancelar')
    expect(alerta).not.toHaveBeenCalled()
  })

  it('«Verificar pago» muestra el mensaje del servidor', async () => {
    suscripcion('active', { subscription_plan: 'pro', access_source: 'mercado_pago', mp_preapproval_id: 'pre_1' })
    servidorResponde({ activated: true, message: 'Tu suscripción al plan Pro está activa.', checkout: checkout('paid', 'pro') })
    montar(<Subscription />)
    fireEvent.click(await screen.findByRole('button', { name: /Verificar pago/ }))
    expect(await screen.findByText('Tu suscripción al plan Pro está activa.')).not.toBeNull()
  })

  it('SubscriptionSuccess: una cuenta activa por un acceso manual no ve «Suscripción activada»', () => {
    suscripcion('active', { subscription_plan: 'pro', access_source: 'admin_override' })
    montar(<SubscriptionSuccess />)
    expect(screen.queryByText('Suscripción activada')).toBeNull()
    expect(screen.getByText('Estamos confirmando tu pago')).not.toBeNull()
  })

  it('SubscriptionSuccess: con una suscripción de Mercado Pago activa, sí', () => {
    suscripcion('active', { subscription_plan: 'pro', access_source: 'mercado_pago', mp_preapproval_id: 'pre_1' })
    montar(<SubscriptionSuccess />)
    expect(screen.getByText('Suscripción activada')).not.toBeNull()
  })
})
