/**
 * Retry utility for transient network/connection errors.
 * Safe to use on read-only operations. Do NOT use on writes (comprobantes, pagos, caja, stock).
 */

const TRANSIENT_PATTERNS = [
  'failed to fetch',
  'network',
  'timeout',
  'connection',
  'fetch error',
  'networkerror',
  'network request failed',
]

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return TRANSIENT_PATTERNS.some(p => msg.includes(p))
}

function isAuthOrPermissionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const anyErr = err as any
  const status = anyErr.status ?? anyErr.code
  if (status === 401 || status === 403) return true
  const msg = err.message.toLowerCase()
  return msg.includes('jwt') || msg.includes('row-level security') || msg.includes('permission denied')
}

/**
 * Retries `fn` up to `maxAttempts` times on transient errors.
 * Immediately throws on auth/permission errors or non-transient failures.
 * Only use on idempotent read operations.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 2,
  delayMs = 800
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (isAuthOrPermissionError(err)) throw err
      if (!isTransient(err)) throw err
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, delayMs * (attempt + 1)))
        if (import.meta.env.DEV) console.warn(`[retry] attempt ${attempt + 2}/${maxAttempts}`, err)
      }
    }
  }
  throw lastErr
}
