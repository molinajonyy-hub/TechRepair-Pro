#!/usr/bin/env node
// SEC-08C FASE B — contrato de las tres correcciones, medido por HTTP.
//
//   B1  pagar a un proveedor exige `finance`. Se verifica el EFECTO, no sólo el
//       código: tras una denegación no puede quedar fila de pago, ni movimiento
//       de cuenta corriente, ni asiento de caja, ni cambio en el saldo de la
//       compra. Y la excepción ratificada de SEC-08B —comprar A CRÉDITO con
//       `inventory`— tiene que seguir viva.
//   B2  payables restringidos llegan como NULL con is_authorized=false, nunca
//       como 0. Tres estados: cero real, distinto de cero autorizado, y
//       restringido.
//   B3  un actor finance-only recibe los importes por la proyección y NUNCA los
//       campos operativos de supplier_purchases, ni por proyección, ni por
//       filtro, ni por ORDER BY.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
const dbContainer = process.env.SEC08C_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base local')
const MIGRATION = 'supabase/migrations/20260919120000_sec08c_b_payment_authority_and_finance_projection.sql'

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
const sql = q => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], q).trim()

const ACTORS = ['owner', 'admin', 'manager', 'sales', 'cashier', 'tech', 'viewer', 'inactive', 'ownerB']
const ids = Object.fromEntries(
  [...ACTORS, 'A', 'B', 'supA', 'supB', 'purA', 'purZero', 'purB', 'bizZero', 'ownerZero']
    .map(n => [n, randomUUID()]))

// ── Testigos ─────────────────────────────────────────────────────────────────
const SP_TOTAL = 73191, SP_PAID = 21203, SP_PENDING = 51988
const INVOICE = 'F-08C-SECRETO-31337'
const NOTES = 'NOTA-INTERNA-64213'
const ATTACH = 'https://x.invalid/ADJUNTO-70118'
const OPERATIONAL = [INVOICE, NOTES, ATTACH]
const PAY_TRY = 13579          // pago que los NO autorizados intentan
const PAY_OK = 46281           // pago que el actor de finanzas sí hace
const CREDIT_TOTAL = 58024     // compra A CRÉDITO (paid = 0)
const CASH_ON_PURCHASE = 24680 // compra CON pago inicial
const B_PENDING = 90211
const METHOD = 'transferencia'
const TAG = 'sec08c-fbc.invalid'

let seeded = false, checks = 0, requests = 0

