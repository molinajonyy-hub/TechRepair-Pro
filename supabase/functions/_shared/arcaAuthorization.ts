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

export async function authorizeArcaCaller(
  authorization: string | null,
  options: {
    capability: 'settings_sensitive' | 'comprobantes'
    serviceRoleKey?: string
    createUserClient: (authorization: string) => ArcaUserClient
  },
): Promise<ArcaCaller> {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i)
  if (!match) throw new ArcaAuthorizationError(401, 'UNAUTHENTICATED')

  // Exact secret verification, not a decoded role claim or an x-internal header.
  if (options.serviceRoleKey && await matchesServiceCredential(match[1], options.serviceRoleKey)) {
    return { kind: 'internal' }
  }

  try {
    const client = options.createUserClient(`Bearer ${match[1]}`)
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
