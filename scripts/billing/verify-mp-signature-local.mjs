/** Owner-only offline diagnosis. No network, no secret/header/manifest values printed.
 * MP_WEBHOOK_SECRET stays in the owner's local environment. The request file is
 * a PRIVATE capture {url, headers, body}; never commit or upload it.
 */
import { readFileSync } from 'node:fs'
import { normalizeSignedId, validateMpSignature } from '../../supabase/functions/_shared/billing/mpSignature.ts'

try {
  if (process.argv.length !== 3) throw new Error('Private request file required')
  const capture = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const req = new Request(capture.url, { headers: capture.headers })
  const params = new URL(capture.url).searchParams
  const id = params.get('data.id')
  const body = typeof capture.body === 'string' ? JSON.parse(capture.body) : capture.body
  const bodyId = body?.data?.id
  const ambiguous = params.getAll('data.id').length > 1 || params.getAll('type').length > 1
  const result = await validateMpSignature(req, id ?? undefined, process.env.MP_WEBHOOK_SECRET)
  console.log(JSON.stringify({
    secret_present: Boolean(process.env.MP_WEBHOOK_SECRET),
    signature_valid: result === 'ok', ambiguous_url: ambiguous,
    url_id_present: Boolean(id), request_id_present: Boolean(req.headers.get('x-request-id')),
    signed_id_matches_body: Boolean(id && bodyId != null && normalizeSignedId(id) === normalizeSignedId(String(bodyId))),
    topic_matches: !params.has('type') || params.get('type') === body?.type,
  }))
} catch {
  console.error('Offline verification could not read a valid private capture. No request or credential values were printed.')
  process.exitCode = 1
}
