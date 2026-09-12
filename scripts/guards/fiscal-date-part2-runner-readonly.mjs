#!/usr/bin/env node
// ============================================================================
// FISCAL DATE Parte 2 — guard: el runner de lookup es de SÓLO LECTURA
//
//   node scripts/guards/fiscal-date-part2-runner-readonly.mjs
//   node scripts/guards/fiscal-date-part2-runner-readonly.mjs --self-test
//
// Prueba ESTRUCTURALMENTE que scripts/fiscal-date-part2/execute-arca-lookup.ts
// —y todo su grafo de imports locales— no puede:
//
//   G1. emitir: FECAESolicitar / buildFECAESolicitarSOAP / solicitarCAEConReconciliacion
//   G2. reservar numeración: reserve_arca_number / claim_comprobante_arca_emission
//   G3. completar un intento: complete_arca_attempt / mark_arca_attempt_sent
//   G4. escribir en la base: .insert( / .update( / .delete( / .upsert( / .rpc(
//   G5. importar nada de afip-cae (arrastraría el builder de emisión)
//   G6. usar service_role
//   G7. pedir otra operación que `consultar`
//
// No alcanza con leer el archivo del runner: se resuelve el grafo de imports
// LOCALES y se revisa cada archivo. Un import indirecto a afip-cae/logic.ts
// metería buildFECAESolicitarSOAP en el bundle aunque el runner no lo nombre.
// ============================================================================
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'

const ENTRY = 'scripts/fiscal-date-part2/execute-arca-lookup.ts'

/**
 * Saca SÓLO los comentarios y conserva los literales.
 *
 * Los comentarios tienen que irse: este guard documenta en prosa justamente lo
 * que prohíbe ("no usa service_role", "no importa afip-cae"), y leerlos daría
 * falsos positivos sobre el archivo correcto.
 *
 * Los literales se CONSERVAN, y eso es deliberado: las formas reales de violar
 * las reglas son strings. `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`, el
 * especificador de un import, un header 'SOAPAction' con FECAESolicitar. Si se
 * blanquearan, el guard pasaría por alto exactamente el caso que busca — lo
 * comprobé: el mutante de service_role se escapaba.
 */
