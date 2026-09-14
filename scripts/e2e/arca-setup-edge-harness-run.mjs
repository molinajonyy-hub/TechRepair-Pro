#!/usr/bin/env node
/**
 * Arranca scripts/e2e/arca-setup-edge-harness.ts con las variables del stack LOCAL leídas de
 * `.env.e2e` (las mismas que usa Playwright). No imprime claves.
 *
 *   node scripts/e2e/arca-setup-edge-harness-run.mjs
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const env = {}
for (const line of readFileSync('.env.e2e', 'utf8').split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#') || !t.includes('=')) continue
  const i = t.indexOf('=')
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim()
}
for (const k of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[k]) { console.error(`.env.e2e no define ${k}`); process.exit(2) }
}

// `--node-modules-dir=none` es obligatorio: con `auto`, Deno instala TODAS las dependencias de package.json en
// node_modules con su propia resolución (ignora package-lock). En CI eso subió @playwright/test a una versión cuyo
// navegador no estaba instalado y la suite E2E murió antes del primer test. node-forge sale del caché global.
const child = spawn('deno', ['run', '-A', '--node-modules-dir=none', 'scripts/e2e/arca-setup-edge-harness.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    SUPABASE_URL: env.VITE_SUPABASE_URL,
    SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    ARCA_E2E_APP_ORIGIN: process.env.E2E_BASE_URL || env.E2E_BASE_URL || 'http://localhost:5174',
  },
})
child.on('exit', (code) => process.exit(code ?? 1))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
