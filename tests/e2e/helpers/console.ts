import type { Page } from '@playwright/test'

/**
 * Attaches a console error listener to the page.
 * Call this at the start of a test; call assertNoErrors() at the end.
 * Ignores known non-critical warnings.
 */
export function watchConsoleErrors(page: Page): () => string[] {
  const errors: string[] = []

  const IGNORE_PATTERNS = [
    /ResizeObserver loop/i,
    /Non-Error promise rejection/i,
    /favicon/i,
    /ERR_BLOCKED_BY_CLIENT/i,
  ]

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text()
      const ignored = IGNORE_PATTERNS.some(p => p.test(text))
      if (!ignored) errors.push(text)
    }
  })

  return () => [...errors]
}
