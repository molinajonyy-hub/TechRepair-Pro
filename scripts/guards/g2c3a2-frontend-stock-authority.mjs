#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// G2-C.3A2 · Guard: el navegador NO es autoridad del stock.
//
// Complementa scripts/guards/g2c3-stock-authority.mjs (contrato DB de la RPC
// A1). Este guard mira src/: ningún flujo frontend vivo escribe el saldo.
//
//   · Toda mutación de stock NO documental pasa por la RPC canónica
//     public.apply_inventory_stock_adjustments_atomic, y sólo a través del
//     adapter único src/services/inventoryStockAdjustmentService.ts.
//   · Los documentos (venta, anulación, compra, reparación, repuesto de orden)
//     mueven stock con sus writers server-side W1-W7: el navegador no escribe
//     inventory_movements.
//
// Invariantes:
//   1. Ningún INSERT / UPDATE / UPSERT de `inventory` desde src/ lleva
//      `stock` / `stock_quantity`. El payload se resuelve: literal, spreads,
//      variables locales, parámetros (por sus call-sites locales) o una
//      aserción runtime `assertNoStockFields(<payload>)`. Un payload que no se
//      puede verificar FALLA (fail-closed).
//   2. Cero INSERT / UPDATE / UPSERT / DELETE de `inventory_movements`.
//   3. Sin writers legacy: registerMovement / revertMovement / los mutadores
//      de inventoryService / updateStock.
//   4. La RPC A1 sólo se invoca desde el adapter; el adapter no escribe tablas.
//   5. Claves de idempotencia estables por intención (initial-stock:<id>,
//      import por attemptId).
//   6. Excel: el export incluye «Stock esperado»; el import manda el stock por
//      applyStockImport con expected = celda del archivo, nunca el stock leído.
//   7. Duplicar copia la DEFINICIÓN (withoutStockFields), nunca la existencia.
//   8. Quick-create contextual (Proveedores, Gastos, POS, Órdenes): el producto
//      nace en 0 (registerStock={false}); initialQuantity no es stock.
//   9. «Con variantes» (Variants v2) oculto; «Agregar variante» legacy vivo.
//  10. createProduct no borra el producto si el stock inicial falla.
//
// No marca: SELECT de stock, tipos, form state, render, SQL de migraciones,
// fixtures de tests, la RPC A1 vía adapter.
//
// `--self-test` muta el árbol en memoria y exige que cada mutación se detecte
// y que los controles no den falso positivo.
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src'
const ADAPTER = 'src/services/inventoryStockAdjustmentService.ts'
const IMPORT_SVC = 'src/services/inventoryStockImport.ts'
const INVENTORY_PAGE = 'src/pages/Inventory.tsx'
const PFM = 'src/components/products/ProductFormModal.tsx'
const PRODUCT_SVC = 'src/services/productService.ts'
const HOOK = 'src/hooks/useInventory.ts'
const A1_RPC = 'apply_inventory_stock_adjustments_atomic'

const LEGACY_WRITERS = [
  'registerMovement', 'revertMovement', 'increaseStockFromPurchase', 'decreaseStockFromSale',
  'decreaseStockFromOrder', 'restoreStockFromOrderRemoval', 'restoreStockFromCancelledSale',
  'applyCreditNoteStock', 'manualAdjustment', 'updateStock',
]

// ── Utilidades de texto ──────────────────────────────────────────────────────

/** Reemplaza comentarios por espacios (conserva posiciones). No toca strings. */
export function stripTsComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += n ?? ''; i += 2; continue }
      if (c === quote) quote = null
      i++; continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; out += ' '.repeat(end - i); i = end; continue }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue }
    out += c; i++
  }
  return out
}

/** Desde `open` (índice de '(' '{' '['), devuelve el índice del cierre balanceado. */
function matchClose(s, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' }
  const stack = [pairs[s[open]]]
  let quote = null
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (pairs[c]) stack.push(pairs[c])
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i }
  }
  return -1
}

/** Separa argumentos de nivel 0. */
function splitArgs(s) {
  const out = []
  let depth = 0, quote = null, start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) { if (c === '\\') { i++; continue } if (c === quote) quote = null; continue }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1 }
  }
  const last = s.slice(start).trim()
  if (last) out.push(last)
  return out
}

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const lineOf = (s, idx) => s.slice(0, idx).split('\n').length

