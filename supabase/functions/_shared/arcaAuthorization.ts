/** Fiscal entry authorization. All user reads use the caller JWT, never service_role. */
export interface ArcaUserClient {
  auth: { getUser(): Promise<{ data: { user: { id: string } | null }; error: unknown }> }
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
}

export type ArcaCaller =
  | { kind: 'internal' }
  | { kind: 'user'; userId: string; businessId: string }

export class ArcaAuthorizationError extends Error {
  readonly status: 401 | 403 | 503
  readonly code: string
  constructor(status: 401 | 403 | 503, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

export async function matchesServiceCredential(token: string, configuredKey: string): Promise<boolean> {
  if (!token || !configuredKey) return false
  const bytes = new TextEncoder()
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', bytes.encode(token)),
    crypto.subtle.digest('SHA-256', bytes.encode(configuredKey)),
  ])
  const a = new Uint8Array(left)
  const b = new Uint8Array(right)
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]
  return difference === 0
}

/**
 * Server credential classes accepted on the internal path (P0-ARCA-A).
 *
 * Classification only decides WHICH configured values may act as a server
 * credential. It never grants authority: an internal caller is recognized only by
 * an exact, constant-time match against one of those configured values. A decoded
 * role claim is shape validation, nothing more.
 *
 * - secret_key: Supabase secret API key. Documented shape
 *   sb_secret_<22-char random>_<8-char checksum>; the project's sb_publishable_
 *   key, observed in production, has exactly that shape.
 * - legacy_service_role_jwt: three base64url parts, a header with a real alg, and
 *   a payload whose role is service_role and that carries no user subject.
 *
 * Everything else (publishable keys, anon or user JWTs, malformed JWTs, arbitrary
 * strings) is rejected, so a miswired environment variable fails closed.
 */
export type ServerCredentialClass = 'secret_key' | 'legacy_service_role_jwt'

const SECRET_KEY_SHAPE = /^sb_secret_[A-Za-z0-9]{22}_[A-Za-z0-9]{8}$/
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/

function decodeJwtPart(part: string): unknown {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
  const binary = atob(padded)
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))))
}

function isStructuralServiceRoleJwt(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 3 || !parts.every((p) => BASE64URL_PART.test(p))) return false
  try {
    const header = decodeJwtPart(parts[0])
    const payload = decodeJwtPart(parts[1])
    if (!header || typeof header !== 'object' || Array.isArray(header)) return false
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
    const alg = (header as Record<string, unknown>).alg
    const claims = payload as Record<string, unknown>
    return typeof alg === 'string' && alg.toLowerCase() !== 'none'
      && claims.role === 'service_role' && !('sub' in claims)
  } catch {
    return false
  }
}

export function serverCredentialClass(value: string): ServerCredentialClass | null {
  if (SECRET_KEY_SHAPE.test(value)) return 'secret_key'
  if (isStructuralServiceRoleJwt(value)) return 'legacy_service_role_jwt'
  return null
}

const isServerCredential = (value: unknown): value is string =>
  typeof value === 'string' && serverCredentialClass(value) !== null

/**
 * Runtime server credentials of this Edge environment (P0-ARCA-A).
 *
 * The platform injects the project's secret API key (sb_secret_*, not a JWT) as
 * SUPABASE_SERVICE_ROLE_KEY and lists every secret key in SUPABASE_SECRET_KEYS.
 * Only values of an accepted class survive; malformed JSON contributes nothing.
 */
export function configuredServiceCredentials(env: { get(name: string): string | undefined }): string[] {
  const found = new Set<string>()
  const serviceRole = env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim()
  if (serviceRole) found.add(serviceRole)
  const secretKeys = env.get('SUPABASE_SECRET_KEYS')
  if (secretKeys) {
    try {
      const parsed: unknown = JSON.parse(secretKeys)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const value of Object.values(parsed as Record<string, unknown>)) {
          if (typeof value === 'string' && value.trim()) found.add(value.trim())
        }
      }
    } catch { /* malformed: contributes nothing */ }
  }
  return [...found].filter(isServerCredential)
}

