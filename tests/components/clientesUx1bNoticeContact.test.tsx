// ─────────────────────────────────────────────────────────────────────────────
// CLIENTES-UX-1B · Contacto alternativo para avisos + destinatario por orden.
//
//   A · reglas del core (validación, payloads, compatibilidad sin migración)
//   B · formulario compartido (alta, edición)
//   C · resolución del destinatario (copia de la orden vs. ficha)
//   D · panel «Avisos por WhatsApp» de la orden
//   E · Nueva orden: elegir a quién avisar
//   F · WhatsApp: preview y envío automático usan el destinatario
// ─────────────────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  create: vi.fn(),
  intakeCreate: vi.fn(),
  upload: vi.fn(),
  searchCustomers: vi.fn(),
  setRecipient: vi.fn(),
  loadNotice: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('../../src/services/api', () => ({
  customersService: { update: mocks.update, create: mocks.create },
}))
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1', role: 'owner', isOwner: true, hasBusinessAccess: true, profile: { permissions: null } }),
}))
vi.mock('../../src/hooks/useSubscription', async () => {
  const { resolveEntitlement } = await vi.importActual<typeof import('../../src/lib/entitlements')>('../../src/lib/entitlements')
  const subscription = { subscription_status: 'active', subscription_plan: 'full' } as const
  const { hasFeature } = resolveEntitlement(subscription)
  return { useSubscription: () => ({ hasFeature, subscription, loading: false }) }
})
vi.mock('../../src/features/order-notify/service', () => ({
  setOrderNotificationRecipient: mocks.setRecipient,
  loadCustomerNoticeContact: mocks.loadNotice,
  loadOrderNotificationRecipient: async () => ({ row: null, available: true }),
  notificationRecipientErrorMessage: () => 'error',
}))
vi.mock('../../src/services/posCustomerSearchService', () => ({ searchPosCustomers: mocks.searchCustomers }))
vi.mock('../../src/services/deviceCatalogService', () => ({
  DEFAULT_BRANDS: ['Samsung'], loadBrandOptions: async () => ['Samsung'], loadModelOptions: async () => [], ensureBrandAndModel: async () => null,
}))
vi.mock('../../src/features/order-intake/service', () => ({
  createOrderIntake: mocks.intakeCreate, uploadIntakePhotos: mocks.upload, loadAssignableProfiles: async () => [],
}))
// F3: Cloud API conectada (es el único caso en que hay envío automático).
vi.mock('../../src/services/whatsappCloudService', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/whatsappCloudService')>('../../src/services/whatsappCloudService')
  return { ...actual, getConnection: async () => ({ id: 'conn' }) }
})
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mocks.navigate }
})

import {
  EMPTY_CUSTOMER_CORE,
  customerCoreFromRecord,
  toCreatePayload,
  toUpdatePayload,
  validateCustomerCore,
  validateNoticeContact,
  CustomerEditDialog,
} from '../../src/features/customer-core'
import {
  alternateDiffersFromCustomer,
  resolveNotificationRecipient,
  type UseOrderNotificationRecipientReturn,
} from '../../src/features/order-notify'
import { NotificationRecipientPanel } from '../../src/components/order/NotificationRecipientPanel'
import { NewCustomer } from '../../src/pages/NewCustomer'
import { NewOrder } from '../../src/pages/NewOrder'
import { buildOrderVars, whatsappService } from '../../src/services/whatsappService'

const base = { ...EMPTY_CUSTOMER_CORE, name: 'Juan Pérez', phone: '3511234567' }

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset())
})

