// ─────────────────────────────────────────────────────────────────────────────
// P0-A — El costo de los repuestos consumidos en una orden debe llegar al
// comprobante, incluso cuando el repuesto está absorbido por el precio del
// servicio (cliente_paga_repuesto = false, el 100 % de los repuestos productivos).
//
// El COGS canónico existe SOLO como comprobante_items.costo_total
// (v_finance_sales_ledger → v_finance_pnl). Si el repuesto no viaja al
// comprobante, su costo no existe para el modelo y la facturación se convierte
// en ganancia.
//
// Estos tests fijan la corrección sobre la función PURA que arma los ítems
// (src/lib/orderBilling.ts) más contratos de wiring sobre el código fuente de
// los tres archivos de la cadena, que no corren en Node (importan
// import.meta.env vía supabase) — mismo criterio que dashboardRealProfit.test.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  buildOrderComprobanteItems, roundCents,
  type OrderBillingItem, type OrderBillingPart,
} from '../../src/lib/orderBilling.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../')
const read = (p: string) => readFileSync(resolve(REPO_ROOT, p), 'utf-8')

// ── Helpers de armado ────────────────────────────────────────────────────────

const servicio = (
  descripcion: string, precio: number, costo = 0, cantidad = 1,
): OrderBillingItem => ({
  tipo: 'servicio', descripcion, cantidad, precio_unitario: precio,
  costo_unitario: costo, cliente_paga_repuesto: false, product_id: null,
})

const repuesto = (
  descripcion: string, precio: number, costo: number,
  clientePaga: boolean | null, cantidad = 1, productId: string | null = 'inv-1',
): OrderBillingItem => ({
  tipo: 'repuesto', descripcion, cantidad, precio_unitario: precio,
  costo_unitario: costo, cliente_paga_repuesto: clientePaga, product_id: productId,
})

const part = (
  name: string, sale: number, costo: number,
  clientePaga: boolean | null = true, quantity = 1, status: string | null = 'used',
): OrderBillingPart => ({
  name, quantity, sale_price: sale, internal_cost: costo,
  cliente_paga_repuesto: clientePaga, status,
})

/** COGS que el checkout va a persistir: Σ costo_unitario × cantidad por línea. */
const cogsDelComprobante = (r: ReturnType<typeof buildOrderComprobanteItems>) =>
  roundCents(r.items.reduce((s, l) => s + l.costo_unitario * l.cantidad, 0))

/** Ingreso del comprobante: Σ precio_unitario × cantidad. */
const ingresoDelComprobante = (r: ReturnType<typeof buildOrderComprobanteItems>) =>
  roundCents(r.items.reduce((s, l) => s + l.precio_unitario * l.cantidad, 0))

// ── Caso 1 — servicio sin repuestos ──────────────────────────────────────────

test('caso 1: servicio sin repuestos → ingreso 100.000, COGS 0', () => {
  const r = buildOrderComprobanteItems([servicio('Reparación', 100_000)], [])
  assert.equal(r.items.length, 1)
  assert.equal(ingresoDelComprobante(r), 100_000)
  assert.equal(cogsDelComprobante(r), 0)
  assert.equal(r.absorbedCostArs, 0)
  assert.equal(r.foldedIntoIndex, null)
})

// ── Caso 2 — servicio con repuesto absorbido ─────────────────────────────────

test('caso 2: servicio 100.000 + repuesto absorbido 25.000 → ingreso 100.000, COGS 25.000, resultado 75.000', () => {
  const r = buildOrderComprobanteItems(
    [servicio('Reparación', 100_000), repuesto('Pantalla', 30_000, 25_000, false)],
    [],
  )
  // El repuesto absorbido NO genera línea propia: no se le factura al cliente.
  assert.equal(r.items.length, 1, 'una sola línea facturable (el servicio)')
  assert.equal(ingresoDelComprobante(r), 100_000, 'el total cotizado no cambia')
  assert.equal(cogsDelComprobante(r), 25_000, 'el costo absorbido sí se reconoce')
  assert.equal(ingresoDelComprobante(r) - cogsDelComprobante(r), 75_000)
  assert.equal(r.absorbedCostArs, 25_000)
  assert.equal(r.foldedIntoIndex, 0)
  assert.equal(r.roundingDeltaArs, 0)
})

// ── Caso 3 y 7 — repuesto cobrado por separado ───────────────────────────────

