#!/usr/bin/env node
// ============================================================================
// Pre-beta P1 — Guard de cierre. ACOTADO a los cuatro P1 de este lote.
//
// No duplica reglas de otros guards; cuando una regla ya vive en otro archivo
// se delega:
//   · contrato de los graficos L1         -> guard-charts-l1.mjs
//   · higiene de SECURITY DEFINER         -> guard-security-definer.mjs
//   · escrituras financieras directas     -> guards/no-direct-finance-writes.mjs
//
// Falla (exit 1) cuando:
//   P1.  vuelve una grilla de columnas FIJAS a la superficie movil corregida
//        (Finanzas -> Caja). `repeat(N, 1fr)` no baja del min-content de sus
//        tarjetas: en 390px el grid supera el viewport y `body{overflow-x:hidden}`
//        recorta plata SIN scrollbar.
//   P2.  la valoracion canonica de inventario vuelve a omitir `parent_id`
//        (o se le copia el predicado de exclusion a otra vista).
//   P3.  React calcula la reposicion (o la re-deriva de las compras).
//   P4.  supplier_purchases entra al numerador/denominador de la reposicion.
//   P5.  se usa lenguaje de "descapitalizacion" como certeza.
//   P6.  se modifica una migracion ya aplicada a produccion (218 y las de este
//        lote una vez desplegadas).
//   P7.  una migracion del lote hace backfill / DML sobre datos historicos.
//   P8.  una migracion del lote agrega SECURITY DEFINER innecesario.
//   P9.  una migracion del lote relaja RLS o abre grants a anon/PUBLIC.
//   P10. se le promete al usuario que hubo mercaderia recibida a partir de una
//        compra a proveedor (el sistema no puede distinguirlo).
//
//   node scripts/finance/guard-prebeta-p1.mjs [archivo|dir ...]
//   node scripts/finance/guard-prebeta-p1.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename, extname } from 'node:path'

// ── Alcance ─────────────────────────────────────────────────────────────────

const P1_SQL = [
  'supabase/migrations/20260810130000_finance_position_variant_parent_alignment.sql',
  'supabase/migrations/20260810140000_comprobantes_estado_fiscal_default_contract.sql',
  'supabase/migrations/20260810150000_finance_charts_l1_supplier_purchase_context.sql',
]

const P1_TS_FILES = [
  'src/pages/FinanceDashboard.tsx',
  'src/lib/finance/chartsL1Presentation.ts',
  'src/components/finance/charts/InventoryCapitalBlock.tsx',
  'src/services/financeChartsService.ts',
]

/**
 * P6 — migraciones INTOCABLES. Editarlas hace que un `db reset` construya otro
 * esquema mientras produccion conserva el cuerpo viejo: repo y produccion
 * divergen sin que nada falle. Forward-only.
 *
 * 218 esta en produccion desde el merge de Charts L1.
 *
 * 219, 220 y 221 se sellan DESPUES de aplicarlas (2026-08-11, `db push` a
 * produccion: 221/221, pending 0, drift 0). Antes del deploy quedaron fuera a
 * proposito: sellar una migracion que todavia se puede tener que corregir
 * convierte al guard en un obstaculo en vez de una red.
 */
const MIGRACIONES_SELLADAS = {
  'supabase/migrations/20260810120000_finance_charts_l1_contracts.sql':
    '97e92cd7637ddfdb97e342989e03f796736e3451c057b4d62435537da995940c',
  'supabase/migrations/20260810130000_finance_position_variant_parent_alignment.sql':
    'dc87f20c27ddd51931e56f72bbc41e93f783c8c047925047b9fbbcaa4ce0dee9',
  'supabase/migrations/20260810140000_comprobantes_estado_fiscal_default_contract.sql':
    '0ee9a46490819cb9dc433a524bcaf14d694e455385a20409e5d1fa89d1d7270d',
  'supabase/migrations/20260810150000_finance_charts_l1_supplier_purchase_context.sql':
    '4013cf9683cc666d22c14e06d90892ebfa8cbbb19bd4b52b1d165b8e8abf10bd',
}

/** La superficie movil corregida por P1-A. */
const SUPERFICIE_MOVIL = 'src/pages/FinanceDashboard.tsx'

