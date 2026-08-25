// ============================================================================
// CONTRATO de las dos Edge Functions de dólar recuperadas desde producción.
//
//   RUN: deno test -A --node-modules-dir=auto tests/deno/
//
// Estos tests describen lo que las funciones DESPLEGADAS hacen hoy, no lo que
// deberían hacer. Varias aserciones documentan comportamiento que este lote
// marca como riesgo (el cascadeo silencioso de proveedores en
// `fetch-dollar-rate`, la rama `variation_suspicious` sin campo `sell`). Se
// afirman a propósito: si un lote futuro las corrige, ESTOS TESTS DEBEN FALLAR
// y ser actualizados en el mismo commit que cambia la función. Ese fallo es la
// señal, no un bug del test.
//
// El source recuperado NO se tocó: no exporta helpers y llama `Deno.serve` en
// el top-level. Por eso el harness intercepta `Deno.serve` ANTES de importar el
// módulo y se queda con el handler. Refactorizar la función para hacerla
// testeable habría roto la fidelidad byte a byte que es el objetivo del lote.
//
// El upstream real NUNCA se llama: `globalThis.fetch` está mockeado en todos
// los casos y cada test asevera a qué host se intentó salir.
// ============================================================================
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'

type Handler = (req: Request) => Response | Promise<Response>

const INFODOLAR_URL =
  'https://www.infodolar.com/cotizacion-dolar-provincia-cordoba.aspx'
const AMBITO_URL = 'https://mercados.ambito.com/dolar/informal/variacion'
const DOLARAPI_URL = 'https://dolarapi.com/v1/dolares/blue'

// ── Harness ─────────────────────────────────────────────────────────────────

/**
 * Importa una Edge Function recuperada y devuelve su handler, sin levantar
 * ningún servidor ni abrir ningún puerto.
 */
async function loadHandler(modulePath: string): Promise<Handler> {
  let captured: Handler | null = null
  const realServe = Deno.serve
  Object.defineProperty(Deno, 'serve', {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      // Deno.serve(handler) | Deno.serve(options, handler)
      const fn = args.find((a) => typeof a === 'function') as Handler | undefined
      if (fn) captured = fn
      // Un objeto con la forma mínima de HttpServer, para no romper el módulo.
      return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {} }
    },
  })
  try {
    await import(modulePath)
  } finally {
    Object.defineProperty(Deno, 'serve', { configurable: true, writable: true, value: realServe })
  }
  assert(captured, `${modulePath} no registró un handler en Deno.serve`)
  return captured!
}

interface FetchCall { url: string; init?: RequestInit }

/** Respuesta canned por host. Cualquier host no listado es un fallo del test. */
function mockFetch(
  routes: Record<string, () => Response | Promise<Response>>,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = []
  const real = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    for (const [prefix, make] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return Promise.resolve(make())
    }
    throw new Error(`fetch a host no permitido en el test: ${url}`)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } })
}
function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}
function timeoutError(): never {
  const e = new Error('Request timed out')
  e.name = 'TimeoutError'
  throw e
}

// Fila real de InfoDolar Córdoba: compra 1.544,00 / venta 1.576,00
const HTML_CORDOBA_OK =
  '<table><tr><td>Dolar Blue</td><td>$ 1.544,00</td><td>$ 1.576,00</td></tr></table>'
// HTML sin ninguna señal de blue ni precios parseables
const HTML_SIN_DATOS = '<html><body><p>Sitio en mantenimiento</p></body></html>'

const H_FETCH_DOLLAR = await loadHandler('../../supabase/functions/fetch-dollar-rate/index.ts')
const H_INFODOLAR = await loadHandler('../../supabase/functions/infodolar-cordoba/index.ts')

