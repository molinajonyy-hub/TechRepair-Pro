/**
 * scopedCors — robust, origin-scoped CORS for browser-facing edge functions.
 *
 * Same contract as the AFIP/CSR + mp-subscription fix, but factored into a pure,
 * dependency-free module so BOTH the Deno functions AND node:test can use it.
 * (Does NOT touch `_shared/cors.ts`, which other functions still import.)
 *
 * - Exact origin allowlist; echo back ONLY the request's Origin when allowed.
 *   Unauthorized origin → no Access-Control-Allow-Origin at all (fail closed).
 *   Never '*', never a comma-joined list of origins, never a canonical fallback.
 * - Request headers: explicit allowlist; reflect only the intersection of what
 *   the preflight asks for (incl. cache-control / pragma — Chrome adds them on a
 *   hard reload). Unknown headers are dropped (no blind reflection).
 * - Always: Allow-Methods POST, OPTIONS · Max-Age 86400 · Vary Origin,
 *   Access-Control-Request-Headers.
 *
 * No Deno/npm/esm.sh imports and no top-level env access → importable in node.
 */

// Real production origins. The apex 307-redirects to www on Vercel, so the
// browser's Origin on the live site is usually https://www.techrepairpro.app.
const CANONICAL_ORIGINS: readonly string[] = [
  'https://www.techrepairpro.app',
  'https://techrepairpro.app',
]

// Request headers we are willing to allow on the actual request (lower-case).
const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set<string>([
  'authorization',
  'apikey',
  'content-type',
  'x-client-info',
  'cache-control',
  'pragma',
])

// Fallback for non-preflight responses (where Allow-Headers is ignored anyway).
const DEFAULT_ALLOW_HEADERS = 'authorization, apikey, content-type, x-client-info'

const stripSlash = (o: string): string => o.trim().replace(/\/+$/, '')

/** Split a single env value (which may itself be a comma-separated list). */
export function parseOriginList(raw: string | undefined | null): string[] {
  return (raw ?? '').split(',').map(stripSlash).filter(Boolean)
}

/** Canonical origins ∪ any explicitly configured via env. De-duplicated. */
export function computeAllowedOrigins(
  envValues: Array<string | undefined | null> = [],
): string[] {
  return [...new Set<string>([
    ...CANONICAL_ORIGINS,
    ...envValues.flatMap(parseOriginList),
  ])]
}

/** Intersection of the preflight's requested headers with the allowlist. */
export function pickAllowedRequestHeaders(req: Request): string {
  const requested = req.headers.get('Access-Control-Request-Headers')
  if (!requested) return DEFAULT_ALLOW_HEADERS
  const allowed = requested
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0 && ALLOWED_REQUEST_HEADERS.has(h))
  return allowed.join(', ')
}

export interface Cors {
  /** CORS header map for a given request (origin echoed only if allowed). */
  headers: (req: Request) => Record<string, string>
  /** 204 preflight response carrying only CORS headers. */
  preflight: (req: Request) => Response
  /** JSON response that always carries the CORS headers. */
  json: (req: Request, body: unknown, status?: number) => Response
}

/**
 * Build a CORS helper bound to a concrete allowlist. The function passes its
 * env-derived origins once at startup; every response then flows through here.
 */
export function createCors(allowedOrigins: string[]): Cors {
  const build = (req: Request): Record<string, string> => {
    const origin = stripSlash(req.headers.get('Origin') ?? '')
    const headers: Record<string, string> = {
      'Access-Control-Allow-Headers': pickAllowedRequestHeaders(req),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin, Access-Control-Request-Headers',
    }
    // Only emit Allow-Origin for an authorized origin; never a fallback, never '*'.
    if (origin && allowedOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin
    }
    return headers
  }

  return {
    headers: build,
    preflight: (req) => new Response(null, { status: 204, headers: build(req) }),
    json: (req, body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...build(req), 'Content-Type': 'application/json' },
      }),
  }
}

export { CANONICAL_ORIGINS, ALLOWED_REQUEST_HEADERS }
