#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// G2-C.2 · Guard de los locks canonicos de inventario.
//
// La matriz SQL y la de concurrencia prueban el COMPORTAMIENTO sobre una base
// viva. Este guard cubre el FUTURO: la forma natural de perder G2-C.2 es que una
// migracion POSTERIOR haga CREATE OR REPLACE de un writer de stock desde una
// copia vieja del cuerpo (sin lock, o con el trigger de repuestos buscando el
// producto solo por id), o que agregue un writer nuevo que haga read-modify-write
// de stock sin bloquear. Ningun test sobre el estado final ve ese archivo
// hipotetico.
//
// Invariantes:
//   1. La migracion G2-C.2 existe, es transaccional (BEGIN/COMMIT) y fail-closed
//      (precondiciones, incluida la de order_items cross-tenant; postcondiciones
//      que comparan prosecdef/proowner/proconfig/proacl contra un snapshot).
//   2. El helper private.lock_inventory_rows: SECURITY INVOKER, search_path
//      pg_catalog/pg_temp, filtra por business_id, ORDER BY id, FOR NO KEY UPDATE,
//      y sin EXECUTE para PUBLIC/anon/authenticated/service_role.
//   3. Los 4 writers de G2-C.2 se redefinen por firma y toman el lock ANTES del
//      primer UPDATE de stock.
//   4. El trigger de repuestos (W7): toda lectura/escritura de inventory acotada
//      por business_id, fail-closed de tenant, e identidad inmutable en UPDATE
//      (business_id, order_id, product_id, tipo -> 0A000).
//   5. En la migracion G2-C.2 y en TODA migracion posterior, cualquier funcion
//      cuyo cuerpo escriba stock (`UPDATE inventory ... SET stock/stock_quantity =`)
//      bloquea antes con el helper o con un pre-lock `ORDER BY id FOR NO KEY UPDATE`.
//      El helper nunca se llama con business_id NULL, nunca se redefine sin
//      tenant/orden, nunca recibe EXECUTE de roles de API, y el trigger de
//      repuestos no se deshabilita ni se borra.
//   6. G2-C.2R · UN solo modo de lock de stock: ningun writer canonico (W1-W7) ni
//      el helper bloquea inventory con FOR UPDATE. FOR UPDATE es el unico modo que
//      choca con el FOR KEY SHARE que toma cualquier INSERT que referencia
//      inventory (FK): checkout FOR UPDATE contra el alta mayorista dio deadlock
//      3/3. Checkout, compra rapida y anulacion (W1-W3) se redefinen en la misma
//      migracion con FOR NO KEY UPDATE, y la postcondicion prueba que es el unico
//      cambio. El guard mira la SENTENCIA: un FOR UPDATE de comprobantes, pagos o
//      cuenta corriente (que la anulacion conserva) NO es de inventory y se permite.
//
// LIMITE HONESTO. Este guard NO cubre los writers de stock del navegador
// (inventoryMovementsService.registerMovement, import de Excel en Inventory.tsx):
// un read-modify-write que atraviesa HTTP no se arregla con un lock de fila. Son
// el lote G2-C.3 y BLOQUEAN el cierre definitivo de BETA-GATE-2.
//
// `--self-test` muta cada invariante en memoria y exige que el guard lo detecte.
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync } from 'node:fs'

const MIG_DIR = 'supabase/migrations'
const VERSION = '20261006120000'
const MIG = `${VERSION}_g2c2_inventory_concurrency_locks.sql`

const WRITERS = {
  W4: { firma: 'private.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text)',
        def: 'private.create_supplier_purchase_atomic' },
  W5: { firma: 'public.delete_supplier_purchase_safe(uuid,uuid,uuid)', def: 'public.delete_supplier_purchase_safe' },
  W6: { firma: 'public.repair_missing_stock_movements(uuid,boolean)', def: 'public.repair_missing_stock_movements' },
  W7: { firma: 'public.adjust_stock_on_order_item()', def: 'public.adjust_stock_on_order_item' },
}
// G2-C.2R: writers que ya bloqueaban ordenado y solo cambian el MODO del lock.
const WRITERS_MODO = {
  W1: { firma: 'private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)', def: 'private.create_comprobante_checkout_atomic' },
  W2: { firma: 'private.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb)',
        def: 'private.create_quick_inventory_purchase_atomic' },
  W3: { firma: 'private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)', def: 'private.sec08e_annul_comprobante_impl' },
}
const CANONICOS = new Set([...Object.values(WRITERS), ...Object.values(WRITERS_MODO)].map((w) => w.def))

