// ============================================================================
// M7 7D — Health Check v2: parsing fail-closed, agrupación y presentación.
// Se testea el comportamiento real, no el texto fuente.
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCheck, parseHealthResult, groupChecks, categoryLabel, fmtARS, GLOBAL_CATEGORIES,
  esV2Inexistente,
} from '../../src/lib/financeHealth.ts'

const chk = (o: Record<string, unknown>) => ({
  id: 'x', title: 'X', severity: 'low', status: 'ok', count: 0, description: 'd', rows: [],
  check_id: 'x', category: 'periods', result: 'pass', severity_level: 'info',
  amount_ars: 0, message: 'm', details: {}, version: 'm7_health_v2', ...o,
})

// ─── parseCheck: contrato v2 ────────────────────────────────────────────────
test('parseCheck lee el contrato v2 completo', () => {
  const c = parseCheck(chk({
    check_id: 'annulled_without_record', category: 'annulments', result: 'fail',
    severity_level: 'critical', amount_ars: 1235580, message: 'msg', status: 'critical',
    count: 2, details: { a: 1 },
  }))
  assert.equal(c.check_id, 'annulled_without_record')
  assert.equal(c.category, 'annulments')
  assert.equal(c.result, 'fail')
  assert.equal(c.severity_level, 'critical')
  assert.equal(c.amount_ars, 1235580)
  assert.equal(c.count, 2)
  assert.deepEqual(c.details, { a: 1 })
  assert.equal(c.unrecognized, false)
})

// ─── FAIL-CLOSED ────────────────────────────────────────────────────────────
test('un result DESCONOCIDO no se degrada a pass: pide revisión', () => {
  const c = parseCheck(chk({ result: 'explotó', status: 'raro', severity_level: 'ultra' }))
  assert.notEqual(c.result, 'pass')
  assert.equal(c.result, 'warn')
  assert.equal(c.unrecognized, true)
  assert.equal(c.severity_level, 'medium')
})

test('una severidad desconocida se marca, no se silencia', () => {
  const c = parseCheck(chk({ result: 'fail', severity_level: 'apocalíptico' }))
  assert.equal(c.result, 'fail')
  assert.equal(c.unrecognized, true)
})

// Regresión: un result desconocido junto a un status legacy 'ok' NO puede
// pintarse verde. Antes se derivaba del status y se colaba como pass.
test('result desconocido + status ok legacy: NO se pinta verde', () => {
  const c = parseCheck(chk({ result: 'ovni', status: 'ok', severity: 'low' }))
  assert.equal(c.result, 'warn')
  assert.equal(c.status, 'warning')     // no 'ok'
  assert.equal(c.unrecognized, true)
})

test('un check vacío o basura no rompe la pantalla', () => {
  for (const raw of [null, undefined, 42, 'x', [], {}]) {
    const c = parseCheck(raw)
    assert.equal(typeof c.check_id, 'string')
    assert.notEqual(c.result, 'pass')   // fail-closed
    assert.deepEqual(c.rows, [])
    assert.deepEqual(c.details, {})
  }
})

test('rows no-objeto se descartan sin romper', () => {
  const c = parseCheck(chk({ rows: [{ ok: 1 }, 'basura', null, 7] }))
  assert.equal(c.rows.length, 1)
})

// ─── compatibilidad v1 ──────────────────────────────────────────────────────
test('un check v1 (sin campos v2) se deriva desde status', () => {
  const v1 = { id: 'fm_huerfanos', title: 'FM huérfanos', severity: 'critical',
    status: 'critical', count: 3, description: 'd', rows: [] }
  const c = parseCheck(v1)
  assert.equal(c.result, 'fail')          // critical -> fail
  assert.equal(c.check_id, 'fm_huerfanos')
  assert.equal(c.category, 'otros')       // v1 no manda category
  assert.equal(c.version, 'legacy_v1')
  assert.equal(c.unrecognized, false)     // status v1 ES conocido
})

