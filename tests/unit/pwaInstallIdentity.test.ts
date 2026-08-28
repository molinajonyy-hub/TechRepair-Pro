/**
 * MOBILE-PWA-0 — identidad de instalación del sitio primario.
 *
 * Bug de producción cerrado por este lote: instalar techrepairpro.app desde
 * iPhone ("Agregar a pantalla de inicio") creaba un ícono de **Mi Guita** que
 * arrancaba en `/personal`, porque el manifest primario y los metadatos Apple
 * de `index.html` declaraban la identidad de Mi Guita.
 *
 * Estos tests son la barrera para que no vuelva. Leen los archivos ESTÁTICOS
 * que sirve el sitio (no un mock): `public/manifest.json`, `index.html` y los
 * PNG de `public/icons/`.
 *
 * Mi Guita NO se elimina: sigue siendo un módulo interno con sus rutas y su
 * identidad verde. Lo que cambia es a quién representa la INSTALACIÓN del
 * sitio primario.
 *
 * Runner: node:test nativo (igual que landing-structured-data.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const raiz = (rel: string) => new URL(`../../${rel}`, import.meta.url)

const manifestRaw = readFileSync(raiz('public/manifest.json'), 'utf-8')
const html = readFileSync(raiz('index.html'), 'utf-8')
const appTsx = readFileSync(raiz('src/App.tsx'), 'utf-8')

const IDENTIDAD = 'TechRepair Pro'
/** Cualquier grafía de la marca de finanzas personales. */
const MI_GUITA = /mi\s*-?\s*guita|miguita/i

/**
 * El bloque <head> SIN comentarios: lo único que define la identidad de
 * instalación son las declaraciones. Los comentarios son prosa y pueden
 * nombrar a Mi Guita legítimamente (para explicar por qué ya no está).
 */
const head = html
  .slice(html.indexOf('<head>'), html.indexOf('</head>'))
  .replace(/<!--[\s\S]*?-->/g, ' ')

// ── manifest: JSON válido ────────────────────────────────────────────────────

test('manifest: el JSON parsea', () => {
  assert.doesNotThrow(() => JSON.parse(manifestRaw), 'public/manifest.json no es JSON válido')
})

const manifest = JSON.parse(manifestRaw)

// ── 1/2/3 — nombre, nombre corto y destino de arranque ───────────────────────

test('manifest: name es TechRepair Pro', () => {
  assert.equal(manifest.name, IDENTIDAD)
})

test('manifest: short_name es TechRepair Pro', () => {
  assert.equal(manifest.short_name, IDENTIDAD)
})

test('manifest: start_url es "/" (no /personal)', () => {
  assert.equal(manifest.start_url, '/', 'la app instalada debe arrancar en el dashboard de TechRepair Pro')
  assert.equal(manifest.scope, '/')
})

// ── 4 — el manifest no identifica a Mi Guita ─────────────────────────────────

test('manifest: ningún campo identifica a Mi Guita', () => {
  assert.doesNotMatch(
    manifestRaw,
    MI_GUITA,
    'el manifest PRIMARIO no puede nombrar a Mi Guita: instalar el sitio instala TechRepair Pro',
  )
})

test('manifest: no arranca ni tiene atajos hacia /personal', () => {
  assert.ok(!String(manifest.start_url).startsWith('/personal'))
  for (const atajo of manifest.shortcuts ?? []) {
    assert.ok(
      !String(atajo.url).startsWith('/personal'),
      `atajo hacia el módulo personal en el manifest primario: ${atajo.url}`,
    )
  }
})

// ── 5 — los íconos son de TechRepair Pro y existen ───────────────────────────

test('manifest: ningún ícono apunta a los assets de Mi Guita', () => {
  for (const icono of manifest.icons ?? []) {
    assert.doesNotMatch(icono.src, MI_GUITA, `ícono de Mi Guita en el manifest primario: ${icono.src}`)
  }
})

/** Lee ancho/alto del IHDR de un PNG. Falla si la firma no es PNG. */
function dimensionesPng(rel: string): { ancho: number; alto: number } {
  const buf = readFileSync(raiz(rel))
  const firma = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  assert.deepEqual([...buf.subarray(0, 8)], firma, `${rel} no es un PNG`)
  return { ancho: buf.readUInt32BE(16), alto: buf.readUInt32BE(20) }
}

