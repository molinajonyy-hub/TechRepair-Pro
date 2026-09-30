// ──────────────────────────────────────────────────────────────────────────────
// Motor PURO de permisos de interfaz para Mayorista y Portal Clic.
//
// PRE-BETA-3A-2 — AUTORIDAD CANÓNICA de acceso a Mayorista (contrato de producto):
//
//   feature `mayorista` del negocio (Pro+, trial incluido)
//   Y acceso válido al negocio
//   Y ( rol owner | rol admin | capacidad `wholesale` EFECTIVA del actor )
//
// owner/admin entran SIEMPRE: no dependen de `can('wholesale')`, así que un
// override `wholesale: false` no los deja afuera. El resto de los roles entra
// sólo con la capacidad (ninguno la trae por defecto). Navegación, guard de ruta,
// página Mayorista y alta de clientes (Customer Core) consumen ESTA decisión vía
// `useWholesaleAccess`; ninguno la recalcula.
//
// Dentro de quien tiene acceso, escribir vs. leer sigue el rol, igual que la RLS
// vigente (Caso E): owner/admin/manager/sales escriben (can_manage_wholesale),
// tech/cashier/viewer leen.
//
// Portal Clic (clic_wholesale_product_settings) NO es Mayorista: lo administra el
// owner REAL del negocio (owner_user_id = auth.uid()) con
// wholesale_portal_enabled = true. No se concede por plan, rol ni `wholesale`.
//
// Es autoridad de UI. El servidor todavía NO aplica este contrato completo
// (ver PRE-BETA-3A-2S): `current_user_can('wholesale')` respeta overrides de admin
// y da la capacidad por defecto a manager/sales, y `business_has_feature` sigue
// resolviendo `mayorista` como Full-only.
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

/**
 * Roles con acceso AUTOMÁTICO a Mayorista: no dependen de la capacidad
 * `wholesale` ni de sus overrides. Único lugar del frontend que lo decide.
 */
export const WHOLESALE_AUTOMATIC_ROLES: readonly BusinessRole[] = [
  'owner', 'admin',
] as const

/** Type guard fail-closed: un rol nulo/desconocido NO es un BusinessRole. */
export function isBusinessRole(role: unknown): role is BusinessRole {
  return typeof role === 'string' && (WHOLESALE_ROLES as readonly string[]).includes(role)
}

/** ¿El rol entra a Mayorista sin depender de la capacidad `wholesale`? */
export function hasAutomaticWholesaleAccess(role: unknown): boolean {
  return isBusinessRole(role) && (WHOLESALE_AUTOMATIC_ROLES as readonly string[]).includes(role)
}

export interface WholesaleAccessInput {
  /** Rol del usuario en el negocio (de AuthContext). */
  role: string | null | undefined
  /** El negocio tiene la feature `mayorista` activa (dato de suscripción confirmado). */
  hasMayoristaFeature: boolean
  /** El usuario tiene acceso válido y activo al negocio. */
  hasBusinessAccess: boolean
  /** Capacidad `wholesale` EFECTIVA del actor (defaults del rol + overrides). */
  hasWholesaleCapability: boolean
}

/**
 * Decisión de acceso con su motivo, para que guard y página muestren lo mismo:
 *  - `allowed`       → entra.
 *  - `actor_denied`  → el actor no tiene acceso (sin rol válido, sin acceso al
 *                      negocio o sin la capacidad). No se le ofrece un upgrade
 *                      que no puede comprar.
 *  - `plan_required` → el actor podría entrar, pero el negocio no tiene la feature.
 */
export type WholesaleAccessDecision = 'allowed' | 'actor_denied' | 'plan_required'

export function decideWholesaleAccess(input: WholesaleAccessInput): WholesaleAccessDecision {
  if (input.hasBusinessAccess !== true || !isBusinessRole(input.role)) return 'actor_denied'
  if (!hasAutomaticWholesaleAccess(input.role) && input.hasWholesaleCapability !== true) {
    return 'actor_denied'
  }
  if (input.hasMayoristaFeature !== true) return 'plan_required'
  return 'allowed'
}

export interface ClicPortalInput {
  /** El usuario es el owner REAL del negocio actual (user.id === business.owner_user_id). */
  isBusinessOwner: boolean
  /** wholesale_portal_enabled del negocio actual. */
  wholesalePortalEnabled: boolean
}

/**
 * ¿Tiene acceso a Mayorista? (módulo, navegación, ruta y tipo de cliente mayorista)
 * Autoridad canónica: ver el encabezado del archivo.
 */
export function canAccessWholesale(input: WholesaleAccessInput): boolean {
  return decideWholesaleAccess(input) === 'allowed'
}

/**
 * ¿Puede GESTIONAR (escribir) Mayorista?
 * Con acceso, y sólo owner/admin/manager/sales (espeja can_manage_wholesale()).
 */
export function canManageWholesale(input: WholesaleAccessInput): boolean {
  return (
    canAccessWholesale(input) &&
    (WHOLESALE_MANAGE_ROLES as readonly string[]).includes(input.role as string)
  )
}

/**
 * ¿Está en modo SOLO LECTURA de Mayorista?
 * Con acceso, y rol tech/cashier/viewer (ven pero no modifican).
 */
export function isWholesaleReadOnly(input: WholesaleAccessInput): boolean {
  return (
    canAccessWholesale(input) &&
    (WHOLESALE_READONLY_ROLES as readonly string[]).includes(input.role as string)
  )
}

/**
 * ¿Puede ADMINISTRAR la configuración privada de Portal Clic?
 * true únicamente cuando es el owner REAL del negocio actual y el portal está habilitado.
 */
export function canManageClicPortal(input: ClicPortalInput): boolean {
  return input.isBusinessOwner === true && input.wholesalePortalEnabled === true
}
