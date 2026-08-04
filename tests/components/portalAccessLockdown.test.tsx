// ─────────────────────────────────────────────────────────────────────────────
// P0 FASE 2 — El portal público frente al lockdown de `public.businesses`.
//
// Tests de COMPORTAMIENTO sobre el DOM real: montan PortalProvider + PortalGate
// y empujan respuestas de Supabase mockeadas. Lo que se prueba no es que exista
// tal string en el fuente, sino qué termina renderizado y qué llamadas salieron.
//
// El caso que da nombre al archivo: con la FASE 2 aplicada, un bundle viejo que
// consulte la tabla recibe 42501. Antes eso caía en `null` → «Portal no
// disponible» (mentira: el portal existe) y, si la promesa llegaba a rechazar,
// en spinner infinito.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PortalProvider, usePortal } from '../../src/portal/contexts/PortalContext'
import { PortalGate } from '../../src/portal/components/PortalGate'
import { PORTAL_PUBLIC_COLUMNS } from '../../src/portal/portalPublicContract'

// ── Mock del cliente Supabase ────────────────────────────────────────────────
// Se reemplaza el módulo entero, así que la validación de env de lib/supabase
// nunca corre y ninguna llamada sale a la red (el setup global además rompe fetch).

const rpcMock = vi.fn()
const fromMock = vi.fn()
const maybeSingleMock = vi.fn()
const getSessionMock = vi.fn()

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (tabla: string) => {
      fromMock(tabla)
      const q = {
        select: (cols: string) => { selectSpy(cols); return q },
        eq:     () => q,
        maybeSingle: () => maybeSingleMock(),
        order:  () => q,
        gt:     () => q,
        limit:  () => q,
      }
      return q
    },
    auth: {
      getSession: () => getSessionMock(),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => ({ error: null }),
    },
  },
}))

const selectSpy = vi.fn()

const FILA_OK = {
  id: 'biz-1',
  name: 'Clic Mayorista',
  logo_url: null,
  wholesale_portal_enabled: true,
  wholesale_portal_slug: 'clic',
  wholesale_whatsapp: '5491100000000',
  wholesale_portal_theme: null,
}

/** Respuesta de PostgREST, con el `status` que supabase-js expone. */
function respuesta(over: Partial<{ data: unknown; error: unknown; status: number }>) {
  return { data: null, error: null, status: 200, ...over }
}

/** Sonda del contexto: expone el estado sin depender de ninguna página. */
function Sonda() {
  const { business, bizLoading, notFound, loadError } = usePortal()
  return (
    <div
      data-testid="sonda"
      data-loading={String(bizLoading)}
      data-notfound={String(notFound)}
      data-error={loadError ?? ''}
    >
      {business ? `portal:${business.name}` : 'sin-portal'}
    </div>
  )
}

function montar(slug = 'clic') {
  return render(
    <PortalProvider slug={slug} basePath="">
      <PortalGate>
        <Sonda />
      </PortalGate>
    </PortalProvider>,
  )
}

/** Espera a que el estado de carga haya terminado. Falla si nunca termina. */
async function esperarFinDeCarga() {
  await waitFor(() => {
    const sonda = screen.queryByTestId('sonda')
    // Si el gate renderizó una pantalla terminal, la sonda no está: eso también
    // significa que la carga terminó.
    if (!sonda) return
    expect(sonda).toHaveAttribute('data-loading', 'false')
  })
}

beforeEach(() => {
  rpcMock.mockReset()
  fromMock.mockReset()
  selectSpy.mockReset()
  maybeSingleMock.mockReset()
  getSessionMock.mockReset()
  getSessionMock.mockResolvedValue({ data: { session: null } })
})

