#!/usr/bin/env node
// SEC-08A Fase B — matriz real contra PostgREST para los tres pivots que la
// revisión independiente probó abiertos:
//
//   P1-1  autoridad ciega al tenant en get_order_financial_amounts
//   P1-2  pivot por comprobantes / comprobante_items
//   P1-3  reconstrucción exacta por order_items / order_parts
//
// Cada aserción negativa comprueba que el VALOR testigo no aparece en el cuerpo
// —ni se puede reconstruir con lo que sí llegó—, no que el status sea feo.
//
// Cada bloque trae su CONTROL NEGATIVO: se reabre la puerta dentro de la misma
// corrida, se comprueba que el testigo SÍ cruza, y se vuelve a cerrar. Un test
// que sólo ve DENIED no prueba que sepa mirar.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('No se pudo identificar el proyecto Supabase local')
const dbContainer = process.env.SEC08A_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base local')

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
const sql = q => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], q).trim()

// Actores. `multiA`/`multiB` son EL MISMO usuario con DOS perfiles: el esquema
// lo permite (profiles.id es PK y user_id tiene índice único parcial, así que
// COALESCE(user_id,id) matchea hasta dos filas con business_id distinto).
const actors = ['owner', 'admin', 'manager', 'tech', 'sales', 'cashier', 'viewer', 'inactive', 'ownerB']
const ids = Object.fromEntries([
  ...actors, 'A', 'B', 'customer', 'device', 'order', 'orderB',
  'multi', 'multiSpare', 'multi2', 'multi2Spare', 'techB',
  'item1', 'item2', 'partA', 'compOrden', 'compSuelto',
].map(n => [n, randomUUID()]))

// Testigos. Únicos por campo: un acierto es inequívoco.
const ITEM = { p1: 1301, c1: 1302, p2: 1303, c2: 1304, qty1: 3, qty2: 2 }
// estimated_total = 1301*3 + 1303*2 = 3903 + 2606 = 6509
// total_cost      = 1302*3 + 1304*2 = 3906 + 2608 = 6514
const EXPECTED_ESTIMATED = ITEM.p1 * ITEM.qty1 + ITEM.p2 * ITEM.qty2
const EXPECTED_COST = ITEM.c1 * ITEM.qty1 + ITEM.c2 * ITEM.qty2
// `margin_percentage` es numeric(5,2): el testigo tiene que caber en <1000.
const PART = { internal: 1401, sale: 1402, margin: 1403, pct: 987.65, qty: 2 }
const COMP = { total: 1501, cobrado: 1502, saldo: 1503, itemPrecio: 1504, itemCosto: 1505 }
const SUELTO = { total: 1601 }
const ORDERB = { total_cost: 1701, estimated: 1702 }
const TAG = 'sec08b-http.invalid'

let seeded = false
let requests = 0
let checks = 0

