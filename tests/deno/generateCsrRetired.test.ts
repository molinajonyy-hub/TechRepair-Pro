/**
 * AFIP-S4B-1 — el generador de CSR legacy quedó RETIRADO (fail-closed).
 *
 * Ejercita el handler REAL desplegado (supabase/functions/generate-csr/handler.ts)
 * en el mismo runtime que producción. El handler no tiene cliente Supabase ni
 * node-forge, así que estas pruebas prueban también, por construcción, que no
 * puede tocar la base, Vault ni generar criptografía.
 *
 * RUN: deno test -A --node-modules-dir=auto tests/deno/
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { handler, RETIRED_BODY } from '../../supabase/functions/generate-csr/handler.ts'

const URL_FN = 'https://example.supabase.co/functions/v1/generate-csr'
const ORIGIN = 'https://www.techrepairpro.app'

// Payload operativo ANTIGUO completo (el que usaba el botón del frontend).
const LEGACY_PAYLOAD = {
  business_id: '00000000-0000-4000-8000-0000000054d1',
  razon_social: 'Fixture SA',
  cuit: '20111111112',
  provincia: 'Buenos Aires',
  localidad: 'CABA',
  email: 'fixture@test.local',
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(URL_FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  }))

// ─────────────────────────────────────────────────────────────────────────
Deno.test('OPTIONS (preflight) sigue respondiendo 204 con CORS', () => {
  const res = handler(new Request(URL_FN, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type',
    },
  }))
  assertEquals(res.status, 204)
  assertEquals(res.headers.get('access-control-allow-origin'), ORIGIN)
  assertEquals(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS')
})

Deno.test('POST sin JWT → 410 (verify_jwt=false: contesta la función, no el gateway)', async () => {
  const res = await post({})
  assertEquals(res.status, 410)
  const body = await res.json()
  assertEquals(body.error, 'LEGACY_CSR_FLOW_RETIRED')
  assertEquals(body.success, false)
})

Deno.test('POST con JWT de owner válido → 410 igual (no hay camino operativo)', async () => {
  const res = await post(LEGACY_PAYLOAD, { Authorization: 'Bearer owner-jwt-simulado' })
  assertEquals(res.status, 410)
  assertEquals((await res.json()).error, 'LEGACY_CSR_FLOW_RETIRED')
})

Deno.test('POST con el payload antiguo completo → 410 y NO devuelve CSR', async () => {
  const res = await post(LEGACY_PAYLOAD)
  assertEquals(res.status, 410)
  const raw = await res.text()
  assert(!/csr_pem/.test(raw), 'no debe devolver csr_pem')
  assert(!/CERTIFICATE REQUEST/.test(raw), 'no debe devolver un CSR')
  assert(!/PRIVATE KEY/.test(raw), 'no debe devolver una clave')
})

Deno.test('POST repetido → 410 estable (idempotente, sin efectos)', async () => {
  for (let i = 0; i < 3; i++) {
    const res = await post(LEGACY_PAYLOAD)
    assertEquals(res.status, 410)
    assertEquals((await res.json()).error, 'LEGACY_CSR_FLOW_RETIRED')
  }
})

Deno.test('la respuesta es sanitizada: sin business_id, CUIT, tablas ni stack', async () => {
  const res = await post(LEGACY_PAYLOAD)
  const raw = await res.text()
  assert(!raw.includes(LEGACY_PAYLOAD.business_id), 'no debe filtrar business_id')
  assert(!raw.includes(LEGACY_PAYLOAD.cuit), 'no debe filtrar el CUIT')
  assert(!/arca_config|private_key|vault|service_role/i.test(raw), 'no debe nombrar tablas/columnas/roles')
  assert(!/at\s+\w+\s+\(/.test(raw), 'no debe incluir stack')
  assertEquals(Object.keys(RETIRED_BODY).sort().join(','), 'error,message,success')
})

Deno.test('un Origin no autorizado no recibe Allow-Origin', () => {
  const res = handler(new Request(URL_FN, {
    method: 'OPTIONS', headers: { Origin: 'https://atacante.example' },
  }))
  assertEquals(res.status, 204)
  assertEquals(res.headers.get('access-control-allow-origin'), null)
})

Deno.test('el módulo del handler no arrastra cliente Supabase, forge ni red', async () => {
  const raw = await Deno.readTextFile('supabase/functions/generate-csr/handler.ts')
  // Se analiza solo el CÓDIGO: la cabecera documenta justamente qué ya NO hace.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert(!/createClient|@supabase\/supabase-js/.test(src), 'sin cliente Supabase')
  assert(!/node-forge|forge\./.test(src), 'sin node-forge')
  assert(!/fetch\(/.test(src), 'sin llamadas de red')
  assert(!/generateKeyPair|privateKey/.test(src), 'sin criptografía')
  // El único import del entrypoint es std/serve + el handler local.
  const entry = await Deno.readTextFile('supabase/functions/generate-csr/index.ts')
  const imports = [...entry.matchAll(/^import .*$/gm)].map((m) => m[0])
  assertEquals(imports.length, 2, 'el entrypoint solo importa serve y el handler')
})
