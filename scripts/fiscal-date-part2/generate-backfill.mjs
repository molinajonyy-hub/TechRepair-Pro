#!/usr/bin/env node
// ============================================================================
// FISCAL DATE Parte 2 — GENERADOR del artefacto de BACKFILL
//
//   node scripts/fiscal-date-part2/generate-backfill.mjs <classification.json> [salida.sql] [--arca <resultados.json>]
//
// GENERA, NO EJECUTA. Escribe un .sql determinístico y lo checksumea. No abre
// conexión a ninguna base: no importa ningún driver ni `docker`, así que no
// tiene camino de ejecución. Aplicar el backfill es una acción de producción
// que el owner NO autorizó.
//
// Es un artefacto SEPARADO del clasificador a propósito: clasificar es sólo
// lectura y se puede repetir sin consecuencias; escribir fecha fiscal es
// irreversible por el trigger de inmutabilidad, y merece su propio paso, su
// propio archivo y su propia revisión humana.
//
// REGLAS DEL SQL GENERADO
//   · Un UPDATE por comprobante, por id. Nunca un UPDATE masivo con JOIN.
//   · Siempre `AND fecha_comprobante_fiscal IS NULL`: idempotente, y no puede
//     pisar una fecha ya persistida ni chocar con el trigger.
//   · Sólo comprobantes con CAE. Nunca toca uno sin autorizar.
//   · Cada fila lleva su PROCEDENCIA en un comentario: de dónde salió la fecha.
//   · PROVABLE_LOCAL usa cbte_fch_probado (día UTC = día civil AR).
//     REQUIRES_ARCA_LOOKUP sólo entra si se pasa --arca con el CbteFch que
//     ARCA reportó. Sin eso, se omite: no se inventa una fecha fiscal.
//   · Va envuelto en BEGIN/COMMIT con un chequeo previo de que la Parte 2 esté
//     aplicada, y un recuento final.
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const argv = process.argv.slice(2)
const manifestPath = argv[0]
if (!manifestPath) {
  console.error('uso: generate-backfill.mjs <classification.json> [salida.sql] [--arca <resultados.json>]')
  process.exit(2)
}
const outPath = argv[1] && !argv[1].startsWith('--') ? argv[1] : 'docs/fiscal-date-part2/backfill.sql'
const arcaIdx = argv.indexOf('--arca')
const arcaPath = arcaIdx >= 0 ? argv[arcaIdx + 1] : null

// Los resultados de ARCA los va a pasar una persona, y en Windows un JSON
// guardado como UTF-8 suele venir con BOM, que JSON.parse rechaza. Se saca.
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''))

const manifest = readJson(manifestPath)

