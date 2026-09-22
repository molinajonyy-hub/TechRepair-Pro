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
// Tras la revisión humana del PR #142 se agregaron tres invariantes más, cada
// uno cerrando un bypass MEDIDO, no hipotético:
//
//   5. BLOCKER 1 — el guard evalúa el documento de ORIGEN (`OLD` primero). Con
//      `COALESCE(NEW, OLD)` un UPDATE movía la línea de un comprobante con
//      impacto a un borrador limpio del mismo tenant y evadía todo el contrato,
//      incluido el period lock del origen. Además el reparenting está prohibido
//      de plano: ningún escritor canónico muda una línea de documento.
//   6. BLOCKER 2 — el predicado SECDEF resuelve autoridad de tenant ANTES de
//      leer. Sin eso era un oráculo cross-tenant: `authenticated` de A podía
//      preguntar por un comprobante de B y aprender si tenía impacto.
//   7. Los marcadores de stock son SERVER-OWNED. `stock_processed` es una señal
//      de `v_finance_effective_comprobantes`: si el navegador pudiera
//      declararla, fabricaría una venta "efectiva" desde un borrador.
//
// Y una regresión: `_descontarStock` (la vieja ruta de stock del cliente) es
// estructuralmente incompatible con G2-B —su propio paso 3 crea el impacto que
// bloquea su paso 4— así que no puede volver.
//
// `--self-test` muta cada invariante en memoria y exige que el guard lo detecte.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'

const MIG  = 'supabase/migrations/20261003120000_g2b_comprobante_items_immutability.sql'
const SVC  = 'src/services/comprobanteService.ts'
const PAGE = 'src/pages/Comprobante.tsx'

const read = (p) => readFileSync(p, 'utf8')

/**
 * Cuerpo de una función SQL: desde su CREATE hasta el cierre de SU dollar-quote.
 * Se resuelve la etiqueta real (`$$`, `$fn$`, …) en vez de asumir `$$`: asumirla
 * hacía que el "cuerpo" del predicado se comiera la función siguiente y varias
 * comprobaciones pasaran por arrastre.
 */
