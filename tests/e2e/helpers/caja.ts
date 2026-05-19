import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Ensures the caja (cash register) is open.
 * If it's closed, opens it with $0 initial balances.
 * If already open, returns immediately.
 * Throws if the page can't reach a known caja state.
 */
export async function ensureCajaOpen(page: Page): Promise<void> {
  await page.goto('/caja')

  // Wait for the caja status to resolve (not "Cargando...")
  const status = page.locator('[data-testid="caja-status"]')
  await expect(status).toBeVisible({ timeout: 10_000 })

  // If already open, done
  const statusText = await status.textContent()
  if (statusText && statusText.includes('Abierta')) return

  // If closed, open it with $0 balances
  const openBtn = page.locator('[data-testid="caja-open-button"]')
  if (!await openBtn.isVisible()) {
    // Still loading or unknown state
    throw new Error('[ensureCajaOpen] caja-open-button not visible. Is the page loaded?')
  }
  await openBtn.click()

  // Wait for caja to be opened
  await expect(status).toContainText('Abierta', { timeout: 10_000 })
}

/** Returns true if the caja is currently open. */
export async function isCajaOpen(page: Page): Promise<boolean> {
  await page.goto('/caja')
  const status = page.locator('[data-testid="caja-status"]')
  await expect(status).toBeVisible({ timeout: 10_000 })
  const text = await status.textContent()
  return (text ?? '').includes('Abierta')
}
