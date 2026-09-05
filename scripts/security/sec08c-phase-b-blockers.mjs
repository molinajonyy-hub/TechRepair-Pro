#!/usr/bin/env node
// SEC-08C FASE B — REPRODUCCIÓN DE LOS TRES BLOCKERS de la revisión independiente.
//
// Igual que el baseline de la fase A, este script NO prueba que el lote esté
// bien: prueba que los blockers existían. Corre contra la base CON la migración
// 20260918120000 aplicada y SIN la de fase B, y exige que los tres se vean.
// Después de aplicar la fase B este script DEBE fallar.
//
//   B1  autoridad de escritura de pagos incoherente: un actor inventory-only
//       (sin finance, sin costos) crea un PAGO REAL a proveedor —fila, caja y
//       movimiento de cuenta corriente— y después no puede leer nada de eso.
//   B2  payables restringidos siguen resolviendo 0 fabricado en
//       get_finance_charts_l1.
//   B3  un actor finance-only recibe la FILA CRUDA de supplier_purchases,
//       incluidos campos operativos que no son verdad financiera.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
const dbContainer = process.env.SEC08C_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base local')

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
const sql = q => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], q).trim()

const ACTORS = ['owner', 'admin', 'manager', 'sales', 'cashier', 'tech', 'viewer']
const ids = Object.fromEntries([...ACTORS, 'A', 'supA', 'purA'].map(n => [n, randomUUID()]))

// ── Testigos ─────────────────────────────────────────────────────────────────
const SP_TOTAL = 73191, SP_PAID = 21203, SP_PENDING = 51988
const PAY_B1 = 13579                       // pago que crea el actor inventory-only
const PAID_ON_PURCHASE = 24680             // pago incrustado en la creacion de compra
const INVOICE = 'F-08C-SECRETO-31337'      // operativo, NO financiero
const NOTES = 'NOTA-INTERNA-64213'         // operativo
const ATTACH = 'https://x.invalid/ADJUNTO-70118'  // operativo
const METHOD = 'transferencia'
const OPERATIONAL = [INVOICE, NOTES, ATTACH]
const TAG = 'sec08c-fb.invalid'

let seeded = false, checks = 0
const found = []

