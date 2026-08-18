// ============================================================================
// REPRODUCCIÓN OFFLINE del incidente del 2026-08-18 (afip-cae v16, HTTP 400
// pre-WSAA) y contrato de los gates pre-envío.
//
//   RUN: deno test -A --node-modules-dir=auto tests/deno/
//
// Ejecuta la secuencia REAL de gates (`evaluarPreEnvio`), no helpers sueltos:
// fetchAttempt, el gate de estado del intento y la resolución canónica de
// CbtesAsoc, con un doble del cliente PostgREST que reproduce la cadena
// `.from().select().eq().eq().maybeSingle()`.
//
// El boundary externo (WSAA/WSFE) NUNCA se llama: llegar hasta él se representa
// con REACHED_WSAA_BOUNDARY, porque `evaluarPreEnvio` devolviendo ok:true es
// exactamente el punto en el que `index.ts` invoca afip-wsaa.
// ============================================================================
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { evaluarPreEnvio } from '../../supabase/functions/afip-cae/preSend.ts'

// ── Fixture EXACTO del incidente ────────────────────────────────────────────
const COMPROBANTE_ID = '722d1a19-01df-4489-80d0-c5c9c5860c8d'
const ATTEMPT_ID     = 'cb9d04c6-7b13-41ba-87f3-317023465177'
const BUSINESS_ID    = 'aa930802-0861-46ce-896c-7f68b181cb39'

const FILA_COMPROBANTE = {
  id: COMPROBANTE_ID,
  business_id: BUSINESS_ID,
  tipo: 'factura_c',
  tipo_comprobante_fiscal: null,   // todavía no emitida
  comprobante_original_id: null,
  numero_fiscal: null,
}

const FILA_ATTEMPT = {
  id: ATTEMPT_ID,
  comprobante_id: COMPROBANTE_ID,
  business_id: BUSINESS_ID,
  ambiente: 'produccion',
  cuit_emisor: '20111111112',
  punto_venta: 10,
  tipo_comprobante: 11,
  numero_intentado: null,
  status: 'claimed',
}

/** Doble del cliente PostgREST. `fallaLectura` simula un error de la base. */
function supabaseDoble(
  filas: Record<string, any[]>,
  opts: { fallaLectura?: string } = {},
) {
  return {
    from(tabla: string) {
      const filtros: Array<[string, unknown]> = []
      const api: any = {
        select: () => api,
        eq(col: string, val: unknown) { filtros.push([col, val]); return api },
        maybeSingle() {
          if (opts.fallaLectura) {
            return Promise.resolve({ data: null, error: { message: opts.fallaLectura } })
          }
          const match = (filas[tabla] ?? []).find(f =>
            filtros.every(([c, v]) => f[c] === v))
          return Promise.resolve({ data: match ?? null, error: null })
        },
      }
      return api
    },
    // Si algún gate llamara al boundary externo, el test falla ruidosamente.
    functions: {
      invoke: () => { throw new Error('WSAA no debe invocarse en los gates pre-envío') },
    },
  }
}

const BASE = { comprobantes: [FILA_COMPROBANTE], arca_emission_attempts: [FILA_ATTEMPT] }

// ── H · el caso del incidente ───────────────────────────────────────────────

Deno.test('H · fixture exacto del incidente llega al boundary de WSAA (no 400)', async () => {
  const r = await evaluarPreEnvio(supabaseDoble(BASE), {
    comprobanteId: COMPROBANTE_ID,
    attemptId: ATTEMPT_ID,
    body: {},   // una factura no manda cbte_asoc_*
  })

  if (!r.ok) {
    throw new Error(`REGRESIÓN: gate=${r.gate} detalle=${r.detalle ?? '-'} status=${r.status} — ${r.error}`)
  }
  assertEquals(r.ok, true, 'REACHED_WSAA_BOUNDARY')
  assertEquals(r.requiereSnapshotNc, false, 'una factura no exige snapshot de NC')
  assertEquals(r.attempt.tipo_comprobante, 11)
  assertEquals(r.attempt.punto_venta, 10)
})

// ── A/B · facturas normales ─────────────────────────────────────────────────

Deno.test('A · Factura C normal atraviesa los gates pre-WSAA', async () => {
  const r = await evaluarPreEnvio(supabaseDoble(BASE), {
    comprobanteId: COMPROBANTE_ID, attemptId: ATTEMPT_ID, body: {},
  })
  assert(r.ok)
})

