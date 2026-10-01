/**
 * mp-subscription — Billing SaaS · acciones autenticadas (BETA-MP)
 *
 * POST /functions/v1/mp-subscription
 * Body: { action, business_id, ... }
 *
 *   create                  abre un checkout de Mercado Pago. NO cambia el acceso del negocio.
 *   status                  lectura local (DB). No consulta ni sincroniza Mercado Pago.
 *   reconcile               consulta Mercado Pago y lleva la DB al estado confirmado.
 *   update_payment_method   link de MP para la suscripción del negocio autorizado.
 *   cancel                  cancela en MP la suscripción del negocio autorizado.
 *
 * Este archivo es SÓLO cableado: CORS, validación del JWT y construcción de las
 * dependencias. Las reglas viven en `_shared/billing/` y se prueban sin red:
 *
 *   subscriptionActions.ts   las cinco acciones + la autorización uniforme
 *   preapproval.ts           el camino canónico que comparte con `mp-webhook`
 *   planCatalog.ts           MP_PLAN_* ↔ plan/ciclo
 *
 * ─── Seguridad ─────────────────────────────────────────────────
 * - El frontend propone, Mercado Pago confirma, el backend decide. Ninguna
 *   acción activa un plan por lo que diga el navegador.
 * - MP_ACCESS_TOKEN vive sólo en los secrets de las Edge Functions.
 * - El gateway corre con verify_jwt=false para que el preflight OPTIONS llegue;
 *   el JWT se valida acá (`getAuthUser`).
 * - Toda acción exige la capacidad `subscription` del usuario EN ese negocio,
 *   evaluada por la base con el JWT del usuario (`current_user_can_in_business`).
 * - Los datos se escriben con `service_role`, sólo después de autorizar.
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { BROWSER_CLIENT_METADATA_HEADERS, userDataApiHeaders } from '../_shared/clientContract.ts'
import { createMpClient } from '../_shared/billing/mpClient.ts'
import { buildPlanCatalog } from '../_shared/billing/planCatalog.ts'
import { createCapabilityAuthorizer, createSupabaseBillingStore } from '../_shared/billing/store.ts'
import { handleBillingAction, type ActionContext } from '../_shared/billing/subscriptionActions.ts'

// ─────────────────────────────────────────────────────────────────
// CORS — single source of truth (buildCorsHeaders + jsonResponse)
//
// Origin: an exact allowlist. We echo back ONLY the request's Origin when it is
// allowed; otherwise we send NO Access-Control-Allow-Origin at all (no canonical
// fallback) so an unauthorized origin can never read the response. Never '*'
// (this endpoint is authenticated), never a comma list of origins.
//
// Allowlist sources (each may be a single origin OR a comma-separated list):
//   - MP_CORS_ORIGIN  (preferred)
//   - APP_URL         (also used for back URLs; usually the same origin)
// The canonical production origin is a HARD default so a present-but-misconfigured
// secret can never silently drop the real origin or fall back to a stale Vercel one.
//
// Headers: an explicit, case-insensitive allowlist. We return ONLY the
// intersection of what the browser announces in Access-Control-Request-Headers
// with that allowlist — never reflect arbitrary headers. `cache-control` and
// `pragma` are included because Chrome adds them on a hard reload (Ctrl+Shift+R);
// omitting them makes the browser fail the preflight and never send the POST.
// ─────────────────────────────────────────────────────────────────
// Both hosts are real production origins. The apex 307-redirects to www (Vercel),
// so on the live site the browser's Origin is usually https://www.techrepairpro.app.
// Allowing ONLY the apex is what rejected the POST preflight for real users
// (the function answered OPTIONS 204 but with no Access-Control-Allow-Origin).
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

// Request headers we are willing to allow on the actual request (lower-case).
const ALLOWED_REQUEST_HEADERS = new Set<string>([
  'authorization',
  'x-client-info',
  'apikey',
  'content-type',
  'cache-control',
  'pragma',
  // The official web client's metadata headers. Transport only, never authority.
  ...BROWSER_CLIENT_METADATA_HEADERS,
])

// Fallback list for non-preflight responses (where ACAH is ignored by the browser).
const DEFAULT_ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type'

// Intersection of the preflight's requested headers with our allowlist.
// Normalizes to lower-case; drops anything unknown (no blind reflection).
function pickAllowedRequestHeaders(req: Request): string {
  const requested = req.headers.get('Access-Control-Request-Headers')
  if (!requested) return DEFAULT_ALLOW_HEADERS
  const allowed = requested
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0 && ALLOWED_REQUEST_HEADERS.has(h))
  return allowed.join(', ')
}

// The single CORS-header builder. Used by every response (preflight, success, error).
function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = stripSlash(req.headers.get('Origin') ?? '')
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': pickAllowedRequestHeaders(req),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin, Access-Control-Request-Headers',
  }
  // Only emit Allow-Origin for an authorized origin; never a canonical fallback.
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

// The single JSON-response builder. Always carries the CORS headers.
function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...buildCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// Origen del frontend para la URL de retorno por defecto del checkout.
const APP_ORIGIN = parseOrigins(Deno.env.get('APP_URL'))[0] ?? CANONICAL_ORIGINS[0]

const CLIENT_OPTIONS = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }

// ─────────────────────────────────────────────────────────────────
// Cliente con el JWT del USUARIO (anon key + Authorization del request).
// Sirve para validar la sesión y para preguntarle a la base, como ese usuario,
// si puede gestionar la suscripción del negocio.
// ─────────────────────────────────────────────────────────────────
function createUserClient(req: Request, authHeader: string) {
  // <any> Database generic: this function predates generated DB types. Type-only.
  return createClient<any>(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: userDataApiHeaders(req, authHeader) }, auth: CLIENT_OPTIONS },
  )
}

async function getAuthUser(req: Request) {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null

  const userClient = createUserClient(req, authHeader)
  const { data: { user }, error } = await userClient.auth.getUser()
  if (error || !user) return null
  return { id: user.id, email: user.email ?? null, client: userClient }
}

// ─────────────────────────────────────────────────────────────────
// Main router
// ─────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    // Preflight — CORS headers only, no body.
    return new Response(null, { status: 204, headers: buildCorsHeaders(req) })
  }
  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'Method not allowed' }, 405)
  }

  try {
    // In-function auth (gateway runs verify_jwt=false so OPTIONS can reach us).
    const user = await getAuthUser(req)
    if (!user) return jsonResponse(req, { error: 'Unauthorized' }, 401)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return jsonResponse(req, { error: 'Invalid JSON body' }, 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse(req, { error: 'Invalid JSON body' }, 400)
    }

    // service_role: escribe sólo DESPUÉS de que `handleBillingAction` autorizó.
    const serviceClient = createClient<any>(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: CLIENT_OPTIONS },
    )

    const ctx: ActionContext = {
      store: createSupabaseBillingStore(serviceClient),
      authorizer: createCapabilityAuthorizer(user.client),
      mp: createMpClient({
        fetchImpl: (input, init) => fetch(input, init),
        accessToken: () => Deno.env.get('MP_ACCESS_TOKEN'),
      }),
      catalog: buildPlanCatalog((key) => Deno.env.get(key)),
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
      allowedOrigins: ALLOWED_ORIGINS,
      appOrigin: APP_ORIGIN,
      // Sólo ids, estados y códigos. Nunca emails, tokens ni cuerpos de Mercado Pago.
      log: (event) => console.log(JSON.stringify({ fn: 'mp-subscription', ...event })),
    }

    const result = await handleBillingAction(ctx, {
      user: { id: user.id, email: user.email },
      body: body as Record<string, unknown>,
      origin: stripSlash(req.headers.get('Origin') ?? '') || null,
    })
    return jsonResponse(req, result.body, result.status)

  } catch (err) {
    // El detalle queda en el log del servidor; al navegador no le llega.
    console.error('[mp-subscription] Unhandled error:', err instanceof Error ? err.message : 'unknown')
    return jsonResponse(req, { error: 'Internal server error' }, 500)
  }
})
