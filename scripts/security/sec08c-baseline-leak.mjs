#!/usr/bin/env node
// SEC-08C — REPRODUCCIÓN DEL DEFECTO, medida por HTTP contra el PostgREST local.
//
// Este script NO prueba que el lote esté bien: prueba que el lote hacía falta.
// Corre contra la base SIN la migración de SEC-08C y exige que cada fuga y cada
// cero falso SE VEAN. Si alguna aserción de acá falla, el defecto no existe tal
// como se lo describió y hay que revisar el enunciado antes de escribir código.
//
// Cubre los cinco defectos del enunciado:
//   A — FinanceDashboard: deuda real != 0 y el actor de finanzas resuelve 0.
//   B — getSuppliersWithStats: stats financieras calculadas en el browser.
//   C — lecturas crudas de compra/línea de compra.
//   D — supplier_payments.select('*').
//   E — supplier_account_movements.select('*').
//
// Se ejecuta con `npm run sec08c:baseline`. Tras aplicar SEC-08C este script
// DEBE fallar: eso es exactamente lo que certifica que la frontera se cerró.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')
const dbContainer = process.env.SEC08C_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base local')

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
const sql = q => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], q).trim()

const ACTORS = ['owner', 'admin', 'manager', 'sales', 'cashier', 'tech', 'viewer', 'ownerB']
const ids = Object.fromEntries(
  [...ACTORS, 'A', 'B', 'supA', 'supA2', 'supB', 'purA', 'purA2', 'purB', 'payA', 'payB', 'movA']
    .map(n => [n, randomUUID()]))

// ── Testigos: ni 0, ni redondos, ni iguales entre sí ─────────────────────────
const SP_TOTAL = 73191
const SP_PAID = 21203
const SP_PENDING = 51988
const SP2_TOTAL = 45613
const SP2_PAID = 15206
const SP2_PENDING = 30407
const DEBT_TOTAL = SP_PENDING + SP2_PENDING   // 82395 — deuda canónica del tenant A
const PAY_AMOUNT = 11837
const ITEM_UNIT_COST = 4173
const ITEM_SUBTOTAL = 12519
const MOV_DEBIT = 68429
const MOV_CREDIT = 39157
const MOV_BALANCE = 29272
const B_PENDING = 90211
const B_PAY = 90212
const TAG = 'sec08c-base.invalid'

let seeded = false, requests = 0, checks = 0
const found = []

