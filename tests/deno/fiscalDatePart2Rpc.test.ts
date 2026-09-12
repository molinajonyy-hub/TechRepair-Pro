import { assert, assertEquals } from 'jsr:@std/assert'
import {
  completeAttemptArgs,
  isLegacyCompleteSignatureError,
  parseFECompConsultarResponse,
  persistCompleteAttempt,
  type CompleteAttemptRpc,
} from '../../supabase/functions/afip-cae/logic.ts'

// FISCAL DATE ARGENTINA (Part 2): afip-cae sends the CbteFch it actually put on
// the wire as `p_fecha_cbte`, and falls back to the legacy 7-argument payload
// for exactly one condition — a database that does not have Part 2 yet.
//
// The invariant every test here defends: an authorized CAE is persisted in all
// four rollout combinations. Fiscal metadata may be missing; the CAE may not.

// ── The real error PostgREST returns ────────────────────────────────────────
// Captured verbatim by scripts/fiscal-date-part2/postgrest-signature-gate.mjs
// against the local stack, calling the 8-argument payload while the database
// still had the 7-argument function. This is the ONLY shape that may retry, so
// it is a fixture and not a paraphrase.
const REAL_PGRST202 = {
  code: 'PGRST202',
  details:
    'Searched for the function public.complete_arca_attempt with parameters p_attempt_id, p_cae, ' +
    'p_cae_vencimiento, p_error_mensaje, p_fecha_cbte, p_observaciones, p_resultado, p_status or with ' +
    'a single unnamed json/jsonb parameter, but no matches were found in the schema cache.',
  hint:
    'Perhaps you meant to call the function public.complete_arca_attempt(p_attempt_id, p_cae, ' +
    'p_cae_vencimiento, p_error_mensaje, p_observaciones, p_resultado, p_status)',
  message:
    'Could not find the function public.complete_arca_attempt(p_attempt_id, p_cae, p_cae_vencimiento, ' +
    'p_error_mensaje, p_fecha_cbte, p_observaciones, p_resultado, p_status) in the schema cache',
}

Deno.test('the real PGRST202 from the local stack is recognised', () => {
  assert(isLegacyCompleteSignatureError(REAL_PGRST202))
})

Deno.test('nothing else is treated as the compatibility case', () => {
  const notLegacy: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'PGRST202 complete_arca_attempt'],
    ['a number', 202],
    ['an empty object', {}],
    ['a plain Error', new Error('Could not find the function public.complete_arca_attempt')],
    ['PGRST202 for a DIFFERENT function', {
      code: 'PGRST202',
      message: 'Could not find the function public.mark_arca_attempt_sent(p_attempt_id) in the schema cache',
    }],
    ['PGRST100 (bad query)', { code: 'PGRST100', message: 'complete_arca_attempt parse error' }],
    ['PGRST301 (jwt)', { code: 'PGRST301', message: 'complete_arca_attempt' }],
    ['a function exception (sqlstate)', { code: 'P0001', message: 'complete_arca_attempt: boom' }],
    ['a timeout', { code: '57014', message: 'canceling statement due to statement timeout' }],
    ['no code at all', { message: 'Could not find the function public.complete_arca_attempt' }],
    ['a numeric code', { code: 404, message: 'complete_arca_attempt' }],
    ['lowercase code', { code: 'pgrst202', message: 'complete_arca_attempt' }],
    ['right code, message not a string', { code: 'PGRST202', message: { fn: 'complete_arca_attempt' } }],
    ['right code, unrelated message', { code: 'PGRST202', message: 'schema cache reload failed' }],
  ]
  for (const [label, err] of notLegacy) {
    assertEquals(isLegacyCompleteSignatureError(err), false, `must NOT retry on: ${label}`)
  }
})

// ── CbteFch reported by ARCA ────────────────────────────────────────────────
// For a comprobante authorised by an EARLIER attempt, today's date proves
// nothing. FECompConsultar's own CbteFch is the only authoritative source, so
// it is parsed — and only in YYYYMMDD form; anything else is discarded rather
// than guessed at.
const consultarFound = (cbteFch: string | null) => `<?xml version="1.0"?>
<soap:Envelope><soap:Body><FECompConsultarResponse><FECompConsultarResult><ResultGet>
  <Concepto>1</Concepto><DocTipo>99</DocTipo><DocNro>0</DocNro>
  <CbteDesde>176</CbteDesde><CbteHasta>176</CbteHasta>
  ${cbteFch === null ? '' : `<CbteFch>${cbteFch}</CbteFch>`}
  <ImpTotal>1000</ImpTotal><CodAutorizacion>75123456789012</CodAutorizacion>
  <FchVto>20260921</FchVto><Resultado>A</Resultado>
</ResultGet></FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`