const main = async () => {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  const apiUrl = `http://127.0.0.1:${hostPort}/rest/v1`
  let signingKey = Buffer.from(vars.PGRST_JWT_SECRET)
  if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
    const k = JSON.parse(vars.PGRST_JWT_SECRET).keys.find(x => x.kty === 'oct')
    signingKey = Buffer.from(k.k, 'base64url')
  }
  const token = a => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const c = Buffer.from(JSON.stringify({ role: 'authenticated', aud: 'authenticated', sub: ids[a], exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url')
    return `${h}.${c}.${createHmac('sha256', signingKey).update(`${h}.${c}`).digest('base64url')}`
  }
  const request = async (a, path, init) => {
    const r = await fetch(apiUrl + path, {
      method: init?.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(a ? { Authorization: `Bearer ${token(a)}` } : {}) },
      body: init?.body, signal: AbortSignal.timeout(20000),
    })
    return { status: r.status, text: await r.text() }
  }
  const rpc = (a, fn, args) => request(a, `/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })
  const leaks = (res, needle, label) => {
    checks++
    assert(String(res.text ?? '').includes(String(needle)),
      `NO SE REPRODUJO «${label}»: el testigo ${needle} no cruzó — ${res.status} ${res.text?.slice(0, 250)}`)
    found.push(`${label} · testigo ${needle}`)
  }
  const expect = (c, l) => { checks++; assert(c, l) }

  const profiles = ACTORS.map(n => `('${ids[n]}','${ids.A}','${n}',true,'${n}@${TAG}')`).join(',')
  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ${ACTORS.map(n => `('${ids[n]}','${n}@${TAG}',now())`).join(',')};
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status)
      VALUES ('${ids.A}','B-FB','${ids.owner}','pro','active');
    INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES ${profiles};
    INSERT INTO public.suppliers(id,business_id,name,active) VALUES ('${ids.supA}','${ids.A}','Prov-FB',true);
    INSERT INTO public.supplier_purchases(id,business_id,supplier_id,purchase_date,invoice_number,total_amount,paid_amount,pending_amount,payment_status,notes,attachment_url,created_by)
      VALUES ('${ids.purA}','${ids.A}','${ids.supA}',current_date,'${INVOICE}',${SP_TOTAL},${SP_PAID},${SP_PENDING},'partial','${NOTES}','${ATTACH}','${ids.owner}');
    COMMIT;
  `)
  seeded = true

  // ═══ BLOCKER 1 — autoridad de escritura de pagos ═════════════════════════
  // `sales`: inventory=true, finance=false, inventory_view_costs=false.
  const before = sql(`SELECT count(*) FROM public.supplier_payments WHERE business_id='${ids.A}';`)
  const paid = await rpc('sales', 'pay_supplier_free_atomic', {
    p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids.sales,
    p_supplier_name: 'Prov-FB', p_payment_date: sql(`SELECT current_date::text`),
    p_amount: PAY_B1, p_payment_method: METHOD, p_notes: 'b1', p_idempotency_key: null,
  })
  expect(paid.status === 200 && JSON.parse(paid.text)?.ok === true,
    `B1 NO SE REPRODUJO: sales no pudo crear el pago — ${paid.status} ${paid.text.slice(0, 250)}`)
  const paymentId = JSON.parse(paid.text).payment_id

  // El pago es REAL: fila, cuenta corriente y movimiento financiero.
  expect(sql(`SELECT count(*) FROM public.supplier_payments WHERE id='${paymentId}';`) === '1',
    'B1: el pago quedó escrito en supplier_payments')
  expect(Number(sql(`SELECT count(*) FROM public.supplier_payments WHERE business_id='${ids.A}';`)) > Number(before),
    'B1: la cantidad de pagos aumentó')
  expect(sql(`SELECT count(*) FROM public.supplier_account_movements WHERE payment_id='${paymentId}';`) === '1',
    'B1: el pago movió la cuenta corriente del proveedor')
  expect(Number(sql(`SELECT count(*) FROM public.financial_movements WHERE business_id='${ids.A}' AND amount_ars=${PAY_B1};`)) >= 1,
    'B1: el pago impactó el libro de caja/tesorería')
  found.push(`B1 · sales (inventory-only) CREA un pago real de ${PAY_B1}: supplier_payments + cuenta corriente + financial_movements`)

  // …y no puede leer NADA de lo que acaba de escribir. Ésa es la incoherencia.
  for (const [label, path] of [
    ['el pago que creó', `/supplier_payments?id=eq.${paymentId}&select=amount`],
    ['la cuenta corriente', `/supplier_account_movements?payment_id=eq.${paymentId}&select=debit,credit,balance_after`],
  ]) {
    const r = await request('sales', path)
    expect(!String(r.text).includes(String(PAY_B1)),
      `B1: sales NO debería poder leer ${label} — ${r.text.slice(0, 200)}`)
  }
  found.push('B1 · …y después NO puede leer ese pago ni el movimiento de cuenta corriente')

  // Y el MISMO actor mueve caja por la puerta de la creación de compra.
  const created = await rpc('sales', 'create_supplier_purchase_atomic', {
    p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids.sales,
    p_supplier_name: 'Prov-FB', p_purchase_date: sql(`SELECT current_date::text`),
    p_invoice_number: 'F-FB-2', p_total_amount: 90000, p_paid_amount: PAID_ON_PURCHASE,
    p_payment_method: METHOD, p_notes: 'b1b',
    p_items: [{ inventory_id: null, product_name: 'l', quantity: 1, unit_cost: 90000 }],
    p_idempotency_key: null,
  })
  expect(created.status === 200 && JSON.parse(created.text)?.ok === true,
    `B1b: la compra con pago inicial tenía que crearse — ${created.text.slice(0, 250)}`)
  expect(Number(sql(`SELECT count(*) FROM public.supplier_payments WHERE business_id='${ids.A}' AND amount=${PAID_ON_PURCHASE};`)) === 1,
    'B1b: la compra con p_paid_amount>0 creó un supplier_payment')
  expect(Number(sql(`SELECT count(*) FROM public.financial_movements WHERE business_id='${ids.A}' AND amount_ars=${PAID_ON_PURCHASE};`)) >= 1,
    'B1b: esa compra movió caja')
  found.push(`B1b · el mismo actor mueve caja por create_supplier_purchase_atomic con p_paid_amount=${PAID_ON_PURCHASE}`)

  // ═══ BLOCKER 2 — payables restringidos → 0 fabricado ═════════════════════
  const period = [sql(`SELECT (current_date - 30)::text`), sql(`SELECT current_date::text`)]
  const l1 = await rpc('sales', 'get_finance_charts_l1',
    { p_business_id: ids.A, p_period_start: period[0], p_period_end: period[1], p_granularity: 'day' })
  expect(l1.status === 200, `B2: get_finance_charts_l1 respondió ${l1.status}`)
  const aging = JSON.parse(l1.text)?.payables_aging
  expect(Number(aging?.total) === 0,
    `B2 NO SE REPRODUJO: se esperaba total=0 fabricado para un actor sin autoridad, llegó ${JSON.stringify(aging)}`)
  const realDebt = sql(`SELECT round(sum(pending_amount),2)::text FROM public.supplier_purchases
                         WHERE business_id='${ids.A}' AND pending_amount > 0.01 AND payment_status <> 'paid';`)
  expect(Number(realDebt) > 0, 'B2: la deuda real del fixture tiene que ser distinta de cero')
  expect(aging?.is_authorized === undefined,
    'B2: hoy el payload NO trae ninguna señal de autorización')
  found.push(`B2 · get_finance_charts_l1.payables_aging.total = 0 con deuda real ${realDebt}, y sin is_authorized`)

  // ═══ BLOCKER 3 — finance-only recibe la fila CRUDA ═══════════════════════
  const raw = await request('cashier', `/supplier_purchases?id=eq.${ids.purA}&select=*`)
  leaks(raw, INVOICE, 'B3 · cashier (finance-only) recibe invoice_number por select=*')
  leaks(raw, NOTES, 'B3 · …y las notas internas')
  leaks(raw, ATTACH, 'B3 · …y la URL del adjunto')
  leaks(await request('cashier', `/supplier_purchases?select=notes,attachment_url,invoice_number,created_by`),
    NOTES, 'B3 · pidiendo las columnas operativas explícitamente')
  // ORÁCULOS sobre campos operativos.
  leaks(await request('cashier', `/supplier_purchases?notes=eq.${encodeURIComponent(NOTES)}&select=id`),
    ids.purA, 'B3 · ORÁCULO por filtro ?notes=eq.')
  leaks(await request('cashier', `/supplier_purchases?select=id&order=invoice_number.desc`),
    ids.purA, 'B3 · ORÁCULO por ORDER BY invoice_number')
  leaks(await request('cashier', `/supplier_purchases?select=created_by`),
    ids.owner, 'B3 · created_by (identidad del operador)')

  console.log('\n────────── BLOCKERS REPRODUCIDOS ──────────')
  for (const f of found) console.log('  ' + f)
  console.log(`\nSEC-08C fase B: ${found.length} hallazgos, ${checks} aserciones`)
}

