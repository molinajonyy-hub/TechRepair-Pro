#!/usr/bin/env node
// ============================================================================
// MOBILE-PWA-0 — guard de CI de la identidad de instalación.
//
// Falla (exit 1) si vuelve el bug de producción que este lote cierra: instalar
// techrepairpro.app desde el iPhone creaba un ícono de **Mi Guita** que
// arrancaba en `/personal`, porque el manifest primario y los metadatos Apple
// de `index.html` declaraban la identidad de Mi Guita.
//
// Chequea, sobre los archivos ESTÁTICOS que sirve el sitio:
//
//   1. manifest: name / short_name = "TechRepair Pro".
//   2. manifest: start_url y scope = "/".
//   3. manifest: ningún campo nombra a Mi Guita ni apunta a /personal.
//   4. manifest: los íconos son PNG, existen en disco y no son los de Mi Guita.
//   5. index.html: apple-mobile-web-app-title = "TechRepair Pro".
//   6. index.html: apple-touch-icon es PNG (Safari no soporta SVG acá), existe
//      y no es de Mi Guita.
//   7. index.html: no queda NINGUNA declaración PWA de Mi Guita.
//   8. index.html: se preservan viewport-fit=cover y la capacidad standalone.
//   9. routing: "/" sigue montando el Dashboard y `/personal` sigue existiendo.
//
//   node scripts/guards/pwa-install-identity.mjs [--self-test]
//
// El `--self-test` REINTRODUCE cada defecto sobre una copia y verifica que el
// guard lo caza. Un gate que nunca se probó fallando no prueba nada.
// ============================================================================
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const RAIZ = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.')

const MANIFEST = 'public/manifest.json'
const SHELL    = 'index.html'
const APP      = 'src/App.tsx'

const IDENTIDAD = 'TechRepair Pro'
/** Cualquier grafía de la marca de finanzas personales. */
const MI_GUITA = /mi\s*-?\s*guita|miguita/i