function post(body: unknown): Request {
  return new Request('http://local/fn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ════════════════════════════════════════════════════════════════════════════
// fetch-dollar-rate  (v4 · verify_jwt=false)
// ════════════════════════════════════════════════════════════════════════════

Deno.test('fetch-dollar-rate · shape de éxito: sell/buy/source/province', async () => {
  const m = mockFetch({ [INFODOLAR_URL]: () => html(HTML_CORDOBA_OK) })
  try {
    const res = await H_FETCH_DOLLAR(post({}))
    assertEquals(res.status, 200)
    assertEquals(res.headers.get('Content-Type'), 'application/json')
    const b = await res.json()
    assertEquals(Object.keys(b).sort(), ['buy', 'province', 'sell', 'source'])
    assertEquals(typeof b.sell, 'number')
    assertEquals(typeof b.buy, 'number')
    assertEquals(b.sell, 1576)
    assertEquals(b.buy, 1544)
    assertEquals(b.source, 'INFODOLAR_CORDOBA')
    assertEquals(b.province, 'CORDOBA')
  } finally { m.restore() }
})

Deno.test('fetch-dollar-rate · sin body.source el DEFAULT es Córdoba, no Nacional', async () => {
  // Contra-intuitivo y relevante para el gate de seguridad: un caller anónimo
  // que no manda body recibe cotización de CÓRDOBA.
  const m = mockFetch({ [INFODOLAR_URL]: () => html(HTML_CORDOBA_OK) })
  try {
    const res = await H_FETCH_DOLLAR(new Request('http://local/fn', { method: 'POST' }))
    const b = await res.json()
    assertEquals(b.source, 'INFODOLAR_CORDOBA')
    assertEquals(m.calls.length, 1)
    assertStringIncludes(m.calls[0].url, 'infodolar.com')
  } finally { m.restore() }
})

Deno.test("fetch-dollar-rate · source:'nacional' saltea Córdoba y va a Ámbito", async () => {
  const m = mockFetch({
    [AMBITO_URL]: () => jsonRes({ compra: '1545,00', venta: '1565,00' }),
  })
  try {
    const res = await H_FETCH_DOLLAR(post({ source: 'nacional' }))
    const b = await res.json()
    assertEquals(b.sell, 1565)
    assertEquals(b.buy, 1545)
    assertEquals(b.source, 'AMBITO_NACIONAL')
    assertEquals(b.province, null)
    // Córdoba NO se consultó
    assertEquals(m.calls.length, 1)
    assertStringIncludes(m.calls[0].url, 'ambito.com')
  } finally { m.restore() }
})

Deno.test('fetch-dollar-rate · RIESGO: Córdoba falla y cae a Nacional EN SILENCIO', async () => {
  // Comportamiento REAL desplegado. El body no trae ninguna marca de que la
  // fuente pedida no fue la que respondió: sólo cambia `source`.
  const m = mockFetch({
    [INFODOLAR_URL]: () => new Response('boom', { status: 503 }),
    [AMBITO_URL]: () => jsonRes({ compra: '1545,00', venta: '1565,00' }),
  })
  try {
    const res = await H_FETCH_DOLLAR(post({}))
    assertEquals(res.status, 200)
    const b = await res.json()
    assertEquals(b.source, 'AMBITO_NACIONAL')
    assertEquals(b.province, null)
    assertEquals(b.sell, 1565)
    assertEquals(m.calls.length, 2, 'debe haber cascadeado a un segundo proveedor')
  } finally { m.restore() }
})

Deno.test('fetch-dollar-rate · RIESGO: cascadeo hasta el tercer proveedor (DolarAPI)', async () => {
  const m = mockFetch({
    [INFODOLAR_URL]: () => html(HTML_SIN_DATOS),
    [AMBITO_URL]: () => new Response('nope', { status: 500 }),
    [DOLARAPI_URL]: () => jsonRes({ compra: 1540, venta: 1560 }),
  })
  try {
    const b = await (await H_FETCH_DOLLAR(post({}))).json()
    assertEquals(b.source, 'DOLARAPI')
    assertEquals(b.sell, 1560)
    assertEquals(b.buy, 1540)
    assertEquals(m.calls.length, 3)
  } finally { m.restore() }
})

Deno.test('fetch-dollar-rate · timeout de upstream no propaga excepción, cascadea', async () => {
  const m = mockFetch({
    [INFODOLAR_URL]: () => timeoutError(),
    [AMBITO_URL]: () => jsonRes({ compra: '1545,00', venta: '1565,00' }),
  })
  try {
    const res = await H_FETCH_DOLLAR(post({}))
    assertEquals(res.status, 200)
    assertEquals((await res.json()).source, 'AMBITO_NACIONAL')
  } finally { m.restore() }
})

Deno.test('fetch-dollar-rate · todos los proveedores caídos → 404 {error,lastKnown}', async () => {
  const m = mockFetch({
    [INFODOLAR_URL]: () => new Response('x', { status: 500 }),
    [AMBITO_URL]: () => new Response('x', { status: 500 }),
    [DOLARAPI_URL]: () => new Response('x', { status: 500 }),
  })
  try {
    const res = await H_FETCH_DOLLAR(post({ lastKnown: 1500 }))
    assertEquals(res.status, 404)
    const b = await res.json()
    assertEquals(Object.keys(b).sort(), ['error', 'lastKnown'])
    assertEquals(b.lastKnown, 1500)
    // FAIL-CLOSED: no inventa un 0 ni un 1.
    assertEquals(b.sell, undefined)
  } finally { m.restore() }
})

Deno.test('fetch-dollar-rate · payload de proveedor inválido no produce cotización basura', async () => {
  const m = mockFetch({
    [INFODOLAR_URL]: () => html(HTML_SIN_DATOS),
    [AMBITO_URL]: () => jsonRes({ compra: 'no-es-un-numero', venta: 'tampoco' }),
    [DOLARAPI_URL]: () => jsonRes({ compra: null, venta: null }),
  })
  try {
    const res = await H_FETCH_DOLLAR(post({}))
    assertEquals(res.status, 404, 'un payload ilegible debe caer en el 404, no en sell:0')
  } finally { m.restore() }
})

Deno.test('fetch-dollar-rate · rango de validez rechaza valores fuera de 500..10000', async () => {
  const m = mockFetch({
    [INFODOLAR_URL]: () => html(HTML_SIN_DATOS),
    [AMBITO_URL]: () => jsonRes({ compra: '1,00', venta: '2,00' }),
    [DOLARAPI_URL]: () => jsonRes({ compra: 99999, venta: 999999 }),
  })
  try {
    assertEquals((await H_FETCH_DOLLAR(post({}))).status, 404)
  } finally { m.restore() }
})

Deno.test('fetch-dollar-rate · CONTRATO HAZARD: variación >15% devuelve 200 SIN campo sell', async () => {
  // La rama de "variación sospechosa" responde 200, sin `error` y sin `sell`.
  // `dollarRateService.fetchViaEdgeFunction` mapea `sell: data.sell` → undefined,
  // y recién `isValidRate(raw.sell)` en el caller lo convierte en degradación a
  // caché. O sea: el warning NUNCA llega al usuario. Ver docs.
  const m = mockFetch({ [INFODOLAR_URL]: () => html(HTML_CORDOBA_OK) })
  try {
    const res = await H_FETCH_DOLLAR(post({ lastKnown: 1000 }))
    assertEquals(res.status, 200)
    const b = await res.json()
    assertEquals(b.warning, 'variation_suspicious')
    assertEquals(b.sell, undefined, 'la rama de warning NO trae sell')
    assertEquals(b.newRate, 1576)
    assertEquals(b.lastKnown, 1000)
    assertEquals(b.error, undefined, 'tampoco trae error: el caller no puede distinguirlo por ahí')
  } finally { m.restore() }
})

Deno.test('fetch-dollar-rate · variación dentro del 15% devuelve el shape normal', async () => {
  const m = mockFetch({ [INFODOLAR_URL]: () => html(HTML_CORDOBA_OK) })
  try {
    const b = await (await H_FETCH_DOLLAR(post({ lastKnown: 1550 }))).json()
    assertEquals(b.sell, 1576)
    assertEquals(b.warning, undefined)
  } finally { m.restore() }
})

Deno.test('fetch-dollar-rate · body no-JSON no rompe (catch → {})', async () => {
  const m = mockFetch({ [INFODOLAR_URL]: () => html(HTML_CORDOBA_OK) })
  try {
    const req = new Request('http://local/fn', { method: 'POST', body: 'esto no es json' })
    assertEquals((await H_FETCH_DOLLAR(req)).status, 200)
  } finally { m.restore() }
})

Deno.test('fetch-dollar-rate · CORS preflight', async () => {
  const res = await H_FETCH_DOLLAR(new Request('http://local/fn', { method: 'OPTIONS' }))
  assertEquals(res.status, 200)
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), '*')
  assertEquals(
    res.headers.get('Access-Control-Allow-Headers'),
    'authorization, x-client-info, apikey, content-type',
  )
  // Contrato tal cual está desplegado: NO declara Allow-Methods ni Max-Age.
  assertEquals(res.headers.get('Access-Control-Allow-Methods'), null)
  assertEquals(res.headers.get('Access-Control-Max-Age'), null)
})

