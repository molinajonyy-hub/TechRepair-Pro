#!/usr/bin/env node
// SEC-08A — guard de visibilidad de datos de órdenes.
//
// Impide que vuelva a existir un lector de browser capaz de bajarse los campos
// financieros de una orden (O1) o el secreto del equipo (O2), y que una
// migración posterior reabra el GRANT de tabla que este lote cerró.
//
// La parte de frontend NO es un grep: se parsea el TypeScript con el compilador
// y se resuelve la cadena `.from('orders')…select(...)`, incluidas las
// constantes de módulo y las relaciones anidadas `orders(...)` colgando de
// cualquier otra tabla. Un regex sobre el texto no distingue `select('*')`
// sobre `orders` de `select('*')` sobre `customers`, ni resuelve
// `select(ORDER_SELECT)`.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const MIGRATION = 'supabase/migrations/20260911120000_sec08a_orders_data_visibility.sql'
const SQL_TEST = 'tests/sql/sec08a_orders_data_visibility.test.sql'

/** Columnas de public.orders que el browser NO puede seleccionar. */
const DENIED = [
  'estimated_total', 'estimated_total_currency', 'labor_cost', 'total_cost',
  'amount_paid', 'paid_at', 'device_password',
]

// ─── Análisis del frontend (AST) ─────────────────────────────────────────────

/** Quita los grupos entre paréntesis para poder mirar sólo el nivel superior. */
function stripGroups(select) {
  let out = '', depth = 0
  for (const ch of select) {
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth--; continue }
    if (depth === 0) out += ch
  }
  return out
}

/** Devuelve el contenido de cada relación embebida `orders(...)`. */
function embeddedOrderSelects(select) {
  const found = []
  const re = /(?:^|[,\s{])(?:[A-Za-z_][\w]*\s*:\s*)?orders\s*(?:!\w+)?\s*\(/g
  let match
  while ((match = re.exec(select))) {
    let depth = 1, i = re.lastIndex, body = ''
    while (i < select.length && depth > 0) {
      if (select[i] === '(') depth++
      else if (select[i] === ')') { depth--; if (depth === 0) break }
      body += select[i]; i++
    }
    found.push(body)
  }
  return found
}

/** Comprueba una lista de columnas de `orders`. Devuelve los motivos de fallo. */
function checkOrderColumns(select, where) {
  const problems = []
  const top = stripGroups(select)
  if (/(^|[,\s])\*($|[,\s])/.test(top)) problems.push(`${where}: select('*') sobre orders`)
  for (const column of DENIED) {
    if (new RegExp(`(^|[,\\s(])${column}($|[,\\s)])`).test(top)) {
      problems.push(`${where}: columna prohibida '${column}' sobre orders`)
    }
  }
  return problems
}

export function analyzeSource(fileName, text) {
  const findings = []
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const consts = new Map()

  const literalOf = node => {
    if (!node) return undefined
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return literalOf(node.expression)
    if (ts.isIdentifier(node)) return consts.get(node.text)
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text
      for (const span of node.templateSpans) {
        const value = literalOf(span.expression)
        if (value === undefined) return undefined
        out += value + span.literal.text
      }
      return out
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literalOf(node.left), right = literalOf(node.right)
      return left === undefined || right === undefined ? undefined : left + right
    }
    return undefined
  }

  // 1) constantes de módulo: `const ORDER_SELECT = '...'`
  const collect = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = literalOf(node.initializer)
      if (value !== undefined) consts.set(node.name.text, value)
    }
    ts.forEachChild(node, collect)
  }
  collect(source)

  // 2) resolver la tabla de una cadena supabase-js
  const tableOf = expression => {
    let node = expression
    let table
    while (node) {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'from' && node.arguments.length) {
          const name = literalOf(node.arguments[0])
          if (name) table = name
        }
        node = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined
        continue
      }
      if (ts.isPropertyAccessExpression(node)) { node = node.expression; continue }
      break
    }
    return table
  }

  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'select') {
      const table = tableOf(node.expression.expression)
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
      const where = `${fileName}:${line}`
      const raw = node.arguments[0]
      const select = raw === undefined ? '*' : literalOf(raw)

      if (table === 'orders') {
        if (select === undefined) {
          findings.push(`${where}: select() dinámico sobre orders — no se puede auditar`)
        } else {
          findings.push(...checkOrderColumns(select, where))
        }
      }
      // Relación anidada: cerrar /orders y dejar /customers?select=orders(*)
      // abierto no cierra nada.
      if (select !== undefined && table !== 'orders') {
        for (const body of embeddedOrderSelects(select)) {
          findings.push(...checkOrderColumns(body, `${where} (relación anidada orders)`))
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

// ─── Recolección de archivos ─────────────────────────────────────────────────

const readTree = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) readTree(full, out)
    else if (/\.tsx?$/.test(entry)) out.push([full.split('\\').join('/'), readFileSync(full, 'utf8')])
  }
  return out
}

