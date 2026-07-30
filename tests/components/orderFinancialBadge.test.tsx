// ─────────────────────────────────────────────────────────────────────────────
// P0-A.1U1 — Badge financiero: comportamiento real sobre el DOM.
// Casos 1-4 y 9-10 de la especificación.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OrderFinancialBadge } from '../../src/components/orders/OrderFinancialBadge'

describe('OrderFinancialBadge', () => {
  test('caso 1: renderiza "Sin facturar" desde el valor server-side', () => {
    render(<OrderFinancialBadge status="sin_facturar" />)
    const b = screen.getByTestId('order-financial-badge')
    expect(b).toHaveTextContent('Sin facturar')
    expect(b).toHaveAttribute('data-status', 'sin_facturar')
    expect(b.getAttribute('title')).toMatch(/no tiene un comprobante vigente/i)
  })

  test('caso 2: renderiza "Pendiente"', () => {
    render(<OrderFinancialBadge status="pending" />)
    const b = screen.getByTestId('order-financial-badge')
    expect(b).toHaveTextContent('Pendiente')
    expect(b.getAttribute('title')).toMatch(/saldo completo pendiente/i)
  })

  test('caso 3: renderiza "Parcial"', () => {
    render(<OrderFinancialBadge status="partial" />)
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('Parcial')
  })

  test('caso 4: renderiza "Cobrado"', () => {
    render(<OrderFinancialBadge status="paid" />)
    const b = screen.getByTestId('order-financial-badge')
    expect(b).toHaveTextContent('Cobrado')
    expect(b.getAttribute('title')).toMatch(/no tiene saldo pendiente/i)
  })

  test('caso 9: ante error muestra "No disponible" y NUNCA un estado inventado', () => {
    render(<OrderFinancialBadge status={null} unavailable />)
    const b = screen.getByTestId('order-financial-badge')
    expect(b).toHaveTextContent('No disponible')
    expect(b).toHaveAttribute('data-status', 'unavailable')
    // Ninguno de los estados reales puede aparecer como fallback.
    for (const falso of ['Cobrado', 'Sin facturar', 'Pendiente', 'Parcial']) {
      expect(b).not.toHaveTextContent(falso)
    }
  })

  test('el estado nulo sin flag también cae en "No disponible" (fail-closed)', () => {
    render(<OrderFinancialBadge status={null} />)
    expect(screen.getByTestId('order-financial-badge')).toHaveTextContent('No disponible')
  })

  test('el significado no depende sólo del color: siempre hay texto y aria-label', () => {
    for (const s of ['paid', 'partial', 'pending', 'sin_facturar'] as const) {
      const { unmount } = render(<OrderFinancialBadge status={s} />)
      const b = screen.getByTestId('order-financial-badge')
      expect(b.textContent?.trim().length ?? 0).toBeGreaterThan(0)
      expect(b.getAttribute('aria-label')).toMatch(/Estado de cobro/)
      unmount()
    }
  })

  test('caso 13: los colores salen de tokens de tema (var(--…)), no hardcodeados', () => {
    render(<OrderFinancialBadge status="paid" />)
    const b = screen.getByTestId('order-financial-badge')
    // El style inline debe referenciar variables CSS, que son las que cambian
    // entre light y dark. Un hex fijo rompería el tema oscuro.
    expect(b.getAttribute('style')).toMatch(/var\(--/)
    expect(b.getAttribute('style')).not.toMatch(/#[0-9a-f]{6}/i)
  })
})