const read = (p) => readFileSync(p, 'utf8')

/**
 * Sentencias que bloquean INVENTORY con FOR UPDATE (el modo que choca con FK
 * KEY SHARE). Mira cada sentencia completa: tiene que leer de `inventory` (no de
 * inventory_movements) y terminar en FOR UPDATE (no FOR NO KEY UPDATE). Un
 * FOR UPDATE de otra tabla (comprobantes, pagos, cuenta corriente) no cuenta.
 * Recibe el cuerpo YA sin comentarios.
 */
export function lockInventarioForUpdate(cuerpo) {
  // Una sentencia termina en ';' pero tambien donde plpgsql abre un bloque: el
  // encabezado de un `FOR r IN SELECT ... LOOP` no lleva ';' y sin este corte se
  // pegaria con la primera sentencia de adentro del loop.
  return cuerpo.split(/;|\bLOOP\b|\bTHEN\b|\bELSE\b|\bBEGIN\b/i)
    .filter((st) => {
      const from = st.match(/\bFROM\s+(?:public\.)?inventory\b(?!_)(?:\s+(?:AS\s+)?(?!WHERE\b|JOIN\b|ORDER\b|FOR\b|GROUP\b|LIMIT\b)(\w+))?/i)
      if (!from || !/\bFOR\s+UPDATE\b/i.test(st)) return false
      // `FOR UPDATE OF x, y`: solo cuenta si alguno de los nombres es inventory o su alias.
      const of = st.match(/\bFOR\s+UPDATE\s+OF\s+([\w\s,]+?)(?:\bSKIP\b|\bNOWAIT\b|$)/i)
      if (!of) return true
      const nombres = of[1].split(',').map((x) => x.trim().toLowerCase())
      return nombres.includes('inventory') || (from[1] && nombres.includes(from[1].toLowerCase()))
    })
    .map((st) => st.replace(/\s+/g, ' ').trim().slice(0, 120))
}

function sinComentarios(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.slice(i, i + 2) === '--') { const f = sql.indexOf('\n', i); const e = f === -1 ? sql.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (sql.slice(i, i + 2) === '/*') { const f = sql.indexOf('*/', i + 2); const e = f === -1 ? sql.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += sql[i]; i++
  }
  return out
}

