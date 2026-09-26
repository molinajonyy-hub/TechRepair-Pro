#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// G2-C.3A3 · Guard del lockdown en base de la autoridad de stock.
//
// A1 creo la autoridad (apply_inventory_stock_adjustments_atomic), A2 migro el
// frontend, A3 (20261009120000) cierra EN LA BASE los caminos directos:
//   · inventory: INSERT/UPDATE de tabla revocados a anon/authenticated;
//     authenticated reconstruido POR COLUMNA sin stock/stock_quantity; guard
//     zz_inventory_stock_authority_guard (INVOKER, rol canonico, 42501).
//   · inventory_movements: sin INSERT/UPDATE/DELETE de API ni policies de
//     escritura; append-only (trg_inventory_movements_append_only + TRUNCATE).
//   · FK inventory_item_id ON DELETE RESTRICT (el historial no se borra por
//     cascade).
//
// La suite SQL y la de PostgREST prueban el COMPORTAMIENTO sobre una base viva.
// Este guard mira el TEXTO: que la migracion candidata tenga el contrato, que no
// se pase de alcance (W1-W7, A1, SEC-08B, product_variants, CHECK stock >= 0,
// backfill) y que ninguna migracion POSTERIOR lo reabra (un GRANT UPDATE de
// tabla invalida el cierre por columna; una policy de escritura o un trigger
// deshabilitado reabre el libro; una FK en CASCADE vuelve a borrar historia).
//
// `--self-test` muta el arbol en memoria y exige que cada mutacion se detecte y
// que los controles no den falso positivo.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const MIG_DIR = 'supabase/migrations'
const VERSION = '20261009120000'
const MIG = `${VERSION}_g2c3a3_inventory_authority_lockdown.sql`
const TEST_SQL = 'tests/sql/g2c3a3_inventory_authority_lockdown.test.sql'
const TEST_HTTP = 'scripts/security/g2c3a3-postgrest.mjs'

const GUARD_FN = 'private.tg_inventory_stock_authority_guard'
const LEDGER_FN = 'private.tg_inventory_movements_append_only'
const GUARD_TG = 'zz_inventory_stock_authority_guard'
const LEDGER_TG = 'trg_inventory_movements_append_only'
const TRUNC_TG = 'trg_inventory_movements_no_truncate'
const FK = 'inventory_movements_inventory_item_id_fkey'

// Lo que A3 NO puede tocar.
const CANONICOS = [
  'private.create_comprobante_checkout_atomic',
  'private.create_quick_inventory_purchase_atomic',
  'private.sec08e_annul_comprobante_impl',
  'private.create_supplier_purchase_atomic',
  'public.delete_supplier_purchase_safe',
  'public.repair_missing_stock_movements',
  'public.adjust_stock_on_order_item',
]
const A1 = ['public.apply_inventory_stock_adjustments_atomic', 'private.apply_inventory_stock_adjustments_impl', 'private.lock_inventory_rows']
const A1_TABLA = 'private.inventory_stock_adjustment_requests'
const INTOCABLES = [
  'public.sync_inventory_stock_alias', 'public.tg_inventory_guard_cost_write', 'public.tg_inventory_inherit_variant_cost',
  'public.can_view_inventory_cost', 'public.set_exchange_rate_on_product_save', 'public.update_timestamp',
]
const TRIGGERS_PREVIOS = ['trg_sync_inventory_stock', 'trig_inventory_guard_cost_write', 'trig_inventory_inherit_variant_cost',
  'update_inventory_updated_at', 'set_exchange_rate_on_product_save_trigger']
const WRITE_POLICIES = ['inventory_movements_insert', 'inventory_movements_update', 'inventory_movements_delete']

const API = /\b(?:anon|authenticated|public|service_role)\b/i
const read = (p) => readFileSync(p, 'utf8')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const one = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 110)

/** Comentarios -> espacios. Respeta literales '...' (un -- dentro de un string no es comentario). */
export function sinComentarios(sql) {
  let out = '', i = 0, q = false
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1]
    if (q) { out += c; if (c === "'") q = false; i++; continue }
    if (c === "'") { q = true; out += c; i++; continue }
    if (c === '-' && n === '-') { const f = sql.indexOf('\n', i); const e = f === -1 ? sql.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (c === '/' && n === '*') { const f = sql.indexOf('*/', i + 2); const e = f === -1 ? sql.length : f + 2; out += sql.slice(i, e).replace(/[^\n]/g, ' '); i = e; continue }
    out += c; i++
  }
  return out
}

/** Contenido de los literales '...' -> espacios (los mensajes de RAISE no cuentan como codigo). */
export function sinLiterales(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, (m) => "'" + ' '.repeat(Math.max(0, m.length - 2)) + "'")
}

/** Funciones definidas: [{ nombre, cabecera, cuerpo }]. */
function funciones(sql) {
  const out = []
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\(([\s\S]*?)\)\s*(RETURNS[\s\S]*?)\bAS\s+(\$[\w]*\$)([\s\S]*?)\4/gi
  let m
  while ((m = re.exec(sql)) !== null) out.push({ nombre: m[1].replace(/"/g, '').toLowerCase(), cabecera: m[3], cuerpo: m[5] })
  return out
}

/** Separa por comas de nivel 0. */
function partes(s) {
  const out = []; let d = 0, start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') d++
    else if (s[i] === ')') d--
    else if (s[i] === ',' && d === 0) { out.push(s.slice(start, i).trim()); start = i + 1 }
  }
  out.push(s.slice(start).trim())
  return out.filter(Boolean)
}

/** GRANT ... ON ... TO ... -> [{ privs: [{ priv, cols }], obj, to, text }] (tambien dentro de EXECUTE '...'). */
export function grants(code) {
  const out = []
  for (const m of code.matchAll(/\bGRANT\s+([^;]*?)\s+ON\s+([^;]*?)\s+TO\s+([^;]*?)(?:;|$)/gi)) {
    const privs = partes(m[1]).map((p) => {
      const mm = /^(\w+(?:\s+PRIVILEGES)?)\s*(?:\(([^)]*)\))?$/i.exec(p.trim())
      return mm ? { priv: mm[1].toUpperCase().replace(/\s+PRIVILEGES$/, ''), cols: mm[2] == null ? null : mm[2].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase()) } : { priv: p.toUpperCase(), cols: null }
    })
    out.push({ privs, obj: m[2].replace(/\s+/g, ' ').trim(), to: m[3], text: one(m[0]) })
  }
  return out
}
const esInventory = (obj) => /^(?:TABLE\s+)?(?:public\.)?"?inventory"?$/i.test(obj)
const esMovs = (obj) => /^(?:TABLE\s+)?(?:public\.)?"?inventory_movements"?$/i.test(obj)
const esTodas = (obj) => /^ALL\s+TABLES\s+IN\s+SCHEMA\b.*\bpublic\b/i.test(obj)

