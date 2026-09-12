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

// Resultados de ARCA: { "<comprobante_id>": "YYYYMMDD" }. Se valida la forma:
// cualquier cosa que no sea YYYYMMDD se descarta, no se "arregla".
let arca = {}
if (arcaPath) {
  const raw = readJson(arcaPath)
  for (const [id, fecha] of Object.entries(raw)) {
    if (/^\d{8}$/.test(String(fecha))) arca[id] = String(fecha)
    else console.error(`[backfill] descartado: ${id} trae un CbteFch sin forma YYYYMMDD (${JSON.stringify(fecha)})`)
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const lineas = []
const omitidos = { sin_fecha_arca: 0, inconsistente: 0, sin_forma: 0 }
let incluidos = 0

for (const f of manifest.filas) {
  if (f.clase === 'INCONSISTENT') { omitidos.inconsistente++; continue }

  let fecha = null
  let procedencia = null
  if (f.clase === 'PROVABLE_LOCAL') {
    fecha = f.cbte_fch_probado
    procedencia = `día UTC = día civil AR en sent_at ${f.sent_at_utc}`
  } else if (arca[f.id]) {
    fecha = arca[f.id]
    procedencia = 'CbteFch reportado por ARCA en FECompConsultar'
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
-- Comprobantes incluidos           : ${incluidos}
-- Omitidos por falta de dato ARCA  : ${omitidos.sin_fecha_arca}
-- Omitidos por INCONSISTENT        : ${omitidos.inconsistente}
-- Omitidos por forma inválida      : ${omitidos.sin_forma}
-- Manifiesto (sha256 del SQL)      : ${manifest.sql_sha256}
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
console.log(`[backfill] ejecutado                  : NO`)
console.log(`[backfill] salida                     : ${outPath}`)
console.log(`[backfill] sha256(${outPath})         = ${sha}`)
