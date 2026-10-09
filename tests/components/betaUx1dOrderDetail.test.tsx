// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1D · Detalle de orden: una primaria visible y secundarias en un menú.
//
// En mobile el encabezado deja UNA acción a la vista (Generar / Ver Comprobante)
// y mueve Imprimir, WhatsApp y Garantía a «Más acciones». Qué se ve en cada
// ancho lo decide el CSS (lo mide `tests/e2e/m7/mobile-orders.spec.ts`); acá se
// fija el contrato que no depende del CSS:
//   · cuál es la primaria según el estado de la orden, y que no exista cuando
//     no se puede facturar de verdad (SEC-08A);
//   · que el menú lleve las mismas acciones que el encabezado de escritorio y
//     que cada una dispare EXACTAMENTE lo mismo (misma vista previa, misma
//     plantilla de WhatsApp, mismo alta de garantía);
//   · que la grilla del contenido y los bloques de ancho completo vivan en
//     clases y no en estilos en línea que una media query no puede cambiar.
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderDetailSimple } from '../../src/hooks/useOrderSimple'

const state = vi.hoisted(() => ({
  order: {} as unknown,
  comprobantes: [] as unknown[],
  refresh: vi.fn(),
}))

vi.mock('../../src/hooks/useOrderSimple', () => ({
  useOrderSimple: () => ({ order: state.order, loading: false, error: null, refresh: state.refresh }),
}))
vi.mock('../../src/hooks/useComprobantes', () => ({
  useComprobantes: () => ({ comprobantes: state.comprobantes, cargarComprobantesByOrder: vi.fn() }),
}))
vi.mock('../../src/hooks/useWarranties', () => ({ useWarranties: () => ({ addWarranty: vi.fn() }) }))
vi.mock('../../src/hooks/useOrderCanonicalBalance', () => ({
  useOrderCanonicalBalance: () => ({ disponible: false }),
}))
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }),
  },
}))

// Los hijos se reemplazan por sondas: lo que se mide es el cableado del
// encabezado de la página, no cada tarjeta.
vi.mock('../../src/components/order/StatusChange', () => ({ StatusChange: () => <div data-testid="probe-status-change" /> }))
vi.mock('../../src/components/order/DeviceLockCard', () => ({ DeviceLockCard: () => <div className="card" data-testid="probe-device-lock" /> }))
vi.mock('../../src/components/order/OrderItemsCard', () => ({ OrderItemsCard: () => <div data-testid="probe-items" /> }))
vi.mock('../../src/components/orders/OrderFinancialSummary', () => ({ OrderFinancialSummary: () => <div data-testid="probe-financial" /> }))
vi.mock('../../src/components/order/DocumentUploader', () => ({ DocumentUploader: () => <div data-testid="probe-documents" /> }))
vi.mock('../../src/components/order/NotificationCard', () => ({ NotificationCard: () => <div data-testid="probe-notification" /> }))
vi.mock('../../src/components/whatsapp/WhatsAppHistorial', () => ({ WhatsAppHistorial: () => null }))
vi.mock('../../src/components/print/OrderPrintPreviewModal', () => ({
  OrderPrintPreviewModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="probe-print-open" /> : null),
}))
vi.mock('../../src/components/comprobantes/ComprobanteProModal', () => ({
  ComprobanteProModal: ({ isOpen, orderId }: { isOpen: boolean; orderId?: string }) =>
    (isOpen ? <div data-testid="probe-pos-open" data-order={orderId} /> : null),
}))
vi.mock('../../src/components/warranties/WarrantyFormModal', () => ({
  WarrantyFormModal: ({ open }: { open: boolean }) => (open ? <div data-testid="probe-warranty-open" /> : null),
}))
vi.mock('../../src/components/whatsapp/WhatsAppPreviewModal', () => ({
  WhatsAppPreviewModal: ({ isOpen, defaultTemplateKey }: { isOpen: boolean; defaultTemplateKey?: string }) =>
    (isOpen ? <div data-testid="probe-whatsapp-open" data-template={defaultTemplateKey} /> : null),
}))

import { OrderDetail } from '../../src/pages/OrderDetail'

const ORDER: OrderDetailSimple = {
  id: 'abcdef12-0000-0000-0000-000000000001', status: 'repair', priority: 'medium', amountsAuthorized: true,
  customer_id: 'cust-1', device_id: 'dev-1',
  created_at: '2026-09-01T12:00:00Z', updated_at: '2026-09-01T12:00:00Z',
  customer: { id: 'cust-1', name: 'Cliente de prueba', phone: '3510000001' },
  device: { id: 'dev-1', type: 'smartphone', brand: 'Samsung', model: 'Galaxy S24 Ultra 5G 512GB', issue: 'No enciende' },
  history: [],
} as OrderDetailSimple

