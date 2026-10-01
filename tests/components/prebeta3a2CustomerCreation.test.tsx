// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-3A-2 · Alta de cliente canónica + gate Mayorista.
//
// Autoridades REALES en juego: `usePermissions` (defaults del rol + overrides),
// `resolveEntitlement` (plan / trial → features) y la autoridad central de
// Mayorista (`useWholesaleAccess`). Sólo se simulan la sesión (`useAuth`) y el
// snapshot de suscripción, para poder mover plan y actor.
//
//   A. Gate Mayorista = acceso Mayorista: feature `mayorista` (Pro+, trial
//      incluido) Y (owner | admin | capacidad `wholesale`).
//   B. Full page y alta rápida: mismas opciones y mismo payload, con y sin gate.
//   C. Técnico de recepción: orders_create sí, customers no, wholesale no.
//   D. Mayorista existente sin gate: se conserva, no se convierte ni se borra.
//   E. Validación visible: nada rojo antes de interactuar.
//   F. Reset del alta rápida.
// ─────────────────────────────────────────────────────────────────────────────
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Plan = { subscription_status: string; subscription_plan: string | null }
type Actor = { businessId: string; role: string; isOwner: boolean; hasBusinessAccess: boolean; profile: { permissions: unknown } }

const state = vi.hoisted(() => ({
  actor: { businessId: 'biz-1', role: 'owner', isOwner: true, hasBusinessAccess: true, profile: { permissions: null } } as Actor,
  /** `null` = suscripción sin confirmar (falló la lectura). */
  plan: { subscription_status: 'active', subscription_plan: 'full' } as Plan | null,
}))

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  getAll: vi.fn(),
  navigate: vi.fn(),
  loadProfiles: vi.fn(),
  ordersQuery: vi.fn(),
}))

vi.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => state.actor }))
vi.mock('../../src/hooks/useSubscription', async () => {
  const { resolveEntitlement } = await vi.importActual<typeof import('../../src/lib/entitlements')>('../../src/lib/entitlements')
  type Input = Parameters<typeof resolveEntitlement>[0]
  return {
    useSubscription: () => ({
      // Sin datos confirmados `useSubscription` resuelve el trial optimista.
      hasFeature: resolveEntitlement((state.plan ?? { subscription_status: null, subscription_plan: null }) as Input).hasFeature,
      subscription: state.plan,
      loading: false,
    }),
  }
})
vi.mock('../../src/services/api', () => ({
  customersService: { create: mocks.create, update: mocks.update, getAll: mocks.getAll },
}))
vi.mock('../../src/features/order-intake/service', () => ({
  createOrderIntake: vi.fn(), uploadIntakePhotos: vi.fn(), loadAssignableProfiles: mocks.loadProfiles,
}))
vi.mock('../../src/services/posCustomerSearchService', () => ({
  searchPosCustomers: async () => ({ status: 'ok', items: [], truncated: false }),
}))
vi.mock('../../src/services/deviceCatalogService', () => ({
  DEFAULT_BRANDS: ['Apple'], loadBrandOptions: async () => ['Apple'], loadModelOptions: async () => [], ensureBrandAndModel: async () => null,
}))
vi.mock('../../src/contexts/LoadingContext', () => ({
  useLoading: () => ({ showLoading: vi.fn(), hideLoading: vi.fn() }),
}))
vi.mock('../../src/hooks/useAppWakeUp', () => ({ useRefreshOnWakeUp: () => {} }))
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ limit: () => mocks.ordersQuery() }) }) }),
    rpc: async () => ({ data: { ok: true, authorized: false, rows: [] }, error: null }),
  },
}))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mocks.navigate }
})

import { usePermissions } from '../../src/hooks/usePermissions'
import { Customers } from '../../src/pages/Customers'
import { NewCustomer } from '../../src/pages/NewCustomer'
import { NewOrder } from '../../src/pages/NewOrder'

