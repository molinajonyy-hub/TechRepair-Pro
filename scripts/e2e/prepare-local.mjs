#!/usr/bin/env node
// ============================================================================
// M7 7D.2 — Prepara el Supabase LOCAL para E2E.
//
//   npm run e2e:prepare
//
// Aplica el marker de entorno y los datos de negocio. Es idempotente: correrlo
// dos veces deja el mismo estado.
//
// ORDEN DE SEGURIDAD (no reordenar):
//   1. Se valida que el destino sea local ANTES de abrir cualquier conexión.
//   2. Recién ahí se crea el marker.
//   3. Todo el resto del setup exige ese marker.
//
// El paso 1 es lo único que separa este script de escribir en producción: a
// diferencia del guard del globalSetup, acá no se puede exigir el marker
// (justamente se lo está creando). Por eso la validación de destino es doble y
// no negociable.
//
// El SQL corre DENTRO del contenedor de Postgres del stack local. No es sólo
// comodidad porque `psql` no esté en PATH en Windows: es una segunda garantía
// estructural — un contenedor local no puede ser producción.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { motivoDeRechazo, enmascarar, MENSAJE_ABORTO } from '../../tests/e2e/setup/assertLocalTarget.ts'
import { sqlDeDatos } from '../../tests/e2e/setup/seedE2E.ts'

const HOSTS_LOCALES = ['localhost', '127.0.0.1', '::1', '[::1]']

function abortar(motivo) {
  console.error('\n' + '═'.repeat(72))
  console.error(MENSAJE_ABORTO)
  console.error('═'.repeat(72))
  console.error(motivo)
  console.error('═'.repeat(72) + '\n')
  process.exit(1)
}

function leerEnvE2E() {
  let crudo
  try {
    crudo = readFileSync('.env.e2e', 'utf-8')
  } catch {
    abortar('Falta `.env.e2e`. Copiá `.env.e2e.example` y completalo con `npx supabase status`.')
  }
  const env = {}
  for (const linea of crudo.split('\n')) {
    const t = linea.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i === -1) continue
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return env
}

/** Nombre del contenedor de Postgres, derivado del project_id del repo. */
function contenedorDb() {
  let toml
  try {
    toml = readFileSync('supabase/config.toml', 'utf-8')
  } catch {
    abortar('No se encontró `supabase/config.toml`: no se puede identificar el stack local.')
  }
  const m = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)
  if (!m) abortar('`supabase/config.toml` no declara project_id.')
  const nombre = `supabase_db_${m[1]}`

  let corriendo = ''
  try {
    corriendo = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf-8' })
  } catch {
    abortar('No se pudo consultar Docker. ¿Está corriendo? El stack local de Supabase vive ahí.')
  }
  if (!corriendo.split('\n').map(s => s.trim()).includes(nombre)) {
    abortar(
      `El contenedor "${nombre}" no está corriendo. Levantá el stack local con \`npx supabase start\`.\n` +
      'Sin stack local no hay dónde correr los E2E, y apuntar a producción no es una alternativa.',
    )
  }
  return nombre
}

const env = leerEnvE2E()

// ─── 1a. Destino del API ────────────────────────────────────────────────────
const motivo = motivoDeRechazo(env.VITE_SUPABASE_URL)
if (motivo) abortar(motivo)

// ─── 1b. Destino de la DB (conexión distinta, validación propia) ────────────
const dbUrl = env.E2E_DATABASE_URL
if (!dbUrl) {
  abortar('Falta E2E_DATABASE_URL en `.env.e2e` (el "DB URL" que muestra `npx supabase status`).')
}
let db
try {
  db = new URL(dbUrl)
} catch {
  abortar('E2E_DATABASE_URL no es una URL válida.')
}
if (!HOSTS_LOCALES.includes(db.hostname)) {
  abortar(
    `E2E_DATABASE_URL apunta a "${enmascarar(db.hostname)}", que no es local. ` +
    'Este script escribe datos: sólo puede correr contra el stack local.',
  )
}

const contenedor = contenedorDb()

console.log(`\n─── M7 7D.2 · preparando E2E local ${'─'.repeat(37)}`)
console.log(`  API        : ${enmascarar(env.VITE_SUPABASE_URL)}`)
console.log(`  DB         : ${db.hostname}:${db.port}`)
console.log(`  Contenedor : ${contenedor}`)

// ─── 2. Marker  +  3. Datos  +  4. Fixtures del gate visual ─────────────────
//
// Las fixtures de Charts L1 se aplicaban A MANO desde el lote que las creó, así
// que las máquinas donde ya se habían corrido pasaban el gate y una base limpia
// no. Se descubrió en el primer runner de CI: las 6 combinaciones de viewport ×
// tema de `charts-l1-visual` y el "0 % contextual" de `finance-caja-visual`
// fallaban con "No hay movimientos suficientes en este período" — la suite
// dependía de estado acumulado, no de su propio seed.
//
// Van acá y no en `ci-local.mjs` para que el camino manual documentado
// (`supabase start` → `e2e:prepare` → `e2e:m7`) también funcione desde cero.
//
// El script es idempotente por construcción (borra lo suyo del negocio E2E y
// vuelve a insertar) y fail-closed por su cuenta: aborta si no encuentra el
// marker, que es lo que se acaba de crear arriba. El orden importa — resuelve
// el usuario desde `public.profiles`, que lo siembra `sqlDeDatos()`.
const sql = readFileSync('tests/e2e/setup/e2eMarker.sql', 'utf-8')
  + '\n' + sqlDeDatos()
  + '\n' + readFileSync('scripts/finance/charts-l1-visual-fixtures.sql', 'utf-8')

try {
  const salida = execFileSync(
    'docker',
    ['exec', '-i', contenedor, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
    { input: sql, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  )
  console.log(salida.trim().split('\n').map(l => `    ${l}`).join('\n'))
} catch (e) {
  console.error(e.stderr || e.message)
  abortar('El SQL de preparación falló. Ver el error de psql arriba.')
}

console.log('\n  ✓ Marker, datos de negocio y fixtures del gate visual aplicados.')
console.log('  El usuario de Auth lo crea el globalSetup (necesita la API de Auth, no la DB).')
console.log('─'.repeat(72) + '\n')
