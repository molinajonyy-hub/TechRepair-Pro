// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1B — Primer cobro sin callejón sin salida.
//
// El POS exige una caja abierta para registrar un cobro. Antes lo decía recién
// al tocar «Cobrar» («No hay caja abierta. Abrí caja antes de emitir.») y no
// ofrecía salida: había que abandonar la venta, ir a Caja y volver a armar todo.
//
// Acá se monta el POS REAL (`ComprobanteProModal`) con los providers REALES de
// sesión y de caja, así que la capacidad sale de `usePermissions` de verdad:
// defaults del rol + overrides. El borde simulado es Supabase y los servicios
// que hablan con él. Se mide:
//
//   · quién ve la acción «Abrir caja» y quién sólo la explicación;
//   · que «Cobrar» con caja cerrada NO empieza el checkout;
//   · que la apertura va por `open_cash_session_atomic` y por nada más;
//   · que al volver, la venta está exactamente como estaba;
//   · que abrir la caja nunca cobra.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const USER_ID  = '11111111-1111-4111-8111-111111111111'
const BIZ_ID   = '22222222-2222-4222-8222-222222222222'
const CAJA_ID  = '33333333-3333-4333-8333-333333333333'
const ORDER_ID = '44444444-4444-4444-8444-444444444444'
const CLIENTE  = { id: '55555555-5555-4555-8555-555555555555', name: 'Ana Pérez', customer_type: 'minorista', phone: '3515550000', document: null }
const COTIZACION = 1450

type RpcResult = { data: unknown; error: null | { code?: string; message: string } }

const estado = vi.hoisted(() => ({
  perfil: null as Record<string, unknown> | null,
  /** ¿`cajas` devuelve una sesión abierta? */
  cajaAbierta: false,
  /** Respuesta de `open_cash_session_atomic`. Por defecto abre la caja. */
  openRpc: null as null | ((args: Record<string, unknown>) => unknown),
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  selects: [] as string[],
  writes: [] as Array<{ tabla: string; op: string }>,
  crear: [] as Array<Record<string, unknown>>,
}))

vi.mock('../../src/lib/supabase', () => {
  const chain = (tabla: string): unknown => {
    const fila = () =>
      tabla === 'cajas' && estado.cajaAbierta
        ? { data: { id: '33333333-3333-4333-8333-333333333333', business_id: '22222222-2222-4222-8222-222222222222', opened_at: '2026-10-07T12:00:00Z', opened_by: '11111111-1111-4111-8111-111111111111', status: 'abierta' }, error: null }
        : { data: null, error: null }
    const c: unknown = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'select') return () => { estado.selects.push(tabla); return c }
        // Cualquier escritura directa queda registrada: el test la prohíbe.
        if (['insert', 'update', 'delete', 'upsert'].includes(prop)) return () => { estado.writes.push({ tabla, op: prop }); return c }
        if (prop === 'maybeSingle' || prop === 'single') return async () => fila()
        if (prop === 'then') return (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: [], error: null })
        return () => c
      },
    })
    return c
  }
  return {
    supabase: {
      auth: {
        getSession: async () => ({
          data: { session: { user: { id: '11111111-1111-4111-8111-111111111111', email: 'u@invalid.test', email_confirmed_at: '2026-08-24T00:00:00Z' } } },
          error: null,
        }),
        getUser: async () => ({ data: { user: { id: '11111111-1111-4111-8111-111111111111' } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signOut: async () => ({ error: null }),
      },
      rpc: async (fn: string, args: Record<string, unknown> = {}) => {
        estado.rpcs.push({ fn, args })
        if (fn === 'get_my_profile') return { data: estado.perfil, error: null }
        if (fn === 'get_current_exchange_rate') return { data: 1450, error: null }
        if (fn === 'open_cash_session_atomic') {
          if (estado.openRpc) return estado.openRpc(args)
          estado.cajaAbierta = true
          return { data: { ok: true, replay: false, caja_id: '33333333-3333-4333-8333-333333333333' }, error: null }
        }
        return { data: null, error: null }
      },
      from: (tabla: string) => chain(tabla),
    },
  }
})

vi.mock('../../src/services/comprobanteService', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/comprobanteService')>()
  return {
    ...real,
    comprobanteService: {
      ...real.comprobanteService,
      crear: async (input: Record<string, unknown>) => { estado.crear.push(input); return { success: true } },
      getCheckoutStatus: async () => ({ found: false }),
      getById: async () => null,
    },
  }
})
vi.mock('../../src/hooks/usePaymentCommissions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/hooks/usePaymentCommissions')>()
  return { ...real, usePaymentCommissions: () => ({ flatMethods: real.FIXED_METHODS }) }
})
vi.mock('../../src/hooks/useWholesaleAccess', () => ({ useWholesaleAccess: () => ({ canAccess: false }) }))
vi.mock('../../src/services/posCustomerSearchService', () => ({
  searchPosCustomers: async () => ({ status: 'ok', items: [{ id: '55555555-5555-4555-8555-555555555555', name: 'Ana Pérez', customer_type: 'minorista', phone: '3515550000', document: null }], truncated: false }),
  getPosCustomerById: async () => ({ id: '55555555-5555-4555-8555-555555555555', name: 'Ana Pérez', customer_type: 'minorista', phone: '3515550000', document: null }),
}))
vi.mock('../../src/services/productSearchService', () => ({
  searchSellableProducts: async () => ({ status: 'ok', items: [] }),
  isSellableProduct: () => true,
}))
vi.mock('../../src/services/salesPointService', () => ({ salesPointService: { getActiveNumeroFormateado: async () => '0007' } }))
vi.mock('../../src/services/arcaService', () => ({ ArcaService: { getPuntoVentaFiscal: async () => null } }))
vi.mock('../../src/components/products/ProductFormModal', () => ({ ProductFormModalSafe: () => null }))
vi.mock('../../src/components/whatsapp/WhatsAppPreviewModal', () => ({ WhatsAppPreviewModal: () => null }))
vi.mock('../../src/lib/sounds', () => ({ soundSystem: { isEnabled: () => false, play: () => {}, toggle: () => false } }))

