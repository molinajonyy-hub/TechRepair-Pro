#!/usr/bin/env node
// SEC-08B — contrato de VISIBILIDAD DEL COSTO DE INVENTARIO, medido por HTTP.
//
// Se prueba contra el PostgREST local con JWT reales, porque el único enunciado
// que vale es «el testigo cruzó la red» o «no cruzó». Un test que sólo mira
// denegaciones da por bueno un 42501 que en realidad es una pantalla rota, así
// que cada superficie cerrada tiene al lado su POSITIVO: el actor autorizado
// tiene que seguir recibiendo el número real.
//
// Cubre: producto, variante (`parent_id`), movimientos, compras, compras a
// proveedor, historial de valuación, vistas de finanzas, los dos ORÁCULOS
// (`?cost=eq.` y `?order=cost.desc`), el portal mayorista, la regresión de POS,
// la de SEC-08A, la matriz de overrides y tenants, y CONTROLES NEGATIVOS que
// reabren cada frontera a propósito para demostrar que el test la vería caer.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')
const dbContainer = process.env.SEC08B_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base local')
const MIGRATION = 'supabase/migrations/20260914120000_sec08b_inventory_cost_visibility.sql'

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
const sql = q => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], q).trim()

const ACTORS = ['owner', 'admin', 'manager', 'sales', 'cashier', 'tech', 'viewer', 'inactive', 'ownerB', 'wholesale']
const ids = Object.fromEntries(
  [...ACTORS, 'A', 'B', 'prodA', 'variantA', 'portalA', 'prodB', 'supplier', 'purchase', 'spurchase',
    'move', 'customer', 'comp', 'compOrder', 'order', 'itemFree', 'itemOrder']
    .map(n => [n, randomUUID()]))

// ── Testigos únicos ──────────────────────────────────────────────────────────
const COST_PARENT = 81011
const COST_USD = 82022
const COST_VARIANT = 83033
const SALE_PARENT = 84044     // operativo: DEBE llegar
const STOCK_PARENT = 17       // operativo: DEBE llegar
const MOVE_COST = 85055
const PI_COST = 86066
const SPI_COST = 87077
const IVH_CAPITAL = 88088
const COST_PORTAL = 89099
const CI_COST_FREE = 90101    // costo de línea en venta de mostrador
const CI_COST_ORDER = 92121   // costo de línea en comprobante VINCULADO A ORDEN
const COST_TENANT_B = 93131   // costo del tenant AJENO: testigo propio, o un
                              // acierto legítimo en B se confunde con un cruce
const TAG = 'sec08b-http.invalid'

let seeded = false, requests = 0, checks = 0

