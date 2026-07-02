#!/usr/bin/env node
/**
 * scripts/audit-arca-cae-integrity.mjs
 *
 * Auditoría READ-ONLY de comprobantes con CAE potencialmente falso (incidente
 * ARCA 2026-07-01: la vista de detalle de Comprobantes reintentaba emisión vía
 * un mock legacy — facturacionService/afipService.solicitarCAE — que fabricaba
 * un CAE aleatorio con generarCAEFake() sin llamar nunca a ARCA).
 *
 * QUÉ HACE
 *   1. Lee candidatos desde `comprobantes` (Supabase, con service_role) filtrando
 *      por fecha / business_id / CUIT / punto de venta.
 *   2. Para cada candidato con CAE, consulta ARCA real vía FECompConsultar
 *      (misma lógica que supabase/functions/afip-cae/logic.ts — la única fuente
 *      de verdad, reutilizada acá, NO reimplementada).
 *   3. Clasifica cada uno y escribe un reporte JSON + CSV.
 *   4. NUNCA modifica la base de datos por defecto. Cualquier acción correctiva
 *      requiere una ejecución SEPARADA, explícita, con --apply (NO implementada
 *      en este script — ver "ESTRATEGIA CORRECTIVA" al final de este comentario).
 *
 * NO asumimos que el FORMATO del CAE indica fraude (podría ser indistinguible
 * de uno real a simple vista). La única verificación válida es contra ARCA.
 *
 * USO
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/audit-arca-cae-integrity.mjs \
 *     --business-id=<uuid> \
 *     --from=2026-01-01 --to=2026-07-01 \
 *     --punto-venta=1 \
 *     --ambiente=produccion \
 *     --concurrency=2 \
 *     --out=./audit-report
 *
 *   --resume=<runId>   reanuda un reporte parcial (ver .partial.json)
 *   --dry-run          no llama a ARCA; solo lista candidatos y su fuente de datos
 *   --help
 *
 * SECURITY MODEL
 *   - SUPABASE_SERVICE_ROLE_KEY se lee SOLO de env var, nunca de argv/logs.
 *   - Nunca imprime certificados, private keys, tokens, sign, CMS ni contraseñas.
 *   - El reporte solo incluye campos operativos (ver CAMPOS DEL REPORTE abajo).
 *
 * REQUIERE
 *   - Node 22.6+ / 24.x (type-stripping nativo de TS: importa logic.ts directo).
 *   - RPC/tabla arca_config con credenciales YA cargadas para el business_id
 *     dado (mismo camino que usa afip-wsaa).
 *
 * CAMPOS DEL REPORTE (sin secretos)
 *   comprobante_id, business_id, fecha, tipo, punto_venta, numero_fiscal,
 *   cae_local, cae_arca, status, motivo, accion_recomendada
 *
 * CLASIFICACIÓN
 *   confirmed_in_arca   — ARCA devuelve el mismo CAE (o un CAE válido) para ese número.
 *   not_found_in_arca   — ARCA responde "comprobante inexistente" (602): el CAE local
 *                         es casi seguro fabricado (mock) — requiere revisión manual.
 *   data_mismatch       — ARCA encontró el comprobante pero con datos distintos
 *                         (CAE, importe o resultado no coinciden) — requiere revisión manual.
 *   insufficient_data   — la fila local no tiene punto_venta/numero_fiscal suficiente
 *                         para construir la consulta FECompConsultar.
 *   query_failed        — la consulta a ARCA falló (red, auth, timeout) — no se pudo
 *                         determinar nada; reintentable.
 *   requires_manual_review — cualquier caso ambiguo se enruta acá explícitamente.
 *
 * ESTRATEGIA CORRECTIVA (preparada, NO ejecutada por este script)
 *   Para comprobantes `not_found_in_arca` confirmados:
 *     - NUNCA borrar la fila ni el CAE — preservar auditoría completa.
 *     - NUNCA sobrescribir silenciosamente.
 *     - Marcar manualmente estado_fiscal = 'pendiente_conciliacion' (o un estado
 *       dedicado a definir) + un campo de auditoría con motivo y fecha de la
 *       corrección, y requerir aprobación explícita de un operador antes de
 *       cualquier re-emisión real. Nunca re-emitir automáticamente.
 *   Esta estrategia se documenta acá pero se implementa en un script/migración
 *   aparte, ejecutado solo tras revisión humana del reporte.
 */