const leer = (raiz, rel) => {
  const p = join(raiz, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

/** Quita comentarios HTML: son prosa y pueden nombrar a Mi Guita legítimamente. */
const sinComentariosHtml = (txt) => txt.replace(/<!--[\s\S]*?-->/g, ' ')

/** Firma PNG. Devuelve false para SVG, JPEG o un archivo ausente. */
function esPng(raiz, rel) {
  const p = join(raiz, rel)
  if (!existsSync(p)) return false
  const buf = readFileSync(p)
  return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
}

export function revisar(raiz) {
  const h = []
  const manifestRaw = leer(raiz, MANIFEST)
  const shell = leer(raiz, SHELL)
  const app = leer(raiz, APP)

  // ── 0. Presencia ──────────────────────────────────────────────────────────
  if (!manifestRaw) h.push(`falta ${MANIFEST}`)
  if (!shell) h.push(`falta ${SHELL}`)
  if (!app) h.push(`falta ${APP}`)

  // ── manifest ──────────────────────────────────────────────────────────────
  if (manifestRaw) {
    let m = null
    try {
      m = JSON.parse(manifestRaw)
    } catch (e) {
      h.push(`${MANIFEST} no es JSON válido: ${e.message}`)
    }

    if (MI_GUITA.test(manifestRaw)) {
      h.push('el manifest PRIMARIO nombra a Mi Guita: instalar el sitio debe instalar TechRepair Pro')
    }

    if (m) {
      // 1. Identidad
      if (m.name !== IDENTIDAD) h.push(`manifest.name es ${JSON.stringify(m.name)}, se espera "${IDENTIDAD}"`)
      if (m.short_name !== IDENTIDAD) h.push(`manifest.short_name es ${JSON.stringify(m.short_name)}, se espera "${IDENTIDAD}"`)

      // 2. Destino de arranque
      if (m.start_url !== '/') h.push(`manifest.start_url es ${JSON.stringify(m.start_url)}, se espera "/"`)
      if (m.scope !== '/') h.push(`manifest.scope es ${JSON.stringify(m.scope)}, se espera "/"`)
      if (m.display !== 'standalone') h.push(`manifest.display es ${JSON.stringify(m.display)}, se espera "standalone"`)
      if (m.lang !== 'es-AR') h.push(`manifest.lang es ${JSON.stringify(m.lang)}, se espera "es-AR"`)

      // 3. Nada apunta al módulo personal
      for (const a of m.shortcuts ?? []) {
        if (String(a.url ?? '').startsWith('/personal')) {
          h.push(`atajo del manifest primario hacia el módulo personal: ${a.url}`)
        }
      }

      // 4. Íconos
      const iconos = m.icons ?? []
      if (iconos.length < 2) h.push('el manifest debe declarar al menos los íconos 192 y 512')
      let maskable = 0
      for (const i of iconos) {
        const src = String(i.src ?? '')
        if (MI_GUITA.test(src)) h.push(`ícono de Mi Guita en el manifest primario: ${src}`)
        // iOS no instala de forma confiable desde SVG: el manifest debe ser raster.
        if (i.type !== 'image/png') h.push(`el ícono ${src} debería declararse image/png (es ${JSON.stringify(i.type)})`)
        if (!esPng(raiz, join('public', src))) h.push(`el ícono ${src} no existe en disco o no es un PNG`)
        if (String(i.purpose ?? '').split(/\s+/).includes('maskable')) maskable++
      }
      if (maskable < 1) h.push('falta un ícono purpose="maskable" para Android')
    }
  }

  // ── index.html ────────────────────────────────────────────────────────────
  if (shell) {
    const head = sinComentariosHtml(shell.slice(shell.indexOf('<head>'), shell.indexOf('</head>')))

    // 5. Etiqueta de la pantalla de inicio
    const titulo = head.match(/<meta\s+name="apple-mobile-web-app-title"\s+content="([^"]*)"/)
    if (!titulo) h.push('falta el meta apple-mobile-web-app-title')
    else if (titulo[1] !== IDENTIDAD) {
      h.push(`apple-mobile-web-app-title es ${JSON.stringify(titulo[1])}, se espera "${IDENTIDAD}"`)
    }

    // 6. apple-touch-icon
    const touch = [...head.matchAll(/<link\s+rel="apple-touch-icon"[^>]*href="([^"]+)"/g)].map(x => x[1])
    if (touch.length === 0) h.push('falta el <link rel="apple-touch-icon">')
    for (const href of touch) {
      if (MI_GUITA.test(href)) h.push(`apple-touch-icon de Mi Guita: ${href}`)
      if (!/\.png$/.test(href)) h.push(`el apple-touch-icon debe ser PNG (Safari no soporta SVG): ${href}`)
      if (!esPng(raiz, join('public', href))) h.push(`el apple-touch-icon no existe en disco o no es PNG: ${href}`)
    }

    // 7. Ninguna declaración PWA de Mi Guita
    const decl = /rel="manifest"|apple-touch-icon|apple-mobile-web-app|mobile-web-app-capable|name="theme-color"/
    const lineas = head.split('\n').filter(l => decl.test(l))
    if (lineas.length === 0) h.push('el shell perdió su bloque de declaraciones PWA')
    for (const l of lineas) {
      if (MI_GUITA.test(l)) h.push(`declaración PWA de Mi Guita en index.html: ${l.trim()}`)
    }

    // 8. Comportamiento iOS que NO se puede perder
    if (!/viewport-fit=cover/.test(head)) h.push('index.html perdió viewport-fit=cover (safe-area de iOS)')
    if (!/<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"/.test(head)) {
      h.push('index.html perdió apple-mobile-web-app-capable')
    }
    if (!/<link\s+rel="manifest"\s+href="\/manifest\.json"/.test(head)) {
      h.push('index.html no enlaza el manifest primario /manifest.json')
    }
  }

  // ── 9. Routing ────────────────────────────────────────────────────────────
  if (app) {
    if (!/<Route\s+path="\/"\s+element=\{<Dashboard\s*\/>\}\s*\/>/.test(app)) {
      h.push('"/" dejó de montar el Dashboard: start_url "/" apunta a la nada')
    }
    if (!/path="\/personal"/.test(app)) {
      h.push('desapareció la ruta /personal: Mi Guita sigue siendo un módulo vigente')
    }
  }

  return h
}

// ── Self-test ────────────────────────────────────────────────────────────────

function copiaDeTrabajo() {
  const dir = mkdtempSync(join(tmpdir(), 'pwa-guard-'))
  for (const rel of [MANIFEST, SHELL, APP]) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    cpSync(join(RAIZ, rel), join(dir, rel))
  }
  cpSync(join(RAIZ, 'public/icons'), join(dir, 'public/icons'), { recursive: true })
  return dir
}

