#!/usr/bin/env node
// SEC-08B Fase 3 â€” MEDICIÃ“N DEL LEAK DE BASELINE (no es un test de regresiÃ³n).
//
// Levanta actores reales contra el PostgREST local y prueba, con testigos Ãºnicos,
// quÃ© superficies entregan HOY el costo interno de inventario a un actor cuyo
// contrato dice que no debe verlo:
//
//     inventory = true
//     inventory_view_costs = false
//
// El rol `sales` es exactamente ese actor por defecto (ver
// private.capability_resolve). No se afirma que una columna filtre por existir:
// se exige que el testigo CRUCE LA RED.
//
// Salida: un inventario de rutas con veredicto LEAK / OK, para que la Fase 5
// diseÃ±e sobre hechos y no sobre suposiciones.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')
const dbContainer = process.env.SEC08B_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base local')

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
const sql = q => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], q).trim()

const ACTORS = ['owner', 'admin', 'manager', 'sales', 'cashier', 'tech', 'viewer', 'ownerB', 'wholesale']
const ids = Object.fromEntries(
  [...ACTORS, 'A', 'B', 'prodA', 'variantA', 'prodB', 'supplier', 'purchase', 'spurchase', 'move', 'customer', 'comp', 'order']
    .map(n => [n, randomUUID()]))

// â”€â”€ Testigos Ãºnicos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const COST_PARENT = 81011      // inventory.cost_price del producto padre
const COST_USD = 82022         // inventory.cost_price_usd
const COST_VARIANT = 83033     // inventory.cost_price de la VARIANTE (parent_id)
const SALE_PARENT = 84044      // inventory.sale_price â€” operativo, DEBE verse
const MOVE_COST = 85055        // inventory_movements.unit_cost
const PI_COST = 86066          // purchase_items.unit_cost
const SPI_COST = 87077         // supplier_purchase_items.unit_cost
const IVH_CAPITAL = 88088      // inventory_valuation_history.capital_invertido
const COST_PORTAL = 89099      // costo de un producto VISIBLE en el portal mayorista
const CI_COST = 90101          // comprobante_items.costo_unitario (venta POS, sin orden)
const OP_COST = 91111          // order_parts.internal_cost
const TAG = 'sec08b-http.invalid'

const results = []
let seeded = false