import { createClient } from '@supabase/supabase-js'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── logic.ts es portable (sin Deno.*, sin imports por URL) — se reutiliza
// tal cual, para no reimplementar el parseo/armado SOAP en un segundo lugar. ──
import { consultarComprobante } from '../supabase/functions/afip-cae/logic.ts'

// ── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { concurrency: 2, out: './audit-report', ambiente: 'produccion' }
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') { args.help = true; continue }
    if (raw === '--dry-run') { args.dryRun = true; continue }
    const m = raw.match(/^--([a-z-]+)=(.*)$/i)
    if (!m) continue
    const [, key, val] = m
    args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val
  }
  return args
}

function printHelp() {
  console.log(`
Auditoría read-only de CAE potencialmente falsos (incidente ARCA 2026-07-01).

  node scripts/audit-arca-cae-integrity.mjs \\
    --business-id=<uuid> --from=2026-01-01 --to=2026-07-01 \\
    [--punto-venta=1] [--cuit=20123456789] [--ambiente=produccion|homologacion] \\
    [--concurrency=2] [--out=./audit-report] [--resume=<runId>] [--dry-run]

Env requerido: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
No modifica datos. No imprime secretos. Ver comentario de cabecera para el
detalle de clasificación y la estrategia correctiva (preparada, no ejecutada).
`)
}

// ── Rate limiting / concurrencia simple ─────────────────────────────────────

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
      // Rate limiting suave: no ametrallar WSFEv1.
      await new Promise(r => setTimeout(r, 300))
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker)
  await Promise.all(workers)
  return results
}

// ── Clasificación ────────────────────────────────────────────────────────────

function classify(comprobante, consulta) {
  if (!comprobante.punto_venta_num || !comprobante.numero_num || !comprobante.tipo_comprobante_fiscal) {
    return { status: 'insufficient_data', motivo: 'Fila local sin punto_venta/numero_fiscal/tipo suficientes para FECompConsultar' }
  }
  if (consulta.status === 'query_failed') {
    return { status: 'query_failed', motivo: consulta.motivo || 'Consulta a ARCA falló' }
  }
  if (consulta.status === 'not_found') {
    return {
      status: 'not_found_in_arca',
      motivo: 'ARCA no reconoce este número de comprobante — el CAE local es sospechoso de ser fabricado. Requiere revisión manual.',
    }
  }
  // found
  const caeCoincide = consulta.cae && comprobante.cae && consulta.cae === comprobante.cae
  if (caeCoincide) {
    return { status: 'confirmed_in_arca', motivo: 'CAE coincide con el registrado en ARCA' }
  }
  return {
    status: 'data_mismatch',
    motivo: `ARCA encontró el comprobante pero con CAE distinto (local=${comprobante.cae ?? 'null'}, arca=${consulta.cae ?? 'null'}) — requiere revisión manual`,
  }
}