describe('A · reglas del core', () => {
  it('A1 · nombre y teléfono van juntos; el teléfono tiene que servir para WhatsApp', () => {
    expect(validateNoticeContact('', '')).toEqual({})
    expect(validateNoticeContact('María', '').noticePhone).toMatch(/Cargá el teléfono/)
    expect(validateNoticeContact('', '3519998888').noticeName).toMatch(/Indicá a quién/)
    expect(validateNoticeContact('María', '351-ABC').noticePhone).toMatch(/teléfono válido/)
    expect(validateNoticeContact('María', '12345').noticePhone).toMatch(/teléfono válido/)
    expect(validateNoticeContact('María', '351 15 555-1234')).toEqual({})
    expect(validateNoticeContact('María', '+54 9 351 555-1234')).toEqual({})
    expect(validateNoticeContact('Contacto Intl', '+34 612 345 678')).toEqual({})
    expect(validateNoticeContact('M'.repeat(121), '3519998888').noticeName).toMatch(/120/)
  })

  it('A2 · no puede ser el mismo teléfono principal', () => {
    expect(validateNoticeContact('María', '+54 9 351 123-4567', '3511234567').noticePhone).toBe('Es el mismo teléfono principal del cliente.')
  })

  it('A3 · el alta manda el contacto sólo si está completo, y limpio', () => {
    expect(toCreatePayload(base, 'full')).not.toHaveProperty('notification_contact_name')
    const payload = toCreatePayload({ ...base, noticeName: '  María   Hija ', noticePhone: ' 351 15 555-1234 ' }, 'full')
    expect(payload).toMatchObject({ notification_contact_name: 'María Hija', notification_contact_phone: '351 15 555-1234' })
    // No reutiliza el contacto mayorista.
    expect(payload.contact_person).toBeUndefined()
  })

  it('A4 · la edición no nombra las columnas si no hay nada que escribir ni borrar (base sin migrar)', () => {
    const stored = customerCoreFromRecord({ name: 'Juan', phone: '351' })
    expect(toUpdatePayload(stored, 'full', stored)).not.toHaveProperty('notification_contact_name')
  })

  it('A5 · la edición escribe el contacto, o lo borra con null si la fila tenía uno', () => {
    const stored = customerCoreFromRecord({ name: 'Juan', phone: '351', notification_contact_name: 'María', notification_contact_phone: '3519998888' })
    expect(stored).toMatchObject({ noticeName: 'María', noticePhone: '3519998888' })
    expect(toUpdatePayload({ ...stored, noticePhone: '3517776666' }, 'full', stored))
      .toMatchObject({ notification_contact_name: 'María', notification_contact_phone: '3517776666' })
    expect(toUpdatePayload({ ...stored, noticeName: '', noticePhone: '' }, 'full', stored))
      .toMatchObject({ notification_contact_name: null, notification_contact_phone: null })
  })

  it('A6 · un mayorista sin acceso (`preserved`) también edita su contacto para avisos', () => {
    const stored = customerCoreFromRecord({ name: 'Mayorista', phone: '351', customer_type: 'mayorista', business_name: 'Demo SRL' })
    const payload = toUpdatePayload({ ...stored, noticeName: 'Depósito', noticePhone: '3516667777' }, 'preserved', stored)
    expect(payload).toMatchObject({ notification_contact_name: 'Depósito', notification_contact_phone: '3516667777' })
    expect(payload).not.toHaveProperty('customer_type')
    expect(payload).not.toHaveProperty('business_name')
  })

  it('A7 · un contacto inválido bloquea igual en alta y en edición', () => {
    const invalid = { ...base, noticeName: 'María', noticePhone: '12' }
    expect(validateCustomerCore(invalid, 'create').noticePhone).toBeTruthy()
    expect(validateCustomerCore(invalid, 'update').noticePhone).toBeTruthy()
  })
})

