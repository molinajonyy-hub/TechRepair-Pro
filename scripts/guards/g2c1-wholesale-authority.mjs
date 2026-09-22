#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// G2-C.1 · Guard de la autoridad del pedido mayorista.
//
//   PEDIDO MAYORISTA = ESTADO COMERCIAL.
//   COMPROBANTE      = MOVIMIENTO ECONOMICO Y DE STOCK.
//
// La matriz SQL (tests/sql/g2c1_wholesale_stock_authority.test.sql) prueba el
// comportamiento sobre una base viva. Este guard cubre lo que ella no ve: el
// NAVEGADOR (que no corre en esa matriz) y el FUTURO (una migracion posterior
// que reabra el UPDATE directo o vuelva la RPC un writer de inventario).
//
// Invariantes protegidos:
//
//   1. portalService no vuelve a ser una autoridad de stock: nada de
//      `_processWholesaleStock`, `Math.max(0`, escrituras de `inventory`,
//      `inventory_movements` ni de los marcadores `stock_*`.
//   2. portalService no hace UPDATE directo de pedidos ni de items, y el alta
//      del cliente no manda `status`.
//   3. `updateOrderStatus` llama SOLO a la RPC canonica y exige `businessId`.
//   4. Todo caller de `updateOrderStatus` (el del portal) pasa `businessId` como
//      primer argumento. El bug que hizo inalcanzable el writer viejo fue
//      justamente un caller sin businessId.
//   5. Ningun otro archivo de src/ hace UPDATE directo de wholesale_orders o
//      wholesale_order_items.
//   6. La migracion G2-C.1 declara la RPC por firma exacta, SECDEF con
//      search_path minimo, sin EXECUTE para anon/PUBLIC, con la autoridad
//      tenant-bound, con FOR UPDATE y SIN tocar inventario; cierra el UPDATE
//      directo; fuerza pending_whatsapp y marcadores neutros; CHECK quantity > 0.
//   7. Ninguna migracion POSTERIOR reabre nada de eso.
//
// NO es un grep global: el alcance es portalService, los callers del portal,
// las dos tablas mayoristas y la RPC. Otros writers de inventario (G2-C.2)
// quedan fuera a proposito.
//
// `--self-test` muta cada invariante en memoria y exige que el guard lo detecte.
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MIG_DIR   = 'supabase/migrations'
const MIG_G2C1  = '20261005120000_g2c1_wholesale_stock_authority.sql'
const VERSION   = '20261005120000'
const SVC       = 'src/portal/services/portalService.ts'
const RPC       = 'update_wholesale_order_status_atomic'
const FIRMA_RPC = /CREATE\s+FUNCTION\s+public\.update_wholesale_order_status_atomic\(\s*p_business_id\s+uuid\s*,\s*p_order_id\s+uuid\s*,\s*p_status\s+text\s*,\s*p_admin_notes\s+text\s+DEFAULT\s+NULL\s*\)/i

const read = (p) => readFileSync(p, 'utf8')
const sinComentarios = (sql) => sql.replace(/^\s*--.*$/gm, '')

/**
 * ¿Alguna cadena `.from('<tabla>')…` de `src` termina en uno de `verbos`?
 * Se mira solo la MISMA sentencia: el repo no usa `;`, asi que una regex con
 * ventana fija cruzaba a la sentencia siguiente (el `.insert` de items seguido
 * del `.update` de wholesale_customers en createOrder daba falso positivo).
 */
