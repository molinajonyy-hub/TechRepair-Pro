#!/usr/bin/env node
// ============================================================================
// P0 FIRST-STEPS-1 — NEGATIVE GATES (§20).
//
// Un test que nunca vio fallar no prueba nada. Este script reintroduce a
// proposito cada defecto que el lote cierra y verifica que el gate
// correspondiente SE PONGA EN ROJO. Si un gate sigue verde con el defecto
// puesto, ese gate es decorativo y el script falla.
//
// Todas las mutaciones se revierten en un `finally`, incluso ante Ctrl-C.
//
//   node scripts/guards/first-steps-negative-gates.mjs
// ============================================================================
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const RAIZ = resolve(process.argv[2] ?? '.')
const DB   = 'supabase_db_techrepair-vite'

const MIGRACION = 'supabase/migrations/20260905120000_first_steps_derived.sql'
const TEST_SQL  = 'tests/sql/first_steps_derived.test.sql'
const HOOK      = 'src/hooks/useFirstSteps.ts'
const CONT      = 'src/components/onboarding/FirstStepsChecklist.tsx'
const SERVICIO  = 'src/services/firstStepsService.ts'
const TEST_COMP = 'tests/components/firstStepsChecklist.test.tsx'

const p = rel => join(RAIZ, rel)
const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: RAIZ, encoding: 'utf8', shell: false, ...opts })

// ── Corredores de gate ──────────────────────────────────────────────────────

/** Corre la suite SQL con la migracion que este en disco. Devuelve exit code. */
function correrGateSQL() {
  const mig = p(MIGRACION)
  let r = sh('docker', ['cp', mig, `${DB}:/tmp/fs_mig_raw.sql`])
  if (r.status !== 0) throw new Error('docker cp migracion: ' + (r.stderr || r.stdout))
  r = sh('docker', ['cp', p(TEST_SQL), `${DB}:/tmp/fs_test.sql`])
  if (r.status !== 0) throw new Error('docker cp test: ' + (r.stderr || r.stdout))
  r = sh('docker', ['exec', DB, 'sh', '-c',
    "sed -E '/^(BEGIN|COMMIT);[[:space:]]*$/d' /tmp/fs_mig_raw.sql > /tmp/fs_mig.sql"])
  if (r.status !== 0) throw new Error('sed: ' + (r.stderr || r.stdout))
  r = sh('docker', ['exec', DB, 'psql', '-U', 'postgres', '-d', 'postgres',
                    '-v', 'ON_ERROR_STOP=1', '-q', '-f', '/tmp/fs_test.sql'])
  return { code: r.status, salida: (r.stdout || '') + (r.stderr || '') }
}