function cuerpoFuncion(sql, nombre) {
  const i = sql.indexOf(`FUNCTION public.${nombre}(`)
  if (i < 0) return null
  const tag = /\bAS (\$[A-Za-z_]*\$)/.exec(sql.slice(i))
  if (!tag) return sql.slice(i)
  const fin = sql.indexOf(tag[1] + ';', i + tag.index + tag[0].length)
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
  // 4b. Y la asercion delega en el predicado: si se copiara la consulta, la
  //     autoridad de tenant del Blocker 2 quedaria fuera de esta ruta.
  if (asrt && !/comprobante_impacto_economico/.test(asrt)) {
    findings.push('la asercion dejo de delegar en el predicado: la autoridad de tenant quedaria sin aplicar')
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

  // ── BLOCKER 1 ──────────────────────────────────────────────────────────────
  // 6. El guard resuelve el documento de ORIGEN, no el destino.
  for (const col of ['business_id', 'comprobante_id']) {
    if (guard && !guard.includes(`COALESCE(OLD.${col}, NEW.${col})`)) {
      findings.push(`el guard dejo de evaluar el ORIGEN en ${col}: un UPDATE podria mudar la linea a un borrador limpio`)
    }
  }
  // 7. Y ademas rechaza el reparenting de plano, en ambas columnas.
  if (guard && !/COMPROBANTE_ITEMS_REPARENT_PROHIBIDO/.test(guard)) {
    findings.push('el guard dejo de rechazar el reparenting de items (Blocker 1)')
  }
  for (const col of ['comprobante_id', 'business_id']) {
    if (guard && !new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM\\s+OLD\\.${col}`).test(guard)) {
      findings.push(`el guard dejo de comparar ${col} entre OLD y NEW: el reparenting por esa columna vuelve a pasar`)
    }
  }

  // ── BLOCKER 2 ──────────────────────────────────────────────────────────────
  // 8. El predicado resuelve autoridad de tenant ANTES de leer. Se exige la
  //    LLAMADA, no la mencion: el cuerpo tiene un comentario que la nombra.
  if (pred && !/PERFORM\s+public\._require_business_member\s*\(\s*p_business_id/.test(pred)) {
    findings.push('el predicado perdio la autoridad de tenant: vuelve a ser un oraculo cross-tenant (Blocker 2)')
  }
  // 9. Y verifica que el comprobante pertenezca a ese negocio, sin revelar nada.
  if (pred && !/ERRCODE\s*=\s*'42501'/.test(pred)) {
    findings.push('el predicado dejo de rechazar un comprobante ajeno al negocio (Blocker 2)')
  }

  // ── Marcadores server-owned ────────────────────────────────────────────────
  // 10. El navegador no puede fabricar las senales de stock.
  if (guard && !/COMPROBANTE_ITEMS_MARCADOR_SERVER_OWNED/.test(guard)) {
    findings.push('el guard dejo de proteger los marcadores server-owned de stock')
  }
  for (const col of ['stock_processed', 'stock_processed_at', 'stock_movement_id']) {
    if (guard && !new RegExp(`NEW\\.${col}\\b`).test(guard)) {
      findings.push(`el guard dejo de vigilar ${col}: el cliente podria declararlo a mano`)
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
  // Regresion: la ruta de stock del cliente no puede volver. Su paso 3 crea el
  // impacto que bloquea su paso 4, asi que reintroducirla dejaria el stock
  // descontado con `stock_processed` en false y sin idempotencia de reintento.
  // Se busca DEFINICION o LLAMADA, no la mencion: los comentarios que explican
  // por que se elimino deben poder nombrarla.
  if (/(async\s+_descontarStock|this\._descontarStock|^\s*_descontarStock\s*[(:])/m.test(svc)) {
    findings.push(`${SVC}: volvio la ruta de stock del cliente (_descontarStock), incompatible con G2-B`)
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

/** Quita el `SECURITY DEFINER` de UNA funcion concreta, sin tocar las demas. */
function quitarSecdef(sql, nombre) {
  const i = sql.indexOf(`FUNCTION public.${nombre}(`)
  if (i < 0) return sql
  const j = sql.indexOf('SECURITY DEFINER', i)
  if (j < 0) return sql
  return sql.slice(0, j) + '-- SECURITY INVOKER' + sql.slice(j + 'SECURITY DEFINER'.length)
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
    ['el guard se "endurece" a SECURITY DEFINER',
      s => ({ ...s, mig: s.mig.replace(
        'RETURNS trigger\nLANGUAGE plpgsql',
        'RETURNS trigger\nLANGUAGE plpgsql\nSECURITY DEFINER') })],
    ['el guard deja de discriminar por current_user',
      s => ({ ...s, mig: s.mig.replace(
        /IF auth\.uid\(\) IS NULL OR current_user NOT IN \('authenticated', 'anon'\) THEN/,
        'IF false THEN') })],
    ['el predicado deja de ser DEFINER',
      s => ({ ...s, mig: quitarSecdef(s.mig, 'comprobante_impacto_economico') })],
    ['la asercion deja de ser DEFINER',
      s => ({ ...s, mig: quitarSecdef(s.mig, 'assert_comprobante_items_mutable') })],
    ['el predicado empieza a mirar `estado`',
      s => ({ ...s, mig: s.mig.replace(
        'EXISTS (SELECT 1 FROM public.comprobante_payments p',
        "EXISTS (SELECT 1 FROM public.comprobantes c WHERE c.id = p_comprobante_id AND c.estado = 'emitido')\n      OR EXISTS (SELECT 1 FROM public.comprobante_payments p") })],
    ['el predicado deja de mirar la Caja',
      s => ({ ...s, mig: s.mig.replace(/OR EXISTS \(SELECT 1 FROM public\.financial_movements fm[\s\S]*?p_comprobante_id\)/, '') })],
    ['se pierde el period lock',
      s => ({ ...s, mig: s.mig.replace(/PERFORM public\.assert_period_open\(p_business_id, v_fecha\);/, '') })],
    ['la asercion deja de delegar en el predicado',
      s => ({ ...s, mig: s.mig.replace(
        'FROM public.comprobante_impacto_economico(p_business_id, p_comprobante_id) i;',
        'FROM (SELECT false AS tiene_impacto, NULL::date AS fecha_economica) i;') })],
    ['el trigger deja de cubrir DELETE',
      s => ({ ...s, mig: s.mig.replace('BEFORE INSERT OR UPDATE OR DELETE ON public.comprobante_items',
                                       'BEFORE INSERT OR UPDATE ON public.comprobante_items') })],
    // ── BLOCKER 1 ───────────────────────────────────────────────────────────
    ['el guard vuelve a evaluar el comprobante DESTINO (bypass del Blocker 1)',
      s => ({ ...s, mig: s.mig.replace('COALESCE(OLD.comprobante_id, NEW.comprobante_id)',
                                       'COALESCE(NEW.comprobante_id, OLD.comprobante_id)') })],
    ['el guard vuelve a evaluar el negocio DESTINO',
      s => ({ ...s, mig: s.mig.replace('COALESCE(OLD.business_id, NEW.business_id)',
                                       'COALESCE(NEW.business_id, OLD.business_id)') })],
    ['el guard deja de rechazar el reparenting de comprobante',
      s => ({ ...s, mig: s.mig.replace(/IF NEW\.comprobante_id IS DISTINCT FROM OLD\.comprobante_id THEN/,
                                       'IF false THEN -- NEW.comprobante_id') })],
    ['el guard deja de rechazar el cambio de negocio',
      s => ({ ...s, mig: s.mig.replace(/IF NEW\.business_id IS DISTINCT FROM OLD\.business_id THEN/,
                                       'IF false THEN -- NEW.business_id') })],
    // ── BLOCKER 2 ───────────────────────────────────────────────────────────
    ['el predicado pierde la autoridad de tenant',
      s => ({ ...s, mig: s.mig.replace('PERFORM public._require_business_member(p_business_id, NULL);', '') })],
    ['el predicado deja de verificar que el comprobante sea del negocio',
      s => ({ ...s, mig: s.mig.replace(/RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';/,
                                       'NULL;') })],
    // ── Marcadores server-owned ─────────────────────────────────────────────
    ['el cliente vuelve a poder declarar stock_processed',
      s => ({ ...s, mig: s.mig.replace(/COMPROBANTE_ITEMS_MARCADOR_SERVER_OWNED/g, 'AVISO_INOFENSIVO') })],
    ['el guard deja de vigilar stock_movement_id',
      s => ({ ...s, mig: s.mig.replace(/NEW\.stock_movement_id/g, 'OLD.stock_movement_id') })],
    // ── Regresion / UI ──────────────────────────────────────────────────────
    ['vuelve la ruta de stock del cliente (_descontarStock)',
      s => ({ ...s, svc: s.svc.replace('async getById', 'async _descontarStock() { return null }\n\n  async getById') })],
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
  console.log('GUARD G2-B OK · guard INVOKER que evalua el ORIGEN · predicado DEFINER con autoridad de tenant '
    + '· impacto por efectos (no por estado) · period lock · marcadores server-owned · UI consulta la autoridad.')
}
