/**
 * Motor de cálculo de cobros — TechRepair Pro
 * Pure TypeScript, sin dependencias externas.
 *
 * Soporta dos modos:
 *  1. Precio de lista → calcula cuánto recibo neto
 *  2. Neto deseado    → calcula cuánto cobrar al cliente
 */

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface PaymentRule {
  /** % de comisión base del proveedor (ej. 0.0399 = 3.99%) */
  fee_percent: number;
  /** Cargo fijo en ARS (ej. 10 ARS por transacción) */
  fee_fixed: number;
  /** % IVA sobre la comisión (ej. 0.21 = 21%) */
  vat_percent: number;
  /** % extra por cuotas (ej. 0.04 = 4% adicional para 3 cuotas) */
  installment_extra_percent: number;
  /** Si el negocio absorbe la comisión (no la traslada al cliente) */
  absorbs_fee: boolean;
  /** Cuotas */
  installments: number;
}

export interface ChargeResult {
  /** Monto que el cliente debe pagar */
  charge_amount: number;
  /** Comisión total estimada (fee + IVA sobre fee) */
  fee_amount: number;
  /** Solo el IVA sobre la comisión */
  vat_on_fee: number;
  /** Neto que recibe el negocio */
  net_amount: number;
  /** Tasa efectiva total incluyendo IVA y extras */
  effective_rate: number;
  /** Detalle por componente */
  breakdown: {
    base_fee:      number;
    installment_extra: number;
    vat_on_fee:    number;
    fixed_fee:     number;
    total_fee:     number;
  };
}

export interface PaymentButton {
  id: string;
  business_id: string;
  name: string;
  code: string;
  payment_type: string;
  provider: string;
  channel: 'manual' | 'integrated';
  integration_kind: 'none' | 'mp_qr' | 'mp_point' | 'mp_checkout' | 'custom';
  installments: number;
  fee_percent: number;
  fee_fixed: number;
  vat_percent: number;
  installment_extra_percent: number;
  absorbs_fee: boolean;
  is_active: boolean;
  sort_order: number;
  color: string;
  icon: string;
  notes?: string;
  created_at: string;
  updated_at: string;
}

// ─── Constantes predeterminadas ───────────────────────────────────────────────

export const DEFAULT_RULES: Record<string, Partial<PaymentRule>> = {
  'cash':           { fee_percent: 0,      fee_fixed: 0,  vat_percent: 0 },
  'transfer':       { fee_percent: 0,      fee_fixed: 0,  vat_percent: 0 },
  'mp_debit':       { fee_percent: 0.0089, fee_fixed: 0,  vat_percent: 0.21 },
  'mp_credit_1':    { fee_percent: 0.0399, fee_fixed: 0,  vat_percent: 0.21 },
  'mp_credit_3':    { fee_percent: 0.0399, fee_fixed: 0,  vat_percent: 0.21, installment_extra_percent: 0.04 },
  'mp_credit_6':    { fee_percent: 0.0399, fee_fixed: 0,  vat_percent: 0.21, installment_extra_percent: 0.09 },
  'mp_credit_12':   { fee_percent: 0.0399, fee_fixed: 0,  vat_percent: 0.21, installment_extra_percent: 0.18 },
  'mp_qr':          { fee_percent: 0.0099, fee_fixed: 0,  vat_percent: 0.21 },
  'mp_checkout':    { fee_percent: 0.0399, fee_fixed: 0,  vat_percent: 0.21 },
  'posnet_debit':   { fee_percent: 0.0080, fee_fixed: 0,  vat_percent: 0.21 },
  'posnet_credit':  { fee_percent: 0.0250, fee_fixed: 0,  vat_percent: 0.21 },
  'getnet_debit':   { fee_percent: 0.0075, fee_fixed: 0,  vat_percent: 0.21 },
  'getnet_credit':  { fee_percent: 0.0230, fee_fixed: 0,  vat_percent: 0.21 },
};

// ─── Función principal: cuánto cobrar para recibir un neto exacto ─────────────

/**
 * Calcula el monto que debe cobrarle al cliente para recibir exactamente `targetNet`.
 *
 * Fórmula:
 *   effective_rate = fee_percent + installment_extra + (fee_percent + installment_extra) * vat_percent
 *   charge = (targetNet + fee_fixed * (1 + vat_percent)) / (1 - effective_rate)
 *
 * @param targetNet - Neto que quiero recibir (ARS)
 * @param rule      - Regla del botón de cobro
 */
