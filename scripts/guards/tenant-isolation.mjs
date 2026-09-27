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
//     R3 NO_DEMOSTRABLE    la expresion no es DEMOSTRABLEMENTE tenant/self-scoped.
//     R4 RLS_OFF           tabla expuesta con RLS desactivado.
//
//   R3 no acepta "columna clave + alguna funcion": exige que la expresion
//   RELACIONE una columna de la fila con una autoridad del usuario, via un
//   helper de la allowlist EXPLICITA de abajo (HELPERS). Reconocedor
//   estructural sobre el texto que imprime PostgreSQL (pg_get_expr):
//     · OR de nivel superior: TODAS las ramas tienen que estar ancladas;
//       AND: alcanza con UNA (las demas solo restringen).
//     · atomos que anclan (y solo estos):
//         self      <col self> = auth.uid()   (user_id, owner_user_id,
//                   auth_user_id, created_by; en profiles tambien id y
//                   COALESCE(user_id, id))
//         tenant    business_id = <helper tenant>()   (en businesses: id)
//         member    business_id IN (SELECT user_business_ids())
//         capacidad <helper capability>(business_id[, 'clave'])
//         subquery  business_id IN / = (SELECT r.business_id FROM t r WHERE ...)
//                   <fk> IN (SELECT r.id FROM <tabla de la fk> r WHERE ...)
//                   con la fila r anclada (mismos atomos)
//         exists    EXISTS (SELECT .. FROM t r WHERE ...) con r anclada Y
//                   correlacionada con la fila (r.business_id = business_id,
//                   o r.id = <fk de la fila hacia t>). Una sola tabla, sin JOIN.
//     · cualquier otra forma (NOT, CASE, JOIN, funciones fuera de la allowlist,
//       helpers aplicados a algo que no es la columna de la fila, comparaciones
//       IS NOT NULL, tautologias) NO ancla: se prefiere un falso positivo
//       revisable a un falso negativo cross-tenant.
//   Los helpers de la allowlist estan FIJADOS por huella (md5 del cuerpo +
//   SECURITY DEFINER + proconfig, calculada en el catalogo): si uno cambia, el
//   guard falla hasta re-revisarlo y actualizar la huella.
//
//   Una policy que solo habilita a service_role (auth.role() = 'service_role')
//   no expone nada al navegador y no cuenta. Las RESTRICTIVE no amplian acceso.
//   Cada hallazgo en una tabla SIN business_id se marca GLOBAL. Tabla sin
//   business_id NO implica hueco: una tabla por usuario (user_id = auth.uid())
//   o la raiz del tenant (businesses) pasa por R3 sin excepcion.
//   PIN PRE-BETA-1: public.users sin grantee distinto del owner, sin privilegio
//   de columna, sin acceso de anon/authenticated/service_role y sin policies.
//   El pin no admite allowlist ni deuda.
//
//   Excepciones (todas fail-closed; una entrada que ya no matchea FALLA):
//   · GLOBAL_ALLOWLIST: tablas globales LEGITIMAS (tabla, razon, acceso
//     rol:comando). Solo suprime ese acceso. public.users no puede entrar.
//   · POLICY_ALLOWLIST: policies seguras que el reconocedor no puede demostrar
//     (tabla, policy, razon, autoridad, huella). Si la policy desaparece o
//     cambia (comando, roles, USING, WITH CHECK), la excepcion falla.
//   · DEUDA_PREEXISTENTE: huecos reales anteriores a PRE-BETA-1, fuera de su
//     alcance. NO son legitimos: se reportan en cada corrida y trinquetean
//     (con huella: si cambian o se arreglan, la entrada falla).
//
// MODO ESTATICO (--static; sin DB, corre en el job quality):
//   · src/ y supabase/functions/ no consultan public.users (.from('users'),
//     embeds users(...), hints users!).
//   · ninguna migracion posterior a PRE-BETA-1 vuelve a dar GRANT sobre
//     public.users ni le crea policies.
//
// --self-test (en cada modo): planta cada violacion y exige detectarla; los
// controles no dan falso positivo. En modo catalogo las mutaciones corren
// dentro de BEGIN ... ROLLBACK.
//
//   node scripts/guards/tenant-isolation.mjs [--self-test]
//   node scripts/guards/tenant-isolation.mjs --static [--self-test]
//   node scripts/guards/tenant-isolation.mjs --catalog <snapshot.json>
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CATALOG_SQL = 'scripts/guards/tenant-isolation-catalog.sql'
const PREBETA1_VERSION = '20261010120000'
const BROWSER_ROLES = ['anon', 'authenticated']
const CMD_LETTERS = { r: ['S'], a: ['I'], w: ['U'], d: ['D'], '*': ['S', 'I', 'U', 'D'] }
const CMD_NAME = { S: 'SELECT', I: 'INSERT', U: 'UPDATE', D: 'DELETE' }

