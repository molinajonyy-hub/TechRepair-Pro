/**
 * subscriptionAccess.ts — Tipos + helpers de ACCESO por estado de suscripción.
 *
 * Módulo HOJA puro (sin imports relativos ni import.meta) → cargable bajo
 * `node --test`. Es el hogar canónico de:
 *   - SubscriptionStatus, AccessSource, AccessLevel
 *   - getAccessLevel / isAccessAllowed
 *
 * `types/subscription.ts` los re-exporta para no romper imports existentes;
 * `lib/entitlements.ts` los consume para la resolución centralizada.
 */

// ─── Status types ─────────────────────────────────────────────────────────────
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'canceled'
  | 'pending_activation'

// Cómo obtuvo el negocio su acceso actual. Distingue un pago MP verificado de
// concesiones manuales/grandfathered/override (nunca se deben confundir).
export type AccessSource =
  | 'mercado_pago'
  | 'trial'
  | 'manual_grandfathered'
  | 'admin_override'

// ─── Access level derived from status ─────────────────────────────────────────
export type AccessLevel = 'full' | 'limited' | 'blocked'

export function getAccessLevel(status: SubscriptionStatus): AccessLevel {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'full'
    case 'past_due':
      return 'limited'
    case 'suspended':
    case 'canceled':
    case 'pending_activation':
      return 'blocked'
    default:
      return 'blocked'
  }
}

export function isAccessAllowed(status: SubscriptionStatus): boolean {
  return getAccessLevel(status) !== 'blocked'
}
