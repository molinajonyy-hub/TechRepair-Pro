import { defineConfig, devices } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env.test for local development (CI injects vars directly via environment)
try {
  const lines = readFileSync(resolve('.env.test'), 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (key && val && !process.env[key]) process.env[key] = val
  }
} catch {
  // .env.test not found — expected in CI where vars come from the environment
}

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

  // Arranque determinista: build + preview sirve el bundle de producción, sin la
  // optimización de dependencias en caliente del dev server (que puede servir la
  // SPA en blanco en el primer hit). `url` espera una respuesta HTTP real (no sólo
  // el puerto abierto). En desarrollo, si ya hay un server en :5173 (p. ej.
  // `npm run dev`), se reutiliza y no se reconstruye. El build toma sus variables
  // de los archivos .env del repo.
  webServer: {
    command: 'npx vite build && npx vite preview --port 5173 --strictPort',
    url: 'http://localhost:5173/landing',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },

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