// ── Helpers de identidad/tenant REVISADOS (unicos que anclan) ────────────────
// Revisados sobre el catalogo de produccion (= replay). `kind` decide como
// pueden aparecer en una policy; `fp` es la huella del catalogo (md5 de cuerpo
// sin \r + prosecdef + proconfig). auth.uid() es de Supabase Auth y no se fija.
//
// NO son anclas (revisados y rechazados a proposito: no relacionan la fila con
// el usuario): current_user_role(), current_user_can(text), can_manage(),
// is_owner_or_admin(), is_staff(), business_has_feature(text),
// comprobante_is_order_linked(uuid), auth.role(), auth.jwt().
export const HELPERS = {
  'public.current_business_id()': {
    kind: 'tenant', fp: '957edd22f3d089b6e00d4a9c2a6175dc',
    doc: 'tenant actual: business_id del perfil del usuario (profiles con COALESCE(user_id, id) = auth.uid(), LIMIT 1)',
  },
  'public.current_user_business_id()': {
    kind: 'tenant', fp: '2be08115b0347ad01a35e54965d4f65b',
    doc: 'tenant actual: business_id del perfil ACTIVO mas reciente del usuario (auth.uid())',
  },
  'public.user_business_ids()': {
    kind: 'member', fp: 'bdde43834cd4216d6408bad03bd78fac',
    doc: 'membership: SETOF business_id de los perfiles activos del usuario (auth.uid())',
  },
  'public.current_user_can_in_business(uuid,text)': {
    kind: 'capability', fp: '3d920821b9924602a57739ca6d3e8b7f',
    doc: 'capability tenant-scoped: true solo si auth.uid() es owner del negocio del ARGUMENTO o tiene perfil activo en ESE negocio con la capability',
  },
  'public.can_view_inventory_cost(uuid)': {
    kind: 'capability', fp: '0fa04ed61e833dbbac50da069d45714a',
    doc: 'capability tenant-scoped: = current_user_can_in_business(argumento, inventory_view_costs)',
  },
  'public.can_view_supplier_finance(uuid)': {
    kind: 'capability', fp: '21623accfb9fbfbf3b3aa6cb1dec46bc',
    doc: 'capability tenant-scoped: current_user_can_in_business(argumento, finance | inventory + inventory_view_costs)',
  },
  'public.can_view_payment_allocations(uuid)': {
    kind: 'capability', fp: 'a20216aec8725952082dcde9c222b1ba',
    doc: 'capability tenant-scoped: = user_can_view_order_amounts(argumento, auth.uid())',
  },
  'public.user_can_view_order_amounts(uuid,uuid)': {
    kind: 'dependencia', fp: '927ee9e9ea0783bca597a3fb8be22165',
    doc: 'dependencia de can_view_payment_allocations: el usuario es owner del negocio o tiene perfil activo con rol financiero EN ese negocio',
  },
}
const helperNames = (kind) => Object.entries(HELPERS).filter(([, h]) => h.kind === kind).map(([s]) => s.split('.')[1].split('(')[0])

// Tablas globales LEGITIMAS (hoy ninguna: todas las tablas expuestas sin
// business_id son por usuario o la raiz del tenant, y pasan sin excepcion).
// Formato: { table, reason, access: ['anon:S', 'authenticated:S', ...] }
export const GLOBAL_ALLOWLIST = []

// Policies seguras que el reconocedor NO puede demostrar (fail-closed por huella).
export const POLICY_ALLOWLIST = [
  {
    table: 'wholesale_order_items', policy: 'woi_customer_select', fp: 'da826035f86a430a1c7d41e70be9b281',
    authority: 'self del cliente mayorista: la fila pertenece a un pedido (order_id -> wholesale_orders) cuyo cliente '
      + '(o.customer_id -> wholesale_customers) tiene auth_user_id = auth.uid()',
    reason: 'la subconsulta usa un JOIN (wholesale_orders JOIN wholesale_customers), forma que el reconocedor no acepta',
  },
  {
    table: 'wholesale_customers', policy: 'wc_own_insert', fp: '1e635fb144ebfcf07690c0f1759a46ba',
    authority: 'alta del cliente mayorista en el portal de un negocio: auth_user_id = auth.uid(), estado administrativo '
      + 'forzado a neutro (approved/suspended/whatsapp_verified false; notes/tags/estadisticas vacias; ademas las columnas '
      + 'administrativas no tienen INSERT de API, G2-C.1) y la aprobacion la decide el negocio via '
      + 'update_wholesale_customer_status_atomic. El business_id es el portal elegido por el cliente: no puede atarse a una '
      + 'pertenencia porque el cliente todavia no pertenece; sin aprobacion no accede a nada del negocio',
    reason: 'escritura en tabla con business_id cuyo CHECK no ata business_id (por diseno del alta en el portal)',
  },
  {
    table: 'wholesale_customers', policy: 'wc_own_update', fp: '5ce66cf36dcefd1d70dd389efef38fc8',
    authority: 'self del cliente (auth_user_id = auth.uid()) + privilegios de columna: anon y authenticated NO pueden '
      + 'UPDATE business_id (G2-C.1: el cliente solo actualiza last_login), asi que la fila no se muda de negocio. La '
      + 'condicion se verifica en el catalogo en cada corrida (requires)',
    reason: 'escritura en tabla con business_id cuyo CHECK no ata business_id; lo ata el privilegio de columna',
    requires: { businessIdNotWritable: [['anon', 'U'], ['authenticated', 'U']] },
  },
]

// Huecos preexistentes, fuera del alcance de PRE-BETA-1. NO legitimos.
const DEUDA_PERSONAL = 'Mi Guita: CHECK solo-self (user_id = auth.uid()) y authenticated puede escribir business_id (FK a '
  + 'businesses, nullable): un usuario puede etiquetar SUS filas personales con el business_id de otro negocio. Hoy nadie '
  + 'las lee por business_id (base: 0 vistas/funciones; src: 0), asi que no hay fuga de datos, pero la columna no esta '
  + 'atada a la pertenencia. Fuera del alcance de PRE-BETA-1: requiere discovery propio (P1 de seguimiento).'
export const DEUDA_PREEXISTENTE = [
  {
    table: 'customer_events', policy: 'ce_insert', rule: 'CHECK_TRUE', access: 'authenticated:I', fp: 'e44e33e9c1d2965c8a0f815a569dc9c9',
    reason: 'INSERT con WITH CHECK (true) desde el remote_baseline: un authenticated puede insertar eventos con '
      + 'business_id ajeno (escritura cross-tenant; la lectura si esta anclada por ce_admin). Fuera del alcance '
      + 'de PRE-BETA-1: requiere discovery propio (P1 de seguimiento).',
  },
  {
    table: 'personal_accounts', policy: 'personal_accounts_own', rule: 'NO_DEMOSTRABLE', access: ['authenticated:I', 'authenticated:U'],
    fp: '32a2cf69e3a79cfe1d650c419b65ada9', reason: DEUDA_PERSONAL,
  },
  {
    table: 'personal_categories', policy: 'personal_categories_own', rule: 'NO_DEMOSTRABLE', access: ['authenticated:I', 'authenticated:U'],
    fp: '32a2cf69e3a79cfe1d650c419b65ada9', reason: DEUDA_PERSONAL,
  },
  {
    table: 'personal_credit_cards', policy: 'personal_credit_cards_own', rule: 'NO_DEMOSTRABLE', access: ['authenticated:I', 'authenticated:U'],
    fp: '32a2cf69e3a79cfe1d650c419b65ada9', reason: DEUDA_PERSONAL,
  },
  {
    table: 'personal_transactions', policy: 'personal_transactions_own', rule: 'NO_DEMOSTRABLE', access: ['authenticated:I', 'authenticated:U'],
    fp: '32a2cf69e3a79cfe1d650c419b65ada9', reason: DEUDA_PERSONAL,
  },
]

