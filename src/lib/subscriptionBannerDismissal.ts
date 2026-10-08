/**
 * subscriptionBannerDismissal.ts — BETA-UX-1C · Cierre del aviso de suscripción.
 *
 * Cerrar un aviso lo oculta POR EL DÍA: no vuelve al navegar, al remontar ni al
 * recargar; al día siguiente, si la condición sigue, puede volver. No es un
 * «no mostrar más».
 *
 * La marca vive en `localStorage` bajo una clave por negocio + tipo de aviso +
 * fecha local. Un negocio no silencia el aviso de otro y un tipo no silencia a
 * otro. Sólo guarda un `1`: ni email, ni datos de pago, ni nada del negocio más
 * que su id (que ya está en la sesión). No es estado de billing: que el aviso
 * esté cerrado no dice nada sobre la suscripción.
 *
 * Si el navegador no deja usar `localStorage` (modo privado, cuota), el cierre
 * dura lo que la pantalla — el comportamiento que había antes.
 */

export type SubscriptionBannerKind = 'trial' | 'past_due' | 'period_ending'

/**
 * Qué avisos recuerdan el cierre durante el día. El de pago vencido NO: es el
 * único que habla de una deuda en curso y conserva su comportamiento anterior
 * (el cierre dura hasta recargar).
 */
export const DISMISSAL_PERSISTS_FOR_THE_DAY: Record<SubscriptionBannerKind, boolean> = {
  trial: true,
  period_ending: true,
  past_due: false,
}

const KEY_PREFIX = 'techrepair:subscription-banner:dismissed'

type DismissalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

/** Fecha LOCAL (`YYYY-MM-DD`): el «día» es el del usuario, no el de UTC. */
export function localDay(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

function scopePrefix(businessId: string, kind: SubscriptionBannerKind): string {
  return `${KEY_PREFIX}:${businessId}:${kind}:`
}

export function dismissalKey(businessId: string, kind: SubscriptionBannerKind, now: Date): string {
  return `${scopePrefix(businessId, kind)}${localDay(now)}`
}

/** `localStorage`, o `null` si el navegador no lo expone o lanza al tocarlo. */
export function browserDismissalStorage(): DismissalStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export function isDismissedToday(
  storage: DismissalStorage | null,
  businessId: string | null | undefined,
  kind: SubscriptionBannerKind,
  now: Date = new Date(),
): boolean {
  if (!storage || !businessId || !DISMISSAL_PERSISTS_FOR_THE_DAY[kind]) return false
  try {
    return storage.getItem(dismissalKey(businessId, kind, now)) === '1'
  } catch {
    return false
  }
}

/**
 * Marca el aviso como cerrado por hoy. Devuelve `false` si no quedó guardado
 * (el llamador conserva el cierre en memoria). De paso borra las marcas de días
 * anteriores del mismo negocio y tipo, para que no se acumulen.
 */
export function dismissForToday(
  storage: DismissalStorage | null,
  businessId: string | null | undefined,
  kind: SubscriptionBannerKind,
  now: Date = new Date(),
): boolean {
  if (!storage || !businessId || !DISMISSAL_PERSISTS_FOR_THE_DAY[kind]) return false
  const today = dismissalKey(businessId, kind, now)
  const prefix = scopePrefix(businessId, kind)
  try {
    const stale: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key && key.startsWith(prefix) && key !== today) stale.push(key)
    }
    for (const key of stale) storage.removeItem(key)
    storage.setItem(today, '1')
    return true
  } catch {
    return false
  }
}
