#!/usr/bin/env node
// ============================================================================
// M7 HOTFIX — Guard: ninguna vista expuesta al cliente sin `security_invoker`.
//
// El hotfix 20260720120000 cerro un leak cross-tenant PROBADO: v_finance_pnl,
// v_finance_sales_ledger y v_finance_product_margin estaban GRANTeadas a
// `authenticated` sin `security_invoker`, o sea corriendo con los privilegios
// de su owner (postgres) y salteando el RLS de todas sus tablas base.
//
// El Health Check tiene el check equivalente contra la base VIVA. Este guard
// mira el TEXTO de las migraciones, que es una red distinta y complementaria:
// atrapa el defecto en el diff, antes de que exista en ninguna base. Una
// migracion nueva que haga
//
//     CREATE VIEW public.v_loquesea AS SELECT ... ;
//     GRANT SELECT ON public.v_loquesea TO authenticated;
//
// sin `security_invoker` nace con el mismo agujero, y la base recien lo acusa
// despues de aplicarla.
//
// CRITERIO: se reporta una vista solo si se cumplen las DOS condiciones —
// se le otorga SELECT a un rol de cliente Y en ningun lado del repo se le
// activa security_invoker. Una vista interna sin grants no puede filtrar nada
// hacia la app y no es un hallazgo.
//
//   node scripts/finance/guard-view-security-invoker.mjs [dir]
//   node scripts/finance/guard-view-security-invoker.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIR_POR_DEFECTO = 'supabase/migrations'
const ROLES_CLIENTE = ['anon', 'authenticated']

/** Quita comentarios para no leer SQL que solo aparece en prosa. */
function despojarComentarios(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.slice(i, i + 2) === '--') { const f = sql.indexOf('\n', i); const e = f === -1 ? sql.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (sql.slice(i, i + 2) === '/*') { const f = sql.indexOf('*/', i + 2); const e = f === -1 ? sql.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += sql[i]; i++
  }
  return out
}

// Un identificador puede venir entrecomillado, calificado, o ambos:
//   v_x   public.v_x   "v_x"   "public"."v_x"   public."v_x"
// El baseline remoto usa la forma entrecomillada en todos lados, asi que esto
// no es un caso de borde: es el caso mayoritario del repo.
const IDENT = '(?:"[^"]+"|\\w+)(?:\\s*\\.\\s*(?:"[^"]+"|\\w+))*'