// ── Utilidades ──────────────────────────────────────────────────────────────

// Normaliza saltos de linea: un checkout Windows no es una modificacion.
const sha = (s) => createHash('sha256').update(s.replace(/\r\n/g, '\n'), 'utf8').digest('hex')

/**
 * Quita comentarios para no acusar a un texto explicativo.
 * El `//` de un protocolo NO abre un comentario.
 */
function sinComentarios(src, sql = false) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
  out = sql
    ? out.replace(/--[^\n]*/g, ' ')
    : out.replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  return out
}

/**
 * Quita los literales de texto de SQL ('...', con '' escapado).
 *
 * Hace falta para las reglas ESTRUCTURALES (P8/P9): una postcondicion que grita
 * "quedo SECURITY DEFINER" o "anon puede leer" menciona lo prohibido dentro de
 * un mensaje de error, y acusarla obligaria a borrar la verificacion para que el
 * guard pase. Las reglas de LENGUAJE (P5/P10) no lo usan: ahi el literal ES el
 * objeto de la revision.
 */
export function sinLiterales(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''")
}

/** Menciones NEGADAS: documentar una prohibicion no la viola. */
const NEGACION = /\b(no|nunca|jam[aá]s|sin|prohib\w*|evitar|ni)\b[^.;]{0,80}$/i

function esNegada(texto, indice) {
  return NEGACION.test(texto.slice(Math.max(0, indice - 90), indice))
}

function listarArchivos(ruta) {
  if (!existsSync(ruta)) return []
  if (statSync(ruta).isFile()) return [ruta]
  const out = []
  for (const e of readdirSync(ruta, { withFileTypes: true })) {
    const p = join(ruta, e.name)
    if (e.isDirectory()) out.push(...listarArchivos(p))
    else if (['.ts', '.tsx', '.sql'].includes(extname(e.name))) out.push(p)
  }
  return out
}

// ── P1 — grilla de columnas fijas en la superficie movil ────────────────────
//
// Se busca `repeat(<n>, 1fr)` con n >= 2. `repeat(auto-fit|auto-fill, minmax(...))`
// es justamente el patron correcto y no dispara. Una sola columna tampoco: no
// puede desbordar.

const GRID_FIJO = /repeat\(\s*(\d+)\s*,\s*1fr\s*\)/gi

