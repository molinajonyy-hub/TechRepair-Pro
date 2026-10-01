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

/** Meses entre cobros de cada ciclo. Se contrasta con la frecuencia del plan en MP. */
export const CYCLE_MONTHS: Record<BillingCycle, number> = { monthly: 1, quarterly: 3, annual: 12 }

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
