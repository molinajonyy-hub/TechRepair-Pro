/**
 * Helpers for money/currency assertions in E2E tests.
 * TechRepair Pro formats money as es-AR: "$1.000,00" or "$1.000"
 */

/** Strips currency symbols, dots and commas to get a numeric string. */
export function normalizeMoney(text: string | null | undefined): string {
  return (text ?? '').replace(/[^0-9.,\-]/g, '').replace(/\./g, '').replace(',', '.')
}

/** Parses a displayed money string into a number. */
export function parseMoney(text: string | null | undefined): number {
  const n = parseFloat(normalizeMoney(text))
  return isNaN(n) ? 0 : n
}

/** Returns true if the text looks like a valid displayed money value (not NaN/undefined/null). */
export function isValidMoneyDisplay(text: string | null | undefined): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  if (t === 'undefined' || t === 'null' || t === 'NaN') return false
  if (t === '[object Object]') return false
  return /\$/.test(t) || /\d/.test(t)
}