/** GRANTs que devuelven autoridad directa sobre el saldo o el libro. `dinamicoOk` = el GRANT canonico de A3. */
export function grantsProhibidos(code, et, { dinamicoOk = false } = {}) {
  const f = []
  for (const g of grants(code)) {
    if (!API.test(g.to)) continue
    const escribe = (p) => ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'ALL'].includes(p.priv)
    if (esTodas(g.obj) && g.privs.some(escribe)) f.push(`${et}: GRANT de escritura sobre TODAS las tablas de public a la API reabre inventory/inventory_movements (${g.text})`)
    if (esMovs(g.obj) && g.privs.some(escribe)) f.push(`${et}: devuelve escritura sobre inventory_movements a la API (${g.text})`)
    if (esInventory(g.obj)) {
      for (const p of g.privs) {
        if (p.priv === 'ALL') f.push(`${et}: GRANT ALL sobre inventory a la API (reabre stock/stock_quantity) (${g.text})`)
        if (!['INSERT', 'UPDATE'].includes(p.priv)) continue
        if (/\b(?:anon|public|service_role)\b/i.test(g.to)) f.push(`${et}: ${p.priv} sobre inventory a anon/PUBLIC/service_role (P5: anon no obtiene escrituras) (${g.text})`)
        if (p.cols == null) f.push(`${et}: ${p.priv} de TABLA sobre inventory (invalida el cierre por columna de stock/stock_quantity) (${g.text})`)
        else if (p.cols.some((c) => c === 'stock' || c === 'stock_quantity')) f.push(`${et}: devuelve ${p.priv} sobre stock/stock_quantity (${g.text})`)
        else if (p.cols.some((c) => c.includes('%')) && !dinamicoOk) f.push(`${et}: ${p.priv} sobre inventory con lista de columnas dinamica no verificable (${g.text})`)
      }
    }
  }
  return f
}