const main = async () => {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuraciÃ³n de PostgREST local (Â¿kong sin puerto publicado?)')
  const apiUrl = `http://127.0.0.1:${hostPort}/rest/v1`
  let signingKey = Buffer.from(vars.PGRST_JWT_SECRET)
  if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
    const k = JSON.parse(vars.PGRST_JWT_SECRET).keys.find(x => x.kty === 'oct')
    assert(k?.k, 'Falta la JWK HS256 local'); signingKey = Buffer.from(k.k, 'base64url')
  }
  const token = actor => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const claims = { role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 900 }
    if (actor) claims.sub = ids[actor]
    const c = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${h}.${c}.${createHmac('sha256', signingKey).update(`${h}.${c}`).digest('base64url')}`
  }
  const request = async (actor, path) => {
    const r = await fetch(apiUrl + path, {
      headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${token(actor)}` } : {}) },
      signal: AbortSignal.timeout(15000),
    })
    return { status: r.status, text: await r.text() }
  }

  // â”€â”€ Fixture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const users = ACTORS.map(n => `('${ids[n]}','${n}@${TAG}',now())`).join(',')
  // `wholesale` NO es un profile del negocio: es un cliente del portal mayorista.
  const staff = ACTORS.filter(n => n !== 'wholesale')
  const profiles = staff.map(n =>
    `('${ids[n]}','${n === 'ownerB' ? ids.B : ids.A}','${n === 'ownerB' ? 'owner' : n}',true,'${n}@${TAG}')`).join(',')

  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ${users};
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
      ('${ids.A}','B-A','${ids.owner}','pro','active'),
      ('${ids.B}','B-B','${ids.ownerB}','pro','active');
    INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES ${profiles};

    -- Cliente del portal mayorista del negocio A (authenticated, NO miembro).
    INSERT INTO public.wholesale_customers(id,business_id,auth_user_id,name,email,approved,suspended)
      VALUES (gen_random_uuid(),'${ids.A}','${ids.wholesale}','Mayorista','w@${TAG}',true,false);

    -- Producto padre + VARIANTE (parent_id) â€” la variante real de este esquema.
    INSERT INTO public.inventory(id,business_id,code,name,category,cost_price,cost_price_usd,sale_price,stock_quantity,is_active,has_variants,visible_in_wholesale,parent_id) VALUES
      ('${ids.prodA}','${ids.A}','SEC08B-P','Padre','cat',${COST_PARENT},${COST_USD},${SALE_PARENT},10,true,true,false,NULL),
      ('${ids.variantA}','${ids.A}','SEC08B-V','Variante','cat',${COST_VARIANT},0,${SALE_PARENT},5,true,false,false,'${ids.prodA}'),
      ('${ids.prodB}','${ids.A}','SEC08B-W','Portal','cat',${COST_PORTAL},0,${SALE_PARENT},7,true,false,true,NULL);

    INSERT INTO public.inventory_movements(id,business_id,inventory_item_id,movement_type,quantity,previous_stock,new_stock,unit_cost)
      VALUES ('${ids.move}','${ids.A}','${ids.prodA}','purchase',1,0,1,${MOVE_COST});

    INSERT INTO public.suppliers(id,business_id,name) VALUES ('${ids.supplier}','${ids.A}','Prov');
    INSERT INTO public.purchases(id,business_id,purchase_date) VALUES ('${ids.purchase}','${ids.A}',now());
    INSERT INTO public.purchase_items(id,business_id,purchase_id,inventory_item_id,description,quantity,unit_cost,subtotal)
      VALUES (gen_random_uuid(),'${ids.A}','${ids.purchase}','${ids.prodA}','linea',1,${PI_COST},${PI_COST});

    INSERT INTO public.supplier_purchases(id,business_id,supplier_id) VALUES ('${ids.spurchase}','${ids.A}','${ids.supplier}');
    INSERT INTO public.supplier_purchase_items(id,business_id,purchase_id,supplier_id,inventory_id,product_name,quantity,unit_cost,subtotal)
      VALUES (gen_random_uuid(),'${ids.A}','${ids.spurchase}','${ids.supplier}','${ids.prodA}','linea',1,${SPI_COST},${SPI_COST});

    INSERT INTO public.inventory_valuation_history(id,business_id,fecha,capital_invertido,valor_venta,ganancia_potencial,cantidad_total_items)
      VALUES (gen_random_uuid(),'${ids.A}',current_date,${IVH_CAPITAL},1,1,1);

    -- Pivots de reconstrucción: la MISMA verdad de costo por otras puertas.
    -- Comprobante SUELTO (no vinculado a orden): SEC-08A no lo alcanza.
    INSERT INTO public.customers(id,business_id,name,phone) VALUES ('${ids.customer}','${ids.A}','Cli','1');
    INSERT INTO public.comprobantes(id,business_id,customer_id,tipo,estado,subtotal,impuestos,total,total_bruto,total_cobrado,saldo_pendiente,currency,total_ars,total_usd,exchange_rate,tax,status,fecha)
      VALUES ('${ids.comp}','${ids.A}','${ids.customer}','factura_c','emitido',1,0,1,1,0,1,'ARS',1,0,1,0,'active',now());
    INSERT INTO public.comprobante_items(id,comprobante_id,business_id,inventory_id,descripcion,cantidad,precio_unitario,costo_unitario,costo_total)
      VALUES (gen_random_uuid(),'${ids.comp}','${ids.A}','${ids.prodA}','linea',1,${SALE_PARENT},${CI_COST},${CI_COST});

    INSERT INTO public.orders(id,business_id,customer_id,status) VALUES ('${ids.order}','${ids.A}','${ids.customer}','repair');
    INSERT INTO public.order_parts(id,order_id,business_id,name,part_number,internal_cost,sale_price,quantity)
      VALUES (gen_random_uuid(),'${ids.order}','${ids.A}','repuesto','SEC08B-PN',${OP_COST},${SALE_PARENT},1);
    COMMIT;
  `)
  seeded = true

  // â”€â”€ Rutas a medir â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // [etiqueta, path, testigos de COSTO que no deberÃ­an cruzar]
  const ROUTES = [
    ['inventory select=*', `/inventory?id=eq.${ids.prodA}&select=*`, [COST_PARENT, COST_USD]],
    ['inventory columna explÃ­cita', `/inventory?id=eq.${ids.prodA}&select=cost_price,cost_price_usd`, [COST_PARENT, COST_USD]],
    ['inventory enumerando', `/inventory?select=code,cost_price`, [COST_PARENT, COST_VARIANT, COST_PORTAL]],
    ['inventory VARIANTE (parent_id)', `/inventory?parent_id=eq.${ids.prodA}&select=*`, [COST_VARIANT]],
    ['inventory ORACLE por filtro', `/inventory?cost_price=eq.${COST_PARENT}&select=code`, ['SEC08B-P']],
    ['inventory ORDER BY costo', `/inventory?select=code&order=cost_price.desc&limit=3`, []],
    ['inventory_movements select=*', `/inventory_movements?id=eq.${ids.move}&select=*`, [MOVE_COST]],
    ['inventory_movements anidado a inventory', `/inventory_movements?id=eq.${ids.move}&select=quantity,inventory:inventory_item_id(cost_price)`, [COST_PARENT]],
    ['purchase_items select=*', `/purchase_items?select=*`, [PI_COST]],
    ['supplier_purchase_items select=*', `/supplier_purchase_items?select=*`, [SPI_COST]],
    ['inventory_valuation_history select=*', `/inventory_valuation_history?select=*`, [IVH_CAPITAL]],
    ['v_finance_product_margin', `/v_finance_product_margin?select=*&limit=5`, []],
    ['v_finance_inventory_capital', `/v_finance_inventory_capital?select=*`, []],
    ['v_finance_inventory_flows', `/v_finance_inventory_flows?select=*&limit=5`, []],
    ['v_finance_position', `/v_finance_position?select=*`, []],
    // ── Fase 4 · reconstrucción exacta ───────────────────────────────────────
    ['RECON purchase_items subtotal/qty', `/purchase_items?select=quantity,subtotal`, [PI_COST]],
    ['RECON supplier_purchase_items subtotal/qty', `/supplier_purchase_items?select=quantity,subtotal`, [SPI_COST]],
    ['RECON comprobante_items costo_unitario (venta POS)', `/comprobante_items?select=inventory_id,cantidad,costo_unitario,costo_total`, [CI_COST]],
    ['RECON order_parts internal_cost', `/order_parts?select=name,part_number,internal_cost,margin_amount,margin_percentage`, [OP_COST]],
    ['RECON v_finance_sales_ledger', `/v_finance_sales_ledger?select=inventory_id,quantity,cogs_amount_ars`, [CI_COST]],
  ]

  const PROBE_ACTORS = ['sales', 'admin', 'owner', 'tech', 'viewer', 'cashier', 'ownerB']

  console.log('\n=== SEC-08B Â· BASELINE (main 2020a8d) â€” costo de inventario ===\n')
  console.log('Actor de contrato: `sales` â†’ inventory=true, inventory_view_costs=false\n')

  for (const [label, path, needles] of ROUTES) {
    const res = await request('sales', path)
    const crossed = needles.filter(n => String(res.text ?? '').includes(String(n)))
    const verdict = crossed.length ? 'LEAK' : (res.status === 200 && res.text !== '[]' ? 'OK-200' : `sin datos (${res.status})`)
    results.push({ label, path, status: res.status, verdict, crossed })
    console.log(`[${verdict.padEnd(14)}] sales Â· ${label}`)
    console.log(`                 ${res.status} ${res.text.slice(0, 190)}`)
    if (crossed.length) console.log(`                 >>> testigos que CRUZARON: ${crossed.join(', ')}`)
  }

  // Cliente del portal mayorista sobre el producto visible en portal.
  const w = await request('wholesale', `/inventory?visible_in_wholesale=eq.true&select=code,sale_price,cost_price`)
  const wCrossed = String(w.text).includes(String(COST_PORTAL))
  results.push({ label: 'PORTAL mayorista lee cost_price', path: 'wholesale', status: w.status, verdict: wCrossed ? 'LEAK' : 'OK', crossed: wCrossed ? [COST_PORTAL] : [] })
  console.log(`\n[${(wCrossed ? 'LEAK' : 'OK').padEnd(14)}] cliente MAYORISTA Â· inventory.cost_price de producto de portal`)
  console.log(`                 ${w.status} ${w.text.slice(0, 250)}`)

  // Matriz por actor sobre la ruta mÃ¡s directa.
  console.log('\n--- Matriz por actor Â· /inventory?select=cost_price ---')
  for (const a of PROBE_ACTORS) {
    const r = await request(a, `/inventory?id=eq.${ids.prodA}&select=cost_price`)
    console.log(`  ${a.padEnd(9)} ${String(r.status).padEnd(4)} ${r.text.slice(0, 120)}`)
  }
  const anon = await request(null, `/inventory?id=eq.${ids.prodA}&select=cost_price`)
  console.log(`  ${'anon'.padEnd(9)} ${String(anon.status).padEnd(4)} ${anon.text.slice(0, 120)}`)

  const leaks = results.filter(r => r.verdict === 'LEAK')
  console.log(`\n=== ${leaks.length} rutas con testigo de costo cruzado ===`)
  for (const l of leaks) console.log(`  Â· ${l.label} â€” ${l.crossed.join(', ')}`)
}

const cleanup = () => {
  if (!seeded) return
  try {
    sql(`
      BEGIN;
      SET session_replication_role=replica;
      DELETE FROM public.order_parts WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.orders WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.comprobante_items WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.comprobantes WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.customers WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.inventory_valuation_history WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_purchase_items WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_purchases WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.purchase_items WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.purchases WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.inventory_movements WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.inventory WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.suppliers WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.wholesale_customers WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.profiles WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.businesses WHERE id IN ('${ids.A}','${ids.B}');
      DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
      COMMIT;
    `)
  } catch (e) { console.error('cleanup:', e.message) }
}

main().then(() => { cleanup(); process.exit(0) })
  .catch(e => { cleanup(); console.error('\nFALLÃ“:', e.message); process.exit(1) })


