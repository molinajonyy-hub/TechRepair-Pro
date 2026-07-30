#!/usr/bin/env node
// ============================================================================
// P0-A.1 — Guard: el estado financiero de una orden es SERVER-SIDE y explícito.
//
// Invariantes que fija (todos verificables sobre el TEXTO del repo, que es una
// red distinta y complementaria a los tests contra la base):
//
//   1. El frontend no marca una orden como pagada ni completada.
//   2. React no calcula payment_status.
//   3. La imputación de cuenta corriente es EXPLÍCITA: nada de FIFO,
//      proporcional ni matching por cliente/fecha/importe.
//   4. No se usan como fuente canónica los tres campos podridos:
//      orders.amount_paid, comprobantes.payment_status, orders.comprobante_id.
//   5. recompute_order_payment_status NO se otorga a authenticated.
//   6. Las asignaciones son append-only y validan sobreasignación y sobrepago.
//
//   node scripts/finance/guard-order-payment-status.mjs [--self-test]
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src'
const MIGRATIONS = 'supabase/migrations'

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const read = (p) => { try { return readFileSync(p, 'utf-8') } catch { return '' } }
// Se quitan comentarios Y bloques COMMENT ON: la prosa que EXPLICA que FIFO está
// prohibido no puede hacer fallar la regla que prohíbe FIFO.
const sinComentariosSql = (s) => s
  .replace(/--[^\n]*/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\bCOMMENT\s+ON\b[\s\S]*?;/gi, ' ')
const sinComentariosTs  = (s) => s.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')

// Deuda REGISTRADA (P1, fuera del alcance de P0-A.1 por decisión del dueño del
// producto): dos archivos siguen leyendo orders.amount_paid. ModalCobro es código
// muerto (no está importado en ningún lado) y useOrderSimple lo usa para un
// balance informativo. El guard bloquea cualquier uso NUEVO fuera de esta lista.
// Son CUATRO consumidores, no dos: el campo se lee además en el Dashboard y en
// la ficha de clientes, donde muestra importes que en la práctica son siempre 0
// (1 sola fila <> 0 en todo el histórico productivo). Ver informe, P1 #2.
const BASELINE_AMOUNT_PAID = new Set([
  'src/components/cobro/ModalCobro.tsx',
  'src/hooks/useOrderSimple.ts',
  'src/hooks/useDashboardStats.ts',
  'src/pages/Customers.tsx',
])
const norm = (p) => p.replace(/\\/g, '/')

// ── Reglas sobre el frontend ────────────────────────────────────────────────

