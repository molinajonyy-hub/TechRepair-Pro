// ─────────────────────────────────────────────────────────────────────────────
// SEC-08C fase B · LOS TRES ESTADOS DE LA DEUDA CON PROVEEDORES EN LA UI.
//
// El servidor ya distingue cero-real / autorizado / restringido
// (get_finance_charts_l1 devuelve NULL + is_authorized). Estos tests exigen que
// la UI NO vuelva a colapsarlos: un `null` no puede leerse como «no tenés deuda
// pendiente con proveedores», que es la frase más tranquilizadora posible sobre
// un dato que no se pudo leer.
// ─────────────────────────────────────────────────────────────────────────────
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  payablesSummaryText, receivablesSummaryText, PayablesDueBlock,
} from '../../src/components/finance/charts/AgingCharts'
import type { AgingSection, PayablesDue } from '../../src/services/financeChartsService'

const aging = (over: Partial<AgingSection>): AgingSection => ({
  total: 0, documents: 0, buckets: [], ...over,
})
const due = (over: Partial<PayablesDue>): PayablesDue => ({
  due_soon_amount: 0, overdue_amount: 0, undated_amount: 0, undated_count: 0,
  has_due_dates: false, ...over,
})

describe('SEC-08C fase B · resumen de payables', () => {
  it('deuda real distinta de cero: dice el importe exacto', () => {
    const t = payablesSummaryText(aging({
      total: 82395, documents: 2,
      buckets: [{ bucket: '0-7', amount: 82395, documents: 2 }],
      is_authorized: true,
    }))
    expect(t).toContain('82.395')
    expect(t).not.toMatch(/No tenés/)
  })

  it('deuda real CERO: puede afirmar que no hay deuda', () => {
    const t = payablesSummaryText(aging({ total: 0, documents: 0, is_authorized: true }))
    expect(t).toBe('No tenés deuda pendiente con proveedores.')
  })

  it('RESTRINGIDO: no afirma que no hay deuda', () => {
    const t = payablesSummaryText(aging({ total: null, documents: null, is_authorized: false }))
    expect(t).toBe('No tenés acceso a la deuda con proveedores.')
    expect(t).not.toMatch(/No tenés deuda pendiente/)
    expect(t).not.toContain('$0')
  })

  it('is_authorized=false manda aunque llegara un número', () => {
    // Defensa en profundidad: si el servidor mandara un 0 con is_authorized
    // false, la UI sigue sin poder afirmar que no hay deuda.
    const t = payablesSummaryText(aging({ total: 0, documents: 0, is_authorized: false }))
    expect(t).toBe('No tenés acceso a la deuda con proveedores.')
  })

  it('la cartera de clientes conserva su comportamiento', () => {
    expect(receivablesSummaryText(aging({ total: 0, documents: 0 })))
      .toBe('No tenés saldos pendientes de cobro.')
    expect(receivablesSummaryText(aging({
      total: 51988, documents: 1, buckets: [{ bucket: '0-7', amount: 51988, documents: 1 }],
    }))).toContain('51.988')
  })
})

describe('SEC-08C fase B · bloque de vencimientos', () => {
  it('restringido: lo dice, y no habla de fechas sin cargar', () => {
    render(<PayablesDueBlock due={due({
      due_soon_amount: null, overdue_amount: null, undated_amount: null,
      undated_count: null, has_due_dates: false, is_authorized: false,
    })} />)
    expect(screen.getByTestId('payables-due-restricted')).toBeInTheDocument()
    expect(screen.getByText(/No tenés acceso a los vencimientos/)).toBeInTheDocument()
    expect(screen.queryByText(/Todavía no cargaste fechas/)).not.toBeInTheDocument()
  })

  it('autorizado sin fechas cargadas: ese mensaje SÍ es legítimo', () => {
    render(<PayablesDueBlock due={due({ has_due_dates: false, is_authorized: true })} />)
    expect(screen.getByText(/Todavía no cargaste fechas/)).toBeInTheDocument()
    expect(screen.queryByTestId('payables-due-restricted')).not.toBeInTheDocument()
  })

  it('autorizado con vencimientos: muestra los importes', () => {
    render(<PayablesDueBlock due={due({
      overdue_amount: 51988, due_soon_amount: 30407, has_due_dates: true, is_authorized: true,
    })} />)
    expect(screen.getByTestId('payables-due')).toBeInTheDocument()
    expect(screen.getByText(/51\.988/)).toBeInTheDocument()
  })
})