function selfTest() {
  const fallas = []
  const chequear = (nombre, ok, detalle = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${nombre}${ok ? '' : ` — ${detalle}`}`)
    if (!ok) fallas.push(nombre)
  }

  // El árbol real debe pasar.
  chequear('el repo actual pasa el guard', revisar(RAIZ).length === 0, revisar(RAIZ).join(' | '))

  const casos = [
    ['caza el name de Mi Guita', d => {
      const m = JSON.parse(readFileSync(join(d, MANIFEST), 'utf8'))
      m.name = 'Mi Guita — Finanzas Personales'
      m.short_name = 'Mi Guita'
      writeFileSync(join(d, MANIFEST), JSON.stringify(m, null, 2))
    }],
    ['caza start_url = /personal', d => {
      const m = JSON.parse(readFileSync(join(d, MANIFEST), 'utf8'))
      m.start_url = '/personal'
      writeFileSync(join(d, MANIFEST), JSON.stringify(m, null, 2))
    }],
    ['caza los íconos miguita en el manifest', d => {
      const m = JSON.parse(readFileSync(join(d, MANIFEST), 'utf8'))
      m.icons = [
        { src: '/icons/miguita-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
        { src: '/icons/miguita-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
      ]
      writeFileSync(join(d, MANIFEST), JSON.stringify(m, null, 2))
    }],
    ['caza un atajo hacia /personal', d => {
      const m = JSON.parse(readFileSync(join(d, MANIFEST), 'utf8'))
      m.shortcuts = [{ name: 'Gasto rápido', url: '/personal?quickExpense=1' }]
      writeFileSync(join(d, MANIFEST), JSON.stringify(m, null, 2))
    }],
    ['caza un ícono declarado que no existe', d => {
      const m = JSON.parse(readFileSync(join(d, MANIFEST), 'utf8'))
      m.icons.push({ src: '/icons/fantasma-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' })
      writeFileSync(join(d, MANIFEST), JSON.stringify(m, null, 2))
    }],
    ['caza apple-mobile-web-app-title = Mi Guita', d => {
      const s = readFileSync(join(d, SHELL), 'utf8')
        .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*"/, '$1Mi Guita"')
      writeFileSync(join(d, SHELL), s)
    }],
    ['caza el apple-touch-icon SVG de Mi Guita', d => {
      const s = readFileSync(join(d, SHELL), 'utf8')
        .replace(/<link rel="apple-touch-icon"[^>]*>/, '<link rel="apple-touch-icon" sizes="512x512" href="/icons/miguita-512.svg" />')
      writeFileSync(join(d, SHELL), s)
    }],
    ['caza la pérdida de viewport-fit=cover', d => {
      const s = readFileSync(join(d, SHELL), 'utf8').replace(/, viewport-fit=cover/, '')
      writeFileSync(join(d, SHELL), s)
    }],
    ['caza que "/" deje de montar el Dashboard', d => {
      const s = readFileSync(join(d, APP), 'utf8')
        .replace('<Route path="/" element={<Dashboard />} />', '<Route path="/" element={<Navigate to="/personal" replace />} />')
      writeFileSync(join(d, APP), s)
    }],
    ['caza la desaparición de /personal', d => {
      const s = readFileSync(join(d, APP), 'utf8').replace(/path="\/personal"/g, 'path="/finanzas-personales"')
      writeFileSync(join(d, APP), s)
    }],
    ['caza un manifest roto', d => {
      writeFileSync(join(d, MANIFEST), '{ "name": "TechRepair Pro", ')
    }],
  ]

  for (const [nombre, romper] of casos) {
    const dir = copiaDeTrabajo()
    try {
      romper(dir)
      const hallazgos = revisar(dir)
      chequear(nombre, hallazgos.length > 0, 'el guard NO lo detectó')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  if (fallas.length) {
    console.error(`\n✗ self-test: ${fallas.length} caso(s) sin cubrir\n`)
    process.exit(1)
  }
  console.log('\n✓ self-test OK\n')
}

if (process.argv.includes('--self-test')) {
  console.log('\nMOBILE-PWA-0 · self-test del guard de identidad de instalación\n')
  selfTest()
} else {
  const hallazgos = revisar(RAIZ)
  if (hallazgos.length) {
    console.error('\n✗ MOBILE-PWA-0 — la identidad de instalación se rompió:\n')
    for (const x of hallazgos) console.error(`  - ${x}`)
    console.error('')
    process.exit(1)
  }
  console.log('✓ MOBILE-PWA-0 — el sitio primario instala TechRepair Pro.')
}
