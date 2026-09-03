#!/usr/bin/env node
// SEC-08B Fase B — PRESERVACIÓN DEL COSTO y CONTENCIÓN DEL COGS CRUDO.
//
// La revisión independiente reprodujo, de punta a punta, que editar un campo
// cualquiera de un producto dejaba el costo real en 0:
//
//     51101.00  →  el usuario edita el nombre  →  HTTP 200  →  0.00
//
// para owner, admin y sales. Esta suite fija el contrato que lo cierra, y lo
// hace por HTTP con actores reales, porque el defecto vivía justamente en el
// viaje de ida y vuelta entre navegador y base.
//
// Dos mecanismos, y hacen falta LOS DOS:
//   · el trigger server-side protege al actor SIN autoridad (no puede
//     distinguir «campo ausente» de «cero a propósito», así que conserva);
//   · el frontend protege al actor CON autoridad (él sí manda el valor, así
//     que tiene que mandar el REAL, no el 0 de un formulario que nunca lo
//     recibió).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')
const dbContainer = process.env.SEC08B_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base local')

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
const sql = q => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], q).trim()

const ACTORS = ['owner', 'admin', 'manager', 'sales', 'cashier', 'tech', 'viewer', 'inactive', 'ownerB']
const ids = Object.fromEntries([...ACTORS, 'A', 'B', 'prod', 'variant', 'prod2', 'customer', 'comp', 'compOrder', 'order', 'itemFree', 'itemOrder']
  .map(n => [n, randomUUID()]))

// ── Testigos únicos ──────────────────────────────────────────────────────────
const COST = 51101          // costo real del producto padre
const COST_USD = 5210       // costo real en USD
const COST_VARIANT = 53303  // costo real de la variante
const COST_P2 = 54404       // costo real de un segundo producto (round-trip Excel)
const SALE = 64044
const NEW_COST = 51234      // cambio legítimo de un autorizado
const CI_COST = 60110       // costo de línea de venta suelta
const CI_COST_ORDER = 61220 // costo de línea de comprobante vinculado a orden
const TAG = 'sec08b-preserve.invalid'

let seeded = false, checks = 0

const cost = id => sql(`SELECT COALESCE(cost_price::text,'NULL') FROM public.inventory WHERE id='${id}';`)
const costUsd = id => sql(`SELECT COALESCE(cost_price_usd::text,'NULL') FROM public.inventory WHERE id='${id}';`)
const resetCosts = () => sql(`
  UPDATE public.inventory SET cost_price=${COST},        cost_price_usd=${COST_USD} WHERE id='${ids.prod}';
  UPDATE public.inventory SET cost_price=${COST_VARIANT},cost_price_usd=0           WHERE id='${ids.variant}';
  UPDATE public.inventory SET cost_price=${COST_P2},     cost_price_usd=0           WHERE id='${ids.prod2}';`)

