/** MP POS CONNECT NOT AVAILABLE IN BETA. Billing uses separate endpoints.
 * No body parsing, authentication, environment, database or provider access.
 * Reactivation requires a separate reviewed POST-BETA project.
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-signature, x-request-id, cache-control, pragma',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
}

export function mpPosBetaDisabled(req: Request): Response {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  return new Response(JSON.stringify({ success: false, error: 'FEATURE_NOT_AVAILABLE' }), {
    status: 410,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}