import { AuthProvider, useAuth } from '../../src/contexts/AuthContext'
import { CajaProvider } from '../../src/contexts/CajaContext'
import { ComprobanteProModal, type ComprobanteProModalProps } from '../../src/components/comprobantes/ComprobanteProModal'
import { readPendingCheckout } from '../../src/lib/checkoutIdempotency'

const here = dirname(fileURLToPath(import.meta.url))
const leer = (rel: string) => readFileSync(join(here, '../../', rel), 'utf8')
const leerCodigo = (rel: string) =>
  leer(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '')

const perfil = (role: string, permissions: unknown = null) => ({
  id: USER_ID, business_id: BIZ_ID, role, is_active: true,
  full_name: 'U', email: 'u@invalid.test', phone: null, permissions,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
})

/** La forma en que `OrderDetail` abre el POS: ítems de la orden + cliente + orden. */
const ITEMS: NonNullable<ComprobanteProModalProps['initialItems']> = [
  { descripcion: 'Cambio de módulo iPhone 13', cantidad: 1, precio_unitario: 85000, costo_unitario: 40000, tipo_linea: 'servicio' },
  { descripcion: 'Vidrio templado', cantidad: 2, precio_unitario: 4500, costo_unitario: 1200 },
]
const TOTAL = 85000 + 2 * 4500

/** Marca cuándo terminó de hidratar el perfil: antes de eso nadie tiene capacidad. */
function Sonda() {
  const { profile } = useAuth()
  return <span data-testid="sonda-rol">{profile?.role ?? 'sin-perfil'}</span>
}

const onClose = vi.fn()
const onCreado = vi.fn()

async function montar(role: string, opts: { permissions?: unknown; props?: Partial<ComprobanteProModalProps> } = {}) {
  estado.perfil = perfil(role, opts.permissions ?? null)
  render(
    <AuthProvider>
      <CajaProvider>
        <Sonda />
        <ComprobanteProModal
          isOpen onClose={onClose} onCreado={onCreado}
          initialItems={ITEMS} initialClienteId={CLIENTE.id} orderId={ORDER_ID}
          {...opts.props}
        />
      </CajaProvider>
    </AuthProvider>,
  )
  await waitFor(() => expect(screen.getByTestId('sonda-rol').textContent).toBe(role))
  // La cotización alimenta el diálogo y el payload: se espera a que cargue.
  await waitFor(() => expect(estado.rpcs.some(r => r.fn === 'get_current_exchange_rate')).toBe(true))
}

const aperturas = () => estado.rpcs.filter(r => r.fn === 'open_cash_session_atomic')
const lecturasDeCaja = () => estado.selects.filter(t => t === 'cajas').length
const cobrar = () => fireEvent.click(screen.getByTestId('comprobante-save-button'))
const tipear = (testId: string, valor: string) => fireEvent.change(screen.getByTestId(testId), { target: { value: valor } })
const esperar = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Fotografía de la venta en pantalla: lo que NO puede cambiar por abrir la caja. */
function fotoDeLaVenta() {
  return {
    lineas: screen.getAllByTestId('comprobante-item-description').map(i => (i as HTMLInputElement).value),
    cantidades: screen.getAllByTestId('comprobante-item-quantity').map(i => (i as HTMLInputElement).value),
    precios: screen.getAllByTestId('comprobante-item-price').map(i => (i as HTMLInputElement).value),
    pagos: screen.queryAllByTestId('comprobante-payment-amount').map(i => (i as HTMLInputElement).value),
    total: screen.getByTestId('comprobante-total').textContent,
    cliente: screen.queryByText(CLIENTE.name) !== null,
    observaciones: (screen.getByPlaceholderText('Observaciones...') as HTMLTextAreaElement).value,
    tipoFiscal: screen.getByTestId('pos-tipo-factura_c').getAttribute('aria-pressed'),
  }
}

