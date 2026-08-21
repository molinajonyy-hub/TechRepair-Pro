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
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const DIR = 'tools/whatsapp-companion'
const MANIFEST = `${DIR}/manifest.json`
const CONTRATO = `${DIR}/lib/contract.js`
const SW = `${DIR}/service-worker.js`

/** Permisos que la extensión NO necesita y que ampliarían mucho su alcance. */
const PERMISOS_PROHIBIDOS = [
  'tabs', 'cookies', 'history', 'webRequest', 'webRequestBlocking',
  'declarativeNetRequest', 'declarativeNetRequestWithHostAccess',
  'scripting', 'nativeMessaging', 'downloads', 'clipboardRead',
  'clipboardWrite', 'management', 'debugger', 'proxy', 'privacy',
  // `storage` y `activeTab` no estaban, y son justamente los que un commit
  // futuro agregaría sin llamar la atención. La extensión no guarda nada.
  'storage', 'unlimitedStorage', 'activeTab', 'bookmarks', 'topSites',
]

/**
 * APIs de almacenamiento que NO requieren declararse en el manifest.
 *
 * IndexedDB y CacheStorage están disponibles sin pedir nada, así que la
 * ausencia de la clave `permissions` no prueba que la extensión no almacene.
 * Lo que lo prueba es el código, no el manifest — de ahí este chequeo aparte.
 */
const APIS_DE_ALMACENAMIENTO =
  /\bchrome\s*\.\s*storage\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bcaches\s*\.\s*open\b/

/** Tamaños de ícono que el manifest debe declarar. El 128 lo exige el Store. */
const ICONOS_REQUERIDOS = ['16', '32', '48', '128']

/**
 * Largo máximo de `description`, en caracteres.
 *
 * No es una convención nuestra: el Chrome Web Store rechazó el ZIP ANTES de
 * dejar crear el ítem, con «El campo description del archivo de manifiesto es
 * demasiado largo. 140. Supera el límite máximo de 132 caracteres.» — o sea que
 * ni siquiera llegás a la ficha, y el error aparece recién al subir.
 *
 * Se mide con `.length` (unidades UTF-16) porque es lo que dio exactamente los
 * 140 que contó el Store, y porque para texto fuera del BMP es el número más
 * grande de los dos: falla cerrado.
 */
const MAX_DESCRIPTION = 132

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

/**
 * El código no usa ninguna API de almacenamiento.
 *
 * El manifest no puede probar esto: IndexedDB y CacheStorage no se declaran.
 * «No almacena» es un claim que va a la ficha del Store, así que tiene que
 * estar bajo guard y no bajo palabra.
 */
export function usaAlmacenamiento(fuente) {
  return APIS_DE_ALMACENAMIENTO.test(fuente)
}

/**
 * La respuesta al sitio es MÍNIMA.
 *
 * `encontradas: tabs.length` le informaba a la página cuántas pestañas de
 * WhatsApp Web tenía abiertas la persona: estado del navegador saliendo hacia
 * una web, sin consumidor y sin figurar en el contrato documentado. Y el
 * `detalle` de los errores podía llevar el mensaje crudo de Chrome, que incluye
 * la URL completa — o sea el teléfono y el texto.
 */