const main = async () => {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuración de PostgREST local (¿kong sin puerto publicado?)')

  assert(sql(`SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
               JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relname='inventory'
                AND t.tgname='trig_inventory_guard_cost_write' AND NOT t.tgisinternal;`) === '1',
    'La Fase B no está aplicada en la base local (falta trig_inventory_guard_cost_write)')

  const api = `http://127.0.0.1:${hostPort}/rest/v1`
  let key = Buffer.from(vars.PGRST_JWT_SECRET)
  if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
    const k = JSON.parse(vars.PGRST_JWT_SECRET).keys.find(x => x.kty === 'oct')
    key = Buffer.from(k.k, 'base64url')
  }
  const token = sub => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const claims = { role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1e3) + 1800 }
    if (sub) claims.sub = sub
    const c = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${h}.${c}.${createHmac('sha256', key).update(`${h}.${c}`).digest('base64url')}`
  }
  const call = async (method, sub, path, body) => {
    const r = await fetch(api + path, {
      method,
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation', ...(sub ? { Authorization: `Bearer ${token(sub)}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    })
    return { status: r.status, text: await r.text() }
  }
  const get = (sub, p) => call('GET', sub, p)
  const patch = (sub, p, b) => call('PATCH', sub, p, b)
  const post = (sub, p, b) => call('POST', sub, p, b)
  const expect = (cond, label) => { checks++; assert(cond, label) }
  const setPerm = (who, json) => sql(`UPDATE public.profiles SET permissions=${json} WHERE id='${ids[who]}';`)

  // Columnas operativas: exactamente las que el frontend pide desde la Fase A.
  const OPS = 'id,code,name,category,description,stock,min_stock,sale_price,supplier_id,created_at,updated_at,stock_quantity,reserved_quantity,is_active,subcategory,max_stock,supplier_code,location,created_by,business_id,price_usd,currency,base_currency,base_price,exchange_rate_used,auto_update_price,linked_to_dolar,tipo,precio_mayorista,mayorista_enabled,variant_name,has_variants,visible_in_wholesale,brand,model,barcode,wholesale_price_ars,wholesale_price_usd,parent_id'

  // ── Fixture ────────────────────────────────────────────────────────────────
  const users = ACTORS.map(n => `('${ids[n]}','${n}@${TAG}',now())`).join(',')
  const profiles = ACTORS.map(n =>
    `('${ids[n]}','${n === 'ownerB' ? ids.B : ids.A}','${n === 'ownerB' ? 'owner' : n === 'inactive' ? 'admin' : n}',${n === 'inactive' ? 'false' : 'true'},'${n}@${TAG}')`).join(',')
  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ${users};
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
      ('${ids.A}','PRES-A','${ids.owner}','pro','active'),
      ('${ids.B}','PRES-B','${ids.ownerB}','pro','active');
    INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES ${profiles};
    INSERT INTO public.inventory(id,business_id,code,name,category,cost_price,cost_price_usd,sale_price,stock_quantity,is_active,has_variants,parent_id) VALUES
      ('${ids.prod}','${ids.A}','PRES-P','Padre','cat',${COST},${COST_USD},${SALE},10,true,true,NULL),
      ('${ids.variant}','${ids.A}','PRES-V','Variante','cat',${COST_VARIANT},0,${SALE},4,true,false,'${ids.prod}'),
      ('${ids.prod2}','${ids.A}','PRES-Q','Otro','cat',${COST_P2},0,${SALE},6,true,false,NULL);
    INSERT INTO public.customers(id,business_id,name,phone) VALUES ('${ids.customer}','${ids.A}','Cli','1');
    INSERT INTO public.orders(id,business_id,customer_id,status) VALUES ('${ids.order}','${ids.A}','${ids.customer}','repair');
    INSERT INTO public.comprobantes(id,business_id,order_id,customer_id,tipo,estado,subtotal,impuestos,total,total_bruto,total_cobrado,saldo_pendiente,currency,total_ars,total_usd,exchange_rate,tax,status,fecha) VALUES
      ('${ids.comp}','${ids.A}',NULL,'${ids.customer}','factura_c','emitido',${SALE},0,${SALE},${SALE},0,${SALE},'ARS',${SALE},0,1,0,'issued',now()),
      ('${ids.compOrder}','${ids.A}','${ids.order}','${ids.customer}','factura_c','emitido',${SALE},0,${SALE},${SALE},0,${SALE},'ARS',${SALE},0,1,0,'issued',now());
    INSERT INTO public.comprobante_items(id,comprobante_id,business_id,inventory_id,descripcion,cantidad,precio_unitario,subtotal,costo_unitario,costo_total,tipo_linea) VALUES
      ('${ids.itemFree}','${ids.comp}','${ids.A}','${ids.prod}','libre',1,${SALE},${SALE},${CI_COST},${CI_COST},'producto'),
      ('${ids.itemOrder}','${ids.compOrder}','${ids.A}','${ids.prod}','orden',1,${SALE},${SALE},${CI_COST_ORDER},${CI_COST_ORDER},'producto');
    COMMIT;
  `)
  seeded = true
  sql(`NOTIFY pgrst, 'reload schema';`)
  await new Promise(r => setTimeout(r, 1200))

  // ═══ 1. El contrato NUEVO del frontend preserva el costo ══════════════════
  // Reproduce el flujo real: leer con columnas operativas, pedir el costo por
  // la vista autorizada, y recién ahí decidir si se manda.
  console.log('\n--- 1. Editar un campo NO relacionado conserva el costo ---')
  for (const who of ['owner', 'admin', 'manager', 'sales']) {
    resetCosts()
    const opsRes = await get(ids[who], `/inventory?id=eq.${ids.prod}&select=${OPS}`)
    const item = JSON.parse(opsRes.text)[0]
    expect(item !== undefined, `${who}: la lectura operativa del producto tiene que funcionar`)
    expect(item.cost_price === undefined, `${who}: la lectura operativa NO puede traer cost_price`)

    // El modal pide el costo autorizado.
    const costRes = await get(ids[who], `/v_inventory_costs?inventory_id=eq.${ids.prod}&select=cost_price,cost_price_usd`)
    const authorized = costRes.status === 200 && JSON.parse(costRes.text).length > 0
    const loaded = authorized ? JSON.parse(costRes.text)[0] : null

    // Y sólo manda costo si lo conoce.
    const payload = { name: `Editado por ${who}` }
    if (authorized) { payload.cost_price = Number(loaded.cost_price); payload.cost_price_usd = Number(loaded.cost_price_usd) }

    const r = await patch(ids[who], `/inventory?id=eq.${ids.prod}&select=id,name`, payload)
    expect(r.status === 200, `${who}: la edición operativa tiene que seguir funcionando — ${r.status} ${r.text.slice(0, 120)}`)
    expect(cost(ids.prod) === `${COST}.00`,
      `${who}: el costo se destruyó — quedó ${cost(ids.prod)} en vez de ${COST}.00`)
    expect(costUsd(ids.prod) === `${COST_USD}.00`,
      `${who}: el costo USD se destruyó — quedó ${costUsd(ids.prod)}`)
    console.log(`  ✓ ${who.padEnd(8)} autoridad=${String(authorized).padEnd(5)} costo tras editar: ${cost(ids.prod)}`)
  }

  // ═══ 2. El respaldo server-side: aunque el cliente mande 0 ════════════════
  console.log('\n--- 2. Un actor SIN autoridad no puede reemplazar el costo ni mandándolo ---')
  for (const who of ['sales', 'cashier', 'tech', 'viewer']) {
    resetCosts()
    const r = await patch(ids[who], `/inventory?id=eq.${ids.prod}&select=id`, { cost_price: 0, cost_price_usd: 0 })
    expect(cost(ids.prod) === `${COST}.00`,
      `${who}: mandando cost_price=0 destruyó el costo (quedó ${cost(ids.prod)}) — ${r.status}`)
    console.log(`  ✓ ${who.padEnd(8)} intentó cost_price=0 → base conserva ${cost(ids.prod)}`)
  }
  // …y tampoco puede subirlo a un valor inventado.
  resetCosts()
  await patch(ids.sales, `/inventory?id=eq.${ids.prod}&select=id`, { cost_price: 999999 })
  expect(cost(ids.prod) === `${COST}.00`, `sales pudo INVENTAR un costo: ${cost(ids.prod)}`)
  console.log(`  ✓ sales    intentó cost_price=999999 → base conserva ${cost(ids.prod)}`)

  // ═══ 3. El autorizado SÍ cambia el costo, y el 0 explícito es real ════════
  console.log('\n--- 3. Cambio legítimo por un actor autorizado ---')
  resetCosts()
  const up = await patch(ids.admin, `/inventory?id=eq.${ids.prod}&select=id`, { cost_price: NEW_COST })
  expect(up.status === 200 && cost(ids.prod) === `${NEW_COST}.00`,
    `admin no pudo cambiar el costo: ${cost(ids.prod)}`)
  console.log(`  ✓ admin ${COST} → ${cost(ids.prod)}`)
  await patch(ids.admin, `/inventory?id=eq.${ids.prod}&select=id`, { cost_price: 0 })
  expect(cost(ids.prod) === '0.00', `el 0 EXPLÍCITO de un autorizado no se respetó: ${cost(ids.prod)}`)
  console.log(`  ✓ admin puede poner 0 a propósito → ${cost(ids.prod)} (distinto de «campo ausente»)`)
  // Y un override a false se lo quita.
  resetCosts()
  setPerm('admin', `'{"inventory_view_costs": false}'::jsonb`)
  await patch(ids.admin, `/inventory?id=eq.${ids.prod}&select=id`, { cost_price: 0 })
  expect(cost(ids.prod) === `${COST}.00`,
    `admin con override false pudo destruir el costo: ${cost(ids.prod)}`)
  console.log(`  ✓ admin + override false → base conserva ${cost(ids.prod)}`)
  setPerm('admin', 'NULL')

  // ═══ 4. Round-trip de Excel ══════════════════════════════════════════════
  console.log('\n--- 4. Round-trip exportar → importar sin cambios ---')
  for (const who of ['owner', 'sales']) {
    resetCosts()
    const rows = JSON.parse((await get(ids[who], `/inventory?business_id=eq.${ids.A}&select=${OPS}&order=code`)).text)
    const costRes = await get(ids[who], `/v_inventory_costs?select=inventory_id,cost_price,cost_price_usd`)
    const authorized = costRes.status === 200 && JSON.parse(costRes.text).length > 0
    const costMap = new Map((authorized ? JSON.parse(costRes.text) : []).map(c => [c.inventory_id, c]))

    // EXPORT tal como lo arma la app.
    const exported = rows.map(it => ({
      'Código/SKU': it.code, 'Nombre del producto': it.name, 'Stock actual': it.stock_quantity,
      ...(authorized ? {
        'Precio de costo (ARS)': costMap.get(it.id)?.cost_price ?? 0,
        'Precio de costo (USD)': costMap.get(it.id)?.cost_price_usd ?? 0,
      } : {}),
      'Precio de venta (ARS)': it.sale_price,
    }))
    expect(authorized || exported.every(r => !('Precio de costo (ARS)' in r)),
      `${who}: sin autoridad el export NO puede incluir columnas de costo`)

    // IMPORT sin tocar nada: celda ausente o vacía = «no modificar».
    for (const row of exported) {
      const raw = row['Precio de costo (ARS)']
      const has = raw !== undefined && raw !== null && String(raw).trim() !== ''
      const target = rows.find(r => r.code === row['Código/SKU'])
      await patch(ids[who], `/inventory?id=eq.${target.id}&select=id`, {
        name: row['Nombre del producto'],
        stock_quantity: row['Stock actual'],
        ...(has ? { cost_price: Number(raw) } : {}),
      })
    }
    expect(cost(ids.prod) === `${COST}.00`, `${who}: el round-trip destruyó el costo del padre (${cost(ids.prod)})`)
    expect(cost(ids.prod2) === `${COST_P2}.00`, `${who}: el round-trip destruyó el costo del 2º producto (${cost(ids.prod2)})`)
    expect(cost(ids.variant) === `${COST_VARIANT}.00`, `${who}: el round-trip destruyó el costo de la variante (${cost(ids.variant)})`)
    console.log(`  ✓ ${who.padEnd(6)} export(${authorized ? 'con' : 'sin'} costo) → import → costos ${cost(ids.prod)} / ${cost(ids.prod2)} / ${cost(ids.variant)}`)
  }

  // ═══ 5. Variante creada por quien no ve el costo ═════════════════════════
  console.log('\n--- 5. Variante nueva desde el padre ---')
  resetCosts()
  const vId = randomUUID()
  const vr = await post(ids.sales, `/inventory?select=id,code`, {
    id: vId, business_id: ids.A, code: `PRES-V2-${vId.slice(0, 6)}`, name: 'Variante nueva',
    category: 'cat', cost_price: 0, cost_price_usd: 0, sale_price: SALE,
    stock_quantity: 1, is_active: true, parent_id: ids.prod,
  })
  expect(vr.status === 201, `sales no pudo crear la variante: ${vr.status} ${vr.text.slice(0, 140)}`)
  expect(cost(vId) === `${COST}.00`,
    `la variante NO heredó el costo del padre: quedó ${cost(vId)} en vez de ${COST}.00`)
  const seen = await get(ids.sales, `/v_inventory_costs?inventory_id=eq.${vId}&select=cost_price`)
  expect(seen.text.trim() === '[]', `sales pudo VER el costo heredado de la variante: ${seen.text}`)
  console.log(`  ✓ sales creó la variante → heredó ${cost(vId)} server-side, y sigue sin poder verlo`)
  sql(`DELETE FROM public.inventory WHERE id='${vId}';`)

  // ═══ 6. Contención del COGS crudo ════════════════════════════════════════
  console.log('\n--- 6. El costo CRUDO de línea vuelve a inventory_view_costs ---')
  const RAW_ROUTES = [
    ['enumeración', `/v_comprobante_item_costs?select=inventory_id,costo_unitario,costo_total`],
    ['por inventory_id', `/v_comprobante_item_costs?inventory_id=eq.${ids.prod}&select=costo_unitario`],
    ['por item', `/v_comprobante_item_costs?comprobante_item_id=eq.${ids.itemFree}&select=costo_unitario`],
    ['filtro por costo', `/v_comprobante_item_costs?costo_unitario=eq.${CI_COST}&select=comprobante_item_id`],
    ['order by costo', `/v_comprobante_item_costs?select=inventory_id&order=costo_unitario.desc`],
    ['ledger por producto', `/v_finance_sales_ledger?inventory_id=eq.${ids.prod}&select=cogs_amount_ars`],
    ['ledger por línea', `/v_finance_sales_ledger?comprobante_item_id=eq.${ids.itemFree}&select=cogs_amount_ars`],
  ]
  const DENIED = [
    ['cashier', 'NULL'],
    ['sales', 'NULL'],
    ['tech', 'NULL'],
    ['viewer', 'NULL'],
    ['cashier', `'{"inventory_view_costs": false}'::jsonb`],
    ['admin', `'{"inventory_view_costs": false}'::jsonb`],
    ['sales', `'{"finance": true}'::jsonb`],
  ]
  for (const [who, perm] of DENIED) {
    setPerm(who, perm)
    for (const [label, path] of RAW_ROUTES) {
      const r = await get(ids[who], path)
      for (const w of [CI_COST, CI_COST_ORDER]) {
        expect(!r.text.includes(String(w)),
          `${who} (${perm === 'NULL' ? 'default' : perm}) · ${label}: el costo ${w} cruzó — ${r.status} ${r.text.slice(0, 200)}`)
      }
    }
    setPerm(who, 'NULL')
    console.log(`  ✓ ${who.padEnd(8)} ${perm === 'NULL' ? 'por defecto' : 'con override'} — ninguna ruta cruda entrega costo`)
  }
  // Positivo: quien SÍ tiene la capacidad lo sigue recibiendo.
  for (const who of ['owner', 'admin', 'manager']) {
    const r = await get(ids[who], `/v_comprobante_item_costs?comprobante_item_id=eq.${ids.itemFree}&select=costo_unitario`)
    expect(r.text.includes(String(CI_COST)), `${who}: perdió el costo de línea autorizado — ${r.status} ${r.text.slice(0, 140)}`)
  }
  console.log(`  ✓ owner/admin/manager conservan el costo crudo de línea`)

  // ═══ 7. El P&L de `finance` sigue exacto, sin costo crudo ════════════════
  console.log('\n--- 7. Agregados de finanzas para `finance` sin inventory_view_costs ---')
  const pnlOwner = JSON.parse((await get(ids.owner, `/v_finance_pnl?business_id=eq.${ids.A}&select=period_date,net_sales,cogs,gross_profit`)).text)
  const pnlCash = JSON.parse((await get(ids.cashier, `/v_finance_pnl?business_id=eq.${ids.A}&select=period_date,net_sales,cogs,gross_profit`)).text)
  expect(pnlCash.length > 0, 'cashier perdió el P&L por completo')
  expect(JSON.stringify(pnlOwner) === JSON.stringify(pnlCash),
    `el P&L del cashier NO coincide con el del owner:\n  owner=${JSON.stringify(pnlOwner)}\n  cashier=${JSON.stringify(pnlCash)}`)
  const row = pnlCash[0]
  expect(Number(row.cogs) > 0, `el COGS agregado del cashier tiene que ser real, llegó ${row.cogs}`)
  expect(Number(row.gross_profit) !== Number(row.net_sales),
    'gross_profit = net_sales: el COGS quedó anulado para el cashier')
  console.log(`  ✓ cashier P&L idéntico al del owner — cogs=${row.cogs} gross_profit=${row.gross_profit}`)

  // El agregado no puede estrecharse a un producto ni a una línea.
  for (const p of ['inventory_id', 'comprobante_id', 'comprobante_item_id']) {
    const r = await get(ids.cashier, `/v_finance_period_cogs?${p}=eq.${ids.prod}&select=cogs_amount_ars`)
    expect(r.status >= 400, `v_finance_period_cogs aceptó filtrar por ${p} — ${r.status} ${r.text.slice(0, 120)}`)
  }
  console.log(`  ✓ v_finance_period_cogs no admite filtro por producto, comprobante ni línea`)
  expect((await get(null, `/v_finance_period_cogs?select=*`)).status >= 400, 'anon alcanza v_finance_period_cogs')
  expect((await get(ids.ownerB, `/v_finance_period_cogs?select=*`)).text.trim() === '[]', 'tenant ajeno alcanza el agregado')
  console.log(`  ✓ anon y tenant ajeno denegados en el agregado`)

  // ═══ 8. SEC-08A sigue cerrado en la ruta de costo ════════════════════════
  setPerm('manager', `'{"orders_view_financials": false}'::jsonb`)
  const ord = await get(ids.manager, `/v_comprobante_item_costs?comprobante_item_id=eq.${ids.itemOrder}&select=costo_unitario`)
  expect(!ord.text.includes(String(CI_COST_ORDER)),
    `SEC-08A reabierto: sin orders_view_financials llegó el costo de la línea de orden — ${ord.text.slice(0, 160)}`)
  setPerm('manager', 'NULL')
  console.log(`\n  ✓ SEC-08A intacto: sin orders_view_financials no hay costo de línea de orden`)

  // ═══ 9. CONTROLES NEGATIVOS ══════════════════════════════════════════════
  console.log('\n--- Controles negativos ---')
  resetCosts()
  // 9.a Reabrir la destrucción: quitar el trigger.
  sql(`ALTER TABLE public.inventory DISABLE TRIGGER trig_inventory_guard_cost_write;`)
  await patch(ids.sales, `/inventory?id=eq.${ids.prod}&select=id`, { cost_price: 0 })
  expect(cost(ids.prod) === '0.00',
    `CONTROL NEGATIVO INÚTIL: sin el trigger, el costo NO se destruyó (${cost(ids.prod)}) — la aserción no prueba nada`)
  console.log(`  ✓ sin el trigger: ${COST} → ${cost(ids.prod)} (la destrucción es real)`)
  sql(`ALTER TABLE public.inventory ENABLE TRIGGER trig_inventory_guard_cost_write;`)
  resetCosts()
  await patch(ids.sales, `/inventory?id=eq.${ids.prod}&select=id`, { cost_price: 0 })
  expect(cost(ids.prod) === `${COST}.00`, `tras restaurar el trigger el costo sigue destruyéndose: ${cost(ids.prod)}`)
  console.log(`  ✓ con el trigger: base conserva ${cost(ids.prod)}`)

  // 9.b Reabrir el COGS crudo: volver al gate `finance OR inventory_view_costs`.
  const CANDIDATE_VIEW = sql(`SELECT pg_get_viewdef('public.v_comprobante_item_costs'::regclass, true);`)
  sql(`CREATE OR REPLACE VIEW public.v_comprobante_item_costs AS
       SELECT ci.id AS comprobante_item_id, ci.comprobante_id, ci.business_id, ci.inventory_id,
              ci.cantidad, ci.costo_unitario, ci.costo_total
         FROM public.comprobante_items ci
        WHERE ci.business_id = public.current_user_business_id()
          AND ( NOT public.comprobante_is_order_linked(ci.comprobante_id)
                OR public.current_user_can_in_business(ci.business_id, 'orders_view_financials') )
          AND public.can_view_cogs(ci.business_id);`)
  sql(`NOTIFY pgrst, 'reload schema';`); await new Promise(r => setTimeout(r, 1100))
  const leak = await get(ids.cashier, `/v_comprobante_item_costs?select=inventory_id,costo_unitario`)
  expect(leak.text.includes(String(CI_COST)),
    `CONTROL NEGATIVO INÚTIL: con el gate de finance el cashier NO recibió el costo — ${leak.status} ${leak.text.slice(0, 200)}`)
  console.log(`  ✓ con gate 'finance': el cashier recibe ${CI_COST} (el bypass es real)`)
  sql(`CREATE OR REPLACE VIEW public.v_comprobante_item_costs AS ${CANDIDATE_VIEW.replace(/;\s*$/, '')};`)
  sql(`NOTIFY pgrst, 'reload schema';`); await new Promise(r => setTimeout(r, 1100))
  const closed = await get(ids.cashier, `/v_comprobante_item_costs?select=inventory_id,costo_unitario`)
  expect(!closed.text.includes(String(CI_COST)), `tras restaurar, el cashier SIGUE recibiendo el costo: ${closed.text.slice(0, 160)}`)
  console.log(`  ✓ restaurado: el cashier ya no lo recibe`)

  resetCosts()
  console.log(`\nSEC-08B Fase B OK — ${checks} aserciones`)
}

const cleanup = () => {
  if (!seeded) return
  try {
    sql(`ALTER TABLE public.inventory ENABLE TRIGGER trig_inventory_guard_cost_write;`)
  } catch { /* ya estaba */ }
  try {
    sql(`
      BEGIN;
      SET session_replication_role=replica;
      DELETE FROM public.comprobante_items WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.comprobantes WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.orders WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.customers WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.inventory WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.profiles WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.businesses WHERE id IN ('${ids.A}','${ids.B}');
      DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
      COMMIT;
    `)
  } catch (e) { console.error('cleanup:', String(e.message).slice(0, 200)) }
}

main().then(() => { cleanup(); process.exit(0) })
  .catch(e => { cleanup(); console.error('\nSEC-08B Fase B FALLÓ:', e.message); process.exit(1) })
