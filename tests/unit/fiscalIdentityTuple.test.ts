/**
 * Identidad fiscal como TERNA (PtoVta, CbteTipo, CbteNro) + estado histórico.
 *
 * Runner: node:test nativo. Ejecutar: npm run test:unit
 *
 * Contexto medido en producción (reconciliación ARCA 2026-08-13):
 *   · Una Factura C y su Nota de Crédito comparten numero_fiscal
 *     '0010-00000001' de forma LEGÍTIMA: son series distintas (CbteTipo 11 y
 *     13). Tratar numero_fiscal como identidad los fusionaría.
 *   · 53 comprobantes llevaban identidad fiscal simulada. La reparación los
 *     deja en 'sin_autorizacion_fiscal' CONSERVANDO estado='emitido', porque
 *     la venta sí ocurrió. Si la UI resuelve el estado por `estado`, los
 *     muestra como "Emitido ARCA" sin CAE — la mentira que se vino a sacar.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  fiscalIdentity,
  fiscalIdentityKey,
  mismaIdentidadFiscal,
  resolverCbteTipo,
  parseNumeroFiscal,
  esTipoFiscal,
} from '../../src/lib/fiscalIdentity.ts'
import {
  getComprobanteDisplayStatus,
  comprobanteStatusDetalle,
  permiteAccionesDeEmision,
} from '../../src/utils/comprobanteStatus.ts'

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

// ─── A · Factura C vs NC C con el MISMO numero_fiscal ───────────────────────

const FACTURA_C_1 = { tipo: 'factura_c', numero_fiscal: '0010-00000001', tipo_comprobante_fiscal: '11' }
const NC_C_1      = { tipo: 'nota_credito', numero_fiscal: '0010-00000001', tipo_comprobante_fiscal: '13' }

test('A · Factura C (10,11,1) y NC C (10,13,1) son identidades DISTINTAS', () => {
  const a = fiscalIdentity(FACTURA_C_1)
  const b = fiscalIdentity(NC_C_1)
  assert.deepEqual(a, { puntoVenta: 10, cbteTipo: 11, numero: 1 })
  assert.deepEqual(b, { puntoVenta: 10, cbteTipo: 13, numero: 1 })
  assert.notEqual(fiscalIdentityKey(a!), fiscalIdentityKey(b!))
  assert.equal(mismaIdentidadFiscal(FACTURA_C_1, NC_C_1), false,
    'fusionarlas es exactamente el defecto que este contrato evita')
})

test('B · la misma terna exacta es la misma identidad', () => {
  const otro = { tipo: 'factura_c', numero_fiscal: '0010-00000001', tipo_comprobante_fiscal: 11 }
  assert.equal(mismaIdentidadFiscal(FACTURA_C_1, otro), true)
  assert.equal(fiscalIdentityKey(fiscalIdentity(FACTURA_C_1)!),
               fiscalIdentityKey(fiscalIdentity(otro)!))
})

test('C · mismo numero_fiscal + CbteTipo distinto => NO deduplicar', () => {
  const porNumero = new Set([FACTURA_C_1.numero_fiscal, NC_C_1.numero_fiscal])
  assert.equal(porNumero.size, 1, 'por numero_fiscal colapsan (asi era el bug)')

  const porTerna = new Set([FACTURA_C_1, NC_C_1].map(c => fiscalIdentityKey(fiscalIdentity(c)!)))
  assert.equal(porTerna.size, 2, 'por terna se mantienen separados')
})

test('D · sin numero_fiscal no hay identidad fiscal canonica', () => {
  assert.equal(fiscalIdentity({ tipo: 'factura_c', numero_fiscal: null, tipo_comprobante_fiscal: '11' }), null)
  for (const v of ['', '   ', '0010', '-', 'abcd-00000001', '0000-00000001', '0010-00000000']) {
    assert.equal(parseNumeroFiscal(v), null, `deberia rechazar ${JSON.stringify(v)}`)
  }
  // Dos comprobantes sin identidad NO son "el mismo".
  const a = { tipo: 'factura_c', numero_fiscal: null }
  assert.equal(mismaIdentidadFiscal(a, a), false)
})

test('E · nota_credito sin tipo_comprobante_fiscal => fail-closed', () => {
  const nc = { tipo: 'nota_credito', numero_fiscal: '0010-00000001' }
  assert.equal(resolverCbteTipo(nc), null, 'no se puede inventar la clase de una NC')
  assert.equal(fiscalIdentity(nc), null)
})

test('E2 · factura_a / factura_c SI derivan sin codigo persistido', () => {
  assert.equal(resolverCbteTipo({ tipo: 'factura_a' }), 1)
  assert.equal(resolverCbteTipo({ tipo: 'factura_c' }), 11)
  assert.equal(fiscalIdentity({ tipo: 'factura_c', numero_fiscal: '0010-00000045' })?.cbteTipo, 11)
})

test('E3 · el remito no tiene identidad fiscal', () => {
  assert.equal(esTipoFiscal('remito'), false)
  assert.equal(fiscalIdentity({ tipo: 'remito', numero_fiscal: '0001-00000015' }), null)
})

// ─── F/G · estado sin_autorizacion_fiscal ───────────────────────────────────

// Como quedan los 53 tras la reparación: la VENTA sigue emitida y cobrada,
// pero no hay autorización fiscal.
const REPARADO = {
  estado: 'emitido',
  estado_fiscal: 'sin_autorizacion_fiscal',
  cae: null,
  numero_fiscal: null,
  total_cobrado: 25000,
}

test('F · sin_autorizacion_fiscal NO cae a borrador ni a "Emitido ARCA"', () => {
  const s = getComprobanteDisplayStatus(REPARADO)
  assert.equal(s.key, 'sin_autorizacion_fiscal')
  assert.equal(s.label, 'Sin autorización fiscal')
  assert.notEqual(s.key, 'borrador')
  assert.notEqual(s.key, 'emitido_arca',
    'estado=emitido no puede hacerlo pasar por autorizado en ARCA')
})

test('F2 · el copy explica que es historico y sin autorizacion', () => {
  const d = comprobanteStatusDetalle('sin_autorizacion_fiscal')
  assert.match(d ?? '', /histórico/i)
  assert.match(d ?? '', /no posee una autorización válida en ARCA/i)
  assert.equal(comprobanteStatusDetalle('emitido_arca'), null)
})

test('G · sin_autorizacion_fiscal no ofrece emitir ni reintentar', () => {
  assert.equal(permiteAccionesDeEmision('sin_autorizacion_fiscal'), false,
    'es un estado TERMINAL: no es un error reintentable')
  assert.equal(permiteAccionesDeEmision('anulado'), false)
  assert.equal(permiteAccionesDeEmision('error_arca'), true)
  assert.equal(permiteAccionesDeEmision('cobrado_pendiente_arca'), true)
})

// ─── H · el #45 queda exactamente como ARCA ─────────────────────────────────

test('H · #45 reconciliado tiene la identidad exacta de ARCA', () => {
  const r45 = {
    tipo: 'factura_c',
    numero_fiscal: '0010-00000045',
    tipo_comprobante_fiscal: '11',
  }
  assert.deepEqual(fiscalIdentity(r45), { puntoVenta: 10, cbteTipo: 11, numero: 45 })
})

// ─── I · la migracion no toca lo comercial ni lo economico ──────────────────

const MIGRACION = () => stripComments(
  read('../../supabase/migrations/20260814120000_fiscal_historical_repair.sql'))

test('I · la migracion no escribe estado ni estado_comercial', () => {
  const sql = MIGRACION()
  assert.doesNotMatch(sql, /\bestado\s*=/, 'no puede tocar el estado comercial')
  assert.doesNotMatch(sql, /estado_comercial\s*=/)
  // Sólo se permiten UPDATE sobre comprobantes; nada economico.
  for (const t of ['financial_movements', 'business_finance_entries', 'comprobante_payments',
                   'account_movements', 'inventory', 'orders']) {
    assert.doesNotMatch(sql, new RegExp(`UPDATE\\s+public\\.${t}`, 'i'), `no puede escribir ${t}`)
    assert.doesNotMatch(sql, new RegExp(`DELETE\\s+FROM\\s+public\\.${t}`, 'i'), `no puede borrar de ${t}`)
  }
})

test('I2 · la migracion verifica el invariante economico dentro de la transaccion', () => {
  const sql = MIGRACION()
  assert.match(sql, /INVARIANTE ECONOMICO ROTO/)
  assert.match(sql, /^BEGIN;/m, 'sin transaccion propia un RAISE no revierte (autocommit)')
  assert.match(sql, /^COMMIT;/m)
})

test('I3 · la migracion usa lista cerrada de ids, no un patron', () => {
  const sql = MIGRACION()
  assert.doesNotMatch(sql, /WHERE[\s\S]{0,80}length\(\s*cae\s*\)\s*=\s*15[\s\S]{0,40}(UPDATE|SET)/i)
  assert.match(sql, /_legacy_53/)
  const ids = sql.match(/\('[0-9a-f]{8}-[0-9a-f-]{27}'\)/g) ?? []
  assert.equal(ids.length, 53, `la lista cerrada debe tener 53 ids, tiene ${ids.length}`)
})

test('I4 · la migracion es no-op donde no estan los datos', () => {
  const sql = MIGRACION()
  assert.match(sql, /_repair_scope/)
  assert.match(sql, /no-op/i, 'una base limpia no puede romper el db reset')
})

// ─── Controles negativos sobre la fuente ────────────────────────────────────

test('NEG · AFIP_TIPO_CODE no vuelve a mapear nota_credito', () => {
  const src = stripComments(read('../../src/services/comprobanteService.ts'))
  const bloque = /const AFIP_TIPO_CODE[^}]*}/.exec(src)?.[0] ?? ''
  assert.ok(bloque.length > 0, 'no se encontro AFIP_TIPO_CODE')
  assert.doesNotMatch(bloque, /nota_credito/,
    'una NC no tiene CbteTipo fijo: 3 es NC-A y la real es NC-C (13)')
  assert.match(bloque, /factura_c:\s*11/)
})

test('NEG · las tres superficies derivan el significado del contrato compartido', () => {
  // Los componentes tienen defensa en profundidad: aunque se rompa la variable
  // semantica, una rama explicita todavia salva el label. Eso hace que el test
  // de render NO detecte la regresion, asi que se fija la derivacion en fuente.
  const actions = stripComments(read('../../src/components/comprobantes/ComprobanteActions.tsx'))
  assert.match(actions, /getComprobanteDisplayStatus\(comprobante\)/,
    'Actions debe consumir la resolucion canonica')
  assert.match(actions, /esEmitido\s*=\s*estadoFiscalCanonico\.fiscalmenteEmitido/,
    'la emision fiscal no puede volver a definirse como estado===emitido || !!cae')
  assert.doesNotMatch(actions, /esEmitido\s*=\s*!esAnulado\s*&&\s*\(comprobante\.estado/,
    'volvio la definicion que ignoraba el estado fiscal')
  assert.match(actions, /permiteEmision\s*&&/,
    'el boton de emitir debe gatearse por permiteEmision, no por no-ser-borrador')

  const doc = stripComments(read('../../src/components/comprobantes/ComprobanteDocumento.tsx'))
  assert.match(doc, /getComprobanteDisplayStatus\(c\)/,
    'Documento debe consumir la resolucion canonica, no reimplementar reglas')

  const header = stripComments(read('../../src/components/comprobantes/ComprobanteHeader.tsx'))
  assert.match(header, /getComprobanteDisplayStatus\(/)
})

test('NEG · facturacionService tampoco vuelve a mapear nota_credito a 3', () => {
  // Segunda copia de la trampa, encontrada por el bundle gate: viajaba a
  // produccion aunque no tuviera llamadores.
  const src = stripComments(read('../../src/services/facturacionService.ts'))
  const bloque = /getCodigoTipoComprobante[\s\S]{0,400}?\n  \},/.exec(src)?.[0] ?? ''
  assert.ok(bloque.length > 0, 'no se encontro getCodigoTipoComprobante')
  assert.doesNotMatch(bloque, /nota_credito/,
    'una NC no tiene CbteTipo fijo: 3 es NC-A y la real es NC-C (13)')
})

test('NEG · el simulador legacy sigue sin poder fabricar un CAE', () => {
  // Origen de los 53: solicitarCAE() inventaba un CAE y marcaba emitido sin
  // llamar a ARCA. Quedo bloqueado en la auditoria 2026-07-01 y no puede
  // reabrirse en silencio.
  const src = stripComments(read('../../src/services/facturacionService.ts'))
  for (const fn of ['solicitarCAE', 'generarCAEFake']) {
    const bloque = new RegExp(`${fn}\\([\\s\\S]{0,900}?\\n  \\},`).exec(src)?.[0] ?? ''
    assert.ok(bloque.length > 0, `no se encontro ${fn}`)
    assert.match(bloque, /throw new Error/, `${fn} debe seguir lanzando, no fabricar`)
  }
})

test('NEG · el CbtesAsoc no vuelve a inferir tipo ni punto de venta', () => {
  const src = stripComments(read('../../src/services/comprobanteService.ts'))
  assert.doesNotMatch(src, /tipo_comprobante_fiscal[\s\S]{0,60}:\s*11/,
    'volvio el default 11 para el CbteTipo del original')
  assert.doesNotMatch(src, /parseInt\(\s*original\.punto_venta/,
    'volvio el punto de venta LOCAL dentro del CbtesAsoc')
  assert.match(src, /fiscalIdentity\(original\)/)
})

test('NEG · el resolvedor de estado atiende sin_autorizacion_fiscal antes que emitido', () => {
  const src = stripComments(read('../../src/utils/comprobanteStatus.ts'))
  const iSin = src.indexOf("'sin_autorizacion_fiscal'")
  const iEmi = src.indexOf("c.estado === 'emitido'")
  assert.ok(iSin > -1 && iEmi > -1)
  assert.ok(iSin < iEmi,
    'si se evalua despues, un registro con estado=emitido se muestra como Emitido ARCA')
})
