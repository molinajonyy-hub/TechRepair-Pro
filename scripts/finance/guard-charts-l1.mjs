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
