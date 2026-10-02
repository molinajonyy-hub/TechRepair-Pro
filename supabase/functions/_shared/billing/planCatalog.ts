/**
 * planCatalog — BETA-MP · catálogo de planes del lado servidor.
 *
 * Plan B (2026-10-02): el backend crea el preapproval por API (`POST /preapproval`)
 * y es quien define qué se cobra. Este módulo es la ÚNICA fuente de precio y
 * frecuencia de un checkout:
 *
 *   plan + ciclo pedidos  →  importe, moneda y frecuencia que se le mandan a MP
 *   `auto_recurring` que informa MP  →  ¿son las condiciones de ESE checkout?
 *
 * El navegador sólo propone plan y ciclo. Importe, moneda y frecuencia nunca
 * salen del body. Los planes creados en el panel de Mercado Pago (`MP_PLAN_*`)
 * dejaron de usarse: su checkout por URL no conserva `external_reference`, así
 * que un pago hecho ahí no se puede vincular con un negocio.
 *
 * Puro: sin `Deno.*`. Corre igual en Deno (Edge Functions) y en Node (tests).
 */

export const BILLING_PLANS = ['basico', 'pro', 'full'] as const
export type BillingPlan = (typeof BILLING_PLANS)[number]

export const BILLING_CYCLES = ['monthly', 'quarterly', 'annual'] as const
export type BillingCycle = (typeof BILLING_CYCLES)[number]

export function isBillingPlan(value: unknown): value is BillingPlan {
  return typeof value === 'string' && (BILLING_PLANS as readonly string[]).includes(value)
}

export function isBillingCycle(value: unknown): value is BillingCycle {
  return typeof value === 'string' && (BILLING_CYCLES as readonly string[]).includes(value)
}

export type MpFrequencyType = 'months' | 'years'

/**
 * Frecuencias de Mercado Pago que equivalen a cada ciclo. Es una lista cerrada:
 * lo que no figura acá no es ese ciclo. La PRIMERA de cada ciclo es la que el
 * servidor manda al crear el preapproval (`months` es la unidad documentada de
 * `POST /preapproval`).
 *
 * Evidencia real (preflight del 2026-10-01/02, `GET /preapproval_plan/search`):
 * Mercado Pago expresa un período anual como `1` / `"years"` en los planes del
 * panel. Son el mismo período que `12` / `"months"`, así que al LEER se aceptan
 * las dos formas. Mensual y trimestral tienen una sola.
 */
export const CYCLE_FREQUENCIES: Record<BillingCycle, readonly { frequency: number; frequencyType: MpFrequencyType }[]> = {
  monthly:   [{ frequency: 1, frequencyType: 'months' }],
  quarterly: [{ frequency: 3, frequencyType: 'months' }],
  annual:    [{ frequency: 12, frequencyType: 'months' }, { frequency: 1, frequencyType: 'years' }],
}

/**
 * ¿La frecuencia que informa Mercado Pago es la del ciclo?
 *
 * Fail-closed: una cantidad que no sea un entero positivo, una unidad que no
 * sea exactamente `months` o `years`, o una combinación fuera de la tabla → `false`.
 * No hay conversión entre unidades más allá de las equivalencias listadas
 * (`2 years`, `24 months`, `365 days`, `1 years` para un mensual: todas `false`).
 */
export function matchesBillingCycleFrequency(billingCycle: BillingCycle, frequency: unknown, frequencyType: unknown): boolean {
  const amount = typeof frequency === 'number'
    ? frequency
    : typeof frequency === 'string' && /^\d+$/.test(frequency.trim()) ? Number(frequency.trim()) : NaN
  if (!Number.isInteger(amount) || amount <= 0) return false
  const unit = typeof frequencyType === 'string' ? frequencyType.trim().toLowerCase() : ''
  return (CYCLE_FREQUENCIES[billingCycle] ?? []).some((f) => f.frequency === amount && f.frequencyType === unit)
}

// ── Precios ─────────────────────────────────────────────────────────────────

export const BILLING_CURRENCY = 'ARS'

export type PlanPriceTable = Record<BillingPlan, Partial<Record<BillingCycle, number>>>

/**
 * Importe por ciclo, en ARS. Es lo que Mercado Pago cobra.
 *
 * Tiene que coincidir con lo que muestra Planes (`PLANS` en
 * `src/types/subscription.ts`): `tests/unit/billingContracts.test.ts` falla si
 * las dos tablas difieren. Un ciclo sin importe no se vende (503): el
 * trimestral no se ofrece en Planes y queda sin precio a propósito.
 */
export const PLAN_PRICES: PlanPriceTable = {
  basico: { monthly: 15_000, annual: 144_000 },
  pro:    { monthly: 25_000, annual: 240_000 },
  full:   { monthly: 45_000, annual: 432_000 },
}

/** Lo que el servidor le pide cobrar a Mercado Pago por un checkout. */
export interface CheckoutTerms {
  amount: number
  currency: string
  frequency: number
  frequencyType: MpFrequencyType
}

export interface PlanCatalog {
  /** `null` si ese plan/ciclo no tiene precio: no se vende. */
  termsFor(plan: BillingPlan, billingCycle: BillingCycle): CheckoutTerms | null
}

export function buildPlanCatalog(prices: PlanPriceTable = PLAN_PRICES): PlanCatalog {
  return {
    termsFor(plan, billingCycle) {
      const amount = prices[plan]?.[billingCycle]
      const send = CYCLE_FREQUENCIES[billingCycle]?.[0]
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || !send) return null
      return { amount, currency: BILLING_CURRENCY, frequency: send.frequency, frequencyType: send.frequencyType }
    },
  }
}

// ── Condiciones de un checkout contra lo que informa Mercado Pago ───────────

export interface ExpectedTerms {
  billingCycle: BillingCycle
  amount: number | string
  currency: string
}

export type TermsProblem = 'no_terms' | 'amount_mismatch' | 'currency_mismatch' | 'frequency_mismatch'

/**
 * ¿El `auto_recurring` de un preapproval es lo que el servidor pidió para ese
 * checkout? Devuelve el primer problema, o `null` si coincide.
 *
 * Es la guarda contra el drift silencioso: un preapproval cuyo importe, moneda
 * o frecuencia no son los de la sesión que lo originó no activa nada.
 */
export function checkoutTermsProblem(expected: ExpectedTerms, recurring: unknown): TermsProblem | null {
  if (!recurring || typeof recurring !== 'object') return 'no_terms'
  const r = recurring as { frequency?: unknown; frequency_type?: unknown; transaction_amount?: unknown; currency_id?: unknown }

  const want = Number(expected.amount)
  const got = typeof r.transaction_amount === 'number'
    ? r.transaction_amount
    : typeof r.transaction_amount === 'string' && r.transaction_amount.trim() !== '' ? Number(r.transaction_amount) : NaN
  if (!Number.isFinite(want) || want <= 0 || !Number.isFinite(got) || Math.abs(got - want) >= 0.005) return 'amount_mismatch'

  const currency = typeof r.currency_id === 'string' ? r.currency_id.trim().toUpperCase() : ''
  if (currency === '' || currency !== expected.currency.trim().toUpperCase()) return 'currency_mismatch'

  if (!matchesBillingCycleFrequency(expected.billingCycle, r.frequency, r.frequency_type)) return 'frequency_mismatch'
  return null
}
