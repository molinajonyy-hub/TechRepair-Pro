/**
 * arca-credentials — handler RETIRADO (ARCA Self-Service Phase 0).
 *
 * Separado de `index.ts` para poder testearlo sin levantar el servidor HTTP.
 * No importa nada más que tipos web estándar: no hay cliente Supabase, ni
 * node-forge, ni acceso a datos. Ver la cabecera de `index.ts` para el porqué.
 */

// ── CORS: mismo contrato que el stub retirado de generate-csr ───────────────
const CANONICAL_ORIGINS = [
  'https://www.techrepairpro.app',
  'https://techrepairpro.app',
]

const stripSlash = (o: string) => o.trim().replace(/\/+$/, '')

const parseOrigins = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map(stripSlash).filter(Boolean)

const ALLOWED_ORIGINS: string[] = [
  ...new Set<string>([
    ...CANONICAL_ORIGINS,
    ...parseOrigins(Deno.env.get('MP_CORS_ORIGIN')),
    ...parseOrigins(Deno.env.get('APP_URL')),
  ]),
]

const ALLOWED_REQUEST_HEADERS = new Set<string>([
  'authorization',
  'x-client-info',
  'apikey',
  'content-type',
  'cache-control',
  'pragma',
])

const DEFAULT_ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type'

function pickAllowedRequestHeaders(req: Request): string {
  const requested = req.headers.get('Access-Control-Request-Headers')
  if (!requested) return DEFAULT_ALLOW_HEADERS
  return requested
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0 && ALLOWED_REQUEST_HEADERS.has(h))
    .join(', ')
}

export function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = stripSlash(req.headers.get('Origin') ?? '')
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': pickAllowedRequestHeaders(req),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin, Access-Control-Request-Headers',
  }
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

/** Cuerpo único y sanitizado: sin identificadores, tablas, stack ni metadata. */
export const RETIRED_BODY = {
  ok: false,
  error: 'ARCA_CREDENTIAL_UPLOAD_RETIRED',
  message: 'La carga de credenciales ARCA desde el navegador fue retirada. La clave privada se genera y resguarda del lado del servidor.',
}

/**
 * Fail-closed: el preflight sigue funcionando; cualquier otra invocación —
 * incluido un payload con `private_key_pem` — recibe 410 sin que se lea el body,
 * sin tocar la base y sin procesar material criptográfico.
 */
export function handler(req: Request): Response {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: buildCorsHeaders(req) })
  }
  return new Response(JSON.stringify(RETIRED_BODY), {
    status: 410,
    headers: { ...buildCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}
