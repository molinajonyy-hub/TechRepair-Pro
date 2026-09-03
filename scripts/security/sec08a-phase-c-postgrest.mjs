#!/usr/bin/env node
// SEC-08A Fase C — visibilidad de los PAGOS de un comprobante vinculado a una orden.
//
// Cierra el último P1 que la revisión final reprodujo: `comprobante_payments.amount`
// entregaba la cobranza de la orden a cualquier actor con `comprobantes` y sin
// `orders_view_financials` — directamente, y también enumerando sin conocer el id.
//
// Además fija el defecto que traía la Fase B: su policy de `comprobante_items`
// invocaba un helper de `private` que `authenticated` no podía ejecutar, así que
// respondía 42501 a TODOS —owner y admin incluidos— y el detalle de líneas de
// cualquier comprobante estaba roto. Por eso este archivo insiste con POSITIVOS
// explícitos: una aserción que sólo mira "el testigo no aparece" da por buena una
// denegación que en realidad es una pantalla rota.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')
const dbContainer = process.env.SEC08A_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base local')
const MIGRATION = 'supabase/migrations/20260913120000_sec08a_phase_c_payment_visibility.sql'

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe','pipe','pipe'], maxBuffer: 32*1024*1024 })
const sql = q => docker(['exec','-i',dbContainer,'psql','-X','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1'], q).trim()

const ACTORS = ['owner','admin','manager','sales','cashier','tech','viewer','inactive','ownerB']
const ids = Object.fromEntries([...ACTORS,'A','B','customer','order','compOrder','compFree','compB'].map(n => [n, randomUUID()]))

// Testigos únicos: un acierto es inequívoco.
const PAY_ORDER = 7101     // pago de un comprobante VINCULADO a la orden
const PAY_FREE  = 7202     // pago de un comprobante SUELTO (mostrador/POS)
const PAY_B     = 7303     // pago de otro tenant
const ITEM_ORDER = 7404    // línea del comprobante de la orden
const ITEM_FREE  = 7505    // línea del comprobante suelto
const TAG = 'sec08c-http.invalid'

let seeded = false, requests = 0, checks = 0

