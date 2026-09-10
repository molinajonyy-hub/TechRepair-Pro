/**
 * P0-ARCA-B — el claim pre-envío no puede ocupar la serie para siempre, y nunca
 * se envía a ARCA sin una reserva de número confirmada.
 * Runner: node:test nativo, clientes Supabase falsos (sin red).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  confirmReservation, releasePreSendClaim,
} from '../../supabase/functions/afip-cae/claimLifecycle.ts'

function fakeSupabase(opts: {
  rpc?: (name: string, args: Record<string, unknown>) => unknown
  row?: Record<string, unknown> | null
  readError?: boolean
  readThrows?: boolean
} = {}) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = []
  const reads: { table: string; filters: [string, unknown][] }[] = []
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      return opts.rpc ? opts.rpc(name, args) : { data: null, error: null }
    },
    from(table: string) {
      const read = { table, filters: [] as [string, unknown][] }
      reads.push(read)
      return {
        select() { return this },
        eq(key: string, value: unknown) { read.filters.push([key, value]); return this },
        maybeSingle: async () => {
          if (opts.readThrows) throw new Error('synthetic read failure')
          if (opts.readError) return { data: null, error: { message: 'synthetic read error' } }
          return { data: opts.row ?? null, error: null }
        },
      }
    },
  }
  return { client, rpcCalls, reads }
}
const noLog = () => {}

test('release: calls the guarded RPC with the attempt and reason', async () => {
  const f = fakeSupabase({ rpc: () => ({ data: { success: true, released: true }, error: null }) })
  const logs: Record<string, unknown>[] = []
  assert.equal(await releasePreSendClaim(f.client, 'att-1', 'wsaa_failed', (x) => logs.push(x)), true)
  assert.deepEqual(f.rpcCalls, [{ name: 'release_arca_presend_claim', args: { p_attempt_id: 'att-1', p_reason: 'wsaa_failed' } }])
  assert.equal(logs[0].classification, 'claim_released')
})

test('release: not releasable, RPC error or exception -> false, never throws', async () => {
  for (const rpc of [
    () => ({ data: { success: true, released: false }, error: null }),
    () => ({ data: null, error: { message: 'permission denied' } }),
    () => ({ data: { success: false, error: 'missing_attempt' }, error: null }),
    () => { throw new Error('network') },
  ]) {
    const f = fakeSupabase({ rpc })
    assert.equal(await releasePreSendClaim(f.client, 'att-1', 'x', noLog), false)
  }
})

test('reservation confirmed by the RPC -> reserved, no extra read', async () => {
  const f = fakeSupabase({ rpc: () => ({ data: { success: true }, error: null }) })
  assert.equal(await confirmReservation(f.client, 'att-1', 175, noLog), 'reserved')
  assert.deepEqual(f.rpcCalls, [{ name: 'reserve_arca_number', args: { p_attempt_id: 'att-1', p_numero: 175 } }])
  assert.equal(f.reads.length, 0)
})

test('reservation not confirmed: the row decides, only an exact own reservation counts', async () => {
  const cases: [Record<string, unknown> | null, string][] = [
    [{ status: 'number_reserved', numero_intentado: 175 }, 'reserved'],   // response lost, reservation applied
    [{ status: 'number_reserved', numero_intentado: 176 }, 'not_reserved'],
    [{ status: 'claimed', numero_intentado: null }, 'not_reserved'],
    [{ status: 'abandoned', numero_intentado: null }, 'not_reserved'],   // claim recovered by another comprobante
    [{ status: 'sent', numero_intentado: 175 }, 'not_reserved'],
    [null, 'unknown'],
  ]
  for (const [row, expected] of cases) {
    const f = fakeSupabase({ rpc: () => ({ data: { success: false, error: 'no claimed' }, error: null }), row })
    assert.equal(await confirmReservation(f.client, 'att-1', 175, noLog), expected, JSON.stringify(row))
    assert.deepEqual(f.reads[0].filters, [['id', 'att-1']])
    assert.equal(f.reads[0].table, 'arca_emission_attempts')
  }
})

test('reservation RPC throws and the row cannot be read -> unknown', async () => {
  for (const opts of [{ readError: true }, { readThrows: true }]) {
    const f = fakeSupabase({ rpc: () => { throw new Error('network') }, ...opts })
    assert.equal(await confirmReservation(f.client, 'att-1', 175, noLog), 'unknown')
  }
})

test('static: afip-cae never sends without a confirmed reservation and releases pre-send failures', () => {
  const src = readFileSync(new URL('../../supabase/functions/afip-cae/index.ts', import.meta.url), 'utf8')
  const at = (needle: string) => {
    const i = src.indexOf(needle)
    assert.ok(i >= 0, `missing: ${needle}`)
    return i
  }
  assert.ok(!src.includes('await reserveNumber('), 'the fire-and-forget reservation must be gone')

  const reserve = at('const reserva = await confirmReservation(')
  const guard = at("if (reserva !== 'reserved') {")
  const markSent = at('await markAttemptSent(supabase, attemptIdOk, logCtx)')
  const soap = at('await solicitarCAEConReconciliacion({')
  assert.ok(reserve < guard && guard < markSent && markSent < soap, 'reserve -> guard -> mark sent -> SOAP')
  const guardBlock = src.slice(guard, markSent)
  assert.match(guardBlock, /return jsonResponse\(req, \{[\s\S]*outcome: 'not_sent'/)

  assert.ok(at('releasableAttemptId = null\n    const reserva') < reserve, 'pre-send release is disarmed before reserving')
  assert.match(src, /if \(attempt\.numero_intentado == null\) releasableAttemptId = attemptIdOk/)

  const wsaaRelease = at("const claimReleased = await releaseClaim('wsaa_failed')")
  assert.ok(wsaaRelease < at('error: `WSAA: ${errMsg}`'), 'WSAA failure releases before responding')
  assert.ok(at("await releaseClaim('nc_snapshot_failed')") < at("error: snapshot.error || 'No se pudo fijar CbtesAsoc en el attempt'"))
  const catchBlock = src.slice(at('} catch (err: any) {'))
  assert.match(catchBlock, /await releaseClaim\('pre_reserve_exception'\)/)
})
