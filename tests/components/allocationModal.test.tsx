// ─────────────────────────────────────────────────────────────────────────────
// P0-A.1U2 — Modal de imputación: comportamiento real sobre el DOM.
// Casos 1-14, 16-18, 22 y 25 del contrato.
// Se mockea el LÍMITE (supabase y useAuth), nunca el componente bajo prueba.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const CREDITO = {
  payment_movement_id: 'pay-1', payment_date: '2026-07-30',
  payment_amount: 60000, allocated_amount: 0, unallocated_amount: 60000,
}
const DOC_A = {
  comprobante_id: 'c-a', numero: '0001-00000001', order_id: 'ord-a', fecha: '2026-07-29',
  total: 100000, saldo_documento: 60000, imputado: 0, saldo_imputable: 60000,
}
const DOC_B = {
  comprobante_id: 'c-b', numero: '0001-00000002', order_id: 'ord-b', fecha: '2026-07-28',
  total: 40000, saldo_documento: 40000, imputado: 0, saldo_imputable: 40000,
}

let workspace: unknown = { ok: true, authorized: true, can_allocate: true, can_reverse: true, credits: [CREDITO], documents: [DOC_A, DOC_B] }
let allocateResp: unknown = { ok: true, allocation_ids: ['a1'], allocated_total: 60000 }
const rpcSpy = vi.fn()

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: 'biz-1', user: { id: 'u1' } }),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => { const q: Record<string, unknown> = {}; const c = () => q; q.select = c; q.eq = c; q.maybeSingle = () => Promise.resolve({ data: null, error: null }); return q },
    rpc: (nombre: string, args: unknown) => {
      rpcSpy(nombre, args)
      if (nombre === 'get_allocation_workspace') return Promise.resolve({ data: workspace, error: null })
      if (nombre === 'allocate_account_payment_atomic') return Promise.resolve({ data: allocateResp, error: null })
      return Promise.resolve({ data: null, error: null })
    },
  },
}))

const { AllocationModal } = await import('../../src/components/finance/AllocationModal')

const montar = (props: Partial<Record<string, unknown>> = {}) => {
  const onAllocated = vi.fn()
  const onClose = vi.fn()
  render(
    <AllocationModal
      isOpen businessId="biz-1" customerId="cli-1" customerName="Ana Gómez"
      onClose={onClose} onAllocated={onAllocated} {...props}
    />,
  )
  return { onAllocated, onClose }
}
const listo = () => waitFor(() => expect(screen.queryByTestId('allocation-loading')).not.toBeInTheDocument())

