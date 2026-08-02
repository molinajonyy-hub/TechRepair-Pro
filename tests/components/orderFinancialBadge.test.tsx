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

  // ───────────────────────────────────────────────────────────────────────────
  // Invariante de contraste. El gate visual midió dos fallas reales:
  //   · --text-subtle sobre el listado dark → 2.29:1
  //   · --success/--error sobre su *-subtle en light → 3.51:1 y 4.40:1
  // Los foregrounds de estos badges viven en --order-badge-*-fg, que llevan un
  // valor por tema y superan 4.5:1 en ambos. Volver a los tokens semánticos
  // globales reintroduce el defecto en light.
  // ───────────────────────────────────────────────────────────────────────────
  const FOREGROUND_ESPERADO = {
    paid:         '--order-badge-paid-fg',
    partial:      '--order-badge-partial-fg',
    pending:      '--order-badge-pending-fg',
    sin_facturar: '--order-badge-neutral-fg',
  } as const

  /** Foregrounds que NO alcanzan 4.5:1 en alguno de los dos temas. */
  const FOREGROUND_PROHIBIDO = ['--text-subtle', '--success', '--error', '--warning-soft']

  const colorDe = (style: string) => style.match(/(?:^|;)\s*color:\s*([^;]+)/)?.[1]?.trim() ?? ''

  test('cada badge usa su foreground propio, con contraste verificado en ambos temas', () => {
    for (const [status, variable] of Object.entries(FOREGROUND_ESPERADO)) {
      const { unmount } = render(<OrderFinancialBadge status={status as keyof typeof FOREGROUND_ESPERADO} />)
      const color = colorDe(screen.getByTestId('order-financial-badge').getAttribute('style') ?? '')
      expect(color).toBe(`var(${variable})`)
      unmount()
    }
  })

  test('"No disponible" tampoco usa un foreground insuficiente', () => {
    render(<OrderFinancialBadge status={null} unavailable />)
    const color = colorDe(screen.getByTestId('order-financial-badge').getAttribute('style') ?? '')
    expect(color).toBe('var(--order-badge-neutral-fg)')
  })

  test('ningún badge vuelve a los tokens que fallan el contraste', () => {
    for (const status of ['paid', 'partial', 'pending', 'sin_facturar'] as const) {
      const { unmount } = render(<OrderFinancialBadge status={status} />)
      const color = colorDe(screen.getByTestId('order-financial-badge').getAttribute('style') ?? '')
      for (const prohibido of FOREGROUND_PROHIBIDO) {
        expect(color).not.toBe(`var(${prohibido})`)
      }
      unmount()
    }
  })
})
