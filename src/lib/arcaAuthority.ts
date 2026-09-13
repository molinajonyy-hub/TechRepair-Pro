/**
 * ARCA Phase 0 — espejo de UI de la autoridad canónica de gestión ARCA.
 *
 * La autoridad real vive en el servidor (private.arca_actor_can_manage y
 * _shared/arcaManagementAuthority.ts). Esto solo decide qué se MUESTRA:
 *
 *   perfil activo  AND  rol owner/admin  AND  settings_sensitive
 *
 * Módulo puro (sin React ni Supabase) para poder testearlo bajo `node --test`.
 */

export const ARCA_MANAGER_ROLES = ['owner', 'admin'] as const

export interface ArcaActor {
  role: string | null | undefined
  isActive: boolean | null | undefined
  /** Resultado de `usePermissions().can('settings_sensitive')`. */
  settingsSensitive: boolean
}

export function canManageArca(actor: ArcaActor): boolean {
  if (actor.isActive !== true) return false
  if (!actor.role || !(ARCA_MANAGER_ROLES as readonly string[]).includes(actor.role)) return false
  return actor.settingsSensitive === true
}

/** Flags de presencia del contrato seguro get_arca_config_safe. */
export interface ArcaIdentityFlags {
  has_certificate?: boolean
  has_private_key_configured?: boolean
}

/**
 * Con certificado o credencial vigente, CUIT/alias/ambiente quedan bloqueados en
 * el servidor (ARCA_FIELD_LOCKED). La UI los muestra de solo lectura.
 */
export function isArcaIdentityLocked(flags: ArcaIdentityFlags | null | undefined): boolean {
  return flags?.has_certificate === true || flags?.has_private_key_configured === true
}
