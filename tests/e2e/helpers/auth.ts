import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

const E2E_EMAIL    = process.env.E2E_EMAIL    || ''
const E2E_PASSWORD = process.env.E2E_PASSWORD || ''

/** Login with QA credentials from environment variables. */
export async function login(page: Page): Promise<void> {
  if (!E2E_EMAIL || !E2E_PASSWORD || E2E_EMAIL === 'COMPLETAR_MANUALMENTE') {
    throw new Error(
      'Faltan variables E2E_EMAIL/E2E_PASSWORD en .env.test.\n' +
      '  → Copiá .env.test.example a .env.test y completá las credenciales manualmente.\n' +
      '  → No hardcodear credenciales en código.'
    )
  }
  await page.goto('/login')
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 10_000 })
  await page.fill('[data-testid="login-email"]', E2E_EMAIL)
  await page.fill('[data-testid="login-password"]', E2E_PASSWORD)
  await page.click('[data-testid="login-submit"]')
  // Wait for redirect away from /login (dashboard or /no-business)
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
}

/** Wait for the main layout (sidebar + content) to be visible. */
export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForSelector('.main-layout-content', { timeout: 15_000 })
}
