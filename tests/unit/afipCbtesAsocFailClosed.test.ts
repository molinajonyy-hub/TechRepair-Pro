import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  resolverCbtesAsocCanonico,
  validarCbtesAsocBody,
} from '../../supabase/functions/afip-cae/cbtesAsoc.ts'

const NC_ID = '00000000-0000-0000-0000-000000000013'
const ORIGINAL_ID = '00000000-0000-0000-0000-000000000011'
const BUSINESS_ID = '00000000-0000-0000-0000-0000000000b0'

function supabaseFixture(rows: Record<string, Record<string, unknown>>) {
  const queries: Array<{ table: string; select: string; filters: Record<string, unknown> }> = []
  return {
    queries,
    client: {
      from(table: string) {
        const query = { table, select: '', filters: {} as Record<string, unknown> }
        queries.push(query)
        const builder = {
          select(columns: string) {
            query.select = columns
            return builder
          },
          eq(column: string, value: unknown) {
            query.filters[column] = value
            return builder
          },
          async maybeSingle() {
            const row = rows[String(query.filters.id)] ?? null
            if (row && row.business_id !== query.filters.business_id) {
              return { data: null, error: null }
            }
            return { data: row, error: null }
          },
        }
        return builder
      },
    },
  }
}

test('NC A/B/C: cualquier CbtesAsoc ausente o parcial falla cerrado', () => {
  for (const tipoComprobante of [3, 8, 13]) {
    for (const body of [
      {},
      { cbteAsocTipo: tipoComprobante === 3 ? 1 : tipoComprobante === 8 ? 6 : 11 },
      { cbteAsocTipo: tipoComprobante === 3 ? 1 : tipoComprobante === 8 ? 6 : 11, cbteAsocPtoVta: 10 },
      { cbteAsocTipo: tipoComprobante === 3 ? 1 : tipoComprobante === 8 ? 6 : 11, cbteAsocPtoVta: 10, cbteAsocNro: 0 },
    ]) {
      const result = validarCbtesAsocBody(tipoComprobante, body)
      assert.equal(result.ok, false, `CbteTipo ${tipoComprobante} no puede aceptar ${JSON.stringify(body)}`)
    }
  }
})

test('la clase de CbtesAsoc debe corresponder a la clase de la NC', () => {
  assert.equal(validarCbtesAsocBody(3, {
    cbteAsocTipo: 11, cbteAsocPtoVta: 10, cbteAsocNro: 45,
  }).ok, false)
  assert.equal(validarCbtesAsocBody(8, {
    cbteAsocTipo: 1, cbteAsocPtoVta: 10, cbteAsocNro: 45,
  }).ok, false)
  assert.equal(validarCbtesAsocBody(13, {
    cbteAsocTipo: 11, cbteAsocPtoVta: 10, cbteAsocNro: 45,
  }).ok, true)
})

test('NC C: la Edge Function vuelve a resolver (10,11,45) desde el original server-side', async () => {
  const db = supabaseFixture({
    [NC_ID]: {
      id: NC_ID,
      business_id: BUSINESS_ID,
      tipo: 'nota_credito',
      tipo_comprobante_fiscal: '13',
      comprobante_original_id: ORIGINAL_ID,
    },
    [ORIGINAL_ID]: {
      id: ORIGINAL_ID,
      business_id: BUSINESS_ID,
      tipo: 'factura_c',
      numero_fiscal: '0010-00000045',
      tipo_comprobante_fiscal: '11',
    },
  })

  const result = await resolverCbtesAsocCanonico(db.client, {
    comprobanteId: NC_ID,
    businessId: BUSINESS_ID,
    tipoComprobante: 13,
    body: { cbteAsocTipo: 11, cbteAsocPtoVta: 10, cbteAsocNro: 45 },
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.identidad, { puntoVenta: 10, cbteTipo: 11, numero: 45 })
  assert.equal(result.originalId, ORIGINAL_ID)
  assert.equal(db.queries.length, 2)
  assert.deepEqual(db.queries.map((q) => q.filters.business_id), [BUSINESS_ID, BUSINESS_ID])
})

test('NC C: el body completo pero distinto del original también falla cerrado', async () => {
  const db = supabaseFixture({
    [NC_ID]: {
      id: NC_ID,
      business_id: BUSINESS_ID,
      tipo: 'nota_credito',
      tipo_comprobante_fiscal: '13',
      comprobante_original_id: ORIGINAL_ID,
    },
    [ORIGINAL_ID]: {
      id: ORIGINAL_ID,
      business_id: BUSINESS_ID,
      tipo: 'factura_c',
      numero_fiscal: '0010-00000045',
      tipo_comprobante_fiscal: '11',
    },
  })

  const result = await resolverCbtesAsocCanonico(db.client, {
    comprobanteId: NC_ID,
    businessId: BUSINESS_ID,
    tipoComprobante: 13,
    body: { cbteAsocTipo: 11, cbteAsocPtoVta: 7, cbteAsocNro: 45 },
  })

  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /no coincide/i)
})