test('status v1 low se mapea a info, no a warn', () => {
  assert.equal(parseCheck({ id: 'a', status: 'low', count: 0 }).result, 'info')
})

// ─── resumen ────────────────────────────────────────────────────────────────
test('parseHealthResult lee el resumen v2', () => {
  const r = parseHealthResult({
    ok: true, business_id: 'b', checked_at: '2026-07-16T00:00:00Z', checks: [],
    critical_count: 1, warning_count: 2, low_count: 3, total_issues: 6,
    version: 'm7_health_v2', overall_status: 'fail', info_count: 3, pass_count: 40,
    checks_total: 44, duration_ms: 8, amount_at_risk: 1248630,
    schema_state: { ledger: true }, semantics: { credit_note: 'x' },
  }, 'v2')
  assert.equal(r.overall_status, 'fail')
  assert.equal(r.amount_at_risk, 1248630)
  assert.equal(r.checks_total, 44)
  assert.equal(r.duration_ms, 8)
  assert.equal(r.schema_state.ledger, true)
  assert.equal(r.health_version, 'v2')
})

test('overall_status desconocido se deriva de los checks, fail-closed', () => {
  const r = parseHealthResult({
    ok: true, checks: [chk({ result: 'fail' })], overall_status: 'qué',
  }, 'v2')
  assert.equal(r.overall_status, 'fail')
})

test('sin overall_status y con un check no reconocido: warn, no pass', () => {
  const r = parseHealthResult({ ok: true, checks: [chk({ result: 'ovni' })] }, 'legacy_v1')
  assert.equal(r.overall_status, 'warn')
})

test('el fallback v1 se marca como legacy_v1', () => {
  const r = parseHealthResult({ ok: true, checks: [] }, 'legacy_v1')
  assert.equal(r.health_version, 'legacy_v1')
  assert.equal(r.version, 'legacy_v1')
})

// ─── agrupación ─────────────────────────────────────────────────────────────
test('groupChecks agrupa por category y cuenta por resultado', () => {
  const g = groupChecks([
    chk({ category: 'annulments', result: 'fail', amount_ars: 100 }),
    chk({ category: 'annulments', result: 'pass' }),
    chk({ category: 'annulments', result: 'info' }),
    chk({ category: 'inventory', result: 'warn' }),
  ])
  const ann = g.find(x => x.category === 'annulments')!
  assert.equal(ann.checks.length, 3)
  assert.equal(ann.failCount, 1)
  assert.equal(ann.infoCount, 1)
  assert.equal(ann.passCount, 1)
  assert.equal(ann.amountAtRisk, 100)
  assert.equal(ann.status, 'fail')
  assert.equal(g.find(x => x.category === 'inventory')!.status, 'warn')
})

test('el monto del grupo suma SOLO los fail', () => {
  const g = groupChecks([
    chk({ category: 'payments', result: 'fail', amount_ars: 500 }),
    chk({ category: 'payments', result: 'info', amount_ars: 2186 }),  // NC sin retorno
    chk({ category: 'payments', result: 'warn', amount_ars: 7500 }),
  ])
  assert.equal(g[0].amountAtRisk, 500)
})

test('una categoría DESCONOCIDA se sigue mostrando, al final', () => {
  const g = groupChecks([
    chk({ category: 'categoria_del_futuro', result: 'fail' }),
    chk({ category: 'periods', result: 'pass' }),
  ])
  assert.equal(g.length, 2)
  assert.equal(g[0].category, 'periods')
  assert.equal(g[1].category, 'categoria_del_futuro')
  assert.equal(g[1].label, 'categoria_del_futuro')  // sin rótulo: se usa el id
})

test('dentro del grupo, lo que requiere acción va primero', () => {
  const g = groupChecks([
    chk({ category: 'periods', result: 'pass', check_id: 'p' }),
    chk({ category: 'periods', result: 'info', check_id: 'i' }),
    chk({ category: 'periods', result: 'fail', check_id: 'f' }),
    chk({ category: 'periods', result: 'warn', check_id: 'w' }),
  ])
  assert.deepEqual(g[0].checks.map(c => c.check_id), ['f', 'w', 'i', 'p'])
})

