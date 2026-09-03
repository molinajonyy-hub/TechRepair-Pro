#!/usr/bin/env node
// SEC-08B — guard de la visibilidad del COSTO DE INVENTARIO.
//
// Vigila las clases de regresión que este lote cerró, en la migración, en las
// migraciones posteriores, y —a diferencia de SEC-08A, que era frontera de
// FILAS— también en el frontend, porque acá la frontera es de COLUMNAS y el
// cliente puede reabrirla pidiendo una columna revocada.
//
// Clases cubiertas:
//   1. Que una columna de costo vuelva a concederse a un rol del navegador.
//   2. Que las proyecciones autorizadas pierdan su gate de capacidad, su
//      tenant, o pasen a `security_invoker` (con lo que dependerían del GRANT
//      revocado y responderían 42501 a TODOS, owner incluido).
//   3. Que la autoridad de costo se resuelva CIEGA al tenant
//      (`current_user_can`) en vez de `current_user_can_in_business`.
//   4. Que `can_view_inventory_cost` incorpore `finance` y deje muerto el
//      override explícito a false de admin y cashier.
//   5. Que las tablas cuya fila entera es costo vuelvan al gate de módulo.
//   6. Que se abra `USAGE` sobre `private` para «arreglar» las vistas: ese
//      esquema conserva funciones `arca_*` con EXECUTE a PUBLIC.
//   7. Frontend: un `.select()` que vuelva a pedir una columna de costo, o un
//      `select('*')` sobre una tabla con columnas revocadas.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION = 'supabase/migrations/20260914120000_sec08b_inventory_cost_visibility.sql'
const MIGRATION_B = 'supabase/migrations/20260915120000_sec08b_b_cost_write_authority.sql'

/** Columnas revocadas, por tabla. */
const REVOKED = {
  inventory: ['cost_price', 'cost_price_usd'],
  inventory_movements: ['unit_cost'],
  comprobante_items: ['costo_unitario', 'costo_total'],
}
/** Vistas que SÍ pueden exponer costo: son la ruta autorizada. */
const AUTHORIZED_VIEWS = ['v_inventory_costs', 'v_inventory_movement_costs', 'v_comprobante_item_costs']

/**
 * Saca los comentarios SQL antes de buscar patrones prohibidos.
 *
 * Sin esto el guard se acusa a sí mismo: la migración EXPLICA en su cabecera por
 * qué NO se concede `USAGE ON SCHEMA private`, y esa frase matchea el patrón que
 * busca la concesión real.
 */
const stripSqlComments = s => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

const viewBody = (sqlText, name) =>
  sqlText.match(new RegExp(`CREATE OR REPLACE VIEW public\\.${name}\\b[\\s\\S]*?;`))?.[0] ?? ''
const policyBody = (sqlText, name) =>
  sqlText.match(new RegExp(`CREATE POLICY ${name}\\b[\\s\\S]*?;`))?.[0] ?? ''

// ─── Análisis del frontend ───────────────────────────────────────────────────
// Estructural, no regex sobre todo el repo: se localiza cada `.from('<tabla>')`
// y se lee el `.select(...)` que le sigue en la misma cadena, respetando
// paréntesis y comillas. Un `cost_price` suelto en un comentario o en un tipo no
// dispara nada; sólo lo que realmente viaja en la proyección.

/**
 * Devuelve el `.select(...)` que pertenece a ESTA cadena.
 *
 * La ventana se corta en el primer `;` o en el siguiente `.from(`, porque si no
 * un `.select()` sin argumento —que es válido y hay que reportar aparte— dejaba
 * que la búsqueda siguiera hasta el `.select('...')` de la función SIGUIENTE y
 * se acusaba a la llamada equivocada.
 *
 * `bare: true` es `.select()` sin argumento: PostgREST lo manda como
 * `RETURNING *`, así que cae con 42501 igual que `select('*')`.
 */