Deno.test('fetch-dollar-rate · SSRF: url/provider del caller son IGNORADOS', async () => {
  const m = mockFetch({ [INFODOLAR_URL]: () => html(HTML_CORDOBA_OK) })
  try {
    await H_FETCH_DOLLAR(post({
      url: 'http://169.254.169.254/latest/meta-data/',
      provider: 'http://internal-host/admin',
      endpoint: 'file:///etc/passwd',
    }))
    assertEquals(m.calls.length, 1)
    assertEquals(m.calls[0].url, INFODOLAR_URL)
    for (const c of m.calls) {
      assert(!c.url.includes('169.254'), 'no debe alcanzar link-local')
      assert(!c.url.includes('internal-host'))
      assert(!c.url.startsWith('file:'))
    }
  } finally { m.restore() }
})

// ════════════════════════════════════════════════════════════════════════════
// infodolar-cordoba  (v3 · verify_jwt=false)
// ════════════════════════════════════════════════════════════════════════════

Deno.test('infodolar-cordoba · shape de éxito completo', async () => {
  const m = mockFetch({ [INFODOLAR_URL]: () => html(HTML_CORDOBA_OK) })
  try {
    const res = await H_INFODOLAR(new Request('http://local/fn'))
    assertEquals(res.status, 200)
    assertEquals(res.headers.get('Content-Type'), 'application/json')
    const b = await res.json()
    assertEquals(
      Object.keys(b).sort(),
      ['appliedRate', 'compra', 'fetchedAt', 'mode', 'source', 'strategy', 'venta'],
    )
    assertEquals(typeof b.compra, 'number')
    assertEquals(typeof b.venta, 'number')
    assertEquals(b.compra, 1544)
    assertEquals(b.venta, 1576)
    assertEquals(b.mode, 'venta')
    assertEquals(b.source, 'infodolar_cordoba')
    assertEquals(b.strategy, 'html-table-row')
    assert(!Number.isNaN(Date.parse(b.fetchedAt)), 'fetchedAt debe ser ISO parseable')
  } finally { m.restore() }
})