const main = async () => {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuración de PostgREST local (¿kong sin puerto publicado?)')

  // La migración tiene que estar aplicada: si no, todo «pasaría» por accidente.
  const applied = sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname IN ('can_view_inventory_cost','can_view_cogs');`)
  assert(applied === '2', `SEC-08B no está aplicada en la base local (aplicá ${MIGRATION})`)

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
    requests++
    const r = await fetch(apiUrl + path, {
      headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${token(actor)}` } : {}) },
      signal: AbortSignal.timeout(15000),
    })
    return { status: r.status, text: await r.text() }
  }
  const denyValue = (res, needles, label) => {
    checks++
    for (const n of [].concat(needles)) {
      assert(!String(res.text ?? '').includes(String(n)),
        `${label}: el valor '${n}' cruzó la red — ${res.status} ${res.text?.slice(0, 300)}`)
    }
  }
  const expectValue = (res, needle, label) => {
    checks++
    assert(String(res.text ?? '').includes(String(needle)),
      `${label}: se esperaba '${needle}' y no llegó — ${res.status} ${res.text?.slice(0, 300)}`)
  }
  const expectOk = (res, label) => {
    checks++
    assert(res.status === 200, `${label}: se esperaba 200 y hubo ${res.status} — ${res.text?.slice(0, 300)}`)
  }
  const expectEmpty = (res, label) => {
    checks++
    assert(res.status === 200 && res.text.trim() === '[]',
      `${label}: se esperaba 200 [] y hubo ${res.status} ${res.text?.slice(0, 200)}`)
  }
  const expect = (cond, label) => { checks++; assert(cond, label) }
  const setPerm = (who, json) => sql(`UPDATE public.profiles SET permissions=${json} WHERE id='${ids[who]}';`)

  // ── Fixture ────────────────────────────────────────────────────────────────
  const users = ACTORS.map(n => `('${ids[n]}','${n}@${TAG}',now())`).join(',')
  const staff = ACTORS.filter(n => n !== 'wholesale')
  const profiles = staff.map(n =>
    `('${ids[n]}','${n === 'ownerB' ? ids.B : ids.A}','${n === 'ownerB' ? 'owner' : n === 'inactive' ? 'admin' : n}',${n === 'inactive' ? 'false' : 'true'},'${n}@${TAG}')`).join(',')

  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ${users};
    -- El dueño registrado es 'owner'; ningún otro rol lo es, o la rama de dueño
    -- de current_user_can_in_business le daría todo y el test mentiría.
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
      ('${ids.A}','B-A','${ids.owner}','pro','active'),
      ('${ids.B}','B-B','${ids.ownerB}','pro','active');
    INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES ${profiles};
    INSERT INTO public.wholesale_customers(id,business_id,auth_user_id,name,email,approved,suspended)
      VALUES (gen_random_uuid(),'${ids.A}','${ids.wholesale}','Mayorista','w@${TAG}',true,false);

    INSERT INTO public.inventory(id,business_id,code,name,category,cost_price,cost_price_usd,sale_price,stock_quantity,is_active,has_variants,visible_in_wholesale,parent_id) VALUES
      ('${ids.prodA}','${ids.A}','SEC08B-P','Padre','cat',${COST_PARENT},${COST_USD},${SALE_PARENT},${STOCK_PARENT},true,true,false,NULL),
      ('${ids.variantA}','${ids.A}','SEC08B-V','Variante','cat',${COST_VARIANT},0,${SALE_PARENT},5,true,false,false,'${ids.prodA}'),
      ('${ids.portalA}','${ids.A}','SEC08B-W','Portal','cat',${COST_PORTAL},0,${SALE_PARENT},7,true,false,true,NULL),
      ('${ids.prodB}','${ids.B}','SEC08B-B','Ajeno','cat',${COST_TENANT_B},0,${SALE_PARENT},3,true,false,false,NULL);

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

    INSERT INTO public.customers(id,business_id,name,phone) VALUES ('${ids.customer}','${ids.A}','Cli','1');
    INSERT INTO public.orders(id,business_id,customer_id,status) VALUES ('${ids.order}','${ids.A}','${ids.customer}','repair');
    -- Un comprobante SUELTO y uno VINCULADO A ORDEN: SEC-08A distingue los dos.
    -- OJO con \`status\`: el ledger devengado filtra por
    -- COALESCE(status, estado) IN ('issued','emitido'). Poner status='active'
    -- —como hace el fixture de SEC-08A, que no dependía del ledger— deja el
    -- comprobante FUERA de \`eff\` y el P&L sale vacío sin que nada esté roto.
    INSERT INTO public.comprobantes(id,business_id,order_id,customer_id,tipo,estado,subtotal,impuestos,total,total_bruto,total_cobrado,saldo_pendiente,currency,total_ars,total_usd,exchange_rate,tax,status,fecha) VALUES
      ('${ids.comp}','${ids.A}',NULL,'${ids.customer}','factura_c','emitido',${SALE_PARENT},0,${SALE_PARENT},${SALE_PARENT},0,${SALE_PARENT},'ARS',${SALE_PARENT},0,1,0,'issued',now()),
      ('${ids.compOrder}','${ids.A}','${ids.order}','${ids.customer}','factura_c','emitido',${SALE_PARENT},0,${SALE_PARENT},${SALE_PARENT},0,${SALE_PARENT},'ARS',${SALE_PARENT},0,1,0,'issued',now());
    INSERT INTO public.comprobante_items(id,comprobante_id,business_id,inventory_id,descripcion,cantidad,precio_unitario,subtotal,costo_unitario,costo_total,tipo_linea) VALUES
      ('${ids.itemFree}','${ids.comp}','${ids.A}','${ids.prodA}','linea-libre',1,${SALE_PARENT},${SALE_PARENT},${CI_COST_FREE},${CI_COST_FREE},'producto'),
      ('${ids.itemOrder}','${ids.compOrder}','${ids.A}','${ids.prodA}','linea-orden',1,${SALE_PARENT},${SALE_PARENT},${CI_COST_ORDER},${CI_COST_ORDER},'producto');
    COMMIT;
  `)
  seeded = true

  const ALL_COST = [COST_PARENT, COST_USD, COST_VARIANT, MOVE_COST, PI_COST, SPI_COST, IVH_CAPITAL, COST_PORTAL, CI_COST_FREE]

  // ═══ 1. El actor del contrato: inventory=true, inventory_view_costs=false ══
  // Todas las puertas medidas en el baseline, incluidos los dos oráculos.
  const CLOSED_ROUTES = [
    ['select=*',                 `/inventory?id=eq.${ids.prodA}&select=*`],
    ['columna explícita',        `/inventory?id=eq.${ids.prodA}&select=cost_price,cost_price_usd`],
    ['enumerando',               `/inventory?select=code,cost_price`],
    ['VARIANTE por parent_id',   `/inventory?parent_id=eq.${ids.prodA}&select=*`],
    ['ORÁCULO por filtro',       `/inventory?cost_price=eq.${COST_PARENT}&select=code`],
    ['ORÁCULO por ORDER BY',     `/inventory?select=code&order=cost_price.desc`],
    ['movimientos select=*',     `/inventory_movements?id=eq.${ids.move}&select=*`],
    ['movimientos → inventory',  `/inventory_movements?id=eq.${ids.move}&select=quantity,inventory:inventory_item_id(cost_price)`],
    ['línea de venta',           `/comprobante_items?select=inventory_id,costo_unitario,costo_total`],
  ]
  for (const [label, path] of CLOSED_ROUTES) {
    const res = await request('sales', path)
    denyValue(res, ALL_COST, `sales · ${label}`)
    expect(res.status === 403 || res.text.trim() === '[]', `sales · ${label}: se esperaba 403 o [] y hubo ${res.status}`)
  }
  // Tablas cuya fila entera es costo: 200 vacío, no 403 (la RLS filtra filas).
  for (const [label, path] of [
    ['compras',              `/purchase_items?select=*`],
    ['compras subtotal/qty', `/purchase_items?select=quantity,subtotal`],
    ['compras a proveedor',  `/supplier_purchase_items?select=*`],
    ['proveedor sub/qty',    `/supplier_purchase_items?select=quantity,subtotal`],
    ['cabecera de compra',   `/purchases?select=*`],
    ['valuación histórica',  `/inventory_valuation_history?select=*`],
  ]) {
    expectEmpty(await request('sales', path), `sales · ${label}`)
  }

  // ═══ 2. POSITIVOS operativos — el POS y el inventario NO se rompen ════════
  // (Fase 11: vender sin ver costo tiene que seguir siendo posible.)
  const POS_COLS = 'id,code,name,category,brand,model,barcode,sale_price,price_usd,currency,stock_quantity,is_active,has_variants,parent_id'
  for (const actor of ['sales', 'admin', 'owner', 'manager']) {
    const r = await request(actor, `/inventory?id=eq.${ids.prodA}&select=${POS_COLS}`)
    expectOk(r, `${actor} · lectura operativa de producto`)
    expectValue(r, SALE_PARENT, `${actor} · precio de venta`)
    expectValue(r, STOCK_PARENT, `${actor} · stock`)
    denyValue(r, ALL_COST, `${actor} · la lectura operativa NO puede traer costo`)
  }
  // Buscar por nombre/código y por código de barras: el picker del POS.
  expectValue(await request('sales', `/inventory?code=eq.SEC08B-P&select=code,sale_price,stock_quantity`),
    SALE_PARENT, 'sales · POS busca por código')
  // La VARIANTE también se opera sin costo.
  expectValue(await request('sales', `/inventory?parent_id=eq.${ids.prodA}&select=code,sale_price,stock_quantity`),
    'SEC08B-V', 'sales · POS ve la variante')
  // Movimientos de stock: cantidad, tipo y fecha siguen siendo operativos.
  const mv = await request('sales', `/inventory_movements?id=eq.${ids.move}&select=id,movement_type,quantity,previous_stock,new_stock,created_at,note`)
  expectOk(mv, 'sales · movimiento operativo')
  expectValue(mv, 'purchase', 'sales · tipo de movimiento')
  denyValue(mv, MOVE_COST, 'sales · el movimiento NO puede traer unit_cost')

  // ═══ 3. POSITIVOS de costo — el actor autorizado SIGUE viendo el número ═══
  for (const actor of ['owner', 'admin', 'manager']) {
    const r = await request(actor, `/v_inventory_costs?inventory_id=eq.${ids.prodA}&select=cost_price,cost_price_usd`)
    expectOk(r, `${actor} · v_inventory_costs`)
    expectValue(r, COST_PARENT, `${actor} · costo real del producto`)
    expectValue(r, COST_USD, `${actor} · costo real en USD`)
    // La VARIANTE (fila con parent_id) es la variante real de este esquema.
    expectValue(await request(actor, `/v_inventory_costs?inventory_id=eq.${ids.variantA}&select=cost_price`),
      COST_VARIANT, `${actor} · costo real de la VARIANTE`)
    expectValue(await request(actor, `/v_inventory_movement_costs?movement_id=eq.${ids.move}&select=unit_cost`),
      MOVE_COST, `${actor} · costo real del movimiento`)
    expectValue(await request(actor, `/purchase_items?select=unit_cost`), PI_COST, `${actor} · costo real de compra`)
    expectValue(await request(actor, `/supplier_purchase_items?select=unit_cost`), SPI_COST, `${actor} · costo real de compra a proveedor`)
    expectValue(await request(actor, `/inventory_valuation_history?select=capital_invertido`), IVH_CAPITAL, `${actor} · valuación real`)
  }
  // Denegados en la proyección autorizada: 200 vacío, nunca el número.
  for (const actor of ['sales', 'tech', 'viewer', 'cashier', 'inactive', 'ownerB']) {
    const r = await request(actor, `/v_inventory_costs?select=cost_price,cost_price_usd`)
    denyValue(r, ALL_COST, `${actor} · v_inventory_costs no puede entregar costo`)
    expect(r.status === 200 || r.status === 403, `${actor} · v_inventory_costs status ${r.status}`)
  }

  // ═══ 4. Portal mayorista — un tercero jamás ve el costo del taller ════════
  const w = await request('wholesale', `/inventory?visible_in_wholesale=eq.true&select=code,sale_price`)
  expectOk(w, 'mayorista · catálogo del portal')
  expectValue(w, 'SEC08B-W', 'mayorista · sigue viendo el producto publicado')
  denyValue(w, ALL_COST, 'mayorista · NO puede ver costo')
  denyValue(await request('wholesale', `/inventory?visible_in_wholesale=eq.true&select=cost_price`),
    COST_PORTAL, 'mayorista · pedir la columna de costo explícitamente')
  denyValue(await request('wholesale', `/v_inventory_costs?select=cost_price`),
    ALL_COST, 'mayorista · proyección autorizada')

  // ═══ 5. Aislamiento de tenant ════════════════════════════════════════════
  // La autoridad del negocio B nunca puede autorizar costo del negocio A.
  for (const path of [
    `/v_inventory_costs?inventory_id=eq.${ids.prodA}&select=cost_price`,
    `/purchase_items?select=unit_cost`,
    `/inventory_valuation_history?select=capital_invertido`,
    `/v_finance_inventory_capital?select=*`,
  ]) {
    denyValue(await request('ownerB', path), ALL_COST, `ownerB (tenant ajeno) · ${path}`)
  }
  // …y el owner de A tampoco alcanza el costo de B.
  denyValue(await request('owner', `/v_inventory_costs?inventory_id=eq.${ids.prodB}&select=cost_price`),
    COST_TENANT_B, 'owner de A · producto del tenant B')
  // Perfil inactivo: sin capacidad.
  denyValue(await request('inactive', `/v_inventory_costs?select=cost_price`), ALL_COST, 'perfil inactivo')
  // anon: ni la proyección ni la tabla.
  expect((await request(null, `/v_inventory_costs?select=cost_price`)).status >= 400, 'anon · v_inventory_costs')
  denyValue(await request(null, `/inventory?select=cost_price`), ALL_COST, 'anon · inventory.cost_price')

  // ═══ 6. Overrides — en los dos sentidos, y de verdad ═════════════════════
  setPerm('sales', `'{"inventory_view_costs": true}'::jsonb`)
  expectValue(await request('sales', `/v_inventory_costs?inventory_id=eq.${ids.prodA}&select=cost_price`),
    COST_PARENT, 'override true sobre sales · ahora SÍ ve costo')
  expectValue(await request('sales', `/purchase_items?select=unit_cost`),
    PI_COST, 'override true sobre sales · compras')
  setPerm('sales', 'NULL')
  denyValue(await request('sales', `/v_inventory_costs?select=cost_price`), ALL_COST, 'sales sin override · vuelve a estar cerrado')

  // Un override a false tiene que denegar incluso a un admin. Éste es el
  // motivo por el que `can_view_inventory_cost` NO incluye `finance`: el admin
  // lo trae por defecto y el override habría quedado muerto.
  setPerm('admin', `'{"inventory_view_costs": false}'::jsonb`)
  denyValue(await request('admin', `/v_inventory_costs?select=cost_price`), ALL_COST, 'override false sobre admin · deniega')
  expectEmpty(await request('admin', `/purchase_items?select=unit_cost`), 'override false sobre admin · compras')
  setPerm('admin', 'NULL')
  expectValue(await request('admin', `/v_inventory_costs?inventory_id=eq.${ids.prodA}&select=cost_price`),
    COST_PARENT, 'admin sin override · recupera el costo')

  // Un payload roto no puede AMPLIAR privilegio.
  setPerm('sales', `'{"inventory_view_costs": "true"}'::jsonb`)
  denyValue(await request('sales', `/v_inventory_costs?select=cost_price`), ALL_COST, 'override con string en vez de boolean · fail-closed')
  setPerm('sales', 'NULL')

  // ═══ 7. Vistas de finanzas — sin ceros falsos ════════════════════════════
  const capOwner = await request('owner', `/v_finance_inventory_capital?business_id=eq.${ids.A}&select=inventory_at_cost`)
  expectOk(capOwner, 'owner · capital de inventario')
  expect(!capOwner.text.includes('"inventory_at_cost":0'), 'owner · el capital no puede ser 0 con stock costeado')
  expectEmpty(await request('sales', `/v_finance_inventory_capital?business_id=eq.${ids.A}&select=*`), 'sales · capital de inventario')

  const posOwner = await request('owner', `/v_finance_position?business_id=eq.${ids.A}&select=inventory_at_cost`)
  expectOk(posOwner, 'owner · posición financiera')
  expect(!/"inventory_at_cost":\s*(0|null)\b/.test(posOwner.text),
    `owner · inventory_at_cost real, no 0 ni null — ${posOwner.text.slice(0, 200)}`)
  // Para el actor sin autoridad la vista puede no devolver fila; lo que NO
  // puede es devolver un CERO, que se leería como «no hay capital inmovilizado».
  const posSales = await request('sales', `/v_finance_position?business_id=eq.${ids.A}&select=inventory_at_cost`)
  expectOk(posSales, 'sales · posición financiera sigue respondiendo')
  const posRows = JSON.parse(posSales.text)
  expect(posRows.every(r => r.inventory_at_cost === null),
    `sales · inventory_at_cost tiene que ser NULL (restringido), NUNCA 0 — ${posSales.text.slice(0, 200)}`)
  // Y con el override puesto, el mismo actor recibe el número real: la
  // denegación es por autoridad, no porque la vista esté rota.
  setPerm('sales', `'{"inventory_view_costs": true}'::jsonb`)
  const posSalesOn = await request('sales', `/v_finance_position?business_id=eq.${ids.A}&select=inventory_at_cost`)
  expect(JSON.parse(posSalesOn.text).some(r => Number(r.inventory_at_cost) > 0),
    `sales con override · tiene que llegar el capital real — ${posSalesOn.text.slice(0, 200)}`)
  setPerm('sales', 'NULL')

  // El P&L: el cashier lo consume y no puede quedarse con gross_profit = net_sales.
  const pnlCashier = await request('cashier', `/v_finance_pnl?business_id=eq.${ids.A}&select=net_sales,cogs,gross_profit`)
  expectOk(pnlCashier, 'cashier · P&L')
  expect(pnlCashier.text.trim() !== '[]', 'cashier · el P&L no puede quedar vacío')
  const pnlRow = JSON.parse(pnlCashier.text)[0]
  expect(Number(pnlRow.cogs) > 0, `cashier · el COGS del P&L tiene que ser real, llegó ${pnlRow.cogs}`)
  expect(Number(pnlRow.gross_profit) !== Number(pnlRow.net_sales),
    'cashier · gross_profit NO puede igualar net_sales (sería el COGS anulado)')
  expectEmpty(await request('sales', `/v_finance_pnl?business_id=eq.${ids.A}&select=*`), 'sales · P&L')
  expectEmpty(await request('viewer', `/v_finance_pnl?business_id=eq.${ids.A}&select=*`), 'viewer · P&L')

  // Ledger devengado: la VENTA se sigue viendo; el COGS no.
  const ledSales = await request('sales', `/v_finance_sales_ledger?comprobante_item_id=eq.${ids.itemFree}&select=sales_amount_ars,cogs_amount_ars`)
  expectOk(ledSales, 'sales · ledger de ventas')
  if (ledSales.text.trim() !== '[]') {
    expectValue(ledSales, SALE_PARENT, 'sales · el importe de VENTA sí se ve')
    denyValue(ledSales, CI_COST_FREE, 'sales · el COGS de la línea NO se ve')
    expect(/"cogs_amount_ars":\s*null/.test(ledSales.text),
      `sales · cogs_amount_ars tiene que ser NULL, no 0 — ${ledSales.text.slice(0, 200)}`)
  }
  expectValue(await request('owner', `/v_finance_sales_ledger?comprobante_item_id=eq.${ids.itemFree}&select=cogs_amount_ars`),
    CI_COST_FREE, 'owner · el COGS real sigue llegando al ledger')

  // ═══ 8. SEC-08A no se reabre ═════════════════════════════════════════════
  // El comprobante VINCULADO A ORDEN sigue exigiendo orders_view_financials,
  // ahora también en la proyección de costo.
  denyValue(await request('tech', `/v_comprobante_item_costs?select=costo_unitario`),
    [CI_COST_ORDER, CI_COST_FREE], 'tech (sin orders_view_financials ni costo) · costo de línea')
  // FASE B — el cashier YA NO recibe el costo crudo de línea. Esta aserción
  // exigía lo contrario, y por eso el lote pasaba sus propios tests mientras
  // `finance` seguía habilitando el costo por producto: la revisión
  // independiente lo reprodujo como bypass. El positivo se toma ahora de un
  // actor que sí tiene `inventory_view_costs`.
  denyValue(await request('cashier', `/v_comprobante_item_costs?comprobante_item_id=eq.${ids.itemOrder}&select=costo_unitario`),
    [CI_COST_ORDER], 'cashier (finance, sin inventory_view_costs) · costo de línea de orden')
  const ordCost = await request('manager', `/v_comprobante_item_costs?comprobante_item_id=eq.${ids.itemOrder}&select=costo_unitario`)
  expectValue(ordCost, CI_COST_ORDER, 'manager (inventory_view_costs + orders_view_financials) · costo de línea de orden')
  // Y las rutas canónicas de SEC-08A siguen respondiendo.
  const oa = await request('owner', `/rpc/get_order_financial_amounts?p_order_id=${ids.order}`)
  expect(oa.status === 200 || oa.status === 404, `SEC-08A get_order_financial_amounts respondió ${oa.status}`)

  // ═══ 9. CONTROLES NEGATIVOS ══════════════════════════════════════════════
  // Cada frontera se reabre a propósito. Si el testigo NO cruza al reabrirla,
  // la aserción correspondiente no estaba probando nada.
  const controls = [
    {
      name: 'GRANT crudo de inventory.cost_price',
      open: () => sql(`GRANT SELECT (cost_price) ON public.inventory TO authenticated;`),
      probe: () => request('sales', `/inventory?id=eq.${ids.prodA}&select=cost_price`),
      witness: COST_PARENT,
      close: () => sql(`REVOKE SELECT (cost_price) ON public.inventory FROM authenticated;`),
    },
    {
      name: 'GRANT crudo de comprobante_items.costo_unitario',
      open: () => sql(`GRANT SELECT (costo_unitario) ON public.comprobante_items TO authenticated;`),
      probe: () => request('sales', `/comprobante_items?id=eq.${ids.itemFree}&select=costo_unitario`),
      witness: CI_COST_FREE,
      close: () => sql(`REVOKE SELECT (costo_unitario) ON public.comprobante_items FROM authenticated;`),
    },
    {
      name: 'quitar el gate de costo de v_inventory_costs',
      open: () => sql(`CREATE OR REPLACE VIEW public.v_inventory_costs AS
                         SELECT i.id AS inventory_id, i.business_id, i.parent_id, i.cost_price, i.cost_price_usd
                           FROM public.inventory i
                          WHERE i.business_id = public.current_user_business_id();`),
      probe: () => request('sales', `/v_inventory_costs?inventory_id=eq.${ids.prodA}&select=cost_price`),
      witness: COST_PARENT,
      close: () => sql(`CREATE OR REPLACE VIEW public.v_inventory_costs AS
                         SELECT i.id AS inventory_id, i.business_id, i.parent_id, i.cost_price, i.cost_price_usd
                           FROM public.inventory i
                          WHERE i.business_id = public.current_user_business_id()
                            AND public.current_user_can_in_business(i.business_id, 'inventory')
                            AND public.can_view_inventory_cost(i.business_id);`),
    },
    {
      name: 'restaurar la policy vieja de purchase_items (current_user_can inventory)',
      open: () => sql(`DROP POLICY IF EXISTS purchase_items_select ON public.purchase_items;
                       CREATE POLICY purchase_items_select ON public.purchase_items FOR SELECT TO authenticated
                         USING (business_id = current_business_id() AND current_user_can('inventory'));`),
      probe: () => request('sales', `/purchase_items?select=unit_cost`),
      witness: PI_COST,
      close: () => sql(`DROP POLICY IF EXISTS purchase_items_select ON public.purchase_items;
                        CREATE POLICY purchase_items_select ON public.purchase_items FOR SELECT TO authenticated
                          USING (business_id = public.current_user_business_id()
                                 AND public.can_view_inventory_cost(business_id));`),
    },
    {
      name: 'abrir el tenant en v_inventory_costs (sin current_user_business_id)',
      open: () => sql(`CREATE OR REPLACE VIEW public.v_inventory_costs AS
                         SELECT i.id AS inventory_id, i.business_id, i.parent_id, i.cost_price, i.cost_price_usd
                           FROM public.inventory i;`),
      probe: () => request('ownerB', `/v_inventory_costs?inventory_id=eq.${ids.prodA}&select=cost_price`),
      witness: COST_PARENT,
      close: () => sql(`CREATE OR REPLACE VIEW public.v_inventory_costs AS
                         SELECT i.id AS inventory_id, i.business_id, i.parent_id, i.cost_price, i.cost_price_usd
                           FROM public.inventory i
                          WHERE i.business_id = public.current_user_business_id()
                            AND public.current_user_can_in_business(i.business_id, 'inventory')
                            AND public.can_view_inventory_cost(i.business_id);`),
    },
  ]

  console.log('\n--- Controles negativos ---')
  for (const c of controls) {
    c.open()
    sql(`NOTIFY pgrst, 'reload schema';`)
    await new Promise(r => setTimeout(r, 900))
    const opened = await c.probe()
    checks++
    assert(String(opened.text ?? '').includes(String(c.witness)),
      `CONTROL NEGATIVO INÚTIL — «${c.name}»: al reabrir, el testigo ${c.witness} NO cruzó (${opened.status} ${opened.text?.slice(0, 200)}). La aserción que protege esta frontera no prueba nada.`)
    c.close()
    sql(`NOTIFY pgrst, 'reload schema';`)
    await new Promise(r => setTimeout(r, 900))
    const closed = await c.probe()
    checks++
    assert(!String(closed.text ?? '').includes(String(c.witness)),
      `«${c.name}»: tras restaurar, el testigo ${c.witness} SIGUE cruzando — ${closed.status} ${closed.text?.slice(0, 200)}`)
    console.log(`  ✓ ${c.name} — cruza al abrir, no cruza al cerrar`)
  }

  console.log(`\nSEC-08B PostgREST OK — ${checks} aserciones sobre ${requests} requests`)
}

const cleanup = () => {
  if (!seeded) return
  try {
    sql(`
      BEGIN;
      SET session_replication_role=replica;
      DELETE FROM public.comprobante_items WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.comprobantes WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.orders WHERE business_id IN ('${ids.A}','${ids.B}');
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
  .catch(e => { cleanup(); console.error('\nSEC-08B PostgREST FALLÓ:', e.message); process.exit(1) })

