#!/usr/bin/env node
// SEC-08C — MATRIZ DE COMPATIBILIDAD. Determina el ORDEN DE ROLLOUT.
//
// SEC-08A y SEC-08B tuvieron que salir FRONTEND-PRIMERO porque revocaban
// columnas y el frontend viejo, que pedía `*`, se habría comido un 42501 y la
// pantalla habría desaparecido. Este lote NO revoca ninguna columna: mueve
// predicados de RLS, que filtran FILAS. Eso invierte la conclusión, y por eso
// se mide en vez de asumirse.
//
// Se prueban las dos combinaciones peligrosas:
//
//   FE VIEJO + DB NUEVA — se ejecutan las formas EXACTAS que hoy tiene
//   origin/main (select('*'), el embed de stats, la consulta de deuda del
//   dashboard). Ninguna puede responder 403 ni filtrar un importe prohibido.
//
//   FE NUEVO + DB VIEJA — el frontend nuevo lee dos vistas que en la DB vieja
//   NO EXISTEN. Se comprueba que eso da un error de lectura (no datos), que es
//   la rama que el service traduce a «restringido» y NO a «$0».
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

const SP_TOTAL = 73191, SP_PENDING = 51988, PAY_AMOUNT = 11837, MOV_DEBIT = 68429, ITEM_COST = 4173
const FORBIDDEN = [SP_TOTAL, SP_PENDING, PAY_AMOUNT, MOV_DEBIT, ITEM_COST]
const TAG = 'sec08c-compat.invalid'

