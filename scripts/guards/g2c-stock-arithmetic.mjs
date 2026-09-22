#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// G2-C · Guard del contrato de stock aritmético.
//
// La matriz SQL prueba el COMPORTAMIENTO contra una base viva, y su caso 18
// mira el catálogo. Este guard cubre lo que ninguno de los dos puede ver: el
// FUTURO. G2-C parchea dos funciones existentes, así que la forma natural de
// perder la corrección no es editar este lote — es que una migración POSTERIOR
// haga `CREATE OR REPLACE` de alguna de las dos y se traiga el clamp de vuelta
// desde una copia vieja del cuerpo. Eso no lo detecta ningún test que corra
// sobre el estado final sin ese hipotético archivo.
//
// Invariantes protegidos:
//
//   1. La migración de G2-C existe y parchea las DOS funciones del contrato.
//   2. Sus parches son fail-closed: si el patrón no aparece exactamente una
//      vez, abortan. Sin eso, un reemplazo silencioso que no hace nada dejaría
//      la migración "verde" sin haber corregido nada.
//   3. Ninguna migración POSTERIOR a G2-C reintroduce el clamp en esas dos
//      funciones.
//   4. El POS sigue permitiendo la sobreventa (el aviso «se agrega de todas
//      formas» es parte del contrato de producto, no un detalle estético).
//   5. `comprobanteService` —el camino POS— no reintroduce la escritura de
//      stock client-side que G2-B eliminó.
//
// LÍMITE HONESTO DEL PUNTO 5. Este guard NO demuestra, ni afirma, que no
// existan escrituras de stock desde el navegador en el resto de la app. Existe
// una, activa y conocida:
//
//     src/portal/services/portalService.ts · _processWholesaleStock()
//         const newStock = Math.max(0, prevStock + delta)
//         UPDATE inventory / INSERT inventory_movements / UPDATE wholesale_order_items
//
// alcanzable desde `updateOrderStatus()` (`approved` → deduct,
// `cancelled`/`rejected` → revert). Tiene EXACTAMENTE el mismo defecto que
// G2-C corrige en la DB: 2 − 5 → 0 y después 0 + 5 → 5.
//
// Queda como **G2-C.1** y BLOQUEA el cierre definitivo de BETA-GATE-2. No se
// parchea acá cambiando `Math.max` por una resta: eso dejaría el resto
// client-side, sin lock, sin atomicidad y sin autoridad server-side. La
// corrección correcta es moverlo server-side y es un lote propio.
//
// NO es un grep global que prohíba `GREATEST` en inventario: hay usos
// legítimos (saldos, límites, fechas) y varios writers que este lote
// deliberadamente NO toca. El alcance son las tres funciones del contrato.
//
// `--self-test` muta cada invariante en memoria y exige que el guard lo detecte.
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync } from 'node:fs'

const MIG_DIR  = 'supabase/migrations'
const MIG_G2C  = '20261004120000_g2c_negative_stock_reversal.sql'
const POS      = 'src/components/comprobantes/ComprobanteProModal.tsx'
const SVC      = 'src/services/comprobanteService.ts'

const VERSION_G2C = '20261004120000'