const main = async () => {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0,i), s.slice(i+1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuración de PostgREST local (¿kong sin puerto publicado?)')
  const apiUrl = `http://127.0.0.1:${hostPort}/rest/v1`
  let signingKey = Buffer.from(vars.PGRST_JWT_SECRET)
  if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
    const k = JSON.parse(vars.PGRST_JWT_SECRET).keys.find(x => x.kty === 'oct')
    assert(k?.k, 'Falta la JWK HS256 local'); signingKey = Buffer.from(k.k, 'base64url')
  }
  const token = actor => {
    const h = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url')
    const claims = { role:'authenticated', aud:'authenticated', exp: Math.floor(Date.now()/1000)+900 }
    if (actor) claims.sub = ids[actor]
    const c = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${h}.${c}.${createHmac('sha256', signingKey).update(`${h}.${c}`).digest('base64url')}`
  }
  const request = async (actor, path) => {
    requests++
    const r = await fetch(apiUrl + path, {
      headers: { 'Content-Type':'application/json', ...(actor ? { Authorization:`Bearer ${token(actor)}` } : {}) },
      signal: AbortSignal.timeout(15000),
    })
    return { status: r.status, text: await r.text() }
  }
  /** El valor no puede aparecer, pase lo que pase. */
  const denyValue = (res, needles, label) => {
    checks++
    for (const n of needles) {
      assert(!String(res.text ?? '').includes(String(n)),
        `${label}: el valor '${n}' cruzó la red — ${res.status} ${res.text?.slice(0,300)}`)
    }
  }
  /** El valor DEBE aparecer: los positivos son la mitad del contrato. */
  const expectValue = (res, needle, label) => {
    checks++
    assert(String(res.text ?? '').includes(String(needle)),
      `${label}: se esperaba '${needle}' y no llegó — ${res.status} ${res.text?.slice(0,300)}`)
  }
  /** Ni siquiera un 42501: una pantalla rota no es una denegación correcta. */
  const expectOk = (res, label) => {
    checks++
    assert(res.status === 200, `${label}: se esperaba 200 y hubo ${res.status} — ${res.text?.slice(0,300)}`)
  }
  const expect = (cond, label) => { checks++; assert(cond, label) }
  const setPerm = (who, json) => sql(`UPDATE public.profiles SET permissions=${json} WHERE id='${ids[who]}';`)

  // ── Fixture ──────────────────────────────────────────────────────────────
  const users = ACTORS.map(n => `('${ids[n]}','${n}@${TAG}',now())`).join(',')
  const profiles = ACTORS.map(n =>
    `('${ids[n]}','${n === 'ownerB' ? ids.B : ids.A}','${n === 'ownerB' ? 'owner' : n === 'inactive' ? 'admin' : n}',${n === 'inactive' ? 'false' : 'true'},'${n}@${TAG}')`).join(',')
  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ${users};
    -- El dueño registrado es el actor 'owner'; ningún otro rol lo es, o la rama
    -- de dueño de current_user_can_in_business le daría todo y el test mentiría.
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
      ('${ids.A}','C-A','${ids.owner}','pro','active'),
      ('${ids.B}','C-B','${ids.ownerB}','pro','active');
    INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES ${profiles};
    INSERT INTO public.customers(id,business_id,name,phone) VALUES ('${ids.customer}','${ids.A}','Cliente','1');
    INSERT INTO public.orders(id,business_id,customer_id,status) VALUES ('${ids.order}','${ids.A}','${ids.customer}','repair');

    INSERT INTO public.comprobantes(id,business_id,order_id,customer_id,tipo,estado,subtotal,impuestos,total,total_bruto,total_cobrado,saldo_pendiente,currency,total_ars,total_usd,exchange_rate,tax,status,fecha) VALUES
      ('${ids.compOrder}','${ids.A}','${ids.order}','${ids.customer}','factura_c','emitido',1,0,1,1,0,1,'ARS',1,0,1,0,'active',now()),
      ('${ids.compFree}','${ids.A}',NULL,'${ids.customer}','factura_c','emitido',1,0,1,1,0,1,'ARS',1,0,1,0,'active',now()),
      ('${ids.compB}','${ids.B}',NULL,NULL,'factura_c','emitido',1,0,1,1,0,1,'ARS',1,0,1,0,'active',now());
    INSERT INTO public.comprobante_items(id,comprobante_id,business_id,descripcion,cantidad,precio_unitario,costo_unitario) VALUES
      (gen_random_uuid(),'${ids.compOrder}','${ids.A}','linea-orden',1,${ITEM_ORDER},1),
      (gen_random_uuid(),'${ids.compFree}','${ids.A}','linea-suelta',1,${ITEM_FREE},1);
    INSERT INTO public.comprobante_payments(id,comprobante_id,business_id,amount,payment_method,date) VALUES
      (gen_random_uuid(),'${ids.compOrder}','${ids.A}',${PAY_ORDER},'efectivo',now()),
      (gen_random_uuid(),'${ids.compFree}','${ids.A}',${PAY_FREE},'efectivo',now()),
      (gen_random_uuid(),'${ids.compB}','${ids.B}',${PAY_B},'efectivo',now());
    UPDATE public.orders SET comprobante_id='${ids.compOrder}' WHERE id='${ids.order}';
    COMMIT;
  `)
  seeded = true

  // Rutas por las que un actor podría llegar al pago de la orden.
  const ORDER_PAY_ROUTES = [
    ['por comprobante_id',      `/comprobante_payments?comprobante_id=eq.${ids.compOrder}&select=amount`],
    ['select=*',                `/comprobante_payments?comprobante_id=eq.${ids.compOrder}&select=*`],
    ['ENUMERANDO todo',         `/comprobante_payments?select=comprobante_id,amount`],
    ['filtrando por importe',   `/comprobante_payments?amount=eq.${PAY_ORDER}&select=amount`],
    ['anidado desde comprobantes', `/comprobantes?id=eq.${ids.compOrder}&select=id,comprobante_payments(amount)`],
    ['vista collections ledger',`/v_finance_collections_ledger?select=*`],
    ['vista sales ledger',      `/v_finance_sales_ledger?select=*`],
    ['vista effective comps',   `/v_finance_effective_comprobantes?select=*`],
  ]

  // ── §6 NEGATIVOS: nadie sin orders_view_financials ve el pago de la orden ──
  // Combinaciones EXPLÍCITAS de override: son la razón por la que este P1 existe.
  const negatives = [
    ['sales',   `'{"orders_view_financials":false}'::jsonb`],
    ['cashier', `'{"orders_view_financials":false}'::jsonb`],
    ['manager', `'{"orders_view_financials":false}'::jsonb`],
    ['admin',   `'{"orders_view_financials":false}'::jsonb`],
    ['viewer',  `'{"comprobantes":true,"orders_view_financials":false}'::jsonb`],
    ['tech',    `'{"comprobantes":true,"orders_view_financials":false}'::jsonb`],
  ]
  for (const [who, perms] of negatives) {
    setPerm(who, perms)
    for (const [label, path] of ORDER_PAY_ROUTES) {
      const res = await request(who, path)
      denyValue(res, [PAY_ORDER], `${who} sin orders_view_financials · ${label}`)
    }
    // …pero el pago del comprobante SUELTO sigue siendo suyo: tiene `comprobantes`.
    const free = await request(who, `/comprobante_payments?comprobante_id=eq.${ids.compFree}&select=amount`)
    expectOk(free, `${who} · pago del comprobante suelto`)
    expectValue(free, PAY_FREE, `${who} conserva el pago del comprobante SUELTO (mostrador/POS intacto)`)
    setPerm(who, 'NULL')
  }
  // Por DEFECTO, tech y viewer no tienen `comprobantes`: nada de pagos.
  for (const who of ['tech','viewer']) {
    for (const [label, path] of ORDER_PAY_ROUTES) {
      const res = await request(who, path)
      denyValue(res, [PAY_ORDER, PAY_FREE], `${who} por defecto · ${label}`)
    }
  }
  // Inactivo y anónimo.
  for (const [label, path] of ORDER_PAY_ROUTES) {
    denyValue(await request('inactive', path), [PAY_ORDER, PAY_FREE], `inactive · ${label}`)
    denyValue(await request(null, path), [PAY_ORDER, PAY_FREE], `anon · ${label}`)
  }

  // ── §9 CROSS-TENANT ───────────────────────────────────────────────────────
  for (const [label, path] of [
    ['pago de B por id',   `/comprobante_payments?comprobante_id=eq.${ids.compB}&select=amount`],
    ['pagos enumerados',   `/comprobante_payments?select=amount`],
    ['pago de B por monto',`/comprobante_payments?amount=eq.${PAY_B}&select=amount`],
  ]) {
    denyValue(await request('owner', path), [PAY_B], `owner de A no ve pagos de B · ${label}`)
    denyValue(await request('ownerB', path.replace(String(PAY_B), String(PAY_ORDER))), [PAY_ORDER, PAY_FREE],
      `owner de B no ve pagos de A · ${label}`)
  }

  // ── §7/§8 POSITIVOS: los flujos legítimos siguen vivos ────────────────────
  // Éstos son los que la Fase B no tenía y por eso no vio su propia rotura.
  for (const who of ['owner','admin','manager','sales','cashier']) {
    const ord = await request(who, `/comprobante_payments?comprobante_id=eq.${ids.compOrder}&select=amount`)
    expectOk(ord, `${who} · pago de la orden`)
    expectValue(ord, PAY_ORDER, `${who} (defaults) SÍ lee el pago del comprobante de la orden`)

    const free = await request(who, `/comprobante_payments?comprobante_id=eq.${ids.compFree}&select=amount`)
    expectOk(free, `${who} · pago suelto`)
    expectValue(free, PAY_FREE, `${who} SÍ lee el pago del comprobante suelto`)

    // Detalle de líneas: 200 real, no 42501 (el defecto que traía la Fase B).
    const itOrd = await request(who, `/comprobante_items?comprobante_id=eq.${ids.compOrder}&select=precio_unitario`)
    expectOk(itOrd, `${who} · líneas del comprobante de la orden`)
    expectValue(itOrd, ITEM_ORDER, `${who} SÍ lee las líneas del comprobante de la orden`)

    const itFree = await request(who, `/comprobante_items?comprobante_id=eq.${ids.compFree}&select=precio_unitario`)
    expectOk(itFree, `${who} · líneas del comprobante suelto`)
    expectValue(itFree, ITEM_FREE, `${who} SÍ lee las líneas del comprobante suelto`)

    // Y el anidado que usa comprobanteService para el detalle.
    const nested = await request(who, `/comprobantes?id=eq.${ids.compOrder}&select=id,pagos:comprobante_payments(amount)`)
    expectOk(nested, `${who} · comprobante con pagos anidados`)
    expectValue(nested, PAY_ORDER, `${who} conserva el anidado comprobante→pagos`)
  }
  // Un actor sin la capacidad de comprobantes tampoco rompe la pantalla de líneas
  // sueltas: debe responder 200 (con o sin filas), nunca 42501.
  for (const who of ['tech','viewer']) {
    const it = await request(who, `/comprobante_items?comprobante_id=eq.${ids.compFree}&select=precio_unitario`)
    expectOk(it, `${who} · líneas del comprobante suelto responden 200, no 42501`)
    expectValue(it, ITEM_FREE, `${who} conserva las líneas del comprobante SUELTO`)
    const itOrd = await request(who, `/comprobante_items?comprobante_id=eq.${ids.compOrder}&select=precio_unitario`)
    expectOk(itOrd, `${who} · líneas del comprobante de orden responden 200, no 42501`)
    denyValue(itOrd, [ITEM_ORDER], `${who} NO ve las líneas del comprobante de la orden`)
  }

  // ── §13 CONTROL NEGATIVO ─────────────────────────────────────────────────
  // Se restaura la policy PRE-FASE-C y la fuga tiene que volver. Si no vuelve,
  // este test no sabe mirar y no vale nada.
  sql(`DROP POLICY cp_select_comprobantes_capability ON public.comprobante_payments;
       CREATE POLICY cp_select_comprobantes_capability ON public.comprobante_payments
         FOR SELECT TO authenticated
         USING (business_id = public.current_user_business_id() AND public.current_user_can('comprobantes'));`)
  setPerm('sales', `'{"orders_view_financials":false}'::jsonb`)
  const leak = await request('sales', `/comprobante_payments?comprobante_id=eq.${ids.compOrder}&select=amount`)
  expectValue(leak, PAY_ORDER, 'CONTROL NEGATIVO: con la policy pre-Fase-C la fuga DEBE reproducirse')
  const leakEnum = await request('sales', `/comprobante_payments?select=amount`)
  expectValue(leakEnum, PAY_ORDER, 'CONTROL NEGATIVO: la enumeración también DEBE filtrar')
  // Restaurar el candidato desde la migración real.
  docker(['exec','-i',dbContainer,'psql','-X','-U','postgres','-d','postgres','-q','-v','ON_ERROR_STOP=1'],
    readFileSync(MIGRATION, 'utf8'))
  const closed = await request('sales', `/comprobante_payments?comprobante_id=eq.${ids.compOrder}&select=amount`)
  denyValue(closed, [PAY_ORDER], 'tras restaurar la migración la fuga debe estar cerrada')
  const closedEnum = await request('sales', `/comprobante_payments?select=amount`)
  denyValue(closedEnum, [PAY_ORDER], 'tras restaurar, la enumeración tampoco filtra')
  expectValue(closedEnum, PAY_FREE, 'y el pago suelto sigue llegando: no se destruyó el mostrador')
  setPerm('sales', 'NULL')

  // ── §12 FASE A / B siguen cerradas ───────────────────────────────────────
  for (const who of ['tech','viewer']) {
    for (const [label, path] of [
      ['orders select=*',        `/orders?id=eq.${ids.order}&select=*`],
      ['orders device_password', `/orders?id=eq.${ids.order}&select=device_password`],
      ['order_items precios',    `/order_items?order_id=eq.${ids.order}&select=precio_unitario`],
      ['order_parts precios',    `/order_parts?order_id=eq.${ids.order}&select=sale_price`],
      ['cogs gaps',              `/v_finance_order_cogs_gaps?select=*`],
    ]) {
      const res = await request(who, path)
      expect(res.status === 403, `FASE A/B ${who} · ${label}: se esperaba 403, hubo ${res.status}`)
    }
    const comp = await request(who, `/comprobantes?order_id=eq.${ids.order}&select=total`)
    expect(!/"total"/.test(comp.text), `FASE B ${who}: el pivot de comprobantes sigue cerrado`)
  }

  console.log(`PASS SEC-08A Fase C PostgREST: ${requests} requests, ${checks} aserciones; ` +
    'ningún actor sin orders_view_financials obtuvo el pago de un comprobante vinculado a una orden ' +
    '(directo, select=*, enumerado, filtrado por importe, anidado o por las vistas de finanzas); ' +
    'pagos y líneas de comprobantes SUELTOS intactos, positivos autorizados en 200 y control negativo verificado')
}

const restoreSchema = () => {
  try {
    docker(['exec','-i',dbContainer,'psql','-X','-U','postgres','-d','postgres','-q','-v','ON_ERROR_STOP=1'],
      readFileSync(MIGRATION, 'utf8'))
  } catch (err) {
    console.error('SEC-08A Fase C: NO se pudo restaurar el esquema tras el control negativo —', String(err.message).slice(0,400))
    process.exitCode = 1
  }
}

const cleanup = () => {
  restoreSchema()
  if (!seeded) return
  try {
    sql(`
      SET session_replication_role=replica;
      DELETE FROM public.comprobante_payments WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.comprobante_items WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.comprobantes WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.orders WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.customers WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.profiles WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.businesses WHERE id IN ('${ids.A}','${ids.B}');
      DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
    `)
  } catch (err) {
    console.error('SEC-08A Fase C: la limpieza del fixture falló —', String(err.message).slice(0,300))
  }
}

try { await main() }
catch (err) { console.error('FAIL SEC-08A Fase C PostgREST:', err.message); process.exitCode = 1 }
finally { cleanup() }
