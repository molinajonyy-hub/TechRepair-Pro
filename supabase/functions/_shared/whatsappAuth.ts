/**
 * whatsappAuth — tenant authorization for WhatsApp-sending edge functions.
 *
 * Single source of truth shared by `whatsapp-send` and `whatsapp-send-message`,
 * so the two can never drift. Pure & dependency-injected (no Deno/npm imports,
 * clients passed in as closures) → importable by node:test for real behavioral
 * tests as well as by the Deno runtime.
 *
 * Security contract enforced here (NOT in the frontend, NOT from the body):
 *  - The actor is taken EXCLUSIVELY from the validated JWT (getUserId). A
 *    `user_id` in the request body is never an authority source.
 *  - business_id must be present.
 *  - The actor must have an ACTIVE membership (profiles.is_active) in THAT
 *    business — this is what blocks cross-tenant access (user of A → business B).
 *  - The membership role must be allowed to send messages.
 *  - Lookups are non-enumerative: "not a member" and "business does not exist"
 *    both return 403 (no signal about whether the business exists).
 *
 * The caller MUST run this BEFORE reading any WhatsApp credentials or contacting
 * Meta, so a blocked request never touches another tenant's connection.
 */

/**
 * Roles permitted to send WhatsApp messages: every active role EXCEPT `viewer`
 * (viewer is read-only by design — see src/config/permissions.ts). Kept here as
 * the single authoritative list so both functions and the tests agree.
 */
export const ALLOWED_SENDER_ROLES: readonly string[] = [
  'owner',
  'admin',
  'manager',
  'tech',
  'sales',
  'cashier',
]

export interface ActiveMembership {
  role: string
}

export interface AuthzDeps {
  /** Resolve the actor's id from the VALIDATED JWT only. Returns null if the
   *  session is missing/invalid. Must NOT consult the request body. */
  getUserId: () => Promise<string | null>
  /** Fetch the actor's ACTIVE membership in `businessId` (null if none/exists not). */
  getActiveMembership: (userId: string, businessId: string) => Promise<ActiveMembership | null>
  /** Raw business_id from the request body (validated here, not trusted). */
  businessId: unknown
  /** Roles allowed to send. Defaults to ALLOWED_SENDER_ROLES. */
  allowedRoles?: readonly string[]
}

export type AuthzResult =
  | { ok: true; userId: string; role: string }
  | { ok: false; status: 400 | 401 | 403; error: string }

/**
 * Authorize a WhatsApp send. Order matters and is part of the contract:
 *   1) valid session            → else 401
 *   2) business_id present       → else 400
 *   3) active membership in biz  → else 403 (non-enumerative)
 *   4) role allowed to send      → else 403
 */
export async function authorizeWhatsAppSender(deps: AuthzDeps): Promise<AuthzResult> {
  const allowedRoles = deps.allowedRoles ?? ALLOWED_SENDER_ROLES

  // 1) Actor strictly from the JWT.
  const userId = await deps.getUserId()
  if (!userId) {
    return { ok: false, status: 401, error: 'No autorizado: sesión inválida o expirada.' }
  }

  // 2) business_id must be a non-empty string.
  const businessId = typeof deps.businessId === 'string' ? deps.businessId.trim() : ''
  if (!businessId) {
    return { ok: false, status: 400, error: 'Falta el campo business_id.' }
  }

  // 3) Active membership in THIS business (blocks cross-tenant + inactive members).
  const membership = await deps.getActiveMembership(userId, businessId)
  if (!membership) {
    // Same response whether the business does not exist or the user is not a
    // member — do not leak the existence of other tenants.
    return { ok: false, status: 403, error: 'No tenés acceso a este negocio.' }
  }

  // 4) Role gate.
  if (!allowedRoles.includes(membership.role)) {
    return { ok: false, status: 403, error: 'Tu rol no tiene permiso para enviar mensajes de WhatsApp.' }
  }

  return { ok: true, userId, role: membership.role }
}