// ─── Inspección completa ─────────────────────────────────────────────────────

export function inspect({ browser, migration, later, tests }) {
  const failures = []

  for (const [name, text] of browser) failures.push(...analyzeSource(name, text))

  // Frontera de columnas
  if (!/REVOKE SELECT ON TABLE public\.orders FROM anon/.test(migration)) failures.push('anon conserva SELECT de tabla sobre orders')
  if (!/REVOKE SELECT ON TABLE public\.orders FROM authenticated/.test(migration)) failures.push('el GRANT de tabla sobre orders no se retira: el listado por columna no restringe nada')
  const grant = migration.match(/GRANT SELECT \(([\s\S]*?)\) ON TABLE public\.orders TO authenticated/)
  if (!grant) failures.push('falta el GRANT por columna sobre orders')
  else {
    const granted = grant[1].replace(/--[^\n]*/g, '').split(',').map(s => s.trim()).filter(Boolean)
    for (const column of DENIED) {
      if (granted.includes(column)) failures.push(`la columna ${column} vuelve a estar concedida`)
    }
    if (!granted.includes('id') || !granted.includes('business_id') || !granted.includes('status')) {
      failures.push('el GRANT operativo perdió columnas que la app necesita')
    }
  }

  // Rutas canónicas. Se mira el CUERPO de la función, no el archivo: un
  // comentario que mencione la capacidad no es una verificación.
  const body = migration.match(/CREATE OR REPLACE FUNCTION public\.get_order_financial_amounts[\s\S]*?\n\$\$;/)?.[0] || ''
  if (!body) failures.push('la migración no redefine la ruta canónica de importes')
  if (!/IF NOT public\.current_user_can\('orders_view_financials'\) THEN/.test(body)) failures.push('la ruta de importes no verifica orders_view_financials')
  for (const column of ['estimated_total', 'estimated_total_currency', 'labor_cost', 'total_cost', 'amount_paid']) {
    if (!new RegExp(`o\\.${column}\\b`).test(body)) failures.push(`la ruta autorizada no devuelve ${column}`)
  }
  if (!/JOIN public\.orders o/.test(body)) failures.push('la ruta autorizada no lee la orden como fuente de sus propios importes')
  if (!/reveal_order_device_access/.test(migration)) failures.push('el lote no ancla la ruta canónica del secreto del equipo')
  if (/CREATE OR REPLACE FUNCTION [^\n]*reveal_order_device_access/.test(migration)) failures.push('SEC-08A no debe redefinir la ruta canónica del secreto: se reutiliza')

  // Compatibilidad de escritura de Mobile2A
  if (!/has_column_privilege\('authenticated', 'public\.orders', 'device_password', 'UPDATE'\)/.test(migration)) failures.push('no se verifica que el dual-write legacy de Mobile2A siga vivo')

  // Postcondiciones
  for (const marker of ['todavía puede leer public.orders', 'perdió la columna operativa', 'conserva SELECT sobre public.orders']) {
    if (!migration.includes(marker)) failures.push(`falta la postcondición: ${marker}`)
  }

  // Ninguna migración posterior reabre la tabla
  if (/GRANT\s+(?:SELECT|ALL)[^;(]*\bON\b[^;(]*\borders\b[^;(]*\bTO\b[^;]*(?:authenticated|anon|PUBLIC)/i.test(later)) {
    failures.push('una migración posterior reabre el SELECT de tabla sobre orders')
  }

  // Evidencia del test SQL
  for (const marker of [
    'baseline financial leak control', 'baseline device-secret leak control',
    'financial unauthorized', 'financial authorized', 'secret unauthorized',
    'secret authorized', 'override', 'foreign tenant', 'anon',
  ]) {
    if (!tests.toLowerCase().includes(marker.toLowerCase())) failures.push(`falta evidencia SQL: ${marker}`)
  }
  return failures
}

const load = () => {
  const migrations = readdirSync('supabase/migrations').filter(n => n.endsWith('.sql')).sort()
  const base = MIGRATION.split('/').at(-1)
  return {
    browser: readTree('src'),
    migration: readFileSync(MIGRATION, 'utf8'),
    later: migrations.filter(n => n > base).map(n => readFileSync(`supabase/migrations/${n}`, 'utf8')).join('\n'),
    tests: readFileSync(SQL_TEST, 'utf8'),
  }
}

if (process.argv.includes('--self-test')) {
  const source = load()
  const withFile = (name, code) => ({ ...source, browser: [...source.browser, [name, code]] })
  const mutations = [
    [withFile('mut1.ts', "await supabase.from('orders').select('*')"), "select('*') sobre orders"],
    [withFile('mut2.ts', "await supabase.from('orders').select('id, total_cost')"), "columna prohibida 'total_cost'"],
    [withFile('mut3.ts', "await supabase.from('orders').select('id, device_password')"), "columna prohibida 'device_password'"],
    [withFile('mut4.ts', "await supabase.from('customers').select('*, orders(*)')"), "select('*') sobre orders"],
    [withFile('mut5.ts', "await supabase.from('customers').select('id, orders:orders(id, estimated_total)')"), "columna prohibida 'estimated_total'"],
    [withFile('mut6.ts', "const S = 'id, paid_at'\nawait supabase.from('orders').select(S)"), "columna prohibida 'paid_at'"],
    // `.select()` sin argumentos ES `*`: RETURNING de un UPDATE incluido.
    [withFile('mut7.ts', "await supabase.from('orders').update({ status: 'x' }).eq('id', id).select()"), "select('*') sobre orders"],
    [withFile('mut8.ts', "await supabase.from('orders').select(buildSelect())"), 'select() dinámico sobre orders'],
    [withFile('mut9.ts', "const C = 'id, ' + 'amount_paid'\nawait supabase.from('orders').select(`${C}, status`)"), "columna prohibida 'amount_paid'"],
    [{ ...source, migration: source.migration.replace('REVOKE SELECT ON TABLE public.orders FROM authenticated', '-- revoke retirado') }, 'el GRANT de tabla sobre orders no se retira'],
    [{ ...source, migration: source.migration.replace('REVOKE SELECT ON TABLE public.orders FROM anon', '-- revoke anon retirado') }, 'anon conserva SELECT'],
    [{ ...source, migration: source.migration.replace('  comprobante_id\n)', '  comprobante_id,\n  total_cost\n)') }, 'la columna total_cost vuelve a estar concedida'],
    // Un comentario que nombre la capacidad NO alcanza: se mira el cuerpo.
    [{ ...source, migration: source.migration.replace("IF NOT public.current_user_can('orders_view_financials') THEN", 'IF NOT public.user_can_view_order_amounts(p_business_id, v_actor) THEN') }, 'no verifica orders_view_financials'],
    [{ ...source, migration: source.migration.replace('o.total_cost, o.amount_paid', 'o.amount_paid') }, 'no devuelve total_cost'],
    [{ ...source, migration: source.migration.replace('JOIN public.orders o', 'LEFT JOIN public.order_items o') }, 'no lee la orden como fuente'],
    [{ ...source, migration: source.migration.replace("has_column_privilege('authenticated', 'public.orders', 'device_password', 'UPDATE')", 'true') }, 'dual-write legacy de Mobile2A'],
    [{ ...source, later: source.later + '\nGRANT SELECT ON TABLE public.orders TO authenticated;' }, 'reabre el SELECT de tabla'],
    [{ ...source, tests: source.tests.replace(/baseline device-secret leak control/gi, 'evidencia retirada') }, 'falta evidencia SQL'],
  ]
  for (const [mutated, label] of mutations) {
    if (!inspect(mutated).some(f => f.includes(label))) throw new Error(`self-test no detectó: ${label}`)
  }
  // Controles negativos: lo seguro no debe fallar.
  const safe = [
    ['safe1.ts', "await supabase.from('orders').select('id, status, created_at')"],
    ['safe2.ts', "await supabase.from('customers').select('*')"],
    ['safe3.ts', "await supabase.from('customers').select('id, orders(id, status)')"],
    ['safe4.ts', "await supabase.from('comprobantes').select('id, total_cost')"],
    ['safe5.ts', "await supabase.from('orders').select('id', { count: 'exact', head: true })"],
  ]
  for (const [name, code] of safe) {
    const found = analyzeSource(name, code)
    if (found.length) throw new Error(`self-test: falso positivo en ${name}: ${found.join('; ')}`)
  }
  console.log(`SEC-08A guard self-test OK: ${mutations.length} mutaciones detectadas, ${safe.length} controles negativos limpios`)
  process.exit(0)
}

const failures = inspect(load())
if (failures.length) {
  console.error(`SEC-08A orders visibility guard FAIL:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('SEC-08A orders visibility guard OK: ningún lector de browser pide columnas O1/O2 de orders (directo ni anidado); la frontera de columnas y las rutas canónicas siguen en pie')
