/**
 * ARCA Phase 0 — autoridad canónica de GESTIÓN ARCA para Edge Functions.
 *
 * Gestión = preparar/activar/finalizar/revertir credenciales o configurar la
 * integración. NO es emisión (afip-cae, capability `comprobantes`) ni la prueba
 * de conexión de afip-wsaa, que conservan su contrato.
 *
 * Contrato (el mismo que private.arca_actor_can_manage en SQL):
 *   perfil ACTIVO  AND  rol IN ('owner','admin')  AND  settings_sensitive = true
 *
 * Reutiliza authorizeArcaCaller (identidad por JWT, perfil por get_my_profile,
 * capacidad por current_user_can) y le suma el rol sobre ESE MISMO perfil. Sólo
 * acepta usuarios: una credencial de servidor no es un actor de gestión.
 *
 * El tenant sale SIEMPRE de la identidad. Un business_id del body sólo puede
 * confirmar ese tenant; si difiere, 403. Nunca lo elige.
 */
import {
  ArcaAuthorizationError,
  authorizeArcaCaller,
  type ArcaUserClient,
} from './arcaAuthorization.ts'

export const ARCA_MANAGER_ROLES: readonly string[] = ['owner', 'admin']

export interface ArcaManager {
  userId: string
  businessId: string
}

export async function authorizeArcaManager(
  authorization: string | null,
  options: { createUserClient: (authorization: string) => ArcaUserClient },
): Promise<ArcaManager> {
  const caller = await authorizeArcaCaller(authorization, {
    capability: 'settings_sensitive',
    roles: ARCA_MANAGER_ROLES,
    createUserClient: options.createUserClient,
  })
  if (caller.kind !== 'user') throw new ArcaAuthorizationError(403, 'FORBIDDEN')
  return { userId: caller.userId, businessId: caller.businessId }
}

/**
 * Valida un business_id opcional del body contra el tenant resuelto. Ausente o
 * vacío → se usa el tenant. Presente y distinto (o no-string) → 403.
 */
export function resolveManagedBusiness(requested: unknown, manager: ArcaManager): string {
  if (requested === undefined || requested === null || requested === '') return manager.businessId
  if (typeof requested !== 'string'
    || requested.trim().toLowerCase() !== manager.businessId.toLowerCase()) {
    throw new ArcaAuthorizationError(403, 'FORBIDDEN')
  }
  return manager.businessId
}
