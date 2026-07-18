import { defineConfig, devices } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// M7 7D.2 — Se lee `.env.e2e` (stack local), NO `.env.test`. `.env.test` nunca
// definió VITE_SUPABASE_URL y su plantilla apunta a un proyecto remoto por
// diseño; seguir leyéndolo sólo reintroduciría la confusión que causó el blocker.
// Nada de esto sustituye al guard: el globalSetup valida el destino igual.
try {
  const lines = readFileSync(resolve('.env.e2e'), 'utf-8').split('\n')
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
  // .env.e2e ausente — el globalSetup aborta con un mensaje accionable.
}

/**
 * TechRepair Pro — Playwright E2E config
 *
 * Requiere `.env.e2e` (copiar de `.env.e2e.example` y completar con
 * `npx supabase status`):
 *   VITE_SUPABASE_URL          — DEBE ser el stack local
 *   VITE_SUPABASE_ANON_KEY     — anon key local
 *   SUPABASE_SERVICE_ROLE_KEY  — sólo Node (seed/guard). Nunca VITE_*.
 *   E2E_BASE_URL               — default: http://localhost:5174
 *   E2E_EMAIL / E2E_PASSWORD   — usuario sembrado por el seed
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,    // secuencial para no saturar Supabase con requests paralelos
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,

  // M7 7D.2 — El guard de destino corre acá, antes que cualquier proyecto o
  // spec. Aplica a TODA la suite, incluidas las legacy: no hay forma de correr
  // un test sin pasar por él.
  globalSetup: './tests/e2e/setup/globalSetup.ts',

  // Arranque determinista: build + preview sirve el bundle de producción, sin la
  // optimización de dependencias en caliente del dev server (que puede servir la
  // SPA en blanco en el primer hit). `url` espera una respuesta HTTP real (no sólo
  // el puerto abierto).
  //
  // `--mode e2e` NO es cosmético: sin él, `vite build` corre en modo production y
  // hornea `.env` → el Supabase PRODUCTIVO. Ese fue el blocker de 7D.1.
  //
  // Puerto 5174 (no 5173) a propósito: `reuseExistingServer` adoptaría un
  // `npm run dev` ya corriendo en 5173, que sí está construido contra `.env`
  // productivo. Con un puerto propio, el server de E2E siempre es uno que
  // arrancamos nosotros en modo e2e. El globalSetup verifica igual el bundle
  // servido, así que un reuse indebido también quedaría cazado ahí.
  webServer: {
    command: 'npx vite build --mode e2e && npx vite preview --mode e2e --port 5174 --strictPort',
    url: 'http://localhost:5174/landing',
    reuseExistingServer: false,
    timeout: 180_000,
  },

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    // Suites legacy. Se mantienen tal cual: 7D.2 no arregla sus ~136 fallas
    // históricas, sólo garantiza que ya no corran contra producción.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /m7\/.*/,
    },
    // M7 7D.2 — Suite nueva, autenticada, separada de las legacy para que su
    // resultado se lea sin ruido del baseline histórico.
    {
      name: 'm7-local',
      testMatch: /m7\/.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/e2e/.auth/owner.json',
        // 7D.3 §1 — Los requests que inicia un service worker NO pasan por
        // page.route, así que serían un canal de fuga invisible para la defensa
        // de red. El proyecto registra uno (src/hooks/useUpdateDetector.ts) que
        // no aporta nada a estos tests. Bloquearlo cierra el agujero de raíz.
        serviceWorkers: 'block',
      },
    },
  ],
})
