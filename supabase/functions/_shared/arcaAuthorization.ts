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

// Shortest value accepted as a server credential, so a missing or placeholder
// environment variable can never turn an empty string into a match.
const MIN_SERVICE_CREDENTIAL_LENGTH = 32

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
 * Server credentials that identify a trusted internal caller (P0-ARCA-A).
 *
 * The platform injects the project's secret API key (sb_secret_*, not a JWT) as
 * SUPABASE_SERVICE_ROLE_KEY and lists every secret key in SUPABASE_SECRET_KEYS.
 * Both are accepted, by exact value only. Malformed JSON contributes nothing.
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
  return [...found].filter((value) => value.length >= MIN_SERVICE_CREDENTIAL_LENGTH)
}

async function matchesAnyServiceCredential(presented: string, configured: readonly string[]): Promise<boolean> {
  let matched = false
  for (const credential of configured) {
    if (credential.length >= MIN_SERVICE_CREDENTIAL_LENGTH && await matchesServiceCredential(presented, credential)) {
      matched = true
    }
  }
  return matched
}

export async function authorizeArcaCaller(
  authorization: string | null,
  options: {
    capability: 'settings_sensitive' | 'comprobantes'
    /** Exact server credentials of a trusted internal caller. Omit to accept users only. */
    serviceCredentials?: readonly string[]
    /** Raw `apikey` header. supabase-js sends the server credential in both headers. */
    presentedApiKey?: string | null
    createUserClient: (authorization: string) => ArcaUserClient
  },
): Promise<ArcaCaller> {
  const bearer = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? null

  // Exact secret verification, never a decoded role claim or an x-internal header.
  const configured = options.serviceCredentials ?? []
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
