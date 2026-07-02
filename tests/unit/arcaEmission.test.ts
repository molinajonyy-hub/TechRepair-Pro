/**
 * Auditoría ARCA/AFIP: endpoint WSFEv1 correcto, reintentos solo para errores
 * previos-al-envío, reconciliación idempotente (FECompConsultar) ante
 * resultados ambiguos, y un único flujo de emisión real (POS y Comprobantes
 * convergen en comprobanteService → ArcaService → afip-cae).
 *
 * Bug original (fase 1 de la auditoría, 2026-07-01):
 *  A) producción apuntaba a un hostname AFIP inválido (wsfe.afip.gov.ar /
 *     wsfev1.afip.gov.ar, sin registro DNS).
 *  B) la vista de detalle de Comprobantes reintentaba contra un servicio MOCK
 *     (facturacionService/afipService) que generaba un CAE falso en vez de
 *     llamar a ARCA real.
 *
 * Bug de fase 2 (este archivo, mismo día): un timeout/502/503/504 DESPUÉS de
 * enviar FECAESolicitar es ambiguo — ARCA pudo haber autorizado el comprobante
 * aunque la respuesta se pierda. Sin reconciliación, un reintento simplemente
 * pedía el siguiente número, arriesgando dos comprobantes fiscales para una
 * sola operación. Este archivo prueba que eso ya no puede pasar.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  resolveWsfeUrl,
  classifyFetchError,
  fetchWithRetry,
  ClassifiedFetchError,
  parseFECAEResponse,
  parseFECompConsultarResponse,
  consultarComprobante,
  solicitarCAEConReconciliacion,
  decidirTrasAmbiguo,
  RETRY_DELAYS_MS,
} from '../../supabase/functions/afip-cae/logic.ts'
import {
  classify as auditClassify,
  accionRecomendada as auditAccion,
  toCsv as auditToCsv,
  parseArgs as auditParseArgs,
} from '../../scripts/audit-arca-cae-integrity.mjs'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vercel', '_legacy'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = `${dir}/${entry}`
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|js|jsx|md)$/.test(entry)) out.push(full)
  }
  return out
}

const ctx = { correlationId: 'test', businessId: 'biz1', ambiente: 'produccion', stage: 'solicitar_cae' }

// ─────────────────────────────────────────────────────────────────────────
// ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────

test('producción usa exactamente servicios1.afip.gov.ar', () => {
  assert.equal(resolveWsfeUrl('produccion'), 'https://servicios1.afip.gov.ar/wsfev1/service.asmx')
})

test('homologación usa exactamente wswhomo.afip.gov.ar', () => {
  assert.equal(resolveWsfeUrl('homologacion'), 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx')
  assert.equal(resolveWsfeUrl('cualquier-otro-valor'), 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx')
})

test('no queda ninguna referencia productiva a wsfev1.afip.gov.ar / wsfe.afip.gov.ar', () => {
  const files = [
    ...walk(`${REPO_ROOT}src`),
    ...walk(`${REPO_ROOT}supabase/functions`),
    ...walk(`${REPO_ROOT}scripts`),
  ]
  const offenders: string[] = []
  for (const f of files) {
    const content = readFileSync(f, 'utf-8')
    if (/https?:\/\/wsfev1\.afip\.gov\.ar/i.test(content) || /https?:\/\/wsfe\.afip\.gov\.ar/i.test(content)) {
      offenders.push(f)
    }
  }
  assert.deepEqual(offenders, [], `Hostname AFIP inválido encontrado en: ${offenders.join(', ')}`)
})

// ─────────────────────────────────────────────────────────────────────────
// RETRY — clasificación de 3 categorías
// ─────────────────────────────────────────────────────────────────────────

test('DNS/host inválido/conexión rechazada → not_sent (previo al envío, reintentable)', () => {
  assert.equal(classifyFetchError(new Error('error sending request: dns error: failed to lookup address information')), 'not_sent')
  assert.equal(classifyFetchError(new Error('dns error: failed to lookup address information')), 'not_sent')
  assert.equal(classifyFetchError(new Error('connection refused')), 'not_sent')
  assert.equal(classifyFetchError(new Error('ECONNREFUSED')), 'not_sent')
})

test('timeout/connection reset → ambiguous (no reintentar FECAESolicitar a ciegas)', () => {
  assert.equal(classifyFetchError(new Error('connection reset by peer')), 'ambiguous')
  assert.equal(classifyFetchError(new Error('ECONNRESET')), 'ambiguous')
  assert.equal(classifyFetchError(new Error('request timed out')), 'ambiguous')
  assert.equal(classifyFetchError(new Error('socket hang up')), 'ambiguous')
})

test('rechazos fiscales y errores de validación se clasifican como fatales (no reintentar, no reconciliar)', () => {
  assert.equal(classifyFetchError(new Error('AFIP rechazó el comprobante: DocNro inválido')), 'fatal')
  assert.equal(classifyFetchError(new Error('WSFEv1 SOAP fault: punto de venta no habilitado')), 'fatal')
  assert.equal(classifyFetchError(new Error('No se obtuvo CAE en la respuesta de AFIP')), 'fatal')
})

test('backoff documentado: 3 intentos máximo, [0, 500, 1500]ms', () => {
  assert.deepEqual(RETRY_DELAYS_MS, [0, 500, 1500])
})

test('fetchWithRetry (retryAmbiguous=true, lectura idempotente): reintenta timeout y se recupera', async () => {
  let calls = 0
  const flaky = (async () => {
    calls++
    if (calls < 2) throw new Error('request timed out')
    return new Response('ok', { status: 200 })
  }) as typeof fetch

  const res = await fetchWithRetry('https://servicios1.afip.gov.ar/wsfev1/service.asmx', { method: 'POST' }, ctx, { fetchImpl: flaky, retryAmbiguous: true })
  assert.equal(res.status, 200)
  assert.equal(calls, 2)
})

test('fetchWithRetry (retryAmbiguous=false, FECAESolicitar): NO reintenta un timeout — lanza ClassifiedFetchError ambiguous en el primer intento', async () => {
  let calls = 0
  const flaky = (async () => { calls++; throw new Error('request timed out') }) as typeof fetch

  await assert.rejects(
    () => fetchWithRetry('https://servicios1.afip.gov.ar/wsfev1/service.asmx', { method: 'POST' }, ctx, { fetchImpl: flaky, retryAmbiguous: false }),
    (err: unknown) => err instanceof ClassifiedFetchError && err.classification === 'ambiguous'
  )
  assert.equal(calls, 1, 'un resultado ambiguo con retryAmbiguous=false no debe reintentarse ciegamente')
})

test('fetchWithRetry: not_sent siempre reintenta con backoff, incluso con retryAmbiguous=false', async () => {
  let calls = 0
  const flaky = (async () => {
    calls++
    if (calls < 3) throw new Error('connection refused')
    return new Response('ok', { status: 200 })
  }) as typeof fetch

  const res = await fetchWithRetry('https://servicios1.afip.gov.ar/wsfev1/service.asmx', { method: 'POST' }, ctx, { fetchImpl: flaky, retryAmbiguous: false })
  assert.equal(res.status, 200)
  assert.equal(calls, 3)
})

test('fetchWithRetry: error fatal nunca se reintenta', async () => {
  let calls = 0
  const fatalFetch = (async () => { calls++; throw new Error('invalid header value') }) as typeof fetch
  await assert.rejects(() => fetchWithRetry('https://servicios1.afip.gov.ar/wsfev1/service.asmx', { method: 'POST' }, ctx, { fetchImpl: fatalFetch }))
  assert.equal(calls, 1)
})

test('fetchWithRetry: 502/503/504 con retryAmbiguous=true se reintenta y se recupera', async () => {
  let calls = 0
  const flaky503 = (async () => {
    calls++
    return calls < 2 ? new Response('unavailable', { status: 503 }) : new Response('ok', { status: 200 })
  }) as typeof fetch
  const res = await fetchWithRetry('https://servicios1.afip.gov.ar/wsfev1/service.asmx', { method: 'POST' }, ctx, { fetchImpl: flaky503, retryAmbiguous: true })
  assert.equal(res.status, 200)
  assert.equal(calls, 2)
})

// ─────────────────────────────────────────────────────────────────────────
// parseFECAEResponse / parseFECompConsultarResponse
// ─────────────────────────────────────────────────────────────────────────

test('parseFECAEResponse: rechazo (Resultado=R) lanza — nunca pasa por retry', () => {
  assert.throws(() => parseFECAEResponse(`<Resultado>R</Resultado><Msg>Punto de venta no habilitado</Msg>`), /AFIP rechazó el comprobante/)
})

test('parseFECAEResponse: SOAP fault lanza', () => {
  assert.throws(() => parseFECAEResponse(`<faultcode>soap:Server</faultcode><faultstring>CUIT no autorizado</faultstring>`), /WSFEv1 SOAP fault/)
})

test('parseFECAEResponse: aprobado devuelve CAE', () => {
  const r = parseFECAEResponse(`<Resultado>A</Resultado><CAE>70123456789012</CAE><CAEFchVto>20261231</CAEFchVto><CbteDesde>42</CbteDesde>`)
  assert.equal(r.cae, '70123456789012')
  assert.equal(r.cae_vencimiento, '2026-12-31')
  assert.equal(r.numero_cbte, 42)
})

test('parseFECompConsultarResponse: comprobante encontrado y autorizado', () => {
  const xml = `<FECompConsultarResult><ResultGet><CodAutorizacion>70999888777666</CodAutorizacion><FchVto>20261231</FchVto><Resultado>A</Resultado><CbteDesde>42</CbteDesde></ResultGet></FECompConsultarResult>`
  const r = parseFECompConsultarResponse(xml)
  assert.equal(r.status, 'found')
  assert.equal(r.cae, '70999888777666')
  assert.equal(r.cae_vencimiento, '2026-12-31')
  assert.equal(r.numero_cbte, 42)
})

test('parseFECompConsultarResponse: comprobante inexistente (602) → not_found', () => {
  const xml = `<FECompConsultarResult><Errors><Err><Code>602</Code><Msg>No se encontro el comprobante solicitado.</Msg></Err></Errors></FECompConsultarResult>`
  const r = parseFECompConsultarResponse(xml)
  assert.equal(r.status, 'not_found')
})

test('parseFECompConsultarResponse: otro código de error de AFIP → query_failed (NUNCA asumir not_found)', () => {
  const xml = `<FECompConsultarResult><Errors><Err><Code>500</Code><Msg>Error interno de AFIP</Msg></Err></Errors></FECompConsultarResult>`
  const r = parseFECompConsultarResponse(xml)
  assert.equal(r.status, 'query_failed')
})

test('parseFECompConsultarResponse: SOAP fault → query_failed', () => {
  const xml = `<faultcode>soap:Server</faultcode><faultstring>Token expirado</faultstring>`
  assert.equal(parseFECompConsultarResponse(xml).status, 'query_failed')
})

test('parseFECompConsultarResponse: XML incompleto (ni CAE ni Errors) → query_failed', () => {
  assert.equal(parseFECompConsultarResponse(`<FECompConsultarResult></FECompConsultarResult>`).status, 'query_failed')
})

test('parseFECompConsultarResponse: respuesta con observaciones se preservan', () => {
  const xml = `<FECompConsultarResult><ResultGet><CodAutorizacion>701</CodAutorizacion><FchVto>20261231</FchVto><Resultado>A</Resultado><CbteDesde>1</CbteDesde><Observaciones><Obs><Msg>Observación de prueba</Msg></Obs></Observaciones></ResultGet></FECompConsultarResult>`
  const r = parseFECompConsultarResponse(xml)
  assert.equal(r.status, 'found')
  assert.match(r.observaciones || '', /Observación de prueba/)
})

// ─────────────────────────────────────────────────────────────────────────
// consultarComprobante — nunca lanza, siempre degrada a query_failed
// ─────────────────────────────────────────────────────────────────────────

test('consultarComprobante: timeout de la consulta → query_failed (no lanza)', async () => {
  const alwaysTimeout = (async () => { throw new Error('request timed out') }) as typeof fetch
  const r = await consultarComprobante('t', 's', '20123456789', 1, 11, 42, 'produccion', { correlationId: 'x', businessId: 'biz1' }, alwaysTimeout)
  assert.equal(r.status, 'query_failed')
})

// ─────────────────────────────────────────────────────────────────────────
// RECONCILIACIÓN — el corazón del fix de idempotencia
// ─────────────────────────────────────────────────────────────────────────

function paramsBase() {
  return {
    token: 't', sign: 's', cuit: '20123456789',
    puntoVenta: 1, tipoComprobante: 11,
    cbteDesde: 42, cbteHasta: 42,
    tipoDocReceptor: 99, nroDocReceptor: '0',
    concepto: 1, fechaCbte: '20260701',
    importeNeto: 1000, importeIva: 0, alicuotaIva: 0, importeTotal: 1000,
    moneda: 'PES', cotizacion: 1,
    ambiente: 'produccion',
  }
}

test('reconciliación: timeout tras enviar FECAESolicitar y FECompConsultar encuentra el comprobante → authorized_reconciled (NO pide número nuevo)', async () => {
  let solicitarCalls = 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = String(init.body || '')
    if (body.includes('FECAESolicitar')) {
      solicitarCalls++
      throw new Error('request timed out') // ambiguo
    }
    if (body.includes('FECompConsultar')) {
      return new Response(`<FECompConsultarResult><ResultGet><CodAutorizacion>70111222333444</CodAutorizacion><FchVto>20261231</FchVto><Resultado>A</Resultado><CbteDesde>42</CbteDesde></ResultGet></FECompConsultarResult>`, { status: 200 })
    }
    throw new Error('unexpected SOAP action in test')
  }) as typeof fetch

  const outcome = await solicitarCAEConReconciliacion(paramsBase(), { correlationId: 'x', businessId: 'biz1' }, fetchImpl)
  assert.equal(outcome.kind, 'authorized_reconciled')
  assert.equal((outcome as any).cae, '70111222333444')
  assert.equal(solicitarCalls, 1, 'no debe reintentar FECAESolicitar cuando la reconciliación encuentra el comprobante')
})

test('reconciliación: FECompConsultar confirma not_found (dos veces) + último autorizado < intentado → reintenta FECAESolicitar UNA vez con el MISMO número (no avanza)', async () => {
  let solicitarCalls = 0
  const cbtesUsados: number[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = String(init.body || '')
    if (body.includes('FECAESolicitar')) {
      solicitarCalls++
      const m = body.match(/<ar:CbteDesde>(\d+)<\/ar:CbteDesde>/)
      cbtesUsados.push(m ? parseInt(m[1], 10) : -1)
      if (solicitarCalls === 1) throw new Error('request timed out') // primer intento ambiguo
      return new Response(`<Resultado>A</Resultado><CAE>70555666777888</CAE><CAEFchVto>20261231</CAEFchVto><CbteDesde>42</CbteDesde>`, { status: 200 })
    }
    if (body.includes('FECompConsultar')) {
      return new Response(`<FECompConsultarResult><Errors><Err><Code>602</Code><Msg>No encontrado</Msg></Err></Errors></FECompConsultarResult>`, { status: 200 })
    }
    if (body.includes('FECompUltimoAutorizado')) {
      return new Response(`<CbteNro>40</CbteNro>`, { status: 200 }) // 40 < 42 intentado → CASO A
    }
    throw new Error('unexpected SOAP action in test')
  }) as typeof fetch

  const outcome = await solicitarCAEConReconciliacion(paramsBase(), { correlationId: 'x', businessId: 'biz1' }, fetchImpl)
  assert.equal(outcome.kind, 'authorized_reconciled')
  assert.equal((outcome as any).cae, '70555666777888')
  assert.equal(solicitarCalls, 2, 'se permite exactamente un reenvío, solo tras confirmar not_found')
  assert.deepEqual(cbtesUsados, [42, 42], 'el reenvío debe usar el MISMO número — nunca avanza al siguiente sin confirmación')
})

test('reconciliación: FECompConsultar también falla (query_failed) → pending_reconciliation, NUNCA inventa CAE ni reintenta más', async () => {
  let solicitarCalls = 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = String(init.body || '')
    if (body.includes('FECAESolicitar')) { solicitarCalls++; throw new Error('request timed out') }
    if (body.includes('FECompConsultar')) { throw new Error('request timed out') } // la propia consulta también falla
    throw new Error('unexpected SOAP action in test')
  }) as typeof fetch

  const outcome = await solicitarCAEConReconciliacion(paramsBase(), { correlationId: 'x', businessId: 'biz1' }, fetchImpl)
  assert.equal(outcome.kind, 'pending_reconciliation')
  assert.equal(solicitarCalls, 1, 'si ni siquiera se puede reconciliar, no se reintenta FECAESolicitar')
  assert.equal((outcome as any).numeroIntentado, 42)
})

test('reconciliación: not_found confirmado pero el reenvío TAMBIÉN es ambiguo → pending_reconciliation (nunca un 2do reenvío, nunca inventa CAE)', async () => {
  let solicitarCalls = 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = String(init.body || '')
    if (body.includes('FECAESolicitar')) { solicitarCalls++; throw new Error('request timed out') } // ambiguo SIEMPRE
    if (body.includes('FECompConsultar')) {
      return new Response(`<FECompConsultarResult><Errors><Err><Code>602</Code><Msg>No encontrado</Msg></Err></Errors></FECompConsultarResult>`, { status: 200 })
    }
    if (body.includes('FECompUltimoAutorizado')) {
      return new Response(`<CbteNro>40</CbteNro>`, { status: 200 }) // 40 < 42 intentado → CASO A ambas veces
    }
    throw new Error('unexpected SOAP action in test')
  }) as typeof fetch

  const outcome = await solicitarCAEConReconciliacion(paramsBase(), { correlationId: 'x', businessId: 'biz1' }, fetchImpl)
  assert.equal(outcome.kind, 'pending_reconciliation')
  assert.equal(solicitarCalls, 2, 'como mucho un reenvío (MAX_RECONCILIATION_ROUNDS=1)')
})

test('reconciliación: rechazo fiscal directo (sin ambigüedad) → rejected, nunca reconcilia', async () => {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = String(init.body || '')
    if (body.includes('FECAESolicitar')) return new Response(`<Resultado>R</Resultado><Msg>CUIT no autorizado</Msg>`, { status: 200 })
    throw new Error('no debería llamar a FECompConsultar en un rechazo limpio')
  }) as typeof fetch

  const outcome = await solicitarCAEConReconciliacion(paramsBase(), { correlationId: 'x', businessId: 'biz1' }, fetchImpl)
  assert.equal(outcome.kind, 'rejected')
})

test('reconciliación: DNS previo al envío (not_sent) agotado → not_sent, nunca reconcilia', async () => {
  const fetchImpl = (async () => { throw new Error('dns error: failed to lookup address information') }) as typeof fetch
  const outcome = await solicitarCAEConReconciliacion(paramsBase(), { correlationId: 'x', businessId: 'biz1' }, fetchImpl)
  assert.equal(outcome.kind, 'not_sent')
})

// ─────────────────────────────────────────────────────────────────────────
// Un único flujo de emisión: POS y Comprobantes convergen en comprobanteService
// ─────────────────────────────────────────────────────────────────────────

test('POS (ComprobanteProModal) emite vía comprobanteService.crear → ArcaService.emitirFactura', () => {
  const modal = read('../../src/components/comprobantes/ComprobanteProModal.tsx')
  assert.match(modal, /import\s*\{[^}]*comprobanteService[^}]*\}\s*from\s*'\.\.\/\.\.\/services\/comprobanteService'/)
  assert.match(modal, /comprobanteService\.crear\(/)
})

test('Comprobantes (detalle/retry) emite vía comprobanteService.emitir — NO vía el mock afipService/facturacionService', () => {
  const page = read('../../src/pages/Comprobante.tsx')
  assert.match(page, /comprobanteService\.emitir\(/)
  assert.doesNotMatch(page, /from '\.\.\/hooks\/useComprobantes'/, 'no debe usar el hook legacy con AFIP mock')
  assert.doesNotMatch(page, /facturacionService\.emitirComprobante\(comprobanteActual/, 'no debe emitir CAE vía el servicio mock')
})

test('_claimYEmitirArca es la ÚNICA puerta a ArcaService.emitirFactura; crear/emitir/crearNotaCredito la usan', () => {
  const service = read('../../src/services/comprobanteService.ts')
  const directArcaCalls = service.match(/ArcaService\.emitirFactura\(/g) ?? []
  assert.equal(directArcaCalls.length, 1, '_claimYEmitirArca debe ser la ÚNICA llamadora directa de ArcaService.emitirFactura')

  const claimCalls = service.match(/this\._claimYEmitirArca\(/g) ?? []
  assert.equal(claimCalls.length, 3, 'crear(), emitir() y crearNotaCredito() deben usar _claimYEmitirArca')
})

test('_claimYEmitirArca reclama atómicamente vía RPC (DB) antes de llamar a ARCA — no un guard en memoria', () => {
  const service = read('../../src/services/comprobanteService.ts')
  assert.match(service, /supabase\.rpc\('claim_comprobante_arca_emission'/)
})

test('arcaService.emitirFactura exige comprobante_id + attempt_id (no se puede emitir sin haber reclamado antes)', () => {
  const arcaService = read('../../src/services/arcaService.ts')
  assert.match(arcaService, /comprobante_id: string\s*\n\s*attempt_id: string/)

  const arcaService2 = read('../../supabase/functions/afip-cae/index.ts')
  assert.match(arcaService2, /if \(!comprobante_id \|\| !attempt_id\)/)
})

test('comprobanteService.crear/emitir/crearNotaCredito son las únicas rutas al edge function afip-cae (vía ArcaService)', () => {
  const arcaService = read('../../src/services/arcaService.ts')
  assert.match(arcaService, /supabase\.functions\.invoke\('afip-cae'/)
})

// ─────────────────────────────────────────────────────────────────────────
// FASE 2 — crear() reordenado: el comprobante existe ANTES de llamar a ARCA
// ─────────────────────────────────────────────────────────────────────────

function crearFnSource(): string {
  const service = read('../../src/services/comprobanteService.ts')
  return service.slice(service.indexOf('async crear(input'), service.indexOf('// ── Emitir borrador'))
}

// NOTA (auditoría idempotencia de checkout, 2026-07-01): comprobante, ítems,
// stock y pagos ya NO se insertan directamente en crear() — se creó
// create_comprobante_checkout_atomic (supabase/migrations/
// 20260701170000_comprobante_checkout_idempotency.sql), que hace todo eso en
// UNA transacción PostgreSQL atómica. crear() ahora llama a esa RPC y recién
// con el comprobante_id que devuelve llama a _claimYEmitirArca. El orden
// "creación local antes de ARCA" se mantiene, solo que la creación local es
// ahora una única llamada a RPC en vez de varios inserts JS sueltos — ver
// financeIndependence.test.ts para el detalle de qué pasa DENTRO de la RPC.

test('crear(): la RPC de creación local (create_comprobante_checkout_atomic) se llama y confirma ANTES de reclamar/emitir en ARCA', () => {
  const crearFn = crearFnSource()
  const idxRpc = crearFn.indexOf("supabase.rpc('create_comprobante_checkout_atomic'")
  const idxClaim = crearFn.indexOf('this._claimYEmitirArca(')
  assert.ok(idxRpc > 0, 'no se encontró la llamada a create_comprobante_checkout_atomic en crear()')
  assert.ok(idxClaim > 0, 'no se encontró la llamada a _claimYEmitirArca en crear()')
  assert.ok(idxRpc < idxClaim, 'la RPC de creación local debe llamarse ANTES de intentar emitir en ARCA — nunca al revés')
})

test('crear(): el comprobante_id devuelto por la RPC (compId) es lo que se pasa a _claimYEmitirArca — nunca se emite sin identidad local', () => {
  const crearFn = crearFnSource();
  assert.match(crearFn, /this\._claimYEmitirArca\(business_id, compId,/);
})

test('crear(): un fallo o ambigüedad de ARCA no borra ni revierte el comprobante ni el cobro ya creado por la RPC', () => {
  const crearFn = crearFnSource();
  const idxClaim = crearFn.indexOf('this._claimYEmitirArca(');
  const afterClaim = crearFn.slice(idxClaim);
  assert.doesNotMatch(afterClaim, /\.delete\(\)/, 'no debe haber ningún delete después de intentar ARCA');
})

test('crear(): stock y pagos de caja quedan confirmados (dentro de la RPC atómica) ANTES de intentar ARCA', () => {
  const migration = read('../../supabase/migrations/20260701170000_comprobante_checkout_idempotency.sql')
  const rpcStart = migration.indexOf('CREATE OR REPLACE FUNCTION "public"."create_comprobante_checkout_atomic"')
  const rpcEnd = migration.indexOf('ALTER FUNCTION "public"."create_comprobante_checkout_atomic"', rpcStart)
  const rpcBody = migration.slice(rpcStart, rpcEnd)
  assert.doesNotMatch(rpcBody, /claim_comprobante_arca_emission|arca_emission_attempts/,
    'la RPC de creación local nunca debe invocar el flujo ARCA — stock/pagos quedan confirmados (commit) mucho antes de que el cliente siquiera intente ARCA, en una llamada JS separada posterior')
})

// ─────────────────────────────────────────────────────────────────────────
// IDEMPOTENCIA
// ─────────────────────────────────────────────────────────────────────────

test('comprobanteService.emitir tiene un atajo rápido si ya tiene CAE (además del claim atómico real)', () => {
  const service = read('../../src/services/comprobanteService.ts')
  assert.match(service, /if \(comp\.cae \|\| comp\.estado_fiscal === 'emitido'\)/)
})

test('_descontarStock tiene guard de idempotencia (stock_processed) — no descuenta dos veces', () => {
  const service = read('../../src/services/comprobanteService.ts')
  assert.match(service, /stock_processed/)
})

test('complete_arca_attempt (RPC) nunca pisa un comprobante ya resuelto (guard AND cae IS NULL)', () => {
  const migration = read('../../supabase/migrations/20260701150000_arca_atomic_claim.sql')
  const guards = migration.match(/AND cae IS NULL/g) ?? []
  assert.ok(guards.length >= 3, 'complete_arca_attempt debe guardar cada UPDATE de comprobantes con AND cae IS NULL')
})

// ─────────────────────────────────────────────────────────────────────────
// CONCURRENCIA — el mecanismo real vive en DB (índice único parcial), NO en
// memoria. La prueba de concurrencia VERDADERA (dos claims simultáneos) es
// supabase/tests/arca_atomic_claim_test.sql — acá solo confirmamos que el
// código está efectivamente cableado a ese mecanismo (no un guard JS solo).
// ─────────────────────────────────────────────────────────────────────────

test('el mecanismo de exclusión mutua POR COMPROBANTE es un índice único parcial en DB, no una variable en memoria', () => {
  const migration = read('../../supabase/migrations/20260701150000_arca_atomic_claim.sql')
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "idx_arca_attempt_one_live_per_comprobante"/)
  assert.match(migration, /WHERE \("status" IN \('claimed', 'number_reserved', 'sent'\)\)/)
})

test('el mecanismo de exclusión mutua POR SERIE FISCAL (ambiente+cuit+punto_venta+tipo) es un índice único parcial en DB', () => {
  const migration = read('../../supabase/migrations/20260701150000_arca_atomic_claim.sql')
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "idx_arca_attempt_one_live_per_serie"/)
  assert.match(migration, /ON "public"\."arca_emission_attempts" \("ambiente", "cuit_emisor", "punto_venta", "tipo_comprobante"\)/)
  assert.match(migration, /WHERE \("status" IN \('claimed', 'number_reserved', 'sent', 'pending_reconciliation'\)\)/)
})

test('claim_comprobante_arca_emission distingue un intento sent/number_reserved (ambiguo, nunca se libera solo) de uno claimed (recuperable)', () => {
  const migration = read('../../supabase/migrations/20260701150000_arca_atomic_claim.sql')
  assert.match(migration, /v_existing_mine\.status = 'claimed' AND v_existing_mine\.started_at < now\(\) - INTERVAL '2 minutes'/)
  assert.match(migration, /-- 'number_reserved'\/'sent' \(ambiguo, ya en tránsito\) NUNCA se libera solo\./)
})

test('claim_comprobante_arca_emission valida ownership vía auth.uid() — nunca confía en business_id/serie del cliente', () => {
  const migration = read('../../supabase/migrations/20260701150000_arca_atomic_claim.sql')
  assert.match(migration, /CREATE OR REPLACE FUNCTION "public"\."claim_comprobante_arca_emission"\(\s*\n\s*"p_comprobante_id" uuid,\s*\n\s*"p_correlation_id" text\s*\n\)/, 'la firma debe ser solo (p_comprobante_id, p_correlation_id) — sin punto_venta/tipo/ambiente/business_id del cliente');
  assert.match(migration, /owner_user_id = auth\.uid\(\)/);
})

test('la identidad de serie (ambiente/cuit/punto_venta/tipo) se resuelve 100% server-side desde arca_config y comprobantes.tipo', () => {
  const migration = read('../../supabase/migrations/20260701150000_arca_atomic_claim.sql')
  assert.match(migration, /FROM arca_config WHERE business_id = v_comp\.business_id/)
  assert.match(migration, /v_cuit := regexp_replace\(v_cuit_raw, '\\D', '', 'g'\)/)
})

test('reserve_arca_number / mark_arca_attempt_sent / complete_arca_attempt son EXCLUSIVAS de service_role (nunca callables desde el browser)', () => {
  const migration = read('../../supabase/migrations/20260701150000_arca_atomic_claim.sql')
  assert.match(migration, /GRANT EXECUTE ON FUNCTION "public"\."reserve_arca_number"\(uuid, integer\) TO "service_role";/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION "public"\."mark_arca_attempt_sent"\(uuid\) TO "service_role";/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION "public"\."complete_arca_attempt"\([^)]*\) TO "service_role";/)
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION "public"\."mark_arca_attempt_sent"\(uuid\) TO "authenticated"/)
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION "public"\."reserve_arca_number"\(uuid, integer\) TO "authenticated"/)
})

test('reserve_arca_number persiste el número ANTES de mark_arca_attempt_sent (claimed → number_reserved → sent)', () => {
  const migration = read('../../supabase/migrations/20260701150000_arca_atomic_claim.sql')
  assert.match(migration, /SET status = 'number_reserved', numero_intentado = p_numero, updated_at = now\(\)\s*\n\s*WHERE id = p_attempt_id AND status = 'claimed'/)
  assert.match(migration, /SET status = 'sent', sent_at = now\(\), updated_at = now\(\)\s*\n\s*WHERE id = p_attempt_id AND status = 'number_reserved'/)
})

test('crearNotaCredito usa el mismo mecanismo de claim/idempotencia que comprobantes normales (respeta su propia serie)', () => {
  const service = read('../../src/services/comprobanteService.ts')
  const ncFn = service.slice(service.indexOf('async crearNotaCredito'), service.indexOf('async eliminar('))
  assert.match(ncFn, /this\._claimYEmitirArca\(params\.businessId, ncId,/)
})

test('_claimYEmitirArca ya NO envía punto_venta/tipo_comprobante/ambiente al reclamar (server-side los resuelve)', () => {
  const service = read('../../src/services/comprobanteService.ts')
  const claimFn = service.slice(service.indexOf('async _claimYEmitirArca'), service.indexOf('const result = claimData?.result'))
  assert.doesNotMatch(claimFn, /p_punto_venta/)
  assert.doesNotMatch(claimFn, /p_tipo_comprobante/)
  assert.doesNotMatch(claimFn, /p_ambiente/)
  assert.match(claimFn, /p_comprobante_id: comprobanteId/)
  assert.match(claimFn, /p_correlation_id: correlationId/)
})

// ─────────────────────────────────────────────────────────────────────────
// FASE 5 — endurecer not_found: matriz de 5 casos (decidirTrasAmbiguo)
// ─────────────────────────────────────────────────────────────────────────

function reconParamsBase() {
  return { token: 't', sign: 's', cuit: '20123456789', puntoVenta: 1, tipoComprobante: 11, numeroIntentado: 42, ambiente: 'produccion' }
}

function soapFetchImpl(handlers: { consultar?: () => Response | Promise<Response>; ultimoAutorizado?: () => Response | Promise<Response> }) {
  let consultarCalls = 0
  return (async (url: string, init: RequestInit) => {
    const body = String(init.body || '')
    if (body.includes('FECompConsultar')) {
      consultarCalls++
      if (!handlers.consultar) throw new Error('unexpected FECompConsultar call in test')
      return handlers.consultar()
    }
    if (body.includes('FECompUltimoAutorizado')) {
      if (!handlers.ultimoAutorizado) throw new Error('unexpected FECompUltimoAutorizado call in test')
      return handlers.ultimoAutorizado()
    }
    throw new Error('unexpected SOAP action in test: ' + body.slice(0, 60))
  }) as typeof fetch
}

test('CASO C: FECompConsultar encuentra el comprobante en la PRIMERA consulta → authorized_reconciled', async () => {
  const fetchImpl = soapFetchImpl({
    consultar: () => new Response(`<FECompConsultarResult><ResultGet><CodAutorizacion>701</CodAutorizacion><FchVto>20261231</FchVto><Resultado>A</Resultado><CbteDesde>42</CbteDesde></ResultGet></FECompConsultarResult>`, { status: 200 }),
  })
  const decision = await decidirTrasAmbiguo(reconParamsBase(), { correlationId: 'x', businessId: 'biz1' }, fetchImpl)
  assert.equal(decision.kind, 'authorized_reconciled')
  assert.equal((decision as any).cae, '701')
})

test('CASO C: FECompConsultar encuentra el comprobante recién en la SEGUNDA consulta (tras backoff) → authorized_reconciled', async () => {
  let calls = 0
  const fetchImpl = soapFetchImpl({
    consultar: () => {
      calls++
      if (calls === 1) return new Response(`<FECompConsultarResult><Errors><Err><Code>602</Code><Msg>No encontrado</Msg></Err></Errors></FECompConsultarResult>`, { status: 200 })
      return new Response(`<FECompConsultarResult><ResultGet><CodAutorizacion>702</CodAutorizacion><FchVto>20261231</FchVto><Resultado>A</Resultado><CbteDesde>42</CbteDesde></ResultGet></FECompConsultarResult>`, { status: 200 })
    },
  })
  const decision = await decidirTrasAmbiguo(reconParamsBase(), { correlationId: 'x', businessId: 'biz1' }, fetchImpl)
  assert.equal(decision.kind, 'authorized_reconciled')
  assert.equal((decision as any).cae, '702')
  assert.equal(calls, 2, 'debe haber consultado dos veces antes de encontrarlo')
})

test('CASO A: doble not_found + último autorizado < número intentado → safe_resend', async () => {
  const fetchImpl = soapFetchImpl({
    consultar: () => new Response(`<FECompConsultarResult><Errors><Err><Code>602</Code><Msg>No encontrado</Msg></Err></Errors></FECompConsultarResult>`, { status: 200 }),
    ultimoAutorizado: () => new Response(`<CbteNro>40</CbteNro>`, { status: 200 }), // 40 < 42 intentado
  })
  const decision = await decidirTrasAmbiguo(reconParamsBase(), { correlationId: 'x', businessId: 'biz1' }, fetchImpl)
  assert.equal(decision.kind, 'safe_resend')
})

test('CASO B: último autorizado >= número intentado PERO FECompConsultar no lo recupera → pending_reconciliation (nunca reenviar)', async () => {
  const fetchImpl = soapFetchImpl({
    consultar: () => new Response(`<FECompConsultarResult><Errors><Err><Code>602</Code><Msg>No encontrado</Msg></Err></Errors></FECompConsultarResult>`, { status: 200 }),
    ultimoAutorizado: () => new Response(`<CbteNro>50</CbteNro>`, { status: 200 }), // 50 >= 42 intentado: inconsistencia
  })
  const decision = await decidirTrasAmbiguo(reconParamsBase(), { correlationId: 'x', businessId: 'biz1' }, fetchImpl)
  assert.equal(decision.kind, 'pending_reconciliation')
  assert.match((decision as any).message, /Inconsistencia/)
})

test('CASO D: la consulta falla (query_failed) → pending_reconciliation, nunca reenviar', async () => {
  const fetchImpl = soapFetchImpl({
    consultar: () => { throw new Error('request timed out') },
  })
  const decision = await decidirTrasAmbiguo(reconParamsBase(), { correlationId: 'x', businessId: 'biz1' }, fetchImpl)
  assert.equal(decision.kind, 'pending_reconciliation')
})

test('CASO D: FECompUltimoAutorizado falla tras doble not_found → pending_reconciliation, nunca reenviar', async () => {
  const fetchImpl = soapFetchImpl({
    consultar: () => new Response(`<FECompConsultarResult><Errors><Err><Code>602</Code><Msg>No encontrado</Msg></Err></Errors></FECompConsultarResult>`, { status: 200 }),
    ultimoAutorizado: () => { throw new Error('dns error: failed to lookup address information') },
  })
  const decision = await decidirTrasAmbiguo(reconParamsBase(), { correlationId: 'x', businessId: 'biz1' }, fetchImpl)
  assert.equal(decision.kind, 'pending_reconciliation')
})

// ─────────────────────────────────────────────────────────────────────────
// MOCKS FISCALES — bloqueados, no alcanzables en runtime de producción
// ─────────────────────────────────────────────────────────────────────────

// Nota: facturacionService.ts importa src/lib/supabase.ts, que lanza si
// import.meta.env.VITE_SUPABASE_URL no está seteado (siempre el caso bajo
// `node --test`, fuera de Vite). Igual que el resto de la suite para módulos
// que dependen de Vite (ver whatsappSendContracts.test.ts), se verifica por
// contrato de texto fuente en vez de importar el módulo real.

test('afipService.solicitarCAE está bloqueado — nunca fabrica un CAE (por contrato de fuente)', () => {
  const service = read('../../src/services/facturacionService.ts')
  assert.match(service, /async solicitarCAE\([^)]*\):\s*Promise<\{/)
  assert.match(service, /solicitarCAE\(\) está deshabilitado: nunca debe fabricar un CAE/)
  // No debe quedar código alcanzable que arme una respuesta mock con Math.random.
  const solicitarCAEBody = service.slice(service.indexOf('async solicitarCAE'), service.indexOf('generarCAEFake'))
  assert.doesNotMatch(solicitarCAEBody, /Math\.random/)
})

test('afipService.generarCAEFake está bloqueado (por contrato de fuente)', () => {
  const service = read('../../src/services/facturacionService.ts')
  assert.match(service, /generarCAEFake\(\): string \{\s*\n\s*throw new Error/)
})

test('facturacionServiceMock.emitirComprobante (huérfano) está bloqueado — no fabrica CAE ni en memoria (por contrato de fuente)', () => {
  const mock = read('../../src/services/facturacionService.mock.ts')
  assert.match(mock, /emitirComprobante\(_id: string\)[\s\S]*?\{\s*\n\s*throw new Error/)
  assert.match(mock, /nunca debe fabricar un CAE/)
})

test('facturacionService.mock.ts y useComprobantes.mock.ts no tienen ningún import externo (huérfanos confirmados)', () => {
  const files = walk(`${REPO_ROOT}src`).filter(f => !f.endsWith('facturacionService.mock.ts') && !f.endsWith('useComprobantes.mock.ts'))
  const offenders = files.filter(f => {
    const c = readFileSync(f, 'utf-8')
    return /facturacionService\.mock|useComprobantes\.mock|facturacionServiceMock/.test(c)
  })
  assert.deepEqual(offenders, [], `Archivos huérfanos referenciados inesperadamente desde: ${offenders.join(', ')}`)
})

test('no queda ningún Math.random() usado para generar un CAE en código productivo', () => {
  const files = walk(`${REPO_ROOT}src`).filter(f => !f.includes('.mock.'))
  const offenders: string[] = []
  for (const f of files) {
    const content = readFileSync(f, 'utf-8')
    // Busca Math.random() en líneas que también mencionen "cae" (case-insensitive),
    // excluyendo los bloqueos explícitos que solo lanzan un Error.
    const lines = content.split('\n')
    lines.forEach((line, i) => {
      if (/math\.random/i.test(line) && /cae/i.test(line) && !/throw new Error/.test(lines[i])) {
        offenders.push(`${f}:${i + 1}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `Posible generación de CAE con Math.random() en: ${offenders.join(', ')}`)
})

// ─────────────────────────────────────────────────────────────────────────
// ANULACIÓN — un comprobante con CAE no se anula localmente
// ─────────────────────────────────────────────────────────────────────────

test('anular() bloquea comprobantes con CAE y exige Nota de Crédito', () => {
  const service = read('../../src/services/comprobanteService.ts')
  assert.match(service, /if \(comp\.cae\) \{\s*\n\s*return \{\s*\n\s*success: false,/)
  assert.match(service, /requiereNotaCredito: true/)
});

test('anular() sigue permitiendo cancelar un borrador sin CAE (no rompe el flujo normal)', () => {
  const service = read('../../src/services/comprobanteService.ts')
  // El guard de CAE debe estar ANTES del bloque de reversión de stock/finanzas,
  // que sigue existiendo para el caso sin CAE.
  const idxGuard = service.indexOf('requiereNotaCredito: true');
  const idxRevertirStock = service.indexOf('_revertirStock(');
  assert.ok(idxGuard > 0 && idxRevertirStock > idxGuard, 'el guard de CAE debe evaluarse antes de revertir stock');
});

test('UI: el botón "Anular" se oculta cuando el comprobante ya tiene CAE (dirige a Nota de Crédito)', () => {
  const actions = read('../../src/components/comprobantes/ComprobanteActions.tsx');
  assert.match(actions, /esEmitido && !comprobante\.cae/);
});

test('crearNotaCredito no anula el original si ARCA queda pendiente de conciliación', () => {
  const service = read('../../src/services/comprobanteService.ts');
  assert.match(service, /estadoFiscalNc\s*=\s*'pendiente_conciliacion'/);
  assert.match(service, /if \(estadoFiscalNc === 'emitido'\) \{/);
});

// ─────────────────────────────────────────────────────────────────────────
// UI: mensajes amigables (sin detalle técnico crudo)
// ─────────────────────────────────────────────────────────────────────────

test('mensaje de error de conectividad ARCA es el copy aprobado', () => {
  const service = read('../../src/services/comprobanteService.ts');
  assert.match(service, /No se pudo conectar con ARCA/);
  assert.match(service, /El cobro quedó registrado y el comprobante quedó pendiente de emisión\. Podés reintentarlo desde Comprobantes\./);
});

test('mensaje de reconciliación pendiente es el copy aprobado', () => {
  const service = read('../../src/services/comprobanteService.ts');
  assert.match(service, /Emisión pendiente de verificación/);
  assert.match(service, /No vuelvas a emitir el comprobante hasta completar la verificación automática\./);
});

// ─────────────────────────────────────────────────────────────────────────
// AUDITORÍA — script read-only de CAE históricos
// ─────────────────────────────────────────────────────────────────────────

test('auditoría: comprobante confirmado en ARCA (CAE coincide)', () => {
  const r = auditClassify(
    { punto_venta_num: 1, numero_num: 42, tipo_comprobante_fiscal: '11', cae: 'ABC123' },
    { status: 'found', cae: 'ABC123' }
  )
  assert.equal(r.status, 'confirmed_in_arca')
})

test('auditoría: comprobante NO encontrado en ARCA → sospechoso, requiere revisión manual', () => {
  const r = auditClassify(
    { punto_venta_num: 1, numero_num: 42, tipo_comprobante_fiscal: '11', cae: 'FAKE000' },
    { status: 'not_found' }
  )
  assert.equal(r.status, 'not_found_in_arca')
  assert.match(auditAccion(r.status), /revisión manual/)
})

test('auditoría: CAE local distinto del CAE real de ARCA → data_mismatch', () => {
  const r = auditClassify(
    { punto_venta_num: 1, numero_num: 42, tipo_comprobante_fiscal: '11', cae: 'LOCAL999' },
    { status: 'found', cae: 'REAL111' }
  )
  assert.equal(r.status, 'data_mismatch')
})

test('auditoría: datos locales insuficientes para construir FECompConsultar', () => {
  const r = auditClassify({ punto_venta_num: null, numero_num: null, tipo_comprobante_fiscal: null, cae: 'X' }, { status: 'found' })
  assert.equal(r.status, 'insufficient_data')
})

test('auditoría: consulta a ARCA fallida → query_failed (reintentable, no se asume nada)', () => {
  const r = auditClassify(
    { punto_venta_num: 1, numero_num: 1, tipo_comprobante_fiscal: '11', cae: 'X' },
    { status: 'query_failed', motivo: 'timeout' }
  )
  assert.equal(r.status, 'query_failed')
})

test('auditoría: nunca se ejecuta contra la DB por defecto (sin --apply implementado)', () => {
  const script = read('../../scripts/audit-arca-cae-integrity.mjs')
  assert.doesNotMatch(script, /\.update\(/, 'el script de auditoría no debe escribir en comprobantes')
  assert.doesNotMatch(script, /\.delete\(/, 'el script de auditoría no debe borrar filas')
})

test('auditoría: el reporte no incluye campos con secretos (token/sign/cert/private key)', () => {
  const row = { comprobante_id: 'x', business_id: 'y', fecha: '2026-01-01', tipo: 'factura_c', punto_venta: '1', numero_fiscal: '0001-00000042', cae_local: 'A', cae_arca: 'A', status: 'confirmed_in_arca', motivo: 'ok', accion_recomendada: 'ninguna' }
  const csv = auditToCsv([row])
  for (const secretWord of ['token', 'sign', 'private_key', 'cert', 'cms', 'password']) {
    assert.doesNotMatch(csv.toLowerCase(), new RegExp(secretWord), `el CSV no debe mencionar ${secretWord}`)
  }
})

test('auditoría: parseArgs soporta los flags documentados', () => {
  const args = auditParseArgs(['--business-id=abc', '--from=2026-01-01', '--to=2026-07-01', '--dry-run'])
  assert.equal(args.businessId, 'abc')
  assert.equal(args.from, '2026-01-01')
  assert.equal(args.dryRun, true)
})