/** Funciones definidas en un archivo: [{ nombre, cabecera, cuerpo }]. */
export function funciones(sql) {
  const out = []
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\(([\s\S]*?)\)\s*(RETURNS[\s\S]*?)\bAS\s+(\$[\w]*\$)([\s\S]*?)\4/gi
  let m
  while ((m = re.exec(sql)) !== null) {
    out.push({ nombre: m[1].replace(/"/g, '').toLowerCase(), cabecera: m[3], cuerpo: m[5] })
  }
  return out
}

const RE_ESCRIBE_STOCK = /UPDATE\s+(?:public\.)?inventory\b[^;]*?\bSET\b[^;]*?\bstock(?:_quantity)?\s*=/i
const RE_HELPER_CALL = /private\.lock_inventory_rows\s*\(/i
const RE_PRELOCK = /ORDER\s+BY\s+(?:i\.)?id\s+FOR\s+NO\s+KEY\s+UPDATE/i

/** Un cuerpo que escribe stock tiene que bloquear ANTES del primer UPDATE de stock. */
function bloqueaAntes(cuerpo) {
  const w = cuerpo.search(RE_ESCRIBE_STOCK)
  if (w < 0) return true
  const candidatos = [cuerpo.search(RE_HELPER_CALL), cuerpo.search(RE_PRELOCK)].filter((i) => i >= 0)
  return candidatos.length > 0 && Math.min(...candidatos) < w
}

function inspectHelper(f, etiqueta) {
  const out = []
  if (!/SECURITY\s+INVOKER/i.test(f.cabecera) || /SECURITY\s+DEFINER/i.test(f.cabecera)) out.push(`${etiqueta}: el helper dejo de ser SECURITY INVOKER`)
  if (!/SET\s+search_path\s*=\s*pg_catalog\s*,\s*pg_temp\b/i.test(f.cabecera)) out.push(`${etiqueta}: el helper cambio su search_path (pg_catalog, pg_temp)`)
  if (!/\bbusiness_id\s*=\s*p_business_id\b/i.test(f.cuerpo)) out.push(`${etiqueta}: el helper bloquea sin filtrar por business_id`)
  if (!/p_business_id\s+IS\s+NULL[\s\S]*?22023/i.test(f.cuerpo)) out.push(`${etiqueta}: el helper acepta business_id NULL (sin INVENTORY_LOCK_TENANT_REQUIRED / 22023)`)
  if (!/ORDER\s+BY\s+i\.id\b/i.test(f.cuerpo)) out.push(`${etiqueta}: el helper bloquea sin orden determinista (ORDER BY id)`)
  if (!/FOR\s+NO\s+KEY\s+UPDATE/i.test(f.cuerpo)) out.push(`${etiqueta}: el helper no toma el lock FOR NO KEY UPDATE`)
  if (/\bFOR\s+UPDATE\b/i.test(f.cuerpo)) out.push(`${etiqueta}: el helper bloquea con FOR UPDATE (choca con el FOR KEY SHARE de las FK: G2-C.2R)`)
  if (/SKIP\s+LOCKED|NOWAIT/i.test(f.cuerpo)) out.push(`${etiqueta}: el helper saltea filas bloqueadas (SKIP LOCKED/NOWAIT): no serializa`)
  return out
}

function inspectW7(f, etiqueta) {
  const out = []
  const c = f.cuerpo
  if (/WHERE\s+id\s*=\s*(?:NEW|OLD)\.product_id\s*;/i.test(c)) out.push(`${etiqueta}: el trigger de repuestos vuelve a acceder a inventory solo por id (cross-tenant)`)
  const accesos = [...c.matchAll(/(?:FROM|UPDATE)\s+public\.inventory\b[^;]*;/gi)].map((m) => m[0])
  if (!accesos.length || accesos.some((a) => !/business_id\s*=\s*v_business_id/i.test(a))) {
    out.push(`${etiqueta}: una lectura/escritura de inventory del trigger no esta acotada por business_id`)
  }
  if (!/INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH/.test(c) || !/<>\s*1\s+THEN|<>\s*v_expected/i.test(c)) {
    out.push(`${etiqueta}: el trigger perdio el fail-closed de tenant (lock <> 1 -> INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH)`)
  }
  const ident = c.match(/TG_OP\s*=\s*'UPDATE'\s+AND\s*\(([\s\S]*?)\)\s*THEN\s*RAISE\s+EXCEPTION\s+'ORDER_ITEM_STOCK_IDENTITY_IMMUTABLE[\s\S]*?ERRCODE\s*=\s*'0A000'/i)
  if (!ident) {
    out.push(`${etiqueta}: el trigger perdio la identidad inmutable en UPDATE (ORDER_ITEM_STOCK_IDENTITY_IMMUTABLE / 0A000)`)
  } else {
    for (const col of ['business_id', 'order_id', 'product_id', 'tipo']) {
      if (!new RegExp(`NEW\\.${col}\\s+IS\\s+DISTINCT\\s+FROM\\s+OLD\\.${col}`, 'i').test(ident[1])) {
        out.push(`${etiqueta}: la identidad inmutable ya no cubre ${col}`)
      }
    }
  }
  if (!/lock_inventory_rows\s*\(\s*v_business_id\s*,\s*v_order_products\s*\)/i.test(c)) {
    out.push(`${etiqueta}: el DELETE perdio el pre-lock ordenado de los repuestos de la orden (cascada)`)
  }
  return out
}

function inspectMigracion(sql) {
  const f = []
  const s = sinComentarios(sql)
  if (!/^\s*BEGIN\s*;/m.test(s) || !/^\s*COMMIT\s*;/m.test(s)) f.push('la migracion perdio su BEGIN/COMMIT explicito (las migraciones corren en autocommit)')
  for (let n = 1; n <= 8; n++) if (!new RegExp(`PRECONDICION ${n}:`).test(s)) f.push(`se perdio la PRECONDICION ${n}`)
  for (let n = 1; n <= 9; n++) if (!new RegExp(`POSTCONDICION ${n}:`).test(s)) f.push(`se perdio la POSTCONDICION ${n}`)
  if (!/PRECONDICION 6:[\s\S]*?order_items/.test(s) && !/order_items[\s\S]{0,600}PRECONDICION 6:/.test(s)) f.push('la PRECONDICION 6 ya no aborta ante order_items cross-tenant')
  if (!/src_md5\s+IS\s+DISTINCT\s+FROM\s+orig_md5[\s\S]{0,200}PRECONDICION 8:/.test(s)) {
    f.push('la PRECONDICION 8 ya no aborta ante drift de los cuerpos (md5 contra main)')
  }
  // G2-C.2R: la prueba de "solo cambio el modo de lock" de W1-W3.
  if (!/md5\(replace\(v_src,\s*'FOR NO KEY UPDATE',\s*'FOR UPDATE'\)\)\s+IS\s+DISTINCT\s+FROM\s+s\.orig_md5/.test(s)) {
    f.push('la POSTCONDICION 2 dejo de probar que W1-W3 solo cambian el modo de lock (md5 revertido contra main)')
  }
  for (const campo of ['prosecdef', 'proowner', 'proconfig', 'proacl']) {
    if (!new RegExp(`v_now\\.${campo}\\s+IS\\s+DISTINCT\\s+FROM\\s+s\\.${campo}`).test(s)) f.push(`las postcondiciones dejaron de comparar ${campo} contra el snapshot`)
  }
  for (const [w, { firma }] of Object.entries(WRITERS)) {
    if (!s.includes(firma)) f.push(`${w}: la migracion dejo de apuntar la firma exacta ${firma}`)
  }
  if (!/REVOKE\s+ALL\s+ON\s+FUNCTION\s+private\.lock_inventory_rows\s*\(\s*uuid\s*,\s*uuid\[\]\s*\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role\s*;/i.test(s)) {
    f.push('el helper perdio el REVOKE de EXECUTE a PUBLIC/anon/authenticated/service_role')
  }
  const fns = funciones(s)
  const helper = fns.find((x) => x.nombre === 'private.lock_inventory_rows')
  if (!helper) f.push('la migracion ya no define private.lock_inventory_rows')
  else f.push(...inspectHelper(helper, 'G2-C.2'))
  for (const [w, { def }] of Object.entries(WRITERS)) {
    const fn = fns.find((x) => x.nombre === def)
    if (!fn) { f.push(`${w}: la migracion ya no redefine ${def}`); continue }
    if (!RE_HELPER_CALL.test(fn.cuerpo)) f.push(`${w}: ${def} no toma el lock canonico`)
    else if (!bloqueaAntes(fn.cuerpo)) f.push(`${w}: ${def} bloquea DESPUES de escribir stock`)
    if (/private\.lock_inventory_rows\s*\(\s*NULL\b/i.test(fn.cuerpo)) f.push(`${w}: ${def} llama al helper sin tenant`)
    if (!/\b(?:DISTINCT|ARRAY\[)/i.test(fn.cuerpo.slice(0, Math.max(0, fn.cuerpo.search(RE_HELPER_CALL)) + 200))) {
      f.push(`${w}: ${def} ya no arma el conjunto de ids (DISTINCT) antes de bloquear`)
    }
  }
  const w7 = fns.find((x) => x.nombre === WRITERS.W7.def)
  if (w7) f.push(...inspectW7(w7, 'W7'))
  // G2-C.2R: W1-W3 se redefinen con el MISMO contrato de lock que el helper.
  for (const [w, { firma, def }] of Object.entries(WRITERS_MODO)) {
    if (!s.includes(firma)) f.push(`${w}: la migracion dejo de apuntar la firma exacta ${firma}`)
    const fn = fns.find((x) => x.nombre === def)
    if (!fn) { f.push(`${w}: la migracion ya no redefine ${def} (G2-C.2R)`); continue }
    if (!RE_PRELOCK.test(fn.cuerpo)) f.push(`${w}: ${def} perdio su pre-lock de inventory ORDER BY id FOR NO KEY UPDATE`)
    else if (!bloqueaAntes(fn.cuerpo)) f.push(`${w}: ${def} bloquea DESPUES de escribir stock`)
  }
  // Ningun writer canonico bloquea inventory con FOR UPDATE.
  for (const fn of fns.filter((x) => CANONICOS.has(x.nombre))) {
    for (const st of lockInventarioForUpdate(fn.cuerpo)) {
      f.push(`${fn.nombre} bloquea inventory con FOR UPDATE (debe ser FOR NO KEY UPDATE: G2-C.2R): ${st}`)
    }
  }
  return f.map((x) => `${MIG_DIR}/${MIG}: ${x}`)
}

/** G2-C.2 y toda migracion posterior: ningun writer de stock sin lock previo. */
function inspectPosteriores(archivos) {
  const f = []
  for (const { nombre, sql } of archivos) {
    if (nombre.split('_')[0] < VERSION) continue
    const s = sinComentarios(sql)
    for (const fn of funciones(s)) {
      if (RE_ESCRIBE_STOCK.test(fn.cuerpo) && !bloqueaAntes(fn.cuerpo)) {
        f.push(`${nombre}: ${fn.nombre} escribe stock de inventory sin lock canonico previo (read-modify-write sin lock)`)
      }
      if ((RE_ESCRIBE_STOCK.test(fn.cuerpo) || CANONICOS.has(fn.nombre)) && nombre !== MIG) {
        for (const st of lockInventarioForUpdate(fn.cuerpo)) {
          f.push(`${nombre}: ${fn.nombre} bloquea inventory con FOR UPDATE (debe ser FOR NO KEY UPDATE: G2-C.2R): ${st}`)
        }
      }
      if (/private\.lock_inventory_rows\s*\(\s*NULL\b/i.test(fn.cuerpo)) f.push(`${nombre}: ${fn.nombre} llama al helper sin tenant`)
      if (fn.nombre === 'private.lock_inventory_rows' && nombre !== MIG) f.push(...inspectHelper(fn, nombre))
      if (fn.nombre === WRITERS.W7.def && nombre !== MIG) f.push(...inspectW7(fn, nombre))
    }
    if (/GRANT[^;]*\bEXECUTE\b[^;]*ON\s+FUNCTION\s+private\.lock_inventory_rows\b[^;]*\bTO\b/i.test(s)) {
      f.push(`${nombre}: concede EXECUTE del helper de lock (solo lo llaman los writers SECURITY DEFINER)`)
    }
    if (/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?order_items\s+DISABLE\s+TRIGGER\s+(?:trg_adjust_stock_on_order_item|ALL|USER)\b/i.test(s)) {
      f.push(`${nombre}: deshabilita el trigger de stock de repuestos`)
    }
    if (/DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?trg_adjust_stock_on_order_item\b/i.test(s)
        && !/CREATE\s+TRIGGER\s+trg_adjust_stock_on_order_item\b/i.test(s)) {
      f.push(`${nombre}: borra el trigger de stock de repuestos sin recrearlo`)
    }
    if (/DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?private\.lock_inventory_rows\b/i.test(s)) {
      f.push(`${nombre}: borra el helper de lock canonico`)
    }
  }
  return f
}

function run(s) {
  if (s.mig == null) return [`${MIG_DIR}/${MIG}: falta la migracion G2-C.2`]
  return [...inspectMigracion(s.mig), ...inspectPosteriores(s.migraciones)]
}

function load() {
  const nombres = readdirSync(MIG_DIR).filter((n) => /^\d+_.*\.sql$/.test(n)).sort()
  const migraciones = nombres.map((nombre) => ({ nombre, sql: read(`${MIG_DIR}/${nombre}`) }))
  return { mig: nombres.includes(MIG) ? read(`${MIG_DIR}/${MIG}`) : null, migraciones }
}

function selfTest() {
  const base = load()
  const limpio = run(base)
  if (limpio.length) {
    console.error('SELF-TEST FALLO: el arbol actual ya viola el contrato:')
    limpio.forEach((x) => console.error('  · ' + x))
    process.exit(1)
  }
  const conMig = (s, a, b) => {
    if (!s.mig.includes(a)) return s
    const mig = s.mig.split(a).join(b)
    return { ...s, mig, migraciones: s.migraciones.map((m) => (m.nombre === MIG ? { ...m, sql: mig } : m)) }
  }
  const posterior = (s, sql) => ({ ...s, migraciones: [...s.migraciones, { nombre: '20261099120000_regresion_hipotetica.sql', sql }] })
  const W7_VIEJO = `CREATE OR REPLACE FUNCTION public.adjust_stock_on_order_item()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.tipo = 'repuesto' AND NEW.product_id IS NOT NULL THEN
    SELECT stock_quantity INTO v_prev_stock FROM public.inventory WHERE id = NEW.product_id;
    UPDATE public.inventory SET stock_quantity = v_prev_stock - NEW.cantidad WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$function$;`

  const MUTACIONES = [
    ['falta la migracion', (s) => ({ ...s, mig: null })],
    ['la migracion pierde BEGIN/COMMIT', (s) => conMig(s, '\nCOMMIT;\n', '\n')],
    ['se pierde la precondicion cross-tenant', (s) => conMig(s, 'PRECONDICION 6:', 'NOTA 6:')],
    ['se pierde una postcondicion', (s) => conMig(s, 'POSTCONDICION 7:', 'NOTA 7:')],
    ['las postcondiciones dejan de comparar el ACL', (s) => conMig(s, 'v_now.proacl    IS DISTINCT FROM s.proacl', 'false')],
    ['las postcondiciones dejan de comparar el owner', (s) => conMig(s, 'v_now.proowner  IS DISTINCT FROM s.proowner', 'false')],
    ['el helper pierde el filtro de tenant', (s) => conMig(s, 'WHERE i.business_id = p_business_id', 'WHERE true')],
    ['el helper acepta tenant NULL', (s) => conMig(s, "USING ERRCODE = '22023'", "USING ERRCODE = 'P0001'")],
    ['el helper pierde el orden determinista', (s) => conMig(s, 'ORDER BY i.id', 'ORDER BY i.name')],
    ['el helper pasa a SKIP LOCKED', (s) => conMig(s, 'FOR NO KEY UPDATE;\n  GET DIAGNOSTICS', 'FOR NO KEY UPDATE SKIP LOCKED;\n  GET DIAGNOSTICS')],
    ['el helper pasa a SECURITY DEFINER', (s) => conMig(s, 'LANGUAGE plpgsql\nSECURITY INVOKER', 'LANGUAGE plpgsql\nSECURITY DEFINER')],
    ['el helper pierde el REVOKE', (s) => conMig(s, 'REVOKE ALL ON FUNCTION private.lock_inventory_rows(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;', '')],
    ['W4 deja de bloquear', (s) => conMig(s, 'IF private.lock_inventory_rows(p_business_id, v_inv_ids) <> cardinality(v_inv_ids) THEN\n    RAISE EXCEPTION \'PRODUCT_NOT_FOUND',
      'IF 0 <> cardinality(v_inv_ids) THEN\n    RAISE EXCEPTION \'PRODUCT_NOT_FOUND')],
    ['W5 deja de bloquear', (s) => conMig(s, "IF private.lock_inventory_rows(p_business_id, v_inv_ids) <> cardinality(v_inv_ids) THEN\n    RAISE EXCEPTION 'INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH' USING",
      "IF 0 <> cardinality(v_inv_ids) THEN\n    RAISE EXCEPTION 'INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH' USING")],
    ['W6 deja de bloquear', (s) => conMig(s, 'PERFORM private.lock_inventory_rows(p_business_id, v_inv_ids);', 'PERFORM 1;')],
    ['W7 vuelve a buscar el producto solo por id', (s) => conMig(s, 'FROM public.inventory WHERE id = NEW.product_id AND business_id = v_business_id;\n    v_prev_stock := COALESCE(v_prev_stock, 0);\n    v_new_stock  := v_prev_stock - NEW.cantidad;',
      'FROM public.inventory WHERE id = NEW.product_id;\n    v_prev_stock := COALESCE(v_prev_stock, 0);\n    v_new_stock  := v_prev_stock - NEW.cantidad;')],
    ['W7 actualiza inventory sin business_id', (s) => conMig(s, '    WHERE id = OLD.product_id AND business_id = v_business_id;', '    WHERE id = OLD.product_id AND true;')],
    ['W7 pierde el fail-closed de tenant', (s) => conMig(s, 'INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH', 'TENANT_WARN')],
    ['W7 pierde la identidad inmutable', (s) => conMig(s, "USING ERRCODE = '0A000'", "USING ERRCODE = 'P0001'")],
    ['la identidad inmutable deja de cubrir tipo', (s) => conMig(s, '    OR NEW.tipo        IS DISTINCT FROM OLD.tipo\n', '\n')],
    ['la identidad inmutable deja de cubrir order_id', (s) => conMig(s, '    OR NEW.order_id    IS DISTINCT FROM OLD.order_id\n', '\n')],
    ['W7 pierde el pre-lock de la orden al borrar', (s) => conMig(s, 'private.lock_inventory_rows(v_business_id, v_order_products)', 'private.lock_inventory_rows(v_business_id, ARRAY[OLD.product_id])')],
    ['una migracion posterior trae el cuerpo viejo de W7', (s) => posterior(s, W7_VIEJO)],
    ['una migracion posterior agrega un writer RMW sin lock', (s) => posterior(s, `CREATE OR REPLACE FUNCTION public.ajuste_nuevo(p uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v int; BEGIN
  SELECT stock_quantity INTO v FROM public.inventory WHERE id = p;
  UPDATE public.inventory SET stock_quantity = v + 1 WHERE id = p;
END $f$;`)],
    ['una migracion posterior bloquea DESPUES de escribir', (s) => posterior(s, `CREATE OR REPLACE FUNCTION public.ajuste_tarde(b uuid, p uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
  UPDATE public.inventory SET stock_quantity = 1 WHERE id = p AND business_id = b;
  PERFORM private.lock_inventory_rows(b, ARRAY[p]);
END $f$;`)],
    ['una migracion posterior llama al helper sin tenant', (s) => posterior(s, `CREATE OR REPLACE FUNCTION public.x(p uuid)
 RETURNS void LANGUAGE plpgsql AS $f$ BEGIN PERFORM private.lock_inventory_rows(NULL, ARRAY[p]); END $f$;`)],
    ['una migracion posterior redefine el helper sin orden', (s) => posterior(s, `CREATE OR REPLACE FUNCTION private.lock_inventory_rows(p_business_id uuid, p_inventory_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE v int; BEGIN
  IF p_business_id IS NULL THEN RAISE EXCEPTION 'X' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM public.inventory i WHERE i.business_id = p_business_id AND i.id = ANY (p_inventory_ids) FOR NO KEY UPDATE;
  RETURN 0; END $fn$;`)],
    ['una migracion posterior concede EXECUTE del helper', (s) => posterior(s, 'GRANT EXECUTE ON FUNCTION private.lock_inventory_rows(uuid, uuid[]) TO authenticated;')],
    ['una migracion posterior deshabilita el trigger de repuestos', (s) => posterior(s, 'ALTER TABLE public.order_items DISABLE TRIGGER trg_adjust_stock_on_order_item;')],
    ['una migracion posterior borra el helper', (s) => posterior(s, 'DROP FUNCTION IF EXISTS private.lock_inventory_rows(uuid, uuid[]);')],
    // ── G2-C.2R · un solo modo de lock de stock (FOR NO KEY UPDATE) ─────────────
    ['G2-C.2R: el pre-lock del checkout (W1) vuelve a FOR UPDATE',
      (s) => conMig(s, "IN ('producto','repuesto'))\n        ORDER BY id FOR NO KEY UPDATE;", "IN ('producto','repuesto'))\n        ORDER BY id FOR UPDATE;")],
    ['G2-C.2R: el lock por linea del checkout (W1) vuelve a FOR UPDATE',
      (s) => conMig(s, 'AND business_id = p_business_id\n          FOR NO KEY UPDATE;', 'AND business_id = p_business_id\n          FOR UPDATE;')],
    ['G2-C.2R: la compra rapida (W2) vuelve a FOR UPDATE',
      (s) => conMig(s, '    ORDER BY id\n    FOR NO KEY UPDATE;', '    ORDER BY id\n    FOR UPDATE;')],
    ['G2-C.2R: la anulacion (W3) vuelve a FOR UPDATE sobre inventory',
      (s) => conMig(s, "IN ('producto','repuesto'))\n      ORDER BY id FOR NO KEY UPDATE;", "IN ('producto','repuesto'))\n      ORDER BY id FOR UPDATE;")],
    ['G2-C.2R: el helper vuelve a FOR UPDATE',
      (s) => conMig(s, '    ORDER BY i.id\n      FOR NO KEY UPDATE;', '    ORDER BY i.id\n      FOR UPDATE;')],
    ['G2-C.2R: la migracion deja de redefinir el checkout',
      (s) => conMig(s, 'CREATE OR REPLACE FUNCTION private.create_comprobante_checkout_atomic(', 'CREATE OR REPLACE FUNCTION private.otra_cosa(')],
    ['G2-C.2R: se pierde la prueba de "solo cambio el modo" (md5 revertido)',
      (s) => conMig(s, "md5(replace(v_src, 'FOR NO KEY UPDATE', 'FOR UPDATE')) IS DISTINCT FROM s.orig_md5", 'false')],
    ['G2-C.2R: se pierde la precondicion de drift (md5 contra main)', (s) => conMig(s, 'PRECONDICION 8:', 'NOTA 8:')],
    ['G2-C.2R: una migracion posterior redefine el checkout con inventory FOR UPDATE', (s) => posterior(s, `CREATE OR REPLACE FUNCTION private.create_comprobante_checkout_atomic(p_business_id uuid, p_idempotency_key text, p_request_hash text, p_payload jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM 1 FROM inventory WHERE business_id = p_business_id AND id IN (SELECT 1) ORDER BY id FOR UPDATE;
  RETURN '{}'::jsonb;
END $function$;`)],
    ['G2-C.2R: una migracion posterior agrega un writer con pre-lock ORDER BY id FOR UPDATE', (s) => posterior(s, `CREATE OR REPLACE FUNCTION public.ajuste_viejo(b uuid, p uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v int; BEGIN
  PERFORM 1 FROM public.inventory WHERE business_id = b AND id = p ORDER BY id FOR UPDATE;
  SELECT stock_quantity INTO v FROM public.inventory WHERE id = p AND business_id = b;
  UPDATE public.inventory SET stock_quantity = v + 1 WHERE id = p AND business_id = b;
END $f$;`)],
  ]

  // CONTROLES · lo que el guard NO debe marcar: un FOR UPDATE de OTRA tabla en un
  // writer de stock (la anulacion lo hace con comprobante, pagos y cuenta corriente).
  const CONTROLES = [
    ['un writer de stock posterior con FOR UPDATE de comprobantes y lock canonico de inventory', (s) => posterior(s, `CREATE OR REPLACE FUNCTION public.ajuste_ok(b uuid, c uuid, p uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v int; BEGIN
  PERFORM 1 FROM public.comprobantes WHERE id = c AND business_id = b FOR UPDATE;
  PERFORM private.lock_inventory_rows(b, ARRAY[p]);
  SELECT stock_quantity INTO v FROM public.inventory WHERE id = p AND business_id = b;
  UPDATE public.inventory SET stock_quantity = v - 1 WHERE id = p AND business_id = b;
END $f$;`)],
    ['una funcion posterior que no escribe stock y bloquea inventory_movements FOR UPDATE', (s) => posterior(s, `CREATE OR REPLACE FUNCTION public.lee_movs(m uuid)
 RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $f$
BEGIN PERFORM 1 FROM public.inventory_movements WHERE id = m FOR UPDATE; END $f$;`)],
  ]

  let fallos = 0
  for (const [nombre, mutar] of MUTACIONES) {
    const mutado = mutar(base)
    if (JSON.stringify(mutado) === JSON.stringify(base)) {
      console.error(`  ✖ ${nombre}: la mutacion NO aplico (el patron cambio) — el self-test estaria mintiendo`)
      fallos++; continue
    }
    if (run(mutado).length === 0) { console.error(`  ✖ ${nombre}: NO detectado`); fallos++ }
    else console.log(`  ✔ ${nombre}: detectado`)
  }
  for (const [nombre, mutar] of CONTROLES) {
    const r = run(mutar(base))
    if (r.length) { console.error(`  ✖ control "${nombre}": falso positivo -> ${r[0]}`); fallos++ }
    else console.log(`  ✔ control "${nombre}": no se marca (correcto)`)
  }
  if (fallos) { console.error(`SELF-TEST FALLO: ${fallos} mutacion(es)/control(es) fallido(s).`); process.exit(1) }
  console.log(`SELF-TEST OK: las ${MUTACIONES.length} mutaciones del contrato G2-C.2/G2-C.2R son detectadas y los ${CONTROLES.length} controles no dan falso positivo.`)
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const findings = run(load())
  if (findings.length) {
    console.error('GUARD G2-C.2 FALLO — el contrato de locks de inventario esta roto:')
    findings.forEach((x) => console.error('  · ' + x))
    process.exit(1)
  }
  console.log('GUARD G2-C.2 OK · helper private.lock_inventory_rows (INVOKER, por negocio, ORDER BY id, sin EXECUTE de API) '
    + '· W4/W5/W6/W7 bloquean antes de escribir stock · W7 acotado al negocio e identidad inmutable '
    + '· G2-C.2R: W1/W2/W3 bloquean inventory FOR NO KEY UPDATE y ningun writer canonico vuelve a FOR UPDATE sobre inventory '
    + '· ninguna migracion posterior reintroduce un read-modify-write de stock sin lock.')
  console.log('NOTA · alcance: NO cubre los writers de stock del navegador (registerMovement, import de Excel): G2-C.3.')
}
