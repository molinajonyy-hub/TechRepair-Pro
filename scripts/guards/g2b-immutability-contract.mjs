#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// G2-B · Guard del contrato de inmutabilidad de `comprobante_items`.
//
// El test SQL prueba el COMPORTAMIENTO contra una base viva. Este guard protege
// las decisiones de ESTRUCTURA que hacen que ese comportamiento sea posible, y
// que un refactor bien intencionado puede revertir sin que ningún test de
// comportamiento se entere hasta que ya no haya base donde correrlo:
//
//   1. El guard es SECURITY INVOKER. Si alguien lo "endurece" a DEFINER,
//      `current_user` pasa a ser siempre postgres, el discriminador queda
//      inerte y el guard deja pasar TODO: fail-open total y silencioso.
//   2. El predicado es SECURITY DEFINER. Si pasa a INVOKER, un actor sin
//      visibilidad financiera obtiene `false` por falta de permisos y vuelve a
//      poder mutar: fail-open por visibilidad.
//   3. El predicado NO mira `estado`/`estado_comercial`. Mirarlos reintroduce
//      el error de G2-A (una Nota de Pedido nace `emitido` en la misma
//      transacción que sus ítems) y bloquearía al propio checkout.
//   4. El frontend no reimplementa el predicado: lo consulta.
//
// `--self-test` muta cada invariante en memoria y exige que el guard lo detecte.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'

const MIG  = 'supabase/migrations/20261003120000_g2b_comprobante_items_immutability.sql'
const SVC  = 'src/services/comprobanteService.ts'
const PAGE = 'src/pages/Comprobante.tsx'

const read = (p) => readFileSync(p, 'utf8')

/** Cuerpo de una función SQL, desde su CREATE hasta el `$$;` de cierre. */
function cuerpoFuncion(sql, nombre) {
  const i = sql.indexOf(`FUNCTION public.${nombre}(`)
  if (i < 0) return null
  const fin = sql.indexOf('$$;', i)
  return fin < 0 ? sql.slice(i) : sql.slice(i, fin)
}

