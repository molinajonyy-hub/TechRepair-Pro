/**
 * BETA-MP — mp-webhook: la firma es obligatoria y va ANTES que todo.
 *
 * Corre el handler real de `supabase/functions/mp-webhook/index.ts` en Deno (el
 * runtime de las Edge Functions), sin red: supabase-js es un stub que registra
 * cada uso y fetch está deshabilitado. Mide el contrato del borde:
 *
 *   · sin MP_WEBHOOK_SECRET → 500, sin tocar la base ni Mercado Pago;
 *   · firma ausente, mal formada, incorrecta, de otro secret o de OTRO recurso
 *     → 401, sin crear el cliente service_role;
 *   · el id firmado (URL) no coincide con el del cuerpo → 401;
 *   · firma válida → recién ahí se crea el cliente y se reclama el evento.
 *
 * Las reglas de billing (qué hace una notificación válida) están en
 * tests/components/betaMp/.
 *
 * RUN: deno test -A --node-modules-dir=none tests/deno/mpWebhookSignature.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'

const HARNESS = new URL('./fixtures/mp-webhook/harness.ts', import.meta.url).href
const IMPORT_MAP = new URL('./fixtures/edge-cors/import_map.json', import.meta.url).href

interface Result { status: number; body: string; backendCalls: string[] }

let cached: Promise<Record<string, Result>> | null = null
function run(): Promise<Record<string, Result>> {
  cached ??= (async () => {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ['run', '-A', '--no-config', '--import-map', IMPORT_MAP, HARNESS],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    const marker = '__MP_WEBHOOK_RESULT__'
    const line = new TextDecoder().decode(out.stdout).split('\n').map((l) => l.trim()).find((l) => l.startsWith(marker))
    if (!out.success || !line) throw new Error(`mp-webhook harness failed:\n${new TextDecoder().decode(out.stderr)}`)
    return JSON.parse(line.slice(marker.length))
  })()
  return cached
}

Deno.test('sin MP_WEBHOOK_SECRET: 500 y no procesa nada, ni con una firma bien calculada', async () => {
  const r = (await run()).no_secret
  assertEquals(r.status, 500)
  assertEquals(r.backendCalls, [])
})

for (const scenario of ['no_signature', 'empty_signature', 'malformed_signature', 'wrong_signature', 'wrong_secret', 'signed_for_other_resource']) {
  Deno.test(`firma inválida (${scenario}): 401 sin crear el cliente service_role ni llamar a Mercado Pago`, async () => {
    const r = (await run())[scenario]
    assertEquals(r.status, 401, r.body)
    assertEquals(r.backendCalls, [])
  })
}

Deno.test('lo firmado y lo procesado no pueden diferir: id de la URL ≠ id del cuerpo → 401', async () => {
  const r = (await run()).url_id_differs_from_body
  assertEquals(r.status, 401, r.body)
  assertEquals(r.backendCalls, [])
})

for (const scenario of ['valid', 'valid_with_url_id', 'valid_uppercase_id']) {
  Deno.test(`firma válida (${scenario}): pasa el borde y reclama el evento antes de cualquier otra cosa`, async () => {
    const r = (await run())[scenario]
    assert(r.status !== 401, `rechazó una firma válida: ${r.body}`)
    assertEquals(r.backendCalls[0], 'createClient')
    assertEquals(r.backendCalls[1], 'from:subscription_events')
    // El stub no tiene base: el claim falla y la función responde 500 para que
    // Mercado Pago reintente. Nunca 200 «recibido» sin haber procesado.
    assertEquals(r.status, 500)
    assert(r.body.includes('"received":false'), r.body)
    // Sin el evento reclamado no se consulta Mercado Pago ni se toca otra tabla.
    assert(!r.backendCalls.some((c) => c.startsWith('fetch:') || c === 'from:businesses' || c === 'from:payments'), r.backendCalls.join(', '))
  })
}

Deno.test('método y cuerpo: GET → 405, JSON inválido o no-objeto → 400, sin tocar nada', async () => {
  const r = await run()
  assertEquals(r.get_method.status, 405)
  assertEquals(r.invalid_json.status, 400)
  assertEquals(r.json_array.status, 400)
  for (const s of [r.get_method, r.invalid_json, r.json_array]) assertEquals(s.backendCalls, [])
})
