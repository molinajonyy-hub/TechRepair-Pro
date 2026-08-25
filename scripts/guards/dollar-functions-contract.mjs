#!/usr/bin/env node
// ============================================================================
// Guard — contrato operativo de las Edge Functions de dolar.
//
//   node scripts/guards/dollar-functions-contract.mjs             (valida el repo)
//   node scripts/guards/dollar-functions-contract.mjs --self-test (valida el guard)
//
// ┌── QUE PROTEGE ──────────────────────────────────────────────────────────┐
// │ `fetch-dollar-rate` e `infodolar-cordoba` sirvieron trafico productivo   │
// │ durante meses SIN fuente en Git. Este lote las versiono recuperando el   │
// │ bundle desplegado. El guard evita que esa recuperacion se degrade:       │
// │                                                                          │
// │  1. FIDELIDAD  — el archivo versionado sigue siendo, byte a byte, el     │
// │     que esta desplegado. Editarlo sin pasar por un lote de deploy deja   │
// │     el repo mintiendo sobre produccion otra vez.                         │
// │  2. SECRETOS   — ninguna de las funciones incorpora una credencial       │
// │     literal. Son publicas (verify_jwt=false): un secreto ahi es fuga.    │
// │  3. verify_jwt — el valor esta declarado explicitamente en config.toml.  │
// │     Sin declaracion, `supabase functions deploy` usa el DEFAULT true y   │
// │     rompe a los consumidores, que llaman sin Authorization.              │
// │  4. SSRF       — el destino upstream es una constante del modulo, nunca  │
// │     sale del request. Con verify_jwt=false el caller es anonimo.         │
// │  5. INVENTARIO — `get-dolar-cordoba` NO tiene consumidores. Contarla     │
// │     como viva llevaria a "mantener" codigo muerto y, peor, a creer que   │
// │     es intercambiable con `infodolar-cordoba` (shapes incompatibles).    │
// └─────────────────────────────────────────────────────────────────────────┘
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

// ─── Huellas del deployment ─────────────────────────────────────────────────
// SHA-256 sobre el contenido NORMALIZADO A LF del source bajado con
// `supabase functions download --use-api` el 2026-08-25 desde el proyecto
// vrdxxmjzxhfgqlnxmbwx. Se normaliza porque el repo no fija eol y un checkout
// en Windows (core.autocrlf=true) entrega CRLF en el working tree.
//
// NO es el `ezbr_sha256` de la plataforma: ese hashea el bundle eszip, que
// incluye metadata del build y no es reproducible localmente. Este hash cubre
// exactamente lo que este repo puede garantizar: el texto fuente.
const FUNCIONES = [
  {
    slug: 'fetch-dollar-rate',
    version: 4,
    verifyJwt: false,
    ezbrSha256: 'f8ba2cfec6907af59fd9a20748c97d1df9aad56c5f4bccbd925cf86e48118c80',
    sourceSha256: '146b697b220b61f286a9d442f3aa7d5d68ac4c6b572f8ca8875b30da24044f15',
    upstreamsPermitidos: ['www.infodolar.com', 'mercados.ambito.com', 'dolarapi.com'],
    consumidoresEsperados: 'al-menos-uno',
  },
  {
    slug: 'infodolar-cordoba',
    version: 3,
    verifyJwt: false,
    ezbrSha256: 'b10cdf7a43684f15a71c5518405b5c4f686527ece31b0c37e922fc99ffa9782e',
    sourceSha256: '2bdd68055e419dfd50628493c3550f02ad968c947c545ce23a3caefddcd1d4ca',
    upstreamsPermitidos: ['www.infodolar.com'],
    consumidoresEsperados: 'al-menos-uno',
  },
  {
    slug: 'get-dolar-cordoba',
    version: 4,
    verifyJwt: false,
    ezbrSha256: 'e6b8abc73be137c0ef39de27bbe46edf029ee903830120bb6d981cebe44fa8c8',
    // Ya estaba versionada y coincide byte a byte con su deployment.
    sourceSha256: '7a89ec81d6d672d1a5a1b16a5d23b8307573c27d9e43ee26d8affbeb0ed843b8',
    upstreamsPermitidos: ['www.infodolar.com'],
    consumidoresEsperados: 'ninguno',
  },
]