function inspectMigracion(sql) {
  const findings = []

  const guard = cuerpoFuncion(sql, 'tg_comprobante_items_immutability_guard')
  const pred  = cuerpoFuncion(sql, 'comprobante_impacto_economico')
  const asrt  = cuerpoFuncion(sql, 'assert_comprobante_items_mutable')

  if (!guard) findings.push('no existe el guard tg_comprobante_items_immutability_guard')
  if (!pred)  findings.push('no existe el predicado comprobante_impacto_economico')
  if (!asrt)  findings.push('no existe la asercion assert_comprobante_items_mutable')

  // 1. El guard NO puede ser SECURITY DEFINER.
  if (guard && /SECURITY\s+DEFINER/i.test(guard)) {
    findings.push('el guard pasó a SECURITY DEFINER: `current_user` seria siempre postgres y dejaria pasar todo')
  }
  // 1b. Y tiene que seguir usando el discriminador.
  if (guard && !/current_user\s+NOT\s+IN\s*\(\s*'authenticated'/i.test(guard)) {
    findings.push('el guard dejo de discriminar por `current_user`')
  }

  // 2. El predicado y la asercion SI deben ser DEFINER.
  if (pred && !/SECURITY\s+DEFINER/i.test(pred)) {
    findings.push('el predicado dejo de ser SECURITY DEFINER: fail-open por falta de visibilidad')
  }
  if (asrt && !/SECURITY\s+DEFINER/i.test(asrt)) {
    findings.push('la asercion dejo de ser SECURITY DEFINER: no podria llamar a assert_period_open')
  }

  // 3. El predicado no puede apoyarse en estados.
  if (pred && /\b(c\.)?estado_comercial\b/.test(pred)) {
    findings.push('el predicado empezo a mirar `estado_comercial`: un estado no es un efecto')
  }
  if (pred && /c\.estado\b/.test(pred)) {
    findings.push('el predicado empezo a mirar `estado`: bloquearia al propio checkout (G2-A)')
  }

  // 3b. Las señales de impacto que el contrato exige, presentes.
  for (const [tabla, etiqueta] of [
    ['comprobante_payments', 'pagos'],
    ['financial_movements', 'caja'],
    ['business_finance_entries', 'BFE/COGS'],
    ['account_movements', 'cuenta corriente'],
    ['inventory_movements', 'movimientos de inventario'],
    ['stock_processed', 'marcador de stock'],
    ['customer_account_payment_allocations', 'imputaciones'],
    ['comprobante_annulments', 'anulacion'],
  ]) {
    if (pred && !pred.includes(tabla)) {
      findings.push(`el predicado dejo de considerar ${etiqueta} (${tabla})`)
    }
  }

  // 4. El period lock reutiliza la autoridad canonica.
  if (asrt && !/assert_period_open/.test(asrt)) {
    findings.push('se perdio el period lock sobre comprobante_items (G2-P1-C)')
  }

  // 5. El trigger cubre las tres operaciones y es BEFORE.
  const trg = sql.match(/CREATE TRIGGER trg_comprobante_items_immutability[\s\S]{0,220}/)
  if (!trg) {
    findings.push('no se crea el trigger trg_comprobante_items_immutability')
  } else {
    if (!/BEFORE INSERT OR UPDATE OR DELETE/i.test(trg[0])) {
      findings.push('el trigger dejo de cubrir BEFORE INSERT OR UPDATE OR DELETE')
    }
  }
  return findings
}

function inspectFrontend(svc, page) {
  const findings = []
  if (!/rpc\('comprobante_impacto_economico'/.test(svc)) {
    findings.push(`${SVC}: la UI dejo de consultar el predicado canonico`)
  }
  // Fail-closed ante error de consulta.
  if (!/return true/.test(svc)) {
    findings.push(`${SVC}: se perdio el fail-closed ante error de consulta`)
  }
  if (!/puedeEditar\s*=.*!impactoEconomico/.test(page)) {
    findings.push(`${PAGE}: `
      + '`puedeEditar` volvio a depender solo del estado documental')
  }
  return findings
}

function run(s) {
  return [
    ...inspectMigracion(s.mig).map(f => `${MIG}: ${f}`),
    ...inspectFrontend(s.svc, s.page),
  ]
}

const load = () => ({ mig: read(MIG), svc: read(SVC), page: read(PAGE) })

function selfTest() {
  const base = load()
  const limpio = run(base)
  if (limpio.length) {
    console.error('SELF-TEST FALLO: el arbol actual ya viola el contrato:')
    limpio.forEach(f => console.error('  · ' + f))
    process.exit(1)
  }

  const MUTACIONES = [
    ['el guard se "endurece" a SECURITY DEFINER',
      s => ({ ...s, mig: s.mig.replace(
        'RETURNS trigger\nLANGUAGE plpgsql\n-- INVOKER a proposito',
        'RETURNS trigger\nLANGUAGE plpgsql\nSECURITY DEFINER\n-- INVOKER a proposito') })],
    ['el guard deja de discriminar por current_user',
      s => ({ ...s, mig: s.mig.replace(
        /IF auth\.uid\(\) IS NULL OR current_user NOT IN \('authenticated', 'anon'\) THEN/,
        'IF false THEN') })],
    ['el predicado deja de ser DEFINER',
      s => ({ ...s, mig: s.mig.replace(
        ') RETURNS TABLE (tiene_impacto boolean, fecha_economica date)\nLANGUAGE sql\nSTABLE\nSECURITY DEFINER',
        ') RETURNS TABLE (tiene_impacto boolean, fecha_economica date)\nLANGUAGE sql\nSTABLE') })],
    ['el predicado empieza a mirar `estado`',
      s => ({ ...s, mig: s.mig.replace(
        'EXISTS (SELECT 1 FROM public.comprobante_payments p',
        "EXISTS (SELECT 1 FROM public.comprobantes cx WHERE cx.id = p_comprobante_id AND c.estado = 'emitido')\n      OR EXISTS (SELECT 1 FROM public.comprobante_payments p") })],
    ['el predicado deja de mirar la Caja',
      s => ({ ...s, mig: s.mig.replace(/OR EXISTS \(SELECT 1 FROM public\.financial_movements fm[\s\S]*?p_comprobante_id\)/, '') })],
    ['se pierde el period lock',
      s => ({ ...s, mig: s.mig.replace(/PERFORM public\.assert_period_open\(p_business_id, v_fecha\);/, '') })],
    ['el trigger deja de cubrir DELETE',
      s => ({ ...s, mig: s.mig.replace('BEFORE INSERT OR UPDATE OR DELETE ON public.comprobante_items',
                                       'BEFORE INSERT OR UPDATE ON public.comprobante_items') })],
    ['la UI vuelve a decidir por el estado documental',
      s => ({ ...s, page: s.page.replace(/const puedeEditar = comprobanteActual\?\.estado === 'borrador' && !impactoEconomico;/,
                                         "const puedeEditar = comprobanteActual?.estado === 'borrador';") })],
    ['la UI deja de consultar el predicado',
      s => ({ ...s, svc: s.svc.replace(/rpc\('comprobante_impacto_economico'/, "rpc('otra_cosa'") })],
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
  console.log(`SELF-TEST OK: las ${MUTACIONES.length} mutaciones del contrato G2-B son detectadas.`)
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const findings = run(load())
  if (findings.length) {
    console.error('GUARD G2-B FALLO — el contrato de inmutabilidad esta roto:')
    findings.forEach(f => console.error('  · ' + f))
    process.exit(1)
  }
  console.log('GUARD G2-B OK · guard INVOKER · predicado DEFINER por efectos (no por estado) · period lock · UI consulta la autoridad.')
}
