/**
 * subscriptionPresentation.ts — BETA-UX-1C · Qué muestra «Mi Suscripción» en cada estado.
 *
 * SÓLO PRESENTACIÓN. No decide acceso (eso es `lib/entitlements.ts`), no decide
 * el muro (eso es `lib/subscriptionWall.ts`) y no cambia ningún estado: recibe
 * señales que el frontend YA tiene y devuelve qué estado mostrar y qué acciones
 * ofrecer. La pantalla dibuja lo que sale de acá en vez de combinar flags a mano.
 *
 * Señales, todas escritas por el servidor:
 *   · estado EFECTIVO de la suscripción (el de `resolveEntitlement`);
 *   · `access_source`      — quién otorgó el acceso vigente;
 *   · `mp_preapproval_id`  — hay una suscripción de Mercado Pago vinculada al
 *     negocio. Es lo que exigen `cancel` y `update_payment_method` en la Edge
 *     Function: sin él responden `no_subscription`;
 *   · `checkout`           — la última intención de compra, leída con la acción
 *     `status` de `mp-subscription`. Nunca una URL ni algo guardado en el navegador.
 *
 * `trial_pending_checkout` NO es un estado de la base: el negocio sigue
 * `trialing`. Es «trial» + «el servidor tiene un checkout abierto». Si esa
 * lectura falla o no se hizo, `checkout` es `null` y el estado es `trial`.
 *
 * Prioridad (el orden importa):
 *   0. bloqueada (suspendida / cancelada / pendiente de activación) → la pantalla
 *      conserva lo que certificó BETA-1; el muro sigue siendo su autoridad;
 *   1. acceso manual — ANTES que «activa», porque un acceso otorgado por un admin
 *      también resuelve `active`;
 *   2. trial + checkout pendiente;
 *   3. trial;
 *   4. activa por Mercado Pago;
 *   5. pago vencido;
 *   6. activa sin Mercado Pago ni concesión manual.
 *
 * Puro (sin Supabase/import.meta) → testeable sin navegador, igual que
 * `lib/entitlements.ts` y `lib/subscriptionWall.ts`.
 */
import type { SubscriptionStatus, AccessSource } from '../types/subscriptionAccess.ts'
import { classifySubscriptionWall, type SubscriptionWallKind } from './subscriptionWall.ts'

export type SubscriptionPresentationState =
  | 'manual_access'
  | 'trial_pending_checkout'
  | 'trial'
  | 'mp_active'
  | 'past_due'
  /** Activa, sin suscripción de Mercado Pago vinculada y sin concesión manual. */
  | 'active_unlinked'
  /** Suspendida, cancelada o pendiente de activación: manda el muro de BETA-1. */
  | 'blocked'

export type SubscriptionActionId =
  | 'choose_plan'
  | 'reactivate'
  | 'continue_checkout'
  | 'verify_payment'
  | 'change_plan'
  | 'update_payment_method'
  | 'cancel_subscription'
  | 'help'

/** Las acciones que terminan en la Edge Function `mp-subscription`. */
export const MERCADO_PAGO_ACTIONS: readonly SubscriptionActionId[] = [
  'continue_checkout', 'verify_payment', 'update_payment_method', 'cancel_subscription',
]

/** Las que llevan a Planes (y de ahí al checkout). */
export const PLAN_ACTIONS: readonly SubscriptionActionId[] = ['choose_plan', 'reactivate', 'change_plan']

/** Lo mínimo del checkout que hace falta: lo que devuelve la acción `status`. */
export interface PresentationCheckout {
  status: string
}

export interface SubscriptionPresentationInput {
  /** Estado EFECTIVO: el que devuelve `resolveEntitlement`, no la columna cruda. */
  status: SubscriptionStatus
  accessSource?: AccessSource | null
  mpPreapprovalId?: string | null
  lastPaymentStatus?: string | null
  trialEndsAt?: string | null
  currentPeriodEnd?: string | null
  overrideExpiresAt?: string | null
  /** Último checkout según el servidor; `null` si no hay, no se consultó o falló. */
  checkout?: PresentationCheckout | null
}

export interface SubscriptionPresentation {
  state: SubscriptionPresentationState
  /** Tipo de muro cuando `state === 'blocked'`; `none` en cualquier otro caso. */
  wall: SubscriptionWallKind
  /** La acción que resuelve el estado. Una sola, o ninguna si no hay nada que resolver. */
  primary: SubscriptionActionId | null
  /** Acciones de apoyo junto al estado, en orden. Nunca compiten con la primaria. */
  secondary: SubscriptionActionId[]
  /** Administración de una suscripción que ya existe («Administrar suscripción»). */
  manage: SubscriptionActionId[]
  /** Acciones que no deben tocarse por accidente (hoy sólo cancelar). */
  destructive: SubscriptionActionId[]
  /** Hay un cobro futuro que anunciar: suscripción de MP activa con fecha. */
  showNextCharge: boolean
  /**
   * Cómo se presenta el precio del catálogo:
   *   `current`      lo que se está cobrando;
   *   `after_trial`  lo que costará al terminar la prueba (hoy no se cobra nada);
   *   `hidden`       no hay ningún cobro que mostrar.
   */
  price: 'current' | 'after_trial' | 'hidden'
  /** Email del pagador y período de facturación: sólo con una suscripción que cobra. */
  showBillingDetails: boolean
  /** Fecha en la que vence un acceso manual; `null` si no vence o no aplica. */
  manualAccessExpiresAt: string | null
}

const MANUAL_SOURCES: ReadonlyArray<AccessSource> = ['admin_override', 'manual_grandfathered']
const BLOCKED: ReadonlyArray<SubscriptionStatus> = ['suspended', 'canceled', 'pending_activation']

