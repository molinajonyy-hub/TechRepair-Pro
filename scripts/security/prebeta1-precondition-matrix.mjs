#!/usr/bin/env node
// PRE-BETA-1 · matriz de PRECONDICIONES (fail-closed) de la migracion
// 20261010120000_prebeta1_public_users_api_retirement.sql.
//
// Cada caso ejecuta el cuerpo REAL de la migracion (el archivo, sin
// BEGIN/COMMIT) dentro de BEGIN ... ROLLBACK sobre una base en estado A3
// (PRE-BETA-1 sin aplicar). Nada persiste.
//   · Los casos que PASAN prueban que el estado de produccion medido en el
//     discovery (MAINTAIN de PG17 para anon/authenticated, 3 filas huerfanas)
//     aplica completo y que el cierre es real (antes: acceso; despues: nada).
//   · Los casos que ABORTAN prueban que cada drift frena la migracion en SU
//     precondicion, sin tocar nada: no hay adaptacion.
//
//   node scripts/security/prebeta1-precondition-matrix.mjs
//   (requiere el stack local con PRE-BETA-1 SIN aplicar: head del ledger = A3)
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
const CT = process.env.PREBETA1_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(CT)) { console.error(`ABORTADO: ${CT} no es un contenedor de Supabase local`); process.exit(2) }

const MIG = 'supabase/migrations/20261010120000_prebeta1_public_users_api_retirement.sql'
const src = readFileSync(MIG, 'utf8')
const ini = src.search(/^BEGIN;$/m), fin = src.lastIndexOf('\nCOMMIT;')
if (ini < 0 || fin < 0) { console.error('No se encontro BEGIN;/COMMIT; en la migracion'); process.exit(2) }
const BODY = src.slice(ini + 'BEGIN;'.length, fin)

