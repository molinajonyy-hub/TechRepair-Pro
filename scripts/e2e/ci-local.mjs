#!/usr/bin/env node
// ============================================================================
// E2E CI — Levanta el Supabase LOCAL, lo prepara y corre Playwright.
//
//   npm run e2e:ci-local                     (suite m7-local, stack ya levantado)
//   npm run e2e:ci-local -- --reset          (además resetea la DB a migraciones)
//   npm run e2e:ci-local -- --grep @smoke    (cualquier flag extra va a Playwright)
//
// ┌── POR QUÉ EXISTE ────────────────────────────────────────────────────────┐
// │ El job E2E de GitHub Actions no tenía entorno: le pasaba los secrets del │
// │ repo (VITE_SUPABASE_URL → Supabase gestionado, o vacío) y el guard de    │
// │ M7 7D.2 abortaba fail-closed antes del primer test. Correcto: el guard   │
// │ hizo su trabajo. Lo que faltaba era el DESTINO LOCAL.                    │
// │                                                                          │
// │ Este script es ese destino, y es UNO SOLO para CI y para la máquina del  │
// │ desarrollador. Si Actions tuviera la lógica inline, nadie podría         │
// │ reproducir un fallo de CI sin empujar commits a ciegas.                  │
// └──────────────────────────────────────────────────────────────────────────┘
//
// NO relaja ninguna barrera. Al contrario: agrega una tercera validación de
// destino —sobre lo que el stack REALMENTE publica, no sobre lo que un archivo
// dice— usando `motivoDeRechazo`, la MISMA autoridad que usan el globalSetup y
// el preflight de `npm run dev`. Un único validador, imposible de divergir.
//
// Las credenciales del stack local NO son secretos: son las claves de demo
// públicas y documentadas que la CLI genera igual en cualquier máquina. Por eso
// el job no necesita ni un solo secret del repo — y por eso puede correr en PRs
// de forks sin exponer nada.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { motivoDeRechazo, enmascarar } from '../../tests/e2e/setup/assertLocalTarget.ts'

const HOSTS_LOCALES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

// Servicios que la suite E2E no usa. Excluirlos ahorra pulls de imágenes y
// arranques en el runner sin tocar `supabase/config.toml` (que es config
// compartida con el desarrollo local, no del CI).
//
// OJO: son nombres de CONTENEDOR, no las secciones de config.toml que lista
// `supabase start --help` (su texto de ayuda está desincronizado: pasarle
// "analytics" o "inbucket" sólo imprime un WARNING y no excluye nada). Se
// quedan levantados los que la suite sí usa: db, gotrue, kong, postgrest,
// realtime, storage-api y mailpit.
//
// `mailpit` ESTABA excluido y se sacó de la lista al encender
// `enable_confirmations` en el config local (EMAIL VERIFICATION P0).
//
// MEDIDO, no supuesto: con Confirm Email ON, GoTrue manda un correo en CADA
// signup. Sin servidor de mail el envío falla y el signup entero devuelve
// **500** — no un usuario pendiente. Probado deteniendo el contenedor contra
// el mismo stack:
//
//   con mailpit  -> signUp OK, session: null   (registro pendiente, correcto)
//   sin mailpit  -> signUp 500, sin usuario
//
// Por eso el mailer dejó de ser opcional: es una dependencia dura del flujo de
// registro, y excluirlo hacía que el CI probara un producto distinto del real.
const SERVICIOS_EXCLUIDOS = [
  'studio', 'imgproxy', 'edge-runtime', 'logflare', 'vector', 'postgres-meta', 'supavisor',
]

// El import de `assertLocalTarget.ts` desde un `.mjs` depende del type stripping
// nativo de Node (sin flag desde 22.18 / 23.6). En Node 20 el proceso muere con
// ERR_UNKNOWN_FILE_EXTENSION, un error que no dice nada sobre la causa real.
const [MAYOR, MENOR] = process.versions.node.split('.').map(Number)
if (MAYOR < 22 || (MAYOR === 22 && MENOR < 18)) {
  console.error(
    `\nNode ${process.versions.node} no puede importar TypeScript sin transpilar.\n` +
    'Este script y `scripts/e2e/prepare-local.mjs` importan `tests/e2e/setup/assertLocalTarget.ts`\n' +
    'para no duplicar el guard de destino. Se necesita Node >= 22.18 (type stripping nativo).\n',
  )
  process.exit(1)
}

function abortar(motivo) {
  console.error('\n' + '═'.repeat(72))
  console.error('E2E CI ABORTADO')
  console.error('═'.repeat(72))
  console.error(motivo)
  console.error('═'.repeat(72) + '\n')
  process.exit(1)
}

// `supabase` y `npx` son shims .cmd en Windows y necesitan shell; `node` y
// `docker` son ejecutables reales. La distinción no es cosmética: con
// shell:true, spawnSync NO entrecomilla, y process.execPath vive en
// "C:\Program Files\nodejs\node.exe" — el espacio partiría el comando.
const NECESITA_SHELL = process.platform === 'win32'

