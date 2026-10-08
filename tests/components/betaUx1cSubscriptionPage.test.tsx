// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1C · B — «Mi Suscripción» por estado: lo que no entra en BETA-MP.
//
// `betaMp/betaMpFrontend.test.tsx` cubre el contrato con Mercado Pago (trial,
// pago iniciado, activa, acceso manual). Acá va el resto de la matriz y los
// bordes de la pantalla:
//
//   · pago vencido: la primaria es «Actualizar método de pago»;
//   · «Continuar pago» cuando Mercado Pago pide el email, cuando el pago ya se
//     registró y cuando el servidor falla;
//   · una acción que el estado no ofrece no llega a la Edge Function aunque
//     alguien dispare su handler;
//   · bloqueadas: la pantalla sigue como la dejó BETA-1;
//   · el CSS de la tarjeta de estado (P1-4) y las superficies con tokens.
//
// Mocks en el BORDE (auth, hook de datos, cliente de Supabase): el servicio y el
// resolver de presentación corren de verdad.
// ─────────────────────────────────────────────────────────────────────────────
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  getUser: vi.fn(),
  from: vi.fn(),
  refresh: vi.fn(async () => undefined),
  sub: {} as Record<string, unknown>,
}))

const chain: Record<string, unknown> = {}
for (const m of ['select', 'eq', 'order', 'limit', 'insert', 'update']) chain[m] = () => chain
chain.single = async () => ({ data: null, error: null })
chain.maybeSingle = async () => ({ data: null, error: null })
chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
  Promise.resolve({ data: [], error: null, count: 2 }).then(res, rej)

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: h.from,
    rpc: async () => ({ data: null, error: null }),
    functions: { invoke: h.invoke },
    auth: { getUser: h.getUser },
  },
}))

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1c', user: { email: 'owner@invalid.test' }, role: 'owner', isOwner: true, profile: { permissions: null } }),
}))

vi.mock('../../src/hooks/useSubscription', () => ({ useSubscription: () => h.sub }))

import { Subscription } from '../../src/pages/Subscription'

type Estado = 'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled' | 'pending_activation'

function suscripcion(status: Estado, fila: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  h.sub = {
    subscription: {
      subscription_status: status, subscription_plan: 'pro', access_source: null, mp_preapproval_id: null,
      mp_payer_email: null, current_period_start: null, current_period_end: null, grace_until: null,
      last_payment_status: null, trial_ends_at: null, override_expires_at: null, ...fila,
    },
    payments: [], loading: false, error: null, refresh: h.refresh,
    isAllowed: ['trialing', 'active', 'past_due'].includes(status),
    isTrial: status === 'trialing', isActive: status === 'active', isPastDue: status === 'past_due',
    isSuspended: status === 'suspended', isCanceled: status === 'canceled',
    currentPlan: 'pro', hasFeature: () => true,
    daysUntilTrialEnd: null, daysUntilGraceEnd: null, daysUntilPeriodEnd: null,
    ...extra,
  }
}

const pendiente = (plan = 'pro', ciclo = 'monthly') =>
  ({ status: 'pending', plan, billing_cycle: ciclo, created_at: '2026-10-07T12:00:00.000Z', confirmed_at: null })

type Respuesta = { status: number; body: Record<string, unknown> }

/** El servidor: `status` informa el último checkout; el resto lo decide `responder`. */
function servidor(ultimoCheckout: Record<string, unknown> | null, responder: (body: Record<string, unknown>) => Respuesta = () => ({ status: 200, body: {} })) {
  h.invoke.mockImplementation(async (_fn: string, o: { body: Record<string, unknown> }) => {
    if (o.body.action === 'status') return { data: { source: 'database', checkout: ultimoCheckout }, error: null }
    const { status, body } = responder(o.body)
    if (status === 200) return { data: body, error: null }
    const { FunctionsHttpError } = await import('@supabase/supabase-js')
    return { data: null, error: new FunctionsHttpError(new Response(JSON.stringify(body), { status })) }
  })
}

function Ruta() {
  return <span data-testid="ruta">{useLocation().pathname}</span>
}
const montar = () => render(<MemoryRouter><Subscription /><Ruta /></MemoryRouter>)
const tarjeta = () => screen.getByTestId('subscription-status-card')
const acciones = () => h.invoke.mock.calls.map(([, o]) => o.body.action as string)
const cuerpos = (accion: string) => h.invoke.mock.calls.filter(([, o]) => o.body.action === accion).map(([, o]) => o.body as Record<string, unknown>)
const boton = (nombre: RegExp | string) => screen.queryByRole('button', { name: nombre })

