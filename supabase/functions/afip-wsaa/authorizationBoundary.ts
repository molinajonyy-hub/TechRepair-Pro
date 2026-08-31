import { ArcaAuthorizationError, type ArcaCaller } from '../_shared/arcaAuthorization.ts'

export interface AuthorizedWsaaRequest {
  caller: ArcaCaller
  businessId: string
  service: 'wsfe'
  forceRefresh: boolean
}

/** The only route into configuration/Vault/WSAA, including its error writes. */
export async function withWsaaAuthorization(req: Request, deps: {
  authorize: () => Promise<ArcaCaller>
  run: (context: AuthorizedWsaaRequest) => Promise<Response>
  markAuthorizedError: (businessId: string, message: string) => Promise<void>
  json: (body: unknown, status: number) => Response
}): Promise<Response> {
  let context: AuthorizedWsaaRequest | undefined
  try {
    const caller = await deps.authorize()
    if (req.method !== 'POST') return deps.json({ success: false, error: 'METHOD_NOT_ALLOWED' }, 405)
    let body: unknown
    try { body = await req.json() } catch {
      return deps.json({ success: false, error: 'INVALID_BODY' }, 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return deps.json({ success: false, error: 'INVALID_BODY' }, 400)
    }
    const input = body as Record<string, unknown>
    if (typeof input.business_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.business_id)) {
      return deps.json({ success: false, error: 'INVALID_BUSINESS_ID' }, 400)
    }
    const businessId = input.business_id.toLowerCase()
    if (caller.kind === 'user' && businessId !== caller.businessId.toLowerCase()) {
      return deps.json({ success: false, error: 'FORBIDDEN' }, 403)
    }
    if ((input.service !== undefined && input.service !== 'wsfe')
      || (input.force_refresh !== undefined && typeof input.force_refresh !== 'boolean')) {
      return deps.json({ success: false, error: 'INVALID_REQUEST' }, 400)
    }
    context = { caller, businessId, service: 'wsfe', forceRefresh: input.force_refresh === true }
    const response = await deps.run(context)
    if (caller.kind === 'internal') return response

    // Browser tests only need presence flags. Never serialize operational credentials.
    const result = await response.json() as Record<string, unknown>
    return deps.json(result.success === true ? {
      success: true,
      tokenOk: typeof result.token === 'string' && result.token.length > 0,
      signOk: typeof result.sign === 'string' && result.sign.length > 0,
      cached: result.cached === true,
      ...(typeof result.expires_at === 'string' ? { expires_at: result.expires_at } : {}),
    } : { success: false, error: typeof result.error === 'string' ? result.error : 'WSAA_FAILED' }, response.status)
  } catch (error) {
    if (error instanceof ArcaAuthorizationError) {
      return deps.json({ success: false, error: error.code }, error.status)
    }
    // A rejected request never gets a context; never reparse untrusted body here.
    const message = 'No se pudo completar la autenticación WSAA.'
    if (context) {
      try { await deps.markAuthorizedError(context.businessId, message) } catch { /* best effort */ }
    }
    return deps.json({ success: false, error: message }, context ? 200 : 503)
  }
}
