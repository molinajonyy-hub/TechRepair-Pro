#!/usr/bin/env node
// ============================================================================
// M8 — Guard del motor determinista de insights.
//
// ACOTADO a este lote. NO duplica reglas de otros guards; cuando una regla ya
// vive en otro archivo se delega explicitamente:
//   · higiene general de SECDEF (search_path, pg_temp) -> guard-security-definer.mjs
//   · RPC SECDEF publica fuera de allowlist        -> guard-secdef-exposure.mjs
//   · escrituras financieras directas              -> guards/no-direct-finance-writes.mjs
//
// Falla (exit 1) cuando:
//   R1.  el catalogo de reglas de la migracion y el de insightsService.ts no
//        coinciden exactamente (bloquea la "regla numero 11" indocumentada).
//   R2.  la tabla finance_insights se crea sin CHECK de evidence obligatorio.
//   R3.  la tabla se crea sin CHECK de action tipada con allowlist de rutas.
//   R4.  React calcula metricas financieras sobre insights (aritmetica sobre
//        evidence/impact en .tsx).
//   R5.  falta rule_id o rule_version en la tabla.
//   R6.  se usa select('*') sobre finance_insights.
//   R7.  la migracion crea una SECURITY DEFINER sin REVOKE de PUBLIC.
//   R8.  se le da a `anon` cualquier acceso a finance_insights o a sus RPC.
//   R9.  el lote introduce cron/scheduler/Edge para generar insights.
//   R10. el lote instala/importa una libreria de graficos.
//   R11. una ruta de `action` en SQL o en el service no existe en el router.
//   R12. la migracion hace backfill / DML historico.
//   R13. la migracion toca importes financieros.
//   R14. el motor formatea numeros con to_char (locale del servidor -> en-US).
//   R15. `message` interpola valores con format() en vez de dejarlos en evidence.
//   R16. React parsea numeros desde `message`, o lo usa como fuente de verdad.
//   R17. se modifica una migracion M8 YA APLICADA a produccion.
//   R18. aparece un formatter de moneda ad-hoc dentro del alcance M8 en vez de
//        usar el presentador canonico.
//
//   node scripts/finance/guard-m8-insights.mjs [archivo|dir ...]
//   node scripts/finance/guard-m8-insights.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, basename, extname } from 'node:path'

// Las migraciones de M8. Las anteriores son historia inmutable y no se auditan acá.
const M8_SQL = [
  'supabase/migrations/20260806120000_supplier_purchase_due_date.sql',
  'supabase/migrations/20260806130000_finance_insights.sql',
  'supabase/migrations/20260807120000_finance_insight_locale_safe_messages.sql',
]

// R17 — migraciones M8 ya aplicadas a produccion. Editarlas hace que un db reset
// futuro construya otro esquema mientras produccion conserva el cuerpo viejo:
// repo y produccion divergen en semantica sin que nada falle. Forward-only.
const APLICADAS = {
  'supabase/migrations/20260806120000_supplier_purchase_due_date.sql':
    'b5bdcd392b4564eeed1703ea3306d9a778be0b418e716f8733d41fc09d493fe7',
  'supabase/migrations/20260806130000_finance_insights.sql':
    '6591d3a150557fa08c085f5d8c97bfa24fcb1b2e85ca72dfee38925b4825f7b6',
}

const M8_TS = [
  'src/services/insightsService.ts',
  'src/components/finance/FinanceInsightsPanel.tsx',
  'src/lib/finance/financeInsightPresentation.ts',
]
// El presentador es el UNICO lugar donde se permite Intl.NumberFormat en M8.
const PRESENTADOR = 'src/lib/finance/financeInsightPresentation.ts'
const ROUTER = 'src/App.tsx'

const REGLAS_ESPERADAS = [
  'margin_drop_cost', 'cash_down_sales_up', 'dead_stock', 'withdrawals_vs_profit',
  'fixed_coverage', 'breakeven_day', 'supplier_crunch', 'fx_stale_prices',
  'data_quality', 'cc_aging',
]

const LIBS_GRAFICOS = ['recharts', 'chart.js', 'victory', 'nivo', 'echarts', 'plotly', 'd3-sankey', 'apexcharts']

const leer = p => { try { return readFileSync(p, 'utf8') } catch { return null } }

