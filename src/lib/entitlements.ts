/**
 * entitlements.ts — Resolución CENTRALIZADA de entitlements (cliente).
 *
 * Única fuente de verdad del lado del cliente para decidir, a partir del
 * snapshot de suscripción del negocio, qué nivel de acceso y qué features
 * corresponden. `useSubscription` consume esto; los tests cubren los casos A–E.
 *
 * Reglas (deben coincidir con el RPC server-side `get_business_subscription_features`
 * y con `business_has_feature`, ambos basados en `subscription_status`):
 *   - El acceso y las features se derivan del estado + plan del negocio.
 *   - Un OVERRIDE permanente vigente (access_source manual/admin, sin vencer)
 *     "rescata" un estado bloqueado tratándolo como activo. Es fail-safe:
 *     sólo concede acceso cuando existe un override explícito en la fila del
 *     negocio (nunca por email ni por nombre). Hoy es un no-op porque todos los
 *     negocios con override ya están `active`; queda como defensa para que el
 *     dueño/grandfathered no se bloquee si el estado derivara en el futuro.
 *
 * Puro (sin Supabase/import.meta) → testeable con `node --test`.
 */

// Se importan desde módulos HOJA (con extensión .ts explícita) para que este
// archivo sea cargable bajo `node --test`. NO importar de '../types/subscription'
// (usa import.meta.env y rompería el runner de tests).
import {
  type SubscriptionStatus,
  type AccessSource,
  type AccessLevel,
  getAccessLevel,
  isAccessAllowed,
} from '../types/subscriptionAccess.ts'
import {
  type PlanId,
  type PlanFeature,
  type PlanFeatureSet,
  PLAN_FEATURES,
  TRIAL_FEATURES,
} from '../config/planFeatures.ts'

// Re-export para que los consumidores tengan un único punto de entrada.
export { getAccessLevel, isAccessAllowed }
export type { AccessLevel }

// Fuentes de acceso que representan una concesión manual/override (no un pago MP).
const OVERRIDE_SOURCES: ReadonlyArray<AccessSource> = ['manual_grandfathered', 'admin_override']

export interface EntitlementInput {
  subscription_status: SubscriptionStatus | null | undefined
  subscription_plan:   PlanId | null | undefined
  access_source?:      AccessSource | null
  override_expires_at?: string | null
}

export interface ResolvedEntitlement {
  /** Estado efectivo tras aplicar el override (lo que se usa para gating). */
  effectiveStatus:   SubscriptionStatus
  /** Estado crudo provisto (con default optimista 'trialing' si falta). */
  rawStatus:         SubscriptionStatus
  accessLevel:       AccessLevel
  isAllowed:         boolean
  currentPlan:       PlanId | null
  planFeatures:      PlanFeatureSet
  hasActiveOverride: boolean
  hasFeature:        (feature: PlanFeature) => boolean
}

/**
 * ¿Hay un override de acceso vigente? Sólo true cuando la fila del negocio
 * tiene un access_source manual/admin y el override no está vencido
 * (sin fecha = permanente).
 */
export function hasActiveOverride(
  accessSource: AccessSource | null | undefined,
  overrideExpiresAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!accessSource || !OVERRIDE_SOURCES.includes(accessSource)) return false
  if (overrideExpiresAt == null) return true // permanente
  const end = new Date(overrideExpiresAt).getTime()
  if (Number.isNaN(end)) return false        // fecha inválida → fail-safe: no override
  return end > now.getTime()
}

/**
 * Resuelve el entitlement efectivo del negocio. Reproduce el comportamiento
 * histórico de `useSubscription` (default optimista a 'trialing' cuando no hay
 * datos; trial → features Pro) y añade el rescate por override como defensa.
 */
export function resolveEntitlement(
  input: EntitlementInput,
  now: Date = new Date(),
): ResolvedEntitlement {
  // Default optimista: sin datos confirmados, no bloquear la app.
  const rawStatus: SubscriptionStatus = input.subscription_status ?? 'trialing'
  const currentPlan: PlanId | null = input.subscription_plan ?? null

  const overrideActive = hasActiveOverride(input.access_source, input.override_expires_at, now)

  // El override sólo "rescata" un estado que de otro modo estaría bloqueado,
  // y sólo si hay un plan concreto otorgado. Nunca degrada un estado válido.
  const effectiveStatus: SubscriptionStatus =
    overrideActive && currentPlan != null && getAccessLevel(rawStatus) === 'blocked'
      ? 'active'
      : rawStatus

  const accessLevel = getAccessLevel(effectiveStatus)
  const isAllowed   = isAccessAllowed(effectiveStatus)

  // Trial → features Pro. Sin plan y no-trial → fallback optimista a Pro
  // (idéntico al comportamiento previo de useSubscription).
  const planFeatures: PlanFeatureSet =
    effectiveStatus === 'trialing'
      ? TRIAL_FEATURES
      : currentPlan
        ? PLAN_FEATURES[currentPlan]
        : TRIAL_FEATURES

  const hasFeature = (feature: PlanFeature): boolean => {
    if (!isAllowed) return false
    return !!planFeatures[feature]
  }

  return {
    effectiveStatus,
    rawStatus,
    accessLevel,
    isAllowed,
    currentPlan,
    planFeatures,
    hasActiveOverride: overrideActive,
    hasFeature,
  }
}
