#!/usr/bin/env node
// SEC-08A Fase B — guard de los pivots de verdad financiera de la orden.
//
// Cubre SÓLO las clases de bypass que esta fase cerró y que pueden volver a
// abrirse por descuido:
//
//   1. Un lector de browser que pida los importes de línea crudos
//      (`order_items.precio_unitario/costo_unitario`,
//       `order_parts.internal_cost/sale_price/margin_*`), directo o anidado.
//      Sumarlos reconstruye `estimated_total` y `total_cost` EXACTOS.
//   2. Que la migración deje de retirar el GRANT de tabla (sin eso, el GRANT
//      por columna no restringe nada) o vuelva a conceder una columna cerrada.
//   3. Que `get_order_financial_amounts` vuelva a una autoridad CIEGA al tenant.
//   4. Que la lectura de comprobantes vinculados a una orden vuelva a gatearse
//      sólo por tenant.
//
// El frontend se analiza con el compilador de TypeScript, no con grep: hay que
// resolver constantes de módulo y relaciones anidadas. Un regex no distingue
// `select('*')` sobre `order_items` de `select('*')` sobre `status_history`.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const MIGRATION = 'supabase/migrations/20260912120000_sec08a_phase_b_financial_pivots.sql'

/** Columnas de importe que el browser NO puede seleccionar, por tabla. */
const DENIED = {
  order_items: ['precio_unitario', 'costo_unitario'],
  order_parts: ['internal_cost', 'sale_price', 'margin_amount', 'margin_percentage'],
}
const TABLES = Object.keys(DENIED)

/** Quita los grupos entre paréntesis para mirar sólo el nivel superior. */
function stripGroups(select) {
  let out = '', depth = 0
  for (const ch of select) {
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth--; continue }
    if (depth === 0) out += ch
  }
  return out
}

/** Cuerpo de cada relación embebida `<tabla>(...)`, a cualquier profundidad. */
function embeddedSelects(select, table) {
  const found = []
  const re = new RegExp(`(?:^|[,\\s{(])(?:[A-Za-z_]\\w*\\s*:\\s*)?${table}\\s*(?:!\\w+)?\\s*\\(`, 'g')
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

function checkColumns(select, table, where) {
  const problems = []
  const top = stripGroups(select)
  if (/(^|[,\s])\*($|[,\s])/.test(top)) problems.push(`${where}: select('*') sobre ${table}`)
  for (const column of DENIED[table]) {
    if (new RegExp(`(^|[,\\s(])${column}($|[,\\s)])`).test(top)) {
      problems.push(`${where}: columna de importe prohibida '${column}' sobre ${table}`)
    }
  }
  return problems
}

/**
 * Constantes compartidas que viven en `src/lib/orderLineAmounts.ts` y que los
 * lectores importan. El analizador resuelve constantes de MÓDULO; sin esto,
 * `select(ORDER_ITEM_OPERATIONAL_COLUMNS)` sería "dinámico" y el guard no podría
 * auditar justo los archivos que este lote migró.
 *
 * Se leen del archivo real, no se copian: si alguien mete una columna de importe
 * en la lista canónica, el guard la ve y falla.
 */
const SHARED_SELECTS = 'src/lib/orderLineAmounts.ts'
function sharedConstants() {
  const found = new Map()
  let text
  try { text = readFileSync(SHARED_SELECTS, 'utf8') } catch { return found }
  const re = /export const (ORDER_(?:ITEM|PART)_OPERATIONAL_COLUMNS)\s*=\s*(?:'([^']*)'|"([^"]*)")/g
  let m
  while ((m = re.exec(text))) found.set(m[1], m[2] ?? m[3])
  return found
}

