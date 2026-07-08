#!/usr/bin/env node
// ============================================================================
// M6 (Fase 10) — Finance write guard
//
// Falla el build/gate si aparece una escritura DIRECTA (insert/update/delete/
// upsert) desde el frontend/service-layer (src/) hacia una tabla financiera
// crítica. Toda operación económica debe entrar por una RPC atómica
// SECURITY DEFINER (ver docs/auditoria-finanzas/m6/finance-write-guard.md).
//
// Esto NO reemplaza la RLS (que es la defensa real server-side); sólo evita
// REGRESIONES en el cliente: que alguien vuelva a insertar/actualizar/borrar
// el libro mayor por fuera de las RPCs.
//
// Uso:
//   node scripts/guards/no-direct-finance-writes.mjs           (escanea src/)
//   node scripts/guards/no-direct-finance-writes.mjs --self-test (valida el guard)
// ============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SCAN_DIR = join(ROOT, 'src');
const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

// Tablas del libro mayor a proteger.
const CRITICAL_TABLES = new Set([
  'financial_movements',
  'business_finance_entries',
  'comprobante_payments',
  'account_movements',
  'supplier_account_movements',
  'supplier_payments',
  'order_payments',
  'expenses',
  'cajas',
]);

// Operaciones de escritura prohibidas por defecto.
const WRITE_OPS = ['insert', 'update', 'delete', 'upsert'];

// ── Allowlist ESTRICTA: por archivo + tabla + operación. Sin comodines. ──────
// Una excepción sólo aplica si (file, table, op) coinciden EXACTO. No existe
// "todo comprobanteService", ni "expenses insert en cualquier archivo", ni
// UPDATE/DELETE en ninguna excepción. Toda excepción futura exige: motivo,
// owner y plan de migración (ver docs/.../finance-write-guard.md).
const ALLOWLIST = [
  {
    code: 'E1',
    file: 'src/services/comprobanteService.ts',
    table: 'comprobante_payments',
    op: 'insert',
    reason: 'Cobro inicial de comprobante (registrarPago). POS/checkout/ARCA sensible; ' +
            'INSERT acotado por business_id; UPDATE/DELETE bloqueados; replace ya va por RPC.',
    migrateTo: 'RPC en Fase 10/11 posterior',
  },
  {
    code: 'E2',
    file: 'src/services/cuentasService.ts',
    table: 'account_movements',
    op: 'insert',
    reason: 'CC manual pago/deuda/ajuste (addMovement). UI activa; ledger CC aislado sin ' +
            'FM/BFE/caja; acotado por business+staff+feature currentAccounts.',
    migrateTo: 'RPC posterior',
  },
  {
    code: 'E3',
    file: 'src/pages/Expenses.tsx',
    table: 'expenses',
    op: 'insert',
    reason: 'Alta de factura documental. Alta legítima; UPDATE/DELETE bloqueados; ' +
            'no es borrado/corrección económica.',
    migrateTo: 'permitido por contrato actual',
  },
];

function allowlistMatch(relFile, table, op) {
  const norm = relFile.split(sep).join('/');
  return ALLOWLIST.find((e) => e.file === norm && e.table === table && e.op === op) || null;
}

