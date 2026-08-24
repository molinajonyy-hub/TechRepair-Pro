#!/usr/bin/env node
/**
 * P0-P6 — Pruebas NEGATIVAS de los gates (brief sección 25).
 *
 * Un test verde no prueba nada si nunca puede ponerse en rojo. Este script
 * rompe A PROPÓSITO cada invariante y verifica que el gate falle de verdad.
 *
 *   A. quitar el gate visual de Ganancia Real -> el component test debe fallar
 *   B. dejar entrar a tech en la RLS financiera -> el SQL security test debe fallar
 *   C. permitir /finance sin capacidad          -> el route test debe fallar
 *   D. mostrar SaaS Admin a un owner normal     -> el component test debe fallar
 *   E. permitir Mi Guita a un actor externo     -> el test debe fallar
 *
 * PRECONDICIÓN: los archivos que se mutan tienen que estar LIMPIOS en git.
 * `git checkout --` descarta cambios sin commitear.
 *
 * Uso (stack local levantado, cambios ya commiteados):
 *   node scripts/p0p6-negative-gates.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONTENEDOR = 'supabase_db_techrepair-vite'
const MIGRACION = 'supabase/migrations/20260826120000_p0p6_capability_rbac.sql'
const TEST_SQL = 'tests/sql/p0p6_capability_rbac.test.sql'
const SUITE = 'tests/components/rbacCapabilities.test.tsx'

const ARCHIVOS_MUTADOS = [
  'src/pages/Dashboard.tsx',
  'src/components/auth/ProtectedRouteByPermission.tsx',
  'src/components/layout/Sidebar.tsx',
  'src/components/auth/PersonalProtectedRoute.tsx',
]

let fallas = 0

const leer = (p) => readFileSync(p, 'utf8')
const escribir = (p, c) => writeFileSync(p, c, 'utf8')
const tmp = (n) => join(tmpdir(), n)

function correr(cmd, args) {
  try {
    return { ok: true, salida: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { ok: false, salida: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

{
  const sucio = execFileSync('git', ['status', '--porcelain', '--', ...ARCHIVOS_MUTADOS], { encoding: 'utf8' }).trim()
  if (sucio) {
    console.error('ABORTADO: hay cambios sin commitear en los archivos que este script muta.')
    console.error('`git checkout --` los descartaria. Commitea primero.\n' + sucio)
    process.exit(2)
  }
}

const restaurarArchivo = (p) => execFileSync('git', ['checkout', '--', p], { stdio: 'ignore' })

/** `patron` CORTO: vitest y psql envuelven las lineas largas. */
function esperarFallo(etiqueta, resultado, patron) {
  const plano = resultado.salida.replace(/\s+/g, ' ')
  if (!resultado.ok && plano.includes(patron)) {
    console.log(`  OK    ${etiqueta} -> el gate fallo como se esperaba`)
    const l = resultado.salida.split('\n').find(x => x.replace(/\s+/g, ' ').includes(patron))
    if (l) console.log(`        ${l.trim().slice(0, 150)}`)
    return
  }
  console.log(`  FALLA ${etiqueta} -> el gate NO detecto la mutacion (exit ok=${resultado.ok})`)
  for (const l of resultado.salida.trim().split('\n').slice(-5)) console.log(`        ${l.trim().slice(0, 150)}`)
  fallas += 1
}