describe('portal público — contrato de carga', () => {
  // ── 1 ──────────────────────────────────────────────────────────────────────
  test('1: la RPC pública exitosa renderiza el portal', async () => {
    rpcMock.mockResolvedValue(respuesta({ data: [FILA_OK] }))
    montar()
    await screen.findByText('portal:Clic Mayorista')

    expect(rpcMock).toHaveBeenCalledWith('get_wholesale_portal_public', { p_slug: 'clic' })
    expect(screen.queryByTestId('portal-error')).toBeNull()
    expect(screen.queryByTestId('portal-unavailable')).toBeNull()
  })

  // ── 2 ──────────────────────────────────────────────────────────────────────
  test('2: slug inexistente muestra «Portal no disponible»', async () => {
    rpcMock.mockResolvedValue(respuesta({ data: [] }))
    montar('no-existe')

    await screen.findByTestId('portal-unavailable')
    expect(screen.getByText(/Portal no disponible/i)).toBeInTheDocument()
    // No es un error: no se ofrece reintentar.
    expect(screen.queryByTestId('portal-error')).toBeNull()
  })

  // ── 3 ──────────────────────────────────────────────────────────────────────
  test('3: portal deshabilitado muestra «Portal no disponible»', async () => {
    // La RPC ya filtra por wholesale_portal_enabled, pero el cliente NO confía
    // en eso: si alguna vez devolviera la fila con el flag apagado, sigue siendo
    // «no disponible» y nunca «disponible».
    rpcMock.mockResolvedValue(respuesta({ data: [{ ...FILA_OK, wholesale_portal_enabled: false }] }))
    montar()

    await screen.findByTestId('portal-unavailable')
    expect(screen.queryByText(/portal:/)).toBeNull()
  })

  // ── 4 ──────────────────────────────────────────────────────────────────────
  test('4: PGRST202 activa el fallback y pide SÓLO la allowlist pública', async () => {
    rpcMock.mockResolvedValue(respuesta({ error: { code: 'PGRST202', message: 'no function' }, status: 404 }))
    maybeSingleMock.mockResolvedValue(respuesta({ data: FILA_OK }))
    montar()

    await screen.findByText('portal:Clic Mayorista')

    expect(fromMock).toHaveBeenCalledWith('businesses')
    expect(selectSpy).toHaveBeenCalledWith(PORTAL_PUBLIC_COLUMNS)
    // Comprobación de contenido, no de identidad de la constante: ninguna
    // columna pedida puede estar fuera de las 7, y jamás el comodín.
    const pedidas = String(selectSpy.mock.calls[0][0]).split(',').map(c => c.trim())
    expect(pedidas).toHaveLength(7)
    expect(pedidas).not.toContain('*')
    for (const prohibida of ['mp_payer_email', 'mp_preapproval_id', 'owner_user_id', 'subscription_plan']) {
      expect(pedidas).not.toContain(prohibida)
    }
  })

  // ── 5 ──────────────────────────────────────────────────────────────────────
  test('5: 42501 NO activa el fallback a la tabla', async () => {
    rpcMock.mockResolvedValue(respuesta({
      error: { code: '42501', message: 'permission denied for table businesses' },
      status: 403,
    }))
    montar()

    await screen.findByTestId('portal-error')
    // Éste es el corazón de la FASE 2: si el fallback se disparara, el portal
    // volvería a golpear la tabla que la migración acaba de cerrar.
    expect(fromMock).not.toHaveBeenCalled()
    expect(selectSpy).not.toHaveBeenCalled()
  })

  // ── 6 ──────────────────────────────────────────────────────────────────────
  test('6: 42501 termina el loading (no queda spinner)', async () => {
    rpcMock.mockResolvedValue(respuesta({ error: { code: '42501', message: 'permission denied' }, status: 403 }))
    montar()

    await screen.findByTestId('portal-error')
    await esperarFinDeCarga()
    // El botón «Reintentar» está habilitado: si bizLoading hubiera quedado en
    // true, PortalButton lo mostraría como «Cargando...» y deshabilitado.
    const reintentar = screen.getByRole('button', { name: /Reintentar/i })
    expect(reintentar).toBeEnabled()
  })

  // ── 7 ──────────────────────────────────────────────────────────────────────
  test('7: 42501 muestra un error terminal con acciones', async () => {
    rpcMock.mockResolvedValue(respuesta({ error: { code: '42501', message: 'permission denied' }, status: 403 }))
    montar()

    const caja = await screen.findByTestId('portal-error')
    expect(caja).toHaveAttribute('data-reason', 'permission-denied')
    expect(screen.getByTestId('portal-error-message'))
      .toHaveTextContent('No pudimos cargar este portal. Actualizá la página o intentá nuevamente.')
    // Un 42501 es casi siempre un bundle viejo: se ofrece recargar duro.
    expect(screen.getByRole('button', { name: /Actualizar/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reintentar/i })).toBeInTheDocument()
    // Y NO se lo confunde con «no disponible».
    expect(screen.queryByTestId('portal-unavailable')).toBeNull()
  })

  // ── 8 ──────────────────────────────────────────────────────────────────────
  test('8: un 5xx no activa el fallback y da error terminal', async () => {
    rpcMock.mockResolvedValue(respuesta({
      error: { code: '', message: 'Internal Server Error' }, status: 503,
    }))
    montar()

    const caja = await screen.findByTestId('portal-error')
    expect(caja).toHaveAttribute('data-reason', 'server')
    expect(fromMock).not.toHaveBeenCalled()
  })

  // ── 9 ──────────────────────────────────────────────────────────────────────
  test('9: un error de red no deja spinner ni activa el fallback', async () => {
    // supabase-js marca el fetch fallido con status 0 y sin código.
    rpcMock.mockResolvedValue(respuesta({ error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 }))
    montar()

    const caja = await screen.findByTestId('portal-error')
    expect(caja).toHaveAttribute('data-reason', 'network')
    expect(fromMock).not.toHaveBeenCalled()
    await esperarFinDeCarga()
    expect(screen.getByRole('button', { name: /Reintentar/i })).toBeEnabled()
    // Con la red caída, recargar sólo da pantalla en blanco: no se ofrece.
    expect(screen.queryByRole('button', { name: /Actualizar/i })).toBeNull()
  })

  // ── 9b ─────────────────────────────────────────────────────────────────────
  test('9b: una promesa RECHAZADA tampoco deja el spinner colgado', async () => {
    rpcMock.mockRejectedValue(new Error('boom'))
    montar()

    const caja = await screen.findByTestId('portal-error')
    expect(caja).toHaveAttribute('data-reason', 'network')
    await esperarFinDeCarga()
  })

  // ── 10 ─────────────────────────────────────────────────────────────────────
  test('10: «Reintentar» vuelve a consultar la RPC y se recupera', async () => {
    const user = userEvent.setup()
    rpcMock
      .mockResolvedValueOnce(respuesta({ error: { code: '42501', message: 'denied' }, status: 403 }))
      .mockResolvedValueOnce(respuesta({ data: [FILA_OK] }))

    montar()
    await screen.findByTestId('portal-error')
    expect(rpcMock).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /Reintentar/i }))

    await screen.findByText('portal:Clic Mayorista')
    expect(rpcMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('portal-error')).toBeNull()
  })

  // ── 11 ─────────────────────────────────────────────────────────────────────
  test('11: una respuesta vieja no pisa el resultado de un slug nuevo', async () => {
    let resolverViejo: ((v: unknown) => void) | null = null

    rpcMock.mockImplementation((_fn: string, args: { p_slug: string }) => {
      if (args.p_slug === 'viejo') {
        return new Promise(res => { resolverViejo = res })
      }
      return Promise.resolve(respuesta({ data: [{ ...FILA_OK, name: 'NUEVO', wholesale_portal_slug: 'nuevo' }] }))
    })

    const { rerender } = render(
      <PortalProvider slug="viejo" basePath=""><PortalGate><Sonda /></PortalGate></PortalProvider>,
    )

    // Navegación a otro portal antes de que llegue la primera respuesta.
    rerender(
      <PortalProvider slug="nuevo" basePath=""><PortalGate><Sonda /></PortalGate></PortalProvider>,
    )
    await screen.findByText('portal:NUEVO')

    // Ahora llega la respuesta del slug viejo. No puede cambiar nada.
    await act(async () => {
      resolverViejo?.(respuesta({ data: [{ ...FILA_OK, name: 'VIEJO' }] }))
      await Promise.resolve()
    })

    expect(screen.getByText('portal:NUEVO')).toBeInTheDocument()
    expect(screen.queryByText('portal:VIEJO')).toBeNull()
  })

  // ── 11b ────────────────────────────────────────────────────────────────────
  test('11b: un error viejo tampoco pisa un slug nuevo que cargó bien', async () => {
    let resolverViejo: ((v: unknown) => void) | null = null
    rpcMock.mockImplementation((_fn: string, args: { p_slug: string }) => {
      if (args.p_slug === 'viejo') return new Promise(res => { resolverViejo = res })
      return Promise.resolve(respuesta({ data: [FILA_OK] }))
    })

    const { rerender } = render(
      <PortalProvider slug="viejo" basePath=""><PortalGate><Sonda /></PortalGate></PortalProvider>,
    )
    rerender(
      <PortalProvider slug="clic" basePath=""><PortalGate><Sonda /></PortalGate></PortalProvider>,
    )
    await screen.findByText('portal:Clic Mayorista')

    await act(async () => {
      resolverViejo?.(respuesta({ error: { code: '42501', message: 'denied' }, status: 403 }))
      await Promise.resolve()
    })

    expect(screen.queryByTestId('portal-error')).toBeNull()
    expect(screen.getByText('portal:Clic Mayorista')).toBeInTheDocument()
  })

  // ── 13 ─────────────────────────────────────────────────────────────────────
  test('13: el flujo normal no consulta /rest/v1/businesses ni una vez', async () => {
    rpcMock.mockResolvedValue(respuesta({ data: [FILA_OK] }))
    montar()
    await screen.findByText('portal:Clic Mayorista')

    // Ninguna lectura de la tabla: sólo la RPC allowlisted.
    expect(fromMock).not.toHaveBeenCalledWith('businesses')
    const rpcsLlamadas = rpcMock.mock.calls.map(c => c[0])
    for (const fn of rpcsLlamadas) {
      expect(['get_wholesale_portal_public', 'get_wholesale_portal_features']).toContain(fn)
    }
  })

  // ── 14 ─────────────────────────────────────────────────────────────────────
  test('14: con sesión iniciada el portal público carga igual (mismo camino)', async () => {
    // Un F5 en /catalogo con sesión ejecuta la RPC como `authenticated`.
    getSessionMock.mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
    })
    rpcMock.mockResolvedValue(respuesta({ data: [FILA_OK] }))
    maybeSingleMock.mockResolvedValue(respuesta({ data: null }))

    montar()
    await screen.findByText('portal:Clic Mayorista')

    expect(rpcMock).toHaveBeenCalledWith('get_wholesale_portal_public', { p_slug: 'clic' })
    // El negocio se resuelve por RPC también con sesión: nunca por la tabla.
    expect(fromMock).not.toHaveBeenCalledWith('businesses')
  })

  // ── 15 ─────────────────────────────────────────────────────────────────────
  test('15: el mensaje de error está sanitizado — no filtra SQL ni internos', async () => {
    const mensajeCrudo =
      'permission denied for table businesses; SELECT mp_payer_email FROM public.businesses WHERE id = $1'
    rpcMock.mockResolvedValue(respuesta({
      error: { code: '42501', message: mensajeCrudo, details: 'pg_catalog', hint: 'GRANT SELECT' },
      status: 403,
    }))
    montar()
    await screen.findByTestId('portal-error')

    const texto = document.body.textContent ?? ''
    for (const filtracion of [
      mensajeCrudo, 'permission denied', 'SELECT', 'public.businesses',
      'mp_payer_email', 'GRANT', 'pg_catalog', '42501',
    ]) {
      expect(texto).not.toContain(filtracion)
    }
    // Lo que sí se ve es el texto fijo del mapa cerrado.
    expect(texto).toContain('No pudimos cargar este portal')
  })

  // ── extra: el fallback también sabe fallar ────────────────────────────────
  test('si el fallback recibe 42501, es error terminal y no «no disponible»', async () => {
    // Orden de despliegue base-primero con un bundle viejo: la RPC no está
    // (PGRST202) y la tabla ya está cerrada (42501). No puede terminar diciendo
    // que el portal no existe.
    rpcMock.mockResolvedValue(respuesta({ error: { code: 'PGRST202', message: 'no function' }, status: 404 }))
    maybeSingleMock.mockResolvedValue(respuesta({
      error: { code: '42501', message: 'permission denied for table businesses' }, status: 403,
    }))
    montar()

    const caja = await screen.findByTestId('portal-error')
    expect(caja).toHaveAttribute('data-reason', 'permission-denied')
    expect(screen.queryByTestId('portal-unavailable')).toBeNull()
  })
})