function despojar(src) {
  let out = '', i = 0
  while (i < src.length) {
    if (src.startsWith('//', i)) { const f = src.indexOf('\n', i); const e = f === -1 ? src.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (src.startsWith('/*', i)) { const f = src.indexOf('*/', i + 2); const e = f === -1 ? src.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += src[i]; i++
  }
  return out
}

const REGLAS = [
  { id: 'G1', re: /\b(FECAESolicitar|buildFECAESolicitarSOAP|solicitarCAEConReconciliacion)\b/, msg: 'puede alcanzar la emisión fiscal' },
  { id: 'G2', re: /\b(reserve_arca_number|claim_comprobante_arca_emission)\b/, msg: 'puede reservar numeración o tomar un claim' },
  { id: 'G3', re: /\b(complete_arca_attempt|mark_arca_attempt_sent)\b/, msg: 'puede completar o marcar un intento' },
  { id: 'G4', re: /\.\s*(insert|update|delete|upsert|rpc)\s*\(/, msg: 'tiene un camino de escritura a la base' },
  { id: 'G5', re: /from\s+['"][^'"]*afip-cae[^'"]*['"]/, msg: 'importa afip-cae (arrastra el builder de emisión)' },
  { id: 'G6', re: /SERVICE_ROLE|service_role/, msg: 'usa service_role' },
]

/** Resuelve el grafo de imports LOCALES (los remotos no pueden tocar nuestra DB). */
function grafoLocal(entry) {
  const vistos = new Set()
  const pendientes = [entry]
  while (pendientes.length) {
    const f = pendientes.pop()
    if (vistos.has(f) || !existsSync(f)) continue
    vistos.add(f)
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue
      pendientes.push(relative(process.cwd(), resolve(dirname(f), spec)).replace(/\\/g, '/'))
    }
  }
  return [...vistos]
}

function revisar(entry) {
  const hallazgos = []
  const archivos = grafoLocal(entry)
  if (!archivos.length) return { hallazgos: [`no se pudo leer ${entry}`], archivos }

  for (const f of archivos) {
    const codigo = despojar(readFileSync(f, 'utf8'))
    for (const r of REGLAS) {
      if (r.re.test(codigo)) hallazgos.push(`${r.id} ${f}: ${r.msg}`)
    }
  }

  // G7: la operación pedida. Dos chequeos, porque uno solo se escapa:
  //   a) la constante tiene que ser exactamente 'consultar' — atrapa que
  //      alguien la cambie por otra operación;
  //   b) el body no puede mandar un string literal como `operacion` — atrapa
  //      que alguien puentee la constante con un valor pegado a mano.
  // OJO: nada de lookaheads sobre `operacion:\s*`; con `\s*` en cero ancho el
  // lookahead se evalúa contra el espacio y da falso positivo sobre el propio
  // `operacion: OPERACION`.
  const entrySrc = readFileSync(entry, 'utf8')
  if (!/const\s+OPERACION\s*=\s*'consultar'\s+as\s+const/.test(entrySrc)) {
    hallazgos.push(`G7 ${entry}: la operación única no es exactamente 'consultar'`)
  }
  if (/operacion:\s*['"]/.test(entrySrc)) {
    hallazgos.push(`G7 ${entry}: manda un literal como operación en vez de la constante`)
  }
  return { hallazgos, archivos }
}

// ── Self-test: cada regla tiene que atrapar una violación plantada ──────────
if (process.argv.includes('--self-test')) {
  const dir = mkdtempSync(resolve(tmpdir(), 'fdp2guard-'))
  const base = readFileSync(ENTRY, 'utf8')
  const casos = [
    ['G1 emisión', base.replace('const OPERACION', 'const x = buildFECAESolicitarSOAP\nconst OPERACION')],
    ['G2 reserva', base.replace('const OPERACION', 'const x = reserve_arca_number\nconst OPERACION')],
    ['G3 completar', base.replace('const OPERACION', 'const x = complete_arca_attempt\nconst OPERACION')],
    ['G4 escritura', base.replace('const OPERACION', 'const x = sb.from("comprobantes").update({})\nconst OPERACION')],
    ['G6 service_role', base.replace('const OPERACION', 'const k = Deno.env.get("SERVICE_ROLE")\nconst OPERACION')],
    ['G7a constante cambiada', base.replace("const OPERACION = 'consultar' as const", "const OPERACION = 'emitir' as const")],
    ['G7b literal pegado a mano', base.replace('operacion: OPERACION,', "operacion: 'emitir',")],
  ]
  let ok = 0
  for (const [nombre, contenido] of casos) {
    const f = resolve(dir, 'mutante.ts')
    writeFileSync(f, contenido)
    const { hallazgos } = revisar(relative(process.cwd(), f).replace(/\\/g, '/'))
    if (hallazgos.length) { console.log(`  PASS  self-test atrapa ${nombre}`); ok++ }
    else console.error(`  FAIL  self-test NO atrapa ${nombre}`)
  }
  // Control positivo: el runner real tiene que pasar.
  const real = revisar(ENTRY)
  if (real.hallazgos.length === 0) { console.log('  PASS  el runner real pasa (control positivo)'); ok++ }
  else { console.error('  FAIL  el runner real no pasa:', real.hallazgos); }
  const total = casos.length + 1
  console.log(`Self-test: ${ok}/${total}`)
  process.exit(ok === total ? 0 : 1)
}

const { hallazgos, archivos } = revisar(ENTRY)
console.log(`[guard] grafo local revisado (${archivos.length} archivo(s)):`)
for (const f of archivos) console.log(`         · ${f}`)
if (hallazgos.length) {
  console.error(`[guard] FALLO: el runner NO es de sólo lectura (${hallazgos.length} hallazgo(s)):`)
  for (const h of hallazgos) console.error(`         ${h}`)
  process.exit(1)
}
console.log('[guard] OK: sin emisión, sin reserva, sin completado, sin escritura a la base, sin service_role, operación única consultar.')