// ── Reconocedor estructural de anclas ────────────────────────────────────────
const isTrue = (e) => typeof e === 'string' && /^\(*\s*true\s*\)*$/i.test(e.trim())
const isServiceOnly = (e) => typeof e === 'string'
  && /^\(*\s*auth\.role\(\)\s*=\s*'service_role'(::text)?\s*\)*$/i.test(e.trim())
const norm = (s) => (s == null ? '-' : s.replace(/\s+/g, ' ').trim())
export const policyFp = (p) => createHash('md5')
  .update([p.cmd, [...p.roles].sort().join(','), p.permissive, norm(p.using), norm(p.check)].join('|')).digest('hex')

// Indice del parentesis que cierra el abierto en i (respeta comillas simples).
function closeAt(s, i) {
  let depth = 0, q = false
  for (let k = i; k < s.length; k++) {
    const ch = s[k]
    if (q) { if (ch === "'") { if (s[k + 1] === "'") k++; else q = false } continue }
    if (ch === "'") q = true
    else if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return k }
  }
  return -1
}
function strip(s) {
  s = s.trim()
  while (s.startsWith('(') && closeAt(s, 0) === s.length - 1) s = s.slice(1, -1).trim()
  return s
}
// Divide en " AND " / " OR " de nivel superior (fuera de parentesis y comillas).
function splitTop(s, word) {
  const parts = [], tok = ` ${word} `
  let depth = 0, q = false, last = 0
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]
    if (q) { if (ch === "'") { if (s[k + 1] === "'") k++; else q = false } continue }
    if (ch === "'") q = true
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && s.startsWith(tok, k)) { parts.push(s.slice(last, k)); last = k + tok.length; k += tok.length - 1 }
  }
  parts.push(s.slice(last))
  return parts.map((p) => p.trim())
}

const ID = '[a-z_][a-z0-9_]*' // identificador SQL sin comillas
const ESC = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const IDENT = String.raw`(?:auth\.uid\(\)|\( ?SELECT auth\.uid\(\) AS uid\))`
const SELF_COLS = ['user_id', 'owner_user_id', 'auth_user_id', 'created_by']
// ctx de una fila: tabla, prefijos con los que la expresion nombra sus columnas
// ('' = sin calificar, 'alias.'), y si es una fila de subconsulta (prueba de
// pertenencia: ahi created_by no alcanza).
const colRe = (ctx, cols) => `(?:${ctx.refs.map(ESC).join('|')})(?:${cols.map(ESC).join('|')})`
const tenantCols = (ctx) => (ctx.table === 'businesses' ? ['business_id', 'id'] : ['business_id'])
const selfCols = (ctx) => [...SELF_COLS.filter((c) => !(ctx.sub && c === 'created_by')), ...(ctx.table === 'profiles' ? ['id'] : [])]

function anchoredExpr(expr, ctx, fk) {
  const e = strip(norm(expr))
  const ors = splitTop(e, 'OR'), ands = splitTop(e, 'AND')
  if (ors.length > 1 && ands.length > 1) return false // mezcla sin parentesis: no se demuestra
  if (ors.length > 1) return ors.every((p) => anchoredExpr(p, ctx, fk))
  if (ands.length > 1) return ands.some((p) => anchoredExpr(p, ctx, fk))
  return atom(e, ctx, fk)
}

function atom(a, ctx, fk) {
  const T = colRe(ctx, tenantCols(ctx)), S = colRe(ctx, selfCols(ctx))
  const SC = ctx.table === 'profiles' ? `|COALESCE\\(${S}, ${S}\\)` : ''
  const eq = (L, R) => new RegExp(`^(?:${L}) = (?:${R})$`).test(a) || new RegExp(`^(?:${R}) = (?:${L})$`).test(a)
  const tenantFns = helperNames('tenant'), memberFns = helperNames('member'), capFns = helperNames('capability')
  const TENANT = tenantFns.map((f) => `${f}\\(\\)|\\( ?SELECT ${f}\\(\\) AS ${f}\\)`).join('|') || '(?!)'
  if (!ctx.bind && eq(`${S}${SC}`, IDENT)) return true                                           // self (no ata business_id)
  if (eq(T, TENANT)) return true                                                                   // tenant actual
  for (const f of memberFns) if (new RegExp(`^${T} IN \\( ?SELECT ${f}\\(\\) AS ${f}\\)$`).test(a)) return true // membership
  if (capFns.length && new RegExp(`^(?:${capFns.join('|')})\\(${T}(?:, '[^']*'::text)?\\)$`).test(a)) return true // capability
  // business_id IN / = (SELECT r.business_id FROM t [r] WHERE cond), con r anclada.
  let m = a.match(new RegExp(`^${T} (?:IN|=) \\( ?SELECT (${ID})\\.business_id FROM (${ID})(?: (${ID}))? WHERE (.+)\\)$`))
  if (m && m[1] === (m[3] || m[2])) return subAnchored(m[4], { table: m[2], refs: [`${m[3] || m[2]}.`], sub: true }, fk, null)
  // <fk> IN (SELECT r.id FROM <tabla referenciada> [r] WHERE cond), con r anclada.
  m = a.match(new RegExp(`^(?:${ctx.refs.map(ESC).join('|')})(${ID}) IN \\( ?SELECT (${ID})\\.id FROM (${ID})(?: (${ID}))? WHERE (.+)\\)$`))
  if (!ctx.bind && m && m[2] === (m[4] || m[3]) && (fk[ctx.table] || {})[m[1]] === m[3]) {
    return subAnchored(m[5], { table: m[3], refs: [`${m[4] || m[3]}.`], sub: true }, fk, null)
  }
  // EXISTS (SELECT .. FROM t [r] WHERE cond): r anclada Y correlacionada con la fila.
  // La lista del SELECT tiene que ser simple (sin comillas ni parentesis): un literal no puede fingir el FROM.
  m = a.match(new RegExp(`^EXISTS \\( ?SELECT [^'()]+? FROM (${ID})(?: (${ID}))? WHERE (.+)\\)$`))
  if (m) return subAnchored(m[3], { table: m[1], refs: [`${m[2] || m[1]}.`], sub: true }, fk, ctx)
  return false
}