const main = async () => {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuración de PostgREST local')
  assert(sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='finance_supplier_purchases';`) === '1',
    `La fase B no está aplicada en la base local (aplicá ${MIGRATION})`)

  const apiUrl = `http://127.0.0.1:${hostPort}/rest/v1`
  let signingKey = Buffer.from(vars.PGRST_JWT_SECRET)
  if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
    const k = JSON.parse(vars.PGRST_JWT_SECRET).keys.find(x => x.kty === 'oct')
    signingKey = Buffer.from(k.k, 'base64url')
  }
  const token = a => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const claims = { role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 900 }
    if (a) claims.sub = ids[a]
    const c = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${h}.${c}.${createHmac('sha256', signingKey).update(`${h}.${c}`).digest('base64url')}`
  }
  const request = async (a, path, init) => {
    requests++
    const r = await fetch(apiUrl + path, {
      method: init?.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(a ? { Authorization: `Bearer ${token(a)}` } : {}) },
      body: init?.body, signal: AbortSignal.timeout(20000),
    })
    return { status: r.status, text: await r.text() }
  }
  const rpc = (a, fn, args) => request(a, `/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })
  const expect = (c, l) => { checks++; assert(c, l) }
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
  const setPerm = (who, json) => sql(`UPDATE public.profiles SET permissions=${json} WHERE id='${ids[who]}';`)
  const today = sql(`SELECT current_date::text`)

  // ── Fixture ────────────────────────────────────────────────────────────────
  const profiles = ACTORS.map(n =>
    `('${ids[n]}','${n === 'ownerB' ? ids.B : ids.A}','${n === 'ownerB' ? 'owner' : n === 'inactive' ? 'admin' : n}',${n === 'inactive' ? 'false' : 'true'},'${n}@${TAG}')`).join(',')
  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
      ${ACTORS.map(n => `('${ids[n]}','${n}@${TAG}',now())`).join(',')},
      ('${ids.ownerZero}','zero@${TAG}',now());
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
      ('${ids.A}','B-A','${ids.owner}','pro','active'),
      ('${ids.B}','B-B','${ids.ownerB}','pro','active'),
      ('${ids.bizZero}','B-ZERO','${ids.ownerZero}','pro','active');
    INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES ${profiles},
      ('${ids.ownerZero}','${ids.bizZero}','owner',true,'zero@${TAG}');
    INSERT INTO public.suppliers(id,business_id,name,active) VALUES
      ('${ids.supA}','${ids.A}','Prov-Uno',true),
      ('${ids.supB}','${ids.B}','Prov-Ajeno',true);
    -- Compra con deuda REAL y con campos OPERATIVOS distintivos.
    INSERT INTO public.supplier_purchases(id,business_id,supplier_id,purchase_date,invoice_number,total_amount,paid_amount,pending_amount,payment_status,notes,attachment_url,created_by) VALUES
      ('${ids.purA}','${ids.A}','${ids.supA}',current_date,'${INVOICE}',${SP_TOTAL},${SP_PAID},${SP_PENDING},'partial','${NOTES}','${ATTACH}','${ids.owner}'),
      ('${ids.purB}','${ids.B}','${ids.supB}',current_date,'F-B',${B_PENDING},0,${B_PENDING},'pending','n','a','${ids.ownerB}');
    -- Un negocio con deuda REALMENTE cero: el tercer estado de la ley.
    INSERT INTO public.supplier_purchases(id,business_id,supplier_id,purchase_date,total_amount,paid_amount,pending_amount,payment_status)
      VALUES ('${ids.purZero}','${ids.bizZero}','${ids.supA}',current_date,1000,1000,0,'paid');
    COMMIT;
  `)
  seeded = true

  // ═══ B1 · AUTORIDAD DE ESCRITURA DE PAGOS ════════════════════════════════
  console.log('\n── B1 · pagar exige finance ──')
  const ledgerCount = () => ({
    pagos: sql(`SELECT count(*) FROM public.supplier_payments WHERE business_id='${ids.A}';`),
    cc: sql(`SELECT count(*) FROM public.supplier_account_movements WHERE business_id='${ids.A}';`),
    fm: sql(`SELECT count(*) FROM public.financial_movements WHERE business_id='${ids.A}';`),
    saldo: sql(`SELECT pending_amount::text FROM public.supplier_purchases WHERE id='${ids.purA}';`),
  })

  // Actores SIN finance: denegados, y sin dejar rastro en ningún libro.
  for (const actor of ['sales', 'manager', 'tech', 'viewer', 'inactive']) {
    const antes = ledgerCount()
    const r = await rpc(actor, 'pay_supplier_free_atomic', {
      p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids[actor],
      p_supplier_name: 'Prov-Uno', p_payment_date: today, p_amount: PAY_TRY,
      p_payment_method: METHOD, p_notes: 'b1', p_idempotency_key: null,
    })
    expect(r.status >= 400 || JSON.parse(r.text)?.ok !== true,
      `${actor} (sin finance) · pago DENEGADO — ${r.status} ${r.text.slice(0, 200)}`)
    const despues = ledgerCount()
    expect(despues.pagos === antes.pagos, `${actor} · no quedó fila en supplier_payments`)
    expect(despues.cc === antes.cc, `${actor} · no quedó movimiento de cuenta corriente`)
    expect(despues.fm === antes.fm, `${actor} · no quedó asiento en financial_movements`)
    expect(despues.saldo === antes.saldo, `${actor} · el saldo de la compra no cambió`)
    // Contra una compra concreta, lo mismo.
    const r2 = await rpc(actor, 'pay_supplier_purchase_atomic', {
      p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids[actor],
      p_supplier_name: 'Prov-Uno', p_purchase_id: ids.purA, p_payment_date: today,
      p_amount: PAY_TRY, p_payment_method: METHOD, p_notes: 'b1', p_idempotency_key: null,
    })
    expect(r2.status >= 400 || JSON.parse(r2.text)?.ok !== true,
      `${actor} · pago contra factura DENEGADO — ${r2.status} ${r2.text.slice(0, 200)}`)
    expect(sql(`SELECT pending_amount::text FROM public.supplier_purchases WHERE id='${ids.purA}';`) === antes.saldo,
      `${actor} · el saldo sigue intacto tras el pago contra factura`)
    console.log(`  ✓ ${actor} — denegado, sin efectos`)
  }
  expect((await rpc(null, 'pay_supplier_free_atomic', {
    p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids.owner, p_supplier_name: 'x',
    p_payment_date: today, p_amount: PAY_TRY, p_payment_method: METHOD, p_notes: 'x', p_idempotency_key: null,
  })).status >= 400, 'anon · pago denegado')

  // El actor de FINANZAS sí puede: sin este positivo, un 403 global pasaría por
  // seguridad cuando en realidad sería la pantalla rota.
  const okPay = await rpc('cashier', 'pay_supplier_free_atomic', {
    p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids.cashier,
    p_supplier_name: 'Prov-Uno', p_payment_date: today, p_amount: PAY_OK,
    p_payment_method: METHOD, p_notes: 'ok', p_idempotency_key: null,
  })
  expect(okPay.status === 200 && JSON.parse(okPay.text)?.ok === true,
    `cashier (finance) · pago PERMITIDO — ${okPay.status} ${okPay.text.slice(0, 300)}`)
  expect(sql(`SELECT count(*) FROM public.supplier_payments WHERE id='${JSON.parse(okPay.text).payment_id}';`) === '1',
    'cashier · el pago quedó escrito')
  console.log('  ✓ cashier — permitido, con efectos reales')

  // IDEMPOTENCIA intacta: misma key dos veces = un solo pago.
  const key = `sec08c-fb-${randomUUID()}`
  const args = {
    p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids.owner,
    p_supplier_name: 'Prov-Uno', p_payment_date: today, p_amount: 3311,
    p_payment_method: METHOD, p_notes: 'idem', p_idempotency_key: key,
  }
  const i1 = await rpc('owner', 'pay_supplier_free_atomic', args)
  const i2 = await rpc('owner', 'pay_supplier_free_atomic', args)
  expect(JSON.parse(i1.text)?.ok === true && JSON.parse(i2.text)?.ok === true, 'idempotencia · las dos llamadas responden ok')
  expect(JSON.parse(i2.text)?.replay === true, 'idempotencia · la segunda es replay')
  expect(sql(`SELECT count(*) FROM public.supplier_payments WHERE business_id='${ids.A}' AND amount=3311;`) === '1',
    'idempotencia · quedó UN solo pago')
  console.log('  ✓ idempotencia intacta')

  // La EXCEPCIÓN RATIFICADA de SEC-08B sigue viva: comprar A CRÉDITO con
  // `inventory`, sin finance y sin poder leer el costo después.
  const credit = await rpc('sales', 'create_supplier_purchase_atomic', {
    p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids.sales,
    p_supplier_name: 'Prov-Uno', p_purchase_date: today, p_invoice_number: 'F-CREDITO',
    p_total_amount: CREDIT_TOTAL, p_paid_amount: 0, p_payment_method: '', p_notes: 'credito',
    p_items: [{ inventory_id: null, product_name: 'l', quantity: 1, unit_cost: CREDIT_TOTAL }],
    p_idempotency_key: null,
  })
  expect(credit.status === 200 && JSON.parse(credit.text)?.ok === true,
    `sales · comprar A CRÉDITO sigue permitido (excepción SEC-08B) — ${credit.status} ${credit.text.slice(0, 300)}`)
  denyValue(await request('sales', `/supplier_purchases?id=eq.${JSON.parse(credit.text).purchase_id}&select=total_amount`),
    CREDIT_TOTAL, 'sales · …y sigue sin poder leer la compra que creó')
  console.log('  ✓ comprar a crédito sigue siendo de inventario')

  // Pero comprar PAGANDO exige además finance: era la puerta de atrás.
  const withCash = await rpc('sales', 'create_supplier_purchase_atomic', {
    p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids.sales,
    p_supplier_name: 'Prov-Uno', p_purchase_date: today, p_invoice_number: 'F-CASH',
    p_total_amount: 90000, p_paid_amount: CASH_ON_PURCHASE, p_payment_method: METHOD, p_notes: 'cash',
    p_items: [{ inventory_id: null, product_name: 'l', quantity: 1, unit_cost: 90000 }],
    p_idempotency_key: null,
  })
  expect(withCash.status >= 400 || JSON.parse(withCash.text)?.ok !== true,
    `sales · comprar CON PAGO INICIAL denegado — ${withCash.status} ${withCash.text.slice(0, 250)}`)
  expect(sql(`SELECT count(*) FROM public.supplier_payments WHERE business_id='${ids.A}' AND amount=${CASH_ON_PURCHASE};`) === '0',
    'sales · la compra con pago no dejó ningún supplier_payment')
  expect(sql(`SELECT count(*) FROM public.financial_movements WHERE business_id='${ids.A}' AND amount_ars=${CASH_ON_PURCHASE};`) === '0',
    'sales · …ni movió caja')
  // …y con finance, la misma llamada procede.
  setPerm('sales', `'{"finance": true}'::jsonb`)
  const withCashOk = await rpc('sales', 'create_supplier_purchase_atomic', {
    p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids.sales,
    p_supplier_name: 'Prov-Uno', p_purchase_date: today, p_invoice_number: 'F-CASH-OK',
    p_total_amount: 90000, p_paid_amount: CASH_ON_PURCHASE, p_payment_method: METHOD, p_notes: 'cash',
    p_items: [{ inventory_id: null, product_name: 'l', quantity: 1, unit_cost: 90000 }],
    p_idempotency_key: null,
  })
  expect(withCashOk.status === 200 && JSON.parse(withCashOk.text)?.ok === true,
    `sales con override finance · la misma compra con pago procede — ${withCashOk.text.slice(0, 250)}`)
  setPerm('sales', 'NULL')
  console.log('  ✓ comprar pagando exige finance (la puerta de atrás quedó cerrada)')

  // Cross-tenant y parámetros forjados.
  for (const [label, a, args2] of [
    ['business_id forjado', 'owner', { p_business_id: ids.B, p_supplier_id: ids.supB }],
    ['supplier ajeno', 'cashier', { p_business_id: ids.A, p_supplier_id: ids.supB }],
  ]) {
    const r = await rpc(a, 'pay_supplier_free_atomic', {
      ...args2, p_user_id: ids[a], p_supplier_name: 'x', p_payment_date: today,
      p_amount: 5501, p_payment_method: METHOD, p_notes: 'x', p_idempotency_key: null,
    })
    expect(r.status >= 400 || JSON.parse(r.text)?.ok !== true, `cross-tenant · ${label} denegado`)
  }
  const foreign = await rpc('cashier', 'pay_supplier_purchase_atomic', {
    p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids.cashier, p_supplier_name: 'x',
    p_purchase_id: ids.purB, p_payment_date: today, p_amount: 5503,
    p_payment_method: METHOD, p_notes: 'x', p_idempotency_key: null,
  })
  expect(foreign.status >= 400 || JSON.parse(foreign.text)?.ok !== true,
    'cross-tenant · pago contra una compra del tenant B denegado')
  expect(sql(`SELECT count(*) FROM public.supplier_payments WHERE amount IN (5501,5503);`) === '0',
    'cross-tenant · ningún pago quedó escrito')
  console.log('  ✓ cross-tenant y parámetros forjados denegados')

  // ═══ B2 · TRES ESTADOS DE PAYABLES ═══════════════════════════════════════
  console.log('\n── B2 · restringido no es cero ──')
  const period = [sql(`SELECT (current_date - 30)::text`), today]
  const l1 = (a, biz) => rpc(a, 'get_finance_charts_l1',
    { p_business_id: biz, p_period_start: period[0], p_period_end: period[1], p_granularity: 'day' })

  // 1) autorizado con deuda REAL distinta de cero
  const liveDebt = Number(sql(`SELECT round(sum(pending_amount),2)::text FROM public.supplier_purchases
                                WHERE business_id='${ids.A}' AND pending_amount > 0.01 AND payment_status <> 'paid';`))
  expect(liveDebt > 0, 'el fixture tiene deuda real distinta de cero')
  const okL1 = JSON.parse((await l1('cashier', ids.A)).text)
  expect(Number(okL1?.payables_aging?.total) === liveDebt,
    `autorizado · total tiene que ser ${liveDebt}, llegó ${okL1?.payables_aging?.total}`)
  expect(okL1?.payables_aging?.is_authorized === true, 'autorizado · is_authorized = true')

  // 2) autorizado con deuda REALMENTE cero → 0 legítimo, no NULL
  const zeroL1 = JSON.parse((await l1('ownerZero', ids.bizZero)).text)
  expect(Number(zeroL1?.payables_aging?.total) === 0, `cero real · total = 0, llegó ${zeroL1?.payables_aging?.total}`)
  expect(zeroL1?.payables_aging?.is_authorized === true, 'cero real · is_authorized = true')
  expect(zeroL1?.payables_aging?.total !== null, 'cero real · NO se convirtió en NULL (sería el error inverso)')

  // 3) restringido → NULL con la razón al lado, jamás 0
  for (const actor of ['sales', 'tech', 'viewer']) {
    const r = await l1(actor, ids.A)
    const ag = JSON.parse(r.text)?.payables_aging
    const du = JSON.parse(r.text)?.payables_due
    expect(ag?.total === null, `${actor} · payables_aging.total NULL, no 0 — llegó ${JSON.stringify(ag)}`)
    expect(ag?.is_authorized === false, `${actor} · is_authorized = false`)
    expect(du?.due_soon_amount === null && du?.overdue_amount === null && du?.undated_amount === null,
      `${actor} · payables_due también en NULL — ${JSON.stringify(du)}`)
    denyValue(r, [SP_PENDING, SP_TOTAL], `${actor} · y nada de la deuda real cruzó`)
  }
  console.log('  ✓ tres estados distinguidos (cero real / autorizado / restringido)')

  // ═══ B3 · FRONTERA DE LA PROYECCIÓN ══════════════════════════════════════
  console.log('\n── B3 · finance-only no recibe la fila cruda ──')
  // La tabla BASE ya no es alcanzable para finance-only.
  for (const [label, path] of [
    ['select=*', `/supplier_purchases?select=*`],
    ['columnas operativas', `/supplier_purchases?select=notes,attachment_url,invoice_number,created_by`],
    ['ORÁCULO ?notes=eq.', `/supplier_purchases?notes=eq.${encodeURIComponent(NOTES)}&select=id`],
    ['ORÁCULO ?invoice_number=eq.', `/supplier_purchases?invoice_number=eq.${encodeURIComponent(INVOICE)}&select=id`],
    ['ORÁCULO order invoice_number', `/supplier_purchases?select=id&order=invoice_number.desc`],
    ['ORÁCULO order notes', `/supplier_purchases?select=id&order=notes.desc`],
    ['embed desde proveedor', `/suppliers?select=name,supplier_purchases(notes,invoice_number)`],
  ]) {
    const r = await request('cashier', path)
    denyValue(r, [...OPERATIONAL, ids.purA, ids.owner], `cashier (finance-only) · ${label}`)
  }
  // La proyección tampoco publica los campos operativos: pedirlos es un error,
  // no un silencio, porque la columna no existe en la vista.
  for (const col of ['notes', 'attachment_url', 'invoice_number', 'created_by', 'payment_method']) {
    const r = await request('cashier', `/v_finance_payables_due?select=${col}`)
    expect(r.status >= 400, `la proyección NO publica '${col}' (status ${r.status})`)
    denyValue(r, OPERATIONAL, `proyección · '${col}' no cruza`)
  }
  // …y el POSITIVO: los importes autorizados siguen llegando exactos.
  expectValue(await request('cashier', `/v_finance_payables_due?supplier_purchase_id=eq.${ids.purA}&select=pending_amount`),
    SP_PENDING, 'cashier · el saldo real llega por la proyección')
  expectValue(await request('cashier', `/v_finance_supplier_debt?business_id=eq.${ids.A}&select=outstanding_ars`),
    liveDebt, 'cashier · la deuda agregada real sigue llegando')
  // El actor con autoridad de COSTO conserva la fila cruda: la denegación de
  // arriba es por autoridad, no porque la superficie esté rota.
  expectValue(await request('manager', `/supplier_purchases?id=eq.${ids.purA}&select=invoice_number,notes`),
    NOTES, 'manager (inventory_view_costs) · conserva la fila operativa completa')
  console.log('  ✓ proyección financiera sin campos operativos, y positivos intactos')

  // anon
  for (const p of [`/v_finance_payables_due?select=*`, `/supplier_purchases?select=*`, `/rpc/finance_supplier_purchases`]) {
    const r = await request(null, p)
    denyValue(r, [...OPERATIONAL, SP_PENDING], `anon · ${p}`)
  }

  // ═══ CONTROLES NEGATIVOS ═════════════════════════════════════════════════
  const controls = [
    {
      name: 'NC1 — devolver la autoridad de pago a `inventory`',
      open: () => sql(`CREATE OR REPLACE FUNCTION public.pay_supplier_free_atomic(
          p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text,
          p_payment_date date, p_amount numeric, p_payment_method text, p_notes text,
          p_idempotency_key text DEFAULT NULL::text)
        RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','pg_temp'
        AS $f$ BEGIN
          PERFORM private.require_action_authority(p_business_id, 'inventory', NULL, NULL);
          RETURN private.pay_supplier_free_atomic(p_business_id,p_supplier_id,p_user_id,p_supplier_name,p_payment_date,p_amount,p_payment_method,p_notes,p_idempotency_key);
        END; $f$;`),
      probe: () => rpc('sales', 'pay_supplier_free_atomic', {
        p_business_id: ids.A, p_supplier_id: ids.supA, p_user_id: ids.sales, p_supplier_name: 'x',
        p_payment_date: today, p_amount: 7001, p_payment_method: METHOD, p_notes: 'nc1', p_idempotency_key: null,
      }),
      witness: '"ok": true',
      close: () => sql(`CREATE OR REPLACE FUNCTION public.pay_supplier_free_atomic(
          p_business_id uuid, p_supplier_id uuid, p_user_id uuid, p_supplier_name text,
          p_payment_date date, p_amount numeric, p_payment_method text, p_notes text,
          p_idempotency_key text DEFAULT NULL::text)
        RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','pg_temp'
        AS $f$ BEGIN
          PERFORM private.require_action_authority(p_business_id, 'finance', NULL, NULL);
          RETURN private.pay_supplier_free_atomic(p_business_id,p_supplier_id,p_user_id,p_supplier_name,p_payment_date,p_amount,p_payment_method,p_notes,p_idempotency_key);
        END; $f$;`),
    },
    {
      name: 'NC2 — restaurar el CERO fabricado en payables',
      open: () => sql(`CREATE OR REPLACE VIEW public.v_finance_supplier_debt WITH (security_invoker=true) AS
                         SELECT b.id AS business_id, COALESCE(d.outstanding,0)::numeric AS outstanding_ars,
                                COALESCE(d.documents,0)::bigint AS documents, true AS is_authorized
                           FROM public.businesses b
                           LEFT JOIN (SELECT sp.business_id, round(sum(sp.pending_amount),2) AS outstanding,
                                             count(*) AS documents
                                        FROM public.finance_supplier_purchases() sp
                                       WHERE sp.pending_amount > 0.01 AND sp.payment_status <> 'paid'
                                       GROUP BY sp.business_id) d ON d.business_id = b.id;`),
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
                                        FROM public.finance_supplier_purchases() sp
                                       WHERE sp.pending_amount > 0.01 AND sp.payment_status <> 'paid'
                                       GROUP BY sp.business_id) d ON d.business_id = b.id;`),
    },
    {
      name: 'NC3 — reabrir la fila cruda de supplier_purchases al actor de finanzas',
      open: () => sql(`DROP POLICY IF EXISTS supplier_purchases_inventory_select ON public.supplier_purchases;
                       CREATE POLICY supplier_purchases_inventory_select ON public.supplier_purchases FOR SELECT TO authenticated
                         USING (business_id = public.current_user_business_id()
                                AND public.can_view_supplier_finance(business_id));`),
      probe: () => request('cashier', `/supplier_purchases?id=eq.${ids.purA}&select=notes`),
      witness: NOTES,
      close: () => sql(`DROP POLICY IF EXISTS supplier_purchases_inventory_select ON public.supplier_purchases;
                        CREATE POLICY supplier_purchases_inventory_select ON public.supplier_purchases FOR SELECT TO authenticated
                          USING (business_id = public.current_user_business_id()
                                 AND public.can_view_inventory_cost(business_id));`),
    },
  ]

  console.log('\n--- Controles negativos ---')
  for (const c of controls) {
    c.open(); sql(`NOTIFY pgrst, 'reload schema';`); await new Promise(r => setTimeout(r, 900))
    const opened = await c.probe()
    checks++
    assert(String(opened.text ?? '').includes(String(c.witness)),
      `CONTROL NEGATIVO INÚTIL — «${c.name}»: al reabrir, el testigo ${c.witness} NO cruzó (${opened.status} ${opened.text?.slice(0, 250)})`)
    c.close(); sql(`NOTIFY pgrst, 'reload schema';`); await new Promise(r => setTimeout(r, 900))
    const closed = await c.probe()
    checks++
    assert(!String(closed.text ?? '').includes(String(c.witness)),
      `«${c.name}»: tras restaurar, el testigo SIGUE cruzando — ${closed.status} ${closed.text?.slice(0, 250)}`)
    console.log(`  ✓ ${c.name} — cruza al abrir, no cruza al cerrar`)
  }

  console.log(`\nSEC-08C fase B PostgREST OK — ${checks} aserciones sobre ${requests} requests`)
}

