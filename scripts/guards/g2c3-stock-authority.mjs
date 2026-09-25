#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// G2-C.3 · Guard de la autoridad canonica de stock.
//
// G2-C.3A1 agrega UNA autoridad server-side para el stock que no nace de un
// documento (stock inicial, import/conteo, ajuste manual):
//   public.apply_inventory_stock_adjustments_atomic  (wrapper DEFINER, authenticated)
//   private.apply_inventory_stock_adjustments_impl   (INVOKER, sin EXECUTE de API)
//   private.inventory_stock_adjustment_requests      (idempotencia, sin acceso de API)
//
// La matriz SQL y la de concurrencia prueban el COMPORTAMIENTO sobre una base
// viva. Este guard cubre el FUTURO: que una migracion posterior redefina la RPC
// sin su contrato, la exponga, le saque la idempotencia o el lock, o que A1 deje
// de ser aditivo.
//
// Invariantes (A1 = contrato DB solamente):
//   1. La migracion A1 existe, es transaccional y fail-closed (precondiciones,
//      incluida la del helper de lock G2-C.2; postcondiciones; NOTICE final).
//   2. Wrapper: SECURITY DEFINER, search_path pg_catalog/pg_temp, exige auth.uid()
//      y private.has_action_authority(p_business_id, 'inventory') ANTES de llamar
//      al impl; no escribe tablas.
//   3. Impl: SECURITY INVOKER, search_path pg_catalog/pg_temp, y en este orden:
//      reserva idempotente (INSERT ... ON CONFLICT sobre el UNIQUE) -> lock
//      canonico private.lock_inventory_rows con conteo exacto (42501) -> UPDATE
//      de stock -> INSERT de movimiento. Hash server-side (sha256); conflicto
//      explicito; replay = respuesta persistida. Sin FOR UPDATE de inventory, sin
//      GREATEST/LEAST ni "stock insuficiente", sin UPDATE/DELETE de movimientos
//      ni DELETE de productos, todo acotado por business_id, y todo UPDATE de
//      stock escribe stock_quantity + alias y va seguido de su movimiento.
//   4. ACL: wrapper sin PUBLIC/anon/service_role y con authenticated; impl y
//      tabla de requests sin ningun privilegio de API; tabla con UNIQUE
//      (business_id, idempotency_key) y RLS.
//   5. A1 es ADITIVO: no redefine los 7 writers documentales ni toca grants,
//      policies, triggers o columnas de inventory / inventory_movements.
//   6. Ninguna migracion posterior redefine la RPC sin el contrato, la borra,
//      la expone, concede la tabla, le quita RLS, ni borra el helper de lock.
//
// LIMITE HONESTO (A1). Este guard NO prohibe todavia las escrituras de stock
// desde el navegador (registerMovement, import de Excel, altas con stock,
// inventory_movements desde la API): el frontend migra en G2-C.3A2 y los
// privilegios se revocan en G2-C.3A3. A2 amplia este guard.
//
// `--self-test` muta cada invariante en memoria y exige que el guard lo detecte.
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync } from 'node:fs'

const MIG_DIR = 'supabase/migrations'
const VERSION = '20261008120000'
const MIG = `${VERSION}_g2c3a1_inventory_stock_adjustments.sql`
const MIG_G2C2 = '20261006120000_g2c2_inventory_concurrency_locks.sql'

const WRAPPER = 'public.apply_inventory_stock_adjustments_atomic'
const IMPL = 'private.apply_inventory_stock_adjustments_impl'
const TABLA = 'private.inventory_stock_adjustment_requests'
const TIPOS = 'uuid,jsonb,text,text,text'

// Writers documentales canonicos (G2-C.2): A1 no los redefine.
const CANONICOS = [
  'private.create_comprobante_checkout_atomic',
  'private.create_quick_inventory_purchase_atomic',
  'private.sec08e_annul_comprobante_impl',
  'private.create_supplier_purchase_atomic',
  'public.delete_supplier_purchase_safe',
  'public.repair_missing_stock_movements',
  'public.adjust_stock_on_order_item',
]

const read = (p) => readFileSync(p, 'utf8')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const pos = (s, re) => { const m = s.search(re); return m < 0 ? Infinity : m }

function sinComentarios(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.slice(i, i + 2) === '--') { const f = sql.indexOf('\n', i); const e = f === -1 ? sql.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (sql.slice(i, i + 2) === '/*') { const f = sql.indexOf('*/', i + 2); const e = f === -1 ? sql.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += sql[i]; i++
  }
  return out
}

