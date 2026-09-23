#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// G2-C.1 · Guard de la autoridad del portal mayorista.
//
//   PEDIDO MAYORISTA = ESTADO COMERCIAL.
//   COMPROBANTE      = MOVIMIENTO ECONOMICO Y DE STOCK.
//
// La matriz SQL (tests/sql/g2c1_wholesale_stock_authority.test.sql) prueba el
// comportamiento sobre una base viva. Este guard cubre lo que ella no ve: el
// NAVEGADOR (que no corre en esa matriz) y el FUTURO (una migracion posterior
// que reabra una escritura directa o afloje una RPC).
//
// Invariantes protegidos:
//
//   1. portalService no vuelve a ser autoridad de stock: nada de
//      `_processWholesaleStock`, `Math.max(0`, escrituras de `inventory`,
//      `inventory_movements` ni de los marcadores `stock_*`.
//   2. portalService no escribe pedidos ni items por tabla: ni INSERT ni UPDATE.
//   3. `updateOrderStatus` y `updateCustomerStatus` llaman SOLO a su RPC y
//      exigen `businessId`; `createOrder` llama SOLO a la RPC de alta y NO manda
//      precio, subtotales, total, nombre, codigo, estado, negocio ni cliente.
//   4. De `wholesale_customers` el navegador solo escribe `last_login` (UPDATE)
//      y el alta neutra (INSERT sin campos administrativos).
//   5. Todo caller de esas funciones del portal pasa `businessId` primero.
//   6. Ningun otro archivo de src/ escribe pedidos, items o campos
//      administrativos de clientes.
//   7. La migracion G2-C.1 declara las tres RPC por firma exacta, SECDEF con
//      search_path minimo, sin EXECUTE para anon/PUBLIC, con su autoridad y su
//      lock; cierra INSERT/UPDATE directo de pedidos e items; limita
//      wholesale_customers por columnas; CHECK quantity > 0.
//   8. Ninguna migracion POSTERIOR reabre nada de eso.
//
// NO es un grep global: el alcance es el portal mayorista, sus tablas y sus
// RPC. Otros writers de inventario (G2-C.2) quedan fuera a proposito.
//
// `--self-test` muta cada invariante en memoria y exige que el guard lo detecte.
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MIG_DIR   = 'supabase/migrations'
const MIG_G2C1  = '20261005120000_g2c1_wholesale_stock_authority.sql'
const VERSION   = '20261005120000'
const SVC       = 'src/portal/services/portalService.ts'
const RPC_STATUS = 'update_wholesale_order_status_atomic'
const RPC_CREATE = 'create_wholesale_order_atomic'
const RPC_CLIENT = 'update_wholesale_customer_status_atomic'

// Columnas del alta del cliente (insertWholesaleCustomer). Todo lo demas es
// administrativo o server-owned.
const ALTA_CLIENTE = ['business_id', 'auth_user_id', 'name', 'business_name', 'email',
  'whatsapp', 'province', 'city', 'instagram']
const ADMIN_CLIENTE = /\b(approved|suspended|notes|tags|total_orders|total_spent|whatsapp_verified|whatsapp_code|whatsapp_code_expires_at|last_order_at|updated_at)\b/

const read = (p) => readFileSync(p, 'utf8')
const sinComentarios = (sql) => sql.replace(/^\s*--.*$/gm, '')

/**
 * Cadenas `.from('<tabla>')…` de `src`: el texto de la MISMA sentencia. El repo
 * no usa `;`, asi que se corta en la siguiente `.from(`, una linea en blanco o
 * el inicio de otra sentencia.
 */