// ── Resultados de ARCA ──────────────────────────────────────────────────────
// SÓLO se acepta la salida del runner (execute-arca-lookup.ts), no un mapa
// pelado { comprobante_id: YYYYMMDD }. Un mapa así no prueba NADA: no dice a
// qué PV+CbteTipo+número+CAE corresponde esa fecha, y `numero_fiscal` por sí
// solo es ambiguo — hay un 0010-00000001 factura y otro nota de crédito.
//
// Cada entrada tiene que traer:
//   · verdict BACKFILLABLE (el runner ya validó identidad contra ARCA)
//   · cae_match === 'match'
//   · PV + CbteTipo + número idénticos a los del manifiesto para ese id
//   · CbteFch con forma YYYYMMDD
// Cualquier otra cosa se descarta con aviso. No se adivina.
const arca = new Map()
const rechazos = []
if (arcaPath) {
  const raw = readJson(arcaPath)
  const resultados = raw?.resultados
  if (!Array.isArray(resultados)) {
    console.error('[backfill] ABORTA: --arca debe ser la salida de execute-arca-lookup.ts (con `resultados`).')
    console.error('           Un mapa { comprobante_id: YYYYMMDD } no prueba la identidad fiscal y no se acepta.')
    process.exit(2)
  }
  for (const r of resultados) {
    const id = r?.comprobante_id
    if (!id) { rechazos.push('entrada sin comprobante_id'); continue }
    if (r.verdict !== 'BACKFILLABLE') { rechazos.push(`${id}: verdict ${r.verdict}`); continue }
    if (r.cae_match !== 'match') { rechazos.push(`${id}: cae_match ${r.cae_match}`); continue }
    if (!/^\d{8}$/.test(String(r.cbte_fch ?? ''))) { rechazos.push(`${id}: CbteFch inválido (${JSON.stringify(r.cbte_fch)})`); continue }
    arca.set(id, r)
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const lineas = []
const omitidos = { sin_fecha_arca: 0, inconsistente: 0, sin_forma: 0, identidad_no_coincide: 0 }
let incluidos = 0

for (const f of manifest.filas) {
  if (f.clase === 'INCONSISTENT') { omitidos.inconsistente++; continue }

  let fecha = null
  let procedencia = null
  if (f.clase === 'PROVABLE_LOCAL') {
    fecha = f.cbte_fch_probado
    procedencia = `probado localmente: ventana [${f.authorized_sent_at} .. ${f.ventana_hasta}] ` +
      'íntegramente post-Parte 1 y con día civil argentino constante'
  } else if (arca.has(f.id)) {
    const r = arca.get(f.id)
    // La identidad del resultado tiene que coincidir con la del manifiesto.
    // El runner ya la validó contra ARCA; acá se revalida contra la base, para
    // que un archivo de resultados de otra corrida no pueda colarse.
    if (Number(r.punto_venta) !== Number(f.pv_fiscal)
      || Number(r.cbte_tipo) !== Number(f.cbte_tipo)
      || Number(r.numero) !== Number(f.nro_fiscal)) {
      omitidos.identidad_no_coincide++
      rechazos.push(`${f.id}: identidad del resultado != manifiesto ` +
        `(plan PV${f.pv_fiscal}/T${f.cbte_tipo}/N${f.nro_fiscal} vs resultado PV${r.punto_venta}/T${r.cbte_tipo}/N${r.numero})`)
      continue
    }
    fecha = r.cbte_fch
    procedencia = `CbteFch informado por ARCA (FECompConsultar), identidad verificada ` +
      `PV${r.punto_venta}/CbteTipo${r.cbte_tipo}/N${r.numero}, CAE ${r.cae_match}`
  } else {
    omitidos.sin_fecha_arca++
    continue
  }

  if (!/^\d{8}$/.test(String(fecha ?? '')) || !UUID.test(f.id)) { omitidos.sin_forma++; continue }

  const iso = `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`
  lineas.push(
    `-- ${f.numero_fiscal} (CbteTipo ${f.cbte_tipo}) · ${procedencia}\n` +
    `UPDATE public.comprobantes SET fecha_comprobante_fiscal = DATE '${iso}'\n` +
    ` WHERE id = '${f.id}'::uuid AND cae IS NOT NULL AND fecha_comprobante_fiscal IS NULL;`)
  incluidos++
}

// Orden determinístico: el mismo manifiesto produce byte por byte el mismo SQL.
lineas.sort()

const sqlOut = `-- ============================================================================
-- FISCAL DATE Parte 2 — BACKFILL de fecha_comprobante_fiscal
--
-- GENERADO por scripts/fiscal-date-part2/generate-backfill.mjs — no editar a mano.
-- NO EJECUTADO. Aplicarlo es una acción de producción que requiere autorización
-- explícita del owner.
--
-- Comprobantes incluidos              : ${incluidos}
-- Omitidos por falta de dato ARCA     : ${omitidos.sin_fecha_arca}
-- Omitidos por INCONSISTENT           : ${omitidos.inconsistente}
-- Omitidos por forma inválida         : ${omitidos.sin_forma}
-- Omitidos por identidad no coincidente: ${omitidos.identidad_no_coincide}
-- Manifiesto (sha256 del SQL)         : ${manifest.sql_sha256}
--
-- Toda fecha de origen remoto pasó por: verdict BACKFILLABLE del runner,
-- cae_match = match, y PV + CbteTipo + número idénticos entre el resultado y
-- el manifiesto. Una fecha sin esa identidad probada NO entra.
--
-- Cada UPDATE es por id, exige CAE y exige que la fecha esté NULL: correrlo dos
-- veces no cambia nada, y no puede pisar una fecha fiscal ya persistida.
-- ============================================================================
BEGIN;

DO $backfill$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='comprobantes'
                    AND column_name='fecha_comprobante_fiscal') THEN
    RAISE EXCEPTION 'la Parte 2 no está aplicada: falta comprobantes.fecha_comprobante_fiscal';
  END IF;
END;
$backfill$;

${lineas.join('\n\n')}

DO $verificacion$
DECLARE v_con int; v_sin int;
BEGIN
  SELECT count(*) FILTER (WHERE fecha_comprobante_fiscal IS NOT NULL),
         count(*) FILTER (WHERE fecha_comprobante_fiscal IS NULL)
    INTO v_con, v_sin
    FROM public.comprobantes WHERE cae IS NOT NULL;
  RAISE NOTICE 'autorizados con fecha fiscal: % · sin fecha fiscal: %', v_con, v_sin;
END;
$verificacion$;

COMMIT;
`

writeFileSync(outPath, sqlOut)
const sha = createHash('sha256').update(sqlOut).digest('hex')

console.log(`[backfill] incluidos                  : ${incluidos}`)
console.log(`[backfill] omitidos (falta dato ARCA) : ${omitidos.sin_fecha_arca}`)
console.log(`[backfill] omitidos (INCONSISTENT)    : ${omitidos.inconsistente}`)
console.log(`[backfill] omitidos (forma inválida)  : ${omitidos.sin_forma}`)
console.log(`[backfill] omitidos (identidad)       : ${omitidos.identidad_no_coincide}`)
if (rechazos.length) {
  console.log(`[backfill] resultados remotos rechazados: ${rechazos.length}`)
  for (const r of rechazos.slice(0, 10)) console.log(`           · ${r}`)
}
console.log(`[backfill] ejecutado                  : NO`)
console.log(`[backfill] salida                     : ${outPath}`)
console.log(`[backfill] sha256(${outPath})         = ${sha}`)