/** El acceso vigente lo otorgó TechRepair Pro a mano, no un pago ni la prueba. */
export function isManualAccess(accessSource: AccessSource | null | undefined): boolean {
  return accessSource != null && MANUAL_SOURCES.includes(accessSource)
}

/** Hay una suscripción de Mercado Pago vinculada al negocio. */
export function hasMercadoPagoSubscription(mpPreapprovalId: string | null | undefined): boolean {
  return typeof mpPreapprovalId === 'string' && mpPreapprovalId.trim() !== ''
}

/**
 * ¿Vale la pena preguntarle al servidor por un checkout abierto? Sólo durante un
 * trial que no sea un acceso manual: es el único estado cuya presentación cambia
 * con la respuesta. Evita una llamada por cada visita en el resto de los casos.
 */
export function shouldLookUpPendingCheckout(
  input: Pick<SubscriptionPresentationInput, 'status' | 'accessSource'>,
): boolean {
  return input.status === 'trialing' && !isManualAccess(input.accessSource)
}

export function resolveSubscriptionPresentation(
  input: SubscriptionPresentationInput,
  now: Date = new Date(),
): SubscriptionPresentation {
  const base = {
    wall: 'none' as SubscriptionWallKind,
    primary: null as SubscriptionActionId | null,
    secondary: [] as SubscriptionActionId[],
    manage: [] as SubscriptionActionId[],
    destructive: [] as SubscriptionActionId[],
    showNextCharge: false,
    price: 'hidden' as SubscriptionPresentation['price'],
    showBillingDetails: false,
    manualAccessExpiresAt: null as string | null,
  }
  const linked = hasMercadoPagoSubscription(input.mpPreapprovalId)

  // 0. Bloqueada: lo que ya hacía la pantalla. El tipo de muro lo decide
  //    `classifySubscriptionWall`, no una regla nueva.
  if (BLOCKED.includes(input.status)) {
    const wall = classifySubscriptionWall({
      subscription_status: input.status,
      access_source: input.accessSource,
      mp_preapproval_id: input.mpPreapprovalId,
      last_payment_status: input.lastPaymentStatus,
      trial_ends_at: input.trialEndsAt,
    }, now)
    // Quien nunca tuvo un plan no «reactiva»: elige uno.
    const primary: SubscriptionActionId | null =
      input.status === 'pending_activation' ? null : wall === 'trial_ended' ? 'choose_plan' : 'reactivate'
    return { ...base, state: 'blocked', wall, primary }
  }

  // 1. Acceso manual. Decisión del owner para BETA-UX-1C: ninguna acción de
  //    billing, para que un checkout no reemplace por accidente lo que otorgó
  //    TechRepair Pro. La única salida es Ayuda.
  if (isManualAccess(input.accessSource)) {
    return {
      ...base,
      state: 'manual_access',
      secondary: ['help'],
      manualAccessExpiresAt: input.overrideExpiresAt ?? null,
    }
  }

  if (input.status === 'trialing') {
    // 2. Trial con un pago iniciado: el servidor tiene un checkout `pending`.
    if (input.checkout?.status === 'pending') {
      return {
        ...base,
        state: 'trial_pending_checkout',
        primary: 'continue_checkout',
        secondary: ['verify_payment'],
        price: 'after_trial',
      }
    }
    // 3. Trial. No hay ninguna suscripción de Mercado Pago que verificar,
    //    actualizar o cancelar.
    return { ...base, state: 'trial', primary: 'choose_plan', price: 'after_trial' }
  }

  if (input.status === 'past_due') {
    // 5. Pago vencido: lo que lo resuelve es el medio de pago. Sin una
    //    suscripción vinculada no hay medio que actualizar ni nada que cancelar.
    return linked
      ? {
          ...base,
          state: 'past_due',
          primary: 'update_payment_method',
          secondary: ['verify_payment', 'change_plan'],
          destructive: ['cancel_subscription'],
          price: 'current',
          showBillingDetails: true,
        }
      : { ...base, state: 'past_due', primary: 'choose_plan' }
  }

  // 4. Activa por Mercado Pago. No hay nada que resolver: ninguna acción es
  //    primaria, y «Verificar pago» queda entre las de administración.
  if (linked) {
    return {
      ...base,
      state: 'mp_active',
      secondary: ['change_plan'],
      manage: ['update_payment_method', 'verify_payment'],
      destructive: ['cancel_subscription'],
      showNextCharge: typeof input.currentPeriodEnd === 'string' && input.currentPeriodEnd !== '',
      price: 'current',
      showBillingDetails: true,
    }
  }

  // 6. Activa sin suscripción de Mercado Pago ni concesión manual: puede elegir
  //    un plan, pero no hay nada de Mercado Pago que administrar ni un cobro
  //    que mostrar.
  return { ...base, state: 'active_unlinked', secondary: ['change_plan'] }
}

/** Todas las acciones que el estado ofrece, sin importar dónde se dibujen. */
export function presentationActions(presentation: SubscriptionPresentation): SubscriptionActionId[] {
  return [
    ...(presentation.primary ? [presentation.primary] : []),
    ...presentation.secondary,
    ...presentation.manage,
    ...presentation.destructive,
  ]
}

export function offersAction(presentation: SubscriptionPresentation, action: SubscriptionActionId): boolean {
  return presentationActions(presentation).includes(action)
}

/** ¿El estado ofrece ir a Planes? Un acceso manual nunca. */
export function offersPlans(presentation: SubscriptionPresentation): boolean {
  return presentation.state !== 'manual_access'
}
