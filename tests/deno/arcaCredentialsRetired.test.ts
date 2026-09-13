/**
 * ARCA Self-Service Phase 0 — `arca-credentials` quedó RETIRADA (fail-closed).
 *
 * Ejercita el handler REAL (supabase/functions/arca-credentials/handler.ts) en el
 * mismo runtime que producción. Antes aceptaba `private_key_pem` desde el
 * llamador; ahora ninguna invocación lee el body.
 *
 * RUN: deno test -A --node-modules-dir=auto tests/deno/
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { handler, RETIRED_BODY } from '../../supabase/functions/arca-credentials/handler.ts'

const URL_FN = 'https://example.supabase.co/functions/v1/arca-credentials'
const ORIGIN = 'https://www.techrepairpro.app'
const SYNTHETIC_KEY = '-----BEGIN PRIVATE KEY-----\nU1lOVEhFVElDLU5PVC1BLVJFQUwtS0VZ\n-----END PRIVATE KEY-----'
const SYNTHETIC_CERT = '-----BEGIN CERTIFICATE-----\nU1lOVEhFVElD\n-----END CERTIFICATE-----'

// Payload operativo ANTIGUO completo de AFIP-S1A.
const LEGACY_PAYLOAD = {
  business_id: '00000000-0000-4000-8000-0000000054d2',
  cert_pem: SYNTHETIC_CERT,
  private_key_pem: SYNTHETIC_KEY,
}

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  handler(new Request(URL_FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body,
  }))

Deno.test('OPTIONS (preflight) responde 204 con CORS de allowlist', () => {
  const res = handler(new Request(URL_FN, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' },
  }))
  assertEquals(res.status, 204)
  assertEquals(res.headers.get('access-control-allow-origin'), ORIGIN)
})

Deno.test('POST con private_key_pem → 410 y el body NUNCA se lee', async () => {
  const req = new Request(URL_FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: 'Bearer owner-jwt-simulado' },
    body: JSON.stringify(LEGACY_PAYLOAD),
  })
  const res = handler(req)
  assertEquals(res.status, 410)
  assertEquals(req.bodyUsed, false, 'el handler no debe consumir el body')
  assertEquals((await res.json()).error, 'ARCA_CREDENTIAL_UPLOAD_RETIRED')
})

Deno.test('POST con body inválido o vacío → 410 igual (no hay parser)', async () => {
  for (const body of ['{no-json', '', null]) {
    const res = post(body)
    assertEquals(res.status, 410)
    assertEquals((await res.json()).error, 'ARCA_CREDENTIAL_UPLOAD_RETIRED')
  }
})

Deno.test('GET/PUT/DELETE → 410 (ningún método operativo)', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const res = handler(new Request(URL_FN, { method, headers: { Origin: ORIGIN } }))
    assertEquals(res.status, 410)
    await res.body?.cancel()
  }
})

Deno.test('la respuesta no refleja la clave, el certificado ni el business_id', async () => {
  const raw = await post(JSON.stringify(LEGACY_PAYLOAD)).text()
  assert(!raw.includes('U1lOVEhFVElD'), 'no debe reflejar material enviado')
  assert(!/PRIVATE KEY|BEGIN CERTIFICATE/.test(raw), 'no debe devolver PEM')
  assert(!raw.includes(LEGACY_PAYLOAD.business_id), 'no debe filtrar business_id')
  assert(!/arca_config|vault|service_role|secret_id/i.test(raw), 'no debe nombrar tablas/roles/secretos')
  assertEquals(Object.keys(RETIRED_BODY).sort().join(','), 'error,message,ok')
})

Deno.test('un Origin no autorizado no recibe Allow-Origin', () => {
  const res = handler(new Request(URL_FN, { method: 'OPTIONS', headers: { Origin: 'https://atacante.example' } }))
  assertEquals(res.headers.get('access-control-allow-origin'), null)
})

Deno.test('el módulo no arrastra cliente Supabase, forge, Vault, RPC ni red', async () => {
  const raw = await Deno.readTextFile('supabase/functions/arca-credentials/handler.ts')
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert(!/createClient|@supabase\/supabase-js/.test(src), 'sin cliente Supabase')
  assert(!/node-forge|forge\./.test(src), 'sin node-forge')
  assert(!/\.rpc\(|fetch\(/.test(src), 'sin RPC ni red')
  assert(!/req\.(json|text|formData|arrayBuffer|blob)\(/.test(src), 'sin lectura de body')
  assert(!/private_key|SERVICE_ROLE/i.test(src), 'sin claves ni service_role')
  const entry = await Deno.readTextFile('supabase/functions/arca-credentials/index.ts')
  const imports = [...entry.matchAll(/^import .*$/gm)].map((m) => m[0])
  assertEquals(imports.length, 2, 'el entrypoint solo importa serve y el handler')
})
