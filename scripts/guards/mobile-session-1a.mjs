#!/usr/bin/env node
// ============================================================================
// MOBILE-SESSION-1A - guard de CI: una falla de red no vence una sesion valida.
//
// Falla (exit 1) si alguien reintroduce alguno de los defectos que este lote
// cierra:
//
//   1. `session_expired` inferido de un error (red/timeout/DNS) en vez de la
//      ausencia CONFIRMADA de sesion.
//   2. El clasificador dejando de mapear "hay error" -> unreachable.
//   3. Un segundo bucle de renovacion (`refreshSession()`) en el camino de
//      wake-up: getSession() ya renueva por dentro.
//   4. Una segunda autoridad de auth: navegacion o signOut desde el hook de
//      wake-up o desde el provider de estado del sistema.
//   5. La copia "Tu sesion vencio" volviendo a un camino de conectividad.
//   6. `onSessionExpired`, el callback cuyo unico consumidor era el redirect
//      especulativo.
//   7. Degradacion de la config de persistencia del cliente Supabase.
//   8. ProtectedRoute dejando de ser el que navega al login.
//
//   node scripts/guards/mobile-session-1a.mjs [--self-test]
// ============================================================================
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// El flag NO es una ruta: sin este filtro, RAIZ apunta a "./--self-test", el
// arbol queda vacio y TODAS las mutaciones "se detectan" por archivo faltante.
// Es un falso verde, no un guard.
const RAIZ = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.')

const SIGNAL   = 'src/lib/sessionSignal.ts'
const HOOK     = 'src/hooks/useAppWakeUp.ts'
const PROVIDER = 'src/contexts/SystemStatusContext.tsx'
const CLIENTE  = 'src/lib/supabase.ts'
const GUARDIA  = 'src/components/auth/ProtectedRoute.tsx'

const ARCHIVOS = [SIGNAL, HOOK, PROVIDER, CLIENTE, GUARDIA]

