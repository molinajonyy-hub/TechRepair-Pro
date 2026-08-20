#!/usr/bin/env node
// ============================================================================
// Guard — el Companion no puede distribuirse con privilegios de desarrollo.
//
//   node scripts/guards/whatsapp-companion-release.mjs             (valida el repo)
//   node scripts/guards/whatsapp-companion-release.mjs --self-test (valida el guard)
//
// ┌── QUÉ PROTEGE ──────────────────────────────────────────────────────────┐
// │ Durante el POC hubo que autorizar `http://localhost:4599/*` en          │
// │ `externally_connectable` para poder abrir el harness. Eso NO puede      │
// │ llegar a una release: cualquier cosa corriendo en esa dirección de la   │
// │ máquina del usuario podría pedirle a la extensión que abra WhatsApp.    │
// │                                                                          │
// │ El olvido es silencioso — la extensión funciona igual de bien con el    │
// │ origin de más — así que hace falta que algo lo grite.                   │
// │                                                                          │
// │ Se vigila también el creep de permisos: la extensión demostró funcionar │
// │ con SÓLO `host_permissions: https://web.whatsapp.com/*`, sin "tabs".    │
// └─────────────────────────────────────────────────────────────────────────┘
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const DIR = 'tools/whatsapp-companion'
const MANIFEST = `${DIR}/manifest.json`
const CONTRATO = `${DIR}/lib/contract.js`
const SW = `${DIR}/service-worker.js`

/** Permisos que la extensión NO necesita y que ampliarían mucho su alcance. */
const PERMISOS_PROHIBIDOS = [
  'tabs', 'cookies', 'history', 'webRequest', 'webRequestBlocking',
  'scripting', 'nativeMessaging', 'downloads', 'clipboardRead',
  'clipboardWrite', 'management', 'debugger', 'proxy', 'privacy',
]

// ─── Comprobaciones puras (testeables) ──────────────────────────────────────

/** Ningún origin de desarrollo puede quedar autorizado. */
export function tieneOrigenDeDesarrollo(matches) {
  if (!Array.isArray(matches)) return true
  return matches.some(m => /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|^file:|^http:\/\//i.test(m))
}

/** Ni un wildcard que autorice de más. */
export function tieneComodinPeligroso(matches) {
  if (!Array.isArray(matches)) return true
  return matches.some(m => m === '<all_urls>' || /^\*:\/\//.test(m) || /^https:\/\/\*\/\*$/.test(m))
}

/** El alcance de host sigue siendo sólo WhatsApp Web. */
export function hostPermissionsCorrectos(hp) {
  return Array.isArray(hp) && hp.length === 1 && hp[0] === 'https://web.whatsapp.com/*'
}

/** Sin permisos de más. Devuelve los que sobran. */
export function permisosDeMas(manifest) {
  const declarados = [
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []),
  ]
  return declarados.filter(p => PERMISOS_PROHIBIDOS.includes(p))
}

/** Nada de content scripts, ni de código remoto. */
export function tieneSuperficieDeMas(manifest) {
  return Boolean(manifest.content_scripts || manifest.web_accessible_resources || manifest.devtools_page)
}

/** El allowlist del runtime tampoco puede tener un origin de desarrollo. */
export function runtimeConOrigenDeDesarrollo(fuente) {
  const bloque = fuente.match(/ORIGENES_AUTORIZADOS[\s\S]{0,400}?\]/)
  if (!bloque) return true // si no se encuentra la lista, fallar cerrado
  return /localhost|127\.0\.0\.1|http:\/\//i.test(bloque[0])
}

/** El destino se construye adentro, nunca se toma del payload. */
export function construyeElDestinoAdentro(fuente) {
  return /WHATSAPP_ORIGEN\s*=\s*'https:\/\/web\.whatsapp\.com'/.test(fuente)
      && /\$\{WHATSAPP_ORIGEN\}\/send\?phone=/.test(fuente)
}

/** Sigue validando origen y payload. */
export function validaOrigenYPayload(fuente) {
  return /origenAutorizado/.test(fuente) && /validarApertura/.test(fuente)
}

// ─── Recorrido del repo ─────────────────────────────────────────────────────

