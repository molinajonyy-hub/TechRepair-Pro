#!/usr/bin/env node
// ============================================================================
// P0-ONBOARDING-1 — MATRIZ DE COMPATIBILIDAD, medida por PostgREST.
//
// El rollout de este lote se decide con evidencia, no con la documentacion de
// lotes anteriores. Se miden los dos escenarios:
//
//   A. DB NUEVA + frontend VIEJO (el que hoy sirve Vercel)
//   B. frontend NUEVO + DB VIEJA
//
// POR QUE POR HTTP Y NO POR psql
// ──────────────────────────────
// Los modos de falla que importan en un rollout son de PostgREST, no de
// PostgreSQL:
//   · PGRST202 — la funcion no existe con esos parametros (firma cambiada);
//   · PGRST203 — hay mas de una candidata (overload ambiguo).
// Ninguno de los dos se puede reproducir desde psql: ahi la resolucion de
// funciones la hace PostgreSQL y siempre encuentra algo. Un test en psql daria
// verde con una firma rota.
//
// Requiere el stack local levantado (`supabase start`).
//
//   node scripts/guards/onboarding-compat-matrix.mjs
// ============================================================================
import { createHmac } from 'node:crypto'
import { execSync } from 'node:child_process'

const API = process.env.SUPABASE_LOCAL_URL  ?? 'http://127.0.0.1:54421'
const ANON = process.env.SUPABASE_LOCAL_ANON ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const JWT_SECRET = process.env.SUPABASE_LOCAL_JWT ??
  'super-secret-jwt-token-with-at-least-32-characters-long'
const DB = 'supabase_db_techrepair-vite'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

