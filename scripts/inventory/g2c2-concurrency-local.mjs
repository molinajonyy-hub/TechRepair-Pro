#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// G2-C.2 · Matriz de CONCURRENCIA con conexiones reales.
//
// Cada carrera abre DOS procesos psql independientes (dos backends, dos
// transacciones) contra el Supabase LOCAL, como `authenticated` del tenant, y
// ejecuta los writers VIVOS sin modificarlos. Una tercera conexion de solo
// lectura mira pg_stat_activity / pg_blocking_pids para probar QUE hubo espera
// de lock (y no un orden feliz por casualidad).
//
// Tecnica: el "holder" ejecuta su writer y despues pg_sleep ANTES del COMMIT
// (ensancha la ventana que ya existe entre su UPDATE y el fin de su
// transaccion); el "late" arranca despues. Nada se simula dentro de una sola
// transaccion. Para el orden de locks multi-item se usa una tercera transaccion
// "compuerta" (un writer real que retiene una fila) que fuerza el orden de
// espera que produce el ciclo si el orden no es determinista.
//
// Por cada carrera se verifica:
//   · stock_final == esperado == stock_inicial + SUM(quantity)
//   · cadena continua: existe UN orden con previous(N+1) = new(N)
//   · invariante por fila: new_stock - previous_stock = quantity
//   · pg_stat_database.deadlocks sin cambios
//
// Cada escenario usa un NEGOCIO propio (uuid aleatorio): los escenarios no se
// pisan y el advisory de periodo (que es por negocio) no los serializa entre si.
// Deja esos negocios de prueba en la base local (descartable).
//
//   node scripts/inventory/g2c2-concurrency-local.mjs            (todo)
//   node scripts/inventory/g2c2-concurrency-local.mjs 1,2,WS      (algunos)
//   G2C2_DB_CONTAINER=supabase_db_<id>  -> otro stack local
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const CT = process.env.G2C2_DB_CONTAINER || 'supabase_db_techrepair-vite'
if (!/^supabase_db_[\w.-]+$/.test(CT)) {
  console.error(`ABORTADO: ${CT} no es un contenedor de Supabase local (supabase_db_*).`)
  process.exit(2)
}