/** Funciones definidas en un archivo: [{ nombre, tipos, cabecera, cuerpo }]. */
function funciones(sql) {
  const out = []
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\(([\s\S]*?)\)\s*(RETURNS[\s\S]*?)\bAS\s+(\$[\w]*\$)([\s\S]*?)\4/gi
  let m
  while ((m = re.exec(sql)) !== null) {
    const tipos = m[2].split(',').map((a) => a.trim().split(/\s+/).pop().toLowerCase()).filter(Boolean).join(',')
    out.push({ nombre: m[1].replace(/"/g, '').toLowerCase(), tipos, cabecera: m[3], cuerpo: m[5] })
  }
  return out
}

// ── Contrato del wrapper ─────────────────────────────────────────────────────
function inspectWrapper(f, et) {
  const out = []
  const c = f.cuerpo
  if (f.tipos !== TIPOS) out.push(`${et}: el wrapper cambio de firma (${f.tipos})`)
  if (!/SECURITY\s+DEFINER/i.test(f.cabecera)) out.push(`${et}: el wrapper dejo de ser SECURITY DEFINER`)
  if (!/SET\s+search_path\s*=\s*pg_catalog\s*,\s*pg_temp\s*$/im.test(f.cabecera)) out.push(`${et}: el wrapper cambio su search_path (pg_catalog, pg_temp)`)
  if (!/auth\.uid\(\)\s+IS\s+NULL\s+THEN\s+RAISE\s+EXCEPTION\s+'[^']*'\s+USING\s+ERRCODE\s*=\s*'42501'/i.test(c)) {
    out.push(`${et}: el wrapper dejo de exigir un actor autenticado (auth.uid() IS NULL -> 42501)`)
  }
  const auth = /IF\s+private\.has_action_authority\s*\(\s*p_business_id\s*,\s*'inventory'\s*,[^;]*?\)\s+IS\s+NOT\s+TRUE\s+THEN\s+RAISE\s+EXCEPTION\s+'[^']*'\s+USING\s+ERRCODE\s*=\s*'42501'/i
  if (!auth.test(c)) out.push(`${et}: el wrapper perdio la autoridad inventory del tenant (has_action_authority(p_business_id, 'inventory') -> 42501)`)
  const impl = pos(c, new RegExp(`${esc(IMPL)}\\s*\\(`, 'i'))
  if (impl === Infinity) out.push(`${et}: el wrapper ya no delega en ${IMPL}`)
  else if (pos(c, auth) > impl) out.push(`${et}: el wrapper llama al impl ANTES de resolver la autoridad`)
  if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public|private)\./i.test(c)) out.push(`${et}: el wrapper escribe tablas (la mutacion vive solo en el impl)`)
  return out
}