test('caso 3: repuesto cobrado aparte → su precio entra al ingreso y su COGS se reconoce UNA vez', () => {
  const r = buildOrderComprobanteItems(
    [servicio('Mano de obra', 40_000), repuesto('Batería', 17_000, 12_200, true)],
    [],
  )
  assert.equal(r.items.length, 2)
  assert.equal(ingresoDelComprobante(r), 57_000)
  assert.equal(cogsDelComprobante(r), 12_200)
  // No se plegó nada: el costo ya viaja en su propia línea.
  assert.equal(r.absorbedCostArs, 0)
  assert.equal(r.foldedIntoIndex, null)
})

test('caso 7: cliente_paga_repuesto=true NO duplica el COGS', () => {
  const r = buildOrderComprobanteItems(
    [servicio('Mano de obra', 40_000), repuesto('Batería', 17_000, 12_200, true)],
    // order_parts es el espejo del MISMO repuesto: no debe sumar otra vez.
    [part('Batería', 17_000, 12_200, true)],
  )
  assert.equal(r.items.length, 2, 'el espejo de order_parts no agrega una tercera línea')
  assert.equal(cogsDelComprobante(r), 12_200, 'el costo se cuenta exactamente una vez')
})

test('caso 6: cliente_paga_repuesto=false NO elimina el COGS (es solo presentación/precio)', () => {
  const conFlagFalse = buildOrderComprobanteItems(
    [servicio('Reparación', 50_000), repuesto('Batería', 17_000, 12_200, false)], [],
  )
  const conFlagTrue = buildOrderComprobanteItems(
    [servicio('Reparación', 50_000), repuesto('Batería', 17_000, 12_200, true)], [],
  )
  // El ingreso difiere (es la decisión comercial), el COGS NO.
  assert.equal(cogsDelComprobante(conFlagFalse), 12_200)
  assert.equal(cogsDelComprobante(conFlagTrue), 12_200)
  assert.equal(ingresoDelComprobante(conFlagFalse), 50_000)
  assert.equal(ingresoDelComprobante(conFlagTrue), 67_000)
})

// ── Caso 4 — varios repuestos absorbidos ─────────────────────────────────────

test('caso 4: varios repuestos absorbidos suman su costo completo', () => {
  const r = buildOrderComprobanteItems(
    [
      servicio('Reparación', 100_000),
      repuesto('Repuesto A', 0, 20_000, false),
      repuesto('Repuesto B', 0, 5_000, false, 1, 'inv-2'),
    ],
    [],
  )
  assert.equal(r.items.length, 1)
  assert.equal(cogsDelComprobante(r), 25_000)
  assert.equal(r.absorbedParts.length, 2)
  assert.deepEqual(r.absorbedParts.map(a => a.costoTotalArs), [20_000, 5_000])
})

test('caso 4b: cantidad > 1 en un repuesto absorbido usa el costo TOTAL (unitario × cantidad)', () => {
  const r = buildOrderComprobanteItems(
    [servicio('Reparación', 100_000), repuesto('Tornillo', 0, 1_500, false, 4)], [],
  )
  assert.equal(cogsDelComprobante(r), 6_000)
})

// ── Caso 5 — repuesto + costo interno directo del servicio ───────────────────

test('caso 5: repuesto absorbido + costo interno del servicio se suman, sin perder ninguno', () => {
  const r = buildOrderComprobanteItems(
    [servicio('Reparación', 100_000, 10_000), repuesto('Pantalla', 0, 25_000, false)], [],
  )
  assert.equal(r.items.length, 1)
  // 10.000 propios del servicio + 25.000 absorbidos del repuesto.
  assert.equal(cogsDelComprobante(r), 35_000)
  assert.equal(ingresoDelComprobante(r) - cogsDelComprobante(r), 65_000)
})

// ── Caso 8 — anti doble descuento de stock ───────────────────────────────────

test('caso 8: NINGUNA línea derivada de la orden lleva inventory_id (el stock ya se descontó)', () => {
  const r = buildOrderComprobanteItems(
    [
      servicio('Reparación', 50_000),
      repuesto('Batería facturada', 17_000, 12_200, true, 1, 'inv-abc'),
      repuesto('Batería absorbida', 0, 8_000, false, 1, 'inv-def'),
    ],
    [part('Suelto', 3_000, 1_000, true)],
  )
  for (const l of r.items) {
    assert.equal((l as Record<string, unknown>).inventory_id, undefined,
      `la línea "${l.descripcion}" no debe llevar inventory_id: el checkout descontaría stock por segunda vez`)
  }
})

// ── Caso 9 — snapshot histórico ──────────────────────────────────────────────