const COMPROBANTE = { id: 'comp-1', tipo: 'remito', numero: '0001-00000001', estado: 'emitido', total: 1000 }

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={[`/orders/${ORDER.id}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/orders/:id" element={<OrderDetail />} />
        <Route path="/comprobantes/:id" element={<div data-testid="comprobante-probe" />} />
      </Routes>
    </MemoryRouter>,
  )
}

const abrirMenu = () => fireEvent.click(screen.getByTestId('order-mobile-actions-menu'))
const elegir = (nombre: string) => fireEvent.click(screen.getByRole('menuitem', { name: nombre }))

beforeEach(() => {
  state.order = { ...ORDER }
  state.comprobantes = []
  state.refresh.mockReset()
})

describe('BETA-UX-1D · detalle de orden · acción principal', () => {
  it('sin comprobante y facturable: «Generar Comprobante», que abre el POS de la orden', () => {
    renderDetail()

    const primaria = screen.getAllByTestId('order-primary-action')
    expect(primaria).toHaveLength(1)
    expect(primaria[0]).toHaveTextContent('Generar Comprobante')
    expect(primaria[0].tagName).toBe('BUTTON')

    fireEvent.click(primaria[0])
    expect(screen.getByTestId('probe-pos-open')).toHaveAttribute('data-order', ORDER.id)
  })

  it('con comprobante: «Ver Comprobante», que lleva a ese comprobante', () => {
    state.comprobantes = [COMPROBANTE]
    renderDetail()

    const primaria = screen.getAllByTestId('order-primary-action')
    expect(primaria).toHaveLength(1)
    expect(primaria[0]).toHaveTextContent('Ver Comprobante')
    expect(primaria[0]).toHaveAttribute('href', '/comprobantes/comp-1')
    expect(screen.queryByRole('button', { name: 'Generar Comprobante' })).not.toBeInTheDocument()
  })

  it('sin importes autorizados no hay acción de facturar: no se ofrece un comprobante vacío', () => {
    state.order = { ...ORDER, amountsAuthorized: false }
    renderDetail()

    expect(screen.queryByTestId('order-primary-action')).not.toBeInTheDocument()
    // El menú de secundarias sigue estando: imprimir y avisar no dependen de los importes.
    expect(screen.getByTestId('order-mobile-actions-menu')).toBeInTheDocument()
  })

  it('la primaria es UN elemento compartido por los dos anchos, fuera del grupo que mobile oculta', () => {
    renderDetail()

    const primaria = screen.getByTestId('order-primary-action')
    const acciones = primaria.closest('.order-detail-header__actions') as HTMLElement
    expect(acciones).not.toBeNull()
    expect(primaria.parentElement).toBe(acciones)
    expect(document.querySelector('.order-detail-header__secondary')!.contains(primaria)).toBe(false)
    expect(document.querySelector('.order-detail-header__overflow')!.contains(primaria)).toBe(false)
  })
})

describe('BETA-UX-1D · detalle de orden · secundarias en «Más acciones»', () => {
  it('el menú lleva Imprimir, las cuatro plantillas de WhatsApp y Garantía', () => {
    renderDetail()

    abrirMenu()
    const menu = screen.getByRole('menu', { name: 'Más acciones de la orden' })
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Imprimir',
      'WhatsApp: Orden recibida',
      'WhatsApp: Presupuesto listo',
      'WhatsApp: Equipo listo para retirar',
      'WhatsApp: Mensaje libre',
      'Garantía',
    ])
  })

  it('Imprimir abre la misma vista previa que el botón de escritorio', () => {
    const viaMenu = renderDetail()
    abrirMenu()
    elegir('Imprimir')
    expect(screen.getByTestId('probe-print-open')).toBeInTheDocument()
    viaMenu.unmount()

    renderDetail()
    expect(screen.queryByTestId('probe-print-open')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('order-print-preview-button'))
    expect(screen.getByTestId('probe-print-open')).toBeInTheDocument()
  })

  it('Garantía abre el mismo alta que el botón de escritorio', () => {
    const viaMenu = renderDetail()
    abrirMenu()
    elegir('Garantía')
    expect(screen.getByTestId('probe-warranty-open')).toBeInTheDocument()
    viaMenu.unmount()

    renderDetail()
    fireEvent.click(screen.getByTestId('order-create-warranty-button'))
    expect(screen.getByTestId('probe-warranty-open')).toBeInTheDocument()
  })

  it.each([
    ['WhatsApp: Orden recibida', 'order-whatsapp-received', 'received'],
    ['WhatsApp: Presupuesto listo', 'order-whatsapp-quote', 'waiting_approval'],
    ['WhatsApp: Equipo listo para retirar', 'order-whatsapp-ready', 'ready_pickup'],
    ['WhatsApp: Mensaje libre', 'order-whatsapp-free', 'free_message'],
  ])('«%s» abre el preview con la misma plantilla que la opción de escritorio', (item, desktopTestId, template) => {
    const viaMenu = renderDetail()
    abrirMenu()
    elegir(item)
    expect(screen.getByTestId('probe-whatsapp-open')).toHaveAttribute('data-template', template)
    viaMenu.unmount()

    // Escritorio: el desplegable de siempre, con sus testids de siempre.
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: /^WhatsApp$/ }))
    fireEvent.click(screen.getByTestId(desktopTestId))
    expect(screen.getByTestId('probe-whatsapp-open')).toHaveAttribute('data-template', template)
  })

  it('las acciones de escritorio siguen ahí, agrupadas en el contenedor que mobile oculta', () => {
    renderDetail()

    const secundarias = document.querySelector('.order-detail-header__secondary') as HTMLElement
    expect(within(secundarias).getByTestId('order-print-preview-button')).toHaveTextContent('Imprimir')
    expect(within(secundarias).getByRole('button', { name: /^WhatsApp$/ })).toBeInTheDocument()
    expect(within(secundarias).getByTestId('order-create-warranty-button')).toHaveTextContent('Garantía')
    // Y el disparador del menú vive en el contenedor que escritorio oculta.
    const overflow = document.querySelector('.order-detail-header__overflow') as HTMLElement
    expect(overflow.contains(screen.getByTestId('order-mobile-actions-menu'))).toBe(true)
    expect(secundarias.contains(screen.getByTestId('order-mobile-actions-menu'))).toBe(false)
  })

  it('el menú se cierra con Escape y devuelve el foco al disparador', () => {
    renderDetail()

    const disparador = screen.getByTestId('order-mobile-actions-menu')
    expect(disparador).toHaveAttribute('aria-haspopup', 'menu')
    expect(disparador).toHaveAttribute('aria-expanded', 'false')
    abrirMenu()
    expect(disparador).toHaveAttribute('aria-expanded', 'true')
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0])

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(disparador).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(disparador)
  })
})

describe('BETA-UX-1D · detalle de orden · la grilla vive en CSS', () => {
  it('la grilla principal no trae columnas en línea', () => {
    renderDetail()

    const grilla = screen.getByTestId('order-detail-grid')
    expect(grilla).toHaveClass('order-detail-grid')
    expect(grilla.getAttribute('style') ?? '').not.toMatch(/grid|display/)
  })

  it('Cliente y Dispositivo son celdas simples; los bloques grandes ocupan la fila entera por clase', () => {
    state.comprobantes = [COMPROBANTE]
    renderDetail()

    for (const testId of ['order-customer-card', 'order-device-card']) {
      const tarjeta = screen.getByTestId(testId)
      expect(tarjeta.parentElement).toBe(screen.getByTestId('order-detail-grid'))
      expect(tarjeta).not.toHaveClass('order-detail-grid__full')
    }
    for (const testId of ['order-comprobante-card', 'order-items-block', 'order-financial-block']) {
      const bloque = screen.getByTestId(testId)
      expect(bloque.parentElement).toBe(screen.getByTestId('order-detail-grid'))
      expect(bloque).toHaveClass('order-detail-grid__full')
      expect(bloque.getAttribute('style') ?? '').not.toContain('grid-column')
    }
    // Mismo orden semántico: Cliente → Dispositivo → Acceso → Comprobante → Ítems → Finanzas.
    const orden = Array.from(screen.getByTestId('order-detail-grid').children).map(el => el.getAttribute('data-testid'))
    expect(orden.filter(Boolean)).toEqual([
      'order-customer-card', 'order-device-card', 'probe-device-lock',
      'order-comprobante-card', 'order-items-block', 'order-financial-block',
    ])
  })

  it.each([
    ['Notas', 'Notas internas'],
    ['Documentos', null],
    ['Comunicación', null],
    ['Historial', 'Historial de Estados'],
  ])('la pestaña %s ocupa la fila entera sin `grid-column` en línea', (pestana, titulo) => {
    renderDetail()

    fireEvent.click(screen.getByRole('button', { name: pestana, exact: true }))
    const bloques = Array.from(screen.getByTestId('order-detail-grid').children) as HTMLElement[]
    expect(bloques.length).toBeGreaterThan(0)
    for (const bloque of bloques) {
      expect(bloque).toHaveClass('order-detail-grid__full')
      expect(bloque.getAttribute('style') ?? '').not.toContain('grid-column')
    }
    if (titulo) expect(screen.getByText(titulo)).toBeInTheDocument()
  })

  it('Marca y Modelo usan la mini-grilla responsive; el modelo largo se muestra entero', () => {
    renderDetail()

    const modelo = screen.getByTestId('order-device-model')
    expect(modelo).toHaveTextContent('Galaxy S24 Ultra 5G 512GB')
    const mini = modelo.closest('.order-device-grid') as HTMLElement
    expect(mini).not.toBeNull()
    expect(mini.getAttribute('style')).toBeNull()
    expect(screen.getByTestId('order-device-card').querySelector('.order-detail-wrap')).not.toBeNull()
  })
})