const leer = (raiz, rel) => {
  const p = join(raiz, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

/** Quita comentarios de linea y de bloque para no analizar prosa. */
function sinComentarios(txt) {
  return txt
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
}

/**
 * Toda emision de `session_expired` tiene que estar dentro de la rama que
 * comprueba `absent`. Es la diferencia exacta entre "auth-js confirmo que no
 * hay sesion" y "no pude averiguarlo".
 */
function emisionesJustificadas(codigo, rel, hallazgos) {
  const lineas = codigo.split('\n')
  let vistas = 0

  lineas.forEach((linea, i) => {
    if (!/setStatus\(\s*'session_expired'\s*\)/.test(linea)) return
    vistas++
    const desde = Math.max(0, i - 12)
    const contexto = lineas.slice(desde, i).join('\n')
    if (!/'absent'/.test(contexto)) {
      hallazgos.push(
        `${rel}:${i + 1}: session_expired se emite sin comprobar 'absent' en las 12 lineas previas: ` +
        'seria una inferencia de conectividad, que es justo el defecto de este lote',
      )
    }
  })

  if (vistas === 0) {
    hallazgos.push(
      `${rel}: no quedo ninguna emision de session_expired; el estado terminal debe seguir existiendo`,
    )
  }
}

export function revisar(raiz) {
  const h = []

  const signal   = leer(raiz, SIGNAL)
  const hook     = leer(raiz, HOOK)
  const provider = leer(raiz, PROVIDER)
  const cliente  = leer(raiz, CLIENTE)
  const guardia  = leer(raiz, GUARDIA)

  // -- 0. Presencia --------------------------------------------------------
  if (!signal)   h.push(`falta el clasificador ${SIGNAL}`)
  if (!hook)     h.push(`falta el hook ${HOOK}`)
  if (!provider) h.push(`falta el provider ${PROVIDER}`)
  if (!cliente)  h.push(`falta el cliente ${CLIENTE}`)
  if (!guardia)  h.push(`falta el guard central ${GUARDIA}`)

  // -- 2. El clasificador mapea "hay error" -> unreachable -----------------
  if (signal) {
    const s = sinComentarios(signal)

    if (!/error\s*\)\s*\{[\s\S]{0,120}?kind:\s*'unreachable'/.test(s)) {
      h.push(
        `${SIGNAL}: no mapea un error de getSession() a 'unreachable'; sin esa rama, ` +
        'un corte de red vuelve a leerse como perdida de sesion',
      )
    }
    if (!/kind:\s*'absent'/.test(s)) {
      h.push(`${SIGNAL}: perdio el caso terminal 'absent'`)
    }
    // Clasificador PURO: si sale a buscar la sesion o toca storage, deja de ser
    // testeable sin red y puede empezar a decidir cosas que no le tocan.
    for (const prohibido of ['signOut(', 'refreshSession(', 'localStorage', 'navigate(']) {
      if (s.includes(prohibido)) {
        h.push(`${SIGNAL}: usa ${prohibido} - debe ser un clasificador puro`)
      }
    }
  }

  // -- 1/3/4/6. El hook de wake-up no es autoridad de auth -----------------
  if (hook) {
    const s = sinComentarios(hook)

    emisionesJustificadas(s, HOOK, h)

    if (/refreshSession\s*\(/.test(s)) {
      h.push(
        `${HOOK}: volvio el segundo bucle de renovacion (refreshSession); getSession() ya ` +
        'renueva por dentro y su fallo era la fuente del falso vencimiento',
      )
    }
    if (/useNavigate|navigate\s*\(/.test(s)) {
      h.push(`${HOOK}: navega. La navegacion por perdida de sesion es de ProtectedRoute`)
    }
    if (/react-router/.test(s)) {
      h.push(`${HOOK}: importa react-router; es un monitor de conectividad, no de routing`)
    }
    if (/signOut\s*\(/.test(s)) {
      h.push(`${HOOK}: cierra sesion. Solo auth-js puede hacerlo`)
    }
    if (/onSessionExpired/.test(s)) {
      h.push(`${HOOK}: volvio onSessionExpired, cuyo unico consumidor era el redirect especulativo`)
    }
  }

  // -- 4/5. El provider informa conectividad, no autenticacion -------------
  if (provider) {
    const s = sinComentarios(provider)

    if (/useNavigate/.test(s)) {
      h.push(`${PROVIDER}: volvio useNavigate; este provider no debe redirigir`)
    }
    if (/navigate\s*\(\s*['"]\/login/.test(s)) {
      h.push(`${PROVIDER}: redirige a /login, compitiendo con ProtectedRoute`)
    }
    if (/refreshSession\s*\(/.test(s)) {
      h.push(`${PROVIDER}: volvio el refresh manual de rescate en la reconexion`)
    }
    // Se busca en el CODIGO, no en los comentarios: un mensaje al usuario vive
    // siempre en una llamada, y el comentario que documenta por que se retiro
    // esta copia tiene que poder nombrarla.
    if (/sesi[oó]n\s+venci[oó]/i.test(s)) {
      h.push(`${PROVIDER}: la copia "Tu sesion vencio" no puede volver a un camino de conectividad`)
    }
  }

  // -- 7. Config de persistencia intacta -----------------------------------
  if (cliente) {
    const s = sinComentarios(cliente)
    for (const [clave, re] of [
      ['persistSession',     /persistSession:\s*true/],
      ['autoRefreshToken',   /autoRefreshToken:\s*true/],
      ['detectSessionInUrl', /detectSessionInUrl:\s*true/],
    ]) {
      if (!re.test(s)) h.push(`${CLIENTE}: ${clave} dejo de ser true`)
    }
    if (/storageKey/.test(s)) h.push(`${CLIENTE}: aparecio un storageKey propio`)
    if (/\bstorage:/.test(s)) h.push(`${CLIENTE}: aparecio un storage de auth propio`)
  }

  // -- 8. ProtectedRoute sigue siendo el que navega ------------------------
  if (guardia) {
    const s = sinComentarios(guardia)
    if (!/authState/.test(s)) {
      h.push(`${GUARDIA}: dejo de decidir por authState`)
    }
    if (!/Navigate\s+to="\/login"/.test(s)) {
      h.push(`${GUARDIA}: dejo de ser el que navega al login`)
    }
  }

  return h
}

// ---------------------------------------------------------------------------
// Self-test: cada mutacion reintroduce UN defecto y tiene que ser detectada.
// ---------------------------------------------------------------------------
function selfTest() {
  const base = RAIZ

  const casos = [
    ['session_expired inferido de un error de red', HOOK,
      t => t.replace("if (probe.kind === 'absent') {", "if (probe.kind === 'unreachable') {")],
    ['vuelve el segundo bucle de renovacion', HOOK,
      t => t.replace('const probe = await probeSession(', 'await supabase.auth.refreshSession()\n    const probe = await probeSession(')],
    ['el hook navega al login', HOOK,
      t => t.replace("setStatus('offline')", "setStatus('offline'); navigate('/login')")],
    ['el hook cierra sesion', HOOK,
      t => t.replace("setStatus('offline')", "setStatus('offline'); supabase.auth.signOut()")],
    ['vuelve onSessionExpired', HOOK,
      t => t.replace('onWakeUp?: () => void', 'onWakeUp?: () => void\n  onSessionExpired?: () => void')],
    ['el provider redirige a /login', PROVIDER,
      t => t.replace("setStatus('reconnecting')", "setStatus('reconnecting'); navigate('/login')")],
    ['vuelve la copia "Tu sesion vencio"', PROVIDER,
      t => t.replace("addToast('Reconectando sistema", "addToast('Tu sesion vencio. Redirigiendo al login")],
    ['el clasificador deja de mapear error -> unreachable', SIGNAL,
      t => t.replace(/if \(result\?\.error\) \{[\s\S]*?\}\n/, '')],
    ['persistSession deja de ser true', CLIENTE,
      t => t.replace('persistSession: true', 'persistSession: false')],
    ['aparece un storageKey propio', CLIENTE,
      t => t.replace('persistSession: true', "storageKey: 'propio',\n    persistSession: true")],
    ['ProtectedRoute deja de navegar al login', GUARDIA,
      t => t.replace('Navigate to="/login"', 'Navigate to="/inicio"')],
  ]

  let fallas = 0
  const limpio = revisar(base)
  if (limpio.length) {
    console.error('self-test: el arbol REAL ya tiene hallazgos:', limpio)
    fallas++
  }

  for (const [nombre, rel, mutar] of casos) {
    const dir = mkdtempSync(join(tmpdir(), 'ms1a-guard-'))
    try {
      for (const f of ARCHIVOS) {
        const src = join(base, f)
        if (!existsSync(src)) continue
        const dst = join(dir, f)
        mkdirSync(join(dst, '..'), { recursive: true })
        writeFileSync(dst, readFileSync(src, 'utf8'))
      }
      const objetivo = join(dir, rel)
      const antes = readFileSync(objetivo, 'utf8')
      const despues = mutar(antes)
      if (antes === despues) {
        console.error(`self-test FALLA: la mutacion "${nombre}" no cambio ${rel}`)
        fallas++
        continue
      }
      writeFileSync(objetivo, despues)

      if (revisar(dir).length === 0) {
        console.error(`self-test FALLA: "${nombre}" no fue detectado`)
        fallas++
      } else {
        console.log(`  ok  detecta: ${nombre}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  if (fallas) { console.error(`\nself-test: ${fallas} caso(s) fallaron`); process.exit(1) }
  console.log('Guard MOBILE-SESSION-1A self-test OK')
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const hallazgos = revisar(RAIZ)
  if (hallazgos.length) {
    console.error('Guard MOBILE-SESSION-1A: hallazgos\n')
    for (const x of hallazgos) console.error('  - ' + x)
    process.exit(1)
  }
  console.log('Guard MOBILE-SESSION-1A OK: la conectividad no vence sesiones; auth sigue teniendo un solo dueno.')
}
