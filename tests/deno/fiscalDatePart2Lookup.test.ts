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
// The fixtures below are the REAL deployed afip-fe-query HTTP response, taken
// from supabase/functions/afip-fe-query/index.ts: the payload arrives under
// `consulta`, the range comes back as numero_desde/numero_hasta, and absent
// fields are null. An earlier version of this module modelled `numero_cbte`,
// which exists only inside queryLogic and never on the wire — so number
// identity read as 'unknown' and every row fell to REVIEW_REQUIRED even when
// ARCA had returned the right comprobante. These tests pin the wire contract.

const ENTRY: PlanEntry = {
  comprobante_id: '00000000-0000-4000-8000-000000000087',
  business_id: 'aa930802-0861-46ce-896c-7f68b181cb39',
  punto_venta: 10,
  cbte_tipo: 11,
  numero: 87,
  cae_local: '75123456789012',
  importe_local: 20000,
}

/** The real envelope afip-fe-query returns for operacion 'consultar'. */
const respuestaReal = (consulta: Record<string, unknown>) => ({
  success: true,
  operacion: 'consultar',
  consulta: {
    status: 'found',
    // Echo of what was REQUESTED — never valid identity evidence.
    punto_venta: 10,
    tipo_comprobante: 11,
    numero: 87,
    // What ARCA actually answered.
    punto_venta_arca: 10,
    tipo_comprobante_arca: 11,
    numero_desde: 87,
    numero_hasta: 87,
    cae: '75123456789012',
    cae_vencimiento: '2026-07-28',
    fecha_comprobante: '2026-07-18',
    importe_total: 20000,
    doc_tipo: 99,
    doc_numero: '0',
    resultado: 'A',
    observaciones: null,
    motivo: null,
    ...consulta,
  },
  ambiente: 'produccion',
  correlation_id: 'fdp2-test',
})

/** What the runner hands the identity module: the `consulta` object. */
const consulta = (over: Record<string, unknown> = {}) =>
  respuestaReal(over).consulta as unknown as ArcaConsultaResult

// ── The contract itself ─────────────────────────────────────────────────────

Deno.test('the runner contract does not use numero_cbte', async () => {
  // Regression guard: numero_cbte is queryLogic-internal and absent from the
  // HTTP response. If it reappears here, number identity silently breaks.
  const src = await Deno.readTextFile(
    new URL('../../scripts/fiscal-date-part2/arcaLookupIdentity.ts', import.meta.url))
  const sinComentarios = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert(!/numero_cbte/.test(sinComentarios),
    'arcaLookupIdentity must consume numero_desde/numero_hasta, never numero_cbte')
  assert(/numero_desde/.test(sinComentarios) && /numero_hasta/.test(sinComentarios),
    'both range ends must be part of the contract')
})

Deno.test('identity is judged on what ARCA answered, not on the echoed request', () => {
  // The echo always equals what we asked, so if identity were read from it a
  // wrong comprobante would still "match". Here ARCA answers a DIFFERENT
  // number while the echo stays correct: it must be caught.
  const e = evaluateLookup(ENTRY, consulta({ numero_desde: 90, numero_hasta: 90 }))
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.checks.numero, 'mismatch')
  assertEquals(e.cbte_fch, undefined)
})

// ── Dates ───────────────────────────────────────────────────────────────────

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

// ── The happy path ──────────────────────────────────────────────────────────

Deno.test('the real response with both range ends matching is backfillable', () => {
  const e = evaluateLookup(ENTRY, consulta())
  assertEquals(e.verdict, 'BACKFILLABLE')
  assertEquals(e.cbte_fch, '20260718')
  assertEquals(e.problemas, [])
  assertEquals(e.checks.numero, 'match')
  assertEquals(e.checks.cae, 'match')
  assertEquals(e.checks.punto_venta, 'match')
  assertEquals(e.checks.cbte_tipo, 'match')
  assertEquals(e.checks.importe, 'match')
})

// ── Number identity: both ends, no fallback ─────────────────────────────────

Deno.test('numero_desde mismatch is REVIEW_REQUIRED', () => {
  const e = evaluateLookup(ENTRY, consulta({ numero_desde: 86 }))
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.checks.numero, 'mismatch')
  assertEquals(e.cbte_fch, undefined)
})

Deno.test('numero_hasta mismatch is REVIEW_REQUIRED', () => {
  // A range like [87, 90] answers more than the one comprobante asked for.
  const e = evaluateLookup(ENTRY, consulta({ numero_hasta: 90 }))
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.checks.numero, 'mismatch')
  assertEquals(e.cbte_fch, undefined)
})

