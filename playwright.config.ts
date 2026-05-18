import { defineConfig, devices } from '@playwright/test'

/**
 * TechRepair Pro — Playwright E2E config
 *
 * Variables requeridas (archivo .env.test o entorno CI):
 *   E2E_BASE_URL   — default: http://localhost:5173
 *   E2E_EMAIL      — usuario QA (no hardcodear credenciales reales)
 *   E2E_PASSWORD   — contraseña QA
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,    // secuencial para no saturar Supabase con requests paralelos
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