function validarRepo() {
  const fallas = []
  for (const p of [MANIFEST, CONTRATO, SW]) {
    if (!existsSync(join(RAIZ, p))) {
      fallas.push(`Falta ${p}: el Companion perdió una pieza.`)
    }
  }
  if (fallas.length) return fallas

  const manifest = JSON.parse(readFileSync(join(RAIZ, MANIFEST), 'utf-8'))
  const matches = manifest.externally_connectable?.matches

  if (tieneOrigenDeDesarrollo(matches)) {
    fallas.push(`${MANIFEST}: externally_connectable autoriza un origin de desarrollo (localhost/127.0.0.1/http). Cualquier cosa corriendo ahí podría pedirle a la extensión que abra WhatsApp. Sacalo antes de distribuir.`)
  }
  if (tieneComodinPeligroso(matches)) {
    fallas.push(`${MANIFEST}: externally_connectable tiene un comodín demasiado amplio.`)
  }
  if (!hostPermissionsCorrectos(manifest.host_permissions)) {
    fallas.push(`${MANIFEST}: host_permissions dejó de ser exactamente ["https://web.whatsapp.com/*"]. Quedó: ${JSON.stringify(manifest.host_permissions)}.`)
  }
  const sobran = permisosDeMas(manifest)
  if (sobran.length) {
    fallas.push(`${MANIFEST}: pide permisos que no necesita (${sobran.join(', ')}). Se demostró que alcanza con host_permissions; "tabs" daría URL y título de TODAS las pestañas.`)
  }
  if (tieneSuperficieDeMas(manifest)) {
    fallas.push(`${MANIFEST}: declara content_scripts / web_accessible_resources / devtools_page. La extensión sólo administra pestañas; nada de eso hace falta y amplía la superficie.`)
  }

  const contrato = readFileSync(join(RAIZ, CONTRATO), 'utf-8')
  if (runtimeConOrigenDeDesarrollo(contrato)) {
    fallas.push(`${CONTRATO}: ORIGENES_AUTORIZADOS incluye un origin de desarrollo. Es la segunda barrera: tiene que quedar igual de limpia que el manifest.`)
  }
  if (!construyeElDestinoAdentro(contrato)) {
    fallas.push(`${CONTRATO}: dejó de construir el destino internamente. Si el host o el path vinieran del payload, la extensión sería un open-redirect.`)
  }

  const sw = readFileSync(join(RAIZ, SW), 'utf-8')
  if (!validaOrigenYPayload(sw)) {
    fallas.push(`${SW}: dejó de validar el origen o el payload antes de abrir una pestaña.`)
  }

  return fallas
}

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  const casos = []
  const chequear = (nombre, real, esperado) => casos.push({ nombre, ok: real === esperado })

  const PROD = ['https://techrepairpro.app/*', 'https://www.techrepairpro.app/*']

  chequear('caza localhost', tieneOrigenDeDesarrollo([...PROD, 'http://localhost:4599/*']), true)
  chequear('caza 127.0.0.1', tieneOrigenDeDesarrollo([...PROD, 'http://127.0.0.1:4599/*']), true)
  chequear('caza cualquier http://', tieneOrigenDeDesarrollo([...PROD, 'http://dev.techrepairpro.app/*']), true)
  chequear('acepta sólo los de producción', tieneOrigenDeDesarrollo(PROD), false)
  chequear('falla cerrado si falta la lista', tieneOrigenDeDesarrollo(undefined), true)

  chequear('caza <all_urls>', tieneComodinPeligroso(['<all_urls>']), true)
  chequear('caza *://', tieneComodinPeligroso(['*://techrepairpro.app/*']), true)
  chequear('no marca los de producción', tieneComodinPeligroso(PROD), false)

  chequear('acepta el host exacto', hostPermissionsCorrectos(['https://web.whatsapp.com/*']), true)
  chequear('caza un host de más', hostPermissionsCorrectos(['https://web.whatsapp.com/*', 'https://x.com/*']), false)
  chequear('caza <all_urls> como host', hostPermissionsCorrectos(['<all_urls>']), false)

  chequear('caza el permiso tabs', permisosDeMas({ permissions: ['tabs'] }).length === 1, true)
  chequear('caza cookies/scripting', permisosDeMas({ permissions: ['cookies', 'scripting'] }).length === 2, true)
  chequear('caza también los opcionales', permisosDeMas({ optional_permissions: ['history'] }).length === 1, true)
  chequear('no marca un manifest sin permissions', permisosDeMas({}).length === 0, true)

  chequear('caza content_scripts', tieneSuperficieDeMas({ content_scripts: [] }), true)
  chequear('caza web_accessible_resources', tieneSuperficieDeMas({ web_accessible_resources: [] }), true)
  chequear('no marca el manifest mínimo', tieneSuperficieDeMas({ background: {} }), false)

  chequear('caza localhost en el runtime', runtimeConOrigenDeDesarrollo(
    `export const ORIGENES_AUTORIZADOS = Object.freeze([\n 'https://techrepairpro.app',\n 'http://localhost:4599',\n]);`), true)
  chequear('acepta el runtime limpio', runtimeConOrigenDeDesarrollo(
    `export const ORIGENES_AUTORIZADOS = Object.freeze([\n 'https://techrepairpro.app',\n 'https://www.techrepairpro.app',\n]);`), false)
  chequear('falla cerrado sin la lista', runtimeConOrigenDeDesarrollo('const x = 1'), true)

  chequear('reconoce el destino interno', construyeElDestinoAdentro(
    "export const WHATSAPP_ORIGEN = 'https://web.whatsapp.com';\nreturn `${WHATSAPP_ORIGEN}/send?phone=${phone}&text=${encodeURIComponent(text)}`"), true)
  chequear('caza el destino tomado del payload', construyeElDestinoAdentro(
    'return msg.url'), false)

  chequear('reconoce las validaciones', validaOrigenYPayload('origenAutorizado(sender); validarApertura(msg)'), true)
  chequear('caza su ausencia', validaOrigenYPayload('abrirEnWhatsApp(msg.url)'), false)

  for (const c of casos) console.log(`  ${c.ok ? '✓' : '✗'} ${c.nombre}`)
  const fallidos = casos.filter(c => !c.ok)
  if (fallidos.length) {
    console.error(`\n✗ Self-test FALLIDO: ${fallidos.length}/${casos.length} comprobaciones no se comportan como dicen.`)
    process.exit(1)
  }
  console.log(`\n✓ Self-test OK: ${casos.length} comprobaciones verificadas en ambos sentidos.`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  console.log('\n─── guard:whatsapp-companion · self-test ───────────────────────────')
  selfTest()
} else {
  const fallas = validarRepo()
  if (fallas.length) {
    console.error('\n' + '═'.repeat(74))
    console.error('  GUARD FALLIDO — el Companion tiene privilegios que no debería')
    console.error('═'.repeat(74))
    for (const f of fallas) console.error(`  ✗ ${f}`)
    console.error('═'.repeat(74) + '\n')
    process.exit(1)
  }
  console.log('✓ guard:whatsapp-companion — sin origins de desarrollo ni permisos de más.')
}