test('manifest: cada ícono existe en disco, es PNG y mide lo declarado', () => {
  assert.ok((manifest.icons ?? []).length >= 2, 'el manifest debe declarar al menos 192 y 512')

  for (const icono of manifest.icons) {
    const rel = `public${icono.src}`
    assert.ok(existsSync(raiz(rel)), `falta el asset declarado en el manifest: ${icono.src}`)

    // PNG y no SVG: iOS no instala de forma confiable desde SVG.
    assert.equal(icono.type, 'image/png', `${icono.src} debería declararse como image/png`)

    const [ancho, alto] = icono.sizes.split('x').map(Number)
    const real = dimensionesPng(rel)
    assert.equal(real.ancho, ancho, `${icono.src}: ancho real ${real.ancho} ≠ declarado ${ancho}`)
    assert.equal(real.alto, alto, `${icono.src}: alto real ${real.alto} ≠ declarado ${alto}`)
  }
})

test('manifest: hay un ícono maskable para Android', () => {
  const maskable = (manifest.icons ?? []).filter((i: { purpose?: string }) =>
    String(i.purpose ?? '').split(/\s+/).includes('maskable'),
  )
  assert.ok(maskable.length >= 1, 'falta un ícono purpose="maskable"')
})

test('manifest: display standalone y locale es-AR', () => {
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.lang, 'es-AR')
})

// ── 6 — título Apple ─────────────────────────────────────────────────────────

test('index.html: apple-mobile-web-app-title es TechRepair Pro', () => {
  const m = head.match(/<meta\s+name="apple-mobile-web-app-title"\s+content="([^"]*)"/)
  assert.ok(m, 'falta el meta apple-mobile-web-app-title')
  assert.equal(m[1], IDENTIDAD, 'es la etiqueta que iOS pone bajo el ícono de la pantalla de inicio')
})

// ── 7 — apple-touch-icon ─────────────────────────────────────────────────────

test('index.html: el apple-touch-icon es un PNG de TechRepair Pro que existe', () => {
  const iconos = [...head.matchAll(/<link\s+rel="apple-touch-icon"[^>]*href="([^"]+)"/g)].map(m => m[1])
  assert.ok(iconos.length >= 1, 'falta el apple-touch-icon')

  for (const href of iconos) {
    assert.doesNotMatch(href, MI_GUITA, `apple-touch-icon de Mi Guita: ${href}`)
    // Safari NO soporta SVG en apple-touch-icon: debe ser raster.
    assert.match(href, /\.png$/, `apple-touch-icon debe ser PNG, no ${href}`)
    assert.ok(existsSync(raiz(`public${href}`)), `el apple-touch-icon no existe en disco: ${href}`)
  }
})

// ── 8 — no queda metadata PWA de Mi Guita en el shell ────────────────────────

test('index.html: el <head> no declara metadata PWA de Mi Guita', () => {
  const lineasPwa = head
    .split('\n')
    .filter(l => /rel="manifest"|apple-touch-icon|apple-mobile-web-app|mobile-web-app-capable|name="theme-color"/.test(l))

  assert.ok(lineasPwa.length > 0, 'el shell perdió su bloque PWA')
  for (const linea of lineasPwa) {
    assert.doesNotMatch(linea, MI_GUITA, `metadata PWA de Mi Guita en index.html: ${linea.trim()}`)
  }
})

test('index.html: el manifest enlazado es el primario', () => {
  const m = head.match(/<link\s+rel="manifest"\s+href="([^"]+)"/)
  assert.ok(m, 'falta el <link rel="manifest">')
  assert.equal(m[1], '/manifest.json')
})

test('index.html: se preserva viewport-fit=cover y la capacidad standalone', () => {
  assert.match(head, /viewport-fit=cover/, 'safe-area de iOS: no se puede perder')
  assert.match(head, /<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"/)
  assert.match(head, /<meta\s+name="mobile-web-app-capable"\s+content="yes"/)
})

// ── 9/10 — el routing no se tocó ─────────────────────────────────────────────

test('routing: /personal sigue existiendo (Mi Guita no se elimina)', () => {
  assert.match(appTsx, /path="\/personal"/, 'Mi Guita es un módulo interno vigente')
})

test('routing: "/" sigue siendo el dashboard canónico de TechRepair Pro', () => {
  assert.match(
    appTsx,
    /<Route\s+path="\/"\s+element=\{<Dashboard\s*\/>\}\s*\/>/,
    'start_url "/" depende de que "/" siga montando el Dashboard bajo ProtectedRoute',
  )
})

// ── No-regresión de sesión ───────────────────────────────────────────────────

test('sesión: el arranque no limpia el storage de auth', () => {
  const supabaseSrc = readFileSync(raiz('src/lib/supabase.ts'), 'utf-8')
  assert.match(supabaseSrc, /persistSession:\s*true/)
  assert.match(supabaseSrc, /autoRefreshToken:\s*true/)

  // Ni el shell ni el manifest pueden introducir un borrado de storage al
  // lanzar en standalone: la sesión persistida tiene que sobrevivir.
  assert.doesNotMatch(html, /localStorage\.clear|sessionStorage\.clear/)
})
