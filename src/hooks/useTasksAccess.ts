/**
 * useTasksAccess — ¿este actor tiene el módulo de Tareas?
 *
 * La regla NO se define acá: es el contrato de la ruta `/tasks` (`App.tsx`),
 * del Sidebar y de la navegación móvil — capacidad `orders` + feature de plan
 * `tasks`. Tareas todavía no tiene una capacidad propia y este hook no la
 * inventa. Existe para que una superficie que está fuera de la navegación (hoy,
 * el bloque de Inicio) tome la MISMA decisión sin montar `useNavigationAccess`,
 * que lee además datos que acá no hacen falta.
 *
 * No consulta nada propio: la capacidad efectiva sale de `usePermissions` y el
 * plan de `useSubscription`, con su caché.
 *
 * Una diferencia deliberada con el guard de la ruta: mientras la suscripción se
 * está leyendo, la ruta deja pasar (`useSubscription` resuelve sin datos como
 * un trial optimista) y acá se espera. El bloque de Inicio pide `tasks` apenas
 * se monta: abrirlo a ciegas sería pedirle tareas al servidor para un negocio
 * cuyo plan no las incluye. Con el plan confirmado la decisión es la de la ruta.
 */
import type { NavigationGate } from './useNavigationAccess'
import { usePermissions } from './usePermissions'
import { useSubscription } from './useSubscription'

/** El gate de `/tasks`, con las mismas claves que su item de navegación. */
export const TASKS_ACCESS_GATE = {
  permission: 'orders',
  planFeature: 'tasks',
} as const satisfies NavigationGate

export interface UseTasksAccessReturn {
  /** true mientras se resuelve el plan del negocio. */
  loading: boolean
  /** Capacidad y plan, con los datos de la suscripción confirmados. */
  canAccessTasks: boolean
}

export function useTasksAccess(): UseTasksAccessReturn {
  const { can } = usePermissions()
  const { hasFeature, subscription, loading } = useSubscription()
  const planConfirmed = !loading && subscription != null

  return {
    loading,
    canAccessTasks:
      planConfirmed
      && can(TASKS_ACCESS_GATE.permission)
      && hasFeature(TASKS_ACCESS_GATE.planFeature),
  }
}