async function presentacion(estado: string) {
  if (estado.startsWith('trial')) await waitFor(() => expect(acciones()).toContain('status'))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  await waitFor(() => expect(tarjeta().getAttribute('data-presentation')).toBe(estado))
}

beforeEach(() => {
  h.invoke.mockReset()
  h.from.mockReset()
  h.from.mockImplementation(() => chain)
  h.refresh.mockReset()
  h.refresh.mockImplementation(async () => undefined)
  h.getUser.mockReset()
  h.getUser.mockResolvedValue({ data: { user: { id: 'user-1c' } }, error: null })
  window.location.hash = ''
  suscripcion('trialing', { access_source: 'trial' })
  servidor(null)
})

// ═══════════════════════════════════════════════════════════════════════════
describe('pago vencido', () => {
  const enMora = (gracia: number | null = 2) => suscripcion('past_due', {
    access_source: 'mercado_pago', mp_preapproval_id: 'pre_1', last_payment_status: 'rejected',
    grace_until: '2026-10-10T12:00:00.000Z',
  }, { daysUntilGraceEnd: gracia })

  it('la acción primaria es «Actualizar método de pago»; «Verificar pago» y «Cambiar plan» son secundarias', async () => {
    enMora()
    montar()
    await presentacion('past_due')

    const zona = within(screen.getByTestId('subscription-status-actions'))
    const botones = zona.getAllByRole('button')
    expect(botones.map(b => (b.textContent ?? '').trim())).toEqual(['Actualizar método de pago', 'Verificar pago', 'Cambiar plan'])
    expect(botones[0].className).toContain('btn-primary')
    expect(botones.slice(1).every(b => !b.className.includes('btn-primary'))).toBe(true)
    // Una sola primaria en toda la pantalla de estado.
    expect(tarjeta().querySelectorAll('.btn-primary')).toHaveLength(1)
  })

  it('explica el pago pendiente y los días de gracia', async () => {
    enMora(2)
    montar()
    await presentacion('past_due')
    const texto = screen.getByTestId('subscription-past-due').textContent ?? ''
    expect(texto).toContain('Tenemos un pago pendiente de tu suscripción.')
    expect(texto).toContain('Tu acceso sigue activo durante el período de gracia: quedan 2 días para regularizarlo.')
    expect(screen.getByTestId('subscription-status-badge').textContent).toBe('Pago vencido')
    expect(document.body.textContent).not.toMatch(/Próximo cobro/)
  })

  it('con 1 día de gracia habla en singular; sin días conocidos no inventa una cuenta', async () => {
    enMora(1)
    const uno = montar()
    await presentacion('past_due')
    expect(screen.getByTestId('subscription-past-due').textContent).toContain('queda 1 día para regularizarlo')
    uno.unmount()

    enMora(null)
    montar()
    await presentacion('past_due')
    expect(screen.getByTestId('subscription-past-due').textContent).toContain('Tu acceso está en período de gracia: regularizalo para no perderlo.')
    expect(screen.getByTestId('subscription-past-due').textContent).not.toMatch(/\d/)
  })

  it('«Actualizar método de pago» abre el enlace que devuelve el servidor', async () => {
    enMora()
    servidor(null, body => body.action === 'update_payment_method'
      ? { status: 200, body: { init_point: 'https://example.test/mp-update' } }
      : { status: 200, body: {} })
    const abrir = vi.spyOn(window, 'open').mockImplementation(() => null)
    montar()
    await presentacion('past_due')

    fireEvent.click(boton(/Actualizar método de pago/)!)
    await waitFor(() => expect(abrir).toHaveBeenCalledWith('https://example.test/mp-update', '_blank'))
    expect(cuerpos('update_payment_method')).toEqual([{ action: 'update_payment_method', business_id: 'biz-1c' }])
  })

  it('si el servidor no puede dar el enlace, el motivo aparece junto al botón', async () => {
    enMora()
    servidor(null, () => ({ status: 409, body: { error: 'La suscripción está cancelada. Elegí un plan para reactivarla.', code: 'subscription_cancelled' } }))
    montar()
    await presentacion('past_due')

    fireEvent.click(boton(/Actualizar método de pago/)!)
    const error = await screen.findByTestId('subscription-manage-error')
    expect(error.textContent).toContain('La suscripción está cancelada.')
    // Junto a la acción que lo causó: dentro de la tarjeta de estado.
    expect(tarjeta().contains(error)).toBe(true)
  })

  it('cancelar sigue disponible: es una suscripción de Mercado Pago real', async () => {
    enMora()
    montar()
    await presentacion('past_due')
    expect(within(screen.getByTestId('subscription-manage-card')).getByRole('button', { name: 'Cancelar suscripción' })).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('«Continuar pago»: los caminos que no terminan en el checkout', () => {
  const ETIQUETA = 'Email de tu cuenta de Mercado Pago'
  const REQUERIDO = { error: 'Mercado Pago no pudo iniciar la suscripción con el email de tu cuenta de TechRepair Pro.', code: 'mp_payer_email_required' }

  it('Mercado Pago pide el email → mismo diálogo que Planes; el reintento manda SÓLO el email de más', async () => {
    // El checkout se había abierto con otro email: sin él, el servidor lo pide.
    let pendienteEnServidor: Record<string, unknown> | null = pendiente('full', 'annual')
    h.invoke.mockImplementation(async (_fn: string, o: { body: Record<string, unknown> }) => {
      if (o.body.action === 'status') return { data: { checkout: pendienteEnServidor }, error: null }
      if (o.body.mp_payer_email === 'cuenta@mp.invalid') return { data: { init_point: '#checkout-con-email' }, error: null }
      pendienteEnServidor = { ...pendiente('full', 'annual'), status: 'expired' }
      const { FunctionsHttpError } = await import('@supabase/supabase-js')
      return { data: null, error: new FunctionsHttpError(new Response(JSON.stringify(REQUERIDO), { status: 422 })) }
    })
    montar()
    await presentacion('trial_pending_checkout')

    fireEvent.click(boton(/Continuar pago/)!)
    const dialogo = await screen.findByRole('dialog')
    expect(dialogo.textContent).toContain('Necesitamos un dato de Mercado Pago')
    expect(dialogo.textContent).toContain('Plan Full')
    expect((screen.getByLabelText(ETIQUETA) as HTMLInputElement).value).toBe('')
    expect(window.location.hash).toBe('')

    fireEvent.change(screen.getByLabelText(ETIQUETA), { target: { value: ' cuenta@mp.invalid ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continuar con Mercado Pago' }))
    await waitFor(() => expect(window.location.hash).toBe('#checkout-con-email'))

    const creates = cuerpos('create')
    expect(creates).toHaveLength(2)
    expect(creates[0].mp_payer_email).toBeUndefined()
    // El plan y el ciclo siguen siendo los del checkout que informó el servidor.
    expect(creates[1]).toEqual({
      action: 'create', business_id: 'biz-1c', plan: 'full', billing_cycle: 'annual',
      mp_payer_email: 'cuenta@mp.invalid', back_url: `${window.location.origin}/subscription/pending`,
    })
  })

  it('cerrar el diálogo no crea nada y vuelve a leer el checkout: si el servidor lo cerró, queda el trial', async () => {
    let pendienteEnServidor: Record<string, unknown> | null = pendiente()
    h.invoke.mockImplementation(async (_fn: string, o: { body: Record<string, unknown> }) => {
      if (o.body.action === 'status') return { data: { checkout: pendienteEnServidor }, error: null }
      pendienteEnServidor = { ...pendiente(), status: 'expired' }
      const { FunctionsHttpError } = await import('@supabase/supabase-js')
      return { data: null, error: new FunctionsHttpError(new Response(JSON.stringify(REQUERIDO), { status: 422 })) }
    })
    montar()
    await presentacion('trial_pending_checkout')

    fireEvent.click(boton(/Continuar pago/)!)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(tarjeta().getAttribute('data-presentation')).toBe('trial'))
    expect(cuerpos('create')).toHaveLength(1)
    expect(acciones().filter(a => a === 'status')).toHaveLength(2)
    expect(boton('Elegir plan')).not.toBeNull()
    expect(window.location.hash).toBe('')
  })

  it('el email tampoco sirve → el motivo queda en el diálogo y NO se reintenta solo', async () => {
    servidor(pendiente(), body => body.mp_payer_email === undefined
      ? { status: 422, body: REQUERIDO }
      : { status: 422, body: { error: 'Mercado Pago tampoco pudo iniciar la suscripción con ese email.', code: 'mp_payer_email_rejected' } })
    montar()
    await presentacion('trial_pending_checkout')

    fireEvent.click(boton(/Continuar pago/)!)
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText(ETIQUETA), { target: { value: 'otra@mp.invalid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continuar con Mercado Pago' }))

    expect(await screen.findByText('Mercado Pago tampoco pudo iniciar la suscripción con ese email.')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await act(async () => { await new Promise(r => setTimeout(r, 40)) })
    expect(cuerpos('create')).toHaveLength(2)
    expect(window.location.hash).toBe('')
  })

  it('el pago ya se registró en Mercado Pago → muestra el mensaje del servidor, que manda a «Verificar pago»', async () => {
    servidor(pendiente(), body => body.action === 'create'
      ? { status: 409, body: { error: 'Mercado Pago ya registró el pago de este plan. Tocá «Verificar pago» en Mi Suscripción para activarlo.', code: 'checkout_already_paid' } }
      : { status: 200, body: {} })
    montar()
    await presentacion('trial_pending_checkout')

    fireEvent.click(boton(/Continuar pago/)!)
    const error = await screen.findByTestId('subscription-manage-error')
    expect(error.textContent).toContain('Mercado Pago ya registró el pago de este plan.')
    expect(tarjeta().contains(error)).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(window.location.hash).toBe('')
    // No se dio nada por activado: sigue en prueba, con «Verificar pago» a mano.
    expect(boton(/Verificar pago/)).not.toBeNull()
    expect(document.body.textContent).not.toMatch(/Suscripción activada|Pago confirmado/)
  })

  it('Mercado Pago caído → error en pantalla, sin diálogo, y el botón vuelve a quedar disponible', async () => {
    servidor(pendiente(), body => body.action === 'create'
      ? { status: 502, body: { error: 'No pudimos consultar a Mercado Pago. Probá de nuevo en unos minutos.', code: 'mp_unavailable' } }
      : { status: 200, body: {} })
    montar()
    await presentacion('trial_pending_checkout')

    fireEvent.click(boton(/Continuar pago/)!)
    expect((await screen.findByTestId('subscription-manage-error')).textContent).toContain('No pudimos consultar a Mercado Pago.')
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect((boton(/Continuar pago/) as HTMLButtonElement).disabled).toBe(false))
  })

  it('un doble toque no abre dos checkouts', async () => {
    let soltar: (v: unknown) => void = () => undefined
    h.invoke.mockImplementation(async (_fn: string, o: { body: Record<string, unknown> }) => {
      if (o.body.action === 'status') return { data: { checkout: pendiente() }, error: null }
      await new Promise(r => { soltar = r })
      return { data: { init_point: '#checkout-unico' }, error: null }
    })
    montar()
    await presentacion('trial_pending_checkout')

    const continuar = boton(/Continuar pago/) as HTMLButtonElement
    fireEvent.click(continuar)
    await waitFor(() => expect(continuar.disabled).toBe(true))
    fireEvent.click(continuar)
    soltar(null)
    await waitFor(() => expect(window.location.hash).toBe('#checkout-unico'))
    expect(cuerpos('create')).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('una acción que el estado no ofrece no llega al servidor', () => {
  it('ningún estado sin suscripción de MP expone un control de «cancel» ni «update_payment_method»', async () => {
    const sinVinculo: Array<[string, () => void]> = [
      ['trial', () => suscripcion('trialing', { access_source: 'trial' })],
      ['manual_access', () => suscripcion('active', { access_source: 'admin_override' })],
      ['manual_access', () => suscripcion('active', { access_source: 'manual_grandfathered' })],
      ['active_unlinked', () => suscripcion('active', { access_source: null })],
      ['blocked', () => suscripcion('suspended', { trial_ends_at: '2026-01-01T00:00:00.000Z' })],
      ['blocked', () => suscripcion('canceled')],
      ['blocked', () => suscripcion('pending_activation')],
    ]
    for (const [estado, preparar] of sinVinculo) {
      preparar()
      const vista = montar()
      await presentacion(estado)
      for (const id of ['cancel_subscription', 'update_payment_method', 'verify_payment', 'continue_checkout']) {
        expect(screen.queryByTestId(`subscription-action-${id}`), `${estado} · ${id}`).toBeNull()
      }
      expect(screen.queryByTestId('subscription-manage-card'), estado).toBeNull()
      vista.unmount()
    }
    expect(acciones().filter(a => a !== 'status')).toEqual([])
  })

  it('los handlers de Mercado Pago verifican el estado antes de llamar al servicio', () => {
    const src = readFileSync('src/pages/Subscription.tsx', 'utf8')
    // Cada handler corta si la presentación no ofrece su acción: un control que
    // quedara montado por error tampoco podría disparar la llamada.
    expect(src).toMatch(/async function handleCancel\(\) \{\s*if \(!businessId \|\| !offers\('cancel_subscription'\)\) return/)
    expect(src).toMatch(/async function handleReconcile\(zone: Zone\) \{\s*if \(!businessId \|\| !offers\('verify_payment'\)\) return/)
    expect(src).toMatch(/async function handleUpdatePayment\(zone: Zone\) \{\s*if \(!businessId \|\| !offers\('update_payment_method'\)\) return/)
    expect(src).toMatch(/function handleContinueCheckout\(\) \{\s*if \(!offers\('continue_checkout'\) \|\| !checkout\) return/)
  })

  it('la pantalla no decide acciones con flags sueltos: las ofrece el resolver', () => {
    const src = readFileSync('src/pages/Subscription.tsx', 'utf8')
    expect(src).toContain('resolveSubscriptionPresentation(')
    // La condición que le daba las tres acciones al trial.
    expect(src).not.toMatch(/isActive \|\| isPastDue \|\| isTrial/)
    // No lee la tabla de sesiones ni escribe nada: sólo cuenta usuarios.
    expect([...src.matchAll(/supabase\.from\('([^']+)'\)/g)].map(m => m[1])).toEqual(['profiles'])
    expect(src).not.toMatch(/subscription_checkout_sessions|\.insert\(|\.update\(|\.upsert\(|\.delete\(/)
    expect(src).not.toMatch(/localStorage|sessionStorage|useSearchParams|location\.search/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('bloqueadas: la pantalla sigue como la dejó BETA-1', () => {
  it('trial vencido: «Prueba finalizada» y «Elegir plan»', async () => {
    suscripcion('suspended', { trial_ends_at: '2026-01-01T00:00:00.000Z', subscription_plan: null })
    montar()
    await presentacion('blocked')
    expect(screen.getByTestId('subscription-status-badge').textContent).toBe('Prueba finalizada')
    expect(screen.getByTestId('subscription-trial-ended')).toBeInTheDocument()
    expect(boton('Elegir plan')).not.toBeNull()
    expect(boton('Reactivar')).toBeNull()
  })

  it('suspendida por pago: «Suspendida» y «Reactivar»', async () => {
    suscripcion('suspended', { access_source: 'mercado_pago', mp_preapproval_id: 'pre_1', last_payment_status: 'rejected' })
    montar()
    await presentacion('blocked')
    expect(screen.getByTestId('subscription-status-badge').textContent).toBe('Suspendida')
    expect(boton('Reactivar')).not.toBeNull()
  })

  it('cancelada: «Cancelada» y «Reactivar»', async () => {
    suscripcion('canceled', { access_source: 'mercado_pago', mp_preapproval_id: 'pre_1' })
    montar()
    await presentacion('blocked')
    expect(screen.getByTestId('subscription-status-badge').textContent).toBe('Cancelada')
    fireEvent.click(boton('Reactivar')!)
    expect(screen.getByTestId('ruta').textContent).toBe('/subscription/plans')
  })

  it('no consulta el checkout: no es un trial', async () => {
    suscripcion('suspended', { trial_ends_at: '2026-01-01T00:00:00.000Z' })
    montar()
    await presentacion('blocked')
    expect(acciones()).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('la lectura del checkout no se repite', () => {
  it('una visita en trial = una sola lectura, aunque la pantalla se redibuje', async () => {
    const vista = montar()
    await presentacion('trial')
    for (let i = 0; i < 5; i++) vista.rerender(<MemoryRouter><Subscription /><Ruta /></MemoryRouter>)
    await act(async () => { await Promise.resolve() })
    expect(acciones()).toEqual(['status'])
  })

  it('mientras la suscripción carga no se consulta nada', async () => {
    Object.assign(h.sub, { loading: true })
    montar()
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Cargando suscripción...')).toBeInTheDocument()
    expect(acciones()).toEqual([])
  })

  it('una respuesta que llega después de salir de la pantalla no rompe nada', async () => {
    let soltar: (v: unknown) => void = () => undefined
    h.invoke.mockImplementation(() => new Promise(r => { soltar = r }))
    const vista = montar()
    await waitFor(() => expect(acciones()).toContain('status'))
    vista.unmount()
    expect(() => soltar({ data: { checkout: pendiente() }, error: null })).not.toThrow()
    await act(async () => { await Promise.resolve() })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('estructura: tarjeta de estado (P1-4) y superficies con tokens', () => {
  const css = readFileSync('src/index.css', 'utf8')
  const pagina = readFileSync('src/pages/Subscription.tsx', 'utf8')
  const bloque = css.slice(css.indexOf('BETA-UX-1C — Mi Suscripción por estado'), css.lastIndexOf('@media print'))
  const regla = (selector: string) => {
    const i = bloque.indexOf(`\n${selector} {`)
    expect(i, `falta la regla ${selector}`).toBeGreaterThan(-1)
    return bloque.slice(i, bloque.indexOf('}', i))
  }
  const movil = (ancho: number) => {
    const i = bloque.indexOf(`@media (max-width: ${ancho}px)`)
    expect(i, `falta el breakpoint de ${ancho}px`).toBeGreaterThan(-1)
    return bloque.slice(i, bloque.indexOf('\n}\n', i))
  }

  it('la tarjeta usa las clases del layout, no un flex inline', async () => {
    montar()
    await presentacion('trial')
    const cuerpo = tarjeta().querySelector('.sub-status')!
    expect(cuerpo).not.toBeNull()
    expect(cuerpo.getAttribute('style')).toBeNull()
    expect(cuerpo.querySelector('.sub-status__main .sub-status__icon')).not.toBeNull()
    expect(cuerpo.querySelector('.sub-status__main .sub-status__heading .sub-status__title')).not.toBeNull()
    expect(cuerpo.querySelector('.sub-status__main .sub-status__detail')).not.toBeNull()
    // Las acciones son hermanas del bloque de texto: por eso pueden bajar.
    expect(cuerpo.querySelector(':scope > .sub-status__actions')).not.toBeNull()
    expect(cuerpo.querySelector('.sub-status__main .sub-status__actions')).toBeNull()
  })

  it('el bloque de texto pide un ancho útil: si no entra, las acciones bajan', () => {
    expect(regla('.sub-status')).toMatch(/flex-wrap:\s*wrap/)
    const main = regla('.sub-status__main')
    expect(main).toMatch(/flex:\s*1 1 22rem/)
    expect(main).toMatch(/min-width:\s*0/)
    // Lo que causaba P1-4: una columna de texto con base 0 al lado del botón.
    expect(bloque).not.toMatch(/\.sub-status__main\s*\{[^}]*flex:\s*1\s*;/)
  })

  it('por debajo de 480px: textos a todo el ancho y acciones debajo, de lado a lado', () => {
    const m = movil(480)
    expect(m).toMatch(/\.sub-status__detail\s*\{[^}]*grid-column:\s*1 \/ -1/)
    expect(m).toMatch(/\.sub-status__actions,[\s\S]*flex:\s*1 1 100%;\s*flex-direction:\s*column/)
    expect(m).toMatch(/\.sub-status__actions \.btn,[\s\S]*width:\s*100%/)
  })

  it('en mobile toda acción de la pantalla mide al menos 44px', () => {
    expect(movil(767)).toMatch(/\.sub-page \.btn\s*\{\s*min-height:\s*44px/)
  })

  it('el responsive es CSS: la pantalla no mide la ventana', () => {
    expect(pagina).not.toMatch(/innerWidth|matchMedia|useMediaQuery|resize/)
  })

  it('«Usuarios incluidos» y las funciones usan tokens de tema, no blancos translúcidos', () => {
    expect(pagina).not.toMatch(/rgba\(255,\s*255,\s*255/)
    expect(regla('.sub-users')).toMatch(/background:\s*var\(--bg-surface\);\s*border:\s*1px solid var\(--border-color\)/)
    expect(regla('.sub-feature')).toMatch(/background:\s*var\(--bg-surface\)/)
  })

  it('la pantalla no trae colores fijos: ni hex ni rgb() en línea', () => {
    expect(pagina).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(pagina).not.toMatch(/rgba?\(/)
    expect(pagina).not.toMatch(/STATUS_COLORS|PAYMENT_STATUS_COLORS/)
  })

  it('el estado se lee con texto de tema; el color queda en el punto, el ícono y el borde', () => {
    expect(regla('.sub-status__badge')).toMatch(/[^-]color:\s*var\(--text-primary\)/)
    expect(regla('.sub-status__badge::before')).toMatch(/background:\s*var\(--sub-tone\)/)
    expect(regla('.sub-status__icon')).toMatch(/[^-]color:\s*var\(--sub-tone\)/)
    expect(regla('.sub-status__detail p')).toMatch(/color:\s*var\(--text-secondary\)/)
  })
})