function cadenas(src, tabla) {
  const out = []
  const re = new RegExp(`from\\(\\s*['"]${tabla}['"]\\s*\\)`, 'g')
  let m
  while ((m = re.exec(src))) {
    let resto = src.slice(m.index + m[0].length, m.index + m[0].length + 400)
    const corte = resto.search(/\.from\(|\n\s*\n|\b(await|const|let|return|if)\b/)
    if (corte >= 0) resto = resto.slice(0, corte)
    out.push(resto)
  }
  return out
}
const escribe = (src, tabla, verbos) =>
  cadenas(src, tabla).some(c => new RegExp(`\\.(${verbos})\\s*\\(`).test(c))

/** Escrituras a wholesale_customers que exceden lo que el navegador puede. */
function escriturasClienteIndebidas(src) {
  const f = []
  for (const c of cadenas(src, 'wholesale_customers')) {
    if (/\.(upsert|delete)\s*\(/.test(c)) f.push('upsert/delete de wholesale_customers')
    const upd = c.match(/\.update\(\s*\{([\s\S]*?)\}\s*\)/)
    if (upd && !/^\s*last_login\s*:[^,]*,?\s*$/.test(upd[1])) f.push('UPDATE de wholesale_customers distinto de last_login')
    if (/\.update\s*\(/.test(c) && !upd) f.push('UPDATE de wholesale_customers no literal')
  }
  return f
}

/** Cuerpo de la funcion exportada `nombre` de un archivo TS. */
function cuerpoFuncion(src, nombre) {
  const i = src.search(new RegExp(`export\\s+async\\s+function\\s+${nombre}\\s*\\(`))
  if (i < 0) return null
  const j = src.indexOf('\n}\n', i)
  return src.slice(i, j < 0 ? src.length : j + 2)
}

/** Argumentos de nivel superior de cada llamada a `fn(` en `src`. */
function llamadas(src, fn) {
  const out = []
  const re = new RegExp(`(?<![\\w.])${fn}\\s*\\(`, 'g')
  let m
  while ((m = re.exec(src))) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue
    let depth = 1, k = m.index + m[0].length, arg = ''
    const args = []
    while (k < src.length && depth > 0) {
      const ch = src[k]
      if ('([{'.includes(ch)) depth++
      if (')]}'.includes(ch)) depth--
      if (depth === 0) break
      if (ch === ',' && depth === 1) { args.push(arg.trim()); arg = '' } else arg += ch
      k++
    }
    if (arg.trim()) args.push(arg.trim())
    out.push({ args, texto: src.slice(m.index, k + 1) })
  }
  return out
}

function inspectServicio(svc) {
  const f = []
  if (/_processWholesaleStock/.test(svc)) f.push(`${SVC}: reaparecio _processWholesaleStock (writer de stock en el navegador)`)
  if (/Math\.max\(\s*0\s*,/.test(svc)) f.push(`${SVC}: reaparecio un clamp Math.max(0, …) (el P0 de G2-C)`)
  if (/from\(\s*['"]inventory_movements['"]\s*\)/.test(svc)) f.push(`${SVC}: el portal volvio a tocar inventory_movements desde el navegador`)
  if (escribe(svc, 'inventory', 'update|insert|upsert|delete')) f.push(`${SVC}: el portal volvio a escribir inventory desde el navegador`)
  if (/stock_processed|stock_movement_id/.test(svc)) f.push(`${SVC}: el portal volvio a leer o escribir marcadores de stock`)
  if (escribe(svc, 'wholesale_orders', 'insert|update|upsert')) f.push(`${SVC}: volvio la escritura directa de wholesale_orders (bypass de las RPC)`)
  if (escribe(svc, 'wholesale_order_items', 'insert|update|upsert')) f.push(`${SVC}: volvio la escritura directa de wholesale_order_items`)
  if (/increment_wholesale_customer_stats/.test(svc)) f.push(`${SVC}: el navegador vuelve a pedir estadisticas de cliente (no son autoridad suya)`)
  for (const e of escriturasClienteIndebidas(svc)) f.push(`${SVC}: ${e}`)

  // El alta del cliente: solo columnas del registro.
  const alta = svc.match(/from\(\s*['"]wholesale_customers['"]\s*\)\s*\.insert\(\s*\{([\s\S]*?)\}\s*\)/)
  if (!alta) f.push(`${SVC}: no se encontro el alta del cliente (insertWholesaleCustomer)`)
  else if (ADMIN_CLIENTE.test(alta[1])) f.push(`${SVC}: el alta del cliente manda un campo administrativo`)

  // updateOrderStatus: businessId obligatorio y SOLO la RPC.
  const uos = cuerpoFuncion(svc, 'updateOrderStatus')
  if (!uos) f.push(`${SVC}: no existe updateOrderStatus`)
  else {
    if (!/updateOrderStatus\s*\(\s*businessId\s*:\s*string\s*,/.test(uos)) f.push(`${SVC}: updateOrderStatus dejo de exigir businessId como primer parametro`)
    if (!/supabase\.rpc\(\s*WHOLESALE_ORDER_STATUS_RPC\b/.test(uos)) f.push(`${SVC}: updateOrderStatus dejo de llamar a la RPC canonica`)
    if (/\.from\(/.test(uos)) f.push(`${SVC}: updateOrderStatus volvio a escribir tablas directo`)
    if (!/if\s*\(\s*error\s*\)\s*throw\b/.test(uos)) f.push(`${SVC}: updateOrderStatus dejo de propagar el error de la RPC`)
  }

  // updateCustomerStatus: businessId obligatorio y SOLO la RPC.
  const ucs = cuerpoFuncion(svc, 'updateCustomerStatus')
  if (!ucs) f.push(`${SVC}: no existe updateCustomerStatus`)
  else {
    if (!/updateCustomerStatus\s*\(\s*businessId\s*:\s*string\s*,/.test(ucs)) f.push(`${SVC}: updateCustomerStatus dejo de exigir businessId como primer parametro`)
    if (!/supabase\.rpc\(\s*WHOLESALE_CUSTOMER_STATUS_RPC\b/.test(ucs)) f.push(`${SVC}: updateCustomerStatus dejo de llamar a la RPC canonica`)
    if (/\.from\(/.test(ucs)) f.push(`${SVC}: updateCustomerStatus volvio a escribir tablas directo`)
    if (!/if\s*\(\s*error\s*\)\s*throw\b/.test(ucs)) f.push(`${SVC}: updateCustomerStatus dejo de propagar el error de la RPC`)
  }

  // createOrder: SOLO la RPC y SOLO producto + cantidad por linea.
  const co = cuerpoFuncion(svc, 'createOrder')
  if (!co) f.push(`${SVC}: no existe createOrder`)
  else {
    if (!/supabase\.rpc\(\s*WHOLESALE_CREATE_ORDER_RPC\b/.test(co)) f.push(`${SVC}: createOrder dejo de llamar a la RPC de alta`)
    if (/\.from\(/.test(co)) f.push(`${SVC}: createOrder volvio a escribir tablas directo`)
    if (/unitPrice|unit_price|subtotal|\btotal\b|productName|product_name|productCode|product_code|business_?[iI]d|customer_?[iI]d|\bstatus\b|admin_notes/.test(co)) {
      f.push(`${SVC}: createOrder manda al servidor precio/total/nombre/codigo/estado/negocio/cliente (no son autoridad del navegador)`)
    }
    const items = co.match(/p_items\s*:\s*([\s\S]*?\)\)\s*\)?)\s*,/)
    if (!items || !/inventory_item_id\s*:/.test(items[1]) || !/quantity\s*:/.test(items[1])) {
      f.push(`${SVC}: createOrder dejo de mandar solo inventory_item_id + quantity por linea`)
    }
  }

  for (const [c, rpc] of [['WHOLESALE_ORDER_STATUS_RPC', RPC_STATUS], ['WHOLESALE_CREATE_ORDER_RPC', RPC_CREATE],
                          ['WHOLESALE_CUSTOMER_STATUS_RPC', RPC_CLIENT]]) {
    if (!new RegExp(`${c}\\s*=\\s*['"]${rpc}['"]`).test(svc)) f.push(`${SVC}: ${c} ya no apunta a ${rpc}`)
  }
  return f
}

/** Callers del portal: `businessId` como primer argumento, sin fallback. */
function inspectCallers(archivos) {
  const f = []
  for (const fn of ['updateOrderStatus', 'updateCustomerStatus']) {
    const importa = new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*['"][^'"]*portal/services/portalService['"]`)
    let n = 0
    for (const { nombre, src } of archivos) {
      if (!importa.test(src)) continue
      for (const { args, texto } of llamadas(src, fn)) {
        n++
        // Exactamente `businessId`: tambien descarta `businessId || undefined`
        // y `undefined`, que eran la forma del bug original.
        if (args.length < 3 || args[0] !== 'businessId') {
          f.push(`${nombre}: ${fn} sin businessId como primer argumento: ${texto.replace(/\s+/g, ' ')}`)
        }
      }
    }
    if (n === 0) f.push(`no se encontro ningun caller de ${fn} del portal: el guard no esta mirando nada`)
  }
  return f
}

/** Nadie mas en src/ escribe pedidos, items o campos administrativos de clientes. */
function inspectBypassSrc(archivos) {
  const f = []
  for (const { nombre, src } of archivos) {
    if (nombre === SVC) continue // lo cubre inspectServicio con su propio mensaje
    if (escribe(src, 'wholesale_orders', 'insert|update|upsert')) f.push(`${nombre}: escritura directa de wholesale_orders (bypass de las RPC)`)
    if (escribe(src, 'wholesale_order_items', 'insert|update|upsert')) f.push(`${nombre}: escritura directa de wholesale_order_items`)
    if (cadenas(src, 'wholesale_customers').some(c => /\.(insert|update|upsert|delete)\s*\(/.test(c))) {
      f.push(`${nombre}: escritura directa de wholesale_customers fuera de portalService`)
    }
  }
  return f
}

/** Declaracion completa (hasta el `$$;`) de la funcion con la firma dada. */
function declaracion(sql, firmaRe) {
  const i = sql.search(firmaRe)
  if (i < 0) return null
  const fin = sql.indexOf('$$;', sql.indexOf('AS $$', i))
  const decl = sql.slice(i, fin)
  return { decl, cuerpo: decl.slice(decl.indexOf('AS $$')) }
}

function inspectRpcComun(sql, nombre, firmaSql, firmaRe, f) {
  const d = declaracion(sql, firmaRe)
  if (!d) { f.push(`no declara ${nombre} por firma exacta`); return null }
  if (!/SECURITY\s+DEFINER/i.test(d.decl)) f.push(`${nombre} dejo de ser SECURITY DEFINER`)
  if (!/SET\s+search_path\s*=\s*pg_catalog\s*,\s*pg_temp\s*\n/i.test(d.decl)) f.push(`${nombre} no fija search_path = pg_catalog, pg_temp`)
  if (!/auth\.uid\(\)/.test(d.cuerpo)) f.push(`${nombre} dejo de derivar la identidad de auth.uid()`)
  if (!/FOR\s+UPDATE/i.test(d.cuerpo)) f.push(`${nombre} dejo de bloquear su fila (FOR UPDATE)`)
  if (/inventory_movements|stock_processed|stock_movement_id|stock_quantity|UPDATE\s+public\.inventory\b|INSERT\s+INTO\s+public\.inventory\b/i.test(d.cuerpo)) {
    f.push(`${nombre} escribe inventario o marcadores: se volvio un writer de stock`)
  }
  const fn = `public\\.${nombre}\\(${firmaSql}\\)`
  if (!new RegExp(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`).test(sql)) f.push(`falta REVOKE ... FROM PUBLIC sobre ${nombre}`)
  if (!new RegExp(`REVOKE ALL ON FUNCTION ${fn} FROM anon;`).test(sql)) f.push(`falta REVOKE ... FROM anon sobre ${nombre}`)
  if (new RegExp(`GRANT[^;]*ON FUNCTION ${fn}[^;]*\\b(anon|PUBLIC)\\b`, 'i').test(sql)) f.push(`${nombre} recibe EXECUTE para anon/PUBLIC`)
  if (!new RegExp(`GRANT EXECUTE ON FUNCTION ${fn} TO authenticated;`).test(sql)) f.push(`authenticated no recibe EXECUTE sobre ${nombre}`)
  return d
}

function inspectMigracion(mig) {
  const f = []
  const sql = sinComentarios(mig)

  // RPC de estado.
  const st = inspectRpcComun(sql, RPC_STATUS, 'uuid, uuid, text, text',
    /CREATE\s+FUNCTION\s+public\.update_wholesale_order_status_atomic\(\s*p_business_id\s+uuid\s*,\s*p_order_id\s+uuid\s*,\s*p_status\s+text\s*,\s*p_admin_notes\s+text\s+DEFAULT\s+NULL\s*\)/i, f)
  if (st) {
    if (!/public\.current_user_can_in_business\(\s*p_business_id\s*,\s*'wholesale'\s*\)/.test(st.cuerpo)) f.push(`${RPC_STATUS} perdio la autoridad tenant-bound`)
    if (/inventory/i.test(st.cuerpo)) f.push(`${RPC_STATUS} toca inventario`)
  }

  // RPC de alta.
  const al = inspectRpcComun(sql, RPC_CREATE, 'text, jsonb, text',
    /CREATE\s+FUNCTION\s+public\.create_wholesale_order_atomic\(\s*p_portal_slug\s+text\s*,\s*p_items\s+jsonb\s*,\s*p_notes\s+text\s+DEFAULT\s+NULL\s*\)/i, f)
  if (al) {
    const c = al.cuerpo
    if (!/public\.get_wholesale_portal_features\(\s*p_portal_slug\s*\)/.test(c)) f.push(`${RPC_CREATE} dejo de usar la autoridad del portal (get_wholesale_portal_features)`)
    if (!/approved\s+IS\s+NOT\s+TRUE/i.test(c)) f.push(`${RPC_CREATE} dejo de exigir cliente aprobado`)
    if (!/suspended\s+IS\s+TRUE/i.test(c)) f.push(`${RPC_CREATE} dejo de rechazar clientes suspendidos`)
    // Dos lecturas del cliente (el conteo que exige exactamente uno y el lock):
    // las dos tienen que atarlo al actor Y al negocio del portal.
    if ((c.match(/wc\.auth_user_id\s*=\s*v_actor/g) || []).length < 2
        || (c.match(/wc\.business_id\s*=\s*v_business/g) || []).length < 2) {
      f.push(`${RPC_CREATE} dejo de atar el cliente al actor Y al negocio del portal`)
    }
    if (!/i\.business_id\s*=\s*v_business/.test(c)) f.push(`${RPC_CREATE} dejo de atar el inventario al negocio del pedido`)
    if (!/i\.is_active\s+IS\s+TRUE/i.test(c) || !/i\.visible_in_wholesale\s+IS\s+TRUE/i.test(c)) f.push(`${RPC_CREATE} dejo de exigir producto activo y visible en mayorista`)
    if (!/COALESCE\(\s*v_inv\.precio_mayorista\s*,\s*0\s*\)\s*>\s*0/.test(c) || !/v_inv\.sale_price/.test(c)) f.push(`${RPC_CREATE} dejo de derivar el precio de la base (precio_mayorista > 0 ? precio_mayorista : sale_price)`)
    if (/v_elem->>'(unit_price|subtotal|total|product_name|product_code|business_id|status)'/.test(c)) f.push(`${RPC_CREATE} vuelve a leer del navegador un dato que debe decidir la base`)
    if (!/EMPTY_ORDER/.test(c)) f.push(`${RPC_CREATE} dejo de rechazar pedidos sin items`)
  }

  // RPC de clientes.
  const cl = inspectRpcComun(sql, RPC_CLIENT, 'uuid, uuid, boolean, boolean, text',
    /CREATE\s+FUNCTION\s+public\.update_wholesale_customer_status_atomic\(\s*p_business_id\s+uuid\s*,\s*p_customer_id\s+uuid\s*,\s*p_approved\s+boolean\s+DEFAULT\s+NULL\s*,\s*p_suspended\s+boolean\s+DEFAULT\s+NULL\s*,\s*p_notes\s+text\s+DEFAULT\s+NULL\s*\)/i, f)
  if (cl && !/public\.current_user_can_in_business\(\s*p_business_id\s*,\s*'wholesale'\s*\)/.test(cl.cuerpo)) f.push(`${RPC_CLIENT} perdio la autoridad tenant-bound`)

  // Pedidos e items: sin INSERT ni UPDATE directo, sin policies de escritura.
  for (const t of ['wholesale_orders', 'wholesale_order_items']) {
    for (const verbo of ['UPDATE', 'INSERT']) {
      if (!new RegExp(`REVOKE ${verbo} ON TABLE public\\.${t}\\s+FROM[^;]*\\bauthenticated\\b`).test(sql)) f.push(`no se revoca el ${verbo} directo de ${t}`)
    }
    if (new RegExp(`GRANT\\s+(INSERT|UPDATE)[^;]*ON\\s+(TABLE\\s+)?public\\.${t}\\b`).test(sql)) f.push(`la migracion concede INSERT/UPDATE directo sobre ${t}`)
  }
  for (const [pol, t] of [['wo_staff_update', 'wholesale_orders'], ['woi_staff_update', 'wholesale_order_items'],
                          ['wo_customer_insert', 'wholesale_orders'], ['wo_staff_insert', 'wholesale_orders'],
                          ['woi_customer_insert', 'wholesale_order_items'], ['woi_staff_insert', 'wholesale_order_items']]) {
    if (!new RegExp(`DROP POLICY IF EXISTS ${pol}\\s+ON public\\.${t};`).test(sql)) f.push(`sigue la policy ${pol}`)
  }

  // Clientes: UPDATE solo last_login; INSERT solo el alta; sin escritura directa del staff.
  if (!/REVOKE UPDATE ON TABLE public\.wholesale_customers FROM[^;]*\bauthenticated\b/.test(sql)) f.push('no se revoca el UPDATE de tabla de wholesale_customers')
  const gUpd = [...sql.matchAll(/GRANT UPDATE \(([^)]*)\)\s*ON TABLE public\.wholesale_customers TO authenticated;/g)]
  if (gUpd.length !== 1 || gUpd[0][1].trim() !== 'last_login') f.push('el UPDATE directo de wholesale_customers excede last_login')
  if (!/REVOKE INSERT ON TABLE public\.wholesale_customers FROM[^;]*\bauthenticated\b/.test(sql)) f.push('no se revoca el INSERT de tabla de wholesale_customers')
  const gIns = sql.match(/GRANT INSERT \(([^)]*)\)\s*ON TABLE public\.wholesale_customers TO authenticated;/)
  if (!gIns) f.push('falta el GRANT INSERT por columnas del alta del cliente')
  else {
    const cols = gIns[1].split(',').map(s => s.trim()).sort()
    if (JSON.stringify(cols) !== JSON.stringify([...ALTA_CLIENTE].sort())) f.push(`el alta del cliente concede columnas distintas del registro: ${cols.join(', ')}`)
  }
  for (const pol of ['wc_staff_update', 'wc_staff_insert']) {
    if (!new RegExp(`DROP POLICY IF EXISTS ${pol} ON public\\.wholesale_customers;`).test(sql)) f.push(`sigue la policy ${pol}`)
  }
  const own = sql.match(/ALTER POLICY wc_own_insert ON public\.wholesale_customers\s+WITH CHECK \(([\s\S]*?)\);\n/)
  if (!own || !/approved IS FALSE/.test(own[1]) || !/suspended IS FALSE/.test(own[1]) || !/total_spent = 0/.test(own[1])) {
    f.push('wc_own_insert no exige el estado administrativo neutro')
  }

  if (!/ADD CONSTRAINT wholesale_order_items_quantity_positive CHECK \(quantity > 0\)/.test(sql)) f.push('falta el CHECK (quantity > 0)')
  for (let n = 1; n <= 14; n++) {
    if (!new RegExp(`POSTCONDICION ${n}:`).test(sql)) f.push(`se perdio la POSTCONDICION ${n}`)
  }
  return f.map(x => `${MIG_DIR}/${MIG_G2C1}: ${x}`)
}

/** Ninguna migracion posterior reabre lo que G2-C.1 cerro. */
function inspectPosteriores(archivos) {
  const f = []
  for (const { nombre, sql: crudo } of archivos) {
    if (nombre.split('_')[0] <= VERSION) continue
    const sql = sinComentarios(crudo)
    const pedidos = '(?:public\\.)?(?:wholesale_orders|wholesale_order_items)\\b'
    if (new RegExp(`GRANT\\s+[^;]*\\b(INSERT|UPDATE|ALL)\\b[^;]*\\bON\\s+(?:TABLE\\s+)?${pedidos}[^;]*\\bTO\\b`, 'i').test(sql)) {
      f.push(`${nombre}: vuelve a conceder INSERT/UPDATE/ALL sobre pedidos o items mayoristas`)
    }
    if (new RegExp(`CREATE\\s+POLICY[^;]*\\bON\\s+${pedidos}[^;]*\\bFOR\\s+(INSERT|UPDATE|ALL)\\b`, 'i').test(sql)) {
      f.push(`${nombre}: crea una policy de escritura sobre pedidos o items mayoristas`)
    }
    // wholesale_customers: solo last_login y el alta neutra.
    const upd = [...sql.matchAll(/GRANT\s+([^;]*?)\s+ON\s+(?:TABLE\s+)?(?:public\.)?wholesale_customers\b[^;]*;/gi)]
    for (const [, privs] of upd) {
      if (/\bALL\b/i.test(privs) || /\bUPDATE\b(?!\s*\(\s*last_login\s*\))/i.test(privs)) {
        f.push(`${nombre}: vuelve a conceder UPDATE administrativo sobre wholesale_customers`)
      }
      if (/\bINSERT\b(?!\s*\()/i.test(privs) || (/\bINSERT\s*\(/i.test(privs) && ADMIN_CLIENTE.test(privs))) {
        f.push(`${nombre}: vuelve a conceder un INSERT administrativo sobre wholesale_customers`)
      }
    }
    if (/CREATE\s+POLICY[^;]*\bON\s+(?:public\.)?wholesale_customers\b[^;]*\bFOR\s+(UPDATE|ALL)\b/i.test(sql)) {
      f.push(`${nombre}: crea una policy de UPDATE/ALL sobre wholesale_customers`)
    }
    for (const rpc of [RPC_STATUS, RPC_CREATE, RPC_CLIENT]) {
      if (new RegExp(`GRANT[^;]*ON\\s+FUNCTION\\s+public\\.${rpc}\\b[^;]*\\b(anon|PUBLIC)\\b`, 'i').test(sql)) {
        f.push(`${nombre}: concede EXECUTE de ${rpc} a anon/PUBLIC`)
      }
      const redef = sql.match(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${rpc}\\b[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`, 'i'))
      if (redef && /inventory_movements|stock_processed|stock_movement_id|stock_quantity|UPDATE\s+public\.inventory\b/i.test(redef[1])) {
        f.push(`${nombre}: redefine ${rpc} escribiendo inventario (writer de stock)`)
      }
      if (redef && rpc === RPC_CREATE
          && (!/precio_mayorista/.test(redef[1]) || !/approved\s+IS\s+NOT\s+TRUE/i.test(redef[1]) || !/get_wholesale_portal_features/.test(redef[1]))) {
        f.push(`${nombre}: redefine ${rpc} perdiendo precio de la base, cliente aprobado o autoridad del portal`)
      }
    }
    if (/DROP\s+CONSTRAINT\s+(IF\s+EXISTS\s+)?wholesale_order_items_quantity_positive/i.test(sql)) f.push(`${nombre}: elimina el CHECK quantity > 0`)
  }
  return f
}

function run(s) {
  return [
    ...inspectServicio(s.svc),
    ...inspectCallers(s.src),
    ...inspectBypassSrc(s.src),
    ...inspectMigracion(s.mig),
    ...inspectPosteriores(s.migraciones),
  ]
}

function leerSrc(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) leerSrc(p, out)
    else if (/\.tsx?$/.test(e)) out.push({ nombre: p.replace(/\\/g, '/'), src: read(p) })
  }
  return out
}

function load() {
  return {
    svc: read(SVC),
    src: leerSrc('src'),
    mig: read(`${MIG_DIR}/${MIG_G2C1}`),
    migraciones: readdirSync(MIG_DIR).filter(n => /^\d+_.*\.sql$/.test(n)).sort()
      .map(nombre => ({ nombre, sql: read(`${MIG_DIR}/${nombre}`) })),
  }
}

// ── self-test ────────────────────────────────────────────────────────────────
const conSrc = (s, archivo, mutar) => ({
  ...s,
  src: s.src.map(x => x.nombre === archivo ? { ...x, src: mutar(x.src) } : x),
  svc: archivo === SVC ? mutar(s.svc) : s.svc,
})
const conPosterior = (s, sql) => ({
  ...s, migraciones: [...s.migraciones, { nombre: '20261099120000_regresion_hipotetica.sql', sql }],
})
const MAYORISTA = 'src/pages/Mayorista.tsx'
const CART      = 'src/portal/pages/PortalCart.tsx'
const conMig    = (s, desde, hacia) => ({ ...s, mig: typeof desde === 'string' ? s.mig.replace(desde, hacia) : s.mig.replace(desde, hacia) })

function selfTest() {
  const base = load()
  const limpio = run(base)
  if (limpio.length) {
    console.error('SELF-TEST FALLO: el arbol actual ya viola el contrato:')
    limpio.forEach(f => console.error('  · ' + f))
    process.exit(1)
  }

  const ANCLA = '/** RPC canónica de cambio de estado'
  const plantar = (codigo) => s => conSrc(s, SVC, x => x.replace(ANCLA, codigo + '\n' + ANCLA))
  const MUTACIONES = [
    // ── navegador: stock ──
    ['vuelve _processWholesaleStock al portal', plantar('async function _processWholesaleStock() {}')],
    ['vuelve el clamp Math.max(0, prev + delta)', plantar('const clamp = (p: number, d: number) => Math.max(0, p + d)')],
    ['el navegador vuelve a escribir inventory', plantar("export async function _mal() { await supabase.from('inventory').update({ stock_quantity: 0 }) }")],
    ['el navegador vuelve a insertar inventory_movements', plantar("export async function _mal() { await supabase.from('inventory_movements').insert({ quantity: -1 }) }")],
    ['el navegador vuelve a escribir stock_processed', plantar("export async function _mal() { await supabase.from('wholesale_order_items').update({ stock_processed: true }) }")],
    // ── navegador: pedidos ──
    ['vuelve el UPDATE directo de wholesale_orders.status', plantar("export async function _mal(id: string) { await supabase.from('wholesale_orders').update({ status: 'approved' }).eq('id', id) }")],
    ['vuelve el INSERT directo de un pedido', plantar("export async function _mal() { await supabase.from('wholesale_orders').insert({ total: 1 }) }")],
    ['vuelve el INSERT directo de items', plantar("export async function _mal() { await supabase.from('wholesale_order_items').insert([{ unit_price: 1 }]) }")],
    ['createOrder vuelve a mandar el precio', s => conSrc(s, SVC, x => x.replace('({ inventory_item_id: i.inventoryItemId, quantity: i.quantity })',
      '({ inventory_item_id: i.inventoryItemId, quantity: i.quantity, unit_price: i.unitPrice })'))],
    ['createOrder vuelve a mandar el total', s => conSrc(s, SVC, x => x.replace("p_notes:       input.notes?.trim() || null,",
      "p_notes:       input.notes?.trim() || null,\n    p_total:       input.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0),"))],
    ['createOrder deja de usar la RPC de alta', s => conSrc(s, SVC, x => x.replace('supabase.rpc(WHOLESALE_CREATE_ORDER_RPC', 'supabase.rpc(OTRA_RPC'))],
    ['vuelve el pedido de estadisticas del navegador', plantar("export const _s = () => supabase.rpc('increment_wholesale_customer_stats', {})")],
    // ── navegador: RPC de estado ──
    ['updateOrderStatus deja de usar la RPC', s => conSrc(s, SVC, x => x.replace('supabase.rpc(WHOLESALE_ORDER_STATUS_RPC', 'supabase.rpc(OTRA_RPC'))],
    ['updateOrderStatus vuelve a tener businessId opcional', s => conSrc(s, SVC, x => x.replace(/updateOrderStatus\(\n\s*businessId: string,/, 'updateOrderStatus(\n  businessId?: string,'))],
    ['updateOrderStatus se traga el error', s => conSrc(s, SVC, x => x.replace(/(export async function updateOrderStatus[\s\S]*?)if \(error\) throw new Error\(error\.message\)/, '$1if (error) return null as never'))],
    // ── navegador: clientes ──
    ['updateCustomerStatus vuelve al UPDATE directo', s => conSrc(s, SVC, x => x.replace('supabase.rpc(WHOLESALE_CUSTOMER_STATUS_RPC', 'supabase.rpc(OTRA_RPC'))],
    ['updateCustomerStatus vuelve a tener businessId opcional', s => conSrc(s, SVC, x => x.replace(/updateCustomerStatus\(\n\s*businessId: string,/, 'updateCustomerStatus(\n  businessId?: string,'))],
    ['el navegador vuelve a aprobar clientes por tabla', plantar("export async function _mal(id: string) { await supabase.from('wholesale_customers').update({ approved: true }).eq('id', id) }")],
    ['el alta del cliente vuelve a mandar approved', s => conSrc(s, SVC, x => x.replace('      instagram:     meta.instagram,', '      instagram:     meta.instagram,\n      approved:      true,'))],
    ['loginCustomer escribe algo mas que last_login', s => conSrc(s, SVC, x => x.replace('.update({ last_login: new Date().toISOString() })',
      '.update({ last_login: new Date().toISOString(), suspended: false })'))],
    // ── callers ──
    ['un caller de estado vuelve a omitir businessId', s => conSrc(s, MAYORISTA, x => x.replace('updateOrderStatus(businessId, order.id, status)', 'updateOrderStatus(order.id, status)'))],
    ['un caller de estado pasa businessId con fallback a undefined', s => conSrc(s, MAYORISTA, x => x.replace("updateOrderStatus(businessId, order.id, 'invoiced')",
      "updateOrderStatus(businessId || undefined, order.id, 'invoiced')"))],
    ['un caller de clientes omite businessId', s => conSrc(s, MAYORISTA, x => x.replace('updateCustomerStatus(businessId, cliente.id, patch)', 'updateCustomerStatus(cliente.id, patch)'))],
    ['otro archivo de src escribe el pedido directo', s => conSrc(s, MAYORISTA, x => x.replace('const handleCambiarEstado',
      "const _bypass = () => supabase.from('wholesale_orders').update({ status: 'approved' })\n  const handleCambiarEstado"))],
    ['otro archivo de src escribe un cliente directo', s => conSrc(s, CART, x => x.replace('export function PortalCart()',
      "const _mal = () => supabase.from('wholesale_customers').update({ approved: true })\nexport function PortalCart()"))],
    // ── migracion: RPC de estado ──
    ['la RPC de estado deja de ser SECURITY DEFINER', s => conMig(s, /(update_wholesale_order_status_atomic\([\s\S]*?VOLATILE\n)SECURITY DEFINER/, '$1SECURITY INVOKER')],
    ['la RPC de estado deja de fijar search_path minimo', s => conMig(s, /(update_wholesale_order_status_atomic\([\s\S]*?)SET search_path = pg_catalog, pg_temp\nAS \$\$/, '$1SET search_path = public, pg_temp\nAS $$')],
    ['la RPC de estado pierde la autoridad tenant-bound', s => conMig(s, "  IF NOT public.current_user_can_in_business(p_business_id, 'wholesale') THEN\n    -- Generico", "  IF NOT true THEN\n    -- Generico")],
    ['la RPC de estado pierde el FOR UPDATE', s => conMig(s, '   FOR UPDATE;\n\n  IF NOT FOUND THEN\n    RAISE EXCEPTION \'WHOLESALE_ORDER_NOT_FOUND\'', ';\n\n  IF NOT FOUND THEN\n    RAISE EXCEPTION \'WHOLESALE_ORDER_NOT_FOUND\'')],
    ['la RPC de estado vuelve a mover stock', s => conMig(s, '  IF v_changed THEN\n    UPDATE public.wholesale_orders', '  IF v_changed THEN\n    UPDATE public.inventory SET stock_quantity = stock_quantity - 1;\n    UPDATE public.wholesale_orders')],
    ['la RPC de estado recibe EXECUTE para anon', s => conMig(s, 'status_atomic(uuid, uuid, text, text) TO authenticated;', 'status_atomic(uuid, uuid, text, text) TO authenticated, anon;')],
    ['se pierde el REVOKE FROM anon de la RPC de estado', s => conMig(s, /REVOKE ALL ON FUNCTION public\.update_wholesale_order_status_atomic\(uuid, uuid, text, text\) FROM anon;\n/, '')],
    // ── migracion: RPC de alta ──
    ['el alta deja de usar la autoridad del portal', s => conMig(s, 'v_features := public.get_wholesale_portal_features(p_portal_slug);', "v_features := '{\"mayorista\":true,\"active\":true}'::jsonb;")],
    ['el alta deja de exigir cliente aprobado', s => conMig(s, 'IF v_customer.approved IS NOT TRUE THEN', 'IF false THEN')],
    ['el alta deja de rechazar suspendidos', s => conMig(s, 'IF v_customer.suspended IS TRUE THEN', 'IF false THEN')],
    ['el alta deja de atar el cliente al negocio', s => conMig(s, /(SELECT count\(\*\) INTO v_n\n    FROM public\.wholesale_customers wc\n   WHERE wc\.auth_user_id = v_actor\n)     AND wc\.business_id = v_business;/, '$1;')],
    ['el alta deja de atar el inventario al negocio', s => conMig(s, '       AND i.business_id = v_business\n', '')],
    ['el alta deja de exigir producto visible', s => conMig(s, '       AND i.visible_in_wholesale IS TRUE;', ';')],
    ['el alta vuelve a tomar el precio del navegador', s => conMig(s, /v_price := CASE WHEN COALESCE\(v_inv\.precio_mayorista, 0\) > 0\n\s*THEN v_inv\.precio_mayorista\n\s*ELSE v_inv\.sale_price END;/, "v_price := (v_elem->>'unit_price')::numeric;")],
    ['el alta pierde el lock del cliente', s => conMig(s, '     AND wc.business_id = v_business\n   FOR UPDATE;', '     AND wc.business_id = v_business;')],
    ['el alta acepta pedidos vacios', s => conMig(s, "RAISE EXCEPTION 'EMPTY_ORDER' USING ERRCODE = '22023';", 'NULL;')],
    ['el alta recibe EXECUTE para anon', s => conMig(s, 'create_wholesale_order_atomic(text, jsonb, text) TO authenticated;', 'create_wholesale_order_atomic(text, jsonb, text) TO authenticated, anon;')],
    ['el alta mueve stock', s => conMig(s, '  UPDATE public.wholesale_customers\n     SET last_order_at = now()', '  UPDATE public.inventory SET stock_quantity = stock_quantity - 1;\n  UPDATE public.wholesale_customers\n     SET last_order_at = now()')],
    // ── migracion: cierres de pedidos ──
    ['se deja el INSERT directo de pedidos', s => conMig(s, /REVOKE INSERT ON TABLE public\.wholesale_orders\s+FROM PUBLIC, anon, authenticated;/, '')],
    ['se deja el UPDATE directo de pedidos', s => conMig(s, /REVOKE UPDATE ON TABLE public\.wholesale_orders\s+FROM PUBLIC, anon, authenticated;/, '')],
    ['la migracion concede INSERT por columnas sobre items', s => conMig(s, 'REVOKE INSERT ON TABLE public.wholesale_order_items FROM PUBLIC, anon, authenticated;',
      'REVOKE INSERT ON TABLE public.wholesale_order_items FROM PUBLIC, anon, authenticated;\nGRANT INSERT (order_id, unit_price) ON TABLE public.wholesale_order_items TO authenticated;')],
    ['se deja la policy wo_customer_insert', s => conMig(s, /DROP POLICY IF EXISTS wo_customer_insert\s+ON public\.wholesale_orders;/, '')],
    ['se deja la policy wo_staff_update', s => conMig(s, /DROP POLICY IF EXISTS wo_staff_update\s+ON public\.wholesale_orders;/, '')],
    // ── migracion: clientes ──
    ['la RPC de clientes pierde la autoridad', s => conMig(s, /(CREATE FUNCTION public\.update_wholesale_customer_status_atomic[\s\S]*?)IF NOT public\.current_user_can_in_business\(p_business_id, 'wholesale'\) THEN/, '$1IF NOT true THEN')],
    ['la RPC de clientes recibe EXECUTE para anon', s => conMig(s, 'boolean, boolean, text) TO authenticated;', 'boolean, boolean, text) TO authenticated, anon;')],
    ['el cliente vuelve a poder hacer UPDATE de approved', s => conMig(s, 'GRANT UPDATE (last_login) ON TABLE public.wholesale_customers TO authenticated;',
      'GRANT UPDATE (last_login, approved) ON TABLE public.wholesale_customers TO authenticated;')],
    ['se deja el UPDATE de tabla de clientes', s => conMig(s, 'REVOKE UPDATE ON TABLE public.wholesale_customers FROM PUBLIC, anon, authenticated;', '')],
    ['el alta del cliente concede approved', s => conMig(s, '              province, city, instagram)\n  ON TABLE public.wholesale_customers', '              province, city, instagram, approved)\n  ON TABLE public.wholesale_customers')],
    ['se deja la policy wc_staff_update', s => conMig(s, 'DROP POLICY IF EXISTS wc_staff_update ON public.wholesale_customers;', '')],
    ['wc_own_insert deja de exigir estado neutro', s => conMig(s, '    AND approved IS FALSE\n', '')],
    ['se pierde el CHECK quantity > 0', s => conMig(s, 'wholesale_order_items_quantity_positive CHECK (quantity > 0)', 'wholesale_order_items_quantity_positive CHECK (quantity <> 0)')],
    ['se pierde una postcondicion', s => conMig(s, /POSTCONDICION 12:/g, 'NOTA 12:')],
    // ── migraciones posteriores ──
    ['una migracion posterior reabre el UPDATE directo de pedidos', s => conPosterior(s, 'GRANT UPDATE ON TABLE public.wholesale_orders TO authenticated;')],
    ['una migracion posterior reabre el INSERT de items', s => conPosterior(s, 'GRANT INSERT ON TABLE public.wholesale_order_items TO authenticated;')],
    ['una migracion posterior concede INSERT por columnas de pedidos', s => conPosterior(s, 'GRANT INSERT (business_id, total) ON TABLE public.wholesale_orders TO authenticated;')],
    ['una migracion posterior crea una policy de INSERT de pedidos', s => conPosterior(s, 'CREATE POLICY wo_x ON public.wholesale_orders FOR INSERT TO authenticated WITH CHECK (true);')],
    ['una migracion posterior devuelve UPDATE de approved a clientes', s => conPosterior(s, 'GRANT UPDATE (approved) ON public.wholesale_customers TO authenticated;')],
    ['una migracion posterior devuelve UPDATE de tabla a clientes', s => conPosterior(s, 'GRANT SELECT, UPDATE ON TABLE public.wholesale_customers TO authenticated;')],
    ['una migracion posterior devuelve INSERT de tabla a clientes', s => conPosterior(s, 'GRANT INSERT ON public.wholesale_customers TO authenticated;')],
    ['una migracion posterior crea una policy de UPDATE de clientes', s => conPosterior(s, 'CREATE POLICY wc_x ON public.wholesale_customers FOR UPDATE TO authenticated USING (true);')],
    ['una migracion posterior da EXECUTE del alta a anon', s => conPosterior(s, 'GRANT EXECUTE ON FUNCTION public.create_wholesale_order_atomic(text, jsonb, text) TO anon;')],
    ['una migracion posterior redefine el alta con precio del navegador', s => conPosterior(s,
      "CREATE OR REPLACE FUNCTION public.create_wholesale_order_atomic(p_portal_slug text, p_items jsonb, p_notes text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RETURN (p_items->0->>'unit_price')::jsonb; END $$;")],
    ['una migracion posterior redefine la RPC de estado moviendo stock', s => conPosterior(s,
      'CREATE OR REPLACE FUNCTION public.update_wholesale_order_status_atomic(p_business_id uuid, p_order_id uuid, p_status text, p_admin_notes text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN UPDATE public.inventory SET stock_quantity = 0; RETURN NULL; END $$;')],
    ['una migracion posterior elimina el CHECK de cantidad', s => conPosterior(s, 'ALTER TABLE public.wholesale_order_items DROP CONSTRAINT wholesale_order_items_quantity_positive;')],
  ]

  let fallos = 0
  for (const [nombre, mutar] of MUTACIONES) {
    const mutado = mutar(base)
    if (JSON.stringify(mutado) === JSON.stringify(base)) {
      console.error(`  ✖ ${nombre}: la mutacion NO aplico (el patron cambio) — el self-test estaria mintiendo`)
      fallos++
      continue
    }
    if (run(mutado).length === 0) {
      console.error(`  ✖ ${nombre}: NO detectado`)
      fallos++
    } else {
      console.log(`  ✔ ${nombre}: detectado`)
    }
  }
  if (fallos) {
    console.error(`SELF-TEST FALLO: ${fallos} mutacion(es) no detectada(s).`)
    process.exit(1)
  }
  console.log(`SELF-TEST OK: las ${MUTACIONES.length} mutaciones del contrato G2-C.1 son detectadas.`)
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const findings = run(load())
  if (findings.length) {
    console.error('GUARD G2-C.1 FALLO — la autoridad del portal mayorista esta rota:')
    findings.forEach(f => console.error('  · ' + f))
    process.exit(1)
  }
  console.log('GUARD G2-C.1 OK · el navegador no escribe stock, pedidos, items ni campos administrativos de clientes '
    + '· estado, alta y administracion de clientes = solo RPC, con businessId obligatorio · createOrder manda solo '
    + 'producto + cantidad · 3 RPC SECDEF por firma exacta, search_path minimo, sin anon, con autoridad y lock, sin '
    + 'tocar inventario · alta con precio de la base · INSERT/UPDATE directo de pedidos cerrado · clientes limitados '
    + 'a last_login y alta neutra · quantity > 0 · ninguna migracion posterior lo reabre.')
  console.log('NOTA · alcance: los demas writers de inventory (G2-C.2) y repair_missing_stock_movements '
    + 'quedan fuera de este guard a proposito.')
}
