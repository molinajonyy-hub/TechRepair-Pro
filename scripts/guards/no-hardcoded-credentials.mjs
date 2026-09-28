#!/usr/bin/env node
// ============================================================================
// GUARD — PRE-BETA-2B · sin credenciales hardcodeadas en el bundle
//
// Nació de BLK-1 (PRE-BETA-2A): el login del portal mayorista traía el email
// y la contraseña de una cuenta demo REAL de producción, en un repo PÚBLICO.
// Que el botón sólo se viera con `import.meta.env.DEV` no protegía nada: el
// valor estaba en el código fuente y quedó en la historia de git.
//
// Alcance: `src/**/*.{ts,tsx}`, lo que termina en el bundle del navegador.
// Tests y scripts quedan fuera a propósito: usan contraseñas de usuarios QA
// efímeros del stack LOCAL, que no existen en producción.
//
// Reglas (deterministas, sin heurística de entropía):
//   R1 declaracion-credencial  const/let/var con nombre de credencial
//                              (password, secret, apiKey, accessToken, …)
//                              inicializada con un string literal no vacío.
//   R2 identificador-demo      identificadores tipo DEMO_PASSWORD, demoEmail,
//                              DEFAULT_PASSWORD, testPassword, …
//   R3 literal-en-login        una llamada de auth (signInWithPassword, signUp,
//                              updateUser, loginCustomer, doLogin, signIn,
//                              registerCustomer, resetPasswordForEmail) que
//                              recibe la contraseña o el email como literal.
//   R4 cuenta-demo             un email `demo@…` en cualquier parte de src/.
//
// Por qué NO hay una regla por valor conocido (hash del literal filtrado): el
// SHA-256 de una contraseña corta se revierte con un diccionario, así que
// publicarlo equivale a republicarla. Esa credencial se trata como quemada: la
// contención real es banearla/rotarla en producción, no reconocerla acá.
//
// El guard NUNCA imprime el valor encontrado: sólo archivo, línea, regla e
// identificador.
//
//   node scripts/guards/no-hardcoded-credentials.mjs
//   node scripts/guards/no-hardcoded-credentials.mjs --self-test
//   node scripts/guards/no-hardcoded-credentials.mjs --root <dir>
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Un nombre que dice «esto ES una credencial». */
const NOMBRE_CREDENCIAL = /(pass(word|wd|phrase)?|pwd|secret|api_?key|access_?token|refresh_?token|auth_?token|bearer|private_?key|client_?secret|credential)/i

/** Credenciales cuyo nombre termina en «key»: ésas NO son descriptivas. */
const CLAVE_QUE_ES_CREDENCIAL = /(api_?key|private_?key|secret_?key|access_?key)$/i

/**
 * Nombres que DESCRIBEN una credencial sin contenerla: claves de storage,
 * headers, nombres de campo, rutas, largos, mensajes de UI.
 */
const SUFIJO_DESCRIPTIVO = /(key|name|field|header|param|label|prefix|path|url|route|storage|event|type|mode|length|min|max|bytes|regex|pattern|message|msg|error|copy|text|placeholder|hint|title)$/i