const psql = (sql) => spawnSync('docker', ['exec', '-i', CT, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1'],
  { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const pre = psql(`SELECT (SELECT max(version) FROM supabase_migrations.schema_migrations)
  || '|' || (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.users'::regclass)
  || '|' || (SELECT relacl::text FROM pg_class WHERE oid = 'public.users'::regclass);`)
const [head, pols, acl0] = pre.stdout.trim().split('|')
if (pre.status !== 0 || head !== '20261009120000' || pols !== '4') {
  console.error(`ABORTADO: la base local no esta en estado A3 sin PRE-BETA-1 (head=${head}, policies=${pols}).`)
  process.exit(2)
}
console.log(`Migracion: ${MIG}\nEstado A3 verificado · ACL base de public.users: ${acl0}\n`)

// Acceso observado antes y despues (misma transaccion).
const ACCESO = (fase) => `
SELECT '${fase}|' || r || '|' || has_table_privilege(r, 'public.users', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
  FROM unnest(ARRAY['anon','authenticated','service_role']) r;
SELECT '${fase}|policies|' || (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.users'::regclass);
SELECT '${fase}|filas|' || (SELECT count(*) FROM public.users);`
const leer = (out, fase) => Object.fromEntries(out.split('\n').filter((l) => l.startsWith(`${fase}|`)).map((l) => {
  const [, k, v] = l.split('|'); return [k, v]
}))

function correr(setup) {
  const r = psql(['BEGIN;', setup, ACCESO('ANTES'), BODY, ACCESO('DESPUES'), 'ROLLBACK;'].join('\n'))
  const out = (r.stdout || '') + '\n' + (r.stderr || '')
  return {
    ok: r.status === 0,
    notice: /PRE-BETA-1 OK/.test(out),
    err: (out.match(/ERROR:\s+(.*)/) || [])[1] || '',
    antes: leer(r.stdout || '', 'ANTES'),
    despues: leer(r.stdout || '', 'DESPUES'),
  }
}

let fallas = 0, checks = 0
const check = (cond, label) => { checks++; if (cond) console.log(`   PASS  ${label}`); else { fallas++; console.log(`   FAIL  ${label}`) } }

// Estado de produccion medido: MAINTAIN (PG17) y 3 filas sin relacion con auth/profiles.
const PROD = `
GRANT MAINTAIN ON TABLE public.users TO anon, authenticated;
INSERT INTO public.users (name, email, role, phone) VALUES
  ('Legacy 1', 'legacy1@prebeta1-matrix.invalid', 'admin', '0'),
  ('Legacy 2', 'legacy2@prebeta1-matrix.invalid', 'technician', '0'),
  ('Legacy 3', 'legacy3@prebeta1-matrix.invalid', 'technician', '0');`
const CASOS = [
  // [id, descripcion, setup, precondicion que debe abortar (null = debe pasar), filas esperadas]
  ['A', 'replay local (sin MAINTAIN, sin filas)', '', null, '0'],
  ['B', 'production-like: MAINTAIN anon/authenticated + 3 filas huerfanas', PROD, null, '3'],
  ['C', 'solo anon tiene MAINTAIN', 'GRANT MAINTAIN ON TABLE public.users TO anon;', null, '0'],
  ['P1a', 'FORCE RLS activado', 'ALTER TABLE public.users FORCE ROW LEVEL SECURITY;', 'PRECONDICION 1'],
  ['P1b', 'RLS desactivado', 'ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;', 'PRECONDICION 1'],
  ['P2', 'PRE-BETA-1 ya registrada en el ledger', "INSERT INTO supabase_migrations.schema_migrations(version, name) VALUES ('20261010120000', 'prebeta1_public_users_api_retirement');", 'PRECONDICION 2'],
  ['P3', 'columna nueva (business_id) — el discovery ya no vale', 'ALTER TABLE public.users ADD COLUMN business_id uuid;', 'PRECONDICION 3'],
  ['P4', 'nueva FK entrante desde otra tabla', 'CREATE TABLE public._pb1_ref (u uuid REFERENCES public.users(id));', 'PRECONDICION 4'],
  ['P5a', 'PRE-BETA-1 parcial: falta users_select', 'DROP POLICY users_select ON public.users;', 'PRECONDICION 5'],
  ['P5b', 'policy reescrita (USING created_by = auth.uid())', 'ALTER POLICY users_select ON public.users USING (created_by = auth.uid());', 'PRECONDICION 5'],
  ['P5c', 'policy extra', 'CREATE POLICY users_extra ON public.users FOR SELECT TO anon USING (true);', 'PRECONDICION 5'],
  ['P6a', 'SELECT extra a service_role', 'GRANT SELECT ON TABLE public.users TO service_role;', 'PRECONDICION 6'],
  ['P6b', 'SELECT extra a PUBLIC', 'GRANT SELECT ON TABLE public.users TO PUBLIC;', 'PRECONDICION 6'],
  ['P6c', 'production-like + MAINTAIN a service_role (lo tolerado no enmascara)', `${PROD}\nGRANT MAINTAIN ON TABLE public.users TO service_role;`, 'PRECONDICION 6'],
  ['P6d', 'baseline faltante: authenticated sin TRUNCATE (REVOKE parcial)', 'REVOKE TRUNCATE ON TABLE public.users FROM authenticated;', 'PRECONDICION 6'],
  ['P6e', 'privilegio de columna SELECT(name) a authenticated', 'GRANT SELECT (name) ON TABLE public.users TO authenticated;', 'PRECONDICION 6'],
  ['P7a', 'vista sobre public.users', 'CREATE VIEW public._pb1_v AS SELECT id, name FROM public.users;', 'PRECONDICION 7'],
  ['P7b', 'funcion que lee public.users', "CREATE FUNCTION public._pb1_f() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM public.users';", 'PRECONDICION 7'],
  ['P7c', 'funcion que lee users sin calificar', "CREATE FUNCTION private._pb1_g() RETURNS bigint LANGUAGE plpgsql SET search_path = public AS $f$ BEGIN RETURN (SELECT count(*) FROM users); END $f$;", 'PRECONDICION 7'],
  ['P7d', 'trigger sobre public.users', "CREATE FUNCTION private._pb1_t() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$; CREATE TRIGGER _pb1 BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION private._pb1_t();", 'PRECONDICION 7'],
  ['P7e', 'public.users en la publicacion realtime', 'CREATE PUBLICATION _pb1_pub FOR TABLE public.users;', 'PRECONDICION 7'],
  ['P8', 'una orden empezo a usar technician_id', `
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.users (id, name, email, role) VALUES ('00000000-0000-0000-0000-00000b1a0e01', 'T', 't@prebeta1-matrix.invalid', 'technician');
    INSERT INTO public.businesses (id, name, subscription_plan, subscription_status) VALUES ('00000000-0000-0000-0000-00000b1a0e02', 'M', 'pro', 'active');
    INSERT INTO public.orders (business_id, technician_id) VALUES ('00000000-0000-0000-0000-00000b1a0e02', '00000000-0000-0000-0000-00000b1a0e01');
    SET LOCAL session_replication_role = origin;`, 'PRECONDICION 8'],
  // Control: una tabla FUERA del alcance con el mismo drift no afecta.
  ['Z', 'control: MAINTAIN/SELECT extra en otra tabla (customers)', `${PROD}\nGRANT MAINTAIN ON TABLE public.customers TO service_role;`, null, '3'],
]

for (const [id, desc, setup, aborta, filas] of CASOS) {
  console.log(`── Caso ${id} · ${desc}`)
  const r = correr(setup)
  if (!aborta) {
    check(r.ok && r.notice, `${id}: la migracion aplica completa (8 precondiciones + 4 postcondiciones)${r.ok ? '' : ` — ${r.err}`}`)
    if (r.ok) {
      check(r.antes.anon === 'true' && r.antes.authenticated === 'true' && r.antes.policies === '4',
        `${id}: antes, anon/authenticated tenian acceso y habia 4 policies (la transicion es real)`)
      check(['anon', 'authenticated', 'service_role'].every((x) => r.despues[x] === 'false') && r.despues.policies === '0',
        `${id}: despues, anon/authenticated/service_role sin ningun privilegio (MAINTAIN incluido) y 0 policies`)
      check(r.antes.filas === filas && r.despues.filas === filas, `${id}: filas ${r.antes.filas} -> ${r.despues.filas} (cero DML)`)
    }
  } else {
    check(!r.ok && r.err.includes(aborta) && !r.notice, `${id}: aborta en ${aborta} (${r.err.slice(0, 110)})`)
  }
}

const post = psql(`SELECT relacl::text || '|' || (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.users'::regclass)
  FROM pg_class WHERE oid = 'public.users'::regclass;`).stdout.trim()
check(post === `${acl0}|4`, `la matriz no dejo rastro (ACL = ${post.split('|')[0]}, policies = ${post.split('|')[1]})`)

console.log(`\n${checks} verificaciones · ${fallas} fallas`)
if (fallas) process.exit(1)
console.log('PRE-BETA-1 · matriz de precondiciones OK')