// La subconsulta ancla si su WHERE es una conjuncion (sin OR de nivel superior)
// con (a) un atomo que ancla la fila r al usuario y, si hay fila externa
// (EXISTS), (b) un atomo que correlaciona r con esa fila.
function subAnchored(cond, rctx, fk, outer) {
  const c = strip(cond)
  if (splitTop(c, 'OR').length > 1) return false
  const parts = splitTop(c, 'AND').map(strip)
  if (!parts.some((p) => atom(p, rctx, fk))) return false
  return !outer || parts.some((p) => correlates(p, rctx, outer, fk))
}

// r.x = o.y valido: r.business_id = o.business_id; businesses.id = o.business_id;
// r.id = o.<fk> cuando la fk de o apunta a la tabla de r.
function correlates(a, r, o, fk) {
  const m = a.match(new RegExp(`^(${ID}\\.)?(${ID}) = (${ID}\\.)?(${ID})$`))
  if (!m) return false
  const oRefs = o.refs.includes('') ? [...o.refs, `${o.table}.`] : o.refs
  for (const [rp, rc, op, oc] of [[m[1] || '', m[2], m[3] || '', m[4]], [m[3] || '', m[4], m[1] || '', m[2]]]) {
    if (!r.refs.includes(rp) || !oRefs.includes(op)) continue
    const oTenant = oc === 'business_id' || (o.table === 'businesses' && oc === 'id')
    if (oTenant && (rc === 'business_id' || (r.table === 'businesses' && rc === 'id'))) return true
    if (!o.bind && rc === 'id' && (fk[o.table] || {})[oc] === r.table) return true // el padre no ata business_id
  }
  return false
}

// Un helper se reconoce por nombre en el texto; pg_depend dice que funcion es de
// verdad. Si la policy usa una funcion con nombre de helper que NO es la de
// public, no se demuestra (un homonimo en otro schema no es el helper revisado).
const NOMBRES_HELPER = new Set(Object.keys(HELPERS).map((s) => s.split('.')[1].split('(')[0]))
const homonimoFueraDePublic = (p) => p.functions.some((f) => {
  const [schema, name] = f.split('.')
  return NOMBRES_HELPER.has(name) && schema !== 'public'
})