export function revisarGridMovil(ruta, src) {
  const f = []
  const normalizada = ruta.replace(/\\/g, '/')
  if (!normalizada.endsWith(SUPERFICIE_MOVIL)) return f

  const c = sinComentarios(src, false)
  let m
  GRID_FIJO.lastIndex = 0
  while ((m = GRID_FIJO.exec(c)) !== null) {
    const cols = Number(m[1])
    if (cols < 2) continue
    // Sólo importa dentro del bloque de la pestaña Caja, que es la superficie
    // que P1-A corrigió. El resto del archivo tiene su propia historia y no es
    // alcance de este guard.
    const contexto = c.slice(Math.max(0, m.index - 900), m.index)
    if (!/activeTab === 'caja'/.test(contexto)) continue
    // ...siempre que no haya empezado ya otra pestaña después de 'caja'.
    const desdeCaja = contexto.slice(contexto.lastIndexOf("activeTab === 'caja'"))
    if (/activeTab === '(?!caja)/.test(desdeCaja)) continue
    f.push(`P1 ${basename(ruta)}: vuelve \`repeat(${cols}, 1fr)\` a Finanzas → Caja; en 390px eso recorta tarjetas monetarias sin scrollbar`)
  }
  return f
}

/**
 * Devuelve el CUERPO de un `CREATE OR REPLACE VIEW <nombre>`, o null si el
 * archivo no lo define. Corta en la siguiente sentencia de nivel superior, para
 * no arrastrar los COMMENT/GRANT/DO que vienen despues — que legitimamente
 * pueden mencionar lo que la vista tiene prohibido contener.
 */
export function cuerpoDeVista(sqlSinComentarios, nombreVista) {
  const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+VIEW\\s+"?public"?\\."?${nombreVista}"?`, 'i')
  const m = re.exec(sqlSinComentarios)
  if (!m) return null
  const desde = sqlSinComentarios.slice(m.index)
  const fin = /\n\s*(COMMENT|GRANT|REVOKE|DO|ALTER|DROP|CREATE|COMMIT|BEGIN|NOTIFY)\b/i.exec(desde)
  return fin ? desde.slice(0, fin.index) : desde
}

// ── Revision de SQL ─────────────────────────────────────────────────────────

export function revisarSql(ruta, src) {
  const f = []
  const c = sinComentarios(src, true)
  const nombre = basename(ruta)

  // P2 — la valoracion canonica no puede olvidar parent_id, y el predicado no
  // se copia a otra vista. Sólo aplica al archivo que redefine v_finance_position,
  // y sólo sobre el CUERPO de la vista: una postcondicion que verifica la
  // ausencia de 'VPREF-' obviamente menciona 'VPREF-'.
  const cuerpo = cuerpoDeVista(c, 'v_finance_position')
  if (cuerpo !== null) {
    if (!/v_finance_inventory_capital/i.test(cuerpo)) {
      f.push(`P2 ${nombre}: v_finance_position deja de leer v_finance_inventory_capital (la valoracion vuelve a tener dos definiciones)`)
    }
    if (/VPREF-/i.test(cuerpo)) {
      f.push(`P2 ${nombre}: se copio el predicado 'VPREF-' dentro de v_finance_position; la regla vive en UN solo lugar`)
    }
  }
  // P2b — si alguna vista/CTE excluye padres por VPREF pero NO por parent_id,
  // la convención estructural quedó afuera otra vez.
  if (/VPREF-/i.test(c) && !/parent_id/i.test(c)) {
    f.push(`P2 ${nombre}: excluye padres de variante por 'VPREF-' pero no por parent_id (ese era el defecto P1-B)`)
  }

  // P4 — supplier_purchases dentro del calculo de reposicion.
  if (/supplier_purchases(_count|_amount)?\s*[/*+]/i.test(c) ||
      /[/*+]\s*[\w.]*supplier_purchases(_count|_amount)?\b/i.test(c)) {
    f.push(`P4 ${nombre}: supplier_purchases entra en una operacion aritmetica (no puede tocar la reposicion)`)
  }
  if (/replenishment_pct[\s\S]{0,200}supplier_purchases/i.test(c)) {
    f.push(`P4 ${nombre}: supplier_purchases aparece dentro del calculo de replenishment_pct`)
  }

  // P7 — backfill / DML historico. Las tablas TEMP de baseline no cuentan.
  const dml = /\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+(?:public\.)?([a-z_]+)/gi
  let m
  while ((m = dml.exec(c)) !== null) {
    const tabla = m[2].toLowerCase()
    if (tabla.startsWith('_') || tabla.startsWith('pg_temp')) continue
    f.push(`P7 ${nombre}: hace DML sobre '${tabla}' (backfill prohibido en este lote)`)
  }

  // Reglas estructurales: sobre codigo, no sobre mensajes de error.
  const e = sinLiterales(c)

  // P8 — SECURITY DEFINER nuevo.
  if (/SECURITY\s+DEFINER/i.test(e)) {
    f.push(`P8 ${nombre}: introduce SECURITY DEFINER (este lote es de solo lectura e invoker)`)
  }

  // P9 — RLS relajada o grants abiertos.
  if (/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(e)) {
    f.push(`P9 ${nombre}: desactiva RLS`)
  }
  if (/\bDROP\s+POLICY\b/i.test(e)) {
    f.push(`P9 ${nombre}: elimina una policy de RLS`)
  }
  const grant = /\bGRANT\s+[\s\S]{0,120}?\bTO\s+([a-z_", ]+)/gi
  while ((m = grant.exec(e)) !== null) {
    const destinos = m[1].toLowerCase()
    if (/\banon\b/.test(destinos) || /\bpublic\b/.test(destinos)) {
      f.push(`P9 ${nombre}: otorga un privilegio a ${/\banon\b/.test(destinos) ? 'anon' : 'PUBLIC'}`)
    }
  }

  // P10 — afirmar mercaderia recibida a partir de una compra.
  f.push(...revisarLenguaje(ruta, src))

  return f
}

// ── Revision de TypeScript / TSX ────────────────────────────────────────────

export function revisarTs(ruta, src) {
  const f = []
  const c = sinComentarios(src, false)
  const nombre = basename(ruta)

  // P3 — la reposicion se calcula en el servidor.
  if (/purchases_cost\s*\/\s*[\w.]*consumption_cost/i.test(c) ||
      /consumption_cost\s*[<>=]{1,2}\s*0\s*\?\s*[\w.]*purchases_cost/i.test(c)) {
    f.push(`P3 ${nombre}: calcula el indice de reposicion en React`)
  }

  // P4 — supplier_purchases sumado a las compras/al numerador.
  if (/supplier_purchases_(count|amount)\s*[+\-*/]\s*[\w.]/i.test(c) ||
      /[\w.]\s*[+\-*/]\s*[\w.]*supplier_purchases_(count|amount)\b/i.test(c)) {
    f.push(`P4 ${nombre}: opera aritmeticamente con supplier_purchases_* (es contexto, no un insumo)`)
  }
  if (/purchases_cost\s*\+\s*[\w.]*supplier_purchases/i.test(c)) {
    f.push(`P4 ${nombre}: suma compras a proveedores a las entradas de inventario`)
  }

  f.push(...revisarGridMovil(ruta, src))
  f.push(...revisarLenguaje(ruta, src))
  return f
}

// ── P5 / P10 — lenguaje ─────────────────────────────────────────────────────
//
// P5: "descapitalizacion" es una conclusion patrimonial que este dato no
//     sostiene: comprar menos de lo que se consume puede ser una decision
//     correcta. Documentar la prohibicion (mencion NEGADA) no la viola.
// P10: una compra a proveedor NO es mercaderia recibida. El sistema no
//     distingue mercaderia de servicio o gasto, asi que afirmarlo inventa un
//     dato. La redaccion condicional ("Si corresponden a…") si esta permitida.

const DESCAPITALIZACION = /descapitaliz\w*/gi

const MERCADERIA_AFIRMADA = [
  /(?:hubo|hay|se)\s+recibi[oó]\s+mercader[ií]a/gi,
  /mercader[ií]a\s+recibida\s+(?:por|en|durante)/gi,
  /(?:compraste|compr[oó])\s+mercader[ií]a/gi,
  /las\s+compras\s+a\s+proveedores\s+son\s+mercader[ií]a/gi,
]

export function revisarLenguaje(ruta, src) {
  const f = []
  const nombre = basename(ruta)
  // El lenguaje se revisa sobre el archivo COMPLETO (los textos de usuario son
  // literales, no codigo), pero las menciones negadas no cuentan.
  let m

  DESCAPITALIZACION.lastIndex = 0
  while ((m = DESCAPITALIZACION.exec(src)) !== null) {
    if (esNegada(src, m.index)) continue
    f.push(`P5 ${nombre}: usa "${m[0]}" como certeza; reponer menos de lo consumido no prueba descapitalizacion`)
  }

  for (const re of MERCADERIA_AFIRMADA) {
    re.lastIndex = 0
    while ((m = re.exec(src)) !== null) {
      if (esNegada(src, m.index)) continue
      // La forma condicional es la unica permitida.
      const antes = src.slice(Math.max(0, m.index - 60), m.index)
      if (/\bsi\b\s*$/i.test(antes.trim()) || /\bSi\s+corresponden\b/.test(antes)) continue
      f.push(`P10 ${nombre}: afirma "${m[0].replace(/\s+/g, ' ')}"; una compra a proveedor puede ser un servicio o un gasto`)
    }
  }
  return f
}

// ── P6 — migraciones selladas ───────────────────────────────────────────────

export function revisarMigracionesSelladas(leer = (p) => readFileSync(p, 'utf8')) {
  const f = []
  for (const [ruta, hashEsperado] of Object.entries(MIGRACIONES_SELLADAS)) {
    if (!existsSync(ruta)) {
      f.push(`P6 ${ruta}: desaparecio una migracion ya aplicada a produccion`)
      continue
    }
    const actual = sha(leer(ruta))
    if (actual !== hashEsperado) {
      f.push(`P6 ${ruta}: se modifico una migracion ya aplicada (esperado ${hashEsperado.slice(0, 12)}…, actual ${actual.slice(0, 12)}…)`)
    }
  }
  return f
}

// ── Runner ──────────────────────────────────────────────────────────────────

function objetivosPorDefecto() {
  return [...P1_SQL.filter(existsSync), ...P1_TS_FILES.filter(existsSync)]
}

function correr(objetivos) {
  const fallos = []
  for (const ruta of objetivos) {
    if (!existsSync(ruta)) { fallos.push(`FALTA ${ruta}`); continue }
    const src = readFileSync(ruta, 'utf8')
    fallos.push(...(extname(ruta) === '.sql' ? revisarSql(ruta, src) : revisarTs(ruta, src)))
  }
  fallos.push(...revisarMigracionesSelladas())
  return fallos
}

// ── Self-test ───────────────────────────────────────────────────────────────

function selfTest() {
  let ok = 0, ko = 0
  const chk = (nombre, cond) => {
    if (cond) { ok++; console.log(`  ok  ${nombre}`) }
    else { ko++; console.error(`  FALLA ${nombre}`) }
  }
  const CAJA = (grid) =>
    `{activeTab === 'caja' && (<><div style={{ display: 'grid', gridTemplateColumns: '${grid}' }}>` +
    `{cashMethods.map(m => <CashCard key={m} />)}</div></>)}`

  // ── P1 ──
  chk('p1 detecta repeat(4,1fr) en la pestana Caja',
    revisarGridMovil('src/pages/FinanceDashboard.tsx', CAJA('repeat(4, 1fr)')).some(x => /^P1 /.test(x)))
  chk('p1 detecta repeat(3,1fr) en la pestana Caja',
    revisarGridMovil('src/pages/FinanceDashboard.tsx', CAJA('repeat(3, 1fr)')).some(x => /^P1 /.test(x)))
  chk('p1 acepta auto-fit + minmax',
    revisarGridMovil('src/pages/FinanceDashboard.tsx',
      CAJA('repeat(auto-fit, minmax(150px, 1fr))')).length === 0)
  chk('p1 acepta una sola columna',
    revisarGridMovil('src/pages/FinanceDashboard.tsx', CAJA('repeat(1, 1fr)')).length === 0)
  chk('p1 no acusa a otra pestana',
    revisarGridMovil('src/pages/FinanceDashboard.tsx',
      `{activeTab === 'auditoria' && (<div style={{ gridTemplateColumns: 'repeat(4, 1fr)' }} />)}`).length === 0)
  chk('p1 no acusa a otro archivo',
    revisarGridMovil('src/pages/Tasks.tsx', CAJA('repeat(4, 1fr)')).length === 0)
  chk('p1 ignora el grid dentro de un comentario',
    revisarGridMovil('src/pages/FinanceDashboard.tsx',
      `{activeTab === 'caja' && (<>\n// antes habia repeat(4, 1fr) aca\n</>)}`).length === 0)

  // ── P2 ──
  const VISTA_OK = `CREATE OR REPLACE VIEW "public"."v_finance_position" WITH (security_invoker = true) AS
    WITH inv AS (SELECT c.business_id, c.inventory_at_cost FROM v_finance_inventory_capital c) SELECT 1;`
  const VISTA_MAL = `CREATE OR REPLACE VIEW "public"."v_finance_position" WITH (security_invoker = true) AS
    WITH inv AS (SELECT i.business_id FROM inventory i WHERE NOT EXISTS (
      SELECT 1 FROM inventory v WHERE v.supplier_code = 'VPREF-' || i.id::text)) SELECT 1;`
  chk('p2 acepta la delegacion en la vista canonica',
    revisarSql('m.sql', VISTA_OK).filter(x => /^P2 /.test(x)).length === 0)
  chk('p2 detecta que position dejo de delegar',
    revisarSql('m.sql', VISTA_MAL).some(x => /^P2 /.test(x) && /deja de leer/.test(x)))
  chk('p2 detecta el predicado copiado',
    revisarSql('m.sql', VISTA_MAL).some(x => /^P2 /.test(x) && /copio el predicado/.test(x)))
  chk('p2 detecta VPREF sin parent_id',
    revisarSql('m.sql',
      `CREATE OR REPLACE VIEW public.v_x AS SELECT 1 WHERE supplier_code <> 'VPREF-' || id::text;`)
      .some(x => /^P2 /.test(x) && /no por parent_id/.test(x)))
  chk('p2 acepta VPREF junto a parent_id',
    revisarSql('m.sql',
      `CREATE OR REPLACE VIEW public.v_x AS SELECT 1 FROM t WHERE parent_id IS NULL AND supplier_code <> 'VPREF-' || id::text;`)
      .filter(x => /^P2 /.test(x)).length === 0)

  // ── P3 ──
  chk('p3 detecta el calculo de reposicion en React',
    revisarTs('x.tsx', `const r = f.purchases_cost / f.consumption_cost`).some(x => /^P3 /.test(x)))
  chk('p3 acepta el indice que ya vino calculado',
    revisarTs('x.tsx', `const r = f.replenishment_pct`).filter(x => /^P3 /.test(x)).length === 0)

  // ── P4 ──
  chk('p4 detecta supplier_purchases sumado en React',
    revisarTs('x.tsx', `const n = f.purchases_cost + f.supplier_purchases_amount`).some(x => /^P4 /.test(x)))
  chk('p4 detecta supplier_purchases en aritmetica SQL',
    revisarSql('m.sql', `SELECT purchases_cost + supplier_purchases_amount FROM agg;`).some(x => /^P4 /.test(x)))
  chk('p4 acepta el contexto sin operar',
    revisarTs('x.tsx', `const hay = (f.supplier_purchases_count ?? 0) > 0`).filter(x => /^P4 /.test(x)).length === 0)
  chk('p4 acepta emitir la clave en SQL',
    revisarSql('m.sql', `SELECT jsonb_build_object('supplier_purchases_count', a.supplier_purchases_count);`)
      .filter(x => /^P4 /.test(x)).length === 0)

  // ── P5 ──
  chk('p5 detecta "descapitalizacion" afirmada',
    revisarLenguaje('x.tsx', `const t = 'Te estás descapitalizando.'`).some(x => /^P5 /.test(x)))
  chk('p5 acepta la mencion NEGADA (documentar la prohibicion)',
    revisarLenguaje('x.tsx',
      `// Menos compras que consumo NO significa descapitalizacion.`).filter(x => /^P5 /.test(x)).length === 0)

  // ── P7 ──
  chk('p7 detecta backfill',
    revisarSql('m.sql', `UPDATE comprobantes SET estado_fiscal = 'no_fiscal';`).some(x => /^P7 /.test(x)))
  chk('p7 acepta una tabla temporal de baseline',
    revisarSql('m.sql', `CREATE TEMP TABLE _p1_baseline AS SELECT 1;`).filter(x => /^P7 /.test(x)).length === 0)
  chk('p7 acepta ALTER COLUMN SET DEFAULT (no es DML)',
    revisarSql('m.sql', `ALTER TABLE public.comprobantes ALTER COLUMN estado_fiscal SET DEFAULT 'no_fiscal';`)
      .filter(x => /^P7 /.test(x)).length === 0)

  // ── P8 ──
  chk('p8 detecta SECURITY DEFINER nuevo',
    revisarSql('m.sql', `CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;`)
      .some(x => /^P8 /.test(x)))
  chk('p8 acepta SECURITY INVOKER',
    revisarSql('m.sql', `CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY INVOKER AS $$ SELECT 1 $$;`)
      .filter(x => /^P8 /.test(x)).length === 0)
  chk('p8 NO acusa a la postcondicion que verifica lo contrario',
    revisarSql('m.sql',
      `DO $p$ BEGIN IF prosecdef THEN RAISE EXCEPTION 'R2a: la RPC quedo SECURITY DEFINER'; END IF; END $p$;`)
      .filter(x => /^P8 /.test(x)).length === 0)
  chk('p9 NO acusa al mensaje que denuncia acceso de anon',
    revisarSql('m.sql',
      `DO $p$ BEGIN RAISE EXCEPTION 'R2: GRANT SELECT ON v TO anon quedo abierto'; END $p$;`)
      .filter(x => /^P9 /.test(x)).length === 0)

  // ── P9 ──
  chk('p9 detecta RLS desactivada',
    revisarSql('m.sql', `ALTER TABLE public.x DISABLE ROW LEVEL SECURITY;`).some(x => /^P9 /.test(x)))
  chk('p9 detecta DROP POLICY',
    revisarSql('m.sql', `DROP POLICY p ON public.x;`).some(x => /^P9 /.test(x)))
  chk('p9 detecta GRANT a anon',
    revisarSql('m.sql', `GRANT SELECT ON public.v TO anon;`).some(x => /^P9 /.test(x)))
  chk('p9 detecta GRANT a PUBLIC',
    revisarSql('m.sql', `GRANT EXECUTE ON FUNCTION f() TO PUBLIC;`).some(x => /^P9 /.test(x)))
  chk('p9 acepta GRANT a authenticated/service_role',
    revisarSql('m.sql', `GRANT SELECT ON public.v TO authenticated, service_role;`)
      .filter(x => /^P9 /.test(x)).length === 0)
  chk('p9 acepta REVOKE de anon/PUBLIC',
    revisarSql('m.sql', `REVOKE ALL ON public.v FROM PUBLIC; REVOKE EXECUTE ON FUNCTION f() FROM anon;`)
      .filter(x => /^P9 /.test(x)).length === 0)

  // ── P10 ──
  chk('p10 detecta que se afirma mercaderia recibida',
    revisarLenguaje('x.tsx', `const t = 'Compraste mercadería y no la ingresaste.'`).some(x => /^P10 /.test(x)))
  chk('p10 acepta la redaccion condicional canonica',
    revisarLenguaje('x.tsx',
      `const t = 'Hay compras a proveedores registradas. Si corresponden a mercadería recibida, revisá que se haya ingresado al inventario.'`)
      .filter(x => /^P10 /.test(x)).length === 0)
  chk('p10 acepta la frase factual de inventario',
    revisarLenguaje('x.tsx',
      `const t = 'No se registraron entradas de mercadería en inventario durante este período.'`)
      .filter(x => /^P10 /.test(x)).length === 0)

  // ── P6 — sellado de migraciones desplegadas ──
  chk('p6 detecta una migracion sellada modificada',
    revisarMigracionesSelladas(() => 'contenido alterado').some(x => /^P6 /.test(x)))
  chk('p6 acepta las migraciones selladas intactas',
    revisarMigracionesSelladas().length === 0)
  chk('p6 sella las 4 migraciones ya aplicadas a produccion (218 + 219 + 220 + 221)',
    Object.keys(MIGRACIONES_SELLADAS).length === 4 &&
    ['20260810120000', '20260810130000', '20260810140000', '20260810150000']
      .every(ts => Object.keys(MIGRACIONES_SELLADAS).some(k => k.includes(ts))))
  chk('p6 el sello es insensible al fin de linea (checkout Windows no es un cambio)',
    (() => {
      const [ruta] = Object.keys(MIGRACIONES_SELLADAS)
      const src = readFileSync(ruta, 'utf8')
      return revisarMigracionesSelladas((p) => p === ruta ? src.replace(/\n/g, '\r\n') : readFileSync(p, 'utf8')).length === 0
    })())

  // Un comentario que menciona lo prohibido NO puede hacer fallar al guard.
  chk('los comentarios de codigo no disparan falsos positivos en P3/P4',
    revisarTs('x.tsx',
      `// no sumar supplier_purchases_amount + purchases_cost aca\nconst a = 1`)
      .filter(x => /^P[34] /.test(x)).length === 0)

  console.log(`\nself-test: ${ok} ok, ${ko} fallas`)
  return ko === 0
}

// ── main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
if (args.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1)
}

const objetivos = args.length ? args.flatMap(listarArchivos) : objetivosPorDefecto()
const fallos = correr(objetivos)

if (fallos.length) {
  console.error('Pre-beta P1 — guard FALLO:\n')
  for (const f of fallos) console.error(`  · ${f}`)
  console.error(`\n${fallos.length} problema(s).`)
  process.exit(1)
}
console.log(`Pre-beta P1 — guard OK (${objetivos.length} archivo(s) revisados).`)
