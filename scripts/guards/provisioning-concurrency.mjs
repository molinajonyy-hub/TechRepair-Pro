#!/usr/bin/env node
// ============================================================================
// P0-P1 — Concurrencia real de `provision_my_business()`.
//
// Lo que NO puede medir tests/sql/canonical_owner_provisioning.test.sql: ese
// corre en UNA sesion, y la barrera que importa es entre sesiones distintas.
// Aca se abren N conexiones simultaneas que llaman a la RPC para el MISMO
// auth.uid() y se mide el resultado.
//
// PROPIEDAD BAJO PRUEBA (mas fuerte que "maximo 1 business"):
//   1. exactamente 1 business y 1 profile para ese usuario;
//   2. TODAS las llamadas concurrentes tienen exito;
//   3. todas devuelven el MISMO business_id.
//
// El punto (2) es el que justifica el advisory lock. Sin el, `profiles_pkey`
// igual impide el duplicado —la transaccion perdedora aborta con 23505 y se
// lleva su business en el rollback— pero el usuario recibe un error espurio por
// haber hecho doble click. El lock convierte esa carrera en una espera.
//
//   node scripts/guards/provisioning-concurrency.mjs
//   node scripts/guards/provisioning-concurrency.mjs --self-test
//
// LOCAL-ONLY POR CONSTRUCCION: habla por `docker exec` con el contenedor del
// stack de desarrollo. No tiene forma de alcanzar produccion — no lee URLs ni
// credenciales de ningun lado.
// ============================================================================
import { spawnSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const AUTO_TEST = process.argv.includes('--self-test')
const CONCURRENCIA = 4

// ─── Contenedor local, derivado de supabase/config.toml ─────────────────────
function contenedor() {
  let id = 'techrepair-vite'
  try {
    const m = readFileSync('supabase/config.toml', 'utf8').match(/^\s*project_id\s*=\s*"([^"]+)"/m)
    if (m) id = m[1]
  } catch { /* default */ }
  return `supabase_db_${id}`
}
const DB = contenedor()

function abortar(msg) {
  console.error(`\n✖ ${msg}\n`)
  process.exit(1)
}

/** psql sincrono. Devuelve stdout o null si fallo. */
function psql(sql, { permitirFallo = false } = {}) {
  const r = spawnSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' })
  if (r.status !== 0) {
    if (permitirFallo) return null
    abortar(`psql fallo:\n${(r.stderr || '').trim()}`)
  }
  return (r.stdout || '').trim()
}

