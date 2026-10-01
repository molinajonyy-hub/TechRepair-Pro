/**
 * subscriptionWall.ts — BETA-1 · Clasificación PURA del bloqueo por suscripción.
 *
 * En la base hay un solo estado para dos historias distintas:
 *
 *   trialing ──expire_trials()──────────────▶ suspended   (nunca pagó nada)
 *   active ─▶ past_due ──enforce_grace()───▶ suspended   (dejó de pagar)
 *
 * La pantalla no puede decirle «falta de pago» al primero. Este módulo los
 * separa con datos que el frontend YA carga (`getSubscription`), sin tocar
 * `expire_trials()`, el cron ni los estados de la DB.
 *
 * Qué prueba que existe una suscripción paga — cualquiera de las tres:
 *   · `mp_preapproval_id`      hay un preapproval de Mercado Pago;
 *   · `access_source`          el acceso vigente salió de un pago MP verificado;
 *   · `last_payment_status`    el webhook procesó al menos un cobro.
 * Las tres las escribe sólo el webhook / la Edge Function, nunca el trial ni
 * las RPC de SaaS Admin. Si no hay ninguna, no hubo billing: no se habla de pagos.
 *
 * La salida sigue siendo la de siempre —Planes, y de ahí el checkout de Mercado
 * Pago— para todo muro que un plan resuelve. La excepción es `suspended_other`:
 * pagar no levanta esa suspensión, así que su CTA es Ayuda.
 *
 * Puro (sin Supabase/import.meta) → testeable con `node --test`, igual que
 * `lib/entitlements.ts`.
 */
import type { SubscriptionStatus, AccessSource } from '../types/subscriptionAccess.ts'

/** Lo mínimo de `BusinessSubscription` que hace falta para clasificar. */
export interface BillingSnapshot {
  subscription_status?: SubscriptionStatus | null
  access_source?:       AccessSource | null
  mp_preapproval_id?:   string | null
  last_payment_status?: string | null
  trial_ends_at?:       string | null
}

export type SubscriptionWallKind =
  /** No hay muro: trial vigente, activa, pago vencido en gracia, o sin datos. */
  | 'none'
  /** Suspendida, sin suscripción paga y con el trial vencido. */
  | 'trial_ended'
  /** Suspendida con una suscripción paga detrás: falta de pago real. */
  | 'billing_suspended'
  /** Suspendida sin billing y sin trial vencido (p. ej. suspensión administrativa). */
  | 'suspended_other'
  | 'canceled'

/** ¿Existe (o existió) una suscripción paga de Mercado Pago para este negocio? */
export function hasPaidSubscription(snapshot: BillingSnapshot | null | undefined): boolean {
  if (!snapshot) return false
  if (typeof snapshot.mp_preapproval_id === 'string' && snapshot.mp_preapproval_id.trim() !== '') return true
  if (snapshot.access_source === 'mercado_pago') return true
  return snapshot.last_payment_status != null && snapshot.last_payment_status !== ''
}

function trialHasEnded(trialEndsAt: string | null | undefined, now: Date): boolean {
  if (!trialEndsAt) return false
  const end = new Date(trialEndsAt).getTime()
  if (Number.isNaN(end)) return false
  return end <= now.getTime()
}

/**
 * Clasifica el bloqueo. `subscription_status` es el estado EFECTIVO (el que
 * devuelve `resolveEntitlement`, ya con el rescate por override aplicado).
 */
export function classifySubscriptionWall(
  snapshot: BillingSnapshot | null | undefined,
  now: Date = new Date(),
): SubscriptionWallKind {
  const status = snapshot?.subscription_status
  if (status === 'canceled') return 'canceled'
  if (status !== 'suspended') return 'none'
  if (hasPaidSubscription(snapshot)) return 'billing_suspended'
  return trialHasEnded(snapshot?.trial_ends_at, now) ? 'trial_ended' : 'suspended_other'
}

// ─── Presentación del muro ────────────────────────────────────────────────────

export interface SubscriptionWallView {
  title:       string
  description: string
  badge:       string
  /** `info` = terminó la prueba · `danger` = billing · `neutral` = el resto. */
  tone:        'info' | 'danger' | 'neutral'
  /**
   * A dónde lleva el CTA primario. `plans` cuando elegir un plan resuelve el
   * bloqueo; `help` cuando no (una suspensión que no es de trial ni de billing
   * no se levanta pagando).
   */
  primary:      'plans' | 'help'
  primaryLabel: string
}

const DATOS_PROTEGIDOS = 'Tus datos siguen guardados y protegidos.'

/** Copy y CTA primario por tipo de muro. */
export function describeSubscriptionWall(
  kind: Exclude<SubscriptionWallKind, 'none'>,
): SubscriptionWallView {
  switch (kind) {
    case 'trial_ended':
      return {
        title: 'Tu período de prueba terminó',
        description: `${DATOS_PROTEGIDOS} Elegí un plan para seguir usando TechRepair Pro.`,
        badge: 'Prueba finalizada',
        tone: 'info',
        primary: 'plans',
        primaryLabel: 'Ver planes',
      }
    case 'billing_suspended':
      return {
        title: 'Cuenta suspendida',
        description: 'Tu suscripción fue suspendida por falta de pago. Para restaurar el acceso, actualizá tu método de pago o elegí un nuevo plan.',
        badge: 'Suspendida',
        tone: 'danger',
        primary: 'plans',
        primaryLabel: 'Ver planes y reactivar',
      }
    case 'canceled':
      return {
        title: 'Suscripción cancelada',
        description: 'Tu suscripción fue cancelada. Para volver a usar TechRepair Pro, reactivá tu plan.',
        badge: 'Cancelada',
        tone: 'neutral',
        primary: 'plans',
        primaryLabel: 'Reactivar mi cuenta',
      }
    case 'suspended_other':
      return {
        title: 'Cuenta suspendida',
        description: `El acceso de este negocio está suspendido. ${DATOS_PROTEGIDOS} Escribinos y lo revisamos.`,
        badge: 'Suspendida',
        tone: 'neutral',
        primary: 'help',
        primaryLabel: 'Contactar soporte',
      }
  }
}
