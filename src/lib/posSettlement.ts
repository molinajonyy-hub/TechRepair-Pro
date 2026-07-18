/**
 * posSettlement — liquidación canónica del cobro del POS (aritmética pura).
 *
 * Fuente ÚNICA de verdad para, dado el total base de la venta y los medios de
 * pago (con el recargo YA decidido por quien llama), responder:
 *   - total EXIGIBLE al cliente = base + recargos trasladados;
 *   - cobertura, y si falta / alcanza / se pasa;
 *   - vuelto — SOLO por exceso de EFECTIVO;
 *   - sobrepago no-efectivo (tarjeta/transferencia/CC) — inválido, jamás vuelto.
 *
 * Bug que corrige (smoke a04b349): el modal comparaba los pagos —que ya incluyen
 * el recargo trasladado— contra el total BASE, tratando el recargo como vuelto y
 * disparando un falso sobrepago.
 *
 * NO decide política: recibe el `surcharge` por línea ya resuelto (ver
 * paymentSurcharge.ts). Tampoco decide nada fiscal/ARCA — `totalExigible` es un
 * hecho de caja (lo que el cliente entrega), no el importe facturado.
 */

export type PosPayMethod =
  | 'efectivo'
  | 'transferencia'
  | 'cuenta_corriente'
  | 'tarjeta'
  | 'otro';

export interface PosPaymentLine {
  /** Medio de pago. Solo 'efectivo' puede generar vuelto. */
  method: PosPayMethod;
  /** Monto TOTAL registrado en la línea (base + recargo ya incluido), en ARS. */
  amount: number;
  /** Recargo trasladado al cliente en esta línea (≥ 0), ya incluido en `amount`. */
  surcharge?: number;
}

export interface PosSettlementInput {
  /** Total base del comprobante = subtotal + IVA, SIN recargos. */
  totalBase: number;
  payments: PosPaymentLine[];
  /** Tolerancia en ARS para comparaciones (evita ruido de punto flotante). Default 1. */
  tolerance?: number;
}

export type PosSettlementEstado = 'exacto' | 'saldo_pendiente' | 'sobrepago_no_efectivo';

export interface PosSettlement {
  totalBase: number;
  /** Suma de recargos trasladados (contado una sola vez). */
  totalRecargo: number;
  /** Total final a cobrar = base + recargo. */
  totalExigible: number;
  /** Cobertura efectiva contra el exigible (efectivo capado a lo adeudado). */
  cobertura: number;
  /** exigible − cobertura. > tol ⇒ saldo pendiente; ~0 ⇒ cubierto. */
  diferencia: number;
  /** Vuelto — SOLO por exceso de efectivo. Nunca por recargo ni por tarjeta. */
  vuelto: number;
  /** Excedente en medios no-efectivo (tarjeta/transferencia/CC). > tol ⇒ inválido. */
  sobrepagoNoEfectivo: number;
  estado: PosSettlementEstado;
  /** true solo si la cobertura iguala el exigible sin sobrepago no-efectivo. */
  valido: boolean;
}

/**
 * Calcula la liquidación canónica. Función PURA: mismos inputs ⇒ mismo output
 * (segura para recalcular ante cualquier cambio dinámico).
 */
export function computeSettlement(input: PosSettlementInput): PosSettlement {
  const tol = input.tolerance ?? 1;

  let totalRecargo = 0;
  let cashPaid = 0;          // efectivo — único medio que da vuelto
  let exactInstruments = 0;  // tarjeta / transferencia / otro / cuenta corriente

  for (const p of input.payments) {
    const amount = p.amount || 0;
    totalRecargo += Math.max(0, p.surcharge || 0);
    if (p.method === 'efectivo') cashPaid += amount;
    else exactInstruments += amount;
  }

  const totalExigible = input.totalBase + totalRecargo;

  // Los medios exactos nunca dan vuelto: su excedente es sobrepago real.
  const sobrepagoNoEfectivo = Math.max(0, exactInstruments - totalExigible);
  // El efectivo cubre lo que reste; lo que sobre por encima de ese resto es el
  // ÚNICO vuelto legítimo.
  const remainderForCash = Math.max(0, totalExigible - exactInstruments);
  const vuelto = Math.max(0, cashPaid - remainderForCash);

  const cobertura =
    Math.min(exactInstruments, totalExigible) + Math.min(cashPaid, remainderForCash);
  const diferencia = totalExigible - cobertura;

  const estado: PosSettlementEstado =
    sobrepagoNoEfectivo > tol ? 'sobrepago_no_efectivo'
    : diferencia > tol ? 'saldo_pendiente'
    : 'exacto';

  return {
    totalBase: input.totalBase,
    totalRecargo,
    totalExigible,
    cobertura,
    diferencia,
    vuelto,
    sobrepagoNoEfectivo,
    estado,
    valido: estado === 'exacto',
  };
}
