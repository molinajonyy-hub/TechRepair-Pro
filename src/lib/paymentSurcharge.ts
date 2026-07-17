/**
 * paymentSurcharge — política de recargo trasladado al cliente por método de cobro.
 *
 * Regla de negocio (hotfix a04b349, decisión funcional): en una operación de UN
 * SOLO PAGO no puede existir diferencia entre el precio de contado y el precio
 * pagado con tarjeta. Por lo tanto:
 *   - Débito y crédito/tarjeta en UNA cuota → NO se traslada recargo al cliente
 *     (paga el precio de lista). La comisión del procesador sigue siendo COSTO
 *     del comercio y se conserva por separado (commission_rate del pago).
 *   - Tarjeta en CUOTAS (≥ 2) → se preserva el comportamiento existente
 *     (recargo trasladado al cliente). Su tratamiento fiscal/ARCA es una
 *     decisión aparte fuera de este hotfix.
 *
 * Limitación del modelo (deuda informada, no resuelta acá): el sistema NO
 * distingue estructuralmente "comisión cobrada al comercio" de "recargo/
 * financiación cobrada al cliente" — reutiliza un único campo `percentage` con
 * `charge_mode`, y no persiste la cantidad de cuotas (se infiere del nombre de
 * la opción). Este helper NO migra datos: sólo decide, en tiempo de cobro, si
 * el recargo se traslada. Separar ambos conceptos requiere un cambio de modelo
 * y validación contable posteriores.
 */

export type ChargeMode = 'none' | 'customer' | 'business';

export interface SurchargeMethodLike {
  charge_mode: ChargeMode;
  /** Porcentaje 0–100 configurado para el método. */
  percentage: number;
  /** Etiqueta corta de la opción (p.ej. "1 cuota", "3 cuotas", "Débito"). */
  short_label?: string;
  label?: string;
}

// "3 cuotas", "6 cuotas", "12 cuotas", "1 cuota", "en 3 pagos", "3 pagos"…
const INSTALLMENT_RE = /(\d+)\s*(?:cuota|cuotas|pago|pagos)/i;

/**
 * Cantidad de cuotas inferida del nombre de la opción. Débito/crédito/QR/
 * contado o cualquier nombre sin número explícito de cuotas ⇒ 1 (un pago).
 */
export function parseInstallments(label: string | null | undefined): number {
  if (!label) return 1;
  const m = INSTALLMENT_RE.exec(label);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

/** true para débito y cualquier tarjeta/crédito en un solo pago. */
export function isSinglePayment(method: SurchargeMethodLike): boolean {
  return parseInstallments(method.short_label ?? method.label) <= 1;
}

/**
 * Tasa de recargo (0–1) que efectivamente se traslada al cliente para este
 * método. Es 0 salvo en cuotas reales (≥ 2) con `charge_mode = 'customer'`.
 * Nunca decide nada fiscal: sólo si el recargo se cobra al cliente.
 *
 * Decisión 1 (cuánto paga el cliente): SOLO `charge_mode = 'customer'` en
 * cuotas reales traslada recargo. Débito / un pago / 'business' / 'none' ⇒ 0.
 */
export function customerSurchargeRate(method: SurchargeMethodLike): number {
  if (method.charge_mode !== 'customer') return 0;
  if (isSinglePayment(method)) return 0;
  const pct = (method.percentage || 0) / 100;
  return pct > 0 ? pct : 0;
}

/**
 * Tasa de comisión/costo (0–1) que ABSORBE el comercio para este método.
 *
 * Decisión 2 (qué costo absorbe el comercio): la comisión SOLO existe cuando la
 * configuración lo declara explícitamente con `charge_mode = 'business'`. Nunca
 * se infiere del nombre, la cantidad de cuotas, el recargo al cliente, el
 * importe final ni la diferencia entre importe original y pagado. Un porcentaje
 * `customer` es recargo al cliente, jamás costo del comercio ⇒ devuelve 0
 * (evita el costo financiero ficticio del riesgo #1).
 */
export function effectiveMerchantCommissionRate(method: SurchargeMethodLike): number {
  if (method.charge_mode !== 'business') return 0;
  const pct = (method.percentage || 0) / 100;
  return Number.isFinite(pct) && pct > 0 ? pct : 0;
}

/**
 * ¿Hay un recargo configurado que NO se trasladará por ser un pago único?
 * Sirve para advertir en la pantalla de configuración sin romper cuotas
 * legítimas ni migrar datos.
 */
export function isSuppressedSinglePaymentSurcharge(method: SurchargeMethodLike): boolean {
  return (
    method.charge_mode === 'customer' &&
    (method.percentage || 0) > 0 &&
    isSinglePayment(method)
  );
}
