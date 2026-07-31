#!/usr/bin/env node
// ============================================================================
// P0-SAFEDEV — Preflight de `npm run dev`. FAIL-CLOSED.
//
// ┌── POR QUÉ EXISTE ────────────────────────────────────────────────────────┐
// │ `npm run dev` ejecutaba `vite` a secas. Vite en modo development carga    │
// │ `.env`, y en las máquinas de desarrollo ese archivo (gitignoreado) tiene  │
// │ la URL del Supabase PRODUCTIVO. Resultado: el camino obvio para levantar  │
// │ la app —el que cualquiera usa— servía la UI contra la base viva. Nada lo  │
// │ validaba: dependía de que el operador se acordara de usar `dev:e2e`.      │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Este preflight corre ANTES de Vite y aborta si el destino no es local. Usa
// `motivoDeRechazo` de tests/e2e/setup/assertLocalTarget.ts — la MISMA autoridad
// que 7D.2 — para que no existan dos validadores que puedan divergir.
//
// Carga el entorno con la semántica REAL de Vite para el modo pedido
// (loadEnv), no con process.env: si `.env` gana por precedencia, se ve acá.
//
// No imprime URLs completas ni claves. Nunca.
//
//   node scripts/dev/preflight-local.mjs [modo]     (modo por defecto: development)
// ============================================================================
import { loadEnv } from 'vite'
import { motivoDeRechazo, enmascarar } from '../../tests/e2e/setup/assertLocalTarget.ts'

const MODO = process.argv[2] || 'development'
const RAIZ = process.cwd()

function abortar(motivo, sugerencia) {
  console.error('\n' + '═'.repeat(72))
  console.error('DESARROLLO ABORTADO: el destino Supabase no es local y seguro')
  console.error('═'.repeat(72))
  console.error(motivo)
  if (sugerencia) console.error('\n' + sugerencia)
  console.error('═'.repeat(72) + '\n')
  process.exit(1)
}

const AYUDA =
  'Camino local aprobado:\n' +
  '  1. npx supabase start\n' +
  '  2. npx supabase status   (copiá API URL y anon key)\n' +
  '  3. poné esos valores en .env.development.local (gitignoreado)\n' +
  '  4. npm run dev\n\n' +
  'Para mirar producción usá el dominio desplegado, nunca una app local\n' +
  'conectada a la base viva.'

// Semántica idéntica a la de Vite: prefijo '' trae también las no-VITE_*.
const env = loadEnv(MODO, RAIZ, '')

// ── 1. Destino ──────────────────────────────────────────────────────────────
const motivo = motivoDeRechazo(env.VITE_SUPABASE_URL)
if (motivo) abortar(motivo, AYUDA)

// ── 2. Clave anónima presente (no se valida su valor, sólo su existencia) ──
if (!String(env.VITE_SUPABASE_ANON_KEY || '').trim()) {
  abortar(
    'Falta VITE_SUPABASE_ANON_KEY en el modo "' + MODO + '". ' +
    'Fail-closed: no se levanta la app sin saber contra qué backend habla.',
    AYUDA,
  )
}

// ── OK ──────────────────────────────────────────────────────────────────────
// Sólo se informa host y puerto; nunca la URL completa ni ninguna clave.
const u = new URL(env.VITE_SUPABASE_URL)
console.log(
  `✅ Destino local verificado · modo=${MODO} · host=${u.hostname} · puerto=${u.port || '(default)'} · ` +
  `anon key=presente (${enmascarar(String(env.VITE_SUPABASE_ANON_KEY)).slice(0, 5)}…)`,
)
