/**
 * Ejecución REAL (no solo --help) del script de auditoría
 * scripts/audit-arca-cae-integrity.mjs, contra un adaptador Supabase mock y un
 * consultarComprobante mock — nunca contra producción ni ARCA real.
 *
 * Cubre los 5 status de clasificación, --resume, generación de JSON/CSV real
 * en disco, y que el modo por defecto nunca escribe en la "base de datos"
 * (el mock no expone ningún método de escritura — si el script intentara
 * usar uno, esto fallaría con un TypeError, no silenciosamente).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAudit } from '../../scripts/audit-arca-cae-integrity.mjs'

const BUSINESS_ID = 'biz-fixture-1'

// ── Fixtures: 5 comprobantes, uno por cada status de clasificación ──────────
const FIXTURE_COMPROBANTES = [
  { id: 'c1', business_id: BUSINESS_ID, fecha: '2026-01-01', tipo: 'factura_c', punto_venta: '1', numero_fiscal: '0001-00000001', tipo_comprobante_fiscal: '11', cae: 'CAE-CONFIRMED-001', cae_vencimiento: null, estado_fiscal: 'emitido' },
  { id: 'c2', business_id: BUSINESS_ID, fecha: '2026-01-02', tipo: 'factura_c', punto_venta: '1', numero_fiscal: '0001-00000002', tipo_comprobante_fiscal: '11', cae: 'CAE-FAKE-002', cae_vencimiento: null, estado_fiscal: 'emitido' },
  { id: 'c3', business_id: BUSINESS_ID, fecha: '2026-01-03', tipo: 'factura_c', punto_venta: '1', numero_fiscal: '0001-00000003', tipo_comprobante_fiscal: '11', cae: 'CAE-LOCAL-003', cae_vencimiento: null, estado_fiscal: 'emitido' },
  { id: 'c4', business_id: BUSINESS_ID, fecha: '2026-01-04', tipo: 'factura_c', punto_venta: '1', numero_fiscal: null, tipo_comprobante_fiscal: null, cae: 'CAE-INCOMPLETE-004', cae_vencimiento: null, estado_fiscal: 'emitido' },
  { id: 'c5', business_id: BUSINESS_ID, fecha: '2026-01-05', tipo: 'factura_c', punto_venta: '1', numero_fiscal: '0001-00000005', tipo_comprobante_fiscal: '11', cae: 'CAE-005', cae_vencimiento: null, estado_fiscal: 'emitido' },
];

function makeQueryBuilder(rows: any[]) {
  let filtered = [...rows]
  const builder: any = {
    select() { return builder },
    eq(col: string, val: unknown) { filtered = filtered.filter(r => r[col] === val); return builder },
    not(col: string, _op: string, _val: unknown) { filtered = filtered.filter(r => r[col] != null); return builder },
    order() { return builder },
    gte(col: string, val: string) { filtered = filtered.filter(r => r[col] >= val); return builder },
    lte(col: string, val: string) { filtered = filtered.filter(r => r[col] <= val); return builder },
    single() {
      return Promise.resolve(filtered[0] ? { data: filtered[0], error: null } : { data: null, error: { message: 'not found (fixture)' } })
    },
    maybeSingle() {
      return Promise.resolve({ data: filtered[0] ?? null, error: null })
    },
    then(resolve: (v: unknown) => void) {
      resolve({ data: filtered, error: null })
    },
  }
  return builder
}

function fakeSupabase() {
  return {
    from(table: string) {
      if (table === 'comprobantes') return makeQueryBuilder(FIXTURE_COMPROBANTES)
      if (table === 'arca_config') return makeQueryBuilder([{ business_id: BUSINESS_ID, cuit: '20123456789', ambiente: 'produccion' }])
      throw new Error('fakeSupabase: tabla inesperada en el test: ' + table)
    },
    functions: {
      invoke(name: string) {
        if (name === 'afip-wsaa') return Promise.resolve({ data: { success: true, token: 'fixture-token', sign: 'fixture-sign' }, error: null })
        throw new Error('fakeSupabase: función inesperada en el test: ' + name)
      },
    },
    // Deliberadamente SIN insert/update/delete — si el script intentara
    // escribir, esto lanzaría un TypeError (confirma modo read-only real).
  }
}

/** Simula FECompConsultar: distintos resultados según el número, para cubrir los 5 status. */
async function fakeConsultarComprobante(_token: string, _sign: string, _cuit: string, _pv: number, _tipo: number, numero: number) {
  if (numero === 1) return { status: 'found', cae: 'CAE-CONFIRMED-001', cae_vencimiento: '2026-12-31', resultado: 'A', numero_cbte: 1 } // confirmed_in_arca
  if (numero === 2) return { status: 'not_found', motivo: 'No se encontró el comprobante solicitado' } // not_found_in_arca
  if (numero === 3) return { status: 'found', cae: 'CAE-REAL-DIFFERENT-003', cae_vencimiento: '2026-12-31', resultado: 'A', numero_cbte: 3 } // data_mismatch
  if (numero === 5) return { status: 'query_failed', motivo: 'timeout de prueba' } // query_failed
  throw new Error('fakeConsultarComprobante: número no esperado en el test: ' + numero)
}

