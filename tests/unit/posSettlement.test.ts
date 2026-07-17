/**
 * posSettlement — regresión de la liquidación canónica del cobro del POS.
 *
 * El recargo por línea llega YA decidido (ver paymentSurcharge.ts); este helper
 * solo hace la aritmética de caja. Invariantes:
 *   - totalExigible = totalBase + Σ recargo (contado UNA vez).
 *   - cobertura se compara contra el exigible, no contra la base.
 *   - vuelto SOLO por exceso de EFECTIVO.
 *   - excedente en medio no-efectivo ⇒ sobrepago inválido, nunca vuelto.
 *   - función pura ⇒ recálculo coherente ante cambios dinámicos.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeSettlement } from '../../src/lib/posSettlement.ts'

// ── Una cuota / débito (recargo ya suprimido → surcharge 0) ─────────────────
test('un pago: base 75.000, tarjeta 75.000, sin recargo ⇒ exigible 75.000, diferencia 0, vuelto 0', () => {
  const s = computeSettlement({
    totalBase: 75000,
    payments: [{ method: 'tarjeta', amount: 75000, surcharge: 0 }],
  })
  assert.equal(s.totalRecargo, 0)
  assert.equal(s.totalExigible, 75000)
  assert.equal(s.diferencia, 0)
  assert.equal(s.vuelto, 0)
  assert.equal(s.sobrepagoNoEfectivo, 0)
  assert.equal(s.estado, 'exacto')
  assert.equal(s.valido, true)
})

// ── Cuotas reales: el recargo se suma al exigible y se cuenta una sola vez ───
test('cuotas: base 75.000 + recargo 16.575 ⇒ exigible 91.575, tarjeta 91.575, diferencia 0, vuelto 0', () => {
  const s = computeSettlement({
    totalBase: 75000,
    payments: [{ method: 'tarjeta', amount: 91575, surcharge: 16575 }],
  })
  assert.equal(s.totalRecargo, 16575)
  assert.equal(s.totalExigible, 91575)
  assert.equal(s.totalExigible, s.totalBase + s.totalRecargo) // recargo una sola vez
  assert.equal(s.diferencia, 0)
  assert.equal(s.vuelto, 0)
  assert.equal(s.valido, true)
})

// ── Sobrepago real NO efectivo ──────────────────────────────────────────────
test('sobrepago no efectivo: exigible 75.000, tarjeta 82.500 ⇒ inválido, sin vuelto', () => {
  const s = computeSettlement({
    totalBase: 75000,
    payments: [{ method: 'tarjeta', amount: 82500, surcharge: 0 }],
  })
  assert.equal(s.totalExigible, 75000)
  assert.equal(s.sobrepagoNoEfectivo, 7500)
  assert.equal(s.vuelto, 0)
  assert.equal(s.estado, 'sobrepago_no_efectivo')
  assert.equal(s.valido, false)
})

test('sobrepago no efectivo en transferencia también se rechaza (no es vuelto)', () => {
  const s = computeSettlement({
    totalBase: 50000,
    payments: [{ method: 'transferencia', amount: 55000, surcharge: 0 }],
  })
  assert.equal(s.sobrepagoNoEfectivo, 5000)
  assert.equal(s.vuelto, 0)
  assert.equal(s.valido, false)
})

// ── Efectivo con vuelto legítimo ────────────────────────────────────────────
test('efectivo con vuelto: exigible 75.000, efectivo 80.000 ⇒ válido, vuelto 5.000', () => {
  const s = computeSettlement({
    totalBase: 75000,
    payments: [{ method: 'efectivo', amount: 80000, surcharge: 0 }],
  })
  assert.equal(s.cobertura, 75000)
  assert.equal(s.diferencia, 0)
  assert.equal(s.vuelto, 5000)          // único origen legítimo de vuelto
  assert.equal(s.sobrepagoNoEfectivo, 0)
  assert.equal(s.valido, true)
})

// ── Pago mixto (efectivo + tarjeta, cobertura exacta, sin falso vuelto) ──────
test('mixto: tarjeta (parte con recargo de cuotas) + efectivo exacto ⇒ vuelto 0, válido', () => {
  // Base 100.000. Tarjeta cubre 40.000 con recargo 4.000 (amount 44.000).
  // Efectivo cubre el resto EXACTO (60.000). Exigible = 104.000.
  const s = computeSettlement({
    totalBase: 100000,
    payments: [
      { method: 'tarjeta', amount: 44000, surcharge: 4000 },
      { method: 'efectivo', amount: 60000, surcharge: 0 },
    ],
  })
  assert.equal(s.totalRecargo, 4000)
  assert.equal(s.totalExigible, 104000)
  assert.equal(s.cobertura, 104000)
  assert.equal(s.diferencia, 0)
  assert.equal(s.vuelto, 0)
  assert.equal(s.valido, true)
})

test('mixto: efectivo con vuelto sobre exigible con recargo', () => {
  // Base 100.000, tarjeta 44.000 (recargo 4.000), efectivo 65.000 (entrega de más).
  const s = computeSettlement({
    totalBase: 100000,
    payments: [
      { method: 'tarjeta', amount: 44000, surcharge: 4000 },
      { method: 'efectivo', amount: 65000, surcharge: 0 },
    ],
  })
  assert.equal(s.totalExigible, 104000)
  assert.equal(s.vuelto, 5000)          // 65.000 − 60.000 restante
  assert.equal(s.sobrepagoNoEfectivo, 0)
  assert.equal(s.valido, true)
})

// ── Cuenta corriente ────────────────────────────────────────────────────────
test('CC: efectivo parcial + cuenta corriente, cobertura EXACTA sin falso sobrepago', () => {
  const s = computeSettlement({
    totalBase: 75000,
    payments: [
      { method: 'efectivo', amount: 30000, surcharge: 0 },
      { method: 'cuenta_corriente', amount: 45000, surcharge: 0 },
    ],
  })
  assert.equal(s.cobertura, 75000)
  assert.equal(s.diferencia, 0)
  assert.equal(s.vuelto, 0)
  assert.equal(s.sobrepagoNoEfectivo, 0)  // CC nunca dispara falso sobrepago
  assert.equal(s.valido, true)
})

test('CC: cobertura parcial ⇒ saldo pendiente (sin vuelto, no válido)', () => {
  const s = computeSettlement({
    totalBase: 75000,
    payments: [
      { method: 'efectivo', amount: 30000, surcharge: 0 },
      { method: 'cuenta_corriente', amount: 40000, surcharge: 0 },
    ],
  })
  assert.equal(s.cobertura, 70000)
  assert.equal(s.diferencia, 5000)
  assert.equal(s.vuelto, 0)
  assert.equal(s.estado, 'saldo_pendiente')
  assert.equal(s.valido, false)
})

// ── Cambio dinámico (recálculo coherente, función pura) ─────────────────────
test('cambio dinámico: quitar recargo / editar importe / cambiar método recalcula todo', () => {
  const base = 75000

  // (a) tarjeta exacta sin recargo
  let s = computeSettlement({ totalBase: base, payments: [{ method: 'tarjeta', amount: 75000, surcharge: 0 }] })
  assert.equal(s.valido, true)
  assert.equal(s.vuelto, 0)

  // (b) se escribe de más en tarjeta ⇒ sobrepago no efectivo, sin vuelto
  s = computeSettlement({ totalBase: base, payments: [{ method: 'tarjeta', amount: 82500, surcharge: 0 }] })
  assert.equal(s.estado, 'sobrepago_no_efectivo')
  assert.equal(s.vuelto, 0)

  // (c) se corrige el importe ⇒ vuelve a válido
  s = computeSettlement({ totalBase: base, payments: [{ method: 'tarjeta', amount: 75000, surcharge: 0 }] })
  assert.equal(s.valido, true)

  // (d) se cambia a efectivo entregando de más ⇒ vuelto legítimo
  s = computeSettlement({ totalBase: base, payments: [{ method: 'efectivo', amount: 80000, surcharge: 0 }] })
  assert.equal(s.vuelto, 5000)
  assert.equal(s.valido, true)
})

// ── Redondeo / tolerancia (sin comparación insegura de floats) ──────────────
test('redondeo: recargo con decimales ya redondeado por el caller cierra exacto', () => {
  // 12.345 con recargo 741 (12.345 * 6% = 740,7 ⇒ 741 vía Math.round del caller)
  const s = computeSettlement({
    totalBase: 12345,
    payments: [{ method: 'tarjeta', amount: 13086, surcharge: 741 }],
  })
  assert.equal(s.totalExigible, 13086)
  assert.equal(s.diferencia, 0)
  assert.equal(s.valido, true)
})

test('tolerancia: diferencia sub-peso no invalida (evita falsos por floating point)', () => {
  const s = computeSettlement({
    totalBase: 0.1 + 0.2, // 0.30000000000000004
    payments: [{ method: 'efectivo', amount: 0.3, surcharge: 0 }],
    tolerance: 1,
  })
  assert.equal(s.valido, true)
})