/** ¿El texto de un literal tiene una CLAVE stock / stock_quantity? */
export function literalHasStockKey(text) {
  for (const m of text.matchAll(/['"]?\b(stock|stock_quantity)\b['"]?\s*:/g)) {
    let j = m.index - 1
    while (j >= 0 && /\s/.test(text[j])) j--
    if (j < 0 || text[j] === '{' || text[j] === ',') return true
  }
  if (/[{,]\s*(stock|stock_quantity)\s*(?=[,}])/.test(text)) return true
  return false
}

/**
 * Cadenas `.from('<tabla>')` → métodos encadenados.
 * Devuelve [{ table, method, args, index }] para cada método de la cadena.
 */
export function chainCalls(src, table) {
  const out = []
  const re = new RegExp(`\\.from\\(\\s*(['"\`])${esc(table)}\\1\\s*\\)`, 'g')
  let m
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length
    for (;;) {
      let j = i
      while (j < src.length && /\s/.test(src[j])) j++
      if (src[j] !== '.') break
      const mm = /^\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(j))
      if (!mm) break
      const open = j + mm[0].length - 1
      const close = matchClose(src, open)
      if (close < 0) break
      out.push({ table, method: mm[1], args: src.slice(open + 1, close), index: j })
      i = close + 1
    }
  }
  return out
}

// ── Resolución de payloads ───────────────────────────────────────────────────

/** Definiciones `const|let|var X = <expr>` y reasignaciones `X = <expr>`. */
function definitionsOf(src, name) {
  const out = []
  const re = new RegExp(`(?:\\b(?:const|let|var)\\s+${esc(name)}\\s*(?::[^=;]+)?|(?<![\\w$.])${esc(name)})\\s*=(?![=>])\\s*`, 'g')
  let m
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length
    const c = src[start]
    if (c === '{' || c === '[') {
      const close = matchClose(src, start)
      out.push({ kind: 'literal', text: src.slice(start, close + 1) })
    } else if (/^withoutStockFields\s*\(/.test(src.slice(start))) {
      out.push({ kind: 'stripped' })
    } else {
      out.push({ kind: 'opaque', text: src.slice(start, start + 60) })
    }
  }
  return out
}

/** Si `name` es parámetro de una función local, devuelve { fn, index }. */
function paramOwner(src, name) {
  const patterns = [
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useCallback\(\s*)?(?:async\s*)?\(([^)]*)\)\s*(?::[^=]+)?=>/g,
    /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g,
    /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::[^{]+)?\{/gm,
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const params = splitArgs(m[2]).map((p) => p.replace(/^\.\.\./, '').split(/[:=?]/)[0].trim())
      const index = params.indexOf(name)
      if (index >= 0) return { fn: m[1], index }
    }
  }
  return null
}

/**
 * ¿El payload `expr` puede llevar stock? Devuelve null (seguro) o el motivo.
 * `depth` corta la recursión.
 */
export function payloadProblem(src, expr, depth = 0) {
  const e = expr.trim()
  if (depth > 4) return `no se pudo verificar el payload (${e.slice(0, 40)})`
  if (e.startsWith('{') || e.startsWith('[')) {
    if (literalHasStockKey(e)) return 'el payload literal lleva stock/stock_quantity'
    for (const sp of e.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)(?![\w$]*\s*\()/g)) {
      const p = payloadProblem(src, sp[1], depth + 1)
      if (p) return p
    }
    return null
  }
  if (/^withoutStockFields\s*\(/.test(e)) return null
  const id = /^([A-Za-z_$][\w$]*)$/.exec(e)?.[1]
  if (!id) return `payload no verificable (${e.slice(0, 40)}): usá un literal o assertNoStockFields()`
  if (new RegExp(`assertNoStockFields\\(\\s*${esc(id)}\\b`).test(src)) return null

  const defs = definitionsOf(src, id)
  if (defs.length) {
    for (const d of defs) {
      if (d.kind === 'stripped') continue
      if (d.kind === 'opaque') return `payload '${id}' no verificable (= ${d.text.trim().split('\n')[0]}): usá assertNoStockFields()`
      const p = payloadProblem(src, d.text, depth + 1)
      if (p) return `${p} (vía '${id}')`
    }
    return null
  }

  const owner = paramOwner(src, id)
  if (!owner) return `payload '${id}' no verificable: usá assertNoStockFields()`
  if (new RegExp(`\\bexport\\b[^\\n]*\\b${esc(owner.fn)}\\b`).test(src)) {
    return `payload '${id}' es parámetro de la función exportada ${owner.fn}: usá assertNoStockFields()`
  }
  const calls = [...src.matchAll(new RegExp(`(?<![\\w$.])${esc(owner.fn)}\\s*\\(`, 'g'))]
    .filter((c) => !/(?:const|let|function)\s*$/.test(src.slice(Math.max(0, c.index - 12), c.index)))
  let checked = 0
  for (const c of calls) {
    const open = c.index + c[0].length - 1
    const close = matchClose(src, open)
    const args = splitArgs(src.slice(open + 1, close))
    // La definición también matchea `fn(`; sus "argumentos" son parámetros.
    if (args.some((a) => a.split(/[:=]/)[0].trim() === id)) continue
    const arg = args[owner.index]
    if (arg === undefined) continue
    checked++
    const p = payloadProblem(src, arg, depth + 1)
    if (p) return `${p} (vía ${owner.fn}(...) → '${id}')`
  }
  if (!checked) return `payload '${id}' (parámetro de ${owner.fn}) sin call-sites verificables: usá assertNoStockFields()`
  return null
}

