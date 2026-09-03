#!/usr/bin/env node
// SEC-08B Fase 17 — MATRIZ DE COMPATIBILIDAD DE ROLLOUT.
//
// No se asume el orden de despliegue de SEC-08A: se mide. Las tres
// combinaciones se ejercitan contra el PostgREST local con actores reales.
//
//   FE nuevo + DB nueva   → el estado final
//   FE viejo + DB nueva   → la ventana si la DB va PRIMERO
//   FE nuevo + DB vieja   → la ventana si el FRONTEND va PRIMERO
//
// «FE viejo» se representa por las consultas que el bundle desplegado HOY hace:
// `select('*')` sobre inventory y la columna `cost_price` explícita. «DB vieja»
// se representa reponiendo el GRANT de tabla y escondiendo las proyecciones
// autorizadas — sin tocar las vistas de finanzas, que siguen dependiendo de
// ellas por OID y por eso se RENOMBRAN en vez de borrarse.
//
// La restauración es re-aplicar la migración: es la única forma de volver a un
// estado que se sabe correcto, en vez de deshacer a mano.
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
const reloadRest = async () => { sql(`NOTIFY pgrst, 'reload schema';`); await new Promise(r => setTimeout(r, 1000)) }

const ACTORS = ['owner', 'sales']
const ids = Object.fromEntries([...ACTORS, 'A', 'prod'].map(n => [n, randomUUID()]))
const COST = 61011
const SALE = 64044
const TAG = 'sec08b-compat.invalid'

let seeded = false, degraded = false