let seeded = false, checks = 0

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
  const token = actor => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const c = Buffer.from(JSON.stringify({ role: 'authenticated', aud: 'authenticated', sub: ids[actor], exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url')
    return `${h}.${c}.${createHmac('sha256', signingKey).update(`${h}.${c}`).digest('base64url')}`
  }
  const request = async (actor, path) => {
    const r = await fetch(apiUrl + path, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(actor)}` },
      signal: AbortSignal.timeout(15000),
    })
    return { status: r.status, text: await r.text() }
  }
  const expect = (cond, label) => { checks++; assert(cond, label) }

  const profiles = ACTORS.map(n => `('${ids[n]}','${ids.A}','${n}',true,'${n}@${TAG}')`).join(',')
  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ${ACTORS.map(n => `('${ids[n]}','${n}@${TAG}',now())`).join(',')};
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status)
      VALUES ('${ids.A}','B-compat','${ids.owner}','pro','active');
    INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES ${profiles};
    INSERT INTO public.suppliers(id,business_id,name,active) VALUES ('${ids.supA}','${ids.A}','Prov-compat',true);
    INSERT INTO public.supplier_purchases(id,business_id,supplier_id,purchase_date,total_amount,paid_amount,pending_amount,payment_status)
      VALUES ('${ids.purA}','${ids.A}','${ids.supA}',current_date,${SP_TOTAL},21203,${SP_PENDING},'partial');
    INSERT INTO public.supplier_purchase_items(id,business_id,purchase_id,supplier_id,product_name,quantity,unit_cost,subtotal)
      VALUES (gen_random_uuid(),'${ids.A}','${ids.purA}','${ids.supA}','l',1,${ITEM_COST},${ITEM_COST});
    INSERT INTO public.supplier_payments(id,business_id,supplier_id,purchase_id,payment_date,amount,payment_method)
      VALUES (gen_random_uuid(),'${ids.A}','${ids.supA}','${ids.purA}',current_date,${PAY_AMOUNT},'transferencia');
    INSERT INTO public.supplier_account_movements(id,business_id,supplier_id,purchase_id,movement_date,type,description,debit,credit,balance_after)
      VALUES (gen_random_uuid(),'${ids.A}','${ids.supA}','${ids.purA}',current_date,'purchase','m',${MOV_DEBIT},0,${MOV_DEBIT});
    COMMIT;
  `)
  seeded = true

  // ═══ FE VIEJO + DB NUEVA ═════════════════════════════════════════════════
  // Las formas literales de origin/main (51afe27a).
  const OLD_SHAPES = [
    ['listado con stats embebidas', `/suppliers?business_id=eq.${ids.A}&select=*,supplier_purchases(total_amount,paid_amount,pending_amount,purchase_date)`],
    ['compras con lineas',          `/supplier_purchases?supplier_id=eq.${ids.supA}&business_id=eq.${ids.A}&select=*,items:supplier_purchase_items(*)`],
    ['pagos select=*',              `/supplier_payments?supplier_id=eq.${ids.supA}&business_id=eq.${ids.A}&select=*`],
    ['cuenta corriente select=*',   `/supplier_account_movements?supplier_id=eq.${ids.supA}&business_id=eq.${ids.A}&select=*`],
    ['deuda del dashboard',         `/supplier_purchases?business_id=eq.${ids.A}&payment_status=neq.paid&select=pending_amount`],
    ['proveedores select=*',        `/suppliers?business_id=eq.${ids.A}&select=*`],
    ['timeline de proveedor',       `/supplier_account_movements?supplier_id=eq.${ids.supA}&business_id=eq.${ids.A}&select=*&order=created_at.desc&limit=50`],
  ]
  console.log('\n── FE VIEJO + DB NUEVA ──')
  for (const actor of ACTORS) {
    for (const [label, path] of OLD_SHAPES) {
      const r = await request(actor, path)
      // Lo que NO puede pasar: que la pantalla vieja se rompa.
      expect(r.status === 200,
        `FE viejo + DB nueva · ${actor} · ${label}: el frontend actual recibiría ${r.status} — ${r.text.slice(0, 200)}`)
      // Y lo que tampoco puede pasar: que siga filtrando.
      if (!['owner', 'admin', 'manager', 'cashier'].includes(actor)) {
        for (const v of FORBIDDEN) {
          expect(!r.text.includes(String(v)),
            `FE viejo + DB nueva · ${actor} · ${label}: filtró ${v}`)
        }
      }
    }
    console.log(`  ✓ ${actor} — las 7 formas viejas responden 200`)
  }
  // El actor de finanzas MEJORA con la DB nueva: la consulta vieja del
  // dashboard le empieza a devolver la deuda real en vez de lista vacía.
  const cashierOld = await request('cashier', `/supplier_purchases?business_id=eq.${ids.A}&payment_status=neq.paid&select=pending_amount`)
  expect(cashierOld.text.includes(String(SP_PENDING)),
    `FE viejo + DB nueva · el cashier tiene que empezar a ver la deuda real — ${cashierOld.text.slice(0, 200)}`)
  console.log('  ✓ cashier — la consulta vieja del dashboard deja de dar el cero falso')

  // ═══ FE NUEVO + DB VIEJA ═════════════════════════════════════════════════
  // En la DB vieja las dos vistas del lote NO existen. Se simula pidiendo un
  // nombre inexistente: PostgREST responde 404, que es la rama de ERROR del
  // service — y el service la traduce a «restringido», nunca a 0.
  console.log('\n── FE NUEVO + DB VIEJA ──')
  for (const view of ['v_finance_supplier_debt_missing', 'v_finance_supplier_stats_missing']) {
    const r = await request('owner', `/${view}?select=*`)
    expect(r.status >= 400,
      `FE nuevo + DB vieja · ${view}: una vista ausente tiene que dar error (dio ${r.status}), no datos`)
  }
  console.log('  ✓ las vistas ausentes dan error de lectura, no filas vacías')
  console.log('    → el service lo mapea a outstanding=null (restringido), cubierto por')
  console.log('      tests/components/sec08cSupplierFinanceTruth.test.tsx')

  // OJO: nada de backticks dentro de este bloque. Un '*' entre backticks
  // cerraba el template literal antes de tiempo y el resto se evaluaba como
  // una multiplicacion de strings: la conclusion se imprimia como "NaN".
  console.log('')
  console.log('=== CONCLUSION DE ROLLOUT ===')
  console.log('  FE viejo + DB nueva : COMPATIBLE. Ninguna forma actual recibe 403;')
  console.log('                        solo se filtran filas. El cashier incluso mejora.')
  console.log('  FE nuevo + DB vieja : DEGRADADO. Las dos vistas no existen y todo se')
  console.log('                        muestra como restringido. No hay cero falso, pero')
  console.log('                        el negocio se queda sin ver su deuda.')
  console.log('')
  console.log('  ORDEN REQUERIDO: DB PRIMERO, despues frontend.')
  console.log('')
  console.log('  Es la INVERSA de SEC-08A y SEC-08B, que exigian frontend-primero porque')
  console.log('  revocaban COLUMNAS y el asterisco del cliente viejo devolvia 42501. Este')
  console.log('  lote no revoca ninguna columna: mueve predicados de RLS, que filtran FILAS.')
  console.log('')
  console.log(`  ${checks} aserciones.`)
}

const cleanup = () => {
  if (!seeded) return
  try {
    sql(`
      BEGIN;
      SET session_replication_role=replica;
      DELETE FROM public.supplier_account_movements WHERE business_id='${ids.A}';
      DELETE FROM public.supplier_payments WHERE business_id='${ids.A}';
      DELETE FROM public.supplier_purchase_items WHERE business_id='${ids.A}';
      DELETE FROM public.supplier_purchases WHERE business_id='${ids.A}';
      DELETE FROM public.suppliers WHERE business_id='${ids.A}';
      DELETE FROM public.profiles WHERE business_id='${ids.A}';
      DELETE FROM public.businesses WHERE id='${ids.A}';
      DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
      COMMIT;
    `)
  } catch (e) { console.error('cleanup:', e.message) }
}

main().then(() => { cleanup(); process.exit(0) })
  .catch(e => { cleanup(); console.error('\nSEC-08C compat FALLÓ:', e.message); process.exit(1) })