export function calculateChargeFromTargetNet(
  targetNet: number,
  rule: PaymentRule
): ChargeResult {
  const {
    fee_percent,
    fee_fixed,
    vat_percent,
    installment_extra_percent,
    absorbs_fee,
  } = rule;

  if (absorbs_fee) {
    // El negocio absorbe la comisión: el cliente paga exactamente el neto deseado
    const base_fee          = targetNet * fee_percent;
    const installment_extra = targetNet * installment_extra_percent;
    const total_fee_pre_vat = base_fee + installment_extra + fee_fixed;
    const vat_on_fee        = total_fee_pre_vat * vat_percent;
    const total_fee         = total_fee_pre_vat + vat_on_fee;

    return {
      charge_amount:  roundARS(targetNet),
      fee_amount:     roundARS(total_fee),
      vat_on_fee:     roundARS(vat_on_fee),
      net_amount:     roundARS(targetNet - total_fee),
      effective_rate: total_fee / Math.max(targetNet, 0.01),
      breakdown: {
        base_fee:          roundARS(base_fee),
        installment_extra: roundARS(installment_extra),
        vat_on_fee:        roundARS(vat_on_fee),
        fixed_fee:         roundARS(fee_fixed),
        total_fee:         roundARS(total_fee),
      },
    };
  }

  // El negocio traslada la comisión al cliente:
  // charge = (targetNet + fee_fixed * (1 + vat)) / (1 - variable_rate_with_vat)
  const variable_rate     = fee_percent + installment_extra_percent;
  const variable_rate_vat = variable_rate * (1 + vat_percent);
  const fixed_with_vat    = fee_fixed * (1 + vat_percent);
  const denominator       = 1 - variable_rate_vat;

  if (denominator <= 0) {
    // Tasa >= 100%: cobrar al menos el neto + fee fijo
    const charge = targetNet + fixed_with_vat;
    return buildResult(charge, charge - targetNet, rule);
  }

  const charge = (targetNet + fixed_with_vat) / denominator;
  return buildResult(charge, charge - targetNet, rule);
}

// ─── Función inversa: dado que cobro X, cuánto recibo ─────────────────────────

/**
 * Calcula cuánto neto recibe el negocio dado un monto bruto cobrado al cliente.
 *
 * @param gross - Monto cobrado al cliente
 * @param rule  - Regla del botón de cobro
 */
export function calculateNetFromGross(
  gross: number,
  rule: PaymentRule
): ChargeResult {
  return buildResult(gross, null, rule);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildResult(
  charge: number,
  knownFee: number | null,
  rule: PaymentRule
): ChargeResult {
  const { fee_percent, fee_fixed, vat_percent, installment_extra_percent } = rule;

  const base_fee          = charge * fee_percent;
  const installment_extra = charge * installment_extra_percent;
  const total_fee_pre_vat = base_fee + installment_extra + fee_fixed;
  const vat_on_fee        = total_fee_pre_vat * vat_percent;
  const total_fee         = knownFee ?? (total_fee_pre_vat + vat_on_fee);
  const net               = charge - total_fee;

  return {
    charge_amount:  roundARS(charge),
    fee_amount:     roundARS(total_fee),
    vat_on_fee:     roundARS(vat_on_fee),
    net_amount:     roundARS(Math.max(0, net)),
    effective_rate: charge > 0 ? total_fee / charge : 0,
    breakdown: {
      base_fee:          roundARS(base_fee),
      installment_extra: roundARS(installment_extra),
      vat_on_fee:        roundARS(vat_on_fee),
      fixed_fee:         roundARS(fee_fixed),
      total_fee:         roundARS(total_fee),
    },
  };
}

function roundARS(v: number): number {
  return Math.round(v * 100) / 100;
}

// ─── Helpers de UI ────────────────────────────────────────────────────────────

export function ruleFromButton(btn: PaymentButton): PaymentRule {
  return {
    fee_percent:               btn.fee_percent,
    fee_fixed:                 btn.fee_fixed,
    vat_percent:               btn.vat_percent,
    installment_extra_percent: btn.installment_extra_percent,
    absorbs_fee:               btn.absorbs_fee,
    installments:              btn.installments,
  };
}

export function formatFeeLabel(btn: PaymentButton): string {
  const pct = btn.fee_percent * 100;
  const parts: string[] = [];
  if (pct > 0)          parts.push(`${pct.toFixed(2)}%`);
  if (btn.fee_fixed > 0) parts.push(`+$${btn.fee_fixed}`);
  if (btn.vat_percent > 0) parts.push(`(+IVA)`);
  return parts.length > 0 ? parts.join(' ') : 'Sin comisión';
}

export function isIntegrated(btn: PaymentButton): boolean {
  return btn.channel === 'integrated' && btn.integration_kind !== 'none';
}

export function isMercadoPago(btn: PaymentButton): boolean {
  return btn.provider === 'mercadopago';
}

// ─── Tipos de pago visuales ───────────────────────────────────────────────────

export const PAYMENT_TYPE_LABELS: Record<string, string> = {
  cash:     'Efectivo',
  transfer: 'Transferencia',
  debit:    'Débito',
  credit:   'Crédito',
  qr:       'QR',
  wallet:   'Billetera digital',
  check:    'Cheque',
  other:    'Otro',
};

export const PROVIDER_LABELS: Record<string, string> = {
  manual:       'Manual',
  mercadopago:  'Mercado Pago',
  posnet:       'Posnet',
  getnet:       'Getnet',
  prisma:       'Prisma (Visa)',
  fiserv:       'Fiserv',
  banco:        'Banco',
  personalizado:'Personalizado',
};

export const INTEGRATION_LABELS: Record<string, string> = {
  none:        'Manual',
  mp_qr:       'MP QR',
  mp_point:    'MP Point',
  mp_checkout: 'MP Link de pago',
  custom:      'Personalizado',
};

// ─── Formateadores ────────────────────────────────────────────────────────────

export const fmtARS = (v: number): string =>
  `$${(v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const fmtPct = (v: number): string =>
  `${(v * 100).toFixed(2)}%`;