const norm = (n) => n.replace(/"/g, '').replace(/\s+/g, '').replace(/^public\./i, '').toLowerCase()

/**
 * ¿Esta lista de opciones de vista activa security_invoker?
 *
 * Hay que aceptar las dos escrituras. A mano se escribe
 *     WITH (security_invoker = true)
 * pero `pg_dump` — y por lo tanto TODO el baseline remoto — emite
 *     WITH ("security_invoker"='true')
 * con el nombre entrecomillado y el valor como string. Ignorar la segunda forma
 * hacia que el guard reportara como inseguras dos vistas que en la base viva
 * estan bien (business_users_view, v_subscription_overview): el falso positivo
 * lo detecto correr el guard contra las migraciones reales.
 */
function activaInvoker(opciones) {
  return /"?security_invoker"?\s*=\s*'?(true|on)'?/i.test(opciones)
}

/**
 * Analiza un corpus de SQL EN ORDEN DE MIGRACION y devuelve las vistas que
 * quedan expuestas a un rol de cliente sin security_invoker.
 *
 * ORDEN, NO ACUMULACION. La primera version de este guard preguntaba "¿alguna
 * vez se le puso security_invoker?" y daba verde. Es la pregunta equivocada:
 *
 *     CREATE OR REPLACE VIEW v WITH (security_invoker = true) AS ...   -- 6f4b
 *     CREATE OR REPLACE VIEW v AS ...                                  -- 6f4c
 *
 * `CREATE OR REPLACE VIEW` SIN clausula WITH no preserva las reloptions: las
 * RESETEA. La segunda sentencia le saca security_invoker a la vista sin decir
 * una palabra, y un analisis acumulativo la sigue viendo "arreglada".
 *
 * Eso fue exactamente lo que paso en produccion: 20260704120000 creo
 * v_finance_pnl y v_finance_product_margin CON security_invoker, y
 * 20260713270000 (6F.4c) las recreo sin la clausula para cambiarles el cuerpo.
 * El leak no nació de un olvido al crearlas: nació de un REPLACE posterior.
 * Por eso gana la ULTIMA sentencia, no la mejor.
 */
export function vistasExpuestasSinInvoker(sqlCorpus) {
  const limpio = despojarComentarios(sqlCorpus)

  // Estado por vista, reconstruido reproduciendo las sentencias en orden.
  const estado = new Map() // vista -> { esVista, invoker, roles:Set }
  const get = (v) => {
    if (!estado.has(v)) estado.set(v, { esVista: false, invoker: false, roles: new Set() })
    return estado.get(v)
  }

  // Un solo barrido posicional: el orden de los eventos es el orden del SQL.
  const reEventos = new RegExp([
    // 1: CREATE VIEW  2: ident  3: opciones del WITH (si hay)
    `(?<create>\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:MATERIALIZED\\s+)?VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?<cident>${IDENT})(?:\\s+WITH\\s*\\((?<copts>[^)]*)\\))?)`,
    `(?<alter>\\bALTER\\s+VIEW\\s+(?:IF\\s+EXISTS\\s+)?(?<aident>${IDENT})\\s+(?<akind>SET|RESET)\\s*\\((?<aopts>[^)]*)\\))`,
    // `[^;]*?` y NO `[\s\S]*?`: la lista de privilegios no puede cruzar un `;`.
    // Con el comodin abierto, un `GRANT EXECUTE ON FUNCTION f(uuid) TO x;` no
    // matcheaba (los parentesis no son parte de un identificador), el cuantificador
    // se estiraba buscando un `ON <ident> TO ...;` mas adelante y se tragaba las
    // sentencias siguientes — incluido el GRANT de v_finance_sales_ledger, que
    // asi desaparecia del analisis. Un hallazgo real perdido por un regex goloso.
    `(?<grant>\\b(?<gkind>GRANT|REVOKE)\\s+(?<gprivs>[^;]*?)\\s+ON\\s+(?:TABLE\\s+)?(?<gident>${IDENT})\\s+(?:TO|FROM)\\s+(?<groles>[^;]+);)`,
  ].join('|'), 'gi')

  let m
  while ((m = reEventos.exec(limpio)) !== null) {
    const g = m.groups
    if (g.create) {
      const s = get(norm(g.cident))
      s.esVista = true
      // Sin clausula WITH, el REPLACE resetea reloptions. Ese es el bug.
      s.invoker = g.copts !== undefined && activaInvoker(g.copts)
      continue
    }
    if (g.alter) {
      const s = get(norm(g.aident))
      if (/^RESET$/i.test(g.akind)) {
        if (/security_invoker/i.test(g.aopts)) s.invoker = false
      } else if (/security_invoker/i.test(g.aopts)) {
        s.invoker = activaInvoker(g.aopts)
      }
      continue
    }
    if (g.grant) {
      const privs = g.gprivs.toLowerCase()
      if (!/\bselect\b/.test(privs) && !/\ball\b/.test(privs)) continue
      const s = get(norm(g.gident))
      const roles = g.groles.toLowerCase().split(/[\s,]+/).map(x => x.replace(/"/g, '').trim()).filter(Boolean)
      for (const rol of ROLES_CLIENTE) {
        if (!roles.includes(rol)) continue
        if (/^GRANT$/i.test(g.gkind)) s.roles.add(rol)
        else s.roles.delete(rol)
      }
    }
  }

  // NOTA DE DISEÑO: aca vivia una heuristica para reconocer un ALTER armado con
  // format()/EXECUTE dentro de un DO. Era insegura — al dispararse marcaba como
  // "arreglada" CUALQUIER vista nombrada en un literal 'v_...' de todo el
  // corpus, y tapaba hallazgos reales (asi se le escapaba v_finance_sales_ledger).
  // Se elimino, y la migracion del hotfix pasó a emitir ALTER literales. Si el
  // guard no puede ver un cambio leyendo el SQL, el problema es del SQL.

  const hallazgos = []
  for (const [vista, s] of estado) {
    if (!s.esVista || s.invoker || s.roles.size === 0) continue
    hallazgos.push({ vista, roles: [...s.roles].sort() })
  }
  return hallazgos.sort((a, b) => a.vista.localeCompare(b.vista))
}

function selfTest() {
  const casos = [
    { n: 'vista expuesta sin invoker',
      sql: 'CREATE VIEW public.v_x AS SELECT 1; GRANT SELECT ON public.v_x TO authenticated;', esperado: 1 },
    { n: 'vista expuesta CON invoker en el CREATE',
      sql: 'CREATE VIEW public.v_x WITH (security_invoker = true) AS SELECT 1; GRANT SELECT ON public.v_x TO authenticated;', esperado: 0 },
    { n: 'vista expuesta con ALTER posterior',
      sql: 'CREATE VIEW public.v_x AS SELECT 1; GRANT SELECT ON public.v_x TO authenticated; ALTER VIEW public.v_x SET (security_invoker = true);', esperado: 0 },
    { n: 'vista interna sin grants (no es hallazgo)',
      sql: 'CREATE VIEW public.v_x AS SELECT 1;', esperado: 0 },
    { n: 'grant solo a service_role (no es rol de cliente)',
      sql: 'CREATE VIEW public.v_x AS SELECT 1; GRANT SELECT ON public.v_x TO service_role;', esperado: 0 },
    { n: 'grant a anon cuenta',
      sql: 'CREATE VIEW public.v_x AS SELECT 1; GRANT SELECT ON public.v_x TO anon;', esperado: 1 },
    { n: 'GRANT ALL cuenta como SELECT',
      sql: 'CREATE VIEW public.v_x AS SELECT 1; GRANT ALL ON public.v_x TO authenticated;', esperado: 1 },
    { n: 'identificadores entrecomillados',
      sql: 'CREATE VIEW "public"."v_x" AS SELECT 1; GRANT SELECT ON "public"."v_x" TO "authenticated";', esperado: 1 },
    { n: 'comentado no cuenta',
      sql: '-- GRANT SELECT ON public.v_x TO authenticated;\nCREATE VIEW public.v_x AS SELECT 1;', esperado: 0 },
    { n: 'security_invoker = false NO cuenta como fix',
      sql: 'CREATE VIEW public.v_x WITH (security_invoker = false) AS SELECT 1; GRANT SELECT ON public.v_x TO authenticated;', esperado: 1 },
    { n: 'tabla (no vista) fuera de alcance',
      sql: 'CREATE TABLE public.t_x(id int); GRANT SELECT ON public.t_x TO authenticated;', esperado: 0 },
    { n: 'dos vistas, una rota',
      sql: 'CREATE VIEW public.v_a WITH (security_invoker=true) AS SELECT 1; GRANT SELECT ON public.v_a TO authenticated;'
         + 'CREATE VIEW public.v_b AS SELECT 1; GRANT SELECT ON public.v_b TO authenticated;', esperado: 1 },
    { n: 'materialized view tambien',
      sql: 'CREATE MATERIALIZED VIEW public.v_x AS SELECT 1; GRANT SELECT ON public.v_x TO authenticated;', esperado: 1 },
    // Forma que emite pg_dump: nombre de opcion entrecomillado y valor string.
    // Es la forma dominante en el baseline remoto.
    { n: 'forma pg_dump WITH ("security_invoker"=\'true\')',
      sql: 'CREATE OR REPLACE VIEW "public"."v_x" WITH ("security_invoker"=\'true\') AS SELECT 1; GRANT SELECT ON "public"."v_x" TO "authenticated";', esperado: 0 },
    { n: 'forma pg_dump con valor \'false\' NO es fix',
      sql: 'CREATE OR REPLACE VIEW "public"."v_x" WITH ("security_invoker"=\'false\') AS SELECT 1; GRANT SELECT ON "public"."v_x" TO "authenticated";', esperado: 1 },
    // v_subscription_overview: se crea sin invoker y se recrea con invoker mas
    // adelante en el mismo baseline. El analisis es acumulativo, no por sitio.
    { n: 'recreada despues CON invoker (gana la ultima)',
      sql: 'CREATE OR REPLACE VIEW "public"."v_x" AS SELECT 1; GRANT SELECT ON "public"."v_x" TO authenticated;'
         + 'CREATE OR REPLACE VIEW "public"."v_x" WITH ("security_invoker"=\'true\') AS SELECT 2;', esperado: 0 },
    // ── El caso que realmente ocurrio en produccion ──────────────────────────
    // Un REPLACE posterior SIN clausula WITH resetea reloptions y le saca
    // security_invoker a una vista que lo tenia. Es la regresion que el guard
    // existe para atrapar, y la que un analisis acumulativo deja pasar.
    { n: 'REGRESION: REPLACE sin WITH le saca el invoker',
      sql: 'CREATE OR REPLACE VIEW public.v_x WITH (security_invoker = true) AS SELECT 1;'
         + 'GRANT SELECT ON public.v_x TO authenticated;'
         + 'CREATE OR REPLACE VIEW public.v_x AS SELECT 2;', esperado: 1 },
    { n: 'REGRESION reparada por un ALTER posterior',
      sql: 'CREATE OR REPLACE VIEW public.v_x WITH (security_invoker = true) AS SELECT 1;'
         + 'GRANT SELECT ON public.v_x TO authenticated;'
         + 'CREATE OR REPLACE VIEW public.v_x AS SELECT 2;'
         + 'ALTER VIEW public.v_x SET (security_invoker = true);', esperado: 0 },
    { n: 'ALTER ... RESET (security_invoker) tambien lo apaga',
      sql: 'CREATE OR REPLACE VIEW public.v_x WITH (security_invoker = true) AS SELECT 1;'
         + 'GRANT SELECT ON public.v_x TO authenticated;'
         + 'ALTER VIEW public.v_x RESET (security_invoker);', esperado: 1 },
    // Regresion real: un GRANT sobre FUNCTION no matchea como objeto-vista, y
    // con un comodin goloso se comia el GRANT siguiente.
    { n: 'GRANT EXECUTE ON FUNCTION previo no se come el GRANT siguiente',
      sql: 'CREATE OR REPLACE VIEW "public"."v_x" AS SELECT 1;'
         + 'ALTER VIEW "public"."v_x" OWNER TO "postgres";'
         + 'GRANT EXECUTE ON FUNCTION "public"."f"("a" uuid, "b" boolean) TO "authenticated";'
         + 'GRANT SELECT ON "public"."v_x" TO "authenticated";', esperado: 1 },
    { n: 'ALTER VIEW ... OWNER TO no altera el estado de invoker',
      sql: 'CREATE OR REPLACE VIEW public.v_x WITH (security_invoker = true) AS SELECT 1;'
         + 'ALTER VIEW public.v_x OWNER TO postgres;'
         + 'GRANT SELECT ON public.v_x TO authenticated;', esperado: 0 },
    { n: 'REVOKE posterior deja de exponerla',
      sql: 'CREATE OR REPLACE VIEW public.v_x AS SELECT 1;'
         + 'GRANT SELECT ON public.v_x TO authenticated;'
         + 'REVOKE SELECT ON public.v_x FROM authenticated;', esperado: 0 },
  ]
  let fallos = 0
  for (const c of casos) {
    const got = vistasExpuestasSinInvoker(c.sql).length
    const ok = got === c.esperado
    if (!ok) fallos++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.n}": esperaba ${c.esperado}, obtuvo ${got}`)
  }
  if (fallos) { console.error(`\n❌ self-test: ${fallos} fixture(s) fallaron`); process.exit(1) }
  console.log(`\n✅ self-test: las ${casos.length} fixtures se clasifican correctamente`)
}

// Importable sin efectos: los tests reusan vistasExpuestasSinInvoker() sin
// disparar el CLI ni su process.exit.
const ejecutadoComoCLI = process.argv[1] && process.argv[1].endsWith('guard-view-security-invoker.mjs')

if (ejecutadoComoCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }

export function auditarDirectorio(dir = DIR_POR_DEFECTO) {
  // El orden importa: se ordena por nombre, que para estas migraciones es el
  // orden cronologico de aplicacion.
  const archivos = readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => join(dir, f))
    .filter(f => statSync(f).isFile())
  const corpus = archivos.map(f => readFileSync(f, 'utf8')).join('\n;\n')
  return { archivos, hallazgos: vistasExpuestasSinInvoker(corpus) }
}

if (!ejecutadoComoCLI) { /* importado: no se ejecuta el CLI */ }
else {

const { archivos, hallazgos } = auditarDirectorio(process.argv[2] || DIR_POR_DEFECTO)

if (hallazgos.length) {
  console.error('❌ Guard security_invoker: hay vistas expuestas al cliente que corren con privilegios del owner.\n')
  for (const h of hallazgos) {
    console.error(`   public.${h.vista}  →  GRANT SELECT a ${h.roles.join(', ')}, sin security_invoker`)
  }
  console.error(`
Una vista sin security_invoker se evalua con los privilegios de su OWNER. Si el
owner es postgres, el RLS de las tablas base NO se aplica y la vista devuelve
filas de TODOS los negocios a cualquiera que tenga SELECT. El filtro por
business_id del frontend no es un limite de seguridad: el cliente elige el valor.

    ALTER VIEW public.<vista> SET (security_invoker = true);

o, al crearla:

    CREATE VIEW public.<vista> WITH (security_invoker = true) AS ...
`)
  process.exit(1)
}

console.log(`✅ Guard security_invoker OK (${archivos.length} migraciones): ninguna vista expuesta corre con privilegios del owner.`)

}
