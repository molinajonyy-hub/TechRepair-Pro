// Corre el handler REAL de mp-webhook sin red, para tests/deno/mpWebhookSignature.test.ts.
// Se carga con ../edge-cors/import_map.json: `serve` sólo captura el handler,
// supabase-js es un stub inerte que registra cada uso y fetch está deshabilitado.
// Imprime una línea JSON marcada con la respuesta de cada escenario.
const g = globalThis as {
  __edgeHandler?: (req: Request) => Response | Promise<Response>
  __backendCalls?: string[]
}
const calls: string[] = (g.__backendCalls ??= [])
globalThis.fetch = (input: RequestInfo | URL) => {
  calls.push(`fetch:${String(input instanceof Request ? input.url : input)}`)
  return Promise.reject(new TypeError('network disabled in the webhook harness'))
}

Deno.env.set('SUPABASE_URL', 'http://stub.invalid')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', `sb_secret_${'c'.repeat(22)}_${'d'.repeat(8)}`)
Deno.env.set('MP_ACCESS_TOKEN', 'TEST-token')
Deno.env.delete('MP_WEBHOOK_SECRET')

await import(new URL('../../../../supabase/functions/mp-webhook/index.ts', import.meta.url).href)
const handler = g.__edgeHandler
if (!handler) throw new Error('mp-webhook did not register a handler')

const SECRET = 'webhook-secret-de-prueba'
const REQUEST_ID = 'req-0001'
const TS = '1790000000'
const URL_BASE = 'https://edge.test/functions/v1/mp-webhook'

/** La firma que calcula Mercado Pago: HMAC-SHA256 del manifiesto, en hex. */
async function sign(dataId: string, secret = SECRET): Promise<string> {
  const manifest = `id:${dataId};request-id:${REQUEST_ID};ts:${TS};`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const notification = (id: string) => JSON.stringify({ id: 4242, type: 'subscription_preapproval', action: 'updated', data: { id } })
const post = (body: string, headers: Record<string, string> = {}, query = '') =>
  new Request(`${URL_BASE}${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })
const signed = async (bodyId: string, signedId: string, query = '', secret = SECRET) =>
  post(notification(bodyId), { 'x-signature': `ts=${TS},v1=${await sign(signedId, secret)}`, 'x-request-id': REQUEST_ID }, query)

interface Scenario { secret: boolean; make: () => Request | Promise<Request> }
const scenarios: Record<string, Scenario> = {
  // Sin MP_WEBHOOK_SECRET la función no procesa NADA, ni con una firma «válida».
  no_secret: { secret: false, make: () => signed('pre_1', 'pre_1') },
  no_signature: { secret: true, make: () => post(notification('pre_1')) },
  empty_signature: { secret: true, make: () => post(notification('pre_1'), { 'x-signature': '', 'x-request-id': REQUEST_ID }) },
  malformed_signature: { secret: true, make: () => post(notification('pre_1'), { 'x-signature': 'v1=abc', 'x-request-id': REQUEST_ID }) },
  wrong_signature: { secret: true, make: () => post(notification('pre_1'), { 'x-signature': `ts=${TS},v1=${'0'.repeat(64)}`, 'x-request-id': REQUEST_ID }) },
  wrong_secret: { secret: true, make: () => signed('pre_1', 'pre_1', '', 'otro-secret') },
  // Firma válida de OTRO recurso: no sirve para éste.
  signed_for_other_resource: { secret: true, make: () => signed('pre_1', 'pre_2') },
  // La URL trae el id firmado y el cuerpo nombra otro recurso.
  url_id_differs_from_body: { secret: true, make: () => signed('pre_victima', 'pre_1', '?data.id=pre_1&type=subscription_preapproval') },
  valid: { secret: true, make: () => signed('pre_1', 'pre_1') },
  valid_with_url_id: { secret: true, make: () => signed('pre_1', 'pre_1', '?data.id=pre_1&type=subscription_preapproval') },
  // Mercado Pago firma el id en minúsculas.
  valid_uppercase_id: { secret: true, make: () => signed('PRE_ABC', 'pre_abc') },
  get_method: { secret: true, make: () => new Request(URL_BASE, { method: 'GET' }) },
  invalid_json: { secret: true, make: () => post('{no es json') },
  json_array: { secret: true, make: () => post('[1,2,3]') },
}

const results: Record<string, unknown> = {}
for (const [name, scenario] of Object.entries(scenarios)) {
  if (scenario.secret) Deno.env.set('MP_WEBHOOK_SECRET', SECRET)
  else Deno.env.delete('MP_WEBHOOK_SECRET')
  const before = calls.length
  const response = await handler(await scenario.make())
  results[name] = { status: response.status, body: (await response.text()).slice(0, 200), backendCalls: calls.slice(before) }
}
console.log(`__MP_WEBHOOK_RESULT__${JSON.stringify(results)}`)
