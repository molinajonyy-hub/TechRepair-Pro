// PRE-BETA-3A-2 — Autoridad CENTRAL de acceso a Mayorista (hook).
//
// Cablea el motor puro (`decideWholesaleAccess`) con las fuentes de verdad que
// ya existen: AuthContext (rol, acceso al negocio), usePermissions (capacidad
// `wholesale` efectiva) y useSubscription (feature `mayorista`). No consulta
// nada propio, así que lo pueden montar un formulario o un guard sin agregar
// un fetch.
//
// Lo consumen, sin recalcular la regla:
//   - guard de ruta `/mayorista`        (ProtectedRouteByWholesaleAccess)
//   - navegación                        (useWholesalePermissions → isNavigationItemAuthorized)
//   - página Mayorista                  (useWholesalePermissions)
//   - tipo de cliente en Customer Core  (useWholesaleCustomerGate)
//
// Fail-closed mientras no hay datos CONFIRMADOS. `useSubscription` resuelve sin
// datos como trial optimista, y el trial ahora TIENE Mayorista (Pro+): sin esta
// condición el gate se abriría durante la carga o ante un error de red para
// cualquier negocio, incluido un Básico.

import { useAuth } from '../contexts/AuthContext'
import { usePermissions } from './usePermissions'
import { useSubscription } from './useSubscription'
import {
  decideWholesaleAccess,
  canManageWholesale,
  isWholesaleReadOnly,
  type WholesaleAccessDecision,
  type WholesaleAccessInput,
} from '../lib/permissions/wholesalePermissions'

export interface WholesaleAccess {
  /** true mientras se resuelven sesión / perfil / suscripción. */
  loading: boolean
  /** Feature `mayorista` del negocio con datos de suscripción confirmados. */
  hasMayoristaFeature: boolean
  decision: WholesaleAccessDecision
  /** Acceso a Mayorista (módulo, navegación, ruta, tipo de cliente mayorista). */
  canAccess: boolean
  /** Con acceso y rol que escribe (owner/admin/manager/sales). */
  canManage: boolean
  /** Con acceso y rol de sólo lectura (tech/cashier/viewer). */
  isReadOnly: boolean
}

export function useWholesaleAccess(): WholesaleAccess {
  const { role, hasBusinessAccess, loading: authLoading, profileLoading } = useAuth()
  const { can } = usePermissions()
  const { hasFeature, subscription, loading: subLoading } = useSubscription()

  const loading = authLoading === true || profileLoading === true || subLoading === true
  const hasMayoristaFeature = !loading && subscription != null && hasFeature('mayorista')

  const input: WholesaleAccessInput = {
    role,
    hasMayoristaFeature,
    hasBusinessAccess: !loading && hasBusinessAccess === true,
    hasWholesaleCapability: can('wholesale'),
  }
  const decision = decideWholesaleAccess(input)

  return {
    loading,
    hasMayoristaFeature,
    decision,
    canAccess: decision === 'allowed',
    canManage: canManageWholesale(input),
    isReadOnly: isWholesaleReadOnly(input),
  }
}
