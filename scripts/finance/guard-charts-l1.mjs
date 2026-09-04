#!/usr/bin/env node
// ============================================================================
// Charts L1 — Guard de arquitectura de las visualizaciones financieras.
//
// ACOTADO a este lote. No duplica reglas de otros guards; cuando una regla ya
// vive en otro archivo se delega:
//   · higiene de SECURITY DEFINER      -> guard-security-definer.mjs
//   · RPC SECDEF fuera de allowlist    -> guard-secdef-exposure.mjs
//   · escrituras financieras directas  -> guards/no-direct-finance-writes.mjs
//   · contrato del motor M8            -> guard-m8-insights.mjs
//
// Falla (exit 1) cuando:
//   R1.  React suma tablas financieras crudas (consulta directa a una tabla de
//        dinero desde el alcance de gráficos).
//   R2.  React reconstruye el P&L (re-deriva gross_profit / operating_result).
//   R3.  React reconstruye COGS.
//   R4.  React reconstruye stock financiero (stock x costo).
//   R5.  React aplica tipo de cambio (no hay FX server-side: aplicarlo en el
//        cliente inventa historia patrimonial).
//   R6.  React calcula la reposición desde movimientos crudos.
//   R7.  aparece un select('*') nuevo en el alcance L1.
//   R8.  se usa una API externa para alimentar los gráficos.
//   R9.  se mezclan retiros del dueño con gastos operativos.
//   R10. se cuenta cuenta corriente como cobro.
//   R11. se mezcla aging con due_date (o se inventa purchase_date + N días).
//   R12. se llama "capital total" / "patrimonio" / "capital invertido total" a
//        lo que sólo es inventario.
//   R13. el lote agrega Realtime.
//   R14. el lote agrega una materialized view.
//   R15. la migración hace backfill / DML sobre datos históricos.
//   R16. se agrega una SEGUNDA librería de gráficos.
//   R17. se modifica una migración M8 ya aplicada a producción.
//   R18. se formatean importes con to_char/format en SQL (el locale del server
//        es en_US: el formato es responsabilidad del frontend).
//   R19. se le promete al usuario que "Capital en stock" es valor/costo de
//        REPOSICIÓN o que está ajustado al dólar de hoy. La métrica es
//        stock x costo REGISTRADO, y no hay fuente FX server-side que pueda
//        respaldar esa afirmación.
//   R20. una vista del alcance reintroduce la FORMA HISTORICA CONOCIDA del
//        anti-join correlacionado: `NOT EXISTS (... col = 'PREFIJO-' || ext.id)`.
//        No hashea ni indexa; reescanea la tabla interna una vez por fila
//        externa y en `inventory` cada fila reevalúa la policy RLS. Medido en
//        producción: 32.786 ms y 57014 en get_finance_charts_l1.
//
//        ALCANCE REAL, medido: R20 detecta ESA escritura, no la clase
//        semántica. Reformulaciones equivalentes se le escapan —operandos
//        invertidos, `concat()`, `format()`, `NOT IN`—. Es un tripwire
//        estático barato, NO un detector de equivalencia SQL.
//
//        La protección autoritativa contra reescrituras equivalentes es
//        V07 de tests/sql/finance_inventory_capital_perf.test.sql: corre la
//        consulta REAL (vista acotada por business_id, como authenticated) y
//        asevera sobre el PLAN —descartes de anti-join y loops de las CTE—,
//        que no mira sintaxis. Medido: 326.024 descartes con la forma vieja
//        contra 805 con la nueva, sobre 404 productos.
//
//   node scripts/finance/guard-charts-l1.mjs [archivo|dir ...]
//   node scripts/finance/guard-charts-l1.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, basename, extname } from 'node:path'

// ── Alcance ─────────────────────────────────────────────────────────────────

const L1_SQL = [
  'supabase/migrations/20260810120000_finance_charts_l1_contracts.sql',
  // P1-D extendio el contrato: las mismas reglas (FX, denominacion, backfill,
  // formato monetario, promesas de reposicion) tienen que alcanzarlo.
  'supabase/migrations/20260810150000_finance_charts_l1_supplier_purchase_context.sql',
  // Hotfix post-rollout: saca el anti-join cuadratico que hacia expirar el RPC.
  'supabase/migrations/20260917120000_finance_inventory_capital_antijoin_perf.sql',
]

/** Módulos que forman el bloque de gráficos. */
const L1_TS_DIRS = ['src/components/finance/charts']
const L1_TS_FILES = [
  'src/services/financeChartsService.ts',
  'src/hooks/useFinanceChartsL1.ts',
  'src/lib/finance/chartsL1Presentation.ts',
  'src/pages/FinanceDashboard.tsx',
]

/**
 * R17 — migraciones M8 ya aplicadas a producción. Editarlas hace que un
 * `db reset` construya otro esquema mientras producción conserva el cuerpo
 * viejo: repo y producción divergen sin que nada falle. Forward-only.
 */
const M8_APLICADAS = {
  'supabase/migrations/20260806120000_supplier_purchase_due_date.sql':
    'b5bdcd392b4564eeed1703ea3306d9a778be0b418e716f8733d41fc09d493fe7',
  'supabase/migrations/20260806130000_finance_insights.sql':
    '6591d3a150557fa08c085f5d8c97bfa24fcb1b2e85ca72dfee38925b4825f7b6',
}

