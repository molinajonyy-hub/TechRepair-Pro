#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env
// ============================================================================
// FISCAL DATE Parte 2 — RUNNER DE EJECUCIÓN de FECompConsultar (SÓLO LECTURA)
//
// CONSTRUIDO. NO EJECUTADO. Correr el lote contra ARCA en producción es una
// acción que el owner tiene que autorizar aparte. Sin `--execute` este script
// no toca la red: imprime el plan verificado y sale.
//
//   # previsualización (sin red)
//   deno run --allow-read --allow-write --allow-net --allow-env \
//     scripts/fiscal-date-part2/execute-arca-lookup.ts \
//     --plan docs/fiscal-date-part2/arca-lookup-plan.json \
//     --sha256 <hex del plan>
//
//   # ejecución real (requiere autorización explícita del owner)
//   ... --execute --out docs/fiscal-date-part2/arca-lookup-results.json
//
// ── POR QUÉ ES ESTRUCTURALMENTE DE SÓLO LECTURA ─────────────────────────────
// No habla con ARCA directamente: llama a la Edge function ya desplegada y ya
// certificada `afip-fe-query`, que soporta EXACTAMENTE dos operaciones, las dos
// de lectura (`ultimo_autorizado` y `consultar`), no importa afip-cae/logic.ts
// y por lo tanto no puede construir FECAESolicitar
// (ver scripts/guards/afip-query-readonly.mjs).
//
// Consecuencias, todas deliberadas:
//   · este runner NUNCA ve el token/sign de WSAA — los resuelve la Edge desde
//     Vault, del lado del servidor. Acá no hay credencial de ARCA que filtrar.
//   · no importa NADA de afip-cae: no hay builder de FECAESolicitar en su grafo
//     de imports.
//   · no crea cliente de base con service_role y no escribe ninguna fila: el
//     único uso de Supabase es iniciar sesión como el owner, que es auth, no
//     una mutación de datos.
//   · el negocio lo resuelve la Edge desde el PERFIL del usuario autenticado,
//     así que no hay business_id que falsificar desde acá.
//
// ── CREDENCIALES ────────────────────────────────────────────────────────────
// Nunca por argv, nunca en el código, nunca en el log. Dos caminos:
//   · prompt local con eco apagado (por defecto);
//   · FDP2_OWNER_ACCESS_TOKEN, si el owner ya tiene un access token.
// Ni el token ni la contraseña se imprimen ni se guardan en la salida.
// ============================================================================
// supabase-js se importa DINÁMICAMENTE, y sólo en el camino de login. Así la
// previsualización (sin --execute) no necesita red ni para resolver módulos:
// verifica el plan y sale.
import { evaluateLookup, type ArcaConsultaResult, type PlanEntry } from './arcaLookupIdentity.ts'