// ── Detección ────────────────────────────────────────────────────────────────
// Para cada `.from('tabla')` de una tabla crítica, busca la PRIMERA operación de
// escritura encadenada antes del siguiente `.from(` (soporta cadenas multilinea).
// Al anclar en `.from('tablaCritica')`, evita falsos positivos de Map/Set/cache
// `.delete()` que no están precedidos por un `.from(` crítico.
const FROM_RE = /\.from\(\s*(['"`])([a-zA-Z_][\w]*)\1\s*\)/g;
const OP_RE = new RegExp(`\\.(${WRITE_OPS.join('|')})\\s*\\(`);
const NEXT_FROM_RE = /\.from\s*\(/g;
const MAX_WINDOW = 400;

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === '\n') line++;
  return line;
}

/** Devuelve [{table, op, line, snippet}] de escrituras directas a tablas críticas. */
function scanContent(content) {
  const hits = [];
  FROM_RE.lastIndex = 0;
  let m;
  while ((m = FROM_RE.exec(content)) !== null) {
    const table = m[2];
    if (!CRITICAL_TABLES.has(table)) continue;
    const afterFrom = m.index + m[0].length;
    // Límite: el próximo `.from(` (nueva cadena) o una ventana máxima.
    NEXT_FROM_RE.lastIndex = afterFrom;
    const nf = NEXT_FROM_RE.exec(content);
    const windowEnd = Math.min(
      nf ? nf.index : content.length,
      afterFrom + MAX_WINDOW,
      content.length,
    );
    const windowStr = content.slice(afterFrom, windowEnd);
    const op = OP_RE.exec(windowStr);
    if (!op) continue;
    const opIndex = afterFrom + op.index;
    const snippet = content
      .slice(m.index, Math.min(opIndex + op[0].length + 1, content.length))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
    hits.push({ table, op: op[1], line: lineOf(content, m.index), snippet });
  }
  return hits;
}

function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { out.push(...walk(full)); continue; }
    const dot = e.name.lastIndexOf('.');
    if (dot < 0 || !SCAN_EXT.has(e.name.slice(dot))) continue;
    out.push(full);
  }
  return out;
}

// ── Runner principal ─────────────────────────────────────────────────────────
function runGuard() {
  const files = walk(SCAN_DIR);
  const permitted = [];
  const violations = [];
  let totalWrites = 0;

  for (const abs of files) {
    let content;
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }
    const rel = relative(ROOT, abs);
    for (const hit of scanContent(content)) {
      totalWrites++;
      const allow = allowlistMatch(rel, hit.table, hit.op);
      if (allow) permitted.push({ ...hit, file: rel, code: allow.code, reason: allow.reason });
      else violations.push({ ...hit, file: rel });
    }
  }

  console.log(`🔎 Finance write guard — escaneado: ${files.length} archivos en src/`);
  console.log(`   Escrituras directas a tablas financieras detectadas: ${totalWrites}`);
  console.log(`   Permitidas por allowlist (E1/E2/E3): ${permitted.length}`);
  for (const p of permitted) {
    console.log(`     · [${p.code}] ${p.file.split(sep).join('/')}:${p.line} → ${p.table}.${p.op}()`);
  }

  if (violations.length > 0) {
    console.error(`\n❌ Finance write guard FAILED — ${violations.length} escritura(s) directa(s) no autorizada(s):\n`);
    for (const v of violations) {
      console.error(`  ${v.file.split(sep).join('/')}:${v.line}`);
      console.error(`    tabla:     ${v.table}`);
      console.error(`    operación: ${v.op}`);
      console.error(`    snippet:   ${v.snippet}`);
      console.error(`    → Migrá esta operación a una RPC atómica SECURITY DEFINER,`);
      console.error(`      o (si es legítima y acotada) agregá una excepción documentada`);
      console.error(`      en scripts/guards/no-direct-finance-writes.mjs (ALLOWLIST) con`);
      console.error(`      code/reason/owner/plan de migración. Ver docs/.../finance-write-guard.md\n`);
    }
    return 1;
  }

  console.log('\n✅ Finance write guard passed');
  return 0;
}