const OWNER: Actor = { businessId: 'biz-1', role: 'owner', isOwner: true, hasBusinessAccess: true, profile: { permissions: null } }
const FULL: Plan = { subscription_status: 'active', subscription_plan: 'full' }
const PRO: Plan = { subscription_status: 'active', subscription_plan: 'pro' }
const BASICO: Plan = { subscription_status: 'active', subscription_plan: 'basico' }
const TRIAL: Plan = { subscription_status: 'trialing', subscription_plan: null }

/** Miembro no owner, con overrides opcionales sobre los defaults de su rol. */
const member = (role: string, permissions: unknown = null): Partial<Actor> =>
  ({ role, isOwner: false, profile: { permissions } })

function as(actor: Partial<Actor>, plan: Plan | null) {
  state.actor = { ...OWNER, ...actor }
  state.plan = plan
}

beforeEach(() => {
  as(OWNER, FULL)
  mocks.create.mockReset().mockImplementation(async (payload) => ({ id: 'nuevo', ...payload }))
  mocks.update.mockReset().mockResolvedValue({ id: 'c1' })
  mocks.getAll.mockReset().mockResolvedValue([])
  mocks.navigate.mockReset()
  mocks.loadProfiles.mockReset().mockResolvedValue([])
  mocks.ordersQuery.mockReset().mockResolvedValue({ data: [] })
})

// ── Shells ───────────────────────────────────────────────────────────────────

type Shell = 'full' | 'quick'

/** Monta la superficie y devuelve el contenedor del formulario y su CTA. */
async function openShell(shell: Shell) {
  if (shell === 'full') {
    const view = render(<MemoryRouter><NewCustomer /></MemoryRouter>)
    return {
      scope: within(view.container),
      root: view.container,
      cta: () => screen.getByTestId('customer-save-button'),
      form: () => view.container.querySelector('form') as HTMLFormElement,
      unmount: view.unmount,
    }
  }
  const view = render(<MemoryRouter><NewOrder /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: 'Crear cliente rápido' }))
  const dialog = screen.getByRole('dialog', { name: 'Crear cliente rápido' })
  // Al abrir, el diálogo manda el foco a «Cerrar» en el próximo frame. Se espera
  // ese frame para que no compita con el foco que el test mide después.
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cerrar' })))
  return {
    scope: within(dialog),
    root: dialog,
    cta: () => within(dialog).getByRole('button', { name: 'Crear cliente' }),
    form: () => document.getElementById('quick-customer-form') as HTMLFormElement,
    unmount: view.unmount,
  }
}

const SHELLS: Shell[] = ['full', 'quick']

function invalidNodes(root: HTMLElement) {
  return root.querySelectorAll('[aria-invalid="true"]')
}

