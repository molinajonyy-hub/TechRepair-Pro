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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { Plans } from '../../../src/pages/Plans'
import { Subscription } from '../../../src/pages/Subscription'
import { SubscriptionSuccess } from '../../../src/pages/SubscriptionSuccess'
import {
  MP_PAYER_EMAIL_REQUIRED, SubscriptionActionError, createSubscription, getCheckoutStatus, reconcilePayment, subscriptionErrorCode,
} from '../../../src/services/subscriptionService'

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
    h.invoke.mockResolvedValue({ data: { init_point: '#mp', checkout: { status: 'pending', plan: 'full', billing_cycle: 'monthly' } }, error: null })
    const res = await createSubscription({ business_id: 'biz-beta-mp', plan: 'full', billing_cycle: 'monthly' })

    expect(res.init_point).toBe('#mp')
    expect(h.from).not.toHaveBeenCalled()
    expect(h.invoke).toHaveBeenCalledTimes(1)
  })

  it('createSubscription sólo propone negocio, plan y ciclo: ni email, ni importe, ni referencia, ni preapproval', async () => {
    h.invoke.mockResolvedValue({ data: { init_point: '#mp' }, error: null })
    await createSubscription({ business_id: 'biz-beta-mp', plan: 'pro', billing_cycle: 'annual' })

    const enviado = h.invoke.mock.calls[0][1].body as Record<string, unknown>
    expect(Object.keys(enviado).sort()).toEqual(['action', 'back_url', 'billing_cycle', 'business_id', 'plan'])
    expect(enviado).toMatchObject({ action: 'create', plan: 'pro', billing_cycle: 'annual' })
  })

  it('un error del servidor conserva su `code`: la pantalla decide qué mostrar por el código, no por el texto', async () => {
    const { FunctionsHttpError } = await import('@supabase/supabase-js')
    h.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response(JSON.stringify({ error: 'Mensaje', code: 'mp_payer_email_required' }), { status: 422 })) })
    const fallo = await createSubscription({ business_id: 'biz-beta-mp', plan: 'pro', billing_cycle: 'monthly' }).catch((e: unknown) => e)

    expect(fallo).toBeInstanceOf(SubscriptionActionError)
    expect(fallo).toMatchObject({ message: 'Mensaje', code: 'mp_payer_email_required', status: 422 })
    expect(subscriptionErrorCode(fallo)).toBe(MP_PAYER_EMAIL_REQUIRED)
    expect(subscriptionErrorCode(new Error('mp_payer_email_required'))).toBeNull()
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
// Evidencia real (2026-10-02): `POST /preapproval` con el email del login dio
// 400 «User bad request»; con el email real de una cuenta de Mercado Pago, 201.
// Planes NO le pide el email a todos: primero intenta con el del login (el
// servidor lo toma del JWT) y sólo si Mercado Pago lo rechaza pide el otro.
describe('E · Planes: el email de Mercado Pago se pide sólo si hace falta', () => {
  const CHECKOUT = '#checkout-mercado-pago'
  const ETIQUETA = 'Email de tu cuenta de Mercado Pago'
  const TITULO = 'Necesitamos un dato de Mercado Pago'
  const REQUERIDO = { error: 'Mercado Pago no pudo iniciar la suscripción con el email de tu cuenta de TechRepair Pro.', code: 'mp_payer_email_required' }
  const RECHAZADO = { error: 'Mercado Pago tampoco pudo iniciar la suscripción con ese email.', code: 'mp_payer_email_rejected' }

  const montarPlanes = () => render(<MemoryRouter><Plans /></MemoryRouter>)
  const creates = () => h.invoke.mock.calls.filter(([, o]) => o.body.action === 'create').map(([, o]) => o.body as Record<string, unknown>)
  const elegir = (plan: string) => fireEvent.click(screen.getByRole('button', { name: `Elegir ${plan}` }))
  const campo = () => screen.getByLabelText(ETIQUETA) as HTMLInputElement
  const continuar = () => fireEvent.click(screen.getByRole('button', { name: 'Continuar con Mercado Pago' }))
  const escribir = (valor: string) => fireEvent.change(campo(), { target: { value: valor } })

  /** El servidor: responde a cada `create` según el `mp_payer_email` que reciba. */
  function servidor(responder: (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }) {
    h.invoke.mockImplementation(async (_fn: string, o: { body: Record<string, unknown> }) => {
      const { status, body } = responder(o.body)
      if (status === 200) return { data: body, error: null }
      const { FunctionsHttpError } = await import('@supabase/supabase-js')
      return { data: null, error: new FunctionsHttpError(new Response(JSON.stringify(body), { status })) }
    })
  }
  /** Mercado Pago sólo acepta `cuenta@mp.invalid`: el email del login no sirve. */
  const soloAceptaLaCuentaDeMp = () => servidor((body) => {
    if (body.mp_payer_email === undefined) return { status: 422, body: REQUERIDO }
    if (body.mp_payer_email === 'cuenta@mp.invalid') return { status: 200, body: { init_point: CHECKOUT } }
    return { status: 422, body: RECHAZADO }
  })

  beforeEach(() => { window.location.hash = '' })
  afterEach(() => { window.location.hash = '' })

  it('flujo normal: «Elegir» va directo al checkout y no aparece ningún campo de email', async () => {
    servidor(() => ({ status: 200, body: { init_point: CHECKOUT } }))
    montarPlanes()
    expect(screen.queryByLabelText(ETIQUETA)).toBeNull()
    elegir('Pro')
    await waitFor(() => expect(window.location.hash).toBe(CHECKOUT))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByLabelText(ETIQUETA)).toBeNull()
    // El navegador sólo propone negocio, plan y ciclo: ni el email del login.
    expect(creates()).toEqual([{
      action: 'create', business_id: 'biz-beta-mp', plan: 'pro', billing_cycle: 'monthly',
      back_url: `${window.location.origin}/subscription/pending`,
    }])
  })

  it('Mercado Pago no acepta el email del login → recién ahí pide el email, con un solo campo', async () => {
    soloAceptaLaCuentaDeMp()
    montarPlanes()
    elegir('Pro')

    const dialogo = await screen.findByRole('dialog')
    expect(dialogo.textContent).toContain(TITULO)
    expect(dialogo.textContent).toContain('Mercado Pago no pudo iniciar la suscripción con el email de tu cuenta de TechRepair Pro.')
    expect(dialogo.textContent).toContain('Ingresá el email asociado a tu cuenta de Mercado Pago.')
    expect(dialogo.querySelectorAll('input')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Continuar con Mercado Pago' })).not.toBeNull()
    // No abrió ningún checkout.
    expect(window.location.hash).toBe('')
    expect(creates()).toHaveLength(1)
  })

  it('no precarga ni muestra el email del login como si fuera el de Mercado Pago', async () => {
    soloAceptaLaCuentaDeMp()
    montarPlanes()
    elegir('Pro')
    const dialogo = await screen.findByRole('dialog')
    expect(campo().value).toBe('')
    expect(dialogo.textContent).not.toContain('owner@invalid.test')
  })

  it('reintento con el email de la cuenta de Mercado Pago → va al checkout', async () => {
    soloAceptaLaCuentaDeMp()
    montarPlanes()
    elegir('Full')
    await screen.findByRole('dialog')
    escribir('  cuenta@mp.invalid ')
    continuar()
    await waitFor(() => expect(window.location.hash).toBe(CHECKOUT))

    expect(creates()).toHaveLength(2)
    expect(creates()[0].mp_payer_email).toBeUndefined()
    expect(creates()[1]).toMatchObject({ action: 'create', plan: 'full', billing_cycle: 'monthly', mp_payer_email: 'cuenta@mp.invalid' })
    // El reintento manda SÓLO eso de más: ni importe, ni referencia, ni estado.
    expect(Object.keys(creates()[1]).sort()).toEqual(['action', 'back_url', 'billing_cycle', 'business_id', 'mp_payer_email', 'plan'])
  })

  it.each([
    ['vacío', '', 'Ingresá el email de tu cuenta de Mercado Pago.'],
    ['sólo espacios', '   ', 'Ingresá el email de tu cuenta de Mercado Pago.'],
    ['sin arroba', 'cuenta.mp.invalid', 'Revisá el email: no tiene un formato válido.'],
    ['sin dominio', 'cuenta@', 'Revisá el email: no tiene un formato válido.'],
    ['con espacios en el medio', 'cuen ta@mp.invalid', 'Revisá el email: no tiene un formato válido.'],
  ])('email %s: lo dice en el campo y NO llama al servidor', async (_caso, valor, mensaje) => {
    soloAceptaLaCuentaDeMp()
    montarPlanes()
    elegir('Pro')
    await screen.findByRole('dialog')
    escribir(valor)
    continuar()

    expect((await screen.findByText(mensaje)).className).toContain('form-error')
    expect(campo().getAttribute('aria-invalid')).toBe('true')
    expect(creates()).toHaveLength(1)
    expect(window.location.hash).toBe('')
  })

  it('segundo fallo: muestra el error del servidor y NO reintenta solo', async () => {
    soloAceptaLaCuentaDeMp()
    montarPlanes()
    elegir('Pro')
    await screen.findByRole('dialog')
    escribir('otra@mp.invalid')
    continuar()

    expect(await screen.findByText(RECHAZADO.error)).not.toBeNull()
    // Sigue abierto, con lo que escribió, y sin checkout.
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(campo().value).toBe('otra@mp.invalid')
    expect(window.location.hash).toBe('')
    // Ni un intento más sin que el usuario lo pida.
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    expect(creates()).toHaveLength(2)
    expect(creates().map((c) => c.mp_payer_email)).toEqual([undefined, 'otra@mp.invalid'])
  })

  it('después de un segundo fallo puede corregir el email: el error se va al editar y el nuevo intento es SUYO', async () => {
    soloAceptaLaCuentaDeMp()
    montarPlanes()
    elegir('Pro')
    await screen.findByRole('dialog')
    escribir('otra@mp.invalid')
    continuar()
    await screen.findByText(RECHAZADO.error)

    escribir('cuenta@mp.invalid')
    expect(screen.queryByText(RECHAZADO.error)).toBeNull()
    continuar()
    await waitFor(() => expect(window.location.hash).toBe(CHECKOUT))
    expect(creates().map((c) => c.mp_payer_email)).toEqual([undefined, 'otra@mp.invalid', 'cuenta@mp.invalid'])
  })

  it('un error que NO es del email (Mercado Pago caído) no abre el pedido: se muestra el error de siempre', async () => {
    servidor(() => ({ status: 502, body: { error: 'No pudimos consultar a Mercado Pago. Probá de nuevo en unos minutos.', code: 'mp_unavailable' } }))
    montarPlanes()
    elegir('Pro')

    expect(await screen.findByText('No pudimos consultar a Mercado Pago. Probá de nuevo en unos minutos.')).not.toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByLabelText(ETIQUETA)).toBeNull()
  })

  it.each([
    ['otro código con el mismo status', { status: 422, body: { error: 'x', code: 'otra_cosa' } }],
    ['sin código', { status: 422, body: { error: 'x' } }],
    ['el texto parecido sin el código', { status: 400, body: { error: REQUERIDO.error } }],
  ])('%s → tampoco abre el pedido', async (_caso, respuesta) => {
    servidor(() => respuesta)
    montarPlanes()
    elegir('Pro')
    await waitFor(() => expect(creates()).toHaveLength(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('es fácil de cerrar: «Cancelar» lo cierra, no crea nada y deja volver a elegir', async () => {
    soloAceptaLaCuentaDeMp()
    montarPlanes()
    elegir('Pro')
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(creates()).toHaveLength(1)
    expect((screen.getByRole('button', { name: 'Elegir Pro' }) as HTMLButtonElement).disabled).toBe(false)
    // «Cerrar» (la X) y Escape hacen lo mismo.
    elegir('Pro')
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    elegir('Pro')
    await screen.findByRole('dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('no vuelve a pedirlo en la misma visita: el siguiente plan manda el email que ya funcionó', async () => {
    soloAceptaLaCuentaDeMp()
    montarPlanes()
    elegir('Pro')
    await screen.findByRole('dialog')
    escribir('cuenta@mp.invalid')
    continuar()
    await waitFor(() => expect(window.location.hash).toBe(CHECKOUT))

    // (jsdom no navega) El usuario elige otro plan en la misma pantalla.
    window.location.hash = ''
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Elegir Básico' }) as HTMLButtonElement).disabled).toBe(false))
    elegir('Básico')
    await waitFor(() => expect(window.location.hash).toBe(CHECKOUT))
    expect(creates().at(-1)).toMatchObject({ plan: 'basico', mp_payer_email: 'cuenta@mp.invalid' })
    expect(creates()).toHaveLength(3)
  })

  it('el email vive sólo en la pantalla: no se guarda en el navegador', async () => {
    soloAceptaLaCuentaDeMp()
    montarPlanes()
    elegir('Pro')
    await screen.findByRole('dialog')
    escribir('cuenta@mp.invalid')
    continuar()
    await waitFor(() => expect(window.location.hash).toBe(CHECKOUT))

    const guardado = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage }) + document.cookie
    expect(guardado).not.toContain('cuenta@mp.invalid')
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
