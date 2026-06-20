/**
 * Tests unitarios del motor de precio (compute-at-read).
 * Runner: node:test nativo (Node ≥ 23.6 corre TypeScript sin dependencias).
 * Ejecutar: npm run test:unit   (o: node --test tests/unit/)
 *
 * Nota: se usa el runner nativo de Node porque `npm install vitest` falla en este
 * entorno Windows por un binario opcional de Rollup fijado a Linux en el lock
 * (EBADPLATFORM). Las aserciones son puras y portables a vitest sin cambios de lógica.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProductPricing } from '../../src/lib/pricing/productPricing.ts'
import { getProductPriceForCustomer } from '../../src/utils/pricing.ts'

const MINORISTA = { customer_type: 'minorista' }
const MAYORISTA = { customer_type: 'mayorista' }

/** Réplica exacta de la composición que usan POS y búsqueda global:
 *  resolver ARS con el motor y luego aplicar la regla por cliente. */
function effectiveCustomerPriceARS(product: any, rate: number, wholesale: boolean): number {
  const e = resolveProductPricing(product, rate)
  return getProductPriceForCustomer(
    { sale_price: e.saleArs, precio_mayorista: e.mayoristaArs },
    wholesale ? MAYORISTA : MINORISTA,
  ).price
}

test('producto manual en ARS NO cambia cuando cambia el dólar', () => {
  const p = { sale_price: 1000, base_currency: 'ARS', auto_update_price: false }
  assert.equal(resolveProductPricing(p, 1000).saleArs, 1000)
  assert.equal(resolveProductPricing(p, 1500).saleArs, 1000) // otro dólar, mismo precio
  const r = resolveProductPricing(p, 1500)
  assert.equal(r.mode, 'manual_ars')
  assert.equal(r.isAuto, false)
  assert.equal(r.dollarUsed, null)
})

test('producto USD auto SÍ cambia cuando cambia el dólar', () => {
  const p = { sale_price: 100000, base_currency: 'USD', base_price: 100, auto_update_price: true }
  const r1 = resolveProductPricing(p, 1000)
  assert.equal(r1.saleArs, 100000) // 100 USD × 1000
  assert.equal(r1.isAuto, true)
  assert.equal(r1.dollarUsed, 1000)
  assert.equal(r1.mode, 'usd_auto')

  const r2 = resolveProductPricing(p, 1200)
  assert.equal(r2.saleArs, 120000) // 100 USD × 1200 → actualizado solo por cambiar el dólar
})

test('producto USD con auto_update_price=false respeta el precio guardado (override manual)', () => {
  const p = { sale_price: 95000, base_currency: 'USD', base_price: 100, auto_update_price: false }
  const r = resolveProductPricing(p, 1200)
  assert.equal(r.saleArs, 95000) // NO dolariza
  assert.equal(r.mode, 'usd_manual')
  assert.equal(r.isAuto, false)
})

test('margen/decimales: base_price con decimales se redondea a 2', () => {
  const p = { sale_price: 0, base_currency: 'USD', base_price: 12.5, auto_update_price: true }
  // 12.5 × 1234.567 = 15432.0875 → 15432.09
  assert.equal(resolveProductPricing(p, 1234.567).saleArs, 15432.09)
})

test('producto VIEJO sin campos nuevos no se rompe', () => {
  const p = { sale_price: 4500 } // sin base_currency / base_price / auto_update_price
  const r = resolveProductPricing(p, 1500)
  assert.equal(r.saleArs, 4500)
  assert.equal(r.mode, 'manual_ars')
  assert.equal(r.isAuto, false)
  assert.equal(r.baseCurrency, 'ARS')
})

test('dólar inválido (≤0) cae al precio guardado, no a cero', () => {
  const p = { sale_price: 88000, base_currency: 'USD', base_price: 100, auto_update_price: true }
  assert.equal(resolveProductPricing(p, 0).saleArs, 88000)
  assert.equal(resolveProductPricing(p, -5).saleArs, 88000)
})

test('USD auto sin base_price cae al precio guardado', () => {
  const p = { sale_price: 77000, base_currency: 'USD', base_price: 0, auto_update_price: true }
  const r = resolveProductPricing(p, 1200)
  assert.equal(r.saleArs, 77000)
  assert.equal(r.isAuto, false)
  assert.equal(r.mode, 'usd_manual')
})

test('mayorista: USD-auto se dolariza proporcional a exchange_rate_used', () => {
  const p = {
    sale_price: 100000, precio_mayorista: 90000,
    base_currency: 'USD', base_price: 100, auto_update_price: true, exchange_rate_used: 1000,
  }
  const r = resolveProductPricing(p, 1200) // ratio 1200/1000 = 1.2
  assert.equal(r.saleArs, 120000)        // 100 × 1200
  assert.equal(r.mayoristaArs, 108000)   // 90000 × 1.2
})

test('costo: USD-auto se dolariza desde cost_price_usd; manual usa cost_price', () => {
  const usd = { sale_price: 0, base_currency: 'USD', base_price: 100, auto_update_price: true, cost_price: 50000, cost_price_usd: 60 }
  assert.equal(resolveProductPricing(usd, 1200).costArs, 72000) // 60 USD × 1200 (no usa el cost_price guardado)
  const ars = { sale_price: 8000, cost_price: 5000, base_currency: 'ARS' }
  assert.equal(resolveProductPricing(ars, 1200).costArs, 5000)
  // USD-auto sin cost_price_usd cae al cost_price guardado
  const usdNoCost = { sale_price: 0, base_currency: 'USD', base_price: 100, auto_update_price: true, cost_price: 40000 }
  assert.equal(resolveProductPricing(usdNoCost, 1200).costArs, 40000)
})