const main = async () => {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuración de PostgREST local (¿kong sin puerto publicado?)')
  const api = `http://127.0.0.1:${hostPort}/rest/v1`
  let signingKey = Buffer.from(vars.PGRST_JWT_SECRET)
  if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
    const key = JSON.parse(vars.PGRST_JWT_SECRET).keys.find(k => k.kty === 'oct')
    assert(key?.k, 'Falta la JWK HS256 local')
    signingKey = Buffer.from(key.k, 'base64url')
  }
  const token = (actor, role = 'authenticated') => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const claims = { role, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 900 }
    if (actor) claims.sub = ids[actor]
    const c = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${h}.${c}.${createHmac('sha256', signingKey).update(`${h}.${c}`).digest('base64url')}`
  }
  const request = async (actor, path, { method = 'GET', body, role = 'authenticated' } = {}) => {
    requests++
    const response = await fetch(api + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(actor || role === 'service_role' ? { Authorization: `Bearer ${token(actor, role)}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    })
    const text = await response.text()
    return { status: response.status, text }
  }
  const denyValue = (result, needles, label) => {
    checks++
    for (const needle of needles) {
      assert(!String(result.text ?? '').includes(String(needle)),
        `${label}: el valor '${needle}' cruzó la red — ${result.status} ${result.text?.slice(0, 300)}`)
    }
  }
  const expectValue = (result, needle, label) => {
    checks++
    assert(String(result.text ?? '').includes(String(needle)),
      `${label}: se esperaba '${needle}' y no llegó — ${result.status} ${result.text?.slice(0, 300)}`)
  }
  const expect = (condition, label) => { checks++; assert(condition, label) }

  // ── Fixture ───────────────────────────────────────────────────────────────
  const users = [...actors, 'multi', 'multiSpare', 'multi2', 'multi2Spare', 'techB']
    .map(n => `('${ids[n]}','${n}@${TAG}',now())`).join(',')
  const profiles = actors
    .map(n => `('${ids[n]}',NULL,'${n === 'ownerB' ? ids.B : ids.A}','${n === 'ownerB' ? 'owner' : n === 'inactive' ? 'admin' : n}',${n === 'inactive' ? 'false' : 'true'},'${n}@${TAG}',now())`)
    .join(',')

  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ${users};
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
      ('${ids.A}','SEC08B A','${ids.owner}','pro','active'),
      ('${ids.B}','SEC08B B','${ids.ownerB}','pro','active');
    INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email,updated_at) VALUES ${profiles};

    -- Usuario con DOS perfiles: admin en A (más reciente) y tech en B.
    INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email,updated_at) VALUES
      ('${ids.multi}',NULL,'${ids.A}','admin',true,'multi@${TAG}',now()),
      ('${ids.multiSpare}','${ids.multi}','${ids.B}','tech',true,'multi@${TAG}',now()-interval '5 days');

    -- El inverso: tech en A (más reciente) y admin en B.
    INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email,updated_at) VALUES
      ('${ids.multi2}',NULL,'${ids.A}','tech',true,'multi2@${TAG}',now()),
      ('${ids.multi2Spare}','${ids.multi2}','${ids.B}','admin',true,'multi2@${TAG}',now()-interval '5 days');

    INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email,updated_at) VALUES
      ('${ids.techB}',NULL,'${ids.B}','tech',true,'techb@${TAG}',now());

    INSERT INTO public.customers(id,business_id,name,phone) VALUES ('${ids.customer}','${ids.A}','Cliente','1');
    INSERT INTO public.devices(id,business_id,customer_id,brand,model,type,issue)
      VALUES ('${ids.device}','${ids.A}','${ids.customer}','Marca','Modelo','smartphone','falla');

    INSERT INTO public.orders(id,business_id,customer_id,device_id,status) VALUES ('${ids.order}','${ids.A}','${ids.customer}','${ids.device}','repair');
    INSERT INTO public.orders(id,business_id,status,total_cost,estimated_total) VALUES ('${ids.orderB}','${ids.B}','repair',${ORDERB.total_cost},${ORDERB.estimated});

    INSERT INTO public.order_parts(id,order_id,business_id,name,internal_cost,sale_price,margin_amount,margin_percentage,quantity,status,cliente_paga_repuesto)
      VALUES ('${ids.partA}','${ids.order}','${ids.A}','parte testigo',${PART.internal},${PART.sale},${PART.margin},${PART.pct},${PART.qty},'used',true);

    -- Comprobante VINCULADO a la orden (verdad financiera de la orden).
    INSERT INTO public.comprobantes(id,business_id,order_id,customer_id,tipo,estado,subtotal,impuestos,total,total_bruto,total_cobrado,saldo_pendiente,currency,total_ars,total_usd,exchange_rate,tax,status,fecha)
      VALUES ('${ids.compOrden}','${ids.A}','${ids.order}','${ids.customer}','factura_c','emitido',${COMP.total},0,${COMP.total},${COMP.total},${COMP.cobrado},${COMP.saldo},'ARS',${COMP.total},0,1,0,'active',now());
    INSERT INTO public.comprobante_items(id,comprobante_id,business_id,descripcion,cantidad,precio_unitario,costo_unitario)
      VALUES (gen_random_uuid(),'${ids.compOrden}','${ids.A}','linea de orden',1,${COMP.itemPrecio},${COMP.itemCosto});

    -- Comprobante SUELTO (venta de mostrador): NO habla de ninguna orden.
    INSERT INTO public.comprobantes(id,business_id,order_id,customer_id,tipo,estado,subtotal,impuestos,total,total_bruto,total_cobrado,saldo_pendiente,currency,total_ars,total_usd,exchange_rate,tax,status,fecha)
      VALUES ('${ids.compSuelto}','${ids.A}',NULL,'${ids.customer}','factura_c','emitido',${SUELTO.total},0,${SUELTO.total},${SUELTO.total},0,${SUELTO.total},'ARS',${SUELTO.total},0,1,0,'active',now());
    COMMIT;
  `)
  seeded = true

  // Los ítems van FUERA del bloque en `replica`: ahí los triggers están
  // desactivados y `recalculate_order_total` no correría, que es justo la
  // aritmética que este test necesita medir. Con el trigger real:
  //   estimated_total = SUM(precio_unitario * cantidad)
  //   total_cost      = SUM(costo_unitario  * cantidad)
  sql(`
    INSERT INTO public.order_items(id,order_id,business_id,tipo,descripcion,cantidad,precio_unitario,costo_unitario) VALUES
      ('${ids.item1}','${ids.order}','${ids.A}','repuesto','repuesto testigo',${ITEM.qty1},${ITEM.p1},${ITEM.c1}),
      ('${ids.item2}','${ids.order}','${ids.A}','servicio','servicio testigo',${ITEM.qty2},${ITEM.p2},${ITEM.c2});
  `)
  const recalculado = sql(`SELECT estimated_total||'/'||total_cost FROM public.orders WHERE id='${ids.order}';`)
  assert.equal(recalculado, `${EXPECTED_ESTIMATED}.00/${EXPECTED_COST}.00`,
    `El trigger no produjo los importes esperados (${recalculado}); el testigo de reconstrucción sería inválido`)

  const SIN_CAPACIDAD = ['tech', 'viewer']
  const CON_CAPACIDAD = ['owner', 'admin', 'manager', 'sales', 'cashier']

  // ── P1-1 · coherencia tenant/capacidad ───────────────────────────────────
  {
    const amounts = (actor, businessId, orderIds) =>
      request(actor, '/rpc/get_order_financial_amounts', { method: 'POST', body: { p_business_id: businessId, p_order_ids: orderIds } })

    // admin en A + tech en B pidiendo B: la capacidad NO puede venir de A.
    const r = await amounts('multi', ids.B, [ids.orderB])
    denyValue(r, [ORDERB.total_cost, ORDERB.estimated], 'P1-1 admin-A/tech-B no puede cobrar autoridad de A sobre B')
    expect(/"authorized":\s*false/.test(r.text), `P1-1 admin-A/tech-B debe recibir authorized=false — ${r.text.slice(0, 200)}`)

    // El inverso: tech en A + admin en B pidiendo B SÍ debe poder.
    const r2 = await amounts('multi2', ids.B, [ids.orderB])
    expectValue(r2, ORDERB.total_cost, 'P1-1 tech-A/admin-B debe recibir los importes de B')

    // Y el mismo usuario, pidiendo A (donde es tech), no.
    const r3 = await amounts('multi2', ids.A, [ids.order])
    denyValue(r3, [EXPECTED_ESTIMATED, EXPECTED_COST], 'P1-1 tech-A/admin-B no puede ver importes de A')

    // Control positivo/negativo simple dentro de un solo tenant.
    for (const a of CON_CAPACIDAD) {
      const ok = await amounts(a, ids.A, [ids.order])
      expectValue(ok, EXPECTED_ESTIMATED, `P1-1 ${a} debe recibir los importes de su orden`)
    }
    for (const a of [...SIN_CAPACIDAD, 'inactive']) {
      const no = await amounts(a, ids.A, [ids.order])
      denyValue(no, [EXPECTED_ESTIMATED, EXPECTED_COST], `P1-1 ${a} no debe recibir importes`)
    }
    const foreign = await amounts('ownerB', ids.A, [ids.order])
    expect(/FORBIDDEN/.test(foreign.text), 'P1-1 tenant ajeno debe recibir FORBIDDEN')
    const anon = await amounts(null, ids.A, [ids.order])
    expect(anon.status === 401 || anon.status === 403, 'P1-1 anon no debe alcanzar la ruta de importes')

    // Overrides, resueltos EN EL NEGOCIO de la orden.
    sql(`UPDATE public.profiles SET permissions='{"orders_view_financials":true}'::jsonb WHERE id='${ids.multiSpare}';`)
    const ovOn = await amounts('multi', ids.B, [ids.orderB])
    expectValue(ovOn, ORDERB.total_cost, 'P1-1 override true EN B habilita a su perfil de B')
    sql(`UPDATE public.profiles SET permissions=NULL WHERE id='${ids.multiSpare}';`)

    sql(`UPDATE public.profiles SET permissions='{"orders_view_financials":false}'::jsonb WHERE id='${ids.manager}';`)
    const ovOff = await amounts('manager', ids.A, [ids.order])
    denyValue(ovOff, [EXPECTED_ESTIMATED], 'P1-1 override false deshabilita al manager')
    sql(`UPDATE public.profiles SET permissions=NULL WHERE id='${ids.manager}';`)

    // CONTROL NEGATIVO: se restaura la autoridad CIEGA al tenant y la fuga
    // vuelve. Sin esto, el test no prueba que sepa detectarla.
    //
    // Antes hay que RE-FIJAR el orden de los perfiles: `current_user_can` elige
    // por `updated_at DESC`, y el trigger `update_profiles_updated_at` pisa esa
    // columna en CADA update — los overrides de arriba dejaron el perfil de B
    // como el más reciente. Se fija en `replica` justamente para que el trigger
    // no vuelva a moverlo. (Que la autoridad ciega dependa de un timestamp que
    // cualquier escritura mueve es, por sí solo, motivo suficiente para no
    // usarla como autoridad financiera.)
    sql(`SET session_replication_role=replica;
         UPDATE public.profiles SET updated_at=now() WHERE id='${ids.multi}';
         UPDATE public.profiles SET updated_at=now()-interval '5 days' WHERE id='${ids.multiSpare}';`)
    sql(`
      CREATE OR REPLACE FUNCTION public.get_order_financial_amounts(p_business_id uuid, p_order_ids uuid[])
      RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $ctl$
      DECLARE v_rows jsonb;
      BEGIN
        IF NOT public.current_user_can('orders_view_financials') THEN
          RETURN jsonb_build_object('ok', true, 'authorized', false, 'rows', '[]'::jsonb);
        END IF;
        SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_rows
          FROM (SELECT o.id AS order_id, o.total_cost, o.estimated_total
                  FROM public.orders o WHERE o.business_id = p_business_id) x;
        RETURN jsonb_build_object('ok', true, 'authorized', true, 'rows', v_rows);
      END $ctl$;`)
    const leak = await amounts('multi', ids.B, [ids.orderB])
    expectValue(leak, ORDERB.total_cost, 'CONTROL NEGATIVO P1-1: con autoridad ciega la fuga DEBE reproducirse')
    // Se restaura la definición real desde la migración.
    docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'],
      readFileSync('supabase/migrations/20260912120000_sec08a_phase_b_financial_pivots.sql', 'utf8'))
    const restored = await amounts('multi', ids.B, [ids.orderB])
    denyValue(restored, [ORDERB.total_cost], 'P1-1 tras restaurar la migración la fuga debe estar cerrada')
  }

  // ── P1-2 · pivot por comprobantes ────────────────────────────────────────
  {
    const pivots = [
      ['comprobantes por order_id', `/comprobantes?order_id=eq.${ids.order}&select=order_id,total,total_bruto,total_cobrado,saldo_pendiente,payment_status`],
      ['comprobantes select=*', `/comprobantes?order_id=eq.${ids.order}&select=*`],
      ['comprobante_items de la orden', `/comprobante_items?comprobante_id=eq.${ids.compOrden}&select=precio_unitario,costo_unitario,cantidad`],
      ['comprobantes anidado a items', `/comprobante_items?select=precio_unitario,comprobante:comprobantes!inner(order_id)&comprobante.order_id=eq.${ids.order}`],
      ['v_order_payment_state', `/v_order_payment_state?order_id=eq.${ids.order}&select=order_id,payment_status,comprobantes_vigentes`],
    ]
    for (const actor of SIN_CAPACIDAD) {
      for (const [label, path] of pivots) {
        const r = await request(actor, path)
        denyValue(r, [COMP.total, COMP.cobrado, COMP.saldo, COMP.itemPrecio, COMP.itemCosto], `P1-2 ${actor} · ${label}`)
      }
      // `payment_status` es verdad financiera derivada: tampoco debe llegar.
      const st = await request(actor, `/v_order_payment_state?order_id=eq.${ids.order}&select=payment_status`)
      expect(!/"payment_status"/.test(st.text), `P1-2 ${actor}: v_order_payment_state no debe devolver filas — ${st.text.slice(0, 200)}`)
      // Y NO debe fabricar 'sin_facturar' para una orden efectivamente facturada.
      expect(!/sin_facturar/.test(st.text), `P1-2 ${actor}: 'sin_facturar' fabricado sobre una orden facturada`)
    }

    // POSITIVOS LEGÍTIMOS: el comprobante SUELTO sigue siendo visible para
    // cualquier miembro del negocio. El módulo de comprobantes no se destruyó.
    for (const actor of SIN_CAPACIDAD) {
      const suelto = await request(actor, `/comprobantes?id=eq.${ids.compSuelto}&select=id,total`)
      expectValue(suelto, SUELTO.total, `P1-2 ${actor} debe seguir viendo comprobantes sueltos (POS/mostrador)`)
    }
    // Y quien tiene la capacidad sigue viendo el comprobante de la orden.
    for (const actor of CON_CAPACIDAD) {
      const r = await request(actor, `/comprobantes?order_id=eq.${ids.order}&select=id,total,total_cobrado`)
      expectValue(r, COMP.total, `P1-2 ${actor} debe seguir viendo el comprobante de la orden`)
      const st = await request(actor, `/v_order_payment_state?order_id=eq.${ids.order}&select=payment_status`)
      expect(/"payment_status"/.test(st.text), `P1-2 ${actor} debe seguir viendo el estado de cobro`)
    }
    // Tenant ajeno y anon.
    const ajeno = await request('ownerB', `/comprobantes?order_id=eq.${ids.order}&select=total`)
    denyValue(ajeno, [COMP.total], 'P1-2 tenant ajeno')
    const anonC = await request(null, `/comprobantes?select=total`)
    denyValue(anonC, [COMP.total, SUELTO.total], 'P1-2 anon')

    // CONTROL NEGATIVO: se restaura la policy sólo-tenant y la fuga vuelve.
    sql(`DROP POLICY comprobantes_select ON public.comprobantes;
         CREATE POLICY comprobantes_select ON public.comprobantes FOR SELECT
           USING (business_id = public.current_user_business_id());`)
    const leak = await request('tech', `/comprobantes?order_id=eq.${ids.order}&select=total,total_cobrado,saldo_pendiente`)
    expectValue(leak, COMP.total, 'CONTROL NEGATIVO P1-2: con la policy sólo-tenant la fuga DEBE reproducirse')
    sql(`DROP POLICY comprobantes_select ON public.comprobantes;
         CREATE POLICY comprobantes_select ON public.comprobantes FOR SELECT
           USING (business_id = public.current_user_business_id()
                  AND (order_id IS NULL
                       OR public.current_user_can_in_business(business_id, 'orders_view_financials')));`)
    const closed = await request('tech', `/comprobantes?order_id=eq.${ids.order}&select=total`)
    denyValue(closed, [COMP.total], 'P1-2 tras restaurar la policy la fuga debe estar cerrada')
  }

  // ── P1-3 · reconstrucción exacta por order_items / order_parts ───────────
  {
    for (const actor of SIN_CAPACIDAD) {
      const rutas = [
        ['order_items select=*', `/order_items?order_id=eq.${ids.order}&select=*`],
        ['order_items precios', `/order_items?order_id=eq.${ids.order}&select=precio_unitario,costo_unitario,cantidad`],
        ['order_parts select=*', `/order_parts?order_id=eq.${ids.order}&select=*`],
        ['order_parts precios', `/order_parts?order_id=eq.${ids.order}&select=internal_cost,sale_price,margin_amount,margin_percentage`],
        ['orders anidado a items', `/orders?id=eq.${ids.order}&select=id,order_items(precio_unitario,cantidad)`],
        ['customers anidado a items', `/customers?id=eq.${ids.customer}&select=id,orders(order_items(precio_unitario))`],
        ['v_finance_order_cogs_gaps', `/v_finance_order_cogs_gaps?order_id=eq.${ids.order}&select=*`],
      ]
      for (const [label, path] of rutas) {
        const r = await request(actor, path)
        denyValue(r, [ITEM.p1, ITEM.c1, ITEM.p2, ITEM.c2, PART.internal, PART.sale, PART.margin, PART.pct, EXPECTED_ESTIMATED, EXPECTED_COST],
          `P1-3 ${actor} · ${label}`)
      }
      // Lo OPERATIVO sigue disponible: el técnico necesita saber qué repuesto
      // puso y cuántos, sin ver el precio.
      const op = await request(actor, `/order_items?order_id=eq.${ids.order}&select=id,tipo,descripcion,cantidad`)
      expectValue(op, 'repuesto testigo', `P1-3 ${actor} debe conservar el detalle operativo de los ítems`)
      const opP = await request(actor, `/order_parts?order_id=eq.${ids.order}&select=id,name,quantity,status`)
      expectValue(opP, 'parte testigo', `P1-3 ${actor} debe conservar el detalle operativo de los repuestos`)
      // Y la ruta canónica de importes de línea le dice que no.
      const line = await request(actor, '/rpc/get_order_line_amounts', { method: 'POST', body: { p_business_id: ids.A, p_order_ids: [ids.order] } })
      denyValue(line, [ITEM.p1, ITEM.c1, PART.internal, PART.sale], `P1-3 ${actor} · ruta de importes de línea`)
      expect(/"authorized":\s*false/.test(line.text), `P1-3 ${actor}: la ruta de línea debe responder authorized=false`)
    }

    // POSITIVO: quien tiene la capacidad recibe los importes por la ruta.
    for (const actor of CON_CAPACIDAD) {
      const line = await request(actor, '/rpc/get_order_line_amounts', { method: 'POST', body: { p_business_id: ids.A, p_order_ids: [ids.order] } })
      expectValue(line, ITEM.p1, `P1-3 ${actor} debe recibir los precios de línea`)
      expectValue(line, PART.internal, `P1-3 ${actor} debe recibir los costos de repuesto`)
      // …pero la tabla cruda sigue cerrada incluso para él.
      const raw = await request(actor, `/order_items?order_id=eq.${ids.order}&select=precio_unitario`)
      denyValue(raw, [ITEM.p1], `P1-3 ${actor}: la tabla cruda sigue cerrada aunque tenga la capacidad`)
    }

    // CONTROL NEGATIVO: se reabre la columna y el testigo vuelve a cruzar.
    sql(`GRANT SELECT (precio_unitario) ON public.order_items TO authenticated;`)
    const leak = await request('tech', `/order_items?order_id=eq.${ids.order}&select=precio_unitario`)
    expectValue(leak, ITEM.p1, 'CONTROL NEGATIVO P1-3: con la columna reabierta el testigo DEBE cruzar')
    sql(`REVOKE SELECT (precio_unitario) ON public.order_items FROM authenticated;`)
    const closed = await request('tech', `/order_items?order_id=eq.${ids.order}&select=precio_unitario`)
    denyValue(closed, [ITEM.p1], 'P1-3 tras revocar, la columna debe estar cerrada')
  }

  // ── Fase A: no se rompió nada ────────────────────────────────────────────
  {
    for (const actor of SIN_CAPACIDAD) {
      for (const [label, path] of [
        ['orders select=*', `/orders?id=eq.${ids.order}&select=*`],
        ['orders O1', `/orders?id=eq.${ids.order}&select=total_cost,estimated_total`],
        ['orders device_password', `/orders?id=eq.${ids.order}&select=device_password`],
        ['customers anidado orders(*)', `/customers?id=eq.${ids.customer}&select=*,orders(*)`],
      ]) {
        const r = await request(actor, path)
        denyValue(r, [EXPECTED_ESTIMATED, EXPECTED_COST], `FASE A ${actor} · ${label}`)
        expect(r.status === 403 || r.status === 401, `FASE A ${actor} · ${label}: se esperaba denegación, hubo ${r.status}`)
      }
      const op = await request(actor, `/orders?id=eq.${ids.order}&select=id,status,access_mode`)
      expect(op.status === 200, `FASE A ${actor}: la lectura operativa de orders debe seguir viva`)
    }
    // El dual-write legacy de Mobile2A sigue funcionando.
    const patch = await request('admin', `/orders?id=eq.${ids.order}`, { method: 'PATCH', body: { device_password: 'pin:1234' } })
    expect(patch.status === 200 || patch.status === 204, `FASE A: PATCH device_password debe seguir permitido — ${patch.status}`)
    expect(sql(`SELECT device_password FROM public.orders WHERE id='${ids.order}';`) === 'pin:1234',
      'FASE A: el dual-write legacy debe persistir')
  }

  console.log(`PASS SEC-08A Fase B PostgREST: ${requests} requests, ${checks} aserciones; ` +
    'ningún actor sin orders_view_financials obtuvo ni reconstruyó verdad financiera de la orden ' +
    '(orders, comprobantes, comprobante_items, order_items, order_parts, vistas); ' +
    'positivos legítimos y controles negativos verificados')
}

/**
 * Los controles negativos SABOTEAN el esquema a propósito (autoridad ciega,
 * policy sólo-tenant, columna reabierta). Si el proceso muere en medio, esa
 * puerta quedaría abierta en la base local. Re-aplicar la migración restaura el
 * estado real y sus postcondiciones vuelven a verificarlo, así que se hace
 * SIEMPRE, incluso cuando el fixture nunca llegó a sembrarse.
 */
const restoreSchema = () => {
  try {
    docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'],
      readFileSync('supabase/migrations/20260912120000_sec08a_phase_b_financial_pivots.sql', 'utf8'))
  } catch (err) {
    console.error('SEC-08A Fase B: NO se pudo restaurar el esquema tras los controles negativos —',
      String(err.message).slice(0, 400))
    process.exitCode = 1
  }
}

const cleanup = () => {
  restoreSchema()
  if (!seeded) return
  try {
    sql(`
      SET session_replication_role=replica;
      DELETE FROM public.comprobante_items WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.comprobantes WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.order_parts WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.order_items WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.orders WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.devices WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.customers WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.profiles WHERE business_id IN ('${ids.A}','${ids.B}');
      DELETE FROM public.businesses WHERE id IN ('${ids.A}','${ids.B}');
      DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
    `)
  } catch (err) {
    console.error('SEC-08A Fase B: la limpieza del fixture falló —', String(err.message).slice(0, 300))
  }
}

try {
  await main()
} catch (err) {
  console.error('FAIL SEC-08A Fase B PostgREST:', err.message)
  process.exitCode = 1
} finally {
  cleanup()
}