const R1 = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*(['"`])((?:\\.|(?!\2)[^\\\n])+)\2/g

const R2 = /\b((?:demo|default|test|sample|fallback|dummy|fake|hardcoded)_?(?:password|passwd|pass|pwd|email|user(?:name)?|login|credentials?|secret|token))\b/gi

const LLAMADAS_AUTH = ['signInWithPassword', 'signUp', 'updateUser', 'loginCustomer', 'doLogin', 'signIn', 'registerCustomer', 'resetPasswordForEmail']
const R3_LLAMADA = new RegExp(`\\b(${LLAMADAS_AUTH.join('|')})\\s*\\(`, 'g')

const R4 = /\bdemo@[a-z0-9.-]+\.[a-z]{2,}\b/gi

const lineaDe = (src, idx) => src.slice(0, idx).split('\n').length

/** Recorta los argumentos de la llamada balanceando paréntesis (como auth-redirect-canonical). */
function argumentos(src, desdeParen) {
  let prof = 0
  for (let i = desdeParen; i < src.length; i++) {
    const c = src[i]
    if (c === '(') prof++
    else if (c === ')') {
      prof--
      if (prof === 0) return src.slice(desdeParen + 1, i)
    }
  }
  return src.slice(desdeParen + 1)
}

/** Separa argumentos de primer nivel (ignora comas dentro de (), [], {} y strings). */
function argumentosDePrimerNivel(bloque) {
  const out = []
  let prof = 0, actual = '', comilla = null
  for (let i = 0; i < bloque.length; i++) {
    const c = bloque[i]
    if (comilla) {
      actual += c
      if (c === '\\') { actual += bloque[++i] ?? ''; continue }
      if (c === comilla) comilla = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { comilla = c; actual += c; continue }
    if ('([{'.includes(c)) prof++
    if (')]}'.includes(c)) prof--
    if (c === ',' && prof === 0) { out.push(actual.trim()); actual = ''; continue }
    actual += c
  }
  if (actual.trim()) out.push(actual.trim())
  return out
}

const esLiteral = (arg) => /^(['"`])(?:\\.|(?!\1)[^\\])+\1$/s.test(arg) && !arg.includes('${')

/** Devuelve hallazgos SIN el valor: {linea, regla, detalle}. */
export function analizar(src) {
  const out = []

  for (const m of src.matchAll(R1)) {
    const [, nombre, delim, valor] = m
    if (!NOMBRE_CREDENCIAL.test(nombre)) continue
    if (!CLAVE_QUE_ES_CREDENCIAL.test(nombre) && SUFIJO_DESCRIPTIVO.test(nombre)) continue
    if (delim === '`' && valor.includes('${')) continue
    out.push({ linea: lineaDe(src, m.index), regla: 'R1 declaracion-credencial', detalle: `\`${nombre}\` inicializada con un literal` })
  }

  for (const m of src.matchAll(R2)) {
    out.push({ linea: lineaDe(src, m.index), regla: 'R2 identificador-demo', detalle: `identificador \`${m[1]}\`` })
  }

  for (const m of src.matchAll(R3_LLAMADA)) {
    const nombre = m[1]
    const bloque = argumentos(src, m.index + m[0].length - 1)
    const linea = lineaDe(src, m.index)
    if (/\bpassword\s*:\s*(['"`])(?:\\.|(?!\1)[^\\])+\1/.test(bloque)) {
      out.push({ linea, regla: 'R3 literal-en-login', detalle: `\`${nombre}\` recibe \`password\` literal` })
    }
    if (/\bemail\s*:\s*(['"`])[^'"`\n]*@[^'"`\n]*\1/.test(bloque)) {
      out.push({ linea, regla: 'R3 literal-en-login', detalle: `\`${nombre}\` recibe \`email\` literal` })
    }
    const args = argumentosDePrimerNivel(bloque)
    args.forEach((arg, i) => {
      if (!esLiteral(arg)) return
      if (arg.includes('@')) out.push({ linea, regla: 'R3 literal-en-login', detalle: `\`${nombre}\` recibe un email literal (arg ${i + 1})` })
      else if (i === 1 && ['loginCustomer', 'doLogin', 'signIn'].includes(nombre)) {
        out.push({ linea, regla: 'R3 literal-en-login', detalle: `\`${nombre}\` recibe la contraseña literal (arg 2)` })
      }
    })
  }

  for (const m of src.matchAll(R4)) {
    out.push({ linea: lineaDe(src, m.index), regla: 'R4 cuenta-demo', detalle: 'email de cuenta demo en el código' })
  }

  return out
}

function archivos(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...archivos(p))
    else if (/\.(ts|tsx)$/.test(p)) out.push(p)
  }
  return out
}

/** Recorre `<raiz>/src`. Exportada para el control negativo por archivo. */
export function validarArbol(raiz) {
  const src = join(raiz, 'src')
  if (!existsSync(src)) throw new Error(`no existe ${src}`)
  const hallazgos = []
  for (const p of archivos(src)) {
    const rel = relative(raiz, p).replace(/\\/g, '/')
    for (const h of analizar(readFileSync(p, 'utf8'))) hallazgos.push({ archivo: rel, ...h })
  }
  return hallazgos
}

// ── Self-test: cada regla caza su caso y no dispara en los falsos amigos ─────
function selfTest() {
  const V = 'Xx-sintetico-123' // valor SINTÉTICO: nunca una credencial real
  const casos = [
    // Positivos
    ['constante demo con contraseña', `const DEMO_PASSWORD = '${V}'`, ['R1', 'R2']],
    ['email demo en constante', "const demoEmail = 'demo@example.com'", ['R2', 'R4']],
    ['api key tipada', `const apiKey: string = 'sk_${V}'`, ['R1']],
    ['secret key (termina en key pero ES credencial)', `const STRIPE_SECRET_KEY = 'sk_${V}'`, ['R1']],
    ['default password', `let DEFAULT_PASSWORD = "${V}"`, ['R1', 'R2']],
    ['signInWithPassword con literales', `await supabase.auth.signInWithPassword({ email: 'qa@example.com', password: '${V}' })`, ['R3']],
    ['loginCustomer con literales posicionales', `await loginCustomer('qa@example.com', '${V}', business.id)`, ['R3']],
    ['doLogin con identificadores demo', 'await doLogin(DEMO_EMAIL, DEMO_PASSWORD)', ['R2']],
    ['cuenta demo en un comentario', '// entrar con demo@clicmayorista.com para probar', ['R4']],
    ['updateUser con password literal', `await supabase.auth.updateUser({ password: "${V}" })`, ['R3']],
    // Negativos (el código real del repo tiene estas formas)
    ['estado vacío', "const [password, setPassword] = useState('')", []],
    ['mapa de etiquetas', "const LABELS = { pin:'PIN', pattern:'Patrón', password:'Contraseña', none:'Sin bloqueo' }", []],
    ['input de contraseña', '<input type="password" autoComplete="current-password" placeholder="••••••••" />', []],
    ['largo mínimo', 'export const PASSWORD_MIN_LENGTH = 8', []],
    ['clave de storage', "export const RECOVERY_MARKER_KEY = 'techrepair.auth.password-recovery'", []],
    ['clave de storage con token en el nombre', "const AUTH_TOKEN_KEY = 'sb-auth-token'", []],
    ['login con variables', 'await supabase.auth.signInWithPassword({ email, password })', []],
    ['loginCustomer con variables', 'await loginCustomer(email, password, business.id)', []],
    ['definición de la función', 'export async function loginCustomer(email: string, password: string, businessId: string) {}', []],
    ['updateUser con variable', 'await supabase.auth.updateUser({ password })', []],
    ['placeholder de email', '<input type="email" placeholder="tu@email.com" />', []],
    ['template dinámico', 'const accessToken = `${prefix}-${id}`', []],
  ]
  let malos = 0
  for (const [etiqueta, codigo, esperadas] of casos) {
    const reglas = [...new Set(analizar(codigo).map(h => h.regla.split(' ')[0]))].sort()
    const ok = esperadas.length === 0 ? reglas.length === 0 : esperadas.every(r => reglas.includes(r))
    const impreso = analizar(codigo).map(h => `${h.regla} ${h.detalle}`).join(' | ')
    if (impreso.includes(V)) { console.error(`  MAL  ${etiqueta}: la salida del guard filtró el valor`); malos++; continue }
    if (!ok) malos++
    console.log(`  ${ok ? 'OK  ' : 'MAL '} ${etiqueta} (esperado ${esperadas.join('+') || 'nada'}, dio ${reglas.join('+') || 'nada'})`)
  }
  // Control negativo por archivo, con el CLI real: una credencial introducida a
  // propósito en un árbol temporal tiene que hacerlo salir con 1 sin imprimirla,
  // y el mismo árbol limpio tiene que pasar. Es .mjs puro: corre también en el
  // job `quality` de CI, que usa Node 20 y no puede ejecutar tests .ts.
  const raiz = mkdtempSync(join(tmpdir(), 'no-cred-selftest-'))
  try {
    const archivo = join(raiz, 'src', 'portal', 'Login.tsx')
    mkdirSync(join(raiz, 'src', 'portal'), { recursive: true })
    const correr = () => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--root', raiz], { encoding: 'utf8' })

    writeFileSync(archivo, `const DEMO_PASSWORD = '${V}'\nexport const f = () => doLogin('qa@example.com', DEMO_PASSWORD)\n`)
    const sucio = correr()
    const okSucio = sucio.status === 1 && !`${sucio.stdout}${sucio.stderr}`.includes(V)
    if (!okSucio) malos++
    console.log(`  ${okSucio ? 'OK  ' : 'MAL '} CLI real con credencial introducida (esperado exit 1 sin filtrar el valor, dio exit ${sucio.status})`)

    writeFileSync(archivo, "const [password, setPassword] = useState('')\n")
    const limpio = correr()
    const okLimpio = limpio.status === 0
    if (!okLimpio) malos++
    console.log(`  ${okLimpio ? 'OK  ' : 'MAL '} CLI real con el árbol limpio (esperado exit 0, dio exit ${limpio.status})`)
  } finally {
    rmSync(raiz, { recursive: true, force: true })
  }

  if (malos) {
    console.error(`\nSELF-TEST FALLIDO: ${malos} caso(s).`)
    process.exit(1)
  }
  console.log(`\nself-test OK: ${casos.length} casos + control negativo por CLI; el guard caza credenciales y no filtra el valor encontrado.`)
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const esCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (esCli) {
  if (process.argv.includes('--self-test')) {
    selfTest()
    process.exit(0)
  }
  const iRoot = process.argv.indexOf('--root')
  const raiz = iRoot > -1 ? resolve(process.argv[iRoot + 1]) : process.cwd()
  const hallazgos = validarArbol(raiz)
  if (hallazgos.length) {
    for (const h of hallazgos) console.error(`  ${h.archivo}:${h.linea}  ${h.regla} — ${h.detalle}`)
    console.error(
      `\nGUARD no-hardcoded-credentials: ${hallazgos.length} hallazgo(s). El valor NO se imprime.\n` +
      'El bundle del navegador y este repo son PÚBLICOS: cualquier email o contraseña en src/\n' +
      'es una credencial expuesta. Una cuenta de demo se pide por un canal privado, nunca se\n' +
      'hardcodea (ni detrás de `import.meta.env.DEV`). Ver docs/pre-beta-2/pre-beta-2b-auth-production-inventory.md.',
    )
    process.exit(1)
  }
  console.log('GUARD no-hardcoded-credentials: OK — sin credenciales ni cuentas demo en src/.')
}