export function filtraEstadoDelNavegador(fuente) {
  return /\bencontradas\b/.test(fuente)
      || /\btabCount\b/.test(fuente)
      || /tabId\s*:/.test(fuente)
      || /error\([^)]*,\s*String\(/.test(fuente)
}

/**
 * Distingue «sin acceso al host» de «no instalada».
 *
 * MEDIDO: sin el host permission, `tabs.query({url})` no tira error — devuelve
 * cero pestañas. Sin este chequeo la extensión crearía una pestaña nueva en
 * cada mensaje, en silencio y respondiendo ok, que es justo el problema que
 * vino a resolver.
 */
export function detectaFaltaDeAcceso(fuente) {
  return /permissions\s*\.\s*contains\s*\(/.test(fuente)
      && /HOST_ACCESS_REQUIRED/.test(fuente)
}

/**
 * No afirma que no toca el historial.
 *
 * Es falso: `tabs.update` es una navegación top-level y Chrome la asienta en el
 * historial con el teléfono y el mensaje en la URL. La frase correcta habla de
 * las APIs (`no usa chrome.history`), no del efecto.
 */
export function afirmaQueNoTocaElHistorial(fuente) {
  return /no\s+(toca|tocan|deja|dejan)[^\n.]{0,40}historial/i.test(fuente)
}

/**
 * `description` existe y entra en el límite del Store.
 *
 * Falla cerrado: sin descripción tampoco se puede publicar.
 * Devuelve el motivo, o `null` si está bien.
 */
export function descripcionFueraDeLimite(manifest) {
  const d = manifest?.description
  if (typeof d !== 'string' || d.trim() === '') {
    return 'no declara "description", y el Store la exige'
  }
  if (d.length > MAX_DESCRIPTION) {
    return `"description" mide ${d.length} caracteres y el máximo es ${MAX_DESCRIPTION}`
  }
  return null
}

/** Declara los íconos, y los archivos existen. Devuelve lo que falta. */
export function iconosFaltantes(manifest, existe) {
  const faltan = []
  const icons = manifest?.icons
  if (!icons || typeof icons !== 'object') return ['la clave "icons" no está declarada']
  for (const tamano of ICONOS_REQUERIDOS) {
    const ruta = icons[tamano]
    if (!ruta) faltan.push(`icons.${tamano} no declarado`)
    else if (!existe(ruta)) faltan.push(`icons.${tamano} apunta a ${ruta}, que no existe`)
  }
  return faltan
}

// ─── Recorrido del repo ─────────────────────────────────────────────────────

export function validarRepo() {
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

  const problemaDescripcion = descripcionFueraDeLimite(manifest)
  if (problemaDescripcion) {
    fallas.push(`${MANIFEST}: ${problemaDescripcion}. El Store lo rechaza al SUBIR el ZIP, antes de crear el ítem, así que se descubre tarde y a mano.`)
  }

  const faltanIconos = iconosFaltantes(manifest, (ruta) => existsSync(join(RAIZ, DIR, ruta)))
  if (faltanIconos.length) {
    fallas.push(`${MANIFEST}: ${faltanIconos.join(' · ')}. Chrome Web Store exige el ícono de 128×128; sin él la submission no se completa. Generalos con: npm run companion:iconos`)
  }

  const sw = readFileSync(join(RAIZ, SW), 'utf-8')
  if (!validaOrigenYPayload(sw)) {
    fallas.push(`${SW}: dejó de validar el origen o el payload antes de abrir una pestaña.`)
  }
  if (!detectaFaltaDeAcceso(sw)) {
    fallas.push(`${SW}: dejó de distinguir «sin acceso al host» de «no instalada». Sin permissions.contains + HOST_ACCESS_REQUIRED, con el acceso al sitio en «Al hacer clic» la extensión crea una pestaña nueva en cada mensaje, en silencio y respondiendo ok.`)
  }
  if (filtraEstadoDelNavegador(sw)) {
    fallas.push(`${SW}: la respuesta al sitio volvió a llevar estado del navegador (encontradas/tabId) o el detalle crudo de un error. TechRepair no necesita nada de eso, y el detalle del error puede incluir la URL completa — o sea el teléfono y el mensaje.`)
  }

  for (const p of [SW, CONTRATO]) {
    const fuente = readFileSync(join(RAIZ, p), 'utf-8')
    if (usaAlmacenamiento(fuente)) {
      fallas.push(`${p}: usa una API de almacenamiento. «No almacena nada» es un claim de la ficha del Store; IndexedDB y CacheStorage ni siquiera se declaran en el manifest, así que esto sólo lo puede probar el código.`)
    }
    if (afirmaQueNoTocaElHistorial(fuente)) {
      fallas.push(`${p}: afirma que no toca el historial. Es falso: tabs.update es una navegación top-level y Chrome la asienta en el historial con el teléfono y el mensaje en la URL. La frase correcta es que no usa las APIs de cookies/storage/history.`)
    }
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

  // Almacenamiento — lo que el manifest no puede probar
  chequear('caza chrome.storage', usaAlmacenamiento('await chrome.storage.local.set({ x })'), true)
  chequear('caza localStorage', usaAlmacenamiento('localStorage.setItem("a", b)'), true)
  chequear('caza indexedDB', usaAlmacenamiento('const db = indexedDB.open("x")'), true)
  chequear('caza CacheStorage', usaAlmacenamiento('const c = await caches.open("v1")'), true)
  chequear('no marca el código actual', usaAlmacenamiento('const tabs = await chrome.tabs.query({ url })'), false)

  // Respuesta mínima
  chequear('caza encontradas', filtraEstadoDelNavegador('return { ok: true, action, encontradas: tabs.length }'), true)
  chequear('caza tabCount', filtraEstadoDelNavegador('return { ok: true, tabCount: n }'), true)
  chequear('caza tabId', filtraEstadoDelNavegador('return { ok: true, action, tabId: tab.id }'), true)
  chequear('caza el detalle crudo del error',
    filtraEstadoDelNavegador('sendResponse(error(CODIGOS.TAB_ERROR, String(e.message)))'), true)
  chequear('acepta la respuesta mínima',
    filtraEstadoDelNavegador('return respuestaApertura("reused")\nsendResponse(error(CODIGOS.TAB_ERROR))'), false)

  // Host access
  chequear('reconoce la detección de falta de acceso', detectaFaltaDeAcceso(
    'await chrome.permissions.contains({ origins: [P] })\nerror(CODIGOS.HOST_ACCESS_REQUIRED)'), true)
  chequear('caza que sólo esté el chequeo sin el código',
    detectaFaltaDeAcceso('await chrome.permissions.contains({ origins: [P] })'), false)
  chequear('caza su ausencia total',
    detectaFaltaDeAcceso('const tabs = await chrome.tabs.query({ url })'), false)

  // Historial — la afirmación que no se puede sostener
  chequear('caza «no toca cookies, storage ni historial»',
    afirmaQueNoTocaElHistorial('// no toca cookies, storage ni historial'), true)
  chequear('caza «no deja datos en el historial»',
    afirmaQueNoTocaElHistorial('no deja datos en el historial del navegador'), true)
  chequear('acepta la redacción correcta',
    afirmaQueNoTocaElHistorial('no usa las APIs de cookies, storage ni history, y no las declara'), false)
  chequear('acepta que se explique que SÍ lo escribe',
    afirmaQueNoTocaElHistorial('Chrome la asienta en el historial del perfil'), false)

  // Íconos
  const iconsOk = { icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' } }
  chequear('acepta los cuatro íconos presentes', iconosFaltantes(iconsOk, () => true).length, 0)
  chequear('caza el archivo ausente', iconosFaltantes(iconsOk, (r) => r !== 'icons/icon128.png').length, 1)
  chequear('caza la falta del 128', iconosFaltantes({ icons: { 16: 'a.png', 32: 'b.png', 48: 'c.png' } }, () => true).length, 1)
  chequear('caza la ausencia de la clave icons', iconosFaltantes({}, () => true).length, 1)

  // Largo de la description
  // El caso que importa: la descripción REAL que el Store rechazó el 2026-08-21.
  // Si este chequeo se rompe, el guard dejó de cazar una falla ya ocurrida.
  const RECHAZADA_POR_EL_STORE =
    'Abre WhatsApp Web en una sola pestaña con el chat y el mensaje que preparaste en TechRepair Pro. No lee tus chats ni envía mensajes por vos.'
  chequear('la descripción rechazada medía los 140 que contó el Store',
    RECHAZADA_POR_EL_STORE.length, 140)
  chequear('caza la descripción que el Store rechazó de verdad',
    descripcionFueraDeLimite({ description: RECHAZADA_POR_EL_STORE }) !== null, true)
  chequear('acepta la descripción actual del manifest',
    descripcionFueraDeLimite(JSON.parse(readFileSync(join(RAIZ, MANIFEST), 'utf-8'))), null)
  chequear('acepta exactamente 132',
    descripcionFueraDeLimite({ description: 'x'.repeat(132) }), null)
  chequear('caza 133, un solo carácter de más',
    descripcionFueraDeLimite({ description: 'x'.repeat(133) }) !== null, true)
  chequear('falla cerrado sin description', descripcionFueraDeLimite({}) !== null, true)
  chequear('falla cerrado con description vacía',
    descripcionFueraDeLimite({ description: '   ' }) !== null, true)
  chequear('los acentos cuentan como UN carácter, no como dos bytes',
    descripcionFueraDeLimite({ description: 'á'.repeat(132) }), null)

  for (const c of casos) console.log(`  ${c.ok ? '✓' : '✗'} ${c.nombre}`)
  const fallidos = casos.filter(c => !c.ok)
  if (fallidos.length) {
    console.error(`\n✗ Self-test FALLIDO: ${fallidos.length}/${casos.length} comprobaciones no se comportan como dicen.`)
    process.exit(1)
  }
  console.log(`\n✓ Self-test OK: ${casos.length} comprobaciones verificadas en ambos sentidos.`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Sólo corre el guard si el archivo se ejecutó directamente.
 *
 * `companion:package` IMPORTA `validarRepo` para no poder construir un ZIP que
 * el guard rechazaría. Sin esta condición, ese import ejecutaría el guard como
 * efecto secundario de cargar el módulo — y un `process.exit(1)` acá adentro
 * cortaría el empaquetado con un mensaje que no explica de dónde salió.
 */
const ejecutadoDirectamente =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (ejecutadoDirectamente) {
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
}
