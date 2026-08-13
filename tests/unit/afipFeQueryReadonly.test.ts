/**
 * afip-fe-query — WSFEv1 SOLO LECTURA.
 *
 * Runner: node:test nativo. Ejecutar: npm run test:unit
 *
 * Cubre el parser de FECompConsultar con fixtures SOAP reales-en-forma, la
 * construccion del sobre, y el contrato de seguridad del endpoint verificado
 * sobre la FUENTE (index.ts usa Deno.serve y no carga bajo node --test).
 *
 * Contexto: esta funcion existe para reconciliar identidad fiscal contra ARCA
 * sin poder autorizar nada. La garantia de "no puede emitir" es estructural y
 * la sostiene scripts/guards/afip-query-readonly.mjs; aca se prueba el
 * comportamiento del parser y la forma del contrato.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseFECompConsultarResponse,
  buildFECompConsultarSOAP,
  resolveWsfeUrl,
  classifyFetchError,
  logStructured,
} from '../../supabase/functions/afip-fe-query/queryLogic.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

function stripComments(src: string): string {
  let out = '', i = 0
  while (i < src.length) {
    if (src.slice(i, i + 2) === '//') {
      const f = src.indexOf('\n', i); const e = f === -1 ? src.length : f
      out += ' '.repeat(e - i); i = e; continue
    }
    if (src.slice(i, i + 2) === '/*') {
      const f = src.indexOf('*/', i + 2); const e = f === -1 ? src.length : f + 2
      out += ' '.repeat(e - i); i = e; continue
    }
    out += src[i]; i++
  }
  return out
}

const indexSrc = () => stripComments(read('../../supabase/functions/afip-fe-query/index.ts'))

// ─── Fixtures SOAP ──────────────────────────────────────────────────────────

const SOAP_FOUND = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope><soap:Body><FECompConsultarResponse><FECompConsultarResult>
  <ResultGet>
    <CbteTipo>11</CbteTipo>
    <PtoVta>10</PtoVta>
    <CbteDesde>146</CbteDesde>
    <CbteHasta>146</CbteHasta>
    <CbteFch>20260812</CbteFch>
    <ImpTotal>13050.50</ImpTotal>
    <DocTipo>99</DocTipo>
    <DocNro>0</DocNro>
    <Resultado>A</Resultado>
    <CodAutorizacion>75123456789012</CodAutorizacion>
    <FchVto>20260822</FchVto>
  </ResultGet>
</FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`

const SOAP_NOT_FOUND = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope><soap:Body><FECompConsultarResponse><FECompConsultarResult>
  <Errors><Err><Code>602</Code><Msg>No existe el comprobante solicitado</Msg></Err></Errors>
</FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`

const SOAP_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope><soap:Body><FECompConsultarResponse><FECompConsultarResult>
  <Errors><Err><Code>600</Code><Msg>Token invalido</Msg></Err></Errors>
</FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`

const SOAP_FAULT = `<?xml version="1.0"?><soap:Envelope><soap:Body><soap:Fault>
  <faultcode>soap:Server</faultcode><faultstring>Server was unable to process request</faultstring>
