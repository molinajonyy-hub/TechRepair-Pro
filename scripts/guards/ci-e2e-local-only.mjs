#!/usr/bin/env node
// ============================================================================
// Guard — El E2E de CI corre SÓLO contra un Supabase local descartable.
//
//   node scripts/guards/ci-e2e-local-only.mjs             (valida el repo)
//   node scripts/guards/ci-e2e-local-only.mjs --self-test (valida el guard)
//
// ┌── QUÉ PROTEGE ──────────────────────────────────────────────────────────┐
// │ El job E2E solía recibir `secrets.VITE_SUPABASE_URL`. Un secret llamado │
// │ así apunta, por definición, al backend de un entorno real: el arreglo   │
// │ obvio cuando el job se pone rojo es "completá los secrets", y eso       │
// │ devuelve la suite —que ESCRIBE datos— a un proyecto gestionado.         │
// │ El guard hace que ese camino no compile.                                │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Se valida el ENCADENAMIENTO real (workflow → script npm → archivo), no la
// forma del YAML: un cambio de indentación o de orden de pasos no lo rompe,
// pero borrar el bootstrap sí. Las comprobaciones de ausencia (project ref
// productivo, service_role, secrets) son textuales a propósito: "esta cadena no
// aparece" es exactamente lo que hay que probar.
// ============================================================================
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { motivoDeRechazo } from '../../tests/e2e/setup/assertLocalTarget.ts'

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const WORKFLOWS = join(RAIZ, '.github', 'workflows')
const CI_YML = join(WORKFLOWS, 'ci.yml')

/** Project ref del Supabase PRODUCTIVO. Ya está en tests/unit/e2eTargetGuard.test.ts. */
const REF_PRODUCTIVO = 'vrdxxmjzxhfgqlnxmbwx'
const SCRIPT_BOOTSTRAP = 'e2e:ci-local'

/**
 * Único host gestionado tolerado fuera del job E2E: el dummy del `npm run build`
 * del job `quality`, que sólo comprueba bundling y jamás abre una conexión.
 * Dentro del job E2E no se tolera NINGUNO, ni siquiera éste — ahí sí se escribe.
 */
const HOST_DUMMY_BUILD = 'placeholder.supabase.co'

// ─── Extracción del bloque de un job ────────────────────────────────────────
/**
 * Devuelve el texto del job pedido. Los jobs cuelgan de `jobs:` con una sangría
 * mayor; el bloque termina en la primera línea con sangría <= la del nombre.
 * Es un subconjunto de YAML, pero suficiente y determinista para lo que se mide.
 */
export function bloqueDeJob(yaml, nombre) {
  const lineas = yaml.split('\n')
  const iJobs = lineas.findIndex(l => /^jobs:\s*$/.test(l))
  if (iJobs === -1) return null

  const re = new RegExp(`^(\\s+)${nombre}:\\s*$`)
  let inicio = -1
  let sangria = 0
  for (let i = iJobs + 1; i < lineas.length; i++) {
    const m = lineas[i].match(re)
    if (m) { inicio = i; sangria = m[1].length; break }
  }
  if (inicio === -1) return null

  const out = [lineas[inicio]]
  for (let i = inicio + 1; i < lineas.length; i++) {
    const l = lineas[i]
    if (l.trim() === '') { out.push(l); continue }
    const s = l.length - l.trimStart().length
    if (s <= sangria) break
    out.push(l)
  }
  return out.join('\n')
}