export function analyzeSource(fileName, text, shared = sharedConstants()) {
  const findings = []
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const consts = new Map(shared)

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

  const collect = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = literalOf(node.initializer)
      if (value !== undefined) consts.set(node.name.text, value)
    }
    ts.forEachChild(node, collect)
  }
  collect(source)

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
      // `.select()` sin argumentos ES `*` — el RETURNING de un insert incluido.
      const select = raw === undefined ? '*' : literalOf(raw)

      if (TABLES.includes(table)) {
        if (select === undefined) findings.push(`${where}: select() dinámico sobre ${table} — no se puede auditar`)
        else findings.push(...checkColumns(select, table, where))
      }
      // Relación anidada: cerrar /order_items y dejar
      // /orders?select=order_items(precio_unitario) abierto no cierra nada.
      if (select !== undefined) {
        for (const t of TABLES) {
          if (t === table) continue
          for (const body of embeddedSelects(select, t)) {
            findings.push(...checkColumns(body, t, `${where} (relación anidada ${t})`))
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

const readTree = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) readTree(full, out)
    else if (/\.tsx?$/.test(entry)) out.push([full.split('\\').join('/'), readFileSync(full, 'utf8')])
  }
  return out
}

export function inspect({ browser, migration, later }) {
  const failures = []

  const shared = sharedConstants()
  for (const [name, text] of browser) failures.push(...analyzeSource(name, text, shared))

  // ── Frontera de columnas de línea ────────────────────────────────────────
  for (const table of TABLES) {
    if (!new RegExp(`REVOKE SELECT ON TABLE public\\.${table} FROM anon`).test(migration)) {
      failures.push(`anon conserva SELECT de tabla sobre ${table}`)
    }
    if (!new RegExp(`REVOKE SELECT ON TABLE public\\.${table} FROM authenticated`).test(migration)) {
      failures.push(`el GRANT de tabla sobre ${table} no se retira: el listado por columna no restringe nada`)
    }
    const grant = migration.match(new RegExp(`GRANT SELECT \\(([\\s\\S]*?)\\) ON TABLE public\\.${table} TO authenticated`))
    if (!grant) { failures.push(`falta el GRANT por columna sobre ${table}`); continue }
    const granted = grant[1].replace(/--[^\n]*/g, '').split(',').map(s => s.trim()).filter(Boolean)
    for (const column of DENIED[table]) {
      if (granted.includes(column)) failures.push(`la columna de importe ${table}.${column} vuelve a estar concedida`)
    }
    // Lo operativo tiene que sobrevivir: el técnico necesita trabajar.
    for (const column of ['id', 'order_id', 'business_id']) {
      if (!granted.includes(column)) failures.push(`el GRANT operativo de ${table} perdió ${column}`)
    }
  }
  if (!/GRANT SELECT \([\s\S]*?\bcantidad\b[\s\S]*?\) ON TABLE public\.order_items TO authenticated/.test(migration)) {
    failures.push('order_items pierde `cantidad`: es dato operativo y sin precios no reconstruye ningún importe')
  }

  // ── Autoridad ligada al tenant ───────────────────────────────────────────
  const capBody = migration.match(/CREATE OR REPLACE FUNCTION public\.current_user_can_in_business[\s\S]*?\n\$\$;/)?.[0] || ''
  if (!capBody) failures.push('la migración no define la capacidad tenant-aware')
  if (!/WHERE p\.business_id = p_business_id/.test(capBody)) {
    failures.push('current_user_can_in_business no filtra el perfil por p_business_id: seguiría siendo ciega al tenant')
  }
  if (!/private\.capability_resolve/.test(capBody)) {
    failures.push('current_user_can_in_business no usa el núcleo compartido: las dos autoridades pueden divergir')
  }

  const amountsBody = migration.match(/CREATE OR REPLACE FUNCTION public\.get_order_financial_amounts[\s\S]*?\n\$\$;/)?.[0] || ''
  if (!amountsBody) failures.push('la migración no redefine la ruta canónica de importes')
  if (!/current_user_can_in_business\(p_business_id, 'orders_view_financials'\)/.test(amountsBody)) {
    failures.push('la ruta de importes no resuelve la capacidad en p_business_id (autoridad ciega al tenant)')
  }
  if (/IF NOT public\.current_user_can\('orders_view_financials'\) THEN/.test(amountsBody)) {
    failures.push('la ruta de importes volvió a la capacidad ciega al tenant')
  }

  const lineBody = migration.match(/CREATE OR REPLACE FUNCTION public\.get_order_line_amounts[\s\S]*?\n\$\$;/)?.[0] || ''
  if (!lineBody) failures.push('falta la ruta canónica de importes de línea')
  if (!/current_user_can_in_business\(p_business_id, 'orders_view_financials'\)/.test(lineBody)) {
    failures.push('la ruta de importes de línea no exige la capacidad tenant-aware')
  }

  // ── Pivot por comprobantes ───────────────────────────────────────────────
  const compPolicy = migration.match(/CREATE POLICY comprobantes_select[\s\S]*?;/)?.[0] || ''
  if (!compPolicy) failures.push('la migración no reescribe comprobantes_select')
  if (!/order_id IS NULL/.test(compPolicy) || !/current_user_can_in_business/.test(compPolicy)) {
    failures.push('comprobantes_select no exige la capacidad para los comprobantes vinculados a una orden')
  }
  const itemsPolicy = migration.match(/CREATE POLICY comprobante_items_select[\s\S]*?;/)?.[0] || ''
  if (!itemsPolicy) failures.push('la migración no reescribe comprobante_items_select')
  if (!/current_user_can_in_business/.test(itemsPolicy)) {
    failures.push('comprobante_items_select no exige la capacidad: es el mismo pivot a nivel línea')
  }
  if (!/comprobante_is_order_linked[\s\S]*?SECURITY DEFINER/.test(migration)) {
    failures.push('el helper de comprobante vinculado no es SECURITY DEFINER: dentro de una policy quedaría filtrado por la RLS de comprobantes y mentiría')
  }
  // La vista de estado no puede fabricar 'sin_facturar' por falta de permiso.
  const viewBody = migration.match(/CREATE OR REPLACE VIEW public\.v_order_payment_state[\s\S]*?;/)?.[0] || ''
  if (!/current_user_can_in_business/.test(viewBody)) {
    failures.push("v_order_payment_state no exige la capacidad: devolvería 'sin_facturar' fabricado para una orden facturada")
  }

  // ── Vista de COGS por orden ──────────────────────────────────────────────
  if (!/REVOKE SELECT ON public\.v_finance_order_cogs_gaps FROM authenticated/.test(migration)) {
    failures.push('v_finance_order_cogs_gaps sigue alcanzable por el browser: expone costo por order_id')
  }

  // ── Ninguna migración posterior reabre nada ──────────────────────────────
  for (const table of TABLES) {
    if (new RegExp(`GRANT\\s+(?:SELECT|ALL)[^;(]*\\bON\\b[^;(]*\\b${table}\\b[^;(]*\\bTO\\b[^;]*(?:authenticated|anon|PUBLIC)`, 'i').test(later)) {
      failures.push(`una migración posterior reabre el SELECT de tabla sobre ${table}`)
    }
    if (new RegExp(`GRANT SELECT \\([^)]*\\b(?:${DENIED[table].join('|')})\\b[^)]*\\) ON (?:TABLE )?public\\.${table}`, 'i').test(later)) {
      failures.push(`una migración posterior vuelve a conceder una columna de importe de ${table}`)
    }
  }
  if (/CREATE POLICY comprobantes_select[\s\S]*?USING \(\s*business_id = public\.current_user_business_id\(\)\s*\)/.test(later)) {
    failures.push('una migración posterior devuelve comprobantes_select a gatear sólo por tenant')
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
  }
}

