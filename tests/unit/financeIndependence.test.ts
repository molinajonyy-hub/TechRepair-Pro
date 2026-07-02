/**
 * Auditoría ARCA/AFIP — fase 4 (independencia de finanzas respecto del
 * resultado fiscal, 2026-07-01) + actualización tras la migración de
 * idempotencia de checkout (2026-07-01, turno siguiente).
 *
 * HALLAZGO ORIGINAL: comprobanteService.crear() gateaba el registro de
 * costo/ingreso/movimiento financiero/cuenta corriente detrás de
 * `estadoDefinitivo === 'issued'`, que dependía de que ARCA hubiera
 * autorizado. Se corrigió quitando esa condición.
 *
 * ACTUALIZACIÓN: esa lógica (comprobante+ítems+stock+pagos+finanzas+CC) ya
 * NO vive en JS — vive DENTRO de la RPC atómica
 * create_comprobante_checkout_atomic (supabase/migrations/
 * 20260701170000_comprobante_checkout_idempotency.sql), que corre en UNA
 * transacción PostgreSQL. ARCA se sigue llamando desde JS, DESPUÉS de que la
 * RPC retorna — ver tests dedicados en checkoutIdempotency.test.ts para la
 * relación RPC/ARCA. Estos tests verifican que, DENTRO de la RPC, el
 * registro financiero sigue sin depender de ningún resultado fiscal (la RPC
 * ni siquiera llama a ARCA — no podría gatear por su resultado aunque
 * quisiera).
 *
 * Tests de CONTRATO sobre el código fuente (mismo patrón que
 * arcaEmission.test.ts): comprobanteService.ts importa `import.meta.env`
 * (vía supabase.ts) y no puede ejecutarse en el runtime nativo de Node sin
 * un build de Vite, así que se verifica la fuente en vez de importar y
 * ejecutar en memoria.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

function rpcBody(migration: string): string {
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION "public"."create_comprobante_checkout_atomic"')
  assert.ok(start >= 0, 'debe existir create_comprobante_checkout_atomic en la migración de checkout')
  const end = migration.indexOf('ALTER FUNCTION "public"."create_comprobante_checkout_atomic"', start)
  assert.ok(end > start, 'debe poder delimitar el cuerpo de la función')
  return migration.slice(start, end)
}

test('1) la RPC registra comprobante/items/stock/pagos ANTES de considerar finanzas — orden preservado del diseño original', () => {
  const body = rpcBody(read('../../supabase/migrations/20260701170000_comprobante_checkout_idempotency.sql'))
  const idxInsertComp   = body.indexOf('INSERT INTO comprobantes (')
  const idxItemsLoop    = body.indexOf("FOR v_item IN SELECT * FROM jsonb_array_elements")
  const idxStock        = body.indexOf('INSERT INTO inventory_movements (')
  const idxPagos        = body.indexOf('INSERT INTO comprobante_payments (')
  const idxFinanceCost  = body.indexOf("'variable_cost'")
  assert.ok(idxInsertComp >= 0 && idxItemsLoop >= 0 && idxStock >= 0 && idxPagos >= 0 && idxFinanceCost >= 0)
  assert.ok(idxInsertComp < idxItemsLoop, 'comprobante se inserta antes del loop de ítems/stock')
  assert.ok(idxStock < idxPagos, 'stock se descuenta antes de registrar el pago de caja')
  assert.ok(idxPagos < idxFinanceCost, 'los pagos se registran antes del bloque de finanzas')
})

test('2) el registro de finanzas (costo/ingreso/CC) dentro de la RPC no depende de ningún resultado de ARCA — la RPC ni siquiera llama a ARCA', () => {
  const migration = read('../../supabase/migrations/20260701170000_comprobante_checkout_idempotency.sql')
  const body = rpcBody(migration)
  // estado_fiscal SÍ se escribe una vez, al insertar el comprobante (estado
  // inicial 'pendiente_emision'/'no_fiscal') — lo que nunca debe pasar es que
  // una condición de finanzas LEA/dependa de su valor.
  assert.doesNotMatch(body, /IF[^\n]*estado_fiscal/, 'ninguna condición debe gatear por estado_fiscal')
  assert.doesNotMatch(body, /claim_comprobante_arca_emission|arca_emission_attempts/, 'la RPC nunca debe invocar el flujo ARCA')
  assert.match(body, /IF v_costo_total_ars > 0 AND NOT v_skip_finance THEN/,
    'el costo se registra si hay costo y el caller no lo saltó explícitamente — nunca por un resultado fiscal inexistente en este contexto')
  assert.match(body, /IF NOT v_skip_finance AND v_cash_total = 0 AND v_cc_total = 0 THEN/,
    'el ingreso propio se registra según la composición del pago (caja vs CC), nunca por ARCA')
  assert.match(body, /IF v_cc_total > 0\.01 AND v_customer_id IS NOT NULL THEN/,
    'el movimiento de cuenta corriente se registra si hay saldo en CC y cliente')
})

test('3) un fallo DENTRO del bloque de trabajo revierte TODO (comprobante+items+stock+pagos+finanzas) atómicamente — nunca deja efectos parciales', () => {
  const migration = read('../../supabase/migrations/20260701170000_comprobante_checkout_idempotency.sql')
  const body = rpcBody(migration)
  // Un único bloque BEGIN...EXCEPTION envuelve TODO el trabajo comercial —
  // si algo falla ahí dentro, el savepoint implícito revierte comprobante,
  // items, stock, pagos y finanzas juntos (todo o nada), y el request queda
  // failed_retryable en vez de completed.
  const workBlockStart = body.indexOf("v_tipo             := p_payload->>'tipo';")
  const exceptionIdx = body.indexOf('EXCEPTION WHEN OTHERS THEN', workBlockStart)
  assert.ok(workBlockStart >= 0 && exceptionIdx > workBlockStart)
  const workBlock = body.slice(workBlockStart, exceptionIdx)
  assert.match(workBlock, /INSERT INTO comprobantes/)
  assert.match(workBlock, /INSERT INTO comprobante_payments/)
  assert.match(workBlock, /business_finance_entries/)
  assert.match(workBlock, /account_movements/)
})

test('4) la venta local (comprobante/pago/stock/finanzas) es independiente de ARCA en la orquestación JS: la RPC de creación corre y confirma ANTES de intentar ARCA', () => {
  const service = read('../../src/services/comprobanteService.ts')
  const crearStart = service.indexOf('async crear(input: CrearComprobanteInput)')
  const crearEnd = service.indexOf('\n  // ── Emitir borrador', crearStart)
  assert.ok(crearStart >= 0 && crearEnd > crearStart)
  const body = service.slice(crearStart, crearEnd)
  const idxRpcCall = body.indexOf("supabase.rpc('create_comprobante_checkout_atomic'")
  const idxCheckoutStatusGuard = body.indexOf("checkoutStatus !== 'created' && checkoutStatus !== 'existing'")
  const idxArca = body.indexOf('_claimYEmitirArca(business_id, compId')
  assert.ok(idxRpcCall >= 0 && idxCheckoutStatusGuard >= 0 && idxArca >= 0)
  assert.ok(idxRpcCall < idxCheckoutStatusGuard, 'la RPC de creación local se llama y su resultado se valida ANTES de tocar ARCA')
  assert.ok(idxCheckoutStatusGuard < idxArca, 'ARCA solo se intenta después de confirmar created/existing — nunca antes')
})

test('5) un reintento posterior de emitir() nunca puede duplicar finanzas: emitir() no escribe en ninguna tabla financiera', () => {
  const service = read('../../src/services/comprobanteService.ts')
  const emitirStart = service.indexOf('async emitir(')
  const emitirEnd = service.indexOf('\n  // ── Anular comprobante', emitirStart)
  assert.ok(emitirStart >= 0 && emitirEnd > emitirStart)
  const emitirBody = service.slice(emitirStart, emitirEnd)
  for (const financeTable of ['business_finance_entries', 'financial_movements', "'cuenta_corriente'", 'registerSale', 'cuentasService']) {
    assert.doesNotMatch(emitirBody, new RegExp(financeTable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `emitir() no debe tocar ${financeTable} — las finanzas se registran una única vez, dentro de la RPC de creación, nunca en un reintento de emisión`)
  }
})

test('6) doble click / doble submit en el POS: AHORA hay dos capas — guard de UI (isSubmittingRef) + lock atómico server-side (idempotency_key)', () => {
  const modal = read('../../src/components/comprobantes/ComprobanteProModal.tsx')
  assert.match(modal, /isSubmittingRef\s*=\s*useRef\(false\)/, 'sigue existiendo el ref de guardia de UI (primera barrera, evita el round-trip innecesario)')
  assert.match(modal, /if\s*\(isSubmittingRef\.current\)\s*return/, 'handleSubmit corta temprano si ya hay un submit en curso')
  assert.match(modal, /disabled=\{submitting\}/, 'el botón de cobrar queda disabled mientras se procesa')
  assert.match(modal, /getOrCreateIdempotencyKey\(businessId, requestHash\)/, 'la clave de idempotencia se resuelve antes de llamar a crear()')

  // La garantía REAL de "nunca dos comprobantes" ya no depende solo de la UI:
  // create_comprobante_checkout_atomic tiene UNIQUE(business_id,
  // idempotency_key) como lock atómico en DB (verificado con dos conexiones
  // reales en run-checkout-idempotency-concurrency-test.ps1, T1: 7/7 PASS,
  // bloqueo real medido ~3.4s). Si el guard de UI fallara (dos pestañas, o
  // una carrera genuina entre dos taps), la MISMA idempotency_key persistida
  // en sessionStorage haría que la segunda solicitud reciba 'existing' con
  // el mismo comprobante_id — nunca una segunda venta.
  const migration = read('../../supabase/migrations/20260701170000_comprobante_checkout_idempotency.sql')
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "idx_checkout_requests_business_key"/,
    'el lock atómico real está en DB, no solo en memoria del navegador')
})