describe('B · formulario compartido', () => {
  it('B1 · alta: la sección está cerrada, se abre y se guarda con el cliente', async () => {
    mocks.create.mockResolvedValue({ id: 'c-new' })
    render(<MemoryRouter><NewCustomer /></MemoryRouter>)

    const toggle = screen.getByTestId('customer-notice-toggle')
    // NewCustomer abre los datos opcionales: el contacto también se ve.
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'Juan Pérez' } })
    fireEvent.change(screen.getByLabelText('Teléfono'), { target: { value: '3511234567' } })
    fireEvent.change(screen.getByLabelText('Nombre del contacto'), { target: { value: 'María Hija' } })
    fireEvent.change(screen.getByLabelText('Teléfono para avisos'), { target: { value: '351 15 555-1234' } })
    fireEvent.click(screen.getByTestId('customer-save-button'))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      phone: '3511234567', notification_contact_name: 'María Hija', notification_contact_phone: '351 15 555-1234',
    })
  })

  it('B2 · un teléfono para avisos inválido se marca en su campo y no se guarda', async () => {
    render(<MemoryRouter><NewCustomer /></MemoryRouter>)
    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'Juan' } })
    fireEvent.change(screen.getByLabelText('Teléfono'), { target: { value: '3511234567' } })
    fireEvent.change(screen.getByLabelText('Nombre del contacto'), { target: { value: 'María' } })
    fireEvent.change(screen.getByLabelText('Teléfono para avisos'), { target: { value: '12' } })
    fireEvent.click(screen.getByTestId('customer-save-button'))

    expect(await screen.findByLabelText('Teléfono para avisos')).toHaveAttribute('aria-invalid', 'true')
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('B3 · edición: hidrata el contacto guardado y lo puede borrar', async () => {
    mocks.update.mockResolvedValue({ id: 'c1', name: 'Juan' })
    const onSaved = vi.fn()
    render(
      <MemoryRouter>
        <CustomerEditDialog
          customer={{ id: 'c1', name: 'Juan', phone: '3511234567', notification_contact_name: 'María', notification_contact_phone: '3519998888' }}
          onClose={() => {}}
          onSaved={onSaved}
        />
      </MemoryRouter>
    )
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Nombre del contacto')).toHaveValue('María')
    expect(within(dialog).getByLabelText('Teléfono para avisos')).toHaveValue('3519998888')
    fireEvent.change(within(dialog).getByLabelText('Nombre del contacto'), { target: { value: '' } })
    fireEvent.change(within(dialog).getByLabelText('Teléfono para avisos'), { target: { value: '' } })
    fireEvent.click(within(dialog).getByTestId('customer-edit-save-button'))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ notification_contact_name: null, notification_contact_phone: null, phone: '3511234567' })
  })
})

describe('C · a quién se avisa', () => {
  const customer = { name: 'Juan Pérez', phone: '3511234567', notification_contact_name: 'María Hija', notification_contact_phone: '3519998888' }

  it('C1 · sin elección: el titular con su teléfono actual', () => {
    expect(resolveNotificationRecipient(customer, null)).toEqual({ kind: 'customer', name: 'Juan Pérez', phone: '3511234567', roleLabel: 'Cliente' })
    expect(resolveNotificationRecipient({ ...customer, phone: '3510000000' }, { recipient: 'customer', contact_name: null, contact_phone: null }).phone).toBe('3510000000')
  })

  it('C2 · alternativo: la copia de la orden, aunque la ficha cambie o se borre', () => {
    const row = { recipient: 'alternate' as const, contact_name: 'María Hija', contact_phone: '3519998888' }
    const changed = { ...customer, notification_contact_name: 'Pedro', notification_contact_phone: '3514443333' }
    expect(resolveNotificationRecipient(changed, row)).toMatchObject({ kind: 'alternate', name: 'María Hija', phone: '3519998888', roleLabel: 'Contacto alternativo' })
    expect(resolveNotificationRecipient({ name: 'Juan', phone: '351' }, row).phone).toBe('3519998888')
    expect(alternateDiffersFromCustomer(resolveNotificationRecipient(changed, row), changed)).toBe(true)
    expect(alternateDiffersFromCustomer(resolveNotificationRecipient(customer, row), customer)).toBe(false)
  })
})

function panelState(overrides: Partial<UseOrderNotificationRecipientReturn> = {}): UseOrderNotificationRecipientReturn {
  return {
    recipient: { kind: 'customer', name: 'Juan Pérez', phone: '3511234567', roleLabel: 'Cliente' },
    row: null, available: true, saving: false, error: '', change: vi.fn(async () => true), ...overrides,
  }
}