test('el grupo propaga si hay checks no reconocidos', () => {
  // groupChecks opera sobre checks YA parseados: la marca la pone parseCheck.
  const g = groupChecks([parseCheck(chk({ category: 'periods', result: 'ovni' }))])
  assert.equal(g[0].hasUnrecognized, true)
  assert.equal(g[0].status, 'warn')   // fail-closed: no queda como pass
})

// ─── info NO es warn ────────────────────────────────────────────────────────
test('info y warn son resultados distintos (NC sin retorno físico es info)', () => {
  const nc = parseCheck(chk({
    check_id: 'credit_note_without_physical_return', result: 'info',
    severity_level: 'info', status: 'low', amount_ars: 2186,
  }))
  assert.equal(nc.result, 'info')
  assert.notEqual(nc.result, 'warn')
  assert.equal(nc.amount_ars, 2186)
})

test('los casos aprobados como info se parsean como info', () => {
  for (const id of ['credit_note_without_physical_return', 'bfe_legacy_annulment_mirrors',
    'reconciliation_corrected', 'global_checks_restricted']) {
    assert.equal(parseCheck(chk({ check_id: id, result: 'info', status: 'low' })).result, 'info')
  }
})

// ─── checks globales ────────────────────────────────────────────────────────
test('la categoría security se reconoce como diagnóstico de plataforma', () => {
  assert.equal(GLOBAL_CATEGORIES.has('security'), true)
  assert.equal(GLOBAL_CATEGORIES.has('annulments'), false)
})

test('un no-owner recibe global_checks_restricted como info y NO los checks globales', () => {
  const r = parseHealthResult({
    ok: true,
    checks: [
      chk({ category: 'security', check_id: 'global_checks_restricted', result: 'info', status: 'low' }),
      chk({ category: 'periods', result: 'pass' }),
    ],
    overall_status: 'pass',
  }, 'v2')
  const globales = r.checks.filter(c => GLOBAL_CATEGORIES.has(c.category))
  assert.equal(globales.length, 1)
  assert.equal(globales[0].result, 'info')
  assert.equal(r.overall_status, 'pass')   // no ensucia la salud del comercio
})

// ─── presentación ───────────────────────────────────────────────────────────
test('categoryLabel traduce las conocidas y deja pasar las nuevas', () => {
  assert.equal(categoryLabel('annulments'), 'Comprobantes y anulaciones')
  assert.equal(categoryLabel('inventory'), 'Inventario')
  assert.equal(categoryLabel('lo_que_venga'), 'lo_que_venga')
})

test('fmtARS formatea en pesos sin decimales', () => {
  const s = fmtARS(1248630)
  assert.ok(s.includes('1.248.630'), `esperaba separador de miles es-AR, salió: ${s}`)
  assert.ok(!s.includes(','), `no debería llevar decimales: ${s}`)
})

// ─── fallback a v1: sólo si la función no existe ────────────────────────────
test('el fallback se activa SOLO cuando v2 no existe', () => {
  assert.equal(esV2Inexistente({ code: 'PGRST202', message: 'Could not find the function' }), true)
  assert.equal(esV2Inexistente({ code: '42883', message: 'undefined function' }), true)
  assert.equal(esV2Inexistente({ message: 'Could not find the function public.finance_health_check_v2 in the schema cache' }), true)
})

test('el fallback NO oculta errores de permisos, SQL, timeout ni contrato', () => {
  const noDebenCaer = [
    { code: '42501', message: 'permission denied for function finance_health_check_v2' },
    { code: '57014', message: 'canceling statement due to statement timeout' },
    { code: '42P01', message: 'relation "comprobantes" does not exist' },
    { message: 'JWT expired' },
    { message: 'Sin acceso a este negocio' },
    null,
  ]
  for (const e of noDebenCaer) {
    assert.equal(esV2Inexistente(e), false, `no debería caer a v1 con: ${JSON.stringify(e)}`)
  }
})