const cleanup = () => {
  if (!seeded) return
  try {
    sql(`
      BEGIN;
      SET session_replication_role=replica;
      DELETE FROM public.financial_movements WHERE business_id='${ids.A}';
      DELETE FROM public.business_finance_entries WHERE business_id='${ids.A}';
      DELETE FROM public.supplier_account_movements WHERE business_id='${ids.A}';
      DELETE FROM public.supplier_payments WHERE business_id='${ids.A}';
      DELETE FROM public.supplier_purchase_items WHERE business_id='${ids.A}';
      DELETE FROM public.supplier_purchases WHERE business_id='${ids.A}';
      DELETE FROM public.suppliers WHERE business_id='${ids.A}';
      DELETE FROM public.expenses WHERE business_id='${ids.A}';
      DELETE FROM public.inventory_movements WHERE business_id='${ids.A}';
      DELETE FROM public.inventory WHERE business_id='${ids.A}';
      DELETE FROM public.profiles WHERE business_id='${ids.A}';
      DELETE FROM public.businesses WHERE id='${ids.A}';
      DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
      COMMIT;
    `)
  } catch (e) { console.error('cleanup:', e.message) }
}

main().then(() => { cleanup(); process.exit(0) })
  .catch(e => { cleanup(); console.error('\nSEC-08C fase B NO SE REPRODUJO:', e.message); process.exit(1) })