/** Tablas de dinero que el bloque de gráficos NO puede consultar directo. */
const TABLAS_FINANCIERAS = [
  'inventory', 'inventory_movements', 'inventory_valuation_history',
  'comprobantes', 'comprobante_items', 'comprobante_payments',
  'financial_movements', 'business_finance_entries',
  'supplier_purchases', 'supplier_account_movements', 'account_movements',
  'owner_withdrawals',
]

/** Librerías de gráficos. La primera es la elegida; el resto está prohibido. */
const LIB_ELEGIDA = 'recharts'
const LIBS_PROHIBIDAS = [
  'chart.js', 'react-chartjs-2', 'd3', 'apexcharts', 'react-apexcharts',
  'victory', '@nivo/core', 'highcharts', 'echarts', 'plotly.js', 'britecharts',
]

// ── Utilidades ──────────────────────────────────────────────────────────────

// Normaliza saltos de línea: un checkout Windows no es una modificación.
// Mismo criterio que guard-m8-insights.mjs, o los hashes no coincidirían.
const sha = (s) => createHash('sha256').update(s.replace(/\r\n/g, '\n'), 'utf8').digest('hex')

/**
 * Quita comentarios para no acusar a un texto explicativo.
 *
 * El `//` de un protocolo NO abre un comentario: sin esta salvedad,
 * `fetch('https://…')` quedaba truncado en `fetch('https:` y la regla de API
 * externa nunca disparaba.
 */
function sinComentarios(src, sql = false) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
  out = sql
    ? out.replace(/--[^\n]*/g, ' ')
    : out.replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  return out
}

/**
 * R12 — denominación prohibida, ignorando las menciones NEGADAS.
 *
 * "Capital en stock NO es patrimonio" documenta la regla; "Capital total: $X"
 * la viola. Distinguirlas mirando si hay una negación inmediatamente antes evita
 * tener que borrar la documentación para que el guard pase.
 */
const TERMINOS_PROHIBIDOS = /capital\s+total|patrimonio|capital\s+invertido\s+total/gi
const NEGACION = /\b(no|nunca|jam[aá]s|sin|prohib\w*|evitar|ni)\b[^.;]{0,60}$/i

function denominacionProhibida(texto) {
  const hits = []
  let m
  TERMINOS_PROHIBIDOS.lastIndex = 0
  while ((m = TERMINOS_PROHIBIDOS.exec(texto)) !== null) {
    const antes = texto.slice(Math.max(0, m.index - 80), m.index)
    if (!NEGACION.test(antes)) hits.push(m[0])
  }
  return hits
}

/**
 * R19 — frases que prometen reposición o revaluación FX.
 *
 * "Capital en stock" es `stock_quantity × cost_price`: el valor según los costos
 * REGISTRADOS. Llamarlo valor/costo de reposición, o decir que está ajustado al
 * dólar, promete algo que el servidor no puede demostrar — no existe fuente de
 * cotización server-side.
 *
 * Se busca sólo en el entorno de la métrica (mercadería / stock / inventario /
 * capital) para no acusar a un texto de compras, que sí habla de reposición
 * legítimamente ("las compras repusieron menos inventario del que salió").
 */
const PROMESAS_REPOSICION = [
  /valor\s+(actual\s+)?de\s+reposici[oó]n/gi,
  /costo\s+de\s+reposici[oó]n(\s+vigente)?/gi,
  /reposici[oó]n\s+vigente/gi,
  /ajustad[oa]s?\s+al\s+d[oó]lar/gi,
  /valuad[oa]s?\s+al\s+d[oó]lar/gi,
  /cotizaci[oó]n\s+(de\s+)?hoy/gi,
  /al\s+d[oó]lar\s+de\s+hoy/gi,
  /precio\s+de\s+reposici[oó]n/gi,
]

function promesaDeReposicion(texto) {
  const hits = []
  for (const re of PROMESAS_REPOSICION) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(texto)) !== null) hits.push(m[0].replace(/\s+/g, ' '))
  }
  return hits
}

function listarArchivos(ruta) {
  if (!existsSync(ruta)) return []
  if (statSync(ruta).isFile()) return [ruta]
  const out = []
  for (const e of readdirSync(ruta, { withFileTypes: true })) {
    const p = join(ruta, e.name)
    if (e.isDirectory()) out.push(...listarArchivos(p))
    else if (['.ts', '.tsx', '.sql', '.mjs', '.js'].includes(extname(e.name))) out.push(p)
  }
  return out
}

// ── Revisión de SQL ─────────────────────────────────────────────────────────

/**
 * Cuerpos de las vistas declaradas en un archivo: desde `CREATE [OR REPLACE]
 * VIEW` hasta el `;` que la cierra. Sirve para distinguir lo que queda
 * DEFINIDO en el esquema de lo que sólo se ejecuta una vez (postcondiciones,
 * comparaciones de equivalencia, fixtures).
 */
