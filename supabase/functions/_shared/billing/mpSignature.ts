/** Mercado Pago's documented manifest uses URL data.id, never a body fallback.
 * Missing components are omitted. No freshness cutoff: MP retries old deliveries.
 * https://www.mercadopago.com.ar/developers/es/docs/checkout-api-orders/optional-notifications
 */
export function normalizeSignedId(id: string): string {
  return /^[a-z0-9]+$/i.test(id) ? id.toLowerCase() : id
}

export function signatureManifest(dataId: string | undefined, requestId: string, ts: string): string | null {
  if (!/^\d+$/.test(ts) || [dataId, requestId].some(v => v && /[;:\r\n]/.test(v))) return null
  return (dataId ? `id:${normalizeSignedId(dataId)};` : '')
    + (requestId ? `request-id:${requestId};` : '') + `ts:${ts};`
}

export async function validateMpSignature(
  req: Request, dataId: string | undefined, secret: string | undefined,
): Promise<'ok' | 'missing_secret' | 'invalid'> {
  if (!secret) return 'missing_secret'
  const parts = new Map<string, string>()
  for (const part of (req.headers.get('x-signature') ?? '').split(',')) {
    const i = part.indexOf('=')
    if (i < 0) return 'invalid'
    const key = part.slice(0, i).trim()
    if (parts.has(key)) return 'invalid'
    parts.set(key, part.slice(i + 1).trim())
  }
  const ts = parts.get('ts') ?? ''
  const v1 = parts.get('v1') ?? ''
  if (!/^[a-f0-9]{64}$/i.test(v1)) return 'invalid'
  const manifest = signatureManifest(dataId, req.headers.get('x-request-id') ?? '', ts)
  if (manifest === null) return 'invalid'
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const signature = Uint8Array.from(v1.match(/../g)!, byte => parseInt(byte, 16))
  return await crypto.subtle.verify('HMAC', key, signature, encoder.encode(manifest)) ? 'ok' : 'invalid'
}