/** 1 y 2: el cliente no escribe ni calcula el estado financiero de una orden. */
export function revisarFrontend(archivos) {
  const h = []
  for (const { ruta, texto } of archivos) {
    const t = sinComentariosTs(texto)

    // .from('orders').update({... status/paid_at/completed_at/payment_status ...})
    const upd = /\.from\(\s*['"]orders['"]\s*\)[\s\S]{0,200}?\.update\(\s*\{([\s\S]{0,300}?)\}/g
    let m
    while ((m = upd.exec(t))) {
      const campos = m[1]
      if (/\b(payment_status|paid_at|completed_at)\s*:/.test(campos)) {
        h.push(`${ruta}: el frontend escribe el estado financiero de la orden (payment_status/paid_at/completed_at)`)
      }
      if (/\bstatus\s*:\s*['"]completed['"]/.test(campos)) {
        h.push(`${ruta}: el frontend marca la orden como completed; eso lo hace el trigger del checkout`)
      }
    }

    // Cálculo del estado en React.
    if (/(payment_status|paymentStatus)\s*=\s*[^=]/.test(t) &&
        /(saldo|balance|pendiente)/i.test(t) &&
        /['"](paid|partial|pending)['"]/.test(t)) {
      h.push(`${ruta}: parece derivar payment_status en el cliente; debe leerse de v_order_financial_status`)
    }

    // Fuentes podridas usadas como verdad.
    if ((/\border\s*\.\s*amount_paid\b/.test(t) || /\bamount_paid\s*:/.test(t) || /\bamount_paid\b/.test(t))
        && !BASELINE_AMOUNT_PAID.has(norm(ruta))) {
      h.push(`${ruta}: usa orders.amount_paid, que es un campo huérfano (no lo mantiene nadie)`)
    }
    if (/comprobante[^\n]{0,40}\.payment_status\b/.test(t)) {
      h.push(`${ruta}: usa comprobantes.payment_status, que está muerto (220 filas incoherentes en prod)`)
    }
  }
  return h
}

// ── Reglas sobre las migraciones de imputación ──────────────────────────────

/** 3, 5 y 6: la imputación es explícita, acotada y no se expone al cliente. */
export function revisarImputacion(textoSql) {
  const h = []
  const t = sinComentariosSql(textoSql)

  if (!/customer_account_payment_allocations/.test(t)) return h

  // 3. Nada de heurísticas de imputación.
  if (/\border\s+by\s+[^\n;]*\b(fecha|date|created_at)\b[^\n;]*\blimit\b/i.test(t) &&
      /allocat/i.test(t)) {
    h.push('la imputación parece elegir documento por fecha (FIFO oculto): debe ser explícita')
  }
  if (/proporcional|prorrate|pro_rata|\bfifo\b/i.test(t)) {
    h.push('aparece una estrategia de imputación automática (FIFO/proporcional): está prohibida')
  }

  // 6. Guardas de importe.
  if (!/EXCEEDS_PAYMENT/.test(t)) h.push('falta la validación de sobreasignación (Σ asignaciones <= importe del pago)')
  if (!/EXCEEDS_BALANCE/.test(t)) h.push('falta la validación de sobrepago del documento (Σ aplicado <= saldo)')
  if (!/CROSS_BUSINESS/.test(t))  h.push('falta la validación de aislamiento por negocio en la imputación')
  if (!/CROSS_CUSTOMER/.test(t))  h.push('falta la validación de que el comprobante sea del cliente de la cuenta')
  if (!/append-only/i.test(t) || !/DELETE no permitido/i.test(t)) {
    h.push('las asignaciones deben ser append-only: falta el guard contra DELETE')
  }
  return h
}

/** 5: el recompute canónico nunca se otorga al rol del cliente. */
export function revisarRecompute(textoSql) {
  const h = []
  const t = sinComentariosSql(textoSql)
  if (!/recompute_order_payment_status/.test(t)) return h
  if (/GRANT\s+EXECUTE\s+ON\s+FUNCTION[^\n;]*recompute_order_payment_status[^\n;]*TO\s+"?authenticated"?/i.test(t)) {
    h.push('recompute_order_payment_status NO puede otorgarse a authenticated: el estado lo decide el servidor')
  }
  return h
}

// ── Self-test ───────────────────────────────────────────────────────────────
function selfTest() {
  const casos = [
    ['frontend marca completed', () => revisarFrontend([{ ruta: 'x.tsx',
      texto: `await supabase.from('orders').update({ status: 'completed' }).eq('id', id)` }]).length > 0],
    ['frontend escribe paid_at', () => revisarFrontend([{ ruta: 'x.tsx',
      texto: `supabase.from('orders').update({ paid_at: new Date() })` }]).length > 0],
    ['frontend usa amount_paid', () => revisarFrontend([{ ruta: 'x.tsx',
      texto: `const pagado = order.amount_paid || 0` }]).length > 0],
    ['frontend usa comprobantes.payment_status', () => revisarFrontend([{ ruta: 'x.tsx',
      texto: `if (comprobanteActual.payment_status === 'paid') {}` }]).length > 0],
    ['frontend legítimo no dispara', () => revisarFrontend([{ ruta: 'x.tsx',
      texto: `const { payment_status } = await supabase.from('v_order_financial_status').select('*')` }]).length === 0],
    ['update de status técnico legítimo', () => revisarFrontend([{ ruta: 'x.tsx',
      texto: `supabase.from('orders').update({ status: 'repair' })` }]).length === 0],
    ['FIFO explícito detectado', () => revisarImputacion(
      `CREATE TABLE customer_account_payment_allocations(); -- allocate fifo\n SELECT allocate fifo;`).length > 0],
    ['falta guard de sobreasignación', () => revisarImputacion(
      `CREATE TABLE customer_account_payment_allocations(); EXCEEDS_BALANCE CROSS_BUSINESS CROSS_CUSTOMER append-only DELETE no permitido`).length > 0],
    ['grant indebido del recompute', () => revisarRecompute(
      `GRANT EXECUTE ON FUNCTION recompute_order_payment_status(uuid) TO "authenticated";`).length > 0],
    ['revoke correcto no dispara', () => revisarRecompute(
      `REVOKE EXECUTE ON FUNCTION recompute_order_payment_status(uuid) FROM "authenticated";`).length === 0],
  ]
  let ok = 0
  for (const [nombre, fn] of casos) {
    const r = fn()
    console.log(`${r ? '✅' : '❌'} fixture "${nombre}"`)
    if (r) ok++
  }
  console.log(ok === casos.length ? `\n✅ self-test: las ${casos.length} fixtures OK` : `\n❌ self-test FALLÓ`)
  process.exit(ok === casos.length ? 0 : 1)
}

// ── Main ────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) selfTest()

const hallazgos = []

const archivosSrc = walk(SRC)
  .filter(p => /\.(ts|tsx)$/.test(p))
  .map(p => ({ ruta: p, texto: read(p) }))
hallazgos.push(...revisarFrontend(archivosSrc))

const sqlP0A1 = readdirSync(MIGRATIONS)
  .filter(f => /p0a1/i.test(f))
  .map(f => read(join(MIGRATIONS, f)))
  .join('\n')
hallazgos.push(...revisarImputacion(sqlP0A1))
hallazgos.push(...revisarRecompute(sqlP0A1))

if (hallazgos.length) {
  console.error(`Guard estado financiero de órdenes FALLÓ: ${hallazgos.length} hallazgo(s):`)
  for (const h of hallazgos) console.error(`   · ${h}`)
  process.exit(1)
}
console.log('✅ Guard estado financiero de órdenes OK: el cliente no lo escribe ni lo calcula, y la imputación es explícita y acotada.')