Deno.test('the CbteFch ARCA reports is parsed out of FECompConsultar', () => {
  const r = parseFECompConsultarResponse(consultarFound('20260808'))
  assertEquals(r.status, 'found')
  assertEquals(r.fecha_cbte, '20260808')
  assertEquals(r.cae, '75123456789012', 'the existing contract is untouched')
  assertEquals(r.cae_vencimiento, '2026-09-21')
  assertEquals(r.numero_cbte, 176)
})

Deno.test('a missing or malformed CbteFch is discarded, never guessed', () => {
  for (const raw of [null, '', '2026-08-08', '2026080', '202608080', 'ayer', '00000000 ']) {
    const r = parseFECompConsultarResponse(consultarFound(raw))
    assertEquals(r.status, 'found', `still found for ${JSON.stringify(raw)}`)
    assertEquals(r.cae, '75123456789012')
    if (raw === '00000000 ') {
      // Trimmed to 8 digits, so it has the shape; the DB parser rejects the
      // impossible date (tests/sql B8). Shape and validity are separate gates.
      assertEquals(r.fecha_cbte, '00000000')
    } else {
      assertEquals(r.fecha_cbte, undefined, `must not invent a date from ${JSON.stringify(raw)}`)
    }
  }
})

// ── Payload shape ───────────────────────────────────────────────────────────
const CANONICAL_KEYS = [
  'p_attempt_id', 'p_status', 'p_cae', 'p_cae_vencimiento',
  'p_resultado', 'p_observaciones', 'p_error_mensaje',
]

Deno.test('without a date the payload is byte-for-byte the legacy 7-argument one', () => {
  const args = completeAttemptArgs('att-1', 'authorized', { cae: '123', resultado: 'A' })
  assertEquals(Object.keys(args).sort(), [...CANONICAL_KEYS].sort())
  assertEquals(args.p_cae, '123')
  assertEquals(args.p_cae_vencimiento, null, 'absent fields travel as null, not undefined')
  assertEquals(args.p_observaciones, null)
  assertEquals(args.p_error_mensaje, null)
  assert(!('p_fecha_cbte' in args))
})

Deno.test('with a date only p_fecha_cbte is added; the canonical seven do not move', () => {
  const fields = { cae: '123', cae_vencimiento: '2026-09-21', resultado: 'A' }
  const legacy = completeAttemptArgs('att-1', 'authorized', fields)
  const withDate = completeAttemptArgs('att-1', 'authorized', fields, '20260911')
  assertEquals(Object.keys(withDate).length, 8)
  assertEquals(withDate.p_fecha_cbte, '20260911')
  for (const k of CANONICAL_KEYS) {
    assertEquals(withDate[k], legacy[k], `${k} must be identical with and without the date`)
  }
})

Deno.test('an empty date is not sent (it is not a fiscal date)', () => {
  const args = completeAttemptArgs('att-1', 'authorized', {}, '')
  assert(!('p_fecha_cbte' in args))
})

// ── Rollout matrix ──────────────────────────────────────────────────────────
// Fake databases. `oldDb` is production before Part 2: it has only the
// 7-argument identity and answers an 8-argument call the way PostgREST really
// does. `newDb` has the 8-argument identity with p_fecha_cbte DEFAULT NULL, so
// both payload shapes resolve — proven over HTTP by the signature gate.
function oldDb(calls: Array<Record<string, unknown>>): CompleteAttemptRpc {
  return (args) => {
    calls.push(args)
    if ('p_fecha_cbte' in args) return Promise.resolve({ error: REAL_PGRST202 })
    return Promise.resolve({ data: { success: true, status: args.p_status, comprobante_id: 'c-1' } })
  }
}
function newDb(calls: Array<Record<string, unknown>>): CompleteAttemptRpc {
  return (args) => {
    calls.push(args)
    const fecha = args.p_fecha_cbte
    return Promise.resolve({
      data: {
        success: true,
        status: args.p_status,
        comprobante_id: 'c-1',
        fiscal_date: fecha === '20260911' ? '2026-09-11' : null,
        fiscal_date_status: fecha === undefined ? 'absent' : fecha === '20260911' ? 'persisted' : 'invalid',
      },
    })
  }
}

const FIELDS = { cae: 'CAE-1', cae_vencimiento: '2026-09-21', resultado: 'A' }

// A — old Edge (no date) + old DB: the state production is in today.
Deno.test('matrix A: old Edge + old DB persists the CAE', async () => {
  const calls: Array<Record<string, unknown>> = []
  const r = await persistCompleteAttempt(oldDb(calls), 'att', 'authorized', FIELDS)
  assert(r.ok, 'the CAE is persisted')
  assertEquals(r.usedLegacyFallback, false)
  assertEquals(calls.length, 1, 'no retry: nothing failed')
  assert(!('p_fecha_cbte' in calls[0]))
})