describe('D · panel de la orden', () => {
  const customer = { name: 'Juan Pérez', phone: '3511234567', notification_contact_name: 'María Hija', notification_contact_phone: '3519998888' }

  it('D1 · muestra nombre, número y rol, y cambia al contacto alternativo', async () => {
    const state = panelState()
    render(<MemoryRouter><NotificationRecipientPanel customerId="c1" customer={customer} state={state} canChange /></MemoryRouter>)

    const recipient = screen.getByTestId('order-notify-recipient')
    // Al titular no se le repite el nombre (ya está en la tarjeta Cliente).
    expect(recipient).toHaveTextContent('Cliente')
    expect(recipient).toHaveTextContent('3511234567')
    expect(recipient).not.toHaveTextContent('Juan Pérez')
    expect(screen.getByTestId('order-notify-choose-customer')).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByTestId('order-notify-choose-alternate'))
    await waitFor(() => expect(state.change).toHaveBeenCalledWith('alternate'))
    expect(await screen.findByRole('status')).toHaveTextContent('Los avisos de esta orden van a María Hija.')
  })

  it('D2 · sin permiso no hay selector; sin contacto, se indica dónde cargarlo', () => {
    const { rerender } = render(<MemoryRouter><NotificationRecipientPanel customerId="c1" customer={customer} state={panelState()} canChange={false} /></MemoryRouter>)
    expect(screen.queryByTestId('order-notify-choose-alternate')).toBeNull()

    rerender(<MemoryRouter><NotificationRecipientPanel customerId="c1" customer={{ name: 'Juan', phone: '351' }} state={panelState()} canChange /></MemoryRouter>)
    expect(screen.queryByTestId('order-notify-choose-alternate')).toBeNull()
    expect(screen.getByRole('link', { name: 'ficha del cliente' })).toHaveAttribute('href', '/customers/c1')
  })

  it('D3 · si la ficha tiene otro contacto, ofrece actualizar la copia (nunca sola)', async () => {
    const state = panelState({ recipient: { kind: 'alternate', name: 'Pedro Viejo', phone: '3514443333', roleLabel: 'Contacto alternativo' } })
    render(<MemoryRouter><NotificationRecipientPanel customerId="c1" customer={customer} state={state} canChange /></MemoryRouter>)

    expect(screen.getByTestId('order-notify-recipient')).toHaveTextContent('Contacto alternativoPedro Viejo3514443333')
    expect(screen.getByTestId('order-notify-stale')).toHaveTextContent('María Hija · 3519998888')
    expect(state.change).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Usar el de la ficha' }))
    await waitFor(() => expect(state.change).toHaveBeenCalledWith('alternate'))
  })

  it('D4 · sin la migración (tabla ausente) se avisa al titular y no se ofrece cambiar', () => {
    render(<MemoryRouter><NotificationRecipientPanel customerId="c1" customer={customer} state={panelState({ available: false })} canChange /></MemoryRouter>)
    expect(screen.getByTestId('order-notify-recipient')).toHaveTextContent('Cliente')
    expect(screen.queryByTestId('order-notify-choose-alternate')).toBeNull()
  })
})