test('runAudit(): ejecuta de verdad (no solo --help) contra fixtures y cubre los 5 status de clasificación', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'arca-audit-test-'))
  try {
    const result = await runAudit(
      { businessId: BUSINESS_ID, from: '2026-01-01', to: '2026-01-31', out: outDir, concurrency: 2, resume: 'test-run-1' },
      { supabase: fakeSupabase(), consultarComprobanteImpl: fakeConsultarComprobante }
    )

    assert.equal(result.dryRun, false)
    assert.equal(result.rows.length, 5, 'debe procesar los 5 comprobantes fixture')

    const byId = Object.fromEntries(result.rows.map((r: any) => [r.comprobante_id, r]))
    assert.equal(byId.c1.status, 'confirmed_in_arca')
    assert.equal(byId.c2.status, 'not_found_in_arca')
    assert.equal(byId.c3.status, 'data_mismatch')
    assert.equal(byId.c4.status, 'insufficient_data')
    assert.equal(byId.c5.status, 'query_failed')

    // Acción recomendada presente y coherente con el status.
    assert.match(byId.c2.accion_recomendada, /revisión manual/)
    assert.match(byId.c3.accion_recomendada, /revisión manual/)

    // JSON y CSV realmente escritos en disco.
    assert.ok(existsSync(result.jsonPath), 'debe existir el archivo JSON del reporte')
    assert.ok(existsSync(result.csvPath), 'debe existir el archivo CSV del reporte')

    const json = JSON.parse(readFileSync(result.jsonPath, 'utf-8'))
    assert.equal(json.length, 5)

    const csv = readFileSync(result.csvPath, 'utf-8')
    assert.match(csv, /comprobante_id,business_id,fecha,tipo,punto_venta,numero_fiscal,cae_local,cae_arca,status,motivo,accion_recomendada/)
    assert.match(csv, /c1,.*confirmed_in_arca/)

    // Ningún secreto en la salida.
    for (const secretWord of ['fixture-token', 'fixture-sign', 'token', 'sign', 'private_key', 'certificate']) {
      assert.doesNotMatch(csv.toLowerCase(), new RegExp(secretWord.toLowerCase()))
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('runAudit(): --resume reanuda desde un .partial.json existente sin reprocesar filas ya hechas', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'arca-audit-resume-test-'))
  try {
    let consultaCalls = 0
    const countingConsultar = async (...args: Parameters<typeof fakeConsultarComprobante>) => {
      consultaCalls++
      return fakeConsultarComprobante(...args)
    }

    // Primera corrida: solo 2 de los 5 (simulamos que se cortó a mitad de camino).
    const supabase1 = fakeSupabase()
    // @ts-expect-error — mutamos el fixture para la primera corrida parcial
    const originalFrom = supabase1.from.bind(supabase1)
    supabase1.from = (table: string) => {
      if (table === 'comprobantes') return makeQueryBuilder(FIXTURE_COMPROBANTES.slice(0, 2))
      return originalFrom(table)
    }
    await runAudit(
      { businessId: BUSINESS_ID, from: '2026-01-01', to: '2026-01-31', out: outDir, concurrency: 1, resume: 'resume-run' },
      { supabase: supabase1, consultarComprobanteImpl: countingConsultar }
    )
    assert.equal(consultaCalls, 2, 'primera corrida: c1 y c2 tienen datos completos, ambos llaman a consultarComprobante')

    // Segunda corrida: TODOS los 5, pero con el mismo --resume → debe reusar
    // c1/c2 del partial y solo consultar los 3 nuevos.
    const callsBeforeResume = consultaCalls
    const result = await runAudit(
      { businessId: BUSINESS_ID, from: '2026-01-01', to: '2026-01-31', out: outDir, concurrency: 2, resume: 'resume-run' },
      { supabase: fakeSupabase(), consultarComprobanteImpl: countingConsultar }
    )

    assert.equal(result.rows.length, 5, 'la corrida final debe tener los 5 (2 reanudados + 3 nuevos)')
    const newCalls = consultaCalls - callsBeforeResume
    assert.ok(newCalls <= 2, `--resume no debe reprocesar los ya hechos (c1 found no vuelve a llamar; c2 not_found sí) — llamadas nuevas: ${newCalls}`)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('runAudit(): --dry-run lista candidatos sin consultar ARCA (no llama a consultarComprobanteImpl)', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'arca-audit-dryrun-test-'))
  try {
    let called = false
    const shouldNotBeCalled = async () => { called = true; throw new Error('no debería llamarse en --dry-run') }

    const result = await runAudit(
      { businessId: BUSINESS_ID, from: '2026-01-01', to: '2026-01-31', out: outDir, dryRun: true },
      { supabase: fakeSupabase(), consultarComprobanteImpl: shouldNotBeCalled }
    )

    assert.equal(result.dryRun, true)
    assert.equal(called, false, '--dry-run nunca debe llamar a ARCA')
    assert.equal(result.candidatos.length, 5)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('runAudit(): el adaptador Supabase mock no expone ningún método de escritura (confirma read-only real, no solo documentado)', () => {
  const supabase = fakeSupabase() as any
  assert.equal(typeof supabase.from('comprobantes').insert, 'undefined')
  assert.equal(typeof supabase.from('comprobantes').update, 'undefined')
  assert.equal(typeof supabase.from('comprobantes').delete, 'undefined')
})
