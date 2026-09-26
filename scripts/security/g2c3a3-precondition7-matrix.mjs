#!/usr/bin/env node
// G2-C.3A3 · matriz de la PRECONDICION 7 (compatibilidad PostgreSQL 17 MAINTAIN).
//
// El rollout de #150 se detuvo en el preflight: produccion (PG17) conserva
// MAINTAIN para anon y authenticated sobre public.inventory; el replay local
// no. La PRECONDICION 7 lo tolera como OPCIONAL exactamente para esas dos filas.
// Esta matriz prueba que la tolerancia es opcional (presente o ausente pasa),
// que no se volvio una comparacion parcial (todo otro drift aborta) y que A3 no
// concede ni revoca MAINTAIN.
//
// Cada caso ejecuta la migracion A3 REAL (el archivo, sin BEGIN/COMMIT) dentro
// de BEGIN ... ROLLBACK sobre una base en estado A1 (A3 sin aplicar). Nada
// persiste. En los casos que pasan, el NOTICE final de A3 implica P1-P18.
//
//   node scripts/security/g2c3a3-precondition7-matrix.mjs
//   (requiere el stack local con A3 SIN aplicar: head del ledger = A1)
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
const CT = process.env.G2C3A3_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(CT)) { console.error(`ABORTADO: ${CT} no es un contenedor de Supabase local`); process.exit(2) }

// G2C3A3_MIGRATION permite correr la matriz contra OTRA version del archivo (p. ej.
// la A3 previa al hotfix, como control negativo). Por defecto: la del repo.
const MIG = process.env.G2C3A3_MIGRATION || 'supabase/migrations/20261009120000_g2c3a3_inventory_authority_lockdown.sql'
const src = readFileSync(MIG, 'utf8')
const ini = src.search(/^BEGIN;$/m), fin = src.lastIndexOf('\nCOMMIT;')
if (ini < 0 || fin < 0) { console.error('No se encontro BEGIN;/COMMIT; en la migracion A3'); process.exit(2) }
const BODY = src.slice(ini + 'BEGIN;'.length, fin)