Deno.test('a missing range end is unknown, never assumed from the request', () => {
  for (const hueco of [
    { numero_desde: null }, { numero_hasta: null },
    { numero_desde: undefined }, { numero_hasta: undefined },
    { numero_desde: null, numero_hasta: null },
  ]) {
    const e = evaluateLookup(ENTRY, consulta(hueco))
    assertEquals(e.verdict, 'REVIEW_REQUIRED', `hueco ${JSON.stringify(hueco)}`)
    assertEquals(e.checks.numero, 'unknown')
    assertEquals(e.cbte_fch, undefined)
  }
})

Deno.test('a malformed range end is a mismatch, not a match', () => {
  const e = evaluateLookup(ENTRY, consulta({ numero_desde: 'ochenta y siete' }))
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.checks.numero, 'mismatch')
})

// ── The other identity gates still block ────────────────────────────────────

Deno.test('a different CAE is never backfilled', () => {
  const e = evaluateLookup(ENTRY, consulta({ cae: '99999999999999' }))
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.checks.cae, 'mismatch')
  assertEquals(e.cbte_fch, undefined)
})

Deno.test('a PV mismatch blocks', () => {
  const e = evaluateLookup(ENTRY, consulta({ punto_venta_arca: 1 }))
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.checks.punto_venta, 'mismatch')
})

Deno.test('a credit note answering an invoice query is caught by CbteTipo', () => {
  // The real hazard: 0010-00000001 exists as both 11 and 13.
  const e = evaluateLookup(ENTRY, consulta({ tipo_comprobante_arca: 13 }))
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.checks.cbte_tipo, 'mismatch')
  assertEquals(e.cbte_fch, undefined)
})

Deno.test('an invalid CbteFch blocks and is never normalised', () => {
  const e = evaluateLookup(ENTRY, consulta({ fecha_comprobante: '2026-02-31' }))
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.checks.cbte_fch, 'invalid')
  assertEquals(e.cbte_fch, undefined, 'must not become 2026-03-03')
})

Deno.test('an absent CbteFch blocks', () => {
  const e = evaluateLookup(ENTRY, consulta({ fecha_comprobante: null }))
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.checks.cbte_fch, 'absent')
})

Deno.test('a contradicting amount blocks; a missing amount does not', () => {
  const contradice = evaluateLookup(ENTRY, consulta({ importe_total: 21000 }))
  assertEquals(contradice.verdict, 'REVIEW_REQUIRED')
  assert(contradice.problemas.some((p) => p.includes('importe_total')))

  // Amount is supporting evidence: absent is tolerated, since fiscal identity
  // is already pinned by PV + CbteTipo + range + CAE.
  const ausente = evaluateLookup(
    { ...ENTRY, importe_local: null }, consulta({ importe_total: null }))
  assertEquals(ausente.verdict, 'BACKFILLABLE')
  assertEquals(ausente.checks.importe, 'unknown')

  // A centavo of XML rounding is not a mismatch.
  assertEquals(evaluateLookup(ENTRY, consulta({ importe_total: 20000.01 })).verdict, 'BACKFILLABLE')
})

// ── Non-found statuses and no response ──────────────────────────────────────

Deno.test('not_found and query_failed are never backfillable', () => {
  for (const status of ['not_found', 'query_failed'] as const) {
    const e = evaluateLookup(ENTRY, consulta({
      status, punto_venta_arca: null, tipo_comprobante_arca: null,
      numero_desde: null, numero_hasta: null, cae: null, fecha_comprobante: null,
    }))
    assertEquals(e.verdict, 'REVIEW_REQUIRED')
    assertEquals(e.cbte_fch, undefined)
    assert(e.problemas.some((p) => p.includes(status)))
  }
})

Deno.test('a null result (no response at all) is REVIEW_REQUIRED', () => {
  const e = evaluateLookup(ENTRY, null)
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.checks.status, 'sin_respuesta')
  assertEquals(e.checks.numero, 'unknown')
  assertEquals(e.cbte_fch, undefined)
})

Deno.test('an unverifiable local CAE blocks the backfill', () => {
  const e = evaluateLookup({ ...ENTRY, cae_local: null }, consulta())
  assertEquals(e.verdict, 'REVIEW_REQUIRED')
  assertEquals(e.checks.cae, 'unknown')
  assert(e.problemas.some((p) => p.includes('no se pudo comparar')))
})
