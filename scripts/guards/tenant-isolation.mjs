#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Guard global de aislamiento de tenants (PRE-BETA-1 · anti-reincidencia).
//
// PRE-BETA-1 encontro public.users: una tabla GLOBAL (sin business_id) con PII,
// legible por cualquier authenticated (USING true) y escribible por el owner/
// admin de CUALQUIER negocio (policies que solo miraban el rol). Este guard
// busca esa clase de hueco en TODAS las tablas de `public`, no solo en users.
//
// MODO CATALOGO (default; requiere la base local levantada):
//   Lee el catalogo REAL (scripts/guards/tenant-isolation-catalog.sql, una sola
//   consulta SELECT) y, por cada tabla expuesta a anon/authenticated (privilegio
//   de tabla o de columna, con herencia), evalua cada policy PERMISSIVE que
//   aplica al rol y al comando que ese rol puede ejecutar:
//     R1 USING_TRUE        USING (true)
//     R2 CHECK_TRUE        WITH CHECK (true)
//     R3 SIN_ANCLA         la expresion no relaciona la fila con un tenant/self:
//                          no referencia una columna clave PROPIA (business_id,
//                          id, user_id, owner_user_id, auth_user_id, created_by,
//                          profile_id, assigned_profile_id o una columna de FK)
//                          o no llama a una fuente de identidad (auth.uid(),
//                          auth.jwt() o un helper de public/private). Cubre
//                          "escritura/lectura autorizada solo por rol owner/admin".
//                          Columnas y funciones salen de pg_depend, no de regex.
//     R4 RLS_OFF           tabla expuesta con RLS desactivado.
//   Una policy que solo habilita a service_role (auth.role() = 'service_role')
//   no expone nada al navegador y no cuenta. Las RESTRICTIVE no amplian acceso.
//   Cada hallazgo en una tabla SIN business_id se marca GLOBAL. Tabla sin
//   business_id NO implica hueco: una tabla por usuario (user_id = auth.uid())
//   o la raiz del tenant (businesses) pasa por R3 sin excepcion.
//   PIN PRE-BETA-1: public.users sin grantee distinto del owner, sin privilegio
//   de columna, sin acceso de anon/authenticated/service_role y sin policies.
//
//   GLOBAL_ALLOWLIST: tablas globales LEGITIMAS; cada una declara tabla, razon y
//   acceso permitido (rol:comando). Solo suprime ese acceso. public.users no
//   puede entrar. Una entrada que ya no matchea nada falla (no se pudre).
//   DEUDA_PREEXISTENTE: huecos reales anteriores a PRE-BETA-1, fuera de su
//   alcance. NO son legitimos: se reportan en cada corrida y trinquetean (si se
//   arreglan, la entrada queda vieja y el guard falla hasta quitarla).
//
// MODO ESTATICO (--static; sin DB, corre en el job quality):
//   · src/ y supabase/functions/ no consultan public.users (.from('users'),
//     embeds users(...), hints users!).
//   · ninguna migracion posterior a PRE-BETA-1 vuelve a dar GRANT sobre
//     public.users ni le crea policies.
//
// --self-test (en cada modo): planta cada violacion y exige detectarla; los
// controles (sin mutacion, tabla global de allowlist) no dan falso positivo. En
// modo catalogo las mutaciones corren dentro de BEGIN ... ROLLBACK.
//
//   node scripts/guards/tenant-isolation.mjs [--self-test]
//   node scripts/guards/tenant-isolation.mjs --static [--self-test]
//   node scripts/guards/tenant-isolation.mjs --catalog <snapshot.json>
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CATALOG_SQL = 'scripts/guards/tenant-isolation-catalog.sql'
const PREBETA1_VERSION = '20261010120000'
const BROWSER_ROLES = ['anon', 'authenticated']
const KEY_COLS = new Set(['business_id', 'id', 'user_id', 'owner_user_id', 'auth_user_id', 'created_by', 'profile_id', 'assigned_profile_id'])
const IDENTITY_FNS = new Set(['auth.uid', 'auth.jwt'])
const CMD_LETTERS = { r: ['S'], a: ['I'], w: ['U'], d: ['D'], '*': ['S', 'I', 'U', 'D'] }
const CMD_NAME = { S: 'SELECT', I: 'INSERT', U: 'UPDATE', D: 'DELETE' }