Deno.test('infodolar-cordoba · INVARIANTE: appliedRate === venta, siempre', async () => {
  const m = mockFetch({ [INFODOLAR_URL]: () => html(HTML_CORDOBA_OK) })
  try {
    const b = await (await H_INFODOLAR(new Request('http://local/fn'))).json()
    assertEquals(b.appliedRate, b.venta)
    assert(b.appliedRate > b.compra, 'appliedRate nunca puede ser la compra')
  } finally { m.restore() }
})

Deno.test('infodolar-cordoba · estrategia json-embedded tiene prioridad', async () => {
  const m = mockFetch({
    [INFODOLAR_URL]: () => html('<script>var d={"compra":"1.544,00","venta":"1.576,00"}</script>'),
  })
  try {
    const b = await (await H_INFODOLAR(new Request('http://local/fn'))).json()
    assertEquals(b.strategy, 'json-embedded')
    assertEquals(b.venta, 1576)
  } finally { m.restore() }
})

Deno.test('infodolar-cordoba · FAIL-CLOSED: NO cascadea a Ámbito ni DolarAPI', async () => {
  // Esta es la diferencia central con fetch-dollar-rate. Si el HTML no parsea,
  // responde 422 en vez de traer un número de otra provincia.
  const m = mockFetch({ [INFODOLAR_URL]: () => html(HTML_SIN_DATOS) })
  try {
    const res = await H_INFODOLAR(new Request('http://local/fn'))
    assertEquals(res.status, 422)
    const b = await res.json()
    assertEquals(b.code, 'parse')
    assertStringIncludes(b.error, 'No se actualizaron precios')
    assertEquals(b.venta, undefined)
    assertEquals(b.appliedRate, undefined)
    // Un solo egress, y sólo a infodolar.
    assertEquals(m.calls.length, 1)
    assertEquals(m.calls[0].url, INFODOLAR_URL)
  } finally { m.restore() }
})