/** Ejecuta heredando stdio. Aborta con un motivo legible si falla. */
function correr(cmd, args, motivoSiFalla, { shell = NECESITA_SHELL } = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell })
  if (r.error) abortar(`${motivoSiFalla}\nNo se pudo ejecutar "${cmd}": ${r.error.message}`)
  if (r.status !== 0) abortar(`${motivoSiFalla}\n"${cmd} ${args.join(' ')}" terminó con código ${r.status}.`)
}

/** Ejecuta capturando stdout. Devuelve null si falla (no aborta). */
function capturar(cmd, args, { shell = NECESITA_SHELL } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', shell })
  if (r.error || r.status !== 0) return null
  return r.stdout
}

/**
 * Como `correr`, pero SIN heredar stdout: sólo lo muestra si el comando falla.
 *
 * `supabase start` termina volcando el anon key, el service_role y el JWT
 * secret del stack. Son las claves de demo públicas, pero un log de CI que
 * escupe algo con forma de credencial enseña exactamente el hábito equivocado.
 * Si falla, el volcado completo aparece — ahí sí hace falta para diagnosticar.
 */
function correrSilencioso(cmd, args, motivoSiFalla, { shell = NECESITA_SHELL } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', shell })
  if (r.error) abortar(`${motivoSiFalla}\nNo se pudo ejecutar "${cmd}": ${r.error.message}`)
  if (r.status !== 0) {
    process.stdout.write(r.stdout ?? '')
    process.stderr.write(r.stderr ?? '')
    abortar(`${motivoSiFalla}\n"${cmd} ${args.join(' ')}" terminó con código ${r.status}.`)
  }
  // Los avisos de la CLI (deprecaciones, versión nueva) sí son útiles y no
  // llevan credenciales: van por stderr.
  const avisos = (r.stderr ?? '').split('\n').filter(l => /^(WARN|WARNING)/.test(l.trim()))
  for (const a of avisos) console.log(`    ${a.trim()}`)
}

// ─── Argumentos ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const RESET = argv.includes('--reset')
const REESCRIBIR_ENV = argv.includes('--write-env')
// Todo lo que no sea una bandera nuestra se le pasa tal cual a Playwright.
const ARGS_PLAYWRIGHT = argv.filter(a => !['--reset', '--write-env'].includes(a))
if (ARGS_PLAYWRIGHT.length === 0) ARGS_PLAYWRIGHT.push('--project=m7-local')

console.log('\n─── E2E CI · Supabase local ' + '─'.repeat(43))

// ─── 1. Docker ──────────────────────────────────────────────────────────────
if (capturar('docker', ['info', '--format', '{{.ServerVersion}}'], { shell: false }) === null) {
  abortar(
    'Docker no responde. El stack local de Supabase vive en Docker.\n' +
    'En local: abrí Docker Desktop. En CI: el runner de Ubuntu ya lo trae.',
  )
}

// ─── 2. Stack local ─────────────────────────────────────────────────────────
// `supabase start` es idempotente: si ya está corriendo, informa y sale 0. En un
// runner limpio aplica TODAS las migraciones de `supabase/migrations` desde cero,
// que es el estado reproducible que queremos. `--reset` es para la máquina del
// desarrollador, donde el stack ya existe y puede estar sucio.
console.log('  · levantando stack (supabase start)…')
correrSilencioso('supabase', ['start', '-x', SERVICIOS_EXCLUIDOS.join(',')],
  'No se pudo levantar el Supabase local.')

if (RESET) {
  console.log('  · reseteando DB a las migraciones (supabase db reset --local)…')
  correr('supabase', ['db', 'reset', '--local'],
    'El reset de la DB local falló: no hay un estado de esquema reproducible.')
}