// Node 24 no puede execFileSync un .cmd (EINVAL, CVE-2024-27980): se invoca el
// entrypoint JS de vitest con el mismo Node.
const vitest = () =>
  correr(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts', SUITE])

function psql(archivoLocal, destino) {
  execFileSync('docker', ['cp', archivoLocal, `${CONTENEDOR}:${destino}`], { stdio: 'ignore' })
  return correr('docker', ['exec', CONTENEDOR, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-f', destino])
}

const restaurarDB = () => {
  const r = psql(MIGRACION, '/tmp/p0p6.sql')
  console.log(r.ok ? '  ...migracion canonica restaurada' : '  !! no se pudo restaurar la migracion')
}

const mutar = (etiqueta, archivo, buscar, reemplazo, patron) => {
  const original = leer(archivo)
  const mutado = original.replace(buscar, reemplazo)
  if (mutado === original) {
    console.log(`  FALLA ${etiqueta} -> la mutacion no se aplico (cambio el texto fuente?)`)
    fallas += 1
    return
  }
  escribir(archivo, mutado)
  esperarFallo(etiqueta, vitest(), patron)
  restaurarArchivo(archivo)
  console.log(`  ...${archivo} restaurado`)
}

console.log('==============================================================')
console.log('A. Quitar el gate visual de Ganancia Real')
console.log('==============================================================')
mutar('A/dashboard', 'src/pages/Dashboard.tsx',
  "  const puedeVerFinanzas = can('finance')",
  '  const puedeVerFinanzas = true',
  'tarjetas financieras')

console.log('')
console.log('==============================================================')
console.log('B. Dejar entrar a tech en la RLS financiera')
console.log('==============================================================')
{
  const original = leer(MIGRACION)
  // Se quita el chequeo de capacidad: vuelve a quedar sólo el filtro de tenant,
  // que es exactamente el estado que este lote cierra.
  const mutado = original.replace(
    "    business_id = public.current_user_business_id()\n    AND public.current_user_can('finance')\n  );\n\n-- El ledger devengado",
    '    business_id = public.current_user_business_id()\n  );\n\n-- El ledger devengado',
  )
  if (mutado === original) {
    console.log('  FALLA B -> la mutacion no se aplico')
    fallas += 1
  } else {
    const f = tmp('p0p6_mutB.sql')
    escribir(f, mutado)
    // La propia postcondicion de la migracion tiene que rechazarla.
    esperarFallo('B1/postcondicion P3 (migracion)', psql(f, '/tmp/mutB.sql'), 'POSTCOND P3')

    // Y si alguien saltea las postcondiciones, el SQL security test tiene que
    // ver que el tech leyo filas financieras.
    const sinPost = mutado.replace(/DO \$post\$[\s\S]*?\$post\$;/, '')
    const f2 = tmp('p0p6_mutB2.sql')
    escribir(f2, sinPost)
    psql(f2, '/tmp/mutB2.sql')
    esperarFallo('B2/SQL security test', psql(TEST_SQL, '/tmp/t6.sql'), 'el tech leyó')
    restaurarDB()
  }
}

console.log('')
console.log('==============================================================')
console.log('C. Permitir /finance sin capacidad')
console.log('==============================================================')
mutar('C/route guard', 'src/components/auth/ProtectedRouteByPermission.tsx',
  '  if (can(permission)) return <Outlet />',
  '  return <Outlet />\n  if (can(permission)) return <Outlet />',
  'denegado')

console.log('')
console.log('==============================================================')
console.log('D. Mostrar SaaS Admin a un owner normal')
console.log('==============================================================')
mutar('D/sidebar SaaS Admin', 'src/components/layout/Sidebar.tsx',
  'if (item.systemOwnerOnly && !isSystemOwner) return false;',
  'if (item.systemOwnerOnly && !isSystemOwner) return true;',
  'SaaS Admin depende')

console.log('')
console.log('==============================================================')
console.log('E. Permitir Mi Guita a un actor externo')
console.log('==============================================================')
mutar('E/Mi Guita', 'src/components/auth/PersonalProtectedRoute.tsx',
  '  if (!isSystemOwner) {\n    return <Navigate to="/dashboard" replace />\n  }',
  '  // gate removido a proposito',
  'el gate es system_admins')

console.log('')
console.log('==============================================================')
if (fallas === 0) {
  console.log('PRUEBAS NEGATIVAS: 6/6 gates demostrados (fallan cuando deben)')
  process.exit(0)
}
console.log(`PRUEBAS NEGATIVAS: ${fallas} gate(s) NO detectaron su mutacion`)
process.exit(1)