// ── A. Gate Mayorista ────────────────────────────────────────────────────────
describe('A · gate Mayorista = feature `mayorista` (Pro+) Y (owner | admin | `wholesale`)', () => {
  const CASES: Array<{ name: string; actor: Partial<Actor>; plan: Plan | null; offered: boolean }> = [
    // PLAN
    { name: 'Básico + owner', actor: {}, plan: BASICO, offered: false },
    { name: 'Pro + owner', actor: {}, plan: PRO, offered: true },
    { name: 'Full + owner', actor: {}, plan: FULL, offered: true },
    { name: 'trial + owner (el trial hereda Pro)', actor: {}, plan: TRIAL, offered: true },
    { name: 'Full vencido (sin acceso) + owner', actor: {}, plan: { subscription_status: 'canceled', subscription_plan: 'full' }, offered: false },
    { name: 'suscripción sin confirmar + owner (fail-closed)', actor: {}, plan: null, offered: false },
    // ROLES — owner/admin automáticos; el resto sólo con `wholesale`.
    { name: 'Pro + admin', actor: member('admin'), plan: PRO, offered: true },
    { name: 'Pro + admin con wholesale=false (automático igual)', actor: member('admin', { wholesale: false }), plan: PRO, offered: true },
    { name: 'Pro + manager (sin wholesale por default)', actor: member('manager'), plan: PRO, offered: false },
    { name: 'Pro + manager con wholesale=true', actor: member('manager', { wholesale: true }), plan: PRO, offered: true },
    { name: 'Pro + sales (sin wholesale por default)', actor: member('sales'), plan: PRO, offered: false },
    { name: 'Pro + sales con wholesale=true', actor: member('sales', { wholesale: true }), plan: PRO, offered: true },
    { name: 'Full + tech con wholesale=true', actor: member('tech', { wholesale: true }), plan: FULL, offered: true },
    { name: 'Full + cashier (wholesale=false por default)', actor: member('cashier'), plan: FULL, offered: false },
    { name: 'Básico + manager con wholesale=true (sin feature)', actor: member('manager', { wholesale: true }), plan: BASICO, offered: false },
    { name: 'Pro + owner sin acceso al negocio', actor: { hasBusinessAccess: false }, plan: PRO, offered: false },
  ]

  for (const shell of SHELLS) {
    for (const scenario of CASES) {
      it(`${shell} · ${scenario.name} → ${scenario.offered ? 'ofrece' : 'NO ofrece'} Mayorista`, async () => {
        as(scenario.actor, scenario.plan)
        const { scope } = await openShell(shell)
        if (scenario.offered) {
          expect(scope.getByTestId('customer-type-mayorista')).toBeInTheDocument()
          expect(scope.getByTestId('customer-type-minorista')).toHaveAttribute('aria-pressed', 'true')
        } else {
          expect(scope.queryByTestId('customer-type-mayorista')).not.toBeInTheDocument()
          expect(scope.queryByTestId('customer-type-minorista')).not.toBeInTheDocument()
          expect(scope.queryByLabelText('Razón social')).not.toBeInTheDocument()
          expect(scope.queryByLabelText('Persona de contacto')).not.toBeInTheDocument()
        }
      })
    }
  }
})

// ── B. Paridad full page ↔ alta rápida ──────────────────────────────────────
describe('B · paridad de las dos altas, con y sin gate', () => {
  async function createWholesale(shell: Shell) {
    const { scope, cta, unmount } = await openShell(shell)
    fireEvent.click(scope.getByTestId('customer-type-mayorista'))
    fireEvent.change(scope.getByLabelText('Nombre completo'), { target: { value: 'Comercio Demo' } })
    fireEvent.change(scope.getByLabelText('Teléfono'), { target: { value: '3512345678' } })
    fireEvent.change(scope.getByTestId('customer-document-input'), { target: { value: '20-30123456-7' } })
    // Misma regla de razón social en las dos: sin ella, no se escribe.
    fireEvent.click(cta())
    expect(await scope.findByText('Un cliente mayorista necesita razón social.')).toBeInTheDocument()
    expect(mocks.create).not.toHaveBeenCalled()
    fireEvent.change(scope.getByLabelText('Razón social'), { target: { value: 'Demo SRL' } })
    fireEvent.change(scope.getByLabelText('Persona de contacto'), { target: { value: 'Ana' } })
    fireEvent.click(cta())
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    const payload = mocks.create.mock.calls[0][0]
    unmount()
    mocks.create.mockClear()
    return payload
  }

  async function createPlain(shell: Shell) {
    const { scope, cta, unmount } = await openShell(shell)
    fireEvent.change(scope.getByLabelText('Nombre completo'), { target: { value: 'Juan Pérez' } })
    fireEvent.change(scope.getByLabelText('Teléfono'), { target: { value: '3512345678' } })
    fireEvent.change(scope.getByTestId('customer-document-input'), { target: { value: '30.123.456' } })
    fireEvent.click(cta())
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    const payload = mocks.create.mock.calls[0][0]
    unmount()
    mocks.create.mockClear()
    return payload
  }

  it('con gate: las dos altas escriben el MISMO mayorista (tipo, CUIT, razón social)', async () => {
    const full = await createWholesale('full')
    const quick = await createWholesale('quick')
    expect(full).toMatchObject({ customer_type: 'mayorista', document: 'CUIT 20301234567', business_name: 'Demo SRL', contact_person: 'Ana' })
    for (const key of ['customer_type', 'document', 'business_name', 'contact_person', 'phone'] as const) {
      expect(quick[key], key).toEqual(full[key])
    }
  })

  it('sin gate: las dos altas sólo crean Minorista y no mandan datos mayoristas', async () => {
    as({}, BASICO)
    const full = await createPlain('full')
    const quick = await createPlain('quick')
    for (const payload of [full, quick]) {
      expect(payload.customer_type).toBe('minorista')
      expect(payload.document).toBe('DNI 30123456')
      expect(payload.business_name).toBeUndefined()
      expect(payload.contact_person).toBeUndefined()
    }
  })

  it('fail-closed con el formulario abierto: si el gate se cae, el alta NO sale mayorista', async () => {
    for (const shell of SHELLS) {
      as({}, FULL)
      const { scope, cta, unmount } = await openShell(shell)
      fireEvent.click(scope.getByTestId('customer-type-mayorista'))
      fireEvent.change(scope.getByLabelText('Razón social'), { target: { value: 'Viejo SRL' } })
      fireEvent.change(scope.getByLabelText('Nombre completo'), { target: { value: 'Estado Viejo' } })

      // El negocio baja de plan con el formulario abierto. El próximo render ya
      // no ofrece Mayorista, y el estado viejo tampoco puede colarse al payload.
      as({}, BASICO)
      fireEvent.change(scope.getByLabelText('Teléfono'), { target: { value: '3510000000' } })
      expect(scope.queryByTestId('customer-type-mayorista')).not.toBeInTheDocument()
      expect(scope.queryByLabelText('Razón social')).not.toBeInTheDocument()

      fireEvent.click(cta())
      await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
      const payload = mocks.create.mock.calls[0][0]
      expect(payload.customer_type, shell).toBe('minorista')
      expect(payload.business_name, shell).toBeUndefined()
      expect(payload.contact_person, shell).toBeUndefined()
      unmount()
      mocks.create.mockClear()
    }
  })
})