function listar(dir, exts) {
  const out = []
  const walk = d => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(d, e.name)
      if (e.isDirectory()) { if (!['node_modules', 'dist', '.git'].includes(e.name)) walk(p) }
      else if (exts.includes(extname(e.name))) out.push(p)
    }
  }
  walk(dir)
  return out
}

// ─── Reglas SQL ─────────────────────────────────────────────────────────────
// `esMotorVigente`: sólo la migración MÁS RECIENTE que define
// generate_finance_insights se audita por formato de textos. Las anteriores ya
// están aplicadas y son historia inmutable.
function revisarSql(archivo, sql, esMotorVigente = false) {
  const h = []
  const f = basename(archivo)
  const esMotor = /finance_insights\.sql$/.test(archivo) || /CREATE TABLE[^;]*finance_insights/i.test(sql)

  // R14/R15 — el motor vigente no puede formatear números: la DB manda el
  // valor crudo en `evidence` y el frontend lo formatea en es-AR. to_char
  // depende de lc_numeric del servidor (en produccion, en_US).
  if (esMotorVigente) {
    const cuerpo = sql.split('$fn$')[1] || ''
    if (/to_char/i.test(cuerpo)) {
      h.push(`${f}: R14 el motor usa to_char — el formato depende de lc_numeric del servidor`)
    }
    if (/'message',\s*format\(/.test(cuerpo)) {
      h.push(`${f}: R15 'message' interpola valores con format(); los números van en evidence`)
    }
  }

  if (esMotor) {
    // R1/R5 — catalogo cerrado y columnas de identidad de regla.
    const mCat = sql.match(/rule_id\s+IN\s*\(([^)]*)\)/i)
    if (!mCat) {
      h.push(`${f}: R1 la tabla no declara un CHECK con el catalogo cerrado de rule_id`)
    } else {
      // [a-z0-9_] y no [a-z_]: una "regla_11" con digitos debe SER VISIBLE para
      // el guard, no quedar fuera del match y pasar como si no existiera.
      const enSql = [...mCat[1].matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]).sort()
      const esperadas = [...REGLAS_ESPERADAS].sort()
      if (JSON.stringify(enSql) !== JSON.stringify(esperadas)) {
        const extra = enSql.filter(r => !esperadas.includes(r))
        const falta = esperadas.filter(r => !enSql.includes(r))
        h.push(`${f}: R1 catalogo de reglas distinto del documentado`
          + (extra.length ? ` · sobran: ${extra.join(', ')}` : '')
          + (falta.length ? ` · faltan: ${falta.join(', ')}` : ''))
      }
    }
    if (!/rule_id\s+text\s+NOT NULL/i.test(sql) || !/rule_version\s+text\s+NOT NULL/i.test(sql)) {
      h.push(`${f}: R5 finance_insights sin rule_id/rule_version NOT NULL`)
    }

    // R2/R3 — evidence y action verificables por la base, no por convencion.
    if (!/evidence\s*\?\s*'metric'/i.test(sql) || !/evidence\s*\?\s*'calculation_version'/i.test(sql)) {
      h.push(`${f}: R2 falta el CHECK que exige evidence completo (metric + calculation_version)`)
    }
    if (!/action->>'target_type'\s+IN/i.test(sql)) {
      h.push(`${f}: R3 falta el CHECK que tipa action.target_type`)
    }
    if (!/action->>'target'\s+IN\s*\(/i.test(sql)) {
      h.push(`${f}: R3 falta la allowlist de rutas en el CHECK de action`)
    }
  }

  // R7 — toda SECDEF nueva revoca de PUBLIC.
  const secdefs = [...sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([\w.]+)\s*\(/gi)]
    .map(m => m[1].replace(/^public\./, ''))
    .filter(nombre => {
      const i = sql.indexOf(nombre)
      const cuerpo = sql.slice(i, i + 4000)
      return /SECURITY\s+DEFINER/i.test(cuerpo)
    })
  for (const fn of secdefs) {
    const reRevoke = new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+(public\\.)?${fn}\\s*\\([^)]*\\)\\s+FROM\\s+PUBLIC`, 'i')
    if (!reRevoke.test(sql)) h.push(`${f}: R7 SECURITY DEFINER ${fn}() sin REVOKE ALL ... FROM PUBLIC`)
  }

  // R8 — anon a cero.
  const grantAnon = [...sql.matchAll(/GRANT\s+[^;]*?\s+ON\s+(TABLE\s+)?[^;]*?(finance_insights|generate_finance_insights|finance_insights_read|v_finance_payables_due)[^;]*?TO\s+([^;]*)/gi)]
  for (const g of grantAnon) {
    if (/\banon\b/i.test(g[3])) h.push(`${f}: R8 GRANT a anon sobre ${g[2]}`)
  }
  if (/CREATE\s+POLICY[^;]*finance_insights[^;]*TO\s+[^;]*\banon\b/i.test(sql)) {
    h.push(`${f}: R8 policy de finance_insights alcanzable por anon`)
  }
  // Una policy sin clausula TO es PUBLIC (anon incluido).
  const pols = [...sql.matchAll(/CREATE\s+POLICY\s+\w+\s+ON\s+(public\.)?finance_insights([\s\S]*?);/gi)]
  for (const p of pols) if (!/\bTO\s+\w/i.test(p[2])) h.push(`${f}: R8 policy de finance_insights sin clausula TO (= PUBLIC)`)

  // R12 — cero backfill / DML historico.
  const dml = [...sql.matchAll(/^\s*(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+(public\.)?(\w+)/gim)]
  const TABLAS_OK = ['finance_insights', '_m8a_baseline', '_m8b_baseline']
  for (const d of dml) {
    const tabla = d[3]
    if (!TABLAS_OK.includes(tabla) && !tabla.startsWith('_')) {
      h.push(`${f}: R12 DML historico sobre ${tabla} (${d[1].toUpperCase()}) — M8 no hace backfill`)
    }
  }

  // R13 — no se tocan importes.
  if (/SET\s+[^;]*\b(total_amount|paid_amount|pending_amount|amount_ars|total_cobrado|saldo_pendiente|balance_after)\b\s*=/i.test(sql)) {
    h.push(`${f}: R13 la migracion modifica importes financieros`)
  }

  // R9 — sin cron/scheduler.
  if (/\b(cron\.schedule|pg_cron|pg_net|net\.http_post)\b/i.test(sql)) {
    h.push(`${f}: R9 el lote introduce cron/scheduler; M8 v1 es on-demand`)
  }

  return h
}

// ─── Reglas TS/TSX ──────────────────────────────────────────────────────────
function revisarTs(archivo, src, rutasRouter) {
  const h = []
  const f = archivo.replace(/\\/g, '/')

  // R6 — select('*') sobre finance_insights.
  if (/from\(\s*['"]finance_insights['"]\s*\)[\s\S]{0,80}?select\(\s*['"]\*['"]/i.test(src)) {
    h.push(`${f}: R6 select('*') sobre finance_insights — pedir columnas explicitas`)
  }

  // R4 — React no calcula metricas financieras.
  if (extname(archivo) === '.tsx') {
    const lineas = src.split('\n')
    lineas.forEach((l, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return
      // aritmetica sobre evidence/impact = calculo financiero en el cliente
      if (/\b(evidence|impact_ars)\b[^\n]*[-+*/]\s*[\w.]/.test(l) && !/`|'|"/.test(l.replace(/\/\/.*/, ''))) {
        h.push(`${f}:${i + 1} R4 React calcula sobre datos financieros del insight; el motor vive en la DB`)
      }
    })
  }

  // R10 — sin librerias de graficos.
  for (const lib of LIBS_GRAFICOS) {
    const re = new RegExp(`from\\s+['"]${lib.replace('.', '\\.')}`, 'i')
    if (re.test(src)) h.push(`${f}: R10 importa la libreria de graficos "${lib}"; M8 no implementa graficos`)
  }

  // R11 — rutas declaradas en el service deben existir en el router.
  if (/INSIGHT_ALLOWED_ROUTES/.test(src) && rutasRouter) {
    const m = src.match(/INSIGHT_ALLOWED_ROUTES\s*=\s*\[([\s\S]*?)\]/)
    if (m) {
      for (const r of [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])) {
        if (!rutasRouter.has(r)) h.push(`${f}: R11 la ruta "${r}" no existe en el router`)
      }
    }
  }

  // R9 — sin scheduler client-side.
  if (/setInterval\([^)]*generate_finance_insights|cron/i.test(src)) {
    h.push(`${f}: R9 scheduler client-side para generar insights`)
  }

  // R16 — `message` es un fallback cualitativo, NO una fuente de números.
  // Parsearlo devolvería el mismo bug por otra puerta.
  if (/\.message[^\n]*\.(match|replace|split|parse)\(/.test(src)
   || /(parseFloat|parseInt|Number)\s*\([^)]*\.message/.test(src)) {
    h.push(`${f}: R16 se parsean números desde insight.message; usar evidence`)
  }

  // R18 — un único formatter de moneda en el alcance M8: el presentador.
  if (extname(archivo) !== '.mjs' && !f.endsWith(PRESENTADOR.split('/').pop())) {
    if (/Intl\.NumberFormat\([^)]*currency/.test(src)) {
      h.push(`${f}: R18 formatter de moneda ad-hoc; usar financeInsightPresentation`)
    }
  }

  return h
}