// ── Contrato del impl ────────────────────────────────────────────────────────
const RE_RESERVA = new RegExp(`INSERT\\s+INTO\\s+${esc(TABLA)}\\b[\\s\\S]*?ON\\s+CONFLICT\\s*\\(\\s*business_id\\s*,\\s*idempotency_key\\s*\\)\\s*DO\\s+NOTHING`, 'i')
const RE_LOCK = /private\.lock_inventory_rows\s*\(\s*p_business_id\s*,/i
const RE_UPD_STOCK = /UPDATE\s+public\.inventory\b(?!_)[^;]*?\bSET\b[^;]*;/gi
const RE_MOV = /INSERT\s+INTO\s+public\.inventory_movements\b(?!_)/gi

/** Sentencias que bloquean INVENTORY con FOR UPDATE (el modo que choca con el KEY SHARE de las FK). */
export function lockInventarioForUpdate(cuerpo) {
  return cuerpo.split(/;|\bLOOP\b|\bTHEN\b|\bELSE\b|\bBEGIN\b/i)
    .filter((st) => /\bFROM\s+(?:public\.)?inventory\b(?!_)/i.test(st) && /\bFOR\s+UPDATE\b/i.test(st))
    .map((st) => st.replace(/\s+/g, ' ').trim().slice(0, 120))
}

function inspectImpl(f, et) {
  const out = []
  const c = f.cuerpo
  if (f.tipos !== TIPOS) out.push(`${et}: el impl cambio de firma (${f.tipos})`)
  if (!/SECURITY\s+INVOKER/i.test(f.cabecera) || /SECURITY\s+DEFINER/i.test(f.cabecera)) out.push(`${et}: el impl dejo de ser SECURITY INVOKER (solo corre dentro del wrapper)`)
  if (!/SET\s+search_path\s*=\s*pg_catalog\s*,\s*pg_temp\s*$/im.test(f.cabecera)) out.push(`${et}: el impl cambio su search_path (pg_catalog, pg_temp)`)

  // Idempotencia server-side.
  if (!RE_RESERVA.test(c)) out.push(`${et}: el impl perdio la reserva idempotente (INSERT ... ON CONFLICT (business_id, idempotency_key) DO NOTHING)`)
  if (!/\bIS\s+DISTINCT\s+FROM\s+v_hash\s+THEN\s+RAISE\s+EXCEPTION\s+'IDEMPOTENCY_CONFLICT/i.test(c)) out.push(`${et}: el impl dejo de rechazar una clave reutilizada con otro payload (IDEMPOTENCY_CONFLICT)`)
  if (!/v_hash\s*:=\s*encode\s*\(\s*pg_catalog\.sha256\s*\(/i.test(c)) out.push(`${et}: el hash de idempotencia dejo de calcularse en el servidor (sha256)`)
  if (/hash/i.test(f.tipos)) out.push(`${et}: el impl recibe un hash del cliente`)
  if (!/RETURN\s+\w+\s*\|\|\s*jsonb_build_object\s*\(\s*'status'\s*,\s*'existing'\s*\)/i.test(c)) out.push(`${et}: el replay dejo de devolver la respuesta persistida`)
  if (!new RegExp(`UPDATE\\s+${esc(TABLA)}\\s+SET\\s+status\\s*=\\s*'completed'\\s*,\\s*response\\s*=`, 'i').test(c)) out.push(`${et}: la respuesta dejo de persistirse en la request`)

  // Lock canonico con conteo exacto.
  if (!RE_LOCK.test(c)) out.push(`${et}: el impl no toma el lock canonico private.lock_inventory_rows(p_business_id, ...)`)
  else if (!/lock_inventory_rows\s*\([^;]*\)\s*;\s*IF\s+\w+\s*<>\s*v_n\s+THEN\s+RAISE\s+EXCEPTION\s+'[^']*'[^;]*ERRCODE\s*=\s*'42501'/i.test(c)) {
    out.push(`${et}: el lock perdio el conteo exacto (productos de otro negocio o inexistentes -> 42501)`)
  }
  if (/private\.lock_inventory_rows\s*\(\s*NULL\b/i.test(c)) out.push(`${et}: el impl llama al helper sin tenant`)
  const updates = [...c.matchAll(RE_UPD_STOCK)].filter((m) => /\bstock(?:_quantity)?\s*=/i.test(m[0]))
  const movs = [...c.matchAll(RE_MOV)].map((m) => m.index)
  const pReserva = pos(c, RE_RESERVA), pLock = pos(c, RE_LOCK)
  if (!updates.length) out.push(`${et}: el impl no escribe stock`)
  if (updates.length && !(pReserva < pLock && pLock < updates[0].index)) out.push(`${et}: el orden dejo de ser idempotencia -> lock -> UPDATE de stock`)

  // Todo UPDATE de stock: tenant, stock + alias, y su movimiento antes del siguiente UPDATE.
  if (updates.length !== movs.length) out.push(`${et}: ${updates.length} UPDATE(s) de stock y ${movs.length} INSERT(s) de movimiento: hay stock sin movimiento`)
  updates.forEach((u, i) => {
    const fin = i + 1 < updates.length ? updates[i + 1].index : c.length
    if (!movs.some((m) => m > u.index && m < fin)) out.push(`${et}: un UPDATE de stock no va seguido de su INSERT en inventory_movements`)
    if (!/\bstock_quantity\s*=/i.test(u[0]) || !/[\s,]stock\s*=/i.test(u[0])) out.push(`${et}: un UPDATE de stock no escribe stock_quantity y el alias stock juntos`)
    if (!/\bbusiness_id\s*=\s*p_business_id\b/i.test(u[0])) out.push(`${et}: un UPDATE de stock no esta acotado por business_id`)
  })
  for (const st of c.split(';')) {
    if (/\bFROM\s+public\.inventory\b(?!_)/i.test(st) && !/\bbusiness_id\s*=\s*p_business_id\b/i.test(st)) {
      out.push(`${et}: una lectura de inventory no esta acotada por business_id: ${st.replace(/\s+/g, ' ').trim().slice(0, 90)}`)
    }
  }

  // Contrato G2-C / G2-C.2R y libro append-only.
  for (const st of lockInventarioForUpdate(c)) out.push(`${et}: bloquea inventory con FOR UPDATE (debe ser el helper FOR NO KEY UPDATE): ${st}`)
  if (/\b(?:GREATEST|LEAST)\s*\(/i.test(c)) out.push(`${et}: el impl clampa el stock (GREATEST/LEAST): el contrato G2-C permite negativos`)
  if (/insuficiente/i.test(c)) out.push(`${et}: el impl rechaza "stock insuficiente": el contrato G2-C permite negativos`)
  if (/\b(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?inventory_movements\b/i.test(c)) out.push(`${et}: el impl reescribe o borra movimientos (el libro es append-only)`)
  if (/\bDELETE\s+FROM\s+(?:public\.)?inventory\b(?!_)/i.test(c)) out.push(`${et}: el impl borra productos`)
  return out
}

function defs(fns, nombre) { return fns.filter((f) => f.nombre === nombre) }

// ── Migracion A1 ─────────────────────────────────────────────────────────────
function inspectMigracion(sql) {
  const f = []
  const s = sinComentarios(sql)
  if (!/^\s*BEGIN\s*;/m.test(s) || !/^\s*COMMIT\s*;/m.test(s)) f.push('la migracion perdio su BEGIN/COMMIT explicito (las migraciones corren en autocommit)')
  for (let n = 1; n <= 11; n++) if (!new RegExp(`PRECONDICION ${n}:`).test(s)) f.push(`se perdio la PRECONDICION ${n}`)
  for (let n = 1; n <= 9; n++) if (!new RegExp(`POSTCONDICION ${n}:`).test(s)) f.push(`se perdio la POSTCONDICION ${n}`)
  if (!/RAISE\s+NOTICE\s+'G2-C\.3A1 OK/.test(s)) f.push('se perdio el NOTICE final G2-C.3A1 OK')
  if (!/:=\s*to_regprocedure\('private\.lock_inventory_rows\(uuid,uuid\[\]\)'\)[\s\S]{0,400}?IS\s+NULL\s+THEN\s+RAISE\s+EXCEPTION\s+'PRECONDICION 1:/.test(s)) {
    f.push('la PRECONDICION 1 ya no aborta si falta el helper de lock G2-C.2')
  }
  if (!/v_now\.src_md5\s+IS\s+DISTINCT\s+FROM\s+s\.src_md5/.test(s) || !/_g2c3a1_acl/.test(s)) {
    f.push('las postcondiciones dejaron de probar que los writers W1-W7 y los grants de inventario quedaron intactos')
  }

  const fns = funciones(s)
  const w = defs(fns, WRAPPER), im = defs(fns, IMPL)
  if (w.length !== 1) f.push(`la migracion define ${w.length} veces ${WRAPPER} (se espera 1)`)
  else f.push(...inspectWrapper(w[0], 'wrapper'))
  if (im.length !== 1) f.push(`la migracion define ${im.length} veces ${IMPL} (se espera 1)`)
  else f.push(...inspectImpl(im[0], 'impl'))

  // ACL.
  const firma = (n) => `${esc(n)}\\s*\\(\\s*uuid\\s*,\\s*jsonb\\s*,\\s*text\\s*,\\s*text\\s*,\\s*text\\s*\\)`
  if (!new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${firma(WRAPPER)}\\s+FROM\\s+PUBLIC\\s*,\\s*anon\\s*,\\s*service_role\\s*;`, 'i').test(s)) {
    f.push('el wrapper perdio el REVOKE de PUBLIC/anon/service_role')
  }
  if (!new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${firma(WRAPPER)}\\s+TO\\s+authenticated\\s*;`, 'i').test(s)) f.push('el wrapper perdio el GRANT EXECUTE a authenticated')
  if (!new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${firma(IMPL)}\\s+FROM\\s+PUBLIC\\s*,\\s*anon\\s*,\\s*authenticated\\s*,\\s*service_role\\s*;`, 'i').test(s)) {
    f.push('el impl perdio el REVOKE de PUBLIC/anon/authenticated/service_role')
  }
  f.push(...grantsProhibidos(s, 'la migracion A1'))

  // Tabla de requests.
  const tabla = s.match(new RegExp(`CREATE\\s+TABLE\\s+${esc(TABLA)}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i'))
  if (!tabla) f.push(`la migracion ya no crea ${TABLA}`)
  else if (!/UNIQUE\s*\(\s*business_id\s*,\s*idempotency_key\s*\)/i.test(tabla[1])) f.push('la tabla de requests perdio el UNIQUE (business_id, idempotency_key)')
  if (!new RegExp(`ALTER\\s+TABLE\\s+${esc(TABLA)}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(s)) f.push('la tabla de requests perdio la RLS')
  if (!new RegExp(`REVOKE\\s+ALL\\s+ON\\s+${esc(TABLA)}\\s+FROM\\s+PUBLIC\\s*,\\s*anon\\s*,\\s*authenticated\\s*,\\s*service_role\\s*;`, 'i').test(s)) {
    f.push('la tabla de requests perdio el REVOKE de PUBLIC/anon/authenticated/service_role')
  }

  // A1 es ADITIVO.
  for (const fn of fns) {
    if (CANONICOS.includes(fn.nombre)) f.push(`A1 redefine el writer canonico ${fn.nombre} (A1 es aditivo)`)
  }
  if (/\b(?:GRANT|REVOKE)\b[^;]*\bON\s+(?:TABLE\s+)?public\.inventory(?:_movements)?\b(?!_)/i.test(s)) f.push('A1 toca grants de inventory/inventory_movements (eso es A3)')
  if (/\b(?:CREATE|DROP|ALTER)\s+POLICY\b[^;]*\bON\s+public\.inventory(?:_movements)?\b(?!_)/i.test(s)) f.push('A1 toca policies de inventory/inventory_movements')
  if (/\b(?:CREATE|DROP)\s+TRIGGER\b[^;]*\bON\s+public\.inventory(?:_movements)?\b(?!_)/i.test(s)) f.push('A1 toca triggers de inventory/inventory_movements (el guard de stock es A3)')
  if (/\bALTER\s+TABLE\s+(?:ONLY\s+)?public\.inventory(?:_movements)?\b(?!_)/i.test(s)) f.push('A1 altera inventory/inventory_movements')
  return f.map((x) => `${MIG_DIR}/${MIG}: ${x}`)
}

/** GRANT que abren la RPC, el impl o la tabla de requests (A1 y toda migracion posterior). */
function grantsProhibidos(s, et) {
  const f = []
  for (const g of s.matchAll(/GRANT\b[^;]*;/gi)) {
    const st = g[0]
    if (new RegExp(`${esc(WRAPPER)}\\b`, 'i').test(st) && /\bTO\b[^;]*\b(?:anon|public|service_role)\b/i.test(st)) f.push(`${et}: concede EXECUTE del wrapper a anon/PUBLIC/service_role`)
    if (new RegExp(`${esc(IMPL)}\\b`, 'i').test(st)) f.push(`${et}: concede privilegios sobre el impl privado`)
    if (new RegExp(`${esc(TABLA)}\\b`, 'i').test(st)) f.push(`${et}: concede privilegios sobre la tabla de requests`)
    if (/\bON\s+SCHEMA\s+private\b/i.test(st) && /\bTO\b[^;]*\b(?:anon|authenticated|public)\b/i.test(st)) f.push(`${et}: abre el schema private a la API`)
  }
  return f
}

// ── Migraciones posteriores ──────────────────────────────────────────────────
function inspectPosteriores(archivos) {
  const f = []
  for (const { nombre, sql } of archivos) {
    if (nombre.split('_')[0] <= VERSION) continue
    const s = sinComentarios(sql)
    for (const fn of funciones(s)) {
      if (fn.nombre === WRAPPER) f.push(...inspectWrapper(fn, `${nombre}: redefine el wrapper`))
      if (fn.nombre === IMPL) f.push(...inspectImpl(fn, `${nombre}: redefine el impl`))
    }
    f.push(...grantsProhibidos(s, nombre))
    if (new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?(?:${esc(WRAPPER)}|${esc(IMPL)})\\b`, 'i').test(s)) f.push(`${nombre}: borra la autoridad de ajustes de stock`)
    if (new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${esc(TABLA)}\\b`, 'i').test(s)) f.push(`${nombre}: borra la tabla de idempotencia`)
    if (new RegExp(`ALTER\\s+TABLE\\s+${esc(TABLA)}\\s+(?:DISABLE\\s+ROW\\s+LEVEL\\s+SECURITY|DROP\\s+CONSTRAINT\\s+inventory_stock_adjustment_requests_key_uq)`, 'i').test(s)) {
      f.push(`${nombre}: le quita la RLS o el UNIQUE a la tabla de idempotencia`)
    }
    if (new RegExp(`CREATE\\s+POLICY\\b[^;]*\\bON\\s+${esc(TABLA)}\\b`, 'i').test(s)) f.push(`${nombre}: agrega una policy a la tabla de idempotencia (debe ser solo-RPC)`)
    for (const a of s.matchAll(new RegExp(`ALTER\\s+FUNCTION\\s+(?:${esc(WRAPPER)}|${esc(IMPL)})\\b[^;]*;`, 'gi'))) {
      if (!/\bOWNER\s+TO\s+postgres\s*;$/i.test(a[0].trim())) f.push(`${nombre}: altera la autoridad de ajustes (${a[0].replace(/\s+/g, ' ').slice(0, 90)})`)
    }
    if (/DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?private\.lock_inventory_rows\b/i.test(s)) f.push(`${nombre}: borra el helper de lock canonico (G2-C.2)`)
  }
  return f
}

function run(st) {
  if (st.mig == null) return [`${MIG_DIR}/${MIG}: falta la migracion G2-C.3A1`]
  const f = [...inspectMigracion(st.mig), ...inspectPosteriores(st.migraciones)]
  if (st.g2c2 == null || !/CREATE\s+FUNCTION\s+private\.lock_inventory_rows\s*\(/i.test(st.g2c2)) {
    f.push(`${MIG_DIR}/${MIG_G2C2}: falta el helper private.lock_inventory_rows del que depende A1`)
  }
  return f
}

function load() {
  const nombres = readdirSync(MIG_DIR).filter((n) => /^\d+_.*\.sql$/.test(n)).sort()
  const migraciones = nombres.map((nombre) => ({ nombre, sql: read(`${MIG_DIR}/${nombre}`) }))
  return {
    mig: nombres.includes(MIG) ? read(`${MIG_DIR}/${MIG}`) : null,
    g2c2: nombres.includes(MIG_G2C2) ? read(`${MIG_DIR}/${MIG_G2C2}`) : null,
    migraciones,
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
  // Los CREATE FUNCTION reales de A1, para redefinirlos en una migracion posterior.
  const def = (nombre) => {
    const m = base.mig.match(new RegExp(`CREATE FUNCTION ${esc(nombre)}\\([\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$;`))
    if (!m) throw new Error(`self-test: no encuentro la definicion de ${nombre}`)
    return m[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
  }
  const IMPL_DEF = def(IMPL), WRAPPER_DEF = def(WRAPPER)
  const redefinirImpl = (a, b) => (st) => {
    if (!IMPL_DEF.includes(a)) return st
    return posterior(st, IMPL_DEF.split(a).join(b))
  }

  const MUTACIONES = [
    // ── migracion A1 ──
    ['falta la migracion', (st) => ({ ...st, mig: null })],
    ['pierde BEGIN/COMMIT', (st) => conMig(st, '\nCOMMIT;\n', '\n')],
    ['pierde una precondicion', (st) => conMig(st, 'PRECONDICION 9:', 'NOTA 9:')],
    ['pierde la postcondicion de writers intactos', (st) => conMig(st, 'v_now.src_md5 IS DISTINCT FROM s.src_md5', 'false')],
    ['pierde el NOTICE final', (st) => conMig(st, "RAISE NOTICE 'G2-C.3A1 OK", "RAISE NOTICE 'listo")],
    ['la precondicion ya no exige el helper de lock', (st) => conMig(st, "v_helper oid := to_regprocedure('private.lock_inventory_rows(uuid,uuid[])');", 'v_helper oid := 1;')],
    // wrapper
    ['el wrapper pierde la autoridad', (st) => conMig(st, "IF private.has_action_authority(p_business_id, 'inventory', NULL, NULL) IS NOT TRUE THEN", 'IF false THEN')],
    ['el wrapper pide otra capability', (st) => conMig(st, "private.has_action_authority(p_business_id, 'inventory'", "private.has_action_authority(p_business_id, 'orders'")],
    ['el wrapper deja de exigir auth.uid', (st) => conMig(st, '  IF auth.uid() IS NULL THEN\n    RAISE EXCEPTION', '  IF false THEN\n    RAISE EXCEPTION')],
    ['el wrapper pasa a SECURITY INVOKER', (st) => conMig(st, 'VOLATILE\nSECURITY DEFINER\nSET search_path = pg_catalog, pg_temp\nAS $fn$\nBEGIN', 'VOLATILE\nSECURITY INVOKER\nSET search_path = pg_catalog, pg_temp\nAS $fn$\nBEGIN')],
    ['el wrapper agrega public al search_path', (st) => conMig(st, 'SECURITY DEFINER\nSET search_path = pg_catalog, pg_temp', 'SECURITY DEFINER\nSET search_path = public, pg_temp')],
    ['el wrapper escribe una tabla', (st) => conMig(st, '  RETURN private.apply_inventory_stock_adjustments_impl(', '  UPDATE public.inventory SET min_stock = 0 WHERE business_id = p_business_id;\n  RETURN private.apply_inventory_stock_adjustments_impl(')],
    // ACL
    ['el wrapper pierde el REVOKE de PUBLIC/anon', (st) => conMig(st, '  FROM PUBLIC, anon, service_role;', '  FROM service_role;')],
    ['el wrapper pierde el GRANT a authenticated', (st) => conMig(st, 'GRANT EXECUTE ON FUNCTION public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text)\n  TO authenticated;', '')],
    ['el wrapper se concede a anon', (st) => antesDelCommit(st, 'GRANT EXECUTE ON FUNCTION public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text) TO anon;')],
    ['el impl pierde su REVOKE', (st) => conMig(st, '  FROM PUBLIC, anon, authenticated, service_role;\nCOMMENT ON FUNCTION private.apply_inventory_stock_adjustments_impl', ';\nCOMMENT ON FUNCTION private.apply_inventory_stock_adjustments_impl')],
    ['el impl se expone a authenticated', (st) => antesDelCommit(st, 'GRANT EXECUTE ON FUNCTION private.apply_inventory_stock_adjustments_impl(uuid, jsonb, text, text, text) TO authenticated;')],
    // impl
    ['el impl pasa a SECURITY DEFINER', (st) => conMig(st, 'VOLATILE\nSECURITY INVOKER', 'VOLATILE\nSECURITY DEFINER')],
    ['el impl pierde la reserva idempotente', (st) => conMig(st, 'ON CONFLICT (business_id, idempotency_key) DO NOTHING', 'ON CONFLICT DO NOTHING')],
    ['el impl deja de rechazar el conflicto de clave', (st) => conMig(st, 'IF v_prev_hash IS DISTINCT FROM v_hash THEN', 'IF false THEN')],
    ['el hash deja de calcularse en el servidor', (st) => conMig(st, 'v_hash := encode(pg_catalog.sha256(', 'v_hash := encode(pg_catalog.convert_to(')],
    ['el replay deja de devolver la respuesta persistida', (st) => conMig(st, "RETURN v_prev_resp || jsonb_build_object('status', 'existing');", "RETURN jsonb_build_object('status', 'existing');")],
    ['la respuesta deja de persistirse', (st) => conMig(st, "SET status = 'completed', response = v_response, completed_at = now()", "SET status = 'completed', completed_at = now()")],
    ['el impl deja de bloquear', (st) => conMig(st, 'v_locked := private.lock_inventory_rows(p_business_id, v_ids);', 'v_locked := v_n;')],
    ['el lock pierde el conteo exacto', (st) => conMig(st, 'IF v_locked <> v_n THEN', 'IF false THEN')],
    ['el impl escribe stock ANTES del lock', (st) => conMig(st, '  v_locked := private.lock_inventory_rows(p_business_id, v_ids);', "  UPDATE public.inventory SET stock_quantity = 0, stock = 0 WHERE business_id = p_business_id;\n  INSERT INTO public.inventory_movements (business_id) VALUES (p_business_id);\n  v_locked := private.lock_inventory_rows(p_business_id, v_ids);")],
    ['el impl bloquea inventory FOR UPDATE', (st) => conMig(st, '  v_locked := private.lock_inventory_rows(p_business_id, v_ids);', '  PERFORM 1 FROM public.inventory WHERE business_id = p_business_id AND id = ANY (v_ids) ORDER BY id FOR UPDATE;\n  v_locked := private.lock_inventory_rows(p_business_id, v_ids);')],
    ['el impl clampa con GREATEST', (st) => conMig(st, 'ELSE v_it.target END;', 'ELSE v_it.target END;\n      v_new := GREATEST(v_new, 0);')],
    ['el impl rechaza stock insuficiente', (st) => conMig(st, 'ELSE v_it.target END;', "ELSE v_it.target END;\n      IF v_new < 0 THEN RAISE EXCEPTION 'Stock insuficiente'; END IF;")],
    ['el impl escribe stock sin movimiento', (st) => conMig(st, 'INSERT INTO public.inventory_movements\n', 'INSERT INTO public.inventory_movements_sombra\n')],
    ['el impl deja de escribir el alias', (st) => conMig(st, '             stock          = v_new::integer,\n', '')],
    ['el UPDATE de stock pierde el tenant', (st) => conMig(st, '       WHERE id = v_it.inventory_id AND business_id = p_business_id;\n      GET DIAGNOSTICS', '       WHERE id = v_it.inventory_id;\n      GET DIAGNOSTICS')],
    ['la relectura pierde el tenant', (st) => conMig(st, '     WHERE i.id = v_it.inventory_id AND i.business_id = p_business_id;', '     WHERE i.id = v_it.inventory_id;')],
    ['el impl reescribe un movimiento', (st) => conMig(st, '      RETURNING id INTO v_mov_id;', "      RETURNING id INTO v_mov_id;\n      UPDATE public.inventory_movements SET note = 'x' WHERE id = v_mov_id;")],
    ['el impl borra un producto', (st) => conMig(st, '      RETURNING id INTO v_mov_id;', '      RETURNING id INTO v_mov_id;\n      DELETE FROM public.inventory WHERE id = v_it.inventory_id AND business_id = p_business_id;')],
    // tabla
    ['la tabla pierde el UNIQUE', (st) => conMig(st, '  CONSTRAINT inventory_stock_adjustment_requests_key_uq UNIQUE (business_id, idempotency_key),\n', '')],
    ['la tabla pierde la RLS', (st) => conMig(st, 'ALTER TABLE private.inventory_stock_adjustment_requests ENABLE ROW LEVEL SECURITY;', '')],
    ['la tabla pierde el REVOKE', (st) => conMig(st, 'REVOKE ALL ON private.inventory_stock_adjustment_requests FROM PUBLIC, anon, authenticated, service_role;', '')],
    // aditivo
    ['A1 revoca stock del navegador (eso es A3)', (st) => antesDelCommit(st, 'REVOKE UPDATE (stock_quantity) ON public.inventory FROM authenticated;')],
    ['A1 cierra inventory_movements (eso es A3)', (st) => antesDelCommit(st, 'REVOKE INSERT ON TABLE public.inventory_movements FROM authenticated;')],
    ['A1 agrega un trigger de revoke (eso es A3)', (st) => antesDelCommit(st, 'CREATE TRIGGER trig_inventory_guard_stock_write BEFORE UPDATE ON public.inventory FOR EACH ROW EXECUTE FUNCTION public.f();')],
    ['A1 toca una policy de inventory_movements', (st) => antesDelCommit(st, 'DROP POLICY inventory_movements_insert ON public.inventory_movements;')],
    ['A1 redefine un writer canonico', (st) => antesDelCommit(st, 'CREATE OR REPLACE FUNCTION public.adjust_stock_on_order_item() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RETURN NEW; END $x$;')],
    ['falta el helper de G2-C.2', (st) => ({ ...st, g2c2: st.g2c2.replace('CREATE FUNCTION private.lock_inventory_rows(', 'CREATE FUNCTION private.otra_cosa(') })],
    // posteriores
    ['una migracion posterior redefine el impl sin lock', redefinirImpl('v_locked := private.lock_inventory_rows(p_business_id, v_ids);', 'v_locked := v_n;')],
    ['una migracion posterior redefine el impl sin idempotencia', redefinirImpl('IF v_prev_hash IS DISTINCT FROM v_hash THEN', 'IF false THEN')],
    ['una migracion posterior redefine el impl con clamp', redefinirImpl('ELSE v_it.target END;', 'ELSE v_it.target END;\n      v_new := GREATEST(v_new, 0);')],
    ['una migracion posterior redefine el wrapper sin autoridad',
      (st) => posterior(st, WRAPPER_DEF.replace("IF private.has_action_authority(p_business_id, 'inventory', NULL, NULL) IS NOT TRUE THEN", 'IF false THEN'))],
    ['una migracion posterior concede el wrapper a anon', (st) => posterior(st, 'GRANT EXECUTE ON FUNCTION public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text) TO anon, authenticated;')],
    ['una migracion posterior concede el wrapper a service_role', (st) => posterior(st, 'GRANT EXECUTE ON FUNCTION public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text) TO service_role;')],
    ['una migracion posterior expone el impl', (st) => posterior(st, 'GRANT EXECUTE ON FUNCTION private.apply_inventory_stock_adjustments_impl(uuid, jsonb, text, text, text) TO authenticated;')],
    ['una migracion posterior concede la tabla', (st) => posterior(st, 'GRANT SELECT, INSERT ON private.inventory_stock_adjustment_requests TO authenticated;')],
    ['una migracion posterior abre el schema private', (st) => posterior(st, 'GRANT USAGE ON SCHEMA private TO authenticated;')],
    ['una migracion posterior le quita la RLS a la tabla', (st) => posterior(st, 'ALTER TABLE private.inventory_stock_adjustment_requests DISABLE ROW LEVEL SECURITY;')],
    ['una migracion posterior le quita el UNIQUE a la tabla', (st) => posterior(st, 'ALTER TABLE private.inventory_stock_adjustment_requests DROP CONSTRAINT inventory_stock_adjustment_requests_key_uq;')],
    ['una migracion posterior agrega una policy a la tabla', (st) => posterior(st, 'CREATE POLICY p ON private.inventory_stock_adjustment_requests FOR SELECT TO authenticated USING (true);')],
    ['una migracion posterior borra la RPC', (st) => posterior(st, 'DROP FUNCTION IF EXISTS public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text);')],
    ['una migracion posterior borra la tabla', (st) => posterior(st, 'DROP TABLE private.inventory_stock_adjustment_requests;')],
    ['una migracion posterior pasa el wrapper a INVOKER', (st) => posterior(st, 'ALTER FUNCTION public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text) SECURITY INVOKER;')],
    ['una migracion posterior borra el helper de lock', (st) => posterior(st, 'DROP FUNCTION private.lock_inventory_rows(uuid, uuid[]);')],
  ]

  // CONTROLES · lo que el guard NO debe marcar.
  const CONTROLES = [
    ['una migracion posterior redefine wrapper e impl con el MISMO contrato', (st) => posterior(st, `${WRAPPER_DEF}\n\n${IMPL_DEF}`)],
    ['una migracion posterior reafirma el owner', (st) => posterior(st, 'ALTER FUNCTION public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text) OWNER TO postgres;')],
    ['una migracion posterior concede OTRA funcion a anon', (st) => posterior(st, 'GRANT EXECUTE ON FUNCTION public.get_wholesale_portal_public(text) TO anon;')],
    ['un comentario posterior menciona GRANT del wrapper a anon', (st) => posterior(st, '-- nunca: GRANT EXECUTE ON FUNCTION public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text) TO anon;\nSELECT 1;')],
    ['un comentario en A1 menciona FOR UPDATE de inventory', (st) => conMig(st, '-- FAIL-CLOSED: si una precondicion no se cumple, nada se aplica.', '-- FAIL-CLOSED: nunca SELECT ... FROM public.inventory ... FOR UPDATE; si una precondicion no se cumple, nada se aplica.')],
  ]

  let fallos = 0
  for (const [nombre, mutar] of MUTACIONES) {
    const mutado = mutar(base)
    if (JSON.stringify(mutado) === JSON.stringify(base)) {
      console.error(`  ✖ ${nombre}: la mutacion NO aplico (el patron cambio) — el self-test estaria mintiendo`)
      fallos++; continue
    }
    const r = run(mutado)
    if (r.length === 0) { console.error(`  ✖ ${nombre}: NO detectado`); fallos++ }
    else console.log(`  ✔ ${nombre}: detectado`)
  }
  for (const [nombre, mutar] of CONTROLES) {
    const mutado = mutar(base)
    if (JSON.stringify(mutado) === JSON.stringify(base)) { console.error(`  ✖ control "${nombre}": no aplico`); fallos++; continue }
    const r = run(mutado)
    if (r.length) { console.error(`  ✖ control "${nombre}": falso positivo -> ${r[0]}`); fallos++ }
    else console.log(`  ✔ control "${nombre}": no se marca (correcto)`)
  }
  if (fallos) { console.error(`SELF-TEST FALLO: ${fallos} mutacion(es)/control(es) fallido(s).`); process.exit(1) }
  console.log(`SELF-TEST OK: las ${MUTACIONES.length} mutaciones del contrato G2-C.3A1 son detectadas y los ${CONTROLES.length} controles no dan falso positivo.`)
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const findings = run(load())
  if (findings.length) {
    console.error('GUARD G2-C.3 FALLO — el contrato de la autoridad de stock esta roto:')
    findings.forEach((x) => console.error('  · ' + x))
    process.exit(1)
  }
  console.log('GUARD G2-C.3 OK · public.apply_inventory_stock_adjustments_atomic (DEFINER, authenticated, autoridad inventory del tenant antes del impl) '
    + '· impl INVOKER sin API: idempotencia server-side (UNIQUE + sha256 + conflicto + replay persistido) -> lock canonico G2-C.2 con conteo exacto '
    + '-> UPDATE de stock + alias -> movimiento · sin FOR UPDATE, sin clamp, libro append-only, todo por business_id '
    + '· tabla de requests sin API · A1 aditivo (W1-W7, grants, policies y triggers de inventario intactos) · ninguna migracion posterior lo reabre.')
  console.log('NOTA · alcance A1: todavia NO prohibe las escrituras de stock del navegador (registerMovement, import de Excel, altas con stock): G2-C.3A2/A3.')
}