// ── C. Técnico de recepción ─────────────────────────────────────────────────
describe('C · técnico con orders_create y SIN customers ni wholesale', () => {
  beforeEach(() => {
    // Rol real, sin overrides: los defaults de `tech` son la matriz vigente.
    as({ role: 'tech', isOwner: false, profile: { permissions: null } }, FULL)
  })

  it('la matriz real del técnico es la que el lote protege', () => {
    let caps: ReturnType<typeof usePermissions>['can'] | null = null
    function Probe() { caps = usePermissions().can; return null }
    render(<Probe />)
    expect(caps!('orders_create')).toBe(true)
    expect(caps!('customers')).toBe(false)
    expect(caps!('wholesale')).toBe(false)
  })

  it('crea un Minorista desde la recepción, queda elegido y el wizard sigue', async () => {
    render(<MemoryRouter><NewOrder /></MemoryRouter>)
    // La alta rápida NO depende de `customers`.
    fireEvent.click(await screen.findByRole('button', { name: 'Crear cliente rápido' }))
    const dialog = screen.getByRole('dialog', { name: 'Crear cliente rápido' })
    // Aunque el negocio sea Full, el técnico no tiene `wholesale`.
    expect(within(dialog).queryByTestId('customer-type-mayorista')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Razón social')).not.toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText('Nombre completo'), { target: { value: 'Cliente Mostrador' } })
    fireEvent.change(within(dialog).getByLabelText('Teléfono'), { target: { value: '3519999999' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear cliente' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ customer_type: 'minorista', name: 'Cliente Mostrador' })
    expect(mocks.create.mock.calls[0][0].business_name).toBeUndefined()

    const selected = await screen.findByRole('button', { name: /Cliente Mostrador/ })
    expect(selected).toHaveClass('is-selected')
    expect(screen.queryByRole('dialog', { name: 'Crear cliente rápido' })).not.toBeInTheDocument()

    const continuar = screen.getAllByRole('button', { name: 'Continuar' })
    fireEvent.click(continuar[continuar.length - 1])
    expect(await screen.findByRole('heading', { name: 'Equipo' })).toBeInTheDocument()
  })
})

// ── D. Mayorista existente sin gate ─────────────────────────────────────────
describe('D · un mayorista existente se PRESERVA cuando falta el gate', () => {
  const WHOLESALE_ROW = {
    id: 'c1',
    name: 'Comercio Demo',
    phone: '3512345678',
    email: 'demo@demo.com',
    document: 'CUIT 20301234567',
    customer_type: 'mayorista',
    business_name: 'Demo SRL',
    contact_person: 'Ana',
  }

  async function editRow(row: Record<string, unknown>) {
    mocks.getAll.mockResolvedValue([row])
    render(<MemoryRouter><Customers /></MemoryRouter>)
    fireEvent.click(await screen.findByTitle('Editar cliente'))
    return screen.getByRole('dialog', { name: 'Editar Cliente' })
  }

  /** Aplica el PATCH como lo haría PostgREST: sólo las claves presentes. */
  function applyPatch(row: Record<string, unknown>) {
    const [, payload] = mocks.update.mock.calls[0]
    return { ...row, ...payload }
  }

  const NO_GATE: Array<{ name: string; actor: Partial<Actor>; plan: Plan }> = [
    { name: 'el negocio bajó a Básico', actor: {}, plan: BASICO },
    { name: 'el actor no tiene `wholesale`', actor: member('sales', { wholesale: false }), plan: FULL },
  ]

  for (const scenario of NO_GATE) {
    it(`${scenario.name}: editar el teléfono no lo convierte ni le borra nada`, async () => {
      as(scenario.actor, scenario.plan)
      const dialog = await editRow(WHOLESALE_ROW)

      // Estado claro y no editable.
      expect(within(dialog).getByTestId('customer-type-locked')).toHaveTextContent('Mayorista')
      expect(within(dialog).queryByTestId('customer-type-minorista')).not.toBeInTheDocument()
      expect(within(dialog).queryByTestId('customer-type-mayorista')).not.toBeInTheDocument()
      expect(within(dialog).queryByLabelText('Razón social')).not.toBeInTheDocument()
      expect(within(dialog).getByTestId('customer-business-name-readonly')).toHaveTextContent('Demo SRL')
      expect(within(dialog).getByTestId('customer-contact-person-readonly')).toHaveTextContent('Ana')

      fireEvent.change(within(dialog).getByLabelText('Teléfono'), { target: { value: '3517777777' } })
      fireEvent.click(within(dialog).getByTestId('customer-edit-save-button'))
      await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))

      const [id, payload] = mocks.update.mock.calls[0]
      expect(id).toBe('c1')
      expect(payload.phone).toBe('3517777777')
      // El PATCH ni nombra lo mayorista: no hay null ni minorista que viaje.
      expect(payload).not.toHaveProperty('customer_type')
      expect(payload).not.toHaveProperty('business_name')
      expect(payload).not.toHaveProperty('contact_person')

      const after = applyPatch(WHOLESALE_ROW)
      expect(after).toMatchObject({
        customer_type: 'mayorista',
        business_name: 'Demo SRL',
        contact_person: 'Ana',
        phone: '3517777777',
      })
    })
  }

  it('un mayorista histórico SIN razón social sigue siendo editable en sus datos comunes', async () => {
    as({}, BASICO)
    const dialog = await editRow({ ...WHOLESALE_ROW, business_name: null, contact_person: null })
    expect(within(dialog).getByTestId('customer-business-name-readonly')).toHaveTextContent('Sin cargar')

    fireEvent.change(within(dialog).getByLabelText('Teléfono'), { target: { value: '3516666666' } })
    fireEvent.click(within(dialog).getByTestId('customer-edit-save-button'))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Un cliente mayorista necesita razón social.')).not.toBeInTheDocument()
    expect(mocks.update.mock.calls[0][1]).not.toHaveProperty('customer_type')
  })

  it('con gate, el mismo mayorista se edita como siempre (sin candado)', async () => {
    as({}, FULL)
    const dialog = await editRow(WHOLESALE_ROW)
    expect(within(dialog).queryByTestId('customer-type-locked')).not.toBeInTheDocument()
    expect(within(dialog).getByTestId('customer-type-mayorista')).toHaveAttribute('aria-pressed', 'true')
    expect(within(dialog).getByLabelText('Razón social')).toHaveValue('Demo SRL')
    fireEvent.click(within(dialog).getByTestId('customer-edit-save-button'))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ customer_type: 'mayorista', business_name: 'Demo SRL', contact_person: 'Ana' })
  })

  it('sin gate, un minorista no puede pasar a mayorista', async () => {
    as({}, BASICO)
    const dialog = await editRow({ id: 'c2', name: 'Juan', phone: '351', customer_type: 'minorista' })
    expect(within(dialog).queryByTestId('customer-type-mayorista')).not.toBeInTheDocument()
    expect(within(dialog).queryByTestId('customer-type-locked')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByTestId('customer-edit-save-button'))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ customer_type: 'minorista', business_name: null })
  })
})

