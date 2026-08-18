// ============================================================================
// REGRESIÓN P0 — la factura normal no puede caer en la lógica de Nota de Crédito
//
// Incidente 2026-08-18: la primera emisión real posterior al release de
// afip-cae v16 devolvió HTTP 400 ANTES de WSAA. El comprobante era una
// Factura C corriente:
//
//   comprobantes.tipo                    = 'factura_c'
//   comprobantes.tipo_comprobante_fiscal = NULL      <- todavía no emitida
//   comprobantes.comprobante_original_id = NULL
//   attempt.tipo_comprobante             = 11
//   attempt.punto_venta                  = 10
//   body.cbte_asoc_*                     = ausentes
//
// Este test ejecuta el gate REAL (`resolverCbtesAsocCanonico`) con un doble
// del cliente PostgREST que reproduce la cadena
// `.select().eq().eq().maybeSingle()`, para que la regresión no se pueda
// "probar" sólo con helpers aislados.
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  resolverCbtesAsocCanonico,
} from '../../supabase/functions/afip-cae/cbtesAsoc.ts'

const COMPROBANTE_ID = '722d1a19-01df-4489-80d0-c5c9c5860c8d'
const BUSINESS_ID    = 'aa930802-0861-46ce-896c-7f68b181cb39'

/**
 * Doble mínimo del cliente PostgREST: sólo la cadena que usa el gate.
 * Devuelve la fila cuando id y business_id coinciden; si no, `null` como
 * `maybeSingle()`. Registra las tablas consultadas para poder aseverar que una
 * factura NO va a buscar el comprobante original.
 */
function supabaseDoble(filas: Record<string, any[]>) {
  const consultas: string[] = []
  const buscar = (id: unknown, biz: unknown) =>
    (filas.comprobantes ?? []).find(f => f.id === id && f.business_id === biz) ?? null

  return {
    consultas,
    async rpc(nombre: string, args: Record<string, any>) {
      if (nombre === 'snapshot_arca_comprobante_identity') {
        consultas.push('comprobante')
        const f = buscar(args.p_comprobante_id, args.p_business_id)
        return {
          data: f ? {
            tipo: f.tipo,
            tipo_comprobante_fiscal: f.tipo_comprobante_fiscal,
            comprobante_original_id: f.comprobante_original_id,
          } : null,
          error: null,
        }
      }
      if (nombre === 'snapshot_arca_original_identity') {
        consultas.push('original')
        const f = buscar(args.p_original_id, args.p_business_id)
        return {
          data: f ? {
            tipo: f.tipo,
            numero_fiscal: f.numero_fiscal,
            tipo_comprobante_fiscal: f.tipo_comprobante_fiscal,
          } : null,
          error: null,
        }
      }
      throw new Error(`RPC inesperada: ${nombre}`)
    },
  }
}

const FILA_FACTURA = {
  id: COMPROBANTE_ID,
  business_id: BUSINESS_ID,
  tipo: 'factura_c',
  tipo_comprobante_fiscal: null,
  comprobante_original_id: null,
}

test('H · fixture exacto del incidente: Factura C / CbteTipo 11 / sin cbte_asoc NO da 400', async () => {
  const db = supabaseDoble({ comprobantes: [FILA_FACTURA] })

  const r = await resolverCbtesAsocCanonico(db as any, {
    comprobanteId: COMPROBANTE_ID,
    businessId: BUSINESS_ID,
    tipoComprobante: 11,
    body: {
      cbteAsocTipo: undefined,
      cbteAsocPtoVta: undefined,
      cbteAsocNro: undefined,
    },
  })

  assert.equal(r.ok, true, `el gate rechazó una factura normal: ${r.error}`)
  assert.equal(r.identidad, undefined, 'una factura no lleva identidad de CbtesAsoc')
  assert.equal(r.originalId, undefined, 'una factura no referencia un original')
})

test('G · la factura no entra en la lógica de NC: no consulta el comprobante original', async () => {
  const db = supabaseDoble({ comprobantes: [FILA_FACTURA] })

  await resolverCbtesAsocCanonico(db as any, {
    comprobanteId: COMPROBANTE_ID,
    businessId: BUSINESS_ID,
    tipoComprobante: 11,
    body: {},
  })

  // Exactamente UNA lectura: la propia fila. Una segunda sería la búsqueda del
  // comprobante original, que sólo corresponde a una Nota de Crédito.
  assert.deepEqual(db.consultas, ['comprobante'])
})

test('B · Factura A / CbteTipo 1 tampoco entra en la lógica de NC', async () => {
  const fila = { ...FILA_FACTURA, tipo: 'factura_a' }
  const db = supabaseDoble({ comprobantes: [fila] })

  const r = await resolverCbtesAsocCanonico(db as any, {
    comprobanteId: COMPROBANTE_ID,
    businessId: BUSINESS_ID,
    tipoComprobante: 1,
    body: {},
  })

  assert.equal(r.ok, true, `el gate rechazó una Factura A normal: ${r.error}`)
  assert.deepEqual(db.consultas, ['comprobante'])
})

test('E · mismatch REAL entre el CbteTipo del intento y el tipo de la fila falla cerrado', async () => {
  const db = supabaseDoble({ comprobantes: [FILA_FACTURA] })

  // La fila es factura_c (11) pero el intento dice Factura A (1).
  const r = await resolverCbtesAsocCanonico(db as any, {
    comprobanteId: COMPROBANTE_ID,
    businessId: BUSINESS_ID,
    tipoComprobante: 1,
    body: {},
  })

  assert.equal(r.ok, false)
  assert.match(String(r.error), /no coincide/i)
})

test('una factura NO puede traer CbtesAsoc en el body', async () => {
  const db = supabaseDoble({ comprobantes: [FILA_FACTURA] })

  const r = await resolverCbtesAsocCanonico(db as any, {
    comprobanteId: COMPROBANTE_ID,
    businessId: BUSINESS_ID,
    tipoComprobante: 11,
    body: { cbteAsocTipo: 11, cbteAsocPtoVta: 10, cbteAsocNro: 1 },
  })

  assert.equal(r.ok, false)
  assert.match(String(r.error), /Nota de Cr/i)
})
