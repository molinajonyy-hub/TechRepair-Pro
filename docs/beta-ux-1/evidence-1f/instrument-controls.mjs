// BUTTON-SYSTEM-1A (microfix) — el instrumento de contraste y sus controles negativos.
//
// `paintedContrastOf` (tests/e2e/helpers/contrast.ts) mide con DOS capturas del
// mismo recorte. En CI la página se movió entre las dos y la medida salió de
// otro lugar: «1,05:1 sobre rgb(31, 27, 27)» con el botón pintado en ámbar.
//
// Este runner:
//   1. toma del spec REAL (`tests/e2e/m7/cta-contrast.spec.ts`) el bloque «El
//      instrumento de medida» —usa `page.setContent`: no necesita ni la app ni
//      la base— y lo corre en Chromium: tiene que dar verde;
//   2. rompe A PROPÓSITO el helper, de a una mutación, y exige que el bloque se
//      ponga rojo en el test que corresponde;
//   3. restaura el helper y comprueba, byte a byte, que quedó igual.
//
// Uso: node instrument-controls.mjs <worktree>
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.argv[2]
const HELPER = 'tests/e2e/helpers/contrast.ts'
const SPEC = 'tests/e2e/m7/cta-contrast.spec.ts'
const tmp = path.join(root, '.instrument-controls-tmp')

// ── 1 · el bloque del instrumento, tal cual está en el spec ──────────────────
const fuente = fs.readFileSync(path.join(root, SPEC), 'utf8')
const desde = fuente.indexOf("test.describe('@beta-ux-1e El instrumento de medida'")
const hasta = fuente.indexOf("test.describe('@beta-ux-1e Usuarios'")
if (desde < 0 || hasta < 0) throw new Error('no se encontró el bloque del instrumento en el spec')
const bloque = fuente.slice(desde, fuente.lastIndexOf('// ═', hasta))

fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
fs.writeFileSync(path.join(tmp, 'instrument.spec.ts'), `import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { AA_SMALL_TEXT, MEASURE_ATTEMPTS, MOVED_DURING_MEASUREMENT, contrastOf, paintedContrastOf } from '../${HELPER.replace(/\.ts$/, '')}'

const VIEWPORT = { mobile: { width: 375, height: 812 }, desktop: { width: 1440, height: 900 } }
test.use({ deviceScaleFactor: 2 })

${bloque}`)
fs.writeFileSync(path.join(tmp, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: '.', timeout: 30_000, retries: 0, workers: 1, use: { browserName: 'chromium' } })
`)

/** Corre el bloque y devuelve cada test con su resultado. */
function correr() {
  const r = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '-c', path.join(tmp, 'playwright.config.ts'), '--reporter=json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64e6 })
  const inicio = r.stdout.indexOf('{')
  if (inicio < 0) throw new Error(`Playwright no devolvió un reporte: ${(r.stderr || r.stdout).slice(0, 400)}`)
  const reporte = JSON.parse(r.stdout.slice(inicio))
  const tests = []
  const recorrer = suite => {
    for (const spec of suite.specs ?? []) tests.push({ titulo: spec.title, ok: spec.ok })
    for (const hija of suite.suites ?? []) recorrer(hija)
  }
  for (const suite of reporte.suites ?? []) recorrer(suite)
  return tests
}

const cambiar = (a, b) => s => { if (!s.includes(a)) throw new Error(`texto ausente: ${a.slice(0, 70)}`); return s.replace(a, () => b) }

/** [nombre, mutación del helper, fragmentos de los tests que TIENEN que ponerse rojos] */
const CONTROLES = [
  ['I1 no se vuelve a medir la caja después de la segunda captura (el instrumento anterior)',
    cambiar("  corrimiento = corrimientoEntre(info.geometria, despues)\n  if (corrimiento) return `se movió entre las dos capturas (${corrimiento})`\n", ''),
    ['página oscura · si se mueve entre las dos capturas', 'página clara · si se mueve entre las dos capturas', 'página oscura · si se mueve en CADA medida', 'página clara · si se mueve en CADA medida']],
  ['I2 la tolerancia de la caja se afloja a 50 px',
    cambiar('const GEOMETRY_TOLERANCE_PX = 0.5', 'const GEOMETRY_TOLERANCE_PX = 50'),
    ['página oscura · si se mueve entre las dos capturas', 'página clara · si se mueve entre las dos capturas', 'página clara · si se mueve en CADA medida']],
  ['I3 no se espera a que el elemento esté quieto antes de medir',
    s => cambiar("    if (!(await quieto())) return null\n    // Al centro y sin animar", '    // Al centro y sin animar')(
      cambiar("    if (!(await quieto())) return null\n    const caja = el.getBoundingClientRect()", '    const caja = el.getBoundingClientRect()')(s)),
    ['con un scroll en curso, espera a que la página se quede quieta']],
  ['I4 una medida descartada no se repite (un solo intento)',
    cambiar('export const MEASURE_ATTEMPTS = 4', 'export const MEASURE_ATTEMPTS = 1'),
    ['página oscura · si se mueve entre las dos capturas, descarta la medida y la repite', 'página clara · si se mueve entre las dos capturas, descarta la medida y la repite']],
]

const lineas = []
const decir = texto => { console.log(texto); lineas.push(texto) }
let fallas = 0
const ruta = path.join(root, HELPER)
const original = fs.readFileSync(ruta, 'utf8')

try {
  const base = correr()
  const rojos = base.filter(t => !t.ok)
  decir(`[instrumento] el bloque del spec real, con el helper tal cual: ${base.length - rojos.length}/${base.length} en verde`)
  for (const t of base) decir(`  ${t.ok ? 'OK   ' : 'FALLA'} ${t.titulo}`)
  if (rojos.length || base.length === 0) fallas += 1

  decir('\n[controles negativos] cada mutación del helper tiene que poner en rojo su test')
  for (const [nombre, mutar, esperados] of CONTROLES) {
    let resultado
    try {
      const mutado = mutar(original)
      if (mutado === original) throw new Error('la mutación no cambió el archivo')
      fs.writeFileSync(ruta, mutado, 'utf8')
      const fallidos = correr().filter(t => !t.ok).map(t => t.titulo)
      const faltan = esperados.filter(e => !fallidos.some(f => f.includes(e)))
      resultado = faltan.length === 0
        ? `  OK    ${nombre} → ${fallidos.length} test(s) en rojo:\n${fallidos.map(f => `          × ${f}`).join('\n')}`
        : `  FALLA ${nombre} → no se puso rojo: ${faltan.join(' | ')}\n          (rojos: ${fallidos.join(' | ') || 'ninguno'})`
      if (faltan.length) fallas += 1
    } catch (e) {
      resultado = `  FALLA ${nombre} → ${e.message}`
      fallas += 1
    } finally {
      fs.writeFileSync(ruta, original, 'utf8')
      if (fs.readFileSync(ruta, 'utf8') !== original) { console.error(`NO SE PUDO RESTAURAR ${HELPER}`); process.exit(3) }
    }
    decir(resultado)
  }
} finally {
  fs.writeFileSync(ruta, original, 'utf8')
  fs.rmSync(tmp, { recursive: true, force: true })
}

decir(`\nhelper restaurado byte a byte: ${fs.readFileSync(ruta, 'utf8') === original ? 'sí' : 'NO'}`)
decir(fallas === 0 ? `INSTRUMENTO: verde con el helper real y ${CONTROLES.length}/${CONTROLES.length} mutaciones detectadas` : `INSTRUMENTO: ${fallas} comprobación(es) en rojo`)
process.exit(fallas === 0 ? 0 : 1)