// ── E. Validación visible ───────────────────────────────────────────────────
describe('E · nada rojo antes de interactuar; el intento revela y no escribe', () => {
  for (const shell of SHELLS) {
    it(`${shell} · formulario limpio: 0 errores visibles y el CTA no está muerto`, async () => {
      const { root, cta, scope } = await openShell(shell)
      expect(invalidNodes(root)).toHaveLength(0)
      expect(root.querySelectorAll('.form-error')).toHaveLength(0)
      expect(scope.queryByText('El nombre es obligatorio.')).not.toBeInTheDocument()
      expect(scope.queryByText('El teléfono es obligatorio.')).not.toBeInTheDocument()
      expect(cta()).not.toBeDisabled()
    })

    it(`${shell} · blur → error del campo; corregir → desaparece; intento → bloqueos; corregir → una sola creación`, async () => {
      const { root, cta, scope } = await openShell(shell)
      const name = scope.getByLabelText('Nombre completo')
      const phone = scope.getByLabelText('Teléfono')

      fireEvent.blur(name)
      expect(scope.getByText('El nombre es obligatorio.')).toBeInTheDocument()
      expect(name).toHaveAttribute('aria-invalid', 'true')
      // Sólo SU error: el teléfono no se tocó.
      expect(phone).toHaveAttribute('aria-invalid', 'false')
      expect(scope.queryByText('El teléfono es obligatorio.')).not.toBeInTheDocument()

      fireEvent.change(name, { target: { value: 'Ana Gómez' } })
      expect(scope.queryByText('El nombre es obligatorio.')).not.toBeInTheDocument()
      expect(invalidNodes(root)).toHaveLength(0)

      fireEvent.click(cta())
      expect(scope.getByText('El teléfono es obligatorio.')).toBeInTheDocument()
      expect(phone).toHaveAttribute('aria-invalid', 'true')
      expect(mocks.create).not.toHaveBeenCalled()
      // El foco va al campo que bloquea.
      await waitFor(() => expect(document.activeElement).toBe(phone))

      fireEvent.change(phone, { target: { value: '3511111111' } })
      expect(scope.queryByText('El teléfono es obligatorio.')).not.toBeInTheDocument()
      fireEvent.click(cta())
      await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    })

    it(`${shell} · email inválido: se muestra al salir, bloquea el intento y se abre si estaba oculto`, async () => {
      const { scope, cta } = await openShell(shell)
      fireEvent.change(scope.getByLabelText('Nombre completo'), { target: { value: 'Ana' } })
      fireEvent.change(scope.getByLabelText('Teléfono'), { target: { value: '3511111111' } })
      const toggle = scope.getByTestId('customer-additional-toggle')
      if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
      const email = scope.getByLabelText('Email')
      fireEvent.change(email, { target: { value: 'no-es-email' } })
      expect(scope.queryByText('Ingresá un email válido.')).not.toBeInTheDocument()
      fireEvent.blur(email)
      expect(scope.getByText('Ingresá un email válido.')).toBeVisible()

      // Aunque el usuario cierre el bloque, el intento lo vuelve a mostrar.
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(cta())
      await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'))
      expect(scope.getByText('Ingresá un email válido.')).toBeVisible()
      expect(mocks.create).not.toHaveBeenCalled()
      await waitFor(() => expect(document.activeElement).toBe(email))
    })

    it(`${shell} · Enter/submit repetido envía UNA sola vez`, async () => {
      let resolveCreate!: (value: unknown) => void
      mocks.create.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve }))
      const { scope, form } = await openShell(shell)
      fireEvent.change(scope.getByLabelText('Nombre completo'), { target: { value: 'Sin Duplicar' } })
      fireEvent.change(scope.getByLabelText('Teléfono'), { target: { value: '3510000001' } })
      fireEvent.submit(form())
      fireEvent.submit(form())
      fireEvent.submit(form())
      expect(mocks.create).toHaveBeenCalledTimes(1)
      await act(async () => resolveCreate({ id: 'nuevo', name: 'Sin Duplicar', phone: '3510000001' }))
    })

    it(`${shell} · Enter con el formulario vacío revela los bloqueos y no escribe`, async () => {
      const { scope, form } = await openShell(shell)
      fireEvent.submit(form())
      expect(scope.getByText('El nombre es obligatorio.')).toBeInTheDocument()
      expect(scope.getByText('El teléfono es obligatorio.')).toBeInTheDocument()
      expect(mocks.create).not.toHaveBeenCalled()
    })
  }
})

