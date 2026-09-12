import { assert, assertEquals } from 'jsr:@std/assert'
import {
  evaluateLookup,
  toYyyymmdd,
  type ArcaConsultaResult,
  type PlanEntry,
} from '../../scripts/fiscal-date-part2/arcaLookupIdentity.ts'

// FISCAL DATE ARGENTINA (Part 2): a CbteFch returned by ARCA is only usable if
// the result provably belongs to the comprobante we asked about. `numero_fiscal`
// alone is ambiguous — production holds a 0010-00000001 invoice AND a
// 0010-00000001 credit note — so identity means PV + CbteTipo + number + CAE.
//
// Everything here is fail-closed: any absence, mismatch or ambiguity becomes
// REVIEW_REQUIRED. Nothing is guessed.

const ENTRY: PlanEntry = {
  comprobante_id: '00000000-0000-4000-8000-000000000087',
  business_id: 'aa930802-0861-46ce-896c-7f68b181cb39',
  punto_venta: 10,
  cbte_tipo: 11,
  numero: 87,
  cae_local: '75123456789012',
  importe_local: 20000,
}

const FOUND: ArcaConsultaResult = {
  status: 'found',
  cae: '75123456789012',
  fecha_comprobante: '2026-07-18',
  punto_venta_arca: 10,
  tipo_comprobante_arca: 11,
  numero_cbte: 87,
  importe_total: 20000,
}

Deno.test('toYyyymmdd accepts the date shapes PostgREST and ARCA actually send', () => {
  assertEquals(toYyyymmdd('2026-07-18'), '20260718')
  assertEquals(toYyyymmdd('2026-07-18T00:00:00+00:00'), '20260718')
  assertEquals(toYyyymmdd(' 2026-07-18 '), '20260718')
})

Deno.test('toYyyymmdd refuses anything it would have to guess at', () => {
  for (const bad of [
    null, undefined, 42, '', '20260718', '2026-7-18', '18/07/2026',
    '2026-13-01', '2026-00-10', '2026-07-00', '2026-02-31', '2026-02-30', 'ayer',
  ]) {
    assertEquals(toYyyymmdd(bad), null, `must reject ${JSON.stringify(bad)}`)
  }
})

Deno.test('a fully matching result is backfillable', () => {
  const e = evaluateLookup(ENTRY, FOUND)
  assertEquals(e.verdict, 'BACKFILLABLE')
  assertEquals(e.cbte_fch, '20260718')
  assertEquals(e.problemas, [])
  assertEquals(e.checks.cae, 'match')
  assertEquals(e.checks.punto_venta, 'match')
  assertEquals(e.checks.cbte_tipo, 'match')
  assertEquals(e.checks.numero, 'match')
  assertEquals(e.checks.importe, 'match')
})

Deno.test('a different CAE is never backfilled', () => {
  const e = evaluateLookup(ENTRY, { ...FOUND, cae: '99999999999999' })
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.cbte_fch, undefined, 'no date may escape a failed identity check')
  assert(e.problemas.some((p) => p.includes('cae')))
})

Deno.test('a credit note answering an invoice query is caught by CbteTipo', () => {
  // The real hazard: 0010-00000001 exists as both 11 and 13.
  const e = evaluateLookup(ENTRY, { ...FOUND, tipo_comprobante_arca: 13 })
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.cbte_fch, undefined)
  assert(e.problemas.some((p) => p.includes('cbte_tipo')))
})

Deno.test('a different PV or number is caught', () => {
  for (const wrong of [{ punto_venta_arca: 1 }, { numero_cbte: 88 }]) {
    const e = evaluateLookup(ENTRY, { ...FOUND, ...wrong })
    assertEquals(e.verdict, 'REVIEW_REQUIRED')
    assertEquals(e.cbte_fch, undefined)
  }
})

Deno.test('not_found and query_failed are never backfillable', () => {
  for (const status of ['not_found', 'query_failed'] as const) {
    const e = evaluateLookup(ENTRY, { status })
    assertEquals(e.verdict, 'REVIEW_REQUIRED')
    assertEquals(e.cbte_fch, undefined)
    assert(e.problemas.some((p) => p.includes(status)))
  }
})

Deno.test('a null result (no response at all) is REVIEW_REQUIRED', () => {
  const e = evaluateLookup(ENTRY, null)
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.checks.status, 'sin_respuesta')
  assertEquals(e.cbte_fch, undefined)
})

Deno.test('a missing or impossible CbteFch is REVIEW_REQUIRED, not a guess', () => {
  const sinFecha = evaluateLookup(ENTRY, { ...FOUND, fecha_comprobante: undefined })
  assertEquals(sinFecha.verdict, 'REVIEW_REQUIRED')
  assertEquals(sinFecha.checks.cbte_fch, 'absent')

  const imposible = evaluateLookup(ENTRY, { ...FOUND, fecha_comprobante: '2026-02-31' })
  assertEquals(imposible.verdict, 'REVIEW_REQUIRED')
  assertEquals(imposible.checks.cbte_fch, 'invalid')
  assertEquals(imposible.cbte_fch, undefined, 'must not normalise to 2026-03-03')
})

Deno.test('an unverifiable identity field blocks the backfill', () => {
  // A local row with no CAE recorded cannot prove the result is its own.
  const e = evaluateLookup({ ...ENTRY, cae_local: null }, FOUND)
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.checks.cae, 'unknown')
  assert(e.problemas.some((p) => p.includes('no se pudo comparar')))
})

Deno.test('a contradicting amount blocks it; a missing amount does not', () => {
  const contradice = evaluateLookup(ENTRY, { ...FOUND, importe_total: 21000 })
  assertEquals(contradice.verdict, 'REVIEW_REQUIRED')
  assert(contradice.problemas.some((p) => p.includes('importe_total')))

  // Amount is supporting evidence: absent is tolerated, since the fiscal
  // identity is already pinned by PV + CbteTipo + number + CAE.
  const ausente = evaluateLookup({ ...ENTRY, importe_local: null }, { ...FOUND, importe_total: undefined })
  assertEquals(ausente.verdict, 'BACKFILLABLE')
  assertEquals(ausente.checks.importe, 'unknown')

  // A centavo of XML rounding is not a mismatch.
  const centavo = evaluateLookup(ENTRY, { ...FOUND, importe_total: 20000.01 })
  assertEquals(centavo.verdict, 'BACKFILLABLE')
})
