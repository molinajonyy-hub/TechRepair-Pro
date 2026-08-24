#!/usr/bin/env node
/**
 * P0-P4 + P0-P5 — Pruebas NEGATIVAS de los gates (brief sección 21).
 *
 * Un test verde no prueba nada si nunca puede ponerse en rojo. Este script
 * rompe A PROPÓSITO cada invariante y verifica que el gate correspondiente
 * falle de verdad.
 *
 *   A. quitar el guard de hidratación   -> el test de hidratación debe fallar
 *   B. aceptar business_id en la RPC    -> la postcondición P2 debe rechazar
 *   C. relajar el path de Storage       -> la postcondición P8b debe rechazar
 *   D. ignorar el error de persistencia -> el test de «no avanza» debe fallar
 *
 * Las mutaciones son TEMPORALES: los archivos del frontend se revierten con
 * `git checkout --` y la DB reaplicando la migración canónica. Nada roto se
 * commitea.
 *
 * PRECONDICIÓN: los archivos que se mutan tienen que estar LIMPIOS en git.
 * `git checkout --` descarta cambios sin commitear, así que correr esto con
 * trabajo a medias borraría ese trabajo — ya pasó una vez durante el desarrollo
 * de este mismo lote.
 *
 * Uso (stack local levantado, cambios ya commiteados):
 *   node scripts/p0p4p5-negative-gates.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONTENEDOR = 'supabase_db_techrepair-vite'
const MIGRACION = 'supabase/migrations/20260825120000_p0p5_business_onboarding_setup.sql'
const SUITE = 'tests/components/routingRecoveryOnboarding.test.tsx'

const ARCHIVOS_MUTADOS = [
  'src/components/auth/ProtectedRoute.tsx',
  'src/pages/Onboarding.tsx',
]

let fallas = 0

const leer = (p) => readFileSync(p, 'utf8')
const escribir = (p, c) => writeFileSync(p, c, 'utf8')
const tmp = (n) => join(tmpdir(), n)

function correr(cmd, args) {
  try {
    const salida = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { ok: true, salida }
  } catch (e) {
    return { ok: false, salida: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

// ── Precondición: sin cambios sin commitear en lo que vamos a mutar ─────────
{
  const sucio = execFileSync('git', ['status', '--porcelain', '--', ...ARCHIVOS_MUTADOS], { encoding: 'utf8' }).trim()
  if (sucio) {
    console.error('ABORTADO: hay cambios sin commitear en los archivos que este script muta.')
    console.error('`git checkout --` los descartaria. Commitea primero.\n')
    console.error(sucio)
    process.exit(2)
  }
}

const restaurarArchivo = (p) => execFileSync('git', ['checkout', '--', p], { stdio: 'ignore' })

/**
 * `patron` tiene que ser CORTO. Vitest envuelve las lineas largas, y un patron
 * de varias palabras se parte al medio con un salto de linea: el gate
 * funcionaba y el match fallaba igual. Se normalizan los espacios para que un
 * wrap no rompa la busqueda.
 */
function esperarFallo(etiqueta, resultado, patron) {
  const plano = resultado.salida.replace(/\s+/g, ' ')
  // Tiene que fallar Y fallar POR LO QUE ESPERAMOS. Un exit code distinto de 0
  // por cualquier otro motivo no prueba que el gate funcione.
  if (!resultado.ok && plano.includes(patron)) {
    console.log(`  OK    ${etiqueta} -> el gate fallo como se esperaba`)
    const linea = resultado.salida.split('\n').find(l => l.replace(/\s+/g, ' ').includes(patron))
    if (linea) console.log(`        ${linea.trim().slice(0, 150)}`)
    return
  }
  console.log(`  FALLA ${etiqueta} -> el gate NO detecto la mutacion (exit ok=${resultado.ok})`)
  console.log('        --- ultimas lineas de la salida ---')
  for (const l of resultado.salida.trim().split('\n').slice(-6)) {
    console.log(`        ${l.trim().slice(0, 150)}`)
  }
  fallas += 1
}

function psql(archivoLocal, destino) {
  execFileSync('docker', ['cp', archivoLocal, `${CONTENEDOR}:${destino}`], { stdio: 'ignore' })
  return correr('docker', [
    'exec', CONTENEDOR, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-f', destino,
  ])
}

const restaurarDB = () => {
  const r = psql(MIGRACION, '/tmp/p0p5.sql')
  console.log(r.ok ? '  ...migracion canonica restaurada' : '  !! no se pudo restaurar la migracion')
}

