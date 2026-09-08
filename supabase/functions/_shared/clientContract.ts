export const CLIENT_CONTRACT_HEADER = 'x-techrepair-client-contract'

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