// ─── R17 — las migraciones ya aplicadas son inmutables ──────────────────────
function revisarInmutables() {
  const h = []
  for (const [ruta, esperado] of Object.entries(APLICADAS)) {
    const src = leer(ruta)
    if (src === null) { h.push(`${ruta}: R17 falta una migracion ya aplicada a produccion`); continue }
    // Normaliza saltos de linea: un checkout Windows no es una modificacion.
    const real = createHash('sha256').update(src.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
    if (real !== esperado) {
      h.push(`${ruta}: R17 se modifico una migracion YA APLICADA a produccion `
        + `(sha256 ${real.slice(0, 16)}… != ${esperado.slice(0, 16)}…). `
        + `Editarla divergiria repo vs produccion: hace falta una migracion forward-only.`)
    }
  }
  return h
}

function rutasDelRouter() {
  const src = leer(ROUTER)
  if (!src) return null
  const set = new Set()
  for (const m of src.matchAll(/path="([^"]+)"/g)) {
    let p = m[1]
    if (p === '/*' || p.includes(':')) continue
    if (!p.startsWith('/')) p = '/' + p
    set.add(p)
  }
  // Rutas anidadas declaradas sin barra inicial ya quedaron normalizadas arriba.
  return set
}

// ─── Self-test ──────────────────────────────────────────────────────────────
function autoTest() {
  const dir = mkdtempSync(join(tmpdir(), 'm8guard-'))
  let fallas = 0
  const chk = (label, cond) => { if (!cond) { fallas++; console.log(`FALLA ${label}`) } else console.log(`OK    ${label}`) }

  const escribir = (nombre, contenido) => { const p = join(dir, nombre); writeFileSync(p, contenido); return p }

  const TABLA_OK = `
CREATE TABLE public.finance_insights (
  rule_id text NOT NULL, rule_version text NOT NULL,
  CONSTRAINT c1 CHECK (rule_id IN (${REGLAS_ESPERADAS.map(r => `'${r}'`).join(',')})),
  CONSTRAINT c2 CHECK (evidence ? 'metric' AND evidence ? 'calculation_version'),
  CONSTRAINT c3 CHECK (action->>'target_type' IN ('route','drawer','none')
    AND (action->>'target_type' <> 'route' OR action->>'target' IN ('/finance','/inventory')))
);`

  // R1: catalogo con una regla de mas
  const conRegla11 = TABLA_OK.replace("'cc_aging'", "'cc_aging','regla_11'")
  chk('r1 detecta una regla numero 11',
    revisarSql(escribir('a_finance_insights.sql', conRegla11), conRegla11).some(x => /R1/.test(x)))
  chk('r1 acepta el catalogo exacto',
    !revisarSql(escribir('b_finance_insights.sql', TABLA_OK), TABLA_OK).some(x => /R1/.test(x)))

  // R2
  const sinEvidence = TABLA_OK.replace(/CONSTRAINT c2[^,]*,/, '')
  chk('r2 detecta la falta del CHECK de evidence',
    revisarSql(escribir('c_finance_insights.sql', sinEvidence), sinEvidence).some(x => /R2/.test(x)))

  // R3
  const sinAllowlist = TABLA_OK.replace(/AND \(action->>'target_type' <> 'route'[^)]*\)\)/, ')')
  chk('r3 detecta la falta de allowlist de rutas',
    revisarSql(escribir('d_finance_insights.sql', sinAllowlist), sinAllowlist).some(x => /R3/.test(x)))

  // R7
  const secdefSinRevoke = `CREATE OR REPLACE FUNCTION public.foo_fn(a uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN '{}'::jsonb; END $$;
    GRANT EXECUTE ON FUNCTION public.foo_fn(uuid) TO authenticated;`
  chk('r7 detecta SECDEF sin REVOKE de PUBLIC',
    revisarSql(escribir('e.sql', secdefSinRevoke), secdefSinRevoke).some(x => /R7/.test(x)))
  const secdefConRevoke = secdefSinRevoke + `\nREVOKE ALL ON FUNCTION public.foo_fn(uuid) FROM PUBLIC;`
  chk('r7 acepta SECDEF con REVOKE',
    !revisarSql(escribir('f.sql', secdefConRevoke), secdefConRevoke).some(x => /R7/.test(x)))

  // R8
  const grantAnon = `GRANT SELECT ON TABLE public.finance_insights TO anon;`
  chk('r8 detecta GRANT a anon',
    revisarSql(escribir('g.sql', grantAnon), grantAnon).some(x => /R8/.test(x)))
  const polSinTo = `CREATE POLICY p1 ON public.finance_insights FOR SELECT USING (true);`
  chk('r8 detecta policy sin clausula TO',
    revisarSql(escribir('h.sql', polSinTo), polSinTo).some(x => /R8/.test(x)))

  // R12
  const backfill = `UPDATE supplier_purchases SET due_date = purchase_date + 30;`
  chk('r12 detecta backfill historico',
    revisarSql(escribir('i.sql', backfill), backfill).some(x => /R12/.test(x)))
  const insertPropio = `INSERT INTO finance_insights (rule_id) SELECT 'dead_stock';`
  chk('r12 permite escribir en finance_insights (es su propia tabla)',
    !revisarSql(escribir('j.sql', insertPropio), insertPropio).some(x => /R12/.test(x)))

  // R13
  const tocaImportes = `UPDATE finance_insights SET pending_amount = 0;`
  chk('r13 detecta modificacion de importes',
    revisarSql(escribir('k.sql', tocaImportes), tocaImportes).some(x => /R13/.test(x)))

  // R9
  const conCron = `SELECT cron.schedule('m8','0 3 * * *', $$ SELECT 1 $$);`
  chk('r9 detecta cron',
    revisarSql(escribir('l.sql', conCron), conCron).some(x => /R9/.test(x)))

  // R6 / R10 / R11
  const rutas = new Set(['/finance', '/inventory'])
  const selStar = `supabase.from('finance_insights').select('*')`
  chk('r6 detecta select(*)', revisarTs('x.ts', selStar, rutas).some(x => /R6/.test(x)))
  const conRecharts = `import { BarChart } from 'recharts'`
  chk('r10 detecta libreria de graficos', revisarTs('x.ts', conRecharts, rutas).some(x => /R10/.test(x)))
  const rutaMuerta = `export const INSIGHT_ALLOWED_ROUTES = ['/finance','/finance/charts/waterfall']`
  chk('r11 detecta ruta inexistente', revisarTs('x.ts', rutaMuerta, rutas).some(x => /R11/.test(x)))
  const rutasOk = `export const INSIGHT_ALLOWED_ROUTES = ['/finance','/inventory']`
  chk('r11 acepta rutas reales', !revisarTs('x.ts', rutasOk, rutas).some(x => /R11/.test(x)))

  // R4
  const calculoEnReact = `const total = insight.evidence.dead_value / insight.evidence.inventory_at_cost`
  chk('r4 detecta calculo financiero en React',
    revisarTs('x.tsx', calculoEnReact, rutas).some(x => /R4/.test(x)))

  // R14 — to_char en el motor vigente
  const motorConToChar = `CREATE OR REPLACE FUNCTION public.generate_finance_insights(a uuid) AS $fn$
    BEGIN v := jsonb_build_object('message', to_char(x,'FM999G999D00')); END $fn$;`
  chk('r14 detecta to_char en el motor vigente',
    revisarSql(escribir('m1.sql', motorConToChar), motorConToChar, true).some(x => /R14/.test(x)))
  const motorSinToChar = `CREATE OR REPLACE FUNCTION public.generate_finance_insights(a uuid) AS $fn$
    BEGIN v := jsonb_build_object('message', 'texto cualitativo'); END $fn$;`
  chk('r14 acepta un motor sin to_char',
    !revisarSql(escribir('m2.sql', motorSinToChar), motorSinToChar, true).some(x => /R14/.test(x)))
  chk('r14 NO audita una migracion vieja ya aplicada',
    !revisarSql(escribir('m3.sql', motorConToChar), motorConToChar, false).some(x => /R14/.test(x)))

  // R15 — message con format()
  const msgConFormat = `CREATE OR REPLACE FUNCTION public.generate_finance_insights(a uuid) AS $fn$
    BEGIN v := jsonb_build_object('message', format('Tenes %s', x)); END $fn$;`
  chk('r15 detecta message interpolado con format()',
    revisarSql(escribir('m4.sql', msgConFormat), msgConFormat, true).some(x => /R15/.test(x)))

  // R16 — parsear numeros desde message
  const parseaMessage = `const n = parseFloat(insight.message.replace(/[^0-9.]/g, ''))`
  chk('r16 detecta parseo de numeros desde message',
    revisarTs('x.ts', parseaMessage, rutas).some(x => /R16/.test(x)))
  const usaEvidence = `const n = insight.evidence.dead_value`
  chk('r16 acepta leer desde evidence',
    !revisarTs('x.ts', usaEvidence, rutas).some(x => /R16/.test(x)))

  // R18 — formatter de moneda duplicado
  const formatterAdHoc = `const f = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' })`
  chk('r18 detecta un formatter de moneda ad-hoc',
    revisarTs('OtroArchivo.tsx', formatterAdHoc, rutas).some(x => /R18/.test(x)))
  chk('r18 permite el formatter dentro del presentador canonico',
    !revisarTs('financeInsightPresentation.ts', formatterAdHoc, rutas).some(x => /R18/.test(x)))

  // R17 — migraciones aplicadas inmutables
  chk('r17 valida el hash de las migraciones ya aplicadas',
    revisarInmutables().length === 0)

  console.log(fallas === 0 ? '\nself-test OK' : `\nself-test con ${fallas} fallas`)
  process.exit(fallas === 0 ? 0 : 1)
}