// ── F. Reset del alta rápida ────────────────────────────────────────────────
describe('F · cancelar y reabrir el alta rápida vuelve al estado inicial', () => {
  for (const gate of [true, false]) {
    it(`${gate ? 'con' : 'sin'} gate: valores, tipo, tocados, errores y disclosure limpios`, async () => {
      as({}, gate ? FULL : BASICO)
      const { scope, cta, root } = await openShell('quick')
      if (gate) {
        fireEvent.click(scope.getByTestId('customer-type-mayorista'))
        fireEvent.change(scope.getByLabelText('Razón social'), { target: { value: 'Descartar SRL' } })
      }
      fireEvent.blur(scope.getByLabelText('Nombre completo'))
      fireEvent.change(scope.getByLabelText('Teléfono'), { target: { value: '351' } })
      fireEvent.click(scope.getByTestId('customer-additional-toggle'))
      fireEvent.change(scope.getByLabelText('Email'), { target: { value: 'mal' } })
      fireEvent.click(cta())
      expect(invalidNodes(root).length).toBeGreaterThan(0)

      fireEvent.click(scope.getByRole('button', { name: 'Cancelar' }))
      expect(mocks.create).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Crear cliente rápido' }))
      const reopened = screen.getByRole('dialog', { name: 'Crear cliente rápido' })
      const again = within(reopened)
      expect(again.getByLabelText('Nombre completo')).toHaveValue('')
      expect(again.getByLabelText('Teléfono')).toHaveValue('')
      expect(again.getByLabelText('Email')).toHaveValue('')
      expect(again.getByTestId('customer-additional-toggle')).toHaveAttribute('aria-expanded', 'false')
      expect(invalidNodes(reopened)).toHaveLength(0)
      expect(reopened.querySelectorAll('.form-error')).toHaveLength(0)
      if (gate) {
        expect(again.getByTestId('customer-type-minorista')).toHaveAttribute('aria-pressed', 'true')
        expect(again.queryByLabelText('Razón social')).not.toBeInTheDocument()
      } else {
        expect(again.queryByTestId('customer-type-mayorista')).not.toBeInTheDocument()
      }

      // Y el siguiente intento vuelve a partir de cero: tocar un campo muestra
      // sólo el suyo, no los del intento anterior.
      fireEvent.blur(again.getByLabelText('Teléfono'))
      expect(again.getByText('El teléfono es obligatorio.')).toBeInTheDocument()
      expect(again.queryByText('El nombre es obligatorio.')).not.toBeInTheDocument()
    })
  }
})
