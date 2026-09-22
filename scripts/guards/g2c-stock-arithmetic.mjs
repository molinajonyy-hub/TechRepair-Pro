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
//   5. No reaparece una escritura de stock desde el navegador en el camino de
//      venta — la línea que G2-B ya había cerrado.
//
// NO es un grep global que prohíba `GREATEST` en inventario: hay usos
// legítimos (saldos, límites, fechas) y varios writers que este lote
// deliberadamente NO toca. El alcance son las dos funciones del contrato.
//
// `--self-test` muta cada invariante en memoria y exige que el guard lo detecte.
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync } from 'node:fs'

const MIG_DIR  = 'supabase/migrations'
const MIG_G2C  = '20261004120000_g2c_negative_stock_reversal.sql'
const POS      = 'src/components/comprobantes/ComprobanteProModal.tsx'
const SVC      = 'src/services/comprobanteService.ts'

const VERSION_G2C = '20261004120000'

// Las dos funciones del contrato y el clamp que no puede volver a ellas.
const CLAMPS_PROHIBIDOS = [
  { fn: 'create_comprobante_checkout_atomic', re: /GREATEST\s*\(\s*0\s*,\s*v_prev_stock/i },
  { fn: 'adjust_stock_on_order_item',         re: /GREATEST\s*\(\s*v_prev_stock\s*-/i },
]

const read = (p) => readFileSync(p, 'utf8')

function inspectMigracion(mig) {
  const findings = []

  // 1. Parchea las dos funciones.
  for (const { fn } of CLAMPS_PROHIBIDOS) {
    if (!mig.includes(fn)) findings.push(`la migracion G2-C dejo de parchear ${fn}`)
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

  // 5. El navegador no vuelve a escribir stock en el camino de venta (G2-B).
  if (/from\('inventory'\)[\s\S]{0,120}?\.update\(/.test(svc)) {
    findings.push(`${SVC}: reaparecio una escritura de inventory desde el navegador`)
  }
  if (/from\('inventory_movements'\)[\s\S]{0,120}?\.insert\(/.test(svc)) {
    findings.push(`${SVC}: reaparecio un INSERT de inventory_movements desde el navegador`)
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
  console.log('GUARD G2-C OK · parches fail-closed sobre los 2 writers del contrato '
    + '· ninguna migracion posterior reintroduce el clamp · el POS permite sobreventa '
    + '· sin escrituras de stock desde el navegador.')
}