/** Arma una venta con todo lo que el usuario puede haber cargado antes de cobrar. */
async function armarVenta() {
  await screen.findByText(CLIENTE.name)
  fireEvent.click(screen.getByTestId('pos-tipo-factura_c'))
  fireEvent.change(screen.getByPlaceholderText('Observaciones...'), { target: { value: 'Entregar con funda' } })
  fireEvent.click(screen.getByTestId('comprobante-payment-efectivo'))
  await screen.findByTestId('comprobante-payment-chip')
  tipear('comprobante-payment-amount', '50000')
  return fotoDeLaVenta()
}

let eventosDeCaja = 0
const contarEvento = () => { eventosDeCaja += 1 }

beforeEach(() => {
  estado.perfil = null
  estado.cajaAbierta = false
  estado.openRpc = null
  estado.rpcs = []
  estado.selects = []
  estado.writes = []
  estado.crear = []
  eventosDeCaja = 0
  onClose.mockClear()
  onCreado.mockClear()
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.addEventListener('cash-session-updated', contarEvento)
})

afterEach(() => {
  window.removeEventListener('cash-session-updated', contarEvento)
})

// ═══════════════════════════════════════════════════════════════════════════
describe('1 · con capacidad `finance` y la caja cerrada', () => {
  it('explica qué falta y ofrece «Abrir caja»', async () => {
    await montar('owner')
    const aviso = await screen.findByTestId('pos-caja-closed')
    await waitFor(() => expect(screen.getByTestId('pos-caja-closed')).toHaveAttribute('data-caja-action', 'open'))
    expect(aviso).toHaveTextContent('Necesitás abrir la caja para registrar este cobro.')
    expect(screen.getByTestId('pos-open-caja-button')).toHaveTextContent('Abrir caja')
    // El aviso viejo era un callejón sin salida: no puede quedar ni su texto.
    expect(screen.queryByText(/no se pueden emitir comprobantes/i)).toBeNull()
  })

  it('el CTA abre el diálogo ENCIMA del POS, con los cuatro saldos y la cotización del POS', async () => {
    await montar('owner')
    fireEvent.click(await screen.findByTestId('pos-open-caja-button'))

    const dialogo = await screen.findByTestId('pos-open-caja-dialog')
    expect(dialogo).toHaveAttribute('role', 'dialog')
    expect(dialogo).toHaveAttribute('aria-modal', 'true')
    for (const m of ['efectivo', 'transferencia', 'tarjeta', 'usd']) {
      expect(within(dialogo).getByTestId(`pos-open-caja-${m}`)).toBeInTheDocument()
    }
    expect(within(dialogo).getByLabelText('Efectivo')).toBe(screen.getByTestId('pos-open-caja-efectivo'))
    expect(within(dialogo).getByLabelText('USD')).toBe(screen.getByTestId('pos-open-caja-usd'))
    await waitFor(() =>
      expect(screen.getByTestId('pos-open-caja-usd-rate')).toHaveTextContent(`Cotización: $${COTIZACION.toLocaleString('es-AR')}`))

    // Vive dentro de la raíz del POS (tokens --pos-*) y el POS sigue montado.
    expect(dialogo.closest('.cpm-root')).not.toBeNull()
    expect(screen.getByTestId('comprobante-product-search')).toBeInTheDocument()
    expect(screen.getAllByTestId('comprobante-item-description')).toHaveLength(ITEMS.length)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('2 · sin capacidad `finance` y la caja cerrada', () => {
  it('sales: explica a quién pedírselo, sin CTA, sin diálogo y sin llamar al servidor', async () => {
    await montar('sales')
    // `sales` necesita CONOCER la caja (tiene `comprobantes`): la consulta sale.
    await waitFor(() => expect(lecturasDeCaja()).toBeGreaterThan(0))

    const aviso = screen.getByTestId('pos-caja-closed')
    expect(aviso).toHaveAttribute('data-caja-action', 'none')
    expect(aviso).toHaveTextContent('La caja está cerrada. Pedile a un usuario con permiso de Finanzas / Caja que la abra para continuar.')
    expect(screen.queryByTestId('pos-open-caja-button')).toBeNull()
    // Ni botón ni enlace a la pantalla Caja.
    expect(within(aviso).queryByRole('button')).toBeNull()
    expect(within(aviso).queryByRole('link')).toBeNull()

    cobrar()
    await esperar(50)
    expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull()
    expect(aperturas()).toEqual([])
    expect(estado.crear).toEqual([])
    expect(readPendingCheckout(BIZ_ID)).toBeNull()
    // El aviso sigue ahí: el toque no se pierde en silencio ni se duplica el mensaje.
    expect(screen.getAllByText(/Pedile a un usuario con permiso de Finanzas/)).toHaveLength(1)
  })

  it('F4 tampoco abre un diálogo para quien no puede operar caja', async () => {
    await montar('sales')
    await waitFor(() => expect(lecturasDeCaja()).toBeGreaterThan(0))
    fireEvent.keyDown(document, { key: 'F4' })
    await esperar(50)
    expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull()
    expect(aperturas()).toEqual([])
    expect(estado.crear).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('3 · «Cobrar» con la caja cerrada', () => {
  it('con capacidad: NO empieza el checkout y abre el diálogo de caja', async () => {
    await montar('owner')
    await screen.findByTestId('pos-open-caja-button')

    cobrar()

    expect(await screen.findByTestId('pos-open-caja-dialog')).toBeInTheDocument()
    await esperar(50)
    // El cobro no arrancó: sin comprobante y sin key de idempotencia del intento.
    expect(estado.crear).toEqual([])
    expect(readPendingCheckout(BIZ_ID)).toBeNull()
    expect(window.sessionStorage.length).toBe(0)
    // Y no aparece el error viejo debajo del diálogo.
    expect(screen.queryByTestId('comprobante-error-message')).toBeNull()
    expect(aperturas()).toEqual([])
  })

  it('F4 hace lo mismo que el botón', async () => {
    await montar('owner')
    await screen.findByTestId('pos-open-caja-button')
    fireEvent.keyDown(document, { key: 'F4' })
    expect(await screen.findByTestId('pos-open-caja-dialog')).toBeInTheDocument()
    expect(estado.crear).toEqual([])
  })

  it('con el diálogo a la vista, F4 y Escape no llegan al POS', async () => {
    await montar('owner')
    fireEvent.click(await screen.findByTestId('pos-open-caja-button'))
    await screen.findByTestId('pos-open-caja-dialog')

    fireEvent.keyDown(document, { key: 'F4' })
    await esperar(30)
    expect(estado.crear).toEqual([])
    expect(screen.getByTestId('pos-open-caja-dialog')).toBeInTheDocument()

    // F2 abre el buscador de clientes del POS y le roba el foco al diálogo:
    // con «Abrir caja» a la vista no puede correr.
    fireEvent.keyDown(document, { key: 'F2' })
    await esperar(30)
    expect(screen.queryByTestId('comprobante-customer-results')).toBeNull()
    expect(screen.queryByTestId('comprobante-customer-search')).toBeNull()

    // Escape cierra SÓLO el diálogo: el POS no se cierra ni pregunta por el borrador.
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByText('Cambios sin guardar')).toBeNull()
    expect(screen.getAllByTestId('comprobante-item-description')).toHaveLength(ITEMS.length)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('4 · apertura', () => {
  it('llama exactamente a `open_cash_session_atomic` con negocio, usuario, saldos, cotización y key', async () => {
    await montar('owner')
    fireEvent.click(await screen.findByTestId('pos-open-caja-button'))
    await screen.findByTestId('pos-open-caja-dialog')
    await waitFor(() => expect(screen.getByTestId('pos-open-caja-usd-rate')).toHaveTextContent('1.450'))

    tipear('pos-open-caja-efectivo', '15000')
    tipear('pos-open-caja-transferencia', '2500.50')
    tipear('pos-open-caja-usd', '20')
    fireEvent.click(screen.getByTestId('pos-open-caja-confirm'))

    await waitFor(() => expect(aperturas()).toHaveLength(1))
    const { args } = aperturas()[0]
    expect(args).toEqual({
      p_business_id: BIZ_ID,
      p_user_id: USER_ID,
      p_efectivo: 15000,
      p_transferencia: 2500.5,
      p_tarjeta: 0,
      p_usd: 20,
      p_usd_rate: COTIZACION,
      p_idempotency_key: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    })
    // Ninguna escritura directa: la caja la abre la RPC, no un INSERT del navegador.
    expect(estado.writes).toEqual([])
    await waitFor(() => expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull())
  })

  it('un doble toque en «Abrir caja» manda UNA sola apertura', async () => {
    let liberar: (v: RpcResult) => void = () => {}
    estado.openRpc = () => new Promise<RpcResult>(res => { liberar = res })
    await montar('owner')
    fireEvent.click(await screen.findByTestId('pos-open-caja-button'))
    await screen.findByTestId('pos-open-caja-dialog')

    const confirmar = screen.getByTestId('pos-open-caja-confirm')
    fireEvent.click(confirmar)
    fireEvent.click(confirmar)
    fireEvent.submit(confirmar.closest('form') as HTMLFormElement)
    await waitFor(() => expect(confirmar).toBeDisabled())
    expect(aperturas()).toHaveLength(1)
    // Mientras está en vuelo no se puede cancelar: el resultado no puede perderse.
    expect(screen.getByTestId('pos-open-caja-cancel')).toBeDisabled()

    estado.cajaAbierta = true
    liberar({ data: { ok: true, replay: false, caja_id: CAJA_ID }, error: null })
    await waitFor(() => expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull())
    expect(aperturas()).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('5 · apertura exitosa: se vuelve al MISMO checkout', () => {
  it('refresca la caja, avisa, cierra sólo el diálogo y la venta queda intacta', async () => {
    await montar('owner')
    const antes = await armarVenta()
    const lecturasAntes = lecturasDeCaja()

    cobrar()
    await screen.findByTestId('pos-open-caja-dialog')
    tipear('pos-open-caja-efectivo', '10000')
    fireEvent.click(screen.getByTestId('pos-open-caja-confirm'))

    await waitFor(() => expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull())
    // `refresh()` del contexto + el evento que escucha el resto de la app.
    expect(lecturasDeCaja()).toBeGreaterThan(lecturasAntes)
    expect(eventosDeCaja).toBeGreaterThanOrEqual(1)
    // El prerequisito desapareció y el POS sigue abierto.
    await waitFor(() => expect(screen.queryByTestId('pos-caja-closed')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    expect(onCreado).not.toHaveBeenCalled()
    expect(screen.getByText('Caja abierta. Ya podés cobrar.')).toBeInTheDocument()

    // P0: nada de lo cargado cambió.
    expect(fotoDeLaVenta()).toEqual(antes)
    expect(antes.lineas).toEqual(ITEMS.map(i => i.descripcion))
    expect(antes.pagos).toEqual(['50000'])
    expect(antes.observaciones).toBe('Entregar con funda')
    expect(antes.tipoFiscal).toBe('true')
    expect(antes.cliente).toBe(true)

    // Y abrir la caja NO cobró.
    expect(estado.crear).toEqual([])
    expect(screen.queryByTestId('comprobante-success-screen')).toBeNull()
    expect(readPendingCheckout(BIZ_ID)).toBeNull()
  })

  it('el cobro sigue necesitando su propio gesto, y entonces sale con la venta completa', async () => {
    await montar('owner')
    await armarVenta()
    cobrar()
    await screen.findByTestId('pos-open-caja-dialog')
    fireEvent.click(screen.getByTestId('pos-open-caja-confirm'))
    await waitFor(() => expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull())

    // Doble toque: el botón del diálogo ocupa el lugar de «Cobrar» en el
    // teléfono. El segundo toque NO puede cobrar.
    cobrar()
    fireEvent.keyDown(document, { key: 'F4' })
    await esperar(100)
    expect(estado.crear).toEqual([])

    // Pasada la ventana, «Cobrar» funciona como siempre.
    await esperar(800)
    cobrar()
    await waitFor(() => expect(estado.crear).toHaveLength(1))
    const venta = estado.crear[0]
    expect(venta).toMatchObject({
      business_id: BIZ_ID,
      caja_id: CAJA_ID,
      customer_id: CLIENTE.id,
      order_id: ORDER_ID,
      tipo: 'factura_c',
      observaciones: 'Entregar con funda',
      skip_finance_entry: false,
    })
    expect((venta.items as Array<{ descripcion: string; cantidad: number; precio_unitario: number }>)
      .map(i => [i.descripcion, i.cantidad, i.precio_unitario]))
      .toEqual(ITEMS.map(i => [i.descripcion, i.cantidad, i.precio_unitario]))
    expect(venta.pagos).toEqual([expect.objectContaining({ payment_method: 'efectivo', amount: 50000 })])
    expect(typeof venta.idempotency_key).toBe('string')
  })

  it('cancelar el diálogo tampoco toca la venta, y no llama a nada', async () => {
    await montar('owner')
    const antes = await armarVenta()
    cobrar()
    await screen.findByTestId('pos-open-caja-dialog')
    tipear('pos-open-caja-efectivo', '999')
    fireEvent.click(screen.getByTestId('pos-open-caja-cancel'))

    await waitFor(() => expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull())
    expect(aperturas()).toEqual([])
    expect(fotoDeLaVenta()).toEqual(antes)
    expect(screen.getByTestId('pos-open-caja-button')).toBeInTheDocument()

    // Reabrir empieza en blanco: lo tipeado en un intento abandonado no reaparece.
    fireEvent.click(screen.getByTestId('pos-open-caja-button'))
    await screen.findByTestId('pos-open-caja-dialog')
    expect((screen.getByTestId('pos-open-caja-efectivo') as HTMLInputElement).value).toBe('')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('6 · carrera: otro usuario abrió la caja', () => {
  it('«Ya hay una caja abierta» + caja efectivamente abierta = prerequisito resuelto, sin error', async () => {
    estado.openRpc = () => {
      estado.cajaAbierta = true            // el usuario B llegó antes
      return { data: { ok: false, error: 'Ya hay una caja abierta' }, error: null }
    }
    await montar('owner')
    const antes = await armarVenta()
    cobrar()
    await screen.findByTestId('pos-open-caja-dialog')
    tipear('pos-open-caja-efectivo', '7000')
    fireEvent.click(screen.getByTestId('pos-open-caja-confirm'))

    await waitFor(() => expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull())
    expect(screen.queryByTestId('pos-open-caja-error')).toBeNull()
    await waitFor(() => expect(screen.queryByTestId('pos-caja-closed')).toBeNull())
    // Se dice la verdad: no la abrió este usuario, así que sus saldos no se aplicaron.
    expect(screen.getByText('La caja ya estaba abierta. Ya podés cobrar.')).toBeInTheDocument()
    expect(eventosDeCaja).toBeGreaterThanOrEqual(1)
    expect(fotoDeLaVenta()).toEqual(antes)
    expect(estado.crear).toEqual([])
  })

  it('si el servidor dice «abierta» pero no se puede confirmar, NO se da por resuelto', async () => {
    estado.openRpc = () => ({ data: { ok: false, error: 'Ya hay una caja abierta' }, error: null })
    await montar('owner')
    fireEvent.click(await screen.findByTestId('pos-open-caja-button'))
    await screen.findByTestId('pos-open-caja-dialog')
    fireEvent.click(screen.getByTestId('pos-open-caja-confirm'))

    expect(await screen.findByTestId('pos-open-caja-error')).toHaveTextContent(/no se pudo confirmar/i)
    expect(screen.getByTestId('pos-open-caja-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('pos-caja-closed')).toBeInTheDocument()
  })

  it('si la caja aparece abierta mientras el diálogo está a la vista, el diálogo se retira solo', async () => {
    await montar('owner')
    const antes = await armarVenta()
    cobrar()
    await screen.findByTestId('pos-open-caja-dialog')

    // Otra pestaña abrió la caja; al volver el foco el contexto se refresca.
    estado.cajaAbierta = true
    fireEvent(window, new Event('focus'))

    await waitFor(() => expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull())
    expect(aperturas()).toEqual([])
    expect(fotoDeLaVenta()).toEqual(antes)
    expect(estado.crear).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('7 · error real', () => {
  it('el servidor rechaza por permisos (42501): se queda en el diálogo con el texto canónico', async () => {
    estado.openRpc = () => ({ data: null, error: { code: '42501', message: 'FORBIDDEN' } })
    await montar('owner')
    const antes = await armarVenta()
    cobrar()
    await screen.findByTestId('pos-open-caja-dialog')
    fireEvent.click(screen.getByTestId('pos-open-caja-confirm'))

    const error = await screen.findByTestId('pos-open-caja-error')
    expect(error).toHaveAttribute('role', 'alert')
    expect(error).toHaveTextContent('Tu usuario no tiene permiso para esta operación financiera.')
    // No se disfraza de éxito ni de carrera.
    expect(screen.getByTestId('pos-open-caja-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('pos-caja-closed')).toBeInTheDocument()
    expect(eventosDeCaja).toBe(0)
    expect(estado.crear).toEqual([])
    expect(fotoDeLaVenta()).toEqual(antes)
    // El botón vuelve a estar disponible para reintentar.
    expect(screen.getByTestId('pos-open-caja-confirm')).not.toBeDisabled()
  })

  it('un error interno no filtra SQL ni nombres de funciones a la pantalla', async () => {
    estado.openRpc = () => ({ data: { ok: false, error: 'INSERT INTO cajas ... PL/pgSQL function public.open_cash_session_atomic(uuid) line 44' }, error: null })
    await montar('owner')
    fireEvent.click(await screen.findByTestId('pos-open-caja-button'))
    await screen.findByTestId('pos-open-caja-dialog')
    fireEvent.click(screen.getByTestId('pos-open-caja-confirm'))

    const error = await screen.findByTestId('pos-open-caja-error')
    expect(error.textContent).not.toMatch(/INSERT|PL\/pgSQL|open_cash_session_atomic|cajas/)
    expect(error).toHaveTextContent(/no se pudo completar/i)
    expect(screen.getByTestId('pos-open-caja-dialog')).toBeInTheDocument()
  })

  it('una caída de red no muestra el error crudo del navegador', async () => {
    estado.openRpc = () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } })
    await montar('owner')
    fireEvent.click(await screen.findByTestId('pos-open-caja-button'))
    await screen.findByTestId('pos-open-caja-dialog')
    fireEvent.click(screen.getByTestId('pos-open-caja-confirm'))

    const error = await screen.findByTestId('pos-open-caja-error')
    expect(error.textContent).not.toMatch(/TypeError|Failed to fetch/)
    expect(screen.getByTestId('pos-open-caja-dialog')).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('8 · sin navegación', () => {
  // Estos tests montan el POS SIN router: cualquier `useNavigate` rompería el
  // render de todo el archivo. Los controles de fuente lo dejan escrito.
  const modal = leerCodigo('src/components/comprobantes/ComprobanteProModal.tsx')
  const dialogo = leerCodigo('src/components/caja/InlineCashOpenDialog.tsx')
  const servicio = leerCodigo('src/services/cashSessionService.ts')

  it('ni el POS ni el diálogo ni el servicio resuelven esto yendo a /caja', () => {
    for (const [nombre, src] of [['modal', modal], ['dialogo', dialogo], ['servicio', servicio]] as const) {
      expect(src, `${nombre} navega`).not.toMatch(/useNavigate|navigate\(|<Link\b|<Navigate\b|react-router/)
      expect(src, `${nombre} apunta a /caja`).not.toMatch(/['"`]\/caja\b/)
      expect(src, `${nombre} usa location`).not.toMatch(/location\.(href|assign|replace)/)
    }
  })

  it('la apertura inline no escribe en `cajas` ni calcula saldos: sólo la RPC', () => {
    for (const src of [dialogo, servicio]) {
      // Acceso a una tabla (`.from('x')`), no `Array.from(...)`.
      expect(src).not.toMatch(/\.from\(\s*['"`]/)
      expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/)
    }
    expect(servicio).toMatch(/supabase\.rpc\('open_cash_session_atomic'/)
    // El diálogo no habla con Supabase: pasa por el servicio.
    expect(dialogo).not.toMatch(/supabase/)
  })

  it('la capacidad sale de `canUseCaja`, nunca de un rol escrito a mano', () => {
    expect(modal).toMatch(/const \{ isOpen: cajaIsOpen, cajaId, canUseCaja \} = useCaja\(\)/)
    expect(dialogo).toMatch(/const \{ canUseCaja, refresh \} = useCaja\(\)/)
    for (const src of [dialogo, servicio]) {
      expect(src).not.toMatch(/role\s*[!=]==?\s*['"]/)
      expect(src).not.toMatch(/['"](owner|admin|cashier|manager|sales|tech|viewer)['"]/)
    }
    // El bloque del POS que decide el prerequisito tampoco ramifica por rol.
    const bloque = modal.slice(modal.indexOf('if (!cajaIsOpen && !skipFinanceEntry) {'), modal.indexOf('const pagosConMonto'))
    expect(bloque).toMatch(/if \(canUseCaja\) \{ setShowOpenCaja\(true\); return \}/)
    expect(bloque).not.toMatch(/role|isOwner/)
  })

  it('el checkout NO empieza antes de resolver la caja', () => {
    // El prerequisito corta ANTES de la key de idempotencia y del servicio.
    const iPrereq = modal.indexOf('if (!cajaIsOpen && !skipFinanceEntry) {')
    const iKey = modal.indexOf('getOrCreateIdempotencyKey(businessId, requestHash)')
    const iCrear = modal.indexOf('comprobanteService.crear(input)')
    expect(iPrereq).toBeGreaterThan(0)
    expect(iPrereq).toBeLessThan(iKey)
    expect(iKey).toBeLessThan(iCrear)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('regresión funcional', () => {
  it('caja ya abierta: no hay aviso y «Cobrar» cobra como siempre, atado a la caja', async () => {
    estado.cajaAbierta = true
    await montar('owner')
    await armarVenta()
    await waitFor(() => expect(lecturasDeCaja()).toBeGreaterThan(0))
    await waitFor(() => expect(screen.queryByTestId('pos-caja-closed')).toBeNull())

    cobrar()
    await waitFor(() => expect(estado.crear).toHaveLength(1))
    expect(estado.crear[0]).toMatchObject({ caja_id: CAJA_ID, order_id: ORDER_ID, customer_id: CLIENTE.id })
    expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull()
    expect(aperturas()).toEqual([])
  })

  it('`skipFinanceEntry`: no se exige caja, ni aviso ni diálogo', async () => {
    await montar('owner', { props: { skipFinanceEntry: true } })
    await armarVenta()
    expect(screen.queryByTestId('pos-caja-closed')).toBeNull()
    expect(screen.queryByTestId('pos-open-caja-button')).toBeNull()

    cobrar()
    await waitFor(() => expect(estado.crear).toHaveLength(1))
    expect(estado.crear[0]).toMatchObject({ skip_finance_entry: true, caja_id: null })
    expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull()
    expect(aperturas()).toEqual([])
  })

  it('sales con la caja abierta: la conoce y vende atado a ella, sin poder abrirla', async () => {
    estado.cajaAbierta = true
    await montar('sales')
    await armarVenta()
    await waitFor(() => expect(lecturasDeCaja()).toBeGreaterThan(0))
    await waitFor(() => expect(screen.queryByTestId('pos-caja-closed')).toBeNull())

    cobrar()
    await waitFor(() => expect(estado.crear).toHaveLength(1))
    expect(estado.crear[0]).toMatchObject({ caja_id: CAJA_ID })
    expect(aperturas()).toEqual([])
  })

  // La matriz sale de `usePermissions` real: defaults del rol + overrides.
  const MATRIZ: Array<[string, string, unknown, boolean]> = [
    ['owner',                               'owner',   null,               true],
    ['admin',                               'admin',   null,               true],
    ['cashier (finance por default)',       'cashier', null,               true],
    ['sales (comprobantes sí, finance no)', 'sales',   null,               false],
    ['tech',                                'tech',    null,               false],
    ['tech con override finance:true',      'tech',    { finance: true },  true],
    ['sales con override finance:true',     'sales',   { finance: true },  true],
    ['cashier con override finance:false',  'cashier', { finance: false }, false],
    ['admin con override finance:false',    'admin',   { finance: false }, false],
  ]
  for (const [nombre, role, permissions, puede] of MATRIZ) {
    it(`${nombre} → ${puede ? 'puede abrir la caja desde el POS' : 'sólo ve la explicación'}`, async () => {
      await montar(role, { permissions })
      await waitFor(() =>
        expect(screen.getByTestId('pos-caja-closed')).toHaveAttribute('data-caja-action', puede ? 'open' : 'none'))
      expect(screen.queryByTestId('pos-open-caja-button') !== null).toBe(puede)

      cobrar()
      if (puede) {
        expect(await screen.findByTestId('pos-open-caja-dialog')).toBeInTheDocument()
      } else {
        await esperar(40)
        expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull()
      }
      expect(aperturas()).toEqual([])
      expect(estado.crear).toEqual([])
    })
  }

  it('entrada desde /comprobantes (sin orden ni ítems): el mismo aviso y el mismo diálogo', async () => {
    await montar('owner', { props: { initialItems: undefined, initialClienteId: undefined, orderId: undefined } })
    fireEvent.click(await screen.findByTestId('pos-open-caja-button'))
    expect(await screen.findByTestId('pos-open-caja-dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('pos-open-caja-confirm'))
    await waitFor(() => expect(aperturas()).toHaveLength(1))
    await waitFor(() => expect(screen.queryByTestId('pos-caja-closed')).toBeNull())
    expect(estado.crear).toEqual([])
  })

  it('todas las entradas al cobro montan el MISMO POS; la apertura inline tiene un único camino', () => {
    for (const pagina of ['src/pages/OrderDetail.tsx', 'src/pages/Comprobantes.tsx', 'src/pages/Mayorista.tsx']) {
      expect(leer(pagina), pagina).toMatch(
        /import \{ ComprobanteProModal as ModalCrearComprobante \} from '\.\.\/components\/comprobantes\/ComprobanteProModal'/)
    }
    // Sólo dos lugares conocen la RPC de apertura: la pantalla Caja (sin
    // cambios en este lote) y el servicio del diálogo. Un tercero sería un
    // camino paralelo.
    const fuentes = [
      'src/pages/CajaPage.tsx', 'src/services/cashSessionService.ts',
      'src/components/caja/InlineCashOpenDialog.tsx',
      'src/components/comprobantes/ComprobanteProModal.tsx',
      'src/components/comprobantes/ModalCrearComprobante.tsx',
      'src/components/cobro/ModalCobro.tsx',
      'src/pages/OrderDetail.tsx', 'src/pages/Comprobantes.tsx', 'src/pages/Mayorista.tsx',
    ]
    const conRpc = fuentes.filter(f => /open_cash_session_atomic/.test(leerCodigo(f)))
    expect(conRpc.sort()).toEqual(['src/pages/CajaPage.tsx', 'src/services/cashSessionService.ts'])
  })

  it('el total que se ve es el de la venta: abrir la caja no lo recalcula', async () => {
    await montar('owner')
    await screen.findByText(CLIENTE.name)
    const total = screen.getByTestId('comprobante-total').textContent
    expect(total).toBe('$' + TOTAL.toLocaleString('es-AR'))
    fireEvent.click(screen.getByTestId('pos-open-caja-button'))
    await screen.findByTestId('pos-open-caja-dialog')
    tipear('pos-open-caja-efectivo', '123456')
    fireEvent.click(screen.getByTestId('pos-open-caja-confirm'))
    await waitFor(() => expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull())
    expect(screen.getByTestId('comprobante-total').textContent).toBe(total)
  })
})
