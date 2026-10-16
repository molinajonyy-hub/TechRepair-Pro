import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const require = createRequire(import.meta.url)
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
  '--allowImportingTsExtensions', '--moduleResolution', 'bundler', '--module', 'esnext', '--target', 'ES2022', '--lib', 'ES2022,DOM',
  'supabase/functions/_shared/billing/planARecovery.ts'], { stdio: 'inherit' })
