#!/usr/bin/env node
// SEC-08C — contrato de VISIBILIDAD FINANCIERA DE PROVEEDORES, medido por HTTP.
//
// Se prueba contra el PostgREST local con JWT reales porque el único enunciado
// que vale es «el testigo cruzó la red» o «no cruzó». Cada frontera cerrada
// tiene al lado su POSITIVO: el actor autorizado tiene que seguir recibiendo el
// número real, o un 403 generalizado pasaría por seguridad cuando en realidad
// es una pantalla rota.
//
// Cubre: pagos, cuenta corriente, cabecera de compra, los ORÁCULOS (?campo=eq.
// y ?order=campo.desc), la separación deuda-agregada / costo-crudo que hereda
// de SEC-08B, la escritura canónica de compra y de pago, los overrides en los
// dos sentidos, el aislamiento de tenant (incluida la RPC con business_id
// forjado), anon, y CONTROLES NEGATIVOS que reabren cada frontera a propósito.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')
const dbContainer = process.env.SEC08C_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base local')
const MIGRATION = 'supabase/migrations/20260918120000_sec08c_supplier_finance_visibility.sql'

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
const sql = q => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], q).trim()

const ACTORS = ['owner', 'admin', 'manager', 'sales', 'cashier', 'tech', 'viewer', 'inactive', 'ownerB']
const ids = Object.fromEntries(
  [...ACTORS, 'A', 'B', 'supA', 'supA2', 'supB', 'purA', 'purA2', 'purB', 'payA', 'payB', 'movA', 'prodA']
    .map(n => [n, randomUUID()]))

// ── Testigos: ni 0, ni redondos, ni iguales entre sí ─────────────────────────
const SP_TOTAL = 73191
const SP_PAID = 21203
const SP_PENDING = 51988
const SP2_PENDING = 30407
const SP2_TOTAL = 45613
const SP2_PAID = 15206
const DEBT_TOTAL = SP_PENDING + SP2_PENDING      // 82395
const PAY_AMOUNT = 11837
const ITEM_UNIT_COST = 4173
const ITEM_SUBTOTAL = 12519
const MOV_DEBIT = 68429
const MOV_CREDIT = 39157
const MOV_BALANCE = 29272
const PROD_COST = 55271                          // costo de inventario (SEC-08B)
const B_PENDING = 90211
const B_PAY = 90212
const B_DEBIT = 90213
const TAG = 'sec08c-http.invalid'

// Todo lo que un actor sin autoridad financiera de proveedor NO puede recibir.
const SUPPLIER_FINANCE = [SP_TOTAL, SP_PAID, SP_PENDING, SP2_TOTAL, SP2_PAID, SP2_PENDING,
  PAY_AMOUNT, MOV_DEBIT, MOV_CREDIT, MOV_BALANCE]
const RAW_COST = [ITEM_UNIT_COST, ITEM_SUBTOTAL, PROD_COST]

let seeded = false, requests = 0, checks = 0

