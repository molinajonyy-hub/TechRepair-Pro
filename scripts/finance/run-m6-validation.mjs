#!/usr/bin/env node
// ============================================================================
// M6 (Fase 11) — Runner de validación local
//
// Orquesta, en orden, TODA la evidencia de M6:
//   1. Finance write guard (self-test + scan real de src/).
//   2. Suites SQL M6 (Fase 3-9) + integridad transversal.
//   3. Regresiones Etapa 0 / Etapa 1 + checkout/idempotencia/numeración/ARCA/anulación.
//
// Diseño (no-frágil): cada suite reporta su propio PASS/FAIL; NUNCA se oculta un
// error. Si Docker o el contenedor local no están, NO se marca "verde": se
// imprime la guía con los comandos exactos y se sale con código 2.
//
// Uso:
//   node scripts/finance/run-m6-validation.mjs          (corre todo)
//   node scripts/finance/run-m6-validation.mjs --guide   (solo imprime la guía)
//   SUPABASE_DB_CONTAINER=<nombre> node ...              (override del contenedor)
//
// Requiere una instancia local: `npx supabase db reset` antes de correr (aplica
// migraciones). Cada suite corre en su propia transacción con ROLLBACK — no deja
// datos ni toca producción.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CONTAINER = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_techrepair-vite';
const TESTS_DIR = join(ROOT, 'supabase', 'tests');

// Orden de ejecución (etiqueta → archivo de test SQL, relativo a supabase/tests).
const SQL_SUITES = [
  // ── M6 por fase ──
  ['Fase 3 · account payments',        'etapa6_account_payments_test.sql'],
  ['Fase 4 · cash sessions (C1)',      'etapa6_cash_sessions_test.sql'],
  ['Fase 5 · expense reversal',        'etapa6_expense_reversal_test.sql'],
  ['Fase 6 · order payments',          'etapa6_order_payments_test.sql'],
  ['Fase 7 · supplier lockdown',       'etapa6_supplier_payment_lockdown_test.sql'],
  ['Fase 8 · replace comprobante pay', 'etapa6_replace_comprobante_payment_test.sql'],
  ['Fase 9 · RLS lockdown',            'etapa6_rls_lockdown_test.sql'],
  ['Fase 11 · integridad transversal', 'etapa6_m6_integrity_test.sql'],
  // ── Regresiones Etapa 0 ──
  ['Etapa 0 · finance hardening',      'etapa0_finance_hardening_test.sql'],
  ['Etapa 0 · checkout invariants',    'etapa0_checkout_invariants_test.sql'],
  ['Etapa 0 · anulación (ledger)',     'etapa0_annulment_ledger_test.sql'],
  // ── Regresiones Etapa 1 ──
  ['Etapa 1 · modelo canónico',        'etapa1_canonical_model_test.sql'],
  ['Etapa 1 · gasto activo/compras',   'etapa1_active_expense_flow_test.sql'],
  ['Etapa 1 · P&L exclusiones',        'etapa1_pnl_exclusions_test.sql'],
  ['Etapa 1 · quick purchase',         'etapa1_quick_purchase_test.sql'],
  // ── Regresiones de venta/fiscal ──
  ['Checkout · pricing security',      'checkout_pricing_security_test.sql'],
  ['Checkout · idempotencia',          'comprobante_checkout_idempotency_test.sql'],
  ['Comprobantes · numeración',        'comprobante_numbering_test.sql'],
  ['ARCA · claim atómico',             'arca_atomic_claim_test.sql'],
];

// spawnSync captura stdout Y stderr sin importar el exit code. Clave: psql emite
// los `PASS:`/`FAIL:` vía RAISE NOTICE = stderr; contarlos solo en stdout daría
// un FALSO VERDE (pass=0). Por eso combinamos ambos streams.
function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  return { out, status: r.status === null ? 1 : r.status, spawnError: r.error };
}

function dockerAvailable() {
  const { out, spawnError } = run('docker', ['ps', '--format', '{{.Names}}']);
  if (spawnError) return false;
  return out.split('\n').map((s) => s.trim()).includes(CONTAINER);
}