// ── Contrato de los guards ───────────────────────────────────────────────────
function inspectGuardFn(f, et) {
  const out = [], c = f.cuerpo
  if (!/SECURITY\s+INVOKER/i.test(f.cabecera) || /SECURITY\s+DEFINER/i.test(f.cabecera)) out.push(`${et}: el guard de stock dejo de ser SECURITY INVOKER (un DEFINER ve siempre a postgres y deja pasar a la API)`)
  if (!/SET\s+search_path\s*=\s*pg_catalog\s*,\s*pg_temp\s*$/im.test(f.cabecera)) out.push(`${et}: el guard de stock cambio su search_path (pg_catalog, pg_temp)`)
  if (!/pg_catalog\.pg_has_role\s*\(\s*current_user\s*,\s*'postgres'\s*,\s*'MEMBER'\s*\)/i.test(c)) out.push(`${et}: el guard de stock perdio el contexto canonico (pg_has_role(current_user, 'postgres', 'MEMBER'))`)
  if (/auth\.uid\s*\(/i.test(c)) out.push(`${et}: el guard de stock usa auth.uid() (la autoridad es el ROL de base, no el usuario)`)
  if (!/NEW\.stock\s+IS\s+NOT\s+DISTINCT\s+FROM\s+OLD\.stock\s+AND\s+NEW\.stock_quantity\s+IS\s+NOT\s+DISTINCT\s+FROM\s+OLD\.stock_quantity/i.test(c)) out.push(`${et}: el guard dejo de comparar stock y stock_quantity contra OLD en el UPDATE`)
  if (!/NEW\.stock\s+IS\s+NOT\s+DISTINCT\s+FROM\s+0\s+AND\s+NEW\.stock_quantity\s+IS\s+NOT\s+DISTINCT\s+FROM\s+0/i.test(c)) out.push(`${et}: el guard dejo de exigir saldo 0 en el INSERT de la API`)
  if (!/RAISE\s+EXCEPTION\s+'INVENTORY_STOCK_DIRECT_WRITE_FORBIDDEN[^;]*ERRCODE\s*=\s*'42501'/i.test(c)) out.push(`${et}: el guard dejo de rechazar con 42501`)
  if (/\b(?:GREATEST|LEAST)\s*\(|insuficiente/i.test(c)) out.push(`${et}: el guard clampa o rechaza saldo insuficiente (negativos permitidos)`)
  return out
}

function inspectLedgerFn(f, et) {
  const out = [], c = f.cuerpo
  if (!/SECURITY\s+INVOKER/i.test(f.cabecera) || /SECURITY\s+DEFINER/i.test(f.cabecera)) out.push(`${et}: el append-only dejo de ser SECURITY INVOKER`)
  if (!/SET\s+search_path\s*=\s*pg_catalog\s*,\s*pg_temp\s*$/im.test(f.cabecera)) out.push(`${et}: el append-only cambio su search_path (pg_catalog, pg_temp)`)
  if (!/pg_catalog\.pg_has_role\s*\(\s*current_user\s*,\s*'postgres'\s*,\s*'MEMBER'\s*\)/i.test(c)) out.push(`${et}: el append-only perdio el contexto canonico para el INSERT`)
  if (/auth\.uid\s*\(/i.test(c)) out.push(`${et}: el append-only usa auth.uid()`)
  if (!/IF\s+TG_LEVEL\s*<>\s*'ROW'\s+THEN\s+RAISE\s+EXCEPTION[^;]*42501/i.test(c)) out.push(`${et}: el append-only dejo de rechazar TRUNCATE`)
  if (!/IF\s+TG_OP\s*=\s*'INSERT'\s+THEN\s+IF\s+v_canonical\s+THEN\s+RETURN\s+NEW;\s+END\s+IF;\s+RAISE\s+EXCEPTION[^;]*42501/i.test(c)) out.push(`${et}: el INSERT de movimientos dejo de estar restringido al contexto canonico`)
  const upd = c.match(/IF\s+TG_OP\s*=\s*'UPDATE'\s+THEN([\s\S]*?)END\s+IF;\s*--\s*DELETE|IF\s+TG_OP\s*=\s*'UPDATE'\s+THEN([\s\S]*?)RAISE\s+EXCEPTION/i)
  const u = upd ? (upd[1] ?? upd[2]) : ''
  if (!/v_canonical/.test(u) || !/\(to_jsonb\(NEW\)\s*-\s*c_detach\)\s*=\s*\(to_jsonb\(OLD\)\s*-\s*c_detach\)/i.test(u)
      || !/to_jsonb\(NEW\)\s+IS\s+DISTINCT\s+FROM\s+to_jsonb\(OLD\)/i.test(u)) {
    out.push(`${et}: el UPDATE de movimientos dejo de estar limitado al SET NULL referencial canonico`)
  }
  if (!/c_detach\s+constant\s+text\[\]\s*:=\s*ARRAY\['created_by',\s*'supplier_id',\s*'variant_id',\s*'product_id'\]/i.test(c)) out.push(`${et}: cambiaron las columnas desprendibles (solo las FKs ON DELETE SET NULL: created_by, supplier_id, variant_id, product_id)`)
  if (!/IF\s+v_canonical\s+AND\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.businesses\s+b\s+WHERE\s+b\.id\s*=\s*OLD\.business_id\s*\)\s+THEN\s+RETURN\s+OLD/i.test(c)) out.push(`${et}: el DELETE de movimientos dejo de estar limitado al purge del tenant`)
  if (!/RAISE\s+EXCEPTION\s+'INVENTORY_MOVEMENTS_APPEND_ONLY: DELETE[^;]*42501/i.test(c)) out.push(`${et}: el DELETE de movimientos dejo de rechazarse con 42501`)
  return out
}

function defs(fns, n) { return fns.filter((f) => f.nombre === n) }

// ── Migracion A3 ─────────────────────────────────────────────────────────────
function inspectMigracion(sql) {
  const f = []
  const code = sinComentarios(sql)
  const bare = sinLiterales(code)

  // Fail-closed: transaccion, precondiciones, postcondiciones, NOTICE, snapshots.
  if (!/^\s*BEGIN\s*;/m.test(code) || !/^\s*COMMIT\s*;/m.test(code)) f.push('la migracion perdio su BEGIN/COMMIT explicito')
  for (let n = 0; n <= 13; n++) if (!new RegExp(`'PRECONDICION ${n}:`).test(code)) f.push(`se perdio la PRECONDICION ${n}`)
  const post = new Set([...code.matchAll(/'POSTCONDICION ([P0-9/]+):/g)].flatMap((m) => m[1].split('/')))
  for (let n = 1; n <= 18; n++) if (!post.has(`P${n}`)) f.push(`se perdio la POSTCONDICION P${n}`)
  if (!/RAISE\s+NOTICE\s+'G2-C\.3A3 OK/.test(code)) f.push('se perdio el NOTICE final G2-C.3A3 OK')
  if (!/v_now\.src_md5\s+IS\s+DISTINCT\s+FROM\s+s\.src_md5/.test(code) || !/CREATE\s+TEMP\s+TABLE\s+_g2c3a3_fns/i.test(code)) f.push('las postcondiciones dejaron de comparar el md5 de W1-W7/A1 antes y despues')
  for (const n of [...CANONICOS, ...A1]) {
    if (!new RegExp(`'${esc(n)}\\(`).test(code.slice(code.search(/CREATE\s+TEMP\s+TABLE\s+_g2c3a3_fns/i)))) f.push(`el snapshot md5 no incluye ${n}`)
  }
  if (!/max\(version\)\s+FROM\s+supabase_migrations\.schema_migrations/i.test(code) || !/IS\s+DISTINCT\s+FROM\s+'20261008120000'/.test(code)) f.push('la PRECONDICION 4 dejo de exigir que A1 sea la migracion previa (A2 sin migracion)')
  if (!/INTO\s+STRICT\s+v_name/i.test(code)) f.push('la FK dejo de resolverse dinamicamente desde pg_catalog (INTO STRICT)')

  // A3.1 · cierre del saldo.
  if (!/REVOKE\s+INSERT\s*,\s*UPDATE\s+ON\s+TABLE\s+public\.inventory\s+FROM\s+anon\s*,\s*authenticated\s*;/i.test(code)) f.push('A3.1: falta el REVOKE de INSERT/UPDATE de TABLA sobre inventory a anon/authenticated')
  // El GRANT dinamico solo se acepta con la lista construida en el MISMO bloque, sin stock.
  const bloque = code.match(/DO\s+\$grant\$([\s\S]*?)\$grant\$/)?.[1] ?? ''
  if (!/a\.attname\s+NOT\s+IN\s*\(\s*'stock'\s*,\s*'stock_quantity'\s*\)/i.test(bloque)) f.push('A3.1: la lista de columnas reconstruida ya no excluye stock y stock_quantity')
  if (!/GRANT\s+INSERT\s*\(%s\)\s*,\s*UPDATE\s*\(%s\)\s+ON\s+TABLE\s+public\.inventory\s+TO\s+authenticated'/i.test(bloque)) f.push('A3.1: falta la reconstruccion por columna de INSERT/UPDATE para authenticated')
  if (!/REVOKE\s+INSERT\s*,\s*UPDATE\s+ON\s+TABLE\s+public\.inventory\s+FROM\s+anon\s*,\s*authenticated\s*;[\s\S]*GRANT\s+INSERT\s*\(%s\)/i.test(bloque)) f.push('A3.1: el REVOKE de tabla tiene que ir ANTES de la reconstruccion por columna')
  f.push(...grantsProhibidos(code, 'A3', { dinamicoOk: true }))
  for (const g of grants(code)) {
    if ((esInventory(g.obj) || esMovs(g.obj)) && g.privs.some((p) => ['SELECT', 'REFERENCES', 'TRIGGER'].includes(p.priv))) f.push(`A3 amplia SELECT/REFERENCES/TRIGGER sobre inventory (SEC-08B) (${g.text})`)
    if (new RegExp(`${esc(GUARD_FN)}|${esc(LEDGER_FN)}`, 'i').test(g.obj)) f.push(`A3 concede EXECUTE de un guard (${g.text})`)
  }
  if (/\bREVOKE\s+(?:[^;]*\bSELECT\b)[^;]*\bON\s+(?:TABLE\s+)?public\.inventory(?:_movements)?\b/i.test(code)) f.push('A3 revoca SELECT de inventory/inventory_movements (las lecturas no cambian)')

  const fns = funciones(code)
  const gf = defs(fns, GUARD_FN), lf = defs(fns, LEDGER_FN)
  if (gf.length !== 1) f.push(`la migracion define ${gf.length} veces ${GUARD_FN} (se espera 1)`)
  else f.push(...inspectGuardFn(gf[0], 'guard'))
  if (lf.length !== 1) f.push(`la migracion define ${lf.length} veces ${LEDGER_FN} (se espera 1)`)
  else f.push(...inspectLedgerFn(lf[0], 'append-only'))
  for (const n of [GUARD_FN, LEDGER_FN]) {
    if (!new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${esc(n)}\\(\\)\\s+FROM\\s+PUBLIC\\s*,\\s*anon\\s*,\\s*authenticated\\s*,\\s*service_role\\s*;`, 'i').test(code)) f.push(`${n} perdio el REVOKE de PUBLIC/anon/authenticated/service_role`)
  }
  if (!new RegExp(`CREATE\\s+TRIGGER\\s+${GUARD_TG}\\s+BEFORE\\s+INSERT\\s+OR\\s+UPDATE\\s+ON\\s+public\\.inventory\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+${esc(GUARD_FN)}\\(\\)`, 'i').test(code)) {
    f.push(`A3.1: falta el trigger ${GUARD_TG} BEFORE INSERT OR UPDATE ON public.inventory FOR EACH ROW (el nombre zz_ lo hace el ultimo BEFORE)`)
  }

  // A3.2 · libro append-only.
  if (!/REVOKE\s+INSERT\s*,\s*UPDATE\s*,\s*DELETE\s+ON\s+TABLE\s+public\.inventory_movements\s+FROM\s+[^;]*\bauthenticated\b[^;]*;/i.test(code)) f.push('A3.2: falta el REVOKE de INSERT/UPDATE/DELETE de inventory_movements a authenticated')
  for (const p of WRITE_POLICIES) {
    if (!new RegExp(`DROP\\s+POLICY\\s+${p}\\s+ON\\s+public\\.inventory_movements\\s*;`, 'i').test(code)) f.push(`A3.2: la policy de escritura ${p} sigue viva`)
  }
  for (const m of code.matchAll(/\b(CREATE|ALTER)\s+POLICY\b[^;]*;/gi)) {
    if (/\bON\s+(?:public\.)?inventory(?:_movements)?\b/i.test(m[0])) f.push(`A3 crea/altera una policy de inventory/inventory_movements (P16) (${one(m[0])})`)
  }
  for (const m of code.matchAll(/\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(\w+)\s+ON\s+(?:public\.)?inventory\b(?!_)/gi)) f.push(`A3 borra la policy ${m[1]} de inventory (P16)`)
  for (const m of code.matchAll(/\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(\w+)\s+ON\s+(?:public\.)?inventory_movements\b/gi)) {
    if (!WRITE_POLICIES.includes(m[1])) f.push(`A3 borra la policy ${m[1]} de inventory_movements (la lectura no cambia)`)
  }
  if (!new RegExp(`CREATE\\s+TRIGGER\\s+${LEDGER_TG}\\s+BEFORE\\s+INSERT\\s+OR\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+public\\.inventory_movements\\s+FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+${esc(LEDGER_FN)}\\(\\)`, 'i').test(code)) f.push(`A3.2: falta el trigger ${LEDGER_TG} BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW`)
  if (!new RegExp(`CREATE\\s+TRIGGER\\s+${TRUNC_TG}\\s+BEFORE\\s+TRUNCATE\\s+ON\\s+public\\.inventory_movements\\s+FOR\\s+EACH\\s+STATEMENT\\s+EXECUTE\\s+FUNCTION\\s+${esc(LEDGER_FN)}\\(\\)`, 'i').test(code)) f.push(`A3.2: falta el trigger ${TRUNC_TG} BEFORE TRUNCATE FOR EACH STATEMENT`)

  // A3.3 · FK del historial.
  const fk = code.match(/ADD\s+CONSTRAINT\s+%I\s+FOREIGN\s+KEY\s*\(\s*inventory_item_id\s*\)\s+REFERENCES\s+public\.inventory\s*\(\s*id\s*\)([^']*)'/i)
  if (!fk) f.push('A3.3: falta el ADD CONSTRAINT de la FK inventory_item_id -> inventory(id)')
  else if (!/ON\s+DELETE\s+RESTRICT/i.test(fk[1]) || /ON\s+DELETE\s+(?:CASCADE|SET\s+NULL|SET\s+DEFAULT)/i.test(fk[1])) f.push(`A3.3: la FK del historial no queda ON DELETE RESTRICT (${one(fk[1])})`)
  f.push(...fkProhibida(code, 'A3'))

  // Alcance: W1-W7, A1, SEC-08B, trg_sync, product_variants, CHECK, backfill.
  for (const n of [...CANONICOS, ...A1, ...INTOCABLES]) {
    const re = new RegExp(`\\b(?:CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION|ALTER\\s+FUNCTION|DROP\\s+FUNCTION(?:\\s+IF\\s+EXISTS)?|ON\\s+FUNCTION)\\s+${esc(n)}\\b`, 'i')
    if (re.test(code)) f.push(`A3 modifica ${n} (${[...CANONICOS].includes(n) ? 'writer canonico W1-W7' : A1.includes(n) ? 'A1' : 'SEC-08B / inventario'})`)
  }
  if (new RegExp(`\\b(?:ALTER|DROP)\\s+TABLE[^;]*${esc(A1_TABLA)}|\\bON\\s+(?:TABLE\\s+)?${esc(A1_TABLA)}\\b`, 'i').test(code)) f.push('A3 toca la tabla de idempotencia de A1')
  for (const t of TRIGGERS_PREVIOS) {
    if (new RegExp(`\\b(?:DROP|ALTER)\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${t}\\b|\\b(?:DISABLE|ENABLE\\s+REPLICA|ENABLE\\s+ALWAYS)\\s+TRIGGER\\s+${t}\\b`, 'i').test(code)) f.push(`A3 toca el trigger ${t}`)
  }
  f.push(...checkStock(code, 'A3'))
  if (/\bproduct_variants\b/i.test(bare) || /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM|ALTER\s+TABLE|GRANT|REVOKE|CREATE\s+(?:TRIGGER|POLICY)|DROP)\b[^;']*\bproduct_variants\b/i.test(code)) {
    f.push('A3 mete product_variants en el alcance (variants v2 no es autoridad beta)')
  }
  const dml = /\b(?:UPDATE\s+(?:ONLY\s+)?(?:(?:public|private|auth)\.)?\w+\s+SET\b|INSERT\s+INTO\s+(?:(?:public|private|auth)\.)?\w+|DELETE\s+FROM\s+(?:(?:public|private|auth)\.)?\w+|TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(?:public|private)\.\w+|MERGE\s+INTO)\b/gi
  for (const m of code.matchAll(dml)) f.push(`A3 escribe datos (backfill/reconciliacion prohibida; A3 es cero DML): ${one(m[0])}`)
  if (/session_replication_role|\bDISABLE\s+TRIGGER\b/i.test(code)) f.push('A3 apaga triggers (session_replication_role / DISABLE TRIGGER)')
  if (/\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:public|private)\./i.test(code)) f.push('A3 crea tablas (opening balance / reconciliacion fuera de alcance)')
  return f.map((x) => `${MIG_DIR}/${MIG}: ${x}`)
}

/** CHECK sobre el saldo (el contrato G2-C permite negativos). */
export function checkStock(code, et) {
  const f = []
  for (const m of code.matchAll(/\bCHECK\s*\(([^;]*)/gi)) {
    if (/\(?\s*(?:\w+\.)?stock(?:_quantity)?\s*(?:>=?|<>|!=)\s*/i.test(m[1]) && /\bstock/i.test(m[1].slice(0, 80))) f.push(`${et}: agrega un CHECK sobre el stock (${one(m[0])})`)
  }
  return f
}

/** FK del historial en CASCADE / SET NULL, o borrada sin reponerla. */
export function fkProhibida(code, et) {
  const f = []
  for (const m of code.matchAll(/FOREIGN\s+KEY\s*\(\s*inventory_item_id\s*\)\s+REFERENCES\s+(?:public\.)?inventory\s*\(\s*id\s*\)([^;']*)/gi)) {
    if (/ON\s+DELETE\s+(?:CASCADE|SET\s+NULL|SET\s+DEFAULT)/i.test(m[1])) f.push(`${et}: la FK del historial vuelve a ${one(m[1].match(/ON\s+DELETE\s+\w+(?:\s+\w+)?/i)[0])} (borraria o desprenderia movimientos)`)
  }
  return f
}

// ── Migraciones posteriores ──────────────────────────────────────────────────
function inspectPosteriores(archivos) {
  const f = []
  for (const { nombre, sql } of archivos) {
    if (nombre.split('_')[0] <= VERSION) continue
    const code = sinComentarios(sql)
    f.push(...grantsProhibidos(code, nombre))
    for (const m of code.matchAll(/\bCREATE\s+POLICY\b[^;]*;/gi)) {
      if (!/\bON\s+(?:public\.)?inventory_movements\b/i.test(m[0])) continue
      const cmd = m[0].match(/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i)?.[1]?.toUpperCase() ?? 'ALL'
      if (cmd !== 'SELECT') f.push(`${nombre}: agrega una policy ${cmd} sobre inventory_movements (reabre el libro) (${one(m[0])})`)
    }
    for (const t of [GUARD_TG, LEDGER_TG, TRUNC_TG]) {
      if (new RegExp(`\\bDROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${t}\\b`, 'i').test(code)) f.push(`${nombre}: borra el trigger ${t}`)
    }
    for (const m of code.matchAll(/\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?(inventory|inventory_movements)\b[^;]*;/gi)) {
      if (/\b(?:DISABLE\s+TRIGGER|ENABLE\s+REPLICA\s+TRIGGER)\b/i.test(m[0])) f.push(`${nombre}: deshabilita triggers de ${m[1]} (${one(m[0])})`)
      if (m[1].toLowerCase() === 'inventory_movements' && new RegExp(`DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?${FK}\\b`, 'i').test(m[0])
          && !/ADD\s+CONSTRAINT[^;]*FOREIGN\s+KEY\s*\(\s*inventory_item_id\s*\)/i.test(m[0])) {
        f.push(`${nombre}: borra la FK ${FK} sin reponerla en la misma sentencia`)
      }
      if (m[1].toLowerCase() === 'inventory' && /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(m[0])) f.push(`${nombre}: le quita la RLS a inventory`)
    }
    f.push(...fkProhibida(code, nombre))
    f.push(...checkStock(code, nombre))
    for (const n of [GUARD_FN, LEDGER_FN]) {
      if (new RegExp(`\\bDROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?${esc(n)}\\b`, 'i').test(code)) f.push(`${nombre}: borra ${n}`)
      for (const a of code.matchAll(new RegExp(`\\bALTER\\s+FUNCTION\\s+${esc(n)}\\b[^;]*;`, 'gi'))) {
        if (!/\bOWNER\s+TO\s+postgres\s*;$/i.test(a[0].trim())) f.push(`${nombre}: altera ${n} (${one(a[0])})`)
      }
      for (const g of grants(code)) if (g.obj.toLowerCase().includes(n)) f.push(`${nombre}: concede EXECUTE de ${n}`)
    }
    for (const fn of funciones(code)) {
      if (fn.nombre === GUARD_FN) f.push(...inspectGuardFn(fn, `${nombre}: redefine el guard de stock`))
      if (fn.nombre === LEDGER_FN) f.push(...inspectLedgerFn(fn, `${nombre}: redefine el append-only`))
    }
  }
  return f
}

// ── Evidencia: la suite SQL y la de PostgREST existen y cubren el lote ───────
function inspectEvidencia(st) {
  const f = []
  if (st.testSql == null) return [`${TEST_SQL}: falta la suite SQL de A3`]
  const t = sinComentarios(st.testSql)
  if (!/^\s*BEGIN\s*;/m.test(t) || !/^\s*ROLLBACK\s*;\s*$/m.test(t)) f.push(`${TEST_SQL}: la suite tiene que correr dentro de BEGIN ... ROLLBACK`)
  if (!/SET\s+LOCAL\s+ROLE/i.test(t) || !/request\.jwt\.claim\.sub/.test(t)) f.push(`${TEST_SQL}: la suite ya no ejecuta como la API (SET LOCAL ROLE + request.jwt.claim.sub)`)
  if (!/has_column_privilege\s*\(/i.test(t) || !/has_table_privilege\s*\(/i.test(t)) f.push(`${TEST_SQL}: la suite perdio la matriz has_table_privilege / has_column_privilege`)
  for (let n = 1; n <= 18; n++) if (!new RegExp(`'A${n}\\.\\d`).test(t)) f.push(`${TEST_SQL}: falta el caso A${n}`)
  if (st.testHttp == null) f.push(`${TEST_HTTP}: falta la prueba por PostgREST`)
  return f
}

function run(st) {
  if (st.mig == null) return [`${MIG_DIR}/${MIG}: falta la migracion G2-C.3A3`]
  return [...inspectMigracion(st.mig), ...inspectPosteriores(st.migraciones), ...inspectEvidencia(st)]
}

function load() {
  const nombres = readdirSync(MIG_DIR).filter((n) => /^\d+_.*\.sql$/.test(n)).sort()
  return {
    mig: nombres.includes(MIG) ? read(`${MIG_DIR}/${MIG}`) : null,
    migraciones: nombres.map((nombre) => ({ nombre, sql: read(`${MIG_DIR}/${nombre}`) })),
    testSql: existsSync(TEST_SQL) ? read(TEST_SQL) : null,
    testHttp: existsSync(TEST_HTTP) ? read(TEST_HTTP) : null,
  }
}

function selfTest() {
  const base = load()
  const limpio = run(base)
  if (limpio.length) {
    console.error('SELF-TEST FALLO: el arbol actual ya viola el contrato:')
    limpio.forEach((x) => console.error('  · ' + x))
    process.exit(1)
  }
  const conMig = (st, a, b) => {
    if (!st.mig.includes(a)) return st
    const mig = st.mig.split(a).join(b)
    return { ...st, mig, migraciones: st.migraciones.map((m) => (m.nombre === MIG ? { ...m, sql: mig } : m)) }
  }
  const antesDelCommit = (st, sql) => conMig(st, '\nCOMMIT;\n', `\n${sql}\nCOMMIT;\n`)
  const posterior = (st, sql) => ({ ...st, migraciones: [...st.migraciones, { nombre: '20261099120000_regresion_hipotetica.sql', sql }] })
  const def = (nombre) => {
    const m = base.mig.match(new RegExp(`CREATE FUNCTION ${esc(nombre)}\\(\\)[\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$;`))
    if (!m) throw new Error(`self-test: no encuentro la definicion de ${nombre}`)
    return m[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
  }
  const GUARD_DEF = def(GUARD_FN), LEDGER_DEF = def(LEDGER_FN)
  const conTest = (st, a, b) => (st.testSql.includes(a) ? { ...st, testSql: st.testSql.split(a).join(b) } : st)

  const MUTACIONES = [
    // ── fail-closed ──
    ['falta la migracion', (st) => ({ ...st, mig: null })],
    ['pierde BEGIN/COMMIT', (st) => conMig(st, '\nCOMMIT;\n', '\n')],
    ['pierde una precondicion (ACL)', (st) => conMig(st, "'PRECONDICION 7:", "'NOTA 7:")],
    ['pierde la precondicion de A2 sin migracion', (st) => conMig(st, "IS DISTINCT FROM '20261008120000'", "IS DISTINCT FROM NULL")],
    ['pierde una postcondicion (FK)', (st) => conMig(st, "'POSTCONDICION P13:", "'NOTA P13:")],
    ['pierde la postcondicion de SEC-08B', (st) => conMig(st, "'POSTCONDICION P15:", "'NOTA P15:")],
    ['pierde el NOTICE final', (st) => conMig(st, "RAISE NOTICE 'G2-C.3A3 OK", "RAISE NOTICE 'listo")],
    ['deja de comparar el md5 de los writers', (st) => conMig(st, 'v_now.src_md5 IS DISTINCT FROM s.src_md5', 'false')],
    ['el snapshot md5 deja afuera W7', (st) => conMig(st, "    'public.adjust_stock_on_order_item()',\n    'public.apply_inventory_stock_adjustments_atomic", "    'public.apply_inventory_stock_adjustments_atomic")],
    ['la FK se resuelve por nombre fijo', (st) => conMig(st, 'SELECT c.conname INTO STRICT v_name', 'SELECT c.conname INTO v_name')],
    // ── A3.1 saldo ──
    ['falta el REVOKE de tabla sobre inventory', (st) => conMig(st, '  REVOKE INSERT, UPDATE ON TABLE public.inventory FROM anon, authenticated;\n', '')],
    ['la reconstruccion incluye stock_quantity', (st) => conMig(st, "AND a.attname NOT IN ('stock', 'stock_quantity');", "AND a.attname NOT IN ('stock');")],
    ['falta la reconstruccion por columna', (st) => conMig(st, "EXECUTE format('GRANT INSERT (%s), UPDATE (%s) ON TABLE public.inventory TO authenticated', v_cols, v_cols);", 'NULL;')],
    ['GRANT UPDATE de tabla a authenticated', (st) => antesDelCommit(st, 'GRANT UPDATE ON public.inventory TO authenticated;')],
    ['GRANT UPDATE (stock_quantity)', (st) => antesDelCommit(st, 'GRANT UPDATE (stock_quantity) ON public.inventory TO authenticated;')],
    ['GRANT INSERT (name, stock) por columna', (st) => antesDelCommit(st, 'GRANT INSERT (name, stock) ON TABLE public.inventory TO authenticated;')],
    ['GRANT ALL sobre inventory', (st) => antesDelCommit(st, 'GRANT ALL ON TABLE public.inventory TO authenticated;')],
    ['GRANT de escritura a anon', (st) => antesDelCommit(st, 'GRANT INSERT (name) ON public.inventory TO anon;')],
    ['GRANT UPDATE dentro de EXECUTE', (st) => antesDelCommit(st, "DO $x$ BEGIN EXECUTE 'GRANT UPDATE ON public.inventory TO authenticated'; END $x$;")],
    ['A3 amplia el SELECT (costo)', (st) => antesDelCommit(st, 'GRANT SELECT (cost_price) ON public.inventory TO authenticated;')],
    ['A3 revoca SELECT', (st) => antesDelCommit(st, 'REVOKE SELECT ON public.inventory_movements FROM authenticated;')],
    ['el guard pasa a SECURITY DEFINER', (st) => conMig(st, 'VOLATILE\nSECURITY INVOKER\nSET search_path = pg_catalog, pg_temp\nAS $fn$\nBEGIN\n  -- Metadata', 'VOLATILE\nSECURITY DEFINER\nSET search_path = pg_catalog, pg_temp\nAS $fn$\nBEGIN\n  -- Metadata')],
    ['el guard usa auth.uid()', (st) => conMig(st, "  IF pg_catalog.pg_has_role(current_user, 'postgres', 'MEMBER') THEN\n    RETURN NEW;\n  END IF;\n\n  RAISE EXCEPTION 'INVENTORY_STOCK", "  IF auth.uid() IS NULL OR pg_catalog.pg_has_role(current_user, 'postgres', 'MEMBER') THEN\n    RETURN NEW;\n  END IF;\n\n  RAISE EXCEPTION 'INVENTORY_STOCK")],
    ['el guard pierde el rol canonico', (st) => conMig(st, "  IF pg_catalog.pg_has_role(current_user, 'postgres', 'MEMBER') THEN\n    RETURN NEW;\n  END IF;\n\n  RAISE EXCEPTION 'INVENTORY_STOCK", "  IF current_user <> 'anon' THEN\n    RETURN NEW;\n  END IF;\n\n  RAISE EXCEPTION 'INVENTORY_STOCK")],
    ['el guard ya no compara el UPDATE contra OLD', (st) => conMig(st, 'IF NEW.stock IS NOT DISTINCT FROM OLD.stock AND NEW.stock_quantity IS NOT DISTINCT FROM OLD.stock_quantity THEN', 'IF true THEN')],
    ['el guard deja pasar INSERT con saldo', (st) => conMig(st, 'IF NEW.stock IS NOT DISTINCT FROM 0 AND NEW.stock_quantity IS NOT DISTINCT FROM 0 THEN', 'IF true THEN')],
    ['el guard rechaza sin 42501', (st) => conMig(st, "  RAISE EXCEPTION 'INVENTORY_STOCK_DIRECT_WRITE_FORBIDDEN: % directo de stock/stock_quantity por el rol %', TG_OP, current_user\n    USING ERRCODE = '42501',", "  RAISE EXCEPTION 'INVENTORY_STOCK_DIRECT_WRITE_FORBIDDEN: % directo de stock/stock_quantity por el rol %', TG_OP, current_user\n    USING ERRCODE = 'P0001',")],
    ['el guard no es el ultimo BEFORE (renombrado)', (st) => conMig(st, 'CREATE TRIGGER zz_inventory_stock_authority_guard', 'CREATE TRIGGER aa_inventory_stock_authority_guard')],
    ['el guard solo cubre UPDATE', (st) => conMig(st, '  BEFORE INSERT OR UPDATE ON public.inventory\n', '  BEFORE UPDATE ON public.inventory\n')],
    ['el guard se concede a authenticated', (st) => antesDelCommit(st, 'GRANT EXECUTE ON FUNCTION private.tg_inventory_stock_authority_guard() TO authenticated;')],
    ['el guard pierde su REVOKE', (st) => conMig(st, 'REVOKE ALL ON FUNCTION private.tg_inventory_stock_authority_guard() FROM PUBLIC, anon, authenticated, service_role;', '')],
    // ── A3.2 libro ──
    ['falta el REVOKE sobre inventory_movements', (st) => conMig(st, 'REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory_movements FROM PUBLIC, anon, authenticated, service_role;', '')],
    ['GRANT INSERT sobre inventory_movements', (st) => antesDelCommit(st, 'GRANT INSERT ON public.inventory_movements TO authenticated;')],
    ['la policy de INSERT del libro sigue viva', (st) => conMig(st, 'DROP POLICY inventory_movements_insert ON public.inventory_movements;', '')],
    ['A3 crea una policy de escritura en el libro', (st) => antesDelCommit(st, 'CREATE POLICY p ON public.inventory_movements FOR INSERT TO authenticated WITH CHECK (true);')],
    ['A3 borra la policy de lectura del libro', (st) => antesDelCommit(st, 'DROP POLICY inventory_movements_select ON public.inventory_movements;')],
    ['A3 toca una policy de inventory', (st) => antesDelCommit(st, 'DROP POLICY inventory_update ON public.inventory;')],
    ['el append-only pasa a DEFINER', (st) => conMig(st, "VOLATILE\nSECURITY INVOKER\nSET search_path = pg_catalog, pg_temp\nAS $fn$\nDECLARE\n  c_detach", "VOLATILE\nSECURITY DEFINER\nSET search_path = pg_catalog, pg_temp\nAS $fn$\nDECLARE\n  c_detach")],
    ['el append-only deja insertar a la API', (st) => conMig(st, "  IF TG_OP = 'INSERT' THEN\n    IF v_canonical THEN", "  IF TG_OP = 'INSERT' THEN\n    IF true THEN")],
    ['el append-only deja reescribir', (st) => conMig(st, '       AND (to_jsonb(NEW) - c_detach) = (to_jsonb(OLD) - c_detach)\n', '')],
    ['el append-only amplia las columnas desprendibles', (st) => conMig(st, "ARRAY['created_by', 'supplier_id', 'variant_id', 'product_id']", "ARRAY['created_by', 'supplier_id', 'variant_id', 'product_id', 'quantity']")],
    ['el append-only deja borrar', (st) => conMig(st, '  IF v_canonical AND NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = OLD.business_id) THEN', '  IF v_canonical THEN')],
    ['el append-only deja truncar', (st) => conMig(st, "  IF TG_LEVEL <> 'ROW' THEN\n    RAISE EXCEPTION", "  IF TG_LEVEL <> 'ROW' THEN\n    RETURN NULL;\n    RAISE EXCEPTION")],
    ['falta el trigger de TRUNCATE', (st) => conMig(st, 'CREATE TRIGGER trg_inventory_movements_no_truncate', 'CREATE TRIGGER otro_nombre')],
    ['el trigger del libro no cubre DELETE', (st) => conMig(st, '  BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_movements', '  BEFORE INSERT OR UPDATE ON public.inventory_movements')],
    // ── A3.3 FK ──
    ['la FK queda en CASCADE', (st) => conMig(st, 'ON UPDATE NO ACTION ON DELETE RESTRICT', 'ON UPDATE NO ACTION ON DELETE CASCADE')],
    ['la FK queda en SET NULL', (st) => conMig(st, 'ON UPDATE NO ACTION ON DELETE RESTRICT', 'ON UPDATE NO ACTION ON DELETE SET NULL')],
    ['la FK no se re-crea', (st) => conMig(st, "'ADD CONSTRAINT %I FOREIGN KEY (inventory_item_id)", "'VALIDATE CONSTRAINT %I -- (inventory_item_id)")],
    // ── alcance ──
    ['A3 redefine W7', (st) => antesDelCommit(st, 'CREATE OR REPLACE FUNCTION public.adjust_stock_on_order_item() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RETURN NEW; END $x$;')],
    ['A3 altera W1', (st) => antesDelCommit(st, 'ALTER FUNCTION private.create_comprobante_checkout_atomic(uuid, text, text, jsonb) SECURITY INVOKER;')],
    ['A3 altera A1', (st) => antesDelCommit(st, 'ALTER FUNCTION public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text) SECURITY INVOKER;')],
    ['A3 concede A1 a anon', (st) => antesDelCommit(st, 'GRANT EXECUTE ON FUNCTION public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text) TO anon;')],
    ['A3 toca la tabla de A1', (st) => antesDelCommit(st, 'ALTER TABLE private.inventory_stock_adjustment_requests DISABLE ROW LEVEL SECURITY;')],
    ['A3 toca el guard de costo (SEC-08B)', (st) => antesDelCommit(st, 'DROP TRIGGER trig_inventory_guard_cost_write ON public.inventory;')],
    ['A3 deshabilita trg_sync_inventory_stock', (st) => antesDelCommit(st, 'ALTER TABLE public.inventory DISABLE TRIGGER trg_sync_inventory_stock;')],
    ['A3 agrega CHECK stock >= 0', (st) => antesDelCommit(st, 'ALTER TABLE public.inventory ADD CONSTRAINT inventory_stock_nonneg CHECK (stock_quantity >= 0);')],
    ['A3 hace backfill del alias', (st) => antesDelCommit(st, 'UPDATE public.inventory SET stock = stock_quantity WHERE stock IS DISTINCT FROM stock_quantity;')],
    ['A3 reconcilia historia', (st) => antesDelCommit(st, "INSERT INTO public.inventory_movements (business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock) SELECT business_id, id, 'adjustment', stock_quantity, 0, stock_quantity FROM public.inventory WHERE stock_quantity <> 0;")],
    ['A3 crea una tabla de opening balance', (st) => antesDelCommit(st, 'CREATE TABLE public.inventory_opening_balances (id uuid PRIMARY KEY);')],
    ['A3 apaga triggers', (st) => antesDelCommit(st, "SET LOCAL session_replication_role = 'replica';")],
    ['A3 mete product_variants', (st) => antesDelCommit(st, 'REVOKE UPDATE (stock) ON public.product_variants FROM authenticated;')],
    // ── posteriores ──
    ['posterior: GRANT UPDATE de tabla sobre inventory', (st) => posterior(st, 'GRANT UPDATE ON public.inventory TO authenticated;')],
    ['posterior: GRANT SELECT, INSERT, UPDATE de tabla', (st) => posterior(st, 'GRANT SELECT, INSERT, UPDATE ON TABLE public.inventory TO authenticated;')],
    ['posterior: GRANT UPDATE (stock)', (st) => posterior(st, 'GRANT UPDATE (name, stock) ON public.inventory TO authenticated;')],
    ['posterior: GRANT con columnas dinamicas', (st) => posterior(st, "DO $x$ BEGIN EXECUTE format('GRANT UPDATE (%s) ON public.inventory TO authenticated', 'x'); END $x$;")],
    ['posterior: GRANT ALL ON ALL TABLES', (st) => posterior(st, 'GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;')],
    ['posterior: GRANT INSERT sobre el libro', (st) => posterior(st, 'GRANT INSERT ON public.inventory_movements TO authenticated;')],
    ['posterior: policy ALL sobre el libro (FOR implicito)', (st) => posterior(st, 'CREATE POLICY p ON public.inventory_movements TO authenticated USING (true);')],
    ['posterior: policy DELETE sobre el libro', (st) => posterior(st, 'CREATE POLICY p ON public.inventory_movements FOR DELETE TO authenticated USING (true);')],
    ['posterior: borra el guard de stock', (st) => posterior(st, 'DROP TRIGGER IF EXISTS zz_inventory_stock_authority_guard ON public.inventory;')],
    ['posterior: deshabilita el append-only', (st) => posterior(st, 'ALTER TABLE public.inventory_movements DISABLE TRIGGER trg_inventory_movements_append_only;')],
    ['posterior: DISABLE TRIGGER ALL en inventory', (st) => posterior(st, 'ALTER TABLE ONLY public.inventory DISABLE TRIGGER ALL;')],
    ['posterior: FK vuelve a CASCADE', (st) => posterior(st, 'ALTER TABLE public.inventory_movements DROP CONSTRAINT inventory_movements_inventory_item_id_fkey, ADD CONSTRAINT inventory_movements_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES public.inventory(id) ON DELETE CASCADE;')],
    ['posterior: borra la FK', (st) => posterior(st, 'ALTER TABLE public.inventory_movements DROP CONSTRAINT inventory_movements_inventory_item_id_fkey;')],
    ['posterior: CHECK stock >= 0', (st) => posterior(st, 'ALTER TABLE public.inventory ADD CONSTRAINT c CHECK (stock >= 0);')],
    ['posterior: borra el append-only', (st) => posterior(st, 'DROP FUNCTION private.tg_inventory_movements_append_only();')],
    ['posterior: el guard pasa a DEFINER', (st) => posterior(st, 'ALTER FUNCTION private.tg_inventory_stock_authority_guard() SECURITY DEFINER;')],
    ['posterior: redefine el guard sin rol canonico', (st) => posterior(st, GUARD_DEF.replace("IF pg_catalog.pg_has_role(current_user, 'postgres', 'MEMBER') THEN", 'IF true THEN'))],
    ['posterior: redefine el append-only dejando reescribir', (st) => posterior(st, LEDGER_DEF.replace('       AND (to_jsonb(NEW) - c_detach) = (to_jsonb(OLD) - c_detach)\n', ''))],
    // ── evidencia ──
    ['falta la suite SQL', (st) => ({ ...st, testSql: null })],
    ['la suite ya no corre como la API', (st) => conTest(conTest(st, "EXECUTE format('SET LOCAL ROLE %I', p_role);", 'NULL;'), "EXECUTE 'SET LOCAL ROLE authenticated';", 'NULL;')],
    ['la suite pierde el caso A13', (st) => conTest(st, "'A13.", "'X13.")],
    ['falta la prueba por PostgREST', (st) => ({ ...st, testHttp: null })],
  ]

  const CONTROLES = [
    ['posterior: GRANT INSERT/UPDATE de una columna NUEVA de metadata', (st) => posterior(st, 'GRANT INSERT (portal_badge), UPDATE (portal_badge) ON public.inventory TO authenticated;')],
    ['posterior: GRANT SELECT de una columna', (st) => posterior(st, 'GRANT SELECT (portal_badge) ON public.inventory TO authenticated, anon;')],
    ['posterior: policy SELECT sobre el libro', (st) => posterior(st, 'CREATE POLICY p ON public.inventory_movements FOR SELECT TO authenticated USING (false);')],
    ['posterior: redefine el guard con el MISMO contrato', (st) => posterior(st, `${GUARD_DEF}\n\n${LEDGER_DEF}`)],
    ['posterior: reafirma el owner del guard', (st) => posterior(st, 'ALTER FUNCTION private.tg_inventory_stock_authority_guard() OWNER TO postgres;')],
    ['posterior: re-crea la FK en RESTRICT', (st) => posterior(st, 'ALTER TABLE public.inventory_movements DROP CONSTRAINT inventory_movements_inventory_item_id_fkey, ADD CONSTRAINT inventory_movements_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES public.inventory(id) ON DELETE RESTRICT;')],
    ['un comentario posterior menciona GRANT UPDATE ON public.inventory', (st) => posterior(st, '-- nunca: GRANT UPDATE ON public.inventory TO authenticated;\nSELECT 1;')],
    ['un RAISE de A3 menciona CHECK stock >= 0', (st) => conMig(st, "'PRECONDICION 5: existe un CHECK sobre el stock de inventory (el contrato G2-C permite negativos)'", "'PRECONDICION 5: existe un CHECK sobre el stock de inventory (nada de CHECK stock >= 0: negativos permitidos)'")],
  ]

  let fallos = 0
  for (const [nombre, mutar] of MUTACIONES) {
    const mutado = mutar(base)
    if (JSON.stringify(mutado) === JSON.stringify(base)) { console.error(`  ✖ ${nombre}: la mutacion NO aplico (el patron cambio) — el self-test estaria mintiendo`); fallos++; continue }
    const r = run(mutado)
    if (r.length === 0) { console.error(`  ✖ ${nombre}: NO detectado`); fallos++ } else console.log(`  ✔ ${nombre}: detectado`)
  }
  for (const [nombre, mutar] of CONTROLES) {
    const mutado = mutar(base)
    if (JSON.stringify(mutado) === JSON.stringify(base)) { console.error(`  ✖ control "${nombre}": no aplico`); fallos++; continue }
    const r = run(mutado)
    if (r.length) { console.error(`  ✖ control "${nombre}": falso positivo -> ${r[0]}`); fallos++ } else console.log(`  ✔ control "${nombre}": no se marca (correcto)`)
  }
  if (fallos) { console.error(`SELF-TEST FALLO: ${fallos} mutacion(es)/control(es) fallido(s).`); process.exit(1) }
  console.log(`SELF-TEST OK: las ${MUTACIONES.length} mutaciones del contrato G2-C.3A3 son detectadas y los ${CONTROLES.length} controles no dan falso positivo.`)
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const findings = run(load())
  if (findings.length) {
    console.error('GUARD G2-C.3A3 FALLO:')
    findings.forEach((x) => console.error('  · ' + x))
    process.exit(1)
  }
  console.log('GUARD G2-C.3A3 OK · inventory: INSERT/UPDATE de tabla revocados a anon/authenticated, authenticated por columna sin stock/stock_quantity, '
    + 'guard INVOKER zz_ (rol canonico, 42501, sin auth.uid) · inventory_movements: sin escritura de API ni policies de escritura, append-only '
    + '(INSERT canonico; UPDATE/DELETE/TRUNCATE -> 42501 salvo SET NULL/CASCADE referenciales) · FK del historial ON DELETE RESTRICT · '
    + 'fail-closed (PRECONDICION 0-13, POSTCONDICION P1-P18, md5 de W1-W7/A1) · sin W1-W7/A1/SEC-08B/product_variants/CHECK/backfill · '
    + 'ninguna migracion posterior lo reabre · suites SQL y PostgREST presentes.')
}