const cleanup = () => {
  if (!seeded) return
  try {
    const biz = `'${ids.A}','${ids.B}','${ids.bizZero}'`
    sql(`
      BEGIN;
      SET session_replication_role=replica;
      DELETE FROM public.financial_movements WHERE business_id IN (${biz});
      DELETE FROM public.business_finance_entries WHERE business_id IN (${biz});
      DELETE FROM public.supplier_account_movements WHERE business_id IN (${biz});
      DELETE FROM public.supplier_payments WHERE business_id IN (${biz});
      DELETE FROM public.supplier_purchase_items WHERE business_id IN (${biz});
      DELETE FROM public.supplier_purchases WHERE business_id IN (${biz});
      DELETE FROM public.suppliers WHERE business_id IN (${biz});
      DELETE FROM public.expenses WHERE business_id IN (${biz});
      DELETE FROM public.inventory_movements WHERE business_id IN (${biz});
      DELETE FROM public.inventory WHERE business_id IN (${biz});
      DELETE FROM public.profiles WHERE business_id IN (${biz});
      DELETE FROM public.businesses WHERE id IN (${biz});
      DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
      COMMIT;
    `)
  } catch (e) { console.error('cleanup:', e.message) }
}

main().then(() => { cleanup(); process.exit(0) })
  .catch(e => { cleanup(); console.error('\nSEC-08C fase B PostgREST FALLÓ:', e.message); process.exit(1) })