test('caso 9: el costo sale del snapshot de la orden, nunca del inventario vivo', () => {
  const src = read('src/lib/orderBilling.ts')
  assert.ok(!/from\s*\(\s*['"]inventory['"]/.test(src) && !/'inventory'/.test(src),
    'el armado no debe consultar inventory: el costo es el snapshot capturado al consumir')
  // El costo del ítem se copia tal cual, sin recalcular.
  const r = buildOrderComprobanteItems(
    [servicio('Reparación', 50_000), repuesto('Batería', 0, 12_200, false)], [],
  )
  assert.equal(cogsDelComprobante(r), 12_200)
})

// ── Redondeo (numeric(14,2) y costo_total = costo_unitario × cantidad) ───────

test('el plegado prefiere una línea de servicio con cantidad 1 → residuo de redondeo 0', () => {
  const r = buildOrderComprobanteItems(
    [
      servicio('Diagnóstico', 30_000, 0, 3),   // cantidad 3
      servicio('Reparación', 70_000, 0, 1),    // cantidad 1 ← destino preferido
      repuesto('Pieza', 0, 10_000, false),
    ],
    [],
  )
  assert.equal(r.foldedIntoIndex, 1, 'debe plegar en el servicio de cantidad 1')
  assert.equal(r.roundingDeltaArs, 0)
  assert.equal(cogsDelComprobante(r), 10_000)
})

test('si la única línea destino tiene cantidad > 1, el residuo de redondeo queda acotado a centavos', () => {
  const r = buildOrderComprobanteItems(
    [servicio('Diagnóstico', 30_000, 0, 3), repuesto('Pieza', 0, 10_000, false)], [],
  )
  assert.equal(r.foldedIntoIndex, 0)
  assert.ok(Math.abs(r.roundingDeltaArs) <= 0.01,
    `el residuo debe ser a lo sumo un centavo, fue ${r.roundingDeltaArs}`)
  // A nivel de centavos el COGS es el esperado (v_finance_pnl redondea a 2 decimales).
  assert.equal(Math.round(cogsDelComprobante(r)), 10_000)
})

// ── order_parts sin gemelo en order_items ────────────────────────────────────

test('un repuesto que vive solo en order_parts y está absorbido aporta su costo', () => {
  const r = buildOrderComprobanteItems(
    [servicio('Reparación', 50_000)],
    [part('Pegamento', 0, 1_800, false)],
  )
  assert.equal(r.items.length, 1)
  assert.equal(cogsDelComprobante(r), 1_800)
  assert.equal(r.absorbedParts[0].origen, 'order_parts')
})

test('caso 11: un repuesto devuelto (status=returned) NO es COGS', () => {
  const r = buildOrderComprobanteItems(
    [servicio('Reparación', 50_000)],
    [part('Pieza devuelta', 0, 9_000, false, 1, 'returned')],
  )
  assert.equal(cogsDelComprobante(r), 0)
  assert.equal(r.absorbedCostArs, 0)
})

// ── Sin línea facturable: no se inventa un evento de ingreso ─────────────────

test('orden sin ninguna línea facturable → el costo se reporta como no reconocido, no se inventa una línea', () => {
  const r = buildOrderComprobanteItems([repuesto('Pieza', 0, 4_000, false)], [])
  assert.equal(r.items.length, 0)
  assert.equal(r.foldedIntoIndex, null)
  assert.equal(r.unrecognizedCostArs, 4_000)
})

// ── NULL se trata como facturable (default de la columna en la DB) ───────────

test('cliente_paga_repuesto NULL se factura, igual que el default de la columna y que el armado anterior', () => {
  const r = buildOrderComprobanteItems(
    [servicio('Mano de obra', 10_000), repuesto('Cable', 5_000, 2_000, null)], [],
  )
  assert.equal(r.items.length, 2)
  assert.equal(ingresoDelComprobante(r), 15_000)
})

// ── Orden de control del P0 ──────────────────────────────────────────────────

test('orden de control: servicio 50.000 + batería absorbida 12.200 → COGS 12.200 y resultado 37.800', () => {
  const r = buildOrderComprobanteItems(
    [
      repuesto('Bateria de Motorola - JK 50', 17_000, 12_200, false),
      servicio('Cambio de bateria', 50_000, 0),
    ],
    [part('Bateria de Motorola - JK 50', 17_000, 12_200, false)],  // espejo, no duplica
    )
  assert.equal(r.items.length, 1, 'solo la línea de servicio se factura')
  assert.equal(ingresoDelComprobante(r), 50_000)
  assert.equal(cogsDelComprobante(r), 12_200)
  assert.equal(ingresoDelComprobante(r) - cogsDelComprobante(r), 37_800)
})

// ── El ingreso al cliente NO cambia respecto del armado anterior ─────────────

test('el predicado de facturación es idéntico al anterior: el total cotizado nunca cambia', () => {
  const items = [
    servicio('Servicio', 50_000),
    repuesto('Facturado', 17_000, 12_200, true),
    repuesto('Absorbido', 30_000, 8_000, false),
    repuesto('Null', 4_000, 1_000, null),
  ]
  // Ingreso con el filtro legacy: servicio siempre + repuesto con flag !== false.
  const ingresoLegacy = items
    .filter(i => i.tipo === 'servicio' || (i.tipo === 'repuesto' && i.cliente_paga_repuesto !== false))
    .reduce((s, i) => s + i.precio_unitario * i.cantidad, 0)
  const r = buildOrderComprobanteItems(items, [])
  assert.equal(ingresoDelComprobante(r), ingresoLegacy)
  assert.equal(ingresoLegacy, 71_000)
  // …y ahora además se reconoce el costo del absorbido.
  assert.equal(cogsDelComprobante(r), 12_200 + 1_000 + 8_000)
})

// ── Contratos de wiring (código fuente) ──────────────────────────────────────

test('caso 10: OrderDetail pasa orderId al modal y usa el armado canónico', () => {
  const s = read('src/pages/OrderDetail.tsx')
  assert.match(s, /import \{ buildOrderComprobanteItems \} from '\.\.\/lib\/orderBilling'/)
  assert.match(s, /buildOrderComprobanteItems\(order\.orderItems, order\.parts\)/)
  assert.match(s, /orderId=\{order\.id\}/, 'el comprobante debe nacer vinculado a la orden')
  // El armado viejo (que perdía el costo y mandaba inventory_id) no debe volver.
  assert.ok(!/billableFromOrderItems/.test(s), 'no debe quedar el armado anterior')
  assert.ok(!/inventory_id:\s*i\.product_id/.test(s),
    'nunca mandar inventory_id de la orden: el checkout descontaría stock dos veces')
})

test('caso 10b: ComprobanteProModal transmite order_id al servicio canónico', () => {
  const s = read('src/components/comprobantes/ComprobanteProModal.tsx')
  assert.match(s, /orderId\?:\s*string/, 'debe declarar la prop orderId')
  assert.match(s, /order_id:\s*orderId\s*\?\?\s*null/, 'debe transmitirla como order_id')
  // La key de idempotencia depende del contenido comercial: si orderId cambia el
  // submit, la dependencia tiene que estar declarada.
  assert.match(s, /\[lineas, businessId, cajaIsOpen, skipFinanceEntry, pagos, tipo, puntoVenta, condicion, clienteId, orderId,/)
})

test('caso 10c: comprobanteService persiste order_id en el payload de la RPC atómica', () => {
  const s = read('src/services/comprobanteService.ts')
  assert.match(s, /order_id:\s*order_id \|\| null/)
})

test('caso 19: la ganancia del comprobante usa el snapshot persistido, no el inventario vivo', () => {
  const s = read('src/pages/Comprobante.tsx')
  // El costo sale de comprobante_items.costo_total — la MISMA columna que
  // alimenta v_finance_pnl. Sin esto la tarjeta mostraba margen 100 % en toda
  // línea sin inventory_id (todas las de órdenes) y contradecía a Finanzas.
  assert.match(s, /Number\(i\.costo_total\)/)
  assert.ok(!/from\('inventory'\)/.test(s),
    'la página del comprobante no debe releer inventory.cost_price para calcular ganancia')
  assert.ok(!/margin:\s*100/.test(s), 'no debe asumir margen 100 % cuando no hay ítems de inventario')
})

test('el detector canónico de huecos existe, es read-only y respeta RLS', () => {
  const s = read('supabase/migrations/20260730120000_p0a_order_cogs_gap_detector.sql')
  assert.match(s, /CREATE OR REPLACE VIEW "public"\."v_finance_order_cogs_gaps"/)
  assert.match(s, /WITH \(security_invoker = true\)/, 'sin security_invoker la vista filtra entre negocios')
  assert.match(s, /cogs_incompleto/)
  assert.match(s, /riesgo_doble_stock/)
  assert.match(s, /snapshot_de_costo_faltante/)
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\s+INTO?\b/i.test(s.replace(/--[^\n]*/g, '')),
    'el detector no escribe nada')
})