/**
 * Se invoca el entrypoint JS de vitest con el mismo Node, NO `npx`.
 *
 * MEDIDO: en Windows con Node 24, `execFileSync('npx.cmd', ...)` falla con
 * EINVAL —el endurecimiento por CVE-2024-27980 bloquea ejecutar .cmd sin
 * shell— y `execFileSync('npx', ...)` con ENOENT. En los dos casos el proceso
 * muere ANTES de correr nada y stdout queda vacio, asi que el script reportaba
 * «el gate no detecto la mutacion» cuando en realidad el test nunca corrio: un
 * falso ROJO que podria haberse leido como un falso verde en el caso opuesto.
 *
 * Llamar al .mjs directo evita el shell y sus problemas de quoting.
 */
const VITEST_BIN = 'node_modules/vitest/vitest.mjs'
const vitest = () =>
  correr(process.execPath, [VITEST_BIN, 'run', '--config', 'vitest.config.ts', SUITE])

// ════════════════════════════════════════════════════════════════════════════
console.log('==============================================================')
console.log('A. Quitar el guard de hidratacion de ProtectedRoute')
console.log('==============================================================')
{
  const archivo = 'src/components/auth/ProtectedRoute.tsx'
  const original = leer(archivo)

  // El defecto historico: tratar «el perfil todavia no cargo» como «no tiene
  // negocio» y redirigir. Se reintroduce exactamente eso.
  const mutado = original.replace(
    "    case 'AUTHENTICATED_PROFILE_LOADING':",
    "    case 'AUTHENTICATED_PROFILE_LOADING':\n      return <Navigate to=\"/no-business\" replace />",
  )

  if (mutado === original) {
    console.log('  FALLA A -> la mutacion no se aplico (cambio el texto fuente?)')
    fallas += 1
  } else {
    escribir(archivo, mutado)
    esperarFallo('A/test de hidratacion', vitest(), 'NO redirige')
    restaurarArchivo(archivo)
    console.log('  ...ProtectedRoute restaurado')
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('==============================================================')
console.log('B. Aceptar business_id como parametro de la RPC')
console.log('==============================================================')
{
  const original = leer(MIGRACION)

  // Se agrega el parametro prohibido: el tenant volveria a ser un dato del
  // cliente en vez de derivarse de auth.uid().
  const mutado = original.replace(
    'CREATE OR REPLACE FUNCTION public.update_my_business_onboarding(\n  p_name             text    DEFAULT NULL,',
    'CREATE OR REPLACE FUNCTION public.update_my_business_onboarding(\n  p_business_id      uuid    DEFAULT NULL,\n  p_name             text    DEFAULT NULL,',
  )

  if (mutado === original) {
    console.log('  FALLA B -> la mutacion no se aplico')
    fallas += 1
  } else {
    const f = tmp('p0p5_mutB.sql')
    escribir(f, mutado)
    esperarFallo('B/postcondicion P2 (migracion)', psql(f, '/tmp/mutB.sql'), 'POSTCOND P2')
    restaurarDB()
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('==============================================================')
console.log('C. Relajar el path de Storage (cross-tenant)')
console.log('==============================================================')
{
  const original = leer(MIGRACION)

  // Se quita el scope de tenant de las tres policies: vuelve a alcanzar con
  // «tener algun perfil», que es como el negocio A podia pisar el logo del B.
  const mutado = original.replaceAll(
    '    AND (storage.foldername(name))[2] = public.current_user_business_id()::text\n',
    '',
  )

  if (mutado === original) {
    console.log('  FALLA C -> la mutacion no se aplico')
    fallas += 1
  } else {
    const f = tmp('p0p5_mutC.sql')
    escribir(f, mutado)
    esperarFallo('C/postcondicion P8b (migracion)', psql(f, '/tmp/mutC.sql'), 'POSTCOND P8b')
    restaurarDB()
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('==============================================================')
console.log('D. Ignorar el error de persistencia y avanzar igual')
console.log('==============================================================')
{
  const archivo = 'src/pages/Onboarding.tsx'
  const original = leer(archivo)

  // El defecto historico exacto: avanzar de paso pase lo que pase.
  const mutado = original.replace(
    '      // NO se avanza: el dato obligatorio no quedó persistido.',
    '      setStep(siguiente)',
  )

  if (mutado === original) {
    console.log('  FALLA D -> la mutacion no se aplico')
    fallas += 1
  } else {
    escribir(archivo, mutado)
    esperarFallo('D/test de persistencia', vitest(), 'NO avanza')
    restaurarArchivo(archivo)
    console.log('  ...Onboarding restaurado')
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('==============================================================')
if (fallas === 0) {
  console.log('PRUEBAS NEGATIVAS: 4/4 gates demostrados (fallan cuando deben)')
  process.exit(0)
}
console.log(`PRUEBAS NEGATIVAS: ${fallas} gate(s) NO detectaron su mutacion`)
process.exit(1)