test('mayorista: manual ARS se conserva tal cual', () => {
  const p = { sale_price: 5000, precio_mayorista: 4200, base_currency: 'ARS' }
  const r = resolveProductPricing(p, 1500)
  assert.equal(r.saleArs, 5000)
  assert.equal(r.mayoristaArs, 4200)
})

test('acepta strings con coma decimal (datos de formularios)', () => {
  const p = { sale_price: '1234,50', base_currency: 'ARS' }
  assert.equal(resolveProductPricing(p, 1000).saleArs, 1234.5)
})

// ─── Costo dolarizado (POS / reportes) ────────────────────────────────────────

test('costo USD-auto CAMBIA cuando cambia la cotización', () => {
  const p = { sale_price: 0, base_currency: 'USD', base_price: 100, auto_update_price: true, cost_price: 50000, cost_price_usd: 60 }
  assert.equal(resolveProductPricing(p, 1000).costArs, 60000) // 60 × 1000
  assert.equal(resolveProductPricing(p, 1200).costArs, 72000) // 60 × 1200 → sigue el dólar
  assert.equal(resolveProductPricing(p, 1500).costArs, 90000) // 60 × 1500
})

test('costo manual ARS NO cambia entre cotizaciones', () => {
  const p = { sale_price: 8000, cost_price: 5000, base_currency: 'ARS' }
  assert.equal(resolveProductPricing(p, 1000).costArs, 5000)
  assert.equal(resolveProductPricing(p, 1500).costArs, 5000) // otro dólar, mismo costo
  // Producto USD con override manual (auto=false): costo guardado, no dolariza
  const manualUsd = { sale_price: 9000, cost_price: 5500, base_currency: 'USD', base_price: 100, auto_update_price: false, cost_price_usd: 60 }
  assert.equal(resolveProductPricing(manualUsd, 1200).costArs, 5500)
})

test('costo fallback: USD-auto sin cotización válida usa el cost_price guardado', () => {
  const p = { sale_price: 0, base_currency: 'USD', base_price: 100, auto_update_price: true, cost_price: 40000, cost_price_usd: 60 }
  assert.equal(resolveProductPricing(p, 0).costArs, 40000)  // rate 0 → fallback
  assert.equal(resolveProductPricing(p, -1).costArs, 40000) // rate inválido → fallback
})

// ─── Precio mayorista (motor) ─────────────────────────────────────────────────

test('mayorista USD-auto: cliente mayorista recibe el mayorista dolarizado', () => {
  const p = {
    sale_price: 100000, precio_mayorista: 90000,
    base_currency: 'USD', base_price: 100, auto_update_price: true, exchange_rate_used: 1000,
  }
  // minorista → saleArs dolarizado; mayorista → precio_mayorista escalado por 1200/1000
  assert.equal(effectiveCustomerPriceARS(p, 1200, false), 120000)
  assert.equal(effectiveCustomerPriceARS(p, 1200, true), 108000)
})

test('mayorista manual ARS: se respeta tal cual para cliente mayorista', () => {
  const p = { sale_price: 5000, precio_mayorista: 4200, base_currency: 'ARS' }
  assert.equal(effectiveCustomerPriceARS(p, 1500, false), 5000)
  assert.equal(effectiveCustomerPriceARS(p, 1500, true), 4200)
})

// ─── No doble conversión ──────────────────────────────────────────────────────

test('NO hay doble conversión: el motor devuelve ARS y la regla por cliente no re-multiplica', () => {
  const p = { sale_price: 0, base_currency: 'USD', base_price: 100, auto_update_price: true }
  // El precio efectivo debe ser base × rate (100 × 1200), NUNCA base × rate² ni ARS × rate.
  assert.equal(effectiveCustomerPriceARS(p, 1200, false), 120000)
  assert.notEqual(effectiveCustomerPriceARS(p, 1200, false), 100 * 1200 * 1200)
})

// ─── Paridad de superficies (Inventario / POS / Búsqueda global) ──────────────

test('búsqueda global usa el MISMO precio resuelto que Inventario y POS', () => {
  const item = { sale_price: 88000, base_currency: 'USD', base_price: 100, auto_update_price: true }
  const rate = 1350
  // Inventario muestra resolveProductPricing(...).saleArs
  const inventarioPrice = resolveProductPricing(item, rate).saleArs
  // Búsqueda global usa exactamente la misma llamada
  const globalSearchPrice = resolveProductPricing(item, rate).saleArs
  // POS (cliente minorista) lo pasa por la regla por cliente
  const posPrice = effectiveCustomerPriceARS(item, rate, false)
  assert.equal(inventarioPrice, 135000)        // 100 × 1350
  assert.equal(globalSearchPrice, inventarioPrice)
  assert.equal(posPrice, inventarioPrice)
})

// ─── Compute-at-read: comprobantes históricos / datos guardados intactos ──────

test('el motor es PURO: no muta el producto de entrada (datos guardados intactos)', () => {
  const frozen = Object.freeze({
    sale_price: 100000, precio_mayorista: 90000, cost_price: 50000, cost_price_usd: 60,
    base_currency: 'USD', base_price: 100, auto_update_price: true, exchange_rate_used: 1000,
  })
  // Si intentara escribir sobre el objeto congelado, lanzaría en strict mode.
  assert.doesNotThrow(() => resolveProductPricing(frozen, 1200))
  const r = resolveProductPricing(frozen, 1200)
  assert.equal(r.saleArs, 120000)
  // El objeto original conserva exactamente sus valores guardados.
  assert.equal(frozen.sale_price, 100000)
  assert.equal(frozen.cost_price, 50000)
  assert.equal(frozen.base_price, 100)
})