// Tablas globales LEGITIMAS (hoy ninguna: todas las tablas expuestas sin
// business_id son por usuario o la raiz del tenant, y pasan sin excepcion).
// Formato: { table, reason, access: ['anon:S', 'authenticated:S', ...] }
export const GLOBAL_ALLOWLIST = []

// Huecos preexistentes, fuera del alcance de PRE-BETA-1. NO legitimos.
export const DEUDA_PREEXISTENTE = [
  {
    table: 'customer_events', policy: 'ce_insert', rule: 'CHECK_TRUE', access: 'authenticated:I',
    reason: 'INSERT con WITH CHECK (true) desde el remote_baseline: un authenticated puede insertar eventos con '
      + 'business_id ajeno (escritura cross-tenant; la lectura si esta anclada por ce_admin). Fuera del alcance '
      + 'de PRE-BETA-1: requiere discovery propio (P1 de seguimiento).',
  },
]

// ── Evaluacion (pura: catalogo -> hallazgos) ─────────────────────────────────
const isTrue = (e) => typeof e === 'string' && /^\(*\s*true\s*\)*$/i.test(e.trim())
const isServiceOnly = (e) => typeof e === 'string'
  && /^\(*\s*auth\.role\(\)\s*=\s*'service_role'(::text)?\s*\)*$/i.test(e.trim())

function anchored(policy, table) {
  const keyCols = policy.own_cols.filter((c) => KEY_COLS.has(c) || table.fk_cols.includes(c))
  const identity = policy.functions.some((f) => IDENTITY_FNS.has(f) || /^(public|private)\./.test(f))
  return keyCols.length > 0 && identity
}

export function evaluate(catalog, { allowlist = GLOBAL_ALLOWLIST, deuda = DEUDA_PREEXISTENTE } = {}) {
  const hallazgos = []
  const inventarioGlobal = []
  for (const t of catalog.tables) {
    const expuesto = BROWSER_ROLES.flatMap((r) => ['S', 'I', 'U', 'D'].filter((c) => t.access?.[r]?.[c]).map((c) => `${r}:${c}`))
    if (!expuesto.length) continue
    const add = (h) => hallazgos.push({ table: t.name, global: !t.has_business_id, ...h })
    const antes = hallazgos.length
    if (!t.rls) {
      for (const acc of expuesto) add({ rule: 'RLS_OFF', access: acc, policy: null, detail: 'RLS desactivado en una tabla expuesta' })
    } else {
      for (const acc of expuesto) {
        const [rol, letra] = acc.split(':')
        for (const p of t.policies) {
          if (!p.permissive || !CMD_LETTERS[p.cmd].includes(letra)) continue
          if (!(p.roles.includes('public') || p.roles.includes(rol))) continue
          // Expresiones que deciden este comando.
          const exprs = letra === 'I' ? [['check', p.check]]
            : letra === 'U' ? [['using', p.using], ['check', p.check ?? p.using]]
              : [['using', p.using]]
          if (exprs.every(([, e]) => e == null || isServiceOnly(e))) continue
          for (const [cual, e] of exprs) {
            if (e == null || isServiceOnly(e)) continue
            if (isTrue(e)) {
              add({ rule: cual === 'using' ? 'USING_TRUE' : 'CHECK_TRUE', access: acc, policy: p.name, detail: `${cual.toUpperCase()} (true)` })
            } else if (!anchored(p, t)) {
              add({ rule: 'SIN_ANCLA', access: acc, policy: p.name,
                detail: `${cual.toUpperCase()} ${e.replace(/\s+/g, ' ').slice(0, 140)} (columnas propias: ${p.own_cols.join(',') || '-'}; funciones: ${p.functions.join(',') || '-'})` })
            }
          }
        }
      }
    }
    if (!t.has_business_id) {
      inventarioGlobal.push({ table: t.name, access: expuesto.join(' '), hallazgos: hallazgos.length - antes })
    }
  }

  // Pin PRE-BETA-1 (no admite allowlist ni deuda).
  const pin = []
  const u = catalog.legacy_users
  if (u) {
    if (u.policies > 0) pin.push(`public.users tiene ${u.policies} policies`)
    if (u.grantees.length) pin.push(`public.users tiene grantees distintos del owner: ${u.grantees.join(', ')}`)
    if (u.column_acl) pin.push('public.users tiene privilegios de columna')
    for (const [r, v] of Object.entries(u.access)) if (v) pin.push(`${r} tiene acceso a public.users`)
  }

  // Allowlist: suprime solo el acceso declarado; entradas invalidas o viejas fallan.
  const errores = []
  const allowUsado = new Set()
  for (const a of allowlist) {
    if (!a.table || !a.reason || !Array.isArray(a.access) || !a.access.length) errores.push(`allowlist incompleta: ${JSON.stringify(a)}`)
    if (a.table === 'users') errores.push('public.users no puede estar en la allowlist de tablas globales (PRE-BETA-1)')
  }
  const deudaUsada = new Set()
  const violaciones = [], deudaVista = []
  for (const h of hallazgos) {
    const a = allowlist.find((x) => x.table === h.table && x.access.includes(h.access))
    if (a) { allowUsado.add(a); continue }
    const d = deuda.find((x) => x.table === h.table && x.policy === h.policy && x.rule === h.rule && x.access === h.access)
    if (d) { deudaUsada.add(d); deudaVista.push(h); continue }
    violaciones.push(h)
  }
  for (const a of allowlist) if (!allowUsado.has(a) && a.table !== 'users') errores.push(`allowlist vieja: ${a.table} (${a.access.join(', ')}) ya no expone ese acceso: quitar la entrada`)
  for (const d of deuda) if (!deudaUsada.has(d)) errores.push(`deuda resuelta o cambiada: ${d.table}.${d.policy} ${d.rule} ${d.access} ya no aparece: quitar la entrada`)

  return { violaciones, deudaVista, pin, errores, inventarioGlobal }
}