/** Patrones de credencial literal. Ninguna de estas funciones usa secretos. */
const PATRONES_SECRETO = [
  { nombre: 'JWT literal (eyJ...)', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { nombre: 'service_role key', re: /service_role/i },
  { nombre: 'Bearer con token literal', re: /Bearer\s+(?!\$\{)[A-Za-z0-9_\-.]{20,}/ },
  { nombre: 'sb_secret / sb_publishable', re: /\bsb_(secret|publishable)_[A-Za-z0-9]/ },
  { nombre: 'clave privada PEM', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { nombre: 'assignacion de apikey literal', re: /apikey['"]?\s*[:=]\s*['"][A-Za-z0-9_\-.]{20,}['"]/i },
]

// ─── Helpers puros (los ejercita el self-test) ──────────────────────────────

/** Hash del texto con EOL normalizado a LF, para ser estable en Windows. */
export function hashNormalizado(texto) {
  return createHash('sha256').update(texto.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

/** Quita comentarios de linea y de bloque, para no marcar prosa como codigo. */
export function sinComentarios(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
}

/** Secretos literales presentes en CODIGO (no en comentarios). */
export function secretosLiterales(src) {
  const codigo = sinComentarios(src)
  return PATRONES_SECRETO.filter(p => p.re.test(codigo)).map(p => p.nombre)
}

/** Hosts alcanzados por un `fetch(...)` con URL literal. */
export function upstreamsLiterales(src) {
  const hosts = new Set()
  for (const m of sinComentarios(src).matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) hosts.add(m[1])
  return [...hosts].sort()
}

/**
 * Marca un `fetch` cuyo destino NO es una constante: si el primer argumento
 * menciona el request, el body o el query, el caller elige el destino.
 */
export function fetchConDestinoDinamico(src) {
  const hallazgos = []
  for (const m of sinComentarios(src).matchAll(/\bfetch\s*\(([\s\S]{0,160}?)[,)]/g)) {
    const arg = m[1]
    if (/\breq\b|\brequest\b|\bbody\b|searchParams|\burl\s*\?\?|\.url\b/i.test(arg)) {
      hallazgos.push(arg.replace(/\s+/g, ' ').trim().slice(0, 80))
    }
  }
  return hallazgos
}

/** Call sites HTTP reales a `/functions/v1/<slug>` dentro de un arbol. */
export function contarConsumidores(slug, archivos) {
  const re = new RegExp(`functions/v1/${slug.replace(/[-]/g, '[-]')}\\b`)
  return archivos.filter(a => re.test(a.contenido)).map(a => a.ruta)
}

/** verify_jwt declarado para un slug en config.toml. `null` si no se declara. */
export function verifyJwtDeclarado(configToml, slug) {
  const re = new RegExp(
    `\\[functions\\.${slug.replace(/[-]/g, '[-]')}\\]([\\s\\S]*?)(?=\\n\\[|$)`,
  )
  const bloque = configToml.match(re)
  if (!bloque) return null
  const v = bloque[1].match(/^\s*verify_jwt\s*=\s*(true|false)\s*$/m)
  return v ? v[1] === 'true' : null
}

// ─── Recorrido del repo ─────────────────────────────────────────────────────

function archivosFuente(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '_archive' || e === 'dist' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) archivosFuente(p, acc)
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e)) {
      acc.push({ ruta: p.slice(RAIZ.length + 1).replace(/\\/g, '/'), contenido: readFileSync(p, 'utf8') })
    }
  }
  return acc
}

function validarRepo() {
  const fallas = []
  const configPath = join(RAIZ, 'supabase', 'config.toml')
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
  const fuentesApp = archivosFuente(join(RAIZ, 'src'))

  for (const fn of FUNCIONES) {
    const rel = `supabase/functions/${fn.slug}/index.ts`
    const abs = join(RAIZ, rel)
    if (!existsSync(abs)) {
      fallas.push(`${fn.slug}: falta ${rel}. Esta desplegada (v${fn.version}) y DEBE estar versionada.`)
      continue
    }
    const src = readFileSync(abs, 'utf8')

    // 1. Fidelidad
    const real = hashNormalizado(src)
    if (real !== fn.sourceSha256) {
      fallas.push(
        `${fn.slug}: el source cambio respecto del deployment v${fn.version}.\n` +
        `      esperado ${fn.sourceSha256}\n      obtuvo   ${real}\n` +
        `      Si el cambio es intencional va en un lote de DEPLOY que redeploya y actualiza este hash.`,
      )
    }

    // 2. Secretos
    for (const s of secretosLiterales(src)) {
      fallas.push(`${fn.slug}: secreto literal en codigo (${s}). Es una funcion PUBLICA.`)
    }

    // 3. verify_jwt declarado y coincidente
    const declarado = verifyJwtDeclarado(config, fn.slug)
    if (declarado === null) {
      fallas.push(
        `${fn.slug}: config.toml no declara [functions.${fn.slug}].verify_jwt. ` +
        `El default de la CLI es TRUE y el deploy rompe a los consumidores anonimos.`,
      )
    } else if (declarado !== fn.verifyJwt) {
      fallas.push(
        `${fn.slug}: verify_jwt declarado ${declarado} pero produccion tiene ${fn.verifyJwt}.`,
      )
    }

    // 4. SSRF
    for (const h of upstreamsLiterales(src)) {
      if (!fn.upstreamsPermitidos.includes(h) && !h.includes('techrepairpro.app')) {
        fallas.push(`${fn.slug}: upstream no declarado en la allowlist: ${h}`)
      }
    }
    for (const f of fetchConDestinoDinamico(src)) {
      fallas.push(`${fn.slug}: SSRF — fetch con destino derivado del request: \`${f}\``)
    }

    // 5. Inventario de consumidores
    const consumidores = contarConsumidores(fn.slug, fuentesApp)
    if (fn.consumidoresEsperados === 'ninguno' && consumidores.length > 0) {
      fallas.push(
        `${fn.slug}: estaba clasificada como SIN consumidores y ahora la llama ` +
        `${consumidores.join(', ')}. Reclasificarla antes de tratarla como viva ` +
        `(su shape {rate,source,timestamp} NO es el de infodolar-cordoba).`,
      )
    }
    if (fn.consumidoresEsperados === 'al-menos-uno' && consumidores.length === 0) {
      fallas.push(
        `${fn.slug}: no quedan consumidores en src/. Si de verdad murio, retirarla ` +
        `en un lote de deploy en vez de dejarla desplegada y publica.`,
      )
    }
  }
  return fallas
}

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  const casos = []
  const chequear = (nombre, real, esperado) => {
    casos.push({ nombre, ok: JSON.stringify(real) === JSON.stringify(esperado), real, esperado })
  }

  // hashNormalizado: estable frente a CRLF (el caso Windows real)
  chequear('CRLF y LF hashean igual',
    hashNormalizado('a\r\nb\r\n') === hashNormalizado('a\nb\n'), true)
  chequear('detecta un cambio real de contenido',
    hashNormalizado('a\n') === hashNormalizado('b\n'), false)

  // GATE D — secretos
  chequear('caza un JWT literal',
    secretosLiterales(`const k = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9'`),
    ['JWT literal (eyJ...)'])
  chequear('caza service_role', secretosLiterales(`const r = 'service_role'`), ['service_role key'])
  chequear('caza una PEM', secretosLiterales(`const p = '-----BEGIN PRIVATE KEY-----'`), ['clave privada PEM'])
  chequear('NO marca un secreto nombrado en un comentario',
    secretosLiterales(`// nunca pongas service_role aca\nconst x = 1`), [])
  chequear('NO marca un Bearer interpolado',
    secretosLiterales('const h = `Bearer ${key}`'), [])
  chequear('el source limpio no dispara nada', secretosLiterales(`const u = 'https://dolarapi.com/v1'`), [])

  // GATE C/SSRF — destino dinamico
  chequear('caza fetch(body.url)', fetchConDestinoDinamico(`await fetch(body.url ?? target, {})`).length > 0, true)
  chequear('caza fetch con searchParams',
    fetchConDestinoDinamico(`await fetch(new URL(req.url).searchParams.get('u'))`).length > 0, true)
  chequear('NO marca fetch a una constante',
    fetchConDestinoDinamico(`await fetch(target, { headers })`), [])
  chequear('NO marca fetch a un literal',
    fetchConDestinoDinamico(`await fetch('https://dolarapi.com/v1/dolares/blue')`), [])

  chequear('extrae hosts upstream',
    upstreamsLiterales(`fetch('https://dolarapi.com/v1'); fetch('https://mercados.ambito.com/x')`),
    ['dolarapi.com', 'mercados.ambito.com'])

  // GATE E — verify_jwt
  const cfgOk = `[functions.fetch-dollar-rate]\nverify_jwt = false\n\n[api]\nport = 1\n`
  chequear('lee verify_jwt=false', verifyJwtDeclarado(cfgOk, 'fetch-dollar-rate'), false)
  chequear('lee verify_jwt=true', verifyJwtDeclarado(`[functions.x]\nverify_jwt = true\n`, 'x'), true)
  chequear('sin bloque devuelve null', verifyJwtDeclarado(`[api]\nport = 1\n`, 'fetch-dollar-rate'), null)
  chequear('bloque sin verify_jwt devuelve null',
    verifyJwtDeclarado(`[functions.y]\nentrypoint = "a"\n`, 'y'), null)
  chequear('no confunde un slug con otro que lo contiene',
    verifyJwtDeclarado(`[functions.get-dolar-cordoba]\nverify_jwt = false\n`, 'dolar-cordoba'), null)

  // GATE F — inventario de consumidores
  const arboles = [
    { ruta: 'src/services/dollarRateService.ts', contenido: `fetch(\`\${u}/functions/v1/infodolar-cordoba\`)` },
    { ruta: 'src/services/otro.ts', contenido: `// nada` },
  ]
  chequear('cuenta el consumidor real de infodolar-cordoba',
    contarConsumidores('infodolar-cordoba', arboles), ['src/services/dollarRateService.ts'])
  chequear('get-dolar-cordoba NO se cuenta por el consumidor de infodolar-cordoba',
    contarConsumidores('get-dolar-cordoba', arboles), [])
  chequear('detecta si get-dolar-cordoba resucita',
    contarConsumidores('get-dolar-cordoba',
      [{ ruta: 'src/x.ts', contenido: `fetch('/functions/v1/get-dolar-cordoba')` }]),
    ['src/x.ts'])

  const fallidos = casos.filter(c => !c.ok)
  for (const c of casos) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.nombre}`)
    if (!c.ok) console.log(`      esperado ${JSON.stringify(c.esperado)}, obtuvo ${JSON.stringify(c.real)}`)
  }
  if (fallidos.length) {
    console.error(`\n✗ Self-test FALLIDO: ${fallidos.length}/${casos.length}.`)
    process.exit(1)
  }
  console.log(`\n✓ Self-test OK: ${casos.length} comprobaciones verificadas en ambos sentidos.`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  console.log('\n─── guard:dollar-functions · self-test ─────────────────────────────')
  selfTest()
} else {
  const fallas = validarRepo()
  if (fallas.length) {
    console.error('\n' + '═'.repeat(74))
    console.error('  GUARD FALLIDO — contrato de las Edge Functions de dolar')
    console.error('═'.repeat(74))
    for (const f of fallas) console.error(`  ✗ ${f}`)
    console.error('═'.repeat(74) + '\n')
    process.exit(1)
  }
  console.log('✓ guard:dollar-functions — fuente fiel, sin secretos, verify_jwt declarado, sin SSRF, inventario estable.')
}