const main = async () => {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuración de PostgREST local')

  // Si la migración no está aplicada, TODO «pasaría» por accidente.
  const applied = sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='can_view_supplier_finance';`)
  assert(applied === '1', `SEC-08C no está aplicada en la base local (aplicá ${MIGRATION})`)

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
  const request = async (actor, path, init) => {
    requests++
    const r = await fetch(apiUrl + path, {
      method: init?.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${token(actor)}` } : {}) },
      body: init?.body,
      signal: AbortSignal.timeout(20000),
    })
    return { status: r.status, text: await r.text() }
  }
  const rpc = (actor, fn, args) => request(actor, `/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })

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
  const profiles = ACTORS.map(n =>
    `('${ids[n]}','${n === 'ownerB' ? ids.B : ids.A}','${n === 'ownerB' ? 'owner' : n === 'inactive' ? 'admin' : n}',${n === 'inactive' ? 'false' : 'true'},'${n}@${TAG}')`).join(',')

  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ${users};
    -- Sólo 'owner' es dueño registrado de A: si otro rol lo fuera, la rama de
    -- dueño de current_user_can_in_business le daría todo y el test mentiría.
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
      ('${ids.A}','B-A','${ids.owner}','pro','active'),
      ('${ids.B}','B-B','${ids.ownerB}','pro','active');
    INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES ${profiles};

    INSERT INTO public.inventory(id,business_id,code,name,category,cost_price,sale_price,stock_quantity,is_active)
      VALUES ('${ids.prodA}','${ids.A}','SEC08C-P','Producto','cat',${PROD_COST},99000,10,true);

    INSERT INTO public.suppliers(id,business_id,name,phone,active) VALUES
      ('${ids.supA}','${ids.A}','Prov-Uno','1131110001',true),
      ('${ids.supA2}','${ids.A}','Prov-Dos','1131110002',true),
      ('${ids.supB}','${ids.B}','Prov-Ajeno','1131110003',true);

    INSERT INTO public.supplier_purchases(id,business_id,supplier_id,purchase_date,invoice_number,total_amount,paid_amount,pending_amount,payment_status) VALUES
      ('${ids.purA}','${ids.A}','${ids.supA}',current_date,'F-08C-1',${SP_TOTAL},${SP_PAID},${SP_PENDING},'partial'),
      ('${ids.purA2}','${ids.A}','${ids.supA2}',current_date,'F-08C-2',${SP2_TOTAL},${SP2_PAID},${SP2_PENDING},'partial'),
      ('${ids.purB}','${ids.B}','${ids.supB}',current_date,'F-08C-B',${B_PENDING},0,${B_PENDING},'pending');

    INSERT INTO public.supplier_purchase_items(id,business_id,purchase_id,supplier_id,inventory_id,product_name,quantity,unit_cost,subtotal) VALUES
      (gen_random_uuid(),'${ids.A}','${ids.purA}','${ids.supA}','${ids.prodA}','linea-08c',3,${ITEM_UNIT_COST},${ITEM_SUBTOTAL});

    INSERT INTO public.supplier_payments(id,business_id,supplier_id,purchase_id,payment_date,amount,payment_method,notes) VALUES
      ('${ids.payA}','${ids.A}','${ids.supA}','${ids.purA}',current_date,${PAY_AMOUNT},'transferencia','pago-08c'),
      ('${ids.payB}','${ids.B}','${ids.supB}',NULL,current_date,${B_PAY},'efectivo','pago-08c-B');

    INSERT INTO public.supplier_account_movements(id,business_id,supplier_id,purchase_id,payment_id,movement_date,type,description,debit,credit,balance_after) VALUES
      ('${ids.movA}','${ids.A}','${ids.supA}','${ids.purA}',NULL,current_date,'purchase','mov-08c',${MOV_DEBIT},${MOV_CREDIT},${MOV_BALANCE}),
      (gen_random_uuid(),'${ids.B}','${ids.supB}','${ids.purB}',NULL,current_date,'purchase','mov-08c-B',${B_DEBIT},0,${B_DEBIT});
    COMMIT;
  `)
  seeded = true

  // La verdad canónica NO es cero. Sin esto todo lo de abajo confundiría
  // «no hay deuda» con «no se puede ver la deuda».
  expect(sql(`SELECT round(sum(pending_amount),0)::text FROM public.supplier_purchases
               WHERE business_id='${ids.A}' AND payment_status <> 'paid';`) === String(DEBT_TOTAL),
    `la deuda sembrada del tenant A tiene que ser ${DEBT_TOTAL}`)

  // ═══ 1. Actores SIN autoridad financiera de proveedor ═════════════════════
  // `sales` es el caso del defecto: inventory=true, finance=false,
  // inventory_view_costs=false. `tech` y `viewer` no tienen ni inventory.
  const CLOSED = [
    ['pagos select=*',            `/supplier_payments?select=*`],
    ['pagos columna explícita',   `/supplier_payments?select=amount,payment_date`],
    ['pagos ORÁCULO filtro',      `/supplier_payments?amount=eq.${PAY_AMOUNT}&select=id`],
    ['pagos ORÁCULO order',       `/supplier_payments?select=id&order=amount.desc`],
    ['CC select=*',               `/supplier_account_movements?select=*`],
    ['CC saldo',                  `/supplier_account_movements?select=debit,credit,balance_after`],
    ['CC ORÁCULO filtro',         `/supplier_account_movements?balance_after=eq.${MOV_BALANCE}&select=id`],
    ['CC ORÁCULO order',          `/supplier_account_movements?select=id&order=balance_after.desc`],
    ['compra select=*',           `/supplier_purchases?select=*`],
    ['compra importes',           `/supplier_purchases?select=total_amount,paid_amount,pending_amount`],
    ['compra ORÁCULO filtro',     `/supplier_purchases?pending_amount=eq.${SP_PENDING}&select=id`],
    ['compra ORÁCULO order',      `/supplier_purchases?select=id&order=pending_amount.desc`],
    ['línea de compra',           `/supplier_purchase_items?select=*`],
    ['línea qty/subtotal',        `/supplier_purchase_items?select=quantity,subtotal`],
    ['embed compra→líneas',       `/supplier_purchases?select=id,items:supplier_purchase_items(unit_cost,subtotal)`],
    ['embed proveedor→compras',   `/suppliers?select=name,supplier_purchases(pending_amount)`],
    ['embed proveedor→pagos',     `/suppliers?select=name,supplier_payments(amount)`],
    ['payables aging',            `/v_finance_payables_aging?select=*`],
    ['payables due',              `/v_finance_payables_due?select=*`],
    ['compras diarias',           `/v_finance_supplier_purchases_daily?select=*`],
  ]
  for (const actor of ['sales', 'tech', 'viewer', 'inactive']) {
    for (const [label, path] of CLOSED) {
      const res = await request(actor, path)
      denyValue(res, [...SUPPLIER_FINANCE, ...RAW_COST], `${actor} · ${label}`)
      expect(res.status === 403 || res.status === 200,
        `${actor} · ${label}: status inesperado ${res.status}`)
    }
  }

  // ═══ 2. RESTRINGIDO ES NULL, NUNCA CERO ══════════════════════════════════
  // El corazón del lote: el agregado canónico responde, pero con NULL.
  const salesDebt = await request('sales', `/v_finance_supplier_debt?business_id=eq.${ids.A}&select=outstanding_ars,documents,is_authorized`)
  expectOk(salesDebt, 'sales · la vista de deuda sigue respondiendo (no es un 403 que rompe la pantalla)')
  const salesRows = JSON.parse(salesDebt.text)
  expect(salesRows.length === 1, `sales · tiene que llegar la fila de su negocio — ${salesDebt.text.slice(0, 200)}`)
  expect(salesRows[0].outstanding_ars === null,
    `sales · outstanding_ars tiene que ser NULL (restringido), NUNCA 0 — llegó ${JSON.stringify(salesRows[0])}`)
  expect(salesRows[0].is_authorized === false, 'sales · is_authorized = false')
  denyValue(salesDebt, SUPPLIER_FINANCE, 'sales · la vista de deuda no filtra importes')

  // Y lo mismo en la posición financiera, que arrastraba el cero por COALESCE.
  const salesPos = await request('sales', `/v_finance_position?business_id=eq.${ids.A}&select=payables`)
  expectOk(salesPos, 'sales · v_finance_position responde')
  const posRows = JSON.parse(salesPos.text)
  expect(posRows.every(r => r.payables === null),
    `sales · v_finance_position.payables tiene que ser NULL, nunca 0 — ${salesPos.text.slice(0, 200)}`)

  // ═══ 3. POSITIVOS — el actor autorizado recibe la verdad ═════════════════
  // Sin estos, un 403 global pasaría por «seguro».
  for (const actor of ['owner', 'admin', 'cashier']) {
    const r = await request(actor, `/v_finance_supplier_debt?business_id=eq.${ids.A}&select=outstanding_ars,documents,is_authorized`)
    expectOk(r, `${actor} · deuda agregada`)
    const row = JSON.parse(r.text)[0]
    expect(Number(row.outstanding_ars) === DEBT_TOTAL,
      `${actor} · tiene que llegar la deuda REAL ${DEBT_TOTAL}, llegó ${row.outstanding_ars}`)
    expect(Number(row.documents) === 2, `${actor} · documentos con deuda = 2, llegó ${row.documents}`)
    expect(row.is_authorized === true, `${actor} · is_authorized = true`)
  }
  // `manager` es el rol de COMPRAS: no tiene `finance`, y aun así tiene que
  // conservar la deuda del proveedor al que le compra.
  expectValue(await request('manager', `/v_finance_supplier_debt?business_id=eq.${ids.A}&select=outstanding_ars`),
    DEBT_TOTAL, 'manager (inventory_view_costs, sin finance) · conserva la deuda agregada')
  for (const actor of ['owner', 'admin', 'manager', 'cashier']) {
    expectValue(await request(actor, `/supplier_purchases?id=eq.${ids.purA}&select=pending_amount`),
      SP_PENDING, `${actor} · saldo real de la compra`)
    expectValue(await request(actor, `/supplier_payments?id=eq.${ids.payA}&select=amount`),
      PAY_AMOUNT, `${actor} · importe real del pago`)
    expectValue(await request(actor, `/supplier_account_movements?id=eq.${ids.movA}&select=debit,balance_after`),
      MOV_DEBIT, `${actor} · cuenta corriente real`)
  }
  // El aging del proveedor tiene que llegarle al actor de finanzas.
  // Las dos compras caen en el mismo bucket, así que el testigo del aging es
  // la suma, no una de las dos.
  expectValue(await request('cashier', `/v_finance_payables_aging?business_id=eq.${ids.A}&select=bucket,amount`),
    DEBT_TOTAL, 'cashier · aging de payables con importe real')

  // ═══ 4. CONTRATO CENTRAL — deuda agregada != costo crudo ═════════════════
  // finance=true, inventory_view_costs=false: ve la DEUDA y NO ve el costo por
  // artículo. Es la frontera que SEC-08C no puede colapsar.
  const cashierDebt = await request('cashier', `/v_finance_supplier_debt?business_id=eq.${ids.A}&select=outstanding_ars`)
  expectValue(cashierDebt, DEBT_TOTAL, 'cashier · SÍ ve la deuda agregada')
  for (const [label, path] of [
    ['línea de compra select=*', `/supplier_purchase_items?select=*`],
    ['línea unit_cost',          `/supplier_purchase_items?select=unit_cost`],
    ['línea subtotal',           `/supplier_purchase_items?select=subtotal`],
    ['embed compra→línea',       `/supplier_purchases?id=eq.${ids.purA}&select=id,items:supplier_purchase_items(unit_cost,subtotal)`],
    ['ORÁCULO unit_cost',        `/supplier_purchase_items?unit_cost=eq.${ITEM_UNIT_COST}&select=id`],
    ['ORÁCULO order unit_cost',  `/supplier_purchase_items?select=id&order=unit_cost.desc`],
    ['costo de inventario',      `/inventory?id=eq.${ids.prodA}&select=cost_price`],
    ['proyección de costo',      `/v_inventory_costs?select=cost_price`],
  ]) {
    denyValue(await request('cashier', path), RAW_COST, `cashier (finance sin costo) · ${label}`)
  }
  // Y el que SÍ tiene autoridad de costo lo sigue viendo: la denegación de
  // arriba es por autoridad, no porque la superficie esté rota.
  expectValue(await request('manager', `/supplier_purchase_items?select=unit_cost`),
    ITEM_UNIT_COST, 'manager (inventory_view_costs) · el costo crudo real sigue llegando')

  // ═══ 5. ESCRITURA — el contrato ratificado de SEC-08B se preserva ════════
  // Un operador de compras (inventory, sin costo ni finanzas) crea la compra
  // canónica y el servidor establece el costo… y él sigue sin poder leerlo.
  const NEW_TOTAL = 64318, NEW_COST = 7241
  const created = await rpc('sales', 'create_supplier_purchase_atomic', {
    p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids.sales,
    p_supplier_name: 'Prov-Uno', p_purchase_date: sql(`SELECT current_date::text`),
    p_invoice_number: 'F-08C-W', p_total_amount: NEW_TOTAL, p_paid_amount: 0,
    p_payment_method: 'transferencia', p_notes: 'write-without-read',
    p_items: [{ inventory_id: ids.prodA, product_name: 'linea-w', quantity: 1, unit_cost: NEW_COST }],
    p_idempotency_key: null,
  })
  expect(created.status === 200 && JSON.parse(created.text)?.ok === true,
    `sales · la compra canónica TIENE que seguir siendo posible — ${created.status} ${created.text.slice(0, 300)}`)
  const newPurchaseId = JSON.parse(created.text).purchase_id
  // El efecto server-side ocurrió…
  expect(sql(`SELECT count(*) FROM public.supplier_purchases WHERE id='${newPurchaseId}';`) === '1',
    'sales · la compra quedó registrada server-side')
  // …y el autor sigue sin poder leerla.
  for (const [label, path] of [
    ['la compra que acaba de crear', `/supplier_purchases?id=eq.${newPurchaseId}&select=total_amount`],
    ['la línea que acaba de crear',  `/supplier_purchase_items?purchase_id=eq.${newPurchaseId}&select=unit_cost`],
    ['el costo del producto',        `/inventory?id=eq.${ids.prodA}&select=cost_price`],
  ]) {
    denyValue(await request('sales', path), [NEW_TOTAL, NEW_COST, PROD_COST], `sales · escribe sin leer · ${label}`)
  }

  // ── Autoridad de escritura de PAGOS ──
  // Se MIDE, no se asume. Hoy las RPC de pago exigen `inventory`, no `finance`.
  // Este lote NO cambia esa autoridad (sería rediseñar quién puede pagar), pero
  // la fija por test para que cualquier cambio futuro sea deliberado.
  const paid = await rpc('sales', 'pay_supplier_free_atomic', {
    p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids.sales,
    p_supplier_name: 'Prov-Uno', p_payment_date: sql(`SELECT current_date::text`),
    p_amount: 9137, p_payment_method: 'transferencia', p_notes: 'pago-w', p_idempotency_key: null,
  })
  expect(paid.status === 200 && JSON.parse(paid.text)?.ok === true,
    `sales · la RPC de pago exige inventory y hoy la tiene — ${paid.status} ${paid.text.slice(0, 300)}`)
  // Pero NO puede leer el pago que creó: la asimetría queda explícita.
  denyValue(await request('sales', `/supplier_payments?id=eq.${JSON.parse(paid.text).payment_id}&select=amount`),
    9137, 'sales · no puede leer el pago que acaba de registrar')
  // Un actor sin `inventory` NO puede pagar.
  for (const actor of ['tech', 'viewer']) {
    const r = await rpc(actor, 'pay_supplier_free_atomic', {
      p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids[actor],
      p_supplier_name: 'Prov-Uno', p_payment_date: sql(`SELECT current_date::text`),
      p_amount: 7717, p_payment_method: 'transferencia', p_notes: 'x', p_idempotency_key: null,
    })
    expect(r.status >= 400 || JSON.parse(r.text)?.ok !== true,
      `${actor} · NO puede registrar un pago a proveedor — ${r.status} ${r.text.slice(0, 200)}`)
  }

  // La sección 5 escribió una compra nueva, así que la deuda canónica cambió.
  // A partir de acá se compara contra la verdad VIVA de la base, no contra la
  // constante del fixture: si no, el test empezaría a mentir en cuanto alguien
  // agregue una escritura más arriba.
  const liveDebt = Number(sql(`SELECT round(sum(pending_amount),2)::text FROM public.supplier_purchases
                                WHERE business_id='${ids.A}' AND pending_amount > 0.01 AND payment_status <> 'paid';`))
  expect(liveDebt > DEBT_TOTAL, `la compra creada por sales tiene que haber subido la deuda (${liveDebt})`)

  // ═══ 6. AISLAMIENTO DE TENANT ════════════════════════════════════════════
  for (const [label, path] of [
    ['pagos', `/supplier_payments?select=amount`],
    ['CC', `/supplier_account_movements?select=debit,balance_after`],
    ['compras', `/supplier_purchases?select=pending_amount`],
    ['deuda agregada', `/v_finance_supplier_debt?select=*`],
    ['stats por proveedor', `/v_finance_supplier_stats?select=*`],
    ['payables due', `/v_finance_payables_due?select=*`],
  ]) {
    denyValue(await request('ownerB', path), SUPPLIER_FINANCE, `ownerB (tenant ajeno) · ${label}`)
    denyValue(await request('owner', path), [B_PENDING, B_PAY, B_DEBIT], `owner de A · no alcanza el tenant B · ${label}`)
    denyValue(await request('admin', path), [B_PENDING, B_PAY, B_DEBIT], `admin de A · no alcanza el tenant B · ${label}`)
  }
  // Lookup directo por id ajeno.
  denyValue(await request('ownerB', `/supplier_purchases?id=eq.${ids.purA}&select=pending_amount`),
    SP_PENDING, 'ownerB · lookup directo de una compra ajena')
  denyValue(await request('owner', `/v_finance_supplier_debt?business_id=eq.${ids.B}&select=outstanding_ars`),
    B_PENDING, 'owner de A · deuda agregada del tenant B')
  // RPC con business_id FORJADO y con supplier/purchase ajenos.
  for (const [label, args] of [
    ['business_id forjado', { p_business_id: ids.B, p_supplier_id: ids.supB, p_user_id: ids.owner, p_supplier_name: 'x', p_payment_date: sql(`SELECT current_date::text`), p_amount: 5501, p_payment_method: 'transferencia', p_notes: 'x', p_idempotency_key: null }],
    ['supplier ajeno', { p_business_id: ids.A, p_supplier_id: ids.supB, p_user_id: ids.owner, p_supplier_name: 'x', p_payment_date: sql(`SELECT current_date::text`), p_amount: 5502, p_payment_method: 'transferencia', p_notes: 'x', p_idempotency_key: null }],
  ]) {
    const r = await rpc('owner', 'pay_supplier_free_atomic', args)
    expect(r.status >= 400 || JSON.parse(r.text)?.ok !== true,
      `owner de A · pago con ${label} tiene que fallar — ${r.status} ${r.text.slice(0, 200)}`)
  }
  expect(sql(`SELECT count(*) FROM public.supplier_payments WHERE business_id='${ids.B}' AND amount IN (5501,5502);`) === '0',
    'ningún pago cross-tenant quedó escrito')
  // Compra con purchase ajeno.
  const foreignPay = await rpc('owner', 'pay_supplier_purchase_atomic', {
    p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids.owner, p_supplier_name: 'x',
    p_purchase_id: ids.purB, p_payment_date: sql(`SELECT current_date::text`),
    p_amount: 5503, p_payment_method: 'transferencia', p_notes: 'x', p_idempotency_key: null,
  })
  expect(foreignPay.status >= 400 || JSON.parse(foreignPay.text)?.ok !== true,
    `owner de A · pago contra una compra del tenant B tiene que fallar — ${foreignPay.text.slice(0, 200)}`)

  // ═══ 7. anon ═════════════════════════════════════════════════════════════
  for (const p of [`/supplier_payments?select=amount`, `/supplier_account_movements?select=debit`,
    `/supplier_purchases?select=pending_amount`, `/supplier_purchase_items?select=unit_cost`,
    `/suppliers?select=name`, `/v_finance_supplier_debt?select=*`, `/v_finance_supplier_stats?select=*`]) {
    const r = await request(null, p)
    denyValue(r, [...SUPPLIER_FINANCE, ...RAW_COST], `anon · ${p}`)
    expect(r.status >= 400 || r.text.trim() === '[]', `anon · ${p}: status ${r.status}`)
  }

  // ═══ 8. OVERRIDES — en los dos sentidos, y de verdad ═════════════════════
  setPerm('sales', `'{"finance": true}'::jsonb`)
  expectValue(await request('sales', `/v_finance_supplier_debt?business_id=eq.${ids.A}&select=outstanding_ars`),
    liveDebt, 'override finance=true sobre sales · ahora SÍ ve la deuda')
  expectValue(await request('sales', `/supplier_payments?id=eq.${ids.payA}&select=amount`),
    PAY_AMOUNT, 'override finance=true sobre sales · ahora SÍ ve el pago')
  // …pero el override de FINANZAS no le da el COSTO CRUDO. Es el contrato.
  denyValue(await request('sales', `/supplier_purchase_items?select=unit_cost`),
    RAW_COST, 'override finance=true · NO habilita el costo crudo por línea')
  setPerm('sales', 'NULL')
  denyValue(await request('sales', `/supplier_payments?select=amount`), SUPPLIER_FINANCE,
    'sales sin override · vuelve a estar cerrado')

  // Un override a false deniega incluso a quien la tiene por rol.
  setPerm('cashier', `'{"finance": false}'::jsonb`)
  const cashOff = await request('cashier', `/v_finance_supplier_debt?business_id=eq.${ids.A}&select=outstanding_ars,is_authorized`)
  denyValue(cashOff, SUPPLIER_FINANCE, 'override finance=false sobre cashier · deniega')
  expect(JSON.parse(cashOff.text).every(r => r.outstanding_ars === null),
    'override finance=false · sigue siendo NULL, no 0')
  setPerm('cashier', 'NULL')
  expectValue(await request('cashier', `/v_finance_supplier_debt?business_id=eq.${ids.A}&select=outstanding_ars`),
    liveDebt, 'cashier sin override · recupera la deuda')

  // Un payload roto no puede AMPLIAR privilegio.
  setPerm('sales', `'{"finance": "true"}'::jsonb`)
  denyValue(await request('sales', `/supplier_payments?select=amount`), SUPPLIER_FINANCE,
    'override con string en vez de boolean · fail-closed')
  setPerm('sales', 'NULL')

  // ═══ 9. get_finance_charts_l1 — no filtra la deuda real ══════════════════
  const period = [sql(`SELECT (current_date - 30)::text`), sql(`SELECT current_date::text`)]
  const l1Sales = await rpc('sales', 'get_finance_charts_l1',
    { p_business_id: ids.A, p_period_start: period[0], p_period_end: period[1], p_granularity: 'day' })
  denyValue(l1Sales, SUPPLIER_FINANCE, 'sales · get_finance_charts_l1 no filtra la deuda real')
  const l1Cashier = await rpc('cashier', 'get_finance_charts_l1',
    { p_business_id: ids.A, p_period_start: period[0], p_period_end: period[1], p_granularity: 'day' })
  expectOk(l1Cashier, 'cashier · get_finance_charts_l1')
  expect(Number(JSON.parse(l1Cashier.text)?.payables_aging?.total) === liveDebt,
    `cashier · payables_aging.total tiene que ser la deuda REAL ${liveDebt}, llegó ${JSON.parse(l1Cashier.text)?.payables_aging?.total}`)

  // ═══ 10. SEC-08A / SEC-08B no se reabren ═════════════════════════════════
  denyValue(await request('sales', `/inventory?id=eq.${ids.prodA}&select=cost_price`), PROD_COST,
    'SEC-08B · sales sigue sin ver cost_price')
  denyValue(await request('sales', `/inventory?cost_price=eq.${PROD_COST}&select=code`), 'SEC08C-P',
    'SEC-08B · el oráculo por filtro sigue cerrado')
  // El costo del producto YA NO es PROD_COST: la compra canónica que creó
  // `sales` en la sección 5 lo actualizó server-side. Eso es justamente el
  // contrato de SEC-08B funcionando, así que el positivo se toma contra la
  // verdad viva de la base y no contra la constante del fixture.
  const liveCost = sql(`SELECT cost_price::text FROM public.inventory WHERE id='${ids.prodA}';`)
  expect(Number(liveCost) > 0, `el producto tiene que tener un costo real (llegó ${liveCost})`)
  expectValue(await request('manager', `/v_inventory_costs?inventory_id=eq.${ids.prodA}&select=cost_price`),
    Number(liveCost), 'SEC-08B · manager sigue viendo el costo real')
  denyValue(await request('sales', `/v_inventory_costs?inventory_id=eq.${ids.prodA}&select=cost_price`),
    Number(liveCost), 'SEC-08B · sales sigue sin ver el costo, tampoco el que su propia compra estableció')
  const posOwner = await request('owner', `/v_finance_position?business_id=eq.${ids.A}&select=inventory_at_cost,payables`)
  expectOk(posOwner, 'SEC-08B · v_finance_position del owner')
  expect(!/"inventory_at_cost":\s*null/.test(posOwner.text),
    `SEC-08B · el owner conserva inventory_at_cost — ${posOwner.text.slice(0, 200)}`)

  // ═══ 11. CONTROLES NEGATIVOS ═════════════════════════════════════════════
  // Cada frontera se reabre a propósito. Si el testigo NO cruza al reabrirla,
  // la aserción que la protege no estaba probando nada.
  const controls = [
    {
      name: 'NC1 — restaurar la policy vieja de supplier_payments (inventory)',
      open: () => sql(`DROP POLICY IF EXISTS supplier_payments_select ON public.supplier_payments;
                       CREATE POLICY supplier_payments_select ON public.supplier_payments FOR SELECT TO authenticated
                         USING (business_id = public.current_business_id() AND public.current_user_can('inventory'));`),
      probe: () => request('sales', `/supplier_payments?select=amount`),
      witness: PAY_AMOUNT,
      close: () => sql(`DROP POLICY IF EXISTS supplier_payments_select ON public.supplier_payments;
                        CREATE POLICY supplier_payments_select ON public.supplier_payments FOR SELECT TO authenticated
                          USING (business_id = public.current_user_business_id()
                                 AND public.can_view_supplier_finance(business_id));`),
    },
    {
      name: 'NC2 — devolver el CERO falso en la vista de deuda',
      open: () => sql(`CREATE OR REPLACE VIEW public.v_finance_supplier_debt WITH (security_invoker=true) AS
                         SELECT b.id AS business_id, COALESCE(d.outstanding,0)::numeric AS outstanding_ars,
                                COALESCE(d.documents,0)::bigint AS documents, true AS is_authorized
                           FROM public.businesses b
                           LEFT JOIN (SELECT sp.business_id, round(sum(sp.pending_amount),2) AS outstanding,
                                             count(*) AS documents
                                        FROM public.supplier_purchases sp
                                       WHERE sp.pending_amount > 0.01 AND sp.payment_status <> 'paid'
                                       GROUP BY sp.business_id) d ON d.business_id = b.id;`),
      // El testigo del cero falso es el CERO mismo llegándole a `sales`.
      probe: () => request('sales', `/v_finance_supplier_debt?business_id=eq.${ids.A}&select=outstanding_ars`),
      witness: '"outstanding_ars":0',
      close: () => sql(`CREATE OR REPLACE VIEW public.v_finance_supplier_debt WITH (security_invoker=true) AS
                         SELECT b.id AS business_id,
                                CASE WHEN public.can_view_supplier_finance(b.id)
                                     THEN COALESCE(d.outstanding,0)::numeric ELSE NULL::numeric END AS outstanding_ars,
                                CASE WHEN public.can_view_supplier_finance(b.id)
                                     THEN COALESCE(d.documents,0)::bigint ELSE NULL::bigint END AS documents,
                                public.can_view_supplier_finance(b.id) AS is_authorized
                           FROM public.businesses b
                           LEFT JOIN (SELECT sp.business_id, round(sum(sp.pending_amount),2) AS outstanding,
                                             count(*) AS documents
                                        FROM public.supplier_purchases sp
                                       WHERE sp.pending_amount > 0.01 AND sp.payment_status <> 'paid'
                                       GROUP BY sp.business_id) d ON d.business_id = b.id;`),
    },
    {
      name: 'NC3 — abrir el costo crudo de línea al actor de finanzas',
      open: () => sql(`DROP POLICY IF EXISTS supplier_purchase_items_inventory_select ON public.supplier_purchase_items;
                       CREATE POLICY supplier_purchase_items_inventory_select ON public.supplier_purchase_items FOR SELECT TO authenticated
                         USING (business_id = public.current_user_business_id()
                                AND public.can_view_supplier_finance(business_id));`),
      probe: () => request('cashier', `/supplier_purchase_items?select=unit_cost`),
      witness: ITEM_UNIT_COST,
      close: () => sql(`DROP POLICY IF EXISTS supplier_purchase_items_inventory_select ON public.supplier_purchase_items;
                        CREATE POLICY supplier_purchase_items_inventory_select ON public.supplier_purchase_items FOR SELECT TO authenticated
                          USING (business_id = public.current_user_business_id()
                                 AND public.can_view_inventory_cost(business_id));`),
    },
    {
      name: 'NC4 — quitar el predicado de tenant de la deuda agregada',
      open: () => sql(`CREATE OR REPLACE VIEW public.v_finance_supplier_debt WITH (security_invoker=false) AS
                         SELECT b.id AS business_id,
                                COALESCE(d.outstanding,0)::numeric AS outstanding_ars,
                                COALESCE(d.documents,0)::bigint AS documents, true AS is_authorized
                           FROM public.businesses b
                           LEFT JOIN (SELECT sp.business_id, round(sum(sp.pending_amount),2) AS outstanding,
                                             count(*) AS documents
                                        FROM public.supplier_purchases sp
                                       WHERE sp.pending_amount > 0.01 AND sp.payment_status <> 'paid'
                                       GROUP BY sp.business_id) d ON d.business_id = b.id;`),
      probe: () => request('ownerB', `/v_finance_supplier_debt?business_id=eq.${ids.A}&select=outstanding_ars`),
      witness: liveDebt,
      close: () => sql(`CREATE OR REPLACE VIEW public.v_finance_supplier_debt WITH (security_invoker=true) AS
                         SELECT b.id AS business_id,
                                CASE WHEN public.can_view_supplier_finance(b.id)
                                     THEN COALESCE(d.outstanding,0)::numeric ELSE NULL::numeric END AS outstanding_ars,
                                CASE WHEN public.can_view_supplier_finance(b.id)
                                     THEN COALESCE(d.documents,0)::bigint ELSE NULL::bigint END AS documents,
                                public.can_view_supplier_finance(b.id) AS is_authorized
                           FROM public.businesses b
                           LEFT JOIN (SELECT sp.business_id, round(sum(sp.pending_amount),2) AS outstanding,
                                             count(*) AS documents
                                        FROM public.supplier_purchases sp
                                       WHERE sp.pending_amount > 0.01 AND sp.payment_status <> 'paid'
                                       GROUP BY sp.business_id) d ON d.business_id = b.id;`),
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
      `CONTROL NEGATIVO INÚTIL — «${c.name}»: al reabrir, el testigo ${c.witness} NO cruzó (${opened.status} ${opened.text?.slice(0, 250)}). La aserción que protege esta frontera no prueba nada.`)
    c.close()
    sql(`NOTIFY pgrst, 'reload schema';`)
    await new Promise(r => setTimeout(r, 900))
    const closed = await c.probe()
    checks++
    assert(!String(closed.text ?? '').includes(String(c.witness)),
      `«${c.name}»: tras restaurar, el testigo ${c.witness} SIGUE cruzando — ${closed.status} ${closed.text?.slice(0, 250)}`)
    console.log(`  ✓ ${c.name} — cruza al abrir, no cruza al cerrar`)
  }

  // La vista tiene que haber quedado con security_invoker tras los controles.
  expect(sql(`SELECT COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                                WHERE option_name='security_invoker'),'off')
                FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='public' AND c.relname='v_finance_supplier_debt';`) === 'true',
    'tras los controles negativos, v_finance_supplier_debt conserva security_invoker=true')

  console.log(`\nSEC-08C PostgREST OK — ${checks} aserciones sobre ${requests} requests`)
}

const cleanup = () => {
  if (!seeded) return
  try {
    sql(`
      BEGIN;
      SET session_replication_role=replica;
      DELETE FROM public.financial_movements WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.business_finance_entries WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_account_movements WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_payments WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_purchase_items WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_purchases WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.suppliers WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.inventory_movements WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.inventory WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.expenses WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.profiles WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.businesses WHERE id IN ('${ids.A}','${ids.B}');
      DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
      COMMIT;
    `)
  } catch (e) { console.error('cleanup:', e.message) }
}

main().then(() => { cleanup(); process.exit(0) })
  .catch(e => { cleanup(); console.error('\nSEC-08C PostgREST FALLÓ:', e.message); process.exit(1) })