// ── Catalogo desde la base local ─────────────────────────────────────────────
function dbContainer() {
  const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
  const ct = process.env.TENANT_GUARD_DB_CONTAINER || `supabase_db_${project}`
  if (!/^supabase_db_[a-z0-9-]+$/.test(ct)) throw new Error(`${ct} no es un contenedor de Supabase local`)
  return ct
}
function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', dbContainer(), 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`psql fallo: ${(r.stderr || '').trim().slice(0, 400)}`)
  return r.stdout
}
const CATALOG = () => readFileSync(CATALOG_SQL, 'utf8')
// El snapshot es la ultima linea que empieza con '{' (las previas son BEGIN/SET/DDL).
const parseSnapshot = (out) => JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop())
const leerCatalogo = (mutacion = '') => mutacion
  ? parseSnapshot(psql(`BEGIN;\n${mutacion}\n${CATALOG()}\nROLLBACK;`))
  : parseSnapshot(psql(CATALOG()))

function reportar(res, origen) {
  console.log(`Guard de aislamiento de tenants · ${origen}`)
  console.log('\nTablas SIN business_id expuestas a la API (inventario, no implica hueco):')
  for (const g of res.inventarioGlobal) console.log(`  · ${g.table.padEnd(38)} ${g.access}${g.hallazgos ? `  ← ${g.hallazgos} hallazgo(s)` : '  (anclada: self/tenant)'}`)
  if (res.deudaVista.length) {
    console.log('\nDEUDA PREEXISTENTE (fuera de alcance, NO legitima — seguimiento abierto):')
    for (const h of res.deudaVista) {
      const d = DEUDA_PREEXISTENTE.find((x) => x.table === h.table && x.policy === h.policy)
      console.log(`  ⚠ ${h.table}.${h.policy} ${h.rule} ${h.access}${h.global ? ' GLOBAL' : ''} — ${d?.reason ?? ''}`)
    }
  }
  for (const p of res.pin) console.error(`  ✖ PIN PRE-BETA-1: ${p}`)
  for (const v of res.violaciones) {
    console.error(`  ✖ ${v.rule}${v.global ? ' [GLOBAL]' : ''} ${v.table}${v.policy ? `.${v.policy}` : ''} ${v.access} (${CMD_NAME[v.access.split(':')[1]]}) — ${v.detail}`)
  }
  for (const e of res.errores) console.error(`  ✖ ${e}`)
  const n = res.pin.length + res.violaciones.length + res.errores.length
  if (n) { console.error(`\nGUARD FALLO: ${n} problema(s).`); return false }
  console.log(`\nOK · 0 violaciones · PIN PRE-BETA-1 cumplido · ${res.deudaVista.length} deuda(s) preexistente(s) reportada(s).`)
  return true
}