// ── Self-test ────────────────────────────────────────────────────────────────
function runSelfTest() {
  const cases = [
    { n: 1, desc: 'detecta insert directo en financial_movements',
      file: 'src/pages/Foo.tsx',
      content: `await supabase.from('financial_movements').insert({ amount: 1 })`,
      expect: 'violation', table: 'financial_movements', op: 'insert' },
    { n: 2, desc: 'detecta update directo en business_finance_entries',
      file: 'src/services/bar.ts',
      content: `await supabase.from('business_finance_entries').update({ x: 1 }).eq('id', id)`,
      expect: 'violation', table: 'business_finance_entries', op: 'update' },
    { n: 3, desc: 'detecta delete directo en order_payments',
      file: 'src/components/Baz.tsx',
      content: `await supabase.from('order_payments').delete().eq('id', id)`,
      expect: 'violation', table: 'order_payments', op: 'delete' },
    { n: 4, desc: 'permite E1 (comprobante_payments insert en comprobanteService)',
      file: 'src/services/comprobanteService.ts',
      content: `const { error } = await supabase.from('comprobante_payments').insert({ amount })`,
      expect: 'permitted', table: 'comprobante_payments', op: 'insert', code: 'E1' },
    { n: 5, desc: 'permite E2 (account_movements insert en cuentasService)',
      file: 'src/services/cuentasService.ts',
      content: `await supabase.from('account_movements').insert({ business_id })`,
      expect: 'permitted', table: 'account_movements', op: 'insert', code: 'E2' },
    { n: 6, desc: 'permite E3 (expenses insert en Expenses.tsx)',
      file: 'src/pages/Expenses.tsx',
      content: `await supabase.from('expenses').insert({ amount })`,
      expect: 'permitted', table: 'expenses', op: 'insert', code: 'E3' },
    { n: 7, desc: 'rechaza E1 si cambia insert -> update',
      file: 'src/services/comprobanteService.ts',
      content: `await supabase.from('comprobante_payments').update({ amount }).eq('id', id)`,
      expect: 'violation', table: 'comprobante_payments', op: 'update' },
    { n: 8, desc: 'rechaza misma tabla/op (account_movements insert) en archivo no allowlisted',
      file: 'src/pages/Otro.tsx',
      content: `await supabase.from('account_movements').insert({ x: 1 })`,
      expect: 'violation', table: 'account_movements', op: 'insert' },
    { n: 9, desc: 'soporta comillas dobles',
      file: 'src/services/x.ts',
      content: `await supabase.from("financial_movements").insert({ x: 1 })`,
      expect: 'violation', table: 'financial_movements', op: 'insert' },
    { n: 10, desc: 'soporta cadena multilinea',
      file: 'src/services/y.ts',
      content: `await supabase\n  .from('cajas')\n  .update({ status: 'cerrada' })\n  .eq('id', id)`,
      expect: 'violation', table: 'cajas', op: 'update' },
    // Guardas anti-falso-positivo (no deben detectar nada):
    { n: 11, desc: 'NO detecta Map/cache .delete() sin .from(tabla crítica)',
      file: 'src/lib/z.ts',
      content: `cache.delete(businessId); next.delete(id)`,
      expect: 'clean' },
    { n: 12, desc: 'NO detecta SELECT sobre tabla crítica',
      file: 'src/services/w.ts',
      content: `await supabase.from('financial_movements').select('*').eq('business_id', b)`,
      expect: 'clean' },
    { n: 13, desc: 'NO detecta tabla no crítica',
      file: 'src/services/v.ts',
      content: `await supabase.from('orders').delete().eq('id', id)`,
      expect: 'clean' },
  ];

  let failed = 0;
  for (const c of cases) {
    const hits = scanContent(c.content);
    let ok = false;
    if (c.expect === 'clean') {
      ok = hits.length === 0;
    } else {
      const hit = hits.find((h) => h.table === c.table && h.op === c.op);
      if (!hit) ok = false;
      else {
        const allow = allowlistMatch(c.file, hit.table, hit.op);
        if (c.expect === 'permitted') ok = !!allow && (!c.code || allow.code === c.code);
        else ok = !allow; // violation
      }
    }
    console.log(`  ${ok ? 'PASS' : 'FAIL'}: [${c.n}] ${c.desc}`);
    if (!ok) failed++;
  }
  if (failed > 0) {
    console.error(`\n❌ Self-test FAILED (${failed}/${cases.length})`);
    return 1;
  }
  console.log(`\n✅ Self-test passed (${cases.length}/${cases.length})`);
  return 0;
}

const isSelfTest = process.argv.includes('--self-test');
process.exit(isSelfTest ? runSelfTest() : runGuard());