// ─── 3. Lo que el stack REALMENTE publica ───────────────────────────────────
// Readiness real: `supabase status` sólo responde con los servicios sanos.
const salida = capturar('supabase', ['status', '-o', 'env'])
if (salida === null) {
  abortar('`supabase status` falló: el stack no está sano. Revisá los logs de Docker.')
}
const status = {}
for (const linea of salida.split('\n')) {
  const m = linea.trim().match(/^([A-Z0-9_]+)="?(.*?)"?$/)
  if (m) status[m[1]] = m[2]
}
for (const k of ['API_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'DB_URL']) {
  if (!status[k]) abortar(`\`supabase status\` no reportó ${k}. No se puede configurar el E2E a ciegas.`)
}

// ─── 4. Guard de destino, sobre el stack real ───────────────────────────────
// Tercera comprobación independiente: el globalSetup valida el archivo, la
// barrera 3 valida el bundle servido, y esto valida lo que la CLI publica.
const motivo = motivoDeRechazo(status.API_URL)
if (motivo) {
  abortar(
    'El stack que levantó la CLI NO es un destino local aceptable.\n' + motivo + '\n' +
    'Este script escribe datos: no continúa contra un destino que no pueda probar que es local.',
  )
}
let db
try { db = new URL(status.DB_URL) } catch { abortar('DB_URL no es una URL válida.') }
if (!HOSTS_LOCALES.has(db.hostname)) {
  abortar(`DB_URL apunta a "${enmascarar(db.hostname)}", que no es local.`)
}

const api = new URL(status.API_URL)
console.log(`  ✓ destino API  : host=${api.hostname} puerto=${api.port} local=true`)
console.log(`  ✓ destino DB   : host=${db.hostname} puerto=${db.port} local=true`)
console.log('  ✓ claves       : presentes (no se imprimen)')

// ─── 5. `.env.e2e` ──────────────────────────────────────────────────────────
// En CI nunca existe (está gitignoreado) y se genera. En local se RESPETA el del
// desarrollador salvo `--write-env`: pisarlo en silencio sería un modo excelente
// de romperle el entorno a alguien.
const RUTA_ENV = '.env.e2e'
// Contraseña del usuario sembrado en un backend descartable. No es un secreto:
// vive sólo en este stack local, que se destruye al terminar el job.
const PASSWORD_E2E = 'e2e-local-Passw0rd'
/**
 * Extension ID de PRUEBA para el Companion. Tiene la forma real que el frontend
 * valida (32 caracteres en a-p) pero no corresponde a ninguna extensión: el
 * spec inyecta su propio `chrome.runtime`. Sin esto el frontend se declararía
 * "sin configurar" y no habría nada que ejercitar.
 */
const ID_COMPANION_E2E = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

if (!existsSync(RUTA_ENV) || REESCRIBIR_ENV) {
  const contenido = [
    '# GENERADO por scripts/e2e/ci-local.mjs desde `supabase status`.',
    '# Valores del stack LOCAL descartable. No editar a mano en CI.',
    `VITE_SUPABASE_URL=${status.API_URL}`,
    `VITE_SUPABASE_ANON_KEY=${status.ANON_KEY}`,
    `E2E_DATABASE_URL=${status.DB_URL}`,
    'E2E_BASE_URL=http://localhost:5174',
    'E2E_EMAIL=e2e-owner@e2e.local',
    `E2E_PASSWORD=${PASSWORD_E2E}`,
    `SUPABASE_SERVICE_ROLE_KEY=${status.SERVICE_ROLE_KEY}`,
    // Companion: ID de PRUEBA con la forma real ([a-p]{32}). No es ninguna
    // extensión publicada; sólo hace que el frontend quede configurado para que
    // el E2E pueda inyectar su bridge y ejercitar el cliente de verdad.
    `VITE_WHATSAPP_COMPANION_EXTENSION_ID=${ID_COMPANION_E2E}`,
    '',
  ].join('\n')
  writeFileSync(RUTA_ENV, contenido, 'utf-8')
  console.log(`  ✓ ${RUTA_ENV} generado desde el stack en marcha.`)
} else {
  // Existe y no se pidió reescribirlo: se valida que apunte al stack en marcha.
  // Un `.env.e2e` viejo apuntando a otro puerto falla más tarde y de forma
  // confusa; mejor decirlo acá.
  const previo = {}
  for (const linea of readFileSync(RUTA_ENV, 'utf-8').split('\n')) {
    const t = linea.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i > 0) previo[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  const motivoPrevio = motivoDeRechazo(previo.VITE_SUPABASE_URL)
  if (motivoPrevio) {
    abortar(`El ${RUTA_ENV} existente no apunta a un destino local aceptable.\n${motivoPrevio}`)
  }
  if (previo.VITE_SUPABASE_URL !== status.API_URL) {
    abortar(
      `El ${RUTA_ENV} existente apunta a ${enmascarar(previo.VITE_SUPABASE_URL)} pero el stack ` +
      `en marcha publica ${enmascarar(status.API_URL)}. Ambos son locales, pero no son el mismo ` +
      `backend.\nCorregilo, o volvé a generarlo con \`--write-env\`.`,
    )
  }
  if (!previo.E2E_PASSWORD?.trim()) {
    abortar(`El ${RUTA_ENV} existente no define E2E_PASSWORD: el seed no puede crear el usuario.`)
  }
  console.log(`  ✓ ${RUTA_ENV} existente conservado y verificado contra el stack en marcha.`)
}

// ─── 6. Marker + datos ──────────────────────────────────────────────────────
// Se reutiliza el script de 7D.2 sin tocarlo: es el que crea el marker que el
// guard exige, y valida el destino por su cuenta antes de escribir nada.
console.log('  · preparando datos (npm run e2e:prepare)…')
correr(process.execPath, ['scripts/e2e/prepare-local.mjs'],
  'La preparación del E2E local falló.', { shell: false })

// ─── 7. Playwright ──────────────────────────────────────────────────────────
console.log(`  · corriendo Playwright: ${ARGS_PLAYWRIGHT.join(' ')}`)
console.log('─'.repeat(72) + '\n')
const pw = spawnSync('npx', ['playwright', 'test', ...ARGS_PLAYWRIGHT], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
// El código de Playwright se propaga tal cual: el job debe ponerse rojo por
// TESTS, no por otra cosa. La limpieza del stack la hace el workflow con
// `if: always()` — un paso aparte, porque si esto falla igual hay que limpiar.
process.exit(pw.status ?? 1)