// B — old Edge (no date) + new DB: the deploy order actually used (DB first).
Deno.test('matrix B: old Edge + new DB persists the CAE, date absent', async () => {
  const calls: Array<Record<string, unknown>> = []
  const r = await persistCompleteAttempt(newDb(calls), 'att', 'authorized', FIELDS)
  assert(r.ok)
  assertEquals(r.usedLegacyFallback, false)
  assertEquals(calls.length, 1)
  assertEquals(r.fiscalDateStatus, 'absent', 'no invented date; backfill will resolve it')
})

// C — new Edge (sends the date) + old DB: the dangerous window. One retry.
Deno.test('matrix C: new Edge + old DB falls back once and still persists the CAE', async () => {
  const calls: Array<Record<string, unknown>> = []
  const r = await persistCompleteAttempt(oldDb(calls), 'att', 'authorized', FIELDS, '20260911')
  assert(r.ok, 'THE CAE IS PERSISTED — fiscal metadata never costs an authorisation')
  assertEquals(r.usedLegacyFallback, true)
  assertEquals(calls.length, 2, 'exactly one retry, never a loop')
  assertEquals(calls[0].p_fecha_cbte, '20260911')
  assert(!('p_fecha_cbte' in calls[1]), 'the retry uses the legacy payload')
  assertEquals(calls[1].p_cae, 'CAE-1', 'and carries the same CAE')
})

// D — new Edge + new DB: the end state.
Deno.test('matrix D: new Edge + new DB persists CAE and the exact fiscal date', async () => {
  const calls: Array<Record<string, unknown>> = []
  const r = await persistCompleteAttempt(newDb(calls), 'att', 'authorized', FIELDS, '20260911')
  assert(r.ok)
  assertEquals(r.usedLegacyFallback, false)
  assertEquals(calls.length, 1)
  assertEquals(r.fiscalDateStatus, 'persisted')
})

Deno.test('a malformed date still completes, and does not trigger a retry', async () => {
  const calls: Array<Record<string, unknown>> = []
  const r = await persistCompleteAttempt(newDb(calls), 'att', 'authorized', FIELDS, '2026-09-11')
  assert(r.ok)
  assertEquals(calls.length, 1)
  assertEquals(r.fiscalDateStatus, 'invalid')
})

Deno.test('a non-compatibility failure is reported, never retried', async () => {
  for (const err of [
    { code: '57014', message: 'canceling statement due to statement timeout' },
    { code: 'P0001', message: 'complete_arca_attempt: something exploded' },
    { code: 'PGRST301', message: 'JWT expired' },
  ]) {
    const calls: Array<Record<string, unknown>> = []
    const rpc: CompleteAttemptRpc = (args) => { calls.push(args); return Promise.resolve({ error: err }) }
    const r = await persistCompleteAttempt(rpc, 'att', 'authorized', FIELDS, '20260911')
    assertEquals(r.ok, false)
    assertEquals(r.usedLegacyFallback, false, `must not retry after ${err.code}`)
    assertEquals(calls.length, 1, `exactly one call after ${err.code}`)
    assertEquals(r.error, err.message)
  }
})

Deno.test('a legacy-signature error is NOT retried when no date was sent', async () => {
  // Can't happen in practice (the error needs an 8-argument call) but the guard
  // must be on `fechaCbte`, not only on the error: retrying an identical
  // payload would be a blind duplicate call.
  const calls: Array<Record<string, unknown>> = []
  const rpc: CompleteAttemptRpc = (args) => { calls.push(args); return Promise.resolve({ error: REAL_PGRST202 }) }
  const r = await persistCompleteAttempt(rpc, 'att', 'authorized', FIELDS)
  assertEquals(r.ok, false)
  assertEquals(r.usedLegacyFallback, false)
  assertEquals(calls.length, 1)
})

Deno.test('success:false from the function is a failure, not a retry', async () => {
  const calls: Array<Record<string, unknown>> = []
  const rpc: CompleteAttemptRpc = (args) => {
    calls.push(args)
    return Promise.resolve({ data: { success: false, error: 'Intento no encontrado' } })
  }
  const r = await persistCompleteAttempt(rpc, 'att', 'authorized', FIELDS, '20260911')
  assertEquals(r.ok, false)
  assertEquals(r.error, 'Intento no encontrado')
  assertEquals(calls.length, 1)
})

Deno.test('rejected and pending_reconciliation carry the date without ever persisting one', async () => {
  // The function ignores p_fecha_cbte unless the status is authorized; proven
  // in tests/sql/fiscal_date_part2.test.sql (C6, C7). Here we only assert the
  // caller keeps the canonical fields intact for those statuses.
  for (const status of ['rejected', 'pending_reconciliation']) {
    const calls: Array<Record<string, unknown>> = []
    const r = await persistCompleteAttempt(
      newDb(calls), 'att', status, { error_mensaje: 'motivo' }, '20260911')
    assert(r.ok)
    assertEquals(calls[0].p_status, status)
    assertEquals(calls[0].p_error_mensaje, 'motivo')
    assertEquals(calls[0].p_cae, null)
  }
})