// ── Self-test del modo catalogo (mutaciones reales en BEGIN ... ROLLBACK) ────
const OWNER_ADMIN = "(current_user_role() = ANY (ARRAY['owner'::text, 'admin'::text]))"
function selfTestCatalogo() {
  const tiene = (res, pred) => res.violaciones.some(pred)
  const casos = [
    ['C0 control: el catalogo tal cual queda limpio (solo deuda reportada)', '',
      (r) => !r.violaciones.length && !r.pin.length && !r.errores.length && r.deudaVista.length === DEUDA_PREEXISTENTE.length],
    ['M1a reabrir public.users (GRANT SELECT + USING true)',
      'GRANT SELECT ON public.users TO authenticated;\nCREATE POLICY m1 ON public.users FOR SELECT TO authenticated USING (true);',
      (r) => r.pin.length >= 2 && tiene(r, (v) => v.table === 'users' && v.rule === 'USING_TRUE' && v.global)],
    ['M1b reabrir public.users solo con GRANT (aunque RLS niegue, el pin falla)',
      'GRANT SELECT, UPDATE ON public.users TO authenticated;',
      (r) => r.pin.some((p) => p.includes('authenticated'))],
    ['M1c dar acceso a service_role sobre public.users',
      'GRANT SELECT ON public.users TO service_role;',
      (r) => r.pin.some((p) => p.includes('service_role'))],
    ['M2 agregar USING (true) a una tabla de tenant',
      'CREATE POLICY m2 ON public.customers FOR SELECT TO authenticated USING (true);',
      (r) => tiene(r, (v) => v.table === 'customers' && v.policy === 'm2' && v.rule === 'USING_TRUE' && v.access === 'authenticated:S')],
    ['M2b agregar WITH CHECK (true) a un INSERT',
      'CREATE POLICY m2b ON public.customers FOR INSERT TO authenticated WITH CHECK (true);',
      (r) => tiene(r, (v) => v.policy === 'm2b' && v.rule === 'CHECK_TRUE')],
    ['M3a SELECT global a authenticated: RLS desactivado',
      'ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY;',
      (r) => tiene(r, (v) => v.table === 'customers' && v.rule === 'RLS_OFF' && v.access === 'authenticated:S')],
    ['M3b SELECT global a authenticated: policy solo por rol',
      `CREATE POLICY m3b ON public.customers FOR SELECT TO authenticated USING ${OWNER_ADMIN};`,
      (r) => tiene(r, (v) => v.policy === 'm3b' && v.rule === 'SIN_ANCLA' && v.access === 'authenticated:S')],
    ['M4 UPDATE/DELETE global para owner/admin (el patron de users)',
      `CREATE POLICY m4u ON public.customers FOR UPDATE TO authenticated USING ${OWNER_ADMIN} WITH CHECK ${OWNER_ADMIN};\n`
      + `CREATE POLICY m4d ON public.customers FOR DELETE TO authenticated USING ${OWNER_ADMIN};`,
      (r) => tiene(r, (v) => v.policy === 'm4u' && v.rule === 'SIN_ANCLA' && v.access === 'authenticated:U')
        && tiene(r, (v) => v.policy === 'm4d' && v.rule === 'SIN_ANCLA' && v.access === 'authenticated:D')],
    ['M4b columna no clave + helper de rol no cuenta como ancla',
      `CREATE POLICY m4b ON public.customers FOR DELETE TO authenticated USING ((name IS NOT NULL) AND ${OWNER_ADMIN});`,
      (r) => tiene(r, (v) => v.policy === 'm4b' && v.rule === 'SIN_ANCLA')],
    ['M5 tabla global insegura nueva (PII, sin business_id, FOR ALL true)',
      'CREATE TABLE public._tg_m5_contactos (id uuid PRIMARY KEY, email text, phone text);\n'
      + 'ALTER TABLE public._tg_m5_contactos ENABLE ROW LEVEL SECURITY;\n'
      + 'GRANT SELECT, INSERT, UPDATE, DELETE ON public._tg_m5_contactos TO authenticated;\n'
      + 'CREATE POLICY m5 ON public._tg_m5_contactos FOR ALL TO authenticated USING (true) WITH CHECK (true);',
      (r) => ['S', 'I', 'U', 'D'].every((c) => tiene(r, (v) => v.table === '_tg_m5_contactos' && v.global && v.access === `authenticated:${c}`))],
    ['M5b tabla global nueva sin RLS expuesta a anon',
      'CREATE TABLE public._tg_m5b (id int, secreto text);\nGRANT SELECT ON public._tg_m5b TO anon;',
      (r) => tiene(r, (v) => v.table === '_tg_m5b' && v.rule === 'RLS_OFF' && v.global && v.access === 'anon:S')],
    ['M7 deuda preexistente arreglada sin quitar la entrada (trinquete)',
      'DROP POLICY ce_insert ON public.customer_events;',
      (r) => r.errores.some((e) => e.includes('customer_events.ce_insert'))],
    ['C1 control: tabla por usuario sin business_id (user_id = auth.uid()) no es hallazgo',
      'CREATE TABLE public._tg_c1 (id uuid PRIMARY KEY, user_id uuid, nota text);\n'
      + 'ALTER TABLE public._tg_c1 ENABLE ROW LEVEL SECURITY;\n'
      + 'GRANT SELECT, INSERT, UPDATE, DELETE ON public._tg_c1 TO authenticated;\n'
      + 'CREATE POLICY c1 ON public._tg_c1 FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());',
      (r) => !r.violaciones.some((v) => v.table === '_tg_c1') && r.inventarioGlobal.some((g) => g.table === '_tg_c1' && g.hallazgos === 0)],
    ['C2 control: policy solo service_role no expone al navegador',
      'CREATE TABLE public._tg_c2 (id int, business_id uuid);\nALTER TABLE public._tg_c2 ENABLE ROW LEVEL SECURITY;\n'
      + 'GRANT SELECT ON public._tg_c2 TO authenticated;\n'
      + "CREATE POLICY c2 ON public._tg_c2 FOR ALL TO public USING (auth.role() = 'service_role'::text);",
      (r) => !r.violaciones.some((v) => v.table === '_tg_c2')],
  ]
  let fallos = 0
  for (const [nombre, mutacion, esperado] of casos) {
    const res = evaluate(leerCatalogo(mutacion))
    if (esperado(res)) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.error(`  ✖ ${nombre}\n      ${JSON.stringify({ v: res.violaciones.slice(0, 4), pin: res.pin, err: res.errores })}`) }
  }
  // M6: una tabla global LEGITIMA de allowlist no da falso positivo, y la
  // allowlist solo cubre el acceso declarado (un UPDATE extra si se detecta).
  const M6 = 'CREATE TABLE public._tg_m6_catalogo (id int PRIMARY KEY, etiqueta text);\n'
    + 'ALTER TABLE public._tg_m6_catalogo ENABLE ROW LEVEL SECURITY;\n'
    + 'GRANT SELECT ON public._tg_m6_catalogo TO anon, authenticated;\n'
    + 'CREATE POLICY m6 ON public._tg_m6_catalogo FOR SELECT TO anon, authenticated USING (true);'
  const allow = [{ table: '_tg_m6_catalogo', reason: 'self-test: catalogo global de solo lectura', access: ['anon:S', 'authenticated:S'] }]
  const checks6 = [
    ['M6 tabla global legitima en allowlist (SELECT true) -> sin falso positivo', M6,
      (r) => !r.violaciones.length && !r.errores.length],
    ['M6b la misma tabla con UPDATE (fuera del acceso declarado) -> detectado',
      `${M6}\nGRANT UPDATE ON public._tg_m6_catalogo TO authenticated;\nCREATE POLICY m6u ON public._tg_m6_catalogo FOR UPDATE TO authenticated USING (true);`,
      (r) => r.violaciones.some((v) => v.table === '_tg_m6_catalogo' && v.access === 'authenticated:U')],
    ['M6c allowlist vieja (la tabla ya no existe) -> falla', '',
      (r) => r.errores.some((e) => e.includes('allowlist vieja'))],
  ]
  for (const [nombre, mutacion, esperado] of checks6) {
    const res = evaluate(leerCatalogo(mutacion), { allowlist: allow })
    if (esperado(res)) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.error(`  ✖ ${nombre}\n      ${JSON.stringify({ v: res.violaciones.slice(0, 4), err: res.errores })}`) }
  }
  const resUsers = evaluate(leerCatalogo(''), { allowlist: [{ table: 'users', reason: 'x', access: ['authenticated:S'] }] })
  if (resUsers.errores.some((e) => e.includes('public.users no puede'))) console.log('  ✓ M1d public.users no puede entrar en la allowlist')
  else { fallos++; console.error('  ✖ M1d public.users entro en la allowlist sin error') }

  if (fallos) { console.error(`SELF-TEST FALLO: ${fallos} caso(s).`); process.exit(1) }
  console.log(`SELF-TEST OK · ${casos.length + checks6.length + 1} casos (mutaciones reales en BEGIN/ROLLBACK)`)
}