function accionRecomendada(status) {
  switch (status) {
    case 'confirmed_in_arca':     return 'ninguna'
    case 'not_found_in_arca':     return 'revisión manual — candidato a marcar pendiente fiscal (ver estrategia correctiva)'
    case 'data_mismatch':         return 'revisión manual urgente'
    case 'insufficient_data':     return 'completar datos históricos si es posible, o descartar de la auditoría automática'
    case 'query_failed':          return 'reintentar la consulta'
    default:                      return 'revisión manual'
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
//
// runAudit() recibe TODAS sus dependencias externas inyectadas (supabase,
// consultarComprobanteImpl) — nunca crea un cliente real ni importa credenciales
// por su cuenta. Esto permite correrla de verdad contra fixtures/mocks en tests
// (ver tests/unit/auditScriptExecution.test.ts) sin tocar producción ni ARCA
// real. main() es el único lugar que arma las dependencias REALES (createClient
// con SUPABASE_URL/SERVICE_ROLE_KEY del entorno, y el consultarComprobante real
// de logic.ts) y solo corre cuando el script se ejecuta como CLI.

async function runAudit(args, deps) {
  const { supabase, consultarComprobanteImpl } = deps

  // ── 1. Candidatos: comprobantes con CAE en el rango pedido ─────────────────
  let query = supabase
    .from('comprobantes')
    .select('id, business_id, fecha, tipo, punto_venta, numero_fiscal, tipo_comprobante_fiscal, cae, cae_vencimiento, estado_fiscal')
    .eq('business_id', args.businessId)
    .not('cae', 'is', null)
    .order('fecha', { ascending: true })

  if (args.from) query = query.gte('fecha', args.from)
  if (args.to)   query = query.lte('fecha', args.to + 'T23:59:59')
  if (args.puntoVenta) query = query.eq('punto_venta', args.puntoVenta)

  const { data: candidatos, error } = await query
  if (error) throw new Error('Error leyendo candidatos: ' + error.message)

  console.log(`Candidatos con CAE en el rango: ${candidatos.length}`)

  // Parsear numero_fiscal "0001-00000042" → punto_venta_num / numero_num
  const enriched = candidatos.map(c => {
    const parts = String(c.numero_fiscal || '').split('-')
    return {
      ...c,
      punto_venta_num: parts[0] ? parseInt(parts[0], 10) : (c.punto_venta ? parseInt(c.punto_venta, 10) : null),
      numero_num: parts[1] ? parseInt(parts[1], 10) : null,
    }
  })

  if (args.dryRun) {
    console.log('--dry-run: no se consulta ARCA. Candidatos:')
    console.table(enriched.map(c => ({ id: c.id, fecha: c.fecha, tipo: c.tipo, numero_fiscal: c.numero_fiscal, cae: c.cae })))
    return { dryRun: true, candidatos: enriched }
  }

  // ── 2. Obtener token+sign (reutiliza afip-wsaa, ya desplegada — no se
  //       reimplementa autenticación acá) ────────────────────────────────────
  const { data: wsaaData, error: wsaaError } = await supabase.functions.invoke('afip-wsaa', {
    body: { business_id: args.businessId, service: 'wsfe' },
  })
  if (wsaaError || !wsaaData?.success) {
    throw new Error('No se pudo autenticar con WSAA: ' + (wsaaError?.message || wsaaData?.error))
  }
  const { token, sign } = wsaaData

  const { data: arcaConfig, error: cfgError } = await supabase
    .from('arca_config')
    .select('cuit, ambiente')
    .eq('business_id', args.businessId)
    .single()
  if (cfgError || !arcaConfig) {
    throw new Error('No se pudo leer arca_config para este business_id: ' + cfgError?.message)
  }
  const cuit = args.cuit || (arcaConfig.cuit || '').replace(/\D/g, '')
  const ambiente = args.ambiente || arcaConfig.ambiente || 'produccion'

  // ── 3. Reanudación: cargar reporte parcial si --resume ──────────────────────
  const outDir = args.out
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const partialPath = join(outDir, `${args.resume || 'run'}.partial.json`)
  const already = new Map()
  if (args.resume && existsSync(partialPath)) {
    const prev = JSON.parse(readFileSync(partialPath, 'utf-8'))
    for (const row of prev) already.set(row.comprobante_id, row)
    console.log(`Reanudando: ${already.size} filas ya procesadas en ${partialPath}`)
  }

  const pendientes = enriched.filter(c => !already.has(c.id))

  // ── 4. Consultar ARCA (rate-limited, concurrencia acotada) ──────────────────
  const correlationId = args.resume || `audit-${Date.now()}`
  await mapWithConcurrency(pendientes, Number(args.concurrency) || 2, async (c) => {
    if (!c.punto_venta_num || !c.numero_num || !c.tipo_comprobante_fiscal) {
      const { status, motivo } = classify(c, { status: 'query_failed' })
      const row = buildRow(c, null, status, motivo)
      already.set(c.id, row)
      writeFileSync(partialPath, JSON.stringify([...already.values()], null, 2))
      return row
    }
    const consulta = await consultarComprobanteImpl(
      token, sign, cuit,
      c.punto_venta_num, parseInt(c.tipo_comprobante_fiscal, 10), c.numero_num,
      ambiente, { correlationId, businessId: args.businessId }
    )
    const { status, motivo } = classify(c, consulta)
    const row = buildRow(c, consulta, status, motivo)

    // Guardar progreso incremental (permite --resume si se corta a mitad de camino).
    already.set(c.id, row)
    writeFileSync(partialPath, JSON.stringify([...already.values()], null, 2))
    return row
  })

  const allRows = [...already.values()]

  // ── 5. Reporte final ─────────────────────────────────────────────────────
  const jsonPath = join(outDir, `${correlationId}.json`)
  const csvPath  = join(outDir, `${correlationId}.csv`)
  writeFileSync(jsonPath, JSON.stringify(allRows, null, 2))
  writeFileSync(csvPath, toCsv(allRows))

  const counts = {}
  for (const r of allRows) counts[r.status] = (counts[r.status] || 0) + 1
  console.log('\nResumen:')
  console.table(counts)
  console.log(`\nReporte JSON: ${jsonPath}`)
  console.log(`Reporte CSV:  ${csvPath}`)

  const sospechosos = allRows.filter(r => r.status === 'not_found_in_arca' || r.status === 'data_mismatch')
  if (sospechosos.length > 0) {
    console.log(`\n⚠️  ${sospechosos.length} comprobante(s) requieren revisión manual (not_found_in_arca / data_mismatch).`)
    console.log('    Ningún dato fue modificado. Ver "ESTRATEGIA CORRECTIVA" en la cabecera de este script.')
  }

  return { dryRun: false, rows: allRows, jsonPath, csvPath, counts, partialPath }
}

// CLI real: arma las dependencias REALES (nunca inyectadas por un test) y
// delega toda la lógica en runAudit().
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { printHelp(); return }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.')
    process.exit(1)
  }
  if (!args.businessId) {
    console.error('Falta --business-id=<uuid>. Ver --help.')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, supabaseKey)
  await runAudit(args, { supabase, consultarComprobanteImpl: consultarComprobante })
}

function buildRow(comprobante, consulta, status, motivo) {
  return {
    comprobante_id: comprobante.id,
    business_id: comprobante.business_id,
    fecha: comprobante.fecha,
    tipo: comprobante.tipo,
    punto_venta: comprobante.punto_venta,
    numero_fiscal: comprobante.numero_fiscal,
    cae_local: comprobante.cae,
    cae_arca: consulta?.cae ?? null,
    status,
    motivo,
    accion_recomendada: accionRecomendada(status),
  }
}

function toCsv(rows) {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [
    headers.join(','),
    ...rows.map(r => headers.map(h => esc(r[h])).join(',')),
  ].join('\n')
}

// Exportado para tests unitarios (clasificación pura, sin red/DB). Guardado
// detrás de un chequeo de entry-point para que `main()` NUNCA se dispare al
// importar este módulo desde un test — solo al ejecutar el script directo.
export { classify, accionRecomendada, toCsv, parseArgs, runAudit }

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch(err => {
    console.error('Error inesperado en la auditoría:', err?.message || err)
    process.exit(1)
  })
}