export function cuerposDeVista(sql) {
  const out = []
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/gi
  let m
  while ((m = re.exec(sql)) !== null) {
    const desde = m.index
    // El `;` de cierre: el primero fuera de literales de cadena.
    let i = desde
    let enCadena = false
    for (; i < sql.length; i++) {
      const ch = sql[i]
      if (ch === "'") {
        if (enCadena && sql[i + 1] === "'") { i++; continue }
        enCadena = !enCadena
      } else if (ch === ';' && !enCadena) break
    }
    out.push(sql.slice(desde, i))
    re.lastIndex = i
  }
  return out
}

/** Migración que redefine `v_finance_inventory_capital` sin el anti-join. */
const HOTFIX_CAPITAL =
  'supabase/migrations/20260917120000_finance_inventory_capital_antijoin_perf.sql'

/**
 * ¿Sigue vigente el hotfix que saca el anti-join cuadrático? Es la condición
 * que habilita la excepción histórica de R20: si el hotfix desaparece o vuelve
 * a la forma correlacionada, la excepción se cae sola y el guard acusa otra vez.
 * Se inyecta `leer` en el self-test para poder simular las dos situaciones.
 */
export function hotfixDeCapitalVigente(leer = null) {
  let src
  try {
    src = leer ? leer(HOTFIX_CAPITAL) : readFileSync(HOTFIX_CAPITAL, 'utf8')
  } catch { return false }
  if (src === null || src === undefined) return false
  const cuerpos = cuerposDeVista(sinComentarios(src, true))
  const capital = cuerpos.find(b => /v_finance_inventory_capital/i.test(b))
  if (!capital) return false
  // Redefine la vista Y no reintroduce la forma correlacionada.
  return !/NOT\s+EXISTS\s*\([\s\S]{0,400}?=\s*'[A-Za-z0-9_-]+-'\s*\|\|/i.test(capital)
}

export function revisarSql(ruta, src) {
  const f = []
  const c = sinComentarios(src, true)
  const nombre = basename(ruta)

  // R14 — materialized view
  if (/CREATE\s+MATERIALIZED\s+VIEW/i.test(c)) {
    f.push(`R14 ${nombre}: crea una MATERIALIZED VIEW (fuera de alcance de L1)`)
  }

  // R13 — Realtime
  if (/supabase_realtime|ALTER\s+PUBLICATION/i.test(c)) {
    f.push(`R13 ${nombre}: agrega Realtime`)
  }

  // R15 — backfill / DML histórico. Las tablas TEMP de baseline no cuentan.
  const dml = /\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+(?:public\.)?([a-z_]+)/gi
  let m
  while ((m = dml.exec(c)) !== null) {
    const tabla = m[2].toLowerCase()
    if (tabla.startsWith('_') || tabla.startsWith('pg_temp')) continue
    f.push(`R15 ${nombre}: hace DML sobre '${tabla}' (backfill prohibido en L1)`)
  }

  // R11 — vencimiento inventado a partir de la fecha de compra
  if (/purchase_date\s*\+\s*\d+/i.test(c) || /purchase_date\s*\+\s*interval/i.test(c)) {
    f.push(`R11 ${nombre}: deriva un vencimiento de purchase_date (due_date no se inventa)`)
  }
  // R11 — aging bucketeado por due_date
  if (/CASE[\s\S]{0,200}due_date[\s\S]{0,200}('0-7'|'8-30'|'31-60'|'60\+')/i.test(c)) {
    f.push(`R11 ${nombre}: bucketea el aging por due_date (aging es antigüedad, no vencimiento)`)
  }

  // R18 — formato monetario en SQL
  if (/to_char\s*\([^)]*(FM)?9{1,3}[G,]/i.test(c)) {
    f.push(`R18 ${nombre}: formatea importes con to_char (el formato es-AR vive en el frontend)`)
  }

  // R19 — promesa de reposición / revaluación FX en comentarios de contrato
  for (const t of promesaDeReposicion(c)) {
    const idx = c.toLowerCase().indexOf(t.toLowerCase())
    const antes = c.slice(Math.max(0, idx - 80), idx)
    if (NEGACION.test(antes)) continue
    f.push(`R19 ${nombre}: promete "${t}"; el contrato valua a costo REGISTRADO, no de reposición`)
  }

  // R20 — tripwire de la FORMA HISTORICA del anti-join correlacionado.
  //
  // Un `NOT EXISTS (... WHERE col = 'PREFIJO-' || externa.id)` no se puede
  // hashear ni indexar: el término de comparación depende de la fila externa,
  // así que el planner reescanea la tabla interna una vez por fila externa.
  // Es CUADRÁTICO, y en `inventory` cada fila interna reevalúa además la
  // policy RLS (una función plpgsql). Con 611 productos medimos 32.786 ms y
  // `get_finance_charts_l1` expiraba con 57014.
  //
  // ESTO DETECTA UNA ESCRITURA, NO LA CLASE. Se probó: operandos invertidos,
  // `concat()`, `format()` y `NOT IN` pasan. No se intenta cubrirlas con más
  // regex —sería un parser de SQL a medias, con la falsa confianza que eso
  // trae—. La protección real contra reescrituras equivalentes es V07 del
  // test SQL, que asevera sobre el PLAN de la consulta real.
  // Se mira SÓLO el cuerpo de las vistas. Una postcondición que recalcula el
  // universo con la forma vieja para comparar valores es legítima y no debe
  // acusarse: el guard vigila lo que queda DEFINIDO, no lo que se verifica.
  //
  // `20260810120000` es donde NACIÓ el anti-join y ya está aplicada a
  // producción: las migraciones son forward-only, editarla haría divergir un
  // `db reset` de lo que producción tiene. Queda exceptuada, pero la excepción
  // se AUTOINVALIDA: sólo vale mientras el hotfix que redefine la vista siga
  // presente y con la forma materializada. Si alguien borra el hotfix, este
  // archivo vuelve a acusar.
  const historico = nombre === '20260810120000_finance_charts_l1_contracts.sql'
  if (!(historico && hotfixDeCapitalVigente())) {
  for (const cuerpo of cuerposDeVista(c)) {
    for (const m2 of cuerpo.matchAll(
      /NOT\s+EXISTS\s*\([\s\S]{0,400}?=\s*'[A-Za-z0-9_-]+-'\s*\|\|[\s\S]{0,80}?\)/gi,
    )) {
      f.push(
        `R20 ${nombre}: anti-join correlacionado contra una cadena construida ` +
          `(${m2[0].replace(/\s+/g, ' ').slice(0, 90)}…) — es cuadrático; ` +
          `materializá el conjunto de exclusión una vez y anti-joineá por igualdad`,
      )
    }
  }
  }

  // R5 — FX aplicado en SQL sobre historia
  if (/\*\s*(?:[a-z_]+\.)?(exchange_rate|exchange_rate_used|dolar|usd_rate)\b/i.test(c)) {
    f.push(`R5 ${nombre}: multiplica por un tipo de cambio (no hay fuente FX canónica)`)
  }

  // R9 — retiros sumados a gastos operativos
  if (/operating_expenses[\s\S]{0,80}\+[\s\S]{0,40}(owner_withdrawal|withdrawals)/i.test(c) ||
      /(owner_withdrawal|withdrawals)[\s\S]{0,80}\+[\s\S]{0,40}operating_expenses/i.test(c)) {
    f.push(`R9 ${nombre}: suma retiros del dueño a gastos operativos`)
  }

  // R12 — denominación prohibida (menciones negadas no cuentan)
  for (const t of denominacionProhibida(c)) {
    f.push(`R12 ${nombre}: llama "${t}" a lo que es sólo inventario`)
  }

  return f
}

// ── Revisión de TypeScript / TSX ────────────────────────────────────────────

export function revisarTs(ruta, src) {
  const f = []
  const c = sinComentarios(src, false)
  const nombre = basename(ruta)
  // FinanceDashboard es el anfitrión: tiene su propio resumen legacy y consultas
  // preexistentes que NO son parte del contrato de gráficos.
  const esAnfitrion = ruta.replace(/\\/g, '/').endsWith('src/pages/FinanceDashboard.tsx')

  // R1 — consulta directa a una tabla de dinero desde el bloque de gráficos
  if (!esAnfitrion) {
    const from = /\.from\(\s*['"`]([a-z_]+)['"`]\s*\)/gi
    let m
    while ((m = from.exec(c)) !== null) {
      if (TABLAS_FINANCIERAS.includes(m[1].toLowerCase())) {
        f.push(`R1 ${nombre}: consulta directo la tabla financiera '${m[1]}' (usar el contrato server-side)`)
      }
    }
  }

  // R2 — reconstrucción del P&L
  if (/net_sales\s*-\s*[\w.]*cogs/i.test(c) ||
      /gross_profit\s*-\s*[\w.]*operating_expenses/i.test(c)) {
    f.push(`R2 ${nombre}: re-deriva el P&L en React (gross_profit/operating_result vienen del server)`)
  }

  // R3 — reconstrucción de COGS
  if (/costo_unitario\s*\*/i.test(c) || /cantidad\s*\*\s*[\w.]*costo/i.test(c)) {
    f.push(`R3 ${nombre}: reconstruye COGS en React`)
  }

  // R4 — reconstrucción del stock financiero
  if (/stock_quantity\s*\*/i.test(c) || /\*\s*[\w.]*cost_price\b/i.test(c) ||
      /cost_price\s*\*/i.test(c)) {
    f.push(`R4 ${nombre}: valoriza stock en React (stock x costo es server-side)`)
  }

  // R5 — FX en el cliente
  if (/\*\s*[\w.]*(exchange_rate|dolarRate|usdRate|cotizacion)\b/i.test(c)) {
    f.push(`R5 ${nombre}: aplica tipo de cambio a importes (prohibido: inventa historia)`)
  }

  // R6 — reposición desde movimientos crudos
  if (/movement_type\s*===|movement_type\s*==|movementType\s*===/i.test(c)) {
    f.push(`R6 ${nombre}: clasifica movimientos de inventario en React (la clasificación es server-side)`)
  }
  if (/purchases_cost\s*\/\s*[\w.]*consumption_cost/i.test(c)) {
    f.push(`R6 ${nombre}: calcula el índice de reposición en React`)
  }

  // R7 — select('*')
  if (/\.select\(\s*['"`]\*['"`]\s*\)/.test(c)) {
    f.push(`R7 ${nombre}: usa select('*')`)
  }

  // R8 — API externa para alimentar gráficos
  if (!esAnfitrion && /\b(fetch|axios)\s*\(\s*['"`]https?:\/\//i.test(c)) {
    f.push(`R8 ${nombre}: llama a una API externa para los gráficos`)
  }

  // R9 — retiros mezclados con gastos operativos
  if (/operating_expenses\s*\+\s*[\w.]*(owner_)?withdrawal/i.test(c) ||
      /[\w.]*(owner_)?withdrawals\s*\+\s*[\w.]*operating_expenses/i.test(c)) {
    f.push(`R9 ${nombre}: suma retiros del dueño a gastos operativos`)
  }

  // R10 — cuenta corriente contada como cobro
  if (/collections\s*\+\s*[\w.]*(cuenta_corriente|accountMovements|account_movements|receivables)/i.test(c) ||
      /(receivables|cuenta_corriente)[\w.]*\s*\+\s*[\w.]*collections/i.test(c)) {
    f.push(`R10 ${nombre}: cuenta la cuenta corriente como cobro`)
  }

  // R11 — aging y due_date mezclados
  if (/due_date[\s\S]{0,60}(bucket|aging)/i.test(c) || /(bucket|aging)[\s\S]{0,60}due_date/i.test(c)) {
    f.push(`R11 ${nombre}: mezcla aging con due_date`)
  }

  // R12 — denominación prohibida (menciones negadas no cuentan)
  for (const t of denominacionProhibida(c)) {
    f.push(`R12 ${nombre}: llama "${t}" a lo que es sólo inventario`)
  }

  // R19 — promesa de reposición / revaluación FX (menciones negadas no cuentan)
  for (const t of promesaDeReposicion(c)) {
    const idx = c.toLowerCase().indexOf(t.toLowerCase())
    const antes = c.slice(Math.max(0, idx - 80), idx)
    if (NEGACION.test(antes)) continue
    f.push(`R19 ${nombre}: promete "${t}"; Capital en stock es stock x costo REGISTRADO, no reposición`)
  }

  // R13 — Realtime agregado por el bloque de gráficos
  if (!esAnfitrion && /\.channel\(|postgres_changes/i.test(c)) {
    f.push(`R13 ${nombre}: agrega una suscripción Realtime`)
  }

  return f
}

// ── R16 — una sola librería de gráficos ─────────────────────────────────────

export function revisarDependencias(pkgJson) {
  const f = []
  const deps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) }
  for (const lib of LIBS_PROHIBIDAS) {
    if (deps[lib]) {
      f.push(`R16 package.json: hay una segunda librería de gráficos ('${lib}'); L1 usa sólo '${LIB_ELEGIDA}'`)
    }
  }
  return f
}

// ── R17 — migraciones M8 intactas ───────────────────────────────────────────

export function revisarM8Intacto(leer = (p) => readFileSync(p, 'utf8')) {
  const f = []
  for (const [ruta, hashEsperado] of Object.entries(M8_APLICADAS)) {
    if (!existsSync(ruta)) {
      f.push(`R17 ${ruta}: desapareció una migración M8 ya aplicada a producción`)
      continue
    }
    const actual = sha(leer(ruta))
    if (actual !== hashEsperado) {
      f.push(`R17 ${ruta}: se modificó una migración M8 ya aplicada (esperado ${hashEsperado.slice(0, 12)}…, actual ${actual.slice(0, 12)}…)`)
    }
  }
  return f
}

// ── Runner ──────────────────────────────────────────────────────────────────

function objetivosPorDefecto() {
  const out = [...L1_SQL.filter(existsSync), ...L1_TS_FILES.filter(existsSync)]
  for (const d of L1_TS_DIRS) out.push(...listarArchivos(d))
  return out
}

function correr(objetivos) {
  const fallos = []
  for (const ruta of objetivos) {
    if (!existsSync(ruta)) { fallos.push(`FALTA ${ruta}`); continue }
    const src = readFileSync(ruta, 'utf8')
    fallos.push(...(extname(ruta) === '.sql' ? revisarSql(ruta, src) : revisarTs(ruta, src)))
  }
  if (existsSync('package.json')) {
    fallos.push(...revisarDependencias(JSON.parse(readFileSync('package.json', 'utf8'))))
  }
  fallos.push(...revisarM8Intacto())
  return fallos
}

// ── Self-test ───────────────────────────────────────────────────────────────

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-l1-'))
  const escribir = (n, s) => { const p = join(dir, n); writeFileSync(p, s, 'utf8'); return p }
  let ok = 0, ko = 0
  const chk = (nombre, cond) => {
    if (cond) { ok++; console.log(`  ok  ${nombre}`) }
    else { ko++; console.error(`  FALLA ${nombre}`) }
  }

  // R1
  const consultaCruda = `supabase.from('inventory_movements').select('quantity')`
  chk('r1 detecta consulta directa a una tabla financiera',
    revisarTs('Chart.tsx', consultaCruda).some(x => /R1/.test(x)))
  chk('r1 acepta una llamada por RPC',
    !revisarTs('Chart.tsx', `supabase.rpc('get_finance_charts_l1', {})`).some(x => /R1/.test(x)))

  // R2
  chk('r2 detecta reconstruccion del P&L',
    revisarTs('x.tsx', `const gp = d.net_sales - d.cogs`).some(x => /R2/.test(x)))
  chk('r2 acepta usar el gross_profit del server',
    !revisarTs('x.tsx', `const gp = d.gross_profit`).some(x => /R2/.test(x)))
  chk('r2 no acusa la brecha facturacion-cobros',
    !revisarTs('x.tsx', `const brecha = s.net_sales - s.collections`).some(x => /R2/.test(x)))

  // R3
  chk('r3 detecta reconstruccion de COGS',
    revisarTs('x.tsx', `const c = it.cantidad * it.costo_unitario`).some(x => /R3/.test(x)))

  // R4
  chk('r4 detecta valorizacion de stock en React',
    revisarTs('x.tsx', `const cap = p.stock_quantity * p.cost_price`).some(x => /R4/.test(x)))
  chk('r4 acepta el capital que ya vino calculado',
    !revisarTs('x.tsx', `const cap = data.inventory_capital.inventory_at_cost`).some(x => /R4/.test(x)))

  // R5
  chk('r5 detecta FX en React',
    revisarTs('x.tsx', `const ars = usd * exchange_rate`).some(x => /R5/.test(x)))
  chk('r5 detecta FX en SQL',
    revisarSql('m.sql', `SELECT stock * cost_price_usd * exchange_rate_used FROM inventory;`).some(x => /R5/.test(x)))
  chk('r5 acepta exponer la tasa como metadato',
    !revisarSql('m.sql', `SELECT max(exchange_rate_used) AS usd_rate_max_applied FROM inventory;`).some(x => /R5/.test(x)))

  // R6
  chk('r6 detecta clasificacion de movimientos en React',
    revisarTs('x.tsx', `if (m.movement_type === 'purchase') total += m.qty`).some(x => /R6/.test(x)))
  chk('r6 detecta calculo del indice de reposicion en React',
    revisarTs('x.tsx', `const r = f.purchases_cost / f.consumption_cost`).some(x => /R6/.test(x)))
  chk('r6 acepta el indice que ya vino calculado',
    !revisarTs('x.tsx', `const r = f.replenishment_pct`).some(x => /R6/.test(x)))

  // R7
  chk('r7 detecta select(*)',
    revisarTs('x.tsx', `supabase.from('x').select('*')`).some(x => /R7/.test(x)))

  // R8
  chk('r8 detecta API externa',
    revisarTs('Chart.tsx', `const r = await fetch('https://api.example.com/x')`).some(x => /R8/.test(x)))

  // R9
  chk('r9 detecta retiros sumados a gastos (TS)',
    revisarTs('x.tsx', `const g = s.operating_expenses + s.owner_withdrawals`).some(x => /R9/.test(x)))
  chk('r9 detecta retiros sumados a gastos (SQL)',
    revisarSql('m.sql', `SELECT operating_expenses + owner_withdrawals AS gastos FROM v;`).some(x => /R9/.test(x)))
  chk('r9 acepta informar el retiro por separado',
    !revisarTs('x.tsx', `<OwnerWithdrawalsNote amount={s.owner_withdrawals} />`).some(x => /R9/.test(x)))

  // R10
  chk('r10 detecta la CC contada como cobro',
    revisarTs('x.tsx', `const cobrado = d.collections + d.receivables`).some(x => /R10/.test(x)))

  // R11
  chk('r11 detecta vencimiento inventado',
    revisarSql('m.sql', `SELECT purchase_date + 30 AS due FROM supplier_purchases;`).some(x => /R11/.test(x)))
  chk('r11 detecta aging bucketeado por due_date',
    revisarSql('m.sql',
      `SELECT CASE WHEN due_date < now() THEN '0-7' ELSE '8-30' END AS bucket FROM sp;`).some(x => /R11/.test(x)))
  chk('r11 acepta aging por antiguedad de compra',
    !revisarSql('m.sql',
      `SELECT CASE WHEN ar_today() - purchase_date <= 7 THEN '0-7' ELSE '8-30' END AS bucket FROM sp;`).some(x => /R11/.test(x)))

  // R12
  chk('r12 detecta "capital total"',
    revisarTs('x.tsx', `const label = 'Capital total'`).some(x => /R12/.test(x)))
  chk('r12 detecta "patrimonio"',
    revisarSql('m.sql', `COMMENT ON VIEW v IS 'patrimonio del negocio';`).some(x => /R12/.test(x)))
  chk('r12 acepta la denominacion canonica',
    !revisarTs('x.tsx', `const label = 'Capital en stock'`).some(x => /R12/.test(x)))
  chk('r12 acepta la mencion NEGADA (documentar la prohibicion no la viola)',
    !revisarSql('m.sql',
      `COMMENT ON VIEW v IS 'Capital en stock. NO es patrimonio ni capital total: es inventario.';`)
      .some(x => /R12/.test(x)))
  chk('r12 sigue detectando la mencion afirmativa en la misma frase',
    revisarSql('m.sql',
      `COMMENT ON VIEW v IS 'Muestra el patrimonio del negocio.';`).some(x => /R12/.test(x)))

  // R13
  chk('r13 detecta Realtime en SQL',
    revisarSql('m.sql', `ALTER PUBLICATION supabase_realtime ADD TABLE x;`).some(x => /R13/.test(x)))
  chk('r13 detecta Realtime en React',
    revisarTs('Chart.tsx', `supabase.channel('charts').on('postgres_changes', {}, cb)`).some(x => /R13/.test(x)))

  // R14
  chk('r14 detecta materialized view',
    revisarSql('m.sql', `CREATE MATERIALIZED VIEW public.mv_charts AS SELECT 1;`).some(x => /R14/.test(x)))

  // R15
  chk('r15 detecta backfill',
    revisarSql('m.sql', `UPDATE inventory SET cost_price = 0;`).some(x => /R15/.test(x)))
  chk('r15 acepta una tabla temporal de baseline',
    !revisarSql('m.sql', `INSERT INTO _l1_baseline SELECT count(*) FROM inventory;`).some(x => /R15/.test(x)))
  chk('r15 acepta una migracion de solo lectura',
    !revisarSql('m.sql', `CREATE OR REPLACE VIEW v AS SELECT 1;`).some(x => /R15/.test(x)))

  // R16
  chk('r16 detecta una segunda libreria de graficos',
    revisarDependencias({ dependencies: { recharts: '^2', 'chart.js': '^4' } }).some(x => /R16/.test(x)))
  chk('r16 acepta una sola libreria',
    revisarDependencias({ dependencies: { recharts: '^2' } }).length === 0)

  // R17
  chk('r17 detecta una migracion M8 modificada',
    revisarM8Intacto(() => 'contenido alterado').some(x => /R17/.test(x)))
  chk('r17 acepta las migraciones M8 intactas',
    revisarM8Intacto().length === 0)

  // R18
  chk('r18 detecta to_char monetario',
    revisarSql('m.sql', `SELECT to_char(total,'FM999G999D00') FROM v;`).some(x => /R18/.test(x)))
  chk('r18 acepta SQL que devuelve numeros',
    !revisarSql('m.sql', `SELECT round(total,2) AS total FROM v;`).some(x => /R18/.test(x)))

  // R19
  chk('r19 detecta "valor de reposicion"',
    revisarTs('x.tsx', `const d = 'Valor de reposición de la mercadería'`).some(x => /R19/.test(x)))
  chk('r19 detecta "costo de reposicion vigente"',
    revisarTs('x.tsx', `const d = 'Stock al costo de reposición vigente'`).some(x => /R19/.test(x)))
  chk('r19 detecta "ajustado al dolar"',
    revisarTs('x.tsx', `const d = 'Inventario ajustado al dólar'`).some(x => /R19/.test(x)))
  chk('r19 detecta "cotizacion de hoy"',
    revisarTs('x.tsx', `const d = 'Valuado a la cotización de hoy'`).some(x => /R19/.test(x)))
  chk('r19 detecta la promesa en un COMMENT de SQL',
    revisarSql('m.sql',
      `COMMENT ON VIEW v IS 'inventario a valor de reposicion';`).some(x => /R19/.test(x)))
  chk('r19 acepta la descripcion canonica',
    !revisarTs('x.tsx',
      `const d = 'Valor de la mercadería disponible según los costos registrados actualmente en TechRepair Pro.'`)
      .some(x => /R19/.test(x)))
  chk('r19 acepta la nota de cotizacion no alarmista',
    !revisarTs('x.tsx',
      `const n = 'Algunos costos pueden variar al actualizarse su cotización.'`).some(x => /R19/.test(x)))
  chk('r19 NO acusa al texto de reposicion de INVENTARIO (compras vs consumo)',
    !revisarTs('x.tsx',
      `const t = 'las compras repusieron menos inventario del que salió por operación'`)
      .some(x => /R19/.test(x)))
  chk('r19 acepta la mencion NEGADA',
    !revisarSql('m.sql',
      `COMMENT ON VIEW v IS 'Costo registrado. NO es valor de reposicion.';`).some(x => /R19/.test(x)))

  // R20 — el anti-join cuadratico que hizo expirar get_finance_charts_l1
  const VISTA_MALA = `CREATE OR REPLACE VIEW public.v_x AS
  SELECT i.id FROM public.inventory i
   WHERE NOT EXISTS (SELECT 1 FROM public.inventory v
                      WHERE v.business_id = i.business_id
                        AND v.supplier_code = 'VPREF-' || i.id::text);`
  const VISTA_BUENA = `CREATE OR REPLACE VIEW public.v_x AS
  WITH vpref AS (SELECT DISTINCT business_id, supplier_code FROM public.inventory
                  WHERE supplier_code LIKE 'VPREF-%')
  SELECT i.id FROM public.inventory i
    LEFT JOIN vpref vp ON vp.business_id = i.business_id
                      AND vp.supplier_code = 'VPREF-' || i.id::text
   WHERE vp.supplier_code IS NULL;`
  chk('r20 detecta el anti-join correlacionado contra una cadena construida',
    revisarSql('m.sql', VISTA_MALA).some(x => /R20/.test(x)))
  chk('r20 acepta el conjunto de exclusion materializado (LEFT JOIN ... IS NULL)',
    !revisarSql('m.sql', VISTA_BUENA).some(x => /R20/.test(x)))
  chk('r20 detecta cualquier prefijo, no solo VPREF-',
    revisarSql('m.sql', VISTA_MALA.replace(/VPREF-/g, 'OTRO-')).some(x => /R20/.test(x)))

  // ALCANCE DECLARADO: estas reformulaciones son equivalentes y R20 NO las ve.
  // Se aseveran como LIMITACION CONOCIDA, no como cobertura. Si alguna vez se
  // cubren, estos checks fallan y obligan a actualizar el contrato del guard.
  const EVASIONES = [
    ['operandos invertidos',
      `NOT EXISTS (SELECT 1 FROM public.inventory v WHERE 'VPREF-' || i.id::text = v.supplier_code)`],
    ['concat()',
      `NOT EXISTS (SELECT 1 FROM public.inventory v WHERE v.supplier_code = concat('VPREF-', i.id::text))`],
    ['format()',
      `NOT EXISTS (SELECT 1 FROM public.inventory v WHERE v.supplier_code = format('VPREF-%s', i.id))`],
    ['NOT IN',
      `i.id NOT IN (SELECT substring(v.supplier_code from 7)::uuid FROM public.inventory v
                     WHERE v.supplier_code LIKE 'VPREF-%')`],
  ]
  for (const [nombre, pred] of EVASIONES) {
    chk(`r20 LIMITACION declarada: no detecta la reformulacion por ${nombre}`,
      !revisarSql('m.sql',
        `CREATE OR REPLACE VIEW public.v_x AS SELECT i.id FROM public.inventory i WHERE ${pred};`,
      ).some(x => /R20/.test(x)))
  }
  chk('r20 NO acusa a una postcondicion que recalcula con la forma vieja',
    !revisarSql('m.sql',
      `${VISTA_BUENA}\nDO $p$ BEGIN\n  PERFORM 1 FROM public.inventory i\n` +
      `   WHERE NOT EXISTS (SELECT 1 FROM public.inventory v\n` +
      `                      WHERE v.supplier_code = 'VPREF-' || i.id::text);\nEND $p$;`)
      .some(x => /R20/.test(x)))
  chk('r20 acepta un anti-join por igualdad de columnas',
    !revisarSql('m.sql',
      `CREATE VIEW public.v_y AS SELECT i.id FROM public.inventory i
        WHERE NOT EXISTS (SELECT 1 FROM public.inventory v WHERE v.parent_id = i.id);`)
      .some(x => /R20/.test(x)))
  chk('cuerposDeVista corta en el ; y no se come el resto del archivo',
    cuerposDeVista(`CREATE VIEW a AS SELECT 1; SELECT 'VPREF-' || x;`).length === 1)
  // La excepcion historica de R20 tiene que AUTOINVALIDARSE.
  chk('r20 la excepcion historica vale mientras el hotfix este vigente',
    hotfixDeCapitalVigente() === true)
  chk('r20 la excepcion se cae si el hotfix desaparece',
    hotfixDeCapitalVigente(() => { throw new Error('no existe') }) === false)
  chk('r20 la excepcion se cae si el hotfix ya no redefine la vista',
    hotfixDeCapitalVigente(() => `CREATE VIEW public.v_otra AS SELECT 1;`) === false)
  chk('r20 la excepcion se cae si el hotfix reintroduce el anti-join',
    hotfixDeCapitalVigente(() =>
      `CREATE OR REPLACE VIEW public.v_finance_inventory_capital AS
       SELECT i.id FROM public.inventory i
        WHERE NOT EXISTS (SELECT 1 FROM public.inventory v
                           WHERE v.supplier_code = 'VPREF-' || i.id::text);`) === false)
  // La excepcion es NOMINAL: alcanza sólo al archivo historico, no a cualquier
  // migracion vieja que quiera colarse con la misma forma.
  chk('r20 la excepcion NO se extiende a otra migracion del alcance',
    revisarSql('20260810150000_finance_charts_l1_supplier_purchase_context.sql',
      `CREATE OR REPLACE VIEW public.v_z AS
       SELECT i.id FROM public.inventory i
        WHERE NOT EXISTS (SELECT 1 FROM public.inventory v
                           WHERE v.supplier_code = 'VPREF-' || i.id::text);`,
    ).some(x => /R20/.test(x)))

  // Un comentario que menciona lo prohibido NO puede hacer fallar al guard.
  chk('los comentarios no disparan falsos positivos',
    revisarTs('x.tsx', `// no usar patrimonio ni capital total aca\nconst a = 1`).length === 0)

  console.log(`\nself-test: ${ok} ok, ${ko} fallas`)
  if (escribir && dir) { /* el tmpdir se descarta solo */ }
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
  console.error('Charts L1 — guard FALLO:\n')
  for (const f of fallos) console.error(`  · ${f}`)
  console.error(`\n${fallos.length} problema(s). Ver §40 del lote Charts L1.`)
  process.exit(1)
}
console.log(`Charts L1 — guard OK (${objetivos.length} archivo(s) revisados).`)