Deno.test('infodolar-cordoba · upstream non-200 → 502 code:http', async () => {
  const m = mockFetch({ [INFODOLAR_URL]: () => new Response('nope', { status: 503 }) })
  try {
    const res = await H_INFODOLAR(new Request('http://local/fn'))
    assertEquals(res.status, 502)
    const b = await res.json()
    assertEquals(b.code, 'http')
    assertStringIncludes(b.error, '503')
    assertEquals(m.calls.length, 1, 'no debe reintentar ni cascadear')
  } finally { m.restore() }
})

Deno.test('infodolar-cordoba · timeout → 503 code:timeout', async () => {
  const m = mockFetch({ [INFODOLAR_URL]: () => timeoutError() })
  try {
    const res = await H_INFODOLAR(new Request('http://local/fn'))
    assertEquals(res.status, 503)
    const b = await res.json()
    assertEquals(b.code, 'timeout')
    assertStringIncludes(b.error, 'No se actualizaron precios')
  } finally { m.restore() }
})

Deno.test('infodolar-cordoba · error de red → 503 code:network', async () => {
  const m = mockFetch({
    [INFODOLAR_URL]: () => { throw new TypeError('error sending request: dns error') },
  })
  try {
    const res = await H_INFODOLAR(new Request('http://local/fn'))
    assertEquals(res.status, 503)
    assertEquals((await res.json()).code, 'network')
  } finally { m.restore() }
})

Deno.test('infodolar-cordoba · rechaza venta <= compra (no invierte silenciosamente)', async () => {
  const m = mockFetch({
    [INFODOLAR_URL]: () => html('<table><tr><td>Blue</td><td>$ 1.576,00</td><td>$ 1.576,00</td></tr></table>'),
  })
  try {
    assertEquals((await H_INFODOLAR(new Request('http://local/fn'))).status, 422)
  } finally { m.restore() }
})

Deno.test('infodolar-cordoba · CORS preflight', async () => {
  const res = await H_INFODOLAR(new Request('http://local/fn', { method: 'OPTIONS' }))
  assertEquals(res.status, 200)
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), '*')
  assertEquals(res.headers.get('Access-Control-Allow-Methods'), null)
})

Deno.test('infodolar-cordoba · SSRF: destino constante, query/body ignorados', async () => {
  const m = mockFetch({ [INFODOLAR_URL]: () => html(HTML_CORDOBA_OK) })
  try {
    const req = new Request(
      'http://local/fn?url=http://169.254.169.254/&target=file:///etc/passwd',
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://internal-host/' }) },
    )
    await H_INFODOLAR(req)
    assertEquals(m.calls.length, 1)
    assertEquals(m.calls[0].url, INFODOLAR_URL)
  } finally { m.restore() }
})

Deno.test('infodolar-cordoba · no emite secretos ni auth en la respuesta', async () => {
  const m = mockFetch({ [INFODOLAR_URL]: () => html(HTML_CORDOBA_OK) })
  try {
    const res = await H_INFODOLAR(new Request('http://local/fn', {
      headers: { Authorization: 'Bearer token-super-secreto' },
    }))
    const raw = await res.text()
    assert(!raw.includes('token-super-secreto'))
    assert(!/service_role|SUPABASE_|apikey/i.test(raw))
  } finally { m.restore() }
})