async function matchesAnyServiceCredential(presented: string, configured: readonly string[]): Promise<boolean> {
  let matched = false
  for (const credential of configured) {
    if (await matchesServiceCredential(presented, credential)) matched = true
  }
  return matched
}

export async function authorizeArcaCaller(
  authorization: string | null,
  options: {
    capability: 'settings_sensitive' | 'comprobantes'
    /**
     * Roles allowed on the user path, checked on the SAME profile that resolved the
     * tenant, in addition to the capability. Omit to keep capability-only authority.
     */
    roles?: readonly string[]
    /** Exact server credentials of a trusted internal caller. Omit to accept users only. */
    serviceCredentials?: readonly string[]
    /** Raw `apikey` header. supabase-js sends the server credential in both headers. */
    presentedApiKey?: string | null
    createUserClient: (authorization: string) => ArcaUserClient
  },
): Promise<ArcaCaller> {
  const bearer = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? null

  // Exact secret verification, never a decoded role claim or an x-internal header.
  // Values outside the accepted classes are dropped here too (defense in depth).
  const configured = (options.serviceCredentials ?? []).filter(isServerCredential)
  if (configured.length > 0) {
    for (const presented of [bearer, options.presentedApiKey?.trim() || null]) {
      if (presented && await matchesAnyServiceCredential(presented, configured)) return { kind: 'internal' }
    }
  }

  if (!bearer) throw new ArcaAuthorizationError(401, 'UNAUTHENTICATED')

  try {
    const client = options.createUserClient(`Bearer ${bearer}`)
    const identity = await client.auth.getUser()
    if (identity.error || !identity.data.user?.id) {
      throw new ArcaAuthorizationError(401, 'UNAUTHENTICATED')
    }
    const profileResult = await client.rpc('get_my_profile')
    if (profileResult.error) throw new ArcaAuthorizationError(503, 'AUTHORIZATION_UNAVAILABLE')
    const rows: unknown = profileResult.data
    const candidate: unknown = Array.isArray(rows) && rows.length === 1 ? rows[0] : null
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new ArcaAuthorizationError(403, 'FORBIDDEN')
    }
    const profile = candidate as Record<string, unknown>
    if ((profile.user_id ?? profile.id) !== identity.data.user.id
      || profile.is_active !== true || typeof profile.business_id !== 'string' || !profile.business_id) {
      throw new ArcaAuthorizationError(403, 'FORBIDDEN')
    }
    if (options.roles !== undefined
      && (typeof profile.role !== 'string' || !options.roles.includes(profile.role))) {
      throw new ArcaAuthorizationError(403, 'FORBIDDEN')
    }

    // The current capability RPC owns defaults/overrides. Malformed restrictions
    // must not silently degrade to a role default (owner ignores overrides by contract).
    const permissions: unknown = profile.permissions
    if (profile.role !== 'owner' && permissions != null) {
      if (typeof permissions !== 'object' || Array.isArray(permissions)) {
        throw new ArcaAuthorizationError(403, 'FORBIDDEN')
      }
      const value = (permissions as Record<string, unknown>)[options.capability]
      if (value !== undefined && typeof value !== 'boolean') {
        throw new ArcaAuthorizationError(403, 'FORBIDDEN')
      }
    }
    const permission = await client.rpc('current_user_can', { p_key: options.capability })
    if (permission.error) throw new ArcaAuthorizationError(503, 'AUTHORIZATION_UNAVAILABLE')
    if (permission.data !== true) throw new ArcaAuthorizationError(403, 'FORBIDDEN')
    return { kind: 'user', userId: identity.data.user.id, businessId: profile.business_id }
  } catch (error) {
    if (error instanceof ArcaAuthorizationError) throw error
    throw new ArcaAuthorizationError(503, 'AUTHORIZATION_UNAVAILABLE')
  }
}