// ─── main ───────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) autoTest()

const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const rutas = rutasDelRouter()
const hallazgos = []

const sqlObjetivo = args.length
  ? args.filter(a => extname(a) === '.sql')
  : M8_SQL.filter(existsSync)
const tsObjetivo = args.length
  ? args.filter(a => ['.ts', '.tsx'].includes(extname(a)))
  : M8_TS.filter(existsSync)

// El motor VIGENTE es la migración más reciente que redefine la función.
const defineMotor = a => (leer(a) || '').includes('FUNCTION public.generate_finance_insights')
const motorVigente = [...sqlObjetivo].filter(defineMotor).sort().pop()

for (const a of sqlObjetivo) {
  const sql = leer(a)
  if (sql === null) { hallazgos.push(`${a}: no se pudo leer`); continue }
  hallazgos.push(...revisarSql(a, sql, a === motorVigente))
}
if (!args.length) hallazgos.push(...revisarInmutables())
for (const a of tsObjetivo) {
  const src = leer(a)
  if (src === null) { hallazgos.push(`${a}: no se pudo leer`); continue }
  hallazgos.push(...revisarTs(a, src, rutas))
}

// R10 global: la libreria de graficos tampoco puede entrar por package.json.
const pkg = leer('package.json')
if (pkg) {
  const deps = { ...(JSON.parse(pkg).dependencies || {}), ...(JSON.parse(pkg).devDependencies || {}) }
  for (const lib of LIBS_GRAFICOS) {
    if (deps[lib]) hallazgos.push(`package.json: R10 se instalo la libreria de graficos "${lib}"; M8 no implementa graficos`)
  }
}

if (hallazgos.length) {
  console.error('guard-m8-insights: HALLAZGOS\n')
  for (const h of hallazgos) console.error(`  · ${h}`)
  process.exit(1)
}
console.log('guard-m8-insights OK — catalogo cerrado, evidence/action verificables, anon a cero, cero backfill, sin graficos.')
