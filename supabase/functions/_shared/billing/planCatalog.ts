/**
 * planCatalog — BETA-MP · única tabla de planes de Mercado Pago del lado servidor.
 *
 * Los IDs de plan viven SÓLO en los secrets de las Edge Functions
 * (`MP_PLAN_<PLAN>_<CICLO>`). Este módulo es el único lugar que los traduce:
 *
 *   plan + ciclo pedidos   →  id de plan de MP   (para armar el checkout)
 *   id de plan que informa MP  →  plan + ciclo  (para decidir qué se otorga)
 *
 * La segunda dirección es la que importa para la seguridad: el plan que recibe
 * un negocio sale de lo que Mercado Pago dice que se contrató, nunca de lo que
 * el navegador pidió. Un id que no está en esta tabla no otorga nada.
 *
 * Puro: recibe un lector de entorno, no toca `Deno.env`. Corre igual en Deno
 * (Edge Functions) y en Node (tests).
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
 * lo que no figura acá no es ese ciclo.
 *
 * Evidencia real (preflight del 2026-10-01/02, `GET /preapproval_plan/search`):
 * los planes ANUALES creados desde el panel oficial vuelven como
 * `frequency = 1, frequency_type = "years"`; los mensuales, `1` / `"months"`.
 * Un plan anual creado por API puede expresarse como `12` / `"months"`: son el
 * mismo período, así que se aceptan las dos formas. Mensual y trimestral tienen
 * una sola.
 */
export const CYCLE_FREQUENCIES: Record<BillingCycle, readonly { frequency: number; frequencyType: MpFrequencyType }[]> = {
  monthly:   [{ frequency: 1, frequencyType: 'months' }],
  quarterly: [{ frequency: 3, frequencyType: 'months' }],
  annual:    [{ frequency: 12, frequencyType: 'months' }, { frequency: 1, frequencyType: 'years' }],
}

/**
 * ¿La frecuencia que informa Mercado Pago para un plan es la del ciclo pedido?
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

export interface PlanCatalogEntry {
  plan: BillingPlan
  billingCycle: BillingCycle
  mpPlanId: string
  /** Nombre del secret. Sólo para logs del servidor: nunca viaja al navegador. */
  envKey: string
}

export interface PlanCatalog {
  entries: readonly PlanCatalogEntry[]
  /** IDs de plan de MP configurados en más de un secret. Ninguno de ellos resuelve. */
  conflicts: readonly string[]
  mpPlanIdFor(plan: BillingPlan, billingCycle: BillingCycle): string | null
  byMpPlanId(mpPlanId: unknown): PlanCatalogEntry | null
}

export function planEnvKey(plan: BillingPlan, billingCycle: BillingCycle): string {
  return `MP_PLAN_${plan.toUpperCase()}_${billingCycle.toUpperCase()}`
}

export function buildPlanCatalog(getEnv: (key: string) => string | undefined): PlanCatalog {
  const configured: PlanCatalogEntry[] = []
  for (const plan of BILLING_PLANS) {
    for (const billingCycle of BILLING_CYCLES) {
      const envKey = planEnvKey(plan, billingCycle)
      const mpPlanId = (getEnv(envKey) ?? '').trim()
      if (mpPlanId) configured.push({ plan, billingCycle, mpPlanId, envKey })
    }
  }

  // Un mismo id bajo dos secrets no permite saber qué plan se pagó. Fail-closed:
  // ese id deja de resolver en las dos direcciones.
  const seen = new Map<string, number>()
  for (const entry of configured) seen.set(entry.mpPlanId, (seen.get(entry.mpPlanId) ?? 0) + 1)
  const conflicts = [...seen].filter(([, count]) => count > 1).map(([id]) => id)
  const entries = configured.filter((entry) => !conflicts.includes(entry.mpPlanId))

  return {
    entries,
    conflicts,
    mpPlanIdFor(plan, billingCycle) {
      return entries.find((e) => e.plan === plan && e.billingCycle === billingCycle)?.mpPlanId ?? null
    },
    byMpPlanId(mpPlanId) {
      if (typeof mpPlanId !== 'string' || mpPlanId.trim() === '') return null
      return entries.find((e) => e.mpPlanId === mpPlanId.trim()) ?? null
    },
  }
}
