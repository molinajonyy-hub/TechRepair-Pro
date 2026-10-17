import { defineConfig, devices } from '@playwright/test'
import { motivoDeRechazo } from './tests/e2e/setup/assertLocalTarget'

const api = process.env.H01_SUPABASE_URL
const rejected = motivoDeRechazo(api)
if (rejected) throw new Error(`H01 local browser tests: ${rejected}`)
if (!process.env.H01_SUPABASE_ANON_KEY || !process.env.H01_SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('H01 requires explicit keys from the isolated local Supabase stack.')
}

export default defineConfig({
  testDir: './tests/e2e/h01',
  testMatch: '**/*.h01.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  globalSetup: './tests/e2e/h01/setup.ts',
  outputDir: 'test-results/h01',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/h01', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:5184',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js build --mode e2e --outDir .h01-local/dist && node node_modules/vite/bin/vite.js preview --mode e2e --outDir .h01-local/dist --port 5184 --strictPort',
    url: 'http://localhost:5184/landing',
    reuseExistingServer: false,
    timeout: 180_000,
    env: { VITE_SUPABASE_URL: api!, VITE_SUPABASE_ANON_KEY: process.env.H01_SUPABASE_ANON_KEY },
  },
})