export function evaluate(catalog, { allowlist = GLOBAL_ALLOWLIST, policyAllow = POLICY_ALLOWLIST, deuda = DEUDA_PREEXISTENTE } = {}) {
  const hallazgos = []
  const inventarioGlobal = []
  let demostradas = 0
  const fk = Object.fromEntries(catalog.tables.map((t) => [t.name, t.fk_refs || {}]))
  const fps = new Map()
  for (const t of catalog.tables) {
    const expuesto = BROWSER_ROLES.flatMap((r) => ['S', 'I', 'U', 'D'].filter((c) => t.access?.[r]?.[c]).map((c) => `${r}:${c}`))
    if (!expuesto.length) continue
    const add = (h) => hallazgos.push({ table: t.name, global: !t.has_business_id, ...h })
    const antes = hallazgos.length
    const ctx = { table: t.name, refs: ['', `${t.name}.`], sub: false }
    if (!t.rls) {
      for (const acc of expuesto) add({ rule: 'RLS_OFF', access: acc, policy: null, detail: 'RLS desactivado en una tabla expuesta' })
    } else {
      for (const acc of expuesto) {
        const [rol, letra] = acc.split(':')
        for (const p of t.policies) {
          if (!p.permissive || !CMD_LETTERS[p.cmd].includes(letra)) continue
          if (!(p.roles.includes('public') || p.roles.includes(rol))) continue
          fps.set(`${t.name}.${p.name}`, policyFp(p))
          // Expresiones que deciden este comando.
          const exprs = letra === 'I' ? [['check', p.check]]
            : letra === 'U' ? [['using', p.using], ['check', p.check ?? p.using]]
              : [['using', p.using]]
          if (exprs.every(([, e]) => e == null || isServiceOnly(e))) continue
          for (const [cual, e] of exprs) {
            if (e == null || isServiceOnly(e)) continue
            if (isTrue(e)) {
              add({ rule: cual === 'using' ? 'USING_TRUE' : 'CHECK_TRUE', access: acc, policy: p.name, detail: `${cual.toUpperCase()} (true)` })
            } else if (!homonimoFueraDePublic(p) && anchoredExpr(e, cual === 'check' && t.has_business_id ? { ...ctx, bind: true } : ctx, fk)) {
              demostradas++
            } else {
              add({ rule: 'NO_DEMOSTRABLE', access: acc, policy: p.name,
                detail: `no demostrablemente tenant/self-scoped${cual === 'check' && t.has_business_id ? ' (la fila escrita no ata business_id)' : ''}: `
                  + `${cual.toUpperCase()} ${norm(e).slice(0, 160)}` })
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

  const errores = []
  // Helpers: la lista del catalogo y la del guard son la misma, y cada huella coincide.
  const cat = catalog.helpers || {}
  const enGuard = Object.keys(HELPERS).sort(), enCatalogo = Object.keys(cat).sort()
  if (JSON.stringify(enGuard) !== JSON.stringify(enCatalogo)) {
    errores.push(`la lista de helpers del catalogo (${enCatalogo.join(', ') || '-'}) no es la del guard (${enGuard.join(', ')})`)
  }
  for (const [sig, h] of Object.entries(HELPERS)) {
    if (!cat[sig]) errores.push(`helper ${sig} no existe en el catalogo: re-revisar la allowlist`)
    else if (cat[sig] !== h.fp) errores.push(`helper ${sig} cambio (huella ${cat[sig]} != revisada ${h.fp}): re-revisar su semantica y actualizar la huella`)
  }

  // Excepciones: completas, nunca para public.users, y viejas -> falla.
  for (const a of allowlist) {
    if (!a.table || !a.reason || !Array.isArray(a.access) || !a.access.length) errores.push(`allowlist incompleta: ${JSON.stringify(a)}`)
    if (a.table === 'users') errores.push('public.users no puede estar en la allowlist de tablas globales (PRE-BETA-1)')
  }
  const tabla = Object.fromEntries(catalog.tables.map((t) => [t.name, t]))
  for (const x of policyAllow) {
    if (!x.table || !x.policy || !x.fp || !x.reason || !x.authority) errores.push(`allowlist de policy incompleta: ${JSON.stringify(x)}`)
    for (const [rol, priv] of x.requires?.businessIdNotWritable || []) {
      if (tabla[x.table]?.business_id_write?.[rol]?.[priv] !== false) {
        errores.push(`excepcion invalida: ${x.table}.${x.policy} declara que ${rol} no puede ${CMD_NAME[priv]} business_id y el catalogo dice que si`)
      }
    }
    if (x.table === 'users') errores.push('public.users no puede estar en la allowlist de policies (PRE-BETA-1)')
    else if (!fps.has(`${x.table}.${x.policy}`)) errores.push(`excepcion vieja: la policy ${x.table}.${x.policy} ya no existe o no aplica: quitar la entrada`)
    else if (fps.get(`${x.table}.${x.policy}`) !== x.fp) errores.push(`excepcion vieja: la policy ${x.table}.${x.policy} cambio (huella ${fps.get(`${x.table}.${x.policy}`)} != ${x.fp}): re-revisar`)
  }
  const allowUsado = new Set(), deudaUsada = new Set(), porPolicyAllow = new Set()
  const violaciones = [], deudaVista = []
  for (const h of hallazgos) {
    const a = allowlist.find((x) => x.table === h.table && x.table !== 'users' && x.access.includes(h.access))
    if (a) { allowUsado.add(a); continue }
    const pa = h.rule === 'NO_DEMOSTRABLE' && policyAllow.find((x) => x.table === h.table && x.table !== 'users' && x.policy === h.policy
      && fps.get(`${h.table}.${h.policy}`) === x.fp)
    if (pa) { porPolicyAllow.add(`${h.table}.${h.policy}`); continue }
    const d = deuda.find((x) => x.table === h.table && x.policy === h.policy && x.rule === h.rule && [x.access].flat().includes(h.access)
      && fps.get(`${h.table}.${h.policy}`) === x.fp)
    if (d) { deudaUsada.add(`${d.table}.${d.policy}|${h.access}`); deudaVista.push(h); continue }
    violaciones.push(h)
  }
  for (const a of allowlist) if (!allowUsado.has(a) && a.table !== 'users') errores.push(`allowlist vieja: ${a.table} (${a.access.join(', ')}) ya no expone ese acceso: quitar la entrada`)
  for (const d of deuda) {
    for (const acc of [d.access].flat()) {
      if (!deudaUsada.has(`${d.table}.${d.policy}|${acc}`)) errores.push(`deuda resuelta o cambiada: ${d.table}.${d.policy} ${d.rule} ${acc} ya no aparece con la huella registrada: re-revisar y actualizar/quitar la entrada`)
    }
  }

  return { violaciones, deudaVista, pin, errores, inventarioGlobal, demostradas, porPolicyAllow: [...porPolicyAllow] }
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
  console.log(`\nOK · 0 violaciones · ${res.demostradas} expresiones demostradas tenant/self-scoped · `
    + `${res.porPolicyAllow.length} policy(s) por allowlist con huella (${res.porPolicyAllow.join(', ') || '-'}) · `
    + `${Object.keys(HELPERS).length} helpers revisados con huella vigente · PIN PRE-BETA-1 cumplido · `
    + `${res.deudaVista.length} deuda(s) preexistente(s) reportada(s).`)
  return true
}

// ── Self-test del modo catalogo (mutaciones reales en BEGIN ... ROLLBACK) ────
const OWNER_ADMIN = "(current_user_role() = ANY (ARRAY['owner'::text, 'admin'::text]))"
const pol = (n, cmd, using, check) => `CREATE POLICY ${n} ON public.customers FOR ${cmd} TO authenticated`
  + (using ? ` USING (${using})` : '') + (check ? ` WITH CHECK (${check})` : '') + ';'
function selfTestCatalogo() {
  const tiene = (res, pred) => res.violaciones.some(pred)
  const nd = (res, policy, access) => tiene(res, (v) => v.policy === policy && v.rule === 'NO_DEMOSTRABLE' && (!access || v.access === access))
  const casos = [
    ['C0 control: el catalogo tal cual queda limpio (solo deuda reportada)', '',
      (r) => !r.violaciones.length && !r.pin.length && !r.errores.length
        && r.deudaVista.length === DEUDA_PREEXISTENTE.reduce((n, d) => n + [d.access].flat().length, 0)],
    // ── PIN PRE-BETA-1 ──
    ['M1a reabrir public.users (GRANT SELECT + USING true)',
      'GRANT SELECT ON public.users TO authenticated;\nCREATE POLICY m1 ON public.users FOR SELECT TO authenticated USING (true);',
      (r) => r.pin.length >= 2 && tiene(r, (v) => v.table === 'users' && v.rule === 'USING_TRUE' && v.global)],
    ['M1b reabrir public.users solo con GRANT (aunque RLS niegue, el pin falla)',
      'GRANT SELECT, UPDATE ON public.users TO authenticated;',
      (r) => r.pin.some((p) => p.includes('authenticated'))],
    ['M1c dar acceso a service_role sobre public.users',
      'GRANT SELECT ON public.users TO service_role;',
      (r) => r.pin.some((p) => p.includes('service_role'))],
    ['M1e reabrir public.users con una policy "anclada" (el pin no admite excepciones)',
      'GRANT SELECT ON public.users TO authenticated;\nCREATE POLICY m1e ON public.users FOR SELECT TO authenticated USING (created_by = auth.uid());',
      (r) => r.pin.some((p) => p.includes('policies')) && r.pin.some((p) => p.includes('authenticated'))],
    // ── Reglas basicas ──
    ['M2 agregar USING (true) a una tabla de tenant', pol('m2', 'SELECT', 'true'),
      (r) => tiene(r, (v) => v.table === 'customers' && v.policy === 'm2' && v.rule === 'USING_TRUE' && v.access === 'authenticated:S')],
    ['M2b agregar WITH CHECK (true) a un INSERT', pol('m2b', 'INSERT', null, 'true'),
      (r) => tiene(r, (v) => v.policy === 'm2b' && v.rule === 'CHECK_TRUE')],
    ['M3a SELECT global a authenticated: RLS desactivado', 'ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY;',
      (r) => tiene(r, (v) => v.table === 'customers' && v.rule === 'RLS_OFF' && v.access === 'authenticated:S')],
    ['M3b SELECT global a authenticated: policy solo por rol', pol('m3b', 'SELECT', OWNER_ADMIN),
      (r) => nd(r, 'm3b', 'authenticated:S')],
    ['M4 UPDATE/DELETE global para owner/admin (el patron de users)',
      pol('m4u', 'UPDATE', OWNER_ADMIN, OWNER_ADMIN) + '\n' + pol('m4d', 'DELETE', OWNER_ADMIN),
      (r) => nd(r, 'm4u', 'authenticated:U') && nd(r, 'm4d', 'authenticated:D')],
    ['M4b columna no clave + helper de rol', pol('m4b', 'DELETE', `(name IS NOT NULL) AND ${OWNER_ADMIN}`),
      (r) => nd(r, 'm4b')],
    ['M5 tabla global insegura nueva (PII, sin business_id, FOR ALL true)',
      'CREATE TABLE public._tg_m5_contactos (id uuid PRIMARY KEY, email text, phone text);\n'
      + 'ALTER TABLE public._tg_m5_contactos ENABLE ROW LEVEL SECURITY;\n'
      + 'GRANT SELECT, INSERT, UPDATE, DELETE ON public._tg_m5_contactos TO authenticated;\n'
      + 'CREATE POLICY m5 ON public._tg_m5_contactos FOR ALL TO authenticated USING (true) WITH CHECK (true);',
      (r) => ['S', 'I', 'U', 'D'].every((c) => tiene(r, (v) => v.table === '_tg_m5_contactos' && v.global && v.access === `authenticated:${c}`))],
    ['M5b tabla global nueva sin RLS expuesta a anon',
      'CREATE TABLE public._tg_m5b (id int, secreto text);\nGRANT SELECT ON public._tg_m5b TO anon;',
      (r) => tiene(r, (v) => v.table === '_tg_m5b' && v.rule === 'RLS_OFF' && v.global && v.access === 'anon:S')],
    // ── Coexistencia sin relacion: columna clave + funcion de identidad NO alcanza ──
    ['A1 Caso A (tabla global): id IS NOT NULL AND current_user_role() = owner',
      'CREATE TABLE public._tg_a (id uuid PRIMARY KEY, nota text);\nALTER TABLE public._tg_a ENABLE ROW LEVEL SECURITY;\n'
      + 'GRANT SELECT, UPDATE, DELETE ON public._tg_a TO authenticated;\n'
      + "CREATE POLICY ta ON public._tg_a FOR ALL TO authenticated USING ((id IS NOT NULL) AND (current_user_role() = 'owner'::text));",
      (r) => ['S', 'U', 'D'].every((c) => tiene(r, (v) => v.table === '_tg_a' && v.policy === 'ta' && v.rule === 'NO_DEMOSTRABLE' && v.global && v.access === `authenticated:${c}`))],
    ['A2 Caso A (tabla de tenant): id IS NOT NULL AND current_user_role() = owner',
      pol('ta2', 'SELECT', "(id IS NOT NULL) AND (current_user_role() = 'owner'::text)"), (r) => nd(r, 'ta2', 'authenticated:S')],
    ['B1 Caso B: business_id IS NOT NULL AND auth.uid() IS NOT NULL (SELECT)',
      pol('tb1', 'SELECT', '(business_id IS NOT NULL) AND (auth.uid() IS NOT NULL)'), (r) => nd(r, 'tb1', 'authenticated:S')],
    ['B2 Caso B en UPDATE (USING y WITH CHECK)',
      pol('tb2', 'UPDATE', '(business_id IS NOT NULL) AND (auth.uid() IS NOT NULL)', '(business_id IS NOT NULL) AND (auth.uid() IS NOT NULL)'),
      (r) => nd(r, 'tb2', 'authenticated:U')],
    ['N1 OR con una rama sin ancla (tenant OR rol)',
      pol('n1', 'SELECT', "(business_id = current_business_id()) OR (current_user_role() = 'owner'::text)"), (r) => nd(r, 'n1')],
    ['N2 tautologia business_id = business_id', pol('n2', 'SELECT', 'business_id = business_id'), (r) => nd(r, 'n2')],
    ['N3 funcion arbitraria de public que "devuelve un tenant" (fuera de la allowlist)',
      'CREATE FUNCTION public._tg_fake_tenant() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT id FROM public.businesses LIMIT 1 $f$;\n'
      + pol('n3', 'SELECT', 'business_id = _tg_fake_tenant()'), (r) => nd(r, 'n3')],
    ['N4 funcion arbitraria de private con la columna como argumento (fuera de la allowlist)',
      'CREATE FUNCTION private._tg_any(uuid) RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT true $f$;\n'
      + 'GRANT EXECUTE ON FUNCTION private._tg_any(uuid) TO authenticated;\n'
      + pol('n4', 'SELECT', 'private._tg_any(business_id)'), (r) => nd(r, 'n4')],
    ['N5 helper de la allowlist aplicado a algo que no es la columna de la fila',
      pol('n5', 'SELECT', "current_user_can_in_business(current_business_id(), 'customers'::text)"), (r) => nd(r, 'n5')],
    ['N6 EXISTS sin correlacion con la fila (el usuario tiene "algun" perfil)',
      pol('n6', 'SELECT', 'EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid())'), (r) => nd(r, 'n6')],
    ['N7 EXISTS correlacionado pero sin anclar la fila de la subconsulta',
      pol('n7', 'SELECT', 'EXISTS (SELECT 1 FROM public.profiles p WHERE p.business_id = customers.business_id AND p.is_active)'), (r) => nd(r, 'n7')],
    ['N8 IN (subconsulta) sin WHERE que la ancle',
      pol('n8', 'SELECT', 'business_id IN (SELECT profiles.business_id FROM public.profiles)'), (r) => nd(r, 'n8')],
    ['N9 NOT(...) no se acepta como ancla (falso positivo revisable, a proposito)',
      pol('n9', 'SELECT', 'NOT (business_id <> current_business_id())'), (r) => nd(r, 'n9')],
    ['N10 created_by = auth.uid() en una subconsulta no prueba pertenencia al negocio',
      pol('n10', 'SELECT', 'EXISTS (SELECT 1 FROM public.orders o WHERE o.business_id = customers.business_id AND o.created_by = auth.uid())'),
      (r) => nd(r, 'n10')],
    ['N11 comparacion con auth.uid() de una columna que no es self (business_id = auth.uid())',
      pol('n11', 'SELECT', 'business_id = auth.uid()'), (r) => nd(r, 'n11')],
    ['N12 helper homonimo en otro schema (no es el helper revisado)',
      'CREATE SCHEMA _tg_shadow;\nCREATE FUNCTION _tg_shadow.current_business_id() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULL::uuid $f$;\n'
      + 'GRANT USAGE ON SCHEMA _tg_shadow TO authenticated;\n' + pol('n12', 'SELECT', 'business_id = _tg_shadow.current_business_id()'),
      (r) => nd(r, 'n12')],
    ['N13 literal en la lista del SELECT de un EXISTS no puede fingir la subconsulta',
      pol('n13', 'SELECT', "EXISTS (SELECT 'x FROM profiles p WHERE p.business_id = customers.business_id AND p.user_id = auth.uid()' AS t "
        + 'FROM public.profiles q WHERE q.is_active)'),
      (r) => nd(r, 'n13')],
    // ── Escritura en tablas con business_id: la fila escrita tiene que atar business_id ──
    ['W1 INSERT con CHECK solo-self (created_by = auth.uid()) en tabla de tenant',
      pol('w1', 'INSERT', null, 'created_by = auth.uid()'), (r) => nd(r, 'w1', 'authenticated:I')],
    ['W2 UPDATE con USING de tenant pero CHECK solo-self (la fila puede mudarse de negocio)',
      pol('w2', 'UPDATE', 'business_id = current_business_id()', 'created_by = auth.uid()'), (r) => nd(r, 'w2', 'authenticated:U')],
    ['W3 INSERT anclado solo por el padre (EXISTS por FK): no ata business_id; el mismo EXISTS en SELECT si ancla',
      'CREATE TABLE public._tg_w3 (id uuid PRIMARY KEY, business_id uuid, customer_id uuid REFERENCES public.customers(id));\n'
      + 'ALTER TABLE public._tg_w3 ENABLE ROW LEVEL SECURITY;\nGRANT SELECT, INSERT ON public._tg_w3 TO authenticated;\n'
      + 'CREATE POLICY w3 ON public._tg_w3 FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM public.customers c '
      + 'WHERE c.id = _tg_w3.customer_id AND c.business_id = current_business_id())) WITH CHECK (EXISTS (SELECT 1 FROM public.customers c '
      + 'WHERE c.id = _tg_w3.customer_id AND c.business_id = current_business_id()));',
      (r) => nd(r, 'w3', 'authenticated:I') && !tiene(r, (v) => v.policy === 'w3' && v.access === 'authenticated:S')],
    ['R1 la autoridad declarada de una excepcion deja de cumplirse (GRANT UPDATE(business_id)) -> falla',
      'GRANT UPDATE (business_id) ON public.wholesale_customers TO authenticated;',
      (r) => r.errores.some((e) => e.includes('excepcion invalida') && e.includes('wc_own_update'))],
    ['D2 una deuda por acceso cambia (personal_accounts_own) -> entrada vieja',
      'ALTER POLICY personal_accounts_own ON public.personal_accounts USING (user_id = auth.uid()) WITH CHECK ((user_id = auth.uid()) AND (business_id IS NULL));',
      (r) => r.errores.some((e) => e.includes('personal_accounts.personal_accounts_own'))],
    // ── Huellas: helpers, allowlist de policy y deuda ──
    ['H1 helper de la allowlist cambia de cuerpo (current_business_id) -> falla hasta re-revisar',
      'CREATE OR REPLACE FUNCTION public.current_business_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER '
      + "SET search_path TO 'public', 'pg_temp' AS $f$ SELECT id FROM public.businesses LIMIT 1 $f$;",
      (r) => r.errores.some((e) => e.includes('helper public.current_business_id() cambio'))],
    ['P1 la policy de la allowlist cambia (pierde el filtro por auth.uid()) -> excepcion vieja + hallazgo',
      'ALTER POLICY woi_customer_select ON public.wholesale_order_items USING (order_id IN (SELECT o.id FROM public.wholesale_orders o '
      + 'JOIN public.wholesale_customers c ON c.id = o.customer_id));',
      (r) => r.errores.some((e) => e.includes('excepcion vieja') && e.includes('woi_customer_select')) && nd(r, 'woi_customer_select')],
    ['P2 la policy de la allowlist desaparece -> excepcion vieja',
      'DROP POLICY woi_customer_select ON public.wholesale_order_items;',
      (r) => r.errores.some((e) => e.includes('excepcion vieja') && e.includes('woi_customer_select'))],
    ['M7 deuda preexistente arreglada sin quitar la entrada (trinquete)',
      'DROP POLICY ce_insert ON public.customer_events;',
      (r) => r.errores.some((e) => e.includes('customer_events.ce_insert'))],
    ['D1 la deuda cambia (roles) -> entrada vieja y el hallazgo vuelve a ser violacion',
      'ALTER POLICY ce_insert ON public.customer_events TO authenticated;',
      (r) => r.errores.some((e) => e.includes('customer_events.ce_insert')) && tiene(r, (v) => v.policy === 'ce_insert' && v.rule === 'CHECK_TRUE')],
    // ── Controles: las formas legitimas NO dan falso positivo ──
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
    ['C3 control: tenant actual, capability por argumento, membership y AND con restricciones extra',
      'CREATE TABLE public._tg_c3 (id uuid PRIMARY KEY, business_id uuid REFERENCES public.businesses(id), v text);\n'
      + 'ALTER TABLE public._tg_c3 ENABLE ROW LEVEL SECURITY;\n'
      + 'GRANT SELECT, INSERT, UPDATE, DELETE ON public._tg_c3 TO authenticated;\n'
      + 'CREATE POLICY c3s ON public._tg_c3 FOR SELECT TO authenticated USING (business_id = current_business_id());\n'
      + "CREATE POLICY c3i ON public._tg_c3 FOR INSERT TO authenticated WITH CHECK (current_user_can_in_business(business_id, 'orders'::text));\n"
      + "CREATE POLICY c3u ON public._tg_c3 FOR UPDATE TO authenticated USING ((business_id = current_user_business_id()) AND current_user_can('orders'::text)) "
      + "WITH CHECK ((business_id = current_user_business_id()) AND current_user_can('orders'::text));\n"
      + 'CREATE POLICY c3d ON public._tg_c3 FOR DELETE TO authenticated USING (business_id IN (SELECT user_business_ids()));',
      (r) => !r.violaciones.some((v) => v.table === '_tg_c3') && !r.errores.length],
    ['C4 control: hija por FK anclada via EXISTS al padre (c.id = fila.fk AND c.business_id = tenant)',
      'CREATE TABLE public._tg_c4 (id uuid PRIMARY KEY, parent_id uuid REFERENCES public.customers(id), v text);\n'
      + 'ALTER TABLE public._tg_c4 ENABLE ROW LEVEL SECURITY;\nGRANT SELECT ON public._tg_c4 TO authenticated;\n'
      + 'CREATE POLICY c4 ON public._tg_c4 FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.customers c '
      + 'WHERE c.id = _tg_c4.parent_id AND c.business_id = current_business_id()));',
      (r) => !r.violaciones.some((v) => v.table === '_tg_c4')],
    ['C5 control: membership por EXISTS en profiles y OR de dos ramas ancladas',
      'CREATE TABLE public._tg_c5 (id uuid PRIMARY KEY, business_id uuid, user_id uuid);\n'
      + 'ALTER TABLE public._tg_c5 ENABLE ROW LEVEL SECURITY;\nGRANT SELECT ON public._tg_c5 TO authenticated;\n'
      + 'CREATE POLICY c5 ON public._tg_c5 FOR SELECT TO authenticated USING ((user_id = auth.uid()) OR (EXISTS (SELECT 1 FROM public.profiles p '
      + 'WHERE p.business_id = _tg_c5.business_id AND p.user_id = auth.uid() AND p.is_active)));',
      (r) => !r.violaciones.some((v) => v.table === '_tg_c5')],
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
  // Casos puros sobre el snapshot actual (sin mutar la base).
  const base = leerCatalogo('')
  const puros = [
    ['M1d public.users no puede entrar en la allowlist de tablas',
      evaluate(base, { allowlist: [{ table: 'users', reason: 'x', access: ['authenticated:S'] }] }),
      (r) => r.errores.some((e) => e.includes('public.users no puede estar en la allowlist de tablas'))],
    ['M1f public.users no puede entrar en la allowlist de policies',
      evaluate(base, { policyAllow: [...POLICY_ALLOWLIST, { table: 'users', policy: 'x', fp: 'x', reason: 'x', authority: 'x' }] }),
      (r) => r.errores.some((e) => e.includes('public.users no puede estar en la allowlist de policies'))],
    ['H2 el catalogo deja de informar un helper revisado -> falla',
      evaluate({ ...base, helpers: Object.fromEntries(Object.entries(base.helpers).filter(([k]) => k !== 'public.user_business_ids()')) }),
      (r) => r.errores.some((e) => e.includes('public.user_business_ids()'))],
    ['P3 una policy no demostrable sin allowlist de policy es violacion (woi_customer_select)',
      evaluate(base, { policyAllow: [] }),
      (r) => nd(r, 'woi_customer_select', 'authenticated:S')],
    ['P4 allowlist de policy incompleta (sin autoridad) -> falla',
      evaluate(base, { policyAllow: POLICY_ALLOWLIST.map((x) => ({ ...x, authority: '' })) }),
      (r) => r.errores.some((e) => e.includes('allowlist de policy incompleta'))],
  ]
  for (const [nombre, res, esperado] of puros) {
    if (esperado(res)) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.error(`  ✖ ${nombre}\n      ${JSON.stringify({ v: res.violaciones.slice(0, 4), err: res.errores })}`) }
  }

  if (fallos) { console.error(`SELF-TEST FALLO: ${fallos} caso(s).`); process.exit(1) }
  console.log(`SELF-TEST OK · ${casos.length + checks6.length + puros.length} casos (mutaciones reales en BEGIN/ROLLBACK + casos puros sobre el snapshot)`)
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