function selectAfter(src, fromIdx) {
  let tail = src.slice(fromIdx + 1, fromIdx + 1200)
  const stop = Math.min(
    ...[tail.indexOf(';'), tail.search(/\.from\(/)].filter(i => i >= 0).concat([tail.length]))
  tail = tail.slice(0, stop)
  const m = tail.match(/\.select\(\s*(?:(['"`])([\s\S]*?)\1)?\s*[),]/)
  if (!m) return null
  return m[1] === undefined ? { bare: true, literal: '' } : { bare: false, literal: m[2] }
}

/**
 * Saca comentarios de línea y de bloque, conservando la longitud del archivo.
 *
 * Igual que en SQL: los comentarios de este lote EXPLICAN los patrones
 * prohibidos («`.select()` a secas es RETURNING *»), y sin esto el guard se
 * acusa a sí mismo. Se sustituye por espacios en vez de borrar para no correr
 * los índices y que las ventanas de búsqueda sigan alineadas con el original.
 */
const stripTsComments = s =>
  s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m.replace(/[^\n]/g, ' '))

function scanSourceFile(path, rawSrc) {
  const src = stripTsComments(rawSrc)
  const found = []
  for (const [table, cols] of Object.entries(REVOKED)) {
    const re = new RegExp(`\\.from\\(\\s*['"\`]${table}['"\`]\\s*\\)`, 'g')
    let m
    while ((m = re.exec(src)) !== null) {
      const sel = selectAfter(src, m.index)
      if (!sel) continue
      const lit = sel.literal
      if (sel.bare) {
        found.push(`${path}: .select() sin argumento sobre ${table} — es RETURNING * y responde 42501 a TODOS; usar la constante *_OPERATIONAL_COLUMNS`)
        continue
      }
      // `select('*')` — incluye el `*` de una plantilla con relaciones anidadas.
      if (/(^|[\s(,])\*\s*(,|$)/.test(lit)) {
        found.push(`${path}: select('*') sobre ${table} — 42501 para TODOS los roles; usar la constante *_OPERATIONAL_COLUMNS`)
      }
      for (const c of cols) {
        if (new RegExp(`\\b${c}\\b`).test(lit)) {
          found.push(`${path}: el select de ${table} vuelve a pedir '${c}', que está revocada para el navegador`)
        }
      }
    }
  }
  // Una lectura anidada de costo por relación (`inventory:inventory_id(...cost_price...)`)
  // no pasa por `.from('inventory')`, así que se busca aparte.
  const nested = src.match(/inventory[^)\n]{0,40}\([^)]*\b(cost_price|cost_price_usd)\b[^)]*\)/g)
  if (nested) {
    for (const n of nested) found.push(`${path}: relación anidada pide costo — ${n.slice(0, 80)}`)
  }
  return found
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) { walk(p, out); continue }
    if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

/**
 * Reglas de la FASE B — preservación del costo y contención del COGS crudo.
 *
 * Las clases que se vigilan acá salieron de una revisión adversarial que
 * reprodujo, de punta a punta, `51101 → 0` al editar el nombre de un producto,
 * y la lectura enumerable del costo por producto con sólo tener `finance`.
 */
function inspectPhaseB({ migrationB, later, sources }) {
  const failures = []
  const mB = stripSqlComments(migrationB)

  // ── El costo CRUDO de línea no puede volver a habilitarse con `finance` ────
  const itemCosts = mB.match(/CREATE OR REPLACE VIEW public\.v_comprobante_item_costs\b[\s\S]*?;/)?.[0] ?? ''
  if (!itemCosts) failures.push('la Fase B no redefine v_comprobante_item_costs')
  if (/can_view_cogs\s*\(/.test(itemCosts)) {
    failures.push('v_comprobante_item_costs volvió al gate can_view_cogs: `finance` habilitaría de nuevo el costo por producto y la capacidad «Ver precios de costo» quedaría sin efecto')
  }
  if (!/can_view_inventory_cost\s*\(/.test(itemCosts)) {
    failures.push('v_comprobante_item_costs perdió el gate de inventory_view_costs')
  }
  if (!/comprobante_is_order_linked/.test(itemCosts) || !/orders_view_financials/.test(itemCosts)) {
    failures.push('v_comprobante_item_costs perdió el predicado de orden vinculada de SEC-08A')
  }

  // ── El agregado de período no puede ganar dimensión de producto ────────────
  const period = mB.match(/CREATE OR REPLACE VIEW public\.v_finance_period_cogs\b[\s\S]*?;/)?.[0] ?? ''
  if (!period) failures.push('la Fase B no define v_finance_period_cogs')
  if (!/GROUP BY\s+business_id\s*,\s*period_date/i.test(period)) {
    failures.push('v_finance_period_cogs dejó de agrupar por negocio y período: podría estrecharse hasta un costo unitario')
  }
  for (const dim of ['inventory_id', 'comprobante_item_id']) {
    if (new RegExp(`\\bAS\\s+${dim}\\b|\\b${dim}\\s*,\\s*$`, 'm').test(period.split('SELECT business_id,')[1] ?? '')) {
      failures.push(`v_finance_period_cogs expone la dimensión ${dim}`)
    }
  }
  if (!/can_view_cogs\s*\(/.test(period)) failures.push('v_finance_period_cogs perdió su gate can_view_cogs')
  if (!/REVOKE ALL ON public\.v_finance_period_cogs FROM anon/.test(mB)) {
    failures.push('v_finance_period_cogs no le está revocada a anon')
  }

  // ── El trigger de preservación del costo ──────────────────────────────────
  if (!/CREATE TRIGGER trig_inventory_guard_cost_write[\s\S]*?ON public\.inventory/.test(mB)) {
    failures.push('la Fase B no monta trig_inventory_guard_cost_write sobre inventory')
  }
  const tg = mB.match(/CREATE OR REPLACE FUNCTION public\.tg_inventory_guard_cost_write[\s\S]*?\$\$;/)?.[0] ?? ''
  if (!/SECURITY DEFINER/.test(tg)) failures.push('el trigger de costo no es SECURITY DEFINER')
  if (!/NEW\.cost_price\s*:=\s*OLD\.cost_price/.test(tg)) {
    failures.push('el trigger ya no PRESERVA el costo anterior en UPDATE: volvería la destrucción silenciosa')
  }
  if (!/can_view_inventory_cost/.test(tg)) failures.push('el trigger de costo no consulta la autoridad tenant-bound')
  if (!/auth\.uid\(\)\s+IS\s+NULL/.test(tg)) {
    failures.push('el trigger no exime a los caminos server-side (auth.uid() NULL): rompería el checkout y las RPC canónicas')
  }
  const laterClean = stripSqlComments(later)
  if (/DROP\s+TRIGGER[^;]*trig_inventory_guard_cost_write/i.test(laterClean)
    || /DISABLE\s+TRIGGER\s+trig_inventory_guard_cost_write/i.test(laterClean)) {
    failures.push('una migración posterior desactiva o elimina el trigger de preservación del costo')
  }
  const laterItemCosts = laterClean.match(/CREATE OR REPLACE VIEW public\.v_comprobante_item_costs\b[\s\S]*?;/)?.[0] ?? ''
  if (laterItemCosts && /can_view_cogs\s*\(/.test(laterItemCosts)) {
    failures.push('una migración posterior devuelve v_comprobante_item_costs al gate can_view_cogs')
  }

  // ── Frontend: el payload de EDICIÓN no puede llevar costo incondicional ────
  for (const [path, raw] of sources) {
    const p = path.replace(/\\/g, '/')
    const src = stripTsComments(raw)

    if (p.endsWith('src/components/products/ProductFormModal.tsx')) {
      // El bloque de edición tiene que mandar el costo por la vía condicional.
      const edit = src.slice(src.indexOf('isEditMode && editItem'))
      if (edit && !/\.\.\.costFields/.test(edit)) {
        failures.push(`${path}: el payload de EDICIÓN no usa el spread condicional de costo`)
      }
      if (/updateProduct\([\s\S]{0,1400}?cost_price:\s*costARS/.test(src)) {
        failures.push(`${path}: updateProduct manda cost_price incondicionalmente — un formulario que nunca recibió el costo escribiría 0 sobre el real`)
      }
      if (/editItem\.cost_price\s*\?\?\s*0|editItem\.cost_price\s*\|\|\s*0/.test(src)) {
        failures.push(`${path}: se vuelve a inventar 0 cuando el costo del ítem no vino — es exactamente la causa raíz del P0`)
      }
      if (!/costLoaded/.test(src) || !/costAuthorized/.test(src)) {
        failures.push(`${path}: perdió el gate de «el costo llegó y estoy autorizado» antes de escribirlo`)
      }
    }

    if (p.endsWith('src/pages/Inventory.tsx')) {
      // El import de Excel no puede leer una celda ausente como cero.
      if (/cost_price:\s*Number\(row\[[^\]]*\]\s*\|\|/.test(src)) {
        failures.push(`${path}: el import de Excel interpreta una celda de costo ausente como 0 — un round-trip destruiría el costo de todo el catálogo`)
      }
      if (!/hasCostArs/.test(src)) {
        failures.push(`${path}: el import de Excel perdió la distinción entre «celda ausente» y «cero escrito a propósito»`)
      }
      // El export no puede publicar un costo que el actor no recibió.
      if (/'Precio de costo \(ARS\)':\s*item\.cost_price\b/.test(src)) {
        failures.push(`${path}: el export de Excel toma el costo de la lectura operativa, que ya no lo trae`)
      }
    }
  }

  return failures
}

export function inspect({ migration, later, sources, migrationB }) {
  const failures = []
  if (migrationB !== undefined) failures.push(...inspectPhaseB({ migrationB, later, sources }))

  // ── 1. Las columnas de costo quedan revocadas ──────────────────────────────
  if (!/REVOKE SELECT ON public\.%I FROM authenticated/.test(migration)) {
    failures.push('la migración no revoca el SELECT de tabla antes de re-conceder columna por columna')
  }
  for (const [table, cols] of Object.entries(REVOKED)) {
    const listed = new RegExp(`'${table}'[^)]*ARRAY\\[${cols.map(c => `'${c}'`).join(',')}\\]`)
    if (!listed.test(migration.replace(/\s+/g, ' '))) {
      failures.push(`${table} no declara como bloqueadas exactamente ${cols.join(', ')}`)
    }
  }

  // ── 2/3/4. Autoridad de costo ──────────────────────────────────────────────
  const authFn = migration.match(/CREATE OR REPLACE FUNCTION public\.can_view_inventory_cost[\s\S]*?\$\$;/)?.[0] ?? ''
  if (!authFn) failures.push('la migración no define public.can_view_inventory_cost')
  if (!/current_user_can_in_business\(\s*p_business_id\s*,\s*'inventory_view_costs'\s*\)/.test(authFn)) {
    failures.push('can_view_inventory_cost no resuelve la capacidad en el negocio de la fila')
  }
  if (/[^_]\bcurrent_user_can\s*\(\s*'/.test(authFn)) {
    failures.push('can_view_inventory_cost usa una autoridad CIEGA al tenant')
  }
  if (/'finance'/.test(authFn)) {
    failures.push("can_view_inventory_cost incorporó 'finance': admin y cashier lo traen por defecto, así que un override explícito de inventory_view_costs=false dejaría de denegar")
  }
  const cogsFn = migration.match(/CREATE OR REPLACE FUNCTION public\.can_view_cogs[\s\S]*?\$\$;/)?.[0] ?? ''
  if (!cogsFn) failures.push('la migración no define public.can_view_cogs')
  if (!/'inventory_view_costs'/.test(cogsFn) || !/'finance'/.test(cogsFn)) {
    failures.push('can_view_cogs perdió una de sus dos capacidades: sin finance el P&L del cashier mostraría gross_profit = net_sales')
  }
  for (const fn of ['can_view_inventory_cost', 'can_view_cogs']) {
    if (!new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn}\\(uuid\\) FROM anon`).test(migration)) {
      failures.push(`${fn} no le está revocada a anon`)
    }
    if (!new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(uuid\\) TO authenticated`).test(migration)) {
      failures.push(`${fn} no es ejecutable por authenticated: toda vista que la invoque respondería 42501 a TODOS`)
    }
  }

  // ── 2. Las proyecciones autorizadas ────────────────────────────────────────
  for (const v of AUTHORIZED_VIEWS) {
    const body = viewBody(migration, v)
    if (!body) { failures.push(`la migración no define public.${v}`); continue }
    if (/security_invoker\s*=\s*true/i.test(body)) {
      failures.push(`${v} es security_invoker: volvería a depender del GRANT de columna revocado y respondería 42501 a todos`)
    }
    if (!/current_user_business_id\(\)/.test(body)) {
      failures.push(`${v} perdió el predicado de tenant: al ser DEFINER ya no hereda la RLS que se lo daba`)
    }
    const gate = v === 'v_comprobante_item_costs' ? 'can_view_cogs' : 'can_view_inventory_cost'
    if (!new RegExp(`public\\.${gate}\\(`).test(body)) {
      failures.push(`${v} perdió su gate de costo (${gate})`)
    }
    if (!new RegExp(`GRANT SELECT ON public\\.${v} TO authenticated`).test(migration)) {
      failures.push(`${v} no es legible por authenticated`)
    }
    if (!new RegExp(`REVOKE ALL ON public\\.${v} FROM anon`).test(migration)) {
      failures.push(`${v} no le está revocada a anon`)
    }
  }
  // SEC-08A no se reabre: la proyección de línea conserva su predicado de orden.
  const ci = viewBody(migration, 'v_comprobante_item_costs')
  if (ci && !/comprobante_is_order_linked/.test(ci)) {
    failures.push('v_comprobante_item_costs perdió el predicado de orden vinculada de SEC-08A: al ser DEFINER ya no lo hereda de la RLS')
  }
  if (ci && !/orders_view_financials/.test(ci)) {
    failures.push('v_comprobante_item_costs ya no exige orders_view_financials para la línea de un comprobante de orden')
  }

  // ── 5. Tablas cuya fila entera es costo ────────────────────────────────────
  for (const p of ['purchases_select', 'purchase_items_select',
    'supplier_purchases_inventory_select', 'supplier_purchase_items_inventory_select',
    'inventory_valuation_history_select']) {
    const body = policyBody(migration, p)
    if (!body) { failures.push(`la migración no reescribe la policy ${p}`); continue }
    if (!/can_view_inventory_cost\(\s*business_id\s*\)/.test(body)) {
      failures.push(`${p} no exige autoridad de costo en el negocio de la fila`)
    }
    if (/[^_]\bcurrent_user_can\s*\(\s*'inventory'\s*\)/.test(body)) {
      failures.push(`${p} volvió al gate de MÓDULO ciego al tenant: sales recuperaría el costo de compra`)
    }
  }

  // ── 6. `private` sigue cerrado ─────────────────────────────────────────────
  if (/GRANT\s+USAGE\s+ON\s+SCHEMA\s+private\s+TO\s+(authenticated|anon|PUBLIC)/i
    .test(stripSqlComments(migration + '\n' + later))) {
    failures.push('se concedió USAGE sobre el esquema private: conserva funciones arca_* con EXECUTE a PUBLIC')
  }

  // ── Postcondiciones vivas ──────────────────────────────────────────────────
  for (const marker of [
    'quedaron GRANT de columnas de costo',
    'se perdió el SELECT de inventory.sale_price',
    "has_function_privilege('anon', 'public.can_view_inventory_cost(uuid)', 'EXECUTE')",
    'proyección de costo con security_invoker',
  ]) {
    if (!migration.includes(marker)) failures.push(`falta la postcondición: ${marker}`)
  }

  // ── Ninguna migración posterior lo revierte ────────────────────────────────
  for (const [table, cols] of Object.entries(REVOKED)) {
    for (const c of cols) {
      const re = new RegExp(`GRANT\\s+SELECT[^;]*\\(([^)]*\\b${c}\\b[^)]*)\\)[^;]*\\bON\\b[^;]*\\b${table}\\b[^;]*\\bTO\\b[^;]*(authenticated|anon)`, 'i')
      if (re.test(later)) failures.push(`una migración posterior le devuelve ${table}.${c} al navegador`)
    }
    const whole = new RegExp(`GRANT\\s+(?:SELECT|ALL)\\s+ON\\s+(?:TABLE\\s+)?(?:public\\.)?${table}\\s+TO\\s+[^;]*(authenticated|anon)`, 'i')
    if (whole.test(later)) failures.push(`una migración posterior concede ${table} ENTERA (incluidas las columnas de costo)`)
  }
  for (const v of AUTHORIZED_VIEWS) {
    const laterBody = viewBody(later, v)
    if (laterBody && /security_invoker\s*=\s*true/i.test(laterBody)) {
      failures.push(`una migración posterior vuelve ${v} security_invoker`)
    }
    if (laterBody && !/can_view_inventory_cost|can_view_cogs/.test(laterBody)) {
      failures.push(`una migración posterior quita el gate de costo de ${v}`)
    }
  }

  // ── 7. Frontend ────────────────────────────────────────────────────────────
  for (const [path, src] of sources) {
    // El módulo de acceso autorizado lee las VISTAS a propósito.
    if (path.replace(/\\/g, '/').endsWith('src/services/inventoryCostAccess.ts')) continue
    failures.push(...scanSourceFile(path, src))
  }

  return failures
}

const load = () => {
  const all = readdirSync('supabase/migrations').filter(n => n.endsWith('.sql')).sort()
  const base = MIGRATION.split('/').at(-1)
  const baseB = MIGRATION_B.split('/').at(-1)
  return {
    migration: readFileSync(MIGRATION, 'utf8'),
    migrationB: readFileSync(MIGRATION_B, 'utf8'),
    // «posteriores» se cuenta desde la Fase B: la propia Fase B redefine objetos
    // de la Fase A a propósito y no puede contarse como una reversión.
    later: all.filter(n => n > baseB).map(n => readFileSync(`supabase/migrations/${n}`, 'utf8')).join('\n'),
    sources: walk('src').map(p => [p, readFileSync(p, 'utf8')]),
  }
}

if (process.argv.includes('--self-test')) {
  const src = load()
  const mut = (field, from, to) => ({ ...src, [field]: src[field].replace(from, to) })
  const mutations = [
    [mut('migration', /AND public\.current_user_can_in_business\(p_business_id, 'inventory_view_costs'\);/,
      "AND public.current_user_can('inventory_view_costs');"), 'CIEGA al tenant'],
    [mut('migration', /SELECT p_business_id IS NOT NULL\s*\n\s*AND public\.current_user_can_in_business\(p_business_id, 'inventory_view_costs'\);/,
      "SELECT public.current_user_can_in_business(p_business_id,'inventory_view_costs') OR public.current_user_can_in_business(p_business_id,'finance');"),
      "incorporó 'finance'"],
    [mut('migration', "   AND public.can_view_inventory_cost(i.business_id);", ';'), 'perdió su gate de costo'],
    [mut('migration', 'CREATE OR REPLACE VIEW public.v_inventory_costs AS',
      'CREATE OR REPLACE VIEW public.v_inventory_costs WITH (security_invoker = true) AS'), 'es security_invoker'],
    [mut('migration', ' WHERE i.business_id = public.current_user_business_id()', ' WHERE true'), 'perdió el predicado de tenant'],
    [mut('migration', 'REVOKE EXECUTE ON FUNCTION public.can_view_inventory_cost(uuid) FROM anon;', '-- sin revoke'),
      'no le está revocada a anon'],
    [mut('migration', /AND \( NOT public\.comprobante_is_order_linked\(ci\.comprobante_id\)[\s\S]*?'orders_view_financials'\) \)/,
      'AND true'), 'predicado de orden vinculada de SEC-08A'],
    [mut('migration', /CREATE POLICY purchase_items_select ON public\.purchase_items[\s\S]*?;/,
      "CREATE POLICY purchase_items_select ON public.purchase_items FOR SELECT TO authenticated USING (business_id = public.current_user_business_id() AND current_user_can('inventory'));"),
      'volvió al gate de MÓDULO'],
    [{ ...src, migration: src.migration + '\nGRANT USAGE ON SCHEMA private TO authenticated;' }, 'USAGE sobre el esquema private'],
    [mut('migration', 'quedaron GRANT de columnas de costo', 'ok'), 'falta la postcondición'],
    [{ ...src, later: src.later + '\nGRANT SELECT (cost_price) ON public.inventory TO authenticated;' },
      'devuelve inventory.cost_price al navegador'],
    [{ ...src, later: src.later + '\nGRANT SELECT ON TABLE public.comprobante_items TO authenticated;' },
      'concede comprobante_items ENTERA'],
    [{ ...src, later: src.later + '\nCREATE OR REPLACE VIEW public.v_inventory_costs WITH (security_invoker = true) AS SELECT 1;' },
      'vuelve v_inventory_costs security_invoker'],
    // Frontend
    [{ ...src, sources: [['src/fake.ts', "supabase.from('inventory').select('id, name, cost_price')"]] },
      "vuelve a pedir 'cost_price'"],
    [{ ...src, sources: [['src/fake.ts', "supabase.from('inventory_movements')\n  .select('*')"]] },
      "select('*') sobre inventory_movements"],
    [{ ...src, sources: [['src/fake.ts', "supabase.from('comprobante_items').select('id, costo_total')"]] },
      "vuelve a pedir 'costo_total'"],
    [{ ...src, sources: [['src/fake.ts', "supabase.from('comprobante_items').select('inventory:inventory_id(id,cost_price)')"]] },
      'relación anidada pide costo'],
    [{ ...src, sources: [['src/fake.ts', "supabase.from('inventory').insert(x).select().single()"]] },
      '.select() sin argumento sobre inventory'],

    // ── FASE B ──────────────────────────────────────────────────────────────
    [mut('migrationB', 'AND public.can_view_inventory_cost(ci.business_id);', 'AND public.can_view_cogs(ci.business_id);'),
      'volvió al gate can_view_cogs'],
    [mut('migrationB', /AND public\.can_view_inventory_cost\(ci\.business_id\);/, ';'),
      'perdió el gate de inventory_view_costs'],
    [mut('migrationB', /AND \( NOT public\.comprobante_is_order_linked\(ci\.comprobante_id\)[\s\S]*?'orders_view_financials'\) \)/, 'AND true'),
      'predicado de orden vinculada de SEC-08A'],
    [mut('migrationB', '  GROUP BY business_id, period_date;', '  GROUP BY business_id;'),
      'dejó de agrupar por negocio y período'],
    [mut('migrationB', /AND public\.can_view_cogs\(business_id\)\n/, '\n'),
      'perdió su gate can_view_cogs'],
    [mut('migrationB', 'REVOKE ALL ON public.v_finance_period_cogs FROM anon;', '-- sin revoke'),
      'v_finance_period_cogs no le está revocada a anon'],
    [mut('migrationB', /CREATE TRIGGER trig_inventory_guard_cost_write[\s\S]*?FOR EACH ROW EXECUTE FUNCTION public\.tg_inventory_guard_cost_write\(\);/, '-- sin trigger'),
      'no monta trig_inventory_guard_cost_write'],
    [mut('migrationB', '    NEW.cost_price     := OLD.cost_price;', '    -- sin preservación'),
      'ya no PRESERVA el costo anterior'],
    [mut('migrationB', /IF auth\.uid\(\) IS NULL THEN\n    RETURN NEW;\n  END IF;/, '-- sin exención server-side'),
      'no exime a los caminos server-side'],
    [{ ...src, later: src.later + '\nDROP TRIGGER trig_inventory_guard_cost_write ON public.inventory;' },
      'desactiva o elimina el trigger'],
    [{ ...src, later: src.later + "\nCREATE OR REPLACE VIEW public.v_comprobante_item_costs AS SELECT 1 WHERE public.can_view_cogs(x);" },
      'devuelve v_comprobante_item_costs al gate can_view_cogs'],

    // Frontend — las tres formas del P0.
    [{ ...src, sources: [['src/components/products/ProductFormModal.tsx',
      "const x = isEditMode && editItem; await productService.updateProduct(id, { name, cost_price: costARS, cost_price_usd: costUSD }); const costLoaded=1, costAuthorized=1"]] },
      'manda cost_price incondicionalmente'],
    [{ ...src, sources: [['src/components/products/ProductFormModal.tsx',
      "const c = editItem.cost_price ?? 0; isEditMode && editItem; const y = '...costFields'; const costLoaded=1, costAuthorized=1"]] },
      'se vuelve a inventar 0 cuando el costo del ítem no vino'],
    [{ ...src, sources: [['src/components/products/ProductFormModal.tsx',
      "isEditMode && editItem; const z = 1"]] },
      'perdió el gate de «el costo llegó y estoy autorizado»'],
    [{ ...src, sources: [['src/pages/Inventory.tsx',
      "const d = { cost_price: Number(row['Precio de costo (ARS)'] || 0) }; const hasCostArs = 1"]] },
      'interpreta una celda de costo ausente como 0'],
    [{ ...src, sources: [['src/pages/Inventory.tsx', "const d = { a: 1 }"]] },
      'perdió la distinción entre «celda ausente»'],
    [{ ...src, sources: [['src/pages/Inventory.tsx',
      "const e = { 'Precio de costo (ARS)': item.cost_price }; const hasCostArs = 1"]] },
      'export de Excel toma el costo de la lectura operativa'],
  ]
  for (const [mutated, label] of mutations) {
    if (!inspect(mutated).some(f => f.includes(label))) throw new Error(`self-test no detectó: ${label}`)
  }
  const clean = inspect(src)
  if (clean.length) throw new Error(`self-test: falso positivo sobre el árbol real:\n- ${clean.join('\n- ')}`)
  console.log(`SEC-08B guard self-test OK: ${mutations.length} mutaciones detectadas, migración y frontend reales limpios`)
  process.exit(0)
}

const failures = inspect(load())
if (failures.length) {
  console.error(`SEC-08B inventory cost guard FAIL:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('SEC-08B inventory cost guard OK: las columnas de costo siguen revocadas para el navegador, las proyecciones autorizadas son DEFINER con tenant y capacidad, el override a false sigue denegando, y ningún caller del frontend vuelve a pedir costo')
