/**
 * paymentSurcharge — dos decisiones SEPARADAS:
 *   (1) cuánto paga el cliente  → customerSurchargeRate
 *   (2) qué costo absorbe el comercio → effectiveMerchantCommissionRate
 *
 * Regla (hotfix a04b349 + cierre riesgo #1):
 *   charge_mode = 'customer' ⇒ el % es recargo al cliente:
 *     - un pago (débito / 1 cuota): surcharge 0, commission 0;
 *     - cuotas reales (≥2): surcharge = %, commission 0.
 *   charge_mode = 'business' ⇒ el % es costo del comercio:
 *     - surcharge 0, commission = %/100 (independiente del nombre).
 * Un % 'customer' JAMÁS se reinterpreta como comisión ⇒ sin costo ficticio.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseInstallments,
  isSinglePayment,
  customerSurchargeRate,
  effectiveMerchantCommissionRate,
  isSuppressedSinglePaymentSurcharge,
} from '../../src/lib/paymentSurcharge.ts'

// ── parseInstallments / isSinglePayment ─────────────────────────────────────
test('parseInstallments: cuenta cuotas del nombre; un pago por defecto', () => {
  assert.equal(parseInstallments('1 cuota'), 1)
  assert.equal(parseInstallments('3 cuotas'), 3)
  assert.equal(parseInstallments('12 cuotas'), 12)
  assert.equal(parseInstallments('en 6 pagos'), 6)
  assert.equal(parseInstallments('Débito'), 1)
  assert.equal(parseInstallments('Crédito'), 1)
  assert.equal(parseInstallments('QR'), 1)
  assert.equal(parseInstallments(''), 1)
  assert.equal(parseInstallments(null), 1)
  assert.equal(parseInstallments(undefined), 1)
})

test('isSinglePayment: débito y 1 cuota son un pago; 2+ cuotas no', () => {
  assert.equal(isSinglePayment({ charge_mode: 'customer', percentage: 10, short_label: '1 cuota' }), true)
  assert.equal(isSinglePayment({ charge_mode: 'customer', percentage: 0.89, short_label: 'Débito' }), true)
  assert.equal(isSinglePayment({ charge_mode: 'customer', percentage: 22.1, short_label: '3 cuotas' }), false)
})

// ── Decisión 1 + 2 juntas, por caso mandado ─────────────────────────────────
test('legacy customer — una cuota: surcharge 0 Y commission 0 (sin costo ficticio)', () => {
  const m = { charge_mode: 'customer' as const, percentage: 10, short_label: '1 cuota' }
  assert.equal(customerSurchargeRate(m), 0)
  assert.equal(effectiveMerchantCommissionRate(m), 0)  // el 10% NO es comisión del comercio
})

test('business — una cuota: surcharge 0, commission 0,0089', () => {
  const m = { charge_mode: 'business' as const, percentage: 0.89, short_label: 'Débito' }
  assert.equal(customerSurchargeRate(m), 0)
  assert.equal(effectiveMerchantCommissionRate(m), 0.0089)
})

test('customer — tres cuotas: surcharge 22,1% Y commission 0 (preservado, sin comisión inventada)', () => {
  const m = { charge_mode: 'customer' as const, percentage: 22.1, short_label: '3 cuotas' }
  assert.equal(customerSurchargeRate(m), 0.221)
  assert.equal(effectiveMerchantCommissionRate(m), 0)
})

test('business — tres cuotas: surcharge 0, commission según %', () => {
  const m = { charge_mode: 'business' as const, percentage: 5, short_label: '3 cuotas' }
  assert.equal(customerSurchargeRate(m), 0)          // el negocio no traslada al cliente
  assert.equal(effectiveMerchantCommissionRate(m), 0.05)
})

test('nombre ambiguo + customer: fail-safe como un pago (surcharge 0, commission 0)', () => {
  const m = { charge_mode: 'customer' as const, percentage: 15, short_label: 'Tarjeta' }
  assert.equal(customerSurchargeRate(m), 0)
  assert.equal(effectiveMerchantCommissionRate(m), 0)
})

test('crédito/QR en un pago con customer: surcharge 0 y commission 0', () => {
  for (const label of ['Crédito', 'QR']) {
    const m = { charge_mode: 'customer' as const, percentage: 3.99, short_label: label }
    assert.equal(customerSurchargeRate(m), 0)
    assert.equal(effectiveMerchantCommissionRate(m), 0)
  }
})

test('none (efectivo/transferencia): ambos 0', () => {
  const m = { charge_mode: 'none' as const, percentage: 0, short_label: 'Efectivo' }
  assert.equal(customerSurchargeRate(m), 0)
  assert.equal(effectiveMerchantCommissionRate(m), 0)
})

test('business con 0% o negativo: commission 0 (validación segura)', () => {
  assert.equal(effectiveMerchantCommissionRate({ charge_mode: 'business', percentage: 0, short_label: 'x' }), 0)
  assert.equal(effectiveMerchantCommissionRate({ charge_mode: 'business', percentage: -5, short_label: 'x' }), 0)
})

test('usa label si falta short_label', () => {
  assert.equal(customerSurchargeRate({ charge_mode: 'customer', percentage: 22.1, label: 'Visa / Mastercard — 3 cuotas' }), 0.221)
  assert.equal(customerSurchargeRate({ charge_mode: 'customer', percentage: 10, label: 'Visa / Mastercard — 1 cuota' }), 0)
})

// ── Regresión financiera: customer no genera comisión; business sí ──────────
test('regresión: NINGÚN método customer produce comisión del comercio', () => {
  for (const label of ['1 cuota', '3 cuotas', '6 cuotas', '12 cuotas', 'Débito', 'Crédito', 'QR']) {
    assert.equal(effectiveMerchantCommissionRate({ charge_mode: 'customer', percentage: 22.1, short_label: label }), 0)
  }
})

test('regresión: un método business produce comisión = %/100 (una sola tasa)', () => {
  assert.equal(effectiveMerchantCommissionRate({ charge_mode: 'business', percentage: 2.5, short_label: 'Posnet' }), 0.025)
})

// ── Payload end-to-end (espeja toggleMetodo → comprobanteService.crear) ─────
// Modelo: amount = base·(1+customerSurcharge); commission_rate = merchant rate;
// commission_amount (server) = amount · commission_rate.
function buildPayload(method: Parameters<typeof customerSurchargeRate>[0], base: number) {
  const custRate = customerSurchargeRate(method)
  const commRate = effectiveMerchantCommissionRate(method)
  const amount = custRate > 0 ? Math.round(base * (1 + custRate)) : base
  const surcharge = amount - base
  const commissionAmount = amount * commRate
  return { amount, surcharge, commissionRate: commRate, commissionAmount }
}

test('payload caso original: 1 cuota customer 10% sobre 75.000 ⇒ amount 75.000, surcharge 0, commission_rate 0, commission_amount 0', () => {
  const p = buildPayload({ charge_mode: 'customer', percentage: 10, short_label: '1 cuota' }, 75000)
  assert.equal(p.amount, 75000)
  assert.equal(p.surcharge, 0)
  assert.equal(p.commissionRate, 0)
  assert.equal(p.commissionAmount, 0)   // sin costo financiero ficticio
})

test('payload business débito 0,89% sobre 75.000 ⇒ amount 75.000 (base), commission_amount 667,5 (sobre base, una vez)', () => {
  const p = buildPayload({ charge_mode: 'business', percentage: 0.89, short_label: 'Débito' }, 75000)
  assert.equal(p.amount, 75000)         // la comisión del comercio NO aumenta el importe del cliente
  assert.equal(p.surcharge, 0)
  assert.equal(p.commissionRate, 0.0089)
  assert.equal(p.commissionAmount, 667.5) // 75.000 · 0,0089 — calculada sobre la base
})

test('payload cuotas customer 22,1%: recargo al cliente, commission_amount 0 (aunque amount incluya recargo)', () => {
  const p = buildPayload({ charge_mode: 'customer', percentage: 22.1, short_label: '3 cuotas' }, 75000)
  assert.equal(p.amount, 91575)
  assert.equal(p.surcharge, 16575)
  assert.equal(p.commissionRate, 0)
  assert.equal(p.commissionAmount, 0)   // NO se cobra comisión sobre el importe con recargo
})

// ── Advertencia de configuración ────────────────────────────────────────────
test('isSuppressedSinglePaymentSurcharge: marca configs de un pago con recargo customer', () => {
  assert.equal(isSuppressedSinglePaymentSurcharge({ charge_mode: 'customer', percentage: 10, short_label: '1 cuota' }), true)
  assert.equal(isSuppressedSinglePaymentSurcharge({ charge_mode: 'customer', percentage: 0.89, short_label: 'Débito' }), true)
  assert.equal(isSuppressedSinglePaymentSurcharge({ charge_mode: 'customer', percentage: 22.1, short_label: '3 cuotas' }), false)
  assert.equal(isSuppressedSinglePaymentSurcharge({ charge_mode: 'customer', percentage: 0, short_label: '1 cuota' }), false)
  assert.equal(isSuppressedSinglePaymentSurcharge({ charge_mode: 'business', percentage: 10, short_label: '1 cuota' }), false)
})