test('una fila nota_credito nunca elude el gate con attempt CbteTipo 11/99', async () => {
  for (const tipoComprobante of [11, 99]) {
    const db = supabaseFixture({
      [NC_ID]: {
        id: NC_ID,
        business_id: BUSINESS_ID,
        tipo: 'nota_credito',
        tipo_comprobante_fiscal: '13',
        comprobante_original_id: ORIGINAL_ID,
      },
    })

    const result = await resolverCbtesAsocCanonico(db.client, {
      comprobanteId: NC_ID,
      businessId: BUSINESS_ID,
      tipoComprobante,
      body: {},
    })

    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /no son fiscalmente equivalentes/i)
    assert.equal(db.queries.length, 1, 'la fila debe leerse aun cuando el attempt no parezca NC')
  }
})

test('una factura tampoco puede procesarse con attempt de Nota de Crédito', async () => {
  const db = supabaseFixture({
    [NC_ID]: {
      id: NC_ID,
      business_id: BUSINESS_ID,
      tipo: 'factura_c',
      tipo_comprobante_fiscal: '11',
      comprobante_original_id: null,
    },
  })

  const result = await resolverCbtesAsocCanonico(db.client, {
    comprobanteId: NC_ID,
    businessId: BUSINESS_ID,
    tipoComprobante: 13,
    body: { cbteAsocTipo: 11, cbteAsocPtoVta: 10, cbteAsocNro: 45 },
  })

  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /no son fiscalmente equivalentes/i)
})

test('la clase NC persistida debe coincidir exactamente con el CbteTipo del attempt', async () => {
  const db = supabaseFixture({
    [NC_ID]: {
      id: NC_ID,
      business_id: BUSINESS_ID,
      tipo: 'nota_credito',
      tipo_comprobante_fiscal: '3',
      comprobante_original_id: ORIGINAL_ID,
    },
  })

  const result = await resolverCbtesAsocCanonico(db.client, {
    comprobanteId: NC_ID,
    businessId: BUSINESS_ID,
    tipoComprobante: 13,
    body: { cbteAsocTipo: 11, cbteAsocPtoVta: 10, cbteAsocNro: 45 },
  })

  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /no coincide con el tipo fiscal persistido/i)
  assert.equal(db.queries.length, 1, 'debe fallar antes de consultar el original')
})

test('facturas A/C rechazan un CbteTipo de attempt contradictorio antes de WSAA', async () => {
  for (const caso of [
    { tipo: 'factura_c', persistido: '11', attempt: 1 },
    { tipo: 'factura_c', persistido: '11', attempt: 99 },
    { tipo: 'factura_a', persistido: '1', attempt: 11 },
    { tipo: 'factura_c', persistido: '1', attempt: 1 },
  ]) {
    const db = supabaseFixture({
      [NC_ID]: {
        id: NC_ID,
        business_id: BUSINESS_ID,
        tipo: caso.tipo,
        tipo_comprobante_fiscal: caso.persistido,
      },
    })

    const result = await resolverCbtesAsocCanonico(db.client, {
      comprobanteId: NC_ID,
      businessId: BUSINESS_ID,
      tipoComprobante: caso.attempt,
      body: {},
    })

    assert.equal(result.ok, false, JSON.stringify(caso))
    assert.match(result.error ?? '', /no coincide con el tipo fiscal canónico/i)
    assert.equal(db.queries.length, 1)
  }
})

test('factura C canónica conserva el camino no-NC sin CbtesAsoc', async () => {
  const db = supabaseFixture({
    [NC_ID]: {
      id: NC_ID,
      business_id: BUSINESS_ID,
      tipo: 'factura_c',
      tipo_comprobante_fiscal: '11',
    },
  })

  const result = await resolverCbtesAsocCanonico(db.client, {
    comprobanteId: NC_ID,
    businessId: BUSINESS_ID,
    tipoComprobante: 11,
    body: {},
  })

  assert.equal(result.ok, true)
  assert.equal(db.queries.length, 1)
})

test('una factura rechaza CbtesAsoc elegido por el caller', async () => {
  const db = supabaseFixture({
    [NC_ID]: {
      id: NC_ID,
      business_id: BUSINESS_ID,
      tipo: 'factura_c',
      tipo_comprobante_fiscal: '11',
      comprobante_original_id: null,
    },
  })

  const result = await resolverCbtesAsocCanonico(db.client, {
    comprobanteId: NC_ID,
    businessId: BUSINESS_ID,
    tipoComprobante: 11,
    body: { cbteAsocTipo: 11, cbteAsocPtoVta: 10, cbteAsocNro: 45 },
  })

  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /sólo está permitido.*Nota de Crédito/i)
})

