/**
 * Generates unique test data names with E2E_ prefix.
 * All E2E data is clearly prefixed so it can be identified and cleaned up manually.
 */
export function e2eId(): string {
  return Date.now().toString(36).toUpperCase()
}

export function e2eCustomer(suffix?: string): string {
  return `E2E Cliente ${suffix ?? e2eId()}`
}

export function e2eProduct(suffix?: string): string {
  return `E2E Producto ${suffix ?? e2eId()}`
}

export function e2eExpense(suffix?: string): string {
  return `E2E Gasto ${suffix ?? e2eId()}`
}

/** Checks if a string looks like E2E test data (safe to ignore in assertions). */
export function isE2EData(name: string): boolean {
  return name.startsWith('E2E ')
}