// ── Reglas ───────────────────────────────────────────────────────────────────

function inspectFile(path, raw) {
  const f = []
  const src = stripTsComments(raw)

  // 1. Writes de inventory con stock.
  for (const call of chainCalls(src, 'inventory')) {
    if (!['insert', 'update', 'upsert'].includes(call.method)) continue
    const payload = splitArgs(call.args)[0] ?? ''
    const problem = payloadProblem(src, payload)
    if (problem) {
      const rmw = /\.select\(\s*['"`][^'"`]*\bstock(?:_quantity)?\b/.test(src)
      f.push(`${path}:${lineOf(src, call.index)}: ${call.method.toUpperCase()} de inventory — ${problem}${rmw ? ' [read-calculate-absolute-write: el archivo lee stock y lo escribe]' : ''}`)
    }
  }

  // 2. inventory_movements es append-only server-side.
  for (const call of chainCalls(src, 'inventory_movements')) {
    if (['insert', 'update', 'upsert', 'delete'].includes(call.method)) {
      f.push(`${path}:${lineOf(src, call.index)}: ${call.method.toUpperCase()} de inventory_movements desde el navegador (sólo writers server-side)`)
    }
  }

  // 3. Writers legacy.
  for (const w of LEGACY_WRITERS) {
    for (const m of src.matchAll(new RegExp(`(?<![\\w$])${w}\\s*\\(`, 'g'))) {
      f.push(`${path}:${lineOf(src, m.index)}: writer legacy ${w}() (el stock no documental va por la RPC canónica)`)
    }
  }

  // 4. La RPC A1 sólo desde el adapter.
  if (path !== ADAPTER && new RegExp(`['"\`]${A1_RPC}['"\`]`).test(src)) {
    f.push(`${path}: invoca ${A1_RPC} fuera del adapter único (${ADAPTER})`)
  }

  // Llamadas a los writers de metadata del hook/servicio con payload resoluble
  // (sólo donde esos writers son los de inventario: otro `addItem`, p. ej. el
  // carrito del portal, no es un write de inventory).
  const writers = [
    ...(/\buseInventory\(\)/.test(src) ? ['addItem', 'updateItem'] : []),
    ...(/\bproductService\b/.test(src) ? ['updateProduct'] : []),
  ]
  for (const fn of writers) {
    for (const m of src.matchAll(new RegExp(`(?<![\\w$])${fn}\\s*\\(`, 'g'))) {
      if (/(?:function|async)\s*$/.test(src.slice(Math.max(0, m.index - 10), m.index))) continue
      const open = m.index + m[0].length - 1
      const close = matchClose(src, open)
      const args = splitArgs(src.slice(open + 1, close))
      const payload = fn === 'addItem' ? args[0] : args[1]
      if (!payload) continue
      const e = payload.replace(/\s+as\s+any\s*$/, '').trim()
      if ((e.startsWith('{') || e.startsWith('[')) && literalHasStockKey(e)) {
        f.push(`${path}:${lineOf(src, m.index)}: ${fn}() con stock en el payload (metadata ≠ saldo)`)
      }
    }
  }
  return f
}

function contracts(files) {
  const f = []
  const get = (p) => (files.has(p) ? stripTsComments(files.get(p)) : null)

  // Adapter
  const adapter = get(ADAPTER)
  if (!adapter) f.push(`${ADAPTER}: falta el adapter único de la RPC canónica`)
  else {
    if (!new RegExp(`STOCK_ADJUSTMENT_RPC\\s*=\\s*['"]${A1_RPC}['"]`).test(adapter) || !/supabase\.rpc\(\s*STOCK_ADJUSTMENT_RPC\b/.test(adapter)) {
      f.push(`${ADAPTER}: dejó de llamar a ${A1_RPC}`)
    }
    if (/\.from\(/.test(adapter)) f.push(`${ADAPTER}: el adapter no puede tocar tablas (sólo la RPC)`)
    if (!/if\s*\(\s*!businessId\s*\)/.test(adapter) || !/if\s*\(\s*!key\s*\)/.test(adapter)) f.push(`${ADAPTER}: el adapter dejó de exigir businessId + clave de idempotencia`)
    if (!/p_idempotency_key:\s*key\b/.test(adapter)) f.push(`${ADAPTER}: la clave de idempotencia no viaja a la RPC`)
    if (!/return\s*`initial-stock:\$\{inventoryId\}`/.test(adapter)) f.push(`${ADAPTER}: la clave de stock inicial dejó de ser estable por producto (initial-stock:<id>)`)
    if (!/return\s*`g2c3a2-import-\$\{kind\}:\$\{attemptId\}:\$\{chunk\}`/.test(adapter)) f.push(`${ADAPTER}: las claves del import dejaron de ser por intento (attemptId)`)
  }

  // Import de stock
  const imp = get(IMPORT_SVC)
  if (!imp) f.push(`${IMPORT_SVC}: falta el plan de stock del import`)
  else {
    if (!/source:\s*'import'/.test(imp) || !/source:\s*'initial_stock'/.test(imp)) f.push(`${IMPORT_SVC}: el import dejó de usar las fuentes import / initial_stock`)
    if (!/expected:\s*expected\.value/.test(imp)) f.push(`${IMPORT_SVC}: el expected del import dejó de ser la celda «Stock esperado»`)
    if (!/missingExpected\.push/.test(imp)) f.push(`${IMPORT_SVC}: un archivo viejo sin «Stock esperado» ya no omite el stock`)
    if (!/importStockKey\(\s*'existing',\s*attemptId/.test(imp) || !/importStockKey\(\s*'created',\s*attemptId/.test(imp)) f.push(`${IMPORT_SVC}: las claves del import dejaron de derivarse del attemptId`)
  }

  // Inventario
  const inv = get(INVENTORY_PAGE)
  if (inv) {
    const exp = inv.slice(inv.indexOf('const handleExportInventory'), inv.indexOf('const handleImportInventory'))
    if (!/\[STOCK_EXPECTED_COLUMN\]\s*:\s*item\.stock_quantity/.test(exp)) f.push(`${INVENTORY_PAGE}: el export perdió el snapshot «Stock esperado»`)
    const impFn = inv.slice(inv.indexOf('const handleImportInventory'), inv.indexOf('const handleDownloadTemplate'))
    if (!/applyStockImport\(/.test(impFn)) f.push(`${INVENTORY_PAGE}: el import dejó de mandar el stock por la RPC (applyStockImport)`)
    if (!/expected:\s*row\[STOCK_EXPECTED_COLUMN\]/.test(impFn)) f.push(`${INVENTORY_PAGE}: el expected del import dejó de salir del archivo («Stock esperado»)`)
    const dup = inv.slice(inv.indexOf('const buildCopyPayload'), inv.indexOf('const makeUniqueCode'))
    if (!/withoutStockFields\(/.test(dup)) f.push(`${INVENTORY_PAGE}: duplicar copia la existencia física (falta withoutStockFields en buildCopyPayload)`)
    for (const m of inv.matchAll(/openCreateProductModal\(\s*'with_variants'\s*\)/g)) {
      if (!/VARIANTS_V2_ENABLED\s*&&\s*<button[^]*$/.test(inv.slice(Math.max(0, m.index - 400), m.index))) {
        f.push(`${INVENTORY_PAGE}:${lineOf(inv, m.index)}: «Producto con variantes» visible (debe quedar detrás de VARIANTS_V2_ENABLED)`)
      }
    }
    if (!/title="Agregar variante"/.test(inv) || !/onClick=\{\(\)\s*=>\s*openAddModal\(item\)\}/.test(inv)) {
      f.push(`${INVENTORY_PAGE}: se perdió el «Agregar variante» legacy (debe preservarse)`)
    }
  } else f.push(`${INVENTORY_PAGE}: no existe`)

  // ProductFormModal
  const pfm = get(PFM)
  if (pfm) {
    if (!/export const VARIANTS_V2_ENABLED\s*=\s*false\b/.test(pfm)) f.push(`${PFM}: «Con variantes» dejó de estar deshabilitado (VARIANTS_V2_ENABLED = false)`)
    if (!/\.filter\(\s*o\s*=>\s*o\.v\s*!==\s*'with_variants'\s*\|\|\s*VARIANTS_V2_ENABLED\s*\)/.test(pfm)) f.push(`${PFM}: la opción «Con variantes» es seleccionable`)
    if (!/initialTipo\s*===\s*'with_variants'\s*&&\s*!VARIANTS_V2_ENABLED/.test(pfm)) f.push(`${PFM}: initialTipo='with_variants' entra al flujo oculto sin degradar`)
    if (!/const canSetInitialStock\s*=\s*registerStock\s*&&\s*!isEditMode/.test(pfm)) f.push(`${PFM}: el stock inicial dejó de estar limitado al alta desde Inventario (registerStock)`)
    if (/\binitialQuantity\b(?!\?\s*:)/.test(pfm.replace(/initialQuantity\?\s*:\s*number/, ''))) f.push(`${PFM}: initialQuantity (cantidad del documento) vuelve a usarse como stock`)
    if (!/initialStock\s*=\s*canSetInitialStock\s*&&/.test(pfm)) f.push(`${PFM}: el alta calcula stock inicial fuera de canSetInitialStock`)
    const edit = pfm.slice(pfm.indexOf('isEditMode && editItem'), pfm.indexOf('// ── Producto con variantes'))
    if (!/applyManualTarget\(/.test(edit) || !/expected:\s*stockExpected/.test(edit)) f.push(`${PFM}: la edición de stock dejó de ir por el ajuste manual target/expected`)
    if (!/status\s*===\s*'stale'/.test(edit)) f.push(`${PFM}: la edición dejó de manejar stale (no se pisa, se informa)`)
  } else f.push(`${PFM}: no existe`)

  // Callers contextuales: el producto nace en 0.
  for (const [path, raw] of files) {
    if (path === INVENTORY_PAGE || path === PFM) continue
    const src = stripTsComments(raw)
    for (const m of src.matchAll(/<ProductFormModal\b/g)) {
      const end = src.indexOf('/>', m.index)
      const tag = src.slice(m.index, end)
      if (!/registerStock=\{false\}/.test(tag) || /registerStock(?!=\{false\})/.test(tag.replace(/registerStock=\{false\}/, ''))) {
        f.push(`${path}:${lineOf(src, m.index)}: quick-create contextual sin registerStock={false} (el producto tiene que nacer en 0)`)
      }
    }
  }

  // productService: sin DELETE del producto tras el stock inicial.
  const ps = get(PRODUCT_SVC)
  if (ps) {
    const create = ps.slice(ps.indexOf('async createProduct('), ps.indexOf('async updateProduct('))
    if (/\.delete\(\)/.test(create)) f.push(`${PRODUCT_SVC}: createProduct borra el producto (rollback destructivo ante una respuesta ambigua)`)
    if (!/applyInitialStock\(/.test(create)) f.push(`${PRODUCT_SVC}: createProduct dejó de aplicar el stock inicial por la RPC canónica`)
  }

  // Hook: fail-closed
  const hook = get(HOOK)
  if (hook) {
    if (!/assertNoStockFields\(\s*item\s*,\s*'addItem'\s*\)/.test(hook)) f.push(`${HOOK}: addItem dejó de rechazar stock en el alta`)
    if (!/assertNoStockFields\(\s*updates\s*,\s*'updateItem'\s*\)/.test(hook)) f.push(`${HOOK}: updateItem dejó de rechazar stock en la edición`)
  }
  return f
}

export function run(files) {
  const f = []
  for (const [path, raw] of files) {
    if (!path.startsWith(`${SRC}/`)) continue
    f.push(...inspectFile(path, raw))
  }
  f.push(...contracts(files))
  return f
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p.replace(/\\/g, '/'))
  }
  return acc
}

export function load() {
  return new Map(walk(SRC).map((p) => [p, readFileSync(p, 'utf8')]))
}

// ── Self-test ────────────────────────────────────────────────────────────────

function selfTest() {
  const base = load()
  const limpio = run(base)
  if (limpio.length) {
    console.error('SELF-TEST FALLO: el árbol actual ya viola el contrato:')
    limpio.forEach((x) => console.error('  · ' + x))
    process.exit(1)
  }
  const edit = (path, a, b) => (files) => {
    const src = files.get(path)
    if (src == null || !src.includes(a)) return files
    const next = new Map(files)
    next.set(path, src.split(a).join(b))
    return next
  }
  const add = (path, body) => (files) => new Map([...files, [path, body]])
  const drop = (path) => (files) => { const n = new Map(files); n.delete(path); return n }
  const HYP = 'src/services/hipoteticoStock.ts'

  const MUTACIONES = [
    // mínimas pedidas
    ['1 · UPDATE directo de stock_quantity (archivo real)', edit('src/pages/Mayorista.tsx', '.update({ precio_mayorista: price })', '.update({ precio_mayorista: price, stock_quantity: 0 })')],
    ['1b · UPDATE directo de stock_quantity (archivo nuevo)', add(HYP, "import { supabase } from '../lib/supabase'\nexport async function f(id: string) { await supabase.from('inventory').update({ stock_quantity: 5 }).eq('id', id) }\n")],
    ['2 · INSERT de inventory con stock', edit(PRODUCT_SVC, '.insert({ ...baseRow, code })', '.insert({ ...baseRow, code, stock: 3 })')],
    ['2b · INSERT con stock vía variable local', edit(PRODUCT_SVC, '      min_stock:           minStock,\n', '      min_stock:           minStock,\n      stock_quantity:      5,\n')],
    ['2c · UPSERT de inventory con stock', add(HYP, "import { supabase } from '../lib/supabase'\nexport async function f(r: any) { await supabase.from('inventory').upsert([{ id: r.id, stock: r.n }]) }\n")],
    ['3 · INSERT en inventory_movements', add(HYP, "import { supabase } from '../lib/supabase'\nexport async function f(b: string) { await supabase\n  .from('inventory_movements')\n  .insert({ business_id: b, quantity: 1 }) }\n")],
    ['3b · DELETE de inventory_movements', add(HYP, "import { supabase } from '../lib/supabase'\nexport async function f(id: string) { await supabase.from('inventory_movements').delete().eq('id', id) }\n")],
    ['4 · registerMovement legacy', add(HYP, "import { inventoryMovementsService } from './inventoryMovementsService'\nexport async function f() { await (inventoryMovementsService as any).registerMovement('x', 'in', 1) }\n")],
    ['4b · manualAdjustment legacy', add(HYP, "export async function f(s: any) { await s.manualAdjustment('x', 1, 'n', 'b', 'u') }\n")],
    ['5 · import de Excel pisa stock_quantity', edit(INVENTORY_PAGE, "          min_stock: Number(row['Stock mínimo'] || row['stock_minimo'] || 1),\n", "          stock_quantity: Number(row['Stock actual'] || row['stock'] || 0),\n          min_stock: Number(row['Stock mínimo'] || row['stock_minimo'] || 1),\n")],
    ['5b · import usa el stock leído como expected', edit(INVENTORY_PAGE, "expected: row[STOCK_EXPECTED_COLUMN] ?? row['stock_esperado'],", "expected: (existingItem as any)?.stock_quantity,")],
    ['5c · import sin applyStockImport', edit(INVENTORY_PAGE, 'const summary = await applyStockImport({', 'const summary = await (async (_: any) => ({}) as any)({')],
    ['5d · export sin «Stock esperado»', edit(INVENTORY_PAGE, '        [STOCK_EXPECTED_COLUMN]: item.stock_quantity,\n', '')],
    ['5e · plan de import sin omitir archivo viejo', edit(IMPORT_SVC, "if (expected.kind === 'blank') { plan.missingExpected.push(row.code); continue }", "if (expected.kind === 'blank') { continue }")],
    ['6 · duplicar copia el stock', edit(INVENTORY_PAGE, 'const rest: any = withoutStockFields(definition)', 'const rest: any = definition')],
    // hook / servicio fail-closed
    ['updateItem sin fail-closed', edit(HOOK, "      assertNoStockFields(updates, 'updateItem')\n", '')],
    ['addItem sin fail-closed', edit(HOOK, "      assertNoStockFields(item, 'addItem')\n", '')],
    ['updateProduct sin fail-closed', edit(PRODUCT_SVC, "    assertNoStockFields(updates, 'updateProduct')\n", '')],
    ['read-calculate-absolute-write', add(HYP, "import { supabase } from '../lib/supabase'\nexport async function f(id: string, q: number) {\n  const { data } = await supabase.from('inventory').select('stock_quantity').eq('id', id).single()\n  const nuevo = (data?.stock_quantity ?? 0) + q\n  const patch = { stock_quantity: nuevo }\n  await supabase.from('inventory').update(patch).eq('id', id)\n}\n")],
    ['payload opaco sin aserción', add(HYP, "import { supabase } from '../lib/supabase'\nexport async function f(p: Record<string, unknown>) { await supabase.from('inventory').update(p).eq('id', 'x') }\n")],
    ['addItem con stock en el literal', edit(INVENTORY_PAGE, 'const createdVariant = await addItem({ ...variantPayload, code: codeToTry } as any', 'const createdVariant = await addItem({ ...variantPayload, code: codeToTry, stock_quantity: 3 } as any')],
    // RPC / adapter
    ['la RPC A1 fuera del adapter', add(HYP, "import { supabase } from '../lib/supabase'\nexport const f = () => supabase.rpc('apply_inventory_stock_adjustments_atomic', {})\n")],
    ['el adapter escribe inventory', edit(ADAPTER, '  if (error) throw toStockAdjustmentError(error)', "  await supabase.from('inventory').update({ min_stock: 0 }).eq('id', 'x')\n  if (error) throw toStockAdjustmentError(error)")],
    ['el adapter no exige clave', edit(ADAPTER, '  if (!key) {', '  if (false) {')],
    ['clave de stock inicial no estable', edit(ADAPTER, 'return `initial-stock:${inventoryId}`', 'return `initial-stock:${crypto.randomUUID()}`')],
    ['clave de import no ligada al intento', edit(ADAPTER, 'return `g2c3a2-import-${kind}:${attemptId}:${chunk}`', 'return `g2c3a2-import-${kind}:${Date.now()}:${chunk}`')],
    ['falta el adapter', drop(ADAPTER)],
    // quick-create contextual
    ['quick-create de proveedor con saldo', edit('src/pages/Suppliers.tsx', 'registerStock={false}', 'registerStock')],
    ['quick-create de gastos sin registerStock', edit('src/pages/Expenses.tsx', '      registerStock={false}\n', '')],
    ['initialQuantity vuelve a ser stock', edit(PFM, "      stock_quantity: '0',\n      exchange_rate: currentRate,", '      stock_quantity: String(initialQuantity ?? 0),\n      exchange_rate: currentRate,')],
    ['stock inicial fuera de Inventario', edit(PFM, 'const canSetInitialStock = registerStock && !isEditMode', 'const canSetInitialStock = !isEditMode')],
    ['edición sin stale', edit(PFM, "if (result.status === 'stale') {", 'if (false) {')],
    // variantes
    ['«Con variantes» habilitado', edit(PFM, 'export const VARIANTS_V2_ENABLED = false', 'export const VARIANTS_V2_ENABLED = true')],
    ['«Con variantes» seleccionable', edit(PFM, ".filter(o => o.v !== 'with_variants' || VARIANTS_V2_ENABLED)", '.filter(() => true)')],
    ['initialTipo with_variants sin degradar', edit(PFM, "initialTipo === 'with_variants' && !VARIANTS_V2_ENABLED", "initialTipo === 'nunca'")],
    ['menú «Producto con variantes» visible', edit(INVENTORY_PAGE, '{VARIANTS_V2_ENABLED && <button', '{<button')],
    ['se pierde «Agregar variante» legacy', edit(INVENTORY_PAGE, 'title="Agregar variante"', 'title="Variante"')],
    // rollback destructivo
    ['createProduct borra el producto si falla el stock', edit(PRODUCT_SVC, '        throw new InitialStockPendingError(product, initialStock, err)', "        await supabase.from('inventory').delete().eq('id', product.id)\n        throw new InitialStockPendingError(product, initialStock, err)")],
  ]

  const CONTROLES = [
    ['7 · SELECT de stock permitido', add(HYP, "import { supabase } from '../lib/supabase'\nexport async function f(b: string) { return supabase.from('inventory').select('id, stock, stock_quantity').eq('business_id', b) }\n")],
    ['8 · RPC A1 vía adapter permitida', add(HYP, "import { inventoryStockAdjustmentService } from './inventoryStockAdjustmentService'\nexport const f = (b: string, id: string) => inventoryStockAdjustmentService.applyManualTarget({ businessId: b, inventoryId: id, target: 5, expected: 4, idempotencyKey: 'k' })\n")],
    ['tipo con stock_quantity', add(HYP, 'export interface X { stock_quantity: number; stock?: number }\n')],
    ['form state con stock_quantity', add(HYP, "export const f = (s: any, set: any) => set({ ...s, stock_quantity: 3 })\n")],
    ['comentario con un UPDATE de stock', add(HYP, "// supabase.from('inventory').update({ stock_quantity: 1 })\nexport const x = 1\n")],
    ['UPDATE de metadata con ternario sobre stock', add(HYP, "import { supabase } from '../lib/supabase'\nexport async function f(stock: number) { await supabase.from('inventory').update({ min_stock: stock > 0 ? stock : 0 }).eq('id', 'x') }\n")],
    ['product_variants con stock (no es inventory)', add(HYP, "import { supabase } from '../lib/supabase'\nexport async function f() { await supabase.from('product_variants').insert({ stock: 3 }) }\n")],
    ['fixture de test fuera de src', add('tests/fixtures/hipotetico.ts', "supabase.from('inventory').insert({ stock_quantity: 9 })\n")],
    ['addItem del carrito del portal con stock (no es inventory)', add('src/portal/hipoteticoCarrito.ts', "export const f = (addItem: any, p: any) => addItem({ inventoryItemId: p.id, stock: p.stock_quantity })\n")],
    ['lectura de inventory_movements', add(HYP, "import { supabase } from '../lib/supabase'\nexport async function f(id: string) { return supabase.from('inventory_movements').select('id').eq('inventory_item_id', id) }\n")],
  ]

  let fallos = 0
  for (const [nombre, mutar] of MUTACIONES) {
    const mutado = mutar(base)
    if (mutado === base) { console.error(`  ✖ ${nombre}: la mutación NO aplicó (el patrón cambió) — el self-test estaría mintiendo`); fallos++; continue }
    const r = run(mutado)
    if (!r.length) { console.error(`  ✖ ${nombre}: NO detectado`); fallos++ } else console.log(`  ✔ ${nombre}: detectado → ${r[0].slice(0, 150)}`)
  }
  for (const [nombre, mutar] of CONTROLES) {
    const mutado = mutar(base)
    if (mutado === base) { console.error(`  ✖ control "${nombre}": no aplicó`); fallos++; continue }
    const r = run(mutado)
    if (r.length) { console.error(`  ✖ control "${nombre}": falso positivo -> ${r[0]}`); fallos++ } else console.log(`  ✔ control "${nombre}": no se marca (correcto)`)
  }
  if (fallos) { console.error(`SELF-TEST FALLO: ${fallos} mutación(es)/control(es) fallido(s).`); process.exit(1) }
  console.log(`SELF-TEST OK: las ${MUTACIONES.length} mutaciones del contrato G2-C.3A2 son detectadas y los ${CONTROLES.length} controles no dan falso positivo.`)
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const findings = run(load())
  if (findings.length) {
    console.error('GUARD G2-C.3A2 FALLO — el navegador volvió a ser autoridad del stock:')
    findings.forEach((x) => console.error('  · ' + x))
    process.exit(1)
  }
  console.log('GUARD G2-C.3A2 OK · src/ sin INSERT/UPDATE/UPSERT de stock en inventory · 0 writes de inventory_movements '
    + '· sin writers legacy (registerMovement & cía.) · RPC canónica sólo vía el adapter · claves estables por intención '
    + '· Excel con «Stock esperado» y stock por RPC · duplicar = definición en 0 · quick-create contextual en 0 '
    + '· «Con variantes» oculto, «Agregar variante» legacy vivo.')
  console.log('NOTA · alcance A2: el cierre en DB (revocar UPDATE de stock / INSERT de movimientos a authenticated) es G2-C.3A3.')
}
