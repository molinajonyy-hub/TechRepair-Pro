#!/usr/bin/env -S deno run --allow-read --allow-write
// ============================================================================
// FISCAL DATE Parte 2 — PLANIFICADOR de consultas FECompConsultar
//
//   deno run --allow-read --allow-write scripts/fiscal-date-part2/plan-arca-lookup.ts
//
// CONSTRUIDO, NO EJECUTADO. Este script produce el PLAN de consultas y su
// SHA-256. No abre red: no importa `fetch`, no toma credenciales y no tiene
// ninguna rama que envíe algo. Ejecutar el lote contra ARCA es una acción de
// producción que el owner NO autorizó.
//
// Es de SÓLO LECTURA por construcción, en dos sentidos:
//   1. La única operación WSFEv1 que arma es FECompConsultar. El builder de
//      FECAESolicitar no se importa siquiera, así que no hay forma de emitir.
//   2. No escribe en la base. Su salida es un archivo de plan.
//
// Reusa buildFECompConsultarSOAP y parseFECompConsultarResponse de afip-cae:
// el mismo builder y el mismo parser certificados que usa la función en
// producción, para que el plan no sea una segunda implementación que pueda
// divergir del contrato real.
import { buildFECompConsultarSOAP, parseFECompConsultarResponse } from '../../supabase/functions/afip-cae/logic.ts'

// Rutas por argumento para poder ejercitar el planificador con un fixture, sin
// meter datos fiscales de producción en el repo.
//   deno run ... plan-arca-lookup.ts [manifiesto.json] [plan-de-salida.json]
// Los argumentos se pasan tal cual: Deno.readTextFile/writeTextFile aceptan
// rutas string, y armar un file:// a mano rompe en Windows por las barras.
const MANIFEST: string | URL = Deno.args[0]
  ?? new URL('../../docs/fiscal-date-part2/classification.json', import.meta.url)
const OUT: string | URL = Deno.args[1]
  ?? new URL('../../docs/fiscal-date-part2/arca-lookup-plan.json', import.meta.url)

/** Tope duro. Si el clasificador pidiera más, algo cambió y hay que revisarlo. */
const MAX_CONSULTAS = 200

interface Fila {
  id: string
  business_id: string
  numero_fiscal: string
  pv_fiscal: number
  cbte_tipo: number
  nro_fiscal: number
  clase: string
  motivo?: string
  cae_local?: string | null
  importe_local?: number | null
  dia_ar_desde?: string | null
  dia_ar_hasta?: string | null
  dia_venta_ar?: string | null
}

const manifest = JSON.parse(await Deno.readTextFile(MANIFEST))
const filas: Fila[] = manifest.filas.filter((f: Fila) => f.clase === 'REQUIRES_ARCA_LOOKUP')

if (filas.length === 0) {
  console.log('[plan] no hay comprobantes que requieran consulta a ARCA')
  Deno.exit(0)
}
if (filas.length > MAX_CONSULTAS) {
  console.error(`[plan] ABORTA: ${filas.length} consultas supera el tope de ${MAX_CONSULTAS}`)
  Deno.exit(1)
}

// Una consulta por comprobante, deduplicada por clave fiscal: PV + CbteTipo +
// Nro. Sin CbteTipo `numero_fiscal` es ambiguo (hay un 0010-00000001 factura y
// otro nota de crédito), así que la clave lleva los tres campos.
const porClave = new Map<string, Fila>()
for (const f of filas) {
  const clave = `${f.pv_fiscal}|${f.cbte_tipo}|${f.nro_fiscal}`
  const previo = porClave.get(clave)
  if (previo && previo.id !== f.id) {
    console.error(`[plan] ABORTA: dos comprobantes distintos comparten la clave fiscal ${clave}`)
    console.error(`        ${previo.id} y ${f.id}`)
    Deno.exit(1)
  }
  porClave.set(clave, f)
}

const consultas = [...porClave.values()].map((f) => {
  // Placeholders explícitos: el plan NO contiene ni token, ni sign, ni CUIT.
  const soap = buildFECompConsultarSOAP({
    token: '<TOKEN>', sign: '<SIGN>', cuit: '<CUIT>',
    puntoVenta: f.pv_fiscal, tipoComprobante: f.cbte_tipo, numero: f.nro_fiscal,
  })
  return {
    comprobante_id: f.id,
    business_id: f.business_id,
    numero_fiscal: f.numero_fiscal,
    punto_venta: f.pv_fiscal,
    cbte_tipo: f.cbte_tipo,
    numero: f.nro_fiscal,
    operacion: 'FECompConsultar',
    // Lo que hay que leer de la respuesta.
    campo_esperado: 'CbteFch',
    // Testigos de identidad: el runner exige que la respuesta de ARCA coincida
    // con ESTOS valores antes de que su CbteFch pueda alimentar un backfill.
    cae_local: f.cae_local ?? null,
    importe_local: f.importe_local ?? null,
    // Contexto para auditar el resultado sin volver a la base.
    contexto: { motivo: f.motivo, dia_venta_ar: f.dia_venta_ar },
    soap_bytes: new TextEncoder().encode(soap).length,
  }
})

// El parser tiene que poder leer la respuesta que esperamos, o el plan no sirve.
const sonda = parseFECompConsultarResponse(
  `<ResultGet><CbteDesde>1</CbteDesde><CbteFch>20260808</CbteFch>` +
  `<CodAutorizacion>75000000000001</CodAutorizacion><FchVto>20260818</FchVto>` +
  `<Resultado>A</Resultado></ResultGet>`)
if (sonda.status !== 'found' || sonda.fecha_cbte !== '20260808') {
  console.error('[plan] ABORTA: el parser certificado no devuelve CbteFch como se espera', sonda)
  Deno.exit(1)
}

// El plan es DETERMINÍSTICO a propósito: no lleva reloj. Si llevara
// `generado_en`, su SHA-256 cambiaría en cada corrida y el hash no serviría
// para lo único que importa —que el runner ejecute EXACTAMENTE el plan que se
// revisó—. Misma clasificación, mismos bytes, mismo hash, verificable por
// cualquiera. La marca de tiempo vive en el manifiesto de clasificación, que es
// evidencia, no plan.
const plan = {
  ejecutado: false,
  nota: 'PLAN. Ejecutar el lote contra ARCA requiere autorización explícita del owner.',
  operacion_unica: 'FECompConsultar',
  clasificacion_sha256: manifest.sql_sha256,
  consultas_totales: consultas.length,
  consultas,
}
const json = JSON.stringify(plan, null, 2)
await Deno.writeTextFile(OUT, json)

const sha = [...new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)))]
  .map((b) => b.toString(16).padStart(2, '0')).join('')
const runnerSha = [...new Uint8Array(
  await crypto.subtle.digest('SHA-256', await Deno.readFile(new URL(import.meta.url))))]
  .map((b) => b.toString(16).padStart(2, '0')).join('')

console.log(`[plan] consultas FECompConsultar a realizar : ${consultas.length}`)
console.log(`[plan] operación única                      : FECompConsultar (jamás FECAESolicitar)`)
console.log(`[plan] ejecutado                            : NO`)
console.log(`[plan] sha256(arca-lookup-plan.json)        = ${sha}`)
console.log(`[plan] sha256(plan-arca-lookup.ts)          = ${runnerSha}`)