describe('E · Nueva orden', () => {
  const action = (name: string) => { const buttons = screen.getAllByRole('button', { name }); return buttons[buttons.length - 1] }

  async function reachSummary(withNotice: boolean) {
    mocks.searchCustomers.mockResolvedValue({ status: 'ok', truncated: false, items: [{ id: 'c1', name: 'Juan Pérez', phone: '3511234567' }] })
    mocks.loadNotice.mockResolvedValue(withNotice ? { name: 'María Hija', phone: '3519998888' } : null)
    mocks.intakeCreate.mockResolvedValue({ order_id: '11111111-1111-4111-8111-111111111111', replayed: false })
    mocks.upload.mockResolvedValue({ uploaded: 0, failed: [] })
    mocks.setRecipient.mockResolvedValue({ recipient: 'alternate', contact_name: 'María Hija', contact_phone: '3519998888' })
    render(<MemoryRouter><NewOrder /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: /Juan Pérez/ }))
  }

  async function finish() {
    fireEvent.click(action('Continuar'))
    fireEvent.change(screen.getByLabelText('Marca'), { target: { value: 'Samsung' } })
    fireEvent.change(screen.getByLabelText('Modelo'), { target: { value: 'S24' } })
    fireEvent.click(action('Continuar'))
    fireEvent.change(screen.getByTestId('intake-problem'), { target: { value: 'No carga' } })
    fireEvent.click(action('Continuar'))
    fireEvent.click(action('Crear orden'))
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled())
  }

  it('E1 · con contacto alternativo ofrece elegir; por defecto, el cliente', async () => {
    await reachSummary(true)
    const choice = await screen.findByTestId('intake-notify')
    expect(within(choice).getByTestId('intake-notify-customer')).toHaveAttribute('aria-pressed', 'true')
    expect(within(choice).getByTestId('intake-notify-alternate')).toHaveTextContent('María Hija · 3519998888')
    await finish()
    expect(mocks.setRecipient).not.toHaveBeenCalled()
  })

  it('E2 · elegir el alternativo lo guarda en la orden recién creada', async () => {
    await reachSummary(true)
    fireEvent.click(await screen.findByTestId('intake-notify-alternate'))
    await finish()
    expect(mocks.setRecipient).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'alternate')
    expect(mocks.navigate.mock.calls[0][1].state).not.toHaveProperty('notifyRecipientWarning')
  })

  it('E3 · si no se puede guardar, la orden se crea igual y se avisa en el detalle', async () => {
    await reachSummary(true)
    mocks.setRecipient.mockRejectedValue(new Error('El cliente no tiene un contacto para avisos cargado.'))
    fireEvent.click(await screen.findByTestId('intake-notify-alternate'))
    await finish()
    expect(mocks.navigate.mock.calls[0][1].state.notifyRecipientWarning).toMatch(/La orden se creó/)
  })

  it('E4 · sin contacto alternativo no aparece el selector', async () => {
    await reachSummary(false)
    await waitFor(() => expect(mocks.loadNotice).toHaveBeenCalledWith('c1', 'biz-1'))
    expect(screen.queryByTestId('intake-notify')).toBeNull()
  })
})

describe('F · WhatsApp', () => {
  const settings = { enabled: true, auto_send_enabled: true, business_name: 'Taller' } as never
  const order = {
    id: 'o1', status: 'ready', customer: { name: 'Juan Pérez', phone: '3511234567' }, device: { brand: 'Samsung', model: 'S24' },
    notification_recipient: { kind: 'alternate', name: 'María Hija', phone: '3519998888', roleLabel: 'Contacto alternativo' },
  }

  it('F1 · `{nombre}` saluda a quien recibe; `{cliente}` sigue siendo el titular', () => {
    const vars = buildOrderVars(order, settings)
    expect(vars.nombre).toBe('María')
    expect(vars.cliente).toBe('Juan Pérez')
    expect(buildOrderVars({ ...order, notification_recipient: undefined }, settings).nombre).toBe('Juan')
  })

  it('F2 · las variables de la orden no incluyen secretos de desbloqueo', () => {
    const vars = buildOrderVars({ ...order, device_password: 'pin:1234', access_secret: '1234', access_mode: 'pin' }, settings)
    const serialized = JSON.stringify(vars)
    expect(serialized).not.toContain('1234')
    expect(Object.keys(vars).join(' ')).not.toMatch(/password|secret|pin|patron|acceso/i)
  })

  it('F3 · el envío automático (Cloud API) va al destinatario de la orden', async () => {
    const service = whatsappService as unknown as Record<string, unknown>
    const sendViaAPI = vi.fn(async () => ({ success: true }))
    const original = { getSettings: service.getSettings, getTemplates: service.getTemplates, sendViaAPI: service.sendViaAPI }
    service.getSettings = async () => ({ enabled: true, auto_send_enabled: true })
    service.getTemplates = async () => [{ status_key: 'ready_pickup', is_active: true, auto_send: true, message_template: 'Hola {nombre}' }]
    service.sendViaAPI = sendViaAPI
    try {
      const result = await whatsappService.handleAutoSend('biz-1', order, 'ready_delivery' as never)
      expect(result.sent).toBe(true)
      expect(sendViaAPI).toHaveBeenCalledTimes(1)
      const [, phone, message] = sendViaAPI.mock.calls[0] as unknown as [string, string, string]
      expect(phone).toBe('3519998888')
      expect(message).toBe('Hola María')
    } finally {
      Object.assign(service, original)
    }
  })
})