function escribe(src, tabla, verbos) {
  const re = new RegExp(`from\\(\\s*['"]${tabla}['"]\\s*\\)`, 'g')
  let m
  while ((m = re.exec(src))) {
    let resto = src.slice(m.index + m[0].length, m.index + m[0].length + 400)
    const corte = resto.search(/\.from\(|\n\s*\n|\b(await|const|let|return|if)\b/)
    if (corte >= 0) resto = resto.slice(0, corte)
    if (new RegExp(`\\.(${verbos})\\s*\\(`).test(resto)) return true
  }
  return false
}

/** Cuerpo de la funcion `nombre` de un archivo TS: desde su firma hasta el cierre. */
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
    // La declaracion no es una llamada.
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue
    let depth = 1, k = m.index + m[0].length, arg = '', args = []
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
  if (escribe(svc, 'inventory', 'update|insert|upsert|delete')) {
    f.push(`${SVC}: el portal volvio a escribir inventory desde el navegador`)
  }
  if (/stock_processed|stock_movement_id/.test(svc)) f.push(`${SVC}: el portal volvio a leer o escribir marcadores de stock`)
  if (escribe(svc, 'wholesale_orders', 'update|upsert')) {
    f.push(`${SVC}: volvio el UPDATE directo de wholesale_orders (bypass de la RPC)`)
  }
  if (escribe(svc, 'wholesale_order_items', 'update|upsert')) {
    f.push(`${SVC}: volvio el UPDATE directo de wholesale_order_items`)
  }

  // El alta del cliente no nombra estado ni notas administrativas.
  const alta = svc.match(/from\(\s*['"]wholesale_orders['"]\s*\)\s*\.insert\(\s*\{([\s\S]*?)\}\s*\)/)
  if (!alta) f.push(`${SVC}: no se encontro el alta de pedidos de createOrder`)
  else if (/\b(status|admin_notes)\s*:/.test(alta[1])) f.push(`${SVC}: el alta del cliente volvio a mandar status/admin_notes`)

  // updateOrderStatus: businessId obligatorio y SOLO la RPC.
  const uos = cuerpoFuncion(svc, 'updateOrderStatus')
  if (!uos) {
    f.push(`${SVC}: no existe updateOrderStatus`)
  } else {
    if (!/updateOrderStatus\s*\(\s*businessId\s*:\s*string\s*,/.test(uos)) {
      f.push(`${SVC}: updateOrderStatus dejo de exigir businessId como primer parametro obligatorio`)
    }
    if (!/supabase\.rpc\(\s*WHOLESALE_ORDER_STATUS_RPC\b/.test(uos)) {
      f.push(`${SVC}: updateOrderStatus dejo de llamar a la RPC canonica`)
    }
    if (/\.from\(/.test(uos)) f.push(`${SVC}: updateOrderStatus volvio a escribir tablas directo`)
    if (!/if\s*\(\s*error\s*\)\s*throw\b/.test(uos)) f.push(`${SVC}: updateOrderStatus dejo de propagar el error de la RPC`)
  }
  if (!new RegExp(`WHOLESALE_ORDER_STATUS_RPC\\s*=\\s*['"]${RPC}['"]`).test(svc)) {
    f.push(`${SVC}: WHOLESALE_ORDER_STATUS_RPC ya no apunta a ${RPC}`)
  }
  return f
}

/** Callers del portal: primer argumento businessId, sin fallback a undefined. */
function inspectCallers(archivos) {
  const f = []
  const importa = /import\s*\{[^}]*\bupdateOrderStatus\b[^}]*\}\s*from\s*['"][^'"]*portal\/services\/portalService['"]/
  let n = 0
  for (const { nombre, src } of archivos) {
    if (!importa.test(src)) continue
    for (const { args, texto } of llamadas(src, 'updateOrderStatus')) {
      n++
      // Exactamente `businessId`: tambien descarta `businessId || undefined`
      // y `undefined`, que eran la forma del bug original.
      if (args.length < 3 || args[0] !== 'businessId') {
        f.push(`${nombre}: llamada sin businessId como primer argumento: ${texto.replace(/\s+/g, ' ')}`)
      }
    }
  }
  if (n === 0) f.push('no se encontro ningun caller de updateOrderStatus del portal: el guard no esta mirando nada')
  return f
}

/** Nadie en src/ hace UPDATE directo de las tablas de pedidos mayoristas. */
function inspectBypassSrc(archivos) {
  const f = []
  for (const { nombre, src } of archivos) {
    if (nombre === SVC) continue // lo cubre inspectServicio con su propio mensaje
    if (escribe(src, 'wholesale_orders', 'update|upsert')) {
      f.push(`${nombre}: UPDATE directo de wholesale_orders (bypass de la RPC)`)
    }
    if (escribe(src, 'wholesale_order_items', 'update|upsert')) {
      f.push(`${nombre}: UPDATE directo de wholesale_order_items`)
    }
  }
  return f
}

function inspectMigracion(mig) {
  const f = []
  const sql = sinComentarios(mig)
  const i = sql.search(FIRMA_RPC)
  if (i < 0) { f.push('no declara la RPC por firma exacta (uuid, uuid, text, text DEFAULT NULL)'); return f }
  const fin = sql.indexOf('$$;', sql.indexOf('AS $$', i))
  const decl = sql.slice(i, fin)
  const cuerpo = decl.slice(decl.indexOf('AS $$'))

  if (!/SECURITY\s+DEFINER/i.test(decl)) f.push('la RPC dejo de ser SECURITY DEFINER')
  if (!/SET\s+search_path\s*=\s*pg_catalog\s*,\s*pg_temp\s*\n/i.test(decl)) {
    f.push('la RPC no fija search_path = pg_catalog, pg_temp')
  }
  if (!/public\.current_user_can_in_business\(\s*p_business_id\s*,\s*'wholesale'\s*\)/.test(cuerpo)) {
    f.push('la RPC perdio la autoridad tenant-bound current_user_can_in_business(p_business_id, \'wholesale\')')
  }
  if (!/auth\.uid\(\)/.test(cuerpo)) f.push('la RPC dejo de derivar la identidad de auth.uid()')
  if (!/FOR\s+UPDATE/i.test(cuerpo)) f.push('la RPC dejo de bloquear el pedido (FOR UPDATE)')
  if (/inventory|stock_processed|stock_movement_id|stock_quantity/i.test(cuerpo)) {
    f.push('la RPC toca inventario o marcadores: se volvio un segundo writer de stock')
  }

  const fn = `public\\.${RPC}\\(uuid, uuid, text, text\\)`
  if (!new RegExp(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`).test(sql)) f.push('falta REVOKE ... FROM PUBLIC sobre la RPC')
  if (!new RegExp(`REVOKE ALL ON FUNCTION ${fn} FROM anon;`).test(sql)) f.push('falta REVOKE ... FROM anon sobre la RPC')
  if (new RegExp(`GRANT[^;]*ON FUNCTION ${fn}[^;]*\\b(anon|PUBLIC)\\b`, 'i').test(sql)) f.push('la RPC recibe EXECUTE para anon/PUBLIC')
  if (!new RegExp(`GRANT EXECUTE ON FUNCTION ${fn} TO authenticated;`).test(sql)) f.push('authenticated no recibe EXECUTE sobre la RPC')

  // Cierre del UPDATE directo: grant Y policy.
  if (!/REVOKE UPDATE ON TABLE public\.wholesale_orders\s+FROM[^;]*\bauthenticated\b/.test(sql)) {
    f.push('no se revoca el UPDATE directo de wholesale_orders')
  }
  if (!/REVOKE UPDATE ON TABLE public\.wholesale_order_items\s+FROM[^;]*\bauthenticated\b/.test(sql)) {
    f.push('no se revoca el UPDATE directo de wholesale_order_items')
  }
  if (!/DROP POLICY IF EXISTS wo_staff_update\s+ON public\.wholesale_orders;/.test(sql)) f.push('sigue la policy wo_staff_update')
  if (!/DROP POLICY IF EXISTS woi_staff_update\s+ON public\.wholesale_order_items;/.test(sql)) f.push('sigue la policy woi_staff_update')

  // Alta: columnas concedidas sin estado ni marcadores, policies con estado inicial.
  if (!/REVOKE INSERT ON TABLE public\.wholesale_orders FROM[^;]*\bauthenticated\b/.test(sql)) {
    f.push('no se reemplaza el INSERT de tabla de wholesale_orders por uno por columnas')
  }
  const gOrd = sql.match(/GRANT INSERT \(([^)]*)\)\s*ON TABLE public\.wholesale_orders TO authenticated;/)
  if (!gOrd) f.push('falta el GRANT INSERT por columnas de wholesale_orders')
  else if (/\b(status|admin_notes)\b/.test(gOrd[1])) f.push('el alta de pedidos concede status/admin_notes')
  const gItm = sql.match(/GRANT INSERT \(([^)]*)\)\s*ON TABLE public\.wholesale_order_items TO authenticated;/)
  if (!gItm) f.push('falta el GRANT INSERT por columnas de wholesale_order_items')
  else if (/stock_/.test(gItm[1])) f.push('el alta de items concede marcadores de stock')
  for (const pol of ['wo_customer_insert', 'wo_staff_insert']) {
    const m = sql.match(new RegExp(`ALTER POLICY ${pol} ON public\\.wholesale_orders\\s+WITH CHECK \\(([\\s\\S]*?)\\);`))
    if (!m || !/status\s*=\s*'pending_whatsapp'/.test(m[1])) f.push(`${pol} no fuerza status = 'pending_whatsapp'`)
  }
  for (const pol of ['woi_customer_insert', 'woi_staff_insert']) {
    const m = sql.match(new RegExp(`ALTER POLICY ${pol} ON public\\.wholesale_order_items\\s+WITH CHECK \\(([\\s\\S]*?)\\);\\n`))
    if (!m || !/stock_processed IS NOT TRUE/.test(m[1]) || !/stock_movement_id IS NULL/.test(m[1])) {
      f.push(`${pol} no fuerza marcadores de stock neutros`)
    }
  }
  if (!/ADD CONSTRAINT wholesale_order_items_quantity_positive CHECK \(quantity > 0\)/.test(sql)) {
    f.push('falta el CHECK (quantity > 0)')
  }
  for (const n of ['1', '2', '3', '5', '6', '8', '9']) {
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
    const tablas = '(?:public\\.)?(?:wholesale_orders|wholesale_order_items)\\b'
    if (new RegExp(`GRANT\\s+[^;]*\\b(UPDATE|ALL)\\b[^;]*\\bON\\s+(?:TABLE\\s+)?${tablas}[^;]*\\bTO\\b`, 'i').test(sql)) {
      f.push(`${nombre}: vuelve a conceder UPDATE/ALL sobre una tabla de pedidos mayoristas`)
    }
    if (new RegExp(`GRANT\\s+INSERT\\s+ON\\s+(?:TABLE\\s+)?${tablas}`, 'i').test(sql)) {
      f.push(`${nombre}: vuelve a conceder INSERT de TABLA (sin columnas) sobre pedidos mayoristas`)
    }
    if (new RegExp(`GRANT\\s+INSERT\\s*\\([^)]*\\b(status|admin_notes|stock_processed|stock_processed_at|stock_movement_id)\\b[^)]*\\)\\s*ON\\s+(?:TABLE\\s+)?${tablas}`, 'i').test(sql)) {
      f.push(`${nombre}: concede INSERT de estado o marcadores sobre pedidos mayoristas`)
    }
    if (new RegExp(`CREATE\\s+POLICY[^;]*\\bON\\s+${tablas}[^;]*\\bFOR\\s+(UPDATE|ALL)\\b`, 'i').test(sql)) {
      f.push(`${nombre}: crea una policy de UPDATE/ALL sobre pedidos mayoristas`)
    }
    if (new RegExp(`GRANT[^;]*ON\\s+FUNCTION\\s+public\\.${RPC}\\b[^;]*\\b(anon|PUBLIC)\\b`, 'i').test(sql)) {
      f.push(`${nombre}: concede EXECUTE de la RPC a anon/PUBLIC`)
    }
    const redef = sql.match(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${RPC}\\b[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`, 'i'))
    if (redef && /inventory|stock_processed|stock_movement_id|stock_quantity/i.test(redef[1])) {
      f.push(`${nombre}: redefine la RPC tocando inventario (segundo writer de stock)`)
    }
    if (/DROP\s+CONSTRAINT\s+(IF\s+EXISTS\s+)?wholesale_order_items_quantity_positive/i.test(sql)) {
      f.push(`${nombre}: elimina el CHECK quantity > 0`)
    }
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

function selfTest() {
  const base = load()
  const limpio = run(base)
  if (limpio.length) {
    console.error('SELF-TEST FALLO: el arbol actual ya viola el contrato:')
    limpio.forEach(f => console.error('  · ' + f))
    process.exit(1)
  }

  const antesDeUpdate = "/** RPC canónica de cambio de estado"
  const MUTACIONES = [
    ['vuelve _processWholesaleStock al portal',
      s => conSrc(s, SVC, x => x.replace(antesDeUpdate,
        "async function _processWholesaleStock() {}\n" + antesDeUpdate))],
    ['vuelve el clamp Math.max(0, prev + delta)',
      s => conSrc(s, SVC, x => x.replace(antesDeUpdate,
        "const clamp = (p: number, d: number) => Math.max(0, p + d)\n" + antesDeUpdate))],
    ['el navegador vuelve a escribir inventory',
      s => conSrc(s, SVC, x => x.replace(antesDeUpdate,
        "export async function _mal() { await supabase.from('inventory').update({ stock_quantity: 0 }) }\n" + antesDeUpdate))],
    ['el navegador vuelve a insertar inventory_movements',
      s => conSrc(s, SVC, x => x.replace(antesDeUpdate,
        "export async function _mal() { await supabase.from('inventory_movements').insert({ quantity: -1 }) }\n" + antesDeUpdate))],
    ['el navegador vuelve a escribir stock_processed',
      s => conSrc(s, SVC, x => x.replace(antesDeUpdate,
        "export async function _mal() { await supabase.from('wholesale_order_items').update({ stock_processed: true }) }\n" + antesDeUpdate))],
    ['vuelve el UPDATE directo de wholesale_orders.status',
      s => conSrc(s, SVC, x => x.replace(antesDeUpdate,
        "export async function _mal(id: string) { await supabase.from('wholesale_orders').update({ status: 'approved' }).eq('id', id) }\n" + antesDeUpdate))],
    ['updateOrderStatus deja de usar la RPC',
      s => conSrc(s, SVC, x => x.replace('supabase.rpc(WHOLESALE_ORDER_STATUS_RPC', 'supabase.rpc(OTRA_RPC'))],
    ['updateOrderStatus vuelve a tener businessId opcional',
      s => conSrc(s, SVC, x => x.replace(/updateOrderStatus\(\n\s*businessId: string,/, 'updateOrderStatus(\n  businessId?: string,'))],
    ['updateOrderStatus se traga el error',
      s => conSrc(s, SVC, x => x.replace('if (error) throw new Error(error.message)', 'if (error) return null as never'))],
    ['el alta del cliente vuelve a mandar status',
      s => conSrc(s, SVC, x => x.replace('order_number: orderNumber,', "order_number: orderNumber,\n      status:       'approved',"))],
    ['un caller vuelve a omitir businessId',
      s => conSrc(s, MAYORISTA, x => x.replace('updateOrderStatus(businessId, order.id, status)', 'updateOrderStatus(order.id, status)'))],
    ['un caller pasa businessId con fallback a undefined',
      s => conSrc(s, MAYORISTA, x => x.replace("updateOrderStatus(businessId, order.id, 'invoiced')",
        "updateOrderStatus(businessId || undefined, order.id, 'invoiced')"))],
    ['otro archivo de src hace UPDATE directo del pedido',
      s => conSrc(s, MAYORISTA, x => x.replace('const handleCambiarEstado',
        "const _bypass = () => supabase.from('wholesale_orders').update({ status: 'approved' })\n  const handleCambiarEstado"))],
    ['la RPC deja de ser SECURITY DEFINER',
      s => ({ ...s, mig: s.mig.replace('VOLATILE\nSECURITY DEFINER', 'VOLATILE\nSECURITY INVOKER') })],
    ['la RPC deja de fijar search_path minimo',
      s => ({ ...s, mig: s.mig.replace('SET search_path = pg_catalog, pg_temp\nAS $$', 'SET search_path = public, pg_temp\nAS $$') })],
    ['la RPC pierde la autoridad tenant-bound',
      s => ({ ...s, mig: s.mig.replace("public.current_user_can_in_business(p_business_id, 'wholesale')", 'true') })],
    ['la RPC pierde el FOR UPDATE',
      s => ({ ...s, mig: s.mig.replace('   FOR UPDATE;\n\n  IF NOT FOUND', ';\n\n  IF NOT FOUND') })],
    ['la RPC vuelve a mover stock',
      s => ({ ...s, mig: s.mig.replace('  IF v_changed THEN\n', '  IF v_changed THEN\n    UPDATE public.inventory SET stock_quantity = stock_quantity - 1;\n') })],
    ['la RPC recibe EXECUTE para anon',
      s => ({ ...s, mig: s.mig.replace('uuid, text, text) TO authenticated;', 'uuid, text, text) TO authenticated, anon;') })],
    ['se pierde el REVOKE FROM anon de la RPC',
      s => ({ ...s, mig: s.mig.replace(/REVOKE ALL ON FUNCTION public\.update_wholesale_order_status_atomic\(uuid, uuid, text, text\) FROM anon;\n/, '') })],
    ['se deja el UPDATE directo de wholesale_orders',
      s => ({ ...s, mig: s.mig.replace(/REVOKE UPDATE ON TABLE public\.wholesale_orders\s+FROM PUBLIC, anon, authenticated;/, '') })],
    ['se deja la policy wo_staff_update',
      s => ({ ...s, mig: s.mig.replace(/DROP POLICY IF EXISTS wo_staff_update\s+ON public\.wholesale_orders;/, '') })],
    ['el alta de pedidos concede status',
      s => ({ ...s, mig: s.mig.replace('GRANT INSERT (business_id, customer_id,', 'GRANT INSERT (status, business_id, customer_id,') })],
    ['la policy del cliente deja de forzar pending_whatsapp',
      s => ({ ...s, mig: s.mig.replace(/(ALTER POLICY wo_customer_insert[\s\S]*?)AND status = 'pending_whatsapp'/, '$1AND status IS NOT NULL') })],
    ['el alta de items concede marcadores',
      s => ({ ...s, mig: s.mig.replace('quantity, unit_price, subtotal)\n  ON TABLE public.wholesale_order_items', 'quantity, unit_price, subtotal, stock_processed)\n  ON TABLE public.wholesale_order_items') })],
    ['la policy de items del cliente deja de forzar marcadores neutros',
      s => ({ ...s, mig: s.mig.replace(/(ALTER POLICY woi_customer_insert[\s\S]*?)AND stock_processed IS NOT TRUE/, '$1AND true') })],
    ['se pierde el CHECK quantity > 0',
      s => ({ ...s, mig: s.mig.replace('wholesale_order_items_quantity_positive CHECK (quantity > 0)',
        'wholesale_order_items_quantity_positive CHECK (quantity <> 0)') })],
    ['una migracion posterior reabre el UPDATE directo',
      s => conPosterior(s, 'GRANT UPDATE ON TABLE public.wholesale_orders TO authenticated;')],
    ['una migracion posterior concede UPDATE de columna sobre status',
      s => conPosterior(s, 'GRANT UPDATE (status) ON public.wholesale_orders TO authenticated;')],
    ['una migracion posterior crea una policy de UPDATE',
      s => conPosterior(s, 'CREATE POLICY wo_x ON public.wholesale_orders FOR UPDATE TO authenticated USING (true);')],
    ['una migracion posterior devuelve el INSERT de tabla',
      s => conPosterior(s, 'GRANT INSERT ON TABLE public.wholesale_order_items TO authenticated;')],
    ['una migracion posterior concede INSERT de status',
      s => conPosterior(s, 'GRANT INSERT (status) ON TABLE public.wholesale_orders TO authenticated;')],
    ['una migracion posterior da EXECUTE a anon',
      s => conPosterior(s, 'GRANT EXECUTE ON FUNCTION public.update_wholesale_order_status_atomic(uuid, uuid, text, text) TO anon;')],
    ['una migracion posterior redefine la RPC moviendo stock',
      s => conPosterior(s, 'CREATE OR REPLACE FUNCTION public.update_wholesale_order_status_atomic(p_business_id uuid, p_order_id uuid, p_status text, p_admin_notes text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN UPDATE public.inventory SET stock_quantity = 0; RETURN NULL; END $$;')],
    ['una migracion posterior elimina el CHECK de cantidad',
      s => conPosterior(s, 'ALTER TABLE public.wholesale_order_items DROP CONSTRAINT wholesale_order_items_quantity_positive;')],
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
    console.error('GUARD G2-C.1 FALLO — la autoridad del pedido mayorista esta rota:')
    findings.forEach(f => console.error('  · ' + f))
    process.exit(1)
  }
  console.log('GUARD G2-C.1 OK · portalService no escribe stock ni marcadores · updateOrderStatus = solo la RPC, '
    + 'con businessId obligatorio · todos los callers del portal pasan businessId · sin UPDATE directo de pedidos '
    + 'en src/ · RPC SECDEF por firma exacta, search_path minimo, sin anon, tenant-bound, FOR UPDATE, sin tocar '
    + 'inventario · UPDATE directo cerrado · alta en pending_whatsapp con marcadores neutros · quantity > 0 '
    + '· ninguna migracion posterior lo reabre.')
  console.log('NOTA · alcance: los demas writers de inventory (G2-C.2) y repair_missing_stock_movements '
    + 'quedan fuera de este guard a proposito.')
}