// ── Constantes de producción, fijadas en el código ──────────────────────────
// El runner sólo puede apuntar a este proyecto y a este negocio. Un plan que
// mencione otro business_id se rechaza entero: no se filtra en silencio.
const PROJECT_REF = 'vrdxxmjzxhfgqlnxmbwx'
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`
const BUSINESS_ID = 'aa930802-0861-46ce-896c-7f68b181cb39'
const FUNCTION = 'afip-fe-query'
/** La ÚNICA operación que este runner puede pedir. */
const OPERACION = 'consultar' as const
/** Tope duro de requests, independiente de lo que diga el plan. */
const MAX_REQUESTS = 200
/** Espaciado secuencial. Sin paralelismo, sin ráfagas. */
const DELAY_MS = 1200

const args = Deno.args
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string) => args.includes(`--${name}`)

const planPath = flag('plan')
const expectedSha = flag('sha256')
const outPath = flag('out') ?? 'docs/fiscal-date-part2/arca-lookup-results.json'
const execute = has('execute')

if (!planPath || !expectedSha) {
  console.error('uso: execute-arca-lookup.ts --plan <plan.json> --sha256 <hex> [--execute] [--out <file>]')
  console.error('     el plan y su SHA-256 son OBLIGATORIOS: sin los dos no se toca la red.')
  Deno.exit(2)
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // Se copia la vista a un ArrayBuffer propio: `Uint8Array<ArrayBufferLike>` no
  // es asignable a `BufferSource`, y además así el hash cubre EXACTAMENTE los
  // bytes de la vista, sin arrastrar el resto del buffer subyacente.
  const exacto = bytes.slice().buffer as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', exacto)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── 1. Verificar el plan ANTES de cualquier acceso a red ────────────────────
const planBytes = await Deno.readFile(planPath)
const actualSha = await sha256Hex(planBytes)
if (actualSha !== expectedSha.trim().toLowerCase()) {
  console.error('[runner] ABORTA: el SHA-256 del plan no coincide.')
  console.error(`         esperado: ${expectedSha}`)
  console.error(`         real    : ${actualSha}`)
  console.error('         un plan modificado no se ejecuta: regeneralo y revisalo de nuevo.')
  Deno.exit(1)
}

const plan = JSON.parse(new TextDecoder().decode(planBytes))
if (plan.operacion_unica !== 'FECompConsultar') {
  console.error(`[runner] ABORTA: el plan declara la operación "${plan.operacion_unica}", y sólo se admite FECompConsultar.`)
  Deno.exit(1)
}
const consultas = plan.consultas
if (!Array.isArray(consultas) || consultas.length === 0) {
  console.error('[runner] ABORTA: el plan no tiene consultas.')
  Deno.exit(1)
}
if (consultas.length > MAX_REQUESTS) {
  console.error(`[runner] ABORTA: ${consultas.length} consultas supera el tope duro de ${MAX_REQUESTS}.`)
  Deno.exit(1)
}
const ajenas = consultas.filter((c: PlanEntry) => c.business_id !== BUSINESS_ID)
if (ajenas.length) {
  console.error(`[runner] ABORTA: ${ajenas.length} entrada(s) del plan no pertenecen al negocio fijado ${BUSINESS_ID}.`)
  Deno.exit(1)
}
for (const c of consultas as PlanEntry[]) {
  if (!(Number(c.punto_venta) > 0 && Number(c.cbte_tipo) > 0 && Number(c.numero) > 0)) {
    console.error(`[runner] ABORTA: entrada con clave fiscal incompleta: ${JSON.stringify(c)}`)
    Deno.exit(1)
  }
}

console.log(`[runner] plan            : ${planPath}`)
console.log(`[runner] sha256 verificado: ${actualSha}`)
console.log(`[runner] proyecto        : ${PROJECT_REF} (fijado en código)`)
console.log(`[runner] negocio         : ${BUSINESS_ID} (fijado en código)`)
console.log(`[runner] operación       : FECompConsultar vía ${FUNCTION} (única posible)`)
console.log(`[runner] consultas       : ${consultas.length} (tope ${MAX_REQUESTS})`)
console.log(`[runner] espaciado       : ${DELAY_MS} ms, secuencial`)
console.log(`[runner] ejecutar        : ${execute ? 'SÍ' : 'NO (previsualización, no toca la red)'}`)

if (!execute) {
  console.log('[runner] previsualización terminada. Con --execute se consultaría ARCA en modo lectura.')
  Deno.exit(0)
}

// ── 2. Sesión del owner, sin credenciales en argv/código/log ────────────────
async function leerOculto(etiqueta: string): Promise<string> {
  await Deno.stdout.write(new TextEncoder().encode(etiqueta))
  Deno.stdin.setRaw(true)
  const bytes: number[] = []
  const buf = new Uint8Array(1)
  while (true) {
    const n = await Deno.stdin.read(buf)
    if (n === null) break
    const b = buf[0]
    if (b === 13 || b === 10) break
    if (b === 3) { Deno.stdin.setRaw(false); console.error('\n[runner] cancelado'); Deno.exit(130) }
    if (b === 127 || b === 8) { bytes.pop(); continue }
    bytes.push(b)
  }
  Deno.stdin.setRaw(false)
  await Deno.stdout.write(new TextEncoder().encode('\n'))
  return new TextDecoder().decode(new Uint8Array(bytes))
}

const anonKey = Deno.env.get('FDP2_SUPABASE_ANON_KEY')
if (!anonKey) {
  console.error('[runner] falta FDP2_SUPABASE_ANON_KEY (clave pública del proyecto).')
  Deno.exit(2)
}

let accessToken = Deno.env.get('FDP2_OWNER_ACCESS_TOKEN') ?? ''
if (!accessToken) {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
  const sb = createClient(SUPABASE_URL, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const email = await leerOculto('email del owner: ')
  const password = await leerOculto('contraseña (no se muestra): ')
  const { data, error } = await sb.auth.signInWithPassword({ email, password })
  if (error || !data.session?.access_token) {
    // El mensaje de error de auth puede traer el email; se reporta genérico.
    console.error('[runner] no se pudo iniciar sesión como owner.')
    Deno.exit(1)
  }
  accessToken = data.session.access_token
}

// ── 3. Consultas SECUENCIALES, sin reintento ciego ──────────────────────────
const resultados: unknown[] = []
let backfillables = 0, revisar = 0, requests = 0

for (const [i, c] of (consultas as PlanEntry[]).entries()) {
  if (requests >= MAX_REQUESTS) {
    console.error(`[runner] tope de ${MAX_REQUESTS} requests alcanzado; se corta.`)
    break
  }
  if (i > 0) await new Promise((r) => setTimeout(r, DELAY_MS))

  let arca: ArcaConsultaResult | null = null
  let transporte: string | null = null
  try {
    requests++
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${FUNCTION}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        operacion: OPERACION,
        punto_venta: c.punto_venta,
        tipo_comprobante: c.cbte_tipo,
        numero: c.numero,
      }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      transporte = `HTTP ${res.status}`
    } else {
      // El endpoint devuelve la ConsultaResult anidada o plana según operación;
      // se acepta cualquiera de las dos formas sin inventar campos.
      arca = (body?.consulta ?? body?.resultado ?? body) as ArcaConsultaResult
    }
  } catch (e) {
    // Timeout / red ambigua: NO se reintenta. Un resultado ambiguo se registra
    // como ambiguo; repetir a ciegas no agrega certeza y sí agrega carga.
    transporte = `red: ${String((e as Error)?.message ?? e).slice(0, 120)}`
  }

  const evaluacion = evaluateLookup(c, arca)
  if (transporte) {
    evaluacion.verdict = 'REVIEW_REQUIRED'
    evaluacion.problemas.unshift(`resultado ambiguo de transporte (${transporte})`)
    evaluacion.cbte_fch = undefined
  }
  if (evaluacion.verdict === 'BACKFILLABLE') backfillables++; else revisar++

  // Salida SANITIZADA: identidad fiscal y veredicto. Ni token, ni sign, ni
  // Authorization, ni cuerpo crudo de ARCA.
  resultados.push({
    comprobante_id: c.comprobante_id,
    business_id: c.business_id,
    punto_venta: c.punto_venta,
    cbte_tipo: c.cbte_tipo,
    numero: c.numero,
    arca_status: evaluacion.checks.status,
    cbte_fch: evaluacion.cbte_fch ?? null,
    cae_match: evaluacion.checks.cae,
    importe_match: evaluacion.checks.importe,
    punto_venta_match: evaluacion.checks.punto_venta,
    cbte_tipo_match: evaluacion.checks.cbte_tipo,
    numero_match: evaluacion.checks.numero,
    cbte_fch_shape: evaluacion.checks.cbte_fch,
    verdict: evaluacion.verdict,
    problemas: evaluacion.problemas,
  })
  console.log(`[runner] ${i + 1}/${consultas.length} PV${c.punto_venta}-T${c.cbte_tipo}-N${c.numero} -> ${evaluacion.verdict}`)
}

const salida = {
  generado_en: new Date().toISOString(),
  plan_sha256: actualSha,
  operacion_unica: 'FECompConsultar',
  proyecto: PROJECT_REF,
  business_id: BUSINESS_ID,
  requests_realizados: requests,
  backfillables,
  review_required: revisar,
  resultados,
}
await Deno.writeTextFile(outPath, JSON.stringify(salida, null, 2))
console.log(`[runner] requests        : ${requests}`)
console.log(`[runner] BACKFILLABLE    : ${backfillables}`)
console.log(`[runner] REVIEW_REQUIRED : ${revisar}`)
console.log(`[runner] salida          : ${outPath} (sanitizada)`)
