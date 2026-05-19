import type { CreditCard, CardPurchase } from '../services/creditCardService'

export type { CreditCard, CardPurchase }

// ─── Year-Month string type ('YYYY-MM') ────────────────────────────────────────
export type YearMonth = string

export interface InstallmentEntry {
  month: YearMonth
  amount: number
  installmentNumber: number
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** Returns today as 'YYYY-MM'. Safe: no timezone offset shift. */
export function currentYearMonth(): YearMonth {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Adds n months to a YearMonth string. Uses Date to handle year rollover. */
export function addMonths(ym: YearMonth, n: number): YearMonth {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Formats 'YYYY-MM' as readable Spanish label, e.g. "Junio 2026". */
export function formatYearMonth(ym: YearMonth): string {
  const [y, m] = ym.split('-').map(Number)
  const label = new Date(y, m - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** Returns 12 months starting from current month, suitable for <select> options. */
export function monthSelectOptions(count = 12): Array<{ value: YearMonth; label: string }> {
  const now = new Date()
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })
    return { value, label: label.charAt(0).toUpperCase() + label.slice(1) }
  })
}

// ─── Installment helpers ──────────────────────────────────────────────────────

export function getInstallmentAmount(purchase: Pick<CardPurchase, 'total_amount' | 'installments'>): number {
  return purchase.total_amount / purchase.installments
}

/** Returns the full installment schedule for a purchase. */
export function getPurchaseSchedule(purchase: CardPurchase): InstallmentEntry[] {
  const base = getInstallmentAmount(purchase)
  return Array.from({ length: purchase.installments }, (_, i) => ({
    month: addMonths(purchase.first_installment_month, i),
    amount: base,
    installmentNumber: i + 1,
  }))
}

/** Total amount due on a specific card in a given month. */
export function getCardStatementTotal(cardId: string, purchases: CardPurchase[], month: YearMonth): number {
  return purchases
    .filter(p => p.credit_card_id === cardId)
    .flatMap(p => getPurchaseSchedule(p))
    .filter(s => s.month === month)
    .reduce((sum, s) => sum + s.amount, 0)
}

/** Total across ALL cards in a given month. */
export function getAllCardsStatementTotal(purchases: CardPurchase[], month: YearMonth): number {
  return purchases
    .flatMap(p => getPurchaseSchedule(p))
    .filter(s => s.month === month)
    .reduce((sum, s) => sum + s.amount, 0)
}

/** Total of all installments from fromMonth onwards (for future projection). */
export function getFutureInstallmentsTotal(purchases: CardPurchase[], fromMonth: YearMonth): number {
  return purchases
    .flatMap(p => getPurchaseSchedule(p))
    .filter(s => s.month >= fromMonth)
    .reduce((sum, s) => sum + s.amount, 0)
}

// ─── Card date helpers ────────────────────────────────────────────────────────

/** Returns the next upcoming due date for a card, clamping for short months. */
export function getNextDueDate(card: Pick<CreditCard, 'due_day'>, today = new Date()): Date {
  const y = today.getFullYear()
  const m = today.getMonth()
  const clamp = (day: number, yr: number, mo: number) =>
    Math.min(day, new Date(yr, mo + 1, 0).getDate())

  const thisDue = new Date(y, m, clamp(card.due_day, y, m))
  if (thisDue > today) return thisDue

  const nm = m + 1, ny = nm > 11 ? y + 1 : y, nmm = nm % 12
  return new Date(ny, nmm, clamp(card.due_day, ny, nmm))
}

/** "Cierre 20 · Vence 10" label for a card. */
export function formatCardCycle(card: Pick<CreditCard, 'closing_day' | 'due_day'>): string {
  return `Cierre ${card.closing_day} · Vence ${card.due_day}`
}

// ─── Purchase status helpers ──────────────────────────────────────────────────

/** True if the purchase still has installments in currentMonth or later. */
export function isPurchaseActive(purchase: CardPurchase, currentMonth = currentYearMonth()): boolean {
  return addMonths(purchase.first_installment_month, purchase.installments - 1) >= currentMonth
}

/** Number of installments from currentMonth onwards. */
export function getRemainingInstallments(purchase: CardPurchase, currentMonth = currentYearMonth()): number {
  return getPurchaseSchedule(purchase).filter(s => s.month >= currentMonth).length
}