function printGuide() {
  console.log('\n📋 Guía de validación M6 (manual):\n');
  console.log('  # 0. Instancia local con migraciones aplicadas');
  console.log('  npx supabase db reset\n');
  console.log('  # 1. Finance write guard');
  console.log('  npm run guard:finance-writes:self-test');
  console.log('  npm run guard:finance-writes\n');
  console.log('  # 2. Suites SQL (cada una es tx + ROLLBACK)');
  for (const [label, file] of SQL_SUITES) {
    console.log(`  #   ${label}`);
    console.log(`  docker cp supabase/tests/${file} ${CONTAINER}:/tmp/t.sql && \\`);
    console.log(`    docker exec -i ${CONTAINER} psql -U postgres -d postgres -X -f /tmp/t.sql\n`);
  }
  console.log('  # 3. Gates frontend');
  console.log('  npx tsc --noEmit && npm run lint:errors && npm run test:unit && npm run build');
}

function runGuard() {
  const results = [];
  for (const [label, args] of [['guard · self-test', ['--self-test']], ['guard · scan src/', []]]) {
    const { out, status } = run('node', [join('scripts', 'guards', 'no-direct-finance-writes.mjs'), ...args]);
    const ok = status === 0 && /passed/.test(out) && !/FAILED/.test(out);
    results.push([label, ok, ok ? '' : out.trim().split('\n').slice(-3).join(' | ')]);
  }
  return results;
}

function runSqlSuite(file) {
  const path = join(TESTS_DIR, file);
  if (!existsSync(path)) return [false, 'archivo no encontrado', 0, 0];
  const cp = run('docker', ['cp', path, `${CONTAINER}:/tmp/m6t.sql`]);
  if (cp.status !== 0) return [false, 'docker cp falló: ' + cp.out.trim().split('\n').slice(-1)[0], 0, 1];
  const { out } = run('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-f', '/tmp/m6t.sql']);
  const pass = (out.match(/PASS:/g) || []).length;
  const fail = (out.match(/FAIL:|ERROR:/g) || []).length;
  // Falso-verde guard: una suite válida SIEMPRE emite ≥1 PASS. 0 PASS = sospechoso.
  if (pass === 0 && fail === 0) return [false, 'no se detectaron asserts PASS (¿suite vacía o output no capturado?)', 0, 0];
  const firstFail = out.split('\n').filter((l) => /FAIL:|ERROR:/.test(l))[0] || '';
  return [fail === 0, fail === 0 ? '' : firstFail, pass, fail];
}

// ── Main ─────────────────────────────────────────────────────────────────────
if (process.argv.includes('--guide')) { printGuide(); process.exit(0); }

console.log(`\n🔬 M6 validation runner — contenedor: ${CONTAINER}\n`);
let anyFail = false;

console.log('── Finance write guard ──');
for (const [label, ok, detail] of runGuard()) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) anyFail = true;
}

if (!dockerAvailable()) {
  console.log(`\n⚠️  Docker o el contenedor "${CONTAINER}" no están disponibles.`);
  console.log('   Las suites SQL NO se ejecutaron (no se asume verde). Corré la guía:');
  printGuide();
  process.exit(2);
}

console.log('\n── Suites SQL (tx + ROLLBACK) ──');
for (const [label, file] of SQL_SUITES) {
  const [ok, detail, pass, fail] = runSqlSuite(file);
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(34)} pass=${pass}${fail ? ` fail=${fail}` : ''}${ok ? '' : '  — ' + detail}`);
  if (!ok) anyFail = true;
}

console.log('');
if (anyFail) {
  console.error('❌ M6 validation FAILED — revisá las suites marcadas arriba.');
  console.error('   (Gates frontend aparte: npx tsc --noEmit && npm run lint:errors && npm run test:unit && npm run build)');
  process.exit(1);
}
console.log('✅ M6 validation passed — guard + todas las suites SQL verdes.');
console.log('   Gates frontend aparte: npx tsc --noEmit && npm run lint:errors && npm run test:unit && npm run build');
process.exit(0);