const main = async () => {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuración de PostgREST local')

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
  // Un LEAK reproducido: el testigo TIENE que cruzar. Si no cruza, el defecto no
  // es el que se describió.
  const leaks = (res, needle, label) => {
    checks++
    assert(String(res.text ?? '').includes(String(needle)),
      `NO SE REPRODUJO «${label}»: el testigo ${needle} no cruzó — ${res.status} ${res.text?.slice(0, 250)}`)
    found.push(`FUGA   · ${label} · testigo ${needle}`)
  }
  // Un CERO FALSO reproducido: la verdad real no es 0, y el actor recibe 0/vacío.
  const falseZero = (res, label, realValue) => {
    checks++
    const t = String(res.text ?? '')
    assert(!t.includes(String(realValue)),
      `«${label}»: el valor real ${realValue} SÍ llegó, no hay cero falso — ${t.slice(0, 250)}`)
    found.push(`CERO   · ${label} · real=${realValue}, el actor recibe vacío/0`)
  }

  // ── Fixture ────────────────────────────────────────────────────────────────
  const users = ACTORS.map(n => `('${ids[n]}','${n}@${TAG}',now())`).join(',')
  const profiles = ACTORS.map(n =>
    `('${ids[n]}','${n === 'ownerB' ? ids.B : ids.A}','${n === 'ownerB' ? 'owner' : n}',true,'${n}@${TAG}')`).join(',')

  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ${users};
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
      ('${ids.A}','B-A','${ids.owner}','pro','active'),
      ('${ids.B}','B-B','${ids.ownerB}','pro','active');
    INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES ${profiles};

    INSERT INTO public.suppliers(id,business_id,name,phone,email,active) VALUES
      ('${ids.supA}','${ids.A}','Prov-Uno','1131110001','uno@${TAG}',true),
      ('${ids.supA2}','${ids.A}','Prov-Dos','1131110002','dos@${TAG}',true),
      ('${ids.supB}','${ids.B}','Prov-Ajeno','1131110003','b@${TAG}',true);

    INSERT INTO public.supplier_purchases(id,business_id,supplier_id,purchase_date,invoice_number,total_amount,paid_amount,pending_amount,payment_status) VALUES
      ('${ids.purA}','${ids.A}','${ids.supA}',current_date,'F-08C-1',${SP_TOTAL},${SP_PAID},${SP_PENDING},'partial'),
      ('${ids.purA2}','${ids.A}','${ids.supA2}',current_date,'F-08C-2',${SP2_TOTAL},${SP2_PAID},${SP2_PENDING},'partial'),
      ('${ids.purB}','${ids.B}','${ids.supB}',current_date,'F-08C-B',${B_PENDING},0,${B_PENDING},'pending');

    INSERT INTO public.supplier_purchase_items(id,business_id,purchase_id,supplier_id,inventory_id,product_name,quantity,unit_cost,subtotal) VALUES
      (gen_random_uuid(),'${ids.A}','${ids.purA}','${ids.supA}',NULL,'linea-08c',3,${ITEM_UNIT_COST},${ITEM_SUBTOTAL});

    INSERT INTO public.supplier_payments(id,business_id,supplier_id,purchase_id,payment_date,amount,payment_method,notes) VALUES
      ('${ids.payA}','${ids.A}','${ids.supA}','${ids.purA}',current_date,${PAY_AMOUNT},'transferencia','pago-08c'),
      ('${ids.payB}','${ids.B}','${ids.supB}',NULL,current_date,${B_PAY},'efectivo','pago-08c-B');

    INSERT INTO public.supplier_account_movements(id,business_id,supplier_id,purchase_id,payment_id,movement_date,type,description,debit,credit,balance_after) VALUES
      ('${ids.movA}','${ids.A}','${ids.supA}','${ids.purA}',NULL,current_date,'purchase','mov-08c',${MOV_DEBIT},${MOV_CREDIT},${MOV_BALANCE});
    COMMIT;
  `)
  seeded = true

  // La verdad canónica del tenant A NO es cero. Sin esto, todo lo de abajo
  // sería un test que confunde «no hay deuda» con «no se puede ver la deuda».
  const realDebt = sql(`SELECT round(sum(pending_amount),0)::text FROM public.supplier_purchases
                         WHERE business_id='${ids.A}' AND payment_status <> 'paid';`)
  checks++
  assert(realDebt === String(DEBT_TOTAL), `La deuda real sembrada tiene que ser ${DEBT_TOTAL}, es ${realDebt}`)
  console.log(`\nDeuda de proveedores REAL del tenant A = ${DEBT_TOTAL} (no es cero)\n`)

  // ═══ DEFECTO D — supplier_payments.select('*') ════════════════════════════
  // `sales` es un actor OPERATIVO: inventory=true, inventory_view_costs=false,
  // finance=false. No tiene ninguna autoridad financiera y aun así recibe el
  // importe de los pagos a proveedores.
  leaks(await request('sales', `/supplier_payments?select=*`),
    PAY_AMOUNT, 'D · sales (sin finance) lee supplier_payments.amount con select=*')
  leaks(await request('sales', `/supplier_payments?select=amount,payment_date,payment_method`),
    PAY_AMOUNT, 'D · sales pide la columna de importe explícitamente')
  // ORÁCULOS: aunque se ocultara la columna, el filtro y el ORDER BY la infieren.
  leaks(await request('sales', `/supplier_payments?amount=eq.${PAY_AMOUNT}&select=id`),
    ids.payA, 'D · ORÁCULO por filtro ?amount=eq.')
  leaks(await request('sales', `/supplier_payments?select=id&order=amount.desc`),
    ids.payA, 'D · ORÁCULO por ORDER BY amount')
  for (const a of ['tech', 'viewer']) {
    const r = await request(a, `/supplier_payments?select=amount`)
    checks++
    if (String(r.text).includes(String(PAY_AMOUNT))) found.push(`FUGA   · D · ${a} lee supplier_payments.amount`)
  }

  // ═══ DEFECTO E — supplier_account_movements.select('*') ═══════════════════
  leaks(await request('sales', `/supplier_account_movements?select=*`),
    MOV_DEBIT, 'E · sales lee supplier_account_movements.debit')
  leaks(await request('sales', `/supplier_account_movements?select=debit,credit,balance_after`),
    MOV_BALANCE, 'E · sales lee el SALDO de cuenta corriente del proveedor')
  leaks(await request('sales', `/supplier_account_movements?select=credit`),
    MOV_CREDIT, 'E · sales lee el haber de la cuenta corriente')
  leaks(await request('sales', `/supplier_account_movements?balance_after=eq.${MOV_BALANCE}&select=id`),
    ids.movA, 'E · ORÁCULO por filtro ?balance_after=eq.')

  // ═══ DEFECTO A — el cero falso de FinanceDashboard ════════════════════════
  // `cashier` es el actor de FINANZAS del producto (finance=true por defecto).
  // Es exactamente quien mira la tarjeta «Deuda proveedores». La consulta que
  // hoy hace el dashboard, hecha por él, resuelve a lista vacía → reduce() → 0.
  const dashQuery = `/supplier_purchases?business_id=eq.${ids.A}&payment_status=neq.paid&select=pending_amount`
  const cashierDash = await request('cashier', dashQuery)
  falseZero(cashierDash, 'A · cashier (finance=true) ejecuta la consulta del FinanceDashboard', SP_PENDING)
  checks++
  assert(cashierDash.status === 200 && cashierDash.text.trim() === '[]',
    `A · la consulta del dashboard tiene que devolver 200 [] (no un error visible) — ${cashierDash.status} ${cashierDash.text.slice(0, 200)}`)
  // Y esto es lo que hace el componente con esa respuesta:
  const rendered = JSON.parse(cashierDash.text).reduce((s, r) => s + (r.pending_amount || 0), 0)
  checks++
  assert(rendered === 0, `A · el reduce del dashboard tiene que dar 0, dio ${rendered}`)
  found.push(`CERO   · A · el FinanceDashboard renderiza "Deuda proveedores $${rendered}" con deuda real ${DEBT_TOTAL}`)
  console.log(`  DEFECTO A reproducido: reduce() del dashboard = ${rendered} · deuda real = ${DEBT_TOTAL}`)

  // El agregado canónico de finanzas arrastra el mismo cero, y encima lo
  // fabrica el SERVIDOR con COALESCE, que es peor: llega como número, no como
  // ausencia. `payables_aging.total` sale 0 para el actor de finanzas.
  const aging = await request('cashier', `/v_finance_payables_aging?business_id=eq.${ids.A}&select=bucket,amount`)
  falseZero(aging, 'A · cashier sobre v_finance_payables_aging', SP_PENDING)
  const l1 = await request('cashier',
    `/rpc/get_finance_charts_l1?p_business_id=${ids.A}&p_period_start=${sql(`SELECT (current_date - 30)::text`)}&p_period_end=${sql(`SELECT current_date::text`)}&p_granularity=day`)
  checks++
  if (l1.status === 200) {
    const total = JSON.parse(l1.text)?.payables_aging?.total
    assert(String(total) === '0' || total === 0,
      `A · get_finance_charts_l1 tenía que devolver payables_aging.total = 0 para el cashier, devolvió ${total}`)
    found.push(`CERO   · A · get_finance_charts_l1.payables_aging.total = ${total} (servidor, COALESCE) con deuda real ${DEBT_TOTAL}`)
    console.log(`  DEFECTO A (RPC canónica) reproducido: payables_aging.total = ${total}`)
  }

  // ═══ DEFECTO B — stats de proveedor calculadas en el browser ══════════════
  // La forma exacta de getSuppliersWithStats(). Para `manager` cruzan los
  // importes; para `sales` el embed viene vacío y las stats salen en 0 sin que
  // nada avise (segundo cero falso, esta vez en el listado de proveedores).
  const statsShape = `/suppliers?business_id=eq.${ids.A}&select=*,supplier_purchases(total_amount,paid_amount,pending_amount,purchase_date)`
  leaks(await request('manager', statsShape), SP_TOTAL, 'B · manager recibe los importes de compra en el embed del listado')
  const salesStats = await request('sales', statsShape)
  falseZero(salesStats, 'B · sales recibe el listado con el embed financiero VACÍO', SP_TOTAL)
  checks++
  assert(salesStats.text.includes('Prov-Uno'), 'B · el listado operativo sí tiene que llegar para sales')
  const salesAgg = JSON.parse(salesStats.text).map(s => (s.supplier_purchases || [])
    .reduce((n, p) => n + (p.pending_amount || 0), 0))
  checks++
  assert(salesAgg.every(v => v === 0), `B · las stats del listado tenían que dar 0 para sales, dieron ${JSON.stringify(salesAgg)}`)
  found.push(`CERO   · B · getSuppliersWithStats() muestra pending_amount 0 a sales con deuda real ${DEBT_TOTAL}`)
  // …y el actor de finanzas no puede ni listar proveedores.
  const cashierList = await request('cashier', `/suppliers?business_id=eq.${ids.A}&select=id,name`)
  checks++
  assert(cashierList.text.trim() === '[]',
    `B · cashier no debería poder listar proveedores hoy — ${cashierList.status} ${cashierList.text.slice(0, 200)}`)
  found.push(`CERO   · B · cashier (finance) no puede listar proveedores: recibe []`)

  // ═══ DEFECTO C — lecturas crudas de compra / línea de compra ══════════════
  const rawShape = `/supplier_purchases?supplier_id=eq.${ids.supA}&select=*,items:supplier_purchase_items(*)`
  const mgrRaw = await request('manager', rawShape)
  leaks(mgrRaw, SP_TOTAL, 'C · manager: select(*) de compra trae total_amount')
  leaks(mgrRaw, SP_PENDING, 'C · select(*) de compra trae pending_amount')
  leaks(mgrRaw, ITEM_UNIT_COST, 'C · el embed de líneas trae unit_cost (reconstruye costo de inventario)')
  leaks(mgrRaw, ITEM_SUBTOTAL, 'C · el embed de líneas trae subtotal')
  // El cashier — actor de FINANZAS — no puede ver ni la cabecera financiera.
  falseZero(await request('cashier', rawShape), 'C · cashier (finance) sobre la compra cruda', SP_TOTAL)

  // ═══ Grants a anon: RLS los tapa hoy, pero el GRANT no debería existir ════
  const anonGrants = sql(`SELECT string_agg(table_name,',' ORDER BY table_name)
                            FROM information_schema.role_table_grants
                           WHERE table_schema='public' AND grantee='anon'
                             AND table_name IN ('supplier_payments','supplier_account_movements');`)
  checks++
  assert(anonGrants === 'supplier_account_movements,supplier_payments',
    `Se esperaba el GRANT residual a anon sobre las dos tablas, hay: ${anonGrants}`)
  found.push(`GRANT  · anon conserva SELECT sobre supplier_payments y supplier_account_movements (hoy tapado por RLS)`)
  for (const p of ['/supplier_payments?select=amount', '/supplier_account_movements?select=debit']) {
    const r = await request(null, p)
    checks++
    assert(!r.text.includes(String(PAY_AMOUNT)) && !r.text.includes(String(MOV_DEBIT)),
      `anon NO debería alcanzar el dato hoy — ${p} ${r.status} ${r.text.slice(0, 150)}`)
  }

  // ═══ Cross-tenant: lo que HOY ya está bien, para no romperlo después ══════
  for (const [label, path] of [
    ['pagos del tenant ajeno', `/supplier_payments?select=amount`],
    ['cuenta corriente ajena', `/supplier_account_movements?select=debit,balance_after`],
    ['compras ajenas', `/supplier_purchases?select=pending_amount`],
  ]) {
    const r = await request('ownerB', path)
    checks++
    assert(!r.text.includes(String(PAY_AMOUNT)) && !r.text.includes(String(MOV_DEBIT)) && !r.text.includes(String(SP_PENDING)),
      `CROSS-TENANT ya roto en baseline · ${label} — ${r.text.slice(0, 200)}`)
    const rA = await request('owner', path)
    checks++
    assert(!rA.text.includes(String(B_PENDING)) && !rA.text.includes(String(B_PAY)),
      `CROSS-TENANT ya roto en baseline · owner de A ve datos de B · ${label} — ${rA.text.slice(0, 200)}`)
  }

  console.log('\n────────── DEFECTOS REPRODUCIDOS ──────────')
  for (const f of found) console.log('  ' + f)
  console.log(`\nSEC-08C baseline: ${found.length} hallazgos, ${checks} aserciones sobre ${requests} requests`)
}

const cleanup = () => {
  if (!seeded) return
  try {
    sql(`
      BEGIN;
      SET session_replication_role=replica;
      DELETE FROM public.supplier_account_movements WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_payments WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_purchase_items WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.supplier_purchases WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.suppliers WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.profiles WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.businesses WHERE id IN ('${ids.A}','${ids.B}');
      DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
      COMMIT;
    `)
  } catch (e) { console.error('cleanup:', e.message) }
}

main().then(() => { cleanup(); process.exit(0) })
  .catch(e => { cleanup(); console.error('\nSEC-08C baseline NO SE REPRODUJO:', e.message); process.exit(1) })