</soap:Fault></soap:Body></soap:Envelope>`

const SOAP_MALFORMED = `<?xml version="1.0"?><soap:Envelope><soap:Body><algo/></soap:Body></soap:Envelope>`

// ─── 1. FECompConsultar · success ───────────────────────────────────────────

test('found: extrae CAE, identidad, fecha, importe y receptor', () => {
  const r = parseFECompConsultarResponse(SOAP_FOUND)
  assert.equal(r.status, 'found')
  assert.equal(r.cae, '75123456789012')
  assert.equal(r.cae?.length, 14, 'el CAE de AFIP tiene 14 digitos')
  assert.equal(r.cae_vencimiento, '2026-08-22')
  assert.equal(r.resultado, 'A')
  assert.equal(r.numero_cbte, 146)
  assert.equal(r.numero_hasta, 146)
  assert.equal(r.punto_venta_arca, 10)
  assert.equal(r.tipo_comprobante_arca, 11)
  assert.equal(r.fecha_comprobante, '2026-08-12')
  assert.equal(r.importe_total, 13050.5)
  assert.equal(r.doc_tipo, 99)
  assert.equal(r.doc_numero, '0')
})

test('los campos de identidad permiten rechazar un match por numero solo', () => {
  // Si ARCA devuelve OTRO punto de venta, el consumidor tiene con que verlo.
  const distinto = SOAP_FOUND.replace('<PtoVta>10</PtoVta>', '<PtoVta>1</PtoVta>')
  const r = parseFECompConsultarResponse(distinto)
  assert.equal(r.punto_venta_arca, 1)
  assert.notEqual(r.punto_venta_arca, 10)
})

// ─── 2. FECompConsultar · not found / error / malformed ─────────────────────

test('not_found: el 602 es la unica forma de "no existe"', () => {
  const r = parseFECompConsultarResponse(SOAP_NOT_FOUND)
  assert.equal(r.status, 'not_found')
  assert.match(r.motivo ?? '', /No existe el comprobante/)
})

test('un error distinto de 602 NO es "no autorizado"', () => {
  const r = parseFECompConsultarResponse(SOAP_ERROR)
  assert.equal(r.status, 'query_failed', 'un token invalido no prueba nada sobre el comprobante')
  assert.match(r.motivo ?? '', /600/)
})

test('un SOAP fault es query_failed, nunca not_found', () => {
  const r = parseFECompConsultarResponse(SOAP_FAULT)
  assert.equal(r.status, 'query_failed')
  assert.match(r.motivo ?? '', /SOAP fault/)
})

test('una respuesta incompleta es query_failed', () => {
  const r = parseFECompConsultarResponse(SOAP_MALFORMED)
  assert.equal(r.status, 'query_failed')
})

test('query_failed nunca trae CAE', () => {
  for (const fx of [SOAP_ERROR, SOAP_FAULT, SOAP_MALFORMED]) {
    assert.equal(parseFECompConsultarResponse(fx).cae, undefined)
  }
})

// ─── 3. Sobre SOAP y endpoint ───────────────────────────────────────────────

test('el sobre de consulta lleva los tres identificadores', () => {
  const soap = buildFECompConsultarSOAP({
    token: 'T', sign: 'S', cuit: '20111111112',
    puntoVenta: 10, tipoComprobante: 11, numero: 146,
  })
  assert.match(soap, /<ar:FECompConsultar>/)
  assert.match(soap, /<ar:PtoVta>10<\/ar:PtoVta>/)
  assert.match(soap, /<ar:CbteTipo>11<\/ar:CbteTipo>/)
  assert.match(soap, /<ar:CbteNro>146<\/ar:CbteNro>/)
  assert.doesNotMatch(soap, /FECAESolicitar/, 'el sobre de consulta jamas autoriza')
})

test('produccion y homologacion resuelven a hosts distintos y reales', () => {
  assert.equal(resolveWsfeUrl('produccion'), 'https://servicios1.afip.gov.ar/wsfev1/service.asmx')
  assert.equal(resolveWsfeUrl('homologacion'), 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx')
})

// ─── 3b. El modulo extraido esta COMPLETO ───────────────────────────────────
// queryLogic.ts es una copia acotada de afip-cae/logic.ts. Copiar una funcion
// sin sus constantes deja un ReferenceError que NO aparece en el camino feliz:
// solo estalla ante el primer error de red, que es justo cuando mas importa.

test('classifyFetchError funciona: no le faltan constantes', () => {
  assert.equal(classifyFetchError(new Error('dns error: failed to lookup address')), 'not_sent')
  assert.equal(classifyFetchError(new Error('connection reset by peer')), 'ambiguous')
  assert.equal(classifyFetchError(new Error('operation timed out')), 'ambiguous')
  assert.equal(classifyFetchError(new Error('cualquier otra cosa')), 'fatal')
})

test('el log identifica a ESTA funcion, no a afip-cae', () => {
  const original = console.log
  const lineas: string[] = []
  console.log = (s: unknown) => { lineas.push(String(s)) }
  try { logStructured({ stage: 'test' }) } finally { console.log = original }
  assert.equal(lineas.length, 1)
  const parsed = JSON.parse(lineas[0])
  assert.equal(parsed.fn, 'afip-fe-query',
    'un log con fn=afip-cae haria imposible distinguir quien consulto y quien emitio')
})

// ─── 4. Contrato de seguridad (sobre la fuente del endpoint) ────────────────

test('el endpoint no expone token, sign ni secretos en la respuesta', () => {
  const src = indexSrc()
  // El token se usa para llamar a WSFEv1 pero nunca se serializa de vuelta.
  assert.doesNotMatch(src, /token[,:]?\s*token/, 'no puede devolver el token')
  assert.doesNotMatch(src, /sign[,:]?\s*sign/, 'no puede devolver el sign')
  for (const secreto of ['private_key', 'pfx_password', 'certificate_password', 'wsaa_token', 'secret_id']) {
    assert.doesNotMatch(src, new RegExp(secreto), `no puede tocar ${secreto}`)
  }
})

test('anon queda fuera: exige Authorization', () => {
  const src = indexSrc()
  assert.match(src, /startsWith\('Bearer '\)/)
  assert.match(src, /401/, 'sin Authorization responde 401')
})

test('no acepta un business_id arbitrario en el camino de usuario', () => {
  const src = indexSrc()
  assert.match(src, /pedido !== perfil\.business_id/,
    'un business_id distinto al del perfil debe rechazarse')
  assert.match(src, /No autorizado para ese negocio/)
})

test('solo roles con autoridad fiscal, sin ampliar permisos', () => {
  const src = indexSrc()
  assert.match(src, /ROLES_CON_AUTORIDAD_FISCAL = \['owner', 'admin'\]/,
    'se usa el contrato settings_sensitive existente, no los cinco que facturan')
  assert.match(src, /Rol sin autoridad fiscal/)
})

test('NO existe un camino de service_role: la autorizacion es unica', () => {
  const src = indexSrc()
  // Una clave de servicio no tiene perfil ni negocio, asi que no puede pasar
  // del chequeo de identidad. No debe haber ninguna rama que la reconozca.
  assert.doesNotMatch(src, /esServiceRole/, 'volvio la rama especial de service_role')
  assert.doesNotMatch(src, /jwt === serviceKey/, 'volvio la comparacion contra la clave de servicio')
  assert.doesNotMatch(src, /viaServiceRole/)
  assert.doesNotMatch(src, /business_id requerido/, 'volvio el camino que exige business_id del body')
})

test('el negocio sale del perfil y nada mas', () => {
  const src = indexSrc()
  assert.match(src, /const businessId: string = perfil\.business_id/,
    'el negocio debe resolverse desde el perfil de la sesion')
})

test('fail-closed sin configuracion ARCA, sin fallback a homologacion', () => {
  const src = indexSrc()
  assert.match(src, /ARCA_NOT_CONFIGURED/)
  assert.doesNotMatch(src, /\|\|\s*'homologacion'/, 'no puede caer a homologacion por defecto')
  assert.doesNotMatch(src, /punto_venta\s*\|\|\s*1/, 'no puede caer a PV 1')
})

test('el endpoint no escribe en la base', () => {
  const src = indexSrc()
  for (const escritura of ['.insert(', '.update(', '.upsert(', '.delete(']) {
    assert.ok(!src.includes(escritura), `el endpoint de lectura no puede usar ${escritura}`)
  }
})

test('solo expone las dos operaciones de lectura', () => {
  const src = indexSrc()
  assert.match(src, /operacion === 'ultimo_autorizado'/)
  assert.match(src, /operacion === 'consultar'/)
  assert.doesNotMatch(src, /FECAESolicitar/)
})