test('afip-cae resuelve y persiste el snapshot antes de WSAA, numeración y FECAESolicitar', () => {
  const index = readFileSync(new URL('../../supabase/functions/afip-cae/index.ts', import.meta.url), 'utf8')
  const gate = index.indexOf('await resolverCbtesAsocCanonico')
  const snapshot = index.indexOf('await persistirCbtesAsocSnapshot', gate)
  const wsaa = index.indexOf("supabase.functions.invoke('afip-wsaa'")
  const ultimo = index.indexOf('await getUltimoComprobante')
  const solicitar = index.indexOf('await solicitarCAEConReconciliacion')

  assert.ok(gate > -1, 'no se encontró el gate CbtesAsoc')
  assert.ok(snapshot > gate, 'el snapshot debe persistirse inmediatamente después del resolver')
  assert.ok(snapshot < wsaa, 'el snapshot debe persistirse antes de WSAA')
  assert.ok(snapshot < ultimo, 'el snapshot debe persistirse antes de reservar numeración')
  assert.ok(snapshot < solicitar, 'el snapshot debe persistirse antes de FECAESolicitar')
  assert.ok(gate < wsaa, 'el gate debe correr antes de WSAA')
  assert.ok(gate < ultimo, 'el gate debe correr antes de reservar numeración')
  assert.ok(gate < solicitar, 'el gate debe correr antes de FECAESolicitar')
})

test('la persistencia del snapshot es RPC service-role y falla cerrada ante error/rechazo', () => {
  const index = readFileSync(new URL('../../supabase/functions/afip-cae/index.ts', import.meta.url), 'utf8')
  const helperStart = index.indexOf('async function persistirCbtesAsocSnapshot')
  const helperEnd = index.indexOf('async function finalizarNotaCreditoAutorizada', helperStart)
  const helper = index.slice(helperStart, helperEnd)
  const call = index.indexOf('await persistirCbtesAsocSnapshot', helperEnd)
  const wsaa = index.indexOf("supabase.functions.invoke('afip-wsaa'", call)
  const failClosed = index.slice(call, wsaa)

  assert.ok(helperStart > -1)
  assert.match(helper, /supabase\.rpc\('snapshot_arca_nc_cbtes_asoc'/)
  assert.match(helper, /p_attempt_id:\s*params\.attemptId/)
  assert.match(helper, /p_original_id:\s*params\.originalId/)
  assert.match(helper, /error \|\| data\?\.success !== true/)
  assert.match(failClosed, /if \(!snapshot\.ok\)/)
  assert.match(failClosed, /return jsonResponse/)
})

test('Edge finaliza cada NC autorizada/reconciliada después de completeAttempt y antes de responder', () => {
  const index = readFileSync(new URL('../../supabase/functions/afip-cae/index.ts', import.meta.url), 'utf8')
  const helperStart = index.indexOf('async function finalizarNotaCreditoAutorizada')
  const handlerStart = index.indexOf('serve(async')
  const helper = index.slice(helperStart, handlerStart)

  assert.ok(helperStart > -1)
  assert.match(helper, /if \(!esNotaCreditoFiscal\(tipoComprobante\)\) return/)
  assert.match(helper, /supabase\.rpc\('create_credit_note_finance_reversal'/)
  assert.match(helper, /p_nc_id:\s*comprobanteId/)
  assert.match(helper, /return \{ pending: true \}/,
    'un fallo local no puede ocultar un CAE ya confirmado')
  assert.match(index, /finalization_pending:\s*finalizacionNc\.pending/)

  const llamadas = index.match(/await finalizarNotaCreditoAutorizada\(supabase, comprobante_id, tipo_comprobante, logCtx\)/g) ?? []
  assert.equal(llamadas.length, 2, 'debe cubrir reconciliación previa y autorización del request actual')

  const reconciliacion = index.slice(
    index.indexOf("await completeAttempt(supabase, attempt_id, 'authorized_reconciled'"),
    index.indexOf("if (consulta.status === 'query_failed')"),
  )
  assert.ok(reconciliacion.indexOf('completeAttempt') < reconciliacion.indexOf('finalizarNotaCreditoAutorizada'))
  assert.ok(reconciliacion.indexOf('finalizarNotaCreditoAutorizada') < reconciliacion.indexOf('return jsonResponse'))

  const terminal = index.slice(
    index.indexOf("case 'authorized':"),
    index.indexOf("case 'pending_reconciliation':"),
  )
  assert.ok(terminal.indexOf('completeAttempt') < terminal.indexOf('finalizarNotaCreditoAutorizada'))
  assert.ok(terminal.indexOf('finalizarNotaCreditoAutorizada') < terminal.indexOf('return jsonResponse'))
})