Deno.test('B · Factura A normal atraviesa los gates pre-WSAA', async () => {
  const db = supabaseDoble({
    comprobantes: [{ ...FILA_COMPROBANTE, tipo: 'factura_a' }],
    arca_emission_attempts: [{ ...FILA_ATTEMPT, tipo_comprobante: 1 }],
  })
  const r = await evaluarPreEnvio(db, {
    comprobanteId: COMPROBANTE_ID, attemptId: ATTEMPT_ID, body: {},
  })
  assert(r.ok)
})

// ── E/F · fail-closed que NO se puede relajar ───────────────────────────────

Deno.test('E · mismatch real entre el CbteTipo del intento y el de la fila falla cerrado', async () => {
  const db = supabaseDoble({
    comprobantes: [FILA_COMPROBANTE],                                  // factura_c → 11
    arca_emission_attempts: [{ ...FILA_ATTEMPT, tipo_comprobante: 1 }], // dice Factura A
  })
  const r = await evaluarPreEnvio(db, {
    comprobanteId: COMPROBANTE_ID, attemptId: ATTEMPT_ID, body: {},
  })
  assert(!r.ok)
  assertEquals(r.gate, 'CBTES_ASOC_INVALID')
  assertEquals(r.detalle, 'INVOICE_CBTE_TIPO_MISMATCH')
  assertEquals(r.status, 400)
})

Deno.test('F · el cliente no puede colar CbtesAsoc en una factura', async () => {
  const r = await evaluarPreEnvio(supabaseDoble(BASE), {
    comprobanteId: COMPROBANTE_ID, attemptId: ATTEMPT_ID,
    body: { cbteAsocTipo: 11, cbteAsocPtoVta: 10, cbteAsocNro: 1 },
  })
  assert(!r.ok)
  assertEquals(r.detalle, 'ASOC_NOT_ALLOWED_ON_INVOICE')
})

Deno.test('D · NC sin identidad completa falla cerrado', async () => {
  const db = supabaseDoble({
    comprobantes: [{ ...FILA_COMPROBANTE, tipo: 'nota_credito', tipo_comprobante_fiscal: '13', comprobante_original_id: null }],
    arca_emission_attempts: [{ ...FILA_ATTEMPT, tipo_comprobante: 13 }],
  })
  const r = await evaluarPreEnvio(db, {
    comprobanteId: COMPROBANTE_ID, attemptId: ATTEMPT_ID,
    body: { cbteAsocTipo: 11, cbteAsocPtoVta: 10, cbteAsocNro: 45 },
  })
  assert(!r.ok)
  assertEquals(r.detalle, 'NC_WITHOUT_ORIGINAL')
})

// ── Gates de intento ────────────────────────────────────────────────────────

Deno.test('MISSING_IDS cuando falta attempt_id', async () => {
  const r = await evaluarPreEnvio(supabaseDoble(BASE), {
    comprobanteId: COMPROBANTE_ID, attemptId: undefined, body: {},
  })
  assert(!r.ok)
  assertEquals(r.gate, 'MISSING_IDS')
  assertEquals(r.status, 400)
})

Deno.test('ATTEMPT_MISMATCH cuando el intento no corresponde al comprobante', async () => {
  const r = await evaluarPreEnvio(supabaseDoble(BASE), {
    comprobanteId: '00000000-0000-0000-0000-0000000000ff',
    attemptId: ATTEMPT_ID, body: {},
  })
  assert(!r.ok)
  assertEquals(r.gate, 'ATTEMPT_MISMATCH')
  assertEquals(r.status, 400)
})

Deno.test('ATTEMPT_NOT_ACTIVE no puede reabrir un intento terminal', async () => {
  const db = supabaseDoble({
    comprobantes: [FILA_COMPROBANTE],
    arca_emission_attempts: [{ ...FILA_ATTEMPT, status: 'authorized' }],
  })
  const r = await evaluarPreEnvio(db, {
    comprobanteId: COMPROBANTE_ID, attemptId: ATTEMPT_ID, body: {},
  })
  assert(!r.ok)
  assertEquals(r.gate, 'ATTEMPT_NOT_ACTIVE')
  assertEquals(r.status, 409)
})

// ── El defecto de diagnóstico que dejó el incidente sin explicación ─────────

Deno.test('un fallo de LECTURA es 503 ATTEMPT_READ_FAILED, no un 400 que culpa al cliente', async () => {
  const db = supabaseDoble(BASE, { fallaLectura: 'canceling statement due to statement timeout' })
  const r = await evaluarPreEnvio(db, {
    comprobanteId: COMPROBANTE_ID, attemptId: ATTEMPT_ID, body: {},
  })
  assert(!r.ok)
  assertEquals(r.gate, 'ATTEMPT_READ_FAILED')
  assertEquals(r.status, 503, 'un fallo del servidor no puede reportarse como 400')
  assert(String(r.detalle).includes('timeout'), 'el motivo real debe llegar al log')
})
