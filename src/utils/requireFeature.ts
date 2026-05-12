/**
 * requireFeature.ts — Validación server-side de features por plan.
 *
 * Llamar ANTES de ejecutar cualquier acción premium en un service.
 * Si el negocio no tiene la feature en su plan activo, lanza FeatureError.
 */

import { supabase } from '../lib/supabase'
import { type PlanFeature, FEATURE_REQUIRED_PLAN, PLAN_DISPLAY } from '../config/planFeatures'

// ─── Error tipado ─────────────────────────────────────────────────────────────

export type FeatureErrorCode =
  | 'FEATURE_NOT_AVAILABLE'
  | 'SUBSCRIPTION_INACTIVE'
  | 'UPGRADE_REQUIRED'

export class FeatureError extends Error {
  readonly code:    FeatureErrorCode
  readonly feature: string

  constructor(code: FeatureErrorCode, message: string, feature: string) {
    super(message)
    this.name    = 'FeatureError'
    this.code    = code
    this.feature = feature
  }
}

export function isFeatureError(e: unknown): e is FeatureError {
  return e instanceof FeatureError
}

// ─── Helper principal ─────────────────────────────────────────────────────────

/**
 * Valida via DB que el negocio tiene la feature solicitada.
 * Lanza FeatureError si no tiene acceso.
 *
 * @example
 *   await requireFeature(businessId, 'arca')
 *   // → continúa si Pro/Full/Trial, lanza si Básico o suspendido
 */
export async function requireFeature(
  businessId: string,
  feature:    PlanFeature,
  action?:    string,
): Promise<void> {
  const { data, error } = await supabase
    .rpc('get_business_subscription_features', { p_business_id: businessId })

  if (error || !data) {
    // Error de red: permitir optimísticamente (no bloquear por fallo de red)
    console.warn('[requireFeature] RPC error:', error?.message)
    return
  }

  const status = data.status as string

  if (status === 'suspended' || status === 'canceled') {
    void logBlockedAttempt(businessId, feature, action, data.plan_id)
    throw new FeatureError(
      'SUBSCRIPTION_INACTIVE',
      'Tu suscripción no está activa. Renovála para continuar.',
      feature,
    )
  }

  if (!data[feature]) {
    void logBlockedAttempt(businessId, feature, action, data.plan_id)

    const reqPlan = FEATURE_REQUIRED_PLAN[feature]
    const label   = PLAN_DISPLAY[reqPlan]?.label ?? reqPlan
    throw new FeatureError(
      'UPGRADE_REQUIRED',
      `Esta función requiere el Plan ${label}. Actualizá tu suscripción para usarla.`,
      feature,
    )
  }
}

// ─── Log de intentos bloqueados (fire-and-forget) ────────────────────────────

async function logBlockedAttempt(
  businessId:  string,
  feature:     string,
  action?:     string,
  currentPlan?: string,
) {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    await supabase.from('blocked_feature_attempts').insert({
      business_id:  businessId,
      user_id:      session?.user?.id ?? null,
      feature,
      action:       action ?? null,
      current_plan: currentPlan ?? null,
    })
  } catch { /* fire-and-forget: ignorar errores de log */ }
}

// ─── Helper para mostrar mensaje amigable desde un catch ─────────────────────

export function getFeatureErrorMessage(e: unknown): string {
  if (isFeatureError(e)) return e.message
  return 'Ocurrió un error inesperado. Intentá de nuevo.'
}