describe('AllocationModal', () => {
  beforeEach(() => {
    rpcSpy.mockClear()
    workspace = { ok: true, authorized: true, can_allocate: true, can_reverse: true, credits: [CREDITO], documents: [DOC_A, DOC_B] }
    allocateResp = { ok: true, allocation_ids: ['a1'], allocated_total: 60000 }
  })

  test('caso 1: muestra el crédito disponible del cobro', async () => {
    montar(); await listo()
    expect(screen.getByTestId('allocation-modal')).toHaveTextContent('$60.000')
    expect(screen.getByTestId('allocation-remainder')).toHaveTextContent('$60.000')
  })

  test('caso 2: sin crédito no ofrece imputar', async () => {
    workspace = { ok: true, authorized: true, can_allocate: true, credits: [], documents: [DOC_A] }
    montar(); await listo()
    expect(screen.getByTestId('allocation-no-credit')).toBeInTheDocument()
    expect(screen.queryByTestId('allocation-confirm')).not.toBeInTheDocument()
  })

  test('caso 6: asignar a un comprobante habilita la confirmación', async () => {
    const u = userEvent.setup()
    montar(); await listo()
    expect(screen.getByTestId('allocation-confirm')).toBeDisabled()
    await u.type(screen.getByTestId('allocation-input-c-a'), '60000')
    expect(screen.getByTestId('allocation-total')).toHaveTextContent('$60.000')
    expect(screen.getByTestId('allocation-remainder')).toHaveTextContent('$0')
    expect(screen.getByTestId('allocation-confirm')).toBeEnabled()
  })

  test('caso 7 y 8: distribuye entre dos comprobantes y deja remanente', async () => {
    const u = userEvent.setup()
    montar(); await listo()
    await u.type(screen.getByTestId('allocation-input-c-a'), '20000')
    await u.type(screen.getByTestId('allocation-input-c-b'), '30000')
    expect(screen.getByTestId('allocation-total')).toHaveTextContent('$50.000')
    expect(screen.getByTestId('allocation-remainder')).toHaveTextContent('$10.000')
    expect(screen.getByTestId('allocation-confirm')).toBeEnabled()
  })

  test('caso 9: no permite exceder el crédito disponible', async () => {
    const u = userEvent.setup()
    montar(); await listo()
    await u.type(screen.getByTestId('allocation-input-c-a'), '60000')
    await u.type(screen.getByTestId('allocation-input-c-b'), '40000')
    expect(screen.getByTestId('allocation-blocked')).toHaveTextContent(/supera el crédito/i)
    expect(screen.getByTestId('allocation-confirm')).toBeDisabled()
  })

  test('caso 10: no permite exceder el saldo de un comprobante', async () => {
    const u = userEvent.setup()
    montar(); await listo()
    await u.type(screen.getByTestId('allocation-input-c-b'), '50000')  // saldo 40.000
    expect(screen.getByTestId('allocation-blocked')).toHaveTextContent(/saldo pendiente/i)
    expect(screen.getByTestId('allocation-confirm')).toBeDisabled()
  })

  test('caso 12: el doble submit ejecuta UNA sola mutación', async () => {
    const u = userEvent.setup()
    montar(); await listo()
    await u.type(screen.getByTestId('allocation-input-c-a'), '60000')
    const btn = screen.getByTestId('allocation-confirm')
    await u.click(btn)
    await u.click(btn)
    const llamadas = rpcSpy.mock.calls.filter(c => c[0] === 'allocate_account_payment_atomic')
    expect(llamadas).toHaveLength(1)
  })

  test('caso 13: el éxito avisa al caller para que refresque', async () => {
    const u = userEvent.setup()
    const { onAllocated, onClose } = montar(); await listo()
    await u.type(screen.getByTestId('allocation-input-c-a'), '60000')
    await u.click(screen.getByTestId('allocation-confirm'))
    await waitFor(() => expect(onAllocated).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalled()
  })

  test('la mutación manda una idempotency key y los importes en pesos', async () => {
    const u = userEvent.setup()
    montar(); await listo()
    await u.type(screen.getByTestId('allocation-input-c-a'), '20000')
    await u.click(screen.getByTestId('allocation-confirm'))
    await waitFor(() => expect(rpcSpy).toHaveBeenCalledWith('allocate_account_payment_atomic', expect.anything()))
    const args = rpcSpy.mock.calls.find(c => c[0] === 'allocate_account_payment_atomic')![1] as {
      p_idempotency_key: string; p_allocations: { comprobante_id: string; amount: number }[]
    }
    expect(args.p_idempotency_key).toBeTruthy()
    expect(args.p_allocations).toEqual([{ comprobante_id: 'c-a', amount: 20000 }])
  })

  test('caso 16: un conflicto refresca y NO reintenta solo', async () => {
    const u = userEvent.setup()
    allocateResp = { ok: false, error_code: 'VALIDATION_ERROR', error: 'ALLOCATION_EXCEEDS_BALANCE: …' }
    const { onAllocated } = montar(); await listo()
    await u.type(screen.getByTestId('allocation-input-c-a'), '60000')
    await u.click(screen.getByTestId('allocation-confirm'))

    await waitFor(() => expect(screen.getByTestId('allocation-notice')).toBeInTheDocument())
    expect(screen.getByTestId('allocation-notice')).toHaveTextContent(/El saldo cambió mientras realizabas la operación/i)
    // No hay segunda llamada automática y el caller no recibió un éxito falso.
    expect(rpcSpy.mock.calls.filter(c => c[0] === 'allocate_account_payment_atomic')).toHaveLength(1)
    expect(onAllocated).not.toHaveBeenCalled()
    // Y se volvió a pedir el estado para mostrar importes frescos.
    expect(rpcSpy.mock.calls.filter(c => c[0] === 'get_allocation_workspace').length).toBeGreaterThanOrEqual(2)
  })

  test('nunca se muestra un mensaje SQL crudo', async () => {
    const u = userEvent.setup()
    allocateResp = { ok: false, error_code: 'INTERNAL_ERROR', error: 'ERROR: null value in column "x" violates not-null constraint' }
    montar(); await listo()
    await u.type(screen.getByTestId('allocation-input-c-a'), '10000')
    await u.click(screen.getByTestId('allocation-confirm'))
    await waitFor(() => expect(screen.getByTestId('allocation-notice')).toBeInTheDocument())
    const texto = screen.getByTestId('allocation-notice').textContent ?? ''
    expect(texto).not.toMatch(/not-null|violates|column "/i)
  })

  test('casos 17-18: sin permiso de escritura no se puede confirmar', async () => {
    const u = userEvent.setup()
    workspace = { ok: true, authorized: true, can_allocate: false, credits: [CREDITO], documents: [DOC_A] }
    montar(); await listo()
    await u.type(screen.getByTestId('allocation-input-c-a'), '10000')
    expect(screen.getByTestId('allocation-confirm')).toBeDisabled()
    expect(screen.getByTestId('allocation-no-permission')).toBeInTheDocument()
  })

  test('caso 18: un rol sin acceso a importes no ve nada del workspace', async () => {
    workspace = { ok: true, authorized: false }
    montar(); await listo()
    expect(screen.getByTestId('allocation-restricted')).toBeInTheDocument()
    expect(screen.queryByTestId('allocation-confirm')).not.toBeInTheDocument()
  })

  test('caso 22: un error de carga no se representa como cero', async () => {
    workspace = { ok: false, error_code: 'FORBIDDEN' }
    montar(); await listo()
    expect(screen.getByTestId('allocation-error')).toBeInTheDocument()
    expect(screen.getByTestId('allocation-modal')).not.toHaveTextContent('$0')
  })

  test('caso 25: no hay FIFO ni prorrateo — sin tipear, no se asigna nada', async () => {
    montar(); await listo()
    // Aunque haya crédito y documentos, el reparto arranca vacío: lo decide el operador.
    expect(screen.getByTestId('allocation-total')).toHaveTextContent('$0')
    expect(screen.getByTestId('allocation-confirm')).toBeDisabled()
    expect(screen.getByTestId('allocation-blocked')).toHaveTextContent(/Asigná un importe/i)
  })

  test('el modal aclara que no registra un ingreso nuevo', async () => {
    montar(); await listo()
    expect(screen.getByTestId('allocation-disclaimer'))
      .toHaveTextContent(/No registrará un nuevo ingreso/i)
  })

  test('caso 23: el modal se monta en un portal a document.body (regresión de layout)', async () => {
    montar(); await listo()
    const modal = screen.getByTestId('allocation-modal')
    const overlay = modal.parentElement!
    // Sin portal, el overlay queda dentro del layout del caller y un ancestro
    // con transform/filter rompe `position: fixed`: en mobile medía 95 px en
    // vez de 375 y el panel aparecía encajonado. Detectado en el recorrido.
    expect(overlay.parentElement).toBe(document.body)
    expect(getComputedStyle(overlay).position).toBe('fixed')
  })

  test('caso 24: el modal usa tokens de tema, no colores fijos', async () => {
    montar(); await listo()
    const modal = screen.getByTestId('allocation-modal')
    expect(modal.getAttribute('style')).toMatch(/var\(--/)
  })

  test('preseleccionar un comprobante lo pone primero pero NO le asigna importe', async () => {
    montar({ comprobanteId: 'c-b' }); await listo()
    const filas = screen.getAllByTestId(/^allocation-doc-/)
    expect(filas[0]).toHaveAttribute('data-testid', 'allocation-doc-c-b')
    expect(screen.getByTestId('allocation-total')).toHaveTextContent('$0')
  })
})