// ── psql ─────────────────────────────────────────────────────────────────────
function psql(sql) {
  return new Promise((resolve) => {
    const p = spawn('docker', ['exec', '-i', CT, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-F', '|'])
    let out = '', err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
    p.stdin.end(sql)
  })
}
async function q(sql) {
  const r = await psql('\\set ON_ERROR_STOP 1\n' + sql)
  if (r.code !== 0 || /ERROR/.test(r.err)) throw new Error(`SQL fallo: ${r.err}\n${sql.slice(0, 400)}`)
  return r.out
}
const val = async (sql) => (await q(sql)).split('\n').pop()

// ── Aserciones ───────────────────────────────────────────────────────────────
let asserts = 0
const fallas = []
function check(cond, label) {
  asserts++
  if (cond) console.log(`   PASS  ${label}`)
  else { fallas.push(label); console.log(`   FAIL  ${label}`) }
}

// ── Fixture ──────────────────────────────────────────────────────────────────
const PREV_MONTH = "(date_trunc('month', public.ar_today()) - interval '1 day')::date"

async function negocio(tag, { wholesale = false } = {}) {
  const t = { biz: randomUUID(), own: randomUUID(), cust: randomUUID(), caja: randomUUID(), prov: randomUUID(),
              ord: randomUUID(), wcu: randomUUID(), wc: randomUUID(), slug: `g2c2-${randomUUID().slice(0, 8)}` }
  await q(`BEGIN;
SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES ('${t.own}'), ('${t.wcu}');
INSERT INTO public.businesses(id, name, owner_user_id, subscription_plan, subscription_status,
                              wholesale_portal_enabled, wholesale_portal_slug)
  VALUES ('${t.biz}', 'G2C2 ${tag}', '${t.own}', 'full', 'active', ${wholesale}, '${t.slug}');
INSERT INTO public.profiles(id, user_id, business_id, role, is_active) VALUES ('${t.own}','${t.own}','${t.biz}','owner',true);
INSERT INTO public.customers(id, business_id, name, phone, customer_type) VALUES ('${t.cust}','${t.biz}','Cliente','+5400','minorista');
INSERT INTO public.cajas(id, business_id, opened_by, status) VALUES ('${t.caja}','${t.biz}','${t.own}','abierta');
INSERT INTO public.suppliers(id, business_id, name) VALUES ('${t.prov}','${t.biz}','Proveedor');
INSERT INTO public.orders(id, business_id, customer_id) VALUES ('${t.ord}','${t.biz}','${t.cust}');
${wholesale ? `INSERT INTO public.wholesale_customers(id, business_id, auth_user_id, name, email, approved, suspended)
  VALUES ('${t.wc}','${t.biz}','${t.wcu}','Mayorista','${t.slug}@g2c2.test',true,false);` : ''}
COMMIT;`)
  return t
}

// Productos con stock inicial; devueltos ORDENADOS por id (x < y < ...).
async function productos(t, n, stock = 10) {
  const ids = Array.from({ length: n }, () => randomUUID()).sort()
  await q(`BEGIN; SET LOCAL session_replication_role = 'replica';
INSERT INTO public.inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price,
                             precio_mayorista, base_price, base_currency, auto_update_price, exchange_rate_used,
                             is_active, visible_in_wholesale)
VALUES ${ids.map((id, i) => `('${id}','${t.biz}','P${i}','G2C2-${id.slice(0, 13)}','Rep',${stock},${stock},600,1000,700,1000,'ARS',false,1,true,true)`).join(',\n')};
COMMIT;`)
  return ids
}

// ── Writers (objetos vivos, como `authenticated`) ─────────────────────────────
const W = {
  orderItem: (t, p, qty, order = t.ord) =>
    `INSERT INTO public.order_items(order_id,business_id,tipo,descripcion,product_id,cantidad,precio_unitario)
       VALUES ('${order}','${t.biz}','repuesto','g2c2','${p}',${qty},1000) RETURNING 'order_item', id;\n`,
  orderItemUpdate: (id, qty) => `UPDATE public.order_items SET cantidad = ${qty} WHERE id = '${id}' RETURNING 'order_item_upd', id;\n`,
  orderItemDelete: (id) => `DELETE FROM public.order_items WHERE id = '${id}' RETURNING 'order_item_del', id;\n`,
  orderDelete: (id) => `DELETE FROM public.orders WHERE id = '${id}' RETURNING 'order_del', id;\n`,
  purchase: (t, items, key, date = 'public.ar_today()') =>
    `SELECT 'purchase', public.create_supplier_purchase_atomic('${t.biz}','${t.prov}','${t.own}','Proveedor',${date},
       'FC-${key}', ${items.reduce((s, i) => s + i.q * 600, 0)}, 0, NULL, 'g2c2',
       jsonb_build_array(${items.map((i) => `jsonb_build_object('inventory_id','${i.p}','product_name','x','quantity',${i.q},'unit_cost',600)`).join(',')}),
       '${key}');\n`,
  deletePurchase: (t, pid) => `SELECT 'delete_purchase', public.delete_supplier_purchase_safe('${t.biz}','${pid}','${t.own}');\n`,
  checkout: (t, items, key) =>
    `SELECT 'checkout', public.create_comprobante_checkout_atomic('${t.biz}','${key}','h-${key}',
       jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final',
         'customer_id','${t.cust}','cc_total',0,'emitir_en_arca',false,
         'items', jsonb_build_array(${items.map((i) => `jsonb_build_object('inventory_id','${i.p}','descripcion','g2c2','tipo_linea','producto','cantidad',${i.q},'precio_unitario',1000)`).join(',')}),
         'pagos', jsonb_build_array(jsonb_build_object('amount',${items.reduce((s, i) => s + i.q * 1000, 0)},'amount_ars',${items.reduce((s, i) => s + i.q * 1000, 0)},'payment_method','efectivo'))));\n`,
  annul: (compId, key) => `SELECT 'annul', public.annul_comprobante_atomic('${compId}','refund_current_session','g2c2',true,'${key}');\n`,
  repair: (t) => `SELECT 'repair', public.repair_missing_stock_movements('${t.biz}', true);\n`,
  wholesale: (t, items) =>
    `SELECT 'wholesale', public.create_wholesale_order_atomic('${t.slug}',
       jsonb_build_array(${items.map((i) => `jsonb_build_object('inventory_item_id','${i.p}','quantity',${i.q})`).join(',')}), 'g2c2');\n`,
}
const key = (s) => `${s}-${randomUUID().slice(0, 8)}`

const como = (uid, app) =>
  `SET application_name = '${app}';\nSELECT set_config('request.jwt.claim.sub','${uid}',false) \\g /dev/null\nSET ROLE authenticated;\n`
const log = (who, what) => `SELECT 'T', to_char(clock_timestamp(),'HH24:MI:SS.MS'), '${who}', '${what}';\n`
const holder = (uid, who, writer, hold = 2) =>
  como(uid, `g2c2-${who}`) + 'BEGIN;\n' + log(who, 'BEGIN') + writer + log(who, 'writer devolvio; retiene el lock') +
  `SELECT pg_sleep(${hold}) \\g /dev/null\n` + 'COMMIT;\n' + log(who, 'COMMIT')
const late = (uid, who, writer, delay = 0.7) =>
  `SELECT pg_sleep(${delay}) \\g /dev/null\n` + como(uid, `g2c2-${who}`) + 'BEGIN;\n' + log(who, 'BEGIN') + writer +
  log(who, 'writer devolvio') + 'COMMIT;\n' + log(who, 'COMMIT')
const monitor = (at) => `SELECT pg_sleep(${at}) \\g /dev/null
SELECT 'MON', a.application_name, coalesce(a.wait_event_type,'-'), coalesce(a.wait_event,'-'),
       coalesce((SELECT string_agg(b.application_name, ',') FROM pg_stat_activity b WHERE b.pid = ANY (pg_blocking_pids(a.pid))), '-')
  FROM pg_stat_activity a WHERE a.application_name LIKE 'g2c2-%' ORDER BY 2;\n`

const deadlocks = async () => Number(await val(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();`))

// Estado de cada producto: stock, SUM(quantity), filas rotas y CADENA continua.
//
// La cadena se valida de dos formas, ambas acotadas en costo:
//   · balance euleriano (siempre, O(n)): los movimientos son aristas
//     previous_stock -> new_stock. Si las operaciones se serializaron, forman UN
//     camino que usa todas las aristas desde el stock inicial al actual: cada
//     valor tiene tantas entradas como salidas, salvo el inicial (+1) y el final
//     (-1). Un lost update deja un valor con DOS salidas (dos operaciones que
//     leyeron el mismo previous_stock) y rompe el balance.
//   · recorrido exacto (solo hasta 12 movimientos): busca el camino concreto.
//     Es exponencial en el peor caso: con miles de movimientos (pgbench) llenaba
//     pgsql_tmp hasta "No space left on device". Por eso NO se usa en carga.
async function estado(ids, inicial) {
  const lista = ids.map((i) => `'${i}'`).join(',')
  const ini = `(VALUES ${ids.map((i) => `('${i}'::uuid, ${inicial[i]})`).join(',')}) s(k, v)`
  const base = await q(`WITH e AS (
  SELECT inventory_item_id AS item, previous_stock AS p, new_stock AS n FROM public.inventory_movements
   WHERE inventory_item_id IN (${lista})
), deg AS (
  SELECT item, v, sum(o) - sum(x) AS d
    FROM (SELECT item, p AS v, 1 AS o, 0 AS x FROM e UNION ALL SELECT item, n, 0, 1 FROM e) t
   GROUP BY item, v
)
SELECT i.id, i.stock_quantity, i.stock,
       coalesce((SELECT sum(quantity) FROM public.inventory_movements WHERE inventory_item_id = i.id), 0),
       (SELECT count(*) FROM e WHERE e.item = i.id),
       (SELECT count(*) FROM public.inventory_movements WHERE inventory_item_id = i.id AND new_stock - previous_stock <> quantity),
       NOT EXISTS (
         SELECT 1 FROM deg, ${ini}
          WHERE deg.item = i.id AND s.k = i.id
            AND deg.d <> (CASE WHEN s.v = i.stock_quantity THEN 0
                               WHEN deg.v = s.v THEN 1
                               WHEN deg.v = i.stock_quantity THEN -1 ELSE 0 END))
       AND ((SELECT count(*) FROM e WHERE e.item = i.id) = 0
            OR (SELECT v FROM ${ini} WHERE s.k = i.id) = i.stock_quantity
            OR EXISTS (SELECT 1 FROM deg, ${ini} WHERE deg.item = i.id AND s.k = i.id AND deg.v = s.v AND deg.d = 1))
  FROM public.inventory i WHERE i.id IN (${lista});`)
  const r = {}
  for (const line of base.split('\n').filter(Boolean)) {
    const [id, stock, alias, suma, movs, rotas, balance] = line.split('|')
    r[id] = { stock: Number(stock), alias: Number(alias), suma: Number(suma), movs: Number(movs), rotas: Number(rotas),
              balance: balance === 't', cadena: balance === 't', exacta: null }
  }
  const chicos = ids.filter((i) => r[i] && r[i].movs > 0 && r[i].movs <= 12)
  if (chicos.length) {
    const out = await q(`WITH RECURSIVE m AS (
  SELECT id, inventory_item_id AS item, previous_stock, new_stock FROM public.inventory_movements
   WHERE inventory_item_id IN (${chicos.map((i) => `'${i}'`).join(',')})
), walk AS (
  SELECT item, ARRAY[id] AS path, new_stock AS last_new FROM m
   WHERE previous_stock = (SELECT v FROM ${ini} WHERE s.k = m.item)
  UNION ALL
  SELECT w.item, w.path || m.id, m.new_stock FROM walk w
    JOIN m ON m.item = w.item AND m.previous_stock = w.last_new AND NOT m.id = ANY (w.path)
)
SELECT i.id, EXISTS (SELECT 1 FROM walk w WHERE w.item = i.id AND w.last_new = i.stock_quantity
                      AND cardinality(w.path) = (SELECT count(*) FROM m WHERE m.item = i.id))
  FROM public.inventory i WHERE i.id IN (${chicos.map((i) => `'${i}'`).join(',')});`)
    for (const line of out.split('\n').filter(Boolean)) {
      const [id, ok] = line.split('|')
      r[id].exacta = ok === 't'
      r[id].cadena = r[id].balance && r[id].exacta
    }
  }
  return r
}

function verificar(label, est, esperado, inicial) {
  for (const [id, exp] of Object.entries(esperado)) {
    const e = est[id]
    const tag = `${label} · ${id.slice(0, 8)}`
    check(e.stock === exp, `${tag} stock final ${e.stock} == esperado ${exp}`)
    check(e.stock === inicial[id] + e.suma, `${tag} stock == inicial ${inicial[id]} + SUM(quantity) ${e.suma}`)
    check(e.cadena, `${tag} cadena continua previous(N+1) = new(N) (${e.movs} movimientos; balance euleriano${e.exacta === null ? '' : ' + recorrido exacto'})`)
    check(e.rotas === 0, `${tag} invariante por fila new - previous = quantity`)
    check(e.alias === e.stock, `${tag} alias stock == stock_quantity`)
  }
}

const sinError = (label, r) => check(r.code === 0 && !/ERROR/.test(r.err), `${label} sin error (${(r.err || 'ok').split('\n')[0].slice(0, 120)})`)
const jsonDe = (out, tag) => {
  const l = out.split('\n').find((x) => x.startsWith(tag + '|'))
  return l ? JSON.parse(l.slice(tag.length + 1)) : null
}

// Carrera de dos conexiones (+ monitor). Devuelve salidas y lineas del monitor.
async function carrera({ holderSql, lateSql, monitorAt = 1.3 }) {
  const d0 = await deadlocks()
  const [a, b, m] = await Promise.all([psql(holderSql), psql(lateSql), psql(monitor(monitorAt))])
  const d1 = await deadlocks()
  return { a, b, mon: m.out.split('\n').filter((l) => l.startsWith('MON')), dl: d1 - d0 }
}
const esperoLock = (mon, app) => mon.some((l) => { const [, name, type] = l.split('|'); return name === `g2c2-${app}` && type === 'Lock' })

// Carrera de tres conexiones: compuerta + primer writer + segundo writer.
async function carrera3({ gateSql, firstSql, secondSql }) {
  const d0 = await deadlocks()
  const [g, a, b, m] = await Promise.all([psql(gateSql), psql(firstSql), psql(secondSql), psql(monitor(1.6))])
  const d1 = await deadlocks()
  return { g, a, b, mon: m.out.split('\n').filter((l) => l.startsWith('MON')), dl: d1 - d0 }
}

// ── Escenarios ───────────────────────────────────────────────────────────────
const E = {}

// 1 · order_item -2 || order_item -3  (10 -> 5), en ambos ordenes
E['1'] = async () => {
  for (const orden of ['A-primero', 'B-primero']) {
    const t = await negocio('1'); const [p] = await productos(t, 1)
    const [x, y] = orden === 'A-primero' ? [2, 3] : [3, 2]
    const r = await carrera({ holderSql: holder(t.own, 'h', W.orderItem(t, p, x)), lateSql: late(t.own, 'l', W.orderItem(t, p, y)) })
    sinError(`1 ${orden} holder`, r.a); sinError(`1 ${orden} late`, r.b)
    check(esperoLock(r.mon, 'l'), `1 ${orden} el segundo order_item ESPERO el lock del producto`)
    check(r.dl === 0, `1 ${orden} cero deadlocks`)
    verificar(`1 ${orden}`, await estado([p], { [p]: 10 }), { [p]: 5 }, { [p]: 10 })
  }
}

// 2 · order_item -2 || compra +5  (10 -> 13), en ambos ordenes
E['2'] = async () => {
  for (const orden of ['item-primero', 'compra-primero']) {
    const t = await negocio('2'); const [p] = await productos(t, 1)
    const item = W.orderItem(t, p, 2), compra = W.purchase(t, [{ p, q: 5 }], key('c2'))
    const r = await carrera(orden === 'item-primero'
      ? { holderSql: holder(t.own, 'h', item), lateSql: late(t.own, 'l', compra) }
      : { holderSql: holder(t.own, 'h', compra), lateSql: late(t.own, 'l', item) })
    sinError(`2 ${orden} holder`, r.a); sinError(`2 ${orden} late`, r.b)
    check(esperoLock(r.mon, 'l'), `2 ${orden} el late ESPERO el lock`)
    check(r.dl === 0, `2 ${orden} cero deadlocks`)
    verificar(`2 ${orden}`, await estado([p], { [p]: 10 }), { [p]: 13 }, { [p]: 10 })
  }
}

// 3 · checkout -2 || order_item -3  (10 -> 5), en AMBOS ordenes de inicio
E['3'] = async () => {
  for (const orden of ['checkout-primero', 'item-primero']) {
    const t = await negocio('3'); const [p] = await productos(t, 1)
    const co = W.checkout(t, [{ p, q: 2 }], key('co3')), item = W.orderItem(t, p, 3)
    const r = await carrera(orden === 'checkout-primero'
      ? { holderSql: holder(t.own, 'h', co), lateSql: late(t.own, 'l', item) }
      : { holderSql: holder(t.own, 'h', item), lateSql: late(t.own, 'l', co) })
    sinError(`3 ${orden} holder`, r.a); sinError(`3 ${orden} late`, r.b)
    check(esperoLock(r.mon, 'l'), `3 ${orden} el late ESPERO el lock`)
    const co3 = jsonDe(orden === 'checkout-primero' ? r.a.out : r.b.out, 'checkout')
    check(co3?.status === 'created', `3 ${orden} checkout created (${JSON.stringify(co3)})`)
    check(r.dl === 0, `3 ${orden} cero deadlocks`)
    verificar(`3 ${orden}`, await estado([p], { [p]: 10 }), { [p]: 5 }, { [p]: 10 })
  }
}

// 4 · compra +5 (mes anterior) || compra +3 (este mes): distinto advisory de periodo  (10 -> 18)
E['4'] = async () => {
  for (const orden of ['anterior-primero', 'actual-primero']) {
    const t = await negocio('4'); const [p] = await productos(t, 1)
    const prev = W.purchase(t, [{ p, q: 5 }], key('c4a'), PREV_MONTH), hoy = W.purchase(t, [{ p, q: 3 }], key('c4b'))
    const r = await carrera(orden === 'anterior-primero'
      ? { holderSql: holder(t.own, 'h', prev), lateSql: late(t.own, 'l', hoy) }
      : { holderSql: holder(t.own, 'h', hoy), lateSql: late(t.own, 'l', prev) })
    sinError(`4 ${orden} holder`, r.a); sinError(`4 ${orden} late`, r.b)
    check(esperoLock(r.mon, 'l'), `4 ${orden} el late ESPERO el lock de la fila (no hay advisory comun)`)
    check(r.dl === 0, `4 ${orden} cero deadlocks`)
    verificar(`4 ${orden}`, await estado([p], { [p]: 10 }), { [p]: 18 }, { [p]: 10 })
  }
}

// 5 · borrar compra -4 || compra +5   (10 +4 = 14 -> 15), en ambos ordenes
E['5'] = async () => {
  for (const orden of ['borrar-primero', 'compra-primero']) {
    const t = await negocio('5'); const [p] = await productos(t, 1)
    const pid = jsonDe(await q(como(t.own, 's') + W.purchase(t, [{ p, q: 4 }], key('c5s'))), 'purchase').purchase_id
    const del = W.deletePurchase(t, pid), compra = W.purchase(t, [{ p, q: 5 }], key('c5'))
    const r = await carrera(orden === 'borrar-primero'
      ? { holderSql: holder(t.own, 'h', del), lateSql: late(t.own, 'l', compra) }
      : { holderSql: holder(t.own, 'h', compra), lateSql: late(t.own, 'l', del) })
    sinError(`5 ${orden} holder`, r.a); sinError(`5 ${orden} late`, r.b)
    const d = jsonDe(orden === 'borrar-primero' ? r.a.out : r.b.out, 'delete_purchase')
    check(d?.ok === true && d?.replay === false, `5 ${orden} borrado ok (${JSON.stringify(d)})`)
    check(esperoLock(r.mon, 'l'), `5 ${orden} el late ESPERO el lock`)
    check(r.dl === 0, `5 ${orden} cero deadlocks`)
    verificar(`5 ${orden}`, await estado([p], { [p]: 10 }), { [p]: 15 }, { [p]: 10 })
  }
}

// Hueco historico para la reparacion: venta real + marcar la linea sin procesar
// y devolver el stock SIN movimiento (el estado exacto para el que existe la RPC).
async function huecoDeReparacion(t, items) {
  const co = jsonDe(await q(como(t.own, 's') + W.checkout(t, items, key('rep'))), 'checkout')
  await q(`BEGIN; SET LOCAL session_replication_role = 'replica';
UPDATE public.comprobante_items SET stock_processed = false, stock_processed_at = NULL, stock_movement_id = NULL
 WHERE comprobante_id = '${co.comprobante_id}';
DELETE FROM public.inventory_movements WHERE reference_id = '${co.comprobante_id}';
${items.map((i) => `UPDATE public.inventory SET stock_quantity = stock_quantity + ${i.q}, stock = stock + ${i.q} WHERE id = '${i.p}';`).join('\n')}
COMMIT;`)
  return co.comprobante_id
}

// 6 · reparacion -2 || compra +5   (10 -> 13), en ambos ordenes; cadena exacta
E['6'] = async () => {
  for (const orden of ['reparacion-primero', 'compra-primero']) {
    const t = await negocio('6'); const [p] = await productos(t, 1)
    await huecoDeReparacion(t, [{ p, q: 2 }])
    const rep = W.repair(t), compra = W.purchase(t, [{ p, q: 5 }], key('c6'))
    const r = await carrera(orden === 'reparacion-primero'
      ? { holderSql: holder(t.own, 'h', rep), lateSql: late(t.own, 'l', compra) }
      : { holderSql: holder(t.own, 'h', compra), lateSql: late(t.own, 'l', rep) })
    sinError(`6 ${orden} holder`, r.a); sinError(`6 ${orden} late`, r.b)
    const j = jsonDe(orden === 'reparacion-primero' ? r.a.out : r.b.out, 'repair')
    check(j?.comprobantes_procesados === 1, `6 ${orden} la reparacion proceso 1 linea (${JSON.stringify(j)})`)
    check(esperoLock(r.mon, 'l'), `6 ${orden} el late ESPERO el lock`)
    check(r.dl === 0, `6 ${orden} cero deadlocks`)
    verificar(`6 ${orden}`, await estado([p], { [p]: 10 }), { [p]: 13 }, { [p]: 10 })
  }
}

// 6b · dos reparaciones concurrentes: la segunda espera, relee y no duplica impacto.
E['6b'] = async () => {
  const t = await negocio('6b'); const [p] = await productos(t, 1)
  await huecoDeReparacion(t, [{ p, q: 2 }])
  const r = await carrera({ holderSql: holder(t.own, 'h', W.repair(t)), lateSql: late(t.own, 'l', W.repair(t)) })
  sinError('6b holder', r.a); sinError('6b late', r.b)
  const j1 = jsonDe(r.a.out, 'repair'), j2 = jsonDe(r.b.out, 'repair')
  check(j1?.comprobantes_procesados === 1, `6b primera reparacion procesa 1 (${JSON.stringify(j1)})`)
  check(j2?.comprobantes_procesados === 0, `6b segunda reparacion procesa 0: releyo el estado (${JSON.stringify(j2)})`)
  check(esperoLock(r.mon, 'l'), '6b la segunda reparacion ESPERO por inventario')
  check(r.dl === 0, '6b cero deadlocks')
  verificar('6b', await estado([p], { [p]: 10 }), { [p]: 8 }, { [p]: 10 })
}

// 7 · INSERT / UPDATE cantidad / DELETE de order_item concurrentes
E['7'] = async () => {
  // 7a · UPDATE 1 -> 4 (-3) || INSERT -2 : 10 -1 = 9 -> 4
  {
    const t = await negocio('7a'); const [p] = await productos(t, 1)
    const id = (await q(como(t.own, 's') + W.orderItem(t, p, 1))).split('\n').find((l) => l.startsWith('order_item|')).split('|')[1]
    const r = await carrera({ holderSql: holder(t.own, 'h', W.orderItemUpdate(id, 4)), lateSql: late(t.own, 'l', W.orderItem(t, p, 2)) })
    sinError('7a holder', r.a); sinError('7a late', r.b)
    check(esperoLock(r.mon, 'l'), '7a el INSERT ESPERO al UPDATE de cantidad')
    check(r.dl === 0, '7a cero deadlocks')
    verificar('7a UPDATE||INSERT', await estado([p], { [p]: 10 }), { [p]: 4 }, { [p]: 10 })
  }
  // 7b · DELETE (+2) || INSERT -3 : 10 -2 = 8 -> 7
  {
    const t = await negocio('7b'); const [p] = await productos(t, 1)
    const id = (await q(como(t.own, 's') + W.orderItem(t, p, 2))).split('\n').find((l) => l.startsWith('order_item|')).split('|')[1]
    const r = await carrera({ holderSql: holder(t.own, 'h', W.orderItemDelete(id)), lateSql: late(t.own, 'l', W.orderItem(t, p, 3)) })
    sinError('7b holder', r.a); sinError('7b late', r.b)
    check(esperoLock(r.mon, 'l'), '7b el INSERT ESPERO al DELETE')
    check(r.dl === 0, '7b cero deadlocks')
    verificar('7b DELETE||INSERT', await estado([p], { [p]: 10 }), { [p]: 7 }, { [p]: 10 })
  }
  // 7c · UPDATE 2 -> 1 (+1) || DELETE de otro item (+3): 10 -2 -3 = 5 -> 9
  {
    const t = await negocio('7c'); const [p] = await productos(t, 1)
    const out = await q(como(t.own, 's') + W.orderItem(t, p, 2) + W.orderItem(t, p, 3))
    const [id1, id2] = out.split('\n').filter((l) => l.startsWith('order_item|')).map((l) => l.split('|')[1])
    const r = await carrera({ holderSql: holder(t.own, 'h', W.orderItemUpdate(id1, 1)), lateSql: late(t.own, 'l', W.orderItemDelete(id2)) })
    sinError('7c holder', r.a); sinError('7c late', r.b)
    check(esperoLock(r.mon, 'l'), '7c el DELETE ESPERO al UPDATE')
    check(r.dl === 0, '7c cero deadlocks')
    verificar('7c UPDATE||DELETE', await estado([p], { [p]: 10 }), { [p]: 9 }, { [p]: 10 })
  }
}

// 8 · stock negativo: stock 1; -2 || -3 => -4
E['8'] = async () => {
  const t = await negocio('8'); const [p] = await productos(t, 1, 1)
  const r = await carrera({ holderSql: holder(t.own, 'h', W.orderItem(t, p, 2)), lateSql: late(t.own, 'l', W.checkout(t, [{ p, q: 3 }], key('co8'))) })
  sinError('8 holder', r.a); sinError('8 late', r.b)
  check(esperoLock(r.mon, 'l'), '8 el late ESPERO el lock')
  check(r.dl === 0, '8 cero deadlocks')
  verificar('8 negativo', await estado([p], { [p]: 1 }), { [p]: -4 }, { [p]: 1 })
}

// 9 · reversa exacta: anulacion (+2, restore) || order_item -3.  10 -2 +2 -3 = 7
E['9'] = async () => {
  for (const orden of ['anulacion-primero', 'item-primero']) {
    const t = await negocio('9'); const [p] = await productos(t, 1)
    const comp = jsonDe(await q(como(t.own, 's') + W.checkout(t, [{ p, q: 2 }], key('co9'))), 'checkout').comprobante_id
    const an = W.annul(comp, key('an9')), item = W.orderItem(t, p, 3)
    const r = await carrera(orden === 'anulacion-primero'
      ? { holderSql: holder(t.own, 'h', an), lateSql: late(t.own, 'l', item) }
      : { holderSql: holder(t.own, 'h', item), lateSql: late(t.own, 'l', an) })
    sinError(`9 ${orden} holder`, r.a); sinError(`9 ${orden} late`, r.b)
    const a = jsonDe(orden === 'anulacion-primero' ? r.a.out : r.b.out, 'annul')
    check(a?.ok === true && a?.stock_restored_count === 1, `9 ${orden} anulacion con reversa de stock (${JSON.stringify(a)?.slice(0, 90)})`)
    check(esperoLock(r.mon, 'l'), `9 ${orden} el late ESPERO el lock`)
    check(r.dl === 0, `9 ${orden} cero deadlocks`)
    verificar(`9 ${orden}`, await estado([p], { [p]: 10 }), { [p]: 7 }, { [p]: 10 })
  }
}

// 10 · multi-producto [A,B] || [B,A] con compuerta: CERO deadlocks.
// La compuerta (order_item real) retiene X; el checkout [X,Y] encola primero en
// X; el segundo writer trae [Y,X]. Antes de G2-C.2 esto cerraba un ciclo.
E['10'] = async () => {
  const casos = {
    'compra (mes anterior)': async (t, x, y) => W.purchase(t, [{ p: y, q: 1 }, { p: x, q: 1 }], key('c10'), PREV_MONTH),
    'borrar compra': async (t, x, y) => {
      const pid = jsonDe(await q(como(t.own, 's') + W.purchase(t, [{ p: y, q: 1 }, { p: x, q: 1 }], key('c10s'))), 'purchase').purchase_id
      return W.deletePurchase(t, pid)
    },
    'reparacion': async (t, x, y) => { await huecoDeReparacion(t, [{ p: y, q: 1 }, { p: x, q: 1 }]); return W.repair(t) },
    'borrar orden (cascada)': async (t, x, y) => {
      const ord2 = randomUUID()
      await q(`BEGIN; SET LOCAL session_replication_role='replica';
INSERT INTO public.orders(id, business_id, customer_id) VALUES ('${ord2}','${t.biz}','${t.cust}'); COMMIT;`)
      await q(como(t.own, 's') + W.orderItem(t, y, 1, ord2) + W.orderItem(t, x, 1, ord2))
      return W.orderDelete(ord2)
    },
  }
  for (const [nombre, preparar] of Object.entries(casos)) {
    for (const compuerta of ['X', 'Y']) {
      const t = await negocio('10'); const [x, y] = await productos(t, 2)
      const segundo = await preparar(t, x, y)
      // La cadena se valida desde el stock SEMBRADO: la preparacion tambien deja movimientos.
      const inicial = { [x]: 10, [y]: 10 }
      const r = await carrera3({
        gateSql: holder(t.own, 'g', W.orderItem(t, compuerta === 'X' ? x : y, 1), 2),
        firstSql: late(t.own, 'c', W.checkout(t, [{ p: x, q: 1 }, { p: y, q: 1 }], key('co10')), 0.4),
        secondSql: late(t.own, 's', segundo, 0.8),
      })
      const tag = `10 ${nombre} · compuerta en ${compuerta}`
      sinError(`${tag} compuerta`, r.g); sinError(`${tag} checkout`, r.a); sinError(`${tag} ${nombre}`, r.b)
      check(r.dl === 0, `${tag} CERO deadlocks (pg_stat_database.deadlocks +${r.dl})`)
      const co = jsonDe(r.a.out, 'checkout')
      check(co?.status === 'created', `${tag} el checkout del POS no fue victima (${JSON.stringify(co)})`)
      const segJson = r.b.out.split('\n').find((l) => /^(purchase|delete_purchase|repair)\|/.test(l))
      if (segJson) {
        const j = JSON.parse(segJson.slice(segJson.indexOf('|') + 1))
        check(j.ok !== false, `${tag} ${nombre} no devolvio error (${JSON.stringify(j).slice(0, 100)})`)
      }
      if (nombre.startsWith('borrar orden')) {
        check(/^order_del\|/m.test(r.b.out), `${tag} la orden se borro de verdad (la cascada corrio)`)
      }
      const est = await estado([x, y], inicial)
      for (const id of [x, y]) {
        check(est[id].cadena && est[id].rotas === 0, `${tag} · ${id === x ? 'X' : 'Y'} cadena continua e invariante por fila`)
      }
    }
  }
}

// 11 · productos distintos NO se bloquean (writers sin advisory de periodo).
// El repuesto sobre Y va en OTRA orden: dos repuestos de la MISMA orden se
// serializan por la fila de `orders` (recalculate_order_total la actualiza en
// cada alta). Eso es previo a G2-C.2 y no es un lock de inventario.
E['11'] = async () => {
  const t = await negocio('11'); const [x, y] = await productos(t, 2)
  const ordB = randomUUID()
  await q(`BEGIN; SET LOCAL session_replication_role='replica';
INSERT INTO public.orders(id, business_id, customer_id) VALUES ('${ordB}','${t.biz}','${t.cust}'); COMMIT;`)
  const pid = jsonDe(await q(como(t.own, 's') + W.purchase(t, [{ p: y, q: 1 }], key('c11'))), 'purchase').purchase_id
  for (const [nombre, sql] of [['order_item sobre Y (otra orden)', W.orderItem(t, y, 1, ordB)], ['borrar compra de Y', W.deletePurchase(t, pid)],
                               ['compra de Y con fecha del mes anterior', W.purchase(t, [{ p: y, q: 1 }], key('c11b'), PREV_MONTH)]]) {
    const r = await carrera({ holderSql: holder(t.own, 'h', W.orderItem(t, x, 1), 2), lateSql: late(t.own, 'l', sql, 0.5), monitorAt: 0.9 })
    sinError(`11 ${nombre} holder`, r.a); sinError(`11 ${nombre} late`, r.b)
    check(!esperoLock(r.mon, 'l'), `11 ${nombre} NO espero lock mientras otro retenia X`)
    const tl = r.b.out.split('\n').filter((l) => l.startsWith('T|'))
    const ms = (s) => { const [h, m2, rest] = s.split(':'); return (Number(h) * 3600 + Number(m2) * 60 + Number(rest)) * 1000 }
    const dur = tl.length >= 2 ? ms(tl[tl.length - 1].split('|')[1]) - ms(tl[0].split('|')[1]) : 99999
    check(dur < 1000, `11 ${nombre} termino en ${Math.round(dur)} ms (< 1000 ms, el holder retiene 2000 ms)`)
  }
}

// 12 · cross-tenant bajo concurrencia: B vende su producto mientras A intenta
// descontarlo desde su orden. A falla; B termina exacto; nada se filtra a A.
E['12'] = async () => {
  const a = await negocio('12A'); const b = await negocio('12B'); const [pb] = await productos(b, 1)
  const r = await carrera({
    holderSql: holder(b.own, 'h', W.checkout(b, [{ p: pb, q: 2 }], key('co12'))),
    lateSql: late(a.own, 'l', W.orderItem(a, pb, 3)),
  })
  sinError('12 venta de B', r.a)
  check(/42501/.test(r.b.err) || /INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH/.test(r.b.err),
    `12 A no puede descontar el producto de B (${r.b.err.split('\n')[0].slice(0, 110)})`)
  verificar('12 producto de B', await estado([pb], { [pb]: 10 }), { [pb]: 8 }, { [pb]: 10 })
  const fuga = await val(`SELECT count(*) FROM public.inventory_movements WHERE business_id = '${a.biz}' AND inventory_item_id = '${pb}';`)
  check(fuga === '0', '12 cero inventory_movements de A sobre el producto de B')
  const items = await val(`SELECT count(*) FROM public.order_items WHERE business_id = '${a.biz}' AND product_id = '${pb}';`)
  check(items === '0', '12 el order_item cross-tenant no quedo')
}

// 16 · misma key de compra en paralelo: una crea, la otra hace replay; UN impacto.
E['16'] = async () => {
  const t = await negocio('16'); const [p] = await productos(t, 1)
  const k = key('c16'), sql = W.purchase(t, [{ p, q: 5 }], k)
  const r = await carrera({ holderSql: holder(t.own, 'h', sql), lateSql: late(t.own, 'l', sql) })
  sinError('16 holder', r.a); sinError('16 late', r.b)
  const j1 = jsonDe(r.a.out, 'purchase'), j2 = jsonDe(r.b.out, 'purchase')
  check(j1?.ok === true && j1?.replay === false, `16 la primera crea (${JSON.stringify(j1)})`)
  check(j2?.ok === true && j2?.replay === true && j2?.purchase_id === j1?.purchase_id, `16 la segunda es replay de la misma compra (${JSON.stringify(j2)})`)
  const n = await val(`SELECT count(*) FROM public.supplier_purchases WHERE business_id = '${t.biz}';`)
  check(n === '1', `16 una sola compra persistida (${n})`)
  verificar('16', await estado([p], { [p]: 10 }), { [p]: 15 }, { [p]: 10 })
}

// ESTRES · sin ningun pg_sleep: pgbench con 8 clientes sobre los writers que
// antes perdian updates (repuestos + compras de otro mes) y sobre [A,B]/[B,A].
async function pgbench(nombre, scripts, segundos = 10) {
  for (const [f, body] of Object.entries(scripts)) {
    const w = spawn('docker', ['exec', '-i', CT, 'sh', '-c', `cat > /tmp/${f}`])
    await new Promise((res) => { w.on('close', res); w.stdin.end(body) })
  }
  const args = Object.keys(scripts).flatMap((f) => ['-f', `/tmp/${f}`])
  // 4 clientes por defecto (estacion local con varios stacks de Supabase y poco
  // disco: el WAL de la carga llego a llenarlo). CI (un stack, Linux) usa 8.
  const clientes = String(process.env.G2C2_PGBENCH_CLIENTS || 4)
  return new Promise((resolve) => {
    const p = spawn('docker', ['exec', CT, 'pgbench', '-U', 'postgres', '-d', 'postgres', '-n', '-c', clientes, '-j', '2', '-T', String(segundos), ...args])
    let out = ''
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
    p.on('close', () => { console.log(`   pgbench ${nombre}: ${(out.match(/number of transactions actually processed: \d+/) || ['?'])[0]}, ${(out.match(/number of failed transactions: \d+/) || ['?'])[0]}`); resolve(out) })
  })
}
const pbComo = (uid) => `BEGIN;\nSELECT set_config('request.jwt.claim.sub','${uid}',true);\nSET LOCAL ROLE authenticated;\n`

E['S1'] = async () => {
  const t = await negocio('S1'); const [p] = await productos(t, 1)
  await pgbench('lost update (repuestos + compras de otro mes)', {
    'g2c2_oi.sql': pbComo(t.own) + W.orderItem(t, p, 1) + 'COMMIT;\n',
    'g2c2_pp.sql': pbComo(t.own) + `SELECT public.create_supplier_purchase_atomic('${t.biz}','${t.prov}','${t.own}','Proveedor',${PREV_MONTH},'PB',600,0,NULL,'pb',
       jsonb_build_array(jsonb_build_object('inventory_id','${p}','product_name','x','quantity',1,'unit_cost',600)), NULL);\nCOMMIT;\n`,
  })
  const est = await estado([p], { [p]: 10 })
  check(est[p].movs > 100, `S1 carga real: ${est[p].movs} movimientos concurrentes`)
  check(est[p].stock === 10 + est[p].suma, `S1 SIN lost update: stock ${est[p].stock} == 10 + SUM(quantity) ${est[p].suma}`)
  check(est[p].balance, 'S1 cadena continua (balance euleriano: ningun previous_stock con dos salidas)')
  check(est[p].rotas === 0, 'S1 invariante por fila en todos los movimientos')
}

E['S2'] = async () => {
  const t = await negocio('S2'); const [a, b] = await productos(t, 2)
  const d0 = await deadlocks()
  await pgbench('[A,B] checkout || [B,A] compra de otro mes || repuestos', {
    'g2c2_co.sql': pbComo(t.own) + `SELECT public.create_comprobante_checkout_atomic('${t.biz}', gen_random_uuid()::text, 'pb',
       jsonb_build_object('tipo','remito','punto_venta','0001','condicion_fiscal','Consumidor Final','customer_id','${t.cust}','cc_total',0,'emitir_en_arca',false,
         'items', jsonb_build_array(jsonb_build_object('inventory_id','${a}','descripcion','pb','tipo_linea','producto','cantidad',1,'precio_unitario',1000),
                                    jsonb_build_object('inventory_id','${b}','descripcion','pb','tipo_linea','producto','cantidad',1,'precio_unitario',1000)),
         'pagos', jsonb_build_array(jsonb_build_object('amount',2000,'amount_ars',2000,'payment_method','efectivo'))));\nCOMMIT;\n`,
    'g2c2_pba.sql': pbComo(t.own) + `SELECT public.create_supplier_purchase_atomic('${t.biz}','${t.prov}','${t.own}','Proveedor',${PREV_MONTH},'PB',1200,0,NULL,'pb',
       jsonb_build_array(jsonb_build_object('inventory_id','${b}','product_name','x','quantity',1,'unit_cost',600),
                         jsonb_build_object('inventory_id','${a}','product_name','x','quantity',1,'unit_cost',600)), NULL);\nCOMMIT;\n`,
    'g2c2_oib.sql': pbComo(t.own) + W.orderItem(t, b, 1) + 'COMMIT;\n',
  }, 12)
  const dl = (await deadlocks()) - d0
  check(dl === 0, `S2 CERO deadlocks bajo carga [A,B]/[B,A] (antes de G2-C.2: 14 en 15 s) (+${dl})`)
  const fallidos = await val(`SELECT count(*) FROM public.comprobante_checkout_requests WHERE business_id = '${t.biz}' AND status <> 'completed';`)
  check(fallidos === '0', `S2 ningun checkout del POS fallo (${fallidos})`)
  const est = await estado([a, b], { [a]: 10, [b]: 10 })
  for (const id of [a, b]) {
    check(est[id].stock === 10 + est[id].suma, `S2 ${id === a ? 'A' : 'B'} SIN lost update: ${est[id].stock} == 10 + ${est[id].suma}`)
    check(est[id].rotas === 0, `S2 ${id === a ? 'A' : 'B'} invariante por fila`)
    check(est[id].balance, `S2 ${id === a ? 'A' : 'B'} cadena continua (balance euleriano)`)
  }
}

// EXTRA OBLIGATORIO · checkout [A,B] (FOR UPDATE) || alta mayorista [B,A]
// (wholesale_order_items: chequeo FK FOR KEY SHARE en orden del payload).
// La compuerta retiene B con un repuesto (NO KEY UPDATE): el checkout toma A y
// encola en B; el alta toma KEY SHARE de B (compatible con la compuerta) y
// encola en A (KEY SHARE vs FOR UPDATE del checkout). Al soltar la compuerta,
// el checkout necesita FOR UPDATE de B, que choca con el KEY SHARE del alta.
// Si PostgreSQL detecta un deadlock, es el residual G2-C.2R.
let blockerWS = null
E['WS'] = async () => {
  const intentos = []
  for (let i = 0; i < 3; i++) {
    const t = await negocio('WS', { wholesale: true }); const [a, b] = await productos(t, 2)
    const r = await carrera3({
      gateSql: holder(t.own, 'g', W.orderItem(t, b, 1), 2),
      firstSql: late(t.own, 'c', W.checkout(t, [{ p: a, q: 1 }, { p: b, q: 1 }], key('cows')), 0.4),
      secondSql: late(t.wcu, 's', W.wholesale(t, [{ p: b, q: 1 }, { p: a, q: 1 }]), 0.8),
    })
    const co = jsonDe(r.a.out, 'checkout')
    const ws = r.b.out.split('\n').find((l) => l.startsWith('wholesale|'))
    intentos.push({ dl: r.dl, checkout: co, wholesale: ws ? ws.slice(10, 120) : (r.b.err.split('\n')[0] || '').slice(0, 120), mon: r.mon })
    console.log(`   intento ${i + 1}: deadlocks +${r.dl} · checkout ${JSON.stringify(co)} · alta ${intentos.at(-1).wholesale}`)
    for (const m of r.mon) console.log(`      ${m}`)
    const req = await q(`SELECT coalesce(string_agg(status || ':' || coalesce(last_error_message,''), ','), '-') FROM public.comprobante_checkout_requests WHERE business_id = '${t.biz}';`)
    console.log(`      checkout_requests: ${req}`)
  }
  const reproducido = intentos.some((x) => x.dl > 0)
  blockerWS = reproducido ? intentos : null
  // Este caso NO es un PASS/FAIL del lote: el contrato dice que si se reproduce
  // se documenta como BLOCKER y se detiene el merge (sin tocar W1/W2/W3/G2-C.1).
  console.log(reproducido
    ? '   >>> G2-C.2R BLOCKER · inventory FK lock graph: REPRODUCIDO (checkout FOR UPDATE vs alta mayorista KEY SHARE)'
    : '   >>> checkout vs alta mayorista: NO se reprodujo deadlock en 3 intentos')
}

// ── Main ─────────────────────────────────────────────────────────────────────
const pedidos = process.argv[2] ? process.argv[2].split(',') : Object.keys(E)
const cont = await val(`SELECT current_setting('server_version') || ' · ' || current_database();`)
console.log(`G2-C.2 concurrencia · contenedor ${CT} · PostgreSQL ${cont}`)
const helper = await val(`SELECT to_regprocedure('private.lock_inventory_rows(uuid,uuid[])') IS NOT NULL;`)
// Sin la migracion la matriz solo corre en modo LINEA BASE (G2C2_BASELINE=1):
// mide el "antes" con el mismo harness; sus fallas son el bug, no un rojo de CI.
// WS no depende de G2-C.2 (checkout y alta mayorista no cambian).
const BASELINE = process.env.G2C2_BASELINE === '1'
if (helper !== 't' && !BASELINE && pedidos.some((k) => k !== 'WS')) {
  console.error('ABORTADO: falta private.lock_inventory_rows (la migracion G2-C.2 no esta aplicada). '
    + 'Para medir la linea base sobre main: G2C2_BASELINE=1.'); process.exit(2)
}
if (helper !== 't') console.log('AVISO: LINEA BASE · G2-C.2 NO aplicada: las fallas de abajo son el comportamiento previo.')

for (const k of pedidos) {
  if (!E[k]) { console.error(`escenario desconocido: ${k}`); process.exit(2) }
  console.log(`\n── escenario ${k} ──`)
  try { await E[k]() } catch (e) { fallas.push(`${k}: excepcion ${e.message.split('\n')[0]}`); console.log(`   FAIL  excepcion: ${e.message}`) }
}

console.log(`\n${asserts} aserciones · ${fallas.length} fallas`)
if (fallas.length) { fallas.forEach((f) => console.log('  · ' + f)); process.exit(1) }
if (pedidos.some((k) => k !== 'WS')) console.log('G2-C.2 concurrencia OK')
// El residual va con su propio codigo de salida: no es una falla de G2-C.2 (no
// toca checkout ni el alta mayorista), pero mientras se reproduzca el rollout
// queda detenido hasta revision humana.
if (blockerWS) {
  console.log('G2-C.2R BLOCKER · inventory FK lock graph REPRODUCIDO: rollout/merge detenido hasta revision humana.')
  process.exit(3)
}