function correrGateComponente() {
  const r = sh(process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts', TEST_COMP])
  return { code: r.status, salida: (r.stdout || '') + (r.stderr || '') }
}

function correrGateEstatico() {
  const r = sh(process.execPath, ['scripts/guards/first-steps-derived.mjs'])
  return { code: r.status, salida: (r.stdout || '') + (r.stderr || '') }
}

// ── Motor ───────────────────────────────────────────────────────────────────

const GATES = [
  // ── A. localStorage como fuente de completitud ────────────────────────────
  {
    id: 'A',
    nombre: 'localStorage vuelve a ser la fuente de "done"',
    archivos: [HOOK, CONT],
    mutar() {
      // El contenedor deja de creerle al servidor y lee el progreso del
      // navegador, exactamente como hacia OnboardingChecklist.
      const t = readFileSync(p(CONT), 'utf8')
      writeFileSync(p(CONT), t.replace(
        '    done:  steps[s.key],',
        `    done:  (() => {
      try {
        const raw = localStorage.getItem('onboarding_done_local') || '[]'
        return (JSON.parse(raw) as string[]).includes(s.id)
      } catch { return false }
    })(),`))
    },
    gate: correrGateComponente,
    espera: 'el test distintivo (SOLO customer -> 1/5) debe romperse',
  },

  // ── B. egresos contados como cobro ────────────────────────────────────────
  {
    id: 'B',
    nombre: 'contar financial_movements de egreso como cobro',
    archivos: [MIGRACION],
    mutar() {
      // ADITIVO a proposito: se conservan las tres fuentes canonicas y se suma
      // una cuarta ilegitima. Asi el unico test que cambia de color es t10 —
      // si en cambio reemplazaramos una fuente, el gate se pondria rojo por
      // perder esa fuente y no probaria nada sobre los egresos.
      const t = readFileSync(p(MIGRACION), 'utf8')
      writeFileSync(p(MIGRACION), t.replace(
        `      OR EXISTS (
        -- \`credit > 0\` es la cobranza de cuenta corriente (type='pago').`,
        `      OR EXISTS (
        SELECT 1 FROM public.financial_movements fm, biz
        WHERE fm.business_id = biz.id
      )
      OR EXISTS (
        -- \`credit > 0\` es la cobranza de cuenta corriente (type='pago').`))
    },
    gate: correrGateSQL,
    espera: 'el test t10 (egreso financiero -> NO es cobro) debe fallar',
  },

  // ── C. sin tenant scoping ─────────────────────────────────────────────────
  {
    id: 'C',
    nombre: 'eliminar el scoping por tenant',
    archivos: [MIGRACION],
    mutar() {
      let t = readFileSync(p(MIGRACION), 'utf8')
      // Cada EXISTS deja de filtrar por negocio: cualquiera ve todo.
      t = t.replace(/WHERE c\.business_id = biz\.id/g,  'WHERE biz.id IS NOT NULL')
      t = t.replace(/WHERE o\.business_id = biz\.id/g,  'WHERE biz.id IS NOT NULL')
      t = t.replace(/WHERE i\.business_id = biz\.id/g,  'WHERE biz.id IS NOT NULL')
      t = t.replace(/WHERE cp\.business_id = biz\.id/g, 'WHERE biz.id IS NOT NULL')
      writeFileSync(p(MIGRACION), t)
    },
    gate: correrGateSQL,
    espera: 'el test cross-tenant (t0 no ve al vecino) debe fallar',
  },

  // ── D. GRANT a anon ───────────────────────────────────────────────────────
  {
    id: 'D',
    nombre: 'GRANT EXECUTE a anon',
    archivos: [MIGRACION],
    mutar() {
      const t = readFileSync(p(MIGRACION), 'utf8')
      writeFileSync(p(MIGRACION), t.replace(
        'GRANT EXECUTE ON FUNCTION public.get_my_first_steps() TO authenticated;',
        'GRANT EXECUTE ON FUNCTION public.get_my_first_steps() TO authenticated;\n' +
        'GRANT EXECUTE ON FUNCTION public.get_my_first_steps() TO anon;'))
    },
    gate: correrGateSQL,
    espera: 'la postcondicion de la migracion y el test de grants deben fallar',
  },

  // ── E. business_id recibido del cliente ───────────────────────────────────
  {
    id: 'E',
    nombre: 'la RPC acepta un business_id del cliente',
    archivos: [MIGRACION, SERVICIO],
    mutar() {
      let m = readFileSync(p(MIGRACION), 'utf8')
      m = m.replace('FUNCTION public.get_my_first_steps()',
                    'FUNCTION public.get_my_first_steps(p_business_id uuid)')
      writeFileSync(p(MIGRACION), m)

      let s = readFileSync(p(SERVICIO), 'utf8')
      s = s.replace(".rpc('get_my_first_steps')",
                    ".rpc('get_my_first_steps', { p_business_id: 'cualquiera' })")
      writeFileSync(p(SERVICIO), s)
    },
    gate: correrGateEstatico,
    espera: 'el guard estatico debe rechazar la firma parametrizada',
  },
]

let fallas = 0
console.log('FIRST-STEPS-1 — negative gates\n')

// Baseline: con el arbol intacto, TODOS los gates deben estar en verde.
console.log('baseline (arbol intacto):')
for (const [nombre, correr] of [
  ['SQL',        correrGateSQL],
  ['componente', correrGateComponente],
  ['estatico',   correrGateEstatico],
]) {
  const { code } = correr()
  const ok = code === 0
  console.log(`  ${ok ? 'ok  ' : 'FALLA'} gate ${nombre} en verde (exit ${code})`)
  if (!ok) fallas++
}
console.log('')

for (const g of GATES) {
  const backups = new Map()
  try {
    for (const f of g.archivos) {
      const bak = p(f) + '.negbak'
      copyFileSync(p(f), bak)
      backups.set(f, bak)
    }
    g.mutar()
    const { code, salida } = g.gate()
    if (code === 0) {
      console.error(`  FALLA  ${g.id}. ${g.nombre}`)
      console.error(`         el gate quedo VERDE con el defecto puesto — ${g.espera}`)
      fallas++
    } else {
      console.log(`  ok     ${g.id}. ${g.nombre} -> gate en ROJO (exit ${code})`)
      const pista = (salida.match(/^.*(FAIL|FALLARON|ERROR|hallazgos|esperado).*$/mi) || [''])[0].trim()
      if (pista) console.log(`         ${pista.slice(0, 150)}`)
    }
  } finally {
    for (const [f, bak] of backups) {
      if (existsSync(bak)) { copyFileSync(bak, p(f)); rmSync(bak, { force: true }) }
    }
  }
}

// Verificacion de restauracion: el arbol debe volver a verde.
console.log('\nrestauracion:')
const final = correrGateEstatico()
console.log(`  ${final.code === 0 ? 'ok  ' : 'FALLA'} guard estatico verde tras revertir (exit ${final.code})`)
if (final.code !== 0) fallas++

if (fallas) {
  console.error(`\nNEGATIVE GATES: ${fallas} problema(s).`)
  process.exit(1)
}
console.log('\nNEGATIVE GATES OK: los 5 defectos ponen su gate en rojo, y el arbol vuelve a verde.')
