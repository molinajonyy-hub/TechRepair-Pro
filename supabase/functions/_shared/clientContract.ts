export const CLIENT_CONTRACT_HEADER = 'x-techrepair-client-contract'
export const CLIENT_BUILD_HEADER = 'x-techrepair-client-build'

/**
 * Metadata headers the official web client (`src/lib/clientContract.ts`,
 * TECHREPAIR_CLIENT_HEADERS) sends on EVERY Supabase request, Edge Functions
 * included. A browser-called Edge Function must allow them in its CORS preflight,
 * otherwise the browser never sends the request. They are forgeable metadata:
 * they never authenticate, authorize, select a tenant or unlock a capability.
 * `scripts/guards/edge-cors-client-contract.mjs` keeps this list equal to the
 * frontend's.
 */
export const BROWSER_CLIENT_METADATA_HEADERS: readonly string[] = [
  CLIENT_CONTRACT_HEADER,
  CLIENT_BUILD_HEADER,
]

/** Headers supabase-js itself adds to a browser `functions.invoke` call. */
export const SUPABASE_JS_BROWSER_HEADERS: readonly string[] = [
  'authorization',
  'x-client-info',
  'apikey',
  'content-type',
]

/** Everything the official web client may announce in a preflight to an Edge Function. */
export const BROWSER_EDGE_REQUEST_HEADERS: readonly string[] = [
  ...SUPABASE_JS_BROWSER_HEADERS,
  ...BROWSER_CLIENT_METADATA_HEADERS,
]

/**
 * Preserve the browser compatibility marker only when an Edge Function makes
 * a user-scoped Data API call. The marker remains forgeable metadata; the user
 * JWT, RLS, and capability checks retain all authorization authority.
 */
export function userDataApiHeaders(req: Request, authorization: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: authorization }
  const contract = req.headers.get(CLIENT_CONTRACT_HEADER)
  if (contract !== null) headers[CLIENT_CONTRACT_HEADER] = contract
  return headers
}
