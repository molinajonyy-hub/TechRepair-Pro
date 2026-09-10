/**
 * Tipo BFE (`business_finance_entries.type`) de un gasto general.
 *
 * `create_expense_with_finance` inserta el BFE con `type = p_finance_type`, y esa
 * columna tiene un CHECK cerrado (`business_finance_entries_type_check`). Un valor
 * fuera del conjunto rompe el INSERT dentro de la RPC, que lo devuelve como
 * INTERNAL_ERROR sin escribir nada. Así fallaba todo gasto de la categoría
 * "Impuestos": el front mandaba 'taxes', que la DB nunca admitió.
 *
 * La clasificación económica NO se decide acá: la deriva server-side
 * `bfe_economic_class(type, category, ...)`. Un gasto 'impuestos' con
 * `fixed_cost_local` es exactamente lo que ese clasificador reconoce como gasto
 * operativo del local (20260704100000_fix_cost_double_count.sql, regla R10).
 */

/** Tipos que el CHECK de BFE admite para un gasto (todos menos 'income'). */
export const EXPENSE_BFE_TYPES = ['variable_cost', 'fixed_cost_local', 'fixed_cost_personal', 'salary'] as const
export type ExpenseBfeType = (typeof EXPENSE_BFE_TYPES)[number]

// Sólo las categorías que NO son gasto fijo del local. 'impuestos' no va acá:
// es fixed_cost_local, igual que alquiler o servicios.
const FINANCE_TYPE_BY_CATEGORY_KEY: Readonly<Record<string, ExpenseBfeType>> = {
  inventario: 'variable_cost',
  sueldos: 'salary',
}

/** Clave de categoría que viaja como `p_category_key`: primera palabra en minúsculas. */
export function expenseCategoryKey(categoryName: string): string {
  return categoryName.toLowerCase().split(' ')[0]
}

/** Tipo BFE para una clave de categoría. Siempre dentro del CHECK de la DB. */
export function expenseFinanceType(categoryKey: string): ExpenseBfeType {
  return Object.prototype.hasOwnProperty.call(FINANCE_TYPE_BY_CATEGORY_KEY, categoryKey)
    ? FINANCE_TYPE_BY_CATEGORY_KEY[categoryKey]
    : 'fixed_cost_local'
}
