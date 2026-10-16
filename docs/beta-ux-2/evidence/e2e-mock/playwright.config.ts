// BETA-UX-2 — corre specs REALES de tests/e2e/m7 contra un Supabase simulado
// (serve.mjs), sin Docker. No reemplaza al job `e2e-local` de CI.
//
//   node node_modules/@playwright/test/cli.js test --config docs/beta-ux-2/evidence/e2e-mock/playwright.config.ts
//
// OJO: `mobile2a-order-intake` y `ordersV20Desktop` escriben capturas en docs/
// (evidencia versionada de lotes anteriores): revertirlas después con
// `git checkout -- docs/p0-mobile-evidence docs/orders-v2-0-evidence`.
import { defineConfig } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const USER_ID = '00000000-0000-4000-8000-00000000d15c'
const user = {
  id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'owner.qa@example.test',
  email_confirmed_at: '2026-10-01T12:00:00Z', app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: 'QA' }, created_at: '2026-10-01T11:59:00Z', identities: [],
}
const jwt = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: USER_ID, exp: now + 86400, role: 'authenticated', aud: 'authenticated', email: user.email })}.sig`
const session = { access_token: jwt, token_type: 'bearer', expires_in: 86400, expires_at: now + 86400, refresh_token: 'fake-refresh', user }
const BASE = 'http://127.0.0.1:5200'
// Lo que `.env.e2e` le da a los specs que llaman una RPC por su cuenta.
process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:59997'
process.env.VITE_SUPABASE_ANON_KEY = 'local-dummy-anon-key'
const storageState = join(tmpdir(), 'beta-ux-2-mock-owner.json')
writeFileSync(storageState, JSON.stringify({
  cookies: [],
  origins: [{ origin: BASE, localStorage: [
    { name: 'sb-127-auth-token', value: JSON.stringify(session) },
    { name: 'techrepair_theme', value: 'light' },
  ] }],
}))

export default defineConfig({
  testDir: '../../../../tests/e2e/m7',
  testMatch: [/beta-ux-2-consistency\.spec\.ts$/, /mobile2a-order-intake\.spec\.ts$/, /ordersV20Desktop\.spec\.ts$/, /dialog-touch-actions\.spec\.ts$/],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: join(tmpdir(), 'beta-ux-2-mock-results'),
  globalSetup: './warmup.ts',
  use: {
    baseURL: BASE,
    storageState,
    viewport: { width: 1440, height: 900 },
    // Bootstrap y fuentes entran por CDN; el resto de la red externa no hace falta.
    trace: 'retain-on-failure',
    // Como en CI: el Chromium headless de esta máquina no anima el scroll y una
    // medida a mitad de un scroll suave pasaba acá y fallaba allá.
    launchOptions: { args: ['--enable-smooth-scrolling'] },
  },
  webServer: {
    command: 'node docs/beta-ux-2/evidence/e2e-mock/serve.mjs',
    cwd: '../../../..',
    url: BASE,
    timeout: 180_000,
    reuseExistingServer: false,
  },
})