// Las TRES funciones del contrato y el clamp que no puede volver a ellas.
// La tercera entró en la revisión humana del PR #143: eliminar una compra ya
// consumida tenía el mismo defecto y es un camino vivo
// (Suppliers.tsx → suppliersService.deletePurchaseSafe → la RPC).
const CLAMPS_PROHIBIDOS = [
  { fn: 'create_comprobante_checkout_atomic', re: /GREATEST\s*\(\s*0\s*,\s*v_prev_stock/i },
  { fn: 'adjust_stock_on_order_item',         re: /GREATEST\s*\(\s*v_prev_stock\s*-/i },
  { fn: 'delete_supplier_purchase_safe',      re: /GREATEST\s*\(\s*0\s*,\s*COALESCE\(v_prev_stk/i },
]

// Firmas exactas que la migración debe apuntar. Buscar por schema+nombre es
// ambiguo: ya existen DOS `create_comprobante_checkout_atomic` (el wrapper
// público y la implementación privada, que es la que corre).
const FIRMAS_EXACTAS = [
  'private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',
  'public.adjust_stock_on_order_item()',
  'public.delete_supplier_purchase_safe(uuid,uuid,uuid)',
]

const read = (p) => readFileSync(p, 'utf8')

function inspectMigracion(mig) {
  const findings = []

  // 1. Parchea las tres funciones, y las apunta por FIRMA EXACTA.
  for (const { fn } of CLAMPS_PROHIBIDOS) {
    if (!mig.includes(fn)) findings.push(`la migracion G2-C dejo de parchear ${fn}`)
  }
  for (const firma of FIRMAS_EXACTAS) {
    if (!mig.includes(firma)) {
      findings.push(`la migracion dejo de apuntar la firma exacta ${firma} (buscar por nombre es ambiguo ante overloads)`)
    }
  }
  if (!/to_regprocedure/.test(mig)) {
    findings.push('la migracion dejo de resolver el objetivo con to_regprocedure: vuelve a ser ambigua')
  }

  // 1b. Y verifica que CREATE OR REPLACE conservo la configuracion.
  for (const [campo, etiqueta] of [
    ['prosecdef', 'SECURITY DEFINER'], ['proowner', 'owner'],
    ['proconfig', 'search_path'],      ['proacl', 'ACL'],
  ]) {
    if (!mig.includes(campo)) {
      findings.push(`la migracion dejo de comprobar que el parche preserva ${etiqueta} (${campo})`)
    }
  }

  // 2. Los parches son fail-closed ante un patron que no aparece.
  const aborta = (mig.match(/RAISE EXCEPTION\s*\n?\s*'G2-C:/g) || []).length
  if (aborta < 2) {
    findings.push('los parches perdieron su aborto fail-closed: un reemplazo que no hace nada pasaria por verde')
  }
  if (!/v_ocurrencias\s*<>\s*1/.test(mig)) {
    findings.push('se perdio el chequeo de "exactamente 1 ocurrencia" del patron a reemplazar')
  }

  // 3. Verifica el RESULTADO contra el catalogo, no solo que el replace corrio.
  //    (Un chequeo textual aca no sirve: el archivo nombra el clamp a proposito,
  //    como patron de busqueda y en el rollback documentado. Lo que importa es
  //    que la migracion se niegue a terminar si el catalogo quedo clampado.)
  for (const [n, desc] of [['1', 'del checkout'], ['7', 'del trigger de repuestos']]) {
    if (!new RegExp(`POSTCONDICION ${n}:`).test(mig)) {
      findings.push(`se perdio la POSTCONDICION ${n} ${desc}, que verifica el catalogo ya sin clamp`)
    }
  }

  // 4. Conserva las postcondiciones que verifican el catalogo.
  for (const ancla of ['FOR\\s+UPDATE', 'stock_processed', 'trg_comprobante_items_immutability']) {
    if (!new RegExp(ancla).test(mig)) {
      findings.push(`la migracion perdio la postcondicion sobre ${ancla.replace('\\s+', ' ')}`)
    }
  }
  return findings
}

/** Ninguna migracion POSTERIOR puede devolver el clamp a esas funciones. */
function inspectMigracionesPosteriores(archivos) {
  const findings = []
  for (const { nombre, sql } of archivos) {
    const version = nombre.split('_')[0]
    if (version <= VERSION_G2C) continue
    // Sin comentarios: una nota que mencione el clamp no es el clamp.
    const cuerpo = sql.replace(/^\s*--.*$/gm, '')
    for (const { fn, re } of CLAMPS_PROHIBIDOS) {
      if (cuerpo.includes(fn) && re.test(cuerpo)) {
        findings.push(`${nombre} reintroduce el clamp de stock en ${fn} (G2-C quedaria revertido en silencio)`)
      }
    }
  }
  return findings
}

function inspectFrontend(pos, svc) {
  const findings = []

  // 4. La sobreventa sigue siendo un camino permitido en el POS.
  if (!/se agrega de todas formas/.test(pos)) {
    findings.push(`${POS}: se perdio el aviso de sobreventa permitida («se agrega de todas formas»)`)
  }
  // Y el aviso no puede convertirse en un bloqueo.
  if (/Sin stock[\s\S]{0,120}?\breturn\b(?![\s\S]{0,40}showToast)/.test(pos)
      && !/se agrega de todas formas/.test(pos)) {
    findings.push(`${POS}: la falta de stock volvio a cortar el alta de la linea`)
  }

  // 5. El camino POS no vuelve a escribir stock desde el navegador (G2-B).
  //    Alcance deliberado: SOLO `comprobanteService`. El portal mayorista tiene
  //    su propio writer client-side (G2-C.1) y este guard no pretende cubrirlo.
  if (/from\('inventory'\)[\s\S]{0,120}?\.update\(/.test(svc)) {
    findings.push(`${SVC}: reaparecio la escritura de inventory desde el navegador que G2-B elimino`)
  }
  if (/from\('inventory_movements'\)[\s\S]{0,120}?\.insert\(/.test(svc)) {
    findings.push(`${SVC}: reaparecio el INSERT de inventory_movements desde el navegador que G2-B elimino`)
  }
  return findings
}

function run(s) {
  return [
    ...inspectMigracion(s.mig).map(f => `${MIG_DIR}/${MIG_G2C}: ${f}`),
    ...inspectMigracionesPosteriores(s.posteriores),
    ...inspectFrontend(s.pos, s.svc),
  ]
}

function load() {
  const posteriores = readdirSync(MIG_DIR)
    .filter(n => /^\d+_.*\.sql$/.test(n))
    .sort()
    .map(nombre => ({ nombre, sql: read(`${MIG_DIR}/${nombre}`) }))
  return {
    mig: read(`${MIG_DIR}/${MIG_G2C}`),
    pos: read(POS),
    svc: read(SVC),
    posteriores,
  }
}

function selfTest() {
  const base = load()
  const limpio = run(base)
  if (limpio.length) {
    console.error('SELF-TEST FALLO: el arbol actual ya viola el contrato:')
    limpio.forEach(f => console.error('  · ' + f))
    process.exit(1)
  }

  const MUTACIONES = [
    ['la migracion deja de parchear el checkout',
      s => ({ ...s, mig: s.mig.replace(/create_comprobante_checkout_atomic/g, 'otra_funcion') })],
    ['la migracion deja de parchear el trigger de repuestos',
      s => ({ ...s, mig: s.mig.replace(/adjust_stock_on_order_item/g, 'otro_trigger') })],
    ['la migracion deja de parchear la eliminacion de compra (Blocker 1)',
      s => ({ ...s, mig: s.mig.replace(/delete_supplier_purchase_safe/g, 'otra_rpc') })],
    ['la migracion vuelve a apuntar por nombre en vez de firma exacta',
      s => ({ ...s, mig: s.mig.replace(/to_regprocedure/g, 'buscar_por_nombre') })],
    ['la migracion deja de comprobar que se preserva el ACL',
      s => ({ ...s, mig: s.mig.replace(/proacl/g, 'otra_cosa') })],
    ['la migracion deja de comprobar que se preserva el owner',
      s => ({ ...s, mig: s.mig.replace(/proowner/g, 'otra_cosa') })],
    ['la migracion deja de comprobar que se preserva el search_path',
      s => ({ ...s, mig: s.mig.replace(/proconfig/g, 'otra_cosa') })],
    ['una migracion POSTERIOR reintroduce el clamp al eliminar una compra',
      s => ({ ...s, posteriores: [...s.posteriores, {
        nombre: '20261007120000_regresion_hipotetica.sql',
        sql: `CREATE OR REPLACE FUNCTION public.delete_supplier_purchase_safe(uuid,uuid,uuid) RETURNS jsonb AS $$
              BEGIN v_new_stk := GREATEST(0, COALESCE(v_prev_stk, 0) - 1); END $$;` }] })],
    ['los parches pierden el aborto fail-closed',
      s => ({ ...s, mig: s.mig.replace(/RAISE EXCEPTION\s*\n?\s*'G2-C:/g, "RAISE NOTICE 'G2C:") })],
    ['se pierde el chequeo de exactamente 1 ocurrencia',
      s => ({ ...s, mig: s.mig.replace(/v_ocurrencias <> 1/g, 'false') })],
    ['se pierde la postcondicion que verifica el catalogo sin clamp',
      s => ({ ...s, mig: s.mig.replace(/POSTCONDICION 1:/g, 'NOTA 1:') })],
    ['la migracion pierde la postcondicion del FOR UPDATE',
      s => ({ ...s, mig: s.mig.replace(/FOR\s+UPDATE/g, 'SIN LOCK') })],
    ['la migracion pierde la postcondicion de los marcadores',
      s => ({ ...s, mig: s.mig.replace(/stock_processed/g, 'otra_marca') })],
    ['la migracion deja de verificar que G2-B sigue en pie',
      s => ({ ...s, mig: s.mig.replace(/trg_comprobante_items_immutability/g, 'otro_trigger') })],
    ['una migracion POSTERIOR reintroduce el clamp en el checkout',
      s => ({ ...s, posteriores: [...s.posteriores, {
        nombre: '20261005120000_regresion_hipotetica.sql',
        sql: `CREATE OR REPLACE FUNCTION private.create_comprobante_checkout_atomic() RETURNS jsonb AS $$
              BEGIN v_new_stock := GREATEST(0, v_prev_stock - 1); END $$;` }] })],
    ['una migracion POSTERIOR reintroduce el clamp en el trigger de repuestos',
      s => ({ ...s, posteriores: [...s.posteriores, {
        nombre: '20261006120000_regresion_hipotetica.sql',
        sql: `CREATE OR REPLACE FUNCTION public.adjust_stock_on_order_item() RETURNS trigger AS $$
              BEGIN v_new_stock := GREATEST(v_prev_stock - NEW.cantidad, 0); END $$;` }] })],
    ['el POS deja de permitir la sobreventa',
      s => ({ ...s, pos: s.pos.replace('se agrega de todas formas', 'no se puede agregar') })],
    ['vuelve una escritura de inventory desde el navegador',
      s => ({ ...s, svc: s.svc.replace('async getById',
        "async _mal() { await supabase.from('inventory').update({ stock_quantity: 0 }) }\n\n  async getById") })],
    ['vuelve un INSERT de inventory_movements desde el navegador',
      s => ({ ...s, svc: s.svc.replace('async getById',
        "async _mal2() { await supabase.from('inventory_movements').insert({ quantity: 1 }) }\n\n  async getById") })],
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
  console.log(`SELF-TEST OK: las ${MUTACIONES.length} mutaciones del contrato G2-C son detectadas.`)
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const findings = run(load())
  if (findings.length) {
    console.error('GUARD G2-C FALLO — el contrato de stock aritmetico esta roto:')
    findings.forEach(f => console.error('  · ' + f))
    process.exit(1)
  }
  console.log('GUARD G2-C OK · parches fail-closed por firma exacta sobre los 3 writers del contrato '
    + '(checkout, repuestos de orden, eliminar compra) · preservan secdef/owner/search_path/ACL '
    + '· ninguna migracion posterior reintroduce el clamp · el POS permite sobreventa '
    + '· comprobanteService no reintroduce el writer client-side que elimino G2-B.')
  console.log('NOTA · alcance: este guard NO cubre el resto de la app. '
    + 'portalService._processWholesaleStock sigue escribiendo stock desde el navegador con el mismo '
    + 'clamp (Math.max(0, prev + delta)). Es G2-C.1 y BLOQUEA el cierre de BETA-GATE-2.')
}
