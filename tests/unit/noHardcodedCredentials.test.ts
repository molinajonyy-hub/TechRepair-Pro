/**
 * PRE-BETA-2B · BLK-1 — guard `no-hardcoded-credentials`.
 *
 * Runner: node:test nativo. Ejecutar: npm run test:unit
 *
 * El login del portal traía email y contraseña de una cuenta demo real de
 * producción en un repo público. Estos tests prueban que el guard que evita la
 * regresión DETECTA una credencial introducida a propósito (control negativo
 * por archivo, con el CLI real), que nunca imprime el valor encontrado, y que
 * el árbol actual está limpio.
 *
 * Los valores de acá son SINTÉTICOS: ninguno es una credencial real.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analizar, validarArbol } from '../../scripts/guards/no-hardcoded-credentials.mjs'

const RAIZ = fileURLToPath(new URL('../../', import.meta.url))
const GUARD = join(RAIZ, 'scripts', 'guards', 'no-hardcoded-credentials.mjs')
const SINTETICO = 'Zz-no-real-9876'

function arbolCon(archivo: string, contenido: string): string {
  const raiz = mkdtempSync(join(tmpdir(), 'no-cred-'))
  const destino = join(raiz, 'src', archivo)
  mkdirSync(join(destino, '..'), { recursive: true })
  writeFileSync(destino, contenido)
  return raiz
}

test('C1. control negativo: una credencial introducida a propósito hace fallar el CLI', () => {
  const raiz = arbolCon('portal/pages/PortalLogin.tsx', [
    "const DEMO_EMAIL    = 'demo@example.com'",
    `const DEMO_PASSWORD = '${SINTETICO}'`,
    'export const probar = () => doLogin(DEMO_EMAIL, DEMO_PASSWORD)',
  ].join('\n'))
  try {
    const r = spawnSync(process.execPath, [GUARD, '--root', raiz], { encoding: 'utf8' })
    assert.equal(r.status, 1, 'el guard tiene que salir con 1')
    assert.match(r.stderr, /R1 declaracion-credencial/)
    assert.match(r.stderr, /R2 identificador-demo/)
    assert.match(r.stderr, /R4 cuenta-demo/)
    assert.ok(!`${r.stdout}${r.stderr}`.includes(SINTETICO), 'la salida NO puede contener el valor encontrado')
  } finally {
    rmSync(raiz, { recursive: true, force: true })
  }
})

test('C2. control negativo: literales en una llamada de login', () => {
  const raiz = arbolCon('lib/x.ts', `await loginCustomer('qa@example.com', '${SINTETICO}', id)`)
  try {
    const r = spawnSync(process.execPath, [GUARD, '--root', raiz], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /R3 literal-en-login/)
    assert.ok(!r.stderr.includes(SINTETICO))
  } finally {
    rmSync(raiz, { recursive: true, force: true })
  }
})

test('C3. un árbol sin credenciales pasa', () => {
  const raiz = arbolCon('lib/ok.ts', [
    "const [password, setPassword] = useState('')",
    "export const RECOVERY_MARKER_KEY = 'techrepair.auth.password-recovery'",
    'await supabase.auth.signInWithPassword({ email, password })',
  ].join('\n'))
  try {
    const r = spawnSync(process.execPath, [GUARD, '--root', raiz], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  } finally {
    rmSync(raiz, { recursive: true, force: true })
  }
})

test('C4. el src/ real no tiene hallazgos', () => {
  assert.deepEqual(validarArbol(RAIZ), [])
})

test('C5. PortalLogin es un login normal: sin cuenta demo, sin atajo de desarrollo', () => {
  const fuente = readFileSync(join(RAIZ, 'src', 'portal', 'pages', 'PortalLogin.tsx'), 'utf8')
  assert.deepEqual(analizar(fuente), [])
  assert.ok(!/import\.meta\.env\.DEV/.test(fuente), 'el login no tiene rama de desarrollo')
  assert.ok(!/Ingresar como demo/i.test(fuente))
  // El único camino de login sigue siendo el formulario con lo que tipea el usuario.
  assert.match(fuente, /doLogin\(email, password\)/)
})