const psql = (sql) => spawnSync('docker', ['exec', '-i', CT, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1'],
  { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

// Estado requerido: A1 aplicada, A3 no (ni registrada ni sus objetos).
const pre = psql(`SELECT (SELECT max(version) FROM supabase_migrations.schema_migrations)
  || '|' || (SELECT count(*) FROM pg_trigger WHERE tgname IN ('zz_inventory_stock_authority_guard','trg_inventory_movements_append_only'))
  || '|' || (SELECT relacl::text FROM pg_class WHERE oid = 'public.inventory'::regclass);`)
const [head, trg, acl0] = pre.stdout.trim().split('|')
if (pre.status !== 0 || head !== '20261008120000' || trg !== '0') {
  console.error(`ABORTADO: la base local no esta en estado A1 (head=${head}, triggers A3=${trg}). Levantar el stack con A3 apartada.`)
  process.exit(2)
}
console.log(`Migracion: ${MIG}\nEstado A1 verificado · ACL base de inventory: ${acl0}\n`)

// Privilegios observados antes y despues de A3 (misma transaccion).
const PRIV = `
SELECT 'PRIV|' || r || '|' || p || '|' || has_table_privilege(r, 'public.inventory', p)
  FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['MAINTAIN','INSERT','UPDATE']) p;
SELECT 'COL|' || r || '|' || c || '|' || k || '|' || has_column_privilege(r, 'public.inventory', c, k)
  FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['stock','stock_quantity']) c, unnest(ARRAY['INSERT','UPDATE']) k;
`
const leer = (out, fase) => Object.fromEntries(out.split('\n').filter((l) => l.startsWith(`${fase}:`)).map((l) => {
  const [, kind, ...rest] = l.split('|'); const v = rest.pop(); return [`${kind}|${rest.join('|')}`, v === 'true']
}))

function correr(setup) {
  const sql = [
    'BEGIN;',
    setup,
    PRIV.replace(/'PRIV\|'/g, "'ANTES:|PRIV|'").replace(/'COL\|'/g, "'ANTES:|COL|'"),
    BODY,
    PRIV.replace(/'PRIV\|'/g, "'DESPUES:|PRIV|'").replace(/'COL\|'/g, "'DESPUES:|COL|'"),
    'ROLLBACK;',
  ].join('\n')
  const r = psql(sql)
  const out = (r.stdout || '') + '\n' + (r.stderr || '')
  return {
    ok: r.status === 0,
    notice: /G2-C\.3A3 OK/.test(out),
    err: (out.match(/ERROR:\s+(.*)/) || [])[1] || '',
    antes: leer(r.stdout || '', 'ANTES'),
    despues: leer(r.stdout || '', 'DESPUES'),
  }
}

let fallas = 0, checks = 0
const check = (cond, label) => { checks++; if (cond) console.log(`   PASS  ${label}`); else { fallas++; console.log(`   FAIL  ${label}`) } }
const maintain = (m, r) => m[`PRIV|${r}|MAINTAIN`]
const sinEscritura = (m) => ['anon', 'authenticated'].every((r) =>
  !m[`PRIV|${r}|INSERT`] && !m[`PRIV|${r}|UPDATE`]
  && ['stock', 'stock_quantity'].every((c) => !m[`COL|${r}|${c}|INSERT`] && !m[`COL|${r}|${c}|UPDATE`]))

const PROD = 'GRANT MAINTAIN ON TABLE public.inventory TO anon, authenticated;'
const CASOS = [
  // [id, descripcion, setup, espera PASS, MAINTAIN esperado {anon, authenticated} antes=despues]
  ['A', 'baseline local sin MAINTAIN (replay normal)', '', true, { anon: false, authenticated: false }],
  ['B', 'production-like: MAINTAIN para anon y authenticated en inventory', PROD, true, { anon: true, authenticated: true }],
  ['C', 'solo anon tiene MAINTAIN en inventory', 'GRANT MAINTAIN ON TABLE public.inventory TO anon;', true, { anon: true, authenticated: false }],
  ['D', 'solo authenticated tiene MAINTAIN en inventory', 'GRANT MAINTAIN ON TABLE public.inventory TO authenticated;', true, { anon: false, authenticated: true }],
  ['E1', 'MAINTAIN inesperado: service_role en inventory', 'GRANT MAINTAIN ON TABLE public.inventory TO service_role;', false],
  ['E2', 'MAINTAIN inesperado: anon en inventory_movements', 'GRANT MAINTAIN ON TABLE public.inventory_movements TO anon;', false],
  ['E3', 'MAINTAIN inesperado: authenticated en inventory_movements', 'GRANT MAINTAIN ON TABLE public.inventory_movements TO authenticated;', false],
  ['E4', 'MAINTAIN inesperado: PUBLIC en inventory', 'GRANT MAINTAIN ON TABLE public.inventory TO PUBLIC;', false],
  ['E5', 'production-like + service_role MAINTAIN en inventory (lo tolerado no enmascara)', `${PROD}\nGRANT MAINTAIN ON TABLE public.inventory TO service_role;`, false],
  ['F1', 'privilegio extra: SELECT de tabla a authenticated en inventory (reabriria el costo)', 'GRANT SELECT ON TABLE public.inventory TO authenticated;', false],
  ['F2', 'privilegio extra: REFERENCES a authenticated en inventory_movements', 'GRANT REFERENCES ON TABLE public.inventory_movements TO authenticated;', false],
  ['F3', 'production-like + TRUNCATE a authenticated en inventory_movements', `${PROD}\nGRANT TRUNCATE ON TABLE public.inventory_movements TO authenticated;`, false],
  ['F4', 'privilegio del baseline faltante: anon sin TRIGGER en inventory', 'REVOKE TRIGGER ON TABLE public.inventory FROM anon;', false],
  ['F5', 'production-like + baseline faltante: authenticated sin REFERENCES en inventory', `${PROD}\nREVOKE REFERENCES ON TABLE public.inventory FROM authenticated;`, false],
  // Control: P7 nunca evaluo tablas fuera de A3 (produccion tiene MAINTAIN en otras 15-25 tablas).
  ['G', 'control: MAINTAIN en una tabla fuera del alcance de A3 (customers)', `${PROD}\nGRANT MAINTAIN ON TABLE public.customers TO anon, authenticated, service_role;`, true, { anon: true, authenticated: true }],
]

for (const [id, desc, setup, pasa, esperado] of CASOS) {
  console.log(`── Caso ${id} · ${desc}`)
  const r = correr(setup)
  if (pasa) {
    // 6 filas PRIV + 8 filas COL antes y despues: si el parser no las lee, el caso no prueba nada.
    check(Object.keys(r.antes).length === 14 && (!r.ok || Object.keys(r.despues).length === 14),
      `${id}: se leyeron los 14 privilegios antes${r.ok ? ' y despues' : ''} de A3`)
    check(r.ok && r.notice, `${id}: A3 aplica completa (13 precondiciones + NOTICE final = P1-P18)${r.ok ? '' : ` — ${r.err}`}`)
    if (r.ok) {
      for (const role of ['anon', 'authenticated']) {
        check(maintain(r.antes, role) === esperado[role] && maintain(r.despues, role) === esperado[role],
          `${id}: ${role} MAINTAIN antes=${maintain(r.antes, role)} despues=${maintain(r.despues, role)} (A3 no lo concede ni revoca)`)
      }
      check(['anon', 'authenticated'].every((x) => r.antes[`PRIV|${x}|INSERT`] && r.antes[`PRIV|${x}|UPDATE`]),
        `${id}: antes de A3 anon/authenticated tenian INSERT/UPDATE de tabla (la transicion es real)`)
      check(sinEscritura(r.despues), `${id}: despues de A3 anon/authenticated sin INSERT/UPDATE de tabla ni de stock/stock_quantity`)
    }
  } else {
    check(!r.ok && /PRECONDICION 7/.test(r.err) && !r.notice, `${id}: aborta en PRECONDICION 7 (${r.err.slice(0, 110)})`)
  }
}

// Nada persistio: el ACL de inventory sigue siendo el del inicio.
const post = psql(`SELECT relacl::text FROM pg_class WHERE oid = 'public.inventory'::regclass;`).stdout.trim()
check(post === acl0, `la matriz no dejo rastro (ACL de inventory = ${post})`)

console.log(`\n${checks} verificaciones · ${fallas} fallas`)
if (fallas) process.exit(1)
console.log('G2-C.3A3 PRECONDICION 7 · matriz PG17 MAINTAIN OK')