const main = async () => {
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const hostPort = kong.NetworkSettings.Ports?.['8000/tcp']?.[0]?.HostPort
  assert(vars.PGRST_JWT_SECRET && hostPort, 'Falta configuración de PostgREST local (¿kong sin puerto publicado?)')
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
  const req = async (actor, path) => {
    const r = await fetch(apiUrl + path, { headers: { Authorization: `Bearer ${token(actor)}` }, signal: AbortSignal.timeout(15000) })
    return { status: r.status, text: await r.text() }
  }

  // ── Fixture ────────────────────────────────────────────────────────────────
  sql(`
    BEGIN;
    SET session_replication_role=replica;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
      ('${ids.owner}','owner@${TAG}',now()),('${ids.sales}','sales@${TAG}',now());
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status)
      VALUES ('${ids.A}','COMPAT','${ids.owner}','pro','active');
    INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES
      ('${ids.owner}','${ids.A}','owner',true,'owner@${TAG}'),
      ('${ids.sales}','${ids.A}','sales',true,'sales@${TAG}');
    INSERT INTO public.inventory(id,business_id,code,name,category,cost_price,cost_price_usd,sale_price,stock_quantity,is_active)
      VALUES ('${ids.prod}','${ids.A}','COMPAT-1','Compat','cat',${COST},0,${SALE},5,true);
    COMMIT;
  `)
  seeded = true

  // Consultas que representan cada bundle.
  const FE_NUEVO_OPERATIVO = `/inventory?id=eq.${ids.prod}&select=id,code,name,sale_price,stock_quantity,is_active`
  const FE_NUEVO_COSTO     = `/v_inventory_costs?inventory_id=eq.${ids.prod}&select=cost_price`
  const FE_VIEJO_LISTA     = `/inventory?id=eq.${ids.prod}&select=*`
  const FE_VIEJO_COSTO     = `/inventory?id=eq.${ids.prod}&select=id,name,cost_price`

  const medir = async etiqueta => ({
    etiqueta,
    feNuevoOperativo: await req('sales', FE_NUEVO_OPERATIVO),
    feNuevoCostoOwner: await req('owner', FE_NUEVO_COSTO),
    feViejoLista: await req('owner', FE_VIEJO_LISTA),
    feViejoCosto: await req('owner', FE_VIEJO_COSTO),
  })
  const linea = (n, r) => `    ${n.padEnd(22)} ${String(r.status).padEnd(5)} ${r.text.slice(0, 110).replace(/\s+/g, ' ')}`

  // ═══ A. DB NUEVA (estado final) ═════════════════════════════════════════
  await reloadRest()
  const nueva = await medir('DB NUEVA')
  console.log('\n=== A · DB NUEVA (SEC-08B aplicada) ===')
  console.log(linea('FE nuevo · operativo', nueva.feNuevoOperativo))
  console.log(linea('FE nuevo · costo', nueva.feNuevoCostoOwner))
  console.log(linea('FE VIEJO · select(*)', nueva.feViejoLista))
  console.log(linea('FE VIEJO · cost_price', nueva.feViejoCosto))

  assert(nueva.feNuevoOperativo.status === 200 && nueva.feNuevoOperativo.text.includes(String(SALE)),
    'FE nuevo + DB nueva: la lectura operativa tiene que seguir funcionando')
  assert(nueva.feNuevoCostoOwner.text.includes(String(COST)),
    'FE nuevo + DB nueva: el owner tiene que recibir el costo real')
  assert(nueva.feViejoLista.status === 403,
    `FE viejo + DB nueva: se esperaba que select(*) ROMPA con 403 y dio ${nueva.feViejoLista.status}`)
  assert(nueva.feViejoCosto.status === 403,
    `FE viejo + DB nueva: se esperaba que la columna de costo ROMPA con 403 y dio ${nueva.feViejoCosto.status}`)

  // ═══ B. DB VIEJA (pre-SEC-08B) ══════════════════════════════════════════
  // Se repone el GRANT de tabla y se esconden las proyecciones autorizadas.
  // RENAME y no DROP: las vistas de finanzas dependen de ellas por OID, así que
  // renombrarlas las deja funcionando y sólo las saca del alcance de PostgREST.
  degraded = true
  sql(`
    GRANT SELECT ON public.inventory TO authenticated;
    GRANT SELECT ON public.inventory_movements TO authenticated;
    GRANT SELECT ON public.comprobante_items TO authenticated;
    ALTER VIEW public.v_inventory_costs RENAME TO v_inventory_costs__compat_hidden;
  `)
  await reloadRest()
  const vieja = await medir('DB VIEJA')
  console.log('\n=== B · DB VIEJA (sin SEC-08B) ===')
  console.log(linea('FE nuevo · operativo', vieja.feNuevoOperativo))
  console.log(linea('FE nuevo · costo', vieja.feNuevoCostoOwner))
  console.log(linea('FE VIEJO · select(*)', vieja.feViejoLista))
  console.log(linea('FE VIEJO · cost_price', vieja.feViejoCosto))

  assert(vieja.feNuevoOperativo.status === 200 && vieja.feNuevoOperativo.text.includes(String(SALE)),
    'FE nuevo + DB vieja: la lectura operativa por columnas explícitas tiene que funcionar')
  assert(vieja.feNuevoCostoOwner.status >= 400,
    'FE nuevo + DB vieja: la proyección autorizada todavía no existe, y eso es lo que degrada el costo')
  assert(vieja.feViejoLista.status === 200,
    'FE viejo + DB vieja: es el estado de producción de hoy y tiene que funcionar')

  // ── Restauración: re-aplicar la migración ─────────────────────────────────
  restore()
  degraded = false
  await reloadRest()
  const restaurada = await medir('RESTAURADA')
  assert(restaurada.feViejoLista.status === 403 && restaurada.feNuevoCostoOwner.text.includes(String(COST)),
    'la restauración no dejó la base en el estado final')

  // ── Veredicto ─────────────────────────────────────────────────────────────
  console.log(`
=== VEREDICTO ===

  FE viejo + DB nueva  →  ROMPE (403 en el catálogo y en el costo).
                          El bundle desplegado hoy hace select('*') sobre
                          inventory: con la DB migrada, Inventario, el buscador
                          del POS y el alta de productos dejan de responder.

  FE nuevo + DB vieja  →  FUNCIONA, DEGRADADO. Lo operativo va por columnas
                          explícitas, que ya existen. La proyección de costo
                          todavía no, así que el costo se muestra como
                          restringido —fail-closed— hasta que entre la DB.

  ORDEN OBLIGATORIO:      FRONTEND primero, DB después.

  Ventana intermedia:     los actores AUTORIZADOS ven «Costo restringido» hasta
                          que corre el db push. Es visible pero seguro: nunca
                          se muestra $0 ni un margen inventado.
`)
}

const restore = () => {
  try {
    sql(`ALTER VIEW IF EXISTS public.v_inventory_costs__compat_hidden RENAME TO v_inventory_costs;`)
  } catch { /* ya estaba con el nombre bueno */ }
  const migration = readFileSync(MIGRATION, 'utf8')
  docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'], migration)
}

const cleanup = () => {
  if (degraded) { try { restore() } catch (e) { console.error('RESTAURACIÓN FALLÓ:', e.message) } }
  if (!seeded) return
  try {
    sql(`
      BEGIN;
      SET session_replication_role=replica;
      DELETE FROM public.inventory WHERE business_id='${ids.A}';
      DELETE FROM public.profiles WHERE business_id='${ids.A}';
      DELETE FROM public.businesses WHERE id='${ids.A}';
      DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
      COMMIT;
    `)
  } catch (e) { console.error('cleanup:', e.message) }
}

main().then(() => { cleanup(); process.exit(0) })
  .catch(e => { cleanup(); console.error('\nSEC-08B compat matrix FALLÓ:', e.message); process.exit(1) })