/** Nombres de los jobs declarados, en orden. */
export function nombresDeJobs(yaml) {
  const lineas = yaml.split('\n')
  const iJobs = lineas.findIndex(l => /^jobs:\s*$/.test(l))
  if (iJobs === -1) return []
  const nombres = []
  let sangria = null
  for (let i = iJobs + 1; i < lineas.length; i++) {
    const l = lineas[i]
    if (l.trim() === '' || /^\s*#/.test(l)) continue
    const s = l.length - l.trimStart().length
    if (s === 0) break
    if (sangria === null) sangria = s
    if (s !== sangria) continue
    const m = l.match(/^\s+([A-Za-z0-9_-]+):\s*$/)
    if (m) nombres.push(m[1])
  }
  return nombres
}

/** El job que corre E2E: el único que invoca el bootstrap local. */
export function jobE2E(yaml) {
  for (const nombre of nombresDeJobs(yaml)) {
    const bloque = bloqueDeJob(yaml, nombre)
    if (bloque && bloque.includes(SCRIPT_BOOTSTRAP)) return { nombre, bloque }
  }
  return null
}

// ─── Comprobaciones ─────────────────────────────────────────────────────────
/**
 * Devuelve la lista de violaciones. Recibe el contenido por parámetro para que
 * el self-test pueda alimentarle un workflow adulterado sin tocar el disco.
 */
export function violaciones({ ciYml, pkg, archivosWorkflow, existeArchivo }) {
  const fallas = []
  const err = (codigo, detalle) => fallas.push({ codigo, detalle })

  // ── C · El E2E arranca su propio entorno seguro ──────────────────────────
  const job = jobE2E(ciYml)
  if (!job) {
    err('C1', `Ningún job de ci.yml invoca "${SCRIPT_BOOTSTRAP}". Sin bootstrap del stack ` +
              'local, el E2E sólo puede correr contra un backend remoto o no correr.')
  } else {
    if (!/supabase\/setup-cli/.test(job.bloque)) {
      err('C2', `El job "${job.nombre}" no instala la CLI de Supabase (supabase/setup-cli). ` +
                'Sin CLI no hay stack local que levantar.')
    }
    // ── Limpieza incondicional ─────────────────────────────────────────────
    if (!/supabase\s+stop/.test(job.bloque)) {
      err('C3', `El job "${job.nombre}" no detiene el stack local. Un runner con contenedores ` +
                'colgados no es descartable.')
    } else if (!/if:\s*always\(\)/.test(job.bloque)) {
      err('C4', `El job "${job.nombre}" detiene el stack sin \`if: always()\`: si los tests ` +
                'fallan, la limpieza se saltea.')
    }
    // ── F · El destino se genera, no se recibe ─────────────────────────────
    const usaSecrets = [...job.bloque.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(m => m[1])
    if (usaSecrets.length > 0) {
      err('F1', `El job "${job.nombre}" consume secrets del repo (${[...new Set(usaSecrets)].join(', ')}). ` +
                'El E2E local no necesita ninguno: sus credenciales salen de `supabase status`. ' +
                'Depender de un secret es el camino de vuelta a apuntar a un entorno real.')
    }
    // El destino no puede venir fijado por el workflow: lo publica el stack.
    const envDestino = job.bloque.match(/^\s*VITE_SUPABASE_URL:\s*(\S.*)$/m)
    if (envDestino) {
      err('F2', `El job "${job.nombre}" fija VITE_SUPABASE_URL en el workflow ` +
                `(${envDestino[1].trim()}). Debe salir de \`supabase status\`, vía ${SCRIPT_BOOTSTRAP}.`)
    }
    // Dentro del job que ESCRIBE datos no se tolera ningún host gestionado,
    // ni siquiera el dummy del build: acá no hay ninguno que sea inofensivo.
    const enJob = [...job.bloque.matchAll(/[A-Za-z0-9-]+\.supabase\.(?:co|in)/g)].map(m => m[0])
    if (enJob.length > 0) {
      err('D3', `El job "${job.nombre}" menciona un Supabase gestionado ` +
                `(${[...new Set(enJob)].join(', ')}). Este job escribe datos: su destino sólo ` +
                'puede ser el stack local que él mismo levanta.')
    }
  }

  // ── C · La cadena workflow → npm → archivo existe de verdad ──────────────
  const definicion = pkg?.scripts?.[SCRIPT_BOOTSTRAP]
  if (!definicion) {
    err('C5', `package.json no define el script "${SCRIPT_BOOTSTRAP}" que el workflow invoca.`)
  } else {
    const ruta = definicion.match(/([\w./-]+\.mjs)/)?.[1]
    if (!ruta) {
      err('C6', `El script "${SCRIPT_BOOTSTRAP}" no apunta a un archivo .mjs reconocible.`)
    } else if (!existeArchivo(ruta)) {
      err('C7', `El script "${SCRIPT_BOOTSTRAP}" apunta a "${ruta}", que no existe.`)
    }
  }

  // ── D/E · Nada productivo puede vivir en .github/workflows ───────────────
  for (const [nombre, contenido] of Object.entries(archivosWorkflow)) {
    if (contenido.includes(REF_PRODUCTIVO)) {
      err('D1', `${nombre} menciona el project ref PRODUCTIVO (${REF_PRODUCTIVO}).`)
    }
    const gestionados = [...new Set(
      [...contenido.matchAll(/[A-Za-z0-9-]+\.supabase\.(?:co|in)/g)].map(m => m[0]),
    )].filter(h => h !== HOST_DUMMY_BUILD)
    if (gestionados.length > 0) {
      err('D2', `${nombre} referencia un Supabase gestionado (${gestionados.join(', ')}). ` +
                `El único host gestionado admitido en un workflow es "${HOST_DUMMY_BUILD}", ` +
                'el dummy del build que nunca abre una conexión.')
    }
    const serviceRole = [...contenido.matchAll(/secrets\.([A-Za-z0-9_]*SERVICE_ROLE[A-Za-z0-9_]*)/gi)].map(m => m[1])
    if (serviceRole.length > 0) {
      err('E1', `${nombre} usa un secret de service_role (${[...new Set(serviceRole)].join(', ')}). ` +
                'La service key del E2E es la de demo del stack local, no un secret del repo.')
    }
  }

  // ── A/B · SafeDev sigue siendo fail-closed ───────────────────────────────
  // Se prueba el COMPORTAMIENTO del validador que el CI va a usar, no su texto:
  // si alguien le agrega un escape, esto falla acá y no en producción.
  const remotos = [
    `https://${REF_PRODUCTIVO}.supabase.co`,
    'https://otroproyecto.supabase.co',
    'https://api.miempresa.com',
    'http://192.168.1.50:54321',
    '',
  ]
  for (const url of remotos) {
    if (!motivoDeRechazo(url)) {
      err('A1', `SafeDev ACEPTA un destino no local: "${url || '(vacío)'}". El guard de M7 7D.2 ` +
                'dejó de ser fail-closed.')
    }
  }
  const locales = ['http://127.0.0.1:54421', 'http://localhost:54321', 'http://127.0.0.1:54321']
  for (const url of locales) {
    const m = motivoDeRechazo(url)
    if (m) {
      err('B1', `SafeDev RECHAZA un destino local legítimo: "${url}" (${m}). Un guard que ` +
                'bloquea lo correcto termina desactivado.')
    }
  }

  return fallas
}

// ─── Lectura del repo ───────────────────────────────────────────────────────
function leerWorkflows() {
  if (!existsSync(WORKFLOWS)) return {}
  const out = {}
  for (const nombre of readdirSync(WORKFLOWS)) {
    const ruta = join(WORKFLOWS, nombre)
    if (statSync(ruta).isFile() && /\.ya?ml$/.test(nombre)) {
      out[`.github/workflows/${nombre}`] = readFileSync(ruta, 'utf-8')
    }
  }
  return out
}

function entradaReal() {
  if (!existsSync(CI_YML)) {
    console.error('\n✖ No existe .github/workflows/ci.yml: no hay nada que validar.\n')
    process.exit(1)
  }
  return {
    ciYml: readFileSync(CI_YML, 'utf-8'),
    pkg: JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf-8')),
    archivosWorkflow: leerWorkflows(),
    existeArchivo: (ruta) => existsSync(join(RAIZ, ruta)),
  }
}

// ─── Self-test ──────────────────────────────────────────────────────────────
// Un guard que nunca se vio fallar no es evidencia de nada: cada mutación de
// abajo es un camino real de vuelta a producción.
function selfTest() {
  const base = entradaReal()
  const casos = [
    {
      nombre: 'sin bootstrap local en ningún job',
      codigo: 'C1',
      mutar: e => ({ ...e, ciYml: e.ciYml.split(SCRIPT_BOOTSTRAP).join('test:e2e:smoke') }),
    },
    {
      nombre: 'el job E2E vuelve a recibir secrets del repo',
      codigo: 'F1',
      mutar: e => ({
        ...e,
        ciYml: e.ciYml.replace(
          /^(\s+)- name: Run E2E/m,
          '$1- name: Fuga\n$1  env:\n$1    VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}\n$1- name: Run E2E',
        ),
      }),
    },
    {
      nombre: 'un workflow menciona el project ref productivo',
      codigo: 'D1',
      mutar: e => ({
        ...e,
        archivosWorkflow: { ...e.archivosWorkflow, '.github/workflows/x.yml': `url: https://${REF_PRODUCTIVO}.supabase.co` },
      }),
    },
    {
      nombre: 'el dummy del build se cambia por un host gestionado real',
      codigo: 'D2',
      mutar: e => ({
        ...e,
        archivosWorkflow: Object.fromEntries(Object.entries(e.archivosWorkflow).map(
          ([k, v]) => [k, v.split(HOST_DUMMY_BUILD).join('staging-real.supabase.co')],
        )),
      }),
    },
    {
      nombre: 'el job E2E menciona un host gestionado (aunque sea el dummy)',
      codigo: 'D3',
      mutar: e => ({
        ...e,
        ciYml: e.ciYml.replace(
          /^(\s+)- name: Run E2E/m,
          `$1- name: Fuga\n$1  env:\n$1    ALGO: https://${HOST_DUMMY_BUILD}\n$1- name: Run E2E`,
        ),
      }),
    },
    {
      nombre: 'un workflow usa un secret de service_role',
      codigo: 'E1',
      mutar: e => ({
        ...e,
        archivosWorkflow: { ...e.archivosWorkflow, '.github/workflows/x.yml': 'k: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}' },
      }),
    },
    {
      nombre: 'el script npm del bootstrap desaparece',
      codigo: 'C5',
      mutar: e => ({ ...e, pkg: { ...e.pkg, scripts: { ...e.pkg.scripts, [SCRIPT_BOOTSTRAP]: undefined } } }),
    },
    {
      nombre: 'el script npm apunta a un archivo inexistente',
      codigo: 'C7',
      mutar: e => ({ ...e, pkg: { ...e.pkg, scripts: { ...e.pkg.scripts, [SCRIPT_BOOTSTRAP]: 'node scripts/e2e/no-existe.mjs' } } }),
    },
    {
      nombre: 'la limpieza del stack deja de ser incondicional',
      codigo: 'C4',
      mutar: e => ({ ...e, ciYml: e.ciYml.split('if: always()').join('if: success()') }),
    },
    {
      nombre: 'el workflow vuelve a fijar el destino a mano',
      codigo: 'F2',
      mutar: e => ({
        ...e,
        ciYml: e.ciYml.replace(
          /^(\s+)- name: Run E2E/m,
          '$1- name: Fuga\n$1  env:\n$1    VITE_SUPABASE_URL: https://algo.example.com\n$1- name: Run E2E',
        ),
      }),
    },
  ]

  let fallos = 0
  console.log('\n── self-test del guard ' + '─'.repeat(48))

  const limpio = violaciones(base)
  if (limpio.length > 0) {
    console.log('  ⚠ el repo actual YA viola el guard; el self-test igual verifica las mutaciones.')
  }

  for (const caso of casos) {
    const detectadas = violaciones(caso.mutar(base)).map(v => v.codigo)
    const ok = detectadas.includes(caso.codigo)
    console.log(`  ${ok ? '✓' : '✖'} ${caso.nombre} → ${caso.codigo}${ok ? '' : ` NO detectado (vio: ${detectadas.join(', ') || 'nada'})`}`)
    if (!ok) fallos++
  }

  console.log('─'.repeat(72))
  if (fallos > 0) {
    console.error(`\n✖ El guard no detecta ${fallos} regresión(es). No sirve como gate.\n`)
    process.exit(1)
  }
  console.log(`✓ El guard detecta las ${casos.length} regresiones probadas.\n`)
}

// ─── Main ───────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const fallas = violaciones(entradaReal())
  if (fallas.length > 0) {
    console.error('\n' + '═'.repeat(72))
    console.error('GUARD CI/E2E: el E2E podría correr contra un backend que no es local')
    console.error('═'.repeat(72))
    for (const f of fallas) console.error(`  [${f.codigo}] ${f.detalle}`)
    console.error('═'.repeat(72) + '\n')
    process.exit(1)
  }
  console.log('✓ Guard CI/E2E: el job E2E levanta su propio Supabase local, sin secrets del repo.')
}
