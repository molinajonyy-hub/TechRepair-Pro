// ──────────────────────────────────────────────────────────────────────────────
// Motor PURO de permisos de interfaz para Mayorista y Portal Clic.
//
// Refleja, del lado del frontend, las policies RLS aplicadas en producción (Caso E):
//   - clic_wholesale_product_settings: administrable solo por el owner REAL del
//     negocio (owner_user_id = auth.uid()) con wholesale_portal_enabled = true.
//   - wholesale_customers / orders / order_items: escritura para
//     owner/admin/manager/sales (can_manage_wholesale); lectura para los 7 roles;
//     siempre con la feature `mayorista` activa.
//
// Sin fetching, sin React, sin email/slug/nombre "Clic"/UUID hardcodeado, sin usar
// el plan Full ni `can_manage` genérico como sustituto de autorización.
// Fuente única y testeable de los permisos de UI mayoristas.
// ──────────────────────────────────────────────────────────────────────────────

export type BusinessRole =
  | 'owner'
  | 'admin'
  | 'manager'
  | 'sales'
  | 'tech'
  | 'cashier'
  | 'viewer'

/** Los 7 roles internos del negocio. */
export const WHOLESALE_ROLES: readonly BusinessRole[] = [
  'owner', 'admin', 'manager', 'sales', 'tech', 'cashier', 'viewer',
] as const

/** Roles que pueden ESCRIBIR mayorista (espeja can_manage_wholesale() en RLS). */
export const WHOLESALE_MANAGE_ROLES: readonly BusinessRole[] = [
  'owner', 'admin', 'manager', 'sales',
] as const

/** Roles que solo pueden LEER mayorista. */
export const WHOLESALE_READONLY_ROLES: readonly BusinessRole[] = [
  'tech', 'cashier', 'viewer',
] as const

/** Type guard fail-closed: un rol nulo/desconocido NO es un BusinessRole. */
export function isBusinessRole(role: unknown): role is BusinessRole {
  return typeof role === 'string' && (WHOLESALE_ROLES as readonly string[]).includes(role)
}

export interface WholesaleViewInput {
  /** Rol del usuario en el negocio (de AuthContext). */
  role: string | null | undefined
  /** El negocio tiene la feature `mayorista` activa. */
  hasMayoristaFeature: boolean
  /** El usuario tiene acceso válido y activo al negocio. */
  hasBusinessAccess: boolean
}

export interface WholesaleManageInput {
  role: string | null | undefined
  hasMayoristaFeature: boolean
  /** El usuario tiene acceso válido y activo al negocio. */
  hasBusinessAccess: boolean
}

export interface ClicPortalInput {
  /** El usuario es el owner REAL del negocio actual (user.id === business.owner_user_id). */
  isBusinessOwner: boolean
  /** wholesale_portal_enabled del negocio actual. */
  wholesalePortalEnabled: boolean
}

/**
 * ¿Puede VER el módulo Mayorista?
 * true cuando: feature `mayorista` activa + acceso válido al negocio + rol ∈ los 7.
 */
export function canViewWholesale(input: WholesaleViewInput): boolean {
  return (
    input.hasMayoristaFeature === true &&
    input.hasBusinessAccess === true &&
    isBusinessRole(input.role)
  )
}

/**
 * ¿Puede GESTIONAR (escribir) Mayorista?
 * true únicamente para owner/admin/manager/sales y solo con la feature activa.
 */
export function canManageWholesale(input: WholesaleManageInput): boolean {
  return (
    input.hasBusinessAccess === true &&
    input.hasMayoristaFeature === true &&
    isBusinessRole(input.role) &&
    (WHOLESALE_MANAGE_ROLES as readonly string[]).includes(input.role)
  )
}

/**
 * ¿Está en modo SOLO LECTURA de Mayorista?
 * true para tech/cashier/viewer con feature activa (ven pero no modifican).
 */
export function isWholesaleReadOnly(input: WholesaleManageInput): boolean {
  return (
    input.hasBusinessAccess === true &&
    input.hasMayoristaFeature === true &&
    isBusinessRole(input.role) &&
    (WHOLESALE_READONLY_ROLES as readonly string[]).includes(input.role)
  )
}

/**
 * ¿Puede ADMINISTRAR la configuración privada de Portal Clic?
 * true únicamente cuando es el owner REAL del negocio actual y el portal está habilitado.
 */
export function canManageClicPortal(input: ClicPortalInput): boolean {
  return input.isBusinessOwner === true && input.wholesalePortalEnabled === true
}