/** psql asincrono, para lanzar en paralelo. Resuelve {ok, out, err}. */
function psqlAsync(sql) {
  return new Promise(resolve => {
    const p = spawn('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres',
      '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('close', code => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }))
    p.stdin.end(sql)
  })
}

// ─── Preflight ──────────────────────────────────────────────────────────────
const vivo = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', DB], { encoding: 'utf8' })
if (vivo.status !== 0 || (vivo.stdout || '').trim() !== 'true') {
  abortar(`El contenedor "${DB}" no esta corriendo.\nLevanta el stack local con \`supabase start\` antes de correr esto.`)
}

const existe = psql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='provision_my_business';`)
if (existe !== '1') {
  abortar('`public.provision_my_business` no existe en el stack local.\nAplica la migracion 20260823150000 primero.')
}

/**
 * Corre la carrera contra `fn` y devuelve las metricas.
 * Cada worker abre su propia transaccion, se identifica como el mismo usuario
 * y llama a la funcion. El pg_sleep inicial alinea los arranques para que la
 * contencion sea real y no un accidente del scheduler.
 */
async function carrera(fn, etiqueta) {
  const uid = psql(`SELECT gen_random_uuid();`)
  const correo = `conc_${uid.slice(0, 8)}@invalid.test`
  psql(`INSERT INTO auth.users (id, email, email_confirmed_at)
        VALUES ('${uid}', '${correo}', now());`)

  // El trigger de la fase A pudo haber provisionado ya. Se limpia para medir
  // la carrera de la RPC y no la del trigger.
  psql(`DELETE FROM public.profiles WHERE COALESCE(user_id, id) = '${uid}';
        DELETE FROM public.businesses WHERE owner_user_id = '${uid}';`)

  const sql = `
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT pg_sleep(0.35);
SELECT public.${fn}('Carrera Concurrente')->>'business_id';
COMMIT;`

  const res = await Promise.all(Array.from({ length: CONCURRENCIA }, () => psqlAsync(sql)))

  const negocios = Number(psql(`SELECT count(*) FROM public.businesses WHERE owner_user_id='${uid}';`))
  const perfiles = Number(psql(`SELECT count(*) FROM public.profiles WHERE COALESCE(user_id,id)='${uid}';`))
  const exitos = res.filter(r => r.ok)
  const ids = new Set(exitos.map(r => r.out.split('\n').filter(Boolean).pop()).filter(Boolean))

  // Limpieza. auth.users CASCADEa a profiles; el business queda suelto.
  psql(`DELETE FROM public.businesses WHERE owner_user_id='${uid}';
        DELETE FROM auth.users WHERE id='${uid}';`, { permitirFallo: true })

  const fallos = res.filter(r => !r.ok)
  console.log(`  ${etiqueta}`)
  console.log(`    llamadas concurrentes : ${CONCURRENCIA}`)
  console.log(`    exitosas              : ${exitos.length}`)
  console.log(`    fallidas              : ${fallos.length}${fallos.length ? '  (' + [...new Set(fallos.map(f => (f.err.match(/ERROR:\s*[^\n]*/) || ['?'])[0].slice(0, 70)))].join(' | ') + ')' : ''}`)
  console.log(`    businesses creados    : ${negocios}`)
  console.log(`    profiles creados      : ${perfiles}`)
  console.log(`    business_id distintos : ${ids.size}`)

  return { negocios, perfiles, exitos: exitos.length, fallos: fallos.length, distintos: ids.size }
}

// ─── Self-test: probar que el harness DETECTA la falla ──────────────────────
// Se clona la RPC quitandole UNICAMENTE el advisory lock. Si el harness no
// distinguiera esa version de la buena, no estaria midiendo nada.
async function autoTest() {
  console.log('\n─── Self-test: clon SIN barrera de concurrencia ' + '─'.repeat(24))
  const fuente = psql(`SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='provision_my_business';`)
  if (!/pg_advisory_xact_lock/.test(fuente)) {
    abortar('La funcion real ya no tiene advisory lock: el self-test no tendria sentido.')
  }
  const inseguro = fuente
    .replace(/FUNCTION public\.provision_my_business/, 'FUNCTION public._conc_inseguro')
    .replace(/PERFORM pg_advisory_xact_lock\([^;]*\);/, '-- lock removido a proposito')
  psql(inseguro)

  let r
  try {
    r = await carrera('_conc_inseguro', 'sin lock:')
  } finally {
    psql('DROP FUNCTION IF EXISTS public._conc_inseguro(text);', { permitirFallo: true })
  }

  // Sin lock, `profiles_pkey` sigue impidiendo el duplicado, pero alguna
  // llamada tiene que haber fallado. Si TODAS pasaron, el harness no genera
  // contencion y sus resultados no prueban nada.
  if (r.fallos === 0) {
    abortar('SELF-TEST FALLIDO: sin el lock ninguna llamada fallo.\n' +
            'El harness no esta generando contencion real, asi que un verde no significa nada.')
  }
  console.log(`\n  ✓ self-test OK: sin lock, ${r.fallos}/${CONCURRENCIA} llamadas fallaron.`)
  console.log('    El harness genera contencion real y distingue las dos versiones.')
}

// ─── Main ───────────────────────────────────────────────────────────────────
const main = async () => {
  if (AUTO_TEST) { await autoTest(); return }

  console.log('\n─── Concurrencia de provision_my_business ' + '─'.repeat(30))
  const r = await carrera('provision_my_business', 'con lock:')

  const errores = []
  if (r.negocios !== 1) errores.push(`se esperaba 1 business, hubo ${r.negocios}`)
  if (r.perfiles !== 1) errores.push(`se esperaba 1 profile, hubo ${r.perfiles}`)
  if (r.fallos !== 0) errores.push(`${r.fallos} llamada(s) fallaron; el lock deberia convertir la carrera en espera`)
  if (r.distintos !== 1) errores.push(`las llamadas devolvieron ${r.distintos} business_id distintos`)

  if (errores.length) {
    abortar('CONCURRENCIA ROTA:\n  · ' + errores.join('\n  · '))
  }
  console.log('\n  ✓ 1 business, 1 profile, 4/4 exitosas, un unico business_id.\n')
}

main().catch(e => abortar(e?.stack || String(e)))