// ── Modo estatico ────────────────────────────────────────────────────────────
const SRC_DIRS = ['src', 'supabase/functions']
const USERS_CLIENTE = [
  [/\.from\(\s*['"`]users['"`]\s*\)/, ".from('users')"],
  [/(^|[\s,(:'"`])users\s*(![A-Za-z_]+\s*)?\(/m, 'embed users(...)'],
  [/(^|[\s,(:'"`])users!/m, 'hint users!'],
  [/rest\/v1\/users\b/, '/rest/v1/users'],
]
const listar = (dir) => existsSync(dir) ? readdirSync(dir).flatMap((n) => {
  const p = join(dir, n)
  if (n === 'node_modules') return []
  return statSync(p).isDirectory() ? listar(p) : /\.(tsx?|jsx?|mjs)$/.test(n) ? [p] : []
}) : []

// Los comentarios que documentan el retiro (p. ej. "`technician:users(...)`") no
// son consultas: se quitan antes de buscar. `//` solo cuenta al inicio de linea o
// tras un espacio, para no cortar URLs dentro de strings.
const sinComentariosJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')

function staticFindings(archivos, migraciones) {
  const out = []
  for (const [p, src] of archivos) {
    const codigo = sinComentariosJs(src)
    for (const [re, nombre] of USERS_CLIENTE) if (re.test(codigo)) out.push(`${p}: consulta public.users (${nombre})`)
  }
  const tabla = String.raw`(?:"?public"?\s*\.\s*)?"?users"?`
  const reGrant = new RegExp(String.raw`\bGRANT\b[^;]*\bON\s+(?:TABLE\s+)?(?:[^;]*,\s*)?${tabla}(?![\w"])[^;]*\bTO\b`, 'i')
  const reAllTables = /\bGRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+"?public"?/i
  const rePolicy = new RegExp(String.raw`\b(CREATE|ALTER)\s+POLICY\b[^;]*\bON\s+${tabla}(?![\w"])`, 'i')
  const reRls = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:ONLY\s+)?${tabla}(?![\w"])\s+(DISABLE|NO\s+FORCE)\b`, 'i')
  for (const [nombre, sql] of migraciones) {
    if (nombre.slice(0, 14) <= PREBETA1_VERSION) continue
    const sinComentarios = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const stmt of sinComentarios.split(';')) {
      if (reGrant.test(stmt + ';') && !/auth"?\s*\.\s*"?users/i.test(stmt)) out.push(`${nombre}: GRANT sobre public.users (PRE-BETA-1 la saco de la API)`)
      if (reAllTables.test(stmt)) out.push(`${nombre}: GRANT ... ON ALL TABLES IN SCHEMA public (reabriria public.users y cualquier tabla cerrada)`)
      if (rePolicy.test(stmt) && !/auth"?\s*\.\s*"?users/i.test(stmt)) out.push(`${nombre}: policy sobre public.users`)
      if (reRls.test(stmt)) out.push(`${nombre}: debilita RLS de public.users`)
    }
  }
  return out
}

function leerArbol() {
  const archivos = SRC_DIRS.flatMap(listar).map((p) => [p, readFileSync(p, 'utf8')])
  const dir = 'supabase/migrations'
  const migraciones = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort().map((n) => [n, readFileSync(join(dir, n), 'utf8')])
  return { archivos, migraciones }
}

function selfTestStatic() {
  const base = leerArbol()
  if (!base.migraciones.some(([n]) => n.startsWith(PREBETA1_VERSION))) {
    console.error(`SELF-TEST: falta la migracion PRE-BETA-1 (${PREBETA1_VERSION})`); process.exit(1)
  }
  const nueva = '20991231000000_mutacion.sql'
  const conArchivo = (p, s) => ({ ...base, archivos: [...base.archivos, [p, s]] })
  const conMig = (s) => ({ ...base, migraciones: [...base.migraciones, [nueva, s]] })
  const casos = [
    ['control: el arbol actual queda limpio', base, 0],
    ["S1 .from('users') en src", conArchivo('src/x.ts', "await supabase.from('users').select('id')"), 1],
    ['S2 embed technician:users(...) en src', conArchivo('src/x.ts', "select('id, technician:users(id, name)')"), 1],
    ['S3 hint users!fk en una Edge Function', conArchivo('supabase/functions/x/index.ts', "select('id, users!orders_technician_id_fkey(name)')"), 1],
    ['S4 migracion posterior re-GRANT SELECT ON public.users', conMig('GRANT SELECT ON TABLE public.users TO authenticated;'), 1],
    ['S5 migracion posterior crea policy USING (true) en users', conMig('CREATE POLICY x ON "public"."users" FOR SELECT TO authenticated USING (true);'), 1],
    ['S6 migracion posterior GRANT ON ALL TABLES IN SCHEMA public', conMig('GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;'), 1],
    ['S7 migracion posterior DISABLE RLS en users', conMig('ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;'), 1],
    ['control: getBusinessUsers( / business_users_view / auth.users no son public.users',
      conArchivo('src/x.ts', "usersService.getBusinessUsers(id); supabase.from('business_users_view'); const users = []; setUsers(users)"), 0],
    ['control: GRANT sobre auth.users o business_users no cuenta',
      conMig('GRANT SELECT ON TABLE public.business_users_view TO authenticated; GRANT REFERENCES ON auth.users TO postgres;'), 0],
  ]
  let fallos = 0
  for (const [nombre, arbol, esperado] of casos) {
    const n = staticFindings(arbol.archivos, arbol.migraciones).length
    if ((esperado === 0 && n === 0) || (esperado > 0 && n >= esperado)) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.error(`  ✖ ${nombre} (hallazgos: ${n})`) }
  }
  if (fallos) { console.error(`SELF-TEST FALLO: ${fallos} caso(s).`); process.exit(1) }
  console.log(`SELF-TEST OK · ${casos.length} casos (estatico)`)
}

// ── Main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
if (args.includes('--static')) {
  if (args.includes('--self-test')) selfTestStatic()
  else {
    const { archivos, migraciones } = leerArbol()
    const f = staticFindings(archivos, migraciones)
    for (const x of f) console.error(`  ✖ ${x}`)
    if (f.length) { console.error(`\nGUARD FALLO: ${f.length} problema(s).`); process.exit(1) }
    console.log(`Guard de aislamiento (estatico) OK · ${archivos.length} archivos de src/functions sin public.users · migraciones posteriores a PRE-BETA-1 sin reabrirla`)
  }
} else if (args.includes('--self-test')) {
  selfTestCatalogo()
} else if (args.includes('--catalog')) {
  const f = args[args.indexOf('--catalog') + 1]
  const raw = JSON.parse(readFileSync(f, 'utf8'))
  if (!reportar(evaluate(raw.catalog ?? raw), `snapshot ${f}`)) process.exit(1)
} else if (!reportar(evaluate(leerCatalogo()), `catalogo local (${dbContainer()})`)) {
  process.exit(1)
}
