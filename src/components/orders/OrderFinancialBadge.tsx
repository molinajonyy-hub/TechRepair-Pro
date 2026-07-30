/**
 * P0-A.1U1 — Badge del estado FINANCIERO de una orden.
 *
 * El estado llega ya resuelto desde `v_order_financial_status` (server-side).
 * Este componente NO deriva nada: no compara saldos, no suma pagos, no decide
 * si algo está cobrado. Sólo traduce el valor canónico a texto, color y ayuda.
 *
 * Es un eje INDEPENDIENTE del estado técnico (`orders.status`), que representa
 * el trabajo. Una orden puede estar Completada y Pendiente a la vez.
 */
import { colors, radius } from '../../lib/tokens'

/** Valores canónicos de `v_order_financial_status.payment_status`. */
export type OrderPaymentStatus = 'sin_facturar' | 'pending' | 'partial' | 'paid'

/** `null` = el bloque financiero no se pudo cargar. NUNCA se asume un estado. */
export type OrderPaymentStatusOrError = OrderPaymentStatus | null

interface Props {
  status: OrderPaymentStatusOrError
  /** true cuando la consulta financiera falló: se muestra "No disponible". */
  unavailable?: boolean
  size?: 'sm' | 'md'
}

const CONFIG: Record<OrderPaymentStatus, { label: string; help: string; fg: string; bg: string; border: string }> = {
  paid: {
    label: 'Cobrado',
    help: 'El comprobante no tiene saldo pendiente.',
    fg: colors.success, bg: colors.successBg, border: colors.successBorder,
  },
  partial: {
    label: 'Parcial',
    help: 'Se cobró o imputó una parte y queda saldo pendiente.',
    fg: colors.warning, bg: colors.warningBg, border: colors.warningBorder,
  },
  pending: {
    label: 'Pendiente',
    help: 'El comprobante mantiene su saldo completo pendiente.',
    fg: colors.error, bg: colors.errorBg, border: colors.errorBorder,
  },
  sin_facturar: {
    label: 'Sin facturar',
    help: 'La orden no tiene un comprobante vigente vinculado.',
    fg: colors.text.muted, bg: 'transparent', border: colors.border.subtle,
  },
}

export function OrderFinancialBadge({ status, unavailable = false, size = 'md' }: Props) {
  // Un error NUNCA se convierte en "Cobrado", "Sin facturar" ni $0.
  if (unavailable || status == null) {
    return (
      <span
        data-testid="order-financial-badge"
        data-status="unavailable"
        title="No se pudo cargar el estado financiero de esta orden."
        aria-label="Estado financiero no disponible"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
          padding: size === 'sm' ? '0.1rem 0.4rem' : '0.15rem 0.5rem',
          borderRadius: radius.full, border: `1px dashed ${colors.border.subtle}`,
          background: 'transparent', color: colors.text.muted,
          fontSize: size === 'sm' ? '0.68rem' : '0.72rem', fontWeight: 600, whiteSpace: 'nowrap',
        }}
      >
        No disponible
      </span>
    )
  }

  const c = CONFIG[status]
  return (
    <span
      data-testid="order-financial-badge"
      data-status={status}
      title={c.help}
      aria-label={`Estado de cobro: ${c.label}. ${c.help}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
        padding: size === 'sm' ? '0.1rem 0.4rem' : '0.15rem 0.5rem',
        borderRadius: radius.full, border: `1px solid ${c.border}`,
        background: c.bg, color: c.fg,
        fontSize: size === 'sm' ? '0.68rem' : '0.72rem', fontWeight: 700, whiteSpace: 'nowrap',
      }}
    >
      {/* El texto siempre acompaña al color: nunca se depende sólo del color. */}
      {c.label}
    </span>
  )
}

/** Etiqueta legible de un estado, para filtros y textos auxiliares. */
export const financialStatusLabel = (s: OrderPaymentStatus): string => CONFIG[s].label
