import { assert, assertEquals, assertNotEquals, assertThrows } from 'jsr:@std/assert'
import {
  ARCA_FISCAL_TIME_ZONE,
  argentinaCivilDate,
  arcaFiscalDate,
  arcaFiscalDatePlusDays,
  formatArgentinaCivilDate,
} from '../../supabase/functions/_shared/fiscalCalendar.ts'
import { resolveCbteFch } from '../../supabase/functions/afip-cae/logic.ts'

// FISCAL DATE ARGENTINA (Part 1): CbteFch is Argentina's civil day, never the
// UTC calendar day. Instants are written with an explicit -03:00 offset.

const VECTORS: Array<[label: string, instant: string, cbteFch: string]> = [
  ['ART 20:59:59', '2026-09-11T20:59:59-03:00', '20260911'],
  ['ART 21:00:00 (UTC is already the next day)', '2026-09-11T21:00:00-03:00', '20260911'],
  ['ART 23:59:59', '2026-09-11T23:59:59-03:00', '20260911'],
  ['ART 00:00:00', '2026-09-12T00:00:00-03:00', '20260912'],
  ['month rollover 23:30', '2026-09-30T23:30:00-03:00', '20260930'],
  ['month rollover 00:00', '2026-10-01T00:00:00-03:00', '20261001'],
  ['year rollover 23:30', '2026-12-31T23:30:00-03:00', '20261231'],
  ['year rollover 00:00', '2027-01-01T00:00:00-03:00', '20270101'],
  ['leap day 23:59', '2028-02-29T23:59:00-03:00', '20280229'],
]

for (const [label, instant, expected] of VECTORS) {
  Deno.test(`CbteFch uses the Argentina civil day: ${label}`, () => {
    assertEquals(arcaFiscalDate(new Date(instant)), expected)
  })
}

// The two production windows where the UTC calendar was already the next day.
// Invoice-like fixtures only: whether ARCA holds a wrong date for those real
// invoices stays unverified until FECompConsultar confirms it.
const UTC_BUG_WINDOWS: Array<[label: string, instant: string, cbteFch: string, utcDay: string]> = [
  ['like 0010-00000087 (2026-07-17 21:03 ART)', '2026-07-17T21:03:22-03:00', '20260717', '20260718'],
  ['like 0010-00000138 (2026-08-08 21:00 ART)', '2026-08-08T21:00:49-03:00', '20260808', '20260809'],
]

for (const [label, instant, cbteFch, utcDay] of UTC_BUG_WINDOWS) {
  Deno.test(`UTC bug window is fixed: ${label}`, () => {
    const at = new Date(instant)
    // The old computation (browser toISOString) produced the next day…
    assertEquals(at.toISOString().slice(0, 10).replace(/-/g, ''), utcDay)
    // …the canonical helper and the server authority produce the civil day.
    assertEquals(arcaFiscalDate(at), cbteFch)
    assertEquals(resolveCbteFch(at, undefined).fechaCbte, cbteFch)
    assertNotEquals(cbteFch, utcDay)
  })
}

Deno.test('delayed issuance like 175/176: sale day and fiscal day stay distinct', () => {
  const cases = [
    { sale: '2026-09-10T22:25:32.952Z', issued: '2026-09-11T12:43:35-03:00' }, // like 0010-00000175
    { sale: '2026-09-10T15:15:49.422Z', issued: '2026-09-11T12:44:08-03:00' }, // like 0010-00000176
  ]
  for (const { sale, issued } of cases) {
    assertEquals(argentinaCivilDate(new Date(sale)), '2026-09-10')
    assertEquals(formatArgentinaCivilDate(new Date(sale)), '10/09/2026')
    assertEquals(resolveCbteFch(new Date(issued), undefined).fechaCbte, '20260911')
  }
})

Deno.test('afip-cae is the authority: an old client UTC date is overridden, never used', () => {
  const now = new Date('2026-09-11T21:30:00-03:00')
  const oldClientDate = now.toISOString().slice(0, 10).replace(/-/g, '') // what old builds sent
  assertEquals(oldClientDate, '20260912')
  assertEquals(resolveCbteFch(now, oldClientDate), {
    fechaCbte: '20260911', client: 'overridden', clientDate: '20260912',
  })
})

Deno.test('afip-cae is the authority: a new client sends no date', () => {
  const now = new Date('2026-09-11T21:30:00-03:00')
  assertEquals(resolveCbteFch(now, undefined), { fechaCbte: '20260911', client: 'absent', clientDate: null })
  assertEquals(resolveCbteFch(now, ''), { fechaCbte: '20260911', client: 'absent', clientDate: null })
  assertEquals(resolveCbteFch(now, '20260911'), { fechaCbte: '20260911', client: 'matches', clientDate: '20260911' })
})

