/**
 * P0 2026-09-10 — gasto general de "Impuestos" devolvía INTERNAL_ERROR.
 *
 * Expenses.tsx mandaba p_finance_type='taxes' a create_expense_with_finance.
 * 'taxes' no está en business_finance_entries_type_check: el INSERT del BFE
 * fallaba dentro de la RPC y el EXCEPTION WHEN OTHERS lo devolvía como
 * INTERNAL_ERROR (sin escritura parcial). Estos tests atan el tipo que manda el
 * front al CHECK real de la DB, leído de las migraciones.
 * Runner: node:test nativo.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  EXPENSE_BFE_TYPES, expenseCategoryKey, expenseFinanceType,
} from '../../src/lib/expenseFinanceType.ts'

const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url)
const BASELINE = '20260628190324_remote_baseline.sql'

function dbBfeTypeCheck(): string[] {
  const sql = readFileSync(new URL(BASELINE, MIGRATIONS), 'utf8')
  const m = sql.match(/"business_finance_entries_type_check" CHECK \(\("type" = ANY \(ARRAY\[([^\]]+)\]\)\)\)/)
  assert.ok(m, 'business_finance_entries_type_check no encontrado en el baseline')
  return [...m[1].matchAll(/'([a-z_]+)'::"text"/g)].map(x => x[1])
}

test('el baseline es la única definición del CHECK de BFE.type', () => {
  const definers = readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .filter(f => readFileSync(new URL(f, MIGRATIONS), 'utf8').includes('business_finance_entries_type_check'))
  assert.deepEqual(definers, [BASELINE],
    'otra migración toca el CHECK: revisar EXPENSE_BFE_TYPES contra la nueva definición')
})

test('todo tipo de gasto que puede mandar el front está en el CHECK de la DB', () => {
  const allowed = new Set(dbBfeTypeCheck())
  for (const t of EXPENSE_BFE_TYPES) assert.ok(allowed.has(t), `${t} no está en business_finance_entries_type_check`)
})

test('payload del incidente: "Impuestos" → impuestos / fixed_cost_local', () => {
  const key = expenseCategoryKey('Impuestos')
  assert.equal(key, 'impuestos')
  assert.equal(expenseFinanceType(key), 'fixed_cost_local')
})

test('categorías reales y por defecto nunca producen un tipo fuera del CHECK', () => {
  const allowed = new Set(dbBfeTypeCheck())
  const names = [
    'Equipamiento', 'Impuestos', 'Inventario / Mercadería', 'Marketing',
    'Sueldos', 'Alquiler', 'Servicios', 'Operativos', 'Otros', '',
  ]
  for (const name of names) {
    const t = expenseFinanceType(expenseCategoryKey(name))
    assert.notEqual(t, 'taxes' as string)
    assert.ok(allowed.has(t), `${name} → ${t} fuera del CHECK`)
  }
})

test('se preservan los tipos no-default existentes', () => {
  assert.equal(expenseFinanceType(expenseCategoryKey('Inventario / Mercadería')), 'variable_cost')
  assert.equal(expenseFinanceType(expenseCategoryKey('Sueldos')), 'salary')
  assert.equal(expenseFinanceType(expenseCategoryKey('Equipamiento')), 'fixed_cost_local')
})

test('claves heredadas del prototipo no se toman como mapeo', () => {
  assert.equal(expenseFinanceType('constructor'), 'fixed_cost_local')
  assert.equal(expenseFinanceType('__proto__'), 'fixed_cost_local')
})

test('Expenses.tsx usa el helper y ya no manda "taxes"', () => {
  const src = readFileSync(new URL('../../src/pages/Expenses.tsx', import.meta.url), 'utf8')
  assert.ok(!src.includes("'taxes'"), "Expenses.tsx todavía contiene 'taxes'")
  assert.ok(src.includes('expenseFinanceType(catKey)'), 'Expenses.tsx no deriva el tipo con expenseFinanceType')
})