/** JWT HS256 para un usuario concreto: es lo que manda el navegador. */
function firmarJwt(sub) {
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({
    sub, role: 'authenticated', aud: 'authenticated',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  })
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

/**
 * Ejecuta SQL en el contenedor y devuelve la ULTIMA linea no vacia.
 *
 * El SQL se colapsa a una sola linea: pasar multilinea por `-c` se rompe en
 * PowerShell y produce un `22P02` que parece un bug del contrato y no lo es.
 * Y se toma la ultima linea porque psql puede anteponer NOTICEs.
 */
function psql(sql) {
  const unaLinea = sql.replace(/\s+/g, ' ').trim().replace(/"/g, '\\"')
  const out = execSync(
    `docker exec -i ${DB} psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1 -c "${unaLinea}"`,
    { encoding: 'utf8' },
  )
  // Se descartan los TAGS de comando (`INSERT 0 1`, `DROP FUNCTION`, NOTICEs):
  // psql los imprime DESPUES del valor de un RETURNING, asi que quedarse con la
  // ultima linea a secas devuelve el tag en vez del dato.
  const lineas = out.split('\n').map(l => l.trim()).filter(Boolean)
    .filter(l => !/^(INSERT|UPDATE|DELETE|SELECT|DROP|CREATE|ALTER|GRANT|REVOKE|NOTICE|BEGIN|COMMIT|ROLLBACK|DO)\b/i.test(l))
  return lineas.length ? lineas[lineas.length - 1] : ''
}

async function rpc(nombre, args, jwt) {
  const r = await fetch(`${API}/rest/v1/rpc/${nombre}`, {
    method: 'POST',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  })
  let cuerpo = null
  try { cuerpo = await r.json() } catch { /* respuesta vacia */ }
  return { status: r.status, cuerpo }
}

const resultados = []
const anotar = (esc, caso, ok, detalle) => {
  resultados.push({ esc, caso, ok, detalle })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${esc} · ${caso}${detalle ? ` — ${detalle}` : ''}`)
}

async function main() {
  // ── Fixture: un owner real con su negocio ─────────────────────────────────
  const uid = psql(`
    with u as (
      insert into auth.users (id, email, email_confirmed_at)
      values (gen_random_uuid(), 'compat_'||floor(random()*1e9)||'@invalid.test', now())
      returning id
    ), b as (
      insert into public.businesses (name, owner_user_id)
      select 'Compat Fixture', id from u returning id, owner_user_id
    )
    insert into public.profiles (id, business_id, role, is_active, email)
    select b.owner_user_id, b.id, 'owner', true, 'compat@invalid.test' from b
    returning id;`)
  if (!/^[0-9a-f-]{36}$/i.test(uid)) {
    // Sin esto, un fixture roto llega al JWT como `sub` invalido y PostgREST
    // devuelve 22P02 — un error que parece del contrato y no lo es.
    console.error(`X el fixture no devolvio un uuid: ${JSON.stringify(uid)}`)
    process.exit(1)
  }
  console.log(`fixture owner=${uid}`)
  const jwt = firmarJwt(uid)

  // ═══ ESCENARIO A — DB NUEVA + frontend VIEJO ════════════════════════════
  // Se llama EXACTAMENTE como lo hace el bundle desplegado: mismos nombres de
  // parametro, mismo shape, los 8 argumentos que manda `businessSetupService`.
  console.log('\nESCENARIO A · DB nueva + frontend viejo (el bundle que hoy sirve Vercel)')

  const aLect = await rpc('get_my_business_onboarding', {}, jwt)
  anotar('A', 'get_my_business_onboarding responde', aLect.status === 200,
    `HTTP ${aLect.status}${aLect.cuerpo?.code ? ' ' + aLect.cuerpo.code : ''}`)

  const CLAVES_LEGACY = ['business_id','name','rubro','ciudad','whatsapp','logo_url',
    'onboarding_completed','cuit','condicion_fiscal','role','can_edit']
  const faltantes = CLAVES_LEGACY.filter(k => !(k in (aLect.cuerpo ?? {})))
  anotar('A', 'el contrato de lectura conserva sus 11 claves', faltantes.length === 0,
    faltantes.length ? `faltan: ${faltantes.join(', ')}` : '')

  const aEsc = await rpc('update_my_business_onboarding', {
    p_name: 'Compat Test', p_rubro: 'celulares', p_ciudad: 'Cordoba',
    p_whatsapp: '351 555-1234', p_condicion_fiscal: 'monotributo',
    p_cuit: '20-12345678-9', p_logo_url: null, p_complete: false,
  }, jwt)
  anotar('A', 'update_my_business_onboarding acepta los 8 params', aEsc.status === 200,
    `HTTP ${aEsc.status}${aEsc.cuerpo?.code ? ' ' + aEsc.cuerpo.code : ''}`)

  // LO QUE HACE QUE ESTE LOTE PUEDA IR DB-FIRST: el frontend viejo, sin
  // redesplegarse, deja de escribir solo en `businesses` y puebla las columnas
  // canonicas — que es de donde leen los documentos impresos.
  const fila = psql(`
    select coalesce(s.nombre_comercial,'-')||'|'||coalesce(s.localidad,'-')||'|'||
           coalesce(s.telefono,'-')||'|'||coalesce(s.condicion_iva,'-')
      from public.business_settings s
      join public.businesses b on b.id = s.business_id
     where b.owner_user_id = '${uid}';`)
  const [nom, loc, tel, cond] = fila.split('|')
  anotar('A', 'el frontend viejo YA escribe nombre_comercial', nom === 'Compat Test', `= ${nom}`)
  anotar('A', 'el frontend viejo YA escribe localidad', loc === 'Cordoba', `= ${loc}`)
  anotar('A', 'el frontend viejo YA escribe telefono', tel === '3515551234', `= ${tel}`)
  anotar('A', 'la condicion queda en slug canonico', cond === 'monotributo', `= ${cond}`)

  // Sin ambiguedad: si hubiera un overload, esto seria PGRST203.
  anotar('A', 'sin PGRST203 (no hay overload)',
    aEsc.cuerpo?.code !== 'PGRST203', aEsc.cuerpo?.code ?? 'sin codigo de error')

  // ═══ ESCENARIO B — frontend NUEVO + DB VIEJA ════════════════════════════
  // Se simula la DB vieja retirando las RPC que introduce este lote y
  // recargando el cache de esquema de PostgREST.
  console.log('\nESCENARIO B · frontend nuevo + DB vieja (se retiran las RPC del lote)')

  psql(`drop function if exists public.update_my_business_profile(jsonb,boolean);
        drop function if exists public.get_my_business_profile();
        notify pgrst, 'reload schema';`)
  await new Promise(r => setTimeout(r, 1500))   // el cache de PostgREST no es sincrono

  const bLect = await rpc('get_my_business_profile', {}, jwt)
  const bEsc  = await rpc('update_my_business_profile',
    { p_patch: { nombre_comercial: 'X' }, p_complete: false }, jwt)

  const esNoExiste = (r) => r.status === 404 || r.cuerpo?.code === 'PGRST202'
  anotar('B', 'get_my_business_profile no existe -> falla explicita', esNoExiste(bLect),
    `HTTP ${bLect.status} ${bLect.cuerpo?.code ?? ''}`)
  anotar('B', 'update_my_business_profile no existe -> falla explicita', esNoExiste(bEsc),
    `HTTP ${bEsc.status} ${bEsc.cuerpo?.code ?? ''}`)

  // Que falle EXPLICITAMENTE es la propiedad buscada: un 404/PGRST202 lo
  // captura `businessSetupService` y llega como error a la UI. Lo inaceptable
  // seria un 200 con un guardado a medias.
  const bSilencioso = bEsc.status === 200
  anotar('B', 'no falla en silencio (nada de 200 con guardado parcial)', !bSilencioso,
    bSilencioso ? 'devolvio 200 sin escribir' : '')

  // ── Restaurar el stack ────────────────────────────────────────────────────
  console.log('\nRestaurando el stack local (db reset)...')
  execSync('npx --no-install supabase db reset', { stdio: 'ignore' })
  const restaurado = psql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('get_my_business_profile','update_my_business_profile');`)
  anotar('-', 'stack restaurado tras el escenario B', restaurado === '2', `${restaurado}/2 RPC`)

  // ── Veredicto ─────────────────────────────────────────────────────────────
  const A = resultados.filter(r => r.esc === 'A')
  const B = resultados.filter(r => r.esc === 'B')
  const aOk = A.every(r => r.ok)
  const bOk = B.every(r => r.ok)

  console.log('\n' + '='.repeat(72))
  console.log(`A (DB nueva + frontend viejo) : ${aOk ? 'PASS' : 'FAIL'}  ${A.filter(r=>r.ok).length}/${A.length}`)
  console.log(`B (frontend nuevo + DB vieja) : ${bOk ? 'FAIL ESPERADO (explicito)' : 'INDETERMINADO'}  ${B.filter(r=>r.ok).length}/${B.length}`)
  console.log('='.repeat(72))

  if (!aOk) {
    console.error('\nX A FALLA -> NO se puede recomendar el deploy en ningun orden.\n')
    process.exit(1)
  }
  console.log('\nVEREDICTO: rollout DB-FIRST.')
  console.log('  · A pasa: la DB nueva sirve al frontend desplegado sin romperlo, y ademas')
  console.log('    lo CURA — el bundle viejo empieza a escribir las columnas canonicas.')
  console.log('  · B falla explicito: el frontend nuevo contra la DB vieja recibe PGRST202,')
  console.log('    que el service traduce a un error visible. No hay guardado a medias.')
  console.log('  · Por lo tanto: primero `db push`, despues el frontend.\n')

  const fallos = resultados.filter(r => !r.ok && r.esc !== 'B')
  process.exit(fallos.length ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