Deno.test('malformed client dates are classified invalid and never echoed', () => {
  const now = new Date('2026-09-11T12:00:00-03:00')
  for (const value of ['2026-09-11', '20260911x', '1234', 'DROP', 20260911, {}, ['20260911']]) {
    assertEquals(resolveCbteFch(now, value), { fechaCbte: '20260911', client: 'invalid', clientDate: null })
  }
})

Deno.test('FchVtoPago helper also counts Argentina civil days', () => {
  assertEquals(arcaFiscalDatePlusDays(new Date('2026-12-25T21:30:00-03:00'), 10), '20270104')
})

Deno.test('an invalid instant is rejected instead of producing a date', () => {
  assertThrows(() => arcaFiscalDate(new Date('not a date')), RangeError)
})

// Same outputs whatever the process timezone is: the helper never reads it.
const PROCESS_ZONES = ['UTC', ARCA_FISCAL_TIME_ZONE, 'America/New_York', 'Asia/Tokyo', 'Pacific/Kiritimati']

Deno.test('process timezone never changes the fiscal day', async () => {
  const helper = new URL('../../supabase/functions/_shared/fiscalCalendar.ts', import.meta.url).href
  const instants = [...VECTORS, ...UTC_BUG_WINDOWS].map((v) => v[1])
  const expected = [...VECTORS, ...UTC_BUG_WINDOWS].map((v) => v[2])
  const script = `import { arcaFiscalDate } from '${helper}'
const instants = ${JSON.stringify(instants)}
console.log(JSON.stringify({
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  offset: new Date('2026-09-11T23:59:59-03:00').getTimezoneOffset(),
  out: instants.map((i) => arcaFiscalDate(new Date(i))),
}))`
  const offsets = new Set<number>()
  for (const zone of PROCESS_ZONES) {
    const run = await new Deno.Command(Deno.execPath(), {
      args: ['eval', '--no-config', script],
      env: { TZ: zone },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    assert(run.success, new TextDecoder().decode(run.stderr))
    const result = JSON.parse(new TextDecoder().decode(run.stdout).trim())
    assertEquals(result.out, expected, `process TZ=${zone} (${result.zone})`)
    offsets.add(result.offset)
  }
  // On platforms that honor TZ (Linux CI), the processes really ran in different zones.
  if (Deno.build.os !== 'windows') assert(offsets.size > 1, 'TZ was not applied to the subprocesses')
})

// ── Static contracts ─────────────────────────────────────────────────────────

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url))
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

Deno.test('the fiscal calendar and afip-cae never derive a day from UTC or the host timezone', () => {
  for (const file of [
    '../../supabase/functions/_shared/fiscalCalendar.ts',
    '../../supabase/functions/afip-cae/logic.ts',
    '../../supabase/functions/afip-cae/index.ts',
  ]) {
    const src = code(file)
    assert(!/\.get(UTC)?(FullYear|Month|Date|Hours)\(/.test(src), `${file} uses Date getters for a calendar day`)
    assert(!/toISOString\(\)\s*\.(slice|split|substring)/.test(src), `${file} slices an ISO string into a day`)
    assert(!/todayYYYYMMDD/.test(src), `${file} still references the UTC helper`)
  }
  assert(/timeZone:\s*ARCA_FISCAL_TIME_ZONE/.test(code('../../supabase/functions/_shared/fiscalCalendar.ts')))
})

Deno.test('afip-cae computes CbteFch itself and never trusts fecha_cbte', () => {
  const src = code('../../supabase/functions/afip-cae/index.ts')
  assert(/resolveCbteFch\(new Date\(\), fecha_cbte\)/.test(src))
  assert(!/fecha_cbte\s*\|\|/.test(src), 'a client date is used as the fiscal date again')
})

Deno.test('the browser no longer sends a fiscal date', () => {
  for (const file of ['../../src/services/comprobanteService.ts', '../../src/services/arcaService.ts']) {
    assert(!/fecha_cbte\s*\??\s*:/.test(code(file)), `${file} sends or declares fecha_cbte`)
  }
})

Deno.test('no surface labels the sale date as the fiscal issue date', () => {
  for (const file of [
    '../../src/components/comprobantes/ComprobanteDocumento.tsx',
    '../../src/components/comprobantes/ComprobantePrintLayout.tsx',
    '../../src/components/comprobantes/ComprobanteInfo.tsx',
    '../../src/pages/Comprobante.tsx',
  ]) {
    const src = code(file)
    assert(!/Fecha de emisi/.test(src), `${file} still calls comprobante.fecha "Fecha de emisión"`)
    assert(/Fecha de venta/.test(src), `${file} does not label the sale date`)
  }
})
