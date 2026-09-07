import { clientUpdateSignal } from './clientUpdateSignal'

// Compiled protocol declaration, not authorization. RLS/capabilities remain
// authoritative; a caller can forge these diagnostic/request headers.
export const TECHREPAIR_CLIENT_CONTRACT = 1
export const TECHREPAIR_CLIENT_HEADERS = {
  'x-techrepair-client-contract': String(TECHREPAIR_CLIENT_CONTRACT),
  'x-techrepair-client-build': __BUILD_COMMIT__,
}

/** Inspect only this project's Data API. Return the untouched SDK response. */
export function createClientContractFetch(
  supabaseUrl: string,
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
  requireUpdate = clientUpdateSignal.requireUpdate,
): typeof fetch {
  const base = new URL(supabaseUrl)
  return async (input, init) => {
    const response = await fetchImpl(input, init)
    const url = new URL(input instanceof Request ? input.url : String(input), base)
    if (response.status !== 409 || url.origin !== base.origin
      || !(url.pathname.startsWith('/rest/v1/') || url.pathname === '/graphql/v1')) return response
    try {
      const body: unknown = await response.clone().json()
      if (body && typeof body === 'object' && 'code' in body && body.code === 'CLIENT_UPDATE_REQUIRED') {
        requireUpdate()
      }
    } catch { /* Malformed JSON must retain the SDK's ordinary error handling. */ }
    return response
  }
}