if (process.argv.includes('--self-test')) {
  const source = load()
  const withFile = (name, code) => ({ ...source, browser: [...source.browser, [name, code]] })
  const mutations = [
    [withFile('m1.ts', "await supabase.from('order_items').select('*')"), "select('*') sobre order_items"],
    [withFile('m2.ts', "await supabase.from('order_items').select('id, precio_unitario')"), "prohibida 'precio_unitario'"],
    [withFile('m3.ts', "await supabase.from('order_items').select('id, costo_unitario')"), "prohibida 'costo_unitario'"],
    [withFile('m4.ts', "await supabase.from('order_parts').select('*')"), "select('*') sobre order_parts"],
    [withFile('m5.ts', "await supabase.from('order_parts').select('id, internal_cost')"), "prohibida 'internal_cost'"],
    [withFile('m6.ts', "await supabase.from('order_parts').select('id, sale_price')"), "prohibida 'sale_price'"],
    [withFile('m7.ts', "await supabase.from('order_parts').select('id, margin_amount')"), "prohibida 'margin_amount'"],
    [withFile('m8.ts', "await supabase.from('orders').select('id, order_items(precio_unitario, cantidad)')"), 'relación anidada order_items'],
    [withFile('m9.ts', "await supabase.from('orders').select('id, order_parts(name, sale_price)')"), 'relación anidada order_parts'],
    [withFile('m10.ts', "await supabase.from('customers').select('id, orders(order_items(costo_unitario))')"), 'relación anidada order_items'],
    [withFile('m11.ts', "const S = 'id, ' + 'precio_unitario'\nawait supabase.from('order_items').select(S)"), "prohibida 'precio_unitario'"],
    // `.select()` pelado tras un insert ES `*`.
    [withFile('m12.ts', "await supabase.from('order_parts').insert(row).select().single()"), "select('*') sobre order_parts"],
    [withFile('m13.ts', "await supabase.from('order_items').select(buildSelect())"), 'select() dinámico sobre order_items'],
    [{ ...source, migration: source.migration.replace('REVOKE SELECT ON TABLE public.order_items FROM authenticated', '-- retirado') }, 'el GRANT de tabla sobre order_items no se retira'],
    [{ ...source, migration: source.migration.replace('REVOKE SELECT ON TABLE public.order_parts FROM anon', '-- retirado') }, 'anon conserva SELECT de tabla sobre order_parts'],
    [{ ...source, migration: source.migration.replace('  created_at, updated_at\n) ON TABLE public.order_items', '  created_at, updated_at, precio_unitario\n) ON TABLE public.order_items') }, 'order_items.precio_unitario vuelve a estar concedida'],
    [{ ...source, migration: source.migration.replace('WHERE p.business_id = p_business_id', 'WHERE true') }, 'no filtra el perfil por p_business_id'],
    [{ ...source, migration: source.migration.replace(/current_user_can_in_business\(p_business_id, 'orders_view_financials'\)/, "current_user_can('orders_view_financials')") }, 'autoridad ciega al tenant'],
    [{ ...source, migration: source.migration.replace(/order_id IS NULL\n      OR public\.current_user_can_in_business\(business_id, 'orders_view_financials'\)/, 'true') }, 'comprobantes_select no exige la capacidad'],
    [{ ...source, migration: source.migration.replace('REVOKE SELECT ON public.v_finance_order_cogs_gaps FROM authenticated', '-- retirado') }, 'v_finance_order_cogs_gaps sigue alcanzable'],
    [{ ...source, later: source.later + '\nGRANT SELECT ON TABLE public.order_items TO authenticated;' }, 'reabre el SELECT de tabla sobre order_items'],
    [{ ...source, later: source.later + '\nGRANT SELECT (id, sale_price) ON public.order_parts TO authenticated;' }, 'vuelve a conceder una columna de importe de order_parts'],
  ]
  for (const [mutated, label] of mutations) {
    if (!inspect(mutated).some(f => f.includes(label))) throw new Error(`self-test no detectó: ${label}`)
  }
  // Controles negativos: lo legítimo NO debe fallar.
  const safe = [
    ['s1.ts', "await supabase.from('order_items').select('id, tipo, descripcion, cantidad')"],
    ['s2.ts', "await supabase.from('order_parts').select('id, name, quantity, status')"],
    ['s3.ts', "await supabase.from('orders').select('id, order_items(tipo, cantidad)')"],
    ['s4.ts', "await supabase.from('comprobante_items').select('precio_unitario, costo_unitario')"],
    ['s5.ts', "await supabase.from('inventory').select('*')"],
    ['s6.ts', "await supabase.from('order_items').select('id', { count: 'exact', head: true })"],
  ]
  for (const [name, code] of safe) {
    const found = analyzeSource(name, code)
    if (found.length) throw new Error(`self-test: falso positivo en ${name}: ${found.join('; ')}`)
  }
  console.log(`SEC-08A Fase B guard self-test OK: ${mutations.length} mutaciones detectadas, ${safe.length} controles negativos limpios`)
  process.exit(0)
}

const failures = inspect(load())
if (failures.length) {
  console.error(`SEC-08A Fase B pivots guard FAIL:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('SEC-08A Fase B pivots guard OK: ningún lector de browser pide importes de línea (directo ni anidado); autoridad tenant-bound, pivot de comprobantes cerrado y vista de COGS fuera del browser')
